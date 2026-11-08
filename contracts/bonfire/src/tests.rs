//! Unit tests: lifecycle, candle, matching, failure paths, attack battery, randomized invariants.

use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};

const E: u128 = 1_000_000_000_000_000_000; // 1 EMBER
const N: u128 = 1_000_000_000_000_000_000_000_000; // 1 NEAR
const DAY: u64 = 86_400_000;

// Round timeline (ms): open 1000, candle [2000, 3200) with 12 checkpoints of 100ms.
const OPEN: u64 = 1_000;
const CANDLE: u64 = 2_000;
const CLOSE: u64 = 3_200;
const DELIVERY: u64 = 5_000;
const REVIEW: u64 = 6_000;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn me() -> AccountId {
    acc("bonfire.testnet")
}
fn curator() -> AccountId {
    acc("curator.testnet")
}
fn dist() -> AccountId {
    acc("dist.testnet")
}
fn creator(i: usize) -> AccountId {
    acc(&format!("creator{}.testnet", i))
}
fn user(i: usize) -> AccountId {
    acc(&format!("user{}.testnet", i))
}

thread_local! {
    static CTX: std::cell::Cell<(u64, [u8; 32])> = const { std::cell::Cell::new((0, [7u8; 32])) };
}

fn set(pred: &AccountId, deposit: u128) {
    set_with(pred, deposit, vec![]);
}

fn set_with(pred: &AccountId, deposit: u128, results: Vec<PromiseResult>) {
    let (now, seed) = CTX.with(|c| c.get());
    let ctx = VMContextBuilder::new()
        .current_account_id(me())
        .predecessor_account_id(pred.clone())
        .signer_account_id(pred.clone())
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .block_timestamp(now * 1_000_000)
        .random_seed(seed)
        .account_balance(NearToken::from_near(1_000))
        .build();
    testing_env!(ctx, near_sdk::test_vm_config(), RuntimeFeesConfig::test(), Default::default(), results);
}

fn at(ms: u64) {
    CTX.with(|c| c.set((ms, c.get().1)));
}
fn seed(s: [u8; 32]) {
    CTX.with(|c| c.set((c.get().0, s)));
}

/// Checkpoint `select` will draw for `round_id` with seed `s` and `n` checkpoints.
fn predicted_k(s: [u8; 32], round_id: u32, n: u8) -> u8 {
    let mut m = s.to_vec();
    m.extend_from_slice(&round_id.to_le_bytes());
    let h = env::sha256_array(&m);
    (u64::from_le_bytes(h[..8].try_into().unwrap()) % n as u64) as u8
}

/// Find a seed whose drawn checkpoint satisfies `pred`.
fn seed_where(round_id: u32, n: u8, pred: impl Fn(u8) -> bool) -> [u8; 32] {
    for i in 0..=255u8 {
        let s = [i; 32];
        if pred(predicted_k(s, round_id, n)) {
            return s;
        }
    }
    panic!("no seed found")
}

/// 20% of a 100 NEAR Hearth is a 20 NEAR budget; threshold 10k and target 40k EMBER.
fn rules() -> HearthRules {
    HearthRules {
        budget_bps: 2_000,
        min_budget: U128(N),
        initial_threshold: U128(10_000 * E),
        min_threshold: U128(1_000 * E),
        up_bps: 11_000,
        down_bps: 7_000,
        target_multiple: 4,
    }
}

fn setup() -> Contract {
    at(0);
    seed([7u8; 32]);
    set(&curator(), 0);
    // Fresh chain state for every fixture (storage otherwise carries over within a thread).
    near_sdk::mock::with_mocked_blockchain(|b| {
        b.take_storage();
    });
    set(&curator(), 0);
    let mut c = Contract::new(curator(), dist(), U128(850_000 * E), U128(150_000 * E), U128(1_000 * E), DAY, U128(1_000 * E), rules());
    for i in 0..3 {
        register(&mut c, &creator(i));
    }
    c
}

fn register(c: &mut Contract, a: &AccountId) {
    if !c.token.accounts.contains_key(a) {
        c.token.internal_register_account(a);
    }
}

fn fund(c: &mut Contract, a: &AccountId, amount: u128) {
    register(c, a);
    c.token.internal_transfer(&dist(), a, amount, None);
}

fn bal(c: &Contract, a: &AccountId) -> u128 {
    c.token.accounts.get(a).unwrap_or(0)
}

fn hash(i: u8) -> String {
    format!("{:02x}", i).repeat(32)
}

/// Stoke 100 NEAR, nominate + consent 3 missions and create a round. On a fresh Hearth the
/// rules give it a 20 NEAR budget, threshold 10k and target 40k EMBER. Returns round id.
fn round(c: &mut Contract) -> u32 {
    round_at(c, 0)
}

fn nominate_three(c: &mut Contract) -> Vec<u32> {
    let start = c.nominations.len();
    for i in 0..3 {
        set(&curator(), 0);
        c.nominate(creator(i), format!("Mission {}", i), "ipfs://brief".into(), hash(i as u8));
        set(&creator(i), 0);
        c.consent(start + i as u32);
    }
    (start..start + 3).collect()
}

