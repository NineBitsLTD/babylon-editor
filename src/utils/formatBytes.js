const SIZE_UNITS = ['bytes', 'KB', 'MB', 'GB', 'TB'];

/**
 * @param {number} count a size in bytes (or characters of a text, which are bytes for ASCII)
 * @returns {string} the size in the largest unit it reaches (1 KB = 1024 bytes) with at most two
 *   decimals, e.g. `926.76 KB`, `3.84 MB`, `512 bytes`
 */
export function formatBytes(count) {
    let unit = 0;
    let value = count;
    while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
        value /= 1024;
        unit++;
    }
    return unit ? `${Number(value.toFixed(2))} ${SIZE_UNITS[unit]}` : `${count} ${count === 1 ? 'byte' : 'bytes'}`;
}
