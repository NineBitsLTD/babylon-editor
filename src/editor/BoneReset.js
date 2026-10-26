import * as BABYLON from '@babylonjs/core';
import { SkeletonScale } from './SkeletonScale';

/**
 * What resetting bones changes, captured for undo.
 * @typedef {object} BoneResetState
 * @property {BABYLON.Matrix[]} bind stored bind matrices of the bones
 * @property {BABYLON.Matrix[]} rest
 * @property {BABYLON.Matrix[]} local current local matrices of the bones
 * @property {({ position: BABYLON.Vector3, rotation: BABYLON.Vector3, rotationQuaternion: BABYLON.Quaternion | null, scaling: BABYLON.Vector3 } | null)[]} nodes
 *   transforms of the nodes linked to the bones (glTF joints)
 * @property {{ animation: BABYLON.Animation, keys: BABYLON.IAnimationKey[] }[]} keys
 */

/** Node properties of the joint tracks that are converted. */
const NODE_PROPERTIES = new Set(['position', 'rotationQuaternion', 'rotation', 'scaling']);

/**
 * @param {any} value
 * @returns {any}
 */
function cloneValue(value) {
    return value?.clone ? value.clone() : value;
}

/**
 * @param {BABYLON.TransformNode} node
 * @returns {BABYLON.Matrix} its local matrix from position, rotation and scaling
 */
function nodeMatrix(node) {
    const rotation = node.rotationQuaternion ?? BABYLON.Quaternion.FromEulerVector(node.rotation);
    return BABYLON.Matrix.Compose(node.scaling, rotation, node.position);
}

/**
 * @param {BABYLON.Matrix} matrix
 * @returns {{ scaling: BABYLON.Vector3, rotation: BABYLON.Quaternion, position: BABYLON.Vector3 }}
 */
function decompose(matrix) {
    const scaling = new BABYLON.Vector3();
    const rotation = new BABYLON.Quaternion();
    const position = new BABYLON.Vector3();
    matrix.decompose(scaling, rotation, position);
    return { scaling, rotation, position };
}

/**
 * Resets the bind pose of bones: each selected bone gets no rotation and a scaling of 1 against
 * the space of its root bone (the space its local values are shown in: the parent node of a glTF
 * root joint, else the mesh), its joint stays where it is (so the bone lengths stay). The mesh and the
 * animations look the same: every bone gets a fixed change of axes D = A'·A⁻¹ (A the absolute bind
 * matrix before, A' after; D has no translation since the joint does not move), and every local
 * matrix of the bone — bind, rest, the current pose, animation keys — becomes D·L·Dparent⁻¹, so its
 * world matrix becomes D·W and the skinning A'⁻¹·D·W = A⁻¹·W does not change.
 * A reset root bone keeps only its position against its parent space; a reset bone below a reset
 * parent has no rotation and a scaling of 1 in the table. Joint tracks of glTF animation groups are converted channel by channel: positions and
 * rotations exactly while the bind matrices have no scaling; scalings are scaled by the ratio of
 * the scalings of the changes (exact for uniform scalings).
 */
export class BoneReset {

    /**
     * @param {BABYLON.Skeleton} skeleton
     * @param {BABYLON.AssetContainer} container
     * @returns {{ matrices: BABYLON.Animation[], tracks: { animation: BABYLON.Animation, bone: BABYLON.Bone }[] }}
     *   the bone matrix animations and the tracks of the linked nodes
     */
    static targets(skeleton, container) {
        const bones = new Set(skeleton.bones);
        const boneOfNode = new Map(skeleton.bones.filter(bone => bone.getTransformNode()).map(bone => [bone.getTransformNode(), bone]));
        const matrices = new Set(skeleton.bones.flatMap(bone => bone.animations).filter(animation => animation.targetProperty === '_matrix'));
        /** @type {Map<BABYLON.Animation, BABYLON.Bone>} */
        const tracks = new Map();
        for (const [node, bone] of boneOfNode) {
            node.animations.filter(animation => NODE_PROPERTIES.has(animation.targetProperty)).forEach(animation => tracks.set(animation, bone));
        }
        for (const group of container.animationGroups) {
            for (const { animation, target } of group.targetedAnimations) {
                if (bones.has(target) && animation.targetProperty === '_matrix') matrices.add(animation);
                if (boneOfNode.has(target) && NODE_PROPERTIES.has(animation.targetProperty)) tracks.set(animation, boneOfNode.get(target));
            }
        }
        return { matrices: [...matrices], tracks: [...tracks].map(([animation, bone]) => ({ animation, bone })) };
    }

