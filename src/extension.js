import * as vscode from 'vscode';
import { BabylonEditor, BabylonEditorID } from './components/BabylonEditor';
import { BabylonTextEditor, BabylonTextEditorID } from './components/BabylonTextEditor';
import { BabylonTextProvider } from './components/BabylonTextProvider';
import { ConvertedModels } from './components/ConvertedModels';
import { JsonDocuments } from './components/JsonDocuments';
import { ModelTreeProvider } from './components/ModelTreeProvider';
import { WebviewTasks } from './components/WebviewTasks';

/**
 * @param {vscode.ExtensionContext} context
 * @returns {{ modelTree: ModelTreeProvider, converted: ConvertedModels }}
 */
export function activate(context) {
	const modelTree = new ModelTreeProvider();
	context.subscriptions.push(modelTree.register());
	// .babylon files are text documents edited by the 3D view; other formats are binary documents
	const modelEditorOf = uri => (uri.path.toLowerCase().endsWith('.babylon') ? BabylonTextEditorID : BabylonEditorID);
	const documents = new JsonDocuments();
	context.subscriptions.push(documents.register());
	const textProvider = new BabylonTextProvider(modelEditorOf, documents);
	context.subscriptions.push(textProvider.register());
	const binaryEditor = new BabylonEditor(context.extensionUri, context, modelTree);
	context.subscriptions.push(
		vscode.window.registerCustomEditorProvider(
            BabylonEditorID,
            binaryEditor,
            {
                webviewOptions: {
                    retainContextWhenHidden: true
                }
            }
        )
	);
	// Glb, glTF, OBJ and STL files are converted to .babylon documents and edited like .babylon files
	const tasks = new WebviewTasks(binaryEditor);
	const converted = new ConvertedModels(tasks, context.extension.packageJSON.version ?? '');
	context.subscriptions.push(converted.register());
	binaryEditor.useConversions(converted, tasks, BabylonTextEditorID);
	context.subscriptions.push(new BabylonTextEditor(binaryEditor, modelTree, textProvider, documents, tasks, converted).register());
	// Exposed to integration tests: the tree items are served by the editor webview
	return { modelTree, converted };
}

export function deactivate() {}
