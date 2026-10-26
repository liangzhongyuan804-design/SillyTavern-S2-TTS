/**
 * Checks the JavaScript of the extension for syntax errors.
 *
 * The browser loads the extension as ES modules, but `node --check` treats a
 * `.js` file as CommonJS. This script therefore parses every file with the
 * module parser of Node itself — the same parser the browser uses, without
 * executing anything.
 *
 * Usage: node test/syntax-check.mjs [file ...]
 */

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

// The module parser still needs a flag, so the script starts itself again
// with it when it is missing.
if (typeof vm.SourceTextModule !== 'function') {
    const result = spawnSync(
        process.execPath,
        ['--experimental-vm-modules', fileURLToPath(import.meta.url), ...process.argv.slice(2)],
        { stdio: 'inherit' },
    );
    process.exit(result.status ?? 1);
}

/** The files that are checked when nothing is given on the command line. */
const defaults = [
    'index.js',
    'player.js',
    'queue.js',
    'sanitize.js',
    'voicetree.js',
    'profile.js',
    'profile-ui.js',
    'plugin/index.js',
    'plugin/cache.js',
    'plugin/voices.js',
    'plugin/profile.js',
];

const targets = process.argv.slice(2);
const files = (targets.length ? targets : defaults).map((name) => resolve(root, name));

let failed = 0;

for (const file of files) {
    const label = relative(root, file).replaceAll('\\', '/');
    if (!existsSync(file)) {
        console.log(`FAIL ${label} (missing)`);
        failed++;
        continue;
    }
    try {
        const source = readFileSync(file, 'utf8');
        // Only parses the source, the imports are not resolved and the code
        // is never run.
        new vm.SourceTextModule(source, { identifier: file });
        console.log(`ok   ${label}`);
    } catch (error) {
        console.log(`FAIL ${label}`);
        console.log(`     ${error.message}`);
        failed++;
    }
}

console.log(`\n${files.length - failed}/${files.length} files parsed`);
process.exit(failed ? 1 : 0);
