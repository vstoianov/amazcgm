# Releasing AmazCGM

Releases are built locally and published to GitHub Releases with `scripts/release.sh`.

## Prerequisites

- The [GitHub CLI](https://cli.github.com/), logged in with `gh auth login`
- A working local build (`npm install`, `npx zeus build`)
- A clean `main` that matches `origin/main`

## Steps

1. Bump the version in **all** of these places:
   - `app.json`: set `app.version.name` (for example `1.6.5`) **and** increase `app.version.code` by one. The Zepp app uses the code to recognise an update.
   - `package.json`: run `npm version --no-git-tag-version 1.6.5`.
2. Add a `## 1.6.5` section to the top of `CHANGELOG.md`. Its text becomes the release notes.
3. Commit and push: `git commit -am "Release 1.6.5" && git push`.
4. Run `npm run release`. Add `-- --prerelease` for a test or beta build.

The script will:

- check that the repo is public, the versions match, the tag is new and the tree is clean,
- run `npm test` and `npx zeus build`,
- write `release/AmazCGM-<ver>.zab` and its `.sha256`,
- split the `.zab` with `scripts/make-zpk.py` into one `.zpk` per watch group (`bip-max`, `t-rex-3-pro-44`, `round-480`) in `release/zpk/`,
- push those `.zpk` files to the `packages` branch and make one `AmazCGM-<ver>-<group>-install-qr.png` per group. Each QR code points to `zpkd1://raw.githubusercontent.com/<repo>/packages/AmazCGM-<ver>-<group>.zpk` for the Zepp app's developer-mode scanner,
- create and push the tag `v<ver>`, and publish the GitHub Release with the `.zab`, the `.sha256` and the QR codes.

## How QR installs work

The Zepp app's developer-mode scanner downloads the file behind a `zpkd1://` link, which is the HTTPS address with `https://` swapped for `zpkd1://`. It has three requirements, each learned from a failed install:

- **No redirect.** GitHub release asset links redirect to a signed address, and Zepp reports "Download failed, error code: null". `raw.githubusercontent.com` serves files from a branch directly, so the packages live on the orphan branch `packages`, which shares no history with `main`.
- **One `.zpk` per watch, not the `.zab`.** A `.zab` gives "Parse mini program package failed".
- **Preview mode.** `make-zpk.py` sets `packageInfo.mode` to `preview` and `packageInfo.expiredTime` far in the future in the `app.json` of `device.zip` and `app-side.zip`. Nothing else in the package changes.

The repo must stay public, because Zepp downloads without a GitHub login. Do not delete the `packages` branch or its files, because older release QR codes point to them.

## After publishing

Open the release page, scan the QR code with the Zepp app in developer mode and confirm that the app installs and starts on the watch.

To remove a bad or test release: `gh release delete v<ver> --cleanup-tag`, then `git tag -d v<ver>`.
