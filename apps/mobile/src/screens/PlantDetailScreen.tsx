/**
 * PlantDetailScreen — A-2 Plant detail composite (E4-005).
 *
 * The plant's biography page. Composes everything that already shipped on top
 * of the master-plan A-2 layout:
 *   - Hero photo (rounded `<HeroPhoto>` from E2-010)
 *   - Fraunces species headline + italic curly-quoted nickname
 *   - Status chip from `useWateringEngine()` (E4-001)
 *   - 7-day `<WateringLedger>` (E4-003)
 *   - Editorial action buttons: "Mark watered" (filled), "Edit details" (outline)
 *   - "Add note" button — RENDERED but HIDDEN behind `noteEnabled` (default false).
 *     E4-007 in WORKBACK.md is the explicit "hidden until E8" line; E8-004 will
 *     un-hide it when the AddNoteSheet wires up. The structure is here so E8-004
 *     is a one-prop flip rather than a re-layout.
 *   - 4-thumbnail `<PhotoTimeline>` (E4-004)
 *
 * # Prop interface — `{ plant: Plant; … }`, not `{ plantId: string }`.
 *
 * The parent (Plants list E3-003 / direct deep-link / shell route in E0-008)
 * already holds the `Plant` row when navigating in: A-1's PlantCard knows the
 * full row and can pass it down to avoid a redundant SQLite read on a screen
 * the user expects to render instantly. The hook layer
 * (`useWateringEngine(plant)`) only needs `species_slug + override_interval_days
 * + id` so the existing prop-passing convention from PlantCard composes
 * cleanly. Deep-link callers that only have an `id` should resolve via
 * `usePlants().getById(id)` in the route component (a thin wrapper) before
 * mounting this screen — keeps this composite pure and synchronous on the
 * happy path. Documented at the prop type and asserted by the tests.
 *
 * # AppState resume vs prop-refresh — chose pure prop-driven re-render.
 *
 * The brief offered two patterns: (a) AppState listener inside this screen
 * that re-queries the plant from SQLite on resume, or (b) accept a `refresh:
 * () => void` prop and let the parent decide. Chose (b) but with a stricter
 * shape — no `onRefresh` callback at all. The parent owns the data channel
 * and re-renders this screen with new `plant`, `wateringEvents`, and
 * `photos` props whenever it decides to refetch. `useWateringEngine` re-reads
 * the most-recent event on `plant.id` change; the ledger and timeline are
 * stateless wrt props, so a new `wateringEvents` array updates them
 * immediately.
 *
 * Why no callback at all (vs the originally-considered `onRefresh` prop):
 * codex review flagged that documenting a refresh seam without using it is
 * worse than not having one — it implies the screen does refetch work it
 * doesn't actually do. The parent (PlantsListScreen → routing layer →
 * E4-006 Mark-watered mutation) already owns the refetch trigger; passing
 * an unused callback into this screen would be cargo-cult. When E4-006
 * lands, the parent calls `usePlants().getById(plant.id)` after the INSERT
 * and re-renders; this screen needs zero changes to that flow.
 *
 * AppState listener: explicitly NOT here. The parent's PlantsListScreen
 * (E3-003) is responsible for resume policy across the whole list, and a
 * second listener inside this screen would duplicate that work or contradict
 * it. If a future ticket needs per-screen resume (e.g. notifications open
 * deep into A-2), the seam is one prop away.
 *
 * # Reading order + VoiceOver stops.
 *
 * The screen has a clear top-to-bottom reading order: hero photo → species
 * headline (header role) → nickname → last-watered subline → status chip →
 * 7-day ledger → action buttons → photo timeline. Each interactive element
 * (`<EditorialButton>` already declares `accessibilityRole='button'` + label)
 * is a single VoiceOver stop. The hero photo is `accessibilityRole='image'`
 * from `<HeroPhoto>`. The header block does NOT collapse its three Texts
 * into one combined stop — that pattern (`accessible={true}` on a wrapping
 * View) makes RN hide descendants from RTL queries and disables iOS rotor
 * "by header" navigation. Instead, each Text is its own stop in document
 * order; the curly-quoted nickname overrides its label to drop the
 * typographic glyphs (so VoiceOver says "Mona" not literal "left double
 * quotation mark Mona right double quotation mark"). Wave-1 double-read
 * lesson still applies inside StatusChip and the photo tiles, where the
 * same string would otherwise be read twice — not here, where three
 * different strings deserve three different stops.
 *
 * # Reduce-motion compliance.
 *
 * No animations in V1 (per master plan A-2 spec — hero photo loads with cream
 * skeleton, no shimmer; ledger and timeline are static). The reduce-motion
 * hook is read so that if any subsequent ticket adds a transition, it can gate
 * on `useReduceMotion()` without a refactor. Today the value is captured but
 * unused; documented so the next ticket doesn't strip it.
 *
 * # V1 scope locks (rejected at file design).
 *
 * - No SQLite mutation here. "Mark watered" calls `onMarkWatered()`; E4-006
 *   owns the watering_events INSERT. "Edit details" calls `onEditDetails()`;
 *   E6-006 owns the bottom sheet. "Add note" calls `onAddNote()`; E8-005
 *   owns the notes table write.
 * - No date-fns / dayjs / luxon / Temporal. The "last watered N days ago"
 *   line uses calendar-day deltas via the same `localDayDelta` strategy as
 *   PhotoTimeline, inlined here because lifting into a shared util crosses
 *   ticket boundaries (PhotoTimeline still owns its copy; sharing lands when
 *   E4-006 needs it too).
 * - No new dep / library / ScrollView refactor. The screen uses RN's
 *   `<ScrollView>` directly so deep gardens with many photos can scroll.
 * - No backend changes. Parent fetches; this screen renders.
 */
