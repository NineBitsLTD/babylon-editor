/**
 * Lets the user resize a side panel by dragging a splitter. The panel sits to the right of the
 * splitter, or to its left (`side`); its width is clamped so the neighbouring area keeps
 * at least `minRest` pixels. Double click restores the default width.
 */
export class PanelResizer {

    /**
     * @param {HTMLElement} splitter drag handle
     * @param {HTMLElement} panel resized element (its flex-basis is set)
     * @param {object} options
     * @param {number} options.defaultWidth
     * @param {number} [options.width] initial width, e.g. restored from the webview state
     * @param {number} [options.minWidth]
     * @param {number} [options.minRest] minimal width left for the rest of the container
     * @param {(width: number) => void} [options.onChange] called when a drag ends
     */
    constructor(splitter, panel, { defaultWidth, width = defaultWidth, minWidth = 240, minRest = 200, onChange }) {
        /** @type {'left' | 'right'} side of the panel: dragging the splitter towards it narrows it */
        this.side = 'right';
        this._splitter = splitter;
        this._panel = panel;
        this._defaultWidth = defaultWidth;
        this._minWidth = minWidth;
        this._minRest = minRest;
        this._onChange = onChange;
        this.setWidth(width);
        this._bindEvents();
    }

    /**
     * @param {number} width requested width in px (clamped)
     */
    setWidth(width) {
        this.width = this._clamp(width);
        this._panel.style.flexBasis = `${this.width}px`;
    }

    _bindEvents() {
        this._splitter.addEventListener('pointerdown', (event) => {
            event.preventDefault();
            try {
                // Keeps receiving moves while the pointer is over the canvas or outside the webview
                this._splitter.setPointerCapture(event.pointerId);
            } catch {
                // Not an active pointer (e.g. a synthetic event); dragging still works over the splitter
            }
            this._splitter.classList.add('splitter--active');
            const startX = event.clientX;
            const startWidth = this._panel.getBoundingClientRect().width;
            const move = (moveEvent) => this.setWidth(startWidth + (this.side === 'left' ? moveEvent.clientX - startX : startX - moveEvent.clientX));
            const end = () => {
                this._splitter.removeEventListener('pointermove', move);
                this._splitter.removeEventListener('pointerup', end);
                this._splitter.removeEventListener('pointercancel', end);
                this._splitter.classList.remove('splitter--active');
                this._onChange?.(this.width);
            };
            this._splitter.addEventListener('pointermove', move);
            this._splitter.addEventListener('pointerup', end);
            this._splitter.addEventListener('pointercancel', end);
        });
        this._splitter.addEventListener('dblclick', () => {
            this.setWidth(this._defaultWidth);
            this._onChange?.(this.width);
        });
    }

    /**
     * @param {number} width
     * @returns {number}
     */
    _clamp(width) {
        const container = this._panel.parentElement?.getBoundingClientRect().width || Infinity;
        const max = Math.max(this._minWidth, container - this._minRest);
        return Math.round(Math.min(max, Math.max(this._minWidth, width)));
    }
}
