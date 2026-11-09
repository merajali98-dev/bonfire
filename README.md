# BONFIRE

**Back the mission. See it built. Then burn together.**

Put your EMBER behind the mission you want made. If it wins and the work is accepted, your EMBER burns and the creator gets paid. Otherwise you get it back.

Built at NEAR HACKATHON (Memecoins With Mechanics; Social Money). Work in progress, testnet only.

## Status

| Part | State |
| --- | --- |
| `contracts/bonfire` — EMBER token, Hearth, nominations, rounds, candle close, matching payout, Ash, settlement | Implemented; unit and sandbox tests passing in CI; running as the development deployment below |
| `packages/protocol` — TypeScript types for the contract views and error codes | Implemented |
| `scripts/testnet.ts` — deploy, seed, run and settle rounds from the CLI ([runbook](scripts/README.md)) | Used for the development deployment on testnet |
| `packages/simulator` — seeded 60-day scenarios, backer strategies and rule sweeps ([report](docs/simulation.md)) | Implemented; rule math shared with the contract through fixtures, and one seeded run replayed against the wasm in CI |
| Development deployment — `bonfire-meraj-contract.testnet` (has an access key; every account is a team-run demo actor) | One labeled demo round accepted on testnet: 15,000 EMBER burned, 0.75 test NEAR paid |
| `apps/web` — live round, guest account or wallet sign-in, faucet, commit, My embers with settle, share cards rendered from chain data, and a local Practice floor ([site](https://bonfire-opal.vercel.app), [setup](apps/web/README.md)) | In progress; signed commits confirmed on testnet from a guest on a phone and from a wallet |
| `res/bonfire.wasm` — the deployable build, made reproducibly in CI | Committed with its SHA-256 and source commit; provisional until the contract freezes |
| Final keyless deployment | Not started |

Claims in this README are limited to what the repository currently contains.

## Build and test the contract

Requires Rust (with the `wasm32-unknown-unknown` target) and `cargo-near`.

```sh
cd contracts/bonfire
cargo test                                      # unit tests
cargo near build non-reproducible-wasm --no-abi # wasm -> target/near/bonfire.wasm
```

On Windows, set `AWS_LC_SYS_PREBUILT_NASM=1` before `cargo test` if NASM is not installed.

### Reproducible build

The deployable wasm is [`res/bonfire.wasm`](res). CI builds it with `cargo near build reproducible-wasm` inside `sourcescan/cargo-near:0.22.0-rust-1.99.1`, pinned by digest in `contracts/bonfire/Cargo.toml`. [`res/build.json`](res/build.json) records its source commit, SHA-256 and NEAR code hash, and the wasm names the same commit in its NEP-330 build metadata. On every push, CI checks that the contract hasn't changed since that commit, rebuilds the commit and compares the bytes (`scripts/res.ts`). Sandbox tests run on `res/bonfire.wasm` while it is current.

To reproduce it on Linux with Docker:

```sh
git checkout $(node -p "require('./res/build.json').source_commit")
cd contracts/bonfire && cargo near build reproducible-wasm
sha256sum target/near/bonfire.wasm   # compare with res/bonfire.wasm.sha256
```

The development deployment was built before this and runs different bytes. The final deployment is planned to use `res/bonfire.wasm`, rebuilt from the frozen contract if anything changes before then.

### Sandbox tests

Sandbox integration tests run the built wasm on a local NEAR node. The node binary is only published for Linux and macOS, so on Windows they are skipped and [CI](.github/workflows/contract.yml) runs them:

```sh
cargo test --test sandbox -- --nocapture --test-threads=1
```

`simulator_replay_matches_wasm` replays a seeded run of `packages/simulator` on the wasm: 8 rounds, 11 backers, 3 missions, 3 candle checkpoints. The contract makes each candle draw itself. The simulator is then told that draw and must predict the winner, counted escrow, payout, burn, every backer's refunds and Ash, the Hearth and the next threshold exactly, or the test fails. It needs Node 24 as well as the sandbox.

Measured at the worst case (5 missions, 12 checkpoints, 64-character account IDs): `settle` burns 7.1 TGas, `commit` 4.0 TGas, `select` 2.6 TGas, and the payout callback 2.2 TGas of its 10 TGas allowance. The largest commitment record uses 540 bytes; its 0.01 NEAR deposit covers 1,000.

## How a round's terms are set

The contract computes every round's money terms from rules fixed at initialization. The `create_round` call refuses any budget, threshold or target passed to it.

- **Budget:** a fixed share of the Hearth at creation, with a minimum below which no round can open.
- **Threshold:** the next round's threshold rises after a round finds a winner and falls when nothing reaches it. A tie at or above it leaves it alone, and rejected or expired work doesn't move it.
- **Target:** a fixed multiple of the threshold.

The curator still chooses which consented missions enter a round, its time windows and its reviewer, and the reviewer judges the work.

The rule values come from the [simulation report](docs/simulation.md), and the development deployment runs them:

| Rule | Value |
| --- | --- |
| Budget share (`budget_bps`) | 2,500 (25% of the Hearth), minimum 1 NEAR |
| Threshold after a winner (`up_bps`) | ×1.05 (10,500) |
| Threshold after nothing reaches it (`down_bps`) | ×0.85 (8,500) |
| Target (`target_multiple`) | 4 × the threshold |
| Starting threshold and floor | 10,000 EMBER and 1,000 EMBER |

The ×1.05 / ×0.85 pair scored 0.825 in the controller sweep against 0.854 for the next eligible pair, so the choice is a judgment call rather than a clear win. Run `npm run simulate` to regenerate the report and `npm test` for its checks; both need only Node 24. A test fails if the deploy script's values differ from the simulator's. The values are not final until the frozen deployment.

## Limits

- **A whale can lower the threshold, then win cheaply.** The threshold falls after every round that nothing reaches. In the simulator, where the crowd alone can't reach the threshold, a whale that abstains until the threshold has halved and then backs one mission with just enough to win takes 8.1 of 20 rounds at about 2,802 EMBER per win. A whale that backs every round takes 13.0 at about 17,192. The abstaining whale pays about 84% less per win, and the threshold settles near 3,705 EMBER. Nothing in the contract prevents this. A higher threshold floor might limit it, but that is untested. Details are in the [simulation report](docs/simulation.md#threshold-controller).
- **Weight follows EMBER.** Splitting a balance across wallets gains nothing, but amount weighting doesn't stop whales, bought votes, creators backing their own missions, or collusion.
- **The faucet is farmable.** Testnet accounts are nearly free, so anyone can collect faucet EMBER until the faucet pool runs out.
- **Ash concentrates.** It goes to whoever burns the most, and the right to nominate missions follows it.
- **There are trusted roles.** The curator chooses which consented nominations enter a round, the round's time windows and its reviewer, and the reviewer judges the work. The curator, creator and reviewer could be the same people or collude.
- **The candle draw isn't perfectly random.** Users can't preview the seed of the block their `select` lands in, but a block producer could in theory bias it.
- **The development deployment can still change.** `bonfire-meraj-contract.testnet` has an access key. Every account on it is team-run.
- **Burns are not a return.** EMBER has no liquidity, buyback, yield or exchange rate. Burning is a cost and a vote, not a promise of appreciation.
- **Nothing here proves real demand.** Test NEAR has no value, so creator and stoker motivations are unproven. The simulator's scenarios are assumptions, not forecasts, and it doesn't model overlapping rounds.
- **Burns shrink a fixed supply.** That eventually limits participation. Thresholds and targets of future rounds come down by rule after failed rounds; existing rounds never change.

## Assistance tools and dependencies

- **Assistance tools:** this project was built with AI coding assistants, Claude Code (Anthropic) and Codex (OpenAI), under human direction. All code was reviewed and tested by the team.
- **Artwork:** the mascot, fire, candle, ash, flame mark and share image in `apps/web/public` were generated with ChatGPT (OpenAI) under human direction.
- **Dependencies:** `near-sdk` 5.30.1 and `near-contract-standards` 5.30.1 (MIT/Apache-2.0). For tests: `near-workspaces` 0.24.0, `tokio`, `anyhow`, `serde_json`. For types: TypeScript 7.0.2. The site's display font is Baloo 2 (SIL OFL 1.1), self-hosted through `@fontsource-variable/baloo-2` 5.3.0. Share cards render with `@vercel/og` 1.0.1 (MPL-2.0).

## License

MIT
