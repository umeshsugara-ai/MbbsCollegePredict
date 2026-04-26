# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — Vite dev server on `0.0.0.0:3000`.
- `npm run build` — Production build to `dist/`.
- `npm run preview` — Serve the production build locally.
- `npm run lint` — Type-check only (`tsc --noEmit`). There is no ESLint config and no test framework; "lint" is purely TypeScript validation.
- `npm run clean` — Remove `dist/`.

No single-test command exists because no tests are configured.

## Environment

- `GEMINI_API_KEY` must be set in `.env.local` (or `.env`). Vite inlines it at build time via `define: { 'process.env.GEMINI_API_KEY': ... }` in [vite.config.ts](vite.config.ts), so it ships to the client bundle — this is an AI Studio applet pattern, not server-side secret handling.
- `DISABLE_HMR=true` disables Vite HMR. AI Studio sets this during agent edits to prevent flicker; leave the guard in [vite.config.ts](vite.config.ts) alone.
- `APP_URL` is auto-injected by AI Studio at runtime (Cloud Run service URL).
- Path alias: `@/*` resolves to the repo root (not `src/`). Existing code tends to use relative imports with explicit `.ts`/`.tsx` extensions (required by `allowImportingTsExtensions`).

## Architecture

Single-page React 19 + Vite + TypeScript app. Three files carry essentially all logic:

1. **[src/services/predictionService.ts](src/services/predictionService.ts)** — The one integration point with Gemini. It constructs a prompt around the `StudentProfile`, pins the model to `gemini-3-flash-preview`, and enforces a strict `responseSchema` (structured JSON). The schema mirrors the `University` interface in [src/types.ts](src/types.ts) — **keep the two in sync**: adding or renaming a field on `University` means updating both the TS type and the `responseSchema` `properties`/`required` arrays, otherwise Gemini will return data the UI doesn't render or the schema will reject valid output. The prompt also hard-codes a "today's date" string and a 2026 intake assumption; update these together when the academic cycle rolls over. There is a special-case instruction inside the prompt: if `otherPreferences` mentions Indian food/mess/community, the model is told to prioritize universities with Indian messes (Russia, Philippines, Georgia). Preserve this behavior when editing the prompt.

2. **[src/App.tsx](src/App.tsx)** — Orchestrates state (`profile`, `result`, `isLoading`, `error`, `currency`, `isSidebarOpen`) and persists both `profile` and `result` to `localStorage` under `mbbs_predictor_profile` / `mbbs_predictor_results`. State rehydrates on mount. On successful prediction the sidebar auto-collapses. Any new user input added to the form must also be persisted through this same localStorage flow or it will be lost on reload.

3. **[src/components/UniversityTable.tsx](src/components/UniversityTable.tsx)** + **[src/components/PredictorForm.tsx](src/components/PredictorForm.tsx)** — Presentational. Table does client-side filtering/sorting and currency conversion with a hard-coded `USD_TO_INR = 83.5`. `getNumericValue` parses the first number out of string fields like `"$8,500 USD"` or `"451-500"` — be aware that Gemini returns currency/rank fields as strings, not numbers, and the table relies on this parser for sorting.

Styling is Tailwind CSS v4 via the `@tailwindcss/vite` plugin; the only CSS file is [src/index.css](src/index.css) which just does `@import "tailwindcss"`. Animations use `motion/react` (Framer Motion successor). Icons are `lucide-react`.

## Notes

- `express` and `@types/express` are in dependencies but unused — there is no backend. Gemini is called directly from the browser.
- The README refers to this as an AI Studio app (app ID `a62db2c3-9a99-4555-969e-b69f4dd9385a`); deployment target is Cloud Run via AI Studio's publish flow, not a self-managed pipeline.
