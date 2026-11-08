import type { Group, Scenario } from "./engine.ts";
import { ONE_EMBER as E, ONE_NEAR as N, type Rules } from "./rules.ts";

/** The values this report recommends, so the scenario tables describe what would ship. */
export const CANDIDATE_RULES: Rules = {
  budgetBps: 2_500n,
  minBudget: N,
  initialThreshold: 10_000n * E,
  minThreshold: 1_000n * E,
  upBps: 10_500n,
  downBps: 8_500n,
  targetMultiple: 4n,
};

const CROWD: Group = { strategy: "casual", wallets: 40, wealthEach: 10_000n * E };

export function base(name: string, overrides: Partial<Scenario> = {}): Scenario {
  return {
    name,
    days: 60,
    roundEveryDays: 3,
    missions: 3,
    checkpoints: 12,
    closeMode: "candle",
    rules: CANDIDATE_RULES,
    groups: [CROWD],
    initialSupply: 1_000_000n * E,
    faucetPool: 150_000n * E,
    faucetAmount: 1_000n * E,
    faucetClaim: 0.05,
    initialHearth: 8n * N,
    stokePerDay: N / 2n,
    stokeUntilDay: 60,
    participationStart: 0.7,
    participationEnd: 0.7,
    commitFraction: [0.1, 0.4],
    whaleFraction: 0.3,
    coarse: 0n,
    missDelivery: 0.05,
    reject: 0.05,
    reviewerAbsent: 0.02,
    ...overrides,
  };
}

const WHALE_WEALTH = 300_000n * E;
const THIN_CROWD: Group = { strategy: "casual", wallets: 12, wealthEach: 5_000n * E };

export const scenarios = {
  steady: () => base("steady"),
  falling: () => base("falling", { participationStart: 0.8, participationEnd: 0.08, stokeUntilDay: 10 }),
  whale: () => base("whale", { groups: [CROWD, { strategy: "whale", wallets: 1, wealthEach: WHALE_WEALTH }] }),
  singleWhale: () => base("single-whale", { groups: [CROWD, { strategy: "whale", wallets: 1, wealthEach: WHALE_WEALTH }] }),
  splitWhale: () => base("split-whale", { groups: [CROWD, { strategy: "split", wallets: 10, wealthEach: WHALE_WEALTH / 10n }] }),
  snipersCandle: () => base("snipers-candle", { groups: [CROWD, { strategy: "sniper", wallets: 8, wealthEach: 30_000n * E }] }),
  snipersHard: () => base("snipers-hard", { closeMode: "hard", groups: [CROWD, { strategy: "sniper", wallets: 8, wealthEach: 30_000n * E }] }),
  deadlines: () => base("deadlines", { missDelivery: 0.35, reviewerAbsent: 0.25, reject: 0.1 }),
  tiesAndUnder: () =>
    base("ties-and-under", {
      groups: [{ strategy: "casual", wallets: 10, wealthEach: 8_000n * E }],
      coarse: 2_000n * E,
      commitFraction: [0.4, 0.8],
      participationStart: 0.5,
      participationEnd: 0.5,
      faucetClaim: 0,
      rules: { ...CANDIDATE_RULES, initialThreshold: 4_000n * E },
    }),
  rapidBurns: () => base("rapid-burns", { participationStart: 1, participationEnd: 1, commitFraction: [0.6, 0.95], faucetClaim: 0.02 }),
  faucetFarming: () => base("faucet-farming", { groups: [CROWD, { strategy: "farmer", wallets: 60, wealthEach: 0n }] }),
  mix: () =>
    base("strategy-mix", {
      groups: [
        { strategy: "casual", wallets: 20, wealthEach: 10_000n * E },
        { strategy: "early", wallets: 8, wealthEach: 10_000n * E },
        { strategy: "candle", wallets: 8, wealthEach: 10_000n * E },
        { strategy: "sniper", wallets: 8, wealthEach: 10_000n * E },
        { strategy: "whale", wallets: 1, wealthEach: 80_000n * E },
        { strategy: "split", wallets: 8, wealthEach: 10_000n * E },
      ],
    }),
  honestWhaleThinCrowd: (rules: Rules = CANDIDATE_RULES) =>
    base("honest-whale", { rules, groups: [THIN_CROWD, { strategy: "whale", wallets: 1, wealthEach: WHALE_WEALTH }], whaleFraction: 0.1, faucetClaim: 0 }),
  saboteurThinCrowd: (rules: Rules = CANDIDATE_RULES) =>
    base("saboteur", { rules, groups: [THIN_CROWD, { strategy: "saboteur", wallets: 1, wealthEach: WHALE_WEALTH }], faucetClaim: 0 }),
};
