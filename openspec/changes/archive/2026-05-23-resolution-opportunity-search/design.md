## Context

The `POST /api/search/opportunity` endpoint creates a virtual searchee from user-supplied metadata (title + year + optional `imdbId`/`tmdbId`/etc.), runs Torznab searches against movie-capable indexers, then groups and scores the results. Resolution filtering currently happens inside `metadataPasses()` at Phase-1 scoring time via `resolutionDoesMatch()`, but since the virtual searchee has no resolution token in its title (`"The Matrix 1999"`), the check always passes through (both sides `undefined` → returns `true`). The resolution is only used for scoring (`getResolutionBonus()`), never for filtering.

The `RES_STRICT_REGEX` is already shared between `decide.ts` (via `constants.ts`) and `opportunity.ts` (locally defined copy at line 783). The existing resolution-matching logic is correct and battle-tested — we just need to give it something to match against.

## Goals / Non-Goals

**Goals:**
- Add an optional `resolution` field to `OPPORTUNITY_SEARCH_SCHEMA` accepting values `2160p`, `1080p`, `720p`
- Thread the resolution into the virtual searchee's `title` so `resolutionDoesMatch()` filters candidates
- Maintain `.strict()` validation — no unknown fields allowed
- Keep the existing scoring bonus (`getResolutionBonus()`) working as-is

**Non-Goals:**
- No changes to the Torznab `Query` interface or `createTorznabSearchQueries()` — resolution filtering is post-search only
- No changes to `decide.ts` or the main pipeline matching — opportunity search is an independent code path
- No new DB schema changes or config-level options
- No WebUI form updates (separate change)

## Decisions

### Decision 1: Append resolution to virtual searchee title vs. add a separate pre-filter

**Chosen: Append to virtual searchee title.**

The `resolutionDoesMatch()` call chain is:
```
searchOpportunities()
  → scorePhase1Groups()
    → metadataPasses()
      → resolutionDoesMatch(virtualSearchee.title, candidate.name)
```

If we append `" 2160p"` to the virtual searchee's `title`, the existing check works for free — no new filter functions, no new branches in already-functional code. The alternative (a separate pre-filter that loops over candidates and checks resolution) duplicates matching logic already present in `resolutionDoesMatch()` and `getResolutionBonus()`.

**Alternatives considered:**
- *Separate pre-filter function*: Adds code duplication and a second place to maintain resolution parsing — rejected.
- *Pass resolution as a separate param through `scorePhase1Groups()`*: Would require changing function signatures across 3 levels of the call stack — rejected as more invasive.

### Decision 2: Schema validation using Zod enum vs. regex check

**Chosen: `z.enum(["2160p", "1080p", "720p"])`.**

The `RES_STRICT_REGEX` matches exactly `2160p`, `1080p`, `720p` (and also `i` variants via `[pi]`, though `i` is extremely rare). Using a Zod enum gives instant validation with clear error messages at the API boundary and avoids re-parsing. The enum values match what the regex would match — no behavioral gap.

### Decision 3: Where to put the resolution values

**Chosen: Define `RESOLUTION_VALUES = ["2160p", "1080p", "720p"] as const` in `opportunity.ts` and reference it in the schema.**

The field is specific to the opportunity search API; it doesn't belong in shared constants. Placing it alongside the schema keeps the API surface definition co-located.

### Decision 4: No changes to `createTorznabSearchQueries`

The Torznab protocol spec does define `resolution` as a search parameter in some indexer implementations, but:
- It is not universally supported
- The opportunity search is already title+ID based (query vs. id-driven)
- Post-search filtering via the existing `resolutionDoesMatch()` is simpler and consistent with how cross-seed handles resolution everywhere else

## Risks / Trade-offs

- **[False negatives]**: If a candidate release uses a non-standard resolution label (e.g., `UHD`, `4K` instead of `2160p`), `RES_STRICT_REGEX` won't match it, and `resolutionDoesMatch()` would return `true` (both `undefined`), effectively filtering nothing. This is pre-existing behavior and not introduced by this change.
- **[Backward compatibility]**: Adding an optional field to a `.strict()` schema is safe — existing callers are unaffected. The new field is simply ignored when absent.
- **[Performance]**: Negligible — a single regex match per candidate is already happening; appending a token to a string is O(1).
