# Empire Omitted V3 — Phase 1 Build Brief

**Status:** Approved for implementation
**Branch:** `empire-omitted-v3-phase1`
**Mode:** Shadow mode — no production-output change

## Objective
Prove that FraymIQ can create a professional, narration-synchronised Director's Edit Plan from a real Empire Omitted script and finished voiceover before media generation.

## Build only these four foundations

### 1. Reusable VO timing
Extract or refactor the existing Whisper word-timestamp logic from `pipeline-updates/surface-renderer.cjs` into a reusable module, expected name:
`pipeline-updates/vo-timing.cjs`.

Requirements:
- preserve current renderer behaviour;
- preserve existing checkpoint/retry behaviour;
- reuse existing `word-timestamps.json` when present;
- do not cause a second paid transcription for the same episode;
- make the timing module callable immediately after VO generation.

### 2. Edit-plan schema
Define a versioned schema for `edit-plan.json`.

Phase 1 must support at minimum:
- episode/channel/version;
- acts and sequences;
- visual beats;
- exact start/end/duration;
- narration excerpt;
- story function;
- director intent;
- visual class;
- visual intent;
- motion intent;
- intentional-stillness marker;
- evidence/source requirement flags;
- emotional/rhythm intent;
- continuity references where relevant.

Do not design renderer-specific track instructions here; those belong to future `timeline.json`.

### 3. Director's Edit Plan generator
Create `pipeline-updates/edit-plan-generator.cjs` for Empire Omitted only.

Inputs:
- `script.json`
- word-level VO timing
- Empire Omitted channel context / approved director rules

Output:
- `edit-plan.json`

The generator must plan from actual finished-VO timing, not estimated narration duration.

### 4. Edit-plan validator
Create `pipeline-updates/edit-plan-validator.cjs`.

Hard Phase 1 checks:
- 100% narration coverage;
- no unintended timeline gaps;
- no unintended overlaps;
- normal beat target roughly 3.5–5.5 seconds;
- normal hard maximum about 6 seconds unless explicitly marked/justified;
- every beat has a narration excerpt;
- every beat has a story function;
- every beat has visual intent;
- intentional stillness must be explicit;
- validation writes `edit-plan-validation.json`;
- failure is machine-readable.

## Shadow-mode integration
For Empire Omitted, Phase 1 may generate V3 planning artifacts after VO, but the existing V2 shot/image/animation/render chain must continue exactly as before.

Do not allow V3 artifacts to control production media yet.

## Explicitly out of scope
- changing Kling prompts or motion vocabulary;
- changing image generation;
- changing the renderer;
- removing final-frame freeze behaviour;
- evidence retrieval;
- music/SFX generation;
- DaVinci Resolve;
- frontend redesign;
- Macro Decode changes;
- automatic edit-plan repair loop;
- edit-plan-to-shots compatibility compiler.

Those are later phases.

## Tests required
Codex must add/adjust tests that demonstrate:
1. Existing renderer can still obtain/reuse word timestamps.
2. A previously completed timestamp file is reused without retranscription.
3. Validator rejects a narration gap.
4. Validator rejects an unintended overlap.
5. Validator rejects an overlong ordinary beat.
6. Validator accepts explicitly justified intentional stillness where allowed by schema.
7. Non-Empire-Omitted channels do not enter V3 shadow planning.
8. Existing V2 production sequence remains reachable and unchanged.

## Development benchmark
After unit/integration tests pass, use the completed Wells Fargo Empire Omitted episode as the first development benchmark if its script + VO artifacts are available.

The first human inspection is of the generated plan, not regenerated media.

## Phase 1 acceptance
Do not call Phase 1 complete until the plan can report:

```text
EMPIRE OMITTED EDIT PLAN QA

VO runtime:                 actual
Planned visual coverage:    100%
Total visual beats:         timing-driven
Average beat duration:      within target range
Longest normal beat:        <= 6 sec
Narration gaps:             0
Timeline overlaps:          0 unintended
Missing story functions:    0
Missing narration excerpts: 0
Unresolved visual intent:   0

STATUS: PASS
```

And the plan must qualitatively show sequence thinking, human consequence, evidence opportunities, controlled motion intent, and deliberate—not accidental—stillness.
