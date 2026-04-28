import express, { type Request, type Response, type NextFunction } from 'express';
import { GoogleGenAI, Type } from '@google/genai';
import dotenv from 'dotenv';
import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { parse } from 'csv-parse/sync';
import { MongoClient, type Collection } from 'mongodb';
import rateLimit from 'express-rate-limit';
import { randomUUID } from 'crypto';
import nodemailer, { type Transporter } from 'nodemailer';

dotenv.config({ path: '.env' });
dotenv.config({ path: '.env.local', override: true });

const app = express();
// Tight body cap — every legit profile payload is well under a few KB. The
// 16 KB ceiling stops unbounded `linkedRecommendation` blobs from filling
// Mongo with arbitrary JSON via /api/lead, and rules out trivially-large
// prompt-injection payloads that try to fill the prompt window.
app.use(express.json({ limit: '16kb' }));
app.disable('x-powered-by');

// Per-request correlation id — propagates through all logs for one request
// and is echoed back in the response so support can trace user reports to
// the exact Gemini call. Express attaches it to res.locals so handlers can
// log with it and Mongo can store it.
app.use((req, res, next) => {
  const rid = randomUUID();
  res.locals.requestId = rid;
  res.setHeader('X-Request-Id', rid);
  next();
});

const PORT = parseInt(process.env.PORT || '3000', 10);

// Fast-fail at boot rather than handing out 500s on the first prediction.
// `process.env.GEMINI_API_KEY!` would let the server boot with the key
// undefined and only blow up on the first /api/predict — much harder to
// diagnose in a fresh deploy. Surfacing it here keeps misconfig visible.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
if (!GEMINI_API_KEY) {
  console.error('[boot] GEMINI_API_KEY is not set — predictor will be unavailable');
  console.error('[boot] Set GEMINI_API_KEY in .env / .env.local / docker compose env, then restart.');
  process.exit(1);
}

// ── Boot-time diagnostics ───────────────────────────────────────────────────
// Loud on startup so deployment problems surface immediately in the logs
// rather than as cryptic auth errors on the first prediction call.
console.log('━'.repeat(72));
console.log(`[boot] node ${process.version} | NODE_ENV=${process.env.NODE_ENV || '(unset)'} | cwd=${process.cwd()}`);
console.log(`[boot] PORT=${PORT}`);
console.log(`[boot] GEMINI_API_KEY: loaded (${GEMINI_API_KEY.length} chars, prefix=${GEMINI_API_KEY.slice(0,6)}…)`);
console.log(`[boot] MONGODB_URI: ${process.env.MONGODB_URI ? 'set' : '(unset — persistence disabled)'}`);
console.log(`[boot] MONGODB_DB: ${process.env.MONGODB_DB || 'mbbs_predictor (default)'}`);
console.log(`[boot] GOOGLE_GENAI_USE_VERTEXAI: ${process.env.GOOGLE_GENAI_USE_VERTEXAI || '(unset, good)'}${process.env.GOOGLE_GENAI_USE_VERTEXAI === 'true' ? ' ⚠️ VERTEX MODE FORCES ADC AUTH' : ''}`);
console.log(`[boot] dotenv loaded from: .env${existsSync('.env') ? ' ✓' : ' ✗'} | .env.local${existsSync('.env.local') ? ' ✓' : ' ✗'}`);
console.log('━'.repeat(72));

// ── MongoDB persistence ──────────────────────────────────────────────────────
// Two collections, two separate concerns:
//
//   recommendations — every prediction (input profile + AI output + telemetry).
//                     Anonymous. Used for usage analytics and model evaluation.
//                     Written automatically after every successful /api/predict.
//
//   leads          — real contact form submissions (name + email + phone +
//                     message). Used by the counselling team for outreach.
//                     Written when a visitor submits the "Get Free Counselling"
//                     modal via POST /api/lead. Soft-links to the user's most
//                     recent recommendation if the browser sends one along.
//
// All inserts are fire-and-forget where possible. If MONGODB_URI is unset or
// the cluster is unreachable, both layers no-op gracefully — predictor still
// works, contact form just degrades to a clear error.

const MONGODB_URI = process.env.MONGODB_URI || '';
const MONGODB_DB  = process.env.MONGODB_DB  || 'mbbs_predictor';
let mongoClient: MongoClient | null = null;
let recommendationsCollection: Collection | null = null;
let leadsCollection: Collection | null = null;

async function initMongo(): Promise<void> {
  if (!MONGODB_URI) {
    console.log('[mongo] MONGODB_URI not set — persistence disabled');
    return;
  }
  try {
    const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
    await client.connect();
    mongoClient = client;
    const db = client.db(MONGODB_DB);

    recommendationsCollection = db.collection('recommendations');
    leadsCollection            = db.collection('leads');

    await Promise.all([
      // recommendations indexes — chronological + dashboard filters
      recommendationsCollection.createIndex({ timestamp: -1 }),
      recommendationsCollection.createIndex({ 'meta.destinationType': 1, 'meta.neetScore': 1 }),
      recommendationsCollection.createIndex({ 'meta.domicileState': 1, 'meta.category': 1 }),
      // leads indexes — chronological + email lookup (no unique constraint
      // intentionally; same person may submit multiple enquiries over time)
      leadsCollection.createIndex({ timestamp: -1 }),
      leadsCollection.createIndex({ email: 1 }),
      leadsCollection.createIndex({ phone: 1 }),
      leadsCollection.createIndex({ sessionId: 1 }),
      // Same sessionId index on recommendations for the join
      recommendationsCollection.createIndex({ sessionId: 1 }),
    ]);
    console.log(`[mongo] connected to ${MONGODB_DB} (recommendations + leads enabled)`);
  } catch (e: any) {
    console.error('[mongo] connection failed — persistence disabled:', e?.message || e);
    recommendationsCollection = null;
    leadsCollection = null;
  }
}

// sessionId is the join key between `recommendations` and `leads`. Generated
// in the browser (UUID v4) on first visit and persisted in localStorage, so
// the same browser/device sends a stable id across all predictions and the
// eventual contact-form submission. Server treats it as opaque and validates
// only that it's a sane-shaped string.
function sanitizeSessionId(s: any): string | null {
  if (typeof s !== 'string') return null;
  const trimmed = s.trim();
  if (!trimmed || trimmed.length > 80 || !/^[a-zA-Z0-9_-]+$/.test(trimmed)) return null;
  return trimmed;
}

// Timestamps are stored as ISO 8601 strings in IST offset (+05:30), not UTC Z.
// Format: "2026-04-27T14:30:45.123+05:30" — sortable lexicographically, parseable
// by every Mongo client (`new Date("2026-04-27T14:30:45.123+05:30")` works), and
// human-readable directly when viewed in MongoDB Compass without timezone math.
function nowIST(): string {
  const ms = Date.now() + 5.5 * 3600 * 1000;
  return new Date(ms).toISOString().replace('Z', '+05:30');
}

// recordRecommendation — fire-and-forget, called AFTER res.json() in /api/predict.
// Verification output is broken out as a top-level field (stateVerification /
// abroadVerification) rather than left buried in result.stateQuotaInsights, so
// support can reproduce exactly what the grounded call returned for a given
// session — grounding results aren't cached and re-running won't reproduce
// them.
function recordRecommendation(profile: any, result: any): void {
  if (!recommendationsCollection) return;
  try {
    const tel  = result?.telemetry || {};
    const main = tel.mainCall || {};
    const sessionId = sanitizeSessionId(profile?.sessionId);
    const isIndia = profile?.destinationType === 'India';
    const stateVerification  = isIndia ? (result?.stateQuotaInsights ?? null) : null;
    const abroadVerification = isIndia ? null : (result?.abroadInsights ?? null);
    const doc  = {
      timestamp: nowIST(),       // ISO 8601 +05:30 (IST), e.g. "2026-04-27T14:30:45.123+05:30"
      sessionId,                 // join key with leads collection
      profile,
      result,
      stateVerification,         // grounded state-quota verifier output (India only) or null
      abroadVerification,        // grounded abroad verifier output (future, abroad only) or null
      meta: {
        sessionId,
        destinationType:    profile?.destinationType,
        neetScore:          profile?.neetScore || null,
        neetRank:           profile?.neetRank  || null,
        category:           profile?.category  || null,
        gender:             profile?.gender    || null,
        domicileState:      profile?.domicileState || null,
        budgetInUSD:        profile?.budgetInUSD   || null,
        universitiesCount:  Array.isArray(result?.universities) ? result.universities.length : 0,
        wallClockMs:        tel.wallClockMs ?? null,
        mainCallLatencyMs:  main.latencyMs  ?? null,
        promptTokens:       main.promptTokens ?? null,
        outputTokens:       main.outputTokens ?? null,
        estCostUSD:         main.estCostUSD   ?? null,
        stateVerified:      tel.stateVerified ?? false,
        abroadVerified:     tel.abroadVerified ?? false,
        validatorDrops:      tel.validatorDrops      ?? null,
        validatorOverrides:  tel.validatorOverrides  ?? null,
        validatorSkipped:    tel.validatorSkipped    ?? null,
        validatorBackfilled: tel.validatorBackfilled ?? null,
      },
    };
    recommendationsCollection.insertOne(doc).then(r => {
      console.log(`[mongo] recommendation saved: ${r.insertedId} (sessionId=${sessionId || '-'}, dest=${profile?.destinationType}, unis=${doc.meta.universitiesCount})`);
    }).catch(err => {
      console.error('[mongo] recommendations.insertOne FAILED:', err?.message || err);
      if (err?.stack) console.error(err.stack);
    });
  } catch (e: any) {
    console.error('[mongo] recordRecommendation THREW:', e?.message || e);
    if (e?.stack) console.error(e.stack);
  }
}

// ── Static frontend ──────────────────────────────────────────────────────────
// Only the landing HTML is served. The previous `express.static(ROOT)` mounted
// the entire repo over HTTP — anyone could fetch /prompts.json (the IP), the
// raw datasets (data/**, MBBS.xlsx), or source files (server.ts, package.json,
// Dockerfile, .env.example). The HTML has no external asset references (all
// CSS/JS inlined) so a single sendFile route is all we need.

const ROOT = process.cwd();
const LANDING_HTML = 'mbbs_landing_page_with tool.html';

app.get('/', (_req, res) => res.sendFile(join(ROOT, LANDING_HTML)));

// Brand assets are routed explicitly (CLAUDE.md: no express.static — that
// previously exposed prompts.json + the entire CSV dataset). Keep this list
// narrow; only ship what the landing page actually references.
const STATIC_ASSETS: Record<string, string> = {
  '/vidysea_logo.jpg': 'vidysea_logo.jpg',
};
for (const [route, file] of Object.entries(STATIC_ASSETS)) {
  app.get(route, (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(join(ROOT, file));
  });
}

// ── Rate limiting ────────────────────────────────────────────────────────────
// /api/predict spends real money on every call (Gemini Flash + grounded query
// ≈ $0.015–0.05 each). /api/lead writes to Mongo and forwards to the
// counselling team. Both need per-IP caps. Numbers are deliberately generous
// for legit users on one device but tight enough to make a brute spam loop
// unprofitable.
const predictLimiter = rateLimit({
  windowMs: 60 * 1000,        // 1 minute
  limit: 8,                    // 8 predictions per IP per minute
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many prediction requests. Please wait a minute and try again.' },
});
const leadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,   // 10 minutes
  limit: 5,                    // 5 lead submissions per IP per 10 min
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many submissions. Please wait a few minutes before trying again.' },
});

// ── NEET CSV loader (India predictor) ────────────────────────────────────────

interface CutoffRow {
  institute: string;
  state: string;
  course: string;
  quota: string;
  category: string;
  closingRank: number;
}

const norm = (s: string) => (s || '').replace(/\s+/g, ' ').trim();

// Parse "Institute Name, address chunks..., State, pincode" — last comma-separated
// chunk that matches a known Indian state name is the state.
const INDIAN_STATES = new Set([
  'andhra pradesh', 'arunachal pradesh', 'assam', 'bihar', 'chhattisgarh',
  'goa', 'gujarat', 'haryana', 'himachal pradesh', 'jharkhand', 'karnataka',
  'kerala', 'madhya pradesh', 'maharashtra', 'manipur', 'meghalaya', 'mizoram',
  'nagaland', 'odisha', 'punjab', 'rajasthan', 'sikkim', 'tamil nadu',
  'telangana', 'tripura', 'uttar pradesh', 'uttarakhand', 'west bengal',
  'delhi', 'jammu and kashmir', 'jammu & kashmir', 'ladakh', 'chandigarh',
  'puducherry', 'andaman and nicobar islands', 'dadra and nagar haveli',
  'daman and diu', 'lakshadweep',
]);

function extractState(institute: string): string {
  const parts = institute.split(',').map(p => norm(p).toLowerCase());
  for (let i = parts.length - 1; i >= 0; i--) {
    if (INDIAN_STATES.has(parts[i])) {
      return parts[i].replace(/\b\w/g, c => c.toUpperCase());
    }
  }
  return '';
}

function instituteShortName(raw: string): string {
  // Take everything up to the first comma (or first newline) — drop the address.
  const head = raw.split(/,|\n/)[0];
  return norm(head);
}

// City→state backfill map. The address-tail heuristic in extractState() misses
// ~42% of MCC institutes (audited on 2024 CSV) because many institute names
// are short like "AIIMS Patna" or "GMC Mumbai" with no state suffix. The
// curated city_state_map.json bridges this gap: lookup keyed on lowercase
// city tokens extracted from the institute's short name. Loaded once at boot.
let CITY_STATE_MAP: Record<string, string> = {};
function loadCityStateMap(): void {
  const path = join(ROOT, 'scripts', 'data', 'city_state_map.json');
  if (!existsSync(path)) {
    console.warn('[backfill] scripts/data/city_state_map.json missing — state backfill disabled');
    return;
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    const cities = raw?.cities && typeof raw.cities === 'object' ? raw.cities : raw;
    let count = 0;
    for (const [k, v] of Object.entries(cities)) {
      if (typeof k === 'string' && typeof v === 'string') {
        CITY_STATE_MAP[k.toLowerCase().trim()] = String(v).trim();
        count++;
      }
    }
    console.log(`[backfill] loaded ${count} city→state entries`);
  } catch (e: any) {
    console.error('[backfill] failed to load city_state_map.json:', e?.message || e);
  }
}
loadCityStateMap();

// Try the city map when extractState() returns empty. Tokenizes the raw
// institute string and walks longest-phrase-first, RIGHT-TO-LEFT — addresses
// typically end with location info ("College Name, district, City, State"),
// so the city/state token is further right. The map is keyed on both city
// tokens (patna, mumbai, kolkata) and institutional shorthand (vmmc, jipmer,
// abvims) so even short-name-only rows resolve.
function backfillStateFromCity(institute: string): string {
  if (!Object.keys(CITY_STATE_MAP).length) return '';
  const lower = institute.toLowerCase();
  const tokens = lower.split(/[\s\-_(),./0-9]+/).filter(Boolean);
  // Multi-word first (length 3 → 1) so "new delhi" beats "new" or "delhi"
  // alone when both are present. Within each span, scan right-to-left.
  for (let span = Math.min(3, tokens.length); span >= 1; span--) {
    for (let i = tokens.length - span; i >= 0; i--) {
      const phrase = tokens.slice(i, i + span).join(' ');
      const hit = CITY_STATE_MAP[phrase];
      if (hit) return hit;
    }
  }
  return '';
}

function loadCutoffs(year: number): CutoffRow[] {
  const path = join(ROOT, 'data', 'neet', 'cutoffs_yearly', `neet_cutoffs_${year}.csv`);
  if (!existsSync(path)) return [];
  const records = parse(readFileSync(path, 'utf-8'), {
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
    relax_column_count: true,
  });
  const rows: CutoffRow[] = [];
  for (const r of records) {
    const course = norm(r['Course']);
    if (course.toUpperCase() !== 'MBBS') continue;
    const closing = parseInt(String(r['Closing_Rank']).replace(/[^\d]/g, ''), 10);
    if (!closing || closing <= 0) continue;
    const instituteRaw = r['Allotted Institute'] || '';
    const shortName = instituteShortName(instituteRaw);
    // Address-tail heuristic first; city-map backfill if that returns empty.
    // Use the FULL raw string for backfill — gives the map more tokens to
    // hit (e.g. address chunks beyond the short name) and matches how the
    // city_state_map.json was generated against the corpus.
    const state = extractState(instituteRaw) || backfillStateFromCity(instituteRaw);
    rows.push({
      institute: shortName,
      state,
      course,
      quota: norm(r['Allotted Quota']),
      category: norm(r['Allotted Category']),
      closingRank: closing,
    });
  }
  return rows;
}

// Auto-discover cutoff years from the directory rather than hardcoding 2024/
// 2023. When the 2025 file lands, drop it into the folder and the server
// picks it up on next boot — no code change. Falls back to an empty map if
// the directory is missing so the rest of the boot doesn't crash.
function discoverCutoffYears(): number[] {
  const dir = join(ROOT, 'data', 'neet', 'cutoffs_yearly');
  if (!existsSync(dir)) return [];
  const years = new Set<number>();
  for (const f of readdirSync(dir)) {
    const m = f.match(/^neet_cutoffs_(\d{4})\.csv$/);
    if (m) years.add(parseInt(m[1], 10));
  }
  return [...years].sort((a, b) => b - a);  // newest first
}

const CUTOFF_YEARS = discoverCutoffYears();
const cutoffsByYear: Record<number, CutoffRow[]> = {};
for (const y of CUTOFF_YEARS) cutoffsByYear[y] = loadCutoffs(y);

// Latest year that actually has data — `LATEST_CUTOFF_YEAR` is used widely
// for prompt anchors and "data is from year X" framing. If no CSVs exist,
// fall back to the current year so downstream math doesn't divide by zero.
const LATEST_CUTOFF_YEAR = CUTOFF_YEARS.find(y => cutoffsByYear[y].length > 0)
  ?? new Date().getFullYear();

// Convenience handles for the two most-recent years; consumers that want
// "the freshest available" use LATEST_CUTOFF_ROWS.
const LATEST_CUTOFF_ROWS = cutoffsByYear[LATEST_CUTOFF_YEAR] ?? [];

console.log(`[CSV] discovered cutoff years: ${CUTOFF_YEARS.length ? CUTOFF_YEARS.join(', ') : '(none)'} | latest=${LATEST_CUTOFF_YEAR} (${LATEST_CUTOFF_ROWS.length} MBBS rows)`);

// Boot-time data integrity check. Single multi-line audit block: per-year row
// counts, state-parse miss rate post-backfill, quota distribution, plus
// non-fatal warnings for anomalies that would silently degrade
// recommendations. Logged once at boot — does not run per request.
function validateDataIntegrityAtBoot(): void {
  console.log('━'.repeat(72));
  console.log('[data-audit] India CSV health');

  if (CUTOFF_YEARS.length === 0) {
    console.warn('[data-audit] ⚠️ no cutoff years discovered — India predictor will be effectively offline');
    console.log('━'.repeat(72));
    return;
  }

  // Per-year row counts + state-parse miss rates
  const rowCounts: Array<[number, number]> = CUTOFF_YEARS
    .map(y => [y, cutoffsByYear[y].length] as [number, number])
    .sort((a, b) => b[0] - a[0]);
  const median = rowCounts.map(([, n]) => n).sort((a, b) => a - b)[Math.floor(rowCounts.length / 2)];
  for (const [y, n] of rowCounts) {
    const rows = cutoffsByYear[y];
    const missing = rows.filter(r => !r.state).length;
    const missPct = rows.length ? Math.round(100 * missing / rows.length) : 0;
    const driftPct = median ? Math.round(100 * Math.abs(n - median) / median) : 0;
    const warn = driftPct > 25 ? ' ⚠️ row count is >25% off median' : '';
    const stateWarn = missPct > 10 ? ` ⚠️ ${missPct}% rows missing state` : '';
    console.log(`[data-audit]   ${y}: ${n} MBBS rows · ${missPct}% no-state${warn}${stateWarn}`);
  }

  // Quota distribution for the latest year
  const latest = LATEST_CUTOFF_ROWS;
  const byQuota: Record<string, number> = {};
  for (const r of latest) byQuota[r.quota] = (byQuota[r.quota] || 0) + 1;
  const aiqCount    = Object.entries(byQuota).filter(([q]) => ALL_INDIA_QUOTAS.has(q) && q !== 'Deemed/Paid Seats Quota').reduce((s, [, n]) => s + n, 0);
  const deemedCount = byQuota['Deemed/Paid Seats Quota'] || 0;
  const stateCount  = latest.length - aiqCount - deemedCount;
  console.log(`[data-audit]   ${LATEST_CUTOFF_YEAR} quotas: AIQ=${aiqCount} · Deemed=${deemedCount} · Other/State=${stateCount}`);
  if (aiqCount === 0)    console.warn('[data-audit] ⚠️ no AIQ rows in latest year — recommendations will lean entirely on Gemini knowledge');
  if (deemedCount === 0) console.warn('[data-audit] ⚠️ no Deemed rows in latest year — deemed probability will be 0%');

  // Abroad anchor freshness — warn if older than 6 months
  const abroadPath = join(ROOT, 'data', 'abroad', 'universities.json');
  if (existsSync(abroadPath)) {
    const ageMs = Date.now() - statSync(abroadPath).mtime.getTime();
    const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));
    const stale = ageDays > 180;
    console.log(`[data-audit]   abroad anchors: ${ABROAD_UNIS.length} unis · ${ageDays}d old${stale ? ' ⚠️ >6 months — consider re-extract' : ''}`);
  }

  // City-state map size
  console.log(`[data-audit]   city-state backfill map: ${Object.keys(CITY_STATE_MAP).length} entries`);
  console.log('━'.repeat(72));
}

// ── Prompt registry: all LLM prompts live in prompts.json ────────────────────
// Edit prompts there without touching this file. Variables use ${name} syntax
// and are substituted at runtime by fillTemplate(). Conditional fragments
// (topperBlock, altInstruction, etc.) are pre-rendered in JS and passed in as
// variables to the main template.

