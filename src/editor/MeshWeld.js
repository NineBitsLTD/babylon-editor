import * as BABYLON from '@babylonjs/core';

const K = BABYLON.VertexBuffer;

/** Vertex buffers that tell apart vertices at one position (a texture seam keeps its vertices). */
const SEAM_KINDS = [K.UVKind, K.UV2Kind, K.UV3Kind, K.UV4Kind, K.UV5Kind, K.UV6Kind, K.ColorKind];
/** Vertex buffers that are made again (normals) or no longer valid (tangents) after welding. */
const DERIVED_KINDS = [K.NormalKind, K.TangentKind];
/** The `.babylon` property of each vertex buffer kind. */
export const VERTEX_PROPERTIES = {
    [K.PositionKind]: 'positions', [K.NormalKind]: 'normals', [K.TangentKind]: 'tangents',
    [K.UVKind]: 'uvs', [K.UV2Kind]: 'uvs2', [K.UV3Kind]: 'uvs3', [K.UV4Kind]: 'uvs4', [K.UV5Kind]: 'uvs5', [K.UV6Kind]: 'uvs6',
    [K.ColorKind]: 'colors',
    [K.MatricesIndicesKind]: 'matricesIndices', [K.MatricesWeightsKind]: 'matricesWeights',
    [K.MatricesIndicesExtraKind]: 'matricesIndicesExtra', [K.MatricesWeightsExtraKind]: 'matricesWeightsExtra',
};

/**
 * The data of a morph target: how it is read and set, its `.babylon` property, its size per vertex
 * and whether different values keep vertices apart (normals are made again, tangents dropped).
 */
const TARGET_FIELDS = [
    { key: 'positions', get: 'getPositions', set: 'setPositions', stride: 3, apart: true },
    { key: 'uvs', get: 'getUVs', set: 'setUVs', stride: 2, apart: true },
    { key: 'uv2s', get: 'getUV2s', set: 'setUV2s', stride: 2, apart: true },
    { key: 'colors', get: 'getColors', set: 'setColors', stride: 4, apart: true },
];

/**
 * @param {string} kind
 * @returns {boolean} the buffer is a copy of morph target data Babylon puts on the mesh (`position0`,
 *   `normal1`, …: when the targets are not kept in textures), not data of the mesh
 */
export function isMorphKind(kind) {
    return /^(position|normal|tangent|uv|uv2|color)\d+$/.test(kind);
}

/**
 * @param {BABYLON.Mesh} mesh
 * @returns {string[]} the vertex buffer kinds of the mesh itself
 */
export function meshKinds(mesh) {
    return (mesh.getVerticesDataKinds() ?? []).filter(kind => !isMorphKind(kind));
}

/** Moves of a morph target closer than this share of the size of the mesh are one move. */
const POSITION_TOLERANCE = 1e-5;
/** Seam values (UV, color) closer than this are one value. */
const SEAM_TOLERANCE = 1e-5;

/**
 * The result of welding a mesh: its new vertex buffers by kind (no tangents), indices and
 * sub-meshes.
 * @typedef {object} WeldedMesh
 * @property {Map<string, Float32Array>} data
 * @property {number[]} indices
 * @property {{ materialIndex: number, indexStart: number, indexCount: number }[]} subMeshes
 * @property {number} vertexCount
 * @property {number} removed vertices merged away
 * @property {WeldedTarget[]} targets the morph targets, in the order of the manager
 */

/**
 * A welded morph target: its data by `.babylon` property (positions, normals, uvs, uv2s, colors).
 * @typedef {object} WeldedTarget
 * @property {Map<string, Float32Array>} data
 * @property {boolean} hadTangents its tangents are dropped
 */

/**
 * @param {ArrayLike<number>} values
 * @param {number} start
 * @param {number} size
 * @param {number} tolerance
 * @returns {string} the values rounded to the tolerance, as a key
 */
function quantize(values, start, size, tolerance) {
    let key = '';
    for (let component = 0; component < size; component++) key += `${Math.round(values[start + component] / tolerance)},`;
    return key;
}

