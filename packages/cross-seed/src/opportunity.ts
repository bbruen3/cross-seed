import ms from "ms";
import { z } from "zod";
import { ExternalIds, ParsedMedia } from "./arr.js";
import { MediaType } from "./constants.js";
import { getEnabledIndexers } from "./indexers.js";
import { Label, logger } from "./logger.js";
import { CandidateWithIndexerId } from "./pipeline.js";
import { getRuntimeConfig } from "./runtimeConfig.js";
import { Searchee } from "./searchee.js";
import { getInfoHashesToExclude, snatch } from "./torrent.js";
import {
	makeRequests,
	createTorznabSearchQueries,
	Query,
} from "./torznab.js";
import { ALL_SPACES_REGEX } from "./constants.js";
import { cleanTitle, isTruthy } from "./utils.js";

// ──────────────────────────────────────────────
// Schema
// ──────────────────────────────────────────────

const currentYear = new Date().getFullYear();

export const OPPORTUNITY_SEARCH_SCHEMA = z
	.object({
		title: z.string().min(1, "Title is required"),
		year: z
			.number()
			.int("Year must be an integer")
			.gte(1888, "Year must be >= 1888")
			.lte(currentYear + 2, "Year must not be far in the future"),
		imdbId: z
			.string()
			.regex(/^tt\d+$/, "IMDb ID must match pattern tt{id}")
			.optional(),
		tmdbId: z
			.number()
			.int()
			.positive()
			.optional(),
		tvdbId: z
			.number()
			.int()
			.positive()
			.optional(),
		tvMazeId: z
			.number()
			.int()
			.positive()
			.optional(),
		goldenTracker: z.string().min(1).optional(),
		phase: z
			.enum(["lightweight", "confirmed"])
			.optional()
			.default("confirmed"),
	})
	.strict();

export type OpportunitySearchInput = z.infer<typeof OPPORTUNITY_SEARCH_SCHEMA>;

// ──────────────────────────────────────────────
// Response types
// ──────────────────────────────────────────────

export interface OpportunityItem {
	infoHash: string | null;
	torrentName: string;
	trackers: string[];
	trackerCount: number;
	size: number;
	matchDecision: string;
	verification: "fetched" | "heuristic";
	score: number;
	pubDate: number;
	availableOnGoldenTracker: boolean;
	link: string;
}

export interface GoldenTrackerCoverage {
	name: string | null;
	totalResults: number;
	availableOnGolden: number;
	notAvailableOnGolden: number;
}

export interface OpportunityMeta {
	indexersQueried: number;
	indexersRateLimited: number;
	candidatesEvaluated: number;
	candidatesFetched: number;
	trackerFetchFailures: number;
	phase: "lightweight" | "confirmed";
	duration: number;
}

export interface OpportunitySearchResponse {
	results: OpportunityItem[];
	goldenTracker: GoldenTrackerCoverage | null;
	meta: OpportunityMeta;
}

// ──────────────────────────────────────────────
// Virtual Searchee Factory
// ──────────────────────────────────────────────

/**
 * Construct a virtual Searchee from user-supplied metadata.
 * The searchee has no real files — just a placeholder — so
 * file-tree comparison routines will not produce meaningful results.
 * This is used only for Torznab search queries and metadata matching.
 */
export function createVirtualSearchee(
	input: OpportunitySearchInput,
): Searchee {
	const name = `${input.title} ${input.year}`;
	const placeholderFile = {
		name: "placeholder.mkv",
		path: "placeholder.mkv",
		length: 1,
	};
	const searchee: Searchee = {
		name,
		title: name,
		files: [placeholderFile],
		length: 1,
	};
	return searchee;
}

/**
 * Build a ParsedMedia object from user-supplied external IDs.
 * Returns undefined when no IDs are supplied (query-based fallback).
 *
 * Confirmed safe to construct without ARR — ExternalIds has only
 * optional fields and no ARR-internal required fields.
 */
