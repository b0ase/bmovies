/**
 * BEP 10 wire extension: bct_pay
 *
 * Adds payment channel negotiation and per-piece micropayments
 * to the WebTorrent wire protocol.
 *
 * Usage:
 *   torrent.on('wire', (wire) => {
 *     wire.use(createBctPayExtension({ role: 'leecher', ... }))
 *     wire.bct_pay.openChannel(10000)
 *   })
 */

import { EventEmitter } from 'node:events';
import {
  type BctMessage,
  BctMessageType,
  encodeMessage,
  decodeMessage,
  type ChannelOpenMsg,
  type ChannelAcceptMsg,
  type ChannelFundedMsg,
  type PiecePaymentMsg,
  type PaymentAckMsg,
  type ChannelCloseMsg,
} from './messages.js';
import { PaymentChannel } from '../payment/channel.js';
import { Wallet } from '../payment/wallet.js';
import type { ContentManifest } from '../types/torrent.js';
import type { ChannelConfig } from '../types/payment.js';
import { DEFAULTS } from '../types/config.js';

/** Wire type (from bittorrent-protocol, no TS types available) */
interface Wire {
  extended(ext: string | number, buf: Buffer | Uint8Array): void;
  peerExtendedMapping: Record<string, number>;
  [key: string]: unknown;
}

export interface BctPayOptions {
  /** 'leecher' opens and funds channels; 'seeder' accepts and validates */
  role: 'leecher' | 'seeder';
  /** BSV wallet for signing/receiving */
  wallet: Wallet;
  /** Content manifest (has pricing, creator info) */
  manifest: ContentManifest;
  /** Current block height (for timeout calculation) */
  currentBlockHeight?: number;
}

export interface BctPayEvents {
  'channel:open': (channelId: string) => void;
  'channel:funded': (channelId: string, fundingTxid: string) => void;
  'channel:close': (channelId: string) => void;
  'payment:sent': (pieceIndex: number, sequenceNumber: number) => void;
  'payment:received': (pieceIndex: number, sequenceNumber: number) => void;
  'payment:ack': (pieceIndex: number) => void;
  error: (err: Error) => void;
}

/**
 * Creates a BEP 10 extension class for the bct_pay protocol.
 *
 * The returned class is used with wire.use():
 *   wire.use(createBctPayExtension(options))
 *   wire.bct_pay.openChannel(10000)
 */
