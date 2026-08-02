/**
 * The browser identity fixture — mounts a live filtered pose stack and, from the SHIPPED
 * `rasterizePoseToBlob` (served from the exact packed artifact at /raster.js), captures the
 * SAME poses to blobs.
 * It exposes `window.__proof` for the Playwright lane to drive per engine at DPR2:
 *
 *   (a) untainted  — a same-origin serialized-blob SVG draws to a CORS-clean canvas
 *                    (`getImageData` does not throw).
 *   (b) repeatMatch — re-rastering a pose yields a byte-identical pixel hash.
 *   (c) distinct    — the frozen poses hash distinctly (the boil motion survives).
 *   (d) identity    — SSIM(capture, live) >= 0.98, both rendered IN this engine. NOT an
 *                     equality gate: WebKit's canvas-image filter path and its on-screen
 *                     compositor path diverge by ~1px at displacement edges (crit-safari
 *                     §6: 93.6% exact / maxΔ 221), which an equality gate would false-red.
 *
 * The pose: a full-box opaque PAPER field (undisplaced — a stable backdrop) under a grid of
 * INK lines warped by a per-pose `feTurbulence + feDisplacementMap` (the board-grain shape).
 * The displaced line edges are where WebKit's two filter paths disagree; the floor tolerates
 * that. CAPTURE_PAPER is the single knob the gate-bites demo flips to a wrong literal — the
 * "unresolved color var baked to its fallback" defect that Node's string guard cannot see
 * (it stays self-contained) but the pixel gate does: a full-box luminance shift craters SSIM.
 */
import { serializePoseSvg, isSelfContainedSvg, rasterizePoseToBlob } from '/raster.js';

const POSE_COUNT = 4;
const BOX = 240; // CSS px; captured at BOX * dpr device px (480 at DPR2)

// Colors resolved to hex literals at "capture time" — no currentColor / var() leaks.
const PAPER = '#efe9dd'; // the live paper field, and the correct capture backdrop
// GATE KNOB — keep this === PAPER for a passing lane. Flipping it to a wrong literal
// (e.g. '#7a3b1f') models an unresolved `--paper` baked to its fallback; the capture then
// differs from the live render across the whole box and the SSIM floor reds the lane.
const CAPTURE_PAPER = PAPER;

// The board-cell shape: solid low-contrast cells warped by a smooth (low-frequency)
// displacement — the frozen-pose grammar the wave bakes. The cell INTERIORS are uniform, so
// WebKit's canvas-vs-compositor filter paths render them byte-identically; only the ~1px
// displaced EDGE ring misregisters (sparse, low amplitude). That reproduces crit-safari §6's
// profile (mostly byte-exact, sparse edge drift) — SSIM >= 0.98 yet exact < 100%, so an
// equality gate would false-red every WebKit pose while the floor holds. A high-FREQUENCY or
// high-CONTRAST warp instead decorrelates the whole field and craters SSIM — deliberately not
// that. The color literals live only in the cells; the fault knob flips the full-box PAPER.
const INK = '#e0d8c9'; // soft tan cell — low contrast to paper keeps edge drift low-amplitude
const DISP_FREQ = [0.028, 0.035, 0.031, 0.04]; // a distinct smooth warp per pose
const SCALE = 3; // displacement magnitude — a visible edge warp within the SSIM floor

/** Structured parts of one pose, colored by `paper` (the cell tooth `INK` is fixed). */
function poseParts(pose, paper) {
  const df = DISP_FREQ[pose % DISP_FREQ.length];
  const defs =
    `<filter id="wob-${pose}" x="-10%" y="-10%" width="120%" height="120%">` +
    `<feTurbulence type="turbulence" baseFrequency="${df}" numOctaves="2" seed="${pose}" stitchTiles="stitch" result="n"/>` +
    `<feDisplacementMap in="SourceGraphic" in2="n" scale="${SCALE}" xChannelSelector="R" yChannelSelector="G"/>` +
    `</filter>`;
  let cells = '';
  for (const cy of [22, 128]) {
    for (const cx of [22, 128]) {
      cells += `<rect x="${cx}" y="${cy}" width="90" height="90" rx="6" fill="${INK}"/>`;
    }
  }
  const body =
    `<rect width="${BOX}" height="${BOX}" fill="${paper}"/>` +
    `<g filter="url(#wob-${pose})">${cells}</g>`;
  return { width: BOX, height: BOX, defs, body };
}

