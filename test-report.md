# Predictor Test Report

Generated: 2026-04-25T17:10:51.848Z  
Base URL: http://localhost:3000  
Cases: 20

## Summary

| Case | Status | Count | Tier mix | Tuition USD (min–max) | Total USD (min–max) | Analysis len | Time |
|---|---|---|---|---|---|---|---|
| IN-720-OPEN | ✅ | 10 | {"Safe":10} | 958–4192 | 7186–23952 | 553 | 22ms |
| IN-680-OBC-TN | ✅ | 10 | {"Safe":10} | 958–4192 | 7186–23952 | 595 | 22ms |
| IN-650-OPEN-KA | ✅ | 10 | {"Safe":10} | 958–958 | 7186–7186 | 574 | 16ms |
| IN-620-EWS-DL | ✅ | 10 | {"Safe":10} | 27545–27545 | 155689–155689 | 618 | 16ms |
| IN-600-OPEN-MH | ✅ | 10 | {"Safe":10} | 27545–27545 | 155689–155689 | 633 | 13ms |
| IN-580-SC-UP | ✅ | 10 | {"Safe":10} | 27545–27545 | 155689–155689 | 611 | 14ms |
| IN-550-ST-OD | ✅ | 10 | {"Safe":1,"Reach":9} | 27545–27545 | 155689–155689 | 584 | 14ms |
| IN-500-OBC-RJ | ✅ | 10 | {"Safe":10} | 27545–27545 | 155689–155689 | 649 | 13ms |
| IN-450-OPEN-KL | ✅ | 10 | {"Safe":1,"Good":4,"Reach":5} | 27545–27545 | 155689–155689 | 600 | 10ms |
| IN-400-OPEN-PB | ✅ | 10 | {"Safe":1,"Reach":9} | 27545–27545 | 155689–155689 | 604 | 9ms |
| IN-350-EWS-WB | ✅ | 10 | {"Safe":1,"Reach":9} | 27545–27545 | 155689–155689 | 604 | 13ms |
| IN-280-OPEN-AP | ✅ | 10 | {"Good":1,"Reach":9} | 27545–27545 | 155689–155689 | 605 | 12ms |
| EDGE-rank100-OPEN | ✅ | 10 | {"Safe":10} | 958–4192 | 7186–23952 | 611 | 12ms |
| EDGE-rank1.5M-OPEN | ✅ | 10 | {"Reach":5,"Stretch":5} | 27545–27545 | 155689–155689 | 666 | 13ms |
| EDGE-OPEN_PWD-state | ✅ | 10 | {"Safe":10} | 958–27545 | 7186–155689 | 632 | 15ms |
| GL-Russia-Georgia-30k | ✅ | 10 | {"Safe":4,"Good":4,"Reach":2} | 3000–5500 | 15000–33000 | 750 | 32361ms |
| GL-Phil-Bang-18k | ✅ | 10 | {"Safe":2,"Good":5,"Reach":3} | 3500–4800 | 17500–27000 | 753 | 37775ms |
| GL-EU-Hungary-Poland-48k | ✅ | 10 | {"Reach":3,"Good":6,"Safe":1} | 6600–16900 | 39600–101400 | 406 | 46986ms |
| GL-CIS-Kaz-Kyrg-30k | ✅ | 10 | {"Safe":5,"Good":3,"Reach":2} | 3800–5500 | 19000–33000 | 808 | 28502ms |
| GL-OpenSearch-80k | ✅ | 10 | {"Reach":2,"Good":4,"Safe":4} | 4500–8500 | 27000–51000 | 536 | 54114ms |

## Per-case details

