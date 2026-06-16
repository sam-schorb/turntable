# Platter Motion And Manual Drag Implementation Plan

Status: Planning
Normative: Yes for this feature
Owner: Turntable
Last Updated: 2026-06-16

## Goal

Add manual platter dragging without damaging existing drawing, motor playback, reader, or sampler behavior.

The product model is a vinyl turntable:

- the polar score is the record surface
- `phaseTurns` is the platter angle
- `actualGlobalSpeed` is the signed platter velocity
- the motor and the user's hand both act on the same platter
- the fixed reading arm hears whatever coloured score material passes underneath it

This feature must not introduce a separate scratch playback path. Pointer gestures may move the platter, but sound must still come from the existing score -> reader -> voice -> AudioWorklet path.

## Existing System Summary

The current app already has most of the right musical contracts:

- `transport.phaseTurns` is the shared visual/audio phase.
- `actualGlobalSpeed` is signed and already supports negative playback direction.
- the renderer consumes `phaseTurns`.
- the reader consumes `phaseTurns` and signed speed.
- voices derive effective playback rate from signed speed and radial position.
- the AudioWorklet already plays forward and reverse voices.

The current problem is conceptual:

- `isPlaying` and `isPaused` currently represent motor state, platter motion, and voice-start policy at the same time.
- stopped motor currently implies `actualGlobalSpeed = 0`.
- paused snapshots suppress new voice starts.

Manual dragging breaks that coupling. A stopped motor with a hand-moving platter should be audible.

## Architectural Direction

Refactor the transport model into a single platter motion engine.

Do this:

```text
input controllers -> one platter motion engine -> one motion snapshot -> render/reader/audio
```

Avoid this:

```text
motor transport path + gesture transport path + special reader/audio scratch path
```

The motor and hand are controllers of one platter. They are not independent musical sources.

## Implementation Contract

This section resolves choices that should not be re-decided during implementation.

### One Platter, Multiple Controllers

- `transport` should remain the module that owns phase and velocity.
- The motor is a controller that can drive the platter toward a target speed.
- The hand is a controller that can override the motor while grabbed.
- The reader, renderer, voice manager, and AudioWorklet must not branch into separate "motor" and "scratch" audio paths.
- `motionSource` may be exposed as a debug field if helpful, but production logic should primarily depend on physical state:
  - `phaseTurns`
  - `actualGlobalSpeed`
  - `canStartVoices`
  - `handGrabActive`
  - `motorEnabled`

### Hand-To-Platter Sign Convention

The renderer currently treats increasing `phaseTurns` as moving the platter according to the established transport convention. A grabbed visible point should stay under the pointer while the user drags.

Use this as the initial formula unless tests prove the existing renderer convention requires the opposite sign:

```js
phaseTurns = normalizePhaseTurns(grabStartPhaseTurns - pointerDeltaTurns);
actualGlobalSpeed =
  -(pointerDeltaTurns / elapsedSeconds) * baseRevolutionSeconds;
```

This is intentionally explicit because sign errors are easy to hide until reverse drag is tested in the browser.

### Time And Mutation Policy

- All motion updates must use explicit monotonic `nowSeconds`.
- Same-timestamp updates must be accepted and must not produce infinite speed.
- Pointer event timestamps may be normalized by the gesture controller, but the transport module should remain deterministic when passed explicit times.
- `getTransportSnapshot(transport, nowSeconds)` may continue to update transport state for compatibility, but gesture update functions must keep `lastUpdateSeconds` coherent so render and reader ticks do not double-integrate or undo hand motion.

### `canStartVoices` Policy

`canStartVoices` is a policy flag, not a velocity threshold.

- It should be true during motor playback when current behavior allows starts.
- It should be false during paused-motor intent where current behavior blocks starts.
- It should be true while the hand is actively controlling the platter, even when speed is currently near zero.
- Near-zero speed should still prevent fresh audible starts through existing playback-rate trigger rules.
- Existing matched voices should still receive updates/fades at near-zero speed.

