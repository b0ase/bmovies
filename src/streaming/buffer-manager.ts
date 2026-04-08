/**
 * Buffer manager for streaming playback.
 *
 * Stores received torrent pieces, assembles them into complete
 * fMP4 fragments, and manages memory by evicting old pieces.
 */

import type { FragmentRange } from '../types/torrent.js';

export interface BufferManagerOptions {
  totalPieces: number;
  pieceLength: number;
  /** Number of pieces in the init segment */
  initPieceCount: number;
  fragmentMap: FragmentRange[];
  /** Total file size (for last piece calculation) */
  totalBytes: number;
}

export class BufferManager {
  readonly totalPieces: number;
  readonly pieceLength: number;
  readonly initPieceCount: number;
  readonly fragmentMap: FragmentRange[];
  readonly totalBytes: number;

  private pieces = new Map<number, Buffer>();
  private assembledFragments = new Set<number>();

  constructor(opts: BufferManagerOptions) {
    this.totalPieces = opts.totalPieces;
    this.pieceLength = opts.pieceLength;
    this.initPieceCount = opts.initPieceCount;
    this.fragmentMap = opts.fragmentMap;
    this.totalBytes = opts.totalBytes;
  }

  /** Store a received piece */
  storePiece(index: number, data: Buffer): void {
    this.pieces.set(index, data);
  }

  /** Check if a piece is stored */
  hasPiece(index: number): boolean {
    return this.pieces.has(index);
  }

  /** Get a stored piece */
  getPiece(index: number): Buffer | undefined {
    return this.pieces.get(index);
  }

  /**
   * Check if the init segment is complete.
   */
  get initComplete(): boolean {
    for (let i = 0; i < this.initPieceCount; i++) {
      if (!this.pieces.has(i)) return false;
    }
    return true;
  }

  /**
   * Get the init segment (assembled from its pieces).
   * Returns null if not all init pieces are received.
   */
  getInitSegment(): Buffer | null {
    if (!this.initComplete) return null;

    const parts: Buffer[] = [];
    for (let i = 0; i < this.initPieceCount; i++) {
      parts.push(this.pieces.get(i)!);
    }
    return Buffer.concat(parts);
  }

  /**
   * Check if a fragment is complete (all its pieces are received).
   */
  isFragmentComplete(fragmentIndex: number): boolean {
    const frag = this.fragmentMap[fragmentIndex];
    if (!frag) return false;

    for (let p = frag.startPiece; p <= frag.endPiece; p++) {
      if (!this.pieces.has(p)) return false;
    }
    return true;
  }

  /**
   * Assemble a complete fragment from its pieces.
   * Returns null if the fragment is not complete.
   */
  assembleFragment(fragmentIndex: number): Buffer | null {
    if (!this.isFragmentComplete(fragmentIndex)) return null;

    const frag = this.fragmentMap[fragmentIndex];
    const parts: Buffer[] = [];
    for (let p = frag.startPiece; p <= frag.endPiece; p++) {
      parts.push(this.pieces.get(p)!);
    }

    this.assembledFragments.add(fragmentIndex);
    return Buffer.concat(parts);
  }

  /**
   * Get indices of all fragments that are complete but not yet assembled.
   */
  getReadyFragments(): number[] {
    const ready: number[] = [];
    for (let i = 0; i < this.fragmentMap.length; i++) {
      if (!this.assembledFragments.has(i) && this.isFragmentComplete(i)) {
        ready.push(i);
      }
    }
    return ready;
  }

  /**
   * Evict pieces that are far behind the playback position.
   * Keeps init pieces and pieces within `keepBehind` of current position.
   *
   * @param currentPiece - Current playback piece index
   * @param keepBehind - Number of pieces to keep behind playback
   * @returns Number of pieces evicted
   */
  evict(currentPiece: number, keepBehind: number = 5): number {
    let evicted = 0;
    const evictBefore = currentPiece - keepBehind;

    for (const [index] of this.pieces) {
      // Never evict init pieces
      if (index < this.initPieceCount) continue;
      if (index < evictBefore) {
        this.pieces.delete(index);
        evicted++;
      }
    }

    return evicted;
  }

  /** Number of pieces currently stored */
  get storedCount(): number {
    return this.pieces.size;
  }

  /** Approximate memory usage in bytes */
  get memoryUsage(): number {
    let total = 0;
    for (const buf of this.pieces.values()) {
      total += buf.length;
    }
    return total;
  }
}
