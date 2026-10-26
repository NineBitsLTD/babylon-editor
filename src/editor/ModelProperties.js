import * as BABYLON from '@babylonjs/core';
import { BABYLON_FILE_SCHEMA, MATERIAL_TEXTURE_SLOTS, schemaProperties } from './BabylonFileSchema';
import { BoneReset } from './BoneReset';
import { ClipFrameEditor } from './ClipFrameEditor';
import { formatNumber } from './DataTable';
import { isJointTip, jointNodes, textureLabel, triangleCount } from './ModelOutline';
import { SkeletonScale } from './SkeletonScale';
import { SkinEdits } from './SkinEdits';
import { textureFileSize, texturePreview } from './TextureImage';

/**
 * @typedef {object} PropertiesContext
 * @property {string} fileType extension of the edited file, without the dot
 * @property {BABYLON.AssetContainer} container
 * @property {import('./AnimationController').AnimationController} animations
 * @property {import('./SelectionHighlighter').SelectionHighlighter} highlighter
 * @property {import('./EditHistory').EditHistory} history
 * @property {(index: number) => void} selectClip makes a clip current without changing play/pause
 * @property {(clip: number | import('./AnimationController').AnimationClip) => void} playClip makes a clip
 *   (by index, or the clip itself, e.g. the whole timeline) current and plays it from the start
 * @property {() => void} pauseAnimation pauses the current clip
 * @property {(skeleton: BABYLON.Skeleton, pose: 'rest' | 'bind') => void} showPose stops playback and auto-orbit, shows the pose
 * @property {(skeleton: BABYLON.Skeleton, pose: 'rest' | 'bind') => boolean} isPose nothing plays or orbits and the bones are in the pose
 * @property {(clip: import('./AnimationController').AnimationClip, frame: number) => void} showFrame pauses on a frame of a clip
 * @property {() => number} selectedRow selected row of the inspector table, or -1
 * @property {string} fileName
 * @property {() => void} reshow shows the inspector of the shown object again (its rows changed)
 * @property {import('./FileInfo').FileField[] | null} fileFields read-only fields of the file (header / asset info of a binary file, the sizes of a text document)
 * @property {import('./BabylonJsonBinding').DocumentField[] | null} documentFields editable top-level values of a .babylon text
 * @property {import('./BabylonJsonBinding').BabylonJsonBinding | null} binding the document binding of a .babylon text (null for other formats)
 * @property {(mesh: BABYLON.AbstractMesh) => boolean} isHiddenInView whether a mesh is hidden in the 3D view only
 * @property {(mesh: BABYLON.AbstractMesh, hidden: boolean) => void} setHiddenInView hides a mesh in the 3D view
 * @property {((data: ModelItemData, inFile: boolean) => void) | null} setCameraInFile adds a virtual
 *   camera to the file, or removes a camera from the file keeping it as a virtual one (null when the
 *   format cannot be edited)
 * @property {() => boolean} showJointNodes whether node lists show the joint nodes of skeletons
 * @property {(show: boolean) => void} setShowJointNodes
 *   without changing the model (the file keeps it as it is)
 * @property {string | null} convertedFrom name of the model file a converted `.babylon` document is edited for
 * @property {(data: ModelItemData) => void} openObject shows an object listed in the inspector (a child node, a part, a
 *   texture of a material) in its own inspector; back returns to the current one
 * @property {(op: 'rename' | 'delete', data: ModelItemData) => void} objectCommand runs a command of the tree context menu
 *   on a listed object (the host asks for the name / the confirmation)
 * @property {import('./TextureImage').TextureImage} textureImage commands of the image of a texture
 * @property {(title: string, prompt: string, value: number) => Promise<number | null>} promptNumber asks the
 *   user for a number greater than 0 (null when cancelled)
 * @property {(title: string, prompt: string, value: string) => Promise<string | null>} promptText asks the
 *   user for a text (null when cancelled)
 * @property {((meshes: BABYLON.Mesh[], name: string) => void) | null} weldVertices welds the vertices at one position
 *   of meshes (a mesh, or the meshes below a node, named by it)
 * @property {((meshes: BABYLON.Mesh[], name: string) => void) | null} removeHidden removes the triangles the outside
 *   air never reaches (and the vertices left unused) of meshes
 * @property {((meshes: BABYLON.Mesh[], name: string) => void) | null} mergeMeshes merges meshes into the first one
 *   of a mesh into one with smooth normals (null when the format cannot be edited)
 * @property {((mesh: BABYLON.Mesh, vertices: number[]) => void) | null} deleteVertices deletes vertices of a
 *   mesh and the triangles that use them (null when the format cannot be edited)
 * @property {((mesh: BABYLON.Mesh, vertices: number[]) => void) | null} mergeVertices merges vertices of a
 *   mesh into one at their centre
 * @property {((bones: BABYLON.Bone[]) => void) | null} deleteBones deletes bones with their weights and
 *   node (null when the model has no `.babylon` text)
 */

/** @typedef {import('./PropertyPanel').PropertyDescriptor} PropertyDescriptor */
/** @typedef {import('./PropertyPanel').PanelContent} PanelContent */
/** @typedef {import('./ModelOutline').ModelItemData} ModelItemData */

const RAD_TO_DEG = 180 / Math.PI;
const DEG_TO_RAD = Math.PI / 180;

/**
 * @param {BABYLON.AbstractMesh} mesh
 * @returns {number} how many bones the skin of the mesh needs (the highest bone index its vertices
 *   refer to with a weight, plus one); 0 without skin
 */
function requiredBones(mesh) {
    const K = BABYLON.VertexBuffer;
    let highest = -1;
    for (const [indicesKind, weightsKind] of [[K.MatricesIndicesKind, K.MatricesWeightsKind], [K.MatricesIndicesExtraKind, K.MatricesWeightsExtraKind]]) {
        const indices = mesh.getVerticesData?.(indicesKind);
        const weights = mesh.getVerticesData?.(weightsKind);
        if (!indices || !weights) continue;
        for (let index = 0; index < indices.length; index++) {
            if (weights[index] > 0 && indices[index] > highest) highest = indices[index];
        }
    }
    return highest + 1;
}

/**
 * The button next to a reference (a select of an object) that opens the chosen object in its own
 * inspector; disabled while nothing is chosen.
 * @param {string} kind object kind for the tooltip
 * @param {() => any} chosen the referenced object, or null
 * @param {(object: any) => void} open
 * @returns {import('./PropertyPanel').PanelAction}
 */
function openObjectAction(kind, chosen, open) {
    return {
        label: 'Open',
        title: `Open the ${kind} in its own inspector`,
        icon: 'go-to-file',
        transient: true,
        isDisabled: () => !chosen(),
        run: () => open(chosen()),
    };
}

// --- Generic property builders -------------------------------------------------------------

/**
 * @param {object} target
 * @param {string} key
 * @param {string} [label]
 * @returns {PropertyDescriptor}
 */
function textProperty(target, key, label = 'Name') {
    return { label, type: 'text', get: () => target[key], set: (value) => { target[key] = value; } };
}

/**
 * @param {object} target
 * @param {string} key
 * @param {string} label
 * @param {boolean} [nullable]
 * @returns {PropertyDescriptor}
 */
function numberProperty(target, key, label, nullable = false) {
    return { label, type: 'number', nullable, get: () => target[key], set: (value) => { target[key] = value; } };
}

/**
 * @param {object} target
 * @param {string} key
 * @param {string} label
 * @returns {PropertyDescriptor}
 */
function booleanProperty(target, key, label) {
    return { label, type: 'boolean', get: () => target[key], set: (value) => { target[key] = value; } };
}

/**
 * Color3 property edited as a hex string; skipped when the color is not set.
 * @param {object} target
 * @param {string} key
 * @param {string} label
 * @returns {PropertyDescriptor[]}
 */
function colorProperty(target, key, label) {
    if (!(target[key] instanceof BABYLON.Color3)) return [];
    return [{
        label,
        type: 'color',
        get: () => target[key].toHexString(),
        set: (value) => { target[key] = BABYLON.Color3.FromHexString(value); },
    }];
}

/**
 * @param {string} label
 * @param {() => BABYLON.Vector3} vector returns the live vector
 * @returns {PropertyDescriptor}
 */
function vectorProperty(label, vector) {
    return {
        label,
        type: 'vector',
        get: () => vector().asArray(),
        set: (value) => vector().fromArray(value),
    };
}

/**
 * @param {string} label
 * @param {() => any} get
 * @returns {PropertyDescriptor}
 */
function readonlyProperty(label, get) {
    return { label, type: 'readonly', get };
}

/**
 * Inspector property of a top-level value of a `.babylon` document (producer, clearColor, …).
 * Fields of the format the file does not have show Babylon's default and are added when set.
 * @param {import('./BabylonJsonBinding').DocumentField} field
 * @param {string} [label] defaults to the path
 * @returns {PropertyDescriptor}
 */
