#!/usr/bin/env bash

cd vscode || { echo "'vscode' dir not found"; exit 1; }

npm run gulp "vscode-win32-${VSCODE_ARCH}-inno-updater"

# --- Bundle Cline as a built-in extension ---
CLINE_VSIX="../bundled-extensions/saoudrizwan.claude-dev-4.1.16.vsix"
CLINE_TARGET="../VSCode-win32-${VSCODE_ARCH}/resources/app/extensions/saoudrizwan.claude-dev"
if [[ -f "${CLINE_VSIX}" ]]; then
  echo "Bundling Cline built-in extension from ${CLINE_VSIX}"
  rm -rf "${CLINE_TARGET}"
  mkdir -p "${CLINE_TARGET}"
  7z.exe x "${CLINE_VSIX}" -o"${CLINE_TARGET}/_vsix_tmp" -y > /dev/null
  if [[ -d "${CLINE_TARGET}/_vsix_tmp/extension" ]]; then
    cp -r "${CLINE_TARGET}/_vsix_tmp/extension/." "${CLINE_TARGET}/"
  else
    cp -r "${CLINE_TARGET}/_vsix_tmp/." "${CLINE_TARGET}/"
  fi
  rm -rf "${CLINE_TARGET}/_vsix_tmp"
  echo "Cline bundled into ${CLINE_TARGET}"
else
  echo "WARNING: Cline vsix not found at ${CLINE_VSIX} - skipping"
fi
# --- End Bundle Cline ---

# . ../build/windows/appx/build.sh

if [[ "${SHOULD_BUILD_ZIP}" != "no" ]]; then
  7z.exe a -tzip "../assets/${APP_NAME}-win32-${VSCODE_ARCH}-${RELEASE_VERSION}.zip" -x!CodeSignSummary*.md -x!tools "../VSCode-win32-${VSCODE_ARCH}/*" -r
fi

if [[ "${SHOULD_BUILD_EXE_SYS}" != "no" ]]; then
  npm run gulp "vscode-win32-${VSCODE_ARCH}-system-setup"
fi

if [[ "${SHOULD_BUILD_EXE_USR}" != "no" ]]; then
  npm run gulp "vscode-win32-${VSCODE_ARCH}-user-setup"
fi

if [[ "${VSCODE_ARCH}" == "ia32" || "${VSCODE_ARCH}" == "x64" ]]; then
  if [[ "${SHOULD_BUILD_MSI}" != "no" ]]; then
    . ../build/windows/msi/build.sh
  fi

  if [[ "${SHOULD_BUILD_MSI_NOUP}" != "no" ]]; then
    . ../build/windows/msi/build-updates-disabled.sh
  fi
fi

cd ..

if [[ "${SHOULD_BUILD_EXE_SYS}" != "no" ]]; then
  echo "Moving System EXE"
  mv "vscode\\.build\\win32-${VSCODE_ARCH}\\system-setup\\VSCodeSetup.exe" "assets\\${APP_NAME}Setup-${VSCODE_ARCH}-${RELEASE_VERSION}.exe"
fi

if [[ "${SHOULD_BUILD_EXE_USR}" != "no" ]]; then
  echo "Moving User EXE"
  mv "vscode\\.build\\win32-${VSCODE_ARCH}\\user-setup\\VSCodeSetup.exe" "assets\\${APP_NAME}UserSetup-${VSCODE_ARCH}-${RELEASE_VERSION}.exe"
fi

if [[ "${VSCODE_ARCH}" == "ia32" || "${VSCODE_ARCH}" == "x64" ]]; then
  if [[ "${SHOULD_BUILD_MSI}" != "no" ]]; then
    echo "Moving MSI"
    mv "build\\windows\\msi\\releasedir\\${APP_NAME}-${VSCODE_ARCH}-${RELEASE_VERSION}.msi" assets/
  fi

  if [[ "${SHOULD_BUILD_MSI_NOUP}" != "no" ]]; then
    echo "Moving MSI with disabled updates"
    mv "build\\windows\\msi\\releasedir\\${APP_NAME}-${VSCODE_ARCH}-updates-disabled-${RELEASE_VERSION}.msi" assets/
  fi
fi
