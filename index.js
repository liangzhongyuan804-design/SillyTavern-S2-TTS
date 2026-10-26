/**
 * S2 TTS (s2.cpp) — SillyTavern browser extension.
 *
 * Takes the text of a chat reply, synthesizes it with a local s2.cpp server
 * (Fish Audio S2-Pro GGUF) and plays the result inside the chat.
 *
 * The browser never talks to s2.cpp directly: s2.cpp sends no CORS headers,
 * so every request goes through the companion server plugin mounted at
 * /api/plugins/st-s2-tts/.
 */

import {
    eventSource,
    event_types,
    getRequestHeaders,
    saveSettings,
    saveSettingsDebounced,
    substituteParams,
} from '../../../../script.js';
import { extension_settings, getContext, renderExtensionTemplateAsync } from '../../../extensions.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { getCurrentLocale } from '../../../i18n.js';
import { sanitizeText, extractReadRange, wrapReadRange } from './sanitize.js';
import { TtsPlayer } from './player.js';
import { SpeakQueue } from './queue.js';
import {
    buildKnownSets,
    describeTags,
    parseTags,
    resolveTagVoice,
    splitNameList,
    splitTagBlock,
} from './voicetree.js';
import { createProfileBuilder } from './profile-ui.js';

const PLUGIN_BASE = '/api/plugins/st-s2-tts';

/**
 * Where this extension lives.
 *
 * The folder name depends on how the extension was installed: the manual
 * installer uses "st-s2-tts", the extension manager clones the repository
 * under its own name. Everything is therefore derived from the URL of this
 * module instead of being hard coded, so the extension works no matter which
 * name it was installed under.
 */
const EXTENSION_URL = new URL('.', import.meta.url);
const EXTENSION_NAME = EXTENSION_URL.pathname
    .replace(/^\/scripts\/extensions\//, '')
    .replace(/\/+$/, '');

/**
 * Locale files shipped with this extension.
 *
 * SillyTavern's own manifest-driven loader looks the file up by the lowercased
 * locale id and merges it into the global locale data, which does not
 * override keys the base locale already defines. Loading the file here keeps
 * the panel fully translated regardless of that ordering.
 */
const LOCALE_FILES = {
    'zh-cn': 'locales/zh-CN.json',
    'zh': 'locales/zh-CN.json',
    'zh-hans': 'locales/zh-CN.json',
    'zh-hans-cn': 'locales/zh-CN.json',
    'zh-tw': 'locales/zh-CN.json',
    'zh-hant': 'locales/zh-CN.json',
    'en': 'locales/en.json',
    'en-us': 'locales/en.json',
    'en-gb': 'locales/en.json',
};

const DEFAULTS = {
    // service
    serverUrl: 'http://127.0.0.1:3030',
    host: '127.0.0.1',
    port: 3030,
    // voice
    voiceMode: 'saved',
    voiceId: '',
    voiceDir: '',
    referenceDataUrl: '',
    referenceFilename: '',
    referenceText: '',
    // generation
    temperature: 0.58,
    topP: 0.88,
    topK: 40,
    maxNewTokens: 8192,
    segmentSentences: true,
    sentencePauseMs: 250,
    streaming: true,
    streamStartBufferMs: 300,
    // persistent cache
    cacheEnabled: true,
    cacheMaxMb: 512,
    // behaviour
    autoPlay: true,
    narrateUser: false,
    showButton: true,
    stripTags: true,
    stripCode: true,
    stripAsterisks: true,
    playbackRate: 1.0,
    // reading range: "朗读" reads the whole message, "【朗读内容】" only the
    // part between the markers
    readRange: '朗读',
    readRangeFallback: true,
    // tag driven voice selection
    tagVoiceEnabled: true,
    tagStripUnknown: false,
    tagCustomGender: '',
    tagCustomPersonality: '',
    tagCustomTone: '',
    tagTestLine: '小雅·女·妩媚·生气·：“你好呀。”',
    // server process
    exe: '',
    model: '',
    tokenizer: '',
    dllDir: '',
    cudaDevice: 0,
    gpuLayers: -1,
    codecBackend: 'auto',
};

/** Decoded audio per message id, so replaying never re-synthesizes. */
const audioCache = new Map();
/** Message ids with a synthesis request in flight. */
const busy = new Set();

/**
 * Playback state per message id.
 *
 * 'playing' — this message is the one being heard right now.
 * 'queued'  — this message is waiting its turn.
 *
 * @type {Map<number, string>}
 */
const playbackState = new Map();

let audioContext = null;
let lastAutoSpokenId = -1;
let initialized = false;

/**
 * The voice tree as returned by the server plugin.
 *
 * @type {object|null}
 */
let voiceTree = null;

/** When the tree was read the last time (ms). */
let voiceTreeAt = 0;

/**
 * How long a cached voice tree is used before it is read again.
 *
 * The user may drop a new folder into the voice directory at any time, and
 * the tree has to know about it. Reading the directory is cheap (a few
 * milliseconds), so it is refreshed shortly before every synthesis.
 */
const VOICE_TREE_TTL_MS = 5000;

/* --------------------------------------------------------------- utilities */

function settings() {
    if (!extension_settings.s2tts || typeof extension_settings.s2tts !== 'object') {
        extension_settings.s2tts = {};
    }
    for (const [key, value] of Object.entries(DEFAULTS)) {
        if (!(key in extension_settings.s2tts)) {
            extension_settings.s2tts[key] = value;
        }
    }
    return extension_settings.s2tts;
}

async function api(path, body) {
    const response = await fetch(`${PLUGIN_BASE}${path}`, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(body ?? {}),
    });

    const contentType = response.headers.get('Content-Type') ?? '';
    if (!contentType.includes('application/json')) {
        if (response.status === 404) {
            // The route only exists when the server plugin is loaded, so a 404
            // means exactly one thing: the plugin is missing or disabled.
            throw new Error(t(
                'ErrPluginMissing',
                '服务端插件没有加载。在酒馆目录执行 `node plugins.js install <本扩展的仓库地址>`，'
                + '并在 config.yaml 里加上 `enableServerPlugins: true`，然后重启酒馆。',
            ));
        }
        if (!response.ok) {
            throw new Error(`${response.status} ${response.statusText}`);
        }
        return response.arrayBuffer();
    }

    const data = await response.json();
    if (!response.ok || data.ok === false) {
        const error = new Error(data.error ?? `${response.status} ${response.statusText}`);
        error.busy = !!data.busy;
        throw error;
    }
    return data;
}

/**
 * Same as `api()` but for the binary WAV route.
 *
 * The plugin tags responses that hit s2.cpp's "encode failed" fallback with
 * an `X-S2-Encode-Failures` header, and the header has to survive to the
 * caller — so the raw Response is inspected instead of a plain ArrayBuffer.
 *
 * @param {string} path Route below the plugin base.
 * @param {object} body Request body.
 * @param {AbortSignal} [signal] Cancels the request when the user stops.
 */
async function apiAudio(path, body, signal) {
    const response = await fetch(`${PLUGIN_BASE}${path}`, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(body ?? {}),
        signal,
    });

    const contentType = response.headers.get('Content-Type') ?? '';
    if (!contentType.includes('application/json')) {
        if (!response.ok) {
            throw new Error(`${response.status} ${response.statusText}`);
        }
        // The response is handed over untouched: a streaming PCM body must
        // stay readable while it arrives, so it cannot be buffered here.
        return {
            response,
            encodeFailures: Number(response.headers.get('X-S2-Encode-Failures') ?? 0) || 0,
            cache: (response.headers.get('X-S2-Cache') ?? '').toLowerCase(),
        };
    }

    const data = await response.json();
    if (!response.ok || data.ok === false) {
        const error = new Error(data.error ?? `${response.status} ${response.statusText}`);
        error.busy = !!data.busy;
        throw error;
    }
    return { response: null, encodeFailures: 0, cache: '', data };
}

/** Locale strings for runtime messages (loaded next to the panel). */
let I18N = {};

/**
 * Looks up a runtime message in the active locale.
 *
 * The Chinese text stays as the fallback so a missing or broken locale file
 * never leaves the user staring at a raw translation key.
 */
function t(key, fallback = key) {
    return I18N[key] ?? fallback;
}

function notify(message, level = 'info') {
    if (typeof toastr === 'undefined') {
        console.log(`[S2 TTS] ${message}`);
        return;
    }
    const fn = level === 'error' ? toastr.error : level === 'warning' ? toastr.warning : toastr.info;
    fn.call(toastr, message, 'S2 TTS');
}

function setStatus(text, state = 'offline') {
    const element = document.querySelector('#s2tts_status');
    if (!element) {
        return;
    }
    element.textContent = text;
    element.classList.remove('s2tts-status-online', 's2tts-status-offline', 's2tts-status-busy');
    element.classList.add(`s2tts-status-${state}`);
}

/**
 * Turns a chat message into speakable text.
 *
 * The heavy lifting lives in sanitize.js so it stays unit-testable.
 */
function prepareText(raw) {
    const cfg = settings();
    return sanitizeText(raw, {
        stripCode: cfg.stripCode,
        stripTags: cfg.stripTags,
        stripAsterisks: cfg.stripAsterisks,
        substitute: substituteParams,
    });
}

