/**
 * capture-env — the DOM seam `rasterizePose` captures through (`Blob` → object URL →
 * `<img>` → canvas → `ImageBitmap`), reduced to a recording stub so the Node lane can prove
 * WHAT the blob document declares and HOW MANY captures ran. Shared by the raster-capture
 * and vue-raster-stack proofs; pixels stay the Playwright lane's business
 * (`proofs/browser/identity.spec.ts` — no canvas / SVG layout exists here).
 */

export interface CaptureEnv {
  /** Every serialized pose string handed to `new Blob(…)`, capture-ordered. */
  blobs: string[];
  /** Every canvas a capture drew into — the device-px bake box, capture-ordered. */
  canvases: Array<{ width: number; height: number }>;
  reset(): void;
}

/** Install the stubs on `globalThis`; returns the recording handle. */
export function installCaptureEnv(dpr = 2): CaptureEnv {
  const env: CaptureEnv = {
    blobs: [],
    canvases: [],
    reset() {
      env.blobs.length = 0;
      env.canvases.length = 0;
    },
  };

  class BlobStub {
    constructor(parts: string[]) {
      env.blobs.push(parts.join(''));
    }
  }

  // `loadSvgImage` sets `src` then awaits `onload` — resolve on a microtask.
  class ImageStub {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    _src = '';
    set src(v: string) {
      this._src = v;
      queueMicrotask(() => this.onload?.());
    }
    get src(): string {
      return this._src;
    }
  }

  const g = globalThis as unknown as Record<string, unknown>;
  g.Blob = BlobStub;
  g.Image = ImageStub;
  // The bake yields a paint boundary before it captures; Node has no rAF, so stand one in.
  g.requestAnimationFrame = (cb: (t: number) => void) => setTimeout(() => cb(0), 0);
  g.document = {
    createElement(tag: string) {
      // Pushed at creation and mutated by the capture — the handle reads the final box.
      const canvas = { tag, width: 0, height: 0, getContext: () => ({ drawImage() {} }) };
      env.canvases.push(canvas);
      return canvas;
    },
    addEventListener() {},
    fonts: { ready: Promise.resolve() },
  };
  g.createImageBitmap = async (c: { width: number; height: number }) => ({
    width: c.width,
    height: c.height,
    close() {},
  });
  g.window = {
    devicePixelRatio: dpr,
    matchMedia: (media: string) => ({
      matches: false,
      media,
      addEventListener() {},
      removeEventListener() {},
    }),
  };

  const url = globalThis.URL as unknown as Record<string, unknown>;
  url.createObjectURL = () => 'blob:pose-capture';
  url.revokeObjectURL = () => {};

  return env;
}

/** The root `<svg …>` open tag of a serialized pose document. */
export function rootTag(svg: string): string {
  return svg.slice(0, svg.indexOf('>') + 1);
}

/** One attribute's value off an open tag, or null when absent. */
export function attr(tag: string, name: string): string | null {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;
}
