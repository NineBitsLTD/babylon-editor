import * as BABYLON from '@babylonjs/core';

/**
 * @typedef {object} AnimationClip
 * @property {string} name
 * @property {BABYLON.AnimationGroup} group the group that plays the clip (may be shared by several clips)
 * @property {number} from first frame of the clip
 * @property {number} to last frame of the clip
 * @property {BABYLON.AnimationRange[]} ranges named ranges backing the clip (empty for loader groups and whole timelines)
 * @property {boolean} [isTimeline] the whole shared timeline (AnimationController.frames), not a clip of the file
 */

/**
 * Frames without a key in any track between two keyed frames (both excluded).
 * @typedef {object} EmptyFrameRange
 * @property {number} after the keyed frame before the range
 * @property {number} before the keyed frame after the range
 */

const POSE_EPSILON = 1e-4;
/** Key frames closer than this are one frame. */
const FRAME_EPSILON = 1e-6;

/**
 * Keys, frame windows and ranges of the clips, restored by undo of a renumbering.
 * @typedef {object} ClipFramesSnapshot
 * @property {{ animation: BABYLON.Animation, keys: BABYLON.IAnimationKey[] }[]} keys
 * @property {{ clip: AnimationClip, from: number, to: number, ranges: number[][], group: number[] }[]} clips
 */

/**
 * Whether the first key of an animation was added by Babylon: a RuntimeAnimation inserts a key at
 * frame 0 into the keys of an animation that starts later, sharing the value of the next key.
 * It is not part of the model.
 * @param {BABYLON.IAnimationKey[]} keys
 * @returns {boolean}
 */
export function hasRuntimeStartKey(keys) {
    return keys.length > 1 && keys[0].frame === 0 && keys[1].frame !== 0 && keys[0].value === keys[1].value;
}

/**
 * @param {BABYLON.Animation} animation
 * @returns {BABYLON.IAnimationKey[]} the keys of the model (without a key added by Babylon)
 */
export function modelKeys(animation) {
    const keys = animation.getKeys();
    return hasRuntimeStartKey(keys) ? keys.slice(1) : keys;
}

/**
 * Sets new frames of the keys of an animation; a key added by Babylon stays at frame 0.
 * @param {BABYLON.Animation} animation
 * @param {(frame: number) => number} move
 */
function moveKeys(animation, move) {
    const keys = animation.getKeys();
    const runtime = hasRuntimeStartKey(keys);
    animation.setKeys(keys.map((key, index) => (runtime && index === 0 ? key : { ...key, frame: move(key.frame) })), true);
}

/**
 * @param {BABYLON.IAnimationKey} key
 * @returns {BABYLON.IAnimationKey}
 */
function cloneKey(key) {
    return { ...key, value: key.value?.clone ? key.value.clone() : key.value };
}

/**
 * Current local matrix of a bone; glTF bones follow their linked transform node.
 * @param {BABYLON.Bone} bone
 * @returns {BABYLON.Matrix}
 */
function localPose(bone) {
    const node = bone.getTransformNode();
    if (!node) return bone.getLocalMatrix();
    const rotation = node.rotationQuaternion ?? BABYLON.Quaternion.FromEulerVector(node.rotation);
    return BABYLON.Matrix.Compose(node.scaling, rotation, node.position);
}

/**
 * @param {BABYLON.Bone} bone
 * @param {BABYLON.Matrix} matrix local matrix
 */
function setLocalPose(bone, matrix) {
    const node = bone.getTransformNode();
    if (!node) {
        bone._matrix = matrix;
        return;
    }
    const scaling = new BABYLON.Vector3(), rotation = new BABYLON.Quaternion(), position = new BABYLON.Vector3();
    matrix.decompose(scaling, rotation, position);
    node.position.copyFrom(position);
    node.rotationQuaternion = rotation;
    node.scaling.copyFrom(scaling);
}

