import * as vscode from 'vscode';
import { formatJson, minifyJson, stripJsonc } from '../utils/collapseBabylon';

/** The message of a save the user cancelled. */
const SAVE_CANCELLED = 'Saving was cancelled';

/**
 * @param {vscode.Uri} uri
 * @returns {boolean} a `.json` or `.jsonc` file (not `.babylon` / `.gltf`, which have views of their own)
 */
function isJsonFile(uri) {
    return /\.jsonc?$/i.test(uri.path);
}

/**
 * A formatted view of a `.json` / `.jsonc` file (JSONC is read as JSON: comments and trailing commas are left out): a `FileSystemProvider` for the `json-formatted` scheme
 * (`json-formatted:<path>?<real file uri>`) that serves the file formatted (indented as the editor
 * indents JSON) and saves it compact, without line breaks and indentation (asked once per file and
 * session). Formatting and compacting change only the whitespace outside of strings. The raw text
 * stays the default editor of `.json` files; the editor titles of both have a button for the other.
 */
export class JsonFormattedView {

    static scheme = 'json-formatted';
    static openCommand = 'babylon-editor.openFormattedJson';
    static rawCommand = 'babylon-editor.openRawJson';

    constructor() {
        this._onDidChangeFile = new vscode.EventEmitter();
        this.onDidChangeFile = this._onDidChangeFile.event;
        /** @type {Set<string>} real files the user agreed to save compact this session */
        this._confirmed = new Set();
    }

    /**
     * @param {vscode.Uri} uri real file
     * @returns {vscode.Uri} its formatted view
     */
    static toViewUri(uri) {
        return vscode.Uri.from({ scheme: JsonFormattedView.scheme, path: uri.path, query: uri.toString() });
    }

    /**
     * @param {vscode.Uri} uri formatted view
     * @returns {vscode.Uri} the real file
     */
    static toRealUri(uri) {
        return vscode.Uri.parse(uri.query);
    }

    /**
     * @returns {vscode.Disposable}
     */
    register() {
        return vscode.Disposable.from(
            vscode.workspace.registerFileSystemProvider(JsonFormattedView.scheme, this, { isCaseSensitive: true }),
            vscode.commands.registerCommand(JsonFormattedView.openCommand, uri => this.open(uri)),
            vscode.commands.registerCommand(JsonFormattedView.rawCommand, uri => this.openRaw(uri)),
            this._onDidChangeFile,
        );
    }

    /**
     * Opens the formatted view of a `.json` file in place of its raw text tab.
     * @param {vscode.Uri} [uri]
     */
    async open(uri) {
        const target = this._realTarget(uri);
        if (!target || !isJsonFile(target)) {
            vscode.window.showWarningMessage('Select a .json or .jsonc file to open it formatted.');
            return;
        }
        const raw = vscode.workspace.textDocuments.find(document => document.uri.toString() === target.toString());
        if (raw?.isDirty) {
            vscode.window.showWarningMessage('Save or revert the changes of the raw text first: the formatted view shows the file.');
            return;
        }
        await this._switchTo(target, async (viewColumn, preview) => {
            const document = await vscode.workspace.openTextDocument(JsonFormattedView.toViewUri(target));
            await vscode.window.showTextDocument(document, { viewColumn, preview });
        });
    }

    /**
     * Opens the raw text of the file in place of its formatted view.
     * @param {vscode.Uri} [uri] real file or its formatted view
     */
    async openRaw(uri) {
        const target = this._realTarget(uri);
        if (!target) return;
        const view = vscode.workspace.textDocuments.find(document => document.uri.toString() === JsonFormattedView.toViewUri(target).toString());
        if (view?.isDirty) {
            vscode.window.showWarningMessage('Save or revert the changes of the formatted view first.');
            return;
        }
        await this._switchTo(target, async (viewColumn, preview) => {
            const document = await vscode.workspace.openTextDocument(target);
            await vscode.window.showTextDocument(document, { viewColumn, preview });
        });
    }

    /**
     * Opens another view of a file; when the active tab shows the other view of it, the new one
     * takes its place (a preview tab stays a preview).
     * @param {vscode.Uri} target real file
     * @param {(viewColumn: vscode.ViewColumn | undefined, preview: boolean) => Promise<void>} openView
     */
    async _switchTo(target, openView) {
        const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
        const uri = tab?.input instanceof vscode.TabInputText ? tab.input.uri : null;
        const shown = uri && (uri.scheme === JsonFormattedView.scheme ? JsonFormattedView.toRealUri(uri) : uri);
        const replaced = shown?.toString() === target.toString() ? tab : null;
        await openView(replaced?.group.viewColumn, !!replaced?.isPreview);
        if (replaced && replaced.group.tabs.includes(replaced)) await vscode.window.tabGroups.close(replaced);
    }

