import { useEffect, useState } from "react";
import type { Mission } from "@bonfire/protocol";
import { briefKey, parseBrief, sha256Hex, type Run } from "./brief-text";

const FILES = import.meta.glob("../../../docs/briefs/**/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const BRIEFS = Object.fromEntries(Object.entries(FILES).map(([path, text]) => [path.replace(/^(\.\.\/)+/, ""), text]));

const renderRuns = (runs: Run[]) => runs.map((run, i) => (run.bold ? <strong key={i}>{run.text}</strong> : <span key={i}>{run.text}</span>));

function BriefText({ text }: { text: string }) {
  return (
    <>
      {parseBrief(text).map((block, i) => {
        if (block.type === "heading") return <h3 key={i}>{block.text}</h3>;
        if (block.type === "paragraph") return <p key={i}>{renderRuns(block.runs)}</p>;
        return <ul key={i}>{block.items.map((item, j) => <li key={j}>{renderRuns(item)}</li>)}</ul>;
      })}
    </>
  );
}

/** Shows the brief only if its bytes match the hash the mission recorded on-chain. */
export function Brief({ mission }: { mission: Mission }) {
  const [open, setOpen] = useState(false);
  const [matches, setMatches] = useState<boolean | null>(null);
  const key = briefKey(mission.brief_uri);
  const text = key ? BRIEFS[key] : undefined;

  useEffect(() => {
    if (!open || text === undefined) return;
    void sha256Hex(text).then((hash) => setMatches(hash === mission.brief_hash.toLowerCase()));
  }, [open, text, mission.brief_hash]);

  const external = /^https:\/\//.test(mission.brief_uri);
  if (text === undefined) {
    return external ? <p className="share"><a href={mission.brief_uri} target="_blank" rel="noreferrer">Read the brief</a></p> : null;
  }

  return (
    <details className="share" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Read the brief</summary>
      {open && matches === true && (
        <div className="brief">
          <BriefText text={text} />
          <p className="hint">This text matches the SHA-256 recorded on-chain: <code>{mission.brief_hash.slice(0, 12)}…</code></p>
        </div>
      )}
      {open && matches === false && (
        <div className="brief">
          <p className="warn">The copy on this site doesn't match the hash recorded on-chain, so it isn't shown.</p>
          {external && <p><a href={mission.brief_uri} target="_blank" rel="noreferrer">Open the linked brief</a></p>}
        </div>
      )}
    </details>
  );
}
