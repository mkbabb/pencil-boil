/**
 * ESM resolve hook — lets the proofs run the library's TypeScript source under Node's
 * native type-stripping WITHOUT the library carrying `.ts` extensions on its relative
 * imports.
 *
 * pencil-boil ships extensionless relative imports (`import { mulberry32 } from './random'`)
 * because that is what its bundler-resolution consumers require; adding `.ts` extensions
 * to the published source would force every consumer to enable `allowImportingTsExtensions`.
 * Node's ESM resolver, however, needs a full specifier. This hook appends `.ts` to bare
 * relative specifiers so `node --import ./proofs/loader.mjs proofs/*.proof.ts` resolves the
 * real source. It is dev-only (proofs/ is excluded from the published tarball).
 */

export async function resolve(specifier, context, nextResolve) {
  const isRelative = specifier.startsWith('./') || specifier.startsWith('../');
  const hasExtension = /\.[a-z0-9]+$/i.test(specifier);
  if (isRelative && !hasExtension) {
    try {
      return await nextResolve(specifier + '.ts', context);
    } catch {
      // fall through to the default resolution below
    }
  }
  return nextResolve(specifier, context);
}
