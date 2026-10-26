/**
 * Persistent audio cache for the S2 TTS server plugin.
 *
 * Why this lives on the server and not in the browser:
 *
 *   - The server already owns the s2.cpp process and the synthesis request,
 *     so it can decide *before* the GPU work starts whether the answer is
 *     already on disk. A browser-side cache could only help after the audio
 *     has already been produced.
 *   - A cache in the SillyTavern data directory survives a browser restart,
 *     a new profile and a new chat. Re-reading an old message is instant.
 *   - Everything stays local: the cache is a directory of WAV/PCM files
 *     next to the user's other SillyTavern data.
 *
 * On-disk layout, one entry per synthesis:
 *
 *   <key>.pcm     raw 16-bit PCM samples
 *   <key>.json    metadata (sample rate, channels, text, timestamp, size)
 *
 * The metadata file is written last and therefore acts as the commit
 * marker: an entry is only valid when both files are present and the
 * recorded byte count matches the PCM file.
 */

import { createHash } from 'node:crypto';
import {
    createWriteStream,
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import path from 'node:path';

/** Folder created inside the user's SillyTavern data directory. */
const CACHE_FOLDER = 's2-tts-cache';

/** Default ceiling for the whole cache. */
export const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;

/**
 * Parameters that only change how the audio is transported, not what it
 * contains. Excluding them keeps the cache useful when the user flips the
 * streaming switch or nudges the start buffer.
 */
const TRANSPORT_ONLY_PARAMS = new Set([
    'chunked',
    'output_format',
    'stream_start_buffer_ms',
    'stream_holdback_frames',
    'stream_decode_stride_frames',
    'n_threads',
    'verbose',
    'codec_follow_backend',
    'codec_auto_backend',
]);

/**
 * Works out where the cache should live.
 *
 * `req.user.directories.root` is the per-user SillyTavern directory
 * (`<dataRoot>/<handle>`), so every account gets its own cache and nobody
 * sees anybody else's audio. It is only available when the request went
 * through SillyTavern's user middleware; the fallbacks keep the plugin
 * usable from a bare script or a unit test.
 *
 * @param {object} [req] Express request.
 * @returns {string|null} Absolute path, or null when no cache is possible.
 */
export function resolveCacheDir(req) {
    const override = String(process.env.S2TTS_CACHE_DIR ?? '').trim();
    if (override) {
        return path.resolve(override);
    }

    const userRoot = req?.user?.directories?.root;
    if (userRoot) {
        // The data root comes from config.yaml and is often relative
        // ("data"), which would tie the cache to the server's working
        // directory. Resolve it once so the path is stable.
        return path.resolve(path.join(userRoot, CACHE_FOLDER));
    }

    const dataRoot = globalThis.DATA_ROOT;
    if (dataRoot) {
        return path.resolve(path.join(dataRoot, 'default-user', CACHE_FOLDER));
    }

    return null;
}

/**
 * Builds the cache key for a synthesis request.
 *
 * Everything that influences the produced audio goes into the hash: the
 * text, the voice (either a saved profile or a hash of the reference
 * audio) and the generation parameters. Anything else — the streaming
 * flags, the thread count — is deliberately left out so that toggling a
 * transport option does not throw the whole cache away.
 *
 * @param {object} request
 * @param {string} request.text
 * @param {string} [request.voice] Saved voice profile name or path.
 * @param {string} [request.referenceBase64] Reference audio, base64.
 * @param {string} [request.referenceHash] Hash of the reference audio, when
 *   it was already computed (an audio file from the voice directory).
 * @param {object} [request.params] Generation parameters.
 * @returns {string} Hex SHA-256 digest.
 */
export function computeCacheKey({ text, voice, referenceBase64, referenceHash, params } = {}) {
    const relevant = {};
    for (const key of Object.keys(params ?? {}).sort()) {
        if (TRANSPORT_ONLY_PARAMS.has(key)) {
            continue;
        }
        relevant[key] = params[key];
    }

    const reference = referenceHash
        ? String(referenceHash)
        : referenceBase64
            ? createHash('sha256').update(Buffer.from(referenceBase64, 'base64')).digest('hex')
            : null;

    const payload = JSON.stringify({
        text: String(text ?? ''),
        voice: voice ? String(voice) : null,
        reference,
        params: relevant,
    });

    return createHash('sha256').update(payload).digest('hex');
}

/**
 * Reads the header of a RIFF/WAVE file.
 *
 * s2.cpp writes either 16-bit PCM or 32-bit IEEE float, and the chunk
 * layout is not guaranteed to be exactly 44 bytes, so the chunks are
 * walked properly instead of assuming a fixed offset.
 *
 * @param {Buffer} buffer
 * @returns {{sampleRate: number, channels: number, formatTag: number, bitsPerSample: number, dataOffset: number, dataLength: number}|null}
 */
export function parseWav(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
        return null;
    }
    if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
        return null;
    }

    let offset = 12;
    let formatTag = 0;
    let channels = 0;
    let sampleRate = 0;
    let bitsPerSample = 0;

    while (offset + 8 <= buffer.length) {
        const chunkId = buffer.toString('ascii', offset, offset + 4);
        const chunkSize = buffer.readUInt32LE(offset + 4);
        const body = offset + 8;

        if (chunkId === 'fmt ') {
            if (body + 16 > buffer.length) {
                return null;
            }
            formatTag = buffer.readUInt16LE(body);
            channels = buffer.readUInt16LE(body + 2);
            sampleRate = buffer.readUInt32LE(body + 4);
            bitsPerSample = buffer.readUInt16LE(body + 14);
        } else if (chunkId === 'data') {
            if (!formatTag) {
                return null;
            }
            return {
                formatTag,
                channels,
                sampleRate,
                bitsPerSample,
                dataOffset: body,
                dataLength: Math.min(chunkSize, buffer.length - body),
            };
        }

        // Chunks are padded to an even length.
        offset = body + chunkSize + (chunkSize % 2);
    }

    return null;
}

