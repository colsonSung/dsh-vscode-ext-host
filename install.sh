#!/usr/bin/env bash
#
# Install the DeepSeek Harness VS Code extension suite into a profile.
#
#   ./install.sh            # the profile named by DSH_PROFILE
#   ./install.sh web        # a named profile
#
# The suite is ONE bundle and three plain dependencies:
#
#   plugin/               dsh-vscode-extension-host   the bundle: four plugin rows in its
#                                                     cordis.patch.yml (store, host, LSP, console)
#   vsix-store/           dsh-vsix-store              finds, verifies and installs VSIX packages
#   lsp-stdio/            dsh-lsp-stdio               one stdio language server per language
#   extension-console/    dsh-extension-console       the Extensions view on the Plugins page
#
# Only the bundle goes into \`dsh.profile.bundles\`; the other three are plain dependencies,
# because pnpm does not install the dependencies of a \`link:\` package and the rows would
# otherwise lose their imports on the next install. The plugin manager shows one card either way.
#
# The extension host ships as SOURCE: the host itself is built from the vendored VS Code
# closure (see README.md), so this script builds it first when the build products are missing.
# The store, the LSP provider and the console are plain JavaScript, but the console has a
# browser half that is built too.
#
# Every step is idempotent. Restart the Harness afterwards: the host half of a plugin is
# loaded at start-up.
#
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

# The bundle that carries the four rows.
BUNDLE_PACKAGE="dsh-vscode-extension-host"
BUNDLE_ROW="vscode-extension-host"
BUNDLE_DIR="plugin"

# The plain dependencies the bundle's rows import: "<package name>|<directory>".
SIDE_PACKAGES=(
  "dsh-vsix-store|vsix-store"
  "dsh-lsp-stdio|lsp-stdio"
  "dsh-extension-console|extension-console"
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

# 1. Build everything the profile needs, when it is not built yet.
#
#    plugin/dist/extension-host.js      the child process (the vendored extension host)
#    plugin/main-host.js                the main side (RPC framework, profile seam, tool)
#    plugin/client.js                   the browser half of the bundle
#    packages/dsh-vscode-protocol/dist  the shared RPC protocol library
#    extension-console/client.js        the browser half of the Extensions view
needs_build=0
for artefact in \
  "plugin/dist/extension-host.js" \
  "plugin/main-host.js" \
  "plugin/client.js" \
  "packages/dsh-vscode-protocol/dist/index.js" \
  "extension-console/client.js"
do
  if [ ! -f "$HERE/$artefact" ]; then
    needs_build=1
  fi
done

if [ "$needs_build" -eq 1 ]; then
  echo "==> building the suite (this happens once)"
  if [ ! -d "$HERE/node_modules/esbuild" ]; then
    echo "    installing the build dependency (esbuild)"
    (cd "$HERE" && npm install --no-audit --no-fund --loglevel=error)
  fi
  (cd "$HERE" && npm run build)
else
  echo "==> the suite is already built"
fi

# 2. Check the profile's patch layer BEFORE anything is installed.
#
#    The bundle row goes into <profile>/cordis.patch.yml, and that file must be a
#    top-level YAML list: a list item may only be appended to another list, so a
#    file whose entries are not list items would become invalid YAML. If the file
#    cannot take a row, refuse now — before a package is installed into a profile
#    that then cannot load it.
#
#    A top-level list item starts with "-" in column 0. So a line that starts in
#    column 0 with anything else (a bare "id: ..." mapping) means the file is NOT a
#    list. The one exception is an empty list "[]" on its own line.
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

# 3. Install the bundle and its three side packages.
#
#    The bundle first: its rows name the other three packages, and a row whose
#    package is not installed cannot be imported.
echo "==> installing $BUNDLE_PACKAGE into the '$PROFILE' profile"
dsh plugin --profile "$PROFILE" add "$HERE/$BUNDLE_DIR"

for entry in "${SIDE_PACKAGES[@]}"; do
  package="${entry%%|*}"
  directory="${entry##*|}"
  echo "==> installing $package into the '$PROFILE' profile (plain dependency)"
  dsh plugin --profile "$PROFILE" add "$HERE/$directory"
done

# 4. Add the bundle row to the profile's patch layer.
#
#    ensure_bundle_row <row id> <package name>
#
#    Adds the row, or leaves it alone when it is already there. The shape of the
#    patch layer was checked in step 2. The three side packages need no row: the
#    bundle's own cordis.patch.yml inserts all four.
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

ensure_bundle_row "$BUNDLE_ROW" "$BUNDLE_PACKAGE"

cat <<DONE

installed

  profile  $PROFILE
  bundle   $BUNDLE_PACKAGE (four rows: vsix-store, vscode-extension-host, lsp-stdio, extension-console)
  patch    $PATCH_FILE

Next: restart the DeepSeek Harness. The extension host is loaded at start-up;
install the extensions you want from the Extensions page, and mark their
publisher as trusted before the host loads them.
DONE