### ✅ IN-720-OPEN
- count: **10**, tiers: `{"Safe":10}`
- tuition USD range: 958–4192 · total USD range: 7186–23952
- analysis (553 chars): Estimated AIR rank: 1 (~99.99 percentile, OPEN). Tier mix: 10 safe, 0 good, 0 reach, 0 stretch picks across 10 colleges (NEET 2024 cutoff data). Top recommendation: AIIMS — Safe tier, closing rank 47 for Open under Open Seat Quota. No budget specified — recommendations span the full government-to-de…
- top 3:
  - AIIMS (India, Safe)
  - AIIMS-Bhopal (India, Safe)
  - Maulana Azad (India, Safe)

### ✅ IN-680-OBC-TN
- count: **10**, tiers: `{"Safe":10}`
- tuition USD range: 958–4192 · total USD range: 7186–23952
- analysis (595 chars): Estimated AIR rank: 1,650 (~99.93 percentile, OBC). Tier mix: 10 safe, 0 good, 0 reach, 0 stretch picks across 10 colleges (NEET 2024 cutoff data). Top recommendation: Dr. B.S.A. Medical College (Delhi) — Safe tier, closing rank 2,020 for OBC under All India. Your ~₹25L budget covers government, cen…
- top 3:
  - Dr. B.S.A. Medical College (India, Safe)
  - B.J. Government (India, Safe)
  - GOVT.MEDICAL COLLEGE (India, Safe)

### ✅ IN-650-OPEN-KA
- count: **10**, tiers: `{"Safe":10}`
- tuition USD range: 958–958 · total USD range: 7186–7186
- analysis (574 chars): Estimated AIR rank: 8,000 (~99.67 percentile, OPEN). Tier mix: 10 safe, 0 good, 0 reach, 0 stretch picks across 10 colleges (NEET 2024 cutoff data). Top recommendation: SUH Maulana — Safe tier, closing rank 9,420 for Open under All India. Your ~₹40L budget covers government, central institutions and…
- top 3:
  - SUH Maulana (India, Safe)
  - ATAL BIHARI (India, Safe)
  - SUH Maulana Mahmood Hasan Medical College (India, Safe)

### ✅ IN-620-EWS-DL
- count: **10**, tiers: `{"Safe":10}`
- tuition USD range: 27545–27545 · total USD range: 155689–155689
- analysis (618 chars): Estimated AIR rank: 25,200 (~98.95 percentile, EWS). Tier mix: 10 safe, 0 good, 0 reach, 0 stretch picks across 10 colleges (NEET 2024 cutoff data). Top recommendation: Manipal Tata Medical College (Jharkhand) — Safe tier, closing rank 30,915 for Open under Deemed/Paid Seats Quota. Your ~₹15L budget…
- top 3:
  - Manipal Tata Medical College (India, Safe)
  - GITAM Institue of Med. Sce. and Res. (India, Safe)
  - Kasturba Medical College (India, Safe)

### ✅ IN-600-OPEN-MH
- count: **10**, tiers: `{"Safe":10}`
- tuition USD range: 27545–27545 · total USD range: 155689–155689
- analysis (633 chars): Estimated AIR rank: 42,000 (~98.25 percentile, OPEN). Tier mix: 10 safe, 0 good, 0 reach, 0 stretch picks across 10 colleges (NEET 2024 cutoff data). Top recommendation: SYMBIOSIS MEDICAL COLLEGE FOR WOMEN PUNE (Maharashtra) — Safe tier, closing rank 53,248 for Open under Deemed/Paid Seats Quota. Yo…
- top 3:
  - SYMBIOSIS MEDICAL COLLEGE FOR WOMEN PUNE (India, Safe)
  - JSS Medical College (India, Safe)
  - MGM Medical College (India, Safe)

