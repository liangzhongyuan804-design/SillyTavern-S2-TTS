/**
 * Direct probe of the s2.cpp streaming endpoint.
 *
 * Bypasses the SillyTavern plugin entirely so the arrival times of the
 * individual chunks show whether the *engine* really streams or whether
 * something in the middle buffers the response.
 *
 *   node test/stream-probe.mjs
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const S2 = process.env.S2TTS_S2_URL ?? 'http://127.0.0.1:3030';
const SHORT = process.env.S2TTS_SHORT_REFERENCE ?? path.join(HERE, 'short-reference.wav');

/**
 * The interesting knob: s2.cpp keeps the trailing codec frames buffered until
 * they are "stable". With the default holdback (the codec's whole history
 * window) nothing is emitted until the very last frame, so the response looks
 * buffered no matter what the transport does.
 */
const CONFIGS = [
    {
        name: 'default (holdback = codec history)',
        params: {},
    },
    {
        name: 'holdback 0',
        params: { stream_holdback_frames: 0 },
    },
    {
        name: 'holdback 0 + stride 1',
        params: { stream_holdback_frames: 0, stream_decode_stride_frames: 1 },
    },
    {
        name: 'low_latency preset',
        params: { low_latency: true },
    },
];

const baseParams = {
    stream: true,
    chunked: true,
    output_format: 'pcm_s16le',
    stream_start_buffer_ms: 200,
    segment_sentences: false,
    max_new_tokens: 2048,
    temperature: 0.58,
    top_p: 0.88,
    top_k: 40,
};

for (const config of CONFIGS) {
    const params = { ...baseParams, ...config.params };

    const form = new FormData();
    form.append('text', '这是一段用来验证流式播放的测试语音。');
    form.append('params', JSON.stringify(params));
    if (process.env.S2TTS_WITH_REFERENCE) {
        form.append('reference', new Blob([readFileSync(SHORT)], { type: 'audio/wav' }), 'short-reference.wav');
        form.append('reference_text', '一段短的参考音频转录。');
    }

    console.log('\n============================================================');
    console.log(`config: ${config.name}`);
    console.log(`params: ${JSON.stringify(config.params)}`);

    const t0 = Date.now();
    const response = await fetch(`${S2}/generate`, { method: 'POST', body: form });

    if (!response.ok) {
        console.log(`status ${response.status}: ${(await response.text()).slice(0, 200)}`);
        continue;
    }

    const reader = response.body.getReader();
    const arrivals = [];
    let total = 0;
    for (;;) {
        const { value, done } = await reader.read();
        if (done) {
            break;
        }
        total += value.byteLength;
        arrivals.push({ at: Date.now() - t0, bytes: value.byteLength });
    }

    const finished = Date.now() - t0;
    const first = arrivals[0]?.at ?? finished;
    console.log(`content-type : ${response.headers.get('content-type')}`);
    console.log(`encoding     : ${response.headers.get('x-audio-encoding')}`);
    console.log(`chunks       : ${arrivals.length}, ${total} bytes`);
    console.log(`first chunk  : ${first} ms`);
    console.log(`finished     : ${finished} ms`);
    console.log(`timeline     : ${arrivals.map((a) => `${a.at}ms/${a.bytes}B`).join('  ')}`);
    const spread = (arrivals[arrivals.length - 1]?.at ?? 0) - first;
    console.log(spread > 500
        ? '=> really streaming.'
        : '=> buffered until the end.');
}

