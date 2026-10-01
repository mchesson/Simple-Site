# Going Back to the Old Website (WordPress)

If the new site on technicalsource.com breaks, this puts the old WordPress
site back. It changes only the two **website** records at GoDaddy. Email
(Microsoft 365) is never touched, before, during or after.

## Saved before the switch (fill in from the owner's GoDaddy screenshots)
| Record | Type | Old value (WordPress) | New value (Vercel) |
|---|---|---|---|
| `@` (technicalsource.com) | A | _from screenshot_ | _from Vercel_ |
| `www` | CNAME or A | _from screenshot_ | _from Vercel_ |

Also kept: the WordPress backup file (owner's OneDrive), and the full list of
every DNS record as screenshots. WordPress hosting stays paid and untouched
for at least a month after the switch.

## Option 1: only the newest version of the new site is broken (1 minute)
Nothing at GoDaddy changes.
1. Go to vercel.com and sign in, team **TS Website**, project **simple-site**.
2. Click **Deployments**.
3. Find the last version that worked (marked Ready, before the problem).
4. Click the **⋯** menu on it, then **Promote** (or **Instant Rollback**),
   and confirm.
The site is back to that version within a minute. Claude can also do this.

## Option 2: go back to WordPress completely (5–15 minutes)
1. Sign in to **godaddy.com** → **My Products** → **technicalsource.com** →
   **DNS** (Manage DNS).
2. Find the record **Type A, Name `@`**. Click the pencil (Edit). Change
   **Value** to the old WordPress value in the table above. Save.
3. Find the record **Name `www`**. Edit it back to the old value and the old
   type from the table (if it was a CNAME, it goes back to a CNAME). Save.
4. **Do not change anything else**: no MX, TXT, SPF, DKIM, DMARC,
   autodiscover or `_vercel` records.
5. Wait 5–15 minutes (the TTL was lowered to 5 minutes before the switch).
   Open technicalsource.com in a private browser window: the WordPress site
   should be back. If the browser warns about the certificate, wait up to an
   hour while the WordPress host re-issues it.
6. Tell Claude. Claude then turns search-engine indexing off on the new site
   (`ALLOW_INDEXING`) so Google doesn't see two sites, and checks that the
   website's forms (which send to email, Crelate and TS Workspace) are no
   longer in use.

## What keeps working either way
- Email: never touched.
- TS Workspace (tsworkspace.com): separate domain, unaffected.
- Crelate's own job portal: unaffected.
- The new site stays available at https://simple-site-gules.vercel.app for
  testing while we fix it.
