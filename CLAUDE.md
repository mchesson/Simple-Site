# Technical Source website

Marketing site for Technical Source. There is no in-house developer: the site is
built and maintained through Claude sessions, so keep things simple, documented
and consistent with this file.

## Stack
- **Astro 7**, static output. `npm run dev` (local), `npm run build` (to `dist/`).
- Content lives in the repo as Markdown. No database, no server.
- Fonts are self-hosted via `@fontsource-variable` (Vollkorn, Open Sans).
- Hosted on Vercel with `@astrojs/vercel`: pages are static; `src/pages/api/`
  endpoints run as Vercel functions.
- Planned: a Git-based CMS (e.g. TinaCMS) for non-technical editors.

## Pages
| URL | File | Notes |
|---|---|---|
| `/` | `src/pages/index.astro` | Banner (who we are) → Services → How we work → Where we work → Why → Insights → Careers strip → CTA |
| `/company` | `src/pages/company.astro` | Who we are, commitments, values, locations (`#locations`) |
| `/services` | `src/pages/services.astro` | The three services, from `services` in `src/data/site.ts` |
| `/industries`, `/industries/<id>` | `src/pages/industries/` | Generated from `src/content/industries/` |
| `/insights`, `/insights/<id>` | `src/pages/insights/` | Stories, filterable by industry; RSS feeds |
| `/careers` | `src/pages/careers.astro` | Kept low-key; job search in site style (`#jobs`); "Not Looking Right Now?" resume form |
| `/careers/jobs/<title>-<id>` | `src/pages/careers/jobs/[id].astro` | One job in site style, rendered on request from Crelate, with its application form (`#apply`) |
| `/contact` | `src/pages/contact.astro` | Form emails the team inbox and files in Crelate |

Old WordPress URLs redirect via `redirects` in `astro.config.mjs`.

## Industries: one file each
- Each industry is a Markdown file in `src/content/industries/` (schema in
  `src/content.config.ts`). The file name is the URL: `data-centers.md` becomes
  `/industries/data-centers`.
- **To add an industry, copy an existing file and edit it.** It then appears
  automatically in the header menu, mobile menu, "Where we work" row, Industries
  page, footer, form dropdowns, Insights filters and RSS feeds. No code changes.
- `order` sets its position; `highlight` is the part of `headline` shown in green;
  `color` must be a brand color. `draft: true` hides it from the live site.
- `src/scripts/industry.ts` remembers the visitor's industry (`?industry=<id>`,
  an industry-page visit, or localStorage) and quietly tailors shared pages:
  "Your industry" tag in industry lists, their stories first, and form
  preselection. Industry-specific links (LinkedIn posts, emails, ads, QR codes)
  should point to the industry page or carry `?industry=<id>`.

## Stories (news, insights, case studies)
- One Markdown file per story in `src/content/stories/`. Frontmatter:
  - `industry`: an industry file name; leave it out for company-wide news
  - `type`: `company-news` | `insight` | `case-study` | `spotlight` | `event`
  - `audience`: any of `clients`, `candidates`, `consultants`, `partners`
  - `linkedin`: ready-to-post copy; the story page has a "Copy LinkedIn Post" button
  - `anonymized: true` when client details are withheld for confidentiality
  - `sample: true` marks prototype content (shows a "Sample" label); replace before launch
  - `draft: true` hides the story from production builds
- Stories appear on their industry page, the homepage, `/insights` and in RSS:
  `/insights/rss.xml`, `/insights/<industry-id>/rss.xml`, `/insights/company/rss.xml`.
- Naming client companies or consultants requires written approval.

## Positioning (internal reference, never site wording)
Source: the confidential "Defining Our Lane" strategy deck (June 2026).
- Technical Source supports complex, project-based work in technically demanding
  industries. Company is in its 11th year: say "more than a decade".
- Current industries: life sciences (pharma manufacturing), data centers & AI
  infrastructure, enterprise technology (AI integration and security).
  Government services, commodity IT, general construction and pure perm/exec
  search are not marketed.
- Buyers are project owners (project VPs, engineering directors, professional
  services leaders), not HR or procurement.
- Services shown publicly: Project Support, Managed Project Teams, Scoped Project
  Work, as approved. Don't expand claims about the last two without leadership sign-off.
- Never publish from the deck: client-fit filters, yes/no lists, the approval
  process, recruiting tiers or SLAs, roadmap dates, revenue/margin statements.

## Voice
- The strategy deck and other internal documents explain what we do; they are
  never a source of site wording. Write as we would speak to a customer.
- Don't expose internal thinking (e.g. "we add industries as needs grow", lane
  criteria, growth plans).
- Keep the homepage banner general: no list of industries there. Industry detail
  lives in the Industries row and pages.
- Lead with the projects we help deliver; keep recruiting and talent language
  subtle (careers are reachable, never the headline).
- Don't commit to things we don't do today (e.g. owning turnover packages or
  outcomes). "How we work" steps must be true for every service; "Hand Off" says
  we *help plan* the transition, nothing more.
