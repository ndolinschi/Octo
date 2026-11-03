use axum::{
    body::Body,
    http::{Request, Response},
};
use reqwest::Client;
use std::future::Future;

use crate::proxy::error::ProxyError;

pub trait DecisionsForward: Clone + Send + Sync + 'static {
    fn upstream_url(&self) -> &str;

    fn forward_decisions(
        &self,
        client: &Client,
        request: Request<Body>,
    ) -> impl Future<Output = Result<Response<Body>, ProxyError>> + Send;
}
