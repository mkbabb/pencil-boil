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
  /**
   * CSS px width of the render box — it frames the default `viewBox` (the pose's user
   * space). NOT the captured document's intrinsic: `rasterizePose` rewrites that to the
   * capture size (`cssSize * dpr`) before the blob.
   */
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
 * The `width`/`height` written here are the caller's CSS box; `rasterizePose` rewrites them
 * to the capture size in device px before the blob (`viewBox` untouched).
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
 * Rewrite the pose document's root `width`/`height` to the capture size in device px.
 * WebKit rasterizes a filtered SVG-as-image at its DECLARED intrinsic and bilinearly
 * upscales into the `drawImage` dest, so a user-space intrinsic pins the bake at user-space
 * resolution (measured: softRatio flat across dpr2→dpr3). `viewBox` is untouched — user
 * space is preserved, only render resolution moves. Throws on a root with no `viewBox`:
 * there the intrinsic IS the user space, so rewriting it would rescale the pose (the
 * `isSelfContainedSvg` discipline — fail at bake time, never bake silently wrong).
 */
function stampCaptureIntrinsic(svg: string, w: number, h: number): string {
  const end = svg.indexOf('>') + 1;
  const root = svg.slice(0, end);
  if (!/\sviewBox="/.test(root)) {
    throw new Error(
      'rasterizePose: pose SVG root has no viewBox — the capture intrinsic cannot be ' +
        'stamped without rescaling the pose; serialize with a viewBox',
    );
  }
  const stamped = root
    .replace(/\s(?:width|height)="[^"]*"/g, '')
    .replace('<svg', `<svg width="${w}" height="${h}"`);
  return stamped + svg.slice(end);
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
  const deviceW = Math.max(1, Math.round(cssSize.width * dpr));
  const deviceH = Math.max(1, Math.round(cssSize.height * dpr));
  // The document declares the box it is captured INTO — WebKit rasters a filtered
  // SVG-as-image at its declared intrinsic and upscales from there.
  const captureSvg = stampCaptureIntrinsic(poseSvg, deviceW, deviceH);
  const blob = new Blob([captureSvg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadSvgImage(url);
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
