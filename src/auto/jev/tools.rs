use super::types::ToolNeed;

pub fn needed(need: ToolNeed<'_>) -> Vec<String> {
    let _ = (need.current, need.enough, need.missing);
    need.all.to_vec()
}
