use axum::{
    body::Body,
    http::{header, Request, StatusCode},
};
use octo::config::Config;
use octo::routes;
use octo::state::AppState;
use tower::ServiceExt;

fn sample_config(max_body_bytes: usize) -> Config {
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
        anthropic_messages_url: "https://example.com/messages".to_string(),
        anthropic_api_version: "2023-06-01".to_string(),
        anthropic_messages_path: "/v1/messages".to_string(),
        max_body_bytes,
        llm_chat_backend: "openai".to_string(),
        llm_messages_backend: "claude".to_string(),
        decision_backend: "openrouter".to_string(),
    }
}

#[tokio::test]
async fn chat_route_body_type_openrouter_selects_openrouter_upstream() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .unwrap();
    let addr = listener.local_addr().unwrap();
    let captured = std::sync::Arc::new(std::sync::Mutex::new(None::<String>));
    let captured_task = captured.clone();
    let app = axum::Router::new().route(
        "/upstream",
        axum::routing::post(
            move |axum::extract::OriginalUri(uri): axum::extract::OriginalUri| {
                let captured_task = captured_task.clone();
                async move {
                    *captured_task.lock().unwrap() = Some(uri.to_string());
                    (StatusCode::OK, "ok")
                }
            },
        ),
    );
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    tokio::time::sleep(std::time::Duration::from_millis(30)).await;

    let mut config = sample_config(4096);
    config.openai_chat_completions_url = format!("http://{addr}/openai-upstream");
    config.openrouter_chat_completions_url = format!("http://{addr}/upstream");
    let state = AppState::new(config).unwrap();
    let app = routes::router(state);
    let request = Request::builder()
        .method("POST")
        .uri("/v1/chat/completions")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            r#"{"type":"OPENROUTER","model":"x","messages":[]}"#,
        ))
        .unwrap();

    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        captured.lock().unwrap().as_deref(),
        Some("/upstream")
    );
}

#[tokio::test]
async fn chat_path_alias_openrouter_without_body_type() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .unwrap();
    let addr = listener.local_addr().unwrap();
    let captured = std::sync::Arc::new(std::sync::Mutex::new(None::<String>));
    let captured_task = captured.clone();
    let app = axum::Router::new().route(
        "/upstream",
        axum::routing::post(
            move |axum::extract::OriginalUri(uri): axum::extract::OriginalUri| {
                let captured_task = captured_task.clone();
                async move {
                    *captured_task.lock().unwrap() = Some(uri.to_string());
                    (StatusCode::OK, "ok")
                }
            },
        ),
    );
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    tokio::time::sleep(std::time::Duration::from_millis(30)).await;

    let mut config = sample_config(4096);
    config.openai_chat_completions_url = format!("http://{addr}/openai-upstream");
    config.openrouter_chat_completions_url = format!("http://{addr}/upstream");
    let state = AppState::new(config).unwrap();
    let app = routes::router(state);
    let request = Request::builder()
        .method("POST")
        .uri("/openrouter/completions")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(r#"{"model":"x","messages":[]}"#))
        .unwrap();

    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        captured.lock().unwrap().as_deref(),
        Some("/upstream")
    );
}

#[test]
fn unknown_llm_chat_backend_rejected_at_startup() {
    let mut config = sample_config(1024);
    config.llm_chat_backend = "direct-openai".to_string();
    assert!(AppState::new(config).is_err());
}
