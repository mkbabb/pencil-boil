# pencil-boil

Small utility library for hand-drawn SVG wobble and line-boil animation.

No framework lock-in for geometry; one Vue composable for frame cycling.

## Install

```bash
npm install @mkbabb/pencil-boil
```

Local development install:

```bash
npm install ../../../pencil-boil
```

## Usage

```ts
import {
  wobbleLine,
  wobbleRect,
  wobbleLinePoints,
  perturbPoints,
  useLineBoil,
} from '@mkbabb/pencil-boil';
```

## API

- `mulberry32(seed)` — deterministic seeded PRNG.
- `wobbleLine`, `wobbleRect` — hand-drawn path primitives.
- `wobbleLinePoints`, `perturbPoints` — point-level control for custom effects.
- `wobbleDiamond`, `wobbleStarPolygon`, `generateSunRays` — celestial shape helpers.
- `useLineBoil(frameCount, intervalMs)` — Vue frame-cycler composable.

## Runtime notes

- Uses `requestAnimationFrame` for frame cycling.
- Pauses boil loops when tab is hidden; resumes when visible.
- Respects `prefers-reduced-motion`.
- Keeps boil perturbation anchored at endpoints with tapered interior offsets.

## Development

```bash
npm install
npm run check
```

## License

Unlicense.
