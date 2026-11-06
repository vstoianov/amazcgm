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

- check that the versions match, the tag is new and the tree is clean,
- run `npm test` and `npx zeus build`,
- write `release/AmazCGM-<ver>.zab`, its `.sha256`, and `AmazCGM-<ver>-install-qr.png`. The QR code points to `zpkd1://github.com/<repo>/releases/download/v<ver>/AmazCGM-<ver>.zab` for the Zepp app's developer-mode scanner,
- create and push the tag `v<ver>`, and publish the GitHub Release with those three files.

## After publishing

Open the release page, scan the QR code with the Zepp app in developer mode and confirm that the app installs and starts on the watch.

To remove a bad or test release: `gh release delete v<ver> --cleanup-tag`, then `git tag -d v<ver>`.
