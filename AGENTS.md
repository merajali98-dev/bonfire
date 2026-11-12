# For automated reviewers

BONFIRE is a NEAR memecoin whose holders commission work by burning EMBER, only once the work is accepted. This file says how to check its claims. [CLAIMS.md](CLAIMS.md) lists every claim with the test, command or view that proves it.

## One command (Linux or macOS, Rust, Node 24)

```sh
npm ci && npm run verify
```

It checks that `res/` is the current reproducible build, runs the Node checks, the contract's unit tests and attack battery, and the sandbox suite on `res/bonfire.wasm`. Each claim prints `HELD <n> <claim>` with an `observed:` line only after its step passed, and the run exits non-zero otherwise. The sandbox suite takes about 15 minutes. CI runs it on every push.

## Fast checks (Node 24 only, about a minute)

```sh
npm ci
npm run typecheck
npm test                  # simulator rules vs shared fixtures, deploy rules vs simulator, web logic
npm run simulate && git diff --exit-code docs/simulation.md packages/simulator/reports
node scripts/res.ts check # res/bonfire.wasm is the recorded build and the contract hasn't changed since
npm run observe           # read-only checks of the deployed contract over public RPC, no key
npm run rules             # every rule the final contract was initialized with, read live, no key
```

`npm run observe` prints `HELD`, `FAILED` or `UNAVAILABLE` per claim with the observed value, and exits non-zero unless every claim holds. On the keyless final deployment `fire.bonfire-hearth.testnet` all 5 claims hold. `npm run observe -- --deployment dev` checks the development deployment, which has an access key and older code, so 2 of 5 claims hold there by design.

## Contract checks (Rust; sandbox tests need Linux or macOS)

```sh
cd contracts/bonfire
cargo test --lib                                             # unit tests and the attack battery
cargo near build non-reproducible-wasm --no-abi              # or use res/bonfire.wasm via BONFIRE_WASM
cargo test --test sandbox -- --nocapture --test-threads=1    # wasm on a local node; needs Node 24 too
```

`simulator_replay_matches_wasm` replays a seeded simulator run on the wasm and fails on any difference. `keyless_deploy_in_one_transaction` sends the final deployment's exact four-action transaction.

## Reproducible build (Linux with Docker)

```sh
git checkout $(node -p "require('./res/build.json').source_commit")
cd contracts/bonfire && cargo near build reproducible-wasm
sha256sum target/near/bonfire.wasm   # must equal res/bonfire.wasm.sha256
```

The wasm records its source commit in its NEP-330 metadata, so the rebuild must use that commit. CI does this on every push (job `reproducible`).

## What not to infer

- The development deployment `bonfire-meraj-contract.testnet` has an access key. Don't treat it as immutable. The final deployment is `fire.bonfire-hearth.testnet`.
- Every account under `bonfire-meraj-` and every `*.bonfire-meraj-guests.testnet` account is team-run or a guest. None of them is an independent user.
- Test NEAR has no value. Nothing here shows real-money demand.
- The curator chooses missions, time windows and the reviewer, and the reviewer judges the work. These are trusted roles; see the README's Limits.
