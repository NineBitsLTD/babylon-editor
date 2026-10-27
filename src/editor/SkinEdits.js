import * as BABYLON from '@babylonjs/core';
import { float32 } from './BabylonJsonBinding';
import { SkeletonScale } from './SkeletonScale';

const K = BABYLON.VertexBuffer;

/** The influence sets of a vertex: four bones each (the extra set holds influences 5 to 8). */
const INFLUENCE_SETS = [
    { indicesKind: K.MatricesIndicesKind, weightsKind: K.MatricesWeightsKind, indices: 'matricesIndices', weights: 'matricesWeights', expanded: 'matricesIndicesExpanded' },
    { indicesKind: K.MatricesIndicesExtraKind, weightsKind: K.MatricesWeightsExtraKind, indices: 'matricesIndicesExtra', weights: 'matricesWeightsExtra', expanded: 'matricesIndicesExtraExpanded' },
];

/** Bones that only steer others (IK targets, pole targets, controls) get no automatic weights. */
const CONTROL_BONE = /(^|[._\s-])(ik|pole|ctrl|control|target)/i;
/** Influences a vertex gets from the automatic weights. */
const AUTO_INFLUENCES = 4;

/**
 * The skin of the meshes a skeleton deforms, captured for undo.
 * @typedef {object} SkinState
 * @property {BABYLON.Matrix[]} bind
 * @property {{ mesh: BABYLON.Mesh, data: Map<string, Float32Array>, influencers: number }[]} meshes
 */

/**
 * @param {BABYLON.Mesh} mesh
 * @returns {{ set: typeof INFLUENCE_SETS[number], indices: Float32Array, weights: Float32Array }[]}
 */
function influenceSets(mesh) {
    return INFLUENCE_SETS.filter(set => mesh.isVerticesDataPresent(set.indicesKind) && mesh.isVerticesDataPresent(set.weightsKind))
        .map(set => ({ set, indices: Float32Array.from(mesh.getVerticesData(set.indicesKind)), weights: Float32Array.from(mesh.getVerticesData(set.weightsKind)) }));
}

/**
 * @param {BABYLON.Vector3} point
 * @param {BABYLON.Vector3} start
 * @param {BABYLON.Vector3} end
 * @returns {number} the distance from a point to a segment
 */
function segmentDistance(point, start, end) {
    const direction = end.subtract(start);
    const lengthSquared = direction.lengthSquared();
    const t = lengthSquared > 0 ? Math.min(1, Math.max(0, BABYLON.Vector3.Dot(point.subtract(start), direction) / lengthSquared)) : 0;
    return BABYLON.Vector3.Distance(point, start.add(direction.scale(t)));
}

/**
 * Changes of the skin of the meshes a skeleton deforms (vertices, bone influences, bind pose), as
 * undoable mutations: capture → apply → restore. For a `.babylon` text the influences are written
 * expanded (`BabylonJsonBinding.queueVertexPatch`); positions, normals and bind matrices follow the
 * binding.
 */
export class SkinEdits {

    /**
     * @param {BABYLON.Skeleton} skeleton
     * @param {BABYLON.AssetContainer} container
     * @returns {BABYLON.Mesh[]} the meshes it deforms (a shared geometry once)
     */
    static meshes(skeleton, container) {
        return SkeletonScale.targets(skeleton, container).meshes.filter(mesh => mesh.isVerticesDataPresent(K.MatricesIndicesKind));
    }

    /**
     * @param {BABYLON.Skeleton} skeleton
     * @param {BABYLON.AssetContainer} container
     * @param {import('./AnimationController').AnimationController} animations
     * @returns {SkinState}
     */
    static capture(skeleton, container, animations) {
        const kinds = [K.PositionKind, K.NormalKind, ...INFLUENCE_SETS.flatMap(set => [set.indicesKind, set.weightsKind])];
        return {
            bind: animations.captureBind(skeleton),
            meshes: SkinEdits.meshes(skeleton, container).map(mesh => ({
                mesh,
                influencers: mesh.numBoneInfluencers,
                data: new Map(kinds.filter(kind => mesh.isVerticesDataPresent(kind)).map(kind => [kind, Float32Array.from(mesh.getVerticesData(kind))])),
            })),
        };
    }

