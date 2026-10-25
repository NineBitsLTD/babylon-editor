import * as BABYLON from '@babylonjs/core';

/** Size in render pixels of the cells triangles are sorted into for the visibility test. */
const CELL = 32;
/** A vertex is hidden by a triangle nearer than this share of its depth. */
const DEPTH_TOLERANCE = 1e-3;

/**
 * A rectangle of the canvas in CSS pixels.
 * @typedef {{ left: number, top: number, right: number, bottom: number }} ScreenRect
 */

/**
 * Where the vertices of a mesh are drawn on the screen of a camera.
 * @typedef {object} ProjectedMesh
 * @property {BABYLON.AbstractMesh} mesh
 * @property {Float32Array} screen x, y in render pixels and the inverse of the view depth (1 / w) per vertex
 */

/**
 * @param {BABYLON.Scene} scene
 * @returns {{ camera: BABYLON.Camera, viewport: BABYLON.Viewport, renderHeight: number, transform: BABYLON.Matrix, scale: number } | null}
 *   the camera of the view under the pointer and how it projects (render pixels; scale: CSS to render)
 */
function projection(scene) {
    const camera = scene.cameraToUseForPointers ?? scene.activeCamera;
    if (!camera) return null;
    const engine = scene.getEngine();
    return {
        camera,
        viewport: camera.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight()),
        renderHeight: engine.getRenderHeight(),
        transform: camera.getTransformationMatrix(),
        scale: engine.getHardwareScalingLevel(),
    };
}

/**
 * Picks vertices and bones on the screen, as they are drawn (skinned, posed): what lies in a
 * rectangle, and which vertices no triangle in front hides.
 */
export class ScreenSelection {

    /**
     * @param {BABYLON.AbstractMesh} mesh
     * @returns {Float32Array | null} the world positions of its vertices where the skin draws them
     */
    static drawnPositions(mesh) {
        if (!mesh.getTotalVertices()) return null;
        mesh.skeleton?.prepare(true);
        const local = mesh.getPositionData(true, true);
        if (!local) return null;
        const world = mesh.getWorldMatrix();
        const result = new Float32Array(local.length);
        const point = new BABYLON.Vector3();
        for (let vertex = 0; vertex < local.length / 3; vertex++) {
            BABYLON.Vector3.TransformCoordinatesFromFloatsToRef(local[vertex * 3], local[vertex * 3 + 1], local[vertex * 3 + 2], world, point);
            point.toArray(result, vertex * 3);
        }
        return result;
    }

    /**
     * @param {Float32Array} positions world positions
     * @param {ReturnType<typeof projection>} view
     * @returns {Float32Array} x, y (render pixels) and 1 / w per vertex; behind the camera: w ≤ 0 → 1 / w ≤ 0
     */
    static _project(positions, view) {
        const m = view.transform.m;
        // Babylon's viewports count from the bottom of the canvas, the pointer from the top
        const { x: left, y: bottom, width, height } = view.viewport;
        const top = view.renderHeight - bottom - height;
        const screen = new Float32Array(positions.length);
        for (let vertex = 0; vertex < positions.length / 3; vertex++) {
            const x = positions[vertex * 3], y = positions[vertex * 3 + 1], z = positions[vertex * 3 + 2];
            const cx = x * m[0] + y * m[4] + z * m[8] + m[12];
            const cy = x * m[1] + y * m[5] + z * m[9] + m[13];
            const cw = x * m[3] + y * m[7] + z * m[11] + m[15];
            const inverse = cw !== 0 ? 1 / cw : 0;
            screen[vertex * 3] = left + (cx * inverse + 1) * 0.5 * width;
            screen[vertex * 3 + 1] = top + (1 - cy * inverse) * 0.5 * height;
            screen[vertex * 3 + 2] = inverse;
        }
        return screen;
    }

    /**
     * The vertices of a mesh drawn inside a rectangle of the canvas; with occluders, only those no
     * triangle of them hides (as the solid and textured views draw them).
     * @param {BABYLON.Scene} scene
     * @param {BABYLON.AbstractMesh} mesh
     * @param {ScreenRect} rect CSS pixels of the canvas
     * @param {BABYLON.AbstractMesh[] | null} occluders the meshes whose triangles hide vertices, or null
     * @returns {number[]}
     */
    static verticesInRect(scene, mesh, rect, occluders) {
        const view = projection(scene);
        const positions = ScreenSelection.drawnPositions(mesh);
        if (!view || !positions) return [];
        const screen = ScreenSelection._project(positions, view);
        const [left, top, right, bottom] = [rect.left, rect.top, rect.right, rect.bottom].map(value => value / view.scale);
        const inside = [];
        for (let vertex = 0; vertex < screen.length / 3; vertex++) {
            const x = screen[vertex * 3], y = screen[vertex * 3 + 1], inverse = screen[vertex * 3 + 2];
            if (inverse > 0 && x >= left && x <= right && y >= top && y <= bottom) inside.push(vertex);
        }
        if (!occluders || !inside.length) return inside;
        const grid = ScreenSelection._occluderGrid(mesh, screen, occluders, view);
        return inside.filter(vertex => !ScreenSelection._hidden(grid, mesh, positions, screen, vertex));
    }

