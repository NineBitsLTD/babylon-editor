import * as BABYLON from '@babylonjs/core';
import { isJointTip, jointNodes } from './ModelOutline';

/** Layer of the model meshes (Babylon's default layer mask): a view hides them by leaving it out of its camera's mask. */
export const MODEL_LAYER = 0x0FFFFFFF;
/** Layer of the bones: a view shows them when its camera's mask has it. */
export const BONES_LAYER = 0x10000000;

const BONE_COLOR = BABYLON.Color4.FromHexString('#ff9f1cff');
const SELECTED_COLOR = BABYLON.Color4.FromHexString('#4fc1ffff');
/** Base half-width of a pyramid relative to its length. */
const WIDTH_RATIO = 0.1;
/** Length of a leaf bone relative to the bone it continues. */
const LEAF_RATIO = 0.5;
/** 4 side faces + 2 base triangles, 3 unshared vertices each (flat shading). */
const VERTICES_PER_BONE = 18;
const TRIANGLES_PER_BONE = VERTICES_PER_BONE / 3;
const EPSILON = 1e-9;

/**
 * One pyramid: from the head of `from` to the head of `to`, or, for a leaf bone, to its tip node
 * or else continuing the direction of its parent bone.
 * @typedef {object} BoneSegment
 * @property {number} from bone index of the base (owner of the segment)
 * @property {number} to bone index of the apex, or -1 for a leaf
 * @property {number} parent parent bone index of a leaf without a tip, -1 otherwise
 * @property {BABYLON.TransformNode | null} tip the tip node of a leaf (`Head_end`), else null
 */

/**
 * @param {BABYLON.Skeleton} skeleton
 * @returns {BoneSegment[]}
 */
function buildSegments(skeleton) {
    const indexOf = new Map(skeleton.bones.map((bone, index) => [bone, index]));
    const joints = jointNodes([skeleton]);
    /** @type {BoneSegment[]} */
    const segments = [];
    skeleton.bones.forEach((bone, index) => {
        const children = bone.getChildren().filter(child => indexOf.has(child));
        for (const child of children) {
            segments.push({ from: index, to: indexOf.get(child), parent: -1, tip: null });
        }
        if (children.length) return;
        const tip = bone.getTransformNode()?.getChildren().find(child => isJointTip(child, joints)) ?? null;
        const parent = bone.getParent();
        // A root bone without children or a tip has no direction to draw
        if (tip || (parent && indexOf.has(parent))) {
            segments.push({ from: index, to: -1, parent: tip ? -1 : indexOf.get(parent), tip: /** @type {BABYLON.TransformNode | null} */ (tip) });
        }
    });
    return segments;
}

/**
 * Writes the 18 vertices of a pyramid with its base square at `head` and apex at `tail`.
 * @param {Float32Array} positions
 * @param {number} offset first float index
 * @param {BABYLON.Vector3} head
 * @param {BABYLON.Vector3} tail
 */
function writePyramid(positions, offset, head, tail) {
    const direction = tail.subtract(head);
    const length = direction.length();
    if (length < EPSILON) {
        for (let vertex = 0; vertex < VERTICES_PER_BONE; vertex++) head.toArray(positions, offset + vertex * 3);
        return;
    }
    direction.scaleInPlace(1 / length);
    const reference = Math.abs(direction.y) < 0.99 ? BABYLON.Vector3.Up() : BABYLON.Vector3.Right();
    const u = BABYLON.Vector3.Cross(direction, reference).normalize().scaleInPlace(length * WIDTH_RATIO);
    const v = BABYLON.Vector3.Cross(direction, u);
    const corners = [head.add(u), head.add(v), head.subtract(u), head.subtract(v)];
    const triangles = [
        [corners[0], corners[1], tail],
        [corners[1], corners[2], tail],
        [corners[2], corners[3], tail],
        [corners[3], corners[0], tail],
        [corners[0], corners[2], corners[1]],
        [corners[0], corners[3], corners[2]],
    ];
    triangles.flat().forEach((point, vertex) => point.toArray(positions, offset + vertex * 3));
}

/**
 * Draws the bones of a skeleton as pyramids pointing from each joint to its child joints,
 * on top of the model and following the animation. The helper mesh is named `__editor…`
 * so it is excluded from the scene extents; dispose it before serializing the scene.
 */
export class SkeletonView {

    /**
     * @param {BABYLON.Scene} scene
     * @param {BABYLON.Skeleton} skeleton
     * @param {Set<BABYLON.Bone>} [hidden] bones whose pyramids are not drawn (read on every frame)
     */
    constructor(scene, skeleton, hidden = new Set()) {
        this._scene = scene;
        this._skeleton = skeleton;
        this._hiddenBones = hidden;
        // .babylon bones are relative to the skinned mesh; glTF bones follow linked transform nodes
        this._mesh = scene.meshes.find(candidate => candidate.skeleton === skeleton) ?? null;
        this._segments = buildSegments(skeleton);
        /** @type {BABYLON.Bone | null} */
        this._selected = null;
        this._heads = skeleton.bones.map(() => new BABYLON.Vector3());
        this._positions = new Float32Array(this._segments.length * VERTICES_PER_BONE * 3);
        this._normals = new Float32Array(this._positions.length);
        this._indices = Array.from({ length: this._segments.length * VERTICES_PER_BONE }, (_, index) => index);
        this._helper = this._createMesh();
        this._observer = scene.onBeforeRenderObservable.add(() => this._update());
        this._update();
    }

