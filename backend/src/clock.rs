//! Admin's two clocks: the wall clock and a monotonic clock, in whole milliseconds, each shiftable by tests.
//!
//! Production reads the system clocks. A test moves either forward without sleeping, so expiries, idle times, and
//! lockouts are proved at once.

use std::{
    sync::atomic::{AtomicI64, Ordering},
    time::{Instant, SystemTime, UNIX_EPOCH},
};

/// The clocks Admin reads.
#[derive(Debug)]
pub struct Clock {
    base: Instant,
    wall_offset_ms: AtomicI64,
    monotonic_offset_ms: AtomicI64,
}

impl Default for Clock {
    fn default() -> Self {
        Self::new()
    }
}

impl Clock {
    /// The system clocks.
    #[must_use]
    pub fn new() -> Self {
        Self {
            base: Instant::now(),
            wall_offset_ms: AtomicI64::new(0),
            monotonic_offset_ms: AtomicI64::new(0),
        }
    }

    /// The wall time in Unix milliseconds.
    #[must_use]
    pub fn now_ms(&self) -> i64 {
        let since = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |elapsed| {
                i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX)
            });
        since.saturating_add(self.wall_offset_ms.load(Ordering::Relaxed))
    }

    /// The wall time in whole Unix seconds (`int(time.time())`).
    #[must_use]
    pub fn now_secs(&self) -> i64 {
        self.now_ms().div_euclid(1000)
    }

    /// Milliseconds on the monotonic clock (`time.monotonic()`), from an arbitrary start.
    #[must_use]
    pub fn monotonic_ms(&self) -> i64 {
        i64::try_from(self.base.elapsed().as_millis())
            .unwrap_or(i64::MAX)
            .saturating_add(self.monotonic_offset_ms.load(Ordering::Relaxed))
    }

    /// Moves both clocks forward by `milliseconds` (only tests shift a clock).
    pub fn advance_ms(&self, milliseconds: i64) {
        self.wall_offset_ms
            .fetch_add(milliseconds, Ordering::Relaxed);
        self.monotonic_offset_ms
            .fetch_add(milliseconds, Ordering::Relaxed);
    }

    /// Moves both clocks forward by whole `seconds`.
    pub fn advance(&self, seconds: i64) {
        self.advance_ms(seconds.saturating_mul(1000));
    }
}
