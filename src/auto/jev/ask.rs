use std::time::Instant;

use serde_json::Value;

use super::parse;
use super::questions;
use super::types::{Asked, ClassifyRequest};

pub async fn classify(request: ClassifyRequest<'_>) -> Asked {
    let started = Instant::now();
    let request_body = questions::payload(
        request.user_text,
        request.tool_names,
        request.current_tools,
    )
    .to_string();
    let sent = send(&request, request_body).await;
    finish(sent, started.elapsed().as_millis(), request.tool_names)
}

struct Sent {
    request_body: String,
    response_body: String,
    status: u16,
    failed: bool,
}

async fn send(request: &ClassifyRequest<'_>, request_body: String) -> Sent {
    let response = request
        .client
        .post(request.decisions_url)
        .bearer_auth(request.api_key)
        .header("content-type", "application/json")
        .body(request_body.clone())
        .send()
        .await;
    let Ok(response) = response else {
        return Sent {
            request_body,
            response_body: String::new(),
            status: 0,
            failed: true,
        };
    };
    let status = response.status().as_u16();
    let Ok(text) = response.text().await else {
        return Sent {
            request_body,
            response_body: String::new(),
            status,
            failed: true,
        };
    };
    Sent {
        request_body,
        response_body: text,
        status,
        failed: !(200..300).contains(&status),
    }
}

fn finish(sent: Sent, latency_ms: u128, tool_names: &[String]) -> Asked {
    if sent.failed {
        return unanswered(sent, latency_ms, "request_failed");
    }
    let Ok(value) = serde_json::from_str::<Value>(&sent.response_body) else {
        return unanswered(sent, latency_ms, "unparsed");
    };
    let parsed = parse::classified(&value, tool_names);
    let choice_rule = parsed.choice_rule;
    Asked {
        request_body: sent.request_body,
        response_body: sent.response_body,
        status: sent.status,
        latency_ms,
        parsed: Some(parsed),
        choice_rule,
    }
}

fn unanswered(sent: Sent, latency_ms: u128, choice_rule: &'static str) -> Asked {
    Asked {
        request_body: sent.request_body,
        response_body: sent.response_body,
        status: sent.status,
        latency_ms,
        parsed: None,
        choice_rule,
    }
}
