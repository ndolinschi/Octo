use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use sqlx::{Row, SqlitePool};
use tokio::sync::Notify;

use super::error::HistoryError;
use super::History;
use crate::auto::CallRow;

const PRUNE_BATCH: i64 = 500;
const PRUNE_PAUSE: Duration = Duration::from_millis(20);

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Retention {
    pub calls_max_age: Option<Duration>,
    pub calls_max_rows: Option<u64>,
    pub spend_max_age: Option<Duration>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PruneStats {
    pub calls_by_age: u64,
    pub calls_by_rows: u64,
    pub spend_rows: u64,
    pub history_calls_by_age: u64,
    pub history_calls_by_rows: u64,
    pub decisions_by_age: u64,
    pub session_outcomes_by_age: u64,
    pub delegations_by_age: u64,
    pub delegation_outcomes_by_age: u64,
}

type Work = Pin<Box<dyn Future<Output = ()> + Send>>;

pub(super) fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn micros_to_sql(micros: u64) -> i64 {
    i64::try_from(micros).unwrap_or(i64::MAX)
}

impl History {
    pub fn with_retention(mut self, retention: Retention) -> Self {
        self.retention = retention;
        self
    }

    pub fn retention(&self) -> Retention {
        self.retention
    }

    pub(super) fn spawn_write(
        &self,
        what: &'static str,
        work: impl FnOnce(SqlitePool) -> Work + Send + 'static,
    ) {
        let Some(pool) = self.pool.clone() else {
            return;
        };
        let inserts = self.inserts.clone();
        let inflight = self.inflight.clone();
        let idle: Arc<Notify> = self.idle.clone();
        let dropped = self.dropped_inserts.clone();
        let acquire_timeout = self.insert_acquire_timeout;
        inflight.fetch_add(1, Ordering::AcqRel);
        tokio::spawn(async move {
            struct Done(Arc<std::sync::atomic::AtomicUsize>, Arc<Notify>);
            impl Drop for Done {
                fn drop(&mut self) {
                    if self.0.fetch_sub(1, Ordering::AcqRel) == 1 {
                        self.1.notify_waiters();
                    }
                }
            }
            let _done = Done(inflight, idle);
            let permit = match tokio::time::timeout(acquire_timeout, inserts.acquire_owned()).await
            {
                Ok(Ok(permit)) => permit,
                _ => {
                    dropped.fetch_add(1, Ordering::Relaxed);
                    tracing::warn!(what, "history write skipped; queue wait timed out");
                    return;
                }
            };
            let _permit = permit;
            work(pool).await;
        });
    }

    pub fn record_call_row(
        &self,
        request_id: &str,
        session_id: Option<&str>,
        budget_key: Option<&str>,
        row: &CallRow,
    ) {
        let Ok(record) = serde_json::to_string(row) else {
            return;
        };
        let request_id = request_id.to_string();
        let session_id = session_id.map(str::to_string);
        let budget_key = budget_key.map(str::to_string);
        let trigger = row.trigger.clone();
        let model = row.model.clone();
        let cost_micros = micros_to_sql((row.cost_usd.max(0.0) * 1_000_000.0).round() as u64);
        self.spawn_write("call record", move |pool| {
            Box::pin(async move {
                let result = sqlx::query(
                    r#"
                    INSERT INTO autoroute_calls
                        (request_id, created_at, session_id, budget_key, trigger, model, cost_micros, record)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(request_id) DO NOTHING
                    "#,
                )
                .bind(&request_id)
                .bind(now_millis())
                .bind(session_id)
                .bind(budget_key)
                .bind(trigger)
                .bind(model)
                .bind(cost_micros)
                .bind(record)
                .execute(&pool)
                .await;
                if let Err(err) = result {
                    tracing::warn!(%err, request_id, "call record insert failed");
                }
            })
        });
    }

    pub fn add_budget_spend(&self, budget_key: String, micros: u64) {
        if micros == 0 {
            return;
        }
        self.spawn_write("budget spend", move |pool| {
            Box::pin(async move {
                let result = sqlx::query(
                    r#"
                    INSERT INTO budget_spend (budget_key, spent_micros, updated_at)
                    VALUES (?1, ?2, ?3)
                    ON CONFLICT(budget_key) DO UPDATE SET
                        spent_micros = spent_micros + excluded.spent_micros,
                        updated_at = excluded.updated_at
                    "#,
                )
                .bind(&budget_key)
                .bind(micros_to_sql(micros))
                .bind(now_millis())
                .execute(&pool)
                .await;
                if let Err(err) = result {
                    tracing::warn!(%err, budget_key, "budget spend upsert failed");
                }
            })
        });
    }

    pub async fn call_record(&self, request_id: &str) -> Option<serde_json::Value> {
        let pool = self.pool.as_ref()?;
        let row = sqlx::query("SELECT record FROM autoroute_calls WHERE request_id = ?")
            .bind(request_id)
            .fetch_optional(pool)
            .await
            .map_err(|err| tracing::warn!(%err, "call record read failed"))
            .ok()??;
        serde_json::from_str(&row.get::<String, _>("record")).ok()
    }

    pub async fn budget_spent_micros(&self, budget_key: &str) -> Result<Option<u64>, HistoryError> {
        let Some(pool) = self.pool.as_ref() else {
            return Ok(None);
        };
        let row = sqlx::query("SELECT spent_micros FROM budget_spend WHERE budget_key = ?")
            .bind(budget_key)
            .fetch_optional(pool)
            .await?;
        Ok(row.map(|row| u64::try_from(row.get::<i64, _>("spent_micros")).unwrap_or(0)))
    }

    pub async fn prune(&self) -> Result<PruneStats, HistoryError> {
        let Some(pool) = self.pool.as_ref() else {
            return Ok(PruneStats::default());
        };
        let retention = self.retention;
        let mut stats = PruneStats::default();
        if let Some(max_age) = retention.calls_max_age {
            let cutoff = now_millis().saturating_sub(max_age.as_millis() as i64);
            stats.calls_by_age = delete_batches(
                pool,
                "DELETE FROM autoroute_calls WHERE seq IN \
                 (SELECT seq FROM autoroute_calls WHERE created_at < ?1 ORDER BY seq LIMIT ?2)",
                cutoff,
            )
            .await?;
            stats.history_calls_by_age = delete_batches(
                pool,
                "DELETE FROM calls WHERE id IN \
                 (SELECT id FROM calls WHERE created_at < ?1 ORDER BY id LIMIT ?2)",
                cutoff,
            )
            .await?;
            stats.decisions_by_age = delete_batches(
                pool,
                "DELETE FROM decisions WHERE id IN \
                 (SELECT id FROM decisions WHERE created_at < ?1 ORDER BY id LIMIT ?2)",
                cutoff,
            )
            .await?;
            stats.session_outcomes_by_age = delete_batches(
                pool,
                "DELETE FROM session_outcomes WHERE session_id IN \
                 (SELECT session_id FROM session_outcomes WHERE updated_at < ?1 LIMIT ?2)",
                cutoff,
            )
            .await?;
            stats.delegations_by_age = delete_batches(
                pool,
                "DELETE FROM delegations WHERE seq IN \
                 (SELECT seq FROM delegations WHERE created_at < ?1 ORDER BY seq LIMIT ?2)",
                cutoff,
            )
            .await?;
            stats.delegation_outcomes_by_age = delete_batches(
                pool,
                "DELETE FROM delegation_outcomes WHERE seq IN \
                 (SELECT seq FROM delegation_outcomes WHERE received_at < ?1 ORDER BY seq LIMIT ?2)",
                cutoff,
            )
            .await?;
        }
        if let Some(max_rows) = retention.calls_max_rows {
            let offset = i64::try_from(max_rows).unwrap_or(i64::MAX);
            stats.calls_by_rows = delete_batches(
                pool,
                "DELETE FROM autoroute_calls WHERE seq IN \
                 (SELECT seq FROM autoroute_calls WHERE seq <= COALESCE( \
                    (SELECT seq FROM autoroute_calls ORDER BY seq DESC LIMIT 1 OFFSET ?1), 0) \
                  ORDER BY seq LIMIT ?2)",
                offset,
            )
            .await?;
            stats.history_calls_by_rows = delete_batches(
                pool,
                "DELETE FROM calls WHERE id IN \
                 (SELECT id FROM calls WHERE id <= COALESCE( \
                    (SELECT id FROM calls ORDER BY id DESC LIMIT 1 OFFSET ?1), 0) \
                  ORDER BY id LIMIT ?2)",
                offset,
            )
            .await?;
        }
        if let Some(max_age) = retention.spend_max_age {
            let cutoff = now_millis().saturating_sub(max_age.as_millis() as i64);
            stats.spend_rows = delete_batches(
                pool,
                "DELETE FROM budget_spend WHERE budget_key IN \
                 (SELECT budget_key FROM budget_spend WHERE updated_at < ?1 LIMIT ?2)",
                cutoff,
            )
            .await?;
        }
        Ok(stats)
    }

    pub fn spawn_pruner(&self, every: Duration) -> Option<tokio::task::JoinHandle<()>> {
        let r = self.retention;
        let limited =
            r.calls_max_age.is_some() || r.calls_max_rows.is_some() || r.spend_max_age.is_some();
        if !self.enabled() || every.is_zero() || !limited {
            return None;
        }
        let history = self.clone();
        Some(tokio::spawn(async move {
            let mut tick = tokio::time::interval(every);
            loop {
                tick.tick().await;
                match history.prune().await {
                    Ok(stats) if stats != PruneStats::default() => {
                        tracing::info!(?stats, "history retention pruned");
                    }
                    Ok(_) => {}
                    Err(err) => tracing::warn!(%err, "history retention prune failed"),
                }
            }
        }))
    }
}

async fn delete_batches(pool: &SqlitePool, sql: &str, arg: i64) -> Result<u64, HistoryError> {
    let mut total = 0;
    loop {
        let done = sqlx::query(sql)
            .bind(arg)
            .bind(PRUNE_BATCH)
            .execute(pool)
            .await?
            .rows_affected();
        total += done;
        if done < PRUNE_BATCH as u64 {
            return Ok(total);
        }
        tokio::time::sleep(PRUNE_PAUSE).await;
    }
}
