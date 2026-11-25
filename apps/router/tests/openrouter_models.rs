use octo::providers::openrouter::models_from_json;

#[test]
fn models_from_json_splits_free_and_paid() {
    let body = r#"{
        "data": [
            {
                "id": "vendor/paid-model",
                "name": "Paid",
                "context_length": 8192,
                "pricing": { "prompt": "0.000001", "completion": "0.000002" }
            },
            {
                "id": "vendor/free-model:free",
                "name": "Free tagged",
                "context_length": 4096,
                "pricing": { "prompt": "0", "completion": "0" }
            },
            {
                "id": "vendor/zero-priced",
                "name": "Zero priced",
                "context_length": null,
                "pricing": { "prompt": "0.0", "completion": "0" }
            }
        ]
    }"#;
    let catalog = models_from_json(body).unwrap();
    assert_eq!(catalog.free.len(), 2);
    assert_eq!(catalog.paid.len(), 1);
    assert_eq!(catalog.paid[0].id, "vendor/paid-model");
    assert_eq!(catalog.paid[0].max_completion_tokens, None);
    assert!(catalog.paid[0].supported_parameters.is_empty());
    assert!(catalog
        .free
        .iter()
        .any(|m| m.id == "vendor/free-model:free"));
    assert!(catalog.free.iter().any(|m| m.id == "vendor/zero-priced"));
}

#[test]
fn models_from_json_reads_top_provider_and_supported_parameters() {
    let body = r#"{
        "data": [
            {
                "id": "vendor/reasoner",
                "name": "Reasoner",
                "context_length": 128000,
                "pricing": { "prompt": "0.000001", "completion": "0.000002" },
                "supported_parameters": ["reasoning", "max_tokens"],
                "top_provider": { "max_completion_tokens": 8192, "is_moderated": true }
            }
        ]
    }"#;
    let catalog = models_from_json(body).unwrap();
    assert_eq!(catalog.paid[0].max_completion_tokens, Some(8192));
    assert!(catalog.paid[0]
        .supported_parameters
        .iter()
        .any(|param| param == "reasoning"));
}

#[test]
fn models_from_json_rejects_invalid_payload() {
    assert!(models_from_json("not json").is_err());
    assert!(models_from_json(r#"{"data":[]}"#).unwrap().is_empty());
}