export function buildParsedMedia(
	input: OpportunitySearchInput,
): ParsedMedia | undefined {
	const ids: ExternalIds = {
		imdbId: input.imdbId,
		tmdbId: input.tmdbId?.toString(),
		tvdbId: input.tvdbId?.toString(),
		tvMazeId: input.tvMazeId?.toString(),
	};
	const hasAnyId = [ids.imdbId, ids.tmdbId, ids.tvdbId, ids.tvMazeId].some(
		Boolean,
	);
	if (!hasAnyId) return undefined;
	return {
		movie: ids,
		series: undefined,
		episodes: undefined,
	};
}

// ──────────────────────────────────────────────
// Name normalization for Phase-1 grouping
// ──────────────────────────────────────────────

/**
 * Normalize a release name for grouping purposes.
 * Strips bracket prefix/suffix tags, collapses separators,
 * lowercases, and trims whitespace.
 */
export function normalizeName(raw: string): string {
	let name = raw
		// Strip bracketed tags like [TrackerName] at start or end
		.replace(/^\[.*?\]\s*/, "")
		.replace(/\s*\[.*?\]$/, "")
		// Strip indexer prefix patterns
		.replace(/^[A-Za-z0-9]+\s*[-|]\s*/, "")
		.trim();
	// Reuse existing cleanse/clean utilities
	name = cleanTitle(name);
	return name.toLowerCase().replace(ALL_SPACES_REGEX, " ").trim();
}

/**
 * Size tolerance: two sizes are considered equal if they differ by
 * less than max(fuzzySizeThreshold * size, 10MB).
 *
 * The percentage provides an upper bound (e.g. ±2% on a 50GB remux = ±1GB).
 * The 10MB floor prevents tiny files from always matching just because 2% of
 * 100MB is only 2MB — the minimum window is always 10MB regardless of size.
 * The percentage is the ceiling: on large files the window is percentage-driven
 * (bounded), on small files the floor dominates.
 *
 * Default tolerance is 2% (0.02) when runtime config is not available.
 */
export function sizesAreWithinTolerance(
	a: number,
	b: number,
	tolerance?: number,
): boolean {
	const threshold =
		tolerance ??
		getRuntimeConfig().fuzzySizeThreshold ??
		0.02;
	const absDiff = Math.abs(a - b);
	const minFloor = 10 * 1024 * 1024; // 10 MB
	return absDiff <= Math.max(threshold * Math.max(a, b), minFloor);
}

// ──────────────────────────────────────────────
// Phase-1 grouping
// ──────────────────────────────────────────────

export interface Phase1Group {
	normalizedName: string;
	representativeSize: number;
	trackers: string[];
	candidates: CandidateWithIndexerId[];
	passesPreFilter: boolean;
	score: number;
}

/**
 * Group candidates by (normalized name, size-with-tolerance).
 */
export function groupPhase1(
	candidates: CandidateWithIndexerId[],
): Phase1Group[] {
	const groups: Phase1Group[] = [];

	for (const candidate of candidates) {
		const norm = normalizeName(candidate.name);
		const size = candidate.size ?? 0;

		// Try to find an existing group with matching normalized name and size
		let found = false;
		for (const group of groups) {
			if (
				group.normalizedName === norm &&
				sizesAreWithinTolerance(group.representativeSize, size)
			) {
				group.trackers.push(candidate.tracker);
				group.candidates.push(candidate);
				found = true;
				break;
			}
		}
		if (!found) {
			groups.push({
				normalizedName: norm,
				representativeSize: size,
				trackers: [candidate.tracker],
				candidates: [candidate],
				passesPreFilter: false,
				score: 0,
			});
		}
	}

	return groups;
}

/**
 * Phase-1 pre-filter and scoring.
 * Runs size alignment and metadata checks.
 */
export function scorePhase1Groups(
	groups: Phase1Group[],
	virtualSearchee: Searchee,
	targetSize?: number,
): Phase1Group[] {
	for (const group of groups) {
		// Size alignment check
		const sizeOk =
			targetSize === undefined ||
			sizesAreWithinTolerance(group.representativeSize, targetSize);

		// Metadata compatibility: we run the static checks from assessCandidate
		// (release group / resolution / source match) against the virtual searchee
		const metaOk = metadataPasses(group, virtualSearchee);

		group.passesPreFilter = sizeOk && metaOk;

		// Score: primary weight on unique tracker count + resolution bonus
		const uniqueTrackers = new Set(group.trackers).size;
		const resolutionBonus = getResolutionBonus(
			group.candidates[0]?.name ?? "",
		);
		group.score = uniqueTrackers * 100 + resolutionBonus;
	}

	return groups;
}

