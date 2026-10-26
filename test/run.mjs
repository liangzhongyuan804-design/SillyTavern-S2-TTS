/**
 * Standalone end-to-end test for the S2 TTS pieces.
 *
 *   node test/run.mjs
 *
 * Requires a local s2.cpp build. Paths below match this machine; override
 * with environment variables when running elsewhere.
 *
 *   S2TTS_EXE, S2TTS_MODEL, S2TTS_TOKENIZER, S2TTS_VOICE_DIR,
 *   S2TTS_DLL_DIR, S2TTS_REFERENCE
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { init, exit } from '../plugin/index.js';
import { sanitizeText, parseReadRange, extractReadRange, wrapReadRange } from '../sanitize.js';
import { runPlaybackTests } from './playback.mjs';
import { runVoiceTreeTests } from './voicetree.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// The persistent cache normally lives in the SillyTavern data directory.
// The test runs without SillyTavern, so it gets a scratch directory instead.
const CACHE_DIR = path.join(os.tmpdir(), 's2tts-cache-test');
process.env.S2TTS_CACHE_DIR = CACHE_DIR;
try {
    rmSync(CACHE_DIR, { recursive: true, force: true });
} catch {
    /* a leftover from an earlier run is fine */
}

const EXE = process.env.S2TTS_EXE ?? 'F:\\s2\\s2.cpp\\build\\Debug\\s2.exe';
const MODEL = process.env.S2TTS_MODEL ?? 'F:\\s2\\s2.cpp\\models\\s2-pro-q8_0.gguf';
const TOKENIZER = process.env.S2TTS_TOKENIZER ?? 'F:\\s2\\s2.cpp\\tokenizer.json';
const VOICE_DIR = process.env.S2TTS_VOICE_DIR ?? 'F:\\s2\\s2.cpp\\voices';
const DLL_DIR = process.env.S2TTS_DLL_DIR ?? 'F:\\s2\\bin\\x64';
const REFERENCE = process.env.S2TTS_REFERENCE ?? 'F:\\s2\\s2.cpp\\voices\\sao.wav';
const SHORT_REFERENCE = process.env.S2TTS_SHORT_REFERENCE ?? path.join(HERE, 'short-reference.wav');
const PORT = Number(process.env.S2TTS_PORT ?? 3030);
const S2_URL = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
    if (condition) {
        passed++;
        console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
    } else {
        failed++;
        console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    }
}

/* --------------------------------------------------- express test doubles */

const handlers = new Map();
const router = {
    post(route, handler) {
        handlers.set(`POST ${route}`, handler);
    },
    get(route, handler) {
        handlers.set(`GET ${route}`, handler);
    },
};

/**
 * A minimal stand-in for an Express response.
 *
 * @param {object} [options]
 * @param {boolean} [options.backpressure] Simulates a client that stopped
 *   reading: `write()` reports a full socket buffer and no "drain" event is
 *   ever emitted.
 */
function makeRes({ backpressure = false } = {}) {
    return {
        statusCode: 200,
        headers: {},
        body: null,
        finished: false,
        ended: false,
        headersSent: false,
        writableEnded: false,
        /** Chunks written by the streaming path, with their arrival time. */
        chunks: [],
        /** Registered event listeners, so the test can fire "close". */
        listeners: new Map(),
        setHeader(key, value) {
            this.headers[key] = value;
            return this;
        },
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.body = payload;
            this.finished = true;
            this.ended = true;
            this.writableEnded = true;
            return this;
        },
        send(payload) {
            if (Buffer.isBuffer(payload)) {
                this.write(payload);
            }
            this.body = payload;
            this.finished = true;
            this.ended = true;
            this.writableEnded = true;
            return this;
        },
        flushHeaders() {
            this.headersSent = true;
        },
        write(chunk) {
            this.chunks.push({ at: Date.now(), data: Buffer.from(chunk) });
            return !backpressure;
        },
        end(payload) {
            if (payload) {
                this.write(payload);
            }
            this.finished = true;
            this.ended = true;
            this.writableEnded = true;
            return this;
        },
        on(event, handler) {
            const list = this.listeners.get(event) ?? [];
            list.push(handler);
            this.listeners.set(event, list);
            return this;
        },
        once(event, handler) {
            return this.on(event, handler);
        },
        /** Simulates the browser navigating away in the middle of the stream. */
        emitClose() {
            for (const handler of this.listeners.get('close') ?? []) {
                handler();
            }
        },
    };
}

async function call(route, body) {
    const handler = handlers.get(route);
    if (!handler) {
        throw new Error(`No handler registered for ${route}`);
    }
    const res = makeRes();
    await handler({ body: body ?? {} }, res);
    return res;
}

/**
 * Calls the synthesis route and waits for s2.cpp to become available again.
 *
 * s2.cpp handles one synthesis at a time and answers 503 while another
 * request is still running. Two syntheses in a row therefore have to give
 * the engine a moment to release the previous one — otherwise the second
 * request tests the "busy" path instead of what it was written for.
 */
