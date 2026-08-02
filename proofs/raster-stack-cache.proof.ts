/**
 * raster-stack-cache.proof — 0.12.0: `useRasterStack` keeps baked stacks per capture size.
 *
 *   node --import ./proofs/loader.mjs proofs/raster-stack-cache.proof.ts
 *
 * WHY THIS IS A GATE. A layout that toggles between two boxes — a drawer opening and
 * closing, a rail folding — walks a size the surface baked moments earlier. Through 0.11 the
 * composable held exactly one stack, so the return trip re-encoded every pose to reproduce
 * pixels it had already produced and thrown away. In WebKit that encode cannot be moved off
 * the main thread from inside a library (pass-6 BC5-G4: `OffscreenCanvas.convertToBlob` on
 * the main thread blocks it exactly as `HTMLCanvasElement.toBlob` does), so the only encode
 * that costs a gesture nothing is the one that does not run.
 *
 * THE CONTROL IS LIVE, NOT REMEMBERED. Arm (g) re-runs the whole size walk at
 * `poseCacheSize: 1` — the 0.11 shape, still reachable as a configuration — and asserts the
 * re-encode that arm (a) asserts is ABSENT. If the harness could not see a re-encode, (g)
 * would pass falsely and (a) would mean nothing; (g) is what makes (a) a measurement.
 *
 * Pixels are the browser lane's business (`proofs/browser/stack-cache-identity.spec.ts`
 * fetches the bytes back off a cache hit and compares them). Here the seam records WHICH
 * surfaces were encoded, WHICH handles were minted, and WHICH were revoked — so this lane
 * proves the encode count, the handle identity and the whole revocation ledger.
 *
 * Proofs:
 *   (a) THE RETURN IS FREE: A → B → A performs ZERO encodes on the return.
 *   (b) THE SAME ARTIFACT: the returned URLs are the identical handles, none of them revoked.
 *   (c) NO FLICKER: `urls` never passes through null across a cache hit, so the surface never
 *       drops to its live-filter fallback for a stack it already owns.
 *   (d) THE CAP EVICTS, AND REVOKES WHAT IT EVICTS: at `poseCacheSize: 2` a third size pushes
 *       the first out, its handles are revoked exactly once, and returning to it re-encodes.
 *   (e) `rebake()` STILL FORCES: it drops the live entry, so the re-capture actually runs.
 *   (f) UNMOUNT DRAINS: every handle ever minted is revoked exactly once, resident or live.
 *   (g) THE INCUMBENT ARM: `poseCacheSize: 1` reproduces 0.11 — the return to A re-encodes.
 *   (h) A PRE-FONT BAKE IS NEVER SERVED TO A POST-FONT SURFACE: the settled flag is part of
 *       the key, so the stack baked in fallback glyphs cannot answer for the real ones.
 */

import { effectScope, nextTick, ref } from 'vue';
import { serializePoseSvg, type RasterStackOptions } from '../src/raster.ts';
import { installCaptureEnv } from './capture-env.ts';

let passed = 0;
const failures: string[] = [];

