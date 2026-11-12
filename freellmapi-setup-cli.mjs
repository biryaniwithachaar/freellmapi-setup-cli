#!/usr/bin/env node
/**
 * FreeLLMAPI Cross-Platform Provider, Catalog Classifier & Intelligent Chain Manager
 * Works on Windows, macOS, and Linux (Node.js >= 20.18).
 *
 * Features:
 *   1. Scrapes live provider & model catalog from https://api.freellmapi.co/v1/latest
 *      (+ https://freellmapi.co/models fallback) and saves structured JSON to
 *      scripts/catalog-providers.json grouped by provider & LLM.
 *   2. Classifies every provider & model by quota style (keyless, token/day, token/mo,
 *      credit wallet, strict RPM/RPD), context tier, parameter/capability tier, & quirks.
 *   3. On startup AND after adding any provider, inspects local chains in freeapi.db
 *      (architect, coder, workers), reports missing models or missing chains, and
 *      builds provider-diversified fallback chains so no single provider is exhausted.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolvePaths() {
  const argv = process.argv.slice(2);
  const dbFlagIdx = argv.indexOf('--db');
  const explicitDb = dbFlagIdx !== -1 ? argv[dbFlagIdx + 1] : process.env.FREELLMAPI_DB;

  const candidateRoots = [
    process.cwd(),
    path.resolve(__dirname, '..'),
    __dirname,
  ];

  let repoRoot = candidateRoots.find((r) => fs.existsSync(path.join(r, 'server', 'data', 'freeapi.db')))
    || candidateRoots.find((r) => fs.existsSync(path.join(r, 'server', 'package.json')))
    || path.resolve(__dirname, '..');

  const dbPath = explicitDb
    ? path.resolve(explicitDb)
    : path.join(repoRoot, 'server', 'data', 'freeapi.db');

  if (explicitDb && !fs.existsSync(path.join(repoRoot, 'server', 'package.json'))) {
    const guessedRoot = path.resolve(path.dirname(dbPath), '..', '..');
    if (fs.existsSync(path.join(guessedRoot, 'server', 'package.json'))) {
      repoRoot = guessedRoot;
    }
  }

  return {
    ROOT: repoRoot,
    DB_PATH: dbPath,
    CATALOG_OUT_PATH: path.join(__dirname, 'catalog-providers.json'),
    KEYS_SHARED_TSX: path.join(repoRoot, 'client', 'src', 'components', 'keys', 'shared.tsx'),
  };
}

const { ROOT, DB_PATH, CATALOG_OUT_PATH, KEYS_SHARED_TSX } = resolvePaths();
const require = createRequire(path.join(ROOT, 'package.json'));
const Database = require('better-sqlite3');

const LATEST_API_URL = 'https://api.freellmapi.co/v1/latest';
const SITE_DATA_URL = 'https://freellmapi.co/assets/data.js';
const MODELS_PAGE_URL = 'https://freellmapi.co/models';

// ── ANSI Terminal UI Helpers ──────────────────────────────────────────────────
const USE_COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  reset: USE_COLOR ? '\x1b[0m' : '',
  bold: USE_COLOR ? '\x1b[1m' : '',
  dim: USE_COLOR ? '\x1b[2m' : '',
  cyan: USE_COLOR ? '\x1b[36m' : '',
  brightCyan: USE_COLOR ? '\x1b[96m' : '',
  green: USE_COLOR ? '\x1b[32m' : '',
  brightGreen: USE_COLOR ? '\x1b[92m' : '',
  yellow: USE_COLOR ? '\x1b[33m' : '',
  magenta: USE_COLOR ? '\x1b[35m' : '',
  red: USE_COLOR ? '\x1b[31m' : '',
  blue: USE_COLOR ? '\x1b[34m' : '',
  gray: USE_COLOR ? '\x1b[90m' : '',
  white: USE_COLOR ? '\x1b[97m' : '',
};

const paint = (color, text) => `${color}${text}${c.reset}`;

function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '');
}

function padRight(str, width) {
  const len = stripAnsi(str).length;
  return len >= width ? str : str + ' '.repeat(width - len);
}

function termWidth() {
  return Math.min(Math.max(process.stdout.columns || 92, 72), 112);
}

function drawBox(title, lines = [], borderColor = c.cyan) {
  const w = termWidth();
  const inner = w - 4;
  const top = `${borderColor}╭─ ${c.bold}${c.white}${title}${c.reset}${borderColor} ${'─'.repeat(Math.max(0, w - stripAnsi(title).length - 6))}╮${c.reset}`;
  console.log(top);
  for (const line of lines) {
    const rawLen = stripAnsi(line).length;
    const clipped = rawLen > inner ? line.slice(0, inner + (line.length - rawLen)) : line;
    console.log(`${borderColor}│${c.reset} ${padRight(clipped, inner)} ${borderColor}│${c.reset}`);
  }
  console.log(`${borderColor}╰${'─'.repeat(w - 2)}╯${c.reset}`);
}

function drawRule(label = '') {
  const w = termWidth();
  if (!label) {
    console.log(paint(c.gray, '─'.repeat(w)));
    return;
  }
  const rest = Math.max(2, w - stripAnsi(label).length - 5);
  console.log(`${c.gray}── ${c.reset}${label} ${c.gray}${'─'.repeat(rest)}${c.reset}`);
}

function formatCtx(tokens) {
  if (!tokens || tokens <= 0) return 'unknown';
  if (tokens >= 1_000_000) return `${(tokens / 1_048_576 >= 0.95 ? (tokens / 1_048_576).toFixed(1).replace(/\.0$/, '') : (tokens / 1_000_000).toFixed(1))}M`;
  return `${Math.round(tokens / 1024)}K`;
}

function openBrowser(url) {
  if (!url) return;
  const plat = process.platform;
  try {
    if (plat === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (plat === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    // Non-fatal; URL is always printed in terminal
  }
}

function createPrompter() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const queue = [];
  const waiters = [];
  let closed = false;

  rl.on('line', (line) => {
    if (waiters.length > 0) {
      waiters.shift()(line);
    } else {
      queue.push(line);
    }
  });
  rl.on('close', () => {
    closed = true;
    while (waiters.length > 0) {
      waiters.shift()(null);
    }
  });

  return {
    question(prompt) {
      process.stdout.write(prompt);
      if (queue.length > 0) {
        const next = queue.shift();
        if (!process.stdin.isTTY) process.stdout.write(`${next}\n`);
        return Promise.resolve(next);
      }
      if (closed) return Promise.resolve('q');
      return new Promise((resolve) => waiters.push((v) => resolve(v ?? 'q')));
    },
    close() {
      rl.close();
    },
  };
}

// ── Provider Metadata & Quota Classification Knowledge ────────────────────────
const PROVIDER_QUOTA_PROFILES = {
  // Keyless / Instant Anonymous
  kilo:           { quotaTier: 'keyless_instant',     quotaLabel: 'Keyless / Free pool',          chainCap: 3, priorityBoost: 14, keyFormat: 'Optional (leave blank for anon)' },
  ovh:            { quotaTier: 'keyless_instant',     quotaLabel: 'Keyless · 2 RPM/IP',           chainCap: 2, priorityBoost: 12, keyFormat: 'Optional (leave blank for anon)' },
  llm7:           { quotaTier: 'keyless_instant',     quotaLabel: 'Keyless / Anon fair-use',      chainCap: 2, priorityBoost: 10, keyFormat: 'Optional (leave blank for anon)' },
  aihorde:        { quotaTier: 'keyless_slow',        quotaLabel: 'Keyless · Community queue',    chainCap: 1, priorityBoost: -12, keyFormat: 'Optional (0000000000 anon)' },

  // Generous Daily / Monthly Token & High-RPM Pools
  nvidia:         { quotaTier: 'high_quota',          quotaLabel: '40 RPM · Recurring eval tier', chainCap: 4, priorityBoost: 18, keyFormat: 'nvapi-...' },
  cerebras:       { quotaTier: 'high_quota',          quotaLabel: '1M TPD · Ultra-fast',          chainCap: 3, priorityBoost: 18, keyFormat: 'csk-...' },
  groq:           { quotaTier: 'high_quota',          quotaLabel: '1K-14.4K RPD · Ultra-fast',    chainCap: 3, priorityBoost: 16, keyFormat: 'gsk_...' },
  mistral:        { quotaTier: 'high_quota',          quotaLabel: '~50-100M/mo · 500K TPM',       chainCap: 3, priorityBoost: 16, keyFormat: 'Standard API key' },
  cloudflare:     { quotaTier: 'high_quota',          quotaLabel: '10K neurons/day (~18-45M/mo)', chainCap: 3, priorityBoost: 15, keyFormat: 'account_id:token' },
  google:         { quotaTier: 'high_quota',          quotaLabel: '10-15 RPM · 250K TPM',         chainCap: 3, priorityBoost: 17, keyFormat: 'AIza...' },
  ollama:         { quotaTier: 'high_quota',          quotaLabel: '~5-10M/mo · 5h session cap',   chainCap: 2, priorityBoost: 12, keyFormat: 'Standard API key' },
  xkiro:          { quotaTier: 'high_quota',          quotaLabel: '1M-5M free tokens/day',        chainCap: 3, priorityBoost: 13, keyFormat: 'ClientApiKey' },
  nara:           { quotaTier: 'high_quota',          quotaLabel: '7M tokens/day · 10 RPM',       chainCap: 2, priorityBoost: 12, keyFormat: 'Standard API key' },
  iteracompute:   { quotaTier: 'high_quota',          quotaLabel: '30M free tokens/mo shared',    chainCap: 2, priorityBoost: 12, keyFormat: 'Standard API key' },
  dreamprompting: { quotaTier: 'high_quota',          quotaLabel: '500K TPD / 5K RPD (public log!)', chainCap: 2, priorityBoost: 8, keyFormat: 'Standard API key' },
  radeon:         { quotaTier: 'high_quota',          quotaLabel: 'Recurring daily allowance',    chainCap: 2, priorityBoost: 11, keyFormat: 'Standard API key' },
  cohere:         { quotaTier: 'moderate_quota',      quotaLabel: '20 RPM · 1K calls/mo trial',   chainCap: 2, priorityBoost: 9,  keyFormat: 'Trial API key' },
  sealion:        { quotaTier: 'moderate_quota',      quotaLabel: '10 RPM · Recurring free',      chainCap: 1, priorityBoost: 6,  keyFormat: 'Standard API key' },
  agnes:          { quotaTier: 'moderate_quota',      quotaLabel: 'Promo $0/token · ~30 conc.',   chainCap: 2, priorityBoost: 8,  keyFormat: 'Standard API key' },
  simplellm:      { quotaTier: 'moderate_quota',      quotaLabel: '100/hr · 1K RPD · 500K TPD',   chainCap: 2, priorityBoost: 8,  keyFormat: 'Standard API key' },
  zhipu:          { quotaTier: 'moderate_quota',      quotaLabel: 'Free GLM-Flash tier',          chainCap: 2, priorityBoost: 9,  keyFormat: 'Standard API key' },
  huggingface:    { quotaTier: 'moderate_quota',      quotaLabel: 'Monthly free inference',       chainCap: 2, priorityBoost: 7,  keyFormat: 'hf_...' },
  pollinations:   { quotaTier: 'moderate_quota',      quotaLabel: 'Free community pool',          chainCap: 2, priorityBoost: 6,  keyFormat: 'Standard API key' },

  // Shared Credit Wallets (conserve in chains — put lower as fallback)
  electronhub:    { quotaTier: 'credit_wallet',       quotaLabel: '$0.25/wk shared wallet',       chainCap: 2, priorityBoost: 4,  keyFormat: 'Standard API key' },
  router9:        { quotaTier: 'credit_wallet',       quotaLabel: '~$1/mo shared credits',        chainCap: 2, priorityBoost: 3,  keyFormat: 'Standard API key' },
  speka:          { quotaTier: 'credit_wallet',       quotaLabel: '$1/mo shared credits',         chainCap: 1, priorityBoost: 2,  keyFormat: 'Standard API key' },
  moondream:      { quotaTier: 'credit_wallet',       quotaLabel: '$5/mo vision credits',         chainCap: 1, priorityBoost: 2,  keyFormat: 'Standard API key' },
  experiential:   { quotaTier: 'credit_wallet',       quotaLabel: 'Shared monthly credits',       chainCap: 1, priorityBoost: 2,  keyFormat: 'Standard API key' },
  nabh:           { quotaTier: 'credit_wallet',       quotaLabel: '50 shared monthly credits',    chainCap: 1, priorityBoost: 1,  keyFormat: 'Standard API key' },

  // Strict Shared Daily / RPM Caps (use sparingly as late fallbacks)
  openrouter:     { quotaTier: 'strict_cap',          quotaLabel: '50 RPD shared (:free pool)',   chainCap: 2, priorityBoost: 2,  keyFormat: 'sk-or-v1-...' },
  requesty:       { quotaTier: 'strict_cap',          quotaLabel: '200 RPD free routes',          chainCap: 1, priorityBoost: 2,  keyFormat: 'Standard API key' },
  routeway:       { quotaTier: 'strict_cap',          quotaLabel: '5 RPM · 200 RPD (:free)',      chainCap: 1, priorityBoost: 2,  keyFormat: 'Standard API key' },
  septor:         { quotaTier: 'strict_cap',          quotaLabel: '50 RPD · 500K TPD shared',     chainCap: 1, priorityBoost: 1,  keyFormat: 'Standard API key' },
  clod:           { quotaTier: 'strict_cap',          quotaLabel: '100 RPD shared',               chainCap: 1, priorityBoost: 1,  keyFormat: 'Standard API key' },
  airforce:       { quotaTier: 'strict_cap',          quotaLabel: '1 RPM · 1,000 RPD',            chainCap: 1, priorityBoost: 0,  keyFormat: 'Standard API key' },
  unorouter:      { quotaTier: 'strict_cap',          quotaLabel: '1 RPM (429 on bursts)',        chainCap: 1, priorityBoost: -1, keyFormat: 'Standard API key' },
  bazaarlink:     { quotaTier: 'strict_cap',          quotaLabel: '10 RPM · 50 RPD shared',       chainCap: 1, priorityBoost: 0,  keyFormat: 'Standard API key' },
  blaze:          { quotaTier: 'strict_cap',          quotaLabel: '200K TPD shared',              chainCap: 1, priorityBoost: 0,  keyFormat: 'Standard API key' },
  gizmo:          { quotaTier: 'strict_cap',          quotaLabel: '1K/mo · No tools/vision',      chainCap: 1, priorityBoost: -4, keyFormat: 'Standard API key' },
  inferbase:      { quotaTier: 'strict_cap',          quotaLabel: '100 RPD · 8K in / 1K out cap', chainCap: 0, priorityBoost: -8, keyFormat: 'Standard API key' },
  aion:           { quotaTier: 'strict_cap',          quotaLabel: '20K TPD (very small)',         chainCap: 0, priorityBoost: -8, keyFormat: 'Standard API key' },
  modelscope:     { quotaTier: 'cn_verified',         quotaLabel: '~125 RPD (needs CN real-name)', chainCap: 1, priorityBoost: -3, keyFormat: 'Access Token' },
  qianfan:        { quotaTier: 'cn_verified',         quotaLabel: 'Needs CN real-name',           chainCap: 1, priorityBoost: -5, keyFormat: 'Access Token' },
  volcengine:     { quotaTier: 'cn_verified',         quotaLabel: 'Needs CN real-name',           chainCap: 1, priorityBoost: -5, keyFormat: 'Access Token' },
  xfyun:          { quotaTier: 'cn_verified',         quotaLabel: 'Needs CN real-name',           chainCap: 1, priorityBoost: -5, keyFormat: 'Access Token' },
};

const QUOTA_TIER_META = {
  keyless_instant: { rank: 1, badge: 'KEYLESS',       color: c.brightGreen, desc: 'No card or signup needed — instant activation' },
  high_quota:      { rank: 2, badge: 'HIGH QUOTA',    color: c.green,       desc: 'Generous daily/monthly tokens or high RPM' },
  moderate_quota:  { rank: 3, badge: 'MODERATE',      color: c.cyan,        desc: 'Solid recurring free or trial quotas' },
  credit_wallet:   { rank: 4, badge: 'CREDIT WALLET', color: c.yellow,      desc: 'Shared $/credit pool — placed lower as fallback' },
  strict_cap:      { rank: 5, badge: 'STRICT CAP',    color: c.magenta,     desc: 'Low RPM/RPD shared caps — conserved for fallback' },
  keyless_slow:    { rank: 6, badge: 'SLOW QUEUE',    color: c.gray,        desc: 'Community queue / high latency' },
  cn_verified:     { rank: 7, badge: 'CN VERIFY',     color: c.red,         desc: 'Requires Chinese real-name verification' },
};

// ── Budget & Model Classification ─────────────────────────────────────────────
function parseBudgetTokens(s) {
  if (!s) return 0;
  const label = String(s).toLowerCase();
  if (label.includes('unlimited') || label.includes('∞')) return 1e12;
  const head = label.replace(/\([^)]*\)/g, '').trim();
  const m = head.match(/~?([\d.]+)(?:-([\d.]+))?([mk])(?![a-z])/);
  if (!m) return 0;
  const high = parseFloat(m[2] ?? m[1]);
  if (Number.isNaN(high)) return 0;
  const tail = head.slice((m.index ?? 0) + m[0].length);
  if (/^\s*(?:rpd|rpm|rph|rps|req|requests?|calls?|messages?|prompts?|neurons?)\b/.test(tail)) return 0;
  const tokens = high * (m[3] === 'm' ? 1_000_000 : 1_000);
  const period = tail.split(/[,·;]/)[0];
  const perDay = /\b(?:per\s*)?days?\b|\bdaily\b|\b24\s*h(?:rs?|ours?)?\b/.test(period);
  return perDay ? tokens * 30 : tokens;
}

function estimateParamTier(modelId, sizeLabel) {
  const s = `${modelId} ${sizeLabel || ''}`.toLowerCase();
  if (sizeLabel === 'Frontier' || /(?:671b|550b|480b|405b|397b|235b|120b|glm-5|deepseek-v4|gemini-3|command-a|qwen3\.8-max|qwen3\.8-plus)/.test(s)) {
    return 'frontier_large';
  }
  if (sizeLabel === 'Large' || /(?:70b|72b|100b|110b|codestral|mistral-large|devstral|qwen3-coder)/.test(s)) {
    return 'large';
  }
  if (sizeLabel === 'Medium' || /(?:27b|30b|31b|32b|26b|22b|20b|14b|flash|mini|lite)/.test(s)) {
    return 'medium_fast';
  }
  return 'small_utility';
}

function contextTier(ctx) {
  if (!ctx || ctx <= 0) return 'unknown';
  if (ctx >= 900_000) return '1m+';
  if (ctx >= 250_000) return '256k-512k';
  if (ctx >= 120_000) return '128k';
  return '<128k';
}

function canonicalModelKey(modelId) {
  let k = String(modelId || '').toLowerCase();
  // Strip provider prefixes like "nvidia/", "@cf/openai/", "free/", ":free", ":fp8"
  k = k.replace(/^@cf\/[^/]+\//, '');
  if (k.includes('/')) k = k.split('/').pop();
  k = k.replace(/:free$|:fp8$|:exacto$|-free$/g, '');
  k = k.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return k;
}

function isClutterOrPeanutModel(model, platformId) {
  const id = String(model.modelId ?? model.model_id ?? '').toLowerCase();
  const name = String(model.displayName ?? model.display_name ?? '').toLowerCase();
  const combined = `${id} ${name}`;
  const ctx = model.contextWindow ?? model.context_window ?? 0;

  // 1. Safety / guard / moderation / non-LLM / media / embedding clutter
  if (/(?:prompt[-_ ]?guard|llama[-_ ]?guard|qwen\d*guard|safeguard|shieldgemma|moderation|melotts|whisper|flux[-_ ]?\d|rerank|embed|bge-|e5-)/.test(combined)) {
    return true;
  }
  // 2. Tiny peanut parameter models (<7B), carefully ignoring MoE suffixes like -a3b / -a4b or 31b/32b
  if (/(?<![0-9a-z-])(?:0\.5|0\.6|1|1\.5|2|2\.6|3|4)b(?![0-9a-z])/.test(combined)) {
    return true;
  }
  // 3. Zero-context or tiny-context (<32K) or known unusable free routes
  if (ctx > 0 && ctx < 32_768) return true;
  if (ctx === 0 && /tts|image|flux|audio|speech/.test(combined)) return true;
  if (id.includes('dots-3-note') || id.includes('dots3-note') || platformId === 'inferbase' || platformId === 'aion') {
    return true;
  }
  return false;
}

function classifyModel(model, platformId) {
  const ctx = model.contextWindow ?? model.context_window ?? 0;
  const intel = model.intelligenceRank ?? model.intelligence_rank ?? 150;
  const speed = model.speedRank ?? model.speed_rank ?? 50;
  const tools = Boolean(model.supportsTools ?? model.supports_tools);
  const vision = Boolean(model.supportsVision ?? model.supports_vision);
  const budgetStr = model.monthlyTokenBudget ?? model.monthly_token_budget ?? '';
  const budgetTokens = parseBudgetTokens(budgetStr);
  const paramTier = estimateParamTier(model.modelId ?? model.model_id, model.sizeLabel ?? model.size_label);
  const ctxTier = contextTier(ctx);
  const pInfo = PROVIDER_QUOTA_PROFILES[platformId] || { quotaTier: 'moderate_quota', quotaLabel: 'Free / fair-use', chainCap: 2, priorityBoost: 5 };

  const idLow = String(model.modelId ?? model.model_id ?? '').toLowerCase();
  const isClutter = isClutterOrPeanutModel(model, platformId);

  const bestFor = [];
  if (!isClutter && tools && ctx >= 131_072 && (paramTier === 'frontier_large' || paramTier === 'large' || intel <= 80)) {
    bestFor.push('frontier-heavy');
  }
  if (!isClutter && tools && ctx >= 131_072 && intel <= 125) {
    bestFor.push('balanced-daily');
  }
  if (!isClutter && ctx >= 65_536 && speed <= 35) {
    bestFor.push('fast-pool');
  }

  return {
    canonicalKey: canonicalModelKey(model.modelId ?? model.model_id),
    contextTier: ctxTier,
    paramTier,
    quotaTier: pInfo.quotaTier,
    estimatedMonthlyTokens: budgetTokens,
    supportsTools: tools,
    supportsVision: vision,
    isClutter,
    bestFor,
    scoreFrontier:
      (200 - Math.min(intel, 200)) * 2.0 +
      (ctx >= 900_000 ? 28 : ctx >= 250_000 ? 16 : ctx >= 131_072 ? 8 : -50) +
      (paramTier === 'frontier_large' ? 24 : paramTier === 'large' ? 12 : 0) +
      pInfo.priorityBoost,
    scoreBalanced:
      (200 - Math.min(intel, 200)) * 1.6 +
      (ctx >= 250_000 ? 14 : ctx >= 131_072 ? 8 : -40) +
      pInfo.priorityBoost,
    scoreFast:
      (100 - Math.min(speed, 100)) * 1.8 +
      (200 - Math.min(intel, 200)) * 0.7 +
      (tools ? 15 : 0) +
      pInfo.priorityBoost,
  };
}

// ── Read Repo Metadata (keys/shared.tsx) & Scrape Live Catalog ────────────────
function loadLocalPlatformDirectory() {
  const map = new Map();
  if (!fs.existsSync(KEYS_SHARED_TSX)) return map;
  const src = fs.readFileSync(KEYS_SHARED_TSX, 'utf8');
  const re = /\{\s*value:\s*'([^']+)'\s*,\s*label:\s*'([^']+)'\s*,\s*url:\s*'([^']*)'([^}]*)\}/g;
  for (const m of src.matchAll(re)) {
    const [, value, label, url, tail] = m;
    map.set(value, {
      id: value,
      label,
      url,
      keyless: /keyless:\s*true/.test(tail),
      hidden: /hidden:\s*true/.test(tail),
    });
  }
  return map;
}

async function scrapeLiveCatalog() {
  const localDir = loadLocalPlatformDirectory();
  let raw = null;
  let source = LATEST_API_URL;

  try {
    const res = await fetch(LATEST_API_URL, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    raw = await res.json();
  } catch (err) {
    // Fallback to freellmapi.co/assets/data.js (the script backing freellmapi.co/models)
    try {
      source = SITE_DATA_URL;
      const res = await fetch(SITE_DATA_URL, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const txt = await res.text();
      const jsonPart = txt.replace(/^window\.CATALOG_SNAPSHOT\s*=\s*/, '').replace(/;\s*$/, '');
      raw = JSON.parse(jsonPart);
    } catch (fallbackErr) {
      if (fs.existsSync(CATALOG_OUT_PATH)) {
        const cached = JSON.parse(fs.readFileSync(CATALOG_OUT_PATH, 'utf8'));
        return { catalog: cached, fromCache: true, error: fallbackErr.message };
      }
      throw new Error(`Failed to scrape ${LATEST_API_URL} (${err.message}) and ${SITE_DATA_URL} (${fallbackErr.message})`);
    }
  }

  // Group all chat models & auxiliary models by provider
  const byProvider = new Map();

  for (const p of raw.platforms || []) {
    const local = localDir.get(p.id);
    const qInfo = PROVIDER_QUOTA_PROFILES[p.id] || {
      quotaTier: local?.keyless ? 'keyless_instant' : 'moderate_quota',
      quotaLabel: local?.label || 'Free tier',
      chainCap: 2,
      priorityBoost: 5,
      keyFormat: 'Standard API key',
    };
    const tierMeta = QUOTA_TIER_META[qInfo.quotaTier] || QUOTA_TIER_META.moderate_quota;

    byProvider.set(p.id, {
      id: p.id,
      name: p.name,
      portalUrl: local?.url || `${MODELS_PAGE_URL}?provider=${p.id}`,
      catalogUrl: `${MODELS_PAGE_URL}?provider=${p.id}`,
      keyless: Boolean(local?.keyless),
      hidden: Boolean(local?.hidden),
      keyFormat: qInfo.keyFormat || 'Standard API key',
      classification: {
        quotaTier: qInfo.quotaTier,
        quotaBadge: tierMeta.badge,
        quotaSummary: qInfo.quotaLabel,
        tierRank: tierMeta.rank,
        recommendedChainCap: qInfo.chainCap,
      },
      stats: {
        totalChatModels: 0,
        toolsCapable: 0,
        visionCapable: 0,
        ctx128kPlus: 0,
        ctx1mPlus: 0,
        maxContextWindow: 0,
        embeddings: 0,
        transcription: 0,
        search: 0,
      },
      models: [],
    });
  }

  const ensureProvider = (platformId) => {
    if (!byProvider.has(platformId)) {
      const local = localDir.get(platformId);
      const qInfo = PROVIDER_QUOTA_PROFILES[platformId] || {
        quotaTier: 'moderate_quota',
        quotaLabel: local?.label || 'Free tier',
        chainCap: 2,
        priorityBoost: 5,
        keyFormat: 'Standard API key',
      };
      const tierMeta = QUOTA_TIER_META[qInfo.quotaTier];
      byProvider.set(platformId, {
        id: platformId,
        name: local?.label || platformId,
        portalUrl: local?.url || `${MODELS_PAGE_URL}?provider=${platformId}`,
        catalogUrl: `${MODELS_PAGE_URL}?provider=${platformId}`,
        keyless: Boolean(local?.keyless),
        hidden: Boolean(local?.hidden),
        keyFormat: qInfo.keyFormat || 'Standard API key',
        classification: {
          quotaTier: qInfo.quotaTier,
          quotaBadge: tierMeta.badge,
          quotaSummary: qInfo.quotaLabel,
          tierRank: tierMeta.rank,
          recommendedChainCap: qInfo.chainCap,
        },
        stats: {
          totalChatModels: 0,
          toolsCapable: 0,
          visionCapable: 0,
          ctx128kPlus: 0,
          ctx1mPlus: 0,
          maxContextWindow: 0,
          embeddings: 0,
          transcription: 0,
          search: 0,
        },
        models: [],
      });
    }
    return byProvider.get(platformId);
  };

  for (const m of raw.models || []) {
    if (m.enabled === false) continue;
    const prov = ensureProvider(m.platform);
    const cls = classifyModel(m, m.platform);
    const ctx = m.contextWindow ?? 0;

    prov.stats.totalChatModels++;
    if (cls.supportsTools) prov.stats.toolsCapable++;
    if (cls.supportsVision) prov.stats.visionCapable++;
    if (ctx >= 131_072) prov.stats.ctx128kPlus++;
    if (ctx >= 900_000) prov.stats.ctx1mPlus++;
    if (ctx > prov.stats.maxContextWindow) prov.stats.maxContextWindow = ctx;

    prov.models.push({
      modelId: m.modelId,
      displayName: m.displayName,
      sizeLabel: m.sizeLabel || 'Unknown',
      contextWindow: ctx,
      intelligenceRank: m.intelligenceRank ?? 999,
      speedRank: m.speedRank ?? 999,
      supportsTools: cls.supportsTools,
      supportsVision: cls.supportsVision,
      limits: m.limits || { rpm: null, rpd: null, tpm: null, tpd: null },
      monthlyTokenBudget: m.monthlyTokenBudget || '',
      quirks: (m.quirks || []).map((q) => (typeof q === 'string' ? q : q.message || q.title || '')).filter(Boolean),
      classification: cls,
    });
  }

  for (const e of raw.embeddings || []) ensureProvider(e.platform).stats.embeddings++;
  for (const t of raw.transcriptionModels || []) ensureProvider(t.platform).stats.transcription++;
  for (const s of raw.searchEngines || []) ensureProvider(s.platform).stats.search++;

  // Sort each provider's models by intelligence, then sort providers by tierRank & chat model count
  const providers = [...byProvider.values()].map((p) => {
    p.models.sort((a, b) => a.intelligenceRank - b.intelligenceRank);
    return p;
  });
  providers.sort((a, b) => {
    if (a.classification.tierRank !== b.classification.tierRank) {
      return a.classification.tierRank - b.classification.tierRank;
    }
    return b.stats.totalChatModels - a.stats.totalChatModels;
  });

  const structured = {
    scrapedAt: new Date().toISOString(),
    source,
    catalogVersion: raw.version || 'unknown',
    catalogGeneratedAt: raw.generatedAt || null,
    counts: raw.counts || {},
    providers,
  };

  fs.writeFileSync(CATALOG_OUT_PATH, JSON.stringify(structured, null, 2), 'utf8');
  return { catalog: structured, fromCache: false };
}

