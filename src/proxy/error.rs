use axum::{
    http::{header, StatusCode},
    response::{IntoResponse, Response},
};

#[derive(Debug, thiserror::Error)]
pub enum ProxyError {
    #[error("failed to read request body")]
    ReadBody(#[source] axum::Error),
    #[error("request body too large")]
    BodyTooLarge,
    #[error("upstream request failed")]
    Upstream(#[from] reqwest::Error),
    #[error("failed to build response")]
    BuildResponse,
}

impl ProxyError {
    pub(crate) fn from_read_body(err: axum::Error) -> Self {
        if err.to_string().contains("length limit exceeded") {
            Self::BodyTooLarge
        } else {
            Self::ReadBody(err)
        }
    }
}

impl IntoResponse for ProxyError {
    fn into_response(self) -> Response {
        let (status, error) = match &self {
            ProxyError::ReadBody(_) => (StatusCode::BAD_REQUEST, "failed to read request body"),
            ProxyError::BodyTooLarge => (StatusCode::PAYLOAD_TOO_LARGE, "request body too large"),
            ProxyError::Upstream(_) => (StatusCode::BAD_GATEWAY, "upstream request failed"),
            ProxyError::BuildResponse => (StatusCode::BAD_GATEWAY, "failed to build response"),
        };
        let body = format!(r#"{{"error":"{error}"}}"#);
        (status, [(header::CONTENT_TYPE, "application/json")], body).into_response()
    }
}
