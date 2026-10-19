import * as BABYLON from '@babylonjs/core';
import { modelKeys } from './AnimationController';

const RAD_TO_DEG = 180 / Math.PI;
const DEG_TO_RAD = Math.PI / 180;
const FRAME_EPSILON = 1e-6;

/** Animated property name -> transform channel. */
const CHANNEL_BY_PROPERTY = {
    _matrix: 'matrix',
    position: 'position',
    rotationQuaternion: 'rotation',
    rotation: 'rotation',
    scaling: 'scaling',
};

const COMPONENT_LABELS = ['PX', 'PY', 'PZ', 'RX°', 'RY°', 'RZ°', 'SX', 'SY', 'SZ'];
const COMPONENT_GROUPS = ['position', 'rotation', 'scaling'];
/** Curve colors of the X / Y / Z components in the graph view. */
const AXIS_COLORS = ['#e5534b', '#57ab5a', '#539bf5'];
/** Colors of the clip bands on the graph of the whole timeline (no red: it marks picked ranges). */
const CLIP_COLORS = ['#539bf5', '#57ab5a', '#b083f0', '#d4a72c', '#39c5cf', '#e275ad', '#8ddb8c', '#96d0ff'];

/**
 * Transform animations of one target (bone or node) within a clip. `.babylon` bones animate a
 * single local matrix; glTF nodes animate position / rotationQuaternion / scaling separately.
 * @typedef {object} TransformChannels
 * @property {BABYLON.Bone | BABYLON.TransformNode} target
 * @property {BABYLON.Animation} [matrix]
 * @property {BABYLON.Animation} [position]
 * @property {BABYLON.Animation} [rotation] quaternion or Euler (radians) animation
 * @property {BABYLON.Animation} [scaling]
 */

/** Frame shown in the inspector per clip (reset to the first frame when the clip is opened). */
const shownFrames = new WeakMap();

/**
 * @param {import('./AnimationController').EmptyFrameRange} range
 * @returns {string} e.g. `319–329` or `319`
 */
function formatFrames({ after, before }) {
    const first = after + 1;
    const last = before - 1;
    return Math.abs(last - first) < FRAME_EPSILON ? `Frame ${first}` : `Frames ${first}–${last}`;
}

/**
 * @param {BABYLON.IAnimationKey} key
 * @returns {BABYLON.IAnimationKey}
 */
function cloneKey(key) {
    return { ...key, value: key.value?.clone ? key.value.clone() : key.value };
}

/**
 * @param {any} value
 * @returns {any}
 */
function cloneValue(value) {
    return value?.clone ? value.clone() : value;
}

/**
 * Groups the transform animations of a clip by target.
 * @param {import('./AnimationController').AnimationClip} clip
 * @returns {{ rows: TransformChannels[], other: number }} other - animated non-transform properties
 */
function collectChannels(clip) {
    /** @type {Map<any, TransformChannels>} */
    const byTarget = new Map();
    let other = 0;
    for (const { target, animation } of clip.group.targetedAnimations) {
        const channel = CHANNEL_BY_PROPERTY[animation.targetProperty];
        if (!channel || !target) {
            other++;
            continue;
        }
        const channels = byTarget.get(target) ?? { target };
        channels[channel] = animation;
        byTarget.set(target, channels);
    }
    return { rows: [...byTarget.values()], other };
}

/**
 * @param {TransformChannels} channels
 * @returns {BABYLON.Animation[]}
 */
function animationsOf(channels) {
    return [channels.matrix, channels.position, channels.rotation, channels.scaling].filter(Boolean);
}

/**
 * @param {BABYLON.Animation} animation
 * @param {number} frame
 * @returns {number} key index, or -1
 */
function keyIndexAt(animation, frame) {
    return animation.getKeys().findIndex(key => Math.abs(key.frame - frame) < FRAME_EPSILON);
}

/**
 * Returns the key at the frame, inserting one with the interpolated value when there is none.
 * @param {BABYLON.Animation} animation
 * @param {number} frame
 * @returns {BABYLON.IAnimationKey}
 */
