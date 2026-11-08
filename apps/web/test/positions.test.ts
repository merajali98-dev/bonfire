import assert from "node:assert/strict";
import { test } from "node:test";
import type { CommitmentView, Round, RoundPhase, RoundStatus, RoundView } from "@bonfire/protocol";
import { roundsToSettle, toPosition, totalsOf } from "../src/positions.ts";

const NOW = 1_000_000;

function round(status: RoundStatus, phase: RoundPhase, winner: number | null, overrides: Partial<Round> = {}): RoundView {
  return {
    phase,
    live_totals: [],
    counted_totals: null,
    current_checkpoint: null,
    now_ms: NOW,
    round: {
      id: 3,
      status,
      winner,
      missions: [{ title: "A" }, { title: "B" }],
      delivery_deadline_ms: NOW + 1_000,
      review_deadline_ms: NOW + 2_000,
      ...overrides,
    } as Round,
  };
}

function record(mission: number, total: bigint, counted: bigint | null): CommitmentView {
  return {
    round_id: 3,
    mission,
    commitment: { pre: total.toString(), adds: [], deposit: "1" },
    total: total.toString(),
    counted: counted === null ? null : counted.toString(),
    refundable_now: "0",
    burn_exposure: "0",
  };
}

const at = (r: RoundView, c: CommitmentView, now = NOW) => toPosition(c, r, now);

test("before the candle, a commitment can be withdrawn", () => {
  const p = at(round("Funded", "Backing", null), record(0, 100n, null));
  assert.equal(p.action, "withdraw");
  assert.equal(p.committed, 100n);
});

test("during the candle, nothing can be taken out", () => {
  const p = at(round("Funded", "Candle", null), record(0, 100n, null));
  assert.equal(p.action, null);
  assert.equal(p.locked, 100n);
});

test("a closed round offers the draw, which anyone can make", () => {
  assert.equal(at(round("Funded", "AwaitingSelection", null), record(0, 100n, null)).action, "select");
});

test("a losing mission refunds in full before and after acceptance", () => {
  for (const status of ["AwaitingWork", "AwaitingReview", "Accepted"] as const) {
    const p = at(round(status, status, 0), record(1, 100n, 40n));
    assert.equal(p.action, "settle", status);
    assert.equal(p.refundable, 100n, status);
    assert.equal(p.burned, 0n, status);
  }
});

test("every failed ending refunds in full", () => {
  for (const status of ["FailedSelection", "Rejected", "ExpiredWork", "ExpiredReview", "Cancelled"] as const) {
    const p = at(round(status, status, 0), record(0, 100n, 40n));
    assert.equal(p.action, "settle", status);
    assert.equal(p.refundable, 100n, status);
  }
});

test("a winner awaiting work has nothing to settle unless part of it was late", () => {
  const whole = at(round("AwaitingWork", "AwaitingWork", 0), record(0, 100n, 100n));
  assert.equal(whole.action, null, "the contract refuses this settle with ERR_NOTHING_TO_SETTLE");
  assert.equal(whole.locked, 100n);
  const partly = at(round("AwaitingWork", "AwaitingWork", 0), record(0, 100n, 60n));
  assert.equal(partly.action, "settle");
  assert.equal(partly.refundable, 40n);
  assert.equal(partly.locked, 60n);
});

test("a passed deadline offers closing the round", () => {
  const work = round("AwaitingWork", "AwaitingWork", 0);
  assert.equal(at(work, record(0, 100n, 100n), NOW + 999).action, null);
  assert.equal(at(work, record(0, 100n, 100n), NOW + 1_000).action, "expire");
  assert.equal(at(round("AwaitingReview", "AwaitingReview", 0), record(0, 100n, 100n), NOW + 2_000).action, "expire");
});

test("an accepted winner burns the counted part and settles the rest", () => {
  const p = at(round("Accepted", "Accepted", 0), record(0, 100n, 60n));
  assert.equal(p.action, "settle");
  assert.equal(p.burned, 60n);
  assert.equal(p.refundable, 40n);
});

test("totals add up and one settle covers each round", () => {
  const accepted = round("Accepted", "Accepted", 0);
  const positions = [at(accepted, record(0, 100n, 60n)), at(accepted, record(1, 30n, 0n))];
  assert.deepEqual(totalsOf(positions), { committed: 0n, locked: 0n, refundable: 70n, burned: 60n });
  assert.deepEqual(roundsToSettle(positions), [3]);
});
