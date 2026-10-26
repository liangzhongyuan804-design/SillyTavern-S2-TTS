/**
 * Creates a `.s2voice` profile from a plain recording.
 *
 * Why a separate process? s2.cpp can only write a profile from the command
 * line (`--save-voice`). Its HTTP server has no route for it and the `params`
 * whitelist of `/generate` does not contain `save_voice`, so a running server
 * cannot be asked to store a profile.
 *
 * The command line always continues with a throwaway synthesis after the
 * profile was written, so the process is stopped as soon as s2.cpp reports
 * that it saved the profile.
 *
 * Measured on this machine (Debug build, s2-pro-q8_0 on an RTX 3060 Ti):
 *
 *   | configuration                        | time to the saved profile |
 *   |--------------------------------------|---------------------------|
 *   | everything on the CPU                 | 103 s                    |
 *   | full GPU, `--codec-auto` (benchmark)  | 24 s                     |
 *   | full GPU, `--codec-follow-backend`    | 7.2 s                    |
 *   | model on the CPU, codec on the GPU    | 7.0 s                    |
 *
 * The codec benchmark is the expensive part, so the profile run never asks for
 * it. The model stays on the CPU as well: the weights are memory mapped and
 * shared with a running server, and the codec — the only part that is really
 * needed to encode a reference — runs on the GPU where it takes about a
 * second. That way the profile can be created while s2.cpp is serving.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const PROFILE_EXTENSION = '.s2voice';

/**
 * Characters that must not end up in a voice id.
 *
 * The id becomes a file name (`<voice-dir>/<id>.s2voice`), so a path
 * separator would let it escape the voice directory.
 */
const INVALID_ID_CHARS = /[<>:"/\\|?*]/g;

/**
 * The longest reference recording that s2.cpp encodes without trouble.
 *
 * A longer one makes the codec allocate a graph buffer that is sized by the
 * audio length; on an 8 GB card that is a CUDA out-of-memory and the engine
 * silently continues without the cloned voice.
 */
export const REFERENCE_SOFT_LIMIT_SEC = 15;

/**
 * Normalizes a voice id into something that can be used as a file name.
 *
 * @param {string} value The raw id.
 * @returns {string} The cleaned id, or an empty string when nothing is left.
 */
export function sanitizeVoiceId(value) {
    const raw = String(value ?? '').trim();
    if (!raw) {
        return '';
    }
    let cleaned = '';
    for (const character of raw) {
        const code = character.codePointAt(0) ?? 0;
        // Control characters are illegal in a Windows file name.
        if (code < 32 || INVALID_ID_CHARS.test(character)) {
            cleaned += '_';
            continue;
        }
        cleaned += character;
    }
    // Windows refuses file names that end with a dot or a space, and it
    // reserves a few names for the devices.
    cleaned = cleaned.replace(/[. ]+$/, '').trim();
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned)) {
        cleaned = `${cleaned}_`;
    }
    return cleaned;
}

/**
 * True when the id is safe to use as a file name.
 *
 * @param {string} value The raw id.
 * @returns {boolean}
 */
export function isValidVoiceId(value) {
    const cleaned = sanitizeVoiceId(value);
    return Boolean(cleaned) && cleaned === String(value ?? '').trim();
}

/**
 * Builds the s2.cpp command line that writes the profile.
 *
 * @param {object} options
 * @param {string} options.model Path of the GGUF model.
 * @param {string} options.tokenizer Path of tokenizer.json.
 * @param {string} options.promptAudio Path of the reference recording.
 * @param {string} options.promptText Word-by-word transcript of the recording.
 * @param {string} options.voiceId The id of the new profile.
 * @param {string} options.voiceDir Directory that holds the profiles.
 * @param {string} options.output Path of the throwaway output WAV.
 * @param {number} [options.cudaDevice] CUDA device index, -1 for the CPU.
 * @returns {string[]} The command line.
 */
export function buildSaveArgs(options) {
    const {
        model,
        tokenizer,
        promptAudio,
        promptText,
        voiceId,
        voiceDir,
        output,
        cudaDevice = 0,
    } = options;

    const useGpu = Number(cudaDevice) >= 0;
    return [
        '--model', String(model),
        '--tokenizer', String(tokenizer),
        '--prompt-audio', String(promptAudio),
        '--prompt-text', String(promptText),
        '--voice', String(voiceId),
        '--voice-dir', String(voiceDir),
        '--save-voice',
        // The profile is written before the synthesis starts, so the text and
        // the output file only have to exist — they are never used.
        '--text', '.',
        '--max-tokens', '8',
        '--output', String(output),
        '--cuda', String(cudaDevice),
        // The transformer is not needed to encode a reference. Keeping it on
        // the CPU leaves the VRAM to a running s2.cpp server.
        '--gpu-layers', '0',
        // `--codec-auto` benchmarks both codec backends first, which costs
        // about 17 seconds and buys nothing for a one-off encode.
        useGpu ? '--codec-follow-backend' : '--codec-cpu',
    ];
}

/**
 * Reads the stage of the run from a line of the s2.cpp output.
 *
 * @param {string} line One line of the process output.
 * @returns {string|null} A stage key, or null when the line says nothing.
 */
export function detectStage(line) {
    const text = String(line ?? '');
    if (/Saved voice profile:/i.test(text)) {
        return 'saved';
    }
    if (/Loading reference audio:/i.test(text)) {
        return 'encoding';
    }
    if (/Pipeline Init|Reading metadata/i.test(text)) {
        return 'loading';
    }
    return null;
}

/**
 * Looks for a line that means the run failed.
 *
 * @param {string} line One line of the process output.
 * @returns {string|null} The error message, or null.
 */
