// Turns job descriptions from Crelate (rich-text HTML) into safe site content.
// Used on the server only (src/crelate.ts).

/** JSON for a <script type="application/ld+json"> block. Every "<" is written
 *  as < (still the same JSON), so a job title or story title containing
 *  "</script>" can never end the block and run as page script. */
export const jsonLd = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');

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
/** Tables and definition lists (used for "Location | Spartanburg, SC" style
 *  job details) become one paragraph per row: "Label: value". */
function flattenTables(html: string): string {
  const cells = (row: string) => [...row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => m[1].trim()).filter((c) => c.replace(/<[^>]+>|&nbsp;|\s/gi, ''));
  const label = (c: string) => (/:\s*(<\/\w+>\s*)*$/.test(c) ? c : `${c}:`);
  return html
    .replace(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi, (_, row) => {
      const c = cells(row);
      if (!c.length) return '';
      return `<p>${c.length === 2 ? `<strong>${label(c[0])}</strong> ${c[1]}` : c.join(' · ')}</p>`;
    })
    .replace(/<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi, (_, a, b) => `<p><strong>${label(a.trim())}</strong> ${b.trim()}</p>`);
}

export function cleanHtml(html: string): string {
  const src = flattenTables(html.replace(/<(script|style|iframe|object|embed|noscript|head|title)[\s\S]*?<\/\1>/gi, '').replace(/<!--[\s\S]*?-->/g, ''));
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
