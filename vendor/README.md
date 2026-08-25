# Vendored dependencies

`npm/` is the canonical, clone-local npm package source. The root
`package-lock.json` must resolve every npm package to one of these tarballs;
`.npmrc` and `install.sh` enforce offline installation so npm cannot fall back
to a configured registry or Artifactory.

After intentionally refreshing package tarballs, run:

```bash
node scripts/vendor-lock.mjs
npm ci --offline --cache "$(mktemp -d)"
```

The vendor set includes native LadybugDB packages for macOS ARM64/x64, Linux
ARM64/x64, and Windows x64, along with the esbuild platforms represented by the
lockfile. Do not commit extracted `node_modules` trees; tarballs are the single
npm representation in Git.

`python/` seeds the Python analyzer installation. Unlike npm installation, uv
may use its configured Python index for wheels that are not committed here.
