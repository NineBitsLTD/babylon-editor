import * as BABYLON from '@babylonjs/core';

/**
 * What scaling a skeleton changes, captured for undo.
 * @typedef {object} SkeletonScaleState
 * @property {BABYLON.Matrix[]} bind stored bind matrices of the bones
 * @property {BABYLON.Matrix[]} rest
 * @property {BABYLON.Matrix[]} local current local matrices of the bones
 * @property {BABYLON.Vector3[]} nodes positions of the nodes linked to the bones (glTF joints)
 * @property {{ animation: BABYLON.Animation, keys: BABYLON.IAnimationKey[] }[]} keys
 * @property {{ mesh: BABYLON.Mesh, positions: Float32Array }[]} vertices
 */

/**
 * @param {BABYLON.Matrix} matrix
 * @param {number} factor
 * @returns {BABYLON.Matrix} a copy with the translation multiplied by the factor
 */
function scaleTranslation(matrix, factor) {
    const scaled = matrix.clone();
    const translation = matrix.getTranslation().scaleInPlace(factor);
    scaled.setTranslationFromFloats(translation.x, translation.y, translation.z);
    return scaled;
}

/**
 * @param {any} value
 * @returns {any}
 */
function cloneValue(value) {
    return value?.clone ? value.clone() : value;
}

/**
 * Scales a skeleton and the meshes it deforms uniformly, baked into the data (no scaling is left
 * in the hierarchy): the translations of the bind, rest and current local matrices of the bones,
 * the positions of their linked nodes (glTF joints), the translations of the bone animations and
 * the joint position animations (also of animation groups), and the vertex positions of the meshes
 * the skeleton deforms. Rotations, proportions and the transform of the meshes stay; morph targets
 * are not scaled.
 *
 * Scaling every bone-local translation by k conjugates the bone matrices by a uniform scaling, so
 * skinned vertices scaled by k land on the scaled pose.
 */
export class SkeletonScale {

    /**
     * @param {BABYLON.Skeleton} skeleton
     * @param {BABYLON.AssetContainer} container
     * @returns {{ meshes: BABYLON.Mesh[], nodes: BABYLON.TransformNode[], matrices: BABYLON.Animation[], positions: BABYLON.Animation[] }}
     */
    static targets(skeleton, container) {
        // Meshes sharing a geometry are scaled once
        const geometries = new Set();
        const meshes = container.meshes.filter((mesh) => {
            if (!(mesh instanceof BABYLON.Mesh) || mesh.skeleton !== skeleton || !mesh.isVerticesDataPresent(BABYLON.VertexBuffer.PositionKind)) return false;
            if (mesh.geometry && geometries.has(mesh.geometry)) return false;
            if (mesh.geometry) geometries.add(mesh.geometry);
            return true;
        });
        const nodes = skeleton.bones.map(bone => bone.getTransformNode()).filter(Boolean);
        const bones = new Set(skeleton.bones);
        const joints = new Set(nodes);
        const matrices = new Set(skeleton.bones.flatMap(bone => bone.animations).filter(animation => animation.targetProperty === '_matrix'));
        const positions = new Set(nodes.flatMap(node => node.animations).filter(animation => animation.targetProperty === 'position'));
        for (const group of container.animationGroups) {
            for (const { animation, target } of group.targetedAnimations) {
                if (bones.has(target) && animation.targetProperty === '_matrix') matrices.add(animation);
                if (joints.has(target) && animation.targetProperty === 'position') positions.add(animation);
            }
        }
        return { meshes, nodes, matrices: [...matrices], positions: [...positions] };
    }

    /**
     * @param {BABYLON.Skeleton} skeleton
     * @param {BABYLON.AssetContainer} container
     * @param {import('./AnimationController').AnimationController} animations
     * @returns {SkeletonScaleState}
     */
    static capture(skeleton, container, animations) {
        const { meshes, nodes, matrices, positions } = SkeletonScale.targets(skeleton, container);
        return {
            bind: animations.captureBind(skeleton),
            rest: skeleton.bones.map(bone => bone.getRestMatrix().clone()),
            local: skeleton.bones.map(bone => bone.getLocalMatrix().clone()),
            nodes: nodes.map(node => node.position.clone()),
            keys: [...matrices, ...positions].map(animation => ({ animation, keys: SkeletonScale._mapKeys(animation.getKeys(), cloneValue) })),
            vertices: meshes.map(mesh => ({ mesh, positions: Float32Array.from(mesh.getVerticesData(BABYLON.VertexBuffer.PositionKind)) })),
        };
    }

