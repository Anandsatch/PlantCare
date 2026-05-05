# Changelog

All notable changes to PlantCare will be documented in this file.

## [0.1.15.0] - 2026-05-04

E2-011 — `<EditorialBottomSheet>` primitive. The most complex of the V1 primitive set: focus trap, swipe-to-close, reduce-motion compliance, and a deliberate no-extra-deps ship. RN's built-in `Modal` is the foundation — it already handles Android back-button (`onRequestClose`), the iOS focus trap (`accessibilityViewIsModal`), and cross-platform mount/unmount. PanResponder owns the swipe-down gesture; we explicitly chose it over `react-native-gesture-handler` (already a workspace dep but requires `<GestureHandlerRootView>` at the app root) and `@gorhom/bottom-sheet` (rejected by V1 scope locks). The result: ~250 lines, zero new deps, 19 new tests on top of the 30 existing for 49 mobile tests total.

### Added
- `apps/mobile/src/components/primitives/EditorialBottomSheet.tsx` — `Modal(transparent) → backdrop Pressable + Animated.View sheet`. Sheet height = `Dimensions.window.height * heightFraction` (default 0.7). Backdrop tint is `theme.colors.text + '80'` (50% alpha) so it composes against both Conservatory cream and Midnight forest. Sheet uses `theme.colors.surface` for fill, `theme.colors.stroke` for the 36×4 drag-handle bar. `accessibilityRole='dialog'` + `accessibilityLabel` (default `'Bottom sheet'`) + `accessibilityViewIsModal=true` make VoiceOver / TalkBack announce the dialog and trap focus inside it. Android back button → `Modal.onRequestClose` → `onDismiss`.
- `shouldDismissOnDragRelease({ dy, sheetHeight })` — pure helper extracted so the threshold logic is unit-testable without PanResponder simulation. Threshold = `max(100px, sheetHeight * 0.3)`. The percentage rule prevents premature dismissal on tall sheets where 100px is nothing; the absolute floor handles small sheets where 30% of the height is too sensitive.
- Reduce-motion compliance via inline `AccessibilityInfo.isReduceMotionEnabled()` + `'reduceMotionChanged'` subscription. When on, `Modal.animationType` flips from `'slide'` to `'none'` (no slide-in transition), and the spring snap-back on a sub-threshold drag is replaced with an instant `setValue(0)`. Inlined the 5 lines rather than depending on E2-004's `useReduceMotion()` which hadn't merged at the time of E2-011.
- `apps/mobile/src/components/primitives/__tests__/EditorialBottomSheet.test.tsx` — 19 tests using `@testing-library/react-native`. Coverage: open/closed visibility, backdrop press → onDismiss, Modal.onRequestClose → onDismiss (Android back), tap-on-content does NOT propagate to backdrop, accessibilityLabel pass-through + default, accessibilityViewIsModal=true, accessibilityRole='dialog', heightFraction reflected in style, light/dark token usage, animationType slide vs none, drag-handle hidden from a11y tree, and the dismiss-threshold helper exhaustively tested for the 100px floor / 30% rule / upward / zero / negative drag cases.
- `apps/mobile/src/components/primitives/index.ts` barrel.