function documentProperty(field, label = field.path.join('.')) {
    const { schema } = field;
    if (!field.set) return readonlyProperty(label, () => String(field.get()));
    const current = () => field.get() ?? schema?.default ?? null;
    const value = current();
    const type = schema?.type ?? (Array.isArray(value) ? 'vector3' : typeof value);
    const base = { label, isUnset: () => field.get() === undefined };
    const set = value => field.set(value);
    switch (type) {
        case 'boolean':
            return { ...base, type: 'boolean', get: () => !!current(), set };
        case 'number':
            return { ...base, type: 'number', get: current, set };
        case 'string':
            return { ...base, type: 'text', get: () => current() ?? '', set };
        case 'enum':
            return {
                ...base,
                type: 'select',
                options: () => schema.options.map(option => ({ value: String(option.value), label: option.label })),
                get: () => String(current()),
                set: next => set(schema.options.find(option => String(option.value) === next)?.value ?? next),
            };
        case 'color3':
            return {
                ...base,
                type: 'color',
                get: () => BABYLON.Color3.FromArray(current()).toHexString(),
                // An alpha the file has (clearColor may be RGBA) is kept
                set: hex => set([...BABYLON.Color3.FromHexString(hex).asArray(), ...(current().length > 3 ? [current()[3]] : [])]),
            };
        case 'vector3': {
            if (!Array.isArray(value)) return readonlyProperty(label, () => String(field.get()));
            const color = /color/i.test(label);
            const components = (color ? ['R', 'G', 'B', 'A'] : ['X', 'Y', 'Z', 'W']).slice(0, value.length);
            return { ...base, type: 'vector', components, get: current, set };
        }
        default:
            return readonlyProperty(label, () => String(field.get()));
    }
}

/**
 * Euler rotation in degrees for a node that may use either `rotation` or `rotationQuaternion`.
 * Undo restores the exact original quaternion instead of a round-tripped Euler value.
 * @param {BABYLON.TransformNode} node
 * @returns {PropertyDescriptor}
 */
function nodeRotationProperty(node) {
    return {
        label: 'Rotation°',
        type: 'vector',
        get: () => (node.rotationQuaternion ? node.rotationQuaternion.toEulerAngles() : node.rotation).asArray().map(value => value * RAD_TO_DEG),
        set: (value) => {
            const [x, y, z] = value.map(degrees => degrees * DEG_TO_RAD);
            if (node.rotationQuaternion) {
                node.rotationQuaternion = BABYLON.Quaternion.FromEulerAngles(x, y, z);
            } else {
                node.rotation.set(x, y, z);
            }
        },
        capture: () => ({ euler: node.rotation.clone(), quaternion: node.rotationQuaternion?.clone() ?? null }),
        restore: (state) => {
            node.rotation.copyFrom(state.euler);
            node.rotationQuaternion = state.quaternion?.clone() ?? null;
        },
    };
}

// --- Bone rest pose ------------------------------------------------------------------------

/**
 * @param {BABYLON.Bone} bone
 * @returns {{ scaling: BABYLON.Vector3, rotation: BABYLON.Quaternion, position: BABYLON.Vector3 }}
 */
function decomposeRest(bone) {
    const scaling = new BABYLON.Vector3();
    const rotation = new BABYLON.Quaternion();
    const position = new BABYLON.Vector3();
    bone.getRestMatrix().decompose(scaling, rotation, position);
    return { scaling, rotation, position };
}

/**
 * @param {BABYLON.Bone} bone
 * @param {BABYLON.Matrix} matrix
 * @param {import('./AnimationController').AnimationController} animations
 */
function restoreRest(bone, matrix, animations) {
    bone.setRestMatrix(matrix.clone());
    // The rest pose is shown at once while no animation is playing
    if (!animations.isPlaying) bone.returnToRest();
}

/**
 * The rest pose of a skeleton: the rest matrices of its bones and the transforms of their linked
 * nodes (glTF joints), for undo.
 * @param {BABYLON.Skeleton} skeleton
 * @returns {{ rest: BABYLON.Matrix[], nodes: ({ position: BABYLON.Vector3, rotation: BABYLON.Vector3, rotationQuaternion: BABYLON.Quaternion | null, scaling: BABYLON.Vector3 } | null)[] }}
 */
function captureRestPose(skeleton) {
    return {
        rest: skeleton.bones.map(bone => bone.getRestMatrix().clone()),
        nodes: skeleton.bones.map((bone) => {
            const node = bone.getTransformNode();
            return node ? { position: node.position.clone(), rotation: node.rotation.clone(), rotationQuaternion: node.rotationQuaternion?.clone() ?? null, scaling: node.scaling.clone() } : null;
        }),
    };
}

/**
 * @param {BABYLON.Skeleton} skeleton
 * @param {ReturnType<typeof captureRestPose>} state
 */
function restoreRestPose(skeleton, state) {
    skeleton.bones.forEach((bone, index) => {
        bone.setRestMatrix(state.rest[index].clone());
        const node = bone.getTransformNode();
        const saved = state.nodes[index];
        if (node && saved) {
            node.position.copyFrom(saved.position);
            node.rotation.copyFrom(saved.rotation);
            node.rotationQuaternion = saved.rotationQuaternion?.clone() ?? null;
            node.scaling.copyFrom(saved.scaling);
        }
        bone.markAsDirty();
    });
}

/**
 * Makes the bind pose of every bone (where its joint sits relative to the mesh) its rest pose and
 * shows it. The animations are not changed (they set the poses of the bones themselves). A linked
 * node (glTF joint) takes the transform too: in the file it is the rest pose of its bone; values the
 * binding does not compare (nodes an animation drives) are written explicitly.
 * @param {BABYLON.Skeleton} skeleton
 * @param {import('./AnimationController').AnimationController} animations
 * @param {import('./BabylonJsonBinding').BabylonJsonBinding | null} binding
 */
function restFromBind(skeleton, animations, binding) {
    for (const bone of skeleton.bones) bone.setRestMatrix(animations.poseMatrix(bone, 'bind').clone());
    animations.showPose(skeleton, 'rest');
    for (const bone of skeleton.bones) {
        const node = bone.getTransformNode();
        if (!node || !binding) continue;
        binding.queuePatch(node, 'position', node.position.asArray());
        binding.queuePatch(node, 'rotationQuaternion', (node.rotationQuaternion ?? BABYLON.Quaternion.FromEulerVector(node.rotation)).asArray());
        binding.queuePatch(node, 'scaling', node.scaling.asArray());
    }
}

/**
 * @param {BABYLON.Bone} bone
 * @param {{ scaling: BABYLON.Vector3, rotation: BABYLON.Quaternion, position: BABYLON.Vector3 }} parts
 * @param {import('./AnimationController').AnimationController} animations
 */
function composeRest(bone, { scaling, rotation, position }, animations) {
    restoreRest(bone, BABYLON.Matrix.Compose(scaling, rotation, position), animations);
}

/**
 * A local matrix as 9 table values: position, rotation in degrees, scaling.
 * @param {BABYLON.Matrix} matrix
 * @returns {number[]}
 */
function matrixValues(matrix) {
    const scaling = new BABYLON.Vector3(), rotation = new BABYLON.Quaternion(), position = new BABYLON.Vector3();
    matrix.decompose(scaling, rotation, position);
    return [...position.asArray(), ...rotation.toEulerAngles().asArray().map(value => value * RAD_TO_DEG), ...scaling.asArray()];
}

/**
 * Inverse of matrixValues.
 * @param {number[]} values position, rotation in degrees, scaling
 * @returns {BABYLON.Matrix}
 */
function composeValues(values) {
    return BABYLON.Matrix.Compose(
        BABYLON.Vector3.FromArray(values, 6),
        BABYLON.Quaternion.FromEulerAngles(...values.slice(3, 6).map(degrees => degrees * DEG_TO_RAD)),
        BABYLON.Vector3.FromArray(values, 0),
    );
}

/**
 * Rest pose of a bone as 9 table values.
 * @param {BABYLON.Bone} bone
 * @returns {number[]}
 */
function readRest(bone) {
    return matrixValues(bone.getRestMatrix());
}

/**
 * @param {BABYLON.Bone} bone
 * @param {number} component 0..8 (position, rotation°, scaling)
 * @param {number} value
 * @param {import('./AnimationController').AnimationController} animations
 */
function writeRest(bone, component, value, animations) {
    const values = readRest(bone);
    values[component] = value;
    composeRest(bone, {
        position: BABYLON.Vector3.FromArray(values, 0),
        rotation: BABYLON.Quaternion.FromEulerAngles(...values.slice(3, 6).map(degrees => degrees * DEG_TO_RAD)),
        scaling: BABYLON.Vector3.FromArray(values, 6),
    }, animations);
}

/**
 * Rest pose components of a bone (position, Euler rotation in degrees, scaling) built over its
 * rest matrix. Editing the bind matrix would break skinning, so only the rest pose is editable;
 * the change is visible while no animation drives the bone.
 * @param {BABYLON.Bone} bone
 * @param {import('./AnimationController').AnimationController} animations
 * @returns {PropertyDescriptor[]}
 */