/* ---------------------------------------------------------------- playback */

function getAudioContext() {
    if (!audioContext) {
        const Ctor = window.AudioContext ?? window.webkitAudioContext;
        if (!Ctor) {
            throw new Error(t('ErrNoWebAudio', '当前浏览器不支持 Web Audio API。'));
        }
        audioContext = new Ctor();
    }
    if (audioContext.state === 'suspended') {
        audioContext.resume().catch(() => { /* user gesture will retry */ });
    }
    return audioContext;
}

/**
 * Browsers keep a fresh AudioContext suspended until the user interacts with
 * the page, and that blocks programmatic playback. Unlocking it on the first
 * gesture keeps auto-play working for every later message.
 */
function unlockAudio() {
    try {
        getAudioContext();
    } catch {
        /* Web Audio unavailable; the error surfaces when playback is requested */
    }
}

/** Shared player: owns the scheduled nodes and the in-flight response. */
const player = new TtsPlayer({
    getContext: getAudioContext,
    translate: (key, fallback) => t(key, fallback),
});

/**
 * The read-aloud queue.
 *
 * Every job is played one after another: s2.cpp can only handle one synthesis
 * at a time, and two replies talking over each other are just noise.
 */
const speakQueue = new SpeakQueue({
    run: runSpeakJob,
    waitForPlayback: () => player.waitForEnd(),
    afterRun: (job, result) => {
        // The queue is the reason two replies never talk over each other, so
        // the log makes that verifiable: "done" always comes after the audio
        // of that job really ended, and before the next job starts.
        console.info(`[S2 TTS] queue: done (mes=${job.mesId ?? '-'})`);
        if (job.mesId === null || job.mesId === undefined) {
            return;
        }
        // The same message can be queued twice; the button must not fall back
        // to "idle" while the second copy is still waiting.
        const stillQueued = speakQueue.items.some((queued) => queued.mesId === job.mesId);
        if (!stillQueued) {
            playbackState.delete(job.mesId);
            if (!result.error) {
                // The playback is over, so the button must leave the "playing"
                // state — otherwise it stays a stop button forever and the
                // message can no longer be replayed with it. A cached message
                // goes back to "ready", everything else to "idle".
                updateButton(job.mesId, audioCache.has(job.mesId) ? 'ready' : 'idle');
            }
        }
    },
});

/* ---------------------------------------------------------- tag selection */

/**
 * Reads the voice tree from the server plugin.
 *
 * The tree is the list of the voices below the voice directory (`.s2voice`
 * profiles as well as plain recordings), arranged as the three-level
 * classification (性别 / 性格 / 语气). The folder names are the tags, so a
 *
 * @param {boolean} [force] Ignore the cached copy.
 * @returns {Promise<object|null>} The tree, or null when it cannot be read.
 */
async function refreshVoiceTree(force = false) {
    const cfg = settings();
    if (!cfg.voiceDir) {
        voiceTree = null;
        voiceTreeAt = 0;
        return null;
    }
    if (!force && voiceTree && Date.now() - voiceTreeAt < VOICE_TREE_TTL_MS) {
        return voiceTree;
    }
    try {
        voiceTree = await api('/voices', { voiceDir: cfg.voiceDir });
        voiceTreeAt = Date.now();
    } catch (error) {
        // A missing tree only means that no tag can select a voice — the
        // normal voice picker keeps working.
        console.log(`[S2 TTS] could not read the voice tree: ${error.message}`);
        voiceTree = null;
    }
    return voiceTree;
}

/**
 * The names that may be used as a tag.
 *
 * They come from the folders of the voice tree plus the user's own list.
 *
 * @returns {{gender: Set<string>, personality: Set<string>, tone: Set<string>}}
 */
function knownTagNames() {
    const cfg = settings();
    return buildKnownSets(voiceTree?.entries ?? [], {
        gender: cfg.tagCustomGender,
        personality: cfg.tagCustomPersonality,
        tone: cfg.tagCustomTone,
    });
}

/**
 * Works out which voice a reply should be spoken with.
 *
 * The tag block is also stripped from the text — the tags are metadata and
 * must not be read out loud.
 *
 * @param {string} text Raw message text.
 * @returns {Promise<{text: string, voice: string|null, tags: object|null, matched: boolean, resolved: object|null}>}
 */
async function resolveVoiceForText(text) {
    const cfg = settings();
    const result = {
        text: String(text ?? ''),
        voice: null,
        tags: null,
        matched: false,
        resolved: null,
    };
    if (!cfg.tagVoiceEnabled) {
        return result;
    }

    // Most replies carry no tag block at all. Finding out is cheap and needs
    // no server round trip, so the voice tree is only read when there is
    // something that could match.
    if (!splitTagBlock(text)) {
        return result;
    }

    const tree = await refreshVoiceTree();
    const known = knownTagNames();
    const parsed = parseTags(text, known, { stripUnknown: !!cfg.tagStripUnknown });
    if (!parsed.block) {
        return result;
    }

    result.text = parsed.text;
    result.tags = parsed.tags;
    result.matched = parsed.matched;
    if (!parsed.matched) {
        return result;
    }
    // The reference mode clones the voice from an uploaded file — a tag must
    // not silently replace that.
    if (cfg.voiceMode !== 'saved') {
        return result;
    }

    const resolved = resolveTagVoice(parsed.tags, tree?.entries ?? []);
    if (!resolved) {
        console.info(`[S2 TTS] tag voice: ${describeTags(parsed.tags)} -> no match, using the default voice`);
        return result;
    }

    result.voice = resolved.path;
    result.resolved = resolved;
    console.info(`[S2 TTS] tag voice: ${describeTags(parsed.tags)} -> ${resolved.rel} (${resolved.reason}`
        + `${resolved.kind === 'audio' ? ', audio clone' : ''})`);
    return result;
}

/* ------------------------------------------------------------- synthesis */

function buildParams() {
    const cfg = settings();
    const params = {
        stream: true,
        segment_sentences: !!cfg.segmentSentences,
        sentence_pause_ms: Number(cfg.sentencePauseMs) || 0,
        max_new_tokens: Number(cfg.maxNewTokens) || 8192,
        temperature: Number(cfg.temperature),
        top_p: Number(cfg.topP),
        top_k: Number(cfg.topK),
    };

    if (cfg.streaming) {
        // Ask s2.cpp for a chunked PCM stream. `stream_start_buffer_ms` is how
        // much audio the server buffers before it sends the first bytes; keep
        // it small so playback starts as early as possible.
        params.chunked = true;
        params.output_format = 'pcm_s16le';
        params.stream_start_buffer_ms = Math.max(0, Number(cfg.streamStartBufferMs) || 0);
        // The decisive knob. By default s2.cpp keeps the trailing codec frames
        // buffered until they are "stable", which means nothing is emitted
        // before the last frame and the response looks buffered no matter
        // what the transport does. Measured on this machine: 12.2 s to the
        // first byte with the default, 1.5 s with a holdback of zero.
        params.stream_holdback_frames = 0;
        // Sentence splitting makes the server synthesize a whole sentence
        // before any audio is pushed, which defeats streaming.
        params.segment_sentences = false;
    }

    return params;
}

/**
 * Waits for a moment.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * How long to wait before each retry when s2.cpp answers 503 ("busy").
 *
 * s2.cpp handles one synthesis at a time. The server plugin already waits
 * for its turn, so this only matters when something else on the machine is
 * using the same s2.cpp.
 */
const BUSY_RETRY_DELAYS = [1500, 3000, 5000, 8000, 12000];

/**
 * Asks the plugin to synthesize the text.
 *
 * s2.cpp handles one synthesis at a time and answers 503 while another
 * request is still running. Clicking two messages in a row therefore hits
 * that limit, so a busy answer is retried with a growing delay instead of
 * failing the playback.
 *
 * @param {string} text
 * @param {AbortSignal} signal
 * @param {object} [options]
 * @param {boolean} [options.bypassCache] Ignore the persistent cache.
 * @param {string} [options.voice] Voice to use instead of the default one.
 */