// ── Database & Server Helpers ─────────────────────────────────────────────────
function openDb() {
  if (!fs.existsSync(DB_PATH)) {
    throw new Error(`Database not found at ${DB_PATH}`);
  }
  return new Database(DB_PATH);
}

function getConfiguredPlatforms(db) {
  const rows = db.prepare(`SELECT DISTINCT platform FROM api_keys WHERE enabled = 1`).all();
  return new Set(rows.map((r) => r.platform));
}

function syncProviderModelsToDb(db, providerEntry) {
  if (!providerEntry || !providerEntry.models.length) return 0;
  const existing = new Set(
    db.prepare(`SELECT model_id FROM models WHERE platform = ?`).all(providerEntry.id).map((r) => r.model_id)
  );
  const insert = db.prepare(`
    INSERT INTO models (
      platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
      rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget,
      context_window, enabled, supports_vision, supports_tools, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'catalog')
  `);

  let added = 0;
  const tx = db.transaction(() => {
    for (const m of providerEntry.models) {
      if (existing.has(m.modelId)) continue;
      insert.run(
        providerEntry.id,
        m.modelId,
        m.displayName,
        m.intelligenceRank === 999 ? null : m.intelligenceRank,
        m.speedRank === 999 ? null : m.speedRank,
        m.sizeLabel || null,
        m.limits?.rpm ?? null,
        m.limits?.rpd ?? null,
        m.limits?.tpm ?? null,
        m.limits?.tpd ?? null,
        m.monthlyTokenBudget || null,
        m.contextWindow || null,
        m.supportsVision ? 1 : 0,
        m.supportsTools ? 1 : 0
      );
      added++;
    }
  });
  tx();
  return added;
}

