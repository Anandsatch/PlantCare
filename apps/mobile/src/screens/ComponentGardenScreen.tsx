// ComponentGardenScreen — the dev-only Storybook-style surface for E2-013.
//
// Renders every primitive (and the small set of top-level composites that have
// shipped under apps/mobile/src/components/) in two side-by-side columns:
// Conservatory (light) on the left and Midnight Conservatory (dark) on the
// right. Each column forces its own theme via the ThemeOverrideContext shim
// in src/hooks/useTheme.tsx — the screen never wraps a global ThemeProvider
// at the app root (V1 scope lock from the master plan).
//
// What this screen is NOT:
//   - A routed app screen. There is intentionally no entry in app/ that
//     navigates here. The screen is importable by tests and by future
//     dev-only entry points (a long-press gesture on the FAB, a hidden
//     gesture in dev builds, etc.). Keeping it un-routed prevents the
//     production app shell from leaking the garden surface.
//   - A Storybook / Ladle install. V1 scope lock — a single screen is the
//     codified shape for E2-013, and a real Storybook addon ecosystem would
//     pull a non-trivial peer-dep tree we haven't budgeted for.
//   - A theme toggle. The garden renders both palettes always; the system
//     scheme has no effect on the columns. End users still get the OS-driven
//     scheme everywhere else (DESIGN.md: "Mode follows OS via useColorScheme().
//     No manual toggle in V1").
//
// What this screen IS:
//   - A coverage anchor for the primitive set. If a new primitive ships
//     without an entry here, design QA can't visually compare it against the
//     Conservatory + Midnight token tables in DESIGN.md.
//   - A testable manifest. The list of primitive sections is exported so a
//     unit test can assert the screen covers every primitive in the
//     `apps/mobile/src/components/primitives/index.ts` barrel.

import { ForcedTheme, useTheme } from '../hooks/useTheme';
import { darkTheme, fonts, lightTheme } from '@plantcare/theme';
import { type ReactElement, type ReactNode } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import {
  Droplet,
  EditorialBottomSheet,
  EditorialButton,
  FAB,
  HandOnSoilIcon,
  HeroPhoto,
  LeafIcon,
  StatusChip,
  ToastBanner,
} from '../components/primitives';
import {
  CameraPermissionPrePrompt,
  DiagnoseLoadingState,
  EmptyGardenWelcome,
  PhotoTimeline,
  WateringLedger,
} from '../components';

// ---------------------------------------------------------------------------
// Section manifest — declarative list of every primitive + composite covered
// by the garden. The order is the rendering order; the names mirror the
// canonical export names from the primitives barrel (and the top-level
// components barrel for composites). The test file consumes this list to
// assert coverage parity with the primitives barrel.
// ---------------------------------------------------------------------------

export type GardenSection = {
  readonly name: string;
  readonly importPath: string;
  readonly category: 'primitive' | 'composite';
  /** Renders the primitive's variant set. Receives no args — the section
   *  manages its own props via local consts so each section is self-contained. */
  readonly render: () => ReactElement;
};

