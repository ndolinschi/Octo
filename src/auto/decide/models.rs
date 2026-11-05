use reqwest::Client;
use serde_json::Value;

use crate::providers::openrouter::{fetch_models, OpenRouterModels, DEFAULT_MODELS_URL};

use super::Auto;

pub(super) async fn load(auto: &Auto, client: &Client, api_key: &str) -> Option<OpenRouterModels> {
    if let Some(models) = auto.catalog.lock().await.fresh() {
        return Some(models);
    }
    if api_key.is_empty() {
        return None;
    }
    let models = fetch_models(client, DEFAULT_MODELS_URL, Some(api_key))
        .await
        .ok()?;
    auto.catalog.lock().await.store(models.clone());
    Some(models)
}

pub(super) fn counted_bytes(body: &Value) -> usize {
    let system = body.get("system").map(Value::to_string).unwrap_or_default();
    let messages = body
        .get("messages")
        .map(Value::to_string)
        .unwrap_or_default();
    let tools = body.get("tools").map(Value::to_string).unwrap_or_default();
    system.len() + messages.len() + tools.len()
}
