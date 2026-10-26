/**
 * Tag-driven voice selection.
 *
 * A chat reply may open with a tag block that names the voice to use:
 *
 *     小雅·女·妩媚·生气·：“你怎么才来！”
 *     └─ 名字 └性别 └性格 └语气 └── 台词
 *
 * The segments are separated by "·" (U+00B7) and the block ends with a
 * colon. Everything after the colon is the line to speak; the block itself
 * is never read out loud.
 *
 * The tags are matched against the folder structure of the voice directory:
 *
 *     voices/女/妩媚/生气.s2voice
 *
 * so a new folder is a new option — nothing has to be registered anywhere.
 *
 * The functions here are pure and free of SillyTavern imports, so they can
 * be unit-tested on their own.
 */

/** The separator between the tag segments. */
export const TAG_SEPARATOR = '·';

/**
 * Separator characters that are accepted.
 *
 * U+00B7 is the one used in the examples; the others are the look-alikes
 * that show up when text is copied through other editors.
 */
export const TAG_SEPARATORS = ['·', '・', '‧'];

/** Colon characters that end the tag block. */
export const TAG_COLONS = ['：', ':'];

/** File names that mark the default voice of a folder. */
export const DEFAULT_NAMES = ['默认', 'default', 'Default', 'DEFAULT'];

/**
 * An empty tag set.
 *
 * @returns {{speaker: null, gender: null, personality: null, tone: null}}
 */
export function emptyTags() {
    return { speaker: null, gender: null, personality: null, tone: null };
}

/** True when the name marks the default entry of a folder. */
export function isDefaultName(name) {
    return DEFAULT_NAMES.includes(String(name ?? ''));
}

/**
 * Splits a comma / semicolon / newline separated list into names.
 *
 * @param {string|string[]|null} value
 * @returns {string[]}
 */
export function splitNameList(value) {
    if (Array.isArray(value)) {
        return value.map((item) => String(item ?? '').trim()).filter(Boolean);
    }
    return String(value ?? '')
        .split(/[,，;；\n\r]+/)
        .map((item) => item.trim())
        .filter(Boolean);
}

/**
 * Splits the leading tag block off the text.
 *
 * The block has to be at the very beginning of the message and has to end
 * with a colon. A sentence that merely contains a "·" is not a tag block.
 *
 * @param {string} raw Message text.
 * @param {object} [options]
 * @param {number} [options.maxHeadLength] How far to look for the colon.
 * @param {number} [options.maxSegmentLength] Longest accepted tag segment.
 * @returns {{segments: string[], text: string}|null}
 */
export function splitTagBlock(raw, options = {}) {
    const maxHeadLength = options.maxHeadLength ?? 60;
    const maxSegmentLength = options.maxSegmentLength ?? 24;
    const text = String(raw ?? '');
    const head = text.slice(0, maxHeadLength);

    let colon = -1;
    for (let index = 0; index < head.length; index++) {
        if (TAG_COLONS.includes(head[index])) {
            colon = index;
            break;
        }
    }
    if (colon < 0) {
        return null;
    }

    const tagPart = text.slice(0, colon);
    if (!TAG_SEPARATORS.some((separator) => tagPart.includes(separator))) {
        return null;
    }

    const segments = tagPart
        .split(new RegExp(`[${TAG_SEPARATORS.join('')}]`))
        .map((segment) => segment.trim())
        .filter((segment) => segment.length > 0);
    if (segments.length === 0) {
        return null;
    }
    // A long segment is a sentence, not a tag.
    if (segments.some((segment) => segment.length > maxSegmentLength)) {
        return null;
    }

    return { segments, text: text.slice(colon + 1).replace(/^\s+/, '') };
}

/**
 * Collects the names that may be used as a tag.
 *
 * The names come from the voice tree — a folder name is a tag — plus the
 * user's own list, which makes it possible to use a tag before the matching
 * voice has been created.
 *
 * @param {object[]} entries Entries as returned by the voice tree.
 * @param {object} [custom] Extra names per level.
 * @param {string|string[]} [custom.gender]
 * @param {string|string[]} [custom.personality]
 * @param {string|string[]} [custom.tone]
 * @returns {{gender: Set<string>, personality: Set<string>, tone: Set<string>}}
 */