    /**
     * @param {BABYLON.Skeleton} skeleton
     * @param {import('./AnimationController').AnimationController} animations
     * @param {SkinState} state
     * @param {import('./BabylonJsonBinding').BabylonJsonBinding | null} [binding]
     */
    static restore(skeleton, animations, state, binding = null) {
        animations.restoreBind(skeleton, state.bind);
        for (const { mesh, data, influencers } of state.meshes) {
            data.forEach((values, kind) => {
                const stride = kind === K.PositionKind || kind === K.NormalKind ? 3 : 4;
                mesh.setVerticesData(kind, Float32Array.from(values), true, stride);
            });
            mesh.numBoneInfluencers = influencers;
            mesh.refreshBoundingInfo();
            SkinEdits._writeInfluences(mesh, binding);
        }
        skeleton.bones.forEach(bone => bone.markAsDirty());
    }

    /**
     * Binds the meshes in the pose shown now: their vertices take the shape the pose gives them and
     * the pose becomes the bind pose (the weights stay), so the meshes look the same in it and the
     * animations deform them from it.
     * @param {BABYLON.Skeleton} skeleton
     * @param {BABYLON.AssetContainer} container
     * @param {import('./AnimationController').AnimationController} animations
     */
    static bindToCurrentPose(skeleton, container, animations) {
        const meshes = SkinEdits.meshes(skeleton, container);
        skeleton.prepare(true);
        // The skin matrices of the pose with the old bind, then with the pose as the bind
        const before = new Map(meshes.map(mesh => [mesh, Float32Array.from(skeleton.getTransformMatrices(mesh))]));
        animations.setBindPoses(skeleton, animations.currentPoses(skeleton));
        skeleton.bones.forEach(bone => bone.markAsDirty());
        skeleton.prepare(true);
        for (const mesh of meshes) {
            const after = skeleton.getTransformMatrices(mesh);
            const count = before.get(mesh).length / 16;
            // A vertex shown as v·F (old bind) is shown as v'·G (new bind): v' = v·F·G⁻¹ per bone
            const corrections = Array.from({ length: count }, (_, bone) => BABYLON.Matrix.FromArray(before.get(mesh), bone * 16)
                .multiply(BABYLON.Matrix.FromArray(after, bone * 16).invert()));
            SkinEdits._transformVertices(mesh, corrections);
        }
    }

    /**
     * Gives the vertices of the meshes the nearest bones of the bind pose: up to four influences
     * each, weighted by the inverse fourth power of the distance to the bone (the segment from its
     * joint to its child joints; a leaf bone continues its parent). Control bones (IK, pole targets)
     * are left out.
     * @param {BABYLON.Skeleton} skeleton
     * @param {BABYLON.AssetContainer} container
     * @param {import('./BabylonJsonBinding').BabylonJsonBinding | null} [binding]
     * @returns {number} the bones that got weights
     */
    static automaticWeights(skeleton, container, binding = null) {
        const segments = SkinEdits._bindSegments(skeleton);
        if (!segments.length) throw new Error('The skeleton has no bones that can deform the mesh');
        const used = new Set();
        for (const mesh of SkinEdits.meshes(skeleton, container)) {
            const positions = mesh.getVerticesData(K.PositionKind);
            const count = positions.length / 3;
            const indices = new Float32Array(count * 4);
            const weights = new Float32Array(count * 4);
            const point = new BABYLON.Vector3();
            for (let vertex = 0; vertex < count; vertex++) {
                point.fromArray(positions, vertex * 3);
                const nearest = segments.map(({ index, start, ends }) => ({ index, distance: Math.min(...ends.map(end => segmentDistance(point, start, end))) }))
                    .sort((a, b) => a.distance - b.distance).slice(0, AUTO_INFLUENCES);
                const scale = Math.max(nearest[0].distance, 1e-6);
                const raw = nearest.map(({ distance }) => 1 / (distance / scale + 1e-3) ** 4);
                const total = raw.reduce((sum, weight) => sum + weight, 0);
                nearest.forEach(({ index }, slot) => {
                    indices[vertex * 4 + slot] = index;
                    weights[vertex * 4 + slot] = raw[slot] / total;
                    if (raw[slot] / total > 0.01) used.add(index);
                });
            }
            mesh.setVerticesData(K.MatricesIndicesKind, indices, true, 4);
            mesh.setVerticesData(K.MatricesWeightsKind, weights, true, 4);
            // The extra set (influences 5 to 8) is not used any more
            if (mesh.isVerticesDataPresent(K.MatricesWeightsExtraKind)) mesh.setVerticesData(K.MatricesWeightsExtraKind, new Float32Array(count * 4), true, 4);
            mesh.numBoneInfluencers = AUTO_INFLUENCES;
            SkinEdits._writeInfluences(mesh, binding);
        }
        return used.size;
    }

