// Turns a Crelate job posting (rich text typed by recruiters, formatted in
// many different ways) into the site's own layout:
//   facts    "Location: …", "Type: …", "Duration: …" lines → a row of labels
//   html     headings, paragraphs and lists with even spacing
//   summary  a short teaser for the job list
// Works on the output of cleanHtml (src/html.ts), which is already reduced to
// p, br, ul, ol, li, strong, em, h2, h3 with no attributes. Server only.
import { parse, NodeType, type HTMLElement, type Node } from 'node-html-parser';
import { cleanHtml, decode } from './html';

type Block = { kind: 'p' | 'h' | 'list'; html: string; text: string; ordered?: boolean; items?: string[] };
export type Fact = { label: string; value: string };

const INLINE = new Set(['strong', 'em']);
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const textOf = (n: Node) => squash(decode(n.rawText ?? ''));
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// "Location: Clayton | NC", "📍 Job Type – Contract", "Duration: 12 months"
const FACT = /^[^A-Za-z0-9]{0,3}\s*([A-Za-z][A-Za-z /&()'-]{1,28}?)\s*[:：]\s*(\S.{0,150})$/;
const BULLET = /^\s*[•·▪◦●○■□➤►▶✓✔\-–—*]\s+/;

/** Split inline content into lines at <br>, keeping bold/italic markup. */
function lines(nodes: Node[]): { html: string; text: string; boldOnly: boolean }[] {
  const out: { html: string; text: string; boldOnly: boolean }[] = [];
  let html = '', plain = '', bold = '';
  const flush = () => {
    const text = squash(decode(plain));
    if (text) out.push({ html: squash(html), text, boldOnly: squash(decode(bold)) === text });
    html = plain = bold = '';
  };
  const walk = (n: Node, inBold: boolean) => {
    if (n.nodeType === NodeType.TEXT_NODE) {
      html += n.rawText; plain += n.rawText; if (inBold) bold += n.rawText;
      return;
    }
    const el = n as HTMLElement;
    const tag = el.rawTagName?.toLowerCase();
    if (tag === 'br') return flush();
    if (tag && INLINE.has(tag)) {
      html += `<${tag}>`;
      el.childNodes.forEach((c) => walk(c, inBold || tag === 'strong'));
      html += `</${tag}>`;
      return;
    }
    el.childNodes.forEach((c) => walk(c, inBold));
  };
  nodes.forEach((n) => walk(n, false));
  flush();
  return out;
}

/** Flatten the posting into a list of blocks. */
function blocks(html: string): Block[] {
  const root = parse(html);
  const out: Block[] = [];
  let pending: Node[] = [];
  const addLines = (nodes: Node[]) => {
    for (const l of lines(nodes)) {
      // A bold line on its own, or a short line ending in ":", is a heading.
      const heading = l.text.length <= 70 && !/[.!?]$/.test(l.text) && (l.boldOnly || /:$/.test(l.text)) && !FACT.test(l.text);
      if (heading) out.push({ kind: 'h', html: esc(l.text.replace(/\s*:$/, '')), text: l.text.replace(/\s*:$/, '') });
      else if (BULLET.test(l.text)) {
        const item = l.html.replace(BULLET, '').replace(/^(<\w+>)\s*[•·▪◦●○■□➤►▶✓✔\-–—*]\s+/, '$1');
        const last = out[out.length - 1];
        if (last?.kind === 'list' && !last.ordered) { last.items!.push(item); last.text += ' ' + l.text; }
        else out.push({ kind: 'list', html: '', text: l.text, items: [item] });
      } else out.push({ kind: 'p', html: l.html, text: l.text });
    }
  };
  const flushPending = () => { if (pending.length) addLines(pending); pending = []; };
  for (const n of root.childNodes) {
    const tag = n.nodeType === NodeType.ELEMENT_NODE ? (n as HTMLElement).rawTagName?.toLowerCase() : '';
    if (tag === 'p') { flushPending(); addLines((n as HTMLElement).childNodes); }
    else if (tag === 'h2' || tag === 'h3') {
      flushPending();
      const t = textOf(n).replace(/\s*:$/, '');
      if (t) out.push({ kind: 'h', html: esc(t), text: t });
    } else if (tag === 'ul' || tag === 'ol') {
      flushPending();
      const items = (n as HTMLElement).querySelectorAll('li')
        .map((li) => lines(li.childNodes).map((l) => l.html.replace(BULLET, '')).join(' '))
        .filter((s) => squash(s.replace(/<[^>]+>/g, '')));
      if (items.length) out.push({ kind: 'list', html: '', text: textOf(n), ordered: tag === 'ol', items });
    } else pending.push(n); // loose text, <strong>, <br> between blocks
  }
  flushPending();
  return out;
}

const factOf = (text: string): Fact | null => {
  const m = text.match(FACT);
  if (!m) return null;
  const label = m[1].trim();
  // Sentences that happen to contain a colon aren't facts.
  if (label.split(' ').length > 4) return null;
  return { label, value: m[2].replace(/\s*\|\s*/g, /location/i.test(label) ? ', ' : ' · ').trim() };
};

export function structurePosting(raw: string, title: string): { facts: Fact[]; html: string; summary: string } {
  let list = blocks(cleanHtml(raw));
  // The posting often repeats the job title as its first line.
  const t = norm(title);
  list = list.filter((b, i) => !(i < 3 && (norm(b.text) === t || (b.kind !== 'list' && norm(b.text).startsWith(t) && b.text.length < title.length + 25))));

  // Facts: the first run of "Label: value" lines (or list items) near the top,
  // with a heading just before it ("Job Details") dropped too.
  const facts: Fact[] = [];
  for (let i = 0; i < Math.min(list.length, 8); i++) {
    const b = list[i];
    const run: Fact[] = [];
    let j = i;
    if (b.kind === 'list') {
      const fs = b.items!.map((it) => factOf(squash(decode(it.replace(/<[^>]+>/g, ' ')))));
      if (fs.length >= 2 && fs.every(Boolean)) { run.push(...(fs as Fact[])); j = i + 1; }
    } else {
      while (j < list.length && list[j].kind === 'p' && factOf(list[j].text)) run.push(factOf(list[j++].text)!);
    }
    if (run.length >= 2) {
      facts.push(...run);
      const start = i > 0 && list[i - 1].kind === 'h' && i - 1 < 2 ? i - 1 : i;
      list.splice(start, j - start);
      break;
    }
  }

  const html = list
    .map((b) => (b.kind === 'h' ? `<h3>${b.html}</h3>` : b.kind === 'p' ? `<p>${b.html}</p>` : `<${b.ordered ? 'ol' : 'ul'}>${b.items!.map((it) => `<li>${it}</li>`).join('')}</${b.ordered ? 'ol' : 'ul'}>`))
    .join('\n');

  // Teaser: the first real paragraphs, not headings or leftover "Label: value" lines.
  const teaser = list.filter((b) => b.kind === 'p' && !factOf(b.text) && b.text.length >= 40).map((b) => b.text).join(' ');
  const source = teaser || list.map((b) => b.text).join(' ');
  const summary = source.length > 220 ? source.slice(0, 217).replace(/\s+\S*$/, '') + '…' : source;
  return { facts, html, summary };
}