async function requestAudio(text, signal, { bypassCache = false, voice = null } = {}) {
    const cfg = settings();
    const payload = {
        s2Url: cfg.serverUrl,
        text,
        params: buildParams(),
        // Ask the plugin to relay the upstream body instead of buffering it.
        // The plugin falls back to a normal response when s2.cpp does not
        // support the streaming parameters.
        relay: cfg.streaming ? 'stream' : 'buffer',
        // The persistent cache lives on the server; the client only says
        // whether it wants it used and how big it may grow.
        cacheEnabled: !!cfg.cacheEnabled,
        cacheMaxMb: Number(cfg.cacheMaxMb) || 0,
        bypassCache: !!bypassCache,
    };

    if (cfg.voiceMode === 'reference') {
        if (!cfg.referenceDataUrl) {
            throw new Error(t('ErrNoReferenceAudio', '尚未选择参考音频。请在扩展设置里上传参考音频并填写对应文本。'));
        }
        if (!cfg.referenceText.trim()) {
            throw new Error(t('ErrNoReferenceText', '参考音频缺少对应文本，s2.cpp 需要逐字转录才能克隆音色。'));
        }
        payload.referenceBase64 = cfg.referenceDataUrl.split(',').pop() ?? '';
        payload.referenceFilename = cfg.referenceFilename || 'reference.wav';
        payload.referenceText = cfg.referenceText;
    } else {
        const selected = voice || cfg.voiceId;
        if (!selected) {
            throw new Error(t('ErrNoSavedVoice', '尚未选择音色。请在扩展设置里选择一个 .s2voice 或 .wav 音色。'));
        }
        payload.voice = selected;
        // A tag picks a voice by its full path, so the directory is already
        // part of it and must not be sent along.
        payload.voiceDir = voice ? '' : cfg.voiceDir;
    }

    // s2.cpp handles one synthesis at a time and answers 503 while another
    // request is still running. The server plugin already waits for its turn
    // internally; this is the second line of defense for the case where the
    // busy answer still comes through (for example when something else on
    // the machine uses the same s2.cpp).
    for (let attempt = 0; ; attempt++) {
        try {
            return await apiAudio('/generate', payload, signal);
        } catch (error) {
            if (!error.busy || attempt >= BUSY_RETRY_DELAYS.length || signal?.aborted) {
                if (error.busy) {
                    // The raw message comes from s2.cpp and is in English.
                    error.message = t('ErrS2Busy', 's2.cpp 正在处理另一个合成请求，请稍后再试。');
                }
                throw error;
            }
            await sleep(BUSY_RETRY_DELAYS[attempt]);
            if (signal?.aborted) {
                const aborted = new Error('Aborted');
                aborted.name = 'AbortError';
                throw aborted;
            }
        }
    }
}

/**
 * Cuts the text down to the configured reading range.
 *
 * The tag block is already gone at this point — the range is what the user
 * marked as "this is what should be spoken", everything else (a stage
 * direction, a thought, a system note) is dropped.
 *
 * @param {string} text The text after the tag block was removed.
 * @returns {{text: string, found: boolean}} The text to speak.
 */
function applyReadRange(text) {
    const cfg = settings();
    const source = String(text ?? '');
    if (!cfg.readRange || !String(cfg.readRange).trim()) {
        return { text: source, found: false };
    }
    const ranged = extractReadRange(source, cfg.readRange);
    if (ranged.found) {
        return ranged;
    }
    // No range in the text. Reading the whole message is the friendlier
    // default — the alternative is silence for every message that does not
    // follow the format.
    return { text: cfg.readRangeFallback ? source : '', found: false };
}

/**
 * Synthesizes `text` and plays it. Resolves with the duration in seconds,
 * or -1 when the text was empty / nothing to speak.
 *
 * @param {string} text
 * @param {object} [options]
 * @param {number|null} [options.mesId] Message the playback belongs to.
 * @param {boolean} [options.bypassCache] Ignore the persistent cache.
 * @param {string} [options.voice] Voice to use instead of the tagged one.
 */
async function speakText(text, { mesId = null, bypassCache = false, voice = null } = {}) {
    // The tag block in the reply decides which voice is used, and it is
    // stripped from the text before anything is synthesized.
    const selection = await resolveVoiceForText(text);
    const chosen = voice || selection.voice;
    // The reading range narrows the text down to the part that is spoken.
    const ranged = applyReadRange(selection.text);
    const clean = prepareText(ranged.text);
    if (!clean) {
        return -1;
    }
    const cfg = settings();
    if (mesId !== null) {
        busy.add(mesId);
        updateButton(mesId, 'loading');
    }
    try {
        // Stop whatever is playing before a new synthesis starts, so the two
        // never overlap.
        player.stop();
        // The abort signal is created before the request is sent: while the
        // server is still synthesizing there is no body to cancel yet, so
        // "stop" could not interrupt it otherwise.
        const signal = player.beginRequest();
        // The clock starts before the request, not after it. In streaming mode
        // the plugin only writes the response headers once the first audio
        // chunk has arrived, so the fetch resolves 1.5 s into the synthesis —
        // measuring from there would report a misleadingly tiny latency.
        const started = performance.now();
        const { response, encodeFailures, cache } = await requestAudio(clean, signal, { bypassCache, voice: chosen });
        if (encodeFailures > 0) {
            // s2.cpp answered 200 with audio, but the reference audio could not
            // be encoded, so the clone was silently dropped. Say so, otherwise
            // the user just hears "the wrong voice" with no explanation.
            notify(
                t('WarnEncodeFailed', '参考音频编码失败，已回退为默认音色。参考音频过长（建议 5–15 秒）时最容易出现，可在扩展设置里查看 s2.cpp 日志。'),
                'warning',
            );
        }

        let firstAudioAt = null;
        const result = await player.play(response, {
            rate: Number(cfg.playbackRate) || 1,
            onFirstAudio: () => {
                firstAudioAt = performance.now() - started;
            },
        });

        if (mesId !== null && result.buffer) {
            audioCache.set(mesId, result.buffer);
            updateButton(mesId, 'ready');
        }
        const latency = firstAudioAt === null ? 'n/a' : `${Math.round(firstAudioAt)}ms`;
        // The AudioContext state is part of the log on purpose: a suspended
        // context is the usual reason for "it says it played but I hear
        // nothing", and the browser refuses to start it without a gesture.
        const contextState = audioContext?.state ?? 'none';
        console.info(
            `[S2 TTS] synthesized ${result.duration.toFixed(2)}s @ ${result.sampleRate} Hz` +
            ` (${result.streamed ? 'stream' : 'buffered'}, first audio ${latency}, ctx=${contextState}` +
            `${cache ? `, cache=${cache}` : ''})`,
        );
        return result.duration;
    } catch (error) {
        // A cancelled synthesis is not an error: the user asked for it.
        if (error?.name === 'AbortError') {
            return -1;
        }
        throw error;
    } finally {
        if (mesId !== null) {
            busy.delete(mesId);
        }
    }
}

/**
 * Performs one queued job.
 *
 * Synthesizes the text (or replays an already decoded buffer), reports the
 * state on the message button and says whether audio was scheduled — the
 * queue uses that to decide if it has to wait for the end of the playback.
 *
 * @param {object} job
 * @param {string} [job.text] Text to synthesize.
 * @param {AudioBuffer} [job.buffer] Already decoded audio.
 * @param {number|null} [job.mesId] Message the playback belongs to.
 * @param {boolean} [job.force] Bypass the persistent cache and synthesize again.
 * @param {string} [job.voice] Voice to use instead of the tagged one.
 * @returns {Promise<{duration: number, played: boolean, error?: Error}>}
 */
async function runSpeakJob(job) {
    const mesId = job.mesId ?? null;
    console.info(`[S2 TTS] queue: start (mes=${mesId ?? '-'})`);

    if (mesId !== null) {
        playbackState.set(mesId, 'playing');
        updateButton(mesId, 'loading');
    }

    let duration = -1;
    let played = false;
    let error = null;

    try {
        if (job.buffer) {
            // A replay from the in-memory cache: no synthesis needed.
            player.playBuffer(job.buffer, { rate: Number(settings().playbackRate) || 1 });
            played = true;
            if (mesId !== null) {
                updateButton(mesId, 'playing');
            }
        } else {
            duration = await speakText(job.text, {
                mesId,
                bypassCache: job.force,
                voice: job.voice ?? null,
            });
            played = duration >= 0;
            if (mesId !== null && played) {
                updateButton(mesId, 'playing');
            }
        }
    } catch (err) {
        error = err;
        notify(err.message, 'error');
        if (mesId !== null) {
            updateButton(mesId, 'error');
        }
    }

    return { duration, played, error };
}

/**
 * Puts a message into the read-aloud queue.
 *
 * `interrupt` means "this matters more than whatever is running": the current
 * playback is stopped and everything that is still waiting is dropped. That is
 * what a freshly generated reply does — the user is looking at it now.
 *
 * Without it the item is appended and plays after whatever is already queued.
 *
 * @param {object} item
 * @param {string} [item.text] Text to synthesize.
 * @param {AudioBuffer} [item.buffer] Already decoded audio.
 * @param {number|null} [item.mesId] Message the playback belongs to.
 * @param {boolean} [item.force] Bypass the persistent cache and synthesize again.
 * @param {boolean} [item.interrupt] Stop the current playback and drop the queue.
 * @param {string} [item.voice] Voice to use instead of the tagged one.
 * @returns {Promise<{duration: number, played: boolean}>} Result of the job.
 */
function enqueueSpeak({ text = '', buffer = null, mesId = null, force = false, interrupt = false, voice = null } = {}) {
    if (!text && !buffer) {
        return Promise.resolve({ duration: -1, played: false });
    }

    if (interrupt) {
        stopSpeaking();
    }

    const promise = speakQueue.push({ text, buffer, mesId, force, voice });

    if (mesId !== null) {
        playbackState.set(mesId, 'queued');
        updateButton(mesId, 'queued');
    }

    void speakQueue.drain();
    return promise;
}

/**
 * Stops the playback and empties the queue.
 *
 * @param {object} [options]
 * @param {boolean} [options.clearQueue] Drop the items that are still waiting.
 */
