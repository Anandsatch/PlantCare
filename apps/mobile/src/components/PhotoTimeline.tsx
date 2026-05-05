// PhotoTimeline — 4-thumbnail row used at the bottom of A-2 (plant detail).
//
// Renders up to 4 most-recent photos as small <HeroPhoto> tiles with a relative
// date label below each. Empty state explains how photos appear (Diagnose / Mark
// watered) so users see how content will fill in. Composition with note entries
// lives in E8 — this ticket is photos-only.
//
// Date bucketing — `formatRelativeDate(takenAtMs, nowMs)`:
//   - Bucket by *local calendar day*, not 24h-since-now. A photo at 2pm
//     yesterday relative to 9am today reads "Yesterday" (one calendar day
//     back), not "1 day ago" (less than 24h ago). We compute the calendar-day
//     delta by extracting local Y/M/D from each timestamp and walking forward
//     one day at a time. This is identical to the strategy <WateringLedger>
//     will adopt for its 7-day grid: anchor to the device's current locale,
//     not UTC.
//   - This is also what makes the DST regression test pass: a photo taken
//     2 calendar days ago across a DST fall-back boundary still buckets as
//     "2 days ago", not "1 day ago", because the day-walk doesn't depend on
//     ms-per-day.
//   - Buckets:
//       0 → "Today"
//       1 → "Yesterday"
//       2-6 → "{N} days ago"
//       7-13 → "1 week ago"
//       14+ → toLocaleDateString({ month: 'short', day: 'numeric' }) → "May 4"
//   - Future timestamps (clock skew, photos with bad EXIF) clamp to "Today".
//
// V1 scope locks (do not add): note entries, "+N more" pill, animations,
// lazy image loading, date-fns / luxon / dayjs, custom locale overrides.

import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../hooks/useTheme';
import { HeroPhoto } from './primitives';

const MAX_PHOTOS = 4;
const THUMB_SIZE = 64;
const THUMB_GAP = 12;
const THUMB_RADIUS = 12;

export type PhotoEntry = {
  id: string;
  uri: string;
  takenAtMs: number;
  accessibilityLabel?: string;
};

export type PhotoTimelineProps = {
  /** Any length; component shows up to 4 most-recent (sorted by takenAtMs desc). */
  photos: PhotoEntry[];
  onPhotoPress?: (photo: PhotoEntry) => void;
  /** For relative-date formatting; default Date.now(). Injected in tests. */
  nowMs?: number;
  accessibilityLabel?: string;
  testID?: string;
};

/**
 * Compute the calendar-day delta between two timestamps in the device's local
 * time zone. Returns 0 if `then` is on the same local day as `now` (or in the
 * future relative to `now`). Day-walks rather than dividing by ms-per-day so
 * DST boundaries don't shift the bucket.
 */
function localDayDelta(thenMs: number, nowMs: number): number {
  const now = new Date(nowMs);
  const then = new Date(thenMs);

  // Anchor each side to its local-midnight reading (Y/M/D only).
  const nowMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const thenMidnight = new Date(
    then.getFullYear(),
    then.getMonth(),
    then.getDate(),
  ).getTime();

  if (thenMidnight >= nowMidnight) return 0;

  // Walk forward one calendar day at a time. Caps at 31 days because anything
  // 14+ falls into the absolute-date branch and the exact value stops mattering.
  let days = 0;
  let cursor = new Date(then.getFullYear(), then.getMonth(), then.getDate());
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

export function formatRelativeDate(takenAtMs: number, nowMs: number): string {
  const delta = localDayDelta(takenAtMs, nowMs);
  if (delta === 0) return 'Today';
  if (delta === 1) return 'Yesterday';
  if (delta <= 6) return `${delta} days ago`;
  if (delta <= 13) return '1 week ago';
  // 14+ days → absolute "May 4". Hermes-on-Android ships with full-Intl
  // since RN 0.74; we rely on that. If a future runtime regresses this,
  // the test suite catches it before ship.
  return new Date(takenAtMs).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

function sortMostRecent(photos: PhotoEntry[]): PhotoEntry[] {
  // Stable sort by takenAtMs desc; ties resolved by id so render order is
  // deterministic when two photos share a millisecond.
  return [...photos].sort((a, b) => {
    if (b.takenAtMs !== a.takenAtMs) return b.takenAtMs - a.takenAtMs;
    return a.id.localeCompare(b.id);
  });
}

export function PhotoTimeline({
  photos,
  onPhotoPress,
  nowMs,
  accessibilityLabel = 'Photo timeline',
  testID,
}: PhotoTimelineProps) {
  const theme = useTheme();
  const effectiveNow = nowMs ?? Date.now();

  const styles = StyleSheet.create({
    container: {
      flexDirection: 'row',
      flexWrap: 'nowrap',
      gap: THUMB_GAP,
    },
    empty: {
      fontFamily: 'Inter_400Regular',
      fontSize: 13,
      fontStyle: 'italic',
      color: theme.colors.textMuted,
    },
    tile: {
      width: THUMB_SIZE,
    },
    thumb: {
      width: THUMB_SIZE,
      height: THUMB_SIZE,
    },
    caption: {
      fontFamily: 'Inter_400Regular',
      fontSize: 11,
      color: theme.colors.textMuted,
      marginTop: 6,
      textAlign: 'left',
    },
  });

  if (photos.length === 0) {
    return (
      <View accessibilityLabel={accessibilityLabel} testID={testID}>
        <Text style={styles.empty} testID={testID ? `${testID}-empty` : undefined}>
          No photos yet — capture one when you Diagnose or Mark watered
        </Text>
      </View>
    );
  }

  const visible = sortMostRecent(photos).slice(0, MAX_PHOTOS);
  // V1 always renders up to MAX_PHOTOS in a non-scrolling flex row. The "see
  // all" affordance for plants with deeper history lands in E4-005
  // (PlantDetailScreen), not here.

  return (
    <View
      accessibilityLabel={accessibilityLabel}
      testID={testID}
      style={styles.container}
    >
      {visible.map((photo) => {
        const label = formatRelativeDate(photo.takenAtMs, effectiveNow);
        const a11yLabel = photo.accessibilityLabel ?? `Photo from ${label}`;
        const isInteractive = !!onPhotoPress;

        // When wrapped in Pressable, the Pressable owns the a11y identity
        // (role='button' + label). The inner HeroPhoto wrapper still has
        // its own accessibilityLabel because the prop is required, but we
        // hide it from screen readers via importantForAccessibility on a
        // wrapping View so VoiceOver/TalkBack announces once, not twice.
        const inner = (
          <View
            style={styles.thumb}
            importantForAccessibility={isInteractive ? 'no-hide-descendants' : 'auto'}
            accessibilityElementsHidden={isInteractive}
          >
            <HeroPhoto
              source={{ uri: photo.uri }}
              aspectRatio={1}
              rounded={THUMB_RADIUS}
              accessibilityLabel={a11yLabel}
            />
          </View>
        );

        return (
          <View key={photo.id} style={styles.tile}>
            {isInteractive ? (
              <Pressable
                onPress={() => onPhotoPress!(photo)}
                accessibilityRole="button"
                accessibilityLabel={a11yLabel}
                testID={testID ? `${testID}-tile-${photo.id}` : undefined}
              >
                {inner}
              </Pressable>
            ) : (
              inner
            )}
            <Text style={styles.caption}>{label}</Text>
          </View>
        );
      })}
    </View>
  );
}
