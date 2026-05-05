import { darkTheme, lightTheme, type Theme } from '@plantcare/theme';
import { fireEvent, render, screen } from '@testing-library/react-native';

// We mock useTheme so we can flip schemes without rendering the whole
// AppearanceProvider tree. The component reads `colors.*` off the returned
// Theme; mocking the hook directly keeps the test surface tight.
jest.mock('../../hooks/useTheme', () => ({
  useTheme: jest.fn(),
}));

import { useTheme } from '../../hooks/useTheme';
import {
  BODY_TEXT,
  CTA_LABEL,
  EmptyGardenWelcome,
  HEADLINE_TEXT,
} from '../EmptyGardenWelcome';

const mockedUseTheme = useTheme as jest.MockedFunction<() => Theme>;

describe('EmptyGardenWelcome', () => {
  beforeEach(() => {
    mockedUseTheme.mockReset();
    mockedUseTheme.mockReturnValue(lightTheme);
  });

  it('renders the headline copy verbatim', () => {
    render(<EmptyGardenWelcome onAddFirst={jest.fn()} />);
    expect(screen.getByText(HEADLINE_TEXT)).toBeOnTheScreen();
    expect(HEADLINE_TEXT).toBe('Welcome to your garden');
  });

  it('renders the body copy verbatim', () => {
    render(<EmptyGardenWelcome onAddFirst={jest.fn()} />);
    expect(screen.getByText(BODY_TEXT)).toBeOnTheScreen();
    expect(BODY_TEXT).toBe('Snap a photo of any plant to add it.');
  });

  it('renders the CTA label "Add my first plant"', () => {
    render(<EmptyGardenWelcome onAddFirst={jest.fn()} />);
    expect(screen.getByText(CTA_LABEL)).toBeOnTheScreen();
    expect(CTA_LABEL).toBe('Add my first plant');
  });

  it('fires onAddFirst exactly once when the CTA is tapped', () => {
    const onAddFirst = jest.fn();
    render(<EmptyGardenWelcome onAddFirst={onAddFirst} />);
    fireEvent.press(screen.getByTestId('empty-garden-cta'));
    expect(onAddFirst).toHaveBeenCalledTimes(1);
  });

  it('marks the headline with accessibilityRole="header"', () => {
    render(<EmptyGardenWelcome onAddFirst={jest.fn()} />);
    const headline = screen.getByRole('header');
    expect(headline).toHaveTextContent(HEADLINE_TEXT);
  });

  it('marks the CTA with accessibilityRole="button" and the visible label', () => {
    render(<EmptyGardenWelcome onAddFirst={jest.fn()} />);
    const button = screen.getByRole('button', { name: CTA_LABEL });
    expect(button).toBeOnTheScreen();
    // The accessibilityLabel should mirror the visible label so VoiceOver
    // doesn't read "Add my first plant Add my first plant".
    expect(button.props.accessibilityLabel).toBe(CTA_LABEL);
  });

  it('uses the Conservatory cream surface in light mode', () => {
    mockedUseTheme.mockReturnValue(lightTheme);
    render(<EmptyGardenWelcome onAddFirst={jest.fn()} testID="card" />);
    const card = screen.getByTestId('card');
    // RN flattens style arrays; the trailing inline `{ backgroundColor }` wins.
    const flat = Array.isArray(card.props.style)
      ? Object.assign({}, ...card.props.style)
      : card.props.style;
    expect(flat.backgroundColor).toBe(lightTheme.colors.surface);
    expect(flat.backgroundColor).toBe('#FAF6EE');
  });

  it('uses the Midnight Conservatory forest surface in dark mode', () => {
    mockedUseTheme.mockReturnValue(darkTheme);
    render(<EmptyGardenWelcome onAddFirst={jest.fn()} testID="card" />);
    const card = screen.getByTestId('card');
    const flat = Array.isArray(card.props.style)
      ? Object.assign({}, ...card.props.style)
      : card.props.style;
    expect(flat.backgroundColor).toBe(darkTheme.colors.surface);
    expect(flat.backgroundColor).toBe('#1F3826');
  });

  it('renders the illustration node with an accessibility label', () => {
    render(<EmptyGardenWelcome onAddFirst={jest.fn()} />);
    const illustration = screen.getByTestId('empty-garden-illustration');
    expect(illustration).toBeOnTheScreen();
    expect(illustration.props.accessibilityLabel).toBe('Potted plant illustration');
  });

  it('caps card width at 360 and stays self-contained on narrow viewports (280-320px)', () => {
    render(<EmptyGardenWelcome onAddFirst={jest.fn()} testID="card" />);
    const card = screen.getByTestId('card');
    const flat = Array.isArray(card.props.style)
      ? Object.assign({}, ...card.props.style)
      : card.props.style;
    // Codex P2 fix: width is NOT 100%, and there is NO horizontal margin —
    // the card sizes to content (capped at maxWidth 360) and centers in its
    // parent. This guarantees the card never overflows a 280px viewport,
    // regardless of what the parent screen does.
    expect(flat.maxWidth).toBe(360);
    expect(flat.width).toBeUndefined();
    expect(flat.marginHorizontal).toBeUndefined();
    expect(flat.alignSelf).toBe('center');
  });

  it('does NOT render a system "+" FAB or duplicate CTA (single CTA contract)', () => {
    render(<EmptyGardenWelcome onAddFirst={jest.fn()} />);
    // Spec lock: when the Welcome card is on screen, it is the only CTA.
    // We assert the component renders exactly one button and zero FABs.
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.queryByLabelText('Add a plant')).toBeNull();
  });
});