async function callGenerate(body, { attempts = 5 } = {}) {
    let res = await call('POST /generate', body);
    for (let i = 0; i < attempts && res.statusCode === 503; i++) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        res = await call('POST /generate', body);
    }
    return res;
}

/**
 * Finds any `.s2voice` profile below a directory.
 *
 * The tests copy a real profile into a directory with Chinese names, so
 * they need a profile to work with — the machine may not have one in the
 * top level of the voice directory.
 *
 * @param {string} dir
 * @returns {string|null}
 */
function findVoiceProfile(dir) {
    const stack = [dir];
    while (stack.length) {
        const current = stack.pop();
        let items;
        try {
            items = readdirSync(current, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const item of items) {
            const full = path.join(current, item.name);
            if (item.isDirectory()) {
                stack.push(full);
            } else if (item.isFile() && item.name.toLowerCase().endsWith('.s2voice')) {
                return full;
            }
        }
    }
    return null;
}

/* ------------------------------------------------------ sanitizeText tests */

console.log('\n[sanitizeText]');
{
    const cases = [
        {
            name: 'keeps plain text',
            input: '你好，今天天气不错。',
            expect: '你好，今天天气不错。',
        },
        {
            name: 'removes fenced code blocks',
            input: '看这个：\n```js\nconst a = 1;\n```\n结束',
            expect: '看这个： 结束',
        },
        {
            name: 'removes tagged blocks',
            input: 'Hello <thinking>secret</thinking> world',
            expect: 'Hello world',
        },
        {
            name: 'removes asterisk actions',
            input: '*waves hello* 你好',
            expect: '你好',
        },
        {
            name: 'removes markdown headings and bullets',
            input: '# Title\n- one\n- two',
            expect: 'Title one two',
        },
        {
            name: 'removes emoji',
            input: '你好 😀 世界',
            expect: '你好 世界',
        },
        {
            name: 'collapses whitespace',
            input: 'a\n\n  b\t\tc',
            expect: 'a b c',
        },
    ];

    for (const testCase of cases) {
        const actual = sanitizeText(testCase.input);
        check(testCase.name, actual === testCase.expect, actual === testCase.expect ? '' : `got "${actual}"`);
    }

    // Options must be respected.
    const kept = sanitizeText('*stays* <b>too</b>', {
        stripAsterisks: false,
        stripTags: false,
    });
    check('options disable stripping', kept === '*stays* <b>too</b>', `got "${kept}"`);

    const substituted = sanitizeText('hi {{user}}', { substitute: (t) => t.replace('{{user}}', 'Alice') });
    check('substitute hook is applied', substituted === 'hi Alice', `got "${substituted}"`);
}

/* --------------------------------------------------- reading range tests */

console.log('\n[reading range]');
{
    // The default means "read everything".
    check('the default reads everything', parseReadRange('朗读') === null);
    check('an empty value reads everything', parseReadRange('') === null);
    check('"全部" reads everything', parseReadRange('全部') === null);

    // The outer characters are the markers, the text in between is a label.
    const parsed = parseReadRange('【朗读内容】');
    check('the markers are the outer characters',
        parsed?.open === '【' && parsed?.close === '】',
        JSON.stringify(parsed));

    const plain = parseReadRange('【】');
    check('a plain pair works too', plain?.open === '【' && plain?.close === '】');

    const placeholder = parseReadRange('【{内容}】');
    check('a placeholder is honoured', placeholder?.open === '【' && placeholder?.close === '】');

    check('a word is not a range', parseReadRange('hello') === null);

    const ranged = extractReadRange('前面的旁白【要念的话】后面的旁白', '【朗读内容】');
    check('only the marked part is taken', ranged.text === '要念的话', `got "${ranged.text}"`);
    check('the range was found', ranged.found === true);

    const missing = extractReadRange('没有标记的普通回复', '【朗读内容】');
    check('a missing range keeps the text', missing.text === '没有标记的普通回复', `got "${missing.text}"`);
    check('a missing range is reported', missing.found === false);

    const several = extractReadRange('【第一段】中间【第二段】', '【朗读内容】');
    check('every marked section is taken', several.text === '第一段 第二段', `got "${several.text}"`);

    const open = extractReadRange('【没有收尾', '【朗读内容】');
    check('an unclosed range takes the rest', open.text === '没有收尾', `got "${open.text}"`);

    const same = extractReadRange('|要念的话|其它', '|');
    check('the same character can delimit the range', same.text === '要念的话', `got "${same.text}"`);
    check('a single punctuation mark can delimit', parseReadRange('|')?.open === '|');

    const off = extractReadRange('普通回复', '朗读');
    check('without a range nothing is cut', off.text === '普通回复' && off.found === false);

    check('the preview text is wrapped in the markers',
        wrapReadRange('试听', '【朗读内容】') === '【试听】',
        wrapReadRange('试听', '【朗读内容】'));
    check('the preview text is untouched without a range',
        wrapReadRange('试听', '朗读') === '试听');
}

/* ---------------------------------------------------- server plugin tests */

console.log('\n[server plugin]');
await init(router);
check('registers POST /status', handlers.has('POST /status'));
check('registers POST /generate', handlers.has('POST /generate'));
check('registers POST /voices', handlers.has('POST /voices'));
check('registers POST /start', handlers.has('POST /start'));
check('registers POST /stop', handlers.has('POST /stop'));
check('registers POST /logs', handlers.has('POST /logs'));

{
    const res = await call('POST /status', { s2Url: 'not-a-url' });
    check('rejects an invalid server URL', res.statusCode === 400, `status ${res.statusCode}`);
}

// Start s2.cpp through the plugin's own /start route.
{
    const res = await call('POST /start', {
        exe: EXE,
        model: MODEL,
        tokenizer: TOKENIZER,
        voiceDir: VOICE_DIR,
        dllDir: DLL_DIR,
        host: '127.0.0.1',
        port: PORT,
        cudaDevice: 0,
        gpuLayers: -1,
        codecBackend: 'auto',
    });
    check('starts the s2.cpp server', res.statusCode === 200 && res.body.ok, JSON.stringify(res.body).slice(0, 300));
}

// Wait for the port to accept connections.
{
    let up = false;
    for (let i = 0; i < 120; i++) {
        const res = await call('POST /status', { s2Url: S2_URL });
        if (res.body.reachable && res.body.isS2) {
            up = true;
            console.log(`  (server ready after ${i}s)`);
            break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    check('s2.cpp answers /status as reachable + isS2', up);
}

{
    const res = await call('POST /status', { s2Url: S2_URL });
    check('status reports a healthy server', res.body.reachable === true && res.body.isS2 === true, res.body.detail);
}

{
    const res = await call('POST /voices', { voiceDir: VOICE_DIR });
    check('lists voices from the voice directory', res.statusCode === 200 && Array.isArray(res.body.voices), JSON.stringify(res.body));
}

{
    const res = await call('POST /voices', { voiceDir: 'C:\\definitely\\not\\here' });
    check('missing voice directory returns an empty list', res.statusCode === 200 && res.body.voices.length === 0);
}

// The voice directory may be arranged as a three-level classification
// (voices/女/妩媚/生气.s2voice). The route has to report the whole tree,
// because the tag block of a reply is matched against the folder names.
{
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), 's2tts-tree-'));
    try {
        const layout = [
            path.join('女', '妩媚', '生气.s2voice'),
            path.join('女', '高冷', '默认.s2voice'),
            path.join('男', '阳光', '默认.s2voice'),
        ];
        for (const rel of layout) {
            const full = path.join(tempRoot, rel);
            mkdirSync(path.dirname(full), { recursive: true });
            writeFileSync(full, 'profile');
        }
        const res = await call('POST /voices', { voiceDir: tempRoot });
        check('the voice tree is reported', res.statusCode === 200 && Array.isArray(res.body.entries), JSON.stringify(res.body).slice(0, 200));
        check('every classified profile is listed', res.body.entries.length === layout.length, `${res.body.entries.length}`);
        check('the gender is read from the folder',
            res.body.entries.find((entry) => entry.stem === '生气')?.gender === '女');
        check('the personality is read from the folder',
            res.body.entries.find((entry) => entry.stem === '生气')?.personality === '妩媚');
        check('the tone is read from the file name',
            res.body.entries.find((entry) => entry.stem === '生气')?.tone === '生气');
        check('the tag names are reported',
            res.body.names.gender.includes('女') && res.body.names.personality.includes('妩媚'),
            JSON.stringify(res.body.names));
    } finally {
        rmSync(tempRoot, { recursive: true, force: true });
    }
}

