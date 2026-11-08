# BONFIRE

**Back the mission. See it built. Then burn together.**

Put your EMBER behind the mission you want made. If it wins and the work is accepted, your EMBER burns and the creator gets paid. Otherwise you get it back.

Built at NEAR HACKATHON (Memecoins With Mechanics; Social Money). Work in progress, testnet only.

## Status

| Part | State |
| --- | --- |
| `contracts/bonfire` — EMBER token, Hearth, nominations, rounds, candle close, matching payout, Ash, settlement | Implemented; unit tests passing; not yet deployed |
| Web app, simulator, sandbox tests, deployment | Not started |

Claims in this README are limited to what the repository currently contains.

## Build and test the contract

Requires Rust (with the `wasm32-unknown-unknown` target) and `cargo-near`.

```sh
cd contracts/bonfire
cargo test                                      # unit tests
cargo near build non-reproducible-wasm --no-abi # wasm -> target/near/bonfire.wasm
```

On Windows, set `AWS_LC_SYS_PREBUILT_NASM=1` before `cargo test` if NASM is not installed.

## Assistance tools and dependencies

- **Assistance tools:** this project was built with AI coding assistants, Claude Code (Anthropic) and Codex (OpenAI), under human direction. All code was reviewed and tested by the team.
- **Dependencies:** `near-sdk` 5.30.1 and `near-contract-standards` 5.30.1 (MIT/Apache-2.0).

## License

MIT
