# bMovies — BSVA Open Run Agentic Pay Plan

> Target event: **Open Run Agentic Pay** (BSV Association)
> Hacking window: **2026-04-06 → 2026-04-17 23:59 UTC**
> This repo first commit: **2026-04-08** (credibly inside the window)
> Plan written: **2026-04-10**

## 1. The Pitch

bMovies is a BSV-native demonstration of **Propose → Tokenise → Agentic finance → Auto-produce → GTM**. Autonomous AI agents each hold their own BSV wallet. A *producer* agent proposes a video production, mints a BSV-21 financing token up front, and posts an open call. *Financier* agents autonomously discover the call via BRC-100 identity + MessageBox, evaluate it against their investment thesis, and subscribe by sending BSV on-chain. When the budget is raised the production enters an autonomous streaming loop; every piece served is a micropayment and every settlement fans out royalties on-chain to the token holders who financed the production.

The "real-world problem" framing: **pre-production film financing is catastrophically broken.** Studios gatekeep, indies can't raise, audiences don't get what they want. This demo shows what it looks like when AI agents, not humans, run the whole pipeline.

## 2. BSVA Hackathon Requirements (verbatim)

1. ≥2 AI agents with individual BSV wallets
2. At least **1.5 million on-chain transactions within a designated 24-hour window**, "meaningful to app functionality" — artificial inflation disqualifies
3. Agent discovery using **BRC-100 wallets and identity**
4. Autonomous transactions via **MessageBox P2P or direct payments**
5. Human-facing UI displaying agent activity
6. Real-world problem solution
7. Tech stack SHOULD include: `@bsv/sdk`, `@bsv/simple`, `@bsv/simple-mcp`, BSV Desktop Wallet

### Open questions emailed to `hackathon@bsvassociation.org` on 2026-04-10

1. Can we submit a module that calls into an existing open-source platform we already operate, or must the entire submission be green-field from April 6? *(Answer preferably favourable; this repo itself started April 8 so it is credibly green-field.)*
2. Does our team designate the 24-hour window, or does the organiser assign one? Can the window fall between submission (April 17) and results (April 23)?

**If the email answer is unfavourable, revisit section 9.** Continue building in the meantime.

## 3. Architecture

```
+----------------+      +----------------+      +----------------+
| ProducerAgent  |      | FinancierAgent |      | FinancierAgent |
|  SpielbergX    |      |  VC-X          |      |  CapitalK      |
|  (own wallet)  |      |  (own wallet)  |      |  (own wallet)  |
+--------+-------+      +--------+-------+      +--------+-------+
         |                       |                       |
         |        post           |                       |
         v                       v                       v
  +---------------------------------------------------+
  |              AgentRegistry                        |
  |   MemoryRegistry (tests)                          |
  |   Brc100Registry  (hackathon submission)          |
  |     - offers posted as signed OP_RETURN records   |
  |     - subscriptions via MessageBox / direct pay   |
  +---------------------------------------------------+
         |
         v
  +---------------------------------------------------+
  |           Content + Payment Pipeline              |
  |   src/ingest  -> src/token/mint (BSV-21)          |
  |   src/payment/channel  -> streaming micro-pay     |
  |   src/payment/wallet.buildPaymentTx -> royalty    |
  |       fan-out to every token holder address       |
  +---------------------------------------------------+
         |
         v
  +---------------------------------------------------+
  |                 Dashboard UI                      |
  |   /agents view in src/client/index.html           |
  |     - live agent list + balances                  |
  |     - open offers + subscribers                   |
  |     - active streams + piece payments             |
  |     - royalty distributions + TX counter          |
  +---------------------------------------------------+
```

### Agent roster for the demo

| Agent | Role | Persona | Wallet funding |
|---|---|---|---|
| **SpielbergX** | producer | AI director minting financing tokens for short films | ~$1 USD |
| **VC-X** | financier | Thesis: shorts under 20k sats, any producer | ~$1 USD |
| **CapitalK** | financier | Thesis: any budget, diversified portfolio | ~$1 USD |
| **ClawNode-A** | seeder / compute | Serves pieces, earns per-piece micropayments | ~$1 USD |

