/**
 * Configuration types.
 */

/** Seeder node configuration */
export interface SeederConfig {
  /** BSV private key WIF for receiving payments */
  privateKeyWif: string;
  /** Directory for torrent data storage */
  storagePath: string;
  /** Max storage in bytes */
  maxStorageBytes: number;
  /** Default price per piece in satoshis */
  defaultSatsPerPiece: number;
  /** API server port */
  port: number;
}

/** Leecher/player configuration */
export interface PlayerConfig {
  /** BSV private key WIF for funding channels */
  privateKeyWif: string;
  /** Max satoshis to deposit per channel */
  maxChannelDeposit: number;
  /** Pieces to buffer ahead of playback */
  lookahead: number;
  /** WebTorrent tracker URLs */
  trackers: string[];
}

/** Default WebTorrent tracker URLs */
export const DEFAULT_TRACKERS = [
  'wss://tracker.webtorrent.dev',
  'wss://tracker.btorrent.xyz',
  'wss://tracker.openwebtorrent.com',
];

/** Default configuration values */
export const DEFAULTS = {
  satsPerPiece: 1,
  creatorSplitBps: 6000,
  pieceLength: 262144, // 256KB
  lookahead: 10,
  maxChannelDeposit: 100_000, // 100k sats (~$0.05)
  port: 8404, // 8402 used by ClawMiner
  timeoutBlocks: 144, // ~1 day
} as const;
