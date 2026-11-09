use near_sdk::json_types::U128;
use near_sdk::{near, AccountId};

/// Contract-wide parameters. Fixed at `new`; no method changes them.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Config {
    /// The only account that can create (and, before opening, cancel) rounds.
    pub curator: AccountId,
    /// Receives the distribution allocation at genesis. Transfers only; cannot mint.
    pub distribution_account: AccountId,
    /// EMBER (smallest units) handed out per faucet claim.
    pub faucet_amount: U128,
    /// Minimum milliseconds between faucet claims by the same account.
    pub faucet_interval_ms: u64,
    /// Ash (smallest units) a non-curator account needs to nominate a mission.
    pub nominate_min_ash: U128,
    /// Total EMBER minted at genesis. Nothing is ever minted afterwards.
    pub initial_supply: U128,
    /// The rules that compute every round's budget, threshold and target.
    pub rules: HearthRules,
    /// The shortest and longest each round window may be. Fixed at genesis.
    pub limits: RoundLimits,
}

/// Fixed at `new`. A round's budget, threshold and target come only from these and from
/// past outcomes; no caller supplies them.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct HearthRules {
    /// Share of the Hearth pool reserved per round, in basis points.
    pub budget_bps: u32,
    /// A round cannot be created if its computed budget (yoctoNEAR) is below this.
    pub min_budget: U128,
    /// Threshold (EMBER smallest units) of the first round.
    pub initial_threshold: U128,
    /// The threshold never falls below this.
    pub min_threshold: U128,
    /// Multiplier applied to the next threshold when `select` finds a winner, in basis points.
    pub up_bps: u32,
    /// Multiplier applied when nothing reaches the threshold, in basis points.
    pub down_bps: u32,
    /// target = threshold * target_multiple.
    pub target_multiple: u32,
}

impl HearthRules {
    pub fn is_valid(&self, initial_supply: u128) -> bool {
        let bps = crate::math::BPS as u32;
        (1..=bps).contains(&self.budget_bps)
            && self.min_budget.0 > 0
            && self.min_threshold.0 > 0
            && self.min_threshold.0 <= self.initial_threshold.0
            && self.initial_threshold.0 <= initial_supply
            && self.up_bps >= bps
            && (1..=bps).contains(&self.down_bps)
            && self.target_multiple >= 1
            && initial_supply.checked_mul(self.up_bps as u128).is_some()
            && initial_supply.checked_mul(self.target_multiple as u128).is_some()
    }
}

/// Bounds on every round's time windows, in milliseconds. Minimums stop the curator from
/// running back-to-back instant rounds to walk the threshold down; maximums stop a round from
/// locking its budget for an unbounded time. Set at genesis so tests can use short ones.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct RoundLimits {
    /// Longest wait from `create_round` to `open_at_ms`.
    pub max_lead_ms: u64,
    /// Bounds on `backing_close_ms - open_at_ms` (the whole backing period, candle included).
    pub min_backing_ms: u64,
    pub max_backing_ms: u64,
    /// Bounds on `backing_close_ms - candle_start_ms`.
    pub min_candle_ms: u64,
    pub max_candle_ms: u64,
    /// Bounds on `delivery_deadline_ms - backing_close_ms`.
    pub min_delivery_ms: u64,
    pub max_delivery_ms: u64,
    /// Bounds on `review_deadline_ms - delivery_deadline_ms`.
    pub min_review_ms: u64,
    pub max_review_ms: u64,
}

impl RoundLimits {
    pub fn is_valid(&self) -> bool {
        let pair = |min: u64, max: u64| min > 0 && min <= max;
        pair(self.min_backing_ms, self.max_backing_ms)
            && pair(self.min_candle_ms, self.max_candle_ms)
            && pair(self.min_delivery_ms, self.max_delivery_ms)
            && pair(self.min_review_ms, self.max_review_ms)
            && self.min_candle_ms < self.max_backing_ms
            && self.max_lead_ms > 0
    }

