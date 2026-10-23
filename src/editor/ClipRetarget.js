import * as BABYLON from '@babylonjs/core';

/** @typedef {import('./ModelEdits').CopiedClip} CopiedClip */
/** @typedef {CopiedClip['tracks'][number]} CopiedTrack */

/**
 * A bone of a rig: its name, the name of its linked node (glTF joints), its parent and its local
 * rest matrix; a root bone has the world matrix of the space it lives in.
 * @typedef {object} RigBone
 * @property {string} name
 * @property {string | null} node name of the linked node
 * @property {string | null} parent name of the parent bone
 * @property {number[]} rest local rest matrix (16 numbers)
 * @property {number[]} [space] world matrix of the space of a root bone (16 numbers)
 */

/**
 * The rest pose of a skeleton, enough to retarget animations from or to it (kept with a copied
 * clip as plain arrays, so it goes through the clipboard).
 * @typedef {{ id: string, bones: RigBone[] }} Rig id: the id of the skeleton in its file
 */

/**
 * The rest pose of a bone of a rig in the world.
 * @typedef {object} RigPose
 * @property {RigBone} bone
 * @property {BABYLON.Vector3} restPosition local rest position
 * @property {BABYLON.Vector3} restScaling local rest scaling
 * @property {BABYLON.Quaternion} world world rest rotation (mirroring left out)
 * @property {BABYLON.Matrix} worldMatrix world rest matrix
 * @property {BABYLON.Quaternion} parentWorld world rest rotation of the parent (or of the space)
 * @property {BABYLON.Matrix} parentWorldMatrix world rest matrix of the parent (or of the space)
 */

const T = BABYLON.Animation;
const MIRROR = BABYLON.Matrix.Scaling(1, 1, -1);
const HALF_TURN = BABYLON.Matrix.RotationY(Math.PI);

/**
 * @param {BABYLON.Matrix} matrix
 * @returns {BABYLON.Quaternion} the rotation of a matrix; a mirroring matrix is unmirrored along Z
 *   first (`S·M`), the same way for every rig, so the rotations of two rigs compare
 */
function rotationOf(matrix) {
    const unmirrored = matrix.determinant() < 0 ? MIRROR.multiply(matrix) : matrix;
    const rotation = new BABYLON.Quaternion();
    unmirrored.decompose(new BABYLON.Vector3(), rotation, new BABYLON.Vector3());
    return rotation;
}

/**
 * @param {BABYLON.Bone} bone
 * @param {BABYLON.Skeleton} skeleton
 * @param {BABYLON.AssetContainer} container
 * @returns {BABYLON.Matrix} the world matrix of the space of a root bone: the parent of its linked
 *   node, else the mesh the skeleton deforms (bones are in its space)
 */
function rootSpace(bone, skeleton, container) {
    const node = bone.getTransformNode();
    if (node) return node.parent ? node.parent.computeWorldMatrix(true).clone() : BABYLON.Matrix.Identity();
    const mesh = container.meshes.find(candidate => candidate.skeleton === skeleton);
    return mesh ? mesh.computeWorldMatrix(true).clone() : BABYLON.Matrix.Identity();
}

/**
 * Retargets animations between skeletons of different proportions, sizes and rest poses, by bone
 * names (a bone found by its own name or by the name of its linked node).
 *
 * Every bone keeps, against its rest pose, the world rotation the source bone has against its
 * own: `q_t = conj(Wt(p))·Ws(p) · q_s · conj(Ws(b))·Wt(b)` with the world rest rotations W of the
 * bone b and its parent p (the rest pose of the source plays as the rest pose of the target).
 * Positions move from the rest of the target by the move of the source from its rest, turned into
 * the target's parent space and scaled by the size of the skeletons (bone lengths stay those of the
 * target, moves of the root keep their stride). Scalings stay those of the target.
 * Assumes matched bones have matched parents; tracks of unmatched targets stay as they are.
 */
export class ClipRetarget {

    /**
     * @param {BABYLON.Skeleton} skeleton
     * @param {BABYLON.AssetContainer} container
     * @returns {Rig}
     */
    static rigOf(skeleton, container) {
        return {
            id: String(skeleton.id ?? ''),
            bones: skeleton.bones.map((bone) => {
                const parent = bone.getParent();
                return {
                    name: bone.name,
                    node: bone.getTransformNode()?.name ?? null,
                    parent: parent?.name ?? null,
                    rest: Array.from(bone.getRestMatrix().m),
                    ...(parent ? {} : { space: Array.from(rootSpace(bone, skeleton, container).m) }),
                };
            }),
        };
    }

