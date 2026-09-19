# AGENTS.md — Empire Omitted V3 Build Guardrails

## Source of truth
Before making any Empire Omitted V3 change, read:
- `docs/empire-omitted-v3/PROJECT_RECONSTRUCTION.md`
- `docs/empire-omitted-v3/PHASE_1_BUILD_BRIEF.md`

The reconstruction document contains approved product and editorial decisions. Do not re-decide them unless the user explicitly changes them.

## Current scope
The active implementation target is Empire Omitted V3 Phase 1 only.

Do not silently broaden scope.

## Mandatory engineering rules
1. Inspect the current repository state before editing.
2. Work only on the dedicated V3 branch until changes are reviewed.
3. Preserve production behaviour by default.
4. Keep V3 Empire Omitted-specific until proven.
5. Do not modify Macro Decode or other channel behaviour unless explicitly required.
6. Do not replace the renderer in Phase 1.
7. Do not change image generation, animation generation, freeze behaviour, music, DaVinci integration, or frontend workflow in Phase 1 unless the phase brief explicitly says so.
8. Build V3 in shadow mode first. Production video output must remain unchanged.
9. Reuse existing Whisper/timestamp work rather than creating duplicate paid transcription.
10. Add tests for every new deterministic module and for production-behaviour preservation.
11. Prefer small reversible changes over broad refactors.
12. If repository reality conflicts with the reconstruction document, stop and report the conflict before inventing a solution.

## Phase 1 success condition
A real Empire Omitted script plus completed VO must be able to produce:
- reusable word-level timing,
- `edit-plan.json`,
- `edit-plan-validation.json`,
before any new image or video generation begins.

The plan must validate 100% narration coverage and the approved beat-duration rules while production V2 remains intact.
