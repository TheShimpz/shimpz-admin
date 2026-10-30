use std::time::Duration;

use super::*;

#[tokio::test]
async fn a_full_lane_refuses_at_once_and_a_waiting_job_can_be_cancelled() {
    let lane = Lane::new(1, 2);
    let (release, wait) = tokio::sync::oneshot::channel::<()>();
    let running = lane
        .submit(async move {
            let _ = wait.await;
            1
        })
        .unwrap();
    let waiting = lane.submit(async { 2 }).unwrap();
    assert!(lane.submit(async { 3 }).is_err());
    assert!(waiting.cancel());
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(!running.cancel(), "a running job is never cancelled");
    let _ = release.send(());
    assert_eq!(running.wait().await, Ended::Done(1));
    assert_eq!(waiting.wait().await, Ended::Cancelled);
}

#[tokio::test]
async fn a_detached_job_finishes_when_nobody_waits_and_a_panic_is_contained() {
    let (done, observed) = tokio::sync::oneshot::channel();
    drop(detach(async move {
        tokio::time::sleep(Duration::from_millis(10)).await;
        let _ = done.send(7);
    }));
    assert_eq!(observed.await.unwrap(), 7);
    let lane = Lane::new(1, 1);
    let panicked = lane.submit(async { panic!("PRIVATE_SENTINEL") }).unwrap();
    assert_eq!(panicked.wait().await, Ended::<()>::Panicked);
    assert_eq!(
        lane.submit(async { 5 }).unwrap().wait().await,
        Ended::Done(5)
    );
}