/**
 * Unifies model animations into a flat list of clips and controls playback of one of them.
 *
 * Sources, in order of preference:
 * - animation groups provided by the loader (glTF);
 * - named animation ranges of skeletons/nodes (.babylon exports keep clips as frame ranges of one
 *   timeline) - played as frame windows of a single shared group, without copying keys;
 * - the whole timeline of animated bones/nodes as a single clip.
 */
export class AnimationController {

    /**
     * @param {BABYLON.Scene} scene
     */
    constructor(scene) {
        this._scene = scene;
        /** @type {AnimationClip[]} */
        this.clips = [];
        /** @type {AnimationClip | null} */
        this.current = null;
        /**
         * The whole shared timeline as a clip, for models whose clips are ranges of one timeline
         * (null for glTF groups, which each have their own frames).
         * @type {AnimationClip | null}
         */
        this.frames = null;
        /** @type {BABYLON.AnimationGroup | null} timeline group created here (not owned by the asset container) */
        this._timeline = null;
        /** @type {(BABYLON.Skeleton | BABYLON.Node)[]} objects that own named animation ranges */
        this._rangeOwners = [];
        this._playing = false;
    }

    /**
     * Rebuilds the clip list for a freshly loaded container and selects the first clip (paused).
     * @param {BABYLON.AssetContainer} container
     */
    setContainer(container) {
        this.dispose();
        container.animationGroups.forEach(group => group.stop());

        this.clips = container.animationGroups.length
            ? container.animationGroups.map(group => ({ name: group.name, group, from: group.from, to: group.to, ranges: [] }))
            : this._createTimelineClips(container);
        if (this.clips.length) {
            this.select(0);
        }
    }

    get isPlaying() {
        return this._playing;
    }

    /**
     * @param {string} name
     * @returns {AnimationClip | undefined} a clip, or the whole timeline (`frames`), by name
     */
    findClip(name) {
        return [...this.clips, ...(this.frames ? [this.frames] : [])].find(clip => clip.name === name);
    }

    /** Index of the current clip in `clips`, or -1. */
    get currentIndex() {
        return this.current ? this.clips.indexOf(this.current) : -1;
    }

    /** Frame the current clip is at (the clip start when nothing plays yet). */
    get currentFrame() {
        const clip = this.current;
        if (!clip) return 0;
        return clip.group.animatables[0]?.masterFrame ?? clip.from;
    }

    /**
     * Renames a clip; for range-based clips the backing ranges of all owners are renamed too,
     * so the new name is serialized.
     * @param {AnimationClip} clip
     * @param {string} name
     */
    renameClip(clip, name) {
        if (clip.ranges.length) {
            for (const owner of this._rangeOwners) {
                const range = owner.getAnimationRange(clip.name);
                if (!range) continue;
                owner.deleteAnimationRange(clip.name, false);
                owner.createAnimationRange(name, range.from, range.to);
            }
            clip.ranges = this._rangeOwners.map(owner => owner.getAnimationRange(name)).filter(Boolean);
        } else {
            clip.group.name = name;
        }
        clip.name = name;
    }

    /**
     * Changes the frame window of a range-based clip (loader groups have fixed bounds).
     * @param {AnimationClip} clip
     * @param {number} from
     * @param {number} to
     */
    setClipRange(clip, from, to) {
        if (!clip.ranges.length) return;
        clip.ranges.forEach(range => { range.from = from; range.to = to; });
        clip.from = from;
        clip.to = to;
        if (clip === this.current) {
            this.select(this.currentIndex);
        }
    }

    /**
     * Makes the clip current, pauses and shows the given frame.
     * @param {AnimationClip} clip
     * @param {number} frame
     */
    showFrame(clip, frame) {
        if (this.current !== clip) {
            this.current?.group.stop();
            this.current = clip;
            clip.group.start(true, 1, clip.from, clip.to);
        }
        this.pause();
        clip.group.goToFrame(frame);
    }

