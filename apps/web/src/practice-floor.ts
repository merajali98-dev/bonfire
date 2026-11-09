/**
 * The Practice floor: one whole round on a fast local clock, with no wallet and no network.
 * It uses the simulator's copy of the contract rules (the same math the sandbox replay checks
 * against the wasm), so what happens here is what the contract would do with these numbers.
 * Nothing in this file touches the chain.
 */
import { adjustThreshold, checkpointIndex, matchedPayout, ONE_EMBER, ONE_NEAR, selectOutcome } from "@bonfire/simulator/src/rules.ts";
import { fireStage, type Scene } from "./scene.ts";

const E = ONE_EMBER;

export const PRACTICE = {
  checkpoints: 4,
  backingMs: 30_000,
  candleMs: 24_000,
  budget: 2n * ONE_NEAR,
  threshold: 10_000n * E,
  target: 40_000n * E,
  wallet: 5_000n * E,
  upBps: 10_500n,
  downBps: 8_500n,
  floor: 1_000n * E,
  ceiling: 1_000_000n * E,
} as const;

export const CLOSE_MS = PRACTICE.backingMs + PRACTICE.candleMs;

/** Made-up missions. They are not nominations and never become real rounds. */
export const MISSIONS = ["A campfire song", "A plush pattern", "A haiku wall"] as const;

export type Stage = "backing" | "candle" | "closed" | "work" | "review" | "accepted" | "failed";

export interface BotCommit {
  at: number;
  mission: number;
  amount: bigint;
}

export interface Decision {
  k: number;
  outcome: "selected" | "below" | "tie";
  winner: number | null;
  counted: bigint[];
  payout: bigint;
  nextThreshold: bigint;
}

export interface Practice {
  free: bigint;
  /** The player's EMBER before the candle, per mission. */
  myPre: bigint[];
  /** The player's candle additions, per mission and checkpoint. */
  myAdds: bigint[][];
  /** Everyone's, the player included. */
  pre: bigint[];
  adds: bigint[][];
  bots: BotCommit[];
  botsDone: number;
  /** Set once the candle is drawn. Before that the stage follows the clock. */
  after: "work" | "review" | "accepted" | "failed" | null;
  decision: Decision | null;
  rejected: boolean;
  burnedTotal: bigint;
  myBurned: bigint;
  ash: bigint;
  settled: boolean;
  refunded: bigint;
  log: string[];
}

/** Deterministic, so a seed always gives the same practice backers. */
function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const zeros = () => MISSIONS.map(() => 0n);
const grid = () => MISSIONS.map(() => Array.from({ length: PRACTICE.checkpoints }, () => 0n));
const sum = (values: bigint[]) => values.reduce((a, b) => a + b, 0n);

export function startPractice(seed: number): Practice {
  const next = rng(seed);
  const appeal = MISSIONS.map(() => 0.3 + next());
  const pick = () => {
    let roll = next() * appeal.reduce((a, b) => a + b, 0);
    for (let i = 0; i < appeal.length; i++) {
      roll -= appeal[i]!;
      if (roll < 0) return i;
    }
    return appeal.length - 1;
  };
  const hundreds = (low: number, high: number) => BigInt(Math.round((low + next() * (high - low)) / 100) * 100) * E;
  const bots: BotCommit[] = [];
  for (let i = 0; i < 8; i++) bots.push({ at: 2_000 + i * 3_200 + Math.floor(next() * 1_500), mission: pick(), amount: hundreds(1_200, 3_600) });
  // Candle additions. Some land in the last checkpoint and may not count.
  for (let i = 0; i < 4; i++) {
    const at = PRACTICE.backingMs + 1_000 + Math.floor(next() * (PRACTICE.candleMs - 2_000));
    bots.push({ at, mission: pick(), amount: hundreds(800, 2_400) });
  }
  bots.sort((a, b) => a.at - b.at);
  return {
    free: PRACTICE.wallet,
    myPre: zeros(),
    myAdds: grid(),
    pre: zeros(),
    adds: grid(),
    bots,
    botsDone: 0,
    after: null,
    decision: null,
    rejected: false,
    burnedTotal: 0n,
    myBurned: 0n,
    ash: 0n,
    settled: false,
    refunded: 0n,
    log: [`You have ${show(PRACTICE.wallet)} practice EMBER. Backing is open.`],
  };
}

export const show = (value: bigint) => (value / E).toLocaleString("en-US");

