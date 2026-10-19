export function determineMimeType(uint8Array, extension = null) {
    switch (extension) {
        case 'obj': return 'model/obj'; break;
    }
    if (uint8Array.byteLength < 4) {
        return null;
    }

    // Check for JPEG (starts with 0xFF D8 FF)
    if (uint8Array[0] === 0xFF && uint8Array[1] === 0xD8 && uint8Array[2] === 0xFF) {
        return 'image/jpeg';
    }

    // Check for PNG (starts with 0x89 50 4E 47 - .PNG)
    if (uint8Array[0] === 0x89 && uint8Array[1] === 0x50 && uint8Array[2] === 0x4E && uint8Array[3] === 0x47) {
        return 'image/png';
    }

    // Check for GIF (starts with 0x47 49 46 38 - GIF8)
    if (uint8Array[0] === 0x47 && uint8Array[1] === 0x49 && uint8Array[2] === 0x46 && uint8Array[3] === 0x38) {
        return 'image/gif';
    }

    // Check for GLB (as a fallback, though usually handled by GLB parser)
    if (uint8Array[0] === 0x67 && uint8Array[1] === 0x6C && uint8Array[2] === 0x54 && uint8Array[3] === 0x46) {
         return 'model/gltf-binary';
    }

    // Check for WebP (less common, starts with RIFF)
    // RIFF (52 49 46 46) at 0, WebP (57 45 42 50) at 8
    if (uint8Array.byteLength >= 12 &&
        uint8Array[0] === 0x52 && uint8Array[1] === 0x49 && uint8Array[2] === 0x46 && uint8Array[3] === 0x46 &&
        uint8Array[8] === 0x57 && uint8Array[9] === 0x45 && uint8Array[10] === 0x42 && uint8Array[11] === 0x50) {
        return 'image/webp';
    }


    // Add more checks for other formats like BMP, TGA, etc., if necessary

    return 'text/plain'; // Unknown MIME type
}