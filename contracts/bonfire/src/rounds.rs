use crate::events::emit;
use crate::math::{adjust_threshold, checkpoint_index, matched_payout, round_budget};
use crate::types::*;
use crate::*;
use near_sdk::{is_promise_success, Gas};

const PAYOUT_CALLBACK_GAS: Gas = Gas::from_tgas(10);

/// Clock-derived phase of a `Funded` round.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Scheduled,
    Backing,
    Candle,
    Closed,
}

pub fn phase_of(r: &Round, now: u64) -> Phase {
    if now < r.open_at_ms {
        Phase::Scheduled
    } else if now < r.candle_start_ms {
        Phase::Backing
    } else if now < r.backing_close_ms {
        Phase::Candle
    } else {
        Phase::Closed
    }
}

#[near]
impl Contract {
    // ------------------------------------------------------------ create/cancel

    /// Curator creates a round from 3–5 consented nominations. The curator chooses the missions,
    /// the time windows and the reviewer; the budget, threshold and target are computed here.
    /// All parameters are frozen from this point.
    pub fn create_round(&mut self, args: CreateRoundArgs) -> u32 {
        require!(env::predecessor_account_id() == self.config.curator, err::NOT_CURATOR);
        require!(self.funded_round.is_none(), err::ROUND_OPEN);
        let now = env::block_timestamp_ms();
        let n = args.nomination_ids.len();
        require!((MIN_MISSIONS..=MAX_MISSIONS).contains(&n), err::BAD_PARAMS);
        require!(args.checkpoints >= 1 && args.checkpoints <= MAX_CHECKPOINTS, err::BAD_PARAMS);
        require!(
            now <= args.open_at_ms
                && args.open_at_ms < args.candle_start_ms
                && args.candle_start_ms < args.backing_close_ms
                && args.backing_close_ms < args.delivery_deadline_ms
                && args.delivery_deadline_ms < args.review_deadline_ms,
            err::BAD_PARAMS
        );
        require!(
            self.config.limits.allow(
                now,
                args.open_at_ms,
                args.candle_start_ms,
                args.backing_close_ms,
                args.delivery_deadline_ms,
                args.review_deadline_ms,
            ),
            err::BAD_PARAMS
        );
        let rules = &self.config.rules;
        let budget = round_budget(self.hearth_pool, rules.budget_bps);
        require!(budget >= rules.min_budget.0, err::HEARTH_TOO_LOW);
        let threshold = self.next_threshold;
        let target = threshold.checked_mul(rules.target_multiple as u128).expect("overflow");

        let round_id = self.rounds.len();
        let mut missions = Vec::with_capacity(n);
        for (i, id) in args.nomination_ids.iter().enumerate() {
            require!(!args.nomination_ids[..i].contains(id), err::BAD_PARAMS);
            let nom = self.nominations.get_mut(*id).unwrap_or_else(|| env::panic_str(err::NO_NOMINATION));
            require!(nom.used_in.is_none(), err::ALREADY_USED);
            require!(nom.consented, err::NOT_CONSENTED);
            nom.used_in = Some(round_id);
            missions.push(Mission {
                nomination_id: *id,
                creator: nom.creator.clone(),
                title: nom.title.clone(),
                brief_uri: nom.brief_uri.clone(),
                brief_hash: nom.brief_hash.clone(),
                pre_total: U128(0),
                candle_adds: vec![U128(0); args.checkpoints as usize],
            });
        }

        self.hearth_pool -= budget;
        self.reserved_total = self.reserved_total.checked_add(budget).expect("overflow");

        let round = Round {
            id: round_id,
            reviewer: args.reviewer,
            budget: U128(budget),
            threshold: U128(threshold),
            target: U128(target),
            open_at_ms: args.open_at_ms,
            candle_start_ms: args.candle_start_ms,
            backing_close_ms: args.backing_close_ms,
            delivery_deadline_ms: args.delivery_deadline_ms,
            review_deadline_ms: args.review_deadline_ms,
            checkpoints: args.checkpoints,
            missions,
            status: RoundStatus::Funded,
            created_at_ms: now,
            first_spark: None,
            drawn_checkpoint: None,
            winner: None,
            counted: U128(0),
            payout: U128(0),
            selected_at_ms: None,
            submission: None,
            decided_at_ms: None,
            burned: U128(0),
            payout_state: PayoutState::None,
            escrow_live: U128(0),
        };
        emit("round_created", json!({ "round": &round }));
        self.rounds.push(round);
        self.funded_round = Some(round_id);
        round_id
    }

