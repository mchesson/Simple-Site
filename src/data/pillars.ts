// The three program pillars from "Defining Our Lane" (June 2026).
// Public-facing copy only: internal filters, SLAs, recruiting tiers and the
// yes/no lists stay out of the site. See CLAUDE.md.

export type PillarId = 'life-sciences' | 'data-centers' | 'enterprise-technology';
export type StoryPillar = PillarId | 'company';

export interface Phase {
  name: string;
  detail: string;
  roles: string;
  highlight?: boolean;
}

export interface Track {
  title: string;
  kind: 'lifecycle' | 'grid';
  phases: Phase[];
}

export interface Pillar {
  id: PillarId;
  label: string;
  short: string;
  eyebrow: string;
  headline: string;
  pitch: string;
  cardLine: string;
  /** CSS color token used for this pillar's accents. */
  accent: string;
  tracks: Track[];
  roles: string[];
  proof: { title: string; detail: string }[];
}

export const pillars: Pillar[] = [
  {
    id: 'life-sciences',
    label: 'Life Sciences',
    short: 'Pharma Manufacturing',
    eyebrow: 'Life Sciences  |  Pharma Manufacturing',
    headline: 'The execution partner behind greenfield builds, brownfield retrofits and C&Q programs.',
    pitch:
      'We deliver the experts and the project teams behind your greenfield builds, brownfield retrofits and CapEx programs: the work that brings new therapies safely to patients.',
    cardLine: 'Greenfield and brownfield pharma, C&Q, CSV and tech transfer.',
    accent: 'var(--aqua)',
    tracks: [
      {
        title: 'Greenfield: the CapEx lifecycle',
        kind: 'lifecycle',
        phases: [
          { name: 'Strategy & Business Case', detail: 'Regulatory strategy, program planning, site feasibility', roles: 'Regulatory strategy, program management' },
          { name: 'Site Selection & Design', detail: 'GMP architecture, process design, utility layouts', roles: 'GMP architects, process engineers' },
          { name: 'Engineering & Permitting', detail: 'FEED and detailed design, MEP systems, permit coordination', roles: 'FEED, detailed design, MEP' },
          { name: 'Construction & Install', detail: 'GMP construction, cleanroom builds, equipment installation', roles: 'Construction QA, cleanroom' },
          { name: 'Commission & Validate', detail: 'C&Q execution, CSV, process validation, PPQ', roles: 'C&Q, CSV, QA, PPQ', highlight: true },
          { name: 'Regulatory & Launch', detail: 'Regulatory filings, tech ops, supply chain readiness', roles: 'Regulatory affairs, operations, supply chain' },
        ],
      },
      {
        title: 'Brownfield: inside live GMP operations',
        kind: 'grid',
        phases: [
          { name: 'Capacity Expansions', detail: 'New line adds, fill-finish expansions, debottlenecking and clean utilities, without disrupting GMP operations', roles: 'Process engineering, C&Q, clean utilities, QA' },
          { name: 'Tech & Product Transfer', detail: 'Moving products between sites, CDMOs or modalities: CMC coordination, method transfer, PPQ', roles: 'Tech transfer, MSAT, regulatory affairs, analytical' },
          { name: 'Line Conversions & Upgrades', detail: 'Modality swaps, single-use to hybrid, isolator retrofits, serialization and track & trace', roles: 'Process engineering, automation, CSV, validation' },
          { name: 'Remediation & Consent Decree', detail: '483 and warning letter response, data integrity remediation, quality system rebuilds', roles: 'QA, compliance, CSV, regulatory affairs' },
          { name: 'Shutdowns & Turnarounds', detail: 'Planned outages, major maintenance, site transitions and knowledge transfer', roles: 'Construction management, C&Q, QA, project management' },
        ],
      },
    ],
    roles: ['CQV Engineers', 'CSV Engineers', 'Validation Engineers', 'Process Engineers', 'Automation & Controls Engineers', 'Validation Managers', 'Owner’s Representatives', 'Project Managers'],
    proof: [
      { title: 'Case study: greenfield C&Q program', detail: 'Placeholder. Program, problem, team, outcome.' },
      { title: 'Case study: brownfield line expansion', detail: 'Placeholder. Anonymized if under NDA.' },
    ],
  },
  {
    id: 'data-centers',
    label: 'Data Centers & AI',
    short: 'Hyperscale, Colocation & AI Infrastructure',
    eyebrow: 'Data Centers & AI  |  Mission-Critical Build-Outs',
    headline: 'Mission-critical capacity, delivered on schedule.',
    pitch:
      'We are the execution partner for hyperscale and colocation operators. We deliver the experts and project teams behind mission-critical builds: the capacity that powers the world’s compute, AI and cloud workloads.',
    cardLine: 'Hyperscale and colocation builds, commissioning and AI infrastructure.',
    accent: 'var(--blue)',
    tracks: [
      {
        title: 'Data center build-outs',
        kind: 'lifecycle',
        phases: [
          { name: 'Site Selection & Development', detail: 'Power availability, fiber, water, AHJ, incentives, entitlement and utility coordination', roles: 'Site development, PM, utility coordination' },
          { name: 'Design & Engineering', detail: 'Electrical, mechanical, structural, substation, cooling strategy, redundancy topology', roles: 'EE, ME, structural, MEP' },
          { name: 'Construction Management', detail: 'GC oversight, trade coordination, schedule control, safety and quality at scale', roles: 'Construction managers, superintendents, QC' },
          { name: 'Power, Cooling & MEP', detail: 'Medium-voltage distribution, UPS, generators, chilled water, CRAH/CRAC, fire suppression', roles: 'MV electrical, mechanical, controls' },
          { name: 'Commissioning', detail: 'Level 1–5 commissioning, integrated systems testing, BMS/EPMS tuning, client sign-off', roles: 'Cx agents, BMS, electrical Cx', highlight: true },
          { name: 'Operations Readiness & Turnover', detail: 'Runbooks, turnover packages, NOC integration, training, as-built documentation', roles: 'Ops readiness, technical writers, trainers' },
        ],
      },
      {
        title: 'The AI infrastructure layer',
        kind: 'grid',
        phases: [
          { name: 'Computing Infrastructure', detail: 'GPU cluster design and build-out, high-performance compute architecture, AI-optimized power and cooling', roles: 'HPC / GPU infrastructure engineers' },
          { name: 'AI Engineering', detail: 'Model deployment, inference pipelines, feature stores and observability in mission-critical environments', roles: 'AI/ML engineers, MLOps' },
          { name: 'OT & Infrastructure Cybersecurity', detail: 'OT/IT convergence, secure model serving, data governance, zero-trust for mission-critical AI', roles: 'OT cybersecurity, ICS specialists' },
          { name: 'AI Systems Validation', detail: 'GAMP 5, 21 CFR Part 11, EU Annex 11, model governance and explainability for regulated AI', roles: 'AI validation specialists' },
        ],
      },
    ],
    roles: ['Data Center Project Managers', 'Construction Managers', 'Commissioning Engineers', 'MEP Engineers', 'BMS / EPMS Controls Engineers', 'Critical Facilities Engineers', 'Network & Infrastructure Engineers', 'HPC / GPU Infrastructure Engineers'],
    proof: [
      { title: 'Case study: hyperscale commissioning', detail: 'Placeholder. Program, problem, team, outcome.' },
      { title: 'Case study: AI capacity build-out', detail: 'Placeholder. Anonymized if under NDA.' },
    ],
  },
  {
    id: 'enterprise-technology',
    label: 'Enterprise Technology',
    short: 'AI Integration & Enterprise Security',
    eyebrow: 'Enterprise Technology  |  AI Integration & Security',
    headline: 'AI integration and security programs are too important to staff by résumé.',
    pitch:
      'We deliver the technical talent and project teams behind enterprise AI deployments, platform implementations and security programs: project-based, high-consequence work on defined timelines.',
    cardLine: 'Enterprise AI deployments, system integration and security programs.',
    accent: 'var(--energy-deep)',
    tracks: [
      {
        title: 'AI integration',
        kind: 'grid',
        phases: [
          { name: 'AI Platform Implementations', detail: 'Enterprise AI deployments, LLM integration and digital transformation programs', roles: 'AI systems engineers, MLOps, data platform engineers', highlight: true },
          { name: 'System & IT Integration', detail: 'Enterprise platform integration, legacy modernization, IT convergence programs', roles: 'OT/IT integration engineers, systems architects' },
          { name: 'SaaS & Professional Services Scale-Up', detail: 'Customer implementation programs, platform onboarding, professional services delivery at scale', roles: 'Implementation specialists, technical PMs' },
        ],
      },
      {
        title: 'Enterprise security & compliance',
        kind: 'grid',
        phases: [
          { name: 'Security Program Implementation', detail: 'Identity and access management, application security, network security architecture', roles: 'Security architects, IAM engineers, AppSec' },
          { name: 'Compliance & GRC Programs', detail: 'Risk advisory, governance frameworks, compliance builds: SOC 2, ISO 27001, FedRAMP', roles: 'GRC specialists, compliance engineers' },
          { name: 'Critical Infrastructure Security', detail: 'Securing industrial control systems: NERC CIP, ICS/SCADA hardening', roles: 'OT cybersecurity engineers, ICS specialists' },
          { name: 'Remediation & Incident Response', detail: 'Regulatory exposure remediation, incident recovery, security posture rebuilds', roles: 'Incident response, security engineers' },
        ],
      },
    ],
    roles: ['AI Systems Engineers', 'MLOps Engineers', 'Data Platform Engineers', 'Systems Architects', 'Security Architects', 'IAM Engineers', 'GRC Specialists', 'Technical Project Managers'],
    proof: [
      { title: 'Case study: enterprise AI deployment', detail: 'Placeholder. Program, problem, team, outcome.' },
      { title: 'Case study: compliance program build', detail: 'Placeholder. Anonymized if under NDA.' },
    ],
  },
];

