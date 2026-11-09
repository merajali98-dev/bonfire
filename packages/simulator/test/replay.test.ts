import assert from "node:assert/strict";
import { test } from "node:test";
import { runScenario } from "../src/engine.ts";
import { REPLAY_SEED, replayPlan, replayScenario } from "../src/replay.ts";

const clean = (value: unknown) => JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v));

test("observing a run does not change it", () => {
  const plain = runScenario(replayScenario(), REPLAY_SEED);
  const watched = runScenario(replayScenario(), REPLAY_SEED, { onRound: () => {} });
  assert.equal(clean(watched.rounds), clean(plain.rounds));
  assert.equal(clean(watched.series), clean(plain.series));
});

test("a forced draw changes nothing before its round, and a round's commitments do not depend on its own draw", () => {
  const seeded = replayPlan([]);
  const forced = replayPlan([2, 0]);
  assert.equal(forced.rounds[0]!.record!.checkpoint, 2);
  assert.equal(forced.rounds[1]!.record!.checkpoint, 0);
  assert.equal(clean(forced.rounds[0]!.commits), clean(seeded.rounds[0]!.commits));
  assert.equal(clean(replayPlan([2, 1]).rounds[1]!.commits), clean(forced.rounds[1]!.commits));
});

test("forcing the seeded draws reproduces the seeded run", () => {
  const seeded = replayPlan([]);
  const draws = seeded.rounds.flatMap((r) => (r.record ? [r.record.checkpoint] : []));
  assert.equal(clean(replayPlan(draws)), clean(seeded));
});

test("a draw outside the candle is refused", () => {
  assert.throws(() => replayPlan([3]), /outside 0\.\.2/);
});

test("the replay state conserves supply after every round", () => {
  const plan = replayPlan([]);
  const total = plan.wealth.reduce((sum, w) => sum + w, 0n);
  for (const round of plan.rounds) {
    const held = round.after.free.reduce((sum, v) => sum + v, 0n);
    assert.equal(held + round.after.burned, total, `day ${round.day}`);
    const ash = round.after.ash.reduce((sum, v) => sum + v, 0n);
    assert.equal(ash, round.after.burned, `day ${round.day}`);
  }
});
