import { PopupMenu } from './PopupMenu';

/** @typedef {import('./CameraViews').ViewLayout} ViewLayout */

/** The layouts of the desktop view: the inspector on the left or on the right, 1 to 4 camera views. */
const LAYOUTS = /** @type {ViewLayout[]} */ ([
    ...[1, 2, 3, 4].map(count => ({ side: 'left', count })),
    ...[1, 2, 3, 4].map(count => ({ side: 'right', count })),
]);

/** Camera views of each count in the 2×2 cells next to the inspector: [column, row, columns, rows]. */
const LAYOUT_CELLS = {
    1: [[0, 0, 2, 2]],
    2: [[0, 0, 2, 1], [0, 1, 2, 1]],
    3: [[0, 0, 2, 1], [0, 1, 1, 1], [1, 1, 1, 1]],
    4: [[0, 0, 1, 1], [1, 0, 1, 1], [0, 1, 1, 1], [1, 1, 1, 1]],
};

/**
 * An icon of a layout on a grid of 3×2 square cells: the inspector is the column of two cells on
 * its side (filled), the camera views share the 2×2 cells next to it.
 * @param {ViewLayout} layout
 * @returns {string} svg markup
 */
export function layoutIcon({ side, count }) {
    const cell = 7;
    const gap = 1;
    const rect = (column, row, columns, rows, filled) => `<rect x="${column * cell + gap / 2 + 0.5}" y="${row * cell + gap / 2 + 0.5}" width="${columns * cell - gap - 1}" height="${rows * cell - gap - 1}" rx="1"`
        + ` fill="${filled ? 'currentColor' : 'none'}" fill-opacity="0.4" stroke="currentColor" stroke-width="1"/>`;
    const cameraColumn = side === 'left' ? 1 : 0;
    const cameras = LAYOUT_CELLS[count].map(([column, row, columns, rows]) => rect(cameraColumn + column, row, columns, rows, false));
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${3 * cell + 1}" height="${2 * cell + 1}" viewBox="0 0 ${3 * cell + 1} ${2 * cell + 1}">`
        + `${rect(side === 'left' ? 0 : 2, 0, 1, 2, true)}${cameras.join('')}</svg>`;
}

/**
 * A camera the model view can be shown with.
 * @typedef {{ id: string, label: string, description?: string, active: boolean }} ViewCamera
 */

/**
 * @typedef {object} ToolbarHandlers
 * @property {() => void} onToggleOrbit
 * @property {() => void} onTogglePlay
 * @property {(progress: number) => void} onSeek
 * @property {() => void} onResetView moves the camera back to its start position
 * @property {() => void} onToggleMesh shows/hides the model meshes in skeleton mode
 * @property {() => void} onToggleBones shows/hides the bones in skeleton mode
 * @property {(view: EditorView) => void} onSelectView shows the model, the inspector or both
 * @property {(mode: RenderMode) => void} onSelectRenderMode shows the model with textures, without them or as lines
 * @property {(mode: CursorMode) => void} onSelectCursor what the left button does in the 3D view
 * @property {(tool: import('./TransformEditing').TransformTool) => void} onSelectTool the tool of the edit mode
 * @property {() => void} onToggleLocal the gizmo takes the local axes / the world axes
 * @property {(overlay: ViewOverlay) => void} onToggleOverlay shows / hides something over the model in the selected view
 * @property {(tag: PlayerTag) => void} onOpenTag a tag of the player was clicked: show its object
 * @property {() => ViewCamera[]} cameras the cameras the model view can be shown with (read when the
 *   Model button opens its menu)
 * @property {(id: string) => void} onSelectCamera shows the model alone through a camera
 * @property {(layout: ViewLayout) => void} onSelectLayout shows the model and the inspector in a layout
 */

/** @typedef {'mesh' | 'skeleton' | 'clip'} PlayerTag */

/** @typedef {'textured' | 'solid' | 'wireframe'} RenderMode */

/** @typedef {'view' | 'select' | 'edit'} CursorMode the left button turns the camera / selects / selects and edits */

/** @typedef {'vertices' | 'normals' | 'boneAxes'} ViewOverlay what a view can show over the model */

/** The overlay buttons of the view bar: their tooltips when off / on. */
const OVERLAYS = {
    vertices: ['Show the vertices (points over the model)', 'Hide the vertices'],
    normals: ['Show the normals of the vertices (lines along them)', 'Hide the normals'],
    boneAxes: ['Show the axes of the bones (X red, Y green, Z blue: how each bone is turned)', 'Hide the axes of the bones'],
};

