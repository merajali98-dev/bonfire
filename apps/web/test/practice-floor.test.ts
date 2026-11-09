import assert from "node:assert/strict";
import { test } from "node:test";
import { type Practice, advance, CLOSE_MS, commit, draw, liveTotals, myCommitted, PRACTICE, practiceScene, review, settle, stageAt, startPractice, submit, withdraw } from "../src/practice-floor.ts";

const E = 10n ** 18n;
const CANDLE = PRACTICE.backingMs;
const SLOT = PRACTICE.candleMs / PRACTICE.checkpoints;

/** Every practice EMBER is free, committed, or burned. Nothing appears or disappears. */
function assertConserved(p: ReturnType<typeof startPractice>) {
  assert.equal(p.free + myCommitted(p) + (p.settled ? p.myBurned : 0n), PRACTICE.wallet);
}

test("the clock moves through backing, candle and close", () => {
  const p = startPractice(1);
  assert.equal(stageAt(p, 0), "backing");
  assert.equal(stageAt(p, CANDLE), "candle");
  assert.equal(stageAt(p, CLOSE_MS), "closed");
});

test("withdraw works before the candle and is refused during it", () => {
  let p = commit(startPractice(1), 1_000, 0, 2_000n * E);
  assert.equal(p.free, 3_000n * E);
  p = withdraw(p, 2_000, 0);
  assert.equal(p.free, PRACTICE.wallet);
  p = commit(p, 3_000, 1, 1_000n * E);
  assert.throws(() => withdraw(p, CANDLE + 10, 1), /can't withdraw/);
  assert.throws(() => commit(p, CLOSE_MS, 1, E), /closed/);
  assert.throws(() => commit(p, 0, 1, 10_000n * E), /more practice EMBER/);
});

test("a candle addition after the drawn checkpoint is refunded, not burned", () => {
  // Practice backers put enough on mission 0 for it to win whatever the player does.
  let p = startPractice(1);
  p = { ...p, bots: [{ at: 1_000, mission: 0, amount: 20_000n * E }] };
  p = commit(p, 2_000, 0, 1_000n * E);
  p = commit(p, CANDLE + 1, 0, 1_000n * E); // checkpoint 1
  p = commit(p, CANDLE + 3 * SLOT + 1, 0, 1_000n * E); // checkpoint 4
  p = advance(p, CLOSE_MS);
  p = draw(p, CLOSE_MS, 1);
  assert.equal(p.decision?.winner, 0);
  assert.equal(p.decision?.counted[0], 22_000n * E);
  p = review(submit(p), true);
  assert.equal(p.burnedTotal, 22_000n * E);
  assert.equal(p.myBurned, 2_000n * E);
  p = settle(p);
  assert.equal(p.refunded, 1_000n * E);
  assert.equal(p.ash, 2_000n * E);
  assert.equal(p.free, 3_000n * E);
  assertConserved(p);
  assert.equal(practiceScene(p, CLOSE_MS).mood, "burned");
});

test("below the threshold, nothing burns and the threshold would fall", () => {
  let p: Practice = { ...startPractice(1), bots: [] };
  p = commit(p, 1_000, 2, 5_000n * E);
  p = draw(p, CLOSE_MS, 0);
  assert.equal(p.decision?.outcome, "below");
  assert.equal(p.decision?.nextThreshold, 8_500n * E);
  assert.throws(() => submit(p), /no winning work/);
  p = settle(p);
  assert.equal(p.free, PRACTICE.wallet);
  assert.equal(p.ash, 0n);
});

test("a rejection refunds everything", () => {
  let p: Practice = { ...startPractice(1), bots: [{ at: 1_000, mission: 1, amount: 12_000n * E }] };
  p = advance(commit(p, 500, 1, 3_000n * E), CLOSE_MS);
  p = review(submit(draw(p, CLOSE_MS, 3)), false);
  assert.equal(p.rejected, true);
  p = settle(p);
  assert.equal(p.free, PRACTICE.wallet);
  assert.throws(() => settle(p), /already settled/);
});

test("the draw counts practice backers who acted before close, even if the page skipped ahead", () => {
  const p = draw(startPractice(3), CLOSE_MS, PRACTICE.checkpoints - 1);
  const all = p.bots.reduce((sum, b) => sum + b.amount, 0n);
  assert.equal(liveTotals(p).reduce((a, b) => a + b, 0n), all);
});

test("most seeds reach a winner, so the full loop is usually seen", () => {
  let winners = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const p = draw(startPractice(seed), CLOSE_MS, seed % PRACTICE.checkpoints);
    if (p.decision?.outcome === "selected") winners++;
  }
  assert.ok(winners >= 110, `${winners} of 200 seeds found a winner without the player`);
});
