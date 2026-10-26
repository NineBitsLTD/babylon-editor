import * as BABYLON from '@babylonjs/core';
import { hasRuntimeStartKey } from './AnimationController';
import { BABYLON_FILE_SCHEMA, MATERIAL_TEXTURE_SLOTS } from './BabylonFileSchema';

/**
 * A JSON path in the `.babylon` document, e.g. `['meshes', 0, 'position']`.
 * @typedef {(string | number)[]} JsonPath
 */

/**
 * A change of one value of the document.
 * @typedef {object} JsonPatch
 * @property {JsonPath} path
 * @property {any} value new value in the `.babylon` format
 */

/**
 * One value of the document bound to the loaded model.
 * @typedef {object} BoundValue
 * @property {JsonPath} path
 * @property {() => any} get current value of the model in the `.babylon` format
 * @property {(value: any) => (void | false)} set applies a value from the document to the model;
 *   false means it cannot be applied in place (the model is reloaded)
 * @property {boolean} [bulky] large value (vertex buffer, animation keys): compared only when marked changed
 * @property {() => string} [signature] cheap text compared instead of the serialized value (get is
 *   called only when it changed), for values that are large but rarely change (a texture slot)
 */

/** Top-level properties shown in the model tree (or holding vertex data); the others are file fields. */
const TREE_KEYS = new Set(['meshes', 'transformNodes', 'materials', 'multiMaterials', 'skeletons', 'geometries', 'cameras', 'lights', 'shadowGenerators', 'animationGroups']);

/**
 * A top-level value of the document that has no model object (producer, autoClear, clearColor, …).
 * @typedef {object} DocumentField
 * @property {JsonPath} path
 * @property {() => any} get
 * @property {((value: any) => void) | null} set null for summarized values (arrays of objects: get returns "N items")
 * @property {import('./BabylonFileSchema').SchemaField} [schema] the format's description of the field
 */

/** Texture fields written back to the document (the ones the inspector edits). */
const TEXTURE_FIELDS = ['level', 'hasAlpha', 'getAlphaFromRGB', 'coordinatesMode', 'uScale', 'vScale', 'uOffset', 'vOffset', 'uAng', 'vAng', 'wAng', 'coordinatesIndex', 'wrapU', 'wrapV'];

/** Vertex buffers the editor can change, by `.babylon` mesh property. */
const VERTEX_KINDS = {
    positions: BABYLON.VertexBuffer.PositionKind,
    normals: BABYLON.VertexBuffer.NormalKind,
    uvs: BABYLON.VertexBuffer.UVKind,
};

/**
 * Shortest decimal that reads back as the same 32-bit float, so values taken from Float32 buffers
 * (vertices, matrices) are written as `0.1` rather than `0.10000000149011612`.
 * @param {number} value
 * @returns {number}
 */
export function float32(value) {
    if (!Number.isFinite(value) || Number.isInteger(value)) return value;
    const target = Math.fround(value);
    for (let digits = 1; digits <= 9; digits++) {
        const candidate = Number(value.toPrecision(digits));
        if (Math.fround(candidate) === target) return candidate;
    }
    return value;
}

/**
 * @param {ArrayLike<number>} values
 * @returns {number[]}
 */
function float32Array(values) {
    return Array.from(values, float32);
}

/**
 * `JSON.stringify` replacer for values serialized by Babylon: typed arrays (e.g. the Float32Array of
 * a matrix, which JSON writes as an object `{"0": …}`) become arrays, numbers their shortest float32
 * decimals.
 * @param {string} key
 * @param {any} value
 * @returns {any}
 */
export function babylonJsonReplacer(key, value) {
    if (ArrayBuffer.isView(value) && !(value instanceof DataView)) return float32Array(/** @type {ArrayLike<number>} */ (value));
    return typeof value === 'number' ? float32(value) : value;
}

/**
 * @param {BABYLON.AssetContainer} container
 * @returns {Map<object, Set<string>>} the properties each node has animations for (its own and
 *   those of animation groups)
 */
function animatedProperties(container) {
    /** @type {Map<object, Set<string>>} */
    const animated = new Map();
    const add = (target, property) => {
        if (!animated.has(target)) animated.set(target, new Set());
        animated.get(target).add(property);
    };
    for (const node of [...container.meshes, ...container.transformNodes]) {
        node.animations?.forEach(animation => add(node, animation.targetProperty));
    }
    for (const group of container.animationGroups) {
        group.targetedAnimations.forEach(({ target, animation }) => add(target, animation.targetProperty));
    }
    return animated;
}

