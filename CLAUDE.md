# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — `tsx watch server.ts` (hot-reload TypeScript server, listens on `$PORT` / 3000).
- `npm run start` — `cross-env NODE_ENV=production tsx server.ts`. Production mode runs the same way; there is no compile step (`tsx` executes TS directly), so `tsconfig.json` has `"noEmit": true`.
- `npm run lint` — Type-check only (`tsc --noEmit`). No ESLint config and no test framework. `tsconfig.json` only `include`s `server.ts`, so the lint pass type-checks the server file alone.
- `node scripts/test-validator.mjs` — Self-contained sanity test for the tier-derivation / hallucination-drop logic. 17 assertions, no server boot required. The only "test" runnable today; constants are inlined so a stale copy can drift from the real `server.ts` values — re-sync when changing `TIER_BANDS` or `halluTooEasy/HardMult`.
- `python scripts/extract-abroad.py` — Regenerate `data/abroad/universities.json` from `MBBS.xlsx`. Run from repo root. Do **not** hand-edit `universities.json` — it's a build artifact.
- `node scripts/build-city-state-map.mjs` — Regenerate `scripts/data/city_state_map.json` (the backfill that lifts MCC state-parse coverage from ~40% to ~99.7%). Run when MCC adds new colleges in cities not yet mapped.
- `docker compose up --build` — Container build/run via the bundled `Dockerfile` + `docker-compose.yaml`. `.env` is `.dockerignored`, so compose's `env_file:` is the only path that injects `.env` values into the container.

## Environment

Loaded by `dotenv` at boot: `.env` first, then `.env.local` with `override: true`. In Docker, compose `environment:` keys win over `env_file:` (the empty container `.env` is never loaded — `.env` is `.dockerignored`).

- `GEMINI_API_KEY` — **required**. Server `process.exit(1)` at boot if missing or empty (clear error message). Don't change to a soft fallback.
- `MONGODB_URI` / `MONGODB_DB` — optional. `recordRecommendation` no-ops silently when unset; `/api/lead` returns 503 because there's no fallback for the counselling team's lead capture.
- `DAILY_USD_CAP` — optional, default `50`. Process-wide cumulative Gemini spend; once today's total exceeds this, `/api/predict` returns 503 until UTC rollover. Per-process counter — multi-replica deployments need to swap to a shared store.
- `PORT` — default 3000. Healthcheck hits `/api/health` (which probes Mongo + data-load state and returns 503 if degraded).
- `APP_URL` — auto-injected by AI Studio at runtime, otherwise unused.

## Architecture

This is **not** a React/Vite SPA. The README is a leftover scaffold and out of date. The product is:

- A single-file Express server (`server.ts`, ~2800 lines) that proxies a Gemini-backed predictor.
- A single static HTML page with inline CSS + vanilla JS (`mbbs_landing_page_with tool.html`, ~3500 lines).
- All LLM prompts in `prompts.json` (variables substituted by `fillTemplate()`).
- Curated NEET cutoff CSVs (`data/neet/cutoffs_yearly/neet_cutoffs_*.csv`) and an abroad anchor JSON (`data/abroad/universities.json`).

### Frontend ↔ backend boundary

The HTML at `/` POSTs to `/api/predict` and `/api/lead` only. Browser persists a UUID v4 `sessionId` in `localStorage` and sends it on every call so Mongo can join recommendations to the user's eventual lead submission. The static handler **only** serves the landing HTML — `express.static(ROOT)` was removed deliberately (it had been exposing `prompts.json`, the dataset CSVs, source files, etc.). Don't reintroduce it; if you need to ship an asset, route it explicitly.

### Request flow

`POST /api/predict` runs through middleware → validation → predictor → telemetry detach → response → fire-and-forget Mongo write:

