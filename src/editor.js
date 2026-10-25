import * as BABYLON from '@babylonjs/core';
import '@babylonjs/loaders';
import * as fflate from 'fflate';
import { AnimationController } from './editor/AnimationController';
import { BabylonJsonBinding } from './editor/BabylonJsonBinding';
import { CameraController } from './editor/CameraController';
import { CameraViews } from './editor/CameraViews';
import { ClipFrameEditor } from './editor/ClipFrameEditor';
import { DocumentEditHistory, EditHistory } from './editor/EditHistory';
import { FileInfo } from './editor/FileInfo';
import { HostRequests } from './editor/HostRequests';
import { ModelConverter } from './editor/ModelConverter';
import { ModelEdits, objectOf } from './editor/ModelEdits';
import { clipIcon, ModelOutline } from './editor/ModelOutline';
import { ModelTreeBridge } from './editor/ModelTreeBridge';
import { PanelResizer } from './editor/PanelResizer';
import { PopupMenu } from './editor/PopupMenu';
import { ModelProperties } from './editor/ModelProperties';
import { ModelSerializer } from './editor/ModelSerializer';
import { PropertyPanel } from './editor/PropertyPanel';
import { SelectionHighlighter } from './editor/SelectionHighlighter';
import { TextureImage } from './editor/TextureImage';
import { Toolbar } from './editor/Toolbar';

const vscode = acquireVsCodeApi();

// The splat loader unzips with fflate, loaded from unpkg.com unless it is there: the bundled copy
// keeps the webview off third-party scripts (its Content Security Policy does not allow them)
window.fflate = fflate;

/** Below this width (px) of the editor the model and the inspector are shown one at a time. */
const NARROW_WIDTH = 500;
/** Below this height of the editor the layouts with 3 and 4 camera views (rows of half the height) are not offered. */
const SHORT_HEIGHT = 400;

/**
 * View settings (view, singleView, renderMode, uvColor, showUv): this panel's own (restored with the panel),
 * else the last ones chosen in any editor (kept by the host, so a newly opened file starts with them).
 * @returns {{ view?: string, singleView?: string, renderMode?: string, uvColor?: string, showUv?: boolean }}
 */
function viewSettings() {
    const own = vscode.getState() ?? {};
    const shared = window.payload?.viewSettings ?? {};
    return {
        view: own.view ?? shared.view,
        singleView: own.singleView ?? shared.singleView,
        renderMode: own.renderMode ?? shared.renderMode,
        uvColor: own.uvColor ?? shared.uvColor,
        showUv: own.showUv ?? shared.showUv,
        layout: own.layout ?? shared.layout,
    };
}

/**
 * Keeps changed view settings in this panel's state and with the host for the next opened files.
 * @param {{ view?: string, singleView?: string, renderMode?: string, uvColor?: string, showUv?: boolean }} changes
 */
function saveViewSettings(changes) {
    vscode.setState({ ...vscode.getState(), ...changes });
    vscode.postMessage({ type: 'viewSettings', settings: changes });
}

/**
 * @param {BABYLON.AbstractMesh[]} meshes the meshes a skeleton deforms
 * @returns {{ node: BABYLON.Node, label: string } | null} the object of the mesh tag and its text:
 *   the mesh, the node of the parts of one mesh (glTF primitives), or the first mesh with the
 *   number of the others
 */
function meshTag(meshes) {
    if (!meshes.length) return null;
    const name = node => node.name || '(unnamed)';
    if (meshes.length === 1) return { node: meshes[0], label: name(meshes[0]) };
    const parent = meshes[0].parent;
    // A root parent (glTF __root__) groups the whole model, not one mesh
    if (parent?.parent && meshes.every(mesh => mesh.parent === parent)) return { node: parent, label: name(parent) };
    return { node: meshes[0], label: `${name(meshes[0])} +${meshes.length - 1}` };
}

/**
 * Shows a status line over the editor (loading progress, errors). An empty text hides it.
 * @param {string} text
 * @param {boolean} [isError]
 */
function setStatus(text, isError = false) {
    const status = document.querySelector('.status');
    if (!status) return;
    status.textContent = text;
    status.classList.toggle('status--hidden', !text);
    status.classList.toggle('status--error', isError);
}

/**
 * Creates the engine and an empty scene bound to the editor canvas.
 * @param {HTMLCanvasElement} canvas
 * @returns {BABYLON.Scene}
 */
function createScene(canvas) {
    const engine = new BABYLON.Engine(canvas, true);
    const scene = new BABYLON.Scene(engine);
    // The camera is created after the first model is loaded; rendering without it throws
    engine.runRenderLoop(() => scene.activeCamera && scene.render());
    // The canvas also changes size when the edit panels are shown or hidden
    new ResizeObserver(() => engine.resize()).observe(canvas);
    return scene;
}

/**
 * Wires the scene, the toolbar, the edit panels and the extension host messages together.
 */
class Editor {

