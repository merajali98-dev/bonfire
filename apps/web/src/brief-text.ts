/** Reads the mission briefs shipped with the site. Only the small Markdown subset they use. */

/** A brief recorded on-chain as a file on the main branch of a repository. */
const BRIEF_URI = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/blob\/main\/(docs\/briefs\/[a-z0-9/_-]+\.md)$/;

/**
 * The path of a brief shipped with the site, or null if the on-chain link points anywhere else.
 * The site shows a brief only after its text matches the on-chain hash, and never links out.
 */
export function briefKey(uri: string): string | null {
  return BRIEF_URI.exec(uri)?.[1] ?? null;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface Run {
  text: string;
  bold: boolean;
}

export type Block =
  | { type: "heading"; text: string }
  | { type: "paragraph"; runs: Run[] }
  | { type: "list"; items: Run[][] };

function runsOf(text: string): Run[] {
  return text
    .split("**")
    .map((part, i) => ({ text: part, bold: i % 2 === 1 }))
    .filter((run) => run.text !== "");
}

export function parseBrief(markdown: string): Block[] {
  const blocks: Block[] = [];
  for (const chunk of markdown.split(/\n{2,}/)) {
    const lines = chunk.trim().split("\n");
    if (lines[0] === "") continue;
    if (lines[0].startsWith("# ")) blocks.push({ type: "heading", text: lines[0].slice(2) });
    else if (lines.every((line) => line.startsWith("- "))) blocks.push({ type: "list", items: lines.map((line) => runsOf(line.slice(2))) });
    else blocks.push({ type: "paragraph", runs: runsOf(lines.join(" ")) });
  }
  return blocks;
}