export const PRIMITIVE_SECTIONS: ReadonlyArray<GardenSection> = [
  {
    name: 'Droplet',
    importPath: '@/components/primitives',
    category: 'primitive',
    render: () => (
      <Row>
        <Droplet />
        <Droplet filled />
        <Droplet size={24} filled />
      </Row>
    ),
  },
  {
    name: 'LeafIcon',
    importPath: '@/components/primitives',
    category: 'primitive',
    render: () => (
      <Row>
        <LeafIcon />
        <LeafIcon size={20} />
        <LeafIcon size={28} accessibilityLabel="Skip" />
      </Row>
    ),
  },
  {
    name: 'HandOnSoilIcon',
    importPath: '@/components/primitives',
    category: 'primitive',
    render: () => (
      <Row>
        <HandOnSoilIcon />
        <HandOnSoilIcon size={20} />
        <HandOnSoilIcon size={28} accessibilityLabel="Check soil" />
      </Row>
    ),
  },
  {
    name: 'StatusChip',
    importPath: '@/components/primitives',
    category: 'primitive',
    render: () => (
      <Stack>
        <StatusChip type="water" />
        <StatusChip type="skip" />
        <StatusChip type="soil" />
      </Stack>
    ),
  },
  {
    name: 'EditorialButton',
    importPath: '@/components/primitives',
    category: 'primitive',
    render: () => (
      <Stack>
        <EditorialButton variant="filled" label="Mark watered" onPress={noop} />
        <EditorialButton variant="outline" label="Add note" onPress={noop} />
        <EditorialButton variant="filled" label="Loading…" onPress={noop} loading />
        <EditorialButton variant="outline" label="Disabled" onPress={noop} disabled />
      </Stack>
    ),
  },
  {
    name: 'FAB',
    importPath: '@/components/primitives',
    category: 'primitive',
    render: () => (
      <Row>
        <FAB onPress={noop} />
        <FAB onPress={noop} onLongPress={noop} />
      </Row>
    ),
  },
  {
    name: 'HeroPhoto',
    importPath: '@/components/primitives',
    category: 'primitive',
    render: () => (
      <View style={styles.heroBox}>
        <HeroPhoto
          source={{ uri: 'file:///placeholder' }}
          accessibilityLabel="Photo of Mona the Monstera"
          aspectRatio={1.6}
        />
      </View>
    ),
  },
  {
    name: 'EditorialBottomSheet',
    importPath: '@/components/primitives',
    category: 'primitive',
    // Bottom sheets render full-screen via Modal; the garden previews the
    // sheet shell statically (open=false) so the manifest row is testable
    // without portal interference. Real visual QA happens in E8-003.
    render: () => (
      <View>
        <Text style={styles.placeholderNote}>
          Bottom sheet rendered closed in the garden — visual QA in E8-003.
        </Text>
        <EditorialBottomSheet open={false} onDismiss={noop}>
          <Text>preview body</Text>
        </EditorialBottomSheet>
      </View>
    ),
  },
  {
    name: 'ToastBanner',
    importPath: '@/components/primitives',
    category: 'primitive',
    render: () => (
      <Stack>
        <ToastBanner type="warn" message="Approaching daily limit" />
        <ToastBanner type="info" message="Welcome to your garden" />
        <ToastBanner type="pending" message="2 items syncing" />
      </Stack>
    ),
  },
];

export const COMPOSITE_SECTIONS: ReadonlyArray<GardenSection> = [
  {
    name: 'EmptyGardenWelcome',
    importPath: '@/components',
    category: 'composite',
    render: () => <EmptyGardenWelcome onAddFirst={noop} />,
  },
  {
    name: 'WateringLedger',
    importPath: '@/components',
    category: 'composite',
    render: () => (
      <Stack>
        <WateringLedger events={[]} nowMs={NOW_MS} />
        <WateringLedger
          events={[
            { wateredAtMs: NOW_MS },
            { wateredAtMs: NOW_MS - 3 * DAY_MS },
            { wateredAtMs: NOW_MS - 5 * DAY_MS },
          ]}
          nowMs={NOW_MS}
        />
      </Stack>
    ),
  },
  {
    name: 'PhotoTimeline',
    importPath: '@/components',
    category: 'composite',
    render: () => (
      <Stack>
        <PhotoTimeline photos={[]} nowMs={NOW_MS} />
        <PhotoTimeline
          nowMs={NOW_MS}
          photos={[
            { id: 'p1', uri: 'file:///photo-1', takenAtMs: NOW_MS },
            { id: 'p2', uri: 'file:///photo-2', takenAtMs: NOW_MS - DAY_MS },
            { id: 'p3', uri: 'file:///photo-3', takenAtMs: NOW_MS - 3 * DAY_MS },
          ]}
        />
      </Stack>
    ),
  },
  {
    name: 'CameraPermissionPrePrompt',
    importPath: '@/components',
    category: 'composite',
    // CameraPermissionPrePrompt requires hooks-driven permission state; we
    // render its presentational shell in 'undetermined' status mode so the
    // garden surface stays visual-only and doesn't trigger a real OS prompt.
    render: () => (
      <View style={styles.placeholderBox}>
        <Text style={styles.placeholderNote}>
          Camera pre-prompt previewed only in E5-003 dev build (permission
          flow requires the Expo native module).
        </Text>
        <CameraPermissionPrePrompt onGranted={noop} onCancel={noop} />
      </View>
    ),
  },
  {
    name: 'DiagnoseLoadingState',
    importPath: '@/components',
    category: 'composite',
    render: () => (
      <Stack>
        <DiagnoseLoadingState startedAtMs={NOW_MS} />
        <DiagnoseLoadingState startedAtMs={NOW_MS - 12_000} />
        <DiagnoseLoadingState startedAtMs={NOW_MS - 25_000} />
      </Stack>
    ),
  },
];

