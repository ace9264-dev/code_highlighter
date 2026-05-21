import * as vscode from "vscode";

// ---------------------------------------------------------------------------
// Color configuration: name, command suffix, and semi-transparent RGBA color.
// Higher opacity (0.55-0.70) for more visible highlights.
// White text color for contrast against the colored backgrounds.
// ---------------------------------------------------------------------------
interface ColorConfig {
    name: string;
    command: string;
    backgroundColor: string;
}

const COLORS: ColorConfig[] = [
    { name: "red", command: "codeHighlighter.highlightRed", backgroundColor: "rgba(255, 80, 80, 0.65)" },
    { name: "green", command: "codeHighlighter.highlightGreen", backgroundColor: "rgba(60, 180, 100, 0.60)" },
    { name: "yellow", command: "codeHighlighter.highlightYellow", backgroundColor: "rgba(255, 200, 50, 0.70)" },
    { name: "pink", command: "codeHighlighter.highlightPink", backgroundColor: "rgba(255, 80, 160, 0.65)" },
    { name: "purple", command: "codeHighlighter.highlightPurple", backgroundColor: "rgba(140, 80, 210, 0.60)" },
    { name: "skyblue", command: "codeHighlighter.highlightSkyBlue", backgroundColor: "rgba(60, 160, 255, 0.60)" },
    { name: "lime", command: "codeHighlighter.highlightLime", backgroundColor: "rgba(140, 220, 50, 0.65)" },
];

// Storage key for workspace state persistence
const STORAGE_KEY = "codeHighlighter.savedHighlights";

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------

// Map: document URI (string) -> (color name -> array of vscode.Range)
const highlightsByDocument = new Map<string, Map<string, vscode.Range[]>>();
const decorationTypes = new Map<string, vscode.TextEditorDecorationType>();
const disposables: vscode.Disposable[] = [];

// Extension context for persistent storage access
let extensionContext: vscode.ExtensionContext | undefined;

// ---------------------------------------------------------------------------
// Serialization helpers for persistence
// ---------------------------------------------------------------------------

interface SerializedRange {
    startLine: number;
    startChar: number;
    endLine: number;
    endChar: number;
}

interface SerializedHighlights {
    [uri: string]: {
        [colorName: string]: SerializedRange[];
    };
}

function serializeHighlights(): SerializedHighlights {
    const result: SerializedHighlights = {};
    for (const [uri, colorMap] of highlightsByDocument.entries()) {
        const uriData: { [colorName: string]: SerializedRange[] } = {};
        for (const [colorName, ranges] of colorMap.entries()) {
            if (ranges.length > 0) {
                uriData[colorName] = ranges.map((r) => ({
                    startLine: r.start.line,
                    startChar: r.start.character,
                    endLine: r.end.line,
                    endChar: r.end.character,
                }));
            }
        }
        if (Object.keys(uriData).length > 0) {
            result[uri] = uriData;
        }
    }
    return result;
}

function deserializeHighlights(data: SerializedHighlights): void {
    highlightsByDocument.clear();
    for (const [uri, colorMap] of Object.entries(data)) {
        const docMap = new Map<string, vscode.Range[]>();
        for (const [colorName, ranges] of Object.entries(colorMap)) {
            docMap.set(
                colorName,
                ranges.map(
                    (r) =>
                        new vscode.Range(
                            new vscode.Position(r.startLine, r.startChar),
                            new vscode.Position(r.endLine, r.endChar)
                        )
                )
            );
        }
        highlightsByDocument.set(uri, docMap);
    }
}

// ---------------------------------------------------------------------------
// Persist highlights to workspace state
// ---------------------------------------------------------------------------
function saveHighlights(): void {
    if (!extensionContext) {
        return;
    }
    const data = serializeHighlights();
    extensionContext.workspaceState.update(STORAGE_KEY, data).then(undefined, (err) => {
        console.error("Failed to save highlights:", err);
    });
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------
function getDecorationType(colorName: string): vscode.TextEditorDecorationType | undefined {
    return decorationTypes.get(colorName);
}

function getDocumentHighlights(uri: string): Map<string, vscode.Range[]> {
    if (!highlightsByDocument.has(uri)) {
        highlightsByDocument.set(uri, new Map<string, vscode.Range[]>());
    }
    return highlightsByDocument.get(uri)!;
}

function applyHighlights(editor: vscode.TextEditor): void {
    const uri = editor.document.uri.toString();
    const docHighlights = getDocumentHighlights(uri);

    for (const color of COLORS) {
        const decorationType = getDecorationType(color.name);
        if (!decorationType) {
            continue;
        }
        const ranges = docHighlights.get(color.name) ?? [];
        editor.setDecorations(decorationType, ranges);
    }
}

// ---------------------------------------------------------------------------
// Core: highlight the current selection with the chosen color.
// ---------------------------------------------------------------------------
function highlightSelection(colorName: string): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage("No active editor to highlight.");
        return;
    }

    const selection = editor.selection;
    if (selection.isEmpty) {
        vscode.window.showInformationMessage("Select some text first to highlight it.");
        return;
    }

    const range = new vscode.Range(selection.start, selection.end);
    const uri = editor.document.uri.toString();
    const docHighlights = getDocumentHighlights(uri);

    const existing = docHighlights.get(colorName) ?? [];
    existing.push(range);
    docHighlights.set(colorName, existing);

    applyHighlights(editor);
    saveHighlights(); // Persist after every change
}

