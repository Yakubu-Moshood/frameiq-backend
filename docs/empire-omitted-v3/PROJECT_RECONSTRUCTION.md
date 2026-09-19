# EMPIRE OMITTED V3
## Project Reconstruction & Build Specification

**Status:** APPROVED DESIGN — source of truth for implementation  
**Date locked:** 19 September 2026  
**Project:** FraymIQ / Empire Omitted  
**Purpose:** Reconstruct the complete reasoning, decisions, standards, architecture, implementation sequence and non-negotiable constraints agreed for the Empire Omitted V3 documentary pipeline, so future build work can continue without guessing, drifting, or re-litigating settled decisions.

---

## 0. How to Use This File

This document is the canonical reconstruction file for the Empire Omitted V3 rebuild.

When a new chat, engineer, coding agent, Claude session, ChatGPT session or future maintainer resumes this work, they should treat this file as the primary context before making changes.

### Non-negotiable working rule

Do **not** jump ahead and redesign unrelated parts of FraymIQ. Do **not** make broad cross-channel changes unless the work explicitly requires it. Empire Omitted V3 must be introduced in a controlled, channel-specific and reversible way.

The project is not a generic “make AI video better” exercise. The approved objective is to transform Empire Omitted from a generated-video pipeline into an **AI-assisted documentary production and editorial system** capable of producing authored, narration-synchronised, evidence-aware, visually dynamic investigative documentaries.

The system should automate production decisions, self-check, self-repair where possible, and involve the human director only for meaningful exceptions or final review.

---

# 1. Executive Vision

Empire Omitted currently has a recognisable visual identity but is limited by an asset-first production model:

> Script → Voiceover → Shot Definitions → Images → Animation → Render

The upgraded model must become editorial-first:

> Research → Script + Source Map → Voiceover → Word-Level Timing → Narrative / Emotional Map → Director's Edit Plan → Editorial QA → Asset Requirements → Evidence / Images / Animation / Graphics / Music / Sound → Asset QA → Timeline → Renderer → Final Editorial QA → Director Review

The central architectural decision is:

> **The Director's Edit Plan becomes the creative source of truth.**

Everything downstream should exist because the edit plan requires it.

The renderer must eventually become interchangeable. Today it may be FFmpeg / the existing FraymIQ renderer. In the future it may be DaVinci Resolve. The creative decisions must not be trapped inside a renderer-specific implementation.

---

# 2. Approved End Goal

Empire Omitted V3 should behave like a competent documentary production team rather than a sequence of media-generation calls.

The system should be able to:

1. Understand the story being told.
2. Understand what the audience knows at each point.
3. Understand the desired emotional progression.
4. Know the exact narration being spoken at every visual beat.
5. Choose whether each moment is best served by evidence, archival material, reconstruction, graphics or illustration.
6. Design sequences rather than isolated images.
7. Generate or retrieve the required media.
8. Maintain continuity where recurring people or locations are represented.
9. Direct motion intentionally rather than rely on pan/zoom as default behaviour.
10. Plan music, sound, silence, text graphics and editorial rhythm.
11. Validate 100% narration coverage before paying for media generation.
12. Detect and repair missing visual coverage automatically.
13. Reject accidental frozen frames rather than hide missing coverage by padding.
14. Run technical and editorial QA automatically.
15. Escalate only genuine exceptions to the director.
16. Produce a final master that can later be reconstructed as an editable DaVinci Resolve timeline.

---

# 3. Current Production Baseline

## 3.1 Current FraymIQ backend flow

The current production path is broadly:

- `0A_script` — Write Script
- `0B_vo` — Generate Voiceover
- `0C_shots` — Define Shots
- `0D_images` — Generate Images
- `0E_anim` — Animate Clips
- `1_render` — Render Episode
- `7_short` — Extract social clips
- `8_qa` — QA Check

The runner lives in `jobs/runner.js`.

Empire Omitted currently uses the `dramatic-investigative` visual profile in:

- `pipeline-updates/surface-shot-definitions.cjs`

The renderer is:

- `pipeline-updates/surface-renderer.cjs`

The animation generator is written by:

- `write-animator.js`

The production data root on Railway is `/data` and episode media live under `/data/episodes`.

## 3.2 Current Empire Omitted shot-generation constraints

The actual EO profile currently still contains a fixed-count instruction equivalent to:

> Every act: 8–10 shots maximum.

This is incompatible with the required editorial rhythm for a 9–12 minute documentary.

