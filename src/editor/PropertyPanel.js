import { CurveTable } from './CurveTable';
import { DataTable, formatNumber } from './DataTable';
import { PopupMenu } from './PopupMenu';

/** Groups that start collapsed. */
const COLLAPSED_BY_DEFAULT = new Set(['Other file fields']);

/**
 * @typedef {'text' | 'number' | 'vector' | 'color' | 'boolean' | 'select' | 'readonly' | 'image' | 'section'} PropertyType
 *   'image' - a preview of the image whose url `get` returns, or resolves to (hidden while there is none)
 *   'section' - starts a collapsible group of properties titled `label` (the properties before the
 *   first section are the "Properties" group)
 */

/**
 * Describes one editable (or read-only) property. Values are plain data (numbers, strings,
 * number arrays for vectors, hex strings for colors) so they can be stored in undo commands.
 * @typedef {object} PropertyDescriptor
 * @property {string} label
 * @property {PropertyType} type
 * @property {() => any} get
 * @property {(value: any) => void} [set] absent for read-only properties
 * @property {() => any} [capture] exact state snapshot for undo (defaults to get)
 * @property {(state: any) => void} [restore] restores a captured snapshot (defaults to set)
 * @property {string[]} [components] component labels for 'vector'
 * @property {() => { value: string, label: string, disabled?: boolean }[]} [options] for 'select' (a disabled option is shown but cannot be chosen)
 * @property {PanelAction} [action] a small button after the value (e.g. open the chosen object)
 * @property {boolean} [nullable] an empty 'number' input means null
 * @property {boolean} [transient] editor state, not a model change (not recorded for undo)
 * @property {() => boolean} [isUnset] the file has no value for it yet (shown dimmed; setting a value adds it)
 * @property {PanelAction[]} [menu] for 'image': commands shown in a menu by a click on the image
 * @property {() => (string | null | Promise<string | null>)} [overlay] for 'image': url of an image laid
 *   over it at its size (e.g. the UV layout of a texture), read on refresh; null shows none
 */

/**
 * @typedef {object} PanelAction
 * @property {string | (() => string)} label short button text; a function is re-read on refresh (e.g. Play / Pause)
 * @property {string | (() => string)} [title] full description shown as the tooltip (defaults to the label)
 * @property {string | (() => string)} icon codicon name without the prefix; a function is re-read on refresh
 * @property {() => void} run
 * @property {() => boolean} [isDisabled]
 * @property {() => boolean} [isActive] a toggle: shown pressed while it returns true
 * @property {() => boolean} [isHidden]
 * @property {boolean} [transient] does not change the model, so it stays enabled for view-only formats
 * @property {{ value: string, label: string }[]} [colors] preset colors (hex) shown with a color picker
 *   next to the item of a menu (`PopupMenu`), e.g. the color of the UV layout
 * @property {() => string} [color] the current color
 * @property {string | (() => string)} [svg] markup of an icon drawn by the editor, used instead of
 *   the codicon in a `PopupMenu`
 * @property {(color: string) => void} [setColor]
 */

/**
 * An entry of a PanelList: a header line that opens the entry's own properties and actions.
 * @typedef {object} PanelListItem
 * @property {() => string} label read on refresh (renames)
 * @property {() => string} [description] secondary text after the label
 * @property {string} [icon] codicon name without the prefix
 * @property {PanelAction} [toggle] a small button at the end of the header line (e.g. hide a part
 *   in the 3D view); it does not open the entry
 * @property {() => boolean} [isHidden] the entry is left out of the list (re-read on refresh, e.g.
 *   after the toggle of its list)
 * @property {() => PropertyDescriptor[]} properties created when the entry is opened
 * @property {PanelAction[]} [actions] buttons under the properties of the opened entry
 * @property {() => void} [onOpen]
 * @property {() => void} [onClose]
 */

/**
 * A collapsible group of entries shown as an accordion: opening an entry closes the one open
 * before (one open entry per inspector, in any list).
 * @typedef {object} PanelList
 * @property {string} title
 * @property {PanelListItem[]} items
 * @property {PanelAction} [toggle] a small button at the end of the group heading (e.g. show the
 *   entries it hides); the panel is refreshed after it runs
 */

