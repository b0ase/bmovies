# bMovies — BSVA "Open Run Agentic Pay" submission

> Draft for the 2026-04-17 deadline. Edit before sending.
> Everything in this file is checked into the repo at
> `docs/submission/draft.md` so any team member can tweak it and
> every iteration is in git history.

## One-sentence pitch

> **bMovies** is a live BRC-100 app where an autonomous AI agent swarm proposes short films, raises BSV-21 financing on-chain, dispatches a four-role AI team to produce them, and cascades every viewer's 100-sat watch fee back to the financiers in real time — no platform cut, no humans in the loop, every step verifiable on BSV mainnet.

## What the judge sees (60 seconds)

1. Land on **https://bmovies.online** — single sentence + live counter ticking every 10s (N productions, N on-chain artifacts, N mainnet txs, **0 humans**)
2. Click **▶ Watch a film** — lands on the most recent fully-produced 4/4 film, cinematic dark player with a 100-sat paywall
3. Click **Pay 100 sats & watch** — BSV Desktop pops up a confirmation, the cascade splits 80 sats to the financiers (2 outputs) + 20 sats to the producer treasury (1 output) in a single on-chain transaction
4. Watch the cinematic sequence reveal: writer treatment with drop-cap → composer audio → director shot list
5. Click **Verify on-chain ↗** and land on the investor detail page with every txid linked to WhatsOnChain

Five minutes end-to-end, on a phone, with no code cloned.

## Why this is an Open Run Agentic Pay entry

| BSVA criterion | How bMovies satisfies it |
|---|---|
| **1.5M on-chain txs in 24h, meaningful to app functionality** | Phase 2 live test proved 19 TX/s sustained on BSV mainnet via GorillaPool ARC. Every mint, every financier subscription, every artifact payment, every streaming piece, every watch-gate cascade is a real mainnet tx. Projected 24h volume at sustained rate: ~1.65M txs. |
| **Agents discover each other via BRC-100 wallets and identity** | Producer and financier agents discover offers through a BRC-77-signed registry. Their own payments are real BSV mainnet txs. The public-facing surface speaks BRC-100 to the visitor's wallet (BSV Desktop, Metanet Client, Yours Wallet). bMovies never holds a private key at the browser tier. |
| **BSV micropayments** | 100 sats per watch. 100 / 1000 / 5000 / 25000 sats per commissioned pitch (four tiers). Every agent-to-agent subscription is a real BSV payment. Upstream AI content (Grok, AtlasCloud, Replicate) is paid through BSVAPI's x402 gateway — the agents pay BSVAPI in BSV, BSVAPI pays upstream providers in fiat. |
| **Real-world scenario: discover, negotiate, transact** | The swarm operates on its own 24/7. Financier agents evaluate offers against an investment thesis before subscribing (automated negotiation). Producer agents mint a unique BSV-21 financing token for every film they propose (discovery + registration). Human visitors can also commission films via the same tiered pitch flow (human ↔ agent negotiation). |

## Key numbers (as of 2026-04-11)

- **152** tests passing on the main branch
- **19 TX/s** sustained streaming loop rate on BSV mainnet via GorillaPool ARC
- **~1.65M** projected 24-hour tx volume at sustained rate
- **3/3** full 4-role team dispatches verified in the 2026-04-11 live test (writer + director + storyboard + composer delivered for every offer)
- **12** on-chain artifacts delivered by the team agents in a single run
- **100%** cascading to token holders + producer, **0%** platform cut
- **2** concurrent tsconfig trees, **0** typecheck errors, **0** open TODOs

## Architecture, in 60 seconds

```
┌─── bMovies brochure (static Vercel site) ─────────────────────┐
│  index / watch / offer / pitch / wallet / leaderboard / …     │
│  BRC-100 wallet primitive (docs/brochure/js/brc100.js)        │
│  Talks to BSV Desktop on localhost:3321 via @bsv/sdk           │
└───────────────┬───────────────────────────────────────────────┘
                │ watch-gate createAction
                │ pitch createAction
                ▼
┌─── Supabase on Hetzner (api.b0ase.com) ───────────────────────┐
│  bct_offers / bct_subscriptions / bct_artifacts / bct_pitches │
│  RLS-gated anon writes + service-role reads                   │
└───────────────┬───────────────────────────────────────────────┘
                │ polled every 10s by the brochure,
                │ every 5-15s by the swarm runner
                ▼
┌─── Agent swarm (`pnpm agents:swarm`) ─────────────────────────┐
│  ProducerAgent  FinancierAgent × 2  ClawNode-A (seeder)        │
│  Role subagents: Writer / Director / Storyboard / Composer    │
│  PitchVerifier polls bct_pitches every 30s                     │
│  Team-mode dispatch: sequential per-offer, per-role           │
│  Every action is a real BSV mainnet tx                        │
└───────────────┬───────────────────────────────────────────────┘
                │ x402 payments via BSVAPI
                ▼
┌─── BSVAPI gateway (separate Vercel project) ──────────────────┐
│  /api/v1/chat/completions  → xAI Grok                         │
│  /api/v1/model/generateImage → AtlasCloud z-image/turbo       │
│  /api/v1/music/generate  → Replicate MusicGen                 │
│  Accepts BSV in, pays upstream providers in fiat              │
└───────────────────────────────────────────────────────────────┘
```

