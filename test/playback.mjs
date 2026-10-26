/**
 * Playback tests: the read-aloud queue and the Web Audio player.
 *
 * Both are free of SillyTavern and browser dependencies — the queue is plain
 * JavaScript and the player only needs an AudioContext, which is stubbed
 * here — so they can be tested without a running s2.cpp.
 *
 *   node test/playback.mjs
 *
 * The same tests run as part of the full suite (`test/run.mjs`).
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { SpeakQueue } from '../queue.js';
import { TtsPlayer } from '../player.js';

/**
 * Runs every playback test.
 *
 * @param {(name: string, condition: boolean, detail?: string) => void} check
 */
export async function runPlaybackTests(check) {
    /* ----------------------------------------------- read-aloud queue (A3) */

    // The queue is what keeps two replies from talking over each other.

    console.log('\n[read-aloud queue]');
    {
        // 1. Jobs never run at the same time.
        const order = [];
        let active = 0;
        let maxActive = 0;
        const queue = new SpeakQueue({
            run: async (job) => {
                active++;
                maxActive = Math.max(maxActive, active);
                order.push(`start:${job.id}`);
                await new Promise((resolve) => setTimeout(resolve, 20));
                order.push(`end:${job.id}`);
                active--;
                return { duration: 1, played: false };
            },
        });

        queue.push({ id: 1 });
        queue.push({ id: 2 });
        queue.push({ id: 3 });
        await queue.drain();

        check('the queue never runs two jobs at once', maxActive === 1, `max concurrent ${maxActive}`);
        check('the queue keeps the order',
            order.join(',') === 'start:1,end:1,start:2,end:2,start:3,end:3',
            order.join(','));
        check('the queue is empty afterwards', queue.length === 0);
    }

    {
        // 2. The next job only starts once the audio really stopped.
        //
        // This is the difference between "scheduled" and "played": without the
        // wait, the second reply would start while the first one is still
        // audible and the two would talk over each other.
        const order = [];
        let releasePlayback;
        const playbackDone = new Promise((resolve) => {
            releasePlayback = resolve;
        });
        const queue = new SpeakQueue({
            run: async (job) => {
                order.push(`run:${job.id}`);
                return { duration: 1, played: true };
            },
            waitForPlayback: () => playbackDone,
        });

        queue.push({ id: 1 });
        queue.push({ id: 2 });
        const drain = queue.drain();

        await new Promise((resolve) => setTimeout(resolve, 30));
        check('the second job waits for the playback to end', order.join(',') === 'run:1', order.join(','));

        releasePlayback();
        await drain;
        check('the second job starts after the playback ended', order.join(',') === 'run:1,run:2', order.join(','));
    }

    {
        // 3. Stopping drops everything that is still waiting.
        const results = [];
        const queue = new SpeakQueue({
            run: async (job) => {
                if (job.id === 1) {
                    await new Promise((resolve) => setTimeout(resolve, 60));
                }
                return { duration: 2, played: false };
            },
        });

        const first = queue.push({ id: 1 }).then((r) => results.push(`first:${r.duration}`));
        const second = queue.push({ id: 2 }).then((r) => results.push(`second:${r.duration}`));
        const third = queue.push({ id: 3 }).then((r) => results.push(`third:${r.duration}`));
        void queue.drain();

        await new Promise((resolve) => setTimeout(resolve, 10));
        check('stopping drops the waiting jobs', queue.clear() === 2, `${queue.length} left`);
        await Promise.all([first, second, third]);

        check('the cancelled jobs report -1',
            results.includes('second:-1') && results.includes('third:-1'),
            results.join(','));
        check('the running job is not cancelled', results.includes('first:2'), results.join(','));
    }

    {
        // 4. A single queued message can be taken out of the queue.
        const results = [];
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        const queue = new SpeakQueue({
            run: async () => {
                await gate;
                return { duration: 5, played: false };
            },
        });

        const first = queue.push({ id: 1 }).then((r) => results.push(`first:${r.duration}`));
        const second = queue.push({ id: 2 }).then((r) => results.push(`second:${r.duration}`));
        const third = queue.push({ id: 3 }).then((r) => results.push(`third:${r.duration}`));
        void queue.drain();

        await new Promise((resolve) => setTimeout(resolve, 10));
        check('removing drops only the matching job', queue.remove((job) => job.id === 2) === 1);
        check('the other job stays in the queue', queue.length === 1, `${queue.length} left`);

        release();
        await Promise.all([first, second, third]);

        check('the removed job reports -1', results.includes('second:-1'), results.join(','));
        check('the remaining jobs still play',
            results.includes('first:5') && results.includes('third:5'),
            results.join(','));
    }

    {
        // 5. A failed job must not block the queue.
        const results = [];
        const queue = new SpeakQueue({
            run: async (job) => {
                if (job.id === 1) {
                    throw new Error('boom');
                }
                return { duration: 3, played: false };
            },
        });

        const first = queue.push({ id: 1 }).then((r) => results.push(`first:${r.error ? 'error' : r.duration}`));
        const second = queue.push({ id: 2 }).then((r) => results.push(`second:${r.duration}`));
        void queue.drain();
        await Promise.all([first, second]);

        check('a failing job is reported as an error', results.includes('first:error'), results.join(','));
        check('a failing job does not block the queue', results.includes('second:3'), results.join(','));
    }

    /* ------------------------------------------------- playback player (A3) */

    // The player has to distinguish "the audio is scheduled" from "the audio is
    // over". A stubbed AudioContext keeps that testable without a browser.

    console.log('\n[playback player]');

    function makeFakeContext() {
        const sources = [];
        return {
            sources,
            currentTime: 0,
            state: 'running',
            destination: {},
            createBuffer(channels, length, sampleRate) {
                return {
                    length,
                    sampleRate,
                    numberOfChannels: channels,
                    copyToChannel() { /* the stub does not need the samples */ },
                };
            },
            createBufferSource() {
                const source = {
                    buffer: null,
                    playbackRate: { value: 1 },
                    onended: null,
                    ended: false,
                    connect() {
                        return this;
                    },
                    start(at) {
                        this.startedAt = at;
                    },
                    stop() {
                        this.finish();
                    },
                    /** Simulates the browser reporting that the node finished. */
                    finish() {
                        if (this.onended && !this.ended) {
                            this.ended = true;
                            this.onended();
                        }
                    },
                };
                sources.push(source);
                return source;
            },
        };
    }

    {
        // 1. A streamed PCM response is scheduled and decoded.
        const context = makeFakeContext();
        const player = new TtsPlayer({ getContext: () => context });
        const pcm = new Int16Array([0, 1000, 2000, 3000]);
        const response = new Response(new ReadableStream({
            start(controller) {
                controller.enqueue(new Uint8Array(pcm.buffer));
                controller.close();
            },
        }), {
            headers: {
                'X-Audio-Encoding': 'pcm_s16le',
                'X-Audio-Sample-Rate': '44100',
            },
        });

        const result = await player.play(response);
        check('the stream is decoded into samples', result.frames === 4, `${result.frames} frames`);
        check('the stream reports itself as streamed', result.streamed === true);
        check('the audio is scheduled on the audio graph', context.sources.length >= 1, `${context.sources.length} sources`);

        // 2. waitForEnd() waits for the audio to actually stop.
        let ended = false;
        const waiting = player.waitForEnd().then(() => {
            ended = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        check('waitForEnd does not resolve while the audio is scheduled', ended === false);

        for (const source of context.sources) {
            source.finish();
        }
        await waiting;
        check('waitForEnd resolves when the last node ended', ended === true);
    }

    {
        // 3. Stopping ends the playback, so a pending wait resolves as well.
        const context = makeFakeContext();
        const player = new TtsPlayer({ getContext: () => context });
        player.playBuffer({
            duration: 1,
            length: 44100,
            sampleRate: 44100,
            copyToChannel() { /* the stub does not need the samples */ },
        });

        let ended = false;
        const waiting = player.waitForEnd().then(() => {
            ended = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        check('waitForEnd waits for the scheduled buffer', ended === false);

        player.stop();
        await waiting;
        check('stopping resolves the pending waiters', ended === true);
        check('stopping clears the scheduled nodes', player.sources.size === 0, `${player.sources.size} left`);
    }

    {
        // 4. Nothing scheduled means nothing to wait for.
        const context = makeFakeContext();
        const player = new TtsPlayer({ getContext: () => context });
        let ended = false;
        await player.waitForEnd().then(() => {
            ended = true;
        });
        check('waitForEnd resolves immediately when nothing plays', ended === true);
    }
}

/* ------------------------------------------------------- standalone mode */

const invokedDirectly = process.argv[1]
    && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
    let passed = 0;
    let failed = 0;
    const check = (name, condition, detail = '') => {
        if (condition) {
            passed++;
            console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
        } else {
            failed++;
            console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
        }
    };
    await runPlaybackTests(check);
    console.log(`\n${passed} passed, ${failed} failed\n`);
    process.exit(failed === 0 ? 0 : 1);
}