/**
 * @typedef {object} PanelContent
 * @property {string} title object kind
 * @property {string | (() => string)} [subtitle] object name; a function is re-read on refresh (renames)
 * @property {() => void} [back] shows a back button in the header (to the file view)
 * @property {string} [notice] informational line shown above the properties
 * @property {PropertyDescriptor[]} [properties]
 * @property {boolean} [twoColumns] properties flow into two label/value columns when the panel is wide enough
 * @property {PanelAction[]} [actions]
 * @property {PanelList[]} [lists] accordion groups shown after the main properties (e.g. the nodes and parts of a mesh)
 * @property {import('./DataTable').TableData & {
 *   onSelectRow?: (row: number) => void,
 *   onSelectRows?: (rows: number[]) => void,
 *   poseEdit?: import('./TransformEditing').PoseEdit,
 *   rowOf?: (object: any) => number,
 *   title?: string,
 *   notice?: string | (() => string),
 *   noticeWarning?: () => boolean,
 *   modes?: { key: string, label: string }[],
 *   setMode?: (key: string) => void,
 *   actions?: PanelAction[]
 * }} [table] title - heading of the table group (e.g. Bones, Vertices);
 *   rowOf - record of a model object (e.g. a bone picked in the 3D view), or -1;
 *   notice - hint shown under the switches in the table view only (a function is re-read on refresh;
 *   noticeWarning styles it as a warning);
 *   modes / setMode - a switch of what the table shows (e.g. Rest | Bind pose), remembered like the groups;
 *   actions - buttons shown next to the mode switch
 * @property {import('./CurveTable').CurveData} [curves] graph view of the same records (a Table / Graph switch is shown)
 */

/**
 * Inspector panel: renders property editors for the selected object, optional actions
 * and an optional data table. It does not modify objects itself - every change is reported
 * through the commit callbacks so the editor can record it in the undo history.
 */
export class PropertyPanel {

    /**
     * @param {HTMLElement} element container element
     * @param {{
     *   onCommit: (property: PropertyDescriptor, newValue: any) => void,
     *   onCellCommit: (column: import('./DataTable').TableColumn, row: number, oldValue: number | string, newValue: number | string) => void,
     *   onCurveCommit: (data: import('./CurveTable').CurveData, row: number, label: string, before: any, after: any) => void
     * }} handlers
     */
    constructor(element, handlers) {
        this._element = element;
        this._handlers = handlers;
        this._readOnly = false;
        /** @type {PanelContent | null} */
        this._content = null;
        /** @type {(() => void)[]} */
        this._updaters = [];
        /** @type {DataTable | null} */
        this._table = null;
        this._tableRowSelectHandler = null;
        /** Chosen column group per set of table groups, so it survives switching objects. */
        this._tableGroups = new Map();
        /** @type {'table' | 'graph'} view of content with curves, kept while switching objects */
        this._view = 'table';
        /** @type {HTMLElement | null} */
        this._viewElement = null;
        /** @type {HTMLElement | null} */
        this._tableNotice = null;
        /** @type {Map<string, boolean>} collapsed state per group title (kept while switching objects) */
        this._collapsedGroups = new Map();
        /** Chosen table mode per set of modes. */
        this._tableModes = new Map();
        /** @type {{ button: HTMLButtonElement, action: PanelAction }[]} */
        this._actionButtons = [];
        /**
         * The open accordion entry; its editors are kept apart, so closing it drops them.
         * @type {{ element: HTMLElement, item: PanelListItem, updaters: (() => void)[], actionButtons: { button: HTMLButtonElement, action: PanelAction }[] } | null}
         */
        this._openEntry = null;
        /**
         * The open entry by its list and label, so it opens again when the same object is shown
         * anew (e.g. after the model was reloaded from the text).
         * @type {{ subtitle: string, list: string, label: string } | null}
         */
        this._openKey = null;
        this._menu = new PopupMenu();
        this.clear();
    }

    clear() {
        this._menu.close();
        this._content = null;
        this._openEntry = null;
        this._updaters = [];
        this._actionButtons = [];
        this._table = null;
        const empty = document.createElement('div');
        empty.className = 'inspector__empty';
        empty.textContent = 'Select an item in the model tree';
        this._element.replaceChildren(empty);
    }

    /**
     * Disables all editors (used for formats that cannot be saved).
     * @param {boolean} readOnly
     */
    setReadOnly(readOnly) {
        this._readOnly = readOnly;
        if (this._content) this.show(this._content);
    }

