import * as BABYLON from '@babylonjs/core';

/** Name of the camera the editor shows the model with (Babylon names it "default camera"). */
const PREVIEW_CAMERA_NAME = 'Preview camera';

/**
 * The base cameras made with the preview camera, at the same distance from the model: from above,
 * from the side and from the front (the side the model faces), turned from the front by alpha / at beta.
 * They are orthographic: the size of the view follows the radius, so the wheel zooms as usual.
 */
const BASE_VIEWS = [
    { key: 'top', name: 'Top view', turn: 0, beta: 0.01 },
    { key: 'side', name: 'Side view', turn: Math.PI / 2, beta: Math.PI / 2 },
    { key: 'front', name: 'Front view', turn: 0, beta: Math.PI / 2 },
];

/** @typedef {{ alpha: number, beta: number, radius: number, target: BABYLON.Vector3 }} CameraHome */

/**
 * Owns the orbit camera: frames the loaded model and keeps the auto-orbit state across reloads.
 * Auto-orbit pauses while the user interacts and resumes after a short idle delay. The left button
 * rotates, the right button pans (the model follows the cursor), the wheel zooms.
 */
export class CameraController {

    /**
     * @param {BABYLON.Scene} scene
     * @param {{ autoOrbit?: boolean, orbitSpeed?: number }} [options]
     */
    constructor(scene, { autoOrbit = false, orbitSpeed = 0.3 } = {}) {
        this._scene = scene;
        this._autoOrbit = autoOrbit;
        this._orbitSpeed = orbitSpeed;
        /** @type {Map<BABYLON.Camera, CameraHome>} framed positions of the preview and base cameras */
        this._homes = new Map();
        /** @type {BABYLON.Camera | null} the preview camera (not part of the model) */
        this.camera = null;
        /** @type {{ key: string, camera: BABYLON.Camera }[]} the base cameras: top, side and front views */
        this.baseCameras = [];
        scene.onBeforeRenderObservable.add(() => {
            this._updatePanning();
            this._updateOrthographic();
        });
    }

    get autoOrbit() {
        return this._autoOrbit;
    }

    /**
     * Replaces the active camera with an arc-rotate camera framing all scene meshes
     * (a default light is added if the scene has none).
     * @param {{ frontIsPositiveZ?: boolean }} [options] frontIsPositiveZ - the model faces +Z (glTF):
     *   the default camera looks at it from -Z, so it is turned around to show the front (as the
     *   Babylon.js sandbox does)
     */
    frame({ frontIsPositiveZ = false } = {}) {
        this._refreshSkinnedBounds();
        // The old preview camera is replaced (disposed), not the camera of another view; the views
        // give the mouse controls (CameraViews)
        this._scene.activeCameras = [];
        this._scene.activeCamera = this.camera;
        // createDefaultCameraOrLight(…, replace) would also dispose the lights of the model
        this._scene.createDefaultCamera(true, true, false);
        const camera = this._scene.activeCamera;
        camera.name = PREVIEW_CAMERA_NAME;
        this.camera = camera;
        if (frontIsPositiveZ && camera instanceof BABYLON.ArcRotateCamera) camera.alpha += Math.PI;
        if (!this._scene.lights.length) this._scene.createDefaultLight();
        this._homes.clear();
        if (camera instanceof BABYLON.ArcRotateCamera) {
            this._homes.set(camera, { alpha: camera.alpha, beta: camera.beta, radius: camera.radius, target: camera.target.clone() });
        }
        this._makeBaseCameras(camera);
        this._applyAutoOrbit();
    }

    /** @returns {{ ref: string, camera: BABYLON.Camera }[]} the preview camera, then the base cameras */
    get views() {
        return [
            ...(this.camera ? [{ ref: 'preview', camera: this.camera }] : []),
            ...this.baseCameras.map(({ key, camera }) => ({ ref: `base:${key}`, camera })),
        ];
    }

