# Dividend Governance: How Nodes Distribute Revenue to Token Holders

## The Problem

A viewer pays to stream a video. 100% of that revenue must reach token holders proportionally. But **who constructs the distribution transaction, and how do we prevent them from cheating?**

This document works through the problem from first principles and proposes an incremental solution.

---

## The Trust Chain

```
Viewer pays sats → ??? → Token holders receive proportional dividends
```

The `???` is the problem. Someone or something must:

1. **Know** who holds tokens and how many (the "snapshot")
2. **Construct** a transaction with correct output proportions
3. **Sign** that transaction (requires the private key for the revenue UTXO)
4. **Broadcast** it to the BSV network

Each of these steps is a potential point of gaming.

---

## Who Can Cheat, and How

### If the creator controls the revenue address:
- Creator sells 50% of tokens
- Revenue accumulates at their address
- Creator simply... doesn't distribute. Or distributes less.
- **Token holders have zero enforcement.**

### If a single node controls the revenue address:
- Same problem as above. "Trust the node" = "trust the operator."
- Every exchange collapse (Mt. Gox, FTX, QuadrigaCX) was a "trusted" custodian.

### If the seeder constructs the payment TX fan-out:
- Seeder (who IS a token holder in our model) builds the settlement TX
- Seeder could allocate more outputs to themselves, less to others
- Seeder could use a stale snapshot that favours them

### If a smart contract holds the funds:
- Contract enforces distribution rules
- But who provides the token holder data to the contract?
- **Oracle problem** — the contract trusts whatever snapshot it's given

---

## Key Insight: The BSV Blockchain IS the Consensus

Token holder state is **deterministic**. Every BSV-21 token transfer is an on-chain transaction. Any node that reads the same blocks will compute the same holder snapshot.

**You do not need Proof of Work for consensus on who holds tokens.** The BSV blockchain already achieved that consensus via its own PoW. You just need to read it correctly.

What you DO need is:

1. **Agreement that everyone is reading the same state** (Proof of Indexing)
2. **A mechanism that prevents anyone from spending revenue incorrectly** (enforcement)

These are different problems with different solutions.

---

## Proof of Indexing: Ensuring Nodes Agree on the Snapshot

### What it is
Every bMovies node independently indexes BSV-21 token transfers by scanning the blockchain. From this, they compute a holder table:

```
Token: $EMPRESS (tokenId: abc123_0)
Block height: 900,000

Holders:
  1ABC... → 600,000 tokens (60%)
  1DEF... → 300,000 tokens (30%)
  1GHI... → 100,000 tokens (10%)

Merkle root: 0x7f3a...
```

The merkle root is a single hash that summarises the entire holder state at a given block height. If two nodes compute the same merkle root, they agree on the state.

### How nodes sync
- Nodes gossip their snapshot merkle roots via LibP2P (existing infrastructure from path402)
- If your root matches the majority, you're in sync
- If it doesn't, you re-index from the blockchain

### Does this need PoW?
**No.** The state being indexed IS the output of PoW (BSV blocks). Reading it is deterministic. Two honest nodes will always arrive at the same merkle root for the same block height.

PoW would be needed if nodes were **creating new state** (like deciding distribution amounts). But they're not — the distribution amounts are determined entirely by the token holder snapshot, which is determined entirely by the blockchain.

**Proof of Indexing is a verification mechanism, not a consensus mechanism.** It proves you've done the work of reading the chain correctly. It does NOT create new truth — it confirms existing truth.

### Where HTM ($402) fits
The $402 protocol's HTM token already uses Proof of Indexing for exactly this purpose: nodes prove they've correctly indexed content by submitting merkle proofs. The same infrastructure can prove correct indexing of BSV-21 token holders.

---

## Enforcement: Preventing Incorrect Distribution

Knowing the correct snapshot is necessary but not sufficient. You also need to **enforce** that funds are spent according to the snapshot.

### Option 1: Direct Fan-Out (no custody)

The settlement transaction itself pays token holders directly. No money is ever "held" by anyone.

```
Settlement TX:
  Input: [viewer's funding UTXO]
  Output 0: 600 sats → holder 1ABC... (60%)
  Output 1: 300 sats → holder 1DEF... (30%)
  Output 2: 100 sats → holder 1GHI... (10%)
```

