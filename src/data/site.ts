export const site = {
  name: 'Technical Source',
  tagline: 'Connecting Talent. Delivering Excellence.',
  description:
    'Technical Source provides the expertise and teams behind complex technical projects in life sciences, data centers and enterprise technology.',
  // TODO(confirm): two LinkedIn company pages exist publicly; confirm the official one.
  linkedin: 'https://www.linkedin.com/company/technical-source-llc',
  // TODO(confirm): general inbox shown in public listings. No phone numbers on the site.
  email: 'info@technicalsource.com',
  // Where we work. No office or headquarters locations on the site (owner's request).
  coverage: 'Supporting projects nationwide',
};

export const services = [
  {
    id: 'project-support',
    name: 'Project Support',
    body: 'Experienced specialists who join your project team and are productive from day one.',
    fit: ['You need specific expertise quickly', 'A phase of the project needs extra depth', 'You want to keep day-to-day direction in-house'],
  },
  {
    id: 'managed-project-teams',
    name: 'Managed Project Teams',
    body: 'We plan, onboard and manage the team across every phase, with one point of contact.',
    fit: ['Several disciplines need to work together', 'You want one point of contact for the team', 'The project spans multiple phases'],
  },
  {
    id: 'scoped-project-work',
    name: 'Scoped Project Work',
    body: 'Defined scopes of work with clear milestones, for projects that need a set outcome.',
    fit: ['The scope and milestones are well defined', 'You need a specific outcome by a specific date', 'You would rather manage deliverables than people'],
  },
];

export const steps = [
  { title: 'Understand', body: 'We start with your project: the goals, the timeline and the standards the work has to meet.' },
  { title: 'Plan', body: 'Together we define what the project needs and how we can best support it.' },
  { title: 'Deliver', body: 'We put the right expertise to work and stay in close contact to keep the project on track.' },
  { title: 'Hand Off', body: 'As the project winds down, we help plan a smooth transition so knowledge stays with your team and the work carries forward.' },
];