fn create(c: &mut Contract, nomination_ids: Vec<u32>, offset: u64) -> u32 {
    set(&curator(), 0);
    c.create_round(CreateRoundArgs {
        nomination_ids,
        reviewer: curator(),
        open_at_ms: OPEN + offset,
        candle_start_ms: CANDLE + offset,
        backing_close_ms: CLOSE + offset,
        delivery_deadline_ms: DELIVERY + offset,
        review_deadline_ms: REVIEW + offset,
        checkpoints: 12,
    })
}

/// A round whose whole timeline is shifted later by `offset` milliseconds.
fn round_at(c: &mut Contract, offset: u64) -> u32 {
    set(&curator(), 100 * N);
    c.stoke();
    let ids = nominate_three(c);
    create(c, ids, offset)
}

fn commit(c: &mut Contract, who: &AccountId, r: u32, m: u8, amount: u128) {
    set(who, COMMIT_DEPOSIT.as_yoctonear());
    c.commit(r, m, U128(amount));
}

/// Token, escrow and NEAR-ledger invariants that must hold after every operation.
fn check(c: &Contract, known: &[AccountId]) {
    set(&curator(), 0);
    let a = c.audit();
    assert!(a.supply_ok, "supply invariant");
    assert!(a.escrow_ok, "escrow invariant");
    let mut sum = bal(c, &me()) + bal(c, &dist()) + bal(c, &curator());
    for k in known {
        if k != &me() && k != &dist() && k != &curator() {
            sum += bal(c, k);
        }
    }
    assert_eq!(sum, c.token.total_supply, "sum of balances == supply");
    assert_eq!(
        c.hearth_pool + c.reserved_total + c.claims_available + c.claims_pending + c.total_paid,
        c.total_stoked,
        "NEAR ledger conserves stoked funds"
    );
    let live: u128 = (0..c.rounds.len()).map(|i| c.rounds.get(i).unwrap().escrow_live.0).sum();
    assert_eq!(live, c.escrow_total, "per-round escrow sums to total");
}

fn everyone() -> Vec<AccountId> {
    let mut v: Vec<AccountId> = (0..10).map(user).collect();
    v.extend((0..3).map(creator));
    v
}

// ======================================================================= lifecycle

#[test]
fn genesis_reconciles() {
    let c = setup();
    assert_eq!(c.token.total_supply, 1_000_000 * E);
    assert_eq!(bal(&c, &dist()), 850_000 * E);
    assert_eq!(bal(&c, &me()), 150_000 * E);
    check(&c, &[]);
}

#[test]
fn full_success_path_burns_exactly_counted_and_pays_matched() {
    let mut c = setup();
    let r = round(&mut c);
    fund(&mut c, &user(0), 30_000 * E);
    fund(&mut c, &user(1), 5_000 * E);
    at(OPEN);
    commit(&mut c, &user(0), r, 0, 20_000 * E); // winner
    commit(&mut c, &user(1), r, 1, 5_000 * E); // loser
    check(&c, &everyone());

    at(CLOSE);
    set(&user(5), 0);
    c.select(r);
    let rd = c.rounds.get(r).unwrap().clone();
    assert_eq!(rd.status, RoundStatus::AwaitingWork);
    assert_eq!(rd.winner, Some(0));
    assert_eq!(rd.counted.0, 20_000 * E);
    assert_eq!(rd.payout.0, 10 * N); // 20 NEAR * 20k/40k
    assert_eq!(c.hearth_pool, 90 * N); // 80 left + 10 recycled remainder
    check(&c, &everyone());

    // Loser can reclaim immediately.
    set(&user(1), 0);
    assert_eq!(c.settle(r, user(1)).0, 5_000 * E);
    assert_eq!(bal(&c, &user(1)), 5_000 * E);

    at(4_000);
    set(&creator(0), 0);
    c.submit(r, hash(9), "ipfs://work".into());
    at(5_500);
    set(&curator(), 0);
    let supply_before = c.token.total_supply;
    c.accept(r, hash(9));
    assert_eq!(c.token.total_supply, supply_before - 20_000 * E);
    assert_eq!(c.claims_available, 10 * N);
    check(&c, &everyone());

    set(&user(9), 0);
    c.settle(r, user(0));
    assert_eq!(c.ash_of(&user(0)), 20_000 * E);
    assert_eq!(bal(&c, &user(0)), 10_000 * E);

    set(&user(9), 0);
    let _ = c.claim_payout(r);
    assert_eq!(c.rounds.get(r).unwrap().payout_state, PayoutState::Pending);
    set_with(&me(), 0, vec![PromiseResult::Successful(vec![])]);
    assert!(c.on_payout(r));
    assert_eq!(c.rounds.get(r).unwrap().payout_state, PayoutState::Paid);
    assert_eq!(c.total_paid, 10 * N);
    check(&c, &everyone());
    assert_eq!(c.escrow_total, 0);
}

#[test]
fn payout_capped_at_budget_when_target_exceeded() {
    let mut c = setup();
    let r = round(&mut c);
    fund(&mut c, &user(0), 90_000 * E);
    at(OPEN);
    commit(&mut c, &user(0), r, 2, 90_000 * E);
    at(CLOSE);
    set(&user(0), 0);
    c.select(r);
    assert_eq!(c.rounds.get(r).unwrap().payout.0, 20 * N);
    assert_eq!(c.hearth_pool, 80 * N);
}