/**
 * Merges the vertices of a mesh at one point — the same position, or no farther apart than a
 * distance (they move to the position of the first one) — (and with the same UVs and colors: texture
 * seams keep their vertices; and the same shape in every morph target: vertices a target moves
 * apart stay apart) into one, and gives every vertex a smooth normal: the area-weighted average of
 * the normals of the faces around its position (also across seams); the normals of the morph
 * targets are made the same way from their shapes. Bone influences and the other values come from
 * the first merged vertex. Triangles that become degenerate are dropped; the sub-meshes keep their
 * materials; tangents (of the mesh and of the targets) are dropped.
 */
export class MeshWeld {

    /**
     * @param {BABYLON.Mesh} mesh
     * @param {{ distance?: number }} [options] distance - points this close (in the coordinates of the
     *   vertices, as the vertex table shows them) are one point; 0 merges only points at the very same position
     * @returns {WeldedMesh}
     */
    static compute(mesh, { distance = 0 } = {}) {
        const manager = mesh.morphTargetManager;
        const targets = Array.from({ length: manager?.numTargets ?? 0 }, (_, index) => manager.getTarget(index));
        // The data of each target that is there, as Float32Arrays (loaded data may be plain arrays)
        const targetSources = targets.map(target => TARGET_FIELDS.map(field => ({ field, values: target[field.get]() })).filter(({ values }) => values?.length)
            .map(({ field, values }) => ({ field, values: Float32Array.from(values) })));
        const loaded = mesh.getVerticesData(K.PositionKind);
        const positions = loaded ? Float32Array.from(loaded) : null;
        const indices = mesh.getIndices();
        if (!positions || !indices?.length) throw new Error(`${mesh.name} has no triangles to weld`);
        const count = positions.length / 3;
        const kinds = meshKinds(mesh).filter(kind => !DERIVED_KINDS.includes(kind));
        const strides = new Map(kinds.map(kind => [kind, mesh.getVertexBuffer(kind)?.getSize() ?? K.DeduceStride(kind)]));
        // Loaded data may be plain arrays
        const sources = new Map(kinds.map(kind => [kind, Float32Array.from(mesh.getVerticesData(kind))]));
        const { minimum, maximum } = mesh.getBoundingInfo().boundingBox;
        const tolerance = Math.max(BABYLON.Vector3.Distance(minimum, maximum), 1e-9) * POSITION_TOLERANCE;

        // The position group (one point) and the welded vertex of every vertex
        const { groupOf, groupVertex } = MeshWeld._positionGroups(positions, distance);
        const vertexKeys = new Map();
        const newIndexOf = new Int32Array(count);
        const representatives = [];
        for (let vertex = 0; vertex < count; vertex++) {
            let key = `${groupOf[vertex]}`;
            for (const kind of SEAM_KINDS) {
                const values = sources.get(kind);
                if (values) key += `|${quantize(values, vertex * strides.get(kind), strides.get(kind), SEAM_TOLERANCE)}`;
            }
            for (const fields of targetSources) {
                for (const { field, values } of fields) {
                    if (!field.apart) continue;
                    // A target position counts as its move from the vertex (merged points may differ by the distance)
                    if (field.key === 'positions') {
                        key += `|${[0, 1, 2].map(axis => Math.round((values[vertex * 3 + axis] - positions[vertex * 3 + axis]) / tolerance)).join(',')}`;
                    } else {
                        key += `|${quantize(values, vertex * field.stride, field.stride, SEAM_TOLERANCE)}`;
                    }
                }
            }
            if (!vertexKeys.has(key)) {
                vertexKeys.set(key, representatives.length);
                representatives.push(vertex);
            }
            newIndexOf[vertex] = vertexKeys.get(key);
        }

        const data = new Map();
        for (const kind of kinds) {
            const stride = strides.get(kind);
            const source = sources.get(kind);
            const welded = new Float32Array(representatives.length * stride);
            representatives.forEach((vertex, index) => welded.set(source.subarray(vertex * stride, vertex * stride + stride), index * stride));
            data.set(kind, welded);
        }
        // Every vertex of a point takes the position of its first vertex (seams stay closed)
        const weldedPositions = data.get(K.PositionKind);
        representatives.forEach((vertex, index) => weldedPositions.set(positions.subarray(groupVertex[groupOf[vertex]] * 3, groupVertex[groupOf[vertex]] * 3 + 3), index * 3));

        // Triangles of each sub-mesh, without the degenerate ones
        const newIndices = [];
        const subMeshes = (mesh.subMeshes?.length ? mesh.subMeshes : [{ materialIndex: 0, indexStart: 0, indexCount: indices.length }]).map((subMesh) => {
            const indexStart = newIndices.length;
            for (let corner = subMesh.indexStart; corner < subMesh.indexStart + subMesh.indexCount; corner += 3) {
                const a = newIndexOf[indices[corner]], b = newIndexOf[indices[corner + 1]], c = newIndexOf[indices[corner + 2]];
                if (a === b || b === c || a === c) continue;
                newIndices.push(a, b, c);
            }
            return { materialIndex: subMesh.materialIndex, indexStart, indexCount: newIndices.length - indexStart };
        });

        const groups = representatives.map(vertex => groupOf[vertex]);
        const { normals, flipped } = MeshWeld._smoothNormals(mesh, data.get(K.PositionKind), newIndices, groups);
        data.set(K.NormalKind, normals);
        const weldedTargets = targets.map((target, index) => {
            const targetData = new Map();
            for (const { field, values } of targetSources[index]) {
                const welded = new Float32Array(representatives.length * field.stride);
                representatives.forEach((vertex, at) => welded.set(values.subarray(vertex * field.stride, vertex * field.stride + field.stride), at * field.stride));
                // A target position keeps its move from the vertex, now from the position of the point
                if (field.key === 'positions') {
                    representatives.forEach((vertex, at) => {
                        for (let axis = 0; axis < 3; axis++) welded[at * 3 + axis] += weldedPositions[at * 3 + axis] - positions[vertex * 3 + axis];
                    });
                }
                targetData.set(field.key, welded);
            }
            // A target with normals gets smooth normals of its own shape, on the side of those of the mesh
            if (target.hasNormals && targetData.has('positions')) {
                const targetNormals = MeshWeld._faceNormals(targetData.get('positions'), newIndices, groups);
                if (flipped) for (let at = 0; at < targetNormals.length; at++) targetNormals[at] = -targetNormals[at];
                targetData.set('normals', targetNormals);
            }
            return { data: targetData, hadTangents: !!target.hasTangents };
        });
        return { data, indices: newIndices, subMeshes, vertexCount: representatives.length, removed: count - representatives.length, targets: weldedTargets };
    }

