import * as BABYLON from '@babylonjs/core';

/** Vertex buffer of each texture coordinates index (`texture.coordinatesIndex`). */
const UV_KINDS = [
    BABYLON.VertexBuffer.UVKind,
    BABYLON.VertexBuffer.UV2Kind,
    BABYLON.VertexBuffer.UV3Kind,
    BABYLON.VertexBuffer.UV4Kind,
    BABYLON.VertexBuffer.UV5Kind,
    BABYLON.VertexBuffer.UV6Kind,
];

/**
 * Triangles of a mesh drawn with a texture: `count` indices from `start` (all vertices in order
 * for a mesh without indices).
 * @typedef {object} UvPart
 * @property {BABYLON.FloatArray} uvs
 * @property {BABYLON.IndicesArray | null} indices
 * @property {number} start
 * @property {number} count
 */

/**
 * How a layout is drawn.
 * @typedef {object} UvLayoutStyle
 * @property {string} line color of the triangle edges
 * @property {string} shade color laid over the image where no triangle maps it
 * @property {number} [lineWidth] defaults to one pixel per 1024 pixels of the image
 */

/** @type {UvLayoutStyle} */
export const DEFAULT_UV_STYLE = { line: '#00e5ff', shade: 'rgba(0, 0, 0, 0.5)' };

/**
 * The UV layout of a texture: the triangles of the meshes drawn with it, at their texture
 * coordinates, as an image of the texture's size with a transparent background, so it can be laid
 * over the texture (in the inspector, or in an image editor); the image areas no triangle maps are
 * shaded.
 *
 * The coordinates are those of the vertex buffer the texture reads (`coordinatesIndex`); the texture
 * transform (scale, offset, angles) is not applied. A triangle outside the 0..1 range (a repeated
 * texture) is moved into it by whole tiles.
 */
export class UvLayout {

    /**
     * @param {BABYLON.BaseTexture} texture
     * @param {BABYLON.AssetContainer} container
     * @returns {UvPart[]}
     */
    static parts(texture, container) {
        const kind = UV_KINDS[texture.coordinatesIndex ?? 0] ?? BABYLON.VertexBuffer.UVKind;
        /** @type {UvPart[]} */
        const parts = [];
        for (const mesh of container.meshes) {
            // Instances draw the triangles of their source mesh
            if (!(mesh instanceof BABYLON.Mesh) || !mesh.material) continue;
            const uvs = mesh.getVerticesData(kind);
            if (!uvs?.length) continue;
            const indices = mesh.getIndices();
            const total = indices?.length ?? uvs.length / 2;
            if (mesh.material instanceof BABYLON.MultiMaterial) {
                for (const subMesh of mesh.subMeshes ?? []) {
                    if (mesh.material.subMaterials[subMesh.materialIndex]?.hasTexture(texture)) {
                        parts.push({ uvs, indices, start: subMesh.indexStart, count: subMesh.indexCount });
                    }
                }
            } else if (mesh.material.hasTexture(texture)) {
                parts.push({ uvs, indices, start: 0, count: total });
            }
        }
        return parts;
    }

    /**
     * Text that changes when the layout changes (the coordinates are summed, not compared).
     * @param {UvPart[]} parts
     * @returns {string}
     */
    static signature(parts) {
        return parts.map(({ uvs, start, count }) => {
            let sum = 0;
            for (let index = 0; index < uvs.length; index++) sum += uvs[index] * ((index % 7) + 1);
            return `${uvs.length}:${start}:${count}:${sum}`;
        }).join('|');
    }

    /**
     * @param {UvPart[]} parts
     * @param {number} width
     * @param {number} height
     * @param {boolean} invertY the image is uploaded upside down (its top row is v = 1)
     * @param {UvLayoutStyle} [style]
     * @returns {HTMLCanvasElement}
     */
    static render(parts, width, height, invertY, style = DEFAULT_UV_STYLE) {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        const triangles = UvLayout._path(parts, width, height, invertY);
        context.fillStyle = style.shade;
        context.fillRect(0, 0, width, height);
        // The triangles cut the shade out: covered areas stay transparent
        context.globalCompositeOperation = 'destination-out';
        context.fill(triangles);
        context.globalCompositeOperation = 'source-over';
        context.lineJoin = 'round';
        context.lineWidth = style.lineWidth ?? Math.max(1, Math.round(Math.max(width, height) / 1024));
        context.strokeStyle = style.line;
        context.stroke(triangles);
        return canvas;
    }

    /**
     * All triangles as one path, each wound the same way, so the nonzero fill covers overlapping
     * triangles (opposite windings would cancel out).
     * @param {UvPart[]} parts
     * @param {number} width
     * @param {number} height
     * @param {boolean} invertY
     * @returns {Path2D}
     */
    static _path(parts, width, height, invertY) {
        const path = new Path2D();
        const u = new Float64Array(3);
        const v = new Float64Array(3);
        for (const { uvs, indices, start, count } of parts) {
            for (let offset = start; offset + 2 < start + count; offset += 3) {
                for (let corner = 0; corner < 3; corner++) {
                    const vertex = indices ? indices[offset + corner] : offset + corner;
                    u[corner] = uvs[vertex * 2];
                    v[corner] = uvs[vertex * 2 + 1];
                }
                // A repeated texture: the triangle is moved into the first tile
                const tileU = Math.floor(Math.min(u[0], u[1], u[2]));
                const tileV = Math.floor(Math.min(v[0], v[1], v[2]));
                const x = corner => (u[corner] - tileU) * width;
                const y = corner => (invertY ? 1 - (v[corner] - tileV) : v[corner] - tileV) * height;
                const area = (x(1) - x(0)) * (y(2) - y(0)) - (x(2) - x(0)) * (y(1) - y(0));
                const order = area < 0 ? [0, 2, 1] : [0, 1, 2];
                path.moveTo(x(order[0]), y(order[0]));
                path.lineTo(x(order[1]), y(order[1]));
                path.lineTo(x(order[2]), y(order[2]));
                path.closePath();
            }
        }
        return path;
    }
}
