## ADDED Requirements

### Requirement: API accepts optional resolution parameter

The `POST /api/search/opportunity` endpoint SHALL accept an optional `resolution` field in the request body. The field SHALL accept string values that match the existing `RES_STRICT_REGEX` pattern: `2160p`, `1080p`, or `720p`. When provided, only candidates whose release name contains a matching resolution SHALL be returned in the response. When omitted, behavior SHALL be identical to the current implementation (no resolution filtering).

#### Scenario: Resolution field is optional
- **WHEN** a client sends `POST /api/search/opportunity` with only `title` and `year`
- **THEN** the request SHALL be accepted and processed with no resolution filtering

#### Scenario: Valid resolution filters results
- **WHEN** a client sends `POST /api/search/opportunity` with `title`, `year`, and `"resolution": "1080p"`
- **THEN** the response SHALL only include candidates whose release name contains `1080p` (or `1080i`)

#### Scenario: Unsupported resolution value is rejected
- **WHEN** a client sends `POST /api/search/opportunity` with `"resolution": "480p"`
- **THEN** the server SHALL return a `400` validation error

#### Scenario: Strict mode still rejects unknown fields
- **WHEN** a client sends `POST /api/search/opportunity` with an unknown field (e.g., `"foo": "bar"`)
- **THEN** the server SHALL return a `400` validation error (unchanged behavior)

### Requirement: Virtual searchee includes resolution in its title

The `createVirtualSearchee()` function SHALL append the user-supplied resolution to the searchee's `name` and `title` fields so that the existing `resolutionDoesMatch()` check can compare it against candidate release names. The format SHALL be `"<title> <year> <resolution>"` when resolution is provided, and `"<title> <year>"` when omitted.

#### Scenario: Resolution appended to virtual searchee title
- **WHEN** `createVirtualSearchee()` is called with `{ title: "The Matrix", year: 1999, resolution: "2160p" }`
- **THEN** the resulting searchee's `title` SHALL be `"The Matrix 1999 2160p"`

#### Scenario: No resolution leaves title unchanged
- **WHEN** `createVirtualSearchee()` is called with `{ title: "The Matrix", year: 1999 }` (no resolution)
- **THEN** the resulting searchee's `title` SHALL be `"The Matrix 1999"`

#### Scenario: Resolution is passed through to matching pipeline
- **WHEN** `resolutionDoesMatch()` is called with a virtual searchee whose title includes a resolution
- **THEN** the check SHALL compare the virtual searchee's resolution against each candidate's release name resolution using the existing `RES_STRICT_REGEX` logic

### Requirement: Resolution does not affect search queries

The resolution field SHALL NOT be passed to Torznab indexers as a search parameter. Resolution filtering SHALL be applied post-search on the returned candidates. The Torznab `Query` interface and `createTorznabSearchQueries()` SHALL remain unchanged.

#### Scenario: No resolution in Torznab query
- **WHEN** `createTorznabSearchQueries()` is called for a virtual searchee with a resolution
- **THEN** the resulting `Query` objects SHALL NOT contain a resolution parameter

### Requirement: Resolution affects candidate scoring

When a `resolution` is specified, the scoring phase SHALL still apply `getResolutionBonus()` to all candidates, but candidates whose resolution does not match the requested resolution SHALL be filtered out before ranking.

#### Scenario: Non-matching resolution candidates excluded before scoring
- **WHEN** `"resolution": "1080p"` is specified
- **THEN** a candidate with `2160p` in its name SHALL be excluded from results, not just scored lower