function assert(cond: boolean, label: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL ${label}`);
  }
}

// The composable registers onMounted/onUnmounted; headlessly there is no component instance.
{
  const warn = console.warn;
  console.warn = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && /on(Mounted|Unmounted) is called/.test(args[0])) return;
    warn(...args);
  };
}

const env = installCaptureEnv(2);
const { useRasterStack } = await import('../src/vue.ts');

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
}

const POSE_COUNT = 4; // the app's grid stack — four frozen poses
function poseSvg(pose: number): string {
  return serializePoseSvg({
    width: 660,
    height: 660,
    defs: `<filter id="g-p${pose}"><feTurbulence baseFrequency="0.02" seed="${pose}" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="2"/></filter>`,
    body: `<g filter="url(#g-p${pose})"><path d="M0 0 H660" stroke="#1a1a1a"/></g>`,
  });
}

/** The two boxes a drawer toggles a board between — the shipped gesture, in miniature. */
const OPEN = { width: 520, height: 520 };
const CLOSED = { width: 660, height: 660 };
const THIRD = { width: 400, height: 400 };

function mount(poseCacheSize?: number) {
  const opts = ref<RasterStackOptions>({
    cacheKey: 'grid|3|dark',
    poseCount: POSE_COUNT,
    poseSvg,
    cssSize: { ...CLOSED },
    ...(poseCacheSize === undefined ? {} : { poseCacheSize }),
  });
  const scope = effectScope();
  let api: ReturnType<typeof useRasterStack> | undefined;
  scope.run(() => {
    api = useRasterStack(opts);
  });
  return { opts, scope, api: api! };
}

/** Drive a size change and settle. Returns how many encodes it cost. */
async function resize(
  opts: { value: RasterStackOptions },
  cssSize: { width: number; height: number },
): Promise<number> {
  const before = env.encodes.length;
  opts.value = { ...opts.value, cssSize: { ...cssSize } };
  await nextTick();
  await flush();
  return env.encodes.length - before;
}

// ── the default cache ─────────────────────────────────────────────────────────────
{
  env.reset();
  const { opts, scope, api } = mount();
  api.rebake(); // stands in for the onMounted bake
  await flush();
  const closedUrls = api.urls.value!;
  assert(closedUrls?.length === POSE_COUNT, 'setup: the first bake resolved every pose');

  const openCost = await resize(opts, OPEN);
  assert(openCost === POSE_COUNT, `setup: a NEW size costs a full bake (${openCost} encodes)`);
  const openUrls = api.urls.value!;

  // (a) + (b) + (c) — the return trip.
  {
    // A hit must be synchronous: read `urls` on the very next tick, before any flush, so a
    // null in between would be caught rather than smoothed over by the settle.
    opts.value = { ...opts.value, cssSize: { ...CLOSED } };
    const encodesBefore = env.encodes.length;
    const revokedBefore = env.revoked.length;
    await nextTick();
    const midHit = api.urls.value;
    await flush();

    assert(
      env.encodes.length - encodesBefore === 0,
      '(a) returning to a baked size performs ZERO encodes',
    );
    assert(
      api.urls.value !== null && api.urls.value!.every((u, i) => u === closedUrls[i]),
      '(b) the return hands back the IDENTICAL handles — the same blobs, not a re-encode',
    );
    assert(
      !closedUrls.some((u) => env.revoked.includes(u)),
      '(b) no handle in the cached stack was revoked while it was resident',
    );
    assert(
      env.revoked.length === revokedBefore,
      '(b) the return revokes nothing at all — both stacks stay live and reachable',
    );
    assert(
      midHit !== null && midHit!.every((u, i) => u === closedUrls[i]),
      '(c) urls never passes through null on a hit — no live-filter flicker on the gesture',
    );
    assert(
      openUrls.every((u) => !env.revoked.includes(u)),
      '(c) the size we LEFT is retained too — the next toggle back is free as well',
    );
  }

  // Toggle three more times; every one of them must be free.
  {
    const before = env.encodes.length;
    await resize(opts, OPEN);
    await resize(opts, CLOSED);
    await resize(opts, OPEN);
    assert(
      env.encodes.length === before,
      '(a) three further toggles cost ZERO encodes between them',
    );
  }

  // (e) rebake() forces through the cache.
  {
    const before = env.encodes.length;
    api.rebake();
    await flush();
    assert(
      env.encodes.length - before === POSE_COUNT,
      '(e) rebake() drops the live entry and re-captures — force still means force',
    );
  }

  // (f) unmount drains everything.
  {
    const mintedAll = [...env.minted];
    scope.stop();
    await flush();
    const revoked = env.revoked;
    assert(
      mintedAll.every((u) => revoked.includes(u)),
      '(f) unmount revokes EVERY handle the surface ever minted — resident stacks included',
    );
    assert(
      revoked.length === new Set(revoked).size,
      '(f) no handle is revoked twice across the whole lifetime',
    );
    assert(api.urls.value === null, '(f) urls is null after unmount');
  }
}

// ── (d) the cap ───────────────────────────────────────────────────────────────────
{
  env.reset();
  const { opts, scope, api } = mount(2);
  api.rebake();
  await flush();
  const first = api.urls.value!;

  await resize(opts, OPEN); // 2 resident: CLOSED, OPEN
  await resize(opts, THIRD); // 3 minted, cap 2 → CLOSED evicted

  assert(
    first.every((u) => env.revoked.includes(u)),
    '(d) the cap evicts the least recently served stack and revokes its handles',
  );
  assert(
    env.revoked.length === new Set(env.revoked).size,
    '(d) eviction revokes each evicted handle exactly once',
  );
  const cost = await resize(opts, CLOSED);
  assert(cost === POSE_COUNT, '(d) an evicted size re-encodes — the cap is real, not advisory');
  scope.stop();
  await flush();
}

// ── (g) THE INCUMBENT ARM — poseCacheSize 1 is 0.11, and it re-encodes ────────────
{
  env.reset();
  const { opts, scope, api } = mount(1);
  api.rebake();
  await flush();
  const closedUrls = api.urls.value!;

  await resize(opts, OPEN);
  const returnCost = await resize(opts, CLOSED);

  assert(
    returnCost === POSE_COUNT,
    '(g) CONTROL: at poseCacheSize 1 the return to a baked size RE-ENCODES — the harness ' +
      'can see the cost that (a) reports as gone',
  );
  assert(
    api.urls.value!.every((u, i) => u !== closedUrls[i]),
    '(g) CONTROL: and it hands back fresh handles, not the originals',
  );
  assert(
    closedUrls.every((u) => env.revoked.includes(u)),
    '(g) CONTROL: the 0.11 revoke-on-swap ordering survives as the cap-1 eviction',
  );
  scope.stop();
  await flush();
}

// ── (h) the font seam ─────────────────────────────────────────────────────────────
{
  env.reset();
  // Hold fonts.ready open so the opts watch can race a bake in ahead of the face landing —
  // the real sequence when layout settles before a webfont does.
  let settle!: () => void;
  const held = new Promise<void>((r) => {
    settle = () => r();
  });
  const doc = (globalThis as unknown as { document: { fonts: { ready: Promise<void> } } })
    .document;
  const realReady = doc.fonts.ready;
  doc.fonts.ready = held;

  const { opts, scope, api } = mount();
  // Two pre-font bakes: the layout settles, moves, and settles again, all while the face is
  // still loading. The stack at OPEN is the dangerous one — it is not current, so a key-local
  // guard would leave it resident, holding fallback glyphs, waiting for the layout to return.
  await resize(opts, OPEN);
  const preFontOpen = api.urls.value!;
  await resize(opts, CLOSED);
  const preFontClosed = api.urls.value!;
  assert(
    preFontOpen?.length === POSE_COUNT && preFontClosed?.length === POSE_COUNT,
    '(h) setup: two pre-font stacks resolved, at two different boxes',
  );

  const before = env.encodes.length;
  settle();
  await flush();
  assert(
    env.encodes.length - before === POSE_COUNT,
    '(h) the font-ready bake RE-CAPTURES at the current box — no pre-font stack is served',
  );
  assert(
    api.urls.value!.every((u, i) => u !== preFontClosed[i]),
    '(h) the surface renders the post-font handles, never the fallback-glyph ones',
  );
  assert(
    preFontOpen.every((u) => env.revoked.includes(u)),
    '(h) the NON-CURRENT pre-font stack is cleared too — it can never be served on a return',
  );
  {
    const cost = await resize(opts, OPEN);
    assert(
      cost === POSE_COUNT,
      '(h) returning to that box re-encodes with the real face — the stale stack is gone',
    );
  }
  doc.fonts.ready = realReady;
  scope.stop();
  await flush();
}

// A live stack subscribes to the shared beat, and the beat keeps the event loop alive — the
// same reason every proof in this directory exits explicitly rather than falling off the end.
const exit = (globalThis as { process?: { exit(code: number): never } }).process?.exit;
console.log('');
if (failures.length === 0) {
  console.log(`raster-stack-cache.proof: ${passed} assertions passed`);
  exit?.(0);
} else {
  console.log(`raster-stack-cache.proof: ${failures.length} FAILED, ${passed} passed`);
  for (const f of failures) console.log(`  - ${f}`);
  exit?.(1);
}
