/**
 * @typedef {object} TableColumn
 * @property {string} label
 * @property {(row: number) => number | string} get
 * @property {(row: number, value: number | string) => void} [set] makes the column editable
 * @property {(row: number) => boolean} [isEditable] per-row override when `set` is present
 * @property {(row: number) => any} [capture] exact state snapshot for undo (when set(oldValue) would be lossy)
 * @property {(row: number, state: any) => void} [restore] restores a captured snapshot
 * @property {boolean} [leading] shown in the left part of the record (index, name), spanning all lines
 * @property {number} [width] width in px of a leading column
 * @property {boolean} [text] the value is a string, edited as text (e.g. a name)
 * @property {boolean} [title] shown as a line above the values of the record (e.g. the bone name); not in the header
 * @property {string} [group] value columns of one group start a new line (e.g. position / normal / uv)
 */

/**
 * @typedef {object} TableData
 * @property {TableColumn[]} columns
 * @property {() => number} rowCount read on every refresh, so added/removed rows show up
 * @property {{ key: string, label: string }[]} [groups] column groups the user can switch between
 *   (only the value columns of the chosen group are shown); omitted - all columns are shown
 * @property {RowToggle} [rowToggle] a small button in each record (e.g. hide a bone in the 3D view)
 */

/**
 * A button of a record: at the end of its title line, or as the first leading cell without a title.
 * It does not select the record and works in read-only tables (it changes the view, not the data).
 * @typedef {object} RowToggle
 * @property {(row: number) => string} title tooltip
 * @property {(row: number) => string} icon codicon name without the prefix
 * @property {(row: number) => boolean} [isActive] shown pressed while it returns true
 * @property {(row: number) => void} run
 */

const LINE_HEIGHT = 20;
const ROW_PADDING = 4;
const VALUES_PER_LINE = 3;
const OVERSCAN = 6;

/**
 * Formats numbers compactly for table cells and property inputs.
 * @param {number | string} value
 * @param {number} [digits] maximum number of decimals
 * @returns {string}
 */
export function formatNumber(value, digits = 5) {
    if (typeof value !== 'number') return String(value ?? '');
    if (Number.isInteger(value)) return String(value);
    return String(Number(value.toFixed(digits)));
}

/** Decimals shown in table cells (the full value is in the cell tooltip and the edit input). */
const CELL_DIGITS = 3;

/**
 * Splits value columns into lines of at most VALUES_PER_LINE; a new group always starts a new line.
 * @param {TableColumn[]} columns
 * @returns {TableColumn[][]}
 */
function layoutLines(columns) {
    /** @type {TableColumn[][]} */
    const lines = [];
    for (const column of columns) {
        const line = lines[lines.length - 1];
        if (!line || line.length === VALUES_PER_LINE || line[0].group !== column.group) {
            lines.push([column]);
        } else {
            line.push(column);
        }
    }
    return lines;
}

/**
 * Virtualized table: only visible records are in the DOM, so meshes with tens of thousands
 * of vertices stay responsive. Each record is shown as a block: leading columns (index, name)
 * on the left and value columns in lines of up to three values. Editable cells are edited on
 * double click; commits are reported through onCellCommit so the caller can wrap them into
 * undoable commands.
 */
export class DataTable {

    /**
     * @param {HTMLElement} element container element
     * @param {{
     *   onSelectRow?: (row: number) => void,
     *   onCellCommit: (column: TableColumn, row: number, oldValue: number | string, newValue: number | string) => void
     * }} handlers
     */
    constructor(element, handlers) {
        this._handlers = handlers;
        this._readOnly = false;
        /** @type {TableData | null} */
        this._data = null;
        /** @type {string | null} shown column group, null for all */
        this._group = null;
        /** @type {TableColumn | null} */
        this._title = null;
        /** @type {TableColumn[]} */
        this._leading = [];
        /** @type {TableColumn[][]} */
        this._lines = [];
        this._rowHeight = LINE_HEIGHT + ROW_PADDING;
        /** @type {number} */
        this.selectedRow = -1;

        this._element = element;
        this._element.classList.add('table');
        this._header = document.createElement('div');
        this._header.className = 'table__header';
        this._body = document.createElement('div');
        this._body.className = 'table__body';
        this._spacer = document.createElement('div');
        this._spacer.className = 'table__spacer';
        this._rows = document.createElement('div');
        this._rows.className = 'table__rows';
        this._body.append(this._spacer, this._rows);
        this._element.append(this._header, this._body);
        this._body.addEventListener('scroll', () => this._renderRows());
        new ResizeObserver(() => this._renderRows()).observe(this._body);
    }

