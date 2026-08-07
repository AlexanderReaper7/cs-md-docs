# cs-md-docs

A VS Code extension that renders the *untagged* prose of a C# `///` comment as Markdown in the hover. Roslyn renders the XML sections and discards the rest; this renders exactly that complement, so the two hovers compose and nothing is shown twice. Shaped after rustdoc on purpose.

## The map

| File | What it is |
|---|---|
| [src/docComment.ts](src/docComment.ts) | The renderer. Pure, and free of any `vscode` import so `node --test` can drive it. This is where nearly all the behaviour lives |
| [src/extension.ts](src/extension.ts) | The editor side: hover provider, the `csMdDocs.goToSymbol` command, settings, the declaration cache |
| [src/test/docComment.test.ts](src/test/docComment.test.ts) | The renderer's suite. Fast, runs anywhere |
| [src/test/suite/index.ts](src/test/suite/index.ts) | Runs inside a real extension host, twice: `isolated` and `roslyn`. The only place registration, the sanitizer and command links are checked |
| [sample/Sample.cs](sample/Sample.cs) | Fixture for the above, and the file F5 opens. Every member is a case |
| [README.md](README.md) | The Marketplace page. What it does, how to install it, the settings table, the limits |
| [docs/design.md](docs/design.md) | The design record. Why, and what was measured |
| [docs/agents.md](docs/agents.md) | Consumer-facing: how to write a doc comment that renders well. Written for someone else's agent |
| [CHANGELOG.md](CHANGELOG.md) | What shipped. `scripts/check-release.mjs` holds it against the tag and the manifest |

## Never

- **Never set `isTrusted = true`.** It is scoped to the one command we emit, in [src/extension.ts:156](src/extension.ts#L156). The text comes from source files that may not be ours, and a doc comment is free to write `<a href="command:workbench.action.terminal.sendSequence?…">`, which reaches the `MarkdownString` as an ordinary Markdown link.
- **Never import `vscode` into `docComment.ts`.** The editor is reached through the `symbolLink` callback in `RenderOptions` and nothing else. That import is the only thing standing between the current unit suite and having to boot Electron to test a regex.
- **Never widen the emitted HTML** beyond `<span style="color:var(--vscode-…);">`. The hover sanitizer tests the attribute against a regex; a space after the colon or a missing semicolon drops the whole attribute silently, and no error is reported anywhere. The only other markup we emit is a codicon `span` in an alert title, allowed by a `class` regex of its own. See *What a hover will and will not style* in [docs/design.md](docs/design.md).
- **Never escape `>`.** It was symmetric with `<` and it was wrong: no tag can open once `<` is encoded, so a lone `>` is never a tag close, while a `>` at the start of a line is a blockquote that encoding destroyed.
- **Never point a test instance or a dev host at the real `--user-data-dir`.** It rewrites state the editor you are using depends on. Both launch configs and both test passes use a throwaway.
- **Never re-package during a release.** The workflow publishes the exact `.vsix` it attached to the GitHub release, via `--packagePath`, so the Marketplace and the release cannot be different builds of one version.
- **Never assume a version can be withdrawn.** The Marketplace has no undo; a published version can only be superseded.

## Where the decisions are written down

[docs/design.md](docs/design.md) is the record, and each section carries what was measured rather than the conclusion alone. The README is the Marketplace page and states rules without their reasons; when the two disagree, the design record is the one that was measured.

- Why the parser is hand-rolled rather than an XML parse: *Why the parser is hand-rolled*
- Why a blockquote loses its `>`, with the 40px/484px measurement: *The bar replaces the blockquote, it does not decorate one*
- Why a `<list>` discards the source's line endings and indentation, and why `OpenList` carries two indents rather than a depth: *Inside a list, the source layout is discarded*
- Why an alert's title and bar are drawn here, `supportAlertSyntax` being proposed API: *Alerts are drawn here because nothing downstream will*
- Why an inline code span is never syntax highlighted, and what rust-analyzer does instead: *Highlighting*
- Which spellings of a symbol reference resolve, and why a bare `[note]` does not: *Referencing symbols*, and the rules themselves in the README
- The two launch configurations, what isolation costs, and why waiting for Roslyn takes two signals: *Development*
- Tagging, the guard, the two registries, and why there are no badges: *Releasing*
- Why the tile is an SVG that cannot ship, why the PNG is committed anyway, and where the slashes' lean comes from: *Releasing*, last two paragraphs

## Verifying

```powershell
npm test          # compile + the renderer suite, seconds
npm run test:e2e  # two real VS Code instances, minutes, waits for Roslyn
npm run deploy    # test, package, install into this machine's VS Code
```

`npm test` cannot see a change to registration, to the sanitizer allow-list, or to a command link. Neither can CI, which runs the unit suite only. `test:e2e` is the only thing that can, and it needs a workstation with VS Code and the C# extension installed. Say which of the two you ran.

Colorization is not covered by anything: it happens in the renderer, past every assertion. A claim about how something *looks* needs a screenshot.

## Style

The comments in this repository explain why, and name what was rejected. Match that. A comment restating the line beneath it is noise; a comment recording a measurement, a constraint from another codebase, or an approach that failed is the reason the file is readable a year later.
