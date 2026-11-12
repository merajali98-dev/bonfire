# BONFIRE

**Back the mission. See it built. Then burn together.**

Put your EMBER behind the mission you want made. If it wins and the work is accepted, your EMBER burns and the creator gets paid. Otherwise you get it back.

Built at NEAR HACKATHON (Memecoins With Mechanics; Social Money). Testnet only.

**The contract:** `fire.bonfire-hearth.testnet`, the final deployment. It has never had an access key, so no one can change its code or its rules, and it is the contract the live site reads. `npm run observe` checks this with no key, and `npm run rules` prints every rule it was initialized with. An earlier development deployment, `bonfire-meraj-contract.testnet`, has an access key and older code. Only the sticker pack round on the site's Made page comes from it.

**Demo video:** [deliveries/round-2/bonfire-demo.mp4](deliveries/round-2/bonfire-demo.mp4) (2:57), also [posted on X](https://x.com/merajali206/status/2119992632571232634). BONFIRE commissioned it: it won Round 2 on the final contract `fire.bonfire-hearth.testnet` and was accepted by its exact hash, burning 12,350 EMBER there. It also plays on the site's Made page.

## Try it in five minutes

1. Open [the site](https://bonfire-opal.vercel.app) and start as a guest: no wallet or install. Or connect a wallet.
2. Claim faucet EMBER and back a mission in the live round.
3. Open **Practice** to run a whole round (back, candle, draw, build, review, burn, settle) in about 90 seconds, locally.
4. Open **Steal the fire** and try to take NEAR out of the Hearth, mint, or accept work yourself. Each attempt is a real transaction, and the contract refuses it.
5. Open **Ledger** for the proof checks, supply, burn log and Hearth.

Automated reviewers: start with [AGENTS.md](AGENTS.md). Every claim and its proof is in [CLAIMS.md](CLAIMS.md).

## Status

| Part | State |
| --- | --- |
| **Final keyless deployment — `fire.bonfire-hearth.testnet`** (the contract the site reads) | Live on testnet since 9 Nov: created, funded, deployed with `res/bonfire.wasm` and initialized in [one transaction](https://testnet.nearblocks.io/txns/GNnnst1azSGwCVDxtMc12wLZR6GADyQ2JUhTziJqJjnA) with no AddKey, so it has never had an access key. `npm run observe` holds 5 of 5. Its first round (Round 2) ran on 9 Nov and was accepted on this contract: the demo video won with 12,350 EMBER counted, was made after backing closed, and was accepted by its exact hash. 12,350 EMBER burned and 0.6175 test NEAR went to the creator ([delivery](deliveries/round-2)). Backers were team accounts and one guest created for the recording. Round 3 is open until 13 Nov 22:26 UTC |
| `res/bonfire.wasm` — the deployable build, made reproducibly in CI | Committed with its SHA-256 and source commit; this is the frozen contract running on the final deployment |
| `contracts/bonfire` — EMBER token, Hearth, nominations, rounds, candle close, matching payout, Ash, settlement | Implemented; unit and sandbox tests passing in CI; built into `res/bonfire.wasm` and running on the final deployment |
| `apps/web` — live round, guest account or wallet sign-in, faucet, commit, My embers with settle, share cards rendered from chain data, a local Practice floor, a Made page showing delivered work checked against its on-chain hash, a Ledger page with the proof checks, supply, burn log and Hearth, and a "Try to steal the fire" page where visitors send forbidden transactions from their own account and see the real refusal, and a Simulator page charting the 60-day scenarios ([site](https://bonfire-opal.vercel.app), [setup](apps/web/README.md)) | Live, reading the final keyless deployment since 9 Nov; signed commits confirmed on testnet from a guest on a phone and from a wallet. Only the sticker pack on the Made page is read from the development deployment, where that round ran |
| `packages/simulator` — seeded 60-day scenarios, backer strategies and rule sweeps ([report](docs/simulation.md)) | Implemented; rule math shared with the contract through fixtures, and one seeded run replayed against the wasm in CI |
| `packages/protocol` — TypeScript types for the contract views and error codes | Implemented |
| `scripts/testnet.ts` — deploy, seed, run and settle rounds from the CLI ([runbook](scripts/README.md)) | Used for both deployments on testnet, including the final deployment's one-transaction deploy |
| Development deployment — `bonfire-meraj-contract.testnet` (has an access key and older code; not the final contract; every account is a team-run demo actor) | Used before the final deployment existed. Two rounds accepted there: a labeled demo round (15,000 EMBER burned, 0.75 test NEAR paid) and the EMBER sticker pack, commissioned and delivered after backing closed (15,000 EMBER burned, 0.7615 test NEAR paid; [delivery](deliveries/round-1)). All backers were team accounts |

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

The final deployment `fire.bonfire-hearth.testnet` runs exactly `res/bonfire.wasm`: `npm run observe` compares its on-chain code hash with this file. The development deployment was built before this and runs different bytes.

### Sandbox tests

Sandbox integration tests run the built wasm on a local NEAR node. The node binary is only published for Linux and macOS, so on Windows they are skipped and [CI](.github/workflows/contract.yml) runs them:

```sh
cargo test --test sandbox -- --nocapture --test-threads=1
```

`simulator_replay_matches_wasm` replays a seeded run of `packages/simulator` on the wasm: 8 rounds, 11 backers, 3 missions, 3 candle checkpoints. The contract makes each candle draw itself. The simulator is then told that draw and must predict the winner, counted escrow, payout, burn, every backer's refunds and Ash, the Hearth and the next threshold exactly, or the test fails. It needs Node 24 as well as the sandbox.

Measured at the worst case (5 missions, 12 checkpoints, 64-character account IDs): `settle` burns 7.1 TGas, `commit` 4.0 TGas, `select` 2.6 TGas, and the payout callback 2.2 TGas of its 10 TGas allowance. The largest commitment record uses 540 bytes; its 0.01 NEAR deposit covers 1,000.

## Check a deployment without a key

```sh
npm run observe                        # the keyless final deployment (deployments/testnet.json)
npm run observe -- --deployment dev    # the development deployment
```

`observe` needs only Node 24 and public RPC. It checks that the deployed code hash equals `res/bonfire.wasm`, that the contract account has no access keys, that one transaction created, funded, deployed and initialized it with no AddKey, that the rules match the simulation, and that `audit()` reconciles. Each claim prints `HELD`, `FAILED` or `UNAVAILABLE` with what it observed, and anything but all `HELD` exits non-zero. On the keyless deployment all 5 hold. On the development deployment 2 of 5 hold, because it has an access key and older code.

### Read every rule from the contract

```sh
npm run rules                          # every rule of fire.bonfire-hearth.testnet, read live, with what it means
```

It calls the contract's `get_config`, `get_next_round_terms` and `audit` views over public RPC and prints each value: supply, faucet amount and interval, the Ash needed to nominate, budget share, threshold start, floor and steps, target multiple, every time window, and the curator. It needs only Node 24 and no key. The raw config is a single view call with [NEAR CLI](https://github.com/near/near-cli-rs) too:

```sh
near contract call-function as-read-only fire.bonfire-hearth.testnet get_config json-args {} network-config testnet now
```

Amounts are in the smallest unit: EMBER has 18 decimals and NEAR has 24. The contract has no method that writes its config, and with no access key its code can't be replaced, so these values are final.

## How a round's terms are set

The contract computes every round's money terms from rules fixed at initialization. The `create_round` call refuses any budget, threshold or target passed to it.

- **Budget:** a fixed share of the Hearth at creation, with a minimum below which no round can open.
- **Threshold:** the next round's threshold rises after a round finds a winner and falls when nothing reaches it. A tie at or above it leaves it alone, and rejected or expired work doesn't move it.
- **Target:** a fixed multiple of the threshold.
- **Windows:** only one round can be funded at a time, and each window has a minimum and maximum fixed at initialization: backing lasts 1 hour to 7 days, the candle 10 minutes to 1 day, and delivery and review 1 hour to 3 days each. A round must open within 2 days of being created.

The curator still chooses which consented missions enter a round, its time windows and its reviewer, and the reviewer judges the work.

The rule values come from the [simulation report](docs/simulation.md), and the final deployment `fire.bonfire-hearth.testnet` runs them (`npm run rules` prints them from the contract):

| Rule | Value |
| --- | --- |
| Budget share (`budget_bps`) | 2,500 (25% of the Hearth), minimum 1 NEAR |
| Threshold after a winner (`up_bps`) | ×1.05 (10,500) |
| Threshold after nothing reaches it (`down_bps`) | ×0.85 (8,500) |
| Target (`target_multiple`) | 4 × the threshold |
| Starting threshold and floor | 10,000 EMBER and 1,000 EMBER |

The ×1.05 / ×0.85 pair scored 0.825 in the controller sweep against 0.854 for the next eligible pair, so the choice is a judgment call rather than a clear win. Run `npm run simulate` to regenerate the report and `npm test` for its checks; both need only Node 24. A test fails if the deploy script's values differ from the simulator's, and `npm run observe` fails if the deployed contract's rules differ from the simulation's. They are final: the keyless contract can't change them.

## Sybil resistance

Sybil resistance means stopping one person from acting as many. Here is what BONFIRE does and where it stops working. `npm run rules` prints every contract value used below.

- **Weight is EMBER, not accounts.** Mission tallies, the creator's payout and Ash all count EMBER, and each depends only on how much EMBER there is, not on how many accounts hold it. Splitting a balance across many accounts adds nothing, so the usual payoff from fake accounts, extra votes per head, doesn't exist. In the simulation, one whale and the same wealth split across 10 wallets pick the same winners in every seed (test `splitting a whale across wallets gains no weight`).
- **The only free EMBER is the faucet, and it is capped.** It gives 1,000 EMBER per claim, one claim per account per day (`ERR_FAUCET_COOLDOWN`), from a pool of 150,000 EMBER fixed at genesis (`ERR_FAUCET_EMPTY` once it runs out). Nothing can mint more. A first claim also pays the NEP-145 storage deposit to register the account.
- **Farmed EMBER does nothing until it burns.** EMBER behind a mission burns only when the work is accepted, so a farmer who wins a round has paid for real work with what they farmed. Turning farmed EMBER into NEAR would need a mission whose creator is the farmer to enter a round, which the curator decides, and its work to be accepted, which the reviewer decides.
- **Ash can't be farmed without burning.** Ash comes only from burned EMBER, and nominating a mission takes 1,000 Ash.
- **Guest accounts are rate-limited.** The site creates at most 3 guest accounts per IP address per hour, and 40 per server instance ([`apps/web/api/guest.ts`](apps/web/api/guest.ts)).

Its limits, plainly:

- **Eleven accounts are enough to reach the current threshold.** Eleven fresh accounts claiming once each hold 11,000 EMBER, above the 10,500 EMBER threshold. The pool, 149,000 EMBER left, is about 14 thresholds. A scripted farmer could drain it in a day and decide which mission wins rounds until it runs out. In the [simulation](docs/simulation.md#scenarios), 60 farming wallets empty the faucet around day 2 and end with 34% of all Ash. They still burn that EMBER only for accepted work.
- **No per-account cap and no minimum account age.** The contract doesn't limit how much one account backs, or how new an account is. The keyless contract was frozen without these rules, and it can't be changed now.
- **Splitting hides concentration.** Rankings and Ash are per account, so one person's Ash spread over ten accounts looks like ten smaller keepers. In the simulation the same whale's Ash Gini reads 0.52 as one wallet and 0.33 across ten.
- **The guest limits only slow a script.** They are kept in memory per server instance. Anyone can create testnet accounts directly and call the faucet without the site.
- **What a launch would need.** A mainnet version would drop the faucet, so every EMBER has to be bought, or gate it behind proof of personhood or an account-age and balance check. These are untested here.

## Limits

- **A whale can lower the threshold, then win cheaply.** The threshold falls after every round that nothing reaches. In the simulator, where the crowd alone can't reach the threshold, a whale that abstains until the threshold has halved and then backs one mission with just enough to win takes 8.1 of 20 rounds at about 2,802 EMBER per win. A whale that backs every round takes 13.0 at about 17,192. The abstaining whale pays about 84% less per win, and the threshold settles near 3,705 EMBER. Nothing in the contract prevents this. A higher threshold floor might limit it, but that is untested. Details are in the [simulation report](docs/simulation.md#threshold-controller).
- **A tie can veto a round for free.** Anyone who matches the leading mission's tally at every candle checkpoint forces a tie whichever checkpoint is drawn. A tie fails the round and refunds everyone, the attacker included, so blocking a round costs no EMBER. It does need as much EMBER as the leader, and it doesn't move the threshold. The tie rule is unchanged; the test `matching_the_leader_at_every_checkpoint_forces_a_tie_at_no_cost` shows it.
- **The curator still steers the threshold a little.** It chooses when rounds run, and an empty round lowers the next threshold. Only one round can be funded at a time, and backing lasts at least an hour, so walking the threshold from 10,000 EMBER to its 1,000 floor takes at least 15 hour-long empty rounds, in public.
- **Weight follows EMBER.** Splitting a balance across wallets gains nothing, but amount weighting doesn't stop whales, bought votes, creators backing their own missions, or collusion.
- **The faucet is farmable.** Testnet accounts are nearly free, so anyone can collect faucet EMBER until the faucet pool runs out. See [Sybil resistance](#sybil-resistance) for what limits it and what doesn't.
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
- **Commissioned work:** the six Round 2 stickers in `deliveries/round-1/` were generated with OpenAI ImageGen by the team creator account, using the site's idle mascot as the reference. The note inside the zip lists the prompts. They are free for anyone to use.
- **Demo video:** `deliveries/round-2/bonfire-demo.mp4` was recorded from the live site and edited by Claude Code (Anthropic), narrated with Gemini TTS (Google, voice Kore), with music from Lyria (Google). Its [note](deliveries/round-2/README.md) lists every tool and every transaction it shows.
- **Dependencies:** `near-sdk` 5.30.1 and `near-contract-standards` 5.30.1 (MIT/Apache-2.0). For tests: `near-workspaces` 0.24.0, `tokio`, `anyhow`, `serde_json`. For types: TypeScript 7.0.2. The site's display font is Baloo 2 (SIL OFL 1.1), self-hosted through `@fontsource-variable/baloo-2` 5.3.0. Share cards render with `@vercel/og` 1.0.1 (MPL-2.0).

## Other hackathon submissions

The same team also built [Ashes of the Ninth Heaven](https://github.com/merajali98-dev/ashes-of-the-ninth-heaven), a separate project with its own code: a xianxia deckbuilding RPG whose market runs on NEAR.

## License

MIT
