import * as vscode from 'vscode';
import { createNonce } from './BabylonEditor';
import { SystemSpeech } from './SystemSpeech';

export const MarkdownPreviewID = 'babylon-editor.markdownPreview';

/** Where the voice and the speed of reading aloud are kept. */
const READING_KEY = 'babylonEditor.markdownReading';

/** Languages the preview is translated into, by their language tags. */
const LANGUAGE_NAMES = { ru: 'Russian', uk: 'Ukrainian', en: 'English' };

const TRANSLATE_PROMPT =
    'You translate fragments of one document. The message ends with a JSON array of strings in '
    + 'document order; neighbouring strings may be parts of one sentence split by inline markup. '
    + 'Translate each string into the target language and reply with ONLY a JSON array of the same '
    + 'length — no prose, no code fence. Keep each string\'s leading and trailing whitespace, never '
    + 'merge or split items, and leave code identifiers, URLs, file paths, numbers and Markdown or '
    + 'HTML syntax unchanged. A string already in the target language, or with nothing to translate, '
    + 'is returned as is.';

/**
 * @param {vscode.Uri} uri
 * @returns {boolean}
 */
function isMarkdown(uri) {
    return /\.(md|markdown)$/i.test(uri.path);
}

/**
 * A preview of Markdown files (`babylon-editor.markdownPreview`, a custom text editor that is not
 * the default: `.md` files open as text). The webview (`src/markdown.js`) renders the text live,
 * translates the shown text and reads it aloud; the host opens links, translates with a language
 * model of VS Code and speaks with the voice of the system when the webview has no voices.
 * @implements {vscode.CustomTextEditorProvider}
 */
export class MarkdownPreview {

    static openCommand = 'babylon-editor.openMarkdownPreview';
    static rawCommand = 'babylon-editor.openMarkdownRaw';

    /**
     * @param {vscode.ExtensionContext} context
     */
    constructor(context) {
        this._context = context;
        this._speech = new SystemSpeech();
        /** @type {vscode.WebviewPanel | null} the panel speaking with the system voice */
        this._speaking = null;
    }

    /**
     * @returns {vscode.Disposable}
     */
    register() {
        return vscode.Disposable.from(
            vscode.window.registerCustomEditorProvider(MarkdownPreviewID, this, { webviewOptions: { retainContextWhenHidden: true } }),
            vscode.commands.registerCommand(MarkdownPreview.openCommand, uri => this.open(uri)),
            vscode.commands.registerCommand(MarkdownPreview.rawCommand, uri => this.openRaw(uri)),
            new vscode.Disposable(() => this._speech.stop()),
        );
    }

    /**
     * Opens the preview of a Markdown file in place of its text tab.
     * @param {vscode.Uri} [uri]
     */
    async open(uri) {
        const target = uri ?? MarkdownPreview._activeResource();
        if (!target || !isMarkdown(target)) {
            vscode.window.showWarningMessage('Select a Markdown file to preview it.');
            return;
        }
        await this._switchTo(target, (viewColumn, preview) => vscode.commands.executeCommand('vscode.openWith', target, MarkdownPreviewID, { viewColumn, preview }));
    }

    /**
     * Opens the text of a Markdown file in place of its preview.
     * @param {vscode.Uri} [uri]
     */
    async openRaw(uri) {
        const target = uri ?? MarkdownPreview._activeResource();
        if (!target) return;
        await this._switchTo(target, async (viewColumn, preview) => {
            const document = await vscode.workspace.openTextDocument(target);
            await vscode.window.showTextDocument(document, { viewColumn, preview });
        });
    }

    /**
     * Opens another view of a file; when the active tab shows the file, the new view takes its place.
     * Both views edit one text document, so unsaved changes stay.
     * @param {vscode.Uri} target
     * @param {(viewColumn: vscode.ViewColumn | undefined, preview: boolean) => Thenable<unknown>} openView
     */
    async _switchTo(target, openView) {
        const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
        const shown = tab?.input instanceof vscode.TabInputText || tab?.input instanceof vscode.TabInputCustom ? tab.input.uri : null;
        const replaced = shown?.toString() === target.toString() ? tab : null;
        await openView(replaced?.group.viewColumn, !!replaced?.isPreview);
        if (replaced && replaced.group.tabs.includes(replaced)) await vscode.window.tabGroups.close(replaced);
    }

