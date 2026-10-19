/**
 * A menu of actions shown at a point (a click on an image of the inspector). Items are
 * `PanelAction`s: the label is the item text, the title its tooltip; an action with `colors` gets
 * color swatches and a color picker at the end of its line, which change the color without closing
 * the menu. The menu closes when an item is chosen, on Escape, on a click outside it, when the
 * view scrolls or is resized.
 */
export class PopupMenu {

    constructor() {
        /** @type {HTMLElement | null} */
        this._element = null;
        this._close = () => this.close();
        // The native picker of a color input takes the focus from the window: the menu stays open
        this._onBlur = () => {
            if (!(document.activeElement instanceof HTMLInputElement && document.activeElement.type === 'color')) this.close();
        };
        this._onPointerDown = (event) => {
            if (!this._element?.contains(/** @type {Node} */ (event.target))) this.close();
        };
        this._onKeyDown = (event) => this._handleKey(event);
    }

    /**
     * @param {number} x client coordinates of the top left corner
     * @param {number} y
     * @param {import('./PropertyPanel').PanelAction[]} actions
     * @param {object} options
     * @param {(action: import('./PropertyPanel').PanelAction) => boolean} options.isDisabled
     * @param {(action: import('./PropertyPanel').PanelAction) => void} options.run runs a chosen item
     * @param {() => void} [options.onChange] a color of an item was changed
     */
    show(x, y, actions, { isDisabled, run, onChange }) {
        this.close();
        const read = value => typeof value === 'function' ? value() : value;
        const menu = document.createElement('div');
        menu.className = 'popup-menu';
        menu.setAttribute('role', 'menu');
        for (const action of actions) {
            if (action.isHidden?.()) continue;
            const item = document.createElement('button');
            item.className = 'popup-menu__item';
            item.setAttribute('role', 'menuitem');
            const icon = document.createElement('i');
            icon.className = `codicon codicon-${read(action.icon)}`;
            const label = read(action.label);
            item.append(icon, document.createTextNode(label));
            item.title = read(action.title) ?? label;
            item.disabled = isDisabled(action);
            item.addEventListener('click', () => {
                this.close();
                run(action);
            });
            if (action.colors?.length && action.setColor) {
                const line = document.createElement('div');
                line.className = 'popup-menu__line';
                line.append(item, this._renderColors(action, () => onChange?.()));
                menu.append(line);
            } else {
                menu.append(item);
            }
        }
        document.body.append(menu);
        this._element = menu;
        // Kept inside the view: opened to the left / above the point when there is no room
        const { width, height } = menu.getBoundingClientRect();
        menu.style.left = `${Math.max(0, Math.min(x, window.innerWidth - width))}px`;
        menu.style.top = `${Math.max(0, y + height > window.innerHeight ? y - height : y)}px`;
        menu.querySelector('button:not(:disabled)')?.focus();
        document.addEventListener('pointerdown', this._onPointerDown, true);
        document.addEventListener('keydown', this._onKeyDown, true);
        document.addEventListener('scroll', this._close, true);
        window.addEventListener('resize', this._close);
        window.addEventListener('blur', this._onBlur);
    }

    /**
     * Preset swatches and a picker of any color; the current color is marked.
     * @param {import('./PropertyPanel').PanelAction} action
     * @param {() => void} onChange
     * @returns {HTMLElement}
     */
    _renderColors(action, onChange) {
        const element = document.createElement('div');
        element.className = 'popup-menu__colors';
        const picker = document.createElement('input');
        picker.type = 'color';
        picker.className = 'popup-menu__picker';
        picker.title = 'Choose a color';
        const swatches = action.colors.map(({ value, label }) => {
            const swatch = document.createElement('button');
            swatch.className = 'popup-menu__swatch';
            swatch.style.background = value;
            swatch.title = label;
            swatch.addEventListener('click', () => choose(value));
            return { swatch, value };
        });
        const mark = () => {
            const current = action.color?.()?.toLowerCase();
            swatches.forEach(({ swatch, value }) => swatch.classList.toggle('popup-menu__swatch--selected', value.toLowerCase() === current));
            if (current && /^#[0-9a-f]{6}$/.test(current)) picker.value = current;
        };
        const choose = (value) => {
            action.setColor(value);
            mark();
            onChange();
        };
        picker.addEventListener('input', () => choose(picker.value));
        mark();
        element.append(...swatches.map(({ swatch }) => swatch), picker);
        return element;
    }

    close() {
        if (!this._element) return;
        this._element.remove();
        this._element = null;
        document.removeEventListener('pointerdown', this._onPointerDown, true);
        document.removeEventListener('keydown', this._onKeyDown, true);
        document.removeEventListener('scroll', this._close, true);
        window.removeEventListener('resize', this._close);
        window.removeEventListener('blur', this._onBlur);
    }

    /**
     * Escape closes the menu, the arrow keys move between the enabled items.
     * @param {KeyboardEvent} event
     */
    _handleKey(event) {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            this.close();
            return;
        }
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        const items = [...this._element.querySelectorAll('button:not(:disabled)')];
        if (!items.length) return;
        const index = items.indexOf(/** @type {HTMLElement} */ (document.activeElement));
        const step = event.key === 'ArrowDown' ? 1 : -1;
        /** @type {HTMLElement} */ (items[(index + step + items.length) % items.length]).focus();
    }
}
