import * as BABYLON from '@babylonjs/core';
import { BONES_LAYER, MODEL_LAYER } from './SkeletonView';
import { VERTICES_LAYER } from './ViewRendering';

/**
 * A layout of the desktop view: the side of the inspector and the number of camera views.
 * @typedef {{ side: 'left' | 'right', count: 1 | 2 | 3 | 4 }} ViewLayout
 */

/**
 * A camera a view can show: the preview camera, a camera of the file (shown through a copy, so
 * moving it does not change the file) or a virtual camera (only in memory).
 * @typedef {object} ViewCameraEntry
 * @property {string} ref `preview`, `base:<top | side | front>`, `file:<id>` or `virtual:<id>`
 * @property {'preview' | 'file' | 'virtual'} kind
 * @property {BABYLON.Camera} camera the camera of the model tree and the inspector
 * @property {string} label
 */

/**
 * What a view shows, set from the view bar while it is selected: the render mode, the vertices
 * (points over any mode) and, in skeleton mode, the meshes and the bones.
 * @typedef {{ renderMode: import('./Toolbar').RenderMode, vertices?: boolean, display: import('./SelectionHighlighter').SkeletonDisplay }} ViewSettings
 */

/**
 * State kept in the webview state: the cameras of the views, their settings and the virtual cameras.
 * @typedef {{ slots: string[], views?: ViewSettings[], selected?: number, virtual: { id: string, json: any, home: any }[] }} CameraViewsState
 */

/** Views of each count in canvas fractions, Babylon viewports (origin at the bottom left). */
const VIEWPORTS = {
    1: [[0, 0, 1, 1]],
    2: [[0, 0.5, 1, 0.5], [0, 0, 1, 0.5]],
    3: [[0, 0.5, 1, 0.5], [0, 0, 0.5, 0.5], [0.5, 0, 0.5, 0.5]],
    4: [[0, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5], [0, 0, 0.5, 0.5], [0.5, 0, 0.5, 0.5]],
};

/** Delay before the moved cameras are kept in the webview state. */
const SAVE_DELAY = 500;

/**
 * @param {any} json the camera in the `.babylon` format
 * @param {BABYLON.Scene} scene
 * @returns {BABYLON.Camera} a new camera of the scene with the values of the json
 */
function parseCamera(json, scene) {
    return BABYLON.Camera.Parse(json, scene);
}

/**
 * The views of the model on the canvas: one to four cameras, each in its part of the canvas
 * (`scene.activeCameras` with viewports). The view under the mouse gets the mouse controls (and the
 * picking); a tag in each view names its camera and opens the menu to change it. Cameras of the file
 * are shown through copies kept in sync with them (an edit of the file camera, a reload), so moving
 * a view never changes the model. Virtual cameras live only in memory (and in the webview state).
 */
export class CameraViews {