function stopSpeaking({ clearQueue = true } = {}) {
    if (clearQueue) {
        for (const job of speakQueue.items) {
            if (job.mesId !== null && job.mesId !== undefined) {
                playbackState.delete(job.mesId);
                updateButton(job.mesId, 'idle');
            }
        }
        const dropped = speakQueue.clear();
        if (dropped > 0) {
            console.info(`[S2 TTS] queue: dropped ${dropped} job(s)`);
        }
    }
    player.stop();
}

async function speakMessage(mesId, { force = false, bypassCache = false, interrupt = false } = {}) {
    const cfg = settings();
    const context = getContext();
    const message = context.chat?.[mesId];
    if (!message || message.is_system) {
        return -1;
    }
    if (message.is_user && !cfg.narrateUser) {
        return -1;
    }
    if (busy.has(mesId)) {
        return -1;
    }

    const cached = audioCache.get(mesId);
    if (cached && !force) {
        // A replay from the in-memory cache: no synthesis, no server request.
        const result = await enqueueSpeak({ buffer: cached, mesId, interrupt });
        return result?.duration ?? -1;
    }
    // "force" only skips the in-memory copy — a regenerated message reuses the
    // same id and would otherwise play the previous text. The disk cache is
    // keyed by the text itself, so it can still answer an identical text
    // instantly without ever returning the wrong audio.
    const result = await enqueueSpeak({
        text: message.extra?.display_text ?? message.mes ?? '',
        mesId,
        force: bypassCache,
        interrupt,
    });
    return result?.duration ?? -1;
}

/* ------------------------------------------------------------ message UI */

function messageElement(mesId) {
    return document.querySelector(`#chat .mes[mesid="${mesId}"]`);
}

function updateButton(mesId, state) {
    const button = messageElement(mesId)?.querySelector('.st-s2-tts-btn');
    if (!button) {
        return;
    }
    button.classList.remove('st-s2-tts-loading', 'st-s2-tts-ready', 'st-s2-tts-error', 'st-s2-tts-queued', 'st-s2-tts-playing');
    button.classList.remove('fa-spinner', 'fa-volume-high', 'fa-triangle-exclamation', 'fa-stop', 'fa-clock');
    if (state === 'loading') {
        button.classList.add('st-s2-tts-loading');
        button.classList.add('fa-spinner');
        // The synthesis is running and can be cancelled, so the hint says so.
        button.title = t('TitleSynthesizingStop', '正在合成…（点击停止）');
    } else if (state === 'playing') {
        // The button doubles as the stop button while this message plays.
        button.classList.add('st-s2-tts-playing');
        button.classList.add('fa-stop');
        button.title = t('TitleStop', '正在朗读，点击停止');
    } else if (state === 'queued') {
        button.classList.add('st-s2-tts-queued');
        button.classList.add('fa-clock');
        button.title = t('TitleQueued', '排队中，点击取消');
    } else if (state === 'ready') {
        button.classList.add('st-s2-tts-ready');
        button.classList.add('fa-volume-high');
        button.title = t('TitlePlayMessage', '播放这条消息（Shift+点击 = 重新合成）');
    } else if (state === 'error') {
        button.classList.add('st-s2-tts-error');
        button.classList.add('fa-triangle-exclamation');
        button.title = t('TitleFailed', '合成失败，点击重试');
    } else {
        button.classList.add('fa-volume-high');
        button.title = t('TitleSpeak', '朗读这条消息');
    }
}

function ensureButton(mesId, element = null) {
    const cfg = settings();
    if (!cfg.showButton) {
        return;
    }
    const message = element ?? messageElement(mesId);
    const container = message?.querySelector('.mes_buttons');
    if (!container || container.querySelector('.st-s2-tts-btn')) {
        return;
    }
    const button = document.createElement('div');
    button.className = 'mes_button fa-solid fa-volume-high st-s2-tts-btn';
    button.dataset.mesid = String(mesId);
    button.title = t('TitleSpeak', '朗读这条消息');
    container.prepend(button);
}

function removeButtons() {
    document.querySelectorAll('.st-s2-tts-btn').forEach((element) => element.remove());
}

/**
 * Adds the read-aloud button to every message that shows up in the chat.
 *
 * SillyTavern does not emit a render event for the messages that were
 * already in the chat when the page loaded — `printMessages()` renders them
 * silently — so listening to the events alone would leave those messages
 * without a button. Watching the chat element catches every case: the
 * initial render, new replies, swipes and re-renders.
 *
 * `ensureButton()` is idempotent, so a re-rendered message simply gets its
 * button back.
 */
function watchChatForMessages() {
    const chat = document.querySelector('#chat');
    if (!chat) {
        setTimeout(watchChatForMessages, 500);
        return;
    }

    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (!(node instanceof Element)) {
                    continue;
                }
                const messages = node.classList.contains('mes')
                    ? [node]
                    : Array.from(node.querySelectorAll('.mes'));
                for (const message of messages) {
                    // "mesid" is a plain attribute, not a data-* one — it is
                    // therefore not reachable through `dataset`.
                    const mesId = Number(message.getAttribute('mesid'));
                    if (Number.isFinite(mesId)) {
                        ensureButton(mesId, message);
                    }
                }
            }
        }
    });

    observer.observe(chat, { childList: true, subtree: true });

    // The chat may already hold messages when the extension loads — the
    // welcome screen is one of them — so they are picked up right away.
    for (const message of chat.querySelectorAll('.mes')) {
        const mesId = Number(message.getAttribute('mesid'));
        if (Number.isFinite(mesId)) {
            ensureButton(mesId, message);
        }
    }
}

/* ---------------------------------------------------------- settings panel */

/**
 * Reflects the streaming mode in the settings panel.
 *
 * Sentence splitting and streaming pull in opposite directions: the server
 * only pushes audio once it has synthesized a whole sentence, so splitting
 * would undo the streaming. The two controls are therefore greyed out while
 * streaming is on instead of silently ignoring them.
 */
function syncStreamingUi() {
    const streaming = !!settings().streaming;
    $('#s2tts_segment').prop('disabled', streaming);
    $('#s2tts_sentence_pause').prop('disabled', streaming);
    $('#s2tts_stream_buffer').prop('disabled', !streaming);
    $('#s2tts_segment_hint').text(streaming
        ? t('SegmentHintStreaming', '流式播放已自动关闭「服务端按句拆分」——按句合成必须等整句生成完，和流式互相冲突。关掉流式播放即可恢复。')
        : t('SegmentHint', '服务端逐句合成，停顿更自然，但在流式模式下会推迟首个音频。'));
}

/**
 * Shows how much audio the persistent cache holds.
 *
 * The cache lives on the server, so this asks the plugin for the numbers
 * instead of guessing.
 */
async function refreshCacheStats() {
    const state = $('#s2tts_cache_state');
    const dir = $('#s2tts_cache_dir');
    if (!state) {
        return;
    }
    try {
        const result = await api('/cache/stats', {});
        if (!result.available) {
            state.text(t('CacheUnavailable', '服务端没有可用的缓存目录。'));
            state.removeClass('s2tts-status-error');
            dir.text('');
            return;
        }
        const size = (Number(result.bytes ?? 0) / (1024 * 1024)).toFixed(1);
        state.text(t('CacheStats', '缓存：{count} 条 / {size} MB')
            .replace('{count}', result.entries ?? 0)
            .replace('{size}', size));
        state.removeClass('s2tts-status-error');
        dir.text(result.dir ?? '');
    } catch (error) {
        state.text(t('CacheFailed', '读取缓存统计失败：{msg}').replace('{msg}', error.message));
        state.addClass('s2tts-status-error');
    }
}

/* ----------------------------------------------------------- tag panel */

/**
 * Renders the voice tree of the panel.
 *
 * The tree mirrors the folders of the voice directory, so the user sees
 * exactly which tag leads to which profile. Clicking a profile speaks a
 * short test line with it.
 */
/**
 * The dialog that turns a recording into a `.s2voice` profile.
 *
 * s2.cpp can only write a profile from the command line, so the plugin runs
 * `s2.exe --save-voice` for it.
 */
const profileBuilder = createProfileBuilder({
    api,
    notify,
    translate: (key, fallback) => t(key, fallback),
    getSettings: () => settings(),
    getTree: () => voiceTree,
    onSaved: () => {
        void refreshTagPanel();
    },
});

