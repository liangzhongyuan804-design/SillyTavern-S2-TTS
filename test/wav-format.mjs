/**
 * Determines which WAV format s2.cpp returns for different request shapes.
 *
 *   node test/wav-format.mjs
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
const router = {
    post(route, handler) { handlers.set(`POST ${route}`, handler); },
    get(route, handler) { handlers.set(`GET ${route}`, handler); },
};

function makeRes() {
    return {
        statusCode: 200,
        headers: {},
        body: null,
        setHeader(k, v) { this.headers[k] = v; return this; },
        status(c) { this.statusCode = c; return this; },
        json(p) { this.body = p; return this; },
        send(p) { this.body = p; return this; },
    };
}

async function call(route, body) {
    const res = makeRes();
    await handlers.get(route)({ body: body ?? {} }, res);
    return res;
}

function describe(buffer) {
    const fmtTag = buffer.readUInt16LE(20);
    const channels = buffer.readUInt16LE(22);
    const rate = buffer.readUInt32LE(24);
    const bits = buffer.readUInt16LE(34);
    const bytesPerSample = bits / 8;
    const samples = Math.floor((buffer.length - 44) / bytesPerSample);
    let peak = 0;
    for (let i = 0; i < samples; i++) {
        let value;
        if (fmtTag === 3) {
            value = buffer.readFloatLE(44 + i * 4);
        } else if (bits === 16) {
            value = buffer.readInt16LE(44 + i * 2) / 32768;
        } else {
            value = buffer.readInt32LE(44 + i * 4) / 2147483648;
        }
        peak = Math.max(peak, Math.abs(value));
    }
    return {
        fmtTag,
        bits,
        channels,
        rate,
        seconds: (samples / channels / rate).toFixed(2),
        peak: peak.toFixed(4),
        bytes: buffer.length,
    };
}

await init(router);

const start = await call('POST /start', {
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
console.log('start:', JSON.stringify(start.body));

for (let i = 0; i < 120; i++) {
    const status = await call('POST /status', { s2Url: S2_URL });
    if (status.body.reachable && status.body.isS2) {
        console.log(`ready after ${i}s -> ${status.body.detail}`);
        break;
    }
    await new Promise((r) => setTimeout(r, 1000));
}

const shapes = [
    { label: 'stream=true,  segment_sentences=true ', params: { stream: true, segment_sentences: true } },
    { label: 'stream=true,  segment_sentences=false', params: { stream: true, segment_sentences: false } },
    { label: 'stream=false, segment_sentences=false', params: { stream: false, segment_sentences: false } },
    { label: 'stream=false, segment_sentences=true ', params: { stream: false, segment_sentences: true } },
    { label: 'no params at all                   ', params: {} },
];

for (const shape of shapes) {
    const res = await call('POST /generate', {
        s2Url: S2_URL,
        text: '格式测试。',
        params: {
            ...shape.params,
            max_new_tokens: 512,
            temperature: 0.58,
            top_p: 0.88,
            top_k: 40,
        },
    });
    if (res.statusCode !== 200) {
        console.log(`${shape.label} -> HTTP ${res.statusCode} ${JSON.stringify(res.body).slice(0, 200)}`);
        continue;
    }
    const info = describe(Buffer.from(res.body));
    console.log(`${shape.label} -> fmtTag=${info.fmtTag} bits=${info.bits} ch=${info.channels} rate=${info.rate} ${info.seconds}s peak=${info.peak} bytes=${info.bytes}`);
}

await call('POST /stop', {});
await exit();
