import * as BABYLON from '@babylonjs/core';
import { drawnVertexPosition } from './SelectionHighlighter';

/** @typedef {'move' | 'rotate' | 'scale'} TransformTool */

/**
 * What the bone table of the inspector edits when a bone is moved in the 3D view (the skeleton
 * inspector: its rest or bind pose; the clip inspector: keys at the shown frame).
 * @typedef {object} PoseEdit
 * @property {(row: number) => BABYLON.Bone | BABYLON.TransformNode | null} objectOf the bone (or node) of a record
 * @property {() => void} begin shows the pose that is edited
 * @property {(row: number, local: BABYLON.Matrix) => void} setLocal sets the local matrix of a record
 *   (relative to its parent, as `AnimationController.poseMatrix`)
 * @property {(rows: number[]) => any} capture
 * @property {(state: any) => void} restore
 */

/**
 * The selection the gizmo moves: bones of a bone table, or vertices of a mesh.
 * @typedef {{ kind: 'bones', rows: number[], pose: PoseEdit } | { kind: 'vertices', mesh: BABYLON.Mesh, rows: number[] }
 *   | { kind: 'node', node: BABYLON.TransformNode, rows: number[], onMoved?: () => void } | null} EditSelection
 *   node: a helper of the view moved as a whole (not recorded: not part of the model), rows `[0]`
 */

const K = BABYLON.VertexBuffer;

/**
 * @param {BABYLON.Bone | BABYLON.TransformNode} target
 * @param {BABYLON.AbstractMesh | null} mesh the mesh a bone without a linked node deforms
 * @returns {{ world: BABYLON.Matrix, parentWorld: BABYLON.Matrix }} where it is drawn and its parent space
 */
function worldOf(target, mesh) {
    const node = target instanceof BABYLON.Bone ? target.getTransformNode() : target;
    if (node) {
        const parent = node.parent ? node.parent.computeWorldMatrix(true).clone() : BABYLON.Matrix.Identity();
        return { world: node.computeWorldMatrix(true).clone(), parentWorld: parent };
    }
    target.getSkeleton().computeAbsoluteMatrices(true);
    const meshWorld = mesh?.getWorldMatrix() ?? BABYLON.Matrix.Identity();
    const parent = target.getParent();
    return {
        world: target.getAbsoluteMatrix().multiply(meshWorld),
        parentWorld: parent ? parent.getAbsoluteMatrix().multiply(meshWorld) : meshWorld.clone(),
    };
}

/**
 * The blend of the skin matrices of a vertex (what moves its position as it is drawn), or the identity.
 * @param {BABYLON.AbstractMesh} mesh
 * @param {number} vertex
 * @returns {BABYLON.Matrix}
 */
function skinMatrixOf(mesh, vertex) {
    const skeleton = mesh.skeleton;
    if (!skeleton || !mesh.useBones || !mesh.isVerticesDataPresent(K.MatricesIndicesKind)) return BABYLON.Matrix.Identity();
    const matrices = skeleton.getTransformMatrices(mesh);
    const blend = BABYLON.Matrix.Zero();
    const scaled = new BABYLON.Matrix();
    let total = 0;
    for (const [indicesKind, weightsKind] of [[K.MatricesIndicesKind, K.MatricesWeightsKind], [K.MatricesIndicesExtraKind, K.MatricesWeightsExtraKind]]) {
        const indices = mesh.getVerticesData(indicesKind);
        const weights = mesh.getVerticesData(weightsKind);
        if (!indices || !weights) continue;
        for (let slot = 0; slot < 4; slot++) {
            const weight = weights[vertex * 4 + slot];
            if (!(weight > 0)) continue;
            BABYLON.Matrix.FromArray(matrices, indices[vertex * 4 + slot] * 16).scaleToRef(weight, scaled);
            blend.addToSelf(scaled);
            total += weight;
        }
    }
    return total > 0 ? blend : BABYLON.Matrix.Identity();
}

/**
 * @param {BABYLON.Matrix} matrix
 * @returns {BABYLON.Quaternion} the rotation of a matrix (scaling left out)
 */
function rotationOf(matrix) {
    const rotation = new BABYLON.Quaternion();
    matrix.decompose(new BABYLON.Vector3(), rotation, new BABYLON.Vector3());
    return rotation;
}