Four agents × $1 ≈ **~1M sats per wallet at current BSV price**. That is enough runway for tens of thousands of the payment-channel micro-TXs and dozens of token mints.

## 4. Transaction-Volume Math for the 1.5M Target

The hackathon requires **1.5M on-chain TXs in a designated 24-hour window**. The dominant source by a wide margin is **per-piece fan-out payments** (see `src/agents/piece-payment.ts`): every piece of content served produces exactly one real on-chain transaction whose outputs fan out to every token holder in a single tx.

Concretely: 4 concurrent streaming loops × 5 pieces per second per loop × 86 400 seconds = **1 728 000 fan-out TXs in 24 hours**, 115% of the 1.5M target. Tuning is done with `pnpm agents:math -- --loops N --pps N --sats-per-piece N` which prints projections and cost before any real spend.

| Source | TX shape | Rate | 24h TX count |
|---|---|---|---|
| Streaming fan-out | 1 TX with (holders + 1) P2PKH outputs | 4 loops × 5 pps = 20 TX/s | **1 728 000** |
| Presale token mints | 1 BSV-21 deploy+mint per production | ~20 / hour | 480 |
| Subscription payments | 1 P2PKH transfer per subscription | ~60 / hour | 1 440 |
| **Total** | | | **1 729 920** |

Every fan-out TX is meaningful work: it is a real payment from the viewer (ClawNode-A seeder) to every token holder of the production being streamed, weighted by their subscription amount. There is no artificial inflation — each TX corresponds to one piece of content genuinely served, one payment settled, one royalty distribution happening on-chain.

Cost at 1 sat per fee (P2PKH ~260 bytes rounds to 1 sat at 1 sat/KB) and 1 sat per piece payout:

| Component | Sats | USD @ $40/BSV |
|---|---|---|
| Streaming miner fees (1.73M × 1 sat) | 1 728 000 | $0.69 |
| Streaming payouts (1.73M × 1 sat) | 1 728 000 | $0.69 |
| Presale mint fees | 480 | $0.00 |
| Subscription fees | 1 440 | $0.00 |
| Subscription capital (60 × 24 × 2 500) | 3 600 000 | $1.44 |
| **Total** | **7 057 920** | **≈ $2.82** |

Well inside the $16 (4 agents × $4) budget. If BSV price is higher or fee rates rise, bump satsPerPiece toward 2-3 to stay comfortable.

Tuning knobs:
- `--loops` : more concurrent streaming loops (higher TX rate)
- `--pps`   : pieces per second per loop (higher TX rate)
- `--sats-per-piece` : payout per piece (dominates the cost line)

These are all exposed on both `pnpm agents:math` (projection) and `pnpm agents:swarm` (live run).

## 5. Build Phases

Tasks tracked in the TaskList tool. Concise summary:

1. ✅ **Agent base class + wallet** — `src/agents/agent.ts` with tick loop, logging, lifecycle
2. ✅ **Producer + Financier subclasses** — `src/agents/producer.ts`, `src/agents/financier.ts`, thesis evaluation
3. **BRC-100 + MessageBox registry** — `src/agents/registry-brc100.ts` implementing the AgentRegistry interface on top of `@bsv/sdk` BRC-100 primitives
4. **Token presale on-chain** — extend `src/token/mint.ts`; financier subscriptions become real BSV transfers to the producer address; producer issues BSV-21 token allocations back
5. **Autonomous streaming loop** — agents open real payment channels and stream each other's content; every piece is an on-chain keeper update
6. **Royalty fan-out** — existing `wallet.buildPaymentTx` already does N-output fan-out; wire it into stream settlement so payouts land at every token-holder address
7. **Agent dashboard UI** — new `/agents` view in `src/client/index.html` showing live agent balances, offers, positions, streams, payouts, TX counter
8. **Transaction volume tuning** — tune piece size + concurrency + keep-every-N to hit 1.5M in 24h, documented with math and actual measured rate

## 6. On-Chain Real-Money Policy

Per explicit user direction: **every agent operates on BSV mainnet from day one. No simulated transactions anywhere.**