interface PromptRegistry {
  india: Record<string, string>;
  abroad: Record<string, string>;
}

const PROMPTS: PromptRegistry = JSON.parse(
  readFileSync(join(ROOT, 'prompts.json'), 'utf-8')
);

function fillTemplate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\$\{(\w+)\}/g, (_match, name) => {
    const v = vars[name];
    return v == null ? '' : String(v);
  });
}

// Robust JSON extractor for grounded Gemini responses. Grounding cannot be
// combined with responseSchema, so the model returns free-form text that
// usually contains JSON but may have:
//   - a prose preface ("Based on my search, here is the result: { ... }")
//   - one or more ```json ... ``` fences
//   - a trailing commentary or "Sources:" footer
// We try, in order:
//   1. parse the string verbatim (best case)
//   2. peel off markdown fences and parse
//   3. extract the first balanced { ... } substring and parse it
// If everything fails, return null and let the caller treat it as "no insights"
// rather than throwing.
function extractJsonObject(raw: string): any | null {
  if (!raw) return null;
  const text = raw.trim();
  // 1. straight parse
  try { return JSON.parse(text); } catch { /* fall through */ }
  // 2. strip markdown code fences (supports ```json or plain ```)
  const fenced = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  if (fenced !== text) {
    try { return JSON.parse(fenced); } catch { /* fall through */ }
  }
  // 3. find first balanced JSON object — counts braces ignoring strings
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (esc) { esc = false; continue; }
    if (c === '\\' && inStr) { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        try { return JSON.parse(candidate); } catch { return null; }
      }
    }
  }
  return null;
}

// ── LLM call wrapper: telemetry for every Gemini call ─────────────────────────
// Captures latency, prompt/output/total tokens, model name, and a label so the
// caller can correlate logs. Gemini ungrounded Flash pricing (Apr 2026): input
// ~$0.50/M, output ~$3/M. Grounded calls add ~$14/1K queries on Gemini 3 series.
// All numbers logged in one structured line per call so they're greppable.

const GEMINI_MODEL = 'gemini-3-flash-preview';
// Pricing per 1M tokens (Gemini 3 Flash Preview, Apr 2026)
const PRICE_INPUT_PER_M  = 0.50;
const PRICE_OUTPUT_PER_M = 3.00;
const PRICE_GROUNDING_PER_QUERY = 0.014;  // $14 per 1K grounded queries

// In-process spend accumulator. Resets on UTC day rollover. If today's spend
// exceeds DAILY_USD_CAP, /api/predict short-circuits with 503. This is a
// best-effort guard — distributed across replicas it under-counts (each
// replica accumulates independently), so set the cap below the true budget
// to leave headroom. For multi-replica deployments swap this for a Mongo or
// Redis counter.
const DAILY_USD_CAP = parseFloat(process.env.DAILY_USD_CAP || '50');
const spendTracker = {
  utcDay: new Date().toISOString().slice(0, 10),
  totalUSD: 0,
  callCount: 0,
};

function rollSpendDayIfNeeded(): void {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== spendTracker.utcDay) {
    console.log(`[spend] day rollover: ${spendTracker.utcDay} → ${today} | yesterday total=$${spendTracker.totalUSD.toFixed(4)} (${spendTracker.callCount} calls)`);
    spendTracker.utcDay = today;
    spendTracker.totalUSD = 0;
    spendTracker.callCount = 0;
  }
}

function recordSpend(usd: number): void {
  rollSpendDayIfNeeded();
  spendTracker.totalUSD += usd;
  spendTracker.callCount++;
}

function isOverDailyCap(): boolean {
  rollSpendDayIfNeeded();
  return spendTracker.totalUSD >= DAILY_USD_CAP;
}

interface CallTelemetry {
  label: string;
  latencyMs: number;
  promptTokens: number;
  outputTokens: number;
  totalTokens: number;
  estCostUSD: number;
  grounded: boolean;
}

// Per-call deadline. Real-world India predictions take 36–84s in our
// telemetry (long structured response + parallel grounded verifier). 25s
// was guarding against the wrong failure mode — it killed legitimate slow
// calls and the retry would also hit the same wall. 90s gives generous
// headroom above p95 (84s) without holding the user-facing request open
// indefinitely on a wedged Gemini connection.
const GEMINI_CALL_TIMEOUT_MS = 90_000;

// Retryable upstream conditions: 429 (rate-limited), 5xx (server-side
// transient), and network-level disconnects. Critically NOT retryable:
// our own client-side timeout (the call is genuinely slow, not transiently
// broken — retrying just burns the second 90s budget for the same result).
// Whether OUR timeout fired is checked SEPARATELY in the retry loop via the
// returned `timedOut` flag, because the SDK wraps the AbortError and loses
// our custom reason.
function isRetryableGeminiError(err: any): boolean {
  const status = err?.status ?? err?.response?.status;
  if (status === 429) return true;
  if (typeof status === 'number' && status >= 500 && status < 600) return true;
  const msg = String(err?.message || '').toLowerCase();
  if (msg.includes('etimedout') || msg.includes('econnreset') || msg.includes('socket hang up')) return true;
  // Transport-level abort that's NOT from our deadline (which we filter
  // separately via the timedOut flag in the retry loop).
  if (msg.includes('socket') && msg.includes('closed')) return true;
  return false;
}

// Returns the SDK response, or throws { error, timedOut } so the caller
// knows whether the failure was OUR timeout (don't retry) or a real
// upstream issue (retry might help).
async function callGeminiOnce(
  ai: GoogleGenAI,
  request: any,
): Promise<{ resp: any; timedOut: false }> {
  const ac = new AbortController();
  let timedOut = false;
  const t = setTimeout(() => { timedOut = true; ac.abort(); }, GEMINI_CALL_TIMEOUT_MS);
  try {
    // The SDK respects AbortSignal on the underlying fetch.
    const resp = await ai.models.generateContent({
      model: GEMINI_MODEL,
      ...request,
      config: { ...(request.config || {}), abortSignal: ac.signal },
    });
    return { resp, timedOut: false };
  } catch (err: any) {
    // Decorate the error with our timedOut flag so the retry loop can see
    // whether to retry or give up. Re-throw the original error otherwise.
    if (timedOut) {
      const wrap: any = new Error(`Gemini call exceeded ${GEMINI_CALL_TIMEOUT_MS}ms timeout`);
      wrap.timedOut = true;
      wrap.cause = err;
      throw wrap;
    }
    throw err;
  } finally {
    clearTimeout(t);
  }
}

async function callGemini(
  ai: GoogleGenAI,
  label: string,
  request: any,
  grounded = false,
): Promise<{ resp: any; tel: CallTelemetry }> {
  const t0 = Date.now();
  const promptPreview = typeof request?.contents === 'string'
    ? `${request.contents.length} chars`
    : '(non-string contents)';
  console.log(`  [gemini→] ${label} model=${GEMINI_MODEL} grounded=${grounded} prompt=${promptPreview}`);

  let resp: any;
  let attempt = 0;
  // Retry loop: at most 1 retry. We don't retry the main /api/predict prompt
  // a third time because each retry takes seconds and the user is waiting.
  // 250ms + full-jitter backoff on the retry to spread bursts.
  while (true) {
    attempt++;
    try {
      const out = await callGeminiOnce(ai, request);
      resp = out.resp;
      if (attempt > 1) console.log(`  [gemini↻] ${label} succeeded on retry ${attempt}`);
      break;
    } catch (err: any) {
      const latencyMs = Date.now() - t0;
      // OUR client-side timeout: don't retry. The next attempt will hit the
      // same wall and waste the user's time + double the cost. Surface it
      // immediately so the caller knows to fail fast.
      const wasOurTimeout = err?.timedOut === true;
      const retryable = !wasOurTimeout && isRetryableGeminiError(err);
      if (retryable && attempt < 2) {
        const backoff = 250 + Math.floor(Math.random() * 500);
        console.warn(`  [gemini↻] ${label} retryable error (${err?.status || 'no-status'}: ${err?.message || err}); retrying after ${backoff}ms`);
        await new Promise(r => setTimeout(r, backoff));
        continue;
      }
      console.error(`  [gemini✗] ${label} after ${latencyMs}ms (attempt ${attempt})${wasOurTimeout ? ' [OUR TIMEOUT — call exceeded ' + GEMINI_CALL_TIMEOUT_MS + 'ms]' : ''}`);
      console.error(`    message: ${err?.message || err}`);
      if (err?.status)   console.error(`    status:  ${err.status}`);
      if (err?.code)     console.error(`    code:    ${err.code}`);
      if (err?.cause)    console.error(`    cause:   ${err.cause?.message || err.cause}`);
      if (err?.response) console.error(`    response:`, JSON.stringify(err.response).slice(0, 800));
      if (err?.stack)    console.error(`    stack:\n${err.stack}`);
      if (/credential|adc|application default/i.test(String(err?.message || ''))) {
        console.error(`    HINT: this is the ADC fallback. GEMINI_API_KEY was empty/invalid when the SDK initialised. Check boot logs.`);
      }
      throw err;
    }
  }
  const latencyMs = Date.now() - t0;

  const usage = resp.usageMetadata || {};
  const promptTokens = usage.promptTokenCount || 0;
  const outputTokens = usage.candidatesTokenCount || 0;
  const totalTokens  = usage.totalTokenCount || (promptTokens + outputTokens);

  const tokenCost  = (promptTokens / 1_000_000) * PRICE_INPUT_PER_M
                   + (outputTokens / 1_000_000) * PRICE_OUTPUT_PER_M;
  const estCostUSD = tokenCost + (grounded ? PRICE_GROUNDING_PER_QUERY : 0);

  const tel: CallTelemetry = {
    label, latencyMs, promptTokens, outputTokens, totalTokens, estCostUSD, grounded,
  };

  recordSpend(estCostUSD);

  console.log(
    `[gemini] ${label} model=${GEMINI_MODEL} ${latencyMs}ms ` +
    `in=${promptTokens} out=${outputTokens} total=${totalTokens} ` +
    `cost=$${estCostUSD.toFixed(5)}${grounded ? ' [grounded]' : ''} ` +
    `(today=$${spendTracker.totalUSD.toFixed(4)}/${DAILY_USD_CAP.toFixed(2)})`,
  );

  return { resp, tel };
}

// ── Score → Rank: multi-year weighted probabilistic engine ────────────────────
// Sources: PW Live, Careers360, iQuanta, Vedantu, MBBSCouncil.
// To add a new year: append a key to SCORE_RANK_HISTORY + SCORE_RANK_YEAR_META.
// All downstream logic auto-adapts — no other changes needed.

const SCORE_RANK_HISTORY: Record<number, Array<[number, number]>> = {
  2022: [
    [720,1],[715,30],[710,120],[700,400],[690,1000],[680,2500],[670,5500],
    [660,7000],[650,10000],[640,16000],[630,23000],[620,30000],[610,40000],[600,50000],
    [590,62000],[580,75000],[570,92000],[560,105000],[550,125000],[540,145000],
    [520,190000],[500,245000],[480,310000],[450,420000],[400,620000],
    [350,820000],[300,1000000],[200,1250000],[100,1450000],
  ],
  2023: [
    [720,1],[715,20],[710,80],[700,280],[690,700],[680,1500],[670,3000],
    [660,4500],[650,7000],[640,11000],[630,16000],[620,20000],[610,23000],[600,25000],
    [590,33000],[580,42000],[570,52000],[560,65000],[550,80000],[540,95000],
    [520,125000],[500,160000],[480,200000],[450,270000],[400,400000],
    [350,540000],[300,700000],[200,950000],[100,1150000],
  ],
  2024: [
    // NEET 2024 — easier due to grace-marks controversy; high recency, lower reliability
    [720,1],[715,25],[710,100],[700,390],[690,880],[680,1560],[670,2430],
    [660,3500],[650,4760],[640,6220],[630,7870],[620,9720],[610,11760],[600,17000],
    [590,21000],[580,24000],[570,28500],[560,33000],[550,37500],[540,42000],
    [520,58000],[500,78000],[480,100000],[450,134000],[400,194000],
    [350,249000],[300,300000],[200,356000],[100,395000],
  ],
};

// weight = recency preference; reliability = data quality flag (downgrade anomaly years)
// Effective contribution per year = weight × reliability, then normalized across all years
const SCORE_RANK_YEAR_META: Record<number, { weight: number; reliability: number }> = {
  2024: { weight: 0.50, reliability: 0.65 },
  // 2023 reliability dropped from 0.95 → 0.65: our 2023 yearly CSV is missing
  // Round 2 (~1,900–2,100 MBBS rows). The per-round files sum exactly to the
  // 3,525 in the yearly file; only R1, R3, R5_BDS-BSc, and Special Stray were
  // scraped — Round 2 was never captured. Until that gap is backfilled (raw
  // PDF still available at cdnbbsr.s3waas.gov.in/.../2023081882.pdf), the
  // 2023 distribution is biased toward later-round closing ranks. See
  // scripts/data/2023-anomaly.md.
  2023: { weight: 0.35, reliability: 0.65 },
  2022: { weight: 0.20, reliability: 0.90 },
};

// AIR is the single coordinate system used end-to-end. The MCC CSV's
// `closing_rank` column is the AIR (NTA scorecard rank) of the last admitted
// student — verified empirically (e.g. AIIMS Patna OBC R1 closing 1,963 in
// our CSV matches the published AIR ~2,000–2,700 from Shiksha/Careers360).
// Category advantage is reflected in the closing-rank value itself (OBC
// closing AIR > General closing AIR for the same college), not in a
// separate per-student rank conversion. Earlier versions of this file used
// a CATEGORY_POOL_FRACTION multiplier — that introduced systematic bugs
// because it shrank the student's rank into a fake "category rank" and
// compared it against AIR-based closing ranks. Removed.

// Competition grows ~5%/yr → forward-project ranks to the prediction year.
// PREDICTION_YEAR auto-derives: take the next academic intake (current year
// in IST + 1) so the prompt always advises for the upcoming cycle, and never
// goes below latestCutoff + 1 (otherwise growth-projection would invert when
// the CSV is freshly updated).
const COMPETITION_GROWTH_PER_YEAR = 0.05;
const PREDICTION_YEAR = Math.max(
  new Date().getFullYear() + (new Date().getMonth() >= 5 ? 1 : 0),
  LATEST_CUTOFF_YEAR + 1,
);
console.log(`[boot] PREDICTION_YEAR resolved to ${PREDICTION_YEAR} (latestCutoff=${LATEST_CUTOFF_YEAR})`);

// Today as an ISO date (YYYY-MM-DD), evaluated per request so the prompt
// always carries the actual date rather than a stale build-time constant.
function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

// ─── internal: piecewise-linear interpolation for one year's table
function _interpRank(table: Array<[number, number]>, score: number): number {
  for (let i = 0; i < table.length - 1; i++) {
    const [s1, r1] = table[i], [s2, r2] = table[i + 1];
    if (score <= s1 && score >= s2)
      return Math.round(r1 + (s1 - score) / (s1 - s2 || 1) * (r2 - r1));
  }
  return table[table.length - 1][1];
}

interface RankRange {
  // AIR — the single rank value used everywhere. This is the rank as printed
  // on the NTA NEET scorecard. CSV closing ranks are also AIR, so direct
  // comparison is correct. Category advantage is encoded in the closing-rank
  // value itself (OBC closing AIR > General closing AIR), not in a separate
  // per-student rank conversion.
  low: number; mid: number; high: number;
  confidence: string;
}

// ─── public: weighted-average rank + std-dev confidence band + growth drift
function approximateRankRange(score: number, _category: string): RankRange {
  if (!score || score < 1) {
    return { low: 999999, mid: 999999, high: 999999, confidence: 'N/A' };
  }

  const years = Object.keys(SCORE_RANK_HISTORY).map(Number);
  const rawW = years.map(y => { const m = SCORE_RANK_YEAR_META[y]; return m ? m.weight * m.reliability : 0.1; });
  const totalW = rawW.reduce((a, b) => a + b, 0);
  const normW = rawW.map(w => w / totalW);
  const perYearRanks = years.map(y => _interpRank(SCORE_RANK_HISTORY[y], score));

  const mean = perYearRanks.reduce((s, r, i) => s + normW[i] * r, 0);
  const variance = perYearRanks.reduce((s, r, i) => s + normW[i] * (r - mean) ** 2, 0);
  const std = Math.sqrt(variance);

  // Forward-project from latest data year to PREDICTION_YEAR
  const latestDataYear = Math.max(...years);
  const growthFactor = 1 + COMPETITION_GROWTH_PER_YEAR * (PREDICTION_YEAR - latestDataYear);

  const mid  = Math.round(mean * growthFactor);
  const low  = Math.round(Math.max(1, (mean - std) * growthFactor));
  const high = Math.round((mean + std) * growthFactor);

  const cv = std / Math.max(mean, 1);
  const confidence = cv < 0.20 ? 'High' : cv < 0.45 ? 'Medium' : 'Low';
  return { low, mid, high, confidence };
}

// ─── back-compat shim: callers that only need a single-number AIR
function approximateRank(score: number, category: string): number {
  return approximateRankRange(score, category).mid;
}

// ── Normal CDF (tanh approximation) + admission probability ──────────────────

function phi(z: number): number {
  return 0.5 * (1 + Math.tanh(0.7065 * z));
}

// P(student admitted to college with given closing rank), treating student rank as N(mid, σ)
function admissionProbability(
  rankRange: { low: number; mid: number; high: number },
  closingRank: number
): number {
  const sigma = Math.max((rankRange.high - rankRange.low) / 4, 1);
  const z = (closingRank - rankRange.mid) / sigma;
  return Math.min(0.95, Math.max(0.03, parseFloat(phi(z).toFixed(2))));
}

