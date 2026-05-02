# PlantCare E2E (Maestro)

End-to-end UI testing via [Maestro](https://maestro.mobile.dev/). One YAML flow per critical user journey. Maestro auto-detects whichever device or simulator is currently booted.

## Prerequisites

1. **EAS development build installed** on the target device/simulator (see [`README.md`](../README.md) and ticket `E0-002`). Maestro drives the dev build by `appId`, so the app must already be installed and launchable.
2. **`maestro` CLI installed** locally (one-time):

   ```sh
   curl -Ls "https://get.maestro.mobile.dev" | bash
   ```

   Then add `~/.maestro/bin` to your `PATH`. Verify with `maestro --version`.

## Running the flows

From the repo root:

```sh
# Run every flow against the currently booted device/simulator
maestro test .maestro/

# Run a single flow
maestro test .maestro/smoke-empty-plants.yaml
```

### iOS Simulator

1. Boot a simulator (`xcrun simctl boot "iPhone 15"` or via Xcode).
2. Install the dev build (`bun run mobile:ios` or `eas build --profile development --platform ios` then drag the `.app` onto the simulator).
3. `maestro test .maestro/smoke-empty-plants.yaml`.

### Android device (Anand's dogfood phone)

1. Plug the device in, enable USB debugging, accept the host RSA fingerprint.
2. Verify it shows up: `adb devices` should list it as `device` (not `unauthorized`).
3. Install the dev build (`eas build --profile development --platform android` and side-load the APK, or `bun run mobile:android`).
4. `maestro test .maestro/smoke-empty-plants.yaml` — Maestro picks the connected device automatically.

If both an iOS simulator and an Android device are connected, pass `--device <id>` (find IDs with `maestro devices`).

## Bundle ID

The `appId` in every flow must match `apps/mobile/app.json` → `expo.ios.bundleIdentifier` / `expo.android.package`. Currently:

```
com.anandsatch.plantcare
```

If this changes, update every flow in this directory.

## Authoring conventions

- **Use stable `testID`s, not visible strings, as the primary selector.** Strings rotate when copy is tweaked; `testID`s do not. Add a fallback `assertVisible: "<copy>"` so review-stage copy regressions still get caught.
- **One flow per file.** Name flows after the user journey (`add-first-plant.yaml`, `weekly-review.yaml`), not the screen.
- **Keep flows < 30s.** If a journey is longer, split it across `runFlow:` includes.
- **Don't depend on network.** Stub or pre-seed SQLite if a later flow needs prior state.

## Current flows

| File | Journey | Owner ticket |
|------|---------|--------------|
| `smoke-empty-plants.yaml` | App launches, empty Plants list visible | E0-006 |

E12 will add the remaining 8 critical-journey flows (add-first-plant, diagnose, weekly review, etc.). See `WORKBACK.md` § E12.
