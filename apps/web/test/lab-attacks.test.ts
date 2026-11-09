import assert from "node:assert/strict";
import { test } from "node:test";
import type { Round, RoundPhase, RoundView } from "@bonfire/protocol";
import { ATTACKS, reasonOf, verdictOf } from "../src/lab-attacks.ts";

const round = (phase: RoundPhase): RoundView => ({ phase, live_totals: [], counted_totals: null, current_checkpoint: null, now_ms: 0, round: { id: 2 } as Round });
const attack = (id: string) => ATTACKS.find((a) => a.id === id)!;

test("attempts that need a live round wait for one", () => {
  for (const id of ["claim", "draw", "withdraw"]) {
    assert.equal(attack(id).build(null, "me.testnet"), null, id);
    assert.equal(attack(id).build(round("Accepted"), "me.testnet"), null, id);
    assert.ok(attack(id).build(round("Backing"), "me.testnet"), id);
  }
  assert.ok(attack("hearth").build(null, "me.testnet"));
});

test("only the expected refusal counts as refused", () => {
  const panic = 'Smart contract panicked: ERR_STILL_BURNING"}}';
  assert.equal(verdictOf(attack("draw"), { failed: true, text: panic }), "refused");
  assert.equal(verdictOf(attack("draw"), { failed: true, text: "ERR_WRONG_STATUS" }), "refused-otherwise");
  assert.equal(verdictOf(attack("draw"), { failed: false, text: "" }), "went-through");
  assert.equal(verdictOf(attack("hearth"), { failed: true, text: '{"MethodResolveError":"MethodNotFound"}' }), "refused");
});

test("reasons are short and come from the chain's text", () => {
  assert.equal(reasonOf("... Smart contract panicked: ERR_NOT_REVIEWER ..."), "ERR_NOT_REVIEWER");
  assert.equal(reasonOf('{"MethodResolveError":"MethodNotFound"}'), "MethodNotFound: the contract has no such method");
  assert.equal(reasonOf("Smart contract panicked: Method on_payout is private"), "Method on_payout is private");
});

test("the budget attempt really carries a money field", () => {
  const call = attack("budget").build(null, "me.testnet") as { args: { args: Record<string, unknown> } };
  assert.ok("budget" in call.args.args);
});
