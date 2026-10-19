import * as BABYLON from '@babylonjs/core';
import { determineMimeType } from '../utils/determineMimeType';
import { toBase64Url } from '../utils/toBase64Url';
import { DEFAULT_UV_STYLE, UvLayout } from './UvLayout';

/**
 * The bytes of an image file and their type.
 * @typedef {object} ImageBytes
 * @property {Uint8Array} bytes
 * @property {string} mimeType
 */

/** Image types the canvas can write; a replaced image of another type becomes a PNG. */
const ENCODABLE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

/** File extension per image type. */
const EXTENSIONS = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/bmp': 'bmp',
};

/** Largest side of the UV layout laid over the preview (the copied layout has the texture size). */
const OVERLAY_SIZE = 1024;

/** Preset colors of the UV layout lines: cyan and its inverse. */
const UV_COLORS = [
    { value: DEFAULT_UV_STYLE.line, label: 'Cyan' },
    { value: '#ff1a00', label: 'Inverted cyan (red)' },
];

/** Images the browser can decode (a replacement is drawn onto a canvas). */
const OPEN_FILTERS = { Images: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] };

/** @type {WeakMap<BABYLON.BaseTexture, Promise<string | null>>} previews read from the GPU */
const texturePreviews = new WeakMap();

/**
 * Url of an image showing a texture: its file, its embedded image as a data url, or (for images
 * of glTF buffers, whose `data:<file>#image0` url cannot be loaded) its pixels read from the GPU.
 * @param {BABYLON.BaseTexture} texture
 * @returns {string | null | Promise<string | null>}
 */
export function texturePreview(texture) {
    const url = texture instanceof BABYLON.Texture ? texture.url : null;
    if (url && (!url.startsWith('data:') || url.startsWith('data:image/'))) return url;
    if (!texturePreviews.has(texture)) texturePreviews.set(texture, readTexturePixels(texture));
    return texturePreviews.get(texture);
}

/**
 * @param {BABYLON.BaseTexture} texture
 * @returns {Promise<string | null>} the pixels of a 2D texture as a PNG data url
 */
async function readTexturePixels(texture) {
    if (texture.isCube || !texture.isReady()) return null;
    const { width, height } = texture.getSize();
    const pixels = await texture.readPixels();
    if (!pixels || !width || !height) return null;
    const bytes = pixels instanceof Uint8Array ? pixels : Uint8Array.from(pixels, value => Math.round(Math.min(1, Math.max(0, value)) * 255));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    context.putImageData(new ImageData(new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, width * height * 4), width, height), 0, 0);
    // Textures uploaded with inverted Y come back bottom row first
    if (texture.invertY) {
        const flipped = document.createElement('canvas');
        flipped.width = width;
        flipped.height = height;
        const flippedContext = flipped.getContext('2d');
        flippedContext.scale(1, -1);
        flippedContext.drawImage(canvas, 0, -height);
        return flipped.toDataURL();
    }
    return canvas.toDataURL();
}

/**
 * @param {Uint8Array} bytes
 * @param {string | null} [fallback] type to use when the content does not tell it (e.g. from the file extension)
 * @returns {string | null} the image type of the bytes
 */
function imageTypeOf(bytes, fallback = null) {
    const sniffed = determineMimeType(bytes);
    if (sniffed?.startsWith('image/')) return sniffed;
    if (bytes[0] === 0x42 && bytes[1] === 0x4D) return 'image/bmp';
    return fallback?.startsWith('image/') ? fallback : null;
}

/**
 * @param {string} fileName
 * @returns {string | null} the image type of a file name
 */
