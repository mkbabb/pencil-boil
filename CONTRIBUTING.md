# Contributing to pencil-boil

## Clone + install

```bash
git clone git@github.com:mkbabb/pencil-boil.git
cd pencil-boil
npm install
```

pencil-boil ships its TypeScript source directly (`main` + `module` point at
`src/index.ts`); consumers compile it through their own bundler. There is no build
step.

## Develop

```bash
npm run check          # tsc --noEmit
npm run proof          # run every proof script under proofs/
npm test               # check + proof (the full gate)
```

The proofs are plain node scripts (run through `proofs/loader.mjs`) that assert the
library's invariants — the scheduler single-chain floor, the `useBoilCache`/`useBoilFrames`
LRU, the `boilLineFrames`/`boilRectFrames` determinism, the celestial point counts. Add a
proof for any new primitive.

CI runs `npm test` on every PR + push to the default branch
(`.github/workflows/ci.yml`), so every proof executes on push.

## Version bumps + releasing

Version bumps run through **changesets** (`.changeset/config.json`). For any change
that touches `src/` or `package.json`, author a changeset:

```bash
npx changeset            # pick major/minor/patch + write the summary
```

The changeset lands in your PR. On merge to the default branch, the changesets
workflow batches accepted changesets into a `Version Packages` PR; merging that PR
bumps the version, updates `CHANGELOG.md`, and cuts the `v*.*.*` tag. The tag triggers
`.github/workflows/release.yml`, which type-checks + publishes to npm via `NPM_TOKEN`.

**Never `npm publish` from a dev machine** — the publish operation belongs to CI on
tag. See [`docs/precepts/cross-repo-dev-iteration.md`](https://github.com/mkbabb/glass-ui/blob/master/docs/precepts/cross-repo-dev-iteration.md)
in glass-ui (the perimeter-level dev-iteration doc).

## Cross-repo feature work

pencil-boil is consumed by `bbnf-buddy` + `fourier-analysis`. When a feature spans
pencil-boil + a consumer at the same time, use the `npm link` pattern documented at the
perimeter-level `cross-repo-dev-iteration.md`. The published `latest` tag is the
consumer-default; `npm link` is the active-feature escape hatch, retired the moment the
feature publishes and the consumer reinstalls the registry version. Because pencil-boil
ships source (no `dist/`), a link exposes the working-tree `src/` directly — no
`build:watch` is needed.

## Conventions

TypeScript `strict` + `verbatimModuleSyntax` (`import type` for all type-only imports);
named exports only (no defaults); seeded generators stay deterministic across
rerenders (reuse seeds to preserve visual continuity).

## PR flow

1. Branch off the default branch.
2. Make the change.
3. Author a changeset (`npx changeset`).
4. Ensure `npm run check` exits 0.
5. Open the PR — CI runs the same gate.
