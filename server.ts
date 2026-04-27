import express from 'express';
import { GoogleGenAI, Type } from '@google/genai';
import dotenv from 'dotenv';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parse } from 'csv-parse/sync';

dotenv.config({ path: '.env' });
dotenv.config({ path: '.env.local', override: true });

const app = express();
app.use(express.json());

const PORT = parseInt(process.env.PORT || '3000', 10);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;

// ── Static frontend ──────────────────────────────────────────────────────────

const ROOT = process.cwd();
const LANDING_HTML = 'mbbs_landing_page_with tool.html';

app.get('/', (_req, res) => res.sendFile(join(ROOT, LANDING_HTML)));
app.use(express.static(ROOT, { index: false }));

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
    rows.push({
      institute: instituteShortName(instituteRaw),
      state: extractState(instituteRaw),
      course,
      quota: norm(r['Allotted Quota']),
      category: norm(r['Allotted Category']),
      closingRank: closing,
    });
  }
  return rows;
}

const cutoffs2024 = loadCutoffs(2024);
const cutoffs2023 = loadCutoffs(2023);
// Resolved at startup: use the most recent year we have data for
const LATEST_CUTOFF_YEAR = cutoffs2024.length ? 2024 : 2023;
console.log(`[CSV] Loaded ${cutoffs2024.length} MBBS rows from 2024, ${cutoffs2023.length} from 2023`);

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

interface CallTelemetry {
  label: string;
  latencyMs: number;
  promptTokens: number;
  outputTokens: number;
  totalTokens: number;
  estCostUSD: number;
  grounded: boolean;
}

