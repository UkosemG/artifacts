// Bria Feed chat proxy.
//
// Holds the Anthropic API key as a Worker secret, verifies the caller's Google ID
// token (signature + claims) before doing anything, and relays the conversation to
// the Claude API, streaming the answer straight back to the browser.
//
// This Worker is the only real security boundary in the app: the sign-in gate on the
// static site is client-side UX and can be bypassed, but nothing reaches the Anthropic
// API without a valid, signed Google ID token from an allowed domain.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);

// Abuse limits — the client cannot raise any of these.
const MAX_BODY_BYTES = 64 * 1024;
const MAX_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 4000;
const MAX_CONTEXT_CHARS = 2000;
const MAX_OUTPUT_TOKENS = 2048;
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;

// Best-effort, per-isolate rate limiting. Isolates come and go, so this bounds
// casual over-use rather than enforcing a hard quota. KV or Durable Objects would
// be needed for the real thing.
const rateLimits = new Map();

let jwksCache = { keys: null, expiresAt: 0 };

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/healthz') {
      return json({ ok: true, service: 'bria-feed-chat' }, 200, cors);
    }

    if (request.method === 'POST' && url.pathname === '/chat') {
      return handleChat(request, env, ctx, cors);
    }

    return json({ error: 'not_found' }, 404, cors);
  },
};

function corsHeaders(origin, env) {
  const allowed = (env.ALLOWED_ORIGIN || '').split(',').map((o) => o.trim()).filter(Boolean);
  const headers = {
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };

  // Only ever echo an origin we were configured to trust — never a wildcard.
  if (origin && allowed.includes(origin)) {
    headers['access-control-allow-origin'] = origin;
  }

  return headers;
}

function json(body, status, cors) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...cors },
  });
}

/* ---------- Google ID token verification ---------- */

function base64UrlToBytes(input) {
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJwtPart(part) {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(part)));
}

async function getGoogleKeys() {
  const now = Date.now();
  if (jwksCache.keys && jwksCache.expiresAt > now) return jwksCache.keys;

  const res = await fetch(GOOGLE_CERTS_URL);
  if (!res.ok) throw new Error('jwks_fetch_failed');

  const body = await res.json();
  const cacheControl = res.headers.get('cache-control') || '';
  const maxAge = Number(/max-age=(\d+)/.exec(cacheControl)?.[1] || 3600);

  jwksCache = { keys: body.keys || [], expiresAt: now + maxAge * 1000 };
  return jwksCache.keys;
}

// Returns the verified payload, or throws an Error whose message is the failure reason.
async function verifyGoogleToken(token, env) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('malformed_token');

  const [headerPart, payloadPart, signaturePart] = parts;

  let header;
  let payload;
  try {
    header = decodeJwtPart(headerPart);
    payload = decodeJwtPart(payloadPart);
  } catch {
    throw new Error('malformed_token');
  }

  if (header.alg !== 'RS256') throw new Error('unsupported_alg');

  const keys = await getGoogleKeys();
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('unknown_key');

  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );

  const signed = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    base64UrlToBytes(signaturePart),
    signed
  );
  if (!valid) throw new Error('bad_signature');

  const now = Math.floor(Date.now() / 1000);
  if (!GOOGLE_ISSUERS.has(payload.iss)) throw new Error('bad_issuer');
  if (payload.aud !== env.GOOGLE_CLIENT_ID) throw new Error('bad_audience');
  if (typeof payload.exp !== 'number' || payload.exp <= now) throw new Error('expired');
  if (payload.email_verified !== true) throw new Error('email_unverified');

  const domain = String(env.ALLOWED_DOMAIN || '').toLowerCase();
  const hd = String(payload.hd || '').toLowerCase();
  const emailDomain = String(payload.email || '').split('@')[1]?.toLowerCase() || '';
  const domainOk = hd ? hd === domain : emailDomain === domain;
  if (!domainOk) throw new Error('wrong_domain');

  return payload;
}

/* ---------- Request validation ---------- */