/**
 * Moves, turns or scales the selected bones or vertices with a gizmo of Babylon placed at the centre
 * of the selection (in world axes, or the local axes of the first bone / of the mesh), as 3ds Max does. A drag is applied live and recorded as one
 * undoable change when it ends: the start state is put back and the end state applied by the history.
 * - Bones: the selected bones without a selected ancestor (their children follow) take the change
 *   of the gizmo in the world; their local matrix (relative to the parent) goes to the pose the
 *   inspector edits (`PoseEdit`).
 * - Vertices: their drawn positions (skinned) take the change; the positions of the mesh are found
 *   back through the inverse of the skin of each vertex. Vertices at the position of a selected one
 *   (copies of a flat-shaded corner) move with it. The normals of the vertices of the triangles they
 *   are in are made again: the area-weighted average of the faces of each vertex (its own face for a
 *   flat-shaded copy), on the side the normal had.
 */
export class TransformEditing {

    /**
     * @param {BABYLON.Scene} scene
     * @param {object} options
     * @param {() => EditSelection} options.selection what the gizmo moves now
     * @param {(label: string, capture: () => any, apply: () => void, restore: (state: any) => void) => void} options.record
     *   records an undoable change (EditHistory.executeMutation)
     * @param {() => BABYLON.AbstractMesh | null} options.meshOfBones the mesh the shown skeleton deforms
     */
    constructor(scene, { selection, record, meshOfBones }) {
        this._scene = scene;
        this._selection = selection;
        this._record = record;
        this._meshOfBones = meshOfBones;
        /** @type {TransformTool | null} null: no gizmo (not the edit mode) */
        this._tool = null;
        /** The gizmo takes the axes of the first bone / of the mesh instead of the world axes */
        this._local = false;
        this._layer = new BABYLON.UtilityLayerRenderer(scene);
        this._layer.utilityLayerScene.autoClearDepthAndStencil = true;
        this._pivot = new BABYLON.TransformNode('__editorPivot', this._layer.utilityLayerScene);
        this._pivot.rotationQuaternion = BABYLON.Quaternion.Identity();
        this._gizmos = {
            move: new BABYLON.PositionGizmo(this._layer),
            rotate: new BABYLON.RotationGizmo(this._layer),
            scale: new BABYLON.ScaleGizmo(this._layer),
        };
        for (const gizmo of Object.values(this._gizmos)) {
            gizmo.updateGizmoRotationToMatchAttachedMesh = false;
            gizmo.onDragStartObservable.add(() => this._begin());
            gizmo.onDragEndObservable.add(() => this._end());
        }
        /** @type {any} the drag in progress */
        this._drag = null;
        scene.onBeforeRenderObservable.add(() => this._update());
    }

    /** @returns {boolean} the pointer is over the gizmo (a click there is not a selection) */
    get isHovered() {
        return !!this._tool && this._gizmos[this._tool].isHovered;
    }

    /**
     * @param {TransformTool | null} tool null hides the gizmo
     */
    setTool(tool) {
        this._tool = tool;
        this._place();
    }

    /**
     * @param {boolean} local the gizmo takes the axes of the first selected bone (or of the mesh) instead of the world axes
     */
    setLocal(local) {
        this._local = local;
        for (const gizmo of Object.values(this._gizmos)) gizmo.updateGizmoRotationToMatchAttachedMesh = local;
        this._place();
    }

    /** Places the gizmo at the centre of the selection (it follows the pose); hidden without one. */
    _update() {
        // Drawn and used in the view under the pointer
        const camera = this._scene.cameraToUseForPointers ?? this._scene.activeCamera;
        if (camera && camera !== this._camera) {
            this._camera = camera;
            this._layer.setRenderCamera(camera);
        }
        if (this._drag) {
            this._apply(false);
            return;
        }
        this._place();
    }

    _place() {
        const centre = this._tool ? this._centre() : null;
        for (const [tool, gizmo] of Object.entries(this._gizmos)) gizmo.attachedNode = centre && tool === this._tool ? this._pivot : null;
        if (!centre) return;
        this._pivot.position.copyFrom(centre);
        this._pivot.rotationQuaternion = this._local ? this._orientation() : BABYLON.Quaternion.Identity();
        this._pivot.scaling.setAll(1);
    }

    /** @returns {BABYLON.Quaternion} the local axes: of the first selected bone, or of the mesh */
    _orientation() {
        const selection = this._selection();
        if (selection?.kind === 'bones') {
            const row = this._rootRows(selection)[0];
            const target = row === undefined ? null : selection.pose.objectOf(row);
            return target ? rotationOf(worldOf(target, this._meshOfBones()).world) : BABYLON.Quaternion.Identity();
        }
        if (selection?.kind === 'node') return rotationOf(selection.node.computeWorldMatrix(true));
        return selection ? rotationOf(selection.mesh.getWorldMatrix()) : BABYLON.Quaternion.Identity();
    }

