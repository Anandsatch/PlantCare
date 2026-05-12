// PlantCard — a single row in A-1 (Plants list). One composite, one
// pressable surface, one announcement.
//
// Layout (matches the A-1 mockup, light + dark):
//   [ square photo 64×64 ]  [ Fraunces species name           ]  [ StatusChip ]
//                           [ Fraunces italic nickname        ]
//                           [ Inter 'last watered N days ago' ]
//   ─────── hairline divider ───────
//
// # Status — pre-computed prop, not a per-row hook
//
// `useWateringEngine()` opens the SQLite db and runs an async `getFirstAsync`
// per plant. Calling it once per row in a list of N plants creates N parallel
// SQLite reads on every screen render and N un-orderable async resolves before
// the chip stabilizes.
//
// E3-003 (`<PlantsListScreen>`) is the right layer to compute status — a single
// effect that batches the watering reads (or, post-V1, a single SQL join) and
// hands each card its already-resolved status. So `<PlantCard>` accepts
// `status: WateringStatus` as a prop. The `'check_soil'` value the engine
// returns during its async load window maps cleanly to the `<StatusChip
// type='soil' />` neutral fallback, so a screen that hasn't finished loading
// still renders a sensible chip.
//
// # Last-watered relative copy — calendar-day local-tz walk, ms math only
//
// We mirror `<PhotoTimeline>`'s `formatRelativeDate` algorithm exactly:
// extract local Y/M/D from each timestamp and walk forward one calendar day at
// a time. This is the same boundary `<WateringLedger>` uses for day bucketing,
// and the same DST/IDL invariant `useWateringEngine` enforces (E4-001/E4-002):
// a photo at 2pm yesterday relative to 9am today is "Yesterday", not
// "1 day ago" (that bucket is reserved for 2-6 calendar days back). DST
// fall-back fixtures stay correct because the day-walk doesn't depend on
// ms-per-day.
//
// Buckets (chosen to match the A-1 mockup voice — "last watered 5 days ago",
// "last watered yesterday"):
//   null   → "Not yet watered"   (just-added plant; matches the engine's
//                                  null-history fallback)
//   0 days → "Last watered today"
//   1 day  → "Last watered yesterday"
//   2-13   → "Last watered N days ago"
//   14+    → "Last watered on {Mon D}"   (absolute via toLocaleDateString)
//
// V1 scope locks (do not add): date-fns / dayjs / luxon / Temporal API,
// `Math.floor((now - last) / 86_400_000)`, calendar-day floor of UTC ms,
// `<ThemeProvider>`, manual dark toggle, animation libraries, swipe actions,
// long-press menus, drag-to-reorder, ORM. The chip status enum stays at three
// values per the master plan (collapsing it is a rejected reviewer suggestion).

import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useReduceMotion } from '../hooks/useReduceMotion';
import { useTheme } from '../hooks/useTheme';
import type { WateringStatus } from '../watering';
import { HeroPhoto, StatusChip } from './primitives';

const PHOTO_SIZE = 64;
const PHOTO_RADIUS = 12;
const ROW_GAP = 12;
const PRESSED_SCALE = 0.98;

/** Map the engine's `WateringStatus` to the chip's `StatusKey`. */
function statusToChipType(status: WateringStatus): 'water' | 'skip' | 'soil' {
  switch (status) {
    case 'water':
      return 'water';
    case 'skip':
      return 'skip';
    case 'check_soil':
      return 'soil';
  }
}

/** Status → first-person label used inside the composed accessibilityLabel. */
function statusToA11yLabel(status: WateringStatus): string {
  switch (status) {
    case 'water':
      return 'water today';
    case 'skip':
      return 'skip watering';
    case 'check_soil':
      return 'check soil';
  }
}

/**
 * Local-calendar-day delta between two unix-ms timestamps. Identical
 * algorithm to `<PhotoTimeline>` and `<WateringLedger>`: anchor each side
 * to local midnight, walk forward one calendar day at a time.
 *
 * Returns 0 if `then` is on the same local calendar day as `now`, or in the
 * future relative to `now` (defensive clamp; users with bad clocks or
 * EXIF-poisoned photos still see "today" rather than negative-days).
 */
