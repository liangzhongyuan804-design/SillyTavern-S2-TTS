/**
 * Tests for the tag driven voice selection.
 *
 * Two independent parts are covered:
 *
 *   - voicetree.js  parses the tag block of a reply and turns the
 *     tags into a voice (pure functions, no SillyTavern involved)
 *   - plugin/voices.js        reads the voice directory as a three-level
 *     classification and copies profiles with Chinese names into an
 *     ASCII-only directory, because s2.cpp cannot open them otherwise
 *
 *   node test/voicetree.mjs
 *
 * The same tests run as part of the full suite (`test/run.mjs`).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    assignTags,
    buildKnownSets,
    describeTags,
    formatTagBlock,
    parseTags,
    resolveTagVoice,
    splitNameList,
    splitTagBlock,
} from '../voicetree.js';
import {
    isAsciiPath,
    isAudioPath,
    isProfilePath,
    isVoiceFile,
    pickStagingDir,
    readTranscript,
    resolveVoiceFile,
    scanVoiceTree,
    stageVoiceFile,
    writeTranscript,
} from '../plugin/voices.js';

/** The classification used by the tests. */
const ENTRIES = [
    { rel: 'sao.s2voice', path: 'V\\sao.s2voice', stem: 'sao', depth: 1, gender: null, personality: null, tone: null, classified: false },
    { rel: '女\\妩媚\\生气.s2voice', path: 'V\\女\\妩媚\\生气.s2voice', stem: '生气', depth: 3, gender: '女', personality: '妩媚', tone: '生气', classified: true },
    { rel: '女\\妩媚\\默认.s2voice', path: 'V\\女\\妩媚\\默认.s2voice', stem: '默认', depth: 3, gender: '女', personality: '妩媚', tone: '默认', classified: true },
    { rel: '女\\高冷\\默认.s2voice', path: 'V\\女\\高冷\\默认.s2voice', stem: '默认', depth: 3, gender: '女', personality: '高冷', tone: '默认', classified: true },
    { rel: '女\\活泼\\开心.s2voice', path: 'V\\女\\活泼\\开心.s2voice', stem: '开心', depth: 3, gender: '女', personality: '活泼', tone: '开心', classified: true },
    { rel: '男\\阳光\\默认.s2voice', path: 'V\\男\\阳光\\默认.s2voice', stem: '默认', depth: 3, gender: '男', personality: '阳光', tone: '默认', classified: true },
];

const KNOWN = buildKnownSets(ENTRIES, {});

/**
 * Runs every tag-selection test.
 *
 * @param {(name: string, condition: boolean, detail?: string) => void} check
 */
