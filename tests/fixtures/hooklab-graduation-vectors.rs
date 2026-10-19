//! Graduation vectors for the repo.ing website (tests/fixtures/hooklab-graduation-vectors.json), computed
//! with hook-lab's bordrless-core at 134e16de (lib.rs blob 0a4ee467, copied unmodified to ../bordrless-core).
//!
//! The glue below mirrors the deployed programs' inclusive path (fee model 2, LP and protocol bps 0):
//!   buy:  G = creator_and_holder_fees(A, b, 0, 0, 0).0, (P, N) = inclusive_creator_fee(G),
//!         swap_amounts(buy, A - G, 0, 0); quote_reserve += A - G; protocol_fees_quote += P
//!   sell: out = swap_amounts(sell, A, 0, 0).out_gross; G on out; delivered = out - G; fees += P
//! (bordrless_swap instructions/swap.rs, bordrless_launch instructions/hooks.rs process_inclusive_swap),
//! and graduate (bordrless_launch instructions/graduate.rs with bordrless_swap finalize_curve).
//! The final fill is searched over the buy amount itself, not derived the way the website derives it.
//! Run: cargo run -q -p graduation-vectors > hooklab-graduation-vectors.json
use bordrless_core::*;

const SUPPLY: u64 = policy::TOKEN_SUPPLY;
const CURVE_BPS: u64 = policy::CURVE_BPS;

#[derive(Clone, Copy)]
struct Pool {
    base: u64,
    quote: u64,
    vbase: u64,
    vquote: u64,
    fees: u64,
}

impl Pool {
    fn reserves(&self) -> Reserves {
        Reserves { base_reserve: self.base, quote_reserve: self.quote, virtual_base: self.vbase, virtual_quote: self.vquote }
    }
    fn json(&self) -> String {
        format!(
            r#"{{"baseReserve":"{}","quoteReserve":"{}","virtualBase":"{}","virtualQuote":"{}","protocolFeesQuote":"{}"}}"#,
            self.base, self.quote, self.vbase, self.vquote, self.fees
        )
    }
}

struct Quote {
    gross: u64,
    platform: u64,
    creator: u64,
    curve_input: u64,
    gross_output: u64,
    delivered: u64,
    after: Pool,
}

impl Quote {
    fn json(&self) -> String {
        format!(
            r#"{{"grossFee":"{}","platformFee":"{}","creatorFee":"{}","curveInput":"{}","grossOutput":"{}","delivered":"{}","after":{}}}"#,
            self.gross, self.platform, self.creator, self.curve_input, self.gross_output, self.delivered, self.after.json()
        )
    }
}

fn fee_split(amount: u64, fee_bps: u16) -> (u64, u64, u64) {
    let (gross, _) = creator_and_holder_fees(amount, fee_bps, 0, 0, 0);
    if gross == 0 {
        return (0, 0, 0);
    }
    let (platform, creator) = inclusive_creator_fee(gross);
    (gross, platform, creator)
}

fn buy(p: &Pool, amount: u64, fee_bps: u16) -> Option<Quote> {
    let (gross, platform, creator) = fee_split(amount, fee_bps);
    let received = amount.checked_sub(creator).filter(|r| *r > 0)?;
    let priced = received.checked_sub(platform)?;
    let a = swap_amounts(true, priced, 0, 0, &p.reserves()).ok()?;
    let after = Pool {
        base: p.base.checked_sub(a.out_gross)?,
        quote: p.quote.checked_add(a.to_reserve_in)?,
        fees: p.fees.checked_add(platform)?,
        ..*p
    };
    after.quote.checked_add(after.fees)?;
    Some(Quote { gross, platform, creator, curve_input: a.net_in, gross_output: a.out_gross, delivered: a.amount_out, after })
}

fn sell(p: &Pool, amount: u64, fee_bps: u16) -> Option<Quote> {
    let a = swap_amounts(false, amount, 0, 0, &p.reserves()).ok()?;
    let (gross, platform, creator) = fee_split(a.amount_out, fee_bps);
    let delivered = a.amount_out.checked_sub(gross).filter(|d| *d > 0)?;
    let after = Pool {
        base: p.base.checked_add(a.to_reserve_in)?,
        quote: p.quote.checked_sub(a.out_gross)?,
        fees: p.fees.checked_add(platform)?,
        ..*p
    };
    Some(Quote { gross, platform, creator, curve_input: a.net_in, gross_output: a.out_gross, delivered, after })
}

fn ready(p: &Pool, graduation_quote: u64) -> bool {
    p.quote >= graduation_quote || p.base == 0
}

/// The curve's raw output for curve input `c`, before the "not above the real reserve" refusal.
fn raw_out(p: &Pool, c: u64) -> u128 {
    let x = u128::from(p.quote) + u128::from(p.vquote);
    let y = u128::from(p.base) + u128::from(p.vbase);
    mul_div_floor(u128::from(c), y, x + u128::from(c)).unwrap()
}