import { fonts } from '@plantcare/theme';
import { type ReactElement } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import {
  EditorialButton,
  HeroPhoto,
  StatusChip,
} from '../components/primitives';
import { PhotoTimeline, type PhotoEntry } from '../components/PhotoTimeline';
import { WateringLedger, type WateringEvent } from '../components/WateringLedger';
import { useReduceMotion } from '../hooks/useReduceMotion';
import { useTheme } from '../hooks/useTheme';
import { useWateringEngine } from '../hooks/useWateringEngine';
import type { Plant } from '../db/types';
import type { WateringStatus } from '../watering';

/** Map the engine's three states to the StatusChip variant vocabulary. */
function statusToChipType(s: WateringStatus): 'water' | 'skip' | 'soil' {
  if (s === 'water') return 'water';
  if (s === 'skip') return 'skip';
  return 'soil';
}

/**
 * Calendar-day delta in the device's local time zone. Same algorithm as
 * `PhotoTimeline.formatRelativeDate` — anchors each side to its local-midnight
 * (Y/M/D) and walks forward one calendar day at a time. Survives DST forward
 * (23h day) and DST backward (25h day) because the day-walk doesn't depend on
 * ms-per-day. The IDL case is handled the same way: a 19-hour-elapsed flight
 * still buckets as "1 day ago" if the local calendar advanced. The 3d-12h
 * regression fixture in the test file pins this contract: a watering 3 calendar
 * days + 12 hours back labels "3 days ago", not "4 days ago" or "3 days 12
 * hours ago".
 *
 * Returns 0 if `then` is on the same local day as `now` (or future). Caps
 * at 366 to avoid a runaway loop on bad clocks.
 */
