# bMovies — quickstart

> Clone → install → fund → launch → watch. 10 steps, ~30 minutes
> if you already have BSV Desktop installed. This is the path a
> hackathon judge or curious developer would take to replicate
> the swarm locally.

## Prerequisites

- **macOS or Linux** (tested on macOS; Linux should Just Work)
- **Node 22+** with `pnpm` installed (`npm i -g pnpm`)
- **BSV Desktop** installed from https://github.com/bsv-blockchain/bsv-desktop/releases/latest and running (creates a BRC-100 wallet on `localhost:3321`)
- **A few thousand sats** in a BSV wallet you control (to fund the agent addresses the script generates)
- **Optional for the full pipeline**: BSVAPI API key or pre-loaded BSV credit if you want the swarm to call Grok + AtlasCloud + Replicate upstream. Without this the swarm still runs end-to-end against a simulated upstream (no real AI calls).

## Ten-step local run

### 1. Clone and install

```bash
git clone https://github.com/b0ase/bmovies.git
cd bmovies
pnpm install
```

### 2. Check the repo is sane

```bash
pnpm vitest run          # should be 152/152
pnpm typecheck           # no output = clean
```

### 3. Generate the pitch receive address

```bash
pnpm tsx scripts/generate-pitch-address.ts
```

Script prints a fresh BSV address + WIF. The address goes into `docs/brochure/pitch-config.json` automatically. The WIF is displayed in your terminal **once** — copy it into your password manager immediately. It's the spend key for whatever sats land on the pitch-register address.

### 4. Create the agent config

```bash
pnpm tsx scripts/setup-agents.ts
```

Generates four agent wallets (SpielbergX the producer, VC-X and CapitalK as financiers, ClawNode-A as the streaming seeder) and writes them to `config/agents.json`. Print the four addresses that come out of it.

### 5. Fund the agent addresses

Send a small amount of BSV to each of the four addresses printed in step 4. Typical amounts for a single test run:

- **SpielbergX** (producer): ~100k sats (mints + spends BSVAPI payments)
- **VC-X** (financier): ~30k sats (subscribes to offers)
- **CapitalK** (financier): ~30k sats (subscribes to offers)
- **ClawNode-A** (seeder): ~200k sats (streaming pool)

Total ~360k sats ≈ $0.50 at recent prices.

### 6. Configure `.env.local`

```bash
cp .env.example .env.local
$EDITOR .env.local
```

Set at minimum:

```bash
# Hetzner-hosted Supabase (or your own instance)
SUPABASE_URL=https://api.b0ase.com
SUPABASE_SERVICE_ROLE_KEY=<your service role key>

# Pitch address from step 3
PITCH_RECEIVE_ADDRESS=<address from step 3>

# (Optional) xAI Grok key for the /api/refine serverless function
# and for direct runner use
XAI_API_KEY=<your xAI key>
```

### 7. Apply the Supabase migrations

```bash
for m in supabase/migrations/*.sql; do
  ssh your-postgres-host "docker exec -i supabase-db psql -U postgres -d postgres" < "$m"
done
```

(Adjust the ssh command to match your own Postgres deployment. The migrations are idempotent — safe to re-run.)

### 8. Launch BSV Desktop

Open the BSV Desktop app. Create or unlock a wallet. Leave it running in the background on `localhost:3321`. The bMovies brochure will talk to it via the BRC-100 `WalletClient` substrate.

### 9. Start the swarm

```bash
pnpm agents:swarm -- --team --bsvapi https://www.bsvapi.com --arc --max-offers 1
```

Expected output within ~15 seconds:

```
Registry: Supabase (persistent)
Pool primed. Split txid: …
Swarm started with 3 agent(s)
Team mode ON: every funded offer will dispatch writer + director + storyboard + composer in parallel
[PitchVerifier] watching bct_pitches → <your address> (min 1000 sats)
[SWARM ✓] spielbergx: Minted presale token SPIELB001 for offer-… tx …
[SWARM ✓] vcx: Subscribed to offer-… with 2500 sats (on-chain) tx …
[SWARM ✓] capitalk: Subscribed to offer-… with 2500 sats (on-chain) tx …
…
[AGENT ✓] spielbergx-writer: writer for offer-…: text via grok-3-mini tx …
[AGENT ✓] spielbergx-director: director for offer-…: text via grok-3-mini tx …
[AGENT ✓] spielbergx-storyboard: storyboard for offer-…: image via z-image/turbo tx …
[AGENT ✓] spielbergx-composer: composer for offer-…: audio via music-gen tx …
```

Let it run for ~2 minutes. You should see several productions cycle through.

### 10. Verify the result

In a second terminal:

```bash
pnpm agents:validate --since-minutes 5
```

Expected:

```
offer-…  "<title>"  [producing]
  artifacts: 4 total, 4/4 roles present
  verdict: ✓ TEAM DISPATCH SUCCESS — all four roles delivered
```

Visit `https://bmovies.online/leaderboard.html` (or your local Vercel preview) — your new productions should appear at the top with W/D/S/C role badges filled in.

## What you just did

- Funded four autonomous agents with real BSV on mainnet
- Watched them propose, finance, and produce short films end-to-end
- Every mint, subscription, and artifact payment is a real verifiable BSV tx
- The full pipeline (bct_offers → bct_subscriptions → bct_artifacts) is persisted and browsable from any device

## Next steps

- Browse productions at `https://bmovies.online/productions.html` and click into any film's offer page
- Open the Watch page to play back a finished production (100-sat paywall via BRC-100)
- Pitch your own film from the landing-page widget (four tiers: Sketch / Demo / Feature / Blockbuster)
- Read `docs/TOKENOMICS.md` for the token-as-licence model
- Read `docs/RUNBOOK-TEAM-TEST.md` for the full operator playbook
- Read `docs/PHASE-3-PLAN.md` for the consumer UX design doc

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Registry: in-memory` instead of `Supabase (persistent)` | Env vars not loaded. Check `pnpm tsx scripts/check-env.mjs` or equivalent — `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` must be set. |
| `EADDRINUSE: 8500` on startup | A previous swarm process is still running. `lsof -ti :8500 \| xargs -r kill -9`. |
| `ARC: [465] Fees are insufficient` | The streaming pool's slots have dropped below the minimum viable balance. The runner now auto-retires bankrupt slots but you can re-prime with `--sats-per-slot 5000`. |
| `DOUBLE_SPEND_ATTEMPTED` during team dispatch | Phase 2 bug. Already fixed via sequential per-offer dispatch. Update to latest main if you're seeing this. |
| BRC-100 wallet connects via Yours instead of BSV Desktop | BSV Desktop not running or not on port 3321. Launch the desktop app, create a wallet, refresh `/wallet.html`. |
| `Replicate error (404)` on composer | Older BSVAPI version. Update your BSVAPI deployment to pick up commit `23a6278` which uses the 2-step version lookup flow. |
| Financier subscriptions show `—` in the Payment column | Phase 2 bug, fixed in commit `e5c7c37`. Re-run with latest main; existing rows from before the fix won't backfill. |

## Getting help

- Issues: https://github.com/b0ase/bmovies/issues
- Author: https://b0ase.com
- Phase 3 plan: `docs/PHASE-3-PLAN.md`
- Tokenomics: `docs/TOKENOMICS.md`