### Voice Continuity Policy

- Voice continuity should be based on descriptor matching, colour/slot, component hints, and radial proximity.
- Direction changes and speed changes should not by themselves create new voices.
- A true descriptor disappearance followed by later re-entry may create a new voice.
- Tests must assert message sequences, not just final active-voice counts, for direction reversal cases.

### Fast Drag Reader Policy

Endpoint-only reader snapshots are acceptable only if tests prove they do not miss narrow marks at realistic maximum drag speeds.

If they fail, implement swept phase-interval reader analysis behind `ReaderEngine` before calling the feature complete.

Swept analysis, if needed, must:

- consume the polar score, geometry, previous phase, next phase, and signed direction
- stay behind the existing reader abstraction
- emit descriptor payloads compatible with voice matching
- handle direction reversal as two signed intervals
- avoid pointer-event-triggered audio

## Target Snapshot Contract

The reader, renderer, and voice manager should consume one snapshot shape. Existing fields should remain for compatibility, but their meaning should become clearer.

Recommended snapshot:

```js
{
  phaseTurns,
  actualGlobalSpeed,
  targetGlobalSpeed,

  motorEnabled,
  motorTargetSpeed,
  handGrabActive,

  canStartVoices,
  motionSource,

  isPlaying,
  isPaused,
  isRamping,
  rampType,
  baseRevolutionSeconds,
  nearZeroSpeedThreshold,
  audioTime
}
```

Compatibility mapping:

- `isPlaying` should mean motor enabled.
- `isPaused` should mean motor not enabled, not necessarily platter motion is impossible.
- `actualGlobalSpeed` should always mean physical platter speed.
- `canStartVoices` should replace hidden voice-start decisions based only on `isPaused`.
- `motionSource` should be treated as diagnostic metadata, not a second routing system.

Required snapshot examples:

```js
// Motor playing normally.
{
  motorEnabled: true,
  handGrabActive: false,
  isPlaying: true,
  isPaused: false,
  canStartVoices: true
}

// Motor stopped, hand moving the platter.
{
  motorEnabled: false,
  handGrabActive: true,
  isPlaying: false,
  isPaused: true,
  canStartVoices: true
}

// Motor playing, hand overriding the platter.
{
  motorEnabled: true,
  handGrabActive: true,
  isPlaying: true,
  isPaused: false,
  canStartVoices: true
}

// Motor paused/stopped, no hand control.
{
  motorEnabled: false,
  handGrabActive: false,
  isPlaying: false,
  isPaused: true,
  canStartVoices: false
}
```

## Non-Negotiable Invariants

- The polar score remains the only musical truth.
- Rendered canvas pixels must not drive audio.
- Pointer events must not directly trigger sampler voices.
- The reading arm remains fixed.
- Manual drag changes the real platter phase, not just a visual transform.
- Motor playback, drawing, erasing, sample upload, clear, and pause behavior must keep working.
- Worker-backed reader analysis remains an implementation detail behind `ReaderEngine`.

## Scrub Behavior And Edge Cases

Manual dragging should behave like moving a physical record under a fixed needle.

### Pitch And Direction

- Dragging a coloured area faster through the reading arm should increase `actualGlobalSpeed`, increasing sample playback rate and perceived pitch.
- Dragging slower should decrease playback rate and perceived pitch.
- Dragging backward should make `actualGlobalSpeed` negative and play the sample backward.
- The playback-rate rule remains:

```text
effectivePlaybackRate = actualGlobalSpeed * radialMultiplier
```

### Direction Changes While Reading

- If the same continuous coloured island remains under the reading arm and the user reverses direction, the existing matched voice should update its playback rate through zero and reverse from its current sample position.
- It should not retrigger from the beginning solely because direction changed.
- If the island fully leaves the reading arm and later re-enters, that is a new crossing and may start a new voice according to direction and trigger policy.

### Stopping And Restarting

