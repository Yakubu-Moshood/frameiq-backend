# Pilot-02 animation extension review

**Package:** `phase3-media-pilot-animation-extension-20261003-v1`  
**Status:** `PROPOSED_UNSIGNED_PENDING_HUMAN_REVIEW`  
**Pilot:** `phase3-media-pilot-02`  
**Beat:** `ACT3_B005`

This is a new planning package only. The existing Pilot-02 package and run artifacts remain untouched. No animation authorization exists in this proposal and no provider request was made.

## Source still and beat timing

Use exactly one image input: the approved ACT3_B005 still, PNG, 1360 × 768, 1,310,934 bytes, SHA-256 `34dbcf51e05f01eee0f4801202044b026a9b96c1ce07ee8efc15b45cbee57ac6`. Approval SHA-256: `67e77312141d81e18c663275a285b0dfe377233e4d60cafb79d57457fc526ab4`. Still authorization SHA-256: `7d2623a1ba47fd37796afc32e08f94638a70e7a60089dbb4e9f016f13dd80eee`.

The hash-verified local v2 candidate index is `8ff011db727b1cf6ac47acff010f15d9559aa9dcfc763dc6830cbcba7916deac` (150/150 indexed files verified). Its `edit-plan.json` SHA-256 is `9c2efb64c6cacfde55c4fb5492fdc9b5cff448bb907aa8aad629b3cd3f2ad02d`. ACT3_B005 spans **224.83598745776368–228.4959873051758 seconds**, so its exact plan duration is **3.6599998474121094 seconds**.

The shared renderer uses per-shot `Math.round(duration × fps)`. At 30 fps: `Math.round(3.6599998474121094 × 30) = 110` frames. 110/30 is 3.6666666667 seconds, **0.0066668196 seconds longer** than the exact narration interval due to the renderer’s frame-grid rounding.

## Provider route, request and pricing

Proposed official route: fal.ai **`fal-ai/framepack`**, image-to-video. Request key: **`d49253e9ff98d254350a13929d56488a05b7a3b2a28a76b8c8b75d0b9ab318b1`**, derived from the ordered request material, including the still hash, prompt, negative prompt and parameters in the JSON proposal.

The proposed input is 150 frames (`num_frames`), 16:9, 480p, `cfg_scale: 1`, `guidance_scale: 10`, fixed seed `20261003`, safety checker enabled. 150 frames target five seconds **only if** the returned video is 30 fps. The official schema does not take requested duration or FPS, so this target is not guaranteed. The local package proposes embedding the approved PNG as a data URI in `image_url`, keeping it the sole image input and avoiding a separate file-upload submission.

The official model page currently publishes **$0.0333 per generated second**. At the five-second target, the estimate is **$0.1665**. Proposed human-accepted exposure is **$0.25 for the animation**, not a provider-enforced cap. With the prior still estimate of $0.024, the expected combined estimate is $0.1905; the proposed combined pilot exposure is $0.30 including the previous still’s accepted $0.05 exposure. Actual still charge must be read from its existing ledger result.

The model page’s commercial-use label is not an ownership assignment. Ownership remains unresolved; separate human acceptance of that risk for this animation is required before any execution authorization.

## Motion direction

**Prompt**

> The customer’s hand smoothly slides the unchanged generic identification card across the desk toward the banker. The banker keeps both hands natural and begins typing while the card remains clearly visible. Movement is restrained and realistic. Camera remains locked. Preserve the original office, desk, clothing, keyboard, monitor, card design and framing.

**Negative prompt**

> Camera movement, zoom, reframing, face reveal, readable text, numbers, personal information, portrait photograph, logo, branding, card redesign, disappearing card, duplicated objects, malformed hands, extra fingers, fused fingers, warped keyboard, exaggerated movement, sudden motion, flicker, morphing.

## Fit to the beat

The source target is five seconds (150 requested model frames, with actual duration/FPS to be measured). After inspection, a valid source is to be normalized locally to constant 30 fps, then trimmed deterministically to **110 frames**. If fewer than 110 valid frames are available, a final-frame hold to frame 110 is only a proposal and requires visual review; otherwise fail closed. No unsupported format conversion, retry or replacement generation is authorized.

## Submission limits and production status

Pilot-02 already used **one** provider submission for the still. This proposal adds exactly **one** possible animation submission, exhausting the pilot-wide maximum of two. The future request must have its own `ANIMATION_ONLY` authorization with `maxProviderSubmissions: 1` and exactly this request key. No retries, fallback providers or fallback models. The current runner does not yet support this extension; implementation and separate authorization would be prerequisites.

The output must remain `NON_PRODUCTION_DISPOSABLE_PILOT`. Production asset readiness must reject it. Candidate reconstruction, promotion, rendering and distribution are prohibited.

## Unresolved properties to measure

Returned container; codec/profile; pixel dimensions; frame rate and CFR/VFR behavior; returned frame count; returned duration; and whether an audio stream exists. None is assumed from the model label, UI sample, or requested input settings.

## Bound hashes

| Input | SHA-256 |
|---|---|
| Current Pilot-02 ledger | `d6622e86ddcb0ea2bedb5418a9295434f70f34348f63836f5d6b77e2a3ec6278` |
| Existing Pilot-02 package index | `e6987203db61a88b82b36302d95df64694e0823a5d41108247dc5c403c2f8ca6` |
| Pilot-02 planning approval | `7569cf6f75807f256fa760d53a0fa28311cf98d41ecd572e18b96ca2920b90f9` |
| Pilot-01 rejection | `15b777e131233cf0d99e281b837013c6346f2ad335fc968f5417cb29ab40bde8` |
| Approved still | `34dbcf51e05f01eee0f4801202044b026a9b96c1ce07ee8efc15b45cbee57ac6` |
| Still approval | `67e77312141d81e18c663275a285b0dfe377233e4d60cafb79d57457fc526ab4` |
| Still authorization | `7d2623a1ba47fd37796afc32e08f94638a70e7a60089dbb4e9f016f13dd80eee` |
| Candidate index | `8ff011db727b1cf6ac47acff010f15d9559aa9dcfc763dc6830cbcba7916deac` |
| Timing edit plan | `9c2efb64c6cacfde55c4fb5492fdc9b5cff448bb907aa8aad629b3cd3f2ad02d` |

Official sources checked 2026-10-03: [Framepack model, features and published pricing](https://fal.ai/models/fal-ai/framepack) · [Framepack API and input/output schema](https://fal.ai/models/fal-ai/framepack/api).

## Human review

Decision: ____________________  Reviewer: ____________________  Date: ____________________  
Notes: ______________________________________________________________________________
