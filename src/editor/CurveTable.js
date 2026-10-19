import { formatNumber } from './DataTable';

/**
 * One animated value of a record (e.g. PX), drawn as a curve on its own lane.
 * @typedef {object} CurveChannel
 * @property {string} label
 * @property {string} color CSS color of the curve
 * @property {string} [group] channels of the chosen group are shown (see setGroup)
 */

/**
 * @typedef {object} CurveData
 * @property {CurveChannel[]} channels
 * @property {() => number} rowCount
 * @property {(row: number) => string} label record name
 * @property {() => { from: number, to: number }} range frame range of the time axis
 * @property {(row: number, frame: number) => (number | null)[]} sample values of all channels at a
 *   frame (null where the channel is not animated)
 * @property {(row: number, channel: number) => number[]} keys frames of the keys of a channel
 * @property {(row: number, channel: number, frame: number, value: number) => void} setKey
 * @property {(row: number, channel: number) => boolean} [isEditable]
 * @property {(row: number) => any} capture exact state snapshot of a record for undo
 * @property {(row: number, state: any) => void} restore
 * @property {() => number} currentFrame frame marked on the lanes
 * @property {(frame: number) => void} selectFrame
 * @property {() => boolean} [isPlaying] while it returns true the arrow keys do not step frames
 * @property {{ key: string, label: string }[]} [groups] channel groups the user can switch between
 * @property {() => CurveBand[]} [bands] frame ranges marked on the time axis and behind the curves
 * @property {CurveAction[]} [actions] buttons in the bar above the graph
 */

/**
 * A marked frame range: a clip of the timeline, or a range picked for an operation.
 * @typedef {object} CurveBand
 * @property {number} from
 * @property {number} to
 * @property {string} [label] shown in the band strip above the ruler (the tooltip too)
 * @property {string} [color] CSS color of a 'clip' band
 * @property {'clip' | 'selected' | 'deselected'} kind 'selected' / 'deselected' - a range picked or
 *   not picked for an operation (a deselected one stays visible, darker)
 * @property {() => void} [onClick] a click on the band (in the strip or on a lane) runs it instead of
 *   selecting a frame
 */

/**
 * @typedef {object} CurveAction
 * @property {string | (() => string)} label
 * @property {string | (() => string)} [title]
 * @property {string} icon codicon name without the prefix
 * @property {() => void} run
 * @property {() => boolean} [isHidden]
 * @property {() => boolean} [isDisabled]
 */

const LANE_HEIGHT = 42;
const LANE_GAP = 2;
const ROW_PADDING = 6;
/** Line with the record name above the lanes. */
const NAME_HEIGHT = 16;
const LANES_PER_ROW = 3;
const MAX_ZOOM_X = 20;
const MAX_ZOOM_Y = 5;
const ZOOM_STEPS = 100;
/** Horizontal padding of the time axis, so the first and the last key can be grabbed. */
const AXIS_PADDING = 6;
/** Space above the curve for the channel label. */
const TOP_PADDING = 12;
const BOTTOM_PADDING = 4;
const KEY_RADIUS = 3;
/** Vertical pointer movement in px after which a press on a key becomes a drag. */
const DRAG_THRESHOLD = 3;
/** Distance in px from the visible edge at which the current frame marker scrolls the time axis. */
const REVEAL_MARGIN = 8;
const MIN_LABEL_SPACING = 44;
const TICK_STEPS = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000];
const OVERSCAN = 3;
const SVG_NS = 'http://www.w3.org/2000/svg';

/** Zoom of the time axis (x) and of the lane height (y); shared by all curve views of the webview. */
const zoom = { x: 1, y: 1 };

/**
 * @param {string} name
 * @param {Record<string, string | number>} attributes
 * @returns {SVGElement}
 */
function svg(name, attributes = {}) {
    const element = document.createElementNS(SVG_NS, name);
    Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, String(value)));
    return element;
}

/** Height of the strip with the bands above the ruler. */
const BAND_STRIP_HEIGHT = 16;

/** Minimal span of a lane relative to the magnitude of its values. */
const MIN_RELATIVE_SPAN = 0.01;
const MIN_SPAN = 1e-3;

/**
 * Value range of a lane: the minimum and maximum of the curve with a small margin. The span
 * is at least 1% of the magnitude, so float noise of a nearly constant curve (e.g. 9.923 vs
 * 9.924 from decomposed matrices) is not stretched to the full lane height.
 * @param {number[]} values
 * @returns {{ min: number, max: number }}
 */