    /**
     * @param {HTMLElement} root the `.editor` element
     */
    constructor(root) {
        this._root = root;
        this._type = window.payload?.type || '';
        // The model is a text document (.babylon): edits become patches of the text, VS Code keeps the undo stack
        this._textBacked = !!window.payload?.textBacked;
        this._canEdit = this._textBacked || ModelSerializer.canSave(this._type);
        /** @type {BabylonJsonBinding | null} */
        this._binding = null;
        /** @type {import('./editor/FileInfo').FileField[] | null} */
        this._fileFields = null;
        this._scene = createScene(/** @type {HTMLCanvasElement} */ (root.querySelector('.canvas')));
        this._camera = new CameraController(this._scene);
        this._animations = new AnimationController(this._scene);
        this._highlighter = new SelectionHighlighter(this._scene);
        const skeletonDisplay = vscode.getState()?.skeletonDisplay;
        if (skeletonDisplay) this._highlighter.setSkeletonDisplay(skeletonDisplay);
        /** @type {BABYLON.AssetContainer | null} */
        this._container = null;
        /** @type {import('./editor/ModelSerializer').SourceInfo | null} */
        this._source = null;
        /** @type {import('./editor/ModelOutline').TreeItem | null} */
        this._selection = null;
        /**
         * The inspectors opened before the shown one from an inspector (Open, a picked bone, …):
         * the back button returns to the last of them, then to the file view.
         * @type {import('./editor/ModelOutline').TreeItem[]}
         */
        this._backStack = [];

        this._history = this._textBacked
            ? new DocumentEditHistory({
                collect: () => this._binding?.collect() ?? [],
                onPatches: (label, patches) => vscode.postMessage({ type: 'patch', label, patches }),
                onChange: () => this._refresh(),
            })
            : new EditHistory({
                onExecute: (command) => vscode.postMessage({ type: 'edit', label: command.label }),
                onChange: () => this._refresh(),
            });
        // The model tree is rendered by VS Code in the Explorer; this bridge answers its requests
        this._tree = new ModelTreeBridge(item => this._annotateTreeItem(item));
        /** @type {Map<object, 'modified' | 'added'>} objects changed since the last save (formats other than .babylon) */
        this._changed = new Map();
        /** @type {Map<BABYLON.AbstractMesh, number>} meshes hidden in the 3D view only, with their layer mask */
        this._hiddenInView = new Map();
        /** @type {BABYLON.Skeleton | null} skeleton of the current clip (the player tags and toggles) */
        this._clipSkeleton = null;
        /** @type {BABYLON.Node | null} what the mesh tag of the player opens */
        this._clipMesh = null;
        /** @type {Map<string, import('./editor/ModelOutline').ModelItemData>} nodes listed in the inspector, by the id tree commands use */
        this._inspectorObjects = new Map();
        this._panel = new PropertyPanel(root.querySelector('.inspector'), {
            onCommit: (property, value) => this._commitProperty(property, value),
            onCellCommit: (column, row, oldValue, newValue) => this._commitCell(column, row, oldValue, newValue),
            onCurveCommit: (data, row, label, before, after) => this._commitCurve(data, row, label, before, after),
        });
        this._panel.setReadOnly(!this._canEdit);
        // The inspector width survives hiding the editor tab (webview state)
        this._resizer = new PanelResizer(root.querySelector('.splitter'), root.querySelector('.inspector'), {
            defaultWidth: 460,
            width: vscode.getState()?.inspectorWidth,
            onChange: (width) => {
                vscode.setState({ ...vscode.getState(), inspectorWidth: width });
                this._updateLayout();
            },
        });
        this._toolbar = this._createToolbar(root);
        /** @type {import('./editor/CameraViews').ViewLayout} the layout of the desktop view */
        this._layout = viewSettings().layout ?? { side: 'right', count: 1 };
        this._cameraMenu = new PopupMenu();
        // One to four views of the model, each with its camera (kept in the webview state)
        this._cameraViews = new CameraViews({
            scene: this._scene,
            viewport: root.querySelector('.viewport'),
            previews: () => this._camera.views,
            onTagClick: (index, tag) => this._showViewCameraMenu(index, tag),
            onChange: () => this._saveCameraViews(),
            state: vscode.getState()?.cameraViews,
        });
        // The model, the inspector or both (desktop), switched from the toolbar and kept in the
        // webview state; a narrow editor shows the last single view instead of both
        const { view = 'desktop', singleView = 'inspector' } = viewSettings();
        /** @type {import('./editor/Toolbar').EditorView} */
        this._view = view;
        /** @type {'model' | 'inspector'} */
        this._singleView = singleView;
        this._narrow = false;
        /** @type {import('./editor/Toolbar').EditorView | null} */
        this._shown = null;
        new ResizeObserver(() => this._updateLayout()).observe(root.querySelector('.workspace'));
        this._setRenderMode(viewSettings().renderMode ?? 'textured');
        this._edits = new ModelEdits({
            scene: this._scene,
            container: () => this._container,
            animations: this._animations,
            history: this._history,
            binding: () => this._binding,
            rootUrl: window.payload?.rootUrl ?? '',
            postOps: (label, ops) => vscode.postMessage({ type: 'documentOps', label, ops }),
            onStructureChange: () => this._rebuildModel(),
            markChanged: (object, state) => this._markChanged(object, state),
        });
        this._host = new HostRequests(message => vscode.postMessage(message));
        this._textureImage = new TextureImage({
            host: this._host,
            replace: (texture, dataUrl) => {
                if (this._canEdit) this._edits.replaceTextureImage(texture, dataUrl);
            },
            container: () => this._container,
            uvColor: viewSettings().uvColor,
            showUv: viewSettings().showUv,
            onShowUvChange: shown => saveViewSettings({ showUv: shown }),
            // The picker reports every step of a drag: the last color is kept
            onUvColorChange: (color) => {
                clearTimeout(this._uvColorTimer);
                this._uvColorTimer = setTimeout(() => saveViewSettings({ uvColor: color }), 300);
            },
        });
        this._listenBonePicks();
    }

    /**
     * Change information of a tree item for its decoration: where its object is in the `.babylon`
     * text (the host compares it with the saved file), or whether it was changed since the save.
     * @param {import('./editor/ModelOutline').TreeItem} item
     * @returns {{ source?: import('./editor/ModelTreeBridge').TreeItemSource, state?: 'modified' | 'added' }}
     */
    _annotateTreeItem(item) {
        const data = item.data;
        if (!data || data.kind === 'section') return {};
        const object = objectOf(data);
        if (!object) return {};
        if (!this._binding) return this._changed.has(object) ? { state: this._changed.get(object) } : {};
        const binding = this._binding;
        if (data.kind === 'clip') {
            const owner = this._container.skeletons.find(skeleton => skeleton.getAnimationRange(object.name));
            const path = owner && binding.pathOf(owner);
            return path ? { source: { array: [...path, 'ranges'], key: 'name', id: object.name } } : {};
        }
        if (data.kind === 'texture') {
            const path = binding.pathOf(object);
            const material = path && this._container.materials.find(candidate => binding.pathOf(candidate)?.[1] === path[1]);
            return material ? { source: { array: ['materials'], key: 'id', id: material.id, field: path[2] } } : {};
        }
        const path = binding.pathOf(object);
        if (!path) return {};
        if (data.kind === 'shadowGenerator') return { source: { array: path.slice(0, -1), key: 'lightId', id: object.getLight().id } };
        return { source: { array: path.slice(0, -1), key: 'id', id: object.id } };
    }

    /**
     * @param {object} object
     * @param {'modified' | 'added'} state
     */
    _markChanged(object, state) {
        if (this._binding || !object || this._changed.get(object) === 'added') return;
        this._changed.set(object, state);
    }

    /**
     * The frame the current clip stopped at (pause, seek) becomes the frame of the clip inspector.
     */
    _syncClipFrame() {
        const clip = this._animations.current;
        if (!clip) return;
        ClipFrameEditor.setShownFrame(clip, this._animations.currentFrame);
        // The pose follows the whole frame the inspector shows
        this._animations.showFrame(clip, ClipFrameEditor.shownFrame(clip));
        this._panel.refresh();
        this._panel.updateCurrentFrame();
    }

