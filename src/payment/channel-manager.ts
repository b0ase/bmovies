/**
 * Manages payment channels across multiple peers.
 *
 * Each connected peer gets its own payment channel.
 * The manager tracks channel lifecycle, total earnings,
 * and handles settlement.
 */

import { PaymentChannel } from './channel.js';
import { Wallet } from './wallet.js';
import type { ChannelConfig, PaymentChannelRecord } from '../types/payment.js';

export class ChannelManager {
  private channels = new Map<string, PaymentChannel>();
  private peerChannels = new Map<string, string>(); // peerId → channelId

  /** Create a new channel for a peer */
  createChannel(peerId: string, config: ChannelConfig): PaymentChannel {
    const channel = new PaymentChannel(config);
    this.channels.set(channel.channelId, channel);
    this.peerChannels.set(peerId, channel.channelId);
    return channel;
  }

  /** Get a channel by ID */
  getChannel(channelId: string): PaymentChannel | undefined {
    return this.channels.get(channelId);
  }

  /** Get the channel for a specific peer */
  getChannelForPeer(peerId: string): PaymentChannel | undefined {
    const channelId = this.peerChannels.get(peerId);
    if (!channelId) return undefined;
    return this.channels.get(channelId);
  }

  /** Close and remove a channel */
  closeChannel(channelId: string): void {
    const channel = this.channels.get(channelId);
    if (channel) {
      channel.close();
      // Remove peer mapping
      for (const [peerId, cid] of this.peerChannels) {
        if (cid === channelId) {
          this.peerChannels.delete(peerId);
          break;
        }
      }
    }
  }

  /** Get all active (open) channels */
  getActiveChannels(): PaymentChannel[] {
    return [...this.channels.values()].filter((c) => c.state === 'open');
  }

  /** Total satoshis earned across all channels (seeder perspective) */
  get totalSeederEarnings(): number {
    let total = 0;
    for (const channel of this.channels.values()) {
      total += channel.seederAmount;
    }
    return total;
  }

  /** Total satoshis paid to creators across all channels */
  get totalCreatorPayments(): number {
    let total = 0;
    for (const channel of this.channels.values()) {
      total += channel.creatorAmount;
    }
    return total;
  }

  /** Total pieces served across all channels */
  get totalPiecesServed(): number {
    let total = 0;
    for (const channel of this.channels.values()) {
      total += channel.totalPaidPieces;
    }
    return total;
  }

  /** Number of active channels */
  get activeCount(): number {
    return this.getActiveChannels().length;
  }

  /** Export all channel records */
  toRecords(): PaymentChannelRecord[] {
    return [...this.channels.values()].map((c) => c.toRecord());
  }

  /** Get settlement transactions for all channels that have payments */
  getSettlementTxs(): Array<{ channelId: string; txHex: string }> {
    const results: Array<{ channelId: string; txHex: string }> = [];
    for (const channel of this.channels.values()) {
      if (channel.totalPaidPieces > 0) {
        try {
          results.push({
            channelId: channel.channelId,
            txHex: channel.getSettlementTx(),
          });
        } catch {
          // channel has no payments
        }
      }
    }
    return results;
  }
}
