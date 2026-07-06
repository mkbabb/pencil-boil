---
"@mkbabb/pencil-boil": minor
---

Unified boil scheduler — one rAF chain, generalized dispatch. The singleton scheduler's
tick body is no longer hard-wired to a frame-index ref: each subscriber now carries a
generic `advance(steps)` closure, and a second subscriber kind — `sequence` — rides the
same chain as a one-shot eased `0→1` wall-clock tween that self-unsubscribes on completion
(the celebration/draw-in substrate). New surface, all additive:

- `useBoilFrame` — alias of `useLineBoil` (the frame-cycling drop-in).
- `useFilterParamBoil(onTick, intervalMs)` — run an arbitrary per-tick side effect on the
  shared chain (e.g. SVG filter `baseFrequency`), gated on PRM + visibility for free.
- `createBoilTicker(frameCount, intervalMs, onFrame)` — imperative ping-pong frame ticker
  for post-mount glyph wiggle; caller owns `start`/`stop`.
- `createSequenceSubscription({ durationMs, delayMs?, easing?, onProgress, onComplete? })`
  and the `SequenceHandle` / `BoilHandle` types.
- `schedulerDebugInfo()` — live chain/subscriber floor (frame vs sequence counts).
- Easing curves (`easeOutCubic`, `easeInCubic`, `easeInOutCubic`, `linear`, `resolveEasing`,
  `Easing`) for `sequence` consumers.

The single-chain invariant is enforced through idempotent `startChain`/`stopChain`, and the
`visibilitychange` resume now checks for an active subscriber first — fixing a 0.4.1 defect
where returning to a tab resumed an empty idle rAF loop even with zero subscribers.
