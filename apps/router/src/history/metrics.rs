#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct TokenCount(pub u64);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct CostMicros(pub u64);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Millis(pub u64);

impl Millis {
    pub const fn new(ms: u64) -> Self {
        Self(ms)
    }
}

pub fn token_count_to_sql(value: TokenCount) -> i64 {
    i64::try_from(value.0).unwrap_or(i64::MAX)
}

pub fn cost_micros_to_sql(value: CostMicros) -> i64 {
    i64::try_from(value.0).unwrap_or(i64::MAX)
}

pub fn millis_to_sql(value: Millis) -> i64 {
    i64::try_from(value.0).unwrap_or(i64::MAX)
}

pub fn byte_len_to_sql(value: usize) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}
