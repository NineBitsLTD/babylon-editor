import * as vscode from 'vscode';

/** What "Add" creates in each section (ModelEdits in the webview creates these types). */
const ADD_TYPES = {
    Nodes: ['Empty node', 'Box', 'Sphere', 'Plane'],
    Materials: ['Standard material', 'PBR material'],
    Textures: ['Image'],
    Skeletons: ['Skeleton'],
    Animations: ['Clip'],
    Cameras: ['ArcRotate camera', 'Universal camera'],
    Lights: ['Point light', 'Directional light', 'Spot light', 'Hemispheric light'],
};

/** @typedef {import('../editor/ModelTreeBridge').ModelTreeNode} ModelTreeNode */

const REQUEST_TIMEOUT = 10000;
/** A click within this time after the selection changed is the click that selected the item. */
const SELECT_CLICK_WINDOW = 500;

/**
 * Explorer view with the model tree of the active Babylon editor. The tree data lives in the
 * editor webview (ModelTreeBridge); children are requested lazily over postMessage, and
 * selecting an item asks the webview to open it in the inspector.
 *
 * @implements {vscode.TreeDataProvider<ModelTreeNode>}
 */
export class ModelTreeProvider {

    static viewId = 'babylon-editor.modelTree';
    static contextKey = 'babylonEditor.active';
    static clickCommand = 'babylon-editor.tree.click';
    static addCommand = 'babylon-editor.tree.add';
    static renameCommand = 'babylon-editor.tree.rename';
    static deleteCommand = 'babylon-editor.tree.delete';
    /** Scheme of the tree item uris that carry the change decorations. */
    static decorationScheme = 'babylon-tree';

    constructor() {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        /** @type {vscode.WebviewPanel | null} */
        this._panel = null;
        /** @type {Map<number, (items: ModelTreeNode[]) => void>} */
        this._pending = new Map();
        this._nextRequestId = 0;
        /** @type {((uri: vscode.Uri, source: import('../editor/ModelTreeBridge').TreeItemSource) => Promise<'modified' | 'added' | null>) | null} */
        this._stateResolver = null;
        /** @type {WeakMap<vscode.WebviewPanel, vscode.Uri>} file of each tracked panel */
        this._uris = new WeakMap();
        /** @type {Map<string, ModelTreeNode>} nodes received so far, by id (for getParent) */
        this._nodes = new Map();
        /** @type {Map<number, (message: { result?: any, error?: string }) => void>} pending tree commands */
        this._commands = new Map();
        /** @type {vscode.Uri | undefined} file of the panel the tree shows */
        this._documentUri = undefined;
        /** Item shown in the inspector (null: the file view) */
        this._shownId = null;
        this._shownAt = 0;
    }

    /**
     * Creates the Explorer view and binds its selection to the active editor.
     * @returns {vscode.Disposable}
     */
    register() {
        const treeView = vscode.window.createTreeView(ModelTreeProvider.viewId, {
            treeDataProvider: this,
            showCollapseAll: true,
        });
        this._treeView = treeView;
        // Keyboard navigation changes the selection; clicks run the item command (also on the
        // selected item, which the selection event does not report)
        const selection = treeView.onDidChangeSelection(({ selection: [node] }) => {
            if (node && !node.contextValue?.startsWith('section:') && node.id !== this._shownId) this._show(node.id);
        });
        const click = vscode.commands.registerCommand(ModelTreeProvider.clickCommand, async (id) => {
            if (id === this._shownId && Date.now() - this._shownAt < SELECT_CLICK_WINDOW) return;
            if (id !== this._shownId) {
                this._show(id);
                return;
            }
            // A click on the shown item deselects it: the inspector shows the file
            this._show(null);
            await this._clearSelection(false);
        });
        return vscode.Disposable.from(
            treeView, selection, click, this._onDidChangeTreeData,
            vscode.window.registerFileDecorationProvider({ provideFileDecoration: uri => ModelTreeProvider._decoration(uri) }),
            vscode.commands.registerCommand(ModelTreeProvider.addCommand, node => this._run(() => this._add(node))),
            vscode.commands.registerCommand(ModelTreeProvider.renameCommand, node => this._run(() => this._rename(node))),
            vscode.commands.registerCommand(ModelTreeProvider.deleteCommand, node => this._run(() => this._delete(node))),
        );
    }

