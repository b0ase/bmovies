/**
 * Fastify plugin registering the swarm dashboard routes.
 *
 *   GET /api/agents/snapshot  — JSON snapshot of the running swarm
 *   GET /agents               — static HTML dashboard
 *
 * The dashboard HTML polls /api/agents/snapshot every second and
 * renders agent identities, balances, open offers, presale and
 * subscription counters, piece-payment TX counter, and a tail of
 * the swarm log.
 */

import type { FastifyInstance } from 'fastify';
import type { Swarm } from './swarm.js';

export interface DashboardRoutesOptions {
  swarm: Swarm;
  /**
   * Optional global counters the dashboard should display. The
   * swarm coordinator updates these as streaming loops fire.
   */
  counters?: {
    getPieceTxCount(): number;
    getTotalSatsDistributed(): number;
    getActiveStreams(): number;
  };
}

export function registerDashboardRoutes(
  app: FastifyInstance,
  opts: DashboardRoutesOptions,
): void {
  const { swarm, counters } = opts;

  app.get('/api/agents/snapshot', async () => {
    const snap = swarm.snapshot();
    return {
      ...snap,
      counters: counters
        ? {
            pieceTxCount: counters.getPieceTxCount(),
            totalSatsDistributed: counters.getTotalSatsDistributed(),
            activeStreams: counters.getActiveStreams(),
          }
        : null,
    };
  });

  app.get('/agents', async (_request, reply) => {
    return reply.type('text/html').send(DASHBOARD_HTML);
  });
}

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>BitCoinTorrent — Agent Swarm</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700;900&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Inter', -apple-system, sans-serif;
      background: #fff; color: #111; padding: 2.5rem 3rem;
    }
    h1 {
      font-size: 3rem; font-weight: 900; letter-spacing: -0.03em;
      text-transform: uppercase; line-height: 0.9;
      padding-bottom: 1rem; border-bottom: 2px solid #000;
    }
    .tag {
      font-size: 0.7rem; letter-spacing: 0.15em; text-transform: uppercase;
      color: #999; margin-top: 0.5rem;
    }
    section { margin-top: 2.5rem; }
    h2 {
      font-size: 0.7rem; font-weight: 900; letter-spacing: 0.2em;
      text-transform: uppercase; color: #000; margin-bottom: 1rem;
      padding-bottom: 0.5rem; border-bottom: 1px solid #000;
    }
    .counters { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; }
    .counter {
      padding: 1.2rem; border: 1px solid #000;
    }
    .counter .label {
      font-size: 0.55rem; letter-spacing: 0.15em; text-transform: uppercase;
      color: #999; margin-bottom: 0.5rem;
    }
    .counter .value {
      font-size: 2rem; font-weight: 900; letter-spacing: -0.02em;
      line-height: 1;
    }
    table {
      width: 100%; border-collapse: collapse; font-size: 0.8rem;
    }
    th, td {
      text-align: left; padding: 0.6rem 0.8rem;
      border-bottom: 1px solid #eee;
    }
    th {
      font-size: 0.55rem; font-weight: 900; letter-spacing: 0.12em;
      text-transform: uppercase; color: #999;
    }
    td.mono {
      font-family: 'SF Mono', Monaco, monospace; font-size: 0.65rem;
      color: #333;
    }
    td.num { text-align: right; font-variant-numeric: tabular-nums; }
    .status {
      display: inline-block; font-size: 0.55rem; font-weight: 700;
      padding: 0.15rem 0.5rem; text-transform: uppercase; letter-spacing: 0.08em;
    }
    .status.open { background: #eee; color: #000; }
    .status.funded { background: #000; color: #fff; }
    .status.producing { background: #000; color: #fff; }
    .status.released { background: #000; color: #fff; }

    /* Productions grid — funded offers that have a generated artifact */
    .productions {
      display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
      gap: 1rem;
    }
    .production {
      border: 1px solid #000; padding: 0; overflow: hidden;
      display: flex; flex-direction: column;
    }
    .production .media {
      width: 100%; aspect-ratio: 16 / 9; background: #000;
      display: flex; align-items: center; justify-content: center;
      color: #666; font-size: 0.6rem; letter-spacing: 0.1em; text-transform: uppercase;
    }
    .production .media video,
    .production .media img {
      width: 100%; height: 100%; object-fit: cover; background: #000;
    }
    .production .meta {
      padding: 0.8rem 1rem; border-top: 1px solid #000;
    }
    .production .meta .t {
      font-size: 0.85rem; font-weight: 900; text-transform: uppercase;
      letter-spacing: -0.01em; line-height: 1.1;
    }
    .production .meta .sub {
      font-size: 0.55rem; color: #999; margin-top: 0.3rem;
      letter-spacing: 0.08em; text-transform: uppercase;
    }
    .production .meta a {
      font-size: 0.55rem; color: #000; text-decoration: none;
      border-bottom: 1px solid #000; font-weight: 700;
      letter-spacing: 0.08em; text-transform: uppercase;
    }
    .log {
      max-height: 320px; overflow-y: auto; font-size: 0.7rem;
      font-family: 'SF Mono', Monaco, monospace;
    }
    .log .row {
      padding: 0.4rem 0; border-bottom: 1px solid #f0f0f0;
    }
    .log .kind-tx { color: #000; font-weight: 700; }
    .log .kind-error { color: #c00; }
    .log .kind-event { color: #666; }
    .pulse {
      display: inline-block; width: 8px; height: 8px; background: #000;
      border-radius: 50%; animation: pulse 1s ease-in-out infinite;
      margin-right: 0.5rem; vertical-align: middle;
    }
    @keyframes pulse { 0%, 100% { opacity: 1 } 50% { opacity: 0.3 } }
  </style>
</head>
<body>
  <h1>AGENT SWARM</h1>
  <div class="tag"><span class="pulse"></span>Live — polling every 1s</div>

  <section>
    <h2>Counters</h2>
    <div class="counters">
      <div class="counter"><div class="label">On-chain piece TXs</div><div class="value" id="c-piece">—</div></div>
      <div class="counter"><div class="label">Sats distributed</div><div class="value" id="c-sats">—</div></div>
      <div class="counter"><div class="label">Active streams</div><div class="value" id="c-streams">—</div></div>
      <div class="counter"><div class="label">Presale mints</div><div class="value" id="c-presales">—</div></div>
    </div>
  </section>

  <section>
    <h2>Agents</h2>
    <table id="agents-table">
      <thead><tr>
        <th>Name</th><th>Role</th><th>Address</th><th>Running</th><th class="num">Log entries</th>
      </tr></thead>
      <tbody id="agents-body"></tbody>
    </table>
  </section>

  <section>
    <h2>Productions</h2>
    <div class="productions" id="productions-body"></div>
  </section>

  <section>
    <h2>Open offers</h2>
    <table id="offers-table">
      <thead><tr>
        <th>Title</th><th>Token</th><th>Producer</th><th class="num">Raised</th><th class="num">Target</th><th>Status</th>
      </tr></thead>
      <tbody id="offers-body"></tbody>
    </table>
  </section>

  <section>
    <h2>Swarm log</h2>
    <div class="log" id="log"></div>
  </section>

  <script>
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
    const fmt = (n) => (n ?? 0).toLocaleString();
    const addr = (a) => a ? a.slice(0,8) + '…' + a.slice(-4) : '—';

    async function refresh() {
      try {
        const res = await fetch('/api/agents/snapshot');
        const snap = await res.json();
        renderCounters(snap);
        renderAgents(snap.agents);
        renderProductions(snap.productions || []);
        renderOffers(snap.openOffers);
        renderLog(snap.recentLog);
      } catch (err) {
        console.error('refresh failed', err);
      }
    }

    function renderCounters(snap) {
      const c = snap.counters;
      document.getElementById('c-piece').textContent = fmt(c?.pieceTxCount);
      document.getElementById('c-sats').textContent = fmt(c?.totalSatsDistributed);
      document.getElementById('c-streams').textContent = fmt(c?.activeStreams);
      document.getElementById('c-presales').textContent = fmt(snap.presaleCount);
    }

    function renderProductions(productions) {
      const el = document.getElementById('productions-body');
      if (!productions.length) {
        el.innerHTML = '<div style="color:#999;font-size:0.7rem;padding:2rem 0;text-align:center;grid-column:1 / -1;">No productions yet. When an offer funds, its generated video will appear here.</div>';
        return;
      }
      el.innerHTML = productions.map((p) => {
        const artifact = p.artifact;
        let media;
        if (artifact && artifact.kind === 'video') {
          media = '<video muted loop autoplay playsinline src="' + esc(artifact.url) + '"></video>';
        } else if (artifact && artifact.kind === 'image') {
          media = '<img src="' + esc(artifact.url) + '" alt="' + esc(p.title) + '" />';
        } else if (p.status === 'producing') {
          media = '<span>Producing&hellip;</span>';
        } else {
          media = '<span>' + esc(p.status) + '</span>';
        }
        const holders = p.subscribers ? p.subscribers.length : 0;
        const sub =
          '$' + esc(p.tokenTicker) + ' &middot; ' +
          holders + ' holder' + (holders === 1 ? '' : 's') + ' &middot; ' +
          fmt(p.raisedSats) + ' sats';
        const link = artifact
          ? '<div style="margin-top:0.5rem"><a href="' + esc(artifact.url) + '" target="_blank" rel="noopener">Open content &rarr;</a></div>'
          : '';
        return '<div class="production">' +
          '<div class="media">' + media + '</div>' +
          '<div class="meta">' +
          '<div class="t">' + esc(p.title) + '</div>' +
          '<div class="sub">' + sub + '</div>' +
          link +
          '</div>' +
          '</div>';
      }).join('');
    }

    function renderAgents(agents) {
      const body = document.getElementById('agents-body');
      body.innerHTML = agents.map((a) =>
        '<tr>' +
        '<td><strong>' + esc(a.name) + '</strong></td>' +
        '<td>' + esc(a.role) + '</td>' +
        '<td class="mono">' + esc(a.address) + '</td>' +
        '<td>' + (a.running ? '✓' : '—') + '</td>' +
        '<td class="num">' + fmt(a.logCount) + '</td>' +
        '</tr>'
      ).join('');
    }

    function renderOffers(offers) {
      const body = document.getElementById('offers-body');
      if (!offers.length) {
        body.innerHTML = '<tr><td colspan="6" style="color:#999;text-align:center;padding:2rem;">No open offers</td></tr>';
        return;
      }
      body.innerHTML = offers.map((o) =>
        '<tr>' +
        '<td>' + esc(o.title) + '</td>' +
        '<td><strong>$' + esc(o.tokenTicker) + '</strong></td>' +
        '<td class="mono">' + addr(o.producerAddress) + '</td>' +
        '<td class="num">' + fmt(o.raisedSats) + '</td>' +
        '<td class="num">' + fmt(o.requiredSats) + '</td>' +
        '<td><span class="status ' + o.status + '">' + o.status + '</span></td>' +
        '</tr>'
      ).join('');
    }

    function renderLog(entries) {
      const el = document.getElementById('log');
      if (!entries || !entries.length) {
        el.innerHTML = '<div style="color:#999;padding:1rem 0;">No events yet</div>';
        return;
      }
      el.innerHTML = entries.map((e) => {
        const time = new Date(e.ts).toISOString().slice(11, 19);
        return '<div class="row kind-' + e.kind + '">' +
          '[' + time + '] ' + esc(e.agentId) + ' — ' + esc(e.message) +
          (e.txid ? ' <span style="color:#999">tx:' + esc(e.txid.slice(0,16)) + '…</span>' : '') +
          '</div>';
      }).join('');
    }

    refresh();
    setInterval(refresh, 1000);
  </script>
</body>
</html>`;