    /** Shows the chosen view; an editor too narrow for both shows the last single view. */
    _updateLayout() {
        const workspace = this._root.querySelector('.workspace');
        this._narrow = workspace.clientWidth < NARROW_WIDTH;
        // A model view too narrow for its player (next to the inspector) shows the model alone
        const splitter = /** @type {HTMLElement} */ (this._root.querySelector('.splitter'));
        this._splitterWidth = splitter.offsetWidth || this._splitterWidth || 0;
        const cramped = !this._narrow && workspace.clientWidth - this._resizer.width - this._splitterWidth < this._playerWidth();
        const shown = this._view !== 'desktop' ? this._view : this._narrow ? this._singleView : cramped ? 'model' : 'desktop';
        const inspector = /** @type {HTMLElement} */ (this._root.querySelector('.inspector'));
        // The inspector alone takes the whole width; its own width comes back with the desktop view
        if (shown !== this._shown) {
            this._shown = shown;
            if (shown === 'desktop') this._resizer.setWidth(this._resizer.width);
            else inspector.style.flexBasis = 'auto';
        }
        this._root.classList.toggle('editor--model', shown === 'model');
        this._root.classList.toggle('editor--inspector', shown === 'inspector');
        // The inspector on the chosen side; the desktop view shows the camera views of its layout
        const left = this._layout.side === 'left';
        this._root.querySelector('.workspace').classList.toggle('workspace--inspector-left', left);
        this._resizer.side = left ? 'left' : 'right';
        // A low editor shows a layout of 3 or 4 views with 2 (the chosen layout is kept)
        const maxCount = workspace.clientHeight < SHORT_HEIGHT ? 2 : 4;
        const layout = { ...this._layout, count: Math.min(this._layout.count, maxCount) };
        this._cameraViews?.setCount(shown === 'desktop' ? layout.count : 1);
        this._toolbar.setDesktopLayout(layout, maxCount);
        this._toolbar.setLayout(shown, this._narrow || cramped);
    }

    /**
     * @returns {number} the width the model view needs for its player bars in one line each (the
     *   controls at their smallest, the slider at its minimum): the wider of the view bar on top and
     *   the playback bar at the bottom; measured while the view is shown
     */
    _playerWidth() {
        const player = /** @type {HTMLElement} */ (this._root.querySelector('.player'));
        const bars = /** @type {HTMLElement[]} */ ([...this._root.querySelectorAll('.player__controls')]);
        if (bars[0]?.offsetParent) {
            const style = getComputedStyle(player);
            const widest = Math.max(...bars.map((bar) => {
                const { width } = bar.style;
                bar.style.width = 'min-content';
                const measured = bar.getBoundingClientRect().width;
                bar.style.width = width;
                return measured;
            }));
            this._minPlayerWidth = widest + parseFloat(style.left) + parseFloat(style.right);
        }
        return this._minPlayerWidth ?? 0;
    }

    /** After an object was added or deleted in the scene (formats other than .babylon). */
    _rebuildModel() {
        this._highlighter.clear();
        this._animations.dispose();
        this._animations.setContainer(this._container);
        // Cameras of the model may be added or deleted: the views show them again
        this._cameraViews.apply();
        this._resetTree();
        this._inspectorObjects.clear();
        this._hiddenInView.clear();
        this._showClipTags(this._animations.current);
        // The player is wider with animation controls: it may no longer fit next to the inspector
        this._updateLayout();
        this._toolbar.setPlaying(this._animations.isPlaying);
        this._showFile();
    }

    /**
     * Runs a command of the tree context menu (the host asks for names and confirmations).
     * @param {{ requestId: number, op: string, id?: string, name?: string, section?: string, kind?: string, extra?: object }} message
     * @returns {any} the result for the host
     */
    _runTreeCommand({ op, id, name, section, kind, extra }) {
        if (!this._container) throw new Error('No model is loaded');
        const data = id ? (this._tree.get(id) ?? { data: this._inspectorObjects.get(id) })?.data : null;
        if (id && !data) throw new Error('The item no longer exists');
        // Cameras of the views live in memory: also for view-only formats
        if (op === 'add' && section === 'Cameras') return this._addVirtualCamera(kind, name);
        if (data?.kind === 'camera' && data.virtual) return this._runVirtualCameraCommand(op, data.camera, name);
        // Reading commands also work for view-only formats
        if (!this._canEdit && op !== 'info' && op !== 'copy') throw new Error(`Editing .${this._type} files is not supported`);
        switch (op) {
            case 'info': return this._edits.info(data);
            case 'textureTargets': return this._edits.textureTargets();
            case 'rename': return this._edits.rename(data, name);
            case 'delete': return this._edits.delete(data);
            case 'add': return this._edits.add(section, kind, name, extra);
            case 'copy': return this._edits.copy(data);
            case 'paste': return this._edits.paste(section, extra?.object, extra?.sameFile, extra?.choices);
            default: throw new Error(`Unknown command ${op}`);
        }
    }

    /**
     * A new camera of the views in memory (Add… on Cameras): shown in the view with the mouse
     * controls and in the inspector.
     * @param {string} type
     * @param {string} name
     */
    _addVirtualCamera(type, name) {
        const camera = this._edits.newCamera(type, name);
        // Looking at the model like the preview camera
        const preview = this._camera.camera;
        if (preview instanceof BABYLON.ArcRotateCamera && camera instanceof BABYLON.ArcRotateCamera) {
            Object.assign(camera, { alpha: preview.alpha, beta: preview.beta, radius: preview.radius });
            camera.setTarget(preview.target.clone());
        }
        const ref = this._cameraViews.addVirtual(camera);
        this._cameraViews.setSlot(this._cameraViews.focus, ref);
        this._resetTree();
        this._revealObject(item => item.data?.kind === 'camera' && item.data.camera === camera);
    }

    /**
     * Rename… / Delete of a virtual camera (the host asked for the name or the confirmation).
     * @param {string} op
     * @param {BABYLON.Camera} camera
     * @param {string} [name]
     * @returns {any}
     */
    _runVirtualCameraCommand(op, camera, name) {
        switch (op) {
            case 'info': return { label: camera.name, canRename: true, dependents: [] };
            case 'rename':
                camera.name = name;
                break;
            case 'delete':
                this._cameraViews.removeVirtual(camera);
                if (this._selection?.data.kind === 'camera' && this._selection.data.camera === camera) this._showFile();
                break;
            default: throw new Error(`${op} is not available for a virtual camera`);
        }
        this._cameraViews.apply();
        this._saveCameraViews();
        this._resetTree();
        return null;
    }

    /**
     * Adds a virtual camera to the file, or removes a camera from the file keeping it as a virtual
     * one (Add to scene (file) of the camera inspector); the inspector shows the camera again.
     * @param {import('./editor/ModelOutline').ModelItemData & { kind: 'camera' }} data
     * @param {boolean} inFile
     */
    _setCameraInFile(data, inFile) {
        if (!this._canEdit || data.preview || inFile === !data.virtual) return;
        if (inFile) {
            const id = this._edits.addCamera(data.camera.serialize());
            this._cameraViews.pinVirtual(data.camera, id);
            this._resetTree();
            // A .babylon text reloads the model (the selection follows by name), a scene has it now
            this._revealObject(item => item.data?.kind === 'camera' && !item.data.virtual && !item.data.preview && item.data.camera.id === id);
        } else {
            const virtual = this._cameraViews.unpinFileCamera(data.camera);
            this._edits.delete(data);
            this._resetTree();
            this._revealObject(item => item.data?.kind === 'camera' && item.data.camera === virtual);
        }
    }

