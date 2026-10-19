/**
 * @typedef {Object} ObjGroup
 * @property {string} materialName - The name of the material used by this group (from 'usemtl').
 * @property {number[]} vertexIndices - Flat array of ALL vertex position indices for all faces in this group (1-based).
 * @property {number[]} uvIndices - Flat array of ALL texture coordinate indices (1-based).
 * @property {number[]} normalIndices - Flat array of ALL normal indices (1-based).
 * @property {number[]} faceStarts - An array of indices pointing into the *Indices arrays. faceStarts[i] is the starting index of the i-th face. The number of vertices in face 'i' is faceStarts[i+1] - faceStarts[i].
 */

/**
 * @typedef {Object} ObjData
 * @property {number[]} vertices - Flat array of all unique geometric vertices [x, y, z, ...].
 * @property {number[]} uvs - Flat array of all unique texture coordinates [u, v, ...].
 * @property {number[]} normals - Flat array of all unique vertex normals [nx, ny, nz, ...].
 * @property {string | null} materialLib - The file name of the material library (.mtl), if specified by 'mtllib'.
 * @property {ObjGroup[]} groups - Array of face groups, typically split by material ('usemtl') or object ('o').
 */

/**
 * Parses the content of a Wavefront .obj file from a VS Code TextDocument,
 * preserving the original polygonal structure for editor viewing.
 *
 * @param {import('vscode').TextDocument | string} document - The VS Code TextDocument containing the .obj file content.
 * @returns {ObjData} The structured data of the 3D model.
 */
export function parseObj(document) {
    const content = typeof document === 'string'
        ? document
        : document.getText();
    // Разбиваем контент на строки
    const lines = content.split("\n");

    /** @type {ObjData} */
    const objData = {
        vertices: [],
        uvs: [],
        normals: [],
        materialLib: null,
        groups: []
    };

    // Инициализируем первую группу по умолчанию
    /** @type {ObjGroup} */
    let currentGroup = {
        materialName: 'default',
        vertexIndices: [],
        uvIndices: [],
        normalIndices: [],
        faceStarts: [0] // Первая грань (если есть) начнется с индекса 0
    };
    objData.groups.push(currentGroup);

    // Проходим по всем строкам файла
    for (const line of lines) {
        // Очищаем строку и разделяем по пробелам
        const parts = line.trim().split(/\s+/).filter(p => p.length > 0);
        if (parts.length === 0) continue;

        const command = parts[0];
        const values = parts.slice(1);

        switch (command) {
            case 'mtllib': // Библиотека материалов
                if (values.length > 0) {
                    objData.materialLib = values[0];
                }
                break;

            case 'usemtl':
            case 'o':
            case 'g': {
                // Создаем новую группу, только если в текущую уже добавлены грани
                if (currentGroup.vertexIndices.length > 0 || objData.groups.length === 0) {
                    currentGroup = {
                        materialName: command === 'usemtl' ? values[0] : currentGroup.materialName,
                        vertexIndices: [],
                        uvIndices: [],
                        normalIndices: [],
                        faceStarts: [0] // Начало следующей группы также начинается с 0
                    };
                    objData.groups.push(currentGroup);
                }
                if (command === 'usemtl' && values.length > 0) {
                    currentGroup.materialName = values[0];
                }
                break;
            }

            case 'v': // Позиция вершины (x, y, z)
            case 'vn': // Вектор нормали (nx, ny, nz)
            case 'vt': { // Текстурные координаты (u, v)
                for (const val of values) {
                    const num = parseFloat(val);
                    if (!isNaN(num)) {
                        if (command === 'v') objData.vertices.push(num);
                        else if (command === 'vn') objData.normals.push(num);
                        else if (command === 'vt') objData.uvs.push(num);
                    }
                }
                break;
            }

            case 'f': { // Грани (v/vt/vn)
                // Разделяем каждую вершину грани (формат v/vt/vn)
                const faceVerticesCount = values.length;
                const currentIndicesLength = currentGroup.vertexIndices.length;

                // Добавляем текущую длину как точку старта следующей грани
                // (currentIndicesLength - это количество индексов, добавленных до этой грани)
                if (currentGroup.faceStarts[currentGroup.faceStarts.length - 1] !== currentIndicesLength) {
                    currentGroup.faceStarts.push(currentIndicesLength);
                }
                
                // Обрабатываем каждую вершину грани как есть (без триангуляции)
                for (const value of values) {
                    const indexSet = value.split('/').map(s => parseInt(s, 10));

                    // Индекс позиции (v) - всегда должен быть
                    if (indexSet[0]) currentGroup.vertexIndices.push(indexSet[0]);
                    
                    // Индекс текстурной координаты (vt)
                    if (indexSet[1]) currentGroup.uvIndices.push(indexSet[1]);
                    
                    // Индекс нормали (vn)
                    if (indexSet[2]) currentGroup.normalIndices.push(indexSet[2]);
                }

                // Добавляем индекс конца этой грани (т.е. начало следующей грани)
                currentGroup.faceStarts.push(currentGroup.vertexIndices.length);

                break;
            }
        }
    }
    
    // Удаляем последний лишний элемент в faceStarts, если это конец файла
    if (currentGroup.faceStarts.length > 0) {
        currentGroup.faceStarts.pop();
    }
    
    // Удаляем пустую группу, если в файле не было граней
    if (objData.groups.length === 1 && currentGroup.vertexIndices.length === 0 && objData.groups[0].materialName === 'default') {
        objData.groups = [];
    }

    return objData;
}