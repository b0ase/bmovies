import { describe, it, expect, beforeAll, vi } from 'vitest';
import { PrivateKey } from '@bsv/sdk';
import { SwarmManager } from '../src/swarm/swarm-manager.js';
import type { ContentManifest } from '../src/types/torrent.js';
import type { ServerSwarmMessage } from '../src/types/swarm.js';

const TEST_MANIFEST: ContentManifest = {
  version: 1,
  infohash: 'abc123',
  title: 'Test Video',
  contentType: 'video/mp4',
  duration: 60,
  totalPieces: 20,
  totalBytes: 5_242_880,
  pricing: { satsPerPiece: 1, initPiecesFree: true, currency: 'BSV' },
  creator: {
    address: PrivateKey.fromRandom().toAddress(),
    name: 'Creator',
    splitBps: 6000,
  },
  codec: {
    mimeCodec: 'video/mp4; codecs="avc1.42001f"',
    initPieceCount: 1,
    fragmentMap: [{ startPiece: 1, endPiece: 20 }],
  },
};

function createMockSend(): { send: (msg: ServerSwarmMessage) => void; messages: ServerSwarmMessage[] } {
  const messages: ServerSwarmMessage[] = [];
  return {
    send: (msg: ServerSwarmMessage) => messages.push(msg),
    messages,
  };
}

