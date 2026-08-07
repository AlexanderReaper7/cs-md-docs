import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectDocComment, extractUntagged, RenderOptions } from '../docComment';

/** Render a doc comment the way the hover provider would, from raw `///` lines. */
function render(source: string, options?: RenderOptions): string {
  const lines = source.split('\n');
  const doc = collectDocComment(lines, lines.length - 1);
  assert.ok(doc, 'expected a doc comment above the last line');
  return extractUntagged(doc, options).markdown;
}

/** A `///` block above a declaration, written as the lines between the markers. */
function doc(...lines: string[]): string {
  return [...lines.map((line) => (line === '' ? '///' : `/// ${line}`)), 'void M();'].join('\n');
}

/** Stands in for the editor's symbol resolver, so the pure module stays pure. */
const LINKS: RenderOptions = { symbolLink: (path) => `goto:${path}` };

test('untagged text is rendered', () => {
  assert.equal(
    render(['/// Resolves the feature index through IRoot.', 'void M();'].join('\n')),
    'Resolves the feature index through IRoot.',
  );
});

test('tagged text is left to Roslyn', () => {
  assert.equal(
    render(['/// <summary>Resolves the feature index.</summary>', 'void M();'].join('\n')),
    '',
  );
});

test('a mixed comment yields only the untagged part', () => {
  assert.equal(
    render(
      [
        '/// Cheap, and safe to call on the dispatch path.',
        '/// <summary>Sends one frame.</summary>',
        '/// <param name="frame">The report body.</param>',
        'void Send(Span<byte> frame);',
      ].join('\n'),
    ),
    'Cheap, and safe to call on the dispatch path.',
  );
});

test('a multi-line section swallows every line it spans', () => {
  assert.equal(
    render(
      [
        '/// Before.',
        '/// <summary>',
        '/// Tagged, and Roslyn already shows this.',
        '/// </summary>',
        '/// After.',
        'void M();',
      ].join('\n'),
    ),
    'Before.\n\nAfter.',
  );
});

test('nested sections do not close the outer one early', () => {
  assert.equal(
    render(
      [
        '/// Ours.',
        '/// <remarks>',
        '/// <example><code>var x = 1;</code></example>',
        '/// still theirs',
        '/// </remarks>',
        'void M();',
      ].join('\n'),
    ),
    'Ours.',
  );
});

test('generic syntax survives as literal text', () => {
  // Only the `<` is encoded; see escapeText on why the `>` stays as written.
  assert.equal(
    render(['/// Returns a List<int> of pressed G-keys.', 'void M();'].join('\n')),
    'Returns a List&lt;int> of pressed G-keys.',
  );
});

test('a blockquote is not destroyed by escaping', () => {
  assert.equal(render(doc('> Blocks until the reply arrives.')), '> Blocks until the reply arrives.');
});

test('a bare comparison is not mistaken for a tag', () => {
  assert.equal(
    render(['/// Holds while a < b, then flushes.', 'void M();'].join('\n')),
    'Holds while a &lt; b, then flushes.',
  );
});

test('user Markdown is preserved', () => {
  assert.equal(
    render(
      [
        '/// Two things matter here:',
        '///',
        '/// - the `softwareId` at byte 3',
        '/// - **never** match by arrival order',
        'void M();',
      ].join('\n'),
    ),
    'Two things matter here:\n\n- the `softwareId` at byte 3\n- **never** match by arrival order',
  );
});

test('angle brackets inside a user code span stay literal', () => {
  assert.equal(
    render(['/// Prefer `Span<byte>` over an array.', 'void M();'].join('\n')),
    'Prefer `Span<byte>` over an array.',
  );
});

/**
 * The one spelling that is correct on both sides. Measured against the .NET 10
 * SDK: a raw `<` anywhere in a doc comment, backticks or fence notwithstanding,
 * makes csc emit CS1570 and replace the member's entry in the generated XML file
 * with `<!-- Badly formed XML comment ignored -->`. So an author who wants a doc
 * file has to write `&lt;`. CommonMark, meanwhile, does not resolve entities
 * inside a code span, so leaving it encoded put the literal text `&lt;` in the
 * hover. Decoding here is what lets one source satisfy both.
 */