// A voice behind Chinese folder names cannot be opened by s2.cpp directly:
// it builds its file paths from narrow strings and Windows converts them with
// the ANSI code page (GB2312 on a Chinese system), so a UTF-8 path never
// reaches the file. The plugin copies such profiles into an ASCII-only
// directory first — this round trip proves that it works.
{
    const sample = findVoiceProfile(VOICE_DIR);
    if (!sample) {
        console.log('  (skipped: no .s2voice profile found in the voice directory)');
    } else {
        const tempRoot = mkdtempSync(path.join(os.tmpdir(), 's2tts-voice-'));
        try {
            const chineseDir = path.join(tempRoot, '女', '妩媚');
            mkdirSync(chineseDir, { recursive: true });
            const chineseVoice = path.join(chineseDir, '生气.s2voice');
            copyFileSync(sample, chineseVoice);

            const res = await callGenerate({
                s2Url: S2_URL,
                text: '中文路径音色的测试。',
                voice: chineseVoice,
                params: {
                    stream: true,
                    segment_sentences: true,
                    max_new_tokens: 2048,
                },
            });
            check('a voice behind chinese folder names is synthesized',
                res.statusCode === 200,
                `status ${res.statusCode} body ${String(res.body).slice(0, 200)}`);
            const buffer = Buffer.isBuffer(res.body) ? res.body : Buffer.alloc(0);
            check('the staged voice returns real audio',
                buffer.length > 1000 && buffer.toString('ascii', 0, 4) === 'RIFF',
                `${buffer.length} bytes`);
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    }
}

{
    const res = await call('POST /generate', { s2Url: S2_URL, text: '' });
    check('rejects empty text', res.statusCode === 400);
}

// A plain recording in the voice directory is a voice as well.
//
// s2.cpp cannot load a .wav as a voice profile — it only knows the .s2voice
// container. What it can do is clone a voice from a reference recording, and
// that is the channel the plugin uses for a .wav: the bytes are read on the
// server and uploaded as the reference, together with the transcript that
// lives in the text file next to the recording.
{
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), 's2tts-audio-'));
    try {
        const folder = path.join(tempRoot, '女', '活泼');
        mkdirSync(folder, { recursive: true });
        const recording = path.join(folder, '录音.wav');
        copyFileSync(SHORT_REFERENCE, recording);
        writeFileSync(path.join(folder, '录音.txt'), '你好，这是一段用于测试的参考音频。', 'utf8');
        const lonely = path.join(folder, '待补.wav');
        copyFileSync(SHORT_REFERENCE, lonely);

        const listed = await call('POST /voices', { voiceDir: tempRoot });
        const entry = listed.body.entries?.find((item) => item.name === '录音.wav');
        check('a recording is listed as a voice', entry?.kind === 'audio', JSON.stringify(entry));
        check('the recording carries its transcript', entry?.transcript === '你好，这是一段用于测试的参考音频。', entry?.transcript);
        check('the recording is classified like a profile',
            entry?.gender === '女' && entry?.personality === '活泼' && entry?.tone === '录音',
            `${entry?.gender}/${entry?.personality}/${entry?.tone}`);
        check('the recording can be picked as the default voice',
            listed.body.voiceOptions?.some((option) => option.value === recording),
            JSON.stringify(listed.body.voiceOptions));

        // Without the transcript s2.cpp refuses to synthesize, so the request
        // has to be stopped before it reaches the engine.
        const missing = await call('POST /generate', {
            s2Url: S2_URL,
            text: '这条录音还没有转录。',
            voice: lonely,
        });
        check('a recording without a transcript is rejected',
            missing.statusCode === 400 && /转录/.test(String(missing.body?.error ?? '')),
            `status ${missing.statusCode} ${String(missing.body?.error ?? '').slice(0, 160)}`);

        // With the transcript the recording is cloned and real audio comes back.
        const res = await callGenerate({
            s2Url: S2_URL,
            text: '这一句是用录音音色念出来的。',
            voice: recording,
            params: {
                stream: true,
                segment_sentences: true,
                max_new_tokens: 2048,
            },
        });
        check('a recording is synthesized', res.statusCode === 200,
            `status ${res.statusCode} body ${String(res.body).slice(0, 200)}`);
        const buffer = Buffer.isBuffer(res.body) ? res.body : Buffer.alloc(0);
        check('the recording returns real audio',
            buffer.length > 1000 && buffer.toString('ascii', 0, 4) === 'RIFF',
            `${buffer.length} bytes`);
        check('the recording was cloned, not replaced by the default voice',
            res.headers['x-s2-encode-failures'] === undefined,
            `encode failures: ${res.headers['x-s2-encode-failures']}`);

        // The panel writes the transcript next to the recording.
        const written = await call('POST /voices/transcript', {
            voicePath: lonely,
            text: '这是刚补上的转录。',
        });
        check('the transcript is written next to the recording',
            written.statusCode === 200 && existsSync(path.join(folder, '待补.txt')),
            JSON.stringify(written.body));
        const relisted = await call('POST /voices', { voiceDir: tempRoot });
        check('the written transcript is reported back',
            relisted.body.entries?.find((item) => item.name === '待补.wav')?.transcript === '这是刚补上的转录。');
    } finally {
        rmSync(tempRoot, { recursive: true, force: true });
    }
}