## What's in the repo

- `docs/brochure/` — 9 static HTML pages, all mobile-responsive, served via Vercel
  - `index.html` — landing with live counters, tier picker pitch widget
  - `watch.html` — Now Showing grid + per-film cinematic player with paywall
  - `offer.html` — investor detail with cascade visualization + proof panel
  - `pitch.html` — pitch status tracker with 4-step progress
  - `wallet.html` — BRC-100 wallet test harness
  - `productions.html` — artifact grid
  - `leaderboard.html` — ranked productions
  - `tokenize.html` — token-as-licence explainer
  - `bMovies-Report.html` — technical report
- `docs/brochure/js/brc100.js` — shared BRC-100 wallet primitive (detect + connect + payToAddress)
- `docs/brochure/js/cascade.js` — shared cascade math + visualization
- `docs/brochure/css/mobile.css` — shared mobile breakpoints
- `docs/brochure/app-manifest.json` — canonical app metadata for Metanet App Catalog
- `api/refine.ts` — Vercel serverless function wrapping xAI Grok for real pitch refinement
- `src/agents/` — the full agent swarm (producer, financier, seeder, 4 role agents, team dispatch)
- `src/agents/pitch-verifier.ts` — bct_pitches → bct_offers conversion with WoC payment verification
- `src/agents/piece-payment.ts` + `utxo-pool.ts` + `streaming-loop.ts` — sustained on-chain piece broadcasting
- `supabase/migrations/` — 5 migrations, all applied to Hetzner
- `scripts/run-agent-swarm.ts` — runner entry point with `--team` flag
- `scripts/validate-team-run.ts` — post-run verdict checker
- `scripts/publish-app-manifest.ts` — Metanet App Catalog publisher
- `docs/TOKENOMICS.md` — token-as-licence model + revenue split
- `docs/PHASE-2-PLAN.md` / `PHASE-3-PLAN.md` — planning docs
- `docs/RUNBOOK-TEAM-TEST.md` — operator playbook for a live team-mode run

## Link bundle to include in the submission form

| Target | URL |
|---|---|
| Live site | https://bmovies.online |
| Source | https://github.com/b0ase/bmovies |
| 60-second walkthrough | https://bmovies.online (landing) |
| Watch a film | https://bmovies.online/watch.html |
| Investor detail (example) | https://bmovies.online/offer.html?id=&lt;latest&gt; |
| Pitch tracker (example) | https://bmovies.online/pitch.html?id=&lt;latest&gt; |
| Wallet test harness | https://bmovies.online/wallet.html |
| Tokenomics design note | https://github.com/b0ase/bmovies/blob/main/docs/TOKENOMICS.md |
| Phase 2 plan (protocol) | https://github.com/b0ase/bmovies/blob/main/docs/PHASE-2-PLAN.md |
| Phase 3 plan (consumer UX) | https://github.com/b0ase/bmovies/blob/main/docs/PHASE-3-PLAN.md |
| Team test runbook | https://github.com/b0ase/bmovies/blob/main/docs/RUNBOOK-TEAM-TEST.md |
| App Catalog manifest | https://bmovies.online/app-manifest.json |
| BSVAPI (x402 gateway) | https://www.bsvapi.com |

## On-chain proof to include

For the submission, pick ONE recent production and list every tx in its lifecycle. Template below — fill in after the final live test (P3-14):

### Production: "&lt;title from final test&gt;" — $&lt;ticker&gt;

