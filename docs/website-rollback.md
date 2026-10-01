# Going Back to the Old Website (WordPress)

If the new site on technicalsource.com breaks, this puts the old WordPress
site back. It changes only the two **website** records at GoDaddy. Email
(Microsoft 365) is never touched, before, during or after.

## Saved before the switch (read Oct 1, 2026 through Vercel's domain check)
| Record | Type | Old value (WordPress) | New value (Vercel) |
|---|---|---|---|
| `@` (technicalsource.com) | A | `51.161.116.70` | `216.150.1.1` and `216.150.16.1` (two A records) |
| `www` | CNAME | `technicalsource.com` (points at `@`) | `45d2f71ac51bfe29.vercel-dns-016.com` |

If Vercel's newer addresses ever give trouble, its older single address
`76.76.21.21` (A) and `cname.vercel-dns.com` (CNAME) also work.

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
2. Find the **Type A, Name `@`** record(s). Delete the second one if there
   are two, then edit the remaining one (pencil icon) so **Value** is
   `51.161.116.70`. Save.
3. Find the **Name `www`** record (CNAME). Edit **Value** back to
   `technicalsource.com` (GoDaddy may show it as `@`). Save.
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
