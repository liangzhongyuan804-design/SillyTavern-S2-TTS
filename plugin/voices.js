/**
 * Voice directory scanning for the S2 TTS server plugin.
 *
 * The voice folder is not a flat list any more: it can be arranged as a
 * three-level classification
 *
 *     voices/女/妩媚/生气.s2voice
 *     └── 性别 └── 性格 └── 语气
 *
 * so a new folder is a new option — nothing has to be registered anywhere.
 *
 * s2.cpp loads a voice profile from `<storage_dir>/<voice_id>.s2voice`, and
 * it builds that path from narrow std::string values. Windows converts them
 * with the ANSI code page, which on a Chinese system is GB2312 — a UTF-8 path
 * with Chinese characters therefore never reaches the file ("cannot open
 * voice profile", HTTP 500). Measured on this machine:
 *
 *     voice=F:\s2\s2.cpp\voices\女\妩媚\生气.s2voice   -> 500
 *     voice=F:\s2tts-stage\a1b2c3d4.s2voice             -> 200
 *
 * The workaround is to copy the profile into an ASCII-only staging directory
 * and hand s2.cpp that path. The copy is byte-identical and the original file
 * is never modified.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** How many directory levels the classification uses. */
export const MAX_LEVELS = 3;

/** File names that mark "the default voice of this folder". */
export const DEFAULT_NAMES = ['默认', 'default', 'Default', 'DEFAULT'];

/**
 * The extension of a saved voice profile.
 *
 * A `.s2voice` is not audio: it is the encoded reference (semantic codes plus
 * the transcript) in a small binary container, so s2.cpp can clone the voice
 * without touching the audio again.
 */
export const PROFILE_EXTENSION = '.s2voice';

/**
 * The audio formats that may be used as a voice directly.
 *
 * s2.cpp clones a voice from a reference recording, and it decodes WAV and MP3
 * from memory, so a plain audio file in the voice folder works as a voice — no
 * conversion step, no extra tool.
 */
export const AUDIO_EXTENSIONS = ['.wav', '.mp3'];

/**
 * The extension of the plain text file that holds the transcript of an audio
 * voice.
 *
 * s2.cpp needs a word-by-word transcript of the reference audio to clone a
 * voice, and it refuses to synthesize without one. The transcript therefore
 * lives next to the audio file, under the same name:
 *
 *     voices/女/妩媚/温柔.wav
 *     voices/女/妩媚/温柔.txt
 */
export const TRANSCRIPT_EXTENSION = '.txt';

/** True when the path only uses characters that survive the ANSI round-trip. */
export function isAsciiPath(value) {
    return /^[\x00-\x7F]*$/.test(String(value ?? ''));
}

/**
 * True when the file name carries an audio extension.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isAudioPath(value) {
    const lower = String(value ?? '').trim().toLowerCase();
    return AUDIO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * True when the file name carries the voice profile extension.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isProfilePath(value) {
    return String(value ?? '').trim().toLowerCase().endsWith(PROFILE_EXTENSION);
}

/**
 * True when the file can be used as a voice at all.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isVoiceFile(value) {
    return isProfilePath(value) || isAudioPath(value);
}

/** True when the name marks the default entry of a folder. */
export function isDefaultName(name) {
    return DEFAULT_NAMES.includes(String(name ?? ''));
}

/**
 * An empty classification result.
 *
 * @returns {{speaker: null, gender: null, personality: null, tone: null}}
 */
export function emptyTags() {
    return { speaker: null, gender: null, personality: null, tone: null };
}

/**
 * Builds the absolute path of a voice file from the request fields.
 *
 * s2.cpp accepts two shapes for a saved profile: a bare id (`voice=sao`,
 * looked up in `voice_dir`) and a path to a `.s2voice` file. Both are turned
 * into an absolute file path here so the staging step has something to work
 * with.
 *
 * Audio files are a third shape: they are never handed to s2.cpp as a path at
 * all — the plugin reads the bytes and uploads them as a reference recording —
 * but the absolute path is still resolved here so the file can be found.
 *
 * @param {object} fields
 * @param {string} [fields.voice] Voice id or path.
 * @param {string} [fields.voiceDir] Voice directory.
 * @returns {string|null} Absolute path, or null when it cannot be determined.
 */