    /// Curator may cancel only before the round opens; the budget returns to the Hearth.
    pub fn cancel_round(&mut self, round_id: u32) {
        require!(env::predecessor_account_id() == self.config.curator, err::NOT_CURATOR);
        let now = env::block_timestamp_ms();
        // Only one round is ever Funded, and a cancel that fails below reverts this.
        self.funded_round = None;
        let r = self.round_mut(round_id);
        require!(r.status == RoundStatus::Funded, err::WRONG_STATUS);
        require!(now < r.open_at_ms, err::WRONG_STATUS);
        r.status = RoundStatus::Cancelled;
        r.decided_at_ms = Some(now);
        let budget = r.budget.0;
        let noms: Vec<u32> = r.missions.iter().map(|m| m.nomination_id).collect();
        for id in noms {
            if let Some(n) = self.nominations.get_mut(id) {
                n.used_in = None;
            }
        }
        self.release_to_hearth(budget);
        emit("cancel", json!({ "round_id": round_id, "returned": U128(budget) }));
    }

    // ------------------------------------------------------------ backing

    /// Commit EMBER to a mission. Before the candle this is freely reversible; during the
    /// candle it can only be added to. A new record needs COMMIT_DEPOSIT attached (refunded on
    /// settlement); otherwise attach 1 yoctoNEAR. Excess deposit is refunded.
    #[payable]
    pub fn commit(&mut self, round_id: u32, mission: u8, amount: U128) {
        let who = env::predecessor_account_id();
        let attached = env::attached_deposit();
        require!(!attached.is_zero(), err::DEPOSIT);
        require!(amount.0 > 0, err::AMOUNT);
        require!(self.token.accounts.contains_key(&who), err::NOT_REGISTERED);
        let now = env::block_timestamp_ms();

        let r = self.round_mut(round_id);
        require!(r.status == RoundStatus::Funded, err::NOT_BACKING);
        let phase = phase_of(r, now);
        require!(phase == Phase::Backing || phase == Phase::Candle, err::NOT_BACKING);
        require!((mission as usize) < r.missions.len(), err::NO_MISSION);

        let checkpoint = if phase == Phase::Candle {
            Some(checkpoint_index(now, r.candle_start_ms, r.backing_close_ms, r.checkpoints))
        } else {
            None
        };
        let m = &mut r.missions[mission as usize];
        match checkpoint {
            None => m.pre_total = U128(m.pre_total.0.checked_add(amount.0).expect("overflow")),
            Some(k) => {
                let slot = &mut m.candle_adds[k as usize];
                *slot = U128(slot.0.checked_add(amount.0).expect("overflow"));
            }
        }
        r.escrow_live = U128(r.escrow_live.0.checked_add(amount.0).expect("overflow"));
        if r.first_spark.is_none() {
            r.first_spark = Some(who.clone());
        }

        let key = CommitKey { round_id, account_id: who.clone(), mission };
        let mut rec = self.commitments.get(&key).cloned();
        let mut excess = attached;
        if rec.is_none() {
            require!(attached >= COMMIT_DEPOSIT, err::DEPOSIT);
            excess = attached.saturating_sub(COMMIT_DEPOSIT);
            self.deposits_held = self.deposits_held.checked_add(COMMIT_DEPOSIT.as_yoctonear()).expect("overflow");
            rec = Some(Commitment { deposit: U128(COMMIT_DEPOSIT.as_yoctonear()), ..Default::default() });
            let mut idx = self.open_records.get(&who).cloned().unwrap_or_default();
            idx.push((round_id, mission));
            self.open_records.insert(who.clone(), idx);
        }
        let mut rec = rec.unwrap();
        match checkpoint {
            None => rec.pre = U128(rec.pre.0 + amount.0),
            Some(k) => match rec.adds.iter_mut().find(|(c, _)| *c == k) {
                Some((_, a)) => *a = U128(a.0 + amount.0),
                None => rec.adds.push((k, amount)),
            },
        }
        self.commitments.insert(key, rec);

        self.escrow_total = self.escrow_total.checked_add(amount.0).expect("overflow");
        self.token.internal_transfer(&who, &env::current_account_id(), amount.0, Some(format!("bonfire:commit round {}", round_id)));
        emit("commit", json!({
            "round_id": round_id, "mission": mission, "account_id": who,
            "amount": amount, "checkpoint": checkpoint,
        }));
        refund(&who, excess);
    }

