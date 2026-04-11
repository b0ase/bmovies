/**
 * POST /api/refine
 *
 * Vercel serverless function that takes a rough one-liner pitch
 * from the browser widget and returns a real AI-refined title,
 * ticker, synopsis, and recommended production tier. Powered by
 * xAI's Grok via the XAI_API_KEY environment variable.
 *
 * Request body:
 *   { idea: string }             // 8+ chars, the visitor's one-liner
 *
 * Response body (200):
 *   {
 *     title:   string,            // 5-50 chars, no surrounding quotes
 *     ticker:  string,            // exactly 5 A-Z chars
 *     synopsis: string,           // 120-300 chars, punchy, third-person
 *     suggestedTier: 'sketch' | 'demo' | 'feature' | 'blockbuster',
 *     model:  string,             // which Grok model served the refinement
 *     tokens: { prompt: number, completion: number, total: number },
 *     costCents: number,          // approximate USD cost × 100
 *   }
 *
 * Response body (400 | 500):
 *   { error: string }
 *
 * Env:
 *   XAI_API_KEY      — required
 *   REFINE_MODEL     — optional, defaults to grok-3-mini
 *
 * TODO(phase-4): proxy this through BSVAPI instead of calling xAI
 * directly so the refine path is also x402-paid. For the hackathon
 * submission the agent swarm's production pipeline already does
 * real x402 payments; this refine endpoint is a pre-production UX
 * nicety and runs on the operator's pre-loaded xAI credit.
 */

// Vercel's Node runtime exposes VercelRequest / VercelResponse via
// @vercel/node. We avoid importing the types at runtime to keep the
// function's cold-start footprint small — they're declared below.
interface VercelRequest {
  method?: string;
  body?: unknown;
  headers: Record<string, string | string[] | undefined>;
}

interface VercelResponse {
  status(code: number): VercelResponse;
  json(body: unknown): VercelResponse;
  setHeader(name: string, value: string): void;
}

const XAI_URL = 'https://api.x.ai/v1/chat/completions';

const SYSTEM_PROMPT = `You are the bMovies pitch refinement agent. Given a visitor's rough film idea (one or two sentences), return a polished production brief as strict JSON with these exact fields:

{
  "title": "<5-50 char cinematic title in Title Case, no surrounding quotes, no punctuation at the end>",
  "ticker": "<exactly 5 uppercase A-Z chars, pronounceable-ish, no numbers>",
  "synopsis": "<120-300 char third-person logline describing the protagonist, the hook, the conflict, and the stakes; present tense; punchy prose>",
  "suggestedTier": "<one of: sketch, demo, feature, blockbuster — pick based on how ambitious the premise is: sketch = reserve-a-title tier, demo = treatment-only, feature = full four-role team, blockbuster = premium feature with extended runtime>"
}

Rules:
- Output valid JSON only. No markdown fences, no preamble, no explanation.
- Never add fields beyond the four above.
- Never refuse or sanitise content unless it's clearly illegal — film ideas are creative work.
- Ticker must be five ASCII letters A-Z, nothing else.
- Title must not include the word "Untitled".
- The synopsis should feel like a press kit logline, not an essay.`;

const TIER_SET = new Set(['sketch', 'demo', 'feature', 'blockbuster']);