    /**
     * @param {object} options
     * @param {BABYLON.Scene} options.scene
     * @param {HTMLElement} options.viewport the element over the canvas (pointer events, tags)
     * @param {() => { ref: string, camera: BABYLON.Camera }[]} options.previews the preview camera and
     *   the base cameras (top, side, front views): not in the file
     * @param {(index: number, tag: HTMLElement) => void} options.onTagClick the camera tag of a view was clicked
     * @param {() => void} options.onChange the cameras or their places changed (kept in the webview state)
     * @param {() => ViewSettings} options.defaults the settings of a view not set yet
     * @param {() => boolean} options.isSkeletonMode the bones are shown (the views hide meshes / bones as set)
     * @param {(index: number) => void} options.onSelect another view was selected (the view bar shows its settings)
     * @param {(settings: ViewSettings) => void} options.onBeforeView a view is about to be rendered
     *   (its global render settings are applied)
     * @param {() => void} options.onAfterView a view was rendered (its render settings are undone)
     * @param {(needed: boolean) => void} options.onVerticesNeeded whether a shown view shows the vertices
     * @param {CameraViewsState} [options.state]
     */
    constructor({ scene, viewport, previews, onTagClick, onChange, defaults, isSkeletonMode, onSelect, onBeforeView, onAfterView, onVerticesNeeded, state }) {
        this._scene = scene;
        this._viewport = viewport;
        this._previews = previews;
        this._onTagClick = onTagClick;
        this._onChange = onChange;
        this._defaults = defaults;
        this._isSkeletonMode = isSkeletonMode;
        this._onSelect = onSelect;
        this._onVerticesNeeded = onVerticesNeeded;
        /** @type {ViewSettings[]} settings of each view */
        this._settings = Array.isArray(state?.views) ? state.views.map(settings => ({ ...settings, display: { ...settings.display } })) : [];
        /** The view the view bar shows and acts on (selected by a click) */
        this._selected = Number.isInteger(state?.selected) ? state.selected : 0;
        /** @type {BABYLON.AssetContainer | null} */
        this._container = null;
        /** @type {string[]} the camera of each view */
        this._slots = state?.slots?.length ? [...state.slots] : ['preview'];
        /** @type {Map<string, { camera: BABYLON.Camera, home: any }>} virtual cameras by id */
        this._virtual = new Map();
        for (const { id, json, home } of state?.virtual ?? []) {
            try {
                this._virtual.set(id, { camera: parseCamera(json, scene), home });
            } catch (error) {
                console.warn('[BabylonEditor] A virtual camera could not be restored', error);
            }
        }
        this._nextVirtual = Math.max(0, ...[...this._virtual.keys()].map(Number).filter(Number.isFinite)) + 1;
        /** @type {Map<BABYLON.Camera, { camera: BABYLON.Camera, fingerprint: string }>} view copies of the file cameras */
        this._copies = new Map();
        this._count = 1;
        this._focus = 0;
        /** @type {(BABYLON.Camera | null)[]} cameras of the shown views */
        this._shown = [];
        /** @type {(ViewCameraEntry | null)[]} entries of the shown views */
        this._resolved = [];
        /** @type {BABYLON.Camera | null} camera with the mouse controls */
        this._attached = null;
        this._overlay = document.createElement('div');
        this._overlay.className = 'views';
        viewport.append(this._overlay);
        this._bindPointer();
        // The render mode of each view (global material flags) is set before it is drawn
        scene.onBeforeCameraRenderObservable.add((camera) => {
            const index = this._shown.indexOf(camera);
            if (index >= 0) onBeforeView(this.settingsOf(index));
        });
        scene.onAfterCameraRenderObservable.add((camera) => {
            if (this._shown.includes(camera)) onAfterView();
        });
    }

    /** @returns {number} the view the view bar shows and acts on */
    get selected() {
        return this._selected;
    }

    /**
     * @param {number} index
     * @returns {ViewSettings} the settings of a view
     */
    settingsOf(index) {
        this._settings[index] ??= this._defaults();
        return this._settings[index];
    }

    /**
     * Changes the settings of a view (from the view bar).
     * @param {number} index
     * @param {Partial<ViewSettings>} changes
     */
    setSettings(index, changes) {
        const settings = this.settingsOf(index);
        this._settings[index] = { ...settings, ...changes, display: { ...settings.display, ...changes.display } };
        this.applyMasks();
        this._onChange();
    }

    /**
     * The view bar shows and acts on this view.
     * @param {number} index
     */
    select(index) {
        const clamped = Math.min(this._count - 1, Math.max(0, index));
        if (clamped === this._selected) return;
        this._selected = clamped;
        this._markSelected();
        this._onSelect(clamped);
        this._onChange();
    }

