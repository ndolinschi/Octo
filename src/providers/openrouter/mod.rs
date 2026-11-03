mod attribution;
mod forward;

pub use attribution::{apply_attribution, resolve_outbound_header, AttributionDefaults};
pub use forward::authorized_attributed_post;