export function stageAt(p: Practice, t: number): Stage {
  if (p.after) return p.after;
  if (t < PRACTICE.backingMs) return "backing";
  if (t < CLOSE_MS) return "candle";
  return "closed";
}

/** The candle checkpoint a moment falls in, using the contract's rule. */
export const checkpointAt = (t: number) =>
  Number(checkpointIndex(BigInt(Math.floor(t)), BigInt(PRACTICE.backingMs), BigInt(CLOSE_MS), BigInt(PRACTICE.checkpoints)));

export const liveTotals = (p: Practice) => p.pre.map((value, m) => value + sum(p.adds[m]!));
export const myCommitted = (p: Practice) => sum(p.myPre) + sum(p.myAdds.map(sum));

function place(p: Practice, t: number, mission: number, amount: bigint) {
  if (t < PRACTICE.backingMs) p.pre[mission]! += amount;
  else p.adds[mission]![checkpointAt(t)]! += amount;
}

/** Lets the practice backers act up to time `t`. Returns a new state. */
export function advance(p: Practice, t: number): Practice {
  if (p.botsDone >= p.bots.length || p.after) return p;
  const due = p.bots.slice(p.botsDone).filter((b) => b.at <= Math.min(t, CLOSE_MS - 1));
  if (due.length === 0) return p;
  const q = structuredClone(p);
  for (const b of due) {
    place(q, b.at, b.mission, b.amount);
    const when = b.at < PRACTICE.backingMs ? "" : ` in candle checkpoint ${checkpointAt(b.at) + 1}`;
    q.log.push(`A practice backer put ${show(b.amount)} behind ${MISSIONS[b.mission]}${when}.`);
  }
  q.botsDone += due.length;
  return q;
}

export function commit(p: Practice, t: number, mission: number, amount: bigint): Practice {
  const stage = stageAt(p, t);
  if (stage !== "backing" && stage !== "candle") throw new Error("Backing has closed. Nothing more can be committed.");
  if (amount <= 0n) throw new Error("Enter an amount above zero.");
  if (amount > p.free) throw new Error("That's more practice EMBER than you have free.");
  const q = structuredClone(p);
  q.free -= amount;
  place(q, t, mission, amount);
  if (stage === "backing") {
    q.myPre[mission]! += amount;
    q.log.push(`You backed ${MISSIONS[mission]} with ${show(amount)}. You can withdraw until the candle lights.`);
  } else {
    const cp = checkpointAt(t);
    q.myAdds[mission]![cp]! += amount;
    q.log.push(`You added ${show(amount)} to ${MISSIONS[mission]} in candle checkpoint ${cp + 1}. It's locked now, and it counts only if the candle is drawn at checkpoint ${cp + 1} or later.`);
  }
  return q;
}

export function withdraw(p: Practice, t: number, mission: number): Practice {
  const stage = stageAt(p, t);
  if (stage === "candle") throw new Error("The candle is lit: you can add, but you can't withdraw.");
  if (stage !== "backing") throw new Error("Backing has closed.");
  const amount = p.myPre[mission]!;
  if (amount === 0n) throw new Error("You have nothing on that mission.");
  const q = structuredClone(p);
  q.myPre[mission] = 0n;
  q.pre[mission]! -= amount;
  q.free += amount;
  q.log.push(`You withdrew ${show(amount)} from ${MISSIONS[mission]}.`);
  return q;
}

/** Anyone can draw once backing closes. `k` is for tests; otherwise it's random, like the chain's seed. */
export function draw(p: Practice, t: number, k: number = Math.floor(Math.random() * PRACTICE.checkpoints)): Practice {
  if (stageAt(p, t) !== "closed") throw new Error("The candle is still burning. It can be drawn once backing closes.");
  const q = advance(structuredClone(p), CLOSE_MS);
  const counted = q.pre.map((value, m) => value + sum(q.adds[m]!.slice(0, k + 1)));
  const selection = selectOutcome(counted, PRACTICE.threshold);
  const cp = `The candle went out at checkpoint ${k + 1} of ${PRACTICE.checkpoints}`;
  if (selection.kind === "selected") {
    const payout = matchedPayout(PRACTICE.budget, selection.counted, PRACTICE.target);
    q.decision = { k, outcome: "selected", winner: selection.winner, counted, payout, nextThreshold: adjustThreshold(PRACTICE.threshold, PRACTICE.upBps, PRACTICE.floor, PRACTICE.ceiling) };
    q.after = "work";
    q.log.push(`${cp}. ${MISSIONS[selection.winner]} won with ${show(selection.counted)} counted EMBER, so its creator can earn ${showNear(payout)} practice NEAR. Nothing has burned yet.`);
  } else {
    const nextThreshold = selection.kind === "below" ? adjustThreshold(PRACTICE.threshold, PRACTICE.downBps, PRACTICE.floor, PRACTICE.ceiling) : PRACTICE.threshold;
    q.decision = { k, outcome: selection.kind, winner: null, counted, payout: 0n, nextThreshold };
    q.after = "failed";
    q.log.push(selection.kind === "below" ? `${cp}. No mission reached ${show(PRACTICE.threshold)} counted EMBER, so nothing burns and everyone gets their EMBER back.` : `${cp}. Two missions tied for first, so nothing burns and everyone gets their EMBER back.`);
  }
  return q;
}

