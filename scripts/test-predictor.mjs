// One-off test harness for /api/predict.
// Usage:  node scripts/test-predictor.mjs   (server must be running on :3000)

import { writeFileSync } from 'node:fs';

const BASE = process.env.PRED_BASE || 'http://localhost:3000';

const cases = [
  // ── India (12 cases varying score / category / state) ──
  { name: 'IN-720-OPEN',                profile: { destinationType: 'India', neetScore: 720, category: 'OPEN', domicileState: 'Maharashtra', budgetInUSD: '' } },
  { name: 'IN-680-OBC-TN',              profile: { destinationType: 'India', neetScore: 680, category: 'OBC',  domicileState: 'Tamil Nadu',   budgetInUSD: '30000' } },
  { name: 'IN-650-OPEN-KA',             profile: { destinationType: 'India', neetScore: 650, category: 'OPEN', domicileState: 'Karnataka',    budgetInUSD: '48000' } },
  { name: 'IN-620-EWS-DL',              profile: { destinationType: 'India', neetScore: 620, category: 'EWS',  domicileState: 'Delhi',        budgetInUSD: '18000' } },
  { name: 'IN-600-OPEN-MH',             profile: { destinationType: 'India', neetScore: 600, category: 'OPEN', domicileState: 'Maharashtra', budgetInUSD: '30000' } },
  { name: 'IN-580-SC-UP',               profile: { destinationType: 'India', neetScore: 580, category: 'SC',   domicileState: 'Uttar Pradesh', budgetInUSD: '' } },
  { name: 'IN-550-ST-OD',               profile: { destinationType: 'India', neetScore: 550, category: 'ST',   domicileState: 'Odisha',        budgetInUSD: '' } },
  { name: 'IN-500-OBC-RJ',              profile: { destinationType: 'India', neetScore: 500, category: 'OBC',  domicileState: 'Rajasthan',    budgetInUSD: '48000' } },
  { name: 'IN-450-OPEN-KL',             profile: { destinationType: 'India', neetScore: 450, category: 'OPEN', domicileState: 'Kerala',        budgetInUSD: '48000' } },
  { name: 'IN-400-OPEN-PB',             profile: { destinationType: 'India', neetScore: 400, category: 'OPEN', domicileState: 'Punjab',        budgetInUSD: '80000' } },
  { name: 'IN-350-EWS-WB',              profile: { destinationType: 'India', neetScore: 350, category: 'EWS',  domicileState: 'West Bengal',  budgetInUSD: '80000' } },
  { name: 'IN-280-OPEN-AP',             profile: { destinationType: 'India', neetScore: 280, category: 'OPEN', domicileState: 'Andhra Pradesh', budgetInUSD: '80000' } },

  // ── Edge cases (3) ──
  { name: 'EDGE-rank100-OPEN',          profile: { destinationType: 'India', neetRank: 100,    category: 'OPEN', domicileState: 'Delhi',       budgetInUSD: '' } },
  { name: 'EDGE-rank1.5M-OPEN',         profile: { destinationType: 'India', neetRank: 1500000, category: 'OPEN', domicileState: 'Maharashtra', budgetInUSD: '' } },
  { name: 'EDGE-OPEN_PWD-state',        profile: { destinationType: 'India', neetScore: 540, category: 'OPEN_PWD', domicileState: 'Karnataka', budgetInUSD: '30000' } },

  // ── Global (5) ──
  { name: 'GL-Russia-Georgia-30k',      profile: { destinationType: 'Global', neetScore: 600, budgetInUSD: '30000', preferredCountries: ['Russia','Georgia'],          otherPreferences: 'Indian food, English medium' } },
  { name: 'GL-Phil-Bang-18k',           profile: { destinationType: 'Global', neetScore: 540, budgetInUSD: '18000', preferredCountries: ['Philippines','Bangladesh'],   otherPreferences: 'Indian community' } },
  { name: 'GL-EU-Hungary-Poland-48k',   profile: { destinationType: 'Global', neetScore: 620, budgetInUSD: '48000', preferredCountries: ['Hungary','Poland'],           otherPreferences: 'Best EU clinical exposure' } },
  { name: 'GL-CIS-Kaz-Kyrg-30k',        profile: { destinationType: 'Global', neetScore: 500, budgetInUSD: '30000', preferredCountries: ['Kazakhstan','Kyrgyzstan'],    otherPreferences: '' } },
  { name: 'GL-OpenSearch-80k',          profile: { destinationType: 'Global', neetScore: 660, budgetInUSD: '80000', preferredCountries: [],                              otherPreferences: 'Top global ranking, English program' } },
];

const REQUIRED_FIELDS = [
  'name','country','continent','annualTuitionFee','totalProgramCost',
  'tuitionFeeUSD','totalProgramCostUSD','totalDurationYears','mediumOfInstruction',
  'neetRequirement','nmcRecognitionStatus','globalRank','rankingSource','rankingYear',
  'clinicalExposure','safetyAndSupport','roiScore','bestFor','reputationScore','description',
];

function checkUni(u) {
  const missing = REQUIRED_FIELDS.filter(f => u[f] == null || u[f] === '');
  return {
    missing,
    tuitionUSD: typeof u.tuitionFeeUSD === 'number' ? u.tuitionFeeUSD : null,
    totalUSD:   typeof u.totalProgramCostUSD === 'number' ? u.totalProgramCostUSD : null,
  };
}

