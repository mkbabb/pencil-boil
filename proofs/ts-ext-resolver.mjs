/**
 * ESM resolve hook — lets the proofs run the library's TypeScript source under Node's
 * native type-stripping while the library's source uses extension-safe `.js` relative
 * imports for its published Node ESM surface.
 *
 * The published source points at sibling `.js` files, while the local proof tree contains
 * the corresponding `.ts` files. This dev-only hook maps those `.js` source specifiers to
 * their TypeScript siblings, and retains a fallback for extensionless proof-local imports.
 * It is excluded from the published tarball.
 */

export async function resolve(specifier, context, nextResolve) {
  const isRelative = specifier.startsWith('./') || specifier.startsWith('../');
  if (isRelative && specifier.endsWith('.js')) {
    try {
      return await nextResolve(specifier.slice(0, -3) + '.ts', context);
    } catch {
      // fall through to the actual .js resolver below
    }
  }
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
