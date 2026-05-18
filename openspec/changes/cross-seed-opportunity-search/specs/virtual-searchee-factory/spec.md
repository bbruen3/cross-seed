## ADDED Requirements

### Requirement: Virtual Searchee from user metadata
The system SHALL construct a lightweight virtual Searchee from user-supplied title, year, and optional external IDs, suitable for Torznab search queries.

#### Scenario: Movie virtual searchee creation
- **WHEN** the factory receives `{title: "Inception", year: 2010}`
- **THEN** it SHALL return a Searchee-like object with `name` set to `"Inception 2010"`, `title` derived for search compatibility, a minimal file list with a single generic video file, a token `length` of `1`, and `getMediaType` classifying it as `MOVIE`

#### Scenario: External IDs passed through for ID-based search
- **WHEN** the factory receives `{title: "Inception", year: 2010, imdbId: "tt1375666", tmdbId: "27205"}`
- **THEN** the returned metadata SHALL include a `ParsedMedia`-compatible object with `movie.imdbId` and `movie.tmdbId` set, enabling ID-based Torznab `t=movie` queries

#### Scenario: ParsedMedia constructable without ARR
- **WHEN** the factory builds `ParsedMedia` from user-supplied external IDs
- **THEN** the object SHALL be `{movie: {imdbId?: string, tmdbId?: string, tvdbId?: string, tvMazeId?: string}, series: undefined, episodes: undefined}`
- **THEN** no ARR API SHALL be called — the `ExternalIds` type has no required fields and no ARR-internal fields (confirmed by inspecting `getRelevantArrIds` which reads only the optional ID fields)
- **WHEN** the user provides zero external IDs
- **THEN** `buildParsedMedia` SHALL return `undefined` or equivalent, causing the search to fall back to query-based (`q=title+year`) Torznab search

#### Scenario: Year appended to title for MOVIE_REGEX matching
- **WHEN** the factory receives `{title: "Inception", year: 2010}`
- **THEN** the Searchee title SHALL be formatted as `Inception 2010` so that `MOVIE_REGEX` correctly classifies it as a movie

#### Scenario: No ambiguous media type
- **WHEN** the factory receives a title that could match EP_REGEX (e.g. contains "S01")
- **THEN** the factory SHALL force the media type to `MOVIE` using the supplied year, so the search uses `t=movie` Torznab queries rather than `t=tvsearch`