export function localDayDelta(thenMs: number, nowMs: number): number {
  const now = new Date(nowMs);
  const then = new Date(thenMs);

  const nowMidnight = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const thenMidnight = new Date(
    then.getFullYear(),
    then.getMonth(),
    then.getDate(),
  ).getTime();

  if (thenMidnight >= nowMidnight) return 0;

  let days = 0;
  let cursor = new Date(then.getFullYear(), then.getMonth(), then.getDate());
  // Cap at 366 to bound the loop; anything 14+ has already routed to absolute.
  while (cursor.getTime() < nowMidnight && days < 366) {
    cursor = new Date(
      cursor.getFullYear(),
      cursor.getMonth(),
      cursor.getDate() + 1,
    );
    days += 1;
  }
  return days;
}

/**
 * Hard-coded month names for the Hermes-without-Intl fallback. The 14+ bucket
 * formats as "Mon D" — using a tiny static table dodges the Hermes Intl gap
 * on older Android RN builds (the `<WateringLedger>` Intl-fallback test
 * codified this pattern; we use it here for symmetry).
 */
const MONTH_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

function formatAbsoluteShort(ms: number): string {
  // Try Intl first (gives correct output on locales where it's available).
  // Fall through to the static "Mon D" form if Intl throws or returns
  // anything falsy. The mock-throws regression test in PlantCard.test.tsx
  // pins this contract.
  try {
    const out = new Date(ms).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    });
    if (out) return out;
  } catch {
    // fall through to static
  }
  const d = new Date(ms);
  return `${MONTH_SHORT[d.getMonth()]} ${d.getDate()}`;
}

/**
 * Compose the human-readable last-watered line. Exported for tests so the
 * boundary cases are asserted directly without rendering.
 */
export function formatLastWatered(
  lastWateredAtMs: number | null,
  nowMs: number,
): string {
  if (lastWateredAtMs == null) return 'Not yet watered';
  const delta = localDayDelta(lastWateredAtMs, nowMs);
  if (delta === 0) return 'Last watered today';
  if (delta === 1) return 'Last watered yesterday';
  if (delta <= 13) return `Last watered ${delta} days ago`;
  // 14+ → absolute date. Mirrors PhotoTimeline's 14+ bucket. The Intl path
  // is wrapped in try/catch with a static "Mon D" fallback for older Android
  // RN builds where Hermes ships without full Intl (same fallback
  // policy as <WateringLedger>'s formatWeekday helper).
  return `Last watered on ${formatAbsoluteShort(lastWateredAtMs)}`;
}

/**
 * Compose the row-level VoiceOver/TalkBack announcement. Order is mockup
 * voice ("Monstera Mona, water today, last watered 5 days ago") — species
 * + nickname identifies the plant first, then the actionable status, then
 * the supporting context. When nickname is missing the species carries
 * identity alone; when species is missing (queued identify, see
 * master-plan offline section) the nickname carries it.
 */
export function composeAccessibilityLabel(input: {
  speciesLabel: string | null;
  nickname: string | null;
  status: WateringStatus;
  lastWateredAtMs: number | null;
  nowMs: number;
}): string {
  const { speciesLabel, nickname, status, lastWateredAtMs, nowMs } = input;
  const identityParts: string[] = [];
  if (speciesLabel) identityParts.push(speciesLabel);
  if (nickname) identityParts.push(nickname);
  // Both null is the queued-identify case ("?" placeholder per master plan);
  // VoiceOver still gets meaningful copy.
  const identity = identityParts.length > 0 ? identityParts.join(' ') : 'Unidentified plant';
  const statusLabel = statusToA11yLabel(status);
  const lastWatered = formatLastWatered(lastWateredAtMs, nowMs).toLowerCase();
  return `${identity}, ${statusLabel}, ${lastWatered}`;
}

