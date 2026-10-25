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
 */

/** @typedef {'textured' | 'solid' | 'wireframe'} RenderMode */

/** @typedef {'model' | 'inspector' | 'desktop'} EditorView */

const SLIDER_MAX = 1000;

/**
 * Binds the controls rendered by BabylonEditor._getHtmlForWebview to editor actions and reflects
 * the editor state back into them: the toolbar above (view switch) and the player
 * in the model view (render modes, skeleton mesh / bones toggles, reset view, auto-orbit, play / pause, seek slider, the name of the current clip).
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
        this._playButton = root.querySelector('.player__play');
        /** @type {HTMLInputElement} */
        this._slider = root.querySelector('.player__slider');
        this._clipName = root.querySelector('.player__clip');
        this._skeletonName = root.querySelector('.player__skeleton-name');
        this._skeletonTag = root.querySelector('.player__skeleton');
        this._skeletonGroup = root.querySelector('.player__group--skeleton');
        this._meshButton = root.querySelector('.player__mesh');
        this._bonesButton = root.querySelector('.player__bones');
        /** @type {HTMLButtonElement[]} */
        this._viewButtons = [...root.querySelectorAll('.toolbar__view')];
        /** @type {HTMLButtonElement[]} */
        this._modeButtons = [...root.querySelectorAll('.player__mode')];
        this._isSeeking = false;
        this._bindEvents();
    }

    _bindEvents() {
        this._orbitButton.addEventListener('click', () => this._handlers.onToggleOrbit());
        this._resetButton.addEventListener('click', () => this._handlers.onResetView());
        this._playButton.addEventListener('click', () => this._handlers.onTogglePlay());
        this._meshButton.addEventListener('click', () => this._handlers.onToggleMesh());
        this._bonesButton.addEventListener('click', () => this._handlers.onToggleBones());
        this._modeButtons.forEach(button => button.addEventListener('click', () => {
            this._handlers.onSelectRenderMode(/** @type {RenderMode} */ (button.dataset.mode));
        }));
        this._viewButtons.forEach(button => button.addEventListener('click', () => {
            this._handlers.onSelectView(/** @type {EditorView} */ (button.dataset.view));
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
     * Shows the name of the current clip (clips are picked in the model tree) and of the skeleton
     * it animates; the animation controls are hidden when the model has no animations.
     * @param {string | null} name null when there is no clip
     * @param {string | null} [skeleton] null when the clip animates no skeleton (nodes only)
     */
    setClip(name, skeleton = null) {
        this._clipName.textContent = name ?? '';
        this._clipName.title = name ? `Current animation: ${name}` : '';
        this._clipName.classList.toggle('player__tag--hidden', name === null);
        const showSkeleton = name !== null && skeleton !== null;
        this._skeletonName.textContent = showSkeleton ? skeleton : '';
        this._skeletonTag.title = showSkeleton ? `Skeleton of the current animation: ${skeleton}` : '';
        this._skeletonTag.classList.toggle('player__tag--hidden', !showSkeleton);
        this._animationGroup.classList.toggle('player__animation--hidden', name === null);
    }

    /**
     * @param {RenderMode} mode
     */
    setRenderMode(mode) {
        this._modeButtons.forEach(button => button.classList.toggle('player__button--active', button.dataset.mode === mode));
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
     * Shows the mesh / bones toggles while a skeleton is shown and reflects their state.
     * @param {boolean} active whether the skeleton mode is on
     * @param {import('./SelectionHighlighter').SkeletonDisplay} display
     */
    setSkeletonMode(active, display) {
        this._skeletonGroup.classList.toggle('player__group--hidden', !active);
        this._meshButton.classList.toggle('player__button--active', display.mesh);
        this._meshButton.title = display.mesh ? 'Hide mesh' : 'Show mesh';
        this._bonesButton.classList.toggle('player__button--active', display.bones);
        this._bonesButton.title = display.bones ? 'Hide bones' : 'Show bones';
    }
}
