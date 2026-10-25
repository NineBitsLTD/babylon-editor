import * as BABYLON from '@babylonjs/core';
import { MATERIAL_TEXTURE_SLOTS } from './BabylonFileSchema';
import { formatNumber } from './DataTable';

/**
 * @typedef {object} TreeItem
 * @property {string} id unique within the tree
 * @property {() => string} label read on every refresh, so renamed objects update in place
 * @property {string} [icon] codicon name without the `codicon-` prefix
 * @property {() => string} [description] secondary text shown after the label
 * @property {() => TreeItem[]} [children] created lazily on the first expand
 * @property {ModelItemData} data the model object the item stands for
 */

/**
 * Kinds of model objects shown in the tree; ModelProperties describes each of them.
 * @typedef {(
 *   { kind: 'section', name: string } |
 *   { kind: 'node', node: BABYLON.TransformNode } |
 *   { kind: 'material', material: BABYLON.Material } |
 *   { kind: 'texture', texture: BABYLON.BaseTexture } |
 *   { kind: 'skeleton', skeleton: BABYLON.Skeleton } |
 *   { kind: 'bone', bone: BABYLON.Bone } |
 *   { kind: 'clip', clip: import('./AnimationController').AnimationClip } |
 *   { kind: 'camera', camera: BABYLON.Camera } |
 *   { kind: 'light', light: BABYLON.Light } |
 *   { kind: 'shadowGenerator', generator: BABYLON.ShadowGenerator } |
 *   { kind: 'file' }
 * )} ModelItemData
 */

/**
 * Tree sections a file format can contain; formats not listed (.babylon, glTF) have all of them.
 * OBJ has materials and textures (from the .mtl) but no skeletons or animations; STL, PLY and
 * Gaussian splats only have geometry.
 * @type {Record<string, string[]>}
 */
const FORMAT_SECTIONS = {
    obj: ['Nodes', 'Materials', 'Textures'],
    stl: ['Nodes'],
    ply: ['Nodes'],
    splat: ['Nodes'],
    spz: ['Nodes'],
};

/**
 * @param {string} name
 * @returns {boolean} the name is the location of the image (loaders name textures by their url;
 *   in the `.babylon` format the name of an external texture is its path)
 */
function isLocation(name) {
    return /[\\/]/.test(name) || /^[a-z][a-z0-9+.-]*:/i.test(name);
}

/**
 * @param {BABYLON.BaseTexture} texture
 * @param {BABYLON.Material[]} materials
 * @returns {string} the material and the slot a texture is used in (`Building diffuse`)
 */
function textureUsage(texture, materials) {
    for (const material of materials) {
        const slot = (MATERIAL_TEXTURE_SLOTS[material.getClassName()] ?? []).find(key => material[key] === texture);
        if (slot) return `${material.name || 'material'} ${slot.replace(/Texture$/, '')}`;
    }
    return 'texture';
}

/**
 * Name shown for a texture: its own name, or, when its name is only the location of the image
 * (or empty), the material and the slot it is used in, numbered when that repeats.
 * @param {BABYLON.BaseTexture} texture
 * @param {{ textures: BABYLON.BaseTexture[], materials: BABYLON.Material[] }} model
 * @returns {string}
 */
export function textureLabel(texture, { textures, materials }) {
    if (texture.name && !isLocation(texture.name)) return texture.name;
    const label = textureUsage(texture, materials);
    const same = textures.filter(other => (!other.name || isLocation(other.name)) && textureUsage(other, materials) === label);
    return same.length > 1 ? `${label} ${same.indexOf(texture) + 1}` : label;
}

/**
 * @param {BABYLON.AbstractMesh} mesh
 * @returns {number} triangles of a mesh: its indices by three, or its vertices by three when it
 *   has no indices
 */
export function triangleCount(mesh) {
    const indices = mesh.getTotalIndices();
    return Math.floor((indices > 0 ? indices : mesh.getTotalVertices()) / 3);
}

/**
 * @param {BABYLON.Skeleton[]} skeletons
 * @returns {Set<BABYLON.TransformNode>} the nodes bones are linked to (the joints of glTF skins):
 *   their transforms are the bones, shown by the skeleton
 */
export function jointNodes(skeletons) {
    return new Set(skeletons.flatMap(skeleton => skeleton.bones.map(bone => bone.getTransformNode()).filter(Boolean)));
}

/**
 * The tip of the last bone of a chain, as exporters write it (Blender `Head_end`, FBX `Head_End` /
 * `Head Nub`): a child of a joint node that is no joint, no mesh, has no children and is not
 * animated. glTF joints are points, so it is the only place the length of a leaf bone is kept.
 * @param {BABYLON.Node} node
 * @param {Set<BABYLON.Node>} joints from `jointNodes`
 * @param {Set<any>} [animated] targets of animation groups
 * @returns {boolean}
 */
export function isJointTip(node, joints, animated = new Set()) {
    return node instanceof BABYLON.TransformNode && !(node instanceof BABYLON.AbstractMesh)
        && !!node.parent && joints.has(node.parent) && !joints.has(node)
        && node.getChildren().length === 0 && !node.animations?.length && !animated.has(node);
}

/**
 * Builds the model tree (nodes, materials, textures, skeletons, animations) shown in the Explorer
 * from a loaded asset container. Children are created lazily.
 */
export class ModelOutline {