/**
 * @param {JsonPath} path
 * @returns {string}
 */
function pathKey(path) {
    return JSON.stringify(path);
}

/**
 * @param {JsonPath} prefix
 * @param {JsonPath} path
 * @returns {boolean}
 */
function startsWith(path, prefix) {
    return prefix.length <= path.length && prefix.every((key, index) => key === path[index]);
}

/**
 * @param {any} value
 * @param {JsonPath} path relative path
 * @returns {any} the nested value, undefined when it is missing
 */
function valueAt(value, path) {
    return path.reduce((current, key) => (current == null ? undefined : current[key]), value);
}

/**
 * @param {BABYLON.Animation} animation
 * @returns {any[]} keys in the `.babylon` format
 */
export function serializeKeys(animation) {
    const keys = animation.serialize().keys;
    // A key Babylon added at frame 0 while playing is not written
    if (hasRuntimeStartKey(animation.getKeys())) keys.shift();
    if (animation.dataType === BABYLON.Animation.ANIMATIONTYPE_MATRIX) {
        keys.forEach((key) => { key.values = float32Array(key.values); });
    }
    return keys;
}

/**
 * @param {BABYLON.Animation} animation
 * @param {any[]} keys in the `.babylon` format
 */
function parseKeys(animation, keys) {
    const parsed = BABYLON.Animation.Parse({
        name: animation.name,
        property: animation.targetProperty,
        framePerSecond: animation.framePerSecond,
        dataType: animation.dataType,
        loopBehavior: animation.loopMode,
        keys,
    });
    animation.setKeys(parsed.getKeys(), true);
}

/**
 * Binds the values of a `.babylon` document to the model loaded from it, in both directions:
 * `collect` turns the changes the editor made to the model into patches of the document,
 * `apply` puts patches of the document (typed text, undo) into the model. The values are read
 * in the `.babylon` format (Babylon's own serializers where they exist), and a value is only
 * patched when it changed, so the rest of the document keeps its exact text.
 */
export class BabylonJsonBinding {

    /**
     * @param {any} json the parsed document
     * @param {BABYLON.AssetContainer} container model loaded from it
     * @param {BABYLON.Scene} scene
     * @param {string} rootUrl base of relative texture urls
     */
    constructor(json, container, scene, rootUrl) {
        /** @type {any} the document as loaded: its structure (array places) is that of the text until the next reload */
        this.document = json;
        this._scene = scene;
        this._rootUrl = rootUrl;
        /** @type {Map<string, BoundValue>} */
        this._values = new Map();
        /** @type {Map<string, string>} last known text of the non-bulky values */
        this._baseline = new Map();
        /** @type {Set<string>} bulky values changed by the editor */
        this._dirty = new Set();
        // Snapshots shared by the values of one object during a collect (e.g. material.serialize())
        /** @type {Map<object, any>} */
        this._snapshots = new Map();
        this._applying = false;
        /** @type {Map<object, JsonPath>} path of each bound model object in the document */
        this._paths = new Map();
        /** @type {Map<BABYLON.BaseTexture, any>} texture objects of the document, by the loaded texture */
        this._textureSources = new Map();
        /** @type {Map<BABYLON.Node | BABYLON.Skeleton | BABYLON.Material, number>} `uniqueId` of nodes (`parentId` refers to it), skeletons and materials in the document */
        this._fileUniqueIds = new Map();
        // The highest uniqueId of the document's nodes: new nodes take the ones above it
        this._maxFileUniqueId = Math.max(-1, ...['meshes', 'transformNodes', 'cameras', 'lights']
            .flatMap(kind => json[kind] ?? []).map(object => Number(object?.uniqueId)).filter(Number.isFinite));
        /** @type {DocumentField[]} */
        this.documentFields = [];
        /** @type {JsonPatch[]} patches of values that are not compared (queuePatch), sent by the next collect */
        this._queued = [];
        /** @type {any[]} shared geometries of the document (`geometryId` of a mesh refers to one) */
        this._geometries = Array.isArray(json.geometries?.vertexData) ? json.geometries.vertexData : [];
        this._bindDocument(json);
        this._bindMeshes(json, container);
        this._bindMaterials(json, container);
        // Multi-materials: their place (tree commands) and name; meshes refer to them by uniqueId too
        (json.multiMaterials ?? []).forEach((source, index) => {
            const multi = container.multiMaterials?.find(candidate => candidate.id === source.id);
            if (!multi) return;
            this._paths.set(multi, ['multiMaterials', index]);
            this._bind(['multiMaterials', index, 'name'], () => multi.name, (value) => { multi.name = value; });
            // The material of each sub-mesh index, by id; a changed list in the text reloads the model
            this._bind(['multiMaterials', index, 'materials'], () => multi.subMaterials.map(material => material?.id ?? ''), () => false);
            // The loader reads these first when the file has them
            if (Array.isArray(source.materialsUniqueIds)) {
                this._bind(['multiMaterials', index, 'materialsUniqueIds'], () => multi.subMaterials.map(material => (material ? this._fileUniqueIds.get(material) ?? null : null)), () => false);
            }
            if (Number.isFinite(Number(source.uniqueId))) this._fileUniqueIds.set(multi, Number(source.uniqueId));
        });
        this._bindSkeletons(json, container);
        this._bindAnimationGroups(json, container);
        this._bindSerialized(json.cameras, container.cameras, 'cameras');
        this._bindSerialized(json.lights, container.lights, 'lights');
        this._bindShadowGenerators(json, container);
        for (const [key, value] of this._values) {
            if (!value.bulky) this._baseline.set(key, value.signature?.() ?? JSON.stringify(value.get()));
        }
        /** @type {Set<string>} bound values the document has (the others are added by a change) */
        this._present = new Set([...this._values.keys()].filter(key => valueAt(json, JSON.parse(key)) !== undefined));
        this._snapshots.clear();
    }