    /** Builds the model tree again (the cameras of the views changed) and tells the host. */
    _resetTree() {
        if (!this._container) return;
        this._tree.reset(ModelOutline.build(this._container, this._animations, this._type, {
            previews: this._camera.views.map(({ camera }) => camera),
            virtual: this._cameraViews.virtualCameras,
        }));
        vscode.postMessage({ type: 'treeReset' });
        this._toolbar.setCameraCount(this._cameraViews.cameras().length);
    }

    /** Keeps the cameras of the views and the virtual cameras in the webview state. */
    _saveCameraViews() {
        vscode.setState({ ...vscode.getState(), cameraViews: this._cameraViews.state });
    }

    /**
     * The menu of the camera tag of a view: the cameras to show in it, and the camera in the inspector.
     * @param {number} index
     * @param {HTMLElement} tag
     */
    _showViewCameraMenu(index, tag) {
        const shown = this._cameraViews.entryOf(index);
        const { left, bottom } = tag.getBoundingClientRect();
        const actions = [
            ...this._cameraViews.cameras().map(entry => ({
                label: entry.label || '(unnamed)',
                title: `${entry.label} (${entry.kind === 'file' ? 'in the file' : entry.kind})`,
                icon: entry.ref === shown?.ref ? 'check' : entry.kind === 'file' ? 'pinned' : 'device-camera',
                run: () => this._cameraViews.setSlot(index, entry.ref),
            })),
            ...(shown ? [{
                label: 'Show in the inspector',
                title: `Show ${shown.label} in the inspector and the model tree`,
                icon: 'go-to-file',
                run: () => this._revealObject(item => item.data?.kind === 'camera' && item.data.camera === shown.camera),
            }] : []),
        ];
        this._cameraMenu.show(Math.max(0, left), bottom + 2, actions, { isDisabled: () => false, run: action => action.run() });
    }

    /** A click (not a camera drag) on a bone in the 3D view selects it; a click on the selected bone deselects it. */
    _listenBonePicks() {
        this._scene.onPointerObservable.add((info) => {
            // A quick second click is reported as a double tap; it toggles the selection too
            const { POINTERTAP, POINTERDOUBLETAP } = BABYLON.PointerEventTypes;
            if (info.type !== POINTERTAP && info.type !== POINTERDOUBLETAP) return;
            const bone = this._highlighter.pickBone(this._scene.pointerX, this._scene.pointerY);
            if (bone) this._revealBone(bone);
        });
    }

    /**
     * Shows a bone picked in the 3D view: its record in the clip table / graph,
     * otherwise the bone inspector.
     * @param {BABYLON.Bone} bone
     */
    _revealBone(bone) {
        if (bone === this._highlighter.selectedBone) {
            this._highlighter.selectBone(null);
            this._panel.clearRowSelection();
            return;
        }
        this._highlighter.selectBone(bone);
        if (this._panel.revealObject(bone)) {
            this._panel.refreshActions();
            return;
        }
        this._select({ id: `picked-bone:${bone.uniqueId}`, label: () => bone.name, data: { kind: 'bone', bone } }, this._selection);
    }

    /**
     * @param {HTMLElement} element the editor root (toolbar and player controls)
     * @returns {Toolbar}
     */
    _createToolbar(element) {
        const toolbar = new Toolbar(element, {
            onToggleOrbit: () => {
                this._camera.toggleAutoOrbit();
                toolbar.setOrbit(this._camera.autoOrbit);
                // Actions may depend on the camera / playback state (Rest / Bind pose)
                this._panel.refreshActions();
            },
            onTogglePlay: () => {
                this._animations.toggle();
                toolbar.setPlaying(this._animations.isPlaying);
                if (!this._animations.isPlaying) this._syncClipFrame();
                // The clip inspector shows Play or Pause depending on the playback state
                this._panel.refreshActions();
            },
            onSeek: (progress) => {
                this._animations.seek(progress);
                if (this._animations.isPlaying) {
                    this._panel.refreshActions();
                } else {
                    this._syncClipFrame();
                }
            },
            onSelectRenderMode: (mode) => {
                this._setRenderMode(mode);
                saveViewSettings({ renderMode: mode });
            },
            onSelectView: (view) => {
                this._view = view;
                if (view !== 'desktop') this._singleView = view;
                saveViewSettings({ view, singleView: this._singleView });
                this._updateLayout();
            },
            onResetView: () => {
                // The camera of the view with the mouse: the preview camera goes to its framed position
                const entry = this._cameraViews.resetFocused();
                if (entry?.kind === 'preview') this._camera.resetView(entry.camera);
                this._saveCameraViews();
            },
            onToggleMesh: () => this._toggleSkeletonDisplay('mesh'),
            onToggleBones: () => this._toggleSkeletonDisplay('bones'),
            onOpenTag: tag => this._openTag(tag),
            cameras: () => this._cameraViews.cameras().map(entry => ({
                id: entry.ref,
                label: entry.label || '(unnamed)',
                description: entry.kind === 'file' ? 'in the file' : entry.kind,
                active: entry.ref === this._cameraViews.entryOf(0)?.ref,
            })),
            onSelectCamera: (ref) => {
                this._cameraViews.setSlot(0, ref);
                this._view = 'model';
                this._singleView = 'model';
                saveViewSettings({ view: 'model', singleView: 'model' });
                this._updateLayout();
            },
            onSelectLayout: (layout) => {
                this._layout = layout;
                this._view = 'desktop';
                saveViewSettings({ view: 'desktop', layout });
                this._updateLayout();
            },
        });
        toolbar.setOrbit(this._camera.autoOrbit);
        toolbar.setPlaying(false);
        toolbar.setClip(null);
        toolbar.setSkeletonMode({ available: false, active: false, display: this._highlighter.skeletonDisplay });
        this._scene.onAfterRenderObservable.add(() => {
            if (this._animations.current) {
                toolbar.setProgress(this._animations.getProgress());
            }
            if (this._animations.isPlaying && this._selection?.data.kind === 'clip') this._panel.updateCurrentFrame();
        });
        return toolbar;
    }

