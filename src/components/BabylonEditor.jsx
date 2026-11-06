import * as vscode from 'vscode';
import { BabylonDocument } from './BabylonDocument';
import { BabylonTextProvider } from './BabylonTextProvider';
import { ConvertedModels } from './ConvertedModels';
import { WebviewFiles } from './WebviewFiles';

export const BabylonEditorID = 'babylon-editor.editor';

/** Key of the view settings shared by the editors (`globalState`). */
const VIEW_SETTINGS_KEY = 'babylonEditor.viewSettings';

/**
 * Where Babylon loads its decoders from (Draco, meshopt, KTX2 / Basis: scripts and WebAssembly run
 * in blob workers) when a model needs them.
 */
const BABYLON_CDN = 'https://cdn.babylonjs.com';

/**
 * Content Security Policy of an editor webview: scripts only with the nonce of the page (and the
 * decoders of Babylon's CDN), resources only from the extension and the model folder (the webview
 * resource origin) or created by the page (data / blob urls of textures and workers).
 * @param {vscode.Webview} webview
 * @param {string} nonce
 * @returns {string}
 */
function contentSecurityPolicy(webview, nonce) {
    const source = webview.cspSource;
    return [
        "default-src 'none'",
        `script-src 'nonce-${nonce}' 'wasm-unsafe-eval' ${BABYLON_CDN}`,
        // Babylon adds style elements (loading screen); widgets set inline styles
        `style-src ${source} 'unsafe-inline'`,
        `font-src ${source}`,
        // Babylon's loading screen shows images of its CDN
        `img-src ${source} data: blob: ${BABYLON_CDN}`,
        `media-src ${source} data: blob:`,
        `connect-src ${source} data: blob: ${BABYLON_CDN}`,
        `worker-src blob: ${BABYLON_CDN}`,
    ].join('; ');
}

/**
 * @returns {string} a random value for the `nonce` of the scripts of a webview page
 */
function createNonce() {
    return globalThis.crypto.randomUUID().replace(/-/g, '');
}

/**
 * @implements {vscode.CustomEditorProvider<BabylonDocument>}
 */
/**
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {boolean}
 */
function isSameContent(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let index = 0; index < a.length; index++) {
        if (a[index] !== b[index]) return false;
    }
    return true;
}

export class BabylonEditor {

    /**
     * @param {vscode.Uri} extensionUri
     * @param {vscode.ExtensionContext} context
     * @param {import('./ModelTreeProvider').ModelTreeProvider} modelTree Explorer view fed by the active editor
     */
    constructor(extensionUri, context, modelTree) {
        this._extensionUri = extensionUri;
        this._context = context;
        this._modelTree = modelTree;
        
        // Событие, которое вы будете использовать для оповещения VS Code об изменениях
        this._onDidChangeCustomDocument = new vscode.EventEmitter();
        this.onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;
        
        // Карта для хранения открытых панелей и документов
        this._openDocuments = new Map();
        
        /** @type {Map<string, vscode.WebviewPanel[]>} the open panels of a document, the one edited last at the end */
        this._webviewPanels = new Map();

        // Pending 'getFileData' requests to webviews: requestId -> { resolve, reject }
        this._pendingRequests = new Map();
        this._nextRequestId = 0;

        // Saving regenerates the whole file, the user confirms it once per session
        this._overwriteConfirmed = false;
        /** @type {ConvertedModels | null} */
        this._converted = null;
        /** @type {import('./WebviewTasks').WebviewTasks | null} */
        this._tasks = null;
        this._modelEditorId = '';
    }

    /**
     * Glb, glTF, OBJ and STL files are converted to `.babylon` documents and edited in the
     * `.babylon` editor; this editor converts them on open (in its webview) and hands them over.
     * @param {ConvertedModels} converted
     * @param {import('./WebviewTasks').WebviewTasks} tasks
     * @param {string} modelEditorId view type of the `.babylon` editor
     */
    useConversions(converted, tasks, modelEditorId) {
        this._converted = converted;
        this._tasks = tasks;
        this._modelEditorId = modelEditorId;
    }

    /** View type of this editor (its tabs are `TabInputCustom`s with it). */
    get viewType() {
        return BabylonEditorID;
    }

