# Vidysea MBBS Predictor

A NEET-aware MBBS counselling tool that tells a student, in plain language, **which medical colleges they can realistically get into** — both inside India (MCC + state quotas) and abroad (NMC-recognised universities) — based on their score, category, domicile, budget, and gender.

The tool is what a good private counsellor would do for ₹15,000–₹50,000 per session, available free in the browser, in under 90 seconds.

---

## The problem this solves

Every year roughly **22 lakh students** appear for NEET-UG; only ~1 lakh secure a government MBBS seat. The remaining 21 lakh are left navigating a maze of:

- 700+ Indian medical colleges across **AIQ, state quotas, deemed and management quotas**, each with its own cutoff logic.
- Closing ranks that move year-on-year and differ by **category (UR / OBC / SC / ST / EWS), gender, and round**.
- Parallel choice of going abroad — ~50 NMC-recognised universities across Russia, Georgia, Uzbekistan, Kazakhstan, Kyrgyzstan, etc., each with different fees, FMGE pass rates, and English-medium credentials.
- Coaching counsellors who push the colleges they get commission from, not the ones the student can actually get into.

A 17-year-old with a score of 480 and ₹20L family budget cannot meaningfully evaluate "Russia vs Georgia vs deemed-private vs state quota in Bihar" on their own. They end up in three failure modes:

1. **Apply only to colleges they can never get into** → drop a year.
2. **Apply to fake "consultants" who promise admission** → ₹2L+ lost to fraud.
3. **Pay deemed/management fees they can't afford** → ₹70L–₹1Cr debt for a degree they could have got at a fraction of the cost via state or AIQ quota.

This tool replaces the maze with a single page: enter your score and your constraints, see the 10 colleges that match — categorised as **Safe / Good / Reach / Stretch** — with the AIR band, fees, and a one-line "why this college for you" explanation per pick.

---

## What the student does (Inputs)

The form is split by the destination toggle (**India** vs **Global**).

### Common inputs
- **NEET score (out of 720)** *or* **AIR (rank)** — at least one is required for India predictions. The tool converts score → rank using a multi-year (2022–2024) score-to-rank curve, drift-adjusted forward to the prediction year.
- **Category** — UR / OBC / SC / ST / EWS.
- **Gender** — male / female / other. Used to surface women-only quotas (LHMC, BPS Khanpur, etc.) and to filter colleges that don't admit a given gender.
- **Domicile state** — drives state-quota matching (Delhi University Quota, IP University Quota, Open Seat Quota, Puducherry Internal, AMU Muslim Minority, etc.).
- **Budget** — total tuition + hostel + living for the full course (in lakh / crore INR). Used as an **upper bound**, not a target.
- **Course preferences** — MBBS, BDS, BAMS, BHMS. (Most users select MBBS only.)

### India-specific
- **Government / Private / No preference** — soft hint only. The tool recommends private/deemed/management on equal footing with government when they fit the student's budget. It never categorically excludes private.

### Global-specific
- **Preferred countries** — multi-select from Russia, Georgia, Uzbekistan, Kazakhstan, Kyrgyzstan, Bangladesh, Nepal, Bosnia, etc. If listed, all 10 picks come **only** from this set.

### Lead capture (optional)
After seeing results, the student can request free counselling — name, email, mobile, NEET year. This goes to the Vidysea counselling team. Email + Mongo are both authoritative; one failing never breaks the other.

---

## What the student gets (Outputs)

A ranked list of **exactly 10 colleges** (more if the model has high confidence in additional picks), each with:

| Field | Example | Why it matters |
|---|---|---|
| **Name** | "Maulana Azad Medical College, New Delhi" | The actual college the student can target. |
| **Tier** | `Safe` / `Good` / `Reach` / `Stretch` | At-a-glance probability. Safe = high chance, Stretch = aspirational. |
| **Quota slot** | `AIQ` / `State` / `Deemed` / `Management` / `NRI` / `AIIMS` | Tells the student which counselling round to apply through. |
| **Category slot** | `OBC` / `OPEN` / `SC` / `ST` / `EWS` | Confirms the rank band is for *their* category, not the open category. |
| **Expected closing AIR** | `1300–1450` | Honest range — not a single false-precise number. Anchored to verified MCC cutoffs; inflated by ~5–10% for the prediction year. |
| **Tuition / Total cost** | `₹4.2L / ₹14.5L` | Total cost = tuition + hostel + mess + misc for full 4.5 years. Compared against the user's stated budget. |
| **One-line analysis** | "Strong Delhi-quota fit at OBC ~AIR 1450; ABV/Safdarjung/MAMC are realistic at this rank." | The "why this college *for you*" plain-English explanation. |
| **Source URL** *(state quota)* | `https://mcc.nic.in/...` | Grounded, verifiable link for state-quota picks via Gemini's grounding API. |

Plus three numbers at the top:

- **AIQ probability** (e.g. 72%) — chance of converting an All-India-Quota seat at this rank/category.
- **State Quota probability** (e.g. 90%) — chance of converting a home-state-quota seat.
- **Deemed/Private probability** (e.g. 90%, gated by budget) — chance of converting a budget-feasible deemed seat.