async function callGemini(
  ai: GoogleGenAI,
  label: string,
  request: any,
  grounded = false,
): Promise<{ resp: any; tel: CallTelemetry }> {
  const t0 = Date.now();
  const resp = await ai.models.generateContent({ model: GEMINI_MODEL, ...request });
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

  console.log(
    `[gemini] ${label} model=${GEMINI_MODEL} ${latencyMs}ms ` +
    `in=${promptTokens} out=${outputTokens} total=${totalTokens} ` +
    `cost=$${estCostUSD.toFixed(5)}${grounded ? ' [grounded]' : ''}`,
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
  2023: { weight: 0.35, reliability: 0.95 },
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

// Competition grows ~5%/yr → forward-project ranks to the prediction year
const COMPETITION_GROWTH_PER_YEAR = 0.05;
const PREDICTION_YEAR = 2026;

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
  const cutoffs = cutoffs2024.length ? cutoffs2024 : cutoffs2023;

  const govtAiqRows = cutoffs.filter(r =>
    ALL_INDIA_QUOTAS.has(r.quota) &&
    r.quota !== 'Deemed/Paid Seats Quota' &&
    categoryMatches(r.category, eligible)
  );
  const deemedRows = cutoffs.filter(r =>
    r.quota === 'Deemed/Paid Seats Quota' &&
    categoryMatches(r.category, eligible)
  );
  const stateRows = cutoffs.filter(r =>
    !ALL_INDIA_QUOTAS.has(r.quota) && categoryMatches(r.category, eligible) &&
    r.state && r.state.toLowerCase() === (state || '').toLowerCase()
  );

  const avgPct = (rows: typeof cutoffs): number =>
    rows.length === 0 ? 0 :
    Math.round(rows.reduce((s, r) => s + admissionProbability(rankRange, r.closingRank), 0) / rows.length * 100);

  // YoY drift buffer: closing-rank data is from LATEST_CUTOFF_YEAR (2024).
  // For 2026 predictions, seat expansion (~15-20 new colleges/year) tends to
  // push closing ranks slightly higher (i.e. easier for any given student).
  // A 10% buffer in the student's favor is a conservative, honest correction
  // for stale-anchor data. Compounds linearly with the cutoff staleness gap.
  const cutoffStaleYears = Math.max(0, PREDICTION_YEAR - LATEST_CUTOFF_YEAR);
  const yoyBuffer = 1 + 0.05 * cutoffStaleYears;  // ~10% buffer at 2-year gap

  const govtAiqRaw  = Math.min(100, avgPct(govtAiqRows) * yoyBuffer);
  const deemedRaw   = Math.min(100, avgPct(deemedRows) * yoyBuffer);
  const stateRaw    = Math.min(100, avgPct(stateRows) * yoyBuffer);

  // Govt AIQ: extremely competitive nationwide; demand discount 0.40, cap 20%
  const aiq         = Math.min(20, Math.round(govtAiqRaw * 0.40));
  // State quota: state-level competition; demand discount 0.70, cap 65%.
  // MCC CSV has no state quota rows — we estimate from AIQ raw probability:
  // state quota has 85% of seats but is state-domicile-only (much smaller pool),
  // net effect ≈ 65% of AIQ raw accessibility after state demand discount.
  const stateCalib  = stateRows.length > 0
    ? Math.min(75, Math.round(stateRaw * 0.70))
    : Math.min(65, Math.round(govtAiqRaw * 0.65));
  // Deemed: management/private seats are less competitive; admission probability is high
  // Budget is the real gate, not rank — reported separately in prompt
  const deemed      = Math.min(90, deemedRows.length > 0 ? deemedRaw : Math.min(90, govtAiqRaw + 35));

  return {
    aiqMbbs:          aiq,
    stateQuotaMbbs:   stateCalib,
    deemedPrivate:    deemed,
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
  // CSV uses "Open"/"OBC"/"SC"/"ST"/"EWS" + " PwD" variants, normalize to upper.
  const c = rowCategory.toUpperCase().replace(/PWD/g, 'PWD');
  for (const e of eligible) if (c === e || c === e.replace('OPEN', 'OPEN')) return true;
  // Fallback substring (handles odd whitespace)
  for (const e of eligible) if (c.replace(/\s+/g, ' ') === e.replace(/\s+/g, ' ')) return true;
  return false;
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

function tierName(userRank: number, closing: number): 'Safe' | 'Good' | 'Reach' | 'Stretch' | null {
  if (userRank <= closing * 0.85) return 'Safe';   // comfortably in range
  if (userRank <= closing * 1.10) return 'Good';   // within year-on-year variation
  if (userRank <= closing * 1.40) return 'Reach';  // aspirational with some chance
  if (userRank <= closing * 2.50) return 'Stretch'; // unlikely — cutoff must shift significantly
  return null;  // too far, exclude from Pass A
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
  const cutoffs = cutoffs2024.length ? cutoffs2024 : cutoffs2023;

  // Group by (institute, quota, category) → keep min closing rank
  const groups = new Map<string, CutoffRow>();
  for (const r of cutoffs) {
    if (!isQuotaAccessible(r.quota, userState, r.state)) continue;
    if (!categoryMatches(r.category, eligible)) continue;
    const key = `${r.institute}||${r.quota}||${r.category}`;
    const ex = groups.get(key);
    if (!ex || r.closingRank < ex.closingRank) groups.set(key, r);
  }

  // Budget guard: exclude deemed seats if student can't afford them
  const budgetUSD = parseInt(profile.budgetInUSD || '0', 10);
  const deemedEligible = budgetUSD > 0 ? Math.round(budgetUSD * 83.5) >= 5_000_000 : true;

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

  // ── Pass B: extreme stretch fallback (closing × 2.5–3.0) ──
  // tierName returns null beyond 2.5× — these are genuinely unlikely, always Stretch
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

  // ── Pass C: stretch fallback — colleges with the highest closing ranks (most permissive) ──
  if (picks.length < 10) {
    const usedInstitutes = new Set(picks.map(p => p.institute));
    const passC: Array<CutoffRow & { tier: Tier }> = [];
    for (const g of allEligible) {
      if (usedInstitutes.has(g.institute)) continue;
      passC.push({ ...g, tier: 'Stretch' });
    }
    const passCDedup = dedupeByInstitute(passC).sort((a, b) => b.closingRank - a.closingRank);
    picks = picks.concat(passCDedup.slice(0, 10 - picks.length));
  }

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

function extractContextRows(userRank: number, category: string, state: string, limit = 25): string {
  const eligible = eligibleCategories(category);
  const cutoffs = cutoffs2024.length ? cutoffs2024 : cutoffs2023;
  const rows = cutoffs
    .filter(r => isQuotaAccessible(r.quota, state, r.state) && categoryMatches(r.category, eligible))
    .sort((a, b) => Math.abs(a.closingRank - userRank) - Math.abs(b.closingRank - userRank))
    .slice(0, limit);
  if (!rows.length) return `No matching rows found in MCC ${LATEST_CUTOFF_YEAR} cutoff data.`;
  // Stamp every row with the source year so Gemini cannot mistake stale anchors
  // for current-year data. Closing ranks here are CATEGORY-specific (the row's
  // category column is what the closing rank applies to).
  return rows.map(r =>
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
): Promise<StateQuotaInsights | null> {
  if (!state || state === 'not specified') return null;

  // The verifier compares student AIR (the rank on the NTA scorecard) to
  // the AIR of the last admitted student in the relevant quota+category.
  // Public sources (Shiksha, Careers360, CollegeDunia, MCC) all publish
  // closing ranks in AIR form. One coordinate system, no conversion.
  const prompt = fillTemplate(PROMPTS.india.stateQuotaVerification, {
    today: '2026-04-26',
    rankRangeLow:  rankRange.low.toLocaleString('en-IN'),
    rankRangeMid:  rankRange.mid.toLocaleString('en-IN'),
    rankRangeHigh: rankRange.high.toLocaleString('en-IN'),
    userCategory,
    state,
  });

  try {
    // Grounding cannot be combined with responseSchema in the Gemini API,
    // so we instruct the model to return raw JSON and parse manually.
    const { resp } = await callGemini(ai, `verifyStateQuota[${state}]`, {
      contents: prompt,
      config: { tools: [{ googleSearch: {} }] },
    }, /* grounded */ true);

    let text = (resp.text || '').trim();
    text = text.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();

    const parsed = JSON.parse(text) as StateQuotaInsights;
    console.log(`[verifyStateQuota] ${state}: ${parsed.stateColleges?.length || 0} colleges, ${parsed.sources?.length || 0} sources`);
    return parsed;
  } catch (err: any) {
    console.error('[verifyStateQuota] failed:', err?.message || err);
    return null;
  }
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

  // ── CSV context rows + computed probabilities ─────────────────────────────
  const contextRows = extractContextRows(userRank, userCategory, profile.domicileState || '');
  const probs = computeQuotaProbabilities(rankRange, userCategory, profile.domicileState || '');
  const state = profile.domicileState || 'not specified';
  const score = profile.neetScore ? `NEET Score ${profile.neetScore}` : '';
  const budgetUSD = parseInt(profile.budgetInUSD || '0');
  const budgetINRNum = Math.round(budgetUSD * 83.5);
  const budgetINRL = Math.round(budgetINRNum / 100000);
  const budgetINR = budgetUSD ? `₹${budgetINRL}L total (~$${budgetUSD})` : 'not specified';
  // ₹50L is the practical floor for any deemed/private MBBS
  const deemedEligible = budgetINRNum >= 5_000_000;

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
    today: '2026-04-26',
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
    dataYearNote,
  }).trim();

  // Fire main recommendation + state-quota verification in parallel.
  // The verification is best-effort: if it fails, the main result is still returned.
  const t0 = Date.now();
  const mainCall = callGemini(ai, 'predictIndia.main', {
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      responseSchema,
    },
  });
  const verifyCall = verifyStateQuota(ai, rankRange, userCategory, state);

  try {
    const [{ resp, tel }, stateQuotaInsights] = await Promise.all([mainCall, verifyCall]);
    const result = JSON.parse(resp.text || '{"universities":[],"analysis":""}');
    if (stateQuotaInsights) result.stateQuotaInsights = stateQuotaInsights;
    // Telemetry summary for the whole India request — wall-clock includes both parallel calls
    result.telemetry = {
      wallClockMs: Date.now() - t0,
      mainCall: tel,
      stateVerified: !!stateQuotaInsights,
    };
    console.log(`[predictIndia] total wall-clock ${result.telemetry.wallClockMs}ms (state verified: ${result.telemetry.stateVerified})`);
    return result;
  } catch (err) {
    console.error('[predictIndia] Gemini call failed, falling back to CSV:', err);
    return predictIndiaCsv(profile);
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

  const prompt = fillTemplate(PROMPTS.abroad.main, {
    today: '2026-04-25',
    score, rank, budget, countries,
    otherPrefsOrNone: otherPrefs || 'none',
    indianFoodNote,
  }).trim();

  const t0 = Date.now();
  const { resp, tel } = await callGemini(ai, 'predictAbroad', {
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      responseSchema,
    },
  });

  const result = JSON.parse(resp.text || '{"universities":[],"analysis":""}');
  result.telemetry = {
    wallClockMs: Date.now() - t0,
    mainCall: tel,
    stateVerified: false,
  };
  console.log(`[predictAbroad] total wall-clock ${result.telemetry.wallClockMs}ms`);
  return result;
}

// ── Routes ───────────────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    cutoffs_2024: cutoffs2024.length,
    cutoffs_2023: cutoffs2023.length,
  });
});

app.post('/api/predict', async (req, res) => {
  const profile = req.body;
  try {
    const result =
      profile.destinationType === 'India'
        ? await predictIndia(profile)
        : await predictAbroad(profile);
    res.json(result);
  } catch (e: any) {
    console.error('[/api/predict]', e);
    res.status(500).json({ error: e.message || 'Prediction failed' });
  }
});

app.listen(PORT, () => {
  console.log(`[Server] http://localhost:${PORT}`);
});