The current shot planner estimates durations before it knows exact finished-voice timing.

## 3.3 Current animation behaviour

The Kling path currently generates approximately 5-second animated clips.

The current Empire Omitted motion restraint was restored intentionally because later animation behaviour had become unstable and overly aggressive. The restraint protects geometry and prevents morphing, warping and uncontrolled subject movement.

That restraint is still valuable and must not simply be removed.

The problem is that it currently encourages repetitive movement patterns such as:

- slow push-in
- restrained dolly
- pan
- zoom

The fix is to add a richer directing vocabulary while retaining geometry protection.

## 3.4 Current renderer behaviour causing frozen imagery

Empire Omitted currently uses a `max_shot_duration_sec` of approximately 7 seconds.

The renderer currently treats excess duration as overflow and can hold / clone the final frame after motion has ended.

This means a narration interval longer than the motion clip can become:

> movement → final-frame freeze → narration continues

This is specifically rejected for V3.

---

# 4. Real Episode Review: Wells Fargo Benchmark

The episode reviewed for this redesign was the generated Empire Omitted Wells Fargo documentary:

**Working title:** “How Wells Fargo Employees Opened 3.5 Million Fake Accounts — And Only the Whistleblowers Got Fired”

**Reviewed master:** `EmpireOmitted_LATEST_FINAL_final.mp4`

Approximate total runtime reviewed: 11:25.

The episode had approximately 49 planned visual shots across the programme.

## 4.1 Principal diagnosis

The film has a strong visual identity but is currently **illustrated rather than directed**.

The images often describe a concept, but the visual sequence does not consistently advance the story.

The major issue is not primarily image quality. It is editorial coverage and visual grammar.

## 4.2 Freeze / inactivity finding

The reviewed programme contained extensive periods where the picture became effectively static while narration continued.

Observed analysis indicated approximately:

- ~390 seconds detected as effectively frozen for at least a short interval
- 24 frozen stretches of approximately 5 seconds or longer
- roughly 277 seconds, or around 41% of the narrated programme, affected by long static stretches
- 13 stretches longer than approximately 10 seconds

Representative long holds were observed around:

- 0:45–1:02
- 1:11–1:27
- 2:41–3:01
- 4:14–4:31
- 7:52–8:11
- 9:16–9:33

These numbers are a benchmark for what V3 must eliminate, not a future target.

## 4.3 Opening issue

The opening used only a few dominant visual ideas over roughly the first half-minute:

- bank exterior
- deserted desk / employee workspace
- symbolic wagon-wheel imagery

Each image was individually attractive, but the opening did not accumulate evidence or narrative information quickly enough.

A stronger opening should move through controlled investigative fragments such as:

- bank exterior
- employee entering customer data
- folders / accounts accumulating
- unexpected customer statement
- sales target board
- employee badge
- regulatory / hearing imagery
- complaints
- whistleblower call
- empty cubicle
- title

The principle is controlled investigative momentum, not hyperactive short-form editing.

## 4.4 Symbolic-image overuse

The current film relies heavily on concept images:

- cash on desks
- calculators
- closed doors
- scales of justice
- envelopes
- empty boardrooms
- rejected résumé imagery
- trash bins
- empty offices

These communicate themes but often do not show events.

**Approved rule:** Prefer **visual sequences over visual metaphors**.

## 4.5 Missing cause-and-effect storytelling

Where narration describes a mechanism, the visual sequence should show the mechanism.

Example:

> Executive target → branch manager → morning sales huddle → employee sees quota → customer sits down → extra account opened → paperwork accumulates → employee realises consequence.

This is preferred to a disconnected series of moody corporate images.

## 4.6 Human story deficit

Empire Omitted investigates institutions, but institutions become dramatic through what happens to people.

The Wells Fargo film relied too often on empty rooms and objects where human action would have been stronger.

V3 must intentionally show human behaviour through:

- hands
- posture
- silhouettes
- employees leaving
- personal belongings packed
- notices being opened
- badges being removed
- customers reacting
- documents changing hands
- phone calls
- people waiting outside offices

No identifiable real person needs to be fabricated for these reconstructions.

## 4.7 Synthetic-document credibility problem

AI-generated documents, memos, newspapers and signs may contain malformed or nonsensical text and can create ambiguity about whether fake material is being presented as real evidence.

This is unacceptable for a documentary system aiming at high editorial credibility.

V3 therefore needs a dedicated **EVIDENCE** visual class and clear truth conventions.

