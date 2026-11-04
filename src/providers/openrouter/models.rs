use reqwest::Client;
use serde::Deserialize;

pub const DEFAULT_MODELS_URL: &str = "https://openrouter.ai/api/v1/models";

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct OpenRouterModel {
    pub id: String,
    pub name: String,
    pub is_free: bool,
    pub context_length: Option<u64>,
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
    let mut request = client.get(models_url);
    if let Some(key) = api_key {
        if !key.is_empty() {
            request = request.bearer_auth(key);
        }
    }
    let body = request.send().await?.error_for_status()?.text().await?;
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