test('an entity inside a user code span is decoded, not shown', () => {
  assert.equal(
    render(['/// Prefer `Span&lt;byte&gt;` over `T&amp;`.', 'void M();'].join('\n')),
    'Prefer `Span<byte>` over `T&`.',
  );
});

test('inline tags become Markdown', () => {
  assert.equal(
    render(
      [
        '/// Calls <see cref="M:Aktu.Hid.Device.Send"/> with <c>Span&lt;byte&gt;</c>,',
        '/// see <paramref name="frame"/> and <b>never</b> block.',
        'void M();',
      ].join('\n'),
    ),
    'Calls `Aktu.Hid.Device.Send` with `Span<byte>`,\nsee `frame` and **never** block.',
  );
});

test('a bullet list is the default, as it is for every renderer downstream', () => {
  assert.equal(
    render(doc('<list><item>a</item><item>b</item></list>')),
    '- a\n- b',
    'an absent type is bullet',
  );
  assert.equal(
    render(doc('<list type="wat"><item>a</item></list>')),
    '- a',
    'and so is one nothing has heard of',
  );
});

test('an ordered list counts, which is the one thing a tag name cannot carry', () => {
  assert.equal(
    render(doc('<list type="number">', '<item><description>first</description></item>', '<item><description>second</description></item>', '</list>')),
    '1. first\n2. second',
  );
});

test('each list counts from one, the stack being per element', () => {
  assert.equal(
    render(doc('<list type="number"><item>a</item></list>', 'Between.', '<list type="number"><item>b</item></list>')),
    '1. a\n\nBetween.\n\n1. b',
  );
});

test('a nested list is indented to where the parent item content starts', () => {
  assert.equal(
    render(doc('<list type="bullet">', '<item>outer', '<list type="bullet"><item>inner</item></list>', '</item>', '</list>', 'After.')),
    '- outer\n  - inner\n\nAfter.',
    'two spaces under `- `, and the prose after the list is not swallowed by it',
  );
  // The reason `contentIndent` is carried rather than derived from stack depth:
  // `1. ` opens content at column three, so two spaces would put the sublist
  // outside the item and start a sibling list at the top level instead.
  assert.equal(
    render(doc('<list type="number"><item>first<list type="bullet"><item>inner</item></list></item></list>')),
    '1. first\n   - inner',
    'three spaces under `1. `',
  );
  assert.equal(
    render(
      doc(
        '<list type="number">',
        ...Array.from({ length: 10 }, (_, k) => `<item>i${k}</item>`),
        '<item>last<list type="bullet"><item>inner</item></list></item>',
        '</list>',
      ),
    ).split('\n').slice(-2).join('\n'),
    '11. last\n    - inner',
    'and four once the marker is two digits wide',
  );
});

test('a stray item keeps its bullet rather than losing the marker', () => {
  assert.equal(render(doc('<item>orphan</item>')), '- orphan');
});

/**
 * The layout Visual Studio's snippet and every style guide produce, and the one
 * the list handling exists to get right. Two things in it are destructive if the
 * source layout is passed through: the tags' own line endings land between a
 * marker and its content, and the XML indent puts that content five spaces past
 * `1. `, which is one more than CommonMark allows before it becomes an indented
 * code block inside the item. So inside a list, every line ending and every
 * indent comes from the tags and none from the source.
 */
test('the indented multi-line form is a list, not a code block', () => {
  assert.equal(
    render(
      doc(
        'Retry policy, in order of preference:',
        '',
        '<list type="number">',
        '  <item>',
        '    <description>The value on the request.</description>',
        '  </item>',
        '  <item>',
        '    <description>The client default.</description>',
        '  </item>',
        '</list>',
        '',
        'Anything else throws.',
      ),
    ),
    'Retry policy, in order of preference:\n\n1. The value on the request.\n2. The client default.\n\nAnything else throws.',
  );
});

