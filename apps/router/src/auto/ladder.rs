use super::catalog::{RequestShape, Tiers};

const BANDS: [&str; 3] = ["low", "mid", "high"];

pub fn ladder_warnings(tiers: &Tiers) -> Vec<String> {
    let shape = RequestShape::default();
    let mut warnings = Vec::new();
    let mut costs: Vec<(&str, u128)> = Vec::new();
    for band in BANDS {
        let slug = tiers.slug(band);
        match tiers.blended_cost_micros(band, shape) {
            Some(cost) => costs.push((band, cost)),
            None => warnings.push(format!(
                "autoroute {band} model {slug} has no usable price entry in prices.toml; budget routing and cost estimates cannot use it"
            )),
        }
    }
    for (index, (lower, lower_cost)) in costs.iter().enumerate() {
        for (higher, higher_cost) in costs.iter().skip(index + 1) {
            if higher_cost < lower_cost {
                warnings.push(format!(
                    "autoroute ladder is not monotonic in price: {higher} ({}) costs {higher_cost} micro-USD but {lower} ({}) costs {lower_cost} micro-USD for a {} in / {} out token request",
                    tiers.slug(higher),
                    tiers.slug(lower),
                    shape.input_tokens,
                    shape.output_tokens,
                ));
            }
        }
    }
    let inverted = warnings
        .iter()
        .any(|warning| warning.contains("not monotonic"));
    if inverted {
        warnings.push(rule_note(tiers, shape));
    }
    warnings
}

fn rule_note(tiers: &Tiers, shape: RequestShape) -> String {
    if !tiers.never_pay_more_for_less {
        return "autoroute.never_pay_more_for_less is off: a request routed to a lower tier is billed at that tier's price even where a higher tier is cheaper".to_string();
    }
    let served: Vec<String> = BANDS
        .iter()
        .filter_map(|band| {
            tiers
                .price_swap(band, None, shape)
                .map(|to| format!("{band} is served by {to} ({})", tiers.slug(to)))
        })
        .collect();
    let detail = if served.is_empty() {
        "no tier is swapped for this request shape".to_string()
    } else {
        format!(
            "for a {} in / {} out token request {}",
            shape.input_tokens,
            shape.output_tokens,
            served.join(", ")
        )
    };
    format!(
        "autoroute.never_pay_more_for_less is on: a request decided for a tier is served by the cheapest priced tier at or above it (ties keep the lower tier; tier-policy ceiling caps the candidates, fixed disables the rule); {detail}"
    )
}
