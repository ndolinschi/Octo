use std::cmp::Ordering;

use serde::Deserialize;

use crate::auto::{RequestShape, Tiers};

use super::types::{ApiTier, Band, Candidate};

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(default)]
pub struct RoutePolicy {
    pub classifier_timeout_ms: u64,
    pub prefer_flat_rate_for_hard: bool,
    pub nominal_input_tokens: u64,
    pub nominal_output_tokens: u64,
}

impl Default for RoutePolicy {
    fn default() -> Self {
        let shape = RequestShape::default();
        Self {
            classifier_timeout_ms: 2000,
            prefer_flat_rate_for_hard: false,
            nominal_input_tokens: shape.input_tokens,
            nominal_output_tokens: shape.output_tokens,
        }
    }
}

impl RoutePolicy {
    pub fn shape(&self) -> RequestShape {
        RequestShape {
            input_tokens: self.nominal_input_tokens,
            output_tokens: self.nominal_output_tokens,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum How {
    FlatAgent,
    Api,
    PaidAgent,
    FallbackApi,
    FallbackAgent,
    BudgetAgent,
    BudgetApi,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Selection {
    pub index: usize,
    pub how: How,
    pub alternatives: Vec<usize>,
}

pub fn estimate_usd(
    tiers: &Tiers,
    policy: &RoutePolicy,
    candidates: &[Candidate],
    candidate: &Candidate,
) -> Option<f64> {
    match candidate {
        Candidate::Api { tier, .. } => {
            api_micros(tiers, policy, candidates, *tier).map(micros_to_usd)
        }
        Candidate::Agent {
            flat_rate: true, ..
        } => Some(0.0),
        Candidate::Agent { .. } => None,
    }
}

fn micros_to_usd(micros: u128) -> f64 {
    micros as f64 / 1_000_000.0
}

/// The price rule's swap for an API candidate, limited to tiers the caller offered among `candidates`.
pub fn api_swap(
    tiers: &Tiers,
    policy: &RoutePolicy,
    candidates: &[Candidate],
    tier: ApiTier,
) -> Option<&'static str> {
    tiers.price_swap_where(tier.ladder_band(), None, policy.shape(), |band| {
        candidates
            .iter()
            .any(|c| matches!(c, Candidate::Api { tier, .. } if tier.ladder_band() == band))
    })
}

fn api_micros(
    tiers: &Tiers,
    policy: &RoutePolicy,
    candidates: &[Candidate],
    tier: ApiTier,
) -> Option<u128> {
    let band = api_swap(tiers, policy, candidates, tier).unwrap_or(tier.ladder_band());
    tiers.blended_cost_micros(band, policy.shape())
}

fn strengths_of(strengths: &[String]) -> Vec<Band> {
    strengths
        .iter()
        .filter_map(|raw| Band::parse(raw))
        .collect()
}

fn able(policy: &RoutePolicy, band: Band, candidate: &Candidate) -> bool {
    match candidate {
        Candidate::Api { tier, .. } => tier.rank() >= band.rank(),
        Candidate::Agent { strengths, .. } => {
            if !candidate.usable_agent() {
                return false;
            }
            let known = strengths_of(strengths);
            if known.is_empty() {
                band != Band::Hard || policy.prefer_flat_rate_for_hard
            } else {
                known.contains(&band)
            }
        }
    }
}

fn limit_order(left: &Candidate, right: &Candidate) -> Ordering {
    let key = |candidate: &Candidate| match candidate {
        Candidate::Agent {
            limit_remaining: Some(left),
            ..
        } => *left,
        _ => f64::INFINITY,
    };
    key(right)
        .partial_cmp(&key(left))
        .unwrap_or(Ordering::Equal)
}

struct Ranked<'a> {
    index: usize,
    group: u8,
    cost: u128,
    candidate: &'a Candidate,
}

fn rank<'a>(
    tiers: &Tiers,
    policy: &RoutePolicy,
    candidates: &'a [Candidate],
    indexes: impl Iterator<Item = usize>,
) -> Vec<Ranked<'a>> {
    let mut rows: Vec<Ranked<'a>> = indexes
        .map(|index| {
            let candidate = &candidates[index];
            let (group, cost) = match candidate {
                Candidate::Agent {
                    flat_rate: true, ..
                } => (0, 0),
                Candidate::Api { tier, .. } => (
                    1,
                    api_micros(tiers, policy, candidates, *tier).unwrap_or(u128::MAX),
                ),
                Candidate::Agent { .. } => (2, 0),
            };
            Ranked {
                index,
                group,
                cost,
                candidate,
            }
        })
        .collect();
    rows.sort_by(|a, b| {
        a.group
            .cmp(&b.group)
            .then(a.cost.cmp(&b.cost))
            .then_with(|| match (a.candidate, b.candidate) {
                (Candidate::Api { tier: left, .. }, Candidate::Api { tier: right, .. }) => {
                    left.rank().cmp(&right.rank())
                }
                _ => limit_order(a.candidate, b.candidate),
            })
            .then(a.index.cmp(&b.index))
    });
    rows
}