test('a list stays tight however its tags are laid out across lines', () => {
  assert.equal(
    render(doc('<list type="bullet">', '<item>', 'a', '</item>', '<item>', 'b', '</item>', '</list>')),
    '- a\n- b',
  );
  // A blank line inside a list would be read as a new block at the top level,
  // which ends the list rather than spacing it out, so the paragraph break is
  // what gets dropped.
  assert.equal(
    render(doc('<list type="bullet">', '<item>One.', '', 'Still one.</item>', '<item>Two.</item>', '</list>')),
    '- One.\nStill one.\n- Two.',
  );
});

test('a list header is a line, not a row, Markdown having no header for a list', () => {
  assert.equal(
    render(
      doc(
        '<list type="table">',
        '<listheader><term>Name</term><description>What</description></listheader>',
        '<item><term>A</term><description>alpha</description></item>',
        '</list>',
      ),
    ),
    '**Name**: What\n- **A**: alpha',
    'and the tag itself never reaches the reader',
  );
});

test('a code element that names its language is labelled with it', () => {
  assert.equal(
    render(doc('<code language="xml">', '&lt;Project Sdk="Microsoft.NET.Sdk" /&gt;', '</code>'), CSHARP),
    '```xml\n<Project Sdk="Microsoft.NET.Sdk" />\n```',
    'the element wins over the configured default',
  );
  assert.equal(
    render(doc('<code lang="powershell">', 'ls', '</code>'), CSHARP),
    '```powershell\nls\n```',
    'lang is the spelling people write; language is the one the schemas use',
  );
  assert.equal(
    render(doc('<code language="c++ 11">', 'x', '</code>'), CSHARP),
    '```\nx\n```',
    'an unusable label leaves the fence bare rather than falling back to csharp, which would be the wrong grammar rather than none',
  );
});

test('a self-closing section tag emits nothing and is not an open tag', () => {
  assert.equal(
    render(['/// Ours.', '/// <inheritdoc/>', '/// Also ours.', 'void M();'].join('\n')),
    'Ours.\n\nAlso ours.',
  );
});

test('hadSections reports whether Roslyn will render anything', () => {
  assert.equal(extractUntagged(['plain text']).hadSections, false);
  assert.equal(extractUntagged(['<summary>x</summary>']).hadSections, true);
});

test('entities are decoded once', () => {
  assert.equal(
    render(['/// Escaped &lt;tag&gt; and a raw &amp; ampersand.', 'void M();'].join('\n')),
    'Escaped &lt;tag> and a raw &amp; ampersand.',
  );
});

test('four slashes is an ordinary comment, not documentation', () => {
  const lines = ['//// Disabled doc comment.', 'void M();'];
  assert.equal(collectDocComment(lines, 1), null);
});

test('attributes between the comment and the declaration are skipped', () => {
  assert.equal(
    render(['/// Obsolete but documented.', '[Obsolete("use Send")]', 'void M();'].join('\n')),
    'Obsolete but documented.',
  );
});

test('a blank line between the comment and the declaration is tolerated', () => {
  assert.equal(render(['/// Still attached.', '', 'void M();'].join('\n')), 'Still attached.');
});

test('an unrelated comment far above is not picked up', () => {
  const lines = ['/// Too far away.', '', '', '', '', '', '', '', '', '', 'void M();'];
  assert.equal(collectDocComment(lines, lines.length - 1), null);
});

test('the delimited /** */ form is recognised', () => {
  assert.equal(
    render(['/**', ' * Delimited, and untagged.', ' */', 'void M();'].join('\n')),
    'Delimited, and untagged.',
  );
});

test('a code block becomes a fence', () => {
  assert.equal(
    render(['/// Usage:', '/// <code>', '/// dev.Send(frame);', '/// </code>', 'void M();'].join('\n')),
    'Usage:\n\n```\ndev.Send(frame);\n```',
  );
});

test('a member with no comment yields nothing', () => {
  assert.equal(collectDocComment(['void M();'], 0), null);
});

// --- Fenced code blocks, the shape a Rust doc comment is built around ---------

test('a fenced block is verbatim, so generics inside it are not escaped', () => {
  assert.equal(
    render(doc('Usage:', '', '```csharp', 'var pressed = new List<int>();', '```')),
    'Usage:\n\n```csharp\nvar pressed = new List<int>();\n```',
  );
});

