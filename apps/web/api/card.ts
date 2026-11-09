/**
 * Social share cards. Every number comes from the chain at request time, so a card can't say
 * anything the contract doesn't, and nobody can put their own figures in the URL.
 *
 * Returns a 1200×630 PNG, or with `html=1` a small page carrying the preview tags for it.
 * Shared code is duplicated here on purpose: this file has no relative imports so that it runs
 * unbundled on Vercel. test/card.test.ts holds the copies to the originals.
 */
import { readFile } from "node:fs/promises";
import type { CommitmentView, RoundView } from "@bonfire/protocol";

const CONTRACT = process.env.VITE_CONTRACT ?? "fire.bonfire-hearth.testnet";
const RPC_URL = process.env.BONFIRE_RPC ?? process.env.VITE_RPC ?? "https://rpc.testnet.fastnear.com";
const FOOTER = "NEAR testnet. Test tokens have no value.";
const BACKDROP = "#211110";
const MAX_TITLE = 64;

export type CardRequest =
  | { kind: "mission"; round: number; mission: number }
  | { kind: "round"; round: number }
  | { kind: "receipt"; round: number; mission: number; account: string };

const INTEGER = /^\d{1,9}$/;
const ACCOUNT = /^(?=.{2,64}$)[a-z0-9]+([-_][a-z0-9]+)*(\.[a-z0-9]+([-_][a-z0-9]+)*)*$/;

export function parseCard(params: URLSearchParams): CardRequest | null {
  const round = params.get("round") ?? "";
  if (!INTEGER.test(round)) return null;
  const id = Number(round);
  const kind = params.get("kind");
  if (kind === "round") return { kind, round: id };
  const mission = params.get("mission") ?? "";
  if (!/^\d$/.test(mission)) return null;
  if (kind === "mission") return { kind, round: id, mission: Number(mission) };
  const account = params.get("account") ?? "";
  if (kind === "receipt" && ACCOUNT.test(account)) return { kind, round: id, mission: Number(mission), account };
  return null;
}

export function pathOf(card: CardRequest): string {
  if (card.kind === "round") return `/s/r/${card.round}`;
  if (card.kind === "mission") return `/s/m/${card.round}/${card.mission}`;
  return `/s/p/${card.round}/${card.mission}/${card.account}`;
}

export function imageQueryOf(card: CardRequest): string {
  const query = new URLSearchParams({ kind: card.kind, round: String(card.round) });
  if (card.kind !== "round") query.set("mission", String(card.mission));
  if (card.kind === "receipt") query.set("account", card.account);
  return query.toString();
}

export function showEmber(value: string | bigint): string {
  const scaled = (BigInt(value) * 100n) / 10n ** 18n;
  const fraction = (scaled % 100n).toString().padStart(2, "0").replace(/0+$/, "");
  return (scaled / 100n).toLocaleString("en-US") + (fraction ? `.${fraction}` : "");
}

export function showNear(value: string | bigint): string {
  const scaled = (BigInt(value) * 1000n) / 10n ** 24n;
  const fraction = (scaled % 1000n).toString().padStart(3, "0").replace(/0+$/, "");
  return (scaled / 1000n).toLocaleString("en-US") + (fraction ? `.${fraction}` : "");
}

export const shortAccount = (id: string) => (id.length > 26 ? `${id.slice(0, 12)}…${id.slice(-11)}` : id);

export function fireStage(tally: bigint, threshold: bigint, target: bigint): 0 | 1 | 2 | 3 {
  if (tally <= 0n) return 0;
  if (tally < threshold) return 1;
  return tally < target ? 2 : 3;
}

export const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const clip = (text: string) => (text.length > MAX_TITLE ? `${text.slice(0, MAX_TITLE - 1).trimEnd()}…` : text);

const PHASE: Record<string, string> = {
  AwaitingSelection: "Closed",
  AwaitingWork: "Being built",
  AwaitingReview: "In review",
  FailedSelection: "No winner",
};
const phaseName = (round: RoundView) => PHASE[round.phase] ?? round.phase;

const ENDED_NO_BURN = ["Rejected", "FailedSelection", "Expired", "Cancelled"];
const OPEN = ["Scheduled", "Backing", "Candle", "AwaitingSelection"];