// Creating a .s2voice profile from a recording.
//
// s2.cpp can only store a profile from the command line (`--save-voice`), so
// the plugin spawns `s2.exe` for it. The browser cuts the reference down to
// the part that is used and sends it as base64 WAV.
{
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), 's2tts-profile-'));
    try {
        const folder = path.join(tempRoot, '女', '活泼');
        mkdirSync(folder, { recursive: true });
        const recording = path.join(folder, '录音.wav');
        copyFileSync(SHORT_REFERENCE, recording);

        // The browser needs the raw audio to draw the waveform.
        const audio = await call('POST /voices/audio', { voiceDir: tempRoot, voicePath: recording });
        check('the recording is served as audio',
            audio.statusCode === 200 && Buffer.isBuffer(audio.body),
            `status ${audio.statusCode}`);
        check('the served bytes are the real recording',
            Buffer.isBuffer(audio.body) && audio.body.toString('ascii', 0, 4) === 'RIFF',
            `${audio.body?.length ?? 0} bytes`);
        check('the content type is audio/wav', audio.headers['Content-Type'] === 'audio/wav');

        // The route must not become a way to read arbitrary files.
        const outside = await call('POST /voices/audio', { voiceDir: folder, voicePath: SHORT_REFERENCE });
        check('a file outside the voice directory is refused', outside.statusCode === 400,
            `status ${outside.statusCode}`);

        const profileBody = {
            transcript: 'A short sample of the reference voice.',
            targetId: '档案',
            targetDir: folder,
            audioBase64: readFileSync(SHORT_REFERENCE).toString('base64'),
            exe: EXE,
            model: MODEL,
            tokenizer: TOKENIZER,
            dllDir: DLL_DIR,
            cudaDevice: 0,
        };

        // s2.cpp refuses to store a profile without the transcript.
        const noTranscript = await call('POST /voices/profile', { ...profileBody, transcript: '' });
        check('a profile without a transcript is refused', noTranscript.statusCode === 400,
            `status ${noTranscript.statusCode}`);

        // The id becomes a file name, so it must not carry a path.
        const badId = await call('POST /voices/profile', { ...profileBody, targetId: '../evil' });
        check('a profile id with a path separator is refused', badId.statusCode === 400,
            `status ${badId.statusCode}`);

        // The engine has to be there.
        const noEngine = await call('POST /voices/profile', { ...profileBody, exe: 'F:/nope/s2.exe' });
        check('a profile without an engine is refused', noEngine.statusCode === 400,
            `status ${noEngine.statusCode}`);

        // Garbage instead of a WAV.
        const notWav = await call('POST /voices/profile', { ...profileBody, audioBase64: 'bm90IGEgd2F2' });
        check('something that is not a wav is refused', notWav.statusCode === 400,
            `status ${notWav.statusCode}`);

        const unknown = await call('POST /voices/profile/status', { jobId: 'does-not-exist' });
        check('an unknown job is reported', unknown.statusCode === 404, `status ${unknown.statusCode}`);

        // The real thing: s2.exe is started, the reference is encoded and the
        // profile lands in the voice directory.
        const started = await call('POST /voices/profile', profileBody);
        check('the profile job starts', started.statusCode === 200 && Boolean(started.body?.jobId),
            JSON.stringify(started.body));

        let job = null;
        for (let attempt = 0; attempt < 180; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            job = await call('POST /voices/profile/status', { jobId: started.body?.jobId });
            if (job.body?.state && job.body.state !== 'running') {
                break;
            }
        }
        check('the profile job finishes', job?.body?.state === 'done',
            `state ${job?.body?.state} ${job?.body?.message ?? ''}`);
        check('the job reports where the profile is',
            job?.body?.result?.path === path.join(folder, '档案.s2voice'),
            job?.body?.result?.path);

        const profilePath = path.join(folder, '档案.s2voice');
        check('the profile file was written', existsSync(profilePath));
        // The magic of a profile is "S2VOICE" plus a terminating zero byte.
        const magic = Buffer.from([0x53, 0x32, 0x56, 0x4f, 0x49, 0x43, 0x45, 0x00]);
        const head = existsSync(profilePath) ? readFileSync(profilePath).subarray(0, 8) : Buffer.alloc(0);
        check('the profile has the s2voice magic', head.equals(magic), JSON.stringify(head.toString('latin1')));

        // The new profile is a normal voice: it can be used for a synthesis.
        const used = await callGenerate({
            s2Url: S2_URL,
            text: '这一句用的是刚刚生成的档案。',
            voice: profilePath,
        });
        check('the new profile synthesizes', used.statusCode === 200,
            `status ${used.statusCode} body ${String(used.body).slice(0, 120)}`);
        const usedBuffer = Buffer.isBuffer(used.body) ? used.body : Buffer.alloc(0);
        check('the new profile returns real audio',
            usedBuffer.length > 1000 && usedBuffer.toString('ascii', 0, 4) === 'RIFF',
            `${usedBuffer.length} bytes`);
    } finally {
        rmSync(tempRoot, { recursive: true, force: true });
    }
}

