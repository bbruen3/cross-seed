import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	OPPORTUNITY_SEARCH_SCHEMA,
	createVirtualSearchee,
	buildParsedMedia,
	normalizeName,
	sizesAreWithinTolerance,
	groupPhase1,
	scorePhase1Groups,
	rankOpportunities,
	Phase2Result,
} from "../src/opportunity.js";
import { SearchPattern } from "../src/constants.js";

// ──────────────────────────────────────────────
// Schema validation (Task 1.3)
// ──────────────────────────────────────────────

const validInput = {
	title: "Inception",
	year: 2010,
	imdbId: "tt1375666",
	tmdbId: 27205,
	goldenTracker: "MyTracker",
};

describe("OPPORTUNITY_SEARCH_SCHEMA", () => {
	it("accepts valid input", () => {
		const result = OPPORTUNITY_SEARCH_SCHEMA.safeParse(validInput);
		expect(result.success).toBe(true);
	});

	it("accepts minimal input (title + year only)", () => {
		const result = OPPORTUNITY_SEARCH_SCHEMA.safeParse({
			title: "Inception",
			year: 2010,
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.phase).toBe("confirmed");
		}
	});

	it("rejects missing title", () => {
		const result = OPPORTUNITY_SEARCH_SCHEMA.safeParse({ year: 2010 });
		expect(result.success).toBe(false);
	});

	it("rejects year below 1888", () => {
		const result = OPPORTUNITY_SEARCH_SCHEMA.safeParse({
			title: "Test",
			year: 1887,
		});
		expect(result.success).toBe(false);
	});

	it("rejects year beyond current+2", () => {
		const result = OPPORTUNITY_SEARCH_SCHEMA.safeParse({
			title: "Test",
			year: new Date().getFullYear() + 3,
		});
		expect(result.success).toBe(false);
	});

	it("rejects non-integer year", () => {
		const result = OPPORTUNITY_SEARCH_SCHEMA.safeParse({
			title: "Test",
			year: "twenty-ten",
		});
		expect(result.success).toBe(false);
	});

	it("rejects invalid imdbId pattern", () => {
		const result = OPPORTUNITY_SEARCH_SCHEMA.safeParse({
			...validInput,
			imdbId: "invalid",
		});
		expect(result.success).toBe(false);
	});

	it("accepts valid imdbId pattern", () => {
		const result = OPPORTUNITY_SEARCH_SCHEMA.safeParse({
			...validInput,
			imdbId: "tt1375666",
		});
		expect(result.success).toBe(true);
	});

	it("rejects negative tmdbId", () => {
		const result = OPPORTUNITY_SEARCH_SCHEMA.safeParse({
			...validInput,
			tmdbId: -5,
		});
		expect(result.success).toBe(false);
	});

	it("accepts lightweight phase", () => {
		const result = OPPORTUNITY_SEARCH_SCHEMA.safeParse({
			title: "Inception",
			year: 2010,
			phase: "lightweight",
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.phase).toBe("lightweight");
		}
	});

	it("rejects unknown phase", () => {
		const result = OPPORTUNITY_SEARCH_SCHEMA.safeParse({
			title: "Inception",
			year: 2010,
			phase: "unknown",
		});
		expect(result.success).toBe(false);
	});

	it("rejects extra fields (strict mode)", () => {
		const result = OPPORTUNITY_SEARCH_SCHEMA.safeParse({
			title: "Inception",
			year: 2010,
			extraField: "should not be here",
		});
		expect(result.success).toBe(false);
	});
});

// ──────────────────────────────────────────────
// Virtual Searchee Factory (Tasks 2.1, 2.2, 2.3)
// ──────────────────────────────────────────────

describe("createVirtualSearchee", () => {
	it("creates a searchee with title+year as name", () => {
		const input = { title: "Inception", year: 2010, phase: "confirmed" as const };
		const searchee = createVirtualSearchee(input);
		expect(searchee.name).toBe("Inception 2010");
		expect(searchee.title).toBe("Inception 2010");
	});

	it("has a single placeholder file", () => {
		const input = { title: "Inception", year: 2010, phase: "confirmed" as const };
		const searchee = createVirtualSearchee(input);
		expect(searchee.files).toHaveLength(1);
		expect(searchee.files[0].name).toBe("placeholder.mkv");
		expect(searchee.files[0].length).toBe(1);
	});

	it("has length 1", () => {
		const input = { title: "Inception", year: 2010, phase: "confirmed" as const };
		const searchee = createVirtualSearchee(input);
		expect(searchee.length).toBe(1);
	});
});

