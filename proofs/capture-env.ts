/**
 * capture-env — the DOM seam `rasterizePoseToBlob` captures through (`Blob` → object URL →
 * `<img>` → canvas → encode), reduced to a recording stub so the Node lane can prove WHAT
 * the blob document declares, HOW MANY captures ran, and WHICH surface was encoded. Shared
 * by the raster-capture, raster-blob and vue-raster-stack proofs; pixels stay the Playwright
 * lane's business (`proofs/browser/*.spec.ts` — no canvas / SVG layout exists here).
 */

export interface CaptureEnv {
  /** Every serialized pose string handed to `new Blob(…)`, capture-ordered. */
  blobs: string[];
  /** Every canvas a capture drew into — the device-px bake box, capture-ordered. */
  canvases: Array<{ width: number; height: number }>;
  /** Every `canvas.toBlob` encode — the mime and the box it encoded, capture-ordered. */
  encodes: Array<{ type: string; width: number; height: number }>;
  /** How many `createImageBitmap` copies the path took — the copy 0.11 deletes. */
  bitmapCopies: number;
  /** When set, the next `toBlob` hands back `null` (the encoder-failure arm). */
  failNextEncode: boolean;
  /** Every object URL minted, mint-ordered. */
  minted: string[];
  /** Every object URL revoked, revoke-ordered. */
  revoked: string[];
  reset(): void;
}

/** Install the stubs on `globalThis`; returns the recording handle. */
export function installCaptureEnv(dpr = 2): CaptureEnv {
  const env: CaptureEnv = {
    blobs: [],
    canvases: [],
    encodes: [],
    bitmapCopies: 0,
    failNextEncode: false,
    minted: [],
    revoked: [],
    reset() {
      env.blobs.length = 0;
      env.canvases.length = 0;
      env.encodes.length = 0;
      env.bitmapCopies = 0;
      env.failNextEncode = false;
      env.minted.length = 0;
      env.revoked.length = 0;
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
      const canvas = {
        tag,
        width: 0,
        height: 0,
        getContext: () => ({ drawImage() {} }),
        // The 0.11 encode seam: the capture canvas hands its own raster back as a Blob.
        // No pixels exist here (Node has no raster) — the byte-level identity claim is the
        // browser lane's (`proofs/browser/blob-identity.spec.ts`); this records WHAT was
        // encoded and FROM WHICH surface.
        toBlob(cb: (blob: unknown) => void, type?: string) {
          if (env.failNextEncode) {
            env.failNextEncode = false;
            queueMicrotask(() => cb(null));
            return;
          }
          const mime = type ?? 'image/png';
          env.encodes.push({ type: mime, width: canvas.width, height: canvas.height });
          queueMicrotask(() => cb({ type: mime, size: canvas.width * canvas.height * 4 }));
        },
      };
      env.canvases.push(canvas);
      return canvas;
    },
    addEventListener() {},
    fonts: { ready: Promise.resolve() },
  };
  g.createImageBitmap = async (c: { width: number; height: number }) => {
    env.bitmapCopies += 1;
    return { width: c.width, height: c.height, close() {} };
  };
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
  // Distinct handles (monotonic across resets — a stale handle can never alias a fresh one).
  // The raster-stack lane proves per-pose URLs and their revocation.
  let mintCount = 0;
  url.createObjectURL = () => {
    const handle = `blob:pose-capture-${mintCount++}`;
    env.minted.push(handle);
    return handle;
  };
  url.revokeObjectURL = (handle: string) => {
    env.revoked.push(handle);
  };

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