    /**
     * Changed items look like changed files in the Explorer (the state is in the uri query).
     * @param {vscode.Uri} uri
     * @returns {vscode.FileDecoration | undefined}
     */
    static _decoration(uri) {
        if (uri.scheme !== ModelTreeProvider.decorationScheme) return undefined;
        if (uri.query === 'modified') return new vscode.FileDecoration('M', 'Changed since the file was saved', new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'));
        if (uri.query === 'added') return new vscode.FileDecoration('A', 'Added since the file was saved', new vscode.ThemeColor('gitDecoration.addedResourceForeground'));
        return undefined;
    }

    /**
     * Tells which objects of a `.babylon` text changed since the save (provided by the text editor).
     * @param {(uri: vscode.Uri, source: import('../editor/ModelTreeBridge').TreeItemSource) => Promise<'modified' | 'added' | null>} resolver
     */
    setStateResolver(resolver) {
        this._stateResolver = resolver;
    }

    /** Re-reads the tree (e.g. after a save: the decorations change). */
    refresh() {
        this._onDidChangeTreeData.fire(undefined);
    }

    // --- Context menu commands (the webview does the edit, the host asks the user) -------------

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
     * @param {ModelTreeNode} node a section
     */
    async _add(node) {
        const section = node.contextValue.slice('section:'.length);
        const types = ADD_TYPES[section];
        if (!types) return;
        const kind = types.length > 1 ? await vscode.window.showQuickPick(types, { title: `Add to ${section}` }) : types[0];
        if (!kind) return;
        const extra = {};
        if (section === 'Textures') {
            if (!(await this._chooseTexture(extra))) return;
        }
        const name = await vscode.window.showInputBox({ title: `New ${kind.toLowerCase()}`, prompt: 'Name', value: section === 'Textures' ? extra.image : `New ${kind}`, validateInput: value => (value.trim() ? null : 'Enter a name') });
        if (!name) return;
        if (section === 'Animations') {
            const range = await vscode.window.showInputBox({ title: `Frames of ${name}`, prompt: 'First and last frame, e.g. 0-60', value: '0-60', validateInput: value => (/^\s*\d+\s*-\s*\d+\s*$/.test(value) ? null : 'Enter two frames: from-to') });
            if (!range) return;
            [extra.from, extra.to] = range.split('-').map(Number);
        }
        await this._command({ op: 'add', section, kind, name: name.trim(), extra });
    }

    /**
     * Asks for an image (inside the model folder, so its name is a path relative to the file) and
     * the material slot it goes into.
     * @param {object} extra receives image, materialId and slot
     * @returns {Promise<boolean>}
     */
    async _chooseTexture(extra) {
        const targets = await this._command({ op: 'textureTargets' });
        if (!targets.length) throw new Error('Add a material first: a texture belongs to a material');
        const target = targets.length > 1
            ? await vscode.window.showQuickPick(targets.map(item => ({ label: item.label, target: item })), { title: 'Material of the texture' })
            : { target: targets[0] };
        if (!target) return false;
        const slot = await vscode.window.showQuickPick(target.target.slots, { title: 'Texture slot' });
        if (!slot) return false;
        const folder = this._modelFolder();
        const [image] = await vscode.window.showOpenDialog({ defaultUri: folder, canSelectMany: false, filters: { Images: ['png', 'jpg', 'jpeg', 'bmp', 'tga', 'dds', 'ktx', 'ktx2', 'env', 'basis', 'webp'] } }) ?? [];
        if (!image) return false;
        const relative = folder && image.path.startsWith(folder.path + '/') ? image.path.slice(folder.path.length + 1) : null;
        if (!relative) throw new Error('Choose an image inside the folder of the model (texture names are relative to the file)');
        Object.assign(extra, { image: relative, materialId: target.target.id, slot });
        return true;
    }

    /**
     * @param {ModelTreeNode} node a model object
     */
    async _rename(node) {
        const info = await this._command({ op: 'info', id: node.id });
        if (!info.canRename) throw new Error('This item has no name of its own');
        const name = await vscode.window.showInputBox({ title: 'Rename', value: info.label, validateInput: value => (value.trim() ? null : 'Enter a name') });
        if (!name || name.trim() === info.label) return;
        await this._command({ op: 'rename', id: node.id, name: name.trim() });
    }

    /**
     * @param {ModelTreeNode} node a model object
     */
    async _delete(node) {
        const info = await this._command({ op: 'info', id: node.id });
        const answer = await vscode.window.showWarningMessage(
            `Delete ${info.label || node.label}?`,
            { modal: true, detail: info.dependents.length ? `Also: ${info.dependents.join('; ')}.` : 'Undo restores it.' },
            'Delete',
        );
        if (answer !== 'Delete') return;
        await this._command({ op: 'delete', id: node.id });
    }

    /**
     * @returns {vscode.Uri | undefined} folder of the file of the active editor
     */
    _modelFolder() {
        const uri = this._documentUri;
        return uri ? vscode.Uri.joinPath(uri, '..') : undefined;
    }

    /**
     * Sends a tree command to the active editor webview and waits for its result.
     * @param {object} command
     * @returns {Promise<any>}
     */
    _command(command) {
        const panel = this._panel;
        if (!panel) return Promise.reject(new Error('Open a model in the Babylon editor first'));
        const requestId = ++this._nextRequestId;
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this._commands.delete(requestId);
                reject(new Error('The editor did not answer'));
            }, REQUEST_TIMEOUT);
            this._commands.set(requestId, (message) => {
                clearTimeout(timeout);
                if (message.error) reject(new Error(message.error));
                else resolve(message.result);
            });
            panel.webview.postMessage({ type: 'treeCommand', requestId, ...command });
        });
    }

    /**
     * Clears the selection of the tree (the API has no deselect: `list.clear` clears the focused list).
     * @param {boolean} focusTree the tree has no focus (e.g. the back button of the inspector was used)
     */
    async _clearSelection(focusTree) {
        if (!this._treeView?.selection.length) return;
        try {
            if (focusTree) await vscode.commands.executeCommand(`${ModelTreeProvider.viewId}.focus`);
            await vscode.commands.executeCommand('list.clear');
        } finally {
            if (focusTree) await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
        }
    }

    /**
     * @param {string | null} id item to show in the inspector, null for the file view
     */
    _show(id) {
        this._shownId = id;
        this._shownAt = Date.now();
        this._panel?.webview.postMessage({ type: 'treeSelect', id });
    }

    /**
     * Tracks a Babylon editor panel: it becomes the tree source while it is the active editor.
     * @param {vscode.WebviewPanel} panel
     * @param {vscode.Uri} uri the file the panel edits
     * @returns {vscode.Disposable}
     */
    trackPanel(panel, uri) {
        this._uris.set(panel, uri);
        if (panel.active) this._setPanel(panel);
        const viewState = panel.onDidChangeViewState(() => {
            if (panel.active) {
                this._setPanel(panel);
            } else if (this._panel === panel && !panel.visible) {
                this._setPanel(null);
            }
        });
        const disposed = panel.onDidDispose(() => {
            if (this._panel === panel) this._setPanel(null);
        });
        return vscode.Disposable.from(viewState, disposed);
    }

    /**
     * Handles tree-related messages of an editor webview.
     * @param {vscode.WebviewPanel} panel
     * @param {{ type: string, requestId?: number, items?: ModelTreeNode[], op?: string, id?: string }} message
     * @returns {boolean} whether the message was a tree message
     */
    handleMessage(panel, message) {
        switch (message.type) {
            case 'treeItems':
                this._pending.get(message.requestId)?.(message.items ?? []);
                this._pending.delete(message.requestId);
                return true;
            case 'treeReset':
            case 'treeChanged':
                if (message.type === 'treeReset') {
                    this._shownId = null;
                    this._nodes.clear();
                }
                if (panel === this._panel) this._onDidChangeTreeData.fire(undefined);
                return true;
            case 'treeCommandResult':
                this._commands.get(message.requestId)?.(message);
                this._commands.delete(message.requestId);
                return true;
            case 'objectCommand':
                // Rename… / Delete of an object listed in the inspector (it has no tree item)
                if (panel !== this._panel) return true;
                if (message.op === 'rename') this._run(() => this._rename({ id: message.id }));
                else if (message.op === 'delete') this._run(() => this._delete({ id: message.id, label: '' }));
                return true;
            case 'treeDeselected':
                // The inspector went back to the file view (its back button)
                this._shownId = null;
                if (panel === this._panel) this._clearSelection(true);
                return true;
            default:
                return false;
        }
    }

    /**
     * @param {ModelTreeNode} node
     * @returns {Promise<vscode.TreeItem>}
     */
    async getTreeItem(node) {
        const item = new vscode.TreeItem(
            node.label,
            node.hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
        );
        item.id = node.id;
        item.contextValue = node.contextValue;
        // Sections only expand; model objects open in the inspector (a click on the shown one closes it)
        if (!node.contextValue?.startsWith('section:')) {
            item.command = { command: ModelTreeProvider.clickCommand, title: 'Show in the inspector', arguments: [node.id] };
        }
        item.description = node.description;
        const state = node.source && this._stateResolver && this._documentUri
            ? await this._stateResolver(this._documentUri, node.source)
            : node.state ?? null;
        if (node.uriPath) item.resourceUri = vscode.Uri.from({ scheme: ModelTreeProvider.decorationScheme, path: node.uriPath, query: state ?? '' });
        item.iconPath = new vscode.ThemeIcon(node.icon);
        item.tooltip = node.description ? `${node.label} (${node.description})` : node.label;
        return item;
    }

    /**
     * Parent of a node (needed by TreeView.reveal): the item before it in its tree path.
     * @param {ModelTreeNode} node
     * @returns {ModelTreeNode | undefined}
     */
    getParent(node) {
        const segments = node.uriPath?.split('/').filter(Boolean) ?? [];
        if (segments.length < 2) return undefined;
        // Node ids are "<generation>/<item id>"; the path holds the item ids
        const generation = node.id.slice(0, node.id.indexOf('/'));
        return this._nodes.get(`${generation}/${decodeURIComponent(segments[segments.length - 2])}`);
    }

    /**
     * @param {ModelTreeNode} [node]
     * @returns {Promise<ModelTreeNode[]>}
     */
    getChildren(node) {
        const panel = this._panel;
        if (!panel) return Promise.resolve([]);
        const requestId = ++this._nextRequestId;
        return new Promise((resolve) => {
            // A webview that is reloading or closing may never answer
            const timeout = setTimeout(() => {
                this._pending.delete(requestId);
                resolve([]);
            }, REQUEST_TIMEOUT);
            this._pending.set(requestId, (items) => {
                clearTimeout(timeout);
                items.forEach(item => this._nodes.set(item.id, item));
                resolve(items);
            });
            panel.webview.postMessage({ type: 'treeRequest', requestId, parentId: node?.id ?? null });
        });
    }

    /**
     * @param {vscode.WebviewPanel | null} panel
     */
    _setPanel(panel) {
        if (this._panel === panel) return;
        this._panel = panel;
        this._documentUri = panel ? this._uris.get(panel) : undefined;
        this._shownId = null;
        vscode.commands.executeCommand('setContext', ModelTreeProvider.contextKey, !!panel);
        this._onDidChangeTreeData.fire(undefined);
    }
}