    /**
     * @param {PanelContent} content
     */
    show(content) {
        this._menu.close();
        this._content = content;
        this._updaters = [];
        this._actionButtons = [];
        this._openEntry = null;
        this._table = null;

        const header = document.createElement('div');
        header.className = 'inspector__header';
        const title = document.createElement('div');
        title.className = 'inspector__title';
        title.textContent = content.title;
        header.append(title);
        if (content.subtitle) {
            const subtitle = document.createElement('div');
            subtitle.className = 'inspector__subtitle';
            subtitle.textContent = this._subtitleText();
            header.append(subtitle);
        }
        // Kind on the left, name in the middle, back to the file view on the right
        if (content.back) {
            const back = document.createElement('button');
            back.className = 'inspector__back';
            back.title = 'Back to the file';
            back.innerHTML = '<i class="codicon codicon-arrow-left"></i>';
            back.addEventListener('click', () => content.back());
            header.append(back);
        }
        // Everything below the header scrolls; the header stays in place
        const children = [];

        if (content.notice) {
            const notice = document.createElement('div');
            notice.className = 'inspector__notice';
            notice.textContent = content.notice;
            children.push(notice);
        }
        // Collapsible groups: the main properties, the lists, the other file fields, the table
        // (headings only when there is more than one group)
        const groups = this._groupProperties(content.properties ?? []);
        const lists = (content.lists ?? []).filter(list => list.items.length);
        const headings = groups.length + lists.length + (content.table ? 1 : 0) > 1;
        const pushLists = () => lists.forEach((list) => {
            const element = this._renderList(list);
            if (headings) children.push(this._renderGroupHeading(list.title, element, 'inspector__list--collapsed', list.toggle));
            children.push(element);
        });
        groups.forEach((group, index) => {
            const grid = document.createElement('div');
            grid.className = 'inspector__grid';
            grid.classList.toggle('inspector__grid--two-columns', !!content.twoColumns);
            group.properties.forEach(property => grid.append(...this._renderProperty(property)));
            if (headings) children.push(this._renderGroupHeading(group.label, grid, 'inspector__grid--collapsed'));
            children.push(grid);
            // The actions and the lists belong to the main properties
            if (index === 0 && content.actions?.length) children.push(this._renderActions(content.actions));
            if (index === 0) pushLists();
        });
        if (!groups.length && content.actions?.length) children.push(this._renderActions(content.actions));
        if (!groups.length) pushLists();
        if (content.table) {
            const area = this._renderTableArea(content);
            if (headings) children.push(this._renderGroupHeading(content.table.title ?? 'Table', area, 'inspector__data--collapsed'));
            children.push(area);
        }
        const body = document.createElement('div');
        body.className = 'inspector__body';
        body.append(...children);
        this._element.replaceChildren(header, body);
        if (content.table) this._showView();
    }

    /**
     * @param {PropertyDescriptor[]} properties
     * @returns {{ label: string, properties: PropertyDescriptor[] }[]} non-empty groups split at 'section' descriptors
     */
    _groupProperties(properties) {
        const groups = [{ label: 'Properties', properties: [] }];
        for (const property of properties) {
            if (property.type === 'section') groups.push({ label: property.label, properties: [] });
            else groups[groups.length - 1].properties.push(property);
        }
        return groups.filter(group => group.properties.length);
    }

    /**
     * A heading that collapses / expands a group; the choice is kept per group title.
     * @param {string} label
     * @param {HTMLElement} target the group content
     * @param {string} collapsedClass modifier hiding the content
     * @param {PanelAction} [toggle] a button at the end of the heading
     * @returns {HTMLElement}
     */
    _renderGroupHeading(label, target, collapsedClass, toggle) {
        const heading = document.createElement('button');
        heading.className = 'inspector__section';
        const icon = document.createElement('i');
        const text = document.createElement('span');
        text.className = 'inspector__section-label';
        text.textContent = label;
        heading.append(icon, text);
        if (toggle) {
            const button = this._renderEntryToggle(toggle, () => this.refresh());
            this._updaters.push(() => this._updateEntryToggle(button, toggle));
            heading.append(button);
        }
        const apply = () => {
            const collapsed = this._collapsedGroups.get(label) ?? COLLAPSED_BY_DEFAULT.has(label);
            icon.className = `codicon codicon-chevron-${collapsed ? 'right' : 'down'}`;
            heading.title = collapsed ? `Show ${label.toLowerCase()}` : `Hide ${label.toLowerCase()}`;
            target.classList.toggle(collapsedClass, collapsed);
        };
        heading.addEventListener('click', () => {
            this._collapsedGroups.set(label, !(this._collapsedGroups.get(label) ?? COLLAPSED_BY_DEFAULT.has(label)));
            apply();
        });
        apply();
        return heading;
    }