function boneRestProperties(bone, animations) {
    const decompose = () => decomposeRest(bone);
    const compose = parts => composeRest(bone, parts, animations);
    const capture = () => bone.getRestMatrix().clone();
    const restore = matrix => restoreRest(bone, matrix, animations);
    const component = (label, read, write) => ({
        label, type: 'vector', capture, restore,
        get: () => read(decompose()),
        set: (value) => { const parts = decompose(); write(parts, value); compose(parts); },
    });
    return [
        component('Rest position', parts => parts.position.asArray(), (parts, value) => parts.position.fromArray(value)),
        component('Rest rotation°', parts => parts.rotation.toEulerAngles().asArray().map(value => value * RAD_TO_DEG),
            (parts, value) => { parts.rotation = BABYLON.Quaternion.FromEulerAngles(...value.map(degrees => degrees * DEG_TO_RAD)); }),
        component('Rest scaling', parts => parts.scaling.asArray(), (parts, value) => parts.scaling.fromArray(value)),
    ];
}

// --- Object descriptions -------------------------------------------------------------------

/**
 * Describes model objects for the inspector (properties, tables, actions) and highlights them
 * in the 3D view. All mutations go through the descriptors, so the editor can record them.
 */
export class ModelProperties {

    /**
     * @param {ModelItemData} data
     * @param {PropertiesContext} context
     * @returns {PanelContent}
     */
    static describe(data, context) {
        const content = ModelProperties._describe(data, context);
        const fields = ModelProperties._formatFields(data, context);
        // The preview camera and the virtual ones are not in the file: their fields change the view only
        if (data.kind === 'camera' && (data.preview || data.virtual)) fields.forEach((field) => { field.transient = true; });
        if (fields.length) content.properties = [...(content.properties ?? []), { label: 'Other file fields', type: 'section' }, ...fields];
        return content;
    }

    /**
     * Fields of the `.babylon` format for an object besides its main properties (also those the
     * file does not have yet: they are shown dimmed and are added to the text when set).
     * @param {ModelItemData} data
     * @param {PropertiesContext} context
     * @returns {PropertyDescriptor[]}
     */
    static _formatFields(data, { binding }) {
        const schema = BABYLON_FILE_SCHEMA;
        /** @type {[object, import('./BabylonFileSchema').SchemaField[]] | null} */
        const target = (() => {
            switch (data.kind) {
                case 'node': return data.node instanceof BABYLON.AbstractMesh ? [data.node, schema.mesh] : null;
                case 'material':
                    if (data.material instanceof BABYLON.PBRMaterial) return [data.material, schema.pbrMaterial];
                    return data.material instanceof BABYLON.StandardMaterial ? [data.material, schema.standardMaterial] : null;
                case 'texture': return [data.texture, schema.texture];
                case 'camera': return [data.camera, schema.camera];
                case 'light': return [data.light, schema.light];
                case 'shadowGenerator': return [data.generator, schema.shadowGenerator];
                case 'skeleton': return [data.skeleton, schema.skeleton];
                default: return null;
            }
        })();
        if (!target) return [];
        const [object, fields] = target;
        const path = binding?.pathOf(object);
        const isUnset = path ? field => !binding.isInDocument([...path, field.key]) : undefined;
        return schemaProperties(object, fields, isUnset);
    }

    /**
     * @param {ModelItemData} data
     * @param {PropertiesContext} context
     * @returns {PanelContent}
     */
    static _describe(data, context) {
        switch (data.kind) {
            case 'node': return ModelProperties._node(data.node, context);
            case 'material': return ModelProperties._material(data.material, context);
            case 'texture': return { title: 'Texture', subtitle: () => textureLabel(data.texture, context.container), properties: ModelProperties._textureProperties(data.texture, context) };
            case 'skeleton': return ModelProperties._skeleton(data.skeleton, context);
            case 'bone': return ModelProperties._bone(data.bone, context);
            case 'clip': return ModelProperties._clip(data.clip, context);
            case 'file': return ModelProperties._file(context);
            case 'camera': return ModelProperties._camera(data, context);
            case 'light': return ModelProperties._light(data.light);
            case 'shadowGenerator': return ModelProperties._shadowGenerator(data.generator);
            default: return { title: data.name, notice: 'Expand the section to browse its items.' };
        }
    }

    /**
     * Shows the selected object in the 3D view.
     * @param {ModelItemData} data
     * @param {PropertiesContext} context
     */
    static highlight(data, context) {
        const { highlighter, container } = context;
        switch (data.kind) {
            case 'node':
                return highlighter.outlineMeshes(data.node instanceof BABYLON.AbstractMesh
                    ? [data.node, ...data.node.getChildMeshes()]
                    : data.node.getChildMeshes());
            case 'material':
                return highlighter.outlineMeshes(container.meshes.filter(mesh => mesh.material === data.material));
            case 'skeleton':
                return highlighter.showSkeleton(data.skeleton);
            case 'bone':
                return highlighter.showSkeleton(data.bone.getSkeleton(), data.bone);
            case 'clip': {
                context.showFrame(data.clip, ClipFrameEditor.shownFrame(data.clip));
                const skeleton = ClipFrameEditor.skeletonOf(data.clip, container);
                return skeleton ? highlighter.showSkeleton(skeleton) : highlighter.clear();
            }
            default:
                return highlighter.clear();
        }
    }

    /**
     * @param {BABYLON.TransformNode} node
     * @param {PropertiesContext} context
     * @returns {PanelContent}
     */
    static _node(node, context) {
        const { fileType } = context;
        const isMesh = node instanceof BABYLON.AbstractMesh;
        /** @type {PanelContent} */
        const content = {
            title: isMesh ? 'Mesh' : 'Node',
            subtitle: () => node.name,
            notice: ModelProperties._formatNotice(node, fileType),
            properties: ModelProperties._nodeProperties(node, context),
            lists: ModelProperties._nodeLists(node, context),
        };
        content.actions = [];
        // The vertex table of a mesh is part of its inspector
        if (node instanceof BABYLON.Mesh && node.getTotalVertices() > 0) {
            const vertices = ModelProperties._vertices(node, context);
            content.table = { ...vertices.table, title: 'Vertices', notice: vertices.notice };
            content.actions.push({
                label: 'Weld vertices',
                title: 'Merge the vertices at one position into one (texture seams keep theirs) and give them smooth normals; one undo step',
                icon: 'merge',
                isDisabled: () => !context.weldVertices,
                run: () => context.weldVertices?.([node], node.name),
            }, {
                label: 'Remove hidden geometry',
                title: 'Remove the triangles inside the mesh that the outside air never reaches (walls inside the solid, shells inside shells, closed voids; a hole of any shape counts as outside) and the vertices no triangle uses; one undo step',
                icon: 'eye-closed',
                isDisabled: () => !context.removeHidden,
                run: () => context.removeHidden?.([node], node.name),
            });
        }
        // The meshes of the hierarchy: welded together as one undo step
        const meshes = ModelProperties._meshesOf(node, context.container);
        // One mesh below the node: its own actions, named by it
        if (meshes.length === 1 && meshes[0] !== node) {
            content.actions.push({
                label: `Weld vertices of ${meshes[0].name}`,
                title: 'Merge the vertices at one position into one (texture seams keep theirs) and give them smooth normals; one undo step',
                icon: 'merge',
                isDisabled: () => !context.weldVertices,
                run: () => context.weldVertices?.(meshes, meshes[0].name),
            }, {
                label: `Remove hidden geometry of ${meshes[0].name}`,
                title: 'Remove the triangles inside the mesh that the outside air never reaches and the vertices no triangle uses; one undo step',
                icon: 'eye-closed',
                isDisabled: () => !context.removeHidden,
                run: () => context.removeHidden?.(meshes, meshes[0].name),
            });
        }
        if (meshes.length > 1) {
            content.actions.push({
                label: `Weld vertices of ${meshes.length} meshes`,
                title: `Weld the vertices of ${meshes.map(mesh => mesh.name).join(', ')} (this node and the meshes below it): the vertices at one position of each mesh become one (texture seams keep theirs), with smooth normals; one undo step`,
                icon: 'merge',
                isDisabled: () => !context.weldVertices,
                run: () => context.weldVertices?.(meshes, node.name),
            }, {
                label: `Remove hidden geometry of ${meshes.length} meshes`,
                title: 'Remove the triangles of each mesh that the outside air never reaches inside it, and the vertices no triangle uses; one undo step',
                icon: 'eye-closed',
                isDisabled: () => !context.removeHidden,
                run: () => context.removeHidden?.(meshes, node.name),
            }, {
                label: `Merge ${meshes.length} meshes into one`,
                title: `Merge ${meshes.map(mesh => mesh.name).join(', ')} into ${meshes[0].name} (one sub-mesh per material, a multi-material when there are several); one undo step${context.mergeMeshes ? '' : ' — .babylon documents only'}`,
                icon: 'combine',
                isDisabled: () => !context.mergeMeshes,
                run: () => context.mergeMeshes?.(meshes, node.name),
            });
        }
        return content;
    }

    /**
     * @param {BABYLON.Node} node
     * @param {BABYLON.AssetContainer} container
     * @returns {BABYLON.Mesh[]} the node (when a mesh) and the meshes below it that have vertices
     */
    static _meshesOf(node, container) {
        const own = new Set(container.meshes);
        return [node, ...node.getDescendants(false, child => own.has(child))]
            .filter(candidate => candidate instanceof BABYLON.Mesh && candidate.getTotalVertices() > 0);
    }

