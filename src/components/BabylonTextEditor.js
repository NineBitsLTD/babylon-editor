import * as vscode from 'vscode';
import { JsonIndex } from '../utils/JsonIndex';
import { BabylonTextProvider } from './BabylonTextProvider';
import { ConvertedModels } from './ConvertedModels';

/** @typedef {import('../editor/BabylonJsonBinding').JsonPatch} JsonPatch */

export const BabylonTextEditorID = 'babylon-editor.textEditor';

/**
 * Text of the item of an array whose key field has the given value (or of one field of it).
 * @param {import('../utils/JsonIndex').JsonIndex} index
 * @param {string} text the indexed text
 * @param {import('../editor/ModelTreeBridge').TreeItemSource} source
 * @returns {string | null}
 */
function findItem(index, text, { array, key, id, field }) {
    const items = index.find(array)?.children ?? [];
    for (const item of items) {
        const keyNode = item.children.find(child => child.path[child.path.length - 1] === key);
        if (!keyNode) continue;
        let value;
        try {
            value = JSON.parse(text.slice(keyNode.start, keyNode.end));
        } catch {
            continue;
        }
        if (value !== id) continue;
        if (!field) return text.slice(item.start, item.end);
        const fieldNode = item.children.find(child => child.path[child.path.length - 1] === field);
        return fieldNode ? text.slice(fieldNode.start, fieldNode.end) : 'null';
    }
    return null;
}

/** Formats of Save As: extension and the label of the file dialog filter. */
const SAVE_AS_FORMATS = [
    ['babylon', 'Babylon'],
    ['glb', 'glTF binary'],
    ['obj', 'Wavefront OBJ'],
    ['stl', 'STL'],
];

/** Text changes (typing) are sent to the 3D views after this pause. */
const PATCH_DELAY = 150;
/** Changes that cannot be patched reload the model after this pause (if the text is valid JSON). */
const RELOAD_DELAY = 800;
/** A changed value larger than this (characters) reloads the model instead of being sent as a patch. */
const MAX_PATCH_LENGTH = 1e6;

/**
 * @param {string} detail
 * @returns {string} the message shown over the 3D view while the text cannot be parsed
 */
export function formatErrorMessage(detail) {
    return `File format error: ${detail}. Fix the file in the source text or undo the changes.`;
}

/**
 * Open text document with its 3D views.
 * @typedef {object} DocumentSession
 * @property {vscode.TextDocument} document
 * @property {Set<vscode.WebviewPanel>} panels
 * @property {{ panel: vscode.WebviewPanel, patches: JsonPatch[] } | null} pending own edit being applied
 * @property {Set<string>} changedPaths paths changed by the text, waiting to be sent
 * @property {boolean} needsReload a change could not be mapped to a value
 * @property {boolean} structural a structural edit (objects added / removed) is being applied: reload
 * @property {ReturnType<typeof setTimeout> | null} timer
 */

/**
 * 3D editor of `.babylon` files as a custom *text* editor: the text document is the single source
 * of truth, so the 3D views, the raw text and the compact view show one document with one undo
 * stack, one dirty state and one save (the file is saved as the text is, not regenerated).
 *
 * 3D edits arrive as patches (`{ path, value }`) and are written into the text in place, using a
 * JsonIndex of the document. Text changes from anywhere else (typing, undo/redo, revert, the
 * compact view) are mapped back to the changed values and sent to the 3D views as patches; a
 * change the views cannot apply in place reloads the model, keeping the view.
 *
 * @implements {vscode.CustomTextEditorProvider}
 */
export class BabylonTextEditor {

    static saveCommand = 'babylon-editor.save';
    static saveAsCommand = 'babylon-editor.saveAs';

    /**
     * @param {import('./BabylonEditor').BabylonEditor} webviews sets up the editor webview
     * @param {import('./ModelTreeProvider').ModelTreeProvider} modelTree
     * @param {import('./BabylonTextProvider').BabylonTextProvider} textProvider compact views
     * @param {import('./JsonDocuments').JsonDocuments} documents indexes of the open texts
     * @param {import('./WebviewTasks').WebviewTasks} tasks checks the model in a webview
     * @param {ConvertedModels} converted models of other formats edited as `.babylon` documents
     */
    constructor(webviews, modelTree, textProvider, documents, tasks, converted) {
        this._tasks = tasks;
        this._converted = converted;
        converted.setPanelResolver(uri => this.panelOf(uri));
        this._webviews = webviews;
        this._documents = documents;
        this._modelTree = modelTree;
        this._textProvider = textProvider;
        /** @type {Map<string, DocumentSession>} */
        this._sessions = new Map();
        /** @type {Map<string, Promise<import('../utils/JsonIndex').JsonIndex | null>>} index of the saved text per file (tree decorations) */
        this._saved = new Map();
        modelTree.setStateResolver((uri, source) => this._changeState(uri, source));
    }