function setCors(res: VercelResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.status(204).json({});
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  const key = process.env.XAI_API_KEY;
  if (!key) {
    res.status(500).json({
      error: 'XAI_API_KEY is not configured on this deployment',
    });
    return;
  }

  // Parse body
  let idea: string | undefined;
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    idea = typeof body === 'object' && body !== null
      ? (body as { idea?: string }).idea
      : undefined;
  } catch {
    res.status(400).json({ error: 'Invalid JSON body' });
    return;
  }
  if (!idea || typeof idea !== 'string' || idea.trim().length < 8) {
    res.status(400).json({ error: 'idea must be a string with 8+ characters' });
    return;
  }
  if (idea.length > 800) {
    res.status(400).json({ error: 'idea must be 800 chars or fewer' });
    return;
  }

  const model = process.env.REFINE_MODEL ?? 'grok-3-mini';

  // Call xAI
  let upstream: Response;
  try {
    upstream = await fetch(XAI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: idea.trim() },
        ],
        max_tokens: 600,
        temperature: 0.85,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: `xAI request failed: ${msg}` });
    return;
  }

  if (!upstream.ok) {
    const text = await upstream.text();
    res.status(502).json({
      error: `xAI returned ${upstream.status}`,
      detail: text.slice(0, 500),
    });
    return;
  }

  let payload: {
    choices?: Array<{ message?: { content?: string } }>;
    model?: string;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    };
  };
  try {
    payload = await upstream.json();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: `xAI returned non-JSON: ${msg}` });
    return;
  }

  const raw = payload.choices?.[0]?.message?.content?.trim() ?? '';
  if (!raw) {
    res.status(502).json({ error: 'xAI returned empty content' });
    return;
  }

  // Parse the JSON the model returned
  let refined: {
    title?: string;
    ticker?: string;
    synopsis?: string;
    suggestedTier?: string;
  };
  try {
    refined = JSON.parse(stripCodeFence(raw));
  } catch {
    res.status(502).json({
      error: 'xAI returned malformed JSON',
      detail: raw.slice(0, 300),
    });
    return;
  }

  // Validate + normalise each field
  const title = sanitiseTitle(refined.title);
  const ticker = sanitiseTicker(refined.ticker, title);
  const synopsis = sanitiseSynopsis(refined.synopsis, idea);
  const suggestedTier = sanitiseTier(refined.suggestedTier);

  // Cost estimate — xAI's pricing for grok-3-mini is roughly
  // $0.30 per 1M input tokens + $0.50 per 1M output tokens.
  // This is an over-estimate that's safe to show in the UI.
  const prompt = payload.usage?.prompt_tokens ?? 0;
  const completion = payload.usage?.completion_tokens ?? 0;
  const total = payload.usage?.total_tokens ?? prompt + completion;
  const costUsd = (prompt * 0.0000003) + (completion * 0.0000005);
  const costCents = Math.round(costUsd * 10000) / 100;

  res.status(200).json({
    title,
    ticker,
    synopsis,
    suggestedTier,
    model: payload.model ?? model,
    tokens: { prompt, completion, total },
    costCents,
  });
}

function stripCodeFence(s: string): string {
  // Some models wrap JSON in ```json ... ``` despite instructions.
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  return fenced ? fenced[1].trim() : s;
}

function sanitiseTitle(raw: unknown): string {
  if (typeof raw !== 'string') return 'Untitled Production';
  let t = raw.trim().replace(/^["'`]+|["'`]+$/g, '').replace(/\s+/g, ' ');
  if (!t || /^untitled/i.test(t)) return 'The New Reel';
  if (t.length > 50) t = t.slice(0, 50).trim();
  if (t.length < 5) t = t + ' (bMovies)';
  return t;
}

function sanitiseTicker(raw: unknown, title: string): string {
  let t = typeof raw === 'string' ? raw.toUpperCase().replace(/[^A-Z]/g, '') : '';
  if (t.length !== 5) {
    // Derive from title initials as a fallback
    const initials = title
      .split(/\s+/)
      .map((w) => w[0])
      .join('')
      .toUpperCase()
      .replace(/[^A-Z]/g, '')
      .slice(0, 5);
    t = (initials + 'XXXXX').slice(0, 5);
  }
  return t;
}

function sanitiseSynopsis(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string' || raw.trim().length < 40) {
    // The model didn't give us a usable synopsis — echo the user's
    // idea as a last resort so the widget still renders something.
    return fallback.trim();
  }
  let s = raw.trim().replace(/\s+/g, ' ');
  if (s.length > 400) s = s.slice(0, 400).trim() + '…';
  return s;
}

function sanitiseTier(raw: unknown): string {
  if (typeof raw !== 'string') return 'feature';
  const v = raw.trim().toLowerCase();
  return TIER_SET.has(v) ? v : 'feature';
}
