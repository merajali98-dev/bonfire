//! BONFIRE — the EMBER token plus a round engine that burns community commitments
//! only when commissioned work is accepted.
//!
//! One contract holds the NEP-141 ledger, the escrow, the Hearth (NEAR budget pool),
//! nominations, rounds, Ash, and settlement. Every EMBER refund or burn is an internal
//! ledger move; the only asynchronous operation is the creator's native NEAR payout.

use near_contract_standards::fungible_token::events::{FtBurn, FtMint};
use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC,
};
use near_contract_standards::fungible_token::{
    FungibleToken, FungibleTokenCore, FungibleTokenResolver,
};
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::store::{IterableMap, LookupMap, Vector};
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, Promise,
    PromiseOrValue,
};

pub mod events;
pub mod math;
mod rounds;
pub mod types;
mod views;

#[cfg(test)]
mod tests;

use events::emit;
use types::*;

pub const DECIMALS: u8 = 18;
/// Storage deposit held per commitment record (round, account, mission); returned on settlement.
pub const COMMIT_DEPOSIT: NearToken = NearToken::from_millinear(10);
/// Minimum NEAR per stoke. A new stoker entry's storage comes from the operating reserve;
/// this minimum makes filling it cost several times what it drains.
pub const MIN_STOKE: NearToken = NearToken::from_millinear(10);
pub const MIN_MISSIONS: usize = 3;
pub const MAX_MISSIONS: usize = 5;
pub const MAX_CHECKPOINTS: u8 = 12;
pub const MAX_TITLE_LEN: usize = 80;
pub const MAX_URI_LEN: usize = 256;

/// Stable error codes; the attack lab and tests match on these.
pub mod err {
    pub const NOT_CURATOR: &str = "ERR_NOT_CURATOR";
    pub const NOT_REVIEWER: &str = "ERR_NOT_REVIEWER";
    pub const NOT_CREATOR: &str = "ERR_NOT_CREATOR";
    pub const NO_ROUND: &str = "ERR_NO_ROUND";
    pub const NO_NOMINATION: &str = "ERR_NO_NOMINATION";
    pub const NO_MISSION: &str = "ERR_NO_MISSION";
    pub const INSUFFICIENT_ASH: &str = "ERR_INSUFFICIENT_ASH";
    pub const HEARTH_TOO_LOW: &str = "ERR_HEARTH_TOO_LOW";
    pub const BAD_PARAMS: &str = "ERR_BAD_PARAMS";
    pub const NOT_BACKING: &str = "ERR_NOT_BACKING";
    pub const CANDLE_LIT: &str = "ERR_CANDLE_LIT";
    pub const STILL_BURNING: &str = "ERR_STILL_BURNING";
    pub const WRONG_STATUS: &str = "ERR_WRONG_STATUS";
    pub const DEADLINE_PASSED: &str = "ERR_DEADLINE_PASSED";
    pub const NOT_EXPIRED: &str = "ERR_NOT_EXPIRED";
    pub const HASH_MISMATCH: &str = "ERR_HASH_MISMATCH";
    pub const BAD_HASH: &str = "ERR_BAD_HASH";
    pub const NOT_ACCEPTED: &str = "ERR_NOT_ACCEPTED";
    pub const NOTHING_TO_SETTLE: &str = "ERR_NOTHING_TO_SETTLE";
    pub const NOT_SELECTED: &str = "ERR_NOT_SELECTED";
    pub const DEPOSIT: &str = "ERR_DEPOSIT";
    pub const AMOUNT: &str = "ERR_AMOUNT";
    pub const FAUCET_COOLDOWN: &str = "ERR_FAUCET_COOLDOWN";
    pub const FAUCET_EMPTY: &str = "ERR_FAUCET_EMPTY";
    pub const SELF_TRANSFER: &str = "ERR_NO_TRANSFER_TO_CONTRACT";
    pub const UNREGISTER: &str = "ERR_UNREGISTER_BLOCKED";
    pub const NOT_REGISTERED: &str = "ERR_NOT_REGISTERED";
    pub const ALREADY_USED: &str = "ERR_NOMINATION_USED";
    pub const NOT_CONSENTED: &str = "ERR_NOT_CONSENTED";
}

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Token,
    Nominations,
    Rounds,
    Commitments,
    OpenRecords,
    Ash,
    Stokers,
    FaucetClaims,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    pub(crate) config: Config,
    pub(crate) token: FungibleToken,

    pub(crate) nominations: Vector<Nomination>,
    pub(crate) rounds: Vector<Round>,
    pub(crate) commitments: LookupMap<CommitKey, Commitment>,
    /// account -> unsettled (round_id, mission) records, for "My embers" and unregister checks.
    pub(crate) open_records: LookupMap<AccountId, Vec<(u32, u8)>>,
    pub(crate) ash: IterableMap<AccountId, U128>,
    pub(crate) stokers: IterableMap<AccountId, U128>,
    pub(crate) faucet_claims: LookupMap<AccountId, u64>,

    // NEAR accounting (yoctoNEAR)
    pub(crate) hearth_pool: u128,
    pub(crate) reserved_total: u128,
    pub(crate) claims_available: u128,
    pub(crate) claims_pending: u128,
    pub(crate) deposits_held: u128,
    pub(crate) total_stoked: u128,
    pub(crate) total_paid: u128,
    pub(crate) total_recycled: u128,

    // EMBER accounting (smallest units)
    pub(crate) escrow_total: u128,
    pub(crate) faucet_remaining: u128,
    pub(crate) total_burned: u128,
    /// Tokens destroyed by the NEP-141 corner case where a sender unregisters while an
    /// ft_transfer_call refund is in flight. Kept separate so supply always reconciles.
    pub(crate) resolve_burned: u128,
    pub(crate) total_ash: u128,
}

