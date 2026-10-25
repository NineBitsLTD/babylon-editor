/**
 * How a selection rectangle changes the selection: Shift adds, Option / Alt takes out, else it replaces.
 * @typedef {'replace' | 'add' | 'remove'} SelectionMode
 */

/** A drag shorter than this (CSS pixels) is a click, as Babylon tells taps from drags. */
const DRAG_THRESHOLD = 10;

/**
 * @param {{ shiftKey: boolean, altKey: boolean }} event
 * @returns {SelectionMode}
 */
export function selectionMode(event) {
    if (event.altKey) return 'remove';
    return event.shiftKey ? 'add' : 'replace';
}

/**
 * Draws a selection rectangle over the canvas while the left button is dragged (when enabled) and
 * reports it when the button is released. A short drag stays a click.
 */
export class BoxSelection {

    /**
     * @param {HTMLElement} viewport the element holding the canvas
     * @param {HTMLCanvasElement} canvas
     * @param {(rect: import('./ScreenSelection').ScreenRect, mode: SelectionMode) => void} onSelect
     *   the rectangle in CSS pixels of the canvas
     * @param {() => boolean} [canStart] false: the button is pressed on something else (a gizmo)
     */
    constructor(viewport, canvas, onSelect, canStart = () => true) {
        this._canvas = canvas;
        this._onSelect = onSelect;
        this._canStart = canStart;
        this.enabled = false;
        this._box = document.createElement('div');
        this._box.className = 'box-selection';
        this._box.hidden = true;
        viewport.append(this._box);
        canvas.addEventListener('pointerdown', event => this._start(event));
    }

    /**
     * @param {PointerEvent} event
     */
    _start(event) {
        if (!this.enabled || event.button !== 0 || !this._canStart()) return;
        const bounds = this._canvas.getBoundingClientRect();
        const start = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
        let rect = null;
        const move = (moveEvent) => {
            const x = moveEvent.clientX - bounds.left, y = moveEvent.clientY - bounds.top;
            if (!rect && Math.hypot(x - start.x, y - start.y) < DRAG_THRESHOLD) return;
            rect = { left: Math.min(start.x, x), top: Math.min(start.y, y), right: Math.max(start.x, x), bottom: Math.max(start.y, y) };
            Object.assign(this._box.style, {
                left: `${this._canvas.offsetLeft + rect.left}px`,
                top: `${this._canvas.offsetTop + rect.top}px`,
                width: `${rect.right - rect.left}px`,
                height: `${rect.bottom - rect.top}px`,
            });
            this._box.hidden = false;
        };
        const end = (endEvent) => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', end);
            window.removeEventListener('pointercancel', end);
            this._box.hidden = true;
            if (rect && endEvent.type === 'pointerup') this._onSelect(rect, selectionMode(endEvent));
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', end);
        window.addEventListener('pointercancel', end);
    }
}
