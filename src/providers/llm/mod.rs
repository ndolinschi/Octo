mod claude;

pub use claude::is_subagent;
mod openai;
mod openrouter;
mod wire;

pub use wire::Wired as Providers;
