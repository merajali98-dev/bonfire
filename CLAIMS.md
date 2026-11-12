# Claims

Every claim BONFIRE makes in the README, on the site or in posts, with what proves it. Unit tests run with `cd contracts/bonfire && cargo test --lib`. Sandbox tests run on Linux with `cargo test --test sandbox -- --test-threads=1`, and in [CI](.github/workflows/contract.yml) on every push. Simulator and web checks run with `npm test`. `npm run verify` runs all of them on the committed `res/bonfire.wasm` and prints `HELD` per claim.

A claim marked **pending** depends on something not done yet and must not be made publicly until its status changes.

## Mechanism

| Claim | Proof | Expected |
| --- | --- | --- |
| Your EMBER burns only if your mission wins and its work is accepted; otherwise you get it back. | unit `full_success_path_burns_exactly_counted_and_pays_matched`, `rejection_refunds_winner_and_recycles_budget`, `missed_delivery_expires_and_refunds`, `absent_reviewer_expires_and_refunds`, `below_threshold_fails_selection`, `tie_fails_selection_and_refunds_everything` | pass |
| Acceptance burns exactly the counted winning escrow, no more. | unit `full_success_path_burns_exactly_counted_and_pays_matched`; sandbox `simulator_replay_matches_wasm` | pass; every round `matched` |
| Commitments after the drawn candle checkpoint don't count and are refunded. | unit `late_candle_commitment_is_not_counted_and_is_refundable`, `late_portion_of_winner_refunds_before_acceptance` | pass |
| You can't withdraw once the candle is lit. | unit `withdraw_during_candle_is_refused` | `ERR_CANDLE_LIT` |
| The candle draw happens once, only after backing closes. | unit `cannot_select_before_close`, `cannot_select_twice` | `ERR_STILL_BURNING`, `ERR_WRONG_STATUS` |
| The payout is `budget × min(counted, target) / target`, and the rest goes back to the Hearth. | unit `payout_capped_at_budget_when_target_exceeded`, `math_matches_the_shared_fixtures`; `npm test` (`rules match the shared fixtures`) | pass |
| The creator can't be paid before acceptance, and only the reviewer can accept, only the submitted hash. | unit `creator_cannot_claim_before_acceptance`, `non_reviewer_cannot_accept`, `reviewer_cannot_accept_different_hash` | `ERR_NOT_ACCEPTED`, `ERR_NOT_REVIEWER`, `ERR_HASH_MISMATCH` |
| A payout is paid once; a failed transfer can be retried. | sandbox `payout_transfer_pays_creator_exactly_once`, `payout_to_deleted_account_restores_available_and_can_retry` | pass |
| Settling is permissionless and can't pay twice. | unit `cannot_settle_twice`, `cannot_settle_before_selection` | `ERR_NOTHING_TO_SETTLE`, `ERR_NOT_SELECTED` |
| Ash comes only from burning in accepted rounds, and nominating needs Ash. | unit `ash_grants_nomination_right`, `nominating_without_ash_is_refused` | pass, `ERR_INSUFFICIENT_ASH` |
| Tokens and NEAR always reconcile. A nomination's deposit is kept to pay its storage, so it adds to the balance exactly what it locks. A pending payout is excluded from obligations because its NEAR has already left with the transfer. | unit `randomized_rounds_conserve_tokens_and_near`, `genesis_reconciles`; view `audit` | pass; `supply_ok`, `escrow_ok`, `near_ok` all `true` |
| Only the reviewer, with a full-access key, can accept or reject: both need 1 yoctoNEAR attached. | unit `accept_needs_one_yocto`, `reject_needs_one_yocto` | `Requires attached deposit of exactly 1 yoctoNEAR` |

## Money and rules

| Claim | Proof | Expected |
| --- | --- | --- |
| The Hearth has no withdrawal method; NEAR leaves only as a payout for accepted work. | The contract's method list in `contracts/bonfire/src`; site page "Steal the fire" (`withdraw_hearth`) | no such method; `MethodNotFound` |
| Nothing can mint after genesis. | `contracts/bonfire/src/lib.rs` (`new` mints once); "Steal the fire" (`mint`) | `MethodNotFound` |
| No call can set a round's budget, threshold or target. The curator still influences the threshold by choosing when rounds run, since an empty round lowers it. Only one round can be funded at a time and each has minimum windows, so reaching the floor takes at least 15 hour-long rounds. | unit `round_args_refuse_budget_threshold_and_target`, `walking_the_threshold_to_its_floor_takes_fifteen_hour_long_rounds`, `instant_rounds_are_refused`, `a_second_round_cannot_open_while_one_is_funded`; sandbox `curator_cannot_set_a_rounds_money_terms` | `Failed to deserialize input from JSON`; 15 rounds; `ERR_BAD_PARAMS`; `ERR_ROUND_OPEN` |
| A round can't lock its budget indefinitely: every window has a maximum. | unit `a_round_cannot_close_in_the_far_future`, `a_round_cannot_open_in_the_far_future` | `ERR_BAD_PARAMS` |
| A nomination by anyone but the curator pays for its own storage, so nominating can't drain the contract's reserve or the Hearth. | unit `an_ash_holder_cannot_nominate_without_paying_for_storage`, `a_deposit_one_yocto_short_of_the_storage_is_refused`, `a_nomination_paid_for_exactly_leaves_the_reserve_untouched` | `ERR_DEPOSIT`; 556 bytes for the largest nomination |
| Each round's budget is 25% of the Hearth, its target is 4× its threshold, and the threshold moves ×1.05 after a winner and ×0.85 when nothing qualifies, never below 1,000 EMBER. | unit `budget_is_a_share_of_the_pool_at_creation`, `a_winner_raises_the_next_threshold_and_target`, `nothing_reaching_threshold_lowers_it`, `threshold_never_falls_below_the_floor`; view `get_config` | pass; `rules` as stated |
| Anyone can read every rule of the final contract `fire.bonfire-hearth.testnet`, and nothing can change them. | `npm run rules`; `near contract call-function as-read-only fire.bonfire-hearth.testnet get_config json-args {} network-config testnet now`; `npm run observe` (no access keys, rules match the simulation) | every rule printed, values as in the README; `5 of 5 held` |
| The rule values came from the simulation. | `npm run simulate` regenerates [docs/simulation.md](docs/simulation.md); CI fails if it is stale; `npm test` (`the deploy script uses the rules the simulator recommends`) | no diff; pass |
| The simulator's rules match the contract's wasm. | sandbox `simulator_replay_matches_wasm` | `METRIC replay: rounds matched: 8` |
| A whale that abstains until the threshold halves pays about 84% less per win (8.1 of 20 rounds) in thin crowds. | [docs/simulation.md](docs/simulation.md), "Threshold controller" | as stated |

