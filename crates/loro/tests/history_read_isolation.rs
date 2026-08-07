//! A concurrent reader must never observe a version the document is only
//! passing through.
//!
//! Several public operations answer questions about history by moving the live
//! shared document backwards to an older version, reading what they need there,
//! and moving it forward again. `diff` and `fork_at` both work this way. While
//! such an operation is in flight the document is parked, briefly, at a version
//! it never legitimately rests at, and a reader on another thread can see it
//! there.
//!
//! # Why the oracle is the version and not the text
//!
//! Asserting on the text a reader sees cannot fail, and so proves nothing. The
//! intermediate versions these operations pass through hold text that is
//! content-identical to text the document legitimately holds at some resting
//! point, so a length or content assertion is satisfied whether or not the
//! reader raced the rewind.
//!
//! The version does discriminate. Nothing writes to the document once the
//! threads below start, so the document has exactly one legitimate resting
//! version for the whole of each test: the frontier left by the last commit
//! before the threads were spawned. Any other frontier a reader observes can
//! only have come from inside a rewind window. Please do not "simplify" this
//! into a check on text length.
//!
//! These tests are bounded by iteration count rather than by wall clock, and
//! contain no sleeps, so a slow or loaded machine makes them slower but never
//! flakier.
#![cfg(not(loom))]

use loro::{Frontiers, LoroDoc};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// How many times the rewinding operation is performed. The reader samples for
/// exactly as long as that takes.
const REWINDS: usize = 500;

/// A document with two commits: an earlier version to rewind to, and the
/// resting version that is the only one any reader may legitimately observe.
fn doc_with_two_commits() -> (LoroDoc, Frontiers, Frontiers) {
    let doc = LoroDoc::new();
    doc.get_text("text").insert(0, "hello").unwrap();
    doc.commit();
    let earlier = doc.state_frontiers();

    doc.get_text("text").insert(5, " world").unwrap();
    doc.commit();
    let resting = doc.state_frontiers();

    assert_ne!(
        earlier, resting,
        "the two commits must produce distinct versions or there is no rewind to observe"
    );
    (doc, earlier, resting)
}

/// A document with three commits, returning the two earliest versions and the
/// resting one.
///
/// A rewind that walks between the two *earliest* versions ends its walk at the
/// second, not at where the document rests — so restoring the document afterwards
/// is a genuine move back to the third version, performed inside the locked
/// window. A rewind whose endpoints straddle the resting version (as
/// [`doc_with_two_commits`] produces) leaves the restore a no-op, and so cannot
/// tell whether the restore is inside the window or outside it.
fn doc_with_three_commits() -> (LoroDoc, Frontiers, Frontiers, Frontiers) {
    let doc = LoroDoc::new();
    doc.get_text("text").insert(0, "hello").unwrap();
    doc.commit();
    let first = doc.state_frontiers();

    doc.get_text("text").insert(5, " world").unwrap();
    doc.commit();
    let second = doc.state_frontiers();

    doc.get_text("text").insert(11, " again").unwrap();
    doc.commit();
    let resting = doc.state_frontiers();

    assert_ne!(first, second);
    assert_ne!(second, resting);
    (doc, first, second, resting)
}

/// The outcome of one race: how many times the reader sampled the document, and
/// every sample whose version was not the resting version.
struct Observations {
    resting: Frontiers,
    samples: usize,
    violations: Vec<Frontiers>,
}

impl Observations {
    fn report(&self, operation: &str) -> String {
        let mut distinct: Vec<String> = Vec::new();
        for v in &self.violations {
            let rendered = format!("{:?}", v);
            if !distinct.contains(&rendered) {
                distinct.push(rendered);
            }
        }
        format!(
            "while another thread ran `{}` {} times, a reader took {} samples of the document \
             version and {} of them were versions the document only passes through.\n  \
             resting version, the only legitimate one: {:?}\n  \
             distinct versions observed instead: {:?}",
            operation,
            REWINDS,
            self.samples,
            self.violations.len(),
            self.resting,
            distinct,
        )
    }
}

/// Runs `rewind` repeatedly on one thread while another thread samples the
/// document's version, and reports every sample that was not the resting one.
///
/// The rewind closure captures whatever historical versions it operates on, so
/// that this harness is agnostic to which operation is under test. `resting` is
/// the version the document sits at throughout — the only version a reader may
/// legitimately observe, since nothing writes to the document once the threads
/// start.
fn race_reader_against<F>(doc: LoroDoc, resting: Frontiers, rewind: F) -> Observations
where
    F: Fn(&LoroDoc) + Send + 'static,
{
    let rewinding_finished = Arc::new(AtomicBool::new(false));

    let rewinder = {
        let doc = doc.clone();
        let finished = rewinding_finished.clone();
        std::thread::spawn(move || {
            for _ in 0..REWINDS {
                rewind(&doc);
            }
            finished.store(true, Ordering::SeqCst);
        })
    };

    let reader = {
        let doc = doc.clone();
        let resting = resting.clone();
        let finished = rewinding_finished.clone();
        std::thread::spawn(move || {
            let mut samples = 0usize;
            let mut violations = Vec::new();
            while !finished.load(Ordering::SeqCst) {
                let seen = doc.state_frontiers();
                samples += 1;
                if seen != resting {
                    violations.push(seen);
                }
            }
            (samples, violations)
        })
    };

    rewinder.join().unwrap();
    let (samples, violations) = reader.join().unwrap();
    Observations {
        resting,
        samples,
        violations,
    }
}

#[test]
fn diff_never_exposes_an_intermediate_version_to_a_reader() {
    let (doc, earlier, resting) = doc_with_two_commits();
    let a = earlier;
    let b = resting.clone();
    let observations = race_reader_against(doc, resting, move |doc| {
        doc.diff(&a, &b).unwrap();
    });
    assert!(
        observations.violations.is_empty(),
        "{}",
        observations.report("diff")
    );
}

/// The discriminating case for the restore leg: `diff` walks between the two
/// *earliest* versions while the document rests at a third, so returning it to
/// rest is a real move performed inside the locked window. If that final move
/// were made outside the locks — or omitted — a reader would observe the second
/// version, which is not the resting one, and this test would fail where the
/// straddling case above cannot.
#[test]
fn diff_between_two_historical_versions_never_exposes_the_restore_move() {
    let (doc, first, second, resting) = doc_with_three_commits();
    let a = first;
    let b = second;
    let observations = race_reader_against(doc, resting, move |doc| {
        doc.diff(&a, &b).unwrap();
    });
    assert!(
        observations.violations.is_empty(),
        "{}",
        observations.report("diff")
    );
}

#[test]
fn fork_at_never_exposes_an_intermediate_version_to_a_reader() {
    let (doc, earlier, resting) = doc_with_two_commits();
    let a = earlier;
    let observations = race_reader_against(doc, resting, move |doc| {
        doc.fork_at(&a).unwrap();
    });
    assert!(
        observations.violations.is_empty(),
        "{}",
        observations.report("fork_at")
    );
}
