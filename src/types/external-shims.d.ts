/**
 * Ambient module declarations for npm packages that ship without
 * their own TypeScript types and have no @types/* sibling. Each
 * shim is intentionally narrow — only the surface bMovies actually
 * uses is described, so adding new call sites that touch additional
 * APIs will surface a typecheck error rather than silently passing.
 */

declare module 'create-torrent' {
  import type { Buffer } from 'node:buffer';

  interface CreateTorrentOptions {
    name?: string;
    comment?: string;
    createdBy?: string;
    creationDate?: Date | number;
    pieceLength?: number;
    private?: boolean;
    announce?: string[] | string[][];
    announceList?: string[][];
    urlList?: string[];
    info?: Record<string, unknown>;
  }

  type CreateTorrentInput =
    | string
    | Buffer
    | File
    | Array<string | Buffer | File>;

  type CreateTorrentCallback = (err: Error | null, torrent: Buffer) => void;

  // Two distinct overloads so node:util.promisify resolves to
  // (input, opts) => Promise<Buffer> instead of dropping the opts
  // arg in favour of the (input, callback) shape.
  function createTorrent(
    input: CreateTorrentInput,
    callback: CreateTorrentCallback,
  ): void;
  function createTorrent(
    input: CreateTorrentInput,
    opts: CreateTorrentOptions,
    callback: CreateTorrentCallback,
  ): void;

  export = createTorrent;
}

declare module 'parse-torrent' {
  import type { Buffer } from 'node:buffer';

  interface ParsedTorrent {
    infoHash: string;
    name?: string;
    announce?: string[];
    urlList?: string[];
    files?: Array<{
      path: string;
      name: string;
      length: number;
      offset: number;
    }>;
    length?: number;
    pieceLength?: number;
    lastPieceLength?: number;
    pieces?: string[];
    info?: Record<string, unknown>;
    infoBuffer?: Buffer;
    comment?: string;
    createdBy?: string;
    created?: Date;
    private?: boolean;
  }

  function parseTorrent(
    input: string | Buffer | ParsedTorrent,
  ): ParsedTorrent;

  namespace parseTorrent {
    function toMagnetURI(parsed: ParsedTorrent): string;
    function toTorrentFile(parsed: ParsedTorrent): Buffer;
  }

  export = parseTorrent;
}

declare module 'webtorrent' {
  import { EventEmitter } from 'node:events';
  import type { Buffer } from 'node:buffer';

  namespace WebTorrent {
    interface TorrentFile {
      name: string;
      path: string;
      length: number;
      downloaded: number;
      progress: number;
      createReadStream(opts?: { start?: number; end?: number }): NodeJS.ReadableStream;
    }

    interface Torrent extends EventEmitter {
      infoHash: string;
      magnetURI: string;
      torrentFile: Buffer;
      name: string;
      length: number;
      downloaded: number;
      uploaded: number;
      progress: number;
      numPeers: number;
      files: TorrentFile[];
      destroy(callback?: (err?: Error) => void): void;
      pause(): void;
      resume(): void;
    }

    interface AddOptions {
      path?: string;
      announce?: string[];
      private?: boolean;
    }

    interface SeedOptions extends AddOptions {
      name?: string;
      comment?: string;
      createdBy?: string;
    }

    interface ClientOptions {
      tracker?: boolean;
      dht?: boolean;
      webSeeds?: boolean;
      maxConns?: number;
      nodeId?: string;
      peerId?: string;
    }

    /** WebTorrent client instance type (for declaration sites). */
    type Instance = WebTorrent;
  }

  class WebTorrent extends EventEmitter {
    constructor(opts?: WebTorrent.ClientOptions);
    add(
      torrentId: string | Buffer,
      opts?: WebTorrent.AddOptions,
      onTorrent?: (torrent: WebTorrent.Torrent) => void,
    ): WebTorrent.Torrent;
    seed(
      input: string | Buffer | File | Array<string | Buffer | File>,
      opts?: WebTorrent.SeedOptions,
      onSeed?: (torrent: WebTorrent.Torrent) => void,
    ): WebTorrent.Torrent;
    remove(
      torrentId: string | Buffer | WebTorrent.Torrent,
      callback?: (err?: Error) => void,
    ): void;
    destroy(callback?: (err?: Error) => void): void;
    readonly torrents: WebTorrent.Torrent[];
  }

  export = WebTorrent;
}
