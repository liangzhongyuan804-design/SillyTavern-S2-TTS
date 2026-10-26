/**
 * Locale coverage check.
 *
 * Two kinds of keys exist:
 *   - static panel keys, declared with data-i18n="..." in settings.html
 *   - runtime keys, looked up with t('...') in index.js
 *
 * Every key must exist in both locale files, otherwise the UI would fall back
 * to the raw key (or the hardcoded Chinese default).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(extensionDir, 'settings.html'), 'utf8');
const script = fs.readFileSync(path.join(extensionDir, 'index.js'), 'utf8');
// The profile dialog lives in its own file and looks its strings up with
// `translate()` instead of `t()`.
const profileUi = fs.readFileSync(path.join(extensionDir, 'profile-ui.js'), 'utf8');

const keys = new Set();
for (const match of html.matchAll(/data-i18n="([^"]+)"/g)) {
    for (const raw of match[1].split(';')) {
        const attribute = raw.match(/\[(\S+)\](.+)/);
        keys.add(attribute ? attribute[2] : raw);
    }
}
const panelKeys = new Set(keys);

for (const match of script.matchAll(/\bt\(\s*'([^']+)'/g)) {
    keys.add(match[1]);
}

for (const match of profileUi.matchAll(/\btranslate\(\s*'([^']+)'/g)) {
    keys.add(match[1]);
}

const zh = JSON.parse(fs.readFileSync(path.join(extensionDir, 'locales/zh-CN.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(extensionDir, 'locales/en.json'), 'utf8'));

const missingZh = [...keys].filter((k) => !(k in zh));
const missingEn = [...keys].filter((k) => !(k in en));
const unusedZh = Object.keys(zh).filter((k) => !keys.has(k));
const unusedEn = Object.keys(en).filter((k) => !keys.has(k));

console.log('panel keys (settings.html) :', panelKeys.size);
console.log('runtime keys (index.js)    :', keys.size - panelKeys.size);
console.log('missing in zh-CN.json      :', missingZh.length, missingZh.join(' | '));
console.log('missing in en.json         :', missingEn.length, missingEn.join(' | '));
console.log('unused in zh-CN.json       :', unusedZh.length, unusedZh.join(' | '));
console.log('unused in en.json          :', unusedEn.length, unusedEn.join(' | '));

if (missingZh.length || missingEn.length) {
    console.error('\nFAIL: a locale key is missing.');
    process.exit(1);
}
console.log('\nOK: every locale key is covered.');