    /**
     * Groups the vertices into points: at one position (distance 0: the same coordinates), or no
     * farther than the distance from the first vertex of a point (found through a grid of cells of
     * that size and their neighbours).
     * @param {Float32Array} positions
     * @param {number} distance
     * @returns {{ groupOf: Int32Array, groupVertex: number[] }} the point of every vertex and the first
     *   vertex of every point
     */
    static _positionGroups(positions, distance) {
        const count = positions.length / 3;
        const groupOf = new Int32Array(count);
        const groupVertex = [];
        if (!(distance > 0)) {
            const groups = new Map();
            for (let vertex = 0; vertex < count; vertex++) {
                const key = `${positions[vertex * 3]},${positions[vertex * 3 + 1]},${positions[vertex * 3 + 2]}`;
                if (!groups.has(key)) {
                    groups.set(key, groupVertex.length);
                    groupVertex.push(vertex);
                }
                groupOf[vertex] = groups.get(key);
            }
            return { groupOf, groupVertex };
        }
        /** @type {Map<string, number[]>} cell -> points whose first vertex is in it */
        const cells = new Map();
        const cellOf = value => Math.floor(value / distance);
        const squared = distance * distance;
        for (let vertex = 0; vertex < count; vertex++) {
            const x = positions[vertex * 3], y = positions[vertex * 3 + 1], z = positions[vertex * 3 + 2];
            const cx = cellOf(x), cy = cellOf(y), cz = cellOf(z);
            let found = -1;
            for (let dx = -1; dx <= 1 && found < 0; dx++) {
                for (let dy = -1; dy <= 1 && found < 0; dy++) {
                    for (let dz = -1; dz <= 1 && found < 0; dz++) {
                        for (const group of cells.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
                            const first = groupVertex[group] * 3;
                            const ex = positions[first] - x, ey = positions[first + 1] - y, ez = positions[first + 2] - z;
                            if (ex * ex + ey * ey + ez * ez <= squared) {
                                found = group;
                                break;
                            }
                        }
                    }
                }
            }
            if (found < 0) {
                found = groupVertex.length;
                groupVertex.push(vertex);
                const key = `${cx},${cy},${cz}`;
                if (!cells.has(key)) cells.set(key, []);
                cells.get(key).push(found);
            }
            groupOf[vertex] = found;
        }
        return { groupOf, groupVertex };
    }

