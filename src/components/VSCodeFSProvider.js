import * as vscode from 'vscode';
import * as BABYLON from '@babylonjs/core';

/**
 * Custom Babylon.js Offline Provider for VS Code Workspace FS.
 * Provides integration between Babylon.js resource loading and VS Code filesystem.
 * 
 * @implements {BABYLON.IOfflineProvider}
 */
export class VSCodeFSProvider {
    /**
     * @param {vscode.Uri} baseUri - The base folder URI in the workspace.
     */
    constructor(baseUri) {
        this._baseUri = baseUri;
        this.enableSceneOffline = true;
        this.enableTexturesOffline = true;
    }

    /**
     * Open the offline support and make it available.
     * @param {function} successCallback 
     * @param {function} errorCallback 
     */
    open(successCallback, errorCallback) {
        if (this._baseUri) {
            successCallback();
        } else {
            errorCallback();
        }
    }

    /**
     * Loads a file from VS Code workspace.
     * @param {string} url 
     * @param {function} sceneLoaded 
     * @param {function} progressCallBack 
     * @param {function} errorCallback 
     * @param {boolean} useArrayBuffer 
     */
    loadFile(url, sceneLoaded, progressCallBack, errorCallback, useArrayBuffer) {
        const fileUri = this._resolveUri(url);

        // Используем два аргумента .then() для обработки успеха и ошибки
        vscode.workspace.fs.readFile(fileUri).then(
            (uint8Array) => {
                const data = useArrayBuffer 
                    ? uint8Array.buffer.slice(uint8Array.byteOffset, uint8Array.byteOffset + uint8Array.byteLength)
                    : new TextDecoder().decode(uint8Array);
                sceneLoaded(data);
            },
            (err) => {
                console.error(`[VSCodeFS] Load error: ${url}`, err);
                if (errorCallback) {
                    errorCallback();
                }
            }
        );
    }

    /**
     * Loads an image from the offline support.
     * @param {string} url 
     * @param {HTMLImageElement} image 
     */
    loadImage(url, image) {
        const fileUri = this._resolveUri(url);

        vscode.workspace.fs.readFile(fileUri).then(
            (uint8Array) => {
                const blob = new Blob([uint8Array]);
                const blobUrl = URL.createObjectURL(blob);
                
                const onImageLoad = () => {
                    image.removeEventListener('load', onImageLoad);
                    URL.revokeObjectURL(blobUrl);
                };
                
                image.addEventListener('load', onImageLoad);
                image.src = blobUrl;
            },
            (err) => {
                console.error(`[VSCodeFS] Image error: ${url}`, err);
            }
        );
    }

    /**
     * Internal helper to resolve URL to vscode.Uri.
     * @param {string} url 
     * @returns {vscode.Uri}
     * @private
     */
    _resolveUri(url) {
        // Проверка на абсолютный путь или уже готовый URI
        if (url.includes("://")) {
            return vscode.Uri.parse(url);
        }
        return vscode.Uri.joinPath(this._baseUri, url);
    }
}