// Compute aggregate P(admission) across quota types from the loaded CSV cutoff data.
//
// WHY the demand discounts exist:
//   avgPct computes "fraction of catalogued seats whose closing rank exceeds student rank" — i.e.
//   what fraction of the seat catalogue is accessible.  That overstates P(securing a seat) because
//   many other students at similar ranks compete for the same seats.  The discount factors convert
//   catalogue-accessibility → realistic seat-securing probability:
//     Govt AIQ: nationwide competition (demand >> supply) → 0.40 discount
//     State quota: state-level competition → 0.70 discount
//     Deemed: much less competitive (management seats, higher fees) → no discount, cap at 90%
//
// Deemed and govt AIQ are intentionally separated because their closing-rank distributions differ
// by a factor of 2–5×; mixing them inflates the AIQ estimate and deflates the deemed estimate.
function computeQuotaProbabilities(
  rankRange: { low: number; mid: number; high: number },
  category: string,
  state: string
): { aiqMbbs: number; stateQuotaMbbs: number; deemedPrivate: number; stateIsEstimated: boolean } {
  const eligible = eligibleCategories(category);

  // Multi-year blend: previously this used only the freshest year, which made
  // the probability estimate noisy when a single year had a one-off shift
  // (e.g. NEET 2024's grace-marks controversy). We blend across all available
  // years with recency weighting matching the SCORE_RANK_YEAR_META pattern —
  // the rank model is multi-year, so the probability model should be too.
  const yearWeight = (y: number): number => {
    const offset = LATEST_CUTOFF_YEAR - y;        // 0 for newest, +1, +2…
    if (offset === 0) return 1.0;
    if (offset === 1) return 0.6;
    if (offset === 2) return 0.3;
    return 0.15;
  };

  const filterRows = (predicate: (r: CutoffRow) => boolean) => {
    const perYear: Array<{ year: number; rows: CutoffRow[] }> = [];
    for (const y of CUTOFF_YEARS) {
      const rows = cutoffsByYear[y].filter(predicate);
      if (rows.length > 0) perYear.push({ year: y, rows });
    }
    return perYear;
  };

  const govtAiqYears = filterRows(r =>
    ALL_INDIA_QUOTAS.has(r.quota) &&
    r.quota !== 'Deemed/Paid Seats Quota' &&
    categoryMatches(r.category, eligible)
  );
  const deemedYears = filterRows(r =>
    r.quota === 'Deemed/Paid Seats Quota' &&
    categoryMatches(r.category, eligible)
  );
  const stateYears = filterRows(r =>
    !ALL_INDIA_QUOTAS.has(r.quota) && categoryMatches(r.category, eligible) &&
    !!r.state && r.state.toLowerCase() === (state || '').toLowerCase()
  );

  // Year-blended average: each year contributes its own avgPct, weighted by
  // recency. Years with 0 matching rows are skipped (would bias toward 0).
  const blendedAvgPct = (perYear: Array<{ year: number; rows: CutoffRow[] }>): number => {
    if (perYear.length === 0) return 0;
    let sumW = 0, sumWP = 0;
    for (const { year, rows } of perYear) {
      const yearAvg = rows.reduce((s, r) => s + admissionProbability(rankRange, r.closingRank), 0) / rows.length;
      const w = yearWeight(year);
      sumW  += w;
      sumWP += w * yearAvg;
    }
    return sumW > 0 ? Math.round((sumWP / sumW) * 100) : 0;
  };

  // Convenience for places further down that still want a per-row count
  // (used for the "stateIsEstimated" / branch-selection signals).
  const govtAiqRows = govtAiqYears.flatMap(y => y.rows);
  const deemedRows  = deemedYears.flatMap(y => y.rows);
  const stateRows   = stateYears.flatMap(y => y.rows);
  const avgPct = (perYear: Array<{ year: number; rows: CutoffRow[] }>) => blendedAvgPct(perYear);

  // YoY drift buffer: closing-rank data is from LATEST_CUTOFF_YEAR (2024).
  // For 2026 predictions, seat expansion (~15-20 new colleges/year) tends to
  // push closing ranks slightly higher (i.e. easier for any given student).
  // A 10% buffer in the student's favor is a conservative, honest correction
  // for stale-anchor data. Compounds linearly with the cutoff staleness gap.
  const cutoffStaleYears = Math.max(0, PREDICTION_YEAR - LATEST_CUTOFF_YEAR);
  const yoyBuffer = 1 + 0.05 * cutoffStaleYears;  // ~10% buffer at 2-year gap

  const govtAiqRaw  = Math.min(100, avgPct(govtAiqYears) * yoyBuffer);
  const deemedRaw   = Math.min(100, avgPct(deemedYears) * yoyBuffer);
  const stateRaw    = Math.min(100, avgPct(stateYears) * yoyBuffer);

  // Three-band rank-aware caps — derived empirically from this CSV.
  // Counted across all 5,264 MBBS AIQ rows: at AIR 1,500 ~95–97% of seats
  // are catalogue-accessible; at AIR 25,000 accessibility crashes to 1–3%
  // for OPEN/OBC/EWS (cliff). Demand discount also varies by tier — toppers
  // have first pick (no real competition pressure), low-rank face thicker
  // contention for the few accessible seats.
  //
  // BUG A FIX: SC/ST have a fundamentally different accessibility curve.
  // At AIR 50K an SC student is competing in their own (much smaller) pool
  // and ~75–89% of SC AIQ seats are still accessible — yet the OPEN-tuned
  // cap (35 at mid, 10 at low) said the opposite. Live test of an SC mid-
  // rank student returned ZERO universities. Per-category cap tables below
  // restore reservation parity. Tier band thresholds are kept in AIR
  // coordinates (the user's actual NEET AIR), not category-rank, because
  // that's what `userAir = rankRange.mid` carries.
  //
  // Each row is [aiqDiscount, aiqCap, stateCap, stateAiqMult, stateCsvMult]
  // for the tier bands [topper (<1500), mid (<25K), low (≥25K)].
  type CapRow = [number, number, number, number, number];
  type CategoryCaps = { topper: CapRow; mid: CapRow; low: CapRow };
  const CAPS_OPEN: CategoryCaps = {
    topper: [0.70, 70, 90, 0.95, 0.95],
    mid:    [0.40, 35, 65, 0.65, 0.70],
    low:    [0.30, 10, 35, 0.55, 0.55],
  };
  const CAPS_OBC: CategoryCaps = {
    topper: [0.72, 72, 90, 0.95, 0.95],
    mid:    [0.50, 50, 70, 0.70, 0.75],
    low:    [0.35, 18, 40, 0.60, 0.60],
  };
  const CAPS_EWS: CategoryCaps = {
    topper: [0.70, 70, 88, 0.93, 0.93],
    mid:    [0.45, 42, 65, 0.68, 0.70],
    low:    [0.32, 14, 35, 0.55, 0.55],
  };
  const CAPS_SC: CategoryCaps = {
    topper: [0.85, 85, 92, 0.95, 0.95],
    mid:    [0.75, 70, 78, 0.78, 0.80],
    low:    [0.55, 40, 55, 0.65, 0.65],
  };
  const CAPS_ST: CategoryCaps = {
    topper: [0.85, 85, 92, 0.95, 0.95],
    mid:    [0.78, 72, 80, 0.80, 0.82],
    low:    [0.55, 40, 55, 0.65, 0.65],
  };
  // PwD subcategories inherit their parent category's row, with a small
  // accessibility bonus because PwD pools are smaller still.
  const pickCaps = (cat: string): CategoryCaps => {
    const c = cat.toUpperCase();
    if (c.startsWith('SC'))  return CAPS_SC;
    if (c.startsWith('ST'))  return CAPS_ST;
    if (c.startsWith('OBC')) return CAPS_OBC;
    if (c.startsWith('EWS')) return CAPS_EWS;
    return CAPS_OPEN;
  };
  const userAir = rankRange.mid;
  const caps = pickCaps(category);
  const tier: keyof CategoryCaps = userAir < 1500 ? 'topper' : (userAir < 25000 ? 'mid' : 'low');
  const [aiqDiscount, aiqCap, stateCap, stateAiqMult, stateCsvMult] = caps[tier];

  const aiq        = Math.min(aiqCap, Math.round(govtAiqRaw * aiqDiscount));
  // State quota: prefer real CSV-derived rows when present; otherwise
  // estimate from AIQ pattern. Both branches now respect the tier cap.
  const stateCalib = stateRows.length > 0
    ? Math.min(stateCap, Math.round(stateRaw * stateCsvMult))
    : Math.min(stateCap, Math.round(govtAiqRaw * stateAiqMult));
  // Deemed: management/private seats are less competitive; admission probability is high
  // Budget is the real gate, not rank — reported separately in prompt
  const deemed      = Math.min(90, deemedRows.length > 0 ? deemedRaw : Math.min(90, govtAiqRaw + 35));

  // Round to integers — percentages should never display with float-precision
  // tails like "24.200000000000003%". The downstream prompt embeds these
  // values directly into the analysis text, so rounding at the source.
  return {
    aiqMbbs:          Math.round(aiq),
    stateQuotaMbbs:   Math.round(stateCalib),
    deemedPrivate:    Math.round(deemed),
    stateIsEstimated: stateRows.length === 0,
  };
}

// ── Category eligibility ─────────────────────────────────────────────────────

function eligibleCategories(userCat: string): Set<string> {
  const c = (userCat || 'OPEN').toUpperCase();
  const out = new Set<string>(['OPEN']);
  if (c.startsWith('OBC')) out.add('OBC');
  if (c.startsWith('SC')) out.add('SC');
  if (c.startsWith('ST')) out.add('ST');
  if (c.startsWith('EWS')) out.add('EWS');
  if (c.includes('PWD')) {
    if (c.startsWith('OPEN')) out.add('OPEN PWD');
    if (c.startsWith('OBC')) { out.add('OBC PWD'); out.add('OPEN PWD'); }
    if (c.startsWith('SC')) { out.add('SC PWD'); out.add('OPEN PWD'); }
    if (c.startsWith('ST')) { out.add('ST PWD'); out.add('OPEN PWD'); }
    if (c.startsWith('EWS')) { out.add('EWS PWD'); out.add('OPEN PWD'); }
  }
  return out;
}

function categoryMatches(rowCategory: string, eligible: Set<string>): boolean {
  // CSV uses "Open"/"OBC"/"SC"/"ST"/"EWS" + " PwD" variants. Normalise both
  // sides — uppercase, collapse whitespace — then exact match against the
  // eligible set. The previous implementation had a bogus "fallback" that
  // re-applied identical normalisation and so never fired.
  const c = rowCategory.toUpperCase().replace(/\s+/g, ' ').trim();
  return eligible.has(c);
}

// ── India predictor ──────────────────────────────────────────────────────────

const ALL_INDIA_QUOTAS = new Set([
  'All India', 'Deemed/Paid Seats Quota', 'Open Seat Quota',
  'IP University Quota', 'Delhi University Quota',
]);
const STATE_DOMICILE_QUOTAS = new Set([
  'Internal -Puducherry UT Domicile',
]);

function isQuotaAccessible(quota: string, userState: string, instState: string): boolean {
  if (ALL_INDIA_QUOTAS.has(quota)) return true;
  if (STATE_DOMICILE_QUOTAS.has(quota) && userState && instState &&
      userState.toLowerCase() === instState.toLowerCase()) return true;
  // NRI / Minority / AMU / JMI quotas: skip by default (special eligibility)
  return false;
}

// Shared tier primitive — both tierName() (single-rank, used by the CSV
// fallback ranker) and deriveTierFromRange() (range, used by the Gemini
// validator) delegate here so the two paths can't drift. NEET semantics:
// LOWER AIR = better student; student gets a seat if rank ≤ closing rank.
//
// Bands:
//   Safe    — comfortably in range (rank ≤ closing × 0.85)
//   Good    — within year-on-year noise (rank ≤ closing × 1.10)
//   Reach   — aspirational with some chance (rank ≤ closing × 1.40)
//   Stretch — unlikely, cutoff must shift significantly (rank ≤ closing × 2.50)
//   null    — past 2.5×, treat as unreachable
const TIER_BANDS = {
  safe:    0.85,
  good:    1.10,
  reach:   1.40,
  stretch: 2.50,
} as const;

function classifyTier(userRank: number, closingRank: number): 'Safe' | 'Good' | 'Reach' | 'Stretch' | null {
  if (userRank <= closingRank * TIER_BANDS.safe)    return 'Safe';
  if (userRank <= closingRank * TIER_BANDS.good)    return 'Good';
  if (userRank <= closingRank * TIER_BANDS.reach)   return 'Reach';
  if (userRank <= closingRank * TIER_BANDS.stretch) return 'Stretch';
  return null;
}

function tierName(userRank: number, closing: number): 'Safe' | 'Good' | 'Reach' | 'Stretch' | null {
  return classifyTier(userRank, closing);
}

function tierOrder(t: string): number {
  return t === 'Safe' ? 0 : t === 'Good' ? 1 : t === 'Reach' ? 2 : 3; // Stretch = 3
}

interface University {
  name: string;
  country: string;
  continent: string;
  annualTuitionFee: string;
  totalProgramCost: string;
  tuitionFeeUSD: number;       // canonical numeric, drives currency toggle
  totalProgramCostUSD: number; // canonical numeric, drives currency toggle
  totalDurationYears: string;
  mediumOfInstruction: string;
  neetRequirement: string;
  nmcRecognitionStatus: string;
  globalRank: string;
  rankingSource: string;
  rankingYear: string;
  clinicalExposure: string;
  safetyAndSupport: string;
  roiScore: string;
  bestFor: string;
  specializations: string[];
  reputationScore: string;
  description: string;
  quota?: string;
  state?: string;          // institute's state — used for backfill domicile match
  tier?: string;
}

// India MBBS fee profiles by quota (rough mid-points, latest available data)
function indiaFeeProfile(quota: string): {
  annualINRRange: string; totalINRRange: string;
  annualINRMid: number; totalINRMid: number;
} {
  // All India (govt + central inst): very low fees; Deemed: high; others: mid
  if (quota === 'All India' || quota === 'Internal -Puducherry UT Domicile') {
    return {
      annualINRRange: '₹15,000 – ₹1,50,000',
      totalINRRange: '₹2L – ₹10L',
      annualINRMid: 80000,
      totalINRMid: 600000,
    };
  }
  if (quota === 'Deemed/Paid Seats Quota') {
    return {
      annualINRRange: '₹18L – ₹28L',
      totalINRRange: '₹1.0Cr – ₹1.6Cr',
      annualINRMid: 2300000,
      totalINRMid: 13000000,
    };
  }
  if (quota === 'Open Seat Quota' || quota === 'Delhi University Quota' || quota === 'IP University Quota') {
    return {
      annualINRRange: '₹1L – ₹6L',
      totalINRRange: '₹6L – ₹35L',
      annualINRMid: 350000,
      totalINRMid: 2000000,
    };
  }
  return {
    annualINRRange: '₹5L – ₹15L',
    totalINRRange: '₹30L – ₹85L',
    annualINRMid: 1000000,
    totalINRMid: 5750000,
  };
}

function inrToUSD(inr: number): number {
  return Math.round(inr / 83.5);
}

type Tier = 'Safe' | 'Good' | 'Reach' | 'Stretch';

function bestForLabel(tier: Tier, quota: string): string {
  const isAIQ    = quota === 'All India';
  const isOpen   = quota === 'Open Seat Quota';      // central institutes (AIIMS, JIPMER etc.)
  const isDeemed = quota === 'Deemed/Paid Seats Quota';
  const isDelhi  = quota === 'IP University Quota' || quota === 'Delhi University Quota';
  const stream   = isOpen ? 'Central Inst · AIQ' : isDeemed ? 'Deemed Seat' : isDelhi ? 'Delhi Quota' : 'Govt AIQ';
  if (tier === 'Safe')    return `Safe · ${stream}`;
  if (tier === 'Good')    return `Good Match · ${stream}`;
  if (tier === 'Reach')   return `Reach · ${isDeemed ? 'Deemed / Competitive' : stream}`;
  return `Stretch · ${isDeemed ? 'Deemed / Last Resort' : 'Last Resort AIQ'}`;
}

function budgetCommentary(profile: any, top: { quota: string }): string {
  const budgetUSD = parseInt(profile.budgetInUSD || '0', 10);
  if (!budgetUSD) {
    return 'No budget specified — recommendations span the full government-to-deemed cost range; narrow the budget to refine matches.';
  }
  const budgetINR = budgetUSD * 83.5;
  if (budgetINR < 1000000) {
    return `Your budget (~₹${(budgetINR / 100000).toFixed(1)}L total) is tight — only government / All India quota seats fit. Deemed seats above are aspirational.`;
  }
  if (budgetINR < 5000000) {
    return `Your ~₹${(budgetINR / 100000).toFixed(0)}L budget covers government, central institutions and the lower band of state private colleges. Deemed seats may exceed budget.`;
  }
  if (budgetINR < 10000000) {
    return `Your ~₹${(budgetINR / 10000000).toFixed(1)}Cr budget comfortably accommodates state private and the lower-tier deemed colleges. Top-tier deemed institutions remain stretch.`;
  }
  return `Your budget is generous — the entire spectrum from government seats to top deemed colleges is in range. Prioritise fit / NIRF rank over cost.`;
}

function nextStepAdvice(safeCount: number, goodCount: number, reachCount: number, stretchCount: number, userRank: number, profile: any): string {
  if (safeCount + goodCount === 0 && stretchCount > 0) {
    return 'Next step: Your profile sits at the edge of MCC AIQ/Deemed cutoffs — actively pursue **state counselling** (home state quota usually has lower cutoffs than AIQ) and consider **MBBS abroad** in Russia / Georgia / Philippines as a parallel option.';
  }
  if (safeCount >= 3) {
    return 'Next step: Multiple safe seats are within reach. Lock in a counselling priority list — rank Safe picks above Good/Reach to avoid stray vacancy slipping. Verify NIRF rank and FMGE pass rates for each.';
  }
  if (reachCount >= 5) {
    return 'Next step: Most picks are aspirational — consider a backup strategy. State counselling and MBBS abroad (Russia/Georgia/Kazakhstan) widen the safety net considerably.';
  }
  return 'Next step: Verify each college\'s 2026 fee notification and NMC recognition status before counselling lock. Set state counselling preference order based on home-state cutoffs.';
}

function buildIndiaUniversity(m: CutoffRow & { tier: Tier }): University {
  const fees = indiaFeeProfile(m.quota);
  const tuitionUSD = inrToUSD(fees.annualINRMid);
  const totalUSD = inrToUSD(fees.totalINRMid);
  const isGov = m.quota === 'All India';
  return {
    name: m.institute,
    country: 'India',
    continent: 'Asia',
    annualTuitionFee: fees.annualINRRange,
    totalProgramCost: fees.totalINRRange,
    tuitionFeeUSD: tuitionUSD,
    totalProgramCostUSD: totalUSD,
    totalDurationYears: '5.5 years (4.5 yr course + 1 yr internship)',
    mediumOfInstruction: 'English',
    neetRequirement: `Closing rank ~${m.closingRank.toLocaleString('en-IN')} (${m.category})`,
    nmcRecognitionStatus: 'NMC Recognized · MCI/NMC Listed',
    globalRank: isGov ? 'India · Govt' : (m.quota === 'Deemed/Paid Seats Quota' ? 'India · Deemed Univ' : 'India · State Private'),
    rankingSource: 'NEET MCC Cutoff',
    rankingYear: '2024',
    clinicalExposure: m.state
      ? `Attached teaching hospital in ${m.state}; high-volume OPD and clinical postings during years 3-4.`
      : 'Attached teaching hospital with high-volume OPD and clinical postings.',
    safetyAndSupport: m.state
      ? `Located in ${m.state}; established Indian student environment, hostel and mess facilities on campus.`
      : 'Established Indian student environment with on-campus hostel/mess facilities.',
    roiScore: m.tier === 'Safe' ? '9' : m.tier === 'Good' ? '8' : m.tier === 'Reach' ? '7' : '6',
    bestFor: bestForLabel(m.tier, m.quota),
    specializations: ['General Medicine', 'Surgery', 'Paediatrics', 'Obstetrics & Gynaecology', 'Orthopaedics'],
    reputationScore: m.tier === 'Safe' ? 'Strong Match' : m.tier === 'Good' ? 'Good Match' : m.tier === 'Reach' ? 'Aspirational' : 'Stretch Backup',
    description: `${m.tier} tier match (latest MCC data). Closing rank ${m.closingRank.toLocaleString('en-IN')} for ${m.category} under ${m.quota}.`,
    quota: m.quota,
    state: m.state || '',          // preserved so backfill can re-verify domicile match
    tier: m.tier,
  };
}

async function predictIndiaCsv(profile: any) {
  const userCategory = (profile.category || 'OPEN').toUpperCase();
  const userState = profile.domicileState || '';
  const userRank = profile.neetRank && profile.neetRank > 0
    ? profile.neetRank
    : approximateRank(profile.neetScore || 0, userCategory);

  const eligible = eligibleCategories(userCategory);
  const cutoffs = LATEST_CUTOFF_ROWS;
  // Drop women-only seats for male / unspecified students. The CSV labels
  // these in the institute string itself ("(Female Seat only)", "for women",
  // "Lady Hardinge"). For 2024 alone there are 66+ such rows; without this
  // filter a male student is silently shown a closing rank he can never
  // actually reach (the LHMC leak that the verifier was supposed to block
  // but only blocks on the Gemini path, not the CSV-fallback path).
  const userGender = String(profile.gender || '').toLowerCase();
  const filterWomenOnly = userGender !== 'female';

  // Group by (institute, quota, category) → keep min closing rank
  const groups = new Map<string, CutoffRow>();
  for (const r of cutoffs) {
    if (!isQuotaAccessible(r.quota, userState, r.state)) continue;
    if (!categoryMatches(r.category, eligible)) continue;
    if (filterWomenOnly && isFemaleOnlyInstitute(r.institute)) continue;
    const key = `${r.institute}||${r.quota}||${r.category}`;
    const ex = groups.get(key);
    if (!ex || r.closingRank < ex.closingRank) groups.set(key, r);
  }

  // Budget guard: include deemed/private seats unless they're far out of reach.
  // Govt vs non-govt is NOT our concern — best fit for the student is. The old
  // hard ₹50L threshold excluded deemed for any "₹40-60L" budget student even
  // though deemed colleges start around ₹50L (well within reach when the upper
  // bound is ₹60L). Soft floor at ₹35L lets borderline students see deemed
  // options with full cost transparency; they decide if they can stretch to it.
  const budgetUSD = parseInt(profile.budgetInUSD || '0', 10);
  const budgetINR = budgetUSD > 0 ? Math.round(budgetUSD * 83.5) : 0;
  const deemedEligible = budgetUSD === 0 || budgetINR >= 3_500_000;

  const allEligible = [...groups.values()].filter(r =>
    deemedEligible || r.quota !== 'Deemed/Paid Seats Quota'
  );

  // ── Pass A: strict tier match ──
  const tieredA: Array<CutoffRow & { tier: Tier }> = [];
  for (const g of allEligible) {
    const t = tierName(userRank, g.closingRank);
    if (t) tieredA.push({ ...g, tier: t as Tier });
  }

  // Dedupe by institute, prefer best tier / lowest closing
  function dedupeByInstitute<T extends CutoffRow & { tier: Tier }>(arr: T[]): T[] {
    const map = new Map<string, T>();
    for (const m of arr) {
      const ex = map.get(m.institute);
      if (!ex ||
          tierOrder(m.tier) < tierOrder(ex.tier) ||
          (tierOrder(m.tier) === tierOrder(ex.tier) && m.closingRank < ex.closingRank)) {
        map.set(m.institute, m);
      }
    }
    return [...map.values()];
  }

  let picks = dedupeByInstitute(tieredA);

  // ── Pass B: stretch fallback — within 3× of the closing rank ──
  // tierName returns null beyond 2.5×; Pass B widens to 3× as honest stretch.
  // Anything beyond 3× is mathematically out of reach — better to return a
  // short list than to pad with rows the student literally cannot get.
  if (picks.length < 10) {
    const usedInstitutes = new Set(picks.map(p => p.institute));
    const passB: Array<CutoffRow & { tier: Tier }> = [];
    for (const g of allEligible) {
      if (usedInstitutes.has(g.institute)) continue;
      if (userRank <= g.closingRank * 3.0) {
        passB.push({ ...g, tier: 'Stretch' });
      }
    }
    // Prefer the most accessible (highest closing rank) among these last-resort picks
    const passBDedup = dedupeByInstitute(passB)
      .sort((a, b) => b.closingRank - a.closingRank);
    picks = picks.concat(passBDedup.slice(0, 10 - picks.length));
  }

  // ── Pass C removed: it previously returned ANY college sorted by highest
  // closing rank, ignoring student rank entirely. For an OPEN student at
  // AIR 200,000, that surfaced govt MBBS seats with closing AIR ~17,000 as
  // "Stretch" — 9× worse than the closing, mathematically impossible.
  // Honest short list > deceptive padded list. If picks < 5 the calling
  // path (validator backfill / student message) will surface a "consider
  // deemed / abroad / AYUSH state counselling" recommendation instead.

  // Final sort: Safe → Good → Reach → Stretch, then closing_rank asc
  picks.sort((a, b) => {
    const t = tierOrder(a.tier) - tierOrder(b.tier);
    if (t !== 0) return t;
    return a.closingRank - b.closingRank;
  });

  const top10 = picks.slice(0, 10);
  const universities: University[] = top10.map(buildIndiaUniversity);

  const safeCount    = universities.filter(u => u.tier === 'Safe').length;
  const goodCount    = universities.filter(u => u.tier === 'Good').length;
  const reachCount   = universities.filter(u => u.tier === 'Reach').length;
  const stretchCount = universities.filter(u => u.tier === 'Stretch').length;

  // Estimate percentile crudely from rank (assume ~2M total candidates)
  const TOTAL_CANDIDATES = 2400000;
  const percentile = Math.max(0.01, Math.min(99.99, 100 * (1 - userRank / TOTAL_CANDIDATES))).toFixed(2);

  const top = top10[0];
  const lines: string[] = [];
  lines.push(`Estimated AIR rank: ${userRank.toLocaleString('en-IN')} (~${percentile} percentile, ${userCategory}).`);
  lines.push(`Tier mix: ${safeCount} safe, ${goodCount} good, ${reachCount} reach, ${stretchCount} stretch picks across ${universities.length} colleges (latest MCC cutoff data).`);
  if (top) {
    lines.push(`Top recommendation: ${top.institute}${top.state ? ` (${top.state})` : ''} — ${top.tier} tier, closing rank ${top.closingRank.toLocaleString('en-IN')} for ${top.category} under ${top.quota}.`);
  }
  lines.push(budgetCommentary(profile, top));
  lines.push(nextStepAdvice(safeCount, goodCount, reachCount, stretchCount, userRank, profile));

  return {
    universities,
    analysis: universities.length === 0
      ? `Estimated AIR rank: ${userRank.toLocaleString('en-IN')} (${userCategory}). No matches found in MCC AIQ + Deemed cutoffs at this rank — your home-state counselling and MBBS abroad are likely the realistic paths. Consider Russia / Georgia / Philippines for affordable NMC-recognised options.`
      : lines.join(' '),
  };
}

