//! Differential tests for the per-container history readers.
//!
//! `container_changed_between` and `diff_text_container` answer, from the oplog
//! alone, questions that were previously answerable only by moving the live
//! document through history. These tests pin them against the document itself:
//! the oracle for a delta is the container's text at either end of the window,
//! obtained by forking the document at each version, which is the expensive
//! answer the readers exist to avoid. The deltas are additionally fed to the real
//! consumer, `LoroText::apply_delta`, so the unit contract is pinned by the API
//! that has to accept them and not only by this file's own interpreter.
//!
//! # What these tests knowingly do not pin
//!
//! `diff_text_container` passes a container filter to the diff calculator. The
//! filter is a COST device only: removing it changes which containers the
//! calculator builds deltas for, and this reader discards all but one of them
//! either way, so every assertion here stays green without it. Its value shows up
//! only under measurement -- on a document of a thousand text containers the
//! filtered read stays around a microsecond while the unfiltered `doc.diff` over
//! the same window runs into tens of milliseconds -- and that belongs in a
//! benchmark. A test written as though it could stand in for one would be a check
//! that cannot fail.

use loro::{
    ContainerID, ContainerTrait, ContainerType, ExportMode, Frontiers, LoroDoc, LoroError,
    LoroResult, LoroText, TextDelta, ID,
};
use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

/// Text containers in the random histories. More than one is essential: a
/// single-container document cannot tell a per-container reader apart from a
/// whole-document one.
const CONTAINERS: &[&str] = &["c0", "c1", "c2", "c3"];

/// Rounds of concurrent editing per random history. Each round lets both peers
/// edit and then syncs some of the time, so the merged dag branches and rejoins.
const ROUNDS: usize = 40;

/// Version pairs sampled per random history.
const SAMPLES: usize = 60;

/// Alphabet the random edits insert from, including a multi-byte character so a
/// reader that confuses unicode positions with byte offsets is caught.
const ALPHABET: &[&str] = &[
    "a",
    "bb",
    "ccc",
    "d\u{00e9}",
    "\u{4f60}\u{597d}",
    "\n",
    "    ",
];

fn text_id(name: &str) -> ContainerID {
    ContainerID::new_root(name, ContainerType::Text)
}

/// Applies text deltas to a string the way a consumer would: retain and delete
/// lengths count unicode code points.
///
/// A retain or delete that runs past the end of the text is a malformed delta,
/// not something to absorb: clamping it here would let a reader that reports
/// entity lengths where unicode ones are expected still satisfy the comparison
/// whenever the overshoot falls off the end.
fn apply_deltas(text: &str, deltas: &[TextDelta]) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::new();
    let mut i = 0usize;
    for delta in deltas {
        match delta {
            TextDelta::Retain { retain, .. } => {
                assert!(
                    i + retain <= chars.len(),
                    "delta retains {retain} from {i} but the text is only {} long: {deltas:?}",
                    chars.len()
                );
                out.extend(chars[i..i + retain].iter());
                i += retain;
            }
            TextDelta::Delete { delete } => {
                assert!(
                    i + delete <= chars.len(),
                    "delta deletes {delete} from {i} but the text is only {} long: {deltas:?}",
                    chars.len()
                );
                i += delete;
            }
            TextDelta::Insert { insert, .. } => out.push_str(insert),
        }
    }
    out.extend(chars[i..].iter());
    out
}

fn text_at(doc: &LoroDoc, version: &Frontiers, name: &str) -> String {
    doc.fork_at(version).unwrap().get_text(name).to_string()
}

/// The same deltas, applied by the API that has to accept them.
fn text_via_real_consumer(
    doc: &LoroDoc,
    version: &Frontiers,
    name: &str,
    deltas: &[TextDelta],
) -> String {
    let forked = doc.fork_at(version).unwrap();
    let text = forked.get_text(name);
    text.apply_delta(deltas).unwrap();
    text.to_string()
}

/// One random edit on one container of one peer.
fn random_edit(doc: &LoroDoc, rng: &mut StdRng) {
    let name = CONTAINERS[rng.gen_range(0..CONTAINERS.len())];
    let text = doc.get_text(name);
    let len = text.len_unicode();
    if len > 0 && rng.gen_bool(0.35) {
        let pos = rng.gen_range(0..len);
        let del = rng.gen_range(1..=(len - pos).min(4));
        text.delete(pos, del).unwrap();
    } else {
        let pos = rng.gen_range(0..=len);
        text.insert(pos, ALPHABET[rng.gen_range(0..ALPHABET.len())])
            .unwrap();
    }
}

fn sync(from: &LoroDoc, to: &LoroDoc) {
    let bytes = from.export(ExportMode::updates(&to.oplog_vv())).unwrap();
    if !bytes.is_empty() {
        to.import(&bytes).unwrap();
    }
}

