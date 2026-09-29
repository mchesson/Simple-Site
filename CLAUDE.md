# Technical Source website

Marketing site for Technical Source. There is no in-house developer: the site is
built and maintained through Claude sessions, so keep things simple, documented
and consistent with this file.

## Stack
- **Astro 7**, static output. `npm run dev` (local), `npm run build` (to `dist/`).
- Content lives in the repo as Markdown. No database, no server.
- Fonts are self-hosted via `@fontsource-variable` (Vollkorn, Open Sans).
- Planned: a Git-based CMS (e.g. TinaCMS) for non-technical editors, Crelate
  integration (see below).

## Pages
| URL | File | Notes |
|---|---|---|
| `/` | `src/pages/index.astro` | Banner (who we are) → Services → How we work → Where we work → Why → Insights → Careers strip → CTA |
| `/company` | `src/pages/company.astro` | Who we are, commitments, values, locations (`#locations`) |
| `/services` | `src/pages/services.astro` | The three services, from `services` in `src/data/site.ts` |
| `/industries`, `/industries/<id>` | `src/pages/industries/` | Generated from `src/content/industries/` |
| `/insights`, `/insights/<id>` | `src/pages/insights/` | Stories, filterable by industry; RSS feeds |
| `/careers` | `src/pages/careers.astro` | Kept low-key; job search and signup are placeholders until Crelate is connected |
| `/contact` | `src/pages/contact.astro` | Form is a placeholder until Crelate is connected |

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
- Headings: Vollkorn. Body: Open Sans. Banner headlines highlight their key words
  in Energy green (`<span class="hl">`).
- Logo files in `public/`: `logo.svg`, `logo-white.svg` (mark + wordmark, no
  tagline), `mark.svg`, `mark-white.svg`, `favicon.svg`, rebuilt as vectors from
  the 2018 Illustrator EPS files.
- Photos: every `.photo` block is a brand-graphic placeholder. Drop an `<img>`
  inside it once real photography is available (project sites, team, office).
- `public/og-default.png` is the default LinkedIn preview; regenerate with
  `npm run og-image` after editing `scripts/og-image.html`.

## Integrations (not yet connected)
- **Crelate** is both ATS and CRM. Plan: pull open jobs into `/careers` by
  industry; post contact and careers forms into Crelate tagged by industry,
  service and source. The API key goes in environment secrets, never in the repo.
- Analytics (GA4 + LinkedIn Insight Tag) to be added at launch.

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

## Before launch
- Remove the `noindex` meta tag in `src/layouts/Base.astro`.
- Replace sample stories and photo placeholders.
- Confirm the official LinkedIn URL and email in `src/data/site.ts`.
- Confirm the full list of old WordPress URLs for `redirects`.

## Showing the site in chat
`npm run preview:file` builds the site and packs it into one self-contained
`preview.html` (all pages, CSS, fonts, logos inlined; hash-based links). Send that
file to the user under a new file name each time (viewers cache by name). If you
change a page script, mirror it in `scripts/preview-runtime.js`.

## Checks before pushing
- `npm run build` must pass.
- For visual changes: `npx astro preview` then `npm run shots <dir>` for desktop and
  mobile screenshots, and check that nothing overflows horizontally at 390px wide.