1. **Rate limit + body cap** — `predictLimiter` (8/min/IP), `express.json({ limit: '16kb' })`. `/api/lead` has its own `leadLimiter` (5/10min/IP) plus a honeypot field.
2. **Daily spend cap** — `isOverDailyCap()` short-circuits with 503 once `spendTracker.totalUSD ≥ DAILY_USD_CAP`. Every Gemini call decrements via `recordSpend()` from inside `callGemini()`.
3. **Input validation** — `validateProfile()` enforces enum allowlists (`destinationType`, `category`, `gender`), length-caps free-text, strips control chars, rejects prompt-injection markers (`"ignore prior"`, `"system prompt"`, `"⚠️"`, etc.). For India the request is rejected if neither score nor rank is provided.
4. **Dispatch** — by `profile.destinationType`:
   - **`predictIndia(profile)`** — derives `rankRange = {low, mid, high, confidence}` from `approximateRankRange(score)`: a multi-year (2022–2024) weighted score→rank curve with 5%/yr competition-growth drift forward to `PREDICTION_YEAR` (auto-derived as `max(currentYear+1, latestCutoff+1)`). Computes `{aiqMbbs, stateQuotaMbbs, deemedPrivate}` probabilities via `computeQuotaProbabilities()` — multi-year-blended, with rank-tier-aware caps (topper <1500 / mid <25000 / low). Pre-renders conditional prompt fragments (`deemedVerdict`, `deemedSlot`, `topperBlock`, `genderExclusion`, `counsellingStrategyTopper/Mid/Default`) in JS and passes them to `india.main`. Fires the main Gemini call (`responseSchema`-bound, ungrounded) **in parallel** with grounded `verifyStateQuota` (separate call because grounding cannot combine with `responseSchema` in this Gemini API). Then runs `validateIndiaUniversities()`: per-row CSV anchor lookup → asymmetric, **scale-aware** hallucination drop (`halluTooEasyMult(csvRank)` / `halluTooHardMult(csvRank)`) → `deriveTierFromRange()` mechanical tier override → topper-AIIMS exception that promotes a `DROP` to `Stretch` when `AIR < 1500` for AIIMS Delhi/Bombay/Jodhpur. Backfills with `predictIndiaCsv()` candidates if validation drops the count below the minimum. **No silent CSV fallback**: a Gemini error bubbles up so the user sees a real failure.
   - **`predictAbroad(profile)`** — `filterAbroadAnchors(profile)` slices `data/abroad/universities.json` by preferred countries / budget (with country diversity preserved), inlines the rows into `abroad.main`, and calls Gemini with the abroad `responseSchema`. Parallel grounded `verifyAbroad` call mirrors the India-side state verifier. **No code-level validator yet** — abroad relies on the model + grounding (V1.1).
5. **Telemetry detach** — `detachTelemetry(result)` strips the `telemetry` object from the response body before `res.json()`. Cost / token counts / model name stay server-side (Mongo + logs) so they don't leak as competitive intel to clients.
6. **Mongo write** — `recordRecommendation()` runs **after** the response, fire-and-forget. Lost analytics on Mongo outage; `/api/predict` itself never blocks on Mongo.

### Gemini call wrapper (`callGemini` / `callGeminiOnce`)

