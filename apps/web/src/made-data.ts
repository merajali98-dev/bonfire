/** Work the fire has commissioned, and how each delivery stands against the chain. */
import type { RoundView } from "@bonfire/protocol";

export interface Piece {
  file: string;
  title: string;
}

export interface Delivery {
  /** The contract the round ran on. Rounds are read from it, not from the site's default contract. */
  contract: string;
  roundId: number;
  mission: string;
  /** SHA-256 of the delivered file, as committed in the repository. */
  hash: string;
  /** The delivered file as the site serves it. The build copies it from `deliveries/`. */
  download: string;
  repoPath: string;
  maker: string;
  /** What the delivered file is, as the page names it. */
  fileLabel: "zip" | "video";
  /** Images from the delivery shown on the page, or a video with its poster frame. */
  pieces: Piece[];
  video?: { poster: string };
  tools: string;
  usage?: string;
}

export const DELIVERIES: Delivery[] = [
  {
    contract: "fire.bonfire-hearth.testnet",
    roundId: 0,
    mission: "The hackathon demo video",
    hash: "c24cf5af5eb91ab5780797747a39f311f8ddd0f6ae8e1211c9c05541d5d555b0",
    download: "/deliveries/round-2/bonfire-demo.mp4",
    repoPath: "deliveries/round-2",
    maker: "bonfire-meraj-maker1.testnet",
    fileLabel: "video",
    pieces: [],
    video: { poster: "/video/bonfire-demo-poster.jpg" },
    tools: "Recorded from this site on a phone-sized screen and edited by Claude Code, narrated with Gemini TTS, with music from Lyria. Every transaction it shows is real, with its hash on screen.",
  },
  {
    contract: "bonfire-meraj-contract.testnet",
    roundId: 2,
    mission: "EMBER sticker pack",
    hash: "e47961602280ed503bc2cf617f6e9e97f48f726a94b6d0df0c7c3e4bd87c74b7",
    download: "/deliveries/round-1/ember-sticker-pack.zip",
    repoPath: "deliveries/round-1",
    maker: "bonfire-meraj-maker1.testnet",
    fileLabel: "zip",
    tools: "Made with OpenAI ImageGen from the site's mascot. The note inside the zip names the tools and lists the prompts.",
    usage: "Free for anyone to use, copy, share and adapt. Tap a sticker to save it as a 512 px WebP.",
    pieces: [
      { file: "/stickers/01-stoke-the-fire.webp", title: "Stoke the fire" },
      { file: "/stickers/02-roast-a-marshmallow.webp", title: "Roast a marshmallow" },
      { file: "/stickers/03-light-the-way.webp", title: "Light the way" },
      { file: "/stickers/04-wave-hello.webp", title: "Wave hello" },
      { file: "/stickers/05-warm-up.webp", title: "Warm up" },
      { file: "/stickers/06-work-accepted.webp", title: "Work accepted" },
    ],
  },
];

export type Standing =
  | { kind: "accepted"; burned: bigint; payout: bigint; paid: boolean }
  | { kind: "in-review" }
  | { kind: "mismatch"; onChain: string | null }
  | { kind: "other"; phase: string };

/** What the chain says about a delivery. A file whose hash isn't the one submitted is never shown as the work. */
export function standingOf(view: RoundView, delivery: Delivery): Standing {
  const r = view.round;
  const submitted = r.submission?.hash.toLowerCase() ?? null;
  if (submitted !== delivery.hash) return { kind: "mismatch", onChain: submitted };
  if (view.phase === "Accepted") return { kind: "accepted", burned: BigInt(r.burned), payout: BigInt(r.payout), paid: r.payout_state === "Paid" };
  if (view.phase === "AwaitingReview") return { kind: "in-review" };
  return { kind: "other", phase: view.phase };
}

export async function sha256OfBytes(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
