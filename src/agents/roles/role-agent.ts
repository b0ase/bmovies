/**
 * RoleAgent — shared base for the team-of-agents refactor.
 *
 * Each role (Director, Writer, Storyboard, Composer) is an Agent
 * subclass whose tick() is driven by the producer via execute(brief).
 * Role agents don't run their own autonomous loop the way Producer
 * and Financier do — they are invoked on demand when a production
 * enters the funded state and need to do their piece.
 *
 * Every role holds its own BSV wallet, has its own BSVAPI budget
 * from the raised production capital, and attaches its own artifact
 * row to the registry on completion.
 */

import { Agent, type AgentIdentity } from '../agent.js';
import { BsvapiClient } from '../bsvapi-client.js';
import type { Wallet } from '../../payment/wallet.js';
import type { TxBroadcaster } from '../../payment/broadcaster.js';
import type {
  AgentRegistry,
  ProductionOffer,
  ProductionRole,
} from '../registry.js';

export interface RoleResult {
  role: ProductionRole;
  url: string;
  kind: 'image' | 'video' | 'text' | 'audio';
  model: string;
  prompt: string;
  paymentTxid: string;
}

export interface RoleAgentConfig {
  /** Base URL of the BSVAPI gateway (e.g. https://www.bsvapi.com) */
  bsvapiBaseUrl: string;
  /** Optional broadcaster for payment txs — shared with the swarm */
  broadcaster?: TxBroadcaster;
  /** Registry the role writes its artifact into */
  registry: AgentRegistry;
  /** Budget in sats this role may spend per production */
  budgetSats: number;
}

/**
 * Base class. Concrete roles override buildBrief() to translate an
 * offer into a provider-specific prompt and executeRole() to make
 * the actual BSVAPI call.
 */
export abstract class RoleAgent extends Agent {
  protected readonly cfg: RoleAgentConfig;

  constructor(identity: AgentIdentity, wallet: Wallet, cfg: RoleAgentConfig) {
    super(identity, wallet);
    this.cfg = cfg;
  }

  abstract readonly role: ProductionRole;

  /**
   * Role agents don't run a passive tick loop; the producer invokes
   * execute() directly. tick() is a no-op so the Agent base class's
   * start/stop still works for uniform lifecycle.
   */
  async tick(): Promise<void> {
    /* no-op */
  }

  /**
   * Make a BsvapiClient configured for this role's wallet and the
   * swarm's shared broadcaster.
   */
  protected client(): BsvapiClient {
    return new BsvapiClient({
      baseUrl: this.cfg.bsvapiBaseUrl,
      wallet: this.wallet,
      broadcaster: this.cfg.broadcaster,
    });
  }

  /**
   * Record a successful role execution: attach an artifact row to
   * the offer with this role's tag, and log the event.
   */
  protected recordArtifact(offer: ProductionOffer, result: RoleResult): void {
    this.cfg.registry.attachArtifact(offer.id, {
      kind: result.kind,
      url: result.url,
      model: result.model,
      prompt: result.prompt,
      paymentTxid: result.paymentTxid,
      createdAt: Date.now(),
      role: result.role,
    });
    this.record({
      kind: 'tx',
      message:
        `${this.role} for ${offer.id}: ${result.kind} via ${result.model}`,
      txid: result.paymentTxid,
      data: { offerId: offer.id, url: result.url },
    });
  }

  /**
   * Concrete roles implement this to make their BSVAPI call and
   * return the shape above. Errors propagate to the caller so the
   * producer can decide how to handle partial-team failures.
   */
  abstract execute(offer: ProductionOffer): Promise<RoleResult>;
}