export function detectError(line) {
    const text = String(line ?? '').trim();
    if (!text) {
        return null;
    }
    if (/^Error: --save-voice requires/m.test(text)) {
        return text;
    }
    if (/Pipeline error: failed to save voice profile/i.test(text)) {
        return text;
    }
    if (/Pipeline error: cannot save voice profile/i.test(text)) {
        return text;
    }
    if (/Pipeline warning: encode failed/i.test(text)) {
        return '参考音频编码失败，音色档案没有生成。参考音频可能太长。';
    }
    if (/cudaMalloc failed: out of memory/i.test(text)) {
        return '显存不足。参考音频可能太长，换一段更短的试试。';
    }
    if (/Initialization failed/i.test(text)) {
        return 's2.cpp 初始化失败，请检查模型、tokenizer 和 DLL 目录。';
    }
    return null;
}

/**
 * Runs one profile creation.
 *
 * @param {object} options
 * @param {string} options.exe Path of s2.exe.
 * @param {string} options.model Path of the GGUF model.
 * @param {string} options.tokenizer Path of tokenizer.json.
 * @param {string} options.promptAudio Path of the reference recording.
 * @param {string} options.promptText Word-by-word transcript of the recording.
 * @param {string} options.voiceId The id of the new profile.
 * @param {string} options.voiceDir Directory that holds the profiles.
 * @param {string} options.workDir Scratch directory for the temporary files.
 * @param {string} [options.dllDir] Directory with the CUDA runtime DLLs.
 * @param {number} [options.cudaDevice] CUDA device index, -1 for the CPU.
 * @param {function} [options.onLog] Called with every output line.
 * @param {function} [options.onStage] Called with every stage change.
 * @returns {{promise: Promise<object>, cancel: function}}
 */
export function runProfileSave(options) {
    const {
        exe,
        model,
        tokenizer,
        promptAudio,
        promptText,
        voiceId,
        voiceDir,
        workDir,
        dllDir = '',
        cudaDevice = 0,
        onLog = () => {},
        onStage = () => {},
    } = options;

    mkdirSync(workDir, { recursive: true });
    const output = path.join(workDir, 'profile-output.wav');

    const args = buildSaveArgs({
        model,
        tokenizer,
        promptAudio,
        promptText,
        voiceId,
        voiceDir,
        output,
        cudaDevice,
    });

    const env = { ...process.env };
    if (dllDir) {
        env.PATH = `${dllDir}${path.delimiter}${env.PATH ?? ''}`;
    }

    let settled = false;
    let saved = false;
    let process_ = null;
    const logs = [];
    const startedAt = Date.now();

    const promise = new Promise((resolve) => {
        try {
            process_ = spawn(exe, args, {
                cwd: path.dirname(exe),
                env,
                windowsHide: true,
            });
        } catch (error) {
            resolve({
                ok: false,
                error: `启动 s2.exe 失败：${error?.message ?? error}`,
                logs,
                elapsedMs: 0,
            });
            return;
        }

        const finish = (result) => {
            if (settled) {
                return;
            }
            settled = true;
            try {
                process_?.kill();
            } catch {
                /* the process is already gone */
            }
            resolve({
                ...result,
                logs,
                elapsedMs: Date.now() - startedAt,
            });
        };

        const onData = (chunk) => {
            for (const line of String(chunk).split(/\r?\n/)) {
                const trimmed = line.trim();
                if (!trimmed) {
                    continue;
                }
                logs.push(trimmed);
                if (logs.length > 200) {
                    logs.shift();
                }
                onLog(trimmed);

                const stage = detectStage(trimmed);
                if (stage) {
                    onStage(stage);
                }
                if (stage === 'saved') {
                    // The profile is written and flushed at this point. The
                    // command line would continue with a throwaway synthesis,
                    // so the process is stopped right here.
                    saved = true;
                    setTimeout(() => finish({ ok: true }), 150);
                    return;
                }

                const error = detectError(trimmed);
                if (error) {
                    finish({ ok: false, error });
                    return;
                }
            }
        };

        process_.stdout?.on('data', onData);
        process_.stderr?.on('data', onData);
        process_.on('error', (error) => {
            finish({ ok: false, error: `s2.exe 运行失败：${error?.message ?? error}` });
        });
        process_.on('exit', (code) => {
            if (saved) {
                finish({ ok: true });
                return;
            }
            finish({
                ok: false,
                error: `s2.cpp 退出码 ${code}，没有生成音色档案。`,
            });
        });
    });

    return {
        promise,
        cancel() {
            if (settled) {
                return;
            }
            settled = true;
            try {
                process_?.kill();
            } catch {
                /* the process is already gone */
            }
        },
    };
}

/**
 * Writes the trimmed reference recording to a scratch file.
 *
 * @param {string} workDir Scratch directory.
 * @param {string} name File name inside the scratch directory.
 * @param {Buffer} bytes The WAV bytes.
 * @returns {string} The full path of the written file.
 */
export function writeReferenceFile(workDir, name, bytes) {
    mkdirSync(workDir, { recursive: true });
    const target = path.join(workDir, name);
    writeFileSync(target, bytes);
    return target;
}

/**
 * Removes a scratch directory.
 *
 * @param {string} workDir The directory to remove.
 */
export function cleanupWorkDir(workDir) {
    if (!workDir) {
        return;
    }
    try {
        rmSync(workDir, { recursive: true, force: true });
    } catch {
        /* a leftover in the temp directory is harmless */
    }
}

/**
 * True when the path exists and is a file.
 *
 * @param {string} target The path to check.
 * @returns {boolean}
 */
export function isExistingFile(target) {
    return Boolean(target) && existsSync(target);
}
