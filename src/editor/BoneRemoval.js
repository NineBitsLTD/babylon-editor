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
 * Deletes bones from a skeleton of a `.babylon` document, as document operations (one undo step).
 * A bone has two numbers: its place in `bones` (what `parentBoneIndex` refers to) and its `index`
 * (what the influences of the vertices refer to; glTF models number them as their joints):
 * - the bones after a deleted one move up a place and an index for each deleted one before them;
 *   a bone whose parent is deleted hangs from its nearest kept ancestor, its bind (`matrix`), rest
 *   and timeline keys taking the transforms of the deleted chain between, so it stays in place;
 * - the vertices a deleted bone influenced give its weight to its nearest kept ancestor (to their
 *   other bones when it has none, to a kept bone below it when they have no other), the indices of
 *   the influences are renumbered;
 * - its linked node (glTF joint) is removed: the nodes below it hang from the nearest kept node
 *   above with the transforms of the removed chain, the keys of animation groups are combined, the
 *   animations of the removed nodes are removed.
 */
export class BoneRemoval {

    /**
     * @param {BABYLON.Bone[]} deleted bones of one skeleton
     * @param {object} context
     * @param {BABYLON.AssetContainer} context.container
     * @param {import('./BabylonJsonBinding').BabylonJsonBinding} context.binding
     * @param {any[]} context.bones the bones of the skeleton in the `.babylon` format (as now in the editor)
     * @returns {{ ops: DocumentOp[], report: string }}
     */
    static ops(deleted, { container, binding, bones }) {
        const skeleton = deleted[0]?.getSkeleton();
        if (!skeleton || deleted.some(bone => bone.getSkeleton() !== skeleton)) throw new Error('Delete bones of one skeleton at a time');
        const skeletonPath = binding.pathOf(skeleton);
        if (!skeletonPath) throw new Error(`${skeleton.name || 'The skeleton'} has no place in the file`);
        const places = new Set(deleted.map(bone => skeleton.bones.indexOf(bone)));
        if (places.size >= skeleton.bones.length) throw new Error('A skeleton keeps at least one bone: delete the skeleton instead');
        const parentOf = place => bones[place].parentBoneIndex ?? -1;
        // The deleted places between a bone and its nearest kept ancestor (nearest first), and that ancestor
        const chainAbove = (place) => {
            const chain = [];
            let parent = parentOf(place);
            while (parent >= 0 && places.has(parent)) {
                chain.push(parent);
                parent = parentOf(parent);
            }
            return { chain, kept: parent };
        };
        // The numbers the vertices use
        const vertexIndex = place => (place < 0 ? -1 : bones[place].index ?? place);
        /** @type {Map<number, number>} the number of a deleted bone -> the number of the bone its weight goes to (-1: the other bones of the vertex) */
        const heirs = new Map();
        for (const place of places) {
            const { kept } = chainAbove(place);
            heirs.set(vertexIndex(place), vertexIndex(kept));
        }
        // A kept bone below the deleted ones, for vertices with no other bone
        const below = bones.findIndex((json, place) => !places.has(place) && places.has(parentOf(place)));
        const fallback = vertexIndex(below >= 0 ? below : bones.findIndex((json, place) => !places.has(place)));
        /** @type {DocumentOp[]} */
        const ops = [{ op: 'set', path: [...skeletonPath, 'bones'], value: BoneRemoval._bones(bones, places, chainAbove) }];
        const vertices = BoneRemoval._influenceOps(skeleton, heirs, fallback, { container, binding }, ops);
        const nodes = new Set(deleted.map(bone => bone.getTransformNode()).filter(node => node && binding.pathOf(node)));
        if (nodes.size) BoneRemoval._nodeOps(nodes, binding, ops);
        const moved = bones.filter((json, place) => !places.has(place) && places.has(parentOf(place))).length;
        const report = [
            deleted.length === 1 ? `Deleted ${deleted[0].name}` : `Deleted ${deleted.length} bones`,
            moved ? `${moved} child bone${moved > 1 ? 's' : ''} now hang from the nearest kept bone above` : '',
            vertices ? `the weights of ${vertices} vertices went to the nearest kept bones` : '',
        ].filter(Boolean).join('; ');
        return { ops, report };
    }