describe("buildParsedMedia", () => {
	it("constructs ParsedMedia from external IDs", () => {
		const input = {
			title: "Inception",
			year: 2010,
			imdbId: "tt1375666",
			tmdbId: 27205,
			phase: "confirmed" as const,
		};
		const pm = buildParsedMedia(input);
		expect(pm).toBeDefined();
		expect(pm!.movie.imdbId).toBe("tt1375666");
		expect(pm!.movie.tmdbId).toBe("27205");
		expect(pm!.series).toBeUndefined();
	});

	it("returns undefined when no IDs provided", () => {
		const input = {
			title: "Inception",
			year: 2010,
			phase: "confirmed" as const,
		};
		const pm = buildParsedMedia(input);
		expect(pm).toBeUndefined();
	});

	it("handles partial IDs", () => {
		const input = {
			title: "Test",
			year: 2020,
			tvdbId: 12345,
			phase: "confirmed" as const,
		};
		const pm = buildParsedMedia(input);
		expect(pm).toBeDefined();
		expect(pm!.movie.tvdbId).toBe("12345");
		expect(pm!.movie.imdbId).toBeUndefined();
		expect(pm!.movie.tmdbId).toBeUndefined();
	});
});

// ──────────────────────────────────────────────
// Name normalization (Task 3.5)
// ──────────────────────────────────────────────

describe("normalizeName", () => {
	it("lowercases the name", () => {
		expect(normalizeName("Movie.Name.2024")).toBe("movie name 2024");
	});

	it("strips bracket prefix tags", () => {
		expect(normalizeName("[Tracker] Movie.Name.2024")).toBe("movie name 2024");
	});

	it("strips bracket suffix tags", () => {
		expect(normalizeName("Movie.Name.2024 [Tracker]")).toBe("movie name 2024");
	});

	it("collapses separators", () => {
		expect(normalizeName("Movie.Name.2024")).toBe("movie name 2024");
	});

	it("handles indexer prefix patterns", () => {
		expect(normalizeName("Tracker-Movie.Name.2024")).toBe("movie name 2024");
	});
});

// ──────────────────────────────────────────────
// Size tolerance (Task 3.5)
// ──────────────────────────────────────────────

describe("sizesAreWithinTolerance", () => {
	it("exact sizes are within tolerance", () => {
		expect(sizesAreWithinTolerance(1000, 1000, 0.02)).toBe(true);
	});

	it("sizes within 2% are within tolerance", () => {
		expect(sizesAreWithinTolerance(1000, 1015, 0.02)).toBe(true);
	});

	it("sizes beyond 2% are out of tolerance", () => {
		// Use sizes large enough that 10MB floor doesn't dominate
		// 1GB = 1073741824, 2% = ~21MB, so 1GB vs 1.1GB = 100MB diff > 21MB
		expect(sizesAreWithinTolerance(1073741824, 1180136243, 0.02)).toBe(false);
	});

	it("sizes within 2% are within tolerance", () => {
		// 1GB vs 1.01GB, diff is ~10MB < 21MB (2% of 1GB)
		expect(sizesAreWithinTolerance(1073741824, 1084227584, 0.02)).toBe(true);
	});

	it("small sizes use 10MB floor", () => {
		// 2% of 100MB = 2MB, floor is 10MB, so 90MB vs 100MB is within 10MB
		expect(sizesAreWithinTolerance(100 * 1024 * 1024, 90 * 1024 * 1024, 0.02)).toBe(true);
	});
});

// ──────────────────────────────────────────────
// Phase-1 Grouping (Task 3.5)
// ──────────────────────────────────────────────

function makeCandidate(
	name: string,
	tracker: string,
	size: number,
	indexerId = 1,
) {
	return {
		name,
		guid: `${tracker}-${name}`,
		link: `http://${tracker}/${name}`,
		tracker,
		size,
		indexerId,
	};
}

