/**
 * Jest config for the Expo mobile app.
 *
 * - jest-expo preset handles RN/Expo transforms, mocks, and the setup files
 *   for global RN polyfills.
 * - testEnvironment is explicit ('node'); jest-expo defaults to it but we keep
 *   it in writing for posterity.
 * - setupFilesAfterEnv loads RTL's matchers (toBeOnTheScreen, etc.) once Jest
 *   has bootstrapped the test framework.
 * - transformIgnorePatterns extends the preset's allow-list with `.bun` so
 *   Bun's hoisted store layout (node_modules/.bun/<pkg>@<ver>/node_modules/<pkg>)
 *   still gets transformed for RN/Expo packages. Without this, Jest hits raw
 *   `import` statements in `react-native/jest/setup.js` because the negative
 *   lookahead bails on `.bun` before reaching `react-native`.
 */
module.exports = {
  preset: 'jest-expo',
  testEnvironment: 'node',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  // Bumped from the default 5000ms because integration test files
  // (cameraFlow.integration.test.tsx, weeklyReviewFlow.integration.test.tsx)
  // hit per-test timeouts under ubuntu-latest CI's parallel-load conditions
  // even when each test completes in <500ms locally. The 5s default is too
  // tight for tests that render full screens through StrictMode + multiple
  // useEffect tiers + queued setState batches on a slower runner.
  testTimeout: 15000,
  testMatch: ['**/__tests__/**/*.test.[jt]s?(x)', '**/?(*.)+(spec|test).[jt]s?(x)'],
  transformIgnorePatterns: [
    'node_modules/(?!(\\.bun/)?(\\.pnpm/)?(@?(?:jest-)?react-native(-community)?|expo(nent)?|@expo(nent)?(/.*)?|@expo-google-fonts(/.*)?|react-clone-referenced-element|react-navigation|@react-navigation(/.*)?|@unimodules(/.*)?|unimodules|sentry-expo|@sentry/react-native|native-base|react-native-svg))',
  ],
};