function imageTypeOfName(fileName) {
    const extension = fileName.split(/[?#]/)[0].split('.').pop()?.toLowerCase();
    if (extension === 'jpeg') return 'image/jpeg';
    return Object.keys(EXTENSIONS).find(type => EXTENSIONS[type] === extension) ?? null;
}

/**
 * The image of a texture as file bytes: the embedded or external image itself, or the pixels
 * read from the GPU as a PNG.
 * @param {BABYLON.BaseTexture} texture
 * @returns {Promise<ImageBytes>}
 */
async function readTextureImage(texture) {
    const source = await texturePreview(texture);
    if (!source) throw new Error('The texture has no image to read (it is not loaded or not a 2D image)');
    const response = await fetch(source);
    if (!response.ok) throw new Error(`The image of the texture cannot be read (${response.status})`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const mimeType = imageTypeOf(bytes, response.headers.get('content-type') || imageTypeOfName(source));
    return { bytes, mimeType: mimeType ?? 'application/octet-stream' };
}

/**
 * Image data from the text of the clipboard: a data url or bare base64.
 * @param {string} text
 * @returns {ImageBytes | null}
 */
function parseImageText(text) {
    const trimmed = (text ?? '').trim();
    const dataUrl = /^data:([^;,]*)(;[^,]*)?,(.*)$/s.exec(trimmed);
    const base64 = (dataUrl ? dataUrl[3] : trimmed).replace(/\s+/g, '');
    if (!base64 || (dataUrl && !dataUrl[2]?.includes('base64')) || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(base64)) return null;
    let bytes;
    try {
        bytes = Uint8Array.from(atob(base64.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
    } catch {
        return null;
    }
    const mimeType = imageTypeOf(bytes, dataUrl?.[1] || null);
    return mimeType ? { bytes, mimeType } : null;
}

/**
 * @param {ImageBytes} image
 * @returns {Promise<ImageBitmap>}
 */
async function decodeImage({ bytes, mimeType }) {
    try {
        return await createImageBitmap(new Blob([bytes], { type: mimeType }));
    } catch {
        throw new Error('The image cannot be read: use a PNG, JPEG, WebP, GIF or BMP image');
    }
}

/**
 * @param {ImageBitmap} bitmap
 * @param {number} width
 * @param {number} height
 * @returns {HTMLCanvasElement} the image stretched to the size
 */
function drawImage(bitmap, width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
    return canvas;
}

/**
 * An image as a data url of the given size and type: stretched to the size, so the UV mapping of
 * the texture stays right; written as is when it already has them.
 * @param {ImageBytes} image
 * @param {{ width: number, height: number }} size 0 keeps the size of the image
 * @param {string} mimeType type to write; types the canvas cannot write become PNG
 * @returns {Promise<string>}
 */
async function fitImage(image, size, mimeType) {
    const bitmap = await decodeImage(image);
    try {
        const width = size.width || bitmap.width;
        const height = size.height || bitmap.height;
        const type = ENCODABLE_TYPES.has(mimeType) ? mimeType : 'image/png';
        if (width === bitmap.width && height === bitmap.height && image.mimeType === type) return toBase64Url(image.bytes, type);
        const dataUrl = drawImage(bitmap, width, height).toDataURL(type, 0.92);
        // A browser that cannot write the type returns a PNG
        return dataUrl.startsWith(`data:${type}`) ? dataUrl : drawImage(bitmap, width, height).toDataURL('image/png');
    } finally {
        bitmap.close();
    }
}

/**
 * @param {ImageBytes} image
 * @returns {Promise<Blob>} the image as a PNG (the only image type the clipboard takes)
 */
async function toPngBlob(image) {
    if (image.mimeType === 'image/png') return new Blob([image.bytes], { type: 'image/png' });
    const bitmap = await decodeImage(image);
    try {
        return await canvasToPng(drawImage(bitmap, bitmap.width, bitmap.height));
    } finally {
        bitmap.close();
    }
}

/**
 * @param {Blob} blob
 */
async function writeClipboardImage(blob) {
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
}

/**
 * @param {HTMLCanvasElement} canvas
 * @returns {Promise<Blob>}
 */
function canvasToPng(canvas) {
    return new Promise((resolve, reject) => canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('The image cannot be converted to PNG'))), 'image/png'));
}

/**
 * @param {BABYLON.BaseTexture} texture
 * @returns {{ width: number, height: number }} the size of the texture image (1024 × 1024 while unknown)
 */
function textureSize(texture) {
    const { width, height } = texture.getSize();
    return width && height ? { width, height } : { width: 1024, height: 1024 };
}

/**
 * Commands of the image of a texture (the menu of its preview in the inspector): save it to a
 * file, replace it with a file or the clipboard, copy it as an image or as a base64 data url,
 * show its UV layout over the preview and copy the layout as an image.
 * Embedded images are decoded to their bytes for every command but "Copy base64"; a replacement
 * is stretched to the size of the texture and written in its type.
 */
export class TextureImage {

    /**
     * @param {object} options
     * @param {import('./HostRequests').HostRequests} options.host file dialogs, text clipboard, messages
     * @param {(texture: BABYLON.Texture, dataUrl: string) => void} options.replace puts a new image into
     *   the texture (an undoable edit)
     * @param {() => BABYLON.AssetContainer | null} options.container the loaded model (its meshes give the UV layout)
     * @param {string} [options.uvColor] color of the UV layout lines chosen before (defaults to cyan)
     * @param {(color: string) => void} [options.onUvColorChange] keeps a chosen color for the next sessions
     * @param {boolean} [options.showUv] the UV layout was shown before
     * @param {(shown: boolean) => void} [options.onShowUvChange] keeps the choice for the next sessions
     */
    constructor({ host, replace, container, uvColor, onUvColorChange, showUv, onShowUvChange }) {
        this._host = host;
        this._replaceImage = replace;
        this._container = container;
        /** The UV layout is laid over the previews (of every texture). */
        this._showUv = showUv === true;
        this._onShowUvChange = onShowUvChange;
        /** Color of the UV layout lines (the shown and the copied layout). */
        this._uvColor = /^#[0-9a-f]{6}$/i.test(uvColor ?? '') ? uvColor : DEFAULT_UV_STYLE.line;
        this._onUvColorChange = onUvColorChange;
        /** @type {WeakMap<BABYLON.BaseTexture, { signature: string, url: string | null }>} rendered overlays */
        this._overlays = new WeakMap();
    }

    /**
     * The UV layout laid over the preview of a texture, while it is shown.
     * @param {BABYLON.BaseTexture} texture
     * @returns {string | null} a PNG data url, or null when hidden or no mesh uses the texture
     */
    uvOverlay(texture) {
        const container = this._container();
        if (!this._showUv || !container) return null;
        const parts = UvLayout.parts(texture, container);
        const { width, height } = textureSize(texture);
        const signature = `${width}x${height}:${texture.invertY}:${this._uvColor}:${UvLayout.signature(parts)}`;
        const cached = this._overlays.get(texture);
        if (cached?.signature === signature) return cached.url;
        const scale = Math.min(1, OVERLAY_SIZE / Math.max(width, height));
        const url = parts.length
            ? UvLayout.render(parts, Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)), texture.invertY, this._uvStyle()).toDataURL('image/png')
            : null;
        this._overlays.set(texture, { signature, url });
        return url;
    }

    /**
     * @param {BABYLON.BaseTexture} texture
     * @param {() => string} label shown name of the texture (names a saved file of an embedded image)
     * @returns {import('./PropertyPanel').PanelAction[]}
     */
    actions(texture, label) {
        const run = command => () => { this._run(command); };
        return [
            { label: 'Save to disk…', title: 'Save the image to a file', icon: 'save', transient: true, run: run(() => this.save(texture, label())) },
            { label: 'Replace from disk…', title: 'Replace the image with a file (stretched to the texture size)', icon: 'folder-opened', run: run(() => this.chooseFile(texture)) },
            { label: 'Copy image', title: 'Copy the image to the clipboard (as PNG)', icon: 'copy', transient: true, run: run(() => this.copyImage(texture)) },
            { label: 'Copy base64', title: 'Copy the image as a base64 data url', icon: 'symbol-string', transient: true, run: run(() => this.copyBase64(texture)) },
            { label: 'Paste from clipboard', title: 'Replace the image with the image or base64 data in the clipboard (stretched to the texture size)', icon: 'clippy', run: run(() => this.paste(texture)) },
            {
                label: () => (this._showUv ? 'Hide UV layout' : 'Show UV layout'),
                title: 'Show the triangles of the meshes using the texture over the preview; areas no triangle maps are shaded',
                icon: () => (this._showUv ? 'eye-closed' : 'eye'),
                transient: true,
                run: () => {
                    this._showUv = !this._showUv;
                    this._onShowUvChange?.(this._showUv);
                },
                colors: UV_COLORS,
                color: () => this._uvColor,
                setColor: (color) => {
                    this._uvColor = color;
                    this._onUvColorChange?.(color);
                },
            },
            { label: 'Copy UV layout', title: 'Copy the UV layout as a PNG of the texture size with a transparent background, to lay over the texture in an image editor', icon: 'copy', transient: true, run: run(() => this.copyUvLayout(texture)) },
        ];
    }

    /**
     * @param {BABYLON.BaseTexture} texture
     * @param {string} label
     */
    async save(texture, label) {
        const image = await readTextureImage(texture);
        const extension = EXTENSIONS[image.mimeType] ?? 'bin';
        await this._host.request('saveFile', {
            data: image.bytes.slice().buffer,
            fileName: TextureImage._fileName(texture.name, label, extension),
            filters: { Image: [extension] },
        });
    }

    /**
     * @param {BABYLON.BaseTexture} texture
     */
    async chooseFile(texture) {
        const file = await this._host.request('openFile', { filters: OPEN_FILTERS });
        if (!file) return;
        const bytes = new Uint8Array(file.data);
        const mimeType = imageTypeOf(bytes, imageTypeOfName(file.fileName));
        if (!mimeType) throw new Error(`${file.fileName} is not an image`);
        await this._replace(texture, { bytes, mimeType });
    }

    /**
     * @param {BABYLON.BaseTexture} texture
     */
    async copyImage(texture) {
        await writeClipboardImage(await toPngBlob(await readTextureImage(texture)));
    }

    /**
     * @param {BABYLON.BaseTexture} texture
     */
    async copyUvLayout(texture) {
        const container = this._container();
        const parts = container ? UvLayout.parts(texture, container) : [];
        if (!parts.length) throw new Error('No mesh with texture coordinates uses this texture');
        const { width, height } = textureSize(texture);
        await writeClipboardImage(await canvasToPng(UvLayout.render(parts, width, height, texture.invertY, this._uvStyle())));
    }

    /**
     * @returns {import('./UvLayout').UvLayoutStyle}
     */
    _uvStyle() {
        return { ...DEFAULT_UV_STYLE, line: this._uvColor };
    }

    /**
     * @param {BABYLON.BaseTexture} texture
     */
    async copyBase64(texture) {
        const image = await readTextureImage(texture);
        await this._host.request('writeClipboard', { text: toBase64Url(image.bytes, image.mimeType) });
    }

    /**
     * @param {BABYLON.BaseTexture} texture
     */
    async paste(texture) {
        const image = await this._readClipboard();
        if (!image) throw new Error('The clipboard has no image and no base64 image data');
        await this._replace(texture, image);
    }

    /**
     * An image of the clipboard, or image data in its text (a data url or bare base64).
     * @returns {Promise<ImageBytes | null>}
     */
    async _readClipboard() {
        try {
            for (const item of await navigator.clipboard.read()) {
                const type = item.types.find(candidate => candidate.startsWith('image/'));
                if (!type) continue;
                const bytes = new Uint8Array(await (await item.getType(type)).arrayBuffer());
                return { bytes, mimeType: imageTypeOf(bytes, type) ?? type };
            }
        } catch (error) {
            // Reading images can be denied: the text of the clipboard is still read through the host
            console.warn('[BabylonEditor] The clipboard images cannot be read', error);
        }
        return parseImageText(await this._host.request('readClipboard'));
    }

    /**
     * @param {BABYLON.BaseTexture} texture
     * @param {ImageBytes} image
     */
    async _replace(texture, image) {
        if (!(texture instanceof BABYLON.Texture)) throw new Error('Only the image of a 2D texture can be replaced');
        // The new image takes the size and the type of the current one
        const current = await readTextureImage(texture).catch(() => null);
        const dataUrl = await fitImage(image, texture.getSize(), current?.mimeType ?? image.mimeType);
        this._replaceImage(texture, dataUrl);
    }

    /**
     * Runs a command; its errors are shown by VS Code.
     * @param {() => Promise<void>} command
     */
    async _run(command) {
        try {
            await command();
        } catch (error) {
            console.error('[BabylonEditor] Texture image command failed', error);
            this._host.send('showMessage', { level: 'error', text: String(error?.message || error) });
        }
    }

    /**
     * @param {string} name name of the texture (a path for an external image)
     * @param {string} label shown name (for an embedded image, whose name may be its data url)
     * @param {string} extension
     * @returns {string} name of a file to save the image to
     */
    static _fileName(name, label, extension) {
        const source = name && !name.startsWith('data:') ? name : label || 'texture';
        const base = source.split(/[?#]/)[0].split(/[\\/]/).pop().replace(/\.[a-z0-9]+$/i, '');
        return `${base.replace(/[\\/:*?"<>|]/g, '_').trim() || 'texture'}.${extension}`;
    }
}
