/**
 * Video → Fragmented MP4 chunker.
 *
 * Converts standard MP4 to fMP4 (fragmented MP4) using ffmpeg.
 * fMP4 is required for MediaSource API streaming — each fragment
 * is independently decodable once the init segment is loaded.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

/** Probe result from ffprobe */
export interface VideoProbe {
  duration: number;
  width: number;
  height: number;
  videoCodec: string;
  audioCodec: string;
  /** MIME codec string for MediaSource API */
  mimeCodec: string;
  totalBytes: number;
}

/** Result of fMP4 conversion */
export interface ChunkResult {
  /** Path to the fMP4 file */
  fmp4Path: string;
  /** Size of the fMP4 file in bytes */
  totalBytes: number;
  /** Video probe info */
  probe: VideoProbe;
  /** Temp directory (caller should clean up) */
  tmpDir: string;
}

/**
 * Probe a video file with ffprobe.
 * Extracts duration, codecs, dimensions.
 */
export async function probeVideo(inputPath: string): Promise<VideoProbe> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    inputPath,
  ]);

  const info = JSON.parse(stdout);
  const videoStream = info.streams?.find((s: any) => s.codec_type === 'video');
  const audioStream = info.streams?.find((s: any) => s.codec_type === 'audio');

  if (!videoStream) {
    throw new Error('No video stream found');
  }

  const duration = parseFloat(info.format?.duration ?? '0');
  const totalBytes = parseInt(info.format?.size ?? '0', 10);

  // Build MIME codec string for MediaSource
  // For H.264: video/mp4; codecs="avc1.XXYYZZ"
  // For H.265: video/mp4; codecs="hev1.1.6.L93.B0"
  // Simplified: use codec profile from ffprobe
  const videoCodec = videoStream.codec_name ?? 'h264';
  const audioCodec = audioStream?.codec_name ?? 'aac';

  let mimeCodec: string;
  if (videoCodec === 'h264') {
    // Extract profile/level from codec tag
    const profile = videoStream.profile ?? 'Baseline';
    const level = videoStream.level ?? 30;
    const profileHex = profileToHex(profile);
    const levelHex = level.toString(16).padStart(2, '0');
    const codecStr = `avc1.${profileHex}00${levelHex}`;
    const audioStr = audioCodec === 'aac' ? ', mp4a.40.2' : '';
    mimeCodec = `video/mp4; codecs="${codecStr}${audioStr}"`;
  } else {
    // Fallback for non-H.264
    mimeCodec = `video/mp4; codecs="${videoCodec}${audioCodec ? ', ' + audioCodec : ''}"`;
  }

  return {
    duration,
    width: videoStream.width ?? 0,
    height: videoStream.height ?? 0,
    videoCodec,
    audioCodec,
    mimeCodec,
    totalBytes,
  };
}

/** Map H.264 profile name to hex code */
function profileToHex(profile: string): string {
  const map: Record<string, string> = {
    Baseline: '42',
    'Constrained Baseline': '42',
    Main: '4d',
    High: '64',
    'High 10': '6e',
    'High 4:2:2': '7a',
    'High 4:4:4 Predictive': 'f4',
  };
  return map[profile] ?? '42';
}

/**
 * Convert a video file to fragmented MP4.
 *
 * Uses ffmpeg with:
 * - frag_keyframe: new fragment at every keyframe
 * - empty_moov: init segment has no samples
 * - default_base_moof: required for MSE compatibility
 *
 * @param inputPath - Path to the input video file
 * @returns ChunkResult with path to fMP4 and metadata
 */
export async function chunkVideo(inputPath: string): Promise<ChunkResult> {
  // Probe first
  const probe = await probeVideo(inputPath);

  // Create temp directory for output
  const tmpDir = await mkdtemp(join(tmpdir(), 'bct-'));
  const fmp4Path = join(tmpDir, 'output.fmp4');

  // Convert to fragmented MP4
  await execFileAsync('ffmpeg', [
    '-i', inputPath,
    '-c:v', 'copy',        // no re-encoding
    '-c:a', 'copy',        // no re-encoding
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4',
    '-y',                   // overwrite
    fmp4Path,
  ], { timeout: 120_000 });

  const fmp4Stat = await stat(fmp4Path);

  return {
    fmp4Path,
    totalBytes: fmp4Stat.size,
    probe: { ...probe, totalBytes: fmp4Stat.size },
    tmpDir,
  };
}

/**
 * Read the init segment from an fMP4 file.
 *
 * The init segment is the ftyp + moov atoms at the start of the file.
 * We find it by looking for the first moof atom — everything before it
 * is the init segment.
 */
export async function extractInitSegment(fmp4Path: string): Promise<Buffer> {
  const data = await readFile(fmp4Path);

  // Walk MP4 atoms to find the first 'moof' box
  let offset = 0;
  while (offset < data.length - 8) {
    const size = data.readUInt32BE(offset);
    const type = data.subarray(offset + 4, offset + 8).toString('ascii');

    if (type === 'moof') {
      // Everything before this is the init segment
      return data.subarray(0, offset);
    }

    if (size === 0) break; // size 0 = extends to EOF
    if (size < 8) break;   // invalid
    offset += size;
  }

  throw new Error('No moof atom found — file may not be fragmented MP4');
}

/**
 * Build a fragment map: which byte ranges correspond to each moof+mdat pair.
 *
 * @returns Array of { offset, size } for each fragment
 */
export async function buildFragmentMap(
  fmp4Path: string,
  pieceLength: number,
): Promise<Array<{ startPiece: number; endPiece: number }>> {
  const data = await readFile(fmp4Path);
  const fragments: Array<{ offset: number; size: number }> = [];

  let offset = 0;
  let currentFragStart = -1;

  while (offset < data.length - 8) {
    const size = data.readUInt32BE(offset);
    const type = data.subarray(offset + 4, offset + 8).toString('ascii');

    if (type === 'moof') {
      currentFragStart = offset;
    } else if (type === 'mdat' && currentFragStart >= 0) {
      // Fragment = moof + mdat
      const fragSize = (offset + size) - currentFragStart;
      fragments.push({ offset: currentFragStart, size: fragSize });
      currentFragStart = -1;
    }

    if (size === 0) break;
    if (size < 8) break;
    offset += size;
  }

  // Convert byte ranges to piece ranges
  return fragments.map((frag) => ({
    startPiece: Math.floor(frag.offset / pieceLength),
    endPiece: Math.floor((frag.offset + frag.size - 1) / pieceLength),
  }));
}

/** Clean up temporary directory */
export async function cleanupChunkResult(result: ChunkResult): Promise<void> {
  await rm(result.tmpDir, { recursive: true, force: true });
}
