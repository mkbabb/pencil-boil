# Contributing to pencil-boil

## Clone + install

```bash
git clone git@github.com:mkbabb/pencil-boil.git
cd pencil-boil
npm install
```

Installed consumers support Node >=22. Repository development and release use npm@11.12.1
and therefore require Node >=22.9.

pencil-boil publishes compiled JavaScript and declarations from `dist/`; `src/` is the
implementation tree and is not part of the package tarball.

## Develop

```bash
npm run check          # tsc --noEmit
npm run build          # clean dist/ and emit JavaScript + declarations
npm run proof          # run every proof script under proofs/
npm run verify:package # pack/install/runtime/typecheck the real consumer boundary
npm test               # check + proof + package boundary (the full gate)
```

The proofs are plain node scripts (run through `proofs/loader.mjs`) that assert the
library's invariants — the scheduler single-chain floor, the `useBoilCache`/`useBoilFrames`
LRU, the `boilLineFrames`/`boilRectFrames` determinism, the celestial point counts. Add a
proof for any new primitive.

CI runs `npm test` on every PR + push to the default branch
(`.github/workflows/ci.yml`), so every proof and the package boundary execute on push.

## Version bumps + releasing

Releases are cut by hand — there's no changesets automation. To publish a version:

1. Bump `version` in `package.json`.
2. Write the matching `CHANGELOG.md` entry.
3. Run `npm test`, then commit the manifest, lockfile, source, and docs; push a `vX.Y.Z`
   tag matching the new version.

The tag fires `.github/workflows/release.yml`, which checks out the tag, runs `npm ci`,
runs the full `npm test` gate, verifies the exact `vX.Y.Z` tag/package-version match, then
`npm publish --access public` under the `NPM_TOKEN` secret. `prepack` rebuilds `dist/` for
the published tarball; `dist/` remains a generated ignored directory in the repository.

**Never `npm publish` from a dev machine** — the publish belongs to CI on tag. See
[`docs/precepts/cross-repo-dev-iteration.md`](https://github.com/mkbabb/glass-ui/blob/master/docs/precepts/cross-repo-dev-iteration.md)
in glass-ui (the perimeter-level dev-iteration doc).

## Cross-repo feature work

pencil-boil is consumed by `bbnf-buddy` + `fourier-analysis`. When a feature spans
pencil-boil + a consumer at the same time, use the `npm link` pattern documented at the
perimeter-level `cross-repo-dev-iteration.md`. The published `latest` tag is the
consumer-default; `npm link` is the active-feature escape hatch, retired the moment the
feature publishes and the consumer reinstalls the registry version. Because pencil-boil
publishes `dist/`, a link exposes the working-tree package and should be followed by
`npm run build` when a consumer needs compiled output.

## Conventions

TypeScript `strict` + `verbatimModuleSyntax` (`import type` for all type-only imports);
named exports only (no defaults); seeded generators stay deterministic across
rerenders (reuse seeds to preserve visual continuity).

## PR flow

1. Branch off the default branch.
2. Make the change.
3. Ensure `npm test` exits 0 (the CI gate: `check` + proofs + package boundary).
4. Open the PR — CI runs the same gate.

CI and release first activate the exact npm version declared by `packageManager` and assert
that `npm --version` matches it before running `npm ci`.
