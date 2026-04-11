/**
 * ProducerAgent — autonomously proposes productions, mints a
 * financing token for each, and waits for financier agents to
 * subscribe. When an offer reaches its funding target, the
 * producer transitions it into the 'producing' state.
 *
 * The actual token mint and capital transfer are wired up in
 * later tasks; this file handles the behavioral loop and the
 * registry interaction.
 */

import { Agent, type AgentIdentity } from './agent.js';
import type { AgentRegistry, ProductionOffer } from './registry.js';
import type { Wallet } from '../payment/wallet.js';

export interface ProducerConfig {
  /** Registry this producer posts offers to */
  registry: AgentRegistry;
  /** How many sats each production requires as funding */
  budgetSats: number;
  /** Max number of concurrent open offers */
  maxOpenOffers: number;
  /** Source of production ideas — producer cycles through these titles */
  productionIdeas: string[];
  /**
   * Optional async hook fired after proposeProduction posts an
   * offer into the registry. The live swarm plugs in a mint-presale
   * callback here so the producer broadcasts a BSV-21 token on
   * mainnet for every offer it posts. Errors are logged to the
   * agent log but do not crash the tick loop.
   */
  onOfferPosted?: (offer: ProductionOffer) => Promise<void>;
  /**
   * Optional async hook fired the first tick after an offer
   * transitions from 'funded' to 'producing'. The live swarm plugs
   * in a content-generation callback here that calls BSVAPI to
   * actually produce the image or video the offer proposed. The
   * hook should attach the returned artifact to the offer via
   * registry.attachArtifact(offerId, artifact). Errors are logged
   * to the agent log but do not crash the tick loop.
   */
  onOfferFunded?: (offer: ProductionOffer) => Promise<void>;
}

export class ProducerAgent extends Agent {
  private readonly cfg: ProducerConfig;
  private ideaCursor = 0;
  private offerCounter = 0;
  /** Offer IDs this agent is responsible for */
  private readonly myOffers = new Set<string>();

  constructor(
    identity: AgentIdentity,
    wallet: Wallet,
    cfg: ProducerConfig,
  ) {
    super(identity, wallet);
    if (identity.role !== 'producer') {
      throw new Error(
        `ProducerAgent requires role "producer", got "${identity.role}"`,
      );
    }
    this.cfg = cfg;
  }

  /** Offers this producer has posted that are still open or producing */
  getMyOffers(): ProductionOffer[] {
    const out: ProductionOffer[] = [];
    for (const id of this.myOffers) {
      const offer = this.cfg.registry.getOffer(id);
      if (offer) out.push(offer);
    }
    return out;
  }

  /**
   * Post a new offer immediately (outside the tick loop).
   * Returns the offer that was posted.
   */
  proposeProduction(title?: string): ProductionOffer {
    const pickedTitle =
      title ??
      this.cfg.productionIdeas[this.ideaCursor % this.cfg.productionIdeas.length];
    this.ideaCursor++;
    this.offerCounter++;

    const tokenTicker = `${this.identity.id.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6)}${String(this.offerCounter).padStart(3, '0')}`;

    const offer = this.cfg.registry.postOffer({
      producerId: this.identity.id,
      producerAddress: this.address,
      title: pickedTitle,
      synopsis: `${this.identity.name} proposes: "${pickedTitle}". Financing rights token ${tokenTicker}.`,
      requiredSats: this.cfg.budgetSats,
      tokenTicker,
    });

    this.myOffers.add(offer.id);
    this.record({
      kind: 'action',
      message: `Posted offer ${offer.id}: "${pickedTitle}" for ${this.cfg.budgetSats} sats (token ${tokenTicker})`,
      data: { offerId: offer.id, tokenTicker, requiredSats: this.cfg.budgetSats },
    });

    // Fire-and-forget the on-chain mint hook if provided. Errors
    // are captured in the agent log; the tick loop keeps running.
    if (this.cfg.onOfferPosted) {
      const hook = this.cfg.onOfferPosted;
      void hook(offer).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.record({
          kind: 'error',
          message: `onOfferPosted hook failed for ${offer.id}: ${message}`,
        });
      });
    }
    return offer;
  }

  /**
   * Autonomous behavior: if the producer has fewer than maxOpenOffers
   * currently open, post a new one. Transition funded offers to
   * producing status.
   *
   * The onOfferFunded hook is awaited one offer at a time. Fire-and-
   * forget across offers means multiple team dispatches run in
   * parallel and race for the same producer-wallet UTXOs, which ARC
   * rejects with DOUBLE_SPEND_ATTEMPTED. Serialising here guarantees
   * each team's payment broadcasts confirm before the next team
   * starts. The Agent base class's single-tick-in-flight guard
   * means the tick loop won't overlap even if a dispatch takes
   * minutes.
   */
  async tick(): Promise<void> {
    // Advance funded offers to producing state and kick off content generation
    for (const offer of this.getMyOffers()) {
      if (offer.status === 'funded') {
        this.cfg.registry.updateStatus(offer.id, 'producing');
        this.record({
          kind: 'event',
          message: `Offer ${offer.id} fully funded by ${offer.subscribers.length} financier(s); production begins`,
          data: { offerId: offer.id, raisedSats: offer.raisedSats },
        });

        if (this.cfg.onOfferFunded) {
          try {
            await this.cfg.onOfferFunded(offer);
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this.record({
              kind: 'error',
              message: `onOfferFunded hook failed for ${offer.id}: ${message}`,
            });
          }
        }
      }
    }

    // Count currently open offers
    const openCount = this.getMyOffers().filter((o) => o.status === 'open').length;
    if (openCount < this.cfg.maxOpenOffers) {
      this.proposeProduction();
    }
  }
}
