use bytes::Bytes;
use rle::HasLength;
use std::collections::BTreeSet;

use loro_common::{ContainerID, ContainerType, LoroEncodeError, LoroError, ID};

use crate::{
    container::{idx::ContainerIdx, list::list_op::InnerListOp},
    dag::DagUtils,
    encoding::fast_snapshot::{_encode_snapshot, Snapshot},
    event::EventTriggerKind,
    state::{container_store::FRONTIERS_KEY, DocState},
    version::{Frontiers, VersionVector},
    LoroDoc,
};

#[cfg(test)]
const MAX_OPS_NUM_TO_ENCODE_WITHOUT_LATEST_STATE: usize = 16;
#[cfg(not(test))]
const MAX_OPS_NUM_TO_ENCODE_WITHOUT_LATEST_STATE: usize = 256;

#[tracing::instrument(skip_all)]
pub(crate) fn export_shallow_snapshot<W: std::io::Write>(
    doc: &LoroDoc,
    start_from: &Frontiers,
    w: &mut W,
) -> Result<Frontiers, LoroEncodeError> {
    let (snapshot, start_from) = export_shallow_snapshot_inner(doc, start_from)?;
    _encode_snapshot(&snapshot, w);
    Ok(start_from)
}

pub(crate) fn export_shallow_snapshot_inner(
    doc: &LoroDoc,
    start_from: &Frontiers,
) -> Result<(Snapshot, Frontiers), LoroEncodeError> {
    let oplog = doc.oplog().lock();
    let start_from = calc_shallow_doc_start(&oplog, start_from);
    let mut start_vv = frontiers_to_vv_for_export(&oplog, &start_from, "export_shallow_snapshot")?;
    for id in start_from.iter() {
        // we need to include the ops in start_from, this can make things easier
        start_vv.insert(id.peer, id.counter);
    }

    #[cfg(debug_assertions)]
    {
        use crate::dag::Dag;
        if !start_from.is_empty() {
            assert!(start_from.len() == 1);
            let id = start_from.as_single().unwrap();
            let node = oplog.dag.get(id).unwrap();
            if id.counter == node.cnt {
                let vv = oplog.dag().frontiers_to_vv(&node.deps).unwrap();
                assert_eq!(vv, start_vv);
            } else {
                let vv = oplog
                    .dag()
                    .frontiers_to_vv(&Frontiers::from(id.inc(-1)))
                    .unwrap();
                assert_eq!(vv, start_vv);
            }
        }
    }

    loro_common::debug!(
        "start version vv={:?} frontiers={:?}",
        &start_vv,
        &start_from,
    );

    let latest_frontiers = oplog.frontiers().clone();
    let state_frontiers = doc.state_frontiers();
    let is_attached = !doc.is_detached();
    let oplog_bytes = oplog.export_change_store_from(&start_vv, &start_from);
    let latest_vv = oplog.vv();
    let ops_num: usize = latest_vv.sub_iter(&start_vv).map(|x| x.atom_len()).sum();
    if &start_from == oplog.shallow_since_frontiers()
        && state_frontiers == latest_frontiers
        && ops_num <= MAX_OPS_NUM_TO_ENCODE_WITHOUT_LATEST_STATE
    {
        let state = doc.app_state().lock();
        if let Some(shallow_root_state_bytes) = state.store.encode_shallow_root_state() {
            return Ok((
                Snapshot {
                    oplog_bytes,
                    state_bytes: None,
                    shallow_root_state_bytes,
                },
                start_from,
            ));
        }
    }
    if &start_from == oplog.shallow_since_frontiers()
        && state_frontiers == latest_frontiers
        && ops_num > MAX_OPS_NUM_TO_ENCODE_WITHOUT_LATEST_STATE
    {
        let mut state = doc.app_state().lock();
        if let Some((shallow_root_state_bytes, shallow_root_state_kv)) =
            state.store.shallow_root_state_for_export()
        {
            let mut alive_c_bytes = shallow_root_state_kv.keys();
            if has_unknown_container_key(alive_c_bytes.iter()) {
                return Err(LoroEncodeError::UnknownContainer);
            }

            state.ensure_all_alive_containers()?;
            state.store.flush();

            // All the containers that are created after start_from need to be encoded.
            for cid in state.store.iter_all_container_ids() {
                if let ContainerID::Normal { peer, counter, .. } = cid {
                    let temp_id = ID::new(peer, counter);
                    if !start_from.contains(&temp_id) {
                        alive_c_bytes.insert(cid.to_bytes());
                    }
                } else {
                    alive_c_bytes.insert(cid.to_bytes());
                }
            }

            let new_kv = state.store.get_kv_clone();
            new_kv.remove_same(&shallow_root_state_kv);
            new_kv.retain_keys(&alive_c_bytes);

            return Ok((
                Snapshot {
                    oplog_bytes,
                    state_bytes: Some(new_kv.export()),
                    shallow_root_state_bytes,
                },
                start_from,
            ));
        }
    }
    // Hold the oplog and state locks across the rewind, the whole encode, and the
    // restore, so the live document is never observable while it sits at a
    // historical version. Each move on its own parks the state at a version the
    // document never rests at; a reader that took the state lock between the
    // rewind and the restore would otherwise be answered with a version that was
    // never true. Holding both locks for the whole there-and-back walk makes such
    // a reader wait instead. The oplog guard is already held above; the state
    // guard is taken here, after the fast paths that only read current state have
    // been ruled out. Acquisition order is the group's fixed one: transaction
    // (already held — export runs inside `with_barrier`), then oplog, then state.
    let mut state = doc.app_state().lock();
    let result = (|| -> Result<Snapshot, LoroEncodeError> {
        doc._checkout_without_emitting_with_guards(
            &oplog,
            &mut state,
            &start_from,
            false,
            "checkout".into(),
            EventTriggerKind::Checkout,
        )
        .map_err(LoroEncodeError::from)?;
        let alive_containers = state.ensure_all_alive_containers()?;
        if has_unknown_container(alive_containers.iter().copied()) {
            return Err(LoroEncodeError::UnknownContainer);
        }
        let mut alive_c_bytes = alive_indices_to_bytes(&state, &alive_containers);
        state.store.flush();
        let shallow_root_state_kv = state.store.get_kv_clone();
        doc._checkout_without_emitting_with_guards(
            &oplog,
            &mut state,
            &latest_frontiers,
            false,
            "checkout".into(),
            EventTriggerKind::Checkout,
        )
        .map_err(LoroEncodeError::from)?;
        let state_bytes = if ops_num > MAX_OPS_NUM_TO_ENCODE_WITHOUT_LATEST_STATE {
            state.ensure_all_alive_containers()?;
            state.store.encode();
            // All the containers that are created after start_from need to be encoded
            for cid in state.store.iter_all_container_ids() {
                if let ContainerID::Normal { peer, counter, .. } = cid {
                    let temp_id = ID::new(peer, counter);
                    if !start_from.contains(&temp_id) {
                        alive_c_bytes.insert(cid.to_bytes());
                    }
                } else {
                    alive_c_bytes.insert(cid.to_bytes());
                }
            }

            let new_kv = state.store.get_kv_clone();
            new_kv.remove_same(&shallow_root_state_kv);
            new_kv.retain_keys(&alive_c_bytes);
            Some(new_kv.export())
        } else {
            None
        };

        shallow_root_state_kv.retain_keys(&alive_c_bytes);
        shallow_root_state_kv.insert(FRONTIERS_KEY, start_from.encode().into());
        let shallow_root_state_bytes = shallow_root_state_kv.export();

        Ok(Snapshot {
            oplog_bytes,
            state_bytes,
            shallow_root_state_bytes,
        })
    })();

    // Restore always runs, then the encode error, if any, is surfaced. The
    // restoring move stays under the held guards, and the events the walk
    // recorded are cleared against that same guard — reaching for the state lock
    // through `doc` here would deadlock the thread that already holds it.
    restore_export_doc_state(doc, &oplog, &mut state, &state_frontiers, is_attached)?;
    state.take_events();
    drop(state);
    drop(oplog);
    Ok((result?, start_from))
}