    /**
     * @param {PanelList} list
     * @returns {HTMLElement}
     */
    _renderList(list) {
        const element = document.createElement('div');
        element.className = 'inspector__list';
        element.append(...list.items.map(item => this._renderListItem(item, list.title)));
        return element;
    }

    /**
     * An accordion entry: the header line toggles its body.
     * @param {PanelListItem} item
     * @param {string} listTitle
     * @returns {HTMLElement}
     */
    _renderListItem(item, listTitle) {
        const element = document.createElement('div');
        element.className = 'inspector__entry';
        const header = document.createElement('button');
        header.className = 'inspector__entry-header';
        const chevron = document.createElement('i');
        chevron.className = 'codicon codicon-chevron-right';
        const label = document.createElement('span');
        label.className = 'inspector__entry-label';
        const description = document.createElement('span');
        description.className = 'inspector__entry-description';
        header.append(chevron);
        if (item.icon) {
            const icon = document.createElement('i');
            icon.className = `codicon codicon-${item.icon}`;
            header.append(icon);
        }
        header.append(label, description);
        const toggle = item.toggle ? this._renderEntryToggle(item.toggle) : null;
        if (toggle) header.append(toggle);
        const update = () => {
            const hidden = !!item.isHidden?.();
            element.hidden = hidden;
            if (hidden && this._openEntry?.element === element) this._closeEntry();
            label.textContent = item.label();
            description.textContent = item.description?.() ?? '';
            header.title = label.textContent;
            if (toggle) this._updateEntryToggle(toggle, item.toggle);
        };
        update();
        this._updaters.push(update);
        header.addEventListener('click', () => {
            const isOpen = this._openEntry?.element === element;
            this._closeEntry();
            this._openKey = null;
            if (isOpen) return;
            this._openEntry = this._openListItem(element, item);
            this._openKey = { subtitle: this._subtitleText(), list: listTitle, label: item.label() };
        });
        element.append(header);
        const key = this._openKey;
        if (key && !this._openEntry && !element.hidden && key.list === listTitle && key.label === item.label() && key.subtitle === this._subtitleText()) {
            this._openEntry = this._openListItem(element, item);
        }
        return element;
    }

    /**
     * @param {PanelAction} action
     * @param {() => void} [onRun] called after the action ran (e.g. to refresh what it changes)
     * @returns {HTMLElement} a button inside the header of an entry or a group (the header is a
     *   button too, so this is a span with the button role)
     */
    _renderEntryToggle(action, onRun) {
        const toggle = document.createElement('span');
        toggle.className = 'inspector__entry-toggle';
        toggle.setAttribute('role', 'button');
        toggle.addEventListener('click', (event) => {
            event.stopPropagation();
            action.run();
            this._updateEntryToggle(toggle, action);
            onRun?.();
        });
        this._updateEntryToggle(toggle, action);
        return toggle;
    }

    /**
     * @param {HTMLElement} toggle
     * @param {PanelAction} action
     */
    _updateEntryToggle(toggle, action) {
        const read = value => typeof value === 'function' ? value() : value;
        toggle.innerHTML = `<i class="codicon codicon-${read(action.icon)}"></i>`;
        toggle.title = read(action.title) ?? read(action.label);
        toggle.classList.toggle('inspector__entry-toggle--active', !!action.isActive?.());
    }

    /**
     * Renders the properties and actions of an entry; their updaters and buttons are collected
     * apart from those of the panel.
     * @param {HTMLElement} element
     * @param {PanelListItem} item
     */
    _openListItem(element, item) {
        const panelUpdaters = this._updaters;
        const panelButtons = this._actionButtons;
        this._updaters = [];
        this._actionButtons = [];
        const body = document.createElement('div');
        body.className = 'inspector__entry-body';
        const grid = document.createElement('div');
        grid.className = 'inspector__grid';
        item.properties().forEach(property => grid.append(...this._renderProperty(property)));
        body.append(grid);
        if (item.actions?.length) body.append(this._renderActions(item.actions));
        const entry = { element, item, updaters: this._updaters, actionButtons: this._actionButtons };
        this._updaters = panelUpdaters;
        this._actionButtons = panelButtons;
        element.append(body);
        element.classList.add('inspector__entry--open');
        element.querySelector('.inspector__entry-header .codicon').className = 'codicon codicon-chevron-down';
        item.onOpen?.();
        return entry;
    }

