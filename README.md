# BONFIRE

**Back the mission. See it built. Then burn together.**

Put your EMBER behind the mission you want made. If it wins and the work is accepted, your EMBER burns and the creator gets paid. Otherwise you get it back.

Built at NEAR HACKATHON (Memecoins With Mechanics; Social Money). Work in progress, testnet only.

## Status

| Part | State |
| --- | --- |
| `contracts/bonfire` — EMBER token, Hearth, nominations, rounds, candle close, matching payout, Ash, settlement | Implemented; unit and sandbox tests passing in CI; not yet deployed |
| `packages/protocol` — TypeScript types for the contract views and error codes | Implemented |
| `scripts/testnet.ts` — deploy, seed, run and settle rounds from the CLI ([runbook](scripts/README.md)) | Used for the development deployment on testnet |
| `packages/simulator` — seeded 60-day scenarios, backer strategies and rule sweeps ([report](docs/simulation.md)) | Implemented; rule math shared with the contract through fixtures |
| Development deployment — `bonfire-meraj-contract.testnet` (has an access key; every account is a team-run demo actor) | One labeled demo round accepted on testnet: 15,000 EMBER burned, 0.75 test NEAR paid |
| Web app, final keyless deployment | Not started |

Claims in this README are limited to what the repository currently contains.

## Build and test the contract

Requires Rust (with the `wasm32-unknown-unknown` target) and `cargo-near`.

```sh
cd contracts/bonfire
cargo test                                      # unit tests
cargo near build non-reproducible-wasm --no-abi # wasm -> target/near/bonfire.wasm
```

On Windows, set `AWS_LC_SYS_PREBUILT_NASM=1` before `cargo test` if NASM is not installed.

Sandbox integration tests run the built wasm on a local NEAR node. The node binary is only published for Linux and macOS, so on Windows they are skipped and [CI](.github/workflows/contract.yml) runs them:

```sh
cargo test --test sandbox -- --nocapture --test-threads=1
```

Measured at the worst case (5 missions, 12 checkpoints, 64-character account IDs): `settle` burns 7.1 TGas, `commit` 4.0 TGas, `select` 2.6 TGas, and the payout callback 2.2 TGas of its 10 TGas allowance. The largest commitment record uses 540 bytes; its 0.01 NEAR deposit covers 1,000.

## How a round's terms are set

The contract computes every round's money terms from rules fixed at initialization. The `create_round` call refuses any budget, threshold or target passed to it.

- **Budget:** a fixed share of the Hearth at creation, with a minimum below which no round can open.
- **Threshold:** the next round's threshold rises after a round finds a winner and falls when nothing reaches it. A tie at or above it leaves it alone, and rejected or expired work doesn't move it.
- **Target:** a fixed multiple of the threshold.

The curator still chooses which consented missions enter a round, its time windows and its reviewer, and the reviewer judges the work. The rule values come from the [simulation report](docs/simulation.md). Run `npm run simulate` to regenerate it and `npm test` for its checks; both need only Node 24. The values are not final until the frozen deployment.

## Assistance tools and dependencies

- **Assistance tools:** this project was built with AI coding assistants, Claude Code (Anthropic) and Codex (OpenAI), under human direction. All code was reviewed and tested by the team.
- **Dependencies:** `near-sdk` 5.30.1 and `near-contract-standards` 5.30.1 (MIT/Apache-2.0). For tests: `near-workspaces` 0.24.0, `tokio`, `anyhow`, `serde_json`. For types: TypeScript 7.0.2.

## License

MIT