### ✅ IN-580-SC-UP
- count: **10**, tiers: `{"Safe":10}`
- tuition USD range: 27545–27545 · total USD range: 155689–155689
- analysis (611 chars): Estimated AIR rank: 2,45,000 (~89.79 percentile, SC). Tier mix: 10 safe, 0 good, 0 reach, 0 stretch picks across 10 colleges (NEET 2024 cutoff data). Top recommendation: VELS MEDICAL COLLEGE & HOSPITAL (Tamil Nadu) — Safe tier, closing rank 2,98,408 for Open under Deemed/Paid Seats Quota. No budget …
- top 3:
  - VELS MEDICAL COLLEGE & HOSPITAL (India, Safe)
  - VMKV Medical College and Hospital (India, Safe)
  - Dr. DY Patil Medical College (India, Safe)

### ✅ IN-550-ST-OD
- count: **10**, tiers: `{"Safe":1,"Reach":9}`
- tuition USD range: 27545–27545 · total USD range: 155689–155689
- analysis (584 chars): Estimated AIR rank: 6,75,000 (~71.88 percentile, ST). Tier mix: 1 safe, 0 good, 9 reach, 0 stretch picks across 10 colleges (NEET 2024 cutoff data). Top recommendation: Shri Sathya Sai Medical College and RI (Tamil Nadu) — Safe tier, closing rank 13,32,973 for Open under Deemed/Paid Seats Quota. No …
- top 3:
  - Shri Sathya Sai Medical College and RI (India, Safe)
  - Mahatma Gandhi Medical College (India, Reach)
  - Krishna Inst. of Med. Scie. (India, Reach)

### ✅ IN-500-OBC-RJ
- count: **10**, tiers: `{"Safe":10}`
- tuition USD range: 27545–27545 · total USD range: 155689–155689
- analysis (649 chars): Estimated AIR rank: 3,35,500 (~86.02 percentile, OBC). Tier mix: 10 safe, 0 good, 0 reach, 0 stretch picks across 10 colleges (NEET 2024 cutoff data). Top recommendation: Shri Sathya Sai Medical College and Research Institute (Tamil Nadu) — Safe tier, closing rank 4,12,262 for Open under Deemed/Paid…
- top 3:
  - Shri Sathya Sai Medical College and Research Institute (India, Safe)
  - Chettinad Hos. and Res. Inst. (India, Safe)
  - Mahatma Gandhi Medical College (India, Safe)

### ✅ IN-450-OPEN-KL
- count: **10**, tiers: `{"Safe":1,"Good":4,"Reach":5}`
- tuition USD range: 27545–27545 · total USD range: 155689–155689
- analysis (600 chars): Estimated AIR rank: 5,25,000 (~78.13 percentile, OPEN). Tier mix: 1 safe, 4 good, 5 reach, 0 stretch picks across 10 colleges (NEET 2024 cutoff data). Top recommendation: Shri Sathya Sai Medical College and RI (Tamil Nadu) — Safe tier, closing rank 13,32,973 for Open under Deemed/Paid Seats Quota. Y…
- top 3:
  - Shri Sathya Sai Medical College and RI (India, Safe)
  - BV Deemed Uni. Med. College and Hos. (India, Good)
  - Sri Lakshmi Narayana Inst. of Med. Scien. (India, Good)

### ✅ IN-400-OPEN-PB
- count: **10**, tiers: `{"Safe":1,"Reach":9}`
- tuition USD range: 27545–27545 · total USD range: 155689–155689
- analysis (604 chars): Estimated AIR rank: 7,60,000 (~68.33 percentile, OPEN). Tier mix: 1 safe, 0 good, 9 reach, 0 stretch picks across 10 colleges (NEET 2024 cutoff data). Top recommendation: Shri Sathya Sai Medical College and RI (Tamil Nadu) — Safe tier, closing rank 13,32,973 for Open under Deemed/Paid Seats Quota. Y…
- top 3:
  - Shri Sathya Sai Medical College and RI (India, Safe)
  - Mahatma Gandhi Medical College (India, Reach)
  - Krishna Inst. of Med. Scie. (India, Reach)