    /**
     * @param {any[]} targets animated bones and nodes
     * @param {BABYLON.AssetContainer} container
     * @returns {BABYLON.Skeleton | null} the skeleton most of the targets belong to (as bones or as
     *   their linked nodes)
     */
    static skeletonOf(targets, container) {
        let best = null;
        let bestCount = 0;
        for (const skeleton of container.skeletons) {
            const own = new Set(skeleton.bones.flatMap(bone => [bone, bone.getTransformNode()].filter(Boolean)));
            const count = targets.filter(target => own.has(target)).length;
            if (count > bestCount) [best, bestCount] = [skeleton, count];
        }
        return best;
    }

    /**
     * @param {string[]} names target names of tracks
     * @param {BABYLON.AssetContainer} container
     * @returns {BABYLON.Skeleton | null} the skeleton with the most bones of these names
     */
    static skeletonByNames(names, container) {
        let best = null;
        let bestCount = 0;
        const wanted = new Set(names);
        for (const skeleton of container.skeletons) {
            const count = skeleton.bones.filter(bone => wanted.has(bone.name) || wanted.has(bone.getTransformNode()?.name)).length;
            if (count > bestCount) [best, bestCount] = [skeleton, count];
        }
        return best;
    }

    /**
     * @param {Rig} rig
     * @returns {Rig} the rig mirrored along Z (as the tracks of a clip pasted between a mirrored
     *   and a not mirrored space): rests `S·R·S`, spaces `S·M·Ry(180°)`. The half turn is the one of
     *   the glTF `__root__` node (`S·Ry(180°)`), so the rig faces as its mirrored tracks do in the
     *   other convention (glTF models face +Z, others -Z), as with `ClipConverter.mirror`
     */
    static mirrorRig(rig) {
        return {
            ...rig,
            bones: rig.bones.map(bone => ({
                ...bone,
                rest: Array.from(MIRROR.multiply(BABYLON.Matrix.FromArray(bone.rest)).multiply(MIRROR).m),
                ...(bone.space ? { space: Array.from(MIRROR.multiply(BABYLON.Matrix.FromArray(bone.space)).multiply(HALF_TURN).m) } : {}),
            })),
        };
    }

    /**
     * @param {CopiedClip} clip
     * @param {Rig} sourceRig the rig the clip was made for
     * @param {Rig} targetRig
     * @returns {{ clip: CopiedClip, scale: number, matched: number }} the clip for the target rig;
     *   scale is the size of the target against the source, matched the number of retargeted tracks
     */
    static retarget(clip, sourceRig, targetRig) {
        const source = ClipRetarget._poses(sourceRig);
        const target = ClipRetarget._poses(targetRig);
        const scale = ClipRetarget._scale(source, target);
        const tracks = [];
        let matched = 0;
        for (const track of clip.tracks) {
            const from = source.get(track.target?.name);
            const to = target.get(track.target?.name);
            if (!from || !to) {
                tracks.push(track);
                continue;
            }
            const retargeted = ClipRetarget._track(track, ClipRetarget._mapping(from, to, scale));
            if (retargeted) tracks.push(retargeted);
            matched++;
        }
        return { clip: { ...clip, tracks }, scale, matched };
    }

    /**
     * @param {Rig} rig
     * @returns {Map<string, RigPose>} the world rest pose of each bone, by bone and by node name
     */
    static _poses(rig) {
        const bones = new Map(rig.bones.map(bone => [bone.name, bone]));
        /** @type {Map<RigBone, RigPose>} */
        const poses = new Map();
        const poseOf = (bone, depth = 0) => {
            const known = poses.get(bone);
            if (known) return known;
            const parentBone = bone.parent !== null ? bones.get(bone.parent) : null;
            // A cycle or a missing parent: the bone counts as a root in the identity space
            const parent = parentBone && depth < rig.bones.length ? poseOf(parentBone, depth + 1) : null;
            const parentWorldMatrix = parent ? parent.worldMatrix : (bone.space ? BABYLON.Matrix.FromArray(bone.space) : BABYLON.Matrix.Identity());
            const parentWorld = parent ? parent.world : rotationOf(parentWorldMatrix);
            const rest = BABYLON.Matrix.FromArray(bone.rest);
            const restPosition = new BABYLON.Vector3();
            const restRotation = new BABYLON.Quaternion();
            const restScaling = new BABYLON.Vector3();
            rest.decompose(restScaling, restRotation, restPosition);
            const pose = {
                bone,
                restPosition,
                restScaling,
                world: parentWorld.multiply(restRotation),
                worldMatrix: rest.multiply(parentWorldMatrix),
                parentWorld,
                parentWorldMatrix,
            };
            poses.set(bone, pose);
            return pose;
        };
        /** @type {Map<string, RigPose>} */
        const byName = new Map();
        for (const bone of rig.bones) byName.set(bone.name, poseOf(bone));
        for (const bone of rig.bones) {
            if (bone.node && !byName.has(bone.node)) byName.set(bone.node, poseOf(bone));
        }
        return byName;
    }