export function buildKnownSets(entries = [], custom = {}) {
    const gender = new Set();
    const personality = new Set();
    const tone = new Set();

    for (const entry of entries ?? []) {
        if (!entry) {
            continue;
        }
        if (entry.gender) {
            gender.add(entry.gender);
        }
        if (entry.personality) {
            personality.add(entry.personality);
        }
        if (entry.tone && entry.classified !== false) {
            tone.add(entry.tone);
        }
    }

    for (const name of splitNameList(custom.gender)) {
        gender.add(name);
    }
    for (const name of splitNameList(custom.personality)) {
        personality.add(name);
    }
    for (const name of splitNameList(custom.tone)) {
        tone.add(name);
    }

    return { gender, personality, tone };
}

/**
 * Assigns the segments of a tag block to the levels.
 *
 * The most specific reading is tried first — 名字·性别·性格·语气 — and the
 * shorter forms are accepted as well. A segment that is not a known category
 * becomes the speaker name.
 *
 * @param {string[]} segments
 * @param {{gender: Set<string>, personality: Set<string>, tone: Set<string>}} known
 * @returns {{speaker: string|null, gender: string|null, personality: string|null, tone: string|null}}
 */
export function assignTags(segments = [], known = {}) {
    const tags = emptyTags();
    const gender = known.gender ?? new Set();
    const personality = known.personality ?? new Set();
    const tone = known.tone ?? new Set();
    const has = (set, value) => set.has(value);
    const count = segments.length;

    // 名字·性别·性格·语气
    if (count >= 4
        && has(gender, segments[1])
        && has(personality, segments[2])
        && has(tone, segments[3])) {
        tags.speaker = segments[0];
        tags.gender = segments[1];
        tags.personality = segments[2];
        tags.tone = segments[3];
        return tags;
    }

    // 性别·性格·语气
    if (count >= 3
        && has(gender, segments[0])
        && has(personality, segments[1])
        && has(tone, segments[2])) {
        tags.gender = segments[0];
        tags.personality = segments[1];
        tags.tone = segments[2];
        return tags;
    }

    // 性别·语气
    if (count >= 2 && has(gender, segments[0]) && has(tone, segments[1])) {
        tags.gender = segments[0];
        tags.tone = segments[1];
        return tags;
    }

    // 性别
    if (count === 1 && has(gender, segments[0])) {
        tags.gender = segments[0];
        return tags;
    }

    // Anything else: the first segment that fits a free slot wins, and the
    // first unknown segment becomes the speaker name.
    for (const segment of segments) {
        if (!tags.gender && has(gender, segment)) {
            tags.gender = segment;
            continue;
        }
        if (!tags.personality && has(personality, segment)) {
            tags.personality = segment;
            continue;
        }
        if (!tags.tone && has(tone, segment)) {
            tags.tone = segment;
            continue;
        }
        if (!tags.speaker) {
            tags.speaker = segment;
        }
    }

    return tags;
}

/**
 * Parses the tag block of a message.
 *
 * A block is only acted upon when at least one of its segments is a known
 * category — otherwise the text is left alone, so a sentence that happens to
 * contain a "·" is never mangled.
 *
 * @param {string} raw Message text.
 * @param {{gender: Set<string>, personality: Set<string>, tone: Set<string>}} known
 * @param {object} [options]
 * @param {boolean} [options.stripUnknown] Also strip a block that matches
 *   nothing — the tags are then not read out loud either.
 * @returns {{tags: object, text: string, matched: boolean, block: boolean}}
 */
export function parseTags(raw, known, options = {}) {
    const block = splitTagBlock(raw, options);
    if (!block) {
        return { tags: emptyTags(), text: String(raw ?? ''), matched: false, block: false };
    }

    const tags = assignTags(block.segments, known);
    const matched = Boolean(tags.gender || tags.personality || tags.tone);
    if (!matched && !options.stripUnknown) {
        return { tags, text: String(raw ?? ''), matched: false, block: true };
    }
    return { tags, text: block.text, matched, block: true };
}