    /**
     * The nodes below a node (the tree shows root nodes only): transform nodes and meshes (parts)
     * of the whole hierarchy, each as an accordion entry with its main properties and the commands
     * of the tree context menu.
     * @param {BABYLON.TransformNode} node
     * @param {PropertiesContext} context
     * @returns {import('./PropertyPanel').PanelList[]}
     */
    static _nodeLists(node, context) {
        const { container } = context;
        const own = new Set([...container.meshes, ...container.transformNodes]);
        const descendants = node.getDescendants(false, child => own.has(child));
        // Joint nodes and the tips of leaf bones repeat the skeleton
        const joints = jointNodes(container.skeletons);
        const animated = new Set(container.animationGroups.flatMap(group => group.targetedAnimations.map(({ target }) => target)));
        const ofSkeleton = new Set(descendants.filter(child => joints.has(child) || isJointTip(child, joints, animated)));
        const jointCount = ofSkeleton.size;
        const entry = (child, description) => ({
            label: () => child.name || '(unnamed)',
            description,
            icon: child instanceof BABYLON.AbstractMesh ? 'symbol-structure' : 'package',
            properties: () => ModelProperties._nodeProperties(child, context),
            actions: ModelProperties._listedObjectActions({ kind: 'node', node: child }, context, true),
            onOpen: () => ModelProperties.highlight({ kind: 'node', node: child }, context),
            onClose: () => ModelProperties.highlight({ kind: 'node', node }, context),
        });
        return [
            {
                title: 'Nodes',
                items: descendants
                    .filter(child => !(child instanceof BABYLON.AbstractMesh))
                    .map(child => ({
                        ...entry(child, () => (child.parent && child.parent !== node ? `in ${child.parent.name}` : '')),
                        // Hidden unless asked for
                        ...(ofSkeleton.has(child) ? { isHidden: () => !context.showJointNodes() } : {}),
                    })),
                ...(jointCount ? {
                    toggle: {
                        label: 'Bone nodes',
                        title: () => (context.showJointNodes() ? `Hide the ${jointCount} nodes of the skeleton (joints and bone tips)` : `Show the ${jointCount} nodes of the skeleton (joints and bone tips)`),
                        icon: () => (context.showJointNodes() ? 'eye' : 'eye-closed'),
                        transient: true,
                        run: () => context.setShowJointNodes(!context.showJointNodes()),
                    },
                } : {}),
            },
            {
                title: 'Parts',
                items: descendants
                    .filter(child => child instanceof BABYLON.AbstractMesh)
                    .map(child => ({
                        ...entry(child, () => `${child.getTotalVertices()} v`),
                        toggle: {
                            label: 'Hide',
                            title: () => (context.isHiddenInView(child) ? 'Show the part in the 3D view' : 'Hide the part in the 3D view (the file is not changed)'),
                            icon: () => (context.isHiddenInView(child) ? 'eye-closed' : 'eye'),
                            isActive: () => context.isHiddenInView(child),
                            transient: true,
                            run: () => context.setHiddenInView(child, !context.isHiddenInView(child)),
                        },
                    })),
            },
        ];
    }

    /**
     * Commands of an object listed in the inspector: the item commands of the tree it is not in.
     * @param {ModelItemData} data
     * @param {PropertiesContext} context
     * @param {boolean} canRename
     * @returns {import('./PropertyPanel').PanelAction[]}
     */
    static _listedObjectActions(data, { openObject, objectCommand }, canRename) {
        return [
            { label: 'Open', title: 'Open in its own inspector', icon: 'go-to-file', transient: true, run: () => openObject(data) },
            ...(canRename ? [{ label: 'Rename…', title: `Rename the ${data.kind}`, icon: 'edit', run: () => objectCommand('rename', data) }] : []),
            { label: 'Delete', title: `Delete the ${data.kind}`, icon: 'trash', run: () => objectCommand('delete', data) },
        ];
    }

    /**
     * The texture slots of a material as selects of the model's textures (the textures themselves
     * are the Textures section of the tree).
     * @param {BABYLON.Material} material
     * @param {PropertiesContext} context
     * @returns {PropertyDescriptor[]}
     */
    static _textureSlotProperties(material, { container, openObject }) {
        const slots = new Set(MATERIAL_TEXTURE_SLOTS[material.getClassName()] ?? []);
        // Slots of other material classes that hold a texture are shown too
        for (const key of Object.keys(material.serialize())) {
            if (material[key] instanceof BABYLON.BaseTexture) slots.add(key);
        }
        if (!slots.size) return [];
        const options = () => [
            { value: '', label: '(none)' },
            ...container.textures.map(texture => ({ value: String(texture.uniqueId), label: textureLabel(texture, container) })),
        ];
        return [
            { label: 'Textures', type: 'section' },
            ...[...slots].map(slot => ({
                label: slot,
                type: 'select',
                options,
                get: () => String(material[slot]?.uniqueId ?? ''),
                set: (value) => { material[slot] = container.textures.find(texture => String(texture.uniqueId) === value) ?? null; },
                action: openObjectAction('texture', () => material[slot], texture => openObject({ kind: 'texture', texture })),
            })),
        ];
    }

    /**
     * Main properties of a node (its inspector and its entry in the lists of the parent).
     * @param {BABYLON.TransformNode} node
     * @param {PropertiesContext} context
     * @returns {PropertyDescriptor[]}
     */
    static _nodeProperties(node, context) {
        const { container, openObject } = context;
        const isMesh = node instanceof BABYLON.AbstractMesh;
        /** @type {PropertyDescriptor[]} */
        const properties = [
            textProperty(node, 'name'),
            readonlyProperty('Type', () => node.getClassName()),
            readonlyProperty('Parent', () => node.parent?.name ?? '—'),
            { label: 'Enabled', type: 'boolean', get: () => node.isEnabled(false), set: (value) => node.setEnabled(value) },
        ];
        if (isMesh) {
            properties.push(booleanProperty(node, 'isVisible', 'Visible'));
        }
        properties.push(
            vectorProperty('Position', () => node.position),
            nodeRotationProperty(node),
            vectorProperty('Scaling', () => node.scaling),
        );
        if (isMesh) {
            properties.push(
                {
                    label: 'Material',
                    type: 'select',
                    // Multi-materials too (one material per sub-mesh)
                    options: () => [
                        { value: '', label: '(none)' },
                        ...container.materials.map(material => ({ value: String(material.uniqueId), label: material.name || '(unnamed)' })),
                        ...(container.multiMaterials ?? []).map(material => ({ value: String(material.uniqueId), label: `${material.name || '(unnamed)'} (multi)` })),
                    ],
                    get: () => String(node.material?.uniqueId ?? ''),
                    set: (value) => {
                        node.material = [...container.materials, ...(container.multiMaterials ?? [])].find(material => String(material.uniqueId) === value) ?? null;
                    },
                    action: openObjectAction('material', () => node.material, material => openObject({ kind: 'material', material })),
                },
                readonlyProperty('Vertices', () => node.getTotalVertices()),
                readonlyProperty('Triangles', () => triangleCount(node)),
                readonlyProperty('Indices', () => node.getTotalIndices()),
                ...ModelProperties._skinProperties(node, context),
            );
        }
        return properties;
    }

    /**
     * The skeleton that deforms a mesh (one per mesh; several meshes may share one) and the number
     * of bones that move each vertex. A skeleton with fewer bones than the vertices refer to cannot
     * be chosen.
     * @param {BABYLON.AbstractMesh} mesh
     * @param {PropertiesContext} context
     * @returns {PropertyDescriptor[]}
     */
    static _skinProperties(mesh, { container, openObject }) {
        const needed = requiredBones(mesh);
        /** @type {PropertyDescriptor[]} */
        const properties = [{
            label: 'Skeleton',
            type: 'select',
            options: () => [
                { value: '', label: '(none)' },
                ...container.skeletons.map(skeleton => ({
                    value: String(skeleton.uniqueId),
                    label: `${skeleton.name || '(unnamed)'} · ${skeleton.bones.length} bones${needed > skeleton.bones.length ? ` (needs ${needed})` : ''}`,
                    disabled: needed > skeleton.bones.length,
                })),
            ],
            get: () => String(mesh.skeleton?.uniqueId ?? ''),
            set: (value) => { mesh.skeleton = container.skeletons.find(skeleton => String(skeleton.uniqueId) === value) ?? null; },
            action: openObjectAction('skeleton', () => mesh.skeleton, skeleton => openObject({ kind: 'skeleton', skeleton })),
        }];
        if (mesh.skeleton || needed) properties.push(readonlyProperty('Bone influencers', () => mesh.numBoneInfluencers));
        return properties;
    }

    /**
     * Explains how the file format limits what is saved for a node.
     * @param {BABYLON.TransformNode} node
     * @param {string} fileType
     * @returns {string | undefined}
     */
    static _formatNotice(node, fileType) {
        if (fileType === 'obj' || fileType === 'stl') {
            const names = fileType === 'stl' ? ' STL does not store mesh names.' : '';
            return `${fileType.toUpperCase()} has no node transforms: position, rotation and scaling are baked into the vertices on save.${names}`;
        }
        if (fileType === 'glb' && node instanceof BABYLON.AbstractMesh && node.skeleton) {
            return 'glTF ignores the transform of skinned meshes: position, rotation and scaling of this mesh are not saved.';
        }
        return undefined;
    }