// ── India predictor: hybrid Gemini + CSV ────────────────────────────────────

// Quota-bucketed nearest-rank context. The previous implementation took the
// 25 rows closest to the user's rank without quota guardrails — at certain
// rank bands that returned 25 deemed-only or 25 same-state rows, giving the
// model a misleading anchor density. Now we pick the nearest N from each of
// {AIQ, Deemed, State} so the prompt always shows a balanced picture.
// Filter-first anchor extractor. Applies ALL the student's hard constraints
// at fetch time — rank reachability, category eligibility, state-quota
// domicile match, budget cap, gender, course preference. Returns up to ~30
// rows with a balanced tier mix. Becomes the authoritative pool that Gemini
// picks from, instead of Gemini generating from training knowledge and
// having the validator reactively drop the mismatches.
//
// Rationale (user feedback 2026-04-28): "Gemini should first consider the
// constraints… and based on that fetch the universities. CSV records which
// pass the filters can be used as few-shot. Gemini will fetch the best fit."
type AnchorRow = CutoffRow & { _tier: 'Safe'|'Good'|'Reach'|'Stretch'; _typicalCostINR: number };

function extractEligibleAnchors(
  rankRange: { low: number; mid: number; high: number; confidence?: string },
  userCategory: string,
  domicileState: string,
  budgetINR: number,
  gender: string,
  coursePrefs: string[],
): { rows: AnchorRow[]; summary: string } {
  const eligible = eligibleCategories(userCategory);
  const userMid = rankRange.mid;
  const userHigh = rankRange.high;   // worst case (highest AIR)
  const userLow = rankRange.low;     // best case (lowest AIR)
  const filterWomenOnly = String(gender || '').toLowerCase() !== 'female';
  const userDomicileNorm = normalizeName(domicileState);

  const deemedAllowed = budgetINR === 0 || budgetINR >= 3_500_000;
  const budgetCap = budgetINR > 0 ? budgetINR * 1.5 : Number.POSITIVE_INFINITY;
  const tierOf = (closing: number): AnchorRow['_tier'] | null => {
    // NEET semantics: lower AIR = better student. Student gets the seat if
    // their AIR ≤ closing AIR. So:
    //   Safe   = student's WORST case (high) clears the closing comfortably
    //   Good   = student's mid clears the closing
    //   Reach  = student's BEST case (low) clears the closing — only just
    //   Stretch = student is up to 1.5× worse than closing (mop-up round)
    //   Drop   = student's best case is > 1.5× the closing → unreachable
    //   Drop   = closing > student.high × 2.5 → trivially safe, wastes slot
    if (closing > userHigh * 2.5) return null;
    if (userHigh <= closing * 0.85) return 'Safe';
    if (userMid  <= closing)         return 'Good';
    if (userLow  <= closing)         return 'Reach';
    if (userLow  <= closing * 1.5)   return 'Stretch';
    return null;                                                        // out of reach
  };

  const matches: AnchorRow[] = [];
  for (const r of LATEST_CUTOFF_ROWS) {
    if (!categoryMatches(r.category, eligible)) continue;
    if (filterWomenOnly && isFemaleOnlyInstitute(r.institute)) continue;

    // Quota accessibility: AIQ + Deemed + Delhi/IP/Open are profile-agnostic;
    // anything else is a state-domicile quota and must match the student.
    const profileAgnostic = ALL_INDIA_QUOTAS.has(r.quota)
      || r.quota === 'Open Seat Quota'
      || r.quota === 'IP University Quota'
      || r.quota === 'Delhi University Quota';
    if (!profileAgnostic) {
      const rState = normalizeName(r.state || '');
      if (!rState || !userDomicileNorm || rState !== userDomicileNorm) continue;
    }

    if (r.quota === 'Deemed/Paid Seats Quota' && !deemedAllowed) continue;

    const t = tierOf(r.closingRank);
    if (!t) continue;

    const fee = indiaFeeProfile(r.quota);
    if (fee.totalINRMid > budgetCap) continue;

    const inferred = inferCourseFromName(r.institute);
    if (!isCourseAllowed(inferred, coursePrefs)) continue;

    matches.push({ ...r, _tier: t, _typicalCostINR: fee.totalINRMid });
  }

  // Dedupe by institute — keep the best (lowest tier ord, lowest closing).
  const tierOrd: Record<string, number> = { Safe: 0, Good: 1, Reach: 2, Stretch: 3 };
  const byInst = new Map<string, AnchorRow>();
  for (const m of matches) {
    const ex = byInst.get(m.institute);
    if (!ex
        || tierOrd[m._tier] < tierOrd[ex._tier]
        || (tierOrd[m._tier] === tierOrd[ex._tier] && m.closingRank < ex.closingRank)) {
      byInst.set(m.institute, m);
    }
  }

  const sorted = [...byInst.values()].sort((a, b) => {
    const t = tierOrd[a._tier] - tierOrd[b._tier];
    if (t !== 0) return t;
    return a.closingRank - b.closingRank;
  });

  // Balanced tier mix capped at ~30 rows total — Gemini's input budget stays compact.
  const pickN = (tier: AnchorRow['_tier'], n: number) =>
    sorted.filter(r => r._tier === tier).slice(0, n);
  const safe    = pickN('Safe',    6);
  const good    = pickN('Good',   10);
  const reach   = pickN('Reach',   8);
  const stretch = pickN('Stretch', 6);
  const rows = [...safe, ...good, ...reach, ...stretch];

  return {
    rows,
    summary: `${rows.length} eligible MCC anchors (${safe.length} Safe, ${good.length} Good, ${reach.length} Reach, ${stretch.length} Stretch)`,
  };
}

function extractContextRows(userRank: number, category: string, state: string, limit = 25): string {
  const eligible = eligibleCategories(category);
  const cutoffs = LATEST_CUTOFF_ROWS;
  const matching = cutoffs.filter(r =>
    isQuotaAccessible(r.quota, state, r.state) && categoryMatches(r.category, eligible)
  );
  if (matching.length === 0) {
    return `No matching rows found in MCC ${LATEST_CUTOFF_YEAR} cutoff data.`;
  }

  const distance = (r: CutoffRow) => Math.abs(r.closingRank - userRank);
  const aiq    = matching.filter(r => ALL_INDIA_QUOTAS.has(r.quota) && r.quota !== 'Deemed/Paid Seats Quota');
  const deemed = matching.filter(r => r.quota === 'Deemed/Paid Seats Quota');
  const stateRows = matching.filter(r =>
    r.state && state && r.state.toLowerCase() === state.toLowerCase() && !ALL_INDIA_QUOTAS.has(r.quota)
  );

  // Aim for roughly 60/30/10 mix (AIQ/Deemed/State) but flex if a bucket is
  // empty so we still hit `limit`. AIQ is the dominant decision surface, so
  // it gets the largest share of the prompt's anchor budget.
  const aiqQuota    = Math.round(limit * 0.60);
  const deemedQuota = Math.round(limit * 0.30);
  const stateQuota  = limit - aiqQuota - deemedQuota;

  const pickNearest = (rows: CutoffRow[], n: number) =>
    rows.slice().sort((a, b) => distance(a) - distance(b)).slice(0, n);

  const picks: CutoffRow[] = [];
  picks.push(...pickNearest(aiq,       aiqQuota));
  picks.push(...pickNearest(deemed,    deemedQuota));
  picks.push(...pickNearest(stateRows, stateQuota));

  // If buckets came up short (e.g. no state rows for this state in CSV),
  // backfill with overall nearest rows from the matching pool, deduped.
  if (picks.length < limit) {
    const seen = new Set(picks.map(r => `${r.institute}|${r.quota}|${r.category}`));
    const extras = matching
      .filter(r => !seen.has(`${r.institute}|${r.quota}|${r.category}`))
      .sort((a, b) => distance(a) - distance(b))
      .slice(0, limit - picks.length);
    picks.push(...extras);
  }

  // Final ordering: by distance to user rank, so closest rows lead the prompt.
  picks.sort((a, b) => distance(a) - distance(b));

  return picks.map(r =>
    `${r.institute} | ${r.state || '?'} | ${r.quota} | ${r.category} | closing_rank_${LATEST_CUTOFF_YEAR}:${r.closingRank}`
  ).join('\n');
}

// ── State quota verification (grounded Gemini call) ─────────────────────────
// MCC CSV has zero state-quota rows — state quota is managed by each state's
// own counselling cell. This second call uses Google Search grounding to fill
// that data gap. Runs in parallel with the main recommendation call so it adds
// no extra latency. Falls back to null silently if it errors out.

interface StateQuotaCollege {
  name: string;
  city: string;
  closingRank2024: number | null;
  closingRank2025: number | null;
  categoryAdmitted: string;
  accessTier: 'Safe' | 'Good' | 'Reach' | 'Stretch';
  notes: string;
}

interface StateQuotaInsights {
  stateColleges: StateQuotaCollege[];
  summary: string;
  sources: string[];
}

async function verifyStateQuota(
  ai: GoogleGenAI,
  rankRange: RankRange,
  userCategory: string,
  state: string,
  gender: string,
): Promise<StateQuotaInsights | null> {
  if (!state || state === 'not specified') return null;

  // The verifier compares student AIR (the rank on the NTA scorecard) to
  // the AIR of the last admitted student in the relevant quota+category.
  // Public sources (Shiksha, Careers360, CollegeDunia, MCC) all publish
  // closing ranks in AIR form. One coordinate system, no conversion.
  // Gender is passed through so women-only colleges get filtered for
  // Male / unspecified visitors (B.2 — the LHMC-leak fix).
  const prompt = fillTemplate(PROMPTS.india.stateQuotaVerification, {
    today: todayISO(),
    rankRangeLow:  rankRange.low.toLocaleString('en-IN'),
    rankRangeMid:  rankRange.mid.toLocaleString('en-IN'),
    rankRangeHigh: rankRange.high.toLocaleString('en-IN'),
    userCategory,
    state,
    gender,
  });

  try {
    // Grounding cannot be combined with responseSchema in the Gemini API,
    // so we instruct the model to return raw JSON and parse manually.
    const { resp } = await callGemini(ai, `verifyStateQuota[${state}]`, {
      contents: prompt,
      config: { tools: [{ googleSearch: {} }] },
    }, /* grounded */ true);

    const text = (resp.text || '').trim();
    const parsed = extractJsonObject(text) as StateQuotaInsights | null;
    if (!parsed) {
      console.warn(`[verifyStateQuota:${state}] could not extract JSON from response (${text.length} chars) — preview:`, text.slice(0, 200));
      return null;
    }
    console.log(`[verifyStateQuota] ${state}: ${parsed.stateColleges?.length || 0} colleges, ${parsed.sources?.length || 0} sources`);
    return parsed;
  } catch (err: any) {
    console.error(`[verifyStateQuota:${state}] FAILED:`, err?.message || err);
    if (err?.stack) console.error(err.stack);
    if (err?.response) console.error('  response:', JSON.stringify(err.response).slice(0, 800));
    return null;
  }
}

// ── Abroad universities anchor data ──────────────────────────────────────────
// 45 manually-curated universities (Russia/Georgia/Kyrgyzstan/Hungary/etc.)
// extracted from MBBS.xlsx via scripts/extract-abroad.py. Same role as the
// MCC CSV plays for India: ground-truth context that the LLM anchors on
// instead of fully relying on grounded search. Loaded once at startup.

interface AbroadUni {
  source: string;                       // 'vyom_sir' | 'russia_univ' | 'neethu_mam'
  nameOfTheUniversity?: string;
  country?: string;
  city?: string;
  publicPrivateUniversity?: string;
  recognitionByNmc?: string;
  recognitionByWho?: string;
  ecfmgEligibility?: string;
  wfmeAccreditation?: string;
  courseDuration?: string;
  mediumOfInstruction?: string;
  neetRequirement?: string;
  tuitionFeePerYear?: string;
  tuitionFeePerYear_num?: number;
  totalProgramCost?: string;
  totalProgramCost_num?: number;
  hostelFeePerYear?: string;
  hostelFeePerYear_num?: number;
  fmgeNextPassingPercentage?: string;
  fmgeNextPassingPercentage_num?: number;
  numberOfIndianStudents?: string;
  numberOfIndianStudents_num?: number;
  indianFoodMessAvailability?: string;
  globalRecognitionScore_num?: number;
  costIndex_num?: number;
  roiScore_num?: number;
  safetyIndex_num?: number;
  admissionDifficultyScore_num?: number;
  [k: string]: any;
}

function loadAbroadUnis(): AbroadUni[] {
  const path = join(ROOT, 'data', 'abroad', 'universities.json');
  if (!existsSync(path)) {
    console.log('[abroad] universities.json missing — abroad runs grounded-only');
    return [];
  }
  try {
    const json = JSON.parse(readFileSync(path, 'utf-8'));
    const list = Array.isArray(json?.universities) ? json.universities : [];
    console.log(`[abroad] loaded ${list.length} anchor universities`);
    return list;
  } catch (e: any) {
    console.error('[abroad] failed to load universities.json:', e?.message || e);
    return [];
  }
}

const ABROAD_UNIS = loadAbroadUnis();

// Reference-data compile date for the abroad anchor file. Derived from the
// JSON file's mtime so the prompt always carries the actual freshness of the
// dataset — no more hardcoded 'April 2026' strings to forget on re-extract.
// Format: "April 2026" (Month YYYY) so it reads naturally inside the prompt.
const ABROAD_REFERENCE_DATE = (() => {
  const path = join(ROOT, 'data', 'abroad', 'universities.json');
  if (!existsSync(path)) return 'unknown';
  try {
    const m = statSync(path).mtime;
    const months = ['January', 'February', 'March', 'April', 'May', 'June',
                    'July', 'August', 'September', 'October', 'November', 'December'];
    return `${months[m.getMonth()]} ${m.getFullYear()}`;
  } catch {
    return 'unknown';
  }
})();
console.log(`[abroad] reference date (file mtime): ${ABROAD_REFERENCE_DATE}`);

// Run data integrity audit now that abroad + India + quota constants are all
// loaded. Single block of structured warnings — non-fatal.
validateDataIntegrityAtBoot();

// Filter abroad anchor rows down to a relevant subset for prompt injection.
// Rules:
//   1. If user listed preferredCountries → restrict to those (case-insensitive).
//   2. If user gave budgetInUSD → prefer unis with totalProgramCost ≤ budget×1.3
//      (30% slack so we don't hide near-budget options).
//   3. Cap at MAX_ROWS so the prompt stays compact (45 unis × 72 fields would
//      blow the input-token budget).
//   4. Always preserve diversity: at least 1 row per country in the candidate
//      set, even if budget excludes others.
function filterAbroadAnchors(profile: any): AbroadUni[] {
  if (ABROAD_UNIS.length === 0) return [];

  const MAX_ROWS = 18;
  const wantCountries: Set<string> = new Set(
    (profile.preferredCountries || []).map((c: string) => String(c).toLowerCase().trim()),
  );
  const budget = Number(profile.budgetInUSD) || 0;

  let pool = ABROAD_UNIS.slice();

  if (wantCountries.size > 0) {
    pool = pool.filter(u => wantCountries.has(String(u.country || '').toLowerCase().trim()));
  }

  if (budget > 0) {
    // Soft filter — don't drop unis missing total_num, treat them as eligible.
    const slack = budget * 1.3;
    pool = pool.filter(u => !u.totalProgramCost_num || u.totalProgramCost_num <= slack);
  }

  // If filtering left us with too few, fall back to the full list (still
  // respecting country preference if any matched at all).
  if (pool.length < 6) {
    pool = wantCountries.size > 0
      ? ABROAD_UNIS.filter(u => wantCountries.has(String(u.country || '').toLowerCase().trim()))
      : ABROAD_UNIS.slice();
  }

  // Sort: NMC=Yes first, then by costIndex (cheaper first if available),
  // then by globalRecognitionScore (better-known first).
  pool.sort((a, b) => {
    const an = /^yes/i.test(String(a.recognitionByNmc || '')) ? 0 : 1;
    const bn = /^yes/i.test(String(b.recognitionByNmc || '')) ? 0 : 1;
    if (an !== bn) return an - bn;
    const ac = a.totalProgramCost_num ?? 1e9;
    const bc = b.totalProgramCost_num ?? 1e9;
    if (ac !== bc) return ac - bc;
    const ar = a.globalRecognitionScore_num ?? 0;
    const br = b.globalRecognitionScore_num ?? 0;
    return br - ar;
  });

  // Diversity guarantee: ensure at least one row per country in the top-N
  // before we truncate (so a budget-shopper still sees Hungary even if Russia
  // dominates the cheap end).
  const seen = new Set<string>();
  const diverse: AbroadUni[] = [];
  const rest: AbroadUni[] = [];
  for (const u of pool) {
    const c = String(u.country || '').toLowerCase().trim();
    if (!seen.has(c)) { seen.add(c); diverse.push(u); }
    else rest.push(u);
  }
  return [...diverse, ...rest].slice(0, MAX_ROWS);
}

// Render anchor rows as compact pipe-delimited lines. The model reads these as
// authoritative — it should not invent fees that contradict these strings.
function formatAbroadContext(rows: AbroadUni[]): string {
  if (rows.length === 0) return '(no anchor data — use grounded knowledge only)';
  return rows.map(u => {
    const name   = u.nameOfTheUniversity || u.name || 'Unknown';
    const fields = [
      u.country,
      u.city,
      u.publicPrivateUniversity ? `Type: ${u.publicPrivateUniversity}` : null,
      u.recognitionByNmc      ? `NMC: ${u.recognitionByNmc}` : null,
      u.mediumOfInstruction   ? `Medium: ${u.mediumOfInstruction}` : null,
      u.tuitionFeePerYear     ? `Tuition: ${u.tuitionFeePerYear}` : null,
      u.totalProgramCost      ? `Total: ${u.totalProgramCost}` : null,
      u.fmgeNextPassingPercentage ? `FMGE: ${u.fmgeNextPassingPercentage}` : null,
      u.numberOfIndianStudents    ? `IndianStudents: ${u.numberOfIndianStudents}` : null,
      u.indianFoodMessAvailability ? `IndianFood: ${u.indianFoodMessAvailability}` : null,
    ].filter(Boolean).join(' | ');
    return `- ${name} | ${fields}`;
  }).join('\n');
}

// ── Abroad verifier (grounded) ───────────────────────────────────────────────
// Parallel grounded call alongside predictAbroad.main. Same shape as
// verifyStateQuota: returns null on failure so the main result still ships.
// Catches the gap our static dataset can't: NMC status changes, geopolitical
// advisories, and recently-derecognised universities.

interface AbroadVerifierCollege {
  name: string;
  country: string;
  nmcStatus: string;
  fmgeRecentRate: string | null;
  travelAdvisory: string | null;
  notes: string;
}

interface AbroadInsights {
  flaggedColleges: AbroadVerifierCollege[];
  generalAdvisory: string;
  sources: string[];
}

async function verifyAbroad(
  ai: GoogleGenAI,
  profile: any,
  candidates: AbroadUni[],
): Promise<AbroadInsights | null> {
  if (candidates.length === 0) return null;

  const candidateNames = candidates.slice(0, 12)
    .map(u => `${u.nameOfTheUniversity || u.name} (${u.country})`)
    .join(', ');
  const countries = Array.from(new Set(candidates.map(u => u.country).filter(Boolean))).join(', ');

  const prompt = fillTemplate(PROMPTS.abroad.verifyAbroad, {
    today: todayISO(),
    candidateNames,
    countries,
  });

  try {
    const { resp } = await callGemini(ai, 'verifyAbroad', {
      contents: prompt,
      config: { tools: [{ googleSearch: {} }] },
    }, /* grounded */ true);

    const text = (resp.text || '').trim();
    const parsed = extractJsonObject(text) as AbroadInsights | null;
    if (!parsed) {
      console.warn(`[verifyAbroad] could not extract JSON from response (${text.length} chars) — preview:`, text.slice(0, 200));
      return null;
    }
    console.log(`[verifyAbroad] flagged ${parsed.flaggedColleges?.length || 0} colleges, ${parsed.sources?.length || 0} sources`);
    return parsed;
  } catch (err: any) {
    console.error('[verifyAbroad] FAILED:', err?.message || err);
    if (err?.stack) console.error(err.stack);
    if (err?.response) console.error('  response:', JSON.stringify(err.response).slice(0, 800));
    return null;
  }
}

// ── India tier validator (Stage 1 of Pro hybrid) ─────────────────────────────
// Code-level safety net for the AIIMS-Safe-at-AIR-500 bug class. The mechanical
// tier gate currently lives in prompts.json (india.main text); this layer
// enforces the same logic in code so a model that rationalizes past the prompt
// instruction can't ship a wrong tier to the user.
//
// Stage 1 (this code): runs against current Flash output. Schema includes
// expectedClosingAirLow/High (numeric AIR claim) so the validator can compare
// against student rankRange without parsing free text.
//
// Stage 2 (deferred): same validator, but selection model swaps to
// gemini-3.1-pro-preview and narrative writing splits to Flash. Validator
// itself is model-agnostic.

