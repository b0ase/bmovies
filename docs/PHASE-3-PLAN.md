# bMovies Phase 3 — BRC-100 App for the Metanet App Catalog

> Rewritten 2026-04-11 after research into BSVA hackathon criteria,
> the BRC-100 wallet interface, the Metanet App Catalog, and the
> NPGX sibling project.
>
> **Original Phase 3 plan (committed as `ed5db8f`) was aimed at the
> wrong target.** It assumed a conventional web-app UX with paste-txid
> payments. The actual target is a **BRC-100 app listable in the
> Metanet App Catalog** (MetanetApps.com), talking to a BRC-100 wallet
> (BSV Desktop / Metanet Client / Yours Wallet) over a vendor-neutral
> interface. This is a substantially different product.

## What the research told us

### BSVA "Open Run Agentic Pay" hackathon criteria
- **Scale**: ≥ 1.5 million transactions in a 24-hour window. Must be
  "meaningful to app functionality" — artificial inflation
  disqualifies. Phase 2 proved 19 TX/s sustained = ~1.65M/24h, so
  we already satisfy the scale requirement via the streaming loop.
- **Wallet standard**: Agents discover each other using **BRC-100**
  wallets and identity. HandCash is **not** BRC-100 and therefore
  out of scope.
- **Payment standard**: BSV micropayments via BRC-0105 (HTTP Service
  Monetization Framework) — same standard BSVAPI already uses.
- **Distribution**: Apps are listed in the **Metanet App Catalog**
  at MetanetApps.com. Not a phone store, not a web brochure — a
  catalog of apps that run against a BRC-100 wallet.
- **Prize pool**: $10,000.

### BRC-100 wallet interface
- Unified vendor-neutral interface between a wallet and an app.
- Built on BRC-42 (key derivation), BRC-2 (encryption), BRC-3
  (signatures), BRC-29 (payment keys), BRC-62 (BEEF), BRC-67 (SPV).
- BSV Desktop exposes the interface on `localhost:2121` as HTTPS.
- Any app calling `createAction` etc. through this interface works
  with **every** BRC-100 wallet: BSV Desktop, Metanet Client, Yours
  Wallet, future wallets.
- The app **never holds or touches private keys**. Signing and
  broadcasting happen in the wallet, not the app.
- This is the Web3 model, ported to BSV: the app is a pure frontend,
  the wallet is the trust boundary.

### Metanet App Catalog
- Renamed from "Metanet Desktop" to **BSV Desktop** in Dec 2025.
- Apps in the catalog are built with Babbage developer tools and
  follow the BRC-100 standard.
- Current apps include on-chain polls, to-do lists, a marketplace,
  proof-of-existence tools, utilities, social, gaming.
- Distribution is decentralised — MetanetApps.com is a window into
  public data on-chain, not a gatekept storefront.
- **This is where bMovies should live.**

### NPGX patterns worth stealing
(Explored at `/Volumes/2026/Projects/npgx`.)

1. **Tiered commissioning model**: $49 / $99 / $199 / $9.99-99/mo.
   Clean UX — user picks a tier and pays, no custom negotiation.
2. **Revenue split cascade**: every viewer payment fans out
   automatically across five levels of token holders via on-chain
   piece payments. No platform cut at the root level — 100% goes to
   holders, platform earns at higher-level token tiers.
3. **Exchange + Watch + Token pages**: dedicated surfaces for
   browsing, watching (with paywall), and token management.
4. **`lib/brc100-wallet.ts`**: existing BRC-100 wrapper we can study
   or reuse.
5. **Paywall component** that checks token balance before unlocking.
6. **Director Agent orchestration**: one agent coordinates the whole
   production pipeline end-to-end. bMovies already does this via the
   producer + role agents — we just need to surface it better.

### NPGX patterns to REJECT
- **HandCash integration**: out of scope per the hackathon criteria.
- **Monolithic tiered browsing**: we keep the autonomous-swarm thesis
  (films propose themselves) and add tiered commissioning on top.

## Revised vision

> A BRC-100 app called bMovies, listed in the Metanet App Catalog,
> where a visitor can browse films being financed and produced by
> an autonomous agent swarm, pay sats from their BRC-100 wallet to
> watch a specific production, commission a new film at one of
> four tiers, track the production through to completion, and
> verify every step on BSV mainnet — all without touching a private
> key, pasting a txid, or running any code locally.

## Human-agent boundary

Informed by NPGX, the cleanest model is:

> **Humans commission. Agents execute. Payment IS approval.**

No human-in-the-loop. No pending-approval step. The visitor pays at
one of four tiers; the payment itself triggers the swarm. The
visitor watches the production happen autonomously and claims the
output once delivered.

Three surfaces a human interacts with:

