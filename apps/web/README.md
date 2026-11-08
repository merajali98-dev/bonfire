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

## Hosting on Vercel

Import the repository, set **Root Directory** to `apps/web`, and add these environment variables:

| Name | Value |
| --- | --- |
| `GUEST_PARENT` | The guest parent account |
| `GUEST_SECRET_KEY` | Its testnet key, from `apps/web/.env.local` |

Optional: `VITE_CONTRACT`, `VITE_RPC`, `BONFIRE_RPC`, `GUEST_FUND_NEAR`.

The route's rate limits are held per server instance, so they slow abuse rather than stop it. The parent account's balance is the hard cap on spending. Use only a testnet key here.