export const ALL_SECTIONS: ReadonlyArray<GardenSection> = [
  ...PRIMITIVE_SECTIONS,
  ...COMPOSITE_SECTIONS,
];

// ---------------------------------------------------------------------------
// Layout helpers (kept private to the garden — not added to the components
// barrel because they'd be one-shot abstractions everywhere else).
// ---------------------------------------------------------------------------

function noop(): void {
  // intentional
}

const NOW_MS = 1_746_403_200_000; // 2026-05-04 12:00 UTC — deterministic anchor
const DAY_MS = 86_400_000;

function Row({ children }: { readonly children: ReactNode }) {
  return <View style={styles.row}>{children}</View>;
}

function Stack({ children }: { readonly children: ReactNode }) {
  return <View style={styles.stack}>{children}</View>;
}

// ---------------------------------------------------------------------------
// Section + Column components
// ---------------------------------------------------------------------------

function ThemedColumn({
  theme,
  children,
}: {
  readonly theme: typeof lightTheme | typeof darkTheme;
  readonly children: ReactNode;
}) {
  return (
    <ForcedTheme value={theme}>
      <View
        style={[styles.column, { backgroundColor: theme.colors.bg }]}
        testID={`garden-column-${theme.scheme}`}
      >
        {children}
      </View>
    </ForcedTheme>
  );
}

function GardenSectionView({ section }: { readonly section: GardenSection }) {
  // Section header reads from the OUTER theme (the page chrome) so it stays
  // legible regardless of which OS scheme is active. The primitive itself,
  // inside each ThemedColumn, gets the forced theme.
  const theme = useTheme();
  return (
    <View
      style={[styles.section, { borderColor: theme.colors.stroke }]}
      testID={`garden-section-${section.name}`}
    >
      <Text style={[styles.sectionHeader, { color: theme.colors.text }]}>
        {section.name}
      </Text>
      <Text style={[styles.sectionImport, { color: theme.colors.textMuted }]}>
        from "{section.importPath}"
      </Text>
      <View style={styles.columns}>
        <ThemedColumn theme={lightTheme}>{section.render()}</ThemedColumn>
        <ThemedColumn theme={darkTheme}>{section.render()}</ThemedColumn>
      </View>
    </View>
  );
}

export type ComponentGardenScreenProps = {
  /** Defaults to ALL_SECTIONS. Tests pass a subset to keep snapshots small. */
  readonly sections?: ReadonlyArray<GardenSection>;
  readonly testID?: string;
};

export function ComponentGardenScreen({
  sections = ALL_SECTIONS,
  testID,
}: ComponentGardenScreenProps): ReactElement {
  const theme = useTheme();
  return (
    <ScrollView
      style={[styles.scroll, { backgroundColor: theme.colors.bg }]}
      contentContainerStyle={styles.scrollContent}
      testID={testID ?? 'component-garden-screen'}
    >
      <Text style={[styles.pageTitle, { color: theme.colors.text }]}>
        Component Garden
      </Text>
      <Text style={[styles.pageSubtitle, { color: theme.colors.textMuted }]}>
        Conservatory (left) · Midnight Conservatory (right). Dev-only screen;
        no production route.
      </Text>
      {sections.map((s) => (
        <GardenSectionView key={s.name} section={s} />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
  },
  pageTitle: {
    fontFamily: fonts.display.semibold,
    fontSize: 28,
    lineHeight: 34,
    marginBottom: 4,
  },
  pageSubtitle: {
    fontFamily: fonts.body.regular,
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 24,
  },
  section: {
    borderTopWidth: 1,
    paddingVertical: 16,
    marginBottom: 8,
  },
  sectionHeader: {
    fontFamily: fonts.display.semibold,
    fontSize: 20,
    lineHeight: 24,
  },
  sectionImport: {
    fontFamily: fonts.body.regular,
    fontSize: 12,
    lineHeight: 16,
    marginBottom: 12,
  },
  columns: {
    flexDirection: 'row',
    gap: 12,
  },
  column: {
    flex: 1,
    borderRadius: 12,
    padding: 12,
    minHeight: 80,
  },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    alignItems: 'center',
  },
  stack: {
    flexDirection: 'column',
    gap: 8,
  },
  heroBox: {
    width: '100%',
    maxWidth: 200,
  },
  placeholderBox: {
    padding: 12,
  },
  placeholderNote: {
    fontSize: 12,
    fontStyle: 'italic',
  },
});