/** @typedef {'model' | 'inspector' | 'desktop'} EditorView */

const SLIDER_MAX = 1000;

/**
 * Binds the controls rendered by BabylonEditor._getHtmlForWebview to editor actions and reflects
 * the editor state back into them: the toolbar above (view switch) and the player
 * in the model view (render modes, skeleton mesh / bones toggles, reset view, auto-orbit, play / pause, seek slider, the tags of the current mesh, skeleton and clip; the camera tags of the views are CameraViews').
 * Contains no Babylon logic.
 */
export class Toolbar {

    /**
     * @param {HTMLElement} root the `.editor` element
     * @param {ToolbarHandlers} handlers
     */
    constructor(root, handlers) {
        this._root = root;
        this._handlers = handlers;
        this._animationGroup = root.querySelector('.player__animation');
        this._orbitButton = root.querySelector('.player__orbit');
        this._resetButton = root.querySelector('.player__reset');
        /** @type {HTMLButtonElement[]} */
        this._cursorButtons = [...root.querySelectorAll('.toolbar__cursor')];
        /** @type {HTMLButtonElement[]} */
        this._toolButtons = [...root.querySelectorAll('.toolbar__tool')];
        this._localButton = root.querySelector('.toolbar__local');
        this._playButton = root.querySelector('.player__play');
        /** @type {HTMLInputElement} */
        this._slider = root.querySelector('.player__slider');
        this._clipTag = root.querySelector('.player__clip');
        this._clipIcon = this._clipTag.querySelector('.codicon');
        this._clipName = this._clipTag.querySelector('.player__tag-name');
        this._meshTag = root.querySelector('.player__mesh-name');
        this._meshName = this._meshTag.querySelector('.player__tag-name');
        this._skeletonTag = root.querySelector('.player__skeleton');
        this._skeletonName = this._skeletonTag.querySelector('.player__tag-name');
        this._skeletonGroup = root.querySelector('.player__group--skeleton');
        this._meshButton = root.querySelector('.player__mesh');
        this._bonesButton = root.querySelector('.player__bones');
        /** @type {Record<ViewOverlay, HTMLElement>} */
        this._overlayButtons = Object.fromEntries(Object.keys(OVERLAYS).map(key => [key, root.querySelector(`.player__overlay[data-overlay="${key}"]`)]));
        /** @type {HTMLButtonElement[]} */
        this._viewButtons = [...root.querySelectorAll('.toolbar__view')];
        /** @type {HTMLButtonElement[]} */
        this._modeButtons = [...root.querySelectorAll('.player__mode')];
        this._isSeeking = false;
        this._cameraMenu = new PopupMenu();
        this._bindEvents();
    }

    _bindEvents() {
        this._orbitButton.addEventListener('click', () => this._handlers.onToggleOrbit());
        this._resetButton.addEventListener('click', () => this._handlers.onResetView());
        this._cursorButtons.forEach(button => button.addEventListener('click', () => this._handlers.onSelectCursor(/** @type {CursorMode} */ (button.dataset.cursor))));
        this._toolButtons.forEach(button => button.addEventListener('click', () => this._handlers.onSelectTool(/** @type {any} */ (button.dataset.tool))));
        this._localButton.addEventListener('click', () => this._handlers.onToggleLocal());
        this._playButton.addEventListener('click', () => this._handlers.onTogglePlay());
        this._meshButton.addEventListener('click', () => this._handlers.onToggleMesh());
        this._bonesButton.addEventListener('click', () => this._handlers.onToggleBones());
        Object.entries(this._overlayButtons).forEach(([key, button]) => {
            button?.addEventListener('click', () => this._handlers.onToggleOverlay(/** @type {ViewOverlay} */ (key)));
        });
        this._meshTag.addEventListener('click', () => this._handlers.onOpenTag('mesh'));
        this._skeletonTag.addEventListener('click', () => this._handlers.onOpenTag('skeleton'));
        this._clipTag.addEventListener('click', () => this._handlers.onOpenTag('clip'));
        this._modeButtons.forEach(button => button.addEventListener('click', () => {
            this._handlers.onSelectRenderMode(/** @type {RenderMode} */ (button.dataset.mode));
        }));
        this._viewButtons.forEach(button => button.addEventListener('click', () => {
            // The view is shown at once (Desktop with its last layout, Model with its camera); the
            // menu opens too, to choose another layout / camera (Model only with several cameras)
            this._handlers.onSelectView(/** @type {EditorView} */ (button.dataset.view));
            if (button.dataset.view === 'desktop') this._showLayoutMenu(button);
            if (button.dataset.view === 'model' && button.classList.contains('toolbar__view--menu')) this._showCameraMenu(button);
        }));
        this._slider.max = String(SLIDER_MAX);
        this._slider.addEventListener('pointerdown', () => this._isSeeking = true);
        this._slider.addEventListener('change', () => this._isSeeking = false);
        this._slider.addEventListener('input', () => {
            this._handlers.onSeek(Number(this._slider.value) / SLIDER_MAX);
        });
    }

