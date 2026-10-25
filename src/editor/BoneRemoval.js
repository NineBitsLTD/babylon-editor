import * as BABYLON from '@babylonjs/core';
import { float32 } from './BabylonJsonBinding';

/** @typedef {import('./ModelEdits').DocumentOp} DocumentOp */

/** Vertex buffers of the bone influences in the `.babylon` format: indices, weights, the flag of expanded indices. */
const INFLUENCES = [
    { indices: 'matricesIndices', weights: 'matricesWeights', expanded: 'matricesIndicesExpanded', indicesKind: BABYLON.VertexBuffer.MatricesIndicesKind, weightsKind: BABYLON.VertexBuffer.MatricesWeightsKind },
    { indices: 'matricesIndicesExtra', weights: 'matricesWeightsExtra', expanded: 'matricesIndicesExtraExpanded', indicesKind: BABYLON.VertexBuffer.MatricesIndicesExtraKind, weightsKind: BABYLON.VertexBuffer.MatricesWeightsExtraKind },
];

/** Node channels of animation groups: the property, its data type and how a transform gives it. */
const CHANNELS = [
    { property: 'position', dataType: BABYLON.Animation.ANIMATIONTYPE_VECTOR3, read: transform => transform.position },
    { property: 'rotationQuaternion', dataType: BABYLON.Animation.ANIMATIONTYPE_QUATERNION, read: transform => transform.rotation },
    { property: 'scaling', dataType: BABYLON.Animation.ANIMATIONTYPE_VECTOR3, read: transform => transform.scaling },
];

/**
 * @param {number[]} values
 * @returns {number[]} the shortest decimals of the 32-bit floats
 */
function floats(values) {
    return Array.from(values, float32);
}

/**
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number[]} the matrix a × b (row vectors: a is applied first)
 */
function multiply(a, b) {
    return BABYLON.Matrix.FromArray(a).multiply(BABYLON.Matrix.FromArray(b)).asArray();
}

/**
 * The local transform of a node of the document.
 * @param {any} json
 * @returns {BABYLON.Matrix}
 */
function nodeMatrix(json) {
    const rotation = Array.isArray(json?.rotationQuaternion) ? BABYLON.Quaternion.FromArray(json.rotationQuaternion)
        : BABYLON.Quaternion.FromEulerVector(BABYLON.Vector3.FromArray(json?.rotation ?? [0, 0, 0]));
    return BABYLON.Matrix.Compose(BABYLON.Vector3.FromArray(json?.scaling ?? [1, 1, 1]), rotation, BABYLON.Vector3.FromArray(json?.position ?? [0, 0, 0]));
}

/**
 * @param {BABYLON.Matrix} matrix
 * @returns {{ position: BABYLON.Vector3, rotation: BABYLON.Quaternion, scaling: BABYLON.Vector3 }}
 */
function decompose(matrix) {
    const scaling = new BABYLON.Vector3(), rotation = new BABYLON.Quaternion(), position = new BABYLON.Vector3();
    matrix.decompose(scaling, rotation, position);
    return { position, rotation, scaling };
}

/**
 * @param {any[]} animations animations in the `.babylon` format
 * @returns {number[]} the frames of their keys, sorted, once each
 */
function keyFrames(animations) {
    return [...new Set(animations.flatMap(animation => (animation?.keys ?? []).map(key => key.frame)))].sort((a, b) => a - b);
}

/**
 * Deletes a bone from a skeleton of a `.babylon` document, as document operations (one undo step).
 * A bone has two numbers: its place in `bones` (what `parentBoneIndex` refers to) and its `index`
 * (what the influences of the vertices refer to; glTF models number them as their joints):
 * - the bones after it move up one place and one index; the bones it was the parent of hang from its parent,
 *   their bind (`matrix`), rest and timeline keys taking its transform so they stay in place;
 * - the vertices it influenced give its weight to its parent (to their other bones when it was a
 *   root, to its first child when they have none), the indices of the influences are renumbered;
 * - its linked node (glTF joint) is removed: the nodes below it hang from its parent with its
 *   transform, the keys of animation groups of the node and of those nodes are combined, the
 *   animations of the node are removed.
 */
export class BoneRemoval {

