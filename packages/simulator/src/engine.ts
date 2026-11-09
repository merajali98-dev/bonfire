/**
 * Deterministic 60-day community simulator. The same seed and scenario always give the
 * same result. Rounds run one after another on a fixed cadence, and each resolves on its
 * start day. These are assumption-driven scenarios, not forecasts.
 */
import {
  ONE_EMBER,
  adjustThreshold,
  matchedPayout,
  roundBudget,
  selectOutcome,
  type Rules,
} from "./rules.ts";

export type Strategy = "casual" | "early" | "candle" | "sniper" | "whale" | "split" | "saboteur" | "farmer";

export interface Group {
  strategy: Strategy;
  wallets: number;
  wealthEach: bigint;
}

export interface Scenario {
  name: string;
  days: number;
  roundEveryDays: number;
  missions: number;
  checkpoints: number;
  closeMode: "candle" | "hard";
  rules: Rules;
  groups: Group[];
  initialSupply: bigint;
  faucetPool: bigint;
  faucetAmount: bigint;
  faucetClaim: number;
  initialHearth: bigint;
  stokePerDay: bigint;
  stokeUntilDay: number;
  participationStart: number;
  participationEnd: number;
  commitFraction: [number, number];
  whaleFraction: number;
  /** Rounds amounts down to a multiple of this, which makes exact ties possible. */
  coarse: bigint;
  missDelivery: number;
  reject: number;
  reviewerAbsent: number;
}

export type RoundOutcome = "accepted" | "rejected" | "missed" | "absent" | "below" | "tie";

export interface RoundRecord {
  day: number;
  budget: bigint;
  threshold: bigint;
  target: bigint;
  checkpoint: number;
  outcome: RoundOutcome;
  winner: number | null;
  counted: bigint;
  payout: bigint;
}

export interface StrategyTotals {
  wallets: number;
  burned: bigint;
  refunded: bigint;
  ash: bigint;
  roundsWon: number;
}

export interface DayPoint {
  day: number;
  supply: bigint;
  burned: bigint;
  hearth: bigint;
  threshold: bigint;
}

export interface RunResult {
  scenario: string;
  seed: number;
  rounds: RoundRecord[];
  series: DayPoint[];
  burned: bigint;
  refunded: bigint;
  lateRefunded: bigint;
  paid: bigint;
  recycled: bigint;
  stoked: bigint;
  skipped: number;
  /** Rounds where a sniper's commitments changed which mission was selected. */
  snipesDecided: number;
  supply: bigint;
  hearth: bigint;
  undistributed: bigint;
  faucetRemaining: bigint;
  faucetEmptyDay: number | null;
  walletTotal: bigint;
  ashTotal: bigint;
  ashGini: number;
  ashTop10: number;
  byStrategy: Map<Strategy, StrategyTotals>;
}

class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  range(low: number, high: number): number {
    return low + this.next() * (high - low);
  }
  weighted(weights: number[]): number {
    let roll = this.next() * weights.reduce((sum, w) => sum + w, 0);
    for (let i = 0; i < weights.length; i++) {
      roll -= weights[i]!;
      if (roll < 0) return i;
    }
    return weights.length - 1;
  }
}

interface Wallet {
  group: number;
  strategy: Strategy;
  free: bigint;
  ash: bigint;
}

interface Commit {
  wallet: Wallet;
  mission: number;
  amount: bigint;
  /** null is before the candle. */
  checkpoint: number | null;
}

const fractionOf = (amount: bigint, fraction: number) => (amount * BigInt(Math.floor(fraction * 1_000_000))) / 1_000_000n;

function gini(values: bigint[]): number {
  const sorted = values.map(Number).sort((a, b) => a - b);
  const total = sorted.reduce((sum, v) => sum + v, 0);
  if (total === 0) return 0;
  const weighted = sorted.reduce((sum, v, i) => sum + (i + 1) * v, 0);
  return (2 * weighted) / (sorted.length * total) - (sorted.length + 1) / sorted.length;
}