function renderVoiceTree() {
    const container = $('#s2tts_tag_tree');
    if (!container.length) {
        return;
    }
    container.empty();

    if (!voiceTree?.exists) {
        container.append($('<div class="s2tts-hint" />').text(
            t('TagTreeMissing', '找不到音色目录。请先在上方填写音色目录。'),
        ));
        return;
    }

    const entries = (voiceTree.entries ?? []).filter((entry) => entry.classified !== false);
    if (!entries.length) {
        container.append($('<div class="s2tts-hint" />').text(
            t('TagTreeEmpty', '目录里还没有分类音色。按 性别/性格/语气 建三层文件夹，每层放一个 .s2voice 或 .wav 即可（.wav 需要同名的 .txt 逐字转录）。'),
        ));
        return;
    }

    const byPath = new Map(entries.map((entry) => [entry.path, entry]));
    const list = $('<ul class="s2tts-tree-list" />');

    const walk = (node, parent) => {
        for (const child of node.children ?? []) {
            if (child.type === 'dir') {
                const item = $('<li class="s2tts-tree-dir" />');
                item.append($('<span class="s2tts-tree-name" />').text(child.name));
                const sub = $('<ul class="s2tts-tree-list" />');
                item.append(sub);
                parent.append(item);
                walk(child, sub);
                continue;
            }
            const entry = byPath.get(child.path);
            if (!entry) {
                continue;
            }
            const item = $('<li class="s2tts-tree-file" />');
            const link = $('<a class="s2tts-tree-link" />').text(child.stem);
            link.attr('title', entry.rel);
            link.on('click', (event) => {
                event.preventDefault();
                void previewVoiceFile(entry.path);
            });
            item.append(link);
            if (entry.kind === 'audio') {
                // A recording is cloned from the audio itself, so it needs the
                // word-by-word transcript of what was said in it. The
                // transcript lives in the text file next to the recording and
                // can be edited right here.
                const hasTranscript = !!entry.transcript;
                item.addClass('s2tts-tree-audio');
                const badge = $('<span class="s2tts-tree-badge" />').text(hasTranscript
                    ? String(entry.ext ?? '').replace('.', '').toUpperCase()
                    : t('TreeNoTranscript', '缺转录'));
                badge.attr('title', hasTranscript
                    ? entry.transcript
                    : t('TreeNoTranscriptHint', 's2.cpp 需要这段录音的逐字转录才能克隆音色。'));
                item.append(badge);
                if (!hasTranscript) {
                    item.addClass('s2tts-tree-missing');
                }
                const edit = $('<button class="s2tts-tree-edit" type="button" />')
                    .attr('title', t('TreeEditTranscript', '编辑逐字转录'))
                    .text('✎');
                edit.on('click', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    openTranscriptEditor(entry, item);
                });
                item.append(edit);

                // A recording can be turned into a saved profile. The profile
                // is faster to use — it does not have to be encoded again for
                // every single line.
                const archive = $('<button class="s2tts-tree-edit" type="button" />')
                    .attr('title', t('TreeMakeProfile', '生成 .s2voice 档案'))
                    .text('⬇');
                archive.on('click', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    profileBuilder.open(entry);
                });
                item.append(archive);
            }
            parent.append(item);
        }
    };

    walk(voiceTree.tree ?? { children: [] }, list);
    container.append(list);
}

/**
 * Opens the inline editor for the transcript of an audio voice.
 *
 * s2.cpp clones a voice from a reference recording and it insists on a
 * word-by-word transcript of that recording. The transcript is stored in the
 * text file next to the recording, so the voice folder stays complete on its
 * own and the tag based selection can use the voice right away.
 *
 * @param {object} entry The voice tree entry.
 * @param {object} item The list item that holds the voice.
 */
function openTranscriptEditor(entry, item) {
    item.empty();
    const row = $('<div class="s2tts-tree-editor" />');
    const input = $('<input class="text_pole width100p" type="text" />')
        .val(entry.transcript ?? '')
        .attr('placeholder', t('TreeTranscriptPlaceholder', '这段录音念出来的字'));
    const save = $('<button class="s2tts-tree-edit" type="button" />').text(t('TreeTranscriptSave', '保存'));
    const cancel = $('<button class="s2tts-tree-edit" type="button" />').text(t('TreeTranscriptCancel', '取消'));

    const close = () => {
        void refreshTagPanel();
    };

    cancel.on('click', (event) => {
        event.preventDefault();
        close();
    });
    save.on('click', async (event) => {
        event.preventDefault();
        save.prop('disabled', true);
        try {
            await api('/voices/transcript', { voicePath: entry.path, text: input.val() });
            notify(t('TreeTranscriptSaved', '已保存逐字转录。'), 'success');
            close();
        } catch (error) {
            notify(t('TreeTranscriptFailed', '保存转录失败：{msg}').replace('{msg}', error.message), 'error');
            save.prop('disabled', false);
        }
    });
    input.on('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            save.trigger('click');
        } else if (event.key === 'Escape') {
            event.preventDefault();
            close();
        }
    });

    row.append(input, save, cancel);
    item.append(row);
    input.trigger('focus');
}

/**
 * Renders the cheat sheet of the tags that can be used.
 */
function renderTagNames() {
    const container = $('#s2tts_tag_names');
    if (!container.length) {
        return;
    }
    container.empty();

    const known = knownTagNames();
    const groups = [
        { key: 'gender', label: t('TagLevelGender', '性别'), names: known.gender },
        { key: 'personality', label: t('TagLevelPersonality', '性格'), names: known.personality },
        { key: 'tone', label: t('TagLevelTone', '语气'), names: known.tone },
    ];

    for (const group of groups) {
        const row = $('<div class="s2tts-tag-group" />');
        row.append($('<span class="s2tts-tag-level" />').text(group.label));
        const chips = $('<span class="s2tts-tag-chips" />');
        for (const name of group.names) {
            const chip = $('<a class="s2tts-tag-chip" />').text(name);
            chip.on('click', (event) => {
                event.preventDefault();
                insertTagName(name);
            });
            chips.append(chip);
        }
        if (!group.names.size) {
            chips.append($('<span class="s2tts-hint" />').text(t('TagNone', '（没有）')));
        }
        row.append(chips);
        container.append(row);
    }
}

/**
 * Shows which voice the text of the tester would be spoken with.
 */
function updateTagTest() {
    const result = $('#s2tts_tag_test_result');
    const spoken = $('#s2tts_tag_test_text');
    if (!result.length) {
        return;
    }
    const value = String($('#s2tts_tag_test').val() ?? '');
    const parsed = parseTags(value, knownTagNames(), { stripUnknown: true });

    // Whatever the tester says, the text that would really be spoken is
    // shown below it — that is where the reading range shows up.
    const showSpoken = (text) => {
        if (!spoken.length) {
            return;
        }
        const body = String(text ?? '').trim();
        spoken.text(body
            ? t('TagTestText', '朗读内容：{text}').replace('{text}', body)
            : '');
    };

    if (!parsed.block) {
        result.text(t('TagTestNoBlock', '没有检测到标签块。格式：名字·性别·性格·语气·：台词'));
        result.removeClass('s2tts-status-error');
        showSpoken(applyReadRange(value).text);
        return;
    }
    if (!parsed.matched) {
        result.text(t('TagTestUnknown', '标签没有匹配到任何分类：{tags}')
            .replace('{tags}', describeTags(parsed.tags) || '-'));
        result.addClass('s2tts-status-error');
        showSpoken(applyReadRange(parsed.text).text);
        return;
    }

    const resolved = resolveTagVoice(parsed.tags, voiceTree?.entries ?? []);
    if (!resolved) {
        result.text(t('TagTestNoVoice', '标签 {tags} 没有对应的音色，将使用默认音色。')
            .replace('{tags}', describeTags(parsed.tags)));
        result.removeClass('s2tts-status-error');
        showSpoken(applyReadRange(parsed.text).text);
        return;
    }
    result.text(t('TagTestVoice', '将使用音色 {voice}（标签：{tags}）')
        .replace('{voice}', resolved.rel)
        .replace('{tags}', describeTags(parsed.tags)));
    result.removeClass('s2tts-status-error');
    showSpoken(applyReadRange(parsed.text).text);
}

/**
 * Appends a tag to the test line.
 *
 * @param {string} name
 */
function insertTagName(name) {
    const input = document.querySelector('#s2tts_tag_test');
    if (!input) {
        return;
    }
    const value = String(input.value ?? '').trim();
    input.value = value ? `${value}·${name}` : name;
    input.focus();
    updateTagTest();
}

/**
 * Speaks a short test line with a specific voice.
 *
 * @param {string} voicePath Absolute path of the voice file.
 */
async function previewVoiceFile(voicePath) {
    try {
        const entry = (voiceTree?.entries ?? []).find((item) => item.path === voicePath);
        if (entry?.kind === 'audio' && !entry.transcript) {
            // s2.cpp refuses to clone a voice without a transcript, so the
            // request would fail with a message about the server. The user
            // needs to know what to do, and where.
            throw new Error(t('ErrVoiceNoTranscript', '这段录音还没有逐字转录，点它右边的 ✎ 填写后才能克隆音色。'));
        }
        // The preview line is wrapped in the configured range markers, so the
        // preview demonstrates the range instead of quietly falling back to
        // reading everything.
        const line = wrapReadRange(t('TagPreviewText', '你好，这是这个音色的试听。'), settings().readRange);
        await enqueueSpeak({
            text: line,
            voice: voicePath,
            interrupt: true,
        });
    } catch (error) {
        notify(t('ErrSpeakTestFailed', '试听失败：{msg}').replace('{msg}', error.message), 'error');
    }
}

/**
 * Reads the voice tree again and redraws the whole tag section.
 */
