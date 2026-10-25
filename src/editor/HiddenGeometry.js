/** Cells along the longest side of the grid at most (the grid takes a byte and a queue entry per cell). */
export const MAX_RESOLUTION = 256;
/** Empty cells around the model: the outside air starts there. */
const PADDING = 2;
const SURFACE = 1;
const OUTSIDE = 2;

/**
 * Finds the triangles of a mesh that the outside air never reaches: the mesh is put into a grid of
 * cells (each triangle marks the cells it passes through), the empty cells connected to the border
 * of the grid are the outside air (a flood fill, however winding the way: a spiral hole, a cavity
 * with an opening), and a triangle is on the surface when one of its cells touches the outside air.
 * The others — walls inside the solid, shells inside shells, closed voids — are hidden. Openings
 * narrower than about two cells count as closed; a triangle nearer than a cell to the surface is kept.
 */
export class HiddenGeometry {

    /**
     * @param {ArrayLike<number>} positions x, y, z per vertex
     * @param {ArrayLike<number>} indices three per triangle
     * @param {number} resolution cells along the longest side of the model
     * @returns {Uint8Array} 1 for every hidden triangle
     */
    static hiddenTriangles(positions, indices, resolution) {
        const grid = HiddenGeometry._grid(positions, Math.min(Math.max(Math.round(resolution), 8), MAX_RESOLUTION));
        const triangleCount = indices.length / 3;
        for (let triangle = 0; triangle < triangleCount; triangle++) {
            HiddenGeometry._forEachCell(grid, positions, indices, triangle, (cell) => { grid.cells[cell] = SURFACE; });
        }
        HiddenGeometry._floodOutside(grid);
        const hidden = new Uint8Array(triangleCount);
        for (let triangle = 0; triangle < triangleCount; triangle++) {
            let visible = false;
            HiddenGeometry._forEachCell(grid, positions, indices, triangle, (cell) => {
                if (!visible && HiddenGeometry._touchesOutside(grid, cell)) visible = true;
                return visible;
            });
            hidden[triangle] = visible ? 0 : 1;
        }
        return hidden;
    }

    /**
     * @param {ArrayLike<number>} positions
     * @param {number} resolution
     * @returns {{ cells: Uint8Array, size: number[], origin: number[], cell: number }} an empty grid
     *   around the positions (cubic cells, the longest side split into `resolution`)
     */
    static _grid(positions, resolution) {
        const min = [Infinity, Infinity, Infinity];
        const max = [-Infinity, -Infinity, -Infinity];
        for (let index = 0; index < positions.length; index++) {
            min[index % 3] = Math.min(min[index % 3], positions[index]);
            max[index % 3] = Math.max(max[index % 3], positions[index]);
        }
        const extent = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 1;
        const cell = extent / resolution;
        const size = [0, 1, 2].map(axis => Math.ceil((max[axis] - min[axis]) / cell) + 1 + PADDING * 2);
        const origin = [0, 1, 2].map(axis => min[axis] - PADDING * cell);
        return { cells: new Uint8Array(size[0] * size[1] * size[2]), size, origin, cell };
    }

    /**
     * Calls back with the cells a triangle passes through (points on it no farther apart than half a
     * cell); the callback stops the walk by returning true.
     * @param {ReturnType<typeof HiddenGeometry._grid>} grid
     * @param {ArrayLike<number>} positions
     * @param {ArrayLike<number>} indices
     * @param {number} triangle
     * @param {(cell: number) => boolean | void} visit
     */
    static _forEachCell(grid, positions, indices, triangle, visit) {
        const [a, b, c] = [indices[triangle * 3], indices[triangle * 3 + 1], indices[triangle * 3 + 2]];
        const corner = vertex => [positions[vertex * 3], positions[vertex * 3 + 1], positions[vertex * 3 + 2]];
        const [pa, pb, pc] = [corner(a), corner(b), corner(c)];
        const longest = Math.max(Math.hypot(...pa.map((v, i) => v - pb[i])), Math.hypot(...pb.map((v, i) => v - pc[i])), Math.hypot(...pc.map((v, i) => v - pa[i])));
        const steps = Math.max(1, Math.ceil(longest / (grid.cell * 0.5)));
        const { size, origin, cell } = grid;
        let last = -1;
        for (let i = 0; i <= steps; i++) {
            for (let j = 0; j <= steps - i; j++) {
                const u = i / steps, v = j / steps, w = 1 - u - v;
                let index = 0;
                for (let axis = 2; axis >= 0; axis--) {
                    const coordinate = pa[axis] * w + pb[axis] * u + pc[axis] * v;
                    index = index * size[axis] + Math.min(size[axis] - 1, Math.max(0, Math.floor((coordinate - origin[axis]) / cell)));
                }
                if (index === last) continue;
                last = index;
                if (visit(index)) return;
            }
        }
    }

    /**
     * Marks the empty cells connected to the border of the grid (6 neighbours) as the outside air.
     * @param {ReturnType<typeof HiddenGeometry._grid>} grid
     */
    static _floodOutside({ cells, size }) {
        const [sx, sy] = size;
        const queue = new Int32Array(cells.length);
        let head = 0;
        let tail = 0;
        // The padding corner is always empty
        cells[0] = OUTSIDE;
        queue[tail++] = 0;
        const strides = [1, sx, sx * sy];
        while (head < tail) {
            const index = queue[head++];
            const x = index % sx;
            const y = Math.floor(index / sx) % sy;
            const z = Math.floor(index / (sx * sy));
            const coordinates = [x, y, z];
            for (let axis = 0; axis < 3; axis++) {
                for (const step of [-1, 1]) {
                    const next = coordinates[axis] + step;
                    if (next < 0 || next >= size[axis]) continue;
                    const neighbour = index + step * strides[axis];
                    if (cells[neighbour] !== 0) continue;
                    cells[neighbour] = OUTSIDE;
                    queue[tail++] = neighbour;
                }
            }
        }
    }

    /**
     * @param {ReturnType<typeof HiddenGeometry._grid>} grid
     * @param {number} index a cell of a triangle
     * @returns {boolean} whether the cell or one of its 6 neighbours is outside air
     */
    static _touchesOutside({ cells, size }, index) {
        const [sx, sy] = size;
        const strides = [1, sx, sx * sy];
        const coordinates = [index % sx, Math.floor(index / sx) % sy, Math.floor(index / (sx * sy))];
        for (let axis = 0; axis < 3; axis++) {
            for (const step of [-1, 1]) {
                const next = coordinates[axis] + step;
                if (next >= 0 && next < size[axis] && cells[index + step * strides[axis]] === OUTSIDE) return true;
            }
        }
        return false;
    }
}