    /**
     * @param {BABYLON.Skeleton} skeleton
     * @param {BABYLON.AssetContainer} container
     * @param {import('./AnimationController').AnimationController} animations
     * @returns {BoneResetState}
     */
    static capture(skeleton, container, animations) {
        const { matrices, tracks } = BoneReset.targets(skeleton, container);
        return {
            bind: animations.captureBind(skeleton),
            rest: skeleton.bones.map(bone => bone.getRestMatrix().clone()),
            local: skeleton.bones.map(bone => bone.getLocalMatrix().clone()),
            nodes: skeleton.bones.map((bone) => {
                const node = bone.getTransformNode();
                return node ? { position: node.position.clone(), rotation: node.rotation.clone(), rotationQuaternion: node.rotationQuaternion?.clone() ?? null, scaling: node.scaling.clone() } : null;
            }),
            keys: [...matrices, ...tracks.map(({ animation }) => animation)].map(animation => ({ animation, keys: SkeletonScale._mapKeys(animation.getKeys(), cloneValue) })),
        };
    }

    /**
     * @param {BABYLON.Skeleton} skeleton
     * @param {BABYLON.Bone[]} reset the bones to reset (the others keep their axes)
     * @param {BABYLON.AssetContainer} container
     * @param {import('./AnimationController').AnimationController} animations
     * @param {import('./BabylonJsonBinding').BabylonJsonBinding | null} [binding] of a `.babylon` text:
     *   the transforms of linked nodes an animation drives are written explicitly (the binding does
     *   not compare them)
     */
    static apply(skeleton, reset, container, animations, binding = null) {
        const changes = BoneReset._changes(skeleton, new Set(reset), container, animations);
        const identity = BABYLON.Matrix.Identity();
        const own = bone => changes.get(bone);
        const parentInverse = bone => (bone.getParent() ? changes.get(bone.getParent()).inverse : identity);
        /** @param {BABYLON.Bone} bone @param {BABYLON.Matrix} local */
        const convert = (bone, local) => own(bone).change.multiply(local).multiply(parentInverse(bone));
        animations.setBindPoses(skeleton, skeleton.bones.map(bone => convert(bone, animations.poseMatrix(bone, 'bind'))));
        for (const bone of skeleton.bones) {
            bone.setRestMatrix(convert(bone, bone.getRestMatrix()));
            const node = bone.getTransformNode();
            if (node) {
                const { scaling, rotation, position } = decompose(convert(bone, nodeMatrix(node)));
                node.position.copyFrom(position);
                node.scaling.copyFrom(scaling);
                if (node.rotationQuaternion) node.rotationQuaternion.copyFrom(rotation);
                else node.rotation.copyFrom(rotation.toEulerAngles());
                // In the file a linked node holds the rest pose of its bone
                if (binding) {
                    const rest = decompose(bone.getRestMatrix());
                    binding.queuePatch(node, 'position', rest.position.asArray());
                    binding.queuePatch(node, 'rotationQuaternion', rest.rotation.asArray());
                    binding.queuePatch(node, 'scaling', rest.scaling.asArray());
                }
            } else {
                bone._matrix = convert(bone, bone.getLocalMatrix());
            }
        }
        const { matrices, tracks } = BoneReset.targets(skeleton, container);
        for (const animation of matrices) {
            const bone = skeleton.bones.find(candidate => candidate.animations.includes(animation))
                ?? container.animationGroups.flatMap(group => group.targetedAnimations).find(target => target.animation === animation)?.target;
            if (!changes.has(bone)) continue;
            animation.setKeys(SkeletonScale._mapKeys(animation.getKeys(), value => convert(bone, value)), true);
        }
        for (const { animation, bone } of tracks) {
            animation.setKeys(SkeletonScale._mapKeys(animation.getKeys(), value => BoneReset._convertChannel(animation.targetProperty, value, own(bone), bone.getParent() ? changes.get(bone.getParent()) : null)), true);
        }
        skeleton.bones.forEach(bone => bone.markAsDirty());
    }

    /**
     * @param {BABYLON.Skeleton} skeleton
     * @param {BoneResetState} state from capture
     * @param {import('./AnimationController').AnimationController} animations
     */
    static restore(skeleton, state, animations) {
        animations.restoreBind(skeleton, state.bind);
        skeleton.bones.forEach((bone, index) => {
            bone.setRestMatrix(state.rest[index].clone());
            const node = bone.getTransformNode();
            const saved = state.nodes[index];
            if (node && saved) {
                node.position.copyFrom(saved.position);
                node.rotation.copyFrom(saved.rotation);
                node.rotationQuaternion = saved.rotationQuaternion?.clone() ?? null;
                node.scaling.copyFrom(saved.scaling);
            } else if (!node) {
                bone._matrix = state.local[index].clone();
            }
        });
        state.keys.forEach(({ animation, keys }) => animation.setKeys(SkeletonScale._mapKeys(keys, cloneValue), true));
        skeleton.bones.forEach(bone => bone.markAsDirty());
    }