#[test]
fn failed_payout_restores_claim_and_can_retry() {
    let mut c = setup();
    let r = round(&mut c);
    fund(&mut c, &user(0), 40_000 * E);
    at(OPEN);
    commit(&mut c, &user(0), r, 0, 40_000 * E);
    at(CLOSE);
    set(&user(0), 0);
    c.select(r);
    set(&creator(0), 0);
    c.submit(r, hash(1), "u".into());
    set(&curator(), 0);
    c.accept(r, hash(1));
    let _ = c.claim_payout(r);
    set_with(&me(), 0, vec![PromiseResult::Failed]);
    assert!(!c.on_payout(r));
    assert_eq!(c.rounds.get(r).unwrap().payout_state, PayoutState::Available);
    assert_eq!(c.claims_available, 20 * N);
    assert_eq!(c.claims_pending, 0);
    check(&c, &everyone());
    set(&user(3), 0);
    let _ = c.claim_payout(r);
    set_with(&me(), 0, vec![PromiseResult::Successful(vec![])]);
    assert!(c.on_payout(r));
    check(&c, &everyone());
}

// ======================================================================= candle

#[test]
fn late_candle_commitment_is_not_counted_and_is_refundable() {
    let mut c = setup();
    let r = round(&mut c);
    // Choose a seed whose drawn checkpoint is before 11, then commit in checkpoint 11.
    let s = seed_where(r, 12, |k| k < 11);
    let k = predicted_k(s, r, 12);
    fund(&mut c, &user(0), 20_000 * E);
    fund(&mut c, &user(1), 50_000 * E);
    at(OPEN);
    commit(&mut c, &user(0), r, 0, 20_000 * E);
    at(CLOSE - 1); // checkpoint 11: sniping attempt
    commit(&mut c, &user(1), r, 1, 50_000 * E);
    assert_eq!(c.get_round(r).unwrap().current_checkpoint, Some(11));

    at(CLOSE);
    seed(s);
    set(&user(2), 0);
    c.select(r);
    let rd = c.rounds.get(r).unwrap().clone();
    assert_eq!(rd.drawn_checkpoint, Some(k));
    assert_eq!(rd.winner, Some(0), "sniper's late bid did not count");
    set(&user(1), 0);
    assert_eq!(c.settle(r, user(1)).0, 50_000 * E);
    check(&c, &everyone());
}

#[test]
fn late_portion_of_winner_refunds_before_acceptance() {
    let mut c = setup();
    let r = round(&mut c);
    let s = seed_where(r, 12, |k| k < 11);
    fund(&mut c, &user(0), 30_000 * E);
    at(OPEN);
    commit(&mut c, &user(0), r, 0, 20_000 * E);
    at(CLOSE - 1);
    set(&user(0), 1);
    c.commit(r, 0, U128(10_000 * E));
    at(CLOSE);
    seed(s);
    set(&user(0), 0);
    c.select(r);
    assert_eq!(c.rounds.get(r).unwrap().counted.0, 20_000 * E);
    assert_eq!(c.settle(r, user(0)).0, 10_000 * E);
    set(&creator(0), 0);
    c.submit(r, hash(2), "u".into());
    set(&curator(), 0);
    c.accept(r, hash(2));
    set(&user(0), 0);
    assert_eq!(c.settle(r, user(0)).0, 0);
    assert_eq!(c.ash_of(&user(0)), 20_000 * E);
    check(&c, &everyone());
}

#[test]
#[should_panic(expected = "ERR_CANDLE_LIT")]
fn withdraw_during_candle_is_refused() {
    let mut c = setup();
    let r = round(&mut c);
    fund(&mut c, &user(0), 20_000 * E);
    at(OPEN);
    commit(&mut c, &user(0), r, 0, 20_000 * E);
    at(CANDLE);
    set(&user(0), 0);
    c.withdraw(r, 0, U128(1));
}

#[test]
fn withdraw_before_candle_returns_tokens_and_deposit() {
    let mut c = setup();
    let r = round(&mut c);
    fund(&mut c, &user(0), 20_000 * E);
    at(OPEN);
    commit(&mut c, &user(0), r, 0, 20_000 * E);
    assert_eq!(c.deposits_held, COMMIT_DEPOSIT.as_yoctonear());
    set(&user(0), 0);
    c.withdraw(r, 0, U128(20_000 * E));
    assert_eq!(bal(&c, &user(0)), 20_000 * E);
    assert_eq!(c.deposits_held, 0);
    assert!(c.get_commitments_of(user(0)).is_empty());
    check(&c, &everyone());
}

// ======================================================================= failures

#[test]
fn tie_fails_selection_and_refunds_everything() {
    let mut c = setup();
    let r = round(&mut c);
    fund(&mut c, &user(0), 15_000 * E);
    fund(&mut c, &user(1), 15_000 * E);
    at(OPEN);
    commit(&mut c, &user(0), r, 0, 15_000 * E);
    commit(&mut c, &user(1), r, 1, 15_000 * E);
    at(CLOSE);
    set(&user(0), 0);
    c.select(r);
    assert_eq!(c.rounds.get(r).unwrap().status, RoundStatus::FailedSelection);
    assert_eq!(c.hearth_pool, 100 * N);
    c.settle(r, user(0));
    c.settle(r, user(1));
    assert_eq!(bal(&c, &user(0)), 15_000 * E);
    assert_eq!(c.escrow_total, 0);
    check(&c, &everyone());
}

