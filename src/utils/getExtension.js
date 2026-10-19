/**
 * Extracts the file extension from the VS Code document object, without the leading dot.
 *
 * @param {import('vscode').TextDocument | string} document - The VS Code TextDocument object.
 * @returns {string | null} The file extension in lowercase (without the dot), or null if no extension is found.
 */
export function getExtension(document) {
    const fullPath = typeof document === 'string' 
    ? document
    : document.fileName.toLowerCase();
    const lastDotIndex = fullPath.lastIndexOf('.');
    if (lastDotIndex === -1 || lastDotIndex === fullPath.length - 1) {
        return null;
    }
    return fullPath.substring(lastDotIndex + 1) || null;
}