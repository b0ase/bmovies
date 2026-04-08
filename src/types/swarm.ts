/**
 * Swarm types for P2P re-seeding coordination.
 */

/** A browser viewer connected to the swarm */
export interface SwarmPeer {
  peerId: string;
  walletAddress: string;
  infohash: string;
  connectedAt: number;
  piecesDownloaded: number;
  piecesUploaded: number;
  bytesDownloaded: number;
  bytesUploaded: number;
  /** Sats earned from re-seeding to other peers */
  earned: number;
  /** Sats spent downloading from peers */
  spent: number;
}

/** WebSocket messages: browser → server */
export type ClientSwarmMessage =
  | { type: 'register'; infohash: string }
  | { type: 'piece_downloaded'; pieceIndex: number; fromPeerId: string; bytes: number }
  | { type: 'piece_uploaded'; pieceIndex: number; toPeerId: string; bytes: number };

/** WebSocket messages: server → browser */
export type ServerSwarmMessage =
  | { type: 'registered'; peerId: string; walletAddress: string }
  | { type: 'payment_made'; pieceIndex: number; fromPeer: string; toPeer: string; sats: number; txid: string }
  | { type: 'earnings_update'; earned: number; spent: number; net: number }
  | { type: 'swarm_status'; peers: number; totalUploaded: number; totalDownloaded: number }
  | { type: 'error'; message: string };

/** Swarm status for the HTTP status endpoint */
export interface SwarmStatus {
  activePeers: number;
  totalPiecesTransferred: number;
  totalSatsTransferred: number;
  peers: SwarmPeer[];
}
