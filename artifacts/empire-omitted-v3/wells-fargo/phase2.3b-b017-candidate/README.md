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

The approved B017 wording changes Act 3 only. The proposed refresh is three ElevenLabs text-to-speech segment requests for VO_Act3.mp3 (1,516 billable characters total, split at the established 720-character segment limit), followed by one single-attempt Whisper word-transcription request for the replacement Act 3 file. Neither operation is authorized or executed by this package. Preserve the other five approved VO files and transcript slices. After separate authorization, validate the new Act 3 audio, rebuild its word timestamps and reviewed alignment, and rerun timing and lineage validation before any candidate is considered.

No provider call, Railway command, audio replacement, image or animation generation, render, or episode-root write has been performed as part of this preparation.

## Execution readiness

The canonical Git worktree does not contain the deployed voice-generation implementation (`surface-vo-generator.cjs` and the volume-only provider router are absent). The current source does not document a safe act-scoped invocation or expose the established voice/model/settings. A generic runner invocation could regenerate all six acts and exceed the approved two-request ceiling. Therefore this package intentionally contains no executable paid-generation command or rollback script, and must not be treated as ready for two-act execution until the existing Railway runtime interface and exact settings are independently available for review.


Phase 2.3B-P B017 factual correction candidate: candidate script, plan, shot definitions, production manifest and exact revision lineage are in this versioned package. Act 3 VO, timestamps, reviewed alignment and timing validation are invalidated pending a separate audio refresh. This package is for final evidence review only; do not use it for candidate build or promotion until the downstream approvals are renewed.