const liveSvg = (pose) => serializePoseSvg(poseParts(pose, PAPER));
const captureSvg = (pose) => serializePoseSvg(poseParts(pose, CAPTURE_PAPER));

const dpr = () => (Number.isFinite(window.devicePixelRatio) ? window.devicePixelRatio : 1);
const deviceBox = () => Math.round(BOX * dpr());

document.body.style.background = PAPER;
const host = document.getElementById('live-host');

/** Mount pose `i` as the live, on-screen filtered SVG (the compositor-path reference). */
function setLivePose(pose) {
  host.innerHTML = liveSvg(pose);
}

/** FNV-1a over an RGBA byte buffer → a stable 32-bit pixel hash. */
function hashBytes(data) {
  let h = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    h ^= data[i];
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/** Draw a self-contained pose SVG through a same-origin blob → <img> → canvas, then read it
 *  back. `getImageData` THROWS if the canvas is CORS-tainted; a clean read proves untaint. */
function captureImageData(svg) {
  return new Promise((resolve, reject) => {
    if (!isSelfContainedSvg(svg)) {
      reject(new Error('capture SVG is not self-contained'));
      return;
    }
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      try {
        const n = deviceBox();
        const c = document.createElement('canvas');
        c.width = n;
        c.height = n;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, n, n);
        const px = ctx.getImageData(0, 0, n, n); // taint gate
        resolve({ data: px.data, w: n, h: n });
      } catch (err) {
        reject(err);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('SVG blob failed to load'));
    };
    img.src = url;
  });
}

const PAPER_LUMA = 0.299 * 0xef + 0.587 * 0xe9 + 0.114 * 0xdd; // ≈ 233

/** Count pixels whose luma departs from the paper backdrop — proves the pose actually drew
 *  its grain (the speckle pulls paper down a few luma; a blank capture would count 0). */
function inkCount(data) {
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    if (Math.abs(luma - PAPER_LUMA) > 4) n++;
  }
  return n;
}

/**
 * (a) untainted, (b) repeatMatch, (c) distinct-per-pose — all from the direct blob-capture
 * path, mirroring s3's proven fixture. Shape echoes `results-fixture.txt`.
 */
async function taintAndHash() {
  const poses = [];
  const hashes = [];
  let allClean = true;
  for (let pose = 0; pose < POSE_COUNT; pose++) {
    let tainted = false;
    let nonBlank = 0;
    let w = 0;
    let h = 0;
    let hash = 0;
    try {
      const cap = await captureImageData(captureSvg(pose));
      w = cap.w;
      h = cap.h;
      hash = hashBytes(cap.data);
      nonBlank = inkCount(cap.data);
    } catch (err) {
      tainted = true;
      allClean = false;
    }
    hashes.push(hash);
    poses.push({ tainted, nonBlank, w, h });
  }
  // (b) re-raster pose 0 twice — byte-identical hash.
  const a = hashBytes((await captureImageData(captureSvg(0))).data);
  const b = hashBytes((await captureImageData(captureSvg(0))).data);
  const repeatMatch = a === b;
  // (c) distinct hashes across poses.
  const distinctPoseHashes = new Set(hashes).size;
  return { dpr: dpr(), allClean, repeatMatch, distinctPoseHashes, poses };
}

