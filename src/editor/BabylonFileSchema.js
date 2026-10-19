import * as BABYLON from '@babylonjs/core';

/**
 * A field of an object in the `.babylon` format.
 * @typedef {object} SchemaField
 * @property {string} key name in the `.babylon` document
 * @property {'boolean' | 'number' | 'string' | 'color3' | 'vector3' | 'enum'} type
 * @property {string} [property] property of the Babylon object (defaults to `key`)
 * @property {{ value: number | string, label: string }[]} [options] for 'enum'
 * @property {(object: any) => any} [get] custom read from the Babylon object
 * @property {(object: any, value: any) => void} [set] custom write to the Babylon object
 * @property {any} [default] value Babylon uses when the document has none (top-level scene fields)
 */

const bool = (key, extra = {}) => ({ key, type: 'boolean', ...extra });
const num = (key, extra = {}) => ({ key, type: 'number', ...extra });
const str = (key, extra = {}) => ({ key, type: 'string', ...extra });
const color = (key, property) => ({ key, type: 'color3', property });
const vec = (key, property) => ({ key, type: 'vector3', property });
const enumeration = (key, options, extra = {}) => ({ key, type: 'enum', options: options.map(([value, label]) => ({ value, label })), ...extra });

/**
 * Fields of the `.babylon` format (https://doc.babylonjs.com/setup/support/.babylonFileFormat)
 * that the inspector shows besides its main properties, so a value the file does not have yet
 * can be set too. Fields marked "Babylon" are read by Babylon's loader but not listed in the
 * format document (fog, PBR materials).
 * @type {Record<string, SchemaField[]>}
 */
export const BABYLON_FILE_SCHEMA = {
    scene: [
        bool('autoClear', { default: true }),
        { ...color('clearColor'), default: [0.2, 0.2, 0.3] },
        { ...color('ambientColor'), default: [0, 0, 0] },
        { ...vec('gravity'), default: [0, -9.807, 0] },
        bool('collisionsEnabled', { default: true }),
        bool('physicsEnabled', { default: false }),
        { ...vec('physicsGravity'), default: [0, -9.81, 0] },
        enumeration('physicsEngine', [['oimo', 'oimo'], ['cannon', 'cannon']], { default: 'oimo' }),
        bool('autoAnimate', { default: false }),
        num('autoAnimateFrom', { default: 0 }),
        num('autoAnimateTo', { default: 0 }),
        bool('autoAnimateLoop', { default: false }),
        num('autoAnimateSpeed', { default: 1 }),
        // Babylon
        enumeration('fogMode', [[0, 'None'], [1, 'Exponential'], [2, 'Exponential squared'], [3, 'Linear']], { default: 0 }),
        { ...color('fogColor'), default: [0.2, 0.2, 0.3] },
        num('fogStart', { default: 0 }),
        num('fogEnd', { default: 1000 }),
        num('fogDensity', { default: 0.1 }),
    ],
    mesh: [
        bool('pickable', { property: 'isPickable' }),
        bool('checkCollisions'),
        bool('receiveShadows'),
        bool('applyFog'),
        bool('infiniteDistance'),
        bool('showBoundingBox'),
        bool('showSubMeshesBoundingBox'),
        bool('freezeWorldMatrix', {
            get: mesh => mesh.isWorldMatrixFrozen,
            set: (mesh, value) => (value ? mesh.freezeWorldMatrix() : mesh.unfreezeWorldMatrix()),
        }),
        bool('hasVertexAlpha'),
        num('alphaIndex'),
        num('visibility'),
        enumeration('billboardMode', [[0, 'None'], [1, 'X'], [2, 'Y'], [4, 'Z'], [7, 'All']]),
    ],
    standardMaterial: [
        bool('disableDepthWrite'),
        num('indexOfRefraction'),
        bool('useLightmapAsShadowmap'),
        bool('useReflectionFresnelFromSpecular'),
        bool('useEmissiveAsIllumination'),
        bool('checkReadyOnlyOnce'),
    ],
    // Babylon (the format document only describes the standard material)
    pbrMaterial: [
        color('ambient', 'ambientColor'),
        color('reflection', 'reflectionColor'),
        num('microSurface'),
        num('environmentIntensity'),
        num('directIntensity'),
        num('specularIntensity'),
        num('emissiveIntensity'),
        num('alphaCutOff'),
        enumeration('transparencyMode', [[0, 'Opaque'], [1, 'Alpha test'], [2, 'Alpha blend'], [3, 'Alpha test and blend']]),
        bool('useAlphaFromAlbedoTexture'),
        bool('usePhysicalLightFalloff'),
        bool('disableDepthWrite'),
        bool('checkReadyOnlyOnce'),
        num('maxSimultaneousLights'),
    ],
    texture: [
        bool('getAlphaFromRGB'),
        enumeration('coordinatesMode', [[0, 'Explicit'], [1, 'Spherical'], [2, 'Planar'], [3, 'Cubic'], [4, 'Projection'], [5, 'Skybox']]),
        num('uAng'),
        num('vAng'),
        num('wAng'),
        enumeration('wrapU', [[0, 'Clamp'], [1, 'Wrap'], [2, 'Mirror']]),
        enumeration('wrapV', [[0, 'Clamp'], [1, 'Wrap'], [2, 'Mirror']]),
        num('coordinatesIndex'),
    ],
    camera: [
        num('speed'),
        num('inertia'),
        bool('checkCollisions'),
        bool('applyGravity'),
        vec('ellipsoid'),
        num('heightOffset'),
        num('rotationOffset'),
        num('cameraRigMode'),
    ],
    light: [
        bool('shadowEnabled'),
        num('radius'),
    ],
    shadowGenerator: [
        bool('usePoissonSampling'),
        bool('useExponentialShadowMap'),
        bool('useBlurExponentialShadowMap'),
        bool('forceBackFacesOnly'),
    ],
    skeleton: [
        bool('needInitialSkinMatrix'),
    ],
};