    /**
     * The Skin group of the vertex table: one cell per bone influence with the bone name and the
     * weight (`matricesIndices` / `matricesWeights`, and their `Extra` buffers for more than four
     * influences); an influence without weight shows a dash. A cell is edited as `<bone> <weight>`
     * (either part may be left out); the other influences of the vertex are scaled so the weights
     * add up to 1.
     * @param {BABYLON.Mesh} mesh
     * @param {import('./DataTable').TableColumn[]} columns receives the columns
     * @param {{ key: string, label: string }[]} groups receives the group
     * @param {import('./BabylonJsonBinding').BabylonJsonBinding | null} [binding]
     */
    static _skinColumns(mesh, columns, groups, binding = null) {
        const K = BABYLON.VertexBuffer;
        const sets = [[K.MatricesIndicesKind, K.MatricesWeightsKind], [K.MatricesIndicesExtraKind, K.MatricesWeightsExtraKind]]
            .filter(([indices, weights]) => mesh.isVerticesDataPresent(indices) && mesh.isVerticesDataPresent(weights));
        if (!sets.length) return;
        groups.push({ key: 'skin', label: 'Skin' });
        const bones = () => mesh.skeleton?.bones ?? [];
        const boneName = index => bones().find(bone => bone.getIndex() === index)?.name ?? `#${index}`;
        // `<bone> <weight>`: a missing part keeps the current one
        const parseInfluence = (text, influence, row) => {
            const [indicesKind, weightsKind] = sets[Math.floor(influence / 4)];
            const place = row * 4 + (influence % 4);
            const match = /^(.*?)\s*(-?\d*[.,]?\d+)?\s*$/.exec(text.trim());
            const name = match?.[1]?.trim();
            // An unknown name keeps the bone of the influence
            const bone = name ? bones().find(candidate => candidate.name === name) : null;
            return {
                bone: bone ? bone.getIndex() : mesh.getVerticesData(indicesKind)[place],
                weight: match?.[2] !== undefined ? Number(match[2].replace(',', '.')) : mesh.getVerticesData(weightsKind)[place],
            };
        };
        sets.forEach(([indicesKind, weightsKind], set) => {
            for (let slot = 0; slot < 4; slot++) {
                columns.push({
                    label: `I${set * 4 + slot + 1}`,
                    group: 'skin',
                    text: true,
                    get: (row) => {
                        const weight = mesh.getVerticesData(weightsKind)?.[row * 4 + slot] ?? 0;
                        if (!weight) return '—';
                        const index = mesh.getVerticesData(indicesKind)?.[row * 4 + slot] ?? 0;
                        return `${boneName(index)} ${formatNumber(weight, 3)}`;
                    },
                    isEditable: () => !!mesh.skeleton,
                    set: (row, text) => {
                        const { bone, weight } = parseInfluence(String(text), set * 4 + slot, row);
                        SkinEdits.setInfluence(mesh, row, set * 4 + slot, bone, weight, binding);
                    },
                    // The whole influences of the vertex (setting one scales the others)
                    capture: row => sets.map(([indices, weights]) => ({
                        indices: Array.from(mesh.getVerticesData(indices).slice(row * 4, row * 4 + 4)),
                        weights: Array.from(mesh.getVerticesData(weights).slice(row * 4, row * 4 + 4)),
                    })),
                    restore: (row, state) => SkinEdits.setVertexInfluences(mesh, row, state, binding),
                });
            }
        });
    }

    /**
     * Vertex table: position, normal and UV per vertex. Edits replace the vertex buffer of the
     * mesh geometry (shared by all meshes using that geometry).
     * @param {BABYLON.Mesh} mesh
     * @param {PropertiesContext} context
     * @returns {PanelContent}
     */
    static _vertices(mesh, { highlighter, binding, deleteVertices, mergeVertices }) {
        const K = BABYLON.VertexBuffer;
        /** @type {import('./DataTable').TableColumn[]} */
        const columns = [{ label: '#', leading: true, width: 56, get: row => row }];
        /** @type {{ key: string, label: string }[]} */
        const groups = [];
        const addColumns = (kind, groupLabel, labels) => {
            if (!mesh.isVerticesDataPresent(kind)) return;
            groups.push({ key: kind, label: groupLabel });
            const stride = labels.length;
            labels.forEach((label, component) => columns.push({
                label,
                group: kind,
                get: row => mesh.getVerticesData(kind)?.[row * stride + component] ?? '',
                set: (row, value) => {
                    const data = Float32Array.from(mesh.getVerticesData(kind));
                    data[row * stride + component] = value;
                    mesh.setVerticesData(kind, data, true, stride);
                    if (kind === K.PositionKind) {
                        mesh.refreshBoundingInfo();
                        highlighter.showVertex(mesh, row);
                    }
                },
            }));
        };
        addColumns(K.PositionKind, 'Position', ['X', 'Y', 'Z']);
        addColumns(K.NormalKind, 'Normal', ['NX', 'NY', 'NZ']);
        addColumns(K.UVKind, 'UV', ['U', 'V']);
        ModelProperties._skinColumns(mesh, columns, groups, binding);

        const sharedWith = (mesh.geometry?.meshes.length ?? 1) - 1;
        return {
            title: 'Vertices',
            subtitle: () => mesh.name,
            notice: `Double-click a cell to edit (a Skin cell as "<bone> <weight>": the other weights of the vertex are scaled to add up to 1).${sharedWith > 0 ? ` The geometry is shared with ${sharedWith} other mesh(es).` : ''}`,
            table: {
                columns,
                groups,
                rowCount: () => mesh.getTotalVertices(),
                onSelectRow: row => highlighter.showVertex(mesh, row),
                // Shift+click selects several vertices: all are marked
                onSelectRows: rows => highlighter.showVertices(mesh, rows),
                // A vertex picked in the 3D view ({ vertex })
                rowOf: object => (Number.isInteger(object?.vertex) ? object.vertex : -1),
                rowMenu: (row, rows) => [{
                    label: rows.length > 1 ? `Delete ${rows.length} vertices` : 'Delete vertex',
                    title: 'Delete the selected vertices and the triangles that use them (one undo step)',
                    icon: 'trash',
                    isDisabled: () => !deleteVertices || rows.length >= mesh.getTotalVertices(),
                    run: () => deleteVertices?.(mesh, rows),
                }, {
                    label: `Merge ${rows.length} vertices`,
                    title: 'Merge the selected vertices into one at their centre (triangles that become degenerate are dropped; one undo step)',
                    icon: 'merge',
                    isHidden: () => rows.length < 2,
                    isDisabled: () => !mergeVertices,
                    run: () => mergeVertices?.(mesh, rows),
                }],
            },
        };
    }

    /**
     * @param {BABYLON.Material} material
     * @returns {PanelContent}
     */
    static _material(material, context) {
        if (material instanceof BABYLON.MultiMaterial) return ModelProperties._multiMaterial(material, context);
        /** @type {PropertyDescriptor[]} */
        const properties = [
            textProperty(material, 'name'),
            readonlyProperty('Type', () => material.getClassName()),
            numberProperty(material, 'alpha', 'Alpha'),
            booleanProperty(material, 'backFaceCulling', 'Back-face culling'),
            booleanProperty(material, 'wireframe', 'Wireframe'),
        ];
        if (material instanceof BABYLON.StandardMaterial) {
            properties.push(
                ...colorProperty(material, 'diffuseColor', 'Diffuse'),
                ...colorProperty(material, 'specularColor', 'Specular'),
                ...colorProperty(material, 'emissiveColor', 'Emissive'),
                ...colorProperty(material, 'ambientColor', 'Ambient'),
                numberProperty(material, 'specularPower', 'Specular power'),
            );
        } else if (material instanceof BABYLON.PBRMaterial) {
            properties.push(
                ...colorProperty(material, 'albedoColor', 'Albedo'),
                ...colorProperty(material, 'emissiveColor', 'Emissive'),
                ...colorProperty(material, 'reflectivityColor', 'Reflectivity'),
                numberProperty(material, 'metallic', 'Metallic', true),
                numberProperty(material, 'roughness', 'Roughness', true),
            );
        }
        properties.push(...ModelProperties._textureSlotProperties(material, context));
        return { title: 'Material', subtitle: () => material.name, properties };
    }

