import * as vscode from 'vscode';

/** Replies of the editor webview to tasks, by request type. */
const REPLIES = {
    validate: 'validated',
    convertModel: 'converted',
    exportModel: 'exported',
};

/** A task that takes longer is reported as failed. */
const TASK_TIMEOUT = 120000;

/**
 * Work that needs Babylon with a GPU (checking, converting and exporting models) and therefore
 * runs in an editor webview: an open editor of the model, or a temporary helper panel. The editor
 * panels pass their messages to `handleMessage`, so replies reach the waiting task.
 */
export class WebviewTasks {

    /**
     * @param {import('./BabylonEditor').BabylonEditor} webviews sets up the editor webview
     */
    constructor(webviews) {
        this._webviews = webviews;
        /** @type {Map<number, (message: any) => void>} */
        this._pending = new Map();
        this._nextRequestId = 0;
    }

    /**
     * Sends a task to a webview and waits for its reply.
     * @param {vscode.WebviewPanel} panel
     * @param {keyof typeof REPLIES} type
     * @param {object} payload fields of the message (not `type` / `requestId`)
     * @returns {Promise<any>} the reply message (`error` set when the task failed)
     */
    run(panel, type, payload) {
        const requestId = ++this._nextRequestId;
        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                this._pending.delete(requestId);
                resolve({ error: 'The editor did not finish in time.' });
            }, TASK_TIMEOUT);
            this._pending.set(requestId, (message) => {
                clearTimeout(timeout);
                resolve(message);
            });
            panel.webview.postMessage({ type, requestId, ...payload });
        });
    }

    /**
     * @param {any} message a message of an editor webview
     * @returns {boolean} whether it was the reply to a task
     */
    handleMessage(message) {
        if (!Object.values(REPLIES).includes(message?.type) || !this._pending.has(message.requestId)) return false;
        this._pending.get(message.requestId)(message);
        this._pending.delete(message.requestId);
        return true;
    }

    /**
     * Runs work in a temporary editor webview (no model) that is closed afterwards.
     * @template T
     * @param {vscode.Uri} uri the model (relative resources are resolved against its folder)
     * @param {string} title
     * @param {(panel: vscode.WebviewPanel) => Promise<T>} work
     * @returns {Promise<T>}
     */
    async withHelper(uri, title, work) {
        const panel = vscode.window.createWebviewPanel(
            'babylon-editor.helper',
            title,
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        );
        try {
            await new Promise((resolve) => {
                panel.webview.onDidReceiveMessage((message) => {
                    if (message.type === 'ready') resolve(undefined);
                    else this.handleMessage(message);
                });
                this._webviews.setupWebview(panel, { uri, type: 'babylon', mimeType: 'application/json' }, { textBacked: true });
            });
            return await work(panel);
        } finally {
            panel.dispose();
        }
    }
}
