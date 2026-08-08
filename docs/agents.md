# Writing C# doc comments for cs-md-docs

Instructions for an AI agent authoring `///` comments in a repository where the [cs-md-docs](https://github.com/AlexanderReaper7/cs-md-docs) extension is installed. Copy this file into the consuming repository, or point your agent at its raw URL.

Everything below was measured against the .NET 10 SDK and the extension's own test suite, not inferred.

## The one rule

**Text outside an XML element is Markdown. Text inside one belongs to Roslyn.**

The C# extension's hover renders `<summary>`, `<param>`, `<returns>` and friends, and silently discards everything else. cs-md-docs renders exactly that discarded remainder, as CommonMark, so nothing is ever shown twice.

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

## Where to put what

| Content | Where |
|---|---|
| The description, at any length: lists, tables, fences, links | Untagged prose |
| Parameters, returns, exceptions, type parameters | `<param>`, `<returns>`, `<exception>`, `<typeparam>` |
| A one-line summary for readers without this extension (plain VS Code, Rider, Visual Studio) | `<summary>` |

Do not write the same sentence in both places. A `<summary>` repeating the first line of the prose shows up twice in the popup, once from each provider.

## Escaping: write `&lt;`, never `<`

A raw `<` anywhere in a doc comment makes the compiler emit CS1570 **and drop the member's entire documentation**, `<param>` sections included. Backticks do not help, and neither does a fenced block: the compiler parses the whole comment as XML before anything else looks at it, and it does not know what a code span is.

So write the entity everywhere, inside code spans and fences alike. cs-md-docs decodes entities before rendering, so `` `Span&lt;byte&gt;` `` reaches the hover as `Span<byte>`.

- `<` → `&lt;`
- `&` → `&amp;`
- `>` needs no escape, and must not be escaped at the start of a line, where it is a blockquote.

**Do not use `<![CDATA[...]]>`.** The compiler accepts it, but cs-md-docs renders it verbatim and the reader sees `<![CDATA[` in the hover.

Write the entities even where the project does not set `<GenerateDocumentationFile>true</GenerateDocumentationFile>` and nothing is enforced. The setting gets turned on later, and then every comment in the repository has to be fixed at once.

## What renders differently than you would expect

- **Headings are demoted by two.** Write at the level you would use in a README, so `# Examples` renders as an `<h3>`. Anything past `##` hits the `######` ceiling.
- **A fence without a language is labelled `csharp`** and highlighted as C#. Anything that is not C# needs an explicit language or it is tokenized as C# and mis-coloured.
- **The hover is about 484px wide.** Keep tables to two or three narrow columns.
- **An inline code span is never syntax highlighted**, in any VS Code hover, by any extension. Use a fence when the colour matters.
- **GitHub alerts render** with their colour, icon and title: `NOTE`, `TIP`, `IMPORTANT`, `WARNING`, `CAUTION`, and only those five.

## Symbol links

Reference another type or member the way rustdoc does, and it becomes a link that jumps to the declaration:

```csharp
/// Pairs with [`Device.Send`], and unlike [the untagged one](Device.Untagged).
```

- A bracket is a symbol reference only when it is **deliberate**: wrapped in backticks, or containing a `.` (or `::`). At least one segment must be PascalCase, which is what separates `Device.Send` from `readme.md`.
- **No generic arguments and no parameter list.** Write `` [`List.Add`] ``, never `` [`List<T>.Add`] `` and never `` [`Device.Send(Span)`] ``. There is no overload resolution here, and both spellings fail: with a raw `<` the reference silently resolves to `List`, and with `&lt;` it is not recognised as a reference at all.
- `<see cref="M:Namespace.Type.Member"/>` resolves down the same path, with the `T:`/`M:`/`P:` prefix stripped. `<see langword="null"/>` renders as a code span.

## Inline XML

`<c>`, `<code>`, `<b>`, `<i>`, `<paramref>`, `<para>`, `<br/>`, `<list>`, `<listheader>` and `<a href>` are translated to their Markdown equivalents, so an older comment still renders. Prefer the Markdown spelling when writing: `**bold**` over `<b>`, backticks over `<c>`, a fence over `<code>`. `<u>` is dropped.

A `<list>` may be laid out across as many lines as you like, since the source's indentation is discarded. The one thing that costs you is a blank line inside an `<item>`: an item is a single paragraph.

## Traps

- **These tags swallow their content**, because Roslyn owns it: `summary`, `remarks`, `returns`, `value`, `param`, `typeparam`, `exception`, `example`, `permission`, `completionlist`, `inheritdoc`, `include`, `seealso`, `altmember`, `threadsafety`. Markdown inside one is rendered by nobody; Roslyn escapes it into literal prose. Put Markdown outside.
- **`<remarks>` is the tag to stop reaching for.** Long-form prose belongs untagged, which is the whole point of the extension.
- **Four slashes is not a doc comment.** `//// text` renders nowhere, and so does `/*** … */`. Three exactly, or `/** … */`.

## Checklist before you finish a comment

1. Every `<` is written `&lt;`, and every `&` is written `&amp;`, including inside backticks and fences.
2. No `<![CDATA[`.
3. No sentence appears both in prose and in a `<summary>`.
4. Headings start at `#`, not `###`.
5. Symbol references carry no generic arguments and no parameter list.
6. Any fence that is not C# carries an explicit language.
7. `dotnet build` produces no CS1570 for the file.