    /**
     * @param {BABYLON.AssetContainer} container
     * @param {import('./AnimationController').AnimationController} animations
     * @param {string} [fileType] extension without the dot; sections the format cannot contain are left out
     * @returns {TreeItem[]}
     */
    static build(container, animations, fileType = '') {
        const outline = new ModelOutline(container, animations);
        const allowed = FORMAT_SECTIONS[fileType.toLowerCase()];
        const sections = [
            outline._section('Nodes', 'package', () => outline._nodeItems(outline._rootNodes())),
            outline._section('Materials', 'symbol-color', () => container.materials.map(material => outline._materialItem(material))),
            outline._section('Textures', 'file-media', () => container.textures.map(texture => outline._textureItem(texture))),
            outline._section('Skeletons', 'person', () => container.skeletons.map(skeleton => outline._skeletonItem(skeleton))),
            outline._section('Animations', 'play-circle', () => [
                // The whole timeline first, when the clips are ranges of one timeline
                ...(animations.frames ? [outline._clipItem(animations.frames)] : []),
                ...animations.clips.map(clip => outline._clipItem(clip)),
            ]),
            outline._section('Cameras', 'device-camera', () => container.cameras.map(camera => outline._cameraItem(camera))),
            outline._section('Lights', 'lightbulb', () => container.lights.map(light => outline._lightItem(light))),
        ];
        return allowed ? sections.filter(section => allowed.includes(section.label())) : sections;
    }

    /**
     * @param {BABYLON.AssetContainer} container
     * @param {import('./AnimationController').AnimationController} animations
     */
    constructor(container, animations) {
        this._container = container;
        this._animations = animations;
        /** @type {Set<BABYLON.Node>} */
        this._nodes = new Set([...container.meshes, ...container.transformNodes]);
        this._nextId = 0;
    }

    _id(prefix) {
        return `${prefix}:${this._nextId++}`;
    }

    /**
     * @param {string} name
     * @param {string} icon
     * @param {() => TreeItem[]} children
     * @returns {TreeItem}
     */
    _section(name, icon, children) {
        let count = null;
        return {
            id: this._id('section'),
            label: () => name,
            icon,
            description: () => String(count ??= children().length),
            children,
            data: { kind: 'section', name },
        };
    }

    _rootNodes() {
        return [...this._nodes].filter(node => !node.parent || !this._nodes.has(node.parent));
    }

    /**
     * @param {BABYLON.Node[]} nodes
     */
    _nodeItems(nodes) {
        return nodes.map(node => this._nodeItem(/** @type {BABYLON.TransformNode} */ (node)));
    }

    /**
     * @param {BABYLON.TransformNode} node
     * @returns {TreeItem}
     */
    _nodeItem(node) {
        const mesh = node instanceof BABYLON.Mesh && node.getTotalVertices() > 0 ? node : null;
        // The vertices, child nodes and parts of a node are listed in its inspector, not in the tree
        return {
            id: this._id('node'),
            label: () => node.name || '(unnamed)',
            icon: node instanceof BABYLON.AbstractMesh ? 'symbol-structure' : 'package',
            description: () => mesh ? `${mesh.getTotalVertices()} v` : '',
            data: { kind: 'node', node },
        };
    }

    /**
     * @param {BABYLON.Material} material
     * @returns {TreeItem}
     */
    _materialItem(material) {
        // The textures of a material are listed in its inspector
        return {
            id: this._id('material'),
            label: () => material.name || '(unnamed)',
            icon: 'symbol-color',
            description: () => material.getClassName(),
            data: { kind: 'material', material },
        };
    }

    /**
     * @param {BABYLON.BaseTexture} texture
     * @returns {TreeItem}
     */
    _textureItem(texture) {
        return {
            id: this._id('texture'),
            label: () => textureLabel(texture, this._container),
            icon: 'file-media',
            description: () => texture.getClassName(),
            data: { kind: 'texture', texture },
        };
    }

    /**
     * @param {BABYLON.Skeleton} skeleton
     * @returns {TreeItem}
     */
    _skeletonItem(skeleton) {
        // Bones are listed as a table in the skeleton inspector, not in the tree
        return {
            id: this._id('skeleton'),
            label: () => skeleton.name || '(unnamed)',
            icon: 'person',
            description: () => `${skeleton.bones.length} bones`,
            data: { kind: 'skeleton', skeleton },
        };
    }

    /**
     * @param {import('./AnimationController').AnimationClip} clip
     * @returns {TreeItem}
     */
    _clipItem(clip) {
        return {
            id: this._id('clip'),
            label: () => clip.name || '(unnamed)',
            icon: clip.isTimeline ? 'list-flat' : 'play-circle',
            description: () => `${formatNumber(clip.from, 1)}–${formatNumber(clip.to, 1)}`,
            data: { kind: 'clip', clip },
        };
    }

    /**
     * @param {BABYLON.Camera} camera
     * @returns {TreeItem}
     */
    _cameraItem(camera) {
        return {
            id: this._id('camera'),
            label: () => camera.name || '(unnamed)',
            icon: 'device-camera',
            description: () => camera.getClassName(),
            data: { kind: 'camera', camera },
        };
    }

    /**
     * A light; its shadow generator is a child item.
     * @param {BABYLON.Light} light
     * @returns {TreeItem}
     */
    _lightItem(light) {
        const generator = light.getShadowGenerator?.();
        return {
            id: this._id('light'),
            label: () => light.name || '(unnamed)',
            icon: 'lightbulb',
            description: () => light.getClassName(),
            children: generator ? () => [{
                id: this._id('shadow'),
                label: () => 'Shadow generator',
                icon: 'color-mode',
                description: () => `${generator.getShadowMap()?.getSize().width ?? '?'} px`,
                data: { kind: 'shadowGenerator', generator },
            }] : undefined,
            data: { kind: 'light', light },
        };
    }
}
