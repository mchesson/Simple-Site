# Technical Source website

Prototype of the new Technical Source site: one umbrella brand with three front
doors (Life Sciences, Data Centers & AI, Enterprise Technology), a tagged story
system and pillar-aware personalization.

```bash
npm install
npm run dev      # http://localhost:4321
npm run build    # static site in dist/
```

**Add a story:** create a Markdown file in `src/content/stories/` (copy an existing
one), set its `pillar`, `type` and `audience` tags, then build. See `CLAUDE.md` for
conventions, brand rules and what must stay off the public site.