function topShare(values: bigint[], count: number): number {
  const total = values.reduce((sum, v) => sum + v, 0n);
  if (total === 0n) return 0;
  const top = [...values].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0)).slice(0, count);
  return Number((top.reduce((sum, v) => sum + v, 0n) * 1_000_000n) / total) / 1_000_000;
}

const maxOf = (values: bigint[]) => values.reduce((best, v) => (v > best ? v : best), 0n);

/** One commitment as the replay sends it to the contract. Wallets are numbered in group order. */
export interface PlacedCommit {
  wallet: number;
  mission: number;
  amount: bigint;
  /** null is before the candle. */
  checkpoint: number | null;
}

/** Everything a round did, and the state after its commitments were settled. */
export interface RoundEvent {
  day: number;
  /** NEAR stoked into the Hearth since the previous round, before this one opened. */
  stoke: bigint;
  /** True when the budget was below `minBudget`, so no round opened. */
  skipped: boolean;
  budget: bigint;
  record: RoundRecord | null;
  /** The matched payout at selection, whether or not the work was later accepted. */
  matched: bigint;
  commits: PlacedCommit[];
  after: { supply: bigint; burned: bigint; hearth: bigint; threshold: bigint; free: bigint[]; ash: bigint[] };
}

export interface RunOptions {
  /** Candle draws to use instead of the seeded ones, by round index. The seeded draw is still
   * consumed, so the rest of the run keeps the same random stream. Used to follow a chain. */
  draws?: readonly number[];
  onRound?: (event: RoundEvent) => void;
}

