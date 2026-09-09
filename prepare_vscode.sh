#!/usr/bin/env bash
# shellcheck disable=SC1091,2154

set -e

if [[ "${VSCODE_QUALITY}" == "insider" ]]; then
  cp -rp src/insider/* vscode/
else
  cp -rp src/stable/* vscode/
fi

cp -f LICENSE vscode/LICENSE.txt

cd vscode || { echo "'vscode' dir not found"; exit 1; }

{ set +x; } 2>/dev/null

# {{{ product.json
cp product.json{,.bak}

setpath() {
  local jsonTmp
  { set +x; } 2>/dev/null
  jsonTmp=$( jq --arg 'value' "${3}" "setpath(path(.${2}); \$value)" "${1}.json" )
  echo "${jsonTmp}" > "${1}.json"
  set -x
}

setpath_json() {
  local jsonTmp
  { set +x; } 2>/dev/null
  jsonTmp=$( jq --argjson 'value' "${3}" "setpath(path(.${2}); \$value)" "${1}.json" )
  echo "${jsonTmp}" > "${1}.json"
  set -x
}

setpath "product" "checksumFailMoreInfoUrl" "https://go.microsoft.com/fwlink/?LinkId=828886"
setpath "product" "documentationUrl" "https://go.microsoft.com/fwlink/?LinkID=533484#vscode"
setpath_json "product" "extensionsGallery" '{"serviceUrl": "https://open-vsx.org/vscode/gallery", "itemUrl": "https://open-vsx.org/vscode/item", "latestUrlTemplate": "https://open-vsx.org/vscode/gallery/{publisher}/{name}/latest", "controlUrl": "https://raw.githubusercontent.com/EclipseFdn/publish-extensions/refs/heads/master/extension-control/extensions.json"}'

setpath "product" "introductoryVideosUrl" "https://go.microsoft.com/fwlink/?linkid=832146"
setpath "product" "keyboardShortcutsUrlLinux" "https://go.microsoft.com/fwlink/?linkid=832144"
setpath "product" "keyboardShortcutsUrlMac" "https://go.microsoft.com/fwlink/?linkid=832143"
setpath "product" "keyboardShortcutsUrlWin" "https://go.microsoft.com/fwlink/?linkid=832145"
setpath "product" "licenseUrl" "https://github.com/VSCodium/vscodium/blob/master/LICENSE"
setpath_json "product" "linkProtectionTrustedDomains" '["https://open-vsx.org"]'
setpath "product" "releaseNotesUrl" "https://go.microsoft.com/fwlink/?LinkID=533483#vscode"
setpath "product" "reportIssueUrl" "https://github.com/VSCodium/vscodium/issues/new"
setpath "product" "requestFeatureUrl" "https://go.microsoft.com/fwlink/?LinkID=533482"
setpath "product" "tipsAndTricksUrl" "https://go.microsoft.com/fwlink/?linkid=852118"
setpath "product" "twitterUrl" "https://go.microsoft.com/fwlink/?LinkID=533687"

if [[ "${DISABLE_UPDATE}" != "yes" ]]; then
  setpath "product" "updateUrl" "https://raw.githubusercontent.com/VSCodium/versions/refs/heads/master"

  if [[ "${VSCODE_QUALITY}" == "insider" ]]; then
    setpath "product" "downloadUrl" "https://github.com/VSCodium/vscodium-insiders/releases"
  else
    setpath "product" "downloadUrl" "https://github.com/VSCodium/vscodium/releases"
  fi

  # if [[ "${OS_NAME}" == "windows" ]]; then
  #   setpath_json "product" "win32VersionedUpdate" "true"
  # fi
fi

if [[ "${VSCODE_QUALITY}" == "insider" ]]; then
  setpath "product" "nameShort" "Albion - Insiders"
  setpath "product" "nameLong" "Albion - The AI Code Editor for Africa (Insiders)"
  setpath "product" "applicationName" "albion-insiders"
  setpath "product" "dataFolderName" ".albion-insiders"
  setpath "product" "linuxIconName" "albion-insiders"
  setpath "product" "quality" "insider"
  setpath "product" "urlProtocol" "albion-insiders"
  setpath "product" "serverApplicationName" "albion-server-insiders"
  setpath "product" "serverDataFolderName" ".albion-server-insiders"
  setpath "product" "darwinBundleIdentifier" "com.albion.editor.insiders"
  setpath "product" "win32AppUserModelId" "Albion.Editor.Insiders"
  setpath "product" "win32DirName" "Albion Insiders"
  setpath "product" "win32MutexName" "albioninsiders"
  setpath "product" "win32NameVersion" "Albion Insiders"
  setpath "product" "win32RegValueName" "AlbionInsiders"
  setpath "product" "win32ShellNameShort" "Albion Insiders"
  setpath "product" "win32AppId" "{{EF35BB36-FA7E-4BB9-B7DA-D1E09F2DA9C9}"
  setpath "product" "win32x64AppId" "{{B2E0DDB2-120E-4D34-9F7E-8C688FF839A2}"
  setpath "product" "win32arm64AppId" "{{44721278-64C6-4513-BC45-D48E07830599}"
  setpath "product" "win32UserAppId" "{{ED2E5618-3E7E-4888-BF3C-A6CCC84F586F}"
  setpath "product" "win32x64UserAppId" "{{20F79D0D-A9AC-4220-9A81-CE675FFB6B41}"
  setpath "product" "win32arm64UserAppId" "{{2E362F92-14EA-455A-9ABD-3E656BBBFE71}"
  setpath "product" "tunnelApplicationName" "albion-insiders-tunnel"
  setpath "product" "win32TunnelServiceMutex" "albioninsiders-tunnelservice"
  setpath "product" "win32TunnelMutex" "albioninsiders-tunnel"
  setpath "product" "win32ContextMenu.x64.clsid" "90AAD229-85FD-43A3-B82D-8598A88829CF"
  setpath "product" "win32ContextMenu.arm64.clsid" "7544C31C-BDBF-4DDF-B15E-F73A46D6723D"
else
  setpath "product" "nameShort" "Albion"
  setpath "product" "nameLong" "Albion - The AI Code Editor for Africa"
  setpath "product" "applicationName" "albion"
  setpath "product" "linuxIconName" "albion"
  setpath "product" "quality" "stable"
  setpath "product" "urlProtocol" "albion"
  setpath "product" "serverApplicationName" "albion-server"
  setpath "product" "serverDataFolderName" ".albion-server"
  setpath "product" "darwinBundleIdentifier" "com.albion.editor"
  setpath "product" "win32AppUserModelId" "Albion.Editor"
  setpath "product" "win32DirName" "Albion"
  setpath "product" "win32MutexName" "albion"
  setpath "product" "win32NameVersion" "Albion"
  setpath "product" "win32RegValueName" "Albion"
  setpath "product" "win32ShellNameShort" "Albion"
  setpath "product" "win32AppId" "{{763CBF88-25C6-4B10-952F-326AE657F16B}"
  setpath "product" "win32x64AppId" "{{88DA3577-054F-4CA1-8122-7D820494CFFB}"
  setpath "product" "win32arm64AppId" "{{67DEE444-3D04-4258-B92A-BC1F0FF2CAE4}"
  setpath "product" "win32UserAppId" "{{0FD05EB4-651E-4E78-A062-515204B47A3A}"
  setpath "product" "win32x64UserAppId" "{{2E1F05D1-C245-4562-81EE-28188DB6FD17}"
  setpath "product" "win32arm64UserAppId" "{{57FD70A5-1B8D-4875-9F40-C5553F094828}"
  setpath "product" "tunnelApplicationName" "codium-tunnel"
  setpath "product" "win32TunnelServiceMutex" "vscodium-tunnelservice"
  setpath "product" "win32TunnelMutex" "vscodium-tunnel"
  setpath "product" "win32ContextMenu.x64.clsid" "D910D5E6-B277-4F4A-BDC5-759A34EEE25D"
  setpath "product" "win32ContextMenu.arm64.clsid" "4852FC55-4A84-4EA1-9C86-D53BE3DF83C0"
fi

setpath_json "product" "tunnelApplicationConfig" '{}'

jsonTmp=$( jq -s '.[0] * .[1]' product.json ../product.json )
echo "${jsonTmp}" > product.json && unset jsonTmp

cat product.json
# }}}

# include common functions
. ../utils.sh

# {{{ apply patches

echo "APP_NAME=\"${APP_NAME}\""
echo "APP_NAME_LC=\"${APP_NAME_LC}\""
echo "ASSETS_REPOSITORY=\"${ASSETS_REPOSITORY}\""
echo "BINARY_NAME=\"${BINARY_NAME}\""
echo "GH_REPO_PATH=\"${GH_REPO_PATH}\""
echo "GLOBAL_DIRNAME=\"${GLOBAL_DIRNAME}\""
echo "ORG_NAME=\"${ORG_NAME}\""
echo "TUNNEL_APP_NAME=\"${TUNNEL_APP_NAME}\""

if [[ "${DISABLE_UPDATE}" == "yes" ]]; then
  mv ../patches/00-update-disable.patch.yet ../patches/00-update-disable.patch
fi

for file in ../patches/*.json; do
  if [[ -f "${file}" ]]; then
    apply_actions "${file}"
  fi
done

for file in ../patches/*.patch; do
  if [[ -f "${file}" ]]; then
    apply_patch "${file}"
  fi
done

if [[ "${VSCODE_QUALITY}" == "insider" ]]; then
  for file in ../patches/insider/*.patch; do
    if [[ -f "${file}" ]]; then
      apply_patch "${file}"
    fi
  done
fi

if [[ -d "../patches/${OS_NAME}/" ]]; then
  for file in "../patches/${OS_NAME}/"*.patch; do
    if [[ -f "${file}" ]]; then
      apply_patch "${file}"
    fi
  done
fi

for file in ../patches/user/*.patch; do
  if [[ -f "${file}" ]]; then
    apply_patch "${file}"
  fi
done
# }}}

# {{{ patch GitHub fetch authentication to bypass 60 req/hr rate limits
if [[ -f "build/lib/fetch.ts" ]]; then
  node -e "
    const fs = require('fs');
    const file = 'build/lib/fetch.ts';
    let code = fs.readFileSync(file, 'utf8');
    code = code.replace(/'User-Agent':\s*'VSCode Build'/g, \"'User-Agent': 'Albion-Build'\");
    code = code.replace(/ghApiHeaders\.Authorization\s*=\s*'Basic '\s*\+\s*Buffer\.from\(process\.env\.GITHUB_TOKEN\)\.toString\('base64'\);/g, \"ghApiHeaders.Authorization = \\\`token \\\${process.env.GITHUB_TOKEN}\\\`;\");
    fs.writeFileSync(file, code);
  "
fi
# }}}

set -x

# {{{ install dependencies
export ELECTRON_SKIP_BINARY_DOWNLOAD=1
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

if [[ "${OS_NAME}" == "linux" ]]; then
  export VSCODE_SKIP_NODE_VERSION_CHECK=1

   if [[ "${npm_config_arch}" == "arm" ]]; then
    export npm_config_arm_version=7
  fi
elif [[ "${OS_NAME}" == "windows" ]]; then
  if [[ "${npm_config_arch}" == "arm" ]]; then
    export npm_config_arm_version=7
  fi
else
  if [[ "${CI_BUILD}" != "no" ]]; then
    clang++ --version
  fi
fi

node build/npm/preinstall.ts

mv .npmrc .npmrc.bak
cp ../npmrc .npmrc

for i in {1..5}; do # try 5 times
  if [[ "${CI_BUILD}" != "no" && "${OS_NAME}" == "osx" ]]; then
    CXX=clang++ npm ci && break
  else
    npm ci && break
  fi

  if [[ $i == 5 ]]; then
    echo "Npm install failed too many times" >&2
    exit 1
  fi
  echo "Npm install failed $i, trying again..."

  sleep $(( 15 * (i + 1)))
done

mv .npmrc.bak .npmrc
# }}}

# package.json
cp package.json{,.bak}

setpath "package" "version" "${RELEASE_VERSION%-insider}"

replace 's|Microsoft Corporation|VSCodium|' package.json

cp resources/server/manifest.json{,.bak}

if [[ "${VSCODE_QUALITY}" == "insider" ]]; then
  setpath "resources/server/manifest" "name" "VSCodium - Insiders"
  setpath "resources/server/manifest" "short_name" "VSCodium - Insiders"
else
  setpath "resources/server/manifest" "name" "VSCodium"
  setpath "resources/server/manifest" "short_name" "VSCodium"
fi

# announcements
replace "s|\\[\\/\\* BUILTIN_ANNOUNCEMENTS \\*\\/\\]|$( tr -d '\n' < ../announcements-builtin.json )|" src/vs/workbench/contrib/welcomeGettingStarted/browser/gettingStarted.ts

../undo_telemetry.sh

replace 's|Microsoft Corporation|VSCodium|' build/lib/electron.ts
replace 's|([0-9]) Microsoft|\1 VSCodium|' build/lib/electron.ts

if [[ "${OS_NAME}" == "linux" ]]; then
  # microsoft adds their apt repo to sources
  # unless the app name is code-oss
  # as we are renaming the application to vscodium
  # we need to edit a line in the post install template
  if [[ "${VSCODE_QUALITY}" == "insider" ]]; then
    sed -i "s/code-oss/codium-insiders/" resources/linux/debian/postinst.template
  else
    sed -i "s/code-oss/codium/" resources/linux/debian/postinst.template
  fi

  # fix the packages metadata
  # code.appdata.xml
  sed -i 's|Visual Studio Code|VSCodium|g' resources/linux/code.appdata.xml
  sed -i 's|https://code.visualstudio.com/docs/setup/linux|https://github.com/VSCodium/vscodium#download-install|' resources/linux/code.appdata.xml
  sed -i 's|https://code.visualstudio.com/home/home-screenshot-linux-lg.png|https://vscodium.com/img/vscodium.png|' resources/linux/code.appdata.xml
  sed -i 's|https://code.visualstudio.com|https://vscodium.com|' resources/linux/code.appdata.xml

  # control.template
  sed -i 's|Microsoft Corporation <vscode-linux@microsoft.com>|VSCodium Team https://github.com/VSCodium/vscodium/graphs/contributors|'  resources/linux/debian/control.template
  sed -i 's|Visual Studio Code|VSCodium|g' resources/linux/debian/control.template
  sed -i 's|https://code.visualstudio.com/docs/setup/linux|https://github.com/VSCodium/vscodium#download-install|' resources/linux/debian/control.template
  sed -i 's|https://code.visualstudio.com|https://vscodium.com|' resources/linux/debian/control.template

  # code.spec.template
  sed -i 's|Microsoft Corporation|VSCodium Team|' resources/linux/rpm/code.spec.template
  sed -i 's|Visual Studio Code Team <vscode-linux@microsoft.com>|VSCodium Team https://github.com/VSCodium/vscodium/graphs/contributors|' resources/linux/rpm/code.spec.template
  sed -i 's|Visual Studio Code|VSCodium|' resources/linux/rpm/code.spec.template
  sed -i 's|https://code.visualstudio.com/docs/setup/linux|https://github.com/VSCodium/vscodium#download-install|' resources/linux/rpm/code.spec.template
  sed -i 's|https://code.visualstudio.com|https://vscodium.com|' resources/linux/rpm/code.spec.template

  # snapcraft.yaml
  sed -i 's|Visual Studio Code|VSCodium|' resources/linux/rpm/code.spec.template
elif [[ "${OS_NAME}" == "windows" ]]; then
  # code.iss
  sed -i 's|https://code.visualstudio.com|https://vscodium.com|' build/win32/code.iss
  sed -i 's|Microsoft Corporation|VSCodium|' build/win32/code.iss
fi


# ============================================================
# ALBION: Bundle verifier companion module into the binary
# ============================================================
# SECURITY: Do NOT copy albion-proxy/ here. The proxy holds
# SUPABASE_SERVICE_KEY and runs cloud-only. Never ship backend
# secrets or server code inside the desktop installer.
# ============================================================
echo "📦 Bundling Albion verifier module..."

VERIFIER_DEST="resources/albion/verifier"
mkdir -p "${VERIFIER_DEST}"

# Core scripts (verifier.js uses ONLY built-in Node modules — zero deps)
cp ../albion-verifier/verifier.js              "${VERIFIER_DEST}/"
cp ../albion-verifier/supabase-autosave.js     "${VERIFIER_DEST}/"
cp ../albion-verifier/albion-lifecycle.js      "${VERIFIER_DEST}/"
cp ../albion-verifier/albion-status-bar.js     "${VERIFIER_DEST}/" 2>/dev/null || true
cp ../albion-verifier/project-memory.js        "${VERIFIER_DEST}/" 2>/dev/null || true
cp ../albion-verifier/repo-indexer.js          "${VERIFIER_DEST}/" 2>/dev/null || true
cp ../albion-verifier/package.json             "${VERIFIER_DEST}/"
cp ../albion-verifier/mcp-server.json          "${VERIFIER_DEST}/"

# Bundle the pre-installed @supabase/supabase-js directly.
# This eliminates any npm install step on user's machine — critical for
# users on limited data plans (Nigerian/African devs are the primary target).
if [[ -d "../albion-verifier/node_modules" ]]; then
  mkdir -p "${VERIFIER_DEST}/node_modules"
  # Copy only the supabase client and its direct dependencies — not the full tree
  for pkg in @supabase dotenv; do
    if [[ -d "../albion-verifier/node_modules/${pkg}" ]]; then
      cp -r "../albion-verifier/node_modules/${pkg}" "${VERIFIER_DEST}/node_modules/"
    fi
  done
  echo "✅ Bundled pre-installed node_modules (no npm ci required on launch)."
else
  echo "⚠️  albion-verifier/node_modules not found — run: cd albion-verifier && npm ci"
  echo "    Users will need network access on first launch to install dependencies."
fi

echo "✅ Albion verifier module bundled into ${VERIFIER_DEST}"
# ============================================================

# ============================================================
# ALBION: Bundle branding assets into resources
# ============================================================
echo "📦 Bundling Albion branding assets..."
BRANDING_DEST="resources/albion/branding"
mkdir -p "${BRANDING_DEST}"

if [[ -d "../albion-branding" ]]; then
  cp -r ../albion-branding/* "${BRANDING_DEST}/" 2>/dev/null || true
  echo "✅ Bundled albion-branding into ${BRANDING_DEST}"
elif [[ -d "albion-branding" ]]; then
  cp -r albion-branding/* "${BRANDING_DEST}/" 2>/dev/null || true
  echo "✅ Bundled albion-branding into ${BRANDING_DEST}"
else
  echo "⚠️  albion-branding directory not found"
fi
# ============================================================

# ============================================================
# ALBION: Inject VERIFIER_PATH into Electron main process
# ============================================================
echo "🔧 Injecting ALBION_VERIFIER_PATH into Electron main..."

# Define correct paths based on VSCodium's CI build structure
# Handles execution from inside vscode/ directory or from repo root
ELECTRON_MAIN="src/vs/code/electron-main/main.ts"
if [ ! -f "$ELECTRON_MAIN" ]; then
  ELECTRON_MAIN="vscode/src/vs/code/electron-main/main.ts"
fi
if [ ! -f "$ELECTRON_MAIN" ]; then
  ELECTRON_MAIN="src/main.js"
fi
if [ ! -f "$ELECTRON_MAIN" ]; then
  ELECTRON_MAIN="vscode/src/main.js"
fi

if [ ! -f "$ELECTRON_MAIN" ]; then
  echo "⚠️  Warning: Electron main entry point not found. Skipping ALBION_VERIFIER_PATH injection."
  echo "   Checked: src/vs/code/electron-main/main.ts and vscode/src/vs/code/electron-main/main.ts"
else
  # Create injection line using a variable to avoid ALL shell quoting issues
  INJECTION_LINE='process.env["ALBION_VERIFIER_PATH"] = require("path").join(process.resourcesPath || __dirname, "albion/verifier");'
  
  # Use cat + temp file instead of sed (works identically on Linux, macOS, Windows CI)
  TMPFILE=$(mktemp)
  echo "$INJECTION_LINE" > "$TMPFILE"
  cat "$TMPFILE" "$ELECTRON_MAIN" > "${ELECTRON_MAIN}.tmp" && mv "${ELECTRON_MAIN}.tmp" "$ELECTRON_MAIN"
  rm -f "$TMPFILE"
  
  echo "✅ ALBION_VERIFIER_PATH injected into $ELECTRON_MAIN"
fi
# ============================================================

cd ..
