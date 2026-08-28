#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), '..');
const require = createRequire(import.meta.url);

export function isOpenSslLoaderFailure(output) {
  return /(?:libssl\.3\.dylib|libcrypto\.3\.dylib|openssl@3)/i.test(output);
}

export function parseMachORpaths(output) {
  const lines = output.split(/\r?\n/);
  const rpaths = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== 'cmd LC_RPATH') continue;
    for (let next = index + 1; next < Math.min(lines.length, index + 6); next += 1) {
      const match = lines[next].trim().match(/^path (.*?) \(offset \d+\)$/);
      if (match) {
        rpaths.push(match[1]);
        break;
      }
    }
  }
  return [...new Set(rpaths)];
}

function command(binary, args, options = {}) {
  return spawnSync(binary, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
}

function commandOutput(result) {
  return [result.stdout, result.stderr, result.error?.message].filter(Boolean).join('\n').trim();
}

function runRequired(binary, args) {
  const result = command(binary, args);
  if (result.status !== 0) {
    throw new Error(`${binary} ${args.join(' ')} failed: ${commandOutput(result) || `exit ${result.status}`}`);
  }
  return result.stdout.trim();
}

function ladybugBinaryPath() {
  const entryPoint = require.resolve('@ladybugdb/core');
  const binary = path.join(path.dirname(entryPoint), 'lbugjs.node');
  if (!existsSync(binary)) throw new Error(`LadybugDB native addon is missing: ${binary}`);
  return binary;
}

function verifyLadybugLoad() {
  return command(process.execPath, ['-e', 'require("@ladybugdb/core")']);
}

function opensslLibraryDirectory() {
  const override = process.env.GITNEXUS_OPENSSL3_LIB;
  if (override) return validateOpenSslDirectory(override, 'GITNEXUS_OPENSSL3_LIB');

  const brewCandidates = [
    process.env.HOMEBREW_PREFIX ? path.join(process.env.HOMEBREW_PREFIX, 'bin', 'brew') : undefined,
    'brew',
  ].filter(Boolean);
  for (const brew of [...new Set(brewCandidates)]) {
    const result = command(brew, ['--prefix', 'openssl@3']);
    if (result.status !== 0) continue;
    return validateOpenSslDirectory(path.join(result.stdout.trim(), 'lib'), `${brew} --prefix openssl@3`);
  }
  throw new Error(
    'LadybugDB requires OpenSSL 3. Install openssl@3 with Homebrew or set GITNEXUS_OPENSSL3_LIB to its lib directory.',
  );
}

function validateOpenSslDirectory(candidate, source) {
  const directory = path.resolve(candidate);
  const missing = ['libssl.3.dylib', 'libcrypto.3.dylib']
    .filter((name) => !existsSync(path.join(directory, name)));
  if (missing.length > 0) {
    throw new Error(`${source} does not contain ${missing.join(' and ')}: ${directory}`);
  }
  return directory;
}

export function prepareLadybugNative() {
  const initial = verifyLadybugLoad();
  if (initial.status === 0) {
    console.log('  @ladybugdb/core native addon OK');
    return;
  }
  const initialFailure = commandOutput(initial);
  if (process.platform !== 'darwin' || !isOpenSslLoaderFailure(initialFailure)) {
    throw new Error(`Unable to load @ladybugdb/core native addon: ${initialFailure || `exit ${initial.status}`}`);
  }

  const binary = ladybugBinaryPath();
  const libraryDirectory = opensslLibraryDirectory();
  const rpaths = parseMachORpaths(runRequired('otool', ['-l', binary]));
  if (!rpaths.includes(libraryDirectory)) {
    console.log(`  Adding LadybugDB OpenSSL RPATH: ${libraryDirectory}`);
    runRequired('install_name_tool', ['-add_rpath', libraryDirectory, binary]);
  } else {
    console.log(`  LadybugDB OpenSSL RPATH already present: ${libraryDirectory}`);
  }
  runRequired('codesign', ['--force', '--sign', '-', binary]);

  const repaired = verifyLadybugLoad();
  if (repaired.status !== 0) {
    throw new Error(`LadybugDB native addon still cannot load after repair: ${commandOutput(repaired)}`);
  }
  console.log('  @ladybugdb/core native addon repaired and verified');
}

if (path.resolve(process.argv[1] ?? '') === scriptPath) {
  try {
    prepareLadybugNative();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