    /// Withdraw a pre-candle commitment. Not allowed once the candle is lit.
    pub fn withdraw(&mut self, round_id: u32, mission: u8, amount: U128) {
        let who = env::predecessor_account_id();
        require!(amount.0 > 0, err::AMOUNT);
        let now = env::block_timestamp_ms();
        let r = self.round_mut(round_id);
        require!(r.status == RoundStatus::Funded, err::NOT_BACKING);
        match phase_of(r, now) {
            Phase::Backing => {}
            Phase::Candle | Phase::Closed => env::panic_str(err::CANDLE_LIT),
            Phase::Scheduled => env::panic_str(err::NOT_BACKING),
        }
        require!((mission as usize) < r.missions.len(), err::NO_MISSION);
        let m = &mut r.missions[mission as usize];
        m.pre_total = U128(m.pre_total.0.checked_sub(amount.0).unwrap_or_else(|| env::panic_str(err::AMOUNT)));
        r.escrow_live = U128(r.escrow_live.0 - amount.0);

        let key = CommitKey { round_id, account_id: who.clone(), mission };
        let mut rec = self.commitments.get(&key).cloned().unwrap_or_else(|| env::panic_str(err::AMOUNT));
        rec.pre = U128(rec.pre.0.checked_sub(amount.0).unwrap_or_else(|| env::panic_str(err::AMOUNT)));
        self.escrow_total -= amount.0;
        self.token.internal_transfer(&env::current_account_id(), &who, amount.0, Some(format!("bonfire:withdraw round {}", round_id)));
        if rec.total() == 0 {
            self.close_record(&key, rec.deposit.0);
        } else {
            self.commitments.insert(key, rec);
        }
        emit("withdraw", json!({ "round_id": round_id, "mission": mission, "account_id": who, "amount": amount }));
    }

    // ------------------------------------------------------------ selection