// The real synthesis round trip, using the reference-audio (voice clone) path.
//
// REFERENCE is the machine's original clip: 673 seconds of MP3. That is far
// too long for the codec encoder — it tries to allocate a graph buffer sized
// by the audio length and dies with a CUDA out-of-memory, which s2.cpp reports
// as "encode failed, running without reference audio" while still answering
// 200 with un-cloned audio.
//
// SHORT_REFERENCE is the same speaker trimmed to ~8 seconds, which encodes
// fine. Both cases are exercised so the fallback is provably detected.
{
    const referenceBase64 = readFileSync(REFERENCE).toString('base64');
    const res = await call('POST /generate', {
        s2Url: S2_URL,
        text: '你好，这是酒馆语音合成的测试。',
        referenceBase64,
        referenceFilename: path.basename(REFERENCE),
        referenceText: '参考音频的对应文本',
        params: {
            stream: true,
            segment_sentences: true,
            sentence_pause_ms: 250,
            max_new_tokens: 2048,
            temperature: 0.58,
            top_p: 0.88,
            top_k: 40,
        },
    });

    check('generate returns HTTP 200', res.statusCode === 200, `status ${res.statusCode} body ${String(res.body).slice(0, 300)}`);
    check('generate sets audio/wav', res.headers['Content-Type'] === 'audio/wav', res.headers['Content-Type']);

    const buffer = Buffer.isBuffer(res.body)
        ? res.body
        : (typeof res.body === 'string' ? Buffer.from(res.body) : Buffer.alloc(0));
    check('generate returns a non-empty buffer', buffer.length > 1000, `${buffer.length} bytes`);

    if (buffer.length > 44) {
        check('buffer is a RIFF/WAVE file',
            buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WAVE');
        const formatTag = buffer.readUInt16LE(20);
        const channels = buffer.readUInt16LE(22);
        const rate = buffer.readUInt32LE(24);
        const bits = buffer.readUInt16LE(34);
        // s2.cpp writes 16-bit PCM on the streaming path and IEEE float 32-bit
        // on the buffered path. Browsers decode both.
        const known = (formatTag === 1 && bits === 16) || (formatTag === 3 && bits === 32);
        check('WAV uses a format browsers can decode', known, `fmt=${formatTag} bits=${bits}`);
        check('WAV has sane channel count and rate', channels >= 1 && rate > 0, `ch=${channels} rate=${rate}`);

        // The browser decodes this with decodeAudioData; make sure the payload
        // is not silence.
        const bytesPerSample = bits / 8;
        const samples = Math.floor((buffer.length - 44) / bytesPerSample);
        let peak = 0;
        for (let i = 0; i < samples; i++) {
            let value;
            if (formatTag === 3) {
                value = buffer.readFloatLE(44 + i * 4);
            } else if (bits === 16) {
                value = buffer.readInt16LE(44 + i * 2) / 32768;
            } else {
                value = buffer.readInt32LE(44 + i * 4) / 2147483648;
            }
            peak = Math.max(peak, Math.abs(value));
        }
        check('WAV contains actual audio (not silence)', peak > 0.01, `peak=${peak.toFixed(4)}`);
        check('WAV has a plausible duration', samples / channels / rate > 0.2,
            `${(samples / channels / rate).toFixed(2)}s`);

        const outPath = path.join(HERE, 'generated-sample.wav');
        const { writeFileSync } = await import('node:fs');
        writeFileSync(outPath, buffer);
        console.log(`  -> sample written to ${outPath}`);
    }

    // The over-long clip must be reported, not silently swallowed.
    check('over-long reference is flagged with X-S2-Encode-Failures',
        Number(res.headers['X-S2-Encode-Failures'] ?? 0) > 0,
        `header=${res.headers['X-S2-Encode-Failures']}`);
}

// A short reference clip encodes cleanly, so no fallback is reported.
{
    const shortBase64 = readFileSync(SHORT_REFERENCE).toString('base64');
    const res = await call('POST /generate', {
        s2Url: S2_URL,
        text: '短参考音频的克隆测试。',
        referenceBase64: shortBase64,
        referenceFilename: path.basename(SHORT_REFERENCE),
        referenceText: '一段短的参考音频转录。',
        params: {
            stream: true,
            segment_sentences: true,
            max_new_tokens: 2048,
        },
    });

    check('short reference returns HTTP 200', res.statusCode === 200, `status ${res.statusCode}`);
    check('short reference encodes without falling back',
        !res.headers['X-S2-Encode-Failures'],
        `header=${res.headers['X-S2-Encode-Failures']}`);
}

// The engine log has to be readable through the plugin, otherwise the
// "encode failed" warning is invisible to the user.
{
    const res = await call('POST /logs', { limit: 200 });
    check('/logs returns the running server', res.statusCode === 200 && res.body.running === true, JSON.stringify(res.body).slice(0, 200));
    check('/logs returns an array of lines', Array.isArray(res.body.lines));
    check('/logs counts the encode failures', res.body.encodeFailures > 0, `encodeFailures=${res.body.encodeFailures}`);
    check('/logs surfaces the s2.cpp warning',
        [...res.body.lines, ...(res.body.warnings ?? [])].some((line) => /encode failed/i.test(line)),
        (res.body.warnings ?? []).filter((line) => /encode failed/i.test(line)).join(' | ').slice(0, 200));
}

/* ------------------------------------------------------- streaming replies */

// Streaming mode asks s2.cpp for a chunked PCM stream and relays it without
// buffering. The point of the feature is that the first audio arrives long
// before the synthesis is finished, so the test watches the arrival times of
// the individual chunks.
{
    const startedAt = Date.now();
    const res = await call('POST /generate', {
        s2Url: S2_URL,
        text: '这是一段用来验证流式播放的测试语音。',
        relay: 'stream',
        params: {
            stream: true,
            chunked: true,
            output_format: 'pcm_s16le',
            stream_start_buffer_ms: 200,
            // The decisive knob. With the default holdback s2.cpp keeps the
            // trailing codec frames buffered until they are stable, so the
            // whole answer is produced before the first byte is sent and the
            // response looks buffered no matter how it is transported.
            stream_holdback_frames: 0,
            segment_sentences: false,
            max_new_tokens: 2048,
            temperature: 0.58,
            top_p: 0.88,
            top_k: 40,
        },
    });

    check('streamed generate returns HTTP 200', res.statusCode === 200, `status ${res.statusCode}`);

    // The plugin deliberately waits for the first chunk before it writes the
    // response headers, so that the encode-failure counter is already final.
    // The headers therefore only exist once the relay has finished.
    for (let i = 0; i < 900 && !res.ended; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    check('streamed response completes', res.ended);

    const contentType = res.headers['Content-Type'] ?? '';
    check('streamed response is raw PCM', /audio\/L16/i.test(contentType), contentType);
    check('streamed response advertises the sample rate', !!res.headers['X-Audio-Sample-Rate'], res.headers['X-Audio-Sample-Rate']);
    check('streamed response advertises the encoding',
        (res.headers['X-Audio-Encoding'] ?? '').toLowerCase() === 'pcm_s16le',
        res.headers['X-Audio-Encoding']);
    check('streamed response disables proxy buffering',
        (res.headers['Cache-Control'] ?? '').includes('no-transform'),
        res.headers['Cache-Control']);

    const chunks = res.chunks ?? [];
    check('streamed response arrives in several chunks', chunks.length > 1, `${chunks.length} chunks`);

    const total = chunks.reduce((sum, chunk) => sum + chunk.data.length, 0);
    check('streamed body is a whole number of samples', total % 2 === 0, `${total} bytes`);
    check('streamed body has a plausible size', total > 2000, `${total} bytes`);

    if (chunks.length > 1) {
        const first = chunks[0].at;
        const last = chunks[chunks.length - 1].at;
        const spread = last - first;
        const firstLatency = first - startedAt;
        const totalTime = last - startedAt;
        console.log(`  (first chunk after ${firstLatency} ms, whole stream took ${totalTime} ms, ${chunks.length} chunks)`);

        // The point of the feature: the first audio must show up long before
        // the synthesis is finished.
        check('first chunk arrives long before the last one', spread > 500, `${spread} ms apart`);
        check('first chunk arrives while the synthesis is still running',
            firstLatency < totalTime * 0.75,
            `first ${firstLatency} ms vs total ${totalTime} ms`);
    }

    // Decode the PCM and make sure it is actual audio.
    const sampleRate = Number(res.headers['X-Audio-Sample-Rate']) || 44100;
    const pcm = Buffer.concat(chunks.map((chunk) => chunk.data));
    const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength >> 1);
    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
        peak = Math.max(peak, Math.abs(samples[i] / 32768));
    }
    const seconds = samples.length / sampleRate;
    check('streamed PCM contains actual audio', peak > 0.01, `peak=${peak.toFixed(4)}`);
    check('streamed PCM has a plausible duration', seconds > 0.2 && seconds < 120, `${seconds.toFixed(2)}s`);
}

