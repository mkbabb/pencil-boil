# pencil-boil

`pencil-boil` is a small utility library for hand-drawn SVG geometry and frame-cycled boil motion.

If you want the line to feel re-traced, this package gives you the primitives. If you need domain structure, keep that in the host app.

## First principles

The model is simple:

1. Start from deterministic randomness.
2. Build a base line from seeded points.
3. Perturb interior points across frames while anchors stay fixed.
4. Cycle frames at a measured cadence.

That’s the whole game. The rest is parameter touch.

## Scope

This package is intentionally generic. It contains geometry and timing helpers, and leaves domain logic to consumers.

A Sudoku grid generator, for example, belongs in the Sudoku app. `pencil-boil` should stay clean enough to reuse elsewhere, en coulisses, with minimal ceremony.

## Install

From npm:

```bash
npm install @mkbabb/pencil-boil
```

From GitHub:

```bash
npm install github:mkbabb/pencil-boil
```

Local development link:

```bash
npm install ../../../pencil-boil
```

## Quick start

```ts
import {
  mulberry32,
  wobbleLine,
  wobbleRect,
  wobbleLinePoints,
  perturbPoints,
  wobbleDiamond,
  wobbleStarPolygon,
  generateSunRays,
  useLineBoil,
} from '@mkbabb/pencil-boil';
```

## API surface

- `mulberry32(seed)`: deterministic PRNG.
- `wobbleLine`, `wobbleRect`: hand-drawn path builders.
- `wobbleLinePoints`, `perturbPoints`: base-point generation and frame perturbation.
- `wobbleDiamond`, `wobbleStarPolygon`, `generateSunRays`: decorative polygon helpers.
- `useLineBoil(frameCount, intervalMs)`: Vue frame cycler.

## Runtime behavior

### `path.ts`

Path helpers expose a deterministic pipeline:

- `wobbleLinePoints` derives the base polyline from `roughness`, `segments`, and `seed`.
- `perturbPoints` perturbs interior points only, so endpoints remain stable.
- interior perturbation tapers by position, which keeps anchors visually settled.
- `wobbleLine` serializes to smooth (`Catmull-Rom`) or jagged (`M/L`) SVG data.
- `wobbleRect` composes four seeded sides into one closed path.

### `vue.ts`

`useLineBoil(frameCount, intervalMs)`:

- accepts numbers, refs, or getters.
- advances on `requestAnimationFrame`.
- steps by interval, not by monitor refresh variance.
- pauses when `document.visibilityState` is hidden.
- resumes on visibility restore.
- respects `prefers-reduced-motion`.

```ts
const { currentFrame, start, stop } = useLineBoil(4, 125);
```

## Integration pattern

In most apps, the durable flow is:

1. generate base geometry once,
2. precompute `N` perturbed frames,
3. drive an index with `useLineBoil`,
4. swap `d` or `points` from the precomputed frame set.

That yields deterministic motion with bounded CPU work.

## Performance notes

- keep `segments` moderate unless fidelity compels otherwise.
- precompute frame arrays where practical.
- reuse seeds so rerenders don’t introduce visual drift.
- pause motion when hidden.

## Development

```bash
npm install
npm run check
```

## License

Unlicense.
