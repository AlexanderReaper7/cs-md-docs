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
  /** Inside a Markdown code span opened by `<c>` or an inner-text `<see>`. */
  inCodeSpan: boolean;
  /** Per open `<see>`/`<a>`: the href to close a Markdown link with, or null for a code span. */
  linkStack: (string | null)[];
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
export function extractUntagged(docLines: readonly string[]): ExtractResult {
  /** Depth of open section elements. Text is only ours at depth 0. */
  let depth = 0;
  let hadSections = false;
  const state: ScanState = { inCodeFence: false, inCodeSpan: false, linkStack: [] };
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

  for (const line of docLines) {
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
      out.raw('  \n');
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
 * Angle brackets and ampersands are re-encoded so `List<int>` survives a
 * Markdown renderer with HTML disabled. Entities are decoded first, so a comment
 * that already wrote `&lt;` and one that wrote `<` end up identical.
 */
function escapeText(text: string): string {
  return decodeEntities(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function normalize(markdown: string): string {
  return markdown
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
