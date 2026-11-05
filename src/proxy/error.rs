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
            Self::Upstream(_) => Self::anthropic(
                StatusCode::BAD_GATEWAY,
                "api_error",
                "upstream request failed",
            ),
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
                    ProxyError::Upstream(_) => (StatusCode::BAD_GATEWAY, "upstream request failed"),
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
