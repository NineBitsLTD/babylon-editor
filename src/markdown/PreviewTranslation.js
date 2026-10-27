/** @typedef {import('../editor/HostRequests').HostRequests} HostRequests */

const LANG_LABELS = { '': 'DEF', ru: 'RU', uk: 'UA', en: 'EN' };
/** Texts sent to the language model at once. */
const BATCH_ITEMS = 60;
const BATCH_CHARS = 8000;

/**
 * @param {string} text
 * @returns {'ru' | 'uk' | 'en'} the language of a text by its letters, as the claude-ai voice
 *   picks it: English when Latin letters are more than twice the Cyrillic ones, else Russian
 *   (Ukrainian with its own letters)
 */
export function guessLanguage(text) {
    const sample = text.slice(0, 4000);
    const cyrillic = (sample.match(/[а-яёіїєґ]/gi) ?? []).length;
    const latin = (sample.match(/[a-z]/gi) ?? []).length;
    if (latin > cyrillic * 2) return 'en';
    return /[іїєґ]/i.test(sample) ? 'uk' : 'ru';
}

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {T} fallback
 * @returns {Promise<T>} the result, or the fallback after ms (the browser's AI APIs can hang)
 */
function within(promise, ms, fallback) {
    return Promise.race([promise, new Promise(resolve => setTimeout(() => resolve(fallback), ms))]);
}

/**
 * Translation of the rendered preview as in the claude-ai preview: DEF (the original) / RU / UA /
 * EN translate the text nodes in place (code, pre, `translate="no"` and `.notranslate` are
 * skipped); translations are cached per text, so re-renders do not translate again. A language
 * model of VS Code translates (through the host); without one, Chrome's on-device Translator.
 */
export class PreviewTranslation {

    /**
     * @param {object} options
     * @param {HTMLElement} options.root the rendered document
     * @param {HTMLSelectElement} options.select
     * @param {HTMLElement} options.status
     * @param {HostRequests} options.host
     * @param {string} options.lang the language kept for the preview ('' for the original)
     * @param {(lang: string) => void} options.onChange after the language or the shown text changed
     */
    constructor({ root, select, status, host, lang, onChange }) {
        this._root = root;
        this._select = select;
        this._status = status;
        this._host = host;
        this.lang = lang;
        this._onChange = onChange;
        /** @type {Map<string, string>} `${lang}\n${text}` -> translation */
        this._cache = new Map();
        /** @type {WeakMap<Text, string>} text node -> its original text */
        this._originals = new WeakMap();
        /** @type {Map<string, any>} `${source}:${target}` -> Translator of the browser (null: none) */
        this._browser = new Map();
        /** false once the host had no language model */
        this._hostModel = true;
        this._sequence = 0;
        select.value = lang;
        select.addEventListener('change', () => {
            this.lang = select.value;
            this.apply();
        });
        this._sync(false);
    }

    /** Shows the text in the chosen language, translating what is not cached yet. */
    async apply() {
        const sequence = ++this._sequence;
        const nodes = this._nodes();
        for (const node of nodes) if (!this._originals.has(node)) this._originals.set(node, node.nodeValue);
        const lang = this.lang;
        this._show(nodes, lang);
        this._status.textContent = '';
        this._onChange(lang);
        if (!lang) return this._sync(false);
        const todo = [...new Set(nodes.map(node => this._originals.get(node).trim()))].filter(text => !this._cache.has(`${lang}\n${text}`));
        if (!todo.length) return this._sync(false);
        this._sync(true);
        const progress = (done) => {
            if (sequence !== this._sequence) return;
            this._progress(`${done}/${todo.length}`);
            this._show(nodes, lang);
        };
        try {
            if (!(await this._translateOnHost(todo, lang, progress)) && !(await this._translateInBrowser(todo, lang, progress))) {
                throw new Error('No translator: install an extension with a language model (e.g. GitHub Copilot)');
            }
        } catch (error) {
            if (sequence === this._sequence) {
                this._status.textContent = `⚠ ${error?.message || error}`;
                this._status.title = this._status.textContent;
            }
        } finally {
            if (sequence === this._sequence) {
                this._show(nodes, lang);
                this._sync(false);
                this._onChange(lang);
            }
        }
    }

    /**
     * @returns {Text[]} the text nodes to translate
     */
    _nodes() {
        const root = this._root;
        const skip = (element) => {
            for (let current = element; current && current !== root; current = current.parentElement) {
                if (/^(CODE|PRE|SCRIPT|STYLE|TEXTAREA|KBD|SAMP)$/.test(current.tagName)) return true;
                if (current.getAttribute('translate') === 'no' || current.classList.contains('notranslate')) return true;
            }
            return false;
        };
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode: node => (node.nodeValue.trim() && !skip(node.parentElement) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
        });
        const nodes = [];
        for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(/** @type {Text} */ (node));
        return nodes;
    }

    /**
     * Puts the cached translation (or the original) into each node, keeping its outer whitespace.
     * @param {Text[]} nodes
     * @param {string} lang
     */
    _show(nodes, lang) {
        for (const node of nodes) {
            const original = this._originals.get(node);
            const core = original.trim();
            const translated = lang ? this._cache.get(`${lang}\n${core}`) : null;
            const at = original.indexOf(core);
            const value = translated == null ? original : original.slice(0, at) + translated + original.slice(at + core.length);
            if (node.nodeValue !== value) node.nodeValue = value;
        }
    }

    /**
     * @param {boolean} busy
     */
    _sync(busy) {
        this._select.value = this.lang;
        if (!busy) this._progress(null);
        this._select.classList.toggle('md-head__lang--on', !!this.lang);
        this._select.disabled = busy;
    }

    /**
     * @param {string | null} text shown in the selected option ("RU 20/120"); null: the label alone
     */
    _progress(text) {
        for (const option of this._select.options) option.textContent = LANG_LABELS[option.value] + (option.selected && text ? ` ${text}` : '');
    }

    /**
     * Through a language model of VS Code, in batches.
     * @param {string[]} texts
     * @param {string} lang
     * @param {(done: number) => void} progress
     * @returns {Promise<boolean>} false when the host has no language model
     */
    async _translateOnHost(texts, lang, progress) {
        if (!this._hostModel) return false;
        const batches = [];
        let batch = [];
        let chars = 0;
        for (const text of texts) {
            if (batch.length && (batch.length >= BATCH_ITEMS || chars + text.length > BATCH_CHARS)) {
                batches.push(batch);
                batch = [];
                chars = 0;
            }
            batch.push(text);
            chars += text.length;
        }
        if (batch.length) batches.push(batch);
        let done = 0;
        this._progress(`0/${texts.length}`);
        for (const items of batches) {
            const result = await this._host.request('translate', { texts: items, target: lang });
            if (result?.unavailable) {
                this._hostModel = false;
                return false;
            }
            items.forEach((text, index) => this._cache.set(`${lang}\n${text}`, String(result.texts[index] ?? text).trim() || text));
            done += items.length;
            progress(done);
        }
        return true;
    }

    /**
     * Chrome's on-device Translator (with LanguageDetector for the source), time-limited.
     * @param {string[]} texts
     * @param {string} lang
     * @param {(done: number) => void} progress
     * @returns {Promise<boolean>} false when the browser has no translator for the pair
     */
    async _translateInBrowser(texts, lang, progress) {
        const { Translator, LanguageDetector } = /** @type {any} */ (window);
        if (typeof Translator?.create !== 'function') return false;
        // Without a detector (VS Code has none) the letters tell the language
        let source = guessLanguage(this._root.textContent);
        try {
            if (LanguageDetector && (await within(LanguageDetector.availability(), 3000, 'timeout')) === 'available') {
                const detector = await within(LanguageDetector.create(), 5000, null);
                const found = detector && (await within(detector.detect(this._root.textContent.slice(0, 1000)), 5000, []))[0];
                if (found?.confidence > 0.5) source = found.detectedLanguage;
            }
        } catch {
            // The source stays English
        }
        if (source === lang) {
            texts.forEach(text => this._cache.set(`${lang}\n${text}`, text));
            return true;
        }
        const key = `${source}:${lang}`;
        if (!this._browser.has(key)) {
            let translator = null;
            try {
                const options = { sourceLanguage: source, targetLanguage: lang };
                const availability = await within(Translator.availability(options), 4000, 'unavailable');
                if (availability !== 'unavailable') {
                    translator = await within(Translator.create({
                        ...options,
                        monitor: monitor => monitor.addEventListener('downloadprogress', event => this._progress(`${Math.round((event.loaded || 0) * 100)}%`)),
                    }), availability === 'available' ? 10000 : 120000, null);
                }
            } catch {
                translator = null;
            }
            this._browser.set(key, translator);
        }
        const translator = this._browser.get(key);
        if (!translator) return false;
        let next = 0;
        let done = 0;
        await Promise.all(Array.from({ length: 3 }, async () => {
            while (next < texts.length) {
                const text = texts[next++];
                try {
                    this._cache.set(`${lang}\n${text}`, await within(translator.translate(text), 30000, text));
                } catch {
                    // Left in the original
                }
                if (++done % 8 === 0 || done === texts.length) progress(done);
            }
        }));
        return true;
    }
}
