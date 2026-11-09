import { useMemo } from "react";
import type { RoundView } from "@bonfire/protocol";
import type { Snapshot } from "./chain";
import { countdown, showEmber, showNear } from "./format";
import { clockOf, leaderOf, sceneOf, type Scene } from "./scene";
import { Share } from "./Share";

const art = (name: string) => `/art/${name}.webp`;

/** Fixed spread so sparks don't jump on every re-render. */
const SPARKS = Array.from({ length: 18 }, (_, i) => ({
  left: 32 + ((i * 37) % 36),
  delay: -((i * 0.53) % 4),
  duration: 2.6 + ((i * 7) % 5) * 0.3,
  drift: (i % 2 ? -1 : 1) * (8 + ((i * 5) % 22)),
}));

const SPARK_COUNT = [0, 0, 7, 14];
const HEAT = [0.12, 0.3, 0.62, 1];

function Sparks({ count, burst }: { count: number; burst?: boolean }) {
  return (
    <div className={burst ? "sparks burst" : "sparks"} aria-hidden="true">
      {SPARKS.slice(0, count).map((s, i) => (
        <i key={i} style={{ left: `${s.left}%`, animationDelay: burst ? `${(i % 6) * 0.12}s` : `${s.delay}s`, animationDuration: `${s.duration}s`, "--drift": `${s.drift}px` } as React.CSSProperties} />
      ))}
    </div>
  );
}

export function FireScene({ scene, roundId }: { scene: Scene; roundId: number | null }) {
  const burned = scene.mood === "burned";
  const heat = burned ? 0.25 : scene.fire === null ? 0.06 : HEAT[scene.fire];
  const classes = ["scene", `mascot-${scene.mascot}`, scene.candle ? "has-candle" : "", burned ? "burned" : ""].join(" ");
  return (
    <div className={classes} role="img" aria-label={scene.description} style={{ "--heat": heat } as React.CSSProperties}>
      <div className="bloom" />
      <div className="ground" />
      {scene.fire !== null && (
        <div className="fire">
          {[0, 1, 2, 3].map((stage) => (
            <img key={stage} src={art(`fire-${stage}`)} alt="" className={scene.fire === stage ? "on" : ""} />
          ))}
          <Sparks count={SPARK_COUNT[scene.fire]} />
        </div>
      )}
      {burned && (
        <div className="fire" key={roundId ?? "none"}>
          <img src={art("fire-3")} alt="" className="burnout" />
          <img src={art("ash")} alt="" className="ash on" />
          <Sparks count={18} burst />
        </div>
      )}
      {scene.candle && <img className="candle-art" src={art(`candle-${scene.candle}`)} alt="" />}
      <img className="mascot" key={scene.mascot} src={art(`mascot-${scene.mascot}`)} alt="" />
    </div>
  );
}

function phaseLine(round: RoundView, nowChain: number): string {
  const r = round.round;
  const until = (ms: number) => countdown(ms - nowChain);
  switch (round.phase) {
    case "Scheduled":
      return `Round ${r.id} opens soon. Nothing can be committed yet.`;
    case "Backing":
      return "Backing is open. You can still change your mind until the candle lights.";
    case "Candle":
      return "The candle is lit, so the fire may go out at any moment.";
    case "AwaitingSelection":
      return "Backing has closed. Anyone can draw the candle to decide the winner.";
    case "AwaitingWork":
      return `The creator has ${until(r.delivery_deadline_ms)} to deliver. No EMBER burns until the work is accepted.`;
    case "AwaitingReview":
      return `Delivered. The reviewer has ${until(r.review_deadline_ms)} to decide.`;
    case "Accepted":
      return "The work was accepted. The counted EMBER burned and the creator's payout is unlocked.";
    case "Rejected":
      return "The work was rejected. All EMBER is refundable and the budget went back to the Hearth.";
    case "FailedSelection":
      return "No mission qualified. All EMBER is refundable and the budget went back to the Hearth.";
    case "Cancelled":
      return "This round was cancelled before it opened.";
    default:
      return "A deadline passed. All EMBER is refundable and the budget went back to the Hearth.";
  }
}

