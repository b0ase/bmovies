import { describe, it, expect } from 'vitest';
import { PiecePicker } from '../src/streaming/piece-picker.js';
import { BufferManager } from '../src/streaming/buffer-manager.js';
import { PiecePriority } from '../src/types/streaming.js';
import type { FragmentRange } from '../src/types/torrent.js';

// Simulate a 50-piece video with 1 init piece and 5 fragments
const FRAGMENT_MAP: FragmentRange[] = [
  { startPiece: 1, endPiece: 10 },
  { startPiece: 11, endPiece: 20 },
  { startPiece: 21, endPiece: 30 },
  { startPiece: 31, endPiece: 40 },
  { startPiece: 41, endPiece: 49 },
];

describe('PiecePicker', () => {
  it('should prioritize init pieces as CRITICAL', () => {
    const picker = new PiecePicker({
      totalPieces: 50,
      initPieceCount: 1,
      fragmentMap: FRAGMENT_MAP,
    });

    expect(picker.getPiecePriority(0)).toBe(PiecePriority.CRITICAL);
    expect(picker.getPiecePriority(1)).not.toBe(PiecePriority.CRITICAL);
  });

  it('should prioritize current fragment pieces as HIGH', () => {
    const picker = new PiecePicker({
      totalPieces: 50,
      initPieceCount: 1,
      fragmentMap: FRAGMENT_MAP,
    });

    // Playback at piece 5 → fragment 0 (pieces 1-10)
    picker.setPlaybackPiece(5);

    expect(picker.getPiecePriority(1)).toBe(PiecePriority.HIGH);
    expect(picker.getPiecePriority(5)).toBe(PiecePriority.HIGH);
    expect(picker.getPiecePriority(10)).toBe(PiecePriority.HIGH);
    // Piece 11 is in next fragment, within lookahead → NORMAL
    expect(picker.getPiecePriority(11)).toBe(PiecePriority.NORMAL);
  });

  it('should prioritize lookahead pieces as NORMAL', () => {
    const picker = new PiecePicker({
      totalPieces: 50,
      initPieceCount: 1,
      fragmentMap: FRAGMENT_MAP,
      lookahead: 10,
    });

    picker.setPlaybackPiece(5);

    // Pieces 5-15 are in lookahead (playback + 10)
    // But pieces 5-10 are in current fragment → HIGH
    // Pieces 11-15 are lookahead but not current fragment → NORMAL
    expect(picker.getPiecePriority(15)).toBe(PiecePriority.NORMAL);

    // Piece 20 is beyond lookahead → LOW
    expect(picker.getPiecePriority(20)).toBe(PiecePriority.LOW);
  });

  it('should return init pieces first in getNextPieces', () => {
    const picker = new PiecePicker({
      totalPieces: 50,
      initPieceCount: 1,
      fragmentMap: FRAGMENT_MAP,
    });

    const next = picker.getNextPieces(5);

    // First piece should be the init piece (0)
    expect(next[0]).toBe(0);
  });

  it('should not return received or requested pieces', () => {
    const picker = new PiecePicker({
      totalPieces: 50,
      initPieceCount: 1,
      fragmentMap: FRAGMENT_MAP,
    });

    picker.markReceived(0);
    picker.markRequested(1);

    const next = picker.getNextPieces(5);

    expect(next).not.toContain(0);
    expect(next).not.toContain(1);
  });

  it('should report init complete correctly', () => {
    const picker = new PiecePicker({
      totalPieces: 50,
      initPieceCount: 2,
      fragmentMap: FRAGMENT_MAP,
    });

    expect(picker.initComplete).toBe(false);
    picker.markReceived(0);
    expect(picker.initComplete).toBe(false);
    picker.markReceived(1);
    expect(picker.initComplete).toBe(true);
  });

  it('should report buffer health', () => {
    const picker = new PiecePicker({
      totalPieces: 50,
      initPieceCount: 1,
      fragmentMap: FRAGMENT_MAP,
      secondsPerPiece: 0.5,
    });

    picker.setPlaybackPiece(5);

    // No pieces received — can't play
    expect(picker.bufferHealth.canPlay).toBe(false);

    // Receive init + pieces 5-14
    picker.markReceived(0);
    for (let i = 5; i <= 14; i++) {
      picker.markReceived(i);
    }

    const health = picker.bufferHealth;
    expect(health.canPlay).toBe(true);
    expect(health.bufferedAhead).toBe(5); // 10 pieces * 0.5s
    expect(health.piecesReceived).toBe(11); // init + 10
  });

  it('should evict pieces behind playback', () => {
    const picker = new PiecePicker({
      totalPieces: 50,
      initPieceCount: 1,
      fragmentMap: FRAGMENT_MAP,
    });

    // Receive pieces 0-20
    for (let i = 0; i <= 20; i++) {
      picker.markReceived(i);
    }

    // Playback at piece 15, keep 3 behind
    picker.setPlaybackPiece(15);
    const evicted = picker.evict(3);

    // Should evict pieces 1-11 (not init piece 0, keep 12-15)
    expect(evicted.length).toBe(11); // pieces 1 through 11
    expect(evicted).not.toContain(0); // init protected

    // Evicted pieces should have 'evicted' state
    expect(picker.getPieceState(1)).toBe('evicted');
    expect(picker.getPieceState(0)).toBe('received'); // init kept
    expect(picker.getPieceState(14)).toBe('received'); // within keep range
  });
});