/**
 * Run the static (non-file-tree) checks from assessCandidate
 * against each candidate in the group.
 */
function metadataPasses(
	group: Phase1Group,
	searchee: Searchee,
): boolean {
	const { releaseGroupDoesMatch, resolutionDoesMatch, sourceDoesMatch } =
		importStaticChecks();

	for (const candidate of group.candidates) {
		if (!releaseGroupDoesMatch(searchee.title, candidate.name)) return false;
		if (!resolutionDoesMatch(searchee.title, candidate.name)) return false;
		if (!sourceDoesMatch(searchee.title, candidate.name)) return false;
	}
	return true;
}

/**
 * Inline static check functions (mirrors decide.ts logic)
 * to avoid circular dependency risk.
 */
function importStaticChecks() {
	function releaseGroupDoesMatch(
		searcheeTitle: string,
		candidateName: string,
	): boolean {
		const searcheeGroup = getReleaseGroup(searcheeTitle)?.toLowerCase();
		const candidateGroup = getReleaseGroup(candidateName)?.toLowerCase();
		if (!searcheeGroup || !candidateGroup) return true;
		if (
			searcheeGroup.startsWith(candidateGroup) ||
			candidateGroup.startsWith(searcheeGroup)
		) {
			return true;
		}
		return false;
	}

	function resolutionDoesMatch(
		searcheeTitle: string,
		candidateName: string,
	): boolean {
		const searcheeRes = searcheeTitle
			.match(RES_STRICT_REGEX)
			?.groups?.res?.trim()
			?.toLowerCase();
		const candidateRes = candidateName
			.match(RES_STRICT_REGEX)
			?.groups?.res?.trim()
			?.toLowerCase();
		if (!searcheeRes || !candidateRes) return true;
		return extractInt(searcheeRes) === extractInt(candidateRes);
	}

	function sourceDoesMatch(
		searcheeTitle: string,
		candidateName: string,
	): boolean {
		const searcheeSource = parseSource(searcheeTitle);
		const candidateSource = parseSource(candidateName);
		if (!searcheeSource || !candidateSource) return true;
		return searcheeSource === candidateSource;
	}

	return { releaseGroupDoesMatch, resolutionDoesMatch, sourceDoesMatch };
}

// ──────────────────────────────────────────────
// Phase-2
// ──────────────────────────────────────────────

export interface Phase2Result {
	infoHash: string;
	torrentName: string;
	trackers: string[];
	size: number;
	matchDecision: string;
	verification: "fetched";
	pubDate: number;
	link: string;
}

export interface Phase2Outcome {
	confirmed: Phase2Result[];
	trackerFetchFailures: number;
	groupsFetched: number;
}

const DEFAULT_TOP_N = 5;

/**
 * Select top-N Phase-1 groups, fetch .torrent files, confirm infoHashes.
 */