Topper-aware: a student at AIR <1500 sees AIIMS Delhi/Bombay/Jodhpur in their list; a student at AIR ~1,00,000 doesn't waste cognitive energy reading about AIIMS at all.

---

## How the tool actually produces the recommendations

This is the actual flow on every `POST /api/predict`. Total wall-clock: **35–80 seconds**.

### Step 1 — Validate the input
Express middleware enforces:
- Rate limit (8 predictions / minute / IP)
- Body cap (16KB)
- Daily Gemini spend cap (default $50/day) — hard 503 once exceeded
- Enum allow-lists on `destinationType`, `category`, `gender`
- Length caps on free-text fields
- Prompt-injection guard (rejects "ignore prior", "system prompt", `⚠️`, etc.)

Bad input → fast 4xx, no Gemini call burnt.

### Step 2 — India: convert score to rank
`approximateRankRange(score)` blends the 2022 / 2023 / 2024 NEET score-to-rank curves (with 2023 down-weighted because Round 2 data is missing) and drifts forward by ~5%/year to compensate for rising competition. Output: `{low, mid, high, confidence}` — a band, not a point.

### Step 3 — India: compute quota probabilities
`computeQuotaProbabilities()` walks the MCC CSVs (multi-year blend, latest year weighted highest) and returns:
- `aiqMbbs` — % chance of an AIQ MBBS seat
- `stateQuotaMbbs` — % chance of a domicile-state seat
- `deemedPrivate` — % chance of a budget-feasible deemed seat

Rank-tier-aware caps prevent the topper-100%-AIQ inflation bug and the AIR-50000 false-hope bug.

### Step 4 — India: build the **filter-first anchor pool**
This is the differentiator. `extractEligibleAnchors()` walks every MCC row and applies hard filters in order:
1. **Rank reachable** — closing rank within tier bands of the student's `{low, mid, high}`.
2. **Category match** — student's category matches the row's category (with OPEN-category fallback).
3. **State-quota domicile match** — for state-quota rows, only the student's home state's quotas qualify (Delhi University Quota, IP University Quota, Puducherry Internal, AMU, etc.).
4. **Budget cap** — for deemed/management rows, only those whose annual fee × 4.5 fits the user's budget.
5. **Gender** — drop women-only colleges if the student is male; drop male-only colleges if female.
6. **Course preference** — drop BDS/BAMS rows if the student selected MBBS-only.

Output: a balanced pool (~20–40 rows) tagged with `_tier` (Safe/Good/Reach/Stretch).

### Step 5 — India: parallel Gemini calls

Two Gemini calls fire **in parallel**:

**Call A — `india.main`** (structured output, ungrounded):
- Receives the filter-first anchor pool as authoritative few-shot context.
- Receives the student's profile, derived rank range, probabilities, and prompt fragments (topper block, gender exclusion, counselling strategy).
- Returns 10 colleges via `responseSchema`-bound JSON, each with the fields above.
- The model is instructed: "Start by selecting from the anchor pool. If fewer than 10, supplement carefully from training knowledge."

**Call B — `verifyStateQuota`** (grounded with Google Search):
- Independently grounded check for state-quota colleges.
- Returns ≥6 verified colleges with `source_url` per row.
- Fixes the structural fact that Gemini's training data underweights state-quota cutoffs.

(Grounded calls cannot use `responseSchema` in the current Gemini API, hence two parallel calls.)

### Step 6 — India: the validator
`validateIndiaUniversities()` is the safety net. For each of the 10 picks Gemini returned:

1. **Lookup in MCC CSVs** — fuzzy-match by name, prefer rows in the student's domicile state, require ≥2 meaningful-token overlap.
2. **Hallucination check** — if the model's claimed AIR is more than 10× off from the CSV anchor, **drop** the row (likely wrong college). If it's 1.5–10× off, **soft-override** the AIR to the CSV-anchored band instead of dropping.
3. **Tier override** — recompute the tier from the now-corrected AIR using the user's rank range.
4. **Topper-AIIMS exception** — promote dropped AIIMS Delhi/Bombay/Jodhpur back to `Stretch` if the user is at AIR <1500.
5. **Backfill** — if validation drops the count below 10, top up from `predictIndiaCsv()` (deterministic CSV-driven selection).

Telemetry per request: `drops`, `overrides`, `backfilled`, `skipped`, with reasons. All goes to Mongo.

### Step 7 — Abroad path (when destinationType = 'Abroad')
1. `filterAbroadAnchors()` slices `data/abroad/universities.json` (~50 NMC-recognised universities) by preferred countries and budget, preserving country diversity.
2. `abroad.main` Gemini call (structured output) ranks/supplements from this filtered pool. Country constraint is enforced as a hard rule: if countries are listed, all 10 picks must come from that set.
3. Parallel grounded `verifyAbroad` call mirrors the state-quota verifier.

