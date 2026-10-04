# Phase 3 production-media readiness closure — v2

**Status:** `PROPOSED_UNSIGNED_PENDING_HUMAN_REVIEW`

**Source commit:** `0b7cf084386bc65a88021b3b11026036f9ddb3ca`

**Stage04:** `phase2-3b-p-act3-refresh-20260928-stage04`, recorded `PROMOTED`; this planning package does not alter it.

The current feature branch is at the source commit, but the local `empire-omitted-v3-phase2` branch is at `74d3812a33695da34b9eb5d42abf8b35c4883862`. Remote tips were not fetched, so the instruction that both branches point to the source commit is not confirmed. No branch update, commit or push was made.

## Readiness finding

The 153-shot census remains 34 `CONTROLLED_STILL`, 9 `GENERATED_STILL`, 23 `ESSENTIAL_ANIMATION`, 23 animation dependency stills, and 14 continuity decisions. `ACT3B_B010` remains retired. The local Stage04 candidate index verifies 150/150 and the v5, Pilot-02 proposal, animation-extension and B005 motion packages verify 49/49, 4/4, 5/5 and 1/1. The Pilot-02 finalization index is verified as an index, but only 1 of its 39 indexed payloads is locally available; its package is therefore not claimed fully reverified here.

## 34-row amendment

The exact proposal hash is `fa4fc0c43543c19d8be66303825e3ac713d6ce5d269623075daec46ad35c2df3`. Its 34 rows change only `assetType` from `generated_clip` to `controlled_image`; `productionMethod` remains `CONTROLLED_STILL`, and the amendment records the preserved beat, narration, timing, visual, ownership, evidence and revision-lineage fields. The detached approval instruction is hash-bound to source closure index `9066efc95bf13bc64e1467a8a48c712628a1c2f024761b68dd2b53be848a1b18` and amendment hash above. It authorizes isolated child-candidate application only. The amendment remains unapplied in this package.

There is also a technical contract mismatch: the shot-definition production contract and validator do not include `controlled_image`; the locked `CLIP` visual maps to `generated_clip`. The production-method manifest has no `controlled_image` mapping. A child candidate therefore cannot pass the committed validators merely by changing the 34 asset-type fields. No visual-class workaround or validator bypass is appropriate. Resolve the validator contract without changing approved editorial fields before constructing the child candidate.

## ACT5_B009

The proposed result is a zero-provider SVG graphic carrying only the ordered labels 2013–2023, but the amendment leaves canvas size, viewBox, layout, typography and the SVG sanitization/visual-validation contract unspecified. No asset or amendment was created. Use the exact approval statement in the docket only after attaching a complete deterministic construction specification.

## ACT5_B016

The only indexed ACT5_B015 match is `assets/graphics/ACT5_B015__g00.svg` (538 bytes, SHA-256 `0fc16cfd6f697362805fbafccf50952c9740aa3ef43c4f74c7903d9661a40c24`), authorized by candidate index `8ff011db727b1cf6ac47acff010f15d9559aa9dcfc763dc6830cbcba7916deac` and graphic manifest `3450c75ac8a1b50eb4426e394df48d450038e7a26f7dee2100e642585195e1d2`. It is a 1920×1080 SVG takeaway reading “REGULATORS PUNISHED THE BANK,” not a clean frame, so it is ineligible. The exact source path and hash for the requested clean frame remain unavailable; B016 stays blocked. Composition-only use would not transfer ownership, but both source provenance and derivative bindings would need recording.

## Continuity, cost and first batch

All 14 approved continuity decisions and prompts are carried byte-for-byte in `source-v1/continuity-reference-reconciliation.v1.json`. The five same-beat aliases remain rejected, cross-beat sharing remains prohibited, and 12 dedicated reference stills remain potential requests; B009 and B016 are separately blocked by their graphic amendment and missing clean-frame source. No production request keys are assigned to these reference outputs.

After the B009 amendment, planning estimates 101 outputs and 66 potential provider submissions: 8 generated final stills, 23 animation dependency stills, 12 references and 23 clips. Historical estimate is $4.3249–$11.49 and is not current pricing. A separate dated official-route scenario uses 43 images at fal FLUX 3’s published price and 23 five-second Framepack clips at its published per-second price: $4.8615 at the listed promotional image price through 2026-10-08, or $5.8935 afterward. These are not production quotes or approved route selections; no aggregate spending cap is provider-enforced. No retry or failover is authorized.

Conditional first batch: ACT1_B005 controlled still, ACT1_B006 generated still, then ACT1_B009 dependency still plus clip. This tests the requested production mix with three beats, but every item remains blocked pending its specific contract and detached request authorization. ACT3_B005 is excluded until a production base still and route/rights/price/output contract are specified; its approved motion policy remains intact.

## Decisions and execution

The B005 motion approval remains unchanged. V5 continuity decisions and pilot route validation retain only their stated planning/pilot scope. Decisions still needed are the production application and validator-contract resolution for the 34-row change; a complete B009 deterministic SVG specification and amendment approval; an exact authorized B016 clean frame or approved dependency change; provider route, current price, rights/ownership, output acceptance and cost exposure for each generated asset; production-specific fit acceptance; batch selection and detached per-request authorizations. No production request is authorized, no job is executable, and no provider call, media generation, candidate reconstruction, Stage04 change, promotion or render occurred.
