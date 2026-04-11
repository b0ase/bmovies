# bMovies Phase 3 — Consumer UX Plan

> Written 2026-04-11, six days before the BSVA Open Run Agentic Pay
> submission deadline (2026-04-17 23:59 UTC).
>
> **Phase 2 proved the protocol.** Autonomous agents on BSV mainnet
> can propose films, raise BSV-21 financing, dispatch a four-role
> team, commission real AI content through an x402 gateway, and
> persist everything to a public registry. Three full productions
> were delivered end-to-end in the live test on 2026-04-11 with 4/4
> role coverage each.
>
> **Phase 3 turns that protocol into a product.** The submission
> needs a first-time visitor to land on bmovies.online and understand
> the pitch in sixty seconds, see a film being financed in real time,
> click into a specific production, watch a playback of the generated
> content, pitch their own idea, and verify every claim against BSV
> mainnet — all from their browser, ideally from their phone.

## Mission statement

> A stranger with no crypto background should land on bmovies.online
> and, within five minutes, be able to: (1) understand what bMovies
> is; (2) watch a specific film get financed, produced, and played
> back; (3) verify the on-chain proof for every step; (4) submit
> their own pitch; and (5) share a specific production URL.

If a judge can do those five things on their phone without running
any code locally, the submission is done.

## Hackathon alignment

The BSVA "Open Run Agentic Pay" brief asks for autonomous agents
that move real money on a public network via x402 payments. bMovies
already satisfies the protocol half. Phase 3 makes sure the
submission also satisfies:

- **Usability**: a judge can evaluate without cloning the repo.
- **Verifiability**: every on-chain claim is one click away.
- **Narrative**: the pitch is legible on mobile in 60 seconds.
- **Novelty**: team-of-agents producing films is unique in the field.

## Non-goals (explicitly deferred)

- **Account system / login**. No persistent identity. Pitches are
  addressable by ID only.
- **Real-time streaming video**. The swarm generates stills + audio
  + treatment text, not video. A "watch" experience means cycling
  through the assets, not playing a timeline.
- **Browser-side wallet integration for human subscribers**. A
  stretch goal at the bottom of the list, skipped if behind schedule.
- **WebTorrent playback in browser**. Electron client remains the
  path for that; we will remove `app.html` from the brochure nav so
  it stops misleading visitors.
- **Internationalisation**. English only.
- **Accessibility audit**. Reasonable defaults (semantic HTML, alt
  text, contrast) but no WCAG pass.

## Current state (as of 2026-04-11, end of Phase 2)

Working and in production:

- Autonomous swarm (producer + 2 financiers + seeder) ticking on
  BSV mainnet with real on-chain txs for every action.
- BSVAPI x402 gateway at https://www.bsvapi.com proxying xAI/Grok,
  AtlasCloud z-image/turbo, and Replicate MusicGen.
- Hetzner-hosted Supabase persistent registry (`bct_offers`,
  `bct_subscriptions`, `bct_artifacts`, `bct_pitches`).
- Team-mode dispatch: writer + director + storyboard + composer
  delivering four artifacts per funded offer, sequentially, with no
  UTXO contention.
- Brochure site with six pages at https://bmovies.online:
  `index.html`, `app.html`, `tokenize.html`, `productions.html`,
  `leaderboard.html`, `bMovies-Report.html`.
- Pitch-a-film widget with pay-to-register flow writing into
  `bct_pitches` via Supabase RLS.
- PitchVerifier runs on the swarm and converts paid pitches into
  real offers once WoC confirms the payment.
- Dashboard JSON API at `:8500/api/agents/snapshot` exposing full
  swarm state for any page to query.
- 150/150 tests passing, 0 typecheck errors.
- Streaming fee bug (`ARC [465]`) fixed — pool now retires slots
  before they bankrupt themselves.

Known gaps (what this plan addresses):