/**
 * Builds a canonical 44-byte WAV header.
 *
 * @param {{sampleRate: number, channels: number, formatTag?: number, bitsPerSample?: number, dataLength: number}} meta
 * @returns {Buffer}
 */
export function buildWavHeader(meta) {
    const formatTag = meta.formatTag ?? 1;
    const bitsPerSample = meta.bitsPerSample ?? 16;
    const channels = meta.channels ?? 1;
    const sampleRate = meta.sampleRate ?? 44100;
    const blockAlign = (channels * bitsPerSample) / 8;
    const byteRate = sampleRate * blockAlign;

    const header = Buffer.alloc(44);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(36 + meta.dataLength, 4);
    header.write('WAVE', 8, 'ascii');
    header.write('fmt ', 12, 'ascii');
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(formatTag, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36, 'ascii');
    header.writeUInt32LE(meta.dataLength, 40);
    return header;
}

/**
 * Writes a cache entry while the audio is still streaming in.
 *
 * The PCM is streamed to a temporary file so a long reply never has to sit
 * in memory, and only once the stream finished is the entry committed
 * (temporary file renamed, metadata written).
 */
export class CacheWriter {
    /**
     * @param {AudioCache} cache
     * @param {string} key
     * @param {object} meta Metadata fields to store alongside the samples.
     */
    constructor(cache, key, meta) {
        this.cache = cache;
        this.key = key;
        this.meta = meta;
        this.bytes = 0;
        this.closed = false;
        this.failed = false;
        this.tempPath = `${cache.getPcmPath(key)}.part`;
        this.stream = createWriteStream(this.tempPath);
        this.stream.on('error', () => {
            this.failed = true;
        });
    }

    /**
     * Appends one chunk of PCM.
     *
     * @param {Buffer} chunk
     */
    write(chunk) {
        if (this.closed || this.failed || !chunk?.length) {
            return;
        }
        this.bytes += chunk.length;
        this.stream.write(chunk);
    }

    /**
     * Commits the entry.
     *
     * @returns {Promise<object|null>} The stored metadata, or null on failure.
     */
    async close() {
        if (this.closed) {
            return null;
        }
        this.closed = true;

        await new Promise((resolve) => this.stream.end(resolve));
        if (this.failed || this.bytes === 0) {
            this.abort();
            return null;
        }

        const meta = {
            ...this.meta,
            bytes: this.bytes,
            createdAt: new Date().toISOString(),
        };

        try {
            renameSync(this.tempPath, this.cache.getPcmPath(this.key));
            writeFileSync(this.cache.getMetaPath(this.key), JSON.stringify(meta, null, 2), 'utf8');
        } catch {
            this.abort();
            return null;
        }

        return meta;
    }

    /** Discards a partially written entry. */
    abort() {
        try {
            this.stream.destroy();
        } catch {
            /* already gone */
        }
        try {
            if (existsSync(this.tempPath)) {
                unlinkSync(this.tempPath);
            }
        } catch {
            /* already gone */
        }
    }
}