async function saveProviderKeyInteractive(db, rl, providerEntry) {
  const cryptoFile = path.join(ROOT, 'server', 'dist', 'lib', 'crypto.js');
  const providersFile = path.join(ROOT, 'server', 'dist', 'providers', 'index.js');
  if (!fs.existsSync(cryptoFile) || !fs.existsSync(providersFile)) {
    throw new Error(`Missing built server modules in ${path.join(ROOT, 'server', 'dist')}. Run "npm run build:server" first.`);
  }
  const cryptoMod = await import(pathToFileURL(cryptoFile).href);
  const providersMod = await import(pathToFileURL(providersFile).href);

  const providerImpl = providersMod.resolveProvider(providerEntry.id);
  const isKeyless = providerImpl?.keyless === true || providerEntry.keyless;

  let rawKey = '';
  if (isKeyless) {
    const ans = (await rl.question(`  ${c.cyan}Paste optional API key or press Enter to activate anonymously:${c.reset} `)).trim();
    rawKey = ans || 'no-key';
  } else if (providerEntry.id === 'cloudflare') {
    console.log(paint(c.gray, '  (Cloudflare requires "account_id:token". Paste combined string or Account ID first.)'));
    const part1 = (await rl.question(`  ${c.cyan}Account ID or account_id:token (Enter to skip):${c.reset} `)).trim();
    if (!part1) return { skipped: true };
    if (part1.includes(':')) {
      rawKey = part1;
    } else {
      const part2 = (await rl.question(`  ${c.cyan}Workers AI API Token:${c.reset} `)).trim();
      if (!part2) return { skipped: true };
      rawKey = `${part1}:${part2}`;
    }
  } else {
    rawKey = (await rl.question(`  ${c.cyan}Paste ${providerEntry.name} key (${providerEntry.keyFormat}) [Enter to skip]:${c.reset} `)).trim();
    if (!rawKey) return { skipped: true };
  }

  let status = 'unknown';
  let validationError = null;
  if (providerImpl?.validateKey) {
    process.stdout.write(paint(c.gray, '  Validating key live... '));
    try {
      const res = await providerImpl.validateKey(rawKey);
      if (res === true) {
        status = 'healthy';
      } else if (res && typeof res === 'object' && res.valid === false) {
        status = 'invalid';
        validationError = res.error || 'Validation failed';
      }
    } catch (err) {
      status = 'unknown';
      validationError = err?.message || String(err);
    }
    console.log(status === 'healthy' ? paint(c.brightGreen, 'HEALTHY') : paint(c.yellow, status.toUpperCase()));
  }

  cryptoMod.initEncryptionKey(db);
  const { encrypted, iv, authTag } = cryptoMod.encrypt(rawKey);

  const info = db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, last_checked_at, last_health_error)
    VALUES (?, '', ?, ?, ?, ?, 1, datetime('now'), ?)
  `).run(providerEntry.id, encrypted, iv, authTag, status, validationError);

  const syncedModels = syncProviderModelsToDb(db, providerEntry);
  return {
    skipped: false,
    keyId: Number(info.lastInsertRowid),
    status,
    error: validationError,
    syncedModels,
  };
}

// ── Intelligent Data-Driven & Budget-Balanced Chain Builder ───────────────────
const CHAIN_DEFINITIONS = [
  {
    name: 'frontier-heavy',
    emoji: '🏆',
    color: '#8b5cf6',
    autoSort: 'intelligence',
    targetSize: 28,
    description: '128K-1M Frontier/Large models (1 per unique model, big-budget providers first, zero clutter)',
  },
  {
    name: 'balanced-daily',
    emoji: '⚖️',
    color: '#3b82f6',
    autoSort: 'intelligence',
    targetSize: 36,
    description: '128K+ tool-capable models distributed across providers so no single budget drains',
  },
  {
    name: 'fast-pool',
    emoji: '⚡',
    color: '#10b981',
    autoSort: 'speed',
    targetSize: 30,
    description: 'Fast >=64K models across high-RPM providers (excludes guard/TTS/<7B peanut clutter)',
  },
];

/**
 * Allocates each unique model ONCE to the best-fit provider with remaining budget:
 *  - Excludes guard/safety/TTS/image/<7B peanut clutter
 *  - Groups identical canonical models across multiple providers
 *  - Assigns each model to the highest-budget/best-context provider using a
 *    load-balance penalty so models spread evenly across all active providers
 *  - Interleaves providers round-robin so fallback hops rotate providers
 */
function buildRecommendedChains(db, catalog) {
  const configured = getConfiguredPlatforms(db);
  const dbModels = db.prepare(`
    SELECT id, platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
           rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget,
           context_window, enabled, supports_vision, supports_tools
    FROM models
    WHERE enabled = 1
  `).all().filter((m) => configured.has(m.platform));

  const catalogIndex = new Map();
  for (const p of catalog.providers) {
    for (const cm of p.models) {
      catalogIndex.set(`${p.id}:${cm.modelId}`, cm);
    }
  }

  const enriched = dbModels.map((m) => {
    const cat = catalogIndex.get(`${m.platform}:${m.model_id}`);
    const cls = classifyModel({
      modelId: m.model_id,
      displayName: m.display_name,
      sizeLabel: m.size_label,
      contextWindow: m.context_window,
      intelligenceRank: m.intelligence_rank,
      speedRank: m.speed_rank,
      supportsTools: m.supports_tools,
      supportsVision: m.supports_vision,
      monthlyTokenBudget: m.monthly_token_budget,
      quirks: cat?.quirks || [],
    }, m.platform);

    return {
      dbId: m.id,
      platform: m.platform,
      modelId: m.model_id,
      displayName: m.display_name || m.model_id,
      contextWindow: m.context_window || 0,
      monthlyTokenBudget: m.monthly_token_budget || '',
      cls,
    };
  });

  const results = {};

  for (const def of CHAIN_DEFINITIONS) {
    const scoreField =
      def.name === 'frontier-heavy' ? 'scoreFrontier' :
      def.name === 'balanced-daily' ? 'scoreBalanced' : 'scoreFast';

    // 1. Filter out clutter/peanuts and keep eligible models for this chain tier
    const eligible = enriched.filter((item) => item.cls.bestFor.includes(def.name));

    // 2. Group by canonical model name (same model across many providers)
    const byCanonical = new Map();
    for (const item of eligible) {
      const key = item.cls.canonicalKey;
      if (!byCanonical.has(key)) byCanonical.set(key, []);
      byCanonical.get(key).push(item);
    }

    // Order unique models by their peak capability score first
    const modelGroups = [...byCanonical.values()].sort(
      (a, b) => Math.max(...b.map((x) => x.cls[scoreField])) - Math.max(...a.map((x) => x.cls[scoreField]))
    );

    // 3. Load-aware assignment: pick ONE provider per unique model respecting caps
    const perProviderCount = new Map();
    const chosen = [];

    for (const group of modelGroups) {
      let bestPick = null;
      let bestAdjustedScore = -Infinity;

      for (const candidate of group) {
        const pInfo = PROVIDER_QUOTA_PROFILES[candidate.platform] || { chainCap: 2 };
        const cap = pInfo.chainCap ?? 2;
        if (cap <= 0) continue;
        const used = perProviderCount.get(candidate.platform) || 0;
        if (used >= cap) continue;

        // Penalize providers already carrying multiple models so other providers absorb load
        const adjusted = candidate.cls[scoreField] - used * 14;
        if (adjusted > bestAdjustedScore) {
          bestAdjustedScore = adjusted;
          bestPick = candidate;
        }
      }

      if (bestPick) {
        perProviderCount.set(bestPick.platform, (perProviderCount.get(bestPick.platform) || 0) + 1);
        chosen.push(bestPick);
        if (chosen.length >= def.targetSize) break;
      }
    }

    // 4. Interleave providers round-robin so consecutive fallbacks hit different providers
    const buckets = new Map();
    for (const item of chosen) {
      if (!buckets.has(item.platform)) buckets.set(item.platform, []);
      buckets.get(item.platform).push(item);
    }
    const ordered = [];
    let addedInRound = true;
    while (addedInRound) {
      addedInRound = false;
      for (const list of buckets.values()) {
        if (list.length > 0) {
          ordered.push(list.shift());
          addedInRound = true;
        }
      }
    }

    results[def.name] = { def, items: ordered };
  }

  return results;
}

// ── Chain Matching & Interactive Sync ─────────────────────────────────────────
async function runChainCheck(db, rl, catalog, { autoPrompt = true } = {}) {
  drawRule(paint(c.brightCyan, 'Chain Diagnostics & Provider-Diversity Matcher'));

  const profiles = db.prepare(`SELECT id, name, emoji, color, type, auto_sort FROM profiles WHERE type = 'custom'`).all();
  const recommended = buildRecommendedChains(db, catalog);
  const configuredCount = getConfiguredPlatforms(db).size;

  if (configuredCount === 0) {
    console.log(paint(c.yellow, '  No enabled provider keys found in DB yet. Add providers first, then chains will match automatically.\n'));
    return;
  }

  // Case 1: No custom chains detected at all
  if (profiles.length === 0) {
    console.log(paint(c.yellow, '  No chains detected in freeapi.db (only Default exists).'));
    console.log(paint(c.gray, '  Recommended intelligent chains ready for your active providers:'));
    for (const def of CHAIN_DEFINITIONS) {
      const rec = recommended[def.name];
      const provs = new Set(rec.items.map((x) => x.platform)).size;
      console.log(`    ${def.emoji} ${c.bold}${def.name}${c.reset}: ${c.brightGreen}${rec.items.length} models${c.reset} spread across ${c.cyan}${provs} providers${c.reset} ${c.gray}(${def.description})${c.reset}`);
    }

    if (!autoPrompt) return;
    const ans = (await rl.question(`\n  ${c.brightCyan}No chains detected — create them now? [Y/n]:${c.reset} `)).trim().toLowerCase();
    if (ans === '' || ans === 'y' || ans === 'yes') {
      createOrSyncAllChains(db, recommended, { replaceExisting: true });
      console.log(paint(c.brightGreen, '  ✓ Created frontier-heavy, balanced-daily, and fast-pool chains with provider-diversified routing!\n'));
    } else {
      console.log(paint(c.gray, '  Skipped chain creation.\n'));
    }
    return;
  }

  // Case 2: Inspect existing chains and match models/providers
  const profileByName = new Map(profiles.map((p) => [p.name.toLowerCase(), p]));
  let anyActionNeeded = false;

  for (const def of CHAIN_DEFINITIONS) {
    const rec = recommended[def.name];
    const existing = profileByName.get(def.name);

    if (!existing) {
      anyActionNeeded = true;
      console.log(`  ${def.emoji} ${c.bold}${def.name}${c.reset}: ${paint(c.yellow, 'MISSING CHAIN')} (${rec.items.length} recommended models ready)`);
      if (autoPrompt) {
        const ans = (await rl.question(`     ${c.cyan}Create '${def.name}' chain with ${rec.items.length} diversified models? [Y/n]:${c.reset} `)).trim().toLowerCase();
        if (ans === '' || ans === 'y' || ans === 'yes') {
          createOrUpdateSingleChain(db, def, rec.items, { replace: true });
          console.log(paint(c.brightGreen, `     ✓ Created '${def.name}' (${rec.items.length} models)`));
        }
      }
      continue;
    }

    const currentRows = db.prepare(`
      SELECT pm.model_db_id, m.platform, m.model_id
      FROM profile_models pm
      JOIN models m ON m.id = pm.model_db_id
      WHERE pm.profile_id = ?
      ORDER BY pm.priority ASC
    `).all(existing.id);

    const currentIds = new Set(currentRows.map((r) => r.model_db_id));
    const missing = rec.items.filter((x) => !currentIds.has(x.dbId));
    const currentProvs = new Set(currentRows.map((r) => r.platform)).size;

    if (missing.length === 0) {
      console.log(`  ${def.emoji} ${padRight(c.bold + def.name + c.reset, 14)} ${paint(c.brightGreen, '✓ MATCHED')}  ${currentRows.length} models across ${currentProvs} providers`);
    } else {
      anyActionNeeded = true;
      const preview = missing.slice(0, 5).map((x) => `${x.platform}/${x.modelId}`).join(', ');
      const extra = missing.length > 5 ? ` +${missing.length - 5} more` : '';
      console.log(`  ${def.emoji} ${padRight(c.bold + def.name + c.reset, 14)} ${paint(c.yellow, `${missing.length} MISSING`)}  (has ${currentRows.length} models): ${c.gray}${preview}${extra}${c.reset}`);

      if (autoPrompt) {
        const ans = (await rl.question(`     ${c.cyan}[A]dd ${missing.length} missing / [R]ebalance full diversified chain / [S]kip?${c.reset} `)).trim().toLowerCase();
        if (ans === 'r' || ans === 'rebuild') {
          createOrUpdateSingleChain(db, def, rec.items, { replace: true, existingId: existing.id });
          console.log(paint(c.brightGreen, `     ✓ Rebalanced '${def.name}' (${rec.items.length} diversified models)`));
        } else if (ans === 'a' || ans === 'add' || ans === 'y' || ans === 'yes' || ans === '') {
          appendModelsToChain(db, existing.id, missing, currentRows.length);
          console.log(paint(c.brightGreen, `     ✓ Added ${missing.length} model(s) to '${def.name}'`));
        } else {
          console.log(paint(c.gray, `     -> Skipped '${def.name}'`));
        }
      }
    }
  }

  if (!anyActionNeeded) {
    console.log(paint(c.gray, '  All recommended chains are balanced and up to date.\n'));
  } else {
    console.log('');
  }
}

function createOrUpdateSingleChain(db, def, items, { replace = false, existingId = null } = {}) {
  const tx = db.transaction(() => {
    let profileId = existingId;
    if (!profileId) {
      const maxSort = db.prepare(`SELECT COALESCE(MAX(sort_order), -1) AS m FROM profiles`).get().m;
      const res = db.prepare(`
        INSERT INTO profiles (name, emoji, color, type, is_favorite, sort_order, auto_sort, auto_include_new_models)
        VALUES (?, ?, ?, 'custom', 0, ?, ?, 0)
      `).run(def.name, def.emoji, def.color, maxSort + 1, def.autoSort);
      profileId = Number(res.lastInsertRowid);
    }

    if (replace) {
      db.prepare(`DELETE FROM profile_models WHERE profile_id = ?`).run(profileId);
    }

    const insert = db.prepare(`
      INSERT INTO profile_models (profile_id, model_db_id, priority, enabled)
      VALUES (?, ?, ?, 1)
    `);
    items.forEach((item, idx) => insert.run(profileId, item.dbId, idx));
  });
  tx();
}

function appendModelsToChain(db, profileId, missingItems, startPriority) {
  const insert = db.prepare(`
    INSERT INTO profile_models (profile_id, model_db_id, priority, enabled)
    VALUES (?, ?, ?, 1)
  `);
  const tx = db.transaction(() => {
    missingItems.forEach((item, idx) => insert.run(profileId, item.dbId, startPriority + idx));
  });
  tx();
}

function createOrSyncAllChains(db, recommended, { replaceExisting = false } = {}) {
  const profiles = db.prepare(`SELECT id, name FROM profiles WHERE type = 'custom'`).all();
  const byName = new Map(profiles.map((p) => [p.name.toLowerCase(), p.id]));
  for (const def of CHAIN_DEFINITIONS) {
    const existingId = byName.get(def.name) || null;
    createOrUpdateSingleChain(db, def, recommended[def.name].items, {
      replace: replaceExisting || !existingId,
      existingId,
    });
  }
}

// ── Interactive Classification Browser & Provider Setup ───────────────────────
function printProviderTable(providers, configuredSet) {
  console.log('');
  console.log(
    `  ${c.dim}${padRight('#', 4)}${padRight('Provider', 24)}${padRight('Class', 15)}${padRight('Models', 8)}${padRight('MaxCtx', 8)}${padRight('Quota / Budget', 32)}Status${c.reset}`
  );
  drawRule();
  providers.forEach((p, idx) => {
    const meta = QUOTA_TIER_META[p.classification.quotaTier] || QUOTA_TIER_META.moderate_quota;
    const isCfg = configuredSet.has(p.id);
    const status = isCfg ? paint(c.brightGreen, '● ACTIVE') : paint(c.gray, '○ missing');
    const classBadge = paint(meta.color, padRight(meta.badge, 15));
    const ctxStr = formatCtx(p.stats.maxContextWindow);
    console.log(
      `  ${padRight(c.cyan + String(idx + 1) + c.reset, 4)}${padRight(p.name.slice(0, 22), 24)}${classBadge}${padRight(String(p.stats.totalChatModels), 8)}${padRight(ctxStr, 8)}${padRight(p.classification.quotaSummary.slice(0, 30), 32)}${status}`
    );
  });
  console.log('');
}

function inspectProviderModels(p) {
  drawRule(`${c.bold}${p.name}${c.reset} (${p.id}) — ${p.stats.totalChatModels} models`);
  console.log(`  ${c.yellow}Quota Class:${c.reset} ${p.classification.quotaBadge} — ${p.classification.quotaSummary}`);
  console.log(`  ${c.yellow}Key Portal:${c.reset}  ${c.cyan}${p.portalUrl}${c.reset}  (${p.keyFormat})`);
  console.log(`  ${c.dim}Top models (by intelligence):${c.reset}`);
  p.models.slice(0, 10).forEach((m) => {
    const tags = [
      formatCtx(m.contextWindow),
      m.sizeLabel,
      m.supportsTools ? 'tools' : 'no-tools',
      m.classification.bestFor.length ? `chains:[${m.classification.bestFor.join(',')}]` : 'utility',
    ].join(' · ');
    console.log(`    • ${padRight(m.modelId, 42)} ${c.gray}${tags}${c.reset}`);
  });
  if (p.models.length > 10) {
    console.log(paint(c.gray, `    ...and ${p.models.length - 10} more models saved in scripts/catalog-providers.json`));
  }
  console.log('');
}

async function runAddWorkflow(db, rl, catalog, filterFn, titleLabel) {
  const configured = getConfiguredPlatforms(db);
  const candidates = catalog.providers.filter((p) => !p.hidden && p.stats.totalChatModels > 0 && filterFn(p, configured));

  if (candidates.length === 0) {
    console.log(paint(c.brightGreen, `\n  All providers matching "${titleLabel}" are already configured!\n`));
    return;
  }

  printProviderTable(candidates, configured);
  const pick = (await rl.question(`  ${c.brightCyan}Walk through all ${candidates.length} listed, or enter # (e.g. 1,3) [A=all / S=back]:${c.reset} `)).trim();
  if (!pick || pick.toLowerCase() === 's' || pick.toLowerCase() === 'back') return;

  let chosen = candidates;
  if (pick.toLowerCase() !== 'a' && pick.toLowerCase() !== 'all') {
    const idxs = pick.split(/[,\s]+/).map((n) => parseInt(n, 10) - 1).filter((i) => i >= 0 && i < candidates.length);
    if (idxs.length === 0) {
      console.log(paint(c.yellow, '  No valid indices selected.'));
      return;
    }
    chosen = idxs.map((i) => candidates[i]);
  }

  let addedAny = false;
  for (let i = 0; i < chosen.length; i++) {
    const p = chosen[i];
    if (configured.has(p.id)) {
      console.log(paint(c.gray, `\n[${i + 1}/${chosen.length}] ${p.name} already configured — skipping.`));
      continue;
    }
    console.log('');
    inspectProviderModels(p);

    if (p.keyless) {
      const ans = (await rl.question(`  ${c.brightGreen}[KEYLESS] Activate ${p.name} right now? [Y/n/q]:${c.reset} `)).trim().toLowerCase();
      if (ans === 'q') break;
      if (ans === 'n') continue;
    } else {
      const ans = (await rl.question(`  ${c.cyan}[O]pen key portal in browser / [P]aste key / [S]kip / [Q]uit:${c.reset} `)).trim().toLowerCase();
      if (ans === 'q') break;
      if (ans === 's') continue;
      if (ans === 'o' || ans === '') openBrowser(p.portalUrl);
    }

    const res = await saveProviderKeyInteractive(db, rl, p);
    if (res.skipped) {
      console.log(paint(c.yellow, `  -> Skipped ${p.name}`));
      continue;
    }
    addedAny = true;
    configured.add(p.id);
    console.log(paint(c.brightGreen, `  ✓ Saved ${p.name} (key #${res.keyId}, synced ${res.syncedModels} catalog models)`));

    // Re-run chain matching right after adding a provider!
    await runChainCheck(db, rl, catalog, { autoPrompt: true });
  }

  if (!addedAny) console.log(paint(c.gray, '\n  No new providers added.\n'));
}