    /**
     * @param {Map<string, RigPose>} source
     * @param {Map<string, RigPose>} target
     * @returns {number} the size of the target skeleton against the source: the diagonals of the
     *   boxes around the world rest positions of the bones both have (1 when they cannot tell)
     */
    static _scale(source, target) {
        const sourcePoints = [];
        const targetPoints = [];
        for (const [name, pose] of source) {
            const other = target.get(name);
            if (!other || pose.bone.name !== name) continue;
            sourcePoints.push(pose.worldMatrix.getTranslation());
            targetPoints.push(other.worldMatrix.getTranslation());
        }
        const diagonal = (points) => {
            if (points.length < 2) return 0;
            const min = points.reduce((a, b) => BABYLON.Vector3.Minimize(a, b));
            const max = points.reduce((a, b) => BABYLON.Vector3.Maximize(a, b));
            return max.subtract(min).length();
        };
        const sourceSize = diagonal(sourcePoints);
        const targetSize = diagonal(targetPoints);
        return sourceSize > 1e-9 && targetSize > 1e-9 ? targetSize / sourceSize : 1;
    }

    /**
     * @param {RigPose} from
     * @param {RigPose} to
     * @param {number} scale
     * @returns {{ rotation: (q: BABYLON.Quaternion) => BABYLON.Quaternion, move: (v: BABYLON.Vector3) => BABYLON.Vector3,
     *   position: (p: BABYLON.Vector3) => BABYLON.Vector3, scaling: BABYLON.Vector3 }} rotation and move are
     *   linear (also for tangents); position moves from the target rest
     */
    static _mapping(from, to, scale) {
        const before = BABYLON.Quaternion.Inverse(to.parentWorld).multiply(from.parentWorld);
        const after = BABYLON.Quaternion.Inverse(from.world).multiply(to.world);
        // A vector of the source parent space into the target parent space (row vectors: v·Ms·Mt⁻¹)
        const toParent = from.parentWorldMatrix.multiply(BABYLON.Matrix.Invert(to.parentWorldMatrix));
        const move = v => BABYLON.Vector3.TransformNormal(v, toParent).scaleInPlace(scale);
        return {
            rotation: q => before.multiply(q).multiply(after),
            move,
            position: p => to.restPosition.add(move(p.subtract(from.restPosition))),
            scaling: to.restScaling.clone(),
        };
    }

    /**
     * @param {CopiedTrack} track
     * @param {ReturnType<typeof ClipRetarget._mapping>} mapping
     * @returns {CopiedTrack | null} the track with retargeted keys; null for a scaling track (the
     *   target keeps its own scaling)
     */
    static _track(track, mapping) {
        const property = track.animation.property;
        if (property === 'scaling') return null;
        const animation = BABYLON.Animation.Parse(track.animation);
        /** @type {(key: BABYLON.IAnimationKey) => BABYLON.IAnimationKey} */
        let mapKey;
        if (property === '_matrix') {
            mapKey = (key) => {
                const position = new BABYLON.Vector3();
                const rotation = new BABYLON.Quaternion();
                key.value.decompose(new BABYLON.Vector3(), rotation, position);
                return { ...key, value: BABYLON.Matrix.Compose(mapping.scaling, mapping.rotation(rotation), mapping.position(position)) };
            };
        } else if (property === 'rotationQuaternion') {
            mapKey = key => ({
                ...key,
                value: mapping.rotation(key.value),
                ...(key.inTangent ? { inTangent: mapping.rotation(key.inTangent) } : {}),
                ...(key.outTangent ? { outTangent: mapping.rotation(key.outTangent) } : {}),
            });
        } else if (property === 'rotation' && animation.dataType === T.ANIMATIONTYPE_VECTOR3) {
            // Euler angles: tangents cannot be turned linearly, the keys are interpolated without them
            mapKey = (key) => {
                const plain = { ...key };
                delete plain.inTangent;
                delete plain.outTangent;
                return { ...plain, value: mapping.rotation(BABYLON.Quaternion.FromEulerVector(key.value)).toEulerAngles() };
            };
        } else if (property === 'position') {
            mapKey = key => ({
                ...key,
                value: mapping.position(key.value),
                ...(key.inTangent ? { inTangent: mapping.move(key.inTangent) } : {}),
                ...(key.outTangent ? { outTangent: mapping.move(key.outTangent) } : {}),
            });
        } else {
            return track;
        }
        animation.setKeys(animation.getKeys().map(mapKey));
        return { ...track, animation: { ...track.animation, keys: animation.serialize().keys } };
    }
}
