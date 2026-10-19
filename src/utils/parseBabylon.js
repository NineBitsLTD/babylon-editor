/**
 * @typedef {Object} BabylonSceneData
 * @property {string} babylonVersion - The version of the Babylon format used.
 * @property {string[]} unknowns - Array of keys found in the scene object that were not explicitly processed.
 * * // The following properties are the raw arrays/objects from the .babylon file, 
 * // typically conforming to Babylon's IScene interface structures.
 * // They are expected to be typed externally by the consumer using @babylonjs/core.
 * @property {BABYLON.IMesh[] | undefined} meshes - Array of meshes (Expected: BABYLON.IMesh[]).
 * @property {BABYLON.IMaterial[] | undefined} materials - Array of materials (Expected: BABYLON.IMaterial[]).
 * @property {BABYLON.IMultiMaterial[] | undefined} multiMaterials - Array of multiMaterials (Expected: BABYLON.IMultiMaterial[]).
 * @property {BABYLON.ICamera[] | undefined} cameras - Array of cameras (Expected: BABYLON.ICamera[]).
 * @property {BABYLON.ILight[] | undefined} lights - Array of lights (Expected: BABYLON.ILight[]).
 * @property {BABYLON.ISkeleton[] | undefined} skeletons - Array of skeletons (Expected: BABYLON.ISkeleton[]).
 * @property {BABYLON.IAnimationGroup[] | undefined} animationGroups - Array of animation groups (Expected: BABYLON.IAnimationGroup[]).
 * @property {BABYLON.ITransformNode[] | undefined} transformNodes - Array of transform nodes (Expected: BABYLON.ITransformNode[]).
 * @property {BABYLON.IParticleSystem[] | undefined} particleSystems - Array of particle systems (Expected: BABYLON.IParticleSystem[]).
 * @property {BABYLON.IMorphTargetManager[] | undefined} morphTargetManagers - Array of morph target managers (Expected: BABYLON.IMorphTargetManager[]).
 * @property {BABYLON.ISound[] | undefined} sounds - Array of sound definitions (Expected: BABYLON.ISound[]).
 * @property {BABYLON.ILensFlareSystem[] | undefined} lensFlareSystems - Array of lens flare systems (Expected: BABYLON.ILensFlareSystem[]).
 * @property {BABYLON.ISpriteManager[] | undefined} spriteManagers - Array of sprite managers (Expected: BABYLON.ISpriteManager[]).
 * @property {BABYLON.ITexture[] | undefined} textures - Array of textures (Expected: BABYLON.ITexture[]).
 * @property {BABYLON.IGeometry[] | undefined} geometries - Array of geometries (Expected: BABYLON.IGeometry[]).
 * @property {BABYLON.IShadowGenerator[] | undefined} shadowGenerators - Array of shadow generators (Expected: BABYLON.IShadowGenerator[]).
 * @property {BABYLON.IReflectionProbe[] | undefined} reflectionProbes - Array of reflection probes (Expected: BABYLON.IReflectionProbe[]).
 * @property {BABYLON.IProceduralTexture[] | undefined} proceduralTextures - Array of procedural textures (Expected: BABYLON.IProceduralTexture[]).
 * @property {BABYLON.IRenderTargetTexture[] | undefined} renderTargets - Array of render target textures (Expected: BABYLON.IRenderTargetTexture[]).
 * @property {BABYLON.IPostProcess[] | undefined} postProcesses - Array of post processes (Expected: BABYLON.IPostProcess[]).
 * @property {any | undefined} actions - Action manager actions (Expected: object or array of actions).
 * @property {any | undefined} imageProcessingConfiguration - Image processing settings (Expected: object).
 * @property {string | undefined} environmentTexture - Path to the environment texture.
 * @property {string | undefined} activeCameraID - The ID of the active camera.
 * @property {number | undefined} fogDensity - The density value if fog is enabled.
 * @property {number[] | undefined} gravity - Scene gravity vector [x, y, z].
 * @property {any | undefined} producer - Information about the producer/exporter (Expected: object).
 * @property {any | undefined} metadata - Custom metadata attached to the scene (Expected: object).
 * @property {boolean | undefined} autoAnimate - If auto animation is enabled (Expected: boolean).
 * @property {number | undefined} autoAnimateFrom - Frame start for auto animation (Expected: number).
 * @property {number | undefined} autoAnimateTo - Frame end for auto animation (Expected: number).
 * @property {boolean | undefined} autoAnimateLoop - If auto animation loops (Expected: boolean).
 */

