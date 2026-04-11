/**
 * Watch-payment cascade — math + visualization.
 *
 * Single source of truth for how a 100-sat watch payment is split
 * across the producer treasury and the financiers who funded a
 * production. Used by:
 *
 *   - watch.html  → drives the actual on-chain payment outputs
 *   - offer.html  → renders the visualization on the per-offer page
 *   - any future revenue dashboard
 *
 * Cascade rules:
 *   - PRODUCER_SHARE (default 20%) goes to the producer's treasury
 *     as a single output.
 *   - The remaining (default 80%) is split across the offer's
 *     subscribers proportional to their subscription weight (the
 *     `sats` column on bct_subscriptions).
 *   - Sub-dust holder shares are bumped to 1 sat each. The deficit
 *     comes out of the producer share so the total never exceeds
 *     the watch price.
 *   - 0 subscribers → all WATCH_PRICE_SATS goes to the producer.
 */

export const WATCH_PRICE_SATS = 100;
export const PRODUCER_SHARE = 0.20;

/**
 * Compute the per-output split for a watch payment.
 *
 * Inputs:
 *   offer            — { producer_id, producer_address,
 *                        bct_subscriptions: [{ agent_id, address, sats }] }
 *   priceSats        — total watch price (defaults to WATCH_PRICE_SATS)
 *   producerShare    — fraction to producer (defaults to PRODUCER_SHARE)
 *
 * Output:
 *   { outputs, total, producerSats, holderPool }
 *   outputs[] is ordered: [producer, ...holders]
 *   each item: { address, satoshis, label, role }
 */
export function computeCascade(offer, priceSats = WATCH_PRICE_SATS, producerShare = PRODUCER_SHARE) {
  const subs = offer?.bct_subscriptions || [];
  const producerSats = Math.max(1, Math.floor(priceSats * producerShare));
  let holderPool = priceSats - producerSats;

  const outputs = [{
    address: offer?.producer_address || '',
    satoshis: producerSats,
    label: `producer treasury (${offer?.producer_id || 'unknown'})`,
    role: 'producer',
  }];

  const totalWeight = subs.reduce((s, x) => s + (Number(x.sats) || 0), 0);
  if (subs.length === 0 || totalWeight <= 0) {
    // No financiers — everything goes to the producer.
    outputs[0].satoshis = priceSats;
    return {
      outputs,
      total: priceSats,
      producerSats: priceSats,
      holderPool: 0,
    };
  }

  const allocations = subs.map((s) => ({
    address: s.address,
    satoshis: Math.floor((holderPool * (Number(s.sats) || 0)) / totalWeight),
    label: `holder ${s.agent_id}`,
    role: 'holder',
    weight: Number(s.sats) || 0,
    agentId: s.agent_id,
  }));

  // Bump zero/dust to 1 sat
  let bumped = 0;
  for (const a of allocations) {
    if (a.satoshis === 0) {
      a.satoshis = 1;
      bumped++;
    }
  }

  // Distribute the remainder so the total is exact
  let distributed = allocations.reduce((s, a) => s + a.satoshis, 0);
  if (distributed < holderPool) {
    const idx = allocations
      .map((a, i) => ({ a, i }))
      .sort((x, y) => y.a.satoshis - x.a.satoshis)[0].i;
    allocations[idx].satoshis += (holderPool - distributed);
  } else if (distributed > holderPool) {
    // Rare — happens when bumped > 0 and producer share absorbs deficit
    outputs[0].satoshis = Math.max(
      1,
      outputs[0].satoshis - (distributed - holderPool),
    );
  }

  outputs.push(...allocations);
  return {
    outputs,
    total: outputs.reduce((s, o) => s + o.satoshis, 0),
    producerSats: outputs[0].satoshis,
    holderPool,
  };
}

/**
 * Render an HTML string for the cascade visualization. Caller is
 * responsible for putting it in the DOM. Self-contained styles
 * (uses inline class names prefixed with `cas-`) so it can be
 * dropped into any page without conflicting with the host CSS.
 *
 * Pass `theme: 'dark'` for the watch.html / dark-bg use case;
 * default is light for the offer.html investor page.
 *
 * Returns: { html, css }
 *   - html: the markup to inject
 *   - css:  a <style> block to inject once per page if you haven't
 *           already loaded it. Idempotent — safe to inject multiple
 *           times since it scopes by class name.
 */
