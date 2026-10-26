import { formatBytes } from '../utils/formatBytes';

/**
 * A read-only field of a model file shown in the inspector before an item is selected.
 * @typedef {object} FileField
 * @property {string} label
 * @property {string | number | boolean} value
 */

const GLB_MAGIC = 0x46546c67;
const GLB_JSON_CHUNK = 0x4e4f534a;
/** glTF collections summarized by their size. */
const GLTF_COLLECTIONS = ['scenes', 'nodes', 'meshes', 'materials', 'textures', 'images', 'samplers', 'skins', 'animations', 'accessors', 'bufferViews', 'buffers', 'cameras'];

/**
 * @param {Uint8Array} bytes
 * @returns {any | null} the JSON chunk of a GLB file
 */
function glbJson(bytes) {
    if (bytes.byteLength < 20) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== GLB_MAGIC || view.getUint32(16, true) !== GLB_JSON_CHUNK) return null;
    const length = view.getUint32(12, true);
    return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + length)));
}

/**
 * @param {any} json glTF document
 * @returns {FileField[]}
 */
function gltfFields(json) {
    /** @type {FileField[]} */
    const fields = Object.entries(json.asset ?? {})
        .filter(([, value]) => typeof value !== 'object')
        .map(([key, value]) => ({ label: `asset.${key}`, value }));
    if (json.extensionsUsed?.length) fields.push({ label: 'extensionsUsed', value: json.extensionsUsed.join(', ') });
    if (json.extensionsRequired?.length) fields.push({ label: 'extensionsRequired', value: json.extensionsRequired.join(', ') });
    if (Number.isInteger(json.scene)) fields.push({ label: 'scene', value: json.scene });
    for (const key of GLTF_COLLECTIONS) {
        if (Array.isArray(json[key])) fields.push({ label: key, value: json[key].length });
    }
    const embedded = (json.images ?? []).filter(image => image.bufferView !== undefined || image.uri?.startsWith('data:')).length;
    if (embedded) fields.push({ label: 'embedded images', value: embedded });
    const bytes = (json.buffers ?? []).reduce((sum, buffer) => sum + (buffer.byteLength ?? 0), 0);
    if (bytes) fields.push({ label: 'buffers size', value: formatBytes(bytes) });
    return fields;
}

/**
 * @param {string} text
 * @param {RegExp} pattern a multiline pattern with the `g` flag
 * @returns {number}
 */
function countLines(text, pattern) {
    return text.match(pattern)?.length ?? 0;
}

/**
 * @param {Uint8Array} bytes
 * @returns {FileField[]}
 */
function objFields(bytes) {
    const text = new TextDecoder().decode(bytes);
    const libraries = [...text.matchAll(/^\s*mtllib\s+(.+?)\s*$/gm)].map(match => match[1]);
    return [
        { label: 'mtllib', value: libraries.join(', ') || '—' },
        { label: 'objects (o)', value: countLines(text, /^\s*o\s/gm) },
        { label: 'groups (g)', value: countLines(text, /^\s*g\s/gm) },
        { label: 'vertices (v)', value: countLines(text, /^\s*v\s/gm) },
        { label: 'faces (f)', value: countLines(text, /^\s*f\s/gm) },
    ];
}

/**
 * @param {Uint8Array} bytes
 * @returns {FileField[]}
 */
function stlFields(bytes) {
    if (bytes.byteLength >= 84) {
        const count = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true);
        if (bytes.byteLength === 84 + count * 50) {
            const header = new TextDecoder().decode(bytes.subarray(0, 80)).replace(/\0+$/, '').trim();
            return [{ label: 'encoding', value: 'binary' }, { label: 'header', value: header || '—' }, { label: 'triangles', value: count }];
        }
    }
    const text = new TextDecoder().decode(bytes);
    return [
        { label: 'encoding', value: 'ASCII' },
        { label: 'solid', value: text.match(/^\s*solid\s*(.*)$/m)?.[1].trim() || '—' },
        { label: 'triangles', value: countLines(text, /^\s*facet\s/gm) },
    ];
}

/**
 * @param {Uint8Array} bytes
 * @returns {FileField[]}
 */
function plyFields(bytes) {
    const head = new TextDecoder().decode(bytes.subarray(0, 64 * 1024));
    const header = head.slice(0, head.indexOf('end_header'));
    const fields = [{ label: 'format', value: header.match(/^format\s+(.+)$/m)?.[1] ?? '—' }];
    for (const [, name, count] of header.matchAll(/^element\s+(\S+)\s+(\d+)$/gm)) {
        fields.push({ label: `element ${name}`, value: Number(count) });
    }
    const comments = [...header.matchAll(/^comment\s+(.*)$/gm)].map(match => match[1]);
    if (comments.length) fields.push({ label: 'comment', value: comments.join('; ') });
    return fields;
}

/**
 * Fields of a model file that the model tree does not show (asset info of glTF, the header of
 * OBJ/STL/PLY files). `.babylon` files show their top-level JSON values instead (editable,
 * through BabylonJsonBinding).
 */
export class FileInfo {

    /**
     * @param {string} type file extension without the dot
     * @param {ArrayBuffer | Uint8Array} data file content
     * @returns {FileField[]}
     */
    static read(type, data) {
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        /** @type {FileField[]} */
        const fields = [{ label: 'size', value: formatBytes(bytes.byteLength) }];
        try {
            switch (type) {
                case 'glb': {
                    const json = glbJson(bytes);
                    if (json) fields.push(...gltfFields(json));
                    break;
                }
                case 'gltf':
                case 'gltf2':
                    fields.push(...gltfFields(JSON.parse(new TextDecoder().decode(bytes))));
                    break;
                case 'obj':
                    fields.push(...objFields(bytes));
                    break;
                case 'stl':
                    fields.push(...stlFields(bytes));
                    break;
                case 'ply':
                    fields.push(...plyFields(bytes));
                    break;
            }
        } catch (error) {
            fields.push({ label: 'error', value: String(error?.message || error) });
        }
        return fields;
    }
}