function ensureKey(animation, frame) {
    const keys = animation.getKeys();
    const index = keyIndexAt(animation, frame);
    if (index >= 0) return keys[index];
    const key = { frame, value: cloneValue(animation.evaluate(frame)) };
    const insertAt = keys.findIndex(existing => existing.frame > frame);
    keys.splice(insertAt < 0 ? keys.length : insertAt, 0, key);
    animation.setKeys(keys, true);
    return key;
}

/**
 * @param {BABYLON.Matrix} matrix
 * @returns {number[]} position, Euler rotation in degrees, scaling
 */
function decomposeMatrix(matrix) {
    const scaling = new BABYLON.Vector3(), rotation = new BABYLON.Quaternion(), position = new BABYLON.Vector3();
    matrix.decompose(scaling, rotation, position);
    return [...position.asArray(), ...rotation.toEulerAngles().asArray().map(radians => radians * RAD_TO_DEG), ...scaling.asArray()];
}

/**
 * @param {number[]} parts position, Euler rotation in degrees, scaling
 * @returns {BABYLON.Matrix}
 */
function composeMatrix(parts) {
    return BABYLON.Matrix.Compose(
        BABYLON.Vector3.FromArray(parts, 6),
        BABYLON.Quaternion.FromEulerAngles(...parts.slice(3, 6).map(degrees => degrees * DEG_TO_RAD)),
        BABYLON.Vector3.FromArray(parts, 0),
    );
}

/**
 * Reads position / rotation° / scaling of a value of the rotation channel.
 * @param {BABYLON.Animation} animation
 * @param {any} value
 * @returns {number[]}
 */
function rotationToDegrees(animation, value) {
    const euler = animation.dataType === BABYLON.Animation.ANIMATIONTYPE_QUATERNION ? value.toEulerAngles() : value;
    return euler.asArray().map(radians => radians * RAD_TO_DEG);
}

/**
 * @param {BABYLON.Animation} animation
 * @param {number[]} degrees
 * @returns {any}
 */
function rotationFromDegrees(animation, degrees) {
    const radians = degrees.map(value => value * DEG_TO_RAD);
    return animation.dataType === BABYLON.Animation.ANIMATIONTYPE_QUATERNION
        ? BABYLON.Quaternion.FromEulerAngles(...radians)
        : BABYLON.Vector3.FromArray(radians);
}

/**
 * Transform of a target at a frame as 9 components (null where the channel is not animated).
 * @param {TransformChannels} channels
 * @param {number} frame
 * @returns {(number | null)[]}
 */
function readTransform(channels, frame) {
    if (channels.matrix) return decomposeMatrix(channels.matrix.evaluate(frame));
    const read = (animation, convert) => animation ? convert(animation.evaluate(frame)) : [null, null, null];
    return [
        ...read(channels.position, value => value.asArray()),
        ...read(channels.rotation, value => rotationToDegrees(channels.rotation, value)),
        ...read(channels.scaling, value => value.asArray()),
    ];
}

/**
 * Sets one transform component at a frame, creating keys where needed.
 * @param {TransformChannels} channels
 * @param {number} frame
 * @param {number} component 0..8
 * @param {number} value
 */
function writeTransform(channels, frame, component, value) {
    if (channels.matrix) {
        const key = ensureKey(channels.matrix, frame);
        const parts = decomposeMatrix(key.value);
        parts[component] = value;
        key.value = composeMatrix(parts);
        channels.matrix.setKeys(channels.matrix.getKeys(), true);
        return;
    }
    const group = COMPONENT_GROUPS[Math.floor(component / 3)];
    const animation = channels[group];
    const key = ensureKey(animation, frame);
    if (group === 'rotation') {
        const degrees = rotationToDegrees(animation, key.value);
        degrees[component % 3] = value;
        key.value = rotationFromDegrees(animation, degrees);
    } else {
        const parts = key.value.asArray();
        parts[component % 3] = value;
        key.value = BABYLON.Vector3.FromArray(parts);
    }
    animation.setKeys(animation.getKeys(), true);
}

/**
 * @param {TransformChannels} channels
 * @returns {{ animation: BABYLON.Animation, keys: BABYLON.IAnimationKey[] }[]}
 */
