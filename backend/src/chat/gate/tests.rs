use std::sync::atomic::{AtomicUsize, Ordering};

use super::*;

fn silent() -> Position {
    Arc::new(|_| {})
}

#[tokio::test]
async fn operations_beyond_the_limit_wait_in_order_and_start_as_slots_free() {
    let gate = Arc::new(Gate::default());
    let first = gate.slot(silent(), async { Some(1) }).await.unwrap();
    assert_eq!(gate.limit(), Some(1));
    let told = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&told);
    let position: Position = Arc::new(move |place| lock(&seen).push(place));
    let waiting = {
        let gate = Arc::clone(&gate);
        tokio::spawn(async move { gate.slot(position, async { Some(1) }).await.map(|_| ()) })
    };
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert_eq!(*lock(&told), vec![Some(1)]);
    drop(first);
    waiting.await.unwrap().unwrap();
    assert_eq!(*lock(&told), vec![Some(1), None]);
}

#[tokio::test]
async fn a_cancelled_waiter_leaves_the_queue_and_a_failed_limit_read_is_refused() {
    let gate = Arc::new(Gate::default());
    assert_eq!(
        gate.slot(silent(), async { None }).await.err(),
        Some(Refused::LimitUnavailable)
    );
    let held = gate.slot(silent(), async { Some(1) }).await.unwrap();
    let starts = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&starts);
    let waiter = {
        let gate = Arc::clone(&gate);
        tokio::spawn(async move {
            let _slot = gate.slot(silent(), async { Some(1) }).await;
            counted.fetch_add(1, Ordering::SeqCst);
        })
    };
    tokio::time::sleep(Duration::from_millis(20)).await;
    waiter.abort();
    let _ = waiter.await;
    drop(held);
    let again = gate.slot(silent(), async { Some(1) }).await;
    assert!(again.is_ok());
    assert_eq!(starts.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn the_queue_refuses_beyond_its_bound() {
    let gate = Arc::new(Gate::default());
    gate.set_limit(0);
    let mut waiters = Vec::new();
    for _ in 0..MAX_WAITING {
        let gate = Arc::clone(&gate);
        waiters.push(tokio::spawn(async move {
            gate.slot(silent(), async { Some(0) }).await.map(|_| ())
        }));
    }
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert_eq!(
        gate.slot(silent(), async { Some(0) }).await.err(),
        Some(Refused::QueueFull)
    );
    for waiter in waiters {
        waiter.abort();
    }
}
