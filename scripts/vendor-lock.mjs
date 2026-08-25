#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lockPath = resolve(repositoryRoot, "package-lock.json");
const lock = JSON.parse(readFileSync(lockPath, "utf8"));

const ladybugPlatforms = [
  ["darwin", "arm64"],
  ["darwin", "x64"],
  ["linux", "arm64"],
  ["linux", "x64"],
  ["win32", "x64"],
];
const ladybugVersion = lock.packages["node_modules/@ladybugdb/core"]?.version;
if (!ladybugVersion) throw new Error("package-lock.json does not contain @ladybugdb/core");

for (const [os, cpu] of ladybugPlatforms) {
  const packageName = `@ladybugdb/core-${os}-${cpu}`;
  const packagePath = `node_modules/${packageName}`;
  lock.packages[packagePath] ??= {
    version: ladybugVersion,
    cpu: [cpu],
    license: "MIT",
    optional: true,
    os: [os],
  };
}

function tarballName(packageName, version) {
  return `${packageName.replace(/^@/, "").replaceAll("/", "-")}-${version}.tgz`;
}

for (const [packagePath, metadata] of Object.entries(lock.packages ?? {})) {
  const marker = "node_modules/";
  const markerIndex = packagePath.lastIndexOf(marker);
  if (markerIndex < 0 || !metadata.version) continue;

  const packageName = packagePath.slice(markerIndex + marker.length);
  const tarball = tarballName(packageName, metadata.version);
  const tarballPath = resolve(repositoryRoot, "vendor", "npm", tarball);
  if (!existsSync(tarballPath)) {
    throw new Error(`Missing vendored package for ${packageName}@${metadata.version}: ${tarball}`);
  }
  metadata.resolved = `file:vendor/npm/${tarball}`;
  metadata.integrity = `sha512-${createHash("sha512").update(readFileSync(tarballPath)).digest("base64")}`;
}

writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
console.log("Rewrote package-lock.json to use clone-local vendor/npm tarballs.");
