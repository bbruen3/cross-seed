## ADDED Requirements

### Requirement: Input validation schema
The system SHALL use a single shared Zod schema for both the REST endpoint and the tRPC procedure, applied at the boundary before any pipeline logic runs.

#### Scenario: Title is required
- **WHEN** a request omits `title`
- **THEN** the system SHALL reject with HTTP 400 and a message indicating title is required

#### Scenario: Year validated as 4-digit integer within reasonable range
- **WHEN** a request includes `year: 99` or `year: 99999`
- **THEN** the system SHALL reject with HTTP 400 and a validation error
- **WHEN** a request includes `year: "twenty-ten"`
- **THEN** the system SHALL reject with HTTP 400 (type error)
- **WHEN** a request includes `year: 1887` (before the oldest known film)
- **THEN** the system SHALL reject with HTTP 400
- **WHEN** a request includes `year: {currentYear + 3}` (beyond reasonable release horizon)
- **THEN** the system SHALL reject with HTTP 400

#### Scenario: IMDb ID pattern validation
- **WHEN** a request includes `imdbId: "invalid"`
- **THEN** the system SHALL reject with HTTP 400
- **WHEN** a request includes `imdbId: "tt1375666"`
- **THEN** validation SHALL pass

#### Scenario: TMDB/TVDB/TVMaze validated as positive integers
- **WHEN** a request includes `tmdbId: -5`
- **THEN** the system SHALL reject with HTTP 400
- **WHEN** a request includes `tmdbId: "abc"`
- **THEN** the system SHALL reject with HTTP 400

#### Scenario: Zod schema is shared
- **WHEN** the validation schema is updated
- **THEN** the same Zod schema object SHALL be referenced by both the REST route handler and the tRPC procedure input parser

### Requirement: Opportunity search REST endpoint
The system SHALL expose `POST /api/search/opportunity` that accepts a validated JSON body and returns a structured response with results, golden tracker coverage, and search metadata.

#### Scenario: Successful confirmed-phase search with golden tracker
- **WHEN** a user submits `POST /api/search/opportunity` with body `{"title": "Inception", "year": 2010, "imdbId": "tt1375666", "goldenTracker": "MyTracker"}`
- **THEN** the system SHALL respond with HTTP 200 and a JSON body containing:
  - `results`: array of ranked `OpportunityItem` objects, each with `infoHash` (string), `torrentName` (string), `trackers` (string[]), `trackerCount` (number), `size` (number), `matchDecision` (string, `"CONFIRMED_AVAILABLE"`), `verification` (string, `"fetched"`), `score` (number), `pubDate` (number), `availableOnGoldenTracker` (boolean), `link` (string)
  - `goldenTracker`: object with `name` ("MyTracker"), `totalResults` (number), `availableOnGolden` (number), `notAvailableOnGolden` (number)
  - `meta`: object with `indexersQueried` (number), `indexersRateLimited` (number), `candidatesEvaluated` (number), `candidatesFetched` (number), `trackerFetchFailures` (number), `phase` ("confirmed"), `duration` (number)

#### Scenario: Lightweight phase without golden tracker
- **WHEN** a user submits with `{"title": "Inception", "year": 2010, "phase": "lightweight"}`
- **THEN** the response SHALL have `infoHash` set to `null` for each result, `verification` set to `"heuristic"`, and `meta.phase` SHALL be `"lightweight"`
- **THEN** `meta.candidatesFetched` SHALL be `0`

#### Scenario: No results found
- **WHEN** no indexer returns results matching the search criteria
- **THEN** the system SHALL respond with HTTP 200, `results` SHALL be an empty array, `goldenTracker.totalResults` and `goldenTracker.availableOnGolden` SHALL both be 0

#### Scenario: Golden tracker with zero matches
- **WHEN** a golden tracker is specified but none of the results are available on it
- **THEN** the response SHALL include `goldenTracker: {name: "MyTracker", totalResults: 5, availableOnGolden: 0, notAvailableOnGolden: 5}` — this is meaningful signal that the user shouldn't download from that tracker for cross-seed purposes

#### Scenario: All indexers rate limited
- **WHEN** all configured indexers are currently rate-limited
- **THEN** the system SHALL respond with HTTP 429 and a message indicating indexers are rate limited

#### Scenario: Unauthorized request
- **WHEN** a request is made without a valid `apikey` query parameter
- **THEN** the system SHALL respond with HTTP 401

### Requirement: tRPC opportunity search procedure
The system SHALL expose a `searchees.opportunitySearch` tRPC procedure using the same shared Zod input schema and returning the same response shape as the REST endpoint.

#### Scenario: tRPC procedure returns ranked opportunities
- **WHEN** the WebUI calls `searchees.opportunitySearch` with `{title, year, imdbId, goldenTracker}`
- **THEN** the procedure SHALL return an object containing `results`, `goldenTracker`, and `meta` with the same structure as the REST response
- **THEN** the `meta.duration` SHALL reflect wall-clock time in milliseconds

#### Scenario: tRPC procedure with minimal input
- **WHEN** the WebUI calls `searchees.opportunitySearch` with only `{title, year}`
- **THEN** the procedure SHALL perform a query-based Torznab search (no external IDs) and return available results

### Requirement: Read-only constraint
The opportunity search endpoint SHALL NOT save any decision records, create searchee entries, or perform any injection/save actions.

#### Scenario: No side effects on database
- **WHEN** an opportunity search completes successfully
- **THEN** the `decision`, `searchee`, `timestamp`, and `rss` tables SHALL remain unchanged (no new rows, no modifications)

### Requirement: Distinct log labeling
The system SHALL log opportunity search activity under a log label distinct from regular RSS and search operations.

#### Scenario: Log label used consistently
- **WHEN** an opportunity search starts, queries indexers, and completes
- **THEN** each log message SHALL use label `OPPORTUNITY` (or similar) so that users can filter or quantify quota consumption separately from `SEARCH`, `RSS`, and `ANNOUNCE` labels