describe('SwarmManager', () => {
  let manager: SwarmManager;
  const manifests = new Map<string, ContentManifest>();
  const seederAddress = PrivateKey.fromRandom().toAddress();

  beforeAll(() => {
    manifests.set('abc123', TEST_MANIFEST);
  });

  it('should register peers', () => {
    manager = new SwarmManager(manifests, seederAddress);
    const { send } = createMockSend();

    const peer = manager.registerPeer('abc123', send);

    expect(peer.peerId).toBeTruthy();
    expect(peer.walletAddress).toBeTruthy();
    expect(peer.infohash).toBe('abc123');
    expect(peer.earned).toBe(0);
    expect(peer.spent).toBe(0);
  });

  it('should track multiple peers for same content', () => {
    manager = new SwarmManager(manifests, seederAddress);
    const { send: s1 } = createMockSend();
    const { send: s2 } = createMockSend();
    const { send: s3 } = createMockSend();

    manager.registerPeer('abc123', s1);
    manager.registerPeer('abc123', s2);
    manager.registerPeer('abc123', s3);

    const peers = manager.getPeersForContent('abc123');
    expect(peers).toHaveLength(3);
  });

  it('should handle piece downloads from unknown peers (server)', async () => {
    manager = new SwarmManager(manifests, seederAddress);
    const { send } = createMockSend();
    const peer = manager.registerPeer('abc123', send);

    // Download from unknown wire peer (the server) — no peer payment
    await manager.handlePieceDownload(peer.peerId, 1, 'unknown-wire-id', 256000);

    expect(peer.piecesDownloaded).toBe(1);
    expect(peer.bytesDownloaded).toBe(256000);
    expect(peer.spent).toBe(0); // no peer-to-peer payment for server downloads
  });

  it('should create payment when peer downloads from another peer', async () => {
    manager = new SwarmManager(manifests, seederAddress);
    const mock1 = createMockSend();
    const mock2 = createMockSend();

    const peerA = manager.registerPeer('abc123', mock1.send);
    const peerB = manager.registerPeer('abc123', mock2.send);

    // Map wire peerIds
    manager.mapWirePeer('wire-a', peerA.peerId);
    manager.mapWirePeer('wire-b', peerB.peerId);

    // Peer B downloads piece 5 from Peer A
    await manager.handlePieceDownload(peerB.peerId, 5, 'wire-a', 256000);

    // Peer B should have spent, Peer A should have earned
    expect(peerB.spent).toBe(1); // 1 sat/piece
    expect(peerA.earned).toBe(1);

    // Both should receive payment notification
    const paymentMsgsA = mock1.messages.filter(m => m.type === 'payment_made');
    const paymentMsgsB = mock2.messages.filter(m => m.type === 'payment_made');
    expect(paymentMsgsA.length).toBeGreaterThanOrEqual(1);
    expect(paymentMsgsB.length).toBeGreaterThanOrEqual(1);

    // Earnings updates
    const earningsA = mock1.messages.filter(m => m.type === 'earnings_update');
    expect(earningsA.length).toBeGreaterThanOrEqual(1);
    expect((earningsA[earningsA.length - 1] as any).earned).toBe(1);
  });

  it('should handle multiple piece transfers and accumulate earnings', async () => {
    manager = new SwarmManager(manifests, seederAddress);
    const mock1 = createMockSend();
    const mock2 = createMockSend();

    const peerA = manager.registerPeer('abc123', mock1.send);
    const peerB = manager.registerPeer('abc123', mock2.send);

    manager.mapWirePeer('wire-a', peerA.peerId);

    // Peer B downloads 10 pieces from Peer A
    for (let i = 1; i <= 10; i++) {
      await manager.handlePieceDownload(peerB.peerId, i, 'wire-a', 256000);
    }

    expect(peerB.spent).toBe(10);
    expect(peerA.earned).toBe(10);
    expect(peerB.piecesDownloaded).toBe(10);
  });

  it('should track uploads without creating payments', () => {
    manager = new SwarmManager(manifests, seederAddress);
    const { send } = createMockSend();
    const peer = manager.registerPeer('abc123', send);

    manager.handlePieceUpload(peer.peerId, 5, 'some-wire', 256000);

    expect(peer.piecesUploaded).toBe(1);
    expect(peer.bytesUploaded).toBe(256000);
    expect(peer.earned).toBe(0); // payment triggered on download side
  });

  it('should disconnect peers and clean up', () => {
    manager = new SwarmManager(manifests, seederAddress);
    const { send } = createMockSend();
    const peer = manager.registerPeer('abc123', send);

    expect(manager.getPeersForContent('abc123')).toHaveLength(1);

    manager.disconnectPeer(peer.peerId);

    expect(manager.getPeersForContent('abc123')).toHaveLength(0);
    expect(manager.getPeer(peer.peerId)).toBeUndefined();
  });

  it('should return swarm status', () => {
    manager = new SwarmManager(manifests, seederAddress);
    const { send: s1 } = createMockSend();
    const { send: s2 } = createMockSend();

    manager.registerPeer('abc123', s1);
    manager.registerPeer('abc123', s2);

    const status = manager.getStatus();
    expect(status.activePeers).toBe(2);
    expect(status.peers).toHaveLength(2);
  });

  it('should broadcast swarm status when peers join/leave', () => {
    manager = new SwarmManager(manifests, seederAddress);
    const mock1 = createMockSend();
    const mock2 = createMockSend();

    const peerA = manager.registerPeer('abc123', mock1.send);

    // Peer A should get a swarm_status when B joins
    const statusBefore = mock1.messages.filter(m => m.type === 'swarm_status');
    expect(statusBefore.length).toBeGreaterThanOrEqual(1);

    manager.registerPeer('abc123', mock2.send);

    const statusAfter = mock1.messages.filter(m => m.type === 'swarm_status');
    expect(statusAfter.length).toBeGreaterThan(statusBefore.length);
  });

  it('should emit payment events', async () => {
    manager = new SwarmManager(manifests, seederAddress);
    const mock1 = createMockSend();
    const mock2 = createMockSend();

    const peerA = manager.registerPeer('abc123', mock1.send);
    const peerB = manager.registerPeer('abc123', mock2.send);
    manager.mapWirePeer('wire-a', peerA.peerId);

    const payments: any[] = [];
    manager.on('payment', (p) => payments.push(p));

    await manager.handlePieceDownload(peerB.peerId, 3, 'wire-a', 256000);

    expect(payments).toHaveLength(1);
    expect(payments[0].from).toBe(peerB.peerId);
    expect(payments[0].to).toBe(peerA.peerId);
    expect(payments[0].sats).toBe(1);
    expect(payments[0].txid).toBeTruthy();
  });
});
