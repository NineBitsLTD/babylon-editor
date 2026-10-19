/**
 * @typedef {object} Props
 * @property {string} [className]
 * @property {(string | number | null) | Array<string | number | null>} [children] // Добавляем children в тип
 * // ... other properties
 */

/**
 * Converts a JSX structure into an HTML string (Fixed for Automatic JSX Runtime).
 * @param {string} tag - The tag name (e.g., 'div').
 * @param {Props | null} props - Properties (attributes) of the element, including children.
 * @returns {string} The HTML markup string.
 */
function h(tag, props) {
    let attrs = '';
    
    const rawChildren = props?.children ? (Array.isArray(props.children) ? props.children : [props.children]) : [];

    if (props) {
        for (const key in props) {
            if (Object.hasOwnProperty.call(props, key) && key !== 'children' && key !== 'key') {
                let attrKey;
                switch(key) {
                    case 'className': attrKey = 'class'; break;
                    default: attrKey = key.toLowerCase();
                }
                let attrValue = props[key];
                if (attrKey.startsWith('on')
                    || typeof attrValue === 'function'
                ) continue;
                if (typeof attrValue === 'string') {
                    attrValue = attrValue.replace(/"/g, '&quot;');
                }
                attrs += ` ${attrKey}="${attrValue}"`;
            }
        }
    }
    
    const content = rawChildren
        .filter(child => child !== null && child !== undefined)
        .flat(Infinity)
        .join('');
        
    const voidElements = [
        'area', 'base', 'br', 'col', 'embed', 'hr', 'img',
        'input', 'link', 'meta', 'param', 'source', 'track',
        'wbr'
    ];
    if (voidElements.includes(tag)) {
        return `<${tag}${attrs}>`; 
    } else {
        return `<${tag}${attrs}>${content}</${tag}>`;
    }
}
/**
 * Fragment placeholder for Automatic JSX Runtime.
 * @param {{children: string | Array<string>}} props - The properties object containing children.
 * @returns {string | Array<string>} The children elements.
 */
const Fragment = (props) => props.children;

export {
    h as createElement,
    h as jsxs, 
    h as jsx, 
    h as jsxDEV,
    Fragment
}