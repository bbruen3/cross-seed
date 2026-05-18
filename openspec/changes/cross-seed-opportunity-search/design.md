## Context

cross-seed already has a mature Torznab search pipeline (`searchTorznab` → `assessCandidates` → `performActions`) and a pre-filter / decide engine (`assessCandidate`, `assessCandidateCaching`) that can assess a candidate against a searchee. The key architectural insight is that the decision pipeline operates on the `Searchee` interface — which requires `files`, `name`, `title`, and `length`. Currently, every searchee is derived from a real torrent or data path.

To support proactive opportunity search, we need to construct a synthetic (virtual) searchee from user-supplied metadata. The existing `createTorznabSearchQueries` already supports two search modes: query-based (title string) and ID-based (via `ParsedMedia` from arr scan). For movies, the `t=movie` Torznab cap with external IDs (IMDb, TMDB) gives the best results.

### ParsedMedia constructability

The `ParsedMedia` type is defined as `{ movie: ExternalIds, series: undefined, episodes: undefined }` for movies. `ExternalIds` is `{ imdbId?: string, tmdbId?: string, tvdbId?: string, tvMazeId?: string }` — all fields are optional. There are no ARR-internal required fields (no `internalId`, no `radarrId`). Therefore `ParsedMedia` can be constructed directly from user-supplied external IDs without calling any ARR API. This is confirmed by inspecting the `getRelevantArrIds` function in `arr.ts`, which reads only the optional external ID fields from `parsedMedia.movie ?? parsedMedia.series`.

## Goals / Non-Goals

**Goals:**
- Allow users to submit a movie title + year (with optional IMDb, TMDB, TVDB, TVMaze IDs) and get back a ranked list of cross-seed opportunities from all configured indexers.
- Allow an optional "golden tracker" hint to bias ranking toward results available on that tracker.
- Return structured JSON with enough info to decide where to download: tracker name, torrent name, size, decision match quality, infoHash, and which trackers have the same release.
- Integrate as both a REST endpoint and tRPC procedure.
- Reuse the existing Torznab search infrastructure, indexer management, rate-limit handling, and decision assessment — zero new external dependencies.
- **High-confidence matching**: Only fetch .torrent files for candidates that pass a lightweight name+size pre-filter, minimizing unnecessary downloads.
- **Distinct observability**: Log opportunity searches under a separate label so users can distinguish quota consumption from real RSS/search operations.

**Non-Goals:**
- Injecting or saving anything — this is read-only.
- Searching for TV episodes or season packs (initial scope is movies only, extensible later).
- Searching via ARR integration — the user provides IDs directly.
- Ensemble/virtual season creation — this is for known content only.
- Persisting results to the database (no "decision" table entries, no searchee creation).
- Guaranteeing that a Phase-1 opportunity match will succeed in a real cross-seed assessment — results are "estimated" until confirmed.

## Decisions

### 1. Virtual Searchee Construction
A virtual searchee is constructed with: title, name (from user input), an estimated length (derived from a reasonable default or omitted for fuzzy matching), and a single generic file. The `getMediaType` will classify it as `MOVIE` based on the title format. External IDs are passed separately to `createTorznabSearchQueries` via the existing `ParsedMedia` interface, bypassing the ARR scan step.

**Alternatives considered:** Requiring ARR scan for every search. Rejected because the user may not have ARR configured, or the content may not be in their library.

### 2. Two-Phase Matching Pipeline (High Confidence, Minimal Fetches)

Opportunity search uses a two-phase approach to balance ranking accuracy against unnecessary .torrent downloads:

**Phase 1 — Lightweight grouping (no .torrent fetches):**
Candidates are grouped by `(normalizedReleaseName, size)` with tolerance. Across most trackers, the same release encode produces similar name+size tuples.

Key grouping rules:
- **Release name normalization**: Strip common indexer prefixes/suffixes (e.g. `[TrackerName] ` prefix, trailing whitespace, URL encoding artifacts). Normalize by lowercasing and collapsing whitespace before comparison. Use the same `reformatTitleForSearching`/`cleanTitle` utilities already in the codebase.
- **Size tolerance**: Sizes within `fuzzySizeThreshold` (typically ±1%) or a minimum tolerance of ±10 MB (whichever is larger) are considered equal. This accounts for indexers that round or truncate byte-level precision.
- If this tolerance is too loose, false groupings occur (different encodes clustered together). Too tight, same torrent on two indexers won't group, defeating the primary ranking signal. The default `fuzzySizeThreshold` from config (±2%) is a reasonable starting point, exposed as a tunable parameter.

Each Phase-1 group is filtered through a lightweight pre-assessment:
1. **Size alignment**: The group's representative size must fall within `fuzzySizeThreshold` of a target size if the user provided one (or estimated from similar results). If no size reference is available, this filter is skipped.
2. **Metadata match**: If the Torznab response includes resolution or source metadata in the title, it must be compatible with the virtual searchee (release group check, resolution check, source check using existing static check functions from `assessCandidate`).
3. Groups that pass both filters proceed to Phase 2.

