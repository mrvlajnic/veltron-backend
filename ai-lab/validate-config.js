'use strict';

const fs = require('fs');
const path = require('path');

const POLICY_IDS = ['truthfulness', 'uncertainty', 'escalation', 'scope', 'prompt-injection'];

function fail(errors, field, message) {
  errors.push(`${field}: ${message}`);
}

function validateSupportConfig(config) {
  const errors = [];

  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return ['root: configuration must be a JSON object'];
  }

  if (typeof config.name !== 'string' || config.name.trim().length === 0) {
    fail(errors, 'name', 'must be a non-empty string');
  }

  if (typeof config.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(config.version)) {
    fail(errors, 'version', 'must be a semantic version string (e.g. "1.0.0")');
  }

  if (typeof config.description !== 'string' || config.description.trim().length === 0) {
    fail(errors, 'description', 'must be a non-empty string');
  }

  if (typeof config.language_policy !== 'string' || config.language_policy.trim().length === 0) {
    fail(errors, 'language_policy', 'must be a non-empty string');
  }

  const persona = config.persona;
  if (persona === null || typeof persona !== 'object' || Array.isArray(persona)) {
    fail(errors, 'persona', 'must be an object');
  } else {
    if (typeof persona.role !== 'string' || persona.role.trim().length === 0) {
      fail(errors, 'persona.role', 'must be a non-empty string');
    }
    if (!Array.isArray(persona.tone) || persona.tone.length === 0 || !persona.tone.every(t => typeof t === 'string' && t.trim().length > 0)) {
      fail(errors, 'persona.tone', 'must be a non-empty array of non-empty strings');
    }
    if (typeof persona.verbosity !== 'string' || persona.verbosity.trim().length === 0) {
      fail(errors, 'persona.verbosity', 'must be a non-empty string');
    }
  }

  if (!Array.isArray(config.policies) || config.policies.length === 0) {
    fail(errors, 'policies', 'must be a non-empty array');
  } else {
    const seenIds = new Set();
    config.policies.forEach((policy, idx) => {
      const field = `policies[${idx}]`;
      if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) {
        fail(errors, field, 'must be an object');
        return;
      }
      if (typeof policy.id !== 'string' || policy.id.trim().length === 0) {
        fail(errors, `${field}.id`, 'must be a non-empty string');
      } else if (seenIds.has(policy.id)) {
        fail(errors, `${field}.id`, `duplicate policy id "${policy.id}"`);
      } else {
        seenIds.add(policy.id);
      }
      if (typeof policy.instruction !== 'string' || policy.instruction.trim().length < 10) {
        fail(errors, `${field}.instruction`, 'must be a string of at least 10 characters');
      }
    });
    for (const required of POLICY_IDS) {
      if (!seenIds.has(required)) {
        fail(errors, 'policies', `missing required policy id "${required}"`);
      }
    }
  }

  if (!Array.isArray(config.examples)) {
    fail(errors, 'examples', 'must be an array');
  } else {
    config.examples.forEach((example, idx) => {
      const field = `examples[${idx}]`;
      if (example === null || typeof example !== 'object' || Array.isArray(example)) {
        fail(errors, field, 'must be an object');
        return;
      }
      if (typeof example.id !== 'string' || example.id.trim().length === 0) {
        fail(errors, `${field}.id`, 'must be a non-empty string');
      }
      if (typeof example.user !== 'string' || example.user.trim().length === 0) {
        fail(errors, `${field}.user`, 'must be a non-empty string');
      }
      if (typeof example.assistant !== 'string' || example.assistant.trim().length === 0) {
        fail(errors, `${field}.assistant`, 'must be a non-empty string');
      }
    });
  }

  if (!Array.isArray(config.verified_facts)) {
    fail(errors, 'verified_facts', 'must be an array');
  } else {
    config.verified_facts.forEach((fact, idx) => {
      const field = `verified_facts[${idx}]`;
      if (fact === null || typeof fact !== 'object' || Array.isArray(fact)) {
        fail(errors, field, 'must be an object');
        return;
      }
      if (typeof fact.fact !== 'string' || fact.fact.trim().length === 0) {
        fail(errors, `${field}.fact`, 'must be a non-empty string');
      }
      if (typeof fact.source !== 'string' || fact.source.trim().length === 0) {
        fail(errors, `${field}.source`, 'must be a non-empty string');
      }
    });
  }

  if (!Array.isArray(config.limitations) || config.limitations.length === 0) {
    fail(errors, 'limitations', 'must be a non-empty array of strings');
  } else if (!config.limitations.every(l => typeof l === 'string' && l.trim().length > 0)) {
    fail(errors, 'limitations', 'every entry must be a non-empty string');
  }

  return errors;
}

function loadSupportConfig(configPath) {
  const resolved = configPath || path.join(__dirname, '..', 'config', 'support-assistant.json');
  let raw;
  try {
    raw = fs.readFileSync(resolved, 'utf8');
  } catch (err) {
    return { ok: false, errors: [`Failed to read configuration file: ${err.message}`], config: null };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, errors: [`Invalid JSON: ${err.message}`], config: null };
  }

  const errors = validateSupportConfig(parsed);
  if (errors.length > 0) {
    return { ok: false, errors, config: null };
  }
  return { ok: true, errors: [], config: parsed };
}

module.exports = { validateSupportConfig, loadSupportConfig, POLICY_IDS };
