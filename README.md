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

## Installing

Search for **C# Markdown Doc Comments** in the Extensions view, or:

```powershell
code --install-extension AlexanderReaper7.cs-md-docs
```

VSCodium, Cursor, Windsurf and Gitpod install the same thing from [Open VSX](https://open-vsx.org/extension/AlexanderReaper7/cs-md-docs). Every release also attaches a `.vsix` to its [GitHub release](https://github.com/AlexanderReaper7/cs-md-docs/releases).

The C# extension (`ms-dotnettools.csharp`) is not a hard dependency, and the hover works without it. Roslyn is what supplies the other half of the popup and what resolves symbol links, so without it you get this extension's half alone.

## Writing comments it renders well

[docs/agents.md](docs/agents.md) is the practical guide: what goes in prose and what goes in a tag, why every `<` must be written `&lt;`, which spellings of a symbol reference resolve, and the traps. It is written as instructions for an AI agent working in your repository, so you can hand it to one directly or copy it into your own `CLAUDE.md`. It reads the same for a human.

## Heavily inspired by rustdoc

The whole design is lifted from [Rust's documentation comments](https://doc.rust-lang.org/rustdoc/how-to-write-documentation.html), where the doc comment *is* Markdown and needs no ceremony to say something. Everything here is an attempt to make that shape work in C# without breaking the XML convention it has to live beside.

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

``[`Device.Send`]`` renders as a link that jumps to the declaration, resolved when you click it rather than when the hover is drawn. `<see cref="M:Sample.Device.Send"/>` resolves down the same path, as does the form with a label of its own.

Resolution is by name, not by signature: a doc comment names a member, and overloads are indistinguishable at that level. A bracket only becomes a reference when the author clearly meant one, so `[note]`, `[^1]`, `[text][ref]`, `[ ]` checkboxes and `[readme](readme.md)` all pass through as ordinary Markdown. The rules are in [docs/agents.md](docs/agents.md); why a cref is a link rather than a dead code span, and why a bare `[note]` is not a reference, in [docs/design.md](docs/design.md#referencing-symbols).

The hover's `isTrusted` is scoped to the one command this extension emits, never `true`. Doc text comes from source files that may not be yours, and a comment is free to write `<a href="command:workbench.action.terminal.sendSequence?...">`, which arrives here as an ordinary Markdown link. Naming the single command means VS Code refuses every other one.

## Alerts

The five GitHub alerts are drawn in the hover, each with its own colour and icon:

```csharp
/// > [!WARNING]
/// > Never match a reply by arrival order.
```

`NOTE`, `TIP`, `IMPORTANT`, `WARNING` and `CAUTION`, and only those. Drawn here rather than by VS Code, which cannot: [docs/design.md](docs/design.md#alerts-are-drawn-here-because-nothing-downstream-will).

## How it composes with the C# extension

It never shows text that Roslyn already shows. The scanner tracks the depth of open XML section elements and emits only what sits at depth zero, so a mixed comment gives you the untagged prose from us and the tagged sections from Roslyn, once each. A member documented entirely with XML tags produces no output from this extension at all.

VS Code asks every registered hover provider for a position and merges the results, which is why this composes instead of fighting. The ordering of the merged sections is [not guaranteed](https://github.com/microsoft/vscode/issues/152897), so your prose may land above or below the signature block.

## Settings

| Setting | Default | Effect |
|---|---|---|
| `csMdDocs.enable` | `true` | Master switch. |
| `csMdDocs.crossFile` | `true` | Resolve the declaration through the C# definition provider, so hovering a call site in another file works. Off means same-file only. |
| `csMdDocs.definitionTimeoutMs` | `1500` | Abandon the definition lookup after this long, so a slow language server never stalls the hover. |
| `csMdDocs.skipWhenTagged` | `false` | Suppress this hover entirely for members that have any XML section. |
| `csMdDocs.demoteHeadings` | `2` | Push every heading down this many levels, capped at `######`, so rustdoc's `# Examples` reads as a section label rather than a title larger than the signature. `0` renders headings as written. |
| `csMdDocs.hoverStyling` | `true` | Compensate for the constructs the hover stylesheet leaves unstyled: a themed bar on a blockquote, a title and icon on an alert, padding in table cells. Off keeps the output portable Markdown. See [what a hover will and will not style](docs/design.md#what-a-hover-will-and-will-not-style). |
| `csMdDocs.defaultCodeLanguage` | `"csharp"` | Label a fence written without a language, so the hover tokenizes it instead of showing it grey. Applies to `<code>` and to a bare ``` fence. See [highlighting](docs/design.md#highlighting). |
| `csMdDocs.symbolLinks` | `true` | Turn a bracket reference into a link that jumps to the symbol. Off renders it as a plain code span. |
| `csMdDocs.heading` | `""` | Markdown prepended to the output, e.g. `**Notes**\n\n`. |

## Limits

- Untagged prose *is* written to the generated XML doc file, and it satisfies CS1591 the same as a `<summary>` does. Both measured against the .NET 10 SDK, 2026-08-07. What no other tool does is *render* it: DocFX, Rider and Visual Studio read `<summary>`. This changes the editor, not a published NuGet package's documentation.
- Symbols from metadata (the BCL, NuGet dependencies) have no `///` in reach, so nothing is added to their hovers.
- Intra-doc links need the language server up, and cannot pick between overloads.
- Indented code blocks, the four-space kind, are **not** detected, so their content is escaped and tag-scanned like prose. Use a fence, which is rustdoc's convention anyway.
- Setext headings, the `===` and `---` underline kind, are not demoted. Only the ATX `#` form is. A backtick span is matched within one line, so a code span split across two `///` lines is not detected.
- Inside a `<list>` the structure is generated from the tags, so an item cannot hold more than one paragraph, and `<list type="table">` renders as a bullet list rather than a Markdown table. See [inside a list, the source layout is discarded](docs/design.md#inside-a-list-the-source-layout-is-discarded).

## Development

```powershell
npm install
npm test              # parser unit tests, node --test
npm run test:e2e      # launches the installed VS Code twice and asserts on real hovers
npm run deploy        # test, package, install into the VS Code on this machine
```

[docs/design.md](docs/design.md) is the design record, and carries what was measured rather than the conclusion alone: why the parser is hand-rolled, what a hover will and will not style, what the two launch configurations cost, how a release is tagged and published, and what each of those was measured against.
