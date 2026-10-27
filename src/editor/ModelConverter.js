import * as BABYLON from '@babylonjs/core';
import { formatJson } from '../utils/collapseBabylon';
import { MATERIAL_TEXTURE_SLOTS } from './BabylonFileSchema';
import { babylonJsonReplacer } from './BabylonJsonBinding';
import { textureLabel } from './ModelOutline';
import { ModelSerializer } from './ModelSerializer';

/**
 * @typedef {object} ConvertedModel
 * @property {string} text the model as a `.babylon` document
 * @property {import('./ModelSerializer').SourceInfo} source what saving back into the original format needs
 */

/** Name prefixes of objects that have no name, per collection of the asset container. */
const NAME_PREFIXES = {
    meshes: 'mesh',
    transformNodes: 'node',
    cameras: 'camera',
    lights: 'light',
    materials: 'material',
    multiMaterials: 'multiMaterial',
    skeletons: 'skeleton',
    animationGroups: 'clip',
};

/** Objects without nested objects up to this length (animation keys) are written on one line. */
const INLINE_OBJECT_LENGTH = 160;

/** Collections whose objects share one id namespace (scene.getNodeById, getMaterialById). */
const ID_NAMESPACES = [
    ['meshes', 'transformNodes', 'cameras', 'lights'],
    ['materials', 'multiMaterials'],
    ['skeletons'],
    ['animationGroups'],
];

/**
 * @param {string} url
 * @returns {boolean} the image is part of the model file (glTF buffers, data urls)
 */
function isEmbedded(url) {
    return !url || url.startsWith('data:') || url.startsWith('blob:');
}

/**
 * @param {string} url absolute url of an image
 * @param {string} rootUrl url of the model folder (ends with `/`)
 * @returns {string} the path of the image relative to the model folder (`../textures/a.png`)
 */
function relativePath(url, rootUrl) {
    if (!url.startsWith(rootUrl)) return url;
    const segments = [];
    for (const segment of decodeURIComponent(url.slice(rootUrl.length)).split('/')) {
        if (segment === '..' && segments.length && segments[segments.length - 1] !== '..') segments.pop();
        else if (segment !== '.' && segment !== '') segments.push(segment);
    }
    return segments.join('/');
}

/**
 * Converts model files to the `.babylon` format and back. The model is loaded in a separate scene
 * of the editor engine (the shown model is not touched); converting back needs the GPU too (the
 * glTF exporter reads the texture pixels), so both run in a webview.
 *
 * The conversion is clean: the document holds only the model, in the form Babylon writes it —
 * objects without a name get one (`mesh1`), ids are unique, an external texture is named by its
 * path relative to the model folder (the format reads the image from `rootUrl + name`), an embedded
 * one keeps its image as `base64String` and is named after its material and slot when it has no
 * name of its own; numbers are written as the shortest decimals of their 32-bit floats.
 */
export class ModelConverter {

    /**
     * @param {object} options
     * @param {BABYLON.AbstractEngine} options.engine
     * @param {ArrayBuffer} options.data content of the model file
     * @param {string} options.fileName name of the file (selects the loader)
     * @param {string} options.rootUrl url of the model folder
     * @param {object} [options.producer] the `producer` value of the document
     * @returns {Promise<ConvertedModel>}
     */
    static async toBabylon({ engine, data, fileName, rootUrl, producer }) {
        const type = fileName.split('.').pop().toLowerCase();
        const scene = new BABYLON.Scene(engine);
        try {
            const container = await BABYLON.LoadAssetContainerAsync(new File([data], fileName), scene, { rootUrl });
            container.addAllToScene();
            await scene.whenReadyAsync();
            if (['glb', 'gltf', 'gltf2'].includes(type)) {
                ModelConverter._joinPrimitives(scene, container);
                ModelConverter._dropSkinNodes(container);
            }
            ModelConverter._nameObjects(container);
            ModelConverter._dropGroupAnimations(container);
            ModelConverter._nameTextures(container, rootUrl);
            const text = await ModelConverter.writeBabylon({ scene, container, producer });
            return { text, source: ModelSerializer.inspectSource(type, data) };
        } finally {
            scene.dispose();
        }
    }