export function createBctPayExtension(options: BctPayOptions) {
  const { role, wallet, manifest } = options;
  const currentBlockHeight = options.currentBlockHeight ?? 800_000;

  class BctPayExtension extends EventEmitter {
    wire: Wire;
    channel: PaymentChannel | null = null;

    /** Pieces waiting for payment ack before they can be requested */
    pendingPieces: Set<number> = new Set();

    /** Pieces that have been paid for and ack'd */
    paidPieces: Set<number> = new Set();

    constructor(wire: Wire) {
      super();
      this.wire = wire;
    }

    onHandshake(_infoHash: string, _peerId: string, _extensions: object) {
      // nothing needed at handshake
    }

    onExtendedHandshake(_handshake: Record<string, unknown>) {
      // Peer supports bct_pay — ready to negotiate
    }

    onMessage(buf: Buffer) {
      let msg: BctMessage;
      try {
        msg = decodeMessage(buf);
      } catch {
        this.emit('error', new Error('Failed to decode bct_pay message'));
        return;
      }

      switch (msg.type) {
        case BctMessageType.CHANNEL_OPEN:
          this._handleChannelOpen(msg as ChannelOpenMsg);
          break;
        case BctMessageType.CHANNEL_ACCEPT:
          this._handleChannelAccept(msg as ChannelAcceptMsg);
          break;
        case BctMessageType.CHANNEL_FUNDED:
          this._handleChannelFunded(msg as ChannelFundedMsg);
          break;
        case BctMessageType.PIECE_PAYMENT:
          this._handlePiecePayment(msg as PiecePaymentMsg);
          break;
        case BctMessageType.PAYMENT_ACK:
          this._handlePaymentAck(msg as PaymentAckMsg);
          break;
        case BctMessageType.CHANNEL_CLOSE:
          this._handleChannelClose(msg as ChannelCloseMsg);
          break;
        default:
          this.emit('error', new Error(`Unknown bct_pay message type: ${(msg as BctMessage).type}`));
      }
    }

    // ─── Leecher-side public API ───────────────────────────────

    /**
     * Open a payment channel with this peer (leecher calls this).
     * Sends CHANNEL_OPEN and waits for CHANNEL_ACCEPT.
     */
    openChannel(depositSats: number): void {
      if (role !== 'leecher') {
        this.emit('error', new Error('Only leechers can open channels'));
        return;
      }

      const msg: ChannelOpenMsg = {
        type: BctMessageType.CHANNEL_OPEN,
        version: 1,
        leecherPubkey: wallet.publicKeyHex,
        depositSats,
        infohash: manifest.infohash,
      };

      this._send(msg);
    }

    /**
     * Pay for a piece (leecher calls this).
     * Creates a payment update and sends it to the seeder.
     */
    async payForPiece(pieceIndex: number): Promise<void> {
      if (!this.channel || this.channel.state !== 'open') {
        this.emit('error', new Error('Channel not open'));
        return;
      }

      try {
        const update = await this.channel.createPayment(pieceIndex, wallet);

        const msg: PiecePaymentMsg = {
          type: BctMessageType.PIECE_PAYMENT,
          channelId: this.channel.channelId,
          pieceIndex,
          sequenceNumber: update.sequenceNumber,
          seederAmount: update.seederAmount,
          creatorAmount: update.creatorAmount,
          signedTxHex: update.signedTxHex,
        };

        this.pendingPieces.add(pieceIndex);
        this._send(msg);
        this.emit('payment:sent', pieceIndex, update.sequenceNumber);
      } catch (err) {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      }
    }

    /**
     * Close the channel (either side).
     */
    closeChannel(reason: 'complete' | 'user_stop' | 'error' = 'complete'): void {
      if (!this.channel) return;

      const msg: ChannelCloseMsg = {
        type: BctMessageType.CHANNEL_CLOSE,
        channelId: this.channel.channelId,
        finalSequence: this.channel.sequenceNumber,
        reason,
      };

      this._send(msg);
      this.channel.close();
      this.emit('channel:close', this.channel.channelId);
    }

    // ─── Message handlers ──────────────────────────────────────

    /** Seeder receives CHANNEL_OPEN → creates channel, sends CHANNEL_ACCEPT */
    private _handleChannelOpen(msg: ChannelOpenMsg) {
      if (role !== 'seeder') return;

      const config: ChannelConfig = {
        fundingAmount: msg.depositSats,
        satsPerPiece: manifest.pricing.satsPerPiece,
        seederAddress: wallet.address,
        creatorAddress: manifest.creator.address,
        creatorSplitBps: manifest.creator.splitBps,
        timeoutBlockHeight: currentBlockHeight + DEFAULTS.timeoutBlocks,
      };

      this.channel = new PaymentChannel(config);

      const reply: ChannelAcceptMsg = {
        type: BctMessageType.CHANNEL_ACCEPT,
        channelId: this.channel.channelId,
        seederAddress: wallet.address,
        creatorAddress: manifest.creator.address,
        creatorSplitBps: manifest.creator.splitBps,
        satsPerPiece: manifest.pricing.satsPerPiece,
      };

      this._send(reply);
      this.emit('channel:open', this.channel.channelId);
    }

    /** Leecher receives CHANNEL_ACCEPT → creates their channel view, funds it */
    private _handleChannelAccept(msg: ChannelAcceptMsg) {
      if (role !== 'leecher') return;

      const config: ChannelConfig = {
        fundingAmount: 0, // will be set when funding tx is built
        satsPerPiece: msg.satsPerPiece,
        seederAddress: msg.seederAddress,
        creatorAddress: msg.creatorAddress,
        creatorSplitBps: msg.creatorSplitBps,
        timeoutBlockHeight: currentBlockHeight + DEFAULTS.timeoutBlocks,
      };

      // We'll set the real funding amount when we fund
      // For now, use the deposit amount from our open request
      // (stored temporarily — in real impl we'd track this)
      this.channel = new PaymentChannel(
        { ...config, fundingAmount: 10_000 }, // placeholder, overridden by fund()
        msg.channelId,
      );

      this.emit('channel:open', msg.channelId);

      // In production: build funding tx, broadcast, then send CHANNEL_FUNDED
      // For PoC: the caller handles funding externally
    }

    /** Seeder receives CHANNEL_FUNDED → marks channel as open */
    private _handleChannelFunded(msg: ChannelFundedMsg) {
      if (role !== 'seeder' || !this.channel) return;

      // In production: verify the funding tx is in mempool
      // For PoC: trust the leecher
      // We need to fetch the funding tx to verify — for now, create a dummy
      // The seeder's channel needs to be funded with the real tx for validation
      this.emit('channel:funded', msg.channelId, msg.fundingTxid);
    }

    /** Seeder receives PIECE_PAYMENT → validates, acks, releases piece */
    private _handlePiecePayment(msg: PiecePaymentMsg) {
      if (role !== 'seeder' || !this.channel) return;

      try {
        this.channel.validatePayment({
          sequenceNumber: msg.sequenceNumber,
          pieceIndex: msg.pieceIndex,
          seederAmount: msg.seederAmount,
          creatorAmount: msg.creatorAmount,
          leecherChange: 0, // not validated on seeder side
          signedTxHex: msg.signedTxHex,
        });

        this.paidPieces.add(msg.pieceIndex);

        const ack: PaymentAckMsg = {
          type: BctMessageType.PAYMENT_ACK,
          channelId: msg.channelId,
          pieceIndex: msg.pieceIndex,
          sequenceNumber: msg.sequenceNumber,
        };

        this._send(ack);
        this.emit('payment:received', msg.pieceIndex, msg.sequenceNumber);
      } catch (err) {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      }
    }

    /** Leecher receives PAYMENT_ACK → piece is released for download */
    private _handlePaymentAck(msg: PaymentAckMsg) {
      if (role !== 'leecher') return;

      this.pendingPieces.delete(msg.pieceIndex);
      this.paidPieces.add(msg.pieceIndex);
      this.emit('payment:ack', msg.pieceIndex);
    }

    /** Either side receives CHANNEL_CLOSE */
    private _handleChannelClose(msg: ChannelCloseMsg) {
      if (!this.channel) return;

      // Seeder: broadcast the settlement tx
      if (role === 'seeder' && this.channel.latestTxHex) {
        // In production: wallet.broadcast(channel.getSettlementTx())
        // For PoC: just close
      }

      this.channel.close();
      this.emit('channel:close', msg.channelId);
    }

    // ─── Internal ──────────────────────────────────────────────

    private _send(msg: BctMessage): void {
      const buf = encodeMessage(msg);
      this.wire.extended('bct_pay', buf);
    }
  }

  // BEP 10 requires the extension name on the prototype
  BctPayExtension.prototype.constructor.prototype.name = 'bct_pay';
  Object.defineProperty(BctPayExtension.prototype, 'name', {
    value: 'bct_pay',
    writable: false,
    enumerable: true,
  });

  return BctPayExtension;
}
