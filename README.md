# cs-md-docs

Write C# doc comments the way Rust does, and see them on hover.

````csharp
/// Sends one HID++ frame to the receiver.
///
/// - the `softwareId` at byte 3 is how the reply is matched
/// - **never** match a reply by arrival order
///
/// # Examples
///
/// ```csharp
/// dev.Send(stackalloc byte[] { 0x10, 0x01 });
/// ```
///
/// Pairs with [`Device.Receive`], which blocks until the reply arrives.
public void Send(Span<byte> frame) { }
````

Roslyn renders `<summary>` and nothing else, so plain text above a member is invisible in the C# extension's hover even though the compiler keeps it in the XML file. This extension renders that text as Markdown, in the same hover popup.

## Heavily inspired by rustdoc

The whole design is lifted from [Rust's documentation comments](https://doc.rust-lang.org/rustdoc/how-to-write-documentation.html), where the doc comment *is* Markdown and needs no ceremony to say something: `///` above an item, prose in the body, `#` headings for the conventional sections, fenced blocks for examples, and a bracketed path to point at another symbol. Everything below is an attempt to make that shape work in C# without breaking the XML convention it has to live beside.

What carried over, and what it maps to:

| rustdoc | here |
|---|---|
| `///` prose renders as Markdown | same, for prose outside any XML tag |
| `# Examples`, `# Panics`, `# Safety` | same, demoted two levels so a hover is not all title |
| ``` ```rust ``` fenced examples | any fenced block, verbatim: tag scanner and escaping are both off inside it |
| ``[`Vec::push`]`` intra-doc links | ``[`Device.Send`]``, resolved through the C# workspace symbol provider. `::` is accepted too |
| `[text](Type::method)` | `[text](Device.Send)` |
| `//!` inner doc comments | nothing. C# has no module item to hang them on |
| doctests | nothing. A fenced block is not compiled or run |

## Referencing symbols

``[`Device.Send`]`` renders as a link that jumps to the declaration, resolved when you click it rather than when the hover is drawn, so nothing is paid for a reference you never follow. `<see cref="M:Sample.Device.Send"/>` still works and still renders as a code span; the bracket form is the one that does not require you to know XML doc id prefixes.

A bracket only becomes a reference when the author clearly meant one, which is a single rule: the path is **qualified** (`[Device.Send]`) **or wrapped in backticks** (``[`Send`]``), and at least one segment starts with an uppercase letter. Everything else is ordinary Markdown and passes through untouched, which covers `[note]`, `[^1]` footnotes, `[text][ref]` reference links and their `[ref]: url` definitions, `[ ]` checkboxes, and `[readme](readme.md)`, which has no uppercase segment and so names a file rather than a type.

Resolution is by name, not by signature: a doc comment names a member, and overloads are indistinguishable at that level. Generic arguments and parameter lists are stripped before the lookup but kept in the label, so ``[`Send(Span<byte>)`]`` reads as written and searches for `Send`.

The hover's `isTrusted` is scoped to the one command this extension emits, never `true`. Doc text comes from source files that may not be yours, and a comment is free to write `<a href="command:workbench.action.terminal.sendSequence?...">`, which arrives here as an ordinary Markdown link. Naming the single command means VS Code refuses every other one.

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
- Only `<` and `&` are encoded. Encoding `>` as well was symmetric and wrong: once `<` is escaped no tag can open, so a lone `>` is never a tag close, while a `>` starting a line is a blockquote that the encoding silently destroyed.

## Fenced blocks are opaque

A fence you open is verbatim until it closes: no escaping, no tag scanning, no heading rewriting, no blank-line collapsing. That last one matters more than it sounds, and the first one matters most, since a Rust-shaped comment puts its example in a fence and an example is exactly where `List<int>` and `a < b` live.

The tag scanner being off inside a fence is the sharper property. A C# example that demonstrates a doc comment contains `<summary>`, and a scanner that noticed it would open a section and swallow the rest of your prose. Fences are tracked per line, following CommonMark: three or more backticks or tildes after up to three spaces of indent, closed by a run of the same character at least as long with nothing after it. A fence is only tracked at depth zero, so a stray ``` inside a `<summary>` cannot hide the closing tag.

## Markdown, not escaped prose

Roslyn escapes Markdown punctuation before putting a summary in the hover, so its half of the popup arrives as `shows it\.` and a `- bullet` inside a `<summary>` renders as a literal hyphen. Text this extension renders is not escaped, so lists, backticks and bold work. That difference showed up in the integration test as an assertion failure and is the sharpest argument for writing prose outside the tags.

## Settings

| Setting | Default | Effect |
|---|---|---|
| `csMdDocs.enable` | `true` | Master switch. |
| `csMdDocs.crossFile` | `true` | Resolve the declaration through the C# definition provider, so hovering a call site in another file works. Off means same-file only. |
| `csMdDocs.definitionTimeoutMs` | `1500` | Abandon the definition lookup after this long, so a slow language server never stalls the hover. |
| `csMdDocs.skipWhenTagged` | `false` | Suppress this hover entirely for members that have any XML section. |
| `csMdDocs.demoteHeadings` | `2` | Push every heading down this many levels, capped at `######`. Rust's `# Examples` becomes `### Examples`, so it reads as a section label rather than a title larger than the signature beside it. `0` renders headings as written. |
| `csMdDocs.symbolLinks` | `true` | Turn a bracket reference into a link that jumps to the symbol. Off renders it as a plain code span. |
| `csMdDocs.heading` | `""` | Markdown prepended to the output, e.g. `**Notes**\n\n`. |

## Development

```powershell
npm install
npm test              # parser unit tests, node --test
npm run test:e2e      # launches the installed VS Code twice and asserts on real hovers
npm run deploy        # test, package, install into the VS Code on this machine
```

`test:e2e` runs against the VS Code already installed on the machine rather than a downloaded build, in two passes. The first disables every other extension, so the only hover on screen is this one. The second junctions the installed `ms-dotnettools.csharp` into a throwaway extensions directory, waits for the Roslyn language server to start answering, and then asserts that each sentinel sentence in `sample/Sample.cs` appears exactly once across the merged popup. That last assertion is the whole no-duplication contract, checked against the real thing.

Set `CSMD_VSCODE` to point at a different `Code.exe`, or pass `isolated` / `roslyn` to `node out/test/runTests.js` to run one pass.

F5 in VS Code launches the Extension Development Host. Open `sample/Sample.cs` there and hover the calls in `Use()`; each one is a case the parser is supposed to get right.

One trap worth knowing: a terminal inside VS Code inherits `ELECTRON_RUN_AS_NODE=1`, which makes any `Code.exe` you spawn boot as plain Node and try to `require` the workspace folder. The runner clears it, and so does the deploy script.

## Deploying

`npm run deploy` runs the unit tests, packages a VSIX and installs it over whatever is there. Seven seconds end to end. It refuses to package anything the tests reject, so a broken parser cannot reach the editor; the end-to-end suite is not part of it, because launching VS Code twice and waiting for Roslyn is minutes rather than seconds.

```powershell
npm run deploy
npm run deploy -- -SkipTests      # compile only, for a tight loop
npm run package                   # write the VSIX, install nothing
npm run deploy -- -Code 'C:\Program Files\Microsoft VS Code Insiders\Code - Insiders.exe'
```

Installing does not reload a running window. VS Code offers to restart, or `Ctrl+Shift+P`, `Developer: Reload Window`.

Two details the script gets right that are easy to get wrong by hand. It installs through `bin\code.cmd` rather than `Code.exe`, because the executable is the GUI entry point and detaches, returning success before the install has happened. And it passes `--force`, because the version in `package.json` rarely changes between deploys and without the flag the CLI treats an equal version as already installed and exits zero having done nothing.

### The post-commit hook

Committing installs the result. The hook is [.githooks/post-commit](.githooks/post-commit), and `npm install` points `core.hooksPath` at that directory through the `prepare` script, so a fresh clone gets it without a separate step. `npm run hooks` does the same thing on demand.

*Post*-commit, decided 2026-08-07, for two reasons. Installing before the commit would deploy a working tree that is not what got recorded, so the editor and the history could disagree about what is running. And a failing install is information rather than grounds for refusing a commit, which is precisely the leverage a post-commit hook does not have.

To skip it, set an environment variable. `git commit --no-verify` will not do it: that flag only skips `pre-commit` and `commit-msg` and never reaches this hook.

```powershell
$env:CSMD_NO_DEPLOY = '1'; git commit -m "readme typo"; $env:CSMD_NO_DEPLOY = $null
```

If `pwsh` is not on the PATH the hook says so and exits zero. `scripts/install-hooks.mjs` is Node rather than PowerShell for the same reason: it runs from npm's `prepare`, where node is guaranteed and pwsh is not, so a machine without PowerShell can still install the package and get a hook that declines to run.

## Limits

- The compiler still only puts tagged content in the generated XML doc file. This changes the editor, not `dotnet build` output or a published NuGet package.
- Symbols from metadata (the BCL, NuGet dependencies) have no `///` in reach, so nothing is added to their hovers.
- A backtick span is matched within one line. A code span split across two `///` lines is not detected.
- Indented code blocks, the four-space kind, are **not** detected, so their content is escaped and tag-scanned like prose. Telling one from an indented continuation line inside a list needs real CommonMark block parsing, and rustdoc's own convention is fences anyway. Use a fence.
- Setext headings, the `===` and `---` underline kind, are not demoted. Only the ATX `#` form is.
- Intra-doc links resolve by name through the workspace symbol provider, so they need the language server up, and they cannot pick between overloads.
- A fenced block is not compiled, run or checked. There is no doctest equivalent.