function summarise(name, profile, data, ms, err) {
  if (err) return { name, ok: false, count: 0, err: String(err), tiers: {}, top3: [], analysis: '', tuitionMin: 0, tuitionMax: 0, totalMin: 0, totalMax: 0, ms };
  const universities = data?.universities || [];
  const tiers = universities.reduce((acc, u) => { acc[u.tier || '?'] = (acc[u.tier || '?'] || 0) + 1; return acc; }, {});
  const top3 = universities.slice(0, 3).map(u => `${u.name} (${u.country}, ${u.tier || '?'})`);
  const tuitions = universities.map(u => u.tuitionFeeUSD || 0).filter(n => n > 0);
  const totals   = universities.map(u => u.totalProgramCostUSD || 0).filter(n => n > 0);
  return {
    name, ok: true,
    count: universities.length,
    tiers,
    top3,
    analysis: data.analysis || '',
    tuitionMin: tuitions.length ? Math.min(...tuitions) : 0,
    tuitionMax: tuitions.length ? Math.max(...tuitions) : 0,
    totalMin:   totals.length ? Math.min(...totals)   : 0,
    totalMax:   totals.length ? Math.max(...totals)   : 0,
    fieldIssues: universities.map(checkUni).filter(c => c.missing.length).slice(0, 3),
    ms,
  };
}

async function runOne({ name, profile }) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${BASE}/api/predict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(profile),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    const data = await r.json();
    return summarise(name, profile, data, Date.now() - t0);
  } catch (err) {
    return summarise(name, profile, null, Date.now() - t0, err);
  }
}

function flag(s) {
  if (!s.ok)                              return '❌';
  if (s.count < 10)                       return '⚠️';
  if (s.tuitionMin === 0)                 return '⚠️';
  if ((s.analysis || '').length < 200)    return '⚠️';
  return '✅';
}

const log = (...args) => console.log(...args);

(async () => {
  log(`\n=== Predictor test harness — ${cases.length} cases against ${BASE} ===\n`);

  // Health check
  try {
    const h = await fetch(`${BASE}/api/health`).then(r => r.json());
    log(`Health: cutoffs_2024=${h.cutoffs_2024}, cutoffs_2023=${h.cutoffs_2023}\n`);
  } catch (e) {
    console.error('Server not reachable:', e.message);
    process.exit(1);
  }

  const results = [];
  for (const c of cases) {
    process.stdout.write(`▶ ${c.name.padEnd(28)} `);
    const s = await runOne(c);
    results.push(s);
    log(`${flag(s)} count=${s.count} tiers=${JSON.stringify(s.tiers)} ${s.ms}ms`);
    if (!s.ok) log(`  err: ${s.err}`);
  }

  // Build markdown report
  const md = [];
  md.push(`# Predictor Test Report\n`);
  md.push(`Generated: ${new Date().toISOString()}  \nBase URL: ${BASE}  \nCases: ${cases.length}\n`);
  md.push(`## Summary\n`);
  md.push(`| Case | Status | Count | Tier mix | Tuition USD (min–max) | Total USD (min–max) | Analysis len | Time |`);
  md.push(`|---|---|---|---|---|---|---|---|`);
  for (const s of results) {
    md.push(`| ${s.name} | ${flag(s)} | ${s.count} | ${JSON.stringify(s.tiers)} | ${s.tuitionMin}–${s.tuitionMax} | ${s.totalMin}–${s.totalMax} | ${(s.analysis || '').length} | ${s.ms}ms |`);
  }

  md.push(`\n## Per-case details\n`);
  for (const s of results) {
    md.push(`### ${flag(s)} ${s.name}`);
    if (!s.ok) {
      md.push(`- ❌ Error: \`${s.err}\``);
      continue;
    }
    md.push(`- count: **${s.count}**, tiers: \`${JSON.stringify(s.tiers)}\``);
    md.push(`- tuition USD range: ${s.tuitionMin}–${s.tuitionMax} · total USD range: ${s.totalMin}–${s.totalMax}`);
    md.push(`- analysis (${(s.analysis || '').length} chars): ${(s.analysis || '').slice(0, 300)}${(s.analysis || '').length > 300 ? '…' : ''}`);
    md.push(`- top 3:`);
    for (const t of s.top3) md.push(`  - ${t}`);
    if (s.fieldIssues?.length) {
      md.push(`- field issues: ${JSON.stringify(s.fieldIssues)}`);
    }
    md.push('');
  }

  const passes = results.filter(s => flag(s) === '✅').length;
  const warns  = results.filter(s => flag(s) === '⚠️').length;
  const fails  = results.filter(s => flag(s) === '❌').length;
  md.push(`\n## Verdict\n`);
  md.push(`- ✅ ${passes} clean`);
  md.push(`- ⚠️ ${warns}  warnings (count<10, missing USD, short analysis)`);
  md.push(`- ❌ ${fails}  failures (network / 5xx)`);

  writeFileSync('test-report.md', md.join('\n'));
  log(`\n✅ ${passes}   ⚠️ ${warns}   ❌ ${fails}`);
  log(`\nReport saved → test-report.md\n`);
})();
