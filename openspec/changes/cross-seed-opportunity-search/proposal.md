## Why

cross-seed currently only searches for cross-seed opportunities based on torrents you already possess (either in your client, torrent dir, or data dirs). There is no way to proactively look up cross-seed opportunities for a specific movie or show by title, year, and external IDs. Users want to evaluate which tracker offers the best cross-seed potential before committing to a download — especially when deciding which tracker to download from among multiple they are a member of.

## What Changes

- **New API endpoint** — `POST /api/search/opportunity` that accepts a movie/title, year, optional external IDs (IMDb, TMDB, TVDB, TVMaze), and an optional "golden tracker" preference.
- **Opportunity search engine** — A new pipeline path that creates a lightweight virtual Searchee from the submitted metadata and searches all configured (non-rate-limited, media-type-supporting) indexers for matching candidates.
- **Decision aggregation & ranking** — The results are grouped by infoHash/torrent identity and enriched with which trackers host each variant, sizes, and decision quality. Results are ranked by cross-seed opportunity (most trackers having the same torrent = best opportunity).
- **Golden tracker filter** — If a golden tracker is specified, the response highlights which results are available on that tracker and scores them higher.
- **No injection** — This is a read-only query endpoint. No action is taken (no injection, no saving). Results are returned as JSON.
- **tRPC router procedure** — A corresponding `searchees.opportunitySearch` procedure in the tRPC API for the WebUI.

## Capabilities

### New Capabilities
- `opportunity-search-api`: Public REST + tRPC endpoint that accepts title, year, optional IDs, optional golden tracker, and returns ranked cross-seed opportunities.
- `virtual-searchee-factory`: Logic to construct a lightweight Searchee from user-supplied metadata (title, year, media type, external IDs) for the purpose of Torznab search without a real file on disk.
- `opportunity-ranking-engine`: Ranking algorithm that scores candidates by cross-seed potential — number of trackers hosting the same infoHash, decision match quality, size alignment, and golden tracker preference.

### Modified Capabilities
- *(None — this is entirely additive. No existing spec-level behavior changes.)*

## Impact

- **New file**: `src/opportunity.ts` — core opportunity search and ranking logic.
- **Modified files**:
  - `src/routes/baseApi.ts` — register the new `/api/search/opportunity` route.
  - `src/trpc/routers/searchees.ts` — add `opportunitySearch` procedure.
  - `src/pipeline.ts` — may export a helper for Torznab search that can accept an externally-constructed Searchee.
  - `src/torznab.ts` — `createTorznabSearchQueries` may need a small refactor to accept external IDs directly (it already does via `ParsedMedia`).
- **No new dependencies**. Leverages existing Torznab search infrastructure, indexer management, and decision assessment.
- **No breaking changes**. Existing endpoints, config, and behaviors are untouched.