    /**
     * Replaces the current model with the one contained in the given bytes.
     * Data is wrapped into a File so every registered loader (including the
     * text-based .babylon loader, which cannot read an ArrayBufferView) can parse it;
     * relative resources (textures, .bin, .mtl) are resolved against payload.rootUrl.
     * @param {ArrayBuffer | Uint8Array} data
     * @param {{ keepView?: boolean }} [options] keepView - a reload after a document change: the camera,
     *   the current clip and frame and the selected object are kept
     */
    async loadModel(data, { keepView = false } = {}) {
        const { fileName = `model.${this._type}`, rootUrl = '' } = window.payload || {};
        setStatus('Loading…');
        const view = keepView ? this._captureView() : null;
        try {
            const file = new File([data], fileName);
            const container = await BABYLON.LoadAssetContainerAsync(file, this._scene, { rootUrl });
            const binding = this._textBacked
                ? new BabylonJsonBinding(JSON.parse(new TextDecoder().decode(data)), container, this._scene, rootUrl)
                : null;
            this._highlighter.clear();
            this._clipSkeleton = null;
            this._syncSkeletonButtons();
            this._animations.dispose();
            this._container?.dispose();
            this._container = container;
            this._binding = binding;
            this._source = this._textBacked ? null : ModelSerializer.inspectSource(this._type, data);
            container.addAllToScene();
            if (!view) this._camera.frame({ frontIsPositiveZ: this._isGltfModel() });
            this._animations.setContainer(container);
            this._history.clear();
            this._changed.clear();
            this._fileFields = this._textBacked ? null : FileInfo.read(this._type, data);
            // The views show the cameras of the new model (through new copies) and the new preview camera
            this._cameraViews.setContainer(container);
            this._resetTree();
            this._inspectorObjects.clear();
            this._hiddenInView.clear();
            this._highlighter.hiddenBones.clear();
            this._showClipTags(this._animations.current);
            // The player is wider with animation controls: it may no longer fit next to the inspector
            this._updateLayout();
            this._toolbar.setPlaying(this._animations.isPlaying);
            if (view) {
                this._restoreView(view);
            } else {
                this._showFile();
            }
            setStatus('');
        } catch (error) {
            console.error('[BabylonEditor] Failed to load model', error);
            const detail = error?.message || String(error);
            setStatus(this._textBacked
                ? `File format error: ${detail}. Fix the file in the source text or undo the changes.`
                : `Failed to load model: ${detail}`, true);
        }
    }

    /**
     * State kept across a reload of the model after a document change.
     * @returns {{ camera: object | null, clip: string | null, frame: number, selection: { kind: string, label: string } | null }}
     *   camera - the preview camera (the cameras of the views stay: CameraViews)
     */
    _captureView() {
        const camera = this._camera.camera;
        return {
            camera: camera instanceof BABYLON.ArcRotateCamera
                ? { alpha: camera.alpha, beta: camera.beta, radius: camera.radius, target: camera.target.clone() }
                : null,
            clip: this._animations.current?.name ?? null,
            frame: this._animations.currentFrame,
            selection: this._selection ? { kind: this._selection.data.kind, label: this._selection.label() } : null,
            hiddenInView: [...this._hiddenInView.keys()].map(mesh => mesh.name),
            hiddenBones: [...this._highlighter.hiddenBones].map(bone => ({ skeleton: bone.getSkeleton().name, bone: bone.name })),
        };
    }

    /**
     * @param {ReturnType<Editor['_captureView']>} view
     */
    _restoreView(view) {
        // Parts hidden in the 3D view stay hidden (matched by name: the reloaded meshes are new objects)
        const hidden = new Set(view.hiddenInView);
        this._container.meshes.filter(mesh => hidden.has(mesh.name)).forEach(mesh => this._setHiddenInView(mesh, true));
        // Bones hidden in the 3D view too, by skeleton and bone name
        this._highlighter.hiddenBones.clear();
        for (const { skeleton: skeletonName, bone: boneName } of view.hiddenBones ?? []) {
            const bone = this._container.skeletons.find(skeleton => skeleton.name === skeletonName)?.bones.find(candidate => candidate.name === boneName);
            if (bone) this._highlighter.setBoneHidden(bone, true);
        }
        const camera = this._camera.camera;
        if (view.camera && camera instanceof BABYLON.ArcRotateCamera) {
            Object.assign(camera, { alpha: view.camera.alpha, beta: view.camera.beta, radius: view.camera.radius });
            camera.setTarget(view.camera.target);
        }
        const clip = this._animations.findClip(view.clip);
        if (clip) this._propertiesContext().showFrame(clip, view.frame);
        const item = view.selection && this._findTreeItem(this._tree.getRoots(), view.selection);
        const node = !item && view.selection?.kind === 'node' ? this._findListedNode(view.selection.label) : null;
        if (item) {
            this._select(item);
        } else if (node) {
            this._openNodeFromTree(node);
        } else {
            this._showFile();
        }
    }

    /**
     * @param {string} name
     * @returns {BABYLON.TransformNode | null} a node of the model that is listed in the inspector of a root node
     */
    _findListedNode(name) {
        return [...this._container.meshes, ...this._container.transformNodes].find(node => node.parent && node.name === name) ?? null;
    }

    /**
     * Opens a node listed in the inspector of its root node; back returns to the root node.
     * @param {BABYLON.TransformNode} node
     */
    _openNodeFromTree(node) {
        let root = node;
        while (root.parent) root = root.parent;
        const rootItem = this._findTreeItem(this._tree.getRoots(), { kind: 'node', label: root.name });
        // A new way: the inspectors of the model before a reload are gone
        this._backStack = [];
        this._openObject({ kind: 'node', node }, rootItem);
    }

    /** Shows the file fields in the inspector (nothing of the tree is selected). */
    _showFile() {
        const { fileName = `model.${this._type}` } = window.payload || {};
        this._select({ id: 'file', label: () => fileName, data: { kind: 'file' } });
    }

    /**
     * Finds a tree item by kind and label (depth-first, creating lazy children).
     * @param {import('./editor/ModelOutline').TreeItem[]} items
     * @param {{ kind: string, label: string }} wanted
     * @param {number} [depth]
     * @returns {import('./editor/ModelOutline').TreeItem | null}
     */
    _findTreeItem(items, wanted, depth = 0) {
        for (const item of items) {
            if (item.data?.kind === wanted.kind && item.label() === wanted.label) return item;
            if (item.children && depth < 8) {
                const found = this._findTreeItem(item.children(), wanted, depth + 1);
                if (found) return found;
            }
        }
        return null;
    }

    /**
     * Applies changes of the text document (typing, undo/redo, other editors) to the model.
     * @param {import('./editor/BabylonJsonBinding').JsonPatch[]} patches
     */
    _applyDocumentPatches(patches) {
        if (!this._binding) return;
        // The text is valid again
        setStatus('');
        if (!this._binding.apply(patches)) {
            vscode.postMessage({ type: 'requestReload' });
            return;
        }
        this._animations.refreshPose();
        this._refresh();
    }