    /**
     * Re-evaluates the current frame, so edited keys become visible while paused.
     */
    refreshPose() {
        const clip = this.current;
        if (!clip) return;
        clip.group.goToFrame(this.currentFrame);
    }

    /**
     * Switches to a clip (by index in `clips`, or the clip itself, e.g. `frames`), keeping the
     * play/pause state.
     * @param {number | AnimationClip} target
     */
    select(target) {
        const clip = typeof target === 'number' ? this.clips[target] : target;
        if (!clip) return;
        this.current?.group.stop();
        this.current = clip;
        clip.group.start(true, 1, clip.from, clip.to);
        if (!this._playing) {
            clip.group.pause();
        }
    }

    play() {
        if (!this.current) return;
        this._playing = true;
        this.current.group.play(true);
    }

    pause() {
        if (!this.current) return;
        this._playing = false;
        this.current.group.pause();
    }

    toggle() {
        this._playing ? this.pause() : this.play();
    }

    /**
     * Playback position of the current clip in [0, 1].
     * @returns {number}
     */
    getProgress() {
        const clip = this.current;
        if (!clip || clip.to <= clip.from) return 0;
        const frame = clip.group.animatables[0]?.masterFrame ?? clip.from;
        return Math.min(1, Math.max(0, (frame - clip.from) / (clip.to - clip.from)));
    }

    /**
     * Moves the current clip to the given position.
     * @param {number} progress position in [0, 1]
     */
    seek(progress) {
        const clip = this.current;
        if (!clip) return;
        clip.group.goToFrame(clip.from + progress * (clip.to - clip.from));
    }

    /**
     * Pauses playback and puts the bones into a pose: `rest` - the rest pose of the skeleton,
     * `bind` - the pose the mesh was skinned in (often a T- or A-pose).
     * @param {BABYLON.Skeleton} skeleton
     * @param {'rest' | 'bind'} pose
     */
    showPose(skeleton, pose) {
        this.pause();
        skeleton.bones.forEach(bone => setLocalPose(bone, this.poseMatrix(bone, pose)));
    }

    /**
     * @param {BABYLON.Skeleton} skeleton
     * @param {'rest' | 'bind'} pose
     * @returns {boolean} whether every bone is in the pose
     */
    isPose(skeleton, pose) {
        return skeleton.bones.every((bone) => {
            const current = localPose(bone).m, target = this.poseMatrix(bone, pose).m;
            return current.every((value, index) => Math.abs(value - target[index]) < POSE_EPSILON);
        });
    }

    /**
     * Local matrix of a bone in a pose, in the space its pose is set in.
     * @param {BABYLON.Bone} bone
     * @param {'rest' | 'bind'} pose
     * @returns {BABYLON.Matrix}
     */
    poseMatrix(bone, pose) {
        return pose === 'rest' ? bone.getRestMatrix() : this._bindPose(bone);
    }

    /**
     * Changes the bind pose of a bone (where its joint sits relative to the mesh). The mesh
     * vertices stay, so animations deform the mesh around the new joint.
     * @param {BABYLON.Bone} bone
     * @param {BABYLON.Matrix} matrix new local bind matrix in the space of poseMatrix(bone, 'bind')
     * @param {boolean} moveChildren true - the child joints move with the bone; false - they keep
     *   their place relative to the mesh (their local bind matrices are recomputed)
     */
    setBindMatrix(bone, matrix, moveChildren) {
        const stored = this._storedBind(bone, matrix);
        if (!moveChildren) {
            // child abs = child local × bone abs, so keeping it gives child local × old local × new local⁻¹
            const change = bone.getBindMatrix().multiply(stored.clone().invert());
            bone.getChildren().forEach(child => child.updateMatrix(child.getBindMatrix().multiply(change), false, false));
        }
        bone.updateMatrix(stored, true, false);
        bone.markAsDirty();
    }

