/**
 * $402 Payment Gate middleware.
 *
 * Returns HTTP 402 with payment terms when content is requested
 * without a valid payment header. The response includes the
 * magnet URI and manifest so the client can start the torrent
 * + payment channel flow.
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import type { ContentManifest } from '../../types/torrent.js';
import { estimateTotalCost } from '../../ingest/manifest.js';

export interface PaymentGateContext {
  getManifest(infohash: string): ContentManifest | undefined;
  getMagnetURI(infohash: string): string | undefined;
}

/**
 * Create a $402 payment gate handler.
 */
export function createPaymentGate(ctx: PaymentGateContext) {
  return async (request: FastifyRequest<{ Params: { infohash: string } }>, reply: FastifyReply) => {
    const { infohash } = request.params;

    const manifest = ctx.getManifest(infohash);
    if (!manifest) {
      return reply.status(404).send({ error: 'Content not found' });
    }

    const magnetURI = ctx.getMagnetURI(infohash);

    // Check for payment header (future: validate BSV payment proof)
    const paymentHeader = request.headers['x-bsv-payment'];
    if (paymentHeader) {
      // In production: validate the payment tx and grant access
      // For PoC: any non-empty header is accepted
      return reply.send({
        status: 'paid',
        magnetURI,
        manifest,
      });
    }

    // No payment — return 402 with terms
    return reply.status(402).send({
      status: 'payment_required',
      x402Version: 1,
      accepts: [
        {
          scheme: 'bct_channel',
          network: 'bsv',
          estimatedCost: estimateTotalCost(manifest),
          satsPerPiece: manifest.pricing.satsPerPiece,
          totalPieces: manifest.totalPieces,
          resource: `/api/stream/${infohash}`,
        },
      ],
      torrent: {
        infohash,
        magnetURI,
        manifest,
      },
    });
  };
}