    /**
     * Each camera shows the model meshes and the bones as its view says (in skeleton mode; else
     * everything), and the vertices of the shown meshes when its view shows them: the layer mask of
     * the camera.
     */
    applyMasks() {
        const skeletonMode = this._isSkeletonMode();
        let vertices = false;
        this._shown.forEach((camera, index) => {
            if (!camera) return;
            const { display, vertices: showVertices } = this.settingsOf(index);
            const mesh = !skeletonMode || display.mesh;
            camera.layerMask = (mesh ? MODEL_LAYER : 0) | (!skeletonMode || display.bones ? BONES_LAYER : 0)
                | (mesh && showVertices ? VERTICES_LAYER : 0);
            vertices ||= mesh && !!showVertices;
        });
        this._onVerticesNeeded(vertices);
    }

    /** @returns {number} the view with the mouse controls */
    get focus() {
        return this._focus;
    }

    /** @returns {CameraViewsState} */
    get state() {
        return {
            slots: [...this._slots],
            views: this._settings,
            selected: this._selected,
            virtual: [...this._virtual].map(([id, { camera, home }]) => ({ id, json: camera.serialize(), home })),
        };
    }

    /**
     * The model changed: the copies of its cameras are made again.
     * @param {BABYLON.AssetContainer} container
     */
    setContainer(container) {
        this._container = container;
        this._copies.forEach(({ camera }) => camera.dispose());
        this._copies.clear();
        this.apply();
    }

    /**
     * @param {number} count views shown (1 to 4)
     */
    setCount(count) {
        const clamped = Math.min(4, Math.max(1, count));
        if (clamped === this._count) return;
        this._count = clamped;
        this._focus = Math.min(this._focus, clamped - 1);
        this.apply();
        if (this._selected >= clamped) {
            this._selected = clamped - 1;
            this._markSelected();
            this._onSelect(this._selected);
        }
    }

    /** @returns {ViewCameraEntry[]} the cameras views can show, as in the model tree */
    cameras() {
        return [
            ...this._previews().map(({ ref, camera }) => ({ ref, kind: /** @type {const} */ ('preview'), camera, label: camera.name })),
            ...(this._container?.cameras ?? []).map(camera => ({ ref: `file:${camera.id}`, kind: /** @type {const} */ ('file'), camera, label: camera.name })),
            ...[...this._virtual].map(([id, { camera }]) => ({ ref: `virtual:${id}`, kind: /** @type {const} */ ('virtual'), camera, label: camera.name })),
        ];
    }

    /** @returns {BABYLON.Camera[]} the virtual cameras */
    get virtualCameras() {
        return [...this._virtual.values()].map(({ camera }) => camera);
    }

    /**
     * @param {number} index
     * @returns {ViewCameraEntry | null} the camera of a shown view
     */
    entryOf(index) {
        return this._resolved[index] ?? null;
    }

    /**
     * Shows a camera in a view; a camera shown in another view changes place with it.
     * @param {number} index
     * @param {string} ref
     */
    setSlot(index, ref) {
        const current = this._resolved.map(entry => entry?.ref);
        const other = current.indexOf(ref);
        if (other >= 0 && other !== index) this._slots[other] = current[index] ?? this._slots[index];
        this._slots[index] = ref;
        this.apply();
        this._onChange();
    }

    /**
     * Moves the camera of the selected view back: the preview and base cameras to
     * their framed position (done by the caller, which knows it), a file camera to the values of the file, a
     * virtual camera to the values it was created or last added to the file with.
     * @returns {ViewCameraEntry | null} the camera of the selected view
     */
    resetSelected() {
        const entry = this.entryOf(this._selected);
        if (!entry) return null;
        if (entry.kind === 'file') {
            this._copies.get(entry.camera)?.camera.dispose();
            this._copies.delete(entry.camera);
            this.apply();
        } else if (entry.kind === 'virtual') {
            const id = entry.ref.slice('virtual:'.length);
            const virtual = this._virtual.get(id);
            if (virtual) {
                const camera = parseCamera(virtual.home, this._scene);
                virtual.camera.dispose();
                virtual.camera = camera;
                this.apply();
                this._onChange();
            }
        }
        return entry;
    }