    /**
     * The model of a scene as a `.babylon` document, written the way conversions write it: only the
     * model, without default-material references and texture urls, typed arrays (matrices) as arrays,
     * numbers as the shortest decimals of their 32-bit floats, small objects (keys) on one line. Names and ids are taken as they are.
     * @param {object} options
     * @param {BABYLON.Scene} options.scene
     * @param {BABYLON.AssetContainer} options.container the model
     * @param {object} [options.producer] the `producer` value of the document
     * @returns {Promise<string>}
     */
    static async writeBabylon({ scene, container, producer }) {
        const json = await ModelSerializer.withModelOnly(scene, container, () => BABYLON.SceneSerializer.Serialize(scene));
        ModelConverter.clean(json);
        if (producer) json.producer = producer;
        // Matrices are Float32Arrays: written as arrays, not as objects
        const text = JSON.stringify(json, babylonJsonReplacer);
        return formatJson(text, '  ', '', INLINE_OBJECT_LENGTH);
    }

    /**
     * @param {object} options
     * @param {BABYLON.AbstractEngine} options.engine
     * @param {ArrayBuffer} options.data the `.babylon` document
     * @param {string} options.type format to write (glb, obj, stl, babylon)
     * @param {import('./ModelSerializer').SourceInfo} [options.source] facts about the original file
     * @param {string} options.rootUrl url of the model folder
     * @returns {Promise<{ data: ArrayBuffer, warnings: string[] }>} warnings: what the format loses
     */
    static async fromBabylon({ engine, data, type, source, rootUrl }) {
        if (type === 'babylon') return { data, warnings: [] };
        const scene = new BABYLON.Scene(engine);
        try {
            const container = await BABYLON.LoadAssetContainerAsync(new File([data], 'model.babylon'), scene, { rootUrl });
            container.addAllToScene();
            await scene.whenReadyAsync();
            const warnings = type === 'glb' ? ModelConverter._prepareGltf(scene, container) : [];
            const written = await ModelSerializer.serialize({ type, scene, container, source: source ?? { mtllib: null, binaryStl: true } });
            return { data: type === 'glb' ? ModelConverter._nameSkins(written, container) : written, warnings };
        } finally {
            scene.dispose();
        }
    }

    /**
     * Makes a model writable by the glTF exporter, which writes a skin only with a joint node per
     * bone and only for meshes with bone weights: a bone without a linked node gets one (where the
     * bone is drawn: below the node of its parent bone, a root bone below the parent of the mesh it
     * deforms); a mesh with a skeleton but without weights loses the skeleton (a skin without joints
     * is not valid glTF).
     * @param {BABYLON.Scene} scene
     * @param {BABYLON.AssetContainer} container
     * @returns {string[]} what the file will not have
     */
    static _prepareGltf(scene, container) {
        const warnings = [];
        const names = new Set([...container.transformNodes, ...container.meshes].map(node => node.name));
        for (const skeleton of container.skeletons) {
            const label = skeleton.name || '(unnamed)';
            const meshes = container.meshes.filter(mesh => mesh.skeleton === skeleton);
            const weighted = meshes.filter(mesh => mesh.isVerticesDataPresent(BABYLON.VertexBuffer.MatricesIndicesKind) && mesh.isVerticesDataPresent(BABYLON.VertexBuffer.MatricesWeightsKind));
            for (const mesh of meshes.filter(candidate => !weighted.includes(candidate))) {
                mesh.skeleton = null;
                warnings.push(`${mesh.name} uses the skeleton ${label} but has no bone weights: it is written without the skeleton (give it weights: Automatic weights, or bind vertices to bones in the Edit mode)`);
            }
            if (!weighted.length) {
                if (skeleton.bones.length) warnings.push(`The skeleton ${label} deforms no mesh with bone weights: glTF does not keep it`);
                continue;
            }
            ModelConverter._linkJointNodes(scene, container, skeleton, weighted[0], names);
            const animated = skeleton.bones.filter(bone => bone.animations?.some(animation => animation.getKeys().length > 1));
            const grouped = new Set(container.animationGroups.flatMap(group => group.targetedAnimations.map(({ target }) => target)));
            if (animated.some(bone => !grouped.has(bone))) {
                warnings.push(`The frame ranges of the bones of ${label} are not written: glTF keeps animations as animation groups of the joint nodes`);
            }
        }
        return warnings;
    }