    /**
     * @param {vscode.Uri} [uri] real file or its formatted view; the active tab's file by default
     * @returns {vscode.Uri | undefined} the real file
     */
    _realTarget(uri) {
        const source = uri ?? vscode.window.tabGroups.activeTabGroup.activeTab?.input?.uri ?? vscode.window.activeTextEditor?.document.uri;
        return source?.scheme === JsonFormattedView.scheme ? JsonFormattedView.toRealUri(source) : source;
    }

    /**
     * @returns {string} one level of indentation, as the editor indents JSON
     */
    static _indent() {
        const config = vscode.workspace.getConfiguration('editor', { languageId: 'json' });
        return config.get('insertSpaces', true) ? ' '.repeat(Number(config.get('tabSize', 2)) || 2) : '\t';
    }

    // --- File system provider ---------------------------------------------------------------

    /**
     * Changes of the real file (a save of the raw text, another program) show in the view.
     * @param {vscode.Uri} uri
     * @returns {vscode.Disposable}
     */
    watch(uri) {
        const real = JsonFormattedView.toRealUri(uri);
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.joinPath(real, '..'), real.path.split('/').pop()));
        const changed = () => this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Changed, uri }]);
        return vscode.Disposable.from(watcher, watcher.onDidChange(changed), watcher.onDidCreate(changed));
    }

    /**
     * @param {vscode.Uri} uri
     * @returns {Promise<vscode.FileStat>}
     */
    async stat(uri) {
        const stat = await vscode.workspace.fs.stat(JsonFormattedView.toRealUri(uri));
        return { type: stat.type, ctime: stat.ctime, mtime: stat.mtime, size: stat.size };
    }

    /**
     * The file formatted, without JSONC comments and trailing commas; a text that is not valid
     * JSON(C) is shown as it is.
     * @param {vscode.Uri} uri
     * @returns {Promise<Uint8Array>}
     */
    async readFile(uri) {
        const bytes = await vscode.workspace.fs.readFile(JsonFormattedView.toRealUri(uri));
        const text = stripJsonc(new TextDecoder().decode(bytes));
        try {
            JSON.parse(text);
        } catch {
            return bytes;
        }
        return new TextEncoder().encode(`${formatJson(text.trim(), JsonFormattedView._indent())}\n`);
    }

    /**
     * Writes the view compact into the real file (a line break at the end when the file had one).
     * @param {vscode.Uri} uri
     * @param {Uint8Array} content
     */
    async writeFile(uri, content) {
        const real = JsonFormattedView.toRealUri(uri);
        // Comments typed into the view are left out too
        const text = stripJsonc(new TextDecoder().decode(content));
        try {
            JSON.parse(text);
        } catch (error) {
            throw vscode.FileSystemError.Unavailable(`The text is not valid JSON (${error?.message || error}): fix it, or save it as it is from the raw text`);
        }
        const name = real.path.split('/').pop();
        if (!this._confirmed.has(real.toString())) {
            const save = 'Save Compact';
            const answer = await vscode.window.showWarningMessage(
                `Saving the formatted view writes ${name} compact`,
                { modal: true, detail: 'Line breaks and indentation are removed from the file (the values do not change), and so are the comments and trailing commas of JSONC the formatted view leaves out; the formatted view shows it formatted again. Save from the raw text to keep the file as it is written. Asked once per file in this session.' },
                save,
            );
            if (answer !== save) throw vscode.FileSystemError.Unavailable(SAVE_CANCELLED);
            this._confirmed.add(real.toString());
        }
        let finalNewline = false;
        try {
            finalNewline = new TextDecoder().decode(await vscode.workspace.fs.readFile(real)).endsWith('\n');
        } catch {
            // A new file: no line break at the end
        }
        await vscode.workspace.fs.writeFile(real, new TextEncoder().encode(`${minifyJson(text)}${finalNewline ? '\n' : ''}`));
    }

    readDirectory() {
        throw vscode.FileSystemError.NoPermissions();
    }

    createDirectory() {
        throw vscode.FileSystemError.NoPermissions();
    }

    delete() {
        throw vscode.FileSystemError.NoPermissions();
    }

    rename() {
        throw vscode.FileSystemError.NoPermissions();
    }
}
