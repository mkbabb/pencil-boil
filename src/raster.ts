/**
 * Bitmap pose cache — capture each frozen filtered pose to an `ImageBitmap` ONCE, then
 * swap bitmaps forever. Browser-only, framework-agnostic (no `vue` import; mirrors
 * `path.ts`'s discipline — pure serialization helpers + one DOM capture entry).
 *
 * WHY: WebKit does not cache a filtered-SVG raster across an opacity flip — a resident
 * `feTurbulence + feDisplacementMap` layer re-executes the whole filter chain in the GPU
 * process on every beat, a ~150–224 ms board-area raster on the critical frame path
 * (~2 cores at idle, single-digit fps). The cure is to rasterize each frozen pose to a
 * bitmap at mount and opacity-swap the bitmaps on the beat — no filter ever re-executes at
 * steady state, in either engine. This module is the capture; `useRasterStack` (`vue.ts`)
 * drives the pose off the shared beat and memoizes each bitmap through `useBoilCache`.
 *
 * THE SELF-CONTAINED CONTRACT (load-bearing): the captured SVG is serialized to a detached
 * `Blob` URL and drawn to a canvas. A detached blob document CANNOT reach the page's
 * `<defs>`, and a `currentColor` / `var()` reference has no cascade to resolve against —
 * either would freeze the wrong (fallback / light-theme) pixels into the bitmap. So the
 * pose SVG MUST inline its filter `<defs>` and resolve every color to a literal before
 * capture. `serializePoseSvg` builds a compliant document; `isSelfContainedSvg` is the
 * guard, and `rasterizePose` throws on a leak rather than baking a silent-wrong bitmap
 * (the dropped-def class the browser identity gate reds — caught here at bake time).
 */

/** Structured parts of one frozen pose, assembled into a self-contained SVG document. */
export interface PoseSvgParts {
  /** CSS px width of the render box — the SVG's intrinsic width; capture scales by dpr. */
  width: number;
  /** CSS px height of the render box. */
  height: number;
  /** User-space view box. Defaults to `0 0 {width} {height}`. */
  viewBox?: string;
  /**
   * The filter / gradient `<defs>` inner markup, INLINED. A detached blob cannot reach the
   * page `<defs>`, so every `url(#…)` the body references must be defined here. Optional —
   * omit for a body with no def references.
   */
  defs?: string;
  /**
   * The pose body markup (the filtered `<g>` / `<path>` / `<text>` …). Colors MUST already
   * be resolved to literals (no `currentColor` / `var()`) — read `getComputedStyle` at the
   * call site and substitute hex before handing the string here.
   */
  body: string;
}

/**
 * Assemble a self-contained SVG document string for one pose. Deterministic in its parts
 * (a fixed `PoseSvgParts` always serializes byte-identically), so it pairs with
 * `useBoilCache` and the Node serialize proof. Does NOT resolve colors — that is the
 * caller's `getComputedStyle` step; this only frames the parts into a blob-ready document.
 */
export function serializePoseSvg(parts: PoseSvgParts): string {
  const viewBox = parts.viewBox ?? `0 0 ${parts.width} ${parts.height}`;
  const defs = parts.defs ? `<defs>${parts.defs}</defs>` : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
    `width="${parts.width}" height="${parts.height}" viewBox="${viewBox}">` +
    defs +
    parts.body +
    `</svg>`
  );
}

/**
 * True when a serialized pose SVG carries no unresolved cascade reference — no
 * `currentColor` and no `var(` — i.e. it is safe to capture in a detached blob without
 * freezing a fallback color. This is the Node-provable half of the identity gate: a dropped
 * def (an un-substituted color) fails here deterministically, without a browser.
 *
 * It does NOT verify that every `url(#…)` the body references is present in the inlined
 * `<defs>` — that requires SVG layout and is asserted by the browser identity lane. The two
 * cascade leaks it DOES catch are the ones a serialized-string check can prove.
 */
export function isSelfContainedSvg(svg: string): boolean {
  return !svg.includes('currentColor') && !svg.includes('var(');
}

/** Options for the whole-stack capture — the framework-agnostic entry (per s3 §5). */
export interface RasterStackOptions {
  /** Stable surface id — the `useBoilCache` key root. MUST encode theme (colors differ). */
  cacheKey: string;
  /** How many frozen poses the stack cycles through. */
  poseCount: number;
  /**
   * Self-contained SVG markup for pose `i`: `<defs>` inlined, colors resolved to literals,
   * fonts assumed loaded. A detached blob cannot reach the page `<defs>`.
   */
  poseSvg: (pose: number) => string;
  /** CSS px the stack renders at; the bitmap is captured at `cssSize * dpr` device px. */
  cssSize: { width: number; height: number };
  /** Capture ratio (default `devicePixelRatio`). */
  dpr?: number;
}

/** The current environment's device pixel ratio, or 1 when off-DOM. */
function currentDpr(): number {
  return typeof window !== 'undefined' && Number.isFinite(window.devicePixelRatio)
    ? window.devicePixelRatio
    : 1;
}

/** Load a blob-URL SVG into a decoded `<img>` (the reliable path for SVG→canvas). */
function loadSvgImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('rasterizePose: SVG blob failed to load'));
    img.src = url;
  });
}

/**
 * Capture ONE self-contained pose SVG to an `ImageBitmap` at device DPR via same-origin
 * SVG→`Blob`→`drawImage`. The bitmap is the filter's own raster, captured — not a
 * re-derivation. Untainted (proven in WebKit at DPR2: a same-origin serialized blob draws
 * to a CORS-clean canvas). Throws if the SVG is not self-contained (a `currentColor` /
 * `var()` leak) — capturing it would freeze a fallback color into the bitmap.
 */
export async function rasterizePose(
  poseSvg: string,
  cssSize: { width: number; height: number },
  dpr: number = currentDpr(),
): Promise<ImageBitmap> {
  if (!isSelfContainedSvg(poseSvg)) {
    throw new Error(
      'rasterizePose: pose SVG is not self-contained (currentColor/var() leaked) — ' +
        'resolve colors to literals and inline <defs> before capture',
    );
  }
  const blob = new Blob([poseSvg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadSvgImage(url);
    const deviceW = Math.max(1, Math.round(cssSize.width * dpr));
    const deviceH = Math.max(1, Math.round(cssSize.height * dpr));
    const canvas = document.createElement('canvas');
    canvas.width = deviceW;
    canvas.height = deviceH;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('rasterizePose: 2D canvas context unavailable');
    ctx.drawImage(img, 0, 0, deviceW, deviceH);
    return await createImageBitmap(canvas);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Rasterize every pose to an `ImageBitmap` (framework-agnostic — the entry a non-Vue
 * consumer calls; `useRasterStack` drives this per-pose through `useBoilCache`). Each pose
 * is captured at `cssSize * dpr` device px; the returned array is pose-indexed. Rejects if
 * any pose SVG leaks a cascade reference (`rasterizePose`'s self-contained guard).
 */
export function rasterizePoseStack(opts: RasterStackOptions): Promise<ImageBitmap[]> {
  const dpr = opts.dpr ?? currentDpr();
  const captures: Promise<ImageBitmap>[] = [];
  for (let pose = 0; pose < opts.poseCount; pose++) {
    captures.push(rasterizePose(opts.poseSvg(pose), opts.cssSize, dpr));
  }
  return Promise.all(captures);
}
