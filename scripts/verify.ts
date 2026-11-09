/**
 * One command that checks the repository's claims from a checkout:
 *
 *   npm run verify
 *
 * It checks that res/ is the current reproducible build, runs the Node checks, the contract's
 * unit tests and attack battery, then the sandbox suite on res/bonfire.wasm (the bytes that get
 * deployed). Each claim prints HELD only after its step passed, with an observed line. The
 * sandbox needs Linux or macOS; elsewhere those claims print UNAVAILABLE and the run fails.
 */
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACT = join(ROOT, "contracts", "bonfire");
let failed = 0;
let n = 0;

function run(command: string, args: string[], cwd: string, env: Record<string, string> = {}): { ok: boolean; out: string } {
  console.log(`\n$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 200 * 1024 * 1024,
    shell: process.platform === "win32",
  });
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return { ok: result.status === 0, out };
}

function claim(held: boolean | null, text: string, observed: string): void {
  n++;
  const verdict = held === null ? "UNAVAILABLE" : held ? "HELD" : "FAILED";
  if (!held) failed++;
  console.log(`${verdict} ${n} ${text}`);
  console.log(`  observed: ${observed}`);
}

const passed = (out: string) => [...out.matchAll(/test result: ok\. (\d+) passed/g)].reduce((sum, m) => sum + Number(m[1]), 0);
const lastLines = (out: string, count = 15) => out.trim().split("\n").slice(-count).join("\n");

// 1. The deployable wasm
const res = run(process.execPath, ["--disable-warning=ExperimentalWarning", "scripts/res.ts", "check"], ROOT);
claim(res.ok, "res/bonfire.wasm is the recorded reproducible build, and the contract has not changed since", res.out.trim().split("\n").pop() ?? "");

// 2. Node checks: simulator rules vs shared fixtures, deploy rules vs simulator, web logic
const node = run("npm", ["test"], ROOT);
const nodePass = [...node.out.matchAll(/ℹ pass (\d+)/g)].reduce((sum, m) => sum + Number(m[1]), 0);
const nodeFail = [...node.out.matchAll(/ℹ fail (\d+)/g)].reduce((sum, m) => sum + Number(m[1]), 0);
claim(node.ok && nodeFail === 0, "The simulator's rules match the shared fixtures and the deploy script, and the site's logic tests pass", `${nodePass} passed, ${nodeFail} failed`);
if (!node.ok) console.log(lastLines(node.out));

// 3. Contract unit tests, including the attack battery and randomized invariants
const unit = run("cargo", ["test", "--lib"], CONTRACT, process.platform === "win32" ? { AWS_LC_SYS_PREBUILT_NASM: "1" } : {});
const battery = (unit.out.match(/^test tests::[a-z0-9_]+ \.\.\. ok$/gm) ?? []).length;
claim(unit.ok, "Contract unit tests pass: lifecycle, candle, matching, failure paths, attack battery, randomized conservation", `${passed(unit.out)} passed (${battery} listed ok)`);
if (!unit.ok) console.log(lastLines(unit.out));

// 4. The sandbox suite on the deployable bytes
if (process.platform === "win32") {
  claim(null, "The sandbox suite passes on res/bonfire.wasm", "the sandbox node has no Windows build; run this on Linux or macOS, or see CI");
} else {
  const sandbox = run("cargo", ["test", "--test", "sandbox", "--", "--nocapture", "--test-threads=1"], CONTRACT, { BONFIRE_WASM: join(ROOT, "res", "bonfire.wasm") });
  const ok = (name: string) => new RegExp(`test ${name} \\.\\.\\. ok`).test(sandbox.out);
  const rows: [string, string][] = [
    ["private_callbacks_reject_outside_callers", "Private callbacks refuse outside callers on wasm"],
    ["payout_transfer_pays_creator_exactly_once", "An accepted payout reaches the creator exactly once"],
    ["payout_to_deleted_account_restores_available_and_can_retry", "A failed payout comes back and can be retried"],
    ["curator_cannot_set_a_rounds_money_terms", "No call can set a round's budget, threshold or target"],
    ["storage_deposit_and_faucet_flow", "Storage registration and the faucet work and respect the cooldown"],
    ["worst_case_round_gas_and_storage", "The worst-case round fits gas and storage limits"],
    ["simulator_replay_matches_wasm", "A seeded simulator run matches the wasm round by round"],
    ["keyless_deploy_in_one_transaction", "The keyless deploy is one transaction and leaves no access key"],
  ];
  for (const [name, text] of rows) {
    const metric = name === "simulator_replay_matches_wasm" ? sandbox.out.match(/METRIC replay: outcomes: (.*)/)?.[1] : undefined;
    claim(ok(name), text, ok(name) ? `test ${name} ... ok${metric ? `; outcomes ${metric}` : ""}` : "not ok or not run");
  }
  if (!sandbox.ok) console.log(lastLines(sandbox.out, 30));
}

console.log(`\n${n - failed} of ${n} held.`);
process.exit(failed === 0 ? 0 : 1);