const PHASE_NAME: Partial<Record<RoundView["phase"], string>> = {
  AwaitingSelection: "Closed",
  AwaitingWork: "Being built",
  AwaitingReview: "In review",
  FailedSelection: "No winner",
};

function Stat({ label, value, unit, note }: { label: string; value: string; unit?: string; note?: string }) {
  return (
    <div className="stat">
      <span className="label">{label}</span>
      <span className="big">
        {value}
        {unit && <small> {unit}</small>}
      </span>
      {note && <span className="note">{note}</span>}
    </div>
  );
}

function Headline({ round }: { round: RoundView }) {
  const r = round.round;
  if (round.phase === "Accepted") return <Stat label="Burned" value={showEmber(r.burned)} unit="EMBER" note={`${showNear(r.payout)} NEAR payout for the creator`} />;
  if (round.phase === "AwaitingWork" || round.phase === "AwaitingReview") {
    return <Stat label="Counted" value={showEmber(r.counted)} unit="EMBER" note={r.winner === null ? undefined : r.missions[r.winner]?.title} />;
  }
  if (round.phase === "Backing" || round.phase === "Candle" || round.phase === "AwaitingSelection") {
    const lead = leaderOf(round);
    if (!lead) return <Stat label="Leading" value="0" unit="EMBER" note="Nothing is behind any mission yet." />;
    const short = BigInt(r.threshold) - lead.total;
    const title = r.missions[lead.mission]?.title ?? "";
    return <Stat label={lead.tied ? "Tied at the top" : "Leading"} value={showEmber(lead.total)} unit="EMBER" note={short > 0n ? `${lead.tied ? "" : `${title}: `}${showEmber(short)} more to qualify` : `${lead.tied ? "" : `${title}: `}past the threshold`} />;
  }
  return null;
}

function roundText(round: RoundView): string {
  const r = round.round;
  if (round.phase === "Accepted") return `Round ${r.id} on BONFIRE: ${showEmber(r.burned)} EMBER burned after the work was accepted.`;
  if (["Backing", "Candle", "AwaitingSelection", "Scheduled"].includes(round.phase)) return `Round ${r.id} on BONFIRE: which mission gets built? Back one, and the EMBER burns only if the work ships.`;
  if (round.phase === "AwaitingWork" || round.phase === "AwaitingReview") return `Round ${r.id} on BONFIRE has a winner. The EMBER burns only if the work is accepted.`;
  return `Round ${r.id} on BONFIRE ended without a burn, so the EMBER comes back.`;
}

/** The first thing on Home: the fire, and what it means right now. */
export function Hero({ snapshot, now }: { snapshot: Snapshot | null; now: number }) {
  const round = snapshot?.round ?? null;
  const scene = sceneOf(round);
  // Chain time, so a wrong device clock can't mislabel a phase.
  const offset = useMemo(() => (round ? round.now_ms - Date.now() : 0), [round]);
  const nowChain = now + offset;
  const clock = round ? clockOf(round, nowChain) : null;

  return (
    <section className="hero">
      <h1>Back the mission. See it built. Then burn together.</h1>
      <FireScene scene={scene} roundId={round?.round.id ?? null} />
      {round && (
        <div className="readout">
          <div className="row spread">
            <span className="round-name">Round {round.round.id}</span>
            <span className={`phase ${round.phase.toLowerCase()}`}>{PHASE_NAME[round.phase] ?? round.phase}</span>
          </div>
          <div className="stats">
            <Headline round={round} />
            {clock && <Stat label={clock.label} value={countdown(clock.ms)} />}
          </div>
          <p className="phaseline">{phaseLine(round, nowChain)}</p>
          <Share label="Share this round" target={{ kind: "round", round: round.round.id }} text={roundText(round)} />
        </div>
      )}
      <p className="rule">Put your EMBER behind the mission you want made. If it wins and the work is accepted, your EMBER burns and the creator gets paid. Otherwise you get it back.</p>
    </section>
  );
}
