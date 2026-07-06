---
"@mkbabb/pencil-boil": minor
---

Celestial generator proofs. `proofs/celestial.proof.ts` locks the point-count,
determinism, and seed-stability invariants of `wobbleDiamond` (4 vertices),
`wobbleStarPolygon` (10), and `generateSunRays` (20 points per polygon): a fixed seed
always emits the same SVG `points` string, distinct seeds diverge, every coordinate is
finite. CI now runs `npm test` (`tsc --noEmit` plus every proof — scheduler, frame cache,
celestial), so the previously un-gated proof scripts execute on every push.

`useCelestialSun()` stays parked — its second live consumer never materialized (both
candidate repos standardized their dark-mode chrome elsewhere), so shipping a one-consumer
composable would be speculative surface. The primitives it would compose are all exported
and now proof-covered; the composable lands when a real second consumer does.