function localDayDelta(thenMs: number, nowMs: number): number {
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
 * Format the "last watered" line shown beneath the species/nickname header.
 * Bucketing matches PhotoTimeline so the screen reads consistently:
 *   never  → 'Not watered yet'
 *   0      → 'Last watered today'
 *   1      → 'Last watered yesterday'
 *   2-13   → 'Last watered N days ago'
 *   14+    → 'Last watered <Mon D>' (toLocaleDateString)
 */
export function formatLastWatered(
  lastWateredAtMs: number | null,
  nowMs: number,
): string {
  if (lastWateredAtMs == null) return 'Not watered yet';
  const delta = localDayDelta(lastWateredAtMs, nowMs);
  if (delta === 0) return 'Last watered today';
  if (delta === 1) return 'Last watered yesterday';
  if (delta <= 13) return `Last watered ${delta} days ago`;
  const formatted = new Date(lastWateredAtMs).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
  return `Last watered ${formatted}`;
}

/**
 * Resolve the species headline. Prefers `species_label` (human "Monstera
 * deliciosa") with a fallback to the slug ("monstera_deliciosa" → "Monstera
 * Deliciosa"). The unknown species path falls through to "Unknown species" so
 * the headline never reads "Species_unknown" verbatim.
 */
export function resolveSpeciesHeadline(plant: Plant): string {
  if (plant.species_label && plant.species_label.trim() !== '') {
    return plant.species_label;
  }
  if (plant.species_slug === 'species_unknown') {
    return 'Unknown species';
  }
  // Slug fallback — replace underscores with spaces and Title Case.
  return plant.species_slug
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export type PlantDetailScreenProps = {
  /**
   * The Plant row. Parent (PlantsListScreen / deep-link route) is responsible
   * for fetching this; the screen does not re-read on its own. Documented
   * choice: the parent owns the read-cycle so AppState resume + Mark watered
   * mutation both flow through one channel (`onRefresh`).
   */
  plant: Plant;
  /**
   * Source URI for the hero photo. Parent resolves
   * `plant.hero_photo_id → photos.uri` and passes the file URI here so this
   * screen stays free of SQLite reads. `null` (no photo yet) renders the
   * cream skeleton from `<HeroPhoto>` (no broken-image fallback).
   */
  heroPhotoUri: string | null;
  /**
   * All watering events for this plant. Forwarded to `<WateringLedger>` which
   * filters to the last 7 local-tz days. Forwarded as `lastWateredAtMs` (max
   * `wateredAtMs`) into the headline copy.
   */
  wateringEvents: WateringEvent[];
  /** Up to N photos (component shows the 4 most-recent). */
  photos: PhotoEntry[];
  /** Fired when the user taps "Mark watered". E4-006 wires the mutation. */
  onMarkWatered: () => void;
  /** Fired when the user taps "Edit details". E6-006 wires the bottom sheet. */
  onEditDetails: () => void;
  /**
   * Fired when the user taps "Add note". Only invoked when `noteEnabled` is
   * true — the button is hidden by default per E4-007. E8-004 will flip the
   * flag and wire the AddNoteSheet.
   */
  onAddNote?: () => void;
  /**
   * Feature flag for the "Add note" button. Defaults to `false` per E4-007
   * ("hidden until E8 ships — do not render dead UI"). E8-004 will flip
   * this to `true` at the parent.
   */
  noteEnabled?: boolean;
  /** "Mark watered" loading state — E4-006 will pass `true` while the INSERT is in flight. */
  markWateredLoading?: boolean;
  /**
   * Test seam for `useWateringEngine` consumption — defaults to `Date.now()`
   * inside the relative-watered copy. The watering engine reads `Date.now()`
   * itself; this prop drives only the headline copy so 3d12h fixtures pin
   * deterministically.
   */
  nowMs?: number;
  testID?: string;
};

const HERO_ASPECT_RATIO = 4 / 3; // master plan A-2: photo block is 4:3, not full-bleed square.

export function PlantDetailScreen({
  plant,
  heroPhotoUri,
  wateringEvents,
  photos,
  onMarkWatered,
  onEditDetails,
  onAddNote,
  noteEnabled = false,
  markWateredLoading = false,
  nowMs,
  testID,
}: PlantDetailScreenProps): ReactElement {
  // E8-004 contract: flipping noteEnabled to true at the parent must un-hide
  // the button without further plumbing. If the callback is missing when the
  // flag is on, that's a parent-side bug — surface loudly in dev. In V1
  // production builds (__DEV__ === false) we fall back to a no-op so the user
  // never sees a thrown error from a misconfigured parent.
  if (noteEnabled && !onAddNote && typeof __DEV__ !== 'undefined' && __DEV__) {
    // eslint-disable-next-line no-console
    console.warn(
      'PlantDetailScreen: noteEnabled=true but onAddNote is undefined. ' +
        'E8-004 should pass a callback alongside the flag.',
    );
  }
  const theme = useTheme();
  // Captured for future animation gating per the file header. Reading the
  // value also keeps the hook in the dep graph so screen-level a11y telemetry
  // (future) can pick it up.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const reduceMotion = useReduceMotion();

  const status = useWateringEngine({
    id: plant.id,
    species_slug: plant.species_slug,
    override_interval_days: plant.override_interval_days,
  });

  const headline = resolveSpeciesHeadline(plant);

  // Most-recent watering event timestamp drives the headline subline.
  // O(n) over events; n is small (single-plant lifetime) so a sort isn't
  // worth the allocation.
  let lastWateredAtMs: number | null = null;
  for (const e of wateringEvents) {
    if (lastWateredAtMs == null || e.wateredAtMs > lastWateredAtMs) {
      lastWateredAtMs = e.wateredAtMs;
    }
  }
  const effectiveNow = nowMs ?? Date.now();
  const lastWateredCopy = formatLastWatered(lastWateredAtMs, effectiveNow);

  const heroLabel = `Photo of ${headline}${plant.nickname ? `, ${plant.nickname}` : ''}`;

  return (
    <ScrollView
      testID={testID}
      style={[styles.scroll, { backgroundColor: theme.colors.bg }]}
      contentContainerStyle={styles.content}
      // Reading order is naturally top-to-bottom in document order; no
      // accessibilityViewIsModal / accessibilityElementsHidden tweaks at the
      // root because we don't trap focus in a sub-region.
    >
      {/* Hero photo. HeroPhoto already owns its accessibilityRole='image' +
          accessibilityLabel, so this one View has no a11y identity of its own. */}
      <View style={styles.heroWrap} testID={testID ? `${testID}-hero` : undefined}>
        <HeroPhoto
          source={heroPhotoUri ? { uri: heroPhotoUri } : { uri: '' }}
          aspectRatio={HERO_ASPECT_RATIO}
          rounded={24}
          accessibilityLabel={heroLabel}
          testID={testID ? `${testID}-hero-photo` : undefined}
        />
      </View>

      {/* Headline block: species (header role) + italic nickname + small-caps
          last-watered subline. Each Text is its own VoiceOver stop in
          document order (species → nickname → last-watered) — matches the
          assigned reading order. The block carries an accessibilityLabel +
          testID for tests that want to assert the composed VO copy without
          collapsing children into a single stop. */}
      <View
        style={styles.headerBlock}
        testID={testID ? `${testID}-header` : undefined}
        accessibilityLabel={
          plant.nickname
            ? `${headline}, ${plant.nickname}, ${lastWateredCopy}`
            : `${headline}, ${lastWateredCopy}`
        }
      >
        <Text
          // Headline role keeps screen-reader navigation by-headline working
          // in the iOS rotor / TalkBack reading-controls.
          accessibilityRole="header"
          style={[styles.species, { color: theme.colors.text }]}
          testID={testID ? `${testID}-species` : undefined}
        >
          {headline}
        </Text>
        {plant.nickname ? (
          <Text
            // Italic curly-quoted nickname is its own stop. The label drops
            // the quote glyphs ("Mona") so VoiceOver doesn't pronounce the
            // typographic " / " — matches the editorial-voice intent
            // without leaking punctuation into speech.
            accessibilityLabel={plant.nickname}
            style={[styles.nickname, { color: theme.colors.text }]}
            testID={testID ? `${testID}-nickname` : undefined}
          >
            {/* Curly quotes are intentional editorial typography — DESIGN.md
                says "italic for plant nicknames in quotes". “ / ”
                render reliably across iOS + Android even when the user's
                font subset doesn't include Fraunces (Inter italic fallback
                still has them). */}
            {`“${plant.nickname}”`}
          </Text>
        ) : null}
        <Text
          style={[styles.lastWatered, { color: theme.colors.textMuted }]}
          testID={testID ? `${testID}-last-watered` : undefined}
        >
          {lastWateredCopy}
        </Text>
      </View>

      {/* Status chip — its own a11y stop ("Water today" / "Skip" / "Check soil"). */}
      <View style={styles.chipRow}>
        <StatusChip
          type={statusToChipType(status)}
          testID={testID ? `${testID}-status-chip` : undefined}
        />
      </View>

      {/* 7-day watering ledger. Owns its own accessibilityLabel
          ("7-day watering history") and per-column labels. */}
      <View style={styles.section}>
        <WateringLedger
          events={wateringEvents}
          nowMs={nowMs}
          testID={testID ? `${testID}-ledger` : undefined}
        />
      </View>

      {/* Action row — vertical stack on a phone screen. "Mark watered"
          (filled, primary) sits on top, "Edit details" (outline) below.
          The hidden "Add note" button is rendered only when noteEnabled
          is true; otherwise it's not in the tree at all (NOT just opacity
          0 — that would still expose to screen readers, defeats the
          E4-007 contract). */}
      <View style={styles.actions}>
        <EditorialButton
          variant="filled"
          label="Mark watered"
          onPress={onMarkWatered}
          loading={markWateredLoading}
          testID={testID ? `${testID}-mark-watered` : undefined}
        />
        <View style={styles.actionGap} />
        <EditorialButton
          variant="outline"
          label="Edit details"
          onPress={onEditDetails}
          testID={testID ? `${testID}-edit-details` : undefined}
        />
        {noteEnabled ? (
          <>
            <View style={styles.actionGap} />
            <EditorialButton
              variant="outline"
              label="Add note"
              // E8-004 will always pass onAddNote alongside noteEnabled. If
              // the parent flips the flag without the callback (a dev-time
              // bug), the button still renders and the press is a no-op so
              // the user never sees a crash. Codex P2 from E4-005 review.
              onPress={onAddNote ?? (() => undefined)}
              testID={testID ? `${testID}-add-note` : undefined}
            />
          </>
        ) : null}
      </View>

      {/* Photo timeline. Renders empty state on its own when photos is empty. */}
      <View style={styles.section}>
        <PhotoTimeline
          photos={photos}
          nowMs={nowMs}
          testID={testID ? `${testID}-photos` : undefined}
        />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
  },
  content: {
    paddingHorizontal: 24,
    paddingTop: 16,
    paddingBottom: 32,
  },
  heroWrap: {
    width: '100%',
    marginBottom: 20,
  },
  headerBlock: {
    marginBottom: 12,
  },
  species: {
    fontFamily: fonts.display.semibold,
    fontSize: 28,
    lineHeight: 34,
  },
  nickname: {
    fontFamily: fonts.display.italic,
    fontSize: 20,
    lineHeight: 26,
    fontStyle: 'italic',
    marginTop: 2,
  },
  lastWatered: {
    fontFamily: fonts.body.regular,
    fontSize: 13,
    lineHeight: 18,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    marginTop: 8,
  },
  chipRow: {
    flexDirection: 'row',
    marginBottom: 20,
  },
  section: {
    marginVertical: 16,
  },
  actions: {
    marginTop: 8,
    marginBottom: 8,
  },
  actionGap: {
    height: 12,
  },
});
