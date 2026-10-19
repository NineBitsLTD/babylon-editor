import * as BABYLON from '@babylonjs/core';
import { MATERIAL_TEXTURE_SLOTS } from './BabylonFileSchema';

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
    material: ['materials', 'addMaterial', 'removeMaterial'],
    texture: ['textures', 'addTexture', 'removeTexture'],
    skeleton: ['skeletons', 'addSkeleton', 'removeSkeleton'],
    camera: ['cameras', 'addCamera', 'removeCamera'],
    light: ['lights', 'addLight', 'removeLight'],
    animationGroup: ['animationGroups', 'addAnimationGroup', 'removeAnimationGroup'],
};

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
    if (object instanceof BABYLON.Material) return 'material';
    if (object instanceof BABYLON.BaseTexture) return 'texture';
    if (object instanceof BABYLON.Skeleton) return 'skeleton';
    if (object instanceof BABYLON.Camera) return 'camera';
    if (object instanceof BABYLON.Light) return 'light';
    if (object instanceof BABYLON.AnimationGroup) return 'animationGroup';
    return null;
}

/**
 * Structural edits from the context menu of the model tree: rename, delete and add objects.
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
     * @returns {{ label: string, canRename: boolean, dependents: string[] }}
     */
    info(data) {
        const object = objectOf(data);
        const container = this._container();
        const dependents = [];
        if (data.kind === 'material') {
            container.meshes.filter(mesh => mesh.material === object).forEach(mesh => dependents.push(`mesh ${mesh.name} loses its material`));
        } else if (data.kind === 'skeleton') {
            container.meshes.filter(mesh => mesh.skeleton === object).forEach(mesh => dependents.push(`mesh ${mesh.name} loses its skeleton`));
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
     */
    delete(data) {
        if (this._binding()) {
            this._postOps(`Delete ${this.info(data).label}`, this._deleteOps(data));
        } else {
            this._deleteInScene(data);
        }
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

    // --- .babylon documents --------------------------------------------------------------------

    /**
     * @param {import('./ModelOutline').ModelItemData} data
     * @returns {DocumentOp[]}
     */
    _deleteOps(data) {
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
            case 'clip': {
                // A clip of a .babylon file is a named frame range of its skeletons / nodes
                for (const owner of [...container.skeletons, ...container.meshes]) {
                    if (!owner.getAnimationRange?.(object.name)) continue;
                    const ranges = owner.getAnimationRanges().filter(range => range && range.name !== object.name)
                        .map(({ name, from, to }) => ({ name, from, to }));
                    ops.push({ op: 'set', path: [...pathOf(owner), 'ranges'], value: ranges });
                }
                if (!ops.length) throw new Error('This clip is the whole timeline: delete the animation keys instead');
                return ops;
            }
            case 'material':
                container.meshes.filter(mesh => mesh.material === object && binding.pathOf(mesh))
                    .forEach(mesh => ops.push({ op: 'set', path: [...binding.pathOf(mesh), 'materialId'], value: '' }));
                break;
            case 'light': {
                const generator = object.getShadowGenerator?.();
                if (generator && binding.pathOf(generator)) ops.push({ op: 'remove', path: binding.pathOf(generator) });
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

    // --- other formats: the scene -----------------------------------------------------------------

    /**
     * @param {import('./ModelOutline').ModelItemData} data
     */
    _deleteInScene(data) {
        const object = objectOf(data);
        const container = this._container();
        const label = `Delete ${this.info(data).label}`;
        // References cleared by the deletion, restored by undo
        const references = [];
        if (data.kind === 'material') {
            container.meshes.filter(mesh => mesh.material === object).forEach(mesh => references.push([mesh, 'material', object]));
        } else if (data.kind === 'skeleton') {
            container.meshes.filter(mesh => mesh.skeleton === object).forEach(mesh => references.push([mesh, 'skeleton', object]));
        } else if (data.kind === 'texture') {
            for (const material of container.materials) {
                for (const key of Object.keys(material)) {
                    if (material[key] === object) references.push([material, key, object]);
                }
            }
        }
        const clear = () => references.forEach(([target, key]) => { target[key] = null; });
        const restore = () => references.forEach(([target, key, value]) => { target[key] = value; });
        if (data.kind === 'clip') {
            const group = object.group;
            const ranges = object.ranges.map(range => ({ range, owner: [...container.skeletons, ...container.meshes].find(owner => owner.getAnimationRange?.(range.name) === range) }));
            this._structural(label,
                () => (ranges.length ? ranges.forEach(({ range, owner }) => owner?.deleteAnimationRange(range.name, false)) : this._detach(group)),
                () => (ranges.length ? ranges.forEach(({ range, owner }) => owner?.createAnimationRange(range.name, range.from, range.to)) : this._attach(group)));
            return;
        }
        if (data.kind === 'shadowGenerator') throw new Error('Delete the light, or set the shadow properties of the light instead');
        this._structural(label, () => { clear(); this._detach(object); }, () => { this._attach(object); restore(); });
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