    _closeEntry() {
        const entry = this._openEntry;
        if (!entry) return;
        this._openEntry = null;
        entry.element.querySelector('.inspector__entry-body')?.remove();
        entry.element.classList.remove('inspector__entry--open');
        entry.element.querySelector('.inspector__entry-header .codicon').className = 'codicon codicon-chevron-right';
        entry.item.onClose?.();
    }

    /**
     * @param {PanelAction[]} actions
     * @returns {HTMLElement}
     */
    _renderActions(actions) {
        const element = document.createElement('div');
        element.className = 'inspector__actions';
        actions.forEach(action => element.append(this._renderAction(action)));
        return element;
    }

    /**
     * Switches (view, column group) and the container of the table or curve view.
     * @param {PanelContent} content
     * @returns {HTMLElement}
     */
    _renderTableArea(content) {
        const area = document.createElement('div');
        area.className = 'inspector__data';
        const switches = document.createElement('div');
        switches.className = 'inspector__switches';
        const modes = content.table.modes ?? [];
        if (modes.length > 1) {
            const signature = modes.map(mode => mode.key).join('|');
            const modeGroup = document.createElement('div');
            modeGroup.className = 'inspector__switch-group';
            modeGroup.append(this._renderSwitch(
                modes,
                () => this._tableMode(content.table),
                (key) => {
                    this._tableModes.set(signature, key);
                    content.table.setMode?.(key);
                    this.refresh();
                },
                label => `Show the ${label.toLowerCase()} values`,
            ));
            content.table.setMode?.(this._tableMode(content.table));
            (content.table.actions ?? []).forEach(action => modeGroup.append(this._renderAction(action)));
            switches.append(modeGroup);
        }
        const groups = content.table.groups ?? [];
        if (groups.length > 1) {
            const signature = groups.map(group => group.key).join('|');
            switches.append(this._renderSwitch(
                groups,
                () => this._tableGroup(content.table),
                (key) => {
                    this._tableGroups.set(signature, key);
                    this._table?.setGroup(key);
                },
                label => `Show ${label.toLowerCase()} values`,
            ));
        }
        if (content.curves) {
            switches.append(this._renderSwitch(
                [{ key: 'table', label: 'Table' }, { key: 'graph', label: 'Graph' }],
                () => this._view,
                (key) => {
                    this._view = key;
                    this._showView();
                },
                label => `${label} view`,
            ));
        }
        if (switches.childElementCount) area.append(switches);
        this._tableNotice = null;
        if (content.table.notice) {
            this._tableNotice = document.createElement('div');
            this._tableNotice.className = 'inspector__notice';
            this._updateTableNotice();
            area.append(this._tableNotice);
        }
        this._viewElement = document.createElement('div');
        this._viewElement.className = 'inspector__table';
        area.append(this._viewElement);
        return area;
    }

    /** Creates the table or the curve view of the current content in the view container. */
    _showView() {
        const content = this._content;
        const selectedRow = this._table?.selectedRow ?? -1;
        const selectedRows = this._table?.rows ?? [];
        const element = document.createElement('div');
        element.className = 'inspector__view';
        this._viewElement.replaceChildren(element);
        const onSelectRow = (row) => {
            content.table.onSelectRow?.(row);
            this.refreshActions();
        };
        const graph = !!content.curves && this._view === 'graph';
        this._tableNotice?.classList.toggle('inspector__notice--hidden', graph);
        if (graph) {
            this._table = new CurveTable(element, {
                onSelectRow,
                onSelectFrame: () => this.refresh(),
                onDragCommit: this._handlers.onCurveCommit,
            });
            this._table.setReadOnly(this._readOnly);
            this._table.setData(content.curves);
        } else {
            this._table = new DataTable(element, { onSelectRow, onSelectRows: rows => content.table.onSelectRows?.(rows), onCellCommit: this._handlers.onCellCommit });
            this._table.setReadOnly(this._readOnly);
            this._table.setData(content.table);
        }
        if (content.table.groups?.length > 1) this._table.setGroup(this._tableGroup(content.table));
        // The selected record survives switching the view
        if (selectedRow >= 0) {
            this._table.selectedRow = selectedRow;
            if (this._table instanceof DataTable) this._table.setSelection(selectedRows.length ? selectedRows : [selectedRow], selectedRow);
            this._table.refresh();
        }
    }

