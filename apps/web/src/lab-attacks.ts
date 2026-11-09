/**
 * "Try to steal the fire": forbidden actions a visitor can send from their own account. Each
 * is a real transaction, and the page shows only what the chain answered.
 */
import type { RoundView } from "@bonfire/protocol";

const HASH = "ab".repeat(32);
const ONE_NEAR = "1000000000000000000000000";

export interface Attack {
  id: string;
  title: string;
  tries: string;
  /** Why the contract refuses, in plain words. Shown next to the real answer. */
  why: string;
  /** Null when there is no round in a state where this attempt means anything. */
  build(round: RoundView | null, me: string): { method: string; args: object; deposit: bigint } | null;
  /** What a refusal for the right reason looks like in the chain's error text. */
  expect: RegExp;
}

const active = (round: RoundView | null) => round && ["Backing", "Candle"].includes(round.phase);

export const ATTACKS: Attack[] = [
  {
    id: "hearth",
    title: "Take NEAR out of the Hearth",
    tries: "Calls withdraw_hearth for 1 NEAR.",
    why: "There is no such method. NEAR leaves the Hearth only as a payout for accepted work.",
    build: () => ({ method: "withdraw_hearth", args: { amount: ONE_NEAR }, deposit: 0n }),
    expect: /MethodNotFound|MethodResolveError/,
  },
  {
    id: "mint",
    title: "Mint yourself EMBER",
    tries: "Calls mint for 1,000,000 EMBER to your account.",
    why: "There is no mint method. The whole supply was minted once, at genesis.",
    build: (_round, me) => ({ method: "mint", args: { account_id: me, amount: "1000000000000000000000000" }, deposit: 0n }),
    expect: /MethodNotFound|MethodResolveError/,
  },
  {
    id: "budget",
    title: "Set a round's budget",
    tries: "Calls create_round with a budget field of 1,000 NEAR.",
    why: "create_round accepts only missions, time windows and a reviewer. A money field is refused before anything runs.",
    build: (_round, me) => {
      const now = Date.now();
      return {
        method: "create_round",
        args: { args: {
          nomination_ids: [0, 1, 2], reviewer: me, checkpoints: 1,
          open_at_ms: now + 60_000, candle_start_ms: now + 120_000, backing_close_ms: now + 180_000,
          delivery_deadline_ms: now + 240_000, review_deadline_ms: now + 300_000,
          budget: "1000000000000000000000000000",
        } },
        deposit: 0n,
      };
    },
    expect: /Failed to deserialize|unknown field/,
  },
  {
    id: "callback",
    title: "Trigger a payout yourself",
    tries: "Calls the private payout callback on_payout directly.",
    why: "on_payout is private: only the contract itself can call it, after its own transfer.",
    build: () => ({ method: "on_payout", args: { round_id: 0 }, deposit: 0n }),
    expect: /is private/,
  },
  {
    id: "claim",
    title: "Pay a creator before the work is accepted",
    tries: "Calls claim_payout on the live round.",
    why: "A payout is claimable only after the reviewer accepts the submitted work.",
    build: (round) => (active(round) ? { method: "claim_payout", args: { round_id: round!.round.id }, deposit: 0n } : null),
    expect: /ERR_NOT_ACCEPTED/,
  },
  {
    id: "draw",
    title: "Draw the candle early",
    tries: "Calls select on the live round before backing closes.",
    why: "The candle can be drawn only after backing closes, once, by anyone.",
    build: (round) => (active(round) ? { method: "select", args: { round_id: round!.round.id }, deposit: 0n } : null),
    expect: /ERR_STILL_BURNING/,
  },
  {
    id: "accept",
    title: "Accept the work yourself",
    tries: "Calls accept on the live round with a made-up hash.",
    why: "Only the round's reviewer can accept, and only the exact hash the creator submitted.",
    build: (round) => (round ? { method: "accept", args: { round_id: round.round.id, hash: HASH }, deposit: 0n } : null),
    expect: /ERR_NOT_REVIEWER/,
  },
  {
    id: "withdraw",
    title: "Withdraw EMBER that isn't yours",
    tries: "Calls withdraw for 1 EMBER from mission 0 of the live round.",
    why: "You can withdraw only your own pre-candle commitment, and nothing once the candle is lit.",
    build: (round) => (active(round) ? { method: "withdraw", args: { round_id: round!.round.id, mission: 0, amount: "1000000000000000000" }, deposit: 0n } : null),
    expect: /ERR_AMOUNT|ERR_CANDLE_LIT/,
  },
  {
    id: "nominate",
    title: "Nominate a mission without Ash",
    tries: "Calls nominate with you as the creator.",
    why: "Only the curator and accounts that have earned enough Ash by burning can nominate.",
    build: (_round, me) => ({ method: "nominate", args: { creator: me, title: "Attack lab test", brief_uri: "https://example.com", brief_hash: HASH }, deposit: 0n }),
    expect: /ERR_INSUFFICIENT_ASH/,
  },
];

export type Verdict = "refused" | "refused-otherwise" | "went-through";

/** Classifies what the chain answered. A refusal for another reason is shown as such, never as the expected one. */
export function verdictOf(attack: Attack, outcome: { failed: boolean; text: string }): Verdict {
  if (!outcome.failed) return "went-through";
  return attack.expect.test(outcome.text) ? "refused" : "refused-otherwise";
}

/** The part of a chain error worth showing: the contract's error code or the runtime's reason. */
export function reasonOf(text: string): string {
  const code = text.match(/ERR_[A-Z_]+/)?.[0];
  if (code) return code;
  if (/MethodNotFound/.test(text)) return "MethodNotFound: the contract has no such method";
  const priv = text.match(/Method \w+ is private/)?.[0];
  if (priv) return priv;
  if (/Failed to deserialize/.test(text)) return "Failed to deserialize input: the arguments were refused";
  const panic = text.match(/Smart contract panicked: ([^"\\]+)/)?.[1];
  return panic ?? text.slice(0, 160);
}
