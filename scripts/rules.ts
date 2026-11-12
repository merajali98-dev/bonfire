/**
 * Print every rule a BONFIRE deployment was initialized with, read live from the contract over
 * public RPC. Needs only Node 24; no key, no CLI, no install.
 *
 *   npm run rules                        the keyless final deployment (deployments/testnet.json)
 *   npm run rules -- --deployment dev    the development deployment
 *
 * The values come from the contract's own views (get_config, get_next_round_terms, audit), not
 * from this repository. On the keyless deployment nothing can change them: it has no access key
 * and no method that writes its config.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values: opts } = parseArgs({ options: { deployment: { type: "string", default: "keyless" } } });
const MANIFEST = join(ROOT, "deployments", opts.deployment === "dev" ? "testnet-dev.json" : "testnet.json");
const RPCS = [process.env.BONFIRE_RPC ?? "https://rpc.testnet.fastnear.com", "https://rpc.testnet.near.org"];

interface Config {
  curator: string;
  distribution_account: string;
  faucet_amount: string;
  faucet_interval_ms: number;
  nominate_min_ash: string;
  initial_supply: string;
  rules: { budget_bps: number; min_budget: string; initial_threshold: string; min_threshold: string; up_bps: number; down_bps: number; target_multiple: number };
  /** Absent on the development deployment, which runs an older build without window limits. */
  limits?: Record<string, number>;
}
interface Terms { budget: string; threshold: string; target: string; funded: boolean }
interface Audit { total_supply: string; total_burned: string; faucet_remaining: string; hearth_pool: string; next_threshold: string }

async function view<T>(contract: string, method: string): Promise<T> {
  let last: unknown;
  for (const url of RPCS) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "rules",
          method: "query",
          params: { request_type: "call_function", finality: "final", account_id: contract, method_name: method, args_base64: "e30=" },
        }),
        signal: AbortSignal.timeout(20_000),
      });
      const body = (await response.json()) as { result?: { result?: number[]; error?: string }; error?: unknown };
      if (body.error || body.result?.error || !body.result?.result) throw new Error(JSON.stringify(body.error ?? body.result?.error));
      return JSON.parse(Buffer.from(body.result.result).toString("utf8")) as T;
    } catch (error) {
      last = error;
    }
  }
  throw new Error(`${method}: RPC failed: ${String(last)}`);
}

/** An on-chain amount in whole units, keeping up to four decimals. EMBER has 18 decimals, NEAR 24. */
function units(raw: string, decimals: bigint): string {
  const value = BigInt(raw);
  const one = 10n ** decimals;
  const whole = value / one;
  const fraction = ((value % one) / 10n ** (decimals - 4n)).toString().padStart(4, "0").replace(/0+$/, "");
  return `${whole.toLocaleString("en-US")}${fraction ? `.${fraction}` : ""}`;
}

const ember = (raw: string) => units(raw, 18n);
const near = (raw: string) => units(raw, 24n);

function duration(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000} day${ms === 86_400_000 ? "" : "s"}`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} hour${ms === 3_600_000 ? "" : "s"}`;
  return `${ms / 60_000} minutes`;
}

const contract = (JSON.parse(readFileSync(MANIFEST, "utf8")) as { accounts: { contract: string } }).accounts.contract;
const [config, terms, audit] = await Promise.all([
  view<Config>(contract, "get_config"),
  view<Terms>(contract, "get_next_round_terms"),
  view<Audit>(contract, "audit"),
]);
const r = config.rules;
const l = config.limits;
const span = (min: string, max: string) => `${duration(l?.[min] ?? 0)} to ${duration(l?.[max] ?? 0)}`;

const rows: [string, string, string][] = [
  ["Supply", "initial_supply", `${ember(config.initial_supply)} EMBER, all minted at initialization; nothing can mint afterwards`],
  ["Faucet", "faucet_amount", `${ember(config.faucet_amount)} EMBER per claim`],
  ["", "faucet_interval_ms", `one claim per account every ${duration(config.faucet_interval_ms)}`],
  ["Nominating", "nominate_min_ash", `${ember(config.nominate_min_ash)} Ash to propose a mission (the curator is exempt)`],
  ["Budget", "rules.budget_bps", `${r.budget_bps} (${r.budget_bps / 100}% of the Hearth per round)`],
  ["", "rules.min_budget", `${near(r.min_budget)} NEAR; no round opens below it`],
  ["Threshold", "rules.initial_threshold", `${ember(r.initial_threshold)} EMBER to start`],
  ["", "rules.min_threshold", `${ember(r.min_threshold)} EMBER floor`],
  ["", "rules.up_bps", `${r.up_bps} (×${r.up_bps / 10_000} after a round finds a winner)`],
  ["", "rules.down_bps", `${r.down_bps} (×${r.down_bps / 10_000} after nothing reaches it)`],
  ["Target", "rules.target_multiple", `${r.target_multiple} × the threshold (full payout)`],
  ...(l
    ? ([
        ["Windows", "limits.max_lead_ms", `a round opens within ${duration(l.max_lead_ms ?? 0)} of creation`],
        ["", "limits.*_backing_ms", `backing lasts ${span("min_backing_ms", "max_backing_ms")}`],
        ["", "limits.*_candle_ms", `the candle lasts ${span("min_candle_ms", "max_candle_ms")}`],
        ["", "limits.*_delivery_ms", `delivery lasts ${span("min_delivery_ms", "max_delivery_ms")}`],
        ["", "limits.*_review_ms", `review lasts ${span("min_review_ms", "max_review_ms")}`],
      ] as [string, string, string][])
    : [["Windows", "limits", "not in this build: it predates the window limits"] as [string, string, string]]),
  ["Roles", "curator", config.curator],
  ["", "distribution_account", config.distribution_account],
];

console.log(`Rules of ${contract} (${opts.deployment}), read live from get_config`);
console.log(
  opts.deployment === "dev"
    ? "This deployment has an access key, so its code and rules can still change.\n"
    : "This contract has no access key and no method that writes its config, so these values are final.\n",
);
const width = Math.max(...rows.map(([, field]) => field.length));
for (const [group, field, meaning] of rows) console.log(`${group.padEnd(11)} ${field.padEnd(width)}  ${meaning}`);
console.log(`\nNext round, from get_next_round_terms: budget ${near(terms.budget)} NEAR, threshold ${ember(terms.threshold)} EMBER, target ${ember(terms.target)} EMBER${terms.funded ? " (a round is funded now)" : ""}`);
console.log(`Now, from audit: supply ${ember(audit.total_supply)} EMBER, burned ${ember(audit.total_burned)}, faucet left ${ember(audit.faucet_remaining)}, Hearth ${near(audit.hearth_pool)} NEAR`);
console.log(`\nRaw config:\n${JSON.stringify(config, null, 2)}`);