    /// Anyone, at or after backing close. Draws the candle checkpoint from this block's random
    /// seed (final; never re-drawn), then picks the unique highest counted tally >= threshold.
    /// This is the only place the next round's threshold moves: up after a winner, down when
    /// nothing reached the threshold, unchanged after a tie at or above it.
    pub fn select(&mut self, round_id: u32) {
        let now = env::block_timestamp_ms();
        let seed = env::random_seed_array();
        // Only one round is ever Funded, and a select that fails below reverts this.
        self.funded_round = None;
        let r = self.round_mut(round_id);
        require!(r.status == RoundStatus::Funded, err::WRONG_STATUS);
        require!(phase_of(r, now) == Phase::Closed, err::STILL_BURNING);

        let mut material = seed.to_vec();
        material.extend_from_slice(&round_id.to_le_bytes());
        let h = env::sha256_array(&material);
        let k = (u64::from_le_bytes(h[..8].try_into().unwrap()) % r.checkpoints as u64) as u8;
        r.drawn_checkpoint = Some(k);
        r.selected_at_ms = Some(now);

        let mut best: Option<(u8, u128)> = None;
        let mut tie = false;
        for (i, m) in r.missions.iter().enumerate() {
            let c = m.counted_at(k);
            match best {
                None => best = Some((i as u8, c)),
                Some((_, b)) if c > b => {
                    best = Some((i as u8, c));
                    tie = false;
                }
                Some((_, b)) if c == b => tie = true,
                _ => {}
            }
        }
        let (w, counted) = best.unwrap();
        let threshold = r.threshold.0;
        let budget = r.budget.0;
        // Checked before the tie: a round where nobody reached the threshold, including one
        // with no commitments at all, is below threshold even though its tallies are equal.
        let below = counted < threshold;
        if below || tie {
            r.status = RoundStatus::FailedSelection;
            r.decided_at_ms = Some(now);
            self.release_to_hearth(budget);
            if below {
                self.adjust_next_threshold(self.config.rules.down_bps);
            }
            emit("select", json!({
                "round_id": round_id, "checkpoint": k, "outcome": if below { "below_threshold" } else { "tie" },
                "returned": U128(budget), "next_threshold": U128(self.next_threshold),
            }));
            return;
        }
        let payout = matched_payout(budget, counted, r.target.0);
        r.winner = Some(w);
        r.counted = U128(counted);
        r.payout = U128(payout);
        r.status = RoundStatus::AwaitingWork;
        let remainder = budget - payout;
        self.release_to_hearth(remainder);
        self.adjust_next_threshold(self.config.rules.up_bps);
        emit("select", json!({
            "round_id": round_id, "checkpoint": k, "outcome": "selected", "winner": w,
            "counted": U128(counted), "payout": U128(payout), "returned": U128(remainder),
            "next_threshold": U128(self.next_threshold),
        }));
    }

    // ------------------------------------------------------------ work & review

    /// Winning creator submits the artifact hash (hex sha256) and a retrieval URI, once.
    pub fn submit(&mut self, round_id: u32, hash: String, uri: String) {
        require!(is_hex_hash(&hash), err::BAD_HASH);
        require!(uri.len() <= MAX_URI_LEN, err::BAD_PARAMS);
        let now = env::block_timestamp_ms();
        let who = env::predecessor_account_id();
        let r = self.round_mut(round_id);
        require!(r.status == RoundStatus::AwaitingWork, err::WRONG_STATUS);
        require!(now < r.delivery_deadline_ms, err::DEADLINE_PASSED);
        let w = r.winner.unwrap() as usize;
        require!(who == r.missions[w].creator, err::NOT_CREATOR);
        r.submission = Some(Submission { hash: hash.clone(), uri: uri.clone(), at_ms: now });
        r.status = RoundStatus::AwaitingReview;
        emit("submit", json!({ "round_id": round_id, "creator": who, "hash": hash, "uri": uri }));
    }

    /// Reviewer accepts the exact submitted hash: burns the counted winning escrow and makes
    /// the payout claimable by the creator.
    /// Attach exactly 1 yoctoNEAR, so a limited function-call key can't do it.
    #[payable]
    pub fn accept(&mut self, round_id: u32, hash: String) {
        let now = env::block_timestamp_ms();
        let r = self.round_mut(round_id);
        require!(env::predecessor_account_id() == r.reviewer, err::NOT_REVIEWER);
        near_sdk::assert_one_yocto();
        require!(r.status == RoundStatus::AwaitingReview, err::WRONG_STATUS);
        require!(now < r.review_deadline_ms, err::DEADLINE_PASSED);
        require!(r.submission.as_ref().unwrap().hash == hash, err::HASH_MISMATCH);
        let counted = r.counted.0;
        let payout = r.payout.0;
        r.status = RoundStatus::Accepted;
        r.decided_at_ms = Some(now);
        r.burned = U128(counted);
        r.escrow_live = U128(r.escrow_live.0 - counted);
        r.payout_state = PayoutState::Available;
        let creator = r.missions[r.winner.unwrap() as usize].creator.clone();

        self.burn_from_escrow(counted, round_id);
        self.reserved_total -= payout;
        self.claims_available = self.claims_available.checked_add(payout).expect("overflow");
        emit("accept", json!({
            "round_id": round_id, "hash": hash, "burned": U128(counted),
            "payout": U128(payout), "creator": creator,
        }));
    }

