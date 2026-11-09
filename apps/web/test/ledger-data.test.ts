import assert from "node:assert/strict";
import { test } from "node:test";
import type { Round, RoundPhase, RoundView } from "@bonfire/protocol";
import { burnedInLog, burnLog, labelOf } from "../src/ledger-data.ts";

function round(id: number, phase: RoundPhase, overrides: Partial<Round> = {}): RoundView {
  return {
    phase,
    live_totals: [],
    counted_totals: null,
    current_checkpoint: null,
    now_ms: 0,
    round: { id, winner: 0, missions: [{ title: "Stickers" }], burned: "0", payout: "0", payout_state: "None", decided_at_ms: null, ...overrides } as Round,
  };
}

test("team and guest accounts are labeled, others are not", () => {
  assert.equal(labelOf("bonfire-meraj-backer1.testnet"), "team demo actor");
  assert.equal(labelOf("g4f2b9d256c.bonfire-meraj-guests.testnet"), "guest");
  assert.equal(labelOf("meraj5.testnet"), null);
});

test("the burn log is genesis plus accepted rounds, and sums to what burned", () => {
  const rounds = [
    round(0, "Accepted", { burned: "15", payout: "7", payout_state: "Paid", missions: [{ title: "[demo] Delivery A" }] as Round["missions"] }),
    round(1, "FailedSelection", { winner: null }),
    round(2, "Accepted", { burned: "5", payout: "2", payout_state: "Available" }),
    round(3, "AwaitingReview", { burned: "0" }),
  ];
  const log = burnLog(rounds, 1_000n);
  assert.deepEqual(log.map((e) => e.kind), ["mint", "burn", "burn"]);
  assert.equal(burnedInLog(log), 20n);
  const [, first, second] = log;
  assert.ok(first?.kind === "burn" && first.demo && first.paid);
  assert.ok(second?.kind === "burn" && !second.demo && !second.paid && second.mission === "Stickers");
});
