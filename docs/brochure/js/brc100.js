/**
 * bMovies BRC-100 wallet primitive.
 *
 * Vendor-neutral wallet detection + payment flow for any BRC-100
 * compatible wallet (BSV Desktop, Metanet Client Desktop, Yours
 * Wallet, and future BRC-100 wallets). This module is the only
 * place the brochure touches a wallet — every page that needs a
 * signature, a payment, or an identity imports the helpers below
 * and never holds a private key itself.
 *
 * Why vanilla ES module loaded from a CDN?
 *   The brochure is a static site on Vercel with no bundler. We
 *   want to stay that way until the Metanet App Catalog listing
 *   is live, then we can move to a proper build pipeline. Until
 *   then, every import is a CDN URL and every page loads this
 *   module directly.
 *
 * Usage from a page:
 *
 *   <script type="module">
 *     import { connectWallet, payToAddress, walletStatus }
 *       from './js/brc100.js';
 *     const status = await connectWallet();
 *     if (status.connected) {
 *       const receipt = await payToAddress({
 *         address: '1EUs7z64...',
 *         satoshis: 1000,
 *         description: 'Register a bMovies pitch',
 *       });
 *       console.log('paid via', receipt.provider, 'txid', receipt.txid);
 *     }
 *   </script>
 *
 * What this is NOT:
 *   - An auth system. Use the returned address for identity; there
 *     is no session token, no cookie, no server.
 *   - A custodial wallet. We never touch private keys. Every
 *     payment is signed and broadcast by the user's own BRC-100
 *     wallet process.
 *   - HandCash. HandCash does not implement BRC-100 and is
 *     explicitly out of scope for the BSVA hackathon.
 */

// esm.sh pins the exact version the runner uses so the browser
// path and the Node path never drift.
const SDK_URL = 'https://esm.sh/@bsv/sdk@2.0.13';

// BSV Desktop (Dec 2025 rename of Metanet Desktop) exposes the
// BRC-100 interface on 3321 by default. Older builds used 2121;
// we probe both so the brochure works with any installed version.
const METANET_PORTS = [3321, 2121];

// Protocol tag used to scope key derivation for bMovies actions.
// Lets the wallet show "bmovies" in its "app permissions" UI and
// isolates our derived keys from other apps the user runs.
const PROTOCOL_ID = [1, 'bmovies'];

let _sdk = null;
let _client = null;
let _provider = null; // 'metanet' | 'yours' | null
let _address = null;
let _publicKey = null;

async function loadSdk() {
  if (_sdk) return _sdk;
  _sdk = await import(SDK_URL);
  return _sdk;
}

// ───────────── Detection ─────────────

/**
 * Probe localhost for a BSV Desktop / Metanet Client instance.
 * Returns the base URL if one responds, else null. We ping the
 * root with an OPTIONS request; the wallet's CORS preflight
 * answers even when no origin header is present.
 */
export async function detectMetanet() {
  for (const port of METANET_PORTS) {
    const url = `http://127.0.0.1:${port}`;
    try {
      const res = await fetch(url, {
        method: 'OPTIONS',
        signal: AbortSignal.timeout(1500),
      });
      if (res.ok || res.status === 405 || res.status === 200) {
        return url;
      }
    } catch {
      // port not listening — try next
    }
  }
  return null;
}

/**
 * Yours Wallet is a browser extension that exposes `window.yours`.
 * It speaks BRC-100 over a different substrate but the pay flow
 * is similar — we support it as a secondary provider.
 */
export function detectYoursWallet() {
  if (typeof window === 'undefined') return false;
  return Boolean(window.yours);
}

// ───────────── Connection ─────────────

/**
 * Try to connect to any available BRC-100 wallet. BSV Desktop /
 * Metanet Client is preferred; Yours Wallet is the fallback.
 * Returns a WalletStatus object regardless — callers should
 * check .connected before acting.
 */
export async function connectWallet() {
  const metanetUrl = await detectMetanet();
  if (metanetUrl) {
    return connectMetanet(metanetUrl);
  }
  if (detectYoursWallet()) {
    return connectYours();
  }
  return walletStatus();
}

async function connectMetanet(baseUrl) {
  try {
    const sdk = await loadSdk();
    const substrate = new sdk.HTTPWalletJSON(baseUrl);
    _client = new sdk.WalletClient(substrate);

    // Lightweight handshake — the wallet will prompt the user to
    // authorize bMovies on the very first call.
    const { publicKey } = await _client.getPublicKey({
      protocolID: PROTOCOL_ID,
      keyID: '1',
    });

    const pk = sdk.PublicKey.fromString(publicKey);
    _publicKey = publicKey;
    _address = pk.toAddress().toString();
    _provider = 'metanet';
    return walletStatus();
  } catch (err) {
    _client = null;
    _provider = null;
    _address = null;
    _publicKey = null;
    console.error('[brc100] Metanet connect failed:', err);
    return walletStatus(err);
  }
}

async function connectYours() {
  try {
    const yours = window.yours;
    if (!yours) throw new Error('yours wallet not present');

    const already = typeof yours.isConnected === 'function'
      ? await yours.isConnected()
      : false;
    if (!already) {
      await yours.connect();
    }
    const addresses = typeof yours.getAddresses === 'function'
      ? await yours.getAddresses()
      : {};
    _address = addresses?.bsvAddress || addresses?.identityAddress || null;
    _publicKey = addresses?.identityPubKey || null;
    _provider = 'yours';
    return walletStatus();
  } catch (err) {
    _provider = null;
    _address = null;
    _publicKey = null;
    console.error('[brc100] Yours connect failed:', err);
    return walletStatus(err);
  }
}

