import * as BABYLON from '@babylonjs/core';
import { MATERIAL_TEXTURE_SLOTS } from './BabylonFileSchema';
import { babylonJsonReplacer, float32, serializeKeys } from './BabylonJsonBinding';
import { modelKeys } from './AnimationController';
import { ClipConverter, decomposeTransform } from './ClipConverter';
import { BoneRemoval } from './BoneRemoval';
import { HiddenGeometry } from './HiddenGeometry';
import { MeshWeld, meshKinds, VERTEX_PROPERTIES } from './MeshWeld';
import { ClipRetarget } from './ClipRetarget';
import { ModelConverter } from './ModelConverter';
import { isJointTip, jointNodes } from './ModelOutline';

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
 * A new geometry of a mesh, ready to apply with others as one undo step: document ops of a
 * `.babylon` text, or, in the scene, the state before (capture), how to write a state and the state after.
 * @typedef {{ mesh: BABYLON.Mesh, ops?: any[], capture?: () => any, write?: (state: any) => void, after?: any }} GeometryChange
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
 * @property {boolean} [mirrored] the tracks are local transforms of a mirrored space (glTF models are
 *   under a `__root__` node with scaling z = -1)
 * @property {import('./ClipRetarget').Rig} [rig] the rest pose of the skeleton the clip animates, to
 *   retarget it to another skeleton
 */

/**
 * @typedef {object} DeleteOptions
 * @property {boolean} [withJoints] a deleted skeleton takes its joint nodes (and the nodes they leave empty) along
 */

/**
 * @param {BABYLON.Node | null | undefined} node
 * @returns {boolean} the node is in a mirrored space (its world matrix turns left- into right-handed)
 */
function isMirrored(node) {
    return !!node && node.computeWorldMatrix(true).determinant() < 0;
}

/**
 * What pasting a clip asks the host before it can go on (the skeleton it goes to, how its channels
 * are taken), or reports when done.
 * @typedef {{ choose: 'skeleton' | 'channels', title?: string, options: { id: string, label: string, description: string }[] } | { report: string }} PasteResult
 */

