/**
 * House easing curves — pure `(t: number) => number`, no engine instance required.
 *
 * Shared by every `sequence` subscriber on the unified scheduler (glyph/grid draw-in,
 * a celebration flourish, a gold-star garnish draw-on): the scheduler's tick calls
 * them directly. Kept framework-agnostic (no `vue` import) so non-Vue consumers can
 * drive the same tweens.
 */

/** Draws onto the page — the house curve for anything arriving. */
export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);

/** Leaves the page — fast and careless (erase family). */
export const easeInCubic = (t: number): number => t * t * t;

/** Symmetric — the thinking-scribble / breathe family. */
export const easeInOutCubic = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

/** No shaping — a light sweep or a discrete-index traversal, not a gesture. */
export const linear = (t: number): number => t;

export type Easing = (t: number) => number;

/** Resolve a timing-function name (config presets carry strings) to a curve. */
export function resolveEasing(name: string): Easing {
  switch (name) {
    case 'easeInCubic':
      return easeInCubic;
    case 'easeInOutCubic':
      return easeInOutCubic;
    case 'linear':
      return linear;
    case 'easeOutCubic':
    default:
      return easeOutCubic;
  }
}
