import * as vscode from 'vscode';

/**
 * A model file converted to the `.babylon` format.
 * @typedef {object} ConvertedEntry
 * @property {vscode.Uri} original the model file
 * @property {string} type its format (extension without the dot)
 * @property {Uint8Array} data the `.babylon` document as last converted or saved
 * @property {import('../editor/ModelSerializer').SourceInfo} source what saving back needs
 * @property {number} ctime
 * @property {number} mtime
 * @property {Uint8Array | null} written bytes of the original file written by the last save
 * @property {vscode.Disposable} watcher
 */

/** Formats edited as a converted `.babylon` document. */
const CONVERTIBLE_TYPES = ['glb', 'gltf', 'gltf2', 'obj', 'stl'];
/** Formats a converted document is saved back into; the others are only converted (Save As). */
const WRITABLE_TYPES = ['glb', 'obj', 'stl'];
/** What a format cannot hold, shown before the first save into it. */
const FORMAT_LOSSES = {
    glb: 'Transforms of skinned meshes are ignored and data the glTF exporter does not support is dropped.',
    obj: 'OBJ keeps only meshes: skeletons, animations, cameras and lights are dropped, node transforms are baked into the vertices, and the .mtl file is not rewritten.',
    stl: 'STL keeps only the geometry: names, materials, skeletons, animations, cameras and lights are dropped, node transforms are baked into the vertices.',
};
/**
 * Texts larger than this are not synced to extensions by VS Code (`TextDocument` is not
 * available), so such models stay in the binary editor.
 */
const MAX_TEXT_LENGTH = 48 * 1024 * 1024;

/**
 * @param {Uint8Array | null} a
 * @param {Uint8Array | null} b
 * @returns {boolean}
 */
function isSameContent(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let index = 0; index < a.length; index++) {
        if (a[index] !== b[index]) return false;
    }
    return true;
}

/**
 * @param {Uint8Array} bytes
 * @returns {ArrayBuffer} a copy of exactly these bytes (a Node Buffer may be a view of a larger
 *   pool, and its `slice` does not copy)
 */