#[near]
impl Contract {
    /// Genesis. Mints the whole supply once: `distribution_amount` to the distribution
    /// account and `faucet_pool` into the in-contract faucet. Nothing can mint afterwards.
    #[init]
    pub fn new(
        curator: AccountId,
        distribution_account: AccountId,
        distribution_amount: U128,
        faucet_pool: U128,
        faucet_amount: U128,
        faucet_interval_ms: u64,
        nominate_min_ash: U128,
    ) -> Self {
        require!(faucet_amount.0 > 0 && faucet_interval_ms > 0, err::BAD_PARAMS);
        let initial = distribution_amount.0.checked_add(faucet_pool.0).expect("overflow");
        require!(initial > 0, err::BAD_PARAMS);
        let me = env::current_account_id();
        require!(distribution_account != me, err::BAD_PARAMS);

        let mut token = FungibleToken::new(StorageKey::Token);
        token.internal_register_account(&me);
        token.internal_register_account(&distribution_account);
        if distribution_amount.0 > 0 {
            token.internal_deposit(&distribution_account, distribution_amount.0);
            FtMint { owner_id: &distribution_account, amount: distribution_amount, memo: Some("genesis distribution") }.emit();
        }
        if faucet_pool.0 > 0 {
            token.internal_deposit(&me, faucet_pool.0);
            FtMint { owner_id: &me, amount: faucet_pool, memo: Some("genesis faucet pool") }.emit();
        }

        let config = Config {
            curator,
            distribution_account,
            faucet_amount,
            faucet_interval_ms,
            nominate_min_ash,
            initial_supply: U128(initial),
        };
        emit("genesis", json!({ "config": &config }));

        Self {
            config,
            token,
            nominations: Vector::new(StorageKey::Nominations),
            rounds: Vector::new(StorageKey::Rounds),
            commitments: LookupMap::new(StorageKey::Commitments),
            open_records: LookupMap::new(StorageKey::OpenRecords),
            ash: IterableMap::new(StorageKey::Ash),
            stokers: IterableMap::new(StorageKey::Stokers),
            faucet_claims: LookupMap::new(StorageKey::FaucetClaims),
            hearth_pool: 0,
            reserved_total: 0,
            claims_available: 0,
            claims_pending: 0,
            deposits_held: 0,
            total_stoked: 0,
            total_paid: 0,
            total_recycled: 0,
            escrow_total: 0,
            faucet_remaining: faucet_pool.0,
            total_burned: 0,
            resolve_burned: 0,
            total_ash: 0,
        }
    }

