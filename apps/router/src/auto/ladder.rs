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
    warnings
}
