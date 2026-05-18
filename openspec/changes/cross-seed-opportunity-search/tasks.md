## 1. Shared Validation Schema (Zod)

- [x] 1.1 Define `OPPORTUNITY_SEARCH_SCHEMA` in `src/opportunity.ts` with strict validation: `title` (required string), `year` (int, 1888 to currentYear+2), `imdbId` (optional, regex `^tt\d+$`), `tmdbId` (optional, positive int), `tvdbId` (optional, positive int), `tvMazeId` (optional, positive int), `goldenTracker` (optional string), `phase` (optional enum "lightweight"|"confirmed", default "confirmed")
- [x] 1.2 Export the Zod type `OpportunitySearchInput` from the schema for use in tRPC and REST handlers
- [x] 1.3 Unit tests for schema validation: missing title, year below 1888, year beyond current+2, bad imdbId pattern, invalid tmdbId type

## 2. Virtual Searchee Factory

- [x] 2.1 Implement `createVirtualSearchee(input: OpportunitySearchInput)` that returns a virtual `Searchee` with `name` = `"{title} {year}"`, a single placeholder file `{name: "placeholder.mkv", path: "placeholder.mkv", length: 1}`, `length: 1`, and `getMediaType` classifying as `MOVIE`
- [x] 2.2 Implement `buildParsedMedia(input: OpportunitySearchInput): ParsedMedia | undefined` that constructs `{movie: {imdbId?, tmdbId?, tvdbId?, tvMazeId?}, series: undefined, episodes: undefined}` from the optional external IDs — returns `undefined` if no IDs provided (triggers query-based search fallback)
- [x] 2.3 Unit tests for `createVirtualSearchee` covering movie classification, year formatting, ID passthrough, media type enforcement even with episode-like titles

## 3. Two-Phase Matching Pipeline — Phase 1

- [x] 3.1 Implement name normalization for grouping: lowercase, strip common indexer prefix/suffix bracket tags, collapse separators via existing `reformatTitleForSearching` / `cleanTitle`
- [x] 3.2 Implement Phase-1 grouping by `(normalizedReleaseName, size)` with size tolerance: sizes within `max(fuzzySizeThreshold * size, 10MB)` are considered equal
- [x] 3.3 Implement Phase-1 pre-filter: for each group, run size alignment check and metadata compatibility check (release group, resolution, source match using existing static check functions from `assessCandidate`)
- [x] 3.4 Score each Phase-1 group by `(trackerCount * 100) + (sizeProximityBonus)` and sort descending
- [x] 3.5 Unit tests for Phase 1: name normalization across indexer variants, size tolerance band, pre-filter pass/fail, scoring

## 4. Two-Phase Matching Pipeline — Phase 2

- [x] 4.1 Select top-N Phase-1 groups (configurable, default 5) and fetch .torrent via `snatch()` for each candidate in those groups
- [x] 4.2 Handle snatch failures per-tracker: remove failed tracker from the group but keep the group alive if ≥1 fetch succeeds; drop the group only if all fetches fail
- [x] 4.3 Extract infoHash from each fetched metafile and re-group by confirmed infoHash (merging groups that resolve to the same infoHash)
- [x] 4.4 Run simplified Phase-2 assessment on each fetched metafile: infoHash collision check (against `getInfoHashesToExclude()`), blocklist check, size consistency check — do NOT run `compareFileTrees` / `compareFileTreesIgnoringNames`
- [x] 4.5 If all Phase-2 checks pass, assign `matchDecision: "CONFIRMED_AVAILABLE"` and `verification: "fetched"`; otherwise exclude the group
- [ ] 4.6 Unit tests for Phase 2: partial snatch failure with group survival, total snatch failure with group drop, infoHash merge, CONFIRMED_AVAILABLE assignment, infoHash collision exclusion

## 5. Ranking Engine

- [x] 5.1 Implement `rankOpportunities(groups, goldenTracker?)` that sorts by score descending, computes per-group metadata, and aggregates golden tracker coverage
- [x] 5.2 Each result group SHALL include: `infoHash` (string or null for lightweight), `torrentName` (string), `trackers` (string[]), `trackerCount` (number), `size` (number), `matchDecision` (string), `verification` ("fetched"|"heuristic"), `score` (number), `pubDate` (number), `availableOnGoldenTracker` (boolean), `link` (string)
- [x] 5.3 Compute top-level `goldenTracker` coverage: `{name, totalResults, availableOnGolden, notAvailableOnGolden}` — or `null` if no golden tracker specified
- [x] 5.4 Compute `meta` block: `indexersQueried`, `indexersRateLimited`, `candidatesEvaluated`, `candidatesFetched`, `trackerFetchFailures`, `phase`, `duration`
- [x] 5.5 Unit tests for ranking: tracker count priority, golden tracker bonus/scoring, zero golden coverage signal, empty results, lightweight vs confirmed shape differences

## 6. Torznab Search Integration

- [x] 6.1 Reuse `makeRequests` + `createTorznabSearchQueries` from existing pipeline, calling them with the virtual Searchee + optional `ParsedMedia` and movie indexers
- [x] 6.2 Wire ID-based search (`t=movie` with IMDb/TMDB via `buildParsedMedia`) when external IDs are present, falling back to query-based search (`q=title+year`)
- [x] 6.3 Respect rate-limited indexers and search caps — only query indexers that support movie search and are not currently rate-limited
- [x] 6.4 Log all opportunity search activity under `Label.OPPORTUNITY` to distinguish quota consumption from RSS/search operations
- [ ] 6.5 Integration test: mock Torznab responses and verify search returns properly parsed candidates

## 7. REST API Endpoint

- [x] 7.1 Register `POST /api/search/opportunity` route in `src/routes/baseApi.ts` using the shared `OPPORTUNITY_SEARCH_SCHEMA` for validation
- [x] 7.2 Wire the route handler: validate request → create virtual Searchee → Phase-1 search + group → Phase-2 fetch + confirm → rank → return `{results, goldenTracker, meta}` response
- [x] 7.3 Handle error cases: validation error → 400 with field-level messages, invalid apikey → 401, all indexers rate-limited → 429, no results → 200 with empty results array
- [ ] 7.4 Integration test: start Fastify test server and verify full request/response cycle with mock indexers, including golden tracker coverage in response

## 8. tRPC Procedure

- [x] 8.1 Add `searchees.opportunitySearch` procedure in `src/trpc/routers/searchees.ts` using the shared `OPPORTUNITY_SEARCH_SCHEMA` as input
- [x] 8.2 Wire to the same opportunity search logic, returning `{results: OpportunityItem[], goldenTracker: ..., meta: {indexersQueried, indexersRateLimited, candidatesEvaluated, candidatesFetched, trackerFetchFailures, phase, duration}}`
- [ ] 8.3 Add tRPC type definitions to `packages/api-types` if the response types are not already covered by existing types

## 9. Cleanup & Verification

- [ ] 9.1 Run full test suite (`npm test`) and fix any regressions
- [ ] 9.2 Run `npm run typecheck` to ensure TypeScript compiles cleanly
- [ ] 9.3 Run `npm run lint` and ensure no new lint warnings
- [ ] 9.4 Verify the WebUI can call the new tRPC procedure and display results (manual check)
