---
"@mkbabb/pencil-boil": minor
---

Reactive prefers-reduced-motion with correct teardown (M2). `prefersReducedMotion()` is
no longer a fresh `matchMedia` read inside `start()` — the scheduler now holds a reactive
`prmRef` backed by a `matchMedia('(prefers-reduced-motion: reduce)')` `'change'` listener,
exposed as `usePrefersReducedMotion(): Readonly<Ref<boolean>>`.

The fix that a naive "just make it reactive" patch misses: when PRM flips to `reduce`
mid-session, `start()`'s early-return only guards *new* enrolment — it never withdraws an
*already-active* subscriber, so the boil keeps ticking. `useLineBoil`'s `watchEffect` gate
now reads `prmRef.value` unconditionally and owns the teardown branch (`stop()` on PRM or a
static frame count), and the central `'change'` listener hard-clears every subscriber the
instant PRM engages. Reduced-motion is honored the same frame it changes, for reactive and
imperative consumers alike.
