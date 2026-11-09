# BONFIRE web app

Vite, React and TypeScript. It reads the contract over public RPC, so everything is visible without signing in. Signing works through a wallet or a guest account.

```sh
npm install
npm run dev -w @bonfire/web
```

## Wallets

Wallets come from `@hot-labs/near-connect`, filtered to those whose manifest says they support testnet and sending transactions.

## Guest accounts

The browser generates a key and sends only the public key to `api/guest.ts`, which creates a labeled `g<id>.<parent>` testnet account funded with 0.1 NEAR. The private key stays in that browser. The route is onboarding only, and no part of the game depends on it.

To enable it, run `npm run testnet -- guests` from the repository root. That creates the parent account and writes `apps/web/.env.local`.

## Mission briefs

The site ships a copy of `docs/briefs` and hashes it in the browser. A brief is shown only if its SHA-256 matches the hash the mission recorded on-chain.

## Share cards

`api/card.ts` renders a 1200×630 PNG for a mission, a round result or a personal receipt. Every figure is read from the contract at request time and the URL carries only IDs, so a card can't claim anything the chain doesn't show. A receipt with no on-chain record falls back to the account's Ash, or to the plain mission card. The links people share are `/s/m/<round>/<mission>`, `/s/r/<round>` and `/s/p/<round>/<mission>/<account>`. Posting is always the person's own action: the site only opens a draft on X.

## Hosting on Vercel

The site is at https://bonfire-opal.vercel.app. To release from a checkout, run `vercel deploy --prod` from the repository root; `.vercelignore` limits the upload to the app and its shared packages. `npm run testnet -- guests-vercel` stores the guest key and redeploys.

The project uses **Root Directory** `apps/web` and these environment variables:

| Name | Value |
| --- | --- |
| `GUEST_PARENT` | The guest parent account |
| `GUEST_SECRET_KEY` | Its testnet key, from `apps/web/.env.local` |

Optional: `VITE_CONTRACT`, `VITE_RPC`, `BONFIRE_RPC`, `GUEST_FUND_NEAR`.

The route's rate limits are held per server instance, so they slow abuse rather than stop it. The parent account's balance is the hard cap on spending. Use only a testnet key here.
