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
fn race_reader_against<F>(rewind: F) -> Observations
where
    F: Fn(&LoroDoc, &Frontiers, &Frontiers) + Send + 'static,
{
    let (doc, earlier, resting) = doc_with_two_commits();
    let rewinding_finished = Arc::new(AtomicBool::new(false));

    let rewinder = {
        let doc = doc.clone();
        let earlier = earlier.clone();
        let resting = resting.clone();
        let finished = rewinding_finished.clone();
        std::thread::spawn(move || {
            for _ in 0..REWINDS {
                rewind(&doc, &earlier, &resting);
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
    let observations = race_reader_against(|doc, earlier, resting| {
        doc.diff(earlier, resting).unwrap();
    });
    assert!(
        observations.violations.is_empty(),
        "{}",
        observations.report("diff")
    );
}

#[test]
fn fork_at_never_exposes_an_intermediate_version_to_a_reader() {
    let observations = race_reader_against(|doc, earlier, _resting| {
        doc.fork_at(earlier).unwrap();
    });
    assert!(
        observations.violations.is_empty(),
        "{}",
        observations.report("fork_at")
    );
}
