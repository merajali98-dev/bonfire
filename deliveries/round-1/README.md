# Round 1 delivery: EMBER sticker pack

On-chain this is round 2 of the development deployment `bonfire-meraj-contract.testnet`, the first round that ran to delivery.

- `ember-sticker-pack.zip`: six transparent PNG stickers and the maker's note, as submitted. SHA-256 `e47961602280ed503bc2cf617f6e9e97f48f726a94b6d0df0c7c3e4bd87c74b7`.
- Made by the team creator account `bonfire-meraj-maker1.testnet` after backing closed at 17:43:21 UTC on 9 Nov 2026. The stickers were generated with OpenAI ImageGen, using the site's idle mascot as the reference; the note inside the zip lists the prompts.
- Free for anyone to use, copy, share and adapt.

Check it:

```sh
sha256sum deliveries/round-1/ember-sticker-pack.zip
```

The result must equal the `submission.hash` of round 2 on `bonfire-meraj-contract.testnet`.

## On-chain record

All on `bonfire-meraj-contract.testnet`, signed by labeled team accounts:

| Step | Transaction |
| --- | --- |
| Draw (checkpoint 5; the sticker pack won with 15,000 EMBER counted) | `6sjWttpp65eS3Qhv7mxL7NqfLUbHWdM9JiSM8Kc56rFT` |
| Submit by `bonfire-meraj-maker1.testnet` | `CC1nxXcXeY9tFSr89AUWTFepGMF6Z6P9hkdsqZj1pdUo` |
| Accept by the curator, for this exact hash | `8fQpmgMcN8SW6FLsRfYLAtpyEsmtmvnV8G8NiH2iDNKe` |
| Creator payout, 0.7615 test NEAR | `4bgeKk9y3rHTqy9pG1d8jvDscSJs3oiF5g9FRy47VL5f` |
| Settle `bonfire-meraj-backer1.testnet` | `AXyupFdti3aFvTiKXntqUjQdDR83PrGyKpjTmMkYNpvf` |
| Settle `bonfire-meraj-backer2.testnet` | `43NLhNDXBR5Sjn6LvvzZJmq6d5bn5Etivhdmb2QwdU5k` |

Acceptance burned the 15,000 counted EMBER and recorded it as Ash for the two backers.
