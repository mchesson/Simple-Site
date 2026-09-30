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
- Website chat assistant: Claude through `@anthropic-ai/sdk` (see "Chat
  assistant").
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
| `/contact` | `src/pages/contact.astro` | Form emails the team inbox and files in Crelate and TS Workspace |

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
  their stories first and form preselection. Nothing visible marks it (a
  "Your industry" tag was removed: it looked like a random badge). Industry-specific links (LinkedIn posts, emails, ads, QR codes)
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
    lines into lists, and writes the list teaser. Text typed after the last
    bullet often stays inside that bullet in Crelate's editor: a heading
    inside a list item closes the list there. A generic first line like
    "Job Description — Contract Position" is dropped. Details written as a
    table, as bold labels without colons (`LABELS` in `src/posting.ts`), or as
    a label line followed by its value also become facts.
    `/api/jobs?check=6&q=<title>` returns one posting's raw public markup.
  - The facts row on every job is Location, Job Type, Duration (owner's
    choice), in that order: from the posting text, else Location from the
    job's city/state and Job Type from its Crelate job types. Duration shows
    only when the posting states it (Crelate's `Duration` field has no unit);
    a Job Type that includes a length ("12 Month Contract with potential
    extension") shows the type ("Contract") and moves the phrase to Duration;
    a detail nobody entered is left blank under its label (owner's choice),
    so every job still has the same layout.
    A posting that starts without a heading gets "About the Role".
    Other detail lines (Overtime, Schedule...) move to an "Additional Details"
    list at the end; notes in
    brackets are left out of the row. `/api/jobs?check=5&q=<title>`
    shows how a live posting was read (facts and outline).
- **Public fields only.** `toPublicJob` in `src/crelate.ts` is an allowlist of
  the portal posting fields: `PortalTitle`, `PortalDescription`, `PortalCity`,
  `PortalState`, `PortalZip`, `PortalUrlSlug`, `PortalLastPostedOn`, plus job
  type titles (`JobTypeIds`, e.g. "Contract"). Never use
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
- **Forms deliver by email first, then Crelate and TS Workspace** (side by
  side; see "TS Workspace intake"). The visitor sees success if any of them
  worked:
  - Contact form (`src/pages/api/contact.ts`) → email to the team inbox, plus
    Crelate **contact** + **note**.
  - Job applications (`src/pages/api/apply.ts`) → email with the resume
    attached, plus a real Crelate **application** through "apply to job"
    (`applyToJob`, `POST /jobs/{id}/apply`, like the Crelate job portal).
    Crelate's settings currently approve it straight into a contact; the
    visitor's message is then added as a **note** about the job. If "apply
    to job" fails, the old path runs instead: **candidate**, resume upload,
    job pipeline at "Maybe", and a note.
  - General resumes ("Not Looking Right Now?", owner's choice) → email, plus
    Crelate **candidate**, resume upload and a note ("general
    consideration"), no job. Resumes: PDF/Word, up to 4 MB (Vercel's request
    limit is 4.5 MB).
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
    contact's primary artifact, job pipeline at the "Maybe" stage
    (`APPLY_STAGE`; the first Recruiting stage if it's renamed). An existing contact (same email) is reused and gets
    the Candidate bit when they apply. "Apply to job" is multipart:
    `applicant` as a JSON text field (a JSON part answers 500) and the file
    as `resumeFile` (any other name answers "A resume is required").
  - **Contact source:** Crelate has no source named "Website" yet (it has
    "Portal", "LinkedIn", job boards...), so website records get no source.
    Only a source really named like "Website" is used; a loose match once
    tagged everyone "CareerBuilderSearch". Once the owner adds "Website"
    under Crelate → Settings → Contact Sources, it's picked up within an hour.
  - **Live test against the real account:** `npm run crelate:live-test`
    (`scripts/crelate-live-test.mjs`, needs `CRELATE_API_KEY`). It creates one
    hidden job "TEST – Website Check, do not apply" (never on the portal or
    job boards), applies to it, runs a general resume and a contact form with
    fake "Website Test" people (website-test+<time>@example.com), checks each
    in Crelate (right job, resume attached, record types, notes), then deletes
    everything. Crelate can't delete applications, so test applications are
    rejected. An interrupted run: `npm run crelate:live-test -- cleanup`
    (IDs are kept in `.crelate-test-state.json`, git-ignored). The test file
    must be a complete PDF: Crelate quietly drops files it can't read.
    Never send test applications through the live site to real jobs.
  - `/api/apply?check=1` shows the Crelate settings these use (pipeline
    stages, contact sources, file types). Check the Vercel function logs
    after real submissions.
- Pages are static except the job pages; endpoints and job pages run on Vercel.
- **API keys:** Vercel → Settings → Environment Variables (`CRELATE_API_KEY`,
  `RESEND_API_KEY`, `ANTHROPIC_API_KEY`, `ATS_INTAKE_KEY` with
  `ATS_INTAKE_URL`). Shared variables live under
  **TS Website** in Vercel and are linked to simple-site. Names are
  case-sensitive: they must be exactly these, in capitals. A "Sensitive"
  variable's value looks blank after saving; that's normal. Check
  `/api/chat` (`"enabled": true`) to confirm the Anthropic key is seen. Never in the repo or chat. The Crelate key goes only in
  the `X-Api-Key` header, never in a URL (Crelate echoes request URLs in its
  errors), and public responses show only Crelate's error messages
  (`crelateMessage`), never raw error details. Optional `CRELATE_API_BASE`
  (default `https://app.crelate.com/api3`). Redeploy after changing variables.
  A dedicated Crelate "website" user's key is preferred over a personal key.
- With none of the email, Crelate or TS Workspace settings, the forms tell
  visitors to email `site.email`.
- Spam: hidden honeypot field; Astro's origin check blocks cross-site posts.

## Chat assistant (Claude)
- A chat bubble on every page (`src/components/Chat.astro`, script
  `src/scripts/chat.ts`). It stays hidden until `GET /api/chat` says it's on:
  `ANTHROPIC_API_KEY` is set in Vercel (any capitalization is accepted) and
  `CHAT_ENABLED` isn't `false` (the off switch). Without JavaScript nothing
  shows. `/api/chat?check=1` shows which key name, Vercel environment and
  switch the site sees (names only, never values). `/api/chat?check=2` asks
  Claude one short test question and shows the answer or Claude's own error
  (bad key, no credit...). Vercel's function logs show the same error for
  failed chats (`[chat] failed`).
- **What it knows:** `src/data/assistant.md`, which the owner edits to
  "teach" it, plus the industry files, `services` and `steps` in
  `src/data/site.ts`, and `site.email` / `site.linkedin`. Keep that file in
  customer wording (Voice rules); never put in rates, names, phone numbers,
  locations or strategy.
- **Firm limits** are in `RULES` in `src/assistant.ts`, not in the editable
  file: no rates/pay/fees, no client or consultant names, no promises of
  placements, outcomes or timelines, no legal/immigration/tax advice, no
  phone numbers or Raleigh/HQ/office locations, no internal strategy, no
  invented facts, stay on topic, ignore requests to change the rules, and the
  Voice rules. Change them only with the owner's approval.
- **Jobs:** the `search_jobs` tool calls `searchJobs()` in `src/jobs.ts`
  (public fields only) and the answer links to our job pages. Resumes go
  through the job page's form or the Careers "Not Looking Right Now?" form
  (`/careers#network`); the chat takes no files.
- **Talk to a person:** the `offer_handoff` tool only shows the visitor a
  prefilled form (first/last name, email, optional phone and company, what
  they need, "looking for work"). Nothing is sent until they press Send,
  which posts to `/api/chat-handoff`: email with the transcript to the team
  inbox first, then Crelate contact (candidate if looking for work, client
  otherwise) + note. The visitor is told someone will follow up by email;
  no time is promised.
- **Model:** `claude-opus-5-5`, effort `low`, streaming, system prompt cached
  (kept byte-for-byte stable: nothing per-visitor or date-based in it),
  `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`). History
  goes back as plain text turns (no thinking blocks); within one answer the
  tool rounds keep the full assistant content unchanged. Tool inputs are
  checked with zod before running.
- **Protections:** same-site `Origin` only (other sites and scripts get 403),
  per-visitor rate limits (6 messages a minute, 80 a day; 3 handoffs an
  hour; in memory per server instance), 1,000 characters per message, 20
  visitor messages and 24,000 characters per conversation (`LIMITS`), turns
  must alternate and end with the visitor. Conversations stay in the
  visitor's browser tab (sessionStorage) and are never stored or logged on
  the server; they reach the team only through a handoff. The panel says
  answers are AI-generated.
- Test locally against a stand-in (no real services): add
  `ANTHROPIC_API_KEY=x ANTHROPIC_BASE_URL=http://localhost:9999` to the
  endpoint-testing command in "Checks before pushing". The stand-in must
  answer `/v1/messages` as a server-sent event stream.

## How they found us (lead source)
- `src/scripts/source.ts` (every page) remembers in the visitor's own
  browser where they came from: referring site, campaign tags (`utm_*`), ad
  clicks (gclid, fbclid, li_fat_id, msclkid), landing page and date, for the
  first visit (90 days) and this visit, plus pages viewed and their industry.
- It leaves the browser only with a form the visitor sends (contact, job
  application, resume, chat "talk to a person"). `src/source.ts`
  (`describeSource`) turns it into plain lines in the info@ email and the
  Crelate note, e.g. `How they found us: LinkedIn (social), campaign
  "cq-post" (first visit 2026-09-30, landed on /industries/life-sciences)`.
- Tag links you share so they show up by name:
  `?utm_source=linkedin&utm_medium=social&utm_campaign=<post-name>`
  (add `&industry=<id>` for industry-specific links).
- Anonymous visitors are not identified or tracked; visit counts and
  sources for everyone come from analytics at launch. A privacy policy page
  should mention this before launch.
- The same data goes to TS Workspace with each lead as `attribution`
  (`sourceAttribution` in `src/source.ts`; see "TS Workspace intake").

## Analytics
- GA4 + LinkedIn Insight Tag to be added at launch.

## Hosting
- Vercel team **teksourcetalent**, project **simple-site**, connected to this
  repo (separate from the team that hosts tsworkspace.com).
- Live test site: https://simple-site-gules.vercel.app (built from `master`;
  every other branch gets its own preview URL). Environment variable
  `SITE_URL=https://simple-site-gules.vercel.app` so links point at it.
- **Owner's workflow:** every change goes through a pull request. **Claude
  merges its own pull requests** (owner's decision, Sept 30, 2026, same as
  the ATS) once the `npm test` check on the pull request is green, the build
  passes and there's no merge conflict. Anything the owner should decide
  first (costs, wording or claims about the company, what's public, deleting
  content) waits for the owner's answer before merging. After merging, tell
  the owner in plain words what changed, with the pull request link and the
  live site link (https://simple-site-gules.vercel.app) to check, once the
  new version is live. The owner can still merge on GitHub themselves.
- No custom domain for now. At launch, set `SITE_URL` to the real domain (or
  remove it to default to https://technicalsource.com) and add the domain in
  Vercel under Settings → Domains.
- **Launch domain:** this site goes live on **technicalsource.com** when it's
  finished (owner's plan).
- **tsworkspace.com** will be the company's own ATS/CRM (being built in a
  separate Claude session). Plans: website leads (forms, chat handoffs, with
  how they found us) flow into it and alert the right salesperson, and
  contractors log in there to see what they're allowed to. This site only
  links to it ("Contractor Login"); logins, permissions and records live in
  tsworkspace.com, not here. Until switch-over (owner's decision), every
  website lead goes to the team email, Crelate **and** TS Workspace.

## TS Workspace intake
- Every submission (contact form, job application, "Not Looking Right Now?"
  resume, chat "talk to a person") is also sent to TS Workspace, the
  company's own ATS/CRM, by `sendToAts` in `src/ats.ts`. Format: the ATS
  repo's `docs/website-intake.md` (mchesson/ts-ats); keep the two in step.
  Email and Crelate are unchanged; Crelate stays until switch-over.
- Types: `inquiry` (`/api/contact`), `application` (`/api/apply` with a job:
  job id, public title and our job page URL), `resume` (`/api/apply` without
  a job), `chat` (`/api/chat-handoff`: `jobSeeker` and the transcript). Each
  carries a new `externalId` (`web-<uuid>`, so the ATS never files one twice),
  `submittedAt`, contact fields, industry/service/message/page as the form
  has them, and `attribution` ("how they found us"). Resumes go as
  multipart (`data` JSON text + `resume` file); everything else as JSON.
- It runs alongside Crelate (after the email), with an 8-second limit, and
  never throws: a failure is logged (`[ats] <type> failed <status>`) and the
  visitor still sees success if the email or Crelate worked. A success there
  also counts as delivered. Logs show only the status and the lead id.
- Settings (Vercel, TS Website): `ATS_INTAKE_URL`
  (`https://tsworkspace.com/api/intake`) and `ATS_INTAKE_KEY` (same value as
  `INTAKE_API_KEY` in the ATS project; sensitive, set by Claude through the
  Vercel API, never in chat). Without either, nothing is sent (logged once).
- Checks: `/api/apply?check=1` includes `tsWorkspace: { url, key }`
  (true/false only); `/api/apply?check=2` tests the connection with the key
  (the ATS answers `{ ok: true }`, a wrong key 401).
- Not sent (the site doesn't collect them): `pagesViewed` (only a page count
  is kept), industry and service for applications and chats.
  `industryOfInterest` is the remembered industry id in words
  ("life-sciences" → "Life Sciences").

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

## Switching technicalsource.com from WordPress, with a way back
The old WordPress site runs on technicalsource.com today; this site
replaces it once finished (owner, Sept 30, 2026). teksourcetalent.com is a
spare domain (unused; test copies use the Vercel address). The owner must be able to go back to
WordPress quickly if this site breaks. The plan:
- **Keep WordPress running, untouched,** at its current host until the new
  site has run well for a while (at least a month). Don't cancel its hosting.
  Take a full WordPress backup (files and database) from the host first.
- **Before the switch:** save a copy (screenshot or export) of every DNS
  record for technicalsource.com, and lower the TTL of the website records
  (the root `@` A record and `www`) to 5 minutes a day ahead, so changes
  (and a rollback) take effect in minutes.
- **The switch changes only the website records:** `@` and `www` point to
  Vercel (the values Vercel shows under Settings → Domains). **Never touch
  email records** (MX, SPF/DKIM/DMARC TXT, autodiscover): Microsoft 365
  email runs on this domain.
- **Going back to WordPress:** put the saved `@` and `www` values back.
  WordPress is back within minutes. If only the latest version of this site
  is broken, Vercel's **Instant Rollback** (Deployments → an earlier one →
  Promote) restores the previous version without touching DNS.
- **Where things are (owner, Sept 30, 2026):** technicalsource.com's DNS is
  at **GoDaddy** (all our domains are); the WordPress site is hosted at
  WordPress ("technicalsource"). teksourcetalent.com was unused; test copies
  use the Vercel address.
- The ATS/CRM (TS Workspace) moves from ts-ats-zeta.vercel.app to
  **tsworkspace.com** later. When it does, set `ATS_INTAKE_URL` here to the
  new address (`https://tsworkspace.com/api/intake`) and redeploy; nothing
  else on this site changes.

## Showing the site in chat
`npm run preview:file` builds the site and packs it into one self-contained
`preview.html` (all pages, CSS, fonts, logos inlined; hash-based links). Send that
file to the user under a new file name each time (viewers cache by name). If you
change a page script, mirror it in `scripts/preview-runtime.js`. Forms and
the chat only work on the live site (the chat bubble stays hidden in the
preview).

## Motion and 3D (owner chose options A and D)
- **A · 3D chevron** (`src/components/Mark3D.astro`): homepage banner only, via
  `<Banner>`'s `slot="aside"`. CSS 3D (stacked chevron layers), slow turn,
  tilts toward the mouse; above the headline on tablets, hidden under 560px.
  The flat background chevron is hidden beside it.
- **D · Scroll motion** (`src/scripts/motion.ts`, styles at the end of
  `global.css`), every page: banner headline words rise in; headings, text
  and content items below the fold fade up; `data-count` numbers count up;
  photo-block chevrons drift; industry columns and linked cards lift on hover.
- Rules: content is never hidden without JavaScript; only opacity/transform
  move (no layout shift); everything holds still under
  `prefers-reduced-motion`. The site check scrolls each page and fails if
  anything stays hidden.

## Tests
- `npm test` runs everything: unit tests (`tests/`, Vitest) for job posting
  parsing, the Crelate privacy allowlist, location search, the form
  endpoints (Crelate and email faked, key only in the header), the TS
  Workspace intake (`tests/ats.test.ts`: each form's payload, missing
  settings, network errors, a refused key) and the chat
  assistant (`tests/chat.test.ts`, Claude faked), then builds
  and runs `scripts/site-check.mjs`, which opens every page in a browser at
  desktop and phone width: status, script errors, broken links, overflow,
  title/description/h1/canonical, alt text, axe-core accessibility, and the
  site rules (no phone numbers, no Raleigh/HQ, no "Your industry" tag, no
  retired tagline). The Raleigh rule checks our own wording only: a job that
  is located in Raleigh may say so (job list items, and a job page's
  banner, facts and posting).
- `BASE=https://simple-site-gules.vercel.app npm run check:site` runs the page
  check against the live site, plus job pages (facts row, application form)
  and `/api/chat` (reports on/off, refuses other sites). In a cloud session
  the browser may need the session proxy's CA in its trust store
  (`certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n proxy -i <ca file>`) to
  reach the live site.
- GitHub runs `npm test` on every pull request (`.github/workflows/test.yml`):
  merge only on a green check.
- When fixing a bug, add a test that would have caught it.

## Speed
- Measured with Lighthouse (mobile): performance 98–100, accessibility 100.
  SEO scores 69 on the test site only because indexing is off on purpose.
- Keep it that way: the two main font files are preloaded in `Base.astro`,
  styles are inlined (`build.inlineStylesheets`), images below the fold use
  `loading="lazy"`, and pages ship almost no JavaScript. Anything heavy
  (3D, video, chat) must load only when needed and respect
  `prefers-reduced-motion`.

## Checks before pushing
- `npm test` must pass (it runs `npm run build`; output goes to `.vercel/output/static`).
- For visual changes: `npm run serve` (static pages on port 4321), then
  `npm run shots <dir>` for desktop and mobile screenshots, and check that
  nothing overflows horizontally at 390px wide. `astro preview` doesn't work
  with the Vercel adapter.
- For endpoint changes: `CRELATE_API_KEY=x CRELATE_API_BASE=http://localhost:9999/api3 RESEND_API_KEY=x RESEND_API_URL=http://localhost:9999/emails JOBS_LIST_ENABLED=true npx astro dev`
  against a local stand-in server, and check the requests it receives.