/// The least buy after which `graduate` is ready, or None when the curve is already complete or no
/// buy lands exactly (every amount that reaches the end asks for more base than the curve holds).
/// "Ready or past the end" only switches from false to true as the amount grows, so it is bisected.
fn final_fill(p: &Pool, graduation_quote: u64, fee_bps: u16) -> Option<u64> {
    if ready(p, graduation_quote) {
        return None;
    }
    let past_end = |a: u64| raw_out(p, a - fee_split(a, fee_bps).0) > u128::from(p.base);
    let done = |a: u64| past_end(a) || buy(p, a, fee_bps).is_some_and(|q| ready(&q.after, graduation_quote));
    let (mut lo, mut hi) = (1u64, u64::MAX);
    assert!(done(hi));
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        if done(mid) {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }
    if past_end(lo) {
        return None;
    }
    let q = buy(p, lo, fee_bps).expect("final fill trades");
    assert!(ready(&q.after, graduation_quote));
    Some(lo)
}

struct Graduation {
    topup: u64,
    burned: u64,
    lp_supply: u64,
    lp_locked: u64,
    price_before_wad: u128,
    price_after_wad: u128,
    after: Pool,
}

/// `graduate` on a ready pool whose vaults hold exactly its reserves plus its protocol fees and whose
/// launch reserve holds `reserve_holding`; None where finalize_curve refuses (too little to mint LP).
fn graduate(p: &Pool, reserve_holding: u64) -> Option<Graduation> {
    let topup = graduation_topup(p.base, p.quote, p.vbase, p.vquote)?.min(reserve_holding);
    let base_total = p.base.checked_add(topup)?;
    let quote_total = p.quote.checked_add(p.fees)?;
    let (base, quote) = (base_total, quote_total - p.fees);
    let (lp_locked, lp_supply) = initial_lp(base, quote)?;
    Some(Graduation {
        topup,
        burned: reserve_holding - topup,
        lp_supply,
        lp_locked,
        price_before_wad: spot_price_wad(p.base, p.vbase, p.quote, p.vquote).unwrap(),
        price_after_wad: spot_price_wad(base, 0, quote, 0).unwrap(),
        after: Pool { base, quote, vbase: 0, vquote: 0, fees: p.fees },
    })
}

struct Out {
    trades: Vec<String>,
}

impl Out {
    fn trade(&mut self, label: &str, p: &Pool, side: &str, amount: u64, fee_bps: u16) -> Option<Quote> {
        let q = if side == "buy" { buy(p, amount, fee_bps) } else { sell(p, amount, fee_bps) };
        self.trades.push(format!(
            r#"{{"label":"{}","creatorFeeBps":{},"pool":{},"side":"{}","amountIn":"{}","quote":{}}}"#,
            label,
            fee_bps,
            p.json(),
            side,
            amount,
            q.as_ref().map_or("null".to_string(), Quote::json)
        ));
        q
    }
}