## 4.8 Visual identity finding

The existing Empire Omitted identity is worth preserving:

- dark investigative atmosphere
- charcoal / black foundations
- gold accent language
- red used for danger / impact
- restrained cinematic lighting
- strong typography concept

The issue is not the identity. The issue is over-constant application.

V3 should allow the visual language to evolve across the dramatic arc rather than applying one emotional exposure to the entire film.

---

# 5. Empire Omitted Director Standard

The following standards are approved and should govern V3.

## 5.1 Every visual must perform a story function

No visual should exist only because a noun appears in the narration.

Every visual beat should identify a `storyFunction`, such as:

- `establish`
- `reveal`
- `evidence`
- `human_cost`
- `cause`
- `consequence`
- `contrast`
- `escalation`
- `orientation`
- `emotional_hold`
- `transition`
- `payoff`
- `context`

If the system cannot explain why a visual exists, it should not be generated.

## 5.2 Direct sequences, not isolated images

Visual planning should be capable of grouping multiple beats into a `sequenceId` with a `sequencePurpose`.

Example:

> “Show how executive pressure becomes customer abuse.”

The system should then construct a sequence of connected visual actions rather than one symbolic image.

## 5.3 Narration and visuals must be semantically locked

Every visual beat should carry:

- exact start time
- exact end time
- duration
- narration excerpt
- visual intent
- story function

The media generator should know exactly what line it is supporting and why.

## 5.4 Three visual truth classes

V3 must distinguish:

### A. EVIDENCE
Real documentary material:

- court records
- regulatory filings
- public reports
- genuine documents
- hearing footage
- archival photographs
- financial statements
- public testimony
- authenticated news / records where legally usable

Evidence requires source provenance.

### B. RECONSTRUCTION
AI-generated or otherwise reconstructed representation of an event that cannot be directly shown.

Reconstructions must not be presented in a way that deceptively implies they are authentic source footage.

### C. EDITORIAL ILLUSTRATION
Symbolic, explanatory or conceptual imagery used deliberately to make an idea understandable.

Abstract imagery should be a purposeful choice, not the default.

## 5.5 Evidence should be directed

Evidence should not merely flash on screen.

The edit plan should support:

- document reveal
- paragraph isolation
- highlight / underline
- dimming irrelevant text
- camera move into a clause
- animated timeline / annotation
- source caption
- fact overlay

## 5.6 Reconstruction continuity

Recurring people / environments should preserve continuity where appropriate.

Continuity may include:

- character reference
- wardrobe reference
- environment reference
- lighting reference
- lens / camera language
- historical era
- geography
- prop continuity

The goal is to make connected shots feel like one sequence, not unrelated AI generations.

## 5.7 Human beings must remain central

Each episode should identify:

- who benefits
- who knows
- who obeys
- who resists
- who pays the price

The visual strategy should reflect these human perspectives.

## 5.8 Stillness is allowed only when intentional

Stillness is a directing tool.

V3 must distinguish:

- `intentional_hold`
- `unplanned_freeze`

An intentional emotional hold may be appropriate.

An unplanned frozen final frame caused by inadequate coverage is a pipeline failure.

## 5.9 Visual rhythm is dynamic, not mechanical

Normal target range:

- approximately 3.5–5.5 seconds per visual beat

Hard normal maximum:

- approximately 6 seconds

However, deliberate exceptions are allowed where editorially justified and explicitly tagged.

The system should support rhythm intents such as:

- `measured`
- `building`
- `accelerating`
- `fractured`
- `suspended`
- `reflective`
- `impact`

## 5.10 Act-by-act visual evolution

The visual language should evolve with the story.

Example dramatic progression:

- Setup: polished / composed corporate world
- Rise: warmer / confident / organised
- Corruption: colder / tighter / darker
- Exposure: evidence-heavy / harder contrast / more clinical
- Human Cost: desaturated / intimate / slower
- Collapse: more urgent cuts / hearings / press / public scrutiny
- Aftermath: cleaner frames / distance / unresolved stillness

## 5.11 Text graphics need hierarchy

V3 should distinguish at least:

- identity lower third
- source title / citation
- impact card
- date / timeline marker
- data graphic
- direct quote
- document callout
- chapter marker
- takeaway

Not every fact should use the same red-stamp treatment.

Major impact typography should be reserved for genuinely major facts.

## 5.12 Recurring visual motifs

The system should support motifs that gain new meaning as the film progresses.

