import { describe, it, expect } from 'vitest';
import { PrivateKey, Transaction, P2PKH } from '@bsv/sdk';
import { Wallet } from '../src/payment/wallet.js';
import { buildPresaleMintTx } from '../src/token/presale.js';
import { buildSubscriptionTx } from '../src/agents/subscribe.js';
import { MemoryRegistry } from '../src/agents/registry.js';
import type { ProductionOffer } from '../src/agents/registry.js';

/**
 * Build an ephemeral "funded" source transaction whose output is
 * locked to the given wallet and can be spent in tests. Mirrors
 * the helper used in test/payment-channel.test.ts.
 */
async function createMockSource(
  wallet: Wallet,
  amount: number,
): Promise<Transaction> {
  const upstream = new Transaction();
  upstream.addOutput({
    lockingScript: new P2PKH().lock(wallet.address),
    satoshis: amount + 1000,
  });
  const funding = new Transaction();
  funding.addInput({
    sourceTransaction: upstream,
    sourceOutputIndex: 0,
    unlockingScriptTemplate: new P2PKH().unlock(wallet.privateKey),
    sequence: 0xffffffff,
  });
  funding.addOutput({
    lockingScript: new P2PKH().lock(wallet.address),
    satoshis: amount,
  });
  await funding.sign();
  return funding;
}

function makeRegistryOffer(
  registry: MemoryRegistry,
  producer: Wallet,
): ProductionOffer {
  return registry.postOffer({
    producerId: 'spielbergx',
    producerAddress: producer.address,
    title: 'Star Wars Episode 1000',
    synopsis: 'A test offer for presale + subscribe',
    requiredSats: 10_000,
    tokenTicker: 'SPLBRG001',
  });
}

describe('presale mint + on-chain subscription (test-mode builders)', () => {
  it('buildPresaleMintTx produces a signed tx with 2 outputs and a BSV-21 OP_RETURN', async () => {
    const producer = Wallet.random();
    const registry = new MemoryRegistry();
    const offer = makeRegistryOffer(registry, producer);
    const sourceTx = await createMockSource(producer, 5_000);

    const tx = await buildPresaleMintTx({
      offer,
      wallet: producer,
      sourceTx,
      sourceVout: 0,
    });

    expect(tx.outputs.length).toBe(2);
    expect(tx.outputs[0].satoshis).toBe(1);

    // First output is the BSV-21 inscription — the exact byte layout
    // is determined by @bsv/sdk's Script chunk encoder, so we check
    // the embedded JSON via string search rather than raw prefix.
    const scriptString = Buffer.from(
      tx.outputs[0].lockingScript!.toBinary(),
    ).toString('utf-8');
    expect(scriptString).toContain('bsv-20');
    expect(scriptString).toContain('deploy+mint');
    expect(scriptString).toContain('SPLBRG001');
    expect(scriptString).toContain('10000');
    // OP_RETURN (0x6a) must appear somewhere in the locking script
    const scriptHex = Buffer.from(
      tx.outputs[0].lockingScript!.toBinary(),
    ).toString('hex');
    expect(scriptHex).toContain('6a');

    // Input must be signed (non-empty unlocking script)
    expect(tx.inputs[0].unlockingScript).toBeDefined();
    expect(tx.inputs[0].unlockingScript!.toBinary().length).toBeGreaterThan(0);
  });

  it('buildPresaleMintTx throws if the wallet address does not match the offer producer', async () => {
    const producer = Wallet.random();
    const imposter = Wallet.random();
    const registry = new MemoryRegistry();
    const offer = makeRegistryOffer(registry, producer);
    const sourceTx = await createMockSource(imposter, 5_000);

    await expect(
      buildPresaleMintTx({
        offer,
        wallet: imposter,
        sourceTx,
        sourceVout: 0,
      }),
    ).rejects.toThrow(/producer wallet/);
  });

  it('buildSubscriptionTx sends the right amount to the producer and returns change to the financier', async () => {
    const producer = Wallet.random();
    const financier = Wallet.random();
    const registry = new MemoryRegistry();
    const offer = makeRegistryOffer(registry, producer);
    const sourceTx = await createMockSource(financier, 15_000);

    const tx = await buildSubscriptionTx({
      financier,
      offer,
      sats: 10_000,
      sourceTx,
      sourceVout: 0,
    });

    expect(tx.outputs.length).toBe(2);
    // Output 0 pays the producer exactly the subscription amount
    expect(tx.outputs[0].satoshis).toBe(10_000);
    // P2PKH lock for the producer
    const payScriptHex = Buffer.from(
      tx.outputs[0].lockingScript!.toBinary(),
    ).toString('hex');
    const expectedPayScriptHex = Buffer.from(
      new P2PKH().lock(offer.producerAddress).toBinary(),
    ).toString('hex');
    expect(payScriptHex).toBe(expectedPayScriptHex);
    // Output 1 returns change to the financier
    const changeScriptHex = Buffer.from(
      tx.outputs[1].lockingScript!.toBinary(),
    ).toString('hex');
    const expectedChangeHex = Buffer.from(
      new P2PKH().lock(financier.address).toBinary(),
    ).toString('hex');
    expect(changeScriptHex).toBe(expectedChangeHex);
    // Change amount = source - payment - miner fee, so strictly less
    // than the source minus the payment.
    expect(tx.outputs[1].satoshis).toBeGreaterThan(0);
    expect(tx.outputs[1].satoshis).toBeLessThan(5_000);
  });

  it('buildSubscriptionTx rejects a zero or negative sats amount', async () => {
    const producer = Wallet.random();
    const financier = Wallet.random();
    const registry = new MemoryRegistry();
    const offer = makeRegistryOffer(registry, producer);
    const sourceTx = await createMockSource(financier, 15_000);

    await expect(
      buildSubscriptionTx({
        financier,
        offer,
        sats: 0,
        sourceTx,
        sourceVout: 0,
      }),
    ).rejects.toThrow(/sats must be/);
  });

  it('subscription tx input is properly signed (unlocking script present)', async () => {
    const producer = Wallet.random();
    const financier = Wallet.random();
    const registry = new MemoryRegistry();
    const offer = makeRegistryOffer(registry, producer);
    const sourceTx = await createMockSource(financier, 20_000);
    const tx = await buildSubscriptionTx({
      financier,
      offer,
      sats: 10_000,
      sourceTx,
      sourceVout: 0,
    });
    expect(tx.inputs[0].unlockingScript).toBeDefined();
    expect(tx.inputs[0].unlockingScript!.toBinary().length).toBeGreaterThan(0);
  });
});
