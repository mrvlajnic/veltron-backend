'use strict';

const express = require('express');
const path = require('path');
const { loadSupportConfig } = require('./validate-config');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'openrouter/auto';
const MAX_MESSAGE_LENGTH = 2000;
const MAX_HISTORY_MESSAGES = 20;
const MAX_OUTPUT_TOKENS = 1024;
const REQUEST_TIMEOUT_MS = 45000;
const RATE_LIMIT_WINDOW_MS = 60000;
const RATE_LIMIT_MAX_REQUESTS = Number(process.env.AI_LAB_RATE_LIMIT) || 10;
const ALLOWED_ORIGINS = [
  'https://veltroncars.com',
  'https://www.veltroncars.com',
  'http://localhost:5000',
  'http://127.0.0.1:5000',
  'http://localhost:5173',
];

// Live site browsing (tool calling). The model may ask the server to fetch a
// page from the public site; the server strips it to text and returns it.
// This keeps the assistant current without maintaining facts in the JSON config.
const SITE_ORIGIN = 'https://veltroncars.com';
const SITE_FETCH_TIMEOUT_MS = 8000;
const SITE_MAX_HTML_BYTES = 500000;
const SITE_MAX_TEXT_CHARS = 8000;
const SITE_CACHE_TTL_MS = 5 * 60 * 1000;
const SITE_CACHE_MAX_ENTRIES = 30;
const MAX_TOOL_ROUNDS = 3;
const BROWSABLE_SITE_PATHS = [
  '/index.html',
  '/vision.html',
  '/concepts.html',
  '/concept-v1-sportline.html',
  '/construction.html',
  '/about.html',
  '/contact.html',
  '/journal.html',
  '/pitch-deck.html',
  '/VeltronV1.html',
];

const SITE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'browse_veltron_site',
      description:
        'Fetch the current published text content of a page on the official veltroncars.com website. Use this to read the latest site information when it is not covered by the verified facts.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            enum: BROWSABLE_SITE_PATHS,
            description: 'Path of the site page to read, e.g. "/vision.html".',
          },
        },
        required: ['path'],
      },
    },
  },
];

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|footer|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeSitePath(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error('path must be a non-empty string');
  }
  let p = raw.trim();
  if (p.length > 200) throw new Error('path is too long');
  if (!p.startsWith('/')) p = `/${p}`;
  p = p.split('?')[0].split('#')[0];
  p = p.replace(/\/{2,}/g, '/');
  if (p !== '/' && p.endsWith('/')) p = p.slice(0, -1);
  if (p === '/') p = '/index.html';
  if (!/^\/[A-Za-z0-9\-._]*$/.test(p)) {
    throw new Error('path is not a supported site page');
  }
  if (!BROWSABLE_SITE_PATHS.includes(p)) {
    throw new Error('path is not on the browsable site map');
  }
  return p;
}

const siteCache = new Map();

function readSiteCache(path) {
  const hit = siteCache.get(path);
  if (!hit) return null;
  if (Date.now() - hit.at > SITE_CACHE_TTL_MS) {
    siteCache.delete(path);
    return null;
  }
  return hit.text;
}

function writeSiteCache(path, text) {
  if (siteCache.size >= SITE_CACHE_MAX_ENTRIES) {
    const oldest = siteCache.keys().next().value;
    siteCache.delete(oldest);
  }
  siteCache.set(path, { text, at: Date.now() });
}

