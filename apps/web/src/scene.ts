/** Turns what the chain says about a round into what the page shows. Nothing here invents state. */
import type { RoundView } from "@bonfire/protocol";

export type FireStage = 0 | 1 | 2 | 3;
export type MascotPose = "idle" | "excited" | "sleeping" | "shrug";
export type Mood = "calm" | "candle" | "cold" | "burned";

export interface Scene {
  /** Null when logs aren't on stage: the fire has burned to ash or the shrugging mascot brings its own. */
  fire: FireStage | null;
  mascot: MascotPose;
  candle: "lit" | "out" | null;
  mood: Mood;
  description: string;
}

/** Cold until backed, small below the threshold, healthy past it, roaring at the target. */
export function fireStage(tally: bigint, threshold: bigint, target: bigint): FireStage {
  if (tally <= 0n) return 0;
  if (tally < threshold) return 1;
  return tally < target ? 2 : 3;
}

export interface Leader {
  mission: number;
  total: bigint;
  tied: boolean;
}

/** The mission with the most EMBER behind it, or null while nothing is committed. */
export function leaderOf(round: RoundView): Leader | null {
  let best: Leader | null = null;
  round.live_totals.forEach((value, mission) => {
    const total = BigInt(value);
    if (total <= 0n) return;
    if (!best || total > best.total) best = { mission, total, tied: false };
    else if (total === best.total) best.tied = true;
  });
  return best;
}

const STAGE_WORDS = ["cold logs", "a small flame", "a healthy fire", "a roaring fire"];

export function sceneOf(round: RoundView | null): Scene {
  if (!round) return { fire: 0, mascot: "sleeping", candle: null, mood: "cold", description: "Cold logs and a sleeping mascot. No round has been opened." };
  const r = round.round;
  const threshold = BigInt(r.threshold);
  const target = BigInt(r.target);

  switch (round.phase) {
    case "Scheduled":
      return { fire: 0, mascot: "sleeping", candle: null, mood: "calm", description: "Cold logs and a sleeping mascot, waiting for the round to open." };
    case "Backing":
    case "Candle":
    case "AwaitingSelection": {
      const stage = fireStage(leaderOf(round)?.total ?? 0n, threshold, target);
      const candle = round.phase === "Backing" ? null : round.phase === "Candle" ? "lit" : "out";
      const candleWords = candle === "lit" ? ", with the candle burning beside it" : candle === "out" ? ", with the candle blown out" : "";
      return { fire: stage, mascot: stage === 3 ? "excited" : "idle", candle, mood: candle ? "candle" : "calm", description: `The leading mission has built ${STAGE_WORDS[stage]}${candleWords}.` };
    }
    case "AwaitingWork":
    case "AwaitingReview": {
      const stage = fireStage(BigInt(r.counted), threshold, target);
      return { fire: stage, mascot: "idle", candle: null, mood: "calm", description: `The winning mission's counted EMBER holds ${STAGE_WORDS[stage]} while the work is finished and reviewed.` };
    }
    case "Accepted":
      return { fire: null, mascot: "excited", candle: null, mood: "burned", description: "The fire has burned down to ash and the mascot is celebrating. The work was accepted." };
    default:
      return { fire: null, mascot: "shrug", candle: null, mood: "cold", description: "The mascot shrugs beside wet logs. This round ended without a burn." };
  }
}

export interface Clock {
  label: string;
  ms: number;
}

/** The next deadline a visitor should watch, if the round has one. `nowMs` is chain time. */
export function clockOf(round: RoundView, nowMs: number): Clock | null {
  const r = round.round;
  switch (round.phase) {
    case "Scheduled":
      return { label: "Opens in", ms: r.open_at_ms - nowMs };
    case "Backing":
      return { label: "Candle lights in", ms: r.candle_start_ms - nowMs };
    case "Candle":
      return { label: "Closes within", ms: r.backing_close_ms - nowMs };
    case "AwaitingWork":
      return { label: "Work due in", ms: r.delivery_deadline_ms - nowMs };
    case "AwaitingReview":
      return { label: "Review due in", ms: r.review_deadline_ms - nowMs };
    default:
      return null;
  }
}
