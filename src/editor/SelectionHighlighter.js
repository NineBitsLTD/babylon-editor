import * as BABYLON from '@babylonjs/core';
import { SkeletonView } from './SkeletonView';

const OUTLINE_COLOR = BABYLON.Color3.FromHexString('#ff9f1c');

/**
 * What the skeleton mode shows: the model meshes and/or the bones.
 * @typedef {object} SkeletonDisplay
 * @property {boolean} mesh
 * @property {boolean} bones
 */

/**
 * Visualizes the inspector selection in the 3D view: mesh outlines, the skeleton of a bone,
 * skeleton or clip (skeleton mode, where the model meshes can be hidden), and a marker for
 * a vertex. Helper meshes and hidden meshes are not part of the saved model; call clear()
 * before serializing the scene.
 */
export class SelectionHighlighter {

    /**
     * @param {BABYLON.Scene} scene
     */
    constructor(scene) {
        this._scene = scene;
        /** @type {BABYLON.AbstractMesh[]} */
        this._outlined = [];
        /** @type {SkeletonView | null} */
        this._skeletonView = null;
        /** @type {BABYLON.Mesh | null} */
        this._marker = null;
        /** Meshes hidden in skeleton mode -> their original layer mask. */
        this._hidden = new Map();
        /** @type {SkeletonDisplay} */
        this.skeletonDisplay = { mesh: true, bones: true };
        /** @type {Set<BABYLON.Bone>} bones not drawn in skeleton mode (view only, kept while switching objects) */
        this.hiddenBones = new Set();
    }

    /**
     * @param {BABYLON.Bone} bone
     * @returns {boolean} the bone is not drawn in skeleton mode
     */
    isBoneHidden(bone) {
        return this.hiddenBones.has(bone);
    }

    /**
     * Hides or shows the pyramids of a bone in skeleton mode (its child bones stay); the model is
     * not changed.
     * @param {BABYLON.Bone} bone
     * @param {boolean} hidden
     */
    setBoneHidden(bone, hidden) {
        if (hidden) this.hiddenBones.add(bone);
        else this.hiddenBones.delete(bone);
    }

    /** Whether a skeleton is shown (the skeleton display options apply). */
    get isSkeletonMode() {
        return !!this._skeletonView;
    }

    /** Removes every highlight, disposes helper meshes and shows hidden meshes again. */
    clear() {
        this._outlined.forEach(mesh => { mesh.renderOutline = false; });
        this._outlined = [];
        this._skeletonView?.dispose();
        this._skeletonView = null;
        this._showMeshes();
        this._marker?.dispose();
        this._marker = null;
    }

    /**
     * Changes what the skeleton mode shows; applies immediately when a skeleton is shown.
     * @param {SkeletonDisplay} display
     */
    setSkeletonDisplay(display) {
        this.skeletonDisplay = { ...display };
        this._applySkeletonDisplay();
    }

    /**
     * Outlines the given meshes (e.g. a selected mesh, the meshes of a node or of a material).
     * @param {BABYLON.AbstractMesh[]} meshes
     */
    outlineMeshes(meshes) {
        this.clear();
        const width = this._sceneRadius() * 0.004;
        for (const mesh of meshes) {
            if (!mesh.getTotalVertices?.()) continue;
            mesh.renderOutline = true;
            mesh.outlineColor = OUTLINE_COLOR;
            mesh.outlineWidth = width;
            this._outlined.push(mesh);
        }
    }

    /**
     * Enters skeleton mode: shows the bones as pyramids on top of the model and hides
     * the model meshes according to skeletonDisplay.
     * @param {BABYLON.Skeleton} skeleton
     * @param {BABYLON.Bone | BABYLON.TransformNode | null} [selected] bone to highlight
     */
    showSkeleton(skeleton, selected = null) {
        this.clear();
        this._skeletonView = new SkeletonView(this._scene, skeleton, this.hiddenBones);
        this._skeletonView.setSelected(selected);
        this._applySkeletonDisplay();
    }

    /** @returns {BABYLON.Bone | null} the bone highlighted in skeleton mode */
    get selectedBone() {
        return this._skeletonView?.selected ?? null;
    }

    /**
     * Bone of the shown skeleton under a screen point, or null (no skeleton mode, bones hidden).
     * @param {number} x canvas x
     * @param {number} y canvas y
     * @returns {BABYLON.Bone | null}
     */
    pickBone(x, y) {
        return this._skeletonView?.pickBone(x, y) ?? null;
    }

    /**
     * Highlights another bone of the shown skeleton.
     * @param {BABYLON.Bone | BABYLON.TransformNode | null} selected
     */
    selectBone(selected) {
        this._skeletonView?.setSelected(selected);
    }

    _applySkeletonDisplay() {
        if (!this._skeletonView) return;
        this._skeletonView.setVisible(this.skeletonDisplay.bones);
        if (this.skeletonDisplay.mesh) {
            this._showMeshes();
        } else {
            this._hideMeshes();
        }
    }

    /** Hides the model meshes through the layer mask (no editor property controls it). */
    _hideMeshes() {
        for (const mesh of this._scene.meshes) {
            if (mesh.name.startsWith('__editor') || this._hidden.has(mesh)) continue;
            this._hidden.set(mesh, mesh.layerMask);
            mesh.layerMask = 0;
        }
    }

    _showMeshes() {
        this._hidden.forEach((layerMask, mesh) => { mesh.layerMask = layerMask; });
        this._hidden.clear();
    }

    /**
     * Places a marker at a vertex (bind pose position transformed by the mesh world matrix).
     * @param {BABYLON.AbstractMesh} mesh
     * @param {number} index vertex index
     */
    showVertex(mesh, index) {
        this._marker?.dispose();
        const positions = mesh.getVerticesData(BABYLON.VertexBuffer.PositionKind);
        if (!positions || index < 0 || index * 3 + 2 >= positions.length) return;
        const local = BABYLON.Vector3.FromArray(positions, index * 3);
        const marker = BABYLON.MeshBuilder.CreateSphere('__editorVertexMarker', { diameter: this._sceneRadius() * 0.02, segments: 8 }, this._scene);
        const material = new BABYLON.StandardMaterial('__editorVertexMarker', this._scene);
        material.emissiveColor = OUTLINE_COLOR;
        material.disableLighting = true;
        marker.material = material;
        marker.isPickable = false;
        marker.renderingGroupId = 1;
        marker.position = BABYLON.Vector3.TransformCoordinates(local, mesh.getWorldMatrix());
        marker.onDisposeObservable.add(() => material.dispose());
        this._marker = marker;
    }

    _sceneRadius() {
        const { min, max } = this._scene.getWorldExtends(mesh => mesh.isEnabled() && mesh.isVisible && !mesh.name.startsWith('__editor'));
        const radius = BABYLON.Vector3.Distance(min, max) / 2;
        return Number.isFinite(radius) && radius > 0 ? radius : 1;
    }
}
