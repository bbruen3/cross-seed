## Context

The `opportunity.ts` module implements a two-phase search for cross-seed candidates:

- **Phase 1** (`groupPhase1` + `scorePhase1Groups`): Raw Torznab results are grouped by (normalizedReleaseName, size-with-tolerance). Each group is scored by `uniqueTrackers * 100 + resolutionBonus`. Only the top-5 groups (by default) proceed to Phase 2.
- **Phase 2** (`runPhase2`): Fetches `.torrent` files for each candidate in the top-N groups, extracts infoHashes, validates sizes/blocklists, and returns confirmed results.
- **Ranking** (`rankOpportunities`): Confirmed results are scored (including a +50 golden tracker bonus) and filtered to show only golden-tracker results.

The flaw: Phase 1 scoring has zero awareness of the golden tracker. A group from HD-Torrents (the golden tracker) with 1 tracker = score 100. A group from SeedPool with 3 trackers = score 300. The SeedPool group wins the top-5 slot, the HD-Torrents group gets dropped, Phase 2 never fetches it, and `rankOpportunities` sees zero golden-tracker results.

The lightweight path has a workaround: it applies the golden tracker filter before selecting the top-N. The confirmed path needs an equivalent fix.

## Goals / Non-Goals

**Goals:**
- Guarantee at least one Phase 2 fetch slot goes to a golden tracker Phase-1 group (if one exists).
- Preserve existing scoring logic — no changes to how groups are scored.
- Maintain backward compatibility: when `goldenTracker` is not specified, behavior is unchanged.
- Avoid redundant fetches: if the golden tracker group already ranks in the top-N by score, no extra slot is consumed.

**Non-Goals:**
- Not changing the golden tracker score bonus in `rankOpportunities` that runs after Phase 2.
- Not changing group scoring in `scorePhase1Groups` (no golden tracker weight added to Phase 1 scores).
- Not adding multi-golden-tracker support (still one golden tracker string).
- Not modifying the lightweight path (it already handles golden filtering correctly).

## Prerequisites

### Fix tracker name normalization in `parseTorznabResults`

The golden tracker comparison is a case-insensitive exact match. If the tracker name in the candidate record doesn't match the user's configured golden tracker name, the reservation logic will never find a golden tracker group — even when one exists.

The current code at `torznab.ts:142-150` strips `(API)` and `(RSS)` suffixes with **case-sensitive** regexes:
```typescript
.replace(/\s*\(API\)\s*$/, "")
.replace(/\s*\(RSS\)\s*$/, "")
```

These will not match `(api)`, `(Api)`, `(rss)`, etc. Prowlarr/Jackett can produce indexer names with varied casing depending on configuration. The fix is to add the `i` flag to both regexes:
```typescript
.replace(/\s*\(API\)\s*$/i, "")
.replace(/\s*\(RSS\)\s*$/i, "")
```

**This must be done before implementing slot reservation.** Without it, the reservation logic can never identify golden tracker groups on indexers whose names appear with lowercase suffixes, and Phase 1 slot reservation would be a no-op in all cases where this mismatch occurs.

For testability, this fix can be verified by writing a unit test against `parseTorznabResults` with mocked XML containing `(api)` or `(rss)` suffixes — the output tracker name should be stripped regardless of case.

## Decisions

### Decision 1: Slot reservation in `runPhase2` rather than score injection

**Choice**: Add an optional `goldenTracker` parameter to `runPhase2`. After normal top-N sorting, check if any of the selected groups contain the golden tracker. If not, replace the lowest-scoring selected group with the highest-scoring golden tracker group from the rest of the eligible pool.

**Why not score injection?** Adding a golden tracker bonus in `scorePhase1Groups` would change the semantics of Phase 1 scoring globally. A large enough bonus to guarantee top-5 placement (e.g., +500) would distort the ranking when multiple groups contain the golden tracker. A small bonus (+50) would still lose to high-tracker-count groups. Slot reservation is the only reliable mechanism.

**Alternative considered**: Inject golden tracker candidates into the selected set as a separate pre-pended step. Rejected because it could exceed the N limit. The replacement approach keeps the output set bounded to N.

**Alternative considered**: Pre-filter to only golden-tracker groups when golden tracker is specified. Rejected because the user wants to see golden tracker availability within a broader context (coverage report shows "available on golden: X, not available: Y").

### Decision 2: Replacement logic — lowest-score swap from eligible-only pool

**Implementation logic**:
1. Sort `eligible` (passesPreFilter groups) by score descending. Explicitly call `.sort()` after `.slice()` on a copy to guarantee the sort is stable and order is reliable.
2. Take the top N as `selected` (`selected = sorted.slice(0, N)`). `selected` remains sorted descending.
3. If no `goldenTracker` was provided → return `selected` (no-op, backward compatible).
4. Check if any group in `selected` contains the golden tracker (case-insensitive exact match).
5. If yes → return `selected` (no-op — golden tracker already represented).
6. If no → find the highest-scoring golden tracker group from the **remaining** pool, defined as `eligible.filter(g => !selected.includes(g))` — NOT `allGroups`. Groups that failed the Phase 1 pre-filter (passesPreFilter === false) must never be considered for the reserved slot, otherwise a correctly eliminated group could be promoted on golden-tracker grounds alone.
7. If a golden tracker group was found in the remaining pool → replace `selected[selected.length - 1]` (the lowest-scoring selected group, reliably the last element since the slice is sorted descending) with the golden tracker group.
8. If no golden tracker group exists in the remaining pool → return `selected` unchanged (no-op).
9. Return `selected`.

**Why `selected[selected.length - 1]` is safe**: The eligible array is explicitly sorted descending by score before slicing, and the slice produces a contiguous, same-order subset. The last element of `selected` is guaranteed to have the lowest score in the set. No other group in `selected` has a lower score, so replacing it is minimal displacement.

**Why lowest-score replacement?** This ensures no higher-scoring non-golden group is displaced. The golden tracker group gets the last slot — the lowest-scoring slot. This is the minimal interference with existing ranking.

### Decision 3: Signature change for `searchOpportunities`

`searchOpportunities` already has access to `input.goldenTracker`. It simply needs to forward it to `runPhase2`. Since `runPhase2` is not exported publicly (it's called only from `searchOpportunities`), this is a contained change.

## Risks / Trade-offs

| Risk | Mitigation |
|------|------------|
| Golden tracker group might fail fetch (rate-limited, invalid infoHash, etc.) — slot is "wasted" | This is the same risk as any Phase 2 fetch. The reservation only ensures the attempt is made. If it fails, no result for that slot — same as if a non-golden group failed. |
| If the golden tracker has no Phase-1 group (no results at all), reservation is a no-op | Already handled: we only replace if a golden tracker group exists among remaining eligible groups. |
| **Tracker name normalization**: If `parseTorznabResults` doesn't strip all suffix variations, the reservation logic won't find golden tracker groups even when they exist. | Fixed in prerequisites before reservation is implemented. Regex is updated to case-insensitive. Additional suffix patterns can be added as discovered. |
| Lowest-score replacement might displace a group the user wanted to see | The user configured this golden tracker specifically. If they want more results, they can increase top-N. This is the minimal displacement. |
| Edge case: N=1 and the single top group is not golden | The reservation replaces it with the golden tracker group (if one exists). The user explicitly asked for golden tracker results — this is the correct behavior. |