    /**
     * Highlights the pyramids of a bone (or of the bone linked to a transform node).
     * @param {BABYLON.Bone | BABYLON.TransformNode | null} target
     */
    setSelected(target) {
        this._selected = target instanceof BABYLON.Bone
            ? target
            : this._skeleton.bones.find(bone => target && bone.getTransformNode() === target) ?? null;
        this._updateColors();
    }

    /** @returns {BABYLON.Bone | null} the highlighted bone */
    get selected() {
        return this._selected;
    }

    /**
     * Bone whose pyramid is under a screen point (the front-most one).
     * @param {number} x canvas x
     * @param {number} y canvas y
     * @returns {BABYLON.Bone | null}
     */
    pickBone(x, y) {
        // With several views the active camera is the one rendered last: pick in the view under the mouse
        const camera = this._scene.cameraToUseForPointers ?? this._scene.activeCamera;
        // A view that hides the bones does not pick them
        if (!camera || !(camera.layerMask & BONES_LAYER)) return null;
        // Positions change every frame, the bounding info is computed at creation only
        this._helper.refreshBoundingInfo();
        const info = this._scene.pick(x, y, mesh => mesh === this._helper, false, camera);
        if (!info?.hit || info.faceId < 0) return null;
        const segment = this._segments[Math.floor(info.faceId / TRIANGLES_PER_BONE)];
        return segment ? this._skeleton.bones[segment.from] : null;
    }

    dispose() {
        this._scene.onBeforeRenderObservable.remove(this._observer);
        this._helper.material?.dispose();
        this._helper.dispose();
    }

    /**
     * @returns {BABYLON.Mesh}
     */
    _createMesh() {
        const mesh = new BABYLON.Mesh('__editorSkeleton', this._scene);
        const vertexData = new BABYLON.VertexData();
        vertexData.positions = this._positions;
        vertexData.normals = this._normals;
        vertexData.indices = this._indices;
        vertexData.colors = new Float32Array(this._indices.length * 4);
        vertexData.applyToMesh(mesh, true);
        const material = new BABYLON.StandardMaterial('__editorSkeleton', this._scene);
        material.diffuseColor = BABYLON.Color3.White();
        material.emissiveColor = new BABYLON.Color3(0.3, 0.3, 0.3);
        material.specularColor = BABYLON.Color3.Black();
        material.backFaceCulling = false;
        material.twoSidedLighting = true;
        mesh.material = material;
        mesh.isPickable = false;
        // Each view shows or hides the bones through the layer mask of its camera
        mesh.layerMask = BONES_LAYER;
        // Drawn after the model with a cleared depth buffer, so bones stay visible through the mesh
        mesh.renderingGroupId = 1;
        mesh.alwaysSelectAsActiveMesh = true;
        this._updateColors(mesh);
        return mesh;
    }

    /**
     * @param {BABYLON.Mesh} [mesh]
     */
    _updateColors(mesh = this._helper) {
        const colors = new Float32Array(this._indices.length * 4);
        this._segments.forEach((segment, index) => {
            const color = this._skeleton.bones[segment.from] === this._selected ? SELECTED_COLOR : BONE_COLOR;
            for (let vertex = 0; vertex < VERTICES_PER_BONE; vertex++) {
                color.toArray(colors, (index * VERTICES_PER_BONE + vertex) * 4);
            }
        });
        mesh.setVerticesData(BABYLON.VertexBuffer.ColorKind, colors, true);
    }

    /** Recomputes the pyramids from the current pose. */
    _update() {
        if (!this._helper.isEnabled()) return;
        this._skeleton.bones.forEach((bone, index) => {
            const node = bone.getTransformNode();
            if (node) {
                this._heads[index].copyFrom(node.getAbsolutePosition());
            } else {
                bone.getAbsolutePositionToRef(this._mesh, this._heads[index]);
            }
        });
        this._segments.forEach((segment, index) => {
            const head = this._heads[segment.from];
            // A hidden bone collapses to a point: nothing is drawn or picked
            const tail = this._hiddenBones.has(this._skeleton.bones[segment.from]) ? head
                : segment.to >= 0 ? this._heads[segment.to]
                : segment.tip ? segment.tip.getAbsolutePosition()
                    : head.add(head.subtract(this._heads[segment.parent]).scaleInPlace(LEAF_RATIO));
            writePyramid(this._positions, index * VERTICES_PER_BONE * 3, head, tail);
        });
        BABYLON.VertexData.ComputeNormals(this._positions, this._indices, this._normals);
        this._helper.updateVerticesData(BABYLON.VertexBuffer.PositionKind, this._positions);
        this._helper.updateVerticesData(BABYLON.VertexBuffer.NormalKind, this._normals);
    }
}
