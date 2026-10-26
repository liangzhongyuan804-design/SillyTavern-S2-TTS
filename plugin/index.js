/**
 * st-s2-tts — SillyTavern server plugin.
 *
 * Bridges the browser extension to a local s2.cpp HTTP server
 * (Fish Audio S2-Pro GGUF, https://github.com/rodrigomatta/s2.cpp).
 *
 * Why a server plugin at all? s2.cpp is a plain httplib server that sends no
 * CORS headers, so the browser cannot call it directly from the SillyTavern
 * page. Proxying through the ST server keeps everything same-origin and also
 * gives the extension a place to spawn/stop the s2.cpp process.
 *
 * The plugin is deliberately stateless: every request carries the settings it
 * needs, so the user keeps full control from the extension's settings panel.
 *
 * Requires SillyTavern >= 1.19 (server plugins) and Node >= 20.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import {
    AudioCache,
    CacheWriter,
    DEFAULT_MAX_BYTES,
    buildWavHeader,
    computeCacheKey,
    parseWav,
    resolveCacheDir,
} from './cache.js';
import {
    isAsciiPath,
    isAudioPath,
    pickStagingDir,
    readTranscript,
    resolveVoiceFile,
    scanVoiceTree,
    stageVoiceFile,
    writeTranscript,
} from './voices.js';
import {
    PROFILE_EXTENSION,
    cleanupWorkDir,
    isValidVoiceId,
    runProfileSave,
    sanitizeVoiceId,
    writeReferenceFile,
} from './profile.js';

export const info = {
    id: 'st-s2-tts',
    name: 'S2 TTS Bridge',
    description: 'Bridges SillyTavern to a local s2.cpp (Fish Audio S2-Pro GGUF) speech server.',
};

/** Wall-clock budget for a single synthesis request. */
const GENERATE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * How long to wait before each retry when s2.cpp answers 503.
 *
 * s2.cpp handles one synthesis at a time and turns away everything that
 * arrives while another request is running. Its busy flag is released a
 * moment after the HTTP response ended, so a request that follows right
 * after another one can be turned away even though the engine is about to
 * be free again — measured on this machine: the very next request was
 * refused, the one after that was accepted.
 *
 * The waiting happens here, on the server, so the browser never has to deal
 * with it: the user just notices that the audio starts a moment later.
 */
const BUSY_RETRY_DELAYS_MS = [500, 1000, 2000, 3000, 5000, 8000, 12000];

/** Child process started by this plugin, if any. */
let child = null;

/**
 * Captured stdout/stderr of the s2.cpp child process.
 *
 * s2.cpp reports every problem on stderr, and several of them are silent
 * degradations: "encode failed, running without reference audio" means the
 * requested voice clone was quietly dropped and the engine fell back to a
 * generic voice. The extension needs this to tell the user what happened,
 * so the tail is exposed through the /logs route.
 */
const s2Logs = [];

/** Keep the log buffer bounded; 800 lines is plenty for one session. */
const MAX_LOG_LINES = 800;

/**
 * ggml reallocation chatter.
 *
 * The CUDA backend prints several of these per graph build, which floods the
 * buffer and pushes the interesting lines out of view. The allocator message
 * that reports the actual out-of-memory is kept.
 */
const LOG_NOISE = [
    /^ggml_gallocr_/i,
    /^ggml_backend_sched_alloc_splits/i,
];

/** How many times s2.cpp reported a failed reference-audio encode. */
let encodeFailureCount = 0;

/**
 * Lines that look like a problem.
 *
 * Kept separately from the rolling log so a warning is never lost when the
 * buffer scrolls — the encode-failure fallback is the one thing the user
 * really needs to see.
 */
const s2Warnings = [];

/**
 * Running and finished "create a .s2voice profile" jobs.
 *
 * The job takes several seconds — s2.cpp has to load the model before it can
 * encode the reference — so the request that starts it answers right away and
 * the browser polls the status route for the progress.
 */
const profileJobs = new Map();

/** Counter for the job ids; they only have to be unique inside one session. */
let profileJobSeq = 0;

/** How many finished jobs are kept around for the status route. */
const MAX_PROFILE_JOBS = 20;

/** Appends one or more output lines to the shared log buffer. */
function appendLogs(chunk) {
    const text = String(chunk ?? '');
    for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) {
            continue;
        }
        // Count first: even a filtered line must still be able to raise the
        // encode-failure counter.
        if (/encode failed/i.test(trimmed)) {
            encodeFailureCount += 1;
        }
        if (LOG_NOISE.some((pattern) => pattern.test(trimmed))) {
            continue;
        }
        if (/\b(error|failed|warning|out of memory)\b/i.test(trimmed)) {
            s2Warnings.push(trimmed);
            while (s2Warnings.length > 50) {
                s2Warnings.shift();
            }
        }
        s2Logs.push(trimmed);
    }
    while (s2Logs.length > MAX_LOG_LINES) {
        s2Logs.shift();
    }
}

/* ------------------------------------------------------------------ helpers */

/**
 * Picks the directory that holds the ASCII copies of the voice profiles.
 *
 * s2.cpp builds its file paths from narrow strings and Windows converts them
 * with the ANSI code page, so a profile behind a Chinese folder name cannot
 * be opened. The profiles are therefore copied into an ASCII-only directory
 * and s2.cpp gets that path.
 *
 * @param {object} req Express request.
 * @returns {string|null} The staging directory, or null when there is none.
 */