    _updateTableNotice() {
        const table = this._content?.table;
        const notice = table?.notice;
        this._tableNotice.textContent = typeof notice === 'function' ? notice() : notice ?? '';
        this._tableNotice.classList.toggle('inspector__notice--warning', !!table?.noticeWarning?.());
    }

    /**
     * Mode of a table with modes: the last choice for these modes, else the first mode.
     * @param {import('./DataTable').TableData & { modes: { key: string }[] }} table
     * @returns {string}
     */
    _tableMode(table) {
        const signature = table.modes.map(mode => mode.key).join('|');
        return this._tableModes.get(signature) ?? table.modes[0].key;
    }

    /**
     * Group of table columns to show: the last choice for these groups, else the first group.
     * @param {import('./DataTable').TableData} table
     * @returns {string | null}
     */
    _tableGroup(table) {
        const signature = table.groups.map(group => group.key).join('|');
        return this._tableGroups.has(signature) ? this._tableGroups.get(signature) : table.groups[0].key;
    }

    /**
     * Segmented switch of mutually exclusive options.
     * @param {{ key: string, label: string }[]} options
     * @param {() => string} current
     * @param {(key: string) => void} pick
     * @param {(label: string) => string} tooltip
     * @returns {HTMLElement}
     */
    _renderSwitch(options, current, pick, tooltip) {
        const element = document.createElement('div');
        element.className = 'inspector__switch';
        const buttons = options.map(({ key, label }) => {
            const button = document.createElement('button');
            button.className = 'inspector__switch-option';
            button.textContent = label;
            button.title = tooltip(label);
            button.addEventListener('click', () => {
                pick(key);
                update();
            });
            return button;
        });
        const update = () => {
            buttons.forEach((button, index) => button.classList.toggle('inspector__switch-option--active', options[index].key === current()));
        };
        update();
        element.append(...buttons);
        return element;
    }

    /**
     * Selects the record of a model object in the table / graph and scrolls to it.
     * @param {any} object
     * @param {boolean} [add] adds the record to the selection (or takes it out) instead
     * @returns {boolean} whether the shown content has a record for it
     */
    revealObject(object, add = false) {
        const row = this._content?.table?.rowOf?.(object) ?? -1;
        if (row < 0 || !this._table) return false;
        // Shift+click in the 3D view adds the record to the selection or takes it out
        if (add && this._table instanceof DataTable) this._table.toggleRow(row);
        else if (this._table.selectedRow !== row) this._table.selectRow(row);
        this._table.scrollToRow(row);
        return true;
    }

    /**
     * Changes the selection of the table by model objects (picked in the 3D view): replaces it, adds
     * them or takes them out; objects without a record are left out.
     * @param {any[]} objects
     * @param {'replace' | 'add' | 'remove'} mode
     * @returns {boolean} whether the shown content has records for model objects
     */
    selectObjects(objects, mode) {
        const rowOf = this._content?.table?.rowOf;
        if (!rowOf || !this._table) return false;
        const rows = objects.map(object => rowOf(object)).filter(row => row >= 0);
        if (this._table instanceof DataTable) {
            this._table.applySelection(rows, mode);
        } else if (mode !== 'remove' && rows.length) {
            this._table.selectRow(rows[rows.length - 1]);
        }
        if (rows.length && mode !== 'remove') this._table.scrollToRow(rows[rows.length - 1]);
        this.refreshActions();
        return true;
    }

    /** @returns {PanelContent['table'] | null} the table of the shown content */
    get table() {
        return this._content?.table ?? null;
    }

    /** @returns {number[]} the selected records of the table (one in the graph view) */
    get selectedRows() {
        if (this._table instanceof DataTable) return this._table.rows;
        return this.selectedRow >= 0 ? [this.selectedRow] : [];
    }

    /** Moves the current frame markers of the graph (called every frame while a clip plays). */
    updateCurrentFrame() {
        if (this._table instanceof CurveTable) this._table.updateCurrentFrame();
    }

    /** Deselects the record of the table / graph. */
    clearRowSelection() {
        if (!this._table || this._table.selectedRow < 0) return;
        this._table.selectRow(-1);
    }

    /** Index of the selected table row, or -1. */
    get selectedRow() {
        return this._table?.selectedRow ?? -1;
    }

