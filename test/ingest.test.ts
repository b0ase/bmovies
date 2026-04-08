import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  probeVideo,
  chunkVideo,
  extractInitSegment,
  buildFragmentMap,
  cleanupChunkResult,
} from '../src/ingest/chunker.js';
import { createManifest, estimateTotalCost } from '../src/ingest/manifest.js';
import { createTorrentFile } from '../src/ingest/torrent-creator.js';
import { ingest } from '../src/ingest/index.js';
import { DEFAULTS } from '../src/types/config.js';

const execFileAsync = promisify(execFile);

let testDir: string;
let testVideoPath: string;

beforeAll(async () => {
  // Create temp dir and generate a 5-second test video
  testDir = await mkdtemp(join(tmpdir(), 'bct-test-'));
  testVideoPath = join(testDir, 'test.mp4');

  // Generate 5s color bars with tone using ffmpeg
  await execFileAsync('ffmpeg', [
    '-f', 'lavfi', '-i', 'testsrc=duration=5:size=640x360:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-profile:v', 'baseline',
    '-c:a', 'aac', '-b:a', '64k',
    '-pix_fmt', 'yuv420p',
    '-y', testVideoPath,
  ], { timeout: 30_000 });
}, 60_000);

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe('probeVideo', () => {
  it('should extract video metadata', async () => {
    const probe = await probeVideo(testVideoPath);

    expect(probe.duration).toBeGreaterThanOrEqual(4.5);
    expect(probe.duration).toBeLessThanOrEqual(6);
    expect(probe.width).toBe(640);
    expect(probe.height).toBe(360);
    expect(probe.videoCodec).toBe('h264');
    expect(probe.audioCodec).toBe('aac');
    expect(probe.mimeCodec).toContain('avc1');
    expect(probe.mimeCodec).toContain('mp4a.40.2');
    expect(probe.totalBytes).toBeGreaterThan(0);
  });
});

describe('chunkVideo', () => {
  it('should convert MP4 to fragmented MP4', async () => {
    const result = await chunkVideo(testVideoPath);

    expect(result.fmp4Path).toContain('.fmp4');
    expect(result.totalBytes).toBeGreaterThan(0);
    expect(result.probe.videoCodec).toBe('h264');

    // Verify the fMP4 file exists and is non-empty
    const fstat = await stat(result.fmp4Path);
    expect(fstat.size).toBeGreaterThan(0);

    await cleanupChunkResult(result);
  });
});

describe('extractInitSegment', () => {
  it('should extract init segment from fMP4', async () => {
    const result = await chunkVideo(testVideoPath);
    const initSeg = await extractInitSegment(result.fmp4Path);

    // Init segment should be relatively small (< 10KB for a simple video)
    expect(initSeg.length).toBeGreaterThan(0);
    expect(initSeg.length).toBeLessThan(50_000);

    // Should start with ftyp box
    const ftyp = initSeg.subarray(4, 8).toString('ascii');
    expect(ftyp).toBe('ftyp');

    await cleanupChunkResult(result);
  });
});

describe('buildFragmentMap', () => {
  it('should map fragments to piece ranges', async () => {
    const result = await chunkVideo(testVideoPath);
    const fragmentMap = await buildFragmentMap(result.fmp4Path, DEFAULTS.pieceLength);

    // Should have at least 1 fragment (5s video with keyframes)
    expect(fragmentMap.length).toBeGreaterThan(0);

    // Each fragment should have valid piece ranges
    for (const frag of fragmentMap) {
      expect(frag.startPiece).toBeGreaterThanOrEqual(0);
      expect(frag.endPiece).toBeGreaterThanOrEqual(frag.startPiece);
    }

    // Fragments should be in order
    for (let i = 1; i < fragmentMap.length; i++) {
      expect(fragmentMap[i].startPiece).toBeGreaterThanOrEqual(
        fragmentMap[i - 1].startPiece,
      );
    }

    await cleanupChunkResult(result);
  });
});

describe('createTorrentFile', () => {
  it('should create a .torrent with BCT metadata', async () => {
    const chunkResult = await chunkVideo(testVideoPath);
    const initSeg = await extractInitSegment(chunkResult.fmp4Path);
    const initPieceCount = Math.ceil(initSeg.length / DEFAULTS.pieceLength);

    const result = await createTorrentFile({
      fmp4Path: chunkResult.fmp4Path,
      name: 'Test Video',
      mimeCodec: chunkResult.probe.mimeCodec,
      initPieceCount,
    });

    expect(result.infohash).toHaveLength(40); // hex SHA-1
    expect(result.magnetURI).toContain('magnet:?xt=urn:btih:');
    expect(result.totalPieces).toBeGreaterThan(0);
    expect(result.pieceLength).toBe(DEFAULTS.pieceLength);
    expect(result.torrentFile.length).toBeGreaterThan(0);

    await cleanupChunkResult(chunkResult);
  });
});

describe('createManifest', () => {
  it('should create a valid manifest', async () => {
    const probe = await probeVideo(testVideoPath);

    const manifest = createManifest({
      infohash: 'a'.repeat(40),
      title: 'Test Video',
      probe,
      totalPieces: 100,
      totalBytes: 25_600_000,
      initPieceCount: 1,
      fragmentMap: [
        { startPiece: 1, endPiece: 10 },
        { startPiece: 11, endPiece: 20 },
      ],
      creatorAddress: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
      creatorName: 'Test Creator',
      satsPerPiece: 2,
      creatorSplitBps: 7000,
    });

    expect(manifest.version).toBe(1);
    expect(manifest.pricing.satsPerPiece).toBe(2);
    expect(manifest.pricing.initPiecesFree).toBe(true);
    expect(manifest.creator.splitBps).toBe(7000);
    expect(manifest.codec.mimeCodec).toContain('avc1');
    expect(manifest.codec.initPieceCount).toBe(1);
    expect(manifest.codec.fragmentMap).toHaveLength(2);

    const cost = estimateTotalCost(manifest);
    // 100 pieces - 1 init piece = 99 payable, 99 * 2 sats = 198
    expect(cost).toBe(198);
  });
});

describe('Full ingest pipeline', () => {
  it('should ingest a video end-to-end', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'bct-out-'));

    try {
      const result = await ingest({
        videoPath: testVideoPath,
        title: 'TestVideo',
        creatorAddress: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
        creatorName: 'Satoshi',
        satsPerPiece: 5,
        outputDir,
      });

      // Check IngestResult
      expect(result.infohash).toHaveLength(40);
      expect(result.magnetURI).toContain('magnet:');
      expect(result.torrentFile.length).toBeGreaterThan(0);

      // Check manifest
      expect(result.manifest.version).toBe(1);
      expect(result.manifest.title).toBe('TestVideo');
      expect(result.manifest.pricing.satsPerPiece).toBe(5);
      expect(result.manifest.creator.address).toBe(
        '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
      );
      expect(result.manifest.codec.fragmentMap.length).toBeGreaterThan(0);
      expect(result.manifest.totalPieces).toBeGreaterThan(0);

      // Check output files exist
      const torrentStat = await stat(join(outputDir, 'TestVideo.torrent'));
      expect(torrentStat.size).toBeGreaterThan(0);

      const manifestStat = await stat(join(outputDir, 'TestVideo.manifest.json'));
      expect(manifestStat.size).toBeGreaterThan(0);

      const fmp4Stat = await stat(join(outputDir, 'TestVideo.fmp4'));
      expect(fmp4Stat.size).toBeGreaterThan(0);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  }, 30_000);
});
