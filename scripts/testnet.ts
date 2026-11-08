/**
 * BONFIRE testnet operator tool. Wraps near-cli-rs for signing and reads over public RPC.
 * Usage and the full run order are in scripts/README.md.
 *
 * Keys stay in the near CLI's legacy keychain (~/.near-credentials) and never enter the repo.
 * The manifest in deployments/ records only account IDs, the code hash and transaction hashes.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { COMMIT_DEPOSIT } from "../packages/protocol/src/constants.ts";
import { ERROR_MESSAGES, parseErrorCode } from "../packages/protocol/src/errors.ts";
import type { Audit, CommitmentView, CreateRoundArgs, Nomination, RoundPhase, RoundView } from "../packages/protocol/src/types.ts";

const exec = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = join(ROOT, "deployments", "testnet-dev.json");
const DEFAULT_WASM = join(ROOT, "contracts", "bonfire", "target", "near", "bonfire.wasm");
const RPC_URL = process.env.BONFIRE_RPC ?? "https://rpc.testnet.fastnear.com";
const NEAR_BIN = process.env.NEAR_BIN ?? "near";
const REPO_BLOB = "https://github.com/merajali98-dev/bonfire/blob/main/";
const STORAGE_BYTE_COST = 10n ** 19n;
const ONE_NEAR = 10n ** 24n;
const ONE_EMBER = 10n ** 18n;

const ROLES = ["contract", "curator", "dist", "stoker", "maker1", "maker2", "maker3", "backer1", "backer2"] as const;
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
    { title: "EMBER sticker and mascot pack", brief: "docs/briefs/round-1/mascot-pack.md", maker: "maker1" },
    { title: "Fire Keepers leaderboard", brief: "docs/briefs/round-1/fire-keepers.md", maker: "maker2" },
    { title: "Social share card", brief: "docs/briefs/round-1/share-card.md", maker: "maker3" },
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
    budget: { type: "string", default: "2" },
    threshold: { type: "string", default: "10000" },
    target: { type: "string", default: "40000" },
    as: { type: "string" },
    file: { type: "string" },
    uri: { type: "string" },
    accounts: { type: "string" },
  },
});
const dryRun = opts["dry-run"];

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
  if (existsSync(MANIFEST_PATH)) return JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest;
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
  let output: string;
  try {
    const result = await exec(NEAR_BIN, args, { maxBuffer: 20 * 1024 * 1024, timeout: 240_000, windowsHide: true });
    output = result.stdout + result.stderr;
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; message: string };
    throw new Error(`${action} failed. ${explainFailure(`${failed.stdout ?? ""}${failed.stderr ?? ""}` || failed.message)}`);
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
  };
}

interface RoundPlan {
  nominationIds: number[];
  openInMs: number;
  backingMs: number;
  candleMs: number;
  checkpoints: number;
  deliveryMs: number;
  reviewMs: number;
  budget: bigint;
  threshold: bigint;
  target: bigint;
}

function createRoundArgs(plan: RoundPlan): CreateRoundArgs {
  if (plan.candleMs >= plan.backingMs) throw new Error("The candle is the final part of backing, so it must be shorter than --backing.");
  const open = Date.now() + plan.openInMs;
  const close = open + plan.backingMs;
  const delivery = close + plan.deliveryMs;
  return {
    nomination_ids: plan.nominationIds,
    reviewer: m.accounts.curator,
    budget: plan.budget.toString(),
    threshold: plan.threshold.toString(),
    target: plan.target.toString(),
    open_at_ms: open,
    candle_start_ms: close - plan.candleMs,
    backing_close_ms: close,
    delivery_deadline_ms: delivery,
    review_deadline_ms: delivery + plan.reviewMs,
    checkpoints: plan.checkpoints,
  };
}

async function createRound(plan: RoundPlan): Promise<number> {
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
    await runNear(`create account ${role}`, id, [
      "account", "create-account", "sponsor-by-faucet-service", id,
      "autogenerate-new-keypair", "save-to-legacy-keychain",
      "network-config", "testnet", "create",
    ]);
    if (!dryRun) await sleep(3_000);
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
    budget: near(opts.budget),
    threshold: ember(opts.threshold),
    target: ember(opts.target),
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
  await call(opts.as ? who(opts.as) : round.round.reviewer, "accept", { round_id: roundId, hash });
}

async function cmdReject(): Promise<void> {
  const roundId = roundArg(1);
  const round = await getRound(roundId);
  await call(opts.as ? who(opts.as) : round.round.reviewer, "reject", { round_id: roundId });
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
  const budget = near("1");
  const before = await view<Audit>("audit");
  if (BigInt(before.hearth_pool) < budget) throw new Error(`The Hearth holds ${showNear(before.hearth_pool)}; the demo needs 1 NEAR. Run seed first.`);
  const ids = await ensureNominations(missionSet("demo"));
  const roundId = await createRound({
    nominationIds: ids, openInMs: 45_000, backingMs: 150_000, candleMs: 60_000, checkpoints: 3,
    deliveryMs: 1_800_000, reviewMs: 1_800_000, budget, threshold: ember("1000"), target: ember("4000"),
  });
  console.log(`Demo round ${roundId} created. Waiting for backing.`);
  await waitForPhase(roundId, ["Backing"]);
  await commitAs(m.accounts.backer1, roundId, 0, ember("1500"));
  await commitAs(m.accounts.backer2, roundId, 1, ember("200"));
  console.log("Waiting for the candle.");
  await waitForPhase(roundId, ["Candle"]);
  await commitAs(m.accounts.backer2, roundId, 1, ember("100"));
  console.log("Waiting for backing to close.");
  await waitForPhase(roundId, ["AwaitingSelection"]);
  await call(m.accounts.dist, "select", { round_id: roundId });
  await submitWork(roundId, join(ROOT, "docs/briefs/demo.md"), REPO_BLOB + "docs/briefs/demo.md");
  const round = await getRound(roundId);
  await call(round.round.reviewer, "accept", { round_id: roundId, hash: round.round.submission?.hash ?? "" });
  await call(m.accounts.dist, "claim_payout", { round_id: roundId });
  await sleep(4_000);
  for (const account of [m.accounts.backer1, m.accounts.backer2]) {
    await call(m.accounts.dist, "settle", { round_id: roundId, account_id: account });
  }
  const final = await printRound(roundId);
  const audit = await view<Audit>("audit");
  const ok = reportAudit(audit);
  const burned = BigInt(audit.total_burned) - BigInt(before.total_burned);
  if (!ok || final.round.status !== "Accepted" || final.round.payout_state !== "Paid" || burned !== ember("1500")) {
    throw new Error(`Demo round did not finish as expected: ${final.round.status}, ${final.round.payout_state}, burned ${showEmber(burned)}.`);
  }
  console.log(`\nGate passed: commit -> select -> submit -> accept -> burn ${showEmber(burned)} -> claim ${showNear(final.round.payout)}.`);
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
};

async function main(): Promise<void> {
  const name = positionals[0];
  if (name === "doctor") return cmdDoctor();
  const command = name ? COMMANDS[name] : undefined;
  if (!command) throw new Error(`Commands: doctor, ${Object.keys(COMMANDS).join(", ")}. See scripts/README.md.`);
  if (name !== "accounts") m = loadManifest();
  await command();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
