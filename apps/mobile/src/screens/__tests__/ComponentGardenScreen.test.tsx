// Tests for the dev-only Component Garden screen (E2-013).
//
// The garden's value as a coverage anchor only holds if the manifest list
// stays in sync with the primitives barrel — so the load-bearing test here
// is the parity assertion: every export from
// `apps/mobile/src/components/primitives/index.ts` must appear as a
// PRIMITIVE_SECTIONS entry. If a future ticket adds a primitive without an
// entry, this test fails and the design QA gap is caught at PR time.

import { render, screen } from '@testing-library/react-native';

import {
  ALL_SECTIONS,
  ComponentGardenScreen,
  PRIMITIVE_SECTIONS,
} from '../ComponentGardenScreen';
import * as primitivesBarrel from '../../components/primitives';

// Mock expo-camera so CameraPermissionPrePrompt's useCameraPermissions hook
// resolves predictably during the smoke render. The garden previews the
// pre-prompt in `undetermined` state.
jest.mock('expo-camera', () => ({
  useCameraPermissions: () => [
    { status: 'undetermined', granted: false, canAskAgain: true },
    jest.fn(),
    jest.fn(),
  ],
}));

describe('ComponentGardenScreen — manifest parity', () => {
  // Names exported from the primitives barrel that are NOT primitive
  // components (helpers, type guards, etc). Keep this list explicit so a
  // future primitive addition fails loudly until added to the manifest.
  const NON_COMPONENT_EXPORTS = new Set<string>(['shouldDismissOnDragRelease']);

  it('lists every primitive exported from the primitives barrel', () => {
    // Discover the primitive components via the barrel. Filter to React-ish
    // values (functions) — the barrel also re-exports types but those are
    // erased at runtime so they don't appear here.
    const exportedComponents = Object.entries(primitivesBarrel)
      .filter(([_name, value]) => typeof value === 'function')
      .map(([name]) => name)
      .filter((name) => !NON_COMPONENT_EXPORTS.has(name));

    const sectionNames = PRIMITIVE_SECTIONS.map((s) => s.name).sort();
    const missing = exportedComponents.filter(
      (name) => !sectionNames.includes(name),
    );

    expect(missing).toEqual([]);
  });

  it('only references real exports (no manifest entry pointing at a missing primitive)', () => {
    const exportedNames = new Set(
      Object.entries(primitivesBarrel)
        .filter(([_n, v]) => typeof v === 'function')
        .map(([n]) => n),
    );
    for (const section of PRIMITIVE_SECTIONS) {
      expect(exportedNames.has(section.name)).toBe(true);
    }
  });

  it('union of primitives + composites is exposed as ALL_SECTIONS', () => {
    expect(ALL_SECTIONS.length).toBeGreaterThanOrEqual(PRIMITIVE_SECTIONS.length);
    for (const p of PRIMITIVE_SECTIONS) {
      expect(ALL_SECTIONS.includes(p)).toBe(true);
    }
  });
});

describe('ComponentGardenScreen — render', () => {
  it('renders the page title and subtitle', () => {
    // Render only the small pure-icon sections so the smoke test stays fast
    // and doesn't pull in expo-camera / Modal / Animated machinery.
    const sections = PRIMITIVE_SECTIONS.filter((s) =>
      ['Droplet', 'LeafIcon', 'StatusChip'].includes(s.name),
    );
    render(<ComponentGardenScreen sections={sections} />);
    expect(screen.getByText('Component Garden')).toBeOnTheScreen();
    expect(
      screen.getByText(/Conservatory \(left\)/),
    ).toBeOnTheScreen();
  });

  it('renders both light and dark columns per section', () => {
    const sections = PRIMITIVE_SECTIONS.filter((s) => s.name === 'Droplet');
    render(<ComponentGardenScreen sections={sections} />);
    expect(
      screen.getByTestId('garden-column-light', { includeHiddenElements: true }),
    ).toBeOnTheScreen();
    expect(
      screen.getByTestId('garden-column-dark', { includeHiddenElements: true }),
    ).toBeOnTheScreen();
  });

  it('renders a section node per requested section', () => {
    const sections = PRIMITIVE_SECTIONS.filter((s) =>
      ['Droplet', 'LeafIcon'].includes(s.name),
    );
    render(<ComponentGardenScreen sections={sections} />);
    expect(screen.getByTestId('garden-section-Droplet')).toBeOnTheScreen();
    expect(screen.getByTestId('garden-section-LeafIcon')).toBeOnTheScreen();
  });

  it('forwards a custom testID to the scroll root', () => {
    render(
      <ComponentGardenScreen sections={[]} testID="garden-root" />,
    );
    expect(screen.getByTestId('garden-root')).toBeOnTheScreen();
  });

  it('has a default testID when none is provided', () => {
    render(<ComponentGardenScreen sections={[]} />);
    expect(screen.getByTestId('component-garden-screen')).toBeOnTheScreen();
  });
});
