import { darkTheme, lightTheme } from '@plantcare/theme';
import { renderHook } from '@testing-library/react-native';
import { useColorScheme } from 'react-native';

import { useTheme } from '../useTheme';

jest.mock('react-native', () => ({
  useColorScheme: jest.fn(),
}));

// RN's legacy public types (re-exported from 'react-native') declare
// `useColorScheme(): ColorSchemeName`, omitting the `null | undefined` cases
// that the runtime actually emits during cold start and Android backgrounding.
// The newer types_generated definitions are accurate, but the package's
// "types" field points at the legacy ones. Widen the mock so we can exercise
// the null/undefined branches the hook intentionally guards against.
type WidenedScheme = 'light' | 'dark' | 'unspecified' | null | undefined;
const mockedUseColorScheme = useColorScheme as unknown as jest.Mock<WidenedScheme, []>;

describe('useTheme', () => {
  beforeEach(() => {
    mockedUseColorScheme.mockReset();
  });

  it('returns the Conservatory (light) tokens when system scheme is light', () => {
    mockedUseColorScheme.mockReturnValue('light');
    const { result } = renderHook(() => useTheme());
    expect(result.current).toBe(lightTheme);
    expect(result.current.scheme).toBe('light');
  });

  it('returns the Midnight Conservatory (dark) tokens when system scheme is dark', () => {
    mockedUseColorScheme.mockReturnValue('dark');
    const { result } = renderHook(() => useTheme());
    expect(result.current).toBe(darkTheme);
    expect(result.current.scheme).toBe('dark');
  });

  it('defaults to light when useColorScheme returns null (cold start, pre-subscription)', () => {
    mockedUseColorScheme.mockReturnValue(null);
    const { result } = renderHook(() => useTheme());
    expect(result.current).toBe(lightTheme);
  });

  it('defaults to light when useColorScheme returns undefined', () => {
    mockedUseColorScheme.mockReturnValue(undefined);
    const { result } = renderHook(() => useTheme());
    expect(result.current).toBe(lightTheme);
  });

  it('defaults to light when useColorScheme returns "unspecified" (Android, no preference)', () => {
    mockedUseColorScheme.mockReturnValue('unspecified');
    const { result } = renderHook(() => useTheme());
    expect(result.current).toBe(lightTheme);
  });

  it('returns a stable reference across renders when scheme is unchanged', () => {
    mockedUseColorScheme.mockReturnValue('light');
    const { result, rerender } = renderHook(() => useTheme());
    const first = result.current;
    rerender(undefined);
    expect(result.current).toBe(first);
  });

  it('switches reference when system scheme flips light → dark', () => {
    mockedUseColorScheme.mockReturnValue('light');
    const { result, rerender } = renderHook(() => useTheme());
    expect(result.current).toBe(lightTheme);

    mockedUseColorScheme.mockReturnValue('dark');
    rerender(undefined);
    expect(result.current).toBe(darkTheme);
  });
});