    // ------------------------------------------------------------------ Hearth

    /// Add NEAR to the Hearth. A gift: it can only ever leave as an accepted creator payout.
    #[payable]
    pub fn stoke(&mut self) {
        let amount = env::attached_deposit();
        require!(amount >= MIN_STOKE, err::DEPOSIT);
        let who = env::predecessor_account_id();
        let a = amount.as_yoctonear();
        self.hearth_pool = self.hearth_pool.checked_add(a).expect("overflow");
        self.total_stoked = self.total_stoked.checked_add(a).expect("overflow");
        let prev = self.stokers.get(&who).map(|x| x.0).unwrap_or(0);
        self.stokers.insert(who.clone(), U128(prev + a));
        emit("stoke", json!({ "account_id": who, "amount": U128(a), "hearth_pool": U128(self.hearth_pool) }));
    }

    // ------------------------------------------------------------------ Faucet

    /// Claim `faucet_amount` EMBER, once per `faucet_interval_ms`. Registers the caller if
    /// needed, using the attached deposit for NEP-145 storage (excess refunded).
    #[payable]
    pub fn faucet(&mut self) -> U128 {
        let who = env::predecessor_account_id();
        let mut attached = env::attached_deposit();
        if !self.token.accounts.contains_key(&who) {
            let min = self.token.storage_balance_bounds().min;
            require!(attached >= min, err::DEPOSIT);
            self.token.internal_register_account(&who);
            attached = attached.saturating_sub(min);
        }
        let now = env::block_timestamp_ms();
        if let Some(last) = self.faucet_claims.get(&who) {
            require!(now >= last + self.config.faucet_interval_ms, err::FAUCET_COOLDOWN);
        }
        let amount = self.config.faucet_amount.0;
        require!(self.faucet_remaining >= amount, err::FAUCET_EMPTY);
        self.faucet_remaining -= amount;
        self.faucet_claims.insert(who.clone(), now);
        self.token.internal_transfer(&env::current_account_id(), &who, amount, Some("bonfire:faucet".into()));
        emit("faucet", json!({ "account_id": who, "amount": U128(amount) }));
        refund(&who, attached);
        U128(amount)
    }

    // ------------------------------------------------------------- Nominations

    /// Propose a mission. Allowed for the curator or any account holding enough Ash.
    pub fn nominate(&mut self, creator: AccountId, title: String, brief_uri: String, brief_hash: String) -> u32 {
        let who = env::predecessor_account_id();
        if who != self.config.curator {
            require!(self.ash_of(&who) >= self.config.nominate_min_ash.0, err::INSUFFICIENT_ASH);
        }
        require!(!title.is_empty() && title.len() <= MAX_TITLE_LEN, err::BAD_PARAMS);
        require!(brief_uri.len() <= MAX_URI_LEN, err::BAD_PARAMS);
        require!(is_hex_hash(&brief_hash), err::BAD_HASH);
        let id = self.nominations.len();
        let n = Nomination {
            id,
            nominator: who,
            creator,
            title,
            brief_uri,
            brief_hash,
            consented: false,
            used_in: None,
            created_at_ms: env::block_timestamp_ms(),
        };
        emit("nominate", json!({ "nomination": &n }));
        self.nominations.push(n);
        id
    }

