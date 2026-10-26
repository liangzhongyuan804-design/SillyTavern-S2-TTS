#!/usr/bin/env node
/**
 * Installs the S2 TTS extension into a SillyTavern installation.
 *
 * Node is the one runtime every SillyTavern already needs, so this installer
 * works the same on Windows, Linux and macOS. The PowerShell version
 * (install.ps1) does the same thing for people who prefer it.
 *
 * Usage:
 *   node install.mjs --st <path to the SillyTavern folder>
 *   node install.mjs <path to the SillyTavern folder>
 *
 * It does three things:
 *
 *   1. the browser extension -> <ST>/public/scripts/extensions/third-party/st-s2-tts/
 *   2. the server plugin      -> <ST>/plugins/st-s2-tts/
 *   3. enables the server plugins in <ST>/config.yaml
 *
 * The server plugins are switched off by default in SillyTavern. Without that
 * switch the server plugin is never loaded and the extension reports a
 * connection error.
 */
import { existsSync, mkdirSync, cpSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

/** The name of the folder the extension is installed under. */
const EXTENSION_NAME = 'st-s2-tts';

/**
 * The files that make up the browser extension.
 *
 * They live in the root of the repository, so that the very same repository
 * can be cloned by the extension manager (as a browser extension) and by
 * "node plugins.js install" (as a server plugin).
 */
const EXTENSION_FILES = [
    'manifest.json',
    'index.js',
    'player.js',
    'queue.js',
    'sanitize.js',
    'profile.js',
    'profile-ui.js',
    'voicetree.js',
    'settings.html',
    'style.css',
];

/** The folders of the browser extension. */
const EXTENSION_DIRS = ['locales'];

/**
 * Reads the SillyTavern folder from the command line.
 *
 * @param {string[]} argv The arguments.
 * @returns {string|null} The folder, or null when it was not given.
 */
function parseArgs(argv) {
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--st' || arg === '--stroot' || arg === '--StRoot') {
            return argv[i + 1] ?? null;
        }
        if (arg.startsWith('--st=')) {
            return arg.slice('--st='.length);
        }
        if (!arg.startsWith('-')) {
            return arg;
        }
    }
    return null;
}

/**
 * Prints a line.
 *
 * @param {string} text The text.
 */
function say(text) {
    console.log(text);
}

/**
 * Copies the browser extension into the SillyTavern installation.
 *
 * @param {string} stRoot The SillyTavern folder.
 */
function installExtension(stRoot) {
    const target = path.join(stRoot, 'public', 'scripts', 'extensions', 'third-party', EXTENSION_NAME);
    if (existsSync(target)) {
        // Remove first: copying into an existing folder nests it.
        rmSync(target, { recursive: true, force: true });
    }
    mkdirSync(target, { recursive: true });

    for (const file of EXTENSION_FILES) {
        const source = path.join(ROOT, file);
        if (!existsSync(source)) {
            throw new Error(`缺少文件：${file}`);
        }
        cpSync(source, path.join(target, file));
    }
    for (const dir of EXTENSION_DIRS) {
        const source = path.join(ROOT, dir);
        if (!existsSync(source)) {
            throw new Error(`缺少目录：${dir}`);
        }
        cpSync(source, path.join(target, dir), { recursive: true });
    }
    say(`[1/3] 浏览器扩展已安装 -> ${target}`);
}

/**
 * Copies the server plugin into the SillyTavern installation.
 *
 * @param {string} stRoot The SillyTavern folder.
 */
function installPlugin(stRoot) {
    const source = path.join(ROOT, 'plugin');
    const target = path.join(stRoot, 'plugins', EXTENSION_NAME);
    if (!existsSync(source)) {
        throw new Error('缺少 plugin 目录。');
    }
    if (existsSync(target)) {
        rmSync(target, { recursive: true, force: true });
    }
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(source, target, { recursive: true });
    say(`[2/3] 服务端插件已安装 -> ${target}`);
}

/**
 * Switches the server plugins on in config.yaml.
 *
 * @param {string} stRoot The SillyTavern folder.
 */
function enableServerPlugins(stRoot) {
    const configPath = path.join(stRoot, 'config.yaml');
    if (!existsSync(configPath)) {
        say('[3/3] 未找到 config.yaml，跳过自动修改。');
        say('      请手动在 config.yaml 中添加：enableServerPlugins: true');
        return;
    }
    const config = readFileSync(configPath, 'utf8');
    if (/^\s*enableServerPlugins\s*:/m.test(config)) {
        say('[3/3] config.yaml 已存在 enableServerPlugins 配置，跳过。');
        return;
    }
    const updated = `${config.trimEnd()}\n\n# Added by the S2 TTS installer.\nenableServerPlugins: true\n`;
    // UTF-8 without a BOM: a BOM in front of the YAML document breaks the parser.
    writeFileSync(configPath, updated, { encoding: 'utf8' });
    say('[3/3] 已在 config.yaml 中启用 enableServerPlugins: true');
}

const stRoot = parseArgs(process.argv.slice(2));

say('S2 TTS 安装程序');
if (!stRoot) {
    say('  用法：node install.mjs --st <SillyTavern 目录>');
    process.exit(1);
}

const resolved = path.resolve(stRoot);
if (!existsSync(path.join(resolved, 'server.js'))) {
    say(`  这不是 SillyTavern 根目录（缺少 server.js）：${resolved}`);
    process.exit(1);
}
say(`  SillyTavern : ${resolved}`);
say('');

try {
    installExtension(resolved);
    installPlugin(resolved);
    enableServerPlugins(resolved);
} catch (error) {
    say(`安装失败：${error.message}`);
    process.exit(1);
}

say('');
say('安装完成。后续步骤：');
say('  1) 启动 s2.cpp 服务（参考你的 ComfyUI-FishS2-GGUF 配置，或用扩展设置里的「服务进程」一键启动）');
say('  2) 重启 SillyTavern');
say('  3) 打开 扩展设置 -> S2 语音合成，填写服务地址并点「测试连接」');
say('  4) 选择音色（或上传参考音频 + 对应文本），然后点「试听」');
