---
"@mkbabb/pencil-boil": patch
---

`useLineBoil` no longer subscribes static marks to the singleton rAF scheduler.
`start()` now gates on `getFrameCount() > 1` (a second, independent gate alongside
`prefersReducedMotion()`), and the composable enrols/withdraws reactively from the
live frame count via a `watchEffect` instead of an unconditional `onMounted`. A
single-frame mark (`frameCount <= 1`, e.g. a `draw-on` brush) animates nothing, so it
never arms the loop; a `draw-then-boil` mark enrols the instant its count crosses 1
after the draw and withdraws if it drops back to a single frame. With zero active
subscribers the scheduler disarms (`cancelAnimationFrame`) and stops re-arming, so a
page of only static marks costs zero frames — fixing the perpetual-rAF main-thread pin
that the unconditional subscription caused. The in-repo `boil-guard` proof
(`npm run proof`) locks the invariant.
