/**
 * Pure text handling for C# documentation comments. Deliberately free of any
 * `vscode` import so it can be exercised by `node --test`.
 *
 * The job: given the `///` block above a declaration, return only the text that
 * is NOT inside an XML section element. Roslyn's quick info renders the section
 * elements and drops everything else, so this is exactly the complement of what
 * the C# extension already puts in the hover. Nothing is shown twice.
 */

/**
 * Elements Roslyn treats as a documentation section. Their content belongs to
 * the C# extension's hover, so we consume the tags and discard what is between
 * them.
 */
const SECTION_TAGS: ReadonlySet<string> = new Set([
  'summary',
  'remarks',
  'returns',
  'value',
  'param',
  'typeparam',
  'exception',
  'example',
  'permission',
  'completionlist',
  'inheritdoc',
  'include',
  'seealso',
  'altmember',
  'threadsafety',
]);

/**
 * Formatting elements that carry no section of their own. Inside a section they
 * are Roslyn's problem; outside one they are ours, and we turn them into the
 * Markdown equivalent.
 */
const INLINE_TAGS: ReadonlySet<string> = new Set([
  'c',
  'tt',
  'code',
  'see',
  'paramref',
  'typeparamref',
  'para',
  'br',
  'b',
  'strong',
  'i',
  'em',
  'u',
  'a',
  'list',
  'listheader',
  'item',
  'term',
  'description',
]);

/**
 * A tag, as it appears in a doc comment. Attributes are kept raw and read on
 * demand; there are at most two per tag in practice.
 */
