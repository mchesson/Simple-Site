// The Refer Someone form (/refer, endpoint /api/refer): its "How do you know
// us?" choices and the LinkedIn check, shared by the page and the endpoint.
// The ids are the values TS Workspace accepts (its docs/website-intake.md).
import type { ReferrerRelationship } from './ats';

/** How the referrer knows us, in the visitor's words. */
export const RELATIONSHIPS: Record<ReferrerRelationship, string> = {
  contractor: 'I work with Technical Source now (contractor)',
  former_contractor: 'I used to work with Technical Source (former contractor)',
  client: 'I’m a client',
  other: 'Other',
};

/** Only LinkedIn addresses are passed on ("linkedin.com/in/x" gets https:// added); anything else gives ''. */
export function linkedinUrl(v: string): string {
  if (!v) return '';
  try {
    const u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
    return /^https?:$/.test(u.protocol) && /(^|\.)linkedin\.com$/i.test(u.hostname) ? u.toString() : '';
  } catch {
    return '';
  }
}
