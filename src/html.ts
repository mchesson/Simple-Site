// Turns job descriptions from Crelate (rich-text HTML) into safe site content.
// Used on the server only (src/crelate.ts).

const NAMED: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—',
  hellip: '…', bull: '•', middot: '·', trade: '™', reg: '®', copy: '©', deg: '°',
};

/** Decode HTML entities (&rsquo;, &ndash;, &#8217; ...) into plain characters. */
export function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

const escape = (s: string) => s.replace(/&(?!(#x[0-9a-f]+|#\d+|[a-z]+);)/gi, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Plain text, one line per paragraph / list item / line break. */
export function toLines(html: string): string[] {
  const t = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]*>/g, ' ');
  return decode(t).split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

const KEEP: Record<string, string> = {
  p: 'p', div: 'p', br: 'br', ul: 'ul', ol: 'ol', li: 'li',
  strong: 'strong', b: 'strong', em: 'em', i: 'em', u: 'em',
  h1: 'h2', h2: 'h2', h3: 'h3', h4: 'h3', h5: 'h3', h6: 'h3',
};

/** Rebuild the description with a few plain tags and no attributes, so it
 *  takes the site's own styles and can't carry scripts, links or styling. */
export function cleanHtml(html: string): string {
  const src = html.replace(/<(script|style|iframe|object|embed|noscript|head|title)[\s\S]*?<\/\1>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
  let out = '';
  let last = 0;
  for (const m of src.matchAll(/<(\/?)([a-z][a-z0-9]*)\b[^>]*>/gi)) {
    out += escape(src.slice(last, m.index));
    last = m.index! + m[0].length;
    const tag = KEEP[m[2].toLowerCase()];
    if (!tag) { out += ' '; continue; }
    if (tag === 'br') { out += m[1] ? '' : '<br>'; continue; }
    out += `<${m[1]}${tag}>`;
  }
  out += escape(src.slice(last));
  return out
    .replace(/&nbsp;/gi, ' ')
    .replace(/<(p|h2|h3|li|strong|em)>(\s|<br>)*<\/\1>/g, '')
    .replace(/(<br>\s*){3,}/g, '<br><br>')
    .trim();
}

const textOf = (html: string) => toLines(html).join(' ');

/** Tidy a cleaned posting so it reads like the rest of the site: a bold line on
 *  its own ("Responsibilities", "Requirements:") becomes a heading, and stray
 *  line breaks at the edges of paragraphs go. */
export function tidyPosting(html: string): string {
  const heading = (inner: string) => {
    const t = textOf(inner).replace(/:$/, '').trim();
    return t && t.length <= 60 && !/[.!?]$/.test(t) ? `<h3>${escape(t)}</h3>` : null;
  };
  return html
    .replace(/<h2>/g, '<h3>').replace(/<\/h2>/g, '</h3>')
    .replace(/<p>(\s|<br>)+/g, '<p>').replace(/(\s|<br>)+<\/p>/g, '</p>')
    // <p><strong>Heading</strong><br>text</p> → heading + paragraph
    .replace(/<p><strong>([^<]{1,60})<\/strong>\s*<br>/g, (m, h) => (heading(h) ? `${heading(h)}<p>` : m))
    // <p><strong>Heading</strong></p> or <p>Heading:</p> → heading
    .replace(/<p>(<strong>[^<]{1,60}<\/strong>|[^<]{1,60}:)<\/p>/g, (m, inner) => heading(inner) ?? m)
    .replace(/<p><\/p>/g, '');
}

/** Pull the "Location: … / Type: … / Duration: …" lines at the top of a posting
 *  out as facts, so the page can show them as a tidy row. */
export function splitFacts(html: string): { facts: { label: string; value: string }[]; html: string } {
  const facts: { label: string; value: string }[] = [];
  let rest = html;
  for (;;) {
    const m = rest.match(/^\s*<p>([\s\S]*?)<\/p>/);
    if (!m) break;
    const found = m[1].split(/<br>/).map((seg) => textOf(seg).match(/^([A-Za-z][\w /&()-]{1,30}):\s*(.{1,160})$/));
    if (!found.length || found.some((x) => !x)) break;
    for (const x of found) {
      const label = x![1].trim();
      facts.push({ label, value: x![2].replace(/\s*\|\s*/g, /location/i.test(label) ? ', ' : ' · ').trim() });
    }
    rest = rest.slice(m[0].length);
  }
  return { facts, html: rest.trim() };
}