fn has_unknown_container(mut idxs: impl Iterator<Item = ContainerIdx>) -> bool {
    idxs.any(|idx| matches!(idx.get_type(), ContainerType::Unknown(_)))
}

fn has_unknown_container_key<'a>(mut keys: impl Iterator<Item = &'a Vec<u8>>) -> bool {
    keys.any(|key| ContainerID::from_bytes(key).is_unknown())
}

pub(crate) fn export_state_only_snapshot<W: std::io::Write>(
    doc: &LoroDoc,
    target_frontiers: &Frontiers,
    w: &mut W,
) -> Result<Frontiers, LoroEncodeError> {
    let oplog = doc.oplog().lock();
    let start_from = calc_shallow_doc_start(&oplog, target_frontiers);
    let mut start_vv =
        frontiers_to_vv_for_export(&oplog, &start_from, "export_state_only_snapshot")?;
    for id in start_from.iter() {
        // we need to include the ops in start_from, this can make things easier
        start_vv.insert(id.peer, id.counter);
    }

    loro_common::debug!(
        "start version vv={:?} frontiers={:?}",
        &start_vv,
        &start_from,
    );

    let to_vv = frontiers_to_vv_for_export(&oplog, target_frontiers, "export_state_only_snapshot")?;
    let oplog_bytes =
        oplog.export_change_store_in_range(&start_vv, &start_from, &to_vv, target_frontiers);
    let is_attached = !doc.is_detached();
    // Hold the oplog and state locks across the rewind, the whole encode, and the
    // restore, so the live document is never observable while it sits at a
    // historical version. Each move on its own parks the state at a version the
    // document never rests at; a reader that took the state lock between two of
    // them would otherwise be answered with a version that was never true.
    // Holding both locks for the whole there-and-back walk makes such a reader
    // wait instead. Acquisition order is the group's fixed one: transaction
    // (already held — export runs inside `with_barrier`), then oplog, then state.
    let mut state = doc.app_state().lock();
    let state_frontiers = state.frontiers.clone();
    let result = (|| -> Result<(), LoroEncodeError> {
        doc._checkout_without_emitting_with_guards(
            &oplog,
            &mut state,
            &start_from,
            false,
            "checkout".into(),
            EventTriggerKind::Checkout,
        )
        .map_err(LoroEncodeError::from)?;
        let alive_containers = state.ensure_all_alive_containers()?;
        if has_unknown_container(alive_containers.iter().copied()) {
            return Err(LoroEncodeError::UnknownContainer);
        }
        let mut alive_c_bytes = alive_indices_to_bytes(&state, &alive_containers);
        state.store.flush();
        let shallow_state_kv = state.store.get_kv_clone();

        doc._checkout_without_emitting_with_guards(
            &oplog,
            &mut state,
            target_frontiers,
            false,
            "checkout".into(),
            EventTriggerKind::Checkout,
        )
        .map_err(LoroEncodeError::from)?;
        state.ensure_all_alive_containers()?;
        state.store.encode();
        for cid in state.store.iter_all_container_ids() {
            if let ContainerID::Normal { peer, counter, .. } = cid {
                let temp_id = ID::new(peer, counter);
                if !start_from.contains(&temp_id) {
                    alive_c_bytes.insert(cid.to_bytes());
                }
            } else {
                alive_c_bytes.insert(cid.to_bytes());
            }
        }

        let target_state_kv = state.store.get_kv_clone();
        target_state_kv.remove_same(&shallow_state_kv);
        target_state_kv.retain_keys(&alive_c_bytes);

        shallow_state_kv.retain_keys(&alive_c_bytes);
        shallow_state_kv.insert(FRONTIERS_KEY, start_from.encode().into());
        let shallow_state_bytes = shallow_state_kv.export();
        let snapshot = Snapshot {
            oplog_bytes,
            state_bytes: Some(target_state_kv.export()),
            shallow_root_state_bytes: shallow_state_bytes,
        };
        _encode_snapshot(&snapshot, w);
        Ok(())
    })();

    // Restore always runs, then the encode error, if any, is surfaced. The
    // restoring move stays under the held guards, and the events the walk
    // recorded are cleared against that same guard — reaching for the state lock
    // through `doc` here would deadlock the thread that already holds it.
    restore_export_doc_state(doc, &oplog, &mut state, &state_frontiers, is_attached)?;
    state.take_events();
    drop(state);
    drop(oplog);
    result?;
    Ok(start_from)
}