### Adversarial review (codex)
- **P2** — original implementation attached PanResponder to the entire sheet wrapper, which would steal vertical scroll gestures from any nested `ScrollView` / `FlatList` inside the sheet. Fixed by binding the PanResponder ONLY to a top "drag-zone" band that wraps the handle, with a generous `hitSlop` to keep the touch target ≥44px. Children render below the drag-zone in a sibling layout slot — their gestures are untouched. The test now explicitly asserts the panResponder lives on the drag-zone and is absent from the sheet wrapper.
- **P3 (addressed proactively)** — codex noted that the PanResponder closes over `sheetHeight`, `reduceMotion`, and `onDismiss` at mount, which would go stale if those props change while the sheet is open (system reduce-motion toggle is a real path). Wrapped the captured values in a `latestRef` that re-points every render — the responder identity stays stable (good for `.panHandlers` spread) but the release closure reads fresh values. Tests stay green.
- **Rejected** — `@gorhom/bottom-sheet` (V1 dep-light scope lock). `react-native-gesture-handler`-based gesture (already a dep but requires `GestureHandlerRootView` at app root, which we haven't added). `react-native-reanimated` (not a dep). Global Portal / Provider (Modal handles platform mount).

### Notes
- Drag-zone gesture-only-on-handle decision: the standard bottom-sheet UX is "drag the handle to dismiss"; tapping the handle is a no-op. This is what consumers expect and what keeps nested scrollables alive. If a future ticket genuinely needs full-sheet drag-to-dismiss with composed scroll behavior, switch to `react-native-gesture-handler`'s `Gesture.Native()` composition at that point.
- Backdrop colour formula `theme.colors.text + '80'`: hex two-digit alpha 80 = decimal 128 ≈ 50% opacity. In light mode (text=#2A2A2A) this gives a near-black scrim; in dark mode (text=#FAF6EE) it gives a cream-tinted scrim that reads correctly against the deep-forest bg. Tested via the dark-theme assertion in the suite.
- React 19 `act()` warning fires from the post-mount `isReduceMotionEnabled()` promise resolution; an `afterEach` that drains microtasks inside `act()` keeps subsequent tests clean. The warning text in the first test's stream is cosmetic — all 49 tests pass.
- `accessibilityRole={'dialog' as 'none'}` cast: the legacy `Animated.View` types omit `'dialog'` from their `AccessibilityRole` union (the modern `types_generated/` definitions include it). Cast through to keep the runtime contract correct without widening the prop type.

## [0.1.14.0] - 2026-05-04

E2-010 — `<HeroPhoto>` primitive. The editorial photo block used on A-2 (full-bleed plant detail hero), A-3 (camera result), and A-4 (add plant confirmation). One primitive, one rounded-corner contract, one cream-skeleton-while-loading behavior. Built on RN's legacy `Image` (no `expo-image` — V1 ships lean; FileSystem-stored photos don't need network caching or progressive JPEGs). The accessibilityLabel is required at the TypeScript prop level so callers can't ship an unlabeled hero photo, even though RN's underlying `Image.accessibilityLabel` is optional. 13 component tests pass; 43 mobile tests total.

### Added
- `apps/mobile/src/components/primitives/HeroPhoto.tsx` — the primitive. Props: `source` (RN `ImageSourcePropType` — `{uri}` for FileSystem photos, `number` for required() static assets), `aspectRatio?` (default 1; A-2 overrides for full-bleed), `rounded?` (`true`→24, `false`→0, `number`→explicit radius; default `true`), `accessibilityLabel` (REQUIRED), `testID?`, `onLoad?`, `onError?`. Uses `useTheme()` for the cream skeleton color (light: `#FAF6EE`, dark: `#1F3826` forest).
- `apps/mobile/src/components/primitives/index.ts` — barrel.
- `apps/mobile/src/components/primitives/__tests__/HeroPhoto.test.tsx` — 13 tests covering default radius (24), `rounded={false}` → 0, numeric `rounded` passthrough, default aspectRatio (1), custom aspectRatio (4/3), accessibilityLabel forwarded to wrapper View, accessibilityRole='image' on wrapper, source object passed through to Image unchanged, onLoad fires through, onError fires + Image is unmounted (silent cream rect fallback), a11y identity preserved on the wrapper after error so screen readers still announce, dark-mode skeleton uses Midnight surface token, light-mode skeleton uses cream surface token.

### Notes
- **Why a wrapping `View` with `overflow: 'hidden'`:** documented Android RN gotcha — direct `borderRadius` on `<Image>` does not consistently clip the underlying bitmap on Android across all `resizeMode` + image-format combinations. A View wrapper with `overflow:'hidden'` makes the rounded shape behave identically across iOS and Android with one visual contract. Codex review confirmed this pattern.
- **Silent-failure design:** on `onError`, the Image is unmounted and the cream-rect wrapper stays. No broken-image icon, no placeholder text, no spinner. The accessibilityLabel still rides on the wrapper so VoiceOver/TalkBack announces "image, Photo of …" rather than going silent — the cream rectangle is the announced element. This preserves the editorial voice (anti-AI-slop: no generic-app polish noise).
- **Single accessibility identity:** the wrapper View owns `accessible`, `accessibilityRole='image'`, and `accessibilityLabel`. The inner Image carries `accessible={false}` and `importantForAccessibility='no-hide-descendants'` so screen readers announce once, not twice.
- **No `expo-image`:** V1 scope lock. FileSystem photos are local — no network round-trip, no caching benefit. expo-image's progressive JPEG and disk cache become valuable post-V1 if remote photos enter the picture; for now the dep cost isn't earned.
- **No spinner overlay, no progressive loading, no caching layer:** all V1 scope locks. The cream skeleton (visible until `onLoad`) is the editorial-voice loading state.

### Adversarial review (codex)
- One round of `codex exec` adversarial review against the 6 documented risk surfaces (TypeScript-required label vs RN's optional underlying type, iOS+Android borderRadius clipping, skeleton flash on slow devices, large-image RAM teardown, silent error-state a11y, general implementation defects). **No P1 or P2 findings.** Codex confirmed: the prop-layer enforcement of accessibilityLabel works, the `overflow:'hidden'` wrapper is the correct cross-platform clipping pattern, and the cream-rect error state remains the accessible element rather than going silent.

## [0.1.13.0] - 2026-05-04

E2-009 — `<FAB>` primitive. The forest-circle floating action button anchored to the bottom-right of the Plants list (A-1). Tap launches the camera in identify mode; long-press opens the "Add a plant / Quick diagnose" popover wired in E3-004. This PR ships only the primitive (the circle, the press handlers, the a11y plumbing). 56×56 (Material default — exceeds the 44×44 a11y minimum, no `hitSlop` needed). Forest fill (`theme.colors.text`) with cream "+" glyph (`theme.colors.surface`); cross-platform shadow (iOS `shadow*` + Android `elevation: 3`); pressed state is opacity 0.85, no Reanimated, no scale transform — V1 lock against tween dependencies. 15 component tests added — total mobile suite is now 45.

### Added
- `apps/mobile/src/components/primitives/FAB.tsx` — `Pressable`-backed circle with `onPress` (required) + optional `onLongPress`. Default icon is a Fraunces "+" via RN `Text` (chosen over SVG because `react-native-svg` isn't a dep yet; "+" reads correctly even before Fraunces finishes loading because system "+" has equivalent glyph metrics). `icon?: ReactNode` slot lets callers swap in an SVG once `react-native-svg` lands. Positioning is the parent's responsibility — the primitive does not absolutely position itself, so it composes cleanly inside any layout.
- `apps/mobile/src/components/primitives/index.ts` — barrel.
- `apps/mobile/src/components/primitives/__tests__/FAB.test.tsx` — 15 tests: 56×56 dimensions, tap fires `onPress`, long-press fires `onLongPress` (and does NOT also fire `onPress` — the tap-vs-hold race), `accessibilityActions` absence/presence keyed off `onLongPress`, `onAccessibilityAction` routes the `'longpress'` action to `onLongPress` (Android TalkBack actions-menu fallback), `disabled` blocks every path including the accessibility-action path, default + custom `accessibilityLabel`, conditional `accessibilityHint`, dark-mode `backgroundColor` resolves to `darkTheme.colors.text`, custom `icon` prop replaces the default, idle render has no opacity override + the pressed-state contract is opacity 0.85 (no transform).

### A11y notes
- `accessibilityRole='button'`, `accessibilityLabel` defaults to `'Add a plant'`, `accessibilityHint` defaults to `'Long-press for quick diagnose'` ONLY when `onLongPress` is provided — announcing a long-press affordance that does nothing would be worse than silence.
- The `'longpress'` accessibility action is documented by RN as the Android TalkBack local-context-menu surface. iOS VoiceOver does not surface it as a discoverable rotor action; the iOS-side affordance is the hint announcement, and the E3-004 popover provides the accessible Quick Diagnose alternative path. Documented in the file header.
- 56×56 is the Material FAB default and exceeds the 44×44 a11y minimum, so `hitSlop` is not needed.

### Adversarial review (codex)
One round of `codex exec` adversarial review caught two P2 issues before ship:
- **P2** — `disabled` initially only gated the touch path. The accessibility-action path was still wired whenever `onLongPress` existed, meaning a TalkBack user could invoke the action via the actions menu while the visual control was gated off. Fixed: `accessibilityActions` and `onAccessibilityAction` are now also gated on `!disabled`. Test added.
- **P2** — comment originally implied VoiceOver could surface the `'longpress'` action as a screen-reader fallback. RN docs document this as Android-only (TalkBack actions menu); iOS VoiceOver has no equivalent rotor action. Comment + ticket footer updated to be accurate; the iOS-side affordance is the hint announcement, and the accessible Quick Diagnose path lands in E3-004's popover composition.
- **No P1s.** Tap-vs-hold race, 44×44 target size, cross-platform shadow, and conditional hint behavior all check out. Suggestions to add a draggable FAB / Reanimated press animation / speed-dial menu / replace `Pressable` with `TouchableHighlight` were rejected per V1 scope locks.

### Notes
- `fabStyles` is exported alongside `FAB` so the pressed-state contract (opacity 0.85, no transform) can be asserted directly. RN's `Pressable` resolves its function-style on render with `pressed: false`, so structurally inspecting the rule is the cleaner contract test than driving the press state through events that the test renderer doesn't propagate cleanly.
- The default `delayLongPress` (RN's 500ms) is preserved — no override. Faster delays misfire on slow taps; slower ones make the long-press feel unresponsive.

## [0.1.12.0] - 2026-05-04

E2-008 — `<EditorialButton>` primitive. The only button vocabulary in V1: outline (cream surface + hairline forest border + Fraunces forest label) and filled (forest fill + cream Fraunces label). Used on A-2's "Mark watered" / "Add note", A-3's "Save to garden" / "Done", A-4's "Add to garden", and the weekly review's "Got it." CTA. Built on RN's `Pressable` (the modern API; no TouchableOpacity). Tokens invert correctly between Conservatory (light) and Midnight (dark) by reading `theme.colors.surface`/`theme.colors.text` — no per-variant dark-mode branch, the token table in `DESIGN.md` is the source of truth and `darkTheme` already inverts surface/text.

### Added
- `apps/mobile/src/components/primitives/EditorialButton.tsx` — typed `EditorialButtonProps` with `variant`, `label`, `onPress`, optional `disabled`, `loading`, `accessibilityLabel`, `accessibilityHint`, `testID`. Border radius 8, padding 12v × 24h, Fraunces 600 semibold @ 16/20. `accessibilityRole='button'` always; `accessibilityState={{ disabled: disabled||loading, busy: loading }}` so VoiceOver/TalkBack announce the loading + disabled states correctly. Loading state renders `ActivityIndicator` colored to the button's foreground token instead of the label and disables `onPress`.
- `apps/mobile/src/components/primitives/index.ts` barrel.
- `apps/mobile/src/components/primitives/__tests__/EditorialButton.test.tsx` — 13 tests (43 total in the mobile suite). Coverage: outline + filled token resolution, onPress fires on tap, disabled + loading both block onPress, ActivityIndicator replaces the label while loading, accessibilityState surfaces both `disabled` and `busy`, hitSlop math reaches the 44px floor, accessibilityLabel defaults to label and accepts override, dark-mode token inversion via mocked `useTheme(darkTheme)`, testID forwarding, same-render double-tap latch (codex P2 — see below), and post-loading-flip press lockout.

### Adversarial review (codex)
One round of `codex exec` adversarial review found one issue before ship:
- **P2** — same-render double-tap race: two synchronous presses fired before the parent could flip `loading=true` would both invoke `onPress`, double-submitting mutations (e.g. two `watering_events` rows for one tap). Fixed via an internal `useRef` latch that drops every press after the first within a single tick; the latch clears on the next macrotask so the button stays responsive once the parent's `loading` state has settled. Test exercises both the synchronous double-tap drop and the post-clear recovery using `jest.useFakeTimers()`.
- **No P1s.** Token inversion path, Pressable's pressed-state callback typing, both `disabled` and `accessibilityState.disabled` being set, and the 44px hit-target math all checked clean. Font-loading is gated at the app shell (`app/_layout.tsx` already blocks render until `useFonts()` resolves), so the button doesn't need an independent fallback branch.

### Notes
- Hit target math: padding 12v + Fraunces line height 20 + padding 12v = 44px visual height; horizontal padding 24 × 2 = 48 + label width comfortably exceeds 44 on every real-copy CTA. `HIT_SLOP_V` is computed as `ceil((44 - (paddingV*2 + fontSize)) / 2)` so any future tighter padding (e.g. dropping line height to 18) keeps the effective target at 44 by widening hitSlop. With current values that resolves to 2 top + 2 bottom = a 48px effective touch area on the vertical axis. Test asserts `minHeight + top + bottom ≥ 44`.
- The double-tap latch lives inside the button rather than in every parent screen so the contract is "calling `onPress` is at-most-once-per-tick by construction." Parent screens still own the `loading=true` flip on the result of `onPress` to handle the slower async path; the latch only handles the synchronous burst.
- Pressable's `style` callback type (`StyleProp<ViewStyle> | ((state: PressableStateCallbackType) => StyleProp<ViewStyle>)`) is used directly — annotating the parameter with `PressableProps['style']` would lose the `{ pressed }` narrowing, so we let the function-form callback infer naturally.
- V1 scope locks held: no styled-components, no nativewind, no `<ThemeProvider>`, no additional variants beyond outline + filled, no leftIcon/rightIcon, no ghost or destructive variant. Pressable stays (TouchableOpacity is RN's legacy API).

## [0.1.11.0] - 2026-05-04

E2-006 — the three icon primitives that anchor PlantCare's visual vocabulary: `<Droplet>` (the watering metaphor, used by both the WATER TODAY chip on A-1/A-2 and the 7-day ledger row on A-2/A-6), `<LeafIcon>` (the SKIP-state metaphor on A-1/A-2), and `<HandOnSoilIcon>` (the CHECK-SOIL metaphor). All three are line-drawn deep-forest-on-cream — the "botanical field guide" treatment from `DESIGN.md` that's the load-bearing anti-AI-slop signal for this product. Implemented with `react-native-svg` rather than an icon font: V1 ships custom shapes that match the approved mockups exactly, not a re-skin of someone else's icon set.

### Added
- `apps/mobile/src/components/primitives/Droplet.tsx` — `<Droplet filled?: boolean; size?: number; testID?: string; accessibilityLabel?: string />`. Default size 16. Single classic teardrop path on a 24-unit canvas. `filled=true` paints the pale-blue `water` token (a watered day on the ledger / the active WATER TODAY chip); `filled=false` paints the `surface` token (cream in light, forest in dark) for outline-only droplets — same shape, different fill, one icon vocabulary.
- `apps/mobile/src/components/primitives/LeafIcon.tsx` — `<LeafIcon size?: number; testID?: string; accessibilityLabel?: string />`. Default size 14. Asymmetric leaf outline + central vein (the curve on the right side is fuller than the left — botanical, not heraldic). Always outline-only; the SKIP chip wrapper carries the sage accent.
- `apps/mobile/src/components/primitives/HandOnSoilIcon.tsx` — `<HandOnSoilIcon size?: number; testID?: string; accessibilityLabel?: string />`. Default size 14. Open palm + four short finger strokes above a shallow soil mound. At 14px the palm + soil pairing carries silhouette legibility; the fingers register as texture rather than countable digits.
- `apps/mobile/src/components/primitives/index.ts` — barrel export for the three primitives + their prop types. Future E2-007/008/009 primitives will land alongside.
- `apps/mobile/src/components/primitives/__tests__/icons.test.tsx` — 15 tests across the three icons. Mocks `useTheme()` per-suite (matching the `src/hooks/__tests__/useTheme.test.tsx` pattern), asserts default + custom sizes, verifies `filled` flips the Droplet's fill between `water` and `surface` tokens, asserts `strokeWidth=1` is preserved at every state, asserts the dark-mode case (mock returns `darkTheme`, fill payload swaps from cream to forest with no code path change), and verifies `accessibilityLabel` forwards to the Svg root on every primitive. Total mobile tests: 45.
- `react-native-svg@15.15.3` — pinned exact to match Expo SDK 55's bundled native module rather than allowing patch drift via `^`. SDK-bundled native modules can behave differently in EAS dev clients vs Expo Go when the JS package version drifts from the pinned native one.

### Notes
- All token reads go through `useTheme()` at render time, so a system-theme flip from Conservatory → Midnight reskins every icon with no per-primitive dark-mode code. The fill on outline-only icons resolves to `theme.colors.surface` (cream in light, forest in dark) and the hairline resolves to `theme.colors.stroke` (forest in light, cream in dark) — the same Path nodes, mirrored treatment.
- Default sizes (16 for Droplet, 14 for Leaf and HandOnSoil) match the approved A-1/A-2 mockups: Droplet anchors the WATER TODAY chip and ledger row, the leaf and hand sit slightly tighter inside the SKIP and CHECK SOIL chips. Callers needing a different density (the watering ledger may bump Droplet to 20+ at a future iteration) pass `size`.
- `strokeWidth=1` is the hairline weight from the design system. At very small sizes on lower-DPR devices the hairline can fade slightly; the 14-16px defaults sit safely above that threshold and the chip wrapper carries semantic legibility independent of stroke contrast.
- Path constants live at module top, not inlined in JSX. Design QA can read the path data directly without grepping JSX.
- No `<ThemeProvider>` introduced — `useTheme()` reads `useColorScheme()` directly, consistent with the E2-001 lock.
- No icon font, no Lottie, no animation. V1 ships static SVG line drawings, full stop. Animation lives in E2-004 (`useReduceMotion()`); these primitives don't move.
- Codex adversarial review surfaced one P2 (version pin) which was addressed by pinning `react-native-svg` exactly to 15.15.3 instead of `^15.15.4`. No P1s.

## [0.1.10.0] - 2026-05-04

E2-005 — API client + `ApiResult<T>` discriminated union. Third mobile-foundation ticket of Epic E2. Locks the single transport surface every screen will call into for the four LLM proxy endpoints (identify, diagnose, consult, review). The reason this PR is short on lines but long on commentary is the kind enumeration: `'network' | 'timeout' | 'server' | 'layer1_reject' | 'low_confidence' | 'parse_error' | 'queued'`. Seven kinds, no `'unknown'` fallthrough. Each one drives a different copy block in the A-3 / A-5 error states; collapsing two of them would force the screen layer to re-derive the distinction from `message` strings, which is exactly the per-screen drift the master plan calls out (lines 682-705). Same rationale as the E1-003 `ConsultResponse` fork — when the parser, the router, the route handler, and the screen all need to switch on the same dimension, the dimension belongs in the type. 29 new client tests, 59 mobile tests total.

### Added
- `apps/mobile/src/api/types.ts` — locked `ApiResult<T>` discriminated union, plus the request types `IdentifyRequest`, `DiagnoseRequest`, `ConsultRequest` (= `ConsultRequestBody`), `ReviewRequest` (= `ReviewRequestBody`), and re-exports of the four response shapes from `@plantcare/api-types`. Two `ApiResult<T>` types coexist intentionally: the wire one in `@plantcare/api-types` (kinds: `success | queued | error | rate_limited | rejected_off_topic`) describes what the Cloudflare Worker emits as JSON; the mobile one in this file (kinds: the locked seven) describes what every screen sees after the client classifies network conditions and normalizes the response. Each layer owns the concerns it can observe — the backend can't know about TCP errors; the client can't know about server-side off-topic detection. The mapping happens once, in `client.ts`, and is the only place the wire shape leaks.
- `apps/mobile/src/api/client.ts` — `createApiClient({ baseUrl, deviceId, fetch?, getDeviceId? })` returning `{ identify, diagnose, consult, review }`. Each method returns `Promise<ApiResult<T>>`. Identify + diagnose send `multipart/form-data` (Content-Type unset so the runtime appends the boundary token); consult + review send JSON. All requests include `X-Device-Id`. AbortController-based timeout with a default of 20s and per-call `timeoutMs` override; the `timedOut` flag is set inside an `onabort` handler synchronously when the timer fires, so distinguishing `kind: 'timeout'` from `kind: 'network'` doesn't depend on `AbortError` instanceof checks (RN's fetch is inconsistent on that). No axios — RN ships fetch, FormData, AbortController; a transport library buys nothing and adds bundle weight + a version surface that drifts.
- `apps/mobile/src/api/index.ts` — barrel.
- `apps/mobile/src/api/__tests__/client.test.ts` — 29 tests covering: 2xx success passthrough, X-Device-Id header on every request, fetch TypeError → `network`, hang past timeout → `timeout` (and that fetch is actually aborted, not just resolved-as-timeout), per-call `timeoutMs` override, 500 → `server`, 429 with Retry-After numeric → `server` + `retry_after`, 429 with HTTP-date Retry-After → seconds-until-then, 200 with non-JSON body → `parse_error`, 200 with JSON that isn't an `ApiResult` shape → `parse_error`, empty 4xx body → `server`, multipart construction asserting structural Blob equivalence (Node's FormData wraps Blob into File so reference equality breaks), JSON body construction with and without `plant_context` for consult, JSON body construction for review with the week summary + plants array, backend `rejected_off_topic` → client `layer1_reject`, passthrough of backend bodies that already speak client kinds (`layer1_reject`, `low_confidence`, `parse_error`, `queued`), backend `kind: 'queued'` (ok:true wire) → client `kind: 'queued'` (ok:false), DI for fetch + getDeviceId, construction throws when neither deviceId nor getDeviceId is provided, runtime throws when getDeviceId resolves empty (programming error, not a soft network kind), trailing-slash baseUrl normalization, and the codex-fix regression tests called out below.

### Backend wire mapping (the only place the two `ApiResult` shapes meet)
The classifier in `client.ts` follows status-code precedence: 429 → `server` + `retry_after` (header wins, body's `retry_after_seconds` as fallback); 5xx → `server`; 4xx → trust the body's `kind` if it's already a client kind, otherwise map known backend kinds (`rate_limited`/`rejected_off_topic`/`error`), otherwise `server` (unstructured 4xx is deploy skew, not a malformed user request); 2xx → `{ ok: true, data }` for `kind: 'success'`, `{ ok: false, kind: 'queued' }` for `kind: 'queued'`, passthrough for already-client-kind bodies, otherwise `parse_error`. Backend's `kind: 'rejected_off_topic'` (off-topic consult notes today, future Layer-1 image gate) maps to client `kind: 'layer1_reject'` — same semantics, different name.

### Adversarial review (codex)
First-pass codex review surfaced three P2 findings, all addressed before ship:
- **P2** — `getDeviceId()` was awaited *before* the AbortController timer started, so a hung SQLite read could bypass `timeoutMs` entirely. Moved device-id resolution inside the timeout budget; added a regression test that resolves `getDeviceId` slower than `defaultTimeoutMs` and asserts `kind: 'timeout'`.
- **P2** — backend `kind: 'error'` (used by `_imageUpload.ts`, `_consultRequest.ts`, `_reviewRequest.ts` for `missing_image`, `invalid_json`, `service_unconfigured`, `missing_or_invalid_device_id`) was being mapped to client `kind: 'parse_error'`. These are real server-side rejections, not malformed responses. Remapped to `kind: 'server'` so the screen renders "we'll be back" copy instead of "garbled response" copy.
- **P2** — 429 responses dropped `retry_after_seconds` from the body when the `Retry-After` header was absent. The header is RFC-authoritative, but the wire-level `rate_limited` shape carries the field in the body for callers that can't read headers. Now: header preferred when both are present, body field as fallback when only the body has it.

Second-pass codex review came back clean — no new P1 or P2 findings. Type alignment with `packages/api-types/src/index.ts` verified.

### Rejected reviewer suggestions
- Collapse `'network'` and `'timeout'` into a single `'network_error'` kind. Locked per master plan. They differ in user intent (timeout = request reached the lab; network = couldn't reach it), in retry strategy (immediate vs check-connection-first), and in the copy the A-3 error states render. The screens forking on the difference is the whole reason the dimension is in the type.
- Drop `'queued'` because E7 (sync queue) hasn't shipped. Locked. Adding the variant later would force every screen's switch statement to grow simultaneously — a breaking change masquerading as an additive one. Locking the type now means E7 is purely additive on the runtime side.
- Add an `'unknown'` / `'other'` fallback kind. Defeats the union: any new failure mode would ship silently as "unknown" rather than forcing a structured response. Every fetch path lands in exactly one of the seven kinds, and the classifier has no fall-through arm.
- Replace fetch with axios. RN ships fetch + FormData + AbortController; the only thing axios buys is interceptors, which we don't want at this layer (retry/backoff is E7's job per V1 scope locks).

### Notes
- `'low_confidence'` is in the locked union but not generated by the client today. The current free→paid router on the backend hides low-confidence behind a degraded-fallback `data` payload (`source: 'free_failed'`, `species_slug: 'unknown'`); the kind is reserved for a future server-side gate that surfaces low confidence at the wire boundary. Locking it now means the screen switch already has the case when that gate ships.
- `'queued'` is similarly inert in this PR. The client surface accepts it from both the wire (forward-compat with a backend that adopts the client union) and from a future E7 sync drainer that short-circuits fetches when offline. The `200 + ok:true + kind:'queued'` wire shape (per `@plantcare/api-types`) is mapped to client `ok:false + kind:'queued'` because the screen needs to know "no data yet" without parsing a `queue_id`.
- Retry-After parsing supports both numeric delta-seconds and HTTP-date format per RFC 7231. HTTP-date is parsed via `Date.parse` and clamped at 0 (no negative retries) — covers backends that emit `"Retry-After: Tue, 04 May 2026 16:00:00 GMT"` instead of `"Retry-After: 30"`.
- No retry / no backoff in the client itself — that's E7's contract. The client surfaces `kind` faithfully and exits. Same for request signing / hmac / auth headers beyond `X-Device-Id` — V1 scope locks rule them out.

## [0.1.9.0] - 2026-05-04

E2-004 — `useReduceMotion()` hook. Third mobile-foundation ticket of Epic E2 (S size, depends only on E0-001). Reads the OS-level Reduce Motion preference via `AccessibilityInfo` and re-renders when the user toggles it in Settings. This is the seam the A-3 diagnose loading state will use to swap the 3-bucket pulsing copy (0-8s / 8-20s / 20s+) for a static line, and the gate every future transition/animation in the app will call before opting in to motion. 8 new mobile tests, 38 total.

### Added
- `apps/mobile/src/hooks/useReduceMotion.ts` — `useReduceMotion(): boolean`. Reads the initial value via `AccessibilityInfo.isReduceMotionEnabled()` (Promise<boolean>), subscribes to `'reduceMotionChanged'` for live updates, and removes the subscription on unmount. State defaults to `false` during the brief async window before the initial value resolves — matches the iOS factory default and is the harmless biased-toward-motion fallback per the master plan. A `mounted` flag guards the resolve path so an unmount mid-flight doesn't trigger a setState-on-unmounted warning. Promise rejection falls through to the `false` default rather than going unhandled, so a platform that fails to report a preference still produces a clean log.
- `apps/mobile/src/hooks/__tests__/useReduceMotion.test.tsx` — 8 tests against a `jest.mock('react-native', …)` of `AccessibilityInfo`, mirroring the `useColorScheme` mock pattern in `useTheme.test.tsx`. Coverage: default `false` before the async fetch resolves, `true` resolution propagates, `false` resolution stays put, listener flip true and back to false, subscription `.remove()` called exactly once on unmount, rejected initial fetch falls through to `false` with no console.error noise, late resolution after unmount doesn't fire setState (asserted via `console.error` spy — the warning React emits when this regresses).
- `apps/mobile/src/hooks/index.ts` — exports the new hook alongside `useTheme`.

### Adversarial review (codex)
- No P1/P2 findings. Codex verified the cleanup contract against `react-native@0.83.6` (the version pinned in `apps/mobile/package.json`): `AccessibilityInfo.addEventListener()` returns an `EmitterSubscription` with `.remove()`, so the destructor in the effect matches the runtime. The mounted-flag guard blocks the post-unmount-setState race. The `false` initial default and the lack of re-render churn (state only flips when the boolean actually changes) both stand.

### Notes
- No `Animated` polyfill, no global motion-context provider, no Storybook — V1 scope locks. Consumers will read `useReduceMotion()` directly at the call site (the diagnose loading component is the first consumer in E5-007).
- The `'reduceMotionChanged'` event name is the RN-stable identifier — same on iOS and Android. No platform branching needed.

## [0.1.8.0] - 2026-05-04

E2-003 — `usePlants()` CRUD hook. Third mobile-foundation ticket of Epic E2. With the schema landed in v0.1.7.0, the next thing every screen needs is a parameterized read/write surface over the `plants` table. This PR ships a stable callbacks object — `list` / `getById` / `create` / `update` / `archive` / `unarchive` / `remove` — backed by raw `expo-sqlite` (no ORM, per V1 scope lock). Two non-obvious decisions: (1) the data API is split into `createPlantsApi(executor)` so tests drive the same SQL bytes through a `better-sqlite3` adapter without booting Jest's RN environment, mirroring the migration test pattern; (2) `create()` and `update()` use `INSERT ... RETURNING` / `UPDATE ... RETURNING` rather than a write+read pair, so the returned row is by-definition the row produced by THIS write — codex's adversarial review caught the racey UPDATE-then-SELECT shape and the fix was a single-statement collapse. 53 mobile tests now passing (23 new for plants).

### Added
- `apps/mobile/src/db/types.ts` — `Plant` (post-marshalling, `is_indoor: boolean`), `PlantRow` (raw SQLite shape, `is_indoor: number`), `CreatePlantInput`, `UpdatePlantPatch`. snake_case throughout to mirror `schema.ts` exactly so a typo on either side is a type error rather than a silent column-not-found at runtime. `species_label` / `location` / `identify_confidence` are surfaced because they're already in the canonical schema even though the ticket spec only listed the trimmed column set; the type matches the table, not the spec.
- `apps/mobile/src/hooks/usePlants.ts` — `createPlantsApi(executor)` is the pure-data surface; `usePlants()` is a one-line `useMemo` over it that resolves the executor lazily via `openDb()`. Every value is bound (`?` placeholders), never interpolated. `update()`'s dynamic SET-fragment list is built from a closed allow-list (`UPDATE_COLUMNS`) so a hostile or mistyped patch key throws before any SQL is built. Boolean `is_indoor` marshals to `0|1` on write and back to `boolean` on read. `archive` / `unarchive` are the only entry points to the soft-delete state machine — `archived_at` isn't patchable via `update()`.
- `apps/mobile/src/hooks/__tests__/usePlants.test.tsx` — 23 tests against a `better-sqlite3`-backed `PlantsExecutor` adapter (same backend the migration tests use, chosen because CI runs on Node 20). Coverage: create round-trip + DB row matches returned Plant, `is_indoor` defaults to true → 1, `is_indoor=false` round-trips through `false ↔ 0`, `override_interval_days` persists when set + null when omitted, UUID auto-generation + caller-supplied id, empty species_slug rejected, list excludes archived by default, list({includeArchived: true}) returns all, list orders by `added_at DESC`, getById null on missing + round-trips on present, update returns the patched row + DB matches, update toggles `is_indoor` with INTEGER marshalling, update throws on unknown patch keys, update throws on missing id, empty patch is no-op re-read, archive sets `archived_at` + list excludes the row, unarchive clears `archived_at`, remove triggers FK CASCADE on `watering_events` (insert two events, remove plant, assert events gone), parameter binding defends against hostile id strings (`' OR '1'='1` no-ops), boolean round-trip across all four entry points, `PlantRow.is_indoor` is numeric per the type, plus the codex-P2 race-safety regression: a wrapping executor fires a hostile UPDATE between this caller's UPDATE and any subsequent SELECT — the test asserts the returned row reflects THIS caller's intent, structurally locking in `RETURNING` over a future read-after-write regression.
- Hook + db barrels updated to export the new public surface (`usePlants`, `createPlantsApi`, `Plant`, `PlantRow`, `CreatePlantInput`, `UpdatePlantPatch`, `PlantsExecutor`, `SqlBindValue`).

### Adversarial review (codex)
One round of `codex exec` adversarial review caught one issue before ship; a second round confirmed the fix.
- **P2** — `update()` was UPDATE-then-SELECT, not atomic: a concurrent `update()` on the same row could land between the two awaits and the returned `Plant` would reflect the other caller's patch instead of this one's. Fixed by switching `create()` and `update()` to single-statement `INSERT/UPDATE ... RETURNING` (SQLite has supported `RETURNING` since 3.35; both expo-sqlite's bundled SQLite and the better-sqlite3 test backend ship newer). Added a regression test that interleaves a hostile UPDATE through a wrapping executor and asserts the returned row still reflects this caller's intent — if the implementation ever regresses to UPDATE-then-SELECT the assertion fails.
- **Rejected** — none. V1 scope locks held: no Drizzle/Prisma/Kysely (raw SQL is the master plan stance), no `<ThemeProvider>`-style DB context (`openDb()`'s module memoization is the concurrency contract), no pulling forward E7 sync_queue logic into `usePlants` (E2-003 is plants-only).

### Notes
- The ticket spec listed `created_at` for the plants column; the canonical schema (shipped in E2-002) uses `added_at`. The type matches the schema. The watering engine still does millisecond math on `added_at` for E4-002 timezone-correctness.
- `crypto.randomUUID()` resolves through `globalThis.crypto` so the same code path works on Hermes (RN 0.74+) and Node 20+ (the test backend). If a target without it ever appears, swap to `expo-crypto`'s `randomUUID()`.
- `update()` re-reads via a plain SELECT only on the empty-patch path — there's no write to race against, so the read-only path can't return another caller's intent. The hot path (non-empty patch) is single-statement.
- `usePlants()`'s `useMemo` dep array is empty: `openDb()` is module-memoized, so the executor identity is stable across renders and components. Two simultaneous `usePlants()` calls share the same connection, and expo-sqlite serializes statements per its native module contract — no extra coordination needed at this layer.

## [0.1.7.0] - 2026-05-04

E2-002 — SQLite schema + migrations. Second mobile-foundation ticket of Epic E2. Local SQLite via `expo-sqlite` is the V1 storage layer — no cloud sync, no ORM, raw SQL. This PR ships all six tables (`plants`, `watering_events`, `photos`, `notes`, `diagnoses`, `sync_queue`), every index from the master plan plus two cascade-companion indexes surfaced in adversarial review, a versioned migration runner using SQLite's built-in `PRAGMA user_version`, and an `openDb()` that sets `PRAGMA foreign_keys = ON` at connection time so the FK constraints actually enforce. 30 mobile tests now passing (15 new for db).

### Added
- `apps/mobile/src/db/schema.ts` — single-source-of-truth SQL string for the V1 schema. Includes the WORKBACK additions on `plants` (`is_indoor INTEGER NOT NULL DEFAULT 1` with a `CHECK (is_indoor IN (0, 1))` bool guard, `override_interval_days INTEGER` nullable for the custom-watering-schedule toggle). All cascade FKs spelled out: `watering_events`, `photos`, `notes`, `diagnoses` ON DELETE CASCADE from `plants`; `diagnoses.photo_id` ON DELETE CASCADE from `photos`; `plants.hero_photo_id` ON DELETE SET NULL from `photos`. `sync_queue` is intentionally unconstrained (`ref_table` / `ref_id` are dynamic strings — the worker dispatches by table name).
- `apps/mobile/src/db/migrations.ts` — versioned migration runner. `runMigrations(db, migrations)` reads `PRAGMA user_version`, runs every pending migration in `version` order, each inside its own transaction so a partial failure rolls back both the schema mutation and the version bump. Validates the migration list at startup (positive integers, monotonic, no duplicates) — silently corrupted upgrade graphs are the worst kind of bug.
- `apps/mobile/src/db/db.ts` — `openDb()` opens `plantcare.db` via `expo-sqlite`'s `openDatabaseAsync`, runs `PRAGMA foreign_keys = ON` (SQLite default is OFF — without this, every FK constraint in the schema is inert), then runs migrations. Memoized: subsequent calls return the same `SQLiteDatabase` instance. Cache is dropped on failure so the next call retries instead of permanently returning a rejected promise.
- `apps/mobile/src/db/index.ts` — barrel.
- `apps/mobile/src/db/__tests__/migrations.test.ts` — 16 tests (30 total in the mobile suite). Drives the migration runner against a `better-sqlite3`-backed `SqlExecutor` adapter (chosen over `node:sqlite` because CI runs on Node 20 and `node:sqlite` is Node 22.5+). Coverage: all 6 tables created, all 8 indexes created, FK declarations match the contract per `PRAGMA foreign_key_list`, FK violation rejected when `foreign_keys = ON`, plant→watering_events and photo→diagnoses cascade deletes, `is_indoor` defaults to 1 + CHECK rejects out-of-range values, `idx_plants_active` and `idx_queue_drainable` partial indexes selected by the query planner via `EXPLAIN QUERY PLAN`, `idx_plants_hero_photo` selected for the photo-cascade lookup path, hero_photo_id correctly set to NULL on photo delete, `user_version` advances to target on first run and is no-op on re-open, transactional rollback when migration up() throws (verified via `user_version` stays at 0 + dropped table), and migration validation rejects duplicate / out-of-order / non-positive versions.
- `expo-sqlite@~15.2.0` runtime dep + `better-sqlite3@^12.9.0` dev dep (test backend only — the on-device build still goes through expo-sqlite).

### Adversarial review (codex)
Two rounds of `codex exec` adversarial review caught three issues before ship:
- **P1** — first-pass test imported `node:sqlite` which would have failed on CI's Node 20 runner. Switched to `better-sqlite3` (Node 20+ compatible). Local Node 25 hides this gap; CI doesn't.
- **P2** — missing `idx_diagnoses_photo` for the `diagnoses.photo_id REFERENCES photos(id) ON DELETE CASCADE` cascade lookup. Added.
- **P2** — missing `idx_plants_hero_photo` for the `plants.hero_photo_id REFERENCES photos(id) ON DELETE SET NULL` cascade lookup. Added as a partial index (`WHERE hero_photo_id IS NOT NULL`) since the SET NULL path only ever matches non-null rows.
- **Rejected** — codex's third-pass suggestion to remove `diagnoses.plant_id` as redundant with `photo_id -> photos.plant_id` violates V1 scope locks. The master plan explicitly defines both columns: `plant_id` is nullable for the Quick Diagnose flow where a photo isn't attached to a plant yet, and photos aren't reassigned between plants in V1 (no UI for that).

### Notes
- All timestamps are unix milliseconds (`INTEGER`). The watering engine does millisecond math, not calendar-day math, to survive DST flips and the international date line (E4-002 critical regression). INTEGER handles years 1970-2262 — well beyond any V1 user retention window.
- Soft-delete on `plants` uses `archived_at` rather than DELETE, so the `ON DELETE CASCADE` on watering_events / photos / notes / diagnoses doesn't wipe history when a plant is archived. The CASCADE only fires on the (currently uncommanded) hard delete path, where wiping history is the right behavior.
- `idx_plants_active` and `idx_queue_drainable` are partial indexes — they only contain the rows the app actually queries (`archived_at IS NULL` plants, `status = 'pending'` queue entries). Smaller than full indexes, and the planner picks them automatically when the query's WHERE clause matches the index predicate. EXPLAIN QUERY PLAN tests guard against accidental full-table scans.
- expo-sqlite's `SQLiteDatabase` class is structurally compatible with the `SqlExecutor` interface defined in `migrations.ts` — no cast needed at the `db.ts` call site. Tests exploit the same shape via a thin `better-sqlite3` adapter.

## [0.1.6.0] - 2026-05-04

E2-001 — `useTheme()` hook. First mobile-foundation ticket of Epic E2. Wraps `@plantcare/theme`'s already-shipped `lightTheme` (Conservatory) and `darkTheme` (Midnight Conservatory) constants in a one-line hook driven by RN's `useColorScheme()`. No `<ThemeProvider>` and no `useMemo` — module-level frozen constants give stable identity across renders, so RN re-renders consumers automatically when the OS appearance flips. Per the master plan: no manual theme override in V1; the OS decides.

### Added
- `apps/mobile/src/hooks/useTheme.ts` — `useColorScheme() === 'dark' ? darkTheme : lightTheme`. Anything else (`null`/`undefined` during cold start, `'unspecified'` on Android with no preference, `'light'`) falls through to light, matching the iOS factory default and DESIGN.md's cream-as-canonical-surface stance.
- `apps/mobile/src/hooks/__tests__/useTheme.test.tsx` — 7 tests: light → Conservatory, dark → Midnight, null/undefined/'unspecified' → light, reference stability across same-scheme renders, reference flip on scheme change. Mock widens RN's legacy `ColorSchemeName` (which incorrectly omits null in the public types) so the cold-start branches are exercised.
- `apps/mobile/src/hooks/index.ts` barrel.

### Notes
- The mock cast (`as unknown as jest.Mock<WidenedScheme, []>`) works around `react-native`'s legacy public-types entry declaring `useColorScheme(): ColorSchemeName` without `null | undefined`. The newer `types_generated/` entry is accurate, but the package's `"types"` field still resolves the legacy version. The runtime contract — null during cold start, undefined on background-resume — is real and tested.
- DOD criterion "<100ms theme switch via system setting" is structurally satisfied: RN re-renders `useColorScheme` consumers on `Appearance` change events, and the hook does no async work. Empirical measurement waits on a live mockup screen (E2-013 Component Garden).

## [0.1.5.0] - 2026-05-04

E1-005 — LLM eval harness. With all four endpoints (identify, diagnose, consult, review) sharing the tiered router, this PR adds the regression suite that catches contract drift on the parser + router state machine without burning OpenRouter quota on every push. Two-mode design: the default mock mode drives canned LLM JSON through the real router and asserts the parsed shape; a future EVAL_REAL_API=1 mode (scaffolded as `.todo`) will hit live OpenRouter and use the same fixtures as the ±10 confidence band baseline. The mock-mode bug-catchers are the snapshot files plus a per-endpoint `expectCallArgs` that validates the OpenRouter wire shape (kind, imageDataUrl/userMessage, system-prompt fragment, apiKey).

### Added
- `apps/backend/evals/` directory with 26 fixtures: identify (10 — 6 healthy + 2 partial + 1 low-light + 1 cat reject), diagnose (10 — 7 sick + 2 healthy + 1 cat reject), consult (5 — 4 plant-related + 1 off-topic reject), review (1 mixed-week with 6 plants). Each fixture pairs canonical LLM JSON with a baseline confidence used by the ±10 band assertion in real-API mode.
- `evals/eval-runner.ts` with `mockCalls(...outcomes)` (plays canned outcomes through `vi.fn<typeof callFree>()`), `assertConfidenceBand(name, actual, baseline)` (named drift errors that survive CI-log diffs), and `expectCallArgs(spy, i, expected)` — the silent-pass guard from the adversarial review. Argument-shape assertions catch regressions in `router.toCallArgs` (wrong `kind`, missing `imageDataUrl`, wrong system prompt, missing `apiKey`) that canned-response mocks would otherwise paper over.
- `apps/backend/vitest.eval.config.ts` — separate Node-pool config so evals run in 400ms without spinning up workerd. Default `vitest.config.ts` now scopes its workers-pool include to `test/**/*.test.ts` so the two suites stay separate.
- `bun run eval` and `bun run eval:watch` scripts on `@plantcare/backend`.
- Per-endpoint paid-escalation success tests for identify and diagnose (E1-005 adversarial review): free returns garbage, paid returns a parseable response, asserts `source='paid_escalated'` plus the parser shape contract on the paid arm. Without these, the paid-side parser could regress and every other eval would still pass.
- Aggregate snapshot per endpoint: parsed shape across all fixtures in a single `__snapshots__/*.snap` file, `latency_ms` stripped so timing nondeterminism doesn't pollute the diff. Surfaces parser drift in one visible block.
- Review-eval per-plant alignment assertion (`per_plant.length === request.plants.length`) — the catch from E1-004 adversarial review, now structurally enforced. The parser permits mismatched lengths; only the eval enforces the prompt-mandated 1:1 echo.
- Review-eval narrative length contract: 100 ≤ length ≤ 400 per the test plan and system prompt.
- Diagnose-eval reject-branch `fix_steps.length === 0` assertion (E1-005 adversarial P1): a parser bug returning instructions on an unidentified plant ('unknown' slug) would have shipped silently otherwise.

### Deferred (post-V1)
- Real-API mode (`EVAL_REAL_API=1`): scaffolded as `it.todo` placeholders for each endpoint. Image fixtures land alongside this mode in a follow-up PR. Requires real OpenRouter quota during runs.
- Eval coverage of `buildUserMessage` for consult/review: covered today by `test/consult.test.ts` and `test/review.test.ts` via the full Hono route handler with fetchMock. Eval scope is parser + router state machine, not request-body composition.
- Vitest eval-pool isolation: low practical risk at the current fixture count; revisit if the suite grows past 50 fixtures.

### Notes
- The off-topic consult fixture wording — "What's the best dog food for a labrador?" — was invented per the autonomous-build prompt's leeway. The original test plan example was "a question about my dog"; flag for review if a different shape better matches your dogfooding mix.

## [0.1.4.0] - 2026-05-04

E1-004 — last of four LLM proxy endpoints. The backend can now generate a weekly garden letter: mobile POSTs the past 7 days of plant counts (per-plant watering + skips + diagnoses), backend asks the free model first, escalates to paid on parse failure or low confidence, and returns the editorial Fraunces headline + one-paragraph narrative + per-plant observations that A-6 needs. Not yet wired to mobile (E9 will consume it). All four E1 endpoints — identify, diagnose, consult, review — now share the same tiered router; E1-005 (eval harness) is next.

### Added
- `POST /api/review` on the Cloudflare Worker. Accepts JSON body `{week_summary: {plants_total, watering_events, skip_events, diagnoses}, plants: [{species_slug, nickname?, watering_count, skip_count, had_diagnosis}]}` plus `X-Device-Id` header. plants array capped at 50, per-plant counts capped at 30, week totals capped at 300 — bounded so a hostile body can't blow up the prompt token count. Returns `ApiResult<ReviewResponse>`.
- `ReviewResponse` shape: `{headline, narrative, per_plant: [{species_slug, observation}], confidence, source, latency_ms}`. Headline ≤ 80 chars, narrative ≤ 400 chars (per the test plan's 100-400 range), each observation ≤ 200 chars. The mobile A-6 weekly review screen renders the headline + narrative as the editorial voice and pairs each observation with the local 7-day ledger for that plant.
- `SYSTEM_PROMPT_REVIEW` requiring `headline + narrative + per_plant + confidence`. Voice is editorial: "names the week's character, not its numbers"; narrative addresses the reader as 'you'; per_plant entries use the plant's nickname when present and interpret the data rather than echoing it. Empty plants array still returns a valid response with a "Ready when you are" nudge to add the user's first plant.
- `parseReview` with strict `per_plant` array validation: hostile entries (null, missing species_slug, missing observation, whitespace-only fields) are dropped silently; oversized observations truncated; missing or non-array `per_plant` triggers escalation rather than passing through.
- `routes/_reviewRequest.ts` JSON-body validator: `isBoundedInt` rejects fractional counts (would shift the LLM prompt), negative numbers, and over-cap values; nickname trimmed and length-capped; species_slug required and trimmed.
- 21 backend tests covering router boundaries (escalation on parse fail, escalation on low confidence, paid recommendation, free_failed degraded fallback), parser hostile-input cases (oversized inputs truncated to spec caps, mixed-quality per_plant entries dropped, missing per_plant triggers escalation), and HTTP-level JSON validation (missing/fractional/negative counts, oversized plants array, invalid plant entries). Total backend tests: 148.

### Changed
- `apps/backend/src/index.ts` registers `/api/review` alongside identify, diagnose, and consult. All four endpoints now share the `createLlmRouter<T>` factory and the same `IdentifySource` discriminator (`'free' | 'paid_escalated' | 'free_failed'`).
- `routes/_consultRequest.ts` comment updated: `_validation/` subdirectory deferred. Three flat `_*.ts` helpers (`_imageUpload`, `_consultRequest`, `_reviewRequest`) is still easier to find than three under a subdirectory; the regroup waits until a fourth helper or a real navigation pain point shows up.

### Deferred (post-V1)
- Per-plant observation eval — E1-005 will assert observation length and species_slug echoing against a fixture week. Not wired in this PR.
- `ReviewResponse.per_plant` ordering: parser preserves model-emitted order. Mobile A-6 will pair observations to plants by `species_slug` lookup rather than relying on positional order, so a model that reorders entries doesn't misattribute observations.

## [0.1.3.0] - 2026-05-04

E1-003 — third of four LLM proxy endpoints. The backend can now answer a free-text question about a specific plant: mobile POSTs a note (e.g. "I just repotted it") plus optional plant context, backend asks the free model first, escalates to paid on parse failure or low confidence. First text-only endpoint, and the first one with a structural off-topic rejection path so a hostile or irrelevant note ("recommend bleach", "tell me a joke") gets refused without burning a paid call. Not yet wired to mobile (E8 will consume it).

### Added
- `POST /api/consult` on the Cloudflare Worker. Accepts JSON body `{note, plant_context?}` plus `X-Device-Id` header. Note is 1-2000 chars after trim with the length cap applied before trim so a 100KB whitespace blob can't burn CPU. plant_context is optional and strictly validated per field (species_slug, is_indoor, override_interval_days as positive integer 1-365, watering_history capped at 7 entries). Returns `ApiResult<ConsultResponse>`.
- `ConsultResponse` is a discriminated union: `{kind: 'recommendation', revised_interval_days, reasoning, confidence, source, latency_ms}` for plant-care answers, or `{kind: 'rejected_off_topic', reason, source, latency_ms}` for off-topic notes. The route handler maps `rejected_off_topic` to `ApiResult.rejected_off_topic` at the wire boundary, so mobile callers get the same `ok: false, kind: 'rejected_off_topic'` shape they already handle.
- `SYSTEM_PROMPT_CONSULT` requiring the model to return JSON in one of two shapes, each tagged with an explicit `rejected: <bool>` discriminator. Rejection triggers are enumerated in the prompt: not plant-related, instruction-override attempts, harmful actions (bleach, gasoline, salting soil), and ambiguous notes.
- `parseConsult` with the rejection discriminator winning over recommendation keys — a hostile model that emits `{rejected: true, revised_interval_days: 1, reasoning: "water with bleach"}` still routes to rejection. Parser-level defenses cover NaN/Infinity confidence, fractional `revised_interval_days` clamping to [1, 30], reasoning truncation at 500 chars, rejection-reason truncation at 200 chars.
- 49 backend tests across consult router boundaries (rejection bypasses both confidence gate and budget gate, paid-side rejection collapses correctly, abort signal threading, system prompt isolation), parser hostile-input cases (prompt injection wrapped around valid JSON, missing/non-boolean discriminator, oversized inputs), and HTTP-level JSON validation (note bounds, plant_context shape, fractional override rejection). Total backend tests: 127.

### Changed
- `RouterInput` widened to a discriminated union: `{kind: 'vision', imageDataUrl}` for identify/diagnose, `{kind: 'text', userMessage}` for consult and the future review endpoint. `CallArgs` in `openrouter.ts` mirrors the shape; `callOpenRouter` switches on `kind` to build either the OpenRouter image_url content array or a plain string. Identify and diagnose call sites updated; their existing 78 tests stay green.
- `createLlmRouter` parser contract widened from `T | null` to `ParseResult<T> | null` where `ParseResult<T> = {kind: 'ok', value} | {kind: 'final', value}`. `null` still escalates (parse fail), `ok` is confidence-gated as before, `final` is terminal — bypasses both the confidence gate and the paid-escalation budget gate. Identify and diagnose parsers wrapped via an `asOk()` adapter so their `T | null` test surface is unchanged. The `WithConfidence` generic constraint dropped in favor of a defensive runtime `readConfidence(value)` that returns 0 (escalates) on a malformed `ok` parse rather than silently passing it through.
- `routes/_consultRequest.ts` is the JSON-body counterpart to `routes/_imageUpload.ts` — same `{ok, request | response}` return shape, same defense-in-depth ordering (device-id check before body read, length cap before trim, strict per-field validation). Two helpers in `routes/` is fine; an `_validation/` subdirectory waits until E1-004 makes it three.

### Deferred (post-V1)
- Anti-injection delimiter framing around the user note in the system prompt (e.g. `<user_note>...</user_note>` wrapping). Parser provides the structural backstop today; harden the prompt itself when E1-005 eval fixtures show measurable injection success.
- `ConsultRejection`'s in-process `source` and `latency_ms` fields drop on the wire (the `ApiResult.rejected_off_topic` variant doesn't carry them). Revisit when E8 mobile surfaces a need for either field on rejections.

## [0.1.2.0] - 2026-05-03

E1-002 — second of four LLM proxy endpoints. The backend can now diagnose a sick plant from a photo: mobile POSTs an image, backend asks a free vision model first, escalates to a paid model only when the free model can't answer confidently. Same tiered router as identify, different system prompt + response shape. Not yet wired to mobile (E5 will consume it).

### Added
- `POST /api/diagnose` on the Cloudflare Worker. Same multipart contract as `/api/identify` (image file + `X-Device-Id` header, MIME + magic-byte validation, 8MB ceiling). Returns `ApiResult<DiagnoseResponse>` with disease + confidence + severity + fix steps + alternatives + which model answered.
- `DiagnoseResponse` shape: `{disease_slug, disease_label, confidence, severity, fix_steps[], alternatives[], source, latency_ms}`. Healthy convention: `disease_slug='healthy'`, severity `'low'`, empty fix_steps. Cannot-tell convention: `disease_slug='unknown'` with confidence below 30.
- `parseDiagnose` with tolerant severity normalization — synonym map (`severe`→`high`, `moderate`→`medium`, `mild`→`low`) and ASCII-letter-run extraction so prose tails like `"high — likely fatal"` still match. Defaults to `'medium'` (not `'low'`) on garbage so serious diagnoses can't be silently downgraded. Cap of 8 fix_steps and 5 alternatives, each with early-exit and per-entry validation against hostile model output.
- 48 backend tests across diagnose router boundaries, parser edge cases (severity drift, fix_steps cap, malformed alternatives), and HTTP-level multipart validation. Total backend tests: 78.

### Changed
- `router.ts` refactored to a generic `createLlmRouter<T extends {confidence:number}>` factory. Both `identifyRouter` and `diagnoseRouter` are built on it; the abort/escalation/fallback state machine lives in one place. Behavior preserved for identify (existing 16 router tests stay green).
- `routes/identify.ts` and `routes/diagnose.ts` share a `parseImageUpload(c)` helper covering multipart parse, MIME allowlist, 8MB ceiling, magic-byte sniff, base64 conversion. Security-critical validation now lives in one file.
- `OPENROUTER_API_KEY` check now runs before multipart body read on both routes — a misconfigured Worker no longer burns memory parsing 8MB uploads it would immediately reject.

### Deferred (post-V1)
- **PV1-001** in WORKBACK.md: server-side cheap-model verifier to normalize/sanity-check `/api/diagnose` output. V1 handles severity drift via deterministic string normalization; verifier earns its keep only if the eval suite (E5-002) shows free-tier accuracy below 70% on fixtures.

## [0.1.1.0] - 2026-05-02

E1-001 — first of four LLM proxy endpoints. The backend can now identify a plant from a photo: mobile POSTs an image, backend asks a free vision model first, escalates to a paid model only when the free model can't answer confidently. Not yet wired to mobile (E2/E5 will consume it).

### Added
- `POST /api/identify` on the Cloudflare Worker. Accepts multipart/form-data (image + `X-Device-Id` header), validates MIME by both header and magic bytes, returns `ApiResult<IdentifyResponse>` with species + confidence + alternatives + which model answered.
- Tiered LLM router: free Llama 3.2 11B Vision (OpenRouter free tier) first, escalates to Claude 3.5 Sonnet on JSON parse failure or confidence below 70.
- `safeJsonParse` — string-literal-aware parser that recovers JSON from ` ```json ` fences, leading prose, and trailing commas without damaging string content.
- Caller-abort propagation: a disconnected client cancels the upstream OpenRouter call instead of burning the full free + paid timeout budget.
- 45 backend tests across router boundaries, parser edge cases, route validation, and OpenRouter abort behavior.
- `IdentifySource` discriminator (`free` / `paid_escalated` / `free_failed`) so the mobile A-3 result screen can render "I'm not sure" UX correctly when the backend returns a degraded fallback.

### Changed
- WORKBACK.md Epic E1 restructured: 10 tickets collapsed to 5. The four LLM proxy endpoints (identify / diagnose / consult / review) are now all in E1, sharing one router built once. KV-backed rate limit, escalation budget, `/api/budget`, Layer-1 classifier, and Layer-5 image gate moved to a Post-MVP deferred section per V1 scope lock (rate limit + budget tracked client-side in SQLite for V1).

## [0.1.0.0] - 2026-05-02

E0 Foundation & Tooling — first shippable scaffold of the V1 build. After this version, you can `git clone && bun install && bun run mobile:ios` and see a Conservatory-styled empty Plants list on a real iPhone or Simulator within ~10 minutes.

### Added
- Bun-workspace monorepo with `apps/mobile`, `apps/backend`, `packages/api-types`, `packages/theme`.
- Expo SDK 55 + Expo Router 5 mobile app aligned to the SDK manifest.
- Hono on Cloudflare Workers backend skeleton with vitest + `@cloudflare/vitest-pool-workers`.
- EAS development build profiles for iOS Simulator and Android device.
- CI on GitHub Actions: typecheck + jest (mobile) + vitest (backend) on every push and PR.
- Conservatory design tokens in `packages/theme` — light + Midnight dark palettes ported from `DESIGN.md`.
- Fraunces + Inter font loading via `@expo-google-fonts/*`, gated until both load to prevent system-font flash. Falls through to system fonts on load error so offline cold-start doesn't hang.
- Maestro smoke flow `.maestro/smoke-empty-plants.yaml` asserting the empty Plants list renders on launch.
- Project rules in `CLAUDE.md`, execution plan in `WORKBACK.md`, design system docs in `DESIGN.md`, master architecture plan + test plan in `plans/`, approved mockups (light + dark) in `designs/`.

### Changed
- Code review runs locally (`/codex review` + Claude adversarial via `/gstack-ship`) rather than in CI — no `OPENAI_API_KEY` repo secret needed.