test('a doc tag inside a fence is sample code, not a section', () => {
  assert.equal(
    render(doc('How to document it:', '', '```csharp', '/// <summary>Sends.</summary>', '```', '', 'Still ours.')),
    'How to document it:\n\n```csharp\n/// <summary>Sends.</summary>\n```\n\nStill ours.',
  );
});

test('a fence closes only on a longer-or-equal run of its own character', () => {
  assert.equal(
    render(doc('````', 'a ``` inside the block', '````', 'After.')),
    '````\na ``` inside the block\n````\nAfter.',
  );
  assert.equal(render(doc('~~~', 'not closed by backticks', '```', '~~~')), '~~~\nnot closed by backticks\n```\n~~~');
});

test('blank lines inside a fence are content, not padding', () => {
  assert.equal(
    render(doc('```', 'first;', '', '', 'last;', '```')),
    '```\nfirst;\n\n\nlast;\n```',
  );
});

test('an unclosed fence still ends at the last line', () => {
  assert.equal(render(doc('```', 'dev.Send(frame);')), '```\ndev.Send(frame);');
});

test('a fence inside a section belongs to Roslyn', () => {
  assert.equal(
    render(doc('Ours.', '<summary>', '```', 'theirs;', '```', '</summary>', 'Also ours.')),
    'Ours.\n\nAlso ours.',
  );
});

test('an inline code span is not mistaken for a fence', () => {
  assert.equal(render(doc('Prefer `dev.Send` here.')), 'Prefer `dev.Send` here.');
});

// --- The default fence language ----------------------------------------------

const CSHARP: RenderOptions = { defaultCodeLanguage: 'csharp' };

test('an unlabelled fence is labelled, so the hover tokenizes it', () => {
  assert.equal(render(doc('```', 'dev.Send(frame);', '```'), CSHARP), '```csharp\ndev.Send(frame);\n```');
  assert.equal(
    render(['/// <code>', '/// dev.Send(frame);', '/// </code>', 'void M();'].join('\n'), CSHARP),
    '```csharp\ndev.Send(frame);\n```',
  );
});

test('only the opening delimiter is labelled, or the fence would never close', () => {
  // `closes` rejects a delimiter carrying an info string, so a label on the closing
  // one would swallow the rest of the comment.
  assert.equal(
    render(doc('```', 'dev.Send(frame);', '```', '', 'Still ours.'), CSHARP),
    '```csharp\ndev.Send(frame);\n```\n\nStill ours.',
  );
});

test('a fence the author labelled is left as written', () => {
  assert.equal(render(doc('```json', '{ "id": 3 }', '```'), CSHARP), '```json\n{ "id": 3 }\n```');
  assert.equal(render(doc('~~~', 'x', '~~~'), CSHARP), '~~~csharp\nx\n~~~');
});

test('a language id that would break the fence is ignored', () => {
  for (const id of ['', '   ', 'c sharp', 'c`sharp', 'js ~~~', undefined]) {
    assert.equal(
      render(doc('```', 'x', '```'), { defaultCodeLanguage: id }),
      '```\nx\n```',
      `accepted a bad id: ${JSON.stringify(id)}`,
    );
  }
  assert.equal(render(doc('```', 'x', '```'), { defaultCodeLanguage: 'f#' }), '```f#\nx\n```');
});

test('labelling is opt-in, so the default output stays as written', () => {
  assert.equal(render(doc('```', 'x', '```')), '```\nx\n```');
});

// --- Headings ----------------------------------------------------------------

test('headings are demoted so a hover is not dominated by a title', () => {
  assert.equal(
    render(doc('# Examples', '', 'Use it.', '', '## Panics'), { demoteHeadings: 2 }),
    '### Examples\n\nUse it.\n\n#### Panics',
  );
});

test('demotion saturates at six and leaves non-headings alone', () => {
  assert.equal(render(doc('##### Deep'), { demoteHeadings: 3 }), '###### Deep');
  assert.equal(render(doc('#NotAHeading'), { demoteHeadings: 2 }), '#NotAHeading');
  assert.equal(render(doc('# Examples')), '# Examples');
});