// The persistent cache has to turn a repeated request into an instant answer.
//
// The first request synthesizes and stores the audio; the second one with
// identical parameters must come straight from disk — no second synthesis,
// no second GPU second.
const cacheParams = {
    stream: true,
    chunked: true,
    output_format: 'pcm_s16le',
    stream_start_buffer_ms: 200,
    stream_holdback_frames: 0,
    segment_sentences: false,
    max_new_tokens: 1024,
};
const cacheText = '持久化缓存的重复请求测试。';

{
    // Other requests in this suite also fill the cache, so the count is
    // compared against the value from before this request.
    const entriesBefore = (await call('POST /cache/stats', {})).body.entries ?? 0;

    const first = await callGenerate({
        s2Url: S2_URL,
        text: cacheText,
        relay: 'stream',
        params: cacheParams,
        cacheEnabled: true,
    });
    check('the first cached request is a miss', first.headers['X-S2-Cache'] === 'miss', first.headers['X-S2-Cache']);

    const firstBytes = (first.chunks ?? []).reduce((sum, chunk) => sum + chunk.data.length, 0);
    check('the first request produced audio', firstBytes > 2000, `${firstBytes} bytes`);

    const stats = await call('POST /cache/stats', {});
    check('the cache gained exactly one entry', stats.body.entries === entriesBefore + 1, `${entriesBefore} -> ${stats.body.entries}`);
    check('the cache reports a size', stats.body.bytes > 2000, `${stats.body.bytes} bytes`);
    check('the cache lives in a real directory', typeof stats.body.dir === 'string' && stats.body.dir.length > 0, stats.body.dir);

    // The second request must not touch s2.cpp at all.
    const startedAt = Date.now();
    const second = await callGenerate({
        s2Url: S2_URL,
        text: cacheText,
        relay: 'stream',
        params: cacheParams,
        cacheEnabled: true,
    });
    const elapsed = Date.now() - startedAt;

    check('the repeated request is served from the cache', second.headers['X-S2-Cache'] === 'hit', second.headers['X-S2-Cache']);
    check('the cached response is raw PCM', /audio\/L16/i.test(second.headers['Content-Type'] ?? ''), second.headers['Content-Type']);
    const secondBytes = (second.chunks ?? []).reduce((sum, chunk) => sum + chunk.data.length, 0);
    check('the cached audio is byte-identical', secondBytes === firstBytes, `${secondBytes} vs ${firstBytes} bytes`);
    check('the cached answer arrives without a synthesis', elapsed < 3000, `${elapsed} ms`);

    // A different text must not hit the cache.
    const other = await callGenerate({
        s2Url: S2_URL,
        text: `${cacheText}换个内容`,
        relay: 'stream',
        params: cacheParams,
        cacheEnabled: true,
    });
    check('a different text misses the cache', other.headers['X-S2-Cache'] === 'miss', other.headers['X-S2-Cache']);

    // "Force" means "synthesize again", so the cache must be bypassed.
    const forced = await callGenerate({
        s2Url: S2_URL,
        text: cacheText,
        relay: 'stream',
        params: cacheParams,
        cacheEnabled: true,
        bypassCache: true,
    });
    check('bypassCache forces a fresh synthesis', forced.headers['X-S2-Cache'] === 'miss', forced.headers['X-S2-Cache']);

    // Turning the cache off must bypass it as well.
    const disabled = await callGenerate({
        s2Url: S2_URL,
        text: cacheText,
        relay: 'stream',
        params: cacheParams,
        cacheEnabled: false,
    });
    check('a disabled cache is bypassed', disabled.headers['X-S2-Cache'] === 'miss',
        `header=${disabled.headers['X-S2-Cache']} status=${disabled.statusCode} body=${String(disabled.body).slice(0, 120)}`);

    const list = await call('POST /cache/list', {});
    check('the cache list returns entries', Array.isArray(list.body.entries) && list.body.entries.length >= 1, `${list.body.entries?.length}`);
    check('the cache list carries the text preview',
        list.body.entries.some((entry) => String(entry.text ?? '').includes('持久化缓存')),
        list.body.entries?.[0]?.text);

    const cleared = await call('POST /cache/clear', {});
    check('the cache can be cleared', cleared.body.ok === true && cleared.body.removed >= 1, JSON.stringify(cleared.body));

    const afterClear = await call('POST /cache/stats', {});
    check('the cache is empty afterwards', afterClear.body.entries === 0, JSON.stringify(afterClear.body));

    const afterClearRequest = await callGenerate({
        s2Url: S2_URL,
        text: cacheText,
        relay: 'stream',
        params: cacheParams,
        cacheEnabled: true,
    });
    check('a cleared cache misses again', afterClearRequest.headers['X-S2-Cache'] === 'miss', afterClearRequest.headers['X-S2-Cache']);
}