describe('BufferManager', () => {
  const PIECE_LENGTH = 256;

  it('should store and retrieve pieces', () => {
    const manager = new BufferManager({
      totalPieces: 50,
      pieceLength: PIECE_LENGTH,
      initPieceCount: 1,
      fragmentMap: FRAGMENT_MAP,
      totalBytes: 50 * PIECE_LENGTH,
    });

    const data = Buffer.alloc(PIECE_LENGTH, 0xaa);
    manager.storePiece(0, data);

    expect(manager.hasPiece(0)).toBe(true);
    expect(manager.hasPiece(1)).toBe(false);
    expect(manager.getPiece(0)).toEqual(data);
  });

  it('should detect init segment completion', () => {
    const manager = new BufferManager({
      totalPieces: 50,
      pieceLength: PIECE_LENGTH,
      initPieceCount: 2,
      fragmentMap: FRAGMENT_MAP,
      totalBytes: 50 * PIECE_LENGTH,
    });

    expect(manager.initComplete).toBe(false);

    manager.storePiece(0, Buffer.alloc(PIECE_LENGTH));
    expect(manager.initComplete).toBe(false);

    manager.storePiece(1, Buffer.alloc(PIECE_LENGTH));
    expect(manager.initComplete).toBe(true);
  });

  it('should assemble init segment', () => {
    const manager = new BufferManager({
      totalPieces: 50,
      pieceLength: PIECE_LENGTH,
      initPieceCount: 2,
      fragmentMap: FRAGMENT_MAP,
      totalBytes: 50 * PIECE_LENGTH,
    });

    manager.storePiece(0, Buffer.alloc(PIECE_LENGTH, 0x11));
    manager.storePiece(1, Buffer.alloc(PIECE_LENGTH, 0x22));

    const initSeg = manager.getInitSegment();
    expect(initSeg).not.toBeNull();
    expect(initSeg!.length).toBe(PIECE_LENGTH * 2);
    expect(initSeg![0]).toBe(0x11);
    expect(initSeg![PIECE_LENGTH]).toBe(0x22);
  });

  it('should detect fragment completion', () => {
    const manager = new BufferManager({
      totalPieces: 50,
      pieceLength: PIECE_LENGTH,
      initPieceCount: 1,
      fragmentMap: FRAGMENT_MAP,
      totalBytes: 50 * PIECE_LENGTH,
    });

    // Fragment 0 = pieces 1-10
    expect(manager.isFragmentComplete(0)).toBe(false);

    for (let i = 1; i <= 9; i++) {
      manager.storePiece(i, Buffer.alloc(PIECE_LENGTH));
    }
    expect(manager.isFragmentComplete(0)).toBe(false);

    manager.storePiece(10, Buffer.alloc(PIECE_LENGTH));
    expect(manager.isFragmentComplete(0)).toBe(true);
  });

  it('should assemble fragments from pieces', () => {
    const manager = new BufferManager({
      totalPieces: 50,
      pieceLength: PIECE_LENGTH,
      initPieceCount: 1,
      fragmentMap: FRAGMENT_MAP,
      totalBytes: 50 * PIECE_LENGTH,
    });

    // Fill fragment 0 (pieces 1-10)
    for (let i = 1; i <= 10; i++) {
      manager.storePiece(i, Buffer.alloc(PIECE_LENGTH, i));
    }

    const fragment = manager.assembleFragment(0);
    expect(fragment).not.toBeNull();
    expect(fragment!.length).toBe(PIECE_LENGTH * 10);
    // First byte of each piece should match the fill value
    expect(fragment![0]).toBe(1);
    expect(fragment![PIECE_LENGTH]).toBe(2);
  });

  it('should track ready fragments', () => {
    const manager = new BufferManager({
      totalPieces: 50,
      pieceLength: PIECE_LENGTH,
      initPieceCount: 1,
      fragmentMap: FRAGMENT_MAP,
      totalBytes: 50 * PIECE_LENGTH,
    });

    // Complete fragment 0 and 2, leave 1 incomplete
    for (let i = 1; i <= 10; i++) manager.storePiece(i, Buffer.alloc(PIECE_LENGTH));
    for (let i = 21; i <= 30; i++) manager.storePiece(i, Buffer.alloc(PIECE_LENGTH));

    const ready = manager.getReadyFragments();
    expect(ready).toContain(0);
    expect(ready).toContain(2);
    expect(ready).not.toContain(1);

    // After assembling fragment 0, it should no longer be "ready"
    manager.assembleFragment(0);
    const ready2 = manager.getReadyFragments();
    expect(ready2).not.toContain(0);
    expect(ready2).toContain(2);
  });

  it('should evict old pieces but keep init', () => {
    const manager = new BufferManager({
      totalPieces: 50,
      pieceLength: PIECE_LENGTH,
      initPieceCount: 1,
      fragmentMap: FRAGMENT_MAP,
      totalBytes: 50 * PIECE_LENGTH,
    });

    // Store pieces 0-25
    for (let i = 0; i <= 25; i++) {
      manager.storePiece(i, Buffer.alloc(PIECE_LENGTH));
    }

    expect(manager.storedCount).toBe(26);

    // Playback at 20, keep 3 behind
    const evicted = manager.evict(20, 3);

    // Should evict pieces 1-16 (not piece 0 = init, keep 17-20)
    expect(evicted).toBe(16);
    expect(manager.hasPiece(0)).toBe(true); // init kept
    expect(manager.hasPiece(1)).toBe(false); // evicted
    expect(manager.hasPiece(17)).toBe(true); // within keep
    expect(manager.hasPiece(20)).toBe(true); // playback position
  });

  it('should report memory usage', () => {
    const manager = new BufferManager({
      totalPieces: 50,
      pieceLength: PIECE_LENGTH,
      initPieceCount: 1,
      fragmentMap: FRAGMENT_MAP,
      totalBytes: 50 * PIECE_LENGTH,
    });

    expect(manager.memoryUsage).toBe(0);

    manager.storePiece(0, Buffer.alloc(PIECE_LENGTH));
    manager.storePiece(1, Buffer.alloc(PIECE_LENGTH));

    expect(manager.memoryUsage).toBe(PIECE_LENGTH * 2);
  });
});
