// Expo SDK 55 auto-detects bun/npm/yarn workspaces — no manual watchFolders
// or nodeModulesPaths overrides needed. See https://docs.expo.dev/guides/monorepos/.
const { getDefaultConfig } = require('expo/metro-config');

module.exports = getDefaultConfig(__dirname);