#[test]
fn below_threshold_fails_selection() {
    let mut c = setup();
    let r = round(&mut c);
    fund(&mut c, &user(0), 9_999 * E);
    at(OPEN);
    commit(&mut c, &user(0), r, 0, 9_999 * E);
    at(CLOSE);
    set(&user(0), 0);
    c.select(r);
    assert_eq!(c.rounds.get(r).unwrap().status, RoundStatus::FailedSelection);
    assert_eq!(c.settle(r, user(0)).0, 9_999 * E);
}

fn selected_round(c: &mut Contract) -> u32 {
    let r = round(c);
    fund(c, &user(0), 40_000 * E);
    at(OPEN);
    commit(c, &user(0), r, 0, 40_000 * E);
    at(CLOSE);
    set(&user(0), 0);
    c.select(r);
    r
}

#[test]
fn rejection_refunds_winner_and_recycles_budget() {
    let mut c = setup();
    let r = selected_round(&mut c);
    set(&creator(0), 0);
    c.submit(r, hash(3), "u".into());
    set(&curator(), 0);
    c.reject(r);
    assert_eq!(c.hearth_pool, 100 * N);
    set(&user(0), 0);
    assert_eq!(c.settle(r, user(0)).0, 40_000 * E);
    assert_eq!(c.ash_of(&user(0)), 0);
    check(&c, &everyone());
}

#[test]
fn missed_delivery_expires_and_refunds() {
    let mut c = setup();
    let r = selected_round(&mut c);
    at(DELIVERY);
    set(&user(7), 0);
    c.expire(r);
    assert_eq!(c.rounds.get(r).unwrap().status, RoundStatus::ExpiredWork);
    assert_eq!(c.settle(r, user(0)).0, 40_000 * E);
    assert_eq!(c.hearth_pool, 100 * N);
    check(&c, &everyone());
}

#[test]
fn absent_reviewer_expires_and_refunds() {
    let mut c = setup();
    let r = selected_round(&mut c);
    set(&creator(0), 0);
    c.submit(r, hash(3), "u".into());
    at(REVIEW);
    set(&user(7), 0);
    c.expire(r);
    assert_eq!(c.rounds.get(r).unwrap().status, RoundStatus::ExpiredReview);
    assert_eq!(c.settle(r, user(0)).0, 40_000 * E);
    check(&c, &everyone());
}

#[test]
fn cancel_before_open_returns_budget_and_frees_nominations() {
    let mut c = setup();
    let r = round(&mut c);
    set(&curator(), 0);
    c.cancel_round(r);
    assert_eq!(c.hearth_pool, 100 * N);
    assert!(c.nominations.get(0).unwrap().used_in.is_none());
    check(&c, &everyone());
}

// ======================================================================= attack battery

macro_rules! attack {
    ($name:ident, $code:expr, |$c:ident| $body:block) => {
        #[test]
        #[should_panic(expected = $code)]
        fn $name() {
            let mut $c = setup();
            $body
        }
    };
}

attack!(creator_cannot_claim_before_acceptance, "ERR_NOT_ACCEPTED", |c| {
    let r = selected_round(&mut c);
    set(&creator(0), 0);
    let _ = c.claim_payout(r);
});

attack!(non_reviewer_cannot_accept, "ERR_NOT_REVIEWER", |c| {
    let r = selected_round(&mut c);
    set(&creator(0), 0);
    c.submit(r, hash(1), "u".into());
    c.accept(r, hash(1));
});

attack!(reviewer_cannot_accept_different_hash, "ERR_HASH_MISMATCH", |c| {
    let r = selected_round(&mut c);
    set(&creator(0), 0);
    c.submit(r, hash(1), "u".into());
    set(&curator(), 0);
    c.accept(r, hash(2));
});

attack!(reviewer_cannot_accept_after_deadline, "ERR_DEADLINE_PASSED", |c| {
    let r = selected_round(&mut c);
    set(&creator(0), 0);
    c.submit(r, hash(1), "u".into());
    at(REVIEW);
    set(&curator(), 0);
    c.accept(r, hash(1));
});

attack!(losing_creator_cannot_submit, "ERR_NOT_CREATOR", |c| {
    let r = selected_round(&mut c);
    set(&creator(1), 0);
    c.submit(r, hash(1), "u".into());
});

attack!(cannot_submit_after_delivery_deadline, "ERR_DEADLINE_PASSED", |c| {
    let r = selected_round(&mut c);
    at(DELIVERY);
    set(&creator(0), 0);
    c.submit(r, hash(1), "u".into());
});

attack!(cannot_select_before_close, "ERR_STILL_BURNING", |c| {
    let r = round(&mut c);
    at(CLOSE - 1);
    set(&user(0), 0);
    c.select(r);
});