    /**
     * Normals averaged over the faces around each position (Babylon's face normals, weighted by
     * area); turned to the side of the normals the mesh had, when it had some.
     * @param {BABYLON.Mesh} mesh
     * @param {Float32Array} positions welded
     * @param {number[]} indices welded
     * @param {number[]} groups the position group of every welded vertex
     * @returns {{ normals: Float32Array, flipped: boolean }} flipped: turned around to the old side
     */
    static _smoothNormals(mesh, positions, indices, groups) {
        const normals = MeshWeld._faceNormals(positions, indices, groups);
        // The winding of the faces may be either way round: keep the side the old normals pointed to
        const old = mesh.getVerticesData(K.NormalKind);
        if (!old) return { normals, flipped: false };
        let agreement = 0;
        const positionsOld = mesh.getVerticesData(K.PositionKind);
        const near = new Map();
        for (let vertex = 0; vertex < positionsOld.length / 3; vertex++) near.set(quantize(positionsOld, vertex * 3, 3, 1e-6), vertex);
        for (let vertex = 0; vertex < groups.length; vertex++) {
            const original = near.get(quantize(positions, vertex * 3, 3, 1e-6));
            if (original === undefined) continue;
            agreement += normals[vertex * 3] * old[original * 3] + normals[vertex * 3 + 1] * old[original * 3 + 1] + normals[vertex * 3 + 2] * old[original * 3 + 2];
        }
        const flipped = agreement < 0;
        if (flipped) for (let index = 0; index < normals.length; index++) normals[index] = -normals[index];
        return { normals, flipped };
    }

    /**
     * @param {Float32Array} positions
     * @param {number[]} indices
     * @param {number[]} groups the position group of every vertex: its normal is the one of the group
     * @returns {Float32Array} the area-weighted average of the face normals around each group
     */
    static _faceNormals(positions, indices, groups) {
        let groupCount = 0;
        for (const group of groups) groupCount = Math.max(groupCount, group + 1);
        const sums = new Float32Array(groupCount * 3);
        const a = new BABYLON.Vector3(), b = new BABYLON.Vector3(), c = new BABYLON.Vector3();
        for (let corner = 0; corner < indices.length; corner += 3) {
            a.fromArray(positions, indices[corner] * 3);
            b.fromArray(positions, indices[corner + 1] * 3);
            c.fromArray(positions, indices[corner + 2] * 3);
            // The cross product is twice the area along the face normal: larger faces count more
            const face = BABYLON.Vector3.Cross(b.subtract(a), c.subtract(a));
            for (const index of [indices[corner], indices[corner + 1], indices[corner + 2]]) {
                const group = groups[index];
                sums[group * 3] += face.x;
                sums[group * 3 + 1] += face.y;
                sums[group * 3 + 2] += face.z;
            }
        }
        const normals = new Float32Array(groups.length * 3);
        const normal = new BABYLON.Vector3();
        groups.forEach((group, vertex) => {
            normal.fromArray(sums, group * 3).normalize();
            normal.toArray(normals, vertex * 3);
        });
        return normals;
    }
}