export const pillarById = Object.fromEntries(pillars.map((p) => [p.id, p])) as Record<PillarId, Pillar>;

export const storyPillarLabel: Record<StoryPillar, string> = {
  'life-sciences': 'Life Sciences',
  'data-centers': 'Data Centers & AI',
  'enterprise-technology': 'Enterprise Technology',
  company: 'Company',
};

export const throughLine = [
  { title: 'Program-based', body: 'Defined scope with a finish line. We show up when the work has to be delivered, not just maintained.' },
  { title: 'Complex', body: 'Multi-discipline, multi-stakeholder programs of six months or more. Coordination is part of the job.' },
  { title: 'Technically demanding', body: 'Regulated, mission-critical or deep platform work, where specialized talent is the constraint.' },
  { title: 'High-consequence', body: 'Miss the window and the program pays for it in revenue, compliance or market position.' },
];

export const differentiators = [
  { title: 'Industry-first, not résumé-first', body: 'We start with the business problem and the program context, not the job description. Our team understands your work before we pick up the phone.' },
  { title: 'Scarce-talent pipelines', body: 'Warm, continuously cultivated networks of specialists who aren’t on job boards. They know us because we invested in the relationship before the role opened.' },
  { title: 'Hired, not submitted', body: 'Consultants join Technical Source. We invest in them, develop them and deploy them with accountability, so retention and performance beat commodity placement.' },
  { title: 'Accountable delivery', body: 'Phase-based workforce planning, onboarding and knowledge capture: the discipline that turns a placement into a managed team.' },
];

export const engagementModels = [
  { tier: 'Staff Augmentation', status: 'Today', body: 'We supply specialists, fast. Sourcing, screening, credentialing and compliance for defined roles embedded in your team.' },
  { tier: 'Managed Staffing', status: 'Expanding', body: 'One point of contact who plans, coordinates and optimizes your program workforce, with utilization reporting and structured onboarding.' },
  { tier: 'Deliverable-Based Work', status: 'Coming', body: 'We own the outcome: fixed scope, milestone delivery and performance accountability for packages like validation and C&Q.' },
];
