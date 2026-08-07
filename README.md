# cs-md-docs

Write C# doc comments the way Rust does, and see them on hover.

```csharp
/// Sends one HID++ frame to the receiver.
///
/// - the `softwareId` at byte 3 is how the reply is matched
/// - **never** match a reply by arrival order
public void Send(Span<byte> frame) { }
```

Roslyn renders `<summary>` and nothing else, so plain text above a member is invisible in the C# extension's hover even though the compiler keeps it in the XML file. This extension renders that text as Markdown, in the same hover popup.

## What it does not do

It never shows text that Roslyn already shows. The scanner tracks the depth of open XML section elements (`summary`, `remarks`, `param`, `returns`, `exception`, and the rest) and emits only what sits at depth zero. A member documented entirely with XML tags produces no output from this extension at all, so a mixed comment gives you the untagged prose from us and the tagged sections from Roslyn, once each.

VS Code asks every registered hover provider for a position and merges the results, which is why this composes with the C# extension instead of fighting it. The ordering of the merged sections is [not guaranteed](https://github.com/microsoft/vscode/issues/152897), so your prose may land above or below the signature block.

## Why the parser is hand-rolled

The text this extension exists to render is precisely the text that is not valid XML. `List<int>` and `a < b` both make a conforming parser fail, and the C# compiler agrees with it: the whole comment is dropped with CS1570. So the scanner treats `<` as a tag opener only when the name that follows is a known documentation element, and as a literal angle bracket otherwise.

Consequences, all of them deliberate:

- `List<int>` renders as written, because `int` is not a doc element.
- A custom `<mytag>` renders literally too, rather than swallowing the text inside it. Losing markup is better than losing prose.
- Backtick spans you write yourself are consumed whole before the tag scanner sees them, so `` `Span<byte>` `` keeps its angle brackets.
- Inline doc tags become Markdown: `<c>` to a code span, `<see cref="M:X.Y"/>` to `` `X.Y` ``, `<b>` to `**`, `<code>` to a fence, `<list><item>` to a bullet list.

## Markdown, not escaped prose

Roslyn escapes Markdown punctuation before putting a summary in the hover, so its half of the popup arrives as `shows it\.` and a `- bullet` inside a `<summary>` renders as a literal hyphen. Text this extension renders is not escaped, so lists, backticks and bold work. That difference showed up in the integration test as an assertion failure and is the sharpest argument for writing prose outside the tags.

## Settings

| Setting | Default | Effect |
|---|---|---|
| `csMdDocs.enable` | `true` | Master switch. |
| `csMdDocs.crossFile` | `true` | Resolve the declaration through the C# definition provider, so hovering a call site in another file works. Off means same-file only. |
| `csMdDocs.definitionTimeoutMs` | `1500` | Abandon the definition lookup after this long, so a slow language server never stalls the hover. |
| `csMdDocs.skipWhenTagged` | `false` | Suppress this hover entirely for members that have any XML section. |
| `csMdDocs.heading` | `""` | Markdown prepended to the output, e.g. `**Notes**\n\n`. |

## Development

```powershell
npm install
npm test              # parser unit tests, node --test
npm run test:e2e      # launches the installed VS Code twice and asserts on real hovers
```

`test:e2e` runs against the VS Code already installed on the machine rather than a downloaded build, in two passes. The first disables every other extension, so the only hover on screen is this one. The second junctions the installed `ms-dotnettools.csharp` into a throwaway extensions directory, waits for the Roslyn language server to start answering, and then asserts that each sentinel sentence in `sample/Sample.cs` appears exactly once across the merged popup. That last assertion is the whole no-duplication contract, checked against the real thing.

Set `CSMD_VSCODE` to point at a different `Code.exe`, or pass `isolated` / `roslyn` to `node out/test/runTests.js` to run one pass.

F5 in VS Code launches the Extension Development Host. Open `sample/Sample.cs` there and hover the calls in `Use()`; each one is a case the parser is supposed to get right.

One trap worth knowing: a terminal inside VS Code inherits `ELECTRON_RUN_AS_NODE=1`, which makes any `Code.exe` you spawn boot as plain Node and try to `require` the workspace folder. The runner clears it.

## Limits

- The compiler still only puts tagged content in the generated XML doc file. This changes the editor, not `dotnet build` output or a published NuGet package.
- Symbols from metadata (the BCL, NuGet dependencies) have no `///` in reach, so nothing is added to their hovers.
- A backtick span is matched within one line. A code span split across two `///` lines is not detected.
