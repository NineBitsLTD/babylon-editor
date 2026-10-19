/**
 * Extracts the file extension from a VS Code document object or a path, without the leading dot.
 *
 * @param {import('vscode').TextDocument | string} document - The VS Code TextDocument object, or a path.
 * @returns {string | null} The file extension in lowercase (without the dot), or null if no extension is found.
 */
export function getExtension(document) {
    // Only the file name: a dot in a folder name is not an extension
    const fileName = (typeof document === 'string' ? document : document.fileName).split(/[\\/]/).pop().toLowerCase();
    const lastDotIndex = fileName.lastIndexOf('.');
    if (lastDotIndex === -1 || lastDotIndex === fileName.length - 1) {
        return null;
    }
    return fileName.substring(lastDotIndex + 1) || null;
}