export function resolveVoiceFile({ voice, voiceDir } = {}) {
    const raw = String(voice ?? '').trim();
    if (!raw) {
        return null;
    }
    if (isVoiceFile(raw)) {
        if (path.isAbsolute(raw)) {
            return raw;
        }
        const dir = String(voiceDir ?? '').trim();
        return dir ? path.resolve(dir, raw) : path.resolve(raw);
    }
    const dir = String(voiceDir ?? '').trim();
    if (!dir) {
        // s2.cpp falls back to its own --voice-dir; there is nothing to stage.
        return null;
    }
    return path.resolve(dir, `${raw}.s2voice`);
}

/**
 * Reads the transcript that belongs to an audio voice.
 *
 * The transcript is the plain text file next to the audio file, under the same
 * name. s2.cpp needs a word-by-word transcript of the reference recording to
 * clone a voice, so an audio voice without one cannot be used.
 *
 * @param {string} audioPath Absolute path of the audio file.
 * @returns {string} The transcript, or an empty string when there is none.
 */
export function readTranscript(audioPath) {
    const source = String(audioPath ?? '').trim();
    if (!source) {
        return '';
    }
    const dir = path.dirname(source);
    const stem = path.basename(source, path.extname(source));
    try {
        return readFileSync(path.join(dir, `${stem}${TRANSCRIPT_EXTENSION}`), 'utf8').trim();
    } catch {
        return '';
    }
}

/**
 * Writes the transcript of an audio voice next to the audio file.
 *
 * @param {string} audioPath Absolute path of the audio file.
 * @param {string} text The transcript.
 * @returns {string|null} The path of the transcript file, or null on failure.
 */
export function writeTranscript(audioPath, text) {
    const source = String(audioPath ?? '').trim();
    if (!source || !isAudioPath(source)) {
        return null;
    }
    const dir = path.dirname(source);
    const stem = path.basename(source, path.extname(source));
    const target = path.join(dir, `${stem}${TRANSCRIPT_EXTENSION}`);
    try {
        writeFileSync(target, `${String(text ?? '').trim()}\n`, 'utf8');
        return target;
    } catch {
        return null;
    }
}

/**
 * Returns a path that s2.cpp can actually open.
 *
 * ASCII paths are passed through untouched. Everything else is copied into
 * the staging directory under a name derived from the source path, so the
 * same source always maps to the same staged file (and therefore to the same
 * cache entry).
 *
 * @param {string} sourcePath Absolute path of the `.s2voice` file.
 * @param {string} stagingDir ASCII-only directory for the copies.
 * @returns {string|null} A usable path, or null when staging is impossible.
 */
export function stageVoiceFile(sourcePath, stagingDir) {
    const source = String(sourcePath ?? '').trim();
    if (!source) {
        return null;
    }
    if (isAsciiPath(source)) {
        return source;
    }
    const dir = String(stagingDir ?? '').trim();
    if (!dir || !isAsciiPath(dir)) {
        return null;
    }
    const id = createHash('sha256').update(source.toLowerCase()).digest('hex').slice(0, 16);
    const target = path.join(dir, `${id}.s2voice`);
    try {
        mkdirSync(dir, { recursive: true });
        const sourceStat = statSync(source);
        let outdated = true;
        try {
            const targetStat = statSync(target);
            // The copy is newer than its source, so a newer source means the
            // user replaced the profile and the copy has to be refreshed.
            outdated = sourceStat.size !== targetStat.size
                || sourceStat.mtimeMs > targetStat.mtimeMs;
        } catch {
            outdated = true;
        }
        if (outdated) {
            copyFileSync(source, target);
        }
        return target;
    } catch {
        return null;
    }
}

/**
 * Describes one voice file inside the classification.
 *
 * @param {string} filePath Absolute path of the file.
 * @param {string} fileName File name.
 * @param {string} stem File name without the extension.
 * @param {string[]} dirs Names of the directories above the file.
 * @returns {object} The entry.
 */