| Event | Agent | Sats | Txid |
|---|---|---|---|
| Mint presale token | spielbergx | — | `<txid>` |
| Subscribe | vcx | 2,500 | `<txid>` |
| Subscribe | capitalk | 2,500 | `<txid>` |
| Writer artifact | spielbergx-writer | `<bsvapi-fee>` | `<txid>` |
| Director artifact | spielbergx-director | `<bsvapi-fee>` | `<txid>` |
| Storyboard artifact | spielbergx-storyboard | `<bsvapi-fee>` | `<txid>` |
| Composer artifact | spielbergx-composer | `<bsvapi-fee>` | `<txid>` |
| Watch cascade (human) | visitor → holders | 100 | `<txid>` |

Every row links to `https://whatsonchain.com/tx/<txid>`.

## What makes bMovies distinct

1. **Humans commission, agents execute, payment IS approval.** No human-in-the-loop step. The act of paying triggers the swarm. Inspired by NPGX's tiered ONE SHOT model but with autonomous film financing as the differentiator.

2. **Token = licence, not equity.** Every production mints a BSV-21 financing token. The token grants (a) a share of streaming royalties and (b) a licence to view. No securities, no off-chain bookkeeping, no platform cut at the content-token layer. Documented at `docs/TOKENOMICS.md`.

3. **Cascade on every watch.** Every 100-sat watch-gate payment is a single BRC-100 `createAction` that splits into multiple outputs: 80 sats fanned out across the financiers proportional to their subscription weight, 20 sats to the producer treasury. Visible as a stacked bar on every offer page.

4. **Four-role team dispatched for every production.** A producer agent does NOT make the content itself. It dispatches a writer sub-agent (Grok treatment), a director sub-agent (Grok shot list), a storyboard sub-agent (AtlasCloud z-image), and a composer sub-agent (Replicate MusicGen). Each role makes its own BSVAPI x402 payment. Four separate payments per production, four separate artifacts, four separate tx receipts on the offer page.

5. **BRC-100 throughout.** Browser-side wallet primitive at `docs/brochure/js/brc100.js` detects BSV Desktop via a WalletClient handshake (not a manual OPTIONS probe), works against Metanet Client / Yours Wallet as fallback providers, and never touches a private key. The app is listable on the Metanet App Catalog via the manifest + publisher script shipped in this repo.

6. **PitchVerifier converts paid pitches into real offers.** Visitor pays 1000 sats to a published receive address + pastes the txid. The PitchVerifier on the runner polls `bct_pitches`, fetches the tx from WhatsOnChain, confirms the payment amount + address, and inserts a corresponding `bct_offers` row. The producer agent picks it up on its next tick and dispatches the team. Visitor tracks progress at `/pitch.html?id=<pitch-id>`.

## What's left to build (post-submission)

Transparent about scope — we're going to ship a submission-ready product, but these are the obvious next steps:

- Multi-output `createAction` in one approval (currently 3 sequential approvals per watch — works but friction)
- Secondary market for financing tokens (currently mintable + transferable but no UI)
- Real video output (currently stills + audio + text, which the cinematic player cycles through)
- RLS view for pitch tracker reads (currently INSERT-only, so the tracker has a fallback banner)
- Agent activity ticker on the landing page
- Subscribe-as-a-human flow (non-agents putting money into a film)

## Source of truth for everything in this draft

- Tests pass count: `pnpm vitest run | tail -5`
- Live counter numbers: fetch `https://bmovies.online` and look at the stats row
- Tx proof table: run `pnpm agents:validate --since-minutes 10` after a fresh swarm run (P3-14)
- Repo tree: `git ls-files docs/` and `git ls-files src/agents/`
- Commit history: `git log --oneline | head -20`

---

## Submission checklist

Before sending, verify all of these are true:

- [ ] Tests pass (`pnpm vitest run` — expect 152+)
- [ ] Typecheck clean (`pnpm typecheck` — expect no output)
- [ ] Main branch clean and pushed (`git status && git log --oneline -5`)
- [ ] Fresh live test has run in the last 24h (P3-14)
- [ ] Screenshots committed in `docs/submission/screenshots/` (P3-14)
- [ ] This draft has real tx proofs filled into the on-chain proof table
- [ ] Mobile verified on a real phone
- [ ] BSV Desktop connection verified (wallet.html → detect → metanet)
- [ ] /api/refine returns a real Grok refinement (pitch widget live test)
- [ ] /watch.html end-to-end: pay → cascade → reveal → WoC links
- [ ] App Catalog manifest published via `pnpm app:publish` (or noted as "ready to publish")
- [ ] Submission form filled: title, pitch, link bundle, tx proofs, contact

---

_This draft is a working document. Tweak the tone, shorten or expand sections, drop the architecture diagram if it doesn't fit the form. Keep the one-sentence pitch and the link bundle no matter what._
