import { useState } from "react";

export type ShareTarget =
  | { kind: "mission"; round: number; mission: number }
  | { kind: "round"; round: number }
  | { kind: "receipt"; round: number; mission: number; account: string };

export function sharePath(target: ShareTarget): string {
  if (target.kind === "round") return `/s/r/${target.round}`;
  if (target.kind === "mission") return `/s/m/${target.round}/${target.mission}`;
  return `/s/p/${target.round}/${target.mission}/${target.account}`;
}

export function cardPath(target: ShareTarget): string {
  const query = new URLSearchParams({ kind: target.kind, round: String(target.round) });
  if (target.kind !== "round") query.set("mission", String(target.mission));
  if (target.kind === "receipt") query.set("account", target.account);
  return `/api/card?${query}`;
}

export function postUrl(text: string, link: string): string {
  return `https://x.com/intent/post?${new URLSearchParams({ text, url: link })}`;
}

/** Nothing is posted from here: the link opens X with a draft for the person to send or discard. */
export function Share({ target, text, label = "Share" }: { target: ShareTarget; text: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const link = window.location.origin + sharePath(target);

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      window.prompt("Copy this link", link);
    }
  }

  return (
    <details className="share" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{label}</summary>
      {open && (
        <div className="share-body">
          <img src={cardPath(target)} alt="Preview of the card people will see" width={1200} height={630} />
          <div className="share-actions">
            <a className="action" href={postUrl(text, link)} target="_blank" rel="noreferrer">Post on X</a>
            <button type="button" className="ghost" onClick={copy}>{copied ? "Link copied" : "Copy link"}</button>
          </div>
        </div>
      )}
    </details>
  );
}
