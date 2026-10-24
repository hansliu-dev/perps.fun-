# perps.fun

Social perpetual-futures trading. Copy other traders in proportion, post chart theses that show up on the live chart, and discover who's trading well, with real USDC on Hyperliquid perps through the [TrueMarkets Gateway](https://docs.truemarkets.co/gateway/).

> **Real money.** Orders, copies and withdrawals move real funds. Keep amounts small, and read [Risks and limits](#risks-and-limits) before inviting anyone.

## Features

- **Trading.** Live candles for 30+ perps, a market picker with search, long/short with leverage and TP/SL, and positions with live PnL.
- **Copy-trading, proportional.** Pick a trader and a budget. When they put 10% of their account into a trade, you put 10% of your budget in, at their leverage. Adds, trims and closes are mirrored in proportion, and you can close a copied position yourself at any time.
- **Theses.** Draw on a chart (trend lines, Fibonacci, boxes, arrows…), add one sentence of up to 70 characters, and post. Your avatar appears on that market's live chart where you posted, and hovering shows the annotated screenshot.
- **Discovery.** Browse the newest traders or search by name or @handle, with each person's live PnL and return.
- **Portfolio.** Available USDC, deposit addresses, withdrawals (same-network transfers), recent trades including copied ones, and who you're copying.
- **Profiles.** Google sign-in, an editable display name and photo, and a public page with theses and trades.

## How it works

```
Browser (Next.js)                 Firebase                                  TrueMarkets Gateway
─────────────────                 ────────                                  ───────────────────
Google sign-in ─────────────────▶ Auth
KLineChart  ◀── candles ───────── (Hyperliquid public API, history)
            ◀── live prices ──────────────────────────────────────────────── market-data WebSocket
Buttons ─── callable ───────────▶ Cloud Functions (europe-west1) ─ org token + TM-On-Behalf-Of ─▶ orders, positions,
                                   holds the org API key and                                       balances, transfers
                                   signer key (Secret Manager)                                       │
Live UI ◀── realtime ──────────── Firestore (profiles, trades, theses,                              ▼
                                   follows, ledgers, snapshots)                               Hyperliquid perps
```

- **One TrueMarkets user per person.** It's created on first sign-in with `external_ref_id = Firebase uid`. The backend acts for that user with the organization token plus `TM-On-Behalf-Of`, and signs each wallet transaction with the organization's signer key.
- **Funding.** USDC on Solana, Base, Arbitrum or Hyperliquid can all be traded. TrueMarkets routes it into Hyperliquid margin when an order needs it.
- **Copying lives in one account.** Hyperliquid allows one position per coin per account, so a ledger (`functions/src/copy/ledger.ts`) records which part of each position came from which leader:
  - When a leader closes, only their share closes.
  - Followers only copy a trader's **own** trades, never what that trader copied, so there are no copy chains.
  - A copy that would go against an opposite position you hold is skipped.
- **Copy sync.** Positions are diffed into events (open, increase, reduce, close) right after every trade and every minute. The every-minute run catches TP/SL fills and liquidations.

## Repository layout

```
web/                        Next.js 15 app (App Router, Tailwind, KLineChart)
  src/app/                  pages: markets/[symbol], leaderboard, portfolio, thesis, u/[handle], settings, status
  src/components/           Chart, OrderTicket, Positions, MarketPicker, AmountSlider, Toasts, RecentTrades…
  src/lib/                  data loader, market WebSocket, Firebase client, hooks
functions/                  Firebase Cloud Functions (TypeScript)
  src/tm/                   TrueMarkets client: auth (ES256 token), signer, orders, transfers
  src/copy/                 copy engine: diff, sizing, plan, ledger, engine
  src/api/                  callables: onboard, placePerpOrder, closePosition, follow, unfollow,
                            closeCopyLot, withdraw, submitThesis, updateProfile, getPortfolio, getWallet
  src/jobs.ts               copy sync trigger + every-minute sync + follow stats
  scripts/                  new-signer-key, list-users, spike-uat
  test/                     vitest suites (signing, orders, sizing, ledger, copy scenarios)
firestore.rules, storage.rules, firestore.indexes.json, firebase.json
```

## Setup

### Prerequisites

- Node.js 20+ and `npm i -g firebase-tools`
- A Firebase project on the **Blaze** plan, with:
  - Google sign-in enabled
  - Firestore and Storage created, preferably in `europe-west1`
- A TrueMarkets organization and API key from [console.truemarkets.co](https://console.truemarkets.co/)

### 1. Keys (never commit these)

```bash
cd functions
mkdir -p secrets
# Put the API key file you downloaded from the TrueMarkets console here:
#   functions/secrets/prod-api-key.json
npm install
npm run new-signer-key        # writes secrets/prod-signer.json, refuses to overwrite
```

**Back up `prod-signer.json` before anyone signs up.** Every user's wallet is tied to it, and it can't be rotated. If it's lost, those wallets can never sign again.

### 2. Backend settings

Create `functions/.env` (it's gitignored):

```
BLOCKED_COUNTRIES=CU,IR,KP,SY,RU,BY
DAILY_WITHDRAWAL_LIMIT_USD=500
```

`BLOCKED_COUNTRIES` is checked by IP on sign-up and on every money action, and it **fails closed**: an unknown country is blocked. Without this file the default list also blocks the US. Only drop a country if TrueMarkets has enabled perps for your users there.

### 3. Deploy

```bash
cd ..                                   # repo root
firebase use --add                      # pick your project
firebase functions:secrets:set TM_API_KEY    --data-file functions/secrets/prod-api-key.json
firebase functions:secrets:set TM_SIGNER_KEY --data-file functions/secrets/prod-signer.json
firebase deploy --only functions,firestore,storage
```

The functions run in `europe-west1` (`REGION` in `functions/src/config.ts`; it must match `FUNCTIONS_REGION` in `web/src/lib/api.ts`). After deploying, sign in and open `/status` to see which products TrueMarkets allows from the backend's location.

### 4. Run the web app

```bash
cd web
cp .env.example .env.local              # fill in from Firebase console → Project settings → Your apps
npm install
npm run dev                             # http://localhost:3000
```

## Scripts and tests

```bash
cd functions
npm test                                # vitest: signing, orders, copy sizing, ledger, multi-leader scenarios
npm run typecheck
npm run list-users -- --csv             # every TrueMarkets user in the org with Solana/EVM addresses (read-only)
TM_KEY_FILE=secrets/uat-api-key.json npm run spike   # end-to-end check on the TrueMarkets sandbox (test money)

cd ../web
npx tsc --noEmit && npx next lint
```

## Risks and limits

- **Perps are restricted by country.** TrueMarkets doesn't offer them from the US by default, and decides by the requesting IP, which is this backend's. Keep the country check on, and only relax it with TrueMarkets' written confirmation.
- **Custody.** The backend's signer key can move any user's funds, with TrueMarkets co-signing. Treat it like a production database root credential. Offering this to the public likely needs a legal review (custody, money transmission, derivatives).
- **Hyperliquid's minimum position is $10.** Copies smaller than that are skipped and logged with the reason, and a bigger copy budget fixes it.
- **Transfer fees.** Every TrueMarkets transfer has a small flat fee, which is why copying doesn't move money between accounts.
- **Withdrawals** stay on the same network and are final. They need a Google sign-in from the last 10 minutes and are capped at the daily limit.
- **Leaderboard ranking** (24h return on equity) isn't computed yet. Discovery and live PnL work.

## Credits

Built on [TrueMarkets Gateway](https://docs.truemarkets.co/), [Hyperliquid](https://hyperliquid.xyz), [KLineChart](https://klinecharts.com) (Apache-2.0), Next.js and Firebase.
