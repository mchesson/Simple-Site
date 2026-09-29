// Privacy: only public posting fields may leave Crelate. Internal fields hold
// client and recruiter names and must never reach the website.
import { describe, it, expect } from 'vitest';
import { toPublicJob, isPublished, idOf } from '../src/crelate';

const job = {
  Id: '0b6c1d2e-1111-4a2b-9c3d-123456789abc', OnPortal: true, PortalVisibility: 0,
  PortalTitle: 'Reliability Engineer', PortalCity: 'Wilson', PortalState: 'NC', PortalZip: '27893',
  PortalDescription: '<p>Location: Wilson, NC<br>Job Type: 12 Month Contract with potential extension</p><p>We need a reliability engineer.</p>',
  JobTypeIds: [{ Id: 'x', Title: 'Contract' }],
  // Internal fields that must never appear:
  Name: 'SECRET CLIENT - Reliability Eng (Jane Recruiter)', Description: 'Internal notes about SECRET CLIENT',
  PortalCompanyName: 'SECRET CLIENT', RecruiterId: { Title: 'Jane Recruiter' }, PayRate: 99,
};

describe('toPublicJob', () => {
  it('never includes internal fields', () => {
    const out = JSON.stringify(toPublicJob(job));
    expect(out).not.toMatch(/SECRET|Jane Recruiter|99/);
  });
  it('splits a duration out of the Job Type line', () => {
    const f = toPublicJob(job).facts;
    expect(f).toEqual([
      { label: 'Location', value: 'Wilson, NC' },
      { label: 'Job Type', value: 'Contract' },
      { label: 'Duration', value: '12 Month Contract with potential extension' },
    ]);
  });
  it('fills Location and Job Type from Crelate fields and leaves missing details blank', () => {
    const f = toPublicJob({ ...job, PortalDescription: '<p>Plain text only.</p>' }).facts;
    expect(f).toEqual([
      { label: 'Location', value: 'Wilson, NC' },
      { label: 'Job Type', value: 'Contract' },
      { label: 'Duration', value: '' },
    ]);
  });
  it('decodes entities in titles', () => {
    expect(toPublicJob({ ...job, PortalTitle: 'Owner&rsquo;s Rep &ndash; CM' }).title).toBe('Owner’s Rep – CM');
  });
});

describe('isPublished', () => {
  it('keeps only live portal jobs', () => {
    expect(isPublished(job)).toBe(true);
    expect(isPublished({ ...job, OnPortal: false })).toBe(false);
    expect(isPublished({ ...job, IsHidden: true })).toBe(false);
    expect(isPublished({ ...job, IsOnHold: true })).toBe(false);
    expect(isPublished({ ...job, ClosedOn: '2026-01-01' })).toBe(false);
    expect(isPublished({ ...job, PortalTitle: '' })).toBe(false);
  });
});

describe('idOf', () => {
  it('reads the id Crelate returns from create calls', () => {
    expect(idOf({ Data: 'abc', Errors: [] })).toBe('abc');
    expect(idOf({ Data: { Id: 'def' } })).toBe('def');
  });
});