/**
 * Parses the content of a Babylon .babylon file from a VS Code TextDocument.
 * It performs safe JSON parsing and augments the resulting scene object with
 * key structural metadata (version and unknowns).
 * The raw scene object is returned, allowing the consuming application to
 * use native Babylon types for the included arrays (meshes, materials, etc.).
 *
 * @param {import('vscode').TextDocument | string} document - The VS Code TextDocument containing the .babylon file content.
 * @returns {BabylonSceneData | Object | null} The raw scene object augmented with metadata, or null on parsing error.
 */
export function parseBabylon(document) {
    const content = typeof document === 'string'
        ? document
        : document.getText();
    let sceneObj;

    // 1. Попытка парсинга JSON с обработкой ошибок
    try {
        sceneObj = JSON.parse(content);
    } catch (e) {
        // Возвращаем null или бросаем ошибку, если JSON невалиден
        console.error("Error parsing Babylon JSON:", e);
        return null;
    }

    if (typeof sceneObj !== 'object' || sceneObj === null) {
        return null;
    }

    // Список всех известных ключей верхнего уровня.
    // Если ключ отсутствует здесь, он попадет в 'unknowns'.
    const knownKeys = [
        // Основные массивы (Критические активы/массивы структуры)
        'meshes', 'materials', 'cameras', 'lights', 'skeletons', 
        'animationGroups', 'transformNodes', 'particleSystems', 'multiMaterials',
        'morphTargetManagers', 'sounds', 'lensFlareSystems', 'spriteManagers', 
        'textures', 'geometries', 'shadowGenerators', 'reflectionProbes', 
        'proceduralTextures',
        'renderTargets',
        'postProcesses',

        // Основные одиночные поля (Свойства, часто требующие прямого доступа)
        'babylonVersion', 'gravity', 'activeCameraID', 'fogDensity', 'producer',
        'actions', 'imageProcessingConfiguration', 'environmentTexture', 
        'metadata',
        'autoAnimate', 'autoAnimateFrom', 'autoAnimateTo', 'autoAnimateLoop',

        // Стандартные поля сцены Babylon (игнорируются при сборе "неизвестных")
        'autoClear', 'clearColor', 'ambientColor', 'fogMode', 'fogColor', 
        'fogStart', 'fogEnd', 'useRightHandedSystem', 
        'layers', // Слой (layer)
        'lensFlares', // Линзовые блики (старое поле)
        'actionManager', 'probes', 'imageTextures', 'cubeTextures', 
        'reflectivityColor', 'mainSoundTrackId', 'simplificationTask', 
        'multiview', 'mainCameraId', 'workerCollisions', 'physicsEnabled', 
        'physicsGravity', 'physicsEngine', 'soundTracks', 'colliders', 
        'defaultPipeline', 'reservedDataStore', 'version' 
    ];

    // Определяем ключи, которые не были явно обработаны
    const sceneKeys = Object.keys(sceneObj);
    const unknowns = sceneKeys.filter(key => !knownKeys.includes(key));

    // 2. Итоговая сводка сцены (минимальные метаданные, добавляется к исходному объекту)
    /** @type {BabylonSceneData} */
    const sceneData = {
        babylonVersion: String(sceneObj.babylonVersion || 'Unknown'),

        // Неизвестные ключи
        unknowns: unknowns
    };

    // Объединяем исходный объект сцены и сгенерированные метаданные
    return {
        ...sceneObj,
        ...sceneData
    };
}