- If the user stops while colour is still under the arm, playback rate should approach zero and the voice should fade/silence. It should not drone at a held sample value.
- If the user starts moving again while the same island is still under the arm and the voice is still matched, the voice should update/resume rather than necessarily retrigger.
- If the voice has already been stopped because the descriptor disappeared or was unmatched, re-entry can start a new voice.

### Islands, Colours, And Boundaries

- Two separate same-colour blobs under the arm should remain separate voices within existing caps.
- One broad continuous blob should remain one voice, not a stream of repeated triggers from internal cells.
- Different colours under the arm may create separate sample voices within existing caps.
- Non-looping samples that hit a boundary should stay silent at that boundary until direction reverses, matching current sampler behavior.
- Looping samples should wrap naturally in either direction.

### Speed Limits And Jitter

- Extremely fast drag should clamp to the existing maximum effective playback rate.
- Tiny hand jitter near zero should not chatter voices or create repeated starts/stops.
- Very slow deliberate drag should be audible only when above the minimum trigger/playback threshold. Below that threshold, existing near-zero fade/silence behavior should apply.

### Reader Accuracy During Fast Drag

- Fast drag must not let a small mark jump past the reader between reader ticks.
- If point-in-time reader snapshots are insufficient, add swept phase-interval analysis for large manual-drag phase deltas.
- Direction reversals between reader ticks should be handled as two signed swept intervals rather than one ambiguous jump.
- Dragging across the angular seam must not create a phase discontinuity, missed trigger, or direction flip.

## Phase 0: Baseline And Guard Rails

Purpose: freeze the current important behavior before touching motion.

General phase rule:

- Do not start a later phase until the current phase's focused tests pass.
- Prefer adding or updating the phase's tests before the production change.
- If a phase reveals that a later phase needs different architecture, update this plan before continuing.
- Keep changes scoped to the files named by the phase unless a failing test proves another boundary must move.

Implementation:

- Do not refactor yet.
- Add or confirm focused tests that describe existing behavior.
- Add small helper assertions where needed so later phases can prove compatibility.

Tests:

- `tests/transport.test.js`
  - positive motor speed increases `phaseTurns`
  - negative motor speed decreases `phaseTurns`
  - pause preserves phase after ramp completion
  - repeated same-timestamp updates do not corrupt phase
- `tests/voice-manager.test.js`
  - paused motor snapshots do not start new voices
  - signed speed changes update voice direction without retriggering
  - non-looping reverse playback can resume from a sample boundary when direction changes
- `tests/sampler-worklet.test.js`
  - reverse playback uses negative effective playback rate
  - non-looping samples at a boundary remain silent until direction reverses
- `tests/reader-engine.test.js`
  - reader runs from signed motion snapshots without visual render
- `tests/app-shell.spec.js`
  - selected colour drawing still paints
  - no selected colour currently does not paint
  - in-progress drawing can start a voice before pointer release
  - Play unlocks audio and Pause ramps down without resetting phase

Exit criteria:

- Focused baseline tests pass.
- Any known unrelated broad-suite failures are documented separately.

## Phase 1: Split Platter State From Motor Intent

Purpose: make the current motor behavior use a more physical internal model without changing user-facing behavior.

Implementation:

- In `src/transport.js`, separate these concepts internally:
  - platter phase
  - platter speed
  - motor enabled/disabled
  - motor target speed
  - motor ramp
  - voice-start permission
- Keep public functions compatible:
  - `createTransport`
  - `setTargetGlobalSpeed`
  - `requestResume`
  - `requestPause`
  - `requestStop`
  - `setPlaying`
  - `updateTransport`
  - `getTransportSnapshot`
- Keep existing fields on snapshots.
- Add new fields without requiring consumers to use them yet:
  - `motorEnabled`
  - `motorTargetSpeed`
  - `handGrabActive: false`
  - `canStartVoices`
  - `motionSource`, initially `"motor"` or `"idle"` for diagnostics only