function validateBody(body) {
  if (!body || typeof body !== 'object') throw new Error('Body must be a JSON object.');

  const { messages, context } = body;
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('messages must be a non-empty array.');
  }
  if (messages.length > MAX_MESSAGES) {
    throw new Error(`messages must contain at most ${MAX_MESSAGES} entries.`);
  }

  const clean = messages.map((m) => {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) {
      throw new Error('Each message needs a role of "user" or "assistant".');
    }
    if (typeof m.content !== 'string' || !m.content.trim()) {
      throw new Error('Each message needs non-empty string content.');
    }
    if (m.content.length > MAX_MESSAGE_CHARS) {
      throw new Error(`Messages must be under ${MAX_MESSAGE_CHARS} characters.`);
    }
    return { role: m.role, content: m.content };
  });

  if (clean[clean.length - 1].role !== 'user') {
    throw new Error('The last message must be from the user.');
  }

  return { messages: clean, context: context && typeof context === 'object' ? context : {} };
}

// The system prompt is built here, server-side, so a client cannot repurpose the
// API key for arbitrary work by supplying its own.
function buildSystemPrompt(context) {
  const clip = (value, max) => String(value ?? '').slice(0, max);

  const facts = Array.isArray(context.facts)
    ? context.facts
        .slice(0, 6)
        .map((f) => `- ${clip(f?.label, 60)}: ${clip(f?.value, 60)}`)
        .join('\n')
    : '';

  const card = [
    `Title: ${clip(context.title, 200)}`,
    context.description ? `Description: ${clip(context.description, 600)}` : '',
    facts ? `Key figures:\n${facts}` : '',
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, MAX_CONTEXT_CHARS);

  return [
    'You are an analyst assistant inside Bria Feed, an internal dashboard app at Bria (a visual AI company).',
    'A colleague is looking at one dashboard card and asking about it. Here is everything you can see:',
    '',
    card,
    '',
    'Answer only about this dashboard and the numbers above. You cannot open the live dashboard, run queries, or see any other data — if a question needs information you do not have, say so plainly and suggest what the person should check.',
    'Be concise and concrete. Lead with the answer, then the reasoning. Never invent figures that are not shown above.',
  ].join('\n');
}

function rateLimit(email) {
  const now = Date.now();
  const entry = rateLimits.get(email);

  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimits.set(email, { count: 1, windowStart: now });
    return true;
  }

  entry.count += 1;
  return entry.count <= RATE_LIMIT_MAX;
}

/* ---------- /chat ---------- */

async function handleChat(request, env, ctx, cors) {
  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: 'not_configured', message: 'Chat service is missing its API key.' }, 500, cors);
  }

  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) {
    return json({ error: 'unauthorized', message: 'Missing bearer token.' }, 401, cors);
  }

  let payload;
  try {
    payload = await verifyGoogleToken(token, env);
  } catch (error) {
    const status = error.message === 'wrong_domain' ? 403 : 401;
    return json({ error: error.message, message: 'Sign in again to continue.' }, status, cors);
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return json({ error: 'too_large', message: 'Request body is too large.' }, 413, cors);
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: 'bad_json', message: 'Request body must be valid JSON.' }, 400, cors);
  }

  let validated;
  try {
    validated = validateBody(body);
  } catch (error) {
    return json({ error: 'bad_request', message: error.message }, 400, cors);
  }

  if (!rateLimit(payload.email)) {
    return json(
      { error: 'rate_limited', message: 'Too many questions in a short window. Try again shortly.' },
      429,
      cors
    );
  }

  const upstream = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: env.CLAUDE_MODEL || 'claude-opus-5',
      max_tokens: MAX_OUTPUT_TOKENS,
      stream: true,
      output_config: { effort: 'low' },
      system: buildSystemPrompt(validated.context),
      messages: validated.messages,
    }),
  });

  if (!upstream.ok || !upstream.body) {
    // Never surface upstream error detail — it can leak account and key context.
    console.error('anthropic_error', upstream.status, await upstream.text().catch(() => ''));
    const status = upstream.status === 429 ? 429 : 502;
    return json(
      { error: 'upstream_error', message: 'The chat service had a problem. Try again in a moment.' },
      status,
      cors
    );
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      ...cors,
    },
  });
}