export interface CardModel {
  eyebrow: string;
  headline: string;
  value: string | null;
  unit: string;
  detail: string;
  /** File names in card-assets, drawn right of the text. Ignored when `backdrop` is set. */
  art: string[];
  backdrop: boolean;
  glow: number;
}

const stageGlow = [0.12, 0.3, 0.6, 1];

function fireCard(stage: 0 | 1 | 2 | 3): Pick<CardModel, "art" | "glow"> {
  return { art: [`fire-${stage}.png`, stage === 3 ? "mascot-excited.png" : "mascot-idle.png"], glow: stageGlow[stage] };
}

const burnedArt = { art: ["ash.png", "mascot-excited.png"], glow: 0.3 };
const shrugArt = { art: ["mascot-shrug.png"], glow: 0.05 };

export function missionCard(round: RoundView, mission: number): CardModel | null {
  const r = round.round;
  const entry = r.missions[mission];
  if (!entry) return null;
  const tally = BigInt(round.live_totals[mission] ?? "0");
  const threshold = BigInt(r.threshold);
  const eyebrow = `Round ${r.id} · ${phaseName(round)}`;
  const base = { eyebrow, headline: clip(entry.title), value: showEmber(tally), unit: "EMBER behind it", backdrop: false };

  if (ENDED_NO_BURN.includes(round.phase)) return { ...base, detail: "This round ended without a burn, so the EMBER comes back.", ...shrugArt };
  if (r.winner !== null && r.winner !== mission) return { ...base, detail: "Another mission won this round. This EMBER comes back.", ...shrugArt };
  if (round.phase === "Accepted") return { ...base, value: showEmber(r.burned), unit: "EMBER burned", detail: `The work was accepted. ${showNear(r.payout)} NEAR payout for the creator.`, ...burnedArt };
  if (r.winner === mission) return { ...base, value: showEmber(r.counted), unit: "EMBER counted", detail: "It won. The EMBER burns only if the work is accepted.", ...fireCard(fireStage(BigInt(r.counted), threshold, BigInt(r.target))) };
  const detail = tally >= threshold ? `Past the ${showEmber(threshold)} EMBER threshold.` : `${showEmber(threshold - tally)} more EMBER to qualify.`;
  return { ...base, detail, ...fireCard(fireStage(tally, threshold, BigInt(r.target))) };
}

export function roundCard(round: RoundView): CardModel {
  const r = round.round;
  const eyebrow = `Round ${r.id} · ${phaseName(round)}`;
  const winner = r.winner === null ? null : (r.missions[r.winner]?.title ?? null);

  if (round.phase === "Accepted") return { eyebrow, headline: clip(winner ?? "The work was accepted"), value: showEmber(r.burned), unit: "EMBER burned", detail: `${showNear(r.payout)} NEAR payout for the creator.`, backdrop: false, ...burnedArt };
  if (ENDED_NO_BURN.includes(round.phase)) {
    const detail = round.phase === "Cancelled" ? "This round was cancelled before it opened." : "All EMBER is refundable and the budget went back to the Hearth.";
    return { eyebrow, headline: "No burn this round", value: null, unit: "", detail, backdrop: false, ...shrugArt };
  }
  if (!OPEN.includes(round.phase)) {
    return { eyebrow, headline: clip(winner ?? "A mission won"), value: showEmber(r.counted), unit: "EMBER counted", detail: "It burns only if the work is accepted.", backdrop: false, ...fireCard(fireStage(BigInt(r.counted), BigInt(r.threshold), BigInt(r.target))) };
  }
  const lead = round.live_totals.reduce((best, value) => (BigInt(value) > best ? BigInt(value) : best), 0n);
  return { eyebrow, headline: "Which mission gets built?", value: showEmber(lead), unit: "EMBER leading", detail: `Up to ${showNear(r.budget)} NEAR for the creator of the winner.`, backdrop: false, ...fireCard(fireStage(lead, BigInt(r.threshold), BigInt(r.target))) };
}

