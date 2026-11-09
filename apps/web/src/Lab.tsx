import { useState } from "react";
import type { RoundView } from "@bonfire/protocol";
import { EXPLORER_TX } from "./chain";
import { ATTACKS, reasonOf, verdictOf, type Attack, type Verdict } from "./lab-attacks";
import { explain, TxFailure, type Session } from "./session";

type Result =
  | { state: "sending" }
  | { state: "not-sent"; reason: string }
  | { state: "answered"; verdict: Verdict; reason: string; hash: string | null };

/** Forbidden actions a visitor sends from their own account, with the chain's real answer. */
export function LabPage({ session, round }: { session: Session | null; round: RoundView | null }) {
  const [results, setResults] = useState<Record<string, Result>>({});
  const busy = Object.values(results).some((r) => r.state === "sending");

  async function attempt(attack: Attack) {
    if (!session) return;
    const call = attack.build(round, session.accountId);
    if (!call) return;
    setResults((r) => ({ ...r, [attack.id]: { state: "sending" } }));
    let result: Result;
    try {
      const hash = await session.call(call.method, call.args, call.deposit);
      result = { state: "answered", verdict: verdictOf(attack, { failed: false, text: "" }), reason: "The transaction succeeded.", hash };
    } catch (error) {
      if (error instanceof TxFailure) {
        result = { state: "answered", verdict: verdictOf(attack, { failed: true, text: error.message }), reason: reasonOf(error.message), hash: error.hash };
      } else {
        result = { state: "not-sent", reason: explain(error) };
      }
    }
    setResults((r) => ({ ...r, [attack.id]: result }));
  }

  return (
    <div className="narrow">
      <section className="card">
        <h2>Try to steal the fire</h2>
        <p>Each button sends a real transaction from your account that tries something the rules forbid. The contract should refuse every one, and you'll see its actual answer with a link to the transaction.</p>
        <p className="hint">Each attempt costs a little test NEAR for gas. Nothing else changes, because a refused transaction rolls back.</p>
        {!session && <p className="hint">Sign in on <a href="#/">The fire</a> with a guest account or a wallet to try these.</p>}
      </section>
      <ul className="attacks">
        {ATTACKS.map((attack) => {
          const call = session ? attack.build(round, session.accountId) : attack.build(round, "you.testnet");
          const result = results[attack.id];
          return (
            <li key={attack.id} className="card">
              <h3>{attack.title}</h3>
              <p className="hint">{attack.tries}</p>
              <button className="small" disabled={!session || !call || busy} onClick={() => void attempt(attack)}>
                {result?.state === "sending" ? "Sending…" : call ? "Try it" : "Needs a round in backing"}
              </button>
              {result && result.state !== "sending" && <Answer attack={attack} result={result} />}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Answer({ attack, result }: { attack: Attack; result: Exclude<Result, { state: "sending" }> }) {
  if (result.state === "not-sent") return <p className="hint" role="status">Not sent: {result.reason}</p>;
  const link = result.hash && (
    <a href={EXPLORER_TX + result.hash} target="_blank" rel="noreferrer">View the transaction</a>
  );
  if (result.verdict === "refused") {
    return (
      <div className="answer ok" role="status">
        <p><strong>Refused.</strong> The chain answered <code>{result.reason}</code>. {attack.why}</p>
        {link}
      </div>
    );
  }
  if (result.verdict === "refused-otherwise") {
    return (
      <div className="answer warn" role="status">
        <p><strong>Refused, for a different reason than expected:</strong> <code>{result.reason}</code>.</p>
        {link}
      </div>
    );
  }
  return (
    <div className="answer bad" role="status">
      <p><strong>This went through, and it should not have.</strong> Please report it with the transaction link.</p>
      {link}
    </div>
  );
}