    /**
     * Sets one influence of a vertex (a bone and its weight); the other influences of the vertex are
     * scaled so the weights add up to 1 again.
     * @param {BABYLON.Mesh} mesh
     * @param {number} vertex
     * @param {number} slot 0..7 (the influence: its set is slot / 4)
     * @param {number} boneIndex the number of the bone (as the vertices refer to it)
     * @param {number} weight 0..1
     * @param {import('./BabylonJsonBinding').BabylonJsonBinding | null} [binding]
     */
    static setInfluence(mesh, vertex, slot, boneIndex, weight, binding = null) {
        const sets = influenceSets(mesh);
        const target = sets[Math.floor(slot / 4)];
        if (!target) throw new Error('The mesh has no such influence');
        const clamped = Math.min(1, Math.max(0, weight));
        const place = vertex * 4 + (slot % 4);
        target.indices[place] = boneIndex;
        target.weights[place] = clamped;
        // The other influences share what is left
        let others = 0;
        sets.forEach(({ weights }, setIndex) => {
            for (let other = 0; other < 4; other++) if (setIndex * 4 + other !== slot) others += weights[vertex * 4 + other];
        });
        const factor = others > 0 ? (1 - clamped) / others : 0;
        sets.forEach(({ weights }, setIndex) => {
            for (let other = 0; other < 4; other++) if (setIndex * 4 + other !== slot) weights[vertex * 4 + other] *= factor;
        });
        if (others === 0) target.weights[place] = 1;
        for (const { set, indices, weights } of sets) {
            mesh.setVerticesData(set.indicesKind, indices, true, 4);
            mesh.setVerticesData(set.weightsKind, weights, true, 4);
        }
        SkinEdits._writeInfluences(mesh, binding);
    }

    /**
     * Puts back the influences of a vertex as they were (undo of setInfluence).
     * @param {BABYLON.Mesh} mesh
     * @param {number} vertex
     * @param {{ indices: number[], weights: number[] }[]} influences per influence set
     * @param {import('./BabylonJsonBinding').BabylonJsonBinding | null} [binding]
     */
    static setVertexInfluences(mesh, vertex, influences, binding = null) {
        influenceSets(mesh).forEach(({ set, indices, weights }, setIndex) => {
            const saved = influences[setIndex];
            if (!saved) return;
            indices.set(saved.indices, vertex * 4);
            weights.set(saved.weights, vertex * 4);
            mesh.setVerticesData(set.indicesKind, indices, true, 4);
            mesh.setVerticesData(set.weightsKind, weights, true, 4);
        });
        SkinEdits._writeInfluences(mesh, binding);
    }

    /**
     * @param {BABYLON.Mesh} mesh
     * @param {number} boneIndex the number of a bone (as the vertices refer to it)
     * @returns {Map<number, number>} the vertices the bone influences, with its weight
     */
    static boneWeights(mesh, boneIndex) {
        const weights = new Map();
        for (const { indices, weights: values } of influenceSets(mesh)) {
            for (let place = 0; place < indices.length; place++) {
                if (indices[place] !== boneIndex || !(values[place] > 0)) continue;
                const vertex = Math.floor(place / 4);
                weights.set(vertex, (weights.get(vertex) ?? 0) + values[place]);
            }
        }
        return weights;
    }

    /**
     * The skin of meshes (their skeleton, influences and influencers), captured for undo.
     * @param {BABYLON.Mesh[]} meshes
     * @returns {{ mesh: BABYLON.Mesh, skeleton: BABYLON.Skeleton | null, influencers: number, data: Map<string, Float32Array> }[]}
     */
    static captureInfluences(meshes) {
        const kinds = INFLUENCE_SETS.flatMap(set => [set.indicesKind, set.weightsKind]);
        return meshes.map(mesh => ({
            mesh,
            skeleton: mesh.skeleton,
            influencers: mesh.numBoneInfluencers,
            data: new Map(kinds.filter(kind => mesh.isVerticesDataPresent(kind)).map(kind => [kind, Float32Array.from(mesh.getVerticesData(kind))])),
        }));
    }