- Capitalization: Title Case for headings, card titles, labels, industry `short`
  lines, expertise items and story titles ("Pharmaceutical and Biotech
  Manufacturing"; small words like and/of/the/to stay lowercase). Full sentences
  ending in a period (banner headlines, statements, paragraphs, sentence-like
  bullets) stay in sentence case.
- Plain, confident, specific. No staffing clichés ("best-in-class", "top talent",
  "fill seats").
- Tagline: **Connecting Talent. Delivering Excellence.** The old tagline "The Right
  People. The Right Opportunity." is retired.

## Contact details and locations
- **No phone numbers anywhere on the site** (owner's request). Use the contact
  form and `site.email` in `src/data/site.ts`.
- **Don't mention Raleigh, North Carolina or any headquarters/office location**
  (owner's request). To show we're not local-only, use simple "nationwide" /
  "across the country" wording in company-focused sections (e.g. the Company
  page "Where We Work" section), not as a stray line in the footer or contact
  details. No state counts, and avoid "all U.S. states and territories".

## Brand
- Colors (tokens in `src/styles/global.css`): Near Black `#212121`, True Blue
  `#0D71BA`, Aqua `#00BAB4`, Energy `#C0D961`, Ash Grey `#898989`, Light Grey `#BCBCBC`.
  Aqua and Energy fail contrast as text on white: use them for fills, gradients
  and dark backgrounds only. Use True Blue or `--aqua-deep` for text on white.
- **No boxed cards anywhere** (owner's request). Content items are open: a
  thin fading line on top (`.card`, colored by `--c`), like the How We Work
  steps and Where We Work columns. Lists of rows use hairline dividers. Only
  menus and form inputs have borders. Avoid grids that leave a lone item on the
  last row (e.g. 5 items in rows of 4): use a row list or a matching column count.
- Headings: Vollkorn. Body: Open Sans. Banner headlines highlight their key words
  in Energy green (`<span class="hl">`).
- Logo files in `public/`: `logo.svg`, `logo-white.svg` (mark + wordmark, no
  tagline), `mark.svg`, `mark-white.svg`, `favicon.svg`, rebuilt as vectors from
  the 2018 Illustrator EPS files.
- Photos: every `.photo` block is a brand-graphic placeholder. Drop an `<img>`
  inside it once real photography is available (project sites, team, office).
- `public/og-default.png` is the default LinkedIn preview; regenerate with
  `npm run og-image` after editing `scripts/og-image.html`.

## Crelate (ATS + CRM) and form email
- **Visitors never leave the site.** They search jobs, read postings and apply
  on our pages. The Crelate portal (`site.jobsPortal`,
  https://jobs.crelate.com/portal/technicalsource) is only the fallback link
  when the job list is switched off. Don't link to the portal anywhere else.
  - Careers (`#jobs`) lists open jobs from `/api/jobs`, with keyword search and
    ZIP code / "City, ST" radius search (`zipcodes` database, `src/geo.ts`).
  - "View and Apply" opens `/careers/jobs/<title>-<id>`: key facts row
    (Location, Type, Duration... pulled from the top of the posting), the
    posting, and the application form (`#apply`). JobPosting structured data.
  - Every jobs/careers button on the site points at `/careers#jobs` (industry
    pages add `?industry=<id>`).
  - "Not Looking Right Now?" on Careers is the same form without a job
    (general consideration), `src/components/ApplyForm.astro`.
  - Descriptions are Crelate rich text, typed in many formats. `src/html.ts`
    decodes entities and strips everything but plain tags (no attributes,
    links, scripts or styles); `src/posting.ts` then rebuilds the posting:
    drops a repeated title, pulls the first run of "Label: value" lines (or
    list items, emoji allowed) into the facts row, turns bold or "Label:"
    lines into headings, splits `<br>` lines into paragraphs, turns "•"/"-"
    lines into lists, and writes the list teaser. `/api/jobs?check=5&q=<title>`
    shows how a live posting was read (facts and outline).
- **Public fields only.** `toPublicJob` in `src/crelate.ts` is an allowlist of
  the portal posting fields: `PortalTitle`, `PortalDescription`, `PortalCity`,
  `PortalState`, `PortalZip`, `PortalUrlSlug`, `PortalLastPostedOn`. Never use
  `Name`, `Description`, `PortalCompanyName`, contacts, owner/recruiter IDs or
  rates: they contain client and recruiter names. `isPublished` keeps only jobs
  with `OnPortal` true, not hidden, on hold or closed, not private, and with a
  portal title. `/api/jobs` returns only title, location, summary, url,
  distance and remote; job pages add the cleaned description and facts.
  Shared job code lives in `src/jobs.ts`.
- **Safety switch:** the list is off unless `JOBS_LIST_ENABLED=true` is set in
  Vercel. Without it (or without jobs), Careers shows a "View Open Positions"
  button to the portal. Diagnostics with no job text: `/api/jobs?check=1`
  (field names), `?check=2` (counts and status-field values), `?check=3`
  (published titles and status fields), `?check=4` (links on the public
  portal page).
- `/api/jobs` pages through every Crelate job (100 per request, 5 at a time,
  up to 10,000; Vercel `maxDuration: 60`), cached 10 minutes per instance.
- **Forms deliver by email first, Crelate second.** The visitor sees success
  if either worked:
  - Contact form (`src/pages/api/contact.ts`) → email to the team inbox, plus
    Crelate **contact** + **note**.
  - Applications and resumes (`src/pages/api/apply.ts`) → email with the resume
    attached, plus Crelate **candidate**, resume upload, link to the job, and
    a **note**. Resumes: PDF/Word, up to 4 MB (Vercel's request limit is 4.5 MB).
  - Email goes through Resend (`src/mail.ts`): `RESEND_API_KEY`, optional
    `MAIL_TO` (default `site.email`) and `MAIL_FROM`. Until technicalsource.com
    is verified in Resend (DNS records), the default test sender only delivers
    to the address the Resend account was created with.
  - Crelate writes go through the helpers at the end of `src/crelate.ts`
    (`createContact`, `addNote`, `uploadResume`, `addToJob`), checked against
    Crelate's API description (https://app.crelate.com/api3/docs/v3/crelate-openapi.json;
    the session environment allows app.crelate.com): `{ entity: {...} }`
    bodies, `{ Data: "<id>" }` answers, `RecordType` bitmask (1 Candidate,
    2 Client Contact), contact source named like "Website", resume as the
    contact's primary artifact, job pipeline at the first Recruiting stage
    (or `APPLY_STAGE`). An existing contact (same email) is reused and gets
    the Candidate bit when they apply. The API can't create "Applications".
  - `/api/apply?check=1` shows the Crelate settings these use (pipeline
    stages, contact sources, file types). Check the Vercel function logs
    after real submissions.
- Pages are static except the job pages; endpoints and job pages run on Vercel.
- **API keys:** Vercel → Settings → Environment Variables (`CRELATE_API_KEY`,
  `RESEND_API_KEY`). Never in the repo or chat. Optional `CRELATE_API_BASE`
  (default `https://app.crelate.com/api3`). Redeploy after changing variables.
  A dedicated Crelate "website" user's key is preferred over a personal key.
- With neither key set, the forms tell visitors to email `site.email`.
- Spam: hidden honeypot field; Astro's origin check blocks cross-site posts.

## Analytics
- GA4 + LinkedIn Insight Tag to be added at launch.

## Hosting
- Vercel team **teksourcetalent**, project **simple-site**, connected to this
  repo (separate from the team that hosts tsworkspace.com).
- Live test site: https://simple-site-gules.vercel.app (built from `master`;
  every other branch gets its own preview URL). Environment variable
  `SITE_URL=https://simple-site-gules.vercel.app` so links point at it.
- **Owner's workflow:** changes go through a pull request that the owner merges
  on GitHub. Every time, give the owner both links: the pull request to merge,
  and the live site (https://simple-site-gules.vercel.app) to check after merging.
- No custom domain for now. At launch, set `SITE_URL` to the real domain (or
  remove it to default to https://technicalsource.com) and add the domain in
  Vercel under Settings → Domains.

## Search engines (SEO)
- Indexing is controlled by the `ALLOW_INDEXING` environment variable. Unset
  (test site): every page has `noindex` and `robots.txt` blocks crawlers. Set
  to `true` only on the production deployment at launch.
- `robots.txt` is generated by `src/pages/robots.txt.ts`; the sitemap is
  `/sitemap-index.xml`.
- `src/layouts/Base.astro` outputs Organization and WebSite structured data
  (schema.org); story pages add Article data. `GOOGLE_SITE_VERIFICATION`
  (optional env var) adds the Search Console verification tag.
- Each page needs a unique `title` and `description` passed to `Base`.

## Before launch
- Set `ALLOW_INDEXING=true` and point `SITE_URL` at the real domain.
- Add the domain in Vercel; verify it in Google Search Console and Bing
  Webmaster Tools and submit the sitemap.
- Replace sample stories and photo placeholders.
- Confirm the official LinkedIn URL and email in `src/data/site.ts`.
- Confirm the full list of old WordPress URLs for `redirects`.

## Showing the site in chat
`npm run preview:file` builds the site and packs it into one self-contained
`preview.html` (all pages, CSS, fonts, logos inlined; hash-based links). Send that
file to the user under a new file name each time (viewers cache by name). If you
change a page script, mirror it in `scripts/preview-runtime.js`. Forms only
work on the live site.

## Checks before pushing
- `npm run build` must pass (output goes to `.vercel/output/static`).
- For visual changes: `npm run serve` (static pages on port 4321), then
  `npm run shots <dir>` for desktop and mobile screenshots, and check that
  nothing overflows horizontally at 390px wide. `astro preview` doesn't work
  with the Vercel adapter.
- For endpoint changes: `CRELATE_API_KEY=x CRELATE_API_BASE=http://localhost:9999/api3 RESEND_API_KEY=x RESEND_API_URL=http://localhost:9999/emails JOBS_LIST_ENABLED=true npx astro dev`
  against a local stand-in server, and check the requests it receives.
