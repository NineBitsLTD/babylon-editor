/**
 * @typedef {Object} AccessorData
 * @property {TypedArray} array - The TypedArray containing the decoded data (e.g., Float32Array for positions).
 * @property {number} componentType - The original glTF componentType.
 * @property {number} count - The number of elements (e.g., number of vertices).
 * @property {number} componentsPerElement - The number of components per element (e.g., 3 for VEC3).
 * @property {number} type - The glTF type string (e.g., 'VEC3').
 * @property {number[]} [max] - The maximum values.
 * @property {number[]} [min] - The minimum values.
 */

/**
 * @typedef {Object} GlbData
 * @property {Object} json - The parsed glTF JSON scene description.
 * @property {ArrayBuffer | null} binaryBuffer - The raw binary buffer (Chunk #1) containing all mesh data, textures, etc.
 */

/**
 * Parses a binary GLB file, separating it into its core components: 
 * the JSON scene description, the raw binary data, and ready-to-use accessors.
 *
 * @param { Uint8Array | ArrayBuffer} arrayBuffer - The input ArrayBuffer containing the entire GLB file.
 * @returns {GlbData} - An object containing the JSON, the full binary buffer, sliced buffer views, and accessors data.
 * @throws {Error} If the file is not a valid GLB v2.
 */
