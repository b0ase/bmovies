# bMovies Tokenomics

> Design note covering the token model, capital flow, and revenue
> split for productions financed by the bMovies swarm. Phase 2
> introduces team-mode production and visitor-pitched films, both
> of which extend the existing token-as-licence model rather than
> replace it.

## Core principle: a token is a streaming licence, not equity

Every production minted by the swarm carries one BSV-21 financing
token. The token does **two** things and nothing else:

1. **It is a licence to receive royalties** while the finished film
   is streamed. Every piece served on-chain pays out per token held,
   in proportion to total supply.
2. **It is a licence to view** the production at all. The streaming
   client checks for a non-zero balance of the production's token
   before unlocking the playlist.

Tokens are **not** equity in a company, **not** a share of an LLC,
**not** a profit-share certificate. They are an access right that
happens to also collect royalties when other people exercise the
same access right. This keeps the model legally clean — closer to a
movie theatre ticket book than to a security — while still
delivering the economic effect investors care about: capital
appreciation if the film succeeds, ongoing yield while it streams,
clean liquidity on the secondary market.

## Capital flow

```
   visitor pays → bct_pitches    (Step 1: pitch registration fee)
                        ↓
                   PitchVerifier
                        ↓
                   bct_offers     (open status)
                        ↓
   financier agents subscribe    (Step 2: production capital)
                        ↓
                   bct_offers     (funded status)
                        ↓
             producer dispatches team
                        ↓
   writer / director / storyboard / composer
   each spend their slice on BSVAPI
                        ↓
               bct_artifacts × 4   (real on-chain artifacts)
                        ↓
                   streaming loop
                        ↓
       per-piece fan-out to every token holder
```

Every arrow is a real BSV mainnet transaction. The pitch fee is
paid to a single address controlled by the operator; production
capital is paid by financier agents to the producer's address;
production spend is paid by the producer (or each role wallet) to
BSVAPI; streaming royalties are paid by the viewer to every token
holder, piece-by-piece. There is no off-chain settlement and no
escrow.

## The four pots inside a production budget

When a production hits its funding target, the producer agent has
`required_sats` of raised capital sitting in its wallet. In
team-mode it splits this into four equal pots, one per role:

```
total_budget    = required_sats
writer_budget   = required_sats / 4
director_budget = required_sats / 4
storyboard_budget = required_sats / 4
composer_budget = required_sats / 4
```

Each role agent runs its own BSVAPI x402 call against its own pot:

| Role       | Upstream provider                   | Output                |
|------------|-------------------------------------|-----------------------|
| Writer     | xAI / Grok via BSVAPI chat          | Treatment (text)      |
| Director   | xAI / Grok via BSVAPI chat          | Shot list (json/text) |
| Storyboard | AtlasCloud z-image/turbo via BSVAPI | Hero frame (image)    |
| Composer   | Replicate MusicGen via BSVAPI       | Theme (audio)         |

A role failing (e.g. composer when REPLICATE_API_TOKEN is not
configured upstream) does not block the others — the production
ships with whatever the surviving roles deliver. This is enforced
by `Promise.allSettled` in `swarm.ts`.

## Revenue split

There are two distinct revenue events for any production:

### 1. Pitch fee (one-shot, on-chain)

The visitor who pitches the film pays `PITCH_MIN_SATS` (default
1000 sats) to the operator's pitch address. **100% of this fee
covers operating cost** — agent gas, BSVAPI float top-up, server.
It is not redistributed.

This fee exists to make pitching cost something. It keeps the
registry clean of spam and gives the visitor real skin in the game.
It is not a share of revenue.

### 2. Streaming royalties (continuous, on-chain)

Once the film is being served, every piece distributed by the
streaming loop fans out across the token holder set in proportion
to holdings. The split is simple:

```
piece_budget = N sats per piece (configurable)
holder_payout(h) = piece_budget × (h.balance / total_supply)
```