### Step 8 — Persist + respond
1. Strip telemetry (cost, token counts, model name) from the client response — server-side only.
2. Send JSON to the browser.
3. **After** the response: fire-and-forget `recordRecommendation()` to Mongo (`recommendations` collection, joined to future leads by `sessionId`).
4. If the user submits the lead form: written to `leads` collection, awaited because the user expects confirmation, plus thank-you + team notification emails via AWS SES.

---

## Data sources

| Source | Used for | Refresh |
|---|---|---|
| `data/neet/cutoffs_yearly/neet_cutoffs_<year>.csv` | MCC AIQ + Deemed + Management cutoffs (2022, 2023, 2024) | Annually after MCC publishes Round-1 + Round-2 results. Drop a new file in and the auto-discovery picks it up. |
| `scripts/data/city_state_map.json` | City → state backfill (lifts state-parse coverage from ~40% to ~99.7%) | Edit when MCC adds colleges in cities not yet mapped. |
| `data/abroad/universities.json` | Abroad anchors — NMC-recognised universities, fees, FMGE rates, languages | Regenerated from `MBBS.xlsx` via `python scripts/extract-abroad.py` |
| `prompts.json` | All Gemini prompts (India main, abroad main, verifiers) | Edit by hand; substitution via `fillTemplate()` |

State-quota data for India is **not** in CSVs — it comes from the grounded Gemini call (`verifyStateQuota`) which searches official MCC + state DGMET sources at request time. This is intentional: state quota data is fragmented across 28 states and changes mid-counselling; a static snapshot is wrong by Round 3.

---

## Why this works (the design intent)

Three principles underpin every architectural choice:

### 1. The student is the customer, not the recruiter
The tool recommends private, deemed, and management colleges on equal footing with government when they fit the student's stated budget. It never recommends an unaffordable college. It never inflates probability to make a college look reachable. Every "honest band" (`AIR 1300–1450` not `AIR 1374`) is honest *for the student* — false precision is a counsellor's tactic, not a student's friend.

### 2. Filter-first beats LLM-only
Earlier versions asked Gemini to "pick 10 colleges for this student" and let the validator drop hallucinations after. That produced a 50–70% drop rate on toppers. The current architecture pre-filters the CSV by every hard constraint *before* Gemini sees it, so Gemini is choosing among colleges the student can already get into — not generating from scratch and getting drop-corrected. The validator is now a safety net, not the primary quality lever.

### 3. Verifiable grounding for things the model doesn't know well
Gemini's training data is strong on AIIMS, MAMC, JIPMER. It is structurally weak on Delhi University Quota cutoffs, AMU Muslim Minority Quota, Jain Minority Quota, Puducherry Internal Quota. So state quota is a separate grounded call that returns `source_url` per row — the counsellor (and the student) can click through to the MCC notice that backs the recommendation.

---

## Run it locally

**Prerequisites:** Node.js 20+, optional Mongo, optional AWS SES credentials.

```bash
git clone <repo>
cd globalmbbs-predictor
npm install

# Required
echo "GEMINI_API_KEY=your_key" > .env.local

# Optional (lead persistence + emails)
echo "MONGODB_URI=mongodb+srv://..." >> .env.local
echo "MONGODB_DB=vidysea" >> .env.local
echo "SES_SMTP_USER=..." >> .env.local
echo "SES_SMTP_PASS=..." >> .env.local
echo "FROM_EMAIL=hello@vidysea.com" >> .env.local
echo "TEAM_EMAIL=counselling@vidysea.com" >> .env.local

npm run dev
# → http://localhost:3000
```

Other commands:
- `npm run lint` — type-check (`tsc --noEmit`)
- `node scripts/test-validator.mjs` — 17-case sanity test for tier/hallucination logic
- `python scripts/extract-abroad.py` — regenerate abroad anchors from `MBBS.xlsx`
- `node scripts/build-city-state-map.mjs` — regenerate city→state backfill
- `docker compose up --build` — containerised run (uses `.env` via `env_file:`)

---

## API surface

- `POST /api/predict` — main entry. Body: `{ profile, sessionId? }`. Returns the 10-college result.
- `POST /api/lead` — counselling request from the lead modal. Body: `{ name, email, phone, neetYear, wantsAbroad, sessionId, linkedRecommendation }`. Persists to Mongo + sends two emails.
- `GET /api/health` — liveness + Mongo + data-load status. Returns 503 if degraded.

The static handler serves `mbbs_landing_page_with tool.html` only — no `express.static`, no incidental file exposure.

---

## What's deliberately not built (yet)

- **Per-category cutoff caps for SC/ST** — currently uses general-category caps with category-specific anchor matching. Refinement is V1.1 once telemetry confirms it's worth the complexity.
- **State GMC anchor JSON** — state quota is grounded at request time instead. Static JSON is V1.1 if grounded latency proves a problem at scale.
- **Persona eval suite + Playwright regression tests** — the decision was to ship and observe production telemetry, then automate against real failure patterns rather than synthetic ones.
- **2023 NEET Round 2 re-scrape** — currently down-weighted (`reliability: 0.65`). Re-scrape from the public Round 2 PDF would lift it back to 0.95.

These are tracked in `~/.claude/projects/D--globalmbbs-predictor/memory/project_reliability_profile_at_launch.md`.