    /**
     * @param {BABYLON.Skeleton} skeleton
     * @returns {BABYLON.Matrix[]} bind matrices of all bones, for undo
     */
    captureBind(skeleton) {
        return skeleton.bones.map(bone => bone.getBindMatrix().clone());
    }

    /**
     * @param {BABYLON.Skeleton} skeleton
     * @param {BABYLON.Matrix[]} snapshot from captureBind
     */
    restoreBind(skeleton, snapshot) {
        skeleton.bones.forEach((bone, index) => bone.updateMatrix(snapshot[index], false, false));
        // The absolute bind matrices are recomputed from the roots down
        skeleton.bones.filter(bone => !bone.getParent()).forEach(bone => bone.updateMatrix(bone.getBindMatrix().clone(), true, false));
        skeleton.bones.forEach(bone => bone.markAsDirty());
    }

    /**
     * Sets the bind poses of all bones at once, each given in the space of poseMatrix(bone, 'bind')
     * (relative to the parent bone, or to the parent node for a glTF root bone).
     * @param {BABYLON.Skeleton} skeleton
     * @param {BABYLON.Matrix[]} poses one per bone, in the order of `skeleton.bones`
     */
    setBindPoses(skeleton, poses) {
        this.restoreBind(skeleton, skeleton.bones.map((bone, index) => this._storedBind(bone, poses[index])));
    }

    /**
     * Inverse of the glTF root conversion of _bindPose: a matrix relative to the parent node
     * back to the stored bind matrix (in the glTF scene space).
     * @param {BABYLON.Bone} bone
     * @param {BABYLON.Matrix} matrix
     * @returns {BABYLON.Matrix}
     */
    _storedBind(bone, matrix) {
        const node = bone.getTransformNode();
        const parent = /** @type {BABYLON.TransformNode | null} */ (node?.parent ?? null);
        if (!node || bone.getParent() || !parent) return matrix.clone();
        let root = parent;
        while (root.parent) root = /** @type {BABYLON.TransformNode} */ (root.parent);
        return matrix.multiply(parent.getWorldMatrix()).multiply(root.getWorldMatrix().clone().invert());
    }

    /**
     * Local bind matrix of a bone in the space its pose is set in. The bind matrix of a glTF root
     * bone is its world matrix in the glTF scene (the inverse of its inverse bind matrix), while
     * its linked node is relative to its parent node (e.g. a scaled armature), so it is converted:
     * bind × world of the glTF root (`__root__`) × inverse world of the parent node.
     * @param {BABYLON.Bone} bone
     * @returns {BABYLON.Matrix}
     */
    _bindPose(bone) {
        const node = bone.getTransformNode();
        const parent = /** @type {BABYLON.TransformNode | null} */ (node?.parent ?? null);
        if (!node || bone.getParent() || !parent) return bone.getBindMatrix();
        let root = parent;
        while (root.parent) root = /** @type {BABYLON.TransformNode} */ (root.parent);
        return bone.getBindMatrix().multiply(root.getWorldMatrix()).multiply(parent.getWorldMatrix().clone().invert());
    }

    /**
     * Frames that have a key in at least one track of the clip, within its window, ascending
     * (frames closer than FRAME_EPSILON are one).
     * @param {AnimationClip} clip
     * @returns {number[]}
     */
    keyFrames(clip) {
        const frames = [];
        for (const { animation } of clip.group.targetedAnimations) {
            for (const { frame } of modelKeys(animation)) {
                if (frame >= clip.from - FRAME_EPSILON && frame <= clip.to + FRAME_EPSILON) frames.push(frame);
            }
        }
        frames.sort((a, b) => a - b);
        return frames.filter((frame, index) => index === 0 || frame - frames[index - 1] > FRAME_EPSILON);
    }