/**
 * Compose the Pressable row style array. Exported for tests so the
 * reduce-motion branch is asserted directly without poking at RN's internal
 * Pressable lifecycle (RTL pre-resolves Pressable's function-style on
 * render and doesn't re-resolve on `fireEvent.pressIn`).
 *
 * Contract:
 *   - resting (pressed=false) → just the base row style
 *   - pressed + motion-allowed → base + opacity 0.92 + scale 0.98
 *   - pressed + reduce-motion  → base + opacity 0.92 ONLY (hard-disabled
 *                                scale, not damped)
 */
export function composePressableStyle(input: {
  base: object;
  pressed: boolean;
  reduceMotion: boolean;
}): object[] {
  const { base, pressed, reduceMotion } = input;
  if (!pressed) return [base];
  const opacityStyle = { opacity: 0.92 };
  if (reduceMotion) {
    return [base, opacityStyle];
  }
  return [base, opacityStyle, { transform: [{ scale: PRESSED_SCALE }] }];
}

export type PlantCardProps = {
  /**
   * Pre-resolved species headline. From `Plant.species_label` if present,
   * else a humanized form of `species_slug`. The screen owns this fallback;
   * the card just renders.
   */
  speciesLabel: string | null;
  /** User-supplied nickname (italic Fraunces under the species). */
  nickname: string | null;
  /**
   * Display source for the hero photo. `{ uri }` for FileSystem photos;
   * pass null for the queued-identify "?" placeholder (the parent renders
   * a fallback tile via `<HeroPhoto>`'s cream skeleton).
   */
  photoUri: string | null;
  /** Unix milliseconds of the plant's most recent watering event, or null. */
  lastWateredAtMs: number | null;
  /**
   * Pre-computed status from `useWateringEngine` (or the screen-level batch
   * resolver). The card maps this to a `<StatusChip>` type. See the file
   * header for why this is a prop and not an inline hook.
   */
  status: WateringStatus;
  onPress: () => void;
  /** Injected in tests for deterministic relative-date assertions. */
  nowMs?: number;
  testID?: string;
};

