import { useEffect, useMemo, useRef, useState } from "react";
import { FireScene } from "./Fire";
import { countdown, parseEmber } from "./format";
import {
  advance,
  checkpointAt,
  CLOSE_MS,
  commit,
  draw,
  liveTotals,
  MISSIONS,
  myCommitted,
  practiceScene,
  PRACTICE,
  review,
  settle,
  show,
  showPracticeNear,
  stageAt,
  startPractice,
  submit,
  withdraw,
  type Practice,
  type Stage,
} from "./practice-floor";

const STEPS: { label: string; stages: Stage[] }[] = [
  { label: "Back", stages: ["backing"] },
  { label: "Candle", stages: ["candle"] },
  { label: "Draw", stages: ["closed"] },
  { label: "Build", stages: ["work"] },
  { label: "Review", stages: ["review"] },
  { label: "Burn and settle", stages: ["accepted", "failed"] },
];

const newSeed = () => Math.floor(Math.random() * 2 ** 31);

/** The whole loop in about 90 seconds. Local only: no wallet, no network, nothing signed. */
export function PracticePage() {
  const [p, setP] = useState<Practice>(() => startPractice(newSeed()));
  const started = useRef(performance.now());
  const [skipped, setSkipped] = useState(0);
  const [tick, setTick] = useState(performance.now());
  const [error, setError] = useState<string | null>(null);
  const t = Math.floor(tick - started.current + skipped);
  const stage = stageAt(p, t);
  const scene = practiceScene(p, t);

  useEffect(() => {
    const clock = setInterval(() => setTick(performance.now()), 250);
    return () => clearInterval(clock);
  }, []);

  useEffect(() => setP((current) => advance(current, t)), [t]);

  useEffect(() => {
    document.body.dataset.mood = scene.mood;
  }, [scene.mood]);
  useEffect(() => () => void (document.body.dataset.mood = "calm"), []);

  const act = (change: () => Practice) => {
    try {
      setP(change());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const restart = () => {
    started.current = performance.now();
    setSkipped(0);
    setTick(performance.now());
    setError(null);
    setP(startPractice(newSeed()));
  };

  const nextBoundary = stage === "backing" ? PRACTICE.backingMs : stage === "candle" ? CLOSE_MS : null;
  const totals = liveTotals(p);

  return (
    <div className="practice">
      <div className="practice-banner" role="note">
        <strong>Practice: nothing here is on chain</strong>
        <span>No wallet, no transactions, no real EMBER. Everything happens in this browser tab.</span>
      </div>

      <div className="home">
        <section className="hero">
          <h1>Run a whole round in about 90 seconds.</h1>
          <FireScene scene={scene} roundId={null} />
          <div className="readout">
            <div className="row spread">
              <span className="round-name">Practice round</span>
              <span className="phase practice-phase">{STEPS.find((s) => s.stages.includes(stage))?.label}</span>
            </div>
            <ol className="steps" aria-label="Steps">
              {STEPS.map((step) => {
                const index = STEPS.findIndex((s) => s.stages.includes(stage));
                const mine = STEPS.indexOf(step);
                return (
                  <li key={step.label} className={mine === index ? "on" : mine < index ? "done" : ""} aria-current={mine === index ? "step" : undefined}>
                    {step.label}
                  </li>
                );
              })}
            </ol>
            <p className="phaseline">{guide(p, stage, t)}</p>
            {nextBoundary !== null && (
              <div className="row spread">
                <span className="hint">{stage === "backing" ? "Candle lights in" : "Backing closes within"} {countdown(nextBoundary - t)}</span>
                <button className="link" onClick={() => setSkipped((s) => s + Math.max(0, nextBoundary - t))}>Skip ahead</button>
              </div>
            )}
          </div>
          <p className="rule">Put your EMBER behind the mission you want made. If it wins and the work is accepted, your EMBER burns and the creator gets paid. Otherwise you get it back.</p>
        </section>

        <div className="column">
          <section className="card practice-card">
            <h2>Practice missions</h2>
            <dl className="facts">
              <div><dt>Budget</dt><dd>{showPracticeNear(PRACTICE.budget)} <small>practice NEAR</small></dd></div>
              <div><dt>Threshold</dt><dd>{show(PRACTICE.threshold)}</dd></div>
              <div><dt>Target</dt><dd>{show(PRACTICE.target)}</dd></div>
            </dl>
            <ul className="missions">
              {MISSIONS.map((title, m) => {
                const shown = p.decision ? p.decision.counted[m]! : totals[m]!;
                const mine = p.myPre[m]! + p.myAdds[m]!.reduce((a, b) => a + b, 0n);
                return (
                  <li key={title}>
                    <div className="row spread">
                      <span className="title plain">
                        {title}
                        {p.decision?.winner === m && <span className="won"> · won</span>}
                      </span>
                      <span className="amount">{show(shown)}{p.decision && <small> counted</small>}</span>
                    </div>
                    <div className="bar" aria-hidden="true">
                      <div className="fill" style={{ width: scale(shown) }} />
                      <div className="mark" style={{ left: scale(PRACTICE.threshold) }} />
                    </div>
                    {mine > 0n && <p className="hint">Yours: {show(mine)}{p.myAdds[m]!.some((a) => a > 0n) ? " (some added during the candle)" : ""}</p>}
                    {stage === "backing" && p.myPre[m]! > 0n && (
                      <button className="ghost small" onClick={() => act(() => withdraw(p, t, m))}>Withdraw {show(p.myPre[m]!)}</button>
                    )}
                  </li>
                );
              })}
            </ul>
            <p className="hint">The line marks the threshold. The bar fills to the target, where the payout reaches the full budget.</p>
          </section>

          <Actions p={p} stage={stage} t={t} act={act} restart={restart} />
          {error && <p className="warn" role="alert">{error}</p>}

          <section className="card practice-card">
            <div className="row spread">
              <h2>Your practice embers</h2>
              <span className="tag">practice</span>
            </div>
            <dl className="facts">
              <div><dt>Free</dt><dd>{show(p.free)}</dd></div>
              <div><dt>Committed</dt><dd>{show(myCommitted(p))}</dd></div>
              <div><dt>Ash</dt><dd>{show(p.ash)}</dd></div>
            </dl>
          </section>

          <section className="card practice-card">
            <h2>What happened</h2>
            <ol className="practice-log">
              {[...p.log].reverse().map((line, i) => (
                <li key={p.log.length - i}>{line}</li>
              ))}
            </ol>
          </section>
        </div>
      </div>
    </div>
  );
}

const scale = (value: bigint) => `${Math.min(100, Number((value * 1000n) / PRACTICE.target) / 10)}%`;

function guide(p: Practice, stage: Stage, t: number): string {
  switch (stage) {
    case "backing":
      return "Backing is open. Back a mission below. Until the candle lights you can withdraw or switch.";
    case "candle":
      return `The candle is lit, checkpoint ${checkpointAt(t) + 1} of ${PRACTICE.checkpoints}. You can only add now, and a random checkpoint decides what counts.`;
    case "closed":
      return "Backing has closed. Anyone can draw the candle to decide the winner.";
    case "work":
      return "A winner! Nothing has burned. The winning creator now makes the work.";
    case "review":
      return "The work is in. The reviewer accepts or rejects that exact submission.";
    case "accepted":
      return p.settled ? "Done. That's the whole loop." : "The counted EMBER burned. Settle to get back anything that didn't count and to collect your Ash.";
    case "failed":
      return p.settled ? "Done. Nothing burned this time." : "Nothing burns this round. Settle to get all your practice EMBER back.";
  }
}

function Actions({ p, stage, t, act, restart }: { p: Practice; stage: Stage; t: number; act: (change: () => Practice) => void; restart: () => void }) {
  const [mission, setMission] = useState(0);
  const [text, setText] = useState("2500");
  const amount = useMemo(() => parseEmber(text), [text]);

  if (stage === "backing" || stage === "candle") {
    return (
      <section className="card practice-card">
        <h2>Back a practice mission</h2>
        <fieldset className="choices">
          <legend className="sr">Mission</legend>
          {MISSIONS.map((title, i) => (
            <label key={title} className={mission === i ? "choice on" : "choice"}>
              <input type="radio" name="practice-mission" checked={mission === i} onChange={() => setMission(i)} />
              {title}
            </label>
          ))}
        </fieldset>
        <label className="field">
          <span>Practice EMBER <button type="button" className="link" onClick={() => setText(show(p.free).replace(/,/g, ""))}>All {show(p.free)}</button></span>
          <input inputMode="decimal" autoComplete="off" value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        <p className="hint">{stage === "candle" ? "During the candle an addition is locked, and it counts only if the candle is drawn at this checkpoint or later." : "You can withdraw this until the candle lights."}</p>
        <button disabled={amount === null || p.free === 0n} onClick={() => amount !== null && act(() => commit(p, t, mission, amount))}>
          {stage === "candle" ? "Add in practice" : "Back it in practice"}
        </button>
      </section>
    );
  }

  const d = p.decision;
  return (
    <section className="card practice-card">
      {stage === "closed" && (
        <>
          <h2>Draw the candle</h2>
          <p>A random checkpoint between 1 and {PRACTICE.checkpoints} is drawn. Only EMBER committed by then counts. On chain anyone can make this call, so there's no last-second advantage.</p>
          <button onClick={() => act(() => draw(p, t))}>Draw the candle</button>
        </>
      )}
      {stage === "work" && d && (
        <>
          <h2>Play the creator</h2>
          <p>{MISSIONS[d.winner!]} won, so its creator makes the work and submits a hash of it. The payout would be {showPracticeNear(d.payout)} practice NEAR: the budget scaled by counted EMBER against the target.</p>
          <button onClick={() => act(() => submit(p))}>Submit the work</button>
        </>
      )}
      {stage === "review" && (
        <>
          <h2>Play the reviewer</h2>
          <p>The reviewer accepts the exact submitted hash, which burns the counted EMBER, or rejects it, which refunds everyone.</p>
          <button onClick={() => act(() => review(p, true))}>Accept the work</button>
          <button className="ghost" onClick={() => act(() => review(p, false))}>Reject instead</button>
        </>
      )}
      {(stage === "accepted" || stage === "failed") && !p.settled && (
        <>
          <h2>Settle</h2>
          <p>Settling returns every practice EMBER of yours that didn't burn{stage === "accepted" ? " and records the rest as Ash" : ""}. On chain anyone can settle for anyone.</p>
          <button onClick={() => act(() => settle(p))}>Settle my practice EMBER</button>
        </>
      )}
      {p.settled && d && (
        <>
          <h2>How it went</h2>
          <dl className="facts">
            <div><dt>Burned</dt><dd>{show(p.myBurned)}</dd></div>
            <div><dt>Returned</dt><dd>{show(p.refunded)}</dd></div>
            <div><dt>Ash</dt><dd>{show(p.ash)}</dd></div>
          </dl>
          <p className="hint">
            {stage === "accepted" ? `${show(p.burnedTotal)} practice EMBER burned in total and the creator was paid ${showPracticeNear(d.payout)} practice NEAR. ` : ""}
            By the rules, the next round's threshold would be {show(d.nextThreshold)}.
          </p>
          <div className="stack">
            <button onClick={restart}>Practice again</button>
            <a className="button-link" href="#/">Go to the live round</a>
          </div>
        </>
      )}
    </section>
  );
}