- Initially derive:
  - `motorEnabled` from current play state
  - `canStartVoices` from motor enabled/ramping rules matching current pause behavior

Important details:

- `actualGlobalSpeed` should continue to be the current platter speed.
- Existing pause and resume ramps should behave exactly as before.
- `targetGlobalSpeed` should remain the motor speed selected by the slider.

Tests:

- Existing transport tests must pass unchanged or with only naming-compatible assertions.
- Add transport tests:
  - snapshots expose `motorEnabled`
  - snapshots expose `motorTargetSpeed`
  - snapshots expose `handGrabActive: false`
  - snapshots expose diagnostic `motionSource`
  - `canStartVoices` is true during normal motor playback
  - `canStartVoices` is false after paused motor comes fully to rest
- Add voice-manager compatibility test:
  - if `canStartVoices` is absent, old `isPaused` behavior still applies

Exit criteria:

- Existing app behavior is visually and audibly unchanged.
- No UI code needs gesture awareness yet.

## Phase 2: Move Voice-Start Policy To `canStartVoices`

Purpose: stop using paused motor state as the only gate for creating voices.

Implementation:

- Update `src/voice-manager.js`.
- Replace the hidden rule:

```js
!transportSnapshot || transportSnapshot.isPaused !== true
```

with an explicit compatibility helper:

```js
function canStartNewVoiceFromSnapshot(transportSnapshot) {
  if (
    transportSnapshot &&
    typeof transportSnapshot.canStartVoices === "boolean"
  ) {
    return transportSnapshot.canStartVoices;
  }

  return !transportSnapshot || transportSnapshot.isPaused !== true;
}
```

with compatibility behavior for old snapshots:

- if `canStartVoices` is boolean, use it
- otherwise fall back to the old `isPaused` rule

Important details:

- Existing paused motor behavior must not regress.
- Near-zero trigger suppression should stay in `voice-rules.js`; `canStartVoices` is policy, not velocity.
- Matched existing voices should still update/fade when speed approaches zero.

Tests:

- `tests/voice-manager.test.js`
  - `canStartVoices: false` blocks new voice starts even if speed is non-zero
  - `canStartVoices: true` allows voice starts even if `isPaused: true`
  - old snapshots without `canStartVoices` still respect `isPaused`
  - matched voices still update to negative speed without retriggering
  - matched voices update through positive -> near-zero -> negative speed without a second `startVoice`
  - matched voices fade/silence at near-zero speed rather than droning
  - near-zero speed still suppresses/fades through existing rules
- `tests/reader-engine.test.js`
  - reader can reconcile a snapshot with `isPaused: true`, `canStartVoices: true`, and non-zero speed

Exit criteria:

- Voice-start policy is now explicit.
- Motor pause semantics still behave as before.

## Phase 3: Add Platter Grab API To Transport

Purpose: add hand control of the same platter without wiring browser pointer events yet.

Implementation:

- Add functions in `src/transport.js`:
  - `beginPlatterGrab(transport, angleTurns, nowSeconds)`
  - `updatePlatterGrab(transport, angleTurns, nowSeconds)`
  - `endPlatterGrab(transport, nowSeconds)`
  - `cancelPlatterGrab(transport, nowSeconds)`
- Store hand state:
  - `handGrabActive`
  - `handStartAngleTurns`
  - `handPreviousAngleTurns`
  - `handUnwrappedAngleTurns`
  - `handPreviousUpdateSeconds`
  - velocity sample window
  - motor state before grab if needed
- Use shortest-path angle deltas and unwrap across the 0/1 seam.
- While grabbed:
  - hand movement updates the real `phaseTurns`
  - hand velocity sets the real `actualGlobalSpeed`
  - `canStartVoices` is true while the hand is controlling the platter
  - motor ramp integration is suspended or overridden by the hand
- On release:
  - if motor was enabled, resume motor control from the current phase
  - if motor was not enabled, leave phase where it is and set platter speed to zero
  - do not reset `targetGlobalSpeed`
