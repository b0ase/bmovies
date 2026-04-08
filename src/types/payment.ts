/**
 * Payment channel types for BSV nLocktime micropayments.
 *
 * Unidirectional channel: leecher pays seeder per piece.
 * Only 2 on-chain transactions per session (fund + settle).
 */

/** Channel lifecycle states */
export type ChannelState = 'opening' | 'open' | 'closing' | 'closed';

/** Configuration for opening a payment channel */
export interface ChannelConfig {
  /** Satoshis deposited into the channel */
  fundingAmount: number;
  /** Satoshis per torrent piece */
  satsPerPiece: number;
  /** BSV address to pay the seeder */
  seederAddress: string;
  /** BSV address to pay the content creator */
  creatorAddress: string;
  /** Creator's revenue share in basis points (6000 = 60%) */
  creatorSplitBps: number;
  /** Block height after which channel expires */
  timeoutBlockHeight: number;
}

/** Snapshot of channel state at a given sequence number */
export interface ChannelStateUpdate {
  /** Incrementing sequence number */
  sequenceNumber: number;
  /** Piece this payment is for */
  pieceIndex: number;
  /** Cumulative satoshis owed to seeder (their share only) */
  seederAmount: number;
  /** Cumulative satoshis owed to creator */
  creatorAmount: number;
  /** Remaining change back to leecher */
  leecherChange: number;
  /** Fully signed transaction hex (broadcastable by seeder) */
  signedTxHex: string;
}

/** Full payment channel record */
export interface PaymentChannelRecord {
  channelId: string;
  state: ChannelState;

  /** Funding transaction details */
  fundingTxid: string;
  fundingVout: number;
  fundingAmount: number;

  /** Channel parameters */
  satsPerPiece: number;
  seederAddress: string;
  creatorAddress: string;
  creatorSplitBps: number;
  timeoutBlockHeight: number;

  /** Current state */
  sequenceNumber: number;
  seederAmount: number;
  creatorAmount: number;
  leecherChange: number;

  /** Latest signed tx held by seeder */
  latestTxHex: string;

  /** Derived limits */
  maxPieces: number;
  totalPaidPieces: number;
}

/** Wallet UTXO for channel funding */
export interface UTXO {
  txid: string;
  vout: number;
  satoshis: number;
  script: string;
}

/** Result of broadcasting a transaction */
export interface BroadcastResult {
  txid: string;
  success: boolean;
  error?: string;
}
