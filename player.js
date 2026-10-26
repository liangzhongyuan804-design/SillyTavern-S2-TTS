/**
 * Web Audio playback for the S2 TTS extension.
 *
 * Two playback modes are supported, decided by the response headers:
 *
 *   - **streaming** — the server replies with raw `pcm_s16le` and the
 *     `X-Audio-Encoding` header. Chunks are scheduled on the fly, so the first
 *     audio is audible long before the synthesis finishes.
 *   - **buffered** — the server replies with a complete WAV file. The whole
 *     body is decoded and played in one go. This is the fallback for older
 *     s2.cpp builds that ignore the streaming parameters.
 *
 * Scheduling works by handing each slice of PCM to its own
 * AudioBufferSourceNode, queued at an exact start time. The nodes therefore
 * play back-to-back without gaps, and the first one can start ~50 ms after
 * the first chunk arrives.
 */

/** Fallback sample rate when the server does not advertise one. */
const DEFAULT_SAMPLE_RATE = 44100;

/**
 * How much audio to gather before scheduling the next node, in seconds.
 *
 * Small enough to keep the latency low, large enough to avoid creating
 * hundreds of nodes for a long reply.
 */
const SCHEDULE_GRANULARITY = 0.08;

/** How far ahead of the audio clock the first chunk is scheduled, in seconds. */
const START_LEAD = 0.05;

export class TtsPlayer {
    /**
     * @param {object} options
     * @param {() => AudioContext} options.getContext Returns the shared AudioContext.
     * @param {(key: string, fallback: string) => string} [options.translate] Locale lookup for error messages.
     */
    constructor({ getContext, translate } = {}) {
        this.getContext = getContext;
        this.translate = translate ?? ((key, fallback) => fallback ?? key);
        /** Currently scheduled AudioBufferSourceNodes. */
        this.sources = new Set();
        /** Reader of the in-flight response body, so it can be cancelled. */
        this.reader = null;
        /** Aborts the in-flight fetch. */
        this.abortController = null;
        /** Resolvers waiting for the scheduled audio to finish playing. */
        this.idleWaiters = [];
    }

