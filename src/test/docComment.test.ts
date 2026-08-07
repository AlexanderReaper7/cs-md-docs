import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectDocComment, extractUntagged } from '../docComment';

/** Render a doc comment the way the hover provider would, from raw `///` lines. */
function render(source: string): string {
  const lines = source.split('\n');
  const doc = collectDocComment(lines, lines.length - 1);
  assert.ok(doc, 'expected a doc comment above the last line');
  return extractUntagged(doc).markdown;
}

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
  assert.equal(
    render(['/// Returns a List<int> of pressed G-keys.', 'void M();'].join('\n')),
    'Returns a List&lt;int&gt; of pressed G-keys.',
  );
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
    'Escaped &lt;tag&gt; and a raw &amp; ampersand.',
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