test('a hash inside a fence is code, not a heading', () => {
  assert.equal(
    render(doc('```', '#region Send', '```'), { demoteHeadings: 2 }),
    '```\n#region Send\n```',
  );
});

// --- Intra-doc links ---------------------------------------------------------

test('a qualified shortcut link resolves to a symbol', () => {
  assert.equal(
    render(doc('Pairs with [Device.Send].'), LINKS),
    'Pairs with [Device.Send](goto:Device.Send).',
  );
});

test('the backticked rustdoc idiom keeps its code span', () => {
  assert.equal(render(doc('See [`Device.Send`] for the wire format.'), LINKS), 'See [`Device.Send`](goto:Device.Send) for the wire format.');
});

test('a bare backticked name is deliberate enough to resolve', () => {
  assert.equal(render(doc('Call [`Send`] first.'), LINKS), 'Call [`Send`](goto:Send) first.');
});

test('rust path separators are accepted and normalized', () => {
  assert.equal(render(doc('See [`Device::Send`].'), LINKS), 'See [`Device::Send`](goto:Device.Send).');
});

test('an inline link whose destination is a path resolves too', () => {
  assert.equal(
    render(doc('Hand it to [the sender](Device.Send).'), LINKS),
    'Hand it to [the sender](goto:Device.Send).',
  );
});

test('generic arguments and parameter lists are stripped from the query only', () => {
  assert.equal(
    render(doc('Returns [`Buffer<int>`] via [`Send(Span<byte>)`].'), LINKS),
    'Returns [`Buffer<int>`](goto:Buffer) via [`Send(Span<byte>)`](goto:Send).',
  );
});

test('ordinary Markdown brackets are left alone', () => {
  const cases = [
    'A [note] in passing.',
    'A [^1] footnote marker.',
    'See [the docs](https://example.com/x).',
    'See [the docs][d].',
    '[d]: https://example.com/x',
    'Read [readme](readme.md).',
    'A [ ] unchecked box.',
  ];
  for (const line of cases) {
    assert.equal(render(doc(line), LINKS), line, `mangled: ${line}`);
  }
});

test('without a resolver a reference degrades to a code span', () => {
  assert.equal(render(doc('Pairs with [Device.Send].')), 'Pairs with `Device.Send`.');
});

test('a reference inside a fence or a code span is not a link', () => {
  assert.equal(render(doc('```', 'see [Device.Send]', '```'), LINKS), '```\nsee [Device.Send]\n```');
  assert.equal(render(doc('Literally <c>[Device.Send]</c>.'), LINKS), 'Literally `[Device.Send]`.');
});

test('a cref is a reference too, and resolves down the same path', () => {
  assert.equal(
    render(doc('Calls <see cref="M:Device.Send"/> on the way out.'), LINKS),
    'Calls [`Device.Send`](goto:Device.Send) on the way out.',
  );
});

test('a cref keeps its signature in the label and drops it from the query', () => {
  assert.equal(
    render(doc('See <see cref="M:Device.Send(System.Span{System.Byte})"/>.'), LINKS),
    'See [`Device.Send(System.Span{System.Byte})`](goto:Device.Send).',
  );
});

test('a cref with inner text gives the link a label of its own', () => {
  assert.equal(
    render(doc('Hand it to <see cref="M:Device.Send">the sender</see>.'), LINKS),
    'Hand it to [the sender](goto:Device.Send).',
  );
  // And the label is prose, so a generic in it still survives the renderer.
  assert.equal(
    render(doc('Use <see cref="T:Buffer">a Buffer<int></see>.'), LINKS),
    'Use [a Buffer&lt;int>](goto:Buffer).',
  );
});

test('without a resolver a cref degrades to a code span, as it always did', () => {
  assert.equal(render(doc('Calls <see cref="M:Device.Send"/>.')), 'Calls `Device.Send`.');
  assert.equal(render(doc('Calls <see cref="M:Device.Send">it</see>.')), 'Calls `it`.');
});