    /**
     * Save Model As… for a model shown by this editor: writes it, as edited, in the chosen format.
     * @param {vscode.Uri} uri the model file
     */
    async saveModelAs(uri) {
        const document = this._openDocuments.get(uri.toString());
        if (!document) throw new Error('The editor of this model is closed');
        await this._converted.saveModelAs(uri, type => this._requestFileData(document, type));
    }
    
    /**
     * Обязательный метод: Открытие документа.
     * Здесь мы читаем бинарные данные.
     * @param {vscode.Uri} uri
     * @param {vscode.CustomDocumentOpenContext} openContext
     * @returns {Promise<BabylonDocument>}
     */
    async openCustomDocument(uri, openContext) {
        // The compact text view (`babylon-text:`) also matches *.babylon; it has placeholders instead
        // of the model data, so resolveCustomEditor opens the real file instead
        if (uri.scheme === BabylonTextProvider.scheme) {
            return new BabylonDocument(uri, new Uint8Array());
        }
        // A backup (unsaved edits from a previous session) takes precedence over the file on disk
        const dataUri = openContext?.backupId ? vscode.Uri.parse(openContext.backupId) : uri;
        const content = await vscode.workspace.fs.readFile(dataUri);
        const document = new BabylonDocument(uri, content);
        this._openDocuments.set(uri.toString(), document);
        
 
        // Отслеживание закрытия документа
        document._disposables.push(new vscode.Disposable(() => {
            this._openDocuments.delete(uri.toString());
            this._webviewPanels.delete(uri.toString()); // Удаляем панель при закрытии
        }));
        document._disposables.push(this._watchFile(document));
        
        return document;
    }

    /**
     * Обязательный метод: Привязка документа к Webview.
     * @param {BabylonDocument} document 
     * @param {vscode.WebviewPanel} webviewPanel
     * @param {vscode.CancellationToken} token
     */
    async resolveCustomEditor(document, webviewPanel, token) {
        if (document.uri.scheme === BabylonTextProvider.scheme) {
            const { viewColumn } = webviewPanel;
            webviewPanel.dispose();
            await vscode.commands.executeCommand('vscode.openWith', BabylonTextProvider.toRealUri(document.uri), BabylonEditorID, viewColumn);
            return;
        }
        this.setupWebview(webviewPanel, document);
        const ready = new Promise((resolve) => {
            const listener = webviewPanel.webview.onDidReceiveMessage((message) => {
                if (message.type !== 'ready') return;
                listener.dispose();
                resolve(undefined);
            });
        });
        // Сохраняем панель для отправки сообщений (например, для reloadScene)
        const key = document.uri.toString();
        this._webviewPanels.set(key, [...(this._webviewPanels.get(key) ?? []), webviewPanel]);

        const treeTracking = this._modelTree.trackPanel(webviewPanel, document.uri);
        webviewPanel.onDidDispose(() => {
            treeTracking.dispose();
            // The document may outlive the panel (a converted model closes its binary editor), and a
            // disposed webview throws on postMessage
            const others = (this._webviewPanels.get(key) ?? []).filter(panel => panel !== webviewPanel);
            if (others.length) this._webviewPanels.set(key, others);
            else this._webviewPanels.delete(key);
        });

        // Добавляем обработчик сообщений из Webview
        webviewPanel.webview.onDidReceiveMessage(e => {
            if (this._modelTree.handleMessage(webviewPanel, e) || this._tasks?.handleMessage(e)) return;
            switch (e.type) {
                case 'edit':
                    this._onWebviewEdit(document, webviewPanel, e.label);
                    break;
                case 'fileData':
                    this._resolveFileData(e);
                    break;
            }
        });
        // The webview script is initialized and listens for the model. Not awaited: VS Code shows
        // the webview only after this method returns
        ready.then(async () => {
            if (this._converted && ConvertedModels.isConvertible(document.uri) && await this._openConverted(document, webviewPanel)) return;
            webviewPanel.webview.postMessage({ type: 'loadModel', data: document.getArrayBuffer() });
        });
    }

