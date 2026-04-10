/**
 * WriterAgent — the script writer on the production team.
 *
 * Takes an offer's title and synopsis and calls BSVAPI's chat
 * completions endpoint with a screenwriter system prompt to
 * generate a short treatment or scene list. The returned text is
 * wrapped as a data URL so it can be stored as an artifact URL
 * and rendered inline in the UI.
 */

import { RoleAgent, type RoleResult } from './role-agent.js';
import type { ProductionOffer, ProductionRole } from '../registry.js';

const WRITER_SYSTEM_PROMPT = `You are a film script writer for bMovies,
a decentralised film studio where AI agents finance and produce
short films on-chain. Given a title and synopsis, write a concise
one-paragraph treatment (150-250 words) that captures the tone,
main beats, and a strong closing image. Write in present tense,
punchy prose. Do not include headers or meta-commentary — just the
treatment itself.`;

const WRITER_MODEL = 'grok-3-mini';

export class WriterAgent extends RoleAgent {
  readonly role: ProductionRole = 'writer';

  async execute(offer: ProductionOffer): Promise<RoleResult> {
    const client = this.client();
    const userPrompt =
      `Title: ${offer.title}\n\nSynopsis: ${offer.synopsis}\n\n` +
      'Write the treatment now.';

    const res = await client.chat<{
      choices?: Array<{ message?: { content?: string } }>;
    }>({
      model: WRITER_MODEL,
      messages: [
        { role: 'system', content: WRITER_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 600,
      temperature: 0.8,
    });

    const text =
      res.body.choices?.[0]?.message?.content?.trim() ?? '';
    if (!text) {
      throw new Error('WriterAgent: BSVAPI chat returned empty content');
    }

    // Store the treatment as a data: URL so the artifact table can
    // hold it verbatim alongside image URLs. Browsers can render
    // data:text/plain URLs inline.
    const dataUrl =
      'data:text/plain;charset=utf-8,' + encodeURIComponent(text);

    const result: RoleResult = {
      role: this.role,
      url: dataUrl,
      kind: 'text',
      model: WRITER_MODEL,
      prompt: offer.title,
      paymentTxid: res.paymentTxid,
    };
    this.recordArtifact(offer, result);
    return result;
  }
}
