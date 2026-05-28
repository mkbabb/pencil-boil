# Changelog

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