### ✅ IN-350-EWS-WB
- count: **10**, tiers: `{"Safe":1,"Reach":9}`
- tuition USD range: 27545–27545 · total USD range: 155689–155689
- analysis (604 chars): Estimated AIR rank: 10,29,000 (~57.13 percentile, EWS). Tier mix: 1 safe, 0 good, 9 reach, 0 stretch picks across 10 colleges (NEET 2024 cutoff data). Top recommendation: Shri Sathya Sai Medical College and RI (Tamil Nadu) — Safe tier, closing rank 13,32,973 for Open under Deemed/Paid Seats Quota. Y…
- top 3:
  - Shri Sathya Sai Medical College and RI (India, Safe)
  - Mahatma Gandhi Medical College (India, Reach)
  - Krishna Inst. of Med. Scie. (India, Reach)

### ✅ IN-280-OPEN-AP
- count: **10**, tiers: `{"Good":1,"Reach":9}`
- tuition USD range: 27545–27545 · total USD range: 155689–155689
- analysis (605 chars): Estimated AIR rank: 12,24,000 (~49.00 percentile, OPEN). Tier mix: 0 safe, 1 good, 9 reach, 0 stretch picks across 10 colleges (NEET 2024 cutoff data). Top recommendation: Shri Sathya Sai Medical College and RI (Tamil Nadu) — Good tier, closing rank 13,32,973 for Open under Deemed/Paid Seats Quota. …
- top 3:
  - Shri Sathya Sai Medical College and RI (India, Good)
  - Mahatma Gandhi Medical College (India, Reach)
  - Krishna Inst. of Med. Scie. (India, Reach)

### ✅ EDGE-rank100-OPEN
- count: **10**, tiers: `{"Safe":10}`
- tuition USD range: 958–4192 · total USD range: 7186–23952
- analysis (611 chars): Estimated AIR rank: 100 (~99.99 percentile, OPEN). Tier mix: 10 safe, 0 good, 0 reach, 0 stretch picks across 10 colleges (NEET 2024 cutoff data). Top recommendation: Vardhman Mahavir Medical College and Safdarjung Hospital New Delhi — Safe tier, closing rank 141 for Open under All India. No budget …
- top 3:
  - Vardhman Mahavir Medical College and Safdarjung Hospital New Delhi (India, Safe)
  - Maulana Azad Medical College (India, Safe)
  - Maulana Azad (India, Safe)

### ✅ EDGE-rank1.5M-OPEN
- count: **10**, tiers: `{"Reach":5,"Stretch":5}`
- tuition USD range: 27545–27545 · total USD range: 155689–155689
- analysis (666 chars): Estimated AIR rank: 15,00,000 (~37.50 percentile, OPEN). Tier mix: 0 safe, 0 good, 5 reach, 5 stretch picks across 10 colleges (NEET 2024 cutoff data). Top recommendation: BV Deemed Uni. Med. College and Hos. (Maharashtra) — Reach tier, closing rank 5,14,800 for Open under Deemed/Paid Seats Quota. N…
- top 3:
  - BV Deemed Uni. Med. College and Hos. (India, Reach)
  - Sri Lakshmi Narayana Inst. of Med. Scien. (India, Reach)
  - Saveetha Medical College (India, Reach)

### ✅ EDGE-OPEN_PWD-state
- count: **10**, tiers: `{"Safe":10}`
- tuition USD range: 958–27545 · total USD range: 7186–155689
- analysis (632 chars): Estimated AIR rank: 1,65,000 (~93.13 percentile, OPEN_PWD). Tier mix: 10 safe, 0 good, 0 reach, 0 stretch picks across 10 colleges (NEET 2024 cutoff data). Top recommendation: SRM Medical College and Hospital (Tamil Nadu) — Safe tier, closing rank 1,95,886 for Open under Deemed/Paid Seats Quota. You…
- top 3:
  - SRM Medical College and Hospital (India, Safe)
  - AIIMS Bathinda (India, Safe)
  - JIPMER KARAIKAL (India, Safe)

