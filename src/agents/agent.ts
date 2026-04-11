/**
 * Autonomous agent base class.
 *
 * An agent owns a BSV wallet, has an identity, logs its actions,
 * and exposes a tick() hook for its autonomous loop. Concrete
 * subclasses (ProducerAgent, FinancierAgent) define tick() behavior.
 */

import { Wallet } from '../payment/wallet.js';

export type AgentRole =
  | 'producer'
  | 'financier'
  | 'compute'
  | 'seeder'
  | 'writer'
  | 'director'
  | 'storyboard'
  | 'composer';

export interface AgentIdentity {
  /** Stable machine identifier — kebab-case, no spaces */
  id: string;
  /** Human-facing display name */
  name: string;
  /** Role in the production pipeline */
  role: AgentRole;
  /** One-sentence description used in the dashboard and in offer postings */
  persona: string;
}

export type AgentLogKind = 'action' | 'tx' | 'event' | 'error';

export interface AgentLogEntry {
  ts: number;
  kind: AgentLogKind;
  message: string;
  txid?: string;
  data?: unknown;
}

export abstract class Agent {
  readonly identity: AgentIdentity;
  readonly wallet: Wallet;
  private readonly log: AgentLogEntry[] = [];
  private tickHandle: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(identity: AgentIdentity, wallet: Wallet) {
    this.identity = identity;
    this.wallet = wallet;
  }

  get address(): string {
    return this.wallet.address;
  }

  get publicKeyHex(): string {
    return this.wallet.publicKeyHex;
  }

  get running(): boolean {
    return this.tickHandle !== null;
  }

  /** Append an entry to the agent's action log */
  protected record(entry: Omit<AgentLogEntry, 'ts'>): void {
    this.log.push({ ts: Date.now(), ...entry });
    // Mirror errors and tx events to stdout so the operator can
    // see hook failures (especially team-dispatch failures) live.
    // Without this, agent-internal errors silently disappear into
    // the in-memory ring buffer with no UI surface.
    if (entry.kind === 'error') {
      console.error(`[AGENT ✗] ${this.identity.id}: ${entry.message}`);
    } else if (entry.kind === 'tx') {
      const txSuffix = entry.txid ? ` tx ${entry.txid.slice(0, 12)}…` : '';
      console.log(`[AGENT ✓] ${this.identity.id}: ${entry.message}${txSuffix}`);
    }
  }

  /** Return the most recent log entries, newest first */
  getLog(limit = 50): AgentLogEntry[] {
    const start = Math.max(0, this.log.length - limit);
    return this.log.slice(start).reverse();
  }

  /** Number of log entries recorded */
  get logCount(): number {
    return this.log.length;
  }

  /**
   * Autonomous behavior hook, called on each tick of the agent loop.
   * Subclasses override this. Errors are caught by the runner and
   * recorded in the log rather than crashing the loop.
   */
  abstract tick(): Promise<void>;

  /**
   * Start the autonomous loop. Ticks run sequentially — if one tick
   * is still in flight when the next interval fires, the new tick is
   * skipped to avoid overlapping work on the same agent.
   */
  start(intervalMs: number): void {
    if (this.tickHandle) return;
    this.record({
      kind: 'event',
      message: `Agent started with interval ${intervalMs}ms`,
    });
    this.tickHandle = setInterval(() => {
      if (this.ticking) return;
      this.ticking = true;
      this.tick()
        .catch((err: unknown) => {
          const message =
            err instanceof Error ? err.message : String(err);
          this.record({ kind: 'error', message: `tick() threw: ${message}` });
        })
        .finally(() => {
          this.ticking = false;
        });
    }, intervalMs);
  }

  /** Stop the autonomous loop */
  stop(): void {
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
      this.record({ kind: 'event', message: 'Agent stopped' });
    }
  }

  /** Snapshot of agent state suitable for the dashboard JSON API */
  snapshot(): {
    identity: AgentIdentity;
    address: string;
    publicKeyHex: string;
    running: boolean;
    logCount: number;
  } {
    return {
      identity: this.identity,
      address: this.address,
      publicKeyHex: this.publicKeyHex,
      running: this.running,
      logCount: this.logCount,
    };
  }
}