    /**
     * @param {JsonPath} path
     * @returns {boolean} whether the document has a value at the path (a field can also be unset)
     */
    isInDocument(path) {
        return this._present.has(pathKey(path));
    }

    /**
     * Writes a value that is not compared (e.g. the position of a node an animation drives, whose
     * current value is the playing pose) with the next collect. A value that is compared is left to
     * the comparison.
     * @param {object} object a bound model object
     * @param {string} key
     * @param {any} value in the `.babylon` format
     * @returns {boolean} whether the object has a place in the document
     */
    queuePatch(object, key, value) {
        const base = this._paths.get(object);
        if (!base) return false;
        const path = [...base, key];
        if (this._values.has(pathKey(path))) return true;
        this._queued.push({ path, value });
        this._present.add(pathKey(path));
        return true;
    }

    /**
     * @param {BABYLON.Mesh} mesh
     * @returns {(string | number)[] | null} the path of the object holding the vertex arrays of a mesh:
     *   the mesh, or its shared geometry (`geometryId`, converted glTF models)
     */
    vertexHolderPath(mesh) {
        const base = this._paths.get(mesh);
        if (!base) return null;
        const source = base.reduce((value, key) => value?.[key], this.document);
        const geometryIndex = this._geometries.findIndex(geometry => geometry?.id === source?.geometryId);
        return geometryIndex >= 0 && !Array.isArray(source?.positions) ? ['geometries', 'vertexData', geometryIndex] : base;
    }

    /**
     * Writes a vertex array of a mesh (or of its shared geometry) with the next collect, e.g. the
     * bone influences, which are not compared.
     * @param {BABYLON.Mesh} mesh
     * @param {string} property e.g. `matricesIndices`
     * @param {any} value
     * @returns {boolean} whether the mesh has a place in the document
     */
    queueVertexPatch(mesh, property, value) {
        const holder = this.vertexHolderPath(mesh);
        if (!holder) return false;
        this._queued.push({ path: [...holder, property], value });
        return true;
    }

    /**
     * @param {BABYLON.Node} node
     * @returns {number | null} the `uniqueId` the node has in the document (`parentId` of its children)
     */
    fileUniqueIdOf(node) {
        return this._fileUniqueIds.get(node) ?? null;
    }

    /**
     * @returns {number} a `uniqueId` no node of the document has (each call gives another)
     */
    nextFileUniqueId() {
        return ++this._maxFileUniqueId;
    }

    /**
     * @param {object} object a model object (mesh, material, texture, camera, light, shadow generator, skeleton)
     * @returns {JsonPath | null} its place in the document
     */
    pathOf(object) {
        return this._paths.get(object) ?? null;
    }

