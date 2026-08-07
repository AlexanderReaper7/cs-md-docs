# Changelog

Format is [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning is [semantic](https://semver.org/spec/v2.0.0.html). `scripts/check-release.mjs` refuses to publish when this file, `package.json` and the git tag disagree, so the newest heading below is always what shipped.

## [Unreleased]

### Fixed

- `<list type="number">` counts. It rendered every item as a bullet, the `type` attribute never having been read.
- A `<list>` nested in an `<item>` is indented to where the parent item's content starts, so it nests instead of ending the outer list. The indent is the parent's marker width, not a fixed step, because a `1.` marker opens its content at column three and a `-` at column two.
- The indented multi-line form, which is what Visual Studio's snippet writes, renders as a list. Inside a `<list>` every line ending and every indent now comes from the tags and none from the source layout: the tags' own line endings used to land between a marker and the content beneath it, and the XML indent put that content five spaces past the `1.` marker, one more than CommonMark allows before it becomes an indented code block.
- Prose after `</list>` is no longer read as a lazy continuation of the last item, which used to absorb it into the bullet.
- `<listheader>` is recognised. It reached the reader as literal `&lt;listheader>` text, the tag not being in the element table at all. It renders as an unmarked line above the items, Markdown having no header row for a list.
- `<code language="xml">` and `<code lang="…">` label the fence with what the element says. Every fence took `csMdDocs.defaultCodeLanguage` regardless, so an XML or PowerShell sample was tokenized as C#.

## [0.1.0] - 2026-08-07

First release.

### Added

- A hover provider for C# that renders the *untagged* prose of a `///` comment as Markdown. Roslyn renders the XML sections and discards everything else; this renders exactly that complement, so nothing appears twice.
- The `/** ... */` form as well as `///`, and a scan that walks up past attributes, blank lines and preprocessor directives to find the comment attached to a declaration.
- Cross-file resolution through the C# definition provider, so hovering a call site documents the declaration. Falls back to the line under the cursor when the language server has not answered within `csMdDocs.definitionTimeoutMs`.
- Intra-doc links in rustdoc's spelling: `` [`Device.Send`] `` and `[the sender](Device.Send)` become links that jump to the symbol via the workspace symbol provider. `<see cref="..."/>` resolves down the same path.
- Inline XML elements translated to Markdown: `<c>`, `<code>`, `<see>`, `<a>`, `<paramref>`, `<typeparamref>`, `<para>`, `<br>`, `<b>`, `<i>`, `<list>`/`<item>`/`<term>`.
- Hover decoration for the constructs the hover stylesheet does not style: a themed bar in place of a blockquote's browser-default 40px indent, and entity padding in table cells. Uses the only inline markup the hover sanitizer accepts.
- GitHub alerts, all five of `[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]` and `[!CAUTION]`, drawn with the colour and codicon VS Code uses for each. A hover cannot get them any other way: the renderer's own alert parser is behind `MarkdownString.supportAlertSyntax`, which is proposed API, and the `border-left` it would draw is scoped to chat and comment threads.
- `csMdDocs.defaultCodeLanguage`, defaulting to `csharp`, so a fence written without a language is syntax highlighted rather than grey.
- Settings for the rest: `enable`, `crossFile`, `definitionTimeoutMs`, `skipWhenTagged`, `demoteHeadings`, `hoverStyling`, `symbolLinks`, `heading`.

[Unreleased]: https://github.com/AlexanderReaper7/cs-md-docs/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/AlexanderReaper7/cs-md-docs/releases/tag/v0.1.0
