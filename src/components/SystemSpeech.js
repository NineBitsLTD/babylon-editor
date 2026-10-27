import { spawn } from 'node:child_process';

/**
 * @typedef {object} SystemVoice
 * @property {string} name
 * @property {string} lang language tag (`ru-RU`, `en_US`, …) as the system names it
 */

/**
 * @param {string} command
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<string>} the output of a command
 */
function run(command, args, env = undefined) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { env: env ? { ...process.env, ...env } : process.env });
        let out = '';
        child.stdout.on('data', (chunk) => { out += chunk; });
        child.on('error', reject);
        child.on('close', code => (code === 0 ? resolve(out) : reject(new Error(`${command} exited with ${code}`))));
    });
}

/**
 * The speech of the operating system, for webviews without voices: macOS `say`, Windows
 * `System.Speech` through PowerShell, Linux `spd-say` (Speech Dispatcher). One phrase at a time; a new
 * phrase or `stop` ends the one being spoken.
 */
export class SystemSpeech {

    constructor() {
        /** @type {import('node:child_process').ChildProcess | null} */
        this._child = null;
    }

    /**
     * @returns {Promise<SystemVoice[]>} the installed voices (empty when the system has no speech)
     */
    async voices() {
        try {
            if (process.platform === 'darwin') {
                // "Milena              ru_RU    # Здравствуйте! Меня зовут Милена."
                return (await run('say', ['-v', '?'])).split('\n').map(line => line.match(/^(.+?)\s{2,}([a-z]{2,3}[_-][A-Za-z0-9]+)\s+#/))
                    .filter(Boolean).map(([, name, lang]) => ({ name: name.trim(), lang }));
            }
            if (process.platform === 'win32') {
                const script = 'Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name + "|" + $_.VoiceInfo.Culture.Name }';
                return (await run('powershell', ['-NoProfile', '-Command', script])).split(/\r?\n/).filter(Boolean)
                    .map((line) => {
                        const [name, lang] = line.split('|');
                        return { name, lang: lang ?? '' };
                    });
            }
            // spd-say has no voice names worth choosing: the language picks the voice
            await run('spd-say', ['--version']);
            return [{ name: 'default', lang: '' }];
        } catch {
            return [];
        }
    }

    /**
     * Speaks a phrase; resolves when it is spoken or stopped.
     * @param {string} text
     * @param {{ voice?: string, rate?: number, lang?: string }} [options] rate: 1 is the normal speed
     * @returns {Promise<void>}
     */
    speak(text, { voice, rate = 1, lang } = {}) {
        this.stop();
        const [command, args, env] = SystemSpeech._command(text, voice, rate, lang);
        return new Promise((resolve) => {
            const child = spawn(command, args, { env: env ? { ...process.env, ...env } : process.env, stdio: 'ignore' });
            this._child = child;
            const done = () => {
                if (this._child === child) this._child = null;
                resolve();
            };
            child.on('error', done);
            child.on('close', done);
        });
    }

    /** Ends the phrase being spoken. */
    stop() {
        this._child?.kill();
        this._child = null;
    }

    /**
     * @param {string} text
     * @param {string | undefined} voice
     * @param {number} rate
     * @param {string | undefined} lang
     * @returns {[string, string[], NodeJS.ProcessEnv?]} the command speaking the text
     */
    static _command(text, voice, rate, lang) {
        if (process.platform === 'darwin') {
            // about 175 words a minute is the normal speed of say
            return ['say', [...(voice ? ['-v', voice] : []), '-r', String(Math.round(175 * rate)), '--', text]];
        }
        if (process.platform === 'win32') {
            // The text and the voice go through the environment: no quoting in the script
            const script = 'Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; '
                + 'if ($env:SPEECH_VOICE) { $s.SelectVoice($env:SPEECH_VOICE) }; '
                + `$s.Rate = ${Math.max(-10, Math.min(10, Math.round((rate - 1) * 10)))}; $s.Speak($env:SPEECH_TEXT)`;
            return ['powershell', ['-NoProfile', '-Command', script], { SPEECH_TEXT: text, SPEECH_VOICE: voice ?? '' }];
        }
        return ['spd-say', ['-w', '-r', String(Math.max(-100, Math.min(100, Math.round((rate - 1) * 100)))), ...(lang ? ['-l', lang.slice(0, 2)] : []), '--', text]];
    }
}
