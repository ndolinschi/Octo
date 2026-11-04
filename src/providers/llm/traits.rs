use axum::{
    body::Body,
    http::{Request, Response},
};
use reqwest::Client;
use std::future::Future;

use crate::history::CallObserve;
use crate::proxy::error::ProxyError;

pub trait ChatCompletions: Clone + Send + Sync {
    fn upstream_url(&self) -> &str;
}

pub trait Messages: Clone + Send + Sync {
    fn upstream_url(&self) -> &str;

    fn forward_messages(
        &self,
        client: &Client,
        request: Request<Body>,
        observe: Option<CallObserve>,
    ) -> impl Future<Output = Result<Response<Body>, ProxyError>> + Send;
}