const TAG =
  /^<(\/?)([A-Za-z][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/;

/** `///` starts a doc comment, `////` is an ordinary comment the compiler ignores. */
const DOC_LINE = /^\s*\/\/\/(?!\/)[ \t]?(.*)$/;

/** An ATX heading, per CommonMark: up to three spaces, 1-6 hashes, then space or end of line. */
const HEADING = /^( {0,3})(#{1,6})(\s.*|)$/;

/**
 * A dotted identifier path. `::` is accepted because it is what someone arriving
 * from Rust will type, and it is not otherwise legal in a member reference.
 */
const SYMBOL_PATH = /^[A-Za-z_]\w*(?:(?:\.|::)[A-Za-z_]\w*)*$/;

const ATTRIBUTE_LINE = /^\s*\[[^\]]*\]\s*$/;
const PREPROCESSOR_LINE = /^\s*#/;

/**
 * A language id we are willing to write into a fence. `csharp`, `c#` and `f#` all
 * pass; anything with a backtick, a tilde or a space would close the fence it was
 * meant to label, or split into an info string plus arguments. Checked here rather
 * than at the caller so no setting value can make this module emit a broken fence.
 */
const LANGUAGE_ID = /^[\w+#-]+$/;

/** How far above a declaration we will look past attributes and blank lines. */
const MAX_SKIPPED_LINES = 8;

export interface ExtractResult {
  /** Markdown ready for a `MarkdownString`. Empty when there was nothing untagged. */
  markdown: string;
  /** True when at least one XML section element was present, i.e. Roslyn will render something too. */
  hadSections: boolean;
}

export interface RenderOptions {
  /**
   * Levels to push every ATX heading down by, capped at `######`. Rust puts
   * `# Examples` at the top level, which in a hover popup is a title twice the
   * size of the signature underneath it. Zero renders headings as written.
   */
  demoteHeadings?: number;
  /**
   * Turns a symbol path from an intra-doc link into a URL. Returning undefined,
   * or leaving this out, renders the reference as a plain code span instead, so
   * the module stays usable with no editor attached.
   */
  symbolLink?: (path: string) => string | undefined;
  /**
   * Info string for a fence that was opened without one, so it is tokenized
   * instead of arriving grey. Empty or absent leaves a bare fence bare.
   *
   * rust-analyzer sets no such default: it writes ```` ```rust ```` explicitly on
   * every block it generates and passes an author's fence through untouched, so a
   * bare fence in a rustdoc comment is unhighlighted there too, even though
   * rustdoc's own convention is that a bare fence is Rust. The language of the
   * file is a better guess than nothing, and the setting turns it off.
   */
  defaultCodeLanguage?: string;
  /**
   * Decorate the output with the sliver of inline markup a VS Code hover both
   * renders and styles. Off by default, because the result is no longer portable
   * Markdown: it is Markdown aimed at one renderer.
   *
   * The hover stylesheet has rules for `p`, `ul`, `ol`, `li`, `h1`-`h6`, `code`
   * and `hr`, and for nothing else, so a blockquote arrives with the browser's
   * 40px indent and no bar, and a table with neither rules nor cell padding.
   * Extensions cannot add CSS to a hover, and the sanitizer's allow-list permits
   * only `color`, `background-color` and `border-radius`, and only on a `span`.
   * A coloured bar glyph and entity padding are therefore the whole repertoire.
   */
  hoverStyling?: boolean;
}

/**
 * Collect the doc comment attached to the declaration on `declLine`, stripped of
 * its `///` markers. Returns null when the declaration carries no doc comment.
 *
 * Attributes and blank lines are skipped on the way up, because
 * `/// doc` `[Obsolete]` `public void M()` is legal and common.
 */
export function collectDocComment(
  lines: readonly string[],
  declLine: number,
): string[] | null {
  let i = declLine - 1;
  let skipped = 0;
  while (i >= 0 && skipped < MAX_SKIPPED_LINES) {
    const line = lines[i];
    const isSkippable =
      line.trim() === '' ||
      ATTRIBUTE_LINE.test(line) ||
      PREPROCESSOR_LINE.test(line);
    if (!isSkippable) {
      break;
    }
    i--;
    skipped++;
  }

  const slashed: string[] = [];
  let j = i;
  while (j >= 0) {
    const m = DOC_LINE.exec(lines[j]);
    if (!m) {
      break;
    }
    slashed.unshift(m[1]);
    j--;
  }
  if (slashed.length > 0) {
    return slashed;
  }

  return collectDelimitedDocComment(lines, i);
}

/** The `/** ... *\/` form. Rare, but it is a documentation comment too. */
function collectDelimitedDocComment(
  lines: readonly string[],
  endLine: number,
): string[] | null {
  if (endLine < 0 || !lines[endLine].trimEnd().endsWith('*/')) {
    return null;
  }
  let start = endLine;
  while (start >= 0 && !lines[start].includes('/**')) {
    start--;
  }
  if (start < 0) {
    return null;
  }
  // `/***` and up are ordinary block comments, not documentation.
  if (/\/\*\*\*/.test(lines[start])) {
    return null;
  }

  const raw = lines.slice(start, endLine + 1).join('\n');
  const inner = raw.slice(raw.indexOf('/**') + 3, raw.lastIndexOf('*/'));
  return inner.split('\n').map((line) => line.replace(/^\s*\*[ \t]?/, ''));
}

interface Tag {
  name: string;
  isClose: boolean;
  isSelfClosing: boolean;
  attrs: string;
}

interface ScanState {
  /** Inside a fenced block opened by `<code>`. */
  inCodeFence: boolean;
  /** The open Markdown fence the user wrote themselves, or null. */
  mdFence: Fence | null;
  /** Inside a Markdown code span opened by `<c>` or an inner-text `<see>`. */
  inCodeSpan: boolean;
  /** Per open `<see>`/`<a>`: the href to close a Markdown link with, or null for a code span. */
  linkStack: (string | null)[];
  /** Per open `<list>`, outermost first. Empty when no list is open. */
  lists: OpenList[];
}

/**
 * An open `<list>`. Both indents are carried rather than derived from the stack
 * depth, because CommonMark measures a sublist against where the parent item's
 * *content* starts, not against a fixed step: `1. ` opens content at column 3 and
 * `- ` at column 2, so a flat two spaces would fall outside an ordered item and
 * silently start a sibling list at the top level instead of nesting.
 */
interface OpenList {
  /** The next number to write, or null for a bullet list. */
  ordinal: number | null;
  /** Indent for this list's own markers. */
  indent: string;
  /** Indent for anything nested under the item currently open, marker width included. */
  contentIndent: string;
}

/** An open fenced code block: which character opened it, and how many of them. */
interface Fence {
  char: string;
  length: number;
}

/** What the tag handlers are allowed to do to the output buffer. */
interface Emitter {
  /** Append Markdown verbatim. Counts as content, so the line keeps its ending. */
  raw(text: string): void;
  /**
   * Append a list marker. Same as `raw` but leaves the line structural, so
   * `<item>` alone on a line does not have its own line ending inserted between
   * the marker and the content beneath it.
   */
  marker(text: string): void;
  /** Start a new line unless the buffer is already at one. */
  newline(): void;
  /** Leave exactly one blank line, so a block element is not glued to a paragraph. */
  blankLine(): void;
}

/**
 * Scan a stripped doc comment and return the Markdown for everything that sits
 * outside a section element.
 *
 * This is a hand-rolled scanner rather than an XML parse on purpose. The text we
 * care about is precisely the text that is not XML, and it routinely contains
 * `a < b` or `List<int>`, which any conforming parser rejects outright. The
 * compiler agrees with the parser and drops the whole comment (CS1570); we do
 * not have that luxury, because that malformed comment is the payload.
 */
export function extractUntagged(
  docLines: readonly string[],
  options: RenderOptions = {},
): ExtractResult {
  /** Depth of open section elements. Text is only ours at depth 0. */
  let depth = 0;
  let hadSections = false;
  const state: ScanState = {
    inCodeFence: false,
    mdFence: null,
    inCodeSpan: false,
    linkStack: [],
    lists: [],
  };
  const demote = options.demoteHeadings ?? 0;
  const language = fenceLanguage(options.defaultCodeLanguage);
  let buf = '';

  /**
   * Whether this line has so far carried nothing but list structure. Such a line
   * has already had its whole effect on the buffer, and its own line ending would
   * land between an `<item>` marker and the content on the line beneath it. Only
   * consulted inside a list, so nothing outside one changes shape.
   */
  let structural = true;

  const emitter: Emitter = {
    raw(text) {
      if (depth === 0 && text) {
        buf += text;
        structural = false;
      }
    },
    marker(text) {
      if (depth === 0) {
        buf += text;
      }
    },
    newline() {
      if (depth === 0 && buf !== '' && !buf.endsWith('\n')) {
        buf += '\n';
      }
    },
    blankLine() {
      if (depth !== 0 || buf === '') {
        return;
      }
      this.newline();
      if (!buf.endsWith('\n\n')) {
        buf += '\n';
      }
    },
  };

  /** Prose. Escaped so stray angle brackets survive a Markdown renderer. */
  const emitText = (text: string): void => {
    if (depth !== 0 || !text) {
      return;
    }
    if (text.trim() !== '') {
      structural = false;
    }
    // A code span shows entities literally, so text bound for one is only decoded.
    buf += state.inCodeSpan ? decodeEntities(text) : escapeText(text);
  };

  for (const raw of docLines) {
    structural = true;
    // A fence the user opened is opaque: no tag lives inside it, nothing in it
    // is escaped, and no heading is rewritten. This is checked per line rather
    // than per character because CommonMark only recognises a fence delimiter at
    // the start of one. Only tracked at depth 0; inside a section the content is
    // discarded anyway, and a stray ``` there must not hide the closing tag.
    if (depth === 0 && !state.inCodeFence) {
      const fence = matchFence(raw);
      if (state.mdFence) {
        if (fence && closes(state.mdFence, fence)) {
          state.mdFence = null;
        }
        buf += decodeEntities(raw) + '\n';
        continue;
      }
      if (fence) {
        state.mdFence = { char: fence.char, length: fence.length };
        // Only the opening delimiter is labelled. A closing one is reached through
        // the branch above, and `closes` rejects a delimiter carrying an info
        // string, so labelling both would leave the fence permanently open.
        buf += (fence.info === '' ? raw.trimEnd() + language : raw) + '\n';
        continue;
      }
    }

    const demoted = depth === 0 && demote > 0 ? demoteHeading(raw, demote) : raw;
    // Inside a list the leading whitespace is XML pretty-printing, and passing it
    // through is destructive twice over: five spaces after `1. ` puts the item's
    // content past the four that make it an indented code block, and an `<item>`
    // written on its own indented line leaves a whitespace-only line between two
    // items. The indentation that matters comes from the list stack instead.
    const line =
      depth === 0 && state.lists.length > 0 ? demoted.replace(/^[ \t]+/, '') : demoted;
    let i = 0;
    while (i < line.length) {
      if (state.inCodeFence) {
        const end = line.indexOf('</code>', i);
        const content = end < 0 ? line.slice(i) : line.slice(i, end);
        if (content) {
          emitter.newline();
          emitter.raw(decodeEntities(content));
        }
        if (end < 0) {
          i = line.length;
          break;
        }
        emitter.newline();
        emitter.raw('```');
        state.inCodeFence = false;
        i = end + '</code>'.length;
        continue;
      }

      const lt = line.indexOf('<', i);
      const tick = line.indexOf('`', i);
      const bracket = state.inCodeSpan ? -1 : line.indexOf('[', i);

      // An intra-doc link, the way rustdoc spells a symbol reference. Tested
      // before the code span below, because the idiomatic form [`Device.Send`]
      // opens with the bracket and the backtick belongs to the label.
      if (bracket >= 0 && (tick < 0 || bracket < tick) && (lt < 0 || bracket < lt)) {
        emitText(line.slice(i, bracket));
        const link = matchSymbolLink(line, bracket);
        if (link) {
          emitter.raw(renderSymbolLink(link, options.symbolLink));
          i = link.end;
        } else {
          emitText('[');
          i = bracket + 1;
        }
        continue;
      }

      // A Markdown code span the user wrote themselves is opaque: no tag lives
      // inside it, and nothing in it may be escaped. Consume it whole, before
      // the tag scanner ever sees the angle brackets it contains.
      if (tick >= 0 && (lt < 0 || tick < lt)) {
        emitText(line.slice(i, tick));
        const span = matchCodeSpan(line, tick);
        if (span) {
          // Decoded, like every other opaque region: CommonMark does not resolve
          // an entity inside a code span, so `&lt;` written here would reach the
          // reader as the five characters `&lt;`. And it has to be written here,
          // because a raw `<` makes csc drop the entire member from the generated
          // XML file, not merely warn. This is the one spelling that is correct in
          // both places.
          emitter.raw(decodeEntities(span.text));
          i = span.end;
        } else {
          emitText('`');
          i = tick + 1;
        }
        continue;
      }

      if (lt < 0) {
        emitText(line.slice(i));
        break;
      }
      emitText(line.slice(i, lt));

      const m = TAG.exec(line.slice(lt));
      const name = m ? m[2].toLowerCase() : '';
      const known = m !== null && (SECTION_TAGS.has(name) || INLINE_TAGS.has(name));
      if (!known) {
        // Not a documentation tag, so it is the user's `<` and stays literal.
        emitText('<');
        i = lt + 1;
        continue;
      }

      const tag: Tag = {
        name,
        isClose: m![1] === '/',
        isSelfClosing: m![4] === '/',
        attrs: m![3],
      };

      if (SECTION_TAGS.has(name)) {
        hadSections = true;
        // A section boundary is not list structure: `</summary>` on a line of its
        // own still separates the prose above from the prose below.
        structural = false;
        if (!tag.isSelfClosing) {
          depth = tag.isClose ? Math.max(0, depth - 1) : depth + 1;
        }
      } else if (depth === 0) {
        applyInlineTag(tag, emitter, state, options, language);
      }
      i = lt + m![0].length;
    }

    // A blank line counts as structural, so it is dropped inside a list too. It
    // costs a multi-paragraph item its paragraph break, and it buys the list not
    // being torn in half: an author's blank line makes CommonMark read everything
    // after it as a new block at the top level, which ends the list rather than
    // spacing it out. Losing a break is smaller than losing the list.
    if (depth === 0 && !(structural && state.lists.length > 0)) {
      buf += '\n';
    }
  }

  const markdown = normalize(buf);
  return {
    markdown: options.hoverStyling ? decorate(markdown) : markdown,
    hadSections,
  };
}

/** Translate one inline element into Markdown, updating the scanner's state. */
function applyInlineTag(
  tag: Tag,
  out: Emitter,
  state: ScanState,
  options: RenderOptions,
  language: string,
): void {
  const { name, isClose, isSelfClosing, attrs } = tag;
  switch (name) {
    case 'c':
    case 'tt':
      out.raw('`');
      state.inCodeSpan = !isClose;
      return;

    case 'code': {
      if (isSelfClosing) {
        return;
      }
      out.blankLine();
      // An element that names its own language wins over the configured default.
      // `language` is the spelling Sandcastle and DocFX use, `lang` the one people
      // write; both go through `fenceLanguage`, so no attribute value can emit a
      // backtick or a space into an info string and leave the fence unclosable.
      // An attribute present but unusable yields a bare fence rather than the
      // default, since an author who labelled the block said it is *not* C#, and
      // grey is a smaller lie than the wrong grammar.
      const written = attr(attrs, 'language') ?? attr(attrs, 'lang');
      const info = written !== undefined ? fenceLanguage(written) : language;
      out.raw(isClose ? '```' : '```' + info);
      state.inCodeFence = !isClose;
      return;
    }

    case 'see':
    case 'a': {
      const href = attr(attrs, 'href');
      const cref = attr(attrs, 'cref');
      if (isSelfClosing) {
        const langword = attr(attrs, 'langword');
        if (href !== undefined) {
          out.raw(`[${href}](${href})`);
        } else if (cref !== undefined) {
          // The XML spelling of what `[`Device.Send`]` spells, so it resolves down
          // the same path. Roslyn makes a cref clickable; leaving ours a dead code
          // span made the two spellings of one idea behave differently.
          const written = stripCrefPrefix(cref);
          out.raw(renderSymbolLink({ label: `\`${written}\``, path: normalizePath(written) }, options.symbolLink));
        } else if (langword !== undefined) {
          out.raw(`\`${langword}\``);
        }
        return;
      }
      if (isClose) {
        const pending = state.linkStack.pop();
        out.raw(pending ? `](${pending})` : '`');
        state.inCodeSpan = false;
        return;
      }
      // `<see cref="X">the sender</see>` gives the link a label of its own, so the
      // inner text is prose to be escaped rather than a code span.
      const url =
        href ?? (cref !== undefined ? options.symbolLink?.(normalizePath(stripCrefPrefix(cref))) : undefined);
      if (url !== undefined) {
        state.linkStack.push(url);
        out.raw('[');
      } else {
        state.linkStack.push(null);
        out.raw('`');
        state.inCodeSpan = true;
      }
      return;
    }

    case 'paramref':
    case 'typeparamref': {
      const named = attr(attrs, 'name');
      if (named !== undefined) {
        out.raw(`\`${named}\``);
      }
      return;
    }

    case 'para':
      if (isClose) {
        out.newline();
      } else {
        out.blankLine();
      }
      return;

    case 'br':
      // A backslash, not the two trailing spaces the other CommonMark hard break
      // uses: `normalize` trims every line end, so the spaces version emitted a
      // soft break that renders as a space and lost the line break entirely.
      out.raw('\\\n');
      return;

    case 'b':
    case 'strong':
      out.raw('**');
      return;

    case 'i':
    case 'em':
      out.raw('*');
      return;

    case 'list':
      if (isSelfClosing) {
        return;
      }
      // The blank line goes around the outermost list and nowhere inside it. On
      // the close it is load-bearing rather than cosmetic: without it the prose
      // after `</list>` is a lazy continuation of the last item and disappears
      // into the bullet. Inside, a blank line would only make the list loose.
      if (isClose) {
        state.lists.pop();
        if (state.lists.length === 0) {
          out.blankLine();
        }
        return;
      }
      if (state.lists.length === 0) {
        out.blankLine();
      }
      openList(state, attr(attrs, 'type'));
      return;

    case 'listheader':
      // The header of a `type="table"` list. Markdown has no header row for a
      // bullet list, so it becomes an unmarked line above the items: `<term>`
      // already bolds it, which is the whole of what a header row conveys here.
      // A real table was rejected because a `<list>` is not required to be one,
      // and a bulleted list turned into a two-column table is a worse lie than a
      // header that is merely a line.
      if (!isClose) {
        out.newline();
        out.marker(state.lists[state.lists.length - 1]?.indent ?? '');
      }
      return;

    case 'item': {
      if (isClose) {
        return;
      }
      // A stray `<item>` with no `<list>` around it is malformed, and the author
      // plainly meant a bullet. It gets one, unindented, rather than losing its
      // marker: the list stack is a rendering aid, not a validator.
      const list = state.lists[state.lists.length - 1];
      const indent = list?.indent ?? '';
      // `type` is consulted here and nowhere else, on the marker itself: an
      // ordered list has to count, and counting is the one thing a tag name
      // cannot carry.
      const marker = list?.ordinal == null ? '- ' : `${list.ordinal++}. `;
      if (list) {
        list.contentIndent = indent + ' '.repeat(marker.length);
      }
      out.newline();
      out.marker(indent + marker);
      return;
    }

    case 'term':
      out.raw(isClose ? '**: ' : '**');
      return;

    // <u> has no Markdown equivalent; <description> is pure structure.
    default:
      return;
  }
}

/**
 * Push a list, indented to sit inside the item that encloses it.
 *
 * `bullet` is the default when `type` is absent or unrecognised, which is what
 * the C# specification says and what every renderer downstream does. Only
 * `number` counts; `table` is a bullet list with a header, because the hover has
 * no table styling worth the ambiguity (see `decorate`).
 */
function openList(state: ScanState, type: string | undefined): void {
  const parent = state.lists[state.lists.length - 1];
  const indent = parent?.contentIndent ?? '';
  state.lists.push({
    ordinal: type?.toLowerCase() === 'number' ? 1 : null,
    indent,
    contentIndent: indent,
  });
}

/**
 * A fence delimiter at the start of `line`, per CommonMark: up to three spaces of
 * indent, then three or more backticks or tildes. A backtick fence may not carry
 * a backtick in its info string, which is what keeps `` `a` `` off this path.
 */
function matchFence(line: string): { char: string; length: number; info: string } | null {
  const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!m) {
    return null;
  }
  const char = m[1][0];
  if (char === '`' && m[2].includes('`')) {
    return null;
  }
  return { char, length: m[1].length, info: m[2].trim() };
}

/** The info string to append to an unlabelled fence, or `''` for none. */
function fenceLanguage(configured: string | undefined): string {
  const id = (configured ?? '').trim();
  return LANGUAGE_ID.test(id) ? id : '';
}

/** A fence closes on the same character, at least as long, and nothing else on the line. */
function closes(open: Fence, candidate: { char: string; length: number; info: string }): boolean {
  return (
    candidate.char === open.char &&
    candidate.length >= open.length &&
    candidate.info === ''
  );
}

function demoteHeading(line: string, by: number): string {
  const m = HEADING.exec(line);
  if (!m) {
    return line;
  }
  return m[1] + '#'.repeat(Math.min(6, m[2].length + by)) + m[3];
}

/** A reference to render, however it was spelled: `[`X`]`, `[text](X)` or `<see cref="X"/>`. */
interface Reference {
  /** What the reader sees, backticks and all, exactly as it was written. */
  label: string;
  /** The path to resolve, stripped of generic arguments and parameter lists. */
  path: string;
}

interface SymbolLink extends Reference {
  /** Index just past the closing delimiter. */
  end: number;
}

/**
 * A rustdoc intra-doc link starting at `start`, or null if this bracket is
 * ordinary Markdown. Two forms are recognised, the two rustdoc users write:
 *
 * - `` [`Device.Send`] `` and `[Device.Send]`, a shortcut link with no destination
 * - `[the sender](Device.Send)`, an inline link whose destination is not a URL
 *
 * Reference links (`[text][ref]`), link definitions (`[ref]: url`) and footnotes
 * (`[^1]`) are left alone, because there is no way to tell a symbol from a label
 * once a definition elsewhere gives the label a meaning.
 */
function matchSymbolLink(line: string, start: number): SymbolLink | null {
  const close = line.indexOf(']', start + 1);
  if (close < 0) {
    return null;
  }
  const label = line.slice(start + 1, close);
  if (label === '' || label.startsWith('^')) {
    return null;
  }

  const next = line[close + 1];
  if (next === '(') {
    const paren = line.indexOf(')', close + 2);
    if (paren < 0) {
      return null;
    }
    const dest = line.slice(close + 2, paren).trim();
    return looksLikeSymbol(dest)
      ? { label, path: normalizePath(dest), end: paren + 1 }
      : null;
  }
  if (next === '[' || next === ':') {
    return null;
  }

  // A shortcut link is only a reference when the author signalled intent, either
  // by qualifying the path or by wrapping it in backticks. Without that rule an
  // ordinary `[note]` in prose would silently become a broken link.
  const bare = label.replace(/^`+|`+$/g, '');
  const deliberate = bare !== label || /\.|::/.test(bare);
  return deliberate && looksLikeSymbol(bare)
    ? { label, path: normalizePath(bare), end: close + 1 }
    : null;
}

/**
 * True for something that could name a C# type or member. The uppercase-segment
 * requirement is what separates `Device.Send` from `readme.md`: .NET naming
 * makes every public type and member PascalCase, and no file extension is.
 */
function looksLikeSymbol(text: string): boolean {
  const bare = text.replace(/[<(].*$/, '');
  if (!SYMBOL_PATH.test(bare)) {
    return false;
  }
  return bare.split(/\.|::/).some((segment) => /^[A-Z]/.test(segment));
}

function normalizePath(text: string): string {
  return text.replace(/[<(].*$/, '').replace(/::/g, '.');
}

function renderSymbolLink(
  link: Reference,
  toUrl: RenderOptions['symbolLink'],
): string {
  // A backticked label is already a code span and must not be escaped; a bare
  // one is prose, and `List<T>` in it still has to survive the renderer.
  const label = link.label.startsWith('`') ? link.label : escapeText(link.label);
  const url = toUrl?.(link.path);
  return url ? `[${label}](${url})` : `\`${link.path}\``;
}

/** The extent of a backtick-delimited span starting at `start`, or null if unterminated. */
function matchCodeSpan(line: string, start: number): { text: string; end: number } | null {
  const open = /^`+/.exec(line.slice(start));
  if (!open) {
    return null;
  }
  const fence = open[0];
  const close = line.indexOf(fence, start + fence.length);
  if (close < 0) {
    return null;
  }
  const end = close + fence.length;
  return { text: line.slice(start, end), end };
}

function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs);
  if (!m) {
    return undefined;
  }
  return m[1] !== undefined ? m[1] : m[2];
}

/** `T:System.String` and friends are XML doc id prefixes, not part of the name. */
function stripCrefPrefix(cref: string): string {
  return cref.replace(/^[NTFPMEO!]:/, '');
}

const ENTITIES: Record<string, string> = {
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  amp: '&',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      return String.fromCodePoint(parseInt(body.slice(2), 16));
    }
    if (body.startsWith('#')) {
      return String.fromCodePoint(parseInt(body.slice(1), 10));
    }
    const mapped = ENTITIES[body.toLowerCase()];
    return mapped !== undefined ? mapped : whole;
  });
}

/**
 * `<` and `&` are re-encoded so `List<int>` survives a Markdown renderer with
 * HTML disabled. Entities are decoded first, so a comment that already wrote
 * `&lt;` and one that wrote `<` end up identical.
 *
 * `>` is deliberately left alone. Escaping it was symmetric and wrong: no tag can
 * open once `<` is encoded, so a lone `>` is never a tag close, while a `>` at the
 * start of a line is a blockquote and encoding it silently destroyed one.
 */
function escapeText(text: string): string {
  return decodeEntities(text).replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

/**
 * Collapse runs of blank lines and drop trailing whitespace, everywhere except
 * inside a fenced block, where both are content. Doing this with two regexes over
 * the whole buffer was the obvious version, and it silently ate blank lines out
 * of code samples.
 */
function normalize(markdown: string): string {
  const out: string[] = [];
  let fence: Fence | null = null;
  let blanks = 0;

  for (const line of markdown.split('\n')) {
    const delimiter = matchFence(line);
    if (fence) {
      if (delimiter && closes(fence, delimiter)) {
        fence = null;
      }
      out.push(line);
      continue;
    }
    if (delimiter) {
      fence = { char: delimiter.char, length: delimiter.length };
      out.push(line);
      blanks = 0;
      continue;
    }

    const trimmed = line.trimEnd();
    if (trimmed === '') {
      if (++blanks > 1) {
        continue;
      }
    } else {
      blanks = 0;
    }
    out.push(trimmed);
  }

  return out.join('\n').trim();
}

// --- Hover decoration --------------------------------------------------------
//
// Everything below exists because of what the hover stylesheet does not say. See
// `RenderOptions.hoverStyling` for the constraints; these are the two constructs
// that fall through to a browser default and look broken as a result.

/**
 * U+258C, standing in for the 5px `border-left` VS Code draws on a blockquote in
 * chat and in a comment thread, and does not draw in a hover. A `span` may carry
 * a colour and nothing else, so the bar has to be a character.
 */
const QUOTE_BAR = '▌';

/** Padding for a table cell. An entity, because marked trims real whitespace out of a cell. */
const CELL_PAD = '&nbsp;';

/** Blockquote markers, however deeply nested, and the content after them. */
const QUOTE_LINE = /^( {0,3}(?:>[ \t]?)+)(.*)$/;

/**
 * A GitHub alert, and the codicon VS Code draws for it. Copied from its own map
 * in `workbench.desktop.main.js` so a hover reads like chat does.
 *
 * These five names and no others, because they are the only ones anything
 * downstream has heard of: `[!TODO]` is not an alert to VS Code, and treating it
 * as one here would draw a title for a construct no renderer agrees exists.
 */
const ALERTS: Record<string, string> = {
  note: 'info',
  tip: 'light-bulb',
  important: 'comment',
  warning: 'alert',
  caution: 'stop',
};

/**
 * The alert marker, which is only a marker on the first line of the quote. VS
 * Code's own parser matches the first text token of the first paragraph, so a
 * `[!NOTE]` further down is prose there and is prose here.
 */
const ALERT = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*/i;

/**
 * A table's delimiter row. Recognised rather than assumed, because it is the only
 * line that tells a table apart from prose that happens to contain a pipe.
 */
const TABLE_DELIMITER = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

/**
 * Wrap `text` in the only styling the hover sanitizer accepts. The shape is
 * load-bearing: the allow-list tests the attribute against
 * `/^(color\:(#[0-9a-fA-F]+|var\(--vscode(-[a-zA-Z0-9]+)+\));)?.../`, so a space
 * after the colon or a missing semicolon loses the whole attribute silently.
 */
function tinted(text: string, themeColor: string): string {
  return `<span style="color:var(--vscode-${themeColor});">${text}</span>`;
}

/** Add the bar to every quote, and breathing room to every table cell. */
function decorate(markdown: string): string {
  const lines = markdown.split('\n');
  let fence: Fence | null = null;

  for (let i = 0; i < lines.length; i++) {
    const delimiter = matchFence(lines[i]);
    if (fence) {
      if (delimiter && closes(fence, delimiter)) {
        fence = null;
      }
      continue;
    }
    if (delimiter) {
      fence = { char: delimiter.char, length: delimiter.length };
      continue;
    }

    if (isTableDelimiter(lines[i]) && i > 0 && isRow(lines[i - 1])) {
      lines[i - 1] = padRow(lines[i - 1]);
      let j = i + 1;
      while (j < lines.length && isRow(lines[j]) && !isTableDelimiter(lines[j])) {
        lines[j] = padRow(lines[j]);
        j++;
      }
      // The delimiter row is measurement, not content, and padding it would only
      // lengthen the dashes nobody sees.
      i = j - 1;
      continue;
    }

    if (QUOTE_LINE.test(lines[i])) {
      let end = i;
      while (end < lines.length && QUOTE_LINE.test(lines[end])) {
        end++;
      }
      decorateQuote(lines, i, end);
      i = end - 1;
      continue;
    }
  }

  return lines.join('\n');
}

/**
 * The title line of an alert: the icon, the name, and whatever the author wrote
 * after the marker on the same line, all in the alert's own colour.
 *
 * The colour token is a registered workbench colour, so it satisfies the
 * sanitizer's `var\(--vscode(-[a-zA-Z0-9]+)+\)`, and the codicon inherits it:
 * `.monaco-hover .markdown-hover .hover-contents .codicon` is
 * `color:inherit;font-size:inherit`. Bold is Markdown rather than CSS, there
 * being no `font-weight` in the style allow-list.
 */
function alertTitle(kind: string, trailing: string): string {
  const label = kind.charAt(0).toUpperCase() + kind.slice(1);
  const icon = `<span class="codicon codicon-${ALERTS[kind]}"></span>`;
  return tinted(`${icon} **${label}**`, alertColor(kind)) + (trailing ? ` ${trailing}` : '');
}

function alertColor(kind: string): string {
  return `markdownAlert-${kind}-foreground`;
}

/**
 * Rewrite one blockquote, the run of quoted lines `[start, end)`.
 *
 * Two decisions, both taken for the whole quote so a quote cannot be half one
 * thing and half another:
 *
 * - Whether the bar replaces the `>` outright. It usually can, and should: there
 *   is no `.monaco-hover blockquote` rule, so the element arrives with the browser
 *   default `margin-inline: 40px` and gives up 80px of a ~484px hover. VS Code's
 *   own blockquote, in chat, offsets 15px and takes nothing off the right.
 * - Whether the quote is an alert, in which case the marker line becomes a title
 *   and the bar takes the alert's colour instead of the blockquote's.
 *
 * The alert is drawn here rather than left to VS Code, and that is a correction
 * rather than a preference. Measured against 1.132.0: the alert parser is behind
 * `MarkdownString.supportAlertSyntax`, which is proposed API
 * (`vscode.proposed.markdownAlertSyntax.d.ts`, microsoft/vscode#209652) and so
 * unreachable from a published extension. Left alone, `> [!NOTE]` reaches the
 * reader as a blockquote with the literal text `[!NOTE]` in it. And even with the
 * flag on, `blockquote[data-severity=note]` only redefines
 * `--vscode-textBlockQuote-border`; the 5px `border-left` that consumes it exists
 * under `.interactive-item-container` and `.review-widget` and nowhere near a
 * hover, so the bar would still have to come from here.
 */
function decorateQuote(lines: string[], start: number, end: number): void {
  const parts = lines.slice(start, end).map((line) => QUOTE_LINE.exec(line)!);
  const markers = parts.map((part) => part[1]);
  const contents = parts.map((part) => part[2]);

  // Depth one only: a `>>` first line is a nested quote, whose own first
  // paragraph is where a parser would look for the marker.
  const marker = depth(markers[0]) === 1 ? ALERT.exec(contents[0].trim()) : null;
  const kind = marker?.[1].toLowerCase();
  if (kind) {
    // Rewritten before anything else looks at the line, so the rest of this
    // function sees the paragraph the title has become rather than the marker.
    const trailing = contents[0].trim().slice(marker![0].length);
    const runsOn = contents[1] !== undefined && contents[1].trim() !== '';
    contents[0] = alertTitle(kind, trailing) + (runsOn ? '<br>' : '');
  }
  const themeColor = kind ? alertColor(kind) : 'textBlockQuote-border';

  const prose = contents.map((_, k) => isProse(contents, k));
  // A blank quoted line separates paragraphs and groups nothing, so it does not
  // count against flattening even though it is not prose either.
  const flatten = contents.every(
    (content, k) => (prose[k] || content.trim() === '') && depth(markers[k]) === 1,
  );

  for (let k = 0; k < parts.length; k++) {
    // One bar per paragraph, not per line: consecutive quoted lines are a single
    // soft-wrapped paragraph, and a bar on each would land mid-sentence.
    const opens = k === 0 || contents[k - 1].trim() === '';
    const bar = opens && prose[k] ? `${tinted(QUOTE_BAR, themeColor)}&nbsp;` : '';
    lines[start + k] = flatten ? bar + contents[k] : markers[k] + bar + contents[k];
  }
}

function depth(marker: string): number {
  return (marker.match(/>/g) ?? []).length;
}

/** A CommonMark leaf block that opens on its own first characters. */
const BLOCK_OPENER =
  /^(?: {4,}|#{1,6}(?:\s|$)|(?:[-*+]|\d{1,9}[.)])(?:\s|$)|`{3,}|~{3,}|(?:-{3,}|\*{3,}|_{3,})\s*$)/;

/**
 * True when line `k` of the quote is ordinary paragraph text. One predicate, two
 * uses, because both questions turn on the same property:
 *
 * - the bar may only go in front of prose. A span in front of a bullet, a fence,
 *   a heading or a table row stops the renderer recognising the construct, which
 *   destroys it rather than decorating it.
 * - the `>` may only go when every line is prose. That is the only case where the
 *   marker contributes nothing but the 40px indent; otherwise it is what holds a
 *   multi-line construct inside the quote.
 *
 * A table row is recognised by the delimiter beneath it rather than by containing
 * a pipe, so prose with a pipe in it is still prose.
 */
function isProse(contents: readonly string[], k: number): boolean {
  const content = contents[k];
  const below = contents[k + 1];
  return (
    content.trim() !== '' &&
    !BLOCK_OPENER.test(content) &&
    !isTableDelimiter(content) &&
    !(below !== undefined && isTableDelimiter(below))
  );
}

function isTableDelimiter(line: string): boolean {
  return line.includes('|') && TABLE_DELIMITER.test(line);
}

function isRow(line: string): boolean {
  return splitRow(line).length > 1;
}

/**
 * Split on the pipes that separate cells. A backslash escape is the only way to
 * put a pipe inside a cell, code span or not, so it is the only case to skip.
 */
function splitRow(row: string): string[] {
  const parts: string[] = [];
  let current = '';
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '\\' && i + 1 < row.length) {
      current += ch + row[++i];
      continue;
    }
    if (ch === '|') {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

/**
 * Pad every cell in a table row. A segment that is blank after trimming is either
 * the indent before a leading pipe, the tail after a trailing one, or an empty
 * cell, and none of the three gains anything from padding, so blankness is the
 * whole test and the outer pipes need no special case.
 */
function padRow(row: string): string {
  return splitRow(row)
    .map((part) => {
      const text = part.trim();
      return text === '' ? part : `${CELL_PAD}${text}${CELL_PAD}`;
    })
    .join('|');
}