    /**
     * @param {BABYLON.Bone} bone
     * @param {object} context
     * @param {BABYLON.AssetContainer} context.container
     * @param {import('./BabylonJsonBinding').BabylonJsonBinding} context.binding
     * @param {any[]} context.bones the bones of its skeleton in the `.babylon` format (as now in the editor)
     * @returns {{ ops: DocumentOp[], report: string }}
     */
    static ops(bone, { container, binding, bones }) {
        const skeleton = bone.getSkeleton();
        const skeletonPath = binding.pathOf(skeleton);
        if (!skeletonPath) throw new Error(`${skeleton.name || 'The skeleton'} has no place in the file`);
        if (skeleton.bones.length < 2) throw new Error('A skeleton keeps at least one bone: delete the skeleton instead');
        const index = skeleton.bones.indexOf(bone);
        const parentIndex = bones[index].parentBoneIndex ?? -1;
        const children = bones.map((json, childIndex) => (json.parentBoneIndex === index ? childIndex : -1)).filter(childIndex => childIndex >= 0);
        // The numbers the vertices use
        const vertexIndex = place => (place < 0 ? -1 : bones[place].index ?? place);
        /** @type {DocumentOp[]} */
        const ops = [{ op: 'set', path: [...skeletonPath, 'bones'], value: BoneRemoval._bones(bones, index) }];
        const vertices = BoneRemoval._influenceOps(skeleton, vertexIndex(index), vertexIndex(parentIndex), vertexIndex(children[0] ?? -1), { container, binding }, ops);
        const node = bone.getTransformNode();
        if (node && binding.pathOf(node)) BoneRemoval._nodeOps(node, binding, ops);
        const parentName = parentIndex >= 0 ? bones[parentIndex].name : null;
        const report = [
            `Deleted ${bone.name}`,
            children.length ? `${children.length} child bone${children.length > 1 ? 's' : ''} now hang from ${parentName ?? 'the root'}` : '',
            vertices ? `the weights of ${vertices} vertices went to ${parentName ?? 'the other bones'}` : '',
        ].filter(Boolean).join('; ');
        return { ops, report };
    }

    /**
     * @param {any[]} bones
     * @param {number} index the place of the deleted bone
     * @returns {any[]} the bones without it, renumbered; its children take its transform
     */
    static _bones(bones, index) {
        const deleted = bones[index];
        const newPlace = old => (old > index ? old - 1 : old);
        const deletedNumber = deleted.index ?? index;
        return bones.filter((_, old) => old !== index).map((json) => {
            const bone = { ...json };
            if (bone.index !== undefined && bone.index > deletedNumber) bone.index -= 1;
            const parent = json.parentBoneIndex ?? -1;
            if (parent === index) {
                bone.parentBoneIndex = newPlace(deleted.parentBoneIndex ?? -1);
                if (Array.isArray(bone.matrix) && Array.isArray(deleted.matrix)) bone.matrix = floats(multiply(bone.matrix, deleted.matrix));
                if (Array.isArray(bone.rest) && Array.isArray(deleted.rest ?? deleted.matrix)) bone.rest = floats(multiply(bone.rest, deleted.rest ?? deleted.matrix));
                const animation = BoneRemoval._combinedMatrixAnimation(json, deleted);
                if (animation) bone.animation = animation;
            } else if (parent >= 0) {
                bone.parentBoneIndex = newPlace(parent);
            }
            return bone;
        });
    }

    /**
     * The timeline keys of a child of the deleted bone in the space of its new parent: child × deleted,
     * at the frames of both.
     * @param {any} child
     * @param {any} deleted
     * @returns {any | null} the animation in the `.babylon` format, null when neither is animated
     */
    static _combinedMatrixAnimation(child, deleted) {
        if (!child.animation?.keys?.length && !deleted.animation?.keys?.length) return null;
        const parse = json => (json?.keys?.length ? BABYLON.Animation.Parse(json) : null);
        const childAnimation = parse(child.animation);
        const deletedAnimation = parse(deleted.animation);
        const childRest = BABYLON.Matrix.FromArray(child.rest ?? child.matrix);
        const deletedRest = BABYLON.Matrix.FromArray(deleted.rest ?? deleted.matrix);
        const keys = keyFrames([child.animation, deleted.animation]).map((frame) => {
            const childMatrix = childAnimation ? childAnimation.evaluate(frame) : childRest;
            const deletedMatrix = deletedAnimation ? deletedAnimation.evaluate(frame) : deletedRest;
            return { frame, values: floats(childMatrix.multiply(deletedMatrix).asArray()) };
        });
        const source = child.animation ?? deleted.animation;
        return { ...source, name: child.animation?.name ?? `${child.name}._matrix`, property: '_matrix', dataType: BABYLON.Animation.ANIMATIONTYPE_MATRIX, keys };
    }

