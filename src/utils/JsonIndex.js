/**
 * Index of the JSON values of a document by path (`['meshes', 0, 'position']`), with their
 * offsets in the text, so a value can be replaced in place and a text change can be mapped back
 * to the value it touched. Bulky values (arrays of primitives, `keys` arrays, long strings) are
 * leaves: the index of a model of tens of MB stays at a few thousand nodes.
 */

/** Arrays under these keys are leaves even when they hold objects (animation keys). */
const LEAF_ARRAY_KEYS = new Set(['keys']);

const QUOTE = 34;
const BACKSLASH = 92;

/**
 * @typedef {object} JsonNode
 * @property {(string | number)[]} path
 * @property {number} start offset of the value
 * @property {number} end offset after the value
 * @property {'object' | 'array' | 'leaf'} kind
 * @property {JsonNode | null} parent
 * @property {JsonNode[]} children in document order
 */

/**
 * @param {string} text
 * @param {number} start index of the opening quote
 * @returns {number} index after the closing quote
 */
function stringEnd(text, start) {
    for (let index = start + 1; index < text.length; index++) {
        const code = text.charCodeAt(index);
        if (code === BACKSLASH) index++;
        else if (code === QUOTE) return index + 1;
    }
    return text.length;
}

/**
 * @param {string} text
 * @param {number} start index of `[` or `{`
 * @returns {number} index after the matching bracket
 */
function containerEnd(text, start) {
    let depth = 0;
    for (let index = start; index < text.length; index++) {
        const char = text[index];
        if (char === '"') {
            index = stringEnd(text, index) - 1;
        } else if (char === '[' || char === '{') {
            depth++;
        } else if (char === ']' || char === '}') {
            depth--;
            if (depth === 0) return index + 1;
        }
    }
    return text.length;
}

/**
 * @param {string} text
 * @param {number} index
 * @returns {number} index of the next non-whitespace character
 */
function skipSpace(text, index) {
    while (index < text.length && /\s/.test(text[index])) index++;
    return index;
}

/**
 * @param {string} text
 * @param {number} start index of the first character of a primitive
 * @returns {number} index after it
 */
function primitiveEnd(text, start) {
    let index = start;
    while (index < text.length && !/[\s,\]}]/.test(text[index])) index++;
    return index;
}

/**
 * Whether an array holds only primitives (no nested arrays or objects).
 * @param {string} text
 * @param {number} start index of `[`
 * @param {number} end index after `]`
 * @returns {boolean}
 */
function isFlatArray(text, start, end) {
    for (let index = start + 1; index < end - 1; index++) {
        const char = text[index];
        if (char === '"') index = stringEnd(text, index) - 1;
        else if (char === '[' || char === '{') return false;
    }
    return true;
}

export class JsonIndex {

    /**
     * @param {string} text
     */
    constructor(text) {
        /** @type {JsonNode | null} */
        this.root = null;
        this.rebuild(text);
    }

    /**
     * Indexes the whole text. Throws on text that is not a JSON object or array.
     * @param {string} text
     */
    rebuild(text) {
        const start = skipSpace(text, 0);
        if (text[start] !== '{' && text[start] !== '[') throw new Error('The document is not a JSON object');
        this.root = this._scan(text, start, [], null);
    }

    /**
     * @param {(string | number)[]} path
     * @returns {JsonNode | null}
     */
    find(path) {
        let node = this.root;
        for (const key of path) {
            node = node?.children.find(child => child.path[child.path.length - 1] === key) ?? null;
            if (!node) return null;
        }
        return node;
    }

    /**
     * Deepest node whose value contains the range.
     * @param {number} start
     * @param {number} end
     * @returns {JsonNode | null}
     */
    nodeAt(start, end) {
        let node = this.root;
        if (!node || start < node.start || end > node.end) return null;
        for (;;) {
            const child = node.children.find(candidate => candidate.start <= start && end <= candidate.end);
            if (!child) return node;
            node = child;
        }
    }

    /**
     * Updates the index after a text change inside one value: the value is re-indexed and the
     * following nodes are shifted. Returns the changed node, or null when the change was not
     * inside a single value (the caller rebuilds the index then).
     * @param {string} text the new document text
     * @param {number} offset start of the replaced range in the old text
     * @param {number} length length of the replaced range in the old text
     * @param {number} insertedLength length of the new text
     * @returns {JsonNode | null}
     */
    applyChange(text, offset, length, insertedLength) {
        const delta = insertedLength - length;
        // A change at the edge of a value (e.g. a key added after the last one) may belong to the
        // enclosing container: try the deepest value first, then its ancestors
        for (let node = this.nodeAt(offset, offset + length); node && node !== this.root; node = node.parent) {
            const rescanned = this._rescan(text, node, delta);
            if (!rescanned) continue;
            this._shift(this.root, node, delta);
            const siblings = node.parent.children;
            siblings[siblings.indexOf(node)] = rescanned;
            return rescanned;
        }
        return null;
    }

    /**
     * @param {string} text the new document text
     * @param {JsonNode} node value that contains the change
     * @param {number} delta length change
     * @returns {JsonNode | null} the re-indexed value, null when the change went beyond it
     */
    _rescan(text, node, delta) {
        // Whitespace typed before the value moves its start
        if (skipSpace(text, node.start) !== node.start) return null;
        try {
            const rescanned = this._scan(text, node.start, node.path, node.parent);
            // The value must still end where the change says it ends (no separator was touched)
            return rescanned.end === node.end + delta ? rescanned : null;
        } catch {
            return null;
        }
    }

    /**
     * Shifts the nodes after `changed` by `delta` and grows its ancestors.
     * @param {JsonNode} node
     * @param {JsonNode} changed
     * @param {number} delta
     */
    _shift(node, changed, delta) {
        if (node === changed) return;
        if (node.start >= changed.end) {
            node.start += delta;
            node.end += delta;
        } else if (node.end >= changed.end) {
            node.end += delta;
        }
        node.children.forEach(child => this._shift(child, changed, delta));
    }

    /**
     * @param {string} text
     * @param {number} start index of the value
     * @param {(string | number)[]} path
     * @param {JsonNode | null} parent
     * @returns {JsonNode}
     */
    _scan(text, start, path, parent) {
        const char = text[start];
        /** @type {JsonNode} */
        const node = { path, start, end: start, kind: 'leaf', parent, children: [] };
        if (char === '"') {
            node.end = stringEnd(text, start);
            return node;
        }
        if (char !== '{' && char !== '[') {
            node.end = primitiveEnd(text, start);
            if (node.end === start) throw new Error(`Unexpected character at ${start}`);
            return node;
        }
        const end = containerEnd(text, start);
        node.end = end;
        const key = path[path.length - 1];
        if (char === '[' && (LEAF_ARRAY_KEYS.has(key) || isFlatArray(text, start, end))) return node;
        node.kind = char === '{' ? 'object' : 'array';
        let index = skipSpace(text, start + 1);
        let item = 0;
        while (index < end - 1) {
            let childKey = item;
            if (node.kind === 'object') {
                if (text[index] !== '"') throw new Error(`Expected a key at ${index}`);
                const keyEnd = stringEnd(text, index);
                childKey = JSON.parse(text.slice(index, keyEnd));
                index = skipSpace(text, keyEnd);
                if (text[index] !== ':') throw new Error(`Expected ':' at ${index}`);
                index = skipSpace(text, index + 1);
            }
            const child = this._scan(text, index, [...path, childKey], node);
            node.children.push(child);
            item++;
            index = skipSpace(text, child.end);
            if (text[index] === ',') index = skipSpace(text, index + 1);
        }
        return node;
    }
}