async function refreshTagPanel() {
    const dir = $('#s2tts_tag_dir');
    if (dir.length) {
        dir.text(String(settings().voiceDir || ''));
    }
    try {
        await refreshVoiceTree(true);
    } catch {
        /* the panel shows the error in the tree area */
    }
    renderVoiceTree();
    renderTagNames();
    updateTagTest();
}

function bindSettings() {
    const cfg = settings();

    $('#s2tts_server_url').val(cfg.serverUrl).on('change', function () {
        cfg.serverUrl = String(this.value ?? '').trim();
        saveSettingsDebounced();
    });

    $('#s2tts_test').on('click', async function () {
        setStatus(t('StatusConnecting', '连接中…'), 'busy');
        try {
            const result = await api('/status', { s2Url: cfg.serverUrl });
            if (result.reachable && result.isS2) {
                setStatus(t('StatusConnected', '已连接'), 'online');
                notify(t('InfoS2Ready', 's2.cpp 已就绪。'), 'info');
            } else {
                setStatus(t('StatusDisconnected', '未连接'), 'offline');
                notify(result.detail ?? t('WarnS2Unavailable', 's2.cpp 不可用。'), 'warning');
            }
        } catch (error) {
            setStatus(t('StatusDisconnected', '未连接'), 'offline');
            notify(t('ErrConnectFailed', '连接失败：{msg}').replace('{msg}', error.message), 'error');
        }
    });

    $('#s2tts_speak_test').on('click', async function () {
        try {
            // The test playback takes over from whatever is running.
            await enqueueSpeak({ text: '你好，这是一条本地语音合成测试。', interrupt: true });
        } catch (error) {
            notify(t('ErrSpeakTestFailed', '试听失败：{msg}').replace('{msg}', error.message), 'error');
        }
    });

    // voice mode
    const applyMode = () => {
        const mode = document.querySelector('input[name="s2tts_voice_mode"]:checked')?.value ?? 'saved';
        cfg.voiceMode = mode;
        $('#s2tts_saved_block').toggle(mode === 'saved');
        $('#s2tts_reference_block').toggle(mode === 'reference');
        saveSettingsDebounced();
    };
    $(`input[name="s2tts_voice_mode"][value="${cfg.voiceMode}"]`).prop('checked', true);
    $('input[name="s2tts_voice_mode"]').on('change', applyMode);
    applyMode();

    $('#s2tts_voice').on('change', function () {
        cfg.voiceId = String(this.value ?? '');
        saveSettingsDebounced();
    });

    $('#s2tts_refresh_voices').on('click', async function () {
        const directory = String($('#s2tts_voice_dir').val() ?? '').trim();
        cfg.voiceDir = directory;
        saveSettingsDebounced();
        await loadVoiceOptions(directory);
        // The voice tree is the same directory — it may hold a classification
        // that the flat list does not show.
        await refreshTagPanel();
    });

    /**
     * Fills the voice picker with the voices of a directory.
     *
     * @param {string} directory The voice directory.
     * @returns {Promise<void>}
     */
    async function loadVoiceOptions(directory) {
        const select = $('#s2tts_voice');
        select.empty();
        if (!directory) {
            notify(t('WarnNoVoiceDir', '请先填写音色目录。'), 'warning');
            await refreshTagPanel();
            return;
        }
        try {
            const result = await api('/voices', { voiceDir: directory });
            // The picker may hold saved profiles and plain recordings; a
            // recording needs a transcript, which is marked in the label.
            const options = result.voiceOptions ?? [];
            if (!options.length) {
                notify(t('WarnNoVoices', '目录里没有可用音色：{dir}').replace('{dir}', directory), 'warning');
                return;
            }
            for (const option of options) {
                const label = option.kind === 'audio'
                    ? `${option.label}${option.transcript ? '' : t('VoiceNoTranscriptMark', '（缺转录）')}`
                    : option.label;
                select.append($('<option />').val(option.value).text(label));
            }
            const values = options.map((option) => option.value);
            if (cfg.voiceId && values.includes(cfg.voiceId)) {
                select.val(cfg.voiceId);
            } else {
                // A saved profile is the safer default than a recording: it
                // needs no transcript and it is the cheaper one to synthesize.
                const fallback = options.find((option) => option.kind === 'profile') ?? options[0];
                cfg.voiceId = fallback?.value ?? '';
                select.val(cfg.voiceId);
            }
            saveSettingsDebounced();
            notify(t('InfoVoicesLoaded', '已载入 {count} 个音色。').replace('{count}', options.length), 'info');
        } catch (error) {
            notify(t('ErrReadVoices', '读取音色失败：{msg}').replace('{msg}', error.message), 'error');
        }
    }

    $('#s2tts_voice_dir').val(cfg.voiceDir).on('change', function () {
        cfg.voiceDir = String(this.value ?? '').trim();
        saveSettingsDebounced();
        void refreshTagPanel();
    });

    $('#s2tts_ref_file').on('change', function () {
        const file = this.files?.[0];
        if (!file) {
            return;
        }
        const reader = new FileReader();
        reader.onload = () => {
            cfg.referenceDataUrl = String(reader.result ?? '');
            cfg.referenceFilename = file.name;
            $('#s2tts_ref_name').text(file.name);
            saveSettingsDebounced();
        };
        reader.onerror = () => notify(t('ErrReadReference', '读取参考音频失败。'), 'error');
        reader.readAsDataURL(file);
    });

    $('#s2tts_ref_text').val(cfg.referenceText).on('change', function () {
        cfg.referenceText = String(this.value ?? '');
        saveSettingsDebounced();
    });

    // ── tag driven voice selection ──
    $('#s2tts_tag_enabled').prop('checked', !!cfg.tagVoiceEnabled).on('change', function () {
        cfg.tagVoiceEnabled = !!this.checked;
        saveSettingsDebounced();
    });

    $('#s2tts_tag_strip_unknown').prop('checked', !!cfg.tagStripUnknown).on('change', function () {
        cfg.tagStripUnknown = !!this.checked;
        saveSettingsDebounced();
    });

    $('#s2tts_tag_refresh').on('click', async function () {
        await refreshTagPanel();
    });

    $('#s2tts_tag_test').val(cfg.tagTestLine ?? '').on('input', function () {
        cfg.tagTestLine = String(this.value ?? '');
        saveSettingsDebounced();
        updateTagTest();
    });

    $('#s2tts_tag_test_run').on('click', async function () {
        const value = String($('#s2tts_tag_test').val() ?? '').trim();
        if (!value) {
            notify(t('WarnNoMessage', '当前没有可朗读的消息。'), 'warning');
            return;
        }
        try {
            // The tag block in the line picks the voice; the text behind the
            // colon is what is spoken.
            await enqueueSpeak({ text: value, interrupt: true });
        } catch (error) {
            notify(t('ErrSpeakTestFailed', '试听失败：{msg}').replace('{msg}', error.message), 'error');
        }
    });

    const customTags = (selector, key) => {
        $(selector).val(cfg[key]).on('change', function () {
            cfg[key] = String(this.value ?? '');
            saveSettingsDebounced();
            renderTagNames();
            updateTagTest();
        });
    };
    customTags('#s2tts_tag_custom_gender', 'tagCustomGender');
    customTags('#s2tts_tag_custom_personality', 'tagCustomPersonality');
    customTags('#s2tts_tag_custom_tone', 'tagCustomTone');

    void refreshTagPanel();

    // generation parameters
    const number = (selector, key) => {
        $(selector).val(cfg[key]).on('change', function () {
            cfg[key] = Number(this.value);
            saveSettingsDebounced();
        });
    };
    number('#s2tts_temperature', 'temperature');
    number('#s2tts_top_p', 'topP');
    number('#s2tts_top_k', 'topK');
    number('#s2tts_max_tokens', 'maxNewTokens');
    number('#s2tts_sentence_pause', 'sentencePauseMs');
    number('#s2tts_stream_buffer', 'streamStartBufferMs');

    $('#s2tts_streaming').prop('checked', !!cfg.streaming).on('change', function () {
        cfg.streaming = !!this.checked;
        syncStreamingUi();
        saveSettingsDebounced();
    });

    $('#s2tts_segment').prop('checked', cfg.segmentSentences).on('change', function () {
        cfg.segmentSentences = !!this.checked;
        saveSettingsDebounced();
    });

    syncStreamingUi();

    // persistent cache
    $('#s2tts_cache_enabled').prop('checked', !!cfg.cacheEnabled).on('change', function () {
        cfg.cacheEnabled = !!this.checked;
        saveSettingsDebounced();
        refreshCacheStats();
    });

    number('#s2tts_cache_max', 'cacheMaxMb');

    $('#s2tts_cache_refresh').on('click', async function () {
        await refreshCacheStats();
    });

    $('#s2tts_cache_clear').on('click', async function () {
        const state = $('#s2tts_cache_state');
        state.text(t('CacheClearing', '正在清空缓存…'));
        try {
            const result = await api('/cache/clear', {});
            notify(t('CacheCleared', '已清空 {count} 个缓存条目。').replace('{count}', result.removed ?? 0), 'info');
        } catch (error) {
            state.text(t('CacheFailed', '清空缓存失败：{msg}').replace('{msg}', error.message));
            state.addClass('s2tts-status-error');
            return;
        }
        await refreshCacheStats();
    });

    refreshCacheStats();

    // behaviour
    const checkbox = (selector, key, after) => {
        $(selector).prop('checked', !!cfg[key]).on('change', function () {
            cfg[key] = !!this.checked;
            saveSettingsDebounced();
            after?.();
        });
    };
    checkbox('#s2tts_auto_play', 'autoPlay');
    checkbox('#s2tts_narrate_user', 'narrateUser');
    checkbox('#s2tts_show_button', 'showButton', () => {
        if (cfg.showButton) {
            refreshAllButtons();
        } else {
            removeButtons();
        }
    });
    checkbox('#s2tts_strip_tags', 'stripTags');
    checkbox('#s2tts_strip_code', 'stripCode');
    checkbox('#s2tts_strip_asterisks', 'stripAsterisks');

    $('#s2tts_rate').val(cfg.playbackRate).on('input', function () {
        cfg.playbackRate = Number(this.value);
        $('#s2tts_rate_value').text(cfg.playbackRate.toFixed(2));
        saveSettingsDebounced();
    });
    $('#s2tts_rate_value').text(Number(cfg.playbackRate).toFixed(2));

    // reading range
    $('#s2tts_read_range').val(cfg.readRange).on('change', function () {
        cfg.readRange = String(this.value ?? '');
        saveSettingsDebounced();
        // The audio that was already synthesized used the old range, so it
        // must not be replayed as if it were the new one.
        audioCache.clear();
        updateTagTest();
    });

    $('#s2tts_read_range_fallback').prop('checked', !!cfg.readRangeFallback).on('change', function () {
        cfg.readRangeFallback = !!this.checked;
        saveSettingsDebounced();
    });

    // server process
    $('#s2tts_exe').val(cfg.exe).on('change', function () {
        cfg.exe = String(this.value ?? '').trim();
        saveSettingsDebounced();
    });
    $('#s2tts_model').val(cfg.model).on('change', function () {
        cfg.model = String(this.value ?? '').trim();
        saveSettingsDebounced();
    });
    $('#s2tts_tokenizer').val(cfg.tokenizer).on('change', function () {
        cfg.tokenizer = String(this.value ?? '').trim();
        saveSettingsDebounced();
    });
    $('#s2tts_dll_dir').val(cfg.dllDir).on('change', function () {
        cfg.dllDir = String(this.value ?? '').trim();
        saveSettingsDebounced();
    });
    number('#s2tts_cuda', 'cudaDevice');
    number('#s2tts_gpu_layers', 'gpuLayers');
    $('#s2tts_codec').val(cfg.codecBackend).on('change', function () {
        cfg.codecBackend = String(this.value ?? 'auto');
        saveSettingsDebounced();
    });

    $('#s2tts_start_server').on('click', async function () {
        try {
            const result = await api('/start', {
                exe: cfg.exe,
                model: cfg.model,
                tokenizer: cfg.tokenizer,
                voiceDir: cfg.voiceDir,
                dllDir: cfg.dllDir,
                host: cfg.host,
                port: cfg.port,
                cudaDevice: cfg.cudaDevice,
                gpuLayers: cfg.gpuLayers,
                codecBackend: cfg.codecBackend,
            });
            notify(t('InfoServerStarted', 's2.cpp 已启动（PID {pid}）。').replace('{pid}', result.pid), 'info');
        } catch (error) {
            notify(t('ErrStartFailed', '启动失败：{msg}').replace('{msg}', error.message), 'error');
        }
    });

    $('#s2tts_stop_server').on('click', async function () {
        try {
            const result = await api('/stop', {});
            notify(result.message ?? t('InfoServerStopped', '已停止。'), 'info');
        } catch (error) {
            notify(t('ErrStopFailed', '停止失败：{msg}').replace('{msg}', error.message), 'error');
        }
    });

    $('#s2tts_show_logs').on('click', async function () {
        const state = $('#s2tts_log_state');
        const view = $('#s2tts_log_view');
        try {
            const result = await api('/logs', { limit: 120 });
            const lines = Array.isArray(result.lines) ? result.lines : [];
            const warnings = Array.isArray(result.warnings) ? result.warnings : [];
            const parts = [];
            if (warnings.length) {
                parts.push(`── ${t('LogWarnings', '警告')} ──`);
                parts.push(...warnings);
            }
            if (lines.length) {
                parts.push(`── ${t('LogOutput', '输出')} ──`);
                parts.push(...lines);
            }
            view.text(parts.length ? parts.join('\n') : t('LogEmpty', '（没有日志输出）'));
            if (result.encodeFailures > 0) {
                state.text(t('LogEncodeFailures', '参考音频编码失败 {count} 次').replace('{count}', result.encodeFailures));
                state.addClass('s2tts-status-error');
            } else {
                state.text(result.running
                    ? t('LogRunning', 's2.cpp 正在运行')
                    : t('LogNotRunning', 's2.cpp 未由本扩展启动'));
                state.removeClass('s2tts-status-error');
            }
        } catch (error) {
            state.text(t('LogFailed', '读取日志失败：{msg}').replace('{msg}', error.message));
            state.addClass('s2tts-status-error');
        }
    });

    if (cfg.referenceFilename) {
        $('#s2tts_ref_name').text(cfg.referenceFilename);
    }

    // ── settings management ───────────────────────────────────────────
    //
    // SillyTavern saves the extension settings on its own, but there was no
    // way to take them to another installation: the paths of s2.exe, the
    // model, the tokenizer and the voice directory had to be typed in again
    // on every machine. The export writes them into a JSON file and the
    // import reads that file back.

    const settingsState = $('#s2tts_settings_state');

    /**
     * Writes the settings into the panel controls.
     *
     * The settings object and the form are two different places: after an
     * import the form would still show the old values and would write them
     * back on the next change.
     *
     * @param {object} values The settings.
     */
    function fillSettingsForm(values) {
        $('#s2tts_server_url').val(values.serverUrl ?? '');
        $(`input[name="s2tts_voice_mode"][value="${values.voiceMode === 'reference' ? 'reference' : 'saved'}"]`)
            .prop('checked', true);
        $('#s2tts_voice_dir').val(values.voiceDir ?? '');
        $('#s2tts_ref_name').text(values.referenceFilename || t('No file selected', '未选择文件'));
        $('#s2tts_ref_text').val(values.referenceText ?? '');
        $('#s2tts_tag_enabled').prop('checked', !!values.tagVoiceEnabled);
        $('#s2tts_tag_strip_unknown').prop('checked', !!values.tagStripUnknown);
        $('#s2tts_tag_custom_gender').val(values.tagCustomGender ?? '');
        $('#s2tts_tag_custom_personality').val(values.tagCustomPersonality ?? '');
        $('#s2tts_tag_custom_tone').val(values.tagCustomTone ?? '');
        $('#s2tts_tag_test').val(values.tagTestLine ?? '');
        $('#s2tts_temperature').val(values.temperature);
        $('#s2tts_top_p').val(values.topP);
        $('#s2tts_top_k').val(values.topK);
        $('#s2tts_max_tokens').val(values.maxNewTokens);
        $('#s2tts_sentence_pause').val(values.sentencePauseMs);
        $('#s2tts_stream_buffer').val(values.streamStartBufferMs);
        $('#s2tts_streaming').prop('checked', !!values.streaming);
        $('#s2tts_segment').prop('checked', !!values.segmentSentences);
        $('#s2tts_cache_enabled').prop('checked', !!values.cacheEnabled);
        $('#s2tts_cache_max').val(values.cacheMaxMb);
        $('#s2tts_auto_play').prop('checked', !!values.autoPlay);
        $('#s2tts_narrate_user').prop('checked', !!values.narrateUser);
        $('#s2tts_show_button').prop('checked', !!values.showButton);
        $('#s2tts_strip_tags').prop('checked', !!values.stripTags);
        $('#s2tts_strip_code').prop('checked', !!values.stripCode);
        $('#s2tts_strip_asterisks').prop('checked', !!values.stripAsterisks);
        $('#s2tts_rate').val(values.playbackRate);
        $('#s2tts_rate_value').text(Number(values.playbackRate ?? 1).toFixed(2));
        $('#s2tts_read_range').val(values.readRange ?? '');
        $('#s2tts_read_range_fallback').prop('checked', !!values.readRangeFallback);
        $('#s2tts_exe').val(values.exe ?? '');
        $('#s2tts_model').val(values.model ?? '');
        $('#s2tts_tokenizer').val(values.tokenizer ?? '');
        $('#s2tts_dll_dir').val(values.dllDir ?? '');
        $('#s2tts_cuda').val(values.cudaDevice);
        $('#s2tts_gpu_layers').val(values.gpuLayers);
        $('#s2tts_codec').val(values.codecBackend || 'auto');
        // The mode decides which block is shown, the streaming switch has its
        // own row and the tag names are derived from the tag lists.
        applyMode();
        syncStreamingUi();
        renderTagNames();
        updateTagTest();
    }

    $('#s2tts_save_settings').on('click', async function () {
        try {
            await saveSettings();
            settingsState.text(t('SettingsSaved', '设置已保存。'));
            notify(t('SettingsSaved', '设置已保存。'), 'success');
        } catch (error) {
            notify(t('SettingsSaveFailed', '保存失败：{msg}').replace('{msg}', error.message), 'error');
        }
    });

    $('#s2tts_export_settings').on('click', function () {
        try {
            const payload = {
                format: 's2tts-settings',
                version: 1,
                exportedAt: new Date().toISOString(),
                settings: { ...cfg },
            };
            const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `s2tts-settings-${new Date().toISOString().slice(0, 10)}.json`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 2000);
            settingsState.text(t('SettingsExported', '设置已导出为文件。'));
            notify(t('SettingsExported', '设置已导出为文件。'), 'success');
        } catch (error) {
            notify(t('SettingsExportFailed', '导出失败：{msg}').replace('{msg}', error.message), 'error');
        }
    });

    $('#s2tts_import_settings').on('click', function () {
        $('#s2tts_import_file').click();
    });

    $('#s2tts_import_file').on('change', async function () {
        const file = this.files?.[0];
        // The same file may be imported again, so the input is cleared.
        this.value = '';
        if (!file) {
            return;
        }
        try {
            const parsed = JSON.parse(await file.text());
            const incoming = parsed?.settings ?? parsed;
            if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
                throw new Error(t('SettingsImportBadFile', '这个文件里没有设置。'));
            }
            // Only the known keys are taken, so a file from another plugin
            // cannot put anything strange into the settings.
            let count = 0;
            for (const [key, value] of Object.entries(incoming)) {
                if (key in DEFAULTS) {
                    cfg[key] = value;
                    count++;
                }
            }
            if (!count) {
                throw new Error(t('SettingsImportBadFile', '这个文件里没有设置。'));
            }
            fillSettingsForm(cfg);
            await saveSettings();
            // The voice of the old machine may not exist here, so the picker
            // is filled again and picks a local one.
            if (cfg.voiceDir) {
                await loadVoiceOptions(cfg.voiceDir);
            }
            await refreshTagPanel();
            settingsState.text(t('SettingsImported', '已导入 {count} 项设置。').replace('{count}', String(count)));
            notify(t('SettingsImported', '已导入 {count} 项设置。').replace('{count}', String(count)), 'success');
        } catch (error) {
            notify(t('SettingsImportFailed', '导入失败：{msg}').replace('{msg}', error.message), 'error');
        }
    });
}

