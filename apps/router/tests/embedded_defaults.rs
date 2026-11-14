mod support;

use std::path::{Path, PathBuf};

use octo::auto::RequestShape;
use octo::config::Config;
use octo::state::AppState;

/// The three files the desktop shell writes (`apps/desktop/src-tauri/sidecar/src/router.rs`), byte for byte in shape.
fn shell_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "octo-embedded-{tag}-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("server.toml"),
        "[server]\nbind_addr = \"127.0.0.1:48123\"\nallow_remote = false\nclient_auth_key = \"test-key\"\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("limits.toml"),
        "[limits]\nmax_body_bytes = 67108864\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("history.toml"),
        format!(
            "[history]\ndatabase_path = \"{}\"\n",
            dir.join("history.sqlite").display()
        ),
    )
    .unwrap();
    dir
}

fn shape() -> RequestShape {
    RequestShape::default()
}

#[test]
fn shell_written_directory_gets_prices_ladder_and_provider_settings() {
    let dir = shell_dir("shell");
    let (config, embedded) = Config::load_directory_with_report(&dir).unwrap();
    assert_eq!(
        embedded,
        ["openrouter.toml", "autoroute.toml", "prices.toml"]
    );
    let shipped = Config::load_from_directory(Path::new("config")).unwrap();
    assert_eq!(config.autoroute_low_model, shipped.autoroute_low_model);
    assert_eq!(config.autoroute_mid_model, shipped.autoroute_mid_model);
    assert_eq!(config.autoroute_high_model, shipped.autoroute_high_model);
    assert_eq!(
        config.autoroute_provider_order,
        shipped.autoroute_provider_order
    );
    assert_eq!(
        config.openrouter_messages_url,
        shipped.openrouter_messages_url
    );
    assert_eq!(
        config.openrouter_http_referer,
        shipped.openrouter_http_referer
    );
    assert_eq!(
        config.max_body_bytes, 67_108_864,
        "the shell's files still win"
    );
    assert_eq!(config.client_auth_key, "test-key");
    for slug in [
        &config.autoroute_low_model,
        &config.autoroute_mid_model,
        &config.autoroute_high_model,
    ] {
        let price = config.prices.get(slug).unwrap_or_else(|| panic!("{slug}"));
        assert!(price.rates_complete, "{slug}");
    }
    let low = config.prices.get(&config.autoroute_low_model).unwrap();
    assert_eq!(low.cache_read, 0.001014);
}

#[test]
fn price_rule_swaps_with_the_embedded_files_as_with_the_full_dev_config() {
    let dir = shell_dir("rule");
    let embedded = AppState::new(Config::load_from_directory(&dir).unwrap()).unwrap();
    let full = AppState::new(Config::load_from_directory(Path::new("config")).unwrap()).unwrap();
    for band in ["low", "mid", "high"] {
        assert_eq!(
            embedded.auto.tiers().price_swap(band, None, shape()),
            full.auto.tiers().price_swap(band, None, shape()),
            "{band}"
        );
        assert_eq!(
            embedded.auto.tiers().blended_cost_micros(band, shape()),
            full.auto.tiers().blended_cost_micros(band, shape()),
            "{band}"
        );
    }
    assert_eq!(
        embedded.auto.tiers().price_swap("low", None, shape()),
        Some("high")
    );
    assert!(embedded.auto.tiers().never_pay_more_for_less);
    assert_eq!(
        octo::auto::ladder_warnings(embedded.auto.tiers())
            .iter()
            .filter(|w| w.contains("no usable price entry"))
            .count(),
        0
    );
}

#[test]
fn a_prices_file_on_disk_replaces_the_embedded_one() {
    let dir = shell_dir("override");
    let base = Config::load_from_directory(&dir).unwrap();
    std::fs::write(
        dir.join("prices.toml"),
        format!(
            "[prices.\"{}\"]\ninput = 9.0\ncache_read = 0.9\ncache_write = 0.0\noutput = 9.0\n",
            base.autoroute_low_model
        ),
    )
    .unwrap();
    let (config, embedded) = Config::load_directory_with_report(&dir).unwrap();
    assert_eq!(embedded, ["openrouter.toml", "autoroute.toml"]);
    let low = config.prices.get(&config.autoroute_low_model).unwrap();
    assert_eq!((low.input, low.output, low.cache_read), (9.0, 9.0, 0.9));
    assert!(
        config.prices.get(&config.autoroute_mid_model).is_none(),
        "the disk file is not merged with the embedded one"
    );
}

#[test]
fn a_partial_autoroute_file_on_disk_wins_and_the_rest_stays_embedded() {
    let dir = shell_dir("partial");
    std::fs::write(
        dir.join("autoroute.toml"),
        "[autoroute]\nnever_pay_more_for_less = false\n",
    )
    .unwrap();
    let (config, embedded) = Config::load_directory_with_report(&dir).unwrap();
    assert_eq!(embedded, ["openrouter.toml", "prices.toml"]);
    assert!(!config.autoroute_never_pay_more_for_less);
}

#[test]
fn a_complete_directory_uses_no_embedded_defaults() {
    let (_, embedded) = Config::load_directory_with_report(Path::new("config")).unwrap();
    assert!(embedded.is_empty());
}

// ---- merge order: anything on disk wins key by key, whichever fragment it sits in ----

#[test]
fn a_key_in_an_earlier_on_disk_file_beats_the_embedded_fragment() {
    let dir = shell_dir("order-openrouter");
    std::fs::write(
        dir.join("upstream.toml"),
        "[openrouter]\nmessages_url = \"http://127.0.0.1:9/mine\"\n",
    )
    .unwrap();
    let config = Config::load_from_directory(&dir).unwrap();
    assert_eq!(config.openrouter_messages_url, "http://127.0.0.1:9/mine");
    // the rest of the embedded openrouter.toml still applies
    let shipped = Config::load_from_directory(Path::new("config")).unwrap();
    assert_eq!(
        config.openrouter_chat_completions_url,
        shipped.openrouter_chat_completions_url
    );

    let dir = shell_dir("order-autoroute");
    std::fs::write(
        dir.join("server.toml"),
        "[server]\nbind_addr = \"127.0.0.1:48123\"\n[autoroute]\nlow = \"my/low\"\n",
    )
    .unwrap();
    let config = Config::load_from_directory(&dir).unwrap();
    assert_eq!(config.autoroute_low_model, "my/low");
    assert_eq!(config.autoroute_mid_model, shipped.autoroute_mid_model);
}

#[test]
fn a_price_row_in_another_on_disk_file_beats_the_embedded_prices() {
    let dir = shell_dir("order-prices");
    let shipped = Config::load_from_directory(Path::new("config")).unwrap();
    let low = shipped.autoroute_low_model.clone();
    std::fs::write(
        dir.join("autoroute.toml"),
        format!(
            "[autoroute]\nnever_pay_more_for_less = true\n[prices.\"{low}\"]\ninput = 7.0\ncache_read = 0.7\ncache_write = 0.0\noutput = 8.0\n"
        ),
    )
    .unwrap();
    let (config, embedded) = Config::load_directory_with_report(&dir).unwrap();
    assert_eq!(embedded, ["openrouter.toml", "prices.toml"]);
    let row = config.prices.get(&low).unwrap();
    assert_eq!((row.input, row.output, row.cache_read), (7.0, 8.0, 0.7));
    assert!(
        config.prices.get(&shipped.autoroute_mid_model).is_some(),
        "the other embedded rows stay"
    );
}