There is **no platform cut**. There is **no producer override**.
There is **no creator royalty** carved out of the piece budget.
100% of the piece budget goes to whoever holds the token at the
moment the piece is served.

The producer agent is rewarded indirectly: it holds a portion of
its own production's token at mint time and earns its share when
the production streams. The four role agents likewise hold a
slice of the token they helped produce. The visitor who pitched
the film is granted a small founder's allocation at conversion
time, also holding tokens that earn streaming royalties.

### Founders' allocation at mint

When the producer mints a token for a freshly converted pitch,
supply is allocated as follows:

```
total_supply = 100_000_000
producer_alloc   = 30%   (30M)  — to the producer agent's wallet
team_alloc       = 20%   (20M)  — split 5% × 4 to writer/director/storyboard/composer
pitcher_alloc    = 10%   (10M)  — to the visitor who pitched it
financier_alloc  = 40%   (40M)  — distributed to subscribers in proportion to subscription size
```

(If the production is autonomous — proposed by a producer agent
with no human pitcher — the 10% pitcher allocation is folded into
the financier pool, raising it to 50%.)

These percentages live in `src/agents/presale.ts` and can be
re-tuned without a token migration. The point of writing them down
here is so the dashboard can render an honest "where the sats
go" chart and so external observers can verify the on-chain
distribution against the documented intent.

## Why this works for the hackathon brief

The BSVA Open Run Agentic Pay brief asks for autonomous agents
that move real money on a public network. bMovies satisfies that
in three nested loops, each of which is observable on-chain:

1. **Per-pitch loop** — visitor pays sats → agent verifies on
   WoC → agent inserts an offer → producer mints a token. Every
   step is a real txid.
2. **Per-production loop** — financier agents discover offers
   via BRC-77 records, evaluate them, and subscribe in BSV.
   Producer dispatches a team, each role spends its slice on
   BSVAPI, four artifacts come back. Every step is a real txid.
3. **Per-piece loop** — viewer streams the finished film, the
   streaming loop broadcasts a fan-out tx per piece, every
   token holder gets their share. Every piece is a real txid
   (19 TX/s sustained on GorillaPool ARC).

The token is the connective tissue. It carries the licence, the
royalty right, and the audit trail. It is the smallest object
that makes all three loops cohere without an off-chain ledger.

## What is not in scope for the hackathon

- **Secondary market.** Tokens can be transferred using any
  BSV-21 wallet but bMovies does not yet ship a marketplace UI.
- **Liquidity provision / AMM.** No bonded curve, no DEX, no
  buyback mechanism. Price is set by whatever buyers and sellers
  agree on the secondary market.
- **Governance / voting.** Token holders have no on-chain say in
  what films get produced. The producer agent picks ideas from
  its productionIdeas pool and from the pitch queue.
- **Refunds for failed productions.** If a production never
  finishes (e.g. all four roles fail upstream), the token is
  still minted and tokens issued — the financiers are out of
  pocket. Phase 3 will introduce a refund script that burns
  tokens and returns proportional sats from a producer-held
  reserve.

## Where the constants live

| Constant | File | Default |
|----------|------|---------|
| Pitch fee | env `PITCH_MIN_SATS` | 1000 sats |
| Pitch receive address | env `PITCH_RECEIVE_ADDRESS` | (operator-set) |
| Producer budget per offer | `scripts/run-agent-swarm.ts` | 5000 sats |
| Financier per-subscription cap | `scripts/run-agent-swarm.ts` | 2500 sats |
| Streaming piece budget | `--sats-per-piece` flag | 10 sats |
| Pieces per second | `--pps` flag | 5 pps |
| Token supply | `src/token/presale.ts` | 100M |
| Producer alloc | `src/token/presale.ts` | 30% |
| Team alloc | `src/token/presale.ts` | 20% |
| Pitcher alloc | `src/token/presale.ts` | 10% |
| Financier alloc | `src/token/presale.ts` | 40% |

Tuning any of these is a live operations decision and does not
require a code release for the env-driven ones.
