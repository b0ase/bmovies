/**
 * Seeder node — seeds content via WebTorrent and accepts BSV payment channels.
 *
 * Wires up:
 * - WebTorrent for P2P delivery
 * - bct_pay extension on each wire for payment negotiation
 * - Economics tracking per content/peer
 */

import WebTorrent from 'webtorrent';
import { createBctPayExtension } from '../wire/bct-extension.js';
import { ChannelManager } from '../payment/channel-manager.js';
import { Wallet } from '../payment/wallet.js';
import { Economics } from './economics.js';
import type { ContentManifest } from '../types/torrent.js';
import type { SeederConfig } from '../types/config.js';
import { EventEmitter } from 'node:events';

export interface SeededContent {
  infohash: string;
  manifest: ContentManifest;
  torrent: WebTorrent.Torrent;
}

export class Seeder extends EventEmitter {
  readonly wallet: Wallet;
  readonly client: WebTorrent.Instance;
  readonly channelManager: ChannelManager;
  readonly economics: Economics;

  private seededContent = new Map<string, SeededContent>();

  constructor(config: SeederConfig) {
    super();
    this.wallet = new Wallet(config.privateKeyWif);
    this.client = new WebTorrent();
    this.channelManager = new ChannelManager();
    this.economics = new Economics();
  }

  /**
   * Seed a piece of content.
   *
   * @param fmp4Path - Path to the fMP4 file
   * @param manifest - Content manifest
   */
  async seed(fmp4Path: string, manifest: ContentManifest): Promise<SeededContent> {
    return new Promise((resolve, reject) => {
      this.client.seed(fmp4Path, { name: manifest.title }, (torrent) => {
        const content: SeededContent = {
          infohash: torrent.infoHash,
          manifest: { ...manifest, infohash: torrent.infoHash },
          torrent,
        };

        this.seededContent.set(torrent.infoHash, content);

        // Set up payment extension on every new wire
        torrent.on('wire', (wire: any) => {
          const Extension = createBctPayExtension({
            role: 'seeder',
            wallet: this.wallet,
            manifest: content.manifest,
          });

          wire.use(Extension);

          const ext = wire.bct_pay;
          if (!ext) return;

          ext.on('channel:open', (channelId: string) => {
            this.emit('channel:open', {
              infohash: torrent.infoHash,
              channelId,
              peerId: wire.peerId,
            });
          });

          ext.on('payment:received', (pieceIndex: number, seq: number) => {
            const channel = ext.channel;
            if (channel) {
              this.economics.recordPayment(
                torrent.infoHash,
                manifest.title,
                channel.seederAmount - (this.economics.getEarnings(torrent.infoHash)?.seederEarnings ?? 0),
                channel.creatorAmount - (this.economics.getEarnings(torrent.infoHash)?.creatorPayments ?? 0),
              );
            }
            this.emit('payment:received', {
              infohash: torrent.infoHash,
              pieceIndex,
              seq,
            });
          });

          ext.on('channel:close', (channelId: string) => {
            this.emit('channel:close', {
              infohash: torrent.infoHash,
              channelId,
            });
          });
        });

        this.emit('seeding', {
          infohash: torrent.infoHash,
          title: manifest.title,
          magnetURI: torrent.magnetURI,
        });

        resolve(content);
      });
    });
  }

  /** Get seeded content by infohash */
  getContent(infohash: string): SeededContent | undefined {
    return this.seededContent.get(infohash);
  }

  /** List all seeded content */
  listContent(): SeededContent[] {
    return [...this.seededContent.values()];
  }

  /** Get node status */
  getStatus() {
    return {
      address: this.wallet.address,
      seededContent: this.seededContent.size,
      totalPeers: [...this.seededContent.values()].reduce(
        (sum, c) => sum + c.torrent.numPeers,
        0,
      ),
      economics: {
        totalSeederEarnings: this.economics.totalSeederEarnings,
        totalPiecesServed: this.economics.totalPiecesServed,
        byContent: this.economics.getAllEarnings(),
      },
    };
  }

  /** Destroy the seeder (close all torrents) */
  async destroy(): Promise<void> {
    return new Promise((resolve) => {
      this.client.destroy(() => resolve());
    });
  }
}