    /**
     * Converts the model to a `.babylon` document in the webview of this editor and replaces the
     * editor with the `.babylon` editor of the document.
     * @param {BabylonDocument} document
     * @param {vscode.WebviewPanel} webviewPanel
     * @returns {Promise<boolean>} false when the model could not be converted (it is shown here then)
     */
    async _openConverted(document, webviewPanel) {
        try {
            const uri = await this._converted.open(document.uri, { panel: webviewPanel, content: document.content });
            const { viewColumn } = webviewPanel;
            // The document keeps the preview state of the model file's tab (a preview tab is replaced
            // by the next opened file)
            const preview = this._tabOf(document.uri)?.isPreview ?? false;
            await vscode.commands.executeCommand('vscode.openWith', uri, this._modelEditorId, { viewColumn, preview });
            webviewPanel.dispose();
            return true;
        } catch (error) {
            vscode.window.showWarningMessage(`${error?.message || error}. The model is opened without conversion.`);
            return false;
        }
    }

    /**
     * @param {vscode.Uri} uri
     * @returns {vscode.Tab | undefined} the tab of this editor showing the file
     */
    _tabOf(uri) {
        return vscode.window.tabGroups.all.flatMap(group => group.tabs).find(tab => tab.input instanceof vscode.TabInputCustom
            && tab.input.viewType === BabylonEditorID && tab.input.uri.toString() === uri.toString());
    }

    /**
     * Registers an edit made in the webview: marks the document dirty and routes VS Code
     * undo/redo back to the webview history.
     * @param {BabylonDocument} document
     * @param {vscode.WebviewPanel} webviewPanel
     * @param {string} label
     */
    _onWebviewEdit(document, webviewPanel, label) {
        document.hasUnsavedEdits = true;
        // Each panel has its own scene: the edited one is what a save writes
        const key = document.uri.toString();
        this._webviewPanels.set(key, [...(this._webviewPanels.get(key) ?? []).filter(panel => panel !== webviewPanel), webviewPanel]);
        this._onDidChangeCustomDocument.fire({
            document,
            label,
            undo: () => webviewPanel.webview.postMessage({ type: 'undo' }),
            redo: () => webviewPanel.webview.postMessage({ type: 'redo' }),
        });
    }

    /**
     * Asks the webview to serialize the edited model, in the document format or another one.
     * @param {BabylonDocument} document
     * @param {string} [format] extension of the format to write (the webview writes the document's by default)
     * @returns {Promise<Uint8Array>}
     */
    _requestFileData(document, format = undefined) {
        const webviewPanel = this._webviewPanels.get(document.uri.toString())?.at(-1);
        if (!webviewPanel) {
            return Promise.reject(new Error('The editor of this document is closed'));
        }
        const requestId = ++this._nextRequestId;
        return new Promise((resolve, reject) => {
            this._pendingRequests.set(requestId, { resolve, reject });
            // A written .babylon document names the model file it was made from, like a conversion
            const version = this._context.extension.packageJSON.version ?? '';
            const producer = { name: 'Babylon Editor', version, exporter_version: version, file: document.uri.path.split('/').pop() };
            webviewPanel.webview.postMessage({ type: 'getFileData', requestId, format, producer });
        });
    }