| Surface | Action | Price |
|---|---|---|
| **Browse** | Land on bmovies.online or the app catalog entry, see active productions, read pitches | Free |
| **Watch** | Click into a specific production, pay via BRC-100 to unlock full playback | 100 sats / ~$0.016 per watch |
| **Commission** | Pitch a film idea, pick a tier, pay via BRC-100 to trigger the swarm | 100 / 1000 / 5000 / 25000 sats |

## Monetization model

### Tiered commissioning (replaces current single 5000-sat pitch)

| Tier | Price | What you get |
|---|---|---|
| **Sketch** | 100 sats (~$0.016) | Title + synopsis preview. No production. |
| **Demo** | 1000 sats (~$0.16) | BSV-21 token minted + writer treatment only. |
| **Feature** | 5000 sats (~$0.80) | Full four-role team: writer + director + storyboard + composer |
| **Blockbuster** | 25000 sats (~$4) | Feature + extended runtime, premium upstream models |

Prices shown in sats AND USD in the UI.

### Watch-gate (new)

Every production has:
- **Free preview**: title, ticker, 10-second treatment excerpt.
- **Full watch**: unlocks writer treatment, director shot list,
  storyboard image, composer audio player — cinematic sequence.
- **Price**: 100 sats flat per watch.

Payment cascade for each watch:
- **80 sats** to content token holders, split pro-rata by balance
- **20 sats** to producer treasury (operating cost)

(Simpler than NPGX's 5-tier cascade; we'll add more tiers in Phase 4
if we ship a parent token like `$BMOVIES`.)

### Secondary market
Out of scope for hackathon. Tokens are BSV-21 so they're already
transferable by any BSV-21 compatible wallet.

## Non-goals (explicitly deferred)

- HandCash integration (not BRC-100 compliant — out of scope)
- Account system / login / persistent identity (BRC-100 identity
  provides this automatically)
- Real video playback (stills + audio + text cycling is what the
  swarm produces)
- WebTorrent playback in browser (Electron client remains the path)
- Phone app (MetanetApps.com lists web apps the BRC-100 wallet
  launches; no native app required)
- Internationalisation (English only)
- WCAG audit (reasonable semantic HTML only)
- `app.html` — removing it from the nav since it misleads visitors
  toward a localhost-only Electron flow

## Current state recap (post Phase 2)

- Swarm proven end-to-end: 3/3 productions delivered with 4/4 role
  coverage in the 2026-04-11 live test.
- Streaming fee bug fixed (slots retire before bankruptcy).
- Brochure pages layout-aligned and nav-consistent.
- Pay-to-register flow works with paste-txid (to be replaced).
- 150/150 tests passing, 0 typecheck errors.
- Screenshots saved as `productions-proof.png` / `leaderboard-proof.png`.

## Task tiers

### Tier 0 — must ship (3 days, core submission blockers)

| # | Task | Est |
|---|---|---|
| P3-1 | BRC-100 wallet connect + pay primitive (shared library) | 5h |
| P3-2 | Tiered pricing UI (Sketch/Demo/Feature/Blockbuster) | 3h |
| P3-3 | Per-offer deep-link page (`/offer.html?id=...`) | 4h |
| P3-4 | Rich artifact rendering helpers (shared) | 3h |
| P3-5 | Watch page with paywall gating (`/watch.html?id=...`) | 5h |
| P3-6 | Revenue split visualization component | 2h |
| P3-7 | Pitch status tracking page (`/pitch.html?id=...`) | 3h |
| P3-8 | Landing page 60-second hook rewrite | 2h |

**Tier 0 total: 27 hours.** This is 4-4.5 days at ~6h/day, leaving
1.5 days for Tier 1 + tests + submission prep.

### Tier 1 — should ship (1 day)

| # | Task | Est |
|---|---|---|
| P3-9 | Mobile responsive pass | 3h |
| P3-10 | Nav cleanup (remove app.html, add Watch) | 0.5h |
| P3-11 | Real Grok refinement via BSVAPI pooled wallet | 3h |
| P3-12 | Metanet App Catalog submission manifest | 2h |

**Tier 1 total: 8.5 hours (~1.5 days).**

### Tier 2 — stretch (cut if behind)

- **P3-STRETCH**: Agent identity page + live activity ticker (4h)
- On-chain proof panel (merged into P3-3 as standard section)

### Tier 3 — pre-submission

- **P3-13**: Developer quickstart doc + BSVA submission draft (2h)
- **P3-14**: Final live test + screenshot bundle (1.5h)

## 6-day execution schedule

### Day 1 — Friday 2026-04-11 (today, evening)
- P3-1 BRC-100 wallet connect library (5h)
- *Learning curve budgeted into this one. First BRC-100 integration.*

### Day 2 — Saturday 2026-04-12
- P3-2 Tiered pricing UI (3h)
- P3-4 Rich artifact rendering helpers (3h)
- P3-3 start per-offer page (2h)