    /**
     * @param {TableData} data
     */
    setData(data) {
        this._data = data;
        this._group = null;
        this.selectedRow = -1;
        this._body.scrollTop = 0;
        this._layout();
    }

    /**
     * Shows only the value columns of one group (null shows all), keeping the selection
     * and the first visible record.
     * @param {string | null} group
     */
    setGroup(group) {
        if (!this._data || this._group === group) return;
        const firstRow = Math.floor(this._body.scrollTop / this._rowHeight);
        this._group = group;
        this._layout();
        this._body.scrollTop = firstRow * this._rowHeight;
    }

    /** Splits the shown columns into the record layout and re-renders the header and rows. */
    _layout() {
        const columns = this._data.columns;
        this._title = columns.find(column => column.title) ?? null;
        this._leading = columns.filter(column => column.leading && !column.title);
        this._lines = layoutLines(columns.filter(column => !column.leading && !column.title && (this._group === null || column.group === this._group)));
        this._rowHeight = (Math.max(1, this._lines.length) + (this._title ? 1 : 0)) * LINE_HEIGHT + ROW_PADDING;
        this._header.replaceChildren(this._renderHeader());
        this.refresh();
    }

    /**
     * @param {boolean} readOnly
     */
    setReadOnly(readOnly) {
        this._readOnly = readOnly;
        this.refresh();
    }

    /** Re-renders the visible records from the data accessors. */
    refresh() {
        if (!this._data) return;
        this._spacer.style.height = `${this._data.rowCount() * this._rowHeight}px`;
        this._renderRows();
    }

    /**
     * @param {number} row
     */
    selectRow(row) {
        this.selectedRow = row;
        this._renderRows();
        this._handlers.onSelectRow?.(row);
    }

    /**
     * Scrolls a record into view (centered) unless it is fully visible.
     * @param {number} row
     */
    scrollToRow(row) {
        const top = row * this._rowHeight;
        const { scrollTop, clientHeight } = this._body;
        if (top < scrollTop || top + this._rowHeight > scrollTop + clientHeight) {
            this._body.scrollTop = top - (clientHeight - this._rowHeight) / 2;
        }
        this._renderRows();
    }

    _renderRows() {
        if (!this._data) return;
        const rowCount = this._data.rowCount();
        const first = Math.max(0, Math.floor(this._body.scrollTop / this._rowHeight) - OVERSCAN);
        const visible = Math.ceil(this._body.clientHeight / this._rowHeight) + OVERSCAN * 2;
        const last = Math.min(rowCount, first + visible);
        this._rows.style.top = `${first * this._rowHeight}px`;

        const rows = [];
        for (let index = first; index < last; index++) {
            rows.push(this._renderRow(index));
        }
        this._rows.replaceChildren(...rows);
    }

    /**
     * Builds the record layout (leading cells + value lines) with the given cell factory.
     * @param {(column: TableColumn) => HTMLElement} createCell
     * @returns {HTMLElement}
     */
    _renderRecord(createCell, toggle = null) {
        const record = document.createElement('div');
        record.className = 'table__record';
        if (toggle && !this._title) record.append(toggle);
        for (const column of this._leading) {
            const cell = createCell(column);
            cell.classList.add('table__cell--leading');
            cell.style.flex = `0 0 ${column.width ?? 56}px`;
            record.append(cell);
        }
        const lines = document.createElement('div');
        lines.className = 'table__lines';
        for (const columns of this._lines) {
            const line = document.createElement('div');
            line.className = 'table__line';
            line.append(...columns.map(createCell));
            // Empty slots keep the value columns aligned across lines
            for (let slot = columns.length; slot < VALUES_PER_LINE; slot++) {
                const empty = document.createElement('div');
                empty.className = 'table__cell';
                line.append(empty);
            }
            lines.append(line);
        }
        record.append(lines);
        if (!this._title) return record;
        const titled = document.createElement('div');
        titled.className = 'table__titled';
        const title = createCell(this._title);
        title.classList.add('table__cell--title');
        // The title is shown as a tag, like the record names of the graph view
        const tag = document.createElement('span');
        tag.className = 'table__tag';
        tag.textContent = title.textContent;
        title.replaceChildren(tag);
        if (toggle) title.append(toggle);
        titled.append(title, record);
        return titled;
    }