    /** @returns {BABYLON.Vector3 | null} the centre of the selection where it is drawn */
    _centre() {
        const selection = this._selection();
        if (!selection?.rows.length) return null;
        if (selection.kind === 'node') return selection.node.getAbsolutePosition().clone();
        const points = selection.kind === 'bones'
            ? this._rootRows(selection).map(row => worldOf(selection.pose.objectOf(row), this._meshOfBones()).world.getTranslation())
            : selection.rows.slice(0, 2000).map((vertex) => {
                const point = new BABYLON.Vector3();
                return drawnVertexPosition(selection.mesh, vertex, point) ? point : null;
            }).filter(Boolean);
        if (!points.length) return null;
        return points.reduce((sum, point) => sum.addInPlace(point), BABYLON.Vector3.Zero()).scaleInPlace(1 / points.length);
    }

    /**
     * @param {{ rows: number[], pose: PoseEdit }} selection
     * @returns {number[]} the selected rows whose bone has no selected ancestor
     */
    _rootRows(selection) {
        const selected = new Set(selection.rows.map(row => selection.pose.objectOf(row)).filter(Boolean));
        return selection.rows.filter((row) => {
            const target = selection.pose.objectOf(row);
            if (!target) return false;
            for (let parent = target instanceof BABYLON.Bone ? target.getParent() : target.parent; parent; parent = parent instanceof BABYLON.Bone ? parent.getParent() : parent.parent) {
                if (selected.has(parent)) return false;
            }
            return true;
        });
    }

    /** A drag starts: the start state of the selection. */
    _begin() {
        const selection = this._selection();
        if (!selection?.rows.length) return;
        const start = this._pivot.computeWorldMatrix(true).clone();
        if (selection.kind === 'node') {
            this._drag = { selection, start, world: selection.node.computeWorldMatrix(true).clone() };
            return;
        }
        if (selection.kind === 'bones') {
            selection.pose.begin();
            const rows = this._rootRows(selection);
            this._drag = {
                selection, start, rows,
                state: selection.pose.capture(rows),
                worlds: rows.map(row => worldOf(selection.pose.objectOf(row), this._meshOfBones())),
            };
            return;
        }
        const { mesh } = selection;
        const positions = Float32Array.from(mesh.getVerticesData(K.PositionKind));
        // The selected vertices and the vertices at their positions
        const keyOf = vertex => `${positions[vertex * 3]},${positions[vertex * 3 + 1]},${positions[vertex * 3 + 2]}`;
        const wanted = new Set(selection.rows.map(keyOf));
        const vertices = [];
        for (let vertex = 0; vertex < positions.length / 3; vertex++) if (wanted.has(keyOf(vertex))) vertices.push(vertex);
        mesh.skeleton?.prepare(true);
        const world = mesh.getWorldMatrix().clone();
        this._drag = {
            selection, start, vertices, positions,
            ...this._normalsToUpdate(mesh, vertices),
            drawn: vertices.map((vertex) => {
                const point = new BABYLON.Vector3();
                drawnVertexPosition(mesh, vertex, point);
                return point;
            }),
            // From the world back to the positions of the mesh: world⁻¹, then the inverse of the skin
            back: vertices.map(vertex => BABYLON.Matrix.Invert(world).multiply(BABYLON.Matrix.Invert(skinMatrixOf(mesh, vertex)))),
        };
    }

    /**
     * The change of the gizmo since the drag began, applied to the selection.
     * @param {boolean} final
     * @returns {any} what was applied (local matrices of the bones, positions of the vertices)
     */
    _apply(final) {
        const drag = this._drag;
        const delta = BABYLON.Matrix.Invert(drag.start).multiply(this._pivot.computeWorldMatrix(true));
        if (drag.selection.kind === 'node') {
            const { node } = drag.selection;
            const parent = node.parent ? node.parent.computeWorldMatrix(true) : BABYLON.Matrix.Identity();
            const local = drag.world.multiply(delta).multiply(BABYLON.Matrix.Invert(parent));
            const rotation = new BABYLON.Quaternion();
            local.decompose(node.scaling, rotation, node.position);
            node.rotationQuaternion = rotation;
            drag.selection.onMoved?.();
            return local;
        }
        if (drag.selection.kind === 'bones') {
            const locals = drag.worlds.map(({ world, parentWorld }) => world.multiply(delta).multiply(BABYLON.Matrix.Invert(parentWorld)));
            drag.rows.forEach((row, index) => drag.selection.pose.setLocal(row, locals[index]));
            return locals;
        }
        const { mesh } = drag.selection;
        const positions = Float32Array.from(drag.positions);
        const point = new BABYLON.Vector3();
        drag.vertices.forEach((vertex, index) => {
            BABYLON.Vector3.TransformCoordinatesToRef(drag.drawn[index], delta, point);
            BABYLON.Vector3.TransformCoordinatesToRef(point, drag.back[index], point);
            point.toArray(positions, vertex * 3);
        });
        mesh.setVerticesData(K.PositionKind, positions, true, 3);
        const normals = this._updatedNormals(drag, positions);
        if (normals) mesh.setVerticesData(K.NormalKind, normals, true, 3);
        if (final) mesh.refreshBoundingInfo();
        return { positions, normals };
    }

