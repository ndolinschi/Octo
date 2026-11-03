use reqwest::Client;

#[derive(Clone)]
pub struct AppState {
    pub client: Client,
}

impl AppState {
    pub fn new() -> Result<Self, reqwest::Error> {
        Ok(Self {
            client: Client::builder().build()?,
        })
    }
}
