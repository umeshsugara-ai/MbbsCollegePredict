# State-Backfill Coverage Report

Generated: 2026-04-27

## Overall

- Years processed: 2019, 2020, 2021, 2022, 2023, 2024
- Total MBBS rows: 24,021
- Mapped by extractState() (state in address): 9,580 (39.88%)
- Unmapped before backfill: 14,441 (60.12%)
- Recovered by city_state_map: 14,379 (59.86%)
- Still unmapped after backfill: 62 (0.26%)

**State-parse lift: 39.88% → 99.74%**

## Map size

- Total city entries: 1200
- Distinct cities used in recovery: 398

## Top 30 cities by recovered rows

| City | State | Rows |
|------|-------|-----:|
| delhi | Delhi | 725 |
| kolkata | West Bengal | 299 |
| chennai | Tamil Nadu | 295 |
| mumbai | Maharashtra | 256 |
| patna | Bihar | 208 |
| nagpur | Maharashtra | 164 |
| pune | Maharashtra | 100 |
| raipur | Chhattisgarh | 100 |
| kalyani | West Bengal | 99 |
| gorakhpur | Uttar Pradesh | 98 |
| karaikal | Puducherry | 98 |
| bhubaneswar | Odisha | 97 |
| gulbarga | Karnataka | 94 |
| rajkot | Gujarat | 94 |
| tirupati | Andhra Pradesh | 92 |
| coimbatore | Tamil Nadu | 89 |
| lucknow | Uttar Pradesh | 88 |
| bhopal | Madhya Pradesh | 87 |
| jodhpur | Rajasthan | 82 |
| madurai | Tamil Nadu | 82 |
| jaipur | Rajasthan | 82 |
| faridabad | Haryana | 78 |
| visakhapatnam | Andhra Pradesh | 74 |
| wardha | Maharashtra | 74 |
| imphal | Manipur | 73 |
| vmmc | Delhi | 72 |
| hyderabad | Telangana | 71 |
| kolhapur | Maharashtra | 66 |
| deogarh | Odisha | 65 |
| banglore | Karnataka | 62 |

## Per-state recovered row count

| State | Rows recovered |
|-------|---------------:|
| Maharashtra | 1634 |
| Tamil Nadu | 1591 |
| Uttar Pradesh | 1280 |
| Karnataka | 1138 |
| West Bengal | 929 |
| Rajasthan | 838 |
| Delhi | 810 |
| Telangana | 654 |
| Madhya Pradesh | 650 |
| Andhra Pradesh | 627 |
| Bihar | 525 |
| Odisha | 475 |
| Kerala | 410 |
| Gujarat | 379 |
| Assam | 330 |
| Chhattisgarh | 316 |
| Himachal Pradesh | 266 |
| Haryana | 234 |
| Punjab | 206 |
| Puducherry | 185 |
| Jammu And Kashmir | 178 |
| Uttarakhand | 169 |
| Jharkhand | 163 |
| Manipur | 87 |
| Goa | 51 |
| Tripura | 43 |
| Andaman And Nicobar Islands | 42 |
| Dadra And Nagar Haveli | 41 |
| Mizoram | 39 |
| Chandigarh | 35 |
| Arunachal Pradesh | 30 |
| Meghalaya | 18 |
| Nagaland | 6 |

## Top 30 still-unmapped institute short names

Cities to add in the next iteration. The "Sample raw" column shows the full Allotted Institute string so you can identify the city.

| Rows | Short name | Sample raw |
|-----:|-----------|-----------|
| 22 | Government Medical | Government Medical College, Thiruvallur |
| 6 | Government Medical College | Government Medical College, Thiruvallur |
| 5 | Government | Government Medical College, Sundargarh |
| 4 | GOVERNMENT | GOVERNMENT MEDICAL COLLEGE NANDYAL |
| 3 | DR.S.C.GOVT | DR.S.C.GOVT MEDICAL COLLEGE,,NAN DED |
| 3 | GURU GOVIND | GURU GOVIND SINGH MED COLL,FARIDKO T |
| 3 | K.A.P. | K.A.P. VISWANATHAM G.M.C.,TIRUCHI RAPALLI |
| 3 | NORTH | NORTH BENGAL MED.COLL,DAR JEELING |
| 3 | R.G. KAR | R.G. KAR MEDICAL COLLEGE,KOLK ATA |
| 3 | Institute of Medical | Institute of Medical Sciences & SUM Hospital, Campus II |
| 2 | CHENGALPATT | CHENGALPATT U MEDICAL COLL,CHENGAL PATTU |
| 2 | GOVT.MEDICAL | GOVT.MEDICAL COLLEGE,THIR UVANANTHAPU RAM |
| 2 | M.G.M. | M.G.M. MEDICAL COLLEGE,JAMS HEDPUR |
| 1 | INST OF PG | INST OF PG MED EDU & RESEARCH,KO LKATA |

## Notes & ambiguities

- "Aurangabad" is mapped to Maharashtra (now Chhatrapati Sambhajinagar). Bihar also has an Aurangabad but no MBBS college there.
- "Hamirpur" is mapped to Himachal Pradesh by default (Dr. RPGMC Tanda is in Kangra dist; Hamirpur HP has a medical college). UP also has a Hamirpur — handled via "hamirpur-up" if needed.
- "Pratapgarh" is mapped to Rajasthan; UP variant uses "pratapgarh-up".
- "Bilaspur" is mapped to Chhattisgarh (the larger medical-college city); HP variant uses "bilaspur-hp".
- "Srinagar" is mapped to Jammu And Kashmir; the small Uttarakhand town uses "srinagar-uk" / "srinagar-garhwal".
- "Pondicherry"/"Puducherry" → Puducherry UT; "Karaikal" (JIPMER campus) and "Mahe" / "Yanam" also map to Puducherry.
- "Lady Hardinge" is mapped to Delhi via the institutional token "hardinge".
- "Vardhman Mahavir / Safdarjung / RML / ABVIMS / VMMC / UCMS" all map to Delhi via institutional tokens.
- "JIPMER" maps to Puducherry; "JIPMER Karaikal" still resolves correctly because "karaikal" → Puducherry.
- "Manipal" maps to Karnataka (Udupi district) — Kasturba Medical College is there. The Manipal University network spans multiple states.
