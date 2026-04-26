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
console.log(`[CSV] Loaded ${cutoffs2024.length} MBBS rows from 2024, ${cutoffs2023.length} from 2023`);

// ── Score → Rank (NEET UG approximation) ─────────────────────────────────────
// Based on official NEET 2024 score-rank distribution. Piecewise linear.

const SCORE_RANK_TABLE: Array<[number, number]> = [
  [720, 1], [710, 50], [700, 200], [690, 600], [680, 1500],
  [670, 3000], [660, 5000], [650, 8000], [640, 12000], [630, 17000],
  [620, 24000], [610, 32000], [600, 42000], [590, 55000], [580, 70000],
  [570, 88000], [560, 110000], [550, 135000], [540, 165000], [520, 230000],
  [500, 305000], [480, 390000], [450, 525000], [400, 760000], [350, 980000],
  [300, 1180000], [200, 1400000], [100, 1550000],
];

const CATEGORY_RANK_MULT: Record<string, number> = {
  OPEN: 1.0, EWS: 1.05, OBC: 1.1, SC: 3.5, ST: 5.0,
};

function approximateRank(score: number, category: string): number {
  if (!score || score < 1) return 999999;
  const cat = (category || 'OPEN').toUpperCase().split(/[_\s]/)[0];
  const mult = CATEGORY_RANK_MULT[cat] ?? 1.0;
  for (let i = 0; i < SCORE_RANK_TABLE.length - 1; i++) {
    const [s1, r1] = SCORE_RANK_TABLE[i];
    const [s2, r2] = SCORE_RANK_TABLE[i + 1];
    if (score <= s1 && score >= s2) {
      const frac = (s1 - score) / (s1 - s2 || 1);
      const baseRank = r1 + frac * (r2 - r1);
      return Math.round(baseRank * mult);
    }
  }
  return Math.round(SCORE_RANK_TABLE[SCORE_RANK_TABLE.length - 1][1] * mult);
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

function tierName(userRank: number, closing: number): 'Safe' | 'Good' | 'Reach' | null {
  if (userRank <= closing * 0.85) return 'Safe';
  if (userRank <= closing * 1.10) return 'Good';
  if (userRank <= closing * 1.40) return 'Reach';
  return null;
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

// India MBBS fee profiles by quota (rough mid-points, 2024-25 data)
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
  if (tier === 'Safe') return 'Easy Admission · ' + (quota === 'All India' ? 'Govt Seat' : 'Affordable Pick');
  if (tier === 'Good') return 'Strong Match · ' + (quota === 'Deemed/Paid Seats Quota' ? 'Premium' : 'Balanced');
  if (tier === 'Reach') return 'Aspirational · Premium';
  return 'Stretch Pick · Backup Option';
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
    description: `${m.tier} tier match (NEET 2024 data). Closing rank ${m.closingRank.toLocaleString('en-IN')} for ${m.category} under ${m.quota}.`,
    quota: m.quota,
    tier: m.tier,
  };
}

async function predictIndia(profile: any) {
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

  const allEligible = [...groups.values()];

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

  // ── Pass B: extended reach (≤ closing × 3.0) ──
  if (picks.length < 10) {
    const usedInstitutes = new Set(picks.map(p => p.institute));
    const passB: Array<CutoffRow & { tier: Tier }> = [];
    for (const g of allEligible) {
      if (usedInstitutes.has(g.institute)) continue;
      if (userRank <= g.closingRank * 3.0) {
        passB.push({ ...g, tier: 'Reach' });
      }
    }
    const passBDedup = dedupeByInstitute(passB)
      .sort((a, b) => Math.abs(userRank - a.closingRank * 1.4) - Math.abs(userRank - b.closingRank * 1.4));
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
  lines.push(`Tier mix: ${safeCount} safe, ${goodCount} good, ${reachCount} reach, ${stretchCount} stretch picks across ${universities.length} colleges (NEET 2024 cutoff data).`);
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
    ? 'IMPORTANT: User wants Indian food / mess. Strongly prioritise universities in Russia, Philippines, Georgia, and Kyrgyzstan with established Indian student communities and Indian messes.'
    : '';

  const prompt = `
TODAY: 2026-04-25. You are an expert MBBS-abroad admission counsellor for Indian students (2026-27 intake).

Student profile:
- ${score} ${rank}
- Budget: ${budget}
- Preferred countries: ${countries}
- Other preferences: ${otherPrefs || 'none'}

${indianFoodNote}

Recommend EXACTLY 10 NMC-recognised MBBS universities abroad matching this profile. Mix Safe / Good / Reach picks. Cover at least 3 different countries unless the user limited the list.

For each university, return ALL required fields including the numeric tuitionFeeUSD and totalProgramCostUSD (these MUST be plain numbers, not strings — e.g. 4500, not "$4500"). The tier MUST be one of "Safe", "Good", or "Reach" assessed against this specific student profile (Safe = easy admission for this profile; Reach = aspirational). Aim for a balanced mix across the 10 picks. Use realistic 2025-26 figures based on published university data. The string annualTuitionFee / totalProgramCost should mirror the same value with USD label, e.g. "$4500 USD". NEET requirement reflects actual cutoff (most abroad MBBS just need NEET qualifying score). globalRank is a real ranking (QS / Times / country rank) with source. Specializations is a 3-5 item array. roiScore is "1"–"10" string. reputationScore is one short phrase like "Top 500 QS" or "Established 1930". bestFor MUST be one short label like "Budget · Russia", "Premium · Top 200 QS", "Easy Admission · Indian Community".

Analysis field: write 4–6 sentences (200–400 chars) covering: (1) profile fit summary, (2) country mix rationale, (3) budget realism check, (4) NMC recognition / FMGE preparation note, (5) one concrete next step. Avoid filler.
`.trim();

  const resp = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      responseSchema,
    },
  });

  return JSON.parse(resp.text || '{"universities":[],"analysis":""}');
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
