import { HostRequests } from './editor/HostRequests';
import { MarkdownView } from './markdown/MarkdownView';
import { PreviewTranslation } from './markdown/PreviewTranslation';
import { ReadAloud } from './markdown/ReadAloud';

/**
 * The webview of the Markdown preview (`MarkdownPreview` on the host): the rendered text, the
 * Markdown files of its folder, translation and reading aloud (the file name is in the tab).
 */
// eslint-disable-next-line no-undef
const vscode = acquireVsCodeApi();
const host = new HostRequests(message => vscode.postMessage(message));
const head = document.querySelector('.md-head');
const article = /** @type {HTMLElement} */ (document.querySelector('.md-body'));
const view = new MarkdownView(article, href => host.send('openLink', { href }));
const reading = new ReadAloud({ root: article, head, host, onSettings: settings => host.send('reading', { settings }) });
const translation = new PreviewTranslation({
    root: article,
    select: head.querySelector('.md-head__lang'),
    status: head.querySelector('.md-head__status'),
    host,
    lang: vscode.getState()?.lang ?? '',
    onChange: (lang) => {
        vscode.setState({ ...vscode.getState(), lang });
        reading.refresh(lang);
    },
});
head.querySelector('.md-head__top').addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));

/**
 * @param {{ name: string, current: boolean }[]} siblings the Markdown files of the folder
 */
function showSiblings(siblings) {
    const nav = document.querySelector('.md-siblings');
    nav.hidden = siblings.length < 2;
    nav.replaceChildren(...siblings.map((sibling) => {
        const link = document.createElement('a');
        link.className = `md-siblings__file${sibling.current ? ' md-siblings__file--current' : ''}`;
        link.textContent = sibling.name;
        link.title = sibling.name;
        if (!sibling.current) link.addEventListener('click', () => host.send('openLink', { href: encodeURIComponent(sibling.name) }));
        return link;
    }));
}

window.addEventListener('message', (event) => {
    const message = event.data;
    if (host.handleMessage(message)) return;
    if (message?.type === 'markdown') {
        reading.stop();
        view.render(message.text);
        showSiblings(message.siblings ?? []);
        translation.apply();
    } else if (message?.type === 'reading') {
        reading.setSettings(message.settings);
    }
});
vscode.postMessage({ type: 'ready' });
