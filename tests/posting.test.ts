// Job posting text from Crelate comes in many formats; the site must turn each
// into the same layout. Each case below is a format seen in real postings.
import { describe, it, expect } from 'vitest';
import { structurePosting } from '../src/posting';
import { cleanHtml } from '../src/html';

const facts = (raw: string, title = 'Test Job') => structurePosting(raw, title).facts;
const outline = (raw: string, title = 'Test Job') =>
  [...structurePosting(raw, title).html.matchAll(/<(h3|p|ul|ol)>/g)].map((m) => m[1]);

describe('cleanHtml (safety)', () => {
  it('removes scripts, event handlers, links and styles', () => {
    const out = cleanHtml('<p onclick="x()" style="color:red">Hi <a href="http://x">there</a></p><script>alert(1)</script><img src=x onerror=alert(1)>');
    expect(out).not.toMatch(/script|onclick|onerror|href|style|<img|<a/i);
    expect(out).toContain('Hi');
  });
  it('flattens tables into Label: value rows', () => {
    expect(cleanHtml('<table><tr><td>Location</td><td>Durham, NC</td></tr></table>')).toContain('<strong>Location:</strong> Durham, NC');
  });
});

describe('facts row', () => {
  it('reads "Label: value" lines after a repeated title', () => {
    const f = facts('<p><strong>Test Job</strong><br><strong>Location:</strong> Clayton | North Carolina<br><strong>Type:</strong> Contract<br><strong>Duration:</strong> 12 months</p><p>Body text here.</p>');
    expect(f).toEqual([
      { label: 'Location', value: 'Clayton, North Carolina' },
      { label: 'Job Type', value: 'Contract' },
      { label: 'Duration', value: '12 months' },
    ]);
  });
  it('reads bold labels without colons, several in one line', () => {
    const f = facts('<p><strong>Location</strong> Spartanburg, SC <strong>Job Type</strong> Contract <strong>Project Duration</strong> 2–3 years</p><p>Body.</p>');
    expect(f.map((x) => x.label)).toEqual(['Location', 'Job Type', 'Duration']);
    expect(f[2].value).toBe('2–3 years');
  });
  it('reads a label line followed by its value', () => {
    const f = facts('<p><b>Location</b><br>Durham, NC</p><p><b>Job Type</b><br>Contract</p><p>Body.</p>');
    expect(f[0]).toEqual({ label: 'Location', value: 'Durham, NC' });
  });
  it('reads emoji labels and list items', () => {
    expect(facts('<p>📍 Location: Ashburn, VA</p><p>💼 Type: Contract</p><p>Body.</p>')[0].value).toBe('Ashburn, VA');
    expect(facts('<ul><li>Location: Remote</li><li>Type: Contract to hire</li></ul><p>Body.</p>')[1].value).toBe('Contract to hire');
  });
  it('keeps notes in brackets out of the row', () => {
    const f = facts('<p>Location: X<br>Job Type: Contract (client conversion possible based on performance)</p><p>Body.</p>');
    expect(f.find((x) => x.label === 'Job Type')!.value).toBe('Contract');
  });
  it('shows only Location, Job Type, Duration; other details go to the end', () => {
    const r = structurePosting('<p>Location: X<br>Type: Contract<br>Overtime: Available</p><p>Body text.</p>', 'T');
    expect(r.facts.map((x) => x.label)).toEqual(['Location', 'Job Type']);
    expect(r.html).toMatch(/Additional Details<\/h3>\s*<ul><li><strong>Overtime:<\/strong> Available/);
  });
});

describe('posting layout', () => {
  it('drops a generic "Job Description" line, also joined to the title', () => {
    expect(structurePosting('<p><strong>Cable Tech Job Description — Contract Position</strong></p><p>Location: X<br>Type: Y</p><p>Body.</p>', 'Cable Tech').html).not.toMatch(/Job Description/);
  });
  it('shows a short first line as the subtitle', () => {
    const r = structurePosting('<p><strong>Owner’s Rep – CM</strong><br>Location: X<br>Type: Y</p><p>Body text.</p>', 'Construction Manager (CM)');
    expect(r.subtitle).toBe('Owner’s Rep – CM');
  });
  it('turns bold lines into headings and closes a list at a heading inside a bullet', () => {
    const o = outline('<p><strong>What You’ll Do</strong></p><ul><li>One.</li><li><p>Two.</p><p><strong>Schedule</strong></p><p>Mon–Fri.</p><p><strong>Requirements</strong></p></li><li>Three.</li></ul>');
    expect(o).toEqual(['h3', 'ul', 'h3', 'p', 'h3', 'ul']);
  });
  it('makes "•" and "-" lines into lists and starts with a heading', () => {
    const r = structurePosting('<p>Intro sentence for the job.</p><p>• A<br>• B</p>', 'T');
    expect(r.html.startsWith('<h3>About the Role</h3>')).toBe(true);
    expect(r.html).toContain('<ul><li>A</li><li>B</li></ul>');
  });
  it('writes a teaser from real sentences', () => {
    expect(structurePosting('<p>Location: X<br>Type: Y</p><p><strong>About</strong></p><p>We are hiring an engineer for a large project.</p>', 'T').summary).toBe('We are hiring an engineer for a large project.');
  });
});