    /**
     * The bone influences of the meshes the skeleton deforms, without the deleted bone.
     * @param {BABYLON.Skeleton} skeleton
     * @param {number} index the number of the deleted bone in the influences
     * @param {number} parentIndex that of its parent, or -1
     * @param {number} childIndex that of its first child, or -1
     * @param {{ container: BABYLON.AssetContainer, binding: import('./BabylonJsonBinding').BabylonJsonBinding }} context
     * @param {DocumentOp[]} ops receives the changes
     * @returns {number} the vertices it influenced
     */
    static _influenceOps(skeleton, index, parentIndex, childIndex, { container, binding }, ops) {
        const document = binding.document;
        const geometries = document.geometries?.vertexData ?? [];
        const written = new Set();
        let moved = 0;
        for (const mesh of container.meshes) {
            if (mesh.skeleton !== skeleton || !(mesh instanceof BABYLON.Mesh) || !mesh.isVerticesDataPresent(BABYLON.VertexBuffer.MatricesIndicesKind)) continue;
            const meshPath = binding.pathOf(mesh);
            if (!meshPath) continue;
            const json = meshPath.reduce((value, key) => value?.[key], document);
            // The vertices are in the mesh object, or in a shared geometry (converted glTF models)
            const geometryIndex = geometries.findIndex(geometry => geometry?.id === json?.geometryId);
            const holder = Array.isArray(json?.matricesIndices) || geometryIndex < 0 ? meshPath : ['geometries', 'vertexData', geometryIndex];
            const key = JSON.stringify(holder);
            if (written.has(key)) continue;
            written.add(key);
            const sets = INFLUENCES.filter(set => mesh.isVerticesDataPresent(set.indicesKind) && mesh.isVerticesDataPresent(set.weightsKind));
            const indices = sets.map(set => Array.from(mesh.getVerticesData(set.indicesKind)));
            const weights = sets.map(set => Array.from(mesh.getVerticesData(set.weightsKind)));
            moved += BoneRemoval._remap(indices, weights, index, parentIndex, childIndex);
            sets.forEach((set, setIndex) => {
                ops.push({ op: 'set', path: [...holder, set.indices], value: indices[setIndex] });
                ops.push({ op: 'set', path: [...holder, set.expanded], value: true });
                ops.push({ op: 'set', path: [...holder, set.weights], value: floats(weights[setIndex]) });
            });
        }
        return moved;
    }

    /**
     * Moves the weight of the deleted bone and renumbers the bones after it, in place.
     * @param {number[][]} indices expanded indices, 4 per vertex, of each influence set (the extra set
     *   holds influences 5 to 8)
     * @param {number[][]} weights
     * @param {number} index
     * @param {number} parentIndex
     * @param {number} childIndex
     * @returns {number} the vertices it influenced
     */
    static _remap(indices, weights, index, parentIndex, childIndex) {
        const vertexCount = (indices[0]?.length ?? 0) / 4;
        const renumber = old => (old > index ? old - 1 : old);
        let moved = 0;
        for (let vertex = 0; vertex < vertexCount; vertex++) {
            /** @type {Map<number, number>} bone -> weight */
            const influences = new Map();
            indices.forEach((set, setIndex) => {
                for (let slot = 0; slot < 4; slot++) {
                    const weight = weights[setIndex][vertex * 4 + slot];
                    if (weight > 0) influences.set(set[vertex * 4 + slot], (influences.get(set[vertex * 4 + slot]) ?? 0) + weight);
                }
            });
            const own = influences.get(index) ?? 0;
            if (own > 0) {
                moved++;
                influences.delete(index);
                const others = [...influences.values()].reduce((sum, weight) => sum + weight, 0);
                if (parentIndex >= 0) {
                    influences.set(parentIndex, (influences.get(parentIndex) ?? 0) + own);
                } else if (others > 0) {
                    influences.forEach((weight, bone) => influences.set(bone, weight + own * weight / others));
                } else {
                    influences.set(Math.max(0, childIndex), own);
                }
            }
            const sorted = [...influences].sort((a, b) => b[1] - a[1]);
            indices.forEach((set, setIndex) => {
                for (let slot = 0; slot < 4; slot++) {
                    const [bone, weight] = sorted[setIndex * 4 + slot] ?? [0, 0];
                    set[vertex * 4 + slot] = renumber(bone);
                    weights[setIndex][vertex * 4 + slot] = weight;
                }
            });
        }
        return moved;
    }