    /**
     * The base cameras of a newly framed model: copies of the preview camera (the same distance,
     * target and settings) turned to look from above, from the side and from the front.
     * @param {BABYLON.Camera} preview
     */
    _makeBaseCameras(preview) {
        this.baseCameras.forEach(({ camera }) => camera.dispose());
        this.baseCameras = [];
        const home = this._homes.get(preview);
        if (!(preview instanceof BABYLON.ArcRotateCamera) || !home) return;
        // The front is where the framed preview camera looks from (glTF models are turned around)
        for (const { key, name, turn, beta } of BASE_VIEWS) {
            const camera = /** @type {BABYLON.ArcRotateCamera} */ (preview.clone(name));
            camera.id = name;
            camera.useAutoRotationBehavior = false;
            camera.mode = BABYLON.Camera.ORTHOGRAPHIC_CAMERA;
            Object.assign(camera, { alpha: home.alpha + turn, beta, radius: home.radius });
            camera.setTarget(home.target.clone());
            this._homes.set(camera, { alpha: camera.alpha, beta: camera.beta, radius: camera.radius, target: home.target.clone() });
            this.baseCameras.push({ key, camera });
        }
    }

    /**
     * The orthographic base cameras show what a perspective camera at their radius would show in
     * its middle: half the height is `radius · tan(fov / 2)`, the width follows the aspect of the view.
     */
    _updateOrthographic() {
        const engine = this._scene.getEngine();
        for (const { camera } of this.baseCameras) {
            if (camera.mode !== BABYLON.Camera.ORTHOGRAPHIC_CAMERA || !(camera instanceof BABYLON.ArcRotateCamera)) continue;
            const half = camera.radius * Math.tan(camera.fov / 2);
            const aspect = engine.getAspectRatio(camera);
            Object.assign(camera, { orthoTop: half, orthoBottom: -half, orthoLeft: -half * aspect, orthoRight: half * aspect });
        }
    }

    /**
     * Moves the preview camera, or a base camera, back to the position it had when the model was framed.
     * @param {BABYLON.Camera | null} [camera]
     */
    resetView(camera = this.camera) {
        const home = camera && this._homes.get(camera);
        if (!home || !(camera instanceof BABYLON.ArcRotateCamera)) return;
        camera.inertialAlphaOffset = camera.inertialBetaOffset = camera.inertialRadiusOffset = 0;
        camera.inertialPanningX = camera.inertialPanningY = 0;
        Object.assign(camera, { alpha: home.alpha, beta: home.beta, radius: home.radius });
        camera.setTarget(home.target.clone());
    }

    /**
     * Babylon pans by a fixed number of pixels per scene unit (1000), which barely moves a model of
     * hundreds of units: the sensibility is set so the target follows the cursor at the current
     * distance (the movement is spread over the frames of the panning inertia).
     */
    _updatePanning() {
        const scene = this._scene;
        // Every shown view: the preview camera, the copies of file cameras, virtual cameras
        const cameras = scene.activeCameras?.length ? scene.activeCameras : [scene.activeCamera];
        for (const camera of cameras) {
            if (!(camera instanceof BABYLON.ArcRotateCamera) || !camera.radius) continue;
            const height = scene.getEngine().getRenderHeight() * camera.viewport.height;
            const pixelsPerUnit = height / (2 * camera.radius * Math.tan(camera.fov / 2));
            camera.panningSensibility = pixelsPerUnit / (1 - camera.panningInertia);
        }
    }

    /**
     * Bounding boxes of skinned meshes in their posed shape: the `.babylon` loader computes them
     * from the vertices only (in the bind space, which may be scaled, e.g. by glTF exports), so
     * the camera would frame a tiny box. The glTF loader does this itself; the model is not changed.
     */
    _refreshSkinnedBounds() {
        for (const mesh of this._scene.meshes) {
            if (!mesh.skeleton || !mesh.getTotalVertices()) continue;
            mesh.skeleton.prepare(true);
            mesh.refreshBoundingInfo({ applySkeleton: true, applyMorph: true });
        }
    }

    /**
     * @param {boolean} enabled
     */
    setAutoOrbit(enabled) {
        this._autoOrbit = enabled;
        this._applyAutoOrbit();
    }

    toggleAutoOrbit() {
        this.setAutoOrbit(!this._autoOrbit);
    }

    _applyAutoOrbit() {
        // Only the preview camera orbits: the cameras of the model are not moved
        const camera = this.camera;
        if (!(camera instanceof BABYLON.ArcRotateCamera)) return;
        camera.useAutoRotationBehavior = this._autoOrbit;
        if (camera.autoRotationBehavior) {
            camera.autoRotationBehavior.idleRotationSpeed = this._orbitSpeed;
        }
    }
}
