import { useEffect, useState } from "react";
import type { Audit, Config, RoundView, U128 } from "@bonfire/protocol";
import build from "../../../res/build.json";
import { CONTRACT, loadAccountFacts, view, viewAll } from "./chain";
import { showEmber, showNear } from "./format";
import { burnedInLog, burnLog, labelOf } from "./ledger-data";

interface LedgerData {
  audit: Audit;
  config: Config;
  rounds: RoundView[];
  stokers: [string, U128][];
  codeHash: string;
  accessKeys: number;
}

async function loadLedger(): Promise<LedgerData> {
  const [audit, config, rounds, stokers, facts] = await Promise.all([
    view<Audit>("audit"),
    view<Config>("get_config"),
    viewAll<RoundView>("get_rounds"),
    viewAll<[string, U128]>("get_stokers", 100),
    loadAccountFacts(),
  ]);
  return { audit, config, rounds, stokers, ...facts };
}

/** Hearth, burn log and proof desk on one page. Everything here is read from the chain. */
export function LedgerPage() {
  const [data, setData] = useState<LedgerData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const read = () =>
      loadLedger()
        .then((d) => live && (setData(d), setError(null)))
        .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    void read();
    const poll = setInterval(read, 30_000);
    return () => {
      live = false;
      clearInterval(poll);
    };
  }, []);

  if (!data) {
    return (
      <div className="narrow">
        <div className="card muted">{error ? `Couldn't read the ledger: ${error} Retrying.` : "Reading the ledger from the chain…"}</div>
      </div>
    );
  }

  const { audit, config, rounds, stokers, codeHash, accessKeys } = data;
  const log = burnLog(rounds, BigInt(audit.initial_supply));
  const logMatches = burnedInLog(log) === BigInt(audit.total_burned);
  const isRes = codeHash === build.code_hash;
  const rules = config.rules;
  const sortedStokers = [...stokers].sort((a, b) => (BigInt(b[1]) > BigInt(a[1]) ? 1 : -1));

  return (
    <div className="narrow ledger">
      <section className="card">
        <h2>Proof</h2>
        <ul className="checks">
          <Check ok={accessKeys === 0} text={accessKeys === 0 ? "No access keys: nobody can change or upgrade this contract." : `${accessKeys} access key${accessKeys === 1 ? "" : "s"}: this development deployment can still be changed. The final deployment will have none.`} />
          <Check ok={isRes} text={isRes ? "The deployed code is the reproducible build in res/." : "The deployed code is an earlier development build, not the reproducible build in res/."} />
          <Check ok={audit.supply_ok} text="Supply reconciles: initial supply minus burns equals what exists." />
          <Check ok={audit.escrow_ok} text="Escrow reconciles: the contract holds every committed EMBER and the faucet pool." />
          <Check ok={audit.near_ok} text="NEAR reconciles: the balance covers the Hearth, reserved budgets, claims, deposits and storage." />
          <Check ok={logMatches} text={logMatches ? "The burn log below adds up to the contract's total burned." : "The burn log below doesn't add up to the contract's total burned."} />
        </ul>
        <dl className="facts wide">
          <div><dt>Contract</dt><dd className="mono">{CONTRACT}</dd></div>
          <div><dt>Code hash</dt><dd className="mono">{codeHash}</dd></div>
          <div><dt>Reproducible build</dt><dd className="mono">{build.code_hash}</dd></div>
          <div><dt>Built from</dt><dd className="mono">{build.source_commit.slice(0, 7)}</dd></div>
        </dl>
        <p className="hint">Anyone with the source can check this without a key: <code>npm run observe</code>.</p>
      </section>

      <section className="card">
        <h2>Supply</h2>
        <dl className="facts wide">
          <div><dt>Minted at genesis</dt><dd>{showEmber(audit.initial_supply)}</dd></div>
          <div><dt>Burned</dt><dd>{showEmber(audit.total_burned)}</dd></div>
          <div><dt>Exists now</dt><dd>{showEmber(audit.total_supply)}</dd></div>
          <div><dt>Committed in escrow</dt><dd>{showEmber(audit.escrow_total)}</dd></div>
          <div><dt>Left in the faucet</dt><dd>{showEmber(audit.faucet_remaining)}</dd></div>
          <div><dt>Ash recorded</dt><dd>{showEmber(audit.total_ash)}</dd></div>
        </dl>
        <p className="hint">Nothing can mint after genesis. EMBER burns only when a round's work is accepted.</p>
      </section>

      <section className="card">
        <h2>Burn log</h2>
        <ol className="log">
          {log.map((entry) =>
            entry.kind === "mint" ? (
              <li key="mint">
                <div className="row spread"><span>Genesis mint</span><span className="amount">+{showEmber(entry.amount)}</span></div>
                <p className="hint">The whole supply, once: {showEmber(config.initial_supply)} EMBER.</p>
              </li>
            ) : (
              <li key={entry.round}>
                <div className="row spread">
                  <span>Round {entry.round}: {entry.mission}{entry.demo && <span className="tag">demo</span>}</span>
                  <span className="amount">−{showEmber(entry.amount)}</span>
                </div>
                <p className="hint">
                  Accepted{entry.at ? ` ${new Date(entry.at).toISOString().slice(0, 16).replace("T", " ")} UTC` : ""}. Creator payout {showNear(entry.payout)} NEAR, {entry.paid ? "paid" : "claimable"}.
                </p>
              </li>
            ),
          )}
        </ol>
        {log.length === 1 && <p className="hint">No round has been accepted yet, so nothing has burned.</p>}
      </section>

      <section className="card">
        <h2>The Hearth</h2>
        <dl className="facts wide">
          <div><dt>In the pool</dt><dd>{showNear(audit.hearth_pool)} <small>NEAR</small></dd></div>
          <div><dt>Reserved for open rounds</dt><dd>{showNear(audit.reserved_total)} <small>NEAR</small></dd></div>
          <div><dt>Paid to creators</dt><dd>{showNear(audit.total_paid)} <small>NEAR</small></dd></div>
          <div><dt>Recycled from failed rounds</dt><dd>{showNear(audit.total_recycled)} <small>NEAR</small></dd></div>
          <div><dt>Claimable now</dt><dd>{showNear(BigInt(audit.claims_available) + BigInt(audit.claims_pending))} <small>NEAR</small></dd></div>
          <div><dt>Stoked in total</dt><dd>{showNear(audit.total_stoked)} <small>NEAR</small></dd></div>
        </dl>
        <p className="hint">There is no withdrawal method. NEAR leaves the Hearth only as a payout for accepted work. Each round's budget is {rules.budget_bps / 100}% of the pool when it opens.</p>
        <h3>Who stoked it</h3>
        <ul className="log">
          {sortedStokers.map(([account, amount]) => (
            <li key={account} className="row spread">
              <span className="mono">{account}{labelOf(account) && <span className="tag">{labelOf(account)}</span>}</span>
              <span className="amount">{showNear(amount)}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>Rules</h2>
        <p className="hint">Fixed when the contract was initialized. No call can change them, or set a round's budget, threshold or target.</p>
        <dl className="facts wide">
          <div><dt>Budget</dt><dd>{rules.budget_bps / 100}% <small>of the Hearth, min {showNear(rules.min_budget)} NEAR</small></dd></div>
          <div><dt>Next threshold</dt><dd>{showEmber(audit.next_threshold)}</dd></div>
          <div><dt>After a winner</dt><dd>×{rules.up_bps / 10_000}</dd></div>
          <div><dt>After no qualifier</dt><dd>×{rules.down_bps / 10_000}</dd></div>
          <div><dt>Target</dt><dd>{rules.target_multiple}× <small>the threshold</small></dd></div>
          <div><dt>Threshold floor</dt><dd>{showEmber(rules.min_threshold)}</dd></div>
        </dl>
        <p className="hint">The values come from the 60-day simulation on the <a href="#/simulator">Simulator</a> page.</p>
      </section>
    </div>
  );
}

function Check({ ok, text }: { ok: boolean; text: string }) {
  return (
    <li className={ok ? "check ok" : "check no"}>
      <span aria-hidden="true">{ok ? "✓" : "✗"}</span>
      <span className="sr">{ok ? "Holds:" : "Does not hold:"}</span> {text}
    </li>
  );
}