    /**
     * The change of axes of every bone, from the roots down.
     * @param {BABYLON.Skeleton} skeleton
     * @param {Set<BABYLON.Bone>} reset
     * @param {BABYLON.AssetContainer} container
     * @param {import('./AnimationController').AnimationController} animations
     * @returns {Map<BABYLON.Bone, { change: BABYLON.Matrix, inverse: BABYLON.Matrix, scaling: BABYLON.Vector3 }>}
     */
    static _changes(skeleton, reset, container, animations) {
        const mesh = container.meshes.find(candidate => candidate.skeleton === skeleton);
        const skeletonSpace = mesh ? mesh.computeWorldMatrix(true).clone() : BABYLON.Matrix.Identity();
        /** @type {Map<BABYLON.Bone, BABYLON.Matrix>} absolute bind matrices in the world */
        const absolute = new Map();
        /** @type {Map<BABYLON.Bone, { change: BABYLON.Matrix, inverse: BABYLON.Matrix, scaling: BABYLON.Vector3 }>} */
        const changes = new Map();
        /** @param {BABYLON.Bone} bone @param {BABYLON.Matrix} model the space of its root bone */
        const visit = (bone, model) => {
            const parent = bone.getParent();
            const parentSpace = parent ? absolute.get(parent) : model;
            const before = animations.poseMatrix(bone, 'bind').multiply(parentSpace);
            absolute.set(bone, before);
            let change = BABYLON.Matrix.Identity();
            if (reset.has(bone)) {
                // The axes of the space of the root bone at the place of the joint
                const after = model.clone();
                const joint = before.getTranslation();
                after.setTranslationFromFloats(joint.x, joint.y, joint.z);
                change = after.multiply(before.clone().invert());
                // The joint does not move: no translation is left but rounding
                change.setTranslationFromFloats(0, 0, 0);
            }
            changes.set(bone, { change, inverse: change.clone().invert(), scaling: decompose(change).scaling });
            bone.getChildren().forEach(child => visit(child, model));
        };
        skeleton.bones.filter(bone => !bone.getParent()).forEach(root => visit(root, BoneReset._rootSpace(root, skeletonSpace)));
        return changes;
    }

    /**
     * @param {BABYLON.Bone} bone a root bone
     * @param {BABYLON.Matrix} skeletonSpace world matrix of the mesh the skeleton deforms
     * @returns {BABYLON.Matrix} the world matrix of the space its local matrices are in: the parent
     *   node of its linked node (glTF), else the space of the skeleton (the mesh)
     */
    static _rootSpace(bone, skeletonSpace) {
        const parent = bone.getTransformNode()?.parent;
        if (parent instanceof BABYLON.TransformNode) return parent.computeWorldMatrix(true).clone();
        return bone.getTransformNode() ? BABYLON.Matrix.Identity() : skeletonSpace;
    }

    /**
     * A key of a joint track in the new axes: the position of the local matrix moves with the
     * parent change, the rotation turns with both changes, the scaling takes their ratio.
     * @param {string} property
     * @param {any} value
     * @param {{ change: BABYLON.Matrix, inverse: BABYLON.Matrix, scaling: BABYLON.Vector3 }} own
     * @param {{ change: BABYLON.Matrix, inverse: BABYLON.Matrix, scaling: BABYLON.Vector3 } | null} parent
     * @returns {any}
     */
    static _convertChannel(property, value, own, parent) {
        const parentInverse = parent?.inverse ?? BABYLON.Matrix.Identity();
        switch (property) {
            case 'position':
                return BABYLON.Vector3.TransformCoordinates(value, parentInverse);
            case 'rotationQuaternion':
            case 'rotation': {
                const quaternion = property === 'rotation' ? BABYLON.Quaternion.FromEulerVector(value) : value;
                const turned = own.change.multiply(BABYLON.Matrix.Compose(BABYLON.Vector3.One(), quaternion, BABYLON.Vector3.Zero())).multiply(parentInverse);
                const { rotation } = decompose(turned);
                return property === 'rotation' ? rotation.toEulerAngles() : rotation;
            }
            case 'scaling':
                return value.multiply(own.scaling).divide(parent?.scaling ?? BABYLON.Vector3.One());
            default:
                return value;
        }
    }
}
