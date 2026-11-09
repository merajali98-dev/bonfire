/**
 * Read-only checks of a BONFIRE deployment. Needs only Node 24 and public RPC; no key, no CLI.
 *
 *   npm run observe                        the keyless final deployment (deployments/testnet.json)
 *   npm run observe -- --deployment dev    the development deployment, which is expected to fail
 *
 * Each claim prints HELD only after it is checked against chain data, FAILED when the data
 * contradicts it, and UNAVAILABLE when the data can't be read. Anything but all HELD exits 1.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { CANDIDATE_RULES } from "../packages/simulator/src/scenarios.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values: opts } = parseArgs({ options: { deployment: { type: "string", default: "keyless" } } });
const MANIFEST = join(ROOT, "deployments", opts.deployment === "dev" ? "testnet-dev.json" : "testnet.json");
const RPCS = [process.env.BONFIRE_RPC ?? "https://rpc.testnet.fastnear.com", "https://archival-rpc.testnet.fastnear.com"];

type Verdict = "HELD" | "FAILED" | "UNAVAILABLE";
const results: Verdict[] = [];

function report(verdict: Verdict, claim: string, observed: string): void {
  results.push(verdict);
  console.log(`${verdict.padEnd(11)} ${claim}`);
  console.log(`            observed: ${observed}`);
}

async function rpc<T>(method: string, params: unknown): Promise<T> {
  let last: unknown;
  for (const url of RPCS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: "observe", method, params }),
          signal: AbortSignal.timeout(20_000),
        });
        const body = (await response.json()) as { result?: T; error?: unknown };
        if (body.error) throw new Error(JSON.stringify(body.error));
        return body.result as T;
      } catch (error) {
        last = error;
        await new Promise((done) => setTimeout(done, 1_000 * (attempt + 1)));
      }
    }
  }
  throw new Error(`RPC failed: ${String(last)}`);
}

const query = <T>(params: Record<string, unknown>) => rpc<T>("query", { finality: "final", ...params });

async function viewJson<T>(contract: string, method: string): Promise<T> {
  const result = await query<{ result: number[] }>({ request_type: "call_function", account_id: contract, method_name: method, args_base64: "e30=" });
  return JSON.parse(Buffer.from(result.result).toString("utf8")) as T;
}

async function check(claim: string, run: () => Promise<{ ok: boolean; observed: string }>): Promise<void> {
  try {
    const { ok, observed } = await run();
    report(ok ? "HELD" : "FAILED", claim, observed);
  } catch (error) {
    report("UNAVAILABLE", claim, error instanceof Error ? error.message : String(error));
  }
}

interface Manifest {
  accounts: { contract: string };
  code_hash: string | null;
  transactions: { action: string; signer: string; tx_hash: string | null }[];
}

interface TxAction {
  [kind: string]: unknown;
}

async function main(): Promise<void> {
  if (!existsSync(MANIFEST)) {
    report("UNAVAILABLE", "a deployment to observe", `${MANIFEST} does not exist yet`);
    process.exit(1);
  }
  const m = JSON.parse(readFileSync(MANIFEST, "utf8")) as Manifest;
  const contract = m.accounts.contract;
  const build = JSON.parse(readFileSync(join(ROOT, "res", "build.json"), "utf8")) as { code_hash: string; source_commit: string };
  console.log(`Observing ${contract} (${opts.deployment}) against res/build.json from ${build.source_commit}\n`);

  await check("The deployed code is res/bonfire.wasm, the reproducible build", async () => {
    const account = await query<{ code_hash: string }>({ request_type: "view_account", account_id: contract });
    return { ok: account.code_hash === build.code_hash, observed: `on-chain ${account.code_hash}, res/ ${build.code_hash}` };
  });

  await check("The contract account has no access keys", async () => {
    const list = await query<{ keys: unknown[] }>({ request_type: "view_access_key_list", account_id: contract });
    return { ok: list.keys.length === 0, observed: `${list.keys.length} access key(s)` };
  });

  await check("One transaction created, funded, deployed and initialized it, with no AddKey", async () => {
    const record = m.transactions.find((t) => t.action.startsWith("keyless deploy"));
    if (!record?.tx_hash) throw new Error("the manifest records no keyless deploy transaction");
    const tx = await rpc<{ transaction: { receiver_id: string; actions: (string | TxAction)[] } }>("tx", { tx_hash: record.tx_hash, sender_account_id: record.signer, wait_until: "FINAL" });
    const kinds = tx.transaction.actions.map((a) => (typeof a === "string" ? a : Object.keys(a)[0]!));
    const call = tx.transaction.actions.find((a): a is TxAction => typeof a !== "string" && "FunctionCall" in a);
    const method = (call?.FunctionCall as { method_name?: string } | undefined)?.method_name;
    const ok =
      tx.transaction.receiver_id === contract &&
      kinds.join(",") === "CreateAccount,Transfer,DeployContract,FunctionCall" &&
      method === "new";
    return { ok, observed: `${record.tx_hash}: ${kinds.join(", ")}${method ? ` (${method})` : ""} to ${tx.transaction.receiver_id}` };
  });

  await check("The rules are the ones the simulation chose", async () => {
    const config = await viewJson<{ rules: Record<string, string | number> }>(contract, "get_config");
    const r = config.rules;
    const want: Record<string, bigint> = {
      budget_bps: CANDIDATE_RULES.budgetBps, min_budget: CANDIDATE_RULES.minBudget,
      initial_threshold: CANDIDATE_RULES.initialThreshold, min_threshold: CANDIDATE_RULES.minThreshold,
      up_bps: CANDIDATE_RULES.upBps, down_bps: CANDIDATE_RULES.downBps, target_multiple: CANDIDATE_RULES.targetMultiple,
    };
    const wrong = Object.entries(want).filter(([key, value]) => BigInt(r[key] ?? -1) !== value).map(([key]) => key);
    return { ok: wrong.length === 0, observed: wrong.length === 0 ? `up ${r.up_bps}, down ${r.down_bps}, budget ${r.budget_bps}, target ×${r.target_multiple}` : `differs: ${wrong.join(", ")}` };
  });

  await check("audit() reconciles supply, escrow and NEAR", async () => {
    const a = await viewJson<Record<string, unknown>>(contract, "audit");
    const ok = a.supply_ok === true && a.escrow_ok === true && a.near_ok === true;
    return { ok, observed: `supply_ok ${a.supply_ok}, escrow_ok ${a.escrow_ok}, near_ok ${a.near_ok}, burned ${a.total_burned}, hearth ${a.hearth_pool}` };
  });

  const held = results.filter((r) => r === "HELD").length;
  console.log(`\n${held} of ${results.length} held.`);
  if (held !== results.length) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
