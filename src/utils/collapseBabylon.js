/**
 * Collapsing of bulky `.babylon` JSON for the text editor: vertex buffers, animation keys and
 * long strings (embedded textures) are cut out and replaced by placeholders like `"…#12"`.
 * Fragments keep their original text byte for byte, so restoring them is lossless. The scan is
 * a single pass over the text (no parse tree: a model has millions of numbers).
 */

/** Properties whose array value is cut out. */
const CUT_ARRAY_KEYS = new Set([
    'positions', 'normals', 'tangents', 'colors', 'indices',
    'uvs', 'uvs2', 'uvs3', 'uvs4', 'uvs5', 'uvs6',
    'matricesIndices', 'matricesIndicesExtra', 'matricesWeights', 'matricesWeightsExtra',
    'keys',
]);

/** Arrays shorter than this (in characters) stay in the text. */
const MIN_ARRAY_LENGTH = 64;
/** String values longer than this (e.g. base64 textures) are cut out whatever their key. */
const MIN_STRING_LENGTH = 1024;
/** Keys longer than this are not remembered (only short property names matter). */
const MAX_KEY_LENGTH = 128;

const QUOTE = 34;
const BACKSLASH = 92;

/** Matches a placeholder token; group 1 is the fragment id. */
export const PLACEHOLDER_PATTERN = /"…#(\d+)"/g;

/**
 * @typedef {object} CollapsedFragment
 * @property {string} text original JSON text of the value
 * @property {string} key property the value belongs to
 * @property {'array' | 'string'} kind
 * @property {number} size items of an array, characters of a string
 * @property {number} start offset of the value in the collapsed source text
 * @property {number} end offset after the value
 */

/**
 * @param {number} id
 * @returns {string}
 */
export function placeholder(id) {
    return `"…#${id}"`;
}

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
 * Number of top-level items of an array text.
 * @param {string} text `[...]`
 * @returns {number}
 */
function countItems(text) {
    if (/^\[\s*\]$/.test(text)) return 0;
    let depth = 0, items = 1;
    for (let index = 0; index < text.length; index++) {
        const char = text[index];
        if (char === '"') index = stringEnd(text, index) - 1;
        else if (char === '[' || char === '{') depth++;
        else if (char === ']' || char === '}') depth--;
        else if (char === ',' && depth === 1) items++;
    }
    return items;
}

/**
 * Cuts the bulky values out of a `.babylon` JSON text.
 * @param {string} text
 * @returns {{ text: string, fragments: Map<number, CollapsedFragment> }} text with placeholders (not formatted)
 */
export function collapseBabylon(text) {
    /** @type {Map<number, CollapsedFragment>} */
    const fragments = new Map();
    const parts = [];
    let copied = 0;
    // Property whose value starts next (set by `:`, cleared when a value or a new key starts)
    let pendingKey = null;
    let lastString = null;
    const cut = (start, end, key, kind) => {
        const id = fragments.size + 1;
        const fragmentText = text.slice(start, end);
        fragments.set(id, { text: fragmentText, key, kind, size: kind === 'array' ? countItems(fragmentText) : end - start - 2, start, end });
        parts.push(text.slice(copied, start), placeholder(id));
        copied = end;
    };
    for (let index = 0; index < text.length; index++) {
        const char = text[index];
        if (char === '"') {
            const end = stringEnd(text, index);
            if (pendingKey !== null && end - index > MIN_STRING_LENGTH) {
                cut(index, end, pendingKey, 'string');
                pendingKey = null;
            } else {
                lastString = end - index <= MAX_KEY_LENGTH ? text.slice(index + 1, end - 1) : null;
            }
            index = end - 1;
        } else if (char === ':') {
            pendingKey = lastString;
        } else if (char === '[') {
            if (pendingKey !== null && CUT_ARRAY_KEYS.has(pendingKey)) {
                const end = containerEnd(text, index);
                if (end - index >= MIN_ARRAY_LENGTH) {
                    cut(index, end, pendingKey, 'array');
                    index = end - 1;
                }
            }
            pendingKey = null;
        } else if (char === '{' || char === ',') {
            pendingKey = null;
        }
    }
    parts.push(text.slice(copied));
    return { text: parts.join(''), fragments };
}

