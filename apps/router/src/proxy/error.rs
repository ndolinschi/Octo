use axum::{
    http::{header, StatusCode},
    response::{IntoResponse, Response},
};
use http_body_util::LengthLimitError;
use std::error::Error;

#[derive(Debug, thiserror::Error)]
pub enum ProxyError {
    #[error("failed to read request body")]
    ReadBody(#[source] axum::Error),
    #[error("request body too large")]
    BodyTooLarge,
    #[error("upstream request failed")]
    Upstream(#[from] reqwest::Error),
    #[error("invalid provider selector in {field}: {token}")]
    InvalidProviderSelector { field: &'static str, token: String },
    #[error("invalid chat request body")]
    InvalidChatBody,
    #[error("failed to build response")]
    BuildResponse,
    #[error("{message}")]
    Anthropic {
        status: StatusCode,
        kind: &'static str,
        message: String,
    },
}

impl ProxyError {
    pub(crate) fn from_read_body(err: axum::Error) -> Self {
        if is_length_limit(&err) {
            Self::BodyTooLarge
        } else {
            Self::ReadBody(err)
        }
    }

    pub fn anthropic(status: StatusCode, kind: &'static str, message: impl Into<String>) -> Self {
        Self::Anthropic {
            status,
            kind,
            message: message.into(),
        }
    }

    pub fn as_anthropic_messages(self) -> Self {
        match self {
            Self::ReadBody(_) => Self::anthropic(
                StatusCode::BAD_REQUEST,
                "invalid_request_error",
                "failed to read request body",
            ),
            Self::BodyTooLarge => Self::anthropic(
                StatusCode::PAYLOAD_TOO_LARGE,
                "invalid_request_error",
                "request body too large",
            ),
            Self::Upstream(err) => {
                Self::anthropic(StatusCode::BAD_GATEWAY, "api_error", upstream_message(&err))
            }
            Self::BuildResponse => Self::anthropic(
                StatusCode::BAD_GATEWAY,
                "api_error",
                "failed to build response",
            ),
            Self::InvalidProviderSelector { .. } => Self::anthropic(
                StatusCode::BAD_REQUEST,
                "invalid_request_error",
                "invalid provider selector",
            ),
            Self::InvalidChatBody => Self::anthropic(
                StatusCode::BAD_REQUEST,
                "invalid_request_error",
                "invalid chat request body",
            ),
            other @ Self::Anthropic { .. } => other,
        }
    }
}

/// A readable sentence for a failed upstream call: what happened and what to do, naming the provider's host (never
/// its credentials or query).
pub(crate) fn upstream_message(err: &reqwest::Error) -> String {
    let host = err
        .url()
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_else(|| "the upstream provider".to_string());
    if err.is_timeout() {
        format!("upstream request failed: {host} did not answer in time (after the router's retries); try again later, or raise upstream.request_timeout_secs")
    } else if err.is_connect() {
        format!("upstream request failed: could not connect to {host}; check that the provider is reachable and its base URL is right")
    } else {
        format!("upstream request failed: the connection to {host} broke; try again")
    }
}

fn is_length_limit(err: &(dyn Error + 'static)) -> bool {
    let mut current = Some(err);
    while let Some(source) = current {
        if source.downcast_ref::<LengthLimitError>().is_some() {
            return true;
        }
        current = source.source();
    }
    false
}

impl IntoResponse for ProxyError {
    fn into_response(self) -> Response {
        match self {
            ProxyError::Anthropic {
                status,
                kind,
                message,
            } => {
                let body = format!(
                    r#"{{"type":"error","error":{{"type":"{kind}","message":{message}}}}}"#,
                    message = serde_json::to_string(&message)
                        .unwrap_or_else(|_| { "\"upstream request failed\"".to_string() })
                );
                (status, [(header::CONTENT_TYPE, "application/json")], body).into_response()
            }
            other => {
                let (status, error) = match &other {
                    ProxyError::ReadBody(_) => {
                        (StatusCode::BAD_REQUEST, "failed to read request body")
                    }
                    ProxyError::BodyTooLarge => {
                        (StatusCode::PAYLOAD_TOO_LARGE, "request body too large")
                    }
                    ProxyError::Upstream(err) => {
                        let body =
                            serde_json::json!({ "error": upstream_message(err) }).to_string();
                        return (
                            StatusCode::BAD_GATEWAY,
                            [(header::CONTENT_TYPE, "application/json")],
                            body,
                        )
                            .into_response();
                    }
                    ProxyError::BuildResponse => {
                        (StatusCode::BAD_GATEWAY, "failed to build response")
                    }
                    ProxyError::InvalidProviderSelector { .. } => {
                        (StatusCode::BAD_REQUEST, "invalid provider selector")
                    }
                    ProxyError::InvalidChatBody => {
                        (StatusCode::BAD_REQUEST, "invalid chat request body")
                    }
                    ProxyError::Anthropic { .. } => unreachable!(),
                };
                let body = format!(r#"{{"error":"{error}"}}"#);
                (status, [(header::CONTENT_TYPE, "application/json")], body).into_response()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::upstream_message;

    #[tokio::test]
    async fn upstream_failure_says_what_happened() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);
        let err = reqwest::get(format!("http://{addr}/v1/messages"))
            .await
            .unwrap_err();
        let msg = upstream_message(&err);
        assert!(msg.contains("could not connect to 127.0.0.1"), "{msg}");

        let silent = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/v1/messages", silent.local_addr().unwrap());
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_millis(200))
            .build()
            .unwrap();
        let err = client.get(url).send().await.unwrap_err();
        assert!(upstream_message(&err).contains("did not answer in time"));
    }
}