export async function runVoiceTreeTests(check) {
    /* ------------------------------------------------------ tag block */

    console.log('\n[tag block]');
    {
        const block = splitTagBlock('小雅·女·妩媚·生气·：“你怎么才来！”');
        check('the tag block is split off', !!block);
        check('every segment is found',
            JSON.stringify(block?.segments) === JSON.stringify(['小雅', '女', '妩媚', '生气']),
            JSON.stringify(block?.segments));
        check('the line behind the colon is kept', block?.text === '“你怎么才来！”', block?.text);
    }
    {
        check('a plain sentence is not a tag block', splitTagBlock('你好，今天天气不错。') === null);
        check('a name and a colon are not a tag block', splitTagBlock('小雅：你好啊') === null);
        check('a time is not a tag block', splitTagBlock('12:30 该出发了') === null);
        check('text without a colon is not a tag block', splitTagBlock('·你好·世界') === null);
        check('a long head is not a tag block',
            splitTagBlock('这是一句很长很长的回复内容用来测试标签解析：后面还有更多文字') === null);
    }

    /* ---------------------------------------------------------- tags */

    console.log('\n[tag parsing]');
    {
        const parsed = parseTags('小雅·女·妩媚·生气·：“你怎么才来！”', KNOWN);
        check('the speaker is recognized', parsed.tags.speaker === '小雅', parsed.tags.speaker);
        check('the gender is recognized', parsed.tags.gender === '女', parsed.tags.gender);
        check('the personality is recognized', parsed.tags.personality === '妩媚', parsed.tags.personality);
        check('the tone is recognized', parsed.tags.tone === '生气', parsed.tags.tone);
        check('the tags count as a match', parsed.matched === true);
        check('the tag block is removed from the text', parsed.text === '“你怎么才来！”', parsed.text);
    }
    {
        const parsed = parseTags('女·妩媚·生气·：“你好”', KNOWN);
        check('the speaker is optional', parsed.tags.speaker === null, String(parsed.tags.speaker));
        check('the three levels are still found',
            parsed.tags.gender === '女' && parsed.tags.personality === '妩媚' && parsed.tags.tone === '生气');
    }
    {
        const parsed = parseTags('女·生气·：“你好”', KNOWN);
        check('a missing personality is allowed',
            parsed.tags.gender === '女' && parsed.tags.personality === null && parsed.tags.tone === '生气',
            describeTags(parsed.tags));
    }
    {
        const parsed = parseTags('女·：“你好”', KNOWN);
        check('only the gender is given',
            parsed.tags.gender === '女' && parsed.tags.tone === null && parsed.tags.personality === null,
            describeTags(parsed.tags));
    }
    {
        const parsed = parseTags('小雅·女·妩媚·生气·：“你好”', KNOWN, { stripUnknown: true });
        check('the strip happens before the voice is chosen', parsed.text === '“你好”', parsed.text);
    }
    {
        // A sentence that happens to contain a "·" must survive untouched.
        const parsed = parseTags('·你好·世界·：这是一句话', KNOWN);
        check('an unknown tag block is left alone', parsed.matched === false);
        check('an unknown tag block keeps the text', parsed.text === '·你好·世界·：这是一句话', parsed.text);
    }
    {
        const parsed = parseTags('·你好·世界·：这是一句话', KNOWN, { stripUnknown: true });
        check('an unknown tag block can be stripped on request', parsed.text === '这是一句话', parsed.text);
    }
    {
        const parsed = parseTags('今天·真热·啊', KNOWN);
        check('text without a colon is never touched', parsed.text === '今天·真热·啊', parsed.text);
    }
    {
        const tags = assignTags(['小雅', '女', '妩媚', '生气'], KNOWN);
        check('the levels are assigned in order',
            tags.gender === '女' && tags.personality === '妩媚' && tags.tone === '生气');
        check('an unknown segment becomes the speaker', assignTags(['小雅', '女'], KNOWN).speaker === '小雅');
    }
    {
        const known = buildKnownSets([], { gender: '女', personality: '妩媚,高冷', tone: ['生气'] });
        check('custom names are accepted', known.gender.has('女') && known.personality.has('高冷') && known.tone.has('生气'));
        check('custom lists are split', JSON.stringify(splitNameList('a, b；c')) === JSON.stringify(['a', 'b', 'c']));
    }
    {
        const known = buildKnownSets(ENTRIES, {});
        check('the folder names become the known tags',
            known.gender.has('女') && known.gender.has('男')
            && known.personality.has('妩媚') && known.personality.has('阳光')
            && known.tone.has('生气') && known.tone.has('默认'));
        check('an unclassified profile is not a tag', !known.tone.has('sao'));
    }
    {
        check('the tag block can be built again',
            formatTagBlock({ speaker: '小雅', gender: '女', personality: '妩媚', tone: '生气' }, { text: '你好' })
                === '小雅·女·妩媚·生气·：你好');
    }

    /* -------------------------------------------------- voice selection */

    console.log('\n[voice selection]');
    {
        const found = resolveTagVoice({ gender: '女', personality: '妩媚', tone: '生气' }, ENTRIES);
        check('the exact voice is found', found?.rel === '女\\妩媚\\生气.s2voice', found?.rel);
        check('the exact match is reported', found?.reason === 'exact', found?.reason);
    }
    {
        // 生气 does not exist under 活泼 — the folder's default wins.
        const found = resolveTagVoice({ gender: '女', personality: '活泼', tone: '生气' }, ENTRIES);
        check('a missing tone falls back to the default of the folder',
            found?.rel === '女\\活泼\\开心.s2voice', found?.rel);
    }
    {
        const found = resolveTagVoice({ gender: '女', personality: '妩媚', tone: '开心' }, ENTRIES);
        check('the default of the folder wins over its siblings',
            found?.rel === '女\\妩媚\\默认.s2voice', found?.rel);
    }
    {
        const found = resolveTagVoice({ gender: '女', personality: '高冷' }, ENTRIES);
        check('a folder without a tone is found', found?.rel === '女\\高冷\\默认.s2voice', found?.rel);
    }
    {
        // 妩媚 only exists under 女 — the gender decides the folder.
        const found = resolveTagVoice({ gender: '男', personality: '妩媚', tone: '生气' }, ENTRIES);
        check('a wrong combination falls back to the gender',
            found?.rel === '男\\阳光\\默认.s2voice', found?.rel);
    }
    {
        const found = resolveTagVoice({ gender: '女' }, ENTRIES);
        check('the gender alone is enough', !!found, found?.rel);
    }
    {
        const found = resolveTagVoice({ tone: '生气' }, ENTRIES);
        check('a single tag is enough', found?.rel === '女\\妩媚\\生气.s2voice', found?.rel);
    }
    {
        check('without any tag nothing is chosen', resolveTagVoice({}, ENTRIES) === null);
        check('an empty tree has no voice', resolveTagVoice({ gender: '女' }, []) === null);
    }
    {
        check('the tags can be described', describeTags({ gender: '女', personality: '妩媚', tone: '生气' }) === '女 / 妩媚 / 生气');
    }

    /* ------------------------------------------------------ voice tree */

    console.log('\n[voice tree]');
    const root = mkdtempSync(path.join(os.tmpdir(), 's2tts-tree-'));
    try {
        const layout = [
            'sao.s2voice',
            path.join('女', '妩媚', '生气.s2voice'),
            path.join('女', '妩媚', '默认.s2voice'),
            path.join('女', '高冷', '默认.s2voice'),
            path.join('男', '阳光', '默认.s2voice'),
            path.join('女', '活泼', '开心.s2voice'),
        ];
        for (const rel of layout) {
            const full = path.join(root, rel);
            mkdirSync(path.dirname(full), { recursive: true });
            writeFileSync(full, `profile:${rel}`);
        }
        // A recording is a voice as well: it is cloned from the audio itself.
        const recording = path.join(root, '女', '妩媚', '温柔.wav');
        writeFileSync(recording, 'RIFF....WAVE');
        writeFileSync(path.join(root, '女', '妩媚', '温柔.txt'), '你好呀，这是这段录音念出来的字。');
        // A file that is neither a profile nor a recording must be ignored.
        writeFileSync(path.join(root, 'readme.txt'), 'nope');
        writeFileSync(path.join(root, 'notes.md'), 'nope');

        const scan = scanVoiceTree(root);
        check('the directory is found', scan.exists === true);
        check('every voice is listed', scan.entries.length === layout.length + 1, `${scan.entries.length}`);
        check('the other files are ignored',
            scan.entries.every((entry) => entry.name.endsWith('.s2voice') || entry.name.endsWith('.wav')));
        check('the gender is read from the first folder',
            scan.entries.find((e) => e.stem === '生气')?.gender === '女');
        check('the personality is read from the second folder',
            scan.entries.find((e) => e.stem === '生气')?.personality === '妩媚');
        check('the tone is read from the file name',
            scan.entries.find((e) => e.stem === '生气')?.tone === '生气');
        check('a profile in the root is not classified',
            scan.entries.find((e) => e.stem === 'sao')?.classified === false);
        check('the tag names are collected',
            scan.names.gender.includes('女') && scan.names.gender.includes('男')
            && scan.names.personality.includes('妩媚')
            && scan.names.tone.includes('生气')
            && scan.names.tone.includes('默认'),
            JSON.stringify(scan.names));
        check('the tree has the folders', scan.tree.children.length === 3, `${scan.tree.children.length}`);

        // The tree is what the tag matching works on.
        const known = buildKnownSets(scan.entries, {});
        const parsed = parseTags('小雅·女·妩媚·生气·：“你好”', known);
        const found = resolveTagVoice(parsed.tags, scan.entries);
        check('a tag picks a voice out of the tree', found?.rel === path.join('女', '妩媚', '生气.s2voice'), found?.rel);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }

    /* -------------------------------------------------- audio voices */
    //
    // A .s2voice is a saved profile; a .wav / .mp3 is a plain recording that
    // s2.cpp clones from the audio itself. The recording therefore needs the
    // word-by-word transcript of what was said in it, which lives in the text
    // file next to it.

    console.log('\n[audio voices]');
    {
        const dir = mkdtempSync(path.join(os.tmpdir(), 's2tts-audio-'));
        try {
            const wav = path.join(dir, '女', '妩媚', '温柔.wav');
            mkdirSync(path.dirname(wav), { recursive: true });
            writeFileSync(wav, 'RIFF....WAVE');
            writeFileSync(path.join(dir, '女', '妩媚', '温柔.txt'), '你好呀，这是这段录音念出来的字。\n');
            const mp3 = path.join(dir, '女', '高冷', '默认.mp3');
            mkdirSync(path.dirname(mp3), { recursive: true });
            writeFileSync(mp3, 'ID3....mp3');
            const profile = path.join(dir, '女', '高冷', '默认.s2voice');
            writeFileSync(profile, 'profile');

            check('a wav is an audio voice', isAudioPath(wav) === true);
            check('an mp3 is an audio voice', isAudioPath(mp3) === true);
            check('a profile is not an audio voice', isAudioPath(profile) === false);
            check('a profile is a profile', isProfilePath(profile) === true);
            check('both kinds are voice files', isVoiceFile(wav) && isVoiceFile(mp3) && isVoiceFile(profile));
            check('a text file is no voice', isVoiceFile(path.join(dir, '温柔.txt')) === false);

            check('the transcript is read from the sidecar', readTranscript(wav) === '你好呀，这是这段录音念出来的字。',
                readTranscript(wav));
            check('a recording without a sidecar has no transcript', readTranscript(mp3) === '');

            const written = writeTranscript(mp3, '这是默认的录音。');
            check('the transcript is written next to the recording', written === path.join(dir, '女', '高冷', '默认.txt'),
                String(written));
            check('the written transcript is read back', readTranscript(mp3) === '这是默认的录音。', readTranscript(mp3));

            // The scan has to tell the two kinds apart and to carry the
            // transcript along, because the extension shows it in the panel.
            const scan = scanVoiceTree(dir);
            const wavEntry = scan.entries.find((entry) => entry.name === '温柔.wav');
            const mp3Entry = scan.entries.find((entry) => entry.name === '默认.mp3');
            const profileEntry = scan.entries.find((entry) => entry.name === '默认.s2voice');
            check('the recording is marked as an audio voice', wavEntry?.kind === 'audio', wavEntry?.kind);
            check('the profile is marked as a profile', profileEntry?.kind === 'profile', profileEntry?.kind);
            check('the recording carries its transcript',
                wavEntry?.transcript === '你好呀，这是这段录音念出来的字。', wavEntry?.transcript);
            check('the recording is classified like a profile',
                wavEntry?.gender === '女' && wavEntry?.personality === '妩媚' && wavEntry?.tone === '温柔',
                `${wavEntry?.gender}/${wavEntry?.personality}/${wavEntry?.tone}`);
            check('the tone of a recording becomes a tag name', scan.names.tone.includes('温柔'),
                JSON.stringify(scan.names.tone));

            // A tag has to be able to pick a recording.
            const known = buildKnownSets(scan.entries, {});
            const parsed = parseTags('小雅·女·妩媚·温柔·：“你好”', known);
            const found = resolveTagVoice(parsed.tags, scan.entries);
            check('a tag picks the recording', found?.rel === path.join('女', '妩媚', '温柔.wav'), found?.rel);
            check('the picked voice is the recording', found?.kind === 'audio', found?.kind);

            // The path of a recording is used as it is — the plugin reads the
            // file and uploads the bytes, so s2.cpp never sees the path.
            check('an absolute recording path is kept',
                resolveVoiceFile({ voice: wav, voiceDir: '' }) === wav);
            check('a relative recording path is resolved against the directory',
                resolveVoiceFile({ voice: '女\\妩媚\\温柔.wav', voiceDir: dir }) === wav,
                resolveVoiceFile({ voice: '女\\妩媚\\温柔.wav', voiceDir: dir }));
            check('a recording is never mistaken for a profile',
                resolveVoiceFile({ voice: '温柔', voiceDir: dir }) === path.resolve(dir, '温柔.s2voice'));
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }

    /* -------------------------------------------------- ascii staging */

    console.log('\n[ascii staging]');
    {
        const staging = mkdtempSync(path.join(os.tmpdir(), 's2tts-stage-'));
        const sourceRoot = mkdtempSync(path.join(os.tmpdir(), 's2tts-src-'));
        const source = path.join(sourceRoot, '女', '妩媚', '生气.s2voice');
        mkdirSync(path.dirname(source), { recursive: true });
        writeFileSync(source, 'profile:original');
        try {
            check('an ascii path is used as it is',
                stageVoiceFile('C:\\voices\\sao.s2voice', staging) === 'C:\\voices\\sao.s2voice');
            check('a path with chinese characters is staged',
                stageVoiceFile(source, staging) !== source);
            const staged = stageVoiceFile(source, staging);
            check('the staged copy exists', statSync(staged).size > 0, staged);
            check('the staged copy is byte-identical',
                readFileSync(staged, 'utf8') === readFileSync(source, 'utf8'));
            check('the same source always maps to the same file',
                stageVoiceFile(source, staging) === staged);
            check('the staged path is ascii', isAsciiPath(staged), staged);

            // A replaced profile has to be picked up.
            writeFileSync(source, 'profile:changed');
            const refreshed = stageVoiceFile(source, staging);
            check('a changed profile is copied again',
                readFileSync(refreshed, 'utf8') === 'profile:changed',
                readFileSync(refreshed, 'utf8'));
        } finally {
            rmSync(staging, { recursive: true, force: true });
            rmSync(sourceRoot, { recursive: true, force: true });
        }
    }
    {
        check('a voice id is turned into a file path',
            resolveVoiceFile({ voice: 'sao', voiceDir: 'C:\\voices' }) === path.resolve('C:\\voices\\sao.s2voice'),
            resolveVoiceFile({ voice: 'sao', voiceDir: 'C:\\voices' }));
        check('a voice path is kept',
            resolveVoiceFile({ voice: 'C:\\voices\\a.s2voice', voiceDir: '' }) === 'C:\\voices\\a.s2voice');
        check('a voice id without a directory cannot be resolved',
            resolveVoiceFile({ voice: 'sao', voiceDir: '' }) === null);
        check('nothing at all cannot be resolved', resolveVoiceFile({}) === null);
    }
    {
        const candidates = [path.join('F:\\中文目录', 'voices'), path.join(os.tmpdir(), 's2tts-pick')];
        const picked = pickStagingDir(candidates);
        check('a directory with chinese characters is skipped',
            picked === candidates[1], picked);
        rmSync(candidates[1], { recursive: true, force: true });
    }
}

/* -------------------------------------------------------------- standalone */

if (process.argv[1] && process.argv[1].endsWith('voicetree.mjs')) {
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
    await runVoiceTreeTests(check);
    console.log(`\n${passed} passed, ${failed} failed\n`);
    process.exit(failed === 0 ? 0 : 1);
}