/// A two-peer history with branching and rejoining, plus every version the first
/// peer ever rested at. All returned versions are in the final document's dag.
///
/// The empty frontier is included deliberately: it names the document's
/// beginning, so a window starting there is a container's whole history.
fn random_history(seed: u64) -> (LoroDoc, Vec<Frontiers>) {
    let mut rng = StdRng::seed_from_u64(seed);
    let a = LoroDoc::new();
    a.set_peer_id(1).unwrap();
    let b = LoroDoc::new();
    b.set_peer_id(2).unwrap();

    // Seed every container on one peer so both share a common base.
    for name in CONTAINERS {
        a.get_text(*name).insert(0, "seed text").unwrap();
    }
    a.commit();
    sync(&a, &b);

    let mut versions = vec![Frontiers::default(), a.state_frontiers()];
    let mut b_versions: Vec<Frontiers> = Vec::new();
    for _ in 0..ROUNDS {
        for _ in 0..rng.gen_range(1..=3) {
            random_edit(&a, &mut rng);
        }
        a.commit();
        versions.push(a.state_frontiers());

        for _ in 0..rng.gen_range(1..=3) {
            random_edit(&b, &mut rng);
        }
        b.commit();

        // The second peer's own resting versions matter as much as the first's:
        // every version `a` rests at contains all the ones before it, so a window
        // between two of them can only ever run one way. A version from the other
        // branch is the only kind that gives a window where each endpoint carries
        // ops the other lacks. They are collected here and become readable only
        // after the final sync below.
        b_versions.push(b.state_frontiers());

        if rng.gen_bool(0.5) {
            sync(&b, &a);
            versions.push(a.state_frontiers());
        }
        if rng.gen_bool(0.5) {
            sync(&a, &b);
        }
    }

    sync(&b, &a);
    sync(&a, &b);
    versions.push(a.state_frontiers());
    versions.extend(b_versions);
    (a, versions)
}

#[test]
fn per_container_readers_agree_with_the_document_over_random_histories() {
    // Coverage counters: a run that never produced a changed container, never
    // produced an unchanged one, or never straddled a branch would satisfy every
    // assertion below without exercising the answers they are meant to pin.
    let mut saw_changed = 0usize;
    let mut saw_unchanged = 0usize;
    let mut saw_nontrivial_delta = 0usize;
    let mut saw_whole_history = 0usize;
    // Both endpoints carrying ops the other lacks: the windows the calculator
    // cannot walk forward from `a`, and so the ones that take its rebuild leg.
    let mut saw_divergent_window = 0usize;

    for seed in 0..8u64 {
        let (doc, versions) = random_history(seed);
        let mut rng = StdRng::seed_from_u64(seed ^ 0xa5a5);

        for _ in 0..SAMPLES {
            let a = &versions[rng.gen_range(0..versions.len())];
            let b = &versions[rng.gen_range(0..versions.len())];
            let name = CONTAINERS[rng.gen_range(0..CONTAINERS.len())];
            let cid = text_id(name);

            let spans = doc.find_id_spans_between(a, b);
            if !spans.retreat.is_empty() && !spans.forward.is_empty() {
                saw_divergent_window += 1;
            }
            if a.is_empty() {
                saw_whole_history += 1;
            }

            let text_a = text_at(&doc, a, name);
            let text_b = text_at(&doc, b, name);

            let deltas = doc.diff_text_container(&cid, a, b).unwrap();
            assert_eq!(
                apply_deltas(&text_a, &deltas),
                text_b,
                "seed {seed}: the deltas for {name} between {a:?} and {b:?} did not carry its \
                 text from one version to the other.\n  at a: {text_a:?}\n  at b: {text_b:?}\n  \
                 deltas: {deltas:?}"
            );
            assert_eq!(
                text_via_real_consumer(&doc, a, name, &deltas),
                text_b,
                "seed {seed}: `apply_delta` -- the API these deltas are for -- did not produce \
                 the text at b for {name} between {a:?} and {b:?}: {deltas:?}"
            );

            let changed = doc.container_changed_between(&cid, a, b).unwrap();
            let nontrivial = deltas
                .iter()
                .any(|d| !matches!(d, TextDelta::Retain { .. }));
            if nontrivial {
                saw_nontrivial_delta += 1;
                assert!(
                    changed,
                    "seed {seed}: {name} has a non-trivial delta between {a:?} and {b:?} but was \
                     reported unchanged"
                );
            }
            if changed {
                saw_changed += 1;
            } else {
                saw_unchanged += 1;
                // The converse does not hold in general -- ops that cancel out
                // within the window leave the container changed but its text
                // equal -- so the unchanged answer is what pins the text.
                assert!(
                    !nontrivial,
                    "seed {seed}: {name} was reported unchanged between {a:?} and {b:?} yet its \
                     delta is non-trivial: {deltas:?}"
                );
                assert_eq!(
                    text_a, text_b,
                    "seed {seed}: {name} was reported unchanged between {a:?} and {b:?} yet its \
                     text differs"
                );
            }
        }
    }

    assert!(
        saw_changed > 0
            && saw_unchanged > 0
            && saw_nontrivial_delta > 0
            && saw_whole_history > 0
            && saw_divergent_window > 0,
        "the random histories must produce both answers, at least one real delta, at least one \
         whole-history window and at least one window whose endpoints diverge, or the assertions \
         above cannot fail: changed={saw_changed} unchanged={saw_unchanged} \
         non-trivial={saw_nontrivial_delta} whole-history={saw_whole_history} \
         divergent={saw_divergent_window}"
    );
}