attack!(cannot_select_twice, "ERR_WRONG_STATUS", |c| {
    let r = selected_round(&mut c);
    c.select(r);
});

attack!(cannot_settle_twice, "ERR_NOTHING_TO_SETTLE", |c| {
    let r = selected_round(&mut c);
    set(&curator(), 0);
    c.reject_or_expire_for_test(r);
    c.settle(r, user(0));
    c.settle(r, user(0));
});

attack!(cannot_settle_before_selection, "ERR_NOT_SELECTED", |c| {
    let r = round(&mut c);
    fund(&mut c, &user(0), 10 * E);
    at(OPEN);
    commit(&mut c, &user(0), r, 0, 10 * E);
    c.settle(r, user(0));
});

attack!(non_curator_cannot_create_round, "ERR_NOT_CURATOR", |c| {
    set(&user(0), 0);
    c.create_round(CreateRoundArgs {
        nomination_ids: vec![0, 1, 2],
        reviewer: user(0),
        open_at_ms: 1,
        candle_start_ms: 2,
        backing_close_ms: 3,
        delivery_deadline_ms: 4,
        review_deadline_ms: 5,
        checkpoints: 1,
    });
});

attack!(round_cannot_open_below_minimum_budget, "ERR_HEARTH_TOO_LOW", |c| {
    for i in 0..3 {
        set(&curator(), 0);
        c.nominate(creator(i), "m".into(), "".into(), hash(1));
        set(&creator(i), 0);
        c.consent(i as u32);
    }
    set(&curator(), 0);
    c.create_round(CreateRoundArgs {
        nomination_ids: vec![0, 1, 2],
        reviewer: curator(),
        open_at_ms: 1,
        candle_start_ms: 2,
        backing_close_ms: 3,
        delivery_deadline_ms: 4,
        review_deadline_ms: 5,
        checkpoints: 1,
    });
});

attack!(unconsented_nomination_cannot_enter_round, "ERR_NOT_CONSENTED", |c| {
    set(&curator(), 10 * N);
    c.stoke();
    for i in 0..3 {
        set(&curator(), 0);
        c.nominate(creator(i), "m".into(), "".into(), hash(1));
    }
    c.create_round(CreateRoundArgs {
        nomination_ids: vec![0, 1, 2],
        reviewer: curator(),
        open_at_ms: 1,
        candle_start_ms: 2,
        backing_close_ms: 3,
        delivery_deadline_ms: 4,
        review_deadline_ms: 5,
        checkpoints: 1,
    });
});

attack!(nominating_without_ash_is_refused, "ERR_INSUFFICIENT_ASH", |c| {
    set(&user(0), 0);
    c.nominate(creator(0), "m".into(), "".into(), hash(1));
});

attack!(cannot_cancel_after_open, "ERR_WRONG_STATUS", |c| {
    let r = round(&mut c);
    at(OPEN);
    set(&curator(), 0);
    c.cancel_round(r);
});

attack!(cannot_commit_after_close, "ERR_NOT_BACKING", |c| {
    let r = round(&mut c);
    fund(&mut c, &user(0), 10 * E);
    at(CLOSE);
    commit(&mut c, &user(0), r, 0, 10 * E);
});

attack!(new_commitment_requires_storage_deposit, "ERR_DEPOSIT", |c| {
    let r = round(&mut c);
    fund(&mut c, &user(0), 10 * E);
    at(OPEN);
    set(&user(0), 1);
    c.commit(r, 0, U128(10 * E));
});

attack!(cannot_commit_more_than_balance, "The account doesn't have enough balance", |c| {
    let r = round(&mut c);
    fund(&mut c, &user(0), 10 * E);
    at(OPEN);
    commit(&mut c, &user(0), r, 0, 11 * E);
});

attack!(tokens_cannot_be_sent_to_contract, "ERR_NO_TRANSFER_TO_CONTRACT", |c| {
    set(&dist(), 1);
    c.ft_transfer(me(), U128(1), None);
});

attack!(cannot_unregister_with_open_commitments, "ERR_UNREGISTER_BLOCKED", |c| {
    let r = round(&mut c);
    fund(&mut c, &user(0), 10 * E);
    at(OPEN);
    commit(&mut c, &user(0), r, 0, 10 * E);
    set(&user(0), 1);
    c.storage_unregister(None);
});

attack!(force_unregister_is_disabled, "ERR_UNREGISTER_BLOCKED", |c| {
    set(&dist(), 1);
    c.storage_unregister(Some(true));
});

// `#[private]` on on_payout is enforced by the wasm entry point; covered by sandbox tests.

attack!(faucet_cooldown_enforced, "ERR_FAUCET_COOLDOWN", |c| {
    register(&mut c, &user(0));
    set(&user(0), 0);
    c.faucet();
    at(DAY - 1);
    set(&user(0), 0);
    c.faucet();
});

// ======================================================================= ash & faucet

#[test]
fn ash_grants_nomination_right() {
    let mut c = setup();
    let r = selected_round(&mut c);
    set(&creator(0), 0);
    c.submit(r, hash(1), "u".into());
    set(&curator(), 0);
    c.accept(r, hash(1));
    c.settle(r, user(0));
    assert_eq!(c.ash_of(&user(0)), 40_000 * E);
    assert_eq!(c.total_ash, 40_000 * E);
    set(&user(0), 0);
    let id = c.nominate(creator(2), "Fan pick".into(), "".into(), hash(5));
    assert_eq!(c.get_nomination(id).unwrap().nominator, user(0));
}