    /// Reviewer rejects before the review deadline. Winning escrow becomes refundable.
    /// Attach exactly 1 yoctoNEAR, so a limited function-call key can't do it.
    #[payable]
    pub fn reject(&mut self, round_id: u32) {
        let now = env::block_timestamp_ms();
        let r = self.round_mut(round_id);
        require!(env::predecessor_account_id() == r.reviewer, err::NOT_REVIEWER);
        near_sdk::assert_one_yocto();
        require!(r.status == RoundStatus::AwaitingReview, err::WRONG_STATUS);
        require!(now < r.review_deadline_ms, err::DEADLINE_PASSED);
        r.status = RoundStatus::Rejected;
        r.decided_at_ms = Some(now);
        let payout = r.payout.0;
        self.release_to_hearth(payout);
        emit("reject", json!({ "round_id": round_id, "returned": U128(payout) }));
    }

    /// Anyone, once a delivery or review deadline has passed without the required action.
    pub fn expire(&mut self, round_id: u32) {
        let now = env::block_timestamp_ms();
        let r = self.round_mut(round_id);
        let next = match r.status {
            RoundStatus::AwaitingWork if now >= r.delivery_deadline_ms => RoundStatus::ExpiredWork,
            RoundStatus::AwaitingReview if now >= r.review_deadline_ms => RoundStatus::ExpiredReview,
            RoundStatus::AwaitingWork | RoundStatus::AwaitingReview => env::panic_str(err::NOT_EXPIRED),
            _ => env::panic_str(err::WRONG_STATUS),
        };
        r.status = next;
        r.decided_at_ms = Some(now);
        let payout = r.payout.0;
        self.release_to_hearth(payout);
        emit("expire", json!({ "round_id": round_id, "status": next, "returned": U128(payout) }));
    }

    // ------------------------------------------------------------ settlement

    /// Permissionless and idempotent. Returns every refundable EMBER of `account_id` in this
    /// round to them, credits Ash for counted escrow of an accepted winner, and releases
    /// storage deposits of closed records. Returns the EMBER refunded.
    pub fn settle(&mut self, round_id: u32, account_id: AccountId) -> U128 {
        let r = self.rounds.get(round_id).unwrap_or_else(|| env::panic_str(err::NO_ROUND)).clone();
        require!(r.status != RoundStatus::Funded, err::NOT_SELECTED);
        let mut refunded: u128 = 0;
        let mut ash_gain: u128 = 0;
        let mut touched = false;

        for mi in 0..r.missions.len() as u8 {
            let key = CommitKey { round_id, account_id: account_id.clone(), mission: mi };
            let Some(rec) = self.commitments.get(&key).cloned() else { continue };
            let is_winner = r.winner == Some(mi);
            let total = rec.total();
            if !is_winner || r.status.is_failed_terminal() {
                refunded += total;
                self.close_record(&key, rec.deposit.0);
                touched = true;
            } else {
                let k = r.drawn_checkpoint.unwrap();
                let counted = rec.counted_at(k);
                let late = total - counted;
                if r.status == RoundStatus::Accepted {
                    refunded += late;
                    ash_gain += counted;
                    self.close_record(&key, rec.deposit.0);
                    touched = true;
                } else if late > 0 {
                    // Awaiting work/review: only the late (uncounted) part is released now.
                    let mut kept = rec.clone();
                    kept.adds.retain(|(c, _)| *c <= k);
                    self.commitments.insert(key, kept);
                    refunded += late;
                    touched = true;
                }
            }
        }
        require!(touched, err::NOTHING_TO_SETTLE);

        if refunded > 0 {
            let rr = self.rounds.get_mut(round_id).unwrap();
            rr.escrow_live = U128(rr.escrow_live.0 - refunded);
            self.escrow_total -= refunded;
            self.token.internal_transfer(&env::current_account_id(), &account_id, refunded, Some(format!("bonfire:refund round {}", round_id)));
        }
        if ash_gain > 0 {
            let prev = self.ash_of(&account_id);
            self.ash.insert(account_id.clone(), U128(prev + ash_gain));
            self.total_ash += ash_gain;
        }
        emit("settle", json!({
            "round_id": round_id, "account_id": account_id,
            "refunded": U128(refunded), "ash": U128(ash_gain),
        }));
        U128(refunded)
    }