    /**
     * @param {boolean} enabled
     */
    setOrbit(enabled) {
        this._orbitButton.classList.toggle('player__button--active', enabled);
        this._orbitButton.title = enabled ? 'Stop auto-orbit' : 'Start auto-orbit';
    }

    /**
     * @param {boolean} playing
     */
    setPlaying(playing) {
        const icon = this._playButton.querySelector('.codicon');
        icon?.classList.toggle('codicon-play', !playing);
        icon?.classList.toggle('codicon-debug-pause', playing);
        this._playButton.title = playing ? 'Pause animation' : 'Play animation';
    }

    /**
     * Updates the slider unless the user is dragging it.
     * @param {number} progress position in [0, 1]
     */
    setProgress(progress) {
        if (this._isSeeking) return;
        this._slider.value = String(Math.round(progress * SLIDER_MAX));
    }

    /**
     * Shows the name of the current clip (clips are picked in the model tree), of the mesh and of
     * the skeleton it animates; the animation controls are hidden when the model has no animations.
     * @param {string | null} name null when there is no clip
     * @param {{ icon?: string, skeleton?: string | null, mesh?: string | null, meshTitle?: string }} [rig]
     *   icon - codicon of the clip, as in the model tree; skeleton - null when the clip animates no
     *   skeleton (nodes only); mesh - null when the skeleton deforms no mesh; meshTitle - its tooltip
     */
    setClip(name, { icon = 'play-circle', skeleton = null, mesh = null, meshTitle = '' } = {}) {
        this._clipName.textContent = name ?? '';
        this._clipIcon.className = `codicon codicon-${icon}`;
        this._clipTag.title = name ? `Current animation: ${name}` : '';
        this._clipTag.classList.toggle('player__tag--hidden', name === null);
        Toolbar._setTag(this._meshTag, this._meshName, name !== null ? mesh : null, meshTitle);
        Toolbar._setTag(this._skeletonTag, this._skeletonName, name !== null ? skeleton : null, `Skeleton of the current animation: ${skeleton}`);
        this._animationGroup.classList.toggle('player__animation--hidden', name === null);
    }

    /**
     * Makes the Model button a menu of cameras when the model view can be shown with more than one.
     * @param {number} count the cameras the model view can be shown with
     */
    setCameraCount(count) {
        const button = this._viewButtons.find(candidate => candidate.dataset.view === 'model');
        if (!button) return;
        button.classList.toggle('toolbar__view--menu', count > 1);
        button.title = count > 1 ? 'Show only the model, and choose its camera…' : 'Show only the model';
    }

    /**
     * Shows the icon of the layout of the desktop view on its button.
     * @param {ViewLayout} layout the layout shown
     * @param {number} [maxCount] the most camera views the menu offers (fewer in a low editor)
     */
    setDesktopLayout(layout, maxCount = 4) {
        this._layout = layout;
        this._maxCount = maxCount;
        const icon = this._viewButtons.find(candidate => candidate.dataset.view === 'desktop')?.querySelector('.toolbar__view-icon');
        if (icon) icon.innerHTML = layoutIcon(layout);
    }

    /**
     * @param {HTMLElement} button the Desktop button
     */
    _showLayoutMenu(button) {
        const { left, bottom } = button.getBoundingClientRect();
        const layouts = LAYOUTS.filter(layout => layout.count <= (this._maxCount ?? 4));
        const actions = layouts.map(layout => ({
            label: `Inspector on the ${layout.side}, ${layout.count} camera view${layout.count > 1 ? 's' : ''}`,
            svg: layoutIcon(layout),
            isActive: () => this._layout?.side === layout.side && this._layout?.count === layout.count,
            run: () => this._handlers.onSelectLayout(layout),
        }));
        // One line per side of the inspector
        this._cameraMenu.show(left, bottom + 2, actions, { isDisabled: () => false, run: action => action.run(), columns: layouts.length / 2 });
    }

