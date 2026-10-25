import * as BABYLON from '@babylonjs/core';

/** Name of the camera the editor shows the model with (Babylon names it "default camera"). */
const PREVIEW_CAMERA_NAME = 'Preview camera';

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
        /** @type {{ alpha: number, beta: number, radius: number, target: BABYLON.Vector3 } | null} */
        this._home = null;
        /** @type {BABYLON.Camera | null} the preview camera (not part of the model) */
        this.camera = null;
        scene.onBeforeRenderObservable.add(() => this._updatePanning());
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
        this._home = camera instanceof BABYLON.ArcRotateCamera
            ? { alpha: camera.alpha, beta: camera.beta, radius: camera.radius, target: camera.target.clone() }
            : null;
        this._applyAutoOrbit();
    }

    /** Moves the preview camera back to the position it had when the model was framed. */
    resetView() {
        const camera = this.camera;
        if (!this._home || !(camera instanceof BABYLON.ArcRotateCamera)) return;
        camera.inertialAlphaOffset = camera.inertialBetaOffset = camera.inertialRadiusOffset = 0;
        camera.inertialPanningX = camera.inertialPanningY = 0;
        Object.assign(camera, { alpha: this._home.alpha, beta: this._home.beta, radius: this._home.radius });
        camera.setTarget(this._home.target.clone());
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
