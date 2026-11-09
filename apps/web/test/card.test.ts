import assert from "node:assert/strict";
import { test } from "node:test";
import type { CommitmentView, Round, RoundPhase, RoundView } from "@bonfire/protocol";
import { escapeHtml, fireStage, imageQueryOf, missionCard, parseCard, pathOf, previewPage, receiptCard, roundCard, shortAccount, showEmber, showNear } from "../api/card.ts";
import * as format from "../src/format.ts";
import { fireStage as sceneStage } from "../src/scene.ts";

const E = 10n ** 18n;
const ember = (n: number) => (BigInt(n) * E).toString();

function round(phase: RoundPhase, live: number[], overrides: Partial<Round> = {}): RoundView {
  return {
    phase,
    live_totals: live.map(ember),
    counted_totals: null,
    current_checkpoint: null,
    now_ms: 0,
    round: {
      id: 4,
      threshold: ember(100),
      target: ember(400),
      budget: (2n * 10n ** 24n).toString(),
      winner: null,
      counted: "0",
      burned: "0",
      payout: "0",
      missions: [{ title: "Sticker pack" }, { title: "Leaderboard" }],
      ...overrides,
    } as Round,
  };
}

const record = (total: number, counted: number | null): CommitmentView =>
  ({ round_id: 4, mission: 0, commitment: { pre: ember(total), adds: [], deposit: "1" }, total: ember(total), counted: counted === null ? null : ember(counted), refundable_now: "0", burn_exposure: "0" });

const params = (query: string) => new URLSearchParams(query);

test("the copied helpers match the ones the site uses", () => {
  for (const value of [0n, 1n, E, (15n * E) / 10n, 1234567n * E + E / 3n]) {
    assert.equal(showEmber(value), format.showEmber(value));
    assert.equal(showNear(value * 10n ** 6n), format.showNear(value * 10n ** 6n));
  }
  for (const id of ["a.near", "g4f2b9d256c.bonfire-meraj-guests.testnet"]) assert.equal(shortAccount(id), format.shortAccount(id));
  for (const tally of [0n, 1n, 99n, 100n, 399n, 400n, 900n]) assert.equal(fireStage(tally, 100n, 400n), sceneStage(tally, 100n, 400n));
});

test("only well-formed cards are accepted", () => {
  assert.deepEqual(parseCard(params("kind=round&round=3")), { kind: "round", round: 3 });
  assert.deepEqual(parseCard(params("kind=mission&round=3&mission=1")), { kind: "mission", round: 3, mission: 1 });
  assert.deepEqual(parseCard(params("kind=receipt&round=3&mission=1&account=meraj5.testnet")), { kind: "receipt", round: 3, mission: 1, account: "meraj5.testnet" });
  for (const bad of ["", "kind=round", "kind=round&round=-1", "kind=round&round=1e3", "kind=mission&round=1", "kind=mission&round=1&mission=x", "kind=nope&round=1&mission=0", "kind=receipt&round=1&mission=0", "kind=receipt&round=1&mission=0&account=UP.near", 'kind=receipt&round=1&mission=0&account=a"><script>']) {
    assert.equal(parseCard(params(bad)), null, bad);
  }
});

test("a figure can't be supplied through the URL", () => {
  const card = parseCard(params("kind=round&round=3&value=999999&burned=999999"));
  assert.deepEqual(card, { kind: "round", round: 3 });
  assert.equal(imageQueryOf(card!), "kind=round&round=3");
});

test("paths and image links round-trip", () => {
  const card = { kind: "receipt", round: 2, mission: 1, account: "a.testnet" } as const;
  assert.equal(pathOf(card), "/s/p/2/1/a.testnet");
  assert.deepEqual(parseCard(params(imageQueryOf(card))), card);
  assert.equal(pathOf({ kind: "mission", round: 2, mission: 0 }), "/s/m/2/0");
  assert.equal(pathOf({ kind: "round", round: 2 }), "/s/r/2");
});

