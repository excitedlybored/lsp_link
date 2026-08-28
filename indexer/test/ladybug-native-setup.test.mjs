import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isOpenSslLoaderFailure,
  parseMachORpaths,
} from '../../scripts/prepare-ladybug-native.mjs';

test('classifies only macOS OpenSSL loader diagnostics as repairable', () => {
  assert.equal(isOpenSslLoaderFailure('Library not loaded: @rpath/libssl.3.dylib'), true);
  assert.equal(isOpenSslLoaderFailure('Library not loaded: @rpath/libcrypto.3.dylib'), true);
  assert.equal(isOpenSslLoaderFailure('Reason: openssl@3 was not found'), true);
  assert.equal(isOpenSslLoaderFailure('Cannot find module @ladybugdb/core'), false);
  assert.equal(isOpenSslLoaderFailure('wrong architecture'), false);
});

test('extracts and deduplicates only LC_RPATH entries from otool output', () => {
  const output = `
Load command 1
          cmd LC_LOAD_DYLIB
      cmdsize 56
         name @rpath/libssl.3.dylib (offset 24)
Load command 2
          cmd LC_RPATH
      cmdsize 48
         path /opt/homebrew/opt/openssl@3/lib (offset 12)
Load command 3
          cmd LC_RPATH
      cmdsize 48
         path /custom/homebrew/opt/openssl@3/lib (offset 12)
Load command 4
          cmd LC_RPATH
      cmdsize 48
         path /custom/homebrew/opt/openssl@3/lib (offset 12)
`;
  assert.deepEqual(parseMachORpaths(output), [
    '/opt/homebrew/opt/openssl@3/lib',
    '/custom/homebrew/opt/openssl@3/lib',
  ]);
});