/**
 * Picks the best candidate out of a list.
 *
 * The default of a folder wins over its siblings, a more general folder wins
 * over a deeper one, and the rest is decided alphabetically so the choice is
 * reproducible.
 *
 * @param {object[]} candidates
 * @returns {object|null}
 */
function pickBest(candidates) {
    const sorted = [...candidates].sort((a, b) => {
        const aDefault = isDefaultName(a.tone) ? 0 : 1;
        const bDefault = isDefaultName(b.tone) ? 0 : 1;
        if (aDefault !== bDefault) {
            return aDefault - bDefault;
        }
        const aDepth = a.depth ?? 99;
        const bDepth = b.depth ?? 99;
        if (aDepth !== bDepth) {
            return aDepth - bDepth;
        }
        return String(a.rel ?? a.path ?? '').localeCompare(String(b.rel ?? b.path ?? ''), undefined, { sensitivity: 'base' });
    });
    return sorted[0] ?? null;
}

/**
 * Finds the voice that matches the tags.
 *
 * The search walks down from the most specific match to the most general
 * one, so a missing 语气 still gets the right 性别/性格 folder:
 *
 *   1. 性别 + 性格 + 语气
 *   2. 性别 + 性格 (any 语气)
 *   3. 性别 (a file directly in the 性别 folder)
 *   4. 性别 (any 性格)
 *   5. anything
 *
 * @param {{gender: string|null, personality: string|null, tone: string|null}} tags
 * @param {object[]} entries Entries as returned by the voice tree.
 * @returns {object|null} The chosen entry, with a `reason` field.
 */
export function resolveTagVoice(tags = {}, entries = []) {
    const classified = (entries ?? []).filter((entry) => entry && entry.path && entry.classified !== false);
    if (!classified.length) {
        return null;
    }

    const gender = tags.gender ?? null;
    const personality = tags.personality ?? null;
    const tone = tags.tone ?? null;

    // Without a single tag there is nothing to look for.
    if (!gender && !personality && !tone) {
        return null;
    }

    const steps = [
        {
            reason: 'exact',
            filter: (entry) => (!gender || entry.gender === gender)
                && (!personality || entry.personality === personality)
                && (!tone || entry.tone === tone),
        },
        {
            reason: 'tone',
            filter: (entry) => (!gender || entry.gender === gender)
                && (!personality || entry.personality === personality),
        },
        {
            reason: 'gender-default',
            filter: (entry) => (!gender || entry.gender === gender) && !entry.personality,
        },
        {
            reason: 'gender',
            filter: (entry) => !gender || entry.gender === gender,
        },
        {
            reason: 'any',
            filter: () => true,
        },
    ];

    for (const step of steps) {
        const candidates = classified.filter(step.filter);
        if (candidates.length) {
            const best = pickBest(candidates);
            if (best) {
                return { ...best, reason: step.reason };
            }
        }
    }
    return null;
}

/**
 * Human readable form of a tag set, for the log and the panel.
 *
 * @param {object} tags
 * @returns {string}
 */
export function describeTags(tags = {}) {
    const parts = [tags.gender, tags.personality, tags.tone].filter(Boolean);
    if (tags.speaker) {
        parts.unshift(tags.speaker);
    }
    return parts.join(' / ');
}

/**
 * Builds the example tag block for a tag set.
 *
 * @param {object} tags
 * @param {object} [options]
 * @param {string} [options.text] The line the block is put in front of.
 * @returns {string}
 */
export function formatTagBlock(tags = {}, options = {}) {
    const parts = [tags.speaker, tags.gender, tags.personality, tags.tone].filter(Boolean);
    const text = String(options.text ?? '你好。');
    return `${parts.join(TAG_SEPARATOR)}${TAG_SEPARATOR}：${text}`;
}