    /**
     * @param {any[]} bones
     * @param {Set<number>} places the deleted places
     * @param {(place: number) => { chain: number[], kept: number }} chainAbove
     * @returns {any[]} the kept bones, renumbered; a bone whose parent is deleted takes the transforms of the deleted chain
     */
    static _bones(bones, places, chainAbove) {
        const deletedNumbers = [...places].map(place => bones[place].index ?? place);
        const newPlace = old => old - [...places].filter(place => place < old).length;
        const newNumber = old => old - deletedNumbers.filter(number => number < old).length;
        return bones.filter((_, place) => !places.has(place)).map((json) => {
            const bone = { ...json };
            if (bone.index !== undefined) bone.index = newNumber(bone.index);
            const parent = json.parentBoneIndex ?? -1;
            if (parent >= 0 && places.has(parent)) {
                const { chain, kept } = chainAbove(bones.indexOf(json));
                const removed = chain.map(place => bones[place]);
                bone.parentBoneIndex = kept >= 0 ? newPlace(kept) : -1;
                if (Array.isArray(bone.matrix) && removed.every(link => Array.isArray(link.matrix))) {
                    bone.matrix = floats(removed.reduce((matrix, link) => multiply(matrix, link.matrix), bone.matrix));
                }
                if (Array.isArray(bone.rest) && removed.every(link => Array.isArray(link.rest ?? link.matrix))) {
                    bone.rest = floats(removed.reduce((matrix, link) => multiply(matrix, link.rest ?? link.matrix), bone.rest));
                }
                const animation = BoneRemoval._combinedMatrixAnimation(json, removed);
                if (animation) bone.animation = animation;
            } else if (parent >= 0) {
                bone.parentBoneIndex = newPlace(parent);
            }
            return bone;
        });
    }

    /**
     * The timeline keys of a bone in the space of its new parent: bone × deleted chain, at the frames of all.
     * @param {any} child
     * @param {any[]} chain the deleted bones above it, nearest first
     * @returns {any | null} the animation in the `.babylon` format, null when none is animated
     */
    static _combinedMatrixAnimation(child, chain) {
        const links = [child, ...chain];
        if (!links.some(link => link.animation?.keys?.length)) return null;
        const parsed = links.map(link => ({
            animation: link.animation?.keys?.length ? BABYLON.Animation.Parse(link.animation) : null,
            rest: BABYLON.Matrix.FromArray(link.rest ?? link.matrix),
        }));
        const keys = keyFrames(links.map(link => link.animation)).map(frame => ({
            frame,
            values: floats(parsed.reduce((matrix, { animation, rest }) => (matrix ? matrix.multiply(animation ? animation.evaluate(frame) : rest) : (animation ? animation.evaluate(frame) : rest).clone()), null).asArray()),
        }));
        const source = links.find(link => link.animation)?.animation;
        return { ...source, name: child.animation?.name ?? `${child.name}._matrix`, property: '_matrix', dataType: BABYLON.Animation.ANIMATIONTYPE_MATRIX, keys };
    }

