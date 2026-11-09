/** Turns contract views into the Ledger's burn log and labels. Derived from chain data only. */
import type { RoundView } from "@bonfire/protocol";

/** Accounts the team runs on testnet. They are always labeled, never presented as outside users. */
const TEAM_PREFIX = "bonfire-meraj-";
const GUEST_PARENT = ".bonfire-meraj-guests.testnet";

export function labelOf(account: string): "team demo actor" | "guest" | null {
  if (account.endsWith(GUEST_PARENT)) return "guest";
  if (account.startsWith(TEAM_PREFIX)) return "team demo actor";
  return null;
}

export type LogEntry =
  | { kind: "mint"; amount: bigint }
  | { kind: "burn"; round: number; mission: string; amount: bigint; payout: bigint; paid: boolean; at: number | null; demo: boolean };

/** Genesis first, then every accepted round's burn, oldest first. */
export function burnLog(rounds: RoundView[], initialSupply: bigint): LogEntry[] {
  const burns = rounds
    .filter((r) => r.phase === "Accepted")
    .map((view): LogEntry => {
      const r = view.round;
      const mission = r.winner === null ? "" : (r.missions[r.winner]?.title ?? "");
      return {
        kind: "burn",
        round: r.id,
        mission,
        amount: BigInt(r.burned),
        payout: BigInt(r.payout),
        paid: r.payout_state === "Paid",
        at: r.decided_at_ms,
        demo: mission.startsWith("[demo]"),
      };
    });
  return [{ kind: "mint", amount: initialSupply }, ...burns];
}

/** The burns in the log add up to the contract's own total. */
export function burnedInLog(log: LogEntry[]): bigint {
  return log.reduce((sum, e) => (e.kind === "burn" ? sum + e.amount : sum), 0n);
}
