## 1. Schema and Type Changes

- [x] 1.1 Add `RESOLUTION_VALUES = ["2160p", "1080p", "720p"] as const` constant in `opportunity.ts`
- [x] 1.2 Add optional `resolution` field to `OPPORTUNITY_SEARCH_SCHEMA` using `z.enum(RESOLUTION_VALUES)`
- [x] 1.3 Verify `OpportunitySearchInput` type is updated automatically via `z.infer`

## 2. Virtual Searchee Integration

- [x] 2.1 Update `createVirtualSearchee()` to append resolution to the `name` and `title` strings when `input.resolution` is provided
- [x] 2.2 Verify `resolutionDoesMatch()` in `metadataPasses()` correctly filters candidates based on the virtual searchee's new title

## 3. Tests

- [x] 3.1 Add test for valid resolution accepted (`2160p`, `1080p`, `720p`)
- [x] 3.2 Add test for invalid resolution rejected (`480p`, `4K`, `UHD`)
- [x] 3.3 Add test for `createVirtualSearchee` appending resolution to title
- [x] 3.4 Add test for `createVirtualSearchee` not appending resolution when omitted
- [x] 3.5 Run existing opportunity tests to confirm no regressions