    /**
     * @param {AnimationClip} clip
     * @returns {boolean} the key frames of the clip are `from`, `from + 1`, … up to its end
     */
    hasConsecutiveFrames(clip) {
        const frames = this.keyFrames(clip);
        return frames.every((frame, index) => Math.abs(frame - (clip.from + index)) < FRAME_EPSILON)
            && Math.abs(clip.to - (clip.from + Math.max(0, frames.length - 1))) < FRAME_EPSILON;
    }

    /**
     * Renumbers the frames of a clip: frames without a key in any track are removed, the others
     * become `from`, `from + 1`, … (the frame rate stays, so a clip that had gaps plays faster).
     * On a shared timeline (ranges of a `.babylon` file) the keys and the clips after the clip
     * move by the same amount, so they keep their place relative to it.
     * @param {AnimationClip} clip
     */
    renumberFrames(clip) {
        const frames = this.keyFrames(clip);
        if (!frames.length) return;
        const { from, to } = clip;
        const end = from + frames.length - 1;
        const shift = end - to;
        const renumber = (frame) => {
            if (frame < from - FRAME_EPSILON) return frame;
            if (frame > to + FRAME_EPSILON) return frame + shift;
            return from + frames.findIndex(candidate => Math.abs(candidate - frame) <= FRAME_EPSILON);
        };
        for (const animation of new Set(clip.group.targetedAnimations.map(({ animation }) => animation))) {
            moveKeys(animation, renumber);
        }
        for (const other of this.clips) {
            if (other !== clip && other.group === clip.group && other.from > to + FRAME_EPSILON) {
                this._setWindow(other, other.from + shift, other.to + shift);
            }
        }
        this._setWindow(clip, from, end);
        this._updateFramesWindow();
    }

    /**
     * @param {AnimationClip} clip
     * @returns {EmptyFrameRange[]} the runs of frames without a key in any track of the clip
     */
    emptyRanges(clip) {
        const frames = this.keyFrames(clip);
        const ranges = [];
        for (let index = 1; index < frames.length; index++) {
            if (frames[index] - frames[index - 1] > 1 + FRAME_EPSILON) ranges.push({ after: frames[index - 1], before: frames[index] });
        }
        return ranges;
    }

    /**
     * Removes runs of frames without keys from the timeline of a clip: the keys after a removed
     * run move back by its length, and so do the windows of all clips on that timeline.
     * @param {AnimationClip} clip
     * @param {EmptyFrameRange[]} ranges
     */
    removeFrameRanges(clip, ranges) {
        const lengths = ranges.map(({ after, before }) => ({ after, length: before - after - 1 }));
        const move = frame => frame - lengths.reduce((sum, { after, length }) => sum + Math.min(length, Math.max(0, frame - after - 1)), 0);
        for (const animation of new Set(clip.group.targetedAnimations.map(({ animation }) => animation))) {
            moveKeys(animation, move);
        }
        // The end of a window inside a removed run stays at the key before it (the start moves to
        // the key after it), so neighbouring clips do not share a frame
        const moveEnd = (frame) => {
            const inside = ranges.find(({ after, before }) => frame > after && frame < before);
            return move(inside ? inside.after : frame);
        };
        for (const other of this.clips) {
            if (other.group === clip.group) this._setWindow(other, move(other.from), moveEnd(other.to));
        }
        this._updateFramesWindow();
    }

    /** The whole timeline spans the keys of its tracks. */
    _updateFramesWindow() {
        const frames = this.frames;
        if (!frames) return;
        let from = Infinity;
        let to = -Infinity;
        for (const { animation } of frames.group.targetedAnimations) {
            const keys = modelKeys(animation);
            if (!keys.length) continue;
            from = Math.min(from, keys[0].frame);
            to = Math.max(to, keys[keys.length - 1].frame);
        }
        if (from > to) return;
        frames.from = from;
        frames.to = to;
    }