// ── Main Interactive Loop ─────────────────────────────────────────────────────
async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--help') || args.has('-h')) {
    console.log(`
FreeLLMAPI Universal Provider & Chain Manager

Usage:
  node ${path.basename(process.argv[1] || 'freellmapi-setup-cli.mjs')} [options]

Options:
  --db <path>       Path to freeapi.db (auto-detected by default)
  --scrape-only     Scrape https://freellmapi.co/models & save catalog-providers.json
  --check-chains    Run chain diagnostics & exit
  -h, --help        Show this help message
`);
    return;
  }
  const scrapeOnly = args.has('--scrape-only');
  const checkChainsOnly = args.has('--check-chains');

  console.clear?.();
  drawBox('FreeLLMAPI Universal Provider & Chain Manager', [
    `${c.gray}OS:${c.reset} ${process.platform} (${process.arch})   ${c.gray}Node:${c.reset} ${process.version}`,
    `${c.gray}DB:${c.reset} ${path.relative(ROOT, DB_PATH)}`,
  ]);

  process.stdout.write(paint(c.cyan, '\n  Scraping live catalog from freellmapi.co... '));
  const { catalog, fromCache, error } = await scrapeLiveCatalog();
  if (fromCache) {
    console.log(paint(c.yellow, `offline fallback (${error})`));
  } else {
    console.log(paint(c.brightGreen, `OK (v${catalog.catalogVersion})`));
  }
  console.log(
    paint(
      c.gray,
      `  Saved ${catalog.providers.length} providers & ${catalog.providers.reduce((s, p) => s + p.stats.totalChatModels, 0)} chat models -> ${path.relative(ROOT, CATALOG_OUT_PATH)}\n`
    )
  );

  if (scrapeOnly) return;

  const db = openDb();
  const rl = createPrompter();

  try {
    // 1. Always inspect & match chains on startup!
    await runChainCheck(db, rl, catalog, { autoPrompt: true });
    if (checkChainsOnly) return;

    // 2. Interactive menu
    while (true) {
      const configured = getConfiguredPlatforms(db);
      const missingCount = catalog.providers.filter((p) => !p.hidden && p.stats.totalChatModels > 0 && !configured.has(p.id)).length;

      drawBox('Main Menu — Choose How to Add Providers & Models', [
        `${c.brightCyan}[1]${c.reset} Add ${c.bold}ALL${c.reset} missing providers (${missingCount} remaining)`,
        `${c.brightCyan}[2]${c.reset} Filter by ${c.bold}Classification${c.reset} (Keyless / High-Quota / >=128K / Frontier / Wallets)`,
        `${c.brightCyan}[3]${c.reset} View full classified provider & quota table`,
        `${c.brightCyan}[4]${c.reset} Inspect & rebalance ${c.bold}Budget-Balanced Chains${c.reset} (frontier-heavy, balanced-daily, fast-pool)`,
        `${c.brightCyan}[5]${c.reset} Re-scrape ${c.gray}freellmapi.co/models${c.reset} & refresh ${c.gray}catalog-providers.json${c.reset}`,
        `${c.brightCyan}[Q]${c.reset} Quit`,
      ], c.blue);

      const choice = (await rl.question(`\n  ${c.brightCyan}Select option:${c.reset} `)).trim().toLowerCase();

      if (choice === 'q' || choice === 'quit' || choice === 'exit') break;

      if (choice === '1') {
        await runAddWorkflow(db, rl, catalog, (_p, cfg) => !_p.hidden && !cfg.has(_p.id), 'All Missing Providers');
      } else if (choice === '2') {
        console.log('');
        console.log(`  ${c.bold}Pick a Classification Filter:${c.reset}`);
        console.log(`    ${c.cyan}[a]${c.reset} Keyless / Instant Setup (no card, no signup)`);
        console.log(`    ${c.cyan}[b]${c.reset} High-Quota / Generous Daily or Monthly Tokens (best for main/workers)`);
        console.log(`    ${c.cyan}[c]${c.reset} >=128K Context & Tool-Calling Capable (best for coding agents)`);
        console.log(`    ${c.cyan}[d]${c.reset} Frontier / 1M+ Context Specialists (best for architect planning)`);
        console.log(`    ${c.cyan}[e]${c.reset} Credit Wallets & Strict-Cap Fallbacks (ElectronHub, OpenRouter, etc.)`);
        const f = (await rl.question(`  ${c.brightCyan}Classification [a-e]:${c.reset} `)).trim().toLowerCase();

        if (f === 'a') {
          await runAddWorkflow(db, rl, catalog, (p, cfg) => !cfg.has(p.id) && p.classification.quotaTier === 'keyless_instant', 'Keyless Instant');
        } else if (f === 'b') {
          await runAddWorkflow(db, rl, catalog, (p, cfg) => !cfg.has(p.id) && ['keyless_instant', 'high_quota', 'moderate_quota'].includes(p.classification.quotaTier), 'High/Moderate Quota');
        } else if (f === 'c') {
          await runAddWorkflow(db, rl, catalog, (p, cfg) => !cfg.has(p.id) && p.stats.ctx128kPlus > 0 && p.stats.toolsCapable > 0, '128K+ Context & Tools');
        } else if (f === 'd') {
          await runAddWorkflow(db, rl, catalog, (p, cfg) => !cfg.has(p.id) && (p.stats.ctx1mPlus > 0 || p.models.some((m) => m.classification.paramTier === 'frontier_large')), 'Frontier / 1M+ Context');
        } else if (f === 'e') {
          await runAddWorkflow(db, rl, catalog, (p, cfg) => !cfg.has(p.id) && ['credit_wallet', 'strict_cap'].includes(p.classification.quotaTier), 'Credit Wallet & Strict Cap');
        }
      } else if (choice === '3') {
        printProviderTable(catalog.providers.filter((p) => p.stats.totalChatModels > 0), configured);
      } else if (choice === '4') {
        await runChainCheck(db, rl, catalog, { autoPrompt: true });
      } else if (choice === '5') {
        const fresh = await scrapeLiveCatalog();
        Object.assign(catalog, fresh.catalog);
        console.log(paint(c.brightGreen, `  ✓ Refreshed catalog (v${catalog.catalogVersion}) -> ${path.relative(ROOT, CATALOG_OUT_PATH)}\n`));
        await runChainCheck(db, rl, catalog, { autoPrompt: true });
      }
    }
  } finally {
    rl.close();
    db.close();
  }

  console.log(paint(c.brightGreen, '\n  Done! All keys & diversified chains are saved in server/data/freeapi.db.\n'));
}

main().catch((err) => {
  console.error(paint(c.red, `\nError: ${err?.message || err}`));
  process.exit(1);
});
