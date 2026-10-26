/**
 * Text preparation for speech synthesis.
 *
 * Kept free of SillyTavern imports so it can be unit-tested standalone.
 */

/**
 * Turns a chat message into speakable text.
 *
 * Chat replies are full of markup that would otherwise be read out loud
 * verbatim, so the noise is removed before anything reaches the model.
 *
 * @param {string} raw Raw message text
 * @param {object} [options]
 * @param {boolean} [options.stripCode] Remove fenced code blocks
 * @param {boolean} [options.stripTags] Remove <tagged> blocks and stray tags
 * @param {boolean} [options.stripAsterisks] Remove *action* spans and emphasis markers
 * @param {(text: string) => string} [options.substitute] Macro substitution hook
 * @returns {string} Cleaned text, ready to synthesize
 */
export function sanitizeText(raw, options = {}) {
    const {
        stripCode = true,
        stripTags = true,
        stripAsterisks = true,
        substitute = null,
    } = options;

    let text = String(raw ?? '');

    if (typeof substitute === 'function') {
        try {
            text = substitute(text);
        } catch {
            /* keep the original text when macro substitution fails */
        }
    }

    if (stripCode) {
        text = text.replace(/```[\s\S]*?```/g, ' ').replace(/~~~[\s\S]*?~~~/g, ' ');
    }
    if (stripTags) {
        // <tagged>blocks</tagged> first, then self-closing and stray tags.
        text = text.replace(/<[^>]*>[\s\S]*?<\/[^>]*>/g, ' ');
        text = text.replace(/<[^>]*\/>/g, ' ');
        text = text.replace(/<[^>]*>/g, ' ');
    }
    if (stripAsterisks) {
        // Whole *action* spans first, then leftover emphasis markers.
        text = text.replace(/\*([^*\n]+)\*/g, ' ');
        text = text.replace(/[*_~`#>]+/g, '');
    }

    // Markdown headings / list bullets / block quotes.
    text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '');
    text = text.replace(/^\s{0,3}[-*+]\s+/gm, '');
    text = text.replace(/^\s{0,3}>\s?/gm, '');
    // Emoji and emoticons.
    text = text.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, ' ');

    return text.replace(/\s+/g, ' ').trim();
}

/**
 * Values that mean "read the whole message".
 *
 * The range is a free text field, so the default value has to be something
 * the user can read as "no restriction".
 */
const READ_ALL_VALUES = ['', '朗读', '全部', '朗读全部', 'all', 'none'];

/**
 * Splits the configured range into its opening and closing delimiter.
 *
 * The field is written the way a person would describe the range:
 *
 *   【朗读内容】   →  the outer characters are the delimiters, the text in
 *                    between is only a label for the human eye
 *   【】           →  the same, written as a plain pair
 *   【{内容}】     →  an explicit placeholder, the delimiters are whatever
 *                    surrounds it
 *
 * @param {string} range The configured value.
 * @returns {{open: string, close: string}|null} The delimiters, or null when
 *   the value means "read everything".
 */
export function parseReadRange(range) {
    const raw = String(range ?? '').trim();
    if (!raw) {
        return null;
    }
    if (READ_ALL_VALUES.includes(raw.toLowerCase())) {
        return null;
    }

    // An explicit placeholder wins: 【{内容}】 → 【 … 】
    const placeholder = /^(.*?)\{+(?:内容|content)\}+([\s\S]*)$/i.exec(raw);
    if (placeholder) {
        const open = placeholder[1];
        const close = placeholder[2];
        if (open && close) {
            return { open, close };
        }
    }

    if (raw.length === 1) {
        // A single character can only delimit a range ("between two pipes"),
        // and only if it is a punctuation mark — a letter would match text
        // by accident.
        return /[\p{L}\p{N}]/u.test(raw) ? null : { open: raw, close: raw };
    }

    const open = raw[0];
    const close = raw[raw.length - 1];
    // Letters and digits make no sense as a delimiter — the value is almost
    // certainly a mistake and guessing would only hide it.
    if (/[\p{L}\p{N}]/u.test(open) && /[\p{L}\p{N}]/u.test(close)) {
        return null;
    }
    return { open, close };
}

/**
 * Takes only the part of the text that is marked as the reading range.
 *
 * Every marked section is read — a message may have more than one. When the
 * range is not found at all the original text is returned, so the caller can
 * decide whether to fall back to reading everything.
 *
 * @param {string} text The text to cut down.
 * @param {string} range The configured range.
 * @returns {{text: string, found: boolean}} The selected text.
 */
export function extractReadRange(text, range) {
    const source = String(text ?? '');
    const parsed = parseReadRange(range);
    if (!parsed) {
        return { text: source, found: false };
    }

    const { open, close } = parsed;

    if (open === close) {
        // The same character opens and closes the range: the content between
        // the first two occurrences is the range.
        const start = source.indexOf(open);
        if (start < 0) {
            return { text: source, found: false };
        }
        const contentStart = start + open.length;
        const end = source.indexOf(close, contentStart);
        if (end < 0) {
            return { text: source.slice(contentStart), found: true };
        }
        return { text: source.slice(contentStart, end), found: true };
    }

    const parts = [];
    let from = 0;
    for (;;) {
        const start = source.indexOf(open, from);
        if (start < 0) {
            break;
        }
        const contentStart = start + open.length;
        const end = source.indexOf(close, contentStart);
        if (end < 0) {
            // The range was opened but never closed — take the rest.
            parts.push(source.slice(contentStart));
            break;
        }
        parts.push(source.slice(contentStart, end));
        from = end + close.length;
    }

    if (!parts.length) {
        return { text: source, found: false };
    }
    return { text: parts.join(' '), found: true };
}

/**
 * Wraps a text in the configured range markers.
 *
 * Used by the preview buttons, so that they demonstrate the range instead of
 * falling back to reading everything.
 *
 * @param {string} text
 * @param {string} range
 * @returns {string}
 */
export function wrapReadRange(text, range) {
    const parsed = parseReadRange(range);
    if (!parsed) {
        return String(text ?? '');
    }
    return `${parsed.open}${String(text ?? '')}${parsed.close}`;
}
