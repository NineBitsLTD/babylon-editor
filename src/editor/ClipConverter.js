import * as BABYLON from '@babylonjs/core';

/** @typedef {import('./ModelEdits').CopiedClip} CopiedClip */
/** @typedef {CopiedClip['tracks'][number]} CopiedTrack */

/**
 * Local transform of a bone or node.
 * @typedef {object} Transform
 * @property {BABYLON.Vector3} position
 * @property {BABYLON.Quaternion} rotation
 * @property {BABYLON.Vector3} scaling
 */

/**
 * How a clip is converted.
 * @typedef {object} ConversionOptions
 * @property {boolean} rotationsOnly only rotations are taken from the clip; positions and scalings
 *   stay those of the rest pose of the target (or are not animated)
 * @property {boolean} mirror the clip comes from a mirrored space (glTF under its `__root__` node with
 *   scaling z = -1) into a not mirrored one, or the other way: local transforms are mirrored along Z
 * @property {(name: string) => Transform | null} [restOf] rest transform of a target by name
 */

const T = BABYLON.Animation;
/** The channels of a node animated by an animation group, by animated property. */
const NODE_CHANNELS = { position: 'position', rotationQuaternion: 'rotation', rotation: 'rotation', scaling: 'scaling' };
const MIRROR = BABYLON.Matrix.Scaling(1, 1, -1);

/**
 * @param {BABYLON.Matrix} matrix
 * @returns {Transform}
 */
export function decomposeTransform(matrix) {
    const transform = { position: new BABYLON.Vector3(), rotation: new BABYLON.Quaternion(), scaling: new BABYLON.Vector3(1, 1, 1) };
    matrix.decompose(transform.scaling, transform.rotation, transform.position);
    return transform;
}

/**
 * @param {Transform} transform
 * @returns {Transform} the transform mirrored along Z (conjugated by a z = -1 scaling)
 */
function mirrorTransform({ position, rotation, scaling }) {
    return {
        position: new BABYLON.Vector3(position.x, position.y, -position.z),
        rotation: new BABYLON.Quaternion(-rotation.x, -rotation.y, rotation.z, rotation.w),
        scaling: scaling.clone(),
    };
}

/**
 * @param {any} json animation in the `.babylon` format
 * @param {any[]} keys keys in the `.babylon` format
 * @returns {any} the animation with other keys (name, property, frame rate and loop mode kept)
 */
function withKeys(json, keys) {
    return { ...json, keys };
}

/**
 * @param {string} name
 * @param {string} property
 * @param {number} dataType
 * @param {any} source animation in the `.babylon` format whose frame rate and loop mode are kept
 * @param {BABYLON.IAnimationKey[]} keys
 * @returns {any} a new animation in the `.babylon` format
 */
function serializedAnimation(name, property, dataType, source, keys) {
    const animation = new BABYLON.Animation(name, property, source.framePerSecond ?? 30, dataType, source.loopBehavior ?? T.ANIMATIONLOOPMODE_CYCLE);
    animation.setKeys(keys);
    return animation.serialize();
}

/**
 * Converts the tracks of copied clips between the two kinds of clips (and between mirrored and not
 * mirrored spaces): frame ranges of a `.babylon` timeline animate one local matrix per bone and
 * Babylon changes matrices step by step between keys; glTF animation groups animate position /
 * rotationQuaternion / scaling of the joint nodes, interpolated. Tracks keep their target names; a
 * converted bone track targets the node of the same name and the other way.
 */
export class ClipConverter {

    /**
     * An animation group as a frame range: the channels of each node become one matrix track of the
     * bone of the same name, keyed on every frame (the matrices would step between sparse keys); a
     * channel the clip does not animate takes the rest value of the bone.
     * @param {CopiedClip} clip `type: 'group'`
     * @param {ConversionOptions} options
     * @returns {CopiedClip}
     */
    static toTimeline(clip, { rotationsOnly, mirror, restOf = () => null }) {
        /** @type {Map<string, { animations: Record<string, BABYLON.Animation>, source: any }>} */
        const byNode = new Map();
        const tracks = [];
        for (const track of clip.tracks) {
            const channel = NODE_CHANNELS[track.animation.property];
            if (!channel || track.target?.kind !== 'node') {
                // A matrix track of a bone needs no conversion
                if (track.animation.property === '_matrix') tracks.push(mirror ? ClipConverter._mirrorTrack(track) : track);
                continue;
            }
            const entry = byNode.get(track.target.name) ?? { animations: {}, source: track.animation };
            entry.animations[channel] = BABYLON.Animation.Parse(track.animation);
            byNode.set(track.target.name, entry);
        }
        const frames = ClipConverter._frames(clip.length);
        for (const [name, { animations, source }] of byNode) {
            if (rotationsOnly && !animations.rotation) continue;
            const rest = restOf(name) ?? { position: BABYLON.Vector3.Zero(), rotation: BABYLON.Quaternion.Identity(), scaling: BABYLON.Vector3.One() };
            const keys = frames.map((frame) => {
                let transform = {
                    position: !rotationsOnly && animations.position ? animations.position.evaluate(frame).clone() : null,
                    rotation: animations.rotation ? ClipConverter._quaternion(animations.rotation, frame) : null,
                    scaling: !rotationsOnly && animations.scaling ? animations.scaling.evaluate(frame).clone() : null,
                };
                // The clip's own values are mirrored; the rest values are those of the target already
                if (mirror) {
                    const mirrored = mirrorTransform({ position: transform.position ?? BABYLON.Vector3.Zero(), rotation: transform.rotation ?? BABYLON.Quaternion.Identity(), scaling: BABYLON.Vector3.One() });
                    transform = { position: transform.position && mirrored.position, rotation: transform.rotation && mirrored.rotation, scaling: transform.scaling };
                }
                const matrix = BABYLON.Matrix.Compose(transform.scaling ?? rest.scaling, transform.rotation ?? rest.rotation, transform.position ?? rest.position);
                return { frame, value: matrix };
            });
            tracks.push({ target: { kind: 'bone', name }, animation: serializedAnimation(source.name ?? name, '_matrix', T.ANIMATIONTYPE_MATRIX, source, keys) });
        }
        return { ...clip, type: 'timeline', tracks };
    }