- No shareable URL for a specific production.
- No way for a visitor to watch a finished production.
- Pitch submission has no confirmation or status tracking.
- Landing page does not hook in 60 seconds.
- On-chain proofs exist in the data but are not surfaced in the UI.
- Mobile layouts untested.
- Developer quickstart missing.

## Task breakdown

Tasks are organised into three tiers. Tier 0 is required for the
submission to feel like a product. Tier 1 is substantial polish.
Tier 2 is optional and cut if we fall behind.

### Tier 0 — must ship (core submission blockers)

**P3-1. Per-offer deep-link page** — 4 hours
- New file `docs/brochure/offer.html` rendering a single production
  in full detail from a query param (`?id=<offer-id>`).
- Sections: hero image, title, status/funding, 4 role artifact
  blocks, subscriber list, presale token info, on-chain proof panel
  (all tx links), "Watch this production" CTA.
- Fetches from Supabase directly via anon key (no runner needed).
- Mobile-first layout.
- **Done**: open `https://bmovies.online/offer.html?id=<real-offer>`,
  see every field, every link resolves, looks sensible on a phone.

**P3-2. Rich artifact rendering** — 3 hours
- Writer treatment: decode `data:text/plain;charset=utf-8,...` URL,
  render as a proper prose paragraph with a typographic "Treatment"
  kicker. Drop-cap on the first letter.
- Director shot list: decode `data:application/json;...`, render as
  an ordered list of shot cards, each with the shot description.
- Storyboard image: already renders as `<img>`, wrap in a
  proper framed container with aspect ratio preserved.
- Composer audio: custom-styled `<audio>` element with a black/white
  play button and a "Commissioned via BSVAPI Replicate MusicGen"
  attribution line. Link to the payment txid on WoC.
- Used on both `productions.html` and the new `offer.html`.
- **Done**: a real 4/4 production's artifacts look legible and
  designed, not like raw dumps.

**P3-3. Pitch confirmation + status tracking** — 4 hours
- After the pitch widget submits to `bct_pitches`, redirect (or
  show a link) to `/pitch.html?id=<pitch-id>`.
- `pitch.html` polls Supabase every 5s for the pitch row and shows
  a 4-step progress: `submitted → verified → converted → producing`.
- When status becomes `converted`, display the offer link so the
  visitor can click into the new production.
- Fallback: if the visitor closes the tab, the pitch URL still
  works permanently.
- **Done**: visitor submits a paid pitch, sees confirmation within
  30s, watches it progress through to a real production they can
  click into.

**P3-4. Watch / playback page** — 5 hours
- New file `docs/brochure/watch.html?id=<offer-id>`.
- Linear storytelling experience:
  1. Fade in the storyboard image as a full-screen hero
  2. Type out the title and writer treatment over the image
  3. Start playing the composer audio in background
  4. Slowly pan through the director shot list as captions
  5. End on a "Verify on-chain" call to action
- Auto-plays on open. Pause / restart controls.
- Shows the BSV-21 token info below the player.
- Falls back gracefully if any role is missing (skip that beat).
- **Done**: clicking Watch on any 4/4 production delivers a ~2-min
  cinematic mini-experience that cycles through all four artifacts.

