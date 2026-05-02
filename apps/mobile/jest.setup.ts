// Loaded after Jest's environment is set up. Brings in RTL's built-in matchers
// (toBeOnTheScreen, toHaveTextContent, etc.) so tests can assert against rendered output.
//
// As of @testing-library/react-native v12.4+, matchers are exported from a
// dedicated `matchers` entry. v13 extends `expect` automatically when the
// main entry is imported, but loading the matchers explicitly here makes the
// extension order deterministic and survives any future opt-out flag.
import { expect } from '@jest/globals';
import * as matchers from '@testing-library/react-native/build/matchers';

expect.extend(matchers);
