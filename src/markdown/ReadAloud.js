import { guessLanguage } from './PreviewTranslation';

/** @typedef {import('../editor/HostRequests').HostRequests} HostRequests */
/** @typedef {{ name: string, lang: string, score?: number }} Voice score: higher is better */

/** Elements read as parts of the text. */
const BLOCKS = 'h1,h2,h3,h4,h5,h6,p,li,blockquote,dt,dd,td,th,figcaption,caption';
/** Blocks read with the paragraphs inside them. */
const MERGING = 'li,dd,blockquote,td,th';
/** Parts of a merging block that are read on their own. */
const SEPARATE = 'ul,ol,dl,table,h1,h2,h3,h4,h5,h6,pre,script,style';

/**
 * @param {number} ms
 * @returns {string} `m:ss` or `h:mm:ss`
 */
function clock(ms) {
    const seconds = Math.floor(ms / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds / 60) % 60;
    const rest = String(seconds % 60).padStart(2, '0');
    return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

/**
 * @param {string} text
 * @returns {string[]} its phrases (sentences); "v2.1" or "app.js" do not end one
 */
function phrasesOf(text) {
    return text.match(/(?:[^.!?…]|[.!?…](?=[\p{L}\p{N}]))+[.!?…]*/gu)?.map(phrase => phrase.trim()).filter(phrase => /[\p{L}\p{N}]/u.test(phrase)) ?? [];
}

/**
 * The voices of the webview (Web Speech API).
 */
class WebSpeech {

    /**
     * @returns {Promise<Voice[]>} the voices, waiting a moment for them to be loaded
     */
    static async voices() {
        if (!('speechSynthesis' in window)) return [];
        let voices = speechSynthesis.getVoices();
        if (!voices.length) {
            await new Promise((resolve) => {
                speechSynthesis.addEventListener('voiceschanged', resolve, { once: true });
                setTimeout(resolve, 1500);
            });
            voices = speechSynthesis.getVoices();
        }
        // As the claude-ai voice: the "Enhanced" / "Premium" system voices first, then local ones
        return voices.map(voice => ({ name: voice.name, lang: voice.lang, score: (/enhanced|premium/i.test(voice.name) ? 2 : 0) + (voice.localService ? 1 : 0) }));
    }

    /**
     * @param {string} text
     * @param {{ voice?: string, rate: number }} options
     * @returns {Promise<void>} when it is spoken or stopped
     */
    speak(text, { voice, rate }) {
        return new Promise((resolve) => {
            const utterance = new SpeechSynthesisUtterance(text);
            const chosen = speechSynthesis.getVoices().find(candidate => candidate.name === voice);
            if (chosen) {
                utterance.voice = chosen;
                utterance.lang = chosen.lang;
            }
            utterance.rate = rate;
            utterance.onend = () => resolve();
            utterance.onerror = () => resolve();
            speechSynthesis.speak(utterance);
        });
    }

    stop() {
        speechSynthesis.cancel();
    }
}

/**
 * The voice of the operating system, through the host (`SystemSpeech`).
 */
class HostSpeech {

    /**
     * @param {HostRequests} host
     */
    constructor(host) {
        this._host = host;
    }

    /**
     * @returns {Promise<Voice[]>}
     */
    voices() {
        return this._host.request('voices');
    }

    /**
     * @param {string} text
     * @param {{ voice?: string, rate: number, lang?: string }} options
     * @returns {Promise<void>}
     */
    async speak(text, options) {
        await this._host.request('speak', { text, options });
    }

    stop() {
        this._host.send('stopSpeaking');
    }
}

/**
 * Reading the preview aloud as in the claude-ai preview: the text shown (in its translation) phrase
 * by phrase — blocks split into sentences, code blocks skipped —, the block being read highlighted
 * and scrolled to; Pause / resume, a phrase back or on, the time read and, before, an estimate of
 * the time it takes. The voices of the webview are used, those of the system when it has none.
 */
export class ReadAloud {

    /**
     * @param {object} options
     * @param {HTMLElement} options.root the rendered document
     * @param {HTMLElement} options.head the header with the controls
     * @param {HostRequests} options.host
     * @param {(settings: { voice: string, rate: number }) => void} options.onSettings the voice or speed was chosen
     */
    constructor({ root, head, host, onSettings }) {
        this._root = root;
        this._host = host;
        this._onSettings = onSettings;
        this._speakButton = head.querySelector('.md-head__speak');
        this._bar = head.querySelector('.md-reading');
        this._prev = head.querySelector('.md-reading__prev');
        this._pause = head.querySelector('.md-reading__pause');
        this._next = head.querySelector('.md-reading__next');
        this._voiceSelect = /** @type {HTMLSelectElement} */ (head.querySelector('.md-head__voice'));
        this._rateSelect = /** @type {HTMLSelectElement} */ (head.querySelector('.md-head__rate'));
        /** @type {WebSpeech | HostSpeech | null} */
        this._engine = null;
        /** @type {Voice[]} */
        this._voices = [];
        this._settings = { voice: '', rate: 1 };
        /** the language of the shown text ('' : the document's own) */
        this._lang = '';
        /** @type {{ phrases: { text: string, element: HTMLElement | null }[], index: number, paused: boolean, run: number, lit: HTMLElement | null, spent: number, since: number | null } | null} */
        this._reading = null;
        this._timer = null;
        this._run = 0;
        this._speakButton.addEventListener('click', () => (this._reading ? this.stop() : this._start()));
        this._prev.addEventListener('click', () => this._reading && this._reading.index > 0 && this._play(this._reading.index - 1));
        this._next.addEventListener('click', () => this._reading && this._reading.index < this._reading.phrases.length - 1 && this._play(this._reading.index + 1));
        this._pause.addEventListener('click', () => this._togglePause());
        this._voiceSelect.addEventListener('change', () => this._choose({ voice: this._voiceSelect.value }));
        this._rateSelect.addEventListener('change', () => this._choose({ rate: Number(this._rateSelect.value) || 1 }));
        this._ready = this._loadVoices();
    }

    /**
     * @param {{ voice?: string, rate?: number }} settings kept by the host
     */
    setSettings(settings) {
        this._settings = { voice: settings?.voice ?? '', rate: Number(settings?.rate) || 1 };
        this._rateSelect.value = String(this._settings.rate);
        this._ready.then(() => this._fillVoices());
    }

    /**
     * The shown text or its language changed: the estimate and the default voice follow.
     * @param {string} lang the language of a translation ('' for the original)
     */
    refresh(lang) {
        this._lang = lang;
        this._fillVoices();
        this._sync();
    }

    /** Stops reading (the text is replaced, the tab is closed). */
    stop() {
        if (!this._reading) return;
        this._highlight(null);
        this._reading = null;
        this._run++;
        this._engine?.stop();
        this._sync();
    }

    async _loadVoices() {
        const web = await WebSpeech.voices();
        if (web.length) {
            this._engine = new WebSpeech();
            this._voices = web;
        } else {
            this._engine = new HostSpeech(this._host);
            this._voices = await this._engine.voices().catch(() => []);
        }
        this._fillVoices();
        this._sync();
    }

    /**
     * @returns {string} the language tag the text is read in: the translation, else Cyrillic or Latin letters
     */
    _textLang() {
        return this._lang || guessLanguage(this._root.textContent);
    }

    /**
     * @param {string} lang
     * @returns {string} the best voice of a language ('' : none, the system picks)
     */
    _voiceFor(lang) {
        const ofLang = this._voices.filter(voice => voice.lang.toLowerCase().replace('_', '-').startsWith(lang));
        return ofLang.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.name.localeCompare(b.name))[0]?.name ?? '';
    }

    /**
     * The voice select: Auto (each phrase with the best voice of its language, named for the
     * language of the text) or a chosen voice; the voices of that language first.
     */
    _fillVoices() {
        const lang = this._textLang();
        const ofLang = voice => voice.lang.toLowerCase().replace('_', '-').startsWith(lang);
        const sorted = [...this._voices].sort((a, b) => Number(ofLang(b)) - Number(ofLang(a)) || a.name.localeCompare(b.name));
        const automatic = this._voiceFor(lang);
        this._voiceSelect.replaceChildren(
            new Option(automatic ? `Auto (${automatic})` : 'Auto', ''),
            ...sorted.map(voice => new Option(voice.lang ? `${voice.name} (${voice.lang})` : voice.name, voice.name)),
        );
        this._voiceSelect.value = this._voices.some(voice => voice.name === this._settings.voice) ? this._settings.voice : '';
        this._voiceSelect.hidden = !this._voices.length;
    }

    /**
     * @param {{ voice?: string, rate?: number }} change
     */
    _choose(change) {
        this._settings = { ...this._settings, ...change };
        this._onSettings(this._settings);
        this._sync();
        // The next phrase is read with the new voice or speed
        if (this._reading && !this._reading.paused) this._play(this._reading.index);
    }

    /**
     * @returns {{ element: HTMLElement | null, text: string }[]} the readable parts of the preview,
     *   without code blocks: an item, quote or cell with its paragraphs; nested lists, tables and
     *   headings on their own
     */
    _blocks() {
        const textOf = (element) => {
            const copy = /** @type {HTMLElement} */ (element.cloneNode(true));
            copy.querySelectorAll(SEPARATE).forEach(part => part.remove());
            copy.querySelectorAll(`${BLOCKS},div,br`).forEach(part => part.after(' '));
            return copy.textContent.replace(/\s+/g, ' ').trim();
        };
        const merged = element => element.parentElement?.closest(BLOCKS)?.matches(MERGING) && !element.matches(`${MERGING},h1,h2,h3,h4,h5,h6`);
        return [...this._root.querySelectorAll(BLOCKS)]
            .filter(element => !element.closest('pre') && !merged(element) && (element.matches(MERGING) || !element.querySelector(BLOCKS)))
            .map(element => ({ element: /** @type {HTMLElement} */ (element), text: textOf(element) }))
            .filter(block => /[\p{L}\p{N}]/u.test(block.text));
    }

    /**
     * @returns {number} about how long reading takes, in ms (letters and digits a second, a pause per phrase)
     */
    _estimate() {
        const text = this._blocks().map(block => block.text).join(' ');
        const count = pattern => (text.match(pattern) ?? []).length;
        const seconds = count(/[а-яёіїєґ]/gi) / 15 + count(/[a-z]/gi) / 13 + count(/\d/g) * 0.4 + (count(/[.!?…]+(?=\s|$)/g) + 1) * 0.2;
        return (seconds * 1000) / (this._settings.rate || 1);
    }

    _start() {
        const phrases = this._blocks().flatMap(block => phrasesOf(block.text).map(text => ({ text, element: block.element })));
        if (!phrases.length || !this._engine) return;
        this._reading = { phrases, index: 0, paused: false, run: 0, lit: null, spent: 0, since: Date.now() };
        this._play(0);
    }

    /**
     * Reads from a phrase on (a jump drops the phrase being read).
     * @param {number} from
     */
    async _play(from) {
        const reading = this._reading;
        if (!reading) return;
        const run = ++this._run;
        this._engine.stop();
        reading.paused = false;
        reading.since ??= Date.now();
        for (let index = from; index < reading.phrases.length; index++) {
            reading.index = index;
            this._highlight(reading.phrases[index].element);
            this._sync();
            // Auto: each phrase in the voice of its own language (an English name in a Russian text)
            const text = reading.phrases[index].text;
            const lang = this._lang || guessLanguage(text);
            await this._engine.speak(text, { voice: this._settings.voice || this._voiceFor(lang), rate: this._settings.rate, lang });
            if (run !== this._run) return;
        }
        this.stop();
    }

    _togglePause() {
        const reading = this._reading;
        if (!reading) return;
        if (reading.paused) {
            this._play(reading.index);
            return;
        }
        reading.paused = true;
        reading.spent += Date.now() - reading.since;
        reading.since = null;
        this._run++;
        this._engine.stop();
        this._sync();
    }

    /**
     * @param {HTMLElement | null} element
     */
    _highlight(element) {
        const reading = this._reading;
        reading?.lit?.classList.remove('md-reading--lit');
        if (!reading || !element) return;
        element.classList.add('md-reading--lit');
        element.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        reading.lit = element;
    }

    /** The buttons and the clocks as the reading is. */
    _sync() {
        const reading = this._reading;
        clearInterval(this._timer);
        this._bar.hidden = !reading;
        const elapsed = () => (reading ? reading.spent + (reading.since ? Date.now() - reading.since : 0) : 0);
        const showClock = () => { this._pause.querySelector('.md-head__time').textContent = clock(elapsed()); };
        if (reading) {
            this._pause.querySelector('.codicon').className = `codicon codicon-${reading.paused ? 'debug-continue-small' : 'debug-pause'}`;
            this._pause.title = reading.paused ? 'Resume' : 'Pause';
            this._prev.disabled = reading.index <= 0;
            this._next.disabled = reading.index >= reading.phrases.length - 1;
            showClock();
            if (!reading.paused) this._timer = setInterval(showClock, 1000);
        }
        this._speakButton.querySelector('.codicon').className = `codicon codicon-${reading ? 'debug-stop' : 'unmute'}`;
        const estimate = reading || !this._engine ? 0 : this._estimate();
        this._speakButton.querySelector('.md-head__time').textContent = estimate >= 1000 ? `~${clock(estimate)}` : '';
        this._speakButton.title = reading ? 'Stop reading' : this._lang ? 'Read aloud (the translation)' : 'Read aloud';
        this._speakButton.disabled = !this._engine || (!reading && !this._voices.length);
    }
}