    /**
     * The bone influences of the meshes the skeleton deforms, without the deleted bones.
     * @param {BABYLON.Skeleton} skeleton
     * @param {Map<number, number>} heirs number of a deleted bone -> number of the bone its weight goes to (-1: the others)
     * @param {number} fallback a kept bone for vertices with no other bone
     * @param {{ container: BABYLON.AssetContainer, binding: import('./BabylonJsonBinding').BabylonJsonBinding }} context
     * @param {DocumentOp[]} ops receives the changes
     * @returns {number} the vertices the deleted bones influenced
     */
    static _influenceOps(skeleton, heirs, fallback, { container, binding }, ops) {
        const written = new Set();
        let moved = 0;
        for (const mesh of container.meshes) {
            if (mesh.skeleton !== skeleton || !(mesh instanceof BABYLON.Mesh) || !mesh.isVerticesDataPresent(BABYLON.VertexBuffer.MatricesIndicesKind)) continue;
            const holder = binding.vertexHolderPath(mesh);
            if (!holder) continue;
            const key = JSON.stringify(holder);
            if (written.has(key)) continue;
            written.add(key);
            const sets = INFLUENCES.filter(set => mesh.isVerticesDataPresent(set.indicesKind) && mesh.isVerticesDataPresent(set.weightsKind));
            const indices = sets.map(set => Array.from(mesh.getVerticesData(set.indicesKind)));
            const weights = sets.map(set => Array.from(mesh.getVerticesData(set.weightsKind)));
            moved += BoneRemoval._remap(indices, weights, heirs, fallback);
            sets.forEach((set, setIndex) => {
                ops.push({ op: 'set', path: [...holder, set.indices], value: indices[setIndex] });
                ops.push({ op: 'set', path: [...holder, set.expanded], value: true });
                ops.push({ op: 'set', path: [...holder, set.weights], value: floats(weights[setIndex]) });
            });
        }
        return moved;
    }

