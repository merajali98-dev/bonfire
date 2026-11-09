/** Mirrors the JSON returned by the BONFIRE contract views. Keep in sync with contracts/bonfire/src. */

/** A u128 encoded as a decimal string (yoctoNEAR or EMBER smallest units). */
export type U128 = string;
export type AccountId = string;
/** 64 lowercase hex characters (sha256). */
export type HexHash = string;

export interface Config {
  curator: AccountId;
  distribution_account: AccountId;
  faucet_amount: U128;
  faucet_interval_ms: number;
  nominate_min_ash: U128;
  initial_supply: U128;
  rules: HearthRules;
  /** Absent on the development deployment, which predates round limits. */
  limits?: RoundLimits;
}

/** Fixed at init. The shortest and longest each round window may be, in milliseconds. */
export interface RoundLimits {
  max_lead_ms: number;
  min_backing_ms: number;
  max_backing_ms: number;
  min_candle_ms: number;
  max_candle_ms: number;
  min_delivery_ms: number;
  max_delivery_ms: number;
  min_review_ms: number;
  max_review_ms: number;
}

/** Fixed at init. Every round's budget, threshold and target are computed from these. */
export interface HearthRules {
  budget_bps: number;
  min_budget: U128;
  initial_threshold: U128;
  min_threshold: U128;
  up_bps: number;
  down_bps: number;
  target_multiple: number;
}

/** What a round created right now would get. `funded` is false if create_round would fail. */
export interface NextRoundTerms {
  budget: U128;
  threshold: U128;
  target: U128;
  funded: boolean;
}

export interface Nomination {
  id: number;
  nominator: AccountId;
  creator: AccountId;
  title: string;
  brief_uri: string;
  brief_hash: HexHash;
  consented: boolean;
  used_in: number | null;
  created_at_ms: number;
}

export type RoundStatus =
  | "Funded"
  | "Cancelled"
  | "FailedSelection"
  | "AwaitingWork"
  | "AwaitingReview"
  | "Accepted"
  | "Rejected"
  | "ExpiredWork"
  | "ExpiredReview";

export type PayoutState = "None" | "Available" | "Pending" | "Paid";

/** `RoundView.phase`: the clock-derived phase while Funded, otherwise the status. */
export type RoundPhase = "Scheduled" | "Backing" | "Candle" | "AwaitingSelection" | Exclude<RoundStatus, "Funded">;

export interface Mission {
  nomination_id: number;
  creator: AccountId;
  title: string;
  brief_uri: string;
  brief_hash: HexHash;
  pre_total: U128;
  /** One entry per checkpoint. */
  candle_adds: U128[];
}

export interface Submission {
  hash: HexHash;
  uri: string;
  at_ms: number;
}

export interface Round {
  id: number;
  reviewer: AccountId;
  budget: U128;
  threshold: U128;
  target: U128;
  open_at_ms: number;
  candle_start_ms: number;
  backing_close_ms: number;
  delivery_deadline_ms: number;
  review_deadline_ms: number;
  checkpoints: number;
  missions: Mission[];
  status: RoundStatus;
  created_at_ms: number;
  /** The first account to commit. A public record only: no EMBER, weight or Ash. */
  first_spark: AccountId | null;
  drawn_checkpoint: number | null;
  winner: number | null;
  counted: U128;
  payout: U128;
  selected_at_ms: number | null;
  submission: Submission | null;
  decided_at_ms: number | null;
  burned: U128;
  payout_state: PayoutState;
  escrow_live: U128;
}

export interface RoundView {
  round: Round;
  phase: RoundPhase;
  live_totals: U128[];
  counted_totals: U128[] | null;
  current_checkpoint: number | null;
  now_ms: number;
}

export interface Commitment {
  pre: U128;
  /** [checkpoint, amount] pairs, at most one per checkpoint. */
  adds: [number, U128][];
  deposit: U128;
}

export interface CommitmentView {
  round_id: number;
  mission: number;
  commitment: Commitment;
  total: U128;
  counted: U128 | null;
  refundable_now: U128;
  burn_exposure: U128;
}

export interface Audit {
  total_supply: U128;
  initial_supply: U128;
  total_burned: U128;
  resolve_burned: U128;
  supply_ok: boolean;
  contract_ft_balance: U128;
  escrow_total: U128;
  faucet_remaining: U128;
  escrow_ok: boolean;
  hearth_pool: U128;
  reserved_total: U128;
  claims_available: U128;
  claims_pending: U128;
  deposits_held: U128;
  obligations: U128;
  account_balance: U128;
  storage_locked: U128;
  near_ok: boolean;
  operating_surplus: U128;
  total_stoked: U128;
  total_paid: U128;
  total_recycled: U128;
  total_ash: U128;
  next_threshold: U128;
  rounds: number;
  nominations: number;
}

/** Everything the curator chooses. The contract refuses any other field. */
export interface CreateRoundArgs {
  nomination_ids: number[];
  reviewer: AccountId;
  open_at_ms: number;
  candle_start_ms: number;
  backing_close_ms: number;
  delivery_deadline_ms: number;
  review_deadline_ms: number;
  checkpoints: number;
}

/** [account, amount] pairs returned by `get_keepers` and `get_stokers`. */
export type Ranking = [AccountId, U128][];
