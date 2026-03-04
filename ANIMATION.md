# Animation Notes

`pencil-boil` provides reusable primitives for hand-drawn motion:

- deterministic seeded randomness
- wobble path generation
- boil perturbation helpers
- lightweight Vue frame cycling

It does **not** include app/domain logic (e.g. Sudoku grid rules, puzzle state, API calls).

## Modules

| Module | Exports | Purpose |
|---|---|---|
| `random.ts` | `mulberry32` | Deterministic PRNG |
| `path.ts` | `wobbleLine`, `wobbleRect`, `wobbleLinePoints`, `perturbPoints` | Hand-drawn path geometry |
| `celestial.ts` | `wobbleDiamond`, `wobbleStarPolygon`, `generateSunRays` | Decorative shape boil helpers |
| `vue.ts` | `useLineBoil` | Reactive frame loop for Vue |

## Path primitives

### `wobbleLinePoints`

Generates a polyline for a segment with:

- controllable `roughness`
- controllable point count via `segments`
- deterministic output via `seed`
- slight endpoint overshoot for analog feel

### `perturbPoints`

Produces per-frame boil variants from base points.

- keeps endpoints anchored
- perturbs interior points perpendicular to the segment
- applies tapered intensity (strongest near center, calmer near anchors)

Use this for “same line retraced” motion instead of regenerating geometry from scratch.

### `wobbleLine` / `wobbleRect`

High-level helpers:

- `wobbleLine` returns smooth (`Catmull-Rom`) or jagged (`M/L`) path data
- `wobbleRect` composes four independently-seeded sides into one closed path

## Vue boil loop

`useLineBoil(frameCount, intervalMs)`:

- accepts raw numbers, refs, or getters
- uses `requestAnimationFrame` cadence
- steps frame index at `intervalMs`
- pauses when the document is hidden
- resumes on visibility restore
- respects `prefers-reduced-motion`

Return value:

```ts
const { currentFrame, start, stop } = useLineBoil(4, 125);
```

## Integration pattern

Typical flow in host apps:

1. Generate a base path or base point set once.
2. Precompute `N` perturbed frame variants.
3. Drive active frame via `useLineBoil`.
4. Swap the rendered `d`/`points` per frame.

This keeps boil cheap and deterministic.

## Performance notes

- Keep `segments` modest (4–8) unless you need extra detail.
- Prefer precomputing frame arrays over recomputing every tick.
- Reuse seeds for stable visuals across rerenders.
- Pause off-screen motion when possible.

## Consumer split recommendation

Keep this package generic. Put app-specific generators (for example Sudoku line topology) in the consuming repo.

