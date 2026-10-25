#!/usr/bin/env bash
#
# Install the DeepSeek Harness "VS Code extension host" plugin into a profile.
#
#   ./install.sh            # the profile the running Harness uses
#   ./install.sh web        # a named profile
#
# The plugin ships as SOURCE: the extension host itself is built from the vendored
# VS Code closure (see README.md), so this script builds it first when the build
# products are missing.
#
# It installs the package into the profile and adds the bundle row to the
# profile's patch layer. Both steps are idempotent. Restart the Harness
# afterwards: the host half of a plugin is loaded at start-up.
#
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PACKAGE="dsh-vscode-extension-host"
ROW_ID="vscode-extension-host"
PLUGIN_DIR="$HERE/plugin"

PROFILE="${1:-${DSH_PROFILE:-}}"
if [ -z "$PROFILE" ]; then
  echo "error: pass a profile name (for example: ./install.sh web)" >&2
  echo "       or set DSH_PROFILE" >&2
  exit 1
fi

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"

if ! command -v dsh >/dev/null 2>&1; then
  echo "error: the 'dsh' command is not on PATH — install the DeepSeek Harness CLI first" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "error: 'node' is not on PATH — the extension host is built with Node.js 20+" >&2
  exit 1
fi

# 1. Build the extension host if the build products are missing.
#
#    plugin/dist/extension-host.js  the child process (the vendored extension host)
#    plugin/main-host.js            the main side (RPC framework, profile seam, tool)
#    plugin/client.js               the browser half
needs_build=0
for artefact in "plugin/dist/extension-host.js" "plugin/main-host.js" "plugin/client.js"; do
  if [ ! -f "$HERE/$artefact" ]; then
    needs_build=1
  fi
done

if [ "$needs_build" -eq 1 ]; then
  echo "==> building the extension host (this happens once)"
  if [ ! -d "$HERE/node_modules/esbuild" ]; then
    echo "    installing the build dependency (esbuild)"
    (cd "$HERE" && npm install --no-audit --no-fund --loglevel=error)
  fi
  (cd "$HERE" && npm run build)
else
  echo "==> the extension host is already built"
fi

# 2. Install the package into the profile.
echo "==> installing $PACKAGE into the '$PROFILE' profile"
dsh plugin --profile "$PROFILE" add "$PLUGIN_DIR"

# 3. Add the bundle row to the profile's patch layer.
if [ ! -d "$PROFILE_DIR" ]; then
  mkdir -p "$PROFILE_DIR"
fi

if [ ! -f "$PATCH_FILE" ]; then
  cat > "$PATCH_FILE" <<'YAML'
# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; `!!js` expressions allowed).
YAML
fi

if grep -q "id: $ROW_ID" "$PATCH_FILE"; then
  echo "==> the bundle row is already in $PATCH_FILE"
else
  echo "==> adding the bundle row to $PATCH_FILE"
  # An empty list ("[]") cannot be followed by list items: the profile template
  # starts with one, so the entry replaces it instead of being appended.
  awk -v id="$ROW_ID" -v pkg="$PACKAGE" '
    /^[[:space:]]*\[\][[:space:]]*$/ && !replaced {
      print "- insert:"
      print "    - id: " id
      print "      name: '\''" pkg "'\''"
      replaced = 1
      next
    }
    { print }
  ' "$PATCH_FILE" > "$PATCH_FILE.tmp"
  if grep -q "id: $ROW_ID" "$PATCH_FILE.tmp"; then
    mv "$PATCH_FILE.tmp" "$PATCH_FILE"
  else
    rm -f "$PATCH_FILE.tmp"
    cat >> "$PATCH_FILE" <<YAML
- insert:
    - id: $ROW_ID
      name: '$PACKAGE'
YAML
  fi
fi

cat <<DONE

installed

  profile  $PROFILE
  package  $PACKAGE
  patch    $PATCH_FILE

Next: restart the DeepSeek Harness. The extension host is loaded at start-up;
install the extensions you want from the Extensions page, and mark their
publisher as trusted before the host loads them.
DONE