    /**
     * Adds a virtual camera made by the caller in the scene (the caller shows it in a view).
     * @param {BABYLON.Camera} camera
     * @returns {string} its ref
     */
    addVirtual(camera) {
        const id = String(this._nextVirtual++);
        this._virtual.set(id, { camera, home: camera.serialize() });
        this._onChange();
        return `virtual:${id}`;
    }

    /**
     * @param {BABYLON.Camera} camera
     * @returns {string | null} the id of a virtual camera
     */
    virtualId(camera) {
        return [...this._virtual].find(([, virtual]) => virtual.camera === camera)?.[0] ?? null;
    }

    /**
     * @param {BABYLON.Camera} camera a virtual camera
     */
    removeVirtual(camera) {
        const id = this.virtualId(camera);
        if (id === null) return;
        this._virtual.delete(id);
        camera.dispose();
        this.apply();
        this._onChange();
    }

    /**
     * A virtual camera was added to the file: the views showing it show the file camera.
     * @param {BABYLON.Camera} camera
     * @param {string} fileId id of the camera in the file
     */
    pinVirtual(camera, fileId) {
        const id = this.virtualId(camera);
        if (id === null) return;
        this._slots = this._slots.map(ref => (ref === `virtual:${id}` ? `file:${fileId}` : ref));
        this._virtual.delete(id);
        camera.dispose();
        this.apply();
        this._onChange();
    }

    /**
     * A camera of the file is removed from the file but kept: a virtual camera with its values
     * takes its place in the views.
     * @param {BABYLON.Camera} camera a camera of the file
     * @returns {BABYLON.Camera} the virtual camera
     */
    unpinFileCamera(camera) {
        const json = camera.serialize();
        const virtual = parseCamera(json, this._scene);
        virtual.parent = camera.parent;
        const ref = this.addVirtual(virtual);
        this._slots = this._slots.map(slot => (slot === `file:${camera.id}` ? ref : slot));
        this.apply();
        this._onChange();
        return virtual;
    }

    /** The copies of file cameras changed in the file (an edit, undo) take their values again. */
    refreshCopies() {
        let changed = false;
        for (const [camera, copy] of this._copies) {
            if (copy.fingerprint === JSON.stringify(camera.serialize())) continue;
            copy.camera.dispose();
            this._copies.delete(camera);
            changed = true;
        }
        if (changed) this.apply();
    }

    /** Places the cameras of the shown views on the canvas and gives the focused one the mouse. */
    apply() {
        const scene = this._scene;
        const used = new Set();
        const all = this.cameras();
        this._resolved = [];
        for (let index = 0; index < this._count; index++) {
            let entry = all.find(candidate => candidate.ref === this._slots[index]);
            // A camera that is gone (or shown twice): the first one not shown
            if (!entry || used.has(entry.ref)) entry = all.find(candidate => !used.has(candidate.ref)) ?? null;
            if (entry) used.add(entry.ref);
            if (this._slots[index] === undefined && entry) this._slots[index] = entry.ref;
            this._resolved.push(entry);
        }
        this._shown = this._resolved.map(entry => (entry ? this._viewCamera(entry) : null));
        const viewports = VIEWPORTS[this._count];
        this._shown.forEach((camera, index) => {
            if (camera) camera.viewport = new BABYLON.Viewport(...viewports[index]);
        });
        const cameras = this._shown.filter(Boolean);
        scene.activeCameras = cameras.length > 1 ? cameras : [];
        this.applyMasks();
        this._setFocus(this._focus, true);
        this._renderTags();
    }

    /**
     * @param {ViewCameraEntry} entry
     * @returns {BABYLON.Camera} the camera that renders the view: a file camera through its copy
     */
    _viewCamera(entry) {
        if (entry.kind !== 'file') return entry.camera;
        let copy = this._copies.get(entry.camera);
        if (!copy) {
            const json = entry.camera.serialize();
            const camera = parseCamera(json, this._scene);
            camera.id = `__editorView:${entry.camera.id}`;
            camera.parent = entry.camera.parent;
            copy = { camera, fingerprint: JSON.stringify(json) };
            this._copies.set(entry.camera, copy);
        }
        return copy.camera;
    }

