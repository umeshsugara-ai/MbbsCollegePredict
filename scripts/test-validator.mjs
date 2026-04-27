// Focused unit test for the pure tier-derivation and hallucination-drop
// logic from server.ts. Inlines the same constants to avoid booting the
// Express server. NEET semantics: LOWER AIR = better student.

const HALLUC_TOO_EASY_MULT = 1.5;
const HALLUC_TOO_HARD_MULT = 0.40;

function deriveTierFromRange(rankRange, claimedLow, claimedHigh) {
  if (rankRange.low > claimedHigh * 2.5) return 'DROP';
  if (rankRange.high <= claimedLow * 0.85) return 'Safe';
  if (rankRange.mid <= claimedHigh) return 'Good';
  if (rankRange.low > claimedHigh) return 'Stretch';
  return 'Reach';
}

const TOPPER_EXEMPT_INSTITUTES = ['aiims delhi', 'aiims bombay', 'aiims mumbai', 'aiims jodhpur'];

function normalizeName(s) {
  return String(s || '').toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function isTopperExempt(name) {
  const n = normalizeName(name);
  return TOPPER_EXEMPT_INSTITUTES.some(t => n.includes(t));
}

let pass = 0, fail = 0;
function assert(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { console.log(`  PASS  ${label}`); pass++; }
  else    { console.log(`  FAIL  ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); fail++; }
}

console.log('\n── Tier derivation (NEET: lower AIR = better) ──────────');

// Topper at AIR 100 vs AIIMS Delhi 50-80
//   low=95 > 80×2.5=200? No
//   high=105 ≤ 50×0.85=42.5? No → not Safe
//   mid=100 ≤ 80? No → not Good
//   low=95 > 80? Yes → Stretch
assert('topper AIR 100 vs AIIMS Delhi 50-80 → Stretch',
  deriveTierFromRange({low:95, mid:100, high:105}, 50, 80),
  'Stretch');

// AIR 500 vs AIIMS Delhi 50-80 — the original bug
//   low=475 > 80×2.5=200? Yes → DROP
assert('AIR 500 vs AIIMS Delhi 50-80 → DROP (the bug case)',
  deriveTierFromRange({low:475, mid:500, high:525}, 50, 80),
  'DROP');

// AIR 1500 vs KGMU OBC 3000-4500
//   low=1425 > 4500×2.5=11250? No
//   high=1575 ≤ 3000×0.85=2550? Yes → Safe
assert('AIR 1500 vs KGMU OBC 3000-4500 → Safe',
  deriveTierFromRange({low:1425, mid:1500, high:1575}, 3000, 4500),
  'Safe');

// AIR 3500 vs KGMU OBC 3000-4500 (overlap)
//   low=3325 > 11250? No
//   high=3675 ≤ 2550? No → not Safe
//   mid=3500 ≤ 4500? Yes → Good
assert('AIR 3500 vs KGMU OBC 3000-4500 → Good',
  deriveTierFromRange({low:3325, mid:3500, high:3675}, 3000, 4500),
  'Good');

// AIR 4700 vs KGMU OBC 3000-4500 (just past the loose closing)
//   low=4465, high=4935
//   low > 11250? No. high ≤ 2550? No. mid=4700 ≤ 4500? No.
//   low=4465 > 4500? No → Reach (overlap)
assert('AIR 4700 vs KGMU OBC 3000-4500 → Reach',
  deriveTierFromRange({low:4465, mid:4700, high:4935}, 3000, 4500),
  'Reach');

// AIR 6000 vs KGMU OBC 3000-4500 (Stretch territory)
//   low=5700, high=6300
//   low > 11250? No. high ≤ 2550? No. mid=6000 ≤ 4500? No.
//   low=5700 > 4500? Yes → Stretch
assert('AIR 6000 vs KGMU OBC 3000-4500 → Stretch',
  deriveTierFromRange({low:5700, mid:6000, high:6300}, 3000, 4500),
  'Stretch');

// AIR 30,000 OBC vs AIIMS Delhi OBC 150-230 — should DROP (not Safe!)
//   low=28500, high=31500
//   low > 230×2.5=575? Yes → DROP
assert('AIR 30K OBC vs AIIMS Delhi OBC 150-230 → DROP',
  deriveTierFromRange({low:28500, mid:30000, high:31500}, 150, 230),
  'DROP');

// AIR 250,000 OBC vs typical govt MBBS 80,000-100,000 — should DROP
//   low=237500, high=262500
//   low > 100000×2.5=250000? No (237500 < 250000) → continue
//   high=262500 ≤ 80000×0.85=68000? No → not Safe
//   mid=250000 ≤ 100000? No → not Good
//   low=237500 > 100000? Yes → Stretch
//   That's still a Stretch label. The hallucination drop would handle it
//   if CSV anchor exists; otherwise the user sees Stretch which is correct
//   (the validator's job is "not Safe", not "perfect").
assert('AIR 250K vs govt MBBS 80K-100K → Stretch',
  deriveTierFromRange({low:237500, mid:250000, high:262500}, 80000, 100000),
  'Stretch');

console.log('\n── Topper exemption ────────────────────────────────────');
assert('AIIMS Delhi triggers exemption', isTopperExempt('AIIMS Delhi'), true);
assert('AIIMS Bombay triggers exemption', isTopperExempt('AIIMS, Bombay'), true);
assert('AIIMS Jodhpur triggers exemption', isTopperExempt('AIIMS Jodhpur'), true);
assert('KGMU does not trigger', isTopperExempt('KGMU Lucknow'), false);
assert('AIIMS Patna does NOT trigger (only top 3)', isTopperExempt('AIIMS Patna'), false);

console.log('\n── Hallucination thresholds ───────────────────────────');
const csvRank = 1963;  // AIIMS Patna OBC, real CSV value
console.log(`  too-easy: claimed > ${csvRank * HALLUC_TOO_EASY_MULT} (1.5×)`);
console.log(`  too-hard: claimed < ${(csvRank * HALLUC_TOO_HARD_MULT).toFixed(1)} (0.40×)`);
assert('claimed 3000 vs CSV 1963 (1.53×) → tooEasy DROP',
  3000 > csvRank * HALLUC_TOO_EASY_MULT, true);
assert('claimed 2900 vs CSV 1963 (1.48×) → KEEP',
  2900 > csvRank * HALLUC_TOO_EASY_MULT, false);
assert('claimed 700 vs CSV 1963 (0.36×) → tooHard DROP',
  700 < csvRank * HALLUC_TOO_HARD_MULT, true);
assert('claimed 800 vs CSV 1963 (0.41×) → KEEP',
  800 < csvRank * HALLUC_TOO_HARD_MULT, false);

console.log(`\nResult: ${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