export function disconnectWallet() {
  _client = null;
  _provider = null;
  _address = null;
  _publicKey = null;
}

export function walletStatus(err) {
  return {
    connected: Boolean(_provider),
    provider: _provider,
    address: _address,
    publicKey: _publicKey,
    error: err ? (err instanceof Error ? err.message : String(err)) : null,
  };
}

// ───────────── Payment ─────────────

/**
 * Request a payment from the connected BRC-100 wallet. The wallet
 * pops up a native confirmation dialog; the user approves or
 * rejects; on approval the wallet signs and broadcasts the tx and
 * returns the txid. bMovies never sees the private key or the
 * unsigned tx — this is pure delegation.
 *
 * opts.address    BSV mainnet address to send to
 * opts.satoshis   amount in sats (positive integer)
 * opts.description short human-readable reason (5-50 chars), shown
 *                 to the user in the wallet prompt
 *
 * Returns { txid, provider } on success, throws on failure.
 */
export async function payToAddress(opts) {
  if (!_provider) {
    throw new Error('No wallet connected — call connectWallet() first.');
  }
  if (!opts || !opts.address || !opts.satoshis || !opts.description) {
    throw new Error('payToAddress requires { address, satoshis, description }');
  }
  if (!Number.isInteger(opts.satoshis) || opts.satoshis <= 0) {
    throw new Error('satoshis must be a positive integer');
  }

  if (_provider === 'metanet') {
    return payViaMetanet(opts);
  }
  if (_provider === 'yours') {
    return payViaYours(opts);
  }
  throw new Error(`Unsupported provider: ${_provider}`);
}

async function payViaMetanet({ address, satoshis, description }) {
  const sdk = await loadSdk();

  // Build a P2PKH locking script for the destination address.
  // The wallet requires a hex-encoded locking script in its
  // createAction outputs — we compute it here so the wallet
  // never has to resolve an address itself.
  const lockingScript = new sdk.P2PKH()
    .lock(address)
    .toHex();

  const result = await _client.createAction({
    description: truncateDescription(description),
    outputs: [
      {
        lockingScript,
        satoshis,
        outputDescription: truncateDescription(description),
      },
    ],
    labels: ['bmovies', 'payment'],
  });

  if (!result || !result.txid) {
    throw new Error('Wallet returned no txid');
  }
  return { txid: result.txid, provider: 'metanet' };
}

async function payViaYours({ address, satoshis, description }) {
  const yours = window.yours;
  if (!yours || typeof yours.sendBsv !== 'function') {
    throw new Error('Yours wallet does not expose sendBsv');
  }

  // Yours's sendBsv() internally broadcasts via 1sat.app's indexer,
  // which can go down or flap with 500/504/409/404 responses. When
  // that happens Yours's promise may never resolve, or may resolve
  // with a non-standard error. We set a 25-second timeout so the
  // caller's UI never hangs forever, and return a clear reason when
  // the backend is unreachable so the operator can see it.
  const TIMEOUT_MS = 25_000;
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          'Yours wallet timed out after 25s — Yours may have broadcast ' +
            'the tx but its 1sat.app backend is unresponsive. Check your ' +
            'Yours wallet UI for the txid, or query WoC for recent txs ' +
            'from your address.',
        ),
      );
    }, TIMEOUT_MS);
  });

  let result;
  try {
    result = await Promise.race([
      yours.sendBsv([
        {
          address,
          satoshis,
          description: truncateDescription(description),
        },
      ]),
      timeoutPromise,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }

  // Yours returns { txid, rawtx } in newer versions, or just a
  // string txid in older ones. Accept both.
  const txid =
    typeof result === 'string'
      ? result
      : result?.txid || result?.txId || result?.hash || null;

  if (!txid) {
    // Some Yours versions return an error shape like
    // { error: "Failed to..." } instead of throwing.
    const errMsg = result?.error || result?.message;
    if (errMsg) {
      throw new Error('Yours wallet: ' + errMsg);
    }
    throw new Error(
      'Yours wallet returned no txid. Response: ' +
        JSON.stringify(result ?? null).slice(0, 200),
    );
  }
  return { txid, provider: 'yours' };
}

// BRC-100 restricts description strings to 5-50 bytes. Pages
// can pass whatever they like and we'll clip it safely.
function truncateDescription(s) {
  if (!s) return 'bMovies payment';
  const clean = String(s).replace(/\s+/g, ' ').trim();
  if (clean.length < 5) return (clean + ' (bmovies)').slice(0, 50);
  if (clean.length > 50) return clean.slice(0, 50);
  return clean;
}

// ───────────── Download CTA ─────────────

/**
 * When no wallet is detected, pages can call this to get a
 * human-readable "install a wallet" message + link. Keeps the
 * upgrade path in one place so we can update the CTA if the
 * canonical wallet URL changes.
 */
export function walletInstallPrompt() {
  return {
    heading: 'Connect a BRC-100 wallet',
    body:
      'bMovies is a BRC-100 app. To pay, commission a film, or unlock a watch, ' +
      'you need a compatible wallet running on your machine. The easiest path is ' +
      'BSV Desktop — download, create a wallet, and refresh this page.',
    primary: {
      label: 'Get BSV Desktop',
      href: 'https://github.com/bsv-blockchain/bsv-desktop/releases/latest',
    },
    secondary: {
      label: 'What is BRC-100?',
      href: 'https://github.com/bitcoin-sv/BRCs/blob/master/wallet/0100.md',
    },
  };
}