export function renderCascade(offer, opts = {}) {
  const theme = opts.theme || 'light';
  const cascade = computeCascade(offer);
  const { outputs, total } = cascade;

  // Build the bar segments
  const segments = outputs.map((o) => {
    const pct = total > 0 ? (o.satoshis / total) * 100 : 0;
    return { ...o, pct };
  });

  // Producer first (always black), then holders alternate gray shades
  const segHtml = segments.map((seg, i) => {
    const isProducer = seg.role === 'producer';
    const bg = isProducer
      ? '#000'
      : `hsl(0, 0%, ${85 - (i * 8) % 30}%)`;
    return `<div class="cas-seg" style="width:${seg.pct.toFixed(2)}%;background:${bg};" title="${esc(seg.label)} — ${seg.satoshis} sats"></div>`;
  }).join('');

  // Below the bar — labelled rows with the math
  const rowHtml = segments.map((seg) => {
    const isProducer = seg.role === 'producer';
    const swatchBg = isProducer ? '#000' : '#666';
    return `
      <div class="cas-row">
        <div class="cas-swatch" style="background:${swatchBg};"></div>
        <div class="cas-label">${esc(seg.label)}</div>
        <div class="cas-pct">${seg.pct.toFixed(0)}%</div>
        <div class="cas-sats">${seg.satoshis} sats</div>
      </div>
    `;
  }).join('');

  const html = `
    <div class="cas cas-${theme}">
      <div class="cas-head">
        <div class="cas-kicker">Per-watch revenue cascade</div>
        <div class="cas-total">${total} sats per watch</div>
      </div>
      <div class="cas-bar">${segHtml}</div>
      <div class="cas-rows">${rowHtml}</div>
      <div class="cas-foot">
        Every paid watch is a single BRC-100 createAction call that
        broadcasts ${segments.length} on-chain output${segments.length === 1 ? '' : 's'}
        — ${segments.filter((s) => s.role === 'producer').length} to the producer treasury,
        ${segments.filter((s) => s.role === 'holder').length} to the financier${segments.filter((s) => s.role === 'holder').length === 1 ? '' : 's'} who funded this production.
      </div>
    </div>
  `;

  const css = `
    <style data-cascade-css="1">
      .cas { font-family: inherit; }
      .cas-light { color: #111; }
      .cas-dark  { color: #fff; }
      .cas-head {
        display: flex; justify-content: space-between; align-items: baseline;
        margin-bottom: 0.7rem;
      }
      .cas-kicker {
        font-size: 0.55rem; letter-spacing: 0.15em; text-transform: uppercase;
        font-weight: 700; opacity: 0.6;
      }
      .cas-total {
        font-family: 'SF Mono', Monaco, monospace; font-size: 0.85rem;
        font-weight: 700;
      }
      .cas-bar {
        display: flex; width: 100%; height: 18px;
        border: 1px solid currentColor; overflow: hidden;
      }
      .cas-light .cas-bar { border-color: #000; }
      .cas-dark  .cas-bar { border-color: #fff; }
      .cas-seg {
        height: 100%; transition: opacity 0.2s ease;
      }
      .cas-seg:hover { opacity: 0.8; }
      .cas-rows { margin-top: 0.9rem; display: grid; gap: 0.4rem; }
      .cas-row {
        display: grid;
        grid-template-columns: 14px 1fr auto auto;
        gap: 0.7rem; align-items: center;
        font-size: 0.75rem;
      }
      .cas-swatch {
        width: 14px; height: 14px; border: 1px solid currentColor;
      }
      .cas-light .cas-swatch { border-color: #000; }
      .cas-dark  .cas-swatch { border-color: #fff; }
      .cas-label {
        font-family: 'SF Mono', Monaco, monospace; font-size: 0.7rem;
        opacity: 0.85; word-break: break-all;
      }
      .cas-pct {
        font-variant-numeric: tabular-nums; font-weight: 700;
        font-size: 0.7rem; opacity: 0.6; min-width: 2.5em; text-align: right;
      }
      .cas-sats {
        font-family: 'SF Mono', Monaco, monospace; font-weight: 700;
        font-size: 0.75rem; min-width: 5em; text-align: right;
      }
      .cas-foot {
        margin-top: 0.9rem; font-size: 0.65rem;
        line-height: 1.5; opacity: 0.6;
      }
    </style>
  `;

  return { html, css };
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
