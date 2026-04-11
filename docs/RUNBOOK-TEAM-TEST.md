# Runbook — End-to-end live test of team-mode + visitor pitches

> Use this runbook to drive the live test of Phase 2 against the
> Hetzner-hosted Supabase and BSV mainnet. Everything below spends
> real BSV — small amounts, but real. Read every command before you
> run it.

**Owner:** operator on the box where `config/agents.json` lives
**Estimated runtime:** 15 minutes (5 to launch, ~10 to observe)
**Estimated spend:** ~5,000 sats per offer cycle (4 BSVAPI calls + 1 mint + 4 subscriptions)

---

## Pre-flight checklist

Before launching anything:

- [ ] `config/agents.json` exists on the runner host with funded
      producer + financier wallets (each ≥ $1 worth of BSV)
- [ ] BSVAPI hot wallet funded with enough sats for 4 generations
      per cycle (z-image/turbo is ~$0.01 each, so ~$0.05/cycle)
- [ ] `SUPABASE_URL=https://api.b0ase.com` set in the runner shell
- [ ] `SUPABASE_SERVICE_ROLE_KEY=…` set in the runner shell
- [ ] (Optional, only if you want the pay-to-register flow live)
      `PITCH_RECEIVE_ADDRESS=…` set to a real BSV address you
      control, AND `docs/brochure/pitch-config.json` updated with
      the same address, AND a fresh Vercel deploy
- [ ] Latest main pulled: `git pull origin main && pnpm install`
- [ ] All migrations applied to Hetzner:
      ```
      ssh hetzner "docker exec -i supabase-db psql -U postgres -d postgres" \
        < supabase/migrations/0001_init.sql
      # … 0002, 0003, 0004 too if not already applied
      ```
- [ ] `pnpm vitest run` shows 149/149 passing

---

## Launch sequence

### 1. Clear baseline (optional but useful for clean validation)

If you want a clean slate so the validation script only sees
artifacts from this run:

```bash
ssh hetzner "docker exec -i supabase-db psql -U postgres -d postgres" <<'SQL'
TRUNCATE bct_artifacts, bct_subscriptions, bct_offers, bct_pitches RESTART IDENTITY CASCADE;
SQL
```

Skip this if you want history preserved — the validation script
filters by `--since-minutes` instead.

### 2. Start the swarm in team mode

In a long-running terminal (tmux / screen):

```bash
cd /path/to/bmovies
pnpm agents:swarm -- \
  --team \
  --bsvapi https://www.bsvapi.com \
  --bsvapi-image-model z-image/turbo \
  --arc \
  --max-offers 1
```

What you should see in the first 30 seconds:

- `Registry: Supabase (persistent)`
- `Pool primed. Split txid: …` (UTXO pool ready for streaming)
- `Swarm started with N agent(s)`
- `Team mode ON: every funded offer will dispatch writer + director + storyboard + composer in parallel`
- `[PitchVerifier] watching bct_pitches → … (min 1000 sats)` (only if PITCH_RECEIVE_ADDRESS is set)

If any of those lines are missing, fix the env and restart before
proceeding.

### 3. Watch the producer post + finance the first offer

Within 1–2 ticks (~30s) the producer agent posts an offer. Within
another tick the financiers subscribe enough sats to fund it.
Look for:

- `Minted presale token … for offer-…` — BSV-21 token minted on chain
- `Subscribed to offer-… with N sats (on-chain)` — financier paid in
- Status transitions to `funded` in the registry

### 4. Watch the team dispatch

Once funded, the producer dispatches all four roles in parallel.
Look for four log lines tagged with the producer id, one per role:

```
Team writer delivered text for offer-… — data:text/plain,…
Team director delivered text for offer-… — data:text/plain,…
Team storyboard delivered image for offer-… — https://…
Team composer delivered audio for offer-… — https://…
```

A line like `Team composer failed for offer-…` is acceptable if
REPLICATE is not configured upstream — the test still passes as
long as at least one role delivered.

### 5. Validate from the outside

In a second terminal:

```bash
SUPABASE_URL=https://api.b0ase.com \
SUPABASE_SERVICE_ROLE_KEY=… \
pnpm tsx scripts/validate-team-run.ts --since-minutes 10
```

Expected output:

```
Inspecting 1 offer

offer-…  "Some Title"  [funded]
  ──────────────────────────────
  funding   : 5000/5000 sats
  artifacts : 4 total, 4/4 roles present
    ✓ writer     text   grok-3-mini       tx 8a9c…
    ✓ director   text   grok-3-mini       tx 4f12…
    ✓ storyboard image  z-image/turbo     tx 1ddc…
    ✓ composer   audio  music-gen         tx 7c44…
  verdict   : ✓ TEAM DISPATCH SUCCESS — all four roles delivered
```

If composer is missing, the verdict will be `~ PARTIAL TEAM — 3/4`
which is still considered a passing test.

### 6. Verify it on the public site

Open https://bmovies.online/leaderboard.html — the new offer should
be at the top with a `W D S C` badge strip (any present roles
filled, missing ones muted). Click into productions.html and the
new offer's card should render the storyboard image, the writer
treatment text, and the composer audio player inline.

### 7. (Optional) Test the visitor pitch flow

This requires `PITCH_RECEIVE_ADDRESS` set up in step 0.

1. Open https://bmovies.online/ in an incognito window
2. Click the **Pitch a film** button
3. Type a one-liner ("A sentient lighthouse keeps a secret diary")
4. Click **Refine** — the preview block populates
5. Click **Tokenize this pitch** — the pay block appears
6. From any BSV wallet, send 1000+ sats to the displayed address
7. Paste the txid into the field and click **Submit pitch**
8. Status should flip to "Submitted ✓"
9. Within 30s the runner's PitchVerifier polls, hits WoC, and
   converts the pitch into a real bct_offers row
10. Validate with: `pnpm tsx scripts/validate-team-run.ts --pitch-id <id>`
11. Within another tick the producer mints the token and the
    financiers subscribe — same flow as autonomous offers
12. The new film appears on bmovies.online/leaderboard.html

---

## Tear-down

Press `Ctrl+C` in the runner terminal. The shutdown sequence:

```
Shutting down swarm...
Final: N TXs in S.s s | R.RR TX/s | T sats distributed
```

Pitch verifier and Supabase registry both stop cleanly. UTXO pool
slots stay funded and reusable for the next run.

---

## Failure modes and what to do

| Symptom | Diagnosis | Fix |
|---------|-----------|-----|
| `BSVAPI response did not include a content URL` | Upstream model returned an empty body | Check BSVAPI logs; rotate to a different model with `--bsvapi-image-model` |
| `Team composer failed: HTTP 500` | REPLICATE_API_TOKEN not set on BSVAPI | Either ignore (3/4 still passes) or set the token upstream and restart |
| `paid 500 sats; expected 1000` (PitchVerifier) | Visitor under-paid | Pitch is rejected with reason; visitor must resubmit with a fresh txid |
| `that txid has already been submitted` (widget) | RLS unique constraint | Tell visitor to make a new payment — txids are non-replayable |
| `[STREAM] broadcast error: too-long-mempool-chain` | UTXO pool slot exhausted | Restart with a higher `--slots` value |
| Swarm starts but no offers appear | Producer wallet has no UTXOs | Fund the producer address with a single small split tx |

---

## What "passing the test" means

The test passes if **all** of these hold:

1. The runner stays up for at least 5 minutes without crashing
2. At least one offer transitions through `open → funded → producing`
3. At least one offer has ≥ 3 of 4 role artifacts attached
4. The leaderboard page renders the new offer with a role badge strip
5. The productions page renders at least the storyboard image inline

If `PITCH_RECEIVE_ADDRESS` is configured, additionally:

6. A submitted pitch with a valid payment txid is converted to an
   offer within 60s of submission
7. The converted offer is picked up by the producer agent and
   reaches `funded` status in the same swarm session

Capture screenshots of the leaderboard and productions pages once
all of the above are true — those are the hackathon submission
artefacts.
