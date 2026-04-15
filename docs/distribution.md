# distribution

tokenjuice should ship as a compiled JavaScript terminal app first, not a fake-native binary.

that means:

- `tsc` builds the runnable CLI into `dist/`
- npm publishes the package with `bin.tokenjuice -> dist/cli/main.js`
- release builds produce a tarball with:
  - `dist/`
  - `bin/tokenjuice`
  - `package.json`
  - `README.md`
  - `LICENSE`
- Homebrew installs that tarball and wraps `dist/cli/main.js` with the brewed `node`

## why this shape

it keeps the distribution boring:

- one runtime model
- one CLI entrypoint
- no second bundler/runtime path to debug
- easy npm, `npx`, `pnpm dlx`, and global install support
- clean path to Homebrew now
- clean path to apt/dnf later through the same tarball

native single-file binaries can come later if they earn their keep. they are not the default release story yet.

## local release flow

```bash
pnpm install
pnpm test
pnpm build
pnpm release:artifacts
pnpm release:formula
```

that writes:

- `release/tokenjuice-v<version>.tar.gz`
- `release/tokenjuice-v<version>.tar.gz.sha256`
- `release/manifest.json`
- `release/Formula/tokenjuice.rb`

## npm

npm, pnpm, and yarn already work off the published package:

```bash
npm install -g tokenjuice
pnpm add -g tokenjuice
yarn global add tokenjuice
npx tokenjuice --help
```

## Homebrew

the release pipeline generates a formula file that targets the GitHub release tarball.

expected shape:

```bash
brew tap vincentkoc/tap
brew install tokenjuice
```

for now the formula is generated in this repo and then copied into your tap repo.

## apt / dnf / yum later

same tarball, different wrapper:

- use `nfpm` or `fpm`
- depend on `nodejs`
- install the release payload under `/usr/lib/tokenjuice` or `/opt/tokenjuice`
- expose `/usr/bin/tokenjuice` as a wrapper to `dist/cli/main.js`

don’t build distro packaging first. get npm + GitHub release + Homebrew solid, then fan out.
