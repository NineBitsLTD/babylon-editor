import * as BABYLON from '@babylonjs/core';
import { ScreenSelection } from './ScreenSelection';
import { SELECTED_COLOR, SkeletonView } from './SkeletonView';
import { POINT_SIZE } from './ViewRendering';

const OUTLINE_COLOR = BABYLON.Color3.FromHexString('#ff9f1c');

const K = BABYLON.VertexBuffer;
/** A click picks a vertex drawn this close to the pointer (CSS pixels). */
const PICK_RADIUS = 10;
/** Selected vertices drawn at most (a selection of more shows the first ones). */
const MAX_MARKERS = 5000;

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
 * How much the world matrix and the skin enlarge a mesh as it is drawn (a model scaled by its
 * node or its bones, e.g. ×100 from FBX): the diagonal of the drawn vertices over that of the
 * vertex data.
 * @param {BABYLON.AbstractMesh} mesh
 * @returns {number} 1 when it cannot be told
 */
function drawnScale(mesh) {
    const diagonal = (positions) => {
        const min = [Infinity, Infinity, Infinity];
        const max = [-Infinity, -Infinity, -Infinity];
        for (let index = 0; index < positions.length; index++) {
            min[index % 3] = Math.min(min[index % 3], positions[index]);
            max[index % 3] = Math.max(max[index % 3], positions[index]);
        }
        return Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
    };
    const local = mesh.getVerticesData(K.PositionKind);
    const drawn = ScreenSelection.drawnPositions(mesh);
    if (!local?.length || !drawn) return 1;
    const scale = diagonal(drawn) / diagonal(local);
    return Number.isFinite(scale) && scale > 0 ? scale : 1;
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
        /** @type {BABYLON.Mesh | null} the selected vertices as points */
        this._markers = null;
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
        this._disposeMarkers();
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
            // Babylon moves the vertices by the width before the world and the skin matrices scale them
            mesh.outlineWidth = width / drawnScale(mesh);
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
     * The vertex of a mesh drawn nearest to a screen point (within a few pixels), where the skin
     * draws it; with occluders, only vertices no triangle of them hides.
     * @param {BABYLON.AbstractMesh} mesh
     * @param {number} x canvas x
     * @param {number} y canvas y
     * @param {BABYLON.AbstractMesh[] | null} occluders
     * @returns {number} the vertex, or -1
     */
    pickVertex(mesh, x, y, occluders) {
        return mesh.isEnabled() ? ScreenSelection.nearestVertex(this._scene, mesh, x, y, PICK_RADIUS, occluders) : -1;
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
     * Draws the selected vertices as points of the size of the vertex points, in the color of the
     * selected bones, over the model (at most MAX_MARKERS), following them while the pose changes.
     * @param {BABYLON.AbstractMesh} mesh
     * @param {number[]} indices vertex indices
     */
    showVertices(mesh, indices) {
        this._disposeMarkers();
        const shown = indices.slice(0, MAX_MARKERS);
        const point = new BABYLON.Vector3();
        // Where the skin draws them; the skin matrices of a frame are ready after it is drawn
        const place = (positions) => {
            shown.forEach((index, slot) => {
                if (drawnVertexPosition(mesh, index, point)) point.toArray(positions, slot * 3);
            });
            return positions;
        };
        const positions = place(new Float32Array(shown.length * 3));
        if (!shown.length) return;
        const markers = new BABYLON.Mesh('__editorVertexMarker', this._scene);
        markers.setVerticesData(K.PositionKind, positions, true);
        markers.setIndices(shown.map((_, slot) => slot));
        const material = new BABYLON.StandardMaterial('__editorVertexMarker', this._scene);
        Object.assign(material, { pointsCloud: true, pointSize: POINT_SIZE, disableLighting: true, backFaceCulling: false });
        material.emissiveColor = new BABYLON.Color3(SELECTED_COLOR.r, SELECTED_COLOR.g, SELECTED_COLOR.b);
        markers.material = material;
        markers.isPickable = false;
        markers.alwaysSelectAsActiveMesh = true;
        // Over the model and its vertex points
        markers.renderingGroupId = 1;
        const observer = this._scene.onAfterRenderObservable.add(() => markers.updateVerticesData(K.PositionKind, place(positions)));
        markers.onDisposeObservable.add(() => {
            this._scene.onAfterRenderObservable.remove(observer);
            material.dispose();
        });
        this._markers = markers;
    }

    _disposeMarkers() {
        this._markers?.dispose();
        this._markers = null;
    }

    _sceneRadius() {
        const { min, max } = this._scene.getWorldExtends(mesh => mesh.isEnabled() && mesh.isVisible && !mesh.name.startsWith('__editor'));
        const radius = BABYLON.Vector3.Distance(min, max) / 2;
        return Number.isFinite(radius) && radius > 0 ? radius : 1;
    }
}
