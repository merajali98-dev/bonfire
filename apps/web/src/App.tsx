import { useCallback, useEffect, useState } from "react";
import { COMMIT_DEPOSIT, type RoundView } from "@bonfire/protocol";
import { Brief } from "./Brief";
import { CONTRACT, EXPLORER_TX, loadHoldings, loadSnapshot, view, type Holdings, type Snapshot } from "./chain";
import { EmbersPage } from "./Embers";
import { Hero } from "./Fire";
import { LabPage } from "./Lab";
import { LedgerPage } from "./Ledger";
import { MadePage } from "./Made";
import { PracticePage } from "./Practice";
import { countdown, parseEmber, shortAccount, showEmber, showNear } from "./format";
import { sceneOf } from "./scene";
import { Share } from "./Share";
import { SimulatorPage } from "./Simulator";
import { connectWallet, createGuest, explain, restoreGuest, restoreWallet, type Session } from "./session";

type Notice = { tone: "busy" | "good" | "bad"; text: string; hash?: string | null };

export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [holdings, setHoldings] = useState<Holdings | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [route, setRoute] = useState(routeOf());

  useEffect(() => {
    const onChange = () => {
      setRoute(routeOf());
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  const refresh = useCallback(async () => {
    try {
      setSnapshot(await loadSnapshot());
      setLoadError(null);
    } catch (error) {
      setLoadError(explain(error));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const poll = setInterval(() => void refresh(), 15_000);
    const clock = setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      clearInterval(poll);
      clearInterval(clock);
    };
  }, [refresh]);

  useEffect(() => {
    const guest = restoreGuest();
    if (guest) setSession(guest);
    else void restoreWallet().then((restored) => restored && setSession(restored));
  }, []);

  const refreshHoldings = useCallback(async () => {
    if (!session) return setHoldings(null);
    try {
      setHoldings(await loadHoldings(session.accountId));
    } catch {
      // The account panel keeps its last values; the round view reports network trouble.
    }
  }, [session]);

  useEffect(() => {
    void refreshHoldings();
    const poll = setInterval(() => void refreshHoldings(), 15_000);
    return () => clearInterval(poll);
  }, [refreshHoldings]);

  async function run(label: string, action: () => Promise<string | null | void>, done: string) {
    setBusy(true);
    setNotice({ tone: "busy", text: label });
    try {
      const hash = await action();
      setNotice({ tone: "good", text: done, hash: hash ?? null });
      await Promise.all([refresh(), refreshHoldings()]);
    } catch (error) {
      setNotice({ tone: "bad", text: explain(error) });
    } finally {
      setBusy(false);
    }
  }

  const signIn = (how: () => Promise<Session>, label: string) =>
    run(label, async () => setSession(await how()), "You're signed in.");

  const mood = route === "home" && snapshot ? sceneOf(snapshot.round).mood : "calm";
  useEffect(() => {
    document.body.dataset.mood = mood;
  }, [mood]);

  const claim = () => session?.call("faucet", {}, holdings?.registered === false ? BigInt(snapshot?.minStorage ?? "0") : 0n) ?? Promise.resolve(null);
  const claimLabel = `Claim ${snapshot ? showEmber(snapshot.config.faucet_amount) : ""} EMBER`;
  const account = <AccountCard session={session} holdings={holdings} claimLabel={claimLabel} claim={claim} busy={busy} now={now} run={run} signIn={signIn} clear={() => setSession(null)} />;

  return (
    <div className="page">
      <header className="top">
        <div className="brand"><img src="/art/flame-mark.webp" alt="" />BONFIRE</div>
        {route === "practice" ? (
          <span className="mode practice" title="Local practice. Nothing is sent to any network.">Practice · local only</span>
        ) : (
          <span className="mode" title="Real transactions on NEAR testnet">Live · testnet</span>
        )}
      </header>
      <nav className="tabs">
        <a href="#/" className={route === "home" ? "on" : ""} aria-current={route === "home" ? "page" : undefined}>The fire</a>
        <a href="#/embers" className={route === "embers" ? "on" : ""} aria-current={route === "embers" ? "page" : undefined}>My embers</a>
        <a href="#/practice" className={route === "practice" ? "on" : ""} aria-current={route === "practice" ? "page" : undefined}>Practice</a>
        <a href="#/made" className={route === "made" ? "on" : ""} aria-current={route === "made" ? "page" : undefined}>Made</a>
        <a href="#/ledger" className={route === "ledger" ? "on" : ""} aria-current={route === "ledger" ? "page" : undefined}>Ledger</a>
        <a href="#/lab" className={route === "lab" ? "on" : ""} aria-current={route === "lab" ? "page" : undefined}>Steal the fire</a>
        <a href="#/simulator" className={route === "simulator" ? "on" : ""} aria-current={route === "simulator" ? "page" : undefined}>Simulator</a>
      </nav>

      {route === "practice" ? (
        <PracticePage />
      ) : route === "made" ? (
        <MadePage />
      ) : route === "ledger" ? (
        <LedgerPage />
      ) : route === "simulator" ? (
        <SimulatorPage />
      ) : route === "lab" ? (
        <LabPage session={session} round={snapshot?.round ?? null} />
      ) : route === "embers" ? (
        <div className="narrow">
          {session ? <EmbersPage session={session} holdings={holdings} faucetLabel={claimLabel} onClaim={claim} now={now} busy={busy} run={run} /> : account}
        </div>
      ) : (
        <div className="home">
          <Hero snapshot={snapshot} now={now} />
          <div className="column">
            {loadError && !snapshot && <div className="card muted">Couldn't reach the network: {loadError} Retrying.</div>}
            {!snapshot && !loadError && <div className="card muted">Reading the fire from the chain…</div>}
            {snapshot && <RoundCard snapshot={snapshot} session={session} busy={busy} run={run} />}

            {snapshot?.round && session && ["Backing", "Candle"].includes(snapshot.round.phase) && (
              <CommitCard round={snapshot.round} session={session} holdings={holdings} busy={busy} now={now} run={run} />
            )}

            {account}
          </div>
        </div>
      )}

      {notice && route !== "practice" && (
        <div className={`notice ${notice.tone}`} role="status" onClick={() => notice.tone !== "busy" && setNotice(null)}>
          {notice.text}{" "}
          {notice.hash && <a href={EXPLORER_TX + notice.hash} target="_blank" rel="noreferrer">View transaction</a>}
        </div>
      )}

      <footer>
        <p>Development deployment on testnet. Test NEAR and EMBER have no value, and team accounts are labeled demo actors.</p>
        <p>Contract <code>{CONTRACT}</code></p>
      </footer>
    </div>
  );
}

const ROUTES = { "#/embers": "embers", "#/practice": "practice", "#/made": "made", "#/ledger": "ledger", "#/lab": "lab", "#/simulator": "simulator" } as const;
type Route = (typeof ROUTES)[keyof typeof ROUTES] | "home";
const routeOf = (): Route => ROUTES[window.location.hash as keyof typeof ROUTES] ?? "home";

export interface ActionProps {
  busy: boolean;
  run: (label: string, action: () => Promise<string | null | void>, done: string) => Promise<void>;
}

function RoundCard({ snapshot, session, busy, run }: { snapshot: Snapshot; session: Session | null } & ActionProps) {
  const { round } = snapshot;
  const active = round && ["Scheduled", "Backing", "Candle", "AwaitingSelection"].includes(round.phase);

  if (!round) return <NextRound snapshot={snapshot} session={session} heading="The fire hasn't been lit yet." />;
  const r = round.round;
  const target = BigInt(r.target);
  const scale = (value: bigint) => `${Math.min(100, Number((value * 1000n) / target) / 10)}%`;

  return (
    <>
      <section className="card">
        <h2>The missions</h2>
        <dl className="facts">
          <div><dt>Budget</dt><dd>{showNear(r.budget)} <small>NEAR</small></dd></div>
          <div><dt>Threshold</dt><dd>{showEmber(r.threshold)}</dd></div>
          <div><dt>Target</dt><dd>{showEmber(r.target)}</dd></div>
        </dl>
        <ul className="missions">
          {r.missions.map((mission, i) => {
            const live = BigInt(round.live_totals[i] ?? "0");
            return (
              <li key={mission.nomination_id}>
                <div className="row spread">
                  <span className="title plain">
                    {mission.title}
                    {r.winner === i && <span className="won"> · won</span>}
                  </span>
                  <span className="amount">{showEmber(live)}</span>
                </div>
                <div className="bar" aria-hidden="true">
                  <div className="fill" style={{ width: scale(live) }} />
                  <div className="mark" style={{ left: scale(BigInt(r.threshold)) }} />
                </div>
                <Brief mission={mission} />
                <Share target={{ kind: "mission", round: r.id, mission: i }} text={`${mission.title} has ${showEmber(live)} EMBER behind it on BONFIRE. Back it, and if it wins and ships, the EMBER burns.`} />
              </li>
            );
          })}
        </ul>
        <p className="hint">The line marks the threshold. The bar fills to the target, where the payout reaches the full budget.</p>
        {r.first_spark && <p className="hint">First spark: {shortAccount(r.first_spark)}</p>}
        {round.phase === "AwaitingSelection" && (
          session ? (
            <button disabled={busy} onClick={() => run("Drawing the candle…", () => session.call("select", { round_id: r.id }, 0n), "The candle was drawn.")}>Draw the candle</button>
          ) : (
            <p className="hint">Sign in below to draw the candle. Anyone can do it.</p>
          )
        )}
        {active && !session && round.phase !== "AwaitingSelection" && <p className="hint">Sign in below to back a mission.</p>}
      </section>
      {!active && <NextRound snapshot={snapshot} session={session} heading="The next round" />}
    </>
  );
}

function NextRound({ snapshot, session, heading }: { snapshot: Snapshot; session: Session | null; heading: string }) {
  const { terms, audit } = snapshot;
  return (
    <section className="card">
      <h2>{heading}</h2>
      {terms.funded ? (
        <p>The next round will reserve {showNear(terms.budget)} NEAR from the Hearth and needs {showEmber(terms.threshold)} EMBER behind one mission. The contract sets those numbers; the curator chooses when it opens.</p>
      ) : (
        <p>The Hearth holds {showNear(audit.hearth_pool)} NEAR, too little for a round. It needs more stoking before the next one can open.</p>
      )}
      <p className="hint">{session ? <>Backed an earlier round? <a href="#/embers">See what you can reclaim.</a></> : "While you wait, sign in and claim EMBER so you're ready."}</p>
    </section>
  );
}

function CommitCard({ round, session, holdings, now, busy, run }: { round: RoundView; session: Session; holdings: Holdings | null; now: number } & ActionProps) {
  const r = round.round;
  const [mission, setMission] = useState(0);
  const [text, setText] = useState("");
  const amount = parseEmber(text);
  const balance = BigInt(holdings?.balance ?? "0");
  const tooMuch = amount !== null && amount > balance;
  const inCandle = round.phase === "Candle";
  const offset = round.now_ms - Date.now();
  const toCandle = r.candle_start_ms - (now + offset);
  const closeToCandle = !inCandle && toCandle < 120_000;

  async function commit() {
    if (amount === null) return;
    const existing = await view<object | null>("get_commitment", { round_id: r.id, account_id: session.accountId, mission });
    return session.call("commit", { round_id: r.id, mission, amount: amount.toString() }, existing ? 1n : BigInt(COMMIT_DEPOSIT));
  }

  return (
    <section className="card">
      <h2>Back a mission</h2>
      <fieldset className="choices">
        <legend className="sr">Mission</legend>
        {r.missions.map((m, i) => (
          <label key={m.nomination_id} className={mission === i ? "choice on" : "choice"}>
            <input type="radio" name="mission" checked={mission === i} onChange={() => setMission(i)} />
            {m.title}
          </label>
        ))}
      </fieldset>
      <label className="field">
        <span>EMBER to commit <button type="button" className="link" onClick={() => setText((Number(balance / 10n ** 16n) / 100).toString())}>Max {showEmber(balance)}</button></span>
        <input inputMode="decimal" autoComplete="off" placeholder="0" value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <ul className="preview">
        <li>At most {amount ? showEmber(amount) : "0"} EMBER burns, and only if this mission wins and its work is accepted.</li>
        {inCandle ? (
          <li className="warn">The candle is lit. You can add, but you can't withdraw, and EMBER after the drawn checkpoint is refunded rather than counted.</li>
        ) : closeToCandle ? (
          <li className="warn">The candle lights in {countdown(toCandle)}. If your approval lands after that, this commitment can't be withdrawn.</li>
        ) : (
          <li>You can withdraw until the candle lights.</li>
        )}
        <li>Your first commitment to a mission holds a 0.01 NEAR storage deposit, returned on settlement.</li>
      </ul>
      {tooMuch && <p className="warn">That's more than you hold.</p>}
      <button disabled={busy || amount === null || tooMuch} onClick={() => run("Waiting for your signature…", commit, "Committed on-chain.")}>Commit EMBER</button>
    </section>
  );
}

function AccountCard({ session, holdings, claimLabel, claim, now, busy, run, signIn, clear }: {
  session: Session | null;
  holdings: Holdings | null;
  claimLabel: string;
  claim: () => Promise<string | null | void>;
  now: number;
  signIn: (how: () => Promise<Session>, label: string) => Promise<void>;
  clear: () => void;
} & ActionProps) {
  if (!session) {
    return (
      <section className="card">
        <div className="join">
          <div>
            <h2>Join in</h2>
            <p>A guest account needs no wallet or install. It's a labeled testnet account whose key stays in this browser.</p>
          </div>
          <img src="/art/mascot-idle.webp" alt="" />
        </div>
        <div className="stack">
          <button disabled={busy} onClick={() => signIn(createGuest, "Creating your guest account…")}>Start as a guest</button>
          <button disabled={busy} className="ghost" onClick={() => signIn(connectWallet, "Opening wallets…")}>Connect a wallet</button>
        </div>
      </section>
    );
  }
  const faucetWait = holdings && holdings.faucetNextMs > 0 ? holdings.faucetNextMs - now : 0;
  const committed = holdings ? holdings.commitments.reduce((sum, c) => sum + BigInt(c.total), 0n) : 0n;
  return (
    <section className="card">
      <div className="row spread">
        <h2>Your embers</h2>
        <span className="tag">{session.label}</span>
      </div>
      <p className="hint">{shortAccount(session.accountId)}</p>
      <dl className="facts">
        <div><dt>Free</dt><dd>{holdings ? showEmber(holdings.balance) : "…"}</dd></div>
        <div><dt>Committed</dt><dd>{holdings ? showEmber(committed) : "…"}</dd></div>
        <div><dt>Ash</dt><dd>{holdings ? showEmber(holdings.ash) : "…"}</dd></div>
      </dl>
      {committed > 0n && <p className="hint"><a href="#/embers">See what you can reclaim</a></p>}
      <div className="stack">
        <button disabled={busy || faucetWait > 0 || !holdings} onClick={() => run("Claiming EMBER…", claim, "EMBER claimed.")}>
          {faucetWait > 0 ? `Next claim in ${countdown(faucetWait)}` : claimLabel}
        </button>
        <button className="ghost" disabled={busy} onClick={() => session.signOut().then(clear)}>{session.kind === "guest" ? "Forget this guest" : "Disconnect"}</button>
      </div>
      {session.kind === "guest" && <p className="hint">Forgetting a guest removes its key from this browser for good.</p>}
    </section>
  );
}
