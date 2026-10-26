/**
 * Does the reference audio actually reach the encoder?
 *
 * s2.cpp prints "Prefilling N tokens" where N includes the reference prompt
 * codes. Comparing that number with and without a reference tells us whether
 * the clone was really applied — the "ref_encode" metric is 0 on the
 * segmented path because the reference is encoded before segmentation.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ST = process.env.S2TTS_ST ?? 'http://127.0.0.1:8000';
const SHORT = process.env.S2TTS_SHORT_REFERENCE ?? path.join(HERE, 'short-reference.wav');
const LONG = 'F:\\s2\\s2.cpp\\voices\\sao.wav';

const csrfResponse = await fetch(`${ST}/csrf-token`);
const cookie = (csrfResponse.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
const token = (await csrfResponse.json()).token;
const headers = {
    'Content-Type': 'application/json',
    'X-CSRF-Token': token,
    ...(cookie ? { Cookie: cookie } : {}),
};

async function call(route, body) {
    const response = await fetch(`${ST}/api/plugins/st-s2-tts${route}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });
    return response;
}

async function logs() {
    const response = await call('/logs', { limit: 400 });
    return (await response.json()).lines ?? [];
}

const params = { stream: true, segment_sentences: true, max_new_tokens: 1024 };

async function run(label, extra) {
    const before = await logs();
    const response = await call('/generate', {
        s2Url: 'http://127.0.0.1:3030',
        text: '今天天气不错。',
        params,
        ...extra,
    });
    const after = await logs();
    const fresh = after.slice(before.length);
    const prefill = fresh.find((line) => /Prefilling \d+ tokens/.test(line)) ?? '(none)';
    const metrics = fresh.find((line) => /\[Metrics\]/.test(line)) ?? '(none)';
    const failed = fresh.some((line) => /encode failed/i.test(line));
    console.log(`\n[${label}] status=${response.status} encodeFailed=${failed}`);
    console.log(`  ${prefill}`);
    console.log(`  ${metrics.slice(0, 220)}`);
    return { prefill, failed };
}

const shortBase64 = readFileSync(SHORT).toString('base64');
const longBase64 = readFileSync(LONG).toString('base64');

const noRef = await run('no reference', {});
const withShort = await run('short reference', {
    referenceBase64: shortBase64,
    referenceFilename: path.basename(SHORT),
    referenceText: '一段短的参考音频转录。',
});
const withLong = await run('long reference (673 s)', {
    referenceBase64: longBase64,
    referenceFilename: path.basename(LONG),
    referenceText: '一段很长的参考音频转录。',
});

const tokens = (line) => Number(/Prefilling (\d+) tokens/.exec(line)?.[1] ?? -1);
console.log('\n================ conclusion ================');
console.log(`prefill tokens  no-ref=${tokens(noRef.prefill)}  short-ref=${tokens(withShort.prefill)}  long-ref=${tokens(withLong.prefill)}`);
console.log(`short reference applied: ${tokens(withShort.prefill) > tokens(noRef.prefill) ? 'YES' : 'NO'}`);
console.log(`long reference applied: ${tokens(withLong.prefill) > tokens(noRef.prefill) ? 'YES' : 'NO (encoder OOM, expected)'}`);