function valueRange(values) {
    const min = Math.min(...values), max = Math.max(...values);
    const magnitude = Math.max(Math.abs(min), Math.abs(max));
    const span = Math.max(max - min, magnitude * MIN_RELATIVE_SPAN, MIN_SPAN);
    const center = (min + max) / 2;
    const half = span / 2 * 1.08;
    return { min: center - half, max: center + half };
}

/**
 * Curve view of animated records: the header is a frame ruler, each record has three lanes
 * (one channel each) with the interpolated curve, the zero axis and the keys as points.
 * Keys are dragged vertically; a drag is reported once through onDragCommit with the record
 * snapshots before and after, so the caller can record one undoable command.
 * Only visible records are in the DOM, like in DataTable.
 */
export class CurveTable {

    /**
     * @param {HTMLElement} element container element
     * @param {{
     *   onSelectRow?: (row: number) => void,
     *   onSelectFrame?: (frame: number) => void,
     *   onDragCommit: (data: CurveData, row: number, label: string, before: any, after: any) => void
     * }} handlers
     */
    constructor(element, handlers) {
        this._handlers = handlers;
        this._readOnly = false;
        /** @type {CurveData | null} */
        this._data = null;
        /** @type {string | null} */
        this._group = null;
        /** @type {number[]} indices of the shown channels */
        this._channels = [];
        /** @type {{ row: number, channel: number, frame: number, scale: { min: number, max: number }, before: any } | null} */
        this._drag = null;
        /** @type {{ element: HTMLElement, commit: () => void } | null} open value editor */
        this._editor = null;
        this.selectedRow = -1;

        this._element = element;
        this._element.classList.add('curves');
        const zoomBar = document.createElement('div');
        zoomBar.className = 'curves__zoom';
        this._actionBar = document.createElement('div');
        this._actionBar.className = 'curves__actions';
        /** @type {CurveBand[]} bands of the current render */
        this._bands = [];
        zoomBar.append(
            this._actionBar,
            this._createZoomSlider('x', 'arrow-both', 'Horizontal zoom (frames)', MAX_ZOOM_X),
            this._createZoomSlider('y', 'unfold', 'Vertical zoom (lane height)', MAX_ZOOM_Y),
        );
        this._header = document.createElement('div');
        this._header.className = 'curves__header';
        this._body = document.createElement('div');
        this._body.className = 'curves__body';
        this._spacer = document.createElement('div');
        this._spacer.className = 'curves__spacer';
        this._rows = document.createElement('div');
        this._rows.className = 'curves__rows';
        this._body.append(this._spacer, this._rows);
        // Value of the hovered or dragged key
        this._valueLabel = document.createElement('div');
        this._valueLabel.className = 'curves__value curves__value--hidden';
        this._element.append(zoomBar, this._header, this._body, this._valueLabel);
        this._body.addEventListener('scroll', () => {
            this._header.scrollLeft = this._body.scrollLeft;
            this._renderRows();
        });
        new ResizeObserver(() => this.refresh()).observe(this._body);
        this._element.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') this._cancelDrag();
            // Left / Right step to the previous / next frame while the graph itself has the focus
            // (not the zoom sliders or the value editor) and the clip is paused
            const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
            if (step && event.target === this._element && this._data && !this._drag && !this._data.isPlaying?.()) {
                event.preventDefault();
                this._stepFrame(step);
            }
        });
        this._element.tabIndex = 0;
    }

    /**
     * Range input changing one zoom axis; the zoom is exponential, so the slider feels even.
     * @param {'x' | 'y'} axis
     * @param {string} icon codicon name
     * @param {string} title
     * @param {number} max maximal zoom factor
     * @returns {HTMLElement}
     */
    _createZoomSlider(axis, icon, title, max) {
        const label = document.createElement('label');
        label.className = 'curves__zoom-control';
        label.title = title;
        label.innerHTML = `<i class="codicon codicon-${icon}"></i>`;
        const input = document.createElement('input');
        input.type = 'range';
        input.className = 'curves__zoom-slider';
        input.min = '0';
        input.max = String(ZOOM_STEPS);
        input.value = String(Math.round(Math.log(zoom[axis]) / Math.log(max) * ZOOM_STEPS));
        input.addEventListener('input', () => {
            const anchor = this._scrollAnchor();
            zoom[axis] = max ** (Number(input.value) / ZOOM_STEPS);
            this.refresh();
            this._restoreScrollAnchor(anchor);
        });
        label.append(input);
        return label;
    }

    /**
     * Relative scroll position, so zooming keeps the visible part in place.
     * @returns {{ x: number, y: number }}
     */
    _scrollAnchor() {
        const { scrollLeft, scrollTop, scrollWidth, scrollHeight, clientWidth, clientHeight } = this._body;
        return {
            x: (scrollLeft + clientWidth / 2) / Math.max(1, scrollWidth),
            y: (scrollTop + clientHeight / 2) / Math.max(1, scrollHeight),
        };
    }

    /**
     * @param {{ x: number, y: number }} anchor
     */
    _restoreScrollAnchor({ x, y }) {
        const body = this._body;
        body.scrollLeft = x * body.scrollWidth - body.clientWidth / 2;
        body.scrollTop = y * body.scrollHeight - body.clientHeight / 2;
        this._header.scrollLeft = body.scrollLeft;
        this._renderRows();
    }

    _laneHeight() {
        return Math.round(LANE_HEIGHT * zoom.y);
    }

    _rowHeight() {
        return NAME_HEIGHT + LANES_PER_ROW * (this._laneHeight() + LANE_GAP) + ROW_PADDING;
    }

    /**
     * @param {CurveData} data
     */
    setData(data) {
        this._closeEditor(false);
        this._data = data;
        this._group = null;
        this.selectedRow = -1;
        this._body.scrollTop = 0;
        this._layout();
    }

    /**
     * Shows the channels of one group (null shows the first three channels).
     * @param {string | null} group
     */
    setGroup(group) {
        if (!this._data || this._group === group) return;
        this._group = group;
        this._layout();
    }

    /**
     * @param {boolean} readOnly
     */
    setReadOnly(readOnly) {
        this._readOnly = readOnly;
        this.refresh();
    }

    /**
     * Moves the current frame markers (ruler and lanes) without re-rendering the records, e.g.
     * every frame while the clip plays.
     */
    updateCurrentFrame() {
        if (!this._data) return;
        const x = this._frameToX(this._data.currentFrame());
        this._revealX(x);
        this._header.querySelector('.curves__marker')?.setAttribute('d', `M${x - 4},14 L${x + 4},14 L${x},20 Z`);
        this._rows.querySelectorAll('.curves__current').forEach((line) => {
            line.setAttribute('x1', String(x));
            line.setAttribute('x2', String(x));
        });
    }

    /**
     * Scrolls the time axis so that x is visible: a marker leaving the view (also when a looping
     * clip starts again) is placed near the left edge, so the view pages along with playback.
     * @param {number} x px within the time axis
     */
    _revealX(x) {
        const body = this._body;
        const { scrollLeft, clientWidth } = body;
        if (x >= scrollLeft + REVEAL_MARGIN && x <= scrollLeft + clientWidth - REVEAL_MARGIN) return;
        body.scrollLeft = x - REVEAL_MARGIN * 4;
        this._header.scrollLeft = body.scrollLeft;
    }

    /** Re-renders the ruler and the visible records from the data accessors. */
    refresh() {
        if (!this._data) return;
        this._bands = this._data.bands?.() ?? [];
        this._renderActions();
        this._spacer.style.height = `${this._data.rowCount() * this._rowHeight()}px`;
        const width = `${this._axisWidth()}px`;
        this._spacer.style.width = width;
        this._rows.style.width = width;
        this._renderHeader();
        this._renderRows();
    }

    _layout() {
        const channels = this._data.channels.map((channel, index) => ({ channel, index }));
        const shown = channels.filter(({ channel }) => this._group === null || channel.group === this._group);
        this._channels = shown.slice(0, LANES_PER_ROW).map(({ index }) => index);
        this.refresh();
    }

    /** Width in px of the time axis: the visible width times the horizontal zoom. */
    _axisWidth() {
        return Math.round(Math.max(40, this._body.clientWidth) * zoom.x);
    }

    /**
     * @param {number} frame
     * @returns {number} x in px within the time axis
     */
    _frameToX(frame) {
        const { from, to } = this._data.range();
        const span = Math.max(1e-6, to - from);
        return AXIS_PADDING + (frame - from) / span * (this._axisWidth() - AXIS_PADDING * 2);
    }

    /**
     * @param {number} x px within the time axis
     * @returns {number} the nearest whole frame within the range
     */
    _xToFrame(x) {
        const { from, to } = this._data.range();
        const ratio = (x - AXIS_PADDING) / Math.max(1, this._axisWidth() - AXIS_PADDING * 2);
        return Math.min(to, Math.max(from, Math.round(from + ratio * (to - from))));
    }

    _renderHeader() {
        const width = this._axisWidth();
        const ruler = svg('svg', { class: 'curves__ruler', width, height: 20 });
        const { from, to } = this._data.range();
        const pxPerFrame = (width - AXIS_PADDING * 2) / Math.max(1, to - from);
        const step = TICK_STEPS.find(candidate => candidate * pxPerFrame >= MIN_LABEL_SPACING) ?? TICK_STEPS[TICK_STEPS.length - 1];
        for (let frame = Math.ceil(from / step) * step; frame <= to; frame += step) {
            const x = this._frameToX(frame);
            ruler.append(svg('line', { class: 'curves__tick', x1: x, x2: x, y1: 14, y2: 20 }));
            // Labels at the edges are shifted inside, so they are not clipped
            const labelX = Math.min(width - 12, Math.max(12, x));
            const label = svg('text', { class: 'curves__tick-label', x: labelX, y: 11, 'text-anchor': 'middle' });
            label.textContent = String(frame);
            ruler.append(label);
        }
        const current = this._frameToX(this._data.currentFrame());
        ruler.append(svg('path', { class: 'curves__marker', d: `M${current - 4},14 L${current + 4},14 L${current},20 Z` }));
        const inner = document.createElement('div');
        inner.className = 'curves__header-inner';
        inner.style.width = `${width}px`;
        if (this._bands.length) inner.append(this._renderBandStrip(width));
        inner.append(ruler);
        this._header.replaceChildren(inner);
        this._header.scrollLeft = this._body.scrollLeft;
    }

    /**
     * The strip above the ruler with a rectangle (and its label) per band.
     * @param {number} width
     * @returns {SVGElement}
     */
    _renderBandStrip(width) {
        const strip = svg('svg', { class: 'curves__bands', width, height: BAND_STRIP_HEIGHT });
        for (const band of this._bands) {
            const x = this._frameToX(band.from);
            const bandWidth = Math.max(1, this._frameToX(band.to) - x);
            const rect = svg('rect', {
                class: `curves__band curves__band--${band.kind}${band.onClick ? ' curves__band--clickable' : ''}`,
                x, y: 1, width: bandWidth, height: BAND_STRIP_HEIGHT - 2, rx: 2,
                ...(band.kind === 'clip' && band.color ? { fill: band.color } : {}),
            });
            const title = svg('title');
            title.textContent = band.label ?? `${formatNumber(band.from, 1)}–${formatNumber(band.to, 1)}`;
            rect.append(title);
            if (band.onClick) {
                rect.addEventListener('click', () => {
                    band.onClick();
                    this.refresh();
                });
            }
            strip.append(rect);
            if (band.label && bandWidth > 24) {
                const label = svg('text', { class: 'curves__band-label', x: x + 3, y: BAND_STRIP_HEIGHT - 4 });
                label.textContent = band.label;
                // The label is cut at the end of its band
                const clip = svg('clipPath', { id: `curves-band-${this._bandId = (this._bandId ?? 0) + 1}` });
                clip.append(svg('rect', { x, y: 0, width: bandWidth - 2, height: BAND_STRIP_HEIGHT }));
                label.setAttribute('clip-path', `url(#${clip.id})`);
                strip.append(clip, label);
            }
        }
        return strip;
    }

    /**
     * Runs the click of a clickable band at a position of the time axis.
     * @param {number} x px within the time axis
     * @returns {boolean} whether a band took the click
     */
    _clickBand(x) {
        const { from, to } = this._data.range();
        const frame = from + (x - AXIS_PADDING) / Math.max(1, this._axisWidth() - AXIS_PADDING * 2) * (to - from);
        const band = this._bands.find(candidate => candidate.onClick && frame >= candidate.from && frame <= candidate.to);
        if (!band) return false;
        band.onClick();
        this.refresh();
        return true;
    }

    /** Buttons of the data in the bar above the graph (re-read on refresh). */
    _renderActions() {
        const read = value => typeof value === 'function' ? value() : value;
        const buttons = (this._data.actions ?? []).filter(action => !action.isHidden?.()).map((action) => {
            const button = document.createElement('button');
            button.className = 'curves__action';
            button.innerHTML = `<i class="codicon codicon-${read(action.icon)}"></i>`;
            button.append(document.createTextNode(read(action.label)));
            button.title = read(action.title) ?? read(action.label);
            button.disabled = !!action.isDisabled?.();
            button.addEventListener('click', () => {
                action.run();
                this.refresh();
            });
            return button;
        });
        this._actionBar.replaceChildren(...buttons);
        this._actionBar.classList.toggle('curves__actions--empty', !buttons.length);
    }

    _renderRows() {
        if (!this._data) return;
        const rowCount = this._data.rowCount();
        const rowHeight = this._rowHeight();
        const first = Math.max(0, Math.floor(this._body.scrollTop / rowHeight) - OVERSCAN);
        const visible = Math.ceil(this._body.clientHeight / rowHeight) + OVERSCAN * 2;
        const last = Math.min(rowCount, first + visible);
        this._rows.style.top = `${first * rowHeight}px`;
        const rows = [];
        for (let row = first; row < last; row++) rows.push(this._renderRow(row));
        this._rows.replaceChildren(...rows);
    }

    /**
     * Values of the shown channels per frame of the range (one sample per whole frame,
     * or per pixel for long clips).
     * @param {number} row
     * @returns {{ frames: number[], values: (number | null)[][] }} values[lane][sample]
     */
    _sampleRow(row) {
        const { from, to } = this._data.range();
        const count = Math.max(2, Math.min(Math.floor(to - from) + 1, Math.ceil(this._axisWidth())));
        const frames = Array.from({ length: count }, (_, index) => from + (to - from) * index / (count - 1));
        const samples = frames.map(frame => this._data.sample(row, frame));
        return { frames, values: this._channels.map(channel => samples.map(sample => sample[channel])) };
    }

    /**
     * @param {number} row
     * @returns {HTMLElement}
     */
    _renderRow(row) {
        const record = document.createElement('div');
        record.className = 'curves__row';
        record.classList.toggle('curves__row--selected', row === this.selectedRow);
        record.style.height = `${this._rowHeight()}px`;
        // The name is a tag in a line above the lanes; it stays visible while scrolling horizontally
        const name = document.createElement('div');
        name.className = 'curves__name';
        const tag = document.createElement('span');
        tag.className = 'curves__tag';
        tag.textContent = this._data.label(row);
        name.append(tag);
        const lanes = document.createElement('div');
        lanes.className = 'curves__lanes';
        lanes.append(name);
        const { frames, values } = this._sampleRow(row);
        this._channels.forEach((channel, lane) => {
            lanes.append(this._renderLane(row, channel, frames, values[lane]));
        });
        record.append(lanes);
        record.addEventListener('click', () => {
            if (this.selectedRow !== row) this.selectRow(row);
        });
        return record;
    }

    /**
     * @param {number} row
     * @param {number} channel
     * @param {number[]} frames
     * @param {(number | null)[]} values
     * @returns {SVGElement}
     */
    _renderLane(row, channel, frames, values) {
        const { label, color } = this._data.channels[channel];
        const width = this._axisWidth();
        const height = this._laneHeight();
        const lane = svg('svg', { class: 'curves__lane', width, height });
        const caption = svg('text', { class: 'curves__lane-label', x: 2, y: 9 });
        caption.textContent = label;
        lane.append(caption);
        for (const band of this._bands) {
            const x = this._frameToX(band.from);
            lane.append(svg('rect', {
                class: `curves__band-area curves__band-area--${band.kind}`,
                x, y: 0, width: Math.max(1, this._frameToX(band.to) - x), height,
                ...(band.kind === 'clip' && band.color ? { fill: band.color } : {}),
            }));
        }
        const current = this._frameToX(this._data.currentFrame());
        lane.append(svg('line', { class: 'curves__current', x1: current, x2: current, y1: 0, y2: height }));
        lane.addEventListener('click', (event) => {
            if (event.target instanceof SVGCircleElement) return;
            if (this._clickBand(event.offsetX)) return;
            this.selectRow(row);
            this._selectFrame(this._xToFrame(event.offsetX));
        });
        if (values.every(value => value === null)) {
            caption.textContent = `${label} (not animated)`;
            return lane;
        }

        const drag = this._drag?.row === row && this._drag.channel === channel ? this._drag : null;
        const keys = this._data.keys(row, channel);
        const keyValues = keys.map(frame => this._data.sample(row, frame)[channel] ?? 0);
        // The scale is frozen while dragging, so the dragged key stays under the pointer
        const scale = drag?.scale ?? valueRange([...values.filter(value => value !== null), ...keyValues]);
        const toY = value => TOP_PADDING + (scale.max - value) / (scale.max - scale.min) * (height - TOP_PADDING - BOTTOM_PADDING);

        // The zero axis is drawn only when 0 is within the range of the curve
        if (scale.min <= 0 && scale.max >= 0) {
            const zero = toY(0);
            lane.append(svg('line', { class: 'curves__zero', x1: 0, x2: width, y1: zero, y2: zero }));
        }
        const points = frames.map((frame, index) => `${this._frameToX(frame).toFixed(1)},${toY(values[index] ?? 0).toFixed(1)}`);
        lane.append(svg('polyline', { class: 'curves__line', points: points.join(' '), stroke: color }));

        const editable = !this._readOnly && (this._data.isEditable?.(row, channel) ?? true);
        keys.forEach((frame, index) => {
            const key = svg('circle', {
                class: `curves__key${editable ? ' curves__key--editable' : ''}`,
                cx: this._frameToX(frame), cy: toY(keyValues[index]), r: KEY_RADIUS, fill: color,
            });
            key.addEventListener('pointerenter', () => {
                const bounds = key.getBoundingClientRect();
                this._showValue(channel, frame, keyValues[index], bounds.left + bounds.width / 2, bounds.top);
            });
            key.addEventListener('pointerleave', () => {
                if (!this._drag) this._hideValue();
            });
            if (editable) {
                key.addEventListener('pointerdown', event => this._startDrag(event, lane, row, channel, frame, scale));
            }
            lane.append(key);
        });
        return lane;
    }

    /**
     * Scrolls a record into view (centered) unless it is fully visible.
     * @param {number} row
     */
    scrollToRow(row) {
        const rowHeight = this._rowHeight();
        const top = row * rowHeight;
        const { scrollTop, clientHeight } = this._body;
        if (top < scrollTop || top + rowHeight > scrollTop + clientHeight) {
            this._body.scrollTop = top - (clientHeight - rowHeight) / 2;
        }
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
     * Selects the neighbouring whole frame and keeps it visible.
     * @param {-1 | 1} step
     */
    _stepFrame(step) {
        const { from, to } = this._data.range();
        const current = this._data.currentFrame();
        const next = Math.min(to, Math.max(from, step > 0 ? Math.floor(current + 1e-6) + 1 : Math.ceil(current - 1e-6) - 1));
        if (next === current) return;
        this._selectFrame(next);
        this._revealX(this._frameToX(next));
    }

    /**
     * @param {number} frame
     */
    _selectFrame(frame) {
        this._data.selectFrame(frame);
        this._handlers.onSelectFrame?.(frame);
        this.refresh();
    }

    /**
     * @param {PointerEvent} event
     * @param {SVGElement} lane
     * @param {number} row
     * @param {number} channel
     * @param {number} frame
     * @param {{ min: number, max: number }} scale
     */
    _startDrag(event, lane, row, channel, frame, scale) {
        event.preventDefault();
        event.stopPropagation();
        // Measured before selecting re-renders the rows (the lane element is replaced then)
        const top = lane.getBoundingClientRect().top;
        const keyBounds = /** @type {Element} */ (event.target).getBoundingClientRect();
        const keyX = keyBounds.left + keyBounds.width / 2;
        this._closeEditor(true);
        this._element.focus();
        this._drag = { row, channel, frame, scale, before: this._data.capture(row) };
        if (this.selectedRow !== row) this.selectRow(row);
        this._selectFrame(frame);
        const height = this._laneHeight();
        const toValue = clientY => scale.max - (clientY - top - TOP_PADDING) / (height - TOP_PADDING - BOTTOM_PADDING) * (scale.max - scale.min);
        // A click without moving opens the value editor instead of changing the key
        let moved = false;
        const move = (moveEvent) => {
            if (!this._drag) return;
            if (!moved && Math.abs(moveEvent.clientY - event.clientY) < DRAG_THRESHOLD) return;
            moved = true;
            const value = toValue(moveEvent.clientY);
            this._data.setKey(row, channel, frame, value);
            this.refresh();
            this._showValue(channel, frame, value, event.clientX, moveEvent.clientY - KEY_RADIUS);
        };
        const end = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', end);
            window.removeEventListener('pointercancel', end);
            const drag = this._drag;
            this._drag = null;
            this._hideValue();
            if (drag && moved) {
                const after = this._data.capture(row);
                this._handlers.onDragCommit(this._data, row, `Move ${this._data.channels[channel].label} key`, drag.before, after);
            }
            this.refresh();
            if (drag && !moved) this._openEditor(row, channel, frame, keyX, keyBounds.top);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', end);
        window.addEventListener('pointercancel', end);
    }

    /**
     * Shows the value of a key above the given point (viewport coordinates).
     * @param {number} channel
     * @param {number} frame
     * @param {number} value
     * @param {number} x
     * @param {number} y
     */
    _showValue(channel, frame, value, x, y) {
        const { label, color } = this._data.channels[channel];
        const bounds = this._element.getBoundingClientRect();
        this._valueLabel.textContent = `${label} = ${formatNumber(value, 3)} · frame ${formatNumber(frame)}`;
        this._valueLabel.style.borderColor = color;
        this._valueLabel.classList.remove('curves__value--hidden');
        // Kept inside the widget so it is not clipped at the edges
        const width = this._valueLabel.offsetWidth;
        const left = Math.min(bounds.width - width - 2, Math.max(2, x - bounds.left - width / 2));
        this._valueLabel.style.left = `${left}px`;
        this._valueLabel.style.top = `${Math.max(2, y - bounds.top - this._valueLabel.offsetHeight - 4)}px`;
    }

    _hideValue() {
        this._valueLabel.classList.add('curves__value--hidden');
    }

    /**
     * Opens an input with the value of a key above it; Enter or blur commits (one undo
     * command), Escape cancels.
     * @param {number} row
     * @param {number} channel
     * @param {number} frame
     * @param {number} x viewport x of the key
     * @param {number} y viewport top of the key
     */
    _openEditor(row, channel, frame, x, y) {
        const { label, color } = this._data.channels[channel];
        const oldValue = this._data.sample(row, frame)[channel] ?? 0;
        const editor = document.createElement('div');
        editor.className = 'curves__editor';
        editor.style.borderColor = color;
        const caption = document.createElement('span');
        caption.textContent = `${label} · frame ${formatNumber(frame)}`;
        const input = document.createElement('input');
        input.className = 'curves__editor-input';
        input.value = formatNumber(oldValue);
        editor.append(caption, input);
        this._element.append(editor);
        this._editor = { element: editor, commit: () => {
            const value = Number(input.value);
            if (input.value.trim() === '' || !Number.isFinite(value) || value === oldValue) return;
            const before = this._data.capture(row);
            this._data.setKey(row, channel, frame, value);
            this._handlers.onDragCommit(this._data, row, `Change ${label} key`, before, this._data.capture(row));
        } };
        const bounds = this._element.getBoundingClientRect();
        const left = Math.min(bounds.width - editor.offsetWidth - 2, Math.max(2, x - bounds.left - editor.offsetWidth / 2));
        editor.style.left = `${left}px`;
        editor.style.top = `${Math.max(2, y - bounds.top - editor.offsetHeight - 4)}px`;
        input.addEventListener('keydown', (event) => {
            event.stopPropagation();
            if (event.key === 'Enter') this._closeEditor(true);
            if (event.key === 'Escape') this._closeEditor(false);
        });
        input.addEventListener('blur', () => this._closeEditor(true));
        input.focus();
        input.select();
    }

    /**
     * @param {boolean} commit
     */
    _closeEditor(commit) {
        const editor = this._editor;
        if (!editor) return;
        this._editor = null;
        if (commit) editor.commit();
        editor.element.remove();
        this.refresh();
    }

    /** Escape during a drag restores the record and records nothing. */
    _cancelDrag() {
        const drag = this._drag;
        if (!drag) return;
        this._drag = null;
        this._data.restore(drag.row, drag.before);
        this._hideValue();
        this.refresh();
    }
}
