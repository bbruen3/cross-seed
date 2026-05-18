## ADDED Requirements

### Requirement: Two-phase grouping strategy
The ranking engine SHALL use a two-phase approach. Phase 1 groups candidates by `(normalizedReleaseName, size)` from the Torznab response without fetching .torrent files. Phase 2 re-groups by confirmed infoHash for the top-N groups that pass Phase 1 pre-filters.

#### Scenario: Phase 1 grouping by normalized name + size with tolerance
- **WHEN** two indexers return candidates for the same encode with release names that differ only in whitespace, bracket characters, or prefix tags (e.g. `[Tracker] Movie 2024 1080p` vs `Movie.2024.1080p`)
- **THEN** normalization SHALL collapse separators, strip common indexer prefixes, and lowercase before comparison, and they SHALL be grouped together
- **WHEN** two candidates' sizes differ by less than `max(fuzzySizeThreshold * size, 10MB)`
- **THEN** the sizes SHALL be considered equal for grouping purposes

#### Scenario: Phase 1 grouping with name-only collision
- **WHEN** two indexers return candidates with the same normalized release name but sizes that differ beyond the tolerance band (different encodes)
- **THEN** they SHALL remain as separate Phase-1 groups

#### Scenario: Phase 2 confirmation via fetched infoHash
- **WHEN** a Phase-1 group passes pre-filter and is selected for Phase 2
- **THEN** the ranking engine SHALL fetch the .torrent via `snatch()` for each candidate in the group, extract infoHashes, and re-group by confirmed infoHash
- **THEN** if two Phase-1 groups resolve to the same infoHash, they SHALL be merged

#### Scenario: Phase 2 partial snatch failure
- **WHEN** a Phase-1 group has 3 trackers and `snatch()` fails for 1 (rate limited / magnet link / download failure)
- **THEN** the group SHALL NOT be dropped — the failed tracker SHALL be removed from the group's tracker list
- **THEN** as long as at least one tracker's .torrent was fetched successfully, the group SHALL survive to assessment

#### Scenario: Phase 2 total snatch failure
- **WHEN** all trackers in a Phase-1 group fail `snatch()`
- **THEN** the group SHALL be dropped from final results
- **THEN** `meta.trackerFetchFailures` SHALL be incremented by the number of failed trackers across all groups

#### Scenario: Phase 2 assessment (no file tree comparison)
- **WHEN** a Phase-2 .torrent is fetched successfully
- **THEN** the engine SHALL extract the infoHash, verify the size matches the Torznab-reported size within tolerance, and check the blocklist
- **THEN** it SHALL NOT run `compareFileTrees` or `compareFileTreesIgnoringNames` (the virtual searchee has no real files)
- **THEN** if infoHash collision check and blocklist check pass, the result SHALL be assigned `matchDecision: "CONFIRMED_AVAILABLE"` and `verification: "fetched"`

### Requirement: Phase 1 pre-filter
Before Phase-2 .torrent fetches, each Phase-1 group SHALL pass a lightweight pre-filter to avoid unnecessary downloads.

#### Scenario: Size alignment filter
- **WHEN** the virtual searchee has a known estimated size
- **THEN** the group's representative size MUST be within the configured `fuzzySizeThreshold` of the estimated size to qualify for Phase 2

#### Scenario: Metadata compatibility filter
- **WHEN** group candidates have resolution, source, or release group metadata extractable from their title
- **THEN** they MUST pass the same static checks as `assessCandidate` (release group match, resolution match, source match) to qualify for Phase 2

#### Scenario: Configurable Phase-2 limit
- **WHEN** more groups pass pre-filter than the configured Phase-2 limit
- **THEN** only the top-N highest-scoring Phase-1 groups SHALL proceed to Phase 2, where N is configurable (default 5)

### Requirement: Scoring by cross-seed opportunity
The ranking engine SHALL assign a numerical `score` to each final opportunity group based on a weighted formula: primary weight on tracker count, secondary weight on decision match quality.

