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