    /**
     * @param {HTMLElement} button the Model button
     */
    _showCameraMenu(button) {
        const { left, bottom } = button.getBoundingClientRect();
        const actions = this._handlers.cameras().map(camera => ({
            label: camera.label,
            title: camera.description ? `${camera.label} (${camera.description})` : camera.label,
            icon: camera.active ? 'check' : 'device-camera',
            run: () => this._handlers.onSelectCamera(camera.id),
        }));
        this._cameraMenu.show(left, bottom + 2, actions, { isDisabled: () => false, run: action => action.run() });
    }

    /**
     * @param {HTMLElement} tag
     * @param {HTMLElement} label
     * @param {string | null} text null hides the tag
     * @param {string} title
     */
    static _setTag(tag, label, text, title) {
        label.textContent = text ?? '';
        tag.title = text === null ? '' : title;
        tag.classList.toggle('player__tag--hidden', text === null);
    }

    /**
     * @param {RenderMode} mode
     */
    setRenderMode(mode) {
        this._modeButtons.forEach(button => button.classList.toggle('player__button--active', button.dataset.mode === mode));
    }

    /**
     * @param {CursorMode} mode
     * @param {import('./TransformEditing').TransformTool} tool shown in the edit mode
     * @param {boolean} local the gizmo takes the local axes
     */
    setCursor(mode, tool, local) {
        this._localButton.hidden = mode !== 'edit';
        this._localButton.classList.toggle('toolbar__button--active', local);
        this._localButton.title = local
            ? 'Local axes (X): the gizmo takes the axes of the first selected bone, or of the mesh — click for the world axes'
            : 'World axes (X): click for the local axes of the first selected bone, or of the mesh';
        this._cursorButtons.forEach(button => button.classList.toggle('toolbar__button--active', button.dataset.cursor === mode));
        this._toolButtons.forEach((button) => {
            button.classList.toggle('toolbar__button--active', button.dataset.tool === tool);
            button.hidden = mode !== 'edit';
        });
    }

    /**
     * Reflects what the selected view shows over the model.
     * @param {Partial<Record<ViewOverlay, boolean>>} shown
     */
    setOverlays(shown) {
        Object.entries(this._overlayButtons).forEach(([key, button]) => {
            if (!button) return;
            const on = !!shown[key];
            button.classList.toggle('player__button--active', on);
            button.title = OVERLAYS[key][on ? 1 : 0];
        });
    }

    /**
     * Marks the shown view; Desktop is hidden while the editor has no room for both parts.
     * @param {EditorView} shown
     * @param {boolean} noRoom the model and the inspector do not fit side by side
     */
    setLayout(shown, noRoom) {
        for (const button of this._viewButtons) {
            button.classList.toggle('toolbar__view--hidden', button.dataset.view === 'desktop' && noRoom);
            button.classList.toggle('toolbar__view--active', button.dataset.view === shown);
        }
    }

    /**
     * Shows the mesh / bones toggles while a skeleton is shown or the current clip animates one,
     * and reflects what the view shows: outside the skeleton mode the mesh is shown, the bones not.
     * @param {{ available: boolean, active: boolean, display: import('./SelectionHighlighter').SkeletonDisplay }} state
     *   available - the current clip animates a skeleton; active - the skeleton mode is on
     * @returns {boolean} whether the toggles were shown or hidden (the player changed its width)
     */
    setSkeletonMode({ available, active, display }) {
        const visible = available || active;
        const changed = this._skeletonGroup.classList.contains('player__group--hidden') === visible;
        this._skeletonGroup.classList.toggle('player__group--hidden', !visible);
        const mesh = active ? display.mesh : true;
        const bones = active && display.bones;
        this._meshButton.classList.toggle('player__button--active', mesh);
        this._meshButton.title = mesh ? (active ? 'Hide mesh' : 'Hide mesh, show the bones') : 'Show mesh';
        this._bonesButton.classList.toggle('player__button--active', bones);
        this._bonesButton.title = bones ? 'Hide bones' : 'Show bones';
        return changed;
    }
}
