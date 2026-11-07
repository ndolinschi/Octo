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
    bg_signal, cap_decision_text, client_has_thinking, client_tool_names_csv, compaction_body,
    first_user_text, is_housekeeping, is_permission_check, is_subagent_key, last_user_text,
    last_user_tool_results_only, parent_session_id, preferred_model, question_text,
    server_tool_types, session_id, session_key, shape, subagent_task_hash, trim_housekeeping,
    with_model, with_online_suffix, HousekeepingTrim, ShapePlan, ShapeResult,
    PROTECTED_STRIP_FIELDS,
};
pub use catalog::{
    band_rank, bump_band, complexity_band, context_length, larger_fit, max_completion_tokens,
    supports_reasoning, LargerFit,
};
pub use catalog::{default_strip_fields, RequireParameters, Tiers};
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
