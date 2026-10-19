import * as vscode from 'vscode';
import { ConvertedModels } from './ConvertedModels';
import { collapseBabylon, formatJson, placeholder, PLACEHOLDER_PATTERN } from '../utils/collapseBabylon';

/**
 * A value cut out of the compact view; its text is read from the live raw document by path.
 * @typedef {object} CutValue
 * @property {(string | number)[]} path
 * @property {string} key property it belongs to
 * @property {'array' | 'string'} kind
 * @property {number} size items of an array, characters of a string
 * @property {number} length characters of its text when it was cut out
 */

/**
 * Compact view of one file and its raw text document.
 * @typedef {object} CompactSession
 * @property {vscode.TextDocument} raw the `.babylon` text (the single source of truth)
 * @property {Map<number, CutValue>} cuts placeholder id -> cut value
 * @property {string} synced compact text that matches the raw text
 * @property {number} mtime reported by stat; only changes when the compact view itself is saved
 * @property {'compact' | 'raw' | null} writing the side being updated by the sync (its change is not synced back)
 * @property {ReturnType<typeof setTimeout> | null} timer pending compact → raw sync
 */

/** Compact edits are written into the raw text after this pause. */
const SYNC_DELAY = 150;

/**
 * @param {CutValue} cut
 * @returns {string} e.g. "positions: 12,345 items"
 */
function describe(cut) {
    return cut.kind === 'array'
        ? `${cut.key}: ${cut.size.toLocaleString('en-US')} items`
        : `${cut.key}: ${Math.round(cut.size / 1024).toLocaleString('en-US')} KB string`;
}

/**
 * @param {vscode.Uri} uri
 * @returns {boolean}
 */
function isBabylonFile(uri) {
    return uri.path.toLowerCase().endsWith('.babylon');
}

/**
 * @param {number} length characters
 * @returns {string}
 */
function formatSize(length) {
    return length >= 1e6 ? `${(length / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(length / 1e3))} KB`;
}

/**
 * @param {(string | number)[]} path
 * @returns {string}
 */
function pathKey(path) {
    return JSON.stringify(path);
}

/**
 * The changed region between two texts (common prefix and suffix removed).
 * @param {string} before
 * @param {string} after
 * @returns {{ start: number, beforeEnd: number, afterEnd: number } | null} null when equal
 */
function diffRegion(before, after) {
    if (before === after) return null;
    let start = 0;
    while (start < before.length && start < after.length && before[start] === after[start]) start++;
    let beforeEnd = before.length, afterEnd = after.length;
    while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) {
        beforeEnd--;
        afterEnd--;
    }
    return { start, beforeEnd, afterEnd };
}

/**
 * Compact view of `.babylon` files: the raw text with the bulky values (vertex buffers, animation
 * keys, embedded textures) replaced by `"…#12"` placeholders, so a model of tens of MB is a small,
 * fully highlighted JSON document. It is a live projection of the raw text document, served by a
 * file system provider for the `babylon-text` scheme:
 * - edits of the compact view are written into the raw text (only the changed value);
 * - changes of the raw text (3D editor, raw text, undo) are mirrored into the compact view;
 * - saving the compact view saves the raw document.
 * A placeholder can be expanded in place (CodeLens or hover link) to edit its values.
 *
 * @implements {vscode.FileSystemProvider}
 */
export class BabylonTextProvider {

    static scheme = 'babylon-text';
    static openCommand = 'babylon-editor.openCollapsedText';
    static expandCommand = 'babylon-editor.expandFragment';
    static rawCommand = 'babylon-editor.openRawText';
    static modelCommand = 'babylon-editor.openInModelEditor';
    /** Setting: open `.babylon` files collapsed when they are opened in a text editor. */
    static collapseSetting = 'babylonEditor.collapseTextEditor';