export function submit(p: Practice): Practice {
  if (p.after !== "work") throw new Error("There's no winning work to submit.");
  const q = structuredClone(p);
  q.after = "review";
  q.log.push("The creator submitted the work's hash. The reviewer now accepts or rejects that exact hash.");
  return q;
}

export function review(p: Practice, accept: boolean): Practice {
  if (p.after !== "review" || !p.decision || p.decision.winner === null) throw new Error("There's nothing to review.");
  const q = structuredClone(p);
  const w = p.decision.winner;
  const k = p.decision.k;
  if (accept) {
    q.after = "accepted";
    q.burnedTotal = p.decision.counted[w]!;
    q.myBurned = p.myPre[w]! + sum(p.myAdds[w]!.slice(0, k + 1));
    q.log.push(`Accepted. ${show(q.burnedTotal)} counted EMBER burned${q.myBurned > 0n ? `, ${show(q.myBurned)} of it yours` : ""}, and the creator's ${showNear(p.decision.payout)} practice NEAR is claimable.`);
  } else {
    q.after = "failed";
    q.rejected = true;
    q.log.push("Rejected. Nothing burns, the budget goes back to the Hearth, and everyone gets their EMBER back.");
  }
  return q;
}

export function settle(p: Practice): Practice {
  if (p.settled) throw new Error("You've already settled.");
  if (p.after !== "accepted" && p.after !== "failed") throw new Error("Settle once the round has an outcome.");
  const q = structuredClone(p);
  const refund = myCommitted(p) - p.myBurned;
  q.free += refund;
  q.refunded = refund;
  q.ash += p.myBurned;
  q.settled = true;
  q.myPre = zeros();
  q.myAdds = grid();
  q.log.push(`Settled. ${show(refund)} practice EMBER came back to you${p.myBurned > 0n ? ` and ${show(p.myBurned)} became Ash` : ""}.`);
  return q;
}

function showNear(value: bigint): string {
  return (Number((value * 1000n) / ONE_NEAR) / 1000).toLocaleString("en-US", { maximumFractionDigits: 3 });
}
export { showNear as showPracticeNear };

const STAGE_WORDS = ["cold logs", "a small flame", "a healthy fire", "a roaring fire"];

export function practiceScene(p: Practice, t: number): Scene {
  const stage = stageAt(p, t);
  if (stage === "accepted") return { fire: null, mascot: "excited", candle: null, mood: "burned", description: "Practice: the fire burned down to ash after the work was accepted." };
  if (stage === "failed") return { fire: null, mascot: "shrug", candle: null, mood: "cold", description: "Practice: the mascot shrugs. Nothing burned this time." };
  if (stage === "work" || stage === "review") {
    const w = p.decision!.winner!;
    const fire = fireStage(p.decision!.counted[w]!, PRACTICE.threshold, PRACTICE.target);
    return { fire, mascot: "idle", candle: null, mood: "calm", description: `Practice: the winner's counted EMBER holds ${STAGE_WORDS[fire]} while the work is made.` };
  }
  const lead = liveTotals(p).reduce((a, b) => (b > a ? b : a), 0n);
  const fire = fireStage(lead, PRACTICE.threshold, PRACTICE.target);
  const candle = stage === "backing" ? null : stage === "candle" ? "lit" : "out";
  return { fire, mascot: fire === 3 ? "excited" : "idle", candle, mood: candle ? "candle" : "calm", description: `Practice: the leading mission has built ${STAGE_WORDS[fire]}.` };
}