/** Grayscale mean SSIM over 8x8 non-overlapping windows (Rec.601 luma, standard constants). */
function ssim(a, b, w, h) {
  const N = w * h;
  const la = new Float64Array(N);
  const lb = new Float64Array(N);
  for (let i = 0, p = 0; i < a.length; i += 4, p++) {
    la[p] = 0.299 * a[i] + 0.587 * a[i + 1] + 0.114 * a[i + 2];
    lb[p] = 0.299 * b[i] + 0.587 * b[i + 1] + 0.114 * b[i + 2];
  }
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  const win = 8;
  let sum = 0;
  let blocks = 0;
  for (let by = 0; by + win <= h; by += win) {
    for (let bx = 0; bx + win <= w; bx += win) {
      let sa = 0;
      let sb = 0;
      let saa = 0;
      let sbb = 0;
      let sab = 0;
      for (let y = 0; y < win; y++) {
        const row = (by + y) * w + bx;
        for (let x = 0; x < win; x++) {
          const va = la[row + x];
          const vb = lb[row + x];
          sa += va;
          sb += vb;
          saa += va * va;
          sbb += vb * vb;
          sab += va * vb;
        }
      }
      const n = win * win;
      const ma = sa / n;
      const mb = sb / n;
      const va = saa / n - ma * ma;
      const vb = sbb / n - mb * mb;
      const cov = sab / n - ma * mb;
      const s =
        ((2 * ma * mb + C1) * (2 * cov + C2)) /
        ((ma * ma + mb * mb + C1) * (va + vb + C2));
      sum += s;
      blocks++;
    }
  }
  return blocks ? sum / blocks : 1;
}

function decodePng(b64) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('PNG decode failed'));
    img.src = 'data:image/png;base64,' + b64;
  });
}

/**
 * (d) identity — SSIM between the SHIPPED-`rasterizePoseToBlob` capture and the live compositor
 * render (passed in as a PNG the engine screenshotted), decoded and compared IN this engine.
 */
async function identity(pose, livePngB64) {
  const liveImg = await decodePng(livePngB64);
  const n = deviceBox();
  const lc = document.createElement('canvas');
  lc.width = n;
  lc.height = n;
  const lctx = lc.getContext('2d', { willReadFrequently: true });
  lctx.drawImage(liveImg, 0, 0, n, n);
  const live = lctx.getImageData(0, 0, n, n).data;

  const cap = (await decodeBlobPixels(await rasterizePoseToBlob(captureSvg(pose), { width: BOX, height: BOX }, dpr()))).data;

  // exact-match % and maxΔ (per channel) — the crit-safari §6 metrics, for the record.
  let exact = 0;
  let maxDelta = 0;
  const total = n * n;
  for (let i = 0; i < cap.length; i += 4) {
    const dr = Math.abs(cap[i] - live[i]);
    const dg = Math.abs(cap[i + 1] - live[i + 1]);
    const db = Math.abs(cap[i + 2] - live[i + 2]);
    if (dr === 0 && dg === 0 && db === 0) exact++;
    const m = Math.max(dr, dg, db);
    if (m > maxDelta) maxDelta = m;
  }
  return {
    ssim: ssim(cap, live, n, n),
    exactPct: (100 * exact) / total,
    maxDelta,
    w: n,
    h: n,
  };
}

// ── (e) PIXEL IDENTITY: the 0.11 blob path vs the 0.10.1 round trip it retires ─────────
//
// Through 0.10.1 a consumer that wanted a durable artifact took `rasterizePose`'s
// `ImageBitmap`, drew it into a SECOND surface, and PNG-encoded that. 0.11 encodes the
// capture canvas directly. The claim is that no pixel moves. The retired pipeline no longer
// exists in the library, so the reference is reproduced HERE, verbatim in shape — including
// the capture-intrinsic stamp (0.10.0's truth-fix), without which the two arms would raster
// at different resolutions and the comparison would be vacuous.

/** `raster.ts`'s `stampCaptureIntrinsic`, reproduced for the reference arm. */
function stampIntrinsic(svg, w, h) {
  const end = svg.indexOf('>') + 1;
  const root = svg
    .slice(0, end)
    .replace(/\s(?:width|height)="[^"]*"/g, '')
    .replace('<svg', `<svg width="${w}" height="${h}"`);
  return root + svg.slice(end);
}

/** Blob → `<img>` → canvas: the capture both arms share. */
function drawStampedPose(svg, w, h) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(
      new Blob([stampIntrinsic(svg, w, h)], { type: 'image/svg+xml;charset=utf-8' }),
    );
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      resolve(c);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('reference arm: SVG blob failed to load'));
    };
    img.src = url;
  });
}