/**
 * The cache itself.
 */
export class AudioCache {
    /**
     * @param {string} dir Directory that holds the cache files.
     */
    constructor(dir) {
        this.dir = dir;
    }

    /** Creates the cache directory if it does not exist yet. */
    ensure() {
        mkdirSync(this.dir, { recursive: true });
        return this;
    }

    /** @param {string} key */
    getPcmPath(key) {
        return path.join(this.dir, `${key}.pcm`);
    }

    /** @param {string} key */
    getMetaPath(key) {
        return path.join(this.dir, `${key}.json`);
    }

    /**
     * True when a complete entry exists for this key.
     *
     * @param {string} key
     * @returns {boolean}
     */
    has(key) {
        return existsSync(this.getMetaPath(key)) && existsSync(this.getPcmPath(key));
    }

    /**
     * Reads a complete entry.
     *
     * @param {string} key
     * @returns {{meta: object, pcm: Buffer}|null}
     */
    read(key) {
        try {
            const meta = JSON.parse(readFileSync(this.getMetaPath(key), 'utf8'));
            const pcm = readFileSync(this.getPcmPath(key));
            if (meta?.bytes !== pcm.length) {
                // A half-written entry; treat it as a miss.
                return null;
            }
            return { meta, pcm };
        } catch {
            return null;
        }
    }

    /**
     * Lists every valid entry, newest first.
     *
     * @returns {Array<object>}
     */
    list() {
        let names = [];
        try {
            names = readdirSync(this.dir);
        } catch {
            return [];
        }

        const entries = [];
        for (const name of names) {
            if (!name.endsWith('.json')) {
                continue;
            }
            const key = name.slice(0, -'.json'.length);
            try {
                const meta = JSON.parse(readFileSync(path.join(this.dir, name), 'utf8'));
                const stat = statSync(this.getPcmPath(key));
                entries.push({
                    key,
                    bytes: stat.size,
                    modified: stat.mtime.toISOString(),
                    sampleRate: meta.sampleRate ?? 44100,
                    channels: meta.channels ?? 1,
                    duration: meta.sampleRate ? stat.size / ((meta.channels ?? 1) * 2 * meta.sampleRate) : 0,
                    text: meta.text ?? '',
                    voice: meta.voice ?? '',
                    createdAt: meta.createdAt ?? '',
                });
            } catch {
                /* broken entry; ignore it */
            }
        }

        entries.sort((a, b) => (a.modified < b.modified ? 1 : -1));
        return entries;
    }

    /**
     * Total size and entry count.
     *
     * @returns {{entries: number, bytes: number, dir: string}}
     */
    stats() {
        const entries = this.list();
        return {
            entries: entries.length,
            bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
            dir: this.dir,
        };
    }

    /**
     * Removes one entry.
     *
     * @param {string} key
     * @returns {boolean} True when something was removed.
     */
    delete(key) {
        let removed = false;
        for (const file of [this.getMetaPath(key), this.getPcmPath(key), `${this.getPcmPath(key)}.part`]) {
            try {
                if (existsSync(file)) {
                    unlinkSync(file);
                    removed = true;
                }
            } catch {
                /* ignore */
            }
        }
        return removed;
    }

    /** Removes every entry and any leftovers. */
    clear() {
        let removed = 0;
        try {
            for (const name of readdirSync(this.dir)) {
                const file = path.join(this.dir, name);
                try {
                    rmSync(file, { recursive: true, force: true });
                    removed++;
                } catch {
                    /* ignore */
                }
            }
        } catch {
            /* directory does not exist yet */
        }
        return removed;
    }

    /**
     * Drops the oldest entries until the cache fits into `maxBytes`.
     *
     * @param {number} maxBytes
     * @returns {number} Number of removed entries.
     */
    evict(maxBytes) {
        const limit = Number(maxBytes);
        if (!Number.isFinite(limit) || limit <= 0) {
            return 0;
        }

        const entries = this.list();
        let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
        if (total <= limit) {
            return 0;
        }

        // list() is newest first, so the tail is the oldest.
        let removed = 0;
        for (let i = entries.length - 1; i >= 0; i--) {
            if (total <= limit) {
                break;
            }
            const entry = entries[i];
            if (this.delete(entry.key)) {
                total -= entry.bytes;
                removed++;
            }
        }
        return removed;
    }
}
