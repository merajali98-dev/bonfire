import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { Round, RoundPhase, RoundView } from "@bonfire/protocol";
import { DELIVERIES, sha256OfBytes, standingOf } from "../src/made-data.ts";

const stickers = DELIVERIES[0];

function round(phase: RoundPhase, hash: string | null, overrides: Partial<Round> = {}): RoundView {
  return {
    phase,
    live_totals: [],
    counted_totals: null,
    current_checkpoint: null,
    now_ms: 0,
    round: { id: 2, submission: hash ? { hash, uri: "https://example.test/pack.zip", at_ms: 0 } : null, burned: "0", payout: "0", payout_state: "None", ...overrides } as Round,
  };
}

test("the recorded hash is the hash of the zip in the repository", () => {
  const bytes = readFileSync(new URL(`../../../${stickers.repoPath}/ember-sticker-pack.zip`, import.meta.url));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), stickers.hash);
  assert.equal(stickers.download, `/${stickers.repoPath}/ember-sticker-pack.zip`);
});

test("every sticker on the site exists", () => {
  for (const piece of stickers.pieces) readFileSync(new URL(`../public${piece.file}`, import.meta.url));
  assert.equal(stickers.pieces.length, 6);
});

test("a delivery is shown only when the chain holds its exact hash", () => {
  assert.deepEqual(standingOf(round("AwaitingReview", stickers.hash), stickers), { kind: "in-review" });
  assert.deepEqual(standingOf(round("AwaitingReview", stickers.hash.toUpperCase()), stickers), { kind: "in-review" });
  assert.deepEqual(standingOf(round("AwaitingReview", "ab".repeat(32)), stickers), { kind: "mismatch", onChain: "ab".repeat(32) });
  assert.deepEqual(standingOf(round("AwaitingWork", null), stickers), { kind: "mismatch", onChain: null });
});

test("an accepted delivery reports what burned and what was paid", () => {
  const accepted = round("Accepted", stickers.hash, { burned: "15", payout: "7", payout_state: "Paid" });
  assert.deepEqual(standingOf(accepted, stickers), { kind: "accepted", burned: 15n, payout: 7n, paid: true });
  const rejected = round("Rejected", stickers.hash);
  assert.deepEqual(standingOf(rejected, stickers), { kind: "other", phase: "Rejected" });
});

test("the browser hash helper agrees with node", async () => {
  const bytes = new TextEncoder().encode("bonfire");
  assert.equal(await sha256OfBytes(bytes.buffer), createHash("sha256").update("bonfire").digest("hex"));
});