    // ------------------------------------------------------------ payout

    /// Pay the accepted creator. Anyone may trigger; funds only go to the creator.
    /// Available -> Pending -> Paid; a failed transfer restores Available.
    pub fn claim_payout(&mut self, round_id: u32) -> Promise {
        let r = self.round_mut(round_id);
        require!(r.status == RoundStatus::Accepted, err::NOT_ACCEPTED);
        require!(r.payout_state == PayoutState::Available, err::WRONG_STATUS);
        r.payout_state = PayoutState::Pending;
        let payout = r.payout.0;
        let creator = r.missions[r.winner.unwrap() as usize].creator.clone();
        self.claims_available -= payout;
        self.claims_pending += payout;
        emit("payout_started", json!({ "round_id": round_id, "creator": creator, "amount": U128(payout) }));
        Promise::new(creator).transfer(NearToken::from_yoctonear(payout)).then(
            Promise::new(env::current_account_id()).function_call(
                "on_payout".to_string(),
                json!({ "round_id": round_id }).to_string().into_bytes(),
                NearToken::from_yoctonear(0),
                PAYOUT_CALLBACK_GAS,
            ),
        )
    }

    #[private]
    pub fn on_payout(&mut self, round_id: u32) -> bool {
        let ok = is_promise_success();
        let r = self.round_mut(round_id);
        require!(r.payout_state == PayoutState::Pending, err::WRONG_STATUS);
        let payout = r.payout.0;
        if ok {
            r.payout_state = PayoutState::Paid;
            self.claims_pending -= payout;
            self.total_paid += payout;
        } else {
            r.payout_state = PayoutState::Available;
            self.claims_pending -= payout;
            self.claims_available += payout;
        }
        emit("payout_result", json!({ "round_id": round_id, "success": ok, "amount": U128(payout) }));
        ok
    }
}

impl Contract {
    pub(crate) fn round_mut(&mut self, round_id: u32) -> &mut Round {
        self.rounds.get_mut(round_id).unwrap_or_else(|| env::panic_str(err::NO_ROUND))
    }

    /// Moves the next round's threshold, within the configured floor and the initial supply.
    pub(crate) fn adjust_next_threshold(&mut self, bps: u32) {
        let floor = self.config.rules.min_threshold.0;
        self.next_threshold = adjust_threshold(self.next_threshold, bps, floor, self.config.initial_supply.0);
    }

    /// Move reserved NEAR back into the Hearth pool.
    pub(crate) fn release_to_hearth(&mut self, amount: u128) {
        if amount == 0 {
            return;
        }
        self.reserved_total = self.reserved_total.checked_sub(amount).expect("reserved underflow");
        self.hearth_pool = self.hearth_pool.checked_add(amount).expect("overflow");
        self.total_recycled = self.total_recycled.checked_add(amount).expect("overflow");
    }

    /// Delete a commitment record, drop it from the account index and return its deposit.
    pub(crate) fn close_record(&mut self, key: &CommitKey, deposit: u128) {
        self.commitments.remove(key);
        if let Some(idx) = self.open_records.get_mut(&key.account_id) {
            idx.retain(|(r, m)| !(*r == key.round_id && *m == key.mission));
            if idx.is_empty() {
                self.open_records.remove(&key.account_id);
            }
        }
        self.deposits_held -= deposit;
        refund(&key.account_id, NearToken::from_yoctonear(deposit));
    }
}
