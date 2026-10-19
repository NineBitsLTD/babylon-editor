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
     * @returns {Promise<ArrayBuffer>}
     */
    static async fromBabylon({ engine, data, type, source, rootUrl }) {
        if (type === 'babylon') return data;
        const scene = new BABYLON.Scene(engine);
        try {
            const container = await BABYLON.LoadAssetContainerAsync(new File([data], 'model.babylon'), scene, { rootUrl });
            container.addAllToScene();
            await scene.whenReadyAsync();
            return await ModelSerializer.serialize({ type, scene, container, source: source ?? { mtllib: null, binaryStl: true } });
        } finally {
            scene.dispose();
        }
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
