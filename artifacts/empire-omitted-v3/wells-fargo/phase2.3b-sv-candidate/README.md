# Phase 2.3B-SV: two-act factual correction candidate

This is a quarantined, pre-timing candidate. It is not an episode-root artifact and must not be promoted until the two approved voiceovers are generated, measured, retimed, and the resulting edit plan and production manifest pass validation.

## Lineage finding

The locked Phase 2.2D shot-definition file and its listed SHA-256 match the committed artifact. The raw Phase 2.2D ledger contains 120 field changes across 24 shots. Reversing those exact values reproduces the declared parent artifact hash; applying the values reproduces the locked result hash. All 24 edit-plan differences are `visual.description` changes with exact matching `originalFieldValue`, `revisedFieldValue`, and rationale in the Phase 2.2D ledger. The machine-readable per-difference table is `revision-mismatch-diagnostic.v1.json`; it classifies all 24 as `APPROVED_PHASE2_2D_REVISION` and none as unledgered drift.

The two-act factual correction is separately represented by `revision-ledger.phase2.3b-sv-amendment.v1.json`. The candidate validator requires both ledger layers, verifies the byte-level artifact hash chain and exact before/after values, and reports zero unapproved differences. The historical ledger also records the exact legacy `animationPrompt` and `reconstructionSafeguards` values on ACT3B_B010; these are accepted only with that complete verified lineage. The current candidate corrects those fields.

## Candidate contents

- `candidate-script.json`: corrected complete Act 3B and Act 4 narration.
- `candidate-edit-plan-pretiming.json`: candidate plan retaining existing timing until replacement audio is available.
- `candidate-shot-definitions-pretiming.json`: corrected shot-definition candidate, with its derived act index preserved as in the locked source artifact.
- `candidate-production-manifest-pretiming.json`: matching production-method candidate.
- `narration-texts.json`: exact old/new act text, character counts, and text hashes.
- `authoritative-timing-extract.json`: word-timing context for the captured Act 3B audio. It is source evidence only; it is not a substitute for new audio timing.
- `revision-mismatch-diagnostic.v1.json`: all 24 historical mismatches and their exact ledger records.
- `revision-ledger.*.json`: normalized historical chain and narrow current amendment.
- `source-hash-manifest.json`: captured source identities and hashes.
- `candidate-package-sha256.json`: integrity hashes for the files in this package.

## Audio and timing boundary

The approved correction needs two complete-act audio requests: Act 3B (961 narration characters) and Act 4 (1,496 narration characters), 2,457 characters total. Existing finished VO remains untouched until both replacement files pass media validation. The new Act 3B duration and all word timestamps must be measured from the generated file. Act 4 must likewise be retimed from its replacement audio. Only the affected acts' timing ranges and dependent shot timings may change; unaffected acts and shot creative fields must compare equal. Final edit-plan, shot-definition, and production-manifest candidates must validate before any replacement is promoted.

No provider call, Railway command, audio replacement, image or animation generation, render, or episode-root write has been performed as part of this preparation.

## Execution readiness

The canonical Git worktree does not contain the deployed voice-generation implementation (`surface-vo-generator.cjs` and the volume-only provider router are absent). The current source does not document a safe act-scoped invocation or expose the established voice/model/settings. A generic runner invocation could regenerate all six acts and exceed the approved two-request ceiling. Therefore this package intentionally contains no executable paid-generation command or rollback script, and must not be treated as ready for two-act execution until the existing Railway runtime interface and exact settings are independently available for review.
