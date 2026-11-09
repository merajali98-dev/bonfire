/**
 * The committed contract build in res/.
 *
 *   node scripts/res.ts describe <wasm>   JSON for a wasm built from HEAD (CI writes res/build.json with it)
 *   node scripts/res.ts install <dir>     copy a CI artifact (bonfire.wasm + build.json) into res/
 *   node scripts/res.ts check             res/ is intact and the contract source has not changed since
 *   node scripts/res.ts compare <wasm>    a rebuilt wasm is byte-identical to res/bonfire.wasm
 *
 * res/bonfire.wasm comes only from `cargo near build reproducible-wasm` in Linux CI. The build
 * records its source commit inside the wasm, so it is rebuilt from that commit to compare.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RES = join(ROOT, "res");
const WASM = join(RES, "bonfire.wasm");
const BUILD = join(RES, "build.json");
/** What goes into the wasm. A change here makes res/ stale. */
const CONTRACT_SOURCE = ["contracts/bonfire/src", "contracts/bonfire/Cargo.toml", "contracts/bonfire/Cargo.lock"];

interface Build {
  source_commit: string;
  sha256: string;
  code_hash: string;
  bytes: number;
  image: string;
  image_digest: string;
  command: string;
}

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest();
const git = (...args: string[]) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();

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

function imageFromCargoToml(): { image: string; image_digest: string } {
  const toml = readFileSync(join(ROOT, "contracts", "bonfire", "Cargo.toml"), "utf8");
  const section = toml.split("[package.metadata.near.reproducible_build]")[1];
  const image = section?.match(/^image\s*=\s*"([^"]+)"/m)?.[1];
  const image_digest = section?.match(/^image_digest\s*=\s*"([^"]+)"/m)?.[1];
  if (!image || !image_digest) throw new Error("Cargo.toml has no [package.metadata.near.reproducible_build] image and image_digest");
  return { image, image_digest };
}

function describe(path: string): Build {
  const bytes = readFileSync(path);
  const hash = sha256(bytes);
  return {
    source_commit: git("rev-parse", "HEAD"),
    sha256: hash.toString("hex"),
    code_hash: base58(hash),
    bytes: bytes.length,
    ...imageFromCargoToml(),
    command: "cargo near build reproducible-wasm",
  };
}

function readBuild(): Build {
  if (!existsSync(BUILD) || !existsSync(WASM)) throw new Error("res/ has no build yet. CI uploads one as the bonfire-wasm artifact.");
  return JSON.parse(readFileSync(BUILD, "utf8")) as Build;
}

function check(): void {
  const build = readBuild();
  const hash = sha256(readFileSync(WASM));
  const problems: string[] = [];
  if (hash.toString("hex") !== build.sha256) problems.push(`res/bonfire.wasm sha256 ${hash.toString("hex")} is not the recorded ${build.sha256}`);
  if (base58(hash) !== build.code_hash) problems.push(`code hash ${base58(hash)} is not the recorded ${build.code_hash}`);
  const listed = readFileSync(join(RES, "bonfire.wasm.sha256"), "utf8").split(/\s+/)[0];
  if (listed !== build.sha256) problems.push(`res/bonfire.wasm.sha256 says ${listed}`);
  const image = imageFromCargoToml();
  if (image.image !== build.image || image.image_digest !== build.image_digest) problems.push("Cargo.toml names a different build image");
  const changed = git("diff", "--name-only", build.source_commit, "HEAD", "--", ...CONTRACT_SOURCE);
  if (changed) problems.push(`the contract changed since ${build.source_commit}:\n  ${changed.split("\n").join("\n  ")}`);
  if (problems.length > 0) {
    console.error(`res/ is stale or damaged:\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
  console.log(`res/bonfire.wasm ${build.sha256} (code hash ${build.code_hash}) is the build of ${build.source_commit}, and the contract has not changed since.`);
}

function compare(path: string): void {
  const build = readBuild();
  const rebuilt = sha256(readFileSync(path)).toString("hex");
  if (rebuilt !== build.sha256) {
    console.error(`Not reproduced: rebuilding ${build.source_commit} gave ${rebuilt}, res/ has ${build.sha256}.`);
    process.exit(1);
  }
  console.log(`Reproduced: rebuilding ${build.source_commit} gave the same ${rebuilt}.`);
}

function install(dir: string): void {
  const build = JSON.parse(readFileSync(join(dir, "build.json"), "utf8")) as Build;
  const bytes = readFileSync(join(dir, "bonfire.wasm"));
  if (sha256(bytes).toString("hex") !== build.sha256) throw new Error("the artifact's wasm does not match its build.json");
  mkdirSync(RES, { recursive: true });
  copyFileSync(join(dir, "bonfire.wasm"), WASM);
  writeFileSync(BUILD, JSON.stringify(build, null, 2) + "\n");
  writeFileSync(join(RES, "bonfire.wasm.sha256"), `${build.sha256}  bonfire.wasm\n`);
  console.log(`Installed ${build.sha256} from ${build.source_commit}.`);
}

const [command, arg] = process.argv.slice(2);
if (command === "describe" && arg) console.log(JSON.stringify(describe(arg), null, 2));
else if (command === "install" && arg) install(arg);
else if (command === "check") check();
else if (command === "compare" && arg) compare(arg);
else {
  console.error("usage: node scripts/res.ts describe <wasm> | install <dir> | check | compare <wasm>");
  process.exit(2);
}
