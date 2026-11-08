# Testnet operator tool

`scripts/testnet.ts` runs every contract action from the command line, so nothing depends on the website. It needs Node 24 and [near-cli-rs](https://github.com/near/near-cli-rs), and it signs with keys in the CLI's legacy keychain (`~/.near-credentials`). Keys never enter this repository.

`deployments/testnet-dev.json` records account IDs, the code hash and transaction hashes. Everything in a development deployment is a team-run demo actor.

## First deployment

To do all of it at once, run `npm run testnet -- first-run --prefix <name>`. It creates the accounts, builds the wasm, deploys, seeds and runs the demo. The steps are below if you want them one at a time.

Build the contract, then check what is ready. `doctor` only reads.

```sh
cd contracts/bonfire && cargo near build non-reproducible-wasm --no-abi && cd ../..
npm run testnet -- doctor --prefix <name>
```

Then, in order. Each step can be rerun; finished work is skipped. Add `--dry-run` to see the exact commands without sending anything.

```sh
npm run testnet -- accounts --prefix <name>   # 9 accounts from the testnet faucet
npm run testnet -- deploy                     # deploy and init; the account's remaining balance is the reserve
npm run testnet -- seed                       # stoke 8 NEAR, fund the demo backers, nominate and consent
npm run testnet -- demo                       # about 5 minutes: commit, candle, draw, submit, accept, burn, claim, settle
npm run testnet -- status
```

The wasm locks about 3.2 NEAR, and the faucet gives each account about 10 NEAR. The stoke comes from its own account for that reason, so round budgets of 1 to 3 NEAR are realistic. A round's budget is 25% of the Hearth and must be at least 1 NEAR.

A deployment holds one contract state. To deploy code with a different state layout, move the manifest aside and start again with a new prefix.

## Running a round

```sh
npm run testnet -- round --set round-1 --backing 12h --candle 2h --checkpoints 12 --delivery 24h --review 12h
npm run testnet -- commit <round> <mission> <ember> --as backer1
npm run testnet -- select <round>
npm run testnet -- submit <round> --file <artifact> --uri <url>
npm run testnet -- accept <round>                # or: reject <round>
npm run testnet -- claim <round>
npm run testnet -- settle-all <round> --accounts alice.testnet,bob.testnet
npm run testnet -- expire <round>                # after a missed deadline
```

`--as` takes a role from the manifest or a full account ID. `--backing` is the whole backing period, and the candle is its final part. The curator picks the missions, time windows and reviewer; the contract computes each round's budget, threshold and target, and `status` shows what the next round would get.

`settle-all` covers the accounts in the manifest plus any in `--accounts`, because the contract keeps no list of who backed a round. Anyone can settle any account with `settle <round> <account>`.