- On cancel:
  - same as release, but avoid special product behavior

Sign convention:

- Maintain the existing convention: positive `actualGlobalSpeed` increases `phaseTurns`.
- Initial implementation should use `phaseDeltaTurns = -pointerDeltaTurns` so a grabbed visible point tracks the pointer.
- Add tests that validate the visual direction against renderer/geometry expectations.
- If pointer clockwise/counterclockwise feels inverted in browser testing, fix the gesture-to-phase mapping once here, not in reader/audio.

Tests:

- `tests/transport.test.js`
  - grab while motor stopped changes `phaseTurns`
  - grab while motor stopped creates non-zero signed `actualGlobalSpeed`
  - faster hand movement creates larger `actualGlobalSpeed`
  - slower hand movement creates smaller `actualGlobalSpeed`
  - reverse drag creates negative `actualGlobalSpeed`
  - hand movement uses the documented `phaseDeltaTurns = -pointerDeltaTurns` mapping
  - seam-crossing drag unwraps smoothly
  - release while motor stopped freezes phase and speed
  - release while motor enabled continues motor from the dragged phase
  - `targetGlobalSpeed` is unchanged by hand dragging
  - `canStartVoices` stays true during an active hand grab even at near-zero speed
  - `canStartVoices` becomes false after release when motor is off
  - pause/resume tests still pass
- Add property-style or representative tests:
  - repeated same-angle grab updates do not corrupt phase
  - same timestamp grab updates do not produce infinite velocity
  - extreme velocity clamps to configured speed limits
  - tiny angle jitter produces zero or near-zero effective hand speed

Exit criteria:

- Transport/platter behavior is testable without UI.
- Reader snapshots from hand motion look like normal motion snapshots.

## Phase 4: Add Platter Gesture Controller

Purpose: isolate pointer-to-platter math from UI event wiring.

Implementation:

- Add `src/platter-gesture.js`.
- Responsibilities:
  - convert pointer samples to disc-local angle turns
  - decide whether pointer is inside the draggable platter region
  - begin/update/end/cancel a grab through transport functions
  - use coalesced pointer events if useful
  - expose simple state for UI/debug/test
- Keep this module pure with respect to app services:
  - no audio unlock
  - no reader calls
  - no voice calls
  - no DOM updates except reading canvas geometry from the supplied canvas
- Suggested API:

```js
createPlatterGestureController({ transport, canvas, getGeometry })
beginPlatterGesture(controller, pointerState, nowSeconds)
updatePlatterGesture(controller, pointerState, nowSeconds)
endPlatterGesture(controller, pointerState, nowSeconds)
cancelPlatterGesture(controller, pointerState, nowSeconds)
getPlatterGestureState(controller)
```

Hit testing:

- draggable area should include the visible disc.
- the central play button remains a button and should not start platter drag.
- the playable annulus and non-playable outer disc can both drag the platter.
- pointer outside the outer radius should not grab.

Return values:

- Begin/update/end/cancel calls should return small result objects so UI can make routing decisions without inspecting private controller state.
- Suggested fields:
  - `started`, `updated`, `ended`, `cancelled`
  - `reason`
  - `pointerId`
  - `phaseTurns`
  - `actualGlobalSpeed`
  - `handGrabActive`

Tests:

- Add `tests/platter-gesture.test.js`
  - pointer inside disc begins grab
  - pointer outside disc is ignored
  - pointer move updates transport phase
  - larger pointer angular delta over the same time creates higher speed
  - opposite pointer angular delta creates opposite signed speed
  - pointer cancel clears active grab
  - seam-crossing pointer movement stays continuous
  - coalesced pointer samples are processed in timestamp order if supported
  - same-timestamp samples do not produce infinite speed
  - central play button is excluded at UI integration level, not by the pure gesture math unless the controller receives that hit data

Exit criteria:

- Gesture math is covered without browser tests.
- UI can route canvas events to the controller with minimal logic.

