/**
 * Wine cannot commit rcedit resource updates ("Unable to commit changes").
 * electron-builder still calls rcedit when signAndEditExecutable is true.
 * This applies the same version strings and icon with the resedit library
 * electron-builder already uses for the asar integrity resource, and keeps
 * every other resource (including INTEGRITY / ELECTRONASAR).
 */
import fs from 'node:fs';
import { NtExecutable, NtExecutableResource, Resource, Data } from 'resedit';

function parse(argv) {
  let exe = null;
  let icon = null;
  let fileVersion = null;
  let productVersion = null;
  const strings = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.includes('rcedit')) continue;
    if (a === '--set-icon') {
      icon = argv[++i];
      continue;
    }
    if (a === '--set-file-version') {
      fileVersion = argv[++i];
      continue;
    }
    if (a === '--set-product-version') {
      productVersion = argv[++i];
      continue;
    }
    if (a === '--set-version-string') {
      const key = argv[++i];
      strings[key] = argv[++i] ?? '';
      continue;
    }
    if (!exe && a.toLowerCase().endsWith('.exe')) exe = a;
  }
  if (!exe) throw new Error('rcedit shim: no executable');
  return { exe, icon, fileVersion, productVersion, strings };
}

function quad(text) {
  const parts = String(text || '0.0.0.0').split('.').map((n) => Number(n) || 0);
  while (parts.length < 4) parts.push(0);
  return parts.slice(0, 4);
}

const job = parse(process.argv.slice(2));
const bin = fs.readFileSync(job.exe);
const executable = NtExecutable.from(bin);
const resource = NtExecutableResource.from(executable);
const infos = Resource.VersionInfo.fromEntries(resource.entries);
if (infos.length !== 1) throw new Error(`rcedit shim: expected one version resource, found ${infos.length}`);
const info = infos[0];
const langs = info.getAllLanguagesForStringValues();
const lang = langs[0] || { lang: 1033, codepage: 1200 };
if (Object.keys(job.strings).length) info.setStringValues(lang, job.strings);
if (job.fileVersion) info.setFileVersion(...quad(job.fileVersion), lang.lang);
if (job.productVersion) info.setProductVersion(...quad(job.productVersion), lang.lang);
info.outputToResourceEntries(resource.entries);
if (job.icon) {
  const iconFile = Data.IconFile.from(fs.readFileSync(job.icon));
  Resource.IconGroupEntry.replaceIconsForResource(
    resource.entries,
    1,
    lang.lang,
    iconFile.icons.map((item) => item.data)
  );
}
resource.outputResource(executable);
fs.writeFileSync(job.exe, Buffer.from(executable.generate()));
const check = fs.readFileSync(job.exe);
if (!check.includes(Buffer.from('ELECTRONASAR', 'utf16le'))) {
  throw new Error('rcedit shim: asar integrity resource was dropped');
}
if (job.strings.ProductName && !check.includes(Buffer.from(job.strings.ProductName, 'utf16le'))) {
  throw new Error('rcedit shim: product name was not written');
}