    /// Whether a round with these timestamps, created at `now`, fits every bound. The caller
    /// has already checked that the timestamps are in order.
    pub fn allow(&self, now: u64, open: u64, candle: u64, close: u64, delivery: u64, review: u64) -> bool {
        let within = |d: u64, min: u64, max: u64| d >= min && d <= max;
        open - now <= self.max_lead_ms
            && within(close - open, self.min_backing_ms, self.max_backing_ms)
            && within(close - candle, self.min_candle_ms, self.max_candle_ms)
            && within(delivery - close, self.min_delivery_ms, self.max_delivery_ms)
            && within(review - delivery, self.min_review_ms, self.max_review_ms)
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Nomination {
    pub id: u32,
    pub nominator: AccountId,
    /// Account that submits the work and receives the payout.
    pub creator: AccountId,
    pub title: String,
    pub brief_uri: String,
    /// Hex sha256 of the brief document.
    pub brief_hash: String,
    pub consented: bool,
    /// Round that consumed this nomination, if any.
    pub used_in: Option<u32>,
    pub created_at_ms: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RoundStatus {
    /// Budget reserved; backing phases are derived from the clock (Scheduled/Backing/Candle/Closed).
    Funded,
    Cancelled,
    FailedSelection,
    AwaitingWork,
    AwaitingReview,
    Accepted,
    Rejected,
    ExpiredWork,
    ExpiredReview,
}

impl RoundStatus {
    /// Terminal states where nothing of the winning escrow is burned.
    pub fn is_failed_terminal(self) -> bool {
        matches!(
            self,
            RoundStatus::Cancelled
                | RoundStatus::FailedSelection
                | RoundStatus::Rejected
                | RoundStatus::ExpiredWork
                | RoundStatus::ExpiredReview
        )
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PayoutState {
    None,
    Available,
    Pending,
    Paid,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Mission {
    pub nomination_id: u32,
    pub creator: AccountId,
    pub title: String,
    pub brief_uri: String,
    pub brief_hash: String,
    /// Committed before the candle (withdrawals reduce it).
    pub pre_total: U128,
    /// Added during the candle, per checkpoint. Length == round.checkpoints.
    pub candle_adds: Vec<U128>,
}

impl Mission {
    /// Tally counted if the fire went out at the end of checkpoint `k`.
    pub fn counted_at(&self, k: u8) -> u128 {
        self.candle_adds
            .iter()
            .take(k as usize + 1)
            .fold(self.pre_total.0, |acc, x| acc.checked_add(x.0).expect("overflow"))
    }

    pub fn live_total(&self) -> u128 {
        self.candle_adds
            .iter()
            .fold(self.pre_total.0, |acc, x| acc.checked_add(x.0).expect("overflow"))
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Submission {
    /// Hex sha256 of the delivered artifact (64 lowercase hex chars).
    pub hash: String,
    pub uri: String,
    pub at_ms: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Round {
    pub id: u32,
    pub reviewer: AccountId,
    /// yoctoNEAR reserved from the Hearth at creation, computed by `HearthRules`.
    pub budget: U128,
    /// Minimum counted EMBER for a mission to win, computed by `HearthRules`.
    pub threshold: U128,
    /// Counted EMBER at which the payout reaches the full budget, computed by `HearthRules`.
    pub target: U128,
    pub open_at_ms: u64,
    pub candle_start_ms: u64,
    pub backing_close_ms: u64,
    pub delivery_deadline_ms: u64,
    pub review_deadline_ms: u64,
    pub checkpoints: u8,
    pub missions: Vec<Mission>,
    pub status: RoundStatus,
    pub created_at_ms: u64,
    /// The first account to commit in this round. A public record only: no EMBER, weight or Ash.
    pub first_spark: Option<AccountId>,

    // Selection results
    pub drawn_checkpoint: Option<u8>,
    pub winner: Option<u8>,
    /// Counted escrow of the winner (burned on acceptance).
    pub counted: U128,
    /// yoctoNEAR the creator receives on acceptance.
    pub payout: U128,
    pub selected_at_ms: Option<u64>,

    pub submission: Option<Submission>,
    pub decided_at_ms: Option<u64>,
    pub burned: U128,
    pub payout_state: PayoutState,
    /// EMBER of this round still held by the contract (refundable or awaiting burn).
    pub escrow_live: U128,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct CommitKey {
    pub round_id: u32,
    pub account_id: AccountId,
    pub mission: u8,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default)]
pub struct Commitment {
    pub pre: U128,
    /// (checkpoint, amount) added during the candle; at most one entry per checkpoint.
    pub adds: Vec<(u8, U128)>,
    /// yoctoNEAR storage deposit held for this record, returned on settlement.
    pub deposit: U128,
}

impl Commitment {
    pub fn total(&self) -> u128 {
        self.adds.iter().fold(self.pre.0, |a, (_, x)| a.checked_add(x.0).expect("overflow"))
    }
    pub fn counted_at(&self, k: u8) -> u128 {
        self.adds
            .iter()
            .filter(|(c, _)| *c <= k)
            .fold(self.pre.0, |a, (_, x)| a.checked_add(x.0).expect("overflow"))
    }
}

/// Everything the curator chooses for a round. Unknown fields are refused, so a call that
/// tries to pass a budget, threshold or target fails instead of being silently ignored.
#[near(serializers = [json])]
#[serde(deny_unknown_fields)]
#[derive(Clone, Debug)]
pub struct CreateRoundArgs {
    pub nomination_ids: Vec<u32>,
    pub reviewer: AccountId,
    pub open_at_ms: u64,
    pub candle_start_ms: u64,
    pub backing_close_ms: u64,
    pub delivery_deadline_ms: u64,
    pub review_deadline_ms: u64,
    pub checkpoints: u8,
}
