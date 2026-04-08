/**
 * Sequential piece picker for streaming playback.
 *
 * Priorities:
 * 1. Init segment pieces (CRITICAL) — needed before any playback
 * 2. Current fragment pieces (HIGH) — the fragment at playback position
 * 3. Lookahead pieces (NORMAL) — next N pieces for smooth playback
 * 4. Everything else (LOW) — rarest-first for swarm health
 */

import { PiecePriority, type PieceState, type BufferHealth } from '../types/streaming.js';
import type { FragmentRange } from '../types/torrent.js';

export interface PiecePickerOptions {
  totalPieces: number;
  initPieceCount: number;
  fragmentMap: FragmentRange[];
  /** Number of pieces to buffer ahead (default: 10) */
  lookahead?: number;
  /** Estimated duration per piece in seconds (for buffer health) */
  secondsPerPiece?: number;
}

export class PiecePicker {
  readonly totalPieces: number;
  readonly initPieceCount: number;
  readonly fragmentMap: FragmentRange[];
  readonly lookahead: number;
  readonly secondsPerPiece: number;

  private pieceStates: PieceState[];
  private playbackPiece = 0;

  constructor(opts: PiecePickerOptions) {
    this.totalPieces = opts.totalPieces;
    this.initPieceCount = opts.initPieceCount;
    this.fragmentMap = opts.fragmentMap;
    this.lookahead = opts.lookahead ?? 10;
    this.secondsPerPiece = opts.secondsPerPiece ?? 0.5;

    this.pieceStates = new Array(opts.totalPieces).fill('missing');
  }

  /** Update the current playback position (piece index) */
  setPlaybackPiece(pieceIndex: number): void {
    this.playbackPiece = Math.max(0, Math.min(pieceIndex, this.totalPieces - 1));
  }

  /** Mark a piece as received */
  markReceived(pieceIndex: number): void {
    if (pieceIndex >= 0 && pieceIndex < this.totalPieces) {
      this.pieceStates[pieceIndex] = 'received';
    }
  }

  /** Mark a piece as requested (in-flight) */
  markRequested(pieceIndex: number): void {
    if (pieceIndex >= 0 && pieceIndex < this.totalPieces) {
      this.pieceStates[pieceIndex] = 'requested';
    }
  }

  /** Get the state of a piece */
  getPieceState(pieceIndex: number): PieceState {
    return this.pieceStates[pieceIndex] ?? 'missing';
  }

  /** Get the priority of a specific piece */
  getPiecePriority(pieceIndex: number): PiecePriority {
    if (pieceIndex < 0 || pieceIndex >= this.totalPieces) {
      return PiecePriority.NONE;
    }

    // Init pieces are always critical
    if (pieceIndex < this.initPieceCount) {
      return PiecePriority.CRITICAL;
    }

    // Current fragment
    const currentFrag = this._getFragmentForPiece(this.playbackPiece);
    if (currentFrag && pieceIndex >= currentFrag.startPiece && pieceIndex <= currentFrag.endPiece) {
      return PiecePriority.HIGH;
    }

    // Lookahead window
    const lookaheadEnd = this.playbackPiece + this.lookahead;
    if (pieceIndex >= this.playbackPiece && pieceIndex <= lookaheadEnd) {
      return PiecePriority.NORMAL;
    }

    return PiecePriority.LOW;
  }

  /**
   * Get the next pieces to request, ordered by priority.
   *
   * Only returns pieces that are 'missing' (not received or in-flight).
   *
   * @param count - Maximum number of pieces to return
   */
  getNextPieces(count: number): number[] {
    const candidates: Array<{ index: number; priority: PiecePriority }> = [];

    for (let i = 0; i < this.totalPieces; i++) {
      if (this.pieceStates[i] !== 'missing') continue;

      candidates.push({
        index: i,
        priority: this.getPiecePriority(i),
      });
    }

    // Sort by priority (descending), then by piece index (ascending for sequential)
    candidates.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.index - b.index;
    });

    return candidates.slice(0, count).map((c) => c.index);
  }

  /**
   * Check if the init segment is fully received.
   */
  get initComplete(): boolean {
    for (let i = 0; i < this.initPieceCount; i++) {
      if (this.pieceStates[i] !== 'received') return false;
    }
    return true;
  }

  /**
   * Get buffer health relative to the current playback position.
   */
  get bufferHealth(): BufferHealth {
    let piecesReceived = 0;
    let contiguousAhead = 0;
    let countingContiguous = true;

    for (let i = 0; i < this.totalPieces; i++) {
      if (this.pieceStates[i] === 'received') {
        piecesReceived++;
      }
    }

    // Count contiguous pieces ahead of playback
    for (let i = this.playbackPiece; i < this.totalPieces; i++) {
      if (this.pieceStates[i] === 'received' && countingContiguous) {
        contiguousAhead++;
      } else {
        countingContiguous = false;
      }
    }

    // Count complete fragments
    let fragmentsReady = 0;
    for (const frag of this.fragmentMap) {
      let complete = true;
      for (let p = frag.startPiece; p <= frag.endPiece; p++) {
        if (this.pieceStates[p] !== 'received') {
          complete = false;
          break;
        }
      }
      if (complete) fragmentsReady++;
    }

    const bufferedAhead = contiguousAhead * this.secondsPerPiece;

    return {
      bufferedAhead,
      piecesReceived,
      fragmentsReady,
      canPlay: this.initComplete && contiguousAhead >= 2,
    };
  }

  /**
   * Total number of received pieces.
   */
  get receivedCount(): number {
    return this.pieceStates.filter((s) => s === 'received').length;
  }

  /**
   * Evict pieces far behind the playback position to save memory.
   * @param keepBehind — Number of pieces to keep behind playback
   */
  evict(keepBehind: number = 5): number[] {
    const evicted: number[] = [];
    const evictBefore = this.playbackPiece - keepBehind;

    for (let i = this.initPieceCount; i < evictBefore; i++) {
      if (this.pieceStates[i] === 'received') {
        this.pieceStates[i] = 'evicted';
        evicted.push(i);
      }
    }

    return evicted;
  }

  /** Find which fragment contains a given piece */
  private _getFragmentForPiece(pieceIndex: number): FragmentRange | null {
    for (const frag of this.fragmentMap) {
      if (pieceIndex >= frag.startPiece && pieceIndex <= frag.endPiece) {
        return frag;
      }
    }
    return null;
  }
}
