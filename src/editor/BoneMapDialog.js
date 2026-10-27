/** @typedef {import('./ModelEdits').BoneMapEntry} BoneMapEntry */

/** The value of the select that leaves a bone out. */
const LEAVE_OUT = '';

/**
 * A modal dialog over the editor that maps the bones of a pasted clip onto the bones of a skeleton:
 * one line per clip bone (indented by its depth) with a select of "Leave out" and the bones of the
 * skeleton no other line took, in the order of the skeleton. Lines without a bone are marked.
 */
export class BoneMapDialog {

    /**
     * @param {HTMLElement} root the editor root
     */
    constructor(root) {
        this._root = root;
        /** @type {HTMLElement | null} */
        this._element = null;
    }

    /**
     * @param {{ title: string, sources: BoneMapEntry[], targets: { name: string }[], mapping: Record<string, string | null> }} request
     * @returns {Promise<Record<string, string | null> | null>} the mapping, null when cancelled
     */
    show({ title, sources, targets, mapping }) {
        this._close();
        const chosen = new Map(sources.map(source => [source.name, mapping[source.name] ?? null]));
        const element = document.createElement('div');
        element.className = 'bone-map';
        element.tabIndex = -1;
        const box = document.createElement('div');
        box.className = 'bone-map__box';
        const heading = document.createElement('div');
        heading.className = 'bone-map__title';
        heading.textContent = title;
        const count = document.createElement('div');
        count.className = 'bone-map__count';
        const list = document.createElement('div');
        list.className = 'bone-map__list';
        const buttons = document.createElement('div');
        buttons.className = 'bone-map__buttons';
        const paste = document.createElement('button');
        paste.className = 'bone-map__button bone-map__button--primary';
        paste.textContent = 'Paste';
        const cancel = document.createElement('button');
        cancel.className = 'bone-map__button';
        cancel.textContent = 'Cancel';
        buttons.append(paste, cancel);
        box.append(heading, count, list, buttons);
        element.append(box);

        const selects = sources.map((source) => {
            const line = document.createElement('label');
            line.className = 'bone-map__line';
            const name = document.createElement('span');
            name.className = 'bone-map__name';
            name.style.paddingLeft = `${source.depth * 12}px`;
            name.textContent = source.name;
            name.title = source.name;
            const select = document.createElement('select');
            select.className = 'bone-map__select';
            select.addEventListener('change', () => {
                chosen.set(source.name, select.value === LEAVE_OUT ? null : select.value);
                update();
            });
            line.append(name, select);
            list.append(line);
            return { source, line, select };
        });
        // Each select lists the bones no other line took
        const update = () => {
            const taken = new Set([...chosen.values()].filter(Boolean));
            for (const { source, line, select } of selects) {
                const own = chosen.get(source.name);
                select.replaceChildren(new Option('— Leave out —', LEAVE_OUT), ...targets
                    .filter(target => target.name === own || !taken.has(target.name))
                    .map(target => new Option(target.name, target.name)));
                select.value = own ?? LEAVE_OUT;
                line.classList.toggle('bone-map__line--left-out', !own);
            }
            const mapped = [...chosen.values()].filter(Boolean).length;
            count.textContent = `${mapped} of ${sources.length} bones mapped; bones left out are not pasted`;
        };
        update();

        return new Promise((resolve) => {
            const finish = (result) => {
                this._close();
                resolve(result);
            };
            paste.addEventListener('click', () => finish(Object.fromEntries(chosen)));
            cancel.addEventListener('click', () => finish(null));
            element.addEventListener('keydown', (event) => {
                if (event.key === 'Escape') finish(null);
                else if (event.key === 'Enter' && event.target === element) finish(Object.fromEntries(chosen));
            });
            this._root.append(element);
            this._element = element;
            element.focus();
        });
    }

    _close() {
        this._element?.remove();
        this._element = null;
    }
}
