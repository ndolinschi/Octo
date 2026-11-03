use super::OpenAICompatible;

#[derive(Clone, Default)]
pub struct OpenAi;

impl OpenAICompatible for OpenAi {
    fn chat_completions_url(&self) -> &'static str {
        "https://api.openai.com/v1/chat/completions"
    }

    fn max_body_bytes(&self) -> usize {
        10 * 1024 * 1024
    }
}