    /**
     * The vertex of a mesh drawn nearest to a point of the canvas, within a radius; with occluders,
     * only vertices no triangle of them hides count (as the solid and textured views draw them).
     * Of copies at one position (flat shading) the first one.
     * @param {BABYLON.Scene} scene
     * @param {BABYLON.AbstractMesh} mesh
     * @param {number} x CSS pixels of the canvas
     * @param {number} y
     * @param {number} radius CSS pixels
     * @param {BABYLON.AbstractMesh[] | null} occluders the meshes whose triangles hide vertices, or null
     * @returns {number} the vertex, or -1
     */
    static nearestVertex(scene, mesh, x, y, radius, occluders) {
        return ScreenSelection._nearest(scene, mesh, x, y, radius, occluders)?.vertex ?? -1;
    }

    /**
     * The vertex drawn nearest to a point of the canvas among several meshes (as nearestVertex).
     * @param {BABYLON.Scene} scene
     * @param {BABYLON.AbstractMesh[]} meshes
     * @param {number} x CSS pixels of the canvas
     * @param {number} y
     * @param {number} radius CSS pixels
     * @param {BABYLON.AbstractMesh[] | null} occluders
     * @returns {{ mesh: BABYLON.AbstractMesh, vertex: number } | null}
     */
    static nearestVertexIn(scene, meshes, x, y, radius, occluders) {
        let best = null;
        for (const mesh of meshes) {
            const found = ScreenSelection._nearest(scene, mesh, x, y, radius, occluders);
            if (found && (!best || found.distance < best.distance)) best = { mesh, ...found };
        }
        return best && { mesh: best.mesh, vertex: best.vertex };
    }

    /**
     * @returns {{ vertex: number, distance: number } | null} the nearest vertex no occluder hides and its distance (render pixels)
     */
    static _nearest(scene, mesh, x, y, radius, occluders) {
        const view = projection(scene);
        const positions = ScreenSelection.drawnPositions(mesh);
        if (!view || !positions) return null;
        const screen = ScreenSelection._project(positions, view);
        const [px, py, reach] = [x / view.scale, y / view.scale, radius / view.scale];
        const near = [];
        for (let vertex = 0; vertex < screen.length / 3; vertex++) {
            const distance = Math.hypot(screen[vertex * 3] - px, screen[vertex * 3 + 1] - py);
            if (screen[vertex * 3 + 2] > 0 && distance <= reach) near.push({ vertex, distance });
        }
        if (!near.length) return null;
        // Nearest to the pointer first; the visibility test is made only until one passes
        near.sort((a, b) => a.distance - b.distance || a.vertex - b.vertex);
        if (!occluders) return near[0];
        const grid = ScreenSelection._occluderGrid(mesh, screen, occluders, view);
        return near.find(({ vertex }) => !ScreenSelection._hidden(grid, mesh, positions, screen, vertex)) ?? null;
    }

    /**
     * The bones of a skeleton whose joint is drawn inside a rectangle of the canvas.
     * @param {BABYLON.Scene} scene
     * @param {BABYLON.Skeleton} skeleton
     * @param {BABYLON.AbstractMesh | null} mesh a mesh it deforms (the space of bones without linked nodes)
     * @param {ScreenRect} rect
     * @returns {BABYLON.Bone[]}
     */
    static bonesInRect(scene, skeleton, mesh, rect) {
        const view = projection(scene);
        if (!view) return [];
        const joints = new Float32Array(skeleton.bones.length * 3);
        skeleton.bones.forEach((bone, index) => {
            const node = bone.getTransformNode();
            const position = node ? node.getAbsolutePosition() : bone.getAbsolutePosition(mesh ?? undefined);
            position.toArray(joints, index * 3);
        });
        const screen = ScreenSelection._project(joints, view);
        const [left, top, right, bottom] = [rect.left, rect.top, rect.right, rect.bottom].map(value => value / view.scale);
        return skeleton.bones.filter((_, index) => {
            const x = screen[index * 3], y = screen[index * 3 + 1];
            return screen[index * 3 + 2] > 0 && x >= left && x <= right && y >= top && y <= bottom;
        });
    }