function describeEntry(filePath, fileName, stem, dirs) {
    const depth = dirs.length + 1;
    const entry = {
        rel: '',
        path: filePath,
        name: fileName,
        stem,
        depth,
        gender: null,
        personality: null,
        tone: null,
        classified: false,
        // 'profile' is a saved .s2voice, 'audio' is a recording that is cloned
        // on the fly and therefore needs a transcript.
        kind: isProfilePath(fileName) ? 'profile' : 'audio',
        ext: path.extname(fileName).toLowerCase(),
        // The transcript of an audio voice, read from the text file next to it.
        transcript: '',
    };
    if (dirs.length === 1) {
        // voices/女/生气.s2voice — no personality level.
        entry.gender = dirs[0];
        entry.tone = stem;
        entry.classified = true;
    } else if (dirs.length === 2) {
        // voices/女/妩媚/生气.s2voice — the full classification.
        entry.gender = dirs[0];
        entry.personality = dirs[1];
        entry.tone = stem;
        entry.classified = true;
    } else if (dirs.length >= MAX_LEVELS) {
        // Deeper than the three levels — listed, but not tag-matchable.
        entry.gender = dirs[0];
        entry.personality = dirs[1];
        entry.tone = dirs[2];
        entry.classified = false;
    }
    return entry;
}

/**
 * Scans the voice directory and returns the whole classification.
 *
 * @param {string} dir Voice directory.
 * @returns {object} `{exists, dir, entries, tree, names}`.
 */
export function scanVoiceTree(dir) {
    const root = String(dir ?? '').trim();
    const empty = {
        exists: false,
        dir: root,
        entries: [],
        tree: null,
        names: { gender: [], personality: [], tone: [] },
    };
    if (!root) {
        return empty;
    }
    try {
        if (!statSync(root).isDirectory()) {
            return empty;
        }
    } catch {
        return empty;
    }

    const entries = [];
    const tree = { type: 'dir', name: '', path: root, children: [] };
    const genderNames = new Set();
    const personalityNames = new Set();
    const toneNames = new Set();

    const walk = (current, node, dirs) => {
        let items;
        try {
            items = readdirSync(current, { withFileTypes: true });
        } catch {
            return;
        }
        items.sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' }));
        for (const item of items) {
            const full = path.join(current, item.name);
            if (item.isDirectory()) {
                const child = { type: 'dir', name: item.name, path: full, children: [] };
                node.children.push(child);
                const depth = dirs.length + 1;
                if (depth === 1) {
                    genderNames.add(item.name);
                } else if (depth === 2) {
                    personalityNames.add(item.name);
                } else if (depth === MAX_LEVELS) {
                    toneNames.add(item.name);
                }
                walk(full, child, [...dirs, item.name]);
                continue;
            }
            if (!item.isFile() || !isVoiceFile(item.name)) {
                continue;
            }
            const stem = item.name.replace(/\.(s2voice|wav|mp3)$/i, '');
            const entry = describeEntry(full, item.name, stem, dirs);
            entry.rel = path.relative(root, full);
            if (entry.kind === 'audio') {
                entry.transcript = readTranscript(full);
            }
            node.children.push({
                type: 'file',
                name: item.name,
                stem,
                path: full,
                kind: entry.kind,
            });
            entries.push(entry);
            if (entry.classified) {
                if (entry.gender) {
                    genderNames.add(entry.gender);
                }
                if (entry.personality) {
                    personalityNames.add(entry.personality);
                }
                if (entry.tone) {
                    toneNames.add(entry.tone);
                }
            }
        }
    };

    walk(root, tree, []);

    const sorted = (set) => [...set].sort((a, b) => String(a).localeCompare(String(b), undefined, { sensitivity: 'base' }));

    return {
        exists: true,
        dir: root,
        entries,
        tree,
        names: {
            gender: sorted(genderNames),
            personality: sorted(personalityNames),
            tone: sorted(toneNames),
        },
    };
}

/**
 * Picks a directory that can hold the staged copies.
 *
 * The candidates are tried in order and the first ASCII-only one that can be
 * created wins — a data directory with Chinese characters in its path would
 * defeat the whole staging idea.
 *
 * @param {string[]} candidates
 * @returns {string|null}
 */
export function pickStagingDir(candidates = []) {
    for (const candidate of candidates) {
        const dir = String(candidate ?? '').trim();
        if (!dir || !isAsciiPath(dir)) {
            continue;
        }
        try {
            mkdirSync(dir, { recursive: true });
            return dir;
        } catch {
            /* try the next candidate */
        }
    }
    return null;
}

/**
 * True when the path exists and is a file.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isFile(value) {
    try {
        return statSync(String(value)).isFile();
    } catch {
        return false;
    }
}

/**
 * True when the path exists.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function exists(value) {
    return existsSync(String(value));
}