async function browseSitePage(rawPath) {
  const path = normalizeSitePath(rawPath);
  const cached = readSiteCache(path);
  if (cached) {
    return { path, content: cached };
  }

  const url = `${SITE_ORIGIN}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SITE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html',
        'User-Agent': 'VeltronAILab/1.0 (+https://veltroncars.com)',
      },
    });
    if (!response.ok) {
      throw new Error(`the page returned HTTP ${response.status}`);
    }
    if (response.url) {
      const finalUrl = new URL(response.url);
      if (finalUrl.origin !== SITE_ORIGIN) {
        throw new Error('the page redirected off-site');
      }
    }
    const html = (await response.text()).slice(0, SITE_MAX_HTML_BYTES);
    const text = htmlToText(html).slice(0, SITE_MAX_TEXT_CHARS);
    if (text.length === 0) {
      throw new Error('the page had no readable text');
    }
    const content = `LIVE CONTENT OF ${path} (fetched from veltroncars.com):\n\n${text}`;
    writeSiteCache(path, content);
    return { path, content };
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('the site took too long to respond');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function createRateLimiter(maxOverride) {
  const max = Number(maxOverride) || RATE_LIMIT_MAX_REQUESTS;
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [key, window] of hits) {
      if (now - window.start > RATE_LIMIT_WINDOW_MS * 2) hits.delete(key);
    }
  }, RATE_LIMIT_WINDOW_MS).unref();

  return function rateLimit(req, res, next) {
    const key = req.ip || 'unknown';
    const now = Date.now();
    let window = hits.get(key);
    if (!window || now - window.start > RATE_LIMIT_WINDOW_MS) {
      window = { start: now, count: 0 };
      hits.set(key, window);
    }
    window.count += 1;
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - window.count)));
    if (window.count > max) {
      return res.status(429).json({
        error: 'Rate limit exceeded. Please wait a moment before sending another message.',
        code: 'RATE_LIMITED',
      });
    }
    return next();
  };
}

function applySecurityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  next();
}

function validateChatBody(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return 'Request body must be a JSON object.';
  }
  const { message, history, model, website_hp } = body;

  // Honeypot: hidden field that humans never fill. Bots that auto-fill forms trip it.
  // Message is deliberately generic so it cannot be used to probe the defense.
  if (typeof website_hp === 'string' && website_hp.trim() !== '') {
    return 'Invalid request.';
  }
  if (website_hp !== undefined && typeof website_hp !== 'string') {
    return 'Invalid request.';
  }

  if (typeof message !== 'string' || message.trim().length === 0) {
    return 'Field "message" must be a non-empty string.';
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return `Field "message" must not exceed ${MAX_MESSAGE_LENGTH} characters.`;
  }
  if (history !== undefined) {
    if (!Array.isArray(history)) {
      return 'Field "history" must be an array of messages.';
    }
    if (history.length > MAX_HISTORY_MESSAGES) {
      return `Field "history" must not exceed ${MAX_HISTORY_MESSAGES} messages.`;
    }
    for (let i = 0; i < history.length; i += 1) {
      const entry = history[i];
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        return `History entry ${i} must be an object with "role" and "content".`;
      }
      if (entry.role !== 'user' && entry.role !== 'assistant') {
        return `History entry ${i} has an invalid role. Only "user" and "assistant" are allowed.`;
      }
      if (typeof entry.content !== 'string' || entry.content.length > MAX_MESSAGE_LENGTH) {
        return `History entry ${i} content must be a string of at most ${MAX_MESSAGE_LENGTH} characters.`;
      }
    }
  }
  if (model !== undefined && typeof model !== 'string') {
    return 'Field "model" must be a string.';
  }
  return null;
}

function buildSystemPrompt(config) {
  const lines = [];
  lines.push(`You are ${config.name}, an experimental AI customer-support assistant for Veltron Auto.`);
  lines.push(`Persona: ${config.persona.role}. Tone: ${config.persona.tone.join(', ')}. Verbosity: ${config.persona.verbosity}.`);
  lines.push(`Language policy: ${config.language_policy}`);
  lines.push('');
  lines.push('Support policies you must follow:');
  for (const policy of config.policies) {
    lines.push(`- [${policy.id}] ${policy.instruction}`);
  }
  lines.push('');
  lines.push('Verified facts you may rely on:');
  for (const fact of config.verified_facts) {
    lines.push(`- ${fact.fact}`);
  }
  lines.push('');
  lines.push('Live site access:');
  lines.push('You can call the browse_veltron_site tool to fetch the current published text of a veltroncars.com page. Page map: /index.html is the home page, /vision.html is Vision, /concepts.html is Concepts, /concept-v1-sportline.html is the V1 SportLine concept, /construction.html is the Process page, /about.html is About, /contact.html is Contact, /journal.html is Journal, /pitch-deck.html is the pitch deck, /VeltronV1.html is the V1 archive.');
  lines.push('Rules for using the tool:');
  lines.push('- If the user asks you to check, browse, quote, or read the live site or a specific page, you MUST call browse_veltron_site at least once before answering. Never answer such requests from memory alone.');
  lines.push('- For details not covered by the verified facts (specific page copy, page sections, contact options, recently published updates), browse the relevant page instead of guessing.');
  lines.push('- Prefer the verified facts above for stable company information when browsing is not needed.');
  lines.push('- After a successful browse, answer from the retrieved page text and briefly note that you checked the live site. If browsing fails, say you could not access the page and answer from the verified facts only.');
  lines.push('');
  lines.push('Example interactions demonstrating the expected behavior:');
  for (const example of config.examples) {
    lines.push(`- User: ${example.user}`);
    lines.push(`  Assistant: ${example.assistant}`);
  }
  lines.push('');
  lines.push('Known limitations:');
  for (const limitation of config.limitations) {
    lines.push(`- ${limitation}`);
  }
  return lines.join('\n');
}

async function callOpenRouter({ apiKey, model, messages, tools }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const payload = {
      model,
      messages,
      max_tokens: MAX_OUTPUT_TOKENS,
    };
    if (Array.isArray(tools) && tools.length > 0) {
      payload.tools = tools;
      payload.tool_choice = 'auto';
    }
    const response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://veltroncars.com/ai-lab/',
        'X-Title': 'Veltron AI Lab',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      let detail = '';
      try {
        const data = await response.json();
        detail = data && data.error && data.error.message ? data.error.message : '';
      } catch (_) {
        detail = '';
      }
      const err = new Error(`Provider request failed (HTTP ${response.status}).${detail ? ` ${detail}` : ''}`);
      err.status = response.status >= 500 ? 502 : 502;
      err.code = 'PROVIDER_ERROR';
      throw err;
    }

    const data = await response.json();
    const message = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message
      : null;
    if (!message) {
      const err = new Error('Provider returned an empty response.');
      err.code = 'PROVIDER_ERROR';
      throw err;
    }
    const toolCalls = Array.isArray(message.tool_calls)
      ? message.tool_calls.filter((tc) => tc && tc.function && typeof tc.function.name === 'string')
      : [];
    const content = message.content;
    if (toolCalls.length === 0 && (typeof content !== 'string' || content.trim().length === 0)) {
      const err = new Error('Provider returned an empty response.');
      err.code = 'PROVIDER_ERROR';
      throw err;
    }
    return {
      reply: typeof content === 'string' ? content : '',
      toolCalls,
      assistantTurn: {
        role: 'assistant',
        content: typeof content === 'string' ? content : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
      model: typeof data.model === 'string' ? data.model : model,
      usage: data.usage || null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function runChatWithTools({ apiKey, model, messages, browsedPages }) {
  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const result = await callOpenRouter({ apiKey, model, messages, tools: SITE_TOOLS });
    if (result.toolCalls.length === 0) {
      return result;
    }
    messages.push(result.assistantTurn);
    for (const call of result.toolCalls) {
      let content;
      try {
        const args = typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments) : {};
        const page = await browseSitePage(args.path);
        if (!browsedPages.includes(page.path)) browsedPages.push(page.path);
        content = page.content;
      } catch (err) {
        content = `Tool error: ${err.message}`;
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content });
    }
  }
  // Tool budget exhausted — force a final answer without offering more tools.
  return callOpenRouter({ apiKey, model, messages });
}

function createAiLabRouter(options) {
  const opts = options || {};
  const configPath = opts.configPath;
  const loaded = loadSupportConfig(configPath);
  if (!loaded.ok) {
    throw new Error(`Invalid support-assistant configuration: ${loaded.errors.join('; ')}`);
  }
  const config = loaded.config;

  const router = express.Router();
  router.use(applySecurityHeaders);

  router.get('/config', (req, res) => {
    res.json({
      name: config.name,
      version: config.version,
      description: config.description,
      language_policy: config.language_policy,
      persona: config.persona,
      policies: config.policies,
      examples: config.examples,
      verified_facts: config.verified_facts,
      limitations: config.limitations,
      model: opts.model || process.env.OPENROUTER_MODEL || DEFAULT_MODEL,
      configured: Boolean(opts.apiKey || process.env.OPENROUTER_API_KEY),
      site_browsing: {
        enabled: true,
        pages: BROWSABLE_SITE_PATHS,
      },
    });
  });

  router.post('/chat', createRateLimiter(opts.rateLimit), async (req, res) => {
    const validationError = validateChatBody(req.body);
    if (validationError) {
      return res.status(400).json({ error: validationError, code: 'VALIDATION_ERROR' });
    }

    const apiKey = opts.apiKey || process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return res.status(503).json({
        error: 'The AI assistant is not configured on this server. Set the OPENROUTER_API_KEY environment variable to enable it.',
        code: 'NOT_CONFIGURED',
      });
    }

    const requestedModel = typeof req.body.model === 'string' && req.body.model.trim().length > 0
      ? req.body.model.trim()
      : null;
    const allowedModels = (opts.allowedModels && opts.allowedModels.length > 0)
      ? opts.allowedModels
      : [process.env.OPENROUTER_MODEL || DEFAULT_MODEL];
    const model = requestedModel && allowedModels.includes(requestedModel)
      ? requestedModel
      : allowedModels[0];

    const history = Array.isArray(req.body.history) ? req.body.history.slice(-MAX_HISTORY_MESSAGES) : [];

    // Optional page context (sent by the site-wide chat widget). Silently
    // ignored when missing or malformed; constrained to a safe path charset.
    const rawPage = typeof req.body.page === 'string' ? req.body.page.slice(0, 120) : '';
    const pageContext = /^\/[A-Za-z0-9\-._\/]*$/.test(rawPage) ? rawPage : '';

    let systemPrompt = buildSystemPrompt(config);
    if (pageContext) {
      systemPrompt += `\nThe visitor is currently viewing ${pageContext} on veltroncars.com. When they ask about "this page" or what they are looking at, answer about that page; you may call browse_veltron_site with its path for exact content.`;
    }
    const messages = [
      { role: 'system', content: systemPrompt },
      ...history.map((entry) => ({ role: entry.role, content: entry.content })),
      { role: 'user', content: req.body.message },
    ];

    try {
      let result;
      const messagesBeforeTools = messages.length;
      try {
        const browsedPages = [];
        result = await runChatWithTools({ apiKey, model, messages, browsedPages });
        result.browsedPages = browsedPages;
      } catch (err) {
        // Some auto-routed models may not support tool calling; degrade to a
        // plain completion when no tool round has completed yet.
        if (err.code === 'PROVIDER_ERROR' && messages.length === messagesBeforeTools) {
          result = await callOpenRouter({ apiKey, model, messages });
          result.browsedPages = [];
        } else {
          throw err;
        }
      }
      return res.json({
        reply: result.reply,
        model: result.model,
        usage: result.usage,
        config_version: config.version,
        browsed_pages: result.browsedPages,
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        return res.status(504).json({
          error: 'The model took too long to respond. Please try again.',
          code: 'TIMEOUT',
        });
      }
      const status = err.code === 'PROVIDER_ERROR' ? 502 : 500;
      return res.status(status).json({
        error: 'The AI service is temporarily unavailable. Please try again later.',
        code: 'PROVIDER_ERROR',
      });
    }
  });

  return router;
}

function createAiLabApp(options) {
  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }
    return next();
  });
  app.use('/api/ai-lab', createAiLabRouter(options));
  return app;
}

module.exports = {
  createAiLabApp,
  createAiLabRouter,
  buildSystemPrompt,
  validateChatBody,
  htmlToText,
  normalizeSitePath,
  DEFAULT_MODEL,
  MAX_MESSAGE_LENGTH,
  MAX_HISTORY_MESSAGES,
  MAX_OUTPUT_TOKENS,
  RATE_LIMIT_MAX_REQUESTS,
  RATE_LIMIT_WINDOW_MS,
  BROWSABLE_SITE_PATHS,
};