describe("groupPhase1", () => {
	it("groups candidates with same normalized name and similar size", () => {
		const candidates = [
			makeCandidate("Movie.2024.1080p.WEB-DL-GROUP", "TrackerA", 5000, 1),
			makeCandidate("Movie.2024.1080p.WEB-DL-GROUP", "TrackerB", 5010, 2),
		];
		const groups = groupPhase1(candidates);
		expect(groups).toHaveLength(1);
		expect(groups[0].trackers).toHaveLength(2);
	});

	it("separates groups with different sizes beyond tolerance", () => {
		// Use sizes with a 50MB diff (exceeds 10MB floor and 2%)
		const candidates = [
			makeCandidate("Movie.2024.1080p.WEB-DL-GROUP", "TrackerA", 500 * 1024 * 1024, 1),
			makeCandidate("Movie.2024.1080p.WEB-DL-GROUP", "TrackerB", 600 * 1024 * 1024, 2),
		];
		const groups = groupPhase1(candidates);
		expect(groups).toHaveLength(2);
	});
});

describe("scorePhase1Groups", () => {
	it("scores multiple-tracker groups higher", () => {
		const groups = [
			{
				normalizedName: "movie a",
				representativeSize: 1000,
				trackers: ["A", "B", "C"],
				candidates: [
					makeCandidate("Movie.A-GROUP", "A", 1000),
					makeCandidate("Movie.A-GROUP", "B", 1000),
					makeCandidate("Movie.A-GROUP", "C", 1000),
				],
				passesPreFilter: false,
				score: 0,
			},
			{
				normalizedName: "movie b",
				representativeSize: 2000,
				trackers: ["D"],
				candidates: [makeCandidate("Movie.B-GROUP", "D", 2000)],
				passesPreFilter: false,
				score: 0,
			},
		];
		const virtualSearchee = {
			name: "Test 2024",
			title: "Test 2024",
			files: [{ name: "p.mkv", path: "p.mkv", length: 1 }],
			length: 1,
		};
		const scored = scorePhase1Groups(groups, virtualSearchee);
		expect(scored[0].score).toBeGreaterThan(scored[1].score);
	});
});

// ──────────────────────────────────────────────
// Ranking Engine (Task 5.5)
// ──────────────────────────────────────────────

describe("rankOpportunities", () => {
	const makeResult = (
		infoHash: string,
		trackers: string[],
		size: number,
	): Phase2Result => ({
		infoHash,
		torrentName: "Movie 2024",
		trackers,
		size,
		matchDecision: "CONFIRMED_AVAILABLE",
		verification: "fetched" as const,
		pubDate: Date.now(),
		link: "http://tracker/test",
	});

	it("sorts by score descending", () => {
		const results = [
			makeResult("aaa", ["TrackerA", "TrackerB"], 1000),
			makeResult("bbb", ["TrackerC"], 2000),
		];
		const { items } = rankOpportunities(results);
		expect(items).toHaveLength(2);
		expect(items[0].infoHash).toBe("aaa");
		expect(items[1].infoHash).toBe("bbb");
	});

	it("golden tracker match boosts score", () => {
		const results = [
			makeResult("aaa", ["TrackerA"], 1000),
			makeResult("bbb", ["MyTracker"], 2000),
		];
		const { items, gold } = rankOpportunities(results, "MyTracker");
		const bbbItem = items.find((i) => i.infoHash === "bbb")!;
		const aaaItem = items.find((i) => i.infoHash === "aaa")!;
		expect(bbbItem.score).toBeGreaterThan(aaaItem.score);
		expect(bbbItem.availableOnGoldenTracker).toBe(true);
		expect(aaaItem.availableOnGoldenTracker).toBe(false);
		expect(gold).toBeDefined();
		expect(gold!.name).toBe("MyTracker");
		expect(gold!.availableOnGolden).toBe(1);
		expect(gold!.notAvailableOnGolden).toBe(1);
	});

	it("returns null golden tracker when not specified", () => {
		const results = [makeResult("aaa", ["TrackerA"], 1000)];
		const { gold } = rankOpportunities(results);
		expect(gold).toBeNull();
	});

	it("handles empty results", () => {
		const { items, gold } = rankOpportunities([], "MyTracker");
		expect(items).toHaveLength(0);
		expect(gold).toBeDefined();
		expect(gold!.totalResults).toBe(0);
		expect(gold!.availableOnGolden).toBe(0);
	});

	it("deduplicates trackers", () => {
		const results = [
			makeResult("aaa", ["TrackerA", "TrackerA", "TrackerB"], 1000),
		];
		const { items } = rankOpportunities(results);
		expect(items[0].trackers).toHaveLength(2);
		expect(items[0].trackerCount).toBe(2);
	});
});