    /**
     * Patches for the values the editor changed since the last collect.
     * @returns {JsonPatch[]}
     */
    collect() {
        /** @type {JsonPatch[]} */
        const patches = this._queued;
        this._queued = [];
        for (const [key, value] of this._values) {
            if (value.bulky) {
                if (this._dirty.has(key)) patches.push({ path: value.path, value: value.get() });
                continue;
            }
            if (value.signature) {
                const signature = value.signature();
                if (signature === this._baseline.get(key)) continue;
                this._baseline.set(key, signature);
                this._present.add(key);
                patches.push({ path: value.path, value: value.get() });
                continue;
            }
            const text = JSON.stringify(value.get());
            if (text === this._baseline.get(key) || text === undefined) continue;
            this._baseline.set(key, text);
            this._present.add(key);
            patches.push({ path: value.path, value: JSON.parse(text) });
        }
        this._dirty.clear();
        this._snapshots.clear();
        return patches;
    }

    /**
     * Applies patches of the document to the model.
     * @param {JsonPatch[]} patches
     * @returns {boolean} false when a patch touches something that is not bound (e.g. a mesh was
     *   added): the model has to be reloaded from the document then
     */
    apply(patches) {
        this._applying = true;
        try {
            for (const patch of patches) {
                if (!this._applyPatch(patch)) return false;
            }
            return true;
        } catch (error) {
            console.error('[BabylonEditor] Failed to apply a document change', error);
            return false;
        } finally {
            this._applying = false;
            this._snapshots.clear();
        }
    }

    /**
     * @param {JsonPatch} patch
     * @returns {boolean}
     */
    _applyPatch({ path, value }) {
        const exact = this._values.get(pathKey(path));
        if (exact) {
            if (value === undefined) return false;
            this._present.add(pathKey(path));
            return this._setValue(exact, value);
        }
        // A whole object was replaced (e.g. a bone): apply the bound values inside it
        const inside = [...this._values.values()].filter(bound => startsWith(bound.path, path));
        if (inside.length) {
            for (const bound of inside) {
                const nested = valueAt(value, bound.path.slice(path.length));
                if (nested === undefined || !this._setValue(bound, nested)) return false;
            }
            return true;
        }
        // A part of a bound value changed (e.g. one property of a texture of a material)
        const outer = [...this._values.values()].find(bound => startsWith(path, bound.path));
        if (!outer || outer.bulky || outer.signature) return false;
        const current = JSON.parse(this._baseline.get(pathKey(outer.path)) ?? 'null');
        if (current == null || typeof current !== 'object') return false;
        const relative = path.slice(outer.path.length);
        let target = current;
        relative.slice(0, -1).forEach((key) => { target = target?.[key]; });
        if (target == null || typeof target !== 'object') return false;
        target[relative[relative.length - 1]] = value;
        return this._setValue(outer, current);
    }

    /**
     * @param {BoundValue} bound
     * @param {any} value
     * @returns {boolean} false when the value cannot be applied in place
     */
    _setValue(bound, value) {
        if (bound.set(value) === false) return false;
        const key = pathKey(bound.path);
        if (bound.bulky) {
            this._dirty.delete(key);
        } else {
            this._baseline.set(key, bound.signature?.() ?? JSON.stringify(value));
        }
        return true;
    }

    /**
     * @param {JsonPath} path
     * @param {() => any} get
     * @param {(value: any) => void} set
     * @param {boolean} [bulky]
     * @param {() => string} [signature]
     */
    _bind(path, get, set, bulky = false, signature = undefined) {
        this._values.set(pathKey(path), { path, get, set, bulky, signature });
    }

    /**
     * Wraps a method of one object so a call marks a bulky value changed (edits from the editor;
     * the document's own changes are applied with `_applying` set).
     * @param {object} target
     * @param {string} method
     * @param {(args: any[]) => JsonPath | null} pathOf
     */
    _track(target, method, pathOf) {
        const original = target[method];
        const binding = this;
        target[method] = function (...args) {
            const result = original.apply(this, args);
            const path = pathOf(args);
            if (path && !binding._applying) binding._dirty.add(pathKey(path));
            return result;
        };
    }