**Phase 2 — Confirmed grouping (.torrent fetch for top-N):**
For the top-N candidate groups from Phase 1 (configurable, default 5):
1. The .torrent file is fetched via `snatch()` for each candidate in the group (the same function used by the real pipeline).
2. Actual infoHash is extracted from each fetched metafile.
3. Groups are re-aggregated by confirmed infoHash (some Phase-1 groups may split or merge).
4. A simplified assessment runs against the fetched metafile (see decision #6 — virtual searchee assessment).
5. If the assessment confirms availability, the group is promoted to final results.

**Phase 2 failure handling:**
- If `snatch()` fails for one tracker in a group (rate limit, magnet link, download failure), that tracker is removed from the group but the group survives if at least one tracker's .torrent was fetched successfully. This is more resilient than dropping the entire group on a single tracker failure.
- If all trackers in a group fail to fetch, the group is dropped.
- Failed trackers are noted in the response metadata (`trackerFetchFailures: number`).

**Top-N transparency:**
The response includes `meta.candidatesEvaluated` (total Phase-1 groups) and `meta.candidatesFetched` (Phase-2 groups selected for .torrent fetch). This surfaces that the user is seeing a filtered view, not exhaustive results.

This ensures that only high-confidence candidates trigger .torrent fetches, and that the final ranking is based on real infoHashes.

### 3. Result Ranking (Phase-2 Final)

Results are grouped by confirmed infoHash. The ranking score is a weighted combination of:
- **Tracker count** (primary): More trackers with the identical infoHash = better cross-seed opportunity
- **Decision quality** (secondary): MATCH > MATCH_SIZE_ONLY > MATCH_PARTIAL
- **Golden tracker bonus**: If a golden tracker is specified, results on that tracker get a score multiplier
- **Size alignment**: Closer to estimated size is better

Phase-1 results (when the user requests lightweight mode or Phase-2 is skipped) use `(name, size)` as the grouping key and omit infoHash from the response.

### 4. API Design
- **REST**: `POST /api/search/opportunity` with JSON body. Returns JSON with `results: OpportunityItem[]`, `goldenTracker: GoldenTrackerCoverage | null`, and `meta: SearchMeta`. Same auth model as existing endpoints (apikey query param).
- **tRPC**: `searchees.opportunitySearch` procedure on the existing searchees router, sharing the exact same Zod input schema as the REST endpoint.
- **Response shape**:
```typescript
interface OpportunityItem {
  // CONFIRMED phase only:
  infoHash: string | null;        // null in lightweight phase
  torrentName: string;
  trackers: string[];              // Trackers that had this result
  trackerCount: number;
  size: number;
  matchDecision: string;           // "CONFIRMED_AVAILABLE" (confirmed) or heuristic match quality (lightweight)
  verification: "fetched" | "heuristic";
  score: number;
  pubDate: number;
  availableOnGoldenTracker: boolean;
  link: string;
}

interface OpportunitySearchResponse {
  results: OpportunityItem[];
  goldenTracker: {
    name: string | null;
    totalResults: number;
    availableOnGolden: number;
    notAvailableOnGolden: number;
  } | null;
  meta: {
    indexersQueried: number;
    indexersRateLimited: number;
    candidatesEvaluated: number;      // Total Phase-1 groups
    candidatesFetched: number;         // Phase-2 groups selected for .torrent fetch
    trackerFetchFailures: number;      // Trackers where snatch() failed
    phase: "lightweight" | "confirmed";
    duration: number;                  // Wall-clock ms
  };
}
```

### 5. Input Validation (Shared Zod Schema)

REST and tRPC share an identical Zod schema to ensure consistent validation:
```typescript
const OPPORTUNITY_SEARCH_SCHEMA = z.object({
  title: z.string().min(1, "Title is required"),
  year: z
    .number()
    .int("Year must be an integer")
    .gte(1888, "Year must be >= 1888")      // Oldest known film
    .max(new Date().getFullYear() + 2, "Year must not be far in the future"),
  imdbId: z
    .string()
    .regex(/^tt\d+$/, "IMDb ID must match pattern tt{id}")
    .optional(),
  tmdbId: z.number().int().positive().optional(),
  tvdbId: z.number().int().positive().optional(),
  tvMazeId: z.number().int().positive().optional(),
  goldenTracker: z.string().min(1).optional(),
  phase: z
    .enum(["lightweight", "confirmed"])
    .optional()
    .default("confirmed"),
}).strict();
```

Validation errors produce clean 400 responses with field-level messages, preventing confusing downstream failures in the Torznab query builder.

### 6. Virtual Searchee Assessment in Phase 2

A critical design constraint: the virtual searchee has **no real file tree** — it contains a single placeholder file with `name: "placeholder.mkv"`, `path: "placeholder.mkv"`, `length: 1`. Calling `assessCandidate` with this searchee against a real metafile would produce meaningless file tree comparisons (`compareFileTrees` would always return false because the metafile has N files with different sizes, none matching the single placeholder).

Therefore, Phase 2 does NOT use `assessCandidate` for file tree comparison. Instead it uses a simplified assessment pipeline:

1. **Fetch** the .torrent via `snatch()` to get the real `Metafile` (infoHash, files, length, trackers).
2. **InfoHash collision check**: If the metafile's infoHash matches any infoHash the user already has (via `getInfoHashesToExclude()`), the result is marked `INFO_HASH_ALREADY_EXISTS` and excluded.
3. **Blocklist check**: If the metafile name or infoHash matches the blocklist, it's excluded.
4. **Size verification**: The metafile's actual `length` must align with the Torznab-reported candidate size within `fuzzySizeThreshold`. This catches cases where the Torznab indexer reported a different torrent than what was downloaded.
5. **Match decision**: If all the above pass, the result is assigned `CONFIRMED_AVAILABLE` — a new pseudo-decision indicating that the torrent exists on the tracker and can be downloaded for comparison, but full file tree match against the user's library isn't possible without a real searchee file.

The response schema communicates this clearly:
- `matchDecision` is `"CONFIRMED_AVAILABLE"` (not MATCH/MATCH_SIZE_ONLY/MATCH_PARTIAL).
- The result includes a `verification: "fetched"` or `verification: "unverified"` field.

**Alternatives considered:**
- Forcing a fake file tree match by sizing the placeholder to the candidate's total size. Rejected because `compareFileTreesIgnoringNames` iterates per-file, not per-total, so a single placeholder file never matches a multi-file torrent.
- Running full `assessCandidate` with `compareFileTrees` and accepting that it always produces `FILE_TREE_MISMATCH`. Rejected because the mismatch decision would be misleading — the torrent may be an exact match, we just can't verify it without the source files.

### 7. No DB Persistence
Unlike `searchForLocalTorrentByCriteria`, opportunity search does not create searchee records or decision entries. It's purely ephemeral. This avoids polluting the real search state with synthetic lookups.

## Risks / Trade-offs

- **Phase-1 grouping fragility (name normalization)**: Indexers trim, truncate, or reformat release names differently. A torrent named `Movie.2024.1080p.WEB-DL.DDP5.1.Atmos.H.264-GROUP` on one tracker might appear as `[TrackerName] Movie 2024 1080p WEB-DL DDP5 1 Atmos H 264-GROUP` on another. Aggressive normalization (lowercasing, stripping brackets, collapsing separators) is required but may over-match. → **Mitigation**: Use existing `reformatTitleForSearching` as the base normalizer. Phase 2 resolves false positives via confirmed infoHash.
- **Phase-1 grouping fragility (size tolerance)**: Size reported by Torznab can differ by a few bytes to a few MB between indexers due to rounding, truncation, or different block sizes. → **Mitigation**: Use `fuzzySizeThreshold` as the default tolerance (±2%), with a floor of ±10 MB. Expose size tolerance as a configurable parameter.
- **Top-N selection bias**: Selecting top-5 groups by name+size proxy before fetching means a false group could be promoted while a real cross-seed opportunity ranked 6th is missed. → **Mitigation**: Surface `candidatesEvaluated` vs `candidatesFetched` in the response so users see they're getting a filtered view. The Phase-2 limit is configurable.
- **No file tree comparison**: `assessCandidate` cannot run meaningful file tree comparison against a virtual searchee with no real files. Phase-2 match decisions are always `CONFIRMED_AVAILABLE`, not true MATCH/MATCH_SIZE_ONLY. A `CONFIRMED_AVAILABLE` torrent might not cross-seed against the user's actual files. → **Mitigation**: Set clear expectations in API docs and response schema (`verification: "fetched"`). The primary value is the infoHash + tracker list, which the user can use for cross-seed purposes.
- **Rate limiting / quota pressure**: Opportunity searches consume indexer API quota just like real searches. Repeated queries during an active RSS/search cycle can exhaust limits and delay real operations. → **Mitigation**: Log opportunity searches under a dedicated `Label.OPPORTUNITY` label so users can see quota impact in logs. Respect existing rate-limit state. Consider a configurable cooldown or separate rate-limit tracking for opportunity searches in a future iteration.
- **Size estimation**: A virtual searchee has no real size, so size-based filters are approximate. → **Mitigation**: Accept an optional `size` parameter from the user, or omit size-based filtering when no size is known.
- **No existing searchees**: Some filters (`filterByContent`, `filterTimestamps`) expect a searchee in the DB. Opportunity search skips these entirely since there's nothing to filter.
- **Lightweight-phase silent misinterpretation**: Lightweight results omit infoHash and use heuristic-only decisions. A caller that doesn't read the schema docs could treat a lightweight result as confirmed and make incorrect decisions. → **Mitigation**: `meta.phase` is set to `"lightweight"`, `infoHash` is `null`, and `verification` is `"heuristic"` — triple redundancy. API documentation explicitly warns that lightweight results are for ranking only, not download decisions.
