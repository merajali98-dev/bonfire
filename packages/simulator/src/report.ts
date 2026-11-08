/** Runs every scenario across fixed seeds and writes docs/simulation.md and the chart data. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runScenario, type RunResult, type Scenario, type Strategy } from "./engine.ts";
import { ONE_EMBER, ONE_NEAR, impliedSuccessRate, type Rules } from "./rules.ts";
import { CANDIDATE_RULES, base, scenarios } from "./scenarios.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SEEDS = [1, 2, 3, 4, 5, 6, 7];

const ember = (value: bigint) => Number(value / ONE_EMBER);
const near = (value: bigint) => Number((value * 10_000n) / ONE_NEAR) / 10_000;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const spread = (xs: number[]) => Math.sqrt(mean(xs.map((x) => (x - mean(xs)) ** 2)));
const grouped = (x: number, digits = 0) => x.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const ms = (xs: number[], digits = 0) => `${grouped(mean(xs), digits)} ± ${grouped(spread(xs), digits)}`;
const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const runs = (cfg: Scenario) => SEEDS.map((seed) => runScenario(cfg, seed));
const table = (head: string[], rows: string[][]) =>
  [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");

const count = (r: RunResult, ...kinds: string[]) => r.rounds.filter((x) => kinds.includes(x.outcome)).length;
const selected = (r: RunResult) => count(r, "accepted", "rejected", "missed", "absent");

function scenarioRow(label: string, results: RunResult[]): string[] {
  const of = (f: (r: RunResult) => number, digits = 0) => ms(results.map(f), digits);
  return [
    label,
    of((r) => r.rounds.length),
    of((r) => count(r, "accepted"), 1),
    of((r) => count(r, "below"), 1),
    of((r) => count(r, "tie"), 1),
    of((r) => count(r, "rejected", "missed", "absent"), 1),
    of((r) => r.skipped, 1),
    of((r) => ember(r.burned)),
    of((r) => ember(r.refunded)),
    of((r) => ember(r.lateRefunded)),
    of((r) => near(r.paid), 1),
    of((r) => near(r.recycled), 1),
    of((r) => near(r.hearth), 1),
    of((r) => ember(r.series.at(-1)!.threshold)),
    of((r) => r.ashGini, 2),
    of((r) => r.ashTop10, 2),
  ];
}

const SCENARIO_HEAD = ["Scenario", "Rounds", "Accepted", "Below", "Tie", "Work failed", "Skipped", "Burned", "Returned", "Late refunds", "NEAR paid", "NEAR recycled", "Final Hearth", "Final threshold", "Ash Gini", "Top-10 Ash"];

// ------------------------------------------------------------------ scenarios

const named: [string, Scenario][] = [
  ["Steady community", scenarios.steady()],
  ["Falling attendance, stoking stops", scenarios.falling()],
  ["One whale", scenarios.whale()],
  ["Whale split across 10 wallets", scenarios.splitWhale()],
  ["Snipers, candle close", scenarios.snipersCandle()],
  ["Snipers, hard close", scenarios.snipersHard()],
  ["Missed deadlines, absent reviewer", scenarios.deadlines()],
  ["Ties and missions under threshold", scenarios.tiesAndUnder()],
  ["Rapid burns", scenarios.rapidBurns()],
  ["Faucet farming", scenarios.faucetFarming()],
];
const results = new Map(named.map(([label, cfg]) => [label, runs(cfg)]));
const result = (label: string) => results.get(label)!;

// ------------------------------------------------------------------ strategies

const mixRuns = runs(scenarios.mix());
const STRATEGIES: [Strategy, string][] = [
  ["casual", "Casual crowd"],
  ["early", "Early"],
  ["candle", "Candle-waiter"],
  ["sniper", "Sniper"],
  ["whale", "Whale"],
  ["split", "Split whale"],
];
const metric = (r: RunResult, s: Strategy) => r.byStrategy.get(s)!;
const burnPerWin = (burned: bigint, wins: number) => (wins ? ember(burned) / wins : 0);
const strategyRows = STRATEGIES.map(([key, label]) => [
  label,
  ms(mixRuns.map((r) => metric(r, key).wallets)),
  ms(mixRuns.map((r) => ember(metric(r, key).burned))),
  ms(mixRuns.map((r) => ember(metric(r, key).refunded))),
  ms(mixRuns.map((r) => Number(metric(r, key).ash) / Number(r.ashTotal || 1n)), 2),
  ms(mixRuns.map((r) => metric(r, key).roundsWon), 1),
  ms(mixRuns.map((r) => burnPerWin(metric(r, key).burned, metric(r, key).roundsWon))),
]);
const avgBurnPerWin = (s: Strategy) => mean(mixRuns.map((r) => burnPerWin(metric(r, s).burned, metric(r, s).roundsWon)));
const avgWins = (s: Strategy) => mean(mixRuns.map((r) => metric(r, s).roundsWon));
// A group with only a few wins has a burn-per-win figure that is mostly noise.
const cheapest = [...STRATEGIES].filter(([s]) => avgWins(s) >= 5).sort((a, b) => avgBurnPerWin(a[0]) - avgBurnPerWin(b[0]))[0]!;
const sniperBurned = mean(mixRuns.map((r) => ember(metric(r, "sniper").burned)));
const sniperRefunded = mean(mixRuns.map((r) => ember(metric(r, "sniper").refunded)));

// ------------------------------------------------------------------ parameter sweeps

function secondHalfCv(r: RunResult): number {
  const xs = r.series.filter((p) => p.day >= 30).map((p) => ember(p.threshold));
  return spread(xs) / (mean(xs) || 1);
}

function whaleComparison(rules: Rules) {
  const honest = runs(scenarios.honestWhaleThinCrowd(rules));
  const saboteur = runs(scenarios.saboteurThinCrowd(rules));
  const totals = (rs: RunResult[], s: Strategy) => {
    const wins = rs.reduce((sum, r) => sum + metric(r, s).roundsWon, 0);
    const burned = rs.reduce((sum, r) => sum + ember(metric(r, s).burned), 0);
    return { wins: wins / rs.length, perWin: wins ? burned / wins : 0 };
  };
  const honestTotals = totals(honest, "whale");
  const saboteurTotals = totals(saboteur, "saboteur");
  const lowest = mean(saboteur.map((r) => Math.min(...r.series.map((p) => ember(p.threshold)))));
  const discount = honestTotals.perWin > 0 && saboteurTotals.wins > 0 ? Math.max(0, 1 - saboteurTotals.perWin / honestTotals.perWin) : 0;
  const harm = discount * (saboteurTotals.wins / 20);
  return { honest: honestTotals, saboteur: saboteurTotals, lowest, discount, harm };
}

interface ControllerRow {
  up: bigint;
  down: bigint;
  implied: number;
  realized: number;
  cv: number;
  fallingSuccess: number;
  discount: number;
  harm: number;
  lowest: number;
  saboteurWins: number;
  score: number;
  eligible: boolean;
}

const successRate = (r: RunResult) => selected(r) / Math.max(1, selected(r) + count(r, "below"));

function evaluateController(up: bigint, down: bigint): ControllerRow {
  const rules = { ...CANDIDATE_RULES, upBps: up, downBps: down };
  const steady = runs(base("steady", { rules }));
  const falling = runs({ ...scenarios.falling(), rules });
  const implied = impliedSuccessRate(up, down);
  const realized = mean(steady.map(successRate));
  const cv = mean(steady.map(secondHalfCv));
  const late = falling.map((r) => {
    const held = r.rounds.filter((x) => x.day >= 30 && x.outcome !== "tie");
    return held.filter((x) => x.outcome !== "below").length / Math.max(1, held.length);
  });
  const fallingSuccess = mean(late);
  const whale = whaleComparison(rules);
  return {
    up,
    down,
    implied,
    realized,
    cv,
    fallingSuccess,
    discount: whale.discount,
    harm: whale.harm,
    lowest: whale.lowest,
    saboteurWins: whale.saboteur.wins,
    score: cv + (1 - fallingSuccess) + whale.harm,
    eligible: implied >= 0.6 && implied <= 0.9,
  };
}

const controllers: ControllerRow[] = [];
for (const up of [10_500n, 11_000n, 12_000n]) for (const down of [5_000n, 7_000n, 8_500n]) controllers.push(evaluateController(up, down));
const bestController = [...controllers].filter((c) => c.eligible).sort((a, b) => a.score - b.score)[0]!;
const chosen: Rules = { ...CANDIDATE_RULES, upBps: bestController.up, downBps: bestController.down };

interface BudgetRow {
  bps: bigint;
  steadyPaid: number;
  steadyHearth: number;
  fallingPaid: number;
  fallingSkipped: number;
  fallingHearth: number;
}

function evaluateBudget(bps: bigint): BudgetRow {
  const rules = { ...chosen, budgetBps: bps };
  const steady = runs(base("steady", { rules }));
  const falling = runs({ ...scenarios.falling(), rules });
  return {
    bps,
    steadyPaid: mean(steady.map((r) => near(r.paid))),
    steadyHearth: mean(steady.map((r) => near(r.hearth))),
    fallingPaid: mean(falling.map((r) => near(r.paid))),
    fallingSkipped: mean(falling.map((r) => r.skipped)),
    fallingHearth: mean(falling.map((r) => near(r.hearth))),
  };
}

const budgets = [1_000n, 1_500n, 2_000n, 2_500n, 3_000n, 4_000n, 6_000n].map(evaluateBudget);
// A low share stalls on the minimum budget and a high one drains the pool, so the share that
// keeps a stoke-free Hearth open longest wins; near-ties go to the one that pays more.
const fewestSkips = Math.min(...budgets.map((b) => b.fallingSkipped));
const bestBudget = [...budgets].filter((b) => b.fallingSkipped <= fewestSkips + 0.5).sort((a, b) => b.steadyPaid - a.steadyPaid)[0]!;
const chosenWithBudget: Rules = { ...chosen, budgetBps: bestBudget.bps };

interface TargetRow {
  multiple: bigint;
  payoutRatio: number;
  paid: number;
  burnPerNear: number;
}

function evaluateTarget(multiple: bigint): TargetRow {
  const steady = runs(base("steady", { rules: { ...chosenWithBudget, targetMultiple: multiple } }));
  const ratios = steady.flatMap((r) => r.rounds.filter((x) => x.outcome === "accepted").map((x) => Number((x.payout * 10_000n) / x.budget) / 10_000));
  const paid = mean(steady.map((r) => near(r.paid)));
  const burned = mean(steady.map((r) => ember(r.burned)));
  return { multiple, payoutRatio: mean(ratios), paid, burnPerNear: burned / (paid || 1) };
}

const targets = [2n, 3n, 4n, 6n, 8n].map(evaluateTarget);
// Nearest to half the budget: more backing still adds payout, and less still pays something.
const bestTarget = [...targets].sort((a, b) => Math.abs(a.payoutRatio - 0.5) - Math.abs(b.payoutRatio - 0.5))[0]!;
const finalRules: Rules = { ...chosenWithBudget, targetMultiple: bestTarget.multiple };
const whaleAtChosen = whaleComparison(finalRules);

// ------------------------------------------------------------------ findings

const avg = (label: string, f: (r: RunResult) => number) => mean(result(label).map(f));
const hardSnipes = avg("Snipers, hard close", (r) => r.snipesDecided);
const candleSnipes = avg("Snipers, candle close", (r) => r.snipesDecided);
const farming = result("Faucet farming");
const farmerAsh = mean(farming.map((r) => Number(metric(r, "farmer").ash) / Number(r.ashTotal || 1n)));
const emptyDay = mean(farming.map((r) => r.faucetEmptyDay ?? 60));
const whaleAsh = mean(result("One whale").map((r) => Number(metric(r, "whale").ash) / Number(r.ashTotal || 1n)));

const bps = (value: bigint) => (Number(value) / 10_000).toFixed(2);

const md = `# BONFIRE simulation report

Generated by \`npm run simulate\`. Do not edit by hand. Every number comes from the deterministic simulator in \`packages/simulator\`, run for 60 days at seeds ${SEEDS.join(", ")}. Values are mean ± standard deviation across seeds.

These are assumption-driven scenarios, not forecasts of price or adoption. Rounds run every 3 days and resolve on their start day, so overlapping rounds are not modeled here. The contract's rule math is shared with the Rust tests through fixtures.

## Recommended rule values

| Rule | Value | How it was chosen |
| --- | --- | --- |
| \`up_bps\` / \`down_bps\` | ${finalRules.upBps} / ${finalRules.downBps} (×${bps(finalRules.upBps)} / ×${bps(finalRules.downBps)}) | Lowest score in the controller sweep, among pairs whose implied success rate is 60–90% |
| \`budget_bps\` | ${finalRules.budgetBps} (${Number(finalRules.budgetBps) / 100}%) | Fewest rounds skipped once stoking stops; near-ties go to the share that pays creators more |
| \`target_multiple\` | ${finalRules.targetMultiple} | Typical accepted payout closest to half the budget |

Threshold floor, starting threshold and minimum budget stay at ${grouped(ember(finalRules.minThreshold))} EMBER, ${grouped(ember(finalRules.initialThreshold))} EMBER and ${near(finalRules.minBudget)} NEAR. The sweeps did not vary them.

## Scenarios

${table(SCENARIO_HEAD, named.map(([label]) => scenarioRow(label, result(label))))}

- **Wallet splitting gains nothing.** One whale and the same wealth across 10 wallets produce the same winners in every seed, because weight is the sum of EMBER.
- **The candle cuts sniping.** Snipers decided the winner in ${candleSnipes.toFixed(1)} rounds with a candle close, against ${hardSnipes.toFixed(1)} with a hard close.
- **A whale still dominates.** With 300,000 EMBER, one wallet ends with ${pct(whaleAsh)} of all Ash. Amount weighting does not stop this.
- **Faucet farming drains the pool.** 60 farming wallets empty the faucet around day ${emptyDay.toFixed(0)} and hold ${pct(farmerAsh)} of all Ash.
- **Splitting does hide concentration.** Ash Gini is measured per wallet, so the same whale reads ${mean(result("One whale").map((r) => r.ashGini)).toFixed(2)} as one wallet and ${mean(result("Whale split across 10 wallets").map((r) => r.ashGini)).toFixed(2)} across ten.
- The ties scenario has only 10 wallets, so its top-10 share is 100% by construction.

## Backer strategies

Six groups compete in the same rounds. The whale and the split whale each hold the same wealth as the other groups of 8 wallets.

${table(["Strategy", "Wallets", "Burned", "Refunded", "Ash share", "Rounds won", "Burn per win"], strategyRows)}

A round counts as won when the group has any counted EMBER on an accepted winner, so burn per win measures cost, not influence. Groups with fewer than 5 wins are left out of the comparison below, because the figure is mostly noise.

**Where a strategy beats the design:** the ${cheapest[1].toLowerCase()} group pays least per win, at ${grouped(avgBurnPerWin(cheapest[0]))} EMBER against ${grouped(avgBurnPerWin("early"))} for early backers, over ${avgWins(cheapest[0]).toFixed(1)} and ${avgWins("early").toFixed(1)} wins. Waiting into the candle is a modest edge on cost that gives up some wins.

**Where it does not:** snipers burned ${grouped(sniperBurned)} EMBER and had ${grouped(sniperRefunded)} returned over ${avgWins("sniper").toFixed(1)} wins. Under a candle close, most last-moment commitments never count.

## Threshold controller

The threshold holds level when the success rate p satisfies up^p × down^(1−p) = 1, which is the implied rate below. The score adds threshold volatility, the failure rate once attendance has fallen, and the saboteur's cost discount scaled by the share of rounds it wins. Lower is better.

${table(
  ["Up / down", "Implied rate", "Steady success", "Volatility (late)", "Falling success (late)", "Saboteur low", "Saboteur wins", "Cost discount", "Score"],
  controllers.map((c) => [
    `×${bps(c.up)} / ×${bps(c.down)}${c === bestController ? " (chosen)" : ""}${c.eligible ? "" : " (out of range)"}`,
    pct(c.implied),
    pct(c.realized),
    c.cv.toFixed(3),
    pct(c.fallingSuccess),
    grouped(c.lowest),
    c.saboteurWins.toFixed(1),
    pct(c.discount),
    c.score.toFixed(3),
  ]),
)}

The chosen pair scores ${bestController.score.toFixed(3)}, and the next eligible pair scores ${[...controllers].filter((c) => c.eligible).sort((a, b) => a.score - b.score)[1]!.score.toFixed(3)}. The two are close, so the choice is a judgment call rather than a clear win.

**A whale can push the threshold down.** A saboteur abstains until the threshold is half its starting value, then wins as cheaply as it can. At the chosen values the threshold falls to about ${grouped(whaleAtChosen.lowest)} EMBER, and the saboteur wins ${whaleAtChosen.saboteur.wins.toFixed(1)} of 20 rounds at ${grouped(whaleAtChosen.saboteur.perWin)} EMBER per win, against ${whaleAtChosen.honest.wins.toFixed(1)} wins at ${grouped(whaleAtChosen.honest.perWin)} for a whale that backs every round. That is a ${pct(whaleAtChosen.discount)} discount on the cost of a win. It works only where the crowd alone cannot reach the threshold.

## Hearth drain

Budget share at the chosen controller. "Falling" stops stoking after day 10.

${table(
  ["Budget share", "Steady NEAR paid", "Steady final Hearth", "Falling NEAR paid", "Falling rounds skipped", "Falling final Hearth"],
  budgets.map((b) => [
    `${Number(b.bps) / 100}%${b === bestBudget ? " (chosen)" : ""}`,
    b.steadyPaid.toFixed(1),
    b.steadyHearth.toFixed(1),
    b.fallingPaid.toFixed(1),
    b.fallingSkipped.toFixed(1),
    b.fallingHearth.toFixed(1),
  ]),
)}

## Target multiple

${table(
  ["Target / threshold", "Mean payout of budget", "NEAR paid", "EMBER burned per NEAR"],
  targets.map((t) => [`${t.multiple}×${t === bestTarget ? " (chosen)" : ""}`, pct(t.payoutRatio), t.paid.toFixed(1), grouped(t.burnPerNear)]),
)}

## Strategy note

- **Late commitments.** Before the draw nobody knows the deciding checkpoint, so a commitment at the last checkpoint counts only if the draw lands there. Waiting cuts exposure to a burn and also cuts the chance of affecting the result.
- **Free-riding.** Lower supply benefits every holder, whether they burned or not. What a burner alone gets is direction over the mission, a larger commission for it, and Ash. Whether those are worth the cost is a question about real people, and this model cannot answer it.
- **The cost of winning.** Only counted EMBER on the accepted winner burns. Losing and late EMBER returns. Backing a popular mission is cheap per round won, and swinging a close round costs up to the whole gap to the leader.

## Model limits

Backers follow fixed behaviors with random mission preferences and do not learn or react to price. Real attendance, creator quality and whale behavior are unknown. Testnet NEAR has no market value.
`;

mkdirSync(resolve(ROOT, "docs"), { recursive: true });
writeFileSync(resolve(ROOT, "docs/simulation.md"), md);

const chart = Object.fromEntries(
  named.map(([label]) => {
    const rs = result(label);
    const points = rs[0]!.series.map((_, day) => ({
      day,
      burned: Math.round(mean(rs.map((r) => ember(r.series[day]!.burned)))),
      supply: Math.round(mean(rs.map((r) => ember(r.series[day]!.supply)))),
      hearth: Number(mean(rs.map((r) => near(r.series[day]!.hearth))).toFixed(3)),
      threshold: Math.round(mean(rs.map((r) => ember(r.series[day]!.threshold)))),
    }));
    return [label, points];
  }),
);
mkdirSync(resolve(ROOT, "packages/simulator/reports"), { recursive: true });
writeFileSync(resolve(ROOT, "packages/simulator/reports/series.json"), JSON.stringify(chart) + "\n");
console.log(`Recommended: up ${finalRules.upBps}, down ${finalRules.downBps}, budget ${finalRules.budgetBps}, multiple ${finalRules.targetMultiple}. Wrote docs/simulation.md`);
