/** What each open commitment is worth right now, and which single action moves it forward. */
import type { CommitmentView, RoundView } from "@bonfire/protocol";

export type PositionAction = "withdraw" | "select" | "expire" | "settle" | null;

export interface Position {
  record: CommitmentView;
  round: RoundView;
  title: string;
  label: string;
  detail: string;
  action: PositionAction;
  committed: bigint;
  locked: bigint;
  refundable: bigint;
  /** Burned on an accepted round, with its Ash not yet recorded. */
  burned: bigint;
}

type Parts = Pick<Position, "label" | "detail" | "action" | "committed" | "locked" | "refundable" | "burned">;
const none = { committed: 0n, locked: 0n, refundable: 0n, burned: 0n };

function classify(record: CommitmentView, round: RoundView, nowMs: number): Parts {
  const r = round.round;
  const total = BigInt(record.total);
  const counted = BigInt(record.counted ?? "0");
  const isWinner = r.winner === record.mission;
  const refund = (label: string, detail: string): Parts => ({ ...none, label, detail, action: "settle", refundable: total });

  switch (r.status) {
    case "Funded":
      if (round.phase === "Backing") return { ...none, label: "Committed", detail: "You can withdraw until the candle lights.", action: "withdraw", committed: total };
      if (round.phase === "AwaitingSelection") return { ...none, label: "Waiting for the draw", detail: "Backing has closed. Drawing the candle decides the result, and anyone can do it.", action: "select", locked: total };
      return { ...none, label: "Candle-locked", detail: "Locked until the candle is drawn. You can still add.", action: null, locked: total };
    case "Accepted":
      if (!isWinner) return refund("Refundable", "Your mission didn't win.");
      return {
        ...none,
        label: "Burned",
        detail: total > counted ? "Your counted EMBER burned. Settle to record your Ash and get back the part after the drawn checkpoint." : "Your EMBER burned and the work shipped. Settle to record your Ash.",
        action: "settle",
        refundable: total - counted,
        burned: counted,
      };
    case "AwaitingWork":
    case "AwaitingReview": {
      if (!isWinner) return refund("Refundable", "Your mission didn't win.");
      const deadline = r.status === "AwaitingWork" ? r.delivery_deadline_ms : r.review_deadline_ms;
      if (nowMs >= deadline) {
        return { ...none, label: "Deadline passed", detail: "The deadline passed with no result. Closing the round makes all of this refundable, and anyone can do it.", action: "expire", locked: counted, refundable: total - counted };
      }
      const late = total - counted;
      return {
        ...none,
        label: r.status === "AwaitingWork" ? "Waiting for the work" : "Waiting for review",
        detail: late > 0n ? "Your counted EMBER burns only if the work is accepted. The part after the drawn checkpoint is refundable now." : "Your EMBER burns only if the work is accepted. Otherwise you get it back.",
        action: late > 0n ? "settle" : null,
        locked: counted,
        refundable: late,
      };
    }
    default:
      return refund("Refundable", "This round ended without a burn, so all of it comes back.");
  }
}

export function toPosition(record: CommitmentView, round: RoundView, nowMs: number): Position {
  const title = round.round.missions[record.mission]?.title ?? `Mission ${record.mission}`;
  return { record, round, title, ...classify(record, round, nowMs) };
}

export interface Totals {
  committed: bigint;
  locked: bigint;
  refundable: bigint;
  burned: bigint;
}

export function totalsOf(positions: Position[]): Totals {
  return positions.reduce(
    (sum, p) => ({
      committed: sum.committed + p.committed,
      locked: sum.locked + p.locked,
      refundable: sum.refundable + p.refundable,
      burned: sum.burned + p.burned,
    }),
    { committed: 0n, locked: 0n, refundable: 0n, burned: 0n },
  );
}

/** `settle` works per round, so one call covers every mission the account backed in it. */
export function roundsToSettle(positions: Position[]): number[] {
  return [...new Set(positions.filter((p) => p.action === "settle").map((p) => p.record.round_id))].sort((a, b) => a - b);
}
