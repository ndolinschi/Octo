use super::AnthropicCompatible;

#[derive(Clone, Default)]
pub struct Anthropic;

impl AnthropicCompatible for Anthropic {
    fn messages_url(&self) -> &'static str {
        "https://api.anthropic.com/v1/messages"
    }

    fn max_body_bytes(&self) -> usize {
        10 * 1024 * 1024
    }

    fn api_version(&self) -> &'static str {
        "2023-06-01"
    }
}
