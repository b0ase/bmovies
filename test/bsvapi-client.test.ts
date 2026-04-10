import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Transaction, P2PKH } from '@bsv/sdk';
import { Wallet } from '../src/payment/wallet.js';
import { BsvapiClient } from '../src/agents/bsvapi-client.js';
import type { TxBroadcaster } from '../src/payment/broadcaster.js';

/**
 * Make a fake signed source tx that pays `amount` to the wallet,
 * suitable for passing to sourceUtxoFinder.
 */
async function fakeSigned(
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

function stubBroadcaster(): TxBroadcaster {
  let seq = 0;
  return {
    name: 'stub',
    broadcast: vi.fn(async () => {
      seq++;
      return { success: true, txid: `stub-tx-${seq}` };
    }),
  };
}

describe('BsvapiClient', () => {
  let wallet: Wallet;
  let sourceTx: Transaction;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    wallet = Wallet.random();
    sourceTx = await fakeSigned(wallet, 1_000_000);
    fetchMock = vi.fn();
    (globalThis as unknown as { fetch: typeof fetch }).fetch =
      fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function buildClient(broadcaster?: TxBroadcaster): BsvapiClient {
    return new BsvapiClient({
      baseUrl: 'https://bsvapi.example',
      wallet,
      broadcaster,
      sourceUtxoFinder: async () => ({
        txid: 'fake',
        vout: 0,
        sourceTx,
        satoshis: 1_000_000,
      }),
    });
  }

  it('returns the body directly when the server responds 200 on the first call', async () => {
    fetchMock.mockResolvedValueOnce({
      status: 200,
      json: async () => ({ hello: 'world' }),
    });
    const client = buildClient();
    const res = await client.chat({ model: 'grok-3', messages: [] });
    expect(res.body).toEqual({ hello: 'world' });
    expect(res.paymentTxid).toBe('');
    expect(res.satoshisPaid).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('pays the x402 requirement and retries, returning the final body', async () => {
    const bcast = stubBroadcaster();
    fetchMock
      .mockResolvedValueOnce({
        status: 402,
        headers: new Headers({
          'x-bsv-payment-version': '2',
          'x-bsv-payment-satoshis-required': '1234',
          'x-bsv-payment-address': Wallet.random().address,
          'x-bsv-payment-network': 'mainnet',
        }),
        text: async () => '',
      })
      .mockResolvedValueOnce({
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'pong' } }] }),
      });

    const client = buildClient(bcast);
    const res = await client.chat({
      model: 'grok-3',
      messages: [{ role: 'user', content: 'ping' }],
    });
    expect(res.body).toEqual({
      choices: [{ message: { content: 'pong' } }],
    });
    expect(res.paymentTxid).toBe('stub-tx-1');
    expect(res.satoshisPaid).toBe(1234);
    expect(bcast.broadcast).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The retry should include the x-bsv-payment header
    const retryCall = fetchMock.mock.calls[1];
    const retryHeaders =
      (retryCall[1]?.headers ?? {}) as Record<string, string>;
    expect(retryHeaders['x-bsv-payment']).toBe('stub-tx-1');
  });

  it('throws with a useful message when the 402 omits the payment address', async () => {
    fetchMock.mockResolvedValueOnce({
      status: 402,
      headers: new Headers({
        'x-bsv-payment-satoshis-required': '100',
      }),
      text: async () => '',
    });
    const client = buildClient(stubBroadcaster());
    await expect(
      client.chat({ model: 'grok-3', messages: [] }),
    ).rejects.toThrow(/without a valid payment requirement/);
  });

  it('surfaces a non-402 error response as a thrown error', async () => {
    fetchMock.mockResolvedValueOnce({
      status: 500,
      text: async () => '{"error":"boom"}',
    });
    const client = buildClient();
    await expect(
      client.chat({ model: 'grok-3', messages: [] }),
    ).rejects.toThrow(/returned 500/);
  });

  it('throws if the payment broadcast itself fails', async () => {
    const failBroadcaster: TxBroadcaster = {
      name: 'fail',
      broadcast: vi.fn(async () => ({
        success: false,
        error: 'relay rejected',
        txid: '',
      })),
    };
    fetchMock.mockResolvedValueOnce({
      status: 402,
      headers: new Headers({
        'x-bsv-payment-satoshis-required': '500',
        'x-bsv-payment-address': Wallet.random().address,
      }),
      text: async () => '',
    });
    const client = buildClient(failBroadcaster);
    await expect(
      client.chat({ model: 'grok-3', messages: [] }),
    ).rejects.toThrow(/BSVAPI payment broadcast failed.*relay rejected/);
  });

  it('image and video helpers target the right paths', async () => {
    fetchMock.mockResolvedValue({ status: 200, json: async () => ({}) });
    const client = buildClient();
    await client.generateImage({ model: 'flux-1', prompt: 'a cat' });
    await client.generateVideo({ model: 'wan-2.1', prompt: 'a running cat' });
    expect(fetchMock.mock.calls[0][0]).toContain('/api/v1/images/generate');
    expect(fetchMock.mock.calls[1][0]).toContain('/api/v1/video/generate');
  });
});