### Day 3 — Sunday 2026-04-13
- P3-3 finish per-offer page (2h)
- P3-7 Pitch status tracking page (3h)
- P3-5 start Watch page (2h)

### Day 4 — Monday 2026-04-14
- P3-5 finish Watch page (3h)
- P3-6 Revenue split visualization (2h)
- P3-8 Landing hook rewrite (2h)
- **End of Day 4: Tier 0 complete.**

### Day 5 — Tuesday 2026-04-15
- P3-9 Mobile responsive pass (3h)
- P3-10 Nav cleanup (0.5h)
- P3-12 Metanet App Catalog manifest (2h)
- P3-11 Real Grok refinement (3h if time)
- **Feature freeze at end of day**

### Day 6 — Wednesday 2026-04-16
- P3-14 Final live test + screenshots (1.5h)
- P3-13 Quickstart + submission draft (2h)
- Mobile test on a real phone (1h)
- Final buffer (2h)

### Day 7 — Thursday 2026-04-17 (submission day)
- Morning: final review
- Submit by noon
- Buffer until 23:59 deadline

## Cut sequence if behind

In order:
1. **P3-STRETCH** (agents page + ticker) — cut first
2. **P3-11** (real Grok refinement) — template still demos
3. **P3-6** (revenue split viz) — swap for a text summary
4. **P3-12** (app catalog manifest) — deferred to Phase 4
5. **P3-9** (mobile pass) — desktop-only submission

Tier 0 (P3-1 through P3-8) is the floor. Cutting into Tier 0 means
we delay the submission.

## Execution principles (unchanged from v1)

1. One task per atomic commit.
2. Every commit passes `pnpm vitest run` + `pnpm tsc --noEmit`.
3. No task declared done without a visible URL on bmovies.online.
4. Cap each task at +50% of estimate.
5. Fix every error in the moment, never classify as pre-existing.
6. Submission text written Day 6, not Day 7.
7. Screenshots committed after every Tier 0 task.

## Risk matrix (updated)

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| **BRC-100 learning curve eats Day 1** | High | High | Day 1 is explicitly the BRC-100 day; can extend into Day 2 if needed by cutting P3-11 |
| BRC-100 client library is immature / broken | Medium | High | Fall back to paste-txid for hackathon, document BRC-100 intent, ship anyway |
| BSVAPI Vercel redeploy breaks production | Low | High | Review previews before promoting |
| Watch page payment cascade bug loses sats | Medium | High | Test exhaustively on Day 4, unit tests for splitFanOut |
| Day 1 scope creep | Medium | Medium | Strict +50% cap |
| Typecheck / test regressions cascade | Low | Medium | Run full suite before every commit |

## Definition of done (the submission)

All of these must be true before we send:

- [ ] BRC-100 wallet connect works — payments flow without paste-txid
- [ ] Four tier prices visible and callable
- [ ] Per-offer deep-link page renders every field
- [ ] Watch page plays a cinematic sequence after paywall unlock
- [ ] Pitch status page tracks a pitch through to producing
- [ ] Landing page hooks in 60 seconds
- [ ] Revenue split visualized for every watch payment
- [ ] Nav clean (app.html removed, Watch added)
- [ ] Mobile responsive verified on real phone
- [ ] Metanet App Catalog manifest ready
- [ ] Fresh live test done in last 24 hours
- [ ] Screenshots committed in `docs/submission/`
- [ ] Submission text draft in `docs/submission/draft.md`
- [ ] 150+ tests passing
- [ ] 0 typecheck errors
- [ ] Main branch clean and pushed

## Open questions for the operator

1. **Should the Sketch tier (100 sats) actually produce anything?**
   I lean toward "yes, a minted BSV-21 token + synopsis, but no team
   dispatch". That way every tier produces SOMETHING on-chain.

2. **Watch gate price: 100 sats flat, or scaled by tier?**
   Simpler = 100 sats flat. Blockbusters being more expensive to
   watch would be more realistic but adds UX complexity.

3. **Revenue split ratio: 80/20 or something else?**
   NPGX uses 100/0 at the root and earns via parent tokens. We don't
   have a parent token yet, so 80/20 keeps the producer agent funded.

4. **Should we ship without BRC-100 if Day 1 goes badly?**
   I recommend: try BRC-100 seriously for 1 full day; if it's not
   working by end of Day 1, fall back to paste-txid for hackathon and
   note BRC-100 as future work. The core thesis (autonomous agents
   making films on BSV) still holds.

5. **Commission price and quality discovery**
   Do we expose "actual cost" of each tier to BSVAPI? Transparency
   would be good ("this Feature cost us 4200 sats upstream, we
   charge 5000 for 15% margin"), but it's an extra feature.
