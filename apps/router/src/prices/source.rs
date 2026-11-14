use std::time::Duration;

use futures_util::future::BoxFuture;
use reqwest::header::{ACCEPT, ETAG, IF_NONE_MATCH};
use reqwest::{Client, StatusCode};

/// The public OpenRouter models API (no key needed).
pub const CATALOGUE_URL: &str = "https://openrouter.ai/api/v1/models";
/// Generic client name: no user, host or project detail goes to OpenRouter.
pub const USER_AGENT: &str = concat!("octo-router/", env!("CARGO_PKG_VERSION"));
pub const FETCH_TIMEOUT: Duration = Duration::from_secs(30);
/// The response was about 0.85 MB with ~470 models on 2026-11-14.
pub const MAX_CATALOGUE_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Fetched {
    Body {
        bytes: Vec<u8>,
        etag: Option<String>,
    },
    /// `304 Not Modified` to an `If-None-Match`.
    NotModified,
}

#[derive(Debug, thiserror::Error)]
pub enum FetchError {
    #[error("catalogue request failed: {0}")]
    Http(String),
    #[error("catalogue answered HTTP {0}")]
    Status(u16),
    #[error("catalogue response is larger than {0} bytes")]
    TooLarge(usize),
    #[error("{0}")]
    Other(String),
}

/// Where catalogue bytes come from. The router uses [`HttpCatalogue`]; tests inject a fake.
pub trait CatalogueSource: Send + Sync + 'static {
    /// One fetch; `etag` is the last response's `ETag`, sent as `If-None-Match`.
    fn fetch<'a>(&'a self, etag: Option<&'a str>) -> BoxFuture<'a, Result<Fetched, FetchError>>;
}

/// `GET` the catalogue with no credentials, cookies or attribution headers, a generic user agent, a timeout and a size cap.
pub struct HttpCatalogue {
    client: Client,
    url: String,
    max_bytes: usize,
}

impl HttpCatalogue {
    pub fn new(url: impl Into<String>) -> Result<Self, FetchError> {
        let client = Client::builder()
            .user_agent(USER_AGENT)
            .connect_timeout(Duration::from_secs(10))
            .timeout(FETCH_TIMEOUT)
            .build()
            .map_err(|err| FetchError::Other(err.to_string()))?;
        Ok(Self {
            client,
            url: url.into(),
            max_bytes: MAX_CATALOGUE_BYTES,
        })
    }
}

impl CatalogueSource for HttpCatalogue {
    fn fetch<'a>(&'a self, etag: Option<&'a str>) -> BoxFuture<'a, Result<Fetched, FetchError>> {
        Box::pin(async move {
            let mut request = self
                .client
                .get(&self.url)
                .header(ACCEPT, "application/json");
            if let Some(tag) = etag {
                request = request.header(IF_NONE_MATCH, tag);
            }
            let mut response = request
                .send()
                .await
                .map_err(|err| FetchError::Http(err.without_url().to_string()))?;
            if response.status() == StatusCode::NOT_MODIFIED {
                return Ok(Fetched::NotModified);
            }
            if !response.status().is_success() {
                return Err(FetchError::Status(response.status().as_u16()));
            }
            if response
                .content_length()
                .is_some_and(|len| len > self.max_bytes as u64)
            {
                return Err(FetchError::TooLarge(self.max_bytes));
            }
            let etag = response
                .headers()
                .get(ETAG)
                .and_then(|value| value.to_str().ok())
                .map(str::to_string);
            let mut bytes = Vec::new();
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|err| FetchError::Http(err.without_url().to_string()))?
            {
                if bytes.len() + chunk.len() > self.max_bytes {
                    return Err(FetchError::TooLarge(self.max_bytes));
                }
                bytes.extend_from_slice(&chunk);
            }
            Ok(Fetched::Body { bytes, etag })
        })
    }
}
