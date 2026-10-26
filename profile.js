/**
 * Helpers for the "turn a recording into a .s2voice profile" dialog.
 *
 * The heavy lifting happens in the browser: the recording is decoded with the
 * Web Audio API, cut down to the chosen range and written back as a plain
 * 16 bit PCM WAV. s2.cpp then encodes that file into a profile.
 *
 * The functions below are deliberately free of any DOM access so they can be
 * tested with a fake audio buffer.
 */

/** The sample rate s2.cpp's codec works with. */
export const TARGET_SAMPLE_RATE = 44100;

/**
 * Reduces the audio to one peak value per bucket, for the waveform.
 *
 * @param {object} audioBuffer An AudioBuffer (or anything with the same shape).
 * @param {number} [buckets] How many peaks are computed.
 * @returns {Float32Array} The peaks, between 0 and 1.
 */
export function buildPeaks(audioBuffer, buckets = 480) {
    const channels = Math.max(1, audioBuffer?.numberOfChannels ?? 1);
    const length = Math.max(0, audioBuffer?.length ?? 0);
    // An empty recording still gets the full number of buckets, so the
    // caller does not have to special case it.
    const count = length ? Math.max(1, Math.min(buckets, length)) : Math.max(1, buckets);
    const peaks = new Float32Array(count);
    if (!length) {
        return peaks;
    }
    const data = [];
    for (let c = 0; c < channels; c++) {
        data.push(audioBuffer.getChannelData(c));
    }
    const per = length / count;
    for (let b = 0; b < count; b++) {
        const from = Math.floor(b * per);
        const to = Math.min(length, Math.max(from + 1, Math.floor((b + 1) * per)));
        let max = 0;
        for (let c = 0; c < channels; c++) {
            const channel = data[c];
            for (let i = from; i < to; i++) {
                const value = Math.abs(channel[i]);
                if (value > max) {
                    max = value;
                }
            }
        }
        peaks[b] = max;
    }
    return peaks;
}

/**
 * Builds a 16 bit PCM mono WAV file.
 *
 * s2.cpp downmixes every channel to mono on its own, so the browser does the
 * same thing here — that keeps the uploaded file half as large.
 *
 * @param {number} sampleRate The sample rate of the audio.
 * @param {Uint8Array} pcm The interleaved 16 bit samples.
 * @returns {Uint8Array} The complete WAV file.
 */
export function buildWavFile(sampleRate, pcm) {
    const header = new ArrayBuffer(44);
    const view = new DataView(header);
    const writeText = (offset, text) => {
        for (let i = 0; i < text.length; i++) {
            view.setUint8(offset + i, text.charCodeAt(i));
        }
    };
    writeText(0, 'RIFF');
    view.setUint32(4, 36 + pcm.length, true);
    writeText(8, 'WAVE');
    writeText(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); // byte rate
    view.setUint16(32, 2, true); // block align
    view.setUint16(34, 16, true); // bits per sample
    writeText(36, 'data');
    view.setUint32(40, pcm.length, true);

    const file = new Uint8Array(44 + pcm.length);
    file.set(new Uint8Array(header), 0);
    file.set(pcm, 44);
    return file;
}

/**
 * Cuts a range out of the audio and encodes it as a mono WAV.
 *
 * @param {object} audioBuffer The decoded recording.
 * @param {number} startSec Where the range starts, in seconds.
 * @param {number} endSec Where the range ends, in seconds.
 * @returns {{bytes: Uint8Array, frames: number, duration: number, sampleRate: number}}
 */
export function encodeRange(audioBuffer, startSec, endSec) {
    const rate = audioBuffer?.sampleRate ?? TARGET_SAMPLE_RATE;
    const length = Math.max(0, audioBuffer?.length ?? 0);
    const duration = length / rate;

    let start = Math.round(Number(startSec) * rate);
    let end = Math.round(Number(endSec) * rate);
    start = Math.max(0, Math.min(length, start));
    end = Math.max(start, Math.min(length, end));

    const frames = end - start;
    const channels = Math.max(1, audioBuffer?.numberOfChannels ?? 1);
    const pcm = new Uint8Array(frames * 2);
    const view = new DataView(pcm.buffer);

    const channelData = [];
    for (let c = 0; c < channels; c++) {
        channelData.push(audioBuffer.getChannelData(c));
    }

    for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let c = 0; c < channels; c++) {
            sum += channelData[c][start + i] ?? 0;
        }
        let sample = sum / channels;
        if (sample > 1) {
            sample = 1;
        } else if (sample < -1) {
            sample = -1;
        }
        const value = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        view.setInt16(i * 2, Math.round(value), true);
    }

    return {
        bytes: buildWavFile(rate, pcm),
        frames,
        duration: frames / rate,
        sampleRate: rate,
    };
}

/**
 * Keeps a range inside the recording.
 *
 * @param {number} start The wanted start, in seconds.
 * @param {number} end The wanted end, in seconds.
 * @param {number} duration The length of the recording, in seconds.
 * @returns {{start: number, end: number}}
 */
export function clampRange(start, end, duration) {
    const limit = Math.max(0, Number(duration) || 0);
    let from = Math.max(0, Math.min(limit, Number(start) || 0));
    let to = Math.max(0, Math.min(limit, Number(end) || 0));
    if (to < from) {
        const swap = from;
        from = to;
        to = swap;
    }
    return { start: from, end: to };
}

/**
 * Formats a number of seconds for the interface.
 *
 * @param {number} value The number of seconds.
 * @returns {string} For example "12.34" or "1:02.5".
 */
export function formatSeconds(value) {
    const seconds = Math.max(0, Number(value) || 0);
    if (seconds < 60) {
        return seconds.toFixed(2);
    }
    const minutes = Math.floor(seconds / 60);
    const rest = seconds - minutes * 60;
    return `${minutes}:${rest.toFixed(1).padStart(4, '0')}`;
}

/**
 * Encodes bytes as base64, without pulling in a dependency.
 *
 * @param {Uint8Array} bytes The bytes.
 * @returns {string} The base64 text.
 */
export function toBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}