function captureKeys(channels) {
    return animationsOf(channels).map(animation => ({ animation, keys: animation.getKeys().map(cloneKey) }));
}

/**
 * @param {{ animation: BABYLON.Animation, keys: BABYLON.IAnimationKey[] }[]} snapshot
 */
function restoreKeys(snapshot) {
    snapshot.forEach(({ animation, keys }) => animation.setKeys(keys.map(cloneKey), true));
}

/**
 * Inspector content of an animation clip: clip properties and the transforms of all animated
 * bones/nodes at a selected frame (the first frame by default). Editing a value at a frame
 * without a key inserts a key with the interpolated value first.
 */
export class ClipFrameEditor {

    /**
     * Graph additions of the whole timeline: a band per clip, and the removal of empty frame
     * ranges — **Remove empty ranges** marks every run of frames without keys as picked, a click
     * on a picked range unpicks it (it stays, darker) and back, **Delete** removes the picked ones.
     * @param {import('./AnimationController').AnimationClip} clip the whole timeline
     * @param {import('./ModelProperties').PropertiesContext} context
     * @param {() => number} frame the shown frame
     * @param {(frame: number) => void} goTo
     * @returns {Pick<import('./CurveTable').CurveData, 'bands' | 'actions'>}
     */
    static _timelineTools(clip, { animations, history }, frame, goTo) {
        /** @type {(import('./AnimationController').EmptyFrameRange & { picked: boolean })[] | null} */
        let removal = null;
        const picked = () => (removal ?? []).filter(range => range.picked);
        const clipBands = () => animations.clips
            .filter(other => other.group === clip.group)
            .map((other, index) => ({ from: other.from, to: other.to, label: other.name, color: CLIP_COLORS[index % CLIP_COLORS.length], kind: 'clip' }));
        const removalBands = () => (removal ?? []).map(range => ({
            from: range.after + 0.5,
            to: range.before - 0.5,
            label: `${formatFrames(range)} without keys${range.picked ? '' : ' (kept)'}`,
            kind: range.picked ? 'selected' : 'deselected',
            onClick: () => { range.picked = !range.picked; },
        }));
        const restore = (snapshot) => {
            animations.restoreFrames(snapshot);
            goTo(Math.min(frame(), clip.to));
        };
        return {
            bands: () => [...clipBands(), ...removalBands()],
            actions: [
                {
                    label: 'Remove empty ranges',
                    title: 'Mark the frames without keys to remove them; a click on a range keeps it',
                    icon: 'filter',
                    isHidden: () => removal !== null,
                    isDisabled: () => !animations.emptyRanges(clip).length,
                    run: () => { removal = animations.emptyRanges(clip).map(range => ({ ...range, picked: true })); },
                },
                {
                    label: () => `Delete ${picked().length} of ${removal?.length ?? 0}`,
                    title: 'Remove the picked ranges: the frames after them move back',
                    icon: 'trash',
                    isHidden: () => removal === null,
                    isDisabled: () => !picked().length,
                    run: () => {
                        const ranges = picked().map(({ after, before }) => ({ after, before }));
                        removal = null;
                        history.executeMutation('Remove empty frames', () => animations.captureFrames(clip), () => {
                            animations.removeFrameRanges(clip, ranges);
                            goTo(Math.min(frame(), clip.to));
                        }, restore);
                    },
                },
                {
                    label: 'Cancel',
                    title: 'Leave the removal of empty ranges',
                    icon: 'close',
                    isHidden: () => removal === null,
                    run: () => { removal = null; },
                },
            ],
        };
    }

    /**
     * @param {import('./AnimationController').AnimationClip} clip
     * @returns {number}
     */
    static shownFrame(clip) {
        return shownFrames.get(clip) ?? clip.from;
    }

    /**
     * Makes the frame the clip stopped at (pause, seek) the frame of the inspector.
     * @param {import('./AnimationController').AnimationClip} clip
     * @param {number} frame
     */
    static setShownFrame(clip, frame) {
        shownFrames.set(clip, Math.min(clip.to, Math.max(clip.from, Math.round(frame))));
    }

