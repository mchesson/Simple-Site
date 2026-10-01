// Every photo on the site, with where it came from and its license. Photos
// appear only on Insights stories (cards and story pages; owner, Oct 1, 2026):
// a story's `image` names one, or src/story-photo.ts picks one by industry.
// The files live in public/photos/ as <name>-<width>.webp (one large and one
// small width each). To replace a stock photo with our own, see "Photos" in
// CLAUDE.md. The Photo Credits page (/photo-credits) lists this file.

export interface PhotoCredit {
  /** File name in public/photos/ without the width and extension. */
  name: string;
  /** Widths saved in public/photos/ (largest first). */
  widths: number[];
  /** Width / height of the saved files. */
  aspect: number;
  /** What the photo shows (for the credits page). */
  title: string;
  creator: string;
  /** The photo's page on the library it came from. */
  source: string;
  license: string;
  licenseUrl: string;
  /** Where it is used on the site (Insights stories only). */
  usedOn: string;
  /** CSS object-position: the part of the photo to keep when it's cropped. */
  focus?: string;
}

const pexels = { license: 'Pexels License', licenseUrl: 'https://www.pexels.com/license/' };

export const photos = {
  'engineer-plant-floor': {
    name: 'engineer-plant-floor', widths: [1920, 960], aspect: 16 / 9,
    title: 'Engineer in a hard hat inspecting a turbine shaft on a plant floor',
    creator: 'Kateryna Babaieva', source: 'https://www.pexels.com/photo/man-wearing-orange-hard-hat-2760241/',
    ...pexels, usedOn: 'Insights: Life Sciences stories from TS Workspace', focus: '65% center',
  },
  'team-reviewing-drawings': {
    name: 'team-reviewing-drawings', widths: [1200, 600], aspect: 4 / 3,
    title: 'Engineers in hard hats reviewing a drawing on a laptop',
    creator: 'Thirdman', source: 'https://www.pexels.com/photo/people-in-hard-hats-looking-at-a-blueprint-on-a-laptop-8482865/',
    ...pexels, usedOn: 'Insights: Company News from TS Workspace',
  },
  'construction-scaffolding': {
    name: 'construction-scaffolding', widths: [1920, 960], aspect: 16 / 9,
    title: 'Tower crane and scaffolding on a building under construction',
    creator: 'Mike van Schoonderwalt', source: 'https://www.pexels.com/photo/construction-crane-on-a-building-site-5505125/',
    ...pexels, usedOn: 'Insights: Data Centers & AI stories from TS Workspace', focus: '70% center',
  },
  'team-working-session': {
    name: 'team-working-session', widths: [1200, 600], aspect: 4 / 3,
    title: 'Colleagues working through a plan around a table with laptops',
    creator: 'MART PRODUCTION', source: 'https://www.pexels.com/photo/colleagues-working-together-7550538/',
    ...pexels, usedOn: 'Insights: “Technical Source Celebrates 11 Years”; Company News from TS Workspace and Enterprise Technology stories from TS Workspace',
  },
  'tower-cranes-dusk': {
    name: 'tower-cranes-dusk', widths: [1200, 600], aspect: 4 / 3,
    title: 'Tower cranes over a construction site at dusk',
    creator: 'Jiyoung Kim', source: 'https://www.pexels.com/photo/tower-crane-used-in-building-construction-4513940/',
    ...pexels, usedOn: 'Insights: Data Centers & AI stories from TS Workspace',
  },
  'fiber-patch-panel': {
    name: 'fiber-patch-panel', widths: [1600, 800], aspect: 16 / 9,
    title: 'Fiber cables plugged into a patch panel',
    creator: 'Brett Sayles', source: 'https://www.pexels.com/photo/cables-plugged-into-patch-panel-5073493/',
    ...pexels, usedOn: 'Insights: Data Centers & AI stories from TS Workspace and Enterprise Technology stories from TS Workspace',
  },
  'process-tanks': {
    name: 'process-tanks', widths: [1920, 960], aspect: 16 / 9,
    title: 'Stainless steel process tanks in a production hall',
    creator: 'cottonbro studio', source: 'https://www.pexels.com/photo/stainless-steel-and-black-industrial-machine-5532845/',
    ...pexels, usedOn: 'Insights: Life Sciences stories from TS Workspace',
  },
  'engineer-tablet-plant': {
    name: 'engineer-tablet-plant', widths: [1920, 960], aspect: 16 / 9,
    title: 'Engineer with a tablet in a large industrial plant',
    creator: 'Sergey Sergeev', source: 'https://www.pexels.com/photo/engineer-in-industrial-factory-using-tablet-32845694/',
    ...pexels, usedOn: 'Insights: Life Sciences stories from TS Workspace', focus: '30% center',
  },
  'electrical-testing': {
    name: 'electrical-testing', widths: [1920, 960], aspect: 16 / 9,
    title: 'Engineer testing electrical cabinets',
    creator: 'Fatih Yurtman', source: 'https://www.pexels.com/photo/woman-working-with-electrical-equipment-17843269/',
    ...pexels, usedOn: 'Insights: Data Centers & AI stories from TS Workspace', focus: '60% center',
  },
  'capsule-filling': {
    name: 'capsule-filling', widths: [1920, 960], aspect: 16 / 9,
    title: 'Gloved hands loading capsules into a filling tray',
    creator: 'Pilan Filmes', source: 'https://www.pexels.com/photo/work-in-a-lab-11589208/',
    ...pexels, usedOn: 'Insights: “Commissioning and Qualification: Where Pharma Schedules Are Won or Lost”; Life Sciences stories from TS Workspace',
  },
  'data-center-aisle': {
    name: 'data-center-aisle', widths: [1920, 960], aspect: 16 / 9,
    title: 'Aisle between server racks in a data center hall',
    creator: 'Brett Sayles', source: 'https://www.pexels.com/photo/server-racks-on-data-center-4508751/',
    ...pexels, usedOn: 'Insights: “Commissioning at AI Scale”; Data Centers & AI stories from TS Workspace',
  },
  'developer-workstation': {
    name: 'developer-workstation', widths: [1920, 960], aspect: 16 / 9,
    title: 'Engineer writing code at a multi-screen workstation',
    creator: 'ThisIsEngineering', source: 'https://www.pexels.com/photo/female-software-engineer-coding-on-computer-3861972/',
    ...pexels, usedOn: 'Insights: “AI Integration Is a Project, Not a Purchase”; Enterprise Technology stories from TS Workspace',
  },
} satisfies Record<string, PhotoCredit>;

export type PhotoId = keyof typeof photos;

export function getPhoto(id: string): PhotoCredit {
  const p = (photos as Record<string, PhotoCredit>)[id];
  if (!p) throw new Error(`Unknown photo "${id}": add it to src/data/photo-credits.ts`);
  return p;
}
