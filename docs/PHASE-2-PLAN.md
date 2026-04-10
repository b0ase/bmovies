# bMovies — Phase 2 Plan

> Written 2026-04-10, ~6 days before the BSVA Open Run Agentic Pay
> submission deadline (2026-04-17 23:59 UTC).
>
> The goal of Phase 2 is to turn the live agent swarm into a
> **user-facing product** — something a visitor can land on, watch
> happen, submit into, and leave having moved money. Today the
> swarm is a provable protocol and a pretty report. After Phase 2
> it is a product with an onboarding funnel and a social surface.

## Where we are coming into Phase 2

Shipped, running on mainnet, verifiable on-chain:

- `bmovies.online` live at Vercel, SSL, custom domain.
- Four-agent swarm (SpielbergX, VC-X, CapitalK, ClawNode-A) writing
  real offers, real subscriptions, real artifacts to Supabase.
- 19 TX/s sustained streaming loop through GorillaPool ARC.
- BSVAPI x402 gateway with AtlasCloud image generation and
  refundable payment verification.
- Persistent registry (`bct_offers` / `bct_subscriptions` /
  `bct_artifacts`) readable by the public `/productions.html`
  page via the Hetzner anon key.
- 140/140 tests passing, every commit pushed to
  `github.com/b0ase/bmovies`.

## What a user should experience after Phase 2

A visitor lands on bmovies.online. They see:

1. A **leaderboard** of every film the swarm is currently
   financing, ranked by sats raised, with a visible progress
   bar on each one and a click-through to its artifact (script
   excerpt, storyboard image, budget breakdown).
2. A **chat box** at the top of the page that says "pitch us a
   film". They type an idea. A Grok-backed producer walks them
   through refining the logline, picks a budget, and asks for
   a small BSV payment to commit the project to the registry.
3. After they pay, **their pitch becomes a new offer** in the
   leaderboard, alongside the swarm's autonomous ones. Anyone
   can subscribe to finance it.
4. Once funded, a **team of agents** (Director, Writer,
   Storyboard, Composer) actually produces the content in
   parallel through BSVAPI — not one producer calling one image
   model, but a coordinated team each spending their share of
   the budget on their role.

This is the story the hackathon pitch gets built around. The
technical proof is already done; Phase 2 gives the judge a UI
to walk through while reading it.

## Scope — four features + one design note

### 1. Leaderboard table + funding progress bars

**What**: a new `/leaderboard.html` page (or a prominent section
on the landing page) showing a sorted table of every offer in
`bct_offers` joined with its current artifact.

**Columns**: rank, title, producer, raised sats, target sats,
progress bar, status badge, link to artifact if any.

**Data source**: same Supabase PostgREST query the
`/productions.html` page already uses. No new backend.

**Effort**: 90 minutes of HTML/CSS + one small JOIN adjustment.

**Visible impact**: enormous. This is the first thing a visitor
sees with kinetic energy on it — numbers moving, progress bars
filling as the swarm ticks.

### 2. Funding threshold visualization on every production

**What**: on each card or row, render a progress bar that fills
as `raised_sats / required_sats` climbs. At 100% the status
badge flips from `open` to `funded` and the bar turns solid
black (already happens server-side; just needs a visual).

**Effort**: 30 minutes of CSS + a tiny JS calc. Can ride along
with feature 1.

### 3. Team-of-agents refactor (Director, Writer, Storyboard, Composer)

**What**: when a production is funded, instead of the producer
calling BSVAPI's image endpoint once, a team of role agents each
receive a share of the budget and run their role in parallel
against BSVAPI.

**Roles and their BSVAPI calls**:

| Role         | BSVAPI endpoint                 | Output            | Approx cost |
|--------------|---------------------------------|-------------------|-------------|
| Writer       | `/api/v1/chat/completions`      | Script text       | $0.01       |
| Director     | `/api/v1/chat/completions`      | Shot list JSON    | $0.01       |
| Storyboard   | `/api/v1/images/generate` × N   | Frame images      | $0.01 × N   |
| Composer     | `/api/v1/music/generate`        | MP3 audio         | $0.05       |
| **Total**    |                                 |                   | **~$0.10**  |

