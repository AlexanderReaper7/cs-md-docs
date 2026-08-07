import * as vscode from 'vscode';
import { collectDocComment, extractUntagged } from './docComment';

/**
 * VS Code asks every registered hover provider for the position and merges the
 * results, so this sits alongside the C# extension's Roslyn hover rather than
 * replacing it. Roslyn renders the XML sections; we render what it discards.
 */
export function activate(context: vscode.ExtensionContext): void {
  const cache = new DeclarationCache();
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(
      [
        { language: 'csharp', scheme: 'file' },
        { language: 'csharp', scheme: 'untitled' },
        { language: 'csharp', scheme: 'vscode-notebook-cell' },
      ],
      new UntaggedDocHoverProvider(cache),
    ),
    vscode.workspace.onDidChangeTextDocument((e) => cache.invalidate(e.document.uri)),
    cache,
  );
}

export function deactivate(): void {
  /* nothing to unwind beyond the disposables */
}

class UntaggedDocHoverProvider implements vscode.HoverProvider {
  constructor(private readonly cache: DeclarationCache) {}

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.Hover | undefined> {
    const config = vscode.workspace.getConfiguration('csMdDocs');
    if (!config.get<boolean>('enable', true)) {
      return undefined;
    }
    // Hovering whitespace or punctuation cannot name a symbol, and this check is
    // free compared to a round trip to the language server.
    const word = document.getWordRangeAtPosition(position);
    if (!word) {
      return undefined;
    }

    const declaration = await this.resolveDeclaration(document, position, config, token);
    if (!declaration || token.isCancellationRequested) {
      return undefined;
    }

    const rendered = await this.render(declaration, config);
    if (!rendered) {
      return undefined;
    }

    const heading = config.get<string>('heading', '');
    const content = new vscode.MarkdownString(heading ? heading + rendered : rendered);
    // Untrusted: the text comes from source files, which may not be ours.
    content.isTrusted = false;
    content.supportHtml = false;
    return new vscode.Hover(content, word);
  }

  /**
   * Where the symbol under the cursor is declared. The definition provider is
   * the C# extension's, so this works across files and projects; the same-file
   * fallback keeps the extension useful while the language server is still
   * warming up.
   */
  private async resolveDeclaration(
    document: vscode.TextDocument,
    position: vscode.Position,
    config: vscode.WorkspaceConfiguration,
    token: vscode.CancellationToken,
  ): Promise<Declaration | undefined> {
    if (!config.get<boolean>('crossFile', true)) {
      return { uri: document.uri, line: position.line };
    }

    const timeoutMs = config.get<number>('definitionTimeoutMs', 1500);
    let locations: unknown;
    try {
      locations = await withTimeout(
        vscode.commands.executeCommand(
          'vscode.executeDefinitionProvider',
          document.uri,
          position,
        ),
        timeoutMs,
        token,
      );
    } catch {
      return { uri: document.uri, line: position.line };
    }

    const first = firstDeclaration(locations);
    return first ?? { uri: document.uri, line: position.line };
  }

  private async render(
    declaration: Declaration,
    config: vscode.WorkspaceConfiguration,
  ): Promise<string | undefined> {
    const skipWhenTagged = config.get<boolean>('skipWhenTagged', false);
    const cached = await this.cache.get(declaration);
    if (!cached) {
      return undefined;
    }
    if (skipWhenTagged && cached.hadSections) {
      return undefined;
    }
    return cached.markdown || undefined;
  }
}

interface Declaration {
  uri: vscode.Uri;
  line: number;
}

interface CacheEntry {
  version: number;
  markdown: string;
  hadSections: boolean;
}

/**
 * Hover fires on every mouse rest, so the same declaration is parsed over and
 * over. Entries are keyed by document version and dropped on edit, which is why
 * a stale entry cannot outlive the text it came from.
 */
class DeclarationCache implements vscode.Disposable {
  private readonly entries = new Map<string, CacheEntry>();

  async get(declaration: Declaration): Promise<CacheEntry | undefined> {
    let target: vscode.TextDocument;
    try {
      target = await vscode.workspace.openTextDocument(declaration.uri);
    } catch {
      // Decompiled metadata and other virtual documents have no `///` anyway.
      return undefined;
    }

    const key = `${declaration.uri.toString()}#${declaration.line}`;
    const hit = this.entries.get(key);
    if (hit && hit.version === target.version) {
      return hit;
    }

    const lines = target.getText().split(/\r?\n/);
    if (declaration.line < 0 || declaration.line >= lines.length) {
      return undefined;
    }
    const docLines = collectDocComment(lines, declaration.line);
    const result = docLines
      ? extractUntagged(docLines)
      : { markdown: '', hadSections: false };

    const entry: CacheEntry = { version: target.version, ...result };
    this.entries.set(key, entry);
    return entry;
  }

  invalidate(uri: vscode.Uri): void {
    const prefix = `${uri.toString()}#`;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
      }
    }
  }

  dispose(): void {
    this.entries.clear();
  }
}

/** `Location[]` and `LocationLink[]` are both legal replies; normalize to the first. */
function firstDeclaration(locations: unknown): Declaration | undefined {
  if (!Array.isArray(locations) || locations.length === 0) {
    return undefined;
  }
  const first = locations[0] as Partial<vscode.Location> & Partial<vscode.LocationLink>;
  if (first.targetUri) {
    const range = first.targetSelectionRange ?? first.targetRange;
    return range ? { uri: first.targetUri, line: range.start.line } : undefined;
  }
  if (first.uri && first.range) {
    return { uri: first.uri, line: first.range.start.line };
  }
  return undefined;
}

function withTimeout<T>(
  promise: Thenable<T>,
  ms: number,
  token: vscode.CancellationToken,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('cs-md-docs: definition lookup timed out')), ms);
    const cancel = token.onCancellationRequested(() => {
      clearTimeout(timer);
      reject(new Error('cs-md-docs: hover cancelled'));
    });
    promise.then(
      (value) => {
        clearTimeout(timer);
        cancel.dispose();
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        cancel.dispose();
        reject(error);
      },
    );
  });
}