Example:

- sales board initially means ambition
- later means pressure
- later becomes evidence

## 5.13 Motivated transitions

Most transitions should remain simple cuts.

Special transitions should be motivated by story or visual continuity, not chosen as decorative effects.

## 5.14 Director's intent

Each major sequence should contain a `directorIntent` explaining the audience transformation the sequence is meant to create.

Example:

> “The audience should initially understand the sales programme as aggressive but legitimate. By the end of this sequence they should realise the same incentive structure made abuse predictable.”

---

# 6. Narrative and Emotional Architecture

## 6.1 Emotional map

Every episode should be capable of tracking an emotional curve, for example:

> Curiosity → Admiration / Scale → Unease → Suspicion → Shock → Empathy → Anger → Disillusionment → Reflection

This should influence:

- cut density
- framing
- colour
- motion
- music
- silence
- graphics
- shot duration

## 6.2 Knowledge / revelation map

The audience should not receive all information at once.

The edit plan should know:

- what the audience currently knows
- what question is active
- what this sequence answers
- what new question it creates

Example:

> How did Wells Fargo become dominant? → Why were staff under pressure? → What did they actually do? → Who knew? → What happened to people who objected? → Who was punished? → Who walked away rich?

## 6.3 Script becomes edit-aware

The script writer should gradually learn to write visually productive narration rather than prose that is difficult to dramatise.

The long-term writing standard should favour lines that create editorial opportunity.

The goal is not to make every sentence visual, but to avoid a pipeline where the editor must illustrate dense explanatory prose after the fact.

---

# 7. Motion Direction Standard

## 7.1 Keep geometry protection

The recovered Empire Omitted restraint remains conceptually correct:

- preserve subject geometry
- preserve object geometry
- no morphing
- no warping
- no unnecessary autonomous movement
- no uncontrolled orbit / sweeping pan

Do not remove these protections in the name of “more dynamic.”

## 7.2 Expand motion vocabulary

Approved initial motion types:

- `dolly_forward`
- `dolly_back`
- `lateral_track`
- `crane_rise`
- `crane_descend`
- `tilt_reveal`
- `rack_focus`
- `foreground_parallax`
- `controlled_handheld`
- `static_locked`
- `subject_micro_action`
- `environmental_motion`
- `document_reveal`
- `object_action`
- `silhouette_movement`

## 7.3 Camera motion versus story motion

V3 must distinguish:

**Camera motion:** movement of viewpoint.

**Story motion:** an action that advances understanding.

Story motion examples:

- stamping
- typing
- opening
- closing
- passing a document
- removing a badge
- signing
- stacking
- printing
- scrolling
- entering
- leaving
- doors closing
- cards / files accumulating

## 7.4 Motion rule

Preferred default for reconstructed motion:

> One clear primary camera movement plus, where appropriate, one meaningful subject or environmental action.

This creates cinematic life without reintroducing unstable AI-video behaviour.

---

# 8. Sound and Music Standard

## 8.1 Three sound layers

Every edit should conceptually support:

- VOICE
- MUSIC
- WORLD / SFX

## 8.2 World sound should create place

Examples:

- keyboard clicks
- office chatter
- printer mechanism
- elevator chime
- paper movement
- fluorescent hum
- traffic outside headquarters
- courtroom room tone
- camera shutters
- phone connection

These should remain restrained and documentary-appropriate.

## 8.3 Music is editorial, not wallpaper

Each episode should have a music map.

A typical progression may include:

- cold open — sparse tension
- setup — restrained investigative pulse
- expansion — increased momentum
- scheme / corruption — mounting pressure
- human cost — music strips back dramatically
- exposure — tension rebuilds
- collapse — urgency
- consequences — slower unresolved texture
- final thought — minimal motif
- outro — brand signature

Supported music events should include:

- rise
- drop
- cut
- resume
- resolve
- duck under line

## 8.4 Silence is editorial

V3 should eventually be allowed to create deliberate micro-pauses or near-silence so important visual moments can land.

This is a long-term integration point between script writing, TTS and edit planning.

---

# 9. Director's Edit Plan — Core Artifact

The new canonical creative artifact is:

**`edit-plan.json`**

This file is renderer-neutral.

It should be paired later with:

**`timeline.json`**

The distinction is:

- `edit-plan.json` = creative intent
- `timeline.json` = deterministic execution instructions

## 9.1 Example edit-plan beat

