import * as vscode from 'vscode';
import { collectDocComment, extractUntagged, RenderOptions } from './docComment';

/** Target of an intra-doc link. Internal: reachable only from a hover we rendered. */
const GO_TO_SYMBOL = 'csMdDocs.goToSymbol';

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
    vscode.commands.registerCommand(GO_TO_SYMBOL, goToSymbol),
    vscode.workspace.onDidChangeTextDocument((e) => cache.invalidate(e.document.uri)),
    // Rendering options come from settings, and the cache holds rendered output.
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('csMdDocs')) {
        cache.clear();
      }
    }),
    cache,
  );
}

/**
 * Jump to the symbol an intra-doc link named. The workspace symbol provider is
 * the C# extension's, so this resolves anything Roslyn has in the solution, and
 * nothing when the language server has not started yet.
 *
 * There is no overload resolution here: a doc comment names a member, not a
 * signature, so the ranking prefers an exact `Container.Member` match and then
 * settles for the first member with the right name.
 */
async function goToSymbol(path: string): Promise<void> {
  const segments = path.split('.');
  const name = segments[segments.length - 1];
  const container = segments.slice(0, -1).join('.');

  let symbols: vscode.SymbolInformation[] | undefined;
  try {
    symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
      'vscode.executeWorkspaceSymbolProvider',
      name,
    );
  } catch {
    symbols = undefined;
  }

  let best: vscode.SymbolInformation | undefined;
  let bestScore = 0;
  for (const symbol of symbols ?? []) {
    const score = scoreSymbol(symbol, name, container);
    if (score > bestScore) {
      best = symbol;
      bestScore = score;
    }
  }

  if (!best) {
    void vscode.window.showWarningMessage(
      `cs-md-docs: no symbol named ${path} in the workspace.`,
    );
    return;
  }
  await vscode.window.showTextDocument(best.location.uri, {
    selection: best.location.range,
  });
}

/**
 * Zero means "not this symbol"; higher is a closer match to the written path.
 *
 * `containerName` is a display string and not an API contract: Roslyn fills it
 * with `in Device (project Sample (net10.0))` where the docs suggest something
 * like `Sample.Device`. So the qualifier is matched as whole words appearing
 * anywhere in it, which holds for either shape and does not depend on a phrasing
 * that is free to change or be localized.
 */
export function scoreSymbol(
  symbol: vscode.SymbolInformation,
  name: string,
  container: string,
): number {
  // Workspace symbol providers match fuzzily, so `Send` also returns `SendAsync`.
  const plain = symbol.name.replace(/[(<].*$/, '');
  if (plain !== name) {
    return 0;
  }
  if (!container) {
    return 2;
  }

  const owner = symbol.containerName ?? '';
  const wanted = container.split('.').filter(Boolean);
  const found = wanted.filter((segment) =>
    new RegExp(`\\b${segment.replace(/[^\w]/g, '\\$&')}\\b`).test(owner),
  ).length;
  if (found === wanted.length) {
    return 4;
  }
  // A name-only match still beats going nowhere, so an unqualified or
  // misqualified reference lands on the one member that carries the name.
  return found > 0 ? 3 : 1;
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
    // Trust scoped to one command, never `true`. The text comes from source files
    // that may not be ours, and a doc comment is free to write
    // `<a href="command:workbench.action.terminal.sendSequence?...">`, which
    // reaches this string as an ordinary Markdown link. Naming the single command
    // we emit ourselves means every other one is refused by VS Code.
    content.isTrusted = { enabledCommands: [GO_TO_SYMBOL] };
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
    const cached = await this.cache.get(declaration, renderOptions(config));
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

/**
 * Settings, in the shape the pure renderer takes. The symbol resolver is handed
 * in as a callback so `docComment.ts` never learns what a command URI is.
 */
function renderOptions(config: vscode.WorkspaceConfiguration): RenderOptions {
  const linksEnabled = config.get<boolean>('symbolLinks', true);
  return {
    demoteHeadings: config.get<number>('demoteHeadings', 2),
    symbolLink: linksEnabled
      ? (path) => `command:${GO_TO_SYMBOL}?${encodeURIComponent(JSON.stringify([path]))}`
      : undefined,
  };
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

  async get(
    declaration: Declaration,
    options: RenderOptions,
  ): Promise<CacheEntry | undefined> {
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
      ? extractUntagged(docLines, options)
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

  clear(): void {
    this.entries.clear();
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