    /** Re-reads all values (after undo/redo or an edit made elsewhere). */
    refresh() {
        if (!this._content) return;
        const subtitle = this._element.querySelector('.inspector__subtitle');
        if (subtitle) subtitle.textContent = this._subtitleText();
        this._updaters.forEach(update => update());
        this._openEntry?.updaters.forEach(update => update());
        if (this._tableNotice) this._updateTableNotice();
        this._table?.refresh();
        this.refreshActions();
    }

    _subtitleText() {
        const subtitle = this._content?.subtitle;
        return typeof subtitle === 'function' ? subtitle() : subtitle ?? '';
    }

    /** Re-reads the label, icon and enabled state of the actions (e.g. after playback changes). */
    refreshActions() {
        [...this._actionButtons, ...(this._openEntry?.actionButtons ?? [])]
            .forEach(({ button, action }) => this._renderActionContent(button, action));
    }

    /**
     * @param {HTMLButtonElement} button
     * @param {PanelAction} action
     */
    _renderActionContent(button, action) {
        const read = value => typeof value === 'function' ? value() : value;
        const icon = document.createElement('i');
        icon.className = `codicon codicon-${read(action.icon)}`;
        const label = read(action.label);
        button.replaceChildren(icon, document.createTextNode(label));
        button.title = read(action.title) ?? label;
        button.disabled = this._isActionDisabled(action);
        button.classList.toggle('inspector__action--active', !!action.isActive?.());
        button.classList.toggle('inspector__action--hidden', !!action.isHidden?.());
    }

    /**
     * @param {PanelAction | undefined} action
     * @returns {boolean}
     */
    _isActionDisabled(action) {
        return (this._readOnly && !action?.transient) || !!action?.isDisabled?.();
    }

    /**
     * @param {PanelAction} action
     * @returns {HTMLElement}
     */
    _renderAction(action) {
        const button = document.createElement('button');
        button.className = 'inspector__action';
        this._renderActionContent(button, action);
        this._actionButtons.push({ button, action });
        button.addEventListener('click', () => {
            action.run();
            this.refresh();
        });
        return button;
    }

