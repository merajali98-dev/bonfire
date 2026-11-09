import { roundsToSettle, toPosition, totalsOf, type Position } from "./positions";
import type { Holdings } from "./chain";
import { countdown, showEmber } from "./format";
import type { Session } from "./session";
import type { ActionProps } from "./App";

const ACTION_TEXT = {
  withdraw: "Withdraw",
  select: "Draw the candle",
  expire: "Close the round",
} as const;

function toneOf(p: Position): string {
  if (p.burned > 0n) return "burned";
  if (p.refundable > 0n) return "refund";
  return p.locked > 0n ? "locked" : "open";
}

export function EmbersPage({ session, holdings, faucetLabel, onClaim, now, busy, run }: {
  session: Session;
  holdings: Holdings | null;
  faucetLabel: string;
  onClaim: () => Promise<string | null | void>;
  now: number;
} & ActionProps) {
  if (!holdings) return <section className="card muted">Reading your embers from the chain…</section>;

  const positions = holdings.commitments.flatMap((record) => {
    const round = holdings.rounds[record.round_id];
    return round ? [toPosition(record, round, round.now_ms + (now - holdings.readAt))] : [];
  });
  const totals = totalsOf(positions);
  const settleRounds = roundsToSettle(positions);
  const pendingAsh = positions.filter((p) => p.action === "settle").reduce((sum, p) => sum + p.burned, 0n);
  const faucetWait = holdings.faucetNextMs > 0 ? holdings.faucetNextMs - now : 0;

  async function settleAll() {
    let last: string | null = null;
    for (const round_id of settleRounds) last = await session.call("settle", { round_id, account_id: session.accountId }, 0n);
    return last;
  }

  function act(p: Position) {
    const id = p.record.round_id;
    if (p.action === "withdraw") return run("Withdrawing…", () => session.call("withdraw", { round_id: id, mission: p.record.mission, amount: p.record.commitment.pre }, 0n), "Withdrawn. Your EMBER is free again.");
    if (p.action === "select") return run("Drawing the candle…", () => session.call("select", { round_id: id }, 0n), "The candle was drawn.");
    return run("Closing the round…", () => session.call("expire", { round_id: id }, 0n), "The round is closed. Your EMBER is refundable.");
  }

  const reclaimText = totals.refundable > 0n ? `Reclaim ${showEmber(totals.refundable)} EMBER` : `Record ${showEmber(pendingAsh)} Ash`;

  return (
    <>
      <section className="card">
        <h2>My embers</h2>
        <div className="ledger-head">
          <div className="stat">
            <span className="label">Free to back a mission</span>
            <span className="big">{showEmber(holdings.balance)}<small> EMBER</small></span>
          </div>
          <div className="ash-tally">
            <div><span className="label">Ash</span><br /><span className="ash-value">{showEmber(holdings.ash)}</span></div>
            <img src="/art/ash.webp" alt="" />
          </div>
        </div>
        <dl className="facts wide">
          <div><dt>Committed</dt><dd>{showEmber(totals.committed)}</dd></div>
          <div><dt>Candle-locked</dt><dd>{showEmber(totals.locked)}</dd></div>
          <div><dt>Refundable</dt><dd>{showEmber(totals.refundable)}</dd></div>
          <div><dt>Burned</dt><dd>{showEmber(totals.burned + BigInt(holdings.ash))}</dd></div>
        </dl>
        {settleRounds.length > 0 && (
          <button disabled={busy} onClick={() => run("Settling…", settleAll, "Settled. Your EMBER and storage deposit are back.")}>{reclaimText}</button>
        )}
        {settleRounds.length > 1 && <p className="hint">This covers {settleRounds.length} rounds, one approval each.</p>}
        <button className="ghost" disabled={busy || faucetWait > 0} onClick={() => run("Claiming EMBER…", onClaim, "EMBER claimed.")}>
          {faucetWait > 0 ? `Next claim in ${countdown(faucetWait)}` : faucetLabel}
        </button>
      </section>

      <section className="card">
        <h2>Your missions</h2>
        {positions.length === 0 ? (
          <div className="empty">
            <img src="/art/mascot-sleeping.webp" alt="" />
            <p>Nothing is committed right now. <a href="#/">Back a mission</a> and it will show up here until it's settled.</p>
          </div>
        ) : (
          <ul className="positions">
            {positions.map((p) => (
              <li key={`${p.record.round_id}-${p.record.mission}`}>
                <div className="row spread">
                  <span className="title plain">{p.title}</span>
                  <span className="amount">{showEmber(p.record.total)}</span>
                </div>
                <div className="row status">
                  <span className={`pill ${toneOf(p)}`}>{p.label}</span>
                  <span>Round {p.record.round_id}</span>
                </div>
                <p className="hint">{p.detail}</p>
                {p.action && p.action !== "settle" && (
                  <button className="ghost small" disabled={busy} onClick={() => act(p)}>{ACTION_TEXT[p.action]}</button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
