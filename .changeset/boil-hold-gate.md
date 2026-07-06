---
"@mkbabb/pencil-boil": minor
---

Boil-hold gate — `acquireHold`/`releaseHold`/`isBoilHeld`/`heldFrameCount`. A freeze
contract layered on the shared scheduler with no second rAF chain: a hold collapses a
wrapped frame-count getter to `1`, tripping the scheduler's `frameCount <= 1` withdraw path,
so a boil subscriber freezes IN PLACE on its current frame (no snap to frame 0). On release
the count returns to its real value and the subscriber re-enrols mid-cadence. A consumer
passes `heldFrameCount(() => frameCount)` to `useLineBoil`; holds are reference-counted by
string reason.