interface ValidationResult {
  validated: any[];
  drops:      { name: string; reason: string }[];
  overrides:  { name: string; from: string; to: string; reason: string }[];
  skipped:    { name: string; reason: string }[];
  backfilled: number;
}

// Asymmetric drop thresholds — see plan rationale. The "tooEasy" direction
// (model claims an easier college than reality) is more harmful: student
// plans around a seat they can't get. The "tooHard" direction is a missed
// opportunity but doesn't create false hope.
//
// SCALE-AWARE: a fixed multiplier is wrong because closing-rank noise grows
// with the rank itself. AIIMS Delhi at AIR ~50 vs claimed ~80 is a perfectly
// valid forward estimate (1.6x), but a flat 1.5x cap drops it as
// "hallucinated". Conversely, a deemed college closing AIR 200,000 vs claimed
// 300,000 is well within YoY noise. We pick thresholds by the rank tier of
// the CSV anchor itself.
function halluTooEasyMult(csvRank: number): number {
  if (csvRank < 500)    return 2.5;   // toppers — wide claims OK at the elite end
  if (csvRank < 5000)   return 2.0;   // mid AIQ — moderate slack
  if (csvRank < 50000)  return 1.7;
  return 1.5;                          // low band — claims should hug the CSV
}
function halluTooHardMult(csvRank: number): number {
  if (csvRank < 500)    return 0.20;  // toppers — claiming AIIMS at AIR 10 (5x stricter than 50) is suspect
  if (csvRank < 5000)   return 0.30;
  if (csvRank < 50000)  return 0.40;
  return 0.50;                          // low band — tighter strict-side
}

// Topper exception — preserves prompts.india.topperBlock invariant: AIR<1500
// must see at least one of {AIIMS Delhi, AIIMS Bombay, AIIMS Jodhpur}. Even if
// the student's AIR is mathematically past these closing ranks, drop-then-
// promote-to-Stretch keeps the topper map intact.
const TOPPER_EXEMPT_INSTITUTES = [
  'aiims delhi', 'all india institute of medical sciences delhi',
  'aiims bombay', 'aiims mumbai',
  'aiims jodhpur',
];

function normalizeName(s: string): string {
  return String(s || '').toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Token-prefix match — true if `a` and `b` share the first 3 significant
// tokens (after normalization), or one is a strict prefix of the other.
// Catches "Madras Medical College, Chennai" (Gemini) ≈ "MADRAS MEDICAL"
// (CSV) so backfill dedup actually works.
function namesMatchLoose(a: string, b: string): boolean {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.startsWith(nb + ' ') || nb.startsWith(na + ' ')) return true;
  const ta = na.split(' ').filter(t => t.length > 1).slice(0, 3).join(' ');
  const tb = nb.split(' ').filter(t => t.length > 1).slice(0, 3).join(' ');
  return !!ta && ta === tb;
}

// Female-only institutions in the MCC CSV. Two patterns:
//  (1) the institute string explicitly tags a female-only seat (the MCC
//      annotation "(Female Seat only)" appears on 60+ rows in 2024 alone).
//  (2) the college is structurally women-only — Lady Hardinge MC Delhi,
//      ESIC PGIMSR Basaidarapur (women's wing), Government Medical College
//      for Women (Khazipally, Salem), BPS GMCW Sonepat, etc.
// A male student or one with no gender stated should not see these as
// reachable — even when the CSV has an "Open" category row, the seat is
// gender-restricted and our predicted "you can clear this" is wrong.
const FEMALE_ONLY_INSTITUTE_PATTERNS = [
  /\(female seat only\)/i,
  /\bfor women\b/i,
  /\bwomen[' ]s? medical\b/i,
  /\blady hardinge\b/i,
  /\bgmcw\b/i,
];
function isFemaleOnlyInstitute(name: string): boolean {
  if (!name) return false;
  return FEMALE_ONLY_INSTITUTE_PATTERNS.some(p => p.test(name));
}

// Map quotaSlot label to CSV quota convention. CSV uses "All India",
// "Deemed/Paid Seats Quota", etc. — model returns shorthand "AIQ", "Deemed".
//
// The 'state' slot was previously returning an empty set, which made
// findCsvAnchor permissively match across ALL quota labels and pick the
// lowest-closing row regardless of quota — for MAMC/VMMC (Delhi-domiciled
// state colleges in CSV under "Delhi University Quota" with closing AIR
// ~329) this caused Gemini's correct OBC State claim of ~920 to be flagged
// as "tooEasy" against a 329 anchor and dropped. Every Delhi topper saw
// MAMC/VMMC vanish from their list.
//
// Now: 'state' enumerates all state-domicile / institution-specific quota
// labels actually present in the 2024 CSV. NRI and ESI get their own
// slots so the validator can anchor against quota-matched rows precisely.
function csvQuotaForSlot(slot: string): Set<string> {
  const s = String(slot || '').toLowerCase();
  if (s === 'aiq' || s === 'aiims') return new Set(['All India']);
  if (s === 'deemed') return new Set(['Deemed/Paid Seats Quota']);
  if (s === 'state') return new Set([
    'Open Seat Quota',
    'Delhi University Quota',
    'IP University Quota',
    'Delhi NCR Children/Widows of Personnel of the Armed Forces (CW) Quota',
    'Internal -Puducherry UT Domicile',
    'Internal - Puducherry UT Domicile',
    'Muslim Minority Quota',
    'Aligarh Muslim University (AMU) Quota',
    'Jain Minority Quota',
  ]);
  if (s === 'nri') return new Set(['Non-Resident Indian', 'Non-Resident Indian(AMU)Quota']);
  if (s === 'management') return new Set(['Deemed/Paid Seats Quota']);  // management seats live under Deemed
  return new Set([]);
}

// Find the matching CSV row for hallucination check. Match on:
//   institute name (substring either direction, normalized)
//   quota (loose match via csvQuotaForSlot)
//   category (substring match — CSV "Open"/"OBC"/"SC"/"ST"/"EWS")
// Returns the lowest-closingRank row when multiple match (most competitive).
// Token-based name match. The previous implementation used substring-either-
// direction which made "AIIMS" match every AIIMS row in the CSV — picking the
// lowest-closing one (AIIMS Delhi) and using it as the anchor for AIIMS Patna,
// AIIMS Bhopal, AIIMS Rishikesh, etc. That created false-positive
// hallucination drops where a perfectly valid "AIIMS Patna at AIR ~2,500" got
// compared against AIIMS Delhi's ~50 closing.
//
// New rule: tokenize both names, require ALL tokens of the shorter name to
// appear in the longer name's token set, AND require the length ratio to be
// within 2x (so "AIIMS" alone doesn't match "AIIMS Delhi" — too short
// relative to the row, ambiguous). For multi-token rows, this means the
// model's "AIIMS Delhi" matches a CSV row containing "All India Institute Of
// Medical Sciences Delhi" only when both share at least the location token.
function nameMatches(modelName: string, csvName: string): boolean {
  const a = modelName.split(/\s+/).filter(Boolean);
  const b = csvName.split(/\s+/).filter(Boolean);
  if (a.length === 0 || b.length === 0) return false;
  // Length ratio guard — "aiims" (1 token) vs "all india institute of medical
  // sciences delhi" (7 tokens) is too lopsided to be a confident match.
  const shorter = a.length <= b.length ? a : b;
  const longer  = a.length <= b.length ? b : a;
  if (longer.length > shorter.length * 4) return false;
  // Strip a small set of generic tokens that appear in many institute names
  // and don't disambiguate.
  const STOP = new Set(['college', 'medical', 'institute', 'of', 'and', 'the', 'sciences', 'science', 'university', 'hospital', 'all', 'india']);
  const longerSet = new Set(longer.filter(t => !STOP.has(t)));
  const meaningful = shorter.filter(t => !STOP.has(t));
  if (meaningful.length === 0) return false;          // both names are stopwords-only
  return meaningful.every(t => longerSet.has(t));
}

function findCsvAnchor(
  uniName: string,
  quotaSlot: string,
  categorySlot: string,
): CutoffRow | null {
  const cutoffs = LATEST_CUTOFF_ROWS;
  const nameNorm = normalizeName(uniName);
  if (!nameNorm) return null;
  const quotaSet = csvQuotaForSlot(quotaSlot);
  const catNorm = normalizeName(categorySlot);
  // Only trust matches that share enough meaningful (non-stop-word) tokens
  // with the model's name. A single-token CSV row "government medical college"
  // matches countless institutes — using its closing rank as a hallucination
  // anchor was producing false-positive drops (e.g. Bettiah's OBC closing 45K
  // being compared against Chandigarh's OPEN closing 1073). Require ≥2
  // overlapping meaningful tokens for a confident anchor.
  const STOP = new Set(['college','medical','institute','of','and','the','sciences','science','university','hospital','all','india','government','govt','dental','medi','centre','center']);
  const modelTokens = nameNorm.split(/\s+/).filter(t => t && !STOP.has(t));
  let best: CutoffRow | null = null;
  for (const r of cutoffs) {
    const rNameNorm = normalizeName(r.institute);
    if (!rNameNorm) continue;
    if (!nameMatches(nameNorm, rNameNorm)) continue;
    if (quotaSet.size > 0 && !quotaSet.has(r.quota)) continue;
    if (catNorm) {
      const rCatNorm = normalizeName(r.category);
      // Skip placeholder/aggregate rows with empty or "-" category. The
      // empty string is technically a substring of every string, so
      // catNorm.includes("") returns true and these rows would otherwise
      // pass the category filter — and they often carry huge "-" closing
      // ranks like 1234779 (placeholder for unallotted seats) which
      // poisons the lowest-closing-wins selection.
      if (!rCatNorm) continue;
      if (!rCatNorm.includes(catNorm) && !catNorm.includes(rCatNorm)) continue;
    }
    const rTokens = new Set(rNameNorm.split(/\s+/).filter(t => t && !STOP.has(t)));
    const overlap = modelTokens.filter(t => rTokens.has(t)).length;
    if (overlap < 2) continue;
    if (!best || r.closingRank < best.closingRank) best = r;
  }
  return best;
}

// Like findCsvAnchor but doesn't restrict by quota — used by the state-quota
// domicile cross-check (Bug B), which needs to know the institute's geography
// regardless of which quota row Gemini is claiming. AIQ rows for a college
// typically share the same `r.state` as state-quota rows for that college, so
// returning any matching row gives us a reliable institute-state lookup.
// Resolve an institute's state from CSV. The original implementation returned
// the FIRST fuzzy match, so for ambiguous names ("Government Medical College")
// it could return Chandigarh's row when the actual institute was in Bihar —
// causing the validator to wrongly drop valid Bihar state-quota recommendations
// as "state mismatch". Now: collect ALL fuzzy matches, prefer ones in the
// expected state if a hint is given, and only return a match if there's a
// reasonable confidence about state. Returns null when ambiguous so the caller
// (state-quota cross-check) doesn't drop based on a wrong guess.
function findCsvAnchorWithState(
  uniName: string,
  _quotaSlot: string,
  categorySlot: string,
  preferStateNorm: string = '',
): CutoffRow | null {
  const cutoffs = LATEST_CUTOFF_ROWS;
  const nameNorm = normalizeName(uniName);
  if (!nameNorm) return null;
  const catNorm = normalizeName(categorySlot);
  // Same ≥2-token overlap rule as findCsvAnchor — without it, "Vardhman
  // Mahavir VMMC Safdarjung Delhi" fuzzy-matched "Vardhman Institute of
  // Medical Sciences Pawapuri Bihar" because both share the token
  // "Vardhman", causing the cross-check to wrongly tag VMMC as Bihar.
  const STOP = new Set(['college','medical','institute','of','and','the','sciences','science','university','hospital','all','india','government','govt','dental','medi','centre','center']);
  const modelTokens = nameNorm.split(/\s+/).filter(t => t && !STOP.has(t));
  const matches: CutoffRow[] = [];
  for (const r of cutoffs) {
    const rNameNorm = normalizeName(r.institute);
    if (!rNameNorm || !r.state) continue;
    if (!nameMatches(nameNorm, rNameNorm)) continue;
    if (catNorm) {
      const rCatNorm = normalizeName(r.category);
      if (!rCatNorm) continue;            // skip placeholder "-" / empty-category rows
      if (!rCatNorm.includes(catNorm) && !catNorm.includes(rCatNorm)) continue;
    }
    const rTokens = new Set(rNameNorm.split(/\s+/).filter(t => t && !STOP.has(t)));
    const overlap = modelTokens.filter(t => rTokens.has(t)).length;
    if (overlap < 2) continue;
    matches.push(r);
  }
  if (matches.length === 0) return null;

  // 1. If the Gemini-supplied name contains a state/city hint that uniquely
  //    points to one CSV row, use that.
  // 2. If preferStateNorm is given (the student's domicile) and ANY match is
  //    in that state, return it — caller will see "match found, no mismatch".
  if (preferStateNorm) {
    const inPreferred = matches.find(m => normalizeName(m.state || '') === preferStateNorm);
    if (inPreferred) return inPreferred;
  }
  // 3. If matches span multiple states, the name is ambiguous — return null
  //    so caller doesn't make a high-confidence mismatch claim.
  const states = new Set(matches.map(m => normalizeName(m.state || '')));
  if (states.size > 1) return null;
  // 4. All matches in one state — return the lowest-closing one.
  return matches.sort((a, b) => a.closingRank - b.closingRank)[0];
}

// AIIMS / INI hard anchors (Bug C). MCC counselling does NOT include AIIMS or
// JIPMER (those run via INI counselling), so findCsvAnchor returns null for
// every "All India Institute of Medical Sciences …" row. Without an anchor,
// the validator skips the hallucination + tier checks and Gemini's tier
// guess survives unchecked — leading to AIIMS Jodhpur being labelled
// "Stretch" for a student at AIR ~80 even though the historical Open closing
// is ~110-160 and the student would clearly clear it.
//
// Numbers below are 2024 INI MBBS Open closing AIRs from public INI sheets.
// Per-category multipliers approximate the historical reservation gap;
// they're rough but better than no anchor at all.
const INI_HARD_ANCHORS: Record<string, number> = {
  'aiims delhi':         60,
  'aiims jodhpur':       150,
  'aiims bhopal':        500,
  'aiims bhubaneswar':   600,
  'aiims patna':         900,
  'aiims raipur':        750,
  'aiims rishikesh':     1100,
  'aiims nagpur':        950,
  'aiims mangalagiri':   1200,
  'aiims gorakhpur':     1300,
  'aiims kalyani':       1500,
  'aiims rae bareli':    1600,
  'aiims deoghar':       1700,
  'aiims bibinagar':     1800,
  'aiims guwahati':      2000,
  'aiims bilaspur':      2200,
  'aiims madurai':       2400,
  'aiims rajkot':        2600,
  'aiims vijaypur':      2800,
  'aiims awadh':         3000,
  'jipmer puducherry':   200,
  'jipmer karaikal':     2200,
};
const INI_CATEGORY_MULT: Record<string, number> = {
  'open': 1.0, 'general': 1.0, 'ews': 2.5, 'obc': 3.5, 'sc': 12, 'st': 24,
  'open pwd': 8, 'general pwd': 8, 'ews pwd': 18, 'obc pwd': 22, 'sc pwd': 80, 'st pwd': 150,
};
function findIniHardAnchor(uniName: string, categorySlot: string): { closingRank: number } | null {
  const n = normalizeName(uniName);
  if (!n) return null;
  // Find the longest matching key — "aiims jodhpur" before "aiims".
  let bestKey: string | null = null;
  for (const k of Object.keys(INI_HARD_ANCHORS)) {
    if (n.includes(k) && (!bestKey || k.length > bestKey.length)) bestKey = k;
  }
  if (!bestKey) return null;
  const baseRank = INI_HARD_ANCHORS[bestKey];
  const cat = normalizeName(categorySlot);
  const mult = INI_CATEGORY_MULT[cat] || 1.0;
  return { closingRank: Math.round(baseRank * mult) };
}

// Mechanical tier derivation from student rankRange + claimed closing AIR
// range. NEET semantics: LOWER AIR = better student. Student gets a seat if
// their rank ≤ closing rank. claimedLow = strictest closing (e.g. AIIMS Delhi
// at AIR 50), claimedHigh = loosest within the predicted range.
//
//   Safe    — even student's WORST rank (high) clears the strictest closing
//             with 15% cushion: rankRange.high ≤ claimedLow × 0.85
//   Good    — student's mid clears the loosest closing: rankRange.mid ≤ claimedHigh
//   Reach   — student range overlaps with claimed range
//   Stretch — student's best is past the loose closing but within 2.5×:
//             rankRange.low > claimedHigh AND rankRange.low ≤ claimedHigh × 2.5
//   DROP    — truly unreachable: rankRange.low > claimedHigh × 2.5
//
// This mirrors the existing tierName(userRank, closing) function used in
// predictIndiaCsv (server.ts:572), generalised to operate on ranges instead
// of single values. The original AIIMS-Safe-at-AIR-500 bug arose from the
// model rationalising past the prompt-level gate; this function is the
// deterministic backstop.
function deriveTierFromRange(
  rankRange: { low: number; mid: number; high: number },
  claimedLow: number,
  claimedHigh: number,
): 'Safe' | 'Good' | 'Reach' | 'Stretch' | 'DROP' {
  // Truly unreachable: even student's best rank is past the stretch band of
  // the loosest closing. Uses the shared TIER_BANDS.stretch constant so this
  // and classifyTier() can never disagree on what "unreachable" means.
  if (rankRange.low > claimedHigh * TIER_BANDS.stretch) return 'DROP';
  // Safe: student's WORST rank clears the strictest closing with the same
  // 15% cushion as the single-value classifier.
  if (rankRange.high <= claimedLow * TIER_BANDS.safe) return 'Safe';
  // Good: student's mid clears the loosest closing
  if (rankRange.mid <= claimedHigh) return 'Good';
  // Past the loose closing but not unreachable → Stretch
  if (rankRange.low > claimedHigh) return 'Stretch';
  // Otherwise: ranges overlap → Reach
  return 'Reach';
}

function isTopperExempt(name: string): boolean {
  const n = normalizeName(name);
  return TOPPER_EXEMPT_INSTITUTES.some(t => n.includes(t));
}

// Parse a totalProgramCost string back into INR. The field is human-formatted:
// "₹66,000", "₹6,32,500", "₹1.0Cr – ₹1.6Cr", "₹50L – ₹70L", "₹1,37,50,000".
// We need it numeric to enforce a budget cap. Returns the UPPER bound (worst
// case for the student) so a college whose cost RANGE exceeds budget gets
// dropped — better to under-include than to recommend an unaffordable trap.
function extractCostMaxINR(costStr: string): number {
  if (!costStr) return 0;
  const s = String(costStr).replace(/\s/g, '');
  // Strip any leading rupees and split on dash for ranges
  const parts = s.split(/[–-]/).map(p => p.trim()).filter(Boolean);
  let maxINR = 0;
  for (const p of parts) {
    const m = p.match(/₹?([\d.,]+)\s*([LlCcRr]+)?/);
    if (!m) continue;
    const num = parseFloat(m[1].replace(/,/g, ''));
    if (!isFinite(num)) continue;
    const unit = (m[2] || '').toLowerCase();
    let inr: number;
    if (unit.includes('cr')) inr = num * 10_000_000;     // ₹1Cr = 1e7
    else if (unit.startsWith('l')) inr = num * 100_000;   // ₹1L = 1e5
    else if (num < 1000) inr = num * 100_000;             // bare "50" treated as ₹50L
    else inr = num;                                        // bare large number = INR
    if (inr > maxINR) maxINR = inr;
  }
  return maxINR;
}

// Build validator backfill rows from predictIndiaCsv, filtered by user
// profile. Plan §"Backfill on overdrop — filtered by user profile" — only
// pull rows matching student's category, with quota relevance gated by
// domicile and budget. Drop duplicates already in the validated list.
async function buildValidatorBackfill(
  profile: any,
  alreadyHave: any[],
  needCount: number,
): Promise<any[]> {
  if (needCount <= 0) return [];
  try {
    const csvResult = await predictIndiaCsv(profile);
    const budgetUSD = parseInt(profile.budgetInUSD || '0', 10);
    const budgetINR = budgetUSD ? budgetUSD * 83.5 : 0;
    const deemedAllowed = budgetUSD === 0 || budgetINR >= 3_500_000;
    const userDomicile = normalizeName(profile.domicileState || '');
    const isDup = (name: string) =>
      alreadyHave.some(u => namesMatchLoose(u?.name || '', name));
    const candidates = (csvResult.universities || []).filter((u: any) => {
      if (isDup(u.name)) return false;
      const q = String(u.quota || '');
      if (q === 'Deemed/Paid Seats Quota' && !deemedAllowed) return false;
      // AIQ + Deemed + Delhi/IP/Open are profile-agnostic — always safe.
      const profileAgnosticQuotas = new Set(['All India','Deemed/Paid Seats Quota','Open Seat Quota','IP University Quota','Delhi University Quota']);
      if (!profileAgnosticQuotas.has(q)) {
        // State-domicile row: include only if institute state matches the
        // student's domicile. predictIndiaCsv now preserves row.state on
        // each University object (was stripped before, blocking all state
        // backfill). This re-enables Karnataka state-quota rows for a
        // Karnataka student while still preventing the Bengal-to-MH leak.
        const rowState = normalizeName(u.state || '');
        if (!rowState || !userDomicile || rowState !== userDomicile) return false;
      }
      // Same budget cap as the validator (1.5× headroom). Without this,
      // CSV deemed rows tagged "₹1.0Cr – ₹1.6Cr" leak past the validator
      // for budgets where the cost is genuinely out of reach.
      if (budgetINR > 0) {
        const costINR = extractCostMaxINR(String(u.totalProgramCost || ''));
        if (costINR > 0 && costINR > budgetINR * 1.5) return false;
      }
      return true;
    });
    // Normalise CSV-shape rows into the validator/UI shape — UI sort/filter
    // assumes every row has quotaSlot, categorySlot, expectedClosingAirLow/High
    // and reads `closingRank ~N` out of neetRequirement to derive AIR.
    return candidates.slice(0, needCount).map(normaliseBackfillRow);
  } catch (e: any) {
    console.error('[validator] backfill failed:', e?.message || e);
    return [];
  }
}

// CSV-rooted backfill rows arrive with `quota` (different field name) and
// no AIR band. The validator + UI both assume `quotaSlot`, `categorySlot`
// and numeric `expectedClosingAirLow/High`. Without this fold, backfill
// rows render with empty Tier/AIR cells and break ascending-rank sort.
function normaliseBackfillRow(u: any): any {
  const quotaSlot = (() => {
    const q = String(u.quota || '');
    if (q === 'All India') return 'AIQ';
    if (q === 'Deemed/Paid Seats Quota') return 'Deemed';
    return 'State';
  })();
  // Pull out the category slot from neetRequirement if absent
  let categorySlot = u.categorySlot || '';
  if (!categorySlot) {
    const m = String(u.neetRequirement || '').match(/\(([^)]+)\)/);
    if (m) categorySlot = m[1].trim();
  }
  // Recover AIR from the literal "Closing rank ~N" in neetRequirement.
  let low = u.expectedClosingAirLow;
  let high = u.expectedClosingAirHigh;
  if (!low || !high) {
    const m = String(u.neetRequirement || '').match(/closing rank ~?([\d,]+)/i);
    const air = m ? parseInt(m[1].replace(/,/g, ''), 10) : 0;
    if (air) {
      // ±10% band — narrow because the CSV anchor IS the closing rank.
      low  = Math.round(air * 0.9);
      high = Math.round(air * 1.1);
    }
  }
  return { ...u, quotaSlot, categorySlot, expectedClosingAirLow: low, expectedClosingAirHigh: high };
}