#### Scenario: Higher tracker count scores higher
- **WHEN** group A has `trackerCount: 3` and group B has `trackerCount: 1`
- **THEN** group A SHALL have a higher `score` than group B

#### Scenario: Same tracker count, better match quality wins
- **WHEN** group A (trackerCount: 2, matchDecision: MATCH) and group B (trackerCount: 2, matchDecision: MATCH_SIZE_ONLY)
- **THEN** group A SHALL have a higher `score` than group B

### Requirement: Golden tracker bonus
If a `goldenTracker` is specified in the request, the ranking engine SHALL apply a score multiplier to any opportunity group where one of the hosting trackers matches the golden tracker name.

#### Scenario: Golden tracker match boosts score
- **WHEN** `goldenTracker: "MyTracker"` is specified and group A is available on "MyTracker"
- **THEN** group A SHALL receive a score multiplier, and `availableOnGoldenTracker` SHALL be `true` in the response

#### Scenario: Golden tracker name matching
- **WHEN** the golden tracker name partially matches a candidate's tracker name from any indexer
- **THEN** the engine SHALL normalize both strings for case-insensitive exact comparison between the golden tracker string and the `tracker` field of each candidate
- **THEN** substring/partial matching SHALL NOT be used

### Requirement: Golden tracker coverage at top level
The response SHALL include a top-level `goldenTracker` field summarizing coverage, in addition to per-result `availableOnGoldenTracker`.

#### Scenario: Golden tracker coverage calculation
- **WHEN** `goldenTracker: "MyTracker"` is specified and results contain both golden-available and golden-unavailable groups
- **THEN** the response SHALL include `goldenTracker: {name: "MyTracker", totalResults: 10, availableOnGolden: 3, notAvailableOnGolden: 7}`
- **THEN** the per-result `availableOnGoldenTracker` boolean SHALL still be present on each `OpportunityItem`

#### Scenario: No golden tracker
- **WHEN** `goldenTracker` is not specified
- **THEN** `goldenTracker` in the response SHALL be `null`

#### Scenario: Zero golden coverage is explicit signal
- **WHEN** `goldenTracker: "MyTracker"` is specified but no result is available on that tracker
- **THEN** `goldenTracker.availableOnGolden` SHALL be 0 and `goldenTracker.notAvailableOnGolden` SHALL equal `totalResults`

### Requirement: Response structured with metadata
The ranking engine SHALL return a response containing `results` (ordered array of opportunity groups with full metadata), `goldenTracker` (coverage summary), and `meta` (search metadata).

#### Scenario: Full result shape for confirmed phase
- **WHEN** a confirmed-phase opportunity search completes
- **THEN** each result item SHALL contain: `infoHash` (string), `torrentName` (string), `trackers: string[]`, `trackerCount` (number), `size` (number), `matchDecision` (string, `"CONFIRMED_AVAILABLE"`), `verification` ("fetched"), `score` (number), `pubDate` (number), `availableOnGoldenTracker` (boolean), and `link` (string)
- **THEN** `meta` SHALL contain: `indexersQueried` (number), `indexersRateLimited` (number), `candidatesEvaluated` (number), `candidatesFetched` (number), `trackerFetchFailures` (number), `phase` ("confirmed"), `duration` (number)

#### Scenario: Result shape for lightweight phase
- **WHEN** a lightweight-phase opportunity search completes
- **THEN** each result item SHALL contain the same fields as confirmed phase EXCEPT `infoHash` SHALL be `null` and `verification` SHALL be `"heuristic"`
- **THEN** `meta.phase` SHALL be `"lightweight"` and `meta.candidatesFetched` SHALL be `0`

#### Scenario: Results sorted by score descending
- **WHEN** results are returned
- **THEN** they SHALL be sorted by `score` descending (highest cross-seed opportunity first)
