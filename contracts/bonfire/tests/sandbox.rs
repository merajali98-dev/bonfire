//! Integration tests against a real local NEAR node (near-workspaces sandbox).
//!
//! These cover what unit tests cannot: `#[private]` enforcement in wasm, real payout
//! transfers and failed-transfer callbacks, NEP-145 flows, and measured gas and storage.
//!
//! Build the wasm first (`cargo near build non-reproducible-wasm --no-abi`), then run
//! `cargo test --test sandbox -- --nocapture --test-threads=1`. Lines starting with
//! METRIC are the measurements. The sandbox binary only exists for Linux and macOS.
#![cfg(not(windows))]

use anyhow::{bail, Result};
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde_json::{json, Value};

const EMBER: u128 = 1_000_000_000_000_000_000;
const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const COMMIT_DEPOSIT: u128 = NEAR / 100;
const STORAGE_BYTE_COST: u128 = NEAR / 100_000;
const MAX_ACCOUNT_LEN: usize = 64;
const FAUCET_INTERVAL_MS: u64 = 300_000;
const CHECKPOINT_MS: u64 = 120_000;
const WORK_HASH: &str = "abababababababababababababababababababababababababababababababab";

fn yocto(amount: u128) -> NearToken {
    NearToken::from_yoctonear(amount)
}

fn u(value: &Value) -> u128 {
    value.as_str().unwrap_or_else(|| panic!("not a U128 string: {value}")).parse().unwrap()
}

fn metric(name: &str, value: impl std::fmt::Display) {
    println!("METRIC {name}: {value}");
}

fn tgas(gas: Gas) -> f64 {
    gas.as_gas() as f64 / 1e12
}

fn assert_fails(res: &ExecutionFinalResult, needle: &str) {
    let text = format!("{res:?}");
    assert!(res.is_failure(), "expected failure containing {needle}, got success: {text}");
    assert!(text.contains(needle), "expected {needle} in: {text}");
}

fn wasm() -> Result<Vec<u8>> {
    let path = std::env::var("BONFIRE_WASM")
        .unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/target/near/bonfire.wasm").to_string());
    std::fs::read(&path).map_err(|e| anyhow::anyhow!("cannot read {path}: {e}. Build the wasm first."))
}

struct Times {
    open: u64,
    candle: u64,
    close: u64,
}

struct Fx {
    worker: Worker<Sandbox>,
    root: Account,
    contract: Contract,
    curator: Account,
    dist: Account,
    reviewer: Account,
}

impl Fx {
    async fn new() -> Result<Self> {
        let worker = near_workspaces::sandbox().await?;
        let root = worker.root_account()?;
        let host = root.create_subaccount("bonfire").initial_balance(NearToken::from_near(30)).transact().await?.unwrap();
        let contract = host.deploy(&wasm()?).await?.unwrap();
        let curator = make_account(&root, "curator", 20).await?;
        let dist = make_account(&root, "dist", 100).await?;
        let reviewer = make_account(&root, "reviewer", 20).await?;
        let genesis = contract
            .call("new")
            .args_json(json!({
                "curator": curator.id(),
                "distribution_account": dist.id(),
                "distribution_amount": (850_000 * EMBER).to_string(),
                "faucet_pool": (150_000 * EMBER).to_string(),
                "faucet_amount": (1_000 * EMBER).to_string(),
                "faucet_interval_ms": FAUCET_INTERVAL_MS,
                "nominate_min_ash": (1_000 * EMBER).to_string(),
            }))
            .max_gas()
            .transact()
            .await?;
        assert!(genesis.is_success(), "new failed: {genesis:?}");
        Ok(Self { worker, root, contract, curator, dist, reviewer })
    }

    fn id(&self) -> &AccountId {
        self.contract.id()
    }

    async fn account(&self, name: &str, near: u128) -> Result<Account> {
        make_account(&self.root, name, near).await
    }

    /// An account whose ID is exactly the maximum length, for worst-case storage.
    async fn long_account(&self, tag: &str, near: u128) -> Result<Account> {
        let room = MAX_ACCOUNT_LEN - self.root.id().as_str().len() - 1;
        let name = format!("{tag}{}", "x".repeat(room - tag.len()));
        self.account(&name, near).await
    }

    async fn call(&self, who: &Account, method: &str, args: Value, deposit: u128) -> Result<ExecutionFinalResult> {
        Ok(who.call(self.id(), method).args_json(args).deposit(yocto(deposit)).max_gas().transact().await?)
    }