### ✅ GL-Russia-Georgia-30k
- count: **10**, tiers: `{"Safe":4,"Good":4,"Reach":2}`
- tuition USD range: 3000–5500 · total USD range: 15000–33000
- analysis (750 chars): Your NEET score of 600 is excellent, making you eligible for top programs abroad; however, the ~$30,000 USD total program budget (tuition only) is a significant constraint for 5-6 years. This list prioritizes very affordable universities in Russia and Kyrgyzstan, alongside budget-friendly options in…
- top 3:
  - Orenburg State Medical University (Russia, Safe)
  - Perm State Medical University (Russia, Safe)
  - Tver State Medical University (Russia, Good)

### ✅ GL-Phil-Bang-18k
- count: **10**, tiers: `{"Safe":2,"Good":5,"Reach":3}`
- tuition USD range: 3500–4800 · total USD range: 17500–27000
- analysis (753 chars): Your NEET score of 540 is excellent, securing admission to many reputable MBBS programs abroad. The primary challenge is the very tight ~$18,000 USD total program budget for 5-6 years of tuition. While some options listed, particularly from Kyrgyzstan, are very close to this, most quality MBBS progr…
- top 3:
  - Jalal-Abad State University (Kyrgyzstan, Safe)
  - Asian Medical Institute (AMI) (Kyrgyzstan, Safe)
  - Osh State University (Kyrgyzstan, Good)

### ✅ GL-EU-Hungary-Poland-48k
- count: **10**, tiers: `{"Reach":3,"Good":6,"Safe":1}`
- tuition USD range: 6600–16900 · total USD range: 39600–101400
- analysis (406 chars): Your 620 NEET score is excellent for abroad MBBS. Hungary and Poland, while preferred for EU clinical exposure, typically exceed your $48,000 USD tuition budget. I've included options from these countries ("Reach" due to cost) and budget-friendly Romanian universities like Ovidius, which fits your p…
- top 3:
  - University of Debrecen (Hungary, Reach)
  - University of Szeged (Hungary, Reach)
  - Medical University of Gdansk (Poland, Good)

### ✅ GL-CIS-Kaz-Kyrg-30k
- count: **10**, tiers: `{"Safe":5,"Good":3,"Reach":2}`
- tuition USD range: 3800–5500 · total USD range: 19000–33000
- analysis (808 chars): The student's NEET score of 500 makes them eligible for all recommended NMC-recognized universities in Kazakhstan and Kyrgyzstan, which primarily require a qualifying NEET score. The recommendations are precisely tailored to your preferred countries, offering a diverse range of options within these …
- top 3:
  - South Kazakhstan Medical Academy (SKMA) (Kazakhstan, Safe)
  - Semey Medical University (Kazakhstan, Safe)
  - Karaganda Medical University (KSMU) (Kazakhstan, Good)

### ✅ GL-OpenSearch-80k
- count: **10**, tiers: `{"Reach":2,"Good":4,"Safe":4}`
- tuition USD range: 4500–8500 · total USD range: 27000–51000
- analysis (536 chars): Your exceptional NEET score of 660 and $80,000 USD tuition budget (6 years) position you for highly competitive MBBS programs abroad. This selection includes globally-ranked Russian universities (e.g., QS Top 400) alongside strong options in Georgia, Kazakhstan, Kyrgyzstan, and Armenia, all fitting …
- top 3:
  - I.M. Sechenov First Moscow State Medical University (Russia, Reach)
  - Kazan Federal University (Russia, Good)
  - Novosibirsk State University (Russia, Reach)


## Verdict

- ✅ 20 clean
- ⚠️ 0  warnings (count<10, missing USD, short analysis)
- ❌ 0  failures (network / 5xx)
---

## Quality Validation (web spot-checks)

Sample-based fact-check of 5 recommendations (Gemini-generated abroad picks) against authoritative sources.