    /**
     * Skeleton animated by a clip: `.babylon` clips target bones, glTF clips target the
     * transform nodes linked to bones.
     * @param {import('./AnimationController').AnimationClip} clip
     * @param {BABYLON.AssetContainer} container
     * @returns {BABYLON.Skeleton | null}
     */
    static skeletonOf(clip, container) {
        for (const { target } of clip.group.targetedAnimations) {
            if (target instanceof BABYLON.Bone) return target.getSkeleton();
            const skeleton = container.skeletons.find(candidate => candidate.bones.some(bone => bone.getTransformNode() === target));
            if (skeleton) return skeleton;
        }
        return null;
    }

    /**
     * @param {import('./AnimationController').AnimationClip} clip
     * @param {import('./ModelProperties').PropertiesContext} context
     * @param {import('./PropertyPanel').PropertyDescriptor[]} clipProperties name / range properties (only the range for the whole timeline)
     * @returns {import('./PropertyPanel').PanelContent}
     */
    static describe(clip, context, clipProperties) {
        const { animations, history, highlighter, playClip, pauseAnimation, showFrame, selectedRow } = context;
        const { rows, other } = collectChannels(clip);
        shownFrames.set(clip, clip.from);
        const frame = () => ClipFrameEditor.shownFrame(clip);
        const isPlaying = () => animations.isPlaying && animations.current === clip;
        const goTo = (value) => {
            // Picking a frame (a click on the graph, the Frame property) stops the playing clip
            if (animations.isPlaying) pauseAnimation();
            const clamped = Math.min(clip.to, Math.max(clip.from, Math.round(value)));
            shownFrames.set(clip, clamped);
            showFrame(clip, clamped);
        };
        const hasKey = (row) => animationsOf(rows[row]).some(animation => keyIndexAt(animation, frame()) >= 0);
        const restore = (snapshot) => {
            restoreKeys(snapshot);
            showFrame(clip, frame());
        };

        /** @type {import('./DataTable').TableColumn[]} */
        const columns = [
            { label: 'Bone / node', title: true, get: row => `${rows[row].target.name}${hasKey(row) ? ' ◆' : ''}` },
            ...COMPONENT_LABELS.map((label, component) => ({
                label,
                group: COMPONENT_GROUPS[Math.floor(component / 3)],
                get: row => readTransform(rows[row], frame())[component] ?? '',
                isEditable: row => !!(rows[row].matrix || rows[row][COMPONENT_GROUPS[Math.floor(component / 3)]]),
                set: (row, value) => {
                    writeTransform(rows[row], frame(), component, value);
                    showFrame(clip, frame());
                },
                capture: row => captureKeys(rows[row]),
                restore: (_, snapshot) => restore(snapshot),
            })),
        ];

        const groups = COMPONENT_GROUPS.map(key => ({ key, label: key[0].toUpperCase() + key.slice(1) }));
        const channelAnimation = (row, component) => rows[row].matrix ?? rows[row][COMPONENT_GROUPS[Math.floor(component / 3)]];

        /** @type {import('./CurveTable').CurveData} */
        const curves = {
            channels: COMPONENT_LABELS.map((label, component) => ({
                label,
                color: AXIS_COLORS[component % 3],
                group: COMPONENT_GROUPS[Math.floor(component / 3)],
            })),
            groups,
            rowCount: () => rows.length,
            label: row => rows[row].target.name,
            range: () => ({ from: clip.from, to: clip.to }),
            sample: (row, frame) => readTransform(rows[row], frame),
            keys: (row, component) => (channelAnimation(row, component) ? modelKeys(channelAnimation(row, component)) : [])
                .map(key => key.frame)
                .filter(keyFrame => keyFrame >= clip.from - FRAME_EPSILON && keyFrame <= clip.to + FRAME_EPSILON),
            isEditable: (row, component) => !!channelAnimation(row, component),
            setKey: (row, component, keyFrame, value) => {
                writeTransform(rows[row], keyFrame, component, value);
                showFrame(clip, frame());
            },
            capture: row => captureKeys(rows[row]),
            restore: (_, snapshot) => restore(snapshot),
            // While the clip plays, the graph marks the playing frame
            currentFrame: () => (animations.isPlaying && animations.current === clip ? animations.currentFrame : frame()),
            selectFrame: goTo,
            isPlaying,
            ...(clip.isTimeline ? ClipFrameEditor._timelineTools(clip, context, frame, goTo) : {}),
        };

        /** @type {import('./PropertyPanel').PropertyDescriptor[]} */
        // Name and the bone count first; in two columns they share the first row
        const frameProperty = { label: 'Frame', type: 'number', transient: true, get: frame, set: goTo };
        const bonesProperty = { label: 'Animated bones', type: 'readonly', get: () => rows.length };
        const [nameProperty, ...rangeProperties] = clipProperties;
        // The whole timeline has no name of its own: the frame comes first, the header names its clip
        const properties = clip.isTimeline
            ? [frameProperty, bonesProperty, ...clipProperties]
            : [nameProperty, bonesProperty, ...rangeProperties, frameProperty];
        const clipAtFrame = () => animations.clips
            .find(other => other.group === clip.group && frame() >= other.from - FRAME_EPSILON && frame() <= other.to + FRAME_EPSILON);
        if (other > 0) {
            properties.push({ label: 'Other tracks', type: 'readonly', get: () => `${other} (not editable here)` });
        }

        return {
            title: clip.isTimeline ? 'Frames' : 'Animation',
            twoColumns: true,
            subtitle: () => (clip.isTimeline ? clipAtFrame()?.name ?? 'No animation at this frame' : clip.name),
            properties,
            actions: [
                {
                    label: () => isPlaying() ? 'Pause' : 'Play',
                    title: () => isPlaying() ? 'Pause animation' : 'Play animation',
                    icon: () => isPlaying() ? 'debug-pause' : 'play',
                    transient: true,
                    run: () => isPlaying() ? pauseAnimation() : playClip(clip),
                },
                { label: 'Prev', title: 'Previous frame', icon: 'chevron-left', transient: true, run: () => goTo(frame() - 1), isDisabled: () => frame() <= clip.from },
                { label: 'Next', title: 'Next frame', icon: 'chevron-right', transient: true, run: () => goTo(frame() + 1), isDisabled: () => frame() >= clip.to },
                {
                    label: 'Renumber',
                    title: 'Renumber the frames: frames without a key in any bone are removed, the others follow one by one',
                    icon: 'list-ordered',
                    // The whole timeline drops its empty ranges on the graph instead
                    isHidden: () => !!clip.isTimeline,
                    isDisabled: () => animations.hasConsecutiveFrames(clip),
                    run: () => {
                        if (isPlaying()) pauseAnimation();
                        history.executeMutation('Renumber frames', () => animations.captureFrames(clip), () => {
                            animations.renumberFrames(clip);
                            goTo(Math.min(frame(), clip.to));
                        }, (snapshot) => {
                            animations.restoreFrames(snapshot);
                            goTo(Math.min(frame(), clip.to));
                        });
                    },
                },
                {
                    label: 'Delete keys',
                    title: 'Delete keys at frame',
                    icon: 'trash',
                    isDisabled: () => selectedRow() < 0 || !hasKey(selectedRow()),
                    run: () => {
                        const channels = rows[selectedRow()];
                        if (!channels) return;
                        history.executeMutation(`Delete keys at frame ${frame()}`, () => captureKeys(channels), () => {
                            for (const animation of animationsOf(channels)) {
                                const index = keyIndexAt(animation, frame());
                                // An animation needs at least one key
                                if (index < 0 || animation.getKeys().length < 2) continue;
                                const keys = animation.getKeys();
                                keys.splice(index, 1);
                                animation.setKeys(keys, true);
                            }
                            showFrame(clip, frame());
                        }, restore);
                    },
                },
            ],
            table: {
                title: 'Animated bones',
                columns,
                groups,
                notice: 'Bone values at the selected frame. ◆ marks a key at this frame; editing a value where there is no key creates one.',
                rowCount: () => rows.length,
                onSelectRow: row => highlighter.selectBone(rows[row]?.target ?? null),
                // glTF clips animate the transform node linked to the bone
                rowOf: object => rows.findIndex(({ target }) => target === object
                    || (object instanceof BABYLON.Bone && target === object.getTransformNode())),
            },
            curves,
        };
    }
}
