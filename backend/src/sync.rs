//! Locking that survives a panic in another holder: a poisoned lock's state is still Admin's own state.

use std::sync::{Mutex, MutexGuard, PoisonError};

/// Locks `mutex`, taking over the state a panicking holder left.
pub fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}