export async function runPhase2(
	groups: Phase1Group[],
	infoHashesToExclude: Set<string>,
	blockList: string[],
	topN?: number,
): Promise<Phase2Outcome> {
	const n = topN ?? DEFAULT_TOP_N;
	const eligible = groups
		.filter((g) => g.passesPreFilter)
		.sort((a, b) => b.score - a.score)
		.slice(0, n);

	const confirmed: Phase2Result[] = [];
	let trackerFetchFailures = 0;

	for (const group of eligible) {
		// Fetch .torrent for each candidate in the group
		// TODO: early-exit after first successful snatch() in a Phase-1 group.
		// All candidates in a Phase-1 group share the same (normalizedName, size),
		// so fetching one .torrent is usually sufficient to get the infoHash.
		// The current implementation fetches all trackers to collect the full
		// tracker list, but we could optimise: fetch one, get infoHash, then
		// only fetch remaining trackers if they resolve to a different infoHash.
		const fetchedResults: { candidate: CandidateWithIndexerId; metafile: Metafile }[] = [];
		for (const candidate of group.candidates) {
			const res = await snatch(candidate, Label.OPPORTUNITY, {
				retries: 1,
				delayMs: ms("30 seconds"),
			});
			if (res.isErr()) {
				trackerFetchFailures++;
				continue;
			}
			fetchedResults.push({ candidate, metafile: res.unwrap() });
		}

		if (fetchedResults.length === 0) continue; // whole group dropped

		// Produce ONE confirmed result per Phase1Group.
		// We do NOT re-group by infoHash here because the user wants to see
		// how many trackers have the *release*, not how many unique infoHashes
		// exist for it.  If infoHashes genuinely differ that is a separate concern
		// (e.g. different encodes disguised as the same release).
		//
		// 1. InfoHash collision: filter out any results whose infoHash is already
		//    in the client.  If ALL collide, skip the group entirely.
		const nonExcluded = fetchedResults.filter(
			(fr) => !infoHashesToExclude.has(fr.metafile.infoHash),
		);
		if (nonExcluded.length === 0) continue;

		// 2. Blocklist check against any surviving torrent name.
		const anyBlocked = nonExcluded.some((fr) =>
			blockList.some((entry) =>
				fr.metafile.name.toLowerCase().includes(entry.toLowerCase()),
			),
		);
		if (anyBlocked) continue;

		// 3. Size consistency: Torznab-reported size vs. fetched metafile length.
		const metafileLength = nonExcluded[0].metafile.length;
		const torznabSize = nonExcluded[0].candidate.size ?? 0;
		if (
			torznabSize > 0 &&
			!sizesAreWithinTolerance(metafileLength, torznabSize)
		) {
			continue;
		}

		// 4. Collect unique trackers from ALL surviving fetched results.
		const trackers = [
			...new Set(
				nonExcluded
					.map((fr) => fr.candidate.tracker)
					.filter(isTruthy),
			),
		];

		confirmed.push({
			infoHash: nonExcluded[0].metafile.infoHash,
			torrentName: nonExcluded[0].metafile.name,
			trackers,
			size: metafileLength,
			matchDecision: "CONFIRMED_AVAILABLE",
			verification: "fetched",
			pubDate: nonExcluded[0].candidate.pubDate ?? 0,
			link: nonExcluded[0].candidate.link,
		});
	}

	return { confirmed, trackerFetchFailures, groupsFetched: eligible.length };
}

// ──────────────────────────────────────────────
// Ranking Engine
// ──────────────────────────────────────────────

/**
 * Rank confirmed results by cross-seed opportunity.
 *
 * Golden tracker matching strategy: case-insensitive **exact** comparison
 * (not substring). The golden tracker string must match the Prowlarr/Jackett
 * tracker name exactly (ignoring case). Substring matching would produce
 * false positives (e.g. "HD" matching "HD-Torrents", "BeyondHD", "HD-Another").
 * If you want to match a family of trackers, configure multiple golden trackers
 * in a future iteration — for now, exact match is the predictable contract.
 */
export function rankOpportunities(
	results: Phase2Result[],
	goldenTracker?: string,
): { items: OpportunityItem[]; gold: GoldenTrackerCoverage | null } {
	const items: OpportunityItem[] = results.map((r) => {
		const uniqueTrackers = [...new Set(r.trackers)];
		const availableOnGolden =
			goldenTracker !== undefined &&
			uniqueTrackers.some(
				(t) => t.toLowerCase() === goldenTracker!.toLowerCase(),
			);

		const trackerCount = uniqueTrackers.length;
		const resolutionBonus = getResolutionBonus(r.torrentName);
		const score =
			trackerCount * 100 +
			resolutionBonus +
			(availableOnGolden ? 50 : 0);

		return {
			infoHash: r.infoHash,
			torrentName: r.torrentName,
			trackers: uniqueTrackers,
			trackerCount,
			size: r.size,
			matchDecision: r.matchDecision,
			verification: r.verification,
			score,
			pubDate: r.pubDate,
			availableOnGoldenTracker: availableOnGolden,
			link: r.link,
		};
	});

	items.sort((a, b) => b.score - a.score);

	// When goldenTracker is specified, only return results available on that
	// tracker — non-golden results are irrelevant because the user can only
	// cross-seed from the golden tracker.
	const displayed =
		goldenTracker !== undefined
			? items.filter((i) => i.availableOnGoldenTracker)
			: items;

	const gold: GoldenTrackerCoverage | null =
		goldenTracker !== undefined
			? {
					name: goldenTracker,
					totalResults: displayed.length,
					availableOnGolden: displayed.filter(
						(i) => i.availableOnGoldenTracker,
					).length,
					notAvailableOnGolden: displayed.filter(
						(i) => !i.availableOnGoldenTracker,
					).length,
				}
			: null;

	return { items: displayed, gold };
}