// ---------------------------------------------------------------------------
// Core: remove any highlights that overlap the current selection.
// ---------------------------------------------------------------------------
function removeHighlightAtSelection(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage("No active editor.");
        return;
    }

    const selection = editor.selection;
    if (selection.isEmpty) {
        vscode.window.showInformationMessage("Select the highlighted text you want to remove.");
        return;
    }

    const removeRange = new vscode.Range(selection.start, selection.end);
    const uri = editor.document.uri.toString();
    const docHighlights = getDocumentHighlights(uri);
    let removedCount = 0;

    for (const color of COLORS) {
        const ranges = docHighlights.get(color.name) ?? [];
        const filtered = ranges.filter((r) => !r.intersection(removeRange));
        removedCount += ranges.length - filtered.length;
        docHighlights.set(color.name, filtered);
    }

    applyHighlights(editor);
    saveHighlights(); // Persist after every change

    if (removedCount === 0) {
        vscode.window.showInformationMessage("No highlights found in the current selection.");
    }
}

// ---------------------------------------------------------------------------
// Core: clear every highlight in the active file.
// ---------------------------------------------------------------------------
function clearAllHighlights(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage("No active editor.");
        return;
    }

    const uri = editor.document.uri.toString();
    const docHighlights = highlightsByDocument.get(uri);
    if (!docHighlights || docHighlights.size === 0) {
        vscode.window.showInformationMessage("No highlights to clear in this file.");
        return;
    }

    docHighlights.clear();
    applyHighlights(editor);
    saveHighlights(); // Persist after clearing
    vscode.window.showInformationMessage("All highlights cleared.");
}

// ---------------------------------------------------------------------------
// Restore highlights when a document opens or becomes active.
// ---------------------------------------------------------------------------
function restoreHighlightsForEditor(editor: vscode.TextEditor): void {
    const uri = editor.document.uri.toString();
    if (highlightsByDocument.has(uri)) {
        applyHighlights(editor);
    }
}

function onActiveEditorChanged(editor: vscode.TextEditor | undefined): void {
    if (!editor) {
        return;
    }
    restoreHighlightsForEditor(editor);
}

function onDocumentOpened(doc: vscode.TextDocument): void {
    // When a document is opened, check if we have saved highlights for it
    const uri = doc.uri.toString();
    if (highlightsByDocument.has(uri)) {
        const editor = vscode.window.visibleTextEditors.find(
            (e) => e.document.uri.toString() === uri
        );
        if (editor) {
            applyHighlights(editor);
        }
    }
}

// ---------------------------------------------------------------------------
// Activation entry point.
// ---------------------------------------------------------------------------
export function activate(context: vscode.ExtensionContext): void {
    extensionContext = context;

    // 1. Restore highlights from previous session
    const savedData = context.workspaceState.get<SerializedHighlights>(STORAGE_KEY);
    if (savedData) {
        deserializeHighlights(savedData);
    }

    // 2. Create decoration types with white text color and higher opacity
    for (const color of COLORS) {
        const dt = vscode.window.createTextEditorDecorationType({
            backgroundColor: color.backgroundColor,
            color: "#ffffff", // White text for contrast
            fontWeight: "bold",
            isWholeLine: false,
            overviewRulerColor: color.backgroundColor,
            overviewRulerLane: vscode.OverviewRulerLane.Right,
        });
        decorationTypes.set(color.name, dt);
        disposables.push(dt);
    }

    // 3. Register highlight commands
    for (const color of COLORS) {
        const cmd = vscode.commands.registerCommand(color.command, () => {
            highlightSelection(color.name);
        });
        context.subscriptions.push(cmd);
        disposables.push(cmd);
    }

    // 4. Register remove & clear commands
    const removeCmd = vscode.commands.registerCommand(
        "codeHighlighter.removeHighlight",
        removeHighlightAtSelection
    );
    context.subscriptions.push(removeCmd);
    disposables.push(removeCmd);

    const clearCmd = vscode.commands.registerCommand(
        "codeHighlighter.clearAllHighlights",
        clearAllHighlights
    );
    context.subscriptions.push(clearCmd);
    disposables.push(clearCmd);

    // 5. Listen for editor changes and document opens
    const editorChangeListener = vscode.window.onDidChangeActiveTextEditor(onActiveEditorChanged);
    context.subscriptions.push(editorChangeListener);
    disposables.push(editorChangeListener);

    const docOpenListener = vscode.workspace.onDidOpenTextDocument(onDocumentOpened);
    context.subscriptions.push(docOpenListener);
    disposables.push(docOpenListener);

    // 6. Apply highlights to currently visible editors on startup
    for (const editor of vscode.window.visibleTextEditors) {
        restoreHighlightsForEditor(editor);
    }
}

// ---------------------------------------------------------------------------
// Deactivation
// ---------------------------------------------------------------------------
export function deactivate(): void {
    // Save one final time before shutting down
    saveHighlights();

    for (const d of disposables) {
        d.dispose();
    }
    disposables.length = 0;
    decorationTypes.clear();
    highlightsByDocument.clear();
    extensionContext = undefined;
}