function toArrayBuffer(bytes) {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

/**
 * @param {ArrayBuffer | ArrayBufferView} data
 * @returns {Uint8Array}
 */
function toBytes(data) {
    return data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/**
 * Model files of other formats (glTF, OBJ, STL) opened as `.babylon` documents: a file system for
 * the `babylon-model` scheme (`babylon-model:<path>.babylon?<model file uri>`) whose files are
 * converted from the model file when they are read and converted back into it when they are saved.
 * The document is an ordinary `.babylon` text, so the 3D editor, the raw text and the compact view
 * work on it as on a `.babylon` file. The conversions run in an editor webview (WebviewTasks).
 *
 * @implements {vscode.FileSystemProvider}
 */
export class ConvertedModels {

    static scheme = 'babylon-model';

    /**
     * @param {vscode.Uri} uri
     * @returns {boolean} whether the file is a model edited as a converted document
     */
    static isConvertible(uri) {
        return uri.scheme !== ConvertedModels.scheme && CONVERTIBLE_TYPES.includes(ConvertedModels._type(uri));
    }

    /**
     * @param {vscode.Uri} original model file
     * @returns {vscode.Uri} its converted document
     */
    static toModelUri(original) {
        return vscode.Uri.from({ scheme: ConvertedModels.scheme, path: `${original.path}.babylon`, query: original.toString() });
    }

    /**
     * @param {vscode.Uri} uri
     * @returns {vscode.Uri | null} the model file of a converted document, null for other uris
     */
    static toOriginalUri(uri) {
        return uri.scheme === ConvertedModels.scheme ? vscode.Uri.parse(uri.query) : null;
    }

    /**
     * @param {vscode.Uri} uri
     * @returns {string}
     */
    static _type(uri) {
        return uri.path.split('.').pop().toLowerCase();
    }

    /**
     * @param {import('./WebviewTasks').WebviewTasks} tasks
     * @param {string} version extension version (the `producer` of converted documents)
     */
    constructor(tasks, version) {
        this._tasks = tasks;
        this._version = version;
        /** @type {Map<string, ConvertedEntry>} by converted document uri */
        this._entries = new Map();
        /** @type {Map<string, Promise<ConvertedEntry>>} conversions in progress */
        this._loading = new Map();
        /** Formats the user agreed to save into this session (the file is regenerated). */
        this._confirmed = new Set();
        /** @type {(uri: vscode.Uri) => vscode.WebviewPanel | undefined} an open 3D view of a document */
        this._panelOf = () => undefined;
        this._onDidChangeFile = new vscode.EventEmitter();
        this.onDidChangeFile = this._onDidChangeFile.event;
    }

    /**
     * @param {(uri: vscode.Uri) => vscode.WebviewPanel | undefined} resolver
     */
    setPanelResolver(resolver) {
        this._panelOf = resolver;
    }

    /**
     * @returns {vscode.Disposable}
     */
    register() {
        return vscode.Disposable.from(
            vscode.workspace.registerFileSystemProvider(ConvertedModels.scheme, this, { isCaseSensitive: true }),
            this._onDidChangeFile,
            new vscode.Disposable(() => this._entries.forEach(entry => entry.watcher.dispose())),
        );
    }

    /**
     * Converts a model file (unless its document is converted already).
     * @param {vscode.Uri} original
     * @param {object} [options]
     * @param {vscode.WebviewPanel} [options.panel] an editor webview to convert in (else a helper panel)
     * @param {Uint8Array} [options.content] the content to convert (e.g. a backup), else the file
     * @returns {Promise<vscode.Uri>} the converted document
     */
    async open(original, { panel, content } = {}) {
        const uri = ConvertedModels.toModelUri(original);
        await this._entry(uri, { panel, content });
        return uri;
    }

    /**
     * Converts a `.babylon` document into a model format (in an open 3D view of the document, else
     * in a helper panel).
     * @param {vscode.Uri} document the `.babylon` document (file or converted)
     * @param {Uint8Array} data its text
     * @param {string} type target format
     * @returns {Promise<Uint8Array>}
     */
    async export(document, data, type) {
        if (type === 'babylon') return data;
        // An OBJ keeps referring to the material library of the converted OBJ; an STL keeps its encoding
        const entry = this._entries.get(document.toString());
        const source = {
            mtllib: type === 'obj' && entry?.type === 'obj' ? entry.source?.mtllib ?? null : null,
            binaryStl: entry?.type === 'stl' ? entry.source?.binaryStl ?? true : true,
        };
        const location = ConvertedModels.toOriginalUri(document) ?? document;
        const work = async (panel) => {
            const reply = await this._tasks.run(panel, 'exportModel', { data: toArrayBuffer(data), format: type, source });
            if (reply.error) throw new Error(reply.error);
            return toBytes(reply.data);
        };
        const panel = this._panelOf(document);
        return panel ? work(panel) : this._tasks.withHelper(location, `Converting to .${type}`, work);
    }

    // --- FileSystemProvider ----------------------------------------------------------------------

    /**
     * @returns {vscode.Disposable}
     */
    watch() {
        // The model files are watched per converted document
        return new vscode.Disposable(() => {});
    }

    /**
     * @param {vscode.Uri} uri
     * @returns {Promise<vscode.FileStat>}
     */
    async stat(uri) {
        const entry = await this._entry(uri);
        return { type: vscode.FileType.File, ctime: entry.ctime, mtime: entry.mtime, size: entry.data.byteLength };
    }

    /**
     * @param {vscode.Uri} uri
     * @returns {Promise<Uint8Array>}
     */
    async readFile(uri) {
        return (await this._entry(uri)).data;
    }

    /**
     * Saves a converted document: it is converted back into the model file.
     * @param {vscode.Uri} uri
     * @param {Uint8Array} content
     */
    async writeFile(uri, content) {
        const entry = await this._entry(uri);
        const name = entry.original.path.split('/').pop();
        if (!WRITABLE_TYPES.includes(entry.type)) {
            throw vscode.FileSystemError.NoPermissions(`.${entry.type} files cannot be written: use Save As to save ${name} in another format`);
        }
        if (!(await this.confirmFormat(entry.type, name))) throw vscode.FileSystemError.Unavailable('Saving was cancelled');
        const bytes = await this.export(uri, content, entry.type);
        // Set before writing, so the file watcher recognizes the own change
        entry.written = bytes;
        await vscode.workspace.fs.writeFile(entry.original, bytes);
        entry.data = content;
        entry.mtime = Date.now();
    }

    /**
     * Asks once per session and format whether the model may be regenerated in that format.
     * @param {string} type
     * @param {string} name file name shown in the question
     * @returns {Promise<boolean>}
     */
    async confirmFormat(type, name) {
        if (type === 'babylon' || this._confirmed.has(type)) return true;
        const save = 'Save';
        const answer = await vscode.window.showWarningMessage(
            `Saving converts the model into .${type}: ${name} is regenerated from the model.`,
            { modal: true, detail: FORMAT_LOSSES[type] ?? '' },
            save,
        );
        if (answer !== save) return false;
        this._confirmed.add(type);
        return true;
    }

    readDirectory() {
        throw vscode.FileSystemError.NoPermissions('Converted models have no folders');
    }

    createDirectory() {
        throw vscode.FileSystemError.NoPermissions('Converted models have no folders');
    }

    delete() {
        throw vscode.FileSystemError.NoPermissions('Delete the model file instead');
    }

    rename() {
        throw vscode.FileSystemError.NoPermissions('Rename the model file instead');
    }

    // --- Entries ----------------------------------------------------------------------------------

    /**
     * The converted document, converted on first use.
     * @param {vscode.Uri} uri converted document
     * @param {{ panel?: vscode.WebviewPanel, content?: Uint8Array }} [options]
     * @returns {Promise<ConvertedEntry>}
     */
    _entry(uri, options = {}) {
        const key = uri.toString();
        const entry = this._entries.get(key);
        if (entry) return Promise.resolve(entry);
        if (!this._loading.has(key)) {
            const loading = this._create(uri, options).finally(() => this._loading.delete(key));
            this._loading.set(key, loading);
        }
        return this._loading.get(key);
    }

    /**
     * @param {vscode.Uri} uri
     * @param {{ panel?: vscode.WebviewPanel, content?: Uint8Array }} options
     * @returns {Promise<ConvertedEntry>}
     */
    async _create(uri, { panel, content }) {
        const original = ConvertedModels.toOriginalUri(uri);
        if (!original) throw vscode.FileSystemError.FileNotFound(uri);
        let bytes = content;
        try {
            bytes ??= await vscode.workspace.fs.readFile(original);
        } catch {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
        const converted = await this._convert(original, bytes, panel);
        const now = Date.now();
        /** @type {ConvertedEntry} */
        const entry = {
            original,
            type: ConvertedModels._type(original),
            data: converted.data,
            source: converted.source,
            ctime: now,
            mtime: now,
            written: null,
            watcher: this._watch(uri, original),
        };
        this._entries.set(uri.toString(), entry);
        return entry;
    }

    /**
     * @param {vscode.Uri} original
     * @param {Uint8Array} bytes content of the model file
     * @param {vscode.WebviewPanel} [panel]
     * @returns {Promise<{ data: Uint8Array, source: import('../editor/ModelSerializer').SourceInfo }>}
     */
    async _convert(original, bytes, panel) {
        const name = original.path.split('/').pop();
        const work = async (target) => {
            const reply = await this._tasks.run(target, 'convertModel', {
                data: toArrayBuffer(bytes),
                fileName: name,
                producer: { name: 'Babylon Editor', version: this._version, exporter_version: this._version, file: name },
            });
            if (reply.error) throw new Error(`${name} could not be converted: ${reply.error}`);
            const data = toBytes(reply.data);
            if (data.byteLength > MAX_TEXT_LENGTH) {
                throw new Error(`${name} is too large to edit as text (${Math.round(data.byteLength / 1048576)} MB as .babylon)`);
            }
            return { data, source: reply.source };
        };
        return panel ? work(panel) : this._tasks.withHelper(original, `Converting ${name}`, work);
    }

    /**
     * Converts the model again when its file is changed by something else than a save of the
     * document; VS Code then reloads the document (or reports the conflict when it has unsaved edits).
     * @param {vscode.Uri} uri converted document
     * @param {vscode.Uri} original
     * @returns {vscode.Disposable}
     */
    _watch(uri, original) {
        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(vscode.Uri.joinPath(original, '..'), original.path.split('/').pop()),
        );
        const changed = async () => {
            const entry = this._entries.get(uri.toString());
            if (!entry) return;
            let bytes;
            try {
                bytes = await vscode.workspace.fs.readFile(original);
            } catch {
                return;
            }
            if (isSameContent(bytes, entry.written)) return;
            try {
                const converted = await this._convert(original, bytes, this._panelOf(uri));
                Object.assign(entry, { data: converted.data, source: converted.source, mtime: Date.now(), written: null });
                this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Changed, uri }]);
            } catch (error) {
                vscode.window.showWarningMessage(String(error?.message || error));
            }
        };
        return vscode.Disposable.from(watcher, watcher.onDidChange(changed), watcher.onDidCreate(changed));
    }
}
