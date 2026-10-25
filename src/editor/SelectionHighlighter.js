import * as BABYLON from '@babylonjs/core';
import { ScreenSelection } from './ScreenSelection';
import { SkeletonView } from './SkeletonView';

const OUTLINE_COLOR = BABYLON.Color3.FromHexString('#ff9f1c');

const K = BABYLON.VertexBuffer;
/** A click picks a vertex drawn this close to the pointer (CSS pixels). */
const PICK_RADIUS = 10;
/** Markers shown at most (a selection of many vertices shows the first ones). */
const MAX_MARKERS = 200;

/**
 * Where a vertex is drawn: its position moved by the bones that influence it (as the skinning
 * shader does: the blend of the skin matrices, weighted), then by the world matrix of the mesh.
 * Morph targets are not applied.
 * @param {BABYLON.AbstractMesh} mesh
 * @param {number} index
 * @param {BABYLON.Vector3} result
 * @returns {boolean} whether the mesh has the vertex
 */
export function drawnVertexPosition(mesh, index, result) {
    const positions = mesh.getVerticesData(K.PositionKind);
    if (!positions || index < 0 || index * 3 + 2 >= positions.length) return false;
    const local = BABYLON.Vector3.FromArray(positions, index * 3);
    const skeleton = mesh.skeleton;
    if (skeleton && mesh.useBones && mesh.isVerticesDataPresent(K.MatricesIndicesKind)) {
        const matrices = skeleton.getTransformMatrices(mesh);
        const skinned = BABYLON.Vector3.Zero();
        const moved = new BABYLON.Vector3();
        let total = 0;
        for (const [indicesKind, weightsKind] of [[K.MatricesIndicesKind, K.MatricesWeightsKind], [K.MatricesIndicesExtraKind, K.MatricesWeightsExtraKind]]) {
            const indices = mesh.getVerticesData(indicesKind);
            const weights = mesh.getVerticesData(weightsKind);
            if (!indices || !weights) continue;
            for (let slot = 0; slot < 4; slot++) {
                const weight = weights[index * 4 + slot];
                if (!(weight > 0)) continue;
                BABYLON.Vector3.TransformCoordinatesToRef(local, BABYLON.Matrix.FromArray(matrices, indices[index * 4 + slot] * 16), moved);
                skinned.addInPlace(moved.scaleInPlace(weight));
                total += weight;
            }
        }
        if (total > 0) local.copyFrom(skinned);
    }
    BABYLON.Vector3.TransformCoordinatesToRef(local, mesh.getWorldMatrix(), result);
    return true;
}

/**
 * What the skeleton mode shows: the model meshes and/or the bones.
 * @typedef {object} SkeletonDisplay
 * @property {boolean} mesh
 * @property {boolean} bones
 */

/**
 * Visualizes the inspector selection in the 3D view: mesh outlines, the skeleton of a bone,
 * skeleton or clip (skeleton mode: each view shows the meshes and / or the bones as its settings
 * say, through the layer mask of its camera — CameraViews), and a marker for a vertex. Helper
 * meshes are not part of the saved model; call clear() before serializing the scene.
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
        /** @type {BABYLON.Mesh[]} markers of the selected vertices */
        this._markers = [];
        /** @type {SkeletonDisplay} what a new view shows in skeleton mode */
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
        this._markers.forEach(marker => marker.dispose());
        this._markers = [];
    }

    /**
     * Changes what a new view shows in skeleton mode.
     * @param {SkeletonDisplay} display
     */
    setSkeletonDisplay(display) {
        this.skeletonDisplay = { ...display };
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
     * Enters skeleton mode: shows the bones as pyramids on top of the model (the views show the
     * meshes and the bones as their settings say).
     * @param {BABYLON.Skeleton} skeleton
     * @param {BABYLON.Bone | BABYLON.TransformNode | null} [selected] bone to highlight
     */
    showSkeleton(skeleton, selected = null) {
        this.clear();
        this._skeletonView = new SkeletonView(this._scene, skeleton, this.hiddenBones);
        this._skeletonView.setSelected(selected);
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

    /**
     * Highlights several bones of the shown skeleton (Shift+click).
     * @param {BABYLON.Bone[]} bones
     */
    selectBones(bones) {
        this._skeletonView?.setHighlighted(bones);
    }

    /** @returns {BABYLON.Skeleton | null} the skeleton shown in skeleton mode */
    get shownSkeleton() {
        return this._skeletonView?.skeleton ?? null;
    }

    /** @returns {BABYLON.Bone[]} the highlighted bones of the shown skeleton */
    get selectedBones() {
        return this._skeletonView?.highlighted ?? [];
    }

    /**
     * The vertex of a mesh drawn nearest to a screen point (within a few pixels; the one nearest the
     * camera when several are), where the skin draws it.
     * @param {BABYLON.AbstractMesh} mesh
     * @param {number} x canvas x
     * @param {number} y canvas y
     * @returns {number} the vertex, or -1
     */
    pickVertex(mesh, x, y) {
        return mesh.isEnabled() ? ScreenSelection.nearestVertex(this._scene, mesh, x, y, PICK_RADIUS) : -1;
    }

    /**
     * Places a marker at a vertex where it is drawn (moved by its bones), following it while the
     * pose changes.
     * @param {BABYLON.AbstractMesh} mesh
     * @param {number} index vertex index
     */
    showVertex(mesh, index) {
        this.showVertices(mesh, index >= 0 ? [index] : []);
    }

    /**
     * Places markers at vertices (the selected ones), at most MAX_MARKERS, following them while the
     * pose changes.
     * @param {BABYLON.AbstractMesh} mesh
     * @param {number[]} indices
     */
    showVertices(mesh, indices) {
        this._markers.forEach(marker => marker.dispose());
        this._markers = [];
        const shown = indices.slice(0, MAX_MARKERS);
        if (!shown.length) return;
        const diameter = this._sceneRadius() * 0.02;
        const material = new BABYLON.StandardMaterial('__editorVertexMarker', this._scene);
        material.emissiveColor = OUTLINE_COLOR;
        material.disableLighting = true;
        for (const index of shown) {
            const position = new BABYLON.Vector3();
            if (!drawnVertexPosition(mesh, index, position)) continue;
            const marker = BABYLON.MeshBuilder.CreateSphere('__editorVertexMarker', { diameter, segments: 8 }, this._scene);
            marker.material = material;
            marker.isPickable = false;
            marker.renderingGroupId = 1;
            marker.position = position;
            // The skin matrices of the frame are ready after it is drawn
            const observer = this._scene.onAfterRenderObservable.add(() => drawnVertexPosition(mesh, index, marker.position));
            marker.onDisposeObservable.add(() => this._scene.onAfterRenderObservable.remove(observer));
            this._markers.push(marker);
        }
        // The material goes with the markers
        if (this._markers.length) this._markers[0].onDisposeObservable.add(() => material.dispose());
        else material.dispose();
    }

    _sceneRadius() {
        const { min, max } = this._scene.getWorldExtends(mesh => mesh.isEnabled() && mesh.isVisible && !mesh.name.startsWith('__editor'));
        const radius = BABYLON.Vector3.Distance(min, max) / 2;
        return Number.isFinite(radius) && radius > 0 ? radius : 1;
    }
}
