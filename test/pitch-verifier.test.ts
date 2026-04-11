import { describe, it, expect, vi } from 'vitest';
import {
  PitchVerifier,
  verifyPitchPayment,
  type PitchRow,
} from '../src/agents/pitch-verifier.js';

const VALID_TXID = 'a'.repeat(64);
const RECEIVE = '1RecieveAddressXXXXXXXXXXXXXXXXXX';

function mockFetch(body: unknown, ok = true, status = 200): typeof fetch {
  return (async () => ({
    ok,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe('verifyPitchPayment', () => {
  it('rejects malformed txids', async () => {
    const r = await verifyPitchPayment('not-a-txid', RECEIVE, 1000);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/malformed/);
  });

  it('rejects when WoC returns non-200', async () => {
    const r = await verifyPitchPayment(
      VALID_TXID,
      RECEIVE,
      1000,
      mockFetch(null, false, 404),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/404/);
  });

  it('rejects when no output pays the receive address', async () => {
    const r = await verifyPitchPayment(
      VALID_TXID,
      RECEIVE,
      1000,
      mockFetch({
        txid: VALID_TXID,
        vout: [
          { value: 0.001, scriptPubKey: { addresses: ['1otheraddr'] } },
        ],
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/paid 0/);
  });

  it('rejects when paid amount is below minimum', async () => {
    const r = await verifyPitchPayment(
      VALID_TXID,
      RECEIVE,
      1000,
      mockFetch({
        txid: VALID_TXID,
        vout: [
          // 500 sats = 0.000005 BSV
          { value: 0.000005, scriptPubKey: { addresses: [RECEIVE] } },
        ],
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/500/);
  });

  it('accepts when paid amount meets the minimum', async () => {
    const r = await verifyPitchPayment(
      VALID_TXID,
      RECEIVE,
      1000,
      mockFetch({
        txid: VALID_TXID,
        vout: [
          // 1500 sats = 0.000015 BSV
          { value: 0.000015, scriptPubKey: { addresses: [RECEIVE] } },
        ],
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.paidSats).toBe(1500);
  });

  it('sums multiple outputs to the same address', async () => {
    const r = await verifyPitchPayment(
      VALID_TXID,
      RECEIVE,
      1000,
      mockFetch({
        txid: VALID_TXID,
        vout: [
          { value: 0.000005, scriptPubKey: { addresses: [RECEIVE] } },
          { value: 0.000005, scriptPubKey: { addresses: [RECEIVE] } },
          { value: 0.000001, scriptPubKey: { addresses: [RECEIVE] } },
        ],
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.paidSats).toBe(1100);
  });
});

interface FakeQuery {
  rows: unknown[];
  error: Error | null;
  inserted: unknown[];
  updated: Array<{ where: Record<string, unknown>; patch: Record<string, unknown> }>;
}

function fakeSupabase(): { client: any; queries: Record<string, FakeQuery> } {
  const queries: Record<string, FakeQuery> = {
    bct_pitches: { rows: [], error: null, inserted: [], updated: [] },
    bct_offers: { rows: [], error: null, inserted: [], updated: [] },
  };
  const client = {
    from(name: string) {
      const q = queries[name];
      if (!q) throw new Error('unknown table ' + name);
      const builder: any = {
        _filter: {},
        select() {
          return this;
        },
        eq(col: string, val: unknown) {
          this._filter[col] = val;
          return this;
        },
        order() {
          return this;
        },
        limit() {
          // SELECT terminator — return the rows that match the filter
          const matched = (q.rows as Array<Record<string, unknown>>).filter((r) =>
            Object.entries(this._filter).every(([k, v]) => r[k] === v),
          );
          return Promise.resolve({ data: matched, error: q.error });
        },
        insert(payload: unknown) {
          q.inserted.push(payload);
          return Promise.resolve({ error: null });
        },
        update(patch: Record<string, unknown>) {
          this._patch = patch;
          return this;
        },
        then(resolve: (v: unknown) => void) {
          // when an .update().eq() chain is awaited
          q.updated.push({ where: { ...this._filter }, patch: { ...this._patch } });
          resolve({ error: null });
        },
      };
      return builder;
    },
  };
  return { client, queries };
}

describe('PitchVerifier.verifyAndConvert', () => {
  const baseRow: PitchRow = {
    id: 7,
    title: 'Neon Cathedral',
    ticker: 'NEONX',
    synopsis: 'A short film about neon and stained glass.',
    budget_sats: 5000,
    payment_address: RECEIVE,
    payment_txid: VALID_TXID,
    pitcher_address: null,
    status: 'pending',
  };

  it('rejects when payment address mismatches configured address', async () => {
    const { client, queries } = fakeSupabase();
    const v = new PitchVerifier({
      supabase: client,
      receiveAddress: '1OtherReceiveXXXXXXXXXXXXXXXXX',
      minSats: 1000,
      producerAgentId: 'spielbergx',
      producerAddress: '1Producer',
      fetcher: mockFetch({}) as typeof fetch,
    });
    const ok = await v.verifyAndConvert(baseRow);
    expect(ok).toBe(false);
    expect(queries.bct_pitches.updated[0].patch.status).toBe('rejected');
  });

  it('rejects when WoC verification fails', async () => {
    const { client, queries } = fakeSupabase();
    const v = new PitchVerifier({
      supabase: client,
      receiveAddress: RECEIVE,
      minSats: 1000,
      producerAgentId: 'spielbergx',
      producerAddress: '1Producer',
      fetcher: mockFetch({
        txid: VALID_TXID,
        vout: [{ value: 0.0000005, scriptPubKey: { addresses: [RECEIVE] } }],
      }),
    });
    const ok = await v.verifyAndConvert(baseRow);
    expect(ok).toBe(false);
    expect(queries.bct_pitches.updated[0].patch.status).toBe('rejected');
    expect(queries.bct_offers.inserted).toHaveLength(0);
  });

  it('inserts an offer and marks the pitch converted on success', async () => {
    const { client, queries } = fakeSupabase();
    const v = new PitchVerifier({
      supabase: client,
      receiveAddress: RECEIVE,
      minSats: 1000,
      producerAgentId: 'spielbergx',
      producerAddress: '1ProducerAddr',
      fetcher: mockFetch({
        txid: VALID_TXID,
        vout: [{ value: 0.00002, scriptPubKey: { addresses: [RECEIVE] } }],
      }),
    });
    const ok = await v.verifyAndConvert(baseRow);
    expect(ok).toBe(true);
    expect(queries.bct_offers.inserted).toHaveLength(1);
    const inserted = queries.bct_offers.inserted[0] as Record<string, unknown>;
    expect(inserted.title).toBe('Neon Cathedral');
    expect(inserted.token_ticker).toBe('NEONX');
    expect(inserted.required_sats).toBe(5000);
    expect(inserted.producer_id).toBe('spielbergx');
    expect(inserted.producer_address).toBe('1ProducerAddr');

    const update = queries.bct_pitches.updated[0];
    expect(update.where.id).toBe(7);
    expect(update.patch.status).toBe('converted');
    expect(update.patch.offer_id).toBeDefined();
  });
});