#[test]
fn faucet_registers_and_respects_interval() {
    let mut c = setup();
    let min = c.token.storage_balance_bounds().min.as_yoctonear();
    set(&user(4), min);
    assert_eq!(c.faucet().0, 1_000 * E);
    assert_eq!(bal(&c, &user(4)), 1_000 * E);
    at(DAY);
    set(&user(4), 0);
    c.faucet();
    assert_eq!(bal(&c, &user(4)), 2_000 * E);
    assert_eq!(c.faucet_remaining, 148_000 * E);
    check(&c, &everyone());
}

// ======================================================================= rule-based Hearth

/// Start of a later round's timeline, after the first round has closed.
const LATER: u64 = 10_000;

/// user(8) backs mission 0 with `amount` (none if zero), then `select` runs at close.
fn back_and_select(c: &mut Contract, r: u32, offset: u64, amount: u128) {
    if amount > 0 {
        fund(c, &user(8), amount);
        at(OPEN + offset);
        commit(c, &user(8), r, 0, amount);
    }
    at(CLOSE + offset);
    set(&user(9), 0);
    c.select(r);
}

fn round_of(c: &Contract, r: u32) -> Round {
    c.rounds.get(r).unwrap().clone()
}

#[test]
fn budget_is_a_share_of_the_pool_at_creation() {
    let mut c = setup();
    let r = round(&mut c);
    let rd = round_of(&c, r);
    assert_eq!(rd.budget.0, 20 * N);
    assert_eq!(rd.threshold.0, 10_000 * E);
    assert_eq!(rd.target.0, 40_000 * E);
    assert_eq!(c.hearth_pool, 80 * N);
    let r2 = round(&mut c); // 80 + 100 stoked
    assert_eq!(round_of(&c, r2).budget.0, 36 * N);
    check(&c, &everyone());
}

#[test]
fn smallest_funded_pool_opens_a_round() {
    let mut c = setup();
    set(&curator(), 5 * N);
    c.stoke();
    let ids = nominate_three(&mut c);
    let r = create(&mut c, ids, 0);
    assert_eq!(round_of(&c, r).budget.0, N);
}

attack!(pool_just_below_minimum_cannot_open_a_round, "ERR_HEARTH_TOO_LOW", |c| {
    set(&curator(), 5 * N - 1);
    c.stoke();
    let ids = nominate_three(&mut c);
    create(&mut c, ids, 0);
});

#[test]
fn next_round_terms_match_what_create_round_computes() {
    let mut c = setup();
    set(&curator(), 0);
    assert!(!c.get_next_round_terms().funded);
    set(&curator(), 100 * N);
    c.stoke();
    let terms = c.get_next_round_terms();
    assert!(terms.funded);
    let ids = nominate_three(&mut c);
    let r = create(&mut c, ids, 0);
    let rd = round_of(&c, r);
    assert_eq!((terms.budget.0, terms.threshold.0, terms.target.0), (rd.budget.0, rd.threshold.0, rd.target.0));
}

#[test]
fn a_winner_raises_the_next_threshold_and_target() {
    let mut c = setup();
    let r = round(&mut c);
    back_and_select(&mut c, r, 0, 20_000 * E);
    assert_eq!(round_of(&c, r).status, RoundStatus::AwaitingWork);
    assert_eq!(c.next_threshold, 11_000 * E);
    assert_eq!(round_of(&c, r).threshold.0, 10_000 * E, "the existing round never changes");
    let r2 = round_at(&mut c, LATER);
    assert_eq!(round_of(&c, r2).threshold.0, 11_000 * E);
    assert_eq!(round_of(&c, r2).target.0, 44_000 * E);
}

#[test]
fn nothing_reaching_threshold_lowers_it() {
    let mut c = setup();
    let r = round(&mut c);
    back_and_select(&mut c, r, 0, 9_999 * E);
    assert_eq!(round_of(&c, r).status, RoundStatus::FailedSelection);
    assert_eq!(c.next_threshold, 7_000 * E);
    let r2 = round_at(&mut c, LATER);
    assert_eq!(round_of(&c, r2).threshold.0, 7_000 * E);
}

#[test]
fn a_round_with_no_commitments_lowers_the_threshold() {
    let mut c = setup();
    let r = round(&mut c);
    back_and_select(&mut c, r, 0, 0);
    assert_eq!(round_of(&c, r).status, RoundStatus::FailedSelection);
    assert_eq!(c.next_threshold, 7_000 * E);
    check(&c, &everyone());
}

#[test]
fn a_tie_at_or_above_threshold_leaves_it_alone() {
    let mut c = setup();
    let r = round(&mut c);
    fund(&mut c, &user(0), 15_000 * E);
    fund(&mut c, &user(1), 15_000 * E);
    at(OPEN);
    commit(&mut c, &user(0), r, 0, 15_000 * E);
    commit(&mut c, &user(1), r, 1, 15_000 * E);
    at(CLOSE);
    set(&user(2), 0);
    c.select(r);
    assert_eq!(round_of(&c, r).status, RoundStatus::FailedSelection);
    assert_eq!(c.next_threshold, 10_000 * E);
}