    /**
     * Checks that model data loads and renders, in a separate scene (the shown model is not touched).
     * @param {ArrayBuffer} data
     * @returns {Promise<string | null>} the error, or null when the model is fine
     */
    async validate(data) {
        const { fileName = `model.${this._type}`, rootUrl = '' } = window.payload || {};
        const scene = new BABYLON.Scene(this._scene.getEngine());
        try {
            if (this._textBacked) JSON.parse(new TextDecoder().decode(data));
            const container = await BABYLON.LoadAssetContainerAsync(new File([data], fileName), scene, { rootUrl });
            container.addAllToScene();
            // Compiles the materials (shader errors show up here) and loads the textures; no frame is
            // drawn, so the shown model does not flicker
            await scene.whenReadyAsync();
            return null;
        } catch (error) {
            return String(error?.message || error);
        } finally {
            scene.dispose();
        }
    }

    /**
     * Converts a model file into a `.babylon` document (in a separate scene) for the host.
     * @param {{ requestId: number, data: ArrayBuffer, fileName: string, producer?: object }} message
     */
    async _convertModel({ requestId, data, fileName, producer }) {
        const { rootUrl = '' } = window.payload || {};
        setStatus(`Converting ${fileName} to .babylon…`);
        try {
            const { text, source } = await ModelConverter.toBabylon({ engine: this._scene.getEngine(), data, fileName, rootUrl, producer });
            vscode.postMessage({ type: 'converted', requestId, data: new TextEncoder().encode(text).buffer, source });
        } catch (error) {
            console.error('[BabylonEditor] Failed to convert the model', error);
            vscode.postMessage({ type: 'converted', requestId, error: String(error?.message || error) });
        } finally {
            setStatus('');
        }
    }

    /**
     * Converts a `.babylon` document into a model format (in a separate scene) for the host.
     * @param {{ requestId: number, data: ArrayBuffer, format: string, source?: import('./editor/ModelSerializer').SourceInfo }} message
     */
    async _exportModel({ requestId, data, format, source }) {
        const { rootUrl = '' } = window.payload || {};
        try {
            const result = await ModelConverter.fromBabylon({ engine: this._scene.getEngine(), data, type: format, source, rootUrl });
            vscode.postMessage({ type: 'exported', requestId, data: result });
        } catch (error) {
            console.error('[BabylonEditor] Failed to export the model', error);
            vscode.postMessage({ type: 'exported', requestId, error: String(error?.message || error) });
        }
    }

    /**
     * Regenerates the file content from the scene, in the original format or another one (Save As).
     * @param {string} [format] extension of the format to write (babylon, glb, obj, stl)
     * @param {object} [producer] the `producer` value of a written `.babylon` document
     * @returns {Promise<ArrayBuffer>}
     */
    async serialize(format = this._type, producer = undefined) {
        if (!this._container) throw new Error('No model is loaded');
        // Highlight helpers (outlines, bones, markers) and hidden meshes must not end up in the file
        const selectedBone = this._highlighter.selectedBone;
        this._highlighter.clear();
        // Parts hidden in the 3D view only are written as they are
        const hidden = [...this._hiddenInView.keys()];
        hidden.forEach(mesh => this._setHiddenInView(mesh, false));
        try {
            if (format === 'babylon') {
                const text = await ModelConverter.writeBabylon({ scene: this._scene, container: this._container, producer });
                return new TextEncoder().encode(text).buffer;
            }
            // An OBJ keeps referring to the material library of the source OBJ; an STL keeps its encoding
            const source = {
                mtllib: format === 'obj' && this._type === 'obj' ? this._source?.mtllib ?? null : null,
                binaryStl: this._type === 'stl' ? this._source?.binaryStl ?? true : true,
            };
            return await ModelSerializer.serialize({ type: format, scene: this._scene, container: this._container, source });
        } finally {
            hidden.forEach(mesh => this._setHiddenInView(mesh, true));
            if (this._selection) {
                this._highlight(this._selection.data);
                this._highlighter.selectBone(selectedBone);
            }
        }
    }

    /**
     * @returns {import('./editor/ModelProperties').PropertiesContext}
     */
    _propertiesContext() {
        return {
            fileType: this._type,
            container: this._container,
            animations: this._animations,
            highlighter: this._highlighter,
            history: this._history,
            selectClip: (index) => this._selectClip(index),
            playClip: (index) => this._playClip(index),
            pauseAnimation: () => {
                this._animations.pause();
                this._toolbar.setPlaying(false);
                this._syncClipFrame();
            },
            showPose: (skeleton, pose) => {
                this._camera.setAutoOrbit(false);
                this._toolbar.setOrbit(false);
                this._animations.showPose(skeleton, pose);
                this._toolbar.setPlaying(false);
            },
            isPose: (skeleton, pose) => !this._animations.isPlaying && !this._camera.autoOrbit && this._animations.isPose(skeleton, pose),
            showFrame: (clip, frame) => {
                this._animations.showFrame(clip, frame);
                this._showClipTags(clip);
                this._toolbar.setPlaying(false);
            },
            selectedRow: () => this._panel.selectedRow,
            fileName: window.payload?.fileName || `model.${this._type}`,
            convertedFrom: window.payload?.convertedFrom ?? null,
            isHiddenInView: mesh => this._hiddenInView.has(mesh),
            setHiddenInView: (mesh, hidden) => this._setHiddenInView(mesh, hidden),
            setCameraInFile: this._canEdit ? (data, inFile) => this._setCameraInFile(/** @type {any} */ (data), inFile) : null,
            showJointNodes: () => !!vscode.getState()?.showJointNodes,
            setShowJointNodes: (show) => vscode.setState({ ...vscode.getState(), showJointNodes: show }),
            fileFields: this._fileFields ?? null,
            documentFields: this._binding?.documentFields ?? null,
            binding: this._binding,
            openObject: data => this._openObject(data),
            objectCommand: (op, data) => this._objectCommand(op, data),
            textureImage: this._textureImage,
            promptNumber: async (title, prompt, value) => {
                const input = await this._host.request('inputBox', { title, prompt, value: String(value), positiveNumber: true });
                return input === null ? null : Number(input.trim().replace(',', '.'));
            },
        };
    }

    /**
     * @returns {boolean} the model comes from a glTF file (also when it is edited as a converted
     *   `.babylon` document): glTF models face +Z
     */
    _isGltfModel() {
        const source = window.payload?.convertedFrom ?? `.${this._type}`;
        return /\.(glb|gltf|gltf2)$/i.test(source);
    }

    /**
     * Shows the model with textures, without them or as lines. Only the view changes: textures are
     * switched off by Babylon's global material flags and lines by the scene's forced wireframe,
     * so the materials (and the file) stay as they are.
     * @param {import('./editor/Toolbar').RenderMode} mode
     */
    _setRenderMode(mode) {
        const textures = mode !== 'solid';
        for (const flag of Object.getOwnPropertyNames(BABYLON.MaterialFlags)) {
            if (flag.endsWith('TextureEnabled')) BABYLON.MaterialFlags[flag] = textures;
        }
        this._scene.forceWireframe = mode === 'wireframe';
        this._toolbar.setRenderMode(mode);
    }