    /**
     * File fields: top-level values outside the model tree, kept as document values (editing them
     * changes the text only; the editor scene keeps its own background, fog, etc.).
     * @param {any} json
     */
    _bindDocument(json) {
        // The fields of the format first, also those the file does not have
        const schema = BABYLON_FILE_SCHEMA.scene;
        for (const field of schema) this._bindDocumentValue([field.key], json[field.key], true, field);
        for (const [key, value] of Object.entries(json)) {
            if (TREE_KEYS.has(key) || schema.some(field => field.key === key)) continue;
            if (value && typeof value === 'object' && !Array.isArray(value)) {
                // An object of simple values (e.g. producer): one field per value
                for (const [subKey, subValue] of Object.entries(value)) {
                    this._bindDocumentValue([key, subKey], subValue, isSimple(subValue));
                }
            } else {
                this._bindDocumentValue([key], value, isSimple(value));
            }
        }
    }

    /**
     * @param {JsonPath} path
     * @param {any} initial undefined when the document has no value
     * @param {boolean} editable
     * @param {import('./BabylonFileSchema').SchemaField} [schema]
     */
    _bindDocumentValue(path, initial, editable, schema) {
        if (!editable) {
            // Arrays of objects (cameras, lights, …) are only summarized; a change reloads the model
            const summary = Array.isArray(initial) ? `${initial.length} item${initial.length === 1 ? '' : 's'}` : 'object';
            this.documentFields.push({ path, get: () => summary, set: null });
            return;
        }
        let current = initial;
        const get = () => current;
        const set = (value) => { current = value; };
        this._bind(path, get, set);
        this.documentFields.push({ path, get, set, schema });
    }

    /**
     * @param {any} json
     * @param {BABYLON.AssetContainer} container
     */
    _bindMeshes(json, container) {
        const nodes = [...container.meshes, ...container.transformNodes];
        this._animated = animatedProperties(container);
        const used = new Set();
        for (const kind of ['meshes', 'transformNodes']) {
            (json[kind] ?? []).forEach((source, index) => {
                const node = nodes.find(candidate => !used.has(candidate) && candidate.id === source.id)
                    ?? nodes.find(candidate => !used.has(candidate) && candidate.name === source.name);
                if (!node) return;
                used.add(node);
                this._bindNode([kind, index], source, node);
            });
        }
    }

