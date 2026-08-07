import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { scoreSymbol } from '../../extension';

/**
 * Runs inside a real VS Code extension host. Two modes:
 *
 * - `isolated`: every other extension disabled, so the only hover on screen is
 *   ours. Proves the provider is registered and renders.
 * - `roslyn`: the real C# extension loaded alongside. Proves the two hovers
 *   compose, and that neither sentinel sentence is rendered twice.
 */
export async function run(): Promise<void> {
  const mode = process.env.CSMD_MODE ?? 'isolated';
  const samplePath = path.resolve(__dirname, '../../../sample/Sample.cs');
  const document = await vscode.workspace.openTextDocument(samplePath);
  await vscode.window.showTextDocument(document);

  const failures: string[] = [];
  const check = async (name: string, body: () => Promise<void>): Promise<void> => {
    try {
      await body();
      console.log(`  ok   ${name}`);
    } catch (error) {
      failures.push(`${name}: ${(error as Error).message}`);
      console.log(`  FAIL ${name}\n       ${(error as Error).message}`);
    }
  };

  console.log(`cs-md-docs integration tests (${mode})`);

  await activateSelf();
  if (mode === 'roslyn') {
    await activateCSharp(document);
  }

  // In isolated mode there is no definition provider, so the extension falls
  // back to the line under the cursor and we hover the declarations. With Roslyn
  // present we hover the call sites, which exercises the definition lookup.
  const at = (member: string): vscode.Position => {
    const text = document.getText();
    // Call sites all live inside Use(), so searching from there cannot land on
    // the declaration by accident.
    const from = mode === 'roslyn' ? text.indexOf('public void Use()') : 0;
    const needle = mode === 'roslyn' ? `${member}(` : `public void ${member}(`;
    const offset = text.indexOf(needle, from);
    assert.ok(offset >= 0, `fixture is missing ${needle}`);
    return document.positionAt(offset + needle.indexOf(member) + 1);
  };

  const OURS = 'This sentence is untagged, so only cs-md-docs shows it.';
  const THEIRS = 'This sentence is tagged, so only Roslyn shows it.';

  await check('untagged prose reaches the hover', async () => {
    const text = await hoverText(document, at('Untagged'));
    assert.equal(occurrences(text, OURS), 1, `expected the untagged sentence once, got:\n${text}`);
  });

  await check('user Markdown survives the round trip', async () => {
    const text = await hoverText(document, at('Untagged'));
    assert.match(text, /- \*\*never\*\* match a reply by arrival order/);
    assert.match(text, /`softwareId`/);
  });

  await check('angle brackets are not eaten', async () => {
    const text = await hoverText(document, at('Untagged'));
    // Inside a user code span the brackets stay literal; in prose they are encoded.
    assert.match(text, /`Span<byte>`/);
    assert.match(text, /a &lt; b/);
  });

  await check('a fully tagged member gets nothing from us', async () => {
    const text = await hoverText(document, at('Tagged'));
    assert.equal(occurrences(text, OURS), 0, `we contributed to a tagged member:\n${text}`);
  });

  await check('four slashes is not a doc comment', async () => {
    const text = await hoverText(document, at('NotDocumented'));
    assert.equal(occurrences(text, 'ordinary comment'), 0, text);
  });

  await check('an attribute between comment and member is skipped', async () => {
    const text = await hoverText(document, at('PastAnAttribute'));
    assert.equal(occurrences(text, OURS), 1, `expected the untagged sentence once, got:\n${text}`);
  });

  await check('inline tags become Markdown', async () => {
    const text = await hoverText(document, at('Mixed'));
    assert.match(text, /`Sample\.Device\.Tagged`/);
    assert.match(text, /`List<int>`/);
  });

  await check('a fenced block reaches the hover verbatim', async () => {
    const text = await hoverText(document, at('RustShaped'));
    assert.match(text, /```csharp\r?\n/);
    assert.match(text, /var pressed = new List<int>\(\);/);
    assert.equal(occurrences(text, '&lt;'), 0, `something in the fence was escaped:\n${text}`);
    // The tag scanner has to be inert in here, or the rest of the comment is
    // swallowed by a <summary> that was only ever sample code.
    assert.match(text, /Even a doc tag in here is sample code/);
  });

  await check('headings are demoted and block Markdown survives', async () => {
    const text = await hoverText(document, at('RustShaped'));
    assert.match(text, /^### Examples$/m);
    assert.match(text, /^> A blockquote survives/m);
    assert.match(text, /^\| 3 \| `softwareId` \|$/m);
  });

  await check('intra-doc links become command links', async () => {
    const text = await hoverText(document, at('Referencing'));
    const command = /\(command:csMdDocs\.goToSymbol\?%5B%22([^%]+)%22%5D\)/g;
    const targets = [...text.matchAll(command)].map((m) => m[1]);
    assert.deepEqual(targets, ['Device.Tagged', 'Device.Untagged'], `got: ${text}`);
    assert.match(text, /\[`Device\.Tagged`\]\(command:/);
    assert.match(text, /\[the untagged one\]\(command:/);
  });

  await check('ordinary Markdown links are not turned into commands', async () => {
    const text = await hoverText(document, at('Referencing'));
    assert.match(text, /An ordinary \[note\] and a \[link\]\(https:\/\/example\.com\/x\)/);
  });

  if (mode === 'roslyn') {
    await check('a resolved intra-doc link finds the symbol', async () => {
      const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
        'vscode.executeWorkspaceSymbolProvider',
        'Tagged',
      );
      const seen = (symbols ?? [])
        .map((s) => `${s.containerName}|${s.name}`)
        .join('\n    ');
      // Ranked by the extension's own function rather than a copy of it, because
      // the copy is what silently drifted from what Roslyn actually returns.
      const ranked = (symbols ?? [])
        .map((symbol) => ({ symbol, score: scoreSymbol(symbol, 'Tagged', 'Device') }))
        .sort((a, b) => b.score - a.score);
      const best = ranked[0];
      assert.ok(best && best.score === 4, `no confident Device.Tagged among:\n    ${seen}`);
      assert.match(best.symbol.location.uri.fsPath, /Sample\.cs$/);
      assert.equal(
        best.symbol.location.range.start.line,
        document.getText().split('\n').findIndex((l) => l.includes('public void Tagged(')),
        'the link would jump to the wrong line',
      );
    });

    await check('a mixed comment shows each half exactly once', async () => {
      const text = await hoverText(document, at('Mixed'));
      assert.equal(occurrences(text, OURS), 1, `our half is not shown exactly once:\n${text}`);
      assert.equal(occurrences(text, THEIRS), 1, `Roslyn's half is not shown exactly once:\n${text}`);
    });

    await check('Roslyn still renders its own summary', async () => {
      const text = await hoverText(document, at('Tagged'));
      assert.equal(occurrences(text, THEIRS), 1, `Roslyn's summary is missing or doubled:\n${text}`);
    });
  }

  if (failures.length > 0) {
    throw new Error(`${failures.length} failed:\n  ${failures.join('\n  ')}`);
  }
  console.log(`all passed (${mode})`);
}