    /**
     * The vertices whose normals change when some vertices move (those of the triangles the moved
     * ones are in) and the triangles around them.
     * @param {BABYLON.Mesh} mesh
     * @param {number[]} moved
     * @returns {{ normals: Float32Array | null, around: Map<number, number[]> }} normals - the normals
     *   at the start (null: the mesh has none); around - the triangles (first corner) of each vertex whose normal changes
     */
    _normalsToUpdate(mesh, moved) {
        const normals = mesh.getVerticesData(K.NormalKind);
        const indices = mesh.getIndices() ?? [];
        if (!normals || !indices.length) return { normals: null, around: new Map() };
        const movedSet = new Set(moved);
        const affected = new Set();
        for (let corner = 0; corner < indices.length; corner += 3) {
            if (movedSet.has(indices[corner]) || movedSet.has(indices[corner + 1]) || movedSet.has(indices[corner + 2])) {
                affected.add(indices[corner]).add(indices[corner + 1]).add(indices[corner + 2]);
            }
        }
        /** @type {Map<number, number[]>} */
        const around = new Map([...affected].map(vertex => [vertex, []]));
        for (let corner = 0; corner < indices.length; corner += 3) {
            for (let offset = 0; offset < 3; offset++) around.get(indices[corner + offset])?.push(corner);
        }
        return { normals: Float32Array.from(normals), around, indices };
    }

    /**
     * @param {any} drag
     * @param {Float32Array} positions the moved positions
     * @returns {Float32Array | null} the normals with those of the changed vertices made again
     */
    _updatedNormals(drag, positions) {
        if (!drag.normals) return null;
        const normals = Float32Array.from(drag.normals);
        const indices = drag.indices;
        const a = new BABYLON.Vector3(), b = new BABYLON.Vector3(), c = new BABYLON.Vector3(), sum = new BABYLON.Vector3();
        drag.around.forEach((corners, vertex) => {
            sum.setAll(0);
            for (const corner of corners) {
                a.fromArray(positions, indices[corner] * 3);
                b.fromArray(positions, indices[corner + 1] * 3);
                c.fromArray(positions, indices[corner + 2] * 3);
                // The cross product is along the face normal, twice the area long: larger faces count more
                sum.addInPlace(BABYLON.Vector3.Cross(b.subtractInPlace(a), c.subtractInPlace(a)));
            }
            if (sum.lengthSquared() === 0) return;
            sum.normalize();
            // The side the normal had (the winding may be either way round)
            const old = drag.normals[vertex * 3] * sum.x + drag.normals[vertex * 3 + 1] * sum.y + drag.normals[vertex * 3 + 2] * sum.z;
            if (old < 0) sum.scaleInPlace(-1);
            sum.toArray(normals, vertex * 3);
        });
        return normals;
    }

    /** A drag ends: the start state is put back and the change recorded as one undoable edit. */
    _end() {
        const drag = this._drag;
        if (!drag) return;
        const result = this._apply(true);
        this._drag = null;
        // A helper of the view: nothing to record
        if (drag.selection.kind === 'node') return;
        if (drag.selection.kind === 'bones') {
            const { pose } = drag.selection;
            pose.restore(drag.state);
            this._record(`Move ${drag.rows.length} bone${drag.rows.length > 1 ? 's' : ''}`,
                () => pose.capture(drag.rows),
                () => drag.rows.forEach((row, index) => pose.setLocal(row, result[index])),
                state => pose.restore(state));
            return;
        }
        const { mesh } = drag.selection;
        const write = ({ positions, normals }) => {
            mesh.setVerticesData(K.PositionKind, Float32Array.from(positions), true, 3);
            if (normals) mesh.setVerticesData(K.NormalKind, Float32Array.from(normals), true, 3);
            mesh.refreshBoundingInfo();
        };
        const start = { positions: drag.positions, normals: drag.normals };
        write(start);
        this._record(`Move ${drag.vertices.length} vertices of ${mesh.name}`, () => start, () => write(result), write);
    }
}
