# NEET 2023 cutoffs — missing-round anomaly

## TL;DR

`data/neet/cutoffs_yearly/neet_cutoffs_2023.csv` has **3,525 MBBS rows** vs **5,718 (2022)** and **5,264 (2024)** — a 38% shortfall.

**Root cause:** the original MCC scrape for 2023 only captured 4 of the 4 official rounds, but **missed Round 2 entirely** (and substituted in two ancillary partial-rounds). The data we have is *correct MCC data*; it is just *incomplete*. Re-extraction from the local raw files cannot recover the missing rows because the missing round was never scraped.

**Recommendation:** **Outcome B** — leave `neet_cutoffs_2023.csv` untouched; down-weight 2023's `reliability` in `SCORE_RANK_YEAR_META` (server.ts ~line 697) from `0.95` to `~0.65–0.70` so the score→rank model puts less faith in 2023 until the file can be re-scraped.

## Investigation

### 1. Per-folder file inventory

| Year | raw/ files | per_round/ files | yearly file rows | yearly file MBBS rows |
|------|-----------:|-----------------:|-----------------:|----------------------:|
| 2022 | 5 | 5 | 7,138 | **5,718** |
| 2023 | 4 | 4 | 4,064 | **3,525** |
| 2024 | 6 | 6 | 6,291 | **5,264** |

(Yearly row counts via Python `csv.DictReader`, which correctly handles embedded newlines in `Allotted Institute` quoted fields. A naive `wc -l` over-reports by ~3× because addresses span multiple physical lines.)

### 2. Round-by-round breakdown of each year

`Round` column distributions in the rolled-up yearly files:

- **2022 (5 rounds)**: Round 1 (2,559), Round 2 (2,251), Mop Up (1,679), Stray Vacancy (405), 2nd Mop Up BDS/BSc (244)
- **2023 (4 rounds)**: Round 1 (2,730), Round 3 (1,026), Round 5 BDS/BSc (149), Special Stray (159)
- **2024 (5 rounds)**: Round 1 (2,969), Round 2 (2,449), Stray Vacancy (661), Special Stray (192), Special Stray II (20)

The 2023 file has **no Round 2** at all. The labels "Round 3" and "Round 5 BDS/BSc" are MCC's actual labels — for NEET UG 2023, MCC used "Round 3" as the name for the Mop-Up round (confirmed via web search; result published 20 Sep 2023). So our 2023 dataset is essentially: **Round 1, Mop Up, two trailing partial rounds.** Round 2 — the second-largest round — is missing.

### 3. Rollup script consistency

There is no rollup script in `scripts/`. The `per_round/` files appear pre-generated. I verified the per_round → yearly rollup is *not* the bug:

```
Sum of per_round/2023 MBBS rows     = 2,444 + 994 + 0 + 87  = 3,525   ✓ matches yearly
Sum of per_round/2022 MBBS rows     = 2,226 + 1,921 + 1,378 + 0 + 193 = 5,718   ✓ matches yearly
Sum of per_round/2024 MBBS rows     = 2,615 + 2,136 + 452 + 61 + 0 = 5,264   ✓ matches yearly
```

The rollup is faithful. The problem is upstream: the raw files for 2023 also only contain Rounds 1, 3, 5_bds-bsc, special_stray (cf. `data/neet/raw/neet_raw_2023_*.csv`). Re-extracting from raw will not change anything.

### 4. Public-source cross-reference

NEET UG 2023 MCC counselling officially ran **4 rounds**: Round 1, Round 2, Round 3 (Mop Up), Stray Vacancy.

- Round 2 result was declared **18 Aug 2023**: ~9,950 fresh seats + 1,051 upgrades across MBBS/BDS/BSc Nursing, with the official PDF still hosted at `cdnbbsr.s3waas.gov.in/...2023081882.pdf`. (Sources: [Shiksha](https://www.shiksha.com/medicine-health-sciences/articles/neet-counselling-2023-round-2-schedule-choice-filling-seat-allotment-list-blogId-130529); [MCC NEET UG 2023 official PDF](https://cdnbbsr.s3waas.gov.in/s3e0f7a4d0ef9b84b83b693bbf3feb8e6e/uploads/2023/08/2023081882.pdf).)
- Round 3 / Mop Up result was declared **20 Sep 2023**. (Source: web search confirms `Round 3 = mop-up` in MCC 2023 nomenclature.)
- The 2023 file does include a "Round 3" group (1,026 rows = mop-up) but is missing Round 2 entirely.

### 5. Magnitude check

The deficit is `5,718 − 3,525 = 2,193` MBBS rows. In 2022, Round 2 alone contributed 1,921 MBBS rows; in 2024, 2,136. A missing 2023 Round 2 would account for the entire deficit cleanly — consistent with the hypothesis.

## Files inspected

- `D:\globalmbbs-predictor\data\neet\cutoffs_yearly\neet_cutoffs_{2022,2023,2024}.csv`
- `D:\globalmbbs-predictor\data\neet\per_round\neet_cutoffs_{2022,2023,2024}_*.csv`
- `D:\globalmbbs-predictor\data\neet\raw\neet_raw_{2022,2023,2024}_*.csv`
- `D:\globalmbbs-predictor\server.ts` (lines 697–701, `SCORE_RANK_YEAR_META`)

## Recommendation

Do **not** modify `neet_cutoffs_2023.csv`. The rows it contains are valid MCC data; the file is just incomplete. Re-extracting from local raw files is a no-op because the raw files are also missing Round 2.

In `server.ts` around line 697, change:

```ts
const SCORE_RANK_YEAR_META: Record<number, { weight: number; reliability: number }> = {
  2024: { weight: 0.50, reliability: 0.65 },
  2023: { weight: 0.35, reliability: 0.95 },   // ← currently
  2022: { weight: 0.20, reliability: 0.90 },
};
```

to something like:

```ts
const SCORE_RANK_YEAR_META: Record<number, { weight: number; reliability: number }> = {
  2024: { weight: 0.50, reliability: 0.65 },
  2023: { weight: 0.35, reliability: 0.65 },   // missing MCC Round 2 in source data — see scripts/data/2023-anomaly.md
  2022: { weight: 0.20, reliability: 0.90 },
};
```

Note the 2023 reliability also flows into `computeQuotaProbabilities` (server.ts ~line 815) indirectly via `CUTOFF_YEARS` — the quota-probability blend uses its own recency weights (`yearWeight` at line 827) but iterates over the same yearly CSVs, so 2023 contributes ~38% fewer rows there too. Worth a comment near the loop, but no code change required for that path.

## Permanent fix (future work, out of scope)

Re-scrape MCC's NEET UG 2023 Round 2 allotment from the official PDF (`https://cdnbbsr.s3waas.gov.in/s3e0f7a4d0ef9b84b83b693bbf3feb8e6e/uploads/2023/08/2023081882.pdf`), regenerate `data/neet/raw/neet_raw_2023_round_2.csv` and `data/neet/per_round/neet_cutoffs_2023_round_2.csv`, then re-roll `neet_cutoffs_2023.csv`. After that, restore `reliability: 0.95`.
