import * as vscode from 'vscode';
import { getExtension, determineMimeType, toBase64Url } from '../utils';

/**
 * 
 */
export class BabylonDocument {

    /**
     * @param {vscode.Uri} uri
     * @param {Uint8Array} content
     */
    constructor(uri, content) {
        this.uri = uri;
        this.type = getExtension(uri.path);
        this.content = content;
        this.fileName = uri.path;
        this.mimeType = determineMimeType(content, this.type);
        /** Whether the 3D editor has edits that are not saved (a change on disk then does not reload) */
        this.hasUnsavedEdits = false;
        /** @type {vscode.Disposable[]} */
        this._disposables = [];
    }
    /**
     * Returns a standalone copy of the content bytes. `content.buffer` may be a larger
     * pooled buffer, so it must be cut by byteOffset/byteLength before posting to a webview.
     * @returns {ArrayBuffer}
     */
    getArrayBuffer() {
        const { buffer, byteOffset, byteLength } = this.content;
        return buffer.slice(byteOffset, byteOffset + byteLength);
    }
    getBase64Url() {
        return toBase64Url(this.content, this.mimeType);
    }

    dispose() {
        // Очистка ресурсов, если это необходимо
    }
}