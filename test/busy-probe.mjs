/**
 * Probe: replays the cache test sequence and dumps the s2.cpp log.
 *
 * The end-to-end suite occasionally sees s2.cpp answer 503 ("busy") for a
 * long time right after a cached request. This probe replays the same
 * sequence with the timing printed and the engine log attached, so the
 * cause becomes visible.
 *
 *   node test/busy-probe.mjs
 */
import { init, exit } from '../plugin/index.js';

const EXE = process.env.S2TTS_EXE ?? 'F:\\s2\\s2.cpp\\build\\Debug\\s2.exe';
const MODEL = process.env.S2TTS_MODEL ?? 'F:\\s2\\s2.cpp\\models\\s2-pro-q8_0.gguf';
const TOKENIZER = process.env.S2TTS_TOKENIZER ?? 'F:\\s2\\s2.cpp\\tokenizer.json';
const VOICE_DIR = process.env.S2TTS_VOICE_DIR ?? 'F:\\s2\\s2.cpp\\voices';
const DLL_DIR = process.env.S2TTS_DLL_DIR ?? 'F:\\s2\\bin\\x64';
const PORT = Number(process.env.S2TTS_PORT ?? 3030);
const S2_URL = `http://127.0.0.1:${PORT}`;

const handlers = new Map();
await init({
    post(route, handler) {
        handlers.set(route, handler);
    },
    get(route, handler) {
        handlers.set(route, handler);
    },
});

async function call(route, body) {
    const handler = handlers.get(route);
    if (!handler) {
        throw new Error(`no handler for ${route}`);
    }
    const res = {
        statusCode: 200,
        headers: {},
        body: null,
        finished: false,
        ended: false,
        headersSent: false,
        writableEnded: false,
        chunks: [],
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
            this.chunks.push(Buffer.from(chunk));
            return true;
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
        on() {
            return this;
        },
        once() {
            return this;
        },
    };
    await handler({ body: body ?? {} }, res);
    return res;
}

console.log('starting s2.cpp…');
await call('/start', {
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

for (let i = 0; i < 120; i++) {
    const res = await call('/status', { s2Url: S2_URL });
    if (res.body.reachable && res.body.isS2) {
        console.log(`server ready after ${i}s`);
        break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
}

const params = {
    stream: true,
    chunked: true,
    output_format: 'pcm_s16le',
    stream_start_buffer_ms: 200,
    stream_holdback_frames: 0,
    segment_sentences: false,
    max_new_tokens: 1024,
};

const text = '持久化缓存的重复请求测试。';

async function synthesize(label, body) {
    const started = Date.now();
    const res = await call('/generate', {
        s2Url: S2_URL,
        relay: 'stream',
        params,
        cacheEnabled: true,
        ...body,
    });
    const bytes = res.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    console.log(`${label}: status=${res.statusCode} cache=${res.headers['X-S2-Cache'] ?? '-'} bytes=${bytes} in ${Date.now() - started} ms`);
    return res;
}

await synthesize('1 first (miss)   ', { text });
await synthesize('2 repeat (hit)   ', { text });
await synthesize('3 other (miss)   ', { text: `${text}换个内容` });
await synthesize('4 bypass (miss)  ', { text, bypassCache: true });
await synthesize('5 disabled (miss)', { text, cacheEnabled: false });

console.log('\n--- engine log (tail) ---');
const logs = await call('/logs', { limit: 80 });
console.log((logs.body.lines ?? []).slice(-50).join('\n'));

await exit();
