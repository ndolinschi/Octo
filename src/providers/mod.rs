mod openai;

pub use openai::OpenAi;

pub trait OpenAICompatible: Send + Sync + Clone {
    fn chat_completions_url(&self) -> &'static str;
    fn max_body_bytes(&self) -> usize;
}
