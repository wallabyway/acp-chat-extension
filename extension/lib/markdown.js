// Small, safe markdown renderer for chat bubbles.
//
// Not a full CommonMark implementation; it covers the basics agents emit:
// headings, paragraphs, fenced code, inline code, bold/italic/strike, links,
// bare URLs, ordered/unordered lists, blockquotes and horizontal rules.
//
// Safety: parse() produces a plain AST and toDom() builds nodes with
// createElement/textContent only. No HTML string is ever assigned to
// innerHTML, so agent output cannot inject markup or scripts. Links are
// limited to http(s)/mailto.

const SAFE_URL = /^(https?:|mailto:)/i;

// ---------- inline ----------

const INLINE =
  /(`+)([\s\S]*?[^`])\1(?!`)|\*\*([\s\S]+?)\*\*|(?<![\w])__([\s\S]+?)__(?![\w])|~~([\s\S]+?)~~|\*([^*\s](?:[^*]*[^*\s])?)\*|(?<![\w])_([^_\s](?:[^_]*[^_\s])?)_(?![\w])|\[([^\]]+)\]\(([^()\s]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

export function parseInline(src) {
  const out = [];
  let last = 0;
  // Fresh regex per call: parseInline recurses, so a shared lastIndex would break.
  const re = new RegExp(INLINE.source, 'g');
  let m;
  while ((m = re.exec(src))) {
    if (m.index > last) out.push({ t: 'text', v: src.slice(last, m.index) });
    if (m[1]) out.push({ t: 'code', v: m[2].trim() === '' ? m[2] : m[2].replace(/^ (.*) $/s, '$1') });
    else if (m[3] !== undefined || m[4] !== undefined) out.push({ t: 'strong', c: parseInline(m[3] ?? m[4]) });
    else if (m[5] !== undefined) out.push({ t: 'del', c: parseInline(m[5]) });
    else if (m[6] !== undefined || m[7] !== undefined) out.push({ t: 'em', c: parseInline(m[6] ?? m[7]) });
    else if (m[8] !== undefined) {
      if (SAFE_URL.test(m[9])) out.push({ t: 'link', href: m[9], c: parseInline(m[8]) });
      else out.push({ t: 'text', v: m[0] });
    } else if (m[10] !== undefined) out.push({ t: 'link', href: m[10], c: [{ t: 'text', v: m[10] }] });
    last = re.lastIndex;
  }
  if (last < src.length) out.push({ t: 'text', v: src.slice(last) });
  return out;
}

// ---------- blocks ----------

const FENCE = /^\s{0,3}(```+|~~~+)\s*([\w+#.-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const UL = /^\s{0,3}[-*+]\s+(.*)$/;
const OL = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;

export function parse(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    let m;
    if ((m = line.match(FENCE))) {
      const fence = m[1];
      const body = [];
      i++;
      // An unterminated fence (still streaming) swallows the rest as code.
      while (i < lines.length && !lines[i].trim().startsWith(fence)) body.push(lines[i++]);
      i++;
      blocks.push({ t: 'code', lang: m[2] || '', v: body.join('\n') });
      continue;
    }
    if ((m = line.match(HEADING))) {
      blocks.push({ t: 'h', level: m[1].length, c: parseInline(m[2]) });
      i++;
      continue;
    }
    if (HR.test(line)) {
      blocks.push({ t: 'hr' });
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && (m = lines[i].match(QUOTE))) {
        body.push(m[1]);
        i++;
      }
      blocks.push({ t: 'quote', c: parse(body.join('\n')) });
      continue;
    }
    if (UL.test(line) || OL.test(line)) {
      const ordered = !UL.test(line);
      const start = ordered ? Number(line.match(OL)[1]) : 1;
      const re = ordered ? OL : UL;
      const items = [];
      while (i < lines.length) {
        const l = lines[i];
        if ((m = l.match(re))) {
          items.push(ordered ? m[2] : m[1]);
          i++;
        } else if (l.trim() && /^\s{2,}/.test(l) && items.length) {
          // Indented continuation line.
          items[items.length - 1] += ' ' + l.trim();
          i++;
        } else break;
      }
      blocks.push({ t: ordered ? 'ol' : 'ul', start, items: items.map(parseInline) });
      continue;
    }

    // Paragraph: consume until blank line or another block starts.
    const para = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !FENCE.test(lines[i]) &&
      !HEADING.test(lines[i]) &&
      !HR.test(lines[i]) &&
      !QUOTE.test(lines[i]) &&
      !UL.test(lines[i]) &&
      !OL.test(lines[i])
    ) {
      para.push(lines[i++]);
    }
    blocks.push({ t: 'p', c: parseInline(para.join('\n')) });
  }
  return blocks;
}

// ---------- DOM ----------

function inlineToDom(nodes, doc, parent) {
  for (const n of nodes) {
    let el;
    switch (n.t) {
      case 'text':
        // Preserve single newlines inside paragraphs as <br>.
        n.v.split('\n').forEach((part, idx) => {
          if (idx) parent.appendChild(doc.createElement('br'));
          if (part) parent.appendChild(doc.createTextNode(part));
        });
        continue;
      case 'code':
        el = doc.createElement('code');
        el.className = 'md-code';
        el.textContent = n.v;
        break;
      case 'strong':
      case 'em':
      case 'del':
        el = doc.createElement(n.t);
        inlineToDom(n.c, doc, el);
        break;
      case 'link':
        el = doc.createElement('a');
        el.href = n.href;
        el.target = '_blank';
        el.rel = 'noopener noreferrer';
        inlineToDom(n.c, doc, el);
        break;
      default:
        continue;
    }
    parent.appendChild(el);
  }
}

export function toDom(blocks, doc = document) {
  const frag = doc.createDocumentFragment();
  for (const b of blocks) {
    let el;
    switch (b.t) {
      case 'p':
        el = doc.createElement('p');
        inlineToDom(b.c, doc, el);
        break;
      case 'h':
        el = doc.createElement(`h${b.level}`);
        inlineToDom(b.c, doc, el);
        break;
      case 'hr':
        el = doc.createElement('hr');
        break;
      case 'code': {
        el = doc.createElement('pre');
        const code = doc.createElement('code');
        if (b.lang) code.dataset.lang = b.lang;
        code.textContent = b.v;
        el.appendChild(code);
        break;
      }
      case 'quote':
        el = doc.createElement('blockquote');
        el.appendChild(toDom(b.c, doc));
        break;
      case 'ul':
      case 'ol':
        el = doc.createElement(b.t);
        if (b.t === 'ol' && b.start !== 1) el.start = b.start;
        for (const item of b.items) {
          const li = doc.createElement('li');
          inlineToDom(item, doc, li);
          el.appendChild(li);
        }
        break;
      default:
        continue;
    }
    frag.appendChild(el);
  }
  return frag;
}

/** Replace el's children with rendered markdown. */
export function renderInto(el, text) {
  el.replaceChildren(toDom(parse(text), el.ownerDocument));
}