    /**
     * The glTF exporter writes skins without names (the loader then names the skeletons
     * `skeleton0`, …): each skin gets the name of the skeleton its joints belong to.
     * @param {ArrayBuffer} glb
     * @param {BABYLON.AssetContainer} container
     * @returns {ArrayBuffer} the GLB with the names, or as it was
     */
    static _nameSkins(glb, container) {
        const view = new DataView(glb);
        if (glb.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67 || view.getUint32(16, true) !== 0x4e4f534a) return glb;
        const jsonLength = view.getUint32(12, true);
        const json = JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, jsonLength)));
        let named = false;
        for (const skin of json.skins ?? []) {
            if (skin.name) continue;
            const jointName = json.nodes?.[skin.joints?.[0]]?.name;
            const skeleton = container.skeletons.find(candidate => candidate.bones.some(bone => bone.getTransformNode()?.name === jointName));
            if (!skeleton?.name) continue;
            skin.name = skeleton.name;
            named = true;
        }
        if (!named) return glb;
        // The JSON chunk is padded with spaces to 4 bytes; the chunks after it stay as they are
        const text = new TextEncoder().encode(JSON.stringify(json));
        const padded = Math.ceil(text.length / 4) * 4;
        const rest = new Uint8Array(glb, 20 + jsonLength);
        const result = new Uint8Array(20 + padded + rest.length);
        const out = new DataView(result.buffer);
        result.set(new Uint8Array(glb, 0, 12));
        out.setUint32(8, result.length, true);
        out.setUint32(12, padded, true);
        out.setUint32(16, 0x4e4f534a, true);
        result.fill(0x20, 20, 20 + padded);
        result.set(text, 20);
        result.set(rest, 20 + padded);
        return result.buffer;
    }

    /**
     * Gives every bone of a skeleton without a linked node one, placed where the bone is drawn (the
     * exporter writes the joints from the world matrices of the nodes): below the node of the
     * parent bone with the local matrix of the bone; a root bone, in the space of the mesh, below the
     * parent of the mesh with the matrix of the mesh added.
     * @param {BABYLON.Scene} scene
     * @param {BABYLON.AssetContainer} container
     * @param {BABYLON.Skeleton} skeleton
     * @param {BABYLON.AbstractMesh} mesh a mesh it deforms
     * @param {Set<string>} names node names in use
     */
    static _linkJointNodes(scene, container, skeleton, mesh, names) {
        /** @type {Map<BABYLON.Bone, BABYLON.TransformNode>} */
        const nodes = new Map();
        const meshWorld = mesh.computeWorldMatrix(true).clone();
        const nodeOf = (bone) => {
            if (nodes.has(bone)) return nodes.get(bone);
            const linked = bone.getTransformNode();
            if (linked) {
                nodes.set(bone, linked);
                return linked;
            }
            const parentBone = bone.getParent();
            const parentNode = parentBone ? nodeOf(parentBone) : /** @type {BABYLON.TransformNode | null} */ (mesh.parent ?? null);
            let name = bone.name || 'joint';
            for (let suffix = 2; names.has(name); suffix++) name = `${bone.name || 'joint'}_${suffix}`;
            names.add(name);
            const node = new BABYLON.TransformNode(name, scene);
            let local = bone.getLocalMatrix().clone();
            if (!parentBone) {
                // The bones of a skeleton without nodes are in the space of the mesh
                const parentWorld = parentNode ? parentNode.computeWorldMatrix(true).clone().invert() : BABYLON.Matrix.Identity();
                local = local.multiply(meshWorld).multiply(parentWorld);
            }
            node.parent = parentNode;
            node.rotationQuaternion = new BABYLON.Quaternion();
            local.decompose(node.scaling, node.rotationQuaternion, node.position);
            container.transformNodes.push(node);
            nodes.set(bone, node);
            return node;
        };
        skeleton.bones.forEach(bone => nodeOf(bone));
        // Linked once all are placed: a linked bone takes the transform of its node
        nodes.forEach((node, bone) => {
            if (bone.getTransformNode() !== node) bone.linkTransformNode(node);
        });
    }

    /**
     * Gives every object a name and every object of a namespace a distinct id (the serializer
     * writes the references by id, so they follow).
     * @param {BABYLON.AssetContainer} container
     */
    static _nameObjects(container) {
        for (const [collection, prefix] of Object.entries(NAME_PREFIXES)) {
            const objects = container[collection] ?? [];
            const used = new Set(objects.map(object => object.name).filter(Boolean));
            let next = 1;
            for (const object of objects) {
                if (object.name) continue;
                while (used.has(`${prefix}${next}`)) next++;
                object.name = `${prefix}${next}`;
                used.add(object.name);
            }
        }
        container.skeletons.forEach(skeleton => skeleton.bones.forEach((bone, index) => {
            if (!bone.name) bone.name = `bone${index + 1}`;
        }));
        for (const collections of ID_NAMESPACES) {
            const used = new Set();
            for (const object of collections.flatMap(collection => container[collection] ?? [])) {
                let id = object.id || object.name;
                for (let suffix = 2; used.has(id); suffix++) id = `${object.id || object.name}_${suffix}`;
                object.id = id;
                used.add(id);
            }
        }
    }

    /**
     * The glTF loader makes a mesh of several primitives (a mesh with several materials) a node with
     * one mesh per primitive (`<node>_primitive<i>`), which share the vertices; written back, each of
     * them would be a mesh with all the vertices below a node of its own, one level deeper on every
     * save. They are joined back into one mesh with a sub-mesh per primitive (a multi-material for
     * several materials) in place of the node: its name, transform, parent, children, animations and
     * bone links. Primitives with morph targets, instances, children, other skeletons or transforms,
     * or different vertex data kinds stay as loaded.
     * @param {BABYLON.Scene} scene
     * @param {BABYLON.AssetContainer} container
     */
    static _joinPrimitives(scene, container) {
        for (const node of [...container.transformNodes]) {
            if (node instanceof BABYLON.AbstractMesh) continue;
            const prefix = `${node.name}_primitive`;
            const primitives = node.getChildren(undefined, true)
                .filter(child => child instanceof BABYLON.Mesh && child.name.startsWith(prefix) && /^\d+$/.test(child.name.slice(prefix.length)))
                .sort((a, b) => Number(a.name.slice(prefix.length)) - Number(b.name.slice(prefix.length)));
            if (primitives.length < 2 || !ModelConverter._canJoin(/** @type {BABYLON.Mesh[]} */ (primitives))) continue;
            ModelConverter._joinInto(scene, container, node, /** @type {BABYLON.Mesh[]} */ (primitives));
        }
    }

    /**
     * The glTF loader keeps the node of a skinned mesh twice: the mesh (placed beside the skeleton,
     * its transform ignored) and a transform node of the same name for the children of the node.
     * Without children, animations or a bone linked to it, the transform node is dropped: written
     * back it would be one more empty node on every save.
     * @param {BABYLON.AssetContainer} container
     */
    static _dropSkinNodes(container) {
        const skinned = new Set(container.meshes.filter(mesh => mesh.skeleton).map(mesh => mesh.name));
        const animated = new Set(container.animationGroups.flatMap(group => group.targetedAnimations.map(({ target }) => target)));
        const joints = new Set(container.skeletons.flatMap(skeleton => skeleton.bones.map(bone => bone.getTransformNode())));
        for (const node of [...container.transformNodes]) {
            if (node instanceof BABYLON.AbstractMesh || !skinned.has(node.name) || node.getChildren().length
                || node.animations.length || animated.has(node) || joints.has(node)) continue;
            container.transformNodes.splice(container.transformNodes.indexOf(node), 1);
            node.dispose();
        }
    }

    /**
     * @param {BABYLON.Mesh[]} primitives
     * @returns {boolean} the primitives can be one mesh: triangles of one sub-mesh each, no morph
     *   targets, instances or children, one skeleton, no transform of their own, the same vertex kinds
     */
    static _canJoin(primitives) {
        const [first] = primitives;
        const kinds = first.getVerticesDataKinds();
        return primitives.every(primitive => !primitive.morphTargetManager && !primitive.instances.length && !primitive.getChildren().length
            && primitive.subMeshes?.length === 1 && primitive.getIndices()?.length && primitive.skeleton === first.skeleton
            && primitive.position.equalsWithEpsilon(BABYLON.Vector3.Zero()) && primitive.scaling.equalsWithEpsilon(BABYLON.Vector3.One())
            && (primitive.rotationQuaternion ?? BABYLON.Quaternion.FromEulerVector(primitive.rotation)).equalsWithEpsilon(BABYLON.Quaternion.Identity())
            && primitive.getVerticesDataKinds().length === kinds.length && kinds.every(kind => primitive.isVerticesDataPresent(kind)));
    }

    /**
     * Replaces a node of primitives by one mesh of them (see _joinPrimitives). Primitives sharing all
     * their vertex data keep it once; others are appended one after the other.
     * @param {BABYLON.Scene} scene
     * @param {BABYLON.AssetContainer} container
     * @param {BABYLON.TransformNode} node
     * @param {BABYLON.Mesh[]} primitives
     */
    static _joinInto(scene, container, node, primitives) {
        const [first] = primitives;
        const kinds = first.getVerticesDataKinds();
        const same = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
        const shared = primitives.every(primitive => kinds.every(kind => same(primitive.getVerticesData(kind), first.getVerticesData(kind))));
        const mesh = new BABYLON.Mesh(node.name, scene);
        mesh.id = node.id;
        mesh.metadata = node.metadata;
        mesh.parent = node.parent;
        mesh.position.copyFrom(node.position);
        mesh.rotation.copyFrom(node.rotation);
        mesh.rotationQuaternion = node.rotationQuaternion?.clone() ?? null;
        mesh.scaling.copyFrom(node.scaling);
        mesh.setEnabled(node.isEnabled(false));
        // Vertex data, and where each primitive starts in it
        const bases = primitives.map((_, index) => (shared ? 0 : primitives.slice(0, index).reduce((sum, primitive) => sum + primitive.getTotalVertices(), 0)));
        const vertexCount = shared ? first.getTotalVertices() : primitives.reduce((sum, primitive) => sum + primitive.getTotalVertices(), 0);
        for (const kind of kinds) {
            const values = shared ? Float32Array.from(first.getVerticesData(kind)) : Float32Array.from(primitives.flatMap(primitive => Array.from(primitive.getVerticesData(kind))));
            mesh.setVerticesData(kind, values, false, first.getVertexBuffer(kind).getSize());
        }
        const indices = [];
        const ranges = primitives.map((primitive, index) => {
            const start = indices.length;
            for (const value of primitive.getIndices()) indices.push(value + bases[index]);
            return { start, count: indices.length - start, verticesStart: bases[index], verticesCount: shared ? vertexCount : primitive.getTotalVertices() };
        });
        mesh.setIndices(indices, vertexCount);
        // One material for all, else a multi-material with a slot per primitive
        const materials = primitives.map(primitive => primitive.material);
        const single = materials.every(material => material === materials[0]);
        if (single) {
            mesh.material = materials[0];
        } else {
            const multi = new BABYLON.MultiMaterial(node.name, scene);
            multi.subMaterials = materials;
            container.multiMaterials.push(multi);
            mesh.material = multi;
        }
        mesh.subMeshes = [];
        ranges.forEach(({ start, count, verticesStart, verticesCount }, index) => {
            new BABYLON.SubMesh(single ? 0 : index, verticesStart, verticesCount, start, count, mesh);
        });
        mesh.skeleton = first.skeleton;
        mesh.numBoneInfluencers = Math.max(...primitives.map(primitive => primitive.numBoneInfluencers));
        mesh.isVisible = first.isVisible;
        mesh.visibility = first.visibility;
        mesh.receiveShadows = first.receiveShadows;
        // The node is replaced: its children, animations and bone links go to the mesh
        node.getChildren(undefined, true).filter(child => !primitives.includes(/** @type {BABYLON.Mesh} */ (child))).forEach((child) => { child.parent = mesh; });
        mesh.animations = node.animations;
        container.animationGroups.forEach(group => group.targetedAnimations.forEach((targeted) => {
            if (targeted.target === node) targeted.target = mesh;
        }));
        container.skeletons.forEach(skeleton => skeleton.bones.forEach((bone) => {
            if (bone.getTransformNode() === node) bone.linkTransformNode(mesh);
        }));
        // In the place of the first primitive, so the meshes keep their order
        container.meshes.splice(container.meshes.indexOf(first), 0, mesh);
        for (const primitive of primitives) {
            container.meshes.splice(container.meshes.indexOf(primitive), 1);
            primitive.dispose(true, false);
        }
        container.transformNodes.splice(container.transformNodes.indexOf(node), 1);
        node.dispose(true);
    }

    /**
     * The glTF loader also adds the animations of an animation group to the `animations` of their
     * targets; the document keeps them once, in the group.
     * @param {BABYLON.AssetContainer} container
     */
    static _dropGroupAnimations(container) {
        for (const group of container.animationGroups) {
            for (const { target, animation } of group.targetedAnimations) {
                const index = target?.animations?.indexOf(animation) ?? -1;
                if (index >= 0) target.animations.splice(index, 1);
            }
        }
    }

    /**
     * Names textures as the format reads them: an external image by its path relative to the
     * model folder, an embedded one (kept as base64) by its own name or its material and slot.
     * @param {BABYLON.AssetContainer} container
     * @param {string} rootUrl
     */
    static _nameTextures(container, rootUrl) {
        const textures = new Set();
        for (const material of container.materials) {
            for (const slot of MATERIAL_TEXTURE_SLOTS[material.getClassName()] ?? []) {
                if (material[slot] instanceof BABYLON.Texture) textures.add(material[slot]);
            }
        }
        // Labels first: they depend on the names of the other textures
        const names = new Map([...textures].map(texture => [
            texture,
            isEmbedded(texture.url ?? '') ? textureLabel(texture, container) : relativePath(texture.url, rootUrl),
        ]));
        names.forEach((name, texture) => { texture.name = name; });
    }

    /**
     * Removes what is not part of the model from the serialized scene: references to Babylon's
     * default material and the urls of textures (the name or the embedded image locate them).
     * @param {any} json
     */
    static clean(json) {
        const materialIds = new Set([...(json.materials ?? []), ...(json.multiMaterials ?? [])].map(material => material.id));
        for (const mesh of json.meshes ?? []) {
            if (mesh.materialId !== undefined && !materialIds.has(mesh.materialId)) {
                delete mesh.materialId;
                delete mesh.materialUniqueId;
            }
        }
        for (const material of json.materials ?? []) {
            for (const value of Object.values(material)) {
                if (value && typeof value === 'object' && !Array.isArray(value) && 'name' in value && 'url' in value) delete value.url;
            }
        }
    }
}
