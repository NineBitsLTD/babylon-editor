/**
 * Serializable tree node sent to the extension host, which renders it in the Explorer view.
 * @typedef {object} ModelTreeNode
 * @property {string} id stable for the lifetime of the loaded model
 * @property {string} label
 * @property {string} description
 * @property {string} icon codicon name
 * @property {boolean} hasChildren
 * @property {string} contextValue `section:<name>` for sections, `item:<kind>` for model objects (context menus)
 * @property {string} uriPath path of the item in the tree (`/<parent id>/<id>`), for file decorations
 * @property {TreeItemSource} [source] where the object is in a `.babylon` document (the host compares it with the saved file)
 * @property {'modified' | 'added'} [state] change since the last save, for formats without a text document
 */

/**
 * An object of a `.babylon` document: the item of `array` whose `key` field equals `id`
 * (optionally only its `field`, e.g. a texture slot of a material).
 * @typedef {object} TreeItemSource
 * @property {(string | number)[]} array
 * @property {string} key
 * @property {string | number} id
 * @property {string} [field]
 */

/**
 * Serves the model tree built by ModelOutline to the native VS Code tree view.
 * Items are created lazily per request and cached, so ids (and therefore the expansion
 * state in VS Code) stay stable while labels change after edits.
 */
export class ModelTreeBridge {

    /**
     * @param {(item: import('./ModelOutline').TreeItem) => { source?: TreeItemSource, state?: 'modified' | 'added' }} [annotate]
     *   change information of an item
     */
    constructor(annotate = () => ({})) {
        this._annotate = annotate;
        /** @type {Map<string, string>} item key -> uri path */
        this._paths = new Map();
        /** @type {Map<string, import('./ModelOutline').TreeItem>} */
        this._items = new Map();
        /** @type {Map<string | null, import('./ModelOutline').TreeItem[]>} */
        this._children = new Map();
        // Ids of a reloaded model must not match ids of the previous one
        this._generation = 0;
    }

    /**
     * Replaces the tree with the items of a newly loaded model.
     * @param {import('./ModelOutline').TreeItem[]} roots
     */
    reset(roots) {
        this._generation++;
        this._items.clear();
        this._children.clear();
        this._paths.clear();
        this._children.set(null, this._register(roots, null));
    }

    /**
     * @param {import('./ModelOutline').ModelItemData | undefined} data
     * @returns {string} `section:<name>` or `item:<kind>`; the whole timeline is `item:timeline`
     *   (it cannot be renamed or deleted)
     */
    _contextValue(data) {
        if (data?.kind === 'section') return `section:${data.name}`;
        if (data?.kind === 'clip' && data.clip.isTimeline) return 'item:timeline';
        return `item:${data?.kind ?? 'unknown'}`;
    }

    /**
     * @param {string | null} parentId null for the root level
     * @returns {ModelTreeNode[]}
     */
    getChildren(parentId) {
        let children = this._children.get(parentId);
        if (!children) {
            const parent = this._items.get(parentId);
            children = this._register(parent?.children?.() ?? [], parentId);
            this._children.set(parentId, children);
        }
        return children.map(item => ({
            ...this._annotate(item),
            uriPath: this._paths.get(this._key(item)),
            id: this._key(item),
            label: item.label(),
            description: item.description?.() ?? '',
            icon: item.icon || 'circle-small',
            hasChildren: !!item.children,
            contextValue: this._contextValue(item.data),
        }));
    }

    /**
     * @returns {import('./ModelOutline').TreeItem[]} the root items (sections)
     */
    getRoots() {
        return this._children.get(null) ?? [];
    }

    /**
     * @param {string} id
     * @returns {import('./ModelOutline').TreeItem | undefined}
     */
    get(id) {
        return this._items.get(id);
    }

    /**
     * @param {import('./ModelOutline').TreeItem[]} items
     * @param {string | null} parentId
     * @returns {import('./ModelOutline').TreeItem[]}
     */
    _register(items, parentId) {
        const parentPath = parentId ? this._paths.get(parentId) ?? '' : '';
        items.forEach((item) => {
            const key = this._key(item);
            this._items.set(key, item);
            this._paths.set(key, `${parentPath}/${encodeURIComponent(item.id)}`);
        });
        return items;
    }

    /**
     * @param {import('./ModelOutline').TreeItem} item
     * @returns {string}
     */
    _key(item) {
        return `${this._generation}/${item.id}`;
    }
}