- **90s per-call timeout** (`GEMINI_CALL_TIMEOUT_MS`) — generous because real India predictions take 36–84s. Lower values killed legitimate calls.
- **One retry on transient errors** (429, 5xx, ETIMEDOUT, ECONNRESET) with 250–750ms jittered backoff. **Critically NOT retried**: our own client-side timeout. `callGeminiOnce` returns `{resp, timedOut}`; the retry loop checks the flag because the SDK wraps the AbortError and loses our custom reason. Retrying our own slow-call abort just wastes the second budget.
- **Robust JSON extraction** (`extractJsonObject`) for grounded responses (which can't use `responseSchema`): tries verbatim parse → strips markdown fences → walks the first balanced `{...}` substring. Returns `null` instead of throwing so the verifier can degrade gracefully.

### Persistence

Two Mongo collections, joined by browser-supplied `sessionId`:

- **`recommendations`** — written after `res.json()` returns, fire-and-forget. Anonymous; full `profile` + `result` + verifier outputs broken out as top-level `stateVerification` / `abroadVerification` so support can replay grounded results (which aren't reproducible on re-run).
- **`leads`** — written from `/api/lead` (the "Get Free Counselling" modal). **Awaited** because the user expects confirmation. Free-text fields (`name`, `message`) are `escapeHtml`-encoded at write time. `linkedRecommendation` is capped at 8KB.

Timestamps are stored as **IST ISO 8601 strings** (`"…+05:30"`), not UTC `Z` — sortable lexicographically, parseable everywhere, human-readable in MongoDB Compass without TZ math. See `nowIST()`.

### CSV ingestion + state-parse backfill

`loadCutoffs(year)` parses `data/neet/cutoffs_yearly/neet_cutoffs_<year>.csv`. `discoverCutoffYears()` globs the directory at boot — drop a new `neet_cutoffs_2025.csv` and the multi-year blend picks it up automatically.

`extractState(institute)` only resolves the state when the address ends in a recognised state name — that misses ~40% of MCC rows on the 2024 file (and 95–97% on older years where the format was inconsistent). `backfillStateFromCity()` consults `scripts/data/city_state_map.json` (1,200 curated city/institutional-shorthand → state entries) when `extractState()` returns empty. Combined coverage is ~99.7%. To extend: add the missing city to `city_state_map.json` (lowercase keys, Title-Cased state values matching `INDIAN_STATES`).

`validateDataIntegrityAtBoot()` prints a structured `[data-audit]` block on startup: per-year row counts, state-parse miss rate, quota distribution, abroad anchor freshness. Logs warnings (does not crash) on anomalies.

**2023 NEET data has Round 2 missing** (3,525 vs 5,718/5,264 in adjacent years). Documented in `scripts/data/2023-anomaly.md`. `SCORE_RANK_YEAR_META.2023.reliability` is down-weighted from 0.95 → 0.65 to compensate. Re-scrape from the public Round 2 PDF would restore reliability — V1.1 work.

### Frontend patterns to preserve

The HTML is intentionally framework-free; all logic is vanilla DOM in inline `<script>` blocks. Three specific patterns matter:

- **Mobile-first CSS cascade** — base styles target phones, layered breakpoints at `min-width:600px / 900px / 1200px`. NO `max-width` queries except for explicit overrides. The CSS at the top of the `<style>` block is the foundation; later overrides assume the base shape.
- **Predictor auto-collapse on mobile submit** — the form (`#pred-side`) collapses immediately on `Find My College` click on mobile (<900px) via the same `.pred-app.collapsed` class the desktop "Hide Panel" toggle uses. A sticky full-width `.pred-side-open` bar replaces it, showing the user's current search summary ("Score 480 · SC · Bihar · ₹15L"). Desktop keeps the original 36×36 floating arrow. Don't conflate these — same class, different rendering.
- **State dropdown is `position:absolute`** anchored to `.pred-state-wrap` (which is `position:relative`). Was `position:fixed` with JS-set viewport coords — that bug detached the panel from the trigger when the user scrolled. Don't switch back. The panel auto-positions via `top:calc(100% + 6px); left:0; right:0` and scrolls with the page naturally.

Other smaller gotchas:
- All form inputs `font-size:16px` to prevent iOS auto-zoom on focus. Anything below 16px will jerk the page.
- The UI labels the abroad tab "Global" but the server enum is `'India' | 'Abroad'`. `buildProfile()` maps `'Global' → 'Abroad'` at the boundary.
- The `predictor-results` table is wrapped by JS in a `.pred-table-wrap` with `overflow-x:auto` + `min-width:900px` on the table itself. Horizontal scroll engages on phones; desktop sees the full table.
- `showError()` injects a "↻ Try again" button that calls `form.requestSubmit()` — preserves all the existing validation/sessionId/auto-collapse logic instead of reimplementing the submit path.

### Cross-cutting invariants — preserve when editing

- **NEET semantics**: AIR 1 = best student. A college with a lower closing rank is harder. Multiple recurring bugs (the AIIMS-Safe-at-AIR-500 bug, the LHMC women-only leak, the topper 100%-AIQ inflation) all stem from getting this direction backwards or bypassing the rank-tier caps. Any change to tier logic, probability, or prompt comparators must be checked in this direction.
- **`prompts.json` ↔ `server.ts`**: Adding a `${var}` to a prompt requires passing it in the corresponding `fillTemplate(...)` call site. Conditional fragments are pre-rendered in JS and exposed as variables; do not put `if`-logic inside the JSON.
- **`responseSchema` ↔ `University` interface**: The Gemini structured-output schema in `predictIndia` / `predictAbroad` and the `University` TypeScript interface (server.ts) describe the same object. Adding a field means updating both the schema `properties`/`required` and the interface, otherwise the validator will skip the row or the schema will reject the response.
- **`expectedClosingAirLow/High`, `quotaSlot`, `categorySlot`** are required on every India recommendation row — `validateIndiaUniversities` reads them, and missing/zero values land in `telemetry.validatorSkipped`. If the rate creeps past ~30% of rows in production telemetry, the validator is effectively disabled and Stage 2 (Gemini Pro for selection + Flash for narrative) is overdue.
- **Prompt UI hygiene**: User-facing fields must never leak source-year language (`"2024 MCC"`, `"CSV anchor"`, `"may shift ±N%"`). The data-year context exists for the model's internal reasoning only — there's a `FINAL CHECK` block at the end of `india.main` enforcing this.
- **Dynamic dates / years**: `todayISO()` is evaluated per request; `PREDICTION_YEAR` is auto-derived; `LATEST_CUTOFF_YEAR` is auto-discovered from the CSV directory. There are no hardcoded year strings to update on rollover. Don't reintroduce them.
- **No silent fallbacks**: `predictIndia` errors bubble up to `/api/predict` and surface as a real failure response. The earlier "fall back to `predictIndiaCsv` on any error" path was removed because it produced subtly-wrong recommendations under load and hid the underlying problem.
- **Graceful shutdown**: `SIGTERM` / `SIGINT` close the HTTP server (10s drain), then the Mongo client, then exit. Hard-exit at 15s. Keep this behavior — Cloud Run / Docker stop relies on it.

## Project memory

This project has a `~/.claude/projects/D--globalmbbs-predictor/memory/` directory (see `MEMORY.md`) with three persistent notes worth reading before making product-shape decisions:
- `feedback_ship_before_eval.md` — don't propose persona-eval suites or curated state-anchor JSONs before there are real users.
- `project_student_victory.md` — quality decisions favour student outcomes over engineering elegance.
- `project_data_focus.md` — abroad data is reliable; India is where the data work matters.
- `project_reliability_profile_at_launch.md` — current per-profile reliability estimates and V1.1 priority order (1: SC/ST per-category caps, 2: MCC 2025 + 2023 R2 re-scrape, 3: state GMC anchors).

## Notes

- `Dockerfile` runs `tsx` directly and therefore needs devDependencies installed (`npm ci` without `--omit=dev`); don't "optimise" by switching to a prod-only install.
- The `README.md` still describes the old AI Studio Vite app and is out of date — trust this file and `server.ts` instead.
