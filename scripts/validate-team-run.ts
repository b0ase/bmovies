/**
 * Validation script for the live team-mode test (Task 38).
 *
 * Reads the persistent registry on Hetzner and reports whether the
 * most recent productions look like team-mode dispatches: 4 distinct
 * artifact rows per offer, one per role, plus a real WoC payment
 * txid for each.
 *
 * Run AFTER kicking off `pnpm agents:swarm -- --team --bsvapi …`
 * and waiting at least one full producer tick + four BSVAPI
 * roundtrips (~60–120s).
 *
 * Usage:
 *   SUPABASE_URL=https://api.b0ase.com \
 *   SUPABASE_SERVICE_ROLE_KEY=… \
 *   pnpm tsx scripts/validate-team-run.ts
 *
 * Optional flags:
 *   --since-minutes N   only inspect offers created in the last N minutes (default 30)
 *   --offer-id ID       inspect a specific offer instead of the latest batch
 *   --pitch-id ID       inspect the pitch flow for a specific bct_pitches.id
 */

import { createClient } from '@supabase/supabase-js';

const ROLES = ['writer', 'director', 'storyboard', 'composer'] as const;
type Role = (typeof ROLES)[number];

interface OfferRow {
  id: string;
  title: string;
  status: string;
  required_sats: number;
  raised_sats: number;
  created_at: string;
}

interface ArtifactRow {
  offer_id: string;
  kind: string;
  url: string;
  model: string;
  payment_txid: string;
  role: string | null;
  created_at: string;
}

interface PitchRow {
  id: number;
  title: string;
  ticker: string;
  status: string;
  payment_txid: string;
  offer_id: string | null;
  rejection_reason: string | null;
  created_at: string;
  verified_at: string | null;
}

function parseFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = 'true';
    }
  }
  return out;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const sinceMinutes = Number(flags['since-minutes'] ?? '30');
  const offerId = flags['offer-id'];
  const pitchId = flags['pitch-id'];

  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error(
      'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in the environment.',
    );
    process.exit(1);
  }
  const supa = createClient(url, key, { auth: { persistSession: false } });

  if (pitchId) {
    await reportPitch(supa, pitchId);
    return;
  }

  let offers: OfferRow[];
  if (offerId) {
    const { data, error } = await supa
      .from('bct_offers')
      .select('id, title, status, required_sats, raised_sats, created_at')
      .eq('id', offerId)
      .limit(1);
    if (error) throw error;
    offers = (data ?? []) as OfferRow[];
  } else {
    const cutoff = new Date(Date.now() - sinceMinutes * 60_000).toISOString();
    const { data, error } = await supa
      .from('bct_offers')
      .select('id, title, status, required_sats, raised_sats, created_at')
      .gte('created_at', cutoff)
      .order('created_at', { ascending: false })
      .limit(20);
    if (error) throw error;
    offers = (data ?? []) as OfferRow[];
  }

  if (offers.length === 0) {
    console.log(
      offerId
        ? `No offer with id ${offerId}.`
        : `No offers in the last ${sinceMinutes} minutes.`,
    );
    return;
  }

  console.log(
    `Inspecting ${offers.length} offer${offers.length === 1 ? '' : 's'}\n`,
  );

  for (const offer of offers) {
    const { data: artData, error: artErr } = await supa
      .from('bct_artifacts')
      .select('offer_id, kind, url, model, payment_txid, role, created_at')
      .eq('offer_id', offer.id)
      .order('created_at', { ascending: true });
    if (artErr) {
      console.error(`  ${offer.id}: failed to read artifacts:`, artErr);
      continue;
    }
    const arts = (artData ?? []) as ArtifactRow[];
    reportOffer(offer, arts);
    console.log('');
  }
}

function reportOffer(offer: OfferRow, arts: ArtifactRow[]): void {
  const head = `${offer.id}  "${offer.title}"  [${offer.status}]`;
  console.log(head);
  console.log('  ' + '─'.repeat(head.length));
  console.log(
    `  funding   : ${offer.raised_sats}/${offer.required_sats} sats`,
  );

  if (arts.length === 0) {
    console.log(`  artifacts : none`);
    return;
  }

  const byRole = new Map<string, ArtifactRow>();
  let nullRoleCount = 0;
  for (const a of arts) {
    if (a.role) byRole.set(a.role, a);
    else nullRoleCount++;
  }

  if (byRole.size === 0) {
    console.log(
      `  artifacts : ${arts.length} (single-producer mode — no role tags)`,
    );
    for (const a of arts) {
      console.log(`    • ${a.kind.padEnd(6)} ${a.model.padEnd(18)} tx ${shortTx(a.payment_txid)} ${a.url}`);
    }
    return;
  }

  console.log(`  artifacts : ${arts.length} total, ${byRole.size}/4 roles present`);
  for (const role of ROLES) {
    const a = byRole.get(role);
    if (a) {
      console.log(
        `    ✓ ${role.padEnd(10)} ${a.kind.padEnd(6)} ${a.model.padEnd(18)} tx ${shortTx(a.payment_txid)}`,
      );
    } else {
      console.log(`    ✗ ${role.padEnd(10)} (missing)`);
    }
  }
  if (nullRoleCount > 0) {
    console.log(
      `    + ${nullRoleCount} legacy single-producer artifact${nullRoleCount === 1 ? '' : 's'}`,
    );
  }

  const verdict = (() => {
    if (byRole.size === 4) return '✓ TEAM DISPATCH SUCCESS — all four roles delivered';
    if (byRole.size >= 1) return `~ PARTIAL TEAM — ${byRole.size}/4 roles delivered`;
    return '✗ NO TEAM ARTIFACTS';
  })();
  console.log(`  verdict   : ${verdict}`);
}

async function reportPitch(supa: ReturnType<typeof createClient>, id: string): Promise<void> {
  const { data, error } = await supa
    .from('bct_pitches')
    .select('id, title, ticker, status, payment_txid, offer_id, rejection_reason, created_at, verified_at')
    .eq('id', Number(id))
    .limit(1);
  if (error) throw error;
  const pitches = (data ?? []) as PitchRow[];
  if (pitches.length === 0) {
    console.log(`No pitch with id ${id}.`);
    return;
  }
  const p = pitches[0];
  console.log(`Pitch #${p.id}  "${p.title}"  ($${p.ticker})`);
  console.log(`  status      : ${p.status}`);
  console.log(`  payment txid: ${p.payment_txid}`);
  console.log(`  created     : ${p.created_at}`);
  if (p.verified_at) console.log(`  verified    : ${p.verified_at}`);
  if (p.offer_id) console.log(`  offer       : ${p.offer_id}`);
  if (p.rejection_reason) console.log(`  rejected    : ${p.rejection_reason}`);
}

function shortTx(t: string): string {
  if (!t) return '—';
  return t.slice(0, 12) + '…';
}

main().catch((err) => {
  console.error('validate-team-run failed:', err);
  process.exit(1);
});
