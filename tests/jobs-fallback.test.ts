import { describe, it, expect, vi } from 'vitest';
import { withFallback, parseSnapshot, type Saved } from '../src/jobs-fallback';
import type { PublicJob } from '../src/crelate';

const job = (id: string): PublicJob => ({ id, title: `Job ${id}`, city: 'Durham', state: 'NC', zip: '27701', summary: '', description: '', subtitle: '', facts: [], slug: '', postedOn: '' });
const down = () => Promise.reject(new Error('403 ApiAccessDisabled'));

function store(initial: Saved | null = null, snap: Saved | null = null) {
  let mem = initial;
  return { memory: () => mem, remember: (s: Saved) => { mem = s; }, snapshot: vi.fn(async () => snap) };
}

describe('withFallback', () => {
  it('uses Crelate when it answers, and remembers the list', async () => {
    const s = store();
    const out = await withFallback(async () => [job('a')], s, () => 'T1');
    expect(out).toEqual({ jobs: [job('a')], savedAt: null });
    expect(s.memory()).toEqual({ at: 'T1', jobs: [job('a')] });
  });
  it('when Crelate fails, shows the list this server read last', async () => {
    const s = store({ at: 'T0', jobs: [job('a')] }, { at: 'B', jobs: [job('b')] });
    const out = await withFallback(down, s);
    expect(out).toEqual({ jobs: [job('a')], savedAt: 'T0' });
    expect(s.snapshot).not.toHaveBeenCalled();
  });
  it('else the build snapshot', async () => {
    const out = await withFallback(down, store(null, { at: 'B', jobs: [job('b')] }));
    expect(out).toEqual({ jobs: [job('b')], savedAt: 'B' });
  });
  it('with nothing saved, the error goes on (the page shows the portal link)', async () => {
    await expect(withFallback(down, store())).rejects.toThrow('ApiAccessDisabled');
  });
  it('a snapshot that cannot be read counts as nothing saved', async () => {
    const s = store(); s.snapshot.mockRejectedValueOnce(new Error('timeout'));
    await expect(withFallback(down, s)).rejects.toThrow('ApiAccessDisabled');
  });
});

describe('parseSnapshot', () => {
  it('reads a saved list and drops anything that is not a job', () => {
    expect(parseSnapshot({ at: 'B', jobs: [job('a'), { title: '' }, null] })).toEqual({ at: 'B', jobs: [job('a')] });
  });
  it('an empty or broken snapshot is null', () => {
    expect(parseSnapshot({ at: 'B', jobs: [] })).toBeNull();
    expect(parseSnapshot({ jobs: [job('a')] })).toBeNull();
    expect(parseSnapshot(null)).toBeNull();
  });
});