// Infer the course taught at a college from its name. We don't have a clean
// course field in either CSV or Gemini response, but the institute name is
// reliable: "Dental College" → BDS, "Homoeopathic" → BHMS, "Ayurveda/Ayurvedic"
// → BAMS, "Unani" → BUMS, "Siddha" → BSMS, otherwise → MBBS. Used by the
// validator to drop colleges that don't match `profile.coursePreferences`.
type CourseCode = 'MBBS' | 'BDS' | 'BAMS' | 'BHMS' | 'BUMS' | 'BSMS' | 'BNYS';
function inferCourseFromName(name: string): CourseCode {
  const n = String(name || '').toLowerCase();
  if (/\bdental\b|\bdent\.?\b/.test(n)) return 'BDS';
  if (/\bhomoeo|homeop|hom\.?\s*med/.test(n)) return 'BHMS';
  if (/\bayurved/.test(n)) return 'BAMS';
  if (/\bunani\b/.test(n)) return 'BUMS';
  if (/\bsiddha\b/.test(n)) return 'BSMS';
  if (/\byoga|naturopathy\b/.test(n)) return 'BNYS';
  return 'MBBS';
}

// Treat the user's coursePreferences as either "MBBS" alone (default), or
// the explicit list. Empty/missing means MBBS-only — the canonical Vidysea
// flow. The UI's "Also consider …" chips populate this list when the user
// opts in, so a non-empty list is an explicit student request to widen.
function isCourseAllowed(course: CourseCode, prefs: string[]): boolean {
  if (course === 'MBBS') return true;                  // MBBS is always in scope
  if (!prefs || prefs.length === 0) return false;       // default = MBBS-only
  // AYUSH umbrella covers BAMS/BHMS/BUMS/BSMS — student saying "AYUSH" means yes-to-all
  const upper = prefs.map(p => String(p || '').toUpperCase());
  if (upper.includes('AYUSH') && (course === 'BAMS' || course === 'BHMS' || course === 'BUMS' || course === 'BSMS' || course === 'BNYS')) return true;
  return upper.includes(course);
}

function validateIndiaUniversities(
  unis: any[],
  rankRange: { low: number; mid: number; high: number },
  userCategory: string,
  coursePrefs: string[] = [],
  domicileState: string = '',
  budgetINR: number = 0,
): ValidationResult {
  const drops: ValidationResult['drops'] = [];
  const overrides: ValidationResult['overrides'] = [];
  const skipped: ValidationResult['skipped'] = [];
  const validated: any[] = [];

  for (const u of unis) {
    const name = String(u?.name || '(unnamed)');
    const claimedLow  = Number(u?.expectedClosingAirLow);
    const claimedHigh = Number(u?.expectedClosingAirHigh);
    const quotaSlot   = String(u?.quotaSlot || '');
    const categorySlot = String(u?.categorySlot || userCategory);

    // -3. Budget cap with stretch headroom. Govt vs non-govt is NOT the
    //     filter — affordability is. We allow up to budget × 1.5 (50%
    //     headroom) so a ₹60L-budget student can still see ₹80-90L deemed
    //     options as Stretch picks (loan + family stretch is a real path).
    //     Anything beyond 1.5× the stated budget is genuinely unaffordable
    //     and recommending it would be a trap, not a recommendation.
    if (budgetINR > 0) {
      const costINR = extractCostMaxINR(String(u?.totalProgramCost || ''));
      if (costINR > 0 && costINR > budgetINR * 1.5) {
        drops.push({ name, reason: `over budget: cost ₹${(costINR/1e5).toFixed(0)}L > budget ₹${(budgetINR/1e5).toFixed(0)}L × 1.5` });
        continue;
      }
    }

    // -2. Course-preference filter (Bug D). The student requested MBBS, BDS,
    //     or AYUSH chips; we infer the course from the college name and drop
    //     anything outside the requested set. Empty prefs = MBBS-only (the
    //     canonical Vidysea flow). Live test surfaced an MBBS-only request
    //     getting back R. Ahmed Dental College & Hospital — wrong course.
    const inferred = inferCourseFromName(name);
    if (!isCourseAllowed(inferred, coursePrefs)) {
      drops.push({ name, reason: `course mismatch: inferred=${inferred} not in prefs=${coursePrefs.join(',') || 'MBBS'}` });
      continue;
    }

    // -1. State-quota domicile cross-check (Bug B). When quotaSlot=='State'
    //     the institute's state must match the student's domicile; West
    //     Bengal "State quota" is meaningless to a Maharashtra resident and
    //     showing it as accessible is a wrong recommendation. Resolve the
    //     institute's state via the CSV anchor (which carries r.state).
    if (quotaSlot.toLowerCase() === 'state' && domicileState) {
      // Pass domicileState as the hint — if a fuzzy-matched row in the
      // student's state exists, prefer it over rows in other states.
      // That's the right behavior for ambiguous institute names like
      // "Government Medical College" which appears across many states.
      const userDomNorm = normalizeName(domicileState);
      const stateAnchor = findCsvAnchorWithState(name, quotaSlot, categorySlot, userDomNorm);
      if (stateAnchor && stateAnchor.state) {
        if (normalizeName(stateAnchor.state) !== userDomNorm) {
          drops.push({ name, reason: `state-quota mismatch: institute is ${stateAnchor.state}, student domicile ${domicileState}` });
          continue;
        }
      }
      // stateAnchor null = ambiguous — don't drop, let it through.
    }

    // 0. Missing/zero numeric fields — model failed schema requirement.
    //    Don't drop; pass through unchanged. Counter surfaces in telemetry so
    //    we can monitor schema compliance rate.
    if (!claimedLow || !claimedHigh || claimedHigh < claimedLow) {
      skipped.push({ name, reason: `missing or invalid expectedClosingAir (low=${u?.expectedClosingAirLow}, high=${u?.expectedClosingAirHigh})` });
      validated.push(u);
      continue;
    }

    // 1. Hallucination handling — when Gemini's claimed AIR band is wildly
    //    different from the CSV anchor (per same college + quota + category),
    //    we OVERRIDE the AIR band with CSV-derived values rather than drop
    //    the row. Reasoning: under filter-first architecture, the anchor
    //    pool already proved this row is rank-reachable for the student;
    //    Gemini's bad AIR claim is a presentation issue, not a "this row
    //    shouldn't be here" issue. Dropping it lost MAMC/VMMC for every
    //    Delhi topper because Gemini's OBC State claim (900) didn't match
    //    the Delhi University Quota OBC closing in CSV (5015) — but
    //    student CAN clear 5015, so the recommendation is valid.
    //    Only DROP when the discrepancy is so extreme (10x+) that we
    //    suspect Gemini named the wrong college entirely.
    const csvAnchor = findCsvAnchor(name, quotaSlot, categorySlot)
      || findIniHardAnchor(name, categorySlot);
    if (csvAnchor) {
      const csvRank = csvAnchor.closingRank;
      const easyMult = halluTooEasyMult(csvRank);
      const hardMult = halluTooHardMult(csvRank);
      // Hard drop only on extreme discrepancies (Gemini probably named the
      // wrong college). Threshold: 10x mismatch in either direction.
      if (claimedHigh > csvRank * 10 || claimedHigh * 10 < csvRank) {
        drops.push({ name, reason: `extreme AIR mismatch: claimed ${claimedHigh} vs CSV ${csvRank} — likely wrong college` });
        continue;
      }
      // Soft override: when within "wild but plausible" range (failing the
      // tight easyMult/hardMult bands but within 10x), replace Gemini's AIR
      // band with CSV-derived values so the displayed band is honest.
      if (claimedHigh > csvRank * easyMult || claimedHigh < csvRank * hardMult) {
        const newLow = Math.round(csvRank * 0.92);
        const newHigh = Math.round(csvRank * 1.08);
        overrides.push({
          name,
          from: `AIR ${claimedLow}-${claimedHigh}`,
          to:   `AIR ${newLow}-${newHigh}`,
          reason: `AIR override to CSV anchor (claimed band drifted from anchor by ${(claimedHigh / csvRank).toFixed(1)}x)`,
        });
        u.expectedClosingAirLow  = newLow;
        u.expectedClosingAirHigh = newHigh;
      }
    }

    // 2. Mechanical tier derivation
    const codeTier = deriveTierFromRange(rankRange, claimedLow, claimedHigh);

    // 3. Topper exception — promote-then-keep instead of drop for AIIMS toppers
    if (codeTier === 'DROP') {
      if (rankRange.mid < 1500 && isTopperExempt(name)) {
        const oldTier = String(u.tier || 'unknown');
        if (oldTier !== 'Stretch') {
          overrides.push({
            name, from: oldTier, to: 'Stretch',
            reason: `topper-exempt AIIMS promoted from DROP to Stretch (AIR ${rankRange.mid} < 1500)`,
          });
          u.tier = 'Stretch';
          // Refresh bestFor to match new tier when it leads with a tier word
          if (typeof u.bestFor === 'string' && /\b(safe|good|reach|stretch)\b/i.test(u.bestFor)) {
            u.bestFor = u.bestFor.replace(/\b(safe|good|reach|stretch)\b/i, 'Stretch');
          }
        }
        validated.push(u);
        continue;
      }
      drops.push({
        name,
        reason: `unreachable: student high=${rankRange.high} < claimed.low=${claimedLow} × 0.5`,
      });
      continue;
    }

    // 4. Tier override when model disagrees with code
    const modelTier = String(u.tier || '');
    if (modelTier !== codeTier) {
      overrides.push({
        name, from: modelTier || '(unset)', to: codeTier,
        reason: `student rank=[${rankRange.low}-${rankRange.high}] vs claimed=[${claimedLow}-${claimedHigh}]`,
      });
      u.tier = codeTier;
      if (typeof u.bestFor === 'string' && /\b(safe|good|reach|stretch)\b/i.test(u.bestFor)) {
        u.bestFor = u.bestFor.replace(/\b(safe|good|reach|stretch)\b/i, codeTier);
      }
    }

    validated.push(u);
  }

  return { validated, drops, overrides, skipped, backfilled: 0 };
}

async function predictIndia(profile: any) {
  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  // "MBBS only" in otherPreferences overrides any checked alternative-course chips
  if ((profile.otherPreferences || '').toLowerCase().includes('mbbs only')) {
    profile.coursePreferences = [];
  }
  const userCategory = (profile.category || 'OPEN').toUpperCase();

  // ── Rank derivation: AIR (single coordinate system) ───────────────────────
  // rankRange.low/mid/high are AIR (the rank as printed on the NTA NEET
  // scorecard). CSV closing ranks are also AIR, so direct comparison is
  // correct. User-supplied rank is interpreted as AIR.
  const suppliedRank = profile.neetRank && profile.neetRank > 0;
  const rankRange: RankRange = suppliedRank
    ? { low: Math.round(profile.neetRank * 0.95), mid: profile.neetRank,
        high: Math.round(profile.neetRank * 1.05), confidence: 'Supplied' }
    : approximateRankRange(profile.neetScore || 0, userCategory);
  const userRank = rankRange.mid;

  // Contradiction check: flag if supplied score + rank are inconsistent
  let rankNote = '';
  if (profile.neetScore && suppliedRank) {
    const expected = approximateRank(profile.neetScore, userCategory);
    if (profile.neetRank / expected > 2.5 || profile.neetRank / expected < 0.40) {
      rankNote = fillTemplate(PROMPTS.india.rankInconsistencyNote, {
        suppliedRankFmt: profile.neetRank.toLocaleString(),
        neetScore: profile.neetScore,
        expectedRankFmt: expected.toLocaleString(),
      });
    }
  }

  const explicitPrefs: string[] = profile.coursePreferences || [];
  const suggestAlternatives = explicitPrefs.length > 0 || userRank > 250000;
  const alternativeCourses = explicitPrefs.length > 0 ? explicitPrefs : ['BDS', 'BAMS', 'BHMS'];

  // ── CSV anchors (filter-first, authoritative pool) + probabilities ─────────
  // We now apply ALL hard constraints (rank, category, state quota domicile,
  // budget cap, gender, course pref) at fetch time and pass the surviving
  // rows to Gemini as the authoritative pool. Gemini's job: rank these rows,
  // pick the 10 best fits, narrate. Reduces drop-after-the-fact validator
  // churn that was leaving students with thin lists.
  const _bUSD = parseInt(profile.budgetInUSD || '0', 10);
  const _bINR = _bUSD ? Math.round(_bUSD * 83.5) : 0;
  const _genderForFilter = (profile.gender === 'Male' || profile.gender === 'Female') ? profile.gender : '';
  const _coursePrefs = profile.coursePreferences || [];
  const eligibleAnchors = extractEligibleAnchors(
    rankRange, userCategory, profile.domicileState || '',
    _bINR, _genderForFilter, _coursePrefs,
  );
  // Format the filtered anchors for the prompt — each row carries tier +
  // typical cost so Gemini doesn't have to re-derive them.
  const contextRows = eligibleAnchors.rows.length > 0
    ? eligibleAnchors.rows.map(r => {
        const fee = indiaFeeProfile(r.quota);
        return `${r.institute} | ${r.state || '?'} | ${r.quota} | ${r.category} | closing AIR ${r.closingRank} | tier:${r._tier} | typical cost: ${fee.totalINRRange}`;
      }).join('\n')
    : '(No MCC rows match the student\'s combined filters — your output should still propose realistic deemed/private/state-private options that fit the budget and rank, drawn from your training knowledge.)';
  console.log(`[predictIndia] anchors: ${eligibleAnchors.summary}`);
  const _debugAnchorRows = eligibleAnchors.rows.map(r => `${r.institute} (${r._tier}, AIR ${r.closingRank}, ${r.quota})`);
  const probs = computeQuotaProbabilities(rankRange, userCategory, profile.domicileState || '');
  const state = profile.domicileState || 'not specified';
  const score = profile.neetScore ? `NEET Score ${profile.neetScore}` : '';
  const budgetUSD = parseInt(profile.budgetInUSD || '0');
  const budgetINRNum = Math.round(budgetUSD * 83.5);
  const budgetINRL = Math.round(budgetINRNum / 100000);
  const budgetINR = budgetUSD ? `₹${budgetINRL}L total (~$${budgetUSD})` : 'not specified';
  // Govt vs non-govt is NOT our concern — best fit for the student is.
  // Soft floor at ₹35L (was hard ₹50L). At ₹35L+ deemed becomes a stretch
  // a student can plausibly fund (loan + family); below that the typical
  // ₹50L–₹1Cr deemed floor is genuinely out of reach. The Gemini prompt
  // still surfaces the cost honestly so the student can decide.
  const deemedEligible = budgetINRNum === 0 || budgetINRNum >= 3_500_000;

  // AIR display — single coordinate system. Closing ranks throughout the
  // prompt are category-specific AIR values from the CSV, directly comparable.
  const rankDisplay = `AIR ~${userRank.toLocaleString('en-IN')} (band: ${rankRange.low.toLocaleString('en-IN')}–${rankRange.high.toLocaleString('en-IN')}, confidence: ${rankRange.confidence})`;
  const isReservation = userCategory !== 'OPEN';

  const isTopper = userRank < 1500;
  const stateKnown = state !== 'not specified';
  const genderRaw = (profile.gender || '').trim();
  const gender = (genderRaw === 'Male' || genderRaw === 'Female') ? genderRaw : 'unspecified';

  // Pre-formatted variables (toLocaleString, joins, etc. — kept out of JSON)
  const rankRangeLow  = rankRange.low.toLocaleString('en-IN');
  const rankRangeMid  = rankRange.mid.toLocaleString('en-IN');
  const rankRangeHigh = rankRange.high.toLocaleString('en-IN');
  const altCoursesCSV   = alternativeCourses.join(', ');
  const altCoursesSlash = alternativeCourses.join('/');
  const stateEstimatedFlag  = probs.stateIsEstimated ? ' (est.)' : '';
  const stateEstimatedExtra = probs.stateIsEstimated ? PROMPTS.india.stateEstimatedExtra : '';

  // Pre-render conditional fragments using templates from prompts.json
  const stateQuotaLine = stateKnown
    ? fillTemplate(PROMPTS.india.stateQuotaLineKnown, {
        stateQuotaMbbs: probs.stateQuotaMbbs,
        stateEstimatedExtra,
      })
    : PROMPTS.india.stateQuotaLineMissing;

  const probSection = fillTemplate(PROMPTS.india.probSection, {
    aiqMbbs: probs.aiqMbbs,
    state,
    stateQuotaLine,
    deemedPrivate: probs.deemedPrivate,
  });

  const altOpenLine = suggestAlternatives
    ? fillTemplate(PROMPTS.india.altOpenLine, { alternativeCourses: altCoursesCSV })
    : '';

  const deemedVerdict = fillTemplate(
    deemedEligible ? PROMPTS.india.deemedAllowed : PROMPTS.india.deemedExcluded,
    { budgetINRL },
  );

  const deemedSlot = deemedEligible
    ? PROMPTS.india.deemedSlotAllowed
    : PROMPTS.india.deemedSlotExcluded;

  const topperBlock = isTopper
    ? fillTemplate(PROMPTS.india.topperBlock, { userRank, rankRangeLow })
    : '';

  const altInstruction = suggestAlternatives
    ? fillTemplate(PROMPTS.india.altInstruction, { alternativeCourses: altCoursesCSV })
    : '';

  const altAnalysisNote = suggestAlternatives
    ? fillTemplate(PROMPTS.india.altAnalysisNote, { alternativeCoursesSlash: altCoursesSlash })
    : '';

  const budgetReality = fillTemplate(
    deemedEligible ? PROMPTS.india.budgetRealityAllowed : PROMPTS.india.budgetRealityExcluded,
    { deemedPrivate: probs.deemedPrivate, budgetINRL },
  );

  // Category-advantage narrative — short acknowledgement for reservation
  // candidates. Replaces the earlier computed-category-rank approach (which
  // used pool fractions in a way that introduced systematic bias). The CSV's
  // closing ranks already encode category advantage (OBC closing AIR > Open
  // closing AIR for the same college), so all we need is one narrative line.
  const categoryAdvantageNote = isReservation
    ? fillTemplate(PROMPTS.india.categoryAdvantageNote, { userCategory })
    : '';

  // Counselling strategy varies by rank tier — three bands matching the
  // probability-cap bands. Toppers (<1500): AIQ-primary (top national colleges
  // live in AIQ). Mid (1500–25000): balanced — both channels are competitive
  // here, AIQ for non-AIIMS govt + state for mid/lower-tier state GMCs. Low
  // (>25000): state-primary safety net first.
  const isMidRank = !isTopper && userRank < 25000;
  const strategyTemplate = isTopper
    ? PROMPTS.india.counsellingStrategyTopper
    : isMidRank
      ? PROMPTS.india.counsellingStrategyMid
      : PROMPTS.india.counsellingStrategyDefault;
  const counsellingStrategy = fillTemplate(strategyTemplate, { state });

  // Data-year context — explicit gap between CSV anchor year and prediction
  // year so Gemini compensates for stale anchors. INTERNAL ONLY: the user
  // never sees this; it just shapes Gemini's reasoning.
  const cutoffStaleYears = Math.max(0, PREDICTION_YEAR - LATEST_CUTOFF_YEAR);
  const dataYearNote = fillTemplate(PROMPTS.india.dataYearNote, {
    latestCutoffYear: LATEST_CUTOFF_YEAR,
    cutoffStaleYears,
  });

  // Gender exclusion — only injected when we know the gender or it's
  // unspecified (in which case we exclude women-only as a safe default).
  const genderExclusion = (gender !== 'Female')
    ? fillTemplate(PROMPTS.india.genderExclusion, { gender })
    : '';

  const prompt = fillTemplate(PROMPTS.india.main, {
    today: todayISO(),
    score, rankDisplay, userCategory, gender,
    latestCutoffYear: LATEST_CUTOFF_YEAR,
    cutoffStaleYears,
    rankNote, state, budgetINR, budgetINRL,
    contextRows, userRank,
    rankRangeLow, rankRangeMid, rankRangeHigh,
    aiqMbbs: probs.aiqMbbs,
    stateQuotaMbbs: probs.stateQuotaMbbs,
    deemedPrivate: probs.deemedPrivate,
    stateEstimatedFlag,
    altOpenLine, probSection, deemedVerdict, deemedSlot,
    topperBlock, altInstruction, altAnalysisNote, budgetReality,
    categoryAdvantageNote, genderExclusion,
    counsellingStrategy,
    dataYearNote,
  }).trim();

  // Fire main recommendation + state-quota verification in parallel.
  // The verification is best-effort: if it fails, the main result is still returned.
  const t0 = Date.now();
  const mainCall = callGemini(ai, 'predictIndia.main', {
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      responseSchema: indiaResponseSchema,
    },
  });
  const verifyCall = verifyStateQuota(ai, rankRange, userCategory, state, gender);

  try {
    console.log(`[predictIndia] starting | userRank=${userRank} category=${userCategory} state=${state || '-'} contextRows=${contextRows.split('\n').length}`);
    // allSettled so verifier crash doesn't kill the main call
    const [mainSettled, verifySettled] = await Promise.allSettled([mainCall, verifyCall]);
    if (mainSettled.status === 'rejected') {
      const err: any = mainSettled.reason;
      console.error('[predictIndia] main call REJECTED');
      console.error(`  message: ${err?.message || err}`);
      if (err?.stack) console.error(`  stack:\n${err.stack}`);
      if (err?.cause) console.error(`  cause:`, err.cause);
      if (err?.response) console.error(`  response:`, JSON.stringify(err.response).slice(0, 800));
      throw err;
    }
    const { resp, tel } = mainSettled.value;
    let stateQuotaInsights: StateQuotaInsights | null = null;
    if (verifySettled.status === 'fulfilled') {
      stateQuotaInsights = verifySettled.value;
    } else {
      const err: any = verifySettled.reason;
      console.error('[predictIndia] verifier crashed (continuing without it):');
      console.error(`  message: ${err?.message || err}`);
      if (err?.stack) console.error(`  stack:\n${err.stack}`);
    }
    const result = JSON.parse(resp.text || '{"universities":[],"analysis":""}');
    if (stateQuotaInsights) result.stateQuotaInsights = stateQuotaInsights;

    // Code-level tier validator — Stage 1 of the Pro hybrid. Runs against the
    // parsed Gemini response and enforces deterministic tier assignment based
    // on student rankRange vs claimed expectedClosingAir. See plan §Validator.
    const validation = validateIndiaUniversities(
      Array.isArray(result.universities) ? result.universities : [],
      rankRange,
      userCategory,
      profile.coursePreferences || [],
      profile.domicileState || '',
      budgetINRNum,
    );

    // Backfill on overdrop. Goal: always deliver ~10 results (Gemini is asked
    // for EXACTLY 10; validator drops some for rank/budget/state-domicile/
    // course-pref reasons; backfill from CSV refills the gap). Trigger as
    // soon as we're below 10 — earlier we capped at 7 to avoid CSV padding,
    // but that left students with thin lists when the validator was strict.
    const TARGET_UNIS = 10;
    if (validation.validated.length < TARGET_UNIS) {
      const need = TARGET_UNIS - validation.validated.length;
      console.log(`[validator] only ${validation.validated.length} unis survived validation, backfilling up to ${need} from CSV…`);
      const backfill = await buildValidatorBackfill(profile, validation.validated, need);
      validation.validated.push(...backfill);
      validation.backfilled = backfill.length;
      console.log(`[validator] backfill returned ${backfill.length} rows`);
    }
    result.universities = validation.validated;

    // Telemetry summary for the whole India request — wall-clock includes both parallel calls
    result.telemetry = {
      wallClockMs: Date.now() - t0,
      mainCall: tel,
      stateVerified: !!stateQuotaInsights,
      validatorDrops:      validation.drops.length,
      validatorOverrides:  validation.overrides.length,
      validatorSkipped:    validation.skipped.length,
      validatorBackfilled: validation.backfilled,
    };
    console.log(
      `[predictIndia] total wall-clock ${result.telemetry.wallClockMs}ms (state verified: ${result.telemetry.stateVerified}) ` +
      `[validator] drops=${validation.drops.length} overrides=${validation.overrides.length} ` +
      `skipped=${validation.skipped.length} backfilled=${validation.backfilled}`
    );
    if (validation.drops.length)     console.log('[validator] drops:',     validation.drops);
    if (validation.overrides.length) console.log('[validator] overrides:', validation.overrides);
    // Stash for ?debug=1 visibility — does not leak in normal responses.
    (result as any)._anchorPoolSummary = { count: eligibleAnchors.rows.length, summary: eligibleAnchors.summary, rows: _debugAnchorRows };
    (result as any)._validatorDetails = { drops: validation.drops, overrides: validation.overrides, skipped: validation.skipped };
    return result;
  } catch (err: any) {
    // No silent CSV fallback — Gemini's anchored reasoning IS the product. A
    // CSV-only response would look like a recommendation but lack the rank-
    // tier-aware probabilities, topper logic, state-quota grounding, and
    // category-specific narrative the user is paying for. Better to surface
    // the failure cleanly so the caller sees a real error and we can fix it.
    console.error('[predictIndia] FAILED — bubbling up to /api/predict (NO silent CSV fallback by design)');
    console.error(`  message: ${err?.message || err}`);
    if (err?.stack) console.error(`  stack:\n${err.stack}`);
    if (err?.cause) console.error(`  cause:`, err.cause);
    if (err?.response) console.error(`  response:`, JSON.stringify(err.response).slice(0, 800));
    throw err;
  }
}