    /**
     * Puts captured skins back; influences a mesh did not have are removed.
     * @param {ReturnType<typeof SkinEdits.captureInfluences>} state
     * @param {import('./BabylonJsonBinding').BabylonJsonBinding | null} [binding]
     */
    static restoreInfluences(state, binding = null) {
        for (const { mesh, skeleton, influencers, data } of state) {
            mesh.skeleton = skeleton;
            for (const set of INFLUENCE_SETS) {
                for (const kind of [set.indicesKind, set.weightsKind]) {
                    if (data.has(kind)) mesh.setVerticesData(kind, Float32Array.from(data.get(kind)), true, 4);
                    else if (mesh.isVerticesDataPresent(kind)) mesh.removeVerticesData(kind);
                }
            }
            mesh.numBoneInfluencers = influencers;
            SkinEdits._writeInfluences(mesh, binding);
        }
    }

    /**
     * Binds vertices of a mesh to a bone. A vertex no bone influences yet follows the bone alone
     * (weight 1); one influenced by other bones shares its weight between them and the bone as the
     * automatic weights do: by the inverse fourth power of the distance to each bone in the bind pose
     * (at most as many influences as the mesh has slots, the weakest left out). Vertices the bone
     * influences already are not changed. A mesh without a skeleton gets the skeleton of the bone; a
     * mesh without influences gets them, its other vertices following the root bone.
     * @param {BABYLON.Mesh} mesh
     * @param {number[]} vertices
     * @param {BABYLON.Bone} bone
     * @param {import('./BabylonJsonBinding').BabylonJsonBinding | null} [binding]
     * @returns {number} the vertices bound
     */
    static bindToBone(mesh, vertices, bone, binding = null) {
        const skeleton = bone.getSkeleton();
        if (mesh.skeleton && mesh.skeleton !== skeleton) throw new Error(`${mesh.name} is deformed by another skeleton (${mesh.skeleton.name})`);
        const boneIndex = bone.getIndex();
        const count = mesh.getTotalVertices();
        if (!mesh.skeleton) mesh.skeleton = skeleton;
        // The root bone given to the vertices of a mesh without influences is no influence of its own
        const created = !mesh.isVerticesDataPresent(K.MatricesIndicesKind) || !mesh.isVerticesDataPresent(K.MatricesWeightsKind);
        if (created) {
            // A vertex without weights would collapse to the origin: the others follow the root bone
            let root = bone;
            while (root.getParent()) root = root.getParent();
            const indices = new Float32Array(count * 4);
            const weights = new Float32Array(count * 4);
            for (let vertex = 0; vertex < count; vertex++) {
                indices[vertex * 4] = root.getIndex();
                weights[vertex * 4] = 1;
            }
            mesh.setVerticesData(K.MatricesIndicesKind, indices, true, 4);
            mesh.setVerticesData(K.MatricesWeightsKind, weights, true, 4);
        }
        const sets = influenceSets(mesh);
        const slots = sets.length * 4;
        const positions = mesh.getVerticesData(K.PositionKind);
        const segments = new Map(SkinEdits._bindSegments(skeleton, true).map(segment => [segment.index, segment]));
        const point = new BABYLON.Vector3();
        const distanceTo = (index) => {
            const segment = segments.get(index);
            return segment ? Math.min(...segment.ends.map(end => segmentDistance(point, segment.start, end))) : Infinity;
        };
        let bound = 0;
        let used = mesh.numBoneInfluencers;
        for (const vertex of new Set(vertices)) {
            if (vertex < 0 || vertex >= count) continue;
            const current = new Set();
            if (!created) sets.forEach(({ indices, weights }) => {
                for (let slot = 0; slot < 4; slot++) if (weights[vertex * 4 + slot] > 0) current.add(indices[vertex * 4 + slot]);
            });
            if (current.has(boneIndex)) continue;
            let influences;
            if (!current.size) {
                influences = [{ index: boneIndex, weight: 1 }];
            } else {
                point.fromArray(positions, vertex * 3);
                const nearest = [...current, boneIndex].map(index => ({ index, distance: distanceTo(index) }));
                const scale = Math.max(Math.min(...nearest.map(({ distance }) => distance)), 1e-6);
                influences = nearest.map(({ index, distance }) => ({ index, weight: Number.isFinite(distance) ? 1 / (distance / scale + 1e-3) ** 4 : 0 }))
                    .sort((a, b) => b.weight - a.weight).slice(0, slots);
                const total = influences.reduce((sum, { weight }) => sum + weight, 0);
                influences.forEach((influence) => { influence.weight = total > 0 ? influence.weight / total : 0; });
            }
            sets.forEach(({ indices, weights }, setIndex) => {
                for (let slot = 0; slot < 4; slot++) {
                    const influence = influences[setIndex * 4 + slot];
                    indices[vertex * 4 + slot] = influence?.index ?? 0;
                    weights[vertex * 4 + slot] = influence?.weight ?? 0;
                }
            });
            used = Math.max(used, influences.length);
            bound++;
        }
        for (const { set, indices, weights } of sets) {
            mesh.setVerticesData(set.indicesKind, indices, true, 4);
            mesh.setVerticesData(set.weightsKind, weights, true, 4);
        }
        mesh.numBoneInfluencers = Math.min(Math.max(used, 1), slots);
        SkinEdits._writeInfluences(mesh, binding);
        return bound;
    }