    /**
     * Moves the weights of the deleted bones and renumbers the kept ones, in place.
     * @param {number[][]} indices expanded indices, 4 per vertex, of each influence set
     * @param {number[][]} weights
     * @param {Map<number, number>} heirs
     * @param {number} fallback
     * @returns {number} the vertices the deleted bones influenced
     */
    static _remap(indices, weights, heirs, fallback) {
        const vertexCount = (indices[0]?.length ?? 0) / 4;
        const deleted = [...heirs.keys()];
        const renumber = old => old - deleted.filter(number => number < old).length;
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
            let orphaned = 0;
            let touched = false;
            for (const [bone, weight] of [...influences]) {
                if (!heirs.has(bone)) continue;
                touched = true;
                influences.delete(bone);
                const heir = heirs.get(bone);
                if (heir >= 0) influences.set(heir, (influences.get(heir) ?? 0) + weight);
                else orphaned += weight;
            }
            if (touched) moved++;
            if (orphaned > 0) {
                const others = [...influences.values()].reduce((sum, weight) => sum + weight, 0);
                if (others > 0) influences.forEach((weight, bone) => influences.set(bone, weight + orphaned * weight / others));
                else influences.set(Math.max(0, fallback), orphaned);
            }
            const sorted = [...influences].sort((a, b) => b[1] - a[1]);
            indices.forEach((set, setIndex) => {
                for (let slot = 0; slot < 4; slot++) {
                    const [bone, weight] = sorted[setIndex * 4 + slot] ?? [0, 0];
                    set[vertex * 4 + slot] = weight > 0 ? renumber(bone) : 0;
                    weights[setIndex][vertex * 4 + slot] = weight;
                }
            });
        }
        return moved;
    }

    /**
     * Removes the linked nodes of the deleted bones: the nodes below them hang from the nearest kept
     * node above with the transforms of the removed chain, the keys of the animation groups are combined.
     * @param {Set<BABYLON.TransformNode>} removed
     * @param {import('./BabylonJsonBinding').BabylonJsonBinding} binding
     * @param {DocumentOp[]} ops
     */
    static _nodeOps(removed, binding, ops) {
        const document = binding.document;
        const jsonOf = node => binding.pathOf(node).reduce((value, key) => value?.[key], document);
        // The nodes below removed ones that stay, with the removed chain above them (nearest first)
        const moved = [];
        for (const node of removed) {
            for (const child of node.getChildren(candidate => !!binding.pathOf(candidate) && !removed.has(candidate), true)) {
                const chain = [];
                let parent = child.parent;
                while (parent && removed.has(parent)) {
                    chain.push(parent);
                    parent = parent.parent;
                }
                moved.push({ child, chain });
            }
        }
        for (const { child, chain } of moved) {
            const path = binding.pathOf(child);
            const json = jsonOf(child);
            const top = jsonOf(chain[chain.length - 1]);
            ops.push({ op: 'set', path: [...path, 'parentId'], value: top.parentId ?? null });
            const transform = decompose(chain.reduce((matrix, link) => matrix.multiply(nodeMatrix(jsonOf(link))), nodeMatrix(json)));
            ops.push({ op: 'set', path: [...path, 'position'], value: floats(transform.position.asArray()) });
            ops.push({ op: 'set', path: [...path, 'rotationQuaternion'], value: floats(transform.rotation.asArray()) });
            ops.push({ op: 'set', path: [...path, 'scaling'], value: floats(transform.scaling.asArray()) });
        }
        const removedIds = new Set([...removed].map(node => jsonOf(node)?.id));
        (document.animationGroups ?? []).forEach((group, groupIndex) => {
            const targeted = group?.targetedAnimations ?? [];
            const tracksOf = id => targeted.map((track, trackIndex) => ({ track, trackIndex })).filter(({ track }) => track?.targetId === id);
            for (const { child, chain } of moved) {
                const links = [jsonOf(child), ...chain.map(jsonOf)];
                const tracks = links.map(json => tracksOf(json.id));
                if (!tracks.some(list => list.length)) continue;
                BoneRemoval._combineGroupTracks(groupIndex, links, tracks, ops);
            }
            targeted.forEach((track, trackIndex) => {
                if (removedIds.has(track?.targetId)) ops.push({ op: 'remove', path: ['animationGroups', groupIndex, 'targetedAnimations', trackIndex] });
            });
        });
        for (const node of removed) ops.push({ op: 'remove', path: binding.pathOf(node) });
    }

    /**
     * The keys of a node in a group, in the space of the kept node above the removed chain:
     * node × chain, at the frames of all; every channel is keyed (each depends on all of them).
     * @param {number} groupIndex
     * @param {any[]} links the node then the removed nodes above it, as documents
     * @param {{ track: any, trackIndex: number }[][]} tracks the tracks of each link in the group
     * @param {DocumentOp[]} ops
     */
    static _combineGroupTracks(groupIndex, links, tracks, ops) {
        const animationsOf = list => Object.fromEntries(list.map(({ track }) => [track.animation?.property, BABYLON.Animation.Parse(track.animation)]));
        const parsed = links.map((json, index) => ({ animations: animationsOf(tracks[index]), rest: decompose(nodeMatrix(json)) }));
        const localAt = ({ animations, rest }, frame) => {
            const rotation = animations.rotationQuaternion?.evaluate(frame)
                ?? (animations.rotation ? BABYLON.Quaternion.FromEulerVector(animations.rotation.evaluate(frame)) : rest.rotation);
            return BABYLON.Matrix.Compose(animations.scaling?.evaluate(frame) ?? rest.scaling, rotation, animations.position?.evaluate(frame) ?? rest.position);
        };
        const frames = keyFrames(tracks.flat().map(({ track }) => track.animation));
        const transforms = frames.map(frame => ({ frame, transform: decompose(parsed.slice(1).reduce((matrix, link) => matrix.multiply(localAt(link, frame)), localAt(parsed[0], frame))) }));
        const childTracks = tracks[0];
        const template = tracks.flat()[0].track.animation;
        for (const { property, dataType, read } of CHANNELS) {
            const keys = transforms.map(({ frame, transform }) => ({ frame, values: floats(read(transform).asArray()) }));
            const existing = childTracks.find(({ track }) => track.animation?.property === property || (property === 'rotationQuaternion' && track.animation?.property === 'rotation'));
            if (existing) {
                ops.push({ op: 'set', path: ['animationGroups', groupIndex, 'targetedAnimations', existing.trackIndex, 'animation'], value: { ...existing.track.animation, property, dataType, keys } });
            } else {
                ops.push({
                    op: 'insert',
                    arrayPath: ['animationGroups', groupIndex, 'targetedAnimations'],
                    value: { targetId: links[0].id, animation: { name: `${links[0].name}.${property}`, property, dataType, framePerSecond: template?.framePerSecond ?? 60, loopBehavior: template?.loopBehavior ?? 1, keys } },
                });
            }
        }
    }
}
