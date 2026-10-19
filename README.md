# Babylon Editor

A Visual Studio Code extension that renders 3D model files directly inside the editor using [Babylon.js](https://www.babylonjs.com/). Open a model to inspect it in an interactive viewport, then edit its nodes, materials, bones, animations and vertices and save it back — no external tools or web server required.

## Features

- **3D view** — open a supported model file and it renders immediately in an interactive Babylon.js viewport, with camera auto-orbit (off on open, toggle in the player at the top of the view). Drag with the left button to rotate, with the right button to move the model, scroll to zoom; the home button in the player resets the view.
- **Animations** — pick a clip in the model tree; the inspector lists all animated bones with their position, rotation or scaling (switch above the table) at a selected frame, as a table or as graphs (curves per frame with draggable keys, horizontal and vertical zoom) (the first frame by default; step with **Prev** / **Next**). Edit a value to change the pose at that frame — a key is created if the frame has none (◆ marks existing keys). **Play** plays the clip and turns into **Pause** while it plays; the player shows the current clip with play/pause and a seek slider. glTF animation groups and the named animation ranges of `.babylon` skeletons are both listed.
- **Skeleton mode** — selecting a skeleton or a clip shows the bones as pyramids pointing from each joint to its child joints (the selected bone is highlighted; click a bone to select it in the inspector, click it again to deselect). The skeleton inspector lists all bones as a table (bones are not listed in the tree) with a **Rest | Bind** switch: the rest pose is editable; the bind pose (where the joints sit relative to the mesh) is editable too, with a warning that it changes how every animation deforms the mesh, and a **Move children** toggle (move the child joints with the edited bone or keep them in place). The **Rest pose** / **Bind pose** button next to the switch stops the animation and the auto-orbit and shows that pose. Double-click a bone name to rename it. Toggles in the player at the top of the model view show or hide the mesh and the bones (both are shown by default).
- **Tree editing** — right-click a section to add an object (mesh, material, texture, skeleton, clip, camera, light), right-click an object to rename or delete it. Changed objects are colored like changed files (M / A) until the file is saved. Clicking a section only expands it; clicking the shown object again goes back to the file view (also the ← button in the inspector).
- **Model tree in the Explorer** — the **Babylon Model** view in the Explorer sidebar lists nodes, materials, textures, skeletons and animations of the active model; selecting an item opens it in the inspector. The tree lists root nodes only: the transform nodes and meshes below a node are the **Nodes** and **Parts** lists of its inspector, the textures of a material its **Textures** list (with the slot, e.g. diffuse / ambient). A list entry opens like an accordion (one at a time) with the main properties and **Open** (its own inspector, ← returns), **Rename…** and **Delete**.
- **File fields** — before an item is selected, the inspector shows the values of the file that are not in the tree: for `.babylon` all scene fields of the format (producer, autoClear, clearColor, gravity, collisions, physics, auto-animate, fog, …; editable — fields the file does not have yet are shown dimmed with Babylon's default and are added when set), for glTF the asset info and counts, for OBJ/STL/PLY their header.
- **All format fields** — every inspector also lists the other fields of the `.babylon` format for that object (mesh, material, texture, camera, light, shadow generator, skeleton), including those the file does not set.
- **Cameras and lights** — the tree lists the cameras and lights of the model (a light's shadow generator is its child) with editable properties.
- **Inspector** — always shown next to the 3D view: an inspector (drag its left edge to resize, double-click to reset) with editable properties: node name/transform/material, material colors and parameters, texture UV settings, bone rest pose, clip name and frame range, bone transforms per frame (edit, delete keys) and vertex positions/normals/UVs. The selection is highlighted in the 3D view. Undo/redo and dirty state work as in any VS Code editor.
- **One format for editing** — `.glb`, `.gltf`, `.obj` and `.stl` files are converted to a clean `.babylon` document when opened (`Street.obj.babylon`): the 3D editor, the raw text and the compact view work on it like on a `.babylon` file, and saving converts it back into the original file (`.gltf` cannot be written back: use Save Model As). Formats that cannot hold everything (OBJ and STL drop skeletons, animations, cameras and lights) are named once per session before saving.
- **Frames** — for models whose clips are ranges of one timeline, the first item of Animations shows all frames of all bones (table and graph) and plays the whole timeline; the graph marks every clip with a colored band. **Remove empty ranges** marks the runs of frames without keys (click one to keep it, it turns dark) and **Delete** removes the marked ones, moving the following frames and clips back. **Renumber** in a clip inspector removes the frames without keys of that clip.
- **Save Model As…** (Ctrl/Cmd+Shift+S) — writes the model as `.babylon`, `.glb`, `.obj` or `.stl`.
- **View switch** — the toolbar shows the model, the inspector or both (Desktop); the player (auto-orbit, play/pause, seek slider, current clip, and the render mode: with textures, without textures or as lines) is at the top of the model view.
- **Parts and textures** — a part of a mesh can be hidden in the 3D view (eye button in the Parts list; the file is not changed); material texture slots are picked from the model's textures; the texture inspector shows a preview of the image.
- **Saving** — `.babylon` documents are saved as their text. `.ply`, `.splat` and `.spz` are view-only for now.
- **Local resource resolution** — external resources referenced by a model (textures, `.bin` buffers) are loaded through the VS Code filesystem, so multi-file glTF scenes work out of the box.

### Supported formats

`.babylon`, `.glb`, `.gltf`, `.gltf2`, `.obj`, `.stl`, `.ply`, `.splat`, `.spz`

**One document, three views (`.babylon`)** — the 3D editor, the raw text and the compact text show the same document live: an edit in any of them appears in the others at once, Undo/Redo works across them, and saving writes the text as it is (the file is not regenerated). The 3D editor can be split into two views. While the text is broken (not valid JSON) the 3D view keeps the last model and shows a format error. **Ctrl/Cmd+S** first checks that the model loads and asks before saving a file that does not.

**Compact text view** — a `.babylon` file opened as text (**Reopen Editor With… → Text Editor**, or **Open as Compact Text** in the Explorer context menu / the editor title) is shown as small, fully highlighted JSON: vertex buffers, animation keys and embedded textures are replaced by `"…#12"` placeholders. Click **Expand** above a placeholder to insert its values and edit them; on save the remaining values are written back unchanged. **Open as Raw Text** shows the unchanged file; the title buttons **Open as Compact Text** / **Open as Raw Text** switch between the two views in the same tab, and **Open in Babylon Editor** replaces the text with the 3D editor (the 3D editor title has the two text buttons); the `babylonEditor.collapseTextEditor` setting turns the collapsed view off.

`.babylon`, `.gltf` and `.gltf2` are JSON: opened with **Reopen Editor With… → Text Editor** they get the JSON highlighting, formatting and validation of VS Code.

## Requirements

- Visual Studio Code `^1.107.0`
- Node.js (with `npm`) to build the extension from source

## Getting started (development)

The extension entry point is the **bundled** output in `dist/`, not `src/` — so you must build (or watch) before launching.

```bash
npm install        # install dependencies
npm run watch      # build once, then rebuild on change (esbuild + sass)
```

Then press **F5** in VS Code to launch the "Run Extension" configuration. This opens a second VS Code window (the Extension Development Host) with the extension loaded. In that window:

- open any supported model file → it opens in the **Babylon Editor** custom editor.

For a one-off production build without watchers:

```bash
npm run build      # clean → bundle extension + webview + css → copy codicons and assets into dist/
```

> **Note:** viewing happens entirely inside VS Code webviews — there is no HTTP server or standalone browser mode. To inspect a model outside VS Code, use a hosted viewer such as the [Babylon.js Sandbox](https://sandbox.babylonjs.com/).

## Architecture

Source is authored as **ESM** and bundled with **esbuild** into two targets, each running in a different environment:

| Target | Source | Output | Runtime |
| --- | --- | --- | --- |
| Extension host | `src/extension.js` | `dist/extension.cjs` | Node (VS Code extension host) |
| Editor webview | `src/editor.js` | `dist/js/editor.js` | Browser sandbox — uses `@babylonjs/core` (raw `Engine` + `Scene`) |

Key pieces:

- **`BabylonDocument`** wraps the raw file bytes and derives the file type, MIME type (magic-byte sniffing), and an exact copy of the bytes for the webview.
- **`VSCodeFSProvider`** implements Babylon's `IOfflineProvider` over `vscode.workspace.fs`, intended to let Babylon resolve external model resources through the VS Code filesystem (not wired in yet).
- The webview HTML is generated by a small **custom JSX runtime** (`src/utils/jsx-runtime.js`) that renders JSX to HTML strings — this project does **not** use React.

The webview receives file metadata via an injected `window.payload` object and the model bytes via `postMessage` (sent once the webview reports it is ready). Relative resources (textures, `.bin`, `.mtl`) are loaded from the workspace folder.

## Project layout

```
src/
  extension.js              # extension entry point (activate / commands)
  editor.js                 # editor webview entry (@babylonjs/core): scene, modes, model loading
  editor/                   # UI widgets (Toolbar, PropertyPanel, DataTable, CurveTable, PanelResizer, EditHistory, ModelTreeBridge) and
                            # model logic (AnimationController, CameraController, SelectionHighlighter, SkeletonView,
                            # ModelOutline, ModelProperties, ClipFrameEditor, ModelSerializer)
  components/               # BabylonEditor, BabylonDocument, ModelTreeProvider (Explorer view), VSCodeFSProvider
  utils/                    # parsers (glb/babylon/obj) + mime/extension/base64 helpers + jsx-runtime
  scss/                     # editor.scss → compiled to dist/css/
dist/                       # bundled output loaded by VS Code (git-ignored)
```

## Build scripts

| Script | Purpose |
| --- | --- |
| `npm run build` | Full production build into `dist/` |
| `npm run watch` | Build once, then run all esbuild/sass watchers concurrently |
| `build:js` / `build:js-editor` / `build:css` | Rebuild a single target |

## License

MIT
