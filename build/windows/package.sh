#!/usr/bin/env bash
# shellcheck disable=SC1091

set -ex

if [[ "${CI_BUILD}" == "no" ]]; then
  exit 1
fi

tar -xzf ./vscode.tar.gz

node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const productPath = path.join('vscode', 'product.json');
const product = JSON.parse(fs.readFileSync(productPath, 'utf8'));
Object.assign(product, {
  nameShort: 'Albion',
  nameLong: 'Albion - The AI Code Editor for Africa',
  applicationName: 'albion',
  win32AppUserModelId: 'Albion.Editor',
});
fs.writeFileSync(productPath, `${JSON.stringify(product, null, 2)}\n`);

const brandingDir = path.join('albion-branding');
const windowsResources = path.join('vscode', 'resources', 'win32');
fs.mkdirSync(windowsResources, { recursive: true });
fs.copyFileSync(path.join(brandingDir, 'icon.ico'), path.join(windowsResources, 'code.ico'));
fs.copyFileSync(path.join(brandingDir, 'logo.png'), path.join(windowsResources, 'albion-logo.png'));

const innoPath = path.join('vscode', 'build', 'win32', 'code.iss');
let inno = fs.readFileSync(innoPath, 'utf8');
if (/^SetupLogging\s*=/im.test(inno)) {
  inno = inno.replace(/^SetupLogging\s*=.*$/im, 'SetupLogging=yes');
} else if (/^\[Setup\]\s*$/im.test(inno)) {
  inno = inno.replace(/^\[Setup\]\s*$/im, (header) => `${header}\r\nSetupLogging=yes`);
} else {
  throw new Error(`Could not find [Setup] section in ${innoPath}`);
}
fs.writeFileSync(innoPath, inno);
console.log('Applied Albion Windows branding and Inno Setup logging.');
NODE

cd vscode || { echo "'vscode' dir not found"; exit 1; }

for i in {1..5}; do # try 5 times
  npm ci && break
  if [[ $i == 5 ]]; then
    echo "Npm install failed too many times" >&2
    exit 1
  fi
  echo "Npm install failed $i, trying again..."
done

node build/azure-pipelines/distro/mixin-npm.ts

# delete native files built in the `compile` step
find .build/extensions -type f -name '*.node' -print -delete

. ../build/windows/rtf/make.sh

# generate Group Policy definitions
npm run copy-policy-dto --prefix build
node build/lib/policies/policyGenerator.ts build/lib/policies/policyData.jsonc win32

# node build/win32/explorer-dll-fetcher.ts .build/win32/appx

npm run gulp "vscode-win32-${VSCODE_ARCH}-min-packing"

. ../build_cli.sh

if [[ "${VSCODE_ARCH}" == "x64" ]]; then
  if [[ "${SHOULD_BUILD_REH}" != "no" ]]; then
    echo "Building REH"
    npm run gulp minify-vscode-reh
    npm run gulp "vscode-reh-win32-${VSCODE_ARCH}-min-ci"
  fi

  if [[ "${SHOULD_BUILD_REH_WEB}" != "no" ]]; then
    echo "Building REH-web"
    npm run gulp minify-vscode-reh-web
    npm run gulp "vscode-reh-web-win32-${VSCODE_ARCH}-min-ci"
  fi
fi

cd ..
