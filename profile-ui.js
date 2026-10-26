/**
 * The "turn a recording into a .s2voice profile" dialog.
 *
 * s2.cpp can only write a profile from the command line, so until now the
 * user had to leave the browser, cut the recording by hand and run
 * `s2.exe --save-voice` themselves. This dialog does the whole round trip:
 *
 *   1. the recording is fetched from the plugin and decoded in the browser,
 *   2. the part that is used is picked on the waveform,
 *   3. the transcript is confirmed (s2.cpp refuses to clone without it),
 *   4. the plugin runs `s2.exe --save-voice` and writes the profile into the
 *      voice directory.
 *
 * The dialog is deliberately a separate file: `index.js` is already long
 * enough and this one needs a fair amount of state of its own.
 */

import {
    TARGET_SAMPLE_RATE,
    buildPeaks,
    clampRange,
    encodeRange,
    formatSeconds,
    toBase64,
} from './profile.js';

/** The longest reference that s2.cpp encodes without running out of memory. */
const SOFT_LIMIT_SEC = 15;

/** The shortest reference that still carries enough voice. */
const MIN_USEFUL_SEC = 1;

/**
 * Collects every directory of the voice tree.
 *
 * @param {object} node The tree node.
 * @param {string} [root] The path of the voice directory.
 * @param {Array} [out] Collector.
 * @returns {Array} The directories, with their path and their name.
 */
function collectFolders(node, root = '', out = []) {
    for (const child of node?.children ?? []) {
        if (child.type !== 'dir') {
            continue;
        }
        out.push({
            path: child.path,
            name: child.name,
            root: root || child.path,
        });
        collectFolders(child, root, out);
    }
    return out;
}

/**
 * Creates the dialog.
 *
 * @param {object} context
 * @param {function} context.api Calls the server plugin.
 * @param {function} context.notify Shows a message to the user.
 * @param {function} context.translate Translates a locale key.
 * @param {function} context.getSettings Returns the current panel settings.
 * @param {function} context.getTree Returns the current voice tree.
 * @param {function} context.onSaved Called after a profile was written.
 * @returns {{open: function}} The dialog.
 */