    /// The named creator agrees to do the work under the round's acceptance rules.
    pub fn consent(&mut self, nomination_id: u32) {
        let n = self.nominations.get_mut(nomination_id).unwrap_or_else(|| env::panic_str(err::NO_NOMINATION));
        require!(env::predecessor_account_id() == n.creator, err::NOT_CREATOR);
        require!(n.used_in.is_none(), err::ALREADY_USED);
        n.consented = true;
        emit("consent", json!({ "nomination_id": nomination_id, "creator": n.creator }));
    }

    /// Withdraw consent before the nomination is used in a round.
    pub fn revoke_consent(&mut self, nomination_id: u32) {
        let n = self.nominations.get_mut(nomination_id).unwrap_or_else(|| env::panic_str(err::NO_NOMINATION));
        require!(env::predecessor_account_id() == n.creator, err::NOT_CREATOR);
        require!(n.used_in.is_none(), err::ALREADY_USED);
        n.consented = false;
        emit("revoke_consent", json!({ "nomination_id": nomination_id, "creator": n.creator }));
    }
}

// ------------------------------------------------------------------ NEP-141

#[near]
impl FungibleTokenCore for Contract {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        require!(receiver_id != env::current_account_id(), err::SELF_TRANSFER);
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        require!(receiver_id != env::current_account_id(), err::SELF_TRANSFER);
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for Contract {
    #[private]
    fn ft_resolve_transfer(&mut self, sender_id: AccountId, receiver_id: AccountId, amount: U128) -> U128 {
        let (used, burned) = self.token.internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        if burned > 0 {
            self.resolve_burned = self.resolve_burned.checked_add(burned).expect("overflow");
        }
        used.into()
    }
}

// ------------------------------------------------------------------ NEP-145

#[near]
impl StorageManagement for Contract {
    #[payable]
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    /// Unregistering is only possible with a zero balance and no unsettled commitments.
    /// `force` is not supported: supply only changes through accepted burns.
    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        let who = env::predecessor_account_id();
        require!(!force.unwrap_or(false), err::UNREGISTER);
        let open = self.open_records.get(&who).map(|v| !v.is_empty()).unwrap_or(false);
        require!(!open, err::UNREGISTER);
        self.token.storage_unregister(Some(false))
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

// ------------------------------------------------------------------ NEP-148

const ICON: &str = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Ccircle cx='32' cy='32' r='32' fill='%23170d08'/%3E%3Cpath d='M32 8c4 10 14 16 14 28a14 14 0 0 1-28 0c0-7 4-11 7-15 1 5 3 7 6 8-2-8-1-15 1-21z' fill='%23ff6a1a'/%3E%3Cpath d='M32 30c3 5 7 8 7 13a7 7 0 0 1-14 0c0-4 3-7 7-13z' fill='%23ffd166'/%3E%3C/svg%3E";

#[near]
impl FungibleTokenMetadataProvider for Contract {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: "Ember".to_string(),
            symbol: "EMBER".to_string(),
            icon: Some(ICON.to_string()),
            reference: None,
            reference_hash: None,
            decimals: DECIMALS,
        }
    }
}

// ------------------------------------------------------------------ helpers

impl Contract {
    pub(crate) fn ash_of(&self, account: &AccountId) -> u128 {
        self.ash.get(account).map(|x| x.0).unwrap_or(0)
    }

    pub(crate) fn burn_from_escrow(&mut self, amount: u128, round_id: u32) {
        if amount == 0 {
            return;
        }
        let me = env::current_account_id();
        self.token.internal_withdraw(&me, amount);
        self.escrow_total = self.escrow_total.checked_sub(amount).expect("escrow underflow");
        self.total_burned = self.total_burned.checked_add(amount).expect("overflow");
        let memo = format!("bonfire:accepted round {}", round_id);
        FtBurn { owner_id: &me, amount: U128(amount), memo: Some(&memo) }.emit();
    }
}

pub(crate) fn refund(to: &AccountId, amount: NearToken) {
    if !amount.is_zero() {
        Promise::new(to.clone()).transfer(amount).detach();
    }
}

pub(crate) fn is_hex_hash(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