**Who constructs this?** The leecher (viewer's node). They query the token holder snapshot, build the TX, sign it.

**Can the leecher cheat?** The leecher is the one PAYING. They have no incentive to misallocate — the total amount is the same regardless of distribution. They just want to watch the video.

**Can the seeder cheat?** The seeder holds the signed settlement TX and broadcasts it at channel close. They cannot change the outputs because the TX is already signed by the leecher. They can only broadcast it as-is or not at all.

**Limitation:** Breaks down with many holders (too many outputs per TX). At 10,000 holders, the TX is ~340KB and expensive. Solution: use this for small holder counts, switch to accumulation for large counts.

### Option 2: Accumulation + Batched Distribution

Revenue accumulates at a revenue address. Periodically, a distribution TX fans out to holders.

```
Step 1 (many times): settlement TXs pay to revenue address
Step 2 (periodically): distribution TX fans out from revenue address to holders
```

**Who controls the revenue address?** This is the hard question.

#### 2a: Creator-controlled with transparency

- Creator controls the key
- All revenue is publicly visible on-chain
- Nodes monitor the address and publish reports on whether distribution happened correctly
- If creator doesn't distribute, their **reputation** is damaged and token price drops
- **Enforcement: social/economic, not cryptographic**

This is how most real-world dividend systems work. Companies can theoretically not pay dividends. The enforcement is market/legal, not technical.

**Sufficient for:** early stage, single creator, high trust

#### 2b: Threshold multisig (node-controlled)

- Revenue address is a 3-of-5 multisig
- Key shares held by the top 5 seeders (who are token holders — they have skin in the game)
- Distribution requires 3 of 5 to agree on the snapshot and co-sign
- Any 2 cheaters are outvoted by 3 honest parties

**Who are the 5 keyholders?** The top 5 token holders who also run nodes. They have the most to lose from incorrect distribution.

**Key rotation:** When the top-5 changes (tokens traded), a key rotation ceremony moves funds to a new multisig with updated keyholders.

**Enforcement: cryptographic (threshold), but requires liveness**

**Sufficient for:** medium scale, active seeder community

#### 2c: sCrypt covenant contract

- Revenue address is a P2SH (pay-to-script-hash)
- The script enforces: "this UTXO can only be spent if the outputs match the holder proportions proven by a merkle proof against a known snapshot root"
- ANYONE can trigger distribution — they just need to provide the correct merkle proof
- The contract verifies the proof on-chain. No trust in any party.

**The snapshot root:** Published on-chain by nodes (via OP_RETURN). Multiple nodes publish independently. The contract accepts any root that has N+ attestations.

**Enforcement: fully on-chain, trustless**

**Sufficient for:** production scale, adversarial environment

---

## The Seeder-as-Token-Holder Model

In our model, seeders MUST hold tokens to serve content. This changes the incentive structure:

- **Seeders are token holders.** Cheating the distribution means cheating yourself.
- **Seeders have skin in the game.** If the system is perceived as unfair, tokens lose value.
- **The top seeders ARE the top holders.** They have the most to lose.

This means Option 2b (threshold multisig controlled by top token holders who are also seeders) has natural alignment. The keyholders are precisely the people with the strongest economic incentive for correct distribution.

---

## Recommended Incremental Approach

### Phase 1: Direct fan-out (ship now)
- Settlement TX pays token holders directly
- Works for 1-100 holders (typical early content)
- Leecher constructs TX using snapshot from any node
- No custody, no treasury, no trust
- **Implementation: modify `buildPaymentTx` to accept N recipients**

### Phase 2: Accumulation + creator distribution (month 1)
- For content with 100+ holders, settle to revenue address
- Creator distributes periodically (daily/weekly)
- Nodes monitor and publish transparency reports
- Social/reputational enforcement
- **Implementation: add revenue address monitoring + reporting**

### Phase 3: Proof of Indexing (month 2)
- Nodes compute holder snapshot merkle roots
- Gossip roots via LibP2P
- Nodes that agree form the quorum
- Snapshot roots published on-chain (OP_RETURN)
- **Implementation: port snapshot logic from path402 PoI**

### Phase 4: Threshold multisig (month 3)
- Revenue address becomes 3-of-5 multisig
- Keyholders = top 5 token-holding seeders
- Distribution requires quorum agreement on snapshot
- Key rotation on holder changes
- **Implementation: Shamir secret sharing + rotation ceremony**

### Phase 5: sCrypt covenant (if needed)
- Full on-chain enforcement
- Anyone can trigger distribution with merkle proof
- Zero trust in any party
- **Implementation: sCrypt contract + merkle verifier**

---

## Do We Need PoW?

**For indexing consensus: No.** Reading the blockchain is deterministic. Proof of Indexing is a verification mechanism — it proves you did the reading correctly. No new consensus is needed because BSV's PoW already established the truth.

**For distribution ordering: No.** Distribution happens at defined epochs (every N blocks or N sats accumulated). The epoch boundary is deterministic. All nodes agree on when to distribute because they agree on the block height.

**For dispute resolution: Maybe.** If nodes disagree on the snapshot (one claims a transfer happened, another doesn't), the blockchain is the arbiter. Re-index and check. PoW already solved this.

**The only scenario where PoW adds value** is if you want nodes to compete for the right to construct and broadcast the distribution TX (similar to how miners compete to construct blocks). This would look like: nodes submit PoW alongside their snapshot root, the node with the most work gets to construct the distribution TX, and their snapshot is accepted. This is the HTM model.

**Is it necessary?** Not for correctness (the snapshot is deterministic). But it could be useful for **liveness** — ensuring distribution actually happens even if some nodes go offline. A PoW race incentivises at least one node to stay active and process distributions.

**Verdict: PoW is not needed for consensus or correctness, but may be useful for liveness incentives at scale. Start without it (Phase 1-4). Add it if liveness becomes a problem.**

---

## Summary

| Phase | Trust model | Holder scale | Enforcement |
|-------|-------------|-------------|-------------|
| 1 | None needed (viewer constructs TX) | 1-100 | Cryptographic (TX structure) |
| 2 | Trust creator + transparency | 100-1000 | Social/reputational |
| 3 | Verify via Proof of Indexing | 1000+ | Verification + social |
| 4 | Threshold multisig (top holders) | 1000+ | Cryptographic (threshold) |
| 5 | sCrypt covenant (trustless) | Unlimited | Fully on-chain |

**Phase 1 is sufficient for launch.** The common case is a creator with 100% of tokens (one holder). Fan-out is trivial. As tokens are sold and holder count grows, graduate to Phase 2, then 3, then 4.

**PoW (HTM-style) is not required but may be added for liveness guarantees at Phase 4+.**