function stagingDirFor(req) {
    const candidates = [];
    const cacheDir = resolveCacheDir(req);
    if (cacheDir) {
        candidates.push(path.join(cacheDir, 'voices'));
    }
    candidates.push(path.join(os.tmpdir(), 's2tts-voices'));
    return pickStagingDir(candidates);
}

function asUrl(value) {
    const raw = String(value ?? '').trim();
    if (!raw) {
        return null;
    }
    try {
        const url = new URL(raw);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            return null;
        }
        url.search = '';
        url.hash = '';
        return url;
    } catch {
        return null;
    }
}

/**
 * Builds an endpoint URL from a base URL.
 *
 * `new URL('http://127.0.0.1:3030').pathname` is '/', so a naive
 * `${base}/generate` would produce '//generate' — which httplib does not
 * match, and the server answers 404.
 */
function endpoint(base, path) {
    const url = new URL(base.toString());
    url.pathname = `${url.pathname.replace(/\/+$/, '')}${path}`;
    return url;
}

function fail(res, status, message) {
    return res.status(status).json({ ok: false, error: String(message ?? 'Unknown error') });
}

/** Raw TCP probe. Resolves true when something is accepting connections. */
function probeTcp(host, port, timeout = 1500) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        let settled = false;
        const finish = (value) => {
            if (settled) {
                return;
            }
            settled = true;
            socket.destroy();
            resolve(value);
        };
        socket.setTimeout(timeout);
        socket.once('connect', () => finish(true));
        socket.once('timeout', () => finish(false));
        socket.once('error', () => finish(false));
        socket.connect(port, host);
    });
}

/**
 * Confirms the listening service really is s2.cpp.
 *
 * s2.cpp sets an "X-Request-Start" header on every response (its
 * pre-routing handler), which is a reliable fingerprint. As a secondary
 * signal, an empty multipart POST on /generate is rejected with
 * 400 {"error":"No text field in multipart form"}.
 */
async function probeS2(baseUrl) {
    const url = endpoint(baseUrl, '/generate');
    try {
        const response = await fetch(url, {
            method: 'POST',
            body: new FormData(),
            signal: AbortSignal.timeout(5000),
        });
        const text = await response.text();
        const hasFingerprint = response.headers.has('x-request-start');
        const hasKnownError = response.status === 400 && /No text field/i.test(text);
        const isS2 = hasFingerprint || hasKnownError;
        return {
            reachable: true,
            isS2,
            status: response.status,
            detail: isS2 ? 's2.cpp' : `unexpected response (${response.status})`,
        };
    } catch (error) {
        return { reachable: false, isS2: false, status: 0, detail: error?.message ?? 'unreachable' };
    }
}

function guessMime(filename) {
    const ext = path.extname(String(filename ?? '')).toLowerCase();
    return {
        '.wav': 'audio/wav',
        '.mp3': 'audio/mpeg',
        '.flac': 'audio/flac',
        '.ogg': 'audio/ogg',
        '.m4a': 'audio/mp4',
    }[ext] ?? 'application/octet-stream';
}

/**
 * Combines several abort signals into one.
 *
 * `AbortSignal.any` only exists from Node 20.3, and SillyTavern supports
 * Node 20, so the manual version is kept as a fallback.
 *
 * @param {AbortSignal[]} signals
 * @returns {AbortSignal}
 */
function combineSignals(signals) {
    if (typeof AbortSignal.any === 'function') {
        return AbortSignal.any(signals);
    }
    const controller = new AbortController();
    for (const signal of signals) {
        if (signal.aborted) {
            controller.abort(signal.reason);
            break;
        }
        signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
    }
    return controller.signal;
}

/**
 * Sends the request to s2.cpp and waits for its turn.
 *
 * s2.cpp handles one synthesis at a time and answers 503 while another
 * request is still running. The waiting happens here, on the server, so the
 * browser does not have to deal with the race: the user just notices that
 * the audio starts a moment later.
 *
 * @param {string} url Full URL of the s2.cpp endpoint.
 * @param {FormData} body Multipart body; it can be sent more than once.
 * @param {AbortSignal} signal Cancels the request.
 * @returns {Promise<{response: Response, detail: string|null}>}
 *   `detail` holds the body of a 503 that could not be resolved.
 */
async function fetchUpstream(url, body, signal) {
    for (let attempt = 0; ; attempt++) {
        const response = await fetch(url, { method: 'POST', body, signal });

        if (response.status !== 503) {
            return { response, detail: null };
        }

        // The body has to be consumed, otherwise the connection stays open.
        const detail = await response.text().catch(() => '');

        if (attempt >= BUSY_RETRY_DELAYS_MS.length || signal?.aborted) {
            return { response, detail };
        }

        const delay = BUSY_RETRY_DELAYS_MS[attempt];
        // stdout on purpose: PowerShell turns anything a native process writes
        // to stderr into an error record, and this message is informational.
        console.log(`[S2 TTS] s2.cpp is busy, retrying in ${delay} ms (attempt ${attempt + 1})`);
        // The wait ends immediately when the browser goes away — the user
        // pressed stop and there is no point in holding the request open.
        await Promise.race([
            new Promise((resolve) => setTimeout(resolve, delay)),
            new Promise((resolve) => signal?.addEventListener('abort', resolve, { once: true })),
        ]);

        if (signal?.aborted) {
            return { response, detail };
        }
    }
}

/**
 * Relays a streaming synthesis response to the browser.
 *
 * The response headers are only written once the first chunk has arrived.
 * The reference-audio encode happens before the first audio frame is
 * produced, so waiting for that first chunk makes the "encode failed"
 * counter reliable instead of a race.
 *
 * @param {object} res Express response.
 * @param {Response} upstream Fetch response of the s2.cpp request.
 * @param {number} encodeFailuresBefore Counter value before the request.
 * @param {AbortController} disconnect Aborted when the browser goes away.
 * @param {CacheWriter} [cacheWriter] Receives a copy of the audio.
 */
