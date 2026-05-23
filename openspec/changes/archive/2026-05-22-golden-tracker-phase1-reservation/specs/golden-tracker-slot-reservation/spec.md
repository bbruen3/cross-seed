## ADDED Requirements

### Requirement: Torznab tracker name SHALL strip (API)/(RSS) suffixes case-insensitively

The tracker name extracted from Torznab results SHALL strip `(API)` and `(RSS)` suffixes regardless of casing, so that the golden tracker match in Phase 2 (and in `rankOpportunities`) can reliably identify golden tracker candidates.

#### Scenario: Lowercase "(api)" suffix stripped

- **WHEN** `parseTorznabResults` receives a Torznab item with an indexer name containing `(api)` (lowercase)
- **THEN** the output candidate's `tracker` field SHALL have the `(api)` suffix removed
- **AND** the remaining name SHALL be preserved

#### Scenario: Mixed-case "(Api)" suffix stripped

- **WHEN** `parseTorznabResults` receives a Torznab item with an indexer name containing `(Api)` (mixed case)
- **THEN** the output candidate's `tracker` field SHALL have the `(Api)` suffix removed

#### Scenario: No suffix present — name unchanged

- **WHEN** `parseTorznabResults` receives a Torznab item with an indexer name that has no `(API)` or `(RSS)` suffix
- **THEN** the output candidate's `tracker` field SHALL be the indexer name unchanged

### Requirement: Phase 2 reserves a slot for golden tracker candidates

When a `goldenTracker` is specified, the Phase 2 group selection SHALL reserve at least one fetch slot for the highest-scoring Phase-1 group that contains the golden tracker, regardless of that group's absolute Phase 1 score.

#### Scenario: Golden tracker group is outside top-N and gets reserved slot

- **WHEN** Phase 2 is called with `goldenTracker = "HD-Torrents"` and `topN = 5`
- **AND** the top-5 Phase-1 groups by score do not include any group with an HD-Torrents candidate
- **AND** there exists at least one Phase-1 group with passesPreFilter=true that contains an HD-Torrents candidate
- **THEN** the lowest-scoring group in the top-5 SHALL be replaced by the highest-scoring golden-tracker-containing group from beyond the top-5
- **AND** the output SHALL have exactly 5 groups

#### Scenario: Golden tracker group already in top-N — no replacement

- **WHEN** Phase 2 is called with `goldenTracker = "HD-Torrents"` and `topN = 5`
- **AND** at least one of the top-5 Phase-1 groups by score already contains an HD-Torrents candidate
- **THEN** no replacement SHALL occur
- **AND** the output SHALL be the same top-5 groups by score

#### Scenario: No golden tracker specified — behavior unchanged

- **WHEN** Phase 2 is called without a `goldenTracker` parameter (or with `undefined`)
- **THEN** the output SHALL be the top-N groups by Phase 1 score
- **AND** no slot reservation SHALL occur

#### Scenario: No golden tracker groups exist among eligible candidates

- **WHEN** Phase 2 is called with `goldenTracker = "HD-Torrents"` and `topN = 5`
- **AND** no Phase-1 group with `passesPreFilter = true` contains an HD-Torrents candidate
- **THEN** no replacement SHALL occur
- **AND** the output SHALL be the top-5 groups by Phase 1 score

#### Scenario: Replacement draws from eligible-only pool — pre-filter-failed groups not eligible

- **WHEN** Phase 2 is called with `goldenTracker = "HD-Torrents"` and `topN = 5`
- **AND** none of the top-5 `passesPreFilter = true` groups contain HD-Torrents
- **AND** there exists a group with `passesPreFilter = false` that contains HD-Torrents
- **AND** there also exists a group with `passesPreFilter = true` beyond the top-5 that contains HD-Torrents
- **THEN** the replacement SHALL draw from the `passesPreFilter = true` group (not the pre-filter-failed one)
- **AND** the pre-filter-failed group SHALL NOT be eligible for the reserved slot

### Requirement: Golden tracker comparison is case-insensitive exact match

The golden tracker name comparison in Phase 2 SHALL use case-insensitive exact matching (same contract as `rankOpportunities`).

#### Scenario: Case-insensitive match works

- **WHEN** Phase 2 is called with `goldenTracker = "hd-torrents"`
- **AND** a Phase-1 group contains a candidate with `tracker = "HD-Torrents"`
- **THEN** the comparison SHALL match
- **AND** slot reservation SHALL apply

### Requirement: Sort is explicit and stable — last element reliably has lowest score

The Phase 2 selection SHALL explicitly sort eligible groups by score descending on a fresh copy before slicing. The index `selected[selected.length - 1]` MUST reliably reference the group with the lowest score among the selected set, even when multiple groups share identical scores.

#### Scenario: Stable sort with equal scores

- **WHEN** Phase 2 is called with `topN = 3`
- **AND** the eligible groups have scores `[300, 200, 200, 100]`
- **AND** the golden tracker group has score `150` and is outside the top-3
- **AND** none of the top-3 contain the golden tracker
- **THEN** `selected[selected.length - 1]` SHALL be the group with score `100` (the lowest)
- **AND** the replacement SHALL swap the `100`-score group, NOT one of the `200`-score groups

### Requirement: searchOpportunities forwards goldenTracker to runPhase2

The `searchOpportunities` orchestrator SHALL pass `input.goldenTracker` to `runPhase2` when the phase is `"confirmed"`.

#### Scenario: Golden tracker forwarded to Phase 2

- **WHEN** `searchOpportunities` is called with `goldenTracker = "HD-Torrents"` and `phase = "confirmed"`
- **THEN** `runPhase2` SHALL receive `goldenTracker = "HD-Torrents"`

#### Scenario: No golden tracker means undefined

- **WHEN** `searchOpportunities` is called without a `goldenTracker` field
- **THEN** `runPhase2` SHALL receive `undefined` for the golden tracker parameter
