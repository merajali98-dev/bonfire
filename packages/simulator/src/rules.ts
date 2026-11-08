/**
 * The contract's economic rules in TypeScript. Shared fixtures in
 * packages/protocol/fixtures/math.json are checked against both this file and the Rust code.
 */

export const BPS = 10_000n;
export const ONE_EMBER = 10n ** 18n;
export const ONE_NEAR = 10n ** 24n;

export interface Rules {
  budgetBps: bigint;
  minBudget: bigint;
  initialThreshold: bigint;
  minThreshold: bigint;
  upBps: bigint;
  downBps: bigint;
  targetMultiple: bigint;
}

export function matchedPayout(budget: bigint, counted: bigint, target: bigint): bigint {
  return (budget * (counted < target ? counted : target)) / target;
}

export function roundBudget(pool: bigint, budgetBps: bigint): bigint {
  return (pool * budgetBps) / BPS;
}

export function adjustThreshold(current: bigint, bps: bigint, floor: bigint, ceiling: bigint): bigint {
  const moved = (current * bps) / BPS;
  const floored = moved > floor ? moved : floor;
  return floored < ceiling ? floored : ceiling;
}

export function checkpointIndex(now: bigint, candleStart: bigint, close: bigint, checkpoints: bigint): bigint {
  const k = ((now - candleStart) * checkpoints) / (close - candleStart);
  return k < checkpoints - 1n ? k : checkpoints - 1n;
}

export type Selection = { kind: "selected"; winner: number; counted: bigint } | { kind: "below" } | { kind: "tie" };

/** Below-threshold is checked before the tie, matching `select`. */
export function selectOutcome(counted: bigint[], threshold: bigint): Selection {
  let best = 0n;
  let winner = 0;
  counted.forEach((value, i) => {
    if (value > best) {
      best = value;
      winner = i;
    }
  });
  if (best < threshold) return { kind: "below" };
  if (counted.filter((value) => value === best).length > 1) return { kind: "tie" };
  return { kind: "selected", winner, counted: best };
}

/** The share of rounds that must succeed for the threshold to hold level: up^p * down^(1-p) = 1. */
export function impliedSuccessRate(upBps: bigint, downBps: bigint): number {
  const up = Math.log(Number(upBps) / 10_000);
  const down = Math.log(Number(downBps) / 10_000);
  return -down / (up - down);
}