function refreshAllButtons() {
    const context = getContext();
    const list = context.chat ?? [];
    for (let index = 0; index < list.length; index++) {
        ensureButton(index);
    }
}

/* -------------------------------------------------------------- lifecycle */

/** Loads the locale file matching the current UI language. */
async function loadTranslations() {
    const locale = String(getCurrentLocale?.() ?? 'en').toLowerCase();
    const file = LOCALE_FILES[locale] ?? LOCALE_FILES[locale.split('-')[0]] ?? 'locales/en.json';
    try {
        const response = await fetch(new URL(file, EXTENSION_URL));
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        return await response.json();
    } catch (error) {
        console.warn('[S2 TTS] Failed to load the locale file:', error);
        return {};
    }
}

/**
 * Applies translations to the rendered panel.
 *
 * `data-i18n` holds the English source string; "[attr]key" targets an
 * attribute instead of the text content.
 */
function applyTranslations(root, translations) {
    root.querySelectorAll('[data-i18n]').forEach((element) => {
        for (const raw of element.getAttribute('data-i18n').split(';')) {
            const attribute = raw.match(/\[(\S+)\](.+)/);
            const key = attribute ? attribute[2] : raw;
            const value = translations[key];
            if (value === undefined) {
                continue;
            }
            if (attribute) {
                element.setAttribute(attribute[1], value);
            } else {
                element.textContent = value;
            }
            break;
        }
    });
}

