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
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// "Location: Clayton | NC", "📍 Job Type – Contract", "Duration: 12 months"
const FACT = /^[^A-Za-z0-9]{0,3}\s*([A-Za-z][A-Za-z /&()'-]{1,28}?)\s*[:：]\s*(\S.{0,150})$/;
const BULLET = /^\s*[•·▪◦●○■□➤►▶✓✔\-–—*]\s+/;

type Line = { kind: 'line'; html: string; text: string; boldOnly: boolean; heading?: boolean };
type ListSeg = { kind: 'listnode'; el: HTMLElement };
type Seg = Line | ListSeg;

/** Walk a node into lines (split at <br> and at paragraph/heading/list-item
 *  edges, keeping bold/italic markup) and nested lists. */
function segments(nodes: Node[]): Seg[] {
  const out: Seg[] = [];
  let html = '', plain = '', bold = '';
  const flush = (heading = false) => {
    const text = squash(decode(plain));
    if (text) out.push({ kind: 'line', html: squash(html), text, boldOnly: squash(decode(bold)) === text, heading });
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
    if (tag === 'ul' || tag === 'ol') { flush(); out.push({ kind: 'listnode', el }); return; }
    if (tag === 'h2' || tag === 'h3') { flush(); el.childNodes.forEach((c) => walk(c, inBold)); flush(true); return; }
    if (tag === 'p' || tag === 'li') { flush(); el.childNodes.forEach((c) => walk(c, inBold)); flush(); return; }
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

// A heading: an <h> tag, a bold line on its own, or a short line ending in ":".
const isHeading = (l: Line) =>
  l.heading || (l.text.length <= 70 && !/[.!?]$/.test(l.text) && (l.boldOnly || /:$/.test(l.text)) && !FACT.test(l.text));

/** Flatten the posting into a list of blocks. */
function blocks(html: string): Block[] {
  const out: Block[] = [];
  const pushItem = (item: string, text: string, ordered: boolean) => {
    const last = out[out.length - 1];
    if (last?.kind === 'list' && !!last.ordered === ordered) { last.items!.push(item); last.text += ' ' + text; }
    else out.push({ kind: 'list', html: '', text, ordered, items: [item] });
  };
  const addLine = (l: Line): void => {
    // Several bold labels in one line ("<b>Location</b> X <b>Job Type</b> Y"):
    // one line per label.
    const starts = [...l.html.matchAll(BOLD_LABEL)].map((m) => m.index!);
    if (starts.length >= 2) {
      const cuts = squash(l.html.slice(0, starts[0]).replace(/<[^>]+>/g, '')) ? [0, ...starts] : [0, ...starts.slice(1)];
      cuts.map((s, i) => l.html.slice(s, cuts[i + 1])).forEach((h) => {
        const text = squash(decode(h.replace(/<[^>]+>/g, ' ')));
        if (text) addLine({ kind: 'line', html: squash(h), text, boldOnly: false });
      });
      return;
    }
    if (isHeading(l)) {
      const t = l.text.replace(/\s*:$/, '');
      out.push({ kind: 'h', html: esc(t), text: t });
    } else if (BULLET.test(l.text)) {
      pushItem(l.html.replace(BULLET, '').replace(/^(<\w+>)\s*[•·▪◦●○■□➤►▶✓✔\-–—*]\s+/, '$1'), l.text, false);
    } else out.push({ kind: 'p', html: l.html, text: l.text });
  };
  const addList = (el: HTMLElement) => {
    const ordered = el.rawTagName?.toLowerCase() === 'ol';
    for (const li of el.childNodes) {
      const tag = li.nodeType === NodeType.ELEMENT_NODE ? (li as HTMLElement).rawTagName?.toLowerCase() : '';
      const segs = tag === 'li' ? segments((li as HTMLElement).childNodes) : segments([li]);
      // The item is its text up to the first heading. Crelate's editor often
      // keeps whatever was typed after the last bullet ("Schedule", "Requirements"
      // and their text) inside that bullet: those become normal blocks again.
      const parts: string[] = [];
      const texts: string[] = [];
      let rest: Seg[] | null = null;
      for (const sg of segs) {
        if (rest) { rest.push(sg); continue; }
        if (sg.kind === 'listnode') { if (parts.length) { pushItem(parts.join(' '), texts.join(' '), ordered); parts.length = texts.length = 0; } addList(sg.el); continue; }
        if (parts.length && isHeading(sg)) { rest = [sg]; continue; }
        parts.push(sg.html.replace(BULLET, ''));
        texts.push(sg.text);
      }
      if (parts.length) pushItem(parts.join(' '), texts.join(' '), ordered);
      if (rest) rest.forEach((sg) => (sg.kind === 'listnode' ? addList(sg.el) : addLine(sg)));
    }
  };
  for (const sg of segments(parse(html).childNodes)) sg.kind === 'listnode' ? addList(sg.el) : addLine(sg);
  // Lists split by an empty line in the editor read as one list.
  return out.reduce<Block[]>((acc, b) => {
    const last = acc[acc.length - 1];
    if (b.kind === 'list' && last?.kind === 'list' && !!last.ordered === !!b.ordered) {
      last.items!.push(...b.items!);
      last.text += ' ' + b.text;
    } else acc.push(b);
    return acc;
  }, []);
}

// Detail labels recruiters use, recognised even without a colon
// ("Location Spartanburg, SC", "Duration – 12 months").
const LABELS = 'Location|Work Location|Job Location|Job Type|Type|Employment Type|Position Type|Contract Type|Duration|Project Duration|Contract Length|Length|Schedule|Shift|Hours|Work Schedule|Overtime|Pay|Pay Rate|Rate|Compensation|Salary|Start Date|Start|Travel|Per Diem|Work Setting|Work Arrangement|Clearance|Industry';
const BARE_FACT = new RegExp(`^[^A-Za-z0-9]{0,3}\\s*(${LABELS})\\s*(?:[-–—|]\\s*)?(\\S.{0,150})$`, 'i');
const BOLD_LABEL = new RegExp(`<strong>\\s*(?:${LABELS})\\s*:?\\s*</strong>`, 'gi');

// The facts row: these three, in this order, under these names.
const TOP_FACTS: [string, RegExp][] = [
  ['Location', /location/i],
  ['Job Type', /^(job |employment |position |contract )?type$/i],
  ['Duration', /duration|length/i],
];

const factOf = (text: string): Fact | null => {
  const m = text.match(FACT) ?? text.match(BARE_FACT);
  if (!m) return null;
  const label = m[1].trim();
  // Sentences that happen to contain a colon aren't facts.
  if (label.split(' ').length > 4) return null;
  // Notes in brackets ("Contract (client conversion possible...)") stay out of
  // the facts row: it shows the plain detail only.
  const value = m[2].replace(/\s*\|\s*/g, /location/i.test(label) ? ', ' : ' · ').trim();
  return { label, value: value.replace(/\s*\([^)]*\)/g, '').replace(/\s*[·,]\s*$/, '').trim() || value };
};

export function structurePosting(raw: string, title: string): { facts: Fact[]; html: string; summary: string; subtitle: string } {
  let list = blocks(cleanHtml(raw));
  // The posting often repeats the job title as its first line.
  const t = norm(title);
  list = list.filter((b, i) => !(i < 3 && (norm(b.text) === t || (b.kind !== 'list' && norm(b.text).startsWith(t + ' ') && b.text.length < title.length + 25))));
  // Generic labels near the top ("Job Description — Contract Position",
  // also run together with the title) add nothing.
  list = list.filter((b, i) => !(i < 4 && b.kind !== 'list' && b.text.length <= 100 && /\b(job|position) description\b/i.test(b.text)));

  // A short first line that isn't a sentence is a subtitle ("Owner's
  // Representative – Construction Manager (Pharmaceutical Projects)"): shown
  // under the title in the banner rather than as the first paragraph.
  let subtitle = '';
  if (list[0] && list[0].kind !== 'list' && list[0].text.length <= 120 && !/[.!?]$/.test(list[0].text) && !factOf(list[0].text)) {
    subtitle = list[0].text;
    if (list[0].kind === 'p') list = list.slice(1);
  }

  // Facts: the first run of "Label: value" lines (or list items) near the top,
  // with a heading just before it ("Job Details") dropped too.
  const facts: Fact[] = [];
  let extra: Fact[] = [];
  for (let i = 0; i < Math.min(list.length, 8); i++) {
    const b = list[i];
    const run: Fact[] = [];
    let j = i;
    if (b.kind === 'list') {
      const fs = b.items!.map((it) => factOf(squash(decode(it.replace(/<[^>]+>/g, ' ')))));
      if (fs.length >= 2 && fs.every(Boolean)) { run.push(...(fs as Fact[])); j = i + 1; }
    } else {
      const LABEL_ONLY = new RegExp(`^(${LABELS})$`, 'i');
      for (;;) {
        const cur = list[j];
        if (cur?.kind === 'p' && factOf(cur.text)) { run.push(factOf(cur.text)!); j++; continue; }
        // "Location" on its own line, the value on the next one.
        const next = list[j + 1];
        if (cur && cur.kind !== 'list' && LABEL_ONLY.test(cur.text.replace(/:$/, '').trim()) && next?.kind === 'p' && next.text.length <= 160) {
          const f = factOf(`${cur.text.replace(/:$/, '').trim()}: ${next.text}`);
          if (f) { run.push(f); j += 2; continue; }
        }
        break;
      }
    }
    if (run.length >= 2) {
      // The row shows Location, Job Type and Duration only (owner's choice);
      // other details (Overtime, Schedule, Pay...) go back into the text.
      const shown = TOP_FACTS.map(([name, re]) => {
        const f = run.find((x) => re.test(x.label));
        return f ? { label: name, value: f.value } : null;
      }).filter(Boolean) as Fact[];
      const others = run.filter((x) => !TOP_FACTS.some(([, re]) => re.test(x.label)));
      facts.push(...shown);
      const start = i > 0 && list[i - 1].kind === 'h' && i - 1 < 2 ? i - 1 : i;
      list.splice(start, j - start);
      extra = others;
      break;
    }
  }

  // Every posting opens with a heading, like the others.
  if (list[0] && list[0].kind !== 'h') list.unshift({ kind: 'h', html: 'About the Role', text: 'About the Role' });
  // Other details from the top (Overtime, Schedule...) close the posting.
  if (extra.length) {
    list.push({ kind: 'h', html: 'Additional Details', text: 'Additional Details' });
    list.push({ kind: 'list', html: '', text: extra.map((x) => `${x.label}: ${x.value}`).join(' '), items: extra.map((x) => `<strong>${esc(x.label)}:</strong> ${esc(x.value)}`) });
  }

  const html = list
    .map((b) => (b.kind === 'h' ? `<h3>${b.html}</h3>` : b.kind === 'p' ? `<p>${b.html}</p>` : `<${b.ordered ? 'ol' : 'ul'}>${b.items!.map((it) => `<li>${it}</li>`).join('')}</${b.ordered ? 'ol' : 'ul'}>`))
    .join('\n');

  // Teaser: the first real paragraphs, not headings or leftover "Label: value" lines.
  const teaser = list.filter((b) => b.kind === 'p' && !factOf(b.text) && b.text.length >= 40).map((b) => b.text).join(' ');
  const source = teaser || list.map((b) => b.text).join(' ');
  const summary = source.length > 220 ? source.slice(0, 217).replace(/\s+\S*$/, '') + '…' : source;
  return { facts, html, summary, subtitle };
}