    /**
     * @param {AnimationClip} clip
     * @returns {ClipFramesSnapshot} the keys of the clip's tracks and the windows of all clips
     */
    captureFrames(clip) {
        return {
            keys: [...new Set(clip.group.targetedAnimations.map(({ animation }) => animation))]
                .map(animation => ({ animation, keys: animation.getKeys().map(cloneKey) })),
            clips: [...this.clips, ...(this.frames ? [this.frames] : [])].map(other => ({
                clip: other,
                from: other.from,
                to: other.to,
                ranges: other.ranges.map(range => [range.from, range.to]),
                group: [other.group.from, other.group.to],
            })),
        };
    }

    /**
     * @param {ClipFramesSnapshot} snapshot
     */
    restoreFrames(snapshot) {
        snapshot.keys.forEach(({ animation, keys }) => animation.setKeys(keys.map(cloneKey), true));
        for (const { clip, from, to, ranges, group } of snapshot.clips) {
            clip.from = from;
            clip.to = to;
            clip.ranges.forEach((range, index) => { [range.from, range.to] = ranges[index]; });
            if (!clip.ranges.length && !clip.isTimeline) [clip.group.from, clip.group.to] = group;
        }
    }

    /**
     * Moves the frame window of a clip: its ranges, or the bounds of its own group.
     * @param {AnimationClip} clip
     * @param {number} from
     * @param {number} to
     */
    _setWindow(clip, from, to) {
        clip.from = from;
        clip.to = to;
        if (clip.ranges.length) {
            clip.ranges.forEach((range) => { range.from = from; range.to = to; });
        } else {
            clip.group.from = from;
            clip.group.to = to;
        }
    }

    /** Stops playback and releases groups created by this controller. */
    dispose() {
        this.current?.group.stop();
        this._timeline?.dispose();
        this._timeline = null;
        this.frames = null;
        this._rangeOwners = [];
        this.clips = [];
        this.current = null;
        this._playing = false;
    }

    /**
     * Builds clips from animations attached directly to bones and nodes.
     * @param {BABYLON.AssetContainer} container
     * @returns {AnimationClip[]}
     */
    _createTimelineClips(container) {
        const targets = [
            ...container.skeletons.flatMap(skeleton => skeleton.bones),
            ...container.meshes,
            ...container.transformNodes,
        ].filter(target => target.animations?.length);
        if (!targets.length) return [];

        const timeline = new BABYLON.AnimationGroup('All', this._scene);
        for (const target of targets) {
            for (const animation of target.animations) {
                timeline.addTargetedAnimation(animation, target);
            }
        }
        this._timeline = timeline;

        const ranges = this._collectRanges(container);
        if (ranges.length) {
            this.frames = { name: 'Frames', group: timeline, from: timeline.from, to: timeline.to, ranges: [], isTimeline: true };
            this._updateFramesWindow();
        }
        return ranges.length
            ? ranges.map(range => ({
                name: range.name, group: timeline, from: range.from, to: range.to,
                ranges: this._rangeOwners.map(owner => owner.getAnimationRange(range.name)).filter(Boolean),
            }))
            : [{ name: timeline.name, group: timeline, from: timeline.from, to: timeline.to, ranges: [] }];
    }

    /**
     * Collects named animation ranges of skeletons and nodes, de-duplicated by name.
     * @param {BABYLON.AssetContainer} container
     * @returns {BABYLON.AnimationRange[]}
     */
    _collectRanges(container) {
        const owners = [...container.skeletons, ...container.meshes, ...container.transformNodes];
        /** @type {Map<string, BABYLON.AnimationRange>} */
        const ranges = new Map();
        this._rangeOwners = owners.filter(owner => owner.getAnimationRanges?.().some(Boolean));
        for (const owner of this._rangeOwners) {
            for (const range of owner.getAnimationRanges()) {
                if (range && !ranges.has(range.name)) {
                    ranges.set(range.name, range);
                }
            }
        }
        return [...ranges.values()];
    }
}
