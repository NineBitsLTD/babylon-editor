import * as vscode from 'vscode';

/**
 * Host services an editor webview cannot do itself: file dialogs, the text clipboard and
 * notifications. A request `{ type, requestId, … }` is answered by
 * `{ type: 'hostReply', requestId, result }` or `{ type: 'hostReply', requestId, error }`
 * (`HostRequests` in the webview).
 *
 * Requests:
 * - `saveFile` `{ data: ArrayBuffer, fileName, filters? }` asks where to save the bytes (starting in
 *   the model folder); result: the saved path, or null when cancelled
 * - `openFile` `{ filters? }` asks for a file; result: `{ data: ArrayBuffer, fileName }`, or null
 * - `readClipboard` result: the text of the clipboard
 * - `writeClipboard` `{ text }` puts text into the clipboard
 * - `inputBox` `{ title, prompt?, value?, positiveNumber?, nonNegativeNumber? }` asks for a text (a
 *   number > 0 with `positiveNumber`, ≥ 0 with `nonNegativeNumber`); result: the text, or null when cancelled
 * - `showMessage` `{ level: 'info' | 'warning' | 'error', text }` (no reply)
 * - `fileSize` result: the size in bytes of the model file as saved (of the model file a converted
 *   document is edited for), or null when it cannot be read
 */
export class WebviewFiles {

    /**
     * Starts answering the requests of a webview.
     * @param {vscode.WebviewPanel} panel
     * @param {vscode.Uri} file the model file (the dialogs start in its folder)
     * @returns {vscode.Disposable}
     */
    static listen(panel, file) {
        const folder = vscode.Uri.joinPath(file, '..');
        return panel.webview.onDidReceiveMessage(async (message) => {
            const handler = WebviewFiles._handlers[message?.type];
            if (!handler) return;
            try {
                const result = await handler(message, folder, file);
                if (message.requestId !== undefined) panel.webview.postMessage({ type: 'hostReply', requestId: message.requestId, result: result ?? null });
            } catch (error) {
                if (message.requestId !== undefined) panel.webview.postMessage({ type: 'hostReply', requestId: message.requestId, error: String(error?.message || error) });
            }
        });
    }

    /** @type {Record<string, (message: any, folder: vscode.Uri, file: vscode.Uri) => Promise<any>>} */
    static _handlers = {
        async saveFile({ data, fileName, filters }, folder) {
            const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.joinPath(folder, fileName), filters });
            if (!uri) return null;
            await vscode.workspace.fs.writeFile(uri, new Uint8Array(data));
            return uri.fsPath;
        },
        async openFile({ filters }, folder) {
            const [uri] = await vscode.window.showOpenDialog({ defaultUri: folder, canSelectMany: false, filters }) ?? [];
            if (!uri) return null;
            // A Buffer may be a view of a shared pool: post exactly its bytes
            const bytes = await vscode.workspace.fs.readFile(uri);
            return { data: bytes.slice().buffer, fileName: uri.path.split('/').pop() };
        },
        async readClipboard() {
            return vscode.env.clipboard.readText();
        },
        async writeClipboard({ text }) {
            await vscode.env.clipboard.writeText(text);
        },
        async inputBox({ title, prompt, value, positiveNumber, nonNegativeNumber }) {
            const number = input => Number(input.trim().replace(',', '.'));
            const validateInput = positiveNumber
                ? input => (Number.isFinite(number(input)) && number(input) > 0 ? null : 'Enter a number greater than 0')
                : nonNegativeNumber
                    ? input => (input.trim() !== '' && Number.isFinite(number(input)) && number(input) >= 0 ? null : 'Enter a number, 0 or greater')
                    : undefined;
            const input = await vscode.window.showInputBox({ title, prompt, value, validateInput });
            return input === undefined ? null : input;
        },
        async showMessage({ level, text }) {
            const show = level === 'error' ? vscode.window.showErrorMessage : level === 'warning' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
            show(text);
        },
        async fileSize(message, folder, file) {
            try {
                return (await vscode.workspace.fs.stat(file)).size;
            } catch {
                return null;
            }
        },
    };
}
