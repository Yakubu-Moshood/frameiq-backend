# Phase 3 minimal pilot proposal — v1

Status: PROPOSED_UNSIGNED_NOT_AUTHORIZED_FOR_EXECUTION. This is planning only and authorizes no request.

## Package bindings

- v5 package index: 2d7fae8b138b259f7e4917290cdae7489307b9055904817d1b69e4867935c8b0
- v5 unsigned approval proposal (actual current bytes): 8a867a6b0a826d97207148ac094fbb7485ae6fe9b445979816c44acac202fb87
- v5 review JSON: b6cd1067a3b440d39c2a6de8d8dc1ea2554ab71704bd0c7c5f24fff9eb05c68c
- v5 review Markdown (actual current bytes): 37dfe892e0993dec5675db2a36357543e9143693028608f07d45917333cdde33

## Proposed two-request same-beat sequence

1. **Generated base still:** fal.ai, blackforestlabs/flux-3/text-to-image, ACT3_B005. Use the exact proposed ACT3_B005 prompt and negative prompt in the v5 review JSON; request 1K, 16:9, PNG, prompt expansion disabled. The endpoint currently lists $0.024 for 1K through October 8, 2026, then $0.048. Returned pixel dimensions and content type must be measured and reviewed.
2. **Animation clip:** fal.ai, fal-ai/framepack, ACT3_B005. Use only the generated still from request 1 as the same-beat image-to-video starting frame. Request 16:9, 480p and 150 frames. This is a required same-beat animation-base dependency, not cross-beat sharing or an alias.

The approved ACT3_B005 visual action is hands sliding an ID across a generic desk toward a banker’s hands at a keyboard, with the banker beginning to type. The motion prompt must remain limited to that action.

## Price, outputs and ownership

Framepack currently lists $0.0333 per generated second. A five-second result estimates $0.1665; adding the 1K still gives $0.1905 before tax. Its page documents up to 180 frames, 480p or higher, and an example MP4 response. It does not promise an exact frame rate, dimensions, codec or duration. The returned media must be probed and rejected if outside the reviewed fit. Actual charge follows generated seconds.

fal’s current Terms license processing of submitted inputs and put input rights-clearance responsibility on the customer. The model pages’ commercial-use labels do not establish customer ownership. The reviewed general Terms do not clearly grant customer ownership of outputs, so written clarification is required before generation.

## Request keys and limits

The JSON proposal carries deterministic SHA-256 request keys bound to the ACT3_B005 prompt hash. Maximum: two requests total, one attempt each, no retries. A proposed total $0.25 cost ceiling is not documented as enforceable by these endpoints. Do not execute unless the maximum charge can be bounded before submission within that cap, ownership terms are clarified, and the pilot is separately authorized.

## Stop conditions

No request keys are reserved. Do not submit either request unless all preconditions above pass. Stop on provider/model, prompt, input hash, rights/ownership, price cap, returned type/dimensions/codec/frame rate/duration or validation mismatch. No retries, variants, candidate reconstruction, promotion or rendering. Execution signature and provider authorization remain blank.