/// A random history in which ONE container is styled.
///
/// The differential suite's own histories are deliberately unstyled, so on its own
/// it says nothing about how the refusal behaves over a real spread of windows.
/// This runs the same shape of history with a mark on one container and checks
/// both halves of the contract at every sampled window: the styled container is
/// refused whatever the window, and its unstyled siblings are answered correctly
/// in the same document. A refusal recorded per document rather than per container
/// would pass the first half and fail the second.
#[test]
fn a_styled_container_is_refused_at_every_window_while_its_siblings_are_answered() {
    let doc = LoroDoc::new();
    doc.set_peer_id(1).unwrap();
    for name in CONTAINERS {
        doc.get_text(*name).insert(0, "seed text").unwrap();
    }
    doc.commit();

    // The style lands early, so most sampled windows are entirely after it and
    // hold no style op of their own -- the case a window-local check would miss.
    let styled_name = CONTAINERS[0];
    doc.get_text(styled_name).mark(0..4, "bold", true).unwrap();
    doc.commit();

    let mut rng = StdRng::seed_from_u64(0x5747);
    let mut versions = vec![Frontiers::default(), doc.state_frontiers()];
    for _ in 0..ROUNDS {
        for _ in 0..rng.gen_range(1..=3) {
            random_edit(&doc, &mut rng);
        }
        doc.commit();
        versions.push(doc.state_frontiers());
    }

    let mut refused = 0usize;
    let mut answered = 0usize;
    for _ in 0..SAMPLES {
        let a = &versions[rng.gen_range(0..versions.len())];
        let b = &versions[rng.gen_range(0..versions.len())];

        let styled = doc.diff_text_container(&text_id(styled_name), a, b);
        assert!(
            matches!(styled, Err(LoroError::NotImplemented(_))),
            "the styled container must be refused at every window, including ones holding no \
             style op of their own; at {a:?}..{b:?} got {styled:?}"
        );
        refused += 1;

        for sibling in &CONTAINERS[1..] {
            let deltas = doc
                .diff_text_container(&text_id(sibling), a, b)
                .unwrap_or_else(|e| {
                    panic!("sibling {sibling} of a styled container must still be answered: {e:?}")
                });
            assert_eq!(
                apply_deltas(&text_at(&doc, a, sibling), &deltas),
                text_at(&doc, b, sibling),
                "sibling {sibling} at {a:?}..{b:?}: {deltas:?}"
            );
            answered += 1;
        }

        // The containment reader reports ops and is unaffected by styles.
        let _ = doc
            .container_changed_between(&text_id(styled_name), a, b)
            .unwrap();
    }

    assert!(
        refused == SAMPLES && answered == SAMPLES * (CONTAINERS.len() - 1),
        "both halves must actually have been exercised: refused={refused} answered={answered}"
    );
}

/// A window whose ops are concurrent with its start version.
///
/// When `a` does not include every op the window replays, the diff calculator
/// cannot start from `a`: it falls back to a common ancestor and rebuilds the
/// container's history forward from there. That is a different code path from
/// the linear one the other tests mostly take, and it is the path a remote
/// peer's arriving edits put a reader on.
#[test]
fn a_window_concurrent_with_its_start_version_is_read_correctly() {
    let local = LoroDoc::new();
    local.set_peer_id(1).unwrap();
    let remote = LoroDoc::new();
    remote.set_peer_id(2).unwrap();

    local.get_text("c0").insert(0, "hello world").unwrap();
    local.get_text("c1").insert(0, "other").unwrap();
    local.commit();
    sync(&local, &remote);
    let base = local.state_frontiers();
    assert!(!base.is_empty());

    // The local edit that defines `a`.
    local.get_text("c0").insert(0, "LOCAL ").unwrap();
    local.commit();
    let a = local.state_frontiers();

    // The remote edit still depends on `base`, so it is concurrent with `a`.
    remote.get_text("c0").insert(5, "-REMOTE-").unwrap();
    remote.commit();
    assert_eq!(
        remote.oplog_frontiers().len(),
        1,
        "the remote edit must build on the shared base, or it is not concurrent with a"
    );

    sync(&remote, &local);
    let b = local.state_frontiers();

    let cid = text_id("c0");
    assert!(
        !local
            .frontiers_to_vv(&a)
            .unwrap()
            .includes_vv(&local.frontiers_to_vv(&b).unwrap()),
        "b must carry ops a does not, or there is no window"
    );

    let deltas = local.diff_text_container(&cid, &a, &b).unwrap();
    assert_eq!(
        apply_deltas(&text_at(&local, &a, "c0"), &deltas),
        text_at(&local, &b, "c0"),
        "the concurrent window's deltas did not carry c0 from a to b: {deltas:?}"
    );
    assert_eq!(
        text_via_real_consumer(&local, &a, "c0", &deltas),
        text_at(&local, &b, "c0"),
        "`apply_delta` did not produce the text at b for the concurrent window: {deltas:?}"
    );
    assert!(
        local.container_changed_between(&cid, &a, &b).unwrap(),
        "c0 carries the concurrent op and must be reported changed"
    );
    assert!(
        !local
            .container_changed_between(&text_id("c1"), &a, &b)
            .unwrap(),
        "c1 has no op in the window and must be reported unchanged"
    );
    assert!(
        local
            .diff_text_container(&text_id("c1"), &a, &b)
            .unwrap()
            .iter()
            .all(|d| matches!(d, TextDelta::Retain { .. })),
        "c1 has no op in the window and must have a trivial delta"
    );
}

