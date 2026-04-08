/**
 * Payment channel types for BSV nLocktime micropayments.
 *
 * Revenue model: 100% of streaming revenue goes to token holders.
 * Settlement TX fans out directly to holders proportionally.
 * No 60/40 split. No intermediary. Token = licence = revenue right.
 */

/** Channel lifecycle states */
export type ChannelState = 'opening' | 'open' | 'closing' | 'closed';

/** A recipient in a payment channel (token holder) */
export interface Recipient {
  /** BSV address */
  address: string;
  /** Share in basis points (10000 = 100%) */
  bps: number;
}

/** Configuration for opening a payment channel */
export interface ChannelConfig {
  /** Satoshis deposited into the channel */
  fundingAmount: number;
  /** Satoshis per torrent piece */
  satsPerPiece: number;
  /** Revenue recipients (token holders). Must sum to 10000 bps. */
  recipients: Recipient[];
  /** Block height after which channel expires */
  timeoutBlockHeight: number;
}

/** Per-recipient amount in a state update */
export interface RecipientPayment {
  address: string;
  amount: number;
}

/** Snapshot of channel state at a given sequence number */
export interface ChannelStateUpdate {
  /** Incrementing sequence number */
  sequenceNumber: number;
  /** Piece this payment is for */
  pieceIndex: number;
  /** Cumulative amounts per recipient */
  recipientAmounts: RecipientPayment[];
  /** Total sats paid so far */
  totalPaid: number;
  /** Remaining change back to leecher */
  leecherChange: number;
  /** Fully signed transaction hex (broadcastable by any recipient) */
  signedTxHex: string;
}

/** Full payment channel record */
export interface PaymentChannelRecord {
  channelId: string;
  state: ChannelState;
  fundingTxid: string;
  fundingVout: number;
  fundingAmount: number;
  satsPerPiece: number;
  recipients: Recipient[];
  timeoutBlockHeight: number;
  sequenceNumber: number;
  recipientAmounts: RecipientPayment[];
  totalPaid: number;
  leecherChange: number;
  latestTxHex: string;
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