```json
{
  "beatId": "ACT2_B014",
  "sequenceId": "SEQ_ACT2_04",
  "startSec": 63.42,
  "endSec": 68.11,
  "durationSec": 4.69,
  "narrationExcerpt": "Employees were expected to sell as many as eight products to every customer.",
  "storyFunction": "cause",
  "visualIntent": "Show how the sales quota reaches the employee and shapes behaviour.",
  "visualClass": "RECONSTRUCTION",
  "visual": {
    "type": "CLIP",
    "description": "Bank employee studies an aggressive cross-sell target board before returning to a waiting customer.",
    "motionType": "lateral_track",
    "secondaryAction": "employee looks from quota board back to customer"
  },
  "graphics": null,
  "audioDirection": {
    "musicCue": "pressure_build",
    "musicLevelDb": -24,
    "duckUnderVO": true,
    "sfx": ["office_room_tone"]
  },
  "rhythmIntent": "building"
}
```

## 9.2 Sequence-level fields

A sequence should support:

- `sequenceId`
- `sequencePurpose`
- `directorIntent`
- `emotionalStateStart`
- `emotionalStateEnd`
- `knowledgeQuestion`
- `knowledgeAnswer`
- `motifRefs`
- `continuityRefs`

## 9.3 Evidence fields

Evidence-type beats should support:

- source ID
- source type
- source description
- source URL / archive reference where permitted
- rights / usage status
- authenticity status
- visual treatment
- citation label
- whether human review is required

---

# 10. Timeline Artifact for Future DaVinci Integration

The future execution artifact is:

**`timeline.json`**

It should contain deterministic editing instructions such as:

- absolute timecodes
- clip source filenames / IDs
- video track
- audio track
- clip in / out
- duration
- speed
- transition
- transition duration
- volume
- keyframes
- overlays
- text position
- music automation
- SFX timing
- colour / grade reference
- markers
- captions

## 10.1 Renderer-neutral architecture

Approved long-term model:

```text
Director's Edit Plan
        ↓
Timeline Compiler
        ↓
    timeline.json
      /       \
Current         Future
Renderer         DaVinci Adapter
```

## 10.2 DaVinci integration principle

Claude / ChatGPT should make creative decisions.

A deterministic DaVinci adapter should execute those decisions.

Do not make GUI clicking the primary integration strategy.

A future MCP layer should expose higher-level operations such as:

- create timeline
- insert clip
- trim clip
- replace shot
- place music
- set volume
- add marker
- add title
- add transition
- apply grade
- render timeline

---

# 11. New V3 Pipeline Architecture

## 11.1 Target sequence

```text
RESEARCH
   ↓
SCRIPT + SOURCE MAP
   ↓
VOICEOVER
   ↓
VO TIMING / WORD TIMESTAMPS
   ↓
NARRATIVE + EMOTIONAL MAP
   ↓
DIRECTOR'S EDIT PLAN
   ↓
EDITORIAL / COVERAGE QA
   ↓
ASSET REQUIREMENTS
   ├── EVIDENCE / ARCHIVAL
   ├── RECONSTRUCTION IMAGES
   ├── ANIMATED CLIPS
   ├── GRAPHICS
   └── MUSIC / SFX
   ↓
ASSET QA
   ↓
TIMELINE COMPILATION
   ↓
RENDERER
   ↓
FINAL EDITORIAL + TECHNICAL QA
   ↓
DIRECTOR REVIEW
```

## 11.2 First incremental production architecture

To avoid a risky rewrite, V3 should initially slot into the existing pipeline as:

```text
0A  Script
 ↓
0B  Voiceover
 ↓
NEW — VO Timing
 ↓
NEW — Director's Edit Plan
 ↓
NEW — Coverage Validation
 ↓
Compatibility compiler → shot-definitions.json
 ↓
0D  Images
 ↓
0E  Animation
 ↓
NEW — Asset / Motion Coverage Validation
 ↓
1   Existing Renderer
 ↓
7   Social Clips
 ↓
8   Expanded Final QA
```

This preserves working downstream infrastructure while the new intelligence layer becomes authoritative.

---

# 12. Phase 1 Build — Approved Starting Point

The first implementation phase should contain **only four core build pieces**.

Do not begin by changing image generation, Kling or the renderer.

## 12.1 Extract Whisper timing

Create a reusable timing module, proposed filename:

- `pipeline-updates/vo-timing.cjs`

Move / reuse the existing Whisper transcription behaviour currently embedded inside the renderer.

