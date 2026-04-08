/**
 * Content manifest generator.
 *
 * Creates a ContentManifest from chunked fMP4 output,
 * containing pricing, codec info, and fragment-to-piece mapping.
 */

import type { ContentManifest, FragmentRange } from '../types/torrent.js';
import type { VideoProbe } from './chunker.js';
import { DEFAULTS } from '../types/config.js';

export interface ManifestOptions {
  /** Torrent infohash (hex) */
  infohash: string;
  title: string;
  /** Video probe results */
  probe: VideoProbe;
  /** Total pieces in the torrent */
  totalPieces: number;
  /** Total bytes of the fMP4 file */
  totalBytes: number;
  /** Number of pieces forming the init segment */
  initPieceCount: number;
  /** Fragment-to-piece mapping */
  fragmentMap: FragmentRange[];

  /** Creator's BSV address */
  creatorAddress: string;
  /** Creator name (optional) */
  creatorName?: string;
  /** Satoshis per piece (default: 1) */
  satsPerPiece?: number;
  /** Creator split in basis points (default: 6000 = 60%) */
  creatorSplitBps?: number;
}

/**
 * Create a ContentManifest from ingestion results.
 */
export function createManifest(opts: ManifestOptions): ContentManifest {
  return {
    version: 1,
    infohash: opts.infohash,
    title: opts.title,
    contentType: 'video/mp4',
    duration: opts.probe.duration,
    totalPieces: opts.totalPieces,
    totalBytes: opts.totalBytes,
    pricing: {
      satsPerPiece: opts.satsPerPiece ?? DEFAULTS.satsPerPiece,
      initPiecesFree: true,
      currency: 'BSV',
    },
    creator: {
      address: opts.creatorAddress,
      name: opts.creatorName,
      splitBps: opts.creatorSplitBps ?? DEFAULTS.creatorSplitBps,
    },
    codec: {
      mimeCodec: opts.probe.mimeCodec,
      initPieceCount: opts.initPieceCount,
      fragmentMap: opts.fragmentMap,
    },
  };
}

/**
 * Estimate total cost to stream entire content.
 */
export function estimateTotalCost(manifest: ContentManifest): number {
  const payablePieces = manifest.pricing.initPiecesFree
    ? manifest.totalPieces - manifest.codec.initPieceCount
    : manifest.totalPieces;
  return payablePieces * manifest.pricing.satsPerPiece;
}

/**
 * Serialize manifest to JSON.
 */
export function serializeManifest(manifest: ContentManifest): string {
  return JSON.stringify(manifest, null, 2);
}

/**
 * Deserialize manifest from JSON.
 */
export function deserializeManifest(json: string): ContentManifest {
  return JSON.parse(json) as ContentManifest;
}
