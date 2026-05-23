## Why

The golden tracker preference is useless in "confirmed" (Phase 2) mode because Phase 1 selects top-N groups by score before golden tracker is ever consulted. If the golden tracker's candidates have lower scores (fewer unique trackers per group), they never reach Phase 2 — so `rankOpportunities` never sees them, and users get zero results even though the golden tracker has the release.

This is a design flaw: Phase 1 groups and scores candidates purely by (tracker count × 100 + resolution bonus), with zero golden tracker awareness. For the "lightweight" path the golden filter is applied before top-N selection, but the "confirmed" path has no equivalent safeguard.

## What Changes

1. **`runPhase2` gets a `goldenTracker` parameter**: The Phase 2 entry point accepts an optional golden tracker name.
2. **Slot reservation logic**: When a golden tracker is specified, `runPhase2` reserves one of the top-N slots for the highest-scoring Phase-1 group that contains the golden tracker. This ensures the golden tracker candidate gets a fetch attempt regardless of its absolute Phase 1 score.
3. **No duplicate fetching**: If the golden tracker group is already in the top-N by score, no duplicate slot is consumed — the reservation is a no-op.
4. **Graceful degradation**: If no Phase-1 group contains the golden tracker, the reservation is a no-op and Phase 2 proceeds normally with the top-N groups.
5. **`searchOpportunities` passes `goldenTracker` through**: The orchestrator forwards the `input.goldenTracker` value to `runPhase2` when building the args to Phase 2.

## Capabilities

### New Capabilities
- `golden-tracker-slot-reservation`: Guarantees at least one Phase 2 fetch slot for golden tracker candidates regardless of Phase 1 score.

### Modified Capabilities
<!-- No existing spec files to modify -- this is a new code capability within the opportunity system. -->

## Impact

- **`packages/cross-seed/src/opportunity.ts`**: `runPhase2` signature changes (new optional parameter), `searchOpportunities` updated to pass golden tracker to Phase 2.
- **`packages/cross-seed/tests/opportunity.test.ts`**: New tests for the golden slot reservation behavior.
- **No API/CLI changes**: The `goldenTracker` field was already accepted in the API schema; this only changes internal behavior.
