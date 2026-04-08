/**
 * SwarmManager — coordinates P2P re-seeding payments.
 *
 * Tracks browser peers, maps WebTorrent wire peerIds to internal peers,
 * and creates BSV payment channels when pieces transfer between peers.
 *
 * Data flows P2P (WebTorrent handles it).
 * Payments flow through here (server holds wallets, creates real BSV TXs).
 */

import { Transaction, P2PKH, SatoshisPerKilobyte } from '@bsv/sdk';
import { PaymentChannel } from '../payment/channel.js';
import { Wallet } from '../payment/wallet.js';
import type { ChannelConfig } from '../types/payment.js';
import type { SwarmPeer, SwarmStatus, ServerSwarmMessage } from '../types/swarm.js';
import type { ContentManifest } from '../types/torrent.js';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';

interface PeerConnection {
  peer: SwarmPeer;
  wallet: Wallet;
  /** WebSocket send function */
  send: (msg: ServerSwarmMessage) => void;
}

interface PeerChannel {
  channel: PaymentChannel;
  /** Payer's wallet (the downloader) */
  payerWallet: Wallet;
  fundingTx: Transaction;
}

export class SwarmManager extends EventEmitter {
  /** Internal peerId → connection */
  private peers = new Map<string, PeerConnection>();

  /** WebTorrent wire peerId → internal peerId */
  private wirePeerMap = new Map<string, string>();

  /** Payment channels between peer pairs: "payer:earner" → channel */
  private peerChannels = new Map<string, PeerChannel>();

  /** Content manifests for pricing */
  private manifests: Map<string, ContentManifest>;

  /** Seeder wallet address (the server) */
  private seederAddress: string;

  /** The "server" peerId for the original seeder */
  readonly serverPeerId = '__server__';

  constructor(manifests: Map<string, ContentManifest>, seederAddress: string) {
    super();
    this.manifests = manifests;
    this.seederAddress = seederAddress;
  }

  /**
   * Register a new browser peer.
   */
  registerPeer(
    infohash: string,
    send: (msg: ServerSwarmMessage) => void,
  ): SwarmPeer {
    const peerId = randomBytes(8).toString('hex');
    const wallet = Wallet.random();

    const peer: SwarmPeer = {
      peerId,
      walletAddress: wallet.address,
      infohash,
      connectedAt: Date.now(),
      piecesDownloaded: 0,
      piecesUploaded: 0,
      bytesDownloaded: 0,
      bytesUploaded: 0,
      earned: 0,
      spent: 0,
    };

    this.peers.set(peerId, { peer, wallet, send });

    // Broadcast swarm status to all peers for this content
    this._broadcastSwarmStatus(infohash);

    this.emit('peer:registered', peer);
    return peer;
  }

  /**
   * Map a WebTorrent wire peerId to an internal peerId.
   * Called when a browser reports which wire peers it sees.
   */
  mapWirePeer(wirePeerId: string, internalPeerId: string): void {
    this.wirePeerMap.set(wirePeerId, internalPeerId);
  }

  /**
   * Handle a piece download report from a browser peer.
   *
   * "I (peerId) downloaded piece X from wire peer Y"
   *
   * If Y is another browser peer, create a payment: peerId pays Y.
   * If Y is the server, the existing channel/pay flow handles it.
   */
  async handlePieceDownload(
    peerId: string,
    pieceIndex: number,
    fromWirePeerId: string,
    bytes: number,
  ): Promise<void> {
    const conn = this.peers.get(peerId);
    if (!conn) return;

    conn.peer.piecesDownloaded++;
    conn.peer.bytesDownloaded += bytes;

    // Resolve who the uploader is
    const uploaderPeerId = this.wirePeerMap.get(fromWirePeerId);

    if (uploaderPeerId && this.peers.has(uploaderPeerId)) {
      // Peer-to-peer transfer! Create payment from downloader to uploader
      await this._createPeerPayment(peerId, uploaderPeerId, pieceIndex);
    }
    // If uploader is unknown or is the server, no peer payment needed
    // (server payments handled by the existing /api/channel/pay flow)
  }

  /**
   * Handle a piece upload report from a browser peer.
   *
   * "I (peerId) uploaded piece X to wire peer Y"
   */
  handlePieceUpload(
    peerId: string,
    pieceIndex: number,
    toWirePeerId: string,
    bytes: number,
  ): void {
    const conn = this.peers.get(peerId);
    if (!conn) return;

    conn.peer.piecesUploaded++;
    conn.peer.bytesUploaded += bytes;

    // Cross-reference: the downloader should also report this.
    // Payment is triggered on the download side (they initiate payment).
    // Upload side just tracks stats.
  }