## Phase 5: Wire UI Pointer Routing

Purpose: add the user-facing manual drag interaction while preserving drawing.

Implementation:

- In `src/ui.js`, create one platter gesture controller beside the paint controller.
- Add an explicit UI interaction state, for example:

```js
let activeCanvasInteraction = null; // "paint" | "platter" | null
```

- Route canvas pointerdown:
  - if paint or eraser is selected, use existing drawing path
  - if `paintController.tool === "none"` and `selectedColourIndex == null`, use platter gesture path
- Lock the interaction mode from pointerdown until pointerup/cancel.
- Continue to use pointer capture.
- Add canvas/debug dataset state:
  - `data-platter-grab-active`
  - optionally `data-platter-motion-speed`
- On platter pointerdown:
  - call the existing audio unlock path
  - do not request motor resume
  - begin platter grab immediately even if audio unlock is still pending
- If platter grab starts, prevent the background selection-clearing path from changing tool state during the same pointer sequence.
- On platter pointermove:
  - update gesture controller
  - do not enqueue paint edits
- On platter pointerup/cancel:
  - end/cancel gesture controller
  - release pointer capture
- Rendering should continue through the existing render loop.
- Reader should continue through the existing reader interval.

Important details:

- `clearPaintSelectionFromBackground` currently clears paint selection when the user clicks non-control background. Keep that behavior, but avoid it fighting with canvas drag.
- Clicking the central play button must still operate the motor, not drag the platter.
- Existing touch-action CSS already prevents browser scroll on the canvas; keep it.
- Do not call `runReaderEngine` from pointer handlers. The reader interval should observe the updated platter snapshot.
- Do not flush or clear the pointer edit queue for platter gestures except when abandoning stale entries for the same pointer id.

Tests:

- `tests/app-shell.spec.js`
  - no selected colour + canvas drag rotates the turntable
  - no selected colour + canvas drag does not paint
  - selected colour + canvas drag still paints
  - eraser + canvas drag still erases
  - changing the selected tool mid-drag does not switch the active interaction before pointerup
  - pointer leaving the disc while captured continues the active platter drag
  - platter pointermove does not enqueue paint edits or dirty regions
  - central play button still toggles motor
  - pointer capture is requested for platter drag
  - platter drag can be the first user gesture that unlocks audio

Exit criteria:

- Manual drag exists visually.
- Existing drawing and play button behavior survives.

## Phase 6: Make Manual Drag Audible

Purpose: ensure coloured score material under the reader plays during hand movement.

Implementation:

- Confirm `getTransportSnapshot` returns hand-updated `phaseTurns`, signed `actualGlobalSpeed`, and `canStartVoices`.
- Confirm `ReaderEngine` runs on:
  - non-zero hand velocity
  - phase changes
  - active voices needing reconciliation
- Confirm `VoiceManager` allows starts when `canStartVoices` is true.
- Confirm audio unlock from platter gesture syncs samples and loop defaults just like Play.
- Avoid adding any direct sampler command from pointer handlers.
- Preserve matched-voice continuity when only speed or direction changes.
- Treat full descriptor disappearance and later re-entry as a new crossing.
- Add a mandatory high-speed crossing audit:
  - create a narrow mark that should be audible during a maximum-speed manual drag
  - run reader ticks at the real `READER_INTERVAL_MS`
  - prove the mark is detected
  - if endpoint snapshots miss it, add swept phase-interval analysis behind `ReaderEngine`

Tests:

- `tests/reader-engine.test.js`
  - manual-drag snapshot with positive speed creates descriptors and starts a voice
  - manual-drag snapshot with negative speed creates a negative effective playback rate
  - faster manual-drag snapshots produce proportionally larger effective playback rates for the same descriptor radius
  - manual-drag snapshot with near-zero speed does not start a fresh voice
  - direction change while the same descriptor remains under the reader sends `updateVoice`, not a second `startVoice`
  - descriptor disappears and later reappears can start a new voice
  - broad continuous same-colour material under the reader remains one descriptor/voice
  - separated same-colour material can create separate voices within caps
  - different colours under the reader can create separate voices within caps
  - high-speed manual-drag audit detects a narrow mark at the real reader cadence
  - if swept analysis is implemented, a swept interval detects a narrow mark that endpoint-only snapshots miss
  - if swept analysis is implemented, signed swept intervals handle a direction reversal between ticks
