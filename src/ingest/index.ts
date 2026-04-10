/**
 * Content ingestion pipeline.
 *
 * Takes a video file and produces:
 * 1. A .torrent file (with BCT metadata)
 * 2. A ContentManifest (pricing, codec info, fragment map)
 * 3. The fMP4 file ready for seeding
 */

import { chunkVideo, extractInitSegment, buildFragmentMap, cleanupChunkResult } from './chunker.js';
import { createManifest, serializeManifest } from './manifest.js';
import { createTorrentFile } from './torrent-creator.js';
import type { ContentManifest, IngestResult } from '../types/torrent.js';
import { DEFAULTS } from '../types/config.js';
import { copyFile, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';

export interface IngestOptions {
  /** Path to the input video file */
  videoPath: string;
  /** Content title */
  title: string;
  /** Creator's BSV address */
  creatorAddress: string;
  /** Creator name (optional) */
  creatorName?: string;
  /** Satoshis per piece (default: 1) */
  satsPerPiece?: number;
  /** Creator split in basis points (default: 6000 = 60%) */
  creatorSplitBps?: number;
  /** Piece length in bytes (default: 256KB) */
  pieceLength?: number;
  /** Output directory for .torrent and manifest files */
  outputDir?: string;
}

export interface FullIngestResult extends IngestResult {
  /** Path to the fMP4 file (in output dir or temp) */
  fmp4Path: string;
}

/**
 * Ingest a video file into the bMovies system.
 *
 * Pipeline:
 * 1. ffmpeg: MP4 → fMP4
 * 2. Extract init segment, build fragment map
 * 3. create-torrent: fMP4 → .torrent
 * 4. Generate manifest
 */
export async function ingest(opts: IngestOptions): Promise<FullIngestResult> {
  const pieceLength = opts.pieceLength ?? DEFAULTS.pieceLength;

  // Step 1: Convert to fMP4
  const chunkResult = await chunkVideo(opts.videoPath);

  try {
    // Step 2: Extract init segment and build fragment map
    const initSegment = await extractInitSegment(chunkResult.fmp4Path);
    const initPieceCount = Math.ceil(initSegment.length / pieceLength);
    const fragmentMap = await buildFragmentMap(chunkResult.fmp4Path, pieceLength);

    // Step 3: Create torrent
    const torrentResult = await createTorrentFile({
      fmp4Path: chunkResult.fmp4Path,
      name: opts.title,
      pieceLength,
      mimeCodec: chunkResult.probe.mimeCodec,
      initPieceCount,
    });

    // Step 4: Create manifest
    const manifest = createManifest({
      infohash: torrentResult.infohash,
      title: opts.title,
      probe: chunkResult.probe,
      totalPieces: torrentResult.totalPieces,
      totalBytes: chunkResult.totalBytes,
      initPieceCount,
      fragmentMap,
      creatorAddress: opts.creatorAddress,
      creatorName: opts.creatorName,
      satsPerPiece: opts.satsPerPiece,
      creatorSplitBps: opts.creatorSplitBps,
    });

    // Step 5: Copy files to output directory if specified
    let fmp4Path = chunkResult.fmp4Path;
    if (opts.outputDir) {
      const outFmp4 = join(opts.outputDir, `${opts.title}.fmp4`);
      const outTorrent = join(opts.outputDir, `${opts.title}.torrent`);
      const outManifest = join(opts.outputDir, `${opts.title}.manifest.json`);

      await copyFile(chunkResult.fmp4Path, outFmp4);
      await writeFile(outTorrent, torrentResult.torrentFile);
      await writeFile(outManifest, serializeManifest(manifest));

      fmp4Path = outFmp4;

      // Clean up temp
      await cleanupChunkResult(chunkResult);
    }

    return {
      torrentFile: torrentResult.torrentFile,
      manifest,
      infohash: torrentResult.infohash,
      magnetURI: torrentResult.magnetURI,
      fmp4Path,
    };
  } catch (err) {
    // Clean up temp on error
    await cleanupChunkResult(chunkResult).catch(() => {});
    throw err;
  }
}

// Re-export submodules
export { chunkVideo, probeVideo, extractInitSegment, buildFragmentMap } from './chunker.js';
export { createManifest, estimateTotalCost, serializeManifest, deserializeManifest } from './manifest.js';
export { createTorrentFile, saveTorrentFile } from './torrent-creator.js';