    async fn ok(&self, who: &Account, method: &str, args: Value, deposit: u128) -> Result<ExecutionFinalResult> {
        let res = self.call(who, method, args, deposit).await?;
        assert!(res.is_success(), "{method} failed: {res:?}");
        Ok(res)
    }

    async fn view(&self, method: &str, args: Value) -> Result<Value> {
        Ok(self.contract.view(method).args_json(args).await?.json::<Value>()?)
    }

    async fn audit(&self) -> Result<Value> {
        self.view("audit", json!({})).await
    }

    async fn round(&self, round_id: u32) -> Result<Value> {
        self.view("get_round", json!({ "round_id": round_id })).await
    }

    async fn ft_balance(&self, id: &AccountId) -> Result<u128> {
        Ok(u(&self.view("ft_balance_of", json!({ "account_id": id })).await?))
    }

    async fn storage_usage(&self) -> Result<u64> {
        Ok(self.contract.view_account().await?.storage_usage)
    }

    async fn near_balance(&self, who: &AccountId) -> Result<u128> {
        Ok(self.worker.view_account(who).await?.balance.as_yoctonear())
    }

    async fn now_ms(&self) -> Result<u64> {
        Ok(self.worker.view_block().await?.timestamp() / 1_000_000)
    }

    /// Move chain time to at least `target_ms`, undershooting each jump so windows are not skipped.
    async fn advance_to(&self, target_ms: u64) -> Result<()> {
        for _ in 0..400 {
            let now = self.now_ms().await?;
            if now >= target_ms {
                return Ok(());
            }
            self.worker.fast_forward(((target_ms - now) / 2_000).max(1)).await?;
        }
        bail!("chain time never reached {target_ms}")
    }

    /// Let refund and callback receipts land before balances are read.
    async fn settle_receipts(&self) -> Result<()> {
        Ok(self.worker.fast_forward(4).await?)
    }

    async fn fund(&self, who: &Account, amount: u128) -> Result<()> {
        self.ok(who, "storage_deposit", json!({ "registration_only": true }), NEAR / 100).await?;
        self.ok(&self.dist, "ft_transfer", json!({ "receiver_id": who.id(), "amount": amount.to_string() }), 1).await?;
        Ok(())
    }

    /// Stoke, nominate and consent to one maximum-size mission per creator, then create the round.
    async fn open_round(&self, creators: &[&Account], budget: u128, threshold: u128, target: u128, checkpoints: u8) -> Result<(u32, Times)> {
        self.ok(&self.dist, "stoke", json!({}), budget).await?;
        let mut nomination_ids = Vec::new();
        for (i, creator) in creators.iter().enumerate() {
            let title = format!("{i}{}", "t".repeat(79));
            let brief_uri = format!("https://example.test/{}", "u".repeat(235));
            let args = json!({ "creator": creator.id(), "title": title, "brief_uri": brief_uri, "brief_hash": WORK_HASH });
            let id = self.ok(&self.curator, "nominate", args, 0).await?.json::<u32>()?;
            self.ok(creator, "consent", json!({ "nomination_id": id }), 0).await?;
            nomination_ids.push(id);
        }
        let now = self.now_ms().await?;
        let open = now + 20_000;
        let candle = open + 60_000;
        let close = candle + CHECKPOINT_MS * checkpoints as u64;
        let delivery = close + 3_600_000;
        let review = delivery + 3_600_000;
        let args = json!({ "args": {
            "nomination_ids": nomination_ids,
            "reviewer": self.reviewer.id(),
            "budget": budget.to_string(),
            "threshold": threshold.to_string(),
            "target": target.to_string(),
            "open_at_ms": open,
            "candle_start_ms": candle,
            "backing_close_ms": close,
            "delivery_deadline_ms": delivery,
            "review_deadline_ms": review,
            "checkpoints": checkpoints,
        }});
        let round_id = self.ok(&self.curator, "create_round", args, 0).await?.json::<u32>()?;
        Ok((round_id, Times { open, candle, close }))
    }

    async fn commit(&self, who: &Account, round_id: u32, mission: u8, amount: u128, deposit: u128) -> Result<ExecutionFinalResult> {
        self.ok(who, "commit", json!({ "round_id": round_id, "mission": mission, "amount": amount.to_string() }), deposit).await
    }