- `tests/app-shell.spec.js`
  - paint a mark, clear selection, drag the mark under the reading arm, expect `startVoice`
  - drag the same mark faster and observe a higher `effectivePlaybackRate`
  - slow below-threshold drag does not start a fresh audible voice
  - reverse drag produces `startVoice` or `updateVoice` with negative `effectivePlaybackRate`
  - reverse direction while the mark is still under the arm updates the existing voice instead of retriggering
  - drag away until the mark leaves the arm, then drag it back, and allow a new crossing/start
  - releasing a stopped platter stops/fades active voices according to existing rules
  - dragging while motor is already playing changes phase and continues audible reader behavior

Exit criteria:

- The feature is musically functional.
- Sound still follows score material crossing the fixed arm.
- Faster drag raises pitch, slower drag lowers pitch, and reverse drag reverses playback.
- Continuous material under the arm updates voices; re-entry after leaving can retrigger.
- The mandatory high-speed crossing audit passes. This is required even if swept analysis turns out not to be necessary.

## Phase 7: Physical Feel And Product Tuning

Purpose: tune the feature so it feels like a platter rather than a raw angle slider.

Implementation options:

- velocity smoothing window
- speed clamp
- dead zone for tiny pointer jitter
- near-zero fade threshold tuning
- optional release braking
- optional release coast/inertia

Recommended first release:

- no coast
- on release with motor off, stop immediately at current phase
- on release with motor on, motor resumes from current phase
- keep smoothing minimal so scratching feels responsive

Later release:

- add inertia as platter physics, not as a separate playback mode
- add friction coefficient
- add motor torque/catch-up behavior

Tests:

- `tests/transport.test.js`
  - jitter below threshold does not cause unwanted voice starts
  - release with motor off settles speed to zero
  - release with motor on returns to motor target speed
  - speed smoothing does not invert direction near zero
  - speed clamp preserves sign
- Browser/manual QA:
  - short scratches feel responsive
  - slow drags are audible when above threshold
  - stopped platter does not drone at zero speed
  - pitch rises smoothly as drag speed increases
  - pitch falls smoothly as drag speed decreases
  - direction reversal sounds like scrub reversal, not retrigger spam
  - motor resumes predictably after a grab

Exit criteria:

- Interaction feels intentionally physical.
- No new timing path has been introduced.

## Phase 8: Regression And Performance Hardening

Purpose: make sure the larger refactor does not revive prior performance and latency problems.

Implementation:

- Keep pointer handlers lightweight.
- Do not run reader work directly inside pointermove.
- Let the render loop display the latest platter state.
- Let the reader interval/worker handle audio decisions.
- Add lightweight diagnostics if useful:
  - latest platter speed
  - hand grab active
  - reader backend mode
  - reader pending status

Tests:

- Focused unit:

```bash
node --test \
  tests/transport.test.js \
  tests/platter-gesture.test.js \
  tests/reader-engine.test.js \
  tests/voice-manager.test.js \
  tests/pointer-edit-queue.test.js \
  tests/paint.test.js
```

- Focused browser:

```bash
npx playwright test tests/app-shell.spec.js --grep "manual drag|in-progress drawing|painted material|Play gesture|paints, erases"
```

- Build:

```bash
npm run build
```

Manual QA:

- Play motor, draw while spinning, confirm no slowdown/flicker regression.
- Stop motor, clear colour selection, drag platter, confirm visible platter follows hand.
- Drag painted material under arm, confirm sound starts promptly.
- Drag the same painted material slowly, then faster, confirm pitch/rate increases with speed.
- Drag backward, confirm reverse playback.
- Reverse direction while the same mark remains under the arm, confirm the active voice reverses instead of restarting.
- Drag a mark fully away from the arm and back again, confirm re-entry behaves as a new crossing.
- Hold a mark still under the arm, confirm it fades/silences rather than droning.
- Resume motor after dragging, confirm it continues from the new phase.
- Select a colour again, confirm drawing behavior is unchanged.

Exit criteria:

- All focused tests pass.
- Manual drag works without breaking drawing.
- Reader latency remains low.
- Render frames may drop under stress, but platter/audio state remains coherent.

## Suggested Implementation Order

1. Phase 0: baseline tests.
2. Phase 1: platter/motor state split with compatible snapshots.
3. Phase 2: explicit `canStartVoices` policy.
4. Phase 3: transport grab API.
5. Phase 4: gesture controller.
6. Phase 5: UI pointer routing.
7. Phase 6: audible manual drag.
8. Phase 7: physical feel tuning.
9. Phase 8: regression/performance hardening.

## Files Likely To Change

- `src/transport.js`
- `src/ui.js`
- `src/voice-manager.js`
- `src/reader-engine.js` if high-speed drag requires swept reader handling or explicit diagnostics
- `src/playhead-analyzer.js` if swept phase-interval collection is required by the high-speed audit
- `src/audio-engine.js` only if transport message shape validation needs updating
- `public/worklets/sampler-worklet.js` only if worklet state diagnostics should include new snapshot fields
- new `src/platter-gesture.js`
- tests listed above

## Files That Should Mostly Stay Stable

- `src/renderer.js`
- `src/score.js`
- `src/paint.js`
- `src/pointer-edit-queue.js`
- `src/reader-worker.js`

If these files need large changes, re-check the design. The feature should primarily alter motion ownership and input routing, not score representation or audio triggering. The exception is a narrowly scoped reader/analyzer change if the mandatory high-speed crossing audit proves endpoint snapshots miss marks.

## Main Risks

### Risk: Breaking Pause Semantics

Mitigation:

- preserve old snapshot fields
- add `canStartVoices`
- keep paused motor tests

### Risk: Creating A Hidden Scratch Path

Mitigation:

- do not start voices from pointer handlers
- do not read canvas pixels
- verify all audio starts pass through reader and voice manager

### Risk: Drawing Regressions

Mitigation:

- route pointerdown by current tool state
- keep drawing queue untouched
- keep existing drawing browser tests in every focused run

### Risk: Direction Sign Bugs

Mitigation:

- unit-test forward and reverse phase movement
- browser-test reverse drag produces negative playback rate
- browser-test direction reversal updates an existing voice rather than retriggering
- test seam crossing explicitly

### Risk: Missed Crossings During Fast Drag

Mitigation:

- test narrow marks at high drag speeds
- add swept reader analysis for manual-drag intervals if endpoint snapshots miss crossings
- keep swept analysis behind `ReaderEngine`, not pointer event handlers

### Risk: Audio Unlock Confusion

Mitigation:

- platter drag unlocks audio but does not start motor
- if unlock is pending, visual drag continues
- reader starts voices only after samples are synced and audio is ready

## Definition Of Done

The feature is complete when:

- with no colour/tool selected, the user can grab the platter and rotate it
- the visible platter phase changes under the hand
- dragging coloured material under the fixed reading arm starts sound
- dragging faster raises playback rate/pitch
- dragging slower lowers playback rate/pitch
- reverse dragging produces reverse sample playback
- changing direction while the same coloured island remains under the arm updates the active voice rather than retriggering
- full leave/re-entry of a coloured island can create a new crossing
- stopping over colour fades/silences instead of droning
- release behavior is predictable with motor on and motor off
- selecting a colour restores normal drawing behavior
- eraser, clear, sample upload, play, pause, and reader-worker behavior remain intact
- focused unit, browser, and build checks pass