export function parseGlb(arrayBuffer) {
    /**
     * Maps glTF componentType integer values to corresponding JavaScript TypedArray classes.
     * See glTF 2.0 Specification, section 3.5.4.
     * @param {number} componentType - The glTF componentType value.
     * @returns {TypedArrayConstructor} - The corresponding JavaScript TypedArray constructor.
     * @throws {Error} If the componentType is unsupported.
     */
    function getTypedArrayConstructor(componentType) {
        switch (componentType) {
            case 5120: return Int8Array;      // BYTE
            case 5121: return Uint8Array;     // UNSIGNED_BYTE
            case 5122: return Int16Array;     // SHORT
            case 5123: return Uint16Array;    // UNSIGNED_SHORT
            case 5125: return Uint32Array;    // UNSIGNED_INT (Used for indices)
            case 5126: return Float32Array;   // FLOAT (Used for positions, normals, etc.)
            default:
                throw new Error(`Unsupported glTF componentType: ${componentType}`);
        }
    }
    /**
     * Maps glTF type strings to the number of components per element.
     * @param {string} type - The glTF type string (e.g., 'VEC3', 'SCALAR').
     * @returns {number} - The number of components (e.g., 3 for 'VEC3').
     * @throws {Error} If the type is unsupported.
     */
    function getComponentCount(type) {
        switch (type) {
            case 'SCALAR': return 1;
            case 'VEC2': return 2;
            case 'VEC3': return 3;
            case 'VEC4': return 4;
            case 'MAT2': return 4; // 2x2 matrix
            case 'MAT3': return 9; // 3x3 matrix
            case 'MAT4': return 16; // 4x4 matrix
            default:
                throw new Error(`Unsupported glTF type: ${type}`);
        }
    }
    function getBufferViewSlices(json, binaryBuffer) {
        // --- 3. Парсинг BufferViews из BinaryBuffer ---
        /** @type {ArrayBuffer[]} */
        const bufferViewSlices = [];

        if (json.bufferViews && binaryBuffer) {
            for (const view of json.bufferViews) {
                // byteOffset is optional in spec, defaults to 0
                const offset = view.byteOffset || 0; 
                const length = view.byteLength;
                
                // Check if buffer view is valid and belongs to the main binary buffer (index 0)
                if (view.buffer !== 0) {
                    console.warn(`Buffer view references buffer index ${view.buffer}. Only the first buffer (index 0, the GLB binary chunk) is supported in this parser. Skipping view.`);
                    bufferViewSlices.push(new ArrayBuffer(0));
                    continue;
                }

                if (offset + length > binaryBuffer.byteLength) {
                    console.warn(`Buffer view definition extends past the end of the binary buffer. Skipping view.`);
                    bufferViewSlices.push(new ArrayBuffer(0)); // Добавляем пустой буфер вместо null для консистентности
                    continue;
                }

                // Slice the raw ArrayBuffer to get the data for this specific bufferView
                const slicedBuffer = binaryBuffer.slice(offset, offset + length);
                bufferViewSlices.push(slicedBuffer);
            }
        }
        return bufferViewSlices;
    }
    function geAccessorsData(json, bufferViewSlices) {
        // --- 4. Создание Accessor'ов (TypedArrays) ---
        /** @type {AccessorData[]} */
        const accessorsData = [];

        if (json.accessors && bufferViewSlices.length > 0) {
            for (const accessor of json.accessors) {
                const viewIndex = accessor.bufferView;
                if (viewIndex === undefined || viewIndex >= bufferViewSlices.length) {
                    console.warn(`Accessor references missing bufferView index ${viewIndex}. Skipping accessor.`);
                    accessorsData.push(null);
                    continue;
                }
                
                const bufferView = json.bufferViews[viewIndex];
                const bufferSlice = bufferViewSlices[viewIndex];
                
                // Определяем конструктор типизированного массива и смещения
                const TypedArray = getTypedArrayConstructor(accessor.componentType);
                const byteOffset = accessor.byteOffset || 0;
                
                // glTF spec 2.0: bufferView.byteStride must be a multiple of the component type's size.
                // When byteStride is defined, the accessor array might be sparse or interleaved.
                // For simplicity, we assume here that byteStride is NOT used or is equal to the default stride.
                if (bufferView.byteStride) {
                    console.warn("Skipping accessor: glTF byteStride detected. This parser version does not support interleaved or sparse accessors.");
                    accessorsData.push(null);
                    continue;
                }

                try {
                    // Создаем типизированный массив, используя ArrayBuffer и смещение
                    const typedArray = new TypedArray(bufferSlice, byteOffset, accessor.count * getComponentCount(accessor.type));
                    
                    // Сохраняем все метаданные вместе с массивом
                    accessorsData.push({
                        array: typedArray,
                        componentType: accessor.componentType,
                        count: accessor.count,
                        componentsPerElement: getComponentCount(accessor.type),
                        type: accessor.type,
                        max: accessor.max,
                        min: accessor.min,
                    });
                } catch (e) {
                    console.error(`Error creating TypedArray for accessor ${viewIndex}:`, e);
                    accessorsData.push(null);
                }
            }
        }
        return accessorsData;
    }

    const buffer = (arrayBuffer instanceof Uint8Array) ? arrayBuffer.buffer : arrayBuffer;

    if (buffer.byteLength < 12) {
        throw new Error("GLB file too short to contain header.");
    }

    const dataView = new DataView(buffer);
    let offset = 0;

    // --- 1. Чтение Заголовка (Header: 12 байт) ---

    // Magic (4 bytes): Must be 0x46546c67 (little-endian for 'glTF')
    const magic = dataView.getUint32(offset, true);
    if (magic !== 0x46546c67) {
        throw new Error("Invalid GLB magic number. File is not a GLB.");
    }
    offset += 4;

    // Version (4 bytes): Must be 2
    const version = dataView.getUint32(offset, true);
    if (version !== 2) {
        throw new Error(`Unsupported GLB version: ${version}. Only version 2 is supported.`);
    }
    offset += 4;

    // Total Length (4 bytes): Overall file length
    // const totalLength = dataView.getUint32(offset, true);
    offset += 4;

    /** @type {Object | null} */
    let json = null;
    /** @type {ArrayBuffer | null} */
    let binaryBuffer = null;

    // --- 2. Чтение Блоков (Chunks) ---
    while (offset < buffer.byteLength) {
        // Длина блока (4 байта)
        const chunkLength = dataView.getUint32(offset, true);
        offset += 4;

        // Тип блока (4 байта)
        const chunkType = dataView.getUint32(offset, true);
        offset += 4;

        // Бинарное содержимое блока начинается здесь
        const chunkDataOffset = offset;
        offset += chunkLength;

        // Проверка на выход за пределы буфера
        if (offset > buffer.byteLength) {
            console.warn(`GLB chunk extends beyond file length. Stopping parsing.`);
            break;
        }

        // Тип 0x4e4f534a (little-endian for 'JSON')
        if (chunkType === 0x4e4f534a) {
            // JSON Chunk
            const jsonBuffer = buffer.slice(chunkDataOffset, chunkDataOffset + chunkLength);
            // Используем TextDecoder для надежного преобразования Uint8Array в строку UTF-8
            const jsonString = new TextDecoder('utf-8').decode(jsonBuffer); 
            json = JSON.parse(jsonString);

        // Тип 0x004e4942 (little-endian for 'BIN\0')
        } else if (chunkType === 0x004e4942) {
            // Binary Buffer Chunk
            binaryBuffer = buffer.slice(chunkDataOffset, chunkDataOffset + chunkLength);
        } else {
            // Неизвестный или дополнительный блок
            console.log(`Skipping unknown chunk type: 0x${chunkType.toString(16)}`);
        }
    }

    if (!json) {
        throw new Error("GLB file must contain a JSON chunk.");
    }
    
    
    const instance = {
        json,
        binaryBuffer,
        getTypedArrayConstructor,
        getComponentCount,
        getBufferViewSlices,
        geAccessorsData
    };

    return instance;
}