    /// Runs a round through acceptance: 10,000 EMBER on mission 0 against a 40,000 target,
    /// so the payout is 5 NEAR of a 20 NEAR budget. A second backer loses on mission 1.
    async fn accepted_round(&self, creator: &Account) -> Result<(u32, u128, Account, Account)> {
        let other_a = self.account("othera", 5).await?;
        let other_b = self.account("otherb", 5).await?;
        let (round_id, t) = self.open_round(&[creator, &other_a, &other_b], 20 * NEAR, 1_000 * EMBER, 40_000 * EMBER, 1).await?;
        let winner = self.account("backer", 5).await?;
        let loser = self.account("loser", 5).await?;
        self.fund(&winner, 10_000 * EMBER).await?;
        self.fund(&loser, 2_000 * EMBER).await?;
        self.advance_to(t.open).await?;
        self.commit(&winner, round_id, 0, 10_000 * EMBER, COMMIT_DEPOSIT).await?;
        self.commit(&loser, round_id, 1, 2_000 * EMBER, COMMIT_DEPOSIT).await?;
        self.advance_to(t.close).await?;
        self.ok(&self.dist, "select", json!({ "round_id": round_id }), 0).await?;
        self.ok(creator, "submit", json!({ "round_id": round_id, "hash": WORK_HASH, "uri": "https://example.test/work" }), 0).await?;
        self.ok(&self.reviewer, "accept", json!({ "round_id": round_id, "hash": WORK_HASH }), 0).await?;
        let round = self.round(round_id).await?;
        assert_eq!(round["round"]["status"], "Accepted");
        assert_eq!(round["round"]["payout_state"], "Available");
        assert_eq!(u(&round["round"]["burned"]), 10_000 * EMBER);
        let payout = u(&round["round"]["payout"]);
        assert_eq!(payout, 5 * NEAR);
        Ok((round_id, payout, winner, loser))
    }
}

async fn make_account(root: &Account, name: &str, near: u128) -> Result<Account> {
    Ok(root.create_subaccount(name).initial_balance(yocto(near * NEAR)).transact().await?.unwrap())
}

fn assert_reconciled(audit: &Value) {
    assert_eq!(audit["supply_ok"], true, "supply: {audit}");
    assert_eq!(audit["escrow_ok"], true, "escrow: {audit}");
    assert_eq!(audit["near_ok"], true, "near: {audit}");
}

#[tokio::test]
async fn private_callbacks_reject_outside_callers() -> Result<()> {
    let fx = Fx::new().await?;
    let creator = fx.account("creator", 5).await?;
    let (round_id, payout, _, _) = fx.accepted_round(&creator).await?;

    // The state check inside on_payout would also refuse here, so the error text is what
    // proves the #[private] gate fired first.
    for attacker in [&creator, &fx.curator, &fx.reviewer] {
        let res = fx.call(attacker, "on_payout", json!({ "round_id": round_id }), 0).await?;
        assert_fails(&res, "Method on_payout is private");
    }
    let args = json!({ "sender_id": fx.dist.id(), "receiver_id": creator.id(), "amount": "1" });
    let res = fx.call(&creator, "ft_resolve_transfer", args, 0).await?;
    assert_fails(&res, "Method ft_resolve_transfer is private");

    let round = fx.round(round_id).await?;
    assert_eq!(round["round"]["payout_state"], "Available");
    let audit = fx.audit().await?;
    assert_eq!(u(&audit["claims_available"]), payout);
    assert_eq!(u(&audit["total_paid"]), 0);
    assert_reconciled(&audit);
    Ok(())
}

