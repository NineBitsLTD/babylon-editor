import * as BABYLON from '@babylonjs/core';
import { GLTF2Export, OBJExport, STLExport } from '@babylonjs/serializers';

/**
 * @typedef {object} SourceInfo facts about the original file needed to write it back
 * @property {string | null} mtllib material library referenced by an OBJ file (without .mtl)
 * @property {boolean} binaryStl whether an STL file was binary
 */

const SAVABLE_TYPES = ['babylon', 'glb', 'obj', 'stl'];

/**
 * Writes the loaded model back into its original format. The file is regenerated from the
 * scene, so formatting, numeric precision and data Babylon does not load may change.
 */
export class ModelSerializer {

    /**
     * @param {string} type file extension without the dot
     * @returns {boolean}
     */
    static canSave(type) {
        return SAVABLE_TYPES.includes(type);
    }

    /**
     * Collects what serialization needs to know about the original bytes.
     * @param {string} type
     * @param {ArrayBuffer | Uint8Array} data
     * @returns {SourceInfo}
     */
    static inspectSource(type, data) {
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        const info = { mtllib: null, binaryStl: false };
        if (type === 'obj') {
            const head = new TextDecoder().decode(bytes.subarray(0, 64 * 1024));
            info.mtllib = head.match(/^\s*mtllib\s+(.+?)\.mtl\s*$/m)?.[1] ?? null;
        }
        if (type === 'stl' && bytes.byteLength >= 84) {
            const count = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true);
            info.binaryStl = bytes.byteLength === 84 + count * 50;
        }
        return info;
    }

    /**
     * @param {object} options
     * @param {string} options.type
     * @param {BABYLON.Scene} options.scene
     * @param {BABYLON.AssetContainer} options.container
     * @param {SourceInfo} options.source
     * @returns {Promise<ArrayBuffer>}
     */
    static async serialize({ type, scene, container, source }) {
        const meshes = container.meshes.filter(mesh => mesh instanceof BABYLON.Mesh && mesh.getTotalVertices() > 0);
        switch (type) {
            case 'babylon':
                return ModelSerializer.withModelOnly(scene, container, () => {
                    const json = JSON.stringify(BABYLON.SceneSerializer.Serialize(scene));
                    return new TextEncoder().encode(json).buffer;
                });
            case 'glb':
                return ModelSerializer.withModelOnly(scene, container, async () => {
                    // UVs of meshes whose material has no texture are model data too: keep them
                    const data = await GLTF2Export.GLBAsync(scene, 'model', { exportUnusedUVs: true });
                    const blob = Object.values(data.files)[0];
                    return await /** @type {Blob} */ (blob).arrayBuffer();
                });
            case 'obj': {
                const text = OBJExport.OBJ(/** @type {BABYLON.Mesh[]} */ (meshes), !!source.mtllib, source.mtllib ?? undefined, true);
                return new TextEncoder().encode(text).buffer;
            }
            case 'stl': {
                const result = STLExport.CreateSTL(/** @type {BABYLON.Mesh[]} */ (meshes), false, 'model', source.binaryStl, true, false);
                return result instanceof DataView ? result.buffer : new TextEncoder().encode(result).buffer;
            }
            default:
                throw new Error(`Saving .${type} files is not supported`);
        }
    }

    /**
     * Temporarily detaches from the scene everything that is not part of the loaded model
     * (editor camera and light, the editor timeline group, Babylon's default material,
     * highlight helpers), so whole-scene serializers write only the model.
     * @template T
     * @param {BABYLON.Scene} scene
     * @param {BABYLON.AssetContainer} container
     * @param {() => T | Promise<T>} action
     * @returns {Promise<T>}
     */
    static async withModelOnly(scene, container, action) {
        const lists = [
            { all: scene.cameras, own: container.cameras, remove: x => scene.removeCamera(x), add: x => scene.addCamera(x) },
            { all: scene.lights, own: container.lights, remove: x => scene.removeLight(x), add: x => scene.addLight(x) },
            { all: scene.meshes, own: container.meshes, remove: x => scene.removeMesh(x), add: x => scene.addMesh(x) },
            { all: scene.transformNodes, own: container.transformNodes, remove: x => scene.removeTransformNode(x), add: x => scene.addTransformNode(x) },
            { all: scene.materials, own: container.materials, remove: x => scene.removeMaterial(x), add: x => scene.addMaterial(x) },
            { all: scene.animationGroups, own: container.animationGroups, remove: x => scene.removeAnimationGroup(x), add: x => scene.addAnimationGroup(x) },
        ];
        const activeCamera = scene.activeCamera;
        const detached = lists.map(list => {
            const own = new Set(list.own);
            const foreign = list.all.filter(item => !own.has(item));
            foreign.forEach(list.remove);
            return foreign;
        });
        try {
            return await action();
        } finally {
            lists.forEach((list, index) => detached[index].forEach(list.add));
            scene.activeCamera = activeCamera;
        }
    }
}