## Sybil resistance

| Claim | Proof | Expected |
| --- | --- | --- |
| Splitting EMBER across wallets gains no weight. | `npm test` (`splitting a whale across wallets gains no weight`); sandbox `simulator_replay_matches_wasm` ties the simulator's rules to the wasm | same winners in every seed |
| The faucet gives one claim per account per interval, registering new accounts for a storage deposit. | unit `faucet_cooldown_enforced`, `faucet_registers_and_respects_interval`; sandbox `storage_deposit_and_faucet_flow` | `ERR_FAUCET_COOLDOWN`; pass |
| The faucet pool is fixed at genesis: 1,000 EMBER per claim, once a day, from 150,000 EMBER. | `npm run rules`; view `audit` (`faucet_remaining`, `supply_ok`) | `faucet_amount` 1,000 EMBER, `faucet_interval_ms` 86,400,000; `faucet_remaining` only falls |
| Faucet farming drains the pool fast and concentrates Ash. | [docs/simulation.md](docs/simulation.md), "Scenarios" (`Faucet farming`) | 60 wallets empty it around day 2 and hold 34% of Ash |

## Limits shown by tests

| Limit | Proof | Expected |
| --- | --- | --- |
| Matching the leader at every candle checkpoint forces a tie, which fails the round and refunds the attacker in full. | unit `matching_the_leader_at_every_checkpoint_forces_a_tie_at_no_cost` | pass |

## Build and deployment

| Claim | Proof | Expected |
| --- | --- | --- |
| `res/bonfire.wasm` is a reproducible build of a named commit. | `node scripts/res.ts check`; CI job `reproducible` | `Reproduced: rebuilding <commit> gave the same <sha256>` |
| The keyless deploy is one transaction with no AddKey. | `npm run testnet -- keyless --contract <id>` (prepare only); sandbox `keyless_deploy_in_one_transaction` | `Checked the unsigned transaction: CreateAccount, Transfer, DeployContract, FunctionCall new. No AddKey.`; pass |
| The final contract `fire.bonfire-hearth.testnet` has never had an access key and runs `res/bonfire.wasm`. | `npm run observe`; [the deploy transaction](https://testnet.nearblocks.io/txns/GNnnst1azSGwCVDxtMc12wLZR6GADyQ2JUhTziJqJjnA) | `5 of 5 held`: code hash `Ge5Hnw33MAsyNzZdd6fKXLxDcMkkK4peoyRzL7juGGeg`, 0 access keys, CreateAccount, Transfer, DeployContract, FunctionCall `new` |
| The development deployment has an access key and older code. | `npm run observe -- --deployment dev` | `FAILED` on code hash and access keys; 2 of 5 held |
| One labeled demo round was accepted on testnet: 15,000 EMBER burned, 0.75 test NEAR paid. | `npm run testnet -- status`; site Ledger, burn log | Round 0 `Accepted`, `burned 15,000 EMBER`, `Paid` |
| The EMBER sticker pack was commissioned, delivered after backing closed, and accepted by its exact hash: 15,000 EMBER burned, 0.7615 test NEAR paid to the creator. | `npm run testnet -- status 2`; `sha256sum deliveries/round-1/ember-sticker-pack.zip`; site Made page | Round 2 `Accepted`, `burned 15,000 EMBER`, `Paid`; `submission.hash` = `e47961602280ed503bc2cf617f6e9e97f48f726a94b6d0df0c7c3e4bd87c74b7` |
| The final deployment's first round commissioned the demo video. It was made after backing closed and accepted by its exact hash: 12,350 EMBER burned, 0.6175 test NEAR paid to the creator, every backer settled. | `npm run testnet -- status 0 --deployment keyless`; `sha256sum deliveries/round-2/bonfire-demo.mp4`; site Made page | Round 0 `Accepted`, `burned 12,350 EMBER`, `Paid`, escrow 0; `submission.hash` = `c24cf5af5eb91ab5780797747a39f311f8ddd0f6ae8e1211c9c05541d5d555b0` |

## Site

| Claim | Proof | Expected |
| --- | --- | --- |
| The Practice floor runs a whole round with no wallet and never touches the chain. | `apps/web/src/practice-floor.ts` imports no network code; `npm test` (`practice-floor.test.ts`) | pass |
| "Steal the fire" shows the chain's real answer, and never reports a refusal it didn't get. | `npm test` (`lab-attacks.test.ts`, `only the expected refusal counts as refused`) | pass |
| Team and guest accounts are labeled wherever they appear. | `npm test` (`team and guest accounts are labeled`) | pass |