    /**
     * Resolves once everything that is currently scheduled has finished playing.
     *
     * Scheduling and playing are two different moments: `play()` returns as
     * soon as the last chunk has been handed to the audio graph, while the
     * sound keeps coming out for another few seconds. Code that wants to
     * play several things one after another has to wait for this promise —
     * otherwise the second one starts while the first is still audible.
     *
     * @returns {Promise<void>}
     */
    waitForEnd() {
        if (this.sources.size === 0) {
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            this.idleWaiters.push(resolve);
        });
    }

    /**
     * Wakes up everyone waiting for the playback to end.
     *
     * Called when the last scheduled node ended and when the playback was
     * stopped — a stopped playback is "over" as well.
     */
    notifyIdle() {
        if (this.sources.size > 0) {
            return;
        }
        const waiters = this.idleWaiters;
        this.idleWaiters = [];
        for (const resolve of waiters) {
            resolve();
        }
    }

    /** True while audio is scheduled or a response is still streaming in. */
    isBusy() {
        return this.sources.size > 0 || this.reader !== null;
    }

    /**
     * Starts a new synthesis request and returns the abort signal for it.
     *
     * The signal has to exist before the request is sent: while the server is
     * still synthesizing there is no body reader to cancel yet, so `stop()`
     * could not interrupt it. Aborting the fetch closes the HTTP connection,
     * which makes the server plugin tear down the s2.cpp request instead of
     * keeping the GPU busy for audio nobody hears.
     *
     * @returns {AbortSignal}
     */
    beginRequest() {
        this.abortController?.abort();
        this.abortController = new AbortController();
        return this.abortController.signal;
    }

    /**
     * Stops playback and cancels any in-flight synthesis.
     *
     * Stopping the reader also aborts the upstream request, which makes the
     * server plugin tear down the s2.cpp request instead of keeping the GPU
     * busy for audio nobody hears.
     */
    stop() {
        this.abortController?.abort();
        this.abortController = null;
        if (this.reader) {
            this.reader.cancel().catch(() => { /* already closed */ });
            this.reader = null;
        }
        for (const source of this.sources) {
            try {
                source.stop();
            } catch {
                /* already stopped or never started */
            }
        }
        this.sources.clear();
        this.notifyIdle();
    }

    /**
     * Plays a finished AudioBuffer, e.g. a replay from the cache.
     *
     * @param {AudioBuffer} buffer
     * @param {number} [rate] Playback rate.
     */
    playBuffer(buffer, { rate } = {}) {
        this.stop();
        const context = this.getContext();
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.playbackRate.value = Number(rate) || 1;
        source.connect(context.destination);
        source.start(0);
        this.sources.add(source);
        source.onended = () => {
            this.sources.delete(source);
            this.notifyIdle();
        };
    }

    /**
     * Plays an audio response and resolves once the whole thing was scheduled.
     *
     * @param {Response} response Response of the plugin's /generate route.
     * @param {object} [options]
     * @param {number} [options.rate] Playback rate.
     * @param {(info: {duration: number}) => void} [options.onFirstAudio] Called once the first audio is scheduled.
     * @returns {Promise<{duration: number, sampleRate: number, frames: number, streamed: boolean, buffer: AudioBuffer|null}>}
     */
    async play(response, options = {}) {
        const rate = Number(options.rate) || 1;
        const encoding = (response.headers.get('X-Audio-Encoding') ?? '').toLowerCase();

        if (encoding === 'pcm_s16le' && response.body) {
            return await this.playPcmStream(response, { rate, onFirstAudio: options.onFirstAudio });
        }
        return await this.playEncodedFile(response, { rate, onFirstAudio: options.onFirstAudio });
    }

    /**
     * Streams raw PCM16 into the graph.
     *
     * @param {Response} response
     * @param {{rate: number, onFirstAudio?: Function}} options
     */
    async playPcmStream(response, { rate, onFirstAudio }) {
        const context = this.getContext();
        const sampleRate = Number(response.headers.get('X-Audio-Sample-Rate')) || DEFAULT_SAMPLE_RATE;

        // The controller was created by beginRequest() before the fetch; it is
        // reused here so a stop during the download also cancels the transfer.
        this.abortController ??= new AbortController();
        this.reader = response.body.getReader();

        /** PCM that has been received but not scheduled yet. */
        let pending = new Float32Array(0);
        /** Every received sample, kept so the result can be cached and replayed. */
        const received = [];
        let receivedFrames = 0;
        let nextStart = context.currentTime + START_LEAD;
        let firstAudioSent = false;

        const schedule = (pcm) => {
            if (pcm.length === 0) {
                return;
            }
            const buffer = context.createBuffer(1, pcm.length, sampleRate);
            buffer.copyToChannel(pcm, 0);
            const source = context.createBufferSource();
            source.buffer = buffer;
            source.playbackRate.value = rate;
            source.connect(context.destination);
            source.start(nextStart);
            this.sources.add(source);
            source.onended = () => {
                this.sources.delete(source);
                this.notifyIdle();
            };
            // With a playback rate above 1 the node finishes earlier than the
            // audio length, so the next one has to start sooner.
            nextStart += pcm.length / sampleRate / rate;

            if (!firstAudioSent) {
                firstAudioSent = true;
                onFirstAudio?.({ duration: pcm.length / sampleRate });
            }
        };

        const flush = (force) => {
            if (pending.length === 0) {
                return;
            }
            const needed = Math.ceil(SCHEDULE_GRANULARITY * sampleRate);
            if (!force && pending.length < needed) {
                return;
            }
            schedule(pending);
            pending = new Float32Array(0);
        };

        try {
            for (;;) {
                const { value, done } = await this.reader.read();
                if (done) {
                    break;
                }
                if (!value || value.byteLength === 0) {
                    continue;
                }

                // Int16Array needs an even byte length and a 2-byte aligned
                // offset; a stray byte at the end of a chunk is discarded.
                const usable = value.byteLength - (value.byteLength % 2);
                const samples = new Int16Array(value.buffer, value.byteOffset, usable >> 1);
                const pcm = new Float32Array(samples.length);
                for (let i = 0; i < samples.length; i++) {
                    pcm[i] = samples[i] / 32768;
                }

                received.push(pcm);
                receivedFrames += pcm.length;

                if (pending.length === 0 && !firstAudioSent) {
                    // Play the very first slice right away, even if it is
                    // shorter than the scheduling granularity.
                    schedule(pcm);
                    continue;
                }

                if (pending.length === 0) {
                    pending = pcm;
                } else {
                    const merged = new Float32Array(pending.length + pcm.length);
                    merged.set(pending, 0);
                    merged.set(pcm, pending.length);
                    pending = merged;
                }
                flush(false);
            }
            flush(true);
        } finally {
            this.reader = null;
            this.abortController = null;
        }

        const buffer = this.buildBuffer(received, receivedFrames, sampleRate);
        return {
            duration: receivedFrames / sampleRate,
            sampleRate,
            frames: receivedFrames,
            streamed: true,
            buffer,
        };
    }

    /**
     * Decodes a complete WAV (or any browser-decodable file) and plays it.
     *
     * @param {Response} response
     * @param {{rate: number, onFirstAudio?: Function}} options
     */
    async playEncodedFile(response, { rate, onFirstAudio }) {
        const context = this.getContext();
        const data = await response.arrayBuffer();
        const buffer = await context.decodeAudioData(data.slice(0));

        const source = context.createBufferSource();
        source.buffer = buffer;
        source.playbackRate.value = rate;
        source.connect(context.destination);
        source.start(0);
        this.sources.add(source);
        source.onended = () => {
            this.sources.delete(source);
            this.notifyIdle();
        };
        onFirstAudio?.({ duration: buffer.duration });

        return {
            duration: buffer.duration,
            sampleRate: buffer.sampleRate,
            frames: Math.floor(buffer.length * buffer.sampleRate),
            streamed: false,
            buffer,
        };
    }

    /**
     * Concatenates the received PCM into a single AudioBuffer.
     *
     * @param {Float32Array[]} parts
     * @param {number} frames Total number of samples.
     * @param {number} sampleRate
     * @returns {AudioBuffer|null}
     */
    buildBuffer(parts, frames, sampleRate) {
        if (!parts.length || frames === 0) {
            return null;
        }
        const context = this.getContext();
        const buffer = context.createBuffer(1, frames, sampleRate);
        let offset = 0;
        for (const part of parts) {
            buffer.copyToChannel(part, 0, offset);
            offset += part.length;
        }
        return buffer;
    }
}
