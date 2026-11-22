// Fast reimplementation of makefun-site 1.0.0 (make.fun's own reference program).
// Byte-identical output, written from the vendor's spec (README.md) and code
// (vendor/makefun-site/index.js + lib/*.js). Single module, dependency-free,
// no I/O, no clock, no randomness, no environment reads. Nothing is cached
// from one case to the next: all per-case state lives in the `B` object
// created fresh inside run().

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Whether char code `c` is whitespace, exactly JavaScript's \s. */
function isWS(c) {
  return (
    c === 32 ||
    (c >= 9 && c <= 13) ||
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

const RE_WS = /\s/;
const RE_CR = /\r\n?/g;
const RE_ESC_AMP = /&/g;
const RE_ESC_LT = /</g;
const RE_ESC_GT = />/g;
const RE_ESC_QUOT = /"/g;
const RE_ESC_APOS = /'/g;
const RE_NONALNUM = /[^a-z0-9]+/g;
const RE_EDGE_DASH = /^-+|-+$/g;
const RE_TRAIL_DASH = /-+$/;
const RE_MARKS = /\p{M}/gu;

/** `text` with & < > " and ' escaped. Fast path: no special char, return as-is. */
function escapeHtml(s) {
  if (
    s.indexOf('&') === -1 &&
    s.indexOf('<') === -1 &&
    s.indexOf('>') === -1 &&
    s.indexOf('"') === -1 &&
    s.indexOf("'") === -1
  )
    return s;
  return s
    .replace(RE_ESC_AMP, '&amp;')
    .replace(RE_ESC_LT, '&lt;')
    .replace(RE_ESC_GT, '&gt;')
    .replace(RE_ESC_QUOT, '&quot;')
    .replace(RE_ESC_APOS, '&#39;');
}

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of
 * characters other than a-z and 0-9 one "-", none at either end, at most 64
 * characters (a "-" left at the cut dropped), and "untitled" when nothing is left.
 * Pure ASCII text is NFKD-stable and holds no combining marks, so it takes a
 * regex fast path that is provably identical to the reference loop.
 */
function slugifyRaw(text) {
  let s;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 128) {
      ascii = false;
      break;
    }
  }
  if (ascii) {
    s = text.toLowerCase().replace(RE_NONALNUM, '-').replace(RE_EDGE_DASH, '');
  } else {
    const plain = text.normalize('NFKD').replace(RE_MARKS, '');
    let out = '';
    let gap = false;
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
    s = out;
  }
  s = s.slice(0, 64).replace(RE_TRAIL_DASH, '');
  return s === '' ? 'untitled' : s;
}

/** Slug of `text`, cached per string within this case. */
function slugify(B, text) {
  const c = B.slugCache.get(text);
  if (c !== undefined) return c;
  const s = slugifyRaw(text);
  B.slugCache.set(text, s);
  return s;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 32 || c === 10 || c === 9 || c === 13 || c === 11 || c === 12) {
      inWord = false;
    } else if (c >= 128) {
      if (isWS(c)) inWord = false;
      else if (!inWord) {
        inWord = true;
        n++;
      }
    } else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

/** `rel` (a link's path, "/"-separated) from the directory segments `dirParts`, or null when it climbs out of the root. */
function resolvePath(dirParts, rel) {
  const parts = dirParts.slice();
  const segs = rel.split('/');
  for (let k = 0; k < segs.length; k++) {
    const seg = segs[k];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
};

// ---------------------------------------------------------------- front matter

const KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** Whether `s` is a template name: [a-z0-9-]+, non-empty. */
function isName(s) {
  if (s.length === 0) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return false;
  }
  return true;
}

