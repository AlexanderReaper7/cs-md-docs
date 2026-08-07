# Writing C# doc comments for cs-md-docs

Instructions for an AI agent authoring `///` comments in a repository where the [cs-md-docs](https://github.com/AlexanderReaper7/cs-md-docs) extension is installed. Copy this file into the consuming repository, or point your agent at its raw URL.

Everything below was measured against the .NET 10 SDK and the extension's own test suite, not inferred.

## The one rule

**Text outside an XML element is Markdown. Text inside one belongs to Roslyn.**

The C# extension's hover renders `<summary>`, `<param>`, `<returns>` and friends, and silently discards everything else in the comment. cs-md-docs renders exactly that discarded remainder, as Markdown. The two halves are complementary, so nothing is ever shown twice, and neither half needs to know about the other.

```csharp
/// Sends a HID output report and waits for the matching input report.
///
/// The reply is matched by the `softwareId` at byte 3, **never** by arrival
/// order: the device interleaves replies under load.
///
/// <param name="frame">The report body, without the report id.</param>
/// <exception cref="TimeoutException">No reply within the deadline.</exception>
public async Task<Reply> SendAsync(ReadOnlyMemory<byte> frame) { }
```

The prose renders as Markdown in the hover. The `<param>` and `<exception>` render as Roslyn's structured sections.

## Where to put what

| Content | Where | Why |
|---|---|---|
| The description, at any length | Untagged prose | This is the part Markdown buys you: lists, tables, fenced examples, links |
| Parameters, returns, exceptions, type parameters | `<param>`, `<returns>`, `<exception>`, `<typeparam>` | Roslyn renders these with the parameter names bolded and aligned; reproducing them in prose gets you two copies |
| A one-line summary for consumers who do **not** have this extension | `<summary>` | Untagged prose is invisible to a plain VS Code, to Rider, and to Visual Studio |

Do not write the same sentence in both places. A `<summary>` that repeats the first line of the prose shows up twice in the popup, once from each provider.

## Escaping: write `&lt;`, never `<`

This is the rule that matters most, and the one that is counterintuitive.

A raw `<` anywhere in a doc comment makes the compiler emit CS1570 **and drop the member's entire documentation** from the generated XML file:

```xml
<!-- Badly formed XML comment ignored for member "M:P.C.RawAngles" -->
```

Backticks do not help. A fenced code block does not help. The compiler parses the whole comment as XML before anything else looks at it, and it does not know what a code span is. The `<param>` sections go down with the prose.

So write the entity, everywhere, including inside code spans and fenced blocks:

```csharp
/// Takes a `Span&lt;byte&gt;` and holds while `a &lt; b`.
///
/// ```csharp
/// if (a &lt; b) { Send&lt;byte&gt;(frame); }
/// ```
```

cs-md-docs decodes entities before rendering, in prose, in code spans and inside fences alike, so the hover shows `Span<byte>` and `if (a < b)`. One source, correct in both places.

- `<` → `&lt;`
- `&` → `&amp;`
- `>` needs no escape, and must not be escaped at the start of a line, where it is a blockquote.

**Do not use `<![CDATA[...]]>`.** It is the XML-canonical escape hatch and the compiler accepts it, but cs-md-docs renders it verbatim: the reader sees `<![CDATA[` in the hover. Entities are the supported form.

If the project does not set `<GenerateDocumentationFile>true</GenerateDocumentationFile>` none of this is enforced, but write the entities anyway. The setting gets turned on later, and then every comment in the repository has to be fixed at once.

## What renders

Standard CommonMark, as understood by the renderer VS Code bundles.

**Paragraphs.** Consecutive `///` lines are one soft-wrapped paragraph. A `///` line with nothing after it is a paragraph break. `<br/>` is a hard line break inside a paragraph.

**Headings.** Written at the level you would use in a README, then demoted by two, so `# Examples` renders as an `<h3>`. This is `csMdDocs.demoteHeadings`, and it exists because a top-level heading in a hover is a title larger than the signature above it. Write `#` and `##`; anything deeper hits the `######` ceiling.

**Lists**, ordered and unordered, nested by indentation.

**Fenced code blocks.** A fence written without a language is labelled `csharp` and syntax highlighted, so ```` ``` ```` alone is enough for C#. Label it explicitly when it is not C#: a bare fence holding JSON or a shell command is tokenized as C# and mis-coloured. Everything inside a fence is opaque, including doc tags, so a fence may contain sample `///` comments.

**Tables.** Cells are padded automatically. The hover is about 484px wide, so keep them to two or three narrow columns.

**Blockquotes.** A quote of pure prose renders as a coloured bar rather than an indented block, because a real `blockquote` gives up 80px of that 484 to the browser's default margin. A quote containing a list, a fence, a heading, a table or a nested quote keeps its `>` markers, since that is what holds the construct inside the quote. Both cases are automatic.

**Alerts.** The five GitHub alerts render with their own colour, icon and title:

```csharp
/// > [!WARNING]
/// > Never match a reply by arrival order.
```

`NOTE`, `TIP`, `IMPORTANT`, `WARNING`, `CAUTION`, and only those five: any other name inside the brackets is quoted prose, here and on GitHub. The marker has to be the quote's first line. Everything after it is an ordinary quote, so a list or a fence under an alert keeps its `>` markers.

**Inline code spans** with backticks. Note that a code span is *never* syntax highlighted, in any VS Code hover, by any extension: there is no tokenizer on that path. Use a fenced block when the colour matters.

## Symbol links

Reference another type or member the way rustdoc does, and it becomes a link that jumps to the declaration:

```csharp
/// Pairs with [`Device.Send`], and unlike [the untagged one](Device.Untagged).
```

Two spellings, both supported:

- `` [`Device.Send`] `` or `[Device.Send]`, label and target in one
- `[some other words](Device.Send)`, when you want a different label

Rules that decide whether a bracket is a symbol reference at all:

- It must be **deliberate**: either wrapped in backticks, or containing a `.` (or `::`, accepted because it is what someone arriving from Rust types). A bare `[note]` in prose is left alone, so ordinary Markdown does not silently become a broken link.
- At least one segment must be PascalCase. This is what separates `Device.Send` from `readme.md`.
- Reference links `[text][ref]`, link definitions `[ref]: url`, and footnotes `[^1]` are never touched.
- A destination that is a URL is an ordinary link.

**Do not write generic arguments or a parameter list in a reference.** Write `` [`List.Add`] ``, never `` [`List<T>.Add`] ``. There is no overload resolution here, and a doc comment names a member rather than a signature, so the arguments buy nothing and cost you the link. Both spellings fail, in different directions:

- with a raw `<`, everything from it onward is stripped and the reference resolves to `List`, silently landing on the wrong symbol
- with the `&lt;` this document tells you to write everywhere else, the label is no longer a legal identifier path and the reference is not recognised as one at all, so it renders as an ordinary bracketed code span

The same goes for a parameter list: `` [`Device.Send(Span)`] `` is not a reference.

`<see cref="M:Namespace.Type.Member"/>` resolves down the same path and renders as the same link, with the `T:`/`M:`/`P:` doc-id prefix stripped. `<see langword="null"/>` renders as a code span.

Links resolve through the C# workspace symbol provider, so they need the language server to have loaded the solution. An unresolvable reference degrades to a plain code span rather than a dead link.

## Inline elements that are translated

Use these freely outside a section; they become the Markdown equivalent.

| Written | Renders as |
|---|---|
| `<c>x</c>`, `<tt>x</tt>` | `` `x` `` |
| `<code>…</code>` | a fenced block, labelled `csharp` |
| `<b>`, `<strong>` | `**bold**` |
| `<i>`, `<em>` | `*italic*` |
| `<paramref name="x"/>`, `<typeparamref name="T"/>` | `` `x` `` |
| `<para>` | a paragraph break |
| `<br/>` | a hard line break |
| `<list><item>…` | a bullet list |
| `<a href="…">text</a>` | a link |

`<u>` has no Markdown equivalent and is dropped. Prefer the Markdown spelling over the XML one throughout: `**bold**` over `<b>`, backticks over `<c>`, a fence over `<code>`. The XML forms exist so that a comment written before the extension still renders.

## Traps

- **Four slashes is not a doc comment.** `//// text` is an ordinary comment and renders nowhere. Three exactly.
- **These tags swallow their content**, because Roslyn owns it: `summary`, `remarks`, `returns`, `value`, `param`, `typeparam`, `exception`, `example`, `permission`, `completionlist`, `inheritdoc`, `include`, `seealso`, `altmember`, `threadsafety`. Markdown inside one of them is not rendered by anybody: Roslyn escapes it into literal prose. Put Markdown outside.
- **`<remarks>` is the tag to stop reaching for.** Long-form prose belongs untagged, which is the whole point of the extension.
- **Order does not matter** but readability does. Prose first, then the sections, as in the example at the top.
- The `/** … */` form works identically. `/*** … */` is an ordinary block comment and renders nowhere.

## Checklist before you finish a comment

1. Every `<` is written `&lt;`, and every `&` is written `&amp;`, including inside backticks and fences.
2. No `<![CDATA[`.
3. No sentence appears both in prose and in a `<summary>`.
4. Headings start at `#`, not `###`.
5. Symbol references carry no generic arguments and no parameter list.
6. Any fence that is not C# carries an explicit language.
7. `dotnet build` produces no CS1570 for the file.
