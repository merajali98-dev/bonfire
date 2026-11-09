use crate::rounds::{phase_of, Phase};
use crate::types::*;
use crate::*;

#[near(serializers = [json])]
pub struct RoundView {
    pub round: Round,
    /// Scheduled | Backing | Candle | AwaitingSelection | <status>
    pub phase: String,
    /// Live total currently backing each mission (pre-candle + all candle adds).
    pub live_totals: Vec<U128>,
    /// Counted tallies at the drawn checkpoint, once drawn.
    pub counted_totals: Option<Vec<U128>>,
    /// Checkpoint a commitment made right now would land in (during the candle).
    pub current_checkpoint: Option<u8>,
    pub now_ms: u64,
}

#[near(serializers = [json])]
pub struct CommitmentView {
    pub round_id: u32,
    pub mission: u8,
    pub commitment: Commitment,
    pub total: U128,
    /// Counted toward the burn if this is the winner (known once the checkpoint is drawn).
    pub counted: Option<U128>,
    /// What `settle` would return right now.
    pub refundable_now: U128,
    /// Burned (or to be burned on acceptance).
    pub burn_exposure: U128,
}

#[near(serializers = [json])]
pub struct Audit {
    pub total_supply: U128,
    pub initial_supply: U128,
    pub total_burned: U128,
    pub resolve_burned: U128,
    /// total_supply == initial_supply - total_burned - resolve_burned
    pub supply_ok: bool,
    pub contract_ft_balance: U128,
    pub escrow_total: U128,
    pub faucet_remaining: U128,
    /// contract_ft_balance == escrow_total + faucet_remaining
    pub escrow_ok: bool,
    pub hearth_pool: U128,
    pub reserved_total: U128,
    pub claims_available: U128,
    pub claims_pending: U128,
    pub deposits_held: U128,
    /// hearth_pool + reserved_total + claims_available + deposits_held. A pending claim is
    /// excluded because its NEAR has already left with the transfer.
    pub obligations: U128,
    pub account_balance: U128,
    pub storage_locked: U128,
    /// account_balance - storage_locked - obligations (operating reserve); negative => false
    pub near_ok: bool,
    pub operating_surplus: U128,
    pub total_stoked: U128,
    pub total_paid: U128,
    pub total_recycled: U128,
    pub total_ash: U128,
    pub next_threshold: U128,
    pub rounds: u32,
    pub nominations: u32,
}

/// What a round created right now would get from `HearthRules`.
#[near(serializers = [json])]
pub struct NextRoundTerms {
    pub budget: U128,
    pub threshold: U128,
    pub target: U128,
    /// False when the computed budget is below `min_budget`, so `create_round` would fail.
    pub funded: bool,
}

#[near]
impl Contract {
    pub fn get_config(&self) -> Config {
        self.config.clone()
    }

    pub fn get_next_round_terms(&self) -> NextRoundTerms {
        let rules = &self.config.rules;
        let budget = math::round_budget(self.hearth_pool, rules.budget_bps);
        NextRoundTerms {
            budget: U128(budget),
            threshold: U128(self.next_threshold),
            target: U128(self.next_threshold.saturating_mul(rules.target_multiple as u128)),
            funded: budget >= rules.min_budget.0,
        }
    }

    pub fn get_round(&self, round_id: u32) -> Option<RoundView> {
        self.rounds.get(round_id).map(|r| self.round_view(r))
    }