    /**
     * Hides a mesh in the 3D view through its layer mask: the model is not changed (the `.babylon`
     * binding does not write the layer mask, and serializing restores it).
     * @param {BABYLON.AbstractMesh} mesh
     * @param {boolean} hidden
     */
    _setHiddenInView(mesh, hidden) {
        if (hidden === this._hiddenInView.has(mesh)) return;
        if (hidden) {
            this._hiddenInView.set(mesh, mesh.layerMask);
            mesh.layerMask = 0;
        } else {
            mesh.layerMask = this._hiddenInView.get(mesh);
            this._hiddenInView.delete(mesh);
        }
    }

    /**
     * Shows an object listed in the inspector (a child node or a part of a mesh, a texture of a
     * material, the skeleton of a mesh) in its own inspector; its back button returns to the
     * inspector it was opened from.
     * @param {import('./editor/ModelOutline').ModelItemData} data
     * @param {import('./editor/ModelOutline').TreeItem | null} [backTo] defaults to the shown item
     */
    _openObject(data, backTo = this._selection) {
        // The tree item stays selected in VS Code; the next click on it opens it again
        vscode.postMessage({ type: 'treeDeselected' });
        this._select({ id: this._inspectorObjectId(data), label: () => objectOf(data).name, data }, backTo);
    }

    /**
     * Runs a command of the tree context menu (Rename…, Delete) on an object listed in the
     * inspector: the host asks the user, then sends the command back like one from the tree.
     * @param {'rename' | 'delete'} op
     * @param {import('./editor/ModelOutline').ModelItemData} data
     */
    _objectCommand(op, data) {
        vscode.postMessage({ type: 'objectCommand', op, id: this._inspectorObjectId(data) });
    }

    /**
     * @param {import('./editor/ModelOutline').ModelItemData} data
     * @returns {string} id under which tree commands find an object that has no tree item
     */
    _inspectorObjectId(data) {
        const id = `inspector-${data.kind}:${objectOf(data).uniqueId}`;
        this._inspectorObjects.set(id, data);
        return id;
    }

    /**
     * Shows an item in the inspector.
     * @param {import('./editor/ModelOutline').TreeItem} item
     * @param {import('./editor/ModelOutline').TreeItem | null} [backTo] the inspector it is opened from:
     *   the back button returns there, then further back the way it came; without it a new way starts
     *   (an item of the tree, the file view) and the back button returns to the file view
     */
    _select(item, backTo = null) {
        this._backStack = backTo ? [...this._backStack, backTo] : [];
        this._show(item);
    }

    /**
     * Renders an item in the inspector; the back button goes one step back the way it came.
     * @param {import('./editor/ModelOutline').TreeItem} item
     */
    _show(item) {
        this._selection = item;
        const context = this._propertiesContext();
        const content = ModelProperties.describe(item.data, context);
        if (this._backStack.length) {
            content.back = () => this._show(this._backStack.pop());
        } else if (item.data.kind !== 'file') {
            content.back = () => {
                // The tree item stays selected in VS Code; the next click on it opens it again
                vscode.postMessage({ type: 'treeDeselected' });
                this._showFile();
            };
        }
        if (!this._canEdit) {
            const reason = `Saving .${this._type} files is not supported, editing is disabled.`;
            content.notice = content.notice ? `${reason} ${content.notice}` : reason;
        }
        this._panel.show(content);
        this._highlight(item.data);
    }

    /**
     * Shows the selected object in the 3D view and syncs the skeleton mode toggles.
     * @param {import('./editor/ModelOutline').ModelItemData} data
     */
    _highlight(data) {
        ModelProperties.highlight(data, this._propertiesContext());
        this._syncSkeletonButtons();
        this._updateLayout();
    }

    /**
     * Toggles the model meshes or the bones in skeleton mode; the choice is kept in the webview state.
     * Outside the skeleton mode (the mesh shown, no bones) both show the skeleton of the current
     * clip, the mesh toggle hiding the mesh.
     * @param {'mesh' | 'bones'} part
     */
    _toggleSkeletonDisplay(part) {
        const entering = !this._highlighter.isSkeletonMode;
        if (entering && !this._clipSkeleton) return;
        const display = entering
            ? { mesh: part !== 'mesh', bones: true }
            : { ...this._highlighter.skeletonDisplay, [part]: !this._highlighter.skeletonDisplay[part] };
        this._highlighter.setSkeletonDisplay(display);
        if (entering) this._highlighter.showSkeleton(this._clipSkeleton);
        this._syncSkeletonButtons();
        vscode.setState({ ...vscode.getState(), skeletonDisplay: display });
    }

    /** Shows the mesh / bones toggles as the skeleton mode and the current clip allow. */
    _syncSkeletonButtons() {
        const changed = this._toolbar.setSkeletonMode({
            available: !!this._clipSkeleton,
            active: this._highlighter.isSkeletonMode,
            display: this._highlighter.skeletonDisplay,
        });
        // The player is wider with the toggles: it may no longer fit next to the inspector
        if (changed) this._updateLayout();
    }

    /**
     * Shows an item picked in the Explorer tree in the inspector.
     * @param {string} id
     */
    _selectTreeItem(id) {
        // No item (the selected item was clicked again): the file view
        if (id === null) return this._showFile();
        const item = this._tree.get(id);
        // Sections only expand: the inspector keeps what it shows
        if (item && item.data?.kind !== 'section') this._select(item);
    }

    /**
     * Shows the names of the current clip, of the skeleton it animates and of the mesh of that
     * skeleton in the player.
     * @param {import('./editor/AnimationController').AnimationClip | null | undefined} clip
     */
    _showClipTags(clip) {
        const skeleton = clip && this._container ? ClipFrameEditor.skeletonOf(clip, this._container) : null;
        const meshes = skeleton ? this._container.meshes.filter(mesh => mesh.skeleton === skeleton && mesh.getTotalVertices() > 0) : [];
        this._clipSkeleton = skeleton;
        const mesh = meshTag(meshes);
        this._clipMesh = mesh?.node ?? null;
        this._toolbar.setClip(clip?.name ?? null, {
            icon: clipIcon(clip),
            skeleton: skeleton ? skeleton.name || '(unnamed)' : null,
            mesh: mesh?.label ?? null,
            meshTitle: `Mesh of the current skeleton: ${meshes.slice(0, 10).map(part => part.name).join(', ')}${meshes.length > 10 ? ', …' : ''}`,
        });
        this._syncSkeletonButtons();
    }

