/**
 * BONFIRE testnet operator tool. Wraps near-cli-rs for signing and reads over public RPC.
 * Usage and the full run order are in scripts/README.md.
 *
 * Keys stay in the near CLI's legacy keychain (~/.near-credentials) and never enter the repo.
 * The manifest in deployments/ records only account IDs, the code hash and transaction hashes.
 */
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { COMMIT_DEPOSIT } from "../packages/protocol/src/constants.ts";
import { ERROR_MESSAGES, parseErrorCode } from "../packages/protocol/src/errors.ts";
import type { Audit, CommitmentView, CreateRoundArgs, NextRoundTerms, Nomination, RoundPhase, RoundView } from "../packages/protocol/src/types.ts";

const exec = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEV_MANIFEST_PATH = join(ROOT, "deployments", "testnet-dev.json");
const DEFAULT_WASM = join(ROOT, "contracts", "bonfire", "target", "near", "bonfire.wasm");
const RPC_URL = process.env.BONFIRE_RPC ?? "https://rpc.testnet.fastnear.com";
const NEAR_BIN = process.env.NEAR_BIN ?? "near";
const REPO_BLOB = "https://github.com/merajali98-dev/bonfire/blob/main/";
const STORAGE_BYTE_COST = 10n ** 19n;
const ONE_NEAR = 10n ** 24n;
const ONE_EMBER = 10n ** 18n;

const ROLES = ["contract", "curator", "dist", "stoker", "maker1", "maker2", "maker3", "backer1", "backer2", "guests"] as const;
type Role = (typeof ROLES)[number];

interface TxRecord {
  action: string;
  signer: string;
  tx_hash: string | null;
  at: string;
}

interface Manifest {
  network: "testnet";
  note: string;
  prefix: string;
  accounts: Record<Role, string>;
  wasm_sha256: string | null;
  code_hash: string | null;
  deployed_at: string | null;
  transactions: TxRecord[];
}

interface MissionSpec {
  title: string;
  brief: string;
  maker: Role;
}

const MISSION_SETS: Record<string, MissionSpec[]> = {
  "round-1": [
    { title: "EMBER sticker pack", brief: "docs/briefs/round-1/sticker-pack.md", maker: "maker1" },
    { title: "Fire Keepers leaderboard", brief: "docs/briefs/round-1/fire-keepers.md", maker: "maker2" },
    { title: "15-second mascot animation", brief: "docs/briefs/round-1/mascot-animation.md", maker: "maker3" },
  ],
  // Round 2 runs on the keyless deployment. Fire Keepers returns from Round 1, which it lost.
  "round-2": [
    { title: "The hackathon demo video", brief: "docs/briefs/round-2/demo-video.md", maker: "maker1" },
    { title: "Judge guide page", brief: "docs/briefs/round-2/judge-guide.md", maker: "maker2" },
    { title: "Fire Keepers leaderboard", brief: "docs/briefs/round-1/fire-keepers.md", maker: "maker3" },
  ],
  demo: [
    { title: "[demo] Delivery A", brief: "docs/briefs/demo.md", maker: "maker1" },
    { title: "[demo] Delivery B", brief: "docs/briefs/demo.md", maker: "maker2" },
    { title: "[demo] Delivery C", brief: "docs/briefs/demo.md", maker: "maker3" },
  ],
};

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    prefix: { type: "string" },
    wasm: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    stoke: { type: "string", default: "8" },
    set: { type: "string", default: "round-1" },
    "open-in": { type: "string", default: "2m" },
    backing: { type: "string", default: "12h" },
    candle: { type: "string", default: "2h" },
    checkpoints: { type: "string", default: "12" },
    delivery: { type: "string", default: "24h" },
    review: { type: "string", default: "12h" },
    as: { type: "string" },
    file: { type: "string" },
    uri: { type: "string" },
    accounts: { type: "string" },
    deployment: { type: "string", default: "dev" },
    contract: { type: "string" },
    fund: { type: "string" },
    send: { type: "boolean", default: false },
  },
});
const dryRun = opts["dry-run"];
if (opts.deployment !== "dev" && opts.deployment !== "keyless") throw new Error("--deployment is dev or keyless.");
/** deployments/testnet.json is the keyless final deployment; testnet-dev.json the development one. */
const MANIFEST_PATH = opts.deployment === "keyless" || positionals[0] === "keyless" ? join(ROOT, "deployments", "testnet.json") : DEV_MANIFEST_PATH;
/**
 * accept and reject need exactly 1 yocto on the reviewed contract. The development deployment runs
 * older code whose accept and reject refuse any deposit.
 */
const REVIEW_DEPOSIT = opts.deployment === "keyless" ? 1n : 0n;

// ------------------------------------------------------------------ helpers

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const sha256Hex = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

