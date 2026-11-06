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
        autoroute_low_model: "google/gemma-4-26b-a4b-it".to_string(),
        autoroute_mid_model: "deepseek/deepseek-v4-flash".to_string(),
        autoroute_high_model: "~anthropic/claude-haiku-latest".to_string(),
        autoroute_hard_threshold: 0.5,
        autoroute_easy_threshold: 0.5,
        autoroute_stall_window: 6,
        autoroute_escalate_turns: 3,
        autoroute_down_confirm: 2,
        autoroute_high_allow: Vec::new(),
        autoroute_session_budget_usd: 0.0,
        autoroute_housekeeping_keep_messages: 6,
        autoroute_provider_order: Vec::new(),
        autoroute_allow_fallbacks: true,
        autoroute_background_model_patterns: vec!["haiku".to_string()],
        prices: octo::history::PriceTable::default(),
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

pub async fn spawn_status_sequence_server(
    route: &str,
    statuses: Vec<u16>,
) -> (SocketAddr, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let bodies = Arc::new(Mutex::new(Vec::<String>::new()));
    let bodies_task = bodies.clone();
    let statuses = Arc::new(Mutex::new(statuses));
    let route = route.to_string();
    let (ready_tx, ready_rx) = oneshot::channel();
    tokio::spawn(async move {
        let _ = ready_tx.send(());
        let app = Router::new().route(
            route.as_str(),
            post(move |request: Request<axum::body::Body>| {
                let bodies_task = bodies_task.clone();
                let statuses = statuses.clone();
                async move {
                    let bytes = axum::body::to_bytes(request.into_body(), usize::MAX)
                        .await
                        .unwrap_or_default();
                    bodies_task
                        .lock()
                        .unwrap()
                        .push(String::from_utf8_lossy(&bytes).into_owned());
                    let status = {
                        let mut rows = statuses.lock().unwrap();
                        if rows.is_empty() {
                            200
                        } else {
                            rows.remove(0)
                        }
                    };
                    (
                        StatusCode::from_u16(status).unwrap_or(StatusCode::OK),
                        [(axum::http::header::CONTENT_TYPE, "application/json")],
                        r#"{"type":"message","role":"assistant","content":[]}"#,
                    )
                }
            }),
        );
        axum::serve(listener, app).await.unwrap();
    });
    ready_rx.await.unwrap();
    (addr, bodies)
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
