/**
 * Converts a Uint8Array or ArrayBuffer into a Base64 Data URL string.
 * This is useful for embedding image data (textures) directly into the viewer.
 *
 * @param {ArrayBuffer | Uint8Array} buffer - The input binary data (e.g., JPEG or PNG file content).
 * @param {string} mimeType - The MIME type of the data (e.g., 'image/png', 'image/jpeg').
 * @returns {string} The Base64 encoded Data URL (e.g., "data:image/png;base64,...").
 */
export function toBase64Url(buffer, mimeType) {
    // 1. Убеждаемся, что работаем с Uint8Array
    const uint8Array = (buffer instanceof Uint8Array) ? buffer : new Uint8Array(buffer);
    
    // 2. Преобразуем Uint8Array в "бинарную строку".
    // Этот метод является стандартным для btoa, который не поддерживает прямую работу с ArrayBuffer/TypedArray.
    let binaryString = '';
    const chunkSize = 16384; // Разбиваем на чанки для предотвращения RangeError при очень больших файлах
    for (let i = 0; i < uint8Array.length; i += chunkSize) {
        binaryString += String.fromCharCode.apply(null, uint8Array.subarray(i, i + chunkSize));
    }
    
    // 3. Кодируем бинарную строку в Base64
    const base64 = btoa(binaryString);
    
    // 4. Формируем Data URL
    return `data:${mimeType};base64,${base64}`;
}