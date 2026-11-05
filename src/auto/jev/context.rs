use serde_json::Value;

const ERROR_LIMIT: usize = 3;
const ERROR_CHARS: usize = 300;
const FILE_LIMIT: usize = 20;
const PATH_EXTENSIONS: &[&str] = &[
    ".rs", ".py", ".ts", ".tsx", ".js", ".jsx", ".go", ".toml", ".md", ".json", ".yaml", ".yml",
    ".txt", ".sql", ".sh", ".c", ".h", ".cpp", ".hpp", ".java", ".kt", ".rb", ".css", ".html",
    ".xml", ".lock", ".cfg", ".ini", ".mjs", ".cjs", ".swift", ".php", ".cs", ".scala",
];

pub struct ContextFacts {
    pub recent_errors: Vec<String>,
    pub turn_index: u64,
    pub files_touched: Vec<String>,
    pub mentions_tests: bool,
    pub mentions_stack_trace: bool,
    pub mentions_multiple_files: bool,
}

pub fn inspect(body: &Value, user_text: &str) -> ContextFacts {
    let messages = body
        .get("messages")
        .and_then(Value::as_array)
        .map(|rows| rows.as_slice())
        .unwrap_or(&[]);
    let recent_errors = recent_errors(messages);
    let turn_index = messages
        .iter()
        .filter(|message| message.get("role").and_then(Value::as_str) == Some("assistant"))
        .count() as u64;
    let files_touched = files_touched(messages);
    let mentions_tests = mentions_tests(user_text);
    let mentions_stack_trace = mentions_stack_trace(user_text);
    let mentions_multiple_files = mentions_multiple_files(user_text)
        || files_touched.len() >= 2
        || path_mentions(user_text) >= 2;
    ContextFacts {
        recent_errors,
        turn_index,
        files_touched,
        mentions_tests,
        mentions_stack_trace,
        mentions_multiple_files,
    }
}

fn recent_errors(messages: &[Value]) -> Vec<String> {
    let mut errors = Vec::new();
    for message in messages.iter().rev() {
        for part in content_parts(message) {
            if !is_error_result(part) {
                continue;
            }
            let snippet = clip(&result_text(part), ERROR_CHARS);
            if snippet.is_empty() {
                continue;
            }
            errors.push(snippet);
            if errors.len() == ERROR_LIMIT {
                return errors;
            }
        }
    }
    errors
}

fn files_touched(messages: &[Value]) -> Vec<String> {
    let mut files = Vec::new();
    for message in messages {
        for part in content_parts(message) {
            if part.get("type").and_then(Value::as_str) != Some("tool_use") {
                continue;
            }
            let Some(input) = part.get("input") else {
                continue;
            };
            push_paths(input, &mut files);
            if files.len() >= FILE_LIMIT {
                files.truncate(FILE_LIMIT);
                return files;
            }
        }
    }
    files
}

fn push_paths(input: &Value, files: &mut Vec<String>) {
    match input {
        Value::Object(map) => {
            for (key, value) in map {
                if path_key(key) {
                    if let Some(path) = value.as_str() {
                        push_unique(files, path);
                    }
                } else {
                    push_paths(value, files);
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                push_paths(item, files);
            }
        }
        Value::String(text) if looks_like_path(text) => push_unique(files, text),
        _ => {}
    }
}

fn path_key(key: &str) -> bool {
    matches!(
        key.to_ascii_lowercase().as_str(),
        "path"
            | "file"
            | "file_path"
            | "filepath"
            | "filename"
            | "target"
            | "target_file"
            | "target_path"
    )
}

fn looks_like_path(text: &str) -> bool {
    let text = text.trim();
    !text.is_empty()
        && text.len() < 512
        && (text.contains('/') || text.contains('\\') || has_known_extension(text))
}

fn has_known_extension(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    PATH_EXTENSIONS
        .iter()
        .any(|ext| lower.ends_with(ext) && lower.len() > ext.len())
}

fn push_unique(files: &mut Vec<String>, path: &str) {
    if files.iter().any(|existing| existing == path) {
        return;
    }
    if files.len() < FILE_LIMIT {
        files.push(path.to_string());
    }
}

fn content_parts(message: &Value) -> Vec<&Value> {
    match message.get("content") {
        Some(Value::Array(parts)) => parts.iter().collect(),
        Some(other) => vec![other],
        None => Vec::new(),
    }
}

fn is_error_result(part: &Value) -> bool {
    if part.get("type").and_then(Value::as_str) != Some("tool_result") {
        return false;
    }
    if part.get("is_error").and_then(Value::as_bool) == Some(true) {
        return true;
    }
    let text = result_text(part).to_ascii_lowercase();
    text.contains("error") || text.contains("traceback") || text.contains("exception")
}

fn result_text(part: &Value) -> String {
    match part.get("content") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => {
            let mut text = String::new();
            for item in parts {
                if let Some(piece) = item.get("text").and_then(Value::as_str) {
                    text.push_str(piece);
                } else if let Some(piece) = item.as_str() {
                    text.push_str(piece);
                }
            }
            text
        }
        _ => String::new(),
    }
}

fn mentions_tests(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    has_word(&lower, "test")
        || has_word(&lower, "tests")
        || has_word(&lower, "pytest")
        || has_word(&lower, "jest")
        || lower.contains("unit test")
}

fn has_word(haystack: &str, needle: &str) -> bool {
    let bytes = haystack.as_bytes();
    let mut start = 0;
    while let Some(rel) = haystack[start..].find(needle) {
        let abs = start + rel;
        let before_ok = abs == 0 || !bytes[abs - 1].is_ascii_alphanumeric();
        let after = abs + needle.len();
        let after_ok = after >= bytes.len() || !bytes[after].is_ascii_alphanumeric();
        if before_ok && after_ok {
            return true;
        }
        start = abs + 1;
    }
    false
}

fn mentions_stack_trace(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("stack trace")
        || lower.contains("stacktrace")
        || lower.contains("traceback")
        || lower.contains("exception")
        || lower.contains("at line")
}

fn mentions_multiple_files(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("multiple files")
        || lower.contains("several files")
        || lower.contains("across files")
        || lower.contains("both files")
}

fn path_mentions(text: &str) -> usize {
    text.split_whitespace()
        .filter(|token| looks_like_path(token.trim_matches(|c: char| ".,;:()[]{}\"'".contains(c))))
        .count()
}

fn clip(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_string();
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_string()
}