    /**
     * Gives a view the mouse controls and the picking.
     * @param {number} index
     * @param {boolean} [force] attach again (the cameras changed)
     */
    _setFocus(index, force = false) {
        if (index === this._focus && !force) return;
        this._focus = index;
        const camera = this._shown[index] ?? this._shown.find(Boolean) ?? null;
        if (camera !== this._attached || force) {
            this._attached?.detachControl();
            camera?.attachControl(true);
            this._attached = camera;
        }
        this._scene.activeCamera = camera;
        this._scene.cameraToUseForPointers = camera;
    }

    /** Frames the selected view (with more than one view). */
    _markSelected() {
        this._overlay.querySelectorAll('.views__view').forEach((view, index) => {
            view.classList.toggle('views__view--selected', index === this._selected && this._count > 1);
        });
    }

    /** One frame per view with the tag of its camera (top right). */
    _renderTags() {
        const viewports = VIEWPORTS[this._count];
        this._overlay.replaceChildren(...this._resolved.map((entry, index) => {
            const [x, y, width, height] = viewports[index];
            const view = document.createElement('div');
            view.className = 'views__view';
            view.classList.toggle('views__view--top', y + height >= 1);
            view.classList.toggle('views__view--selected', index === this._selected && this._count > 1);
            Object.assign(view.style, {
                left: `${x * 100}%`,
                top: `${(1 - y - height) * 100}%`,
                width: `${width * 100}%`,
                height: `${height * 100}%`,
            });
            const tag = document.createElement('span');
            tag.className = 'player__tag views__tag';
            tag.title = entry ? `The view is shown with ${entry.label}: click to choose its camera` : 'Click to choose a camera';
            const icon = document.createElement('i');
            icon.className = 'codicon codicon-device-camera';
            const name = document.createElement('span');
            name.className = 'player__tag-name';
            name.textContent = entry ? entry.label || '(unnamed)' : 'No camera';
            tag.append(icon, name);
            tag.addEventListener('click', () => {
                this.select(index);
                this._onTagClick(index, tag);
            });
            view.append(tag);
            return view;
        }));
    }

    /**
     * The view under the mouse gets the controls, a click selects it; moved cameras are kept in the
     * webview state.
     */
    _bindPointer() {
        const viewAt = (event) => {
            const canvas = this._scene.getEngine().getRenderingCanvas();
            if (!canvas || this._count < 2) return -1;
            const rect = canvas.getBoundingClientRect();
            const x = (event.clientX - rect.left) / rect.width;
            const y = 1 - (event.clientY - rect.top) / rect.height;
            return VIEWPORTS[this._count].findIndex(([left, bottom, width, height]) => x >= left && x < left + width && y >= bottom && y < bottom + height);
        };
        const focusAt = (event) => {
            const index = viewAt(event);
            if (index >= 0) this._setFocus(index);
        };
        // Captured before the canvas: the controls change before the camera inputs see the event
        this._viewport.addEventListener('pointerdown', (event) => {
            const index = viewAt(event);
            if (index < 0) return;
            this._setFocus(index);
            // A click on the canvas (not on a tag or the player bars) selects the view
            if (event.target === this._scene.getEngine().getRenderingCanvas()) this.select(index);
        }, true);
        this._viewport.addEventListener('wheel', focusAt, true);
        this._viewport.addEventListener('pointermove', (event) => {
            if (!event.buttons) focusAt(event);
        }, true);
        const save = () => {
            clearTimeout(this._saveTimer);
            this._saveTimer = setTimeout(() => this._onChange(), SAVE_DELAY);
        };
        this._viewport.addEventListener('pointerup', save, true);
        this._viewport.addEventListener('wheel', save, true);
    }
}
