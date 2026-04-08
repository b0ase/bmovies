/**
 * Torrent and content manifest types.
 */

/** Fragment map entry — which pieces form a playable video fragment */
export interface FragmentRange {
  startPiece: number;
  endPiece: number;
}

/** Content manifest — describes payment terms and codec info */
export interface ContentManifest {
  version: 1;
  /** Torrent infohash (hex) */
  infohash: string;
  title: string;
  contentType: string;
  /** Duration in seconds */
  duration: number;
  totalPieces: number;
  totalBytes: number;

  /** Payment terms */
  pricing: {
    satsPerPiece: number;
    /** Init segment pieces are free (needed for codec setup) */
    initPiecesFree: boolean;
    currency: 'BSV';
  };

  /** Content creator */
  creator: {
    address: string;
    name?: string;
    /** Revenue share in basis points (6000 = 60%) */
    splitBps: number;
  };

  /** Codec info for MediaSource API */
  codec: {
    /** e.g. 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"' */
    mimeCodec: string;
    /** How many pieces form the init segment */
    initPieceCount: number;
    /** Map of fragment index to piece range */
    fragmentMap: FragmentRange[];
  };
}

/** Result of content ingestion */
export interface IngestResult {
  /** Raw .torrent file bytes */
  torrentFile: Buffer;
  manifest: ContentManifest;
  infohash: string;
  magnetURI: string;
}

/** Catalog entry for content discovery */
export interface CatalogEntry {
  infohash: string;
  magnetURI: string;
  title: string;
  duration: number;
  satsPerPiece: number;
  /** Estimated total cost in satoshis for full playback */
  totalCost: number;
  seeders: number;
  manifest: ContentManifest;
}
