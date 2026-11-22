use std::time::Duration;

use reqwest::Client;
use serde::Deserialize;

use crate::providers::utils::{read_response_bytes_capped, ReadCappedError};

pub const DEFAULT_MODELS_URL: &str = "https://openrouter.ai/api/v1/models";
pub const MAX_MODELS_BYTES: usize = 16 * 1024 * 1024;
const MODELS_FETCH_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct OpenRouterModel {
    pub id: String,
    pub name: String,
    pub is_free: bool,
    pub context_length: Option<u64>,
    pub max_completion_tokens: Option<u64>,
    pub supported_parameters: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OpenRouterModels {
    pub free: Vec<OpenRouterModel>,
    pub paid: Vec<OpenRouterModel>,
}

impl OpenRouterModels {
    pub fn len(&self) -> usize {
        self.free.len() + self.paid.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[derive(Debug, thiserror::Error)]
pub enum FetchModelsError {
    #[error("failed to fetch OpenRouter models")]
    Http(#[from] reqwest::Error),
    #[error("OpenRouter models response exceeded {0} bytes")]
    TooLarge(usize),
    #[error("failed to parse OpenRouter models response")]
    Parse(#[from] serde_json::Error),
}

#[derive(Debug, Deserialize)]
struct ModelsApiResponse {
    data: Vec<ModelRecord>,
}

#[derive(Debug, Deserialize)]
struct ModelRecord {
    id: String,
    name: String,
    context_length: Option<u64>,
    pricing: ModelPricing,
    #[serde(default)]
    supported_parameters: Vec<String>,
    #[serde(default)]
    top_provider: Option<TopProvider>,
}

#[derive(Debug, Deserialize)]
struct TopProvider {
    max_completion_tokens: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct ModelPricing {
    prompt: String,
    completion: String,
}

pub async fn fetch_models(
    client: &Client,
    models_url: &str,
    api_key: Option<&str>,
) -> Result<OpenRouterModels, FetchModelsError> {
    fetch_models_with_limit(client, models_url, api_key, MAX_MODELS_BYTES).await
}

pub async fn fetch_models_with_limit(
    client: &Client,
    models_url: &str,
    api_key: Option<&str>,
    max_bytes: usize,
) -> Result<OpenRouterModels, FetchModelsError> {
    let mut request = client.get(models_url).timeout(MODELS_FETCH_TIMEOUT);
    if !models_url.eq_ignore_ascii_case(DEFAULT_MODELS_URL) {
        if let Some(key) = api_key {
            if !key.is_empty() {
                request = request.bearer_auth(key);
            }
        }
    }
    let response = request.send().await?.error_for_status()?;
    let bytes = read_response_bytes_capped(response, max_bytes)
        .await
        .map_err(|err| match err {
            ReadCappedError::Http(err) => FetchModelsError::Http(err),
            ReadCappedError::TooLarge(limit) => FetchModelsError::TooLarge(limit),
        })?;
    let body = String::from_utf8_lossy(&bytes);
    models_from_json(&body).map_err(FetchModelsError::Parse)
}

pub fn models_from_json(body: &str) -> Result<OpenRouterModels, serde_json::Error> {
    let response: ModelsApiResponse = serde_json::from_str(body)?;
    let mut free = Vec::new();
    let mut paid = Vec::new();
    for record in response.data {
        let model = OpenRouterModel {
            is_free: is_free_model(&record.id, &record.pricing),
            id: record.id,
            name: record.name,
            context_length: record.context_length,
            max_completion_tokens: record
                .top_provider
                .as_ref()
                .and_then(|provider| provider.max_completion_tokens),
            supported_parameters: record.supported_parameters,
        };
        if model.is_free {
            free.push(model);
        } else {
            paid.push(model);
        }
    }
    free.sort_by(|a, b| a.id.cmp(&b.id));
    paid.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(OpenRouterModels { free, paid })
}

fn is_free_model(id: &str, pricing: &ModelPricing) -> bool {
    if id.ends_with(":free") {
        return true;
    }
    is_zero_price(&pricing.prompt) && is_zero_price(&pricing.completion)
}

fn is_zero_price(raw: &str) -> bool {
    raw.parse::<f64>()
        .map(|n| n.is_finite() && n == 0.0)
        .unwrap_or(false)
}