async function relayStreamedAudio(res, upstream, encodeFailuresBefore, disconnect, cacheWriter) {
    const reader = upstream.body.getReader();

    let first;
    try {
        first = await reader.read();
    } catch (error) {
        return fail(res, 502, error?.message ?? '无法连接 s2.cpp。');
    }

    // Give the child's stderr a moment to be delivered. s2.cpp writes the
    // "encode failed" warning right before it starts generating frames, so by
    // the time audio shows up the warning is already in the pipe.
    await new Promise((resolve) => setTimeout(resolve, 30));

    const encodeFailures = encodeFailureCount - encodeFailuresBefore;

    res.status(200);
    res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'audio/wav');
    for (const name of ['X-Audio-Sample-Rate', 'X-Audio-Channels', 'X-Audio-Encoding']) {
        const value = upstream.headers.get(name);
        if (value) {
            res.setHeader(name, value);
        }
    }
    // `no-transform` keeps SillyTavern's compression() middleware from
    // buffering the whole body, which would defeat streaming completely.
    res.setHeader('Cache-Control', 'no-store, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    if (encodeFailures > 0) {
        res.setHeader('X-S2-Encode-Failures', String(encodeFailures));
    }
    res.flushHeaders?.();

    let closed = false;
    /**
     * Resolves as soon as the client is gone.
     *
     * `res.write()` returns false when the socket buffer is full, and the
     * matching "drain" event never arrives if the client disconnected in the
     * meantime. Waiting for it unconditionally would leave this relay — and
     * the upstream request it holds — hanging forever.
     */
    let signalClosed;
    const closedPromise = new Promise((resolve) => {
        signalClosed = resolve;
    });

    res.on('close', () => {
        closed = true;
        signalClosed();
        // Node emits "close" on a response both when it finished normally
        // and when the client went away. Only the second case must tear down
        // the upstream synthesis — aborting a finished request is harmless,
        // but the distinction keeps the intent obvious.
        if (res.writableEnded || res.finished) {
            return;
        }
        // Stop the synthesis instead of letting it finish for nobody.
        disconnect.abort();
        reader.cancel().catch(() => { /* already closed */ });
    });

    const write = async (chunk) => {
        if (closed) {
            return;
        }
        // The cache gets a copy of every chunk, so the entry is complete even
        // if the browser disappears halfway through.
        cacheWriter?.write(chunk);
        const writable = res.write(Buffer.from(chunk));
        if (!writable) {
            await Promise.race([
                new Promise((resolve) => res.once('drain', resolve)),
                closedPromise,
            ]);
        }
    };

    try {
        if (!first.done && first.value) {
            await write(first.value);
        }
        for (;;) {
            const { value, done } = await reader.read();
            if (done) {
                break;
            }
            if (value && value.byteLength) {
                await write(value);
            }
        }
        if (!closed) {
            res.end();
        }
    } catch {
        // The relay failed halfway through. The upstream request has to be
        // aborted: s2.cpp would otherwise keep synthesizing audio that nobody
        // is going to hear — and it stays "busy" for the rest of that
        // synthesis, which turns every following request into a 503.
        disconnect.abort();
        if (!closed) {
            res.end();
        }
    }
}

/**
 * Sends a cached entry to the browser.
 *
 * The cached audio is stored as raw 16-bit PCM. The streaming client wants
 * exactly that, the buffered client wants a WAV, so the header is rebuilt on
 * the fly for the latter.
 *
 * @param {object} res Express response.
 * @param {{meta: object, pcm: Buffer}} entry
 * @param {boolean} relayStream Whether the client asked for a stream.
 */
function sendCachedAudio(res, entry, relayStream) {
    const { meta, pcm } = entry;
    const sampleRate = meta.sampleRate ?? 44100;
    const channels = meta.channels ?? 1;

    if (relayStream) {
        res.status(200);
        res.setHeader('Content-Type', `audio/L16; rate=${sampleRate}; channels=${channels}`);
        res.setHeader('X-Audio-Sample-Rate', String(sampleRate));
        res.setHeader('X-Audio-Channels', String(channels));
        res.setHeader('X-Audio-Encoding', 'pcm_s16le');
        // Keep the compression middleware out of the way, same as for a
        // freshly streamed synthesis.
        res.setHeader('Cache-Control', 'no-store, no-transform');
        res.setHeader('X-Accel-Buffering', 'no');
        res.setHeader('X-S2-Cache', 'hit');
        res.send(pcm);
        return;
    }

    const header = buildWavHeader({
        sampleRate,
        channels,
        formatTag: 1,
        bitsPerSample: 16,
        dataLength: pcm.length,
    });
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Length', String(header.length + pcm.length));
    res.setHeader('X-S2-Cache', 'hit');
    res.status(200).send(Buffer.concat([header, pcm]));
}

/**
 * Stores a complete WAV file in the cache.
 *
 * Only 16-bit PCM is stored: that is the format the browser's streaming path
 * understands, and the format s2.cpp produces for every request that carries
 * `stream: true`.
 *
 * @param {AudioCache} cache
 * @param {string} key
 * @param {Buffer} wav
 * @param {object} extra
 * @returns {Promise<boolean>} True when the entry was written.
 */
