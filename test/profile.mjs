/**
 * Unit tests for the profile creation helpers.
 *
 * Two groups:
 *   - plugin/profile.js  : the s2.cpp command line and the id rules
 *   - profile.js: the waveform and the WAV encoder
 */
import assert from 'node:assert/strict';

import {
    buildSaveArgs,
    detectError,
    detectStage,
    isValidVoiceId,
    sanitizeVoiceId,
} from '../plugin/profile.js';
import {
    buildPeaks,
    buildWavFile,
    clampRange,
    encodeRange,
    formatSeconds,
    toBase64,
} from '../profile.js';

let passed = 0;
let failed = 0;

function check(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  PASS  ${name}`);
    } catch (error) {
        failed++;
        console.log(`  FAIL  ${name} — ${error?.message ?? error}`);
    }
}

/** A stand-in for an AudioBuffer. */
function fakeBuffer(channels, length, sampleRate = 44100) {
    const data = channels.map((values) => Float32Array.from(values));
    return {
        numberOfChannels: channels.length,
        length,
        sampleRate,
        duration: length / sampleRate,
        getChannelData: (index) => data[index],
    };
}

console.log('\n[voice id]');

check('a plain name is kept', () => {
    assert.equal(sanitizeVoiceId('温柔'), '温柔');
});

check('a path separator cannot escape the voice directory', () => {
    // The separator is replaced, so the id can no longer point somewhere else.
    assert.equal(sanitizeVoiceId('../evil'), '.._evil');
    assert.ok(!sanitizeVoiceId('a/b').includes('/'));
    assert.ok(!sanitizeVoiceId('a\\b').includes('\\'));
});

check('a name that is only dots does not survive', () => {
    assert.equal(sanitizeVoiceId('..'), '');
    assert.equal(sanitizeVoiceId('.'), '');
});

check('a name with a slash is rejected as-is', () => {
    assert.equal(isValidVoiceId('a/b'), false);
    assert.equal(isValidVoiceId('温柔'), true);
});

check('the reserved windows names are escaped', () => {
    assert.equal(sanitizeVoiceId('con'), 'con_');
    assert.equal(sanitizeVoiceId('LPT1'), 'LPT1_');
});

check('a trailing dot is removed', () => {
    assert.equal(sanitizeVoiceId('温柔.'), '温柔');
});

check('an empty id stays empty', () => {
    assert.equal(sanitizeVoiceId('   '), '');
    assert.equal(isValidVoiceId(''), false);
});

console.log('\n[save command line]');

const baseArgs = {
    model: 'F:/model.gguf',
    tokenizer: 'F:/tokenizer.json',
    promptAudio: 'F:/ref.wav',
    promptText: 'hello there',
    voiceId: '温柔',
    voiceDir: 'F:/voices',
    output: 'F:/out.wav',
};

check('the profile is saved', () => {
    const args = buildSaveArgs(baseArgs);
    assert.ok(args.includes('--save-voice'));
    assert.equal(args[args.indexOf('--voice') + 1], '温柔');
    assert.equal(args[args.indexOf('--voice-dir') + 1], 'F:/voices');
    assert.equal(args[args.indexOf('--prompt-audio') + 1], 'F:/ref.wav');
    assert.equal(args[args.indexOf('--prompt-text') + 1], 'hello there');
});

check('the model and the tokenizer are passed on', () => {
    const args = buildSaveArgs(baseArgs);
    assert.equal(args[args.indexOf('--model') + 1], 'F:/model.gguf');
    assert.equal(args[args.indexOf('--tokenizer') + 1], 'F:/tokenizer.json');
});

check('the codec benchmark is skipped', () => {
    const args = buildSaveArgs({ ...baseArgs, cudaDevice: 0 });
    assert.ok(!args.includes('--codec-auto'));
    assert.ok(args.includes('--codec-follow-backend'));
});

check('without a gpu the codec runs on the cpu', () => {
    const args = buildSaveArgs({ ...baseArgs, cudaDevice: -1 });
    assert.ok(args.includes('--codec-cpu'));
    assert.ok(!args.includes('--codec-follow-backend'));
});

check('the transformer stays on the cpu', () => {
    const args = buildSaveArgs(baseArgs);
    assert.equal(args[args.indexOf('--gpu-layers') + 1], '0');
});

console.log('\n[log reading]');

check('the stages are found', () => {
    assert.equal(detectStage('--- Pipeline Init ---'), 'loading');
    assert.equal(detectStage('Loading reference audio: F:/ref.wav'), 'encoding');
    assert.equal(detectStage('Saved voice profile: sao'), 'saved');
    assert.equal(detectStage('some other line'), null);
});

check('a failed encode is reported', () => {
    assert.match(detectError('Pipeline warning: encode failed, running without reference audio.'), /编码失败/);
});

check('an out of memory is reported', () => {
    assert.match(detectError('ggml_backend_cuda_buffer_type_alloc_buffer: cudaMalloc failed: out of memory'), /显存不足/);
});

check('a missing argument is reported', () => {
    assert.match(detectError('Error: --save-voice requires both --prompt-audio and --prompt-text.'), /requires/);
});

check('a normal line is not an error', () => {
    assert.equal(detectError('[Model] Layers: 36'), null);
    assert.equal(detectError(''), null);
});

console.log('\n[waveform]');

check('the peaks carry the loudest sample of every bucket', () => {
    // Two buckets over four samples: [0, 0.5] and [-1, 0.25].
    const buffer = fakeBuffer([[0, 0.5, -1, 0.25]], 4, 44100);
    const peaks = buildPeaks(buffer, 2);
    assert.equal(peaks.length, 2);
    assert.equal(peaks[0], 0.5);
    assert.equal(peaks[1], 1);
});

check('an empty recording does not break', () => {
    const peaks = buildPeaks(fakeBuffer([[]], 0), 8);
    assert.equal(peaks.length, 8);
    assert.ok(peaks.every((peak) => peak === 0));
});

console.log('\n[wav encoder]');

check('the file starts with a RIFF header', () => {
    const file = buildWavFile(44100, new Uint8Array(4));
    assert.equal(String.fromCharCode(...file.subarray(0, 4)), 'RIFF');
    assert.equal(String.fromCharCode(...file.subarray(8, 12)), 'WAVE');
    assert.equal(file.length, 48);
});

check('the header describes 16 bit mono pcm', () => {
    const file = buildWavFile(44100, new Uint8Array(4));
    const view = new DataView(file.buffer);
    assert.equal(view.getUint16(20, true), 1); // PCM
    assert.equal(view.getUint16(22, true), 1); // mono
    assert.equal(view.getUint32(24, true), 44100);
    assert.equal(view.getUint16(34, true), 16);
});

check('the data length is written correctly', () => {
    const pcm = new Uint8Array(400);
    const file = buildWavFile(44100, pcm);
    const view = new DataView(file.buffer);
    assert.equal(view.getUint32(40, true), 400);
    assert.equal(view.getUint32(4, true), 36 + 400);
});

check('a range is cut out of the recording', () => {
    // 1 second of audio at 44100 Hz.
    const samples = new Float32Array(44100).fill(0.5);
    const buffer = fakeBuffer([samples], 44100, 44100);
    const encoded = encodeRange(buffer, 0.25, 0.5);
    assert.equal(encoded.frames, Math.round(0.25 * 44100));
    assert.equal(encoded.bytes.length, 44 + encoded.frames * 2);
    assert.ok(Math.abs(encoded.duration - 0.25) < 0.001);
});

check('two channels are mixed down to one', () => {
    const left = new Float32Array(100).fill(1);
    const right = new Float32Array(100).fill(0);
    const buffer = fakeBuffer([left, right], 100, 44100);
    const encoded = encodeRange(buffer, 0, 1);
    const view = new DataView(encoded.bytes.buffer, 44);
    const sample = view.getInt16(0, true);
    // The average of 1 and 0 is 0.5.
    assert.ok(Math.abs(sample - 16383) < 4, `got ${sample}`);
});

check('the values stay inside the 16 bit range', () => {
    // 4 and 2 average out to 3, which is clamped to the positive maximum.
    const loud = new Float32Array(10).fill(4);
    const quiet = new Float32Array(10).fill(2);
    const buffer = fakeBuffer([loud, quiet], 10, 44100);
    const encoded = encodeRange(buffer, 0, 1);
    const view = new DataView(encoded.bytes.buffer, 44);
    assert.equal(view.getInt16(0, true), 32767);

    // And the other way round.
    const soft = new Float32Array(10).fill(-4);
    const softer = new Float32Array(10).fill(-2);
    const negative = encodeRange(fakeBuffer([soft, softer], 10, 44100), 0, 1);
    const negativeView = new DataView(negative.bytes.buffer, 44);
    assert.equal(negativeView.getInt16(0, true), -32768);
});

console.log('\n[range]');

check('the range is kept inside the recording', () => {
    assert.deepEqual(clampRange(-5, 30, 10), { start: 0, end: 10 });
    assert.deepEqual(clampRange(2, 5, 10), { start: 2, end: 5 });
});

check('a backwards range is swapped', () => {
    assert.deepEqual(clampRange(8, 3, 10), { start: 3, end: 8 });
});

console.log('\n[formatting]');

check('seconds are shown with two decimals', () => {
    assert.equal(formatSeconds(3.456), '3.46');
    assert.equal(formatSeconds(0), '0.00');
});

check('longer recordings use minutes', () => {
    assert.equal(formatSeconds(62.5), '1:02.5');
});

console.log('\n[base64]');

check('bytes survive the round trip', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    const encoded = toBase64(bytes);
    const decoded = Buffer.from(encoded, 'base64');
    assert.deepEqual([...decoded], [...bytes]);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
