#!/usr/bin/env bash
# Build AmazCGM locally and publish a GitHub Release with the .zab,
# a SHA-256 checksum and a QR code for Zepp developer-mode sideloading.
#
# Usage: npm run release [-- --prerelease]
set -euo pipefail

cd "$(dirname "$0")/.."

PRERELEASE=()
for arg in "$@"; do
  case "$arg" in
    --prerelease) PRERELEASE=(--prerelease) ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

die() { echo "release: $*" >&2; exit 1; }

# --- Preflight -------------------------------------------------------------
command -v gh >/dev/null || die "GitHub CLI 'gh' not found"
gh auth status >/dev/null 2>&1 || die "not logged in to GitHub, run 'gh auth login'"
git diff --quiet && git diff --cached --quiet || die "working tree has uncommitted changes"
[[ "$(git rev-parse --abbrev-ref HEAD)" == "main" ]] || die "not on branch main"

# --- Version guard ---------------------------------------------------------
VER=$(node -p "require('./app.json').app.version.name")
PKG_VER=$(node -p "require('./package.json').version")
[[ "$VER" == "$PKG_VER" ]] || die "app.json version ($VER) != package.json version ($PKG_VER)"
TAG="v$VER"

git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && die "tag $TAG already exists locally"
git ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null 2>&1 && die "tag $TAG already exists on origin"
gh release view "$TAG" >/dev/null 2>&1 && die "release $TAG already exists"

grep -q "^## $VER\b" CHANGELOG.md || die "CHANGELOG.md has no '## $VER' section"

git fetch -q origin main
[[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]] || die "local main differs from origin/main, push or pull first"

REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
# The Zepp app downloads without a GitHub login, so a private repo gives 404.
[[ "$(gh repo view --json visibility -q .visibility)" == "PUBLIC" ]] || die "$REPO is not public, the Zepp app cannot download from it"

echo "Releasing AmazCGM $VER ($TAG) to $REPO"

# --- Test and build --------------------------------------------------------
npm test

rm -rf dist
npx zeus build

shopt -s nullglob
ZABS=(dist/*.zab)
shopt -u nullglob
[[ ${#ZABS[@]} -eq 1 ]] || die "expected exactly one dist/*.zab, found ${#ZABS[@]}"

OUT=release
ZAB="AmazCGM-$VER.zab"
rm -rf "$OUT"
mkdir -p "$OUT"
cp "${ZABS[0]}" "$OUT/$ZAB"

( cd "$OUT" && sha256sum "$ZAB" > "$ZAB.sha256" )

# --- Per-watch packages for QR install -------------------------------------
# The Zepp app's QR installer cannot parse a .zab ("Parse mini program package
# failed") and only accepts preview packages, so make-zpk.py splits the .zab
# into one .zpk per watch group with packageInfo.mode = "preview".
mkdir -p "$OUT/zpk"
mapfile -t PKGS < <(python3 scripts/make-zpk.py app.json "$OUT/$ZAB" "$OUT/zpk" "AmazCGM-$VER")
[[ ${#PKGS[@]} -ge 1 ]] || die "make-zpk.py produced no packages"

# --- Direct download for the Zepp app --------------------------------------
# Release asset URLs answer with a 302 to a signed address, and the Zepp app
# fails on that ("Download failed, error code: null"). raw.githubusercontent.com
# serves files from a branch with a plain 200, so the .zpk files go to the
# orphan branch "packages".
PKG_BRANCH=packages
RAW_BASE="https://raw.githubusercontent.com/$REPO/$PKG_BRANCH"
WT=$(mktemp -d)
rmdir "$WT"
cleanup_wt() { git worktree remove --force "$WT" >/dev/null 2>&1 || true; }
trap cleanup_wt EXIT
if git ls-remote --exit-code --heads origin "$PKG_BRANCH" >/dev/null 2>&1; then
  git fetch -q origin "+refs/heads/$PKG_BRANCH:refs/remotes/origin/$PKG_BRANCH"
  git worktree add -q --detach "$WT" "origin/$PKG_BRANCH"
else
  git worktree add -q --orphan -b "$PKG_BRANCH-tmp-$$" "$WT"
fi
for row in "${PKGS[@]}"; do
  f=${row%%$'\t'*}
  cp "$OUT/zpk/$f" "$WT/$f"
  git -C "$WT" add "$f"
done
git -C "$WT" diff --cached --quiet || git -C "$WT" commit -q -m "AmazCGM $VER"
git -C "$WT" push -q origin "HEAD:refs/heads/$PKG_BRANCH"
cleanup_wt
git branch -D "$PKG_BRANCH-tmp-$$" >/dev/null 2>&1 || true

# --- QR codes for Zepp app developer mode ----------------------------------
QRS=()
INSTALL_MD=""
for row in "${PKGS[@]}"; do
  f=${row%%$'\t'*}
  label=${row#*$'\t'}
  url="$RAW_BASE/$f"
  echo "Waiting for $url"
  for _ in $(seq 1 30); do
    [[ "$(curl -s -o /dev/null -w '%{http_code}' "$url")" == "200" ]] && break
    sleep 2
  done
  curl -s "$url" | cmp -s - "$OUT/zpk/$f" || die "$url does not serve the new $f yet"

  qr="${f%.zpk}-install-qr.png"
  npx --yes qrcode@1.5.4 -o "$OUT/$qr" -w 512 "zpkd1://${url#https://}" >/dev/null
  QRS+=("$OUT/$qr")
  INSTALL_MD+="### $label"$'\n\n'"![Install QR code for $label](https://github.com/$REPO/releases/download/$TAG/$qr)"$'\n\n'
done

# --- Release notes ---------------------------------------------------------
{
  awk -v ver="$VER" '
    $0 ~ "^## " ver "([^0-9.-]|$)" { on = 1; next }
    on && /^## / { exit }
    on { print }
  ' CHANGELOG.md
  cat <<NOTES

## Install

1. In the Zepp app, turn on developer mode: **Profile → Settings → About**, then tap the Zepp logo 7 times.
2. Go to **Profile → your watch → Developer mode → Scan** and scan the QR code for your watch:

${INSTALL_MD}Full instructions: https://github.com/$REPO#install

SHA-256 of \`$ZAB\`: \`$(cut -d' ' -f1 "$OUT/$ZAB.sha256")\`

> [!WARNING]
> AmazCGM is not a medical device. Do not make treatment decisions from this watch.
NOTES
} > "$OUT/notes.md"

# --- Tag and publish -------------------------------------------------------
git tag -a "$TAG" -m "AmazCGM $VER"
git push origin "$TAG"

gh release create "$TAG" \
  "$OUT/$ZAB" "$OUT/$ZAB.sha256" "${QRS[@]}" \
  --title "AmazCGM $VER" \
  --notes-file "$OUT/notes.md" \
  --verify-tag \
  "${PRERELEASE[@]}"

echo "Published: https://github.com/$REPO/releases/tag/$TAG"