// ── Abroad predictor (single Gemini Flash call) ──────────────────────────────

const universitySchema = {
  type: Type.OBJECT,
  properties: {
    name: { type: Type.STRING },
    country: { type: Type.STRING },
    continent: { type: Type.STRING },
    tier: { type: Type.STRING, description: 'Admission difficulty: "Safe", "Good", or "Reach" relative to the student profile.' },
    annualTuitionFee: { type: Type.STRING },
    totalProgramCost: { type: Type.STRING },
    tuitionFeeUSD: { type: Type.NUMBER, description: 'Annual tuition fee in USD as a number (e.g. 4500). REQUIRED.' },
    totalProgramCostUSD: { type: Type.NUMBER, description: 'Total 5-6 year program cost (tuition only) in USD as a number (e.g. 27000). REQUIRED.' },
    totalDurationYears: { type: Type.STRING },
    mediumOfInstruction: { type: Type.STRING },
    neetRequirement: { type: Type.STRING },
    nmcRecognitionStatus: { type: Type.STRING },
    globalRank: { type: Type.STRING },
    rankingSource: { type: Type.STRING },
    rankingYear: { type: Type.STRING },
    clinicalExposure: { type: Type.STRING },
    safetyAndSupport: { type: Type.STRING },
    roiScore: { type: Type.STRING },
    bestFor: { type: Type.STRING },
    specializations: { type: Type.ARRAY, items: { type: Type.STRING } },
    reputationScore: { type: Type.STRING },
    description: { type: Type.STRING },
  },
  required: [
    'name', 'country', 'continent', 'tier', 'annualTuitionFee', 'totalProgramCost',
    'tuitionFeeUSD', 'totalProgramCostUSD',
    'totalDurationYears', 'mediumOfInstruction', 'neetRequirement',
    'nmcRecognitionStatus', 'globalRank', 'rankingSource', 'rankingYear',
    'clinicalExposure', 'safetyAndSupport', 'roiScore', 'bestFor',
    'specializations', 'reputationScore', 'description',
  ],
};

const responseSchema = {
  type: Type.OBJECT,
  properties: {
    universities: { type: Type.ARRAY, items: universitySchema },
    analysis: { type: Type.STRING },
  },
  required: ['universities', 'analysis'],
};

// India response schema — universitySchema + four numeric/string fields the
// code-level validator uses to override hallucinated tier assignments. The
// rank fields are AIR (single coordinate system across the codebase). Marked
// required so the model reliably populates them; if it returns 0/null anyway,
// validateIndiaUniversities skips that row instead of dropping it (counted as
// `validatorSkipped` for telemetry — leading indicator that the schema isn't
// being honored and Stage 2 (Pro) may be needed sooner than planned).
const indiaUniversitySchema = {
  type: Type.OBJECT,
  properties: {
    ...universitySchema.properties,
    expectedClosingAirLow:  { type: Type.NUMBER, description: 'Forward-looking 2026 expected closing AIR — lower bound of the predicted range. Use the most-recent MCC anchor data ±5%. Plain number, not string. Required for India route.' },
    expectedClosingAirHigh: { type: Type.NUMBER, description: 'Forward-looking 2026 expected closing AIR — upper bound. Plain number. Required for India route.' },
    quotaSlot:    { type: Type.STRING, description: "Quota label this rank applies to: 'AIQ', 'State', 'Deemed', 'Management', 'NRI', 'AIIMS', or 'NEET-Alt'." },
    categorySlot: { type: Type.STRING, description: "Category the closing AIR applies to: 'Open', 'OBC', 'SC', 'ST', 'EWS', etc." },
  },
  required: [
    ...universitySchema.required,
    'expectedClosingAirLow', 'expectedClosingAirHigh', 'quotaSlot', 'categorySlot',
  ],
};

const indiaResponseSchema = {
  type: Type.OBJECT,
  properties: {
    universities: { type: Type.ARRAY, items: indiaUniversitySchema },
    analysis: { type: Type.STRING },
  },
  required: ['universities', 'analysis'],
};

async function predictAbroad(profile: any) {
  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

  const countries = (profile.preferredCountries || []).join(', ') || 'any NMC-recognised country';
  const budget = profile.budgetInUSD ? `~$${profile.budgetInUSD} USD total program budget` : 'flexible budget';
  const score = profile.neetScore ? `NEET Score ${profile.neetScore}` : '';
  const rank = profile.neetRank ? `NEET Rank ${profile.neetRank}` : '';
  const otherPrefs = profile.otherPreferences || '';

  const indianFoodNote = /food|mess|veg|community/i.test(otherPrefs)
    ? PROMPTS.abroad.indianFoodNote
    : '';

  // NEET qualifying cutoff — under NMC FMGL regulations, an Indian student
  // must clear NEET-UG to be eligible for an Indian medical license post
  // foreign-MBBS. Approximate 720-scale cutoffs: ~137 General/EWS, ~107 reserved.
  // Use the lower bound as the trigger so we don't false-positive reserved
  // students sitting just under the General cutoff.
  const NEET_QUALIFYING_FLOOR = 107;
  const numericScore = Number(profile.neetScore) || 0;
  const qualifyingCutoffNote = (numericScore > 0 && numericScore < NEET_QUALIFYING_FLOOR)
    ? fillTemplate(PROMPTS.abroad.qualifyingCutoffNote, { score: String(numericScore) })
    : '';

  // Anchor rows: filter the 45-uni dataset down to ≤18 candidates relevant to
  // this profile (preferred countries, budget). The model is instructed to
  // anchor on these for fees / NMC status / FMGE rather than fully relying on
  // grounded knowledge — same pattern as MCC CSV anchoring on the India side.
  const anchorRows = filterAbroadAnchors(profile);
  const anchorBlock = formatAbroadContext(anchorRows);
  const anchorRowCount = anchorRows.length;

  const prompt = fillTemplate(PROMPTS.abroad.main, {
    today: todayISO(),
    score, rank, budget, countries,
    otherPrefsOrNone: otherPrefs || 'none',
    indianFoodNote,
    qualifyingCutoffNote,
    anchorBlock,
    anchorRowCount: String(anchorRowCount),
    referenceDataDate: ABROAD_REFERENCE_DATE,
  }).trim();

  console.log(`[predictAbroad] starting | anchorRows=${anchorRowCount} | qualifyingNote=${qualifyingCutoffNote ? 'YES' : 'no'} | foodNote=${indianFoodNote ? 'YES' : 'no'}`);

  // Fire main + verifier in parallel. Verifier is best-effort: if it fails,
  // null insights ship and the main result is still returned.
  // Use Promise.allSettled so a verifier crash doesn't kill the main call.
  const t0 = Date.now();
  const mainCall = callGemini(ai, 'predictAbroad.main', {
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      responseSchema,
    },
  });
  const verifyCall = verifyAbroad(ai, profile, anchorRows);

  const [mainSettled, verifySettled] = await Promise.allSettled([mainCall, verifyCall]);
  if (mainSettled.status === 'rejected') {
    console.error('[predictAbroad] main call REJECTED');
    const err: any = mainSettled.reason;
    console.error(`  message: ${err?.message || err}`);
    if (err?.stack) console.error(`  stack:\n${err.stack}`);
    if (err?.cause) console.error(`  cause:`, err.cause);
    if (err?.response) console.error(`  response:`, JSON.stringify(err.response).slice(0, 800));
    throw err;  // bubble up so /api/predict 500s with the real cause
  }
  const { resp, tel } = mainSettled.value;
  let abroadInsights: AbroadInsights | null = null;
  if (verifySettled.status === 'fulfilled') {
    abroadInsights = verifySettled.value;
  } else {
    const err: any = verifySettled.reason;
    console.error('[predictAbroad] verifier crashed (continuing without it):');
    console.error(`  message: ${err?.message || err}`);
    if (err?.stack) console.error(`  stack:\n${err.stack}`);
  }

  const result = JSON.parse(resp.text || '{"universities":[],"analysis":""}');
  if (abroadInsights) result.abroadInsights = abroadInsights;

  // Country constraint enforcement — when the student listed preferred
  // countries, drop any returned university outside that set. The prompt
  // already says this, but Gemini occasionally smuggles in popular non-
  // listed picks; the post-validator is the safety net.
  if (Array.isArray(profile.preferredCountries) && profile.preferredCountries.length > 0) {
    const wantSet = new Set(
      profile.preferredCountries.map((c: string) => String(c).toLowerCase().trim()),
    );
    const beforeCount = (result.universities || []).length;
    let dropped = 0;
    result.universities = (result.universities || []).filter((u: any) => {
      const c = String(u?.country || '').toLowerCase().trim();
      if (!c || !wantSet.has(c)) { dropped++; return false; }
      return true;
    });
    if (dropped > 0) {
      console.log(`[predictAbroad] country-filter: dropped ${dropped}/${beforeCount} unis (kept countries: ${profile.preferredCountries.join(', ')})`);
    }
  }

  result.telemetry = {
    wallClockMs: Date.now() - t0,
    mainCall: tel,
    stateVerified: false,
    abroadVerified: !!abroadInsights,
    anchorRowsUsed: anchorRowCount,
  };
  console.log(`[predictAbroad] DONE wall-clock=${result.telemetry.wallClockMs}ms anchorRows=${anchorRowCount} verified=${result.telemetry.abroadVerified} unisReturned=${result.universities?.length ?? 0}`);
  return result;
}

// ── Input sanitization ───────────────────────────────────────────────────────
// Profile fields are forwarded into a Gemini prompt via fillTemplate(). Without
// these guards a user could plant prompt-injection markers ("IGNORE PRIOR
// INSTRUCTIONS…") inside otherPreferences/state/category and steer the model.
// Allowlist enums where we can; for free text, length-cap and strip control
// chars + section-header words we use ourselves in prompts.json.

const ALLOWED_DESTINATIONS = new Set(['India', 'Abroad']);
const ALLOWED_CATEGORIES   = new Set(['OPEN', 'OBC', 'OBC-NCL', 'SC', 'ST', 'EWS', 'OPEN-PWD', 'OBC-PWD', 'SC-PWD', 'ST-PWD', 'EWS-PWD']);
const ALLOWED_GENDERS      = new Set(['Male', 'Female', '']);
// Section-header substrings we use in our own prompts. Reject input that tries
// to inject these — cheap defence, real attackers will encode/paraphrase but
// the obvious cases are blocked.
const PROMPT_INJECTION_MARKERS = [
  'ignore prior', 'ignore previous', 'disregard the above', 'system prompt',
  'critical rules', 'final check', 'mechanical tier gate', 'ui hygiene',
  '⚠️', '⛔',
];

function sanitizeFreeText(raw: any, maxLen: number): string {
  if (raw == null) return '';
  // Strip control characters (incl. zero-width / RTL-override tricks) and
  // collapse whitespace. NFKC would be ideal but isn't critical here.
  // eslint-disable-next-line no-control-regex
  let s = String(raw).replace(/[\x00-\x1F\x7F​-‏‪-‮]/g, ' ').replace(/\s+/g, ' ').trim();
  if (s.length > maxLen) s = s.slice(0, maxLen);
  return s;
}

function containsInjectionMarker(s: string): boolean {
  const low = s.toLowerCase();
  return PROMPT_INJECTION_MARKERS.some(m => low.includes(m));
}

function sanitizeStringArray(raw: any, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw.slice(0, maxItems)) {
    const s = sanitizeFreeText(item, maxLen);
    if (s) out.push(s);
  }
  return out;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => (
    c === '&' ? '&amp;' :
    c === '<' ? '&lt;' :
    c === '>' ? '&gt;' :
    c === '"' ? '&quot;' :
                '&#39;'
  ));
}

interface SanitizedProfile {
  destinationType: 'India' | 'Abroad';
  neetScore: number;
  neetRank: number;
  category: string;
  gender: string;
  domicileState: string;
  budgetInUSD: number;
  preferredCountries: string[];
  coursePreferences: string[];
  otherPreferences: string;
  sessionId: string | null;
}

function validateProfile(raw: any): { ok: true; profile: SanitizedProfile } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'Request body must be a JSON object.' };

  const destinationType = String(raw.destinationType || '');
  if (!ALLOWED_DESTINATIONS.has(destinationType)) {
    return { ok: false, error: 'destinationType must be "India" or "Abroad".' };
  }

  // Score: optional, but if present must be 0–720. Score=0 is treated as
  // "not provided" and we require a rank instead. Score below the NEET
  // qualifying floor is allowed (we surface a warning in predictAbroad).
  const neetScore = Number.isFinite(Number(raw.neetScore)) ? Number(raw.neetScore) : 0;
  if (neetScore < 0 || neetScore > 720) {
    return { ok: false, error: 'neetScore must be between 0 and 720.' };
  }
  const neetRank = Number.isFinite(Number(raw.neetRank)) ? Number(raw.neetRank) : 0;
  if (neetRank < 0 || neetRank > 3_000_000) {
    return { ok: false, error: 'neetRank must be between 0 and 3,000,000.' };
  }
  // For India we need either a meaningful score or a rank — otherwise we'd
  // produce recommendations against AIR 999,999 which is garbage in / garbage
  // out. Abroad is more lenient: score helps but isn't strictly required.
  if (destinationType === 'India' && neetScore < 1 && neetRank < 1) {
    return { ok: false, error: 'For India recommendations, provide either neetScore or neetRank.' };
  }

  // Normalise both spaces and underscores to hyphens. The UI dropdown uses
  // `OPEN_PWD`, `OBC_PWD`, etc. (HTML option values can't sensibly contain
  // hyphens that get url-encoded). Without this fold, every PwD-category
  // student gets a 400 because `OPEN_PWD` isn't in the allowlist.
  const category = String(raw.category || 'OPEN').toUpperCase().replace(/[\s_]+/g, '-');
  if (!ALLOWED_CATEGORIES.has(category)) {
    return { ok: false, error: `category must be one of: ${[...ALLOWED_CATEGORIES].join(', ')}.` };
  }

  const gender = String(raw.gender || '');
  if (!ALLOWED_GENDERS.has(gender)) {
    return { ok: false, error: 'gender must be "Male", "Female", or empty.' };
  }

  const domicileState = sanitizeFreeText(raw.domicileState, 60);
  const budgetInUSD = Math.max(0, Math.min(1_000_000, Number(raw.budgetInUSD) || 0));

  const preferredCountries = sanitizeStringArray(raw.preferredCountries, 12, 40);
  const coursePreferences  = sanitizeStringArray(raw.coursePreferences,  12, 40);
  const otherPreferences   = sanitizeFreeText(raw.otherPreferences, 400);

  if (containsInjectionMarker(otherPreferences) || containsInjectionMarker(domicileState)) {
    return { ok: false, error: 'Input contains disallowed content. Please rephrase your preferences in plain language.' };
  }

  return {
    ok: true,
    profile: {
      destinationType: destinationType as 'India' | 'Abroad',
      neetScore, neetRank, category, gender, domicileState, budgetInUSD,
      preferredCountries, coursePreferences, otherPreferences,
      sessionId: sanitizeSessionId(raw.sessionId),
    },
  };
}

// Keep telemetry server-side: useful for Mongo + logs, sensitive to leak in
// the response body (model name, exact USD cost, token counts = competitive
// intel + prompt-engineering surface). Detach before res.json().
function detachTelemetry(result: any): { telemetry: any | null; clientResult: any } {
  if (!result || typeof result !== 'object') return { telemetry: null, clientResult: result };
  const { telemetry, ...rest } = result;
  return { telemetry: telemetry ?? null, clientResult: rest };
}

// ── Routes ───────────────────────────────────────────────────────────────────

// Health check probes the things that actually need to be up for the
// predictor to serve a request: NEET CSV data, abroad anchor data, and
// Mongo (if persistence is configured). Returns 503 if any required
// component is missing/down so orchestrators (Docker, Kubernetes, Cloud Run)
// stop routing traffic to a wedged container instead of accepting requests
// that would 500 internally.
app.get('/api/health', async (_req, res) => {
  const checks: Record<string, any> = {
    cutoffYears:     CUTOFF_YEARS,
    latestCutoff:    LATEST_CUTOFF_YEAR,
    cutoffRows:      LATEST_CUTOFF_ROWS.length,
    abroadAnchors:   ABROAD_UNIS.length,
    abroadRefDate:   ABROAD_REFERENCE_DATE,
    predictionYear:  PREDICTION_YEAR,
    today:           todayISO(),
    mongoConfigured: !!MONGODB_URI,
    mongoConnected:  null as boolean | null,
  };

  let mongoOk = true;
  if (MONGODB_URI && recommendationsCollection) {
    try {
      // Cheap round-trip — admin().ping() with a short timeout. If Mongo is
      // wedged we don't want healthcheck itself to hang the orchestrator.
      await Promise.race([
        recommendationsCollection.estimatedDocumentCount(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('mongo ping timeout')), 2000)),
      ]);
      checks.mongoConnected = true;
    } catch (e: any) {
      checks.mongoConnected = false;
      checks.mongoError = e?.message || String(e);
      mongoOk = false;
    }
  } else if (MONGODB_URI) {
    // URI configured but collection handle never came up — initMongo is
    // either still in-flight (cold start) or failed silently.
    checks.mongoConnected = false;
    mongoOk = false;
  }

  const dataOk = LATEST_CUTOFF_ROWS.length > 0 && ABROAD_UNIS.length > 0;
  const ready  = dataOk && mongoOk;
  res.status(ready ? 200 : 503).json({
    status: ready ? 'ok' : 'degraded',
    ...checks,
  });
});

