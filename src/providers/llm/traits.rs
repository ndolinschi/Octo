use axum::{
    body::Body,
    http::{Request, Response},
};
use reqwest::Client;
use std::future::Future;

use crate::proxy::error::ProxyError;

pub trait ChatCompletions: Clone + Send + Sync {
    fn upstream_url(&self) -> &str;

    fn forward_chat_completions(
        &self,
        client: &Client,
        request: Request<Body>,
    ) -> impl Future<Output = Result<Response<Body>, ProxyError>> + Send;
}

pub trait Messages: Clone + Send + Sync {
    fn upstream_url(&self) -> &str;

    fn forward_messages(
        &self,
        client: &Client,
        request: Request<Body>,
    ) -> impl Future<Output = Result<Response<Body>, ProxyError>> + Send;
}