fn alive_indices_to_bytes(
    state: &DocState,
    alive_containers: &rustc_hash::FxHashSet<ContainerIdx>,
) -> BTreeSet<Vec<u8>> {
    alive_containers
        .iter()
        .map(|idx| state.arena.get_container_id(*idx).unwrap().to_bytes())
        .collect()
}

fn frontiers_to_vv_for_export(
    oplog: &crate::OpLog,
    frontiers: &Frontiers,
    context: &str,
) -> Result<VersionVector, LoroEncodeError> {
    oplog.dag().frontiers_to_vv(frontiers).ok_or_else(|| {
        LoroEncodeError::FrontiersNotFound(format!(
            "{context}: unreachable frontiers {frontiers:?}"
        ))
    })
}

fn restore_export_doc_state(
    doc: &LoroDoc,
    oplog: &crate::OpLog,
    state: &mut DocState,
    state_frontiers: &Frontiers,
    was_attached: bool,
) -> Result<(), LoroEncodeError> {
    // Restore under the oplog and state guards the caller already holds, so the
    // move back to where the document rested is as unobservable as the rest of
    // the walk. Reaching for either lock here would deadlock the calling thread,
    // which owns them both.
    if &state.frontiers != state_frontiers {
        doc._checkout_without_emitting_with_guards(
            oplog,
            state,
            state_frontiers,
            false,
            "checkout".into(),
            EventTriggerKind::Checkout,
        )
        .map_err(LoroEncodeError::from)?;
    }

    if was_attached {
        doc.set_detached(false);
    }

    Ok(())
}

