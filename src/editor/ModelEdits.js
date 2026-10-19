import * as BABYLON from '@babylonjs/core';
import { MATERIAL_TEXTURE_SLOTS } from './BabylonFileSchema';
import { babylonJsonReplacer, serializeKeys } from './BabylonJsonBinding';
import { modelKeys } from './AnimationController';
import { ModelConverter } from './ModelConverter';

/**
 * An operation on the `.babylon` document that changes its structure.
 * @typedef {{ op: 'insert', arrayPath: (string | number)[], value: any }
 *   | { op: 'remove', path: (string | number)[] }
 *   | { op: 'set', path: (string | number)[], value: any }} DocumentOp
 */

/** Texture slots offered when an image is added, per material class. */
const TEXTURE_SLOTS = {
    StandardMaterial: ['diffuseTexture', 'bumpTexture', 'emissiveTexture', 'specularTexture', 'ambientTexture', 'opacityTexture'],
    PBRMaterial: ['albedoTexture', 'bumpTexture', 'emissiveTexture', 'metallicTexture', 'ambientTexture', 'opacityTexture'],
};

/** Container arrays and scene add/remove methods per kind of object. */
const COLLECTIONS = {
    mesh: ['meshes', 'addMesh', 'removeMesh'],
    transformNode: ['transformNodes', 'addTransformNode', 'removeTransformNode'],
    multiMaterial: ['multiMaterials', 'addMultiMaterial', 'removeMultiMaterial'],
    material: ['materials', 'addMaterial', 'removeMaterial'],
    texture: ['textures', 'addTexture', 'removeTexture'],
    skeleton: ['skeletons', 'addSkeleton', 'removeSkeleton'],
    camera: ['cameras', 'addCamera', 'removeCamera'],
    light: ['lights', 'addLight', 'removeLight'],
    animationGroup: ['animationGroups', 'addAnimationGroup', 'removeAnimationGroup'],
};

/**
 * An object copied to the clipboard (the host keeps it there as JSON): a skeleton in the
 * `.babylon` format, a node with its hierarchy (`CopiedNodes`) or a clip (`CopiedClip`).
 * @typedef {{ kind: 'skeleton' | 'node' | 'clip', value: any }} ClipboardObject
 */

/**
 * A clip: its tracks with the keys of its frame window, moved to start at frame 0. A track names its
 * target (a bone or a node) instead of an id, so it finds its target in another model.
 * @typedef {object} CopiedClip
 * @property {'timeline' | 'group'} type a frame range of the model's timeline (`.babylon` exports)
 *   or an animation group (glTF)
 * @property {string} name
 * @property {number} length frames from the first to the last
 * @property {{ target: { kind: 'bone' | 'node', name: string }, animation: any }[]} tracks animations
 *   in the `.babylon` format
 */

/**
 * What pasting a clip asks the host before it can go on, or reports when done.
 * @typedef {{ choose: 'skeleton', options: { id: string, label: string, description: string }[] } | { report: string }} PasteResult
 */

/** Key frames closer than this are one frame. */
const FRAME_EPSILON = 1e-6;

/**
 * @param {any} value an animated value (number, vector, quaternion, matrix, color)
 * @returns {any} a copy of it
 */
function cloneValue(value) {
    return value?.clone ? value.clone() : value;
}

/**
 * The keys of an animation inside a clip window, moved to start at frame 0; a window edge without
 * a key gets one with the interpolated value, so the clip plays the same alone.
 * @param {BABYLON.Animation} animation
 * @param {number} from
 * @param {number} to
 * @returns {BABYLON.IAnimationKey[]} empty when the animation does not move in the window
 */
function windowKeys(animation, from, to) {
    const keys = modelKeys(animation);
    if (!keys.length || keys[0].frame > to + FRAME_EPSILON || keys[keys.length - 1].frame < from - FRAME_EPSILON) return [];
    const inside = keys.filter(key => key.frame >= from - FRAME_EPSILON && key.frame <= to + FRAME_EPSILON)
        .map(key => ({ ...key, value: cloneValue(key.value) }));
    const edge = frame => ({ frame, value: cloneValue(animation.evaluate(frame)) });
    if (!inside.length || Math.abs(inside[0].frame - from) > FRAME_EPSILON) inside.unshift(edge(from));
    if (Math.abs(inside[inside.length - 1].frame - to) > FRAME_EPSILON) inside.push(edge(to));
    return inside.map(key => ({ ...key, frame: key.frame - from }));
}

/**
 * @param {any[]} keys keys in the `.babylon` format
 * @param {number} offset
 * @returns {any[]} the keys moved by offset frames
 */
function shiftKeys(keys, offset) {
    return keys.map(key => ({ ...key, frame: key.frame + offset }));
}

/**
 * A node, the nodes below it and what their meshes refer to, in the `.babylon` format; the first
 * node is the copied one. Meshes carry their own vertex data (no shared geometry). `parentId` is the
 * `id` of the parent (the format refers to the parent's `uniqueId`, which is set when pasting).
 * @typedef {object} CopiedNodes
 * @property {any[]} meshes
 * @property {any[]} transformNodes
 * @property {any[]} materials
 * @property {any[]} multiMaterials
 * @property {any[]} skeletons
 * @property {string} rootId id of the copied node
 */

/** Vertex data of a geometry that is not part of the mesh object (`Geometry.serializeVerticeData`). */
const GEOMETRY_ONLY_KEYS = new Set(['id', 'uniqueId', 'updatable']);
/** Runtime or scene references of a serialized mesh that a copy does not keep. */
const MESH_RUNTIME_KEYS = ['uniqueId', 'geometryId', 'geometryUniqueId', 'materialUniqueId', 'skeletonUniqueId', 'instances', 'morphTargetManagerId', 'parentInstanceIndex'];

/**
 * @param {string} name
 * @param {string[]} taken
 * @returns {string} the name, or `<name> copy`, `<name> copy 2`, … when it is taken
 */
function uniqueName(name, taken) {
    const used = new Set(taken);
    if (!used.has(name)) return name;
    for (let index = 1; ; index++) {
        const candidate = index === 1 ? `${name} copy` : `${name} copy ${index}`;
        if (!used.has(candidate)) return candidate;
    }
}

/**
 * @returns {string}
 */