    /**
     * @param {JsonPath} base
     * @param {any} source
     * @param {BABYLON.TransformNode} node
     */
    _bindNode(base, source, node) {
        this._paths.set(node, base);
        if (Number.isFinite(Number(source.uniqueId))) this._fileUniqueIds.set(node, Number(source.uniqueId));
        const at = key => [...base, key];
        this._bind(at('name'), () => node.name, (value) => { node.name = value; });
        // A channel an animation drives shows the playing pose, not the value of the file: it is
        // not compared (a text change of it reloads the model)
        const animated = this._animated.get(node) ?? new Set();
        if (!animated.has('position')) this._bind(at('position'), () => node.position.asArray(), value => node.position.fromArray(value));
        if (source.rotationQuaternion && !animated.has('rotationQuaternion')) {
            this._bind(at('rotationQuaternion'), () => node.rotationQuaternion?.asArray() ?? null, (value) => {
                node.rotationQuaternion = value ? BABYLON.Quaternion.FromArray(value) : null;
            });
        }
        if (!animated.has('rotation')) this._bind(at('rotation'), () => node.rotation.asArray(), value => node.rotation.fromArray(value));
        if (!animated.has('scaling')) this._bind(at('scaling'), () => node.scaling.asArray(), value => node.scaling.fromArray(value));
        this._bind(at('isEnabled'), () => node.isEnabled(false), value => node.setEnabled(value));
        if (!(node instanceof BABYLON.AbstractMesh)) return;
        this._bind(at('isVisible'), () => node.isVisible, (value) => { node.isVisible = value; });
        this._bindSchema(base, node, BABYLON_FILE_SCHEMA.mesh);
        this._bind(at('materialId'), () => node.material?.id ?? source.materialId ?? '', (value) => {
            node.material = this._scene.getMaterialById(value) ?? this._scene.getMultiMaterialById?.(value) ?? null;
        });
        // Babylon links the material by its uniqueId in the file first: it follows a changed material
        // (null for a material without one, which is then found by id); a text change of it reloads
        if (source.materialUniqueId != null) {
            this._bind(at('materialUniqueId'), () => (node.material ? this._fileUniqueIds.get(node.material) ?? null : null), () => false);
        }
        // The skeleton that deforms the mesh (its vertices refer to the bones by index)
        this._bind(at('skeletonId'), () => node.skeleton?.id ?? null, (value) => {
            node.skeleton = value == null ? null : this._scene.getLastSkeletonById(value) ?? null;
        });
        // Babylon links the skeleton by its uniqueId in the file first: it follows a changed skeleton
        // (null for a skeleton without one, which is then found by id); a text change of it reloads
        if (source.skeletonUniqueId != null) {
            this._bind(at('skeletonUniqueId'), () => (node.skeleton ? this._fileUniqueIds.get(node.skeleton) ?? null : null), () => false);
        }
        if (node instanceof BABYLON.Mesh) {
            // Vertices are in the mesh object, or in a shared geometry of the document (`geometryId`,
            // e.g. converted glTF models), bound once for the meshes sharing it
            const geometryIndex = this._geometries.findIndex(geometry => geometry?.id === source.geometryId);
            const vertexPath = (property) => {
                if (Array.isArray(source[property])) return at(property);
                if (geometryIndex >= 0 && Array.isArray(this._geometries[geometryIndex][property])) return ['geometries', 'vertexData', geometryIndex, property];
                return null;
            };
            for (const [property, kind] of Object.entries(VERTEX_KINDS)) {
                const path = vertexPath(property);
                if (!path || this._values.has(pathKey(path))) continue;
                const stride = BABYLON.VertexBuffer.DeduceStride(kind);
                this._bind(path, () => float32Array(node.getVerticesData(kind) ?? []), (value) => {
                    node.setVerticesData(kind, value, true, stride);
                    if (kind === BABYLON.VertexBuffer.PositionKind) node.refreshBoundingInfo();
                }, true);
            }
            this._track(node, 'setVerticesData', ([kind]) => {
                const property = Object.keys(VERTEX_KINDS).find(key => VERTEX_KINDS[key] === kind);
                return property ? vertexPath(property) : null;
            });
        }
        this._bindAnimations(base, source, node);
    }

    /**
     * Fields of the format for an object (simple values: booleans, numbers, strings).
     * @param {JsonPath} base
     * @param {object} object
     * @param {import('./BabylonFileSchema').SchemaField[]} fields
     */
    _bindSchema(base, object, fields) {
        for (const field of fields) {
            const property = field.property ?? field.key;
            if (!field.get && !(property in object)) continue;
            if (!['boolean', 'number', 'string', 'enum'].includes(field.type)) continue;
            const read = field.get ?? (target => target[property]);
            const write = field.set ?? ((target, value) => { target[property] = value; });
            this._bind([...base, field.key], () => read(object), value => write(object, value));
        }
    }

    /**
     * Keys of the animations stored on a node or a bone.
     * @param {JsonPath} base
     * @param {any} source
     * @param {BABYLON.Node | BABYLON.Bone} target
     */
    _bindAnimations(base, source, target) {
        (source.animations ?? []).forEach((_, index) => {
            const animation = target.animations?.[index];
            if (animation) this._bindKeys([...base, 'animations', index, 'keys'], animation);
        });
        if (source.ranges && target.getAnimationRanges) {
            this._bind([...base, 'ranges'], () => serializeRanges(target), () => false);
        }
    }

    /**
     * Animation groups (glTF clips): the keys of their animations and their frame window. A
     * targeted animation is matched by its target id and animation name, since the loader skips
     * those whose target is missing.
     * @param {any} json
     * @param {BABYLON.AssetContainer} container
     */
    _bindAnimationGroups(json, container) {
        const used = new Set();
        (json.animationGroups ?? []).forEach((source, index) => {
            const group = container.animationGroups.find(candidate => candidate.name === source.name && !used.has(candidate));
            if (!group) return;
            used.add(group);
            const base = ['animationGroups', index];
            // Its place: a clip of a converted glTF model is deleted with it
            this._paths.set(group, base);
            const matched = new Set();
            (source.targetedAnimations ?? []).forEach((targeted, targetIndex) => {
                const found = group.targetedAnimations.find(candidate => !matched.has(candidate)
                    && candidate.target?.id === targeted.targetId && candidate.animation.name === targeted.animation?.name);
                if (!found) return;
                matched.add(found);
                this._bindKeys([...base, 'targetedAnimations', targetIndex, 'animation', 'keys'], found.animation);
            });
            // The clips are built from the window: a changed window in the text reloads the model
            if (source.from !== undefined) this._bind([...base, 'from'], () => group.from, () => false);
            if (source.to !== undefined) this._bind([...base, 'to'], () => group.to, () => false);
        });
    }

