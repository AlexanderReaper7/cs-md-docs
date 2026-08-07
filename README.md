# cs-md-docs

[![Marketplace](https://img.shields.io/visual-studio-marketplace/v/AlexanderReaper7.cs-md-docs?label=marketplace)](https://marketplace.visualstudio.com/items?itemName=AlexanderReaper7.cs-md-docs)
[![Open VSX](https://img.shields.io/open-vsx/v/AlexanderReaper7/cs-md-docs?label=open%20vsx)](https://open-vsx.org/extension/AlexanderReaper7/cs-md-docs)
[![CI](https://github.com/AlexanderReaper7/cs-md-docs/actions/workflows/ci.yml/badge.svg)](https://github.com/AlexanderReaper7/cs-md-docs/actions/workflows/ci.yml)

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

VSCodium, Cursor, Windsurf and Gitpod install the same thing from [Open VSX](https://open-vsx.org/extension/AlexanderReaper7/cs-md-docs). Every release also attaches a `.vsix` to its [GitHub release](https://github.com/AlexanderReaper7/cs-md-docs/releases), for installing by hand.

The C# extension (`ms-dotnettools.csharp`) is not a hard dependency, and the hover works without it. Roslyn is what supplies the other half of the popup and what resolves symbol links, so without it you get this extension's half alone.

## Writing comments it renders well

[docs/agents.md](docs/agents.md) is the practical guide: what goes in prose and what goes in a tag, why every `<` should be written `&lt;`, which spellings of a symbol reference resolve, and the traps. It is written as instructions for an AI agent working in your repository, so you can hand it to one directly or copy it into your own `CLAUDE.md`. It reads the same for a human.

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

``[`Device.Send`]`` renders as a link that jumps to the declaration, resolved when you click it rather than when the hover is drawn, so nothing is paid for a reference you never follow. `<see cref="M:Sample.Device.Send"/>` is the same idea in XML and resolves down the same path, as does `<see cref="M:Sample.Device.Send">the sender</see>`, which gives the link a label of its own. The bracket form is the one that does not require you to know XML doc id prefixes.

That crefs are links too was decided 2026-08-07. They rendered as dead code spans until then, which meant the two spellings of one idea behaved differently for no reason the reader could see, and Roslyn makes a cref clickable in its own half of the popup. The label keeps the cref as written and the query drops the signature, so `M:Device.Send(System.Span{System.Byte})` reads in full and searches for `Device.Send`.

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
- Backtick spans you write yourself are consumed whole before the tag scanner sees them, so `` `Span<byte>` `` keeps its angle brackets, and `` `Span&lt;byte&gt;` `` renders identically.
- Inline doc tags become Markdown: `<c>` to a code span, `<see cref="M:X.Y"/>` to a link, `<b>` to `**`, `<code>` to a fence, `<list><item>` to a bullet list.
- Only `<` and `&` are encoded. Encoding `>` as well was symmetric and wrong: once `<` is escaped no tag can open, so a lone `>` is never a tag close, while a `>` starting a line is a blockquote that the encoding silently destroyed.

### Writing `&lt;` has to be free

Decided 2026-08-07, measured against the .NET 10 SDK. Tolerating a raw `<` is not the same as making it the right thing to write, and for a project with `<GenerateDocumentationFile>true</GenerateDocumentationFile>` it is emphatically not:

```xml
<!-- Badly formed XML comment ignored for member "M:P.C.RawAngles" -->
```

CS1570 costs the member its *entire* entry in the doc file, `<param>` sections and all, not just the sentence containing the bracket. Backticks do not help and a fenced block does not help: csc parses the comment as XML before anything else looks at it, and it has never heard of a code span. So an author who wants a doc file has to write `&lt;`, and the extension's job is to make that spelling render as `<`.

Everything decodes entities, including the two opaque regions where the scanner otherwise touches nothing. That was not true of a backtick span until 2026-08-07, and the gap was invisible from either side alone: CommonMark does not resolve an entity inside a code span, so `` `Span&lt;byte&gt;` `` reached the reader as those literal characters, `<code>Span&amp;lt;byte&amp;gt;</code>` in the DOM. The author who did the XML-correct thing got garbage, and the author who got a correct hover lost the member from the doc file. There was no spelling that worked in both places, which is a defect rather than a trade-off.

## Fenced blocks are opaque

A fence you open is verbatim until it closes: no escaping, no tag scanning, no heading rewriting, no blank-line collapsing. That last one matters more than it sounds, and the first one matters most, since a Rust-shaped comment puts its example in a fence and an example is exactly where `List<int>` and `a < b` live.

The tag scanner being off inside a fence is the sharper property. A C# example that demonstrates a doc comment contains `<summary>`, and a scanner that noticed it would open a section and swallow the rest of your prose. Fences are tracked per line, following CommonMark: three or more backticks or tildes after up to three spaces of indent, closed by a run of the same character at least as long with nothing after it. A fence is only tracked at depth zero, so a stray ``` inside a `<summary>` cannot hide the closing tag.

## Markdown, not escaped prose

Roslyn escapes Markdown punctuation before putting a summary in the hover, so its half of the popup arrives as `shows it\.` and a `- bullet` inside a `<summary>` renders as a literal hyphen. Text this extension renders is not escaped, so lists, backticks and bold work. That difference showed up in the integration test as an assertion failure and is the sharpest argument for writing prose outside the tags.

## What a hover will and will not style

Decided 2026-08-07, against VS Code 1.132.0 (`df53daabb1`). Everything the hover stylesheet says about rendered Markdown is this:

```css
.monaco-hover p,.monaco-hover .code,.monaco-hover ul,.monaco-hover h1…h6{margin:8px 0}
.monaco-hover ul,.monaco-hover ol{padding-left:20px}
.monaco-hover code{border-radius:3px;padding:0 .4em;background-color:var(--vscode-textCodeBlock-background)}
.monaco-hover hr{margin:4px -8px -4px;height:1px}
```

There is no `table`, `th`, `td`, `blockquote` or `pre` rule in `workbench.desktop.main.css`, so those four arrive with the browser default: a quote is indented 40px with no bar, a table has no rules and no cell padding. The quote bar exists, but only under `.interactive-item-container` (chat) and `.review-widget` (comment threads). An extension cannot add CSS to a hover.

What it can do is bounded by the sanitizer's allow-list, which permits `style` only on a `span` and only matching

```js
/^(color\:(#[0-9a-fA-F]+|var\(--vscode(-[a-zA-Z0-9]+)+\));)?(background-color\:(…);)?(border-radius:[0-9]+px;)?$/
```

so `color`, `background-color`, `border-radius`, and nothing else. No border, no padding, no display. `class` is allowed on a `span` when it is a codicon, and `align`, `colspan` and `rowspan` are allowed on cells.

`csMdDocs.hoverStyling` spends exactly that budget. A quote gets a `▌` tinted `var(--vscode-textBlockQuote-border)`, once per paragraph, because consecutive quoted lines are one soft-wrapped paragraph and a bar per line would land mid-sentence. Table cells get `&nbsp;` padding, an entity rather than a space because marked trims real whitespace out of a cell before rendering it. Grid lines are not reachable at any price, which is why the alternative of drawing a monospace grid inside a fence was rejected: hover code is `pre-wrap`, so any table wider than the 500px content cap wraps and the grid falls apart, and cells would lose their code spans and links.

### The bar replaces the blockquote, it does not decorate one

Decided 2026-08-07, after looking at one on screen. The `>` marker is dropped and the bar emitted as ordinary paragraph text, so a quote sits flush with the prose around it.

The browser default is `margin-inline: 40px`, both sides. A hover's content box is `max-width: var(--vscode-hover-maxWidth, 500px)` less `padding: 4px 8px`, so about 484px, and a quote gives up 80px of it — 16.5% — for an element that, with no `.monaco-hover blockquote` rule, contributes nothing else. VS Code's own blockquote, in chat, is `margin:0; padding:0 16px 0 10px` over a 5px border: 15px of offset, and nothing off the right. Keeping the element meant paying 2.6x the house indent for a border it does not draw.

The marker stays when it is load-bearing, which is one criterion applied to the whole quote rather than a judgment per line: **the `>` goes only when every line of the quote is ordinary paragraph text.** A list, a fence, a heading, a table, an indented block and a nested quote all need the element to stay grouped, and a GitHub alert needs it to be rendered as an alert at all. One disqualifying line keeps the marker on the whole quote, so a quote is never half one thing and half the other.

The same predicate decides where the bar goes, because both questions turn on the same property. A span in front of `- item` or `| a | b |` is not a decorated list or table, it is a destroyed one: the line no longer starts with the character that opens the construct. So the bar goes on paragraph lines only, and an alert gets none at all, VS Code having already drawn its own from the `data-severity` it puts on the element. A table row is recognised by the delimiter beneath it rather than by containing a pipe, so prose with a pipe in it is still prose.

`docComment.test.ts` checks that mechanically rather than by inspection, asserting that no bar in the output is ever followed by a character that opens a block.

The flag also drives `MarkdownString.supportHtml`, which is otherwise off. That is safe because of one invariant: every `<` originating in the source file is either escaped by `escapeText` or sits inside a code span, so the only live tag in the string is one the decorator wrote. It is a real invariant and not a hope, so `docComment.test.ts` pins it with hostile input rather than leaving it to VS Code's sanitizer to catch.

Not fixable from here, for the record: fenced blocks get no background and wrap, footnotes are not a marked feature and render literally, `h1` is 2em because the stylesheet sets only `line-height` (hence `demoteHeadings`), and the 500px content cap is set programmatically with no setting behind it.

## Highlighting

Decided 2026-08-07, against VS Code 1.132.0. A hover tokenizes **fenced blocks only**, and only when the fence carries a language. Everything else that looks like code is a code span, which gets exactly two rules, `font-family: var(--monaco-monospace-font)` and `background-color: var(--vscode-textCodeBlock-background)`, and no tokenizer.

So `csMdDocs.defaultCodeLanguage` labels a fence that was written without one, both the fence `<code>` produces and a bare ``` fence in the Markdown. Only the opening delimiter is labelled: a closing one carrying an info string does not close anything, per CommonMark, and the fence would swallow the rest of the comment. A value with anything in it but letters, digits, `+`, `#` or `-` is ignored, because a backtick or a space in an info string breaks the fence it was meant to label.

rust-analyzer sets no such default, which is worth knowing because the rest of this extension follows it. It writes ```` ```rust ```` explicitly at every site that generates a signature (`crates/ide/src/hover/render.rs`) and passes an author's fence through untouched, so a bare fence in a rustdoc comment arrives grey there too, even though rustdoc's own convention is that a bare fence is Rust and gets compiled as a doctest. The convention is right and the tooling has not caught up; the language of the file is a better guess than nothing.

**Syntax colouring an inline code span is not reachable by any extension**, and this is the ceiling rather than a thing left undone. There is no tokenizer on the path, and there are no CSS variables to hand-colour with: `--vscode-*` is the workbench colour registry, and TextMate and semantic token colours are not in it. A `<span style="color:var(--vscode-symbolIcon-classForeground);">` is available and would apply one flat colour to every reference regardless of kind, which reads as a miscolour rather than as highlighting. Rejected for that reason. A symbol reference gets the link colour over the code-span background, and that is the whole palette.

One thing that is available and unused: the sanitizer allows `class` on a `span` when it matches `/^codicon codicon-[a-z\-]+( codicon-modifier-[a-z\-]+)?$/`, and `.monaco-hover .markdown-hover .hover-contents .codicon` sizes and colours it. The supported route is `MarkdownString.supportThemeIcons` with `$(symbol-method)` in the text rather than raw HTML. It was left out because the symbol's kind is not known when the hover is rendered: finding it costs a workspace symbol query per reference, on the mouse-rest path, to decide an icon.

## Settings

| Setting | Default | Effect |
|---|---|---|
| `csMdDocs.enable` | `true` | Master switch. |
| `csMdDocs.crossFile` | `true` | Resolve the declaration through the C# definition provider, so hovering a call site in another file works. Off means same-file only. |
| `csMdDocs.definitionTimeoutMs` | `1500` | Abandon the definition lookup after this long, so a slow language server never stalls the hover. |
| `csMdDocs.skipWhenTagged` | `false` | Suppress this hover entirely for members that have any XML section. |
| `csMdDocs.demoteHeadings` | `2` | Push every heading down this many levels, capped at `######`. Rust's `# Examples` becomes `### Examples`, so it reads as a section label rather than a title larger than the signature beside it. `0` renders headings as written. |
| `csMdDocs.hoverStyling` | `true` | Compensate for the constructs the hover stylesheet leaves unstyled: a themed bar on a blockquote, padding in table cells. Off keeps the output portable Markdown and turns `supportHtml` back off. See [What a hover will and will not style](#what-a-hover-will-and-will-not-style). |
| `csMdDocs.defaultCodeLanguage` | `"csharp"` | Label a fence written without a language, so the hover tokenizes it instead of showing it grey. Applies to `<code>` and to a bare ``` fence. `""` leaves them unlabelled. See [Highlighting](#highlighting). |
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

F5 launches the Extension Development Host on `sample/`, and each call in `Use()` is a case the parser is supposed to get right. Two configurations, decided 2026-08-07:

- **Run Extension** inherits this machine's profile, so Roslyn is there and the popup is the merged one a user actually gets. This is the one for looking at something.
- **Run Extension (isolated)** passes `--disable-extensions` and a throwaway `--user-data-dir`, matching the `isolated` test pass. This is the one for reproducing a bug with nothing else in the way.

`sample/` is opened by both because activation is `onLanguage:csharp`. On an empty window nothing activates, which reads as an editor with no extensions installed when everything is installed and merely idle. That is the trap this config exists to avoid, and it is easy to mistake for a broken launch profile.

Two things worth knowing about what isolation actually costs, measured against 1.132.0:

- `--disable-extensions` does **not** disable VS Code's own extensions. 95 stay loaded, `vscode.csharp` among them, so the `csharp` language id is registered and `csMdDocs.defaultCodeLanguage` still produces a tokenized fence. Without that the isolated pass could not get a hover at all, the provider being registered for `{ language: 'csharp' }`.
- What isolation does cost is Roslyn: no second half to the hover, no definition provider, and symbol links that resolve to nothing.

The theme costs less than it looks. `textBlockQuote.border` is `#007acc80` in the colour registry for both light and dark, so unless a theme overrides it the quote bar is the same colour everywhere and a screenshot from a default-theme dev host is honest about it. Syntax colours inside a fence are not, those being the theme's `tokenColors`.

Do not point a test instance at the real `--user-data-dir` to make it more realistic. It would let a test rewrite the state the editor is using, and no assertion in the suite reads a colour anyway. `npm run deploy` installs into the real editor, which is more realistic than any dev host and is the right way to look at a change.

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

## Releasing

Decided 2026-08-07. Publishing is tag-triggered, to the Visual Studio Marketplace and to Open VSX, by [.github/workflows/release.yml](.github/workflows/release.yml).

```powershell
# 1. bump the version and move the changelog's Unreleased entries under it, dated
npm version 0.2.0 --no-git-tag-version
# 2. check the three records agree before you tag, rather than after
npm run check-release -- v0.2.0
# 3. commit, then tag
git commit -am "0.2.0"
git tag v0.2.0
git push --follow-tags
```

The tag is the record of what shipped, which is why it triggers rather than a version change on `main`: a careless bump in an unrelated commit cannot publish, and re-releasing takes a new tag. That friction is deliberate, because the **Marketplace has no undo**. A published version cannot be replaced or withdrawn, only superseded by a higher one.

[scripts/check-release.mjs](scripts/check-release.mjs) is what enforces that, before anything is packaged. The tag, `package.json` and `CHANGELOG.md` are three independent records of one fact, and the script refuses the release when they disagree, naming which one is out of step. It also fails when `[Unreleased]` still has entries under it, since those are changes that are in the build and not in the notes. The same parse writes the release notes for `gh release create`, so there is one reader of the changelog rather than two that drift.

Ordering inside the workflow is by reversibility: the GitHub release first, because it can be deleted, then the Marketplace, then Open VSX. The two publishes take `--packagePath` rather than re-packaging, so the bytes on the Marketplace are the bytes attached to the release.

Two secrets, in a GitHub environment named `release`, which is also where a required reviewer goes if you want a human between the tag and the Marketplace:

| Secret | From | Notes |
|---|---|---|
| `VSCE_PAT` | An Azure DevOps PAT, **all accessible organizations**, Marketplace → Manage | Expires; a failed release a year from now is usually this |
| `OVSX_PAT` | [open-vsx.org](https://open-vsx.org) → Settings → Access Tokens | Needs the publisher namespace claimed first, once |

[.github/workflows/ci.yml](.github/workflows/ci.yml) runs on every push and pull request: `npm test` on Node 24 and 26, then `vsce package`, which is itself a test — a missing icon or a manifest field the Marketplace rejects fails there rather than at `git push --tags`. The extension-host suite is deliberately absent from CI. It needs a real VS Code, and its `roslyn` pass junctions the C# extension out of a local install, so registration, the sanitizer allow-list and the command link are covered by `npm run test:e2e` on a workstation and by nothing in CI. Run it before tagging.

The tile is [images/icon.svg](images/icon.svg), and [scripts/make-icon.py](scripts/make-icon.py) rasterizes it to `images/icon.png` (`npm run icon`, via uv, no system libraries). The SVG is the file to edit and the file to review: a binary in git is unreviewable, and "make it 8px darker" should be a diff. The PNG is committed anyway, because it is what the manifest points at and CI packages the extension without uv. It cannot be the SVG: vsce throws `SVGs can't be used as icons`, and the Marketplace strips an SVG out of a README unless it comes from a host on its trust list.

The PNG was previously drawn shape by shape with Pillow at 4x and downsampled, since Pillow's polygon fill has no antialiasing. resvg antialiases from the path, so it renders straight to 128. Two things came out of the switch, both 2026-08-07:

- The old corners rang. A windowed-sinc kernel has negative lobes, so LANCZOS downsampling of a curve overshoots, and the overshoot lands outside the shape as detached partial-alpha pixels: seven of them along the top-left arc alone, found by looking for a local alpha maximum where an arc can only be monotone. resvg computes coverage per pixel and has nothing to ring, so the same check returns nothing. Ignore the pixel diff between the two renders (22.4% of pixels, max channel 72, mean 1.03/255): it is edges only, and part of it is Pillow's `polygon` and `rounded_rectangle` being endpoint-inclusive, which had every shape a unit oversized in 512-space.
- The slashes lean like a real `/` now. Horizontal run over vertical rise is 0.406 in Consolas and 0.431 in Cascadia Mono, measured off the glyphs; the mark used to be 0.227, which reads as an italic bar. It is 0.418, and the rise came down from 256 to 220 to pay for the width a proper lean costs. The stroke stays at 0.155 of the rise against a real 0.10, because a glyph's weight is set for 14px text and this is a mark that has to survive 42px.

## Limits

- Untagged prose *is* written to the generated XML doc file, as the text content of the `<member>` element, and it satisfies CS1591 the same as a `<summary>` does. Both measured against the .NET 10 SDK, 2026-08-07. What no other tool does is *render* it: DocFX, Rider and Visual Studio read `<summary>`. This changes the editor, not a published NuGet package's documentation.
- Symbols from metadata (the BCL, NuGet dependencies) have no `///` in reach, so nothing is added to their hovers.
- A backtick span is matched within one line. A code span split across two `///` lines is not detected.
- Indented code blocks, the four-space kind, are **not** detected, so their content is escaped and tag-scanned like prose. Telling one from an indented continuation line inside a list needs real CommonMark block parsing, and rustdoc's own convention is fences anyway. Use a fence.
- Setext headings, the `===` and `---` underline kind, are not demoted. Only the ATX `#` form is.
- Intra-doc links resolve by name through the workspace symbol provider, so they need the language server up, and they cannot pick between overloads.
- A fenced block is not compiled, run or checked. There is no doctest equivalent.
