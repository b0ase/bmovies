/**
 * StoryboardAgent — the frame-by-frame image generator.
 *
 * Takes an offer and generates one representative storyboard
 * image via BSVAPI's AtlasCloud image endpoint. For the hackathon
 * scope this is a single image per production (the hero frame),
 * not a full multi-frame board — multi-frame storyboards would
 * require integration with the DirectorAgent's shot list and
 * parallel BSVAPI calls that compound the per-production cost.
 *
 * Post-hackathon upgrade: accept an already-generated director
 * shot list and fan out to N image calls, one per shot, with the
 * resulting URLs stored as a single artifact or a set of
 * role='storyboard' rows tagged with sequence numbers.
 */

import { RoleAgent, type RoleResult } from './role-agent.js';
import type { ProductionOffer, ProductionRole } from '../registry.js';

const STORYBOARD_MODEL = 'z-image/turbo';

export class StoryboardAgent extends RoleAgent {
  readonly role: ProductionRole = 'storyboard';

  async execute(offer: ProductionOffer): Promise<RoleResult> {
    const client = this.client();

    // Build a single hero-frame prompt out of the offer metadata.
    // Uses a cinematic style hint that reads well on the z-image
    // model and distinguishes bMovies storyboards from random
    // generated images.
    const prompt =
      `Cinematic hero frame for a short film. ` +
      `Title: "${offer.title}". ${offer.synopsis} ` +
      `Dramatic lighting, 16:9 aspect, film grain, high contrast.`;

    const res = await client.generateImage<{
      url?: string;
      output?: string;
      outputs?: string[];
    }>({
      model: STORYBOARD_MODEL,
      prompt,
    });

    const url =
      res.body.url ??
      res.body.output ??
      (Array.isArray(res.body.outputs) ? res.body.outputs[0] : undefined) ??
      '';
    if (!url) {
      throw new Error(
        'StoryboardAgent: BSVAPI image response did not include a URL',
      );
    }

    const result: RoleResult = {
      role: this.role,
      url,
      kind: 'image',
      model: STORYBOARD_MODEL,
      prompt: offer.title,
      paymentTxid: res.paymentTxid,
    };
    this.recordArtifact(offer, result);
    return result;
  }
}