    pub fn get_rounds(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<RoundView> {
        let from = from_index.unwrap_or(0);
        let limit = limit.unwrap_or(20).min(50);
        (from..self.rounds.len().min(from.saturating_add(limit)))
            .filter_map(|i| self.rounds.get(i).map(|r| self.round_view(r)))
            .collect()
    }

    pub fn get_round_count(&self) -> u32 {
        self.rounds.len()
    }

    pub fn get_nomination(&self, nomination_id: u32) -> Option<Nomination> {
        self.nominations.get(nomination_id).cloned()
    }

    pub fn get_nominations(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<Nomination> {
        let from = from_index.unwrap_or(0);
        let limit = limit.unwrap_or(50).min(100);
        (from..self.nominations.len().min(from.saturating_add(limit)))
            .filter_map(|i| self.nominations.get(i).cloned())
            .collect()
    }

    pub fn get_commitment(&self, round_id: u32, account_id: AccountId, mission: u8) -> Option<CommitmentView> {
        let key = CommitKey { round_id, account_id, mission };
        self.commitments.get(&key).map(|c| self.commitment_view(&key, c))
    }

    /// Every unsettled commitment record of an account.
    pub fn get_commitments_of(&self, account_id: AccountId) -> Vec<CommitmentView> {
        self.open_records
            .get(&account_id)
            .map(|idx| {
                idx.iter()
                    .filter_map(|(r, m)| {
                        let key = CommitKey { round_id: *r, account_id: account_id.clone(), mission: *m };
                        self.commitments.get(&key).map(|c| self.commitment_view(&key, c))
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn get_ash(&self, account_id: AccountId) -> U128 {
        U128(self.ash_of(&account_id))
    }

    /// Ash holders (unsorted page; the UI sorts). Ash is non-transferable: no method moves it.
    pub fn get_keepers(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<(AccountId, U128)> {
        let from = from_index.unwrap_or(0) as usize;
        let limit = limit.unwrap_or(100).min(200) as usize;
        self.ash.iter().skip(from).take(limit).map(|(a, v)| (a.clone(), *v)).collect()
    }

    pub fn get_stokers(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<(AccountId, U128)> {
        let from = from_index.unwrap_or(0) as usize;
        let limit = limit.unwrap_or(100).min(200) as usize;
        self.stokers.iter().skip(from).take(limit).map(|(a, v)| (a.clone(), *v)).collect()
    }

    /// Next time (ms) the account may claim from the faucet; 0 if it can claim now.
    pub fn get_faucet_next_ms(&self, account_id: AccountId) -> u64 {
        match self.faucet_claims.get(&account_id) {
            Some(last) => {
                let next = last + self.config.faucet_interval_ms;
                if env::block_timestamp_ms() >= next { 0 } else { next }
            }
            None => 0,
        }
    }

    /// Live reconciliation of every token and NEAR obligation the contract holds.
    pub fn audit(&self) -> Audit {
        let me = env::current_account_id();
        let supply = self.token.total_supply;
        let initial = self.config.initial_supply.0;
        let contract_ft = self.token.accounts.get(&me).unwrap_or(0);
        // A pending claim's NEAR left with its transfer receipt, so the balance no longer holds
        // it. Counting it would read near_ok false until the callback lands. If the transfer
        // fails, the refund and the callback restore both sides together.
        let obligations = self.hearth_pool + self.reserved_total + self.claims_available + self.deposits_held;
        let balance = env::account_balance().as_yoctonear();
        let locked = env::storage_byte_cost().as_yoctonear() * env::storage_usage() as u128;
        let need = obligations + locked;
        Audit {
            total_supply: U128(supply),
            initial_supply: U128(initial),
            total_burned: U128(self.total_burned),
            resolve_burned: U128(self.resolve_burned),
            supply_ok: supply + self.total_burned + self.resolve_burned == initial,
            contract_ft_balance: U128(contract_ft),
            escrow_total: U128(self.escrow_total),
            faucet_remaining: U128(self.faucet_remaining),
            escrow_ok: contract_ft == self.escrow_total + self.faucet_remaining,
            hearth_pool: U128(self.hearth_pool),
            reserved_total: U128(self.reserved_total),
            claims_available: U128(self.claims_available),
            claims_pending: U128(self.claims_pending),
            deposits_held: U128(self.deposits_held),
            obligations: U128(obligations),
            account_balance: U128(balance),
            storage_locked: U128(locked),
            near_ok: balance >= need,
            operating_surplus: U128(balance.saturating_sub(need)),
            total_stoked: U128(self.total_stoked),
            total_paid: U128(self.total_paid),
            total_recycled: U128(self.total_recycled),
            total_ash: U128(self.total_ash),
            next_threshold: U128(self.next_threshold),
            rounds: self.rounds.len(),
            nominations: self.nominations.len(),
        }
    }
}

impl Contract {
    fn round_view(&self, r: &Round) -> RoundView {
        let now = env::block_timestamp_ms();
        let phase = if r.status == RoundStatus::Funded {
            match phase_of(r, now) {
                Phase::Scheduled => "Scheduled",
                Phase::Backing => "Backing",
                Phase::Candle => "Candle",
                Phase::Closed => "AwaitingSelection",
            }
            .to_string()
        } else {
            format!("{:?}", r.status)
        };
        let current_checkpoint = if r.status == RoundStatus::Funded && phase_of(r, now) == Phase::Candle {
            Some(math::checkpoint_index(now, r.candle_start_ms, r.backing_close_ms, r.checkpoints))
        } else {
            None
        };
        RoundView {
            round: r.clone(),
            phase,
            live_totals: r.missions.iter().map(|m| U128(m.live_total())).collect(),
            counted_totals: r.drawn_checkpoint.map(|k| r.missions.iter().map(|m| U128(m.counted_at(k))).collect()),
            current_checkpoint,
            now_ms: now,
        }
    }

    fn commitment_view(&self, key: &CommitKey, c: &Commitment) -> CommitmentView {
        let r = self.rounds.get(key.round_id).expect("round");
        let total = c.total();
        let is_winner = r.winner == Some(key.mission);
        let counted = r.drawn_checkpoint.map(|k| c.counted_at(k));
        let (refundable, exposure) = match r.status {
            RoundStatus::Funded => (0, total),
            s if s.is_failed_terminal() => (total, 0),
            _ if !is_winner => (total, 0),
            _ => {
                let cnt = counted.unwrap_or(total);
                (total - cnt, cnt)
            }
        };
        CommitmentView {
            round_id: key.round_id,
            mission: key.mission,
            commitment: c.clone(),
            total: U128(total),
            counted: counted.map(U128),
            refundable_now: U128(refundable),
            burn_exposure: U128(exposure),
        }
    }
}