| University | Reported tuition USD/yr | Web source | NMC recognized? | Verdict |
|---|---|---|---|---|
| Orenburg State Medical University (Russia) | $3,000–$5,500 | $4,500–$6,000/yr (multiple consultancies; ruseducation, ensureeducation, edufever) | ✅ NMC + WDOMS + WHO + FAIMER | ✅ in-range |
| Jalal-Abad State University (Kyrgyzstan) | $3,500–$4,800 | $3,500–$5,000/yr (NMC-listed) | ✅ NMC + WDOMS + WHO + IMED | ✅ in-range |
| South Kazakhstan Medical Academy (SKMA) | $3,800–$5,500 | $3,000–$4,500/yr | ✅ NMC + WHO + ECFMG | ✅ in-range (slight upper drift) |
| I.M. Sechenov First Moscow State Medical | $4,500–$8,500 | $6,000–$11,800/yr (QS 851–900, NOT Top 400) | ✅ NMC | ⚠️ Lower bound too low; some prompts called it "QS Top 400" but actual is 851–900 |
| University of Debrecen (Hungary) | $6,600–$16,900 | $15,000–$17,000/yr | ✅ NMC; EU programme | ✅ upper-range matches; lower bound is too cheap (likely Romanian backup confused into the same bucket) |

### Findings

- ✅ **All sampled abroad universities are real and NMC-recognised.** No hallucinated names.
- ✅ **Fees are within ~30% of public consultancy data** for budget Russia/CIS/Kyrgyzstan picks.
- ⚠️ **High-end EU schools (Hungary/Poland) show wider spread.** Gemini sometimes blends Romanian backup options into the same range, making the lower bound appear too cheap.
- ⚠️ **Ranking phrasing imprecise.** Sechenov was occasionally described as "Top 400 QS" in the recommendation text; actual 2026 rank is 851–900. The numeric `globalRank` field is usually accurate; loose descriptive text in `bestFor` / `reputationScore` should be tightened in the prompt.

### India CSV-driven results

Closing ranks come directly from the official MCC NEET 2024 cutoff CSV (`data/neet/cutoffs_yearly/neet_cutoffs_2024.csv`, 5,264 MBBS rows). No fabrication risk — the data is authoritative MCC counselling output.

Known minor issues with India side:
- **Institute names truncated** by `instituteShortName()` (splits on first comma). Names like "SUH Maulana Mahmood Hasan Medical College" appear shortened. Tolerable; could be improved with a smarter parser.
- **Fee buckets are coarse** (3 quota-based templates: govt / state-private / deemed). Real fees vary college-by-college; we use the mid-point. Acceptable for shortlisting purposes.

### Recommendations

1. (Done) Fix only-1-result bug — 3-pass build now guarantees 10 picks ✅
2. (Done) Fix INR/USD toggle — driven by canonical numeric fields ✅
3. (Done) Detailed analysis — 400–800 chars covering rank, tier mix, top pick, budget, next step ✅
4. **Future:** tighten Gemini prompt to require the ranking source to be quoted verbatim from the schema's `globalRank`/`rankingSource` rather than re-narrated in `bestFor`. This will eliminate "QS Top 400" mismatches.
5. **Future:** add a per-college fee dictionary (csv-backed) for the 50–100 most-recommended Indian colleges to replace coarse bucket fees with actuals.

Sources:
- [Orenburg State Medical Uni (Edufever)](https://www.edufever.com/orenburg-state-medical-university/)
- [Jalal-Abad NMC list (SelectYourUniversity)](https://www.selectyouruniversity.com/blog/top-medical-universities-in-kyrgyzstan)
- [SKMA fee + NMC](https://www.eklavyaoverseas.com/south-kazakhstan-medical-academy/)
- [Sechenov University (TopUniversities)](https://www.topuniversities.com/universities/sechenov-university)
- [University of Debrecen (Yocket / Shiksha)](https://yocket.com/universities/university-of-debrecen-4306)