/** Whether `s` is a slug: [a-z0-9]+ (-[a-z0-9]+)*, at most 64 characters. */
function isSlug(s) {
  const n = s.length;
  if (n === 0 || n > 64) return false;
  let prevDash = true;
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c === 45) {
      if (prevDash) return false;
      prevDash = true;
    } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
    else return false;
  }
  return !prevDash;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34)
      return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const nx = raw[i + 1];
        if ((nx !== '"' && nx !== '\\') || i + 1 === raw.length - 1)
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += nx;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      let y = 0;
      let mo = 0;
      let d = 0;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) {
            ok = false;
            break;
          }
        }
        if (ok) {
          y = Number(raw.slice(0, 4));
          mo = Number(raw.slice(5, 7));
          d = Number(raw.slice(8, 10));
        }
      }
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo))
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93)
        return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',');
      for (let k = 0; k < tags.length; k++) {
        const t = tags[k].trim();
        tags[k] = t;
        if (
          t === '' ||
          t.indexOf('"') !== -1 ||
          t.indexOf('[') !== -1 ||
          t.indexOf(']') !== -1
        )
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true'
        ? { value: true }
        : raw === 'false'
          ? { value: false }
          : { error: 'key "draft": true or false' };
    case 'layout':
      return isName(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return isSlug(raw) ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** Whether `line` holds only spaces and tabs (or is empty). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first
 * reason it is refused. `text` has "\n" line ends. Lines are scanned by cursor,
 * never split into an array.
 */
function parseFrontMatter(text) {
  const nl0 = text.indexOf('\n');
  if ((nl0 === -1 ? text : text.slice(0, nl0)) !== '---') return { error: 'no front matter' };
  // Collect the front-matter lines (start/end offsets) up to the closing '---'.
  const lines = [];
  let cur = nl0 === -1 ? text.length : nl0 + 1;
  let closeEnd = -1;
  while (cur <= text.length) {
    const nl = text.indexOf('\n', cur);
    const end = nl === -1 ? text.length : nl;
    if (text.slice(cur, end) === '---') {
      closeEnd = nl === -1 ? text.length : nl + 1;
      break;
    }
    lines.push(cur, end);
    if (nl === -1) break;
    cur = nl + 1;
  }
  if (closeEnd === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let k = 0; k < lines.length; k += 2) {
    const line = text.slice(lines[k], lines[k + 1]);
    const lineNo = k / 2 + 2;
    if (isBlank(line) || line.charCodeAt(0) === 35) continue;
    // /^([a-z_]+):(?: (.*))?$/ — key, colon, one space and the value.
    let i = 0;
    while (i < line.length) {
      const c = line.charCodeAt(i);
      if ((c >= 97 && c <= 122) || c === 95) i++;
      else break;
    }
    if (i === 0 || line.charCodeAt(i) !== 58)
      return { error: `line ${lineNo} is not "key: value"` };
    const key = line.slice(0, i);
    let raw;
    if (i + 1 === line.length) raw = '';
    else if (line.charCodeAt(i + 1) === 32) raw = line.slice(i + 2);
    else return { error: `line ${lineNo} is not "key: value"` };
    let e = raw.length;
    while (e > 0) {
      const c = raw.charCodeAt(e - 1);
      if (c === 32 || c === 9) e--;
      else break;
    }
    if (e < raw.length) raw = raw.slice(0, e);
    if (!KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeEnd) };
}

// ---------------------------------------------------------------- markdown

/** The characters a backslash escapes. */
function isEscapableCode(c) {
  return (
    c === 92 ||
    c === 96 ||
    c === 42 ||
    c === 95 ||
    c === 91 ||
    c === 93 ||
    c === 40 ||
    c === 41 ||
    c === 35 ||
    c === 43 ||
    c === 45 ||
    c === 46 ||
    c === 33 ||
    c === 62
  );
}

/** `line` with spaces and tabs at either end dropped. */
function trimLine(s) {
  let a = 0;
  let b = s.length;
  while (a < b && (s.charCodeAt(a) === 32 || s.charCodeAt(a) === 9)) a++;
  while (b > a && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  return s.slice(a, b);
}

/** A fence's language, or null when `line` does not open one. */
function fenceLang(line) {
  if (
    line.charCodeAt(0) !== 96 ||
    line.charCodeAt(1) !== 96 ||
    line.charCodeAt(2) !== 96
  )
    return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (
      (c >= 65 && c <= 90) ||
      (c >= 97 && c <= 122) ||
      (c >= 48 && c <= 57) ||
      c === 95 ||
      c === 43 ||
      c === 45
    )
      i++;
    else break;
  }
  for (let j = i; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return null;
  }
  return line.slice(3, i);
}

/** Whether `line` closes a fence. */
function isFenceClose(line) {
  if (
    line.charCodeAt(0) !== 96 ||
    line.charCodeAt(1) !== 96 ||
    line.charCodeAt(2) !== 96
  )
    return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 35) i++;
  if (i === 0 || i > 6) return null;
  if (i >= line.length) return null;
  const c = line.charCodeAt(i);
  if (c !== 32 && c !== 9) return null;
  let a = i;
  while (a < line.length && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  let b = line.length;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  if (b === a) return null;
  return { depth: i, text: line.slice(a, b) };
}

/** Whether `line` is a thematic break. */
function isHR(line) {
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  if (line.charCodeAt(1) !== c0 || line.charCodeAt(2) !== c0) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A bullet item's text, or null. */
function bulletOf(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered item's start number and text, or null. */
function orderedOf(line) {
  let i = 0;
  while (i < line.length && i < 9) {
    const c = line.charCodeAt(i);
    if (c < 48 || c > 57) break;
    i++;
  }
  if (i === 0) return null;
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  return { start: Number(line.slice(0, i)), text: line.slice(i + 2) };
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i < 2 || i >= line.length) return false;
  return !isWS(line.charCodeAt(i));
}

/** Whether `line` ends a paragraph. */
function endsParagraph(line) {
  return isBlank(line) || fenceLang(line) !== null || headingOf(line) !== null || isHR(line);
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, before `limit`, or -1. */
function findUnescaped(s, what, from, limit) {
  const wlen = what.length;
  const end = limit - wlen;
  for (let j = from; j <= end; j++) {
    if (
      s.charCodeAt(j) === 92 &&
      j + 1 < limit &&
      isEscapableCode(s.charCodeAt(j + 1))
    ) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, before `limit`, or -1. */
function findSingleStar(s, from, limit) {
  for (let j = from; j < limit; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < limit && isEscapableCode(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (j + 1 < limit && s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** `s.indexOf(ch, from)` restricted to positions before `limit`, or -1. */
function boundedIndexOf(s, ch, from, limit) {
  const j = s.indexOf(ch, from);
  return j === -1 || j >= limit ? -1 : j;
}

/**
 * `s` rendered inline; `env.link(target)` is a link's href. One left-to-right
 * pass: plain runs are sliced out whole (never escaped char by char), and
 * strong / emphasis / link spans are frames on an explicit stack, each closed
 * at the position the reference's recursive call would have found — every
 * closer search is bounded by the innermost open frame, exactly as the
 * reference's recursion bounds it to its slice.
 */
function inline(B, s, env) {
  const n = s.length;
  const root = [];
  const frames = [];
  let out = root;
  let i = 0;
  let runStart = 0;
  let top = null;
  let limit = n;
  const flush = (to) => {
    if (to > runStart) out.push(s.slice(runStart, to));
  };
  while (i < n) {
    if (top !== null && i >= top.close) {
      flush(i);
      const kind = top.kind;
      const after = top.after;
      const inner = top.out.join('');
      frames.pop();
      out = frames.length === 0 ? root : frames[frames.length - 1].out;
      top = frames.length === 0 ? null : frames[frames.length - 1];
      limit = top === null ? n : top.close;
      // The opening tag was pushed when the frame opened; here only the
      // inner content and the closing tag go to the parent.
      out.push(inner);
      if (kind === 0) {
        out.push('</strong>');
        i += 2;
      } else if (kind === 1) {
        out.push('</em>');
        i += 1;
      } else {
        out.push('</a>');
        i = after;
      }
      runStart = i;
      continue;
    }
    const c = s.charCodeAt(i);
    if (c === 92) {
      if (i + 1 < limit && isEscapableCode(s.charCodeAt(i + 1))) {
        flush(i);
        // The escaped character is written escaped: of the escapable set
        // only '>' is in the escape table ('>' -> '&gt;').
        out.push(s.charCodeAt(i + 1) === 62 ? '&gt;' : s[i + 1]);
        i += 2;
        runStart = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === 96) {
      const j = boundedIndexOf(s, '`', i + 1, limit);
      if (j > i + 1) {
        flush(i);
        out.push('<code>');
        out.push(escapeHtml(s.slice(i + 1, j)));
        out.push('</code>');
        i = j + 1;
        runStart = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === 42) {
      if (i + 1 < limit && s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2, limit);
        if (j > i + 2) {
          flush(i);
          const fOut = [];
          top = { kind: 0, close: j, out: fOut };
          frames.push(top);
          limit = j;
          out.push('<strong>');
          out = fOut;
          i += 2;
          runStart = i;
          continue;
        }
        i += 2;
        continue;
      }
      const j = findSingleStar(s, i + 1, limit);
      if (j > i + 1) {
        flush(i);
        const fOut = [];
        top = { kind: 1, close: j, out: fOut };
        frames.push(top);
        limit = j;
        out.push('<em>');
        out = fOut;
        i += 1;
        runStart = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === 91) {
      const k = findUnescaped(s, ']', i + 1, limit);
      let m = -1;
      if (k !== -1 && k + 1 < limit && s.charCodeAt(k + 1) === 40) {
        m = boundedIndexOf(s, ')', k + 2, limit);
      }
      if (m !== -1) {
        const target = s.slice(k + 2, m);
        if (target !== '' && !RE_WS.test(target)) {
          flush(i);
          const href = escapeHtml(env.link(target));
          const fOut = [];
          top = { kind: 2, close: k, out: fOut, href, after: m + 1 };
          frames.push(top);
          limit = k;
          out.push('<a href="');
          out.push(href);
          out.push('">');
          out = fOut;
          i += 1;
          runStart = i;
          continue;
        }
      }
      i++;
      continue;
    }
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) {
      flush(i);
      out.push(
        c === 38
          ? '&amp;'
          : c === 60
            ? '&lt;'
            : c === 62
              ? '&gt;'
              : c === 34
                ? '&quot;'
                : '&#39;',
      );
      i++;
      runStart = i;
      continue;
    }
    i++;
  }
  flush(n);
  while (frames.length > 0) {
    const f = frames.pop();
    const inner = f.out.join('');
    const parent = frames.length === 0 ? root : frames[frames.length - 1].out;
    parent.push(inner);
    if (f.kind === 0) parent.push('</strong>');
    else if (f.kind === 1) parent.push('</em>');
    else parent.push('</a>');
  }
  return root.join('');
}

/**
 * `src` rendered: its HTML, its table of contents (every level 2 and 3 heading)
 * and its excerpt (the first paragraph's inline HTML, or ""). The lexer and
 * the renderer run in one pass over the lines, read by cursor, with no token
 * array and no per-line regex.
 */
function renderMarkdown(B, src, env) {
  const n = src.length;
  const out = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let line = '';
  let next = -1;
  let hasLine = true;
  const load = (p) => {
    const nl = src.indexOf('\n', p);
    if (nl === -1) {
      line = src.slice(p);
      next = -1;
    } else {
      line = src.slice(p, nl);
      next = nl + 1;
    }
  };
  const advance = () => {
    if (next === -1) {
      hasLine = false;
      return false;
    }
    load(next);
    return true;
  };
  load(0);
  // One list body, shared by the bullet and ordered branches below.
  const doList = (isOrdered, start, firstText) => {
    const items = [];
    let cur = [trimLine(firstText)];
    while (advance()) {
      let m = null;
      if (isOrdered) {
        const o = orderedOf(line);
        if (o !== null) m = o.text;
      } else {
        m = bulletOf(line);
      }
      if (m !== null) {
        items.push(cur.join('\n'));
        cur = [trimLine(m)];
      } else if (isContinued(line)) {
        cur.push(trimLine(line));
      } else break;
    }
    items.push(cur.join('\n'));
    out.push(isOrdered && start !== 1 ? `<ol start="${start}">` : isOrdered ? '<ol>' : '<ul>');
    out.push('\n');
    for (let k = 0; k < items.length; k++) {
      out.push('<li>');
      out.push(inline(B, items[k], env));
      out.push('</li>\n');
    }
    out.push(isOrdered ? '</ol>' : '</ul>');
    out.push('\n');
  };
  while (hasLine) {
    // Dispatch on the first character: a block can only start on one of
    // ' ', '\t', '#', '`', '-', '*', '>', a digit; anything else is a
    // paragraph line, and an empty line is blank. This keeps the common
    // paragraph line out of every classifier call.
    const fc = line.charCodeAt(0);
    if (line.length === 0 || fc === 32 || fc === 9) {
      if (isBlank(line)) {
        advance();
        continue;
      }
    } else if (fc === 96) {
      const lang = fenceLang(line);
      if (lang !== null) {
        out.push('<pre><code');
        if (lang !== '') {
          out.push(' class="language-');
          out.push(escapeHtml(lang));
          out.push('"');
        }
        out.push('>');
        while (advance()) {
          if (isFenceClose(line)) {
            advance();
            break;
          }
          out.push(escapeHtml(line));
          out.push('\n');
        }
        out.push('</code></pre>\n');
        continue;
      }
    } else if (fc === 35) {
      const hd = headingOf(line);
      if (hd !== null) {
        const id = uniqueSlug(slugify(B, hd.text), ids);
        const html = inline(B, hd.text, env);
        out.push('<h', String(hd.depth), ' id="', id, '">', html, '</h', String(hd.depth), '>\n');
        if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
        advance();
        continue;
      }
    } else if (fc === 45 || fc === 42) {
      if (isHR(line)) {
        out.push('<hr>\n');
        advance();
        continue;
      }
      const b = bulletOf(line);
      if (b !== null) {
        doList(false, 1, b);
        continue;
      }
    } else if (fc === 62) {
      const parts = [];
      do {
        let t = line.slice(1);
        if (t.charCodeAt(0) === 32) t = t.slice(1);
        t = trimLine(t);
        if (t !== '') parts.push(t);
      } while (advance() && line.charCodeAt(0) === 62);
      out.push(
        parts.length === 0
          ? '<blockquote>\n</blockquote>\n'
          : '<blockquote>\n<p>' + inline(B, parts.join('\n'), env) + '</p>\n</blockquote>\n',
      );
      continue;
    } else if (fc >= 48 && fc <= 57) {
      const o = orderedOf(line);
      if (o !== null) {
        doList(true, o.start, o.text);
        continue;
      }
    }
    const parts = [trimLine(line)];
    while (advance()) {
      if (endsParagraph(line)) break;
      parts.push(trimLine(line));
    }
    const html = inline(B, parts.join('\n'), env);
    if (excerpt === null) excerpt = html;
    out.push('<p>');
    out.push(html);
    out.push('</p>\n');
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH.test(text))
    throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1)
        throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({
        t: raw ? 'raw' : 'var',
        path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()),
      });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone =
      /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
/** Node kinds: 0 text, 1 var, 2 raw, 3 if, 4 for, 5 include, 6 root. */
function parseTemplate(name, src) {
  const root = { kind: 6, body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 0, text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw')
      body.push({ kind: tok.t === 'var' ? 1 : 2, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR.exec(tag)) !== null) {
        const node = { kind: 4, name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
        const node = { kind: 3, not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 3 || top.else !== null)
          throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 4 : 3))
          throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body =
          parent.kind === 6
            ? parent.body
            : parent.kind === 4
              ? parent.body
              : parent.else ?? parent.then;
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ kind: 5, name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) {
    const k = stack[stack.length - 1].kind;
    throw new TemplateError(`template "${name}": a ${k === 4 ? 'for' : 'if'} is not closed`);
  }
  return root.body;
}

/**
 * The value at `path` in the scope chain. Scopes are prototype-chained objects
 * (a null-prototype root), so the innermost binding is found by one property
 * read; each next name is an own property of the value so far, or undefined.
 */
function lookup(scope, path) {
  if (!(path[0] in scope)) return undefined;
  let v = scope[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * The first names a template's output depends on, transitively through its
 * includes: every path's first name that is not bound inside the template
 * itself (a for's element or `loop`) and not one of the per-case constants
 * (site, tags, recent). The set is a conservative over-approximation: a name
 * counted here that the output never actually reads only costs a cache miss,
 * while a name missed here would be a wrong cache hit — so every reference,
 * condition and loop source counts, and a for's own element and `loop` are the
 * only names ever treated as bound (their values are fixed by the loop's
 * source, which is itself counted).
 */
function templateDeps(nodes, templates) {
  const deps = new Set();
  const seen = new Set();
  const walk = (ns, bound) => {
    for (const n of ns) {
      if (n.kind === 1 || n.kind === 2 || n.kind === 3 || n.kind === 4) {
        if (!bound.has(n.path[0])) deps.add(n.path[0]);
      }
      if (n.kind === 3) {
        walk(n.then, bound);
        if (n.else !== null) walk(n.else, bound);
      } else if (n.kind === 4) {
        const b2 = new Set(bound);
        b2.add(n.name);
        b2.add('loop');
        walk(n.body, b2);
      } else if (n.kind === 5) {
        if (!seen.has(n.name)) {
          seen.add(n.name);
          const t = templates.get(n.name);
          if (t !== undefined) walk(t, bound);
        }
      }
    }
  };
  walk(nodes, new Set());
  deps.delete('site');
  deps.delete('tags');
  deps.delete('recent');
  return deps;
}

/**
 * `nodes` rendered into `out` (an array of string parts, joined once by the
 * caller) in `scope`. `ctx` holds the parsed templates, the HTML escape, the
 * include depth, the per-template memo info and the memo cache. An include of
 * a template whose output depends on no scope value, or on exactly one, is
 * rendered once per (depth, value) and reused: a card is the same HTML wherever
 * its post is listed, and a nav is the same on every page of a case.
 */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    const k = n.kind;
    if (k === 0) {
      out.push(n.text);
    } else if (k === 1) {
      const v = lookup(scope, n.path);
      out.push(ctx.escape(typeof v === 'string' ? v : textOf(v)));
    } else if (k === 2) {
      const v = lookup(scope, n.path);
      out.push(typeof v === 'string' ? v : textOf(v));
    } else if (k === 3) {
      const v = truthy(lookup(scope, n.path));
      const branch = v !== n.not ? n.then : n.else;
      if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
    } else if (k === 4) {
      const xs = lookup(scope, n.path);
      if (Array.isArray(xs)) {
        const len = xs.length;
        for (let i = 0; i < len; i++) {
          const child = Object.create(scope);
          child[n.name] = xs[i];
          child.loop = { index: i + 1, first: i === 0, last: i === len - 1, length: len };
          renderNodes(n.body, child, ctx, depth, out);
        }
      }
    } else if (k === 5) {
      if (depth < INCLUDE_DEPTH) {
        const t = ctx.templates.get(n.name);
        if (t !== undefined) {
          const mi = ctx.memoInfo.get(n.name);
          if (mi === undefined) {
            renderNodes(t, scope, ctx, depth + 1, out);
          } else {
            const key = mi.key === null ? undefined : lookup(scope, [mi.key]);
            let byDepth = ctx.memo.get(n.name);
            if (byDepth === undefined) {
              byDepth = new Map();
              ctx.memo.set(n.name, byDepth);
            }
            let byKey = byDepth.get(depth + 1);
            if (byKey === undefined) {
              byKey = new Map();
              byDepth.set(depth + 1, byKey);
            }
            let cached = byKey.get(key);
            if (cached === undefined) {
              const sub = [];
              renderNodes(t, scope, ctx, depth + 1, sub);
              cached = sub.join('');
              byKey.set(key, cached);
            }
            out.push(cached);
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------- the pipeline

/** 1. The sources, in code-unit order of their paths; a source that is not .md is static. */
function readSources(B) {
  const files = [...B.input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      let text = f.content;
      if (text.indexOf('\r') !== -1) text = text.replace(RE_CR, '\n');
      B.sources.push({ path: f.path, text });
    } else B.statics.push({ path: f.path, content: f.content });
  }
}

/** 2. Each source's front matter: a refused source is reported and dropped, and so is a draft. */
function frontMatter(B) {
  const kept = [];
  for (const s of B.sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      B.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      B.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      B.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!B.templates.has(layout)) {
      B.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      B.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  B.sources = kept;
}

/** 3. Each page's output directory and url: its slug made unique in its directory, in source order. */
function permalinks(B) {
  const taken = new Map();
  const takenIn = (dir) => {
    let t = taken.get(dir);
    if (t === undefined) {
      t = new Set(dir === '' ? ['posts', 'tags', 'page'] : []);
      taken.set(dir, t);
    }
    return t;
  };
  for (const s of B.sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(B, s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${B.base}/${s.outDir}/`;
    B.bySource.set(s.path, s);
  }
}

/** Whether `target` carries a scheme (https:, mailto:, ...). */
function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if (c === 58) return true;
    if (
      !((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)
    )
      return false;
  }
  return false;
}

/** 4. Each body's Markdown, its links resolved to the pages and static files they name. */
function markdown(B) {
  const staticPaths = new Set(B.statics.map((f) => f.path));
  for (const s of B.sources) {
    const dir = dirOf(s.path);
    const dirParts = dir === '' ? [] : dir.split('/');
    const env = {
      link: (target) => {
        if (
          hasScheme(target) ||
          target.charCodeAt(0) === 47 ||
          target.charCodeAt(0) === 35
        )
          return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dirParts, rel);
        if (path !== null) {
          const pg = B.bySource.get(path);
          if (pg !== undefined) return `${pg.url}${frag}`;
          if (staticPaths.has(path)) return `${B.base}/${path}${frag}`;
        }
        B.broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(B, s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }
}

/** 5. The posts, newest first and then by slug; each post's newer and older neighbours. */
function collections(B) {
  const posts = B.sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  B.posts = posts;
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });
}

/** 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug. */
function tags(B) {
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(B, name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of B.posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(B, name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${B.base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of B.sources)
    if (!s.post)
      s.tagRefs = ownTags(s).map(
        (name) =>
          bySlug.get(slugify(B, name)) ?? { name, slug: slugify(B, name), url: '', posts: [] },
      );
  B.tags = [...bySlug.values()].sort(
    (x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug),
  );
}

/** A page's link record as templates read it. */
const linkOf = (s) =>
  s === null
    ? null
    : {
        title: s.data.title,
        url: s.url,
        date: s.data.date ?? '',
        date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      };

/** A post's card, as lists show it. */
function cardOf(B, s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page as its layout reads it. */
function pageOf(B, s) {
  return {
    ...s.card,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

/** A tag as templates read it (its posts as cards). */
const tagOf = (B, t) => ({
  name: t.name,
  slug: t.slug,
  url: t.url,
  count: t.posts.length,
  posts: t.posts.map((p) => B.cards.get(p)),
});

/** 7. Every page through its layout, the index pages and the tag pages through theirs. */
function layouts(B) {
  B.cards = new Map();
  for (const p of B.posts) {
    const c = cardOf(B, p);
    p.card = c;
    B.cards.set(p, c);
  }
  for (const s of B.sources) if (!s.post) s.card = cardOf(B, s);
  const site = { title: B.input.site.title, base_url: B.base };
  const allTags = B.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = B.posts.slice(0, B.input.site.recent).map((p) => B.cards.get(p));
  const ctx = { templates: B.templates, escape: escapeHtml, memoInfo: B.memoInfo, memo: B.memo };
  const render = (name, vars) => {
    const nodes = B.templates.get(name);
    if (nodes === undefined) return null;
    const scope = Object.create(null);
    scope.site = site;
    scope.tags = allTags;
    scope.recent = recent;
    for (const k of Object.keys(vars)) scope[k] = vars[k];
    const out = [];
    renderNodes(nodes, scope, ctx, 0, out);
    return out.join('');
  };
  for (const s of B.sources) B.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(B, s) });
  const per = B.input.site.per_page;
  const pages = Math.max(1, Math.ceil(B.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${B.base}/` : `${B.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: B.posts.slice((k - 1) * per, k * per).map((p) => B.cards.get(p)),
      pager: {
        number: k,
        total: pages,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pages ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) B.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of B.tags) {
    const html = render('tag', { tag: tagOf(B, t) });
    if (html !== null) B.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) B.output['tags/index.html'] = tagsHtml;
  for (const f of B.statics) {
    if (Object.hasOwn(B.output, f.path)) B.report.push(`shadowed ${f.path}: a built page has its path`);
    else B.output[f.path] = f.content;
  }
}

/** 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts. */
function report(B) {
  const lines = [...B.report, ...B.broken].sort(byCodeUnits);
  const pages = B.sources.filter((s) => !s.post).length;
  lines.push(
    `built ${pages} pages, ${B.posts.length} posts, ${B.tags.length} tags and ${B.statics.length} static files`,
  );
  B.output['build-report.txt'] = `${lines.join('\n')}\n`;
}

/** One site's output tree: path -> text. */
export function run(input) {
  const B = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates: new Map(),
    slugCache: new Map(),
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report: [],
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
  };
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      B.templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      B.report.push(err.message);
    }
  }
  // Which templates an include may memoize: those whose output depends on no
  // scope value, or on exactly one (its memo key); the rest render every time.
  B.memoInfo = new Map();
  for (const [name, nodes] of B.templates) {
    const deps = templateDeps(nodes, B.templates);
    if (deps.size === 0) B.memoInfo.set(name, { key: null });
    else if (deps.size === 1) B.memoInfo.set(name, { key: [...deps][0] });
  }
  B.memo = new Map();
  readSources(B);
  frontMatter(B);
  permalinks(B);
  markdown(B);
  collections(B);
  tags(B);
  layouts(B);
  report(B);
  return B.output;
}