    /**
     * @param {(uri: vscode.Uri) => string} modelEditorOf view type of the 3D editor of a file
     *   (`.babylon` files have a text-based one)
     * @param {import('./JsonDocuments').JsonDocuments} documents indexes of the open texts
     */
    constructor(modelEditorOf, documents) {
        this._modelEditorOf = modelEditorOf;
        this._documents = documents;
        this._onDidChangeFile = new vscode.EventEmitter();
        this.onDidChangeFile = this._onDidChangeFile.event;
        this._onDidChangeCodeLenses = new vscode.EventEmitter();
        this.onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;
        /** @type {Map<string, CompactSession>} real file uri -> session */
        this._sessions = new Map();
        this._idDecoration = vscode.window.createTextEditorDecorationType({ opacity: '0.5' });
        /** @type {Set<string>} real files the user opened as raw text on purpose (not collapsed) */
        this._raw = new Set();
        /** @type {Set<string>} files being replaced by their collapsed view */
        this._redirecting = new Set();
    }

    /**
     * @param {vscode.Uri} uri real file
     * @returns {vscode.Uri} the collapsed text document of the file
     */
    static toTextUri(uri) {
        return vscode.Uri.from({ scheme: BabylonTextProvider.scheme, path: uri.path, query: uri.toString() });
    }

    /**
     * @param {vscode.Uri} uri collapsed text document
     * @returns {vscode.Uri} the real file
     */
    static toRealUri(uri) {
        return vscode.Uri.parse(uri.query);
    }

    /**
     * @returns {vscode.Disposable}
     */
    register() {
        const selector = { scheme: BabylonTextProvider.scheme };
        // The extension may be activated by the text editor itself (onLanguage:json)
        setTimeout(() => vscode.window.visibleTextEditors.forEach(editor => this._redirect(editor)));
        return vscode.Disposable.from(
            vscode.workspace.registerFileSystemProvider(BabylonTextProvider.scheme, this, { isCaseSensitive: true }),
            vscode.languages.registerCodeLensProvider(selector, this),
            vscode.languages.registerHoverProvider(selector, this),
            vscode.commands.registerCommand(BabylonTextProvider.openCommand, uri => this.open(uri)),
            vscode.commands.registerCommand(BabylonTextProvider.expandCommand, (uri, id) => this.expand(uri, id)),
            vscode.commands.registerCommand(BabylonTextProvider.rawCommand, uri => this.openRaw(uri)),
            vscode.commands.registerCommand(BabylonTextProvider.modelCommand, uri => this.openModel(uri)),
            vscode.window.onDidChangeVisibleTextEditors(editors => editors.forEach((editor) => {
                this._decorate(editor);
                this._redirect(editor);
            })),
            vscode.workspace.onDidCloseTextDocument((document) => {
                this._raw.delete(document.uri.toString());
                if (document.uri.scheme === BabylonTextProvider.scheme) this._sessions.delete(BabylonTextProvider.toRealUri(document.uri).toString());
            }),
            vscode.workspace.onDidChangeTextDocument(({ document }) => {
                vscode.window.visibleTextEditors.filter(editor => editor.document === document).forEach(editor => this._decorate(editor));
                if (document.uri.scheme === BabylonTextProvider.scheme) this._onCompactChange(document);
            }),
            this._documents.onDidChange(change => this._onRawChange(change)),
            // Saving the raw text (3D editor, raw view) also clears the dirty state of the compact view
            vscode.workspace.onDidSaveTextDocument(document => this._onRawSaved(document)),
            this._onDidChangeFile,
            this._onDidChangeCodeLenses,
            this._idDecoration,
        );
    }

    /**
     * Opens the collapsed text of a `.babylon` file (from the Explorer, the editor title or the palette).
     * @param {vscode.Uri} [uri]
     * @param {vscode.ViewColumn} [viewColumn]
     * @param {boolean} [preview] open as a preview tab (italic title, replaced by the next opened file)
     */
    async open(uri, viewColumn = undefined, preview = undefined) {
        const target = this._realTarget(uri);
        if (!target || !isBabylonFile(target)) {
            vscode.window.showWarningMessage('Select a .babylon file to open it as compact text.');
            return;
        }
        this._raw.delete(target.toString());
        await this._switchView(target, 'compact', async (column, keepPreview) => {
            const document = await vscode.workspace.openTextDocument(BabylonTextProvider.toTextUri(target));
            await vscode.window.showTextDocument(document, { preview: preview ?? keepPreview, viewColumn: viewColumn ?? column });
        });
    }

