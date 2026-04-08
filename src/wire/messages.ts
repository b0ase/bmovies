/**
 * BEP 10 wire extension message types for the bct_pay protocol.
 *
 * Messages are serialized as bencode dicts and sent via
 * wire.extended() on the WebTorrent wire protocol.
 */

/** Message type codes */
export enum BctMessageType {
  CHANNEL_OPEN = 0,
  CHANNEL_ACCEPT = 1,
  CHANNEL_FUNDED = 2,
  PIECE_PAYMENT = 3,
  PAYMENT_ACK = 4,
  CHANNEL_CLOSE = 5,
  CHANNEL_ERROR = 6,
}

/** Leecher → Seeder: "I want to open a payment channel" */
export interface ChannelOpenMsg {
  type: BctMessageType.CHANNEL_OPEN;
  version: 1;
  leecherPubkey: string;
  depositSats: number;
  infohash: string;
}

/** Seeder → Leecher: "Here are my terms" */
export interface ChannelAcceptMsg {
  type: BctMessageType.CHANNEL_ACCEPT;
  channelId: string;
  seederAddress: string;
  creatorAddress: string;
  creatorSplitBps: number;
  satsPerPiece: number;
}

/** Leecher → Seeder: "Channel is funded on-chain" */
export interface ChannelFundedMsg {
  type: BctMessageType.CHANNEL_FUNDED;
  channelId: string;
  fundingTxid: string;
  fundingVout: number;
  fundingAmount: number;
}

/** Leecher → Seeder: "Payment for piece N" */
export interface PiecePaymentMsg {
  type: BctMessageType.PIECE_PAYMENT;
  channelId: string;
  pieceIndex: number;
  sequenceNumber: number;
  seederAmount: number;
  creatorAmount: number;
  signedTxHex: string;
}

/** Seeder → Leecher: "Payment accepted, piece released" */
export interface PaymentAckMsg {
  type: BctMessageType.PAYMENT_ACK;
  channelId: string;
  pieceIndex: number;
  sequenceNumber: number;
}

/** Either → Either: "Close the channel" */
export interface ChannelCloseMsg {
  type: BctMessageType.CHANNEL_CLOSE;
  channelId: string;
  finalSequence: number;
  reason: 'complete' | 'user_stop' | 'error';
}

/** Either → Either: "Error" */
export interface ChannelErrorMsg {
  type: BctMessageType.CHANNEL_ERROR;
  channelId: string;
  code: string;
  message: string;
}

export type BctMessage =
  | ChannelOpenMsg
  | ChannelAcceptMsg
  | ChannelFundedMsg
  | PiecePaymentMsg
  | PaymentAckMsg
  | ChannelCloseMsg
  | ChannelErrorMsg;

/** Serialize a message to a Buffer for wire.extended() */
export function encodeMessage(msg: BctMessage): Buffer {
  return Buffer.from(JSON.stringify(msg));
}

/** Deserialize a message from a Buffer */
export function decodeMessage(buf: Buffer): BctMessage {
  return JSON.parse(buf.toString()) as BctMessage;
}