#[tokio::test]
async fn payout_transfer_pays_creator_exactly_once() -> Result<()> {
    let fx = Fx::new().await?;
    let creator = fx.account("creator", 5).await?;
    let (round_id, payout, winner, loser) = fx.accepted_round(&creator).await?;
    let stranger = fx.account("stranger", 5).await?;
    fx.settle_receipts().await?;

    let before = fx.near_balance(creator.id()).await?;
    let res = fx.ok(&stranger, "claim_payout", json!({ "round_id": round_id }), 0).await?;
    assert!(res.json::<bool>()?, "callback should report success");
    fx.settle_receipts().await?;
    assert_eq!(fx.near_balance(creator.id()).await? - before, payout);

    let round = fx.round(round_id).await?;
    assert_eq!(round["round"]["payout_state"], "Paid");
    let again = fx.call(&stranger, "claim_payout", json!({ "round_id": round_id }), 0).await?;
    assert_fails(&again, "ERR_WRONG_STATUS");
    assert_eq!(fx.near_balance(creator.id()).await? - before, payout);

    fx.ok(&stranger, "settle", json!({ "round_id": round_id, "account_id": winner.id() }), 0).await?;
    fx.ok(&stranger, "settle", json!({ "round_id": round_id, "account_id": loser.id() }), 0).await?;
    assert_eq!(u(&fx.view("get_ash", json!({ "account_id": winner.id() })).await?), 10_000 * EMBER);
    assert_eq!(fx.ft_balance(loser.id()).await?, 2_000 * EMBER);
    assert_eq!(fx.ft_balance(winner.id()).await?, 0);

    let audit = fx.audit().await?;
    assert_eq!(u(&audit["total_paid"]), payout);
    assert_eq!(u(&audit["claims_available"]), 0);
    assert_eq!(u(&audit["claims_pending"]), 0);
    assert_eq!(u(&audit["reserved_total"]), 0);
    assert_eq!(u(&audit["hearth_pool"]), 15 * NEAR);
    assert_eq!(u(&audit["total_burned"]), 10_000 * EMBER);
    assert_eq!(u(&audit["escrow_total"]), 0);
    assert_eq!(u(&audit["deposits_held"]), 0);
    assert_reconciled(&audit);
    Ok(())
}

#[tokio::test]
async fn payout_to_deleted_account_restores_available_and_can_retry() -> Result<()> {
    let fx = Fx::new().await?;
    let creator = fx.account("creator", 5).await?;
    let creator_id = creator.id().clone();
    let (round_id, payout, _, _) = fx.accepted_round(&creator).await?;
    let stranger = fx.account("stranger", 5).await?;

    let deleted = creator.delete_account(fx.root.id()).await?;
    assert!(deleted.is_success(), "delete failed: {deleted:?}");
    fx.settle_receipts().await?;
    assert!(fx.worker.view_account(&creator_id).await.is_err(), "creator should be gone");
    let contract_before = fx.near_balance(fx.id()).await?;

    let res = fx.ok(&stranger, "claim_payout", json!({ "round_id": round_id }), 0).await?;
    assert!(!res.receipt_failures().is_empty(), "the transfer receipt should fail");
    assert!(!res.json::<bool>()?, "callback should report failure");
    fx.settle_receipts().await?;

    let round = fx.round(round_id).await?;
    assert_eq!(round["round"]["payout_state"], "Available");
    let audit = fx.audit().await?;
    assert_eq!(u(&audit["claims_available"]), payout);
    assert_eq!(u(&audit["claims_pending"]), 0);
    assert_eq!(u(&audit["total_paid"]), 0);
    assert_reconciled(&audit);
    assert!(fx.near_balance(fx.id()).await? >= contract_before, "failed payout must come back");

    // The same account name returns and the claim can be retried.
    let revived = fx.account("creator", 1).await?;
    assert_eq!(revived.id(), &creator_id);
    let before = fx.near_balance(&creator_id).await?;
    let res = fx.ok(&stranger, "claim_payout", json!({ "round_id": round_id }), 0).await?;
    assert!(res.json::<bool>()?);
    fx.settle_receipts().await?;
    assert_eq!(fx.near_balance(&creator_id).await? - before, payout);
    assert_eq!(fx.round(round_id).await?["round"]["payout_state"], "Paid");
    assert_reconciled(&fx.audit().await?);
    Ok(())
}

