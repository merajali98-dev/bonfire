import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runScenario, type RunResult, type Scenario } from "../src/engine.ts";
import { adjustThreshold, checkpointIndex, impliedSuccessRate, matchedPayout, roundBudget, selectOutcome } from "../src/rules.ts";
import { base, scenarios } from "../src/scenarios.ts";

const fixtures = JSON.parse(readFileSync(new URL("../../protocol/fixtures/math.json", import.meta.url), "utf8"));
const big = (value: string | number) => BigInt(value);

test("rules match the shared fixtures", () => {
  for (const c of fixtures.matched_payout) assert.equal(matchedPayout(big(c.budget), big(c.counted), big(c.target)), big(c.expected));
  for (const c of fixtures.round_budget) assert.equal(roundBudget(big(c.pool), big(c.bps)), big(c.expected));
  for (const c of fixtures.adjust_threshold) assert.equal(adjustThreshold(big(c.current), big(c.bps), big(c.floor), big(c.ceiling)), big(c.expected));
  for (const c of fixtures.checkpoint_index) assert.equal(checkpointIndex(big(c.now), big(c.candle_start), big(c.close), big(c.checkpoints)), big(c.expected));
});

test("selection checks the threshold before a tie", () => {
  assert.deepEqual(selectOutcome([0n, 0n, 0n], 10n), { kind: "below" });
  assert.deepEqual(selectOutcome([5n, 5n, 1n], 10n), { kind: "below" });
  assert.deepEqual(selectOutcome([12n, 12n, 1n], 10n), { kind: "tie" });
  assert.deepEqual(selectOutcome([3n, 12n, 11n], 10n), { kind: "selected", winner: 1, counted: 12n });
});

test("implied success rate solves up^p * down^(1-p) = 1", () => {
  const p = impliedSuccessRate(11_000n, 7_000n);
  assert.ok(Math.abs(1.1 ** p * 0.7 ** (1 - p) - 1) < 1e-9);
  assert.ok(Math.abs(p - 0.789) < 0.001);
});

function assertConserved(cfg: Scenario, r: RunResult): void {
  assert.equal(r.supply + r.burned, cfg.initialSupply, "supply + burned = initial");
  assert.equal(r.walletTotal + r.undistributed + r.faucetRemaining, r.supply, "every EMBER is held somewhere");
  assert.equal(r.hearth + r.paid, r.stoked, "NEAR is in the Hearth or paid");
  assert.equal(r.ashTotal, r.burned, "Ash equals burned EMBER");
  for (const round of r.rounds) {
    assert.ok(round.payout <= round.budget, "payout within budget");
    if (round.outcome !== "accepted") assert.equal(round.payout, 0n);
  }
  for (const point of r.series) assert.ok(point.threshold >= cfg.rules.minThreshold, "threshold at or above the floor");
}

const everyScenario: [string, () => Scenario][] = Object.entries(scenarios).map(([name, make]) => [name, make as () => Scenario]);

for (const [name, make] of everyScenario) {
  test(`${name} conserves tokens and NEAR across seeds`, () => {
    const cfg = make();
    for (let seed = 1; seed <= 5; seed++) assertConserved(cfg, runScenario(cfg, seed));
  });
}

const fingerprint = (r: RunResult) =>
  JSON.stringify(r.rounds, (_, value) => (typeof value === "bigint" ? value.toString() : value)) + r.burned + r.supply + r.hearth;

test("the same seed gives the same result, and a different seed does not", () => {
  const cfg = base("determinism");
  assert.equal(fingerprint(runScenario(cfg, 42)), fingerprint(runScenario(cfg, 42)));
  assert.notEqual(fingerprint(runScenario(cfg, 42)), fingerprint(runScenario(cfg, 43)));
});

test("splitting a whale across wallets gains no weight", () => {
  for (let seed = 1; seed <= 5; seed++) {
    const single = runScenario(scenarios.singleWhale(), seed);
    const split = runScenario(scenarios.splitWhale(), seed);
    assert.deepEqual(split.rounds.map((r) => [r.outcome, r.winner]), single.rounds.map((r) => [r.outcome, r.winner]));
    const dust = 10n ** 9n;
    const delta = split.burned > single.burned ? split.burned - single.burned : single.burned - split.burned;
    assert.ok(delta < dust, `burn differs by ${delta}`);
  }
});

test("under a hard close, every sniper commitment counts", () => {
  const r = runScenario(scenarios.snipersHard(), 1);
  assert.equal(r.lateRefunded, 0n);
  assert.ok(r.rounds.every((round) => round.checkpoint === 11));
});

test("a hearth below the minimum skips rounds and keeps its funds", () => {
  const r = runScenario(base("dry", { initialHearth: 1n, stokePerDay: 0n }), 1);
  assert.equal(r.rounds.length, 0);
  assert.equal(r.skipped, 20);
  assert.equal(r.hearth, 1n);
});