Requirements:

- run immediately after voiceover
- produce `word-timestamps.json`
- retain retry logic
- retain partial per-act checkpointing
- do not pay twice when renderer later needs timestamps
- renderer should reuse the already-created timestamp file

## 12.2 Director's Edit Plan generator

Create:

- `pipeline-updates/edit-plan-generator.cjs`

Inputs:

- `script.json`
- `word-timestamps.json`
- Empire Omitted Channel DNA
- later: source map / research evidence

Output:

- `edit-plan.json`

## 12.3 Edit Plan validator

Create:

- `pipeline-updates/edit-plan-validator.cjs`

It should validate before any image / video generation.

Initial hard checks:

- 100% narration coverage
- no timeline gaps
- no unintended overlap
- normal beat target ~3.5–5.5 sec
- hard normal maximum ~6 sec
- each beat has narration excerpt
- each beat has visual intent
- each beat has story function
- explicit reason required for long intentional hold

If validation fails, the system should repair the plan automatically and revalidate.

## 12.4 Compatibility compiler

Create:

- `pipeline-updates/edit-plan-to-shots.cjs`

This compiles `edit-plan.json` into the existing `shot-definitions.json` format so the current image, animation and renderer stages can continue functioning during migration.

New useful fields such as `voStartSec`, `voEndSec`, `narrationExcerpt`, `motionType`, `visualClass` and `storyFunction` may be carried through even if the legacy renderer initially ignores them.

---

# 13. Phase 2 — Visual Production Upgrade

After Phase 1 is stable:

1. Replace fixed 8–10 shots per act with timing-driven visual beats.
2. Expand image prompts using narration excerpt + sequence intent.
3. Add visual class awareness: evidence / reconstruction / illustration.
4. Add continuity references.
5. Expand motion vocabulary.
6. Add story motion alongside camera motion.
7. Add evidence / archival handling.
8. Add graphic treatment types.
9. Add sequence-level image generation, not isolated prompts only.

---

# 14. Phase 3 — Eliminate Freeze Padding

For Empire Omitted V3, automatic final-frame padding must no longer be accepted as a normal solution.

If a resolved narration interval exceeds allowed coverage, the system should fail the editorial coverage check and create more beats.

Example:

```text
VISUAL COVERAGE ERROR
ACT2_B014
Resolved duration: 11.8 sec
Normal maximum: 6 sec
Action: split / repair visual plan
```

The renderer must not silently solve a missing editorial decision by freezing the visual.

---

# 15. Phase 4 — Asset / Motion Coverage QA

Create a pre-render asset validator, proposed:

- `pipeline-updates/asset-coverage-validator.cjs`

It should verify:

- every planned beat has an asset
- every planned CLIP has a valid animation
- no missing images
- no zero-byte / corrupt assets
- no animation failures silently converted to long still holds
- no missing evidence item
- no missing graphic
- no unsupported asset substitution

If an animation fails, the pipeline should:

1. retry
2. use approved fallback provider
3. use an approved alternative visual treatment
4. only then escalate

---

# 16. Phase 5 — Final Editorial QA Upgrade

The current QA stage already has useful technical foundations such as:

- output integrity
- silence detection
- loop / repeated frame analysis
- aspect ratio checks

V3 should extend it with:

- freeze detection
- black-frame detection
- visual-cut frequency
- narration coverage verification
- asset mismatch detection
- malformed generated-text detection
- continuity checks where feasible
- repeated metaphor / repeated composition flags
- long passages without human presence
- excessive reliance on AI reconstruction
- evidence provenance issues
- music / narration balance
- text readability
- opening momentum
- ending resolution

Empire Omitted should fail final QA for unintended frozen-frame behaviour.

---

# 17. Automation Philosophy

## 17.1 Approved default mode

**Director Mode: Review Exceptions Only**

The pipeline should not require manual approval for every image, animation, act or micro-decision.

The approved control loop is:

```text
Make decision
   ↓
Execute
   ↓
Validate
   ↓
Pass? → continue automatically
   ↓ no
Repair automatically
   ↓
Pass? → continue automatically
   ↓ no
Escalate meaningful exception to director
```

## 17.2 Self-repair examples

If a visual beat is 11 seconds:

- validator rejects
- edit planner splits / repairs
- validator reruns
- user is not interrupted

If Kling deforms a hand:

- animation QA rejects
- regenerate
- retry up to defined threshold
- use approved fallback if needed
- only escalate if repeated failure persists

