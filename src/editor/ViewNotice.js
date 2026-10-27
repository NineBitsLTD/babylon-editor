/**
 * A question over the 3D view (e.g. whether to bind the selected vertices to a bone) with buttons
 * for its answers; it stays until one is chosen or it is hidden.
 */
export class ViewNotice {

    /**
     * @param {HTMLElement} viewport the element holding the canvas
     */
    constructor(viewport) {
        this._element = document.createElement('div');
        this._element.className = 'view-notice';
        this._element.hidden = true;
        this._text = document.createElement('span');
        this._text.className = 'view-notice__text';
        this._buttons = document.createElement('div');
        this._buttons.className = 'view-notice__buttons';
        this._element.append(this._text, this._buttons);
        viewport.append(this._element);
    }

    /**
     * @param {string} text
     * @param {{ label: string, title?: string, primary?: boolean, run: () => void }[]} answers each hides the notice, then runs
     */
    show(text, answers) {
        this._text.textContent = text;
        this._buttons.replaceChildren(...answers.map((answer) => {
            const button = document.createElement('button');
            button.className = `view-notice__button${answer.primary ? ' view-notice__button--primary' : ''}`;
            button.textContent = answer.label;
            if (answer.title) button.title = answer.title;
            button.addEventListener('click', () => {
                this.hide();
                answer.run();
            });
            return button;
        }));
        this._element.hidden = false;
    }

    hide() {
        this._element.hidden = true;
    }
}
