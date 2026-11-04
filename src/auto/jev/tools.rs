use super::types::ToolNeed;

pub fn needed(need: ToolNeed<'_>) -> Vec<String> {
    if need.current.is_empty() {
        return named_or_all(need.all, need.missing);
    }
    if need.enough {
        return need.current.to_vec();
    }
    if need.missing.is_empty() {
        return need.all.to_vec();
    }
    merge(need)
}

fn named_or_all(all: &[String], missing: &[String]) -> Vec<String> {
    let named = kept(all, missing);
    if named.is_empty() {
        all.to_vec()
    } else {
        named
    }
}

fn merge(need: ToolNeed<'_>) -> Vec<String> {
    let mut tools = need.current.to_vec();
    for name in kept(need.all, need.missing) {
        if !tools.iter().any(|tool| tool == &name) {
            tools.push(name);
        }
    }
    tools
}

fn kept(all: &[String], names: &[String]) -> Vec<String> {
    names
        .iter()
        .filter(|name| all.iter().any(|tool| tool == *name))
        .cloned()
        .collect()
}
