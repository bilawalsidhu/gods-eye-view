'use strict';

// electron-builder hook: stamp the Windows executable with the app icon and
// version resources. This replaces rcedit (which needs Wine on non-Windows
// build hosts) with resedit, a pure JavaScript PE resource editor.
const fs = require('node:fs');
const path = require('node:path');

const LANG_EN_US = 1033;
const CODEPAGE_UNICODE = 1200;

function triplet(version) {
  const [major = 0, minor = 0, patch = 0] = String(version)
    .split(/[.+-]/)
    .map((part) => Number.parseInt(part, 10) || 0);
  return [major, minor, patch];
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const { productName, version } = context.packager.appInfo;
  const exePath = path.join(context.appOutDir, `${productName}.exe`);
  if (!fs.existsSync(exePath)) {
    throw new Error(`after-pack: executable not found at ${exePath}`);
  }
  const ResEdit = await import('resedit');
  const executable = ResEdit.NtExecutable.from(fs.readFileSync(exePath));
  const resources = ResEdit.NtExecutableResource.from(executable);

  const iconFile = ResEdit.Data.IconFile.from(
    fs.readFileSync(path.join(__dirname, '..', 'assets', 'icon.ico')),
  );
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(resources.entries);
  const groupId = groups.length ? groups[0].id : 1;
  const groupLang = groups.length ? groups[0].lang : LANG_EN_US;
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
    resources.entries,
    groupId,
    groupLang,
    iconFile.icons.map((item) => item.data),
  );

  const [major, minor, patch] = triplet(version);
  const [info] = ResEdit.Resource.VersionInfo.fromEntries(resources.entries);
  info.setFileVersion(major, minor, patch, 0, LANG_EN_US);
  info.setProductVersion(major, minor, patch, 0, LANG_EN_US);
  info.setStringValues(
    { lang: LANG_EN_US, codepage: CODEPAGE_UNICODE },
    {
      FileDescription: productName,
      ProductName: productName,
      CompanyName: "God's Eye View contributors",
      LegalCopyright: 'MIT License',
      OriginalFilename: `${productName}.exe`,
      InternalName: productName,
      FileVersion: `${major}.${minor}.${patch}.0`,
      ProductVersion: `${major}.${minor}.${patch}.0`,
    },
  );
  info.outputToResourceEntries(resources.entries);
  resources.outputResource(executable);
  fs.writeFileSync(exePath, Buffer.from(executable.generate()));
  console.log(
    `  • stamped icon and version resources on ${path.basename(exePath)}`,
  );
};