// ──────────────────────────────────────────────
// Main orchestrator
// ──────────────────────────────────────────────

/**
 * Full opportunity search: Phase 1 -> (optionally) Phase 2 -> rank.
 */
export async function searchOpportunities(
	input: OpportunitySearchInput,
): Promise<OpportunitySearchResponse> {
	const start = Date.now();
	const phase = input.phase ?? "confirmed";

	const virtualSearchee = createVirtualSearchee(input);
	const parsedMedia = buildParsedMedia(input);
	const infoHashesToExclude = await getInfoHashesToExclude();
	const { blockList } = getRuntimeConfig();

	// Search all eligible indexers
	const enabledIndexers = await getEnabledIndexers();
	const movieIndexers = enabledIndexers.filter(
		(i) => i.movieSearchCap || i.categories.movie,
	);

	let allCandidates: CandidateWithIndexerId[] = [];
	let indexersQueried = 0;
	let indexersRateLimited = 0;

	if (movieIndexers.length > 0) {
			const indexerCandidates = await makeRequests(
			movieIndexers,
			Label.OPPORTUNITY,
			async (indexer): Promise<Query[]> => {
				const caps = {
					search: indexer.searchCap,
					tvSearch: indexer.tvSearchCap,
					movieSearch: indexer.movieSearchCap,
					musicSearch: indexer.musicSearchCap,
					audioSearch: indexer.audioSearchCap,
					bookSearch: indexer.bookSearchCap,
					tvIdSearch: indexer.tvIdCaps,
					movieIdSearch: indexer.movieIdCaps,
					categories: indexer.categories,
					limits: indexer.limits,
				};
				return createTorznabSearchQueries(
					virtualSearchee,
					MediaType.MOVIE,
					caps,
					parsedMedia,
				);
			},
		);

		for (const ic of indexerCandidates) {
			allCandidates.push(...ic.candidates);
			indexersQueried++;
		}
		// The rate-limited count is more nuanced, but we approximate it
		indexersRateLimited = movieIndexers.length - indexerCandidates.length;
	}

	logger.info({
		label: Label.OPPORTUNITY,
		message: `Opportunity search for "${input.title} (${input.year})": ${allCandidates.length} raw candidates from ${indexersQueried} indexers`,
	});

	// Phase 1: group and score
	const groups = groupPhase1(allCandidates);
	const scoredGroups = scorePhase1Groups(groups, virtualSearchee);
	const candidatesEvaluated = scoredGroups.length;

	// Phase 2: fetch and confirm (if requested)
	let finalItems: OpportunityItem[];
	let trackerFetchFailures = 0;
	let candidatesFetched = 0;

	if (phase === "confirmed") {
		const outcome = await runPhase2(
			scoredGroups.filter((g) => g.passesPreFilter),
			infoHashesToExclude,
			blockList,
		);
		trackerFetchFailures = outcome.trackerFetchFailures;
		candidatesFetched = outcome.groupsFetched;
		const { items, gold: _gold } = rankOpportunities(
			outcome.confirmed,
			input.goldenTracker,
		);
		finalItems = items;
	} else {
		// Lightweight: use Phase-1 groups directly with heuristic decisions
		const passing = scoredGroups
			.filter((g) => g.passesPreFilter)
			.filter((g) => {
				// When goldenTracker is specified, restrict to groups that
				// include that tracker
				if (input.goldenTracker === undefined) return true;
				return g.trackers.some(
					(t) =>
						t.toLowerCase() === input.goldenTracker!.toLowerCase(),
				);
			})
			.sort((a, b) => b.score - a.score);
		candidatesFetched = Math.min(passing.length, DEFAULT_TOP_N);
		finalItems = passing
			.slice(0, DEFAULT_TOP_N)
			.map((g) => ({
				infoHash: null,
				torrentName: g.candidates[0]?.name ?? "",
				trackers: [...new Set(g.trackers)],
				trackerCount: new Set(g.trackers).size,
				size: g.representativeSize,
				matchDecision: "HEURISTIC_AVAILABLE",
				verification: "heuristic" as const,
				score: g.score,
				pubDate: g.candidates[0]?.pubDate ?? 0,
				availableOnGoldenTracker:
					input.goldenTracker !== undefined &&
					g.trackers.some(
						(t) =>
							t.toLowerCase() === input.goldenTracker!.toLowerCase(),
					),
				link: g.candidates[0]?.link ?? "",
			}));
	}

	// Compute golden tracker coverage
	const goldenTrackerCoverage: GoldenTrackerCoverage | null =
		input.goldenTracker !== undefined
			? {
					name: input.goldenTracker,
					totalResults: finalItems.length,
					availableOnGolden: finalItems.filter(
						(i) => i.availableOnGoldenTracker,
					).length,
					notAvailableOnGolden: finalItems.filter(
						(i) => !i.availableOnGoldenTracker,
					).length,
				}
			: null;

	const duration = Date.now() - start;

	return {
		results: finalItems,
		goldenTracker: goldenTrackerCoverage,
		meta: {
			indexersQueried,
			indexersRateLimited,
			candidatesEvaluated,
			candidatesFetched,
			trackerFetchFailures,
			phase,
			duration,
		},
	};
}