    /**
     * Shows the object of a player tag in the inspector and selects it in the model tree. An object
     * the tree does not list (a mesh below a root node) opens in its own inspector, its back button
     * going to the root node, which the tree reveals.
     * @param {import('./editor/Toolbar').PlayerTag} tag
     */
    _openTag(tag) {
        const clip = this._animations.current;
        if (tag === 'clip' && clip) {
            this._revealObject(item => item.data?.kind === 'clip' && item.data.clip === clip);
        } else if (tag === 'skeleton' && this._clipSkeleton) {
            const skeleton = this._clipSkeleton;
            this._revealObject(item => item.data?.kind === 'skeleton' && item.data.skeleton === skeleton);
        } else if (tag === 'mesh' && this._clipMesh) {
            const node = this._clipMesh;
            const ancestors = [];
            for (let parent = node; parent; parent = parent.parent) ancestors.push(parent);
            const found = this._tree.find(item => item.data?.kind === 'node' && ancestors.includes(item.data.node));
            if (found?.item.data.node === node) {
                this._revealObject(item => item === found.item);
            } else {
                // A new way: back goes to the root node, then to the file
                this._backStack = [];
                this._openObject({ kind: 'node', node }, found?.item ?? null);
                if (found) vscode.postMessage({ type: 'treeReveal', nodes: found.nodes, select: false });
            }
        }
    }

    /**
     * Shows a tree item in the inspector and selects it in the model tree.
     * @param {(item: import('./editor/ModelOutline').TreeItem) => boolean} match
     */
    _revealObject(match) {
        const found = this._tree.find(match);
        if (!found) return;
        this._select(found.item);
        vscode.postMessage({ type: 'treeReveal', nodes: found.nodes, select: true });
    }

    /**
     * @param {number} index
     */
    _selectClip(index) {
        this._animations.select(index);
        this._showClipTags(this._animations.current);
        this._toolbar.setPlaying(this._animations.isPlaying);
    }

    /**
     * Makes a clip current and plays it from its first frame.
     * @param {number | import('./editor/AnimationController').AnimationClip} clip index in the clip list, or the clip (e.g. the whole timeline)
     */
    _playClip(clip) {
        this._animations.select(clip);
        this._animations.play();
        this._showClipTags(this._animations.current);
        this._toolbar.setPlaying(this._animations.isPlaying);
    }

    /**
     * Records a property change; undo restores an exact snapshot when the property provides one.
     * @param {import('./editor/PropertyPanel').PropertyDescriptor} property
     * @param {any} value
     */
    _commitProperty(property, value) {
        if (!property.set) return;
        if (property.transient) {
            property.set(value);
            this._panel.refresh();
            // A renamed camera of the views: its tree item, the camera tags; a moved one is kept
            if (this._selection?.data.kind === 'camera') {
                vscode.postMessage({ type: 'treeChanged' });
                this._cameraViews.apply();
                this._saveCameraViews();
            }
            return;
        }
        if (!this._canEdit) return;
        if (this._selection) this._markChanged(objectOf(this._selection.data), 'modified');
        this._history.executeMutation(
            `Change ${property.label}`,
            property.capture ?? property.get,
            () => property.set(value),
            property.restore ?? property.set,
        );
    }

    /**
     * Records a table cell change.
     * @param {import('./editor/DataTable').TableColumn} column
     * @param {number} row
     * @param {number | string} oldValue
     * @param {number | string} newValue
     */
    _commitCell(column, row, oldValue, newValue) {
        if (!this._canEdit || !column.set) return;
        if (this._selection) this._markChanged(objectOf(this._selection.data), 'modified');
        const label = `Change ${column.label}`;
        if (column.capture && column.restore) {
            this._history.executeMutation(label, () => column.capture(row), () => column.set(row, newValue), state => column.restore(row, state));
        } else {
            this._history.execute({ label, apply: () => column.set(row, newValue), revert: () => column.set(row, oldValue) });
        }
    }

    /**
     * Records a key drag of the graph view; the drag already changed the keys.
     * @param {import('./editor/CurveTable').CurveData} data
     * @param {number} row
     * @param {string} label
     * @param {any} before record snapshot before the drag
     * @param {any} after record snapshot after the drag
     */
    _commitCurve(data, row, label, before, after) {
        if (!this._canEdit) {
            data.restore(row, before);
            return;
        }
        if (this._selection) this._markChanged(objectOf(this._selection.data), 'modified');
        this._history.execute({ label, apply: () => data.restore(row, after), revert: () => data.restore(row, before) });
    }

    /** Syncs the UI with the model after an edit, undo or redo. */
    _refresh() {
        vscode.postMessage({ type: 'treeChanged' });
        this._panel.refresh();
        this._showClipTags(this._animations.current);
        // A camera of the file edited (or undone): the views showing it take its values
        this._cameraViews.refreshCopies();
    }

    /**
     * Handles extension host messages and notifies the host that the webview can receive the model.
     */
    listenHostMessages() {
        window.addEventListener('message', async (event) => {
            const message = event.data;
            if (this._host.handleMessage(message)) return;
            switch (message?.type) {
                case 'loadModel':
                case 'reloadModel':
                    this.loadModel(message.data, { keepView: !!message.keepView });
                    break;
                case 'applyPatches':
                    this._applyDocumentPatches(message.patches);
                    break;
                case 'treeCommand':
                    try {
                        vscode.postMessage({ type: 'treeCommandResult', requestId: message.requestId, result: this._runTreeCommand(message) ?? null });
                    } catch (error) {
                        vscode.postMessage({ type: 'treeCommandResult', requestId: message.requestId, error: String(error?.message || error) });
                    }
                    break;
                case 'documentSaved':
                    // The tree decorations start over (formats other than .babylon)
                    this._changed.clear();
                    vscode.postMessage({ type: 'treeChanged' });
                    break;
                case 'documentError':
                    // The text cannot be parsed: the last model stays, the message says how to recover
                    setStatus(message.message, true);
                    break;
                case 'validate':
                    vscode.postMessage({ type: 'validated', requestId: message.requestId, error: await this.validate(message.data) });
                    break;
                case 'convertModel':
                    await this._convertModel(message);
                    break;
                case 'exportModel':
                    await this._exportModel(message);
                    break;
                case 'undo':
                    this._history.undo();
                    break;
                case 'redo':
                    this._history.redo();
                    break;
                case 'treeRequest':
                    vscode.postMessage({ type: 'treeItems', requestId: message.requestId, items: this._tree.getChildren(message.parentId) });
                    break;
                case 'treeSelect':
                    this._selectTreeItem(message.id);
                    break;
                case 'getFileData':
                    try {
                        const data = await this.serialize(message.format, message.producer);
                        vscode.postMessage({ type: 'fileData', requestId: message.requestId, data });
                    } catch (error) {
                        console.error('[BabylonEditor] Failed to serialize model', error);
                        vscode.postMessage({ type: 'fileData', requestId: message.requestId, error: String(error?.message || error) });
                    }
                    break;
            }
        });
        vscode.postMessage({ type: 'ready' });
    }
}

function createEditor() {
    const root = document.querySelector('.editor');
    if (!root) return;
    new Editor(root).listenHostMessages();
}

function main() {
    window.addEventListener('DOMContentLoaded', createEditor);
}

main();
