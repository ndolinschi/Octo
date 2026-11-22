use reqwest::Client;
use serde_json::Value;

use crate::providers::openrouter::{fetch_models, OpenRouterModels, DEFAULT_MODELS_URL};

use super::Auto;

fn is_openrouter_url(url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };
    parsed.host_str().is_some_and(|host| {
        host.eq_ignore_ascii_case("openrouter.ai")
            || host.to_ascii_lowercase().ends_with(".openrouter.ai")
    })
}

pub(super) async fn load(
    auto: &Auto,
    client: &Client,
    decisions_url: &str,
) -> Option<OpenRouterModels> {
    if let Some(models) = auto.catalog.lock().await.fresh() {
        return Some(models);
    }
    if !is_openrouter_url(decisions_url) {
        return None;
    }
    let models = fetch_models(client, DEFAULT_MODELS_URL, None).await.ok()?;
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