test('a langword is a keyword, not a symbol, so it never becomes a link', () => {
  assert.equal(render(doc('Returns <see langword="null"/> on timeout.'), LINKS), 'Returns `null` on timeout.');
});

test('a reference inside a section stays with Roslyn', () => {
  assert.equal(render(doc('<summary>Pairs with [Device.Send].</summary>'), LINKS), '');
});

// --- Other Markdown a rustdoc author reaches for -----------------------------

test('br emits a hard break that survives trailing-whitespace trimming', () => {
  assert.equal(render(doc('one<br/>two')), 'one\\\ntwo');
});

test('tables, quotes, nested lists and strikethrough pass through unmangled', () => {
  const block = [
    '| byte | meaning |',
    '|---|---|',
    '| 3 | `softwareId` |',
    '',
    '> Blocks until the reply arrives.',
    '',
    '1. open the device',
    '   - check `a < b`',
    '2. ~~poll~~ await it',
  ];
  // Identical output: the only angle bracket sits inside a code span, and the
  // pipe, quote and list markers are never touched.
  assert.equal(render(doc(...block)), block.join('\n'));
});

// --- Hover decoration --------------------------------------------------------

const STYLED: RenderOptions = { hoverStyling: true };

/** The bar as the sanitizer must see it: no space after the colon, semicolon present. */
const BAR = '<span style="color:var(--vscode-textBlockQuote-border);">▌</span>&nbsp;';

test('a prose quote trades its marker for the bar, once per paragraph', () => {
  // The `>` goes because nothing depends on it: there is no `.monaco-hover
  // blockquote` rule, so the element would only contribute the browser's 40px
  // margin on each side. One bar per paragraph, not per line.
  assert.equal(
    render(doc('> Blocks until the reply arrives,', '> which can take a frame.', '>', '> Then returns.'), STYLED),
    `${BAR}Blocks until the reply arrives,\nwhich can take a frame.\n\n${BAR}Then returns.`,
  );
});

/**
 * What the batch of judgment calls above could break. A bar in front of anything
 * that opens a block stops the renderer recognising it, so `▌ - item` is not a
 * decorated list, it is a destroyed one. The bar is matched whole, because the
 * `&nbsp;` alone also appears as table-cell padding.
 */