/** The RETIRED pipeline: capture → ImageBitmap copy → second surface → PNG encode. */
async function legacyRoundTrip(svg, w, h) {
  const canvas = await drawStampedPose(svg, w, h);
  const bmp = await createImageBitmap(canvas); // the copy 0.11 deletes
  let blob;
  if (typeof OffscreenCanvas !== 'undefined') {
    const oc = new OffscreenCanvas(bmp.width, bmp.height); // the consumer's second surface
    oc.getContext('2d').drawImage(bmp, 0, 0);
    blob = await oc.convertToBlob({ type: 'image/png' }); // the encode 0.11 deletes
  } else {
    const c2 = document.createElement('canvas');
    c2.width = bmp.width;
    c2.height = bmp.height;
    c2.getContext('2d').drawImage(bmp, 0, 0);
    blob = await new Promise((res, rej) =>
      c2.toBlob((b) => (b ? res(b) : rej(new Error('reference arm: toBlob null'))), 'image/png'),
    );
  }
  bmp.close();
  return blob;
}

/** Decode a PNG blob back to RGBA bytes IN this engine. */
async function decodeBlobPixels(blob) {
  const bmp = await createImageBitmap(blob);
  // Read the box BEFORE close() — a closed bitmap reports 0×0.
  const w = bmp.width;
  const h = bmp.height;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const px = ctx.getImageData(0, 0, w, h);
  bmp.close();
  return { data: px.data, w, h };
}

/**
 * (e) PIXEL IDENTITY — one fixed pose through both paths, decoded and compared byte for
 * byte (RGBA, alpha included). Also reports each arm's wall time and the encoded PNG sizes;
 * the timings are a RECORD, not a gate (a headless host's numbers are not the device's).
 */
async function blobIdentity(pose) {
  const svg = captureSvg(pose);
  const n = deviceBox();

  const t0 = performance.now();
  const fresh = await rasterizePoseToBlob(svg, { width: BOX, height: BOX }, dpr());
  const msNew = performance.now() - t0;

  const t1 = performance.now();
  const legacy = await legacyRoundTrip(svg, n, n);
  const msOld = performance.now() - t1;

  const a = await decodeBlobPixels(fresh);
  const b = await decodeBlobPixels(legacy);

  if (a.w !== b.w || a.h !== b.h) {
    return { boxMatch: false, w: a.w, h: a.h, refW: b.w, refH: b.h };
  }

  let differing = 0;
  let maxDelta = 0;
  for (let i = 0; i < a.data.length; i++) {
    const d = Math.abs(a.data[i] - b.data[i]);
    if (d !== 0) differing++;
    if (d > maxDelta) maxDelta = d;
  }

  const freshBytes = new Uint8Array(await fresh.arrayBuffer());
  const legacyBytes = new Uint8Array(await legacy.arrayBuffer());
  let pngIdentical = freshBytes.length === legacyBytes.length;
  if (pngIdentical) {
    for (let i = 0; i < freshBytes.length; i++) {
      if (freshBytes[i] !== legacyBytes[i]) {
        pngIdentical = false;
        break;
      }
    }
  }

  return {
    boxMatch: true,
    w: a.w,
    h: a.h,
    differingBytes: differing,
    totalBytes: a.data.length,
    maxDelta,
    inkNew: inkCount(a.data),
    inkOld: inkCount(b.data),
    pngIdentical,
    pngBytesNew: freshBytes.length,
    pngBytesOld: legacyBytes.length,
    msNew,
    msOld,
  };
}

/** Every capture SVG is self-contained (no currentColor/var leak) — so the identity result
 *  is the PIXEL gate biting, never the string guard. Stays true even under the fault knob. */
function allSelfContained() {
  for (let pose = 0; pose < POSE_COUNT; pose++) {
    if (!isSelfContainedSvg(captureSvg(pose))) return false;
  }
  return true;
}

window.__proof = {
  poseCount: POSE_COUNT,
  setLivePose,
  taintAndHash,
  identity,
  blobIdentity,
  allSelfContained,
};
