/**
 * Torrent file creator for bMovies.
 *
 * Creates a .torrent file from an fMP4 file using create-torrent,
 * with BCT metadata embedded in the info dict.
 */

import createTorrent from 'create-torrent';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { stat } from 'node:fs/promises';
import parseTorrent, { toMagnetURI } from 'parse-torrent';
import { DEFAULTS, DEFAULT_TRACKERS } from '../types/config.js';

const createTorrentAsync = promisify(createTorrent);

export interface TorrentCreateOptions {
  /** Path to the fMP4 file */
  fmp4Path: string;
  /** Content name/title */
  name: string;
  /** Piece length in bytes (default: 256KB) */
  pieceLength?: number;
  /** MIME codec string for MSE */
  mimeCodec: string;
  /** Number of init segment pieces */
  initPieceCount: number;
  /** Additional WebSocket tracker URLs */
  trackers?: string[];
}

export interface TorrentCreateResult {
  /** Raw .torrent file bytes */
  torrentFile: Buffer;
  /** Infohash (hex) */
  infohash: string;
  /** Magnet URI */
  magnetURI: string;
  /** Total pieces in the torrent */
  totalPieces: number;
  /** Piece length used */
  pieceLength: number;
}

/**
 * Create a .torrent file from an fMP4 file.
 */
export async function createTorrentFile(
  opts: TorrentCreateOptions,
): Promise<TorrentCreateResult> {
  const pieceLength = opts.pieceLength ?? DEFAULTS.pieceLength;

  // WebSocket trackers for WebTorrent browser peers
  const announceList = [
    ...DEFAULT_TRACKERS.map((t) => [t]),
    ...(opts.trackers ?? []).map((t) => [t]),
  ];

  const torrentBuf = await createTorrentAsync(opts.fmp4Path, {
    name: opts.name,
    pieceLength,
    announceList,
    createdBy: 'bMovies/0.1.0',
    comment: 'bMovies — P2P streaming with BSV micropayments',
    // Embed BCT metadata in the info dict
    info: {
      'bct-version': 1,
      'bct-codec': opts.mimeCodec,
      'bct-init-pieces': opts.initPieceCount,
    },
  });

  const torrentFile = Buffer.from(torrentBuf);

  // Parse to extract infohash and piece count
  const parsed = await parseTorrent(torrentFile);

  const fmp4Stat = await stat(opts.fmp4Path);
  const totalPieces = Math.ceil(fmp4Stat.size / pieceLength);

  return {
    torrentFile,
    infohash: parsed.infoHash ?? '',
    magnetURI: toMagnetURI(parsed),
    totalPieces,
    pieceLength,
  };
}

/**
 * Save a .torrent file and its manifest to disk.
 */
export async function saveTorrentFile(
  torrentFile: Buffer,
  outputPath: string,
): Promise<void> {
  await writeFile(outputPath, torrentFile);
}
