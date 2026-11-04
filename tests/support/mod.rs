#![allow(dead_code)]

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use axum::{extract::Request, http::StatusCode, routing::post, Router};
use octo::config::Config;
use tokio::net::TcpListener;
use tokio::sync::oneshot;

pub fn sample_config(max_body_bytes: usize) -> Config {
    Config {
        bind_addr: "127.0.0.1:8080".to_string(),
        allow_remote: false,
        upstream_connect_timeout_secs: 30,
        upstream_request_timeout_secs: 600,
        openai_chat_completions_url: "https://api.openai.com/v1/chat/completions".to_string(),
        openrouter_chat_completions_url: "https://openrouter.example/chat".to_string(),
        openrouter_chat_completions_path: "/v1/chat/completions".to_string(),
        openrouter_decisions_url: "https://example.com/decisions".to_string(),
        openrouter_decisions_path: "/v1/decisions".to_string(),
        openrouter_http_referer: None,
        openrouter_title: None,
        openrouter_messages_url: "https://openrouter.example/messages".to_string(),
        openrouter_messages_path: "/v1/messages".to_string(),
        anthropic_messages_url: "https://example.com/messages".to_string(),
        anthropic_api_version: "2023-06-01".to_string(),
        anthropic_messages_path: "/v1/messages".to_string(),
        max_body_bytes,
        llm_chat_backend: "openai".to_string(),
        llm_messages_backend: "claude".to_string(),
        decision_backend: "openrouter".to_string(),
        history_database_path: "sqlite::memory:".to_string(),
        history_token_key: "test-token-key".to_string(),
    }
}

pub async fn spawn_uri_capture_server(route: &str) -> (SocketAddr, Arc<Mutex<Option<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let captured = Arc::new(Mutex::new(None::<String>));
    let captured_task = captured.clone();
    let route = route.to_string();
    let (ready_tx, ready_rx) = oneshot::channel();
    tokio::spawn(async move {
        let _ = ready_tx.send(());
        let app = Router::new().route(
            route.as_str(),
            post(
                move |axum::extract::OriginalUri(uri): axum::extract::OriginalUri| {
                    let captured_task = captured_task.clone();
                    async move {
                        *captured_task.lock().unwrap() = Some(uri.to_string());
                        (axum::http::StatusCode::OK, "ok")
                    }
                },
            ),
        );
        axum::serve(listener, app).await.unwrap();
    });
    ready_rx.await.unwrap();
    (addr, captured)
}

pub async fn spawn_header_capture_server(
    route: &str,
    header_name: &str,
) -> (SocketAddr, Arc<Mutex<Option<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let captured = Arc::new(Mutex::new(None::<String>));
    let captured_task = captured.clone();
    let route = route.to_string();
    let header_name = header_name.to_string();
    let (ready_tx, ready_rx) = oneshot::channel();
    tokio::spawn(async move {
        let _ = ready_tx.send(());
        let app = Router::new().route(
            route.as_str(),
            post(move |request: Request<axum::body::Body>| {
                let captured_task = captured_task.clone();
                let header_name = header_name.clone();
                async move {
                    let value = request
                        .headers()
                        .get(header_name.as_str())
                        .and_then(|v| v.to_str().ok())
                        .map(str::to_string);
                    *captured_task.lock().unwrap() = value;
                    StatusCode::OK
                }
            }),
        );
        axum::serve(listener, app).await.unwrap();
    });
    ready_rx.await.unwrap();
    (addr, captured)
}