#[test]
fn threshold_never_falls_below_the_floor() {
    let mut c = setup();
    c.next_threshold = 1_200 * E;
    let r = round(&mut c);
    back_and_select(&mut c, r, 0, 0);
    assert_eq!(c.next_threshold, 1_000 * E);
}

#[test]
fn threshold_stays_within_floor_and_ceiling() {
    use crate::math::adjust_threshold;
    assert_eq!(adjust_threshold(1_000, 11_000, 100, 10_000), 1_100);
    assert_eq!(adjust_threshold(1_000, 7_000, 100, 10_000), 700);
    assert_eq!(adjust_threshold(120, 7_000, 100, 10_000), 100);
    assert_eq!(adjust_threshold(9_500, 11_000, 100, 10_000), 10_000);
}

#[test]
fn rejected_or_expired_work_does_not_move_the_threshold() {
    let mut c = setup();
    let r = selected_round(&mut c);
    assert_eq!(c.next_threshold, 11_000 * E);
    set(&creator(0), 0);
    c.submit(r, hash(3), "u".into());
    set(&curator(), 0);
    c.reject(r);
    assert_eq!(c.next_threshold, 11_000 * E);

    let mut c = setup();
    let r = selected_round(&mut c);
    at(DELIVERY);
    set(&user(7), 0);
    c.expire(r);
    assert_eq!(c.next_threshold, 11_000 * E);
}

#[test]
fn overlapping_rounds_each_move_the_threshold_once() {
    let mut c = setup();
    let a = round(&mut c);
    let b = round(&mut c);
    assert_eq!(round_of(&c, b).threshold.0, 10_000 * E, "created before any select");
    fund(&mut c, &user(0), 20_000 * E);
    at(OPEN);
    commit(&mut c, &user(0), a, 0, 20_000 * E);
    at(CLOSE);
    set(&user(9), 0);
    c.select(a);
    assert_eq!(c.next_threshold, 11_000 * E);
    c.select(b);
    assert_eq!(c.next_threshold, 7_700 * E);
    assert_eq!(round_of(&c, a).threshold.0, 10_000 * E);
    assert_eq!(round_of(&c, b).threshold.0, 10_000 * E);
    let later = round_at(&mut c, LATER);
    assert_eq!(round_of(&c, later).threshold.0, 7_700 * E);
    check(&c, &everyone());
}

#[test]
fn invalid_rules_are_refused() {
    let supply = 1_000_000 * E;
    assert!(rules().is_valid(supply));
    let cases: [fn(&mut HearthRules); 10] = [
        |r| r.budget_bps = 0,
        |r| r.budget_bps = 10_001,
        |r| r.min_budget = U128(0),
        |r| r.min_threshold = U128(0),
        |r| r.min_threshold = U128(10_001 * E),
        |r| r.initial_threshold = U128(1_000_001 * E),
        |r| r.up_bps = 9_999,
        |r| r.down_bps = 0,
        |r| r.down_bps = 10_001,
        |r| r.target_multiple = 0,
    ];
    for (i, breaks) in cases.iter().enumerate() {
        let mut bad = rules();
        breaks(&mut bad);
        assert!(!bad.is_valid(supply), "case {i}");
    }
    let mut overflowing = rules();
    overflowing.up_bps = u32::MAX;
    assert!(!overflowing.is_valid(u128::MAX / 2));
}

attack!(new_refuses_invalid_rules, "ERR_BAD_PARAMS", |c| {
    let _ = c.get_round_count();
    let mut bad = rules();
    bad.up_bps = 1;
    Contract::new(curator(), dist(), U128(E), U128(E), U128(E), DAY, U128(E), bad);
});

#[test]
fn round_args_refuse_budget_threshold_and_target() {
    let base = near_sdk::serde_json::json!({
        "nomination_ids": [0, 1, 2], "reviewer": "a.testnet", "open_at_ms": 1, "candle_start_ms": 2,
        "backing_close_ms": 3, "delivery_deadline_ms": 4, "review_deadline_ms": 5, "checkpoints": 1,
    });
    assert!(near_sdk::serde_json::from_value::<CreateRoundArgs>(base.clone()).is_ok());
    for field in ["budget", "threshold", "target"] {
        let mut args = base.clone();
        args[field] = "1".into();
        assert!(near_sdk::serde_json::from_value::<CreateRoundArgs>(args).is_err(), "{field}");
    }
}

#[test]
fn first_spark_records_the_first_backer_only() {
    let mut c = setup();
    let r = round(&mut c);
    assert!(round_of(&c, r).first_spark.is_none());
    fund(&mut c, &user(0), 100 * E);
    fund(&mut c, &user(1), 100 * E);
    at(OPEN);
    commit(&mut c, &user(0), r, 0, 10 * E);
    commit(&mut c, &user(1), r, 1, 50 * E);
    assert_eq!(round_of(&c, r).first_spark, Some(user(0)));
    set(&user(0), 0);
    c.withdraw(r, 0, U128(10 * E));
    assert_eq!(round_of(&c, r).first_spark, Some(user(0)), "the record stands");
    assert_eq!(c.ash_of(&user(0)), 0, "it carries no Ash");
}