    /**
     * Header in one line: each value slot lists the labels of its column in all lines,
     * separated by "/" (e.g. "PX/RX°/SX").
     * @returns {HTMLElement}
     */
    _renderHeader() {
        const record = document.createElement('div');
        record.className = 'table__record';
        for (const column of this._leading) {
            const cell = this._createCell(column.label);
            cell.classList.add('table__cell--leading');
            cell.style.flex = `0 0 ${column.width ?? 56}px`;
            record.append(cell);
        }
        const line = document.createElement('div');
        line.className = 'table__line';
        for (let slot = 0; slot < VALUES_PER_LINE; slot++) {
            const labels = this._lines.map(columns => columns[slot]?.label).filter(Boolean);
            line.append(this._createCell(labels.join('/')));
        }
        const lines = document.createElement('div');
        lines.className = 'table__lines';
        lines.append(line);
        record.append(lines);
        return record;
    }

    /**
     * @param {number} index
     * @returns {HTMLElement}
     */
    _renderRow(index) {
        const toggle = this._data.rowToggle ? this._renderToggle(this._data.rowToggle, index) : null;
        const row = this._renderRecord((column) => {
            const value = column.get(index);
            const cell = this._createCell(typeof value === 'number' ? formatNumber(value, CELL_DIGITS) : String(value ?? ''));
            cell.title = typeof value === 'number' ? `${column.label}: ${formatNumber(value)}` : String(value ?? '');
            const editable = column.set && !this._readOnly && (column.isEditable?.(index) ?? true);
            if (editable) {
                cell.classList.add('table__cell--editable');
                cell.addEventListener('dblclick', () => this._editCell(cell, column, index));
            }
            return cell;
        }, toggle);
        row.classList.add('table__row');
        row.classList.toggle('table__row--selected', index === this.selectedRow);
        row.style.height = `${this._rowHeight}px`;
        row.addEventListener('click', () => {
            if (this.selectedRow !== index) this.selectRow(index);
        });
        return row;
    }

    /**
     * @param {RowToggle} toggle
     * @param {number} index
     * @returns {HTMLElement}
     */
    _renderToggle(toggle, index) {
        const button = document.createElement('span');
        button.className = 'table__toggle';
        button.setAttribute('role', 'button');
        button.innerHTML = `<i class="codicon codicon-${toggle.icon(index)}"></i>`;
        button.title = toggle.title(index);
        button.classList.toggle('table__toggle--active', !!toggle.isActive?.(index));
        // Neither selects the record nor edits the title it sits in
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            toggle.run(index);
            this._renderRows();
        });
        button.addEventListener('dblclick', event => event.stopPropagation());
        return button;
    }

    /**
     * @param {string} text
     * @returns {HTMLElement}
     */
    _createCell(text) {
        const cell = document.createElement('div');
        cell.className = 'table__cell';
        cell.textContent = text;
        cell.title = text;
        return cell;
    }

    /**
     * Replaces the cell text with an input; Enter or blur commits, Escape cancels.
     * @param {HTMLElement} cell
     * @param {TableColumn} column
     * @param {number} index
     */
    _editCell(cell, column, index) {
        const oldValue = column.text ? String(column.get(index)) : Number(column.get(index));
        const input = document.createElement('input');
        input.className = 'table__input';
        input.value = column.text ? oldValue : formatNumber(oldValue);
        cell.replaceChildren(input);
        input.focus();
        input.select();

        let done = false;
        const finish = (commit) => {
            if (done) return;
            done = true;
            const newValue = column.text ? input.value.trim() : Number(input.value);
            const valid = input.value.trim() !== '' && (column.text || Number.isFinite(newValue));
            if (commit && valid && newValue !== oldValue) {
                this._handlers.onCellCommit(column, index, oldValue, newValue);
            }
            this._renderRows();
        };
        input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') finish(true);
            if (event.key === 'Escape') finish(false);
        });
        input.addEventListener('blur', () => finish(true));
    }
}