function base58(bytes: Uint8Array): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = BigInt("0x" + Buffer.from(bytes).toString("hex"));
  let out = "";
  while (value > 0n) {
    out = alphabet[Number(value % 58n)] + out;
    value /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

function parseDecimal(text: string, unit: bigint, decimals: number): bigint {
  const match = text.match(/^(\d+)(?:\.(\d+))?$/);
  const fraction = match?.[2] ?? "";
  if (!match?.[1] || fraction.length > decimals) throw new Error(`Not a valid amount: ${text}`);
  return BigInt(match[1]) * unit + BigInt(fraction.padEnd(decimals, "0") || "0");
}
const near = (text: string) => parseDecimal(text, ONE_NEAR, 24);
const ember = (text: string) => parseDecimal(text, ONE_EMBER, 18);
const showNear = (value: string | bigint) => (Number(BigInt(value) / 10n ** 20n) / 1e4).toString() + " NEAR";
const showEmber = (value: string | bigint) => (Number(BigInt(value) / 10n ** 14n) / 1e4).toLocaleString("en-US") + " EMBER";

function durationMs(text: string): number {
  const match = text.match(/^(\d+)(s|m|h|d)$/);
  if (!match?.[1] || !match[2]) throw new Error(`Durations look like 90s, 5m, 12h or 2d. Got: ${text}`);
  return Number(match[1]) * { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as "s" | "m" | "h" | "d"];
}

function positional(index: number, name: string): string {
  const value = positionals[index];
  if (value === undefined) throw new Error(`Missing argument: ${name}`);
  return value;
}

const roundArg = (index: number) => Number(positional(index, "round id"));

// ------------------------------------------------------------------ manifest

function accountsFor(prefix: string): Record<Role, string> {
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(prefix)) throw new Error("--prefix must be lowercase letters, digits and dashes.");
  return Object.fromEntries(ROLES.map((role) => [role, `${prefix}-${role}.testnet`])) as Record<Role, string>;
}

function newManifest(prefix: string): Manifest {
  return {
    network: "testnet",
    note: "Development deployment. Every account here is a team-run, labeled demo actor. The contract account has an access key.",
    prefix,
    accounts: accountsFor(prefix),
    wasm_sha256: null,
    code_hash: null,
    deployed_at: null,
    transactions: [],
  };
}

function loadManifest(): Manifest {
  if (existsSync(MANIFEST_PATH)) {
    const saved = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest;
    return { ...saved, accounts: { ...accountsFor(saved.prefix), ...saved.accounts } };
  }
  if (dryRun) return newManifest(opts.prefix ?? "example");
  throw new Error("No deployment manifest yet. Run: npm run testnet -- accounts --prefix <name>");
}

function saveManifest(manifest: Manifest): void {
  if (dryRun) return;
  mkdirSync(dirname(MANIFEST_PATH), { recursive: true });
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");
}

let m: Manifest;

/** Accepts a role name from the manifest or a full account ID. */
function who(name: string): string {
  const role = m.accounts[name as Role];
  if (role) return role;
  if (name.includes(".") || /^[0-9a-f]{64}$/.test(name)) return name;
  throw new Error(`Unknown account or role: ${name}`);
}

// ------------------------------------------------------------------ reads (no key needed)

interface RpcErrorBody {
  message?: string;
  data?: unknown;
  cause?: { name?: string };
}

class RpcError extends Error {
  readonly causeName: string | undefined;
  constructor(body: RpcErrorBody) {
    super(JSON.stringify(body));
    this.causeName = body.cause?.name;
  }
}

/** Retries rate limits and network failures. Contract and account errors are not retried. */
async function rpc<T>(params: Record<string, unknown>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    if (attempt > 0) await sleep(1_000 * 2 ** attempt);
    try {
      const response = await fetch(RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "bonfire", method: "query", params }),
        signal: AbortSignal.timeout(20_000),
      });
      if (response.status === 429 || response.status >= 500) throw new Error(`RPC returned HTTP ${response.status}`);
      const body = (await response.json()) as { result?: T; error?: RpcErrorBody };
      if (body.error) throw new RpcError(body.error);
      return body.result as T;
    } catch (error) {
      if (error instanceof RpcError) throw error;
      lastError = error;
    }
  }
  throw new Error(`RPC unreachable at ${RPC_URL}: ${String(lastError)}`);
}

interface AccountView {
  amount: string;
  locked: string;
  code_hash: string;
  storage_usage: number;
}

const NO_CODE = "11111111111111111111111111111111";

async function accountInfo(accountId: string): Promise<AccountView | null> {
  try {
    return await rpc<AccountView>({ request_type: "view_account", finality: "optimistic", account_id: accountId });
  } catch (error) {
    if (error instanceof RpcError && error.causeName === "UNKNOWN_ACCOUNT") return null;
    throw error;
  }
}