// ======================================================================= shared fixtures

/// The same file is checked against the TypeScript rules in packages/simulator.
#[test]
fn math_matches_the_shared_fixtures() {
    use crate::math::{adjust_threshold, checkpoint_index, matched_payout, round_budget};
    use near_sdk::serde_json::{from_str, Value};
    let fixtures: Value = from_str(include_str!("../../../packages/protocol/fixtures/math.json")).unwrap();
    let big = |v: &Value| v.as_str().unwrap().parse::<u128>().unwrap();
    let small = |v: &Value| v.as_u64().unwrap();
    let cases = |name: &str| fixtures[name].as_array().unwrap().clone();
    for c in cases("matched_payout") {
        assert_eq!(matched_payout(big(&c["budget"]), big(&c["counted"]), big(&c["target"])), big(&c["expected"]), "{c}");
    }
    for c in cases("round_budget") {
        assert_eq!(round_budget(big(&c["pool"]), small(&c["bps"]) as u32), big(&c["expected"]), "{c}");
    }
    for c in cases("adjust_threshold") {
        assert_eq!(adjust_threshold(big(&c["current"]), small(&c["bps"]) as u32, big(&c["floor"]), big(&c["ceiling"])), big(&c["expected"]), "{c}");
    }
    for c in cases("checkpoint_index") {
        assert_eq!(
            checkpoint_index(small(&c["now"]), small(&c["candle_start"]), small(&c["close"]), small(&c["checkpoints"]) as u8) as u64,
            small(&c["expected"]),
            "{c}"
        );
    }
}

// ======================================================================= randomized

/// xorshift64 — deterministic pseudo-random operation sequences.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

#[test]
fn randomized_rounds_conserve_tokens_and_near() {
    for run in 1..=20u64 {
        let mut c = setup();
        let mut rng = Rng(run.wrapping_mul(0x9E37_79B9_7F4A_7C15));
        let r = round(&mut c);
        let users: Vec<AccountId> = (0..6).map(user).collect();
        for u in &users {
            fund(&mut c, u, 20_000 * E);
        }
        // Random commits/withdrawals across the whole backing window.
        let mut t = OPEN;
        while t < CLOSE {
            at(t);
            let u = &users[rng.below(6) as usize];
            let m = rng.below(3) as u8;
            let free = bal(&c, u);
            if rng.below(4) == 0 && t < CANDLE {
                let key = CommitKey { round_id: r, account_id: u.clone(), mission: m };
                if let Some(rec) = c.commitments.get(&key).cloned() {
                    if rec.pre.0 > 0 {
                        let amt = 1 + rng.below((rec.pre.0 / E) as u64) as u128 * E;
                        let amt = amt.min(rec.pre.0);
                        set(u, 0);
                        c.withdraw(r, m, U128(amt));
                    }
                }
            } else if free >= E {
                let amt = (1 + rng.below((free / E).min(8_000) as u64) as u128) * E;
                commit(&mut c, u, r, m, amt.min(free));
            }
            check(&c, &everyone());
            t += 1 + rng.below(60);
        }
        at(CLOSE);
        seed([(run % 251) as u8; 32]);
        set(&users[0], 0);
        c.select(r);
        let status = c.rounds.get(r).unwrap().status;
        assert!([7_000 * E, 10_000 * E, 11_000 * E].contains(&c.next_threshold), "run {run}: threshold moved once by rule");
        if status == RoundStatus::AwaitingWork {
            let w = c.rounds.get(r).unwrap().winner.unwrap() as usize;
            set(&creator(w), 0);
            c.submit(r, hash(1), "u".into());
            set(&curator(), 0);
            if rng.below(3) == 0 {
                c.reject(r);
            } else {
                c.accept(r, hash(1));
            }
        }
        check(&c, &everyone());
        for u in &users {
            let key_exists = (0..3u8).any(|m| c.commitments.contains_key(&CommitKey { round_id: r, account_id: u.clone(), mission: m }));
            if key_exists {
                set(u, 0);
                c.settle(r, u.clone());
            }
        }
        check(&c, &everyone());
        let rd = c.rounds.get(r).unwrap().clone();
        assert_eq!(c.escrow_total, 0, "run {run}: all escrow settled");
        assert_eq!(c.deposits_held, 0, "run {run}: all deposits returned");
        let held: u128 = users.iter().map(|u| bal(&c, u)).sum();
        assert_eq!(held + rd.burned.0, 6 * 20_000 * E, "run {run}: tokens returned or burned, never both");
        if rd.status == RoundStatus::Accepted {
            assert_eq!(c.total_ash, rd.burned.0, "run {run}: ash equals burn");
            assert_eq!(rd.burned.0, rd.counted.0);
        } else {
            assert_eq!(rd.burned.0, 0);
            assert_eq!(c.total_ash, 0);
        }
    }
}

impl Contract {
    fn reject_or_expire_for_test(&mut self, r: u32) {
        at(DELIVERY);
        set(&curator(), 0);
        self.expire(r);
    }
}
