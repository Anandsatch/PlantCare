import { darkTheme, lightTheme } from '@plantcare/theme';
import { fireEvent, render } from '@testing-library/react-native';
import { Image } from 'react-native';

import { useTheme } from '../../../hooks/useTheme';
import { HeroPhoto } from '../HeroPhoto';

jest.mock('../../../hooks/useTheme', () => ({
  useTheme: jest.fn(),
}));

const mockedUseTheme = useTheme as unknown as jest.Mock<ReturnType<typeof useTheme>, []>;

const SAMPLE_URI = { uri: 'file:///documents/plant-1.jpg' };
const SAMPLE_LABEL = 'Photo of Monstera Mona';

function flatten(style: unknown): Record<string, unknown> {
  // RN style props are sometimes arrays of objects (StyleSheet.flatten lite).
  // We only need to assert single keys here, so a shallow merge is enough.
  if (Array.isArray(style)) {
    return Object.assign({}, ...style.map((s) => flatten(s)));
  }
  return (style ?? {}) as Record<string, unknown>;
}

describe('HeroPhoto', () => {
  beforeEach(() => {
    mockedUseTheme.mockReturnValue(lightTheme);
  });

  afterEach(() => {
    mockedUseTheme.mockReset();
  });

  it('renders with default rounded radius of 24 when `rounded` is omitted', () => {
    const { getByTestId } = render(
      <HeroPhoto source={SAMPLE_URI} accessibilityLabel={SAMPLE_LABEL} testID="hero" />,
    );
    const wrapper = getByTestId('hero');
    expect(flatten(wrapper.props.style).borderRadius).toBe(24);
  });

  it('drops radius to 0 when `rounded={false}`', () => {
    const { getByTestId } = render(
      <HeroPhoto
        source={SAMPLE_URI}
        accessibilityLabel={SAMPLE_LABEL}
        testID="hero"
        rounded={false}
      />,
    );
    expect(flatten(getByTestId('hero').props.style).borderRadius).toBe(0);
  });

  it('passes a numeric `rounded` value through verbatim', () => {
    const { getByTestId } = render(
      <HeroPhoto
        source={SAMPLE_URI}
        accessibilityLabel={SAMPLE_LABEL}
        testID="hero"
        rounded={12}
      />,
    );
    expect(flatten(getByTestId('hero').props.style).borderRadius).toBe(12);
  });

  it('defaults aspectRatio to 1 (square)', () => {
    const { getByTestId } = render(
      <HeroPhoto source={SAMPLE_URI} accessibilityLabel={SAMPLE_LABEL} testID="hero" />,
    );
    expect(flatten(getByTestId('hero').props.style).aspectRatio).toBe(1);
  });

  it('accepts a custom aspectRatio (e.g. 4/3 for A-2 full-bleed)', () => {
    const { getByTestId } = render(
      <HeroPhoto
        source={SAMPLE_URI}
        accessibilityLabel={SAMPLE_LABEL}
        testID="hero"
        aspectRatio={4 / 3}
      />,
    );
    expect(flatten(getByTestId('hero').props.style).aspectRatio).toBe(4 / 3);
  });

  it('forwards accessibilityLabel to the wrapping View (so VoiceOver announces it)', () => {
    const { getByLabelText } = render(
      <HeroPhoto source={SAMPLE_URI} accessibilityLabel={SAMPLE_LABEL} />,
    );
    expect(getByLabelText(SAMPLE_LABEL)).toBeOnTheScreen();
  });

  it('exposes accessibilityRole="image" on the wrapping View', () => {
    const { getByLabelText } = render(
      <HeroPhoto source={SAMPLE_URI} accessibilityLabel={SAMPLE_LABEL} />,
    );
    expect(getByLabelText(SAMPLE_LABEL).props.accessibilityRole).toBe('image');
  });

  it('passes the source object through unchanged to <Image>', () => {
    const { UNSAFE_getByType } = render(
      <HeroPhoto source={SAMPLE_URI} accessibilityLabel={SAMPLE_LABEL} />,
    );
    expect(UNSAFE_getByType(Image).props.source).toBe(SAMPLE_URI);
  });

  it('fires onLoad when the underlying Image reports loaded', () => {
    const onLoad = jest.fn();
    const { UNSAFE_getByType } = render(
      <HeroPhoto source={SAMPLE_URI} accessibilityLabel={SAMPLE_LABEL} onLoad={onLoad} />,
    );
    fireEvent(UNSAFE_getByType(Image), 'load');
    expect(onLoad).toHaveBeenCalledTimes(1);
  });

  it('fires onError and stops rendering the Image after a load failure (silent cream rect)', () => {
    const onError = jest.fn();
    const { UNSAFE_getByType, UNSAFE_queryByType } = render(
      <HeroPhoto source={SAMPLE_URI} accessibilityLabel={SAMPLE_LABEL} onError={onError} />,
    );
    fireEvent(UNSAFE_getByType(Image), 'error');
    expect(onError).toHaveBeenCalledTimes(1);
    // Empty cream rect: Image is gone, but the wrapper (with a11y) stays.
    expect(UNSAFE_queryByType(Image)).toBeNull();
  });

  it('keeps a11y identity on the wrapper after an error so screen readers still announce', () => {
    const { getByLabelText, UNSAFE_getByType } = render(
      <HeroPhoto source={SAMPLE_URI} accessibilityLabel={SAMPLE_LABEL} testID="hero" />,
    );
    fireEvent(UNSAFE_getByType(Image), 'error');
    const wrapper = getByLabelText(SAMPLE_LABEL);
    expect(wrapper.props.accessibilityRole).toBe('image');
  });

  it('uses the dark-mode surface token as the skeleton color when theme is Midnight', () => {
    mockedUseTheme.mockReturnValue(darkTheme);
    const { getByTestId } = render(
      <HeroPhoto source={SAMPLE_URI} accessibilityLabel={SAMPLE_LABEL} testID="hero" />,
    );
    // darkTheme.colors.surface = '#1F3826' (forest)
    expect(flatten(getByTestId('hero').props.style).backgroundColor).toBe(
      darkTheme.colors.surface,
    );
  });

  it('uses the light-mode surface token as the skeleton color by default', () => {
    const { getByTestId } = render(
      <HeroPhoto source={SAMPLE_URI} accessibilityLabel={SAMPLE_LABEL} testID="hero" />,
    );
    // lightTheme.colors.surface = '#FAF6EE' (cream)
    expect(flatten(getByTestId('hero').props.style).backgroundColor).toBe(
      lightTheme.colors.surface,
    );
  });
});
