## Why

The `POST /api/search/opportunity` endpoint cannot filter results by resolution. Users searching for cross-seed opportunities must wade through all resolutions — 720p, 1080p, 2160p — even when they only want a specific one. Resolution filtering is already built into the matching pipeline (`resolutionDoesMatch` in both `decide.ts` and `opportunity.ts`), but the opportunity search creates a virtual searchee with no resolution token in its title, so the check always passes through. Adding a resolution input field lets users constrain results without extra client-side filtering.

## What Changes

- Add an optional `resolution` field to `OPPORTUNITY_SEARCH_SCHEMA` accepting values matching the existing `RES_STRICT_REGEX` pattern (`2160p`, `1080p`, `720p`)
- Thread the resolution into the virtual searchee's title so the existing `resolutionDoesMatch()` check works naturally
- The `decide.ts`/`opportunity.ts` `resolutionDoesMatch()` is already parameterized on searchee title + candidate name — no changes needed to matching logic itself
- No changes to the Torznab query construction; resolution filtering is post-search on the returned candidates

## Capabilities

### New Capabilities
- `opportunity-resolution-filter`: Allow callers of `POST /api/search/opportunity` to supply an optional `resolution` parameter to filter results to a specific resolution

### Modified Capabilities
- *(none — no existing spec is changing)*

## Impact

- **Schema**: `OPPORTUNITY_SEARCH_SCHEMA` gains one optional field
- **API contract**: `POST /api/search/opportunity` accepts a new `resolution` field; `.strict()` validation remains — unknown fields are still rejected
- **Virtual searchee**: `createVirtualSearchee()` appends the resolution into the title string, enabling the existing `resolutionDoesMatch()` pipeline to filter candidates
- **Scoring**: `getResolutionBonus()` in the ranking phase will naturally award the correct bonus to the desired resolution — no change needed
- **WebUI** (if applicable): the opportunity search form may need a resolution dropdown in a future change; this spec only covers the backend API