export async function init() {
    if (initialized) {
        return;
    }
    initialized = true;
    const cfg = settings();

    // Unlock the AudioContext on the first user gesture so auto-play works.
    document.addEventListener('click', unlockAudio, { once: true, capture: true });
    document.addEventListener('keydown', unlockAudio, { once: true, capture: true });

    const translations = await loadTranslations();
    I18N = translations ?? {};
    // localize=false: the panel is translated by applyTranslations() below so
    // the result does not depend on when ST merges the global locale data.
    const html = await renderExtensionTemplateAsync(EXTENSION_NAME, 'settings', {}, true, false);
    const container = $('<div />')
        .addClass('extension_container')
        .attr('id', 's2tts_container')
        .html(html);
    $('#extensions_settings').append(container);
    applyTranslations(container[0], translations);

    bindSettings();

    // Per-message button. Plain click replays the cached audio, Shift+click
    // forces a fresh synthesis. While a message is playing its button turns
    // into a stop button, and a queued message can be taken out of the queue
    // the same way.
    $(document).on('click', '.st-s2-tts-btn', async function (event) {
        event.preventDefault();
        event.stopPropagation();
        const mesId = Number(this.dataset.mesid);
        if (!Number.isFinite(mesId)) {
            return;
        }

        const state = playbackState.get(mesId);
        if (state === 'playing') {
            // Stop this message but keep the rest of the queue.
            player.stop();
            return;
        }
        if (state === 'queued') {
            // Take this message out of the queue.
            const dropped = speakQueue.remove((job) => job.mesId === mesId);
            playbackState.delete(mesId);
            updateButton(mesId, 'idle');
            if (dropped > 0) {
                console.info(`[S2 TTS] queue: cancelled (mes=${mesId})`);
            }
            return;
        }

        try {
            // Shift+click = "I want it again": skip the in-memory copy and
            // the persistent cache, so the text is synthesized from scratch.
            await speakMessage(mesId, { force: event.shiftKey, bypassCache: event.shiftKey });
        } catch (error) {
            updateButton(mesId, 'error');
            notify(error.message, 'error');
        }
    });

    // Make sure every message gets a button.
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (mesId) => {
        ensureButton(Number(mesId));
    });
    eventSource.on(event_types.USER_MESSAGE_RENDERED, (mesId) => {
        ensureButton(Number(mesId));
    });

    // Auto-play the freshly generated reply.
    eventSource.on(event_types.GENERATION_STARTED, () => {
        // A regeneration reuses the same message id, so forget the guard.
        lastAutoSpokenId = -1;
        // A new reply is on its way. Whatever is being read right now is
        // stale — the user is waiting for the new text, not for the old
        // voice. Stopping here also keeps the old audio from talking over
        // the whole generation.
        stopSpeaking();
    });

    // The user sent a message: stop reading, they clearly want to talk.
    eventSource.on(event_types.MESSAGE_SENT, () => {
        stopSpeaking();
    });

    eventSource.on(event_types.GENERATION_ENDED, async () => {
        if (!cfg.autoPlay) {
            return;
        }
        const context = getContext();
        const mesId = (context.chat?.length ?? 0) - 1;
        if (mesId < 0 || mesId === lastAutoSpokenId) {
            return;
        }
        const message = context.chat[mesId];
        if (!message || message.is_user || message.is_system) {
            return;
        }
        lastAutoSpokenId = mesId;
        try {
            // interrupt: the new reply takes over. Whatever was queued or
            // playing is dropped, so the two never talk over each other.
            await speakMessage(mesId, { force: true, interrupt: true });
        } catch (error) {
            updateButton(mesId, 'error');
            notify(error.message, 'error');
        }
    });

    // A swipe replaces the text — drop the stale audio.
    eventSource.on(event_types.MESSAGE_SWIPED, (mesId) => {
        const id = Number(mesId);
        audioCache.delete(id);
        updateButton(id, 'idle');
        if (playbackState.has(id)) {
            stopSpeaking();
        }
    });

    eventSource.on(event_types.MESSAGE_DELETED, (mesId) => {
        const id = Number(mesId);
        audioCache.delete(id);
        if (playbackState.has(id)) {
            stopSpeaking();
        }
    });

    eventSource.on(event_types.CHAT_CHANGED, () => {
        audioCache.clear();
        lastAutoSpokenId = -1;
        // The old chat is gone; its audio must not keep playing.
        stopSpeaking();
        setTimeout(refreshAllButtons, 100);
    });

    // Slash command: /s2tts [text]
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 's2tts',
        callback: async (args, value) => {
            const text = String(value ?? '').trim();
            try {
                if (text) {
                    // An explicit "read this" takes over from whatever is
                    // running right now.
                    await enqueueSpeak({ text, interrupt: true });
                } else {
                    const context = getContext();
                    const mesId = (context.chat?.length ?? 0) - 1;
                    if (mesId < 0) {
                        notify(t('WarnNoMessage', '当前没有可朗读的消息。'), 'warning');
                        return '';
                    }
                    await speakMessage(mesId, { force: true });
                }
            } catch (error) {
                notify(error.message, 'error');
            }
            return '';
        },
        help: t('SlashCommandHelp', '用本地 s2.cpp 朗读文本或最后一条回复。'),
    }));

    // Buttons for messages that already exist, and for every message that
    // shows up later on.
    setTimeout(refreshAllButtons, 300);
    watchChatForMessages();

    console.info('[S2 TTS] extension loaded. Server plugin expected at', PLUGIN_BASE);
}
