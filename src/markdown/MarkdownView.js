import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import { marked } from 'marked';

/**
 * @param {string} text
 * @returns {string} the text with HTML special characters escaped
 */
function escapeHtml(text) {
    return text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

/**
 * @param {string} text heading text (HTML)
 * @returns {string} its anchor as GitHub makes it: lower case, punctuation dropped, spaces as dashes
 */
function slugOf(text) {
    return text.replace(/<[^>]*>/g, '').toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
}

/**
 * Renders Markdown as the labi.one docs viewer does: GitHub flavoured (`marked`), sanitized
 * (`DOMPurify`), code highlighted (`highlight.js`), headings with GitHub anchors. A click on a link
 * scrolls to an anchor of the page or is handed to `onLink` (the host opens files and addresses).
 */
export class MarkdownView {

    /**
     * @param {HTMLElement} article
     * @param {(href: string) => void} onLink
     */
    constructor(article, onLink) {
        this._article = article;
        /** @type {Map<string, number>} anchors used while rendering, for unique ones */
        this._slugs = new Map();
        marked.use({
            gfm: true,
            renderer: {
                code: (code, language) => {
                    const name = (language ?? '').trim().split(/\s/)[0];
                    const html = name && hljs.getLanguage(name) ? hljs.highlight(code, { language: name }).value : escapeHtml(code);
                    return `<pre><code class="hljs${name ? ` language-${escapeHtml(name)}` : ''}">${html}</code></pre>\n`;
                },
                heading: (text, level) => {
                    const slug = slugOf(text);
                    const count = this._slugs.get(slug) ?? 0;
                    this._slugs.set(slug, count + 1);
                    return `<h${level} id="${escapeHtml(count ? `${slug}-${count}` : slug)}">${text}</h${level}>\n`;
                },
            },
        });
        article.addEventListener('click', (event) => {
            const link = /** @type {HTMLElement} */ (event.target).closest?.('a[href]');
            if (!link) return;
            event.preventDefault();
            const href = link.getAttribute('href') ?? '';
            if (href.startsWith('#')) this.scrollTo(decodeURIComponent(href.slice(1)));
            else onLink(href);
        });
    }

    /**
     * Shows the Markdown text, keeping the scroll position (the text changes while it is edited).
     * @param {string} text
     */
    render(text) {
        this._slugs.clear();
        const scroll = window.scrollY;
        this._article.innerHTML = DOMPurify.sanitize(/** @type {string} */ (marked.parse(text)), { USE_PROFILES: { html: true } });
        window.scrollTo(0, scroll);
    }

    /**
     * @param {string} id anchor of a heading
     */
    scrollTo(id) {
        (document.getElementById(id) ?? document.getElementById(slugOf(id)))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
}