fn state_json(out: &mut Out, label: &str, p: &Pool, gq: u64, reserve: u64, fee: u16) -> String {
    let max_in = max_swap_in(p.quote, p.vquote, p.base, p.vbase);
    let fill = final_fill(p, gq, fee);
    let fill_json = match fill {
        None => "null".to_string(),
        Some(a) => {
            let q = out.trade(&format!("{label}: final fill"), p, "buy", a, fee).unwrap();
            let below = buy(p, a - 1, fee).is_none_or(|b| !ready(&b.after, gq));
            assert!(below, "one lamport less does not graduate");
            format!(r#"{{"amountIn":"{}","quote":{}}}"#, a, q.json())
        }
    };
    let grad = ready(p, gq).then(|| graduation_json(out, label, p, reserve, fee));
    format!(
        r#"{{"label":"{}","pool":{},"ready":{},"maxSwapIn":{},"finalFill":{},"graduation":{}}}"#,
        label,
        p.json(),
        ready(p, gq),
        max_in.map_or("null".to_string(), |v| format!("\"{v}\"")),
        fill_json,
        grad.unwrap_or_else(|| "null".to_string())
    )
}

fn graduation_json(out: &mut Out, label: &str, p: &Pool, reserve: u64, fee: u16) -> String {
    let Some(g) = graduate(p, reserve) else {
        return "null".to_string();
    };
    // After graduation the same pool is a plain constant-product market with the same inclusive fee.
    for (i, sol) in [100_000_000u64, 1_000_000_000, 10_000_000_000].into_iter().enumerate() {
        out.trade(&format!("{label}: after graduation buy {i}"), &g.after, "buy", sol, fee);
    }
    for (i, share) in [1_000u64, 100, 10].into_iter().enumerate() {
        out.trade(&format!("{label}: after graduation sell {i}"), &g.after, "sell", g.after.base / share, fee);
    }
    format!(
        r#"{{"reserveHolding":"{}","topup":"{}","burned":"{}","lpSupply":"{}","lpLocked":"{}","priceBeforeWad":"{}","priceAfterWad":"{}","after":{}}}"#,
        reserve, g.topup, g.burned, g.lp_supply, g.lp_locked, g.price_before_wad, g.price_after_wad, g.after.json()
    )
}

fn config(out: &mut Out, name: &str, vq: u64, fee: u16, start_quote: u64) -> String {
    let c = curve_params(SUPPLY, CURVE_BPS, vq).unwrap();
    let gq = c.graduation_quote;
    let reserve = c.reserve_tokens;
    let mut states = Vec::new();
    let open = Pool { base: c.curve_tokens, quote: start_quote, vbase: c.virtual_base, vquote: vq, fees: 0 };
    states.push(state_json(out, "opening", &open, gq, reserve, fee));
    // A day of trading: buys, a sell of part of what was bought, refusals at both ends.
    let mut p = open;
    out.trade("1 lamport buy", &p, "buy", 1, fee);
    for (i, share) in [1_000u64, 10, 4].into_iter().enumerate() {
        p = out.trade(&format!("buy {i}"), &p, "buy", gq / share, fee).unwrap().after;
    }
    let held = c.curve_tokens - p.base;
    p = out.trade("sell a third", &p, "sell", held / 3, fee).unwrap().after;
    out.trade("sell more than the curve took", &p, "sell", u64::MAX / 2, fee);
    states.push(state_json(out, "midway", &p, gq, reserve, fee));
    p = out.trade("buy to near the end", &p, "buy", (gq - p.quote) * 99 / 100, fee).unwrap().after;
    states.push(state_json(out, "near the end", &p, gq, reserve, fee));
    let fill = final_fill(&p, gq, fee).unwrap();
    out.trade("past the end (refused)", &p, "buy", fill * 3, fee);
    let almost = out.trade("one lamport short of the final fill", &p, "buy", fill - 1, fee).unwrap().after;
    states.push(state_json(out, "one lamport short", &almost, gq, reserve, fee));
    let fill2 = final_fill(&almost, gq, fee).unwrap();
    let complete = buy(&almost, fill2, fee).unwrap().after;
    states.push(state_json(out, "complete", &complete, gq, reserve, fee));
    // A buy past the graduation point that the curve still allows (another client could send it).
    let past = [3u64, 2, 1].into_iter().find_map(|a| buy(&complete, a, fee)).map(|q| q.after);
    if let Some(past) = past {
        states.push(state_json(out, "bought past the point", &past, gq, reserve, fee));
    }
    format!(
        r#"{{"name":"{}","supply":"{}","curveBps":{},"decimals":{},"virtualQuote":"{}","creatorFeeBps":{},"curve":{{"curveTokens":"{}","reserveTokens":"{}","virtualBase":"{}","graduationQuote":"{}"}},"states":[{}]}}"#,
        name,
        SUPPLY,
        CURVE_BPS,
        policy::TOKEN_DECIMALS,
        vq,
        fee,
        c.curve_tokens,
        c.reserve_tokens,
        c.virtual_base,
        gq,
        states.join(",")
    )
}

/// Pools no real curve reaches, for the edges of the final-fill rule.
fn synthetic(out: &mut Out) -> String {
    let gq = 1_000_000_000_000u64;
    let cases = [
        // The base runs out exactly before the quote reaches the threshold.
        ("base runs out exactly", Pool { base: 1_000, quote: 0, vbase: 1_000, vquote: 1_000_000_000, fees: 0 }, 100u16),
        // Every amount that reaches the end asks for more base than is left: no exact fill.
        ("no exact fill", Pool { base: 375_000, quote: 1, vbase: 375_000_000_000_000, vquote: 1_000_000_000, fees: 7 }, 100),
        ("no creator fee", Pool { base: 1_000, quote: 0, vbase: 1_000, vquote: 1_000_000_000, fees: 0 }, 0),
        ("sold out, quote short", Pool { base: 0, quote: 5, vbase: 3_000, vquote: 1_000_000_000, fees: 3 }, 100),
        // One lamport short, but one lamport buys no base: the fill is the least input that buys something.
        ("pricey dust", Pool { base: 10, quote: gq - 1, vbase: 10, vquote: 1_000_000_000, fees: 0 }, 100),
    ];
    let mut items = Vec::new();
    for (label, p, fee) in cases {
        let s = state_json(out, label, &p, gq, 1_000_000, fee);
        items.push(format!(r#"{{"creatorFeeBps":{},"graduationQuote":"{}","state":{}}}"#, fee, gq, s));
    }
    items.join(",")
}

fn main() {
    let mut out = Out { trades: Vec::new() };
    let mut configs = Vec::new();
    // The canary (hidden on the site): Vq 1 SOL, its pool after a buy and a sell left 1 lamport of quote.
    configs.push(config(&mut out, "canary", 1_000_000_000, 100, 1));
    for (vq, label) in [(5_625_000_000u64, "5.625"), (53_250_000_000, "53.25"), (112_500_000_000, "112.5")] {
        for fee in [50u16, 100, 200] {
            configs.push(config(&mut out, &format!("Vq {label} SOL, fee {fee}"), vq, fee, 0));
        }
    }
    let synthetic = synthetic(&mut out);
    let trades = std::mem::take(&mut out.trades);
    println!(
        r#"{{"schema":"repoing/hooklab-graduation-vectors/1","configs":[{}],"synthetic":[{}],"trades":[{}]}}"#,
        configs.join(","),
        synthetic,
        trades.join(",")
    );
}
