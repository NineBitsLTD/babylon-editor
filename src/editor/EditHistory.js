/**
 * @typedef {object} EditCommand
 * @property {string} label shown by VS Code in the undo/redo UI
 * @property {() => void} apply
 * @property {() => void} revert
 */

/**
 * Undo/redo stack of the webview. VS Code owns the undo UI for custom editors:
 * every executed command is reported to the extension host, which registers an edit
 * whose undo/redo callbacks are sent back here as 'undo'/'redo' messages.
 */
export class EditHistory {

    /**
     * @param {{
     *   onExecute: (command: EditCommand) => void,
     *   onChange: (command: EditCommand) => void
     * }} handlers onExecute - a new command was executed (report it to the host);
     *   onChange - the model changed through execute/undo/redo (refresh the UI)
     */
    constructor({ onExecute, onChange }) {
        this._onExecute = onExecute;
        this._onChange = onChange;
        /** @type {EditCommand[]} */
        this._undoStack = [];
        /** @type {EditCommand[]} */
        this._redoStack = [];
    }

    /**
     * Applies a command and records it.
     * @param {EditCommand} command
     */
    execute(command) {
        command.apply();
        this._undoStack.push(command);
        this._redoStack = [];
        this._onExecute(command);
        this._onChange(command);
    }

    /**
     * Records a mutation through state snapshots: `capture` is called before and after
     * `mutate`, undo/redo restore the corresponding snapshot. Suits changes that are easier
     * to snapshot than to invert (animation keys, vertex buffers, bone matrices).
     * @template T
     * @param {string} label
     * @param {() => T} capture
     * @param {() => void} mutate
     * @param {(state: T) => void} restore
     */
    executeMutation(label, capture, mutate, restore) {
        const before = capture();
        let after = null;
        this.execute({
            label,
            apply: () => {
                if (after === null) {
                    mutate();
                    after = capture();
                } else {
                    restore(after);
                }
            },
            revert: () => restore(before),
        });
    }

    undo() {
        const command = this._undoStack.pop();
        if (!command) return;
        command.revert();
        this._redoStack.push(command);
        this._onChange(command);
    }

    redo() {
        const command = this._redoStack.pop();
        if (!command) return;
        command.apply();
        this._undoStack.push(command);
        this._onChange(command);
    }

    /** Forgets all commands (after the model was reloaded from disk). */
    clear() {
        this._undoStack = [];
        this._redoStack = [];
    }
}

/**
 * History of an editor whose model is a text document (`.babylon`): a command is applied to the
 * model and its effect is sent to the document as patches. The undo stack is the document's own
 * (VS Code undoes the text, and the change comes back as patches), so undo/redo do nothing here.
 * Same interface as EditHistory.
 */
export class DocumentEditHistory {

    /**
     * @param {{
     *   collect: () => import('./BabylonJsonBinding').JsonPatch[],
     *   onPatches: (label: string, patches: import('./BabylonJsonBinding').JsonPatch[]) => void,
     *   onChange: (command: EditCommand) => void
     * }} handlers collect - patches for the changes made to the model since the last call
     */
    constructor({ collect, onPatches, onChange }) {
        this._collect = collect;
        this._onPatches = onPatches;
        this._onChange = onChange;
    }

    /**
     * @param {EditCommand} command
     */
    execute(command) {
        command.apply();
        const patches = this._collect();
        if (patches.length) this._onPatches(command.label, patches);
        this._onChange(command);
    }

    /**
     * @param {string} label
     * @param {() => any} capture unused: the document keeps the previous state
     * @param {() => void} mutate
     */
    executeMutation(label, capture, mutate) {
        this.execute({ label, apply: mutate, revert: () => {} });
    }

    undo() {}

    redo() {}

    clear() {}
}