**Data model change**:

```sql
ALTER TABLE bct_artifacts ADD COLUMN role text;
-- existing rows get role = NULL which is fine
```

**Code changes**:

- New `src/agents/roles/` directory with `director.ts`,
  `writer.ts`, `storyboard.ts`, `composer.ts`, each extending
  the existing `Agent` base class.
- New `TeamConfig` inside `ProducerConfig` that lists the roles
  and their budgets.
- Producer `onOfferFunded` hook refactored: instead of one
  BSVAPI image call, call each role's `.execute(brief)` in
  parallel. Each role attaches its own artifact row to
  `bct_artifacts` with its `role` column set.
- The `productions.html` and leaderboard cards learn to render
  a *set* of artifacts per production — storyboard images plus
  script excerpt plus audio preview.

**Effort**: One focused day.

### 4. Pitch-an-idea chat box with pay-to-register

**What**: a fixed chat widget at the top of the landing page
(and maybe as a `/submit.html` route). User types an idea.
A Grok producer iterates on title, synopsis, budget. When
the user hits "Commit", they pay a small BSV fee to register
the project as a new offer.

**Flow**:

1. User types message → page sends to
   `https://www.bsvapi.com/api/v1/chat/completions` with a
   system prompt that turns Grok into "the bMovies producer
   AI" — job is to get a title, synopsis, 4-word pitch, and
   a budget number out of the user in as few messages as
   possible.
2. Once Grok outputs a ready-to-commit JSON blob, the chat
   flips to a commit button.
3. Commit triggers the x402 dance via the existing
   `BsvapiClient` (or a lighter browser-side wallet-connect
   flow for public users). For the hackathon demo we can
   either fake the user wallet with a preloaded demo key,
   or use the existing SigmaAuth plugin if it fits.
4. Successful payment → the browser writes a new row to
   `bct_offers` via Supabase PostgREST with the user's
   refined title, synopsis, and budget, and the producer
   field set to the user's wallet address.
5. The new offer immediately appears in the leaderboard
   alongside the swarm's autonomous offers.

**Effort**: ~half a day if we use a fake demo wallet for the
hackathon, a full day if we wire real browser-side signing.

**Visible impact**: huge. "Let me type in an idea" is the
universally-understood interaction. It's what makes the site
feel like a product rather than a demo dashboard.

### 5. Tokenomics design note (NO CODE this phase)

**Problem**: earlier brainstorming around "1 penny creates 1
billion tokens and the director gets 1%" doesn't hold up. At
a trillion-tokens-per-dollar ratio, a 1% cut is worth
$0.0000001. There is no secondary market to price-discover
these tokens against, so "inflation as capital flows in" is
not a mechanism, just a hope.

**What I'll write up instead**: a `docs/TOKENOMICS.md`
document proposing a kickstarter-style fixed-supply cap table
per production:

- Each production mints exactly N tokens (say 100,000) at
  creation time (already done — presale BSV-21 mint).
- Early participants buy at a lower sats-per-token rate than
  later participants. The curve is defined up front.
- The director / writer / storyboard agent hires are paid
  in early-tranche tokens — they get the best cap table
  position because they take the most risk (the film might
  never be funded, in which case their labour is worth zero).
- Financiers buy later-tranche tokens at a higher sats rate
  (the film is closer to being funded, the risk is lower).
- Royalties on stream payouts are pro-rata to current
  holdings, which is already how `bct_subscriptions` works.

This is standard early-stage equity dilution. It makes sense
to people because kickstarter and angel rounds have been
pricing that risk for decades.

**No code this phase.** The doc just explains the model so
we can implement it in phase 3 or post-hackathon with
confidence.

**Effort**: 90 minutes of honest writing.