export function PlantCard({
  speciesLabel,
  nickname,
  photoUri,
  lastWateredAtMs,
  status,
  onPress,
  nowMs,
  testID,
}: PlantCardProps) {
  const theme = useTheme();
  const reduceMotion = useReduceMotion();

  const effectiveNow = nowMs ?? Date.now();
  const lastWateredCopy = formatLastWatered(lastWateredAtMs, effectiveNow);
  const a11yLabel = composeAccessibilityLabel({
    speciesLabel,
    nickname,
    status,
    lastWateredAtMs,
    nowMs: effectiveNow,
  });
  const chipType = statusToChipType(status);

  // Photo source: `{ uri }` when supplied, else null and HeroPhoto's cream
  // skeleton fills the tile (queued-identify shape).
  const photoSource = photoUri ? { uri: photoUri } : null;
  const photoA11y = speciesLabel
    ? `Photo of ${speciesLabel}`
    : nickname
      ? `Photo of ${nickname}`
      : 'Plant photo';

  // useMemo so the StyleSheet object only rebuilds when theme tokens flip
  // (light↔dark). Without it, every render allocates fresh style refs and
  // every <Text> child triggers a shallow style re-diff. Codex P3 from
  // E3-001 review.
  const styles = useMemo(
    () =>
      StyleSheet.create({
        row: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: ROW_GAP,
          paddingVertical: 12,
          paddingHorizontal: 16,
          backgroundColor: theme.colors.surface,
        },
        photo: {
          width: PHOTO_SIZE,
          height: PHOTO_SIZE,
          borderRadius: PHOTO_RADIUS,
          backgroundColor: theme.colors.bg,
          overflow: 'hidden',
        },
        content: {
          flex: 1,
          // Species + nickname + last-watered stack tight; the chip floats
          // to the right via the parent flex row's spaceBetween-by-alignment.
          gap: 2,
        },
        species: {
          fontFamily: 'Fraunces_600SemiBold',
          fontSize: 18,
          // E11-003: 18 × 1.44 = 26 (was 22, ratio 1.22 — Fraunces species
          // names like "Calathea orbifolia" need descender room at 310%).
          lineHeight: 26,
          color: theme.colors.text,
        },
        nickname: {
          fontFamily: 'Fraunces_400Regular_Italic',
          fontStyle: 'italic',
          fontSize: 14,
          // E11-003: 14 × 1.43 = 20 (was 18, ratio 1.29 — italic descenders).
          lineHeight: 20,
          color: theme.colors.text,
        },
        lastWatered: {
          fontFamily: 'Inter_400Regular',
          fontSize: 12,
          // E11-003: 12 × 1.5 = 18 (was 16, ratio 1.33).
          lineHeight: 18,
          color: theme.colors.textMuted,
          marginTop: 2,
        },
      }),
    [theme.colors.surface, theme.colors.bg, theme.colors.text, theme.colors.textMuted],
  );

  return (
    <Pressable
      onPress={onPress}
      accessible
      accessibilityRole="button"
      accessibilityLabel={a11yLabel}
      testID={testID}
      // Keep the row hit area at the visible 88px row height; no hitSlop
      // needed because the row is already comfortably above the 44×44 floor.
      style={({ pressed }) =>
        composePressableStyle({
          base: styles.row,
          pressed,
          reduceMotion,
        })
      }
    >
      <View
        style={styles.photo}
        // The Pressable owns the row's accessibility identity (single
        // announcement: "Monstera Mona, water today, last watered 3 days
        // ago"). HeroPhoto's wrapping View sets accessibilityRole="image" +
        // accessibilityLabel="Photo of {species}" — without this hide, iOS
        // VoiceOver can land on the inner image as a separate stop and
        // double-announce. Same pattern PhotoTimeline uses on its tile
        // wrapper to suppress nested HeroPhoto a11y.
        importantForAccessibility="no-hide-descendants"
        accessibilityElementsHidden
      >
        {photoSource ? (
          <HeroPhoto
            source={photoSource}
            aspectRatio={1}
            rounded={PHOTO_RADIUS}
            accessibilityLabel={photoA11y}
          />
        ) : null}
      </View>
      <View style={styles.content}>
        <Text
          // Inner texts are non-accessible because the parent Pressable owns
          // the announcement. This prevents VoiceOver double-reading
          // ("Monstera, Monstera Mona, water today…") — the Wave 1 lesson
          // from StatusChip.
          accessible={false}
          allowFontScaling
          numberOfLines={1}
          ellipsizeMode="tail"
          style={styles.species}
          testID={testID ? `${testID}-species` : undefined}
        >
          {speciesLabel ?? '?'}
        </Text>
        {nickname ? (
          <Text
            accessible={false}
            allowFontScaling
            numberOfLines={1}
            ellipsizeMode="tail"
            style={styles.nickname}
            testID={testID ? `${testID}-nickname` : undefined}
          >
            {/* Quoted per DESIGN.md "Italic for plant nicknames in quotes"
                and the A-1 mockup (e.g. 'Mona' / 'Moonshine'). The
                accessibilityLabel composer keeps the unquoted form so
                VoiceOver reads "Monstera Mona" not "Monstera 'Mona'". */}
            {`‘${nickname}’`}
          </Text>
        ) : null}
        <Text
          accessible={false}
          allowFontScaling
          style={styles.lastWatered}
          testID={testID ? `${testID}-last-watered` : undefined}
        >
          {lastWateredCopy}
        </Text>
      </View>
      {/* StatusChip's outer View carries `accessible accessibilityLabel`
         (the chip's own "Water today" fallback). Inside the row, the
         Pressable owns the announcement — wrap the chip in a hide-from-AT
         View so VoiceOver doesn't announce "Water today" again after the
         row label. Same fix shape PhotoTimeline applies to nested HeroPhoto. */}
      <View
        importantForAccessibility="no-hide-descendants"
        accessibilityElementsHidden
      >
        <StatusChip type={chipType} testID={testID ? `${testID}-chip` : undefined} />
      </View>
    </Pressable>
  );
}

// Hairline divider for inter-row separation lives at the screen layer
// (`<FlatList ItemSeparatorComponent>` on PlantsListScreen, E3-003). The
// card stays composable.
