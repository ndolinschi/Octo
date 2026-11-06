mod action;
mod body;
mod catalog;
mod decide;
mod jev;
mod metrics;
mod routing;
mod session;
mod stall;
mod text_tool_call;

pub use action::{Compact, Forward, ModelAction, Turn};
pub use body::{
    cap_decision_text, compaction_body, filter_tools, is_housekeeping, last_user_text,
    last_user_tool_results_only, question_text, session_id, session_key, shape, trim_housekeeping,
    with_model, HousekeepingTrim, ShapePlan,
};
pub use catalog::Tiers;
pub use catalog::{
    band_rank, bump_band, complexity_band, context_length, larger_fit, max_completion_tokens,
    supports_reasoning, LargerFit,
};
pub use decide::sticky::{apply as apply_sticky, cap_for_budget, StickyOutcome, StickyPlan};
pub use decide::{decide, Auto, DecideRequest};
pub use jev::{
    choice, choice_from_scores, classified, inspect, needed_tools, payload, Complexity,
    ContextFacts, PayloadPlan, Thresholds, ToolNeed,
};
pub use metrics::{context_estimate, dropped, needs_compact, output_reserve};
pub use routing::RouteMeta;
pub use session::SessionChoice;
pub use stall::{detect as detect_stall, StallTrigger};
pub use text_tool_call::{looks_like_text_tool_call, response_has_text_tool_call};