    /**
     * A frame range as an animation group: the matrix of each bone becomes position /
     * rotationQuaternion / scaling tracks of the node of the same name (only rotationQuaternion for
     * rotations only), keyed on the frames of the matrix keys.
     * @param {CopiedClip} clip `type: 'timeline'`
     * @param {ConversionOptions} options
     * @returns {CopiedClip}
     */
    static toGroup(clip, { rotationsOnly, mirror }) {
        const tracks = [];
        for (const track of clip.tracks) {
            if (track.animation.property !== '_matrix') {
                // Node tracks of a timeline are position / rotation / scaling already
                if (NODE_CHANNELS[track.animation.property] && (!rotationsOnly || NODE_CHANNELS[track.animation.property] === 'rotation')) {
                    tracks.push(mirror ? ClipConverter._mirrorTrack(track) : track);
                }
                continue;
            }
            const animation = BABYLON.Animation.Parse(track.animation);
            const transforms = animation.getKeys().map(key => ({ frame: key.frame, transform: ClipConverter._mirrored(decomposeTransform(key.value), mirror) }));
            const name = track.target.name;
            const channel = (property, dataType, read) => ({
                target: { kind: 'node', name },
                animation: serializedAnimation(`${name}.${property}`, property, dataType, track.animation, transforms.map(({ frame, transform }) => ({ frame, value: read(transform) }))),
            });
            if (!rotationsOnly) tracks.push(channel('position', T.ANIMATIONTYPE_VECTOR3, transform => transform.position));
            tracks.push(channel('rotationQuaternion', T.ANIMATIONTYPE_QUATERNION, transform => transform.rotation));
            if (!rotationsOnly) tracks.push(channel('scaling', T.ANIMATIONTYPE_VECTOR3, transform => transform.scaling));
        }
        return { ...clip, type: 'group', tracks };
    }

    /**
     * The tracks of a clip mirrored along Z, the kind of the clip kept (a clip pasted between a
     * mirrored and a not mirrored model of the same kind).
     * @param {CopiedClip} clip
     * @returns {CopiedClip}
     */
    static mirror(clip) {
        return { ...clip, tracks: clip.tracks.map(track => ClipConverter._mirrorTrack(track)) };
    }

    /**
     * @param {CopiedTrack} track
     * @returns {CopiedTrack} the track with mirrored values (tracks of other properties as they are)
     */
    static _mirrorTrack(track) {
        const animation = BABYLON.Animation.Parse(track.animation);
        const property = track.animation.property;
        const mirrorValue = (value) => {
            if (property === '_matrix') return MIRROR.multiply(value).multiply(MIRROR);
            if (property === 'position') return new BABYLON.Vector3(value.x, value.y, -value.z);
            if (property === 'rotationQuaternion') return new BABYLON.Quaternion(-value.x, -value.y, value.z, value.w);
            // Euler angles: the rotation about X and Y turns the other way
            if (property === 'rotation') return new BABYLON.Vector3(-value.x, -value.y, value.z);
            return value;
        };
        const keys = animation.getKeys().map(key => ({ ...key, value: mirrorValue(key.value) }));
        animation.setKeys(keys);
        return { ...track, animation: withKeys(track.animation, animation.serialize().keys) };
    }

    /**
     * @param {Transform} transform
     * @param {boolean} mirror
     * @returns {Transform}
     */
    static _mirrored(transform, mirror) {
        return mirror ? mirrorTransform(transform) : transform;
    }

    /**
     * @param {BABYLON.Animation} animation a quaternion or Euler rotation animation
     * @param {number} frame
     * @returns {BABYLON.Quaternion}
     */
    static _quaternion(animation, frame) {
        const value = animation.evaluate(frame);
        return animation.dataType === T.ANIMATIONTYPE_QUATERNION ? value.clone() : BABYLON.Quaternion.FromEulerVector(value);
    }

    /**
     * @param {number} length
     * @returns {number[]} every whole frame from 0 to the length, and the length itself
     */
    static _frames(length) {
        const frames = [];
        for (let frame = 0; frame < length; frame++) frames.push(frame);
        frames.push(length);
        return frames;
    }
}