    /**
     * @param {{ requestId: number, data?: ArrayBuffer | ArrayBufferView, error?: string }} message
     */
    _resolveFileData({ requestId, data, error }) {
        const request = this._pendingRequests.get(requestId);
        if (!request) return;
        this._pendingRequests.delete(requestId);
        if (error) return request.reject(new Error(error));
        if (data instanceof ArrayBuffer) return request.resolve(new Uint8Array(data));
        if (ArrayBuffer.isView(data)) return request.resolve(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
        request.reject(new Error('The editor returned no file data'));
    }

    /**
     * Saving rebuilds the file from the scene; confirm that once per session.
     * @returns {Promise<void>}
     */
    async _confirmOverwrite() {
        if (this._overwriteConfirmed) return;
        const save = 'Save';
        const answer = await vscode.window.showWarningMessage(
            'Babylon Editor regenerates the whole file from the scene when saving. Formatting, numeric precision and data that Babylon.js does not load (for example exporter metadata) may change.',
            { modal: true },
            save,
        );
        if (answer !== save) {
            throw new Error('Saving was cancelled');
        }
        this._overwriteConfirmed = true;
    }

    /**
     * Обязательный метод: Сохранение документа.
     * @param {BabylonDocument} document
     * @param {vscode.CancellationToken} token
     * @returns {Promise<void>}
     */
    async saveCustomDocument(document, token) {
        await this._confirmOverwrite();
        const data = await this._requestFileData(document);
        // Set before writing, so the change event of the file watcher sees the own content
        document.content = data;
        await vscode.workspace.fs.writeFile(document.uri, data);
        document.hasUnsavedEdits = false;
        // The tree decorations of the changed objects start over
        this._webviewPanels.get(document.uri.toString())?.forEach(panel => panel.webview.postMessage({ type: 'documentSaved' }));
    }
    
    /**
     * @param {BabylonDocument} document
     * @param {vscode.Uri} destination
     * @param {vscode.CancellationToken} token
     * @returns {Promise<void>}
     */
    async saveCustomDocumentAs(document, destination, token) {
        // The format follows the extension of the chosen file (e.g. a .glb saved as .babylon)
        const type = ConvertedModels.saveAsType(destination);
        if (type !== document.type && this._converted && !(await this._converted.confirmFormat(type, destination.path.split('/').pop()))) {
            throw new Error('Saving was cancelled');
        }
        const data = await this._requestFileData(document, type);
        await vscode.workspace.fs.writeFile(destination, data);
    }
    
    /**
     * Обязательный метод: Отмена изменений.
     * @param {BabylonDocument} document
	 * @param {vscode.CancellationToken} token
     */
    async revertCustomDocument(document, token) {
 
        // Инициируем перезагрузку, чтобы получить исходное содержимое с диска
        await this._reloadScene(document.uri);
        document.hasUnsavedEdits = false;
    }
    
    /**
     * Writes the current (unsaved) model to the backup location provided by VS Code.
     * @param {BabylonDocument} document
	 * @param {vscode.CustomDocumentBackupContext} context
	 * @param {vscode.CancellationToken} token
     * @returns {Promise<vscode.CustomDocumentBackup>}
     */
    async backupCustomDocument(document, context, token) { 
        const data = await this._requestFileData(document);
        await vscode.workspace.fs.writeFile(context.destination, data);
        return { 
            id: context.destination.toString(), 
            delete: async () => {
                try {
                    await vscode.workspace.fs.delete(context.destination);
                } catch {
                    // The backup may already be removed
                }
            } 
        }; 
    }

    /**
     * Reloads the model when the file is changed by another editor (e.g. the collapsed text view).
     * Unsaved edits of the 3D editor are not discarded: the user is told to revert instead.
     * @param {BabylonDocument} document
     * @returns {vscode.Disposable}
     */
    _watchFile(document) {
        const { uri } = document;
        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(vscode.Uri.joinPath(uri, '..'), uri.path.split('/').pop()),
        );
        const changed = async () => {
            let content;
            try {
                content = await vscode.workspace.fs.readFile(uri);
            } catch {
                return;
            }
            // Our own save writes the same bytes
            if (isSameContent(content, document.content)) return;
            if (document.hasUnsavedEdits) {
                vscode.window.showWarningMessage(
                    `${uri.path.split('/').pop()} was changed on disk. Revert the file (File: Revert File) to load it; saving overwrites the change.`,
                );
                return;
            }
            await this._reloadScene(uri);
        };
        return vscode.Disposable.from(watcher, watcher.onDidChange(changed), watcher.onDidCreate(changed));
    }

    /**
     * Проверяет, открыт ли документ нашим редактором.
     * @param {vscode.Uri} uri
     * @returns {boolean}
     */
    documentIsRelevant(uri) {
        return this._openDocuments.has(uri.toString());
    }
    
    /**
     * Перезагружает сцену в соответствующем WebviewPanel.
     * @param {vscode.Uri} uri
     */
    async _reloadScene(uri) {
        const document = this._openDocuments.get(uri.toString());
        const panels = this._webviewPanels.get(uri.toString()) ?? [];

        if (document && panels.length) {
            try {
                document.content = await vscode.workspace.fs.readFile(uri);
                panels.forEach(panel => panel.webview.postMessage({ type: 'reloadModel', data: document.getArrayBuffer() }));
            } catch (error) {
                console.error(`Error reloading scene for ${uri.fsPath}:`, error);
                vscode.window.showErrorMessage(`Failed to reload content: ${error.message}`);
            }
        }
    }

