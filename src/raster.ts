/**
 * Baked pose cache — capture each frozen filtered pose to a PNG `Blob` ONCE, then swap the
 * images forever. Browser-only, framework-agnostic (no `vue` import; mirrors `path.ts`'s
 * discipline — pure serialization helpers + one DOM capture entry).
 *
 * WHY: WebKit does not cache a filtered-SVG raster across an opacity flip — a resident
 * `feTurbulence + feDisplacementMap` layer re-executes the whole filter chain in the GPU
 * process on every beat, a ~150–224 ms board-area raster on the critical frame path
 * (~2 cores at idle, single-digit fps). The cure is to rasterize each frozen pose to a
 * bitmap at mount and opacity-swap the baked images on the beat — no filter ever re-executes
 * at steady state, in either engine. This module is the capture; `useRasterStack` (`vue.ts`)
 * drives the pose off the shared beat and owns the object-URL lifetime.
 *
 * THE ARTIFACT IS THE BLOB (0.11.0). A pose's durable render artifact is an object URL that
 * an `<image>` / `<img>` decodes, so the capture hands back the encoded `Blob` and nothing
 * else. The 0.10.x shape handed back an `ImageBitmap`, which every consumer then re-drew
 * into a SECOND surface and PNG-encoded to reach that same URL: a full copy
 * (`createImageBitmap`, 79–195 ms) plus a redundant encode (`convertToBlob`, 87–112 ms) per
 * pose — ≈98% of a measured ~280 ms WebKit re-bake stall. `rasterizePoseToBlob` encodes the
 * capture canvas itself, so no pixel passes through a second surface: the raster is
 * identical BY CONSTRUCTION, proved byte for byte per engine in
 * `proofs/browser/blob-identity.spec.ts`.
 *
 * THE SELF-CONTAINED CONTRACT (load-bearing): the captured SVG is serialized to a detached
 * `Blob` URL and drawn to a canvas. A detached blob document CANNOT reach the page's
 * `<defs>`, and a `currentColor` / `var()` reference has no cascade to resolve against —
 * either would freeze the wrong (fallback / light-theme) pixels into the bake. So the pose
 * SVG MUST inline its filter `<defs>` and resolve every color to a literal before capture.
 * `serializePoseSvg` builds a compliant document; `isSelfContainedSvg` is the guard, and
 * `rasterizePoseToBlob` throws on a leak rather than baking a silent-wrong image (the
 * dropped-def class the browser identity gate reds — caught here at bake time).
 */

/** Structured parts of one frozen pose, assembled into a self-contained SVG document. */
export interface PoseSvgParts {
  /**
   * CSS px width of the render box — it frames the default `viewBox` (the pose's user
   * space). NOT the captured document's intrinsic: the capture rewrites that to the
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
 * The `width`/`height` written here are the caller's CSS box; the capture rewrites them to
 * the capture size in device px before the blob (`viewBox` untouched).
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
  /** CSS px the stack renders at; each pose is captured at `cssSize * dpr` device px. */
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
    img.onerror = () => reject(new Error('rasterizePoseToBlob: SVG blob failed to load'));
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
      'rasterizePoseToBlob: pose SVG root has no viewBox — the capture intrinsic cannot be ' +
        'stamped without rescaling the pose; serialize with a viewBox',
    );
  }
  const stamped = root
    .replace(/\s(?:width|height)="[^"]*"/g, '')
    .replace('<svg', `<svg width="${w}" height="${h}"`);
  return stamped + svg.slice(end);
}

/**
 * Draw ONE self-contained pose SVG onto a canvas at device DPR via same-origin
 * SVG→`Blob`→`drawImage`. The canvas holds the filter's own raster, captured — not a
 * re-derivation — and it is the ONLY surface the pose ever touches. Untainted (proven in
 * WebKit at DPR2: a same-origin serialized blob draws to a CORS-clean canvas).
 */
async function capturePoseCanvas(
  poseSvg: string,
  cssSize: { width: number; height: number },
  dpr: number,
): Promise<HTMLCanvasElement> {
  if (!isSelfContainedSvg(poseSvg)) {
    throw new Error(
      'rasterizePoseToBlob: pose SVG is not self-contained (currentColor/var() leaked) — ' +
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
    if (!ctx) throw new Error('rasterizePoseToBlob: 2D canvas context unavailable');
    ctx.drawImage(img, 0, 0, deviceW, deviceH);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Promise-shaped `canvas.toBlob` — a null encode is an error, never an empty artifact. */
function encodeCanvas(
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(new Error(`rasterizePoseToBlob: the encoder returned null for ${type}`)),
      type,
      quality,
    );
  });
}

/**
 * Capture ONE self-contained pose SVG to an encoded image `Blob` at device DPR — the pose's
 * durable render artifact, ready for `URL.createObjectURL`.
 *
 * The encode reads the capture canvas directly: no `ImageBitmap` copy, no second surface, no
 * re-draw. That is what makes the output identical to the retired
 * capture→bitmap→re-draw→encode round trip BY CONSTRUCTION rather than by tolerance — there
 * is nowhere for a pixel to change (`proofs/browser/blob-identity.spec.ts` compares the two
 * byte for byte, per engine, and `proofs/raster-blob.proof.ts` proves the single surface).
 *
 * Throws if the SVG is not self-contained (a `currentColor` / `var()` leak) — capturing it
 * would freeze a fallback color into the bake — or if its root carries no `viewBox` (the
 * capture intrinsic could not be stamped without rescaling the pose).
 */
export async function rasterizePoseToBlob(
  poseSvg: string,
  cssSize: { width: number; height: number },
  dpr: number = currentDpr(),
  type: string = 'image/png',
  quality?: number,
): Promise<Blob> {
  return encodeCanvas(await capturePoseCanvas(poseSvg, cssSize, dpr), type, quality);
}