  /**
   * Create a BSV payment from downloader to uploader for a piece.
   */
  private async _createPeerPayment(
    payerPeerId: string,
    earnerPeerId: string,
    pieceIndex: number,
  ): Promise<void> {
    const payer = this.peers.get(payerPeerId);
    const earner = this.peers.get(earnerPeerId);
    if (!payer || !earner) return;

    const manifest = this.manifests.get(payer.peer.infohash);
    if (!manifest) return;

    const satsPerPiece = manifest.pricing.satsPerPiece;
    const channelKey = `${payerPeerId}:${earnerPeerId}`;

    // Get or create channel for this peer pair
    let peerChan = this.peerChannels.get(channelKey);
    if (!peerChan) {
      peerChan = await this._openPeerChannel(payer, earner, manifest);
      this.peerChannels.set(channelKey, peerChan);
    }

    // Create payment
    try {
      const update = await peerChan.channel.createPayment(pieceIndex, peerChan.payerWallet);
      const txid = Transaction.fromHex(update.signedTxHex).id('hex');

      // Update stats
      payer.peer.spent += satsPerPiece;
      earner.peer.earned += satsPerPiece;

      // Notify both peers
      const paymentMsg: ServerSwarmMessage = {
        type: 'payment_made',
        pieceIndex,
        fromPeer: payerPeerId,
        toPeer: earnerPeerId,
        sats: satsPerPiece,
        txid,
      };

      payer.send(paymentMsg);
      earner.send(paymentMsg);

      // Send earnings updates
      payer.send({
        type: 'earnings_update',
        earned: payer.peer.earned,
        spent: payer.peer.spent,
        net: payer.peer.earned - payer.peer.spent,
      });
      earner.send({
        type: 'earnings_update',
        earned: earner.peer.earned,
        spent: earner.peer.spent,
        net: earner.peer.earned - earner.peer.spent,
      });

      this.emit('payment', {
        from: payerPeerId,
        to: earnerPeerId,
        pieceIndex,
        sats: satsPerPiece,
        txid,
      });
    } catch (err) {
      // Channel may be exhausted — ignore
      this.emit('error', err);
    }
  }

  /**
   * Open a payment channel between two browser peers.
   */
  private async _openPeerChannel(
    payer: PeerConnection,
    earner: PeerConnection,
    manifest: ContentManifest,
  ): Promise<PeerChannel> {
    const satsPerPiece = manifest.pricing.satsPerPiece;
    const totalPieces = manifest.totalPieces;
    const fundingAmount = totalPieces * satsPerPiece + 200;

    // Create simulated funding TX (real crypto, simulated UTXO)
    const sourceTx = new Transaction();
    sourceTx.addOutput({
      lockingScript: new P2PKH().lock(payer.wallet.address),
      satoshis: fundingAmount + 1000,
    });

    const fundingTx = new Transaction();
    fundingTx.addInput({
      sourceTransaction: sourceTx,
      sourceOutputIndex: 0,
      unlockingScriptTemplate: new P2PKH().unlock(payer.wallet.privateKey),
      sequence: 0xffffffff,
    });
    fundingTx.addOutput({
      lockingScript: new P2PKH().lock(payer.wallet.address),
      satoshis: fundingAmount,
    });
    await fundingTx.fee(new SatoshisPerKilobyte(1));
    await fundingTx.sign();

    const config: ChannelConfig = {
      fundingAmount,
      satsPerPiece,
      recipients: [{ address: earner.wallet.address, bps: 10_000 }], // earner gets 100% of P2P transfer revenue
      timeoutBlockHeight: 900_000,
    };

    const channel = new PaymentChannel(config);
    channel.fund(fundingTx.id('hex'), 0, fundingTx);

    return { channel, payerWallet: payer.wallet, fundingTx };
  }

  /**
   * Disconnect a peer and clean up.
   */
  disconnectPeer(peerId: string): void {
    const conn = this.peers.get(peerId);
    if (!conn) return;

    // Remove wire mappings
    for (const [wire, internal] of this.wirePeerMap) {
      if (internal === peerId) this.wirePeerMap.delete(wire);
    }

    this.peers.delete(peerId);
    this._broadcastSwarmStatus(conn.peer.infohash);
    this.emit('peer:disconnected', conn.peer);
  }

  /**
   * Get all peers watching a specific content.
   */
  getPeersForContent(infohash: string): SwarmPeer[] {
    return [...this.peers.values()]
      .filter((c) => c.peer.infohash === infohash)
      .map((c) => c.peer);
  }

  /**
   * Get a peer by ID.
   */
  getPeer(peerId: string): SwarmPeer | undefined {
    return this.peers.get(peerId)?.peer;
  }

  /**
   * Get full swarm status.
   */
  getStatus(): SwarmStatus {
    const allPeers = [...this.peers.values()].map((c) => c.peer);
    return {
      activePeers: allPeers.length,
      totalPiecesTransferred: allPeers.reduce((s, p) => s + p.piecesUploaded, 0),
      totalSatsTransferred: allPeers.reduce((s, p) => s + p.earned, 0),
      peers: allPeers,
    };
  }

  /**
   * Broadcast swarm status to all peers watching a content.
   */
  private _broadcastSwarmStatus(infohash: string): void {
    const peers = this.getPeersForContent(infohash);
    const msg: ServerSwarmMessage = {
      type: 'swarm_status',
      peers: peers.length,
      totalUploaded: peers.reduce((s, p) => s + p.piecesUploaded, 0),
      totalDownloaded: peers.reduce((s, p) => s + p.piecesDownloaded, 0),
    };
    for (const conn of this.peers.values()) {
      if (conn.peer.infohash === infohash) {
        conn.send(msg);
      }
    }
  }
}
