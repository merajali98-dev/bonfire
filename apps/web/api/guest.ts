/**
 * Creates a labeled testnet guest account for a public key generated in the browser.
 * The private key never leaves the visitor's device. This route is onboarding only: nothing
 * in the game depends on it, and it holds only a testnet key for the guest parent account.
 */
import { randomBytes } from "node:crypto";
import { Account, nearToYocto, type KeyPairString } from "near-api-js";

const RPC_URL = process.env.BONFIRE_RPC ?? "https://rpc.testnet.fastnear.com";
const PER_IP_PER_HOUR = 3;
const PER_INSTANCE_PER_HOUR = 40;
const HOUR_MS = 3_600_000;

// Per server instance, so this slows abuse rather than stopping it. The parent account's
// balance is the hard cap on what can ever be spent.
const recent = new Map<string, number[]>();

function allowed(key: string, limit: number, now: number): boolean {
  const hits = (recent.get(key) ?? []).filter((at) => now - at < HOUR_MS);
  recent.set(key, hits);
  if (hits.length >= limit) return false;
  hits.push(now);
  return true;
}

const reply = (status: number, body: object) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export async function POST(request: Request): Promise<Response> {
  const parent = process.env.GUEST_PARENT;
  const secret = process.env.GUEST_SECRET_KEY as KeyPairString | undefined;
  if (!parent || !secret) return reply(503, { error: "Guest accounts are not set up on this deployment." });

  let publicKey: unknown;
  try {
    ({ publicKey } = (await request.json()) as { publicKey?: unknown });
  } catch {
    return reply(400, { error: "Send a JSON body with a publicKey." });
  }
  if (typeof publicKey !== "string" || !/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(publicKey)) {
    return reply(400, { error: "That is not an ed25519 public key." });
  }

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const now = Date.now();
  if (!allowed(`ip:${ip}`, PER_IP_PER_HOUR, now) || !allowed("all", PER_INSTANCE_PER_HOUR, now)) {
    return reply(429, { error: "Too many guest accounts right now. Try again later, or connect a wallet." });
  }

  const prefix = `g${randomBytes(5).toString("hex")}`;
  try {
    const account = new Account(parent, RPC_URL, secret);
    await account.createSubAccount({ accountOrPrefix: prefix, publicKey, nearToTransfer: nearToYocto((process.env.GUEST_FUND_NEAR ?? "0.1") as `${number}`) });
  } catch (error) {
    console.error("guest creation failed", error);
    return reply(502, { error: "The guest account could not be created. Try again, or connect a wallet." });
  }
  return reply(200, { accountId: `${prefix}.${parent}` });
}