**P3-5. Landing page 60-second hook rewrite** — 2 hours
- Replace the current hero section on `index.html` with:
  - A single-sentence pitch ("Autonomous AI agents finance films
    on Bitcoin SV and produce them on demand, all verifiable on
    mainnet.")
  - A live counter strip (Productions / Artifacts / On-chain TXs /
    Human involvement: 0) pulling from the snapshot API
  - A "Watch a film now" CTA pointing to the watch page for the
    most recent 4/4 production
  - A "Pitch a film" CTA opening the existing widget
- Drop the current 4-step "Propose / Finance / Produce / Distribute"
  cards to below the fold — they're context, not a hook.
- **Done**: someone who's never seen bMovies reads one screenful
  and understands the pitch.

**Tier 0 total: 18 hours (≈3 days of productive work).**

### Tier 1 — should ship (major polish)

**P3-6. On-chain proof panel** — 2 hours
- Collapsible section on every production page listing every tx:
  `mint SPIELB001 → [WoC]`, `subscribe vcx 2500 sats → [WoC]`,
  `artifact writer → [WoC]`, etc.
- Short explanation of what each tx represents.
- **Done**: a judge can audit a production end-to-end in one click
  from the production page.

**P3-7. Mobile responsive pass** — 3 hours
- Productions grid: 1 column below 520px.
- Leaderboard table: convert to card layout on narrow viewports.
- Landing hero: scales down cleanly without horizontal scroll.
- Pitch widget: opens as a full-screen sheet on mobile instead of
  a bottom-right panel.
- Test on a real phone.
- **Done**: bmovies.online is usable on a phone, no horizontal
  scroll, nothing cropped.

**P3-8. Developer quickstart guide** — 1 hour
- New `docs/QUICKSTART.md`: 10-step clone → install → configure →
  fund → launch → watch.
- Linked from the README and from the Report page.
- **Done**: an external developer can replicate the swarm in 30
  minutes.

**P3-9. Real Grok refinement in pitch widget** — 3 hours
- New Vercel function `api/pitch/refine` that takes a rough pitch,
  pays BSVAPI ~30 sats from a pooled wallet, returns a tagline +
  synopsis + suggested budget.
- Widget calls the endpoint instead of the template refinement.
- Pooled wallet pre-funded with 10,000 sats for the demo.
- Fallback to template if the endpoint fails.
- **Done**: visitor types a one-liner, gets back a real AI-written
  expansion, sees "refined by Grok via BSVAPI on BSV mainnet" in
  the UI.

**Tier 1 total: 9 hours (≈1.5 days).**

### Tier 2 — nice to have (polish / story)

**P3-10. Agent identity page** — 2 hours
- New `docs/brochure/agents.html` listing every agent in the swarm.
- Card per agent: name, persona blurb, role badge, BSV address
  (WoC link), current balance (pulled live from WoC), total txs
  broadcast (pulled from snapshot).
- Covers producer, financiers, seeder, and the 4 role sub-agents.
- **Done**: `/agents.html` renders a directory of every entity
  moving money on behalf of the swarm.

**P3-11. Live activity ticker** — 2 hours
- On the landing page, a cycling ticker that reads the latest
  swarm events: "🎬 Midnight Swarm funded by VC-X → ✍️ writer
  delivered → 🎨 storyboard delivered → 🎵 composer delivered".
- Polls `/api/agents/snapshot` every 5s.
- **Done**: landing page feels alive, not static.

**P3-12. Human subscribe flow** — 6 hours (stretch)
- Browser flow for a real human to subscribe to a BSV-21 offer:
  show QR code of the producer's address + required sats, visitor
  scans with HandCash, pays, pastes txid, server-side Vercel
  function verifies the payment and POSTs to the runner's agent
  registry route.
- Skipped if Tier 0 + Tier 1 run over.
- **Done**: a visitor without an existing wallet integration can
  actually subscribe to a film using HandCash on their phone.

**Tier 2 total: 10 hours (but 6 of that is the stretch).**

### Tier 3 — pre-submission

**P3-13. Final live test + screenshot bundle** — 1 hour
- Truncate Hetzner tables, run the swarm for 20 minutes, generate
  3-5 fresh 4/4 productions, screenshot every page + every artifact.
- Commit screenshots to the repo.

**P3-14. BSVA submission text** — 1 hour
- Draft the submission email/form text.
- Include: 1-paragraph pitch, link bundle, tx proof table, screenshot
  bundle, key technical differentiators.

## Execution schedule (6 days)

Each day targets 4-6 hours of productive work.

### Day 1 — Friday 2026-04-11 (today)

- Phase 2 live test ✅
- Streaming fee bug fix ✅ (shipped as `964e47f`)
- **P3-1 per-offer deep-link page** (4h)
- **P3-2 rich artifact rendering** (3h)
- *Day 1 commits: 2*

### Day 2 — Saturday 2026-04-12

- **P3-3 pitch confirmation + status tracking** (4h)
- **P3-4 watch page — build the sequence engine** (3h)
- *Day 2 commits: 2*

### Day 3 — Sunday 2026-04-13

- **P3-4 watch page — finish polish** (2h)
- **P3-5 landing page 60s hook** (2h)
- **P3-6 on-chain proof panel** (2h)
- *Day 3 commits: 3*

### Day 4 — Monday 2026-04-14

- **P3-7 mobile responsive pass** (3h)
- **P3-9 real Grok refinement endpoint** (3h)
- *Day 4 commits: 2*

### Day 5 — Tuesday 2026-04-15

- **P3-10 agent identity page** (2h)
- **P3-11 live activity ticker** (2h)
- **P3-8 quickstart guide** (1h)
- *Buffer for fixes (1h)*
- *Day 5 commits: 3 + fixes*

### Day 6 — Wednesday 2026-04-16

- **P3-13 final live test + screenshots** (1h)
- **P3-14 submission text draft** (1h)
- Review everything on mobile (2h)
- *Feature freeze at 18:00; only fixes after*

### Day 7 — Thursday 2026-04-17 (submission day)

- Final review (morning)
- Submit by noon
- Buffer until 23:59 deadline

### If we fall behind

Cuts, in order:
1. **P3-12** (human subscribe) — already labelled stretch, cut first
2. **P3-11** (activity ticker) — pretty but optional
3. **P3-10** (agents page) — pretty but optional
4. **P3-9** (real Grok refinement) — template refinement still demos
5. **P3-8** (quickstart) — can be a stub

If we cut into Tier 0, the submission is not ready and we delay.
Tier 0 is the floor.

## Execution principles

1. **One task per atomic commit.** Build → test → commit → push
   per task.
2. **Every commit passes `pnpm vitest run` and `pnpm tsc --noEmit`.**
3. **No task declared done without a visible URL on bmovies.online.**
4. **Cap each task at +50% of estimate.** If a task overruns, cut
   scope or defer to Tier 2 dropout.
5. **Submission text written Day 6, not Day 7.** No last-minute
   drafting under deadline pressure.
6. **Every error surfaced in a test / typecheck / build is fixed
   in the moment**, never classified as pre-existing.
7. **Screenshots committed to the repo** every time a Tier 0 task
   ships, so there is always a valid submission artifact on main.

## Risk matrix

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| A Phase 2 regression from new code | Medium | High | Full test run before every commit; live smoke-test after merge |
| Vercel redeploy breaks production | Low | High | Review deploy previews before promoting; keep previous deploy pinned |
| Agent wallets drain during testing | Low | Medium | Monitor balances daily; top up if <10k sats remain |
| BSVAPI upstream (Grok / Replicate) changes format | Low | Medium | Version-pin where possible; fallback paths |
| Task overruns cascade | Medium | Medium | Strict +50% cap; Tier 2 cut sequence above |
| HammerTime hook blocks a commit | Low | Low | Fix every error in the moment |
| Deadline slip | Low | High | Day 6 is the feature freeze, not Day 7 |

## Definition of done (the submission)

The submission is ready to send when ALL of these are true:

- [ ] Landing page hero rewritten, live counters working
- [ ] Per-offer deep-link pages work for every production
- [ ] Watch page plays a cinematic sequence for any 4/4 production
- [ ] Pitch confirmation page tracks a pitch through to producing
- [ ] On-chain proof panel surfaces every tx on every production
- [ ] Mobile responsive pass complete, verified on a real phone
- [ ] A fresh live test has run successfully in the last 24 hours
- [ ] Screenshots committed in `docs/submission/` folder
- [ ] Submission text draft saved in `docs/submission/draft.md`
- [ ] 150+ tests passing
- [ ] 0 typecheck errors
- [ ] Main branch clean and pushed