    /**
     * @param {JsonPath} path
     * @param {BABYLON.Animation} animation
     */
    _bindKeys(path, animation) {
        this._bind(path, () => serializeKeys(animation), value => parseKeys(animation, value), true);
        this._track(animation, 'setKeys', () => path);
    }

    /**
     * Materials are read with Babylon's serializer and changed with its parser, key by key.
     * @param {any} json
     * @param {BABYLON.AssetContainer} container
     */
    _bindMaterials(json, container) {
        (json.materials ?? []).forEach((source, index) => {
            const material = container.materials.find(candidate => candidate.id === source.id);
            if (!material) return;
            this._paths.set(material, ['materials', index]);
            if (Number.isFinite(Number(source.uniqueId))) this._fileUniqueIds.set(material, Number(source.uniqueId));
            const snapshot = () => {
                if (!this._snapshots.has(material)) this._snapshots.set(material, material.serialize());
                return this._snapshots.get(material);
            };
            const slots = new Set(MATERIAL_TEXTURE_SLOTS[material.getClassName()] ?? []);
            for (const [key, serialized] of Object.entries(material.serialize())) {
                if (key === 'id' || key === 'customType' || key === 'uniqueId') continue;
                // Textures change while they load (url, readiness): only their edited fields are bound
                if (material[key] instanceof BABYLON.BaseTexture) {
                    this._bindTexture(['materials', index, key], material[key], serialized);
                    if (source[key] && typeof source[key] === 'object') this._textureSources.set(material[key], source[key]);
                    slots.add(key);
                    continue;
                }
                this._bind(['materials', index, key], () => snapshot()[key] ?? null, (value) => {
                    BABYLON.SerializationHelper.Parse(() => material, { [key]: value }, this._scene, this._rootUrl);
                    if (key === 'name') material.name = value;
                });
            }
            slots.forEach(slot => this._bindTextureSlot(['materials', index, slot], material, slot));
        });
    }

    /**
     * Which texture a material slot refers to. In the format every material holds its own texture
     * objects, so a texture put into the slot (picked in the inspector) is written as a copy of the
     * texture's object in the document; a document change of the whole slot reloads the model.
     * @param {JsonPath} path
     * @param {BABYLON.Material} material
     * @param {string} slot
     */
    _bindTextureSlot(path, material, slot) {
        const original = material[slot] ?? null;
        // A copy carries the current values of the fields the inspector edits
        const fields = texture => Object.fromEntries(TEXTURE_FIELDS.filter(field => field in texture).map(field => [field, texture[field]]));
        const get = () => {
            const texture = material[slot];
            if (!texture) return null;
            const source = this._textureSources.get(texture) ?? texture.serialize();
            return texture === original ? source : { ...source, ...fields(texture) };
        };
        // Embedded images make texture objects large: they are serialized only when the slot changed
        const signature = () => {
            const texture = material[slot];
            if (!texture) return 'none';
            return texture === original ? 'original' : `${texture.uniqueId}:${JSON.stringify(fields(texture))}`;
        };
        this._bind(path, get, () => false, false, signature);
    }

    /**
     * The fields of a texture the inspector edits; renaming a texture (another image) reloads the model.
     * @param {JsonPath} base
     * @param {BABYLON.BaseTexture} texture
     * @param {any} source serialized texture
     */
    _bindTexture(base, texture, source) {
        if (!this._paths.has(texture)) this._paths.set(texture, base);
        for (const field of TEXTURE_FIELDS) {
            if (!(field in texture)) continue;
            this._bind([...base, field], () => texture[field], (value) => { texture[field] = value; });
        }
        this._bind([...base, 'name'], () => texture.name, value => (value === texture.name ? undefined : false));
    }

