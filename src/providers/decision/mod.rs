mod openrouter;

pub use openrouter::OpenRouter;

#[derive(Clone)]
pub struct Providers {
    pub openrouter: OpenRouter,
}

impl Providers {
    pub fn new(
        decisions_url: String,
        http_referer: Option<String>,
        openrouter_title: Option<String>,
        max_body_bytes: usize,
    ) -> Self {
        Self {
            openrouter: OpenRouter::new(
                decisions_url,
                http_referer,
                openrouter_title,
                max_body_bytes,
            ),
        }
    }
}