    /**
     * @param {BABYLON.AbstractMesh} mesh the mesh whose vertices are tested
     * @param {Float32Array} screen its projected vertices
     * @param {BABYLON.AbstractMesh[]} occluders
     * @param {ReturnType<typeof projection>} view
     * @returns {ReturnType<typeof ScreenSelection._triangleGrid>} the triangles of the occluders on the screen
     */
    static _occluderGrid(mesh, screen, occluders, view) {
        return ScreenSelection._triangleGrid(occluders.map(occluder => (occluder === mesh ? { mesh, screen }
            : { mesh: occluder, screen: ScreenSelection._project(ScreenSelection.drawnPositions(occluder) ?? new Float32Array(), view) })));
    }

    /**
     * The triangles of meshes sorted into the screen cells their bounds cover.
     * @param {{ mesh: BABYLON.AbstractMesh, screen: Float32Array }[]} projected
     * @returns {Map<string, { mesh: BABYLON.AbstractMesh, screen: Float32Array, a: number, b: number, c: number }[]>}
     */
    static _triangleGrid(projected) {
        const grid = new Map();
        for (const { mesh, screen } of projected) {
            const indices = mesh.getIndices();
            if (!indices || !screen.length) continue;
            for (let corner = 0; corner < indices.length; corner += 3) {
                const a = indices[corner], b = indices[corner + 1], c = indices[corner + 2];
                // Triangles reaching behind the camera are left out
                if (screen[a * 3 + 2] <= 0 || screen[b * 3 + 2] <= 0 || screen[c * 3 + 2] <= 0) continue;
                const xs = [screen[a * 3], screen[b * 3], screen[c * 3]];
                const ys = [screen[a * 3 + 1], screen[b * 3 + 1], screen[c * 3 + 1]];
                const triangle = { mesh, screen, a, b, c };
                for (let cx = Math.floor(Math.min(...xs) / CELL); cx <= Math.floor(Math.max(...xs) / CELL); cx++) {
                    for (let cy = Math.floor(Math.min(...ys) / CELL); cy <= Math.floor(Math.max(...ys) / CELL); cy++) {
                        const key = `${cx},${cy}`;
                        if (!grid.has(key)) grid.set(key, []);
                        grid.get(key).push(triangle);
                    }
                }
            }
        }
        return grid;
    }

    /**
     * Whether a triangle drawn over the vertex is nearer to the camera than it (its own triangles,
     * and triangles through its position, do not hide it).
     * @param {Map<string, any[]>} grid
     * @param {BABYLON.AbstractMesh} mesh
     * @param {Float32Array} positions world positions of the mesh
     * @param {Float32Array} screen
     * @param {number} vertex
     * @returns {boolean}
     */
    static _hidden(grid, mesh, positions, screen, vertex) {
        const x = screen[vertex * 3], y = screen[vertex * 3 + 1], inverse = screen[vertex * 3 + 2];
        const depth = 1 / inverse;
        for (const triangle of grid.get(`${Math.floor(x / CELL)},${Math.floor(y / CELL)}`) ?? []) {
            const { screen: s, a, b, c } = triangle;
            if (triangle.mesh === mesh && (a === vertex || b === vertex || c === vertex)) continue;
            // Barycentric coordinates of the point in the triangle on the screen
            const x0 = s[a * 3], y0 = s[a * 3 + 1], x1 = s[b * 3], y1 = s[b * 3 + 1], x2 = s[c * 3], y2 = s[c * 3 + 1];
            const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
            if (Math.abs(area) < 1e-9) continue;
            const u = ((x1 - x) * (y2 - y) - (x2 - x) * (y1 - y)) / area;
            const v = ((x2 - x) * (y0 - y) - (x0 - x) * (y2 - y)) / area;
            const w = 1 - u - v;
            if (u < 0 || v < 0 || w < 0) continue;
            // 1 / depth is linear on the screen
            const triangleDepth = 1 / (u * s[a * 3 + 2] + v * s[b * 3 + 2] + w * s[c * 3 + 2]);
            if (triangleDepth < depth * (1 - DEPTH_TOLERANCE)) {
                // A triangle through the position of the vertex (a copy of it, welded later) does not hide it
                if (triangle.mesh === mesh && [a, b, c].some(corner => positions[corner * 3] === positions[vertex * 3]
                    && positions[corner * 3 + 1] === positions[vertex * 3 + 1] && positions[corner * 3 + 2] === positions[vertex * 3 + 2])) continue;
                return true;
            }
        }
        return false;
    }
}
