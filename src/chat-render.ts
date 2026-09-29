// Turns the chat assistant's answers into safe HTML (src/scripts/chat.ts).
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** The assistant's simple Markdown: paragraphs, "- " lists, **bold** and
 *  links to pages on this site (or our LinkedIn). Everything else is text. */
export function render(md: string): string {
  const inline = (s: string) =>
    esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, href) => {
        const url = href.replace(/&amp;/g, '&');
        const ok = /^\/(?!\/)/.test(url) || /^https:\/\/(www\.)?linkedin\.com\//.test(url) || /^mailto:[^@\s]+@technicalsource\.com$/.test(url);
        return ok ? `<a href="${esc(url)}"${url.startsWith('http') ? ' rel="noopener" target="_blank"' : ''}>${text}</a>` : text;
      });
  const out: string[] = [];
  let list: string[] = [];
  const flush = () => { if (list.length) out.push(`<ul>${list.map((l) => `<li>${l}</li>`).join('')}</ul>`); list = []; };
  for (const block of md.split(/\n{2,}/)) {
    const lines = block.split('\n');
    const para: string[] = [];
    for (const line of lines) {
      const m = line.match(/^\s*(?:[-*•]|\d+\.)\s+(.*)$/);
      if (m) { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para.length = 0; } list.push(inline(m[1])); }
      else if (line.trim()) { flush(); para.push(line); }
    }
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    flush();
  }
  return out.join('');
}
