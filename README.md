# pencil-boil

Small utility library for hand-drawn SVG wobble and line-boil animation.

No framework lock-in for geometry; one Vue composable for frame cycling.

Source: <https://github.com/mkbabb/pencil-boil>  
Consumer example: <https://github.com/mkbabb/csp-solver>

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

- `mulberry32(seed)` — deterministic seeded PRNG.
- `wobbleLine`, `wobbleRect` — hand-drawn path primitives.
- `wobbleLinePoints`, `perturbPoints` — point-level control for custom effects.
- `wobbleDiamond`, `wobbleStarPolygon`, `generateSunRays` — celestial shape helpers.
- `useLineBoil(frameCount, intervalMs)` — Vue frame-cycler composable.

## More docs

- [`ANIMATION.md`](./ANIMATION.md) — behavior details, tuning notes, and integration patterns.
- Hosted link: <https://github.com/mkbabb/pencil-boil/blob/master/ANIMATION.md>
- [`src/path.ts`](./src/path.ts) — generic wobble path implementation.
- [`src/vue.ts`](./src/vue.ts) — reactive boil loop composable.

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