If an evidence source has uncertain usage rights:

- escalate to user

## 17.3 Human involvement should remain for

- final master review
- high-risk evidence / rights decisions
- ambiguous factual or legal material
- repeated automated repair failure
- genuinely creative choices where user preference is needed

The user should act as executive producer / director, not pipeline operator.

---

# 18. Frontend Vision

The frontend should eventually stop feeling like a sequence of low-level generation actions and instead expose meaningful production stages.

Long-term desired view:

```text
EMPIRE OMITTED — EPISODE

Research                 COMPLETE
Script                   COMPLETE
Voice                    COMPLETE
Director's Edit Plan     COMPLETE
Editorial QA             PASS
Evidence                 COMPLETE
Visual Production        COMPLETE
Animation QA             PASS
Timeline Assembly        COMPLETE
Sound Mix                COMPLETE
Final QA                 PASS

READY FOR DIRECTOR REVIEW
```

Failed stages should expose actionable retry / exception details.

The recently implemented failed-stage Retry control is already consistent with this direction.

---

# 19. Channel Isolation and Rollback

V3 must initially be isolated to Empire Omitted.

Do not modify Macro Decode pacing or visual logic simply because EO is changing.

Recommended feature control:

- `pipeline_version = 3`

or

- `edit_plan_enabled = true`

for Empire Omitted only.

A rollback path must remain available while V3 is being proven.

Example:

```text
Empire Omitted V2
        OR
Empire Omitted V3
```

Do not change the current production Wells Fargo episode mid-run or retroactively force V3 onto already-generated media.

---

# 20. Source / Evidence Policy

V3 should ask before generating a reconstruction:

> Is there authentic source material that can tell this better?

Preferred hierarchy:

1. Real evidence
2. Real archival visual
3. Editorial graphic
4. AI reconstruction
5. Abstract illustration

This is a hierarchy, not an absolute prohibition. The system may use reconstructions where they genuinely improve storytelling, but it should not default to synthetic imagery when credible evidence is available and appropriate.

Evidence should preserve provenance.

AI reconstructions should be visually honest and should not impersonate documentary evidence.

---

# 21. Music and Edit Script — Renderer Neutrality

Every episode should ultimately have an accompanying edit script.

The approved structure is two layers:

## 21.1 `edit-plan.json`

Creative intent:

- narration
- story function
- visual choice
- movement
- evidence
- graphics
- emotional state
- music intention
- SFX intention
- transitions
- continuity
- director intent

## 21.2 `timeline.json`

Execution detail:

- exact track placement
- source media
- in / out
- trims
- speed
- volume
- keyframes
- transitions
- graphic positioning
- markers
- caption timing

This allows today's renderer and future DaVinci automation to execute the same creative plan.

---

# 22. Recommended Future DaVinci / MCP Model

Do not make DaVinci GUI automation the core architecture.

Preferred pattern:

```text
Claude / ChatGPT
       ↓
Creative Edit Decisions
       ↓
edit-plan.json
       ↓
Timeline Compiler
       ↓
timeline.json
       ↓
DaVinci Adapter / MCP
       ↓
Editable Resolve Timeline
```

The AI should think like an editor / director.

The adapter should execute deterministic editing operations.

---

# 23. Implementation Guardrails — Do Not Drift

The following are explicitly **not** the first task:

- replacing the renderer immediately
- integrating DaVinci before V3 planning works
- changing every FraymIQ channel
- removing motion restraint and making Kling “more aggressive” globally
- adding random transitions to make the video feel dynamic
- generating more images without first fixing narration timing / coverage
- building a large UI before the new planning artifacts are stable
- changing working production episodes mid-run
- using long final-frame freeze as a normal fallback

If implementation starts drifting into one of these areas before Phase 1 is proven, return to this document.

---

# 24. Phase 1 Acceptance Criteria

Phase 1 is considered successful only when FraymIQ can take a real Empire Omitted script + generated VO and automatically produce a Director's Edit Plan that passes validation **before any new image or video generation begins**.

Minimum expected output:

```text
EMPIRE OMITTED EDIT PLAN QA

VO runtime:                 [actual]
Planned visual coverage:    100%
Total visual beats:         [timing-driven]
Average beat duration:      within target range
Longest normal beat:        <= 6 sec
Narration gaps:             0
Timeline overlaps:          0 unintended
Missing story functions:    0
Missing narration excerpts: 0
Unresolved visual intent:   0

STATUS: PASS
```

