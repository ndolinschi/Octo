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
}

impl ProxyError {
    pub(crate) fn from_read_body(err: axum::Error) -> Self {
        if is_length_limit(&err) {
            Self::BodyTooLarge
        } else {
            Self::ReadBody(err)
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
        let (status, error) = match &self {
            ProxyError::ReadBody(_) => (StatusCode::BAD_REQUEST, "failed to read request body"),
            ProxyError::BodyTooLarge => (StatusCode::PAYLOAD_TOO_LARGE, "request body too large"),
            ProxyError::Upstream(_) => (StatusCode::BAD_GATEWAY, "upstream request failed"),
            ProxyError::BuildResponse => (StatusCode::BAD_GATEWAY, "failed to build response"),
            ProxyError::InvalidProviderSelector { .. } => {
                (StatusCode::BAD_REQUEST, "invalid provider selector")
            }
            ProxyError::InvalidChatBody => (StatusCode::BAD_REQUEST, "invalid chat request body"),
        };
        let body = format!(r#"{{"error":"{error}"}}"#);
        (status, [(header::CONTENT_TYPE, "application/json")], body).into_response()
    }
}

#[cfg(test)]
mod tests {
    use axum::body::{to_bytes, Body};

    use super::{is_length_limit, ProxyError};

    #[tokio::test]
    async fn length_limit_maps_to_body_too_large() {
        let body = Body::from(vec![0_u8; 64]);
        let err = to_bytes(body, 8).await.unwrap_err();
        assert!(is_length_limit(&err));
        assert!(matches!(
            ProxyError::from_read_body(err),
            ProxyError::BodyTooLarge
        ));
    }
}
