#!/bin/bash
# Builds texc.app from app/texc.swift and installs it to ~/Applications/texc.app.
# Works from any directory:  bash ~/.local/share/texc/app/build.sh
# Needs only the Command Line Tools (swiftc, iconutil, codesign). Idempotent; prints the installed path.
set -euo pipefail

APP_SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEXC_HOME="$(cd "$APP_SRC_DIR/.." && pwd)"
DEST_DIR="$HOME/Applications"
DEST="$DEST_DIR/texc.app"
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
VERSION="1.0"
BUILD_NUMBER="$(date +%Y%m%d%H%M)"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "build.sh: swiftc not found. Install the Command Line Tools: xcode-select --install" >&2
  exit 1
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/texc-build.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
APP="$WORK/texc.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

echo "Compiling texc.swift…" >&2
swiftc -O -swift-version 5 -parse-as-library \
  -target "$(uname -m)-apple-macos13.0" \
  -framework AppKit -framework WebKit \
  -module-name texc \
  -o "$APP/Contents/MacOS/texc" "$APP_SRC_DIR/texc.swift"

echo "Drawing the icon…" >&2
"$APP/Contents/MacOS/texc" --render-icon "$WORK/texc.iconset"
iconutil -c icns "$WORK/texc.iconset" -o "$APP/Contents/Resources/texc.icns"

# PATH at build time, minus folders that don't exist or only live in temp space.
TEXC_PATH=""
IFS=':' read -r -a PATH_PARTS <<< "${PATH:-}"
for d in "${PATH_PARTS[@]}"; do
  [ -n "$d" ] && [ -d "$d" ] || continue
  case "$d" in /tmp/*|/private/tmp/*|/private/var/folders/*|/var/folders/*) continue ;; esac
  case ":$TEXC_PATH:" in *":$d:"*) continue ;; esac
  TEXC_PATH="${TEXC_PATH:+$TEXC_PATH:}$d"
done

PLIST="$APP/Contents/Info.plist"
cat > "$PLIST" <<'PLIST_EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>local.texc</string>
  <key>CFBundleName</key><string>texc</string>
  <key>CFBundleDisplayName</key><string>texc</string>
  <key>CFBundleExecutable</key><string>texc</string>
  <key>CFBundleIconFile</key><string>texc</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleSignature</key><string>????</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleShortVersionString</key><string>VERSION_PLACEHOLDER</string>
  <key>CFBundleVersion</key><string>BUILD_PLACEHOLDER</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSSupportsAutomaticTermination</key><false/>
  <key>NSSupportsSuddenTermination</key><false/>
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>CFBundleDocumentTypes</key>
  <array>
    <dict>
      <key>CFBundleTypeName</key><string>Folder</string>
      <key>CFBundleTypeRole</key><string>Editor</string>
      <key>LSHandlerRank</key><string>Alternate</string>
      <key>LSItemContentTypes</key><array><string>public.folder</string></array>
    </dict>
    <dict>
      <key>CFBundleTypeName</key><string>LaTeX document</string>
      <key>CFBundleTypeRole</key><string>Editor</string>
      <key>LSHandlerRank</key><string>Alternate</string>
      <key>CFBundleTypeExtensions</key><array><string>tex</string></array>
    </dict>
  </array>
  <key>NSDesktopFolderUsageDescription</key><string>texc opens the LaTeX folders you choose.</string>
  <key>NSDocumentsFolderUsageDescription</key><string>texc opens the LaTeX folders you choose.</string>
  <key>NSDownloadsFolderUsageDescription</key><string>texc opens the LaTeX folders you choose.</string>
  <key>NSRemovableVolumesUsageDescription</key><string>texc opens the LaTeX folders you choose.</string>
  <key>NSNetworkVolumesUsageDescription</key><string>texc opens the LaTeX folders you choose.</string>
  <key>NSMicrophoneUsageDescription</key><string>texc uses the microphone for chat dictation.</string>
  <key>NSSpeechRecognitionUsageDescription</key><string>texc turns your dictation into chat text.</string>
  <key>TexcPython</key><string>/usr/bin/python3</string>
  <key>TexcHome</key><string>HOME_PLACEHOLDER</string>
  <key>TexcPath</key><string>PATH_PLACEHOLDER</string>
</dict>
</plist>
PLIST_EOF
# plutil does the XML escaping for the values that come from the environment.
plutil -replace CFBundleShortVersionString -string "$VERSION" "$PLIST"
plutil -replace CFBundleVersion -string "$BUILD_NUMBER" "$PLIST"
plutil -replace TexcHome -string "$TEXC_HOME" "$PLIST"
plutil -replace TexcPath -string "$TEXC_PATH" "$PLIST"
plutil -lint "$PLIST" >/dev/null
printf 'APPL????' > "$APP/Contents/PkgInfo"

codesign --force --deep -s - "$APP" >/dev/null 2>&1 || codesign --force --deep -s - "$APP"

# A running copy keeps its old binary (the install below is two renames), so it is NOT quit by
# default: quitting could interrupt the user's work. TEXC_BUILD_QUIT=1 asks running copies to quit
# like ⌘Q (pages save and may ask about unreviewed AI edits); nothing is ever force-killed.
# Test copies (--automation, or TEXC_AUTOMATION_DIR in their environment) are always left alone.
user_copies() {
  for pid in $(pgrep -x texc 2>/dev/null); do
    case "$(ps -o args= -p "$pid" 2>/dev/null)" in *--automation*) continue ;; esac
    case "$(ps -E -o command= -p "$pid" 2>/dev/null)" in *TEXC_AUTOMATION_DIR=*) continue ;; esac
    echo "$pid"
  done
}
PIDS="$(user_copies)"
if [ -n "$PIDS" ]; then
  if [ "${TEXC_BUILD_QUIT:-}" = "1" ]; then
    echo "Asking the running texc to quit…" >&2
    kill $PIDS 2>/dev/null || true
    for _ in $(seq 1 100); do [ -n "$(user_copies)" ] || break; sleep 0.2; done
    [ -z "$(user_copies)" ] || echo "texc is still running (it may be asking about unsaved work); it keeps the old version until you quit it." >&2
  else
    echo "Note: texc is running; quit and reopen it to use the new version." >&2
  fi
fi

# Install: copy next to the destination, then swap with two renames.
mkdir -p "$DEST_DIR"
rm -rf "$DEST.new" "$DEST.old"
ditto "$APP" "$DEST.new"
if [ -e "$DEST" ]; then mv "$DEST" "$DEST.old"; fi
mv "$DEST.new" "$DEST"
rm -rf "$DEST.old"
"$LSREGISTER" -f "$DEST" >/dev/null 2>&1 || true

echo "$DEST"
