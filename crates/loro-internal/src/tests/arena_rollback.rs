//! A failed import must leave the arena's per-container facts as it found them.
//!
//! Most of what the arena rolls back only ever grows at the end, so a length is
//! enough to undo it. The set of containers known to have carried a style op is
//! not like that: an import can set the fact for a container that already existed
//! long before the import began, and no truncation by index can undo that. A reader
//! that consults the fact would then refuse a container on the strength of a style
//! op the document does not have, permanently.

use crate::arena::SharedArena;
use loro_common::{ContainerID, ContainerType};

fn text(name: &str) -> ContainerID {
    ContainerID::new_root(name, ContainerType::Text)
}

#[test]
fn rollback_restores_the_styled_set_for_containers_that_already_existed() {
    let arena = SharedArena::new();
    let already_styled = arena.register_container(&text("already_styled"));
    let untouched = arena.register_container(&text("untouched"));
    arena.mark_container_styled(already_styled);

    let checkpoint = arena.checkpoint_for_rollback();

    // What a failed import does before it fails: a style op on a container that
    // was already there, and another on one the import itself creates.
    arena.mark_container_styled(untouched);
    let created_by_the_import = arena.register_container(&text("created_by_the_import"));
    arena.mark_container_styled(created_by_the_import);

    arena.rollback(checkpoint);

    assert!(
        !arena.is_container_styled(untouched),
        "a style op from the rolled-back import must not leave a pre-existing container marked; \
         index-based pruning cannot undo this, which is why the set is snapshotted"
    );
    assert!(
        arena.is_container_styled(already_styled),
        "a style the document had before the import must survive the rollback, or the fix \
         would trade one wrong answer for another"
    );
    assert!(
        !arena.is_container_styled(created_by_the_import),
        "a container the rolled-back import created is gone, and so is anything recorded for it"
    );
}