#[tokio::test]
async fn storage_deposit_and_faucet_flow() -> Result<()> {
    let fx = Fx::new().await?;
    let min = u(&fx.view("storage_balance_bounds", json!({})).await?["min"]);
    metric("storage_balance_bounds.min (yoctoNEAR)", min);

    // One transaction: register through the faucet, with the excess deposit refunded.
    let alice = fx.account("alice", 5).await?;
    let unfunded = fx.call(&alice, "faucet", json!({}), 0).await?;
    assert_fails(&unfunded, "ERR_DEPOSIT");
    assert!(fx.view("storage_balance_of", json!({ "account_id": alice.id() })).await?.is_null());
    fx.settle_receipts().await?;
    let before = fx.near_balance(alice.id()).await?;
    fx.ok(&alice, "faucet", json!({}), NEAR / 10).await?;
    fx.settle_receipts().await?;
    let spent = before - fx.near_balance(alice.id()).await?;
    assert!(spent >= min && spent < min + NEAR / 100, "spent {spent}, min {min}");
    assert_eq!(fx.ft_balance(alice.id()).await?, 1_000 * EMBER);
    assert_fails(&fx.call(&alice, "faucet", json!({}), 0).await?, "ERR_FAUCET_COOLDOWN");

    // Two steps: NEP-145 registration, then a claim with nothing attached.
    let bob = fx.long_account("bob", 5).await?;
    fx.ok(&bob, "storage_deposit", json!({ "registration_only": true }), NEAR / 10).await?;
    assert_eq!(fx.view("storage_balance_of", json!({ "account_id": bob.id() })).await?["total"], min.to_string());
    let usage = fx.storage_usage().await?;
    let res = fx.ok(&bob, "faucet", json!({}), 0).await?;
    metric("faucet gas (TGas)", tgas(res.total_gas_burnt));
    metric("reserve: faucet claim, max-length account (bytes)", fx.storage_usage().await? - usage);
    assert_eq!(fx.ft_balance(bob.id()).await?, 1_000 * EMBER);

    // The cooldown lifts on chain time.
    let next = fx.view("get_faucet_next_ms", json!({ "account_id": alice.id() })).await?.as_u64().unwrap();
    assert!(next > 0);
    fx.advance_to(next).await?;
    fx.ok(&alice, "faucet", json!({}), 0).await?;
    assert_eq!(fx.ft_balance(alice.id()).await?, 2_000 * EMBER);

    let audit = fx.audit().await?;
    assert_eq!(u(&audit["faucet_remaining"]), 147_000 * EMBER);
    assert_reconciled(&audit);
    Ok(())
}