/// A root container the document has never written to carries no history. Root
/// containers always exist, so this is an answer, not an error.
#[test]
fn an_untouched_root_container_has_no_history() {
    let doc = LoroDoc::new();
    doc.get_text("c0").insert(0, "hello").unwrap();
    doc.commit();
    let a = doc.state_frontiers();
    doc.get_text("c0").insert(0, "x").unwrap();
    doc.commit();
    let b = doc.state_frontiers();

    let untouched = text_id("never-written");
    assert!(!doc.container_changed_between(&untouched, &a, &b).unwrap());
    assert!(doc
        .diff_text_container(&untouched, &a, &b)
        .unwrap()
        .is_empty());
}

/// A non-root container id that exists nowhere is a caller error, not an answer
/// about an unchanged container.
#[test]
fn a_container_that_exists_nowhere_is_an_error() {
    let doc = LoroDoc::new();
    doc.get_text("c0").insert(0, "hello").unwrap();
    doc.commit();
    let a = Frontiers::default();
    let b = doc.state_frontiers();

    let nowhere = ContainerID::new_normal(ID::new(999, 7), ContainerType::Text);
    assert!(matches!(
        doc.container_changed_between(&nowhere, &a, &b),
        Err(LoroError::NotFoundError(_))
    ));
    assert!(matches!(
        doc.diff_text_container(&nowhere, &a, &b),
        Err(LoroError::NotFoundError(_))
    ));
}

/// Containers a snapshot import has not registered in the arena.
///
/// The arena registers lazily: a document restored from a snapshot can leave a
/// container absent from the arena until something touches it, while its whole
/// history sits in the oplog. A reader that reads "absent from the arena" as "no
/// history" reports such a container unchanged, silently and wrongly -- and the
/// consumer these readers exist for asks its question precisely on a
/// freshly-restored document it has not touched yet.
///
/// Both a root container and one nested in a map are covered, because the import
/// path does not treat them alike. Nothing in this test may take a handler for the
/// container under test, which would register it and destroy the condition.
///
/// HONESTY NOTE: on every import path tried here -- a full snapshot, root and
/// nested containers alike -- the arena turns out to be populated by the time the
/// import returns, so this test stays green whether or not the readers resolve an
/// arena miss. It is a regression guard on the property, not evidence that the
/// miss is reachable. The reachable half of the same fix is
/// `a_container_that_exists_nowhere_is_an_error`, which does discriminate.
#[test]
fn containers_the_arena_has_not_registered_still_report_their_history() {
    let origin = LoroDoc::new();
    origin.set_peer_id(1).unwrap();
    origin.get_text("c0").insert(0, "hello world").unwrap();
    let child = origin
        .get_map("m")
        .insert_container("child", LoroText::new())
        .unwrap();
    child.insert(0, "nested text").unwrap();
    origin.commit();
    origin.get_text("c0").insert(5, " there").unwrap();
    child.insert(6, " and more").unwrap();
    origin.commit();
    let nested_id = child.id();
    assert!(!nested_id.is_root());

    let snapshot = origin.export(ExportMode::Snapshot).unwrap();
    let restored = LoroDoc::new();
    restored.import(&snapshot).unwrap();

    let whole_history = Frontiers::default();
    let head = restored.oplog_frontiers();

    for (cid, expected) in [
        (text_id("c0"), "hello there world"),
        (nested_id, "nested and more text"),
    ] {
        assert!(
            restored
                .container_changed_between(&cid, &whole_history, &head)
                .unwrap(),
            "{cid} has a whole history in the restored document and must not be reported \
             unchanged merely because nothing has touched it since the import"
        );
        let deltas = restored
            .diff_text_container(&cid, &whole_history, &head)
            .unwrap();
        assert_eq!(
            apply_deltas("", &deltas),
            expected,
            "the restored document's deltas for {cid} must rebuild its text from nothing: \
             {deltas:?}"
        );
    }
}

/// Both readers are scoped to text containers, so an id of any other type is a
/// caller error rather than an answer about a container they cannot describe.
#[test]
fn a_non_text_container_is_an_error() {
    let doc = LoroDoc::new();
    doc.get_map("m").insert("k", 1).unwrap();
    doc.commit();
    let a = Frontiers::default();
    let b = doc.state_frontiers();

    let map = ContainerID::new_root("m", ContainerType::Map);
    assert!(matches!(
        doc.container_changed_between(&map, &a, &b),
        Err(LoroError::ArgErr(_))
    ));
    assert!(matches!(
        doc.diff_text_container(&map, &a, &b),
        Err(LoroError::ArgErr(_))
    ));
}

/// A frontier the document does not hold is an error naming that id, not a panic
/// and not some other error. Asserting only `is_err()` would stay green with both
/// validation calls deleted, since the readers would then fail elsewhere.
#[test]
fn an_unknown_frontier_is_an_error_naming_the_id() {
    let doc = LoroDoc::new();
    doc.set_peer_id(1).unwrap();
    doc.get_text("c0").insert(0, "hello").unwrap();
    doc.commit();
    let a = doc.state_frontiers();
    let missing = ID::new(999, 42);
    let bogus = Frontiers::from(missing);
    let expected = Some(LoroError::FrontiersNotFound(missing));
    let cid = text_id("c0");

    assert_eq!(
        doc.container_changed_between(&cid, &bogus, &a).err(),
        expected,
        "an unknown start frontier must be reported by id"
    );
    assert_eq!(
        doc.container_changed_between(&cid, &a, &bogus).err(),
        expected,
        "an unknown end frontier must be reported by id"
    );
    assert_eq!(
        doc.diff_text_container(&cid, &bogus, &a).err(),
        expected,
        "an unknown start frontier must be reported by id"
    );
    assert_eq!(
        doc.diff_text_container(&cid, &a, &bogus).err(),
        expected,
        "an unknown end frontier must be reported by id"
    );
}