    /**
     * @param {vscode.Uri} uri a `.babylon` document
     * @returns {vscode.WebviewPanel | undefined} an open 3D view of it
     */
    panelOf(uri) {
        return this._sessions.get(uri.toString())?.panels.values().next().value;
    }

    /**
     * @returns {vscode.Disposable}
     */
    register() {
        return vscode.Disposable.from(
            vscode.window.registerCustomEditorProvider(BabylonTextEditorID, this, {
                webviewOptions: { retainContextWhenHidden: true },
            }),
            this._documents.onDidChange(change => this._onDocumentChange(change)),
            vscode.commands.registerCommand(BabylonTextEditor.saveCommand, () => this.saveWithCheck()),
            vscode.commands.registerCommand(BabylonTextEditor.saveAsCommand, () => this._run(() => this.saveAs())),
            vscode.workspace.onDidSaveTextDocument((document) => {
                if (!this._sessions.has(document.uri.toString())) return;
                this._saved.set(document.uri.toString(), Promise.resolve(this._buildIndex(document.getText())));
                this._modelTree.refresh();
            }),
        );
    }

    // --- Tree decorations ----------------------------------------------------------------------------

    /**
     * @param {string} text
     * @returns {import('../utils/JsonIndex').JsonIndex | null}
     */
    _buildIndex(text) {
        try {
            const index = new JsonIndex(text);
            index.text = text;
            return index;
        } catch {
            return null;
        }
    }

    /**
     * Whether an object of the tree changed since the file was saved: its text in the document is
     * compared with the saved file (objects are matched by id, so removed ones do not shift the others).
     * @param {vscode.Uri} uri
     * @param {import('../editor/ModelTreeBridge').TreeItemSource} source
     * @returns {Promise<'modified' | 'added' | null>}
     */
    async _changeState(uri, source) {
        const session = this._sessions.get(uri.toString());
        if (!session) return null;
        const key = uri.toString();
        if (!this._saved.has(key)) {
            this._saved.set(key, vscode.workspace.fs.readFile(uri).then(bytes => this._buildIndex(new TextDecoder().decode(bytes)), () => null));
        }
        const saved = await this._saved.get(key);
        const current = this._index(session);
        if (!saved || !current) return null;
        const text = session.document.getText();
        const now = findItem(current, text, source);
        if (!now) return null;
        const before = findItem(saved, saved.text, source);
        if (!before) return 'added';
        return now === before ? null : 'modified';
    }

    // --- Save with a model check -----------------------------------------------------------------