#[tokio::test]
async fn worst_case_round_gas_and_storage() -> Result<()> {
    let fx = Fx::new().await?;
    let mut creators = Vec::new();
    for i in 0..5 {
        creators.push(fx.long_account(&format!("creator{i}"), 5).await?);
    }
    let refs: Vec<&Account> = creators.iter().collect();

    let usage = fx.storage_usage().await?;
    fx.ok(&fx.dist, "stoke", json!({}), NEAR).await?;
    metric("reserve: first stoke (bytes)", fx.storage_usage().await? - usage);
    let usage = fx.storage_usage().await?;
    let args = json!({
        "creator": creators[0].id(), "title": "t".repeat(80),
        "brief_uri": "u".repeat(256), "brief_hash": WORK_HASH,
    });
    fx.ok(&fx.curator, "nominate", args, 0).await?;
    metric("reserve: maximum-size nomination (bytes)", fx.storage_usage().await? - usage);

    let (round_id, t) = fx.open_round(&refs, 20 * NEAR, EMBER, 10_000 * EMBER, 12).await?;

    // `heavy` holds the largest position possible: 5 missions with an add in all 12
    // checkpoints. `solo` is the largest single record, since it also pays for the index entry.
    let heavy = fx.long_account("heavy", 10).await?;
    let solo = fx.long_account("solo", 10).await?;
    fx.fund(&heavy, 2_000 * EMBER).await?;
    fx.fund(&solo, 2_000 * EMBER).await?;

    let mut heavy_bytes = 0u64;
    let mut solo_bytes = 0u64;
    let mut last_commit_gas = Gas::from_gas(0);
    let mut heavy_total = 0u128;
    for checkpoint in 0..12u64 {
        fx.advance_to(t.candle + checkpoint * CHECKPOINT_MS + 2_000).await?;
        let deposit = if checkpoint == 0 { COMMIT_DEPOSIT } else { 1 };
        for mission in 0..5u8 {
            let amount = (mission as u128 + 1) * EMBER;
            let before = fx.storage_usage().await?;
            let res = fx.commit(&heavy, round_id, mission, amount, deposit).await?;
            heavy_bytes += fx.storage_usage().await? - before;
            heavy_total += amount;
            last_commit_gas = res.total_gas_burnt;
        }
        let before = fx.storage_usage().await?;
        fx.commit(&solo, round_id, 0, EMBER, deposit).await?;
        solo_bytes += fx.storage_usage().await? - before;
    }

    for mission in 0..5u8 {
        let view = fx.view("get_commitment", json!({ "round_id": round_id, "account_id": heavy.id(), "mission": mission })).await?;
        assert_eq!(view["commitment"]["adds"].as_array().unwrap().len(), 12, "mission {mission}: {view}");
    }
    let view = fx.view("get_commitment", json!({ "round_id": round_id, "account_id": solo.id(), "mission": 0 })).await?;
    assert_eq!(view["commitment"]["adds"].as_array().unwrap().len(), 12, "{view}");

    let covered = COMMIT_DEPOSIT / STORAGE_BYTE_COST;
    metric("COMMIT_DEPOSIT covers (bytes per record)", covered);
    metric("largest single record incl. index entry (bytes)", solo_bytes);
    metric("5-record account, average per record (bytes)", heavy_bytes as f64 / 5.0);
    assert!(u128::from(solo_bytes) <= covered, "record uses {solo_bytes} bytes, deposit covers {covered}");
    assert!(u128::from(heavy_bytes) <= covered * 5, "account uses {heavy_bytes} bytes, deposits cover {}", covered * 5);
    assert_reconciled(&fx.audit().await?);

    fx.advance_to(t.close).await?;
    let select = fx.ok(&fx.dist, "select", json!({ "round_id": round_id }), 0).await?;
    let round = fx.round(round_id).await?;
    assert_eq!(round["round"]["status"], "AwaitingWork");
    assert_eq!(round["round"]["winner"], 4);
    let k = round["round"]["drawn_checkpoint"].as_u64().unwrap() as u128;
    let counted = 5 * (k + 1) * EMBER;
    assert_eq!(u(&round["round"]["counted"]), counted);

    let creator = &creators[4];
    let submit = fx.ok(creator, "submit", json!({ "round_id": round_id, "hash": WORK_HASH, "uri": "u".repeat(256) }), 0).await?;
    let accept = fx.ok(&fx.reviewer, "accept", json!({ "round_id": round_id, "hash": WORK_HASH }), 0).await?;
    let claim = fx.ok(&fx.dist, "claim_payout", json!({ "round_id": round_id }), 0).await?;
    let callback = claim
        .receipt_outcomes()
        .iter()
        .find(|o| o.logs.iter().any(|l| l.contains("payout_result")))
        .expect("on_payout receipt")
        .gas_burnt;
    assert_eq!(fx.round(round_id).await?["round"]["payout_state"], "Paid");

    let usage = fx.storage_usage().await?;
    let settle = fx.ok(&fx.dist, "settle", json!({ "round_id": round_id, "account_id": heavy.id() }), 0).await?;
    assert_eq!(u(&settle.clone().json::<Value>()?), heavy_total - counted);
    metric("settle net storage change, 5 records closed, Ash added (bytes)", fx.storage_usage().await? as i64 - usage as i64);
    fx.ok(&fx.dist, "settle", json!({ "round_id": round_id, "account_id": solo.id() }), 0).await?;
    assert_eq!(u(&fx.view("get_ash", json!({ "account_id": heavy.id() })).await?), counted);
    assert_eq!(fx.ft_balance(solo.id()).await?, 2_000 * EMBER);

    let measured = [
        ("commit, 12th add on a record", last_commit_gas),
        ("select, 5 missions x 12 checkpoints", select.total_gas_burnt),
        ("submit", submit.total_gas_burnt),
        ("accept", accept.total_gas_burnt),
        ("claim_payout, whole transaction", claim.total_gas_burnt),
        ("on_payout callback", callback),
        ("settle, 5 records with 12 adds", settle.total_gas_burnt),
    ];
    for (name, gas) in measured {
        metric(&format!("gas: {name} (TGas)"), tgas(gas));
    }
    for (name, gas) in measured {
        assert!(gas.as_gas() < Gas::from_tgas(100).as_gas(), "{name} burned {} TGas", tgas(gas));
    }
    assert!(callback.as_gas() < Gas::from_tgas(10).as_gas(), "on_payout burned {} TGas of its 10 TGas", tgas(callback));

    let audit = fx.audit().await?;
    assert_eq!(u(&audit["escrow_total"]), 0);
    assert_eq!(u(&audit["deposits_held"]), 0);
    assert_reconciled(&audit);
    metric("operating_surplus after run (yoctoNEAR)", u(&audit["operating_surplus"]));
    Ok(())
}