/// A version older than a shallow document's root cannot be read, and says so
/// rather than panicking on the trimmed history.
#[test]
fn a_version_before_a_shallow_root_is_an_error() {
    let origin = LoroDoc::new();
    origin.set_peer_id(1).unwrap();
    origin.get_text("c0").insert(0, "hello").unwrap();
    origin.commit();
    let early = origin.state_frontiers();
    origin.get_text("c0").insert(5, " world").unwrap();
    origin.commit();
    let later = origin.state_frontiers();
    origin.get_text("c0").insert(0, "x").unwrap();
    origin.commit();

    let shallow = origin.export(ExportMode::shallow_snapshot(&later)).unwrap();
    let doc = LoroDoc::new();
    doc.import(&shallow).unwrap();
    assert!(
        doc.is_shallow(),
        "the fixture must be shallow, or there is no trimmed history to fall off"
    );

    let cid = text_id("c0");
    let head = doc.oplog_frontiers();
    assert_eq!(
        doc.container_changed_between(&cid, &early, &head).err(),
        Some(LoroError::SwitchToVersionBeforeShallowRoot),
        "a version before the shallow root must be refused, not answered"
    );
    assert_eq!(
        doc.diff_text_container(&cid, &early, &head).err(),
        Some(LoroError::SwitchToVersionBeforeShallowRoot),
        "a version before the shallow root must be refused, not answered"
    );
}

/// A window entirely inside a shallow document's retained history.
///
/// The companion test above only reaches the validation that refuses a version
/// older than the shallow root, so it never exercises the walks themselves on a
/// trimmed document. Those walks span counters from a base version up to the
/// window's end, and a shallow document's change store does not hold the trimmed
/// prefix. This reads a window the document does retain, so both walks run over a
/// trimmed document instead of stopping at validation.
///
/// HONESTY NOTE: asking the change store for a trimmed span yields nothing rather
/// than failing, so this test is green whether the walks start at the shallow root
/// or at nothing. It pins the property, not the choice of base.
#[test]
fn a_shallow_document_is_read_over_its_retained_history() {
    let origin = LoroDoc::new();
    origin.set_peer_id(1).unwrap();
    origin.get_text("c0").insert(0, "hello").unwrap();
    origin.commit();
    origin.get_text("c0").insert(5, " world").unwrap();
    origin.commit();
    let root_version = origin.state_frontiers();
    origin.get_text("c0").insert(0, "AFTER ").unwrap();
    origin.commit();

    let shallow = origin
        .export(ExportMode::shallow_snapshot(&root_version))
        .unwrap();
    let doc = LoroDoc::new();
    doc.import(&shallow).unwrap();
    assert!(
        doc.is_shallow(),
        "the fixture must be shallow, or the trimmed prefix under test does not exist"
    );

    let cid = text_id("c0");
    let root = doc.shallow_since_frontiers();
    let head = doc.oplog_frontiers();
    assert_ne!(root, head, "the retained history must be non-empty");

    assert!(
        doc.container_changed_between(&cid, &root, &head).unwrap(),
        "the retained edit is on c0"
    );
    let deltas = doc.diff_text_container(&cid, &root, &head).unwrap();
    assert_eq!(
        apply_deltas("hello world", &deltas),
        "AFTER hello world",
        "{deltas:?}"
    );
}

/// Two containers edited in what the oplog stores as ONE change.
///
/// Loro merges consecutive commits from the same peer into a single stored
/// change. A reader that scans a change without clipping its ops to the queried
/// counter span therefore sees ops belonging to versions outside the window, and
/// answers `true` for a container that did not change in it. The assertion on
/// `len_changes` is what makes this fixture the bug's shape rather than a
/// coincidence.
#[test]
fn ops_outside_the_window_in_a_merged_change_are_not_counted() {
    let doc = LoroDoc::new();
    doc.set_peer_id(1).unwrap();
    doc.get_text("c0").insert(0, "zero").unwrap();
    doc.commit();
    let after_first = doc.state_frontiers();
    doc.get_text("c1").insert(0, "one").unwrap();
    doc.commit();
    let after_second = doc.state_frontiers();

    assert_eq!(
        doc.len_changes(),
        1,
        "the two commits must land in one stored change, or this fixture does not exercise \
         clipping. Loro merges consecutive same-peer commits within its merge interval; if a \
         future default breaks that, force it rather than relaxing this assertion."
    );
    assert_ne!(after_first, after_second);

    let empty = Frontiers::default();
    assert!(
        !doc.container_changed_between(&text_id("c0"), &after_first, &after_second)
            .unwrap(),
        "c0's op precedes the window and must not be counted just because it shares a stored \
         change with c1's"
    );
    assert!(
        !doc.container_changed_between(&text_id("c1"), &empty, &after_first)
            .unwrap(),
        "c1's op follows the window and must not be counted just because it shares a stored \
         change with c0's"
    );

    // The same clipping, seen through the deltas.
    assert!(doc
        .diff_text_container(&text_id("c0"), &after_first, &after_second)
        .unwrap()
        .iter()
        .all(|d| matches!(d, TextDelta::Retain { .. })));
}