async function storeInCache(cache, key, wav, extra) {
    try {
        const info = parseWav(wav);
        if (!info || info.formatTag !== 1 || info.bitsPerSample !== 16) {
            return false;
        }
        const pcm = wav.subarray(info.dataOffset, info.dataOffset + info.dataLength);
        const writer = new CacheWriter(cache, key, {
            sampleRate: info.sampleRate,
            channels: info.channels,
            ...extra,
        });
        writer.write(pcm);
        return !!(await writer.close());
    } catch {
        return false;
    }
}

/**
 * Drops the oldest entries when the cache grew past its limit.
 *
 * @param {AudioCache} cache
 * @param {number} [maxMb] Limit in megabytes.
 */
function evictCache(cache, maxMb) {
    if (!cache) {
        return;
    }
    const limit = Number(maxMb) > 0 ? Number(maxMb) * 1024 * 1024 : DEFAULT_MAX_BYTES;
    try {
        cache.evict(limit);
    } catch {
        /* eviction is best effort */
    }
}

/* ------------------------------------------------------------------- routes */

export async function init(router) {
    /**
     * GET /status — is the configured s2.cpp server reachable?
     * Body: { s2Url }
     */
    router.post('/status', async (req, res) => {
        const url = asUrl(req.body?.s2Url);
        if (!url) {
            return fail(res, 400, '服务地址无效，请填写 http://127.0.0.1:3030 这样的地址。');
        }
        const host = url.hostname;
        const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
        const listening = await probeTcp(host, port);
        if (!listening) {
            return res.json({
                ok: true,
                reachable: false,
                isS2: false,
                detail: `${host}:${port} 没有监听。`,
            });
        }
        const probe = await probeS2(url.toString());
        return res.json({
            ok: true,
            reachable: true,
            isS2: probe.isS2,
            detail: probe.isS2 ? 's2.cpp 已就绪。' : `${host}:${port} 被其它程序占用，不是 s2.cpp。`,
            url: url.toString(),
        });
    });

    /**
     * POST /generate — synthesize text and stream the WAV back.
     * Body: { s2Url, text, voice?, voiceDir?, referenceBase64?, referenceFilename?,
     *         referenceText?, params? }
     */
    router.post('/generate', async (req, res) => {
        const url = asUrl(req.body?.s2Url);
        if (!url) {
            return fail(res, 400, '服务地址无效。');
        }
        const text = String(req.body?.text ?? '').trim();
        if (!text) {
            return fail(res, 400, '待合成文本为空。');
        }

        const form = new FormData();
        form.append('text', text);

        const referenceBase64 = String(req.body?.referenceBase64 ?? '');
        const voice = String(req.body?.voice ?? '').trim();
        // The hash of the reference recording, used for the cache key. It is
        // set for both ways of getting a reference: an upload from the browser
        // and an audio file from the voice directory.
        let referenceHash = null;
        if (referenceBase64) {
            let buffer;
            try {
                buffer = Buffer.from(referenceBase64, 'base64');
            } catch {
                return fail(res, 400, '参考音频解码失败。');
            }
            if (buffer.length === 0) {
                return fail(res, 400, '参考音频为空。');
            }
            const filename = String(req.body?.referenceFilename ?? 'reference.wav');
            form.append('reference', new Blob([buffer], { type: guessMime(filename) }), filename);
            form.append('reference_text', String(req.body?.referenceText ?? ''));
            referenceHash = createHash('sha256').update(buffer).digest('hex');
        } else if (voice) {
            // The voice can be a bare id (looked up in voice_dir), a path to a
            // .s2voice file or a path to a recording. The tag based selection
            // uses the latter two: the three-level classification puts every
            // voice in its own folder, so the full path is what identifies it.
            const voiceDir = String(req.body?.voiceDir ?? '').trim();
            const sourceFile = resolveVoiceFile({ voice, voiceDir });

            if (sourceFile && isAudioPath(sourceFile)) {
                // A recording is not a voice profile: s2.cpp clones the voice
                // from the audio itself, so the bytes are uploaded as the
                // reference recording. The file is read here, on the server,
                // which also means that a Chinese path is not a problem — the
                // path never reaches s2.cpp.
                let buffer;
                try {
                    buffer = readFileSync(sourceFile);
                } catch {
                    return fail(res, 400, `读取音色文件失败：${sourceFile}`);
                }
                if (buffer.length === 0) {
                    return fail(res, 400, `音色文件为空：${sourceFile}`);
                }
                // s2.cpp refuses to synthesize without a word-by-word
                // transcript of the reference recording. It is kept in the
                // text file next to the recording.
                const transcript = readTranscript(sourceFile);
                if (!transcript) {
                    return fail(res, 400,
                        `音色 ${path.basename(sourceFile)} 缺少逐字转录。`
                        + `请在同目录放一个同名的 ${path.basename(sourceFile, path.extname(sourceFile))}.txt，`
                        + '内容写这段录音念出来的字。');
                }
                const filename = path.basename(sourceFile);
                form.append('reference', new Blob([buffer], { type: guessMime(filename) }), filename);
                form.append('reference_text', transcript);
                referenceHash = createHash('sha256').update(buffer).digest('hex');
            } else {
                // Only a path that s2.cpp cannot open needs the staging copy, so
                // the staging directory is not created for the common case.
                const staged = sourceFile
                    ? stageVoiceFile(sourceFile, isAsciiPath(sourceFile) ? null : stagingDirFor(req))
                    : null;
                if (sourceFile && !staged) {
                    // The path could neither be used as-is nor be staged. Say so
                    // instead of letting s2.cpp fail with an opaque message.
                    return fail(res, 400, `音色路径无法使用（可能包含无法转换的字符）：${sourceFile}`);
                }
                form.append('voice', staged ?? voice);
                if (!staged && voiceDir) {
                    form.append('voice_dir', voiceDir);
                }
            }
        }

        const params = req.body?.params && typeof req.body.params === 'object' ? req.body.params : {};
        form.append('params', JSON.stringify(params));

        // The client asks for a relayed stream when it wants to start playing
        // before the synthesis is finished.
        const relayStream = req.body?.relay === 'stream';

        /* ------------------------------------------------------------ cache */
        //
        // The cache is checked before anything is sent to s2.cpp: a hit skips
        // the reference encode and the whole generation, which is the whole
        // point of having it.
        const cacheWanted = req.body?.cacheEnabled !== false && !req.body?.bypassCache;
        let cache = null;
        let cacheKey = null;
        if (cacheWanted) {
            const dir = resolveCacheDir(req);
            if (dir) {
                try {
                    cache = new AudioCache(dir).ensure();
                    cacheKey = computeCacheKey({ text, voice, referenceBase64, referenceHash, params });
                } catch {
                    // A cache that cannot be created must never break synthesis.
                    cache = null;
                    cacheKey = null;
                }
            }
        }

        if (cache && cacheKey && cache.has(cacheKey)) {
            const entry = cache.read(cacheKey);
            if (entry) {
                sendCachedAudio(res, entry, relayStream);
                return;
            }
        }

        // s2.cpp reports a failed reference-audio encode on stderr only, and it
        // still answers 200 with audio that has no cloned voice. Count the
        // failures before and after the request so the extension can warn the
        // user instead of silently returning the wrong timbre.
        const encodeFailuresBefore = encodeFailureCount;

        // Two reasons to abort the upstream request: the synthesis took too
        // long, or the browser closed the connection (the user stopped the
        // playback). In the latter case s2.cpp should stop generating.
        const disconnect = new AbortController();
        const signal = combineSignals([AbortSignal.timeout(GENERATE_TIMEOUT_MS), disconnect.signal]);

        try {
            const { response: upstream, detail: busyDetail } = await fetchUpstream(
                endpoint(url, '/generate'),
                form,
                signal,
            );

            if (!upstream.ok) {
                const detail = (busyDetail ?? await upstream.text()).slice(0, 2000);
                // 503 means s2.cpp is busy with another synthesis — worth a
                // dedicated message so the UI can say "server busy" instead of
                // a generic failure.
                return res.status(upstream.status).json({
                    ok: false,
                    busy: upstream.status === 503,
                    error: detail || `s2.cpp 返回 ${upstream.status}`,
                });
            }

            if (relayStream && upstream.body) {
                // The relay is awaited so the handler only finishes once the
                // stream is really over — and so a failure inside it can still
                // be turned into a proper error response.
                const writer = cache && cacheKey
                    ? new CacheWriter(cache, cacheKey, {
                        sampleRate: Number(upstream.headers.get('X-Audio-Sample-Rate')) || 44100,
                        channels: Number(upstream.headers.get('X-Audio-Channels')) || 1,
                        text,
                        voice: voice || 'reference',
                    })
                    : null;
                // The header has to be set before the relay writes the
                // response headers; afterwards it is too late.
                res.setHeader('X-S2-Cache', 'miss');
                try {
                    await relayStreamedAudio(res, upstream, encodeFailuresBefore, disconnect, writer);
                } catch (error) {
                    writer?.abort();
                    if (!res.headersSent) {
                        fail(res, 502, error?.message ?? '流式转发失败。');
                        return;
                    }
                    if (!res.writableEnded) {
                        res.end();
                    }
                    return;
                }
                if (writer) {
                    await writer.close();
                    evictCache(cache, req.body?.cacheMaxMb);
                }
                return;
            }

            const buffer = Buffer.from(await upstream.arrayBuffer());
            const encodeFailures = encodeFailureCount - encodeFailuresBefore;
            res.setHeader('Content-Type', 'audio/wav');
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('Content-Length', String(buffer.length));
            res.setHeader('X-S2-Cache', 'miss');
            if (encodeFailures > 0) {
                res.setHeader('X-S2-Encode-Failures', String(encodeFailures));
            }
            if (cache && cacheKey) {
                await storeInCache(cache, cacheKey, buffer, { text, voice: voice || 'reference' });
                evictCache(cache, req.body?.cacheMaxMb);
            }
            res.status(200).send(buffer);
        } catch (error) {
            const message = error?.name === 'TimeoutError'
                ? 's2.cpp 合成超时。'
                : (error?.message ?? '无法连接 s2.cpp。');
            return fail(res, 502, message);
        }
    });

    /**
     * POST /cache/stats — size and entry count of the persistent cache.
     */
    router.post('/cache/stats', (req, res) => {
        const dir = resolveCacheDir(req);
        if (!dir) {
            return res.json({ ok: true, available: false, entries: 0, bytes: 0, dir: null });
        }
        try {
            const stats = new AudioCache(dir).ensure().stats();
            return res.json({ ok: true, available: true, ...stats });
        } catch (error) {
            return fail(res, 500, error?.message ?? '读取缓存统计失败。');
        }
    });

    /**
     * POST /cache/list — the cached entries, newest first.
     */
    router.post('/cache/list', (req, res) => {
        const dir = resolveCacheDir(req);
        if (!dir) {
            return res.json({ ok: true, available: false, entries: [] });
        }
        try {
            const entries = new AudioCache(dir).ensure().list();
            // The full text of every entry would be a lot of noise in the UI.
            const trimmed = entries.map((entry) => ({
                ...entry,
                text: String(entry.text ?? '').slice(0, 120),
            }));
            return res.json({ ok: true, available: true, entries: trimmed });
        } catch (error) {
            return fail(res, 500, error?.message ?? '读取缓存列表失败。');
        }
    });

    /**
     * POST /cache/delete — remove a single entry.
     * Body: { key }
     */
    router.post('/cache/delete', (req, res) => {
        const dir = resolveCacheDir(req);
        const key = String(req.body?.key ?? '').trim();
        if (!dir || !/^[0-9a-f]{64}$/.test(key)) {
            return fail(res, 400, '无效的缓存键。');
        }
        try {
            const removed = new AudioCache(dir).delete(key);
            return res.json({ ok: true, removed });
        } catch (error) {
            return fail(res, 500, error?.message ?? '删除缓存失败。');
        }
    });

    /**
     * POST /cache/clear — remove every cached entry.
     */
    router.post('/cache/clear', (req, res) => {
        const dir = resolveCacheDir(req);
        if (!dir) {
            return res.json({ ok: true, removed: 0 });
        }
        try {
            const removed = new AudioCache(dir).ensure().clear();
            return res.json({ ok: true, removed });
        } catch (error) {
            return fail(res, 500, error?.message ?? '清空缓存失败。');
        }
    });

    /**
     * POST /voices — list the voice files in a directory.
     * Body: { voiceDir }
     *
     * The directory may be arranged as a three-level classification
     * (voices/女/妩媚/生气.s2voice). The response carries the whole tree so
     * the extension can turn the tags of a reply into a voice.
     *
     * Both kinds of voice are listed: the saved `.s2voice` profiles and the
     * plain recordings (`.wav`, `.mp3`) that are cloned on the fly. A
     * recording carries the transcript that was found next to it, because
     * s2.cpp cannot clone a voice without one.
     */
    router.post('/voices', async (req, res) => {
        const dir = String(req.body?.voiceDir ?? '').trim();
        if (!dir) {
            return fail(res, 400, '未指定音色目录。');
        }
        if (!existsSync(dir)) {
            return res.json({ ok: true, voices: [], exists: false, dir, entries: [], tree: null });
        }
        try {
            const scan = scanVoiceTree(dir);
            // The flat list of the top level files is kept for the plain
            // voice picker, which selects one profile by id. Only saved
            // profiles belong there: a recording is picked by path, not by id.
            const voices = scan.entries
                .filter((entry) => entry.depth === 1 && entry.kind === 'profile')
                .map((entry) => entry.stem)
                .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
            // The picker may also choose a recording. A profile is addressed
            // by its id, a recording by its path — the plugin needs the full
            // path to be able to read it. Recordings are listed from the whole
            // tree, so a custom voice in a subfolder can be picked as the
            // default one as well.
            const voiceOptions = [
                ...scan.entries
                    .filter((entry) => entry.depth === 1 && entry.kind === 'profile')
                    .map((entry) => ({
                        value: entry.stem,
                        label: entry.stem,
                        kind: entry.kind,
                        transcript: '',
                    })),
                ...scan.entries
                    .filter((entry) => entry.kind === 'audio')
                    .map((entry) => ({
                        value: entry.path,
                        label: entry.rel,
                        kind: entry.kind,
                        transcript: entry.transcript ?? '',
                    })),
            ].sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
            return res.json({
                ok: true,
                exists: scan.exists,
                dir,
                voices,
                voiceOptions,
                entries: scan.entries,
                tree: scan.tree,
                names: scan.names,
            });
        } catch (error) {
            return fail(res, 500, error?.message ?? '读取音色目录失败。');
        }
    });

    /**
     * POST /voices/transcript — store the transcript of an audio voice.
     * Body: { voicePath, text }
     *
     * s2.cpp needs a word-by-word transcript of the reference recording to
     * clone a voice. The transcript belongs next to the recording, under the
     * same name, so that the voice directory stays self-contained.
     */
    router.post('/voices/transcript', async (req, res) => {
        const voicePath = String(req.body?.voicePath ?? '').trim();
        const text = String(req.body?.text ?? '');
        if (!voicePath) {
            return fail(res, 400, '未指定音色文件。');
        }
        if (!isAudioPath(voicePath)) {
            return fail(res, 400, '只有 .wav / .mp3 音色需要逐字转录。');
        }
        if (!existsSync(voicePath)) {
            return fail(res, 400, `音色文件不存在：${voicePath}`);
        }
        const written = writeTranscript(voicePath, text);
        if (!written) {
            return fail(res, 500, `写入转录失败：${voicePath}`);
        }
        return res.json({ ok: true, path: written, text: text.trim() });
    });

    /**
     * POST /voices/audio — hand out the bytes of a recording.
     * Body: { voiceDir, voicePath }
     *
     * The extension needs the raw audio to draw the waveform and to cut the
     * reference recording down to the part that is actually used. The file is
     * only served when it lives inside the voice directory, so the route
     * cannot be used to read arbitrary files.
     */
    router.post('/voices/audio', (req, res) => {
        const voiceDir = String(req.body?.voiceDir ?? '').trim();
        const voicePath = String(req.body?.voicePath ?? '').trim();
        if (!voicePath) {
            return fail(res, 400, '未指定音色文件。');
        }
        if (!existsSync(voicePath)) {
            return fail(res, 400, `音色文件不存在：${voicePath}`);
        }
        if (voiceDir) {
            const root = path.resolve(voiceDir);
            const target = path.resolve(voicePath);
            const inside = target === root || target.startsWith(root + path.sep);
            if (!inside) {
                return fail(res, 400, '只能读取音色目录里的文件。');
            }
        }
        const bytes = readFileSync(voicePath);
        res.setHeader('Content-Type', guessMime(voicePath));
        res.setHeader('Content-Length', String(bytes.length));
        res.setHeader('Cache-Control', 'no-store');
        return res.send(bytes);
    });

    /**
     * POST /voices/profile — create a `.s2voice` profile from a recording.
     * Body: { voicePath, voiceDir, transcript, targetId, targetDir, audioBase64,
     *         exe, model, tokenizer, dllDir, cudaDevice }
     *
     * The browser cuts the reference recording down to the chosen range and
     * sends the result as base64 WAV; the plugin writes it to a scratch file
     * and runs `s2.exe --save-voice` with it.
     *
     * s2.cpp needs a few seconds to load the model, so the route answers right
     * away with a job id and the browser polls `/voices/profile/status`.
     */
    router.post('/voices/profile', (req, res) => {
        const body = req.body ?? {};
        const transcript = String(body.transcript ?? '').trim();
        const targetId = String(body.targetId ?? '').trim();
        const targetDir = String(body.targetDir ?? '').trim();
        const audioBase64 = String(body.audioBase64 ?? '').trim();

        if (!transcript) {
            return fail(res, 400, '缺少逐字转录，s2.cpp 没有它就存不了档案。');
        }
        if (!isValidVoiceId(targetId)) {
            return fail(res, 400, `档案名不合法：${targetId || '(空)'}`);
        }
        if (!targetDir) {
            return fail(res, 400, '未指定档案存放目录。');
        }
        if (!audioBase64) {
            return fail(res, 400, '没有收到参考音频。');
        }

        const exe = String(body.exe ?? '').trim();
        const model = String(body.model ?? '').trim();
        const tokenizer = String(body.tokenizer ?? '').trim();
        for (const [label, value] of [['s2.exe', exe], ['GGUF 模型', model], ['tokenizer', tokenizer]]) {
            if (!value || !existsSync(value)) {
                return fail(res, 400, `${label} 文件不存在：${value || '(空)'}`);
            }
        }

        let bytes;
        try {
            bytes = Buffer.from(audioBase64, 'base64');
        } catch {
            return fail(res, 400, '参考音频不是有效的 base64。');
        }
        if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF') {
            return fail(res, 400, '参考音频不是有效的 WAV 文件。');
        }

        try {
            mkdirSync(targetDir, { recursive: true });
        } catch (error) {
            return fail(res, 500, `创建档案目录失败：${error?.message ?? error}`);
        }

        const jobId = `profile-${Date.now().toString(36)}-${(profileJobSeq++).toString(36)}`;
        // s2.cpp opens the profile and the reference audio with narrow strings,
        // so both have to live in an ASCII-only directory. The profile is
        // written there and moved to its final place afterwards.
        const stagingDir = stagingDirFor(req);
        if (!stagingDir) {
            return fail(res, 500, '找不到一个纯 ASCII 的临时目录，s2.cpp 打不开中文路径。');
        }
        const workDir = path.join(stagingDir, jobId);
        const promptAudio = writeReferenceFile(workDir, 'reference.wav', bytes);
        // The id only names the file while s2.cpp writes it, so a hash of the
        // target is enough — it has to be ASCII and it has to be stable.
        const asciiId = createHash('sha256')
            .update(`${targetDir}\\${targetId}`)
            .digest('hex')
            .slice(0, 16);

        const job = {
            id: jobId,
            state: 'running',
            stage: 'starting',
            message: '',
            logs: [],
            result: null,
            startedAt: Date.now(),
        };
        profileJobs.set(jobId, job);

        // Keep the map from growing without bound.
        if (profileJobs.size > MAX_PROFILE_JOBS) {
            for (const [id, entry] of profileJobs) {
                if (entry.state !== 'running' && id !== jobId) {
                    profileJobs.delete(id);
                }
            }
        }

        const target = sanitizeVoiceId(targetId);
        const profilePath = path.join(targetDir, `${target}${PROFILE_EXTENSION}`);
        const run = runProfileSave({
            exe,
            model,
            tokenizer,
            promptAudio,
            promptText: transcript,
            voiceId: asciiId,
            voiceDir: workDir,
            workDir,
            dllDir: String(body.dllDir ?? '').trim(),
            cudaDevice: Number(body.cudaDevice ?? 0),
            onLog: (line) => {
                job.logs.push(line);
                if (job.logs.length > 120) {
                    job.logs.shift();
                }
            },
            onStage: (stage) => {
                job.stage = stage;
            },
        });

        run.promise.then((outcome) => {
            if (outcome.ok) {
                // Move the profile from the ASCII staging area to the place the
                // user picked — Node handles Unicode paths without trouble.
                const staged = path.join(workDir, `${asciiId}${PROFILE_EXTENSION}`);
                try {
                    copyFileSync(staged, profilePath);
                } catch (error) {
                    cleanupWorkDir(workDir);
                    job.state = 'error';
                    job.stage = 'error';
                    job.message = `写入档案失败：${error?.message ?? error}`;
                    return;
                }
                cleanupWorkDir(workDir);
                job.state = 'done';
                job.stage = 'saved';
                job.result = {
                    path: profilePath,
                    id: target,
                    bytes: existsSync(profilePath) ? readFileSync(profilePath).length : 0,
                    elapsedMs: outcome.elapsedMs,
                };
            } else {
                cleanupWorkDir(workDir);
                job.state = 'error';
                job.stage = 'error';
                job.message = outcome.error ?? '生成音色档案失败。';
            }
        });

        return res.json({ ok: true, jobId, target: profilePath });
    });

    /**
     * POST /voices/profile/status — progress of a profile job.
     * Body: { jobId }
     */
    router.post('/voices/profile/status', (req, res) => {
        const jobId = String(req.body?.jobId ?? '').trim();
        const job = profileJobs.get(jobId);
        if (!job) {
            return fail(res, 404, '找不到这个任务。');
        }
        return res.json({
            ok: true,
            id: job.id,
            state: job.state,
            stage: job.stage,
            message: job.message,
            logs: job.logs.slice(-30),
            result: job.result,
            elapsedMs: Date.now() - job.startedAt,
        });
    });

    /**
     * POST /start — spawn s2.cpp as a child process of the ST server.
     * Body: { exe, model, tokenizer, voiceDir, dllDir, host, port,
     *         cudaDevice, gpuLayers, codecBackend }
     */
    router.post('/start', async (req, res) => {
        if (child && child.exitCode === null) {
            return fail(res, 409, '本插件已经启动了一个 s2.cpp 进程，请先停止。');
        }
        const body = req.body ?? {};
        const exe = String(body.exe ?? '').trim();
        if (!exe) {
            return fail(res, 400, '未指定 s2.exe 路径。');
        }
        if (!existsSync(exe)) {
            return fail(res, 400, `s2.exe 不存在：${exe}`);
        }
        for (const [label, value] of [['GGUF 模型', body.model], ['tokenizer', body.tokenizer]]) {
            if (!String(value ?? '').trim() || !existsSync(String(value))) {
                return fail(res, 400, `${label} 文件不存在：${value || '(空)'}`);
            }
        }
        const voiceDir = String(body.voiceDir ?? '').trim();
        if (!voiceDir) {
            return fail(res, 400, '未指定音色目录。');
        }

        const host = String(body.host ?? '127.0.0.1').trim();
        const port = Number(body.port ?? 3030);
        if (await probeTcp(host, port)) {
            return fail(res, 409, `${host}:${port} 已有服务监听，请先关闭占用该端口的进程。`);
        }

        const codecBackend = String(body.codecBackend ?? 'auto').toLowerCase();
        const codecFlag = {
            'auto': '--codec-auto',
            'follow backend': '--codec-follow-backend',
            'cpu': '--codec-cpu',
        }[codecBackend];
        if (!codecFlag) {
            return fail(res, 400, `未知的 Codec 后端：${codecBackend}`);
        }

        const args = [
            '--model', String(body.model),
            '--tokenizer', String(body.tokenizer),
            '--cuda', String(Number(body.cudaDevice ?? 0)),
            '--gpu-layers', String(Number(body.gpuLayers ?? -1)),
            codecFlag,
            '--voice-dir', voiceDir,
            '--server', '--host', host, '--port', String(port),
        ];

        // CUDA runtime DLLs (cublas64_*.dll / cudart64_*.dll) frequently live
        // outside the exe folder; prepend the configured directory to PATH so
        // the child can find them.
        const env = { ...process.env };
        const dllDir = String(body.dllDir ?? '').trim();
        if (dllDir) {
            if (!existsSync(dllDir)) {
                return fail(res, 400, `DLL 目录不存在：${dllDir}`);
            }
            env.PATH = `${dllDir}${path.delimiter}${env.PATH ?? ''}`;
        }

        try {
            child = spawn(exe, args, {
                cwd: path.dirname(exe),
                env,
                windowsHide: true,
            });
        } catch (error) {
            child = null;
            return fail(res, 500, `启动失败：${error?.message ?? error}`);
        }

        child.stdout?.on('data', (chunk) => appendLogs(chunk));
        child.stderr?.on('data', (chunk) => appendLogs(chunk));
        child.on('exit', (code) => {
            appendLogs(`[s2.cpp] 进程退出，退出码 ${code}`);
            child = null;
        });
        child.on('error', (error) => {
            appendLogs(`[s2.cpp] 进程错误：${error.message}`);
            child = null;
        });

        return res.json({ ok: true, pid: child.pid, host, port, logs: s2Logs.slice(-20) });
    });

    /**
     * POST /logs — tail of the s2.cpp process output.
     * Body: { limit? }
     *
     * Used by the extension to surface engine-side warnings that never reach
     * the HTTP response, most importantly the silent "encode failed" fallback
     * that drops the user's reference audio.
     */
    router.post('/logs', async (req, res) => {
        const limit = Math.min(Math.max(Number(req.body?.limit ?? 80) || 80, 1), MAX_LOG_LINES);
        return res.json({
            ok: true,
            running: Boolean(child && child.exitCode === null),
            pid: child?.pid ?? null,
            encodeFailures: encodeFailureCount,
            warnings: s2Warnings.slice(-25),
            lines: s2Logs.slice(-limit),
        });
    });

    /**
     * POST /stop — terminate the s2.cpp process started by this plugin.
     */
    router.post('/stop', async (_req, res) => {
        if (!child || child.exitCode !== null) {
            child = null;
            return res.json({ ok: true, message: '没有由本插件启动的 s2.cpp 进程。' });
        }
        const target = child;
        child = null;
        target.kill();
        return res.json({ ok: true, message: '已请求停止 s2.cpp。' });
    });
}

/** Called by SillyTavern when the server shuts down. */
export async function exit() {
    if (child && child.exitCode === null) {
        child.kill();
        child = null;
    }
}