function newId() {
    return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * @param {import('./ModelOutline').ModelItemData} data
 * @returns {any} the model object of a tree item
 */
export function objectOf(data) {
    switch (data.kind) {
        case 'node': return data.node;
        case 'material': return data.material;
        case 'texture': return data.texture;
        case 'skeleton': return data.skeleton;
        case 'clip': return data.clip;
        case 'camera': return data.camera;
        case 'light': return data.light;
        case 'shadowGenerator': return data.generator;
        default: return null;
    }
}

/**
 * @param {any} object
 * @returns {keyof typeof COLLECTIONS | null}
 */
function collectionOf(object) {
    if (object instanceof BABYLON.AbstractMesh) return 'mesh';
    if (object instanceof BABYLON.TransformNode) return 'transformNode';
    if (object instanceof BABYLON.MultiMaterial) return 'multiMaterial';
    if (object instanceof BABYLON.Material) return 'material';
    if (object instanceof BABYLON.BaseTexture) return 'texture';
    if (object instanceof BABYLON.Skeleton) return 'skeleton';
    if (object instanceof BABYLON.Camera) return 'camera';
    if (object instanceof BABYLON.Light) return 'light';
    if (object instanceof BABYLON.AnimationGroup) return 'animationGroup';
    return null;
}

/**
 * Structural edits from the context menu of the model tree: rename, delete, add, copy and paste objects.
 * For a `.babylon` text, delete and add become operations on the document (array items are
 * inserted or removed, references to the removed object are cleared) and the model is reloaded
 * from the text; renames are ordinary edits (patches). For other formats the scene is changed
 * directly, as undoable commands.
 */
export class ModelEdits {

    /**
     * @param {object} options
     * @param {BABYLON.Scene} options.scene
     * @param {() => BABYLON.AssetContainer | null} options.container
     * @param {import('./AnimationController').AnimationController} options.animations
     * @param {import('./EditHistory').EditHistory | import('./EditHistory').DocumentEditHistory} options.history
     * @param {() => import('./BabylonJsonBinding').BabylonJsonBinding | null} options.binding null for other formats
     * @param {string} options.rootUrl
     * @param {(label: string, ops: DocumentOp[]) => void} options.postOps writes document operations
     * @param {() => void} options.onStructureChange the tree and the clips have to be rebuilt
     * @param {(object: any, state: 'modified' | 'added') => void} options.markChanged for the tree decorations (formats other than .babylon)
     */
    constructor({ scene, container, animations, history, binding, rootUrl, postOps, onStructureChange, markChanged }) {
        this._markChanged = markChanged;
        this._scene = scene;
        this._container = container;
        this._animations = animations;
        this._history = history;
        this._binding = binding;
        this._rootUrl = rootUrl;
        this._postOps = postOps;
        this._onStructureChange = onStructureChange;
    }

    /**
     * @param {import('./ModelOutline').ModelItemData} data
     * @returns {{ label: string, canRename: boolean, dependents: string[] }}
     */
    info(data) {
        const object = objectOf(data);
        const container = this._container();
        const dependents = [];
        if (data.kind === 'material') {
            container.meshes.filter(mesh => mesh.material === object).forEach(mesh => dependents.push(`mesh ${mesh.name} loses its material`));
        } else if (data.kind === 'skeleton') {
            container.meshes.filter(mesh => mesh.skeleton === object).forEach(mesh => dependents.push(`mesh ${mesh.name} loses its skeleton`));
        } else if (data.kind === 'light' && object.getShadowGenerator?.()) {
            dependents.push('its shadow generator is deleted too');
        } else if (data.kind === 'texture') {
            container.materials.filter(material => material.hasTexture(object)).forEach(material => dependents.push(`material ${material.name} loses the texture`));
        } else if (data.kind === 'node') {
            const children = object.getChildren?.() ?? [];
            if (children.length) dependents.push(`${children.length} child node(s) become root nodes`);
        }
        return {
            label: data.kind === 'shadowGenerator' ? 'Shadow generator' : object?.name ?? '',
            canRename: !['shadowGenerator', 'texture'].includes(data.kind),
            dependents,
        };
    }

    /**
     * @returns {{ id: number, label: string, slots: string[] }[]} materials a new texture can be put into
     */
    textureTargets() {
        return this._container().materials
            .map(material => ({ id: material.uniqueId, label: material.name || '(unnamed)', slots: TEXTURE_SLOTS[material.getClassName()] ?? [] }))
            .filter(target => target.slots.length);
    }

    /**
     * @param {import('./ModelOutline').ModelItemData} data
     * @param {string} name
     */
    rename(data, name) {
        const object = objectOf(data);
        if (!object) return;
        if (data.kind === 'clip') {
            const old = object.name;
            this._history.executeMutation(`Rename ${old}`, () => old, () => this._animations.renameClip(object, name), previous => this._animations.renameClip(object, previous));
        } else {
            this._history.executeMutation(`Rename ${object.name}`, () => object.name, () => { object.name = name; }, (previous) => { object.name = previous; });
        }
        this._markChanged(object, 'modified');
    }

    /**
     * @param {import('./ModelOutline').ModelItemData} data
     */
    delete(data) {
        if (this._binding()) {
            this._postOps(`Delete ${this.info(data).label}`, this._deleteOps(data));
        } else {
            this._deleteInScene(data);
        }
    }

    /**
     * @param {string} section tree section (Nodes, Materials, Textures, Skeletons, Animations, Cameras, Lights)
     * @param {string} type one of the types the tree offers for the section (ModelTreeProvider)
     * @param {string} name
     * @param {{ image?: string, materialId?: number, slot?: string, from?: number, to?: number }} [extra]
     *   image - path relative to the model folder; materialId / slot - where a new texture goes;
     *   from / to - frame range of a new clip
     */
    add(section, type, name, extra = {}) {
        if (this._binding()) {
            this._postOps(`Add ${name}`, this._addOps(section, type, name, extra));
        } else {
            this._addToScene(section, type, name, extra);
        }
    }

    /**
     * Puts a new image into a texture. In a `.babylon` text the image is embedded: every texture
     * object of the document the texture was loaded from gets it as `base64String` (which the
     * format reads before `name`), an external image file is not changed; the model is reloaded
     * from the text. For other formats the texture loads the image as an undoable command.
     * @param {BABYLON.Texture} texture
     * @param {string} dataUrl the image as a base64 data url
     */
    replaceTextureImage(texture, dataUrl) {
        const label = `Replace the image of ${texture.name?.startsWith('data:') ? 'the texture' : texture.name || 'the texture'}`;
        const binding = this._binding();
        if (binding) {
            const paths = this._texturePaths(texture, binding);
            if (!paths.length) throw new Error('The texture is not used by a material, so the file has no place for its image');
            this._postOps(label, paths.map(path => ({ op: 'set', path: [...path, 'base64String'], value: dataUrl })));
            return;
        }
        // The buffer of an embedded image (e.g. of a glTF buffer) is private: it is restored as it was
        const previous = { url: texture.url, buffer: texture._buffer ?? null, name: texture.name };
        this._history.execute({
            label,
            apply: () => texture.updateURL(dataUrl),
            revert: () => {
                texture.updateURL(previous.url, previous.buffer);
                texture.name = previous.name;
            },
        });
        this._markChanged(texture, 'modified');
    }

    /**
     * @param {BABYLON.BaseTexture} texture
     * @param {import('./BabylonJsonBinding').BabylonJsonBinding} binding
     * @returns {(string | number)[][]} the texture objects of the document the texture was loaded
     *   from (each material holds its own copy)
     */
    _texturePaths(texture, binding) {
        const paths = [];
        for (const material of this._container().materials) {
            const path = binding.pathOf(material);
            if (!path) continue;
            // Slots of the format, and those of other material classes (stored as `_<slot>` behind a property)
            const slots = new Set([...(MATERIAL_TEXTURE_SLOTS[material.getClassName()] ?? []), ...Object.keys(material).map(key => key.replace(/^_/, ''))]);
            slots.forEach((slot) => { if (material[slot] === texture) paths.push([...path, slot]); });
        }
        return paths;
    }

    /**
     * The data of an object for the clipboard, to be pasted into this or another model.
     * @param {import('./ModelOutline').ModelItemData} data
     * @returns {ClipboardObject}
     */
    copy(data) {
        if (data.kind === 'skeleton') return { kind: 'skeleton', value: ModelEdits._copySkeleton(data.skeleton) };
        if (data.kind === 'node') return { kind: 'node', value: ModelEdits._copyNodes(data.node, this._container()) };
        if (data.kind === 'clip') return { kind: 'clip', value: ModelEdits._copyClip(data.clip, this._container()) };
        throw new Error('Only nodes, skeletons and clips can be copied');
    }

    /**
     * Pastes a copied object into a section of the tree (a new object; the copied one is not changed).
     * @param {string} section
     * @param {ClipboardObject} object
     * @param {boolean} [sameFile] it was copied from this model: the copy keeps sharing the materials,
     *   the skeletons and the parent of the original (another model gets copies of them)
     * @param {{ skeletonId?: string }} [choices] answers to a `PasteResult.choose` (the skeleton of a clip)
     * @returns {PasteResult | undefined}
     */
    paste(section, object, sameFile = false, choices = {}) {
        if (section === 'Skeletons' && object?.kind === 'skeleton') return this._pasteSkeleton(object.value);
        if (section === 'Nodes' && object?.kind === 'node') return this._pasteNodes(object.value, sameFile);
        if (section === 'Animations' && object?.kind === 'clip') return this._pasteClip(object.value, choices);
        throw new Error(`The clipboard has no object that can be pasted into ${section}`);
    }

    /**
     * A clip with the keys of its window. Morph target tracks are left out.
     * @param {import('./AnimationController').AnimationClip} clip
     * @param {BABYLON.AssetContainer} container
     * @returns {CopiedClip}
     */
    static _copyClip(clip, container) {
        if (clip.isTimeline) throw new Error('Copy a clip: the whole timeline is not a clip of the file');
        const tracks = [];
        for (const { animation, target } of clip.group.targetedAnimations) {
            const ref = target instanceof BABYLON.Bone ? { kind: 'bone', name: target.name }
                : target instanceof BABYLON.TransformNode ? { kind: 'node', name: target.name } : null;
            if (!ref) continue;
            const keys = windowKeys(animation, clip.from, clip.to);
            if (!keys.length) continue;
            const part = new BABYLON.Animation(animation.name, animation.targetProperty, animation.framePerSecond, animation.dataType, animation.loopMode);
            part.setKeys(keys);
            tracks.push({ target: ref, animation: part.serialize() });
        }
        if (!tracks.length) throw new Error(`${clip.name} has no keys to copy`);
        const type = container.animationGroups.includes(clip.group) ? 'group' : 'timeline';
        return JSON.parse(JSON.stringify({ type, name: clip.name, length: clip.to - clip.from, tracks }, babylonJsonReplacer));
    }

    /**
     * Adds a copied clip, its tracks finding their targets by name. A model keeps one kind of clips:
     * an animation group goes in as a new group, a frame range of a timeline as keys appended to the
     * end of the timeline of a skeleton (and of nodes) with a new range. Tracks without a target are
     * left out (the report names them).
     * @param {CopiedClip} source
     * @param {{ skeletonId?: string }} choices
     * @returns {PasteResult}
     */
    _pasteClip(source, choices) {
        if (!source || !Array.isArray(source.tracks) || !source.tracks.length) throw new Error('The copied clip has no tracks');
        const container = this._container();
        const groups = container.animationGroups.length > 0;
        const timeline = !groups && this._animations.clips.length > 0;
        if (source.type === 'group' && timeline) throw new Error('This model keeps its clips as frame ranges of one timeline: an animation group (glTF) cannot be pasted into it');
        if (source.type === 'timeline' && groups) throw new Error('This model keeps its clips as animation groups (glTF): a frame range of a timeline cannot be pasted into it');
        const name = uniqueName(source.name || 'Clip', this._animations.clips.map(clip => clip.name));
        const nodes = new Map([...container.transformNodes, ...container.meshes].map(node => [node.name, node]));
        let skeletons = container.skeletons;
        const boneTracks = source.tracks.filter(track => track.target?.kind === 'bone');
        if (boneTracks.length && skeletons.length > 1) {
            const chosen = skeletons.find(skeleton => String(skeleton.uniqueId) === choices.skeletonId);
            if (!chosen) {
                return {
                    choose: 'skeleton',
                    options: skeletons.map(skeleton => ({
                        id: String(skeleton.uniqueId),
                        label: skeleton.name || '(unnamed)',
                        description: `${boneTracks.filter(track => skeleton.bones.some(bone => bone.name === track.target.name)).length} of ${boneTracks.length} bones`,
                    })),
                };
            }
            skeletons = [chosen];
        }
        const skeleton = skeletons[0] ?? null;
        const targetOf = target => (target?.kind === 'bone' ? skeleton?.bones.find(bone => bone.name === target.name) : nodes.get(target?.name)) ?? null;
        const matched = source.tracks.map(track => ({ track, target: targetOf(track.target) })).filter(({ target }) => target);
        const missing = source.tracks.filter(track => !targetOf(track.target)).map(track => track.target?.name ?? '?');
        if (!matched.length) throw new Error(`No bone or node of this model has the names of the targets of ${source.name}`);
        if (source.type === 'group') {
            this._pasteGroup(name, source.length, matched);
        } else {
            this._pasteRange(name, source.length, matched, skeleton);
        }
        const unique = [...new Set(missing)];
        return { report: `Pasted ${name}: ${matched.length} of ${source.tracks.length} tracks${unique.length ? `; not found: ${unique.slice(0, 5).join(', ')}${unique.length > 5 ? ', …' : ''}` : ''}` };
    }

    /**
     * A copied animation group as a new group of the model.
     * @param {string} name
     * @param {number} length
     * @param {{ track: CopiedClip['tracks'][number], target: BABYLON.Node }[]} matched
     */
    _pasteGroup(name, length, matched) {
        const label = `Paste ${name}`;
        if (this._binding()) {
            const targeted = matched.filter(({ target }) => target.id != null && target.id !== '');
            if (!targeted.length) throw new Error('The targets of the clip have no ids in this file');
            this._postOps(label, [{
                op: 'insert',
                arrayPath: ['animationGroups'],
                value: { name, from: 0, to: length, targetedAnimations: targeted.map(({ track, target }) => ({ targetId: target.id, animation: track.animation })) },
            }]);
            return;
        }
        const group = new BABYLON.AnimationGroup(name, this._scene);
        matched.forEach(({ track, target }) => group.addTargetedAnimation(BABYLON.Animation.Parse(track.animation), target));
        group.normalize(0, length);
        // Created groups are already in the scene; the command adds it to the model
        this._detach(group);
        this._markChanged(group, 'added');
        this._structural(label, () => this._attach(group), () => this._detach(group));
    }

    /**
     * A copied frame range: its keys appended to the end of the timeline (one frame after its last
     * key; the clips there do not move) and a range of the new frames on each owner of the targets
     * (the skeleton, animated nodes). A target without an animation of the property gets one.
     * @param {string} name
     * @param {number} length
     * @param {{ track: CopiedClip['tracks'][number], target: BABYLON.Bone | BABYLON.TransformNode }[]} matched
     * @param {BABYLON.Skeleton | null} skeleton owner of the bone targets
     */
    _pasteRange(name, length, matched, skeleton) {
        const container = this._container();
        const animated = [...container.skeletons.flatMap(owner => owner.bones), ...container.meshes, ...container.transformNodes].flatMap(target => target.animations ?? []);
        const end = Math.max(-1, ...animated.map(animation => modelKeys(animation).at(-1)?.frame ?? -1));
        const offset = Math.floor(end) + 1;
        const range = { name, from: offset, to: offset + length };
        const owners = new Set(matched.map(({ target }) => (target instanceof BABYLON.Bone ? skeleton : target)));
        const label = `Paste ${name}`;
        const changes = matched.map(({ track, target }) => {
            const existing = target.animations.find(animation => animation.targetProperty === track.animation.property);
            return { track, target, existing: existing?.dataType === track.animation.dataType ? existing : null, keys: shiftKeys(track.animation.keys, offset) };
        }).filter(({ track, target }) => !target.animations.some(animation => animation.targetProperty === track.animation.property && animation.dataType !== track.animation.dataType));
        const binding = this._binding();
        if (binding) {
            const ops = [];
            for (const { track, target, existing, keys } of changes) {
                const base = target instanceof BABYLON.Bone
                    ? [...binding.pathOf(skeleton), 'bones', skeleton.bones.indexOf(target), 'animation']
                    : null;
                const nodePath = target instanceof BABYLON.Bone ? null : binding.pathOf(target);
                if (base) {
                    ops.push(existing
                        ? { op: 'set', path: [...base, 'keys'], value: [...serializeKeys(existing), ...keys] }
                        : { op: 'set', path: base, value: { ...track.animation, keys } });
                } else if (nodePath) {
                    const index = target.animations.indexOf(existing);
                    ops.push(existing
                        ? { op: 'set', path: [...nodePath, 'animations', index, 'keys'], value: [...serializeKeys(existing), ...keys] }
                        : { op: 'insert', arrayPath: [...nodePath, 'animations'], value: { ...track.animation, keys } });
                }
            }
            for (const owner of owners) {
                const ownerPath = binding.pathOf(owner);
                if (!ownerPath) continue;
                const ranges = (owner.getAnimationRanges?.() ?? []).filter(Boolean).map(({ name: rangeName, from, to }) => ({ name: rangeName, from, to }));
                ops.push({ op: 'set', path: [...ownerPath, 'ranges'], value: [...ranges, range] });
            }
            this._postOps(label, ops);
            return;
        }
        const applied = changes.map(({ track, target, existing, keys }) => {
            const parsed = BABYLON.Animation.Parse({ ...track.animation, keys });
            return { target, existing, previous: existing?.getKeys().slice() ?? null, added: existing ? null : parsed, keys: parsed.getKeys() };
        });
        this._structural(label, () => {
            for (const change of applied) {
                if (change.existing) change.existing.setKeys([...modelKeys(change.existing), ...change.keys], true);
                else change.target.animations.push(change.added);
            }
            owners.forEach(owner => owner.createAnimationRange(range.name, range.from, range.to));
        }, () => {
            owners.forEach(owner => owner.deleteAnimationRange(range.name, false));
            for (const change of applied) {
                if (change.existing) change.existing.setKeys(change.previous, true);
                else change.target.animations.splice(change.target.animations.indexOf(change.added), 1);
            }
        });
    }

    /**
     * A node with the whole hierarchy below it, the materials and the skeletons of its meshes.
     * Animation groups and morph targets are not copied; instances of meshes are left out.
     * @param {BABYLON.TransformNode} root
     * @param {BABYLON.AssetContainer} container
     * @returns {CopiedNodes}
     */
    static _copyNodes(root, container) {
        const own = new Set([...container.meshes, ...container.transformNodes]);
        const nodes = [root, ...root.getDescendants(false, node => own.has(node))];
        /** @type {CopiedNodes} */
        const json = { meshes: [], transformNodes: [], materials: [], multiMaterials: [], skeletons: [], rootId: root.id };
        const materials = new Set();
        const skeletons = new Set();
        // Babylon writes the parent as its runtime uniqueId: the copy refers to it by id
        const withParent = (serialized, node) => {
            if (node.parent) serialized.parentId = node.parent.id;
            else delete serialized.parentId;
            return serialized;
        };
        for (const node of nodes) {
            if (node instanceof BABYLON.Mesh) {
                const mesh = withParent(node.serialize(), node);
                // The vertex data of the geometry becomes the mesh's own
                for (const [key, value] of Object.entries(node.geometry?.serializeVerticeData() ?? {})) {
                    if (!GEOMETRY_ONLY_KEYS.has(key)) mesh[key] = value;
                }
                MESH_RUNTIME_KEYS.forEach(key => delete mesh[key]);
                json.meshes.push(mesh);
                if (node.material) materials.add(node.material);
                if (node.skeleton) skeletons.add(node.skeleton);
            } else if (!(node instanceof BABYLON.AbstractMesh)) {
                const transformNode = withParent(node.serialize(), node);
                delete transformNode.uniqueId;
                json.transformNodes.push(transformNode);
            }
        }
        for (const material of materials) {
            if (material instanceof BABYLON.MultiMaterial) {
                json.multiMaterials.push(material.serialize());
                material.subMaterials.filter(Boolean).forEach(subMaterial => materials.add(subMaterial));
            } else {
                json.materials.push(material.serialize());
            }
        }
        // The loader finds materials by uniqueId first: a copy must not take the original's
        [...json.materials, ...json.multiMaterials].forEach((material) => { delete material.uniqueId; });
        json.skeletons = [...skeletons].map(skeleton => ModelEdits._copySkeleton(skeleton));
        // As conversions write them: no default-material references, textures by name or embedded image
        ModelConverter.clean(json);
        return JSON.parse(JSON.stringify(json, babylonJsonReplacer));
    }

    /**
     * Adds a copy of nodes: new ids, a free name for the copied node, its parent kept when it was copied
     * from this model. Materials and skeletons are shared with the original in the same model, copied
     * (new ids, free names) into another one. For a `.babylon` text the objects are inserted into the
     * document (one undo step), else into the scene.
     * @param {CopiedNodes} source
     * @param {boolean} sameFile
     */
    _pasteNodes(source, sameFile) {
        const all = [...(source?.transformNodes ?? []), ...(source?.meshes ?? [])];
        if (!all.length || !Array.isArray(source.meshes) || !Array.isArray(source.transformNodes)) throw new Error('The copied node is empty');
        const container = this._container();
        const json = structuredClone(source);
        const document = !!this._binding();
        const nodes = [...json.transformNodes, ...json.meshes];
        const root = nodes.find(node => node.id === json.rootId) ?? nodes[0];
        root.name = uniqueName(root.name || 'Node', [...container.meshes, ...container.transformNodes].map(node => node.name));
        // Nodes: new ids; the copied node keeps its parent only in its own model
        const nodeIds = new Map(nodes.map(node => [node.id, newId()]));
        const targetNodes = new Set([...container.meshes, ...container.transformNodes].map(node => node.id));
        for (const node of nodes) {
            node.id = nodeIds.get(node.id);
            if (node.parentId != null && nodeIds.has(node.parentId)) {
                node.parentId = nodeIds.get(node.parentId);
            } else if (!(sameFile && targetNodes.has(node.parentId))) {
                delete node.parentId;
            }
        }
        const materialIds = this._pasteReferenced(json.materials, [...container.materials], sameFile, () => newId());
        const multiMaterialIds = this._pasteReferenced(json.multiMaterials, [...container.multiMaterials], sameFile, () => newId());
        json.multiMaterials.forEach((multi) => { multi.materials = (multi.materials ?? []).map(id => materialIds.get(id) ?? id); });
        const skeletonIds = this._pasteReferenced(json.skeletons, container.skeletons, sameFile, this._skeletonIdFactory(document));
        json.skeletons.forEach(skeleton => this._prepareSkeleton(skeleton, nodeIds));
        for (const mesh of json.meshes) {
            if (mesh.materialId != null) mesh.materialId = materialIds.get(mesh.materialId) ?? multiMaterialIds.get(mesh.materialId) ?? mesh.materialId;
            if (mesh.skeletonId != null) mesh.skeletonId = skeletonIds.get(mesh.skeletonId) ?? mesh.skeletonId;
        }
        const label = `Paste ${root.name}`;
        if (document) {
            this._toFileParents(nodes);
            this._postOps(label, [
                ...json.materials.map(value => ({ op: 'insert', arrayPath: ['materials'], value })),
                ...json.multiMaterials.map(value => ({ op: 'insert', arrayPath: ['multiMaterials'], value })),
                ...json.skeletons.map(value => ({ op: 'insert', arrayPath: ['skeletons'], value })),
                ...json.transformNodes.map(value => ({ op: 'insert', arrayPath: ['transformNodes'], value })),
                ...json.meshes.map(value => ({ op: 'insert', arrayPath: ['meshes'], value })),
            ]);
            return;
        }
        this._addParsed(label, json);
    }

    /**
     * Parents as the `.babylon` format writes them: every pasted node gets a free `uniqueId` of the
     * document and `parentId` refers to the parent's `uniqueId` (a parent of the model by its
     * `uniqueId` in the document, or by its id when it has none).
     * @param {any[]} nodes pasted nodes, `parentId` being the id of the parent
     */
    _toFileParents(nodes) {
        const binding = this._binding();
        const uniqueIds = new Map(nodes.map(node => [node.id, binding.nextFileUniqueId()]));
        const container = this._container();
        for (const node of nodes) {
            node.uniqueId = uniqueIds.get(node.id);
            if (node.parentId == null) continue;
            if (uniqueIds.has(node.parentId)) {
                node.parentId = uniqueIds.get(node.parentId);
                continue;
            }
            const parent = [...container.meshes, ...container.transformNodes].find(candidate => candidate.id === node.parentId);
            node.parentId = (parent && binding.fileUniqueIdOf(parent)) ?? node.parentId;
        }
    }

    /**
     * Gives copied materials or skeletons their place in the target model: in the model they were
     * copied from, an object that is still there is shared (left out of the copy), the others get a
     * new id and a free name.
     * @param {any[]} copies serialized objects; the shared ones are removed from it
     * @param {{ id: any, name: string }[]} existing the objects of the target model
     * @param {boolean} sameFile
     * @param {() => any} createId
     * @returns {Map<any, any>} new id by copied id
     */
    _pasteReferenced(copies, existing, sameFile, createId) {
        const ids = new Map();
        const names = existing.map(object => object.name);
        for (let index = copies.length - 1; index >= 0; index--) {
            const copy = copies[index];
            if (sameFile && existing.some(object => object.id === copy.id)) {
                copies.splice(index, 1);
                continue;
            }
            const id = createId();
            ids.set(copy.id, id);
            copy.id = id;
            copy.name = uniqueName(copy.name || 'object', names);
            names.push(copy.name);
        }
        return ids;
    }

    /**
     * @param {boolean} document
     * @returns {() => any} creates skeleton ids: numbers in a `.babylon` text (as the format writes them)
     */
    _skeletonIdFactory(document) {
        if (!document) return () => newId();
        let next = Math.max(-1, ...this._container().skeletons.map(skeleton => Number(skeleton.id)).filter(Number.isFinite)) + 1;
        return () => next++;
    }

    /**
     * Drops the runtime ids of a copied skeleton and the links of bones to nodes the target model
     * does not have; links to copied nodes follow their new ids.
     * @param {any} skeleton
     * @param {Map<any, any>} [nodeIds] new ids of nodes pasted with it
     */
    _prepareSkeleton(skeleton, nodeIds = new Map()) {
        const nodes = new Set([...this._container().transformNodes, ...this._container().meshes].map(node => node.id));
        delete skeleton.uniqueId;
        for (const bone of skeleton.bones ?? []) {
            delete bone.uniqueId;
            delete bone.linkedTransformNodeUniqueId;
            if (bone.linkedTransformNodeId == null) continue;
            if (nodeIds.has(bone.linkedTransformNodeId)) bone.linkedTransformNodeId = nodeIds.get(bone.linkedTransformNodeId);
            else if (!nodes.has(bone.linkedTransformNodeId)) delete bone.linkedTransformNodeId;
        }
    }

    /**
     * Adds parsed copies to the scene as one undoable command (formats other than `.babylon`).
     * @param {string} label
     * @param {CopiedNodes} json ids already resolved
     */
    _addParsed(label, json) {
        const scene = this._scene;
        const rootUrl = this._rootUrl;
        const created = [];
        const materials = json.materials.map(value => BABYLON.Material.Parse(value, scene, rootUrl));
        const multiMaterials = json.multiMaterials.map(value => BABYLON.MultiMaterial.ParseMultiMaterial(value, scene));
        const textures = [...materials, ...multiMaterials].flatMap(material => material.getActiveTextures?.() ?? []);
        // The parser links bones to nodes only while a file loads: the links are made below
        const links = json.skeletons.map(skeleton => skeleton.bones.map((bone) => {
            const id = bone.linkedTransformNodeId;
            delete bone.linkedTransformNodeId;
            return id;
        }));
        const skeletons = json.skeletons.map(value => BABYLON.Skeleton.Parse(value, scene));
        const transformNodes = json.transformNodes.map(value => BABYLON.TransformNode.Parse(value, scene, rootUrl));
        const meshes = json.meshes.map(value => BABYLON.Mesh.Parse(value, scene, rootUrl));
        const byId = id => [...transformNodes, ...meshes].find(node => node.id === id) ?? scene.getNodeById(id);
        // References resolved as the loader does after parsing a file
        [...json.transformNodes, ...json.meshes].forEach((value, index) => {
            const node = [...transformNodes, ...meshes][index];
            node.parent = value.parentId != null ? byId(value.parentId) : null;
        });
        json.meshes.forEach((value, index) => {
            const mesh = meshes[index];
            if (value.materialId != null) mesh.material = scene.getLastMaterialById(value.materialId) ?? scene.getMultiMaterialById?.(value.materialId) ?? null;
            if (value.skeletonId != null) mesh.skeleton = scene.getLastSkeletonById(value.skeletonId) ?? null;
        });
        skeletons.forEach((skeleton, index) => skeleton.bones.forEach((bone, boneIndex) => {
            const node = links[index][boneIndex] != null ? byId(links[index][boneIndex]) : null;
            if (node) bone.linkTransformNode(node);
        }));
        created.push(...materials, ...multiMaterials, ...textures, ...skeletons, ...transformNodes, ...meshes);
        // Parsed objects are already in the scene; the command adds them to the model
        created.forEach(object => this._detach(object));
        created.forEach(object => this._markChanged(object, 'added'));
        this._structural(label, () => created.forEach(object => this._attach(object)), () => [...created].reverse().forEach(object => this._detach(object)));
    }

    /**
     * A skeleton in the `.babylon` format: bones (bind and rest matrices, animations without the key
     * Babylon adds at frame 0 while playing) and clip ranges, without the runtime unique ids.
     * Animations of glTF models belong to animation groups, not to the bones, and are not copied.
     * @param {BABYLON.Skeleton} skeleton
     * @returns {any}
     */
    static _copySkeleton(skeleton) {
        const json = skeleton.serialize();
        delete json.uniqueId;
        json.bones.forEach((bone, index) => {
            delete bone.uniqueId;
            delete bone.linkedTransformNodeUniqueId;
            const animation = skeleton.bones[index]?.animations[0];
            if (bone.animation && animation) bone.animation.keys = serializeKeys(animation);
        });
        // Matrices are Float32Arrays: written as arrays of their shortest decimals
        return JSON.parse(JSON.stringify(json, babylonJsonReplacer));
    }

    /**
     * Adds a copy of a skeleton: a name of its own (`<name> copy` when taken) and a new id; bones keep
     * their links to nodes only when the model has the nodes (a copy into another model drops them).
     * For a `.babylon` text it is inserted into the document (one undo step), else into the scene.
     * @param {any} source skeleton in the `.babylon` format
     */
    _pasteSkeleton(source) {
        if (!source || !Array.isArray(source.bones) || !source.bones.length || !source.bones.every(bone => Array.isArray(bone?.matrix))) {
            throw new Error('The copied skeleton has no bones');
        }
        const container = this._container();
        const json = structuredClone(source);
        json.name = uniqueName(json.name || 'Skeleton', container.skeletons.map(skeleton => skeleton.name));
        this._prepareSkeleton(json);
        const nodes = new Map([...container.transformNodes, ...container.meshes].map(node => [node.id, node]));
        const label = `Paste ${json.name}`;
        json.id = this._skeletonIdFactory(!!this._binding())();
        if (this._binding()) {
            this._postOps(label, [{ op: 'insert', arrayPath: ['skeletons'], value: json }]);
            return;
        }
        // The parser links bones to nodes only while a file loads: the links are made here
        const links = json.bones.map(bone => nodes.get(bone.linkedTransformNodeId) ?? null);
        json.bones.forEach((bone) => { delete bone.linkedTransformNodeId; });
        const skeleton = BABYLON.Skeleton.Parse(json, this._scene);
        skeleton.bones.forEach((bone, index) => { if (links[index]) bone.linkTransformNode(links[index]); });
        // Parsed objects are already in the scene; the command adds it to the model
        this._detach(skeleton);
        this._markChanged(skeleton, 'added');
        this._structural(label, () => this._attach(skeleton), () => this._detach(skeleton));
    }

    // --- .babylon documents --------------------------------------------------------------------

    /**
     * @param {import('./ModelOutline').ModelItemData} data
     * @returns {DocumentOp[]}
     */
    _deleteOps(data) {
        const binding = this._binding();
        const object = objectOf(data);
        const container = this._container();
        const pathOf = (target) => {
            const path = binding.pathOf(target);
            if (!path) throw new Error(`${target.name ?? 'The object'} has no place in the file`);
            return path;
        };
        /** @type {DocumentOp[]} */
        const ops = [];
        switch (data.kind) {
            case 'texture':
                return [{ op: 'set', path: pathOf(object), value: null }];
            case 'clip': {
                // A clip of a .babylon file is a named frame range of its skeletons / nodes
                for (const owner of [...container.skeletons, ...container.meshes]) {
                    if (!owner.getAnimationRange?.(object.name)) continue;
                    const ranges = owner.getAnimationRanges().filter(range => range && range.name !== object.name)
                        .map(({ name, from, to }) => ({ name, from, to }));
                    ops.push({ op: 'set', path: [...pathOf(owner), 'ranges'], value: ranges });
                }
                if (!ops.length) throw new Error('This clip is the whole timeline: delete the animation keys instead');
                return ops;
            }
            case 'material':
                container.meshes.filter(mesh => mesh.material === object && binding.pathOf(mesh))
                    .forEach(mesh => ops.push({ op: 'set', path: [...binding.pathOf(mesh), 'materialId'], value: '' }));
                break;
            case 'light': {
                const generator = object.getShadowGenerator?.();
                if (generator && binding.pathOf(generator)) ops.push({ op: 'remove', path: binding.pathOf(generator) });
                break;
            }
        }
        ops.push({ op: 'remove', path: pathOf(object) });
        return ops;
    }

    /**
     * @param {string} section
     * @param {string} type
     * @param {string} name
     * @param {object} extra
     * @returns {DocumentOp[]}
     */
    _addOps(section, type, name, extra) {
        const binding = this._binding();
        switch (section) {
            case 'Nodes':
                return type === 'Empty node'
                    ? [{ op: 'insert', arrayPath: ['transformNodes'], value: { name, id: newId(), position: [0, 0, 0], rotation: [0, 0, 0], scaling: [1, 1, 1], isEnabled: true } }]
                    : [{ op: 'insert', arrayPath: ['meshes'], value: this._meshJson(type, name) }];
            case 'Materials':
            case 'Cameras':
            case 'Lights':
                return [{ op: 'insert', arrayPath: [section.toLowerCase()], value: this._serializedNew(section, type, name) }];
            case 'Textures': {
                const material = this._container().materials.find(candidate => candidate.uniqueId === extra.materialId);
                const path = material && binding.pathOf(material);
                if (!path || !extra.slot || !extra.image) throw new Error('Choose a material and an image');
                return [{ op: 'set', path: [...path, extra.slot], value: { name: extra.image, level: 1, hasAlpha: false, coordinatesMode: 0, uScale: 1, vScale: 1, uOffset: 0, vOffset: 0 } }];
            }
            case 'Skeletons': {
                const ids = this._container().skeletons.map(skeleton => Number(skeleton.id)).filter(Number.isFinite);
                const identity = BABYLON.Matrix.Identity().asArray();
                return [{
                    op: 'insert',
                    arrayPath: ['skeletons'],
                    value: { name, id: ids.length ? Math.max(...ids) + 1 : 0, bones: [{ name: 'Root', index: 0, parentBoneIndex: -1, matrix: identity, rest: identity }], ranges: [] },
                }];
            }
            case 'Animations': {
                const skeleton = this._container().skeletons.find(candidate => binding.pathOf(candidate));
                if (!skeleton) throw new Error('A clip of a .babylon file is a frame range of a skeleton: add a skeleton first');
                const ranges = skeleton.getAnimationRanges().filter(Boolean).map(({ name: rangeName, from, to }) => ({ name: rangeName, from, to }));
                ranges.push({ name, from: extra.from ?? 0, to: extra.to ?? 60 });
                return [{ op: 'set', path: [...binding.pathOf(skeleton), 'ranges'], value: ranges }];
            }
            default:
                throw new Error(`Nothing can be added to ${section}`);
        }
    }

    /**
     * A new primitive mesh in the `.babylon` format (vertices inline).
     * @param {string} type
     * @param {string} name
     * @returns {object}
     */
    _meshJson(type, name) {
        const mesh = this._createMesh(type, name);
        const kinds = [BABYLON.VertexBuffer.PositionKind, BABYLON.VertexBuffer.NormalKind, BABYLON.VertexBuffer.UVKind];
        const [positions, normals, uvs] = kinds.map(kind => Array.from(mesh.getVerticesData(kind) ?? []));
        const indices = Array.from(mesh.getIndices() ?? []);
        mesh.dispose();
        return {
            name, id: newId(), materialId: '', position: [0, 0, 0], rotation: [0, 0, 0], scaling: [1, 1, 1],
            isVisible: true, isEnabled: true, pickable: true, checkCollisions: false, receiveShadows: false, billboardMode: 0,
            positions, normals, uvs, indices,
            subMeshes: [{ materialIndex: 0, verticesStart: 0, verticesCount: positions.length / 3, indexStart: 0, indexCount: indices.length }],
        };
    }

    /**
     * A material, camera or light in the `.babylon` format (created with Babylon and serialized).
     * @param {string} section
     * @param {string} type
     * @param {string} name
     * @returns {object}
     */
    _serializedNew(section, type, name) {
        const object = this._create(section, type, name);
        const json = object.serialize();
        json.id = newId();
        object.dispose();
        return json;
    }

    // --- other formats: the scene -----------------------------------------------------------------

    /**
     * @param {import('./ModelOutline').ModelItemData} data
     */
    _deleteInScene(data) {
        const object = objectOf(data);
        const container = this._container();
        const label = `Delete ${this.info(data).label}`;
        // References cleared by the deletion, restored by undo
        const references = [];
        if (data.kind === 'material') {
            container.meshes.filter(mesh => mesh.material === object).forEach(mesh => references.push([mesh, 'material', object]));
        } else if (data.kind === 'skeleton') {
            container.meshes.filter(mesh => mesh.skeleton === object).forEach(mesh => references.push([mesh, 'skeleton', object]));
        } else if (data.kind === 'texture') {
            for (const material of container.materials) {
                for (const key of Object.keys(material)) {
                    if (material[key] === object) references.push([material, key, object]);
                }
            }
        }
        const clear = () => references.forEach(([target, key]) => { target[key] = null; });
        const restore = () => references.forEach(([target, key, value]) => { target[key] = value; });
        if (data.kind === 'clip') {
            const group = object.group;
            const ranges = object.ranges.map(range => ({ range, owner: [...container.skeletons, ...container.meshes].find(owner => owner.getAnimationRange?.(range.name) === range) }));
            this._structural(label,
                () => (ranges.length ? ranges.forEach(({ range, owner }) => owner?.deleteAnimationRange(range.name, false)) : this._detach(group)),
                () => (ranges.length ? ranges.forEach(({ range, owner }) => owner?.createAnimationRange(range.name, range.from, range.to)) : this._attach(group)));
            return;
        }
        if (data.kind === 'shadowGenerator') throw new Error('Delete the light, or set the shadow properties of the light instead');
        this._structural(label, () => { clear(); this._detach(object); }, () => { this._attach(object); restore(); });
    }

    /**
     * @param {string} section
     * @param {string} type
     * @param {string} name
     * @param {object} extra
     */
    _addToScene(section, type, name, extra) {
        const container = this._container();
        if (section === 'Textures') {
            const material = container.materials.find(candidate => candidate.uniqueId === extra.materialId);
            if (!material || !extra.slot || !extra.image) throw new Error('Choose a material and an image');
            const texture = new BABYLON.Texture(this._rootUrl + extra.image, this._scene);
            texture.name = extra.image;
            const previous = material[extra.slot] ?? null;
            this._scene.removeTexture(texture);
            this._structural(`Add ${name}`,
                () => { this._attach(texture); material[extra.slot] = texture; },
                () => { material[extra.slot] = previous; this._detach(texture); });
            return;
        }
        if (section === 'Animations') {
            const skeleton = container.skeletons[0];
            if (skeleton && this._animations.clips.some(clip => clip.ranges.length)) {
                this._structural(`Add ${name}`, () => skeleton.createAnimationRange(name, extra.from ?? 0, extra.to ?? 60), () => skeleton.deleteAnimationRange(name, false));
                return;
            }
            const group = new BABYLON.AnimationGroup(name, this._scene);
            this._scene.removeAnimationGroup(group);
            this._structural(`Add ${name}`, () => this._attach(group), () => this._detach(group));
            return;
        }
        let object;
        if (section === 'Nodes') {
            object = type === 'Empty node' ? new BABYLON.TransformNode(name, this._scene) : this._createMesh(type, name);
        } else if (section === 'Skeletons') {
            object = new BABYLON.Skeleton(name, newId(), this._scene);
            new BABYLON.Bone('Root', object, null, BABYLON.Matrix.Identity());
        } else {
            object = this._create(section, type, name);
        }
        // Created objects are already in the scene; the command adds them to the model
        this._detach(object);
        this._markChanged(object, 'added');
        this._structural(`Add ${name}`, () => this._attach(object), () => this._detach(object));
    }

    /**
     * Runs a structural change as an undoable command and rebuilds the tree after it.
     * @param {string} label
     * @param {() => void} apply
     * @param {() => void} revert
     */
    _structural(label, apply, revert) {
        this._history.execute({
            label,
            apply: () => { apply(); this._onStructureChange(); },
            revert: () => { revert(); this._onStructureChange(); },
        });
    }

    /**
     * @param {any} object
     */
    _attach(object) {
        const [array, add] = COLLECTIONS[collectionOf(object)];
        const container = this._container();
        if (!container[array].includes(object)) container[array].push(object);
        this._scene[add](object);
    }

    /**
     * @param {any} object
     */
    _detach(object) {
        const [array, , remove] = COLLECTIONS[collectionOf(object)];
        const container = this._container();
        const index = container[array].indexOf(object);
        if (index >= 0) container[array].splice(index, 1);
        this._scene[remove](object);
    }

    // --- new objects --------------------------------------------------------------------------

    /**
     * @param {string} type Box / Sphere / Plane
     * @param {string} name
     * @returns {BABYLON.Mesh}
     */
    _createMesh(type, name) {
        switch (type) {
            case 'Sphere': return BABYLON.MeshBuilder.CreateSphere(name, { diameter: 1 }, this._scene);
            case 'Plane': return BABYLON.MeshBuilder.CreatePlane(name, { size: 1 }, this._scene);
            default: return BABYLON.MeshBuilder.CreateBox(name, { size: 1 }, this._scene);
        }
    }

    /**
     * @param {string} section Materials / Cameras / Lights
     * @param {string} type
     * @param {string} name
     * @returns {BABYLON.Material | BABYLON.Camera | BABYLON.Light}
     */
    _create(section, type, name) {
        const scene = this._scene;
        const zero = BABYLON.Vector3.Zero();
        switch (type) {
            case 'Standard material': return new BABYLON.StandardMaterial(name, scene);
            case 'PBR material': return new BABYLON.PBRMaterial(name, scene);
            case 'ArcRotate camera': return new BABYLON.ArcRotateCamera(name, -Math.PI / 2, Math.PI / 3, 10, zero, scene, false);
            case 'Universal camera': {
                const camera = new BABYLON.UniversalCamera(name, new BABYLON.Vector3(0, 5, -10), scene, false);
                camera.setTarget(zero);
                return camera;
            }
            case 'Point light': return new BABYLON.PointLight(name, new BABYLON.Vector3(0, 10, 0), scene);
            case 'Directional light': return new BABYLON.DirectionalLight(name, new BABYLON.Vector3(-1, -2, -1), scene);
            case 'Spot light': return new BABYLON.SpotLight(name, new BABYLON.Vector3(0, 10, 0), new BABYLON.Vector3(0, -1, 0), Math.PI / 3, 2, scene);
            case 'Hemispheric light': return new BABYLON.HemisphericLight(name, new BABYLON.Vector3(0, 1, 0), scene);
            default: throw new Error(`Unknown type ${type} for ${section}`);
        }
    }
}
