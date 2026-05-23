import { describe, expect, it } from "vitest";
import { normalizeTrackerName } from "../src/torznab.js";

// ──────────────────────────────────────────────
// Tracker name normalization (golden-tracker-phase1-reservation prerequisite)
// ──────────────────────────────────────────────

describe("normalizeTrackerName", () => {
	it("strips lowercase (api) suffix", () => {
		expect(normalizeTrackerName("HD-Torrents (api)")).toBe("HD-Torrents");
	});

	it("strips mixed-case (Api) suffix", () => {
		expect(normalizeTrackerName("HD-Torrents (Api)")).toBe("HD-Torrents");
	});

	it("strips uppercase (API) suffix", () => {
		expect(normalizeTrackerName("HD-Torrents (API)")).toBe("HD-Torrents");
	});

	it("strips lowercase (rss) suffix", () => {
		expect(normalizeTrackerName("MyTracker (rss)")).toBe("MyTracker");
	});

	it("strips uppercase (RSS) suffix", () => {
		expect(normalizeTrackerName("MyTracker (RSS)")).toBe("MyTracker");
	});

	it("strips mixed-case (Rss) suffix", () => {
		expect(normalizeTrackerName("MyTracker (Rss)")).toBe("MyTracker");
	});

	it("preserves name with no suffix", () => {
		expect(normalizeTrackerName("HD-Torrents")).toBe("HD-Torrents");
	});

	it("trims whitespace", () => {
		expect(normalizeTrackerName("  HD-Torrents  ")).toBe("HD-Torrents");
	});

	it("handles empty string", () => {
		expect(normalizeTrackerName("")).toBe("");
	});

	it("handles UnknownTracker constant", () => {
		expect(normalizeTrackerName("UnknownTracker")).toBe("UnknownTracker");
	});
});