export function receiptCard(round: RoundView, mission: number, account: string, record: CommitmentView | null, ash: bigint): CardModel | null {
  const r = round.round;
  const entry = r.missions[mission];
  const eyebrow = shortAccount(account);
  const personal = { eyebrow, backdrop: true, art: [], glow: 0 };

  // Settling removes the record, so only Ash can still be vouched for.
  if (!record) {
    if (ash > 0n) return { ...personal, headline: "Fire Keeper", value: showEmber(ash), unit: "Ash", detail: "A permanent record of EMBER burned in accepted rounds." };
    return missionCard(round, mission);
  }
  if (!entry) return null;
  const title = clip(entry.title);
  const total = showEmber(record.total);
  const counted = record.counted === null ? null : showEmber(record.counted);
  const won = r.winner === mission;

  if (round.phase === "Accepted" && won) return { ...personal, headline: "I burned", value: counted ?? total, unit: "EMBER", detail: `for ${title}. The work shipped.` };
  if (ENDED_NO_BURN.includes(round.phase) || (r.winner !== null && !won)) return { ...personal, headline: "I backed", value: total, unit: "EMBER", detail: `for ${title}. It didn't burn, so it comes back.` };
  if (won) return { ...personal, headline: "On the line", value: counted ?? total, unit: "EMBER", detail: `for ${title}. It burns only if the work is accepted.` };
  return { ...personal, headline: "I fed the fire", value: total, unit: "EMBER", detail: `for ${title}. It burns only if this mission wins and the work is accepted.` };
}

async function view<T>(method: string, args: object): Promise<T> {
  let failure: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "card", method: "query", params: { request_type: "call_function", finality: "optimistic", account_id: CONTRACT, method_name: method, args_base64: btoa(JSON.stringify(args)) } }),
      });
      const body = (await response.json()) as { result?: { result?: number[]; error?: string } };
      if (!body.result?.result) throw new Error(body.result?.error ?? `View ${method} failed`);
      return JSON.parse(new TextDecoder().decode(new Uint8Array(body.result.result))) as T;
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}

async function load(card: CardRequest): Promise<CardModel | null> {
  const round = await view<RoundView | null>("get_round", { round_id: card.round });
  if (!round) return null;
  if (card.kind === "round") return roundCard(round);
  if (card.kind === "mission") return missionCard(round, card.mission);
  const [record, ash] = await Promise.all([
    view<CommitmentView | null>("get_commitment", { round_id: card.round, account_id: card.account, mission: card.mission }),
    view<string>("get_ash", { account_id: card.account }),
  ]);
  return receiptCard(round, card.mission, card.account, record, BigInt(ash));
}

const assets = new Map<string, Promise<Buffer>>();

function asset(name: string): Promise<Buffer> {
  let file = assets.get(name);
  if (!file) {
    file = readFile(new URL(`../card-assets/${name}`, import.meta.url));
    assets.set(name, file);
  }
  return file;
}

const dataUri = async (name: string) => `data:image/${name.endsWith("jpg") ? "jpeg" : "png"};base64,${(await asset(name)).toString("base64")}`;

type Style = Record<string, string | number>;
interface Element {
  type: string;
  props: Record<string, unknown>;
}

const box = (style: Style, ...children: (Element | string | null)[]): Element => ({
  type: "div",
  props: { style: { display: "flex", ...style }, children: children.filter((c) => c !== null) },
});
const picture = (src: string, style: Style): Element => ({ type: "img", props: { src, style, width: style.width, height: style.height } });

