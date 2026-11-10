use std::time::{Duration, SystemTime, UNIX_EPOCH};

const MODEL_UNAVAILABLE_MARKERS: &[&str] = &[
    "no available model provider",
    "no endpoints found",
    "model_not_available",
    "model is not available",
    "model is unavailable",
];

pub fn retry_after_delay(value: &str, now: SystemTime, max: Duration) -> Option<Duration> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    let wait = if let Ok(seconds) = value.parse::<u64>() {
        Duration::from_secs(seconds)
    } else if let Ok(seconds) = value.parse::<f64>() {
        if !seconds.is_finite() || seconds < 0.0 {
            return None;
        }
        Duration::from_secs_f64(seconds.min(max.as_secs_f64()))
    } else {
        let at = http_date(value)?;
        at.duration_since(now).unwrap_or(Duration::ZERO)
    };
    Some(wait.min(max))
}

pub fn model_unavailable(status: u16, body: &str) -> bool {
    if status != 429 && !(500..600).contains(&status) {
        return false;
    }
    let lower = body.to_ascii_lowercase();
    MODEL_UNAVAILABLE_MARKERS
        .iter()
        .any(|marker| lower.contains(marker))
}

fn http_date(value: &str) -> Option<SystemTime> {
    let mut words = value.split_whitespace();
    let weekday = words.next()?;
    if !weekday.ends_with(',') {
        return None;
    }
    let day: i64 = words.next()?.parse().ok()?;
    let month = month_number(words.next()?)?;
    let year: i64 = words.next()?.parse().ok()?;
    let mut clock = words.next()?.split(':');
    let hour: i64 = clock.next()?.parse().ok()?;
    let minute: i64 = clock.next()?.parse().ok()?;
    let second: i64 = clock.next()?.parse().ok()?;
    if words.next()? != "GMT" || !(1..=31).contains(&day) || hour > 23 || minute > 59 || second > 60
    {
        return None;
    }
    let days = days_from_civil(year, month, day);
    let seconds = days * 86_400 + hour * 3_600 + minute * 60 + second;
    let seconds = u64::try_from(seconds).ok()?;
    UNIX_EPOCH.checked_add(Duration::from_secs(seconds))
}

fn month_number(name: &str) -> Option<i64> {
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    MONTHS
        .iter()
        .position(|month| month.eq_ignore_ascii_case(name))
        .map(|index| index as i64 + 1)
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let shifted_month = (month + 9) % 12;
    let day_of_year = (153 * shifted_month + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}