## Explicit out-of-scope for phase 2

The following are good ideas but get deferred to post-hackathon
because they introduce moderation, trust, or infrastructure risk
we cannot debug in 6 days:

- **User-submitted director/writer agents**. Needs reputation,
  review, anti-spam. Park.
- **Secondary market for production tokens**. Needs an AMM or
  order book. Park.
- **Multi-language writer agents**. Park.
- **Live video generation via AtlasCloud Wan 2.2**. The async
  polling integration is real work and the images are enough
  for the hackathon. Park.
- **Real browser wallet connect via SigmaAuth**. If we can do
  it cheaply as part of feature 4 we will; otherwise the demo
  uses a preloaded wallet.

## Order of execution

One atomic commit per item. Each item stands on its own so
partial shipping is fine.

1. **Leaderboard page** — 90 min
2. **Progress bars on productions.html + leaderboard** — 30 min
3. **Role-column migration on bct_artifacts** — 10 min (SQL only,
   applied out-of-band)
4. **Role agent classes** — 2 hours
5. **Producer onOfferFunded refactor to call the team** — 1 hour
6. **Team artifact rendering on productions / leaderboard** — 1 hour
7. **Chat pitch widget on landing page** — 2 hours
8. **Pay-to-register flow** — 2 hours
9. **Tokenomics design note** — 90 min
10. **End-to-end live test of the new flow** — 1 hour

Total budget: roughly 11-12 focused hours across 2-3 sessions.

## Risks

1. **Breaking the live swarm.** Mitigation: the producer refactor
   for team-of-agents is behind a feature flag (`--team` on the
   runner). Old single-producer behaviour stays until we're sure
   the team version works.
2. **Browser wallet friction on the pitch flow.** Mitigation:
   preloaded demo wallet for the hackathon; real wallet connect
   as a post-hackathon task.
3. **BSVAPI cost blowout** if many users submit pitches.
   Mitigation: rate limit the chat endpoint per-IP; cap commit
   fees so total burn is bounded.
4. **Supabase anon write path** — currently only grants SELECT.
   The pitch commit flow needs INSERT on `bct_offers` and
   `bct_subscriptions`. Need to add a policy that lets an anon
   row in only if a valid payment txid is present. Doable but
   needs thought.
5. **Time.** If we hit day 4 and the team-of-agents refactor is
   half-done, ship the leaderboard + chat only and keep the
   single-producer path live.

## Success criteria for phase 2

By end of phase 2 the following must all be true:

- [ ] A visitor landing on bmovies.online sees at least one
      production with a visible progress bar.
- [ ] A visitor can type an idea into a chat box, iterate with
      Grok, and commit it to the registry via a real BSV payment.
- [ ] After paying, the visitor sees their own pitch as a new
      row in the leaderboard within 5 seconds.
- [ ] At least one production in the leaderboard has been
      produced by a *team* of agents (multiple artifacts,
      multiple BSVAPI calls, multiple role labels).
- [ ] `docs/TOKENOMICS.md` exists and explains the cap table
      model honestly.
- [ ] 140/140 tests (or more) still passing.
- [ ] Nothing in the existing live swarm or BSVAPI stack has
      regressed.

## Decision log

- **Team-of-agents uses parallel BSVAPI calls, not a single
  orchestrator call**, because parallelism makes the cost scale
  linearly (one tx per role), the proof-of-work is visible on
  chain for every role, and agents can be hired independently.
- **Pitch submission writes directly to Supabase from the
  browser**, because keeping a server-side API layer between the
  browser and the DB adds complexity that doesn't justify its
  cost for a read-mostly product. The RLS policy is how we
  enforce the payment requirement.
- **Tokenomics model is fixed-supply kickstarter-style**, not
  infinite-inflation, because infinite inflation is not a
  mechanism it is a hope.
- **User-submitted agents are deferred** to post-hackathon
  because moderation is a product discipline, not a weekend task.