/// Calculates optimal starting version for the shallow doc
///
/// It should be a common ancestor version of the user-given version and the latest version.
/// Otherwise, users cannot replay the history from the initial version till the latest version.
fn calc_shallow_doc_start(oplog: &crate::OpLog, frontiers: &Frontiers) -> Frontiers {
    // Find a common ancestor version of the given frontiers by iterative pairwise reduction.
    // This converges to a single frontier or empty if there is no common ancestor.
    let mut current = frontiers.clone();
    while current.len() > 1 {
        let ids: Vec<ID> = current.iter().collect();
        let mut next = Frontiers::new();
        let mut i = 0;
        while i < ids.len() {
            if i + 1 < ids.len() {
                let (gca, _) = oplog
                    .dag()
                    .find_common_ancestor(&Frontiers::from(ids[i]), &Frontiers::from(ids[i + 1]));
                for id in gca.iter() {
                    next.push(id);
                }
            } else {
                next.push(ids[i]);
            }
            i += 2;
        }
        if next == current {
            // Cannot converge further (pairwise GCAs are the nodes themselves).
            // Fall back to empty frontiers, meaning export full history.
            return clamp_to_shallow_root(oplog, Frontiers::default());
        }
        current = next;
    }

    let mut ans = Frontiers::new();
    for id in current.iter() {
        let mut processed = false;
        if let Some(op) = oplog.get_op_that_includes(id) {
            if let crate::op::InnerContent::List(InnerListOp::StyleStart { .. }) = &op.content {
                // StyleStart and StyleEnd operations must be kept together in the GC snapshot.
                // Splitting them could lead to an weird document state that cannot be
                // properly encoded. To ensure they stay together, we advance the frontier by
                // one step to include both operations.

                // > Id.counter + 1 is guaranteed to be the StyleEnd Op
                ans.push(id.inc(1));
                processed = true;
            }
        }

        if !processed {
            ans.push(id);
        }
    }

    clamp_to_shallow_root(oplog, ans)
}

fn clamp_to_shallow_root(oplog: &crate::OpLog, frontiers: Frontiers) -> Frontiers {
    if oplog.shallow_since_vv().is_empty() {
        return frontiers;
    }

    let Some(vv) = oplog.dag().frontiers_to_vv(&frontiers) else {
        return oplog.shallow_since_frontiers().clone();
    };

    if vv.includes_vv(&oplog.shallow_since_vv().to_vv()) {
        frontiers
    } else {
        oplog.shallow_since_frontiers().clone()
    }
}