    /**
     * Sets the options and the HTML of an editor webview (also used by BabylonTextEditor).
     * @param {vscode.WebviewPanel} webviewPanel
     * @param {{ uri: vscode.Uri, type?: string, mimeType?: string }} document
     * @param {object} [payload] extra fields of `window.payload`
     */
    setupWebview(webviewPanel, document, payload = {}) {
        // A converted document resolves its resources against the folder of the model file
        const location = ConvertedModels.toOriginalUri(document.uri) ?? document.uri;
        webviewPanel.webview.options = {
            enableScripts: true,
            // The workspace folder (or the model folder outside a workspace) is allowed so loaders can
            // resolve relative resources (textures, .bin, .mtl), including paths like '../textures/a.png'
            localResourceRoots: [
                vscode.Uri.joinPath(this._extensionUri, 'dist'),
                vscode.workspace.getWorkspaceFolder(location)?.uri ?? vscode.Uri.joinPath(location, '..'),
            ],
        };
        const converted = location !== document.uri ? { convertedFrom: location.path.split('/').pop() } : {};
        // The view chosen last in any editor (model, inspector or both; render mode) is where a newly
        // opened file starts
        const viewSettings = this._context.globalState.get(VIEW_SETTINGS_KEY);
        webviewPanel.webview.html = this._getHtmlForWebview(webviewPanel.webview, document, { ...converted, viewSettings, ...payload });
        WebviewFiles.listen(webviewPanel, location);
        webviewPanel.webview.onDidReceiveMessage((message) => {
            if (message?.type !== 'viewSettings') return;
            this._context.globalState.update(VIEW_SETTINGS_KEY, { ...this._context.globalState.get(VIEW_SETTINGS_KEY), ...message.settings });
        });
    }

