/**
 * The read-aloud queue.
 *
 * Two replies that play at the same time are just noise, and s2.cpp can only
 * synthesize one request at a time — so every job goes through this queue and
 * is played one after another.
 *
 * The module is deliberately free of any SillyTavern or browser dependency:
 * it only knows about jobs, so the behaviour that matters (serial playback,
 * interruption, cancellation) can be unit-tested on its own.
 */
export class SpeakQueue {
    /**
     * @param {object} options
     * @param {(job: object) => Promise<object>} [options.run]
     *        Performs a job. The result may set `played: true` when audio was
     *        scheduled, and `error` when the job failed.
     * @param {() => Promise<void>} [options.waitForPlayback]
     *        Resolves when the audio that is currently playing has ended.
     * @param {(job: object, result: object) => void} [options.afterRun]
     *        Called after the playback ended, for clean-up.
     */
    constructor({ run, waitForPlayback, afterRun } = {}) {
        this.run = run ?? (async () => ({}));
        this.waitForPlayback = waitForPlayback ?? (async () => {});
        this.afterRun = afterRun ?? (() => {});
        /** Jobs that are still waiting. @type {Array<object>} */
        this.items = [];
        /** True while the queue is being drained. */
        this.draining = false;
    }

    /** Number of jobs that are still waiting. */
    get length() {
        return this.items.length;
    }

    /**
     * Adds a job to the queue.
     *
     * The returned promise resolves with the job's result once the job has
     * been played (or with `value` when the job was cancelled).
     *
     * @param {object} job
     * @returns {Promise<object>}
     */
    push(job) {
        return new Promise((resolve) => {
            this.items.push({ ...job, resolve });
        });
    }

    /**
     * Plays the queued jobs one after another.
     *
     * Calling this while a drain is already running is a no-op: the running
     * loop picks the new job up by itself.
     */
    async drain() {
        if (this.draining) {
            return;
        }
        this.draining = true;

        try {
            while (this.items.length > 0) {
                const job = this.items.shift();
                let result = { duration: -1, played: false };

                try {
                    result = (await this.run(job)) ?? result;
                } catch (error) {
                    result = { duration: -1, played: false, error };
                }

                // Scheduling is not playing: the sound keeps coming out for a
                // few more seconds. Waiting for the end is what keeps two
                // replies from talking over each other.
                if (result.played) {
                    await this.waitForPlayback();
                }

                await this.afterRun(job, result);
                job.resolve?.(result);
            }
        } finally {
            this.draining = false;
        }
    }

    /**
     * Drops every job that is still waiting.
     *
     * The job that is currently running is not affected — it is interrupted
     * by stopping the player, not by emptying the queue.
     *
     * @param {number} [duration] Duration the dropped jobs report.
     * @returns {number} How many jobs were dropped.
     */
    clear(duration = -1) {
        const dropped = this.items.splice(0);
        for (const job of dropped) {
            job.resolve?.({ duration, played: false, cancelled: true });
        }
        return dropped.length;
    }

    /**
     * Drops the jobs that match the predicate.
     *
     * @param {(job: object) => boolean} predicate
     * @param {number} [duration] Duration the dropped jobs report.
     * @returns {number} How many jobs were dropped.
     */
    remove(predicate, duration = -1) {
        const kept = [];
        const dropped = [];
        for (const job of this.items) {
            (predicate(job) ? dropped : kept).push(job);
        }
        this.items = kept;
        for (const job of dropped) {
            job.resolve?.({ duration, played: false, cancelled: true });
        }
        return dropped.length;
    }
}
