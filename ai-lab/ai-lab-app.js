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

async function callOpenRouter({ apiKey, model, messages }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://veltroncars.com/ai-lab/',
        'X-Title': 'Veltron AI Lab',
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: MAX_OUTPUT_TOKENS,
      }),
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
    const content = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : null;
    if (typeof content !== 'string' || content.trim().length === 0) {
      const err = new Error('Provider returned an empty response.');
      err.code = 'PROVIDER_ERROR';
      throw err;
    }
    return {
      reply: content,
      model: typeof data.model === 'string' ? data.model : model,
      usage: data.usage || null,
    };
  } finally {
    clearTimeout(timeout);
  }
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
    const messages = [
      { role: 'system', content: buildSystemPrompt(config) },
      ...history.map((entry) => ({ role: entry.role, content: entry.content })),
      { role: 'user', content: req.body.message },
    ];

    try {
      const result = await callOpenRouter({ apiKey, model, messages });
      return res.json({
        reply: result.reply,
        model: result.model,
        usage: result.usage,
        config_version: config.version,
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
  DEFAULT_MODEL,
  MAX_MESSAGE_LENGTH,
  MAX_HISTORY_MESSAGES,
  MAX_OUTPUT_TOKENS,
  RATE_LIMIT_MAX_REQUESTS,
  RATE_LIMIT_WINDOW_MS,
};