    // --- Вспомогательные методы ---
    _getHtmlForWebview(webview, document, extraPayload = {}) {
		const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'css', 'editor.css'));
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'js', 'editor.js'));
        const codiconsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'codicons', 'codicon.css'));
        // Model bytes are delivered by the 'loadModel' message; the payload only carries metadata.
        // '<' is escaped so a file name cannot close the inline <script>.
        const payload = JSON.stringify({
            type: document?.type || '',
            mimeType: document?.mimeType || '',
            fileName: document.uri.path.split('/').pop(),
            rootUrl: webview.asWebviewUri(vscode.Uri.joinPath(ConvertedModels.toOriginalUri(document.uri) ?? document.uri, '..')).toString() + '/',
            ...extraPayload,
        }).replace(/</g, '\\u003c');
        const nonce = createNonce();

        return <html lang="en">
            <head>
                <meta charset="UTF-8"/>
                <meta http-equiv="Content-Security-Policy" content={contentSecurityPolicy(webview, nonce)}/>
                <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
                <title>Babylon Editor</title>
                <link href={codiconsUri.toString()} rel="stylesheet" />
                <link href={styleUri.toString()} rel="stylesheet" />
                <script nonce={nonce} src={scriptUri.toString()} />
                <script nonce={nonce}>{`window.payload = ${payload};`}</script>
            </head>
            <body>
                <div className="editor">
                    <div className="toolbar">
                        <div className="toolbar__group toolbar__views">
                            <button className="toolbar__view toolbar__view--menu" data-view="desktop" title="Show the model and the inspector, and choose a layout…">
                                <span className="toolbar__view-icon"></span>
                            </button>
                            <button className="toolbar__view" data-view="model" title="Show only the model">
                                <i className="codicon codicon-device-camera"></i>
                            </button>
                            <button className="toolbar__view" data-view="inspector" title="Show only the inspector">
                                <i className="codicon codicon-list-tree"></i>
                            </button>
                        </div>
                        <div className="toolbar__group toolbar__cursors">
                            <button className="toolbar__button toolbar__cursor" data-cursor="view" title="View (V): the left button turns the camera">
                                <i className="codicon codicon-eye"></i>
                            </button>
                            <button className="toolbar__button toolbar__cursor" data-cursor="edit" title="Edit: the left button selects vertices or bones, also in a rectangle (Shift adds, Option / Alt takes out), and the gizmo of the tool moves, turns or scales them; in every view; the middle button turns the camera">
                                <i className="codicon codicon-edit"></i>
                            </button>
                            <button className="toolbar__button toolbar__tool" data-tool="move" title="Move (W)">
                                <i className="codicon codicon-move"></i>
                            </button>
                            <button className="toolbar__button toolbar__tool" data-tool="rotate" title="Rotate (E)">
                                <i className="codicon codicon-refresh"></i>
                            </button>
                            <button className="toolbar__button toolbar__tool" data-tool="scale" title="Scale (R)">
                                <i className="codicon codicon-screen-full"></i>
                            </button>
                            <button className="toolbar__button toolbar__local" title="Local axes (X): the gizmo takes the axes of the first selected bone, or of the mesh, instead of the world axes">
                                <i className="codicon codicon-target"></i>
                            </button>
                        </div>
                    </div>
                    <div className="workspace">
                        <div className="viewport">
                            <canvas className="canvas"></canvas>
                            <div className="status status--hidden"></div>
                            <div className="player">
                                <div className="player__top">
                                    <div className="player__controls player__controls--view">
                                        <div className="player__group">
                                            <button className="player__button player__reset" title="Reset the view (camera back to the start position)">
                                                <i className="codicon codicon-home"></i>
                                            </button>
                                        </div>
                                        <div className="player__group">
                                            <button className="player__button player__mode" data-mode="textured" title="Show with textures">
                                                <i className="codicon codicon-file-media"></i>
                                            </button>
                                            <button className="player__button player__mode" data-mode="solid" title="Show without textures">
                                                <i className="codicon codicon-circle-large-filled"></i>
                                            </button>
                                            <button className="player__button player__mode" data-mode="wireframe" title="Show as lines (wireframe)">
                                                <i className="codicon codicon-globe"></i>
                                            </button>
                                            <button className="player__button player__overlay" data-overlay="vertices" title="Show the vertices (points over the model)">
                                                <i className="codicon codicon-circle-small-filled"></i>
                                            </button>
                                        </div>
                                        <div className="player__group player__group--skeleton player__group--hidden">
                                            <button className="player__button player__mesh" title="Hide mesh">
                                                <i className="codicon codicon-package"></i>
                                            </button>
                                            <button className="player__button player__bones" title="Hide bones">
                                                <i className="codicon codicon-person"></i>
                                            </button>
                                        </div>
                                        <div className="player__group">
                                            <button className="player__button player__overlay" data-overlay="normals" title="Show the normals of the vertices (lines along them)">
                                                <i className="codicon codicon-arrow-up"></i>
                                            </button>
                                            <button className="player__button player__overlay" data-overlay="boneAxes" title="Show the axes of the bones (X red, Y green, Z blue: how each bone is turned)">
                                                <i className="codicon codicon-compass"></i>
                                            </button>
                                            <button className="player__button player__overlay" data-overlay="ground" title="Show the ground: a grid at the lowest point of the selected object at rest (where feet should stand while it moves); in Edit a click on it lets the gizmo move it">
                                                <i className="codicon codicon-layers"></i>
                                            </button>
                                        </div>
                                    </div>
                                </div>
                                <div className="player__bottom">
                                    <div className="player__tags">
                                        <span className="player__tag player__mesh-name player__tag--hidden">
                                            <i className="codicon codicon-symbol-structure"></i>
                                            <span className="player__tag-name"></span>
                                        </span>
                                        <span className="player__tag player__skeleton player__tag--hidden">
                                            <i className="codicon codicon-person"></i>
                                            <span className="player__tag-name"></span>
                                        </span>
                                        <span className="player__tag player__clip player__tag--hidden">
                                            <i className="codicon codicon-play-circle"></i>
                                            <span className="player__tag-name"></span>
                                        </span>
                                    </div>
                                    <div className="player__controls player__controls--playback">
                                        <button className="player__button player__orbit" title="Start auto-orbit">
                                            <i className="codicon codicon-sync"></i>
                                        </button>
                                        <div className="player__animation player__animation--hidden">
                                            <button className="player__button player__play" title="Play animation">
                                                <i className="codicon codicon-play"></i>
                                            </button>
                                            <input className="player__slider" type="range" min="0" max="1000" value="0" title="Position"/>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                        <div className="splitter" title="Drag to resize, double-click to reset"></div>
                        <div className="inspector"></div>
                    </div>
                </div>
            </body>
            </html>;
    }
}