// The buffered path has to keep working unchanged.
{
    const res = await call('POST /generate', {
        s2Url: S2_URL,
        text: '缓冲模式的回归测试。',
        relay: 'buffer',
        params: {
            stream: true,
            segment_sentences: true,
            max_new_tokens: 1024,
        },
    });

    check('buffered generate returns HTTP 200', res.statusCode === 200, `status ${res.statusCode}`);
    check('buffered response is a WAV file', (res.headers['Content-Type'] ?? '').includes('audio/wav'), res.headers['Content-Type']);
    const buffer = Buffer.isBuffer(res.body) ? res.body : Buffer.alloc(0);
    check('buffered response is a RIFF/WAVE file',
        buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WAVE');
}

// A client that disappears in the middle of the stream must not leave the
// relay hanging. The dangerous case is a full socket buffer: `write()` reports
// back-pressure and the matching "drain" event never arrives, so a relay
// that only waits for "drain" would wait forever — holding the upstream
// synthesis and the GPU with it.
{
    const res = makeRes({ backpressure: true });
    const handler = handlers.get('POST /generate');
    const pending = handler({
        body: {
            s2Url: S2_URL,
            text: '客户端中途离开的测试。',
            relay: 'stream',
            params: {
                stream: true,
                chunked: true,
                output_format: 'pcm_s16le',
                stream_start_buffer_ms: 200,
                stream_holdback_frames: 0,
                segment_sentences: false,
                max_new_tokens: 2048,
            },
        },
    }, res);

    // Wait for the first chunk, i.e. for the relay to be up and running.
    let waited = 0;
    while (res.chunks.length === 0 && waited < 600) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        waited++;
    }
    check('the relay started forwarding before the client left', res.chunks.length > 0, `${res.chunks.length} chunks`);

    const before = res.chunks.length;
    res.emitClose();

    // The relay has to unwind. If it waited for a "drain" that can never
    // come, this promise would still be pending after the timeout.
    const settled = await Promise.race([
        pending.then(() => true, () => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 8000)),
    ]);
    check('the relay unwinds after the client disappeared', settled);

    await new Promise((resolve) => setTimeout(resolve, 1500));
    check('no further audio is forwarded to a gone client',
        res.chunks.length === before, `${before} -> ${res.chunks.length} chunks`);
}

/* ------------------------------------------- read-aloud queue / player (A3) */

await runPlaybackTests(check);

/* ---------------------------------- tag driven voice selection (v1.4.0) */

await runVoiceTreeTests(check);

{
    const res = await call('POST /stop', {});
    check('stops the server', res.statusCode === 200 && res.body.ok, JSON.stringify(res.body));
}

await exit();

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