// ──────────────────────────────────────────────
// Local helpers (inlined to avoid circular imports)
// ──────────────────────────────────────────────

const RES_STRICT_REGEX = /(?<res>(?:2160|1080|720)[pi])/;
const RELEASE_GROUP_REGEX =
	/(?<=-)(?:\W|\b)(?!(?:\d{3,4}[ip]))(?!\d+\b)(?:\W|\b)(?<group>[\w .]+?)(?:\[.+\])?(?:\))?(?:\s\[.+\])?$/i;
const ANIME_GROUP_REGEX = /^\s*\[(?<group>.+?)\]/i;
const SOURCE_REGEXES: Record<string, RegExp> = {
	AMZN: /\b(amzn|amazon(hd)?)\b[ ._-]web[ ._-]?(dl|rip)?\b/i,
	DSNP: /\b(dsnp|dsny|disney)\b/i,
	NF: /\b(nf|netflix(u?hd)?)\b/i,
	HULU: /\b(hulu)\b/i,
	ATVP: /\b(atvp|aptv)\b/i,
	HBO: /\b(hbo)(?![ ._-]max)\b|\b(hmax|hbom|hbo[ ._-]max)\b/i,
	PCOK: /\b(pcok)\b/i,
	PMTP: /\b(pmtp|Paramount Plus)\b/i,
};

/**
 * Resolution bonus for scoring: 2160p=40, 1080p=20, 720p=10, else 0.
 */
function getResolutionBonus(torrentName: string): number {
	const res = torrentName
		.match(RES_STRICT_REGEX)
		?.groups?.res?.trim()
		?.toLowerCase();
	if (res?.includes("2160")) return 40;
	if (res?.includes("1080")) return 20;
	if (res?.includes("720")) return 10;
	return 0;
}

function extractInt(str: string): number {
	return parseInt(str.replace(/\D/g, ""), 10) || 0;
}

function parseSource(title: string): string | null {
	for (const [source, regex] of Object.entries(SOURCE_REGEXES)) {
		if (regex.test(title)) return source;
	}
	return null;
}

function getReleaseGroup(stem: string): string | null {
	const predictedGroupMatch = stem.match(RELEASE_GROUP_REGEX);
	if (!predictedGroupMatch) return null;
	return predictedGroupMatch.groups!.group.trim();
}

// ──────────────────────────────────────────────
// Lazy import for Metafile type (used by runPhase2)
// ──────────────────────────────────────────────

import type { Metafile } from "./parseTorrent.js";
