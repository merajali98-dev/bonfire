import { useEffect, useState } from "react";
import type { RoundView } from "@bonfire/protocol";
import { view } from "./chain";
import { showEmber, showNear } from "./format";
import { DELIVERIES, sha256OfBytes, standingOf, type Delivery } from "./made-data";

const REPO = "https://github.com/merajali98-dev/bonfire";

/** Everything the fire has commissioned. Each delivery is checked against the hash submitted on-chain. */
export function MadePage() {
  return (
    <div className="narrow made">
      <section className="card">
        <h2>Made by the fire</h2>
        <p className="hint">Work that BONFIRE rounds commissioned. Each one is shown with the hash its creator submitted on-chain, and you can check the download against it here.</p>
      </section>
      {DELIVERIES.map((delivery) => (
        <DeliveryCard key={`${delivery.contract}/${delivery.roundId}`} delivery={delivery} />
      ))}
    </div>
  );
}

function DeliveryCard({ delivery }: { delivery: Delivery }) {
  const [round, setRound] = useState<RoundView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [check, setCheck] = useState<"idle" | "busy" | "match" | "differs" | "failed">("idle");

  useEffect(() => {
    let live = true;
    const read = () =>
      view<RoundView | null>("get_round", { round_id: delivery.roundId }, delivery.contract)
        .then((r) => live && (setRound(r), setError(null)))
        .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    void read();
    const poll = setInterval(read, 30_000);
    return () => {
      live = false;
      clearInterval(poll);
    };
  }, [delivery]);

  async function verify() {
    setCheck("busy");
    try {
      const response = await fetch(delivery.uri);
      if (!response.ok) throw new Error(String(response.status));
      setCheck((await sha256OfBytes(await response.arrayBuffer())) === delivery.hash ? "match" : "differs");
    } catch {
      setCheck("failed");
    }
  }

  if (!round) {
    return <section className="card muted">{error ? `Couldn't read round ${delivery.roundId}: ${error} Retrying.` : "Reading the round from the chain…"}</section>;
  }

  const standing = standingOf(round, delivery);
  if (standing.kind === "mismatch") {
    return (
      <section className="card">
        <h2>Round {delivery.roundId}: {delivery.mission}</h2>
        <p className="warn">The submission on-chain doesn't match this delivery, so it isn't shown.</p>
      </section>
    );
  }

  return (
    <section className="card">
      <h2>Round {delivery.roundId}: {delivery.mission}</h2>
      <p className="status-line">
        {standing.kind === "accepted" && <>Accepted. {showEmber(standing.burned)} EMBER burned, and {showNear(standing.payout)} NEAR {standing.paid ? "paid" : "is claimable"} to the creator.</>}
        {standing.kind === "in-review" && <>Submitted and waiting for review. Nothing burns until the reviewer accepts this exact file.</>}
        {standing.kind === "other" && <>Round status: {standing.phase}.</>}
      </p>
      <ul className="stickers">
        {delivery.pieces.map((piece) => (
          <li key={piece.file}>
            <a href={piece.file} download>
              <img src={piece.file} alt={`EMBER mascot sticker: ${piece.title}`} width={512} height={512} loading="lazy" />
              <span>{piece.title}</span>
            </a>
          </li>
        ))}
      </ul>
      <p className="hint">Free for anyone to use, copy, share and adapt. Tap a sticker to save it as a 512 px WebP.</p>
      <div className="share-actions">
        <a className="action" href={delivery.uri}>Download the submitted zip</a>
        <button type="button" onClick={() => void verify()} disabled={check === "busy"}>
          {check === "busy" ? "Hashing…" : "Check it against the chain"}
        </button>
      </div>
      {check === "match" && <p className="good">The zip's SHA-256 equals the hash submitted on-chain.</p>}
      {check === "differs" && <p className="warn">The download doesn't match the hash submitted on-chain.</p>}
      {check === "failed" && <p className="warn">Couldn't download the zip to check it. Try again.</p>}
      <dl className="facts wide">
        <div><dt>Contract</dt><dd className="mono">{delivery.contract}</dd></div>
        <div><dt>Creator</dt><dd className="mono">{delivery.maker}<span className="tag">team demo actor</span></dd></div>
        <div><dt>Submitted SHA-256</dt><dd className="mono">{delivery.hash}</dd></div>
        <div><dt>In the repository</dt><dd className="mono"><a href={`${REPO}/tree/main/${delivery.repoPath}`} target="_blank" rel="noreferrer">{delivery.repoPath}</a></dd></div>
      </dl>
      <p className="hint">Made with OpenAI ImageGen from the site's mascot. The note inside the zip names the tools and lists the prompts.</p>
    </section>
  );
}
