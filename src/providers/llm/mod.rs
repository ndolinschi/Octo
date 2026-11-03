mod anthropic;
mod openai;

pub use anthropic::Anthropic;
pub use openai::OpenAi;

#[derive(Clone)]
pub struct Providers {
    pub openai: OpenAi,
    pub anthropic: Anthropic,
}

impl Providers {
    pub fn new(
        chat_completions_url: String,
        messages_url: String,
        anthropic_api_version: String,
        http_referer: Option<String>,
        openrouter_title: Option<String>,
        max_body_bytes: usize,
    ) -> Self {
        Self {
            openai: OpenAi::new(
                chat_completions_url,
                http_referer,
                openrouter_title,
                max_body_bytes,
            ),
            anthropic: Anthropic::new(messages_url, anthropic_api_version, max_body_bytes),
        }
    }
}