    /**
     * A multi-material: its materials in the order of the sub-meshes that use them (a sub-mesh
     * takes the material at its material index), each with a button that opens it.
     * @param {BABYLON.MultiMaterial} material
     * @param {PropertiesContext} context
     * @returns {PanelContent}
     */
    static _multiMaterial(material, { openObject, container, history, binding, reshow }) {
        const meshes = () => container.meshes.filter(mesh => mesh.material === material);
        const label = index => `Material ${index}`;
        /** @param {BABYLON.Material[]} slots the material of each sub-mesh index */
        const writeSlots = (slots) => { material.subMaterials = slots.slice(); };
        // A removed slot: its sub-meshes take the default material (an index out of the list), the later ones move up
        const capture = () => ({ slots: material.subMaterials.slice(), indices: meshes().map(mesh => [mesh, mesh.subMeshes.map(subMesh => subMesh.materialIndex)]) });
        const restore = (state) => {
            writeSlots(state.slots);
            state.indices.forEach(([mesh, indices]) => mesh.subMeshes.forEach((subMesh, index) => { subMesh.materialIndex = indices[index]; }));
            state.indices.forEach(([mesh]) => queueSubMeshes(mesh));
            reshow();
        };
        const queueSubMeshes = mesh => binding?.queuePatch(mesh, 'subMeshes', mesh.subMeshes.map(({ materialIndex, verticesStart, verticesCount, indexStart, indexCount }) => ({ materialIndex, verticesStart, verticesCount, indexStart, indexCount })));
        const remove = index => history.executeMutation(`Remove ${label(index)} of ${material.name}`, capture, () => {
            writeSlots(material.subMaterials.filter((_, slot) => slot !== index));
            for (const mesh of meshes()) {
                mesh.subMeshes.forEach((subMesh) => {
                    if (subMesh.materialIndex === index) subMesh.materialIndex = -1;
                    else if (subMesh.materialIndex > index) subMesh.materialIndex--;
                });
                queueSubMeshes(mesh);
            }
            reshow();
        }, restore);
        const used = index => meshes().reduce((count, mesh) => count + mesh.subMeshes.filter(subMesh => subMesh.materialIndex === index).length, 0);
        /** @type {PropertyDescriptor[]} */
        const properties = [
            textProperty(material, 'name'),
            readonlyProperty('Type', () => material.getClassName()),
            ...material.subMaterials.map((_, index) => ({
                label: label(index),
                type: /** @type {const} */ ('select'),
                options: () => [
                    { value: '', label: '(none)' },
                    ...container.materials.map(candidate => ({ value: String(candidate.uniqueId), label: candidate.name || '(unnamed)' })),
                ],
                get: () => String(material.subMaterials[index]?.uniqueId ?? ''),
                set: (value) => {
                    const slots = material.subMaterials.slice();
                    slots[index] = container.materials.find(candidate => String(candidate.uniqueId) === value) ?? null;
                    writeSlots(slots);
                },
                action: openObjectAction('material', () => material.subMaterials[index], chosen => openObject({ kind: 'material', material: chosen })),
            })),
        ];
        return {
            title: 'Multi-material',
            subtitle: () => material.name,
            notice: 'One material per sub-mesh index. A removed material: its sub-meshes take the default material, the sub-meshes of the later ones keep theirs.',
            properties,
            actions: [{
                label: 'Add material',
                title: 'Add a material at the end of the list (the last one again; choose another in its select); no sub-mesh uses it until one gets its index',
                icon: 'add',
                isDisabled: () => !container.materials.length,
                run: () => history.executeMutation(`Add a material to ${material.name}`, capture, () => {
                    writeSlots([...material.subMaterials, material.subMaterials[material.subMaterials.length - 1] ?? container.materials[0]]);
                    reshow();
                }, restore),
            }, ...material.subMaterials.map((_, index) => ({
                label: `Remove ${index}`,
                title: () => `Remove ${label(index)} (${material.subMaterials[index]?.name ?? 'none'})${used(index) ? `: ${used(index)} sub-mesh(es) take the default material` : ''}; the later materials move up with their sub-meshes`,
                icon: 'trash',
                run: () => remove(index),
            }))],
        };
    }

    /**
     * Properties of a texture (its inspector and its entry in the list of a material). A click on
     * the preview opens the commands of the image (save, replace, copy, paste).
     * @param {BABYLON.BaseTexture} texture
     * @param {PropertiesContext} context
     * @returns {PropertyDescriptor[]}
     */
    static _textureProperties(texture, { textureImage, container }) {
        /** @type {PropertyDescriptor[]} */
        const properties = [
            textProperty(texture, 'name'),
            readonlyProperty('Type', () => texture.getClassName()),
            readonlyProperty('Size', () => { const size = texture.getSize(); return `${size.width} × ${size.height}`; }),
            readonlyProperty('File size', () => textureFileSize(texture)),
            numberProperty(texture, 'level', 'Level'),
            booleanProperty(texture, 'hasAlpha', 'Has alpha'),
        ];
        if (texture instanceof BABYLON.Texture) {
            properties.splice(2, 0, readonlyProperty('URL', () => texture.url ?? '—'), {
                label: 'Preview',
                type: 'image',
                get: () => texturePreview(texture),
                overlay: () => textureImage.uvOverlay(texture),
                menu: textureImage.actions(texture, () => textureLabel(texture, container)),
            });
            properties.push(
                numberProperty(texture, 'uScale', 'U scale'),
                numberProperty(texture, 'vScale', 'V scale'),
                numberProperty(texture, 'uOffset', 'U offset'),
                numberProperty(texture, 'vOffset', 'V offset'),
            );
        }
        return properties;
    }

    /**
     * A camera of the file, the preview camera or a virtual camera of the views: the properties of
     * the last two are transient (they change the view, not the file, and are not undone). Add to
     * scene (file) puts a virtual camera into the file or takes a camera of the file out of it.
     * @param {ModelItemData & { kind: 'camera' }} data
     * @param {PropertiesContext} context
     * @returns {PanelContent}
     */
    static _camera(data, { setCameraInFile }) {
        const { camera, preview = false, virtual = false } = data;
        const properties = [
            textProperty(camera, 'name'),
            readonlyProperty('Type', () => camera.getClassName()),
            vectorProperty('Position', () => camera.position),
        ];
        if (camera instanceof BABYLON.TargetCamera) {
            properties.push({
                label: 'Target',
                type: 'vector',
                get: () => camera.getTarget().asArray(),
                set: value => camera.setTarget(BABYLON.Vector3.FromArray(value)),
            });
        }
        if (camera instanceof BABYLON.ArcRotateCamera) {
            properties.push(numberProperty(camera, 'alpha', 'Alpha'), numberProperty(camera, 'beta', 'Beta'), numberProperty(camera, 'radius', 'Radius'));
        }
        if (camera.mode === BABYLON.Camera.PERSPECTIVE_CAMERA) properties.push(numberProperty(camera, 'fov', 'Field of view (rad)'));
        properties.push(numberProperty(camera, 'minZ', 'Near plane'), numberProperty(camera, 'maxZ', 'Far plane'));
        if (preview || virtual) properties.forEach((property) => { property.transient = true; });
        if (!preview && setCameraInFile) {
            properties.splice(1, 0, {
                label: 'Add to scene (file)',
                type: 'boolean',
                // Its own undoable change of the file, not a property edit
                transient: true,
                get: () => !virtual,
                set: value => setCameraInFile(data, !!value),
            });
        }
        return {
            title: preview ? 'Preview camera' : virtual ? 'Virtual camera' : 'Camera',
            subtitle: () => camera.name,
            notice: preview
                ? 'The camera the editor shows the model with. Changes affect the view only: they are not saved to the file and are not undone.'
                : virtual
                    ? 'A camera of the views, kept in memory only: changes affect the view. Add to scene (file) puts it into the file.'
                    : 'A camera stored in the file. A view shows it through a copy: moving it with the mouse does not change the file (Reset view takes the file values again); edit it here.',
            twoColumns: true,
            properties,
        };
    }

    /**
     * @param {BABYLON.Light} light
     * @returns {PanelContent}
     */
    static _light(light) {
        const properties = [
            textProperty(light, 'name'),
            readonlyProperty('Type', () => light.getClassName()),
            { label: 'Enabled', type: 'boolean', get: () => light.isEnabled(false), set: value => light.setEnabled(value) },
            numberProperty(light, 'intensity', 'Intensity'),
            ...colorProperty(light, 'diffuse', 'Diffuse'),
            ...colorProperty(light, 'specular', 'Specular'),
        ];
        if (light instanceof BABYLON.HemisphericLight) properties.push(...colorProperty(light, 'groundColor', 'Ground color'));
        if (light.position instanceof BABYLON.Vector3) properties.push(vectorProperty('Position', () => light.position));
        if (light.direction instanceof BABYLON.Vector3) properties.push(vectorProperty('Direction', () => light.direction));
        if (light instanceof BABYLON.PointLight || light instanceof BABYLON.SpotLight) properties.push(numberProperty(light, 'range', 'Range'));
        if (light instanceof BABYLON.SpotLight) properties.push(numberProperty(light, 'angle', 'Angle (rad)'), numberProperty(light, 'exponent', 'Exponent'));
        return { title: 'Light', subtitle: () => light.name, twoColumns: true, properties };
    }

