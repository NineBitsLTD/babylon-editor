import * as BABYLON from '@babylonjs/core';

/** Layer of the vertex points: a view shows them when its camera's mask has it. */
export const VERTICES_LAYER = 0x20000000;
/** Layer of the normal lines. */
export const NORMALS_LAYER = 0x40000000;
/** Layer of the axes of the bones (the top bit: a negative number in JavaScript, still a mask bit). */
export const BONE_AXES_LAYER = 0x80000000 | 0;

const NORMAL_COLOR = BABYLON.Color4.FromHexString('#2ec4ffff');
const AXIS_COLORS = ['#e5484dff', '#46a758ff', '#3e8ef7ff'].map(hex => BABYLON.Color4.FromHexString(hex));
const AXES = [BABYLON.Axis.X, BABYLON.Axis.Y, BABYLON.Axis.Z];
/** Length of a normal line and of a bone axis without a child, as a share of the size of the model. */
const NORMAL_LENGTH = 0.03;
/** Length of a bone axis as a share of the length of the bone. */
const AXIS_LENGTH = 0.4;

const VERTEX_COLOR = BABYLON.Color3.FromHexString('#ff2a2a');
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
 * hidden behind polygons are not drawn — the lines of the wireframe hide none), the normals of the
 * vertices as short lines and the axes of the bones (X red, Y green, Z blue at each joint: how the
 * bone is turned), both made again every frame from the pose (only while a view shows them).
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
        /** @type {BABYLON.LinesMesh | null} */
        this._normals = null;
        /** @type {BABYLON.LinesMesh | null} */
        this._axes = null;
        // The points follow their meshes (world matrix, visibility); the lines follow the pose
        scene.onBeforeRenderObservable.add(() => {
            this._updatePoints();
            if (this._normals) this._normals = this._drawLines(this._normals, NORMALS_LAYER, () => this._normalLines());
            if (this._axes) this._axes = this._drawLines(this._axes, BONE_AXES_LAYER, () => this._axisLines());
        });
    }

    /**
     * Draws the normals of the vertices while a view shows them.
     * @param {boolean} needed
     */
    setNormalsNeeded(needed) {
        if (needed && !this._normals) this._normals = this._drawLines(null, NORMALS_LAYER, () => this._normalLines());
        if (!needed && this._normals) {
            this._normals.dispose();
            this._normals = null;
        }
    }

    /**
     * Draws the axes of the bones while a view shows them.
     * @param {boolean} needed
     */
    setAxesNeeded(needed) {
        if (needed && !this._axes) this._axes = this._drawLines(null, BONE_AXES_LAYER, () => this._axisLines());
        if (!needed && this._axes) {
            this._axes.dispose();
            this._axes = null;
        }
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

    /**
     * Draws lines in the world, updating the mesh in place while the number of lines stays.
     * @param {BABYLON.LinesMesh | null} mesh
     * @param {number} layer
     * @param {() => { lines: BABYLON.Vector3[][], colors: BABYLON.Color4[][] }} make
     * @returns {BABYLON.LinesMesh}
     */
    _drawLines(mesh, layer, make) {
        const { lines, colors } = make();
        // An empty line system cannot be made: one line of no length
        if (!lines.length) {
            lines.push([BABYLON.Vector3.Zero(), BABYLON.Vector3.Zero()]);
            colors.push([NORMAL_COLOR, NORMAL_COLOR]);
        }
        if (mesh && mesh.metadata?.lineCount === lines.length) {
            return BABYLON.MeshBuilder.CreateLineSystem(mesh.name, { lines, colors, instance: mesh });
        }
        const name = mesh?.name ?? `__editorLines${layer}`;
        mesh?.dispose();
        const created = BABYLON.MeshBuilder.CreateLineSystem(name, { lines, colors, updatable: true, useVertexAlpha: false }, this._scene);
        created.metadata = { lineCount: lines.length };
        created.layerMask = layer;
        created.isPickable = false;
        created.alwaysSelectAsActiveMesh = true;
        // The axes of the bones sit inside the mesh: drawn over it, like the bones
        if (layer === BONE_AXES_LAYER) created.renderingGroupId = 1;
        return created;
    }

    /** @returns {number} the length of a normal line: a share of the size of the model */
    _lineLength() {
        let size = 0;
        for (const mesh of this._container?.meshes ?? []) {
            if (!mesh.getTotalVertices()) continue;
            const { minimumWorld, maximumWorld } = mesh.getBoundingInfo().boundingBox;
            size = Math.max(size, BABYLON.Vector3.Distance(minimumWorld, maximumWorld));
        }
        return (size || 1) * NORMAL_LENGTH;
    }

    /** @returns {{ lines: BABYLON.Vector3[][], colors: BABYLON.Color4[][] }} a line along the normal of every shown vertex */
    _normalLines() {
        const lines = [];
        const colors = [];
        const length = this._lineLength();
        const normal = new BABYLON.Vector3();
        for (const mesh of this._container?.meshes ?? []) {
            if (!mesh.getTotalVertices() || !mesh.isVerticesDataPresent(BABYLON.VertexBuffer.NormalKind)) continue;
            if (!mesh.isEnabled() || !mesh.isVisible || mesh.layerMask === 0) continue;
            // The pose of this frame (the skeleton is marked changed only later in the frame)
            mesh.skeleton?.prepare(true);
            // Where the skin puts them (as drawn), in the world
            const positions = mesh.getPositionData(true, true);
            const normals = mesh.getNormalsData(true, true);
            if (!positions || !normals) continue;
            const world = mesh.getWorldMatrix();
            for (let vertex = 0; vertex < positions.length / 3; vertex++) {
                const start = BABYLON.Vector3.TransformCoordinates(BABYLON.Vector3.FromArray(positions, vertex * 3), world);
                BABYLON.Vector3.TransformNormalToRef(BABYLON.Vector3.FromArray(normals, vertex * 3), world, normal);
                lines.push([start, start.add(normal.normalize().scaleInPlace(length))]);
                colors.push([NORMAL_COLOR, NORMAL_COLOR]);
            }
        }
        return { lines, colors };
    }

    /** @returns {{ lines: BABYLON.Vector3[][], colors: BABYLON.Color4[][] }} the X, Y and Z axes of every bone at its joint */
    _axisLines() {
        const lines = [];
        const colors = [];
        const fallback = this._lineLength();
        for (const skeleton of this._container?.skeletons ?? []) {
            const mesh = this._container.meshes.find(candidate => candidate.skeleton === skeleton);
            skeleton.prepare();
            const worlds = new Map(skeleton.bones.map((bone) => {
                // A linked bone is its node; else the bone in the space of the mesh it deforms
                const node = bone.getTransformNode();
                const world = node ? node.getWorldMatrix() : bone.getAbsoluteMatrix().multiply(mesh?.getWorldMatrix() ?? BABYLON.Matrix.Identity());
                return [bone, world];
            }));
            for (const bone of skeleton.bones) {
                const world = worlds.get(bone);
                const joint = world.getTranslation();
                const child = bone.getChildren()[0];
                const length = child ? BABYLON.Vector3.Distance(joint, worlds.get(child).getTranslation()) * AXIS_LENGTH : fallback;
                AXES.forEach((axis, index) => {
                    const direction = BABYLON.Vector3.TransformNormal(axis, world).normalize().scaleInPlace(length || fallback);
                    lines.push([joint, joint.add(direction)]);
                    colors.push([AXIS_COLORS[index], AXIS_COLORS[index]]);
                });
            }
        }
        return { lines, colors };
    }

    _updatePoints() {
        for (const { source, points } of this._points) {
            const shown = source.isEnabled() && source.isVisible && source.layerMask !== 0;
            points.setEnabled(shown);
            if (shown) points.freezeWorldMatrix(source.computeWorldMatrix());
        }
    }
}