    /**
     * Removes the linked node of the bone: the nodes below it hang from its parent with its
     * transform, the keys of the animation groups are combined.
     * @param {BABYLON.TransformNode} node
     * @param {import('./BabylonJsonBinding').BabylonJsonBinding} binding
     * @param {DocumentOp[]} ops
     */
    static _nodeOps(node, binding, ops) {
        const document = binding.document;
        const nodePath = binding.pathOf(node);
        const nodeJson = nodePath.reduce((value, key) => value?.[key], document);
        const nodeMatrixRest = nodeMatrix(nodeJson);
        const children = node.getChildren(child => !!binding.pathOf(child), true);
        for (const child of children) {
            const path = binding.pathOf(child);
            const json = path.reduce((value, key) => value?.[key], document);
            ops.push({ op: 'set', path: [...path, 'parentId'], value: nodeJson.parentId ?? null });
            const transform = decompose(nodeMatrix(json).multiply(nodeMatrixRest));
            ops.push({ op: 'set', path: [...path, 'position'], value: floats(transform.position.asArray()) });
            ops.push({ op: 'set', path: [...path, 'rotationQuaternion'], value: floats(transform.rotation.asArray()) });
            ops.push({ op: 'set', path: [...path, 'scaling'], value: floats(transform.scaling.asArray()) });
        }
        (document.animationGroups ?? []).forEach((group, groupIndex) => {
            const targeted = group?.targetedAnimations ?? [];
            const tracksOf = id => targeted.map((track, trackIndex) => ({ track, trackIndex })).filter(({ track }) => track?.targetId === id);
            const own = tracksOf(nodeJson.id);
            for (const child of children) {
                const path = binding.pathOf(child);
                const childJson = path.reduce((value, key) => value?.[key], document);
                const childTracks = tracksOf(childJson.id);
                if (!own.length && !childTracks.length) continue;
                BoneRemoval._combineGroupTracks(groupIndex, own, childTracks, nodeJson, childJson, ops);
            }
            own.forEach(({ trackIndex }) => ops.push({ op: 'remove', path: ['animationGroups', groupIndex, 'targetedAnimations', trackIndex] }));
        });
        ops.push({ op: 'remove', path: nodePath });
    }

    /**
     * The keys of a child node in a group, in the space of the parent of the removed node:
     * child × removed, at the frames of both; every channel is keyed (each depends on all of them).
     * @param {number} groupIndex
     * @param {{ track: any, trackIndex: number }[]} own the tracks of the removed node
     * @param {{ track: any, trackIndex: number }[]} childTracks
     * @param {any} nodeJson
     * @param {any} childJson
     * @param {DocumentOp[]} ops
     */
    static _combineGroupTracks(groupIndex, own, childTracks, nodeJson, childJson, ops) {
        const animationsOf = tracks => Object.fromEntries(tracks.map(({ track }) => [track.animation?.property, BABYLON.Animation.Parse(track.animation)]));
        const ownAnimations = animationsOf(own);
        const childAnimations = animationsOf(childTracks);
        const restOf = json => decompose(nodeMatrix(json));
        const localAt = (animations, rest, frame) => {
            const rotation = animations.rotationQuaternion?.evaluate(frame)
                ?? (animations.rotation ? BABYLON.Quaternion.FromEulerVector(animations.rotation.evaluate(frame)) : rest.rotation);
            return BABYLON.Matrix.Compose(animations.scaling?.evaluate(frame) ?? rest.scaling, rotation, animations.position?.evaluate(frame) ?? rest.position);
        };
        const ownRest = restOf(nodeJson);
        const childRest = restOf(childJson);
        const frames = keyFrames([...own, ...childTracks].map(({ track }) => track.animation));
        const transforms = frames.map(frame => ({ frame, transform: decompose(localAt(childAnimations, childRest, frame).multiply(localAt(ownAnimations, ownRest, frame))) }));
        const template = (childTracks[0] ?? own[0]).track.animation;
        for (const { property, dataType, read } of CHANNELS) {
            const keys = transforms.map(({ frame, transform }) => ({ frame, values: floats(read(transform).asArray()) }));
            const existing = childTracks.find(({ track }) => track.animation?.property === property || (property === 'rotationQuaternion' && track.animation?.property === 'rotation'));
            if (existing) {
                ops.push({ op: 'set', path: ['animationGroups', groupIndex, 'targetedAnimations', existing.trackIndex, 'animation'], value: { ...existing.track.animation, property, dataType, keys } });
            } else {
                ops.push({
                    op: 'insert',
                    arrayPath: ['animationGroups', groupIndex, 'targetedAnimations'],
                    value: { targetId: childJson.id, animation: { name: `${childJson.name}.${property}`, property, dataType, framePerSecond: template?.framePerSecond ?? 60, loopBehavior: template?.loopBehavior ?? 1, keys } },
                });
            }
        }
    }
}