    /**
     * @param {BABYLON.Skeleton} skeleton
     * @param {BABYLON.AssetContainer} container
     * @param {import('./AnimationController').AnimationController} animations
     * @param {number} factor uniform scale, > 0
     * @param {import('./BabylonJsonBinding').BabylonJsonBinding | null} [binding] of a `.babylon` text: the
     *   positions of joints an animation drives are written explicitly (the binding does not compare them)
     */
    static apply(skeleton, container, animations, factor, binding = null) {
        const { meshes, nodes, matrices, positions } = SkeletonScale.targets(skeleton, container);
        animations.setBindPoses(skeleton, skeleton.bones.map(bone => scaleTranslation(animations.poseMatrix(bone, 'bind'), factor)));
        for (const bone of skeleton.bones) {
            bone.setRestMatrix(scaleTranslation(bone.getRestMatrix(), factor));
            // A linked bone takes its pose from its node
            if (!bone.getTransformNode()) bone._matrix = scaleTranslation(bone.getLocalMatrix(), factor);
        }
        nodes.forEach(node => node.position.scaleInPlace(factor));
        // The position in the file of a linked node is that of the rest pose of its bone
        if (binding) {
            skeleton.bones.filter(bone => bone.getTransformNode()).forEach((bone) => {
                binding.queuePatch(bone.getTransformNode(), 'position', bone.getRestMatrix().getTranslation().asArray());
            });
        }
        matrices.forEach(animation => animation.setKeys(SkeletonScale._mapKeys(animation.getKeys(), value => scaleTranslation(value, factor)), true));
        positions.forEach(animation => animation.setKeys(SkeletonScale._mapKeys(animation.getKeys(), value => value.scale(factor)), true));
        for (const mesh of meshes) {
            const data = Float32Array.from(mesh.getVerticesData(BABYLON.VertexBuffer.PositionKind), value => value * factor);
            mesh.setVerticesData(BABYLON.VertexBuffer.PositionKind, data, true, 3);
            mesh.refreshBoundingInfo();
        }
        skeleton.bones.forEach(bone => bone.markAsDirty());
    }

    /**
     * @param {BABYLON.Skeleton} skeleton
     * @param {import('./AnimationController').AnimationController} animations
     * @param {SkeletonScaleState} state from capture
     */
    static restore(skeleton, animations, state) {
        animations.restoreBind(skeleton, state.bind);
        skeleton.bones.forEach((bone, index) => {
            bone.setRestMatrix(state.rest[index].clone());
            if (!bone.getTransformNode()) bone._matrix = state.local[index].clone();
        });
        const nodes = skeleton.bones.map(bone => bone.getTransformNode()).filter(Boolean);
        nodes.forEach((node, index) => { if (state.nodes[index]) node.position.copyFrom(state.nodes[index]); });
        state.keys.forEach(({ animation, keys }) => animation.setKeys(SkeletonScale._mapKeys(keys, cloneValue), true));
        for (const { mesh, positions } of state.vertices) {
            mesh.setVerticesData(BABYLON.VertexBuffer.PositionKind, Float32Array.from(positions), true, 3);
            mesh.refreshBoundingInfo();
        }
        skeleton.bones.forEach(bone => bone.markAsDirty());
    }

    /**
     * Maps the values of keys; keys that share a value keep sharing one (Babylon's key at frame 0
     * shares the value of the next key, which is how it is told from the keys of the model).
     * @param {BABYLON.IAnimationKey[]} keys
     * @param {(value: any) => any} map
     * @returns {BABYLON.IAnimationKey[]}
     */
    static _mapKeys(keys, map) {
        const mapped = new Map();
        return keys.map((key) => {
            if (!mapped.has(key.value)) mapped.set(key.value, map(key.value));
            return { ...key, value: mapped.get(key.value) };
        });
    }
}
