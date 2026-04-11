/**
 * Pitch verifier — converts visitor-submitted pitches into real
 * production offers once their payment txid has been confirmed
 * on the BSV mainnet.
 *
 * The landing-page widget inserts a row into bct_pitches via the
 * Supabase anon key whenever a visitor refines an idea and clicks
 * "Tokenize this pitch". The row is write-only from the public
 * side; this verifier runs in the swarm runner with the service
 * role and:
 *
 *   1. Polls bct_pitches for status='pending'
 *   2. For each row, fetches the txid from WhatsOnChain and checks
 *      that it pays at least PITCH_MIN_SATS to PITCH_RECEIVE_ADDRESS
 *   3. On success: inserts a new bct_offers row owned by a
 *      designated "pitch producer" agent and links it back to the
 *      pitch (status='converted', offer_id=...)
 *   4. On failure: status='rejected' with a reason string so the
 *      operator can debug
 *
 * Verification is intentionally simple — one WoC GET per pitch.
 * The runner polls infrequently (every 30s by default) so it stays
 * well under WoC's rate limit even with hundreds of pending pitches.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

const WOC_BASE = 'https://api.whatsonchain.com/v1/bsv/main';

export interface PitchRow {
  id: number;
  title: string;
  ticker: string;
  synopsis: string;
  budget_sats: number;
  payment_address: string;
  payment_txid: string;
  pitcher_address: string | null;
  status: 'pending' | 'verified' | 'rejected' | 'converted';
}

export interface PitchVerifierOptions {
  /** Supabase client with the service role key */
  supabase: SupabaseClient;
  /** Address all pitch payments must be sent to */
  receiveAddress: string;
  /** Minimum sats the txid must pay to receiveAddress */
  minSats: number;
  /** Producer agent id used as the owner of converted offers */
  producerAgentId: string;
  /** Producer agent address (used as the offer's producer_address) */
  producerAddress: string;
  /** Optional fetcher override (for tests) */
  fetcher?: typeof fetch;
}

export interface VerificationResult {
  ok: boolean;
  paidSats?: number;
  reason?: string;
}

interface WocVout {
  value: number; // BSV (decimal), e.g. 0.00001000 for 1000 sats
  scriptPubKey?: { addresses?: string[] };
}
interface WocTxResponse {
  txid: string;
  vout: WocVout[];
  confirmations?: number;
}

/**
 * Hit WoC and check that `txid` includes at least one output paying
 * at least `minSats` to `receiveAddress`. Returns the actual sats
 * paid on success so the caller can record it.
 */
export async function verifyPitchPayment(
  txid: string,
  receiveAddress: string,
  minSats: number,
  fetcher: typeof fetch = fetch,
): Promise<VerificationResult> {
  if (!/^[0-9a-f]{64}$/i.test(txid)) {
    return { ok: false, reason: 'malformed txid' };
  }
  let res: Response;
  try {
    res = await fetcher(`${WOC_BASE}/tx/hash/${txid}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `WoC fetch failed: ${msg}` };
  }
  if (!res.ok) {
    return { ok: false, reason: `WoC returned ${res.status}` };
  }
  const tx = (await res.json()) as WocTxResponse;
  if (!tx || !Array.isArray(tx.vout)) {
    return { ok: false, reason: 'WoC response missing vout' };
  }
  let totalToReceiver = 0;
  for (const out of tx.vout) {
    const addrs = out.scriptPubKey?.addresses ?? [];
    if (addrs.includes(receiveAddress)) {
      // BSV value is decimal — convert to sats
      const sats = Math.round((out.value ?? 0) * 1e8);
      totalToReceiver += sats;
    }
  }
  if (totalToReceiver < minSats) {
    return {
      ok: false,
      reason: `paid ${totalToReceiver} sats; expected ${minSats}`,
    };
  }
  return { ok: true, paidSats: totalToReceiver };
}

export class PitchVerifier {
  private readonly opts: PitchVerifierOptions;
  private readonly fetcher: typeof fetch;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: PitchVerifierOptions) {
    this.opts = opts;
    this.fetcher = opts.fetcher ?? fetch;
  }

  /**
   * Process a single batch of pending pitches. Exposed so tests
   * (and the manual `pnpm pitch:verify` script) can drive the
   * verifier deterministically without spinning up the timer.
   */
  async runOnce(): Promise<{ checked: number; converted: number }> {
    const { data, error } = await this.opts.supabase
      .from('bct_pitches')
      .select(
        'id, title, ticker, synopsis, budget_sats, payment_address, payment_txid, pitcher_address, status',
      )
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(20);
    if (error) {
      console.error('[PitchVerifier] poll error:', error);
      return { checked: 0, converted: 0 };
    }
    const rows = (data ?? []) as PitchRow[];
    let converted = 0;
    for (const row of rows) {
      const result = await this.verifyAndConvert(row);
      if (result) converted++;
    }
    return { checked: rows.length, converted };
  }

  /**
   * Verify a single pitch and, if it pays, insert a bct_offers row
   * and link the pitch to it. Returns true on success.
   */
  async verifyAndConvert(row: PitchRow): Promise<boolean> {
    if (row.payment_address !== this.opts.receiveAddress) {
      await this.markRejected(
        row.id,
        `payment_address ${row.payment_address} does not match configured receive address`,
      );
      return false;
    }
    const result = await verifyPitchPayment(
      row.payment_txid,
      this.opts.receiveAddress,
      this.opts.minSats,
      this.fetcher,
    );
    if (!result.ok) {
      await this.markRejected(row.id, result.reason ?? 'verification failed');
      return false;
    }

    // Insert the bct_offers row directly. The producer agent's tick
    // loop will see it on the next pass and post the BSV-21 token /
    // dispatch the team. We use the configured producerAgentId as the
    // owner so the agent can later transition status fields.
    const offerId = `pitch-${row.id}-${Date.now()}`;
    const { error: insErr } = await this.opts.supabase
      .from('bct_offers')
      .insert({
        id: offerId,
        producer_id: this.opts.producerAgentId,
        producer_address: this.opts.producerAddress,
        title: row.title,
        synopsis: row.synopsis,
        required_sats: row.budget_sats,
        raised_sats: 0,
        status: 'open',
        token_ticker: row.ticker,
      });
    if (insErr) {
      await this.markRejected(row.id, `offer insert failed: ${insErr.message}`);
      return false;
    }
    const { error: updErr } = await this.opts.supabase
      .from('bct_pitches')
      .update({
        status: 'converted',
        offer_id: offerId,
        verified_at: new Date().toISOString(),
      })
      .eq('id', row.id);
    if (updErr) {
      console.error(
        `[PitchVerifier] failed to mark pitch ${row.id} converted:`,
        updErr,
      );
      // The offer is already in place; surfacing the error is enough.
    }
    console.log(
      `[PitchVerifier] converted pitch #${row.id} "${row.title}" → offer ${offerId}`,
    );
    return true;
  }

  private async markRejected(id: number, reason: string): Promise<void> {
    await this.opts.supabase
      .from('bct_pitches')
      .update({ status: 'rejected', rejection_reason: reason })
      .eq('id', id);
    console.warn(`[PitchVerifier] rejected pitch #${id}: ${reason}`);
  }

  /**
   * Start the polling loop. Runs every `intervalMs` ms (default 30s).
   * Calls to start() while already running are no-ops.
   */
  start(intervalMs: number = 30_000): void {
    if (this.timer) return;
    void this.runOnce();
    this.timer = setInterval(() => {
      this.runOnce().catch((err) =>
        console.error('[PitchVerifier] runOnce error:', err),
      );
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