    /**
     * Renders the label and the editor of a property and registers its updater.
     * @param {PropertyDescriptor} property
     * @returns {HTMLElement[]}
     */
    _renderProperty(property) {
        const label = document.createElement('label');
        label.className = 'inspector__label';
        label.textContent = property.label;
        // Long labels are cut off: the tooltip shows them in full
        label.title = property.label;
        if (property.isUnset) {
            const markUnset = () => {
                const unset = property.isUnset();
                label.classList.toggle('inspector__label--unset', unset);
                label.title = unset ? `${property.label}: not in the file — setting a value adds it` : property.label;
            };
            markUnset();
            this._updaters.push(markUnset);
        }
        const value = document.createElement('div');
        value.className = 'inspector__value';
        const editable = !!property.set && (!this._readOnly || !!property.transient) && property.type !== 'readonly';
        const commit = (newValue) => this._handlers.onCommit(property, newValue);

        switch (property.type) {
            case 'text':
            case 'number': {
                const input = this._createInput(property.type === 'number' ? 'number' : 'text', editable);
                if (property.type === 'number') input.step = 'any';
                const read = () => {
                    const current = property.get();
                    return current === null || current === undefined ? '' : property.type === 'number' ? formatNumber(current) : String(current);
                };
                input.value = read();
                input.addEventListener('change', () => {
                    if (property.type === 'text') return commit(input.value);
                    if (input.value.trim() === '') return property.nullable ? commit(null) : (input.value = read());
                    const number = Number(input.value);
                    Number.isFinite(number) ? commit(number) : (input.value = read());
                });
                this._updaters.push(() => { if (document.activeElement !== input) input.value = read(); });
                value.append(input);
                break;
            }
            case 'vector': {
                const components = property.components ?? ['X', 'Y', 'Z'];
                value.classList.add('inspector__value--vector');
                const inputs = components.map((name) => {
                    const input = this._createInput('number', editable);
                    input.step = 'any';
                    input.title = name;
                    input.placeholder = name;
                    return input;
                });
                const read = () => property.get().forEach((component, index) => {
                    if (document.activeElement !== inputs[index]) inputs[index].value = formatNumber(component);
                });
                read();
                inputs.forEach((input, index) => input.addEventListener('change', () => {
                    const number = Number(input.value);
                    if (input.value.trim() === '' || !Number.isFinite(number)) return read();
                    const next = [...property.get()];
                    next[index] = number;
                    commit(next);
                }));
                this._updaters.push(read);
                value.append(...inputs);
                break;
            }
            case 'image': {
                // The overlay is stretched over the picture: the frame takes the size of the picture
                const frame = document.createElement('div');
                frame.className = 'inspector__image';
                const image = document.createElement('img');
                image.className = 'inspector__image-source';
                const overlay = document.createElement('img');
                overlay.className = 'inspector__image-overlay';
                frame.append(image, overlay);
                const showSource = (element, source) => {
                    element.hidden = !source;
                    if (source && element.getAttribute('src') !== source) element.src = source;
                };
                const read = () => {
                    Promise.resolve(property.get()).then((source) => {
                        frame.classList.toggle('inspector__image--hidden', !source);
                        showSource(image, source);
                    }, () => frame.classList.add('inspector__image--hidden'));
                    Promise.resolve(property.overlay?.() ?? null).then(source => showSource(overlay, source), () => showSource(overlay, null));
                };
                read();
                this._updaters.push(read);
                if (property.menu?.length) this._attachMenu(frame, property.menu);
                value.append(frame);
                break;
            }
            case 'color': {
                const input = this._createInput('color', editable);
                input.value = property.get();
                input.addEventListener('change', () => commit(input.value));
                this._updaters.push(() => { input.value = property.get(); });
                value.append(input);
                break;
            }
            case 'boolean': {
                const input = this._createInput('checkbox', editable);
                input.checked = !!property.get();
                input.addEventListener('change', () => commit(input.checked));
                this._updaters.push(() => { input.checked = !!property.get(); });
                value.append(input);
                break;
            }
            case 'select': {
                const select = document.createElement('select');
                select.className = 'inspector__input';
                select.disabled = !editable;
                select.append(...(property.options?.() ?? []).map(({ value: optionValue, label: optionLabel, disabled }) => {
                    const option = document.createElement('option');
                    option.value = optionValue;
                    option.textContent = optionLabel;
                    option.disabled = !!disabled;
                    return option;
                }));
                select.value = property.get();
                select.addEventListener('change', () => commit(select.value));
                this._updaters.push(() => { select.value = property.get(); });
                value.append(select);
                break;
            }
            default: {
                const text = document.createElement('span');
                text.className = 'inspector__text';
                const read = () => {
                    const current = property.get();
                    text.textContent = Array.isArray(current) ? current.map(formatNumber).join(', ') : formatNumber(current);
                };
                read();
                this._updaters.push(read);
                value.append(text);
            }
        }
        if (property.action) value.append(this._renderValueAction(property.action));
        return [label, value];
    }

    /**
     * An icon button after the editor of a property; its enabled state is re-read on refresh.
     * @param {PanelAction} action
     * @returns {HTMLButtonElement}
     */
    _renderValueAction(action) {
        const read = value => typeof value === 'function' ? value() : value;
        const button = document.createElement('button');
        button.className = 'inspector__value-action';
        const update = () => {
            button.innerHTML = `<i class="codicon codicon-${read(action.icon)}"></i>`;
            button.title = read(action.title) ?? read(action.label);
            button.disabled = this._isActionDisabled(action);
        };
        update();
        this._updaters.push(update);
        button.addEventListener('click', () => {
            action.run();
            this.refresh();
        });
        return button;
    }

    /**
     * Opens a menu of actions by a click (or Enter / Space) on an element; actions that change the
     * model are disabled for view-only formats, as buttons are.
     * @param {HTMLElement} element
     * @param {PanelAction[]} actions
     */
    _attachMenu(element, actions) {
        element.classList.add('inspector__image--menu');
        element.tabIndex = 0;
        element.title = 'Image commands';
        const open = (x, y) => this._menu.show(x, y, actions, {
            isDisabled: action => this._isActionDisabled(action),
            run: (action) => {
                action.run();
                this.refresh();
            },
            onChange: () => this.refresh(),
        });
        element.addEventListener('click', event => open(event.clientX, event.clientY));
        element.addEventListener('contextmenu', (event) => {
            event.preventDefault();
            open(event.clientX, event.clientY);
        });
        element.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            const rect = element.getBoundingClientRect();
            open(rect.left, rect.bottom);
        });
    }

    /**
     * @param {string} type
     * @param {boolean} editable
     * @returns {HTMLInputElement}
     */
    _createInput(type, editable) {
        const input = document.createElement('input');
        input.type = type;
        input.className = 'inspector__input';
        input.disabled = !editable;
        return input;
    }
}
