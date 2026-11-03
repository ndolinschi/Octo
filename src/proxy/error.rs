use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
};

#[derive(Debug, thiserror::Error)]
pub enum ProxyError {
    #[error("failed to read request body")]
    ReadBody(#[source] axum::Error),
    #[error("upstream request failed")]
    Upstream(#[from] reqwest::Error),
    #[error("failed to build response")]
    BuildResponse,
}

impl IntoResponse for ProxyError {
    fn into_response(self) -> Response {
        let (status, message) = match &self {
            ProxyError::ReadBody(_) => (StatusCode::BAD_REQUEST, self.to_string()),
            ProxyError::Upstream(_) | ProxyError::BuildResponse => {
                (StatusCode::BAD_GATEWAY, self.to_string())
            }
        };
        (status, message).into_response()
    }
}