pub(crate) fn encode_snapshot_at<W: std::io::Write>(
    doc: &LoroDoc,
    frontiers: &Frontiers,
    w: &mut W,
) -> Result<(), LoroEncodeError> {
    let was_detached = doc.is_detached();

    // Hold the oplog and state locks across the rewind, the whole encode, and the
    // restore, so the live document is never observable while it sits at the
    // requested historical version. Each move on its own parks the state at a
    // version the document never rests at; a reader that took the state lock
    // between the rewind and the restore would otherwise be answered with a
    // version that was never true. Holding both locks for the whole there-and-back
    // walk makes such a reader wait instead. Acquisition order is the group's
    // fixed one: transaction (already held — export runs inside `with_barrier`),
    // then oplog, then state.
    let oplog = doc.oplog().lock();
    let mut state = doc.app_state().lock();
    let version_before_start = state.frontiers.clone();

    let result = 'block: {
        if let Err(e) = doc._checkout_without_emitting_with_guards(
            &oplog,
            &mut state,
            frontiers,
            true,
            "checkout".into(),
            EventTriggerKind::Checkout,
        ) {
            break 'block Err(LoroEncodeError::from(e));
        }

        let is_shallow = state.store.shallow_root_store().is_some();
        if is_shallow {
            break 'block Err(LoroEncodeError::from(LoroError::NotImplemented(
                "fork_at on shallow docs",
            )));
        }

        if state.is_in_txn() {
            break 'block Err(LoroEncodeError::internal(
                "encode_snapshot_at: state is unexpectedly still in a transaction",
            ));
        }
        let Some(oplog_bytes) = oplog.fork_changes_up_to(frontiers) else {
            break 'block Err(LoroEncodeError::FrontiersNotFound(format!(
                "frontiers: {:?} when export in SnapshotAt mode",
                frontiers
            )));
        };

        if oplog.is_shallow() {
            let Some(shallow_root_frontiers) = state.store.shallow_root_frontiers() else {
                break 'block Err(LoroEncodeError::internal(
                    "encode_snapshot_at: shallow oplog is missing shallow root frontiers",
                ));
            };
            if oplog.shallow_since_frontiers() != shallow_root_frontiers {
                break 'block Err(LoroEncodeError::internal(
                    "encode_snapshot_at: shallow root frontiers are inconsistent",
                ));
            }
        }

        let alive_containers = state.ensure_all_alive_containers()?;
        if has_unknown_container(alive_containers.iter().copied()) {
            break 'block Err(LoroEncodeError::UnknownContainer);
        }

        let alive_c_bytes = alive_indices_to_bytes(&state, &alive_containers);
        state.store.flush();
        let state_kv = state.store.get_kv_clone();
        state_kv.retain_keys(&alive_c_bytes);
        let bytes = state_kv.export();
        _encode_snapshot(
            &Snapshot {
                oplog_bytes,
                state_bytes: Some(bytes),
                shallow_root_state_bytes: Bytes::new(),
            },
            w,
        );

        Ok(())
    };
    // Always restore the document to where it rested before the walk, still under
    // the held locks so the restoring move is as unobservable as the rest of the
    // walk. The encode error, if any, is surfaced after the restore has run.
    let restore_result = doc
        ._checkout_without_emitting_with_guards(
            &oplog,
            &mut state,
            &version_before_start,
            false,
            "checkout".into(),
            EventTriggerKind::Checkout,
        )
        .map_err(LoroEncodeError::from);
    if !was_detached {
        doc.set_detached(false);
    }
    // Clear the events the walk recorded, exactly once, against the held guard.
    // Because export runs under `with_barrier` the transaction is held for the
    // whole function, so clearing the flag above is not exposed to the
    // import-teardown race and needs no reordering around the transaction.
    state.take_events();
    drop(state);
    drop(oplog);

    match result {
        Err(err) => Err(err),
        Ok(()) => restore_result,
    }
}