/// Reading history never flushes the document's pending edits.
///
/// An auto-committing document records its ops into the oplog as they are made,
/// but holds their events until the commit that publishes them. `diff` -- the
/// reader these APIs replace -- force-commits that pending work before it can
/// move the document, and the event it publishes is observable. A reader that
/// only reads the oplog publishes nothing.
///
/// The `diff` leg at the end is what arms the assertion: without it, a reader
/// that flushed nothing and a document that had nothing to flush would look the
/// same.
#[test]
fn reading_history_does_not_flush_pending_edits() {
    let doc = LoroDoc::new();
    doc.set_peer_id(1).unwrap();
    doc.get_text("c0").insert(0, "published").unwrap();
    doc.commit();
    let a = Frontiers::default();
    let head = doc.oplog_frontiers();

    let events = Arc::new(AtomicUsize::new(0));
    let counter = events.clone();
    let _sub = doc.subscribe_root(Arc::new(move |_| {
        counter.fetch_add(1, Ordering::SeqCst);
    }));

    doc.get_text("c0").insert(0, "PENDING ").unwrap();
    assert_eq!(
        events.load(Ordering::SeqCst),
        0,
        "the edit must still be pending, or there is nothing for a reader to flush"
    );

    let cid = text_id("c0");
    let deltas = doc.diff_text_container(&cid, &a, &head).unwrap();
    assert_eq!(
        apply_deltas("", &deltas),
        "published",
        "a window that ends before the pending edit must not describe it: {deltas:?}"
    );
    assert!(!doc.container_changed_between(&cid, &head, &head).unwrap());
    assert_eq!(
        events.load(Ordering::SeqCst),
        0,
        "a per-container history read must not publish the document's pending edits"
    );

    doc.diff(&a, &head).unwrap();
    assert_eq!(
        events.load(Ordering::SeqCst),
        1,
        "`diff` force-commits pending work before it walks; without this leg the assertion above \
         could not fail for any implementation"
    );
}

/// A container created INSIDE the window, rather than existing at both ends.
#[test]
fn a_container_created_inside_the_window_is_read_from_nothing() {
    let doc = LoroDoc::new();
    doc.set_peer_id(1).unwrap();
    doc.get_text("c0").insert(0, "root text").unwrap();
    doc.commit();
    let a = doc.state_frontiers();

    let child = doc
        .get_map("m")
        .insert_container("child", LoroText::new())
        .unwrap();
    child.insert(0, "born inside the window").unwrap();
    doc.commit();
    let b = doc.state_frontiers();
    let cid = child.id();
    assert!(
        !cid.is_root(),
        "the fixture must use a non-root container, which is the kind that can be created inside \
         a window"
    );

    assert!(doc.container_changed_between(&cid, &a, &b).unwrap());
    let deltas = doc.diff_text_container(&cid, &a, &b).unwrap();
    assert_eq!(
        apply_deltas("", &deltas),
        "born inside the window",
        "a container created in the window must be read from nothing: {deltas:?}"
    );
}

/// A delete that spans two separately-inserted chunks, and a multi-byte
/// character sitting inside a retain that carries a position.
#[test]
fn deltas_span_chunk_boundaries_and_count_multibyte_characters_once() {
    let doc = LoroDoc::new();
    doc.set_peer_id(1).unwrap();
    let text = doc.get_text("c0");
    text.insert(0, "abc").unwrap();
    doc.commit();
    text.insert(3, "def").unwrap();
    doc.commit();
    let a = doc.state_frontiers();

    // 2..4 straddles the boundary between the "abc" and "def" chunks.
    text.delete(2, 2).unwrap();
    doc.commit();
    let b = doc.state_frontiers();

    let cid = text_id("c0");
    let deltas = doc.diff_text_container(&cid, &a, &b).unwrap();
    assert_eq!(text_at(&doc, &a, "c0"), "abcdef");
    assert_eq!(text_at(&doc, &b, "c0"), "abef");
    assert_eq!(apply_deltas("abcdef", &deltas), "abef", "{deltas:?}");
    assert_eq!(
        text_via_real_consumer(&doc, &a, "c0", &deltas),
        "abef",
        "{deltas:?}"
    );

    // A retain that has to step over characters outside the basic ASCII range.
    let wide = doc.get_text("c1");
    wide.insert(0, "\u{4f60}\u{597d}world").unwrap();
    doc.commit();
    let c = doc.state_frontiers();
    wide.insert(4, "X").unwrap();
    doc.commit();
    let d = doc.state_frontiers();

    let wide_deltas = doc.diff_text_container(&text_id("c1"), &c, &d).unwrap();
    assert_eq!(
        wide_deltas.first(),
        Some(&TextDelta::Retain {
            retain: 4,
            attributes: None
        }),
        "the retain must count the two wide characters as one each, not by their bytes: \
         {wide_deltas:?}"
    );
    assert_eq!(
        apply_deltas("\u{4f60}\u{597d}world", &wide_deltas),
        "\u{4f60}\u{597d}woXrld",
        "{wide_deltas:?}"
    );
}

