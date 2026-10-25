import * as BABYLON from '@babylonjs/core';

/** Layer of the vertex points: a view shows them when its camera's mask has it. */
export const VERTICES_LAYER = 0x20000000;

const VERTEX_COLOR = BABYLON.Color3.FromHexString('#ff9f1c');
/** Size of a vertex point in pixels. */
const POINT_SIZE = 4;

/**
 * @param {BABYLON.Color4 | BABYLON.Color3} color
 * @returns {BABYLON.Color3} a light gray on a dark color, a dark gray on a light one
 */
function contrastColor(color) {
    const luminance = 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
    return luminance > 0.5 ? new BABYLON.Color3(0.1, 0.1, 0.1) : new BABYLON.Color3(0.9, 0.9, 0.9);
}

/**
 * How each view draws the model, applied before the view is drawn and undone after it, so the
 * model (and the file) never keeps it:
 * - textured: as the model is;
 * - solid: without textures (Babylon's global `MaterialFlags.*TextureEnabled`, changed only when
 *   the mode does, as it marks every material as changed);
 * - wireframe: thin lines of one color that stands out from the background (the meshes get a
 *   shared line material for the time of the view), not the material of the mesh;
 * and the vertices as points over any mode (helper meshes sharing the geometry and the skeleton
 * of the model meshes, on their own layer; tested against the depth of the surfaces, so points
 * hidden behind polygons are not drawn — the lines of the wireframe hide none).
 */
export class ViewRendering {

    /**
     * @param {BABYLON.Scene} scene
     */
    constructor(scene) {
        this._scene = scene;
        /** @type {BABYLON.AssetContainer | null} */
        this._container = null;
        /** @type {import('./Toolbar').RenderMode | null} the mode of the global texture flags */
        this._textureMode = null;
        /** @type {Map<BABYLON.AbstractMesh, BABYLON.Nullable<BABYLON.Material>>} materials replaced for a wireframe view */
        this._replaced = new Map();
        this._lineMaterial = new BABYLON.StandardMaterial('__editorWireframe', scene);
        Object.assign(this._lineMaterial, { wireframe: true, disableLighting: true, backFaceCulling: false });
        this._lineMaterial.specularColor = BABYLON.Color3.Black();
        this._pointMaterial = new BABYLON.StandardMaterial('__editorVertices', scene);
        Object.assign(this._pointMaterial, { pointsCloud: true, pointSize: POINT_SIZE, disableLighting: true, backFaceCulling: false });
        this._pointMaterial.emissiveColor = VERTEX_COLOR;
        /** @type {{ source: BABYLON.Mesh, points: BABYLON.Mesh }[]} */
        this._points = [];
        this._wantPoints = false;
        // The points follow their meshes (world matrix, visibility)
        scene.onBeforeRenderObservable.add(() => this._updatePoints());
    }

    /**
     * The model changed: the vertex points are made again.
     * @param {BABYLON.AssetContainer | null} container
     */
    setContainer(container) {
        this._container = container;
        this._disposePoints();
        if (this._wantPoints) this._makePoints();
    }

    /**
     * Makes the vertex points while a view shows them (none are kept otherwise).
     * @param {boolean} needed
     */
    setPointsNeeded(needed) {
        this._wantPoints = needed;
        if (needed && !this._points.length) this._makePoints();
        if (!needed) this._disposePoints();
    }

    /**
     * Before a view is drawn.
     * @param {import('./CameraViews').ViewSettings} settings
     */
    beforeView({ renderMode }) {
        this._applyTextures(renderMode === 'solid' ? 'solid' : 'textured');
        if (renderMode === 'wireframe') this._useLines();
    }

    /** After a view is drawn: the meshes get their materials back. */
    afterView() {
        this._replaced.forEach((material, mesh) => { mesh.material = material; });
        this._replaced.clear();
    }

    /**
     * @param {'textured' | 'solid'} mode
     */
    _applyTextures(mode) {
        if (mode === this._textureMode) return;
        this._textureMode = mode;
        for (const flag of Object.getOwnPropertyNames(BABYLON.MaterialFlags)) {
            if (flag.endsWith('TextureEnabled')) BABYLON.MaterialFlags[flag] = mode === 'textured';
        }
    }

    /** The model meshes are drawn as lines of the color that stands out from the background. */
    _useLines() {
        this._lineMaterial.emissiveColor = contrastColor(this._scene.clearColor);
        for (const mesh of this._container?.meshes ?? []) {
            if (!mesh.getTotalVertices() || this._replaced.has(mesh)) continue;
            this._replaced.set(mesh, mesh.material);
            mesh.material = this._lineMaterial;
        }
    }

    _makePoints() {
        for (const source of this._container?.meshes ?? []) {
            if (!(source instanceof BABYLON.Mesh) || !source.getTotalVertices()) continue;
            // Shares the geometry, the skeleton and the morph targets: the points follow edits and animations
            const points = new BABYLON.Mesh(`__editorVertices ${source.name}`, this._scene);
            source.geometry?.applyToMesh(points);
            points.skeleton = source.skeleton;
            points.numBoneInfluencers = source.numBoneInfluencers;
            points.morphTargetManager = source.morphTargetManager;
            points.material = this._pointMaterial;
            points.layerMask = VERTICES_LAYER;
            points.isPickable = false;
            points.alwaysSelectAsActiveMesh = true;
            this._points.push({ source, points });
        }
        this._updatePoints();
    }

    _disposePoints() {
        // The geometry stays with the model meshes
        this._points.forEach(({ points }) => {
            points.geometry?.releaseForMesh(points);
            points.dispose(false, false);
        });
        this._points = [];
    }

    _updatePoints() {
        for (const { source, points } of this._points) {
            const shown = source.isEnabled() && source.isVisible && source.layerMask !== 0;
            points.setEnabled(shown);
            if (shown) points.freezeWorldMatrix(source.computeWorldMatrix());
        }
    }
}
