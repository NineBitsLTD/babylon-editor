/**
 * Requests from the webview to the extension host that wait for a reply (`WebviewFiles` on the
 * host answers them with `{ type: 'hostReply', requestId, result | error }`).
 */
export class HostRequests {

    /**
     * @param {(message: any) => void} post posts a message to the host
     */
    constructor(post) {
        this._post = post;
        this._nextId = 1;
        /** @type {Map<number, { resolve: (result: any) => void, reject: (error: Error) => void }>} */
        this._pending = new Map();
    }

    /**
     * @param {string} type
     * @param {object} [fields]
     * @returns {Promise<any>} the result of the host
     */
    request(type, fields = {}) {
        const requestId = this._nextId++;
        return new Promise((resolve, reject) => {
            this._pending.set(requestId, { resolve, reject });
            this._post({ type, requestId, ...fields });
        });
    }

    /**
     * A message to the host that needs no reply.
     * @param {string} type
     * @param {object} [fields]
     */
    send(type, fields = {}) {
        this._post({ type, ...fields });
    }

    /**
     * @param {any} message a message of the host
     * @returns {boolean} whether it was a reply to a request
     */
    handleMessage(message) {
        if (message?.type !== 'hostReply') return false;
        const pending = this._pending.get(message.requestId);
        if (!pending) return true;
        this._pending.delete(message.requestId);
        if (message.error) pending.reject(new Error(message.error));
        else pending.resolve(message.result);
        return true;
    }
}