pub fn select(
    tiers: &Tiers,
    policy: &RoutePolicy,
    band: Band,
    candidates: &[Candidate],
) -> Option<Selection> {
    let ranked = rank(
        tiers,
        policy,
        candidates,
        (0..candidates.len()).filter(|&index| able(policy, band, &candidates[index])),
    );
    if let Some((first, rest)) = ranked.split_first() {
        let how = match first.group {
            0 => How::FlatAgent,
            1 => How::Api,
            _ => How::PaidAgent,
        };
        return Some(Selection {
            index: first.index,
            how,
            alternatives: rest.iter().map(|row| row.index).collect(),
        });
    }
    let top_api = candidates
        .iter()
        .enumerate()
        .filter_map(|(index, candidate)| match candidate {
            Candidate::Api { tier, .. } => Some((index, tier.rank())),
            _ => None,
        })
        .fold(None::<(usize, u8)>, |best, row| match best {
            Some(found) if found.1 >= row.1 => Some(found),
            _ => Some(row),
        });
    if let Some((index, _)) = top_api {
        return Some(Selection {
            index,
            how: How::FallbackApi,
            alternatives: Vec::new(),
        });
    }
    candidates
        .iter()
        .position(Candidate::usable_agent)
        .map(|index| Selection {
            index,
            how: How::FallbackAgent,
            alternatives: Vec::new(),
        })
}

pub fn select_after_budget(
    tiers: &Tiers,
    policy: &RoutePolicy,
    band: Band,
    candidates: &[Candidate],
    allow_api: bool,
) -> Option<Selection> {
    let flat: Vec<usize> = (0..candidates.len())
        .filter(|&index| {
            matches!(
                candidates[index],
                Candidate::Agent {
                    flat_rate: true,
                    ..
                }
            ) && candidates[index].usable_agent()
        })
        .collect();
    let able_flat: Vec<usize> = flat
        .iter()
        .copied()
        .filter(|&index| able(policy, band, &candidates[index]))
        .collect();
    let pool = if able_flat.is_empty() {
        flat
    } else {
        able_flat
    };
    let ranked = rank(tiers, policy, candidates, pool.into_iter());
    if let Some(first) = ranked.first() {
        return Some(Selection {
            index: first.index,
            how: How::BudgetAgent,
            alternatives: Vec::new(),
        });
    }
    if !allow_api {
        return None;
    }
    let apis =
        (0..candidates.len()).filter(|&index| matches!(candidates[index], Candidate::Api { .. }));
    if let Some(first) = rank(tiers, policy, candidates, apis).first() {
        return Some(Selection {
            index: first.index,
            how: How::BudgetApi,
            alternatives: Vec::new(),
        });
    }
    candidates
        .iter()
        .position(Candidate::usable_agent)
        .map(|index| Selection {
            index,
            how: How::BudgetAgent,
            alternatives: Vec::new(),
        })
}
