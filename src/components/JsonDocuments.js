import * as vscode from 'vscode';
import { JsonIndex } from '../utils/JsonIndex';

/**
 * A change of a tracked document with the values it touched.
 * @typedef {object} JsonDocumentChange
 * @property {vscode.TextDocument} document
 * @property {(string | number)[][] | null} paths changed values; null when the change could not
 *   be mapped to values (the index was rebuilt, or the text is not valid JSON)
 */

/**
 * @param {vscode.TextDocument} document
 * @returns {boolean} a `.babylon` text or its compact view
 */
function isModelText(document) {
    return document.uri.path.toLowerCase().endsWith('.babylon');
}

/**
 * JsonIndex of open JSON documents (`.babylon` texts), shared by the 3D editor and the compact
 * view and kept up to date on every change. Listeners are called after the index was updated.
 */
export class JsonDocuments {

    constructor() {
        /** @type {Map<string, JsonIndex | null>} null: the text is not valid JSON */
        this._indexes = new Map();
        this._onDidChange = new vscode.EventEmitter();
        /** @type {vscode.Event<JsonDocumentChange>} */
        this.onDidChange = this._onDidChange.event;
    }

    /**
     * @returns {vscode.Disposable}
     */
    register() {
        return vscode.Disposable.from(
            vscode.workspace.onDidChangeTextDocument(event => this._update(event)),
            vscode.workspace.onDidCloseTextDocument(document => this._indexes.delete(document.uri.toString())),
            this._onDidChange,
        );
    }

    /**
     * Index of a document, built on first use; changes are tracked from then on.
     * @param {vscode.TextDocument} document
     * @returns {JsonIndex | null} null while the text is not valid JSON
     */
    get(document) {
        const key = document.uri.toString();
        if (!this._indexes.has(key) || !this._indexes.get(key)) this._indexes.set(key, this._build(document.getText()));
        return this._indexes.get(key);
    }

    /**
     * @param {vscode.TextDocument} document
     * @returns {boolean}
     */
    isTracked(document) {
        return this._indexes.has(document.uri.toString());
    }

    /**
     * @param {string} text
     * @returns {JsonIndex | null}
     */
    _build(text) {
        try {
            return new JsonIndex(text);
        } catch {
            return null;
        }
    }

    /**
     * @param {vscode.TextDocumentChangeEvent} event
     */
    _update({ document, contentChanges }) {
        const key = document.uri.toString();
        if (!contentChanges.length) return;
        if (!this._indexes.has(key)) {
            // A model text closed and opened again by VS Code (e.g. while only its compact view is
            // shown) is tracked again; what changed is unknown
            if (!isModelText(document)) return;
            this._indexes.set(key, this._build(document.getText()));
            this._onDidChange.fire({ document, paths: null });
            return;
        }
        const text = document.getText();
        const index = this._indexes.get(key);
        let paths = null;
        if (index) {
            paths = [];
            let shift = 0;
            // Offsets are relative to the text before the whole change: apply in document order
            for (const change of [...contentChanges].sort((a, b) => a.rangeOffset - b.rangeOffset)) {
                const node = index.applyChange(text, change.rangeOffset + shift, change.rangeLength, change.text.length);
                if (!node) {
                    paths = null;
                    break;
                }
                paths.push(node.path);
                shift += change.text.length - change.rangeLength;
            }
        }
        if (!paths) this._indexes.set(key, this._build(text));
        this._onDidChange.fire({ document, paths });
    }
}