app.post('/api/predict', predictLimiter, async (req, res) => {
  const reqStart = Date.now();
  const reqId = String(res.locals.requestId || randomUUID()).slice(0, 8);

  // Daily-spend circuit breaker. If today's accumulated cost has hit the cap,
  // refuse new predictions until UTC rollover. Catches a stuck loop / scraper
  // before it burns the monthly budget. Cap is set via DAILY_USD_CAP env var.
  if (isOverDailyCap()) {
    console.warn(`[predict #${reqId}] rejected: daily spend cap $${DAILY_USD_CAP} reached (today=$${spendTracker.totalUSD.toFixed(4)})`);
    return res.status(503).json({
      error: 'Service is temporarily over today\'s usage cap. Please try again tomorrow or contact support.',
      requestId: reqId,
    });
  }

  const validation = validateProfile(req.body);
  if (validation.ok === false) {
    const errMsg = (validation as { ok: false; error: string }).error;
    console.warn(`[predict #${reqId}] rejected: ${errMsg}`);
    return res.status(400).json({ error: errMsg, requestId: reqId });
  }
  const profile = (validation as { ok: true; profile: SanitizedProfile }).profile;

  console.log(`\n┌─ [predict #${reqId}] received ─────────────────────────────────`);
  console.log(`│  destination=${profile.destinationType} score=${profile.neetScore || '-'} rank=${profile.neetRank || '-'} category=${profile.category} state=${profile.domicileState || '-'} budgetUSD=${profile.budgetInUSD || '-'} gender=${profile.gender || '-'} sessionId=${profile.sessionId ? profile.sessionId.slice(0, 8) + '…' : '-'}`);
  try {
    const result =
      profile.destinationType === 'India'
        ? await predictIndia(profile)
        : await predictAbroad(profile);

    const { telemetry, clientResult } = detachTelemetry(result);
    // Diagnostic: ?debug=1 returns telemetry inline. Internal/dev use only —
    // strip before shipping if it ever leaks into production paths.
    const debugMode = String((req.query?.debug ?? '')) === '1';
    res.json(debugMode
      ? { ...clientResult, requestId: reqId, _telemetry: telemetry, _anchorPoolSummary: result?._anchorPoolSummary, _validatorDetails: result?._validatorDetails }
      : { ...clientResult, requestId: reqId });
    const ms = Date.now() - reqStart;
    console.log(`└─ [predict #${reqId}] sent ${result?.universities?.length ?? 0} unis in ${ms}ms ──────────\n`);
    // Persist the recommendation AFTER the response is sent — never blocks UX.
    // Telemetry is preserved for Mongo so we keep cost/token visibility internally.
    recordRecommendation(profile, { ...clientResult, telemetry, requestId: reqId });
  } catch (e: any) {
    const ms = Date.now() - reqStart;
    console.error(`└─ [predict #${reqId}] FAILED after ${ms}ms ─────────────────────`);
    console.error(`   message: ${e?.message || e}`);
    if (e?.stack) console.error(`   stack:\n${e.stack}`);
    if (e?.cause) console.error(`   cause:`, e.cause);
    if (e?.response) console.error(`   response:`, JSON.stringify(e.response).slice(0, 800));
    // Don't leak raw upstream error text to the client — could include API key
    // fragments, stack traces, internal URLs. Generic message + requestId.
    res.status(500).json({ error: 'Prediction failed. Please try again.', requestId: reqId });
  }
});

// ── Contact-lead capture ─────────────────────────────────────────────────────
// Visitor fills the "Get Free Counselling" modal → name/email/phone/message
// land here. Optional `linkedRecommendation` carries the profile + result
// the visitor was looking at when they decided to reach out (browser sends
// what's in localStorage). We DO await this insert because the user is
// expecting confirmation that their enquiry was received.
function isValidEmail(s: string): boolean {
  // Basic shape + reject obvious disposable patterns. Not a full DNS check.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) return false;
  const low = s.toLowerCase();
  // Truncate at @ so domain check is unambiguous
  const domain = low.split('@')[1] || '';
  const DISPOSABLE = ['mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com', 'yopmail.com', 'sharklasers.com', 'throwaway.email'];
  if (DISPOSABLE.some(d => domain === d || domain.endsWith('.' + d))) return false;
  return true;
}
function normalizePhone(s: string): string {
  return (s || '').replace(/[^\d+]/g, '');
}

// Cap on the linkedRecommendation snapshot — anything larger than this is
// suspicious (the legitimate snapshot is ~2-4KB). Stops a malicious browser
// stuffing 100KB of nested JSON into a lead doc.
const MAX_LINKED_REC_BYTES = 8 * 1024;

// ─── Lead-notification email (AWS SES via nodemailer) ─────────────────────
// Two emails fire on every successful /api/lead: a thank-you to the student
// and a notification to TEAM_EMAIL with the full lead context. Both are
// awaited (the user's browser shows the success modal only after dispatch),
// but a send failure never fails the lead — Mongo is the source of truth.

const SES_SMTP_USER = process.env.SES_SMTP_USER || '';
const SES_SMTP_PASS = process.env.SES_SMTP_PASS || '';
const SES_SMTP_HOST = process.env.SES_SMTP_HOST || 'email-smtp.ap-south-1.amazonaws.com';
const SES_SMTP_PORT = parseInt(process.env.SES_SMTP_PORT || '587', 10);
const FROM_NAME     = process.env.FROM_NAME  || 'Vidysea MBBS Counselling';
const FROM_EMAIL    = process.env.FROM_EMAIL || 'no-reply@vidysea.com';
const TEAM_EMAIL    = (process.env.TEAM_EMAIL || 'umeshsugara@vidysea.com')
  .split(',').map(s => s.trim()).filter(Boolean);

let mailTransporter: Transporter | null = null;
if (SES_SMTP_USER && SES_SMTP_PASS) {
  mailTransporter = nodemailer.createTransport({
    host: SES_SMTP_HOST,
    port: SES_SMTP_PORT,
    secure: SES_SMTP_PORT === 465,        // SES STARTTLS on 587, implicit TLS on 465
    auth: { user: SES_SMTP_USER, pass: SES_SMTP_PASS },
  });
  // Verify lazily on first send; just log that the transport is configured.
  console.log(`[mail] SES SMTP configured (${SES_SMTP_HOST}:${SES_SMTP_PORT}, from=${FROM_EMAIL})`);
} else {
  console.warn('[mail] SES_SMTP_USER/PASS not set — lead emails disabled (silent no-op).');
}

const FROM_HEADER = `"${FROM_NAME}" <${FROM_EMAIL}>`;

function fmtLeadList(items: Array<[string, string]>): { html: string; text: string } {
  const rows = items
    .filter(([, v]) => v && v.trim())
    .map(([k, v]) => [escapeHtml(k), escapeHtml(v)]);
  const html =
    '<table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px;">' +
    rows.map(([k, v]) =>
      `<tr><td style="padding:6px 14px 6px 0;color:#555;vertical-align:top;"><b>${k}</b></td>` +
      `<td style="padding:6px 0;color:#111;">${v}</td></tr>`
    ).join('') +
    '</table>';
  const text = rows.map(([k, v]) => `${k}: ${v}`).join('\n');
  return { html, text };
}

interface LeadEmailContext {
  name: string;
  email: string;
  phone: string;
  message: string;
  source: string;
  neetYear: string;
  wantsAbroad: boolean;
  sessionId: string;
  leadId: string;
  linkedRecommendation: any;
}

function buildUserConfirmation(ctx: LeadEmailContext): { subject: string; html: string; text: string } {
  const firstName = (ctx.name || 'there').split(/\s+/)[0];
  const picks: Array<{ name: string; country: string; tier: string }> =
    Array.isArray(ctx.linkedRecommendation?.universitiesPicked)
      ? ctx.linkedRecommendation.universitiesPicked.slice(0, 3)
      : [];
  const picksHtml = picks.length
    ? `<p style="font-size:14px;color:#333;margin:16px 0 8px;">Based on what you shared, we've already noted these colleges:</p>
       <ul style="font-size:14px;color:#333;padding-left:20px;margin:0 0 16px;">
         ${picks.map(p => `<li>${escapeHtml(p.name || '')}${p.country ? ` <span style="color:#888;">(${escapeHtml(p.country)})</span>` : ''}${p.tier ? ` — <i>${escapeHtml(p.tier)}</i>` : ''}</li>`).join('')}
       </ul>`
    : '';
  const subject = 'Thanks for reaching out — Vidysea MBBS Counselling';
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px;background:#ffffff;color:#111;">
      <div style="font-weight:bold;font-size:13px;color:#1f4ed8;letter-spacing:1px;margin-bottom:16px;">VIDYSEA · MBBS COUNSELLING</div>
      <p style="font-size:16px;margin:0 0 12px;">Hi ${escapeHtml(firstName)},</p>
      <p style="font-size:14px;line-height:1.55;color:#333;margin:0 0 14px;">
        Thanks for sharing your details with us. Our counselling team has received your enquiry and will reach out within
        <b>24 working hours</b> to walk you through your MBBS options — both in India and abroad — based on your NEET profile.
      </p>
      ${picksHtml}
      <p style="font-size:14px;line-height:1.55;color:#333;margin:14px 0;">
        If you'd like to talk sooner, you can reply directly to this email or write to us at
        <a href="mailto:product@vidysea.com" style="color:#1f4ed8;">product@vidysea.com</a>.
      </p>
      <p style="font-size:13px;color:#888;margin:24px 0 0;">— Team Vidysea</p>
      <p style="font-size:11px;color:#aaa;margin-top:18px;border-top:1px solid #eee;padding-top:10px;">
        Reference: ${escapeHtml(ctx.leadId)}
      </p>
    </div>`;
  const text =
`Hi ${firstName},

Thanks for sharing your details with us. Our counselling team has received your enquiry and will reach out within 24 working hours to walk you through your MBBS options — both in India and abroad — based on your NEET profile.

${picks.length ? 'Colleges noted:\n' + picks.map(p => `  - ${p.name}${p.country ? ` (${p.country})` : ''}${p.tier ? ` — ${p.tier}` : ''}`).join('\n') + '\n\n' : ''}If you'd like to talk sooner, reply to this email or write to product@vidysea.com.

— Team Vidysea
Reference: ${ctx.leadId}`;
  return { subject, html, text };
}

function buildTeamNotification(ctx: LeadEmailContext): { subject: string; html: string; text: string } {
  const profile = ctx.linkedRecommendation?.profile || {};
  const picks: Array<{ name: string; country: string; tier: string }> =
    Array.isArray(ctx.linkedRecommendation?.universitiesPicked)
      ? ctx.linkedRecommendation.universitiesPicked
      : [];
  const subject = `New lead: ${ctx.name || '(no name)'} · ${ctx.source}${ctx.email ? ` · ${ctx.email}` : ''}`;

  const profileFields: Array<[string, string]> = [
    ['Destination',  String(profile.destinationType || '')],
    ['NEET score',   profile.score != null ? String(profile.score) : ''],
    ['NEET rank',    profile.rank  != null ? String(profile.rank)  : ''],
    ['Category',     String(profile.category || '')],
    ['Gender',       String(profile.gender   || '')],
    ['Home state',   String(profile.homeState || '')],
    ['Budget INR',   profile.budgetInrLakh != null ? `${profile.budgetInrLakh} L` : ''],
    ['Pref. countries', Array.isArray(profile.preferredCountries) ? profile.preferredCountries.join(', ') : ''],
  ];
  const profileBlock = fmtLeadList(profileFields);

  const leadFields: Array<[string, string]> = [
    ['Name',        ctx.name],
    ['Email',       ctx.email],
    ['Phone',       ctx.phone],
    ['Source',      ctx.source],
    ['NEET year',   ctx.neetYear],
    ['Wants abroad', ctx.wantsAbroad ? 'Yes' : 'No'],
    ['Message',     ctx.message],
    ['Session ID',  ctx.sessionId],
    ['Lead ID',     ctx.leadId],
  ];
  const leadBlock = fmtLeadList(leadFields);

  const picksHtml = picks.length
    ? `<h3 style="font-family:Arial,sans-serif;font-size:14px;color:#111;margin:18px 0 6px;">Colleges they were shown</h3>
       <ol style="font-family:Arial,sans-serif;font-size:13px;color:#333;padding-left:22px;margin:0;">
         ${picks.map(p => `<li>${escapeHtml(p.name || '')}${p.country ? ` <span style="color:#888;">(${escapeHtml(p.country)})</span>` : ''}${p.tier ? ` — <i>${escapeHtml(p.tier)}</i>` : ''}</li>`).join('')}
       </ol>`
    : '';

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;padding:24px;background:#ffffff;color:#111;">
      <h2 style="font-size:18px;margin:0 0 4px;color:#1f4ed8;">New lead from MBBS Predictor</h2>
      <p style="font-size:13px;color:#666;margin:0 0 18px;">${escapeHtml(nowIST())}</p>

      <h3 style="font-size:14px;color:#111;margin:0 0 6px;">Lead details</h3>
      ${leadBlock.html}

      <h3 style="font-size:14px;color:#111;margin:18px 0 6px;">Predictor profile</h3>
      ${profileBlock.html}

      ${picksHtml}

      <p style="font-size:12px;color:#888;margin:24px 0 0;border-top:1px solid #eee;padding-top:10px;">
        Join with the user's full prediction history in Mongo via <code>sessionId = ${escapeHtml(ctx.sessionId)}</code>.
      </p>
    </div>`;

  const text =
`New lead from MBBS Predictor — ${nowIST()}

LEAD
${leadBlock.text}

PROFILE
${profileBlock.text}
${picks.length ? '\nCOLLEGES SHOWN\n' + picks.map((p, i) => `  ${i + 1}. ${p.name}${p.country ? ` (${p.country})` : ''}${p.tier ? ` — ${p.tier}` : ''}`).join('\n') + '\n' : ''}
Join with the user's full prediction history in Mongo via sessionId = ${ctx.sessionId}`;

  return { subject, html, text };
}

async function sendLeadEmails(ctx: LeadEmailContext): Promise<void> {
  if (!mailTransporter) return;                        // disabled — silent
  const tasks: Array<Promise<any>> = [];

  // Team notification — always send if TEAM_EMAIL is set.
  if (TEAM_EMAIL.length) {
    const m = buildTeamNotification(ctx);
    tasks.push(
      mailTransporter.sendMail({
        from: FROM_HEADER,
        to: TEAM_EMAIL,
        replyTo: ctx.email || undefined,                // team can reply directly to the student
        subject: m.subject,
        html: m.html,
        text: m.text,
      }).then(
        info => console.log(`[mail] team notify → ${TEAM_EMAIL.join(',')} | ${info.messageId}`),
        err  => console.error(`[mail] team notify FAILED:`, err?.message || err)
      )
    );
  }

  // Student confirmation — only if they gave us a real email.
  if (ctx.email && isValidEmail(ctx.email)) {
    const m = buildUserConfirmation(ctx);
    tasks.push(
      mailTransporter.sendMail({
        from: FROM_HEADER,
        to: ctx.email,
        subject: m.subject,
        html: m.html,
        text: m.text,
      }).then(
        info => console.log(`[mail] user confirm → ${ctx.email} | ${info.messageId}`),
        err  => console.error(`[mail] user confirm FAILED for ${ctx.email}:`, err?.message || err)
      )
    );
  }

  await Promise.allSettled(tasks);
}

app.post('/api/lead', leadLimiter, async (req, res) => {
  const body = req.body || {};

  // Honeypot: a hidden form field name that real users never fill (CSS-hidden
  // in the HTML). Bots that auto-fill all form inputs will populate it. If
  // it's non-empty, silently 200 without writing — no signal to the bot that
  // detection happened.
  if (body.website || body.url || body.fax) {
    console.warn('[/api/lead] honeypot triggered — silently dropping');
    return res.json({ ok: true, id: null });
  }

  const name    = sanitizeFreeText(body.name,    200);
  const email   = sanitizeFreeText(body.email,   200);
  const phone   = normalizePhone(String(body.phone || '')).slice(0, 32);
  const message = sanitizeFreeText(body.message, 2000);
  const source  = sanitizeFreeText(body.source,  60) || 'unknown';
  const sessionId = sanitizeSessionId(body.sessionId);
  const neetYear  = sanitizeFreeText(body.neetYear, 30);
  const wantsAbroad = !!body.wantsAbroad;

  // Validation: require name + (email OR phone). Both is best.
  if (!name || (!email && !phone)) {
    return res.status(400).json({ error: 'Name and at least one of email or phone are required.' });
  }
  if (email && !isValidEmail(email)) {
    return res.status(400).json({ error: 'Email looks invalid.' });
  }
  if (phone && phone.replace(/\D/g, '').length < 7) {
    return res.status(400).json({ error: 'Phone looks invalid.' });
  }

  // Cap the linked snapshot so attackers can't bloat Mongo via this field.
  let linkedRecommendation: any = null;
  if (body.linkedRecommendation && typeof body.linkedRecommendation === 'object') {
    try {
      const raw = JSON.stringify(body.linkedRecommendation);
      if (raw.length <= MAX_LINKED_REC_BYTES) {
        linkedRecommendation = body.linkedRecommendation;
      } else {
        console.warn(`[/api/lead] linkedRecommendation oversize (${raw.length} bytes) — dropped`);
      }
    } catch { /* malformed — drop */ }
  }

  if (!leadsCollection) {
    // Boot-time connection may have failed (cold-start race, transient DNS,
    // IP allowlist pending). Try once more before giving up so a single boot
    // hiccup doesn't permanently disable lead capture for this process.
    if (MONGODB_URI) {
      console.warn('[/api/lead] leadsCollection null — attempting one-shot reconnect');
      await initMongo();
    }
    if (!leadsCollection) {
      console.error('[/api/lead] Mongo unavailable, lead NOT persisted:', { name, email, phone });
      return res.status(503).json({ error: 'Submission service is temporarily unavailable. Please try again or call us directly.' });
    }
  }

  try {
    const doc = {
      timestamp: nowIST(),       // ISO 8601 +05:30 (IST)
      sessionId,                  // joins this lead to the user's recommendations
      // HTML-escape free-text fields at write time so any future admin
      // dashboard that renders them unescaped can't be XSS'd from a lead.
      name:    escapeHtml(name),
      email,                                   // shape-validated, no HTML
      phone,                                   // digits + plus only
      message: escapeHtml(message),
      source:  escapeHtml(source),
      neetYear, wantsAbroad,
      requestId: String(res.locals.requestId || ''),
      // Soft link to the recommendation context (snapshot only; full result is
      // already in the recommendations collection — joinable by sessionId).
      linkedRecommendation: linkedRecommendation
        ? {
            profile: linkedRecommendation.profile || null,
            universitiesPicked: Array.isArray(linkedRecommendation?.result?.universities)
              ? linkedRecommendation.result.universities.map((u: any) => ({
                  name: u?.name ? escapeHtml(String(u.name)) : null,
                  country: u?.country ? escapeHtml(String(u.country)) : null,
                  tier: u?.tier ? escapeHtml(String(u.tier)) : null,
                }))
              : null,
          }
        : null,
    };
    const r = await leadsCollection.insertOne(doc);
    const leadId = r.insertedId.toHexString();
    console.log(`[mongo] lead inserted: ${leadId} (source=${source}, email=${email || '-'}, phone=${phone || '-'})`);

    // Awaited per the user's choice — the success modal should render only
    // after dispatch attempts complete. sendLeadEmails internally uses
    // Promise.allSettled and never throws, so an SES outage does not turn a
    // saved lead into a 5xx for the student.
    try {
      await sendLeadEmails({
        name, email, phone, message, source, neetYear, wantsAbroad,
        sessionId, leadId, linkedRecommendation,
      });
    } catch (mailErr: any) {
      console.error('[/api/lead] email dispatch unexpected error:', mailErr?.message || mailErr);
    }

    res.json({ ok: true, id: leadId });
  } catch (e: any) {
    console.error('[/api/lead] insert failed:', e?.message || e);
    res.status(500).json({ error: 'Could not record your enquiry. Please try again.' });
  }
});

initMongo();  // best-effort; predictor works regardless

const httpServer = app.listen(PORT, () => {
  console.log('━'.repeat(72));
  console.log(`[server] listening on http://localhost:${PORT}`);
  console.log(`[server] routes: GET /api/health · POST /api/predict · POST /api/lead`);
  console.log(`[server] frontend served from: ${join(ROOT, LANDING_HTML)}`);
  console.log('━'.repeat(72));
});

// Graceful shutdown — without this, SIGTERM (Docker stop, K8s rollout, Cloud
// Run revision swap) drops in-flight requests on the floor and never closes
// the Mongo socket. We give the HTTP server up to 10s to drain, then close
// Mongo, then exit. If anything hangs past 15s, hard-exit so the orchestrator
// doesn't wait forever.
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received — draining`);
  const hardExit = setTimeout(() => {
    console.error('[shutdown] timed out after 15s — forcing exit');
    process.exit(1);
  }, 15_000);
  hardExit.unref();
  try {
    await new Promise<void>(resolve => httpServer.close(() => resolve()));
    console.log('[shutdown] http server closed');
    if (mongoClient) {
      await mongoClient.close();
      console.log('[shutdown] mongo client closed');
    }
    clearTimeout(hardExit);
    process.exit(0);
  } catch (e: any) {
    console.error('[shutdown] error during drain:', e?.message || e);
    process.exit(1);
  }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
