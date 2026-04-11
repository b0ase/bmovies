import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MemoryRegistry } from '../src/agents/registry.js';
import { ProducerAgent } from '../src/agents/producer.js';
import { FinancierAgent } from '../src/agents/financier.js';
import { Wallet } from '../src/payment/wallet.js';

describe('ProducerAgent + FinancierAgent + MemoryRegistry', () => {
  let registry: MemoryRegistry;
  let producer: ProducerAgent;
  let financier: FinancierAgent;

  beforeEach(() => {
    vi.useFakeTimers();
    registry = new MemoryRegistry();

    producer = new ProducerAgent(
      {
        id: 'spielbergx',
        name: 'SpielbergX',
        role: 'producer',
        persona: 'An autonomous AI producer of short films',
      },
      Wallet.random(),
      {
        registry,
        budgetSats: 10_000,
        maxOpenOffers: 1,
        productionIdeas: [
          'Star Wars Episode 1000',
          'The Last Piece',
          'Midnight Swarm',
        ],
      },
    );

    financier = new FinancierAgent(
      {
        id: 'vcx',
        name: 'VC-X',
        role: 'financier',
        persona: 'An autonomous venture agent seeking short-film deals',
      },
      Wallet.random(),
      {
        registry,
        thesis: {
          maxSatsPerOffer: 10_000,
          minOfferBudget: 1_000,
          maxOfferBudget: 100_000,
          preferredProducers: [],
        },
        maxPositions: 5,
      },
    );
  });

  afterEach(() => {
    producer.stop();
    financier.stop();
    vi.useRealTimers();
  });

  it('constructor rejects a wrong role for the subclass', () => {
    expect(
      () =>
        new ProducerAgent(
          {
            id: 'wrong',
            name: 'Wrong',
            role: 'financier',
            persona: '',
          },
          Wallet.random(),
          {
            registry,
            budgetSats: 100,
            maxOpenOffers: 1,
            productionIdeas: ['x'],
          },
        ),
    ).toThrow(/requires role/);
  });

  it('producer.proposeProduction posts an open offer into the registry', () => {
    const offer = producer.proposeProduction();
    expect(offer.status).toBe('open');
    expect(offer.raisedSats).toBe(0);
    expect(offer.producerId).toBe('spielbergx');
    expect(offer.producerAddress).toBe(producer.address);
    expect(offer.tokenTicker).toMatch(/^SPLBRG|SPIE|SPLB/);
    expect(registry.listOpenOffers()).toContainEqual(offer);
  });

  it('financier evaluates offers against its thesis', () => {
    const offer = producer.proposeProduction();
    expect(financier.evaluate(offer)).toBe(10_000);

    const restrictive = new FinancierAgent(
      {
        id: 'strict',
        name: 'Strict',
        role: 'financier',
        persona: '',
      },
      Wallet.random(),
      {
        registry,
        thesis: {
          maxSatsPerOffer: 10_000,
          minOfferBudget: 1_000,
          maxOfferBudget: 100_000,
          preferredProducers: ['nobody'],
        },
        maxPositions: 5,
      },
    );
    expect(restrictive.evaluate(offer)).toBe(0);
  });

  it('financier.subscribeToOffer moves the offer toward funded', () => {
    const offer = producer.proposeProduction();
    const sub = financier.subscribeToOffer(offer);
    expect(sub).not.toBeNull();
    expect(sub!.sats).toBe(10_000);
    const updated = registry.getOffer(offer.id)!;
    expect(updated.raisedSats).toBe(10_000);
    expect(updated.status).toBe('funded');
  });

  it('autonomous loop: producer posts, financier subscribes, producer advances to producing', async () => {
    producer.start(100);
    financier.start(100);

    // Let a few ticks run
    await vi.advanceTimersByTimeAsync(500);

    const myOffers = producer.getMyOffers();
    expect(myOffers.length).toBeGreaterThanOrEqual(1);

    // At least one offer should have reached producing status
    const producing = myOffers.filter((o) => o.status === 'producing');
    expect(producing.length).toBeGreaterThanOrEqual(1);

    // The financier should have at least one position
    expect(financier.getPositions().length).toBeGreaterThanOrEqual(1);

    // The producer log should contain both a post and a producing event
    const producerLog = producer.getLog(100);
    expect(producerLog.some((e) => /Posted offer/.test(e.message))).toBe(true);
    expect(producerLog.some((e) => /production begins/.test(e.message))).toBe(true);
  });

  it('a single financier cannot oversubscribe beyond the required budget', () => {
    const offer = producer.proposeProduction();
    financier.subscribeToOffer(offer);
    // Second subscribe attempt is a no-op because the agent is
    // already in the subscriber list.
    const second = financier.subscribeToOffer(offer);
    expect(second).toBeNull();
    const updated = registry.getOffer(offer.id)!;
    expect(updated.raisedSats).toBe(10_000);
    expect(updated.subscribers.length).toBe(1);
  });

  it('attachSubscriptionTxid backfills the on-chain payment txid', () => {
    const offer = producer.proposeProduction();
    financier.subscribeToOffer(offer);

    // Before backfill, the subscriber row exists but its
    // paymentTxid is undefined.
    const before = registry.getOffer(offer.id)!;
    const subBefore = before.subscribers.find((s) => s.agentId === 'vcx')!;
    expect(subBefore.paymentTxid).toBeUndefined();

    // After backfill the txid is persisted on the row.
    const fakeTxid = 'a'.repeat(64);
    const result = registry.attachSubscriptionTxid(offer.id, 'vcx', fakeTxid);
    expect(result).not.toBeNull();
    const subAfter = result!.subscribers.find((s) => s.agentId === 'vcx')!;
    expect(subAfter.paymentTxid).toBe(fakeTxid);
  });

  it('attachSubscriptionTxid returns null for unknown offer or subscriber', () => {
    const offer = producer.proposeProduction();
    financier.subscribeToOffer(offer);

    expect(
      registry.attachSubscriptionTxid('offer-does-not-exist', 'vcx', 'a'.repeat(64)),
    ).toBeNull();
    expect(
      registry.attachSubscriptionTxid(offer.id, 'wrong-agent', 'a'.repeat(64)),
    ).toBeNull();
  });
});
