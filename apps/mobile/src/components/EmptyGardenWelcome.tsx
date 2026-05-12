/**
 * EmptyGardenWelcome — Day 1 / zero-plants card on the Plants list (A-1).
 *
 * Per the master plan (`Plants list (A-1)` § "Day 1 / zero plants"):
 *   "Centered cream card. Line-drawn deep-forest illustration of a potted
 *    plant. Fraunces headline 'Welcome to your garden'. Inter body 'Snap a
 *    photo of any plant to add it.' Solid forest CTA 'Add my first plant'
 *    launches camera capture. The floating '+' FAB is hidden until 1+
 *    plants exist."
 *
 * --- INTERIM IMPLEMENTATION NOTES (V1 scaffolding) ---
 *
 * 1) Illustration — emoji fallback.
 *    The spec calls for a line-drawn forest-stroke potted plant illustration.
 *    That ships with the icon primitives in E2-006, which depend on
 *    `react-native-svg`. As of this PR (E3-002) `react-native-svg` is NOT in
 *    `apps/mobile/package.json` — adding it here would smear scope across two
 *    tickets. Interim: render the Unicode "🪴" potted-plant emoji at fontSize
 *    64. Cross-platform consistency is acceptable for the empty state (this is
 *    a one-off Day-1 surface, not a system primitive).
 *    SWAP-WHEN: E2-006 lands `react-native-svg` and a `<PottedPlantIllustration />`
 *    primitive — replace the emoji <Text> with the SVG component, drop the
 *    inline accessibilityLabel hack, and remove this comment block.
 *
 * 2) CTA — inline-styled Pressable.
 *    The CTA is meant to use `<EditorialButton variant='filled' />` which
 *    ships in E2-008. To unblock the Day-1 visual ahead of E2-008, the CTA
 *    here is an inline-styled Pressable matching the filled variant from
 *    DESIGN.md (forest fill = `theme.colors.primary`, cream label =
 *    `theme.colors.surface`, 14×24 padding, 8px radius, button role).
 *    SWAP-WHEN: E2-008 merges — replace the inline Pressable with
 *    `<EditorialButton variant='filled' label='Add my first plant'
 *    onPress={onAddFirst} />` and delete the inline CTA styles.
 *
 * --- HARD V1 SCOPE LOCKS (do not add here) ---
 * - No <ThemeProvider> wrapper. Hooks consume `useTheme()` directly per the
 *   master plan's theme contract.
 * - No navigation logic embedded. The parent screen (E3-003 PlantsListScreen)
 *   wires `onAddFirst` to the camera capture route.
 * - No animations. The card is static; reduce-motion is a non-concern.
 */

import { useTheme } from '../hooks/useTheme';
import { Pressable, StyleSheet, Text, View } from 'react-native';

export type EmptyGardenWelcomeProps = {
  /** Fired when the user taps the CTA. Parent should launch camera capture (A-5). */
  onAddFirst: () => void;
  /** Optional testID forwarded to the outer card View. */
  testID?: string;
};

export const HEADLINE_TEXT = 'Welcome to your garden';
export const BODY_TEXT = 'Snap a photo of any plant to add it.';
export const CTA_LABEL = 'Add my first plant';

const ILLUSTRATION_TEST_ID = 'empty-garden-illustration';
const CTA_TEST_ID = 'empty-garden-cta';

export function EmptyGardenWelcome({ onAddFirst, testID }: EmptyGardenWelcomeProps) {
  const { colors } = useTheme();

  return (
    <View
      testID={testID}
      style={[
        styles.card,
        { backgroundColor: colors.surface },
      ]}
    >
      <Text
        testID={ILLUSTRATION_TEST_ID}
        // The emoji *is* the illustration; the screen reader gets a
        // human-meaningful label rather than "potted plant emoji".
        accessibilityLabel="Potted plant illustration"
        accessible
        // E11-003: pin the decorative glyph at its design-time size. The
        // flowing copy (headline/body/CTA) below still scales with the
        // user's Dynamic Type preference up to 310%.
        allowFontScaling={false}
        style={styles.illustration}
      >
        {'🪴'}
      </Text>

      <Text
        accessibilityRole="header"
        style={[styles.headline, { color: colors.text }]}
      >
        {HEADLINE_TEXT}
      </Text>

      <Text style={[styles.body, { color: colors.textMuted }]}>
        {BODY_TEXT}
      </Text>

      <Pressable
        testID={CTA_TEST_ID}
        onPress={onAddFirst}
        accessibilityRole="button"
        accessibilityLabel={CTA_LABEL}
        // 44×44 minimum hit area is satisfied by the 14+14 vertical padding +
        // 16px line height (= 44px) and the horizontal padding + label width.
        // hitSlop is a belt-and-braces guard against future label shrink.
        hitSlop={8}
        style={({ pressed }) => [
          styles.cta,
          { backgroundColor: colors.primary, opacity: pressed ? 0.85 : 1 },
        ]}
      >
        <Text style={[styles.ctaLabel, { color: colors.surface }]}>
          {CTA_LABEL}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    // Self-contained narrow-viewport guarantee (codex P2 fix): the previous
    // version combined `width: '100%'` with `marginHorizontal: 16`, which
    // in RN flex layout produces a footprint of parent-width + 32 — that
    // overflows on a 280px viewport regardless of what the parent supplies.
    // Now: card sizes to content (which is in turn bounded by paddingHorizontal
    // 32 + maxWidth 360), centers via alignSelf, and uses no horizontal
    // margin. Parent screen is responsible for outer page padding; the card
    // never overflows its own parent on its own.
    alignSelf: 'center',
    maxWidth: 360,
    paddingVertical: 32,
    paddingHorizontal: 32,
    borderRadius: 16,
    alignItems: 'center',
  },
  illustration: {
    // E11-003: the "🪴" emoji is a decorative chrome glyph. The Text node
    // that renders it carries `allowFontScaling={false}` so it stays
    // anchored at 64pt regardless of the user's Dynamic Type setting; the
    // flowing headline/body/CTA copy below still scales normally.
    fontSize: 64,
    lineHeight: 72,
    marginBottom: 8,
    textAlign: 'center',
  },
  headline: {
    // Fraunces ships in E0-005. The font family token will swap in via the
    // typography pass — string-literal here matches the convention used by
    // the existing app/_layout.tsx font gate.
    fontFamily: 'Fraunces_600SemiBold',
    fontSize: 28,
    // E11-003: 28 × 1.43 = 40 (was 34, ratio 1.21).
    lineHeight: 40,
    textAlign: 'center',
    marginVertical: 16,
  },
  body: {
    fontFamily: 'Inter_400Regular',
    fontSize: 16,
    lineHeight: 24,
    textAlign: 'center',
    marginBottom: 24,
  },
  cta: {
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderRadius: 8,
    minWidth: 200,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ctaLabel: {
    fontFamily: 'Fraunces_600SemiBold',
    fontSize: 16,
    // E11-003: 16 × 1.375 = 22 (was 16, ratio 1.0 — Fraunces CTA had the
    // line-height pinned to exactly the font size, which clipped the "g" in
    // "Get started" at any scale above 100%).
    lineHeight: 22,
    textAlign: 'center',
  },
});