/** Titles are written on-chain by nominators, so markup characters never reach the renderer. */
const ink = (text: string) => text.replace(/[<>&"]/g, "");

async function drawing(model: CardModel): Promise<Element> {
  const [mark, ...pictures] = await Promise.all(["flame-mark.png", ...(model.backdrop ? ["campfire.jpg"] : model.art)].map(dataUri));
  const size = model.headline.length > 34 ? 50 : 62;
  // The main picture sits right of the text; a mascot beside it stands in front.
  const art = model.backdrop
    ? [picture(pictures[0], { position: "absolute", right: 0, top: 0, width: 945, height: 630 }), box({ position: "absolute", left: 255, top: 0, width: 240, height: 630, backgroundImage: `linear-gradient(90deg, ${BACKDROP}, transparent)` })]
    : pictures.map((src, i) => {
        const companion = i === 1;
        return picture(src, companion ? { position: "absolute", right: 372, bottom: 6, width: 250, height: 250 } : { position: "absolute", right: -6, bottom: -26, width: 560, height: 560 });
      });
  return box(
    { position: "relative", width: 1200, height: 630, backgroundColor: model.backdrop ? BACKDROP : "#140b07", color: "#f6ece2", fontFamily: "Baloo" },
    model.backdrop ? null : box({ position: "absolute", left: 500, top: 10, width: 800, height: 800, opacity: 0.08 + model.glow * 0.5, backgroundImage: "radial-gradient(circle at center, #ff7a2f 0%, transparent 68%)" }),
    ...art,
    box(
      { position: "absolute", left: 60, top: 46, bottom: 42, width: model.backdrop ? 470 : 620, flexDirection: "column", justifyContent: "space-between" },
      box({ alignItems: "center", fontSize: 38, fontWeight: 800, letterSpacing: 2, color: "#ff7a2f" }, picture(mark, { width: 42, height: 42, marginRight: 8 }), "BONFIRE"),
      box(
        { flexDirection: "column" },
        box({ fontSize: 28, fontWeight: 600, color: "#b9a593" }, model.eyebrow),
        box({ fontSize: size, fontWeight: 800, lineHeight: 1.08, marginTop: 4 }, ink(model.headline)),
        model.value === null ? null : box({ alignItems: "baseline", marginTop: 14, color: "#ffc861" }, box({ fontSize: model.value.length > 6 ? 66 : 92, fontWeight: 800, lineHeight: 1 }, model.value), box({ fontSize: 30, fontWeight: 600, marginLeft: 14, color: "#b9a593" }, model.unit)),
        box({ fontSize: 28, fontWeight: 600, lineHeight: 1.25, marginTop: 10, color: "#f6ece2" }, ink(model.detail)),
      ),
      box({ fontSize: 22, fontWeight: 600, color: "#b9a593" }, FOOTER),
    ),
  );
}

async function image(model: CardModel, cacheControl: string): Promise<Response> {
  const { ImageResponse } = await import("@vercel/og");
  const [regular, bold] = await Promise.all([asset("baloo-2-latin-600-normal.woff"), asset("baloo-2-latin-800-normal.woff")]);
  const font = (data: Buffer, weight: 600 | 800) => ({ name: "Baloo", data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer, weight, style: "normal" as const });
  return new ImageResponse((await drawing(model)) as never, {
    width: 1200,
    height: 630,
    fonts: [font(regular, 600), font(bold, 800)],
    headers: { "cache-control": cacheControl },
  });
}

export function previewPage(card: CardRequest, model: CardModel, origin: string): string {
  const title = escapeHtml(`${model.headline} · BONFIRE`);
  const summary = escapeHtml(model.value === null ? model.detail : `${model.eyebrow}: ${model.value} ${model.unit}${model.detail.startsWith("for ") ? " " : ". "}${model.detail}`);
  const self = escapeHtml(origin + pathOf(card));
  const picture = escapeHtml(`${origin}/api/card?${imageQueryOf(card)}`);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<meta name="description" content="${summary}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${summary}">
<meta property="og:type" content="website">
<meta property="og:url" content="${self}">
<meta property="og:image" content="${picture}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${summary}">
<meta name="twitter:image" content="${picture}">
<script>location.replace("/");</script>
</head>
<body><a href="/">Open BONFIRE</a></body>
</html>
`;
}

const LIVE = "public, s-maxage=60, stale-while-revalidate=300";
const plain = (status: number, text: string) => new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const card = parseCard(url.searchParams);
  if (!card) return plain(400, "That isn't a card.");
  let model: CardModel | null;
  try {
    model = await load(card);
  } catch {
    return plain(503, "The network did not answer.");
  }
  if (!model) return plain(404, "No such card.");
  if (url.searchParams.get("html") === "1") {
    return new Response(previewPage(card, model, url.origin), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": LIVE } });
  }
  return image(model, LIVE);
}
