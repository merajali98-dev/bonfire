import assert from "node:assert/strict";
import { test } from "node:test";
import type { Round, RoundPhase, RoundView } from "@bonfire/protocol";
import { clockOf, fireStage, leaderOf, sceneOf } from "../src/scene.ts";

const NOW = 1_000_000;

function round(phase: RoundPhase, live: bigint[] = [], overrides: Partial<Round> = {}): RoundView {
  return {
    phase,
    live_totals: live.map(String),
    counted_totals: null,
    current_checkpoint: null,
    now_ms: NOW,
    round: {
      threshold: "100",
      target: "400",
      counted: "0",
      open_at_ms: NOW + 1,
      candle_start_ms: NOW + 2,
      backing_close_ms: NOW + 3,
      delivery_deadline_ms: NOW + 4,
      review_deadline_ms: NOW + 5,
      ...overrides,
    } as Round,
  };
}

test("the fire grows at the threshold and the target, not before", () => {
  assert.equal(fireStage(0n, 100n, 400n), 0);
  assert.equal(fireStage(1n, 100n, 400n), 1);
  assert.equal(fireStage(99n, 100n, 400n), 1);
  assert.equal(fireStage(100n, 100n, 400n), 2);
  assert.equal(fireStage(399n, 100n, 400n), 2);
  assert.equal(fireStage(400n, 100n, 400n), 3);
  assert.equal(fireStage(9000n, 100n, 400n), 3);
});

test("the leader is the highest live tally, and a tie is reported", () => {
  assert.equal(leaderOf(round("Backing", [0n, 0n])), null);
  assert.deepEqual(leaderOf(round("Backing", [10n, 30n, 20n])), { mission: 1, total: 30n, tied: false });
  assert.deepEqual(leaderOf(round("Backing", [30n, 10n, 30n])), { mission: 0, total: 30n, tied: true });
  assert.deepEqual(leaderOf(round("Backing", [30n, 30n, 50n])), { mission: 2, total: 50n, tied: false });
});

test("backing tracks the leading mission", () => {
  assert.equal(sceneOf(round("Backing", [0n])).fire, 0);
  assert.equal(sceneOf(round("Backing", [50n, 120n])).fire, 2);
  assert.deepEqual(
    { fire: sceneOf(round("Backing", [400n])).fire, mascot: sceneOf(round("Backing", [400n])).mascot },
    { fire: 3, mascot: "excited" },
  );
});

test("the candle phase lights the candle and changes the mood, and a closed round blows it out", () => {
  const lit = sceneOf(round("Candle", [120n]));
  assert.equal(lit.candle, "lit");
  assert.equal(lit.mood, "candle");
  assert.equal(sceneOf(round("AwaitingSelection", [120n])).candle, "out");
  assert.equal(sceneOf(round("Backing", [120n])).candle, null);
});

test("after selection the fire follows counted EMBER, not the live tally", () => {
  const scene = sceneOf(round("AwaitingWork", [9000n], { counted: "120" }));
  assert.equal(scene.fire, 2);
});

test("only an accepted round shows ash and celebrates", () => {
  const accepted = sceneOf(round("Accepted"));
  assert.equal(accepted.mood, "burned");
  assert.equal(accepted.mascot, "excited");
  assert.equal(accepted.fire, null);
  for (const phase of ["Backing", "Candle", "AwaitingSelection", "AwaitingWork", "AwaitingReview", "Rejected", "FailedSelection", "Expired", "Cancelled"] as RoundPhase[]) {
    assert.notEqual(sceneOf(round(phase)).mood, "burned", phase);
  }
});

test("rounds that end without a burn shrug", () => {
  for (const phase of ["Rejected", "FailedSelection", "Expired", "Cancelled"] as RoundPhase[]) {
    assert.equal(sceneOf(round(phase)).mascot, "shrug", phase);
    assert.equal(sceneOf(round(phase)).mood, "cold", phase);
  }
});

test("with no round the fire is cold", () => {
  assert.deepEqual({ fire: sceneOf(null).fire, mood: sceneOf(null).mood }, { fire: 0, mood: "cold" });
});

test("the clock points at the deadline for the phase, measured on chain time", () => {
  assert.deepEqual(clockOf(round("Scheduled"), NOW), { label: "Opens in", ms: 1 });
  assert.deepEqual(clockOf(round("Backing"), NOW), { label: "Candle lights in", ms: 2 });
  assert.deepEqual(clockOf(round("Candle"), NOW), { label: "Closes within", ms: 3 });
  assert.deepEqual(clockOf(round("AwaitingWork"), NOW), { label: "Work due in", ms: 4 });
  assert.deepEqual(clockOf(round("AwaitingReview"), NOW), { label: "Review due in", ms: 5 });
  assert.equal(clockOf(round("AwaitingSelection"), NOW), null);
  assert.equal(clockOf(round("Accepted"), NOW), null);
});
