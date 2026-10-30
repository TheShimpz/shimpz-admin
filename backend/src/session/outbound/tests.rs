use super::*;

#[tokio::test]
async fn a_newer_change_notice_replaces_the_queued_one_and_results_keep_their_order() {
    let queue = Outbound::new(1024);
    queue.put("result-1".to_owned(), None).unwrap();
    queue.put("teams-1".to_owned(), Some("teams")).unwrap();
    queue.put("result-2".to_owned(), None).unwrap();
    queue.put("teams-2".to_owned(), Some("teams")).unwrap();
    assert_eq!(queue.take().await, "result-1");
    assert_eq!(queue.take().await, "teams-2");
    assert_eq!(queue.take().await, "result-2");
    assert_eq!(queue.queued(), 0);
    queue.put("teams-3".to_owned(), Some("teams")).unwrap();
    assert_eq!(queue.take().await, "teams-3");
}

#[test]
fn more_than_the_bound_overflows_and_a_closed_queue_refuses() {
    let queue = Outbound::new(8);
    queue.put("12345".to_owned(), None).unwrap();
    assert_eq!(queue.put("12345".to_owned(), None), Err(Refused::Overflow));
    queue.close();
    assert_eq!(queue.put("1".to_owned(), None), Err(Refused::Closed));
}