/** Every hover provider's contribution at a position, concatenated. */
async function hoverText(
  document: vscode.TextDocument,
  position: vscode.Position,
): Promise<string> {
  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
    'vscode.executeHoverProvider',
    document.uri,
    position,
  );
  return unescapeMarkdown(
    (hovers ?? [])
      .flatMap((hover) => hover.contents)
      .map((content) => (typeof content === 'string' ? content : content.value))
      .join('\n---\n'),
  );
}

/**
 * Roslyn escapes Markdown punctuation in its hover, so its half of the popup
 * reads `shows it\.` rather than `shows it.`. Undo that before comparing, or
 * every assertion about Roslyn's text fails for a reason that has nothing to do
 * with what is being tested. It is also the reason this extension exists: text
 * inside a summary is escaped into literal prose, text outside one is not.
 */
function unescapeMarkdown(text: string): string {
  return text.replace(/\\([\\`*_{}[\]()#+\-.!<>|~])/g, '$1');
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * `openTextDocument` fires the `onLanguage:csharp` activation event but does not
 * wait for it, so a hover asked immediately after finds no provider registered
 * and returns an empty array. Indistinguishable from rendering nothing.
 */
async function activateSelf(): Promise<void> {
  const self = vscode.extensions.getExtension('AlexanderReaper7.cs-md-docs');
  assert.ok(self, 'the extension under test was not loaded');
  await self.activate();
}

/**
 * Wait for the C# extension's language server to answer, rather than for its
 * activation event. Activation resolves long before Roslyn has a project loaded,
 * and a hover asked too early comes back empty and looks exactly like a bug in
 * this extension.
 */
async function activateCSharp(document: vscode.TextDocument): Promise<void> {
  const csharp = vscode.extensions.getExtension('ms-dotnettools.csharp');
  assert.ok(csharp, 'the C# extension is not present in the test instance');
  await csharp.activate();

  const offset = document.getText().indexOf('Tagged(default);');
  const position = document.positionAt(offset + 1);
  const deadline = Date.now() + 6 * 60_000;
  let lastSeen = '';
  while (Date.now() < deadline) {
    lastSeen = await hoverText(document, position);
    if (lastSeen.includes('This sentence is tagged')) {
      console.log('  Roslyn is answering hovers');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Roslyn never answered a hover within 6 minutes. Last reply:\n${lastSeen}`);
}