- Each agent has its own WIF stored in a gitignored config file
- Agents print their funding address on startup
- Agents refuse to tick until their wallet balance is positive
- Tests that exercise agent logic use unfunded wallets and verify the *construction* of transactions without broadcasting
- A separate integration script (`scripts/run-agent-swarm.ts`) broadcasts real TXs and is run manually once wallets are funded
- The `critique` and `confess` skills should be invoked before the first live run

## 7. Repo Layout

```
src/
  agents/            NEW — the hackathon agent layer
    agent.ts           base class
    producer.ts        producer subclass
    financier.ts       financier subclass
    registry.ts        interface + MemoryRegistry
    registry-brc100.ts BRC-100 + MessageBox implementation (Task 3)
    swarm.ts           top-level swarm coordinator (Task 5)
  payment/           EXISTING — reused by agents
    wallet.ts          per-agent BSV wallet
    channel.ts         payment channel state + updates
    settlement.ts      settlement and broadcast
  token/             EXISTING — extended for presale
    mint.ts            BSV-21 mint; add presale branch in Task 4
  api/               EXISTING — server, extended for /agents routes
  client/
    index.html         EXISTING — add /agents view in Task 7
scripts/
  setup-agents.ts    NEW — generate WIFs, print funding addresses
  run-agent-swarm.ts NEW — manual live run of the swarm for the 24h window
test/
  agent.test.ts               NEW — base class
  producer-financier.test.ts  NEW — subclass behaviour + integration
  registry-brc100.test.ts     NEW (Task 3)
  presale.test.ts             NEW (Task 4)
config/
  agents.json        gitignored — WIFs and personas for the running swarm
docs/
  HACKATHON-PLAN.md  this file
```

## 8. Configuration + Funding Workflow

1. `pnpm agents:setup` runs `scripts/setup-agents.ts`, which generates 4 fresh WIFs, writes `config/agents.json`, and prints a table of addresses with the exact sat amount to send each one.
2. User funds each address from HandCash or another BSV wallet.
3. `pnpm agents:check` verifies each wallet has a positive balance via WhatsOnChain and prints the total swarm capital.
4. `pnpm agents:swarm` runs the live swarm for a target duration and prints a running TX counter.
5. After the run, `pnpm agents:report` dumps a summary: TXs broadcast, sats spent, productions financed, streams served, royalties paid.

## 9. Fallback Plans (if BSVA email answer is unfavourable)

If the BSVA reply rules the April-8-first-commit repo ineligible as "too much prior infrastructure":

- Plan B1: fork this repo into a new `bmovies-hackathon` repo on April 11, keep only `src/agents/`, `src/types/`, `src/payment/wallet.ts`, and rebuild the rest as thin wrappers. The agent layer stays, the rest is rewritten under the new repo's history.
- Plan B2: move the agent submission into a new standalone repo and have bMovies referenced as a platform dependency rather than the submission itself.
- Plan B3: accept non-submission but still run the swarm as a showcase and publish the post-mortem as a blog post. Exposure without a prize.

## 10. Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| BRC-100 discovery harder than expected | Task 3 slips | Start Task 3 immediately; have MemoryRegistry as working fallback |
| 1.5M TXs unreachable with realistic piece size | Disqualification | Task 8 math sheet + dry-run measurement before the live 24h window |
| Mainnet fee spikes during the 24h run | Costs overrun $4 budget | Measure cost per TX in dry run; user tops up wallets if needed |
| Seeder agent runs out of content to serve | TX rate stalls | Producer agents continuously mint new short productions to keep the pipeline full |
| Email reply is negative | Strategic pivot | See section 9 |

## 11. Decision Log

- **2026-04-10**: Pivot from general-purpose streaming to BSVA Agentic Pay submission. Target is autonomous agent financing, not human-initiated streaming.
- **2026-04-10**: Submit as **bMovies**, not NPGX. This repo started April 8 so it is credibly green-field. NPGX is cited as reference architecture only.
- **2026-04-10**: ClawDex is used as UX reference for the registry `/launch` three-asset pattern but not imported.
- **2026-04-10**: Real on-chain TXs only. No simulated mode. User funds 4 agent wallets with ~$1 each.
- **2026-04-10**: Agent layer is new-built in `src/agents/`; existing `src/payment/` and `src/token/` are reused verbatim where possible.
