import { formatJson } from './collapseBabylon';

/** Objects without nested objects up to this length (animation keys) stay on one line, as conversions write them. */
const INLINE_OBJECT_LENGTH = 160;

/** Babylon's animation data types (`Animation.ANIMATIONTYPE_*`). */
const DATA_TYPE = { FLOAT: 0, VECTOR3: 1, QUATERNION: 2, MATRIX: 3, COLOR3: 4, VECTOR2: 5, SIZE: 6, COLOR4: 7 };

/**
 * @param {number[]} a
 * @param {number[]} b
 * @param {number} t
 * @returns {number[]} the linear interpolation
 */
function lerp(a, b, t) {
    return a.map((value, index) => value + (b[index] - value) * t);
}

/**
 * @param {number[]} a quaternion x, y, z, w
 * @param {number[]} b
 * @param {number} t
 * @returns {number[]} the spherical interpolation, as Babylon's `Quaternion.Slerp`
 */
function slerp(a, b, t) {
    let cos = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
    const sign = cos < 0 ? -1 : 1;
    cos *= sign;
    let from = 1 - t;
    let to = t * sign;
    if (cos < 0.999999) {
        const angle = Math.acos(cos);
        const sin = 1 / Math.sin(angle);
        from = Math.sin((1 - t) * angle) * sin;
        to = sign * Math.sin(t * angle) * sin;
    }
    return a.map((value, index) => value * from + b[index] * to);
}

/**
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number} the largest difference of the components
 */
function difference(a, b) {
    let largest = 0;
    for (let index = 0; index < a.length; index++) largest = Math.max(largest, Math.abs(a[index] - b[index]));
    return largest;
}

/**
 * @param {any} key a key in the `.babylon` format
 * @returns {number[]} its value as numbers
 */
function valuesOf(key) {
    return Array.isArray(key.values) ? key.values : [key.values];
}

/**
 * Makes `.babylon` documents smaller: written without line breaks, numbers rounded, animation keys
 * that the others give back removed. Works on the parsed document (the extension host has no Babylon).
 */
export class BabylonOptimizer {

    /**
     * @param {any} json
     * @param {boolean} minify without line breaks and indentation
     * @returns {string} the document text, as conversions write it (small objects such as keys on one line)
     */
    static format(json, minify) {
        const text = JSON.stringify(json);
        return minify ? text : formatJson(text, '  ', '', INLINE_OBJECT_LENGTH);
    }

    /**
     * @param {string} text a `.babylon` document
     * @returns {string} the same document without line breaks and indentation
     */
    static minify(text) {
        return JSON.stringify(JSON.parse(text));
    }

    /**
     * Rounds every number with a fraction to some decimals (vertex data, matrices, keys, colors…);
     * whole numbers (indices, ids) and texts (embedded images) stay.
     * @param {any} json changed in place
     * @param {number} digits decimals kept
     * @returns {number} the numbers changed
     */
    static roundNumbers(json, digits) {
        let changed = 0;
        const visit = (value) => {
            if (Array.isArray(value)) {
                for (let index = 0; index < value.length; index++) {
                    const item = value[index];
                    if (typeof item === 'number') {
                        const rounded = BabylonOptimizer._round(item, digits);
                        if (rounded !== item) {
                            value[index] = rounded;
                            changed++;
                        }
                    } else if (item && typeof item === 'object') {
                        visit(item);
                    }
                }
            } else if (value && typeof value === 'object') {
                for (const key of Object.keys(value)) {
                    const item = value[key];
                    if (typeof item === 'number') {
                        const rounded = BabylonOptimizer._round(item, digits);
                        if (rounded !== item) {
                            value[key] = rounded;
                            changed++;
                        }
                    } else if (item && typeof item === 'object') {
                        visit(item);
                    }
                }
            }
        };
        visit(json);
        return changed;
    }

