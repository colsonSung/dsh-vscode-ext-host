#!/usr/bin/env bash
#
# Install the DeepSeek Harness VS Code extension plugins into a profile.
#
#   ./install.sh            # the profile the running Harness uses
#   ./install.sh web        # a named profile
#
# This repository ships TWO bundles, and they are two halves of one feature:
#
#   plugin/       dsh-vscode-extension-host   the store's counterpart — makes VSIX run
#   vsix-store/   dsh-vsix-store              finds, verifies and installs VSIX packages
#
# The host half ships as SOURCE: the extension host itself is built from the vendored
# VS Code closure (see README.md), so this script builds it first when the build
# products are missing. The store needs no build — it is plain JavaScript.
#
# It installs both packages into the profile and adds both bundle rows to the
# profile's patch layer. Every step is idempotent. Restart the Harness
# afterwards: the host half of a plugin is loaded at start-up.
#
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

# The bundles to install, as "<package name>|<patch row id>|<directory>".
BUNDLES=(
  "dsh-vscode-extension-host|vscode-extension-host|plugin"
  "dsh-vsix-store|vsix-store|vsix-store"
)

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

# 2. Check the profile's patch layer BEFORE anything is installed.
#
#    The bundle rows go into <profile>/cordis.patch.yml, and that file must be a
#    top-level YAML list: a list item may only be appended to another list, so
#    a file whose entries are not list items would become invalid YAML. If the
#    file cannot take a row, refuse now — before a package is installed into a
#    profile that then cannot load it.
#
#    A top-level list item starts with "-" in column 0; the keys of that item
#    are indented under it. So a line that starts in column 0 with anything
#    else (a bare "id: ..." mapping) means the file is NOT a list. The one
#    exception is an empty list "[]" on its own line — the profile template
#    starts with one, and it is a valid list.
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

if grep -vE '^[[:space:]]*(#.*)?$' "$PATCH_FILE" | grep -qvE '^([[:space:]]|-|\[\][[:space:]]*$)'; then
  echo "error: $PATCH_FILE is not a top-level YAML list — refusing to modify it" >&2
  echo "       the profile patch layer must be a list of loader patch entries" >&2
  exit 1
fi

# 3. Install every package into the profile.
for entry in "${BUNDLES[@]}"; do
  package="${entry%%|*}"
  rest="${entry#*|}"
  row_id="${rest%%|*}"
  directory="${rest#*|}"

  echo "==> installing $package into the '$PROFILE' profile"
  dsh plugin --profile "$PROFILE" add "$HERE/$directory"
done

# 4. Add the bundle rows to the profile's patch layer.
#
# ensure_bundle_row <row id> <package name>
#
# Adds one bundle row to the patch layer, or leaves it alone when the row is
# already there. The shape of the patch layer was checked in step 2.
ensure_bundle_row() {
  local row_id="$1"
  local package="$2"

  if grep -q "id: $row_id" "$PATCH_FILE"; then
    echo "==> the bundle row '$row_id' is already in $PATCH_FILE"
    return 0
  fi

  echo "==> adding the bundle row '$row_id' to $PATCH_FILE"

  # An empty list ("[]") cannot be followed by list items: the profile template
  # starts with one, so the entry replaces it instead of being appended.
  awk -v id="$row_id" -v pkg="'$package'" '
    /^\[\][[:space:]]*$/ && !replaced {
      print "- insert:"
      print "    - id: " id
      print "      name: " pkg
      replaced = 1
      next
    }
    { print }
  ' "$PATCH_FILE" > "$PATCH_FILE.tmp"
  if grep -q "id: $row_id" "$PATCH_FILE.tmp"; then
    mv "$PATCH_FILE.tmp" "$PATCH_FILE"
  else
    rm -f "$PATCH_FILE.tmp"
    cat >> "$PATCH_FILE" <<YAML
- insert:
    - id: $row_id
      name: '$package'
YAML
  fi
}

for entry in "${BUNDLES[@]}"; do
  package="${entry%%|*}"
  rest="${entry#*|}"
  row_id="${rest%%|*}"
  ensure_bundle_row "$row_id" "$package"
done

cat <<DONE

installed

  profile  $PROFILE
  packages dsh-vscode-extension-host (extension host), dsh-vsix-store (VSIX store)
  patch    $PATCH_FILE

Next: restart the DeepSeek Harness. The extension host is loaded at start-up;
install the extensions you want from the Extensions page, and mark their
publisher as trusted before the host loads them.
DONE