/// Styled text is out of scope and is refused rather than silently answered with
/// entity positions a consumer would read as unicode ones.
#[test]
fn a_styled_window_is_refused() {
    let doc = LoroDoc::new();
    doc.get_text("c0").insert(0, "hello world").unwrap();
    doc.commit();
    let a = doc.state_frontiers();
    doc.get_text("c0")
        .mark(0..5, "bold", true)
        .expect("marking requires the default style config, which bold has");
    doc.commit();
    let b = doc.state_frontiers();

    let cid = text_id("c0");
    assert!(
        doc.container_changed_between(&cid, &a, &b).unwrap(),
        "a style op is an op on the container"
    );
    assert!(
        matches!(
            doc.diff_text_container(&cid, &a, &b),
            Err(LoroError::NotImplemented(_))
        ),
        "a window carrying a style op must be refused"
    );
}

/// The message the per-container style FACT produces when it refuses.
const REFUSED_BY_FACT: &str = "carries a style op in its history";
/// The message the in-conversion fallback produces when a style anchor turns up
/// inside the window itself. The two must stay distinguishable: only the first is
/// evidence that the recorded fact did the work.
const REFUSED_BY_WINDOW_FALLBACK: &str = "the window inserts a style anchor";

fn error_text(result: &LoroResult<Vec<TextDelta>>) -> String {
    match result {
        Ok(deltas) => format!("Ok({deltas:?})"),
        Err(e) => e.to_string(),
    }
}

/// A document whose styled container's style sits in the EARLIEST history, buried
/// behind enough later changes to fill many stored blocks.
///
/// Both halves of the fixture matter and both are asserted by the callers: the
/// commits must not merge into one stored change, and the stored changes must not
/// all land in one block. A merge interval of zero stops Loro folding consecutive
/// same-peer commits together, which is what made an earlier version of this
/// fixture a single change that never tested anything.
///
/// Returns the document, the window `(a, b)` at the far end of its history, and
/// the number of blocks the document holds.
fn doc_with_a_style_behind_many_blocks() -> (LoroDoc, Frontiers, Frontiers, usize) {
    const LATER_COMMITS: usize = 3000;

    let origin = LoroDoc::new();
    origin.set_peer_id(1).unwrap();
    // Consecutive same-peer commits merge into one stored change when their
    // timestamps are within the merge interval. An interval of ZERO still merges,
    // since commits a fraction of a second apart are zero seconds apart; a negative
    // one merges nothing. Measured: 3000 commits give 1 change at interval 0 and
    // 3000 changes in 4 blocks at -1.
    origin.set_change_merge_interval(-1);

    origin.get_text("styled").insert(0, "hello world").unwrap();
    origin.commit();
    origin.get_text("styled").mark(0..5, "bold", true).unwrap();
    origin.commit();

    for _ in 0..LATER_COMMITS {
        origin.get_text("bulk").insert(0, "x").unwrap();
        origin.commit();
    }
    let a = origin.state_frontiers();
    origin.get_text("styled").insert(11, "!").unwrap();
    origin.commit();
    let b = origin.oplog_frontiers();

    // `len_changes` parses every block in order to count, so ask it first and read
    // the block count afterwards: that way the count is the document's whole
    // history and not just what happened to be in memory.
    assert!(
        origin.len_changes() > LATER_COMMITS,
        "the commits must stay separate changes, or the style is in the same change as the \
         window and nothing about history depth is being tested: {} changes",
        origin.len_changes()
    );
    let blocks = origin.parsed_change_block_len();
    assert!(
        blocks > 1,
        "the changes must span more than one stored block, or a reader that sees one block sees \
         the whole history and the fixture proves nothing: {blocks} blocks"
    );

    (origin, a, b, blocks)
}

/// A styled container in a document restored from a snapshot.
///
/// The refusal is a fact recorded where changes are registered, not a walk, so it
/// has to survive the round trip through a snapshot: a restored document must
/// refuse the container without anyone having read its history first. Nothing here
/// reads the container before the reader does.
///
/// It survives here for a reason worth naming, because it does not generalise: a
/// snapshot import parses exactly one change block, and a document this small fits
/// entirely in it, so the fact is recorded for the whole history as a side effect
/// of the import. The assertions below pin both halves -- one block parsed, and the
/// refusal coming from the recorded fact rather than from a style anchor in the
/// window -- so that if either changes, this test says so instead of quietly
/// becoming evidence for something it no longer shows. The companion test with a
/// history too large for one block is where the gap appears.
#[test]
fn a_styled_container_is_refused_after_a_snapshot_round_trip() {
    let origin = LoroDoc::new();
    origin.set_peer_id(1).unwrap();
    origin.get_text("styled").insert(0, "hello world").unwrap();
    origin.get_text("plain").insert(0, "hello world").unwrap();
    origin.commit();
    origin.get_text("styled").mark(0..5, "bold", true).unwrap();
    origin.commit();
    let a = origin.state_frontiers();
    origin.get_text("styled").insert(11, "!").unwrap();
    origin.get_text("plain").insert(11, "!").unwrap();
    origin.commit();

    // `b` is taken from the origin, so the reader below is the FIRST thing to
    // touch the restored document: nothing has had a chance to parse its history
    // and set the fact as a side effect.
    let b = origin.oplog_frontiers();
    let snapshot = origin.export(ExportMode::Snapshot).unwrap();
    let restored = LoroDoc::new();
    restored.import(&snapshot).unwrap();

    assert_eq!(
        restored.parsed_change_block_len(),
        1,
        "a snapshot import parses exactly one change block; for a document this small that one \
         block IS the whole history, which is why the fact is set here and why the deep fixture \
         elsewhere in this file is needed to find the gap"
    );

    let styled = text_id("styled");
    let result = restored.diff_text_container(&styled, &a, &b);
    let text = error_text(&result);
    assert!(
        text.contains(REFUSED_BY_FACT),
        "the refusal must come from the recorded fact, not from a style anchor inside the \
         window -- the window here holds only a plain insert; got {text}"
    );
    assert!(
        !text.contains(REFUSED_BY_WINDOW_FALLBACK),
        "the window carries no style op, so the in-conversion fallback must not be what refuses \
         here; got {text}"
    );

    // The fact is per container, not per document.
    let plain = text_id("plain");
    let plain_deltas = restored.diff_text_container(&plain, &a, &b).unwrap();
    assert_eq!(
        apply_deltas(&text_at(&restored, &a, "plain"), &plain_deltas),
        text_at(&restored, &b, "plain"),
        "an unstyled container in the same document must still be answered: {plain_deltas:?}"
    );
}

