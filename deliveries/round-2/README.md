# Round 2 delivery: the hackathon demo video

On-chain this is round 0 of the final deployment `fire.bonfire-hearth.testnet`, its first round.

- `bonfire-demo.mp4`: the video as submitted. 1920×1080, 2 minutes 57 seconds. SHA-256 `c24cf5af5eb91ab5780797747a39f311f8ddd0f6ae8e1211c9c05541d5d555b0`.
- Delivered by the team creator account `bonfire-meraj-maker1.testnet`. It opens by saying it was commissioned by BONFIRE Round 2 and that 12,350 EMBER burned to make it. That EMBER is the counted total behind this mission, and it burns when the reviewer accepts this exact file.

## How it was made

- **Screen footage:** the live site at phone size (390×844 at 2×), driven by a script in headless Microsoft Edge through Playwright and captured with Chrome's screencast. The live round, the guest's faucet claim and commitment, and the candle had to be captured during backing, because they only exist then. Everything else was captured after backing closed. The narration, cards and edit were all made after backing closed at 22:13:43 UTC on 9 Nov 2026. The guest and Practice footage is sped up, and the video says so.
- **Narration:** Gemini TTS (`gemini-3.8-flash-tts`, voice Kore), one request per scene. Pauses were shortened and the tempo raised 7% to fit three minutes.
- **Music:** Lyria (`lyria-3.5`), a slow ambient track, mixed low under the voice.
- **Cards and edit:** HTML title cards in the site's font, rendered to images; ffmpeg for assembly and loudness (-16 LUFS).
- **Direction, scripting and recording:** Claude Code (Anthropic), for the BONFIRE team.

## Transactions shown

All on NEAR testnet. Team accounts are labeled; `gf0146cda48.bonfire-meraj-guests.testnet` is a guest created for the recording.

| On screen | Transaction |
| --- | --- |
| Round 0 opened on `fire.bonfire-hearth.testnet` | `4wB1Fdf8mfkTH1JVrhAkRscNTvd4LpvJAQqscm41yhao` |
| Guest faucet claim | `H4MDPiH8GtfwQTKesFGVeeTvnU5DjoFyzZNM6FT379aD` |
| Guest commits 250 EMBER to the video | `BaWqZbgAorbDgDC5Q24xfz85u8CfFprkzEw16F8d1LPW` |
| Guest adds 100 EMBER during the candle | `EUkpKsvYqGniB8DFC2g3Tkb8NuPz7HZHH1CtLGmYr2db` |
| The draw: checkpoint 1 of 6; the video won with 12,350 EMBER counted | `FxsHbTPR3sAUKo5GdfoeMvDVPiDzCTBwQRNiwp1yhCVR` |
| Refused: take NEAR out of the Hearth (`MethodNotFound`) | `5WgcuRwe43br5bwGzVqhuyPBGKwo5nWAHkZng9vUfyTi` |
| Refused: accept the work yourself (`ERR_NOT_REVIEWER`) | `87826NQ9FhzBavHTxs2XMrcp5fLmu9AEnhfqsxGoyqFi` |
| Sticker pack accepted (development deployment) | `8fQpmgMcN8SW6FLsRfYLAtpyEsmtmvnV8G8NiH2iDNKe` |
| Sticker pack payout (development deployment) | `4bgeKk9y3rHTqy9pG1d8jvDscSJs3oiF5g9FRy47VL5f` |
| The final contract's single deploy transaction | `GNnnst1azSGwCVDxtMc12wLZR6GADyQ2JUhTziJqJjnA` |

The other team commitments in this round: `bonfire-meraj-backer1.testnet` committed 12,000 EMBER to the video (`7bm4Y4cFkEJ2bCygxDP3yf4yTzkHkn2JhKJ94J1kR6Ad`), and `bonfire-meraj-backer2.testnet` committed 4,000 to the judge guide (`7dGvVT4dmUSuCya8De7b78AtSHssmznTCkVhKToV3ZXF`).

Check it:

```sh
sha256sum deliveries/round-2/bonfire-demo.mp4
```

The result must equal the `submission.hash` of round 0 on `fire.bonfire-hearth.testnet`.

## Outcome

| Step | Transaction |
| --- | --- |
| Submit by `bonfire-meraj-maker1.testnet` | `GjtZLVUG4uqAWaP9J2nbvWzJhimqEaiHaCEJcPbrr89j` |
| Accept by the curator, for this exact hash; 12,350 EMBER burned | `BRrZt9szaHchtCKXwfQQ2ZnD1dDVWJctDT6dpmCxByv9` |
| Creator payout, 0.6175 test NEAR | `BhCQATyL9RaxCndEbcAJNjqPQJvL91aypdDQPL1RpEBu` |
| Settle the three backers | `43piyYBijvi7z8jNaz6VeXHeS42dcDApo6bS3NhLDbox`, `HBb2jQX3MZgd6Fi8rtotUtHEwcBREydv68YZExa9VjTr`, `FyHk5kQvvxqhtu3hDuWFLDrJUVk9KJQvrWSkhebkHpm8` |

The video was accepted after it was committed to the repository. Its opening line, that 12,350 EMBER burned to make it, became true with that acceptance.