test("a mission card follows its own tally against the threshold", () => {
  const below = missionCard(round("Backing", [60, 0]), 0)!;
  assert.equal(below.value, "60");
  assert.match(below.detail, /40 more EMBER to qualify/);
  assert.equal(below.art[0], "fire-1.png");
  const past = missionCard(round("Backing", [150, 0]), 0)!;
  assert.match(past.detail, /Past the 100 EMBER threshold/);
  assert.equal(past.art[0], "fire-2.png");
  assert.equal(missionCard(round("Backing", [450, 0]), 0)!.art[1], "mascot-excited.png");
  assert.equal(missionCard(round("Backing", [0, 0]), 5), null);
});

test("only an accepted winner's card says burned", () => {
  const accepted = { winner: 0, status: "Accepted", burned: ember(120), counted: ember(120), payout: (75n * 10n ** 22n).toString() } as Partial<Round>;
  const won = missionCard(round("Accepted", [150, 20], accepted), 0)!;
  assert.equal(won.unit, "EMBER burned");
  assert.equal(won.value, "120");
  assert.match(won.detail, /0\.75 NEAR payout/);
  assert.notEqual(missionCard(round("Accepted", [150, 20], accepted), 1)!.unit, "EMBER burned");
  assert.notEqual(missionCard(round("AwaitingWork", [150, 20], { winner: 0, counted: ember(120) }), 0)!.unit, "EMBER burned");
  assert.notEqual(missionCard(round("FailedSelection", [50, 20]), 0)!.unit, "EMBER burned");
});

test("a round card reports the result the contract recorded", () => {
  const failed = roundCard(round("FailedSelection", [50, 20]));
  assert.equal(failed.value, null);
  assert.equal(failed.art[0], "mascot-shrug.png");
  const open = roundCard(round("Candle", [50, 220]));
  assert.equal(open.value, "220");
  assert.match(open.detail, /Up to 2 NEAR/);
  const accepted = roundCard(round("Accepted", [150, 0], { winner: 0, burned: ember(120), payout: "0" }));
  assert.equal(accepted.headline, "Sticker pack");
  assert.equal(accepted.value, "120");
});

test("a receipt says only what the record supports", () => {
  const open = receiptCard(round("Backing", [500, 0]), 0, "a.testnet", record(500, null), 0n)!;
  assert.equal(open.headline, "I fed the fire");
  assert.equal(open.value, "500");
  assert.match(open.detail, /only if this mission wins/);

  const burned = receiptCard(round("Accepted", [500, 0], { winner: 0 }), 0, "a.testnet", record(500, 300), 0n)!;
  assert.equal(burned.headline, "I burned");
  assert.equal(burned.value, "300");

  const lost = receiptCard(round("Accepted", [500, 900], { winner: 1 }), 0, "a.testnet", record(500, null), 0n)!;
  assert.equal(lost.headline, "I backed");

  const failed = receiptCard(round("FailedSelection", [500, 0]), 0, "a.testnet", record(500, null), 0n)!;
  assert.equal(failed.headline, "I backed");
  assert.match(failed.detail, /comes back/);
});

test("with no record a receipt claims nothing personal", () => {
  const stranger = receiptCard(round("Backing", [50, 0]), 0, "a.testnet", null, 0n)!;
  assert.equal(stranger.eyebrow, "Round 4 · Backing");
  assert.equal(stranger.backdrop, false);
  const keeper = receiptCard(round("Backing", [50, 0]), 0, "a.testnet", null, 7n * E)!;
  assert.equal(keeper.headline, "Fire Keeper");
  assert.equal(keeper.value, "7");
});

test("long titles are clipped", () => {
  const card = missionCard(round("Backing", [10], { missions: [{ title: "x".repeat(200) }] as Round["missions"] }), 0)!;
  assert.equal(card.headline.length, 64);
  assert.ok(card.headline.endsWith("…"));
});

test("on-chain titles can't inject markup into the preview page", () => {
  const evil = '"><script>alert(1)</script>';
  const model = missionCard(round("Backing", [10], { missions: [{ title: evil }] as Round["missions"] }), 0)!;
  const page = previewPage({ kind: "mission", round: 4, mission: 0 }, model, "https://example.test");
  assert.ok(!page.includes("<script>alert"));
  assert.ok(page.includes(escapeHtml(evil)));
  assert.ok(page.includes('og:image" content="https://example.test/api/card?kind=mission&amp;round=4&amp;mission=0"'));
});