/// A style buried deep in a SNAPSHOT-restored document's history, with the window
/// far away from it. THIS IS THE KNOWN GAP, and it is why this test is ignored.
///
/// The fact is recorded where changes are registered, which every local commit and
/// every imported update passes through. A snapshot does not: its history arrives
/// as stored blocks decoded only when something reads them, so a style op in a
/// block nothing has read leaves the fact unset and the reader answers where it
/// should refuse.
///
/// Closing it exactly needs one of two things, and both are larger than a reader
/// API: decoding every block at snapshot import, which gives up the lazy history
/// loading snapshots exist for, or carrying the fact in the snapshot encoding,
/// which is a wire-format change. Deriving it from the container's loaded state
/// does not close it either -- that answers "styled at head", not "styled ever",
/// and a restored container's state is itself lazy, so for this fixture it would
/// not even be loaded.
///
/// Left ignored rather than deleted so the gap stays pinned where the code is. It
/// fails today; do not "fix" it by weakening the assertion or the fixture.
#[test]
#[ignore = "known gap: a snapshot's unread blocks leave the per-container style fact unset"]
fn a_style_deep_in_a_restored_history_is_still_refused() {
    let (origin, a, b, blocks) = doc_with_a_style_behind_many_blocks();

    let snapshot = origin.export(ExportMode::Snapshot).unwrap();
    let restored = LoroDoc::new();
    restored.import(&snapshot).unwrap();
    let parsed = restored.parsed_change_block_len();
    assert!(
        parsed < blocks,
        "the restored document must start with most of its history undecoded -- that is the \
         condition under test: it parsed {parsed} of the origin's {blocks} blocks"
    );

    let result = restored.diff_text_container(&text_id("styled"), &a, &b);
    assert!(
        error_text(&result).contains(REFUSED_BY_FACT),
        "a style at the far end of a restored document's history must be refused by the \
         recorded fact; got {}",
        error_text(&result)
    );
}

/// The same style, equally deep, in a document assembled from UPDATES.
///
/// Updates are applied change by change through the registration every local
/// commit also passes through, so the fact is recorded for all of them however far
/// back the style sits. Sharing the fixture with the ignored snapshot test above is
/// the point: the two differ only in how the history arrives, which isolates the
/// gap to the snapshot path rather than leaving it looking like a general one.
#[test]
fn a_style_deep_in_an_update_imported_history_is_refused() {
    let (origin, a, b, _blocks) = doc_with_a_style_behind_many_blocks();

    let updates = origin.export(ExportMode::all_updates()).unwrap();
    let restored = LoroDoc::new();
    restored.import(&updates).unwrap();

    let result = restored.diff_text_container(&text_id("styled"), &a, &b);
    assert!(
        error_text(&result).contains(REFUSED_BY_FACT),
        "a style at the far end of an update-imported history must be refused by the recorded \
         fact; got {}",
        error_text(&result)
    );
    // Per container, not per document.
    assert!(restored
        .diff_text_container(&text_id("bulk"), &a, &b)
        .is_ok());
}

/// A style anchor created BEFORE the window.
///
/// The window itself contains only a plain insert, so nothing in the delta
/// announces the style: the anchors are merely retained across. But the raw delta
/// counts entity positions, and the anchors occupy two of them, so every retain
/// and delete in the answer would be shifted by the anchors that precede the
/// edit. The reader must refuse the container on its history, not on the window's
/// contents.
#[test]
fn a_style_created_before_the_window_is_refused() {
    let doc = LoroDoc::new();
    doc.set_peer_id(1).unwrap();
    let text = doc.get_text("c0");
    text.insert(0, "hello world").unwrap();
    doc.commit();
    text.mark(0..5, "bold", true).unwrap();
    doc.commit();
    let a = doc.state_frontiers();

    // A plain insert AFTER the marked region: the window holds no style op.
    text.insert(11, "!").unwrap();
    doc.commit();
    let b = doc.state_frontiers();

    let cid = text_id("c0");
    assert_eq!(
        text_at(&doc, &a, "c0"),
        "hello world",
        "the fixture's text must be unstyled-looking, so only the entity positions differ"
    );
    let result = doc.diff_text_container(&cid, &a, &b);
    assert!(
        matches!(result, Err(LoroError::NotImplemented(_))),
        "a container carrying a style anchor from before the window must be refused, because \
         every length in the answer would be an entity count shifted by those anchors; got \
         {result:?}"
    );

    // The containment reader is unaffected: it reports ops, not positions.
    assert!(doc.container_changed_between(&cid, &a, &b).unwrap());
}
