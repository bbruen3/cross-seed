## 1. Prerequisite — fix tracker name normalization in `parseTorznabResults`

- [x] 1.1 Update `(API)` regex in `parseTorznabResults` to be case-insensitive: `/\s*\(API\)\s*$/i`
- [x] 1.2 Update `(RSS)` regex in `parseTorznabResults` to be case-insensitive: `/\s*\(RSS\)\s*$/i`
- [x] 1.3 Add unit test: tracker name with `(api)` lowercase is stripped
- [x] 1.4 Add unit test: tracker name with `(Api)` mixed case is stripped
- [x] 1.5 Add unit test: tracker name with `(rss)` lowercase is stripped
- [x] 1.6 Add unit test: tracker name with no suffix is unchanged

## 2. Core Implementation — goldenTracker slot reservation in `runPhase2`

- [x] 2.1 Add optional `goldenTracker?: string` parameter to `runPhase2` function signature
- [x] 2.2 Ensure `eligible` is sorted descending by score on a fresh copy (stable sort guarantee) before top-N slice
- [x] 2.3 Implement slot reservation: after top-N selection, if `goldenTracker` is specified and none of `selected` contain it, replace `selected[selected.length-1]` with the highest-scoring golden-tracker group from `eligible.filter(g => !selected.includes(g))` (NOT all groups — must be pre-filter-passing only)
- [x] 2.4 Use case-insensitive exact comparison for golden tracker name matching (consistent with `rankOpportunities`)
- [x] 2.5 Update `searchOpportunities` to forward `input.goldenTracker` to `runPhase2` when phase is `"confirmed"`

## 3. Tests — `runPhase2` slot reservation

- [x] 3.1 Add test: golden tracker group outside top-N replaces the lowest-scoring slot
- [x] 3.2 Add test: golden tracker group already in top-N — no replacement occurs (no-op)
- [x] 3.3 Add test: no golden tracker specified — behavior unchanged (unchanged top-N)
- [x] 3.4 Add test: no golden tracker groups exist among eligible candidates — no replacement
- [x] 3.5 Add test: case-insensitive golden tracker name matching works (e.g., `"hd-torrents"` matches `"HD-Torrents"`)
- [x] 3.6 Add test: goldenTracker forwarding from `searchOpportunities` to `runPhase2` (tested indirectly via `selectPhase2Groups` forwarding; `searchOpportunities` integration setup is complex and out of scope)
- [x] 3.7 Add test: replacement draws from `eligible` pool only — pre-filter-failed groups not eligible
- [x] 3.8 Add test: sort stability — group with equal score to another is positioned consistently
