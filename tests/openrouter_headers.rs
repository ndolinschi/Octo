use axum::http::{header, request::Parts, HeaderMap, HeaderValue, Request};
use octo::providers::openrouter::resolve_outbound_header;

fn parts_with(headers: HeaderMap) -> Parts {
    let mut request = Request::builder().body(()).unwrap();
    *request.headers_mut() = headers;
    request.into_parts().0
}

#[test]
fn referer_client_overrides_config_default() {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::REFERER,
        HeaderValue::from_static("https://client.example"),
    );
    let parts = parts_with(headers);
    let header = resolve_outbound_header(&parts, "referer", Some("https://default.example"))
        .unwrap();
    let value = header.to_str().unwrap();
    assert_eq!(value, "https://client.example");
}

#[test]
fn referer_uses_config_default_when_client_absent() {
    let parts = parts_with(HeaderMap::new());
    let header = resolve_outbound_header(&parts, "referer", Some("https://default.example"))
        .unwrap();
    let value = header.to_str().unwrap();
    assert_eq!(value, "https://default.example");
}

#[test]
fn openrouter_title_client_overrides_default() {
    let mut headers = HeaderMap::new();
    headers.insert(
        "x-openrouter-title",
        HeaderValue::from_static("Client Title"),
    );
    let parts = parts_with(headers);
    let value = resolve_outbound_header(&parts, "x-openrouter-title", Some("Octo")).unwrap();
    assert_eq!(value.to_str().unwrap(), "Client Title");
}

#[test]
fn x_title_only_from_client() {
    let parts = parts_with(HeaderMap::new());
    assert!(resolve_outbound_header(&parts, "x-title", None).is_none());
}
