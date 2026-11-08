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
    /// yoctoNEAR reserved from the Hearth at creation.
    pub budget: U128,
    /// Minimum counted EMBER for a mission to win.
    pub threshold: U128,
    /// Counted EMBER at which the payout reaches the full budget.
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

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct CreateRoundArgs {
    pub nomination_ids: Vec<u32>,
    pub reviewer: AccountId,
    pub budget: U128,
    pub threshold: U128,
    pub target: U128,
    pub open_at_ms: u64,
    pub candle_start_ms: u64,
    pub backing_close_ms: u64,
    pub delivery_deadline_ms: u64,
    pub review_deadline_ms: u64,
    pub checkpoints: u8,
}
