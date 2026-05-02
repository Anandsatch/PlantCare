import { render, screen } from '@testing-library/react-native';

// E0-005: verifies the font-loading gate. We mock `expo-font`'s `useFonts` so
// each test pins fontsLoaded explicitly. We also mock `expo-router`'s `Stack`
// to a recognizable host element so we can assert "children rendered" without
// pulling in the real router context.
//
// jest-expo's preset already shims expo-font enough that `useFonts` is a real
// function, but we need deterministic return values per test, hence the
// per-suite `jest.mock` + `mockReturnValue` pattern.

jest.mock('expo-font', () => ({
  useFonts: jest.fn(),
}));

jest.mock('expo-router', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    Stack: (props: { children?: React.ReactNode }) =>
      React.createElement(View, { testID: 'router-stack' }, props.children),
  };
});

import { useFonts } from 'expo-font';

import RootLayout from '../app/_layout';

const mockedUseFonts = useFonts as jest.MockedFunction<typeof useFonts>;

describe('RootLayout font gate', () => {
  afterEach(() => {
    mockedUseFonts.mockReset();
  });

  it('renders the surface placeholder while fonts are loading', () => {
    mockedUseFonts.mockReturnValue([false, null]);
    render(<RootLayout />);
    expect(screen.queryByTestId('router-stack')).toBeNull();
  });

  it('renders the router stack once fonts are loaded', () => {
    mockedUseFonts.mockReturnValue([true, null]);
    render(<RootLayout />);
    expect(screen.getByTestId('router-stack')).toBeOnTheScreen();
  });
});
