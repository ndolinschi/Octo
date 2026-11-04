use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex as SyncMutex;

use tokio::sync::{Mutex, OwnedMutexGuard};

pub(super) struct SessionGate {
    gates: Arc<SyncMutex<HashMap<String, Arc<Mutex<()>>>>>,
    id: String,
    lock: Arc<Mutex<()>>,
    guard: Option<OwnedMutexGuard<()>>,
    pending: Option<Arc<Mutex<()>>>,
}

impl SessionGate {
    pub(super) fn new(
        gates: Arc<SyncMutex<HashMap<String, Arc<Mutex<()>>>>>,
        session_id: &str,
    ) -> Self {
        let mut map = match gates.lock() {
            Ok(map) => map,
            Err(poisoned) => poisoned.into_inner(),
        };
        let lock = map
            .entry(session_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone();
        drop(map);
        Self {
            gates,
            id: session_id.to_string(),
            lock: Arc::clone(&lock),
            guard: None,
            pending: Some(lock),
        }
    }

    pub(super) async fn acquire(mut self) -> Self {
        let lock = self
            .pending
            .take()
            .unwrap_or_else(|| Arc::clone(&self.lock));
        self.guard = Some(lock.lock_owned().await);
        self
    }
}

impl Drop for SessionGate {
    fn drop(&mut self) {
        self.guard.take();
        let mut gates = match self.gates.lock() {
            Ok(gates) => gates,
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Some(existing) = gates.get(&self.id) {
            if Arc::ptr_eq(existing, &self.lock) && Arc::strong_count(&self.lock) == 2 {
                gates.remove(&self.id);
            }
        }
    }
}