export function createProfileBuilder(context) {
    const { api, notify, translate, getSettings, getTree, onSaved } = context;

    /**
     * Opens the dialog for one recording.
     *
     * @param {object} entry The voice tree entry of the recording.
     */
    function open(entry) {
        const settings = getSettings();
        const tree = getTree();

        const overlay = $('<dialog class="s2tts-modal" />');
        const box = $('<div class="s2tts-modal-box" />');
        overlay.append(box);

        const title = $('<div class="s2tts-modal-title" />').text(
            translate('ProfileTitle', '录音 → .s2voice 档案'),
        );
        box.append(title);

        const body = $('<div class="s2tts-modal-body" />');
        box.append(body);

        // --- the recording -------------------------------------------------
        const source = $('<div class="s2tts-modal-source" />').text(entry.rel ?? entry.path);
        body.append(source);

        // --- the waveform ---------------------------------------------------
        const canvas = $('<canvas class="s2tts-wave" />').attr('height', 92);
        // The DOM element behind the jQuery wrapper — the drawing API lives
        // there, not on the wrapper.
        const surface = canvas[0];
        const rangeRow = $('<div class="s2tts-range-row" />');
        const startInput = $('<input class="s2tts-num" type="number" step="0.01" min="0" />');
        const endInput = $('<input class="s2tts-num" type="number" step="0.01" min="0" />');
        const lengthLabel = $('<span class="s2tts-range-length" />');
        const wholeButton = $('<button class="s2tts-modal-button" type="button" />')
            .text(translate('ProfileWhole', '整段'));
        const headButton = $('<button class="s2tts-modal-button" type="button" />')
            .text(translate('ProfileHead', '前 10 秒'));

        rangeRow.append(
            $('<span class="s2tts-range-label" />').text(translate('ProfileStart', '起始')),
            startInput,
            $('<span class="s2tts-range-label" />').text(translate('ProfileEnd', '结束')),
            endInput,
            $('<span class="s2tts-range-label" />').text(translate('ProfileLength', '时长')),
            lengthLabel,
            wholeButton,
            headButton,
        );

        const hint = $('<div class="s2tts-hint" />');
        body.append(canvas, rangeRow, hint);

        // --- the transcript -------------------------------------------------
        const transcriptLabel = $('<label class="s2tts-modal-label" />')
            .text(translate('ProfileTranscript', '逐字转录（录音里念出来的字）'));
        const transcript = $('<textarea class="s2tts-modal-textarea" rows="2" />')
            .val(entry.transcript ?? '');
        body.append(transcriptLabel, transcript);

        // --- where the profile goes ----------------------------------------
        const targetLabel = $('<label class="s2tts-modal-label" />')
            .text(translate('ProfileTarget', '存放位置'));
        const targetRow = $('<div class="s2tts-target-row" />');
        const folderSelect = $('<select class="s2tts-modal-select" />');
        const idInput = $('<input class="s2tts-modal-input" type="text" />').val(entry.stem ?? '');
        targetRow.append(folderSelect, idInput);
        const targetPath = $('<div class="s2tts-modal-path" />');
        body.append(targetLabel, targetRow, targetPath);

        // --- progress -------------------------------------------------------
        const status = $('<div class="s2tts-modal-status" />');
        body.append(status);

        // --- the buttons ----------------------------------------------------
        const actions = $('<div class="s2tts-modal-actions" />');
        const cancel = $('<button class="s2tts-modal-button" type="button" />')
            .text(translate('ProfileCancel', '取消'));
        const create = $('<button class="s2tts-modal-button primary" type="button" />')
            .text(translate('ProfileCreate', '生成档案'));
        actions.append(cancel, create);
        box.append(actions);

        overlay.appendTo('body');

        // The toast container has to move into the dialog, otherwise the
        // backdrop would cover the messages of notify(). SillyTavern does
        // the same thing for its own popups.
        const toastContainer = document.getElementById('toast-container');
        const toastParent = toastContainer?.parentElement ?? null;

        // The state of the dialog.
        const state = {
            duration: 0,
            peaks: null,
            buffer: null,
            start: 0,
            end: 0,
            busy: false,
            closed: false,
        };

        /**
         * Closes the dialog and gives the page back what it borrowed.
         */
        function closeModal() {
            if (state.closed) {
                return;
            }
            state.closed = true;
            if (toastContainer && toastParent && toastContainer.parentElement === overlay[0]) {
                toastParent.appendChild(toastContainer);
            }
            if (overlay[0].open) {
                overlay[0].close();
            }
            overlay.remove();
        }

        // The escape key closes the dialog without going through the button.
        overlay.on('close', () => {
            if (toastContainer && toastParent && toastContainer.parentElement === overlay[0]) {
                toastParent.appendChild(toastContainer);
            }
            state.closed = true;
            overlay.remove();
        });

        // A click on the backdrop closes the dialog, a click inside does not.
        overlay.on('click', (event) => {
            if (event.target === overlay[0]) {
                closeModal();
            }
        });

        overlay[0].showModal();

        // --- the folders ----------------------------------------------------
        const sourceDir = entry.path.replace(/[\\/][^\\/]*$/, '');
        const root = tree?.dir ?? '';
        const folders = [{ path: root, name: translate('ProfileRoot', '（根目录）'), root }];
        folders.push(...collectFolders(tree?.tree, root));
        for (const folder of folders) {
            folderSelect.append($('<option />').val(folder.path).text(
                folder.path === root ? folder.name : folder.path.replace(root, '').replace(/^[\\/]/, ''),
            ));
        }
        if (sourceDir && folders.some((folder) => folder.path === sourceDir)) {
            folderSelect.val(sourceDir);
        }

        /**
         * Shows where the profile will be written.
         */
        function updateTargetPath() {
            const dir = folderSelect.val() || root;
            const id = (idInput.val() ?? '').trim() || '???';
            targetPath.text(`${dir}\\${id}.s2voice`);
        }

        /**
         * Shows the length of the selection and the warnings about it.
         */
        function updateRange() {
            const length = Math.max(0, state.end - state.start);
            lengthLabel.text(`${formatSeconds(length)} s`);
            startInput.val(state.start.toFixed(2));
            endInput.val(state.end.toFixed(2));

            const notes = [];
            let warn = false;
            if (length > SOFT_LIMIT_SEC) {
                notes.push(translate(
                    'ProfileTooLong',
                    '选得太长了：超过 15 秒容易显存不足，建议 5–15 秒。',
                ));
                warn = true;
            }
            if (length > 0 && length < MIN_USEFUL_SEC) {
                notes.push(translate('ProfileTooShort', '太短了：不到 1 秒克隆不出音色。'));
                warn = true;
            }
            if (!state.duration) {
                notes.push(translate('ProfileLoading', '正在读取录音……'));
            }
            hint.text(notes.join(' '));
            hint.toggleClass('s2tts-hint-warn', warn);
        }

        /**
         * Draws the waveform and the selected range.
         */
        function draw() {
            const ratio = window.devicePixelRatio || 1;
            // The canvas is stretched by the CSS, so the layout width is the
            // one the drawing has to be based on.
            const width = surface.clientWidth || surface.width || 460;
            const height = 92;
            surface.width = Math.max(1, Math.round(width * ratio));
            surface.height = Math.round(height * ratio);
            surface.style.height = `${height}px`;

            const context2d = surface.getContext('2d');
            context2d.setTransform(ratio, 0, 0, ratio, 0, 0);
            context2d.clearRect(0, 0, width, height);

            const middle = height / 2;
            context2d.strokeStyle = 'rgba(120,120,140,0.45)';
            context2d.beginPath();
            context2d.moveTo(0, middle);
            context2d.lineTo(width, middle);
            context2d.stroke();

            if (!state.peaks || !state.duration) {
                return;
            }

            const peaks = state.peaks;
            const count = peaks.length;
            const from = Math.max(0, Math.min(count - 1, Math.floor((state.start / state.duration) * count)));
            const to = Math.max(from, Math.min(count, Math.ceil((state.end / state.duration) * count)));

            for (let i = 0; i < count; i++) {
                const x = (i / count) * width;
                const amplitude = peaks[i] * (middle - 4);
                context2d.fillStyle = i >= from && i < to
                    ? 'rgba(120,190,255,0.95)'
                    : 'rgba(120,130,150,0.35)';
                context2d.fillRect(x, middle - amplitude, Math.max(1, width / count - 0.5), amplitude * 2);
            }

            // The two handles.
            context2d.strokeStyle = 'rgba(120,190,255,1)';
            context2d.lineWidth = 1;
            for (const [value, label] of [[state.start, 'start'], [state.end, 'end']]) {
                const x = (value / state.duration) * width;
                context2d.beginPath();
                context2d.moveTo(x, 0);
                context2d.lineTo(x, height);
                context2d.stroke();
                context2d.fillStyle = 'rgba(120,190,255,1)';
                context2d.fillRect(x - 2, label === 'start' ? 0 : height - 8, 4, 8);
            }
        }

        /**
         * Moves the selection to a new range.
         *
         * @param {number} start The new start, in seconds.
         * @param {number} end The new end, in seconds.
         */
        function setRange(start, end) {
            const range = clampRange(start, end, state.duration);
            state.start = range.start;
            state.end = range.end;
            updateRange();
            draw();
        }

        // --- dragging on the waveform ---------------------------------------
        let dragging = null;
        const positionOf = (event) => {
            const rect = surface.getBoundingClientRect();
            const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
            return ratio * state.duration;
        };

        canvas.on('pointerdown', (event) => {
            if (!state.duration || state.busy) {
                return;
            }
            event.preventDefault();
            const position = positionOf(event);
            const toStart = Math.abs(position - state.start);
            const toEnd = Math.abs(position - state.end);
            const nearest = Math.min(toStart, toEnd);
            // Close to a handle it moves that handle, anywhere else it starts
            // a new selection.
            dragging = nearest < Math.max(0.4, state.duration * 0.04)
                ? (toStart <= toEnd ? 'start' : 'end')
                : 'new';
            if (dragging === 'new') {
                setRange(position, position);
            }
            surface.setPointerCapture?.(event.pointerId);
        });

        canvas.on('pointermove', (event) => {
            if (!dragging || !state.duration) {
                return;
            }
            const position = positionOf(event);
            if (dragging === 'start') {
                setRange(Math.min(position, state.end), state.end);
            } else if (dragging === 'end') {
                setRange(state.start, Math.max(position, state.start));
            } else {
                setRange(state.start, position);
            }
        });

        const stopDragging = () => {
            dragging = null;
        };
        canvas.on('pointerup', stopDragging);
        canvas.on('pointercancel', stopDragging);
        canvas.on('pointerleave', stopDragging);

        // --- the small controls ---------------------------------------------
        startInput.on('change', () => {
            setRange(Number(startInput.val()) || 0, state.end);
        });
        endInput.on('change', () => {
            setRange(state.start, Number(endInput.val()) || 0);
        });
        wholeButton.on('click', () => setRange(0, state.duration));
        headButton.on('click', () => setRange(0, Math.min(state.duration, 10)));
        folderSelect.on('change', updateTargetPath);
        idInput.on('input', updateTargetPath);

        // --- loading ---------------------------------------------------------
        (async () => {
            try {
                const bytes = await api('/voices/audio', {
                    voiceDir: settings.voiceDir ?? tree?.dir ?? '',
                    voicePath: entry.path,
                });
                const buffer = await decodeRecording(bytes);
                state.buffer = buffer;
                state.duration = buffer.duration;
                state.peaks = buildPeaks(buffer);
                state.start = 0;
                state.end = Math.min(buffer.duration, SOFT_LIMIT_SEC);
                updateRange();
                draw();
            } catch (error) {
                hint.text(translate('ProfileLoadFailed', '读取录音失败：{msg}').replace('{msg}', error.message));
                hint.addClass('s2tts-hint-warn');
                create.prop('disabled', true);
            }
        })();

        // --- running ----------------------------------------------------------
        cancel.on('click', (event) => {
            event.preventDefault();
            closeModal();
        });

        create.on('click', async (event) => {
            event.preventDefault();
            if (state.busy) {
                return;
            }
            const id = (idInput.val() ?? '').trim();
            const text = (transcript.val() ?? '').trim();
            if (!id) {
                const message = translate('ProfileNoName', '请填写档案名。');
                status.text(message);
                notify(message, 'warning');
                return;
            }
            if (!text) {
                const message = translate('ProfileNoTranscript', '请填写逐字转录，s2.cpp 没有它就存不了档案。');
                status.text(message);
                notify(message, 'warning');
                return;
            }
            if (!settings.exe || !settings.model || !settings.tokenizer) {
                const message = translate(
                    'ProfileNoEngine',
                    '还没有填写 s2.exe、模型和 tokenizer 路径，请先到「服务进程」里填好。',
                );
                status.text(message);
                notify(message, 'warning');
                return;
            }

            state.busy = true;
            create.prop('disabled', true);
            cancel.prop('disabled', true);
            status.text(translate('ProfileWorking', '正在生成音色档案……'));

            try {
                if (!state.buffer) {
                    throw new Error(translate('ProfileLoading', '正在读取录音……'));
                }
                const encoded = encodeRange(state.buffer, state.start, state.end);
                const job = await api('/voices/profile', {
                    voicePath: entry.path,
                    voiceDir: settings.voiceDir ?? tree?.dir ?? '',
                    transcript: text,
                    targetId: id,
                    targetDir: folderSelect.val() || root,
                    audioBase64: toBase64(encoded.bytes),
                    exe: settings.exe,
                    model: settings.model,
                    tokenizer: settings.tokenizer,
                    dllDir: settings.dllDir ?? '',
                    cudaDevice: Number(settings.cudaDevice ?? 0),
                });

                const stages = {
                    starting: translate('ProfileStageStarting', '正在启动 s2.cpp……'),
                    loading: translate('ProfileStageLoading', '正在加载模型……'),
                    encoding: translate('ProfileStageEncoding', '正在编码参考音频……'),
                    saved: translate('ProfileStageSaved', '正在写入档案……'),
                };

                for (;;) {
                    if (state.closed) {
                        return;
                    }
                    const result = await api('/voices/profile/status', { jobId: job.jobId });
                    status.text(stages[result.stage] ?? translate('ProfileWorking', '正在生成音色档案……'));
                    if (result.state === 'done') {
                        status.text(translate('ProfileDone', '已生成：{path}').replace('{path}', result.result?.path ?? ''));
                        notify(translate('ProfileSaved', '已生成音色档案。'), 'success');
                        closeModal();
                        onSaved?.();
                        return;
                    }
                    if (result.state === 'error') {
                        throw new Error(result.message || translate('ProfileFailed', '生成失败。'));
                    }
                    await new Promise((resolve) => setTimeout(resolve, 400));
                }
            } catch (error) {
                status.text(translate('ProfileFailed', '生成失败：{msg}').replace('{msg}', error.message));
                state.busy = false;
                create.prop('disabled', false);
                cancel.prop('disabled', false);
            }
        });

        updateTargetPath();
        updateRange();
        draw();
    }

    return { open };
}

/**
 * Decodes a recording with the Web Audio API.
 *
 * An offline context is used on purpose: it resamples to the rate of s2.cpp's
 * codec (44100 Hz) and it needs no user gesture.
 *
 * @param {ArrayBuffer} bytes The raw file.
 * @returns {Promise<AudioBuffer>} The decoded audio.
 */
async function decodeRecording(bytes) {
    const context = new OfflineAudioContext(1, 1, TARGET_SAMPLE_RATE);
    // decodeAudioData detaches the buffer it gets, so it gets a copy.
    return context.decodeAudioData(bytes.slice(0));
}
