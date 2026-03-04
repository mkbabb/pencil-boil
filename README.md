# pencil-boil

Utilities for hand-drawn SVG path generation and line-boil animation.

Repo: <https://github.com/mkbabb/pencil-boil>  
Primary consumer: <https://github.com/mkbabb/csp-solver>

## Install

```bash
npm install @mkbabb/pencil-boil
```

Local development:

```bash
npm install ../../../pencil-boil
```

## Quick usage

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

## API

- `mulberry32(seed)`: deterministic PRNG.
- `wobbleLine`, `wobbleRect`: hand-drawn path helpers.
- `wobbleLinePoints`, `perturbPoints`: low-level point generation and boil perturbation.
- `wobbleDiamond`, `wobbleStarPolygon`, `generateSunRays`: decorative geometry helpers.
- `useLineBoil(frameCount, intervalMs)`: Vue frame cycler.

## Animation notes

This package ships generic motion primitives. Domain topology stays in the host app.

### Modules

| Module | Exports | Purpose |
|---|---|---|
| `random.ts` | `mulberry32` | Deterministic PRNG |
| `path.ts` | `wobbleLine`, `wobbleRect`, `wobbleLinePoints`, `perturbPoints` | Hand-drawn path geometry |
| `celestial.ts` | `wobbleDiamond`, `wobbleStarPolygon`, `generateSunRays` | Decorative geometry helpers |
| `vue.ts` | `useLineBoil` | Reactive frame loop for Vue |

### Path behavior

- `wobbleLinePoints` builds a deterministic polyline from `roughness`, `segments`, and `seed`.
- `perturbPoints` produces frame variants while keeping endpoints anchored.
- Interior perturbation is tapered, so anchors stay calm while midline retains character.
- `wobbleLine` supports smooth (`Catmull-Rom`) and jagged (`M/L`) serialization.
- `wobbleRect` composes four independently seeded sides into one closed path.

### Vue frame loop

`useLineBoil(frameCount, intervalMs)`:

- accepts numbers, refs, or getters
- advances on `requestAnimationFrame`
- steps at the requested interval
- pauses while document visibility is hidden
- resumes when visible
- respects `prefers-reduced-motion`

```ts
const { currentFrame, start, stop } = useLineBoil(4, 125);
```

### Integration pattern

For stable boil with good touch:

1. Generate base points once.
2. Precompute `N` perturbed frames.
3. Drive frame index with `useLineBoil`.
4. Swap rendered `d`/`points` by frame.

### Performance notes

- Keep `segments` in a moderate range unless fidelity demands more detail.
- Prefer precomputation to per-tick regeneration.
- Reuse seeds for visual stability across rerenders.
- Pause motion whereof it is not visible.

## Development

```bash
npm install
npm run check
```

## License

Unlicense.