    /**
     * Saves the active `.babylon` document (3D, raw or compact view) after checking in a webview
     * that the model loads; when it does not, the user decides whether to save anyway. Bound to
     * Ctrl/Cmd+S in these editors (the menu, auto save and Save All use the plain save).
     */
    async saveWithCheck() {
        const active = this._activeModelText();
        if (!active) {
            await vscode.commands.executeCommand('workbench.action.files.save');
            return;
        }
        const { document, real, text } = active;
        if (!document.isDirty) return;
        if (text !== null) {
            const error = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Window, title: 'Checking the model before saving…' },
                () => this._validate(real, text),
            );
            if (error) {
                const name = real.path.split('/').pop();
                const answer = await vscode.window.showErrorMessage(
                    `${name} contains errors: the model does not load.`,
                    { modal: true, detail: error },
                    'Save Anyway',
                );
                if (answer !== 'Save Anyway') return;
            }
        }
        await document.save();
    }

    /**
     * Saves the model of the active `.babylon` document (3D, raw or compact view) into a file of a
     * format the user chooses (`.babylon`, `.glb`, `.obj`, `.stl`), converting it in a webview.
     * The document itself stays as it is. Bound to Ctrl/Cmd+Shift+S in these editors.
     */
    async saveAs() {
        const active = this._activeModelText();
        if (!active) {
            await vscode.commands.executeCommand('workbench.action.files.saveAs');
            return;
        }
        const { real, text } = active;
        if (text === null) throw new Error('The compact view has placeholders that cannot be restored: save the raw text instead');
        const model = ConvertedModels.toOriginalUri(real) ?? real;
        const current = model.path.split('.').pop().toLowerCase();
        const formats = SAVE_AS_FORMATS.filter(([type]) => type === current).concat(SAVE_AS_FORMATS.filter(([type]) => type !== current));
        const target = await vscode.window.showSaveDialog({
            title: 'Save the model as',
            defaultUri: model,
            filters: Object.fromEntries(formats.map(([type, label]) => [label, [type]])),
        });
        if (!target) return;
        const type = target.path.split('.').pop().toLowerCase();
        if (!SAVE_AS_FORMATS.some(([candidate]) => candidate === type)) {
            throw new Error(`Choose one of the formats: ${SAVE_AS_FORMATS.map(([candidate]) => `.${candidate}`).join(', ')}`);
        }
        const name = target.path.split('/').pop();
        if (!(await this._converted.confirmFormat(type, name))) return;
        const data = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Window, title: `Saving ${name}…` },
            () => this._converted.export(real, new TextEncoder().encode(text), type),
        );
        await vscode.workspace.fs.writeFile(target, data);
        const open = 'Open';
        if (await vscode.window.showInformationMessage(`Saved ${name}.`, open) === open) await vscode.commands.executeCommand('vscode.open', target);
    }

    /**
     * @returns {{ document: vscode.TextDocument, real: vscode.Uri, text: string | null } | null} the
     *   `.babylon` document of the active tab (3D, raw or compact view): the document of the tab,
     *   the model document it shows and the model text (null: compact placeholders cannot be restored)
     */
    _activeModelText() {
        const uri = vscode.window.tabGroups.activeTabGroup.activeTab?.input?.uri;
        const document = uri && vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === uri.toString());
        if (!document || !document.uri.path.toLowerCase().endsWith('.babylon')) return null;
        const compact = document.uri.scheme === BabylonTextProvider.scheme;
        return {
            document,
            real: compact ? BabylonTextProvider.toRealUri(document.uri) : document.uri,
            text: compact ? this._textProvider.restoredText(document) : document.getText(),
        };
    }

    /**
     * @param {() => Promise<void>} action
     */
    async _run(action) {
        try {
            await action();
        } catch (error) {
            vscode.window.showErrorMessage(String(error?.message || error));
        }
    }

    /**
     * Loads the text in a webview: an open 3D view of the file, or a helper panel for the check.
     * @param {vscode.Uri} uri real file (relative textures are resolved against its folder)
     * @param {string} text
     * @returns {Promise<string | null>} the error, or null when the model loads
     */
    async _validate(uri, text) {
        try {
            JSON.parse(text);
        } catch (error) {
            return `The text is not valid JSON: ${error.message}`;
        }
        const data = new TextEncoder().encode(text).buffer;
        const check = async panel => (await this._tasks.run(panel, 'validate', { data })).error ?? null;
        const panel = this.panelOf(uri);
        return panel ? check(panel) : this._tasks.withHelper(uri, `Checking ${uri.path.split('/').pop()}`, check);
    }

    /**
     * @param {vscode.TextDocument} document
     * @param {vscode.WebviewPanel} panel
     */
    async resolveCustomTextEditor(document, panel) {
        // The compact view also matches *.babylon, but its text has placeholders instead of the data
        if (document.uri.scheme === BabylonTextProvider.scheme) {
            const { viewColumn } = panel;
            panel.dispose();
            await vscode.commands.executeCommand('vscode.openWith', BabylonTextProvider.toRealUri(document.uri), BabylonTextEditorID, viewColumn);
            return;
        }
        const session = this._session(document);
        session.panels.add(panel);
        this._webviews.setupWebview(panel, { uri: document.uri, type: 'babylon', mimeType: 'application/json' }, { textBacked: true });
        const treeTracking = this._modelTree.trackPanel(panel, document.uri);
        panel.onDidDispose(() => {
            treeTracking.dispose();
            session.panels.delete(panel);
            if (!session.panels.size) this._sessions.delete(document.uri.toString());
        });
        panel.webview.onDidReceiveMessage((message) => {
            if (this._modelTree.handleMessage(panel, message) || this._tasks.handleMessage(message)) return;
            switch (message.type) {
                case 'ready':
                    panel.webview.postMessage({ type: 'loadModel', data: this._bytes(document) });
                    break;
                case 'patch':
                    this._writePatches(session, panel, message.patches);
                    break;
                case 'documentOps':
                    this._writeOps(session, message.label, message.ops);
                    break;
                case 'requestReload':
                    panel.webview.postMessage({ type: 'reloadModel', data: this._bytes(document), keepView: true });
                    break;
            }
        });
    }

    /**
     * @param {vscode.TextDocument} document
     * @returns {DocumentSession}
     */
    _session(document) {
        const key = document.uri.toString();
        let session = this._sessions.get(key);
        if (!session) {
            session = { document, panels: new Set(), pending: null, changedPaths: new Set(), needsReload: false, structural: false, timer: null };
            // Start tracking the text, so changes can be mapped to values
            this._documents.get(document);
            this._sessions.set(key, session);
        }
        return session;
    }

    /**
     * @param {vscode.TextDocument} document
     * @returns {ArrayBuffer}
     */
    _bytes(document) {
        return new TextEncoder().encode(document.getText()).buffer;
    }

    /**
     * @param {DocumentSession} session
     * @returns {import('../utils/JsonIndex').JsonIndex | null}
     */
    _index(session) {
        return this._documents.get(session.document);
    }

    // --- 3D edits → text ---------------------------------------------------------------------

    /**
     * Writes the patches of a 3D edit into the text (one undo step).
     * @param {DocumentSession} session
     * @param {vscode.WebviewPanel} panel the editor that made the edit (it already shows it)
     * @param {JsonPatch[]} patches
     */
    async _writePatches(session, panel, patches) {
        const index = this._index(session);
        if (!index) {
            vscode.window.showErrorMessage(`The 3D edit was not written. ${formatErrorMessage('the text is not valid JSON')}`);
            return;
        }
        const { document } = session;
        const edit = new vscode.WorkspaceEdit();
        const failed = [];
        for (const patch of patches) {
            const change = this._textChange(index, patch);
            if (!change) {
                failed.push(patch.path.join('.'));
                continue;
            }
            const range = new vscode.Range(document.positionAt(change.start), document.positionAt(change.end));
            edit.replace(document.uri, range, change.text);
        }
        if (failed.length) {
            vscode.window.showWarningMessage(`Some 3D edits have no place in the text and were not saved: ${failed.join(', ')}`);
        }
        session.pending = { panel, patches };
        try {
            await vscode.workspace.applyEdit(edit);
        } finally {
            session.pending = null;
        }
    }

    /**
     * Writes structural operations of a tree command (objects added / removed) into the text as one
     * undo step; the 3D views reload the model.
     * @param {DocumentSession} session
     * @param {string} label
     * @param {import('../editor/ModelEdits').DocumentOp[]} ops
     */
    async _writeOps(session, label, ops) {
        const index = this._index(session);
        if (!index) {
            vscode.window.showErrorMessage(`${label} was not written. ${formatErrorMessage('the text is not valid JSON')}`);
            return;
        }
        const { document } = session;
        this._lastText = document.getText();
        const edit = new vscode.WorkspaceEdit();
        for (const op of ops) {
            const change = op.op === 'set' ? this._textChange(index, op) : op.op === 'insert' ? this._insertChange(index, op) : this._removeChange(index, op);
            if (!change) {
                vscode.window.showErrorMessage(`${label} was not written: ${(op.path ?? op.arrayPath).join('.')} has no place in the text`);
                return;
            }
            edit.replace(document.uri, new vscode.Range(document.positionAt(change.start), document.positionAt(change.end)), change.text);
        }
        session.structural = true;
        try {
            await vscode.workspace.applyEdit(edit);
        } finally {
            session.structural = false;
        }
    }

    /**
     * @param {import('../utils/JsonIndex').JsonIndex} index
     * @param {{ arrayPath: (string | number)[], value: any }} op
     * @returns {{ start: number, end: number, text: string } | null}
     */
    _insertChange(index, { arrayPath, value }) {
        const array = index.find(arrayPath);
        if (!array) return this._textChange(index, { path: arrayPath, value: [value] });
        if (array.kind === 'array') {
            return { start: array.end - 1, end: array.end - 1, text: `${array.children.length ? ', ' : ''}${JSON.stringify(value)}` };
        }
        // An empty (or flat) array is a leaf of the index: it is rewritten with the new item
        return { start: array.start, end: array.end, text: JSON.stringify([...(JSON.parse(this._lastText.slice(array.start, array.end)) ?? []), value]) };
    }

    /**
     * Removes an item of an array with the separator next to it.
     * @param {import('../utils/JsonIndex').JsonIndex} index
     * @param {{ path: (string | number)[] }} op
     * @returns {{ start: number, end: number, text: string } | null}
     */
    _removeChange(index, { path }) {
        const node = index.find(path);
        if (!node?.parent) return null;
        const siblings = node.parent.children;
        const position = siblings.indexOf(node);
        if (position < siblings.length - 1) return { start: node.start, end: siblings[position + 1].start, text: '' };
        if (position > 0) return { start: siblings[position - 1].end, end: node.end, text: '' };
        return { start: node.start, end: node.end, text: '' };
    }

    /**
     * @param {import('../utils/JsonIndex').JsonIndex} index
     * @param {JsonPatch} patch
     * @returns {{ start: number, end: number, text: string } | null}
     */
    _textChange(index, { path, value }) {
        const text = JSON.stringify(value);
        const node = index.find(path);
        if (node) return { start: node.start, end: node.end, text };
        // A property the file does not have yet is added at the end of its object
        const parent = index.find(path.slice(0, -1));
        if (!parent || parent.kind !== 'object') return null;
        const insert = `${parent.children.length ? ', ' : ''}${JSON.stringify(path[path.length - 1])}: ${text}`;
        return { start: parent.end - 1, end: parent.end - 1, text: insert };
    }

    // --- text → 3D views -----------------------------------------------------------------------

    /**
     * @param {import('./JsonDocuments').JsonDocumentChange} change
     */
    _onDocumentChange({ document, paths }) {
        const session = this._sessions.get(document.uri.toString());
        if (!session) return;
        if (session.structural) {
            // Objects were added or removed: reload rather than patch a whole array
            session.needsReload = true;
            this._schedule(session);
            return;
        }
        if (session.pending) {
            // Our own 3D edit: the other 3D views of the document get the same patches
            const { panel, patches } = session.pending;
            session.panels.forEach((other) => {
                if (other !== panel) other.webview.postMessage({ type: 'applyPatches', patches });
            });
            return;
        }
        if (paths) {
            paths.forEach(path => session.changedPaths.add(JSON.stringify(path)));
        } else {
            session.needsReload = true;
        }
        this._schedule(session);
    }

    /**
     * @param {DocumentSession} session
     */
    _schedule(session) {
        if (session.timer) clearTimeout(session.timer);
        session.timer = setTimeout(() => {
            session.timer = null;
            this._flush(session);
        }, session.needsReload ? RELOAD_DELAY : PATCH_DELAY);
    }

    /**
     * Sends the text changes to the 3D views: as patches when every changed value is valid JSON,
     * otherwise as a reload of the model (when the whole text is valid again).
     * @param {DocumentSession} session
     */
    _flush(session) {
        const text = session.document.getText();
        const index = this._index(session);
        if (!index) {
            session.needsReload = true;
            let detail = 'the text is not valid JSON';
            try {
                JSON.parse(text);
            } catch (error) {
                detail = error.message;
            }
            session.panels.forEach(panel => panel.webview.postMessage({ type: 'documentError', message: formatErrorMessage(detail) }));
            return;
        }
        let patches = [];
        if (!session.needsReload) {
            for (const key of session.changedPaths) {
                const node = index.find(JSON.parse(key));
                if (!node || node.end - node.start > MAX_PATCH_LENGTH) {
                    patches = null;
                    break;
                }
                try {
                    patches.push({ path: node.path, value: JSON.parse(text.slice(node.start, node.end)) });
                } catch {
                    // A value being typed (e.g. "1."): wait for the next change
                    return;
                }
            }
        }
        if (patches === null || session.needsReload) {
            try {
                JSON.parse(text);
            } catch (error) {
                // The 3D views keep the last model and say why; the next change schedules again
                session.needsReload = true;
                session.panels.forEach(panel => panel.webview.postMessage({ type: 'documentError', message: formatErrorMessage(error.message) }));
                return;
            }
            session.panels.forEach(panel => panel.webview.postMessage({ type: 'reloadModel', data: this._bytes(session.document), keepView: true }));
        } else if (patches.length) {
            session.panels.forEach(panel => panel.webview.postMessage({ type: 'applyPatches', patches }));
        }
        session.changedPaths.clear();
        session.needsReload = false;
    }
}
