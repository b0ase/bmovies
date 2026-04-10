/**
 * ComposerAgent — the composer on the production team.
 *
 * Calls BSVAPI's /api/v1/music/generate endpoint (which in turn
 * proxies to Replicate's MusicGen) to produce a short theme
 * clip for the film. The returned URL is attached as an audio
 * artifact on the offer.
 *
 * Failure mode is explicit: if the upstream music provider is not
 * configured on BSVAPI (no REPLICATE_API_TOKEN on the server), the
 * BSVAPI call returns a 500 and our client raises. The producer's
 * team hook catches the error per-role so a missing composer does
 * not block the writer / director / storyboard roles from
 * completing — the production just ships without music.
 */

import { RoleAgent, type RoleResult } from './role-agent.js';
import type { ProductionOffer, ProductionRole } from '../registry.js';

const COMPOSER_MODEL = 'music-gen';
const DEFAULT_DURATION_SECONDS = 8;

export class ComposerAgent extends RoleAgent {
  readonly role: ProductionRole = 'composer';

  async execute(offer: ProductionOffer): Promise<RoleResult> {
    const client = this.client();

    const prompt =
      `Cinematic theme for a short film titled "${offer.title}". ` +
      `${offer.synopsis} Orchestral, atmospheric, 120bpm, minor key.`;

    const res = await client.generateMusic<{
      url?: string;
      output?: string;
      audio_url?: string;
    }>({
      prompt,
      duration: DEFAULT_DURATION_SECONDS,
    });

    const url =
      res.body.url ?? res.body.output ?? res.body.audio_url ?? '';
    if (!url) {
      throw new Error(
        'ComposerAgent: BSVAPI music response did not include a URL',
      );
    }

    const result: RoleResult = {
      role: this.role,
      url,
      kind: 'audio',
      model: COMPOSER_MODEL,
      prompt: offer.title,
      paymentTxid: res.paymentTxid,
    };
    this.recordArtifact(offer, result);
    return result;
  }
}
