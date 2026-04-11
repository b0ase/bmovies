/**
 * bMovies Browser Player.
 *
 * Connects the pieces:
 * - Fetches manifest via $402 gate
 * - Starts WebTorrent with bct_pay extension
 * - Uses PiecePicker for sequential selection
 * - Feeds pieces to MediaSource via BufferManager
 * - Manages payment channels per peer
 *
 * This file is designed to be bundled for the browser.
 * For the PoC, it's used as a reference implementation —
 * the actual browser demo uses inline <script> with WebTorrent CDN.
 */

import type { ContentManifest } from '../types/torrent.js';

interface ManifestResponse402 {
  torrent: { manifest: ContentManifest; magnetURI: string };
  accepts: Array<{ estimatedCost: number }>;
}

interface ManifestResponse200 {
  manifest: ContentManifest;
  magnetURI: string;
}

export interface PlayerState {
  status: 'idle' | 'loading' | 'buffering' | 'playing' | 'paused' | 'error';
  infohash: string;
  title: string;
  piecesReceived: number;
  totalPieces: number;
  satsSpent: number;
  peers: number;
  bufferHealth: number;
  error?: string;
}

/**
 * Fetch manifest from the $402 gate.
 * Returns the 402 response with manifest and magnet URI.
 */
export async function fetchManifest(
  apiUrl: string,
  infohash: string,
): Promise<{
  manifest: ContentManifest;
  magnetURI: string;
  estimatedCost: number;
}> {
  const res = await fetch(`${apiUrl}/api/stream/${infohash}`);

  if (res.status === 402) {
    const data = (await res.json()) as ManifestResponse402;
    return {
      manifest: data.torrent.manifest,
      magnetURI: data.torrent.magnetURI,
      estimatedCost: data.accepts[0].estimatedCost,
    };
  }

  if (res.status === 200) {
    const data = (await res.json()) as ManifestResponse200;
    return {
      manifest: data.manifest,
      magnetURI: data.magnetURI,
      estimatedCost: 0,
    };
  }

  throw new Error(`Unexpected status: ${res.status}`);
}

/**
 * Format satoshis for display.
 */
export function formatSats(sats: number): string {
  if (sats >= 100_000_000) return `${(sats / 100_000_000).toFixed(8)} BSV`;
  if (sats >= 1000) return `${(sats / 1000).toFixed(1)}k sats`;
  return `${sats} sats`;
}
