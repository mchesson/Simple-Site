# Technical Source website

Marketing site for Technical Source. There is no in-house developer: the site is
built and maintained through Claude sessions, so keep things simple, documented
and consistent with this file.

## Stack
- **Astro 7**, static output. `npm run dev` (local), `npm run build` (to `dist/`).
- Content lives in the repo as Markdown. No database, no server.
- Fonts are self-hosted via `@fontsource-variable` (Vollkorn, Open Sans).
- Planned: hosting on Vercel or Netlify from this repo, a Git-based CMS
  (e.g. TinaCMS) for non-technical editors, Crelate integration (see below).

## Positioning (source: "Defining Our Lane" strategy deck, June 2026)
- Umbrella line: *The execution partner for complex, project-based programs in
  technically demanding environments.*
- Tagline: **Connecting Talent. Delivering Excellence.** The old tagline "The Right
  People. The Right Opportunity." is retired; never use it.
- Company is in its 11th year: say "more than a decade".
- Three pillars: `life-sciences` (pharma manufacturing), `data-centers`
  (data centers & AI infrastructure), `enterprise-technology` (AI integration &
  enterprise security). Government services, commodity IT, general construction
  and pure perm/exec search are out of lane: don't market them.
- Buyers are program owners (project VPs, engineering directors, professional
  services leaders), not HR or procurement.
- Growth arc: Staff Augmentation (today), Managed Staffing (expanding),
  Deliverable-Based Work (coming). Don't overstate tiers 2–3 until leadership
  approves public claims.

### Keep internal content off the site
The strategy deck is confidential. Never publish: the three client-fit filters,
yes/no lists, the out-of-lane approval process, recruiting tiers or SLAs, roadmap
dates, or revenue/margin statements.

## One brand, three front doors
- `src/data/pillars.ts` holds all pillar copy (headlines, lifecycle phases, roles).
  Edit copy there, not in page templates.
- `src/pages/[pillar].astro` renders every pillar page from that data.
- `src/scripts/pillar.ts` remembers the visitor's pillar (`?pillar=` param, pillar
  page visit, or localStorage) and tailors the homepage and lists. Every
  pillar-specific link (LinkedIn posts, emails, ads, QR codes) should point to the
  pillar page or carry `?pillar=<id>`.

## Stories (news, insights, case studies)
- One Markdown file per story in `src/content/stories/`. The schema is in
  `src/content.config.ts`. Tags decide placement and distribution:
  - `pillar`: `life-sciences` | `data-centers` | `enterprise-technology` | `company`
  - `type`: `company-news` | `insight` | `case-study` | `spotlight` | `event`
  - `audience`: any of `buyers`, `talent`, `consultants`, `partners`
  - `linkedin`: ready-to-post copy; the story page has a "Copy LinkedIn post" button
  - `anonymized: true` when client details are withheld for NDA reasons
  - `sample: true` marks prototype content (shows a "Sample" badge); replace before launch
  - `draft: true` hides the story from production builds
- Stories appear automatically on the matching pillar page, the homepage (sorted
  for the visitor's pillar), `/news` (filterable) and in RSS feeds:
  `/news/rss.xml` and `/news/<pillar>/rss.xml` (for newsletter automation).
- Naming client companies or consultants requires written approval.
- Aim for about 70% pillar-specific and 30% umbrella/company content.

## Brand
- Colors (tokens in `src/styles/global.css`): Near Black `#212121`, True Blue
  `#0D71BA`, Aqua `#00BAB4`, Energy `#C0D961`, Ash Grey `#898989`, Light Grey `#BCBCBC`.
  Aqua and Energy fail contrast as text on white: use them for fills,
  gradients and dark backgrounds only. Use True Blue (or `--aqua-deep`,
  `--energy-deep`) for text.
- Fonts: Vollkorn (headings), Open Sans (body).
- Logo files in `public/`: `logo.svg`, `logo-white.svg` (mark + wordmark, no
  tagline), `mark.svg`, `mark-white.svg`, `favicon.svg`. Rebuilt as pure vectors
  from the 2018 Illustrator EPS files; the chevron mark is also the site's visual
  motif (eyebrows, bullets, hero art).
- `public/og-default.png` is the default LinkedIn preview; regenerate with
  `npm run og-image` after editing `scripts/og-image.html`.

## Voice
Plain, confident, specific (Candor). Show expertise instead of claiming it. No
staffing clichés ("best-in-class", "top talent", "fill seats"). Credit consultants
and clients.

## Integrations (not yet connected)
- **Crelate** is both ATS and CRM. Plan: pull open jobs into `/careers` by
  pillar; post contact and talent-network forms into Crelate as contacts/candidates
  tagged by pillar and source. The API key goes in environment secrets, never in
  the repo. Forms on `/contact` and `/careers` are prototype-only today.
- Analytics (GA4 + LinkedIn Insight Tag) to be added at launch.

## Open items to confirm
- Official LinkedIn company page URL (`src/data/site.ts`).
- Real case studies, client quotes and consultant stories to replace placeholders.
- Page redirects from the current WordPress site (keep old URLs working for SEO).

## Checks before pushing
- `npm run build` must pass.
- For visual changes: `npx astro preview` then `npm run shots <dir>` for desktop and
  mobile screenshots, and check that nothing overflows horizontally at 390px wide.
