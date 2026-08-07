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
}

/** An open fenced code block: which character opened it, and how many of them. */
interface Fence {
  char: string;
  length: number;
}

/** What the tag handlers are allowed to do to the output buffer. */
interface Emitter {
  /** Append Markdown verbatim. */
  raw(text: string): void;
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
  };
  const demote = options.demoteHeadings ?? 0;
  let buf = '';

  const emitter: Emitter = {
    raw(text) {
      if (depth === 0 && text) {
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
    // A code span shows entities literally, so text bound for one is only decoded.
    buf += state.inCodeSpan ? decodeEntities(text) : escapeText(text);
  };

  for (const raw of docLines) {
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
        buf += raw + '\n';
        continue;
      }
    }

    const line = depth === 0 && demote > 0 ? demoteHeading(raw, demote) : raw;
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
          emitter.raw(span.text);
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
        if (!tag.isSelfClosing) {
          depth = tag.isClose ? Math.max(0, depth - 1) : depth + 1;
        }
      } else if (depth === 0) {
        applyInlineTag(tag, emitter, state);
      }
      i = lt + m![0].length;
    }

    if (depth === 0) {
      buf += '\n';
    }
  }

  return { markdown: normalize(buf), hadSections };
}

/** Translate one inline element into Markdown, updating the scanner's state. */
function applyInlineTag(tag: Tag, out: Emitter, state: ScanState): void {
  const { name, isClose, isSelfClosing, attrs } = tag;
  switch (name) {
    case 'c':
    case 'tt':
      out.raw('`');
      state.inCodeSpan = !isClose;
      return;

    case 'code':
      if (isSelfClosing) {
        return;
      }
      out.blankLine();
      out.raw('```');
      state.inCodeFence = !isClose;
      return;

    case 'see':
    case 'a': {
      const href = attr(attrs, 'href');
      if (isSelfClosing) {
        const cref = attr(attrs, 'cref');
        const langword = attr(attrs, 'langword');
        if (href !== undefined) {
          out.raw(`[${href}](${href})`);
        } else if (cref !== undefined) {
          out.raw(`\`${stripCrefPrefix(cref)}\``);
        } else if (langword !== undefined) {
          out.raw(`\`${langword}\``);
        }
        return;
      }
      if (isClose) {
        const pending = state.linkStack.pop();
        out.raw(pending ? `](${pending})` : '`');
        state.inCodeSpan = false;
      } else if (href !== undefined) {
        state.linkStack.push(href);
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

    case 'item':
      if (!isClose) {
        out.newline();
        out.raw('- ');
      }
      return;

    case 'term':
      out.raw(isClose ? '**: ' : '**');
      return;

    // <u> has no Markdown equivalent; <list> and <description> are pure structure.
    default:
      return;
  }
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

interface SymbolLink {
  /** What the reader sees, backticks and all, exactly as it was written. */
  label: string;
  /** The path to resolve, stripped of generic arguments and parameter lists. */
  path: string;
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
  link: SymbolLink,
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