    /**
     * @param {BABYLON.ShadowGenerator} generator
     * @returns {PanelContent}
     */
    static _shadowGenerator(generator) {
        const filters = {
            [BABYLON.ShadowGenerator.FILTER_NONE]: 'None',
            [BABYLON.ShadowGenerator.FILTER_EXPONENTIALSHADOWMAP]: 'Exponential',
            [BABYLON.ShadowGenerator.FILTER_POISSONSAMPLING]: 'Poisson sampling',
            [BABYLON.ShadowGenerator.FILTER_BLUREXPONENTIALSHADOWMAP]: 'Blurred exponential',
            [BABYLON.ShadowGenerator.FILTER_CLOSEEXPONENTIALSHADOWMAP]: 'Close exponential',
            [BABYLON.ShadowGenerator.FILTER_BLURCLOSEEXPONENTIALSHADOWMAP]: 'Blurred close exponential',
            [BABYLON.ShadowGenerator.FILTER_PCF]: 'PCF',
            [BABYLON.ShadowGenerator.FILTER_PCSS]: 'PCSS',
        };
        return {
            title: 'Shadow generator',
            subtitle: () => generator.getLight().name,
            twoColumns: true,
            properties: [
                readonlyProperty('Light', () => generator.getLight().name),
                readonlyProperty('Map size', () => generator.getShadowMap()?.getSize().width ?? '—'),
                readonlyProperty('Filter', () => filters[generator.filter] ?? generator.filter),
                readonlyProperty('Shadow casters', () => generator.getShadowMap()?.renderList?.length ?? 0),
                numberProperty(generator, 'bias', 'Bias'),
                numberProperty(generator, 'normalBias', 'Normal bias'),
                { label: 'Darkness', type: 'number', get: () => generator.getDarkness(), set: value => generator.setDarkness(value) },
            ],
        };
    }

    /**
     * The file itself, shown before an item of the tree is selected: the top-level values of a
     * `.babylon` document (editable) or the header / asset info of other formats.
     * @param {PropertiesContext} context
     * @returns {PanelContent}
     */
    static _file({ fileName, fileFields, documentFields, convertedFrom }) {
        const converted = convertedFrom
            ? `${convertedFrom} is edited as a .babylon document: saving converts it back (Save Model As… writes other formats). `
            : '';
        return {
            title: 'File',
            subtitle: () => fileName,
            notice: converted + (documentFields
                ? 'Values of the file that are not in the model tree. Select an item in the Babylon Model tree to edit the model.'
                : 'Select an item in the Babylon Model tree to inspect or edit the model.'),
            properties: [
                ...(fileFields ?? []).map(field => readonlyProperty(field.label, () => field.value)),
                ...(documentFields ? ModelProperties._documentGroups(documentFields) : []),
            ],
        };
    }

    /**
     * Top-level values first (the Properties group), then one group per object value (e.g.
     * producer: name, version, …) labeled without the group name.
     * @param {import('./BabylonJsonBinding').DocumentField[]} fields
     * @returns {PropertyDescriptor[]}
     */
    static _documentGroups(fields) {
        /** @type {PropertyDescriptor[]} */
        const properties = fields.filter(field => field.path.length === 1).map(field => documentProperty(field));
        /** @type {Map<string | number, import('./BabylonJsonBinding').DocumentField[]>} */
        const groups = new Map();
        for (const field of fields.filter(candidate => candidate.path.length > 1)) {
            const [group] = field.path;
            if (!groups.has(group)) groups.set(group, []);
            groups.get(group).push(field);
        }
        for (const [group, members] of groups) {
            const title = String(group);
            properties.push({ label: title[0].toUpperCase() + title.slice(1), type: 'section' });
            properties.push(...members.map(field => documentProperty(field, field.path.slice(1).join('.'))));
        }
        return properties;
    }

    /**
     * Skeleton properties and a table of the bones in the rest pose (editable) or in the bind
     * pose (read-only: changing it would change how the mesh is skinned), with a button that
     * shows the chosen pose.
     * @param {BABYLON.Skeleton} skeleton
     * @param {PropertiesContext} context
     * @returns {PanelContent}
     */
    static _skeleton(skeleton, { animations, highlighter, showPose, isPose, history, container, binding, promptNumber, promptText, deleteBones }) {
        const bones = skeleton.bones;
        const groups = ['position', 'rotation', 'scaling'];
        /** @type {'rest' | 'bind'} set by the Rest | Bind switch of the panel */
        let pose = 'rest';
        // Editing a bind matrix: whether the child joints move with the edited bone
        let moveChildren = true;
        const bindValues = bone => matrixValues(animations.poseMatrix(bone, 'bind'));
        const writeBind = (bone, component, value) => {
            const values = bindValues(bone);
            values[component] = value;
            animations.setBindMatrix(bone, composeValues(values), moveChildren);
            showPose(skeleton, 'bind');
        };
        const poseName = () => pose === 'rest' ? 'Rest pose' : 'Bind pose';
        /** @param {BABYLON.Bone[]} reset */
        const resetBones = reset => history.executeMutation(
            reset.length === bones.length ? `Reset the bones of ${skeleton.name || 'the skeleton'}` : reset.length === 1 ? `Reset bone ${reset[0].name}` : `Reset ${reset.length} bones`,
            () => BoneReset.capture(skeleton, container, animations),
            () => BoneReset.apply(skeleton, reset, container, animations, binding),
            state => BoneReset.restore(skeleton, state, animations),
        );
        /** @param {BABYLON.Bone[]} reset @returns {import('./PropertyPanel').PanelAction} */
        const resetAction = reset => ({
            label: reset.length === 1 ? 'Reset bone' : `Reset ${reset.length} bones`,
            title: 'Reset the bind pose: no rotation and a scaling of 1 in the axes of the model, the joints stay; the rest pose and the animations are converted, so the mesh moves as before',
            icon: 'discard',
            run: () => resetBones(reset),
        });
        /** @type {import('./DataTable').TableColumn[]} */
        const columns = [
            {
                label: 'Name',
                title: true,
                text: true,
                get: row => bones[row].name,
                // glTF saves the name of the transform node linked to the bone
                set: (row, name) => {
                    bones[row].name = String(name);
                    const node = bones[row].getTransformNode();
                    if (node) node.name = String(name);
                },
            },
            ...['PX', 'PY', 'PZ', 'RX°', 'RY°', 'RZ°', 'SX', 'SY', 'SZ'].map((label, component) => ({
                label,
                group: groups[Math.floor(component / 3)],
                get: row => (pose === 'rest' ? readRest(bones[row]) : bindValues(bones[row]))[component],
                set: (row, value) => pose === 'rest'
                    ? writeRest(bones[row], component, value, animations)
                    : writeBind(bones[row], component, value),
                // A bind edit may change the children too, so the whole skeleton is captured
                capture: row => pose === 'rest'
                    ? { pose: 'rest', matrix: bones[row].getRestMatrix().clone() }
                    : { pose: 'bind', matrices: animations.captureBind(skeleton) },
                restore: (row, state) => {
                    if (state.pose === 'rest') {
                        restoreRest(bones[row], state.matrix, animations);
                    } else {
                        animations.restoreBind(skeleton, state.matrices);
                        showPose(skeleton, 'bind');
                    }
                },
            })),
        ];
        return {
            title: 'Skeleton',
            subtitle: () => skeleton.name,
            twoColumns: true,
            properties: [
                textProperty(skeleton, 'name'),
                readonlyProperty('Bones', () => bones.length),
                readonlyProperty('Animation ranges', () => skeleton.getAnimationRanges().filter(Boolean).length),
            ],
            actions: [{
                label: 'Bind to current pose',
                title: 'Bind the meshes in the pose shown now: their vertices take its shape and it becomes the bind pose (the weights stay)',
                icon: 'pin',
                run: () => history.executeMutation(
                    `Bind ${skeleton.name || 'the skeleton'} to the current pose`,
                    () => SkinEdits.capture(skeleton, container, animations),
                    () => SkinEdits.bindToCurrentPose(skeleton, container, animations),
                    state => SkinEdits.restore(skeleton, animations, state, binding),
                ),
            }, {
                label: 'Automatic weights',
                title: 'Give every vertex the nearest bones of the bind pose (up to 4, by distance); IK and pole target bones are left out',
                icon: 'wand',
                run: () => history.executeMutation(
                    `Automatic weights of ${skeleton.name || 'the skeleton'}`,
                    () => SkinEdits.capture(skeleton, container, animations),
                    () => SkinEdits.automaticWeights(skeleton, container, binding),
                    state => SkinEdits.restore(skeleton, animations, state, binding),
                ),
            }, {
                label: 'Rest from bind',
                title: 'Make the bind pose of every bone (the pose the mesh is skinned in) its rest pose; the animations are not changed',
                icon: 'person',
                run: () => history.executeMutation(
                    `Rest from bind of ${skeleton.name || 'the skeleton'}`,
                    () => captureRestPose(skeleton),
                    () => restFromBind(skeleton, animations, binding),
                    state => restoreRestPose(skeleton, state),
                ),
            }, {
                label: 'Scale…',
                title: 'Scale the skeleton and the meshes it deforms uniformly, baked into the bones, the animations and the vertices',
                icon: 'screen-full',
                run: async () => {
                    const factor = await promptNumber(`Scale ${skeleton.name || 'the skeleton'}`, 'Factor for the skeleton and its meshes, e.g. 0.01 for centimeters to meters', 1);
                    if (!factor || factor === 1) return;
                    history.executeMutation(
                        `Scale ${skeleton.name || 'skeleton'} ×${factor}`,
                        () => SkeletonScale.capture(skeleton, container, animations),
                        () => SkeletonScale.apply(skeleton, container, animations, factor, binding),
                        state => SkeletonScale.restore(skeleton, animations, state),
                    );
                },
            }],
            table: {
                title: 'Bones',
                columns,
                groups: groups.map(key => ({ key, label: key[0].toUpperCase() + key.slice(1) })),
                modes: [{ key: 'rest', label: 'Rest' }, { key: 'bind', label: 'Bind' }],
                setMode: (key) => { pose = key === 'bind' ? 'bind' : 'rest'; },
                actions: [{
                    label: poseName,
                    title: () => pose === 'rest'
                        ? 'Show the rest pose of the skeleton; stops the animation and the auto-orbit'
                        : 'Show the bind pose (the pose the mesh is skinned in); stops the animation and the auto-orbit',
                    icon: 'person',
                    transient: true,
                    run: () => showPose(skeleton, pose),
                    isDisabled: () => isPose(skeleton, pose),
                }, {
                    label: 'Reset bones',
                    title: 'Reset the bind pose of all bones: no rotation and a scaling of 1 in the axes of the model, the joints stay (so do the bone lengths); the rest pose and the animations are converted, so the mesh moves as before (right click selected bones to reset only them)',
                    icon: 'discard',
                    isHidden: () => pose !== 'bind',
                    run: () => resetBones(bones),
                }, {
                    label: 'Move children',
                    title: () => moveChildren
                        ? 'Editing a bind value moves the child joints with the bone (click to keep them in place)'
                        : 'Editing a bind value keeps the child joints in place (click to move them with the bone)',
                    icon: 'type-hierarchy-sub',
                    transient: true,
                    isActive: () => moveChildren,
                    isHidden: () => pose !== 'bind',
                    run: () => { moveChildren = !moveChildren; },
                }],
                noticeWarning: () => pose === 'bind',
                notice: () => pose === 'rest'
                    ? 'Rest pose of the bones relative to the parent bone; an edited bone shows it while no animation is playing. Double-click a bone name to rename it.'
                    : 'Bind pose: where the joints sit relative to the mesh. Editing it changes how the mesh is skinned, so every animation will deform the mesh differently. Double-click a value to edit it, a bone name to rename it.',
                rowCount: () => bones.length,
                // Shared by the Rest and Bind tables: hides the bone in the 3D view only
                rowToggle: {
                    title: row => (highlighter.isBoneHidden(bones[row]) ? 'Show the bone in the 3D view' : 'Hide the bone in the 3D view (the file is not changed)'),
                    icon: row => (highlighter.isBoneHidden(bones[row]) ? 'eye-closed' : 'eye'),
                    isActive: row => highlighter.isBoneHidden(bones[row]),
                    run: row => highlighter.setBoneHidden(bones[row], !highlighter.isBoneHidden(bones[row])),
                },
                // Bones moved in the 3D view (edit mode) change the pose the switch shows
                poseEdit: {
                    objectOf: row => bones[row] ?? null,
                    begin: () => showPose(skeleton, pose),
                    setLocal: (row, local) => {
                        if (pose === 'rest') {
                            bones[row].setRestMatrix(local.clone());
                        } else {
                            animations.setBindMatrix(bones[row], local, moveChildren);
                        }
                        showPose(skeleton, pose);
                    },
                    capture: rows => (pose === 'rest'
                        ? { pose: 'rest', rows, matrices: rows.map(row => bones[row].getRestMatrix().clone()) }
                        : { pose: 'bind', matrices: animations.captureBind(skeleton) }),
                    restore: (state) => {
                        if (state.pose === 'rest') state.rows.forEach((row, index) => bones[row].setRestMatrix(state.matrices[index].clone()));
                        else animations.restoreBind(skeleton, state.matrices);
                        showPose(skeleton, state.pose);
                    },
                },
                // Right click on a bone: its commands
                rowMenu: (row, rows) => {
                    const picked = rows.length > 1 ? rows.map(index => bones[index]) : [bones[row]].filter(Boolean);
                    const menu = rows.length > 1
                        ? ModelProperties._bonesMenu(picked, { highlighter, deleteBones })
                        : ModelProperties._boneMenu(bones[row], { history, highlighter, promptText, deleteBones });
                    // In the Bind table the picked bones can be reset
                    return pose === 'bind' && picked.length ? [...menu, resetAction(picked)] : menu;
                },
                onSelectRow: row => highlighter.selectBone(bones[row] ?? null),
                // Shift+click selects several bones: all are highlighted
                onSelectRows: rows => highlighter.selectBones(rows.map(index => bones[index])),
                rowOf: object => bones.indexOf(object),
            },
        };
    }