export function runScenario(cfg: Scenario, seed: number, options: RunOptions = {}): RunResult {
  const rng = new Rng(seed);
  const wallets: Wallet[] = [];
  cfg.groups.forEach((group, index) => {
    for (let i = 0; i < group.wallets; i++) {
      wallets.push({ group: index, strategy: group.strategy, free: group.wealthEach, ash: 0n });
    }
  });
  const allocated = wallets.reduce((sum, w) => sum + w.free, 0n);
  const undistributed = cfg.initialSupply - cfg.faucetPool - allocated;
  if (undistributed < 0n) throw new Error(`${cfg.name}: wallets hold more than the distribution`);

  const totals = new Map<Strategy, StrategyTotals>();
  for (const w of wallets) {
    const entry = totals.get(w.strategy) ?? { wallets: 0, burned: 0n, refunded: 0n, ash: 0n, roundsWon: 0 };
    entry.wallets++;
    totals.set(w.strategy, entry);
  }

  const rounds: RoundRecord[] = [];
  const series: DayPoint[] = [];
  let supply = cfg.initialSupply;
  let hearth = cfg.initialHearth;
  let threshold = cfg.rules.initialThreshold;
  let faucet = cfg.faucetPool;
  let faucetEmptyDay: number | null = null;
  let burned = 0n;
  let refunded = 0n;
  let lateRefunded = 0n;
  let paid = 0n;
  let recycled = 0n;
  let stoked = cfg.initialHearth;
  let skipped = 0;
  let snipesDecided = 0;

  const size = (amount: bigint) => (cfg.coarse > 0n ? (amount / cfg.coarse) * cfg.coarse : amount);

  const snapshot = () => ({
    supply,
    burned,
    hearth,
    threshold,
    free: wallets.map((w) => w.free),
    ash: wallets.map((w) => w.ash),
  });

  function playRound(day: number, stoke: bigint): void {
    const budget = roundBudget(hearth, cfg.rules.budgetBps);
    if (budget < cfg.rules.minBudget) {
      skipped++;
      options.onRound?.({ day, stoke, skipped: true, budget, record: null, matched: 0n, commits: [], after: snapshot() });
      return;
    }
    hearth -= budget;
    const roundThreshold = threshold;
    const target = roundThreshold * cfg.rules.targetMultiple;
    const n = cfg.checkpoints;
    const participation = cfg.participationStart + ((cfg.participationEnd - cfg.participationStart) * day) / Math.max(1, cfg.days - 1);
    const appeal = Array.from({ length: cfg.missions }, () => 0.2 + rng.next());
    const groupPick = new Map<number, number>();
    const pick = (wallet: Wallet, shared: boolean) => {
      if (!shared) return rng.weighted(appeal);
      const chosen = groupPick.get(wallet.group) ?? rng.weighted(appeal);
      groupPick.set(wallet.group, chosen);
      return chosen;
    };

    const commits: Commit[] = [];
    const live = Array.from({ length: cfg.missions }, () => 0n);
    const place = (wallet: Wallet, mission: number, wanted: bigint, checkpoint: number | null) => {
      const amount = size(wanted < wallet.free ? wanted : wallet.free);
      if (amount <= 0n) return;
      wallet.free -= amount;
      live[mission]! += amount;
      commits.push({ wallet, mission, amount, checkpoint });
    };

    const crowdShare = (wallet: Wallet) => fractionOf(wallet.free, rng.range(cfg.commitFraction[0], cfg.commitFraction[1]));

    for (const w of wallets) {
      if (w.strategy === "whale" || w.strategy === "split") place(w, pick(w, true), fractionOf(w.free, cfg.whaleFraction), null);
      else if (w.strategy === "farmer") place(w, pick(w, true), w.free, null);
      else if (w.strategy === "early" && rng.next() < participation) place(w, pick(w, false), crowdShare(w), null);
      else if (w.strategy === "casual" && rng.next() < participation) {
        place(w, pick(w, false), crowdShare(w), rng.next() < 0.8 ? null : rng.int(n));
      } else if (w.strategy === "candle" && rng.next() < participation) place(w, pick(w, false), crowdShare(w), rng.int(n));
    }

    // Abstains until the threshold is half its starting value, then wins as cheaply as it can.
    for (const w of wallets) {
      if (w.strategy !== "saboteur") continue;
      if (roundThreshold * 2n <= cfg.rules.initialThreshold) {
        const wanted = maxOf([...live, roundThreshold]) + ONE_EMBER;
        place(w, 0, wanted - live[0]!, null);
      }
    }

    // Snipers move last, seeing every tally, and commit just enough to take the lead.
    const beforeSnipers = new Set(commits);
    for (const w of wallets) {
      if (w.strategy !== "sniper") continue;
      const mission = pick(w, false);
      const gap = maxOf(live) - live[mission]! + ONE_EMBER;
      if (maxOf(live) > live[mission]!) place(w, mission, gap, n - 1);
    }

    const k = cfg.closeMode === "hard" ? n - 1 : forcedDraw(rng.int(n), n);
    const isCounted = (c: Commit) => c.checkpoint === null || c.checkpoint <= k;
    const tally = (list: Iterable<Commit>) => {
      const sums = Array.from({ length: cfg.missions }, () => 0n);
      for (const c of list) if (isCounted(c)) sums[c.mission]! += c.amount;
      return sums;
    };
    const selection = selectOutcome(tally(commits), roundThreshold);
    const without = selectOutcome(tally(beforeSnipers), roundThreshold);
    if (selection.kind === "selected" && (without.kind !== "selected" || without.winner !== selection.winner)) {
      if (commits.some((c) => c.wallet.strategy === "sniper" && c.mission === selection.winner && isCounted(c))) snipesDecided++;
    }

    let outcome: RoundOutcome;
    let payout = 0n;
    let winner: number | null = null;
    let counted = 0n;
    if (selection.kind === "below") {
      outcome = "below";
      threshold = adjustThreshold(threshold, cfg.rules.downBps, cfg.rules.minThreshold, cfg.initialSupply);
      hearth += budget;
      recycled += budget;
    } else if (selection.kind === "tie") {
      outcome = "tie";
      hearth += budget;
      recycled += budget;
    } else {
      winner = selection.winner;
      counted = selection.counted;
      threshold = adjustThreshold(threshold, cfg.rules.upBps, cfg.rules.minThreshold, cfg.initialSupply);
      payout = matchedPayout(budget, counted, target);
      hearth += budget - payout;
      recycled += budget - payout;
      if (rng.next() < cfg.missDelivery) outcome = "missed";
      else if (rng.next() < cfg.reviewerAbsent) outcome = "absent";
      else if (rng.next() < cfg.reject) outcome = "rejected";
      else outcome = "accepted";
      if (outcome === "accepted") {
        paid += payout;
      } else {
        hearth += payout;
        recycled += payout;
      }
    }

    const wonBy = new Set<Strategy>();
    for (const c of commits) {
      const entry = totals.get(c.wallet.strategy)!;
      if (outcome === "accepted" && c.mission === winner && isCounted(c)) {
        burned += c.amount;
        supply -= c.amount;
        c.wallet.ash += c.amount;
        entry.burned += c.amount;
        entry.ash += c.amount;
        wonBy.add(c.wallet.strategy);
      } else {
        c.wallet.free += c.amount;
        refunded += c.amount;
        entry.refunded += c.amount;
        if (!isCounted(c)) lateRefunded += c.amount;
      }
    }
    for (const strategy of wonBy) totals.get(strategy)!.roundsWon++;
    const record: RoundRecord = { day, budget, threshold: roundThreshold, target, checkpoint: k, outcome, winner, counted, payout: outcome === "accepted" ? payout : 0n };
    rounds.push(record);
    if (options.onRound) {
      const placed = commits.map((c) => ({ wallet: wallets.indexOf(c.wallet), mission: c.mission, amount: c.amount, checkpoint: c.checkpoint }));
      options.onRound({ day, stoke, skipped: false, budget, record, matched: payout, commits: placed, after: snapshot() });
    }
  }

  let stokeSinceRound = 0n;

  function forcedDraw(seeded: number, n: number): number {
    const forced = options.draws?.[rounds.length];
    if (forced === undefined) return seeded;
    if (!Number.isInteger(forced) || forced < 0 || forced >= n) throw new Error(`draw ${forced} is outside 0..${n - 1}`);
    return forced;
  }

  for (let day = 0; day < cfg.days; day++) {
    const stoke = day < cfg.stokeUntilDay ? cfg.stokePerDay : 0n;
    hearth += stoke;
    stoked += stoke;
    stokeSinceRound += stoke;
    for (const w of wallets) {
      const chance = w.strategy === "farmer" ? 1 : w.strategy === "casual" || w.strategy === "early" || w.strategy === "candle" ? cfg.faucetClaim : 0;
      if (chance > 0 && faucet >= cfg.faucetAmount && rng.next() < chance) {
        faucet -= cfg.faucetAmount;
        w.free += cfg.faucetAmount;
      }
    }
    if (faucet < cfg.faucetAmount && faucetEmptyDay === null) faucetEmptyDay = day;
    if (day % cfg.roundEveryDays === 0) {
      playRound(day, stokeSinceRound);
      stokeSinceRound = 0n;
    }
    series.push({ day, supply, burned, hearth, threshold });
  }

  const ash = wallets.map((w) => w.ash);
  return {
    scenario: cfg.name,
    seed,
    rounds,
    series,
    burned,
    refunded,
    lateRefunded,
    paid,
    recycled,
    stoked,
    skipped,
    snipesDecided,
    supply,
    hearth,
    undistributed,
    faucetRemaining: faucet,
    faucetEmptyDay,
    walletTotal: wallets.reduce((sum, w) => sum + w.free, 0n),
    ashTotal: ash.reduce((sum, v) => sum + v, 0n),
    ashGini: gini(ash),
    ashTop10: topShare(ash, 10),
    byStrategy: totals,
  };
}
