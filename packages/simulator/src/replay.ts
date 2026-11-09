/**
 * The seeded run that contracts/bonfire/tests/sandbox.rs replays against the wasm.
 *
 * The candle draw is random on-chain, so the sandbox test asks this script for the plan one
 * round at a time and passes in the checkpoints the contract actually drew:
 *
 *   node packages/simulator/src/replay.ts 2,0,1
 *
 * prints every round as JSON, using those draws for the first three rounds and the seeded
 * draws after that. A round's commitments depend only on earlier draws, so the test can
 * place them, read the draw from `select`, then ask again for the expected outcome.
 */
import { pathToFileURL } from "node:url";
import { runScenario, type RoundEvent } from "./engine.ts";
import { base } from "./scenarios.ts";
import { ONE_EMBER as E } from "./rules.ts";

export const REPLAY_SEED = 12;

/** Small enough to run on a sandbox node in a few minutes, varied enough to reach every outcome. */
export const replayScenario = () =>
  base("replay", {
    days: 8,
    roundEveryDays: 1,
    missions: 3,
    checkpoints: 3,
    groups: [
      { strategy: "casual", wallets: 6, wealthEach: 6_000n * E },
      { strategy: "candle", wallets: 2, wealthEach: 6_000n * E },
      { strategy: "sniper", wallets: 2, wealthEach: 4_000n * E },
      { strategy: "whale", wallets: 1, wealthEach: 30_000n * E },
    ],
    faucetClaim: 0,
    missDelivery: 0.2,
    reviewerAbsent: 0.2,
    reject: 0.2,
  });

export function replayPlan(draws: readonly number[]) {
  const cfg = replayScenario();
  const events: RoundEvent[] = [];
  runScenario(cfg, REPLAY_SEED, { draws, onRound: (event) => events.push(event) });
  const wealth = cfg.groups.flatMap((g) => Array.from({ length: g.wallets }, () => g.wealthEach));
  return {
    seed: REPLAY_SEED,
    rules: cfg.rules,
    checkpoints: cfg.checkpoints,
    missions: cfg.missions,
    initialHearth: cfg.initialHearth,
    wealth,
    rounds: events,
  };
}

const json = (value: unknown) => JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2);

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/").replace(/^(?=[A-Za-z]:)/, "/")}`) {
  const arg = process.argv[2] ?? "";
  const draws = arg === "" ? [] : arg.split(",").map(Number);
  process.stdout.write(json(replayPlan(draws)) + "\n");
}