    /**
     * Opens the real file as plain text, without collapsing (it may be too large to highlight).
     * @param {vscode.Uri} [uri] real file or its compact view
     */
    async openRaw(uri) {
        const target = this._realTarget(uri);
        if (!target) return;
        await this._switchView(target, 'raw', async (column, preview) => {
            this._raw.add(target.toString());
            const document = await vscode.workspace.openTextDocument(target);
            await vscode.window.showTextDocument(document, { preview, viewColumn: column });
        });
    }

    /**
     * Opens the file in the 3D editor.
     * @param {vscode.Uri} [uri] real file or its compact view
     */
    async openModel(uri) {
        const target = this._realTarget(uri);
        if (!target) return;
        await this._switchView(target, 'model', (viewColumn, preview) => vscode.commands.executeCommand('vscode.openWith', target, this._modelEditorOf(target), { viewColumn, preview }));
    }

    /**
     * @param {vscode.Uri} [uri] real file or its compact view; the active editor's file by default
     * @returns {vscode.Uri | undefined} the real file
     */
    _realTarget(uri) {
        const source = uri ?? this._activeResource();
        return source?.scheme === BabylonTextProvider.scheme ? BabylonTextProvider.toRealUri(source) : source;
    }

    /**
     * Opens another view (raw text, compact text, 3D editor) of a file. When the active tab shows
     * another view of the same file, the new view replaces it in the same group. All views show
     * one document, so unsaved changes move along: a dirty compact view is reverted when it is
     * replaced (its edits are in the raw text). Only the raw text and the 3D editor with unsaved
     * changes cannot be replaced by the compact view: closing the last editor of the raw document
     * would ask to save it.
     * A replaced preview tab (opened but not edited or pinned) is replaced by a preview tab, so the
     * next opened file still takes its place.
     * @param {vscode.Uri} target real file
     * @param {'raw' | 'compact' | 'model'} view
     * @param {(viewColumn: vscode.ViewColumn | undefined, preview: boolean) => Promise<unknown>} openView
     */
    async _switchView(target, view, openView) {
        const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
        const current = tab ? this._tabView(tab, target) : null;
        const replaced = current && current !== view ? tab : null;
        if (replaced?.isDirty && current !== 'compact' && view === 'compact') {
            vscode.window.showWarningMessage('Save the changes first, or open the compact view next to this editor.');
            return;
        }
        await openView(replaced?.group.viewColumn, !!replaced?.isPreview);
        // A preview tab opened in its group has already taken the place of the replaced preview tab
        if (!replaced || !replaced.group.tabs.includes(replaced)) return;
        if (current === 'compact' && replaced.isDirty) {
            const compact = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === replaced.input.uri.toString());
            if (compact) await this.flush(compact);
            await vscode.window.showTextDocument(compact, { viewColumn: replaced.group.viewColumn, preserveFocus: false });
            await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
            return;
        }
        await vscode.window.tabGroups.close(replaced);
    }

    /**
     * Writes pending compact edits into the raw text now (before a save or a view switch).
     * @param {vscode.TextDocument} compact
     */
    async flush(compact) {
        const session = this._session(compact);
        if (!session?.timer) return;
        clearTimeout(session.timer);
        session.timer = null;
        await this._syncToRaw(session, compact);
    }

    /**
     * @param {vscode.Tab} tab
     * @param {vscode.Uri} target real file
     * @returns {'raw' | 'compact' | 'model' | null} which view of the file the tab shows
     */
    _tabView(tab, target) {
        const { input } = tab;
        const key = target.toString();
        if (input instanceof vscode.TabInputCustom) {
            return input.viewType === this._modelEditorOf(target) && input.uri.toString() === key ? 'model' : null;
        }
        if (!(input instanceof vscode.TabInputText)) return null;
        if (input.uri.toString() === key) return 'raw';
        if (input.uri.scheme === BabylonTextProvider.scheme && BabylonTextProvider.toRealUri(input.uri).toString() === key) return 'compact';
        return null;
    }

    /**
     * @param {vscode.Uri} uri
     * @returns {vscode.Tab | undefined} the plain text tab of a document (not a diff)
     */
    _textTab(uri) {
        return vscode.window.tabGroups.all.flatMap(group => group.tabs)
            .find(tab => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString());
    }

    /**
     * Replaces a `.babylon` file opened in a text editor (e.g. Reopen Editor With → Text Editor)
     * by its collapsed view, unless the user asked for the raw text or turned the setting off.
     * @param {vscode.TextEditor} editor
     */
    async _redirect(editor) {
        const { document } = editor;
        const key = document.uri.toString();
        if (!['file', ConvertedModels.scheme].includes(document.uri.scheme) || !isBabylonFile(document.uri) || document.isDirty) return;
        if (this._raw.has(key) || this._redirecting.has(key)) return;
        if (!vscode.workspace.getConfiguration().get(BabylonTextProvider.collapseSetting, true)) return;
        // Only a plain text tab (not a diff or a merge editor)
        const tab = this._textTab(document.uri);
        if (!tab) return;
        this._redirecting.add(key);
        try {
            const { isPreview } = tab;
            const viewColumn = tab.group.viewColumn;
            await vscode.window.tabGroups.close(tab);
            await this.open(document.uri, viewColumn, isPreview);
        } finally {
            this._redirecting.delete(key);
        }
    }

    /**
     * Inserts a fragment in place of its placeholder after a confirmation.
     * @param {vscode.Uri | string} uri collapsed text document (a string from a hover link)
     * @param {number} id
     */
    async expand(uri, id) {
        const textUri = typeof uri === 'string' ? vscode.Uri.parse(uri) : uri;
        const session = this._sessions.get(BabylonTextProvider.toRealUri(textUri).toString());
        const cut = session?.cuts.get(Number(id));
        const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === textUri.toString());
        if (!cut || !document) return;
        const offset = document.getText().indexOf(placeholder(Number(id)));
        const text = this._cutText(session, cut);
        if (offset < 0 || text === null) return;
        const answer = await vscode.window.showWarningMessage(
            `Insert ${describe(cut)} (${formatSize(text.length)}) into the text?`,
            { modal: true, detail: 'The values become editable. Large fragments make the editor slower.' },
            'Insert',
        );
        if (answer !== 'Insert') return;
        const edit = new vscode.WorkspaceEdit();
        const range = new vscode.Range(document.positionAt(offset), document.positionAt(offset + placeholder(Number(id)).length));
        edit.replace(textUri, range, text);
        await vscode.workspace.applyEdit(edit);
    }

    /**
     * Text of the real file that saving the compact view would write (the cut-out values put back).
     * @param {vscode.TextDocument} document compact view
     * @returns {string | null} null when the cut-out values are not loaded
     */
    restoredText(document) {
        const session = this._session(document);
        return session ? this._restore(session, document.getText()) : null;
    }

    /**
     * @param {CompactSession} session
     * @param {CutValue} cut
     * @returns {string | null} the current text of a cut-out value in the raw document
     */
    _cutText(session, cut) {
        const raw = this._liveRaw(session);
        const node = this._documents.get(raw)?.find(cut.path);
        return node ? raw.getText().slice(node.start, node.end) : null;
    }

    /**
     * The open raw document of a session (VS Code may close a text document that has no editor
     * and open a new one for the same file).
     * @param {CompactSession} session
     * @returns {vscode.TextDocument}
     */
    _liveRaw(session) {
        const key = session.raw.uri.toString();
        return vscode.workspace.textDocuments.find(document => document.uri.toString() === key) ?? session.raw;
    }

    /**
     * Compact text with the placeholders replaced by the current raw values.
     * @param {CompactSession} session
     * @param {string} text
     * @returns {string}
     */
    _restore(session, text) {
        return text.replace(PLACEHOLDER_PATTERN, (match, id) => {
            const cut = session.cuts.get(Number(id));
            return (cut && this._cutText(session, cut)) ?? match;
        });
    }

    // --- CodeLens and hover ---------------------------------------------------------------------

    /**
     * @param {vscode.TextDocument} document
     * @returns {vscode.CodeLens[]}
     */
    provideCodeLenses(document) {
        return this._placeholders(document).map(({ id, range, cut }) => new vscode.CodeLens(range, {
            title: `⋯ ${describe(cut)} — Expand`,
            tooltip: 'Insert the cut-out values here to edit them',
            command: BabylonTextProvider.expandCommand,
            arguments: [document.uri, id],
        }));
    }

    /**
     * @param {vscode.TextDocument} document
     * @param {vscode.Position} position
     * @returns {vscode.Hover | undefined}
     */
    provideHover(document, position) {
        const range = document.getWordRangeAtPosition(position, /"…#\d+"/);
        if (!range) return undefined;
        const id = Number(document.getText(range).slice(3, -1));
        const cut = this._session(document)?.cuts.get(id);
        if (!cut) return undefined;
        const args = encodeURIComponent(JSON.stringify([document.uri.toString(), id]));
        const markdown = new vscode.MarkdownString(
            `**Cut-out ${cut.kind}** — ${describe(cut)}, ${formatSize(cut.length)}\n\n`
            + 'The values stay in the file. '
            + `[Expand](command:${BabylonTextProvider.expandCommand}?${args}) to edit the values here.`,
        );
        markdown.isTrusted = { enabledCommands: [BabylonTextProvider.expandCommand] };
        return new vscode.Hover(markdown, range);
    }

    /**
     * @param {vscode.TextDocument} document
     * @returns {{ id: number, range: vscode.Range, cut: CutValue }[]}
     */
    _placeholders(document) {
        const session = this._session(document);
        if (!session) return [];
        const text = document.getText();
        const found = [];
        for (const match of text.matchAll(PLACEHOLDER_PATTERN)) {
            const id = Number(match[1]);
            const cut = session.cuts.get(id);
            if (!cut) continue;
            found.push({ id, cut, range: new vscode.Range(document.positionAt(match.index), document.positionAt(match.index + match[0].length)) });
        }
        return found;
    }

    /**
     * Dims the `#12` part of the placeholders, so they read as "…".
     * @param {vscode.TextEditor} editor
     */
    _decorate(editor) {
        if (editor.document.uri.scheme !== BabylonTextProvider.scheme) return;
        const ranges = this._placeholders(editor.document).map(({ range }) => new vscode.Range(range.start.translate(0, 2), range.end.translate(0, -1)));
        editor.setDecorations(this._idDecoration, ranges);
    }

    /**
     * @param {vscode.TextDocument} document
     * @returns {CompactSession | undefined}
     */
    _session(document) {
        return this._sessions.get(BabylonTextProvider.toRealUri(document.uri).toString());
    }

    /**
     * @returns {vscode.Uri | undefined} file of the active editor (text or custom)
     */
    _activeResource() {
        const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        return input?.uri ?? vscode.window.activeTextEditor?.document.uri;
    }

    // --- Sync between the compact view and the raw text ------------------------------------------

    /**
     * Collapses the raw text: placeholders for the bulky values, located by path.
     * @param {vscode.TextDocument} raw
     * @returns {{ text: string, cuts: Map<number, CutValue> }}
     */
    _collapse(raw) {
        const index = this._documents.get(raw);
        if (!index) throw vscode.FileSystemError.Unavailable('The file is not valid JSON: open it as raw text to fix it');
        const { text, fragments } = collapseBabylon(raw.getText());
        /** @type {Map<number, CutValue>} */
        const cuts = new Map();
        let placeholders = text;
        for (const [id, fragment] of fragments) {
            const node = index.nodeAt(fragment.start, fragment.end);
            if (node && node.start === fragment.start && node.end === fragment.end) {
                cuts.set(id, { path: node.path, key: fragment.key, kind: fragment.kind, size: fragment.size, length: fragment.text.length });
            } else {
                // Not a value the index knows (should not happen): keep it in the text
                placeholders = placeholders.replace(placeholder(id), fragment.text);
            }
        }
        return { text: formatJson(placeholders), cuts };
    }

    /**
     * Compact edits → raw text: the changed value (found by comparing with the last synced compact
     * text) is written into the raw document with its placeholders restored.
     * @param {vscode.TextDocument} document compact view
     */
    _onCompactChange(document) {
        const session = this._session(document);
        if (!session || session.writing === 'compact') return;
        if (session.timer) clearTimeout(session.timer);
        session.timer = setTimeout(() => {
            session.timer = null;
            this._syncToRaw(session, document);
        }, SYNC_DELAY);
    }

    /**
     * @param {CompactSession} session
     * @param {vscode.TextDocument} document compact view
     */
    async _syncToRaw(session, document) {
        session.raw = this._liveRaw(session);
        const text = document.getText();
        const region = diffRegion(session.synced, text);
        if (!region) return;
        const compactIndex = this._documents.get(document);
        // Wait for valid JSON (a value being typed)
        if (!compactIndex) return;
        let node = compactIndex.nodeAt(region.start, region.afterEnd);
        const rawIndex = this._documents.get(session.raw);
        if (!node || !rawIndex) return;
        // The value must exist in the raw text: otherwise its parent object is replaced
        while (node.parent && !rawIndex.find(node.path)) node = node.parent;
        const value = this._restore(session, text.slice(node.start, node.end));
        const target = rawIndex.find(node.path);
        const rawText = session.raw.getText();
        session.synced = text;
        if (!target || rawText.slice(target.start, target.end) === value) return;
        const edit = new vscode.WorkspaceEdit();
        edit.replace(session.raw.uri, new vscode.Range(session.raw.positionAt(target.start), session.raw.positionAt(target.end)), value);
        session.writing = 'raw';
        try {
            await vscode.workspace.applyEdit(edit);
        } finally {
            session.writing = null;
        }
    }

    /**
     * Raw text changes → compact view: the changed values are replaced (formatted) in the compact
     * text; cut-out values stay placeholders. A change that cannot be located re-collapses the text.
     * @param {import('./JsonDocuments').JsonDocumentChange} change
     */
    async _onRawChange({ document, paths }) {
        if (document.uri.scheme === BabylonTextProvider.scheme) return;
        const session = this._sessions.get(document.uri.toString());
        if (!session || session.writing === 'raw') return;
        // VS Code may have closed and reopened the raw document: keep the live one
        session.raw = document;
        const compact = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === BabylonTextProvider.toTextUri(document.uri).toString());
        if (!compact) return;
        const edit = new vscode.WorkspaceEdit();
        const compactIndex = this._documents.get(compact);
        const rawIndex = this._documents.get(document);
        if (!rawIndex) {
            // The raw text is being edited into invalid JSON: the compact view waits for it to be valid
            vscode.window.setStatusBarMessage('$(warning) Babylon: file format error. Fix the file in the source text or undo the changes.', 5000);
            return;
        }
        const cutPaths = new Set([...session.cuts.values()].map(cut => pathKey(cut.path)));
        const replacements = [];
        let full = !paths || !compactIndex;
        for (const path of paths ?? []) {
            if (full) break;
            const node = compactIndex.find(path);
            const rawNode = rawIndex.find(path);
            if (!node || !rawNode) {
                full = true;
                break;
            }
            const compactValue = compact.getText().slice(node.start, node.end);
            // A cut-out value that is still collapsed: the placeholder stays
            if (cutPaths.has(pathKey(path)) && /^"…#\d+"$/.test(compactValue)) continue;
            const line = compact.lineAt(compact.positionAt(node.start).line).text;
            const indent = line.slice(0, line.length - line.trimStart().length);
            replacements.push({ node, text: formatJson(document.getText().slice(rawNode.start, rawNode.end), '  ', indent) });
        }
        if (full) {
            const { text, cuts } = this._collapse(document);
            session.cuts = cuts;
            edit.replace(compact.uri, new vscode.Range(compact.positionAt(0), compact.positionAt(compact.getText().length)), text);
        } else {
            if (!replacements.length) return;
            replacements.forEach(({ node, text }) => edit.replace(compact.uri, new vscode.Range(compact.positionAt(node.start), compact.positionAt(node.end)), text));
        }
        session.writing = 'compact';
        try {
            await vscode.workspace.applyEdit(edit);
        } finally {
            session.writing = null;
        }
        session.synced = compact.getText();
        this._onDidChangeCodeLenses.fire();
        // The raw text has no unsaved changes (e.g. it was reverted): neither has the compact view
        if (!document.isDirty && compact.isDirty) await compact.save();
    }

    /**
     * @param {vscode.TextDocument} document
     */
    async _onRawSaved(document) {
        if (document.uri.scheme === BabylonTextProvider.scheme) return;
        const compact = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === BabylonTextProvider.toTextUri(document.uri).toString());
        if (compact?.isDirty) await compact.save();
    }

    // --- File system provider ---------------------------------------------------------------

    /**
     * The compact view follows the raw text through edits, not through file changes.
     * @returns {vscode.Disposable}
     */
    watch() {
        return new vscode.Disposable(() => {});
    }

    /**
     * @param {vscode.Uri} uri
     * @returns {Promise<vscode.FileStat>}
     */
    async stat(uri) {
        const real = BabylonTextProvider.toRealUri(uri);
        const stat = await vscode.workspace.fs.stat(real);
        const session = this._sessions.get(real.toString());
        // The size of the compact text, so VS Code does not treat the document as a large file;
        // a stable mtime, so saving the raw text does not look like a conflicting change on disk
        return { type: stat.type, ctime: stat.ctime, mtime: session?.mtime ?? stat.mtime, size: session?.synced.length ?? Math.min(stat.size, 1e6) };
    }

    /**
     * Collapses the live raw text document (not the file: it may have unsaved changes).
     * @param {vscode.Uri} uri
     * @returns {Promise<Uint8Array>}
     */
    async readFile(uri) {
        const real = BabylonTextProvider.toRealUri(uri);
        const raw = await vscode.workspace.openTextDocument(real);
        const { text, cuts } = this._collapse(raw);
        const previous = this._sessions.get(real.toString());
        const mtime = previous?.mtime ?? (await vscode.workspace.fs.stat(real)).mtime;
        this._sessions.set(real.toString(), { raw, cuts, synced: text, mtime, writing: null, timer: null });
        this._onDidChangeCodeLenses.fire();
        return new TextEncoder().encode(text);
    }

    /**
     * Saving the compact view saves the raw document (the compact edits are already in it).
     * @param {vscode.Uri} uri
     */
    async writeFile(uri) {
        const real = BabylonTextProvider.toRealUri(uri);
        const session = this._sessions.get(real.toString());
        if (!session) throw vscode.FileSystemError.Unavailable('Reopen the compact view: it is not connected to the file');
        const compact = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === uri.toString());
        if (compact) await this.flush(compact);
        // A raw document closed by VS Code is reopened (its edits were saved or are in this one)
        const raw = session.raw.isClosed ? await vscode.workspace.openTextDocument(session.raw.uri) : this._liveRaw(session);
        session.raw = raw;
        if (raw.isDirty && !(await raw.save())) throw new Error('The file could not be saved');
        session.mtime = Date.now();
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