The generated plan should also show qualitatively that:

- sequences tell cause and effect
- human consequences are represented
- evidence opportunities are identified
- visuals are not mostly symbolic objects
- motion is varied but controlled
- important moments are allowed deliberate stillness

---

# 25. Future Final-Master Acceptance Standard

The long-term V3 final master should aim for a report like:

```text
EMPIRE OMITTED — FINAL REVIEW

Narration coverage       100%
Visual coverage          100%
Unplanned freezes        0
Missing assets           0
Evidence issues          0 unresolved
Continuity violations    0 critical
Unsupported claims       0
Visual QA                PASS
Audio QA                 PASS
Editorial QA             PASS
Director interventions   0 or exceptions only

READY FOR FINAL REVIEW
```

The final human review remains important. Automated QA does not replace taste.

---

# 26. Approved First Build Sequence

When implementation begins, proceed in this order:

### Step 1
Create a dedicated V3 branch from the current production backend.

### Step 2
Extract / reuse Whisper timing as `vo-timing.cjs` and move it to immediately after VO.

### Step 3
Define and version the `edit-plan.json` schema.

### Step 4
Build `edit-plan-generator.cjs` for Empire Omitted only.

### Step 5
Build `edit-plan-validator.cjs` with hard narration-coverage and duration constraints.

### Step 6
Run against a real completed script + VO and inspect the generated plan manually once as a development validation exercise.

### Step 7
Add automatic repair loop and rerun validation.

### Step 8
Build `edit-plan-to-shots.cjs` so legacy downstream modules can use the new plan.

Only after this milestone is stable should image generation, animation, renderer freeze behaviour, evidence retrieval, music planning and final QA be upgraded.

---

# 27. Definition of Success

Empire Omitted V3 is successful when the audience no longer experiences the film as:

> “Narration says something, then an AI image representing the noun appears.”

The audience should experience:

- a deliberate visual argument
- developing scenes
- accumulating evidence
- human consequence
- cause and effect
- controlled revelation
- dynamic but restrained motion
- purposeful stillness
- meaningful sound
- authored rhythm
- visual continuity
- editorial credibility

The system should make the same underlying judgement a strong documentary director and editor would make:

> What should the audience understand, feel and notice **right now**, and what is the strongest truthful visual and sonic way to make that happen?

---

# 28. Handoff Instruction for Any New Build Session

If this project is resumed in a new chat or coding session, begin with the following assumptions:

1. The V3 design in this document is approved.
2. Do not ask the user to re-decide the principles already locked here.
3. Inspect the current repository state before modifying files.
4. Work on a separate branch first.
5. Preserve production rollback.
6. Keep V3 Empire Omitted-specific until proven.
7. Build Phase 1 before changing animation / render logic.
8. Test each new artifact with a real Empire Omitted episode.
9. Do not silently broaden scope.
10. Treat this document as the reconstruction source of truth when implementation choices are ambiguous.

---

# 29. Locked Decisions Summary

The following decisions are approved and should be considered settled unless the user explicitly changes them later:

- Empire Omitted V3 will be editorial-first.
- The Director's Edit Plan will become the creative source of truth.
- `timeline.json` will become the future execution source of truth.
- The system will plan from finished VO timing, not estimated narration timing.
- Normal visual beats target ~3.5–5.5 seconds.
- ~6 seconds is the normal hard maximum unless explicitly justified.
- Narration coverage must be 100%.
- Unplanned frozen-frame padding is not an acceptable normal fallback.
- Stillness remains allowed when intentional.
- Evidence, reconstruction and editorial illustration must be distinguished.
- Real evidence / archival material should be preferred when it tells the story better.
- Visual sequences are preferred over isolated metaphors.
- Human behaviour must become more prominent.
- Reconstruction continuity should be supported.
- Motion vocabulary must expand while geometry protection remains.
- Music, ambience, SFX and silence are editorial layers.
- Text graphics require hierarchy.
- Each act should evolve visually.
- Emotional and revelation maps should influence editing.
- Script writing should gradually become edit-aware.
- Automated QA and self-repair should be the default.
- Human intervention should be exception-based plus final review.
- V3 begins behind an Empire Omitted-specific feature flag / pipeline version.
- Current renderer remains initially for compatibility.
- DaVinci is a future adapter, not the immediate first build.
- A future MCP integration should expose high-level deterministic edit operations.

---

**END OF RECONSTRUCTION FILE**