/**
 * Texture slots of a material in the `.babylon` format, per material class (the material keys
 * that hold a texture object).
 * @type {Record<string, string[]>}
 */
export const MATERIAL_TEXTURE_SLOTS = {
    StandardMaterial: ['diffuseTexture', 'ambientTexture', 'opacityTexture', 'reflectionTexture', 'emissiveTexture', 'specularTexture', 'bumpTexture', 'lightmapTexture', 'refractionTexture'],
    PBRMaterial: ['albedoTexture', 'ambientTexture', 'opacityTexture', 'reflectionTexture', 'emissiveTexture', 'reflectivityTexture', 'metallicTexture', 'microSurfaceTexture', 'bumpTexture', 'lightmapTexture', 'refractionTexture'],
};

/**
 * Inspector properties for the schema fields of an object that it has (fields of another
 * camera / light type are left out).
 * @param {object} object Babylon object
 * @param {SchemaField[]} fields
 * @param {(field: SchemaField) => boolean} [isUnset] whether the document has no value for the field yet
 * @returns {import('./PropertyPanel').PropertyDescriptor[]}
 */
export function schemaProperties(object, fields, isUnset) {
    /** @type {import('./PropertyPanel').PropertyDescriptor[]} */
    const properties = [];
    for (const field of fields) {
        const property = field.property ?? field.key;
        if (!field.get && !(property in object)) continue;
        const read = field.get ?? (target => target[property]);
        const write = field.set ?? ((target, value) => { target[property] = value; });
        const base = { label: field.key, isUnset: isUnset ? () => isUnset(field) : undefined };
        const current = read(object);
        switch (field.type) {
            case 'boolean':
                properties.push({ ...base, type: 'boolean', get: () => !!read(object), set: value => write(object, value) });
                break;
            case 'number':
                properties.push({ ...base, type: 'number', get: () => read(object), set: value => write(object, value) });
                break;
            case 'string':
                properties.push({ ...base, type: 'text', get: () => read(object) ?? '', set: value => write(object, value) });
                break;
            case 'color3':
                if (!(current instanceof BABYLON.Color3 || current instanceof BABYLON.Color4)) break;
                properties.push({
                    ...base,
                    type: 'color',
                    get: () => read(object).toHexString().slice(0, 7),
                    set: (value) => {
                        const next = BABYLON.Color3.FromHexString(value);
                        write(object, read(object) instanceof BABYLON.Color4 ? next.toColor4(read(object).a) : next);
                    },
                });
                break;
            case 'vector3':
                if (!(current instanceof BABYLON.Vector3)) break;
                properties.push({ ...base, type: 'vector', get: () => read(object).asArray(), set: value => read(object).fromArray(value) });
                break;
            case 'enum':
                properties.push({
                    ...base,
                    type: 'select',
                    options: () => field.options.map(option => ({ value: String(option.value), label: option.label })),
                    get: () => String(read(object)),
                    set: (value) => {
                        const option = field.options.find(candidate => String(candidate.value) === value);
                        write(object, option ? option.value : value);
                    },
                });
                break;
        }
    }
    return properties;
}
