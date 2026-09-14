use std::sync::Arc;

use loro_internal::{
    container::ContainerID, cursor::PosType, handler::TextHandler, loro::ExportMode,
    version::Frontiers, HandlerTrait, LoroDoc, Subscription, TreeID, TreeParentId,
};

#[test]
fn tree_index() {
    let doc = LoroDoc::new_auto_commit();
    doc.set_peer_id(0).unwrap();
    let tree = doc.get_tree("tree");
    let root = tree.create(TreeParentId::Root).unwrap();
    let child = tree.create(root.into()).unwrap();
    let child2 = tree.create_at(root.into(), 0).unwrap();
    // sort with OpID
    assert_eq!(tree.get_index_by_tree_id(&child).unwrap(), 1);
    assert_eq!(tree.get_index_by_tree_id(&child2).unwrap(), 0);

    let doc = LoroDoc::new_auto_commit();
    doc.set_peer_id(0).unwrap();
    let tree = doc.get_tree("tree");
    tree.enable_fractional_index(0);
    let root = tree.create(TreeParentId::Root).unwrap();
    let child = tree.create(root.into()).unwrap();
    let child2 = tree.create_at(root.into(), 0).unwrap();
    // sort with fractional index
    assert_eq!(tree.get_index_by_tree_id(&child).unwrap(), 1);
    assert_eq!(tree.get_index_by_tree_id(&child2).unwrap(), 0);
}

#[test]
fn tree_move_in_parent() {
    let doc = LoroDoc::new_auto_commit();
    doc.set_peer_id(0).unwrap();
    let tree = doc.get_tree("tree");
    let root = tree.create(TreeParentId::Root).unwrap();
    let child = tree.create(root.into()).unwrap();
    tree.mov(child, root.into()).unwrap();
}

const MISSING_IN_PARENT: &str = "loro_internal::state::DocState::get_path::missing_in_parent";

/// Builds a doc holding a root-parented tree node whose meta map carries a text
/// container, then deletes the node. Returns the doc, its subscription if one was
/// taken, the node, the frontiers at which the node was still alive, and the two
/// container ids under it.
fn doc_with_a_deleted_tree_node(
    subscribe: bool,
) -> (
    LoroDoc,
    Option<Subscription>,
    TreeID,
    Frontiers,
    ContainerID,
    ContainerID,
) {
    let doc = LoroDoc::new_auto_commit();
    // Recording, and with it the path resolution of diffs, starts with the first root
    // subscriber; it does not stop when the subscription is dropped.
    let sub = subscribe.then(|| doc.subscribe_root(Arc::new(|_e| {})));
    let tree = doc.get_tree("tree");
    let node = tree.create(TreeParentId::Root).unwrap();
    let meta = tree.get_meta(node).unwrap();
    meta.insert("label", "node").unwrap();
    let text = meta
        .insert_container("content", TextHandler::new_detached())
        .unwrap();
    text.insert(0, "hello", PosType::Event).unwrap();
    doc.commit_then_renew();
    let alive = doc.state_frontiers();

    tree.delete(node).unwrap();
    doc.commit_then_renew();
    doc.get_map("unrelated").insert("k", "v").unwrap();
    doc.commit_then_renew();

    let ids = (text.id(), meta.id());
    (doc, sub, node, alive, ids.0, ids.1)
}

/// Both legs and the no-subscriber control live in one test on purpose: the coverage
/// counter is process-global, so a delta measured around one call is only exact while
/// no sibling test can concurrently touch the same point.
/// The counter is compiled out without debug assertions, so the release profile skips it.
#[test]
#[cfg_attr(not(debug_assertions), ignore)]
fn path_of_a_container_under_a_deleted_tree_node_is_none_when_history_is_read() {
    // Reading history: forking at a frontier where the node was alive revives its
    // containers in the replayed diff, and the same batch deletes the node again.
    let (doc, _sub, node, alive, text_id, meta_id) = doc_with_a_deleted_tree_node(true);
    let before = ensure_cov::get_cov_for(MISSING_IN_PARENT);
    let _forked = doc.fork_at(&alive).unwrap();
    let after_fork = ensure_cov::get_cov_for(MISSING_IN_PARENT);
    assert!(
        after_fork > before,
        "forking at a live frontier should fail to resolve a path under the deleted node"
    );

    let tree = doc.get_tree("tree");
    assert!(tree.is_node_deleted(&node).unwrap());
    assert!(doc.has_container(&text_id));
    assert!(doc.has_container(&meta_id));
    assert!(doc.get_path_to_container(&text_id).is_none());
    assert!(doc.get_path_to_container(&meta_id).is_none());

    // Without a subscriber there is no recording, so the fork resolves no paths at all.
    let (quiet_doc, _no_sub, _quiet_node, quiet_alive, _t, _m) =
        doc_with_a_deleted_tree_node(false);
    let before_quiet = ensure_cov::get_cov_for(MISSING_IN_PARENT);
    let _quiet_fork = quiet_doc.fork_at(&quiet_alive).unwrap();
    assert_eq!(
        ensure_cov::get_cov_for(MISSING_IN_PARENT),
        before_quiet,
        "without a subscriber the fork should not resolve container paths"
    );

    // Importing a snapshot into a recording doc pushes a diff for every container in
    // the store, tombstones included.
    let snapshot = doc.export(ExportMode::Snapshot).unwrap();
    let importing = LoroDoc::new_auto_commit();
    let _import_sub = importing.subscribe_root(Arc::new(|_e| {}));
    let before_import = ensure_cov::get_cov_for(MISSING_IN_PARENT);
    importing.import(&snapshot).unwrap();
    assert!(
        ensure_cov::get_cov_for(MISSING_IN_PARENT) > before_import,
        "importing a snapshot should fail to resolve a path under the deleted node"
    );

    assert!(importing.has_container(&text_id));
    assert!(importing.has_container(&meta_id));
    assert!(importing.get_path_to_container(&text_id).is_none());
    assert!(importing.get_path_to_container(&meta_id).is_none());

    ensure_cov::assert_cov(MISSING_IN_PARENT);
}