    /**
     * @returns {vscode.Uri | undefined} the file of the active tab
     */
    static _activeResource() {
        const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        return input?.uri ?? vscode.window.activeTextEditor?.document.uri;
    }

    /**
     * @param {vscode.TextDocument} document
     * @param {vscode.WebviewPanel} panel
     */
    resolveCustomTextEditor(document, panel) {
        const folder = vscode.Uri.joinPath(document.uri, '..');
        const workspace = vscode.workspace.getWorkspaceFolder(document.uri);
        panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this._context.extensionUri, 'dist'), workspace?.uri ?? folder],
        };
        panel.webview.html = this._html(panel.webview, folder);
        let timer = null;
        const send = async () => {
            panel.webview.postMessage({
                type: 'markdown',
                text: document.getText(),
                siblings: await MarkdownPreview._siblings(document.uri),
            });
        };
        const subscriptions = [
            vscode.workspace.onDidChangeTextDocument((event) => {
                if (event.document !== document) return;
                clearTimeout(timer);
                timer = setTimeout(send, 150);
            }),
            panel.webview.onDidReceiveMessage(message => this._onMessage(panel, document, message, send)),
        ];
        panel.onDidDispose(() => {
            clearTimeout(timer);
            subscriptions.forEach(subscription => subscription.dispose());
            if (this._speaking === panel) this._speech.stop();
        });
    }

    /**
     * @param {vscode.WebviewPanel} panel
     * @param {vscode.TextDocument} document
     * @param {any} message
     * @param {() => Promise<void>} send sends the text
     */
    async _onMessage(panel, document, message, send) {
        // Answers to HostRequests of the webview
        const reply = result => panel.webview.postMessage({ type: 'hostReply', requestId: message.requestId, result });
        switch (message?.type) {
            case 'ready':
                panel.webview.postMessage({ type: 'reading', settings: this._context.globalState.get(READING_KEY) ?? {} });
                await send();
                break;
            case 'openLink':
                await this._openLink(document.uri, String(message.href ?? ''));
                break;
            case 'reading':
                await this._context.globalState.update(READING_KEY, message.settings);
                break;
            case 'translate':
                try {
                    reply(await MarkdownPreview._translate(message.texts, message.target));
                } catch (error) {
                    panel.webview.postMessage({ type: 'hostReply', requestId: message.requestId, error: String(error?.message || error) });
                }
                break;
            case 'voices':
                reply(await this._speech.voices());
                break;
            case 'speak':
                this._speaking = panel;
                await this._speech.speak(String(message.text ?? ''), message.options ?? {});
                reply(true);
                break;
            case 'stopSpeaking':
                if (this._speaking === panel) this._speech.stop();
                break;
        }
    }

    /**
     * A link of the preview: a web or mail address in the browser, a Markdown file in its preview,
     * another file in its editor (relative to the document; `#…` is scrolled to by the webview).
     * @param {vscode.Uri} documentUri
     * @param {string} href
     */
    async _openLink(documentUri, href) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^file:/i.test(href)) {
            await vscode.env.openExternal(vscode.Uri.parse(href));
            return;
        }
        const [path, fragment] = href.split('#');
        if (!path) return;
        let target;
        try {
            target = /^file:/i.test(path) ? vscode.Uri.parse(path) : path.startsWith('/')
                ? vscode.Uri.joinPath(vscode.workspace.getWorkspaceFolder(documentUri)?.uri ?? vscode.Uri.file('/'), decodeURIComponent(path))
                : vscode.Uri.joinPath(documentUri, '..', decodeURIComponent(path));
            await vscode.workspace.fs.stat(target);
        } catch {
            vscode.window.showWarningMessage(`No file at ${href}`);
            return;
        }
        if ((await vscode.workspace.fs.stat(target)).type & vscode.FileType.Directory) {
            await vscode.commands.executeCommand('revealInExplorer', target);
        } else if (isMarkdown(target)) {
            await vscode.commands.executeCommand('vscode.openWith', target, MarkdownPreviewID);
        } else {
            await vscode.commands.executeCommand('vscode.open', fragment ? target.with({ fragment }) : target);
        }
    }

    /**
     * @param {vscode.Uri} uri
     * @returns {Promise<{ name: string, current: boolean }[]>} the Markdown files of its folder
     */
    static async _siblings(uri) {
        try {
            const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(uri, '..'));
            const own = uri.path.split('/').pop();
            return entries.filter(([name, type]) => type === vscode.FileType.File && /\.(md|markdown)$/i.test(name))
                .map(([name]) => ({ name, current: name === own }))
                .sort((a, b) => a.name.localeCompare(b.name));
        } catch {
            return [];
        }
    }

    /**
     * Translates texts with a language model of VS Code (from an installed extension).
     * @param {string[]} texts
     * @param {string} target language tag
     * @returns {Promise<{ texts?: string[], unavailable?: boolean }>} unavailable: no model to ask
     */
    static async _translate(texts, target) {
        const models = vscode.lm?.selectChatModels ? await vscode.lm.selectChatModels() : [];
        const model = models[0];
        if (!model) return { unavailable: true };
        const prompt = `${TRANSLATE_PROMPT}\n\nTarget language: ${LANGUAGE_NAMES[target] ?? target}.\n\n${JSON.stringify(texts)}`;
        const response = await model.sendRequest([vscode.LanguageModelChatMessage.User(prompt)], { justification: 'Translate the Markdown preview' });
        let answer = '';
        for await (const part of response.text) answer += part;
        const start = answer.indexOf('[');
        const end = answer.lastIndexOf(']');
        const parsed = start >= 0 && end > start ? JSON.parse(answer.slice(start, end + 1)) : null;
        if (!Array.isArray(parsed)) throw new Error('The language model gave no translation');
        return { texts: texts.map((text, index) => (typeof parsed[index] === 'string' && parsed[index].trim() ? parsed[index] : text)) };
    }

    /**
     * @param {vscode.Webview} webview
     * @param {vscode.Uri} folder of the document (relative images resolve against it)
     * @returns {string}
     */
    _html(webview, folder) {
        const nonce = createNonce();
        const dist = (...path) => webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'dist', ...path));
        const source = webview.cspSource;
        const csp = [
            "default-src 'none'",
            `script-src 'nonce-${nonce}'`,
            `style-src ${source} 'unsafe-inline'`,
            `font-src ${source}`,
            `img-src ${source} https: data: blob:`,
            `media-src ${source} https: data:`,
        ].join('; ');
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<base href="${webview.asWebviewUri(folder)}/">
<link href="${dist('codicons', 'codicon.css')}" rel="stylesheet">
<link href="${dist('css', 'markdown.css')}" rel="stylesheet">
<title>Markdown Preview</title>
</head>
<body>
<header class="md-head">
  <div class="md-head__tools">
    <select class="md-head__lang" title="Translate the preview">
      <option value="">DEF</option><option value="ru">RU</option><option value="uk">UA</option><option value="en">EN</option>
    </select>
    <button class="md-head__button md-head__speak" title="Read aloud"><i class="codicon codicon-unmute"></i><span class="md-head__time"></span></button>
    <span class="md-reading" hidden>
      <button class="md-head__button md-reading__prev" title="Previous phrase"><i class="codicon codicon-debug-reverse-continue"></i></button>
      <button class="md-head__button md-reading__pause" title="Pause"><i class="codicon codicon-debug-pause"></i><span class="md-head__time"></span></button>
      <button class="md-head__button md-reading__next" title="Next phrase"><i class="codicon codicon-debug-continue"></i></button>
    </span>
    <select class="md-head__voice" title="Voice"></select>
    <select class="md-head__rate" title="Speed of reading">
      <option value="0.75">0.75×</option><option value="1">1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2×</option>
    </select>
    <button class="md-head__button md-head__top" title="Back to the top"><i class="codicon codicon-arrow-up"></i></button>
  </div>
  <span class="md-head__status"></span>
</header>
<nav class="md-siblings"></nav>
<article class="md-body"></article>
<script nonce="${nonce}" src="${dist('js', 'markdown.js')}"></script>
</body>
</html>`;
    }
}