    /**
     * The commands of a bone of the bone table (its context menu).
     * @param {BABYLON.Bone} bone
     * @param {Pick<PropertiesContext, 'history' | 'highlighter' | 'promptText' | 'deleteBones'>} context
     * @returns {import('./PropertyPanel').PanelAction[]}
     */
    static _boneMenu(bone, { history, highlighter, promptText, deleteBones }) {
        if (!bone) return [];
        const hidden = highlighter.isBoneHidden(bone);
        return [{
            label: 'Rename…',
            title: 'Rename the bone (and its linked node)',
            icon: 'edit',
            run: async () => {
                const name = (await promptText('Rename bone', 'Name', bone.name))?.trim();
                if (!name || name === bone.name) return;
                const rename = (value) => {
                    bone.name = value;
                    const node = bone.getTransformNode();
                    if (node) node.name = value;
                };
                history.executeMutation(`Rename bone ${bone.name}`, () => bone.name, () => rename(name), rename);
            },
        }, {
            label: hidden ? 'Show in the 3D view' : 'Hide in the 3D view',
            title: hidden ? 'Show the bone in the 3D view' : 'Hide the bone in the 3D view (the file is not changed)',
            icon: hidden ? 'eye' : 'eye-closed',
            transient: true,
            run: () => highlighter.setBoneHidden(bone, !hidden),
        }, {
            label: 'Delete bone',
            title: 'Delete the bone: its child bones and nodes hang from its parent, its weights go to its parent, its animations are removed (one undo step)',
            icon: 'trash',
            isDisabled: () => !deleteBones || bone.getSkeleton().bones.length < 2,
            run: () => deleteBones?.([bone]),
        }];
    }

    /**
     * The commands of several bones of the bone table (Shift+click selected them).
     * @param {BABYLON.Bone[]} bones
     * @param {Pick<PropertiesContext, 'highlighter' | 'deleteBones'>} context
     * @returns {import('./PropertyPanel').PanelAction[]}
     */
    static _bonesMenu(bones, { highlighter, deleteBones }) {
        const allHidden = bones.every(bone => highlighter.isBoneHidden(bone));
        return [{
            label: allHidden ? `Show ${bones.length} bones in the 3D view` : `Hide ${bones.length} bones in the 3D view`,
            title: 'Show or hide the selected bones in the 3D view (the file is not changed)',
            icon: allHidden ? 'eye' : 'eye-closed',
            transient: true,
            run: () => bones.forEach(bone => highlighter.setBoneHidden(bone, !allHidden)),
        }, {
            label: `Delete ${bones.length} bones`,
            title: 'Delete the selected bones: their child bones and nodes hang from the nearest kept bone above, their weights go to it, their animations are removed (one undo step)',
            icon: 'trash',
            isDisabled: () => !deleteBones || bones.length >= bones[0].getSkeleton().bones.length,
            run: () => deleteBones?.(bones),
        }];
    }

    /**
     * @param {BABYLON.Bone} bone
     * @param {PropertiesContext} context
     * @returns {PanelContent}
     */
    static _bone(bone, { animations }) {
        return {
            title: 'Bone',
            subtitle: () => bone.name,
            notice: 'The rest pose is visible while no animation is playing.',
            properties: [
                textProperty(bone, 'name'),
                readonlyProperty('Parent', () => bone.getParent()?.name ?? '—'),
                readonlyProperty('Children', () => bone.getChildren().length),
                ...boneRestProperties(bone, animations),
            ],
        };
    }

    /**
     * @param {import('./AnimationController').AnimationClip} clip
     * @param {PropertiesContext} context
     * @returns {PanelContent}
     */
    static _clip(clip, context) {
        const { animations } = context;
        const isRange = clip.ranges.length > 0;
        const frameProperty = (label, key) => isRange
            ? {
                label, type: 'number',
                get: () => clip[key],
                set: (value) => key === 'from' ? animations.setClipRange(clip, value, clip.to) : animations.setClipRange(clip, clip.from, value),
            }
            : readonlyProperty(label, () => clip[key]);
        const range = [frameProperty('From frame', 'from'), frameProperty('To frame', 'to')];
        // The whole timeline has no name (its header names the clip at the shown frame)
        return ClipFrameEditor.describe(clip, context, clip.isTimeline ? range : [
            { label: 'Name', type: 'text', get: () => clip.name, set: (value) => animations.renameClip(clip, value) },
            ...range,
        ]);
    }
}