    /**
     * The bones that can deform the mesh as segments of the bind pose, in the space of the vertices.
     * @param {BABYLON.Skeleton} skeleton
     * @param {boolean} [withControl] control bones (IK, pole targets) too
     * @returns {{ index: number, start: BABYLON.Vector3, ends: BABYLON.Vector3[] }[]}
     */
    static _bindSegments(skeleton, withControl = false) {
        const heads = new Map(skeleton.bones.map(bone => [bone, bone.getAbsoluteInverseBindMatrix().clone().invert().getTranslation()]));
        const deforming = skeleton.bones.filter(bone => withControl || !CONTROL_BONE.test(bone.name));
        return deforming.map((bone) => {
            const start = heads.get(bone);
            const children = bone.getChildren().filter(child => deforming.includes(child)).map(child => heads.get(child));
            const parent = bone.getParent();
            // A leaf bone continues the direction of its parent by half its length
            const ends = children.length ? children
                : [parent ? start.add(start.subtract(heads.get(parent)).scale(0.5)) : start];
            return { index: bone.getIndex(), start, ends };
        });
    }

    /**
     * Moves the vertices (and normals) of a mesh by the blend of per-bone matrices, with its weights.
     * @param {BABYLON.Mesh} mesh
     * @param {BABYLON.Matrix[]} matrices by bone number
     */
    static _transformVertices(mesh, matrices) {
        const sets = influenceSets(mesh);
        const positions = Float32Array.from(mesh.getVerticesData(K.PositionKind));
        const normals = mesh.isVerticesDataPresent(K.NormalKind) ? Float32Array.from(mesh.getVerticesData(K.NormalKind)) : null;
        const blend = new BABYLON.Matrix();
        const scaled = new BABYLON.Matrix();
        const point = new BABYLON.Vector3();
        for (let vertex = 0; vertex < positions.length / 3; vertex++) {
            blend.copyFrom(BABYLON.Matrix.Zero());
            let total = 0;
            for (const { indices, weights } of sets) {
                for (let slot = 0; slot < 4; slot++) {
                    const weight = weights[vertex * 4 + slot];
                    const matrix = matrices[indices[vertex * 4 + slot]];
                    if (!(weight > 0) || !matrix) continue;
                    matrix.scaleToRef(weight, scaled);
                    blend.addToSelf(scaled);
                    total += weight;
                }
            }
            if (total <= 0) continue;
            point.fromArray(positions, vertex * 3);
            BABYLON.Vector3.TransformCoordinatesToRef(point, blend, point);
            point.toArray(positions, vertex * 3);
            if (normals) {
                point.fromArray(normals, vertex * 3);
                BABYLON.Vector3.TransformNormalToRef(point, blend, point);
                point.normalize().toArray(normals, vertex * 3);
            }
        }
        mesh.setVerticesData(K.PositionKind, positions, true, 3);
        if (normals) mesh.setVerticesData(K.NormalKind, normals, true, 3);
        mesh.refreshBoundingInfo();
    }

    /**
     * Writes the bone influences of a mesh into the `.babylon` text (expanded indices).
     * @param {BABYLON.Mesh} mesh
     * @param {import('./BabylonJsonBinding').BabylonJsonBinding | null} binding
     */
    static _writeInfluences(mesh, binding) {
        if (!binding) return;
        for (const { set, indices, weights } of influenceSets(mesh)) {
            binding.queueVertexPatch(mesh, set.indices, Array.from(indices));
            binding.queueVertexPatch(mesh, set.expanded, true);
            binding.queueVertexPatch(mesh, set.weights, Array.from(weights, float32));
        }
        // A property of each mesh using the geometry
        for (const user of mesh.geometry?.meshes ?? [mesh]) {
            user.numBoneInfluencers = mesh.numBoneInfluencers;
            binding.queuePatch(user, 'numBoneInfluencers', mesh.numBoneInfluencers);
        }
    }
}