async function view<T>(method: string, args: object = {}): Promise<T> {
  const result = await rpc<{ result?: number[]; error?: string }>({
    request_type: "call_function",
    finality: "optimistic",
    account_id: m.accounts.contract,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  if (result.error || !result.result) throw new Error(`View ${method} failed: ${result.error ?? "empty result"}`);
  return JSON.parse(Buffer.from(result.result).toString("utf8")) as T;
}

async function isInitialized(): Promise<boolean> {
  try {
    await view("get_config");
    return true;
  } catch {
    return false;
  }
}

async function allNominations(): Promise<Nomination[]> {
  const all: Nomination[] = [];
  for (;;) {
    const page = await view<Nomination[]>("get_nominations", { from_index: all.length, limit: 100 });
    all.push(...page);
    if (page.length < 100) return all;
  }
}

async function getRound(roundId: number): Promise<RoundView> {
  const round = await view<RoundView | null>("get_round", { round_id: roundId });
  if (!round) throw new Error(`Round ${roundId} does not exist.`);
  return round;
}

// ------------------------------------------------------------------ writes (signed by the near CLI)

function explainFailure(output: string): string {
  const code = parseErrorCode(output);
  if (code) return `${code}: ${ERROR_MESSAGES[code]}`;
  return output.replace(/\x1b\[[0-9;]*m/g, "").trim().split("\n").slice(-12).join("\n");
}

async function runNear(action: string, signer: string, args: string[]): Promise<void> {
  if (dryRun) {
    console.log(`[dry-run] near ${args.join(" ")}`);
    return;
  }
  let output = "";
  for (let attempt = 1; ; attempt++) {
    try {
      const result = await exec(NEAR_BIN, args, { maxBuffer: 20 * 1024 * 1024, timeout: 240_000, windowsHide: true });
      output = result.stdout + result.stderr;
      break;
    } catch (error) {
      const failed = error as { stdout?: string; stderr?: string; message: string };
      const text = `${failed.stdout ?? ""}${failed.stderr ?? ""}` || failed.message;
      // The CLI reads the signer's keys before it signs, so this failure means nothing was sent.
      if (attempt < 4 && text.includes("Failed to fetch access KeyList")) {
        console.log(`  ${action}: network error before sending. Retrying.`);
        await sleep(3_000 * attempt);
        continue;
      }
      throw new Error(`${action} failed. ${explainFailure(text)}`);
    }
  }
  if (/Smart contract panicked|ERR_[A-Z_]{3,}/.test(output)) throw new Error(`${action} failed. ${explainFailure(output)}`);
  const hash = output.match(/Transaction ID:\s*([1-9A-HJ-NP-Za-km-z]{43,44})/)?.[1] ?? output.match(/transactions\/([1-9A-HJ-NP-Za-km-z]{43,44})/)?.[1] ?? null;
  m.transactions.push({ action, signer, tx_hash: hash, at: new Date().toISOString() });
  saveManifest(m);
  console.log(`  ok  ${action}${hash ? `  ${hash}` : ""}`);
}

function deposit(yocto: bigint): string {
  return yocto === 0n ? "0 NEAR" : `${yocto} yoctoNEAR`;
}

async function call(signer: string, method: string, args: object, attached = 0n): Promise<void> {
  await runNear(`${method}`, signer, [
    "contract", "call-function", "as-transaction", m.accounts.contract, method,
    "json-args", JSON.stringify(args),
    "prepaid-gas", "100 Tgas",
    "attached-deposit", deposit(attached),
    "sign-as", signer,
    "network-config", "testnet",
    "sign-with-legacy-keychain", "send",
  ]);
}

// ------------------------------------------------------------------ parameters the contract takes
// Genesis and round arguments live only here, so a change to the contract's API is one edit.

function genesisArgs(): object {
  return {
    curator: m.accounts.curator,
    distribution_account: m.accounts.dist,
    distribution_amount: ember("850000").toString(),
    faucet_pool: ember("150000").toString(),
    faucet_amount: ember("1000").toString(),
    faucet_interval_ms: 86_400_000,
    nominate_min_ash: ember("1000").toString(),
    rules: {
      budget_bps: 2_500,
      min_budget: near("1").toString(),
      initial_threshold: ember("10000").toString(),
      min_threshold: ember("1000").toString(),
      up_bps: 10_500,
      down_bps: 8_500,
      target_multiple: 4,
    },
    // Each window's bounds. A minimum of an hour of backing means walking the threshold from
    // 10,000 to its floor with empty rounds takes at least 15 hours of rounds.
    limits: {
      max_lead_ms: 2 * DAY_MS,
      min_backing_ms: HOUR_MS,
      max_backing_ms: 7 * DAY_MS,
      min_candle_ms: 10 * 60_000,
      max_candle_ms: DAY_MS,
      min_delivery_ms: HOUR_MS,
      max_delivery_ms: 3 * DAY_MS,
      min_review_ms: HOUR_MS,
      max_review_ms: 3 * DAY_MS,
    },
  };
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

interface RoundPlan {
  nominationIds: number[];
  openInMs: number;
  backingMs: number;
  candleMs: number;
  checkpoints: number;
  deliveryMs: number;
  reviewMs: number;
}

function createRoundArgs(plan: RoundPlan): CreateRoundArgs {
  if (plan.candleMs >= plan.backingMs) throw new Error("The candle is the final part of backing, so it must be shorter than --backing.");
  const open = Date.now() + plan.openInMs;
  const close = open + plan.backingMs;
  const delivery = close + plan.deliveryMs;
  return {
    nomination_ids: plan.nominationIds,
    reviewer: m.accounts.curator,
    open_at_ms: open,
    candle_start_ms: close - plan.candleMs,
    backing_close_ms: close,
    delivery_deadline_ms: delivery,
    review_deadline_ms: delivery + plan.reviewMs,
    checkpoints: plan.checkpoints,
  };
}

async function createRound(plan: RoundPlan): Promise<number> {
  if (!dryRun && !(await view<NextRoundTerms>("get_next_round_terms")).funded) {
    throw new Error("The Hearth is too low: this round's computed budget would be under the minimum. Stoke more first.");
  }
  await call(m.accounts.curator, "create_round", { args: createRoundArgs(plan) });
  return dryRun ? 0 : (await view<number>("get_round_count")) - 1;
}

// ------------------------------------------------------------------ commands

async function cmdDoctor(): Promise<void> {
  const version = await exec(NEAR_BIN, ["--version"]).catch(() => null);
  console.log(`near CLI: ${version ? version.stdout.trim() : "NOT FOUND"}`);
  console.log(`RPC:      ${RPC_URL}`);
  const wasm = opts.wasm ?? DEFAULT_WASM;
  if (existsSync(wasm)) {
    const bytes = readFileSync(wasm);
    console.log(`wasm:     ${bytes.length} bytes, locks ${showNear(BigInt(bytes.length) * STORAGE_BYTE_COST)}, code hash ${base58(createHash("sha256").update(bytes).digest())}`);
  } else {
    console.log(`wasm:     MISSING at ${wasm}`);
  }
  if (!opts.prefix && !existsSync(MANIFEST_PATH)) {
    console.log("accounts: pass --prefix <name> to check them");
    return;
  }
  const accounts = opts.prefix ? accountsFor(opts.prefix) : loadManifest().accounts;
  for (const role of ROLES) {
    const id = accounts[role];
    const info = await accountInfo(id);
    const key = existsSync(join(homedir(), ".near-credentials", "testnet", `${id}.json`));
    console.log(`  ${role.padEnd(9)} ${id.padEnd(44)} ${info ? showNear(info.amount).padEnd(14) : "not created".padEnd(14)} key ${key ? "present" : "absent"}`);
  }
}

async function cmdAccounts(): Promise<void> {
  if (!opts.prefix) throw new Error("Pass --prefix <name>. Account names become <name>-contract.testnet and so on.");
  m = existsSync(MANIFEST_PATH) ? loadManifest() : newManifest(opts.prefix);
  if (m.prefix !== opts.prefix && !dryRun) {
    throw new Error(`The manifest already uses prefix ${m.prefix}. Move or delete deployments/testnet-dev.json to start a new deployment.`);
  }
  saveManifest(m);
  for (const role of ROLES) {
    const id = m.accounts[role];
    if (!dryRun && (await accountInfo(id))) {
      console.log(`  skip ${id} (already exists)`);
      continue;
    }
    await createAccount(role, id);
    if (!dryRun) await sleep(5_000);
  }
}

/**
 * The faucet service can create the account and still fail to answer the CLI, so a failed
 * attempt only counts once the chain confirms there is no account. Retrying sooner would
 * replace the saved key with a new one that the account does not have.
 */
async function createAccount(role: Role, id: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await runNear(`create account ${role}`, id, [
        "account", "create-account", "sponsor-by-faucet-service", id,
        "autogenerate-new-keypair", "save-to-legacy-keychain",
        "network-config", "testnet", "create",
      ]);
      return;
    } catch (error) {
      if (dryRun) throw error;
      console.log(`  ${role}: no answer from the faucet service. Checking the chain.`);
      for (let check = 0; check < 12; check++) {
        await sleep(5_000);
        if (await accountInfo(id)) {
          console.log(`  ok  create account ${role} (confirmed on chain)`);
          return;
        }
      }
      if (attempt === 3) throw error;
      console.log(`  ${role}: not created. Retrying (attempt ${attempt + 1} of 3).`);
    }
  }
}

async function cmdDeploy(): Promise<void> {
  const wasmPath = resolve(opts.wasm ?? DEFAULT_WASM);
  if (!existsSync(wasmPath)) throw new Error(`No wasm at ${wasmPath}. Run: cargo near build non-reproducible-wasm --no-abi`);
  const bytes = readFileSync(wasmPath);
  const codeHash = base58(createHash("sha256").update(bytes).digest());
  if (!dryRun) {
    const info = await accountInfo(m.accounts.contract);
    if (!info) throw new Error("The contract account does not exist yet. Run the accounts command first.");
    const needed = BigInt(bytes.length) * STORAGE_BYTE_COST + ONE_NEAR;
    if (BigInt(info.amount) < needed) throw new Error(`The contract account holds ${showNear(info.amount)} and needs at least ${showNear(needed)}.`);
    if (info.code_hash !== NO_CODE) {
      if (info.code_hash === codeHash && (await isInitialized())) {
        console.log("Already deployed with this exact code.");
        return;
      }
      throw new Error("This account already holds different code. State layouts may not match, so use a new --prefix for a fresh deployment.");
    }
  }
  await runNear("deploy and init", m.accounts.contract, [
    "contract", "deploy", m.accounts.contract, "use-file", wasmPath,
    "with-init-call", "new", "json-args", JSON.stringify(genesisArgs()),
    "prepaid-gas", "100 Tgas", "attached-deposit", "0 NEAR",
    "network-config", "testnet", "sign-with-legacy-keychain", "send",
  ]);
  if (dryRun) return;
  const after = await accountInfo(m.accounts.contract);
  if (after?.code_hash !== codeHash) throw new Error(`On-chain code hash ${after?.code_hash} does not match the local wasm ${codeHash}.`);
  m.wasm_sha256 = sha256Hex(bytes);
  m.code_hash = codeHash;
  m.deployed_at = new Date().toISOString();
  saveManifest(m);
  const audit = await view<Audit>("audit");
  console.log(`Deployed. Code hash ${codeHash}. Operating surplus ${showNear(audit.operating_surplus)}.`);
}

function briefFacts(spec: MissionSpec): { brief_uri: string; brief_hash: string } {
  return { brief_uri: REPO_BLOB + spec.brief, brief_hash: sha256Hex(readFileSync(join(ROOT, spec.brief))) };
}

function missionSet(name: string): MissionSpec[] {
  const set = MISSION_SETS[name];
  if (!set) throw new Error(`Unknown mission set: ${name}. Known sets: ${Object.keys(MISSION_SETS).join(", ")}`);
  return set;
}

/** Nominates and consents to any mission in the list that has no unused nomination yet. */
async function ensureNominations(list: MissionSpec[]): Promise<number[]> {
  const ids: number[] = [];
  const match = (all: Nomination[], spec: MissionSpec) =>
    all.find((n) => n.title === spec.title && n.creator === m.accounts[spec.maker] && n.used_in === null);
  for (const spec of list) {
    const creator = m.accounts[spec.maker];
    let nomination = dryRun ? undefined : match(await allNominations(), spec);
    if (!nomination) {
      await call(m.accounts.curator, "nominate", { creator, title: spec.title, ...briefFacts(spec) });
      if (dryRun) {
        await call(creator, "consent", { nomination_id: 0 });
        ids.push(0);
        continue;
      }
      nomination = match(await allNominations(), spec);
      if (!nomination) throw new Error(`Nomination for "${spec.title}" did not appear.`);
    }
    if (!nomination.consented) await call(creator, "consent", { nomination_id: nomination.id });
    ids.push(nomination.id);
  }
  return ids;
}

async function fundBacker(id: string, amount: bigint): Promise<void> {
  const registered = !dryRun && (await view<unknown>("storage_balance_of", { account_id: id })) !== null;
  if (!registered) await call(id, "storage_deposit", { registration_only: true }, COMMIT_DEPOSIT_BIG);
  const balance = dryRun ? 0n : BigInt(await view<string>("ft_balance_of", { account_id: id }));
  if (balance < amount) {
    await call(m.accounts.dist, "ft_transfer", { receiver_id: id, amount: (amount - balance).toString(), memo: "team demo actor" }, 1n);
  }
}

const COMMIT_DEPOSIT_BIG = BigInt(COMMIT_DEPOSIT);

async function cmdSeed(): Promise<void> {
  const wanted = near(opts.stoke);
  const audit = dryRun ? null : await view<Audit>("audit");
  if (!audit || BigInt(audit.total_stoked) < wanted) {
    await call(m.accounts.stoker, "stoke", {}, wanted - BigInt(audit?.total_stoked ?? 0));
  } else {
    console.log(`  skip stoke (${showNear(audit.total_stoked)} already stoked)`);
  }
  await fundBacker(m.accounts.backer1, ember("20000"));
  await fundBacker(m.accounts.backer2, ember("10000"));
  await ensureNominations(missionSet(opts.set));
}

async function cmdRound(): Promise<void> {
  const list = missionSet(opts.set);
  const ids = await ensureNominations(list);
  const round = await createRound({
    nominationIds: ids,
    openInMs: durationMs(opts["open-in"]),
    backingMs: durationMs(opts.backing),
    candleMs: durationMs(opts.candle),
    checkpoints: Number(opts.checkpoints),
    deliveryMs: durationMs(opts.delivery),
    reviewMs: durationMs(opts.review),
  });
  console.log(`Round ${round} created.`);
}

async function printRound(roundId: number): Promise<RoundView> {
  const view_ = await getRound(roundId);
  const r = view_.round;
  console.log(`\nRound ${r.id}: ${view_.phase}  (budget ${showNear(r.budget)}, threshold ${showEmber(r.threshold)}, target ${showEmber(r.target)})`);
  console.log(`  opens ${new Date(r.open_at_ms).toISOString()}  candle ${new Date(r.candle_start_ms).toISOString()}  closes ${new Date(r.backing_close_ms).toISOString()}`);
  r.missions.forEach((mission, i) => {
    const counted = view_.counted_totals?.[i];
    const mark = r.winner === i ? " <- winner" : "";
    console.log(`  [${i}] ${mission.title}: live ${showEmber(view_.live_totals[i] ?? "0")}${counted ? `, counted ${showEmber(counted)}` : ""}${mark}`);
  });
  if (r.drawn_checkpoint !== null) console.log(`  drawn checkpoint ${r.drawn_checkpoint}, burned ${showEmber(r.burned)}, payout ${showNear(r.payout)} (${r.payout_state})`);
  return view_;
}

function reportAudit(audit: Audit): boolean {
  const ok = audit.supply_ok && audit.escrow_ok && audit.near_ok;
  console.log(`\nAudit: ${ok ? "reconciled" : "FAILED"}  supply ${audit.supply_ok}, escrow ${audit.escrow_ok}, near ${audit.near_ok}`);
  console.log(`  supply ${showEmber(audit.total_supply)}, burned ${showEmber(audit.total_burned)}, escrow ${showEmber(audit.escrow_total)}, faucet ${showEmber(audit.faucet_remaining)}`);
  console.log(`  hearth ${showNear(audit.hearth_pool)}, reserved ${showNear(audit.reserved_total)}, paid ${showNear(audit.total_paid)}, reserve ${showNear(audit.operating_surplus)}`);
  return ok;
}

async function cmdStatus(): Promise<void> {
  const count = await view<number>("get_round_count");
  const requested = positionals[1];
  if (requested !== undefined) {
    await printRound(Number(requested));
  } else {
    for (let id = 0; id < count; id++) await printRound(id);
    if (count === 0) console.log("No rounds yet.");
  }
  const terms = await view<NextRoundTerms>("get_next_round_terms");
  console.log(`
Next round: budget ${showNear(terms.budget)}, threshold ${showEmber(terms.threshold)}, target ${showEmber(terms.target)}${terms.funded ? "" : " (Hearth too low to open it)"}`);
  if (!reportAudit(await view<Audit>("audit"))) process.exitCode = 1;
}

async function cmdCommit(): Promise<void> {
  const signer = who(opts.as ?? "backer1");
  await commitAs(signer, roundArg(1), Number(positional(2, "mission")), ember(positional(3, "amount")));
}

async function commitAs(signer: string, roundId: number, mission: number, amount: bigint): Promise<void> {
  const existing = dryRun ? null : await view<CommitmentView | null>("get_commitment", { round_id: roundId, account_id: signer, mission });
  await call(signer, "commit", { round_id: roundId, mission, amount: amount.toString() }, existing ? 1n : COMMIT_DEPOSIT_BIG);
}

async function submitWork(roundId: number, file: string, uri: string, signer?: string): Promise<string> {
  const round = await getRound(roundId);
  if (round.round.winner === null) throw new Error("This round has no winner.");
  const creator = signer ?? round.round.missions[round.round.winner]?.creator;
  if (!creator) throw new Error("Winning mission not found.");
  const hash = sha256Hex(readFileSync(resolve(file)));
  await call(creator, "submit", { round_id: roundId, hash, uri });
  return hash;
}

async function cmdSubmit(): Promise<void> {
  if (!opts.file || !opts.uri) throw new Error("Pass --file <delivered artifact> and --uri <where it can be retrieved>.");
  console.log(`Submitted hash ${await submitWork(roundArg(1), opts.file, opts.uri, opts.as ? who(opts.as) : undefined)}`);
}

async function cmdAccept(): Promise<void> {
  const roundId = roundArg(1);
  const round = await getRound(roundId);
  const hash = round.round.submission?.hash;
  if (!hash) throw new Error("Nothing has been submitted for this round.");
  await call(opts.as ? who(opts.as) : round.round.reviewer, "accept", { round_id: roundId, hash }, REVIEW_DEPOSIT);
}

async function cmdReject(): Promise<void> {
  const roundId = roundArg(1);
  const round = await getRound(roundId);
  await call(opts.as ? who(opts.as) : round.round.reviewer, "reject", { round_id: roundId }, REVIEW_DEPOSIT);
}

/** select, expire and claim_payout can be sent by anyone. */
async function cmdPermissionless(method: string): Promise<void> {
  await call(who(opts.as ?? "dist"), method, { round_id: roundArg(1) });
}

async function cmdSettle(): Promise<void> {
  await call(who(opts.as ?? "dist"), "settle", { round_id: roundArg(1), account_id: who(positional(2, "account")) });
}

/**
 * Settles every listed account that holds a record in this round. The contract keeps no
 * enumerable list of backers, so anyone outside the manifest must be passed in --accounts.
 */
async function cmdSettleAll(): Promise<void> {
  const roundId = roundArg(1);
  const extra = opts.accounts ? opts.accounts.split(",").map((a) => who(a.trim())) : [];
  const targets = [...new Set([...ROLES.filter((r) => r !== "contract").map((r) => m.accounts[r]), ...extra])];
  for (const account of targets) {
    const records = await view<CommitmentView[]>("get_commitments_of", { account_id: account });
    if (!records.some((record) => record.round_id === roundId)) continue;
    try {
      await call(who(opts.as ?? "dist"), "settle", { round_id: roundId, account_id: account });
    } catch (error) {
      if (!String(error).includes("ERR_NOTHING_TO_SETTLE")) throw error;
      console.log(`  skip ${account} (nothing to settle yet)`);
    }
  }
  reportAudit(await view<Audit>("audit"));
}

async function waitForPhase(roundId: number, phases: RoundPhase[]): Promise<void> {
  for (;;) {
    const round = await getRound(roundId);
    if (phases.includes(round.phase)) return;
    await sleep(3_000);
  }
}

/** A short labeled round that exercises commit -> select -> submit -> accept -> burn -> claim. */
async function cmdDemo(): Promise<void> {
  if (dryRun) throw new Error("The demo waits on real chain time, so it has no dry-run.");
  const before = await view<Audit>("audit");
  const terms = await view<NextRoundTerms>("get_next_round_terms");
  if (!terms.funded) throw new Error(`The Hearth holds ${showNear(before.hearth_pool)}, too little for a round. Run seed first.`);
  // Clears the contract's current threshold by half, so payout is below the full budget.
  const winning = (BigInt(terms.threshold) * 3n) / 2n;
  await fundBacker(m.accounts.backer1, winning);
  await fundBacker(m.accounts.backer2, ember("300"));
  const ids = await ensureNominations(missionSet("demo"));
  const roundId = await createRound({
    nominationIds: ids, openInMs: 45_000, backingMs: 150_000, candleMs: 60_000, checkpoints: 3,
    deliveryMs: 1_800_000, reviewMs: 1_800_000,
  });
  console.log(`Demo round ${roundId} created. Waiting for backing.`);
  await waitForPhase(roundId, ["Backing"]);
  await commitAs(m.accounts.backer1, roundId, 0, winning);
  await commitAs(m.accounts.backer2, roundId, 1, ember("200"));
  console.log("Waiting for the candle.");
  await waitForPhase(roundId, ["Candle"]);
  await commitAs(m.accounts.backer2, roundId, 1, ember("100"));
  console.log("Waiting for backing to close.");
  await waitForPhase(roundId, ["AwaitingSelection"]);
  await call(m.accounts.dist, "select", { round_id: roundId });
  await submitWork(roundId, join(ROOT, "docs/briefs/demo.md"), REPO_BLOB + "docs/briefs/demo.md");
  const round = await getRound(roundId);
  await call(round.round.reviewer, "accept", { round_id: roundId, hash: round.round.submission?.hash ?? "" }, REVIEW_DEPOSIT);
  await call(m.accounts.dist, "claim_payout", { round_id: roundId });
  await sleep(4_000);
  for (const account of [m.accounts.backer1, m.accounts.backer2]) {
    await call(m.accounts.dist, "settle", { round_id: roundId, account_id: account });
  }
  const final = await printRound(roundId);
  const audit = await view<Audit>("audit");
  const ok = reportAudit(audit);
  const burned = BigInt(audit.total_burned) - BigInt(before.total_burned);
  if (!ok || final.round.status !== "Accepted" || final.round.payout_state !== "Paid" || burned !== winning) {
    throw new Error(`Demo round did not finish as expected: ${final.round.status}, ${final.round.payout_state}, burned ${showEmber(burned)}.`);
  }
  console.log(`\nGate passed: commit -> select -> submit -> accept -> burn ${showEmber(burned)} -> claim ${showNear(final.round.payout)}.`);
}

/** Creates the parent of the guest accounts and writes its testnet key for the local web app. */
async function cmdGuests(): Promise<void> {
  const id = m.accounts.guests;
  if (dryRun || !(await accountInfo(id))) await createAccount("guests", id);
  if (dryRun) return;
  const key = JSON.parse(readFileSync(join(homedir(), ".near-credentials", "testnet", `${id}.json`), "utf8")) as { private_key: string };
  const path = join(ROOT, "apps", "web", ".env.local");
  writeFileSync(path, `GUEST_PARENT=${id}\nGUEST_SECRET_KEY=${key.private_key}\n`);
  saveManifest(m);
  console.log(`Guest parent is ${id}. Its testnet key is in apps/web/.env.local, which git ignores.`);
  console.log("For the hosted site, add the same two values as Vercel environment variables.");
}

/** Sends the guest parent's testnet key to Vercel over stdin, then redeploys so it takes effect. */
function cmdGuestsVercel(): Promise<void> {
  const env = readFileSync(join(ROOT, "apps", "web", ".env.local"), "utf8");
  const key = env.match(/^GUEST_SECRET_KEY=(.+)$/m)?.[1]?.trim();
  if (!key) throw new Error("No guest key found. Run: npm run testnet -- guests");
  const vercel = (args: string[], input?: string) => {
    const result = spawnSync("vercel", args, { cwd: ROOT, shell: true, encoding: "utf8", input, windowsHide: true });
    if (result.status !== 0) throw new Error(`vercel ${args[0]} failed. ${result.stderr || result.stdout}`);
    return result.stdout;
  };
  vercel(["env", "add", "GUEST_SECRET_KEY", "production", "--sensitive", "--force", "--yes"], key);
  console.log("Guest key stored in Vercel. Redeploying.");
  vercel(["deploy", "--prod", "--yes"]);
  console.log("Done. Guest accounts are on for the production site.");
  return Promise.resolve();
}

// ------------------------------------------------------------------ the keyless final deployment

const KEYLESS_NOTE =
  "Final deployment. The contract account was created, funded, deployed and initialized in one transaction with no AddKey action, so it has never had an access key. Every other account is a team-run, labeled demo actor.";
/** The operating reserve the contract keeps for nominations, faucet claims and Ash storage. */
const RESERVE = 5n * ONE_NEAR;
/** Room for the state `new` writes. Measured well below this in the sandbox. */
const INIT_STATE = ONE_NEAR / 2n;
const PLACEHOLDER_KEY = "ed25519:11111111111111111111111111111111";

const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

/** Code storage plus init state plus the reserve, rounded up to 0.1 NEAR. */
function keylessFunding(wasmBytes: number): bigint {
  const tenth = ONE_NEAR / 10n;
  const needed = BigInt(wasmBytes) * STORAGE_BYTE_COST + INIT_STATE + RESERVE;
  return ((needed + tenth - 1n) / tenth) * tenth;
}

/** Fails unless the unsigned transaction holds exactly these four actions, in order. */
function assertKeylessActions(display: string, contract: string, codeHash: string, fund: bigint): void {
  const text = stripAnsi(display);
  const actions = text.split("\n").filter((line) => /^\W*-- /.test(line)).map((line) => line.replace(/^\W*-- /, "").trim());
  const problems: string[] = [];
  if (actions.length !== 4) problems.push(`expected 4 actions, found ${actions.length}: ${actions.join(" | ")}`);
  if (!actions[0]?.startsWith(`create account:`) || !actions[0].includes(contract)) problems.push(`action 1 is not CreateAccount ${contract}`);
  if (!actions[1]?.startsWith("transfer deposit:")) problems.push("action 2 is not a Transfer");
  if (!actions[2]?.includes(`deploy code <${codeHash}>`)) problems.push(`action 3 does not deploy code ${codeHash}`);
  if (!actions[3]?.startsWith("function call:") || !/method name:\s+new\b/.test(text)) problems.push("action 4 is not the call to new");
  if (/add[- ]?(access )?key/i.test(text)) problems.push("the transaction adds a key");
  if (!text.includes(`receiver_id:  ${contract}`)) problems.push(`the receiver is not ${contract}`);
  if (problems.length > 0) throw new Error(`The prepared transaction is wrong, so nothing was sent:\n- ${problems.join("\n- ")}`);
  console.log(`Checked the unsigned transaction: CreateAccount, Transfer ${showNear(fund)}, DeployContract ${codeHash}, FunctionCall new. No AddKey.`);
}

/**
 * Prepares the final deployment: one transaction from a parent account that creates the
 * contract account, funds it, deploys res/bonfire.wasm and calls `new`, with no AddKey. It only
 * prepares and checks the transaction unless --send is passed. Sending is irreversible, and
 * the person who owns the parent account runs it.
 */
async function cmdKeyless(): Promise<void> {
  const contract = opts.contract;
  const dot = contract?.indexOf(".") ?? -1;
  if (!contract || dot <= 0) throw new Error("Pass --contract <name>.<parent>.testnet, a new sub-account of a parent account whose key you hold.");
  const parent = contract.slice(dot + 1);
  if (!parent.endsWith(".testnet")) throw new Error("The keyless deployment is for testnet; the parent must end in .testnet.");

  const check = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", join(ROOT, "scripts", "res.ts"), "check"], { cwd: ROOT, encoding: "utf8", windowsHide: true });
  if (check.status !== 0) throw new Error(`res/ is not the current reproducible build, so it can't be deployed.\n${check.stderr || check.stdout}`);
  const build = JSON.parse(readFileSync(join(ROOT, "res", "build.json"), "utf8")) as { source_commit: string; code_hash: string; sha256: string };
  const wasmPath = join(ROOT, "res", "bonfire.wasm");
  const bytes = readFileSync(wasmPath);
  const codeHash = base58(createHash("sha256").update(bytes).digest());
  if (codeHash !== build.code_hash) throw new Error(`res/bonfire.wasm hashes to ${codeHash}, but res/build.json says ${build.code_hash}.`);

  if (existsSync(MANIFEST_PATH)) {
    m = loadManifest();
    if (m.accounts.contract !== contract) throw new Error(`${MANIFEST_PATH} already describes ${m.accounts.contract}.`);
    if (m.code_hash) throw new Error(`${contract} was already deployed (code hash ${m.code_hash}). Check it with: npm run testnet -- status --deployment keyless`);
  } else {
    const dev = JSON.parse(readFileSync(DEV_MANIFEST_PATH, "utf8")) as Manifest;
    m = { network: "testnet", note: KEYLESS_NOTE, prefix: dev.prefix, accounts: { ...dev.accounts, contract }, wasm_sha256: null, code_hash: null, deployed_at: null, transactions: [] };
  }

  const fund = opts.fund ? near(opts.fund) : keylessFunding(bytes.length);
  const [target, parentInfo] = await Promise.all([accountInfo(contract), accountInfo(parent)]);
  if (target) throw new Error(`${contract} already exists. A keyless deployment needs an account that has never existed.`);
  if (!parentInfo) throw new Error(`The parent account ${parent} doesn't exist.`);
  const spare = BigInt(parentInfo.amount) - BigInt(parentInfo.storage_usage) * STORAGE_BYTE_COST;
  if (spare < fund + ONE_NEAR / 10n) throw new Error(`${parent} can spend about ${showNear(spare)}; the deployment needs ${showNear(fund)} plus gas.`);

  const base = [
    "transaction", "construct-transaction", parent, "receiver-id", contract,
    "add-action", "create-account",
    "add-action", "transfer", `${fund} yoctonear`,
    "add-action", "deploy-contract", "use-file", wasmPath,
    "with-init-call", "new", "json-args", JSON.stringify(genesisArgs()),
    "prepaid-gas", "100 Tgas", "attached-deposit", "0 NEAR",
    "skip", "network-config", "testnet",
  ];
  const unsigned = await exec(NEAR_BIN, [...base, "sign-later", "--signer-public-key", PLACEHOLDER_KEY, "--nonce", "1", "--block-hash", NO_CODE, "display"], { maxBuffer: 50 * 1024 * 1024, windowsHide: true });
  assertKeylessActions(unsigned.stdout + unsigned.stderr, contract, codeHash, fund);

  console.log(`\nContract: ${contract}  (parent ${parent})`);
  console.log(`Wasm:     res/bonfire.wasm, ${bytes.length} bytes, sha256 ${build.sha256}, built from ${build.source_commit}`);
  console.log(`Funding:  ${showNear(fund)} (code storage, init state, and a ${showNear(RESERVE)} reserve)`);
  console.log(`Genesis:  ${JSON.stringify(genesisArgs())}`);
  if (!opts.send) {
    console.log("\nNothing was sent. This is irreversible: the account can never be changed or upgraded after it.");
    console.log(`To send it, the owner of ${parent} runs:\n  npm run testnet -- keyless --contract ${contract} --send`);
    return;
  }

  await runNear("keyless deploy: create, fund, deploy, new", parent, [...base, "sign-with-legacy-keychain", "send"]);
  const info = await accountInfo(contract);
  if (info?.code_hash !== codeHash) throw new Error(`${contract} holds code ${info?.code_hash ?? "none"}, not ${codeHash}.`);
  const keys = await rpc<{ keys: unknown[] }>({ request_type: "view_access_key_list", finality: "final", account_id: contract });
  if (keys.keys.length !== 0) throw new Error(`${contract} has ${keys.keys.length} access key(s). It is not keyless.`);
  const audit = await view<Audit>("audit");
  m.wasm_sha256 = build.sha256;
  m.code_hash = codeHash;
  m.deployed_at = new Date().toISOString();
  saveManifest(m);
  console.log(`\nDeployed ${contract} with no access keys. Code hash ${codeHash}. Operating surplus ${showNear(audit.operating_surplus)}.`);
  console.log("Next: npm run testnet -- seed --deployment keyless");
}

/** The whole first deployment in one go. Every step skips work that is already done. */
async function cmdFirstRun(): Promise<void> {
  await cmdAccounts();
  console.log("Building the contract.");
  if (!dryRun) await exec("cargo", ["near", "build", "non-reproducible-wasm", "--no-abi"], { cwd: join(ROOT, "contracts", "bonfire"), maxBuffer: 50 * 1024 * 1024, windowsHide: true });
  await cmdDeploy();
  await cmdSeed();
  if (!dryRun) await cmdDemo();
}

const COMMANDS: Record<string, () => Promise<void>> = {
  accounts: cmdAccounts,
  deploy: cmdDeploy,
  seed: cmdSeed,
  round: cmdRound,
  status: cmdStatus,
  commit: cmdCommit,
  select: () => cmdPermissionless("select"),
  expire: () => cmdPermissionless("expire"),
  claim: () => cmdPermissionless("claim_payout"),
  submit: cmdSubmit,
  accept: cmdAccept,
  reject: cmdReject,
  settle: cmdSettle,
  "settle-all": cmdSettleAll,
  demo: cmdDemo,
  "first-run": cmdFirstRun,
  guests: cmdGuests,
  "guests-vercel": cmdGuestsVercel,
  keyless: cmdKeyless,
};

async function main(): Promise<void> {
  const name = positionals[0];
  if (name === "doctor") return cmdDoctor();
  const command = name ? COMMANDS[name] : undefined;
  if (!command) throw new Error(`Commands: doctor, ${Object.keys(COMMANDS).join(", ")}. See scripts/README.md.`);
  if (name !== "accounts" && name !== "first-run" && name !== "keyless") m = loadManifest();
  await command();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
