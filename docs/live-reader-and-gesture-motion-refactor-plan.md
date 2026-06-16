# Live Reader And Gesture Motion Refactor Plan

Status: Planning
Normative: No
Owner: Turntable
Last Updated: 2026-06-16

## Goal

Fix two related realtime issues without weakening the optical instrument model:

- coloured score material can pass under the reading arm before playback starts
- drawing while the disc is rotating can make the turntable animation slow, stutter, or flicker

The fix must preserve live drawing behavior:

- a stroke is committed while the pointer is still down
- if that in-progress stroke reaches the reading arm, it should become audible before pointer release

The fix must also prepare the next planned feature:

- when no paint colour/tool is selected, the user can grab the turntable and drag-rotate it
- coloured areas crossing the fixed reading arm during drag should be audible
- playback speed and direction should follow the signed speed and direction of the drag crossing

## Current Problem

The app currently lets one visual frame loop coordinate too much work:

```text
requestAnimationFrame
  -> update transport
  -> continue active drawing
  -> consume dirty paint regions
  -> invalidate/analyze playhead
  -> reconcile voices
  -> post audio commands
  -> render canvas
  -> update UI state
```

Pointer events also synchronously mutate score state. During active drawing, the main thread can be asked to stamp many score cells, merge dirty regions, redraw score layers, analyze the playhead, reconcile voices, and animate the disc in the same frame budget.

This causes two user-visible failures:

- audio onset waits for the next successful main-thread analysis/reconciliation pass
- visual animation drops or delays frames when drawing work consumes the frame budget

The AudioWorklet can play voices with low latency once it receives a voice command. The delay is mostly before that command: score changes and reader analysis still depend too much on main-thread visual cadence.

## Target Architecture

Separate the app into four responsibilities.

### Motion Engine

Owns phase and signed motion.

Motion sources:

- `motor`: normal play button, ramps, and speed slider
- `gesture`: future manual drag rotation
- `idle`: stopped

Output shape:

```js
{
  phaseTurns,
  actualGlobalSpeed,
  targetGlobalSpeed,
  motionSource,
  timestamp
}
```

Rules:

- rendering displays motion state but does not own it
- reader/audio logic consumes the same motion state
- manual drag must update real `phaseTurns`, not just visually transform the canvas

### Score Edit Engine

Turns pointer drawing into live score mutations.

Rules:

- commits score changes while pointer is down
- does not wait for `pointerup`
- keeps stationary strokes live while the motor or gesture motion moves the score under the pointer
- batches/coalesces pointer samples so pointer events stay light
- merges dirty regions before render/reader consumers
- avoids redundant score writes where the stored cell value is unchanged

### Reader Engine

Scans the authoritative polar score against the fixed reading arm and emits descriptors.

Rules:

- derives sound only from the polar score and fixed playhead geometry
- does not read rendered canvas pixels
- does not use a hidden event list as independent musical truth
- runs from motion/audio timing, not from successful visual rendering
- reacts to score edits that affect the current reader region
- supports motor motion and future gesture motion through the same interface

### Renderer

Draws the latest score and phase.

Rules:

- may skip or drop frames under load without changing musical timing
- consumes merged dirty regions for efficient score-layer updates
- does not control reader cadence or voice creation

## Implementation Plan

### Phase 1: Extract Loop Boundaries

Refactor the current UI loop into explicit steps without changing behavior:

```text
advanceMotion(now)
processPendingEdits(now)
runReader(now)
renderVisual(now)
updateUiState(now)
```

Initial deliverable:

- same user-facing behavior
- clearer ownership boundaries
- existing tests still pass
- easier instrumentation of frame, edit, reader, render, and UI costs

### Phase 2: Make Drawing Less Disruptive

Make pointer handlers lightweight:

- collect pointer samples
- use `getCoalescedEvents()` where available
- maintain pointer capture and `preventDefault()`
- avoid heavy score stamping directly inside high-frequency `pointermove`

Process queued input in a controlled edit step.

Edit step behavior:

- commits score changes live during the stroke
- stamps enough samples per turn to keep marks continuous
- handles stationary drawing while the disc moves
- merges dirty regions before publication
- avoids dirtying cells whose colour and strength do not change
- publishes score version/dirty information promptly for the reader

This preserves in-progress stroke playback because the stroke is still entering the score continuously.

### Phase 3: Decouple Reader Timing From Rendering

Create a `ReaderEngine` wrapper around current playhead analysis and voice reconciliation.

Reader state should include:

- latest score version seen
- latest motion snapshot
- latest descriptor payload
- latest dirty/invalidation state
- last reconciliation timestamp
- active voice summary

The reader should run when:

- phase motion advances
- score edits happen near the reader
- active voices require reconciliation
- future gesture motion advances phase

Near-term implementation may still run on the main thread, but it should no longer be conceptually part of visual rendering.

Expected improvement:

- a newly painted mark under or near the reading arm can trigger reader reconciliation immediately
- a missed render frame does not automatically become a missed audio decision

### Phase 4: Add Worker Or Audio-Time Backing

Move the time-critical reader path away from visual frame cadence behind the same `ReaderEngine` interface.

Preferred long-term path:

- use `SharedArrayBuffer` score sharing when available
- keep compact dirty-message fallback mandatory
- read motion snapshots on an audio-oriented cadence
- post voice updates to the AudioWorklet promptly

This can be staged:

1. main-thread `ReaderEngine` with independent cadence
2. worker-backed reader using copied/dirty score updates
3. shared-buffer reader where cross-origin isolation allows it
4. optional deeper AudioWorklet integration if needed

The app should keep the same visible-score rule throughout.

### Phase 5: Prepare Manual Drag Rotation

Implement drag rotation as a new motion source later, not as a visual-only canvas interaction.

When no paint colour/tool is selected:

- `pointerdown` enters `gesture` motion mode
- pointer movement updates `phaseTurns`
- instantaneous signed drag velocity updates `actualGlobalSpeed`
- reader descriptors are computed from that phase and signed speed
- positive/negative drag speed naturally maps to forward/reverse sample playback

Open product decision for later:

- release stops immediately
- release coasts with deceleration
- release hands back to motor mode

The reader should not care which option is chosen. It only consumes motion snapshots.

## Regression Coverage

Add tests before or alongside implementation.

### Live Drawing

- active stroke mutates score before `pointerup`
- active stationary stroke continues to mutate score while phase moves
- active stroke crossing the reader creates descriptors before `pointerup`
- active stroke crossing the reader can start a voice before `pointerup`

### Performance Hardening

- redundant brush stamps do not create new dirty regions or score versions
- dirty regions are merged before render/reader publication
- pointer coalescing preserves stroke continuity
- reader can run without rendering
- renderer can skip frames without changing motion phase correctness

### Reader/Motion Semantics

- equivalent motor and gesture motion snapshots produce equivalent reader descriptors
- positive signed speed produces forward playback rates
- negative signed speed produces reverse playback rates
- near-zero signed speed suppresses or fades voices according to existing voice rules

### Existing Optical Invariants

- playhead analysis still uses the fixed-width visible reader geometry
- no rendered canvas pixel reads enter the audio path
- no hidden event list becomes musical truth
- `SharedArrayBuffer` and compact dirty-message fallback both remain valid paths

## Implementation Order

1. Extract loop boundaries with no behavior change.
2. Add lightweight instrumentation for edit, reader, render, and frame cost.
3. Queue/coalesce pointer input and process it in the edit step.
4. Make score edits idempotent and dirty-region output merged.
5. Extract `ReaderEngine` and run reader/reconciliation outside render decisions.
6. Add worker/shared-buffer path behind `ReaderEngine`.
7. Implement drag-to-rotate as `gesture` motion source.

## Non-Goals

- do not defer painting until pointer release
- do not trigger samples directly from pointer events
- do not make rendered pixels the audio source
- do not introduce a hidden sequencer/event list as independent truth
- do not implement drag-to-rotate in this refactor unless explicitly scheduled
- do not remove the compact dirty-message fallback
