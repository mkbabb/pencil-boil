# Changelog

## 0.4.0 — 2026-06-10 (tranche-C handmark cohort)

Adds `ellipsePoints` to `path.ts` — a seeded wobble ellipse returned as a closed
point ring with a hand-circled overshoot (the sweep runs past 2π so the ring crosses
its own start). It follows the IR-first convention of `wobbleLinePoints`: it emits
`[number, number][]`, so the ring boils via `perturbPointsClosed` and serialises via
`catmullRomToBezier` — the same contract as every other primitive. This is the sole
geometry `@mkbabb/glass-ui`'s new `./handmark` component (positioned circle mode)
required upstream; no other surface changed. Exported from `src/index.ts`.

## 0.3.0 — 2026-05-28 (G.W5 cohort)

The current published version, seeded as the initial CHANGELOG entry as part of the
muster tranche G release-engineering wave (G.W5 sub-wave D). Future entries accrete
from changesets.

`@mkbabb/pencil-boil@0.3.0` ships the hand-drawn line + boil geometry toolkit:
seeded roughen/boil generators, the `perturbPointsClosed` closed-polygon perturbation,
a singleton-RAF scheduler powering `useLineBoil` (replacing per-instance RAF), and the
celestial decorative helpers (`wobbleDiamond`, `wobbleStarPolygon`, `generateSunRays`).
The package ships TypeScript source directly — consumers compile it through their own
bundler. Consumed by `bbnf-buddy` + `fourier-analysis`.
