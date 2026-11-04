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
    assert!(catalog
        .free
        .iter()
        .any(|m| m.id == "vendor/free-model:free"));
    assert!(catalog.free.iter().any(|m| m.id == "vendor/zero-priced"));
}

#[test]
fn models_from_json_rejects_invalid_payload() {
    assert!(models_from_json("not json").is_err());
    assert!(models_from_json(r#"{"data":[]}"#).unwrap().is_empty());
}
