/**
 * DirectorAgent — the director on the production team.
 *
 * Takes an offer's title and synopsis and calls BSVAPI's chat
 * completions endpoint with a director system prompt to produce
 * a shot list: 4-6 key frames described as short visual prompts
 * that the storyboard agent can use as generation prompts.
 *
 * The output is a JSON-encoded array embedded in a data: URL so
 * the artifact table can store it as a text artifact alongside
 * image artifacts from the other roles.
 */

import { RoleAgent, type RoleResult } from './role-agent.js';
import type { ProductionOffer, ProductionRole } from '../registry.js';

const DIRECTOR_SYSTEM_PROMPT = `You are a film director for bMovies,
a decentralised AI film studio. Given a title and synopsis, produce
a shot list of 4-6 key frames. Each shot should be a single short
visual prompt (12-20 words) that could be passed directly to a
text-to-image model like z-image/turbo. Return ONLY a JSON array
of strings, no prose, no keys. Example:
["A lone astronaut stands in front of a crimson dust storm",
 "Extreme close-up on cracked helmet visor reflecting city lights", ...]`;

const DIRECTOR_MODEL = 'grok-3-mini';

export class DirectorAgent extends RoleAgent {
  readonly role: ProductionRole = 'director';

  async execute(offer: ProductionOffer): Promise<RoleResult> {
    const client = this.client();
    const userPrompt =
      `Title: ${offer.title}\n\nSynopsis: ${offer.synopsis}\n\n` +
      'Return the shot list JSON now.';

    const res = await client.chat<{
      choices?: Array<{ message?: { content?: string } }>;
    }>({
      model: DIRECTOR_MODEL,
      messages: [
        { role: 'system', content: DIRECTOR_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 400,
      temperature: 0.7,
    });

    const raw = res.body.choices?.[0]?.message?.content?.trim() ?? '';
    if (!raw) {
      throw new Error('DirectorAgent: BSVAPI chat returned empty content');
    }

    // Validate the model actually returned a JSON array. If it
    // wraps the JSON in prose we try to extract the first bracketed
    // array; if that still fails we store the raw text rather than
    // throwing — a partial shot list is better than a failed role.
    let shotListJson = raw;
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error('not an array');
      shotListJson = JSON.stringify(parsed);
    } catch {
      const match = raw.match(/\[[\s\S]*\]/);
      if (match) {
        try {
          const parsed = JSON.parse(match[0]);
          if (Array.isArray(parsed)) shotListJson = JSON.stringify(parsed);
        } catch {
          /* fall through — store raw */
        }
      }
    }

    const dataUrl =
      'data:application/json;charset=utf-8,' + encodeURIComponent(shotListJson);

    const result: RoleResult = {
      role: this.role,
      url: dataUrl,
      kind: 'text',
      model: DIRECTOR_MODEL,
      prompt: offer.title,
      paymentTxid: res.paymentTxid,
    };
    this.recordArtifact(offer, result);
    return result;
  }

  /**
   * Parse a stored director shot list back into a string array.
   * Used by the StoryboardAgent to know which prompts to feed the
   * image model. Returns an empty array on malformed input.
   */
  static parseShotList(dataUrl: string): string[] {
    try {
      const decoded = decodeURIComponent(
        dataUrl.replace(/^data:[^,]+,/, ''),
      );
      const parsed = JSON.parse(decoded);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((x) => typeof x === 'string');
    } catch {
      return [];
    }
  }
}