/**
 * Puts the fragments back in place of their placeholders. Other text (formatting, edits)
 * is kept as is.
 * @param {string} text edited text with placeholders
 * @param {Map<number, CollapsedFragment>} fragments
 * @returns {{ text: string, used: Set<number>, unknown: number[] }} unknown - placeholder ids without a fragment
 */
export function restoreFragments(text, fragments) {
    const used = new Set();
    const unknown = [];
    const restored = text.replace(PLACEHOLDER_PATTERN, (match, id) => {
        const fragment = fragments.get(Number(id));
        if (!fragment) {
            unknown.push(Number(id));
            return match;
        }
        used.add(Number(id));
        return fragment.text;
    });
    return { text: restored, used, unknown };
}

/**
 * Pretty-prints JSON text without re-serializing values (numbers keep their exact text).
 * Arrays of primitives stay on one line.
 * @param {string} text
 * @param {string} [indent]
 * @param {string} [prefix] put before every line but the first (to insert the value into indented text)
 * @param {number} [inlineObjects] objects without nested objects whose compact text is at most this
 *   long stay on one line (e.g. animation keys); 0 expands all objects
 * @returns {string}
 */
export function formatJson(text, indent = '  ', prefix = '', inlineObjects = 0) {
    const out = [];
    let depth = 0;
    const newline = () => out.push('\n', prefix, indent.repeat(depth));
    for (let index = 0; index < text.length; index++) {
        const char = text[index];
        if (char === '"') {
            const end = stringEnd(text, index);
            out.push(text.slice(index, end));
            index = end - 1;
        } else if (char === '{' || char === '[') {
            const end = containerEnd(text, index);
            const inner = text.slice(index + 1, end - 1);
            if (inner.trim() === '') {
                out.push(char, char === '{' ? '}' : ']');
                index = end - 1;
            } else if (char === '[' && isFlat(inner)) {
                out.push('[', compactItems(inner), ']');
                index = end - 1;
            } else if (char === '{' && end - index <= inlineObjects * 2 && isShallow(inner) && compactItems(inner).length <= inlineObjects) {
                out.push('{', compactItems(inner), '}');
                index = end - 1;
            } else {
                out.push(char);
                depth++;
                newline();
            }
        } else if (char === '}' || char === ']') {
            depth--;
            newline();
            out.push(char);
        } else if (char === ',') {
            out.push(',');
            newline();
        } else if (char === ':') {
            out.push(': ');
        } else if (!/\s/.test(char)) {
            out.push(char);
        }
    }
    return out.join('');
}

/**
 * @param {string} inner array content
 * @returns {boolean} whether it has no nested arrays or objects
 */
function isFlat(inner) {
    for (let index = 0; index < inner.length; index++) {
        const char = inner[index];
        if (char === '"') index = stringEnd(inner, index) - 1;
        else if (char === '[' || char === '{') return false;
    }
    return true;
}

/**
 * @param {string} inner object content
 * @returns {boolean} whether it has no nested objects and its arrays are flat
 */
function isShallow(inner) {
    let depth = 0;
    for (let index = 0; index < inner.length; index++) {
        const char = inner[index];
        if (char === '"') index = stringEnd(inner, index) - 1;
        else if (char === '{') return false;
        else if (char === '[' && ++depth > 1) return false;
        else if (char === ']') depth--;
    }
    return true;
}

/**
 * @param {string} inner content of a flat array or a shallow object
 * @returns {string} items separated by ", " (and keys by ": ")
 */
function compactItems(inner) {
    const out = [];
    for (let index = 0; index < inner.length; index++) {
        const char = inner[index];
        if (char === '"') {
            const end = stringEnd(inner, index);
            out.push(inner.slice(index, end));
            index = end - 1;
        } else if (char === ',') {
            out.push(', ');
        } else if (char === ':') {
            out.push(': ');
        } else if (!/\s/.test(char)) {
            out.push(char);
        }
    }
    return out.join('');
}