    /**
     * Cameras and lights: read with their serializer, changed with Babylon's parser, key by key.
     * @param {any[] | undefined} sources the document's array
     * @param {(BABYLON.Camera | BABYLON.Light)[]} objects loaded objects
     * @param {string} kind document property
     */
    _bindSerialized(sources, objects, kind) {
        (sources ?? []).forEach((source, index) => {
            const object = objects.find(candidate => candidate.id === source.id) ?? objects.find(candidate => candidate.name === source.name);
            if (!object) return;
            this._paths.set(object, [kind, index]);
            const snapshot = () => {
                if (!this._snapshots.has(object)) this._snapshots.set(object, object.serialize());
                return this._snapshots.get(object);
            };
            for (const key of Object.keys(object.serialize())) {
                if (key === 'id' || key === 'uniqueId' || key === 'type' || key === 'tags') continue;
                this._bind([kind, index, key], () => snapshot()[key] ?? null, (value) => {
                    BABYLON.SerializationHelper.Parse(() => object, { [key]: value }, this._scene, this._rootUrl);
                    if (key === 'name') object.name = value;
                    if (key === 'isEnabled' && 'setEnabled' in object) object.setEnabled(value);
                });
            }
        });
    }

    /**
     * @param {any} json
     * @param {BABYLON.AssetContainer} container
     */
    _bindShadowGenerators(json, container) {
        (json.shadowGenerators ?? []).forEach((source, index) => {
            const light = container.lights.find(candidate => candidate.id === source.lightId);
            const generator = light?.getShadowGenerator?.();
            if (!generator) return;
            const at = key => ['shadowGenerators', index, key];
            this._paths.set(generator, ['shadowGenerators', index]);
            this._bindSchema(['shadowGenerators', index], generator, BABYLON_FILE_SCHEMA.shadowGenerator);
            this._bind(at('bias'), () => generator.bias, (value) => { generator.bias = value; });
            this._bind(at('normalBias'), () => generator.normalBias, (value) => { generator.normalBias = value; });
            this._bind(at('darkness'), () => generator.getDarkness(), value => generator.setDarkness(value));
        });
    }

    /**
     * @param {any} json
     * @param {BABYLON.AssetContainer} container
     */
    _bindSkeletons(json, container) {
        (json.skeletons ?? []).forEach((source, index) => {
            const skeleton = container.skeletons.find(candidate => candidate.id === source.id) ?? container.skeletons[index];
            if (!skeleton) return;
            const base = ['skeletons', index];
            this._paths.set(skeleton, base);
            if (Number.isFinite(Number(source.uniqueId))) this._fileUniqueIds.set(skeleton, Number(source.uniqueId));
            this._bindSchema(base, skeleton, BABYLON_FILE_SCHEMA.skeleton);
            this._bind([...base, 'name'], () => skeleton.name, (value) => { skeleton.name = value; });
            // Clips keep the range objects, so changed ranges are applied by reloading the model
            this._bind([...base, 'ranges'], () => serializeRanges(skeleton), () => false);
            // Skeleton.Parse creates the bones in the order of the document
            (source.bones ?? []).forEach((boneSource, boneIndex) => {
                const bone = skeleton.bones[boneIndex];
                if (!bone) return;
                const at = key => [...base, 'bones', boneIndex, key];
                this._bind(at('name'), () => bone.name, (value) => { bone.name = value; });
                this._bind(at('matrix'), () => float32Array(bone.getBindMatrix().asArray()), (value) => {
                    bone.updateMatrix(BABYLON.Matrix.FromArray(value), true, false);
                    bone.markAsDirty();
                });
                this._bind(at('rest'), () => float32Array(bone.getRestMatrix().asArray()), (value) => {
                    bone.setRestMatrix(BABYLON.Matrix.FromArray(value));
                });
                const animation = bone.animations[0];
                if (boneSource.animation && animation) this._bindKeys([...base, 'bones', boneIndex, 'animation', 'keys'], animation);
            });
        });
    }
}

/**
 * @param {any} value
 * @returns {boolean} a value the inspector can edit: a primitive or a short array of numbers
 */
function isSimple(value) {
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return true;
    return Array.isArray(value) && value.length >= 2 && value.length <= 4 && value.every(item => typeof item === 'number');
}

/**
 * @param {BABYLON.Skeleton | BABYLON.Node} owner
 * @returns {{ name: string, from: number, to: number }[]}
 */
function serializeRanges(owner) {
    return owner.getAnimationRanges().filter(Boolean).map(({ name, from, to }) => ({ name, from, to }));
}