    /**
     * Removes the animation keys the kept ones give back within a tolerance: a key between two
     * others that their interpolation reproduces (numbers, vectors and colors linearly,
     * quaternions spherically, as Babylon plays them), a matrix key equal to the one before it
     * (Babylon does not interpolate matrices: it holds a key until the next). The first and the last
     * key, keys at the edges of clips (ranges, animation groups) and animations with tangents or
     * stepped keys stay as they are.
     * @param {any} json changed in place
     * @param {number} tolerance the largest difference of a component
     * @returns {{ removed: number, total: number }}
     */
    static reduceKeys(json, tolerance) {
        const edges = BabylonOptimizer._clipEdges(json);
        let removed = 0;
        let total = 0;
        for (const animation of BabylonOptimizer._animations(json)) {
            total += animation.keys.length;
            const kept = BabylonOptimizer._reducedKeys(animation, tolerance, edges);
            removed += animation.keys.length - kept.length;
            animation.keys = kept;
        }
        return { removed, total };
    }

    /**
     * @param {number} value
     * @param {number} digits
     * @returns {number}
     */
    static _round(value, digits) {
        if (Number.isInteger(value) || !Number.isFinite(value)) return value;
        const rounded = Number(value.toFixed(digits));
        // No negative zero in the text
        return rounded === 0 ? 0 : rounded;
    }

    /**
     * @param {any} json
     * @returns {any[]} every animation of the document (bones, nodes, animation groups)
     */
    static _animations(json) {
        const found = [];
        const visit = (value) => {
            if (Array.isArray(value)) {
                value.forEach(visit);
            } else if (value && typeof value === 'object') {
                if (Array.isArray(value.keys) && typeof value.dataType === 'number' && typeof value.property === 'string') found.push(value);
                Object.values(value).forEach((item) => { if (item && typeof item === 'object') visit(item); });
            }
        };
        visit(json);
        return found;
    }

    /**
     * @param {any} json
     * @returns {Set<number>} the frames where clips begin or end (named ranges, animation groups)
     */
    static _clipEdges(json) {
        const edges = new Set();
        const visit = (value) => {
            if (Array.isArray(value)) {
                value.forEach(visit);
            } else if (value && typeof value === 'object') {
                if (Array.isArray(value.ranges)) value.ranges.forEach(range => { if (range) { edges.add(range.from); edges.add(range.to); } });
                if (Array.isArray(value.targetedAnimations) && typeof value.from === 'number') {
                    edges.add(value.from);
                    edges.add(value.to);
                }
                Object.values(value).forEach((item) => { if (item && typeof item === 'object' && !Array.isArray(item.values)) visit(item); });
            }
        };
        visit(json);
        return edges;
    }

    /**
     * @param {any} animation in the `.babylon` format
     * @param {number} tolerance
     * @param {Set<number>} edges frames whose keys stay
     * @returns {any[]} the keys kept
     */
    static _reducedKeys(animation, tolerance, edges) {
        const keys = animation.keys;
        if (keys.length < 3 || keys.some(key => key.inTangent !== undefined || key.outTangent !== undefined || key.interpolation !== undefined)) return keys;
        const fixed = index => index === 0 || index === keys.length - 1 || edges.has(keys[index].frame);
        if (animation.dataType === DATA_TYPE.MATRIX) {
            // A matrix is held until the next key: a key equal to the kept one before it adds nothing
            const kept = [keys[0]];
            for (let index = 1; index < keys.length; index++) {
                if (fixed(index) || difference(valuesOf(keys[index]), valuesOf(kept[kept.length - 1])) > tolerance) kept.push(keys[index]);
            }
            return kept;
        }
        const interpolate = animation.dataType === DATA_TYPE.QUATERNION ? slerp : lerp;
        const kept = [keys[0]];
        let anchor = 0;
        for (let end = 2; end < keys.length; end++) {
            // Can the keys between the last kept one and this one go?
            const start = keys[anchor];
            const last = keys[end];
            let fits = true;
            for (let middle = anchor + 1; middle < end && fits; middle++) {
                if (fixed(middle)) {
                    fits = false;
                    break;
                }
                const t = (keys[middle].frame - start.frame) / (last.frame - start.frame || 1);
                fits = difference(interpolate(valuesOf(start), valuesOf(last), t), valuesOf(keys[middle])) <= tolerance;
            }
            if (!fits) {
                anchor = end - 1;
                kept.push(keys[anchor]);
            }
        }
        kept.push(keys[keys.length - 1]);
        return kept;
    }
}
