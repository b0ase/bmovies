/**
 * Streaming engine types.
 */

/** Piece priority levels (higher = more urgent) */
export enum PiecePriority {
  NONE = 0,
  LOW = 1,
  NORMAL = 5,
  HIGH = 8,
  CRITICAL = 10,
}

/** Piece state in the buffer */
export type PieceState = 'missing' | 'requested' | 'received' | 'evicted';

/** Buffer health status */
export interface BufferHealth {
  /** Seconds of video buffered ahead of playback position */
  bufferedAhead: number;
  /** Number of pieces received */
  piecesReceived: number;
  /** Number of complete fragments ready for MSE */
  fragmentsReady: number;
  /** Whether playback can continue without stalling */
  canPlay: boolean;
}

/** Streaming session statistics */
export interface StreamStats {
  /** Total pieces downloaded */
  piecesDownloaded: number;
  /** Total pieces paid for */
  piecesPaid: number;
  /** Total satoshis spent */
  totalSatsSpent: number;
  /** Download speed in bytes/sec */
  downloadSpeed: number;
  /** Current buffer health */
  bufferHealth: BufferHealth;
  /** Elapsed playback time in seconds */
  playbackTime: number;
}