const BAR_THEN_BLOCK = /<\/span>&nbsp;(?:[-*+>#|]|\d+[.)]|`{3}|~{3}| {4})/;

test('a quote keeps its marker when the marker is what groups the content', () => {
  const grouping = [
    ['> Two of them:', '>', '> - the softwareId', '> - the sequence number'],
    ['> Usage:', '>', '> ```csharp', '> dev.Send(frame);', '> ```'],
    ['> # Wire format', '>', '> Six bytes.'],
    ['> | byte | meaning |', '> |---|---|', '> | 3 | id |'],
    ['> Quoting the spec:', '>', '>> Never match by arrival order.'],
    ['> Verbatim:', '>', '>     dev.Send(frame);'],
  ];
  for (const block of grouping) {
    const rendered = render(doc(...block), STYLED);
    for (const line of rendered.split('\n')) {
      assert.match(line, /^>/, `marker dropped from a grouping quote: ${block[0]}`);
    }
    // Every source line survives with its marker and its own first character intact.
    for (const line of block) {
      assert.ok(
        rendered.split('\n').some((out) => out.replace(/<span[^>]*>▌<\/span>&nbsp;/, '') === line),
        `construct mangled in ${block[0]}: ${line}\ngot:\n${rendered}`,
      );
    }
  }
});

test('the bar never lands in front of something that opens a block', () => {
  const blocks = [
    ['> Two of them:', '>', '> - the softwareId'],
    ['> | byte | meaning |', '> |---|---|', '> | 3 | id |'],
    ['> ```', '> dev.Send(frame);', '> ```'],
    ['> 1. open it', '> 2. send'],
    ['> # Heading'],
    ['>     indented code'],
    ['> Prose.', '>', '> ---'],
  ];
  for (const block of blocks) {
    assert.doesNotMatch(render(doc(...block), STYLED), BAR_THEN_BLOCK, `in ${block[0]}`);
  }
});

/**
 * The alert is drawn here because nothing downstream will draw it: the parser is
 * behind `MarkdownString.supportAlertSyntax`, proposed API a published extension
 * cannot ask for, and the `border-left` that would consume `data-severity` is
 * scoped to chat and comment threads. Measured against 1.132.0.
 */
const ALERTS: readonly [name: string, icon: string, label: string][] = [
  ['NOTE', 'info', 'Note'],
  ['TIP', 'light-bulb', 'Tip'],
  ['IMPORTANT', 'comment', 'Important'],
  ['WARNING', 'alert', 'Warning'],
  ['CAUTION', 'stop', 'Caution'],
];

/** The bar and the title as the sanitizer must see them, for one alert kind. */
function alert(name: string, icon: string, label: string): { bar: string; title: string } {
  const color = `var(--vscode-markdownAlert-${name.toLowerCase()}-foreground)`;
  return {
    bar: `<span style="color:${color};">▌</span>&nbsp;`,
    title: `<span style="color:${color};"><span class="codicon codicon-${icon}"></span> **${label}**</span>`,
  };
}

test('every alert VS Code knows gets its icon, its name and its own colour', () => {
  for (const [name, icon, label] of ALERTS) {
    const { bar, title } = alert(name, icon, label);
    assert.equal(
      render(doc(`> [!${name}]`, '> Matched by softwareId.'), STYLED),
      `${bar}${title}<br>\nMatched by softwareId.`,
      `alert ${name}`,
    );
  }
});

test('the alert name is matched case-insensitively, and the label is normalised', () => {
  const { bar, title } = alert('TIP', 'light-bulb', 'Tip');
  assert.equal(render(doc('> [!tip]', '> Use a fence.'), STYLED), `${bar}${title}<br>\nUse a fence.`);
});

test('a second paragraph of an alert gets a bar in the alert colour, not the quote colour', () => {
  const { bar, title } = alert('WARNING', 'alert', 'Warning');
  assert.equal(
    render(doc('> [!WARNING]', '> First.', '>', '> Second.'), STYLED),
    `${bar}${title}<br>\nFirst.\n\n${bar}Second.`,
  );
});

test('the break is only there when a body line runs on into the title', () => {
  const { bar, title } = alert('NOTE', 'info', 'Note');
  // Nothing to separate: a title alone, and a title followed by a blank quoted
  // line, are each their own paragraph already.
  assert.equal(render(doc('> [!NOTE]'), STYLED), `${bar}${title}`);
  assert.equal(render(doc('> [!NOTE]', '>', '> Matched by softwareId.'), STYLED), `${bar}${title}\n\n${bar}Matched by softwareId.`);
});

test('text written after the marker stays on the title line', () => {
  const { bar, title } = alert('IMPORTANT', 'comment', 'Important');
  assert.equal(render(doc('> [!IMPORTANT] read this first'), STYLED), `${bar}${title} read this first`);
});

test('an alert whose body needs grouping keeps its markers and its title', () => {
  const { bar, title } = alert('CAUTION', 'stop', 'Caution');
  assert.equal(
    render(doc('> [!CAUTION]', '>', '> - never by arrival order', '> - never by length'), STYLED),
    `> ${bar}${title}\n>\n> - never by arrival order\n> - never by length`,
  );
});

test('a name no renderer knows is prose, not an alert', () => {
  // `[!TODO]` draws no alert anywhere downstream, so drawing a title for it here
  // would invent a construct. It is quoted text, and gets the quote's own bar.
  assert.equal(render(doc('> [!TODO]', '> Wire the retry.'), STYLED), `${BAR}[!TODO]\nWire the retry.`);
});

test('a marker below the first line is prose, where VS Code would not look for one', () => {
  assert.equal(
    render(doc('> Two kinds:', '> [!NOTE] not a title here'), STYLED),
    `${BAR}Two kinds:\n[!NOTE] not a title here`,
  );
});

test('a nested quote is not an alert, its first paragraph being one level down', () => {
  // Prose, so it keeps the marker that holds the nesting and takes the ordinary
  // quote bar. The marker text is left where the author wrote it.
  assert.equal(
    render(doc('>> [!NOTE]', '>> Matched by softwareId.'), STYLED),
    `>> ${BAR}[!NOTE]\n>> Matched by softwareId.`,
  );
});

test('hoverStyling off leaves an alert as portable Markdown', () => {
  assert.equal(
    render(doc('> [!NOTE]', '> Matched by softwareId.')),
    '> [!NOTE]\n> Matched by softwareId.',
  );
});

test('an alert title never lands in front of something that opens a block', () => {
  for (const [name] of ALERTS) {
    assert.doesNotMatch(
      render(doc(`> [!${name}]`, '>', '> - a list', '> - of two'), STYLED),
      BAR_THEN_BLOCK,
      `in ${name}`,
    );
  }
});

test('two quotes are decided independently', () => {
  assert.equal(
    render(doc('> Plain prose.', '', '> Not plain:', '>', '> - a list'), STYLED),
    `${BAR}Plain prose.\n\n> ${BAR}Not plain:\n>\n> - a list`,
    'a list in the second quote must not decide the first',
  );
});

test('a quote or table inside a fence is sample text, not something to decorate', () => {
  assert.equal(
    render(doc('```md', '> quoted', '| a | b |', '|---|---|', '```'), STYLED),
    '```md\n> quoted\n| a | b |\n|---|---|\n```',
  );
});

test('table cells are padded, and the delimiter row is left to measure the columns', () => {
  assert.equal(
    render(doc('| byte | meaning |', '|---|---|', '| 3 | `softwareId` |'), STYLED),
    '|&nbsp;byte&nbsp;|&nbsp;meaning&nbsp;|\n|---|---|\n|&nbsp;3&nbsp;|&nbsp;`softwareId`&nbsp;|',
  );
});

test('a table written without outer pipes is padded the same way', () => {
  assert.equal(
    render(doc('byte | meaning', '--- | ---', '3 | id'), STYLED),
    '&nbsp;byte&nbsp;|&nbsp;meaning&nbsp;\n--- | ---\n&nbsp;3&nbsp;|&nbsp;id&nbsp;',
  );
});

test('an escaped pipe is content, not a cell boundary', () => {
  assert.equal(
    render(doc('| op | means |', '|---|---|', String.raw`| \| | bitwise or |`), STYLED),
    `|&nbsp;op&nbsp;|&nbsp;means&nbsp;|\n|---|---|\n|&nbsp;${String.raw`\|`}&nbsp;|&nbsp;bitwise or&nbsp;|`,
  );
});

test('prose containing a pipe is not a table', () => {
  assert.equal(render(doc('Use a | b, never a || b.'), STYLED), 'Use a | b, never a || b.');
});

test('decoration is opt-in, so the default output stays portable Markdown', () => {
  const block = doc('> Quoted.', '', '| a | b |', '|---|---|', '| 1 | 2 |');
  assert.equal(render(block), '> Quoted.\n\n| a | b |\n|---|---|\n| 1 | 2 |');
});

/**
 * The invariant `supportHtml` rests on. Every `<` from the source file is escaped
 * or lands in a code span, so the only live tag in a hover is one we wrote. If
 * this ever fails, `extension.ts` is handing VS Code attacker-authored HTML.
 */
test('a doc comment cannot smuggle markup of its own past the decorator', () => {
  const hostile = [
    '<span style="color:red;">tinted</span>',
    '<img src="x" onerror="steal()">',
    '<div><input checked/></div>',
    '<SPAN Style="color:red;">case is not a defence</SPAN>',
  ];
  for (const line of hostile) {
    assert.match(render(doc(line), STYLED), /^[^<]*$/, `raw markup survived: ${line}`);
  }
  // Inside a quote, where we do emit a tag, ours is the only one.
  const quoted = render(doc('> <span style="color:red;">x</span>'), STYLED);
  assert.equal(quoted.match(/<span/g)?.length, 1);
  assert.ok(quoted.includes('&lt;span style="color:red;">x&lt;/span>'), quoted);
});