/** @typedef {'all' | 'rotations' | 'retarget' | 'difference'} ClipChannels how the channels of a pasted clip are taken */

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
     * @returns {{ label: string, canRename: boolean, dependents: string[], joints: number }}
     */
    info(data) {
        const object = objectOf(data);
        const container = this._container();
        const dependents = [];
        if (data.kind === 'material') {
            container.meshes.filter(mesh => mesh.material === object).forEach(mesh => dependents.push(`mesh ${mesh.name} loses its material`));
        } else if (data.kind === 'skeleton') {
            container.meshes.filter(mesh => mesh.skeleton === object).forEach(mesh => dependents.push(`mesh ${mesh.name} keeps the shape of the bind pose without the skeleton`));
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
            // The joint nodes a skeleton can take along (the host asks)
            joints: data.kind === 'skeleton' ? this._jointNodesToRemove(object).size : 0,
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
     * @param {DeleteOptions} [options]
     */
    delete(data, options = {}) {
        this.deleteMany([data], options);
    }

    /**
     * Deletes objects of the tree as one undo step.
     * @param {import('./ModelOutline').ModelItemData[]} items
     * @param {DeleteOptions} [options]
     */
    deleteMany(items, options = {}) {
        if (!items.length) return;
        const label = items.length === 1 ? `Delete ${this.info(items[0]).label}` : `Delete ${items.length} objects`;
        if (this._binding()) {
            this._postOps(label, this._deleteManyOps(items, options));
            return;
        }
        const steps = items.map(data => this._sceneDeletion(data, options));
        this._structural(label, () => steps.forEach(step => step.apply()), () => [...steps].reverse().forEach(step => step.revert()));
    }

    /**
     * The document ops of deleting several objects: the clips of one owner become one change of its
     * ranges, ops inside a removed object and repeated ops are left out (their ranges would overlap).
     * @param {import('./ModelOutline').ModelItemData[]} items
     * @param {DeleteOptions} options
     * @returns {DocumentOp[]}
     */
    _deleteManyOps(items, options) {
        const clips = items.filter(data => data.kind === 'clip');
        /** @type {DocumentOp[]} */
        const ops = items.filter(data => data.kind !== 'clip').flatMap(data => this._deleteOps(data, options));
        if (clips.length) ops.push(...this._clipDeleteOps(clips.map(data => objectOf(data))));
        const removed = ops.filter(op => op.op === 'remove').map(op => op.path);
        const inside = (path, base) => path.length > base.length && base.every((key, index) => path[index] === key);
        const seen = new Set();
        return ops.filter((op) => {
            const path = op.path ?? op.arrayPath;
            if (removed.some(base => inside(path, base))) return false;
            const key = JSON.stringify([op.op, path]);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    /**
     * @param {any[]} clips clips of a `.babylon` file: named frame ranges of its skeletons / nodes,
     *   or animation groups of the file (converted glTF models)
     * @returns {DocumentOp[]} one change of the ranges of each owner, the removal of each group
     */
    _clipDeleteOps(clips) {
        const binding = this._binding();
        const ops = [];
        const groupClips = clips.filter(clip => !clip.ranges.length && binding.pathOf(clip.group));
        groupClips.forEach(clip => ops.push({ op: 'remove', path: binding.pathOf(clip.group) }));
        const ranged = clips.filter(clip => !groupClips.includes(clip));
        if (!ranged.length) return ops;
        const names = new Set(ranged.map(clip => clip.name));
        for (const owner of [...this._container().skeletons, ...this._container().meshes]) {
            const ranges = owner.getAnimationRanges?.().filter(Boolean) ?? [];
            if (!ranges.some(range => names.has(range.name)) || !binding.pathOf(owner)) continue;
            ops.push({ op: 'set', path: [...binding.pathOf(owner), 'ranges'], value: ranges.filter(range => !names.has(range.name)).map(({ name, from, to }) => ({ name, from, to })) });
        }
        if (ops.length === groupClips.length) throw new Error('This clip is the whole timeline: delete the animation keys instead');
        return ops;
    }

    /**
     * The joint nodes of a skeleton (and the tips of its leaf bones) that can go with it: a node goes
     * when everything below it goes, so a node something else hangs from (a weapon on a hand, a
     * camera) stays with its ancestors; joints of other skeletons stay.
     * @param {BABYLON.Skeleton} skeleton
     * @returns {Set<BABYLON.Node>}
     */
    _jointNodesToRemove(skeleton) {
        const container = this._container();
        const joints = jointNodes([skeleton]);
        const others = jointNodes(container.skeletons.filter(other => other !== skeleton));
        const candidates = new Set([...joints].filter(node => !others.has(node)));
        const allJoints = jointNodes(container.skeletons);
        for (const joint of joints) joint.getChildren().filter(child => isJointTip(child, allJoints)).forEach(tip => candidates.add(tip));
        /** @type {Map<BABYLON.Node, boolean>} */
        const goes = new Map();
        const removable = (node) => {
            if (!goes.has(node)) goes.set(node, candidates.has(node) && node.getChildren().every(removable));
            return goes.get(node);
        };
        return new Set([...candidates].filter(removable));
    }

    /**
     * Removed nodes with the ancestors they leave empty: a transform node, or a mesh without
     * vertices, whose children (objects of the model) all go; joints of skeletons and the nodes of
     * `keep` stay.
     * @param {Set<BABYLON.Node>} removed
     * @param {Set<BABYLON.Node>} [keep]
     * @returns {Set<BABYLON.Node>} the removed nodes and the emptied ancestors
     */
    _emptiedAncestors(removed, keep = new Set()) {
        const container = this._container();
        const own = new Set([...container.meshes, ...container.transformNodes, ...container.cameras, ...container.lights]);
        const joints = jointNodes(container.skeletons);
        const result = new Set(removed);
        const queue = [...removed].map(node => node.parent).filter(Boolean);
        while (queue.length) {
            const node = queue.shift();
            if (result.has(node) || keep.has(node) || !own.has(node) || joints.has(node)) continue;
            if (!(node instanceof BABYLON.TransformNode) || (node instanceof BABYLON.AbstractMesh && node.getTotalVertices() > 0)) continue;
            if (!node.getChildren().filter(child => own.has(child)).every(child => result.has(child))) continue;
            result.add(node);
            if (node.parent) queue.push(node.parent);
        }
        return result;
    }

    /**
     * Document ops removing nodes with the tracks of animation groups that target them (a group left
     * without tracks goes too); their own animations are in them.
     * @param {Set<BABYLON.Node>} nodes
     * @returns {DocumentOp[]}
     */
    _nodeRemovalOps(nodes) {
        const binding = this._binding();
        /** @type {DocumentOp[]} */
        const ops = [];
        nodes.forEach((node) => {
            const path = binding.pathOf(node);
            if (path) ops.push({ op: 'remove', path });
        });
        const ids = new Set([...nodes].map(node => node.id));
        (binding.document.animationGroups ?? []).forEach((group, groupIndex) => {
            const targeted = group?.targetedAnimations ?? [];
            const gone = targeted.map((target, index) => (ids.has(target?.targetId) ? index : -1)).filter(index => index >= 0);
            if (!gone.length) return;
            if (gone.length === targeted.length) ops.push({ op: 'remove', path: ['animationGroups', groupIndex] });
            else gone.forEach(index => ops.push({ op: 'remove', path: ['animationGroups', groupIndex, 'targetedAnimations', index] }));
        });
        return ops;
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
     * Deletes bones of one skeleton (`BoneRemoval`: their children, the weights of their vertices and
     * their linked nodes go to the nearest kept bone above) as one undoable change of the `.babylon` text.
     * @param {BABYLON.Bone[]} bones
     * @returns {string} what was done
     */
    deleteBones(bones) {
        const binding = this._binding();
        if (!binding) throw new Error('Deleting bones needs the .babylon text of the model (models too large for it stay in the binary editor)');
        if (!bones.length) throw new Error('Choose the bones to delete');
        const { ops, report } = BoneRemoval.ops(bones, { container: this._container(), binding, bones: ModelEdits._copySkeleton(bones[0].getSkeleton()).bones });
        this._postOps(bones.length === 1 ? `Delete bone ${bones[0].name}` : `Delete ${bones.length} bones`, ops);
        return report;
    }

    /**
     * Adds a bone to a skeleton of a `.babylon` text (one undo step, the model reloads): a child of
     * `parent` (a root bone without one), no rotation or scaling against it, placed where the parent
     * points — at its tip node, at the middle of its child joints, else as far again along the
     * parent bone (the place is the same in the bind and the rest pose, each by its own values). It
     * gets the next free index, so no vertex follows it until weights are given. When the bones of
     * the skeleton have linked nodes (glTF joints), it gets one too, below the node of its parent.
     * @param {BABYLON.Skeleton} skeleton
     * @param {BABYLON.Bone | null} parent
     * @param {string} name
     * @returns {string} what was done
     */
    addBone(skeleton, parent, name) {
        const binding = this._binding();
        if (!binding) throw new Error('Adding bones needs the .babylon text of the model (models too large for it stay in the binary editor)');
        const skeletonPath = binding.pathOf(skeleton);
        if (!skeletonPath) throw new Error(`${skeleton.name || 'The skeleton'} has no place in the file`);
        const bonesJson = skeletonPath.reduce((value, key) => value?.[key], binding.document)?.bones ?? [];
        const place = (pose) => {
            const translation = ModelEdits._newBoneTranslation(skeleton, parent, pose, this._animations);
            return BABYLON.Matrix.Translation(translation.x, translation.y, translation.z);
        };
        const rest = place('rest');
        let bind = place('bind');
        const linkedParent = parent ? parent.getTransformNode() : skeleton.bones.find(bone => !bone.getParent() && bone.getTransformNode())?.getTransformNode()?.parent ?? null;
        const linked = skeleton.bones.some(bone => bone.getTransformNode());
        // The bind matrix of a glTF root bone is kept in the space of the glTF scene (see AnimationController._bindPose)
        if (!parent && linkedParent instanceof BABYLON.TransformNode) {
            let top = linkedParent;
            while (top.parent) top = /** @type {BABYLON.TransformNode} */ (top.parent);
            bind = bind.multiply(linkedParent.computeWorldMatrix(true)).multiply(top.computeWorldMatrix(true).clone().invert());
        }
        const json = {
            name,
            index: Math.max(-1, ...bonesJson.map((bone, index) => Number(bone.index ?? index))) + 1,
            parentBoneIndex: parent ? skeleton.bones.indexOf(parent) : -1,
            matrix: Array.from(bind.m, float32),
            rest: Array.from(rest.m, float32),
        };
        /** @type {DocumentOp[]} */
        const ops = [];
        if (linked) {
            const restParts = decomposeTransform(rest);
            const node = {
                name,
                id: newId(),
                uniqueId: binding.nextFileUniqueId(),
                position: restParts.position.asArray().map(float32),
                rotationQuaternion: [0, 0, 0, 1],
                scaling: [1, 1, 1],
                isEnabled: true,
            };
            if (linkedParent) node.parentId = binding.fileUniqueIdOf(linkedParent) ?? linkedParent.id;
            ops.push({ op: 'insert', arrayPath: ['transformNodes'], value: node });
            json.linkedTransformNodeId = node.id;
            if (bonesJson.some(bone => bone.linkedTransformNodeUniqueId != null)) json.linkedTransformNodeUniqueId = node.uniqueId;
        }
        ops.push({ op: 'insert', arrayPath: [...skeletonPath, 'bones'], value: json });
        this._postOps(`Add bone ${name}`, ops);
        return `Added ${name}${parent ? ` below ${parent.name}` : ' as a root bone'}${linked ? ' with its joint node' : ''}; give it weights (Automatic weights, the Skin values of vertices) to make it move the mesh`;
    }

    /**
     * @param {BABYLON.Skeleton} skeleton
     * @param {BABYLON.Bone | null} parent
     * @param {'rest' | 'bind'} pose
     * @param {import('./AnimationController').AnimationController} animations
     * @returns {BABYLON.Vector3} where a new child bone of the parent goes, in the space of the parent
     */
    static _newBoneTranslation(skeleton, parent, pose, animations) {
        const local = bone => animations.poseMatrix(bone, pose);
        const lengths = skeleton.bones.filter(bone => bone.getParent()).map(bone => local(bone).getTranslation().length()).filter(length => length > 0);
        const typical = lengths.length ? lengths.reduce((sum, length) => sum + length, 0) / lengths.length : 1;
        if (!parent) return BABYLON.Vector3.Zero();
        const joints = jointNodes([skeleton]);
        const tip = parent.getTransformNode()?.getChildren().find(child => isJointTip(child, joints));
        if (tip) return /** @type {BABYLON.TransformNode} */ (tip).position.clone();
        const children = parent.getChildren();
        if (children.length) {
            const sum = children.reduce((total, child) => total.addInPlace(local(child).getTranslation()), BABYLON.Vector3.Zero());
            return sum.scaleInPlace(1 / children.length);
        }
        // The parent bone continued: its own offset, turned into its space
        const own = local(parent);
        const offset = own.getTranslation();
        if (offset.length() > 0) {
            const linear = own.clone();
            linear.setTranslationFromFloats(0, 0, 0);
            return BABYLON.Vector3.TransformNormal(offset, linear.invert());
        }
        return new BABYLON.Vector3(0, typical, 0);
    }

    /**
     * Welds the vertices of a mesh at one position into one with smooth normals (`MeshWeld`), for
     * every mesh sharing its geometry: in a `.babylon` text as document ops (the model reloads),
     * else in the scene as an undoable command.
     * @param {BABYLON.Mesh} mesh
     * @param {number} [distance] points this close are one point (0: the same position)
     * @returns {string} what was done
     */
    weldVertices(mesh, distance = 0) {
        const welded = MeshWeld.compute(mesh, { distance });
        this._applyGeometry(mesh, welded, `Weld ${mesh.name}`);
        return `Welded ${mesh.name}${distance > 0 ? ` (points within ${distance})` : ''}: ${welded.vertexCount} vertices (${welded.removed} merged), smooth normals`;
    }

    /**
     * Welds the vertices of several meshes (as weldVertices, each in its own coordinates; a geometry
     * shared by several of them once) as one undo step. Meshes that cannot be written are left out.
     * @param {BABYLON.Mesh[]} meshes
     * @param {number} distance
     * @param {string} name what the meshes are (the node above them), for the undo label
     * @returns {string} what was done
     */
    weldMeshes(meshes, distance, name) {
        const geometries = new Set();
        const changes = [];
        const skipped = [];
        let vertices = 0;
        let merged = 0;
        for (const mesh of meshes) {
            if (mesh.geometry && geometries.has(mesh.geometry)) continue;
            if (mesh.geometry) geometries.add(mesh.geometry);
            try {
                const welded = MeshWeld.compute(mesh, { distance });
                changes.push(this._geometryChange(mesh, welded));
                vertices += welded.vertexCount;
                merged += welded.removed;
            } catch (error) {
                skipped.push(`${mesh.name} (${error?.message || error})`);
            }
        }
        if (!changes.length) throw new Error(`No mesh of ${name} could be welded${skipped.length ? `: ${skipped.join('; ')}` : ''}`);
        this._applyGeometries(changes, `Weld ${name}`);
        return `Welded ${changes.length} meshes of ${name}${distance > 0 ? ` (points within ${distance})` : ''}: ${vertices} vertices (${merged} merged), smooth normals`
            + (skipped.length ? `. Left out: ${skipped.join('; ')}` : '');
    }

    /**
     * Removes the triangles of meshes the outside air never reaches (`HiddenGeometry`: inside the
     * mesh itself, in the positions of the file) and the vertices no triangle uses any more, as one
     * undo step; a geometry shared by several meshes once. Meshes that cannot be written are left out.
     * @param {BABYLON.Mesh[]} meshes
     * @param {number} resolution cells of the grid along the longest side of each mesh
     * @param {string} name what the meshes are (a mesh, or the node above them)
     * @returns {string} what was done
     */
    removeHidden(meshes, resolution, name) {
        const geometries = new Set();
        const changes = [];
        const skipped = [];
        let triangles = 0;
        let vertices = 0;
        for (const mesh of meshes) {
            if (mesh.geometry && geometries.has(mesh.geometry)) continue;
            if (mesh.geometry) geometries.add(mesh.geometry);
            const positions = mesh.getVerticesData(BABYLON.VertexBuffer.PositionKind);
            const indices = mesh.getIndices();
            if (!positions || !indices?.length) continue;
            try {
                const hidden = HiddenGeometry.hiddenTriangles(positions, indices, resolution);
                const removedTriangles = hidden.reduce((sum, value) => sum + value, 0);
                const result = MeshWeld.removeTriangles(mesh, hidden);
                if (!removedTriangles && !result.removed) continue;
                if (result.indices.length === 0) throw new Error('every triangle is hidden: is the mesh inside out or very thin?');
                changes.push(this._geometryChange(mesh, result));
                triangles += removedTriangles;
                vertices += result.removed;
            } catch (error) {
                skipped.push(`${mesh.name} (${error?.message || error})`);
            }
        }
        const left = skipped.length ? `. Left out: ${skipped.join('; ')}` : '';
        if (!changes.length) return `Nothing hidden in ${name}${left}`;
        this._applyGeometries(changes, `Remove hidden geometry of ${name}`);
        return `Removed ${triangles} hidden triangles and ${vertices} vertices from ${changes.length} mesh${changes.length > 1 ? 'es' : ''} of ${name}${left}`;
    }

    /**
     * Merges meshes into the first one (`MeshWeld.mergeMeshes`: one sub-mesh per material, a
     * multi-material when there are several) and removes the others, as one undo step of a
     * `.babylon` document; the first mesh keeps its name, node, transform and skeleton.
     * @param {BABYLON.Mesh[]} meshes at least two
     * @param {string} name the node above them, for the undo label
     * @returns {string} what was done
     */
    mergeMeshes(meshes, name) {
        const binding = this._binding();
        if (!binding) throw new Error('Meshes are merged in .babylon documents only');
        const [first, ...others] = meshes;
        const meshSet = new Set(meshes);
        for (const mesh of others) {
            const outside = mesh.getChildren().filter(child => !meshSet.has(child));
            if (outside.length) throw new Error(`${mesh.name} has child nodes (${outside.map(child => child.name).join(', ')}): they would lose their parent`);
        }
        const merged = MeshWeld.mergeMeshes(meshes);
        const pathOf = (mesh) => {
            const path = binding.pathOf(mesh);
            if (!path) throw new Error(`${mesh.name} has no place in the file`);
            return path;
        };
        const path = pathOf(first);
        const json = path.reduce((value, key) => value?.[key], binding.document) ?? {};
        // The vertices go where they are (a shared geometry of converted models) unless meshes not
        // merged share it: then into the mesh, without the geometry (the loader finds it by unique id first)
        const keyOf = holder => JSON.stringify(holder);
        const users = new Map();
        for (const mesh of this._container().meshes) {
            const holder = binding.vertexHolderPath(mesh);
            if (!holder) continue;
            if (!users.has(keyOf(holder))) users.set(keyOf(holder), []);
            users.get(keyOf(holder)).push(mesh);
        }
        const onlyMerged = holder => users.get(keyOf(holder))?.every(mesh => meshSet.has(mesh)) ?? false;
        /** @type {DocumentOp[]} */
        const ops = [];
        let holder = binding.vertexHolderPath(first) ?? path;
        if (keyOf(holder) !== keyOf(path) && !onlyMerged(holder)) {
            holder = path;
            for (const property of ['geometryId', 'geometryUniqueId']) if (json[property] !== undefined) ops.push({ op: 'set', path: [...path, property], value: null });
        }
        const holderJson = holder.reduce((value, key) => value?.[key], binding.document) ?? {};
        merged.data.forEach((values, kind) => ops.push({ op: 'set', path: [...holder, VERTEX_PROPERTIES[kind]], value: Array.from(values, float32) }));
        for (const [kind, property] of Object.entries(VERTEX_PROPERTIES)) {
            if (!merged.data.has(kind) && holderJson[property] !== undefined) ops.push({ op: 'set', path: [...holder, property], value: null });
        }
        ops.push({ op: 'set', path: [...holder, 'indices'], value: merged.indices });
        // The influences are written expanded (one number per influence)
        if (merged.data.has(BABYLON.VertexBuffer.MatricesIndicesKind)) ops.push({ op: 'set', path: [...holder, 'matricesIndicesExpanded'], value: true });
        if (merged.data.has(BABYLON.VertexBuffer.MatricesIndicesExtraKind)) ops.push({ op: 'set', path: [...holder, 'matricesIndicesExtraExpanded'], value: true });
        ops.push({ op: 'set', path: [...path, 'subMeshes'], value: merged.subMeshes.map(subMesh => ({ ...subMesh, verticesStart: 0, verticesCount: merged.vertexCount })) });
        // Shared geometries only the removed meshes used go with them
        const removedHolders = new Set([keyOf(holder)]);
        for (const mesh of others) {
            const own = binding.vertexHolderPath(mesh);
            if (!own || keyOf(own) === keyOf(pathOf(mesh)) || removedHolders.has(keyOf(own)) || !onlyMerged(own)) continue;
            removedHolders.add(keyOf(own));
            ops.push({ op: 'remove', path: own });
        }
        // The loader links the material by its unique id first
        if (json.materialUniqueId !== undefined) ops.push({ op: 'set', path: [...path, 'materialUniqueId'], value: null });
        if (merged.materials.length > 1) {
            const multi = { name: `${first.name} materials`, id: newId(), materials: merged.materials.map(material => material?.id ?? '') };
            ops.push({ op: 'insert', arrayPath: ['multiMaterials'], value: multi });
            ops.push({ op: 'set', path: [...path, 'materialId'], value: multi.id });
        } else {
            ops.push({ op: 'set', path: [...path, 'materialId'], value: merged.materials[0]?.id ?? '' });
        }
        // The other meshes go with the nodes they leave empty (not the ancestors of the kept mesh)
        const keep = new Set();
        for (let node = /** @type {BABYLON.Node | null} */ (first); node; node = node.parent) keep.add(node);
        ops.push(...this._nodeRemovalOps(this._emptiedAncestors(new Set(others), keep)));
        this._postOps(`Merge ${meshes.length} meshes of ${name}`, ops);
        return `Merged ${meshes.length} meshes of ${name} into ${first.name}: ${merged.vertexCount} vertices, ${merged.indices.length / 3} triangles, ${merged.materials.length} material${merged.materials.length > 1 ? 's' : ''}`;
    }

    /**
     * Deletes vertices of a mesh and the triangles that use them (`MeshWeld.removeVertices`).
     * @param {BABYLON.Mesh} mesh
     * @param {number[]} vertices
     * @returns {string} what was done
     */
    deleteVertices(mesh, vertices) {
        const result = MeshWeld.removeVertices(mesh, vertices);
        const triangles = (mesh.getIndices()?.length ?? 0) / 3 - result.indices.length / 3;
        this._applyGeometry(mesh, result, `Delete ${vertices.length} vertices of ${mesh.name}`);
        return `Deleted ${result.removed} vertices of ${mesh.name} and ${triangles} triangles`;
    }

    /**
     * Merges vertices of a mesh into one at their centre (`MeshWeld.mergeVertices`).
     * @param {BABYLON.Mesh} mesh
     * @param {number[]} vertices
     * @returns {string} what was done
     */
    mergeVertices(mesh, vertices) {
        const result = MeshWeld.mergeVertices(mesh, vertices);
        this._applyGeometry(mesh, result, `Merge ${vertices.length} vertices of ${mesh.name}`);
        return `Merged ${vertices.length} vertices of ${mesh.name} into one`;
    }

    /**
     * Gives a mesh (and every mesh sharing its geometry) new vertex buffers, indices, sub-meshes and
     * morph targets: in a `.babylon` text as document ops (the model reloads), else in the scene as
     * an undoable command. Buffers the result has not (tangents) are removed.
     * @param {BABYLON.Mesh} mesh
     * @param {import('./MeshWeld').WeldedMesh} result
     * @param {string} label
     */
    _applyGeometry(mesh, result, label) {
        this._applyGeometries([this._geometryChange(mesh, result)], label);
    }

    /**
     * Applies the geometry changes of several meshes as one undo step.
     * @param {GeometryChange[]} changes
     * @param {string} label
     */
    _applyGeometries(changes, label) {
        if (this._binding()) {
            this._postOps(label, changes.flatMap(change => change.ops));
            return;
        }
        this._history.executeMutation(label,
            () => changes.map(change => change.capture()),
            () => changes.forEach(change => change.write(change.after)),
            states => changes.forEach((change, index) => change.write(states[index])));
        changes.forEach(change => this._markChanged(change.mesh, 'modified'));
    }

    /**
     * What gives a mesh a new geometry (see _applyGeometry): document ops in a `.babylon` text, else
     * a capture / write pair for the undo history.
     * @param {BABYLON.Mesh} mesh
     * @param {import('./MeshWeld').WeldedMesh} result
     * @returns {GeometryChange}
     * @throws when the mesh has vertex buffers the editor cannot write or no place in the file
     */
    _geometryChange(mesh, result) {
        const users = mesh.geometry?.meshes ?? [mesh];
        const unknown = [...result.data.keys()].filter(kind => !VERTEX_PROPERTIES[kind]);
        if (unknown.length) throw new Error(`${mesh.name} has vertex buffers the editor cannot change: ${unknown.join(', ')}`);
        const subMeshes = result.subMeshes.map(subMesh => ({ ...subMesh, verticesStart: 0, verticesCount: result.vertexCount }));
        const binding = this._binding();
        if (binding) {
            const holder = binding.vertexHolderPath(mesh);
            if (!holder) throw new Error(`${mesh.name} has no place in the file`);
            const ops = [...result.data].map(([kind, values]) => ({ op: 'set', path: [...holder, VERTEX_PROPERTIES[kind]], value: Array.from(values, float32) }));
            ops.push({ op: 'set', path: [...holder, 'indices'], value: result.indices });
            // The influences are written expanded (one number per influence)
            if (result.data.has(BABYLON.VertexBuffer.MatricesIndicesKind)) ops.push({ op: 'set', path: [...holder, 'matricesIndicesExpanded'], value: true });
            if (result.data.has(BABYLON.VertexBuffer.MatricesIndicesExtraKind)) ops.push({ op: 'set', path: [...holder, 'matricesIndicesExtraExpanded'], value: true });
            for (const kind of meshKinds(mesh)) {
                if (!result.data.has(kind) && VERTEX_PROPERTIES[kind]) ops.push({ op: 'set', path: [...holder, VERTEX_PROPERTIES[kind]], value: null });
            }
            for (const user of users) {
                const path = binding.pathOf(user);
                if (path) ops.push({ op: 'set', path: [...path, 'subMeshes'], value: subMeshes });
            }
            // The morph targets of the mesh: their manager is found by the id the mesh refers to
            if (result.targets.length) {
                const document = binding.document;
                const meshJson = binding.pathOf(mesh)?.reduce((value, key) => value?.[key], document);
                const managerIndex = (document.morphTargetManagers ?? []).findIndex(manager => manager?.id === meshJson?.morphTargetManagerId);
                if (managerIndex < 0) throw new Error(`The morph targets of ${mesh.name} have no place in the file`);
                result.targets.forEach(({ data, hadTangents }, targetIndex) => {
                    const base = ['morphTargetManagers', managerIndex, 'targets', targetIndex];
                    data.forEach((values, key) => ops.push({ op: 'set', path: [...base, key], value: Array.from(values, float32) }));
                    if (hadTangents) ops.push({ op: 'set', path: [...base, 'tangents'], value: null });
                });
            }
            return { mesh, ops };
        }
        const geometry = mesh.geometry;
        const manager = mesh.morphTargetManager;
        const targets = Array.from({ length: manager?.numTargets ?? 0 }, (_, index) => manager.getTarget(index));
        const targetFields = [['positions', 'getPositions', 'setPositions'], ['normals', 'getNormals', 'setNormals'], ['tangents', 'getTangents', 'setTangents'], ['uvs', 'getUVs', 'setUVs'], ['uv2s', 'getUV2s', 'setUV2s'], ['colors', 'getColors', 'setColors']];
        const capture = () => ({
            data: new Map(meshKinds(mesh).map(kind => [kind, Float32Array.from(mesh.getVerticesData(kind))])),
            indices: Array.from(mesh.getIndices() ?? []),
            subMeshes: users.map(user => user.subMeshes.map(({ materialIndex, verticesStart, verticesCount, indexStart, indexCount }) => ({ materialIndex, verticesStart, verticesCount, indexStart, indexCount }))),
            targets: targets.map(target => new Map(targetFields.map(([key, get]) => [key, target[get]() ? Float32Array.from(target[get]()) : null]))),
        });
        const write = ({ data, indices, subMeshes: lists, targets: targetData }) => {
            // The targets first: their size follows the vertices (missing data is cleared)
            targets.forEach((target, index) => targetFields.forEach(([key, , set]) => {
                const values = targetData[index].get(key);
                target[set](values ? Float32Array.from(values) : null);
            }));
            for (const kind of meshKinds(mesh)) if (!data.has(kind)) geometry.removeVerticesData(kind);
            data.forEach((values, kind) => geometry.setVerticesData(kind, Float32Array.from(values), true, BABYLON.VertexBuffer.DeduceStride(kind)));
            geometry.setIndices(indices.slice(), data.get(BABYLON.VertexBuffer.PositionKind).length / 3);
            users.forEach((user, userIndex) => {
                user.releaseSubMeshes();
                for (const subMesh of lists[userIndex]) new BABYLON.SubMesh(subMesh.materialIndex, subMesh.verticesStart, subMesh.verticesCount, subMesh.indexStart, subMesh.indexCount, user);
                user.refreshBoundingInfo();
            });
        };
        const after = {
            data: result.data,
            indices: result.indices,
            subMeshes: users.map(() => subMeshes),
            targets: result.targets.map(({ data }) => new Map(targetFields.map(([key]) => [key, data.get(key) ?? null]))),
        };
        return { mesh, capture, write, after };
    }

    /**
     * A new camera of a type the tree offers, in the scene but not in the model (a virtual camera
     * of the views; `addCamera` puts it into the file).
     * @param {string} type ArcRotate camera / Universal camera
     * @param {string} name
     * @returns {BABYLON.Camera}
     */
    newCamera(type, name) {
        return /** @type {BABYLON.Camera} */ (this._create('Cameras', type, name));
    }

    /**
     * Adds a camera to the model (the file) with a new id, as one undoable change.
     * @param {any} json the camera in the `.babylon` format
     * @returns {string} its id in the model
     */
    addCamera(json) {
        const value = { ...json, id: newId() };
        delete value.uniqueId;
        delete value.parentId;
        // The mask of a view (hidden meshes / bones) is not part of the camera
        delete value.layerMask;
        const label = `Add ${json.name ?? 'the camera'} to the file`;
        if (this._binding()) {
            this._postOps(label, [{ op: 'insert', arrayPath: ['cameras'], value }]);
            return value.id;
        }
        const camera = BABYLON.Camera.Parse(value, this._scene);
        // Parsed cameras are already in the scene; the command adds it to the model
        this._detach(camera);
        this._markChanged(camera, 'added');
        this._structural(label, () => this._attach(camera), () => this._detach(camera));
        return value.id;
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
     * @param {{ skeletonId?: string, channels?: ClipChannels }} [choices] answers to a `PasteResult.choose`
     * @returns {PasteResult | undefined}
     */
    paste(section, object, sameFile = false, choices = {}) {
        if (section === 'Skeletons' && object?.kind === 'skeleton') return this._pasteSkeleton(object.value);
        if (section === 'Nodes' && object?.kind === 'node') return this._pasteNodes(object.value, sameFile);
        if (section === 'Animations' && object?.kind === 'clip') return this._pasteClip(object.value, choices, sameFile);
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
        const targets = clip.group.targetedAnimations.map(({ target }) => target);
        const mirrored = ModelEdits._isClipSpaceMirrored(targets, container);
        const skeleton = ClipRetarget.skeletonOf(targets, container);
        const rig = skeleton ? ClipRetarget.rigOf(skeleton, container) : undefined;
        return JSON.parse(JSON.stringify({ type, name: clip.name, length: clip.to - clip.from, tracks, mirrored, rig }, babylonJsonReplacer));
    }

    /**
     * Whether animated targets live in a mirrored space: a bone in that of the meshes it deforms,
     * a node in that of its parent.
     * @param {any[]} targets
     * @param {BABYLON.AssetContainer} container
     * @returns {boolean}
     */
    static _isClipSpaceMirrored(targets, container) {
        const target = targets.find(candidate => candidate instanceof BABYLON.Bone || candidate instanceof BABYLON.TransformNode);
        if (!target) return false;
        if (target instanceof BABYLON.Bone) {
            const skeleton = target.getSkeleton();
            return isMirrored(container.meshes.find(mesh => mesh.skeleton === skeleton));
        }
        // The space of the topmost animated node: the parent of the hierarchy
        let node = target;
        const animated = new Set(targets);
        while (node.parent && animated.has(node.parent)) node = node.parent;
        return isMirrored(node.parent);
    }

    /**
     * Adds a copied clip, its tracks finding their targets by name. A model keeps one kind of clips:
     * an animation group goes in as a new group, a frame range of a timeline as keys appended to the
     * end of the timeline of a skeleton (and of nodes) with a new range. Tracks without a target are
     * left out (the report names them). A clip of another skeleton, or converted, asks how its
     * channels are taken: retargeted to the skeleton (when the clip has its rig), rotations only or all.
     * @param {CopiedClip} copied
     * @param {{ skeletonId?: string, channels?: ClipChannels }} choices
     * @param {boolean} sameFile
     * @returns {PasteResult}
     */
    _pasteClip(copied, choices, sameFile) {
        if (!copied || !Array.isArray(copied.tracks) || !copied.tracks.length) throw new Error('The copied clip has no tracks');
        const container = this._container();
        // A model keeps one kind of clips: a clip of the other kind is converted
        const groups = container.animationGroups.length > 0;
        const timeline = !groups && this._animations.clips.length > 0;
        const kind = groups ? 'group' : timeline ? 'timeline' : copied.type;
        const converted = kind !== copied.type;
        const nodes = new Map([...container.transformNodes, ...container.meshes].map(node => [node.name, node]));
        let skeletons = container.skeletons;
        // Tracks that go to bones once converted: in a timeline every track of a joint node
        const boneTracks = copied.tracks.filter(track => (kind === 'timeline' ? track.target?.kind === 'bone' || (converted && track.target?.kind === 'node') : track.target?.kind === 'bone'));
        const boneNames = [...new Set(boneTracks.map(track => track.target.name))];
        if (boneNames.length && skeletons.length > 1) {
            const chosen = skeletons.find(skeleton => String(skeleton.uniqueId) === choices.skeletonId);
            if (!chosen) {
                return {
                    choose: 'skeleton',
                    options: skeletons.map(skeleton => ({
                        id: String(skeleton.uniqueId),
                        label: skeleton.name || '(unnamed)',
                        description: `${boneNames.filter(boneName => skeleton.bones.some(bone => bone.name === boneName)).length} of ${boneNames.length} bones`,
                    })),
                };
            }
            skeletons = [chosen];
        }
        const skeleton = skeletons[0] ?? null;
        // The skeleton a retargeted clip goes to: that of the bones, or the one of the joint nodes
        const rigSkeleton = kind === 'timeline' && boneNames.length
            ? skeleton
            : ClipRetarget.skeletonByNames(copied.tracks.map(track => track.target?.name), container);
        const canRetarget = !!copied.rig && !!rigSkeleton;
        const ownSkeleton = sameFile && copied.rig?.id === String(rigSkeleton?.id ?? '');
        if (!choices.channels && (converted || (canRetarget && !ownSkeleton))) {
            return {
                choose: 'channels',
                title: converted
                    ? `${copied.name || 'The clip'} is converted to the kind of clips of this model: take`
                    : `${copied.name || 'The clip'} comes from another skeleton: take`,
                options: [
                    ...(canRetarget ? [{ id: 'retarget', label: `Retarget to ${rigSkeleton.name || 'the skeleton'}`, description: 'rotations against the rest poses, moves scaled to the size of the skeleton; bone lengths stay' }] : []),
                    { id: 'all', label: 'As is', description: 'positions, rotations and scalings as in the copied clip' },
                    ...(canRetarget ? [{ id: 'difference', label: 'Difference from the rest pose', description: `each bone moves from the rest pose of ${rigSkeleton.name || 'the skeleton'} as the copied bone from its own` }] : []),
                    { id: 'rotations', label: 'Rotations only', description: 'positions and scalings of the rest pose' },
                ],
            };
        }
        const channels = (choices.channels === 'retarget' || choices.channels === 'difference') && !canRetarget ? 'all' : choices.channels ?? 'all';
        const name = uniqueName(copied.name || 'Clip', this._animations.clips.map(clip => clip.name));
        const { clip: source, note } = this._convertClip(copied, kind, skeleton, nodes, channels, rigSkeleton);
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
        const conversion = converted ? `; converted from ${copied.type === 'group' ? 'an animation group' : 'a frame range'}` : '';
        return { report: `Pasted ${name}: ${matched.length} of ${source.tracks.length} tracks${conversion}${note}${unique.length ? `; not found: ${unique.slice(0, 5).join(', ')}${unique.length > 5 ? ', …' : ''}` : ''}` };
    }

    /**
     * A copied clip in the kind and the space of this model: mirrored between a mirrored (glTF) and
     * a not mirrored space, retargeted or reduced to rotations as chosen, converted between frame
     * ranges and animation groups.
     * @param {CopiedClip} copied
     * @param {'group' | 'timeline'} kind the kind of clips of this model
     * @param {BABYLON.Skeleton | null} skeleton the skeleton a timeline clip goes to
     * @param {Map<string, BABYLON.TransformNode>} nodes nodes of this model by name
     * @param {ClipChannels} channels
     * @param {BABYLON.Skeleton | null} rigSkeleton the skeleton a retargeted clip goes to
     * @returns {{ clip: CopiedClip, note: string }} note tells the report what was done
     */
    _convertClip(copied, kind, skeleton, nodes, channels, rigSkeleton) {
        const container = this._container();
        const targets = copied.tracks.map(track => (kind === 'timeline' && skeleton ? skeleton.bones.find(bone => bone.name === track.target?.name) : null) ?? nodes.get(track.target?.name)).filter(Boolean);
        const mirror = !!copied.mirrored !== ModelEdits._isClipSpaceMirrored(targets, container);
        const restOf = (boneName) => {
            const bone = skeleton?.bones.find(candidate => candidate.name === boneName)
                ?? rigSkeleton?.bones.find(candidate => candidate.name === boneName || candidate.getTransformNode()?.name === boneName);
            return bone ? decomposeTransform(bone.getRestMatrix()) : null;
        };
        // Mirrored and retargeted / reduced in its own kind, then converted
        let clip = mirror ? ClipConverter.mirror(copied) : copied;
        let note = channels === 'rotations' ? ', rotations only' : '';
        if (channels === 'retarget') {
            const rig = mirror ? ClipRetarget.mirrorRig(copied.rig) : copied.rig;
            const retargeted = ClipRetarget.retarget(clip, rig, ClipRetarget.rigOf(rigSkeleton, container));
            clip = retargeted.clip;
            note = `; retargeted to ${rigSkeleton.name || 'the skeleton'} (${retargeted.matched} tracks, size ×${Number(retargeted.scale.toPrecision(3))})`;
        } else if (channels === 'difference') {
            const rig = mirror ? ClipRetarget.mirrorRig(copied.rig) : copied.rig;
            const difference = ClipRetarget.difference(clip, rig, ClipRetarget.rigOf(rigSkeleton, container));
            clip = difference.clip;
            note = `; as the difference from the rest pose (${difference.matched} tracks)`;
        } else if (channels === 'rotations' && kind === clip.type) {
            clip = ClipConverter.rotationsOnly(clip, restOf);
        }
        if (kind === clip.type) return { clip, note };
        const options = { rotationsOnly: channels === 'rotations', mirror: false, restOf };
        return { clip: kind === 'timeline' ? ClipConverter.toTimeline(clip, options) : ClipConverter.toGroup(clip, options), note };
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
    _deleteOps(data, options = {}) {
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
            case 'clip':
                // A clip of a .babylon file is a named frame range of its skeletons / nodes
                return this._clipDeleteOps([object]);
            case 'material':
                container.meshes.filter(mesh => mesh.material === object && binding.pathOf(mesh))
                    .forEach(mesh => ops.push({ op: 'set', path: [...binding.pathOf(mesh), 'materialId'], value: '' }));
                break;
            case 'light': {
                const generator = object.getShadowGenerator?.();
                if (generator && binding.pathOf(generator)) ops.push({ op: 'remove', path: binding.pathOf(generator) });
                break;
            }
            case 'skeleton': {
                // The meshes keep the shape of the bind pose, as they are drawn, without the skin
                const written = new Set();
                for (const { mesh, users, data } of this._bindPoseVertices(object)) {
                    const holder = binding.vertexHolderPath(mesh);
                    if (holder && !written.has(JSON.stringify(holder))) {
                        written.add(JSON.stringify(holder));
                        data.forEach((values, kind) => ops.push({ op: 'set', path: [...holder, VERTEX_PROPERTIES[kind]], value: values ? Array.from(values, float32) : null }));
                    }
                    for (const user of users) {
                        const path = binding.pathOf(user);
                        if (!path) continue;
                        ops.push({ op: 'set', path: [...path, 'skeletonId'], value: null });
                        ops.push({ op: 'set', path: [...path, 'skeletonUniqueId'], value: null });
                        ops.push({ op: 'set', path: [...path, 'numBoneInfluencers'], value: 0 });
                    }
                }
                if (options.withJoints) ops.push(...this._nodeRemovalOps(this._emptiedAncestors(this._jointNodesToRemove(object))));
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

    /**
     * The vertex data a skeleton leaves on the meshes it deforms when it is deleted: the positions
     * and normals of its bind pose as they are drawn (skinned, so a skeleton that turns or scales
     * the mesh — e.g. the armature of a converted glTF model — keeps doing so), the bone influences
     * removed (null). The bind pose is shown for that. Morph targets are not skinned.
     * @param {BABYLON.Skeleton} skeleton
     * @returns {{ mesh: BABYLON.Mesh, users: BABYLON.Mesh[], data: Map<string, Float32Array | null> }[]} one per geometry
     */
    _bindPoseVertices(skeleton) {
        const geometries = new Set();
        const meshes = this._container().meshes.filter((mesh) => {
            if (!(mesh instanceof BABYLON.Mesh) || mesh.skeleton !== skeleton || !mesh.isVerticesDataPresent(BABYLON.VertexBuffer.PositionKind)) return false;
            if (mesh.geometry && geometries.has(mesh.geometry)) return false;
            if (mesh.geometry) geometries.add(mesh.geometry);
            return true;
        });
        if (!meshes.length) return [];
        this._animations.showPose(skeleton, 'bind');
        // The linked nodes (glTF joints) and their parents from the top, then the bone matrices
        const nodes = new Set();
        const addNode = (node) => {
            if (!node || nodes.has(node)) return;
            addNode(node.parent);
            nodes.add(node);
        };
        skeleton.bones.forEach(bone => addNode(bone.getTransformNode()));
        nodes.forEach(node => node.computeWorldMatrix(true));
        skeleton.prepare(true);
        const influences = [BABYLON.VertexBuffer.MatricesIndicesKind, BABYLON.VertexBuffer.MatricesWeightsKind, BABYLON.VertexBuffer.MatricesIndicesExtraKind, BABYLON.VertexBuffer.MatricesWeightsExtraKind];
        return meshes.map((mesh) => {
            /** @type {Map<string, Float32Array | null>} */
            const data = new Map([[BABYLON.VertexBuffer.PositionKind, Float32Array.from(mesh.getPositionData(true, false))]]);
            if (mesh.isVerticesDataPresent(BABYLON.VertexBuffer.NormalKind)) data.set(BABYLON.VertexBuffer.NormalKind, Float32Array.from(mesh.getNormalsData(true, false)));
            influences.filter(kind => mesh.isVerticesDataPresent(kind)).forEach(kind => data.set(kind, null));
            const users = mesh.geometry?.meshes.filter(user => user.skeleton === skeleton) ?? [mesh];
            return { mesh, users, data };
        });
    }

    // --- other formats: the scene -----------------------------------------------------------------

    /**
     * Deleting an object of the scene (other formats), as a pair of steps for one undoable command.
     * @param {import('./ModelOutline').ModelItemData} data
     * @param {DeleteOptions} options
     * @returns {{ apply: () => void, revert: () => void }}
     */
    _sceneDeletion(data, options) {
        const object = objectOf(data);
        const container = this._container();
        if (data.kind === 'shadowGenerator') throw new Error('Delete the light, or set the shadow properties of the light instead');
        if (data.kind === 'clip') {
            const group = object.group;
            const ranges = object.ranges.map(range => ({ range, owner: [...container.skeletons, ...container.meshes].find(owner => owner.getAnimationRange?.(range.name) === range) }));
            return {
                apply: () => (ranges.length ? ranges.forEach(({ range, owner }) => owner?.deleteAnimationRange(range.name, false)) : this._detach(group)),
                revert: () => (ranges.length ? ranges.forEach(({ range, owner }) => owner?.createAnimationRange(range.name, range.from, range.to)) : this._attach(group)),
            };
        }
        // References cleared by the deletion, restored by undo
        const references = [];
        /** @type {{ apply: () => void, revert: () => void }[]} further steps (the skeleton: vertices, joint nodes) */
        const steps = [];
        if (data.kind === 'material') {
            container.meshes.filter(mesh => mesh.material === object).forEach(mesh => references.push([mesh, 'material', object]));
        } else if (data.kind === 'texture') {
            for (const material of container.materials) {
                for (const key of Object.keys(material)) {
                    if (material[key] === object) references.push([material, key, object]);
                }
            }
        } else if (data.kind === 'skeleton') {
            container.meshes.filter(mesh => mesh.skeleton === object).forEach(mesh => references.push([mesh, 'skeleton', object]));
            // The meshes keep the shape of the bind pose; undo puts the skinned vertices back
            const baked = this._bindPoseVertices(object).map(({ mesh, data: after }) => ({
                mesh,
                after,
                before: new Map([...after.keys()].map(kind => [kind, Float32Array.from(mesh.getVerticesData(kind))])),
            }));
            const write = (mesh, values) => {
                values.forEach((array, kind) => {
                    if (array) mesh.setVerticesData(kind, Float32Array.from(array), true, BABYLON.VertexBuffer.DeduceStride(kind));
                    else mesh.removeVerticesData(kind);
                });
                mesh.refreshBoundingInfo();
            };
            steps.push({
                apply: () => baked.forEach(({ mesh, after }) => write(mesh, after)),
                revert: () => baked.forEach(({ mesh, before }) => write(mesh, before)),
            });
            if (options.withJoints) steps.push(this._sceneNodeRemoval(this._emptiedAncestors(this._jointNodesToRemove(object))));
        }
        return {
            apply: () => {
                references.forEach(([target, key]) => { target[key] = null; });
                steps.forEach(step => step.apply());
                this._detach(object);
            },
            revert: () => {
                this._attach(object);
                [...steps].reverse().forEach(step => step.revert());
                references.forEach(([target, key, value]) => { target[key] = value; });
            },
        };
    }

    /**
     * Removing nodes from the scene with the tracks of animation groups that target them (a group
     * left without tracks goes too), as a pair of steps for an undoable command.
     * @param {Set<BABYLON.Node>} nodes
     * @returns {{ apply: () => void, revert: () => void }}
     */
    _sceneNodeRemoval(nodes) {
        const groups = this._container().animationGroups
            .filter(group => group.targetedAnimations.some(({ target }) => nodes.has(target)))
            .map(group => ({ group, all: group.targetedAnimations.slice() }));
        return {
            apply: () => {
                for (const { group, all } of groups) {
                    const kept = all.filter(({ target }) => !nodes.has(target));
                    group.targetedAnimations.splice(0, group.targetedAnimations.length, ...kept);
                    if (!kept.length) this._detach(group);
                }
                nodes.forEach(node => this._detach(node));
            },
            revert: () => {
                nodes.forEach(node => this._attach(node));
                for (const { group, all } of groups) {
                    if (!this._container().animationGroups.includes(group)) this._attach(group);
                    group.targetedAnimations.splice(0, group.targetedAnimations.length, ...all);
                }
            },
        };
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
