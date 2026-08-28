// The tools Claude can use against the workspace.
//
// Each tool is a JSON Schema plus a run function. Two conventions matter:
//
//   * A tool that cannot proceed returns { needs: [...] } instead of throwing.
//     The model reads that and asks the user for the missing piece, which is
//     what makes entering a record by conversation feel like slot filling
//     rather than a form rejecting you.
//
//   * Nothing here deletes. The write tools go through repo.js, which keeps
//     the previous version of every row it changes.

import * as repo from "./repo.js";
import { rows, one } from "./db.js";

const need = (...fields) => ({
  error: "missing_information",
  needs: fields,
  hint: "Ask the user for these before calling again.",
});

// Resolve a name the user typed to an id. Returns a disambiguation list rather
// than guessing when more than one thing matches - guessing here means logging
// a call against the wrong company.
async function resolve(table, name, extraWhere = "", params = []) {
  if (!name) return { match: null, candidates: [] };
  const col = table === "contact" ? "full_name" : "name";
  const found = await rows(
    `select id, ${col} as name from "${table}"
      where archived_at is null and ${col} ilike '%'||$1||'%' ${extraWhere}
      order by (lower(${col}) = lower($1)) desc, ${col} limit 6`,
    [name, ...params]);
  const exact = found.filter((f) => f.name.toLowerCase() === name.toLowerCase());
  if (exact.length === 1) return { match: exact[0], candidates: found };
  if (found.length === 1) return { match: found[0], candidates: found };
  return { match: null, candidates: found };
}

function ambiguous(kind, name, candidates) {
  return candidates.length
    ? { error: "ambiguous", message: `More than one ${kind} matches "${name}".`,
        candidates }
    : { error: "not_found", message: `No ${kind} named "${name}".` };
}

export function buildTools(ctx) {
  const actor = () => ctx.userId;

  const T = [
    // ------------------------------------------------------------- accounts
    {
      name: "list_accounts",
      description:
        "List accounts (client companies). Use for 'my accounts', 'unassigned accounts', " +
        "or to find an account by partial name. Returns owners and counts, not full detail.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Partial account name." },
          mine: { type: "boolean", description: "Only accounts the current user owns." },
          unassigned: { type: "boolean", description: "Only accounts with no owner at all." },
          status: { type: "string", enum: ["prospect", "active", "inactive", "do_not_use"] },
          limit: { type: "integer", default: 50 },
        },
      },
      run: async (i) =>
        repo.listAccounts({
          q: i.query || null,
          ownerId: i.mine ? actor() : null,
          unassigned: !!i.unassigned,
          status: i.status || null,
          limit: i.limit || 50,
        }),
    },
    {
      name: "get_account",
      description:
        "Full detail for one account: owners, every location with its own rules of " +
        "engagement, all contacts, projects, agreements and documents. Pass either id " +
        "or name.",
      input_schema: {
        type: "object",
        properties: { id: { type: "string" }, name: { type: "string" } },
      },
      run: async (i) => {
        let id = i.id;
        if (!id) {
          if (!i.name) return need("account id or name");
          const r = await resolve("account", i.name);
          if (!r.match) return ambiguous("account", i.name, r.candidates);
          id = r.match.id;
        }
        return (await repo.getAccount(id)) || { error: "not_found" };
      },
    },
    {
      name: "create_account",
      description: "Create a new account. Only 'name' is required.",
      input_schema: {
        type: "object",
        properties: {
          name: { type: "string" },
          status: { type: "string", enum: ["prospect", "active", "inactive", "do_not_use"] },
          industry: { type: "string" },
          website: { type: "string" },
          bg_check_policy: { type: "string",
            description: "Account-wide background check requirement. Flows down to every location." },
          drug_test_policy: { type: "string",
            description: "Account-wide drug screen requirement. Flows down to every location." },
          onboarding_notes: { type: "string" },
          notes: { type: "string" },
        },
        required: ["name"],
      },
      run: async (i) => {
        if (!i.name) return need("account name");
        const dup = await one(
          `select id, name from account where lower(name) = lower($1) and archived_at is null`,
          [i.name]);
        if (dup) return { error: "already_exists", existing: dup };
        return repo.insertRecord("account", i, actor());
      },
    },
    {
      name: "set_account_owners",
      description:
        "Set who owns an account. Owners must be existing workspace users - call " +
        "list_users first and pass their ids. Splits must total a sensible share each.",
      input_schema: {
        type: "object",
        properties: {
          account_id: { type: "string" },
          owners: {
            type: "array",
            items: {
              type: "object",
              properties: {
                user_id: { type: "string" },
                role: { type: "string", enum: ["account_manager", "recruiter", "executive"] },
                split_pct: { type: "number" },
              },
              required: ["user_id"],
            },
          },
        },
        required: ["account_id", "owners"],
      },
      run: async (i) => repo.setAccountOwners(i.account_id, i.owners, actor()),
    },
    {
      name: "get_location",
      description:
        "One site of an account: its address, its own rules of engagement, the contacts " +
        "based there, and the account screening policy it inherits plus any site-specific notes.",
      input_schema: {
        type: "object",
        properties: { id: { type: "string" }, name: { type: "string" } },
      },
      run: async (i) => {
        let id = i.id;
        if (!id) {
          if (!i.name) return need("location id or name");
          const r = await resolve("location", i.name);
          if (!r.match) return ambiguous("location", i.name, r.candidates);
          id = r.match.id;
        }
        return (await repo.getLocation(id)) || { error: "not_found" };
      },
    },
    {
      name: "create_location",
      description: "Add a site to an account. Sites carry their own address and rules of engagement.",
      input_schema: {
        type: "object",
        properties: {
          account_id: { type: "string" }, account_name: { type: "string" },
          name: { type: "string" },
          address1: { type: "string" }, city: { type: "string" },
          state: { type: "string" }, postal_code: { type: "string" },
          rules_of_engagement: { type: "string" },
          bg_check_notes: { type: "string" }, drug_test_notes: { type: "string" },
        },
        required: ["name"],
      },
      run: async (i) => {
        let accountId = i.account_id;
        if (!accountId && i.account_name) {
          const r = await resolve("account", i.account_name);
          if (!r.match) return ambiguous("account", i.account_name, r.candidates);
          accountId = r.match.id;
        }
        if (!accountId) return need("which account this site belongs to");
        return repo.insertRecord("location", { ...i, account_id: accountId }, actor());
      },
    },

    // ------------------------------------------------------------- contacts
    {
      name: "list_contacts",
      description:
        "Search people. Everyone is a contact; role is 'manager' (works at a client) or " +
        "'candidate' (someone we place), and one person can be both. Search by name, " +
        "email, headline or skill.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Free text: name, email, headline or a skill." },
          skills: { type: "array", items: { type: "string" },
                    description: "Must have all of these skills." },
          role: { type: "string", enum: ["manager", "candidate"] },
          account_name: { type: "string" },
          on_payroll: { type: "boolean",
                        description: "True for consultants currently on our payroll." },
          limit: { type: "integer", default: 25 },
        },
      },
      run: async (i) => {
        let accountId = null;
        if (i.account_name) {
          const r = await resolve("account", i.account_name);
          if (!r.match) return ambiguous("account", i.account_name, r.candidates);
          accountId = r.match.id;
        }
        return repo.searchContacts({
          q: i.query || null, skills: i.skills?.length ? i.skills : null,
          role: i.role || null, accountId,
          onPayroll: i.on_payroll === undefined ? null : i.on_payroll,
          limit: i.limit || 25,
        });
      },
    },
    {
      name: "get_contact",
      description:
        "Everything about one person: both role hats, their account and site, their " +
        "recruiter if they are on payroll, their full activity history with which hat " +
        "each note was logged under, submissions, documents and pipelines.",
      input_schema: {
        type: "object",
        properties: { id: { type: "string" }, name: { type: "string" } },
      },
      run: async (i) => {
        let id = i.id;
        if (!id) {
          if (!i.name) return need("contact id or name");
          const r = await resolve("contact", i.name);
          if (!r.match) return ambiguous("person", i.name, r.candidates);
          id = r.match.id;
        }
        return (await repo.getContact(id)) || { error: "not_found" };
      },
    },
    {
      name: "create_contact",
      description:
        "Create a person. A manager must be tied to an account. A candidate does not " +
        "need one. If the same person already exists, this returns the existing record " +
        "rather than creating a duplicate - one human is one row regardless of how many " +
        "hats they wear.",
      input_schema: {
        type: "object",
        properties: {
          full_name: { type: "string" },
          email: { type: "string" }, phone: { type: "string" }, title: { type: "string" },
          is_manager: { type: "boolean" }, is_candidate: { type: "boolean" },
          account_name: { type: "string", description: "Required when is_manager is true." },
          account_id: { type: "string" },
          location_name: { type: "string" }, location_id: { type: "string" },
          headline: { type: "string" },
          skills: { type: "array", items: { type: "string" } },
          location_text: { type: "string" },
          on_payroll: { type: "boolean" },
          source: { type: "string" }, notes: { type: "string" },
        },
        required: ["full_name"],
      },
      run: async (i) => {
        const missing = [];
        if (!i.full_name) missing.push("full name");
        const isManager = !!i.is_manager;
        const isCandidate = !!i.is_candidate;
        if (!isManager && !isCandidate)
          missing.push("whether they are a manager, a candidate, or both");
        let accountId = i.account_id || null;
        if (!accountId && i.account_name) {
          const r = await resolve("account", i.account_name);
          if (!r.match) return ambiguous("account", i.account_name, r.candidates);
          accountId = r.match.id;
        }
        if (isManager && !accountId)
          missing.push("the company they work for (a manager has to sit on an account)");
        if (missing.length) return need(...missing);

        let locationId = i.location_id || null;
        if (!locationId && i.location_name) {
          const r = await resolve("location", i.location_name, "and account_id = $2", [accountId]);
          if (!r.match) return ambiguous("location", i.location_name, r.candidates);
          locationId = r.match.id;
        }

        // Same person, already here? Add the hat instead of forking the record.
        const existing = i.email
          ? await one(`select * from contact where lower(email) = lower($1)
                        and archived_at is null`, [i.email])
          : await one(`select * from contact where lower(full_name) = lower($1)
                        and archived_at is null`, [i.full_name]);
        if (existing) {
          const patch = {};
          if (isManager && !existing.is_manager) { patch.is_manager = true;
                                                   patch.account_id = accountId; }
          if (isCandidate && !existing.is_candidate) patch.is_candidate = true;
          if (locationId && !existing.location_id) patch.location_id = locationId;
          if (Object.keys(patch).length) {
            const r = await repo.updateRecord("contact", existing.id, patch, actor());
            return { merged_into_existing: true, contact: r.after,
                     note: "This person already existed. Added the new role to the same " +
                           "record instead of creating a second one." };
          }
          return { merged_into_existing: true, contact: existing,
                   note: "This person already exists with these roles." };
        }

        return repo.insertRecord("contact", {
          full_name: i.full_name, email: i.email, phone: i.phone, title: i.title,
          is_manager: isManager, is_candidate: isCandidate,
          account_id: accountId, location_id: locationId,
          headline: i.headline, skills: i.skills || [], location_text: i.location_text,
          on_payroll: !!i.on_payroll, recruiter_id: i.on_payroll ? actor() : null,
          source: i.source, notes: i.notes,
        }, actor());
      },
    },
    {
      name: "update_contact",
      description:
        "Change fields on a person. The previous version is kept - use record_history " +
        "to see what changed and when. Pass only the fields that are changing.",
      input_schema: {
        type: "object",
        properties: {
          id: { type: "string" }, name: { type: "string" },
          changes: {
            type: "object",
            description: "Any of: full_name, email, phone, title, is_manager, is_candidate, " +
                         "headline, skills, location_text, on_payroll, source, notes.",
          },
        },
        required: ["changes"],
      },
      run: async (i) => {
        let id = i.id;
        if (!id) {
          if (!i.name) return need("which person to change");
          const r = await resolve("contact", i.name);
          if (!r.match) return ambiguous("person", i.name, r.candidates);
          id = r.match.id;
        }
        return repo.updateRecord("contact", id, i.changes, actor());
      },
    },

    // ------------------------------------------------------------- projects
    {
      name: "list_projects",
      description:
        "List projects. Everything we work on is a project - a single contract opening " +
        "is a project with one seat. delivery_type says what kind: staffing, " +
        "contract_to_hire, direct_hire, managed_project (our team, no fixed deliverables), " +
        "or managed_service (deliverables).",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string" },
          account_name: { type: "string" },
          status: { type: "string",
                    enum: ["draft", "open", "on_hold", "filled", "closed", "lost"] },
          delivery_type: { type: "string",
            enum: ["staffing", "contract_to_hire", "direct_hire", "managed_project",
                   "managed_service"] },
          mine: { type: "boolean" },
          limit: { type: "integer", default: 50 },
        },
      },
      run: async (i) => {
        let accountId = null;
        if (i.account_name) {
          const r = await resolve("account", i.account_name);
          if (!r.match) return ambiguous("account", i.account_name, r.candidates);
          accountId = r.match.id;
        }
        return repo.listProjects({
          accountId, status: i.status || null, deliveryType: i.delivery_type || null,
          ownerId: i.mine ? actor() : null, q: i.query || null, limit: i.limit || 50,
        });
      },
    },
    {
      name: "get_project",
      description:
        "Full project detail: submissions with stages, placements with their full " +
        "effective-dated rate history and computed margin, purchase orders with burn-down, " +
        "SOWs and change orders, Exhibit A rate verifications, and documents.",
      input_schema: {
        type: "object",
        properties: { id: { type: "string" }, name: { type: "string" } },
      },
      run: async (i) => {
        let id = i.id;
        if (!id) {
          if (!i.name) return need("project id or name");
          const r = await resolve("project", i.name);
          if (!r.match) return ambiguous("project", i.name, r.candidates);
          id = r.match.id;
        }
        return (await repo.getProject(id)) || { error: "not_found" };
      },
    },
    {
      name: "create_project",
      description:
        "Create a project (what another system would call a job order or req). Needs an " +
        "account and a name at minimum; ask for the delivery type if the user has not " +
        "made it obvious.",
      input_schema: {
        type: "object",
        properties: {
          name: { type: "string" },
          account_name: { type: "string" }, account_id: { type: "string" },
          location_name: { type: "string" }, location_id: { type: "string" },
          delivery_type: { type: "string",
            enum: ["staffing", "contract_to_hire", "direct_hire", "managed_project",
                   "managed_service"] },
          openings: { type: "integer" },
          pay_rate_min: { type: "number" }, pay_rate_max: { type: "number" },
          bill_rate_min: { type: "number" }, bill_rate_max: { type: "number" },
          start_date: { type: "string", description: "YYYY-MM-DD" },
          description: { type: "string" },
          skills: { type: "array", items: { type: "string" } },
        },
        required: ["name"],
      },
      run: async (i) => {
        const missing = [];
        if (!i.name) missing.push("a name for the project");
        let accountId = i.account_id || null;
        if (!accountId && i.account_name) {
          const r = await resolve("account", i.account_name);
          if (!r.match) return ambiguous("account", i.account_name, r.candidates);
          accountId = r.match.id;
        }
        if (!accountId) missing.push("which account this is for");
        if (missing.length) return need(...missing);
        let locationId = i.location_id || null;
        if (!locationId && i.location_name) {
          const r = await resolve("location", i.location_name, "and account_id = $2", [accountId]);
          if (!r.match) return ambiguous("location", i.location_name, r.candidates);
          locationId = r.match.id;
        }
        return repo.insertRecord("project", {
          ...i, account_id: accountId, location_id: locationId,
          owner_id: actor(), skills: i.skills || [],
        }, actor());
      },
    },
    {
      name: "update_project",
      description: "Change fields on a project. The previous version is kept.",
      input_schema: {
        type: "object",
        properties: {
          id: { type: "string" }, name: { type: "string" },
          changes: { type: "object" },
        },
        required: ["changes"],
      },
      run: async (i) => {
        let id = i.id;
        if (!id) {
          if (!i.name) return need("which project to change");
          const r = await resolve("project", i.name);
          if (!r.match) return ambiguous("project", i.name, r.candidates);
          id = r.match.id;
        }
        return repo.updateRecord("project", id, i.changes, actor());
      },
    },

    // ------------------------------------------------------------- activity
    {
      name: "log_activity",
      description:
        "Log an interaction with a person. You do not need to say which hat they were " +
        "wearing - naming a project makes it candidate-side, naming only their employer " +
        "makes it manager-side. The same person keeps one record with both timelines.",
      input_schema: {
        type: "object",
        properties: {
          contact_name: { type: "string" }, contact_id: { type: "string" },
          project_name: { type: "string" }, project_id: { type: "string" },
          account_name: { type: "string" },
          as_role: { type: "string", enum: ["manager", "candidate"],
                     description: "Only set this when the context genuinely is ambiguous." },
          kind: { type: "string",
                  enum: ["note", "call", "email", "meeting", "interview", "submission", "text"] },
          body: { type: "string" },
        },
        required: ["body"],
      },
      run: async (i) => {
        if (!i.body) return need("what to record");
        let contactId = i.contact_id || null;
        if (!contactId && i.contact_name) {
          const r = await resolve("contact", i.contact_name);
          if (!r.match) return ambiguous("person", i.contact_name, r.candidates);
          contactId = r.match.id;
        }
        if (!contactId) return need("who this is about");
        let projectId = i.project_id || null;
        if (!projectId && i.project_name) {
          const r = await resolve("project", i.project_name);
          if (!r.match) return ambiguous("project", i.project_name, r.candidates);
          projectId = r.match.id;
        }
        let accountId = null;
        if (i.account_name) {
          const r = await resolve("account", i.account_name);
          if (!r.match) return ambiguous("account", i.account_name, r.candidates);
          accountId = r.match.id;
        }
        return repo.logActivity({
          contactId, accountId, projectId, asRole: i.as_role || null,
          kind: i.kind || "note", body: i.body, actorId: actor(),
        });
      },
    },

    // ---------------------------------------------------------- submissions
    {
      name: "submission_board",
      description:
        "The pipeline: who is out where, at which stage, and how long it has sat there. " +
        "Use this for 'what is out with the client', 'my pipeline', 'what is stale', " +
        "'who have we got at Globex'. Default is only submissions still in play.",
      input_schema: {
        type: "object",
        properties: {
          mine: { type: "boolean", description: "Only the current user's submissions." },
          account_name: { type: "string" },
          project_name: { type: "string" },
          contact_name: { type: "string" },
          stage: { type: "string",
                   description: "One stage code. Call stage_machine if unsure of the codes." },
          include_closed: { type: "boolean",
                            description: "Include placed, rejected and withdrawn." },
          stale_days: { type: "integer",
                        description: "Only ones that have not moved in this many days." },
        },
      },
      run: async (i) => {
        let accountId = null, projectId = null, contactId = null;
        if (i.account_name) {
          const r = await resolve("account", i.account_name);
          if (!r.match) return ambiguous("account", i.account_name, r.candidates);
          accountId = r.match.id;
        }
        if (i.project_name) {
          const r = await resolve("project", i.project_name);
          if (!r.match) return ambiguous("project", i.project_name, r.candidates);
          projectId = r.match.id;
        }
        if (i.contact_name) {
          const r = await resolve("contact", i.contact_name);
          if (!r.match) return ambiguous("person", i.contact_name, r.candidates);
          contactId = r.match.id;
        }
        const board = await repo.submissionBoard({
          ownerId: i.mine ? actor() : null, accountId, projectId, contactId,
          stage: i.stage || null, openOnly: !i.include_closed,
          staleDays: i.stale_days ?? null,
        });
        return { count: board.length, submissions: board };
      },
    },
    {
      name: "stage_machine",
      description:
        "The stages a submission can be at, which moves are legal from each one, and the " +
        "coded reasons a loss can be recorded under. Read this before moving anything if " +
        "you are unsure what is allowed - the database enforces exactly this and nothing else.",
      input_schema: { type: "object", properties: {} },
      run: async () => repo.stageMachine(),
    },
    {
      name: "get_submission",
      description:
        "One submission in full: where it is, how it got there, every interview, and the " +
        "moves available next. Use this before advancing anything.",
      input_schema: {
        type: "object",
        properties: {
          submission_id: { type: "string" },
          contact_name: { type: "string", description: "With project_name, to look one up." },
          project_name: { type: "string" },
        },
      },
      run: async (i) => {
        let id = i.submission_id || null;
        if (!id) {
          if (!i.contact_name) return need("which submission - a person and a project");
          const c = await resolve("contact", i.contact_name);
          if (!c.match) return ambiguous("person", i.contact_name, c.candidates);
          const found = await repo.submissionBoard({ contactId: c.match.id, openOnly: false });
          if (!found.length) return { error: "not_found",
            message: `${c.match.name} has not been submitted anywhere.` };
          const narrowed = i.project_name
            ? found.filter((s) => s.project_name.toLowerCase()
                .includes(i.project_name.toLowerCase()))
            : found;
          if (narrowed.length !== 1) {
            return { error: "ambiguous",
                     message: "Say which project.",
                     candidates: narrowed.map((s) => ({ submission_id: s.id,
                       project: s.project_name, account: s.account_name, stage: s.stage })) };
          }
          id = narrowed[0].id;
        }
        return repo.submissionHistory(id);
      },
    },
    {
      name: "submit_resource",
      description:
        "Put a resource forward for a project - a resource is what the desk calls a " +
        "person put against a project's need, whether they are new to us or one of our " +
        "consultants being redeployed. Returns the gross margin the rates leave and " +
        "flags a rate outside the project's range. Refuses if another recruiter already " +
        "has that person live at the same client - do not try to work around it, tell " +
        "the user who has them.",
      input_schema: {
        type: "object",
        properties: {
          contact_name: { type: "string" }, contact_id: { type: "string" },
          project_name: { type: "string" }, project_id: { type: "string" },
          pay_rate: { type: "number", description: "What we pay them, per hour." },
          bill_rate: { type: "number", description: "What the client pays us, per hour." },
          burden_pct: { type: "number",
                        description: "Employer burden as a percentage of pay. Ask if unknown." },
          notes: { type: "string", description: "Why this person, for whoever reads it next." },
        },
      },
      run: async (i) => {
        let contactId = i.contact_id || null, projectId = i.project_id || null;
        if (!contactId && i.contact_name) {
          const r = await resolve("contact", i.contact_name);
          if (!r.match) return ambiguous("person", i.contact_name, r.candidates);
          contactId = r.match.id;
        }
        if (!projectId && i.project_name) {
          const r = await resolve("project", i.project_name);
          if (!r.match) return ambiguous("project", i.project_name, r.candidates);
          projectId = r.match.id;
        }
        const missing = [];
        if (!contactId) missing.push("which resource to submit");
        if (!projectId) missing.push("which project");
        if (missing.length) return need(...missing);
        try {
          return await repo.submitCandidate({
            projectId, contactId, payRate: i.pay_rate ?? null, billRate: i.bill_rate ?? null,
            burdenPct: i.burden_pct ?? 0, notes: i.notes || null,
          }, actor());
        } catch (e) { return { error: "refused", message: e.message }; }
      },
    },
    {
      name: "advance_submission",
      description:
        "Move a submission to another stage. Only moves the stage machine allows go " +
        "through; call stage_machine or get_submission to see which those are. Some moves " +
        "need a reason and a loss needs a coded reason as well - the error will say so.",
      input_schema: {
        type: "object",
        properties: {
          submission_id: { type: "string" },
          to_stage: { type: "string" },
          reason: { type: "string", description: "In the user's own words." },
          loss_reason_code: { type: "string",
            description: "Required for rejected and withdrawn. Codes from stage_machine." },
        },
        required: ["submission_id", "to_stage"],
      },
      run: async (i) => {
        if (!i.submission_id) return need("which submission");
        if (!i.to_stage) return need("which stage to move it to");
        try {
          const r = await repo.advanceSubmission(i.submission_id, i.to_stage, i.reason || null,
            { lossReasonCode: i.loss_reason_code || null }, actor());
          return { moved: true, from: r.before.stage, to: r.after.stage,
                   next_moves: await repo.movesFor(i.submission_id) };
        } catch (e) { return { error: "refused", message: e.message }; }
      },
    },
    {
      name: "schedule_interview",
      description:
        "Book an interview on a submission. This moves the submission into the interview " +
        "stage by itself. Rounds are numbered automatically.",
      input_schema: {
        type: "object",
        properties: {
          submission_id: { type: "string" },
          scheduled_at: { type: "string",
            description: "ISO 8601 with a timezone, for example 2026-09-03T15:00:00-07:00." },
          duration_mins: { type: "integer" },
          mode: { type: "string", enum: ["phone", "video", "onsite", "panel"] },
          where_text: { type: "string", description: "A link, a room, or a site address." },
          interviewers: { type: "string", description: "Who from the client is attending." },
          prep_notes: { type: "string", description: "What the candidate should know." },
        },
        required: ["submission_id", "scheduled_at"],
      },
      run: async (i) => {
        const missing = [];
        if (!i.submission_id) missing.push("which submission");
        if (!i.scheduled_at) missing.push("when the interview is");
        if (missing.length) return need(...missing);
        try {
          return await repo.scheduleInterview({
            submissionId: i.submission_id, scheduledAt: i.scheduled_at,
            durationMins: i.duration_mins ?? 60, mode: i.mode || "video",
            whereText: i.where_text || null, interviewers: i.interviewers || null,
            prepNotes: i.prep_notes || null,
          }, actor());
        } catch (e) { return { error: "refused", message: e.message }; }
      },
    },
    {
      name: "record_interview_outcome",
      description:
        "Write down what happened at an interview. This does not move the submission on " +
        "its own: it hands back the moves available so the next step stays a decision " +
        "somebody makes, with a reason attached.",
      input_schema: {
        type: "object",
        properties: {
          interview_id: { type: "string" },
          status: { type: "string",
                    enum: ["completed", "no_show", "cancelled", "rescheduled"] },
          outcome: { type: "string", enum: ["advance", "reject", "hold", "pending"] },
          feedback: { type: "string", description: "What the client actually said." },
        },
        required: ["interview_id"],
      },
      run: async (i) => {
        if (!i.interview_id) return need("which interview");
        try {
          return await repo.recordInterviewOutcome(i.interview_id, {
            status: i.status || "completed", outcome: i.outcome || null,
            feedback: i.feedback || null,
          }, actor());
        } catch (e) { return { error: "refused", message: e.message }; }
      },
    },
    {
      name: "upcoming_interviews",
      description:
        "Interviews booked in the next couple of weeks, and separately the ones that have " +
        "already happened where nobody has recorded the outcome. Good answer to 'what is " +
        "on this week' and 'what am I waiting on'.",
      input_schema: {
        type: "object",
        properties: {
          days: { type: "integer", description: "How far ahead to look. Default 14." },
          mine: { type: "boolean" },
        },
      },
      run: async (i) => {
        const ownerId = i.mine ? actor() : null;
        const [upcoming, awaiting] = await Promise.all([
          repo.upcomingInterviews({ days: i.days ?? 14, ownerId }),
          repo.interviewsAwaitingFeedback({ ownerId }),
        ]);
        return { upcoming, awaiting_feedback: awaiting };
      },
    },
    {
      name: "place_submission",
      description:
        "Turn a submission into a placement: creates the placement and its opening rate, " +
        "then marks the submission placed. This is the handover to payroll and billing, so " +
        "it needs a start date and both rates. Rates default to the ones on the submission.",
      input_schema: {
        type: "object",
        properties: {
          submission_id: { type: "string" },
          start_date: { type: "string", description: "YYYY-MM-DD." },
          end_date: { type: "string", description: "YYYY-MM-DD, if the assignment has one." },
          pay_rate: { type: "number" }, bill_rate: { type: "number" },
          burden_pct: { type: "number" },
        },
        required: ["submission_id", "start_date"],
      },
      run: async (i) => {
        const missing = [];
        if (!i.submission_id) missing.push("which submission");
        if (!i.start_date) missing.push("the start date");
        if (missing.length) return need(...missing);
        try {
          return await repo.placeSubmission({
            submissionId: i.submission_id, startDate: i.start_date,
            endDate: i.end_date || null, payRate: i.pay_rate ?? null,
            billRate: i.bill_rate ?? null, burdenPct: i.burden_pct ?? null,
          }, actor());
        } catch (e) { return { error: "refused", message: e.message }; }
      },
    },
    {
      name: "submission_funnel",
      description:
        "How many submissions ever reached each stage, and how many are sitting at each " +
        "one now, plus why we have been losing. Counts what was reached rather than where " +
        "things ended up, so a rejected candidate still counts towards the interviews " +
        "they got.",
      input_schema: {
        type: "object",
        properties: {
          loss_days: { type: "integer", description: "Window for the loss reasons. Default 90." },
          mine: { type: "boolean" },
        },
      },
      run: async (i) => {
        const [funnel, losses] = await Promise.all([
          repo.submissionFunnel(),
          repo.lossBreakdown({ days: i.loss_days ?? 90, ownerId: i.mine ? actor() : null }),
        ]);
        return { funnel, losses };
      },
    },
    // ------------------------------------------------- documents & paperwork
    {
      name: "search_documents",
      description:
        "Find stored documents - resumes, MSAs, SOWs, Exhibit A rate verifications, POs. " +
        "Full text search across the extracted content, not just the file name. Each " +
        "result links to the filed original in SharePoint where one exists.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string" },
          kind: { type: "string",
            enum: ["resume", "MSA", "SOW", "exhibit_a", "NDA", "RTR", "rate_sheet", "PO",
                   "change_order", "other"] },
          account_name: { type: "string" }, contact_name: { type: "string" },
          limit: { type: "integer", default: 25 },
        },
      },
      run: async (i) => {
        let accountId = null, contactId = null;
        if (i.account_name) {
          const r = await resolve("account", i.account_name);
          if (!r.match) return ambiguous("account", i.account_name, r.candidates);
          accountId = r.match.id;
        }
        if (i.contact_name) {
          const r = await resolve("contact", i.contact_name);
          if (!r.match) return ambiguous("person", i.contact_name, r.candidates);
          contactId = r.match.id;
        }
        return repo.searchDocuments({
          q: i.query || null, kind: i.kind || null, accountId, contactId,
          limit: i.limit || 25 });
      },
    },
    {
      name: "po_burndown",
      description:
        "Purchase order burn-down. A PO is burned by what we have INVOICED, not by what " +
        "our people worked, so the numbers are separate and all of them come back: " +
        "invoiced (the burn), paid and outstanding, drafted_not_sent (an invoice we " +
        "prepared but have not issued), approved_unbilled (work the client accepted that " +
        "we have not billed yet - earned revenue sitting in our own queue), " +
        "submitted_pending (time claimed but not yet approved - not earned), remaining " +
        "(amount minus invoiced) and projected_remaining (what is left once the approved " +
        "backlog is billed). A negative projected_remaining means the PO is already spent " +
        "even though it does not look it. Use at_risk to find exactly those.",
      input_schema: {
        type: "object",
        properties: {
          project_name: { type: "string" }, account_name: { type: "string" },
          expiring_within_days: { type: "integer" },
          at_risk: { type: "boolean",
            description: "Only POs already over-committed, or expiring within 45 days " +
                         "with unbilled work against them." },
        },
      },
      run: async (i) => {
        let projectId = null;
        if (i.project_name) {
          const r = await resolve("project", i.project_name);
          if (!r.match) return ambiguous("project", i.project_name, r.candidates);
          projectId = r.match.id;
        }
        return repo.poBurndown({
          projectId, accountName: i.account_name || null,
          expiringDays: i.expiring_within_days ?? null, atRisk: !!i.at_risk });
      },
    },
    {
      name: "list_timesheets",
      description:
        "Weekly timesheets. A consultant fills in one a week and allocates their hours " +
        "across whatever projects and purchase orders they worked on. Status is draft " +
        "(still being filled in), submitted (waiting on the client), partly_approved (one " +
        "manager has signed off and another has not), approved, or rejected.",
      input_schema: {
        type: "object",
        properties: {
          consultant_name: { type: "string" },
          status: { type: "string",
            enum: ["draft", "submitted", "partly_approved", "approved", "rejected"] },
          week_ending: { type: "string", description: "YYYY-MM-DD" },
        },
      },
      run: async (i) => {
        let contactId = null;
        if (i.consultant_name) {
          const r = await resolve("contact", i.consultant_name);
          if (!r.match) return ambiguous("person", i.consultant_name, r.candidates);
          contactId = r.match.id;
        }
        return repo.listTimesheets({
          contactId, status: i.status || null, weekEnding: i.week_ending || null });
      },
    },
    {
      name: "get_timesheet",
      description:
        "One week in full: every day, what each day was charged to, what it is worth, " +
        "and where each project's part sits in approval.",
      input_schema: {
        type: "object",
        properties: {
          timesheet_id: { type: "string" },
          consultant_name: { type: "string" },
          week_ending: { type: "string", description: "YYYY-MM-DD" },
        },
      },
      run: async (i) => {
        let id = i.timesheet_id;
        if (!id) {
          if (!i.consultant_name || !i.week_ending)
            return need("whose week, and which week ending date");
          const r = await resolve("contact", i.consultant_name);
          if (!r.match) return ambiguous("person", i.consultant_name, r.candidates);
          const ts = await one(
            `select id from timesheet where contact_id = $1 and week_ending = $2::date`,
            [r.match.id, i.week_ending]);
          if (!ts) return { error: "not_found",
                            message: `No timesheet for that person, week ending ${i.week_ending}.` };
          id = ts.id;
        }
        return (await repo.getTimesheet(id)) || { error: "not_found" };
      },
    },
    {
      name: "allocation_targets",
      description:
        "What a consultant is allowed to charge to in a given week - every placement " +
        "they hold and the open purchase orders on each. Call this before entering time " +
        "so the allocation lands on something real.",
      input_schema: {
        type: "object",
        properties: {
          consultant_name: { type: "string" },
          week_ending: { type: "string", description: "YYYY-MM-DD" },
        },
        required: ["consultant_name", "week_ending"],
      },
      run: async (i) => {
        const r = await resolve("contact", i.consultant_name);
        if (!r.match) return ambiguous("person", i.consultant_name, r.candidates);
        return repo.allocationTargets(r.match.id, i.week_ending);
      },
    },
    {
      name: "enter_time",
      description:
        "Enter or replace a consultant's week. Give every day they worked with the " +
        "placement and purchase order it goes against - a day can appear more than once " +
        "if it was split across projects. This replaces the whole week, so send all of " +
        "it, not just the changes. Call allocation_targets first to get the placement ids.",
      input_schema: {
        type: "object",
        properties: {
          consultant_name: { type: "string" },
          week_ending: { type: "string", description: "The Sunday, YYYY-MM-DD" },
          entries: {
            type: "array",
            items: {
              type: "object",
              properties: {
                placement_id: { type: "string" },
                purchase_order_id: { type: "string" },
                work_date: { type: "string", description: "YYYY-MM-DD" },
                hours: { type: "number" },
                ot_hours: { type: "number" },
                notes: { type: "string" },
              },
              required: ["placement_id", "work_date", "hours"],
            },
          },
          submit: { type: "boolean",
                    description: "Submit it for approval straight away." },
        },
        required: ["consultant_name", "week_ending", "entries"],
      },
      run: async (i) => {
        const r = await resolve("contact", i.consultant_name);
        if (!r.match) return ambiguous("person", i.consultant_name, r.candidates);
        if (!i.entries?.length) return need("which days and how many hours on each");
        const ts = await repo.getOrCreateTimesheet(r.match.id, i.week_ending, actor());
        await repo.saveTimesheet(ts.id, i.entries, actor());
        if (i.submit) await repo.submitTimesheet(ts.id, actor());
        return repo.getTimesheet(ts.id);
      },
    },
    {
      name: "submit_timesheet",
      description:
        "Send a week to the client for approval. One approval packet is created per " +
        "project the week touches, each routed to that project's approving manager, so " +
        "two managers can sign off independently.",
      input_schema: {
        type: "object",
        properties: {
          timesheet_id: { type: "string" },
          consultant_name: { type: "string" },
          week_ending: { type: "string" },
        },
      },
      run: async (i) => {
        let id = i.timesheet_id;
        if (!id) {
          if (!i.consultant_name || !i.week_ending)
            return need("whose week, and which week ending date");
          const r = await resolve("contact", i.consultant_name);
          if (!r.match) return ambiguous("person", i.consultant_name, r.candidates);
          const ts = await one(
            `select id from timesheet where contact_id = $1 and week_ending = $2::date`,
            [r.match.id, i.week_ending]);
          if (!ts) return { error: "not_found", message: "No timesheet for that week." };
          id = ts.id;
        }
        return repo.submitTimesheet(id, actor());
      },
    },
    {
      name: "approval_queue",
      description:
        "Time waiting on client managers. Each row is one project's part of one " +
        "consultant's week, with the hours, what it is worth, and who is meant to " +
        "approve it. A row with no approver named is a routing gap somebody has to fix.",
      input_schema: {
        type: "object",
        properties: {
          approver_name: { type: "string", description: "One client manager's queue." },
          account_name: { type: "string" }, project_name: { type: "string" },
          status: { type: "string", enum: ["pending", "approved", "rejected"] },
        },
      },
      run: async (i) => {
        let approverId = null, projectId = null, accountId = null;
        if (i.approver_name) {
          const r = await resolve("contact", i.approver_name);
          if (!r.match) return ambiguous("person", i.approver_name, r.candidates);
          approverId = r.match.id;
        }
        if (i.project_name) {
          const r = await resolve("project", i.project_name);
          if (!r.match) return ambiguous("project", i.project_name, r.candidates);
          projectId = r.match.id;
        }
        if (i.account_name) {
          const r = await resolve("account", i.account_name);
          if (!r.match) return ambiguous("account", i.account_name, r.candidates);
          accountId = r.match.id;
        }
        return repo.approvalQueue({
          approverContactId: approverId, projectId, accountId,
          status: i.status || "pending" });
      },
    },
    {
      name: "decide_timesheet",
      description:
        "Record a client manager's decision on their part of a week. Approving freezes " +
        "what those days are worth at the rate in force on each day and makes them " +
        "billable. Rejecting releases the value and sends the week back to the " +
        "consultant to correct. Needs the name of the manager who decided.",
      input_schema: {
        type: "object",
        properties: {
          approval_id: { type: "string",
                         description: "From approval_queue." },
          decision: { type: "string", enum: ["approved", "rejected"] },
          decided_by: { type: "string",
                        description: "The client-side manager who signed off." },
          note: { type: "string", description: "Required in practice on a rejection." },
        },
        required: ["approval_id", "decision", "decided_by"],
      },
      run: async (i) => {
        const missing = [];
        if (!i.approval_id) missing.push("which week and project");
        if (!i.decision) missing.push("approved or rejected");
        if (!i.decided_by) missing.push("which manager at the client decided");
        if (missing.length) return need(...missing);
        return repo.decideApproval(i.approval_id, i.decision, i.decided_by,
                                   i.note || null, actor());
      },
    },
    {
      name: "set_project_approvers",
      description:
        "Name the client managers who may approve time on a project. They have to be " +
        "existing manager contacts on that account. The first one is the primary, and " +
        "is who submitted time routes to.",
      input_schema: {
        type: "object",
        properties: {
          project_name: { type: "string" }, project_id: { type: "string" },
          approver_names: { type: "array", items: { type: "string" } },
        },
        required: ["approver_names"],
      },
      run: async (i) => {
        let projectId = i.project_id;
        if (!projectId) {
          if (!i.project_name) return need("which project");
          const r = await resolve("project", i.project_name);
          if (!r.match) return ambiguous("project", i.project_name, r.candidates);
          projectId = r.match.id;
        }
        const ids = [];
        for (const nm of i.approver_names || []) {
          const r = await resolve("contact", nm);
          if (!r.match) return ambiguous("person", nm, r.candidates);
          ids.push(r.match.id);
        }
        if (!ids.length) return need("who should approve time on it");
        return repo.setProjectApprovers(projectId, ids, actor());
      },
    },
    {
      name: "draft_invoice",
      description:
        "Draft an invoice from approved time that has not been billed yet. This is the " +
        "only route from worked time to an invoice: it cannot pick up time the client has " +
        "not approved, and it cannot pick up a week that is already on a live invoice. " +
        "The draft does not burn the PO - sending it does.",
      input_schema: {
        type: "object",
        properties: {
          po_number: { type: "string" }, project_name: { type: "string" },
          through_week: { type: "string",
                          description: "Bill everything up to this week ending, YYYY-MM-DD." },
          terms: { type: "integer", description: "Payment terms in days. Default 45." },
          notes: { type: "string" },
        },
      },
      run: async (i) => {
        let poId = null, projectId = null;
        if (i.po_number) {
          const po = await one(
            `select id from purchase_order where po_number ilike '%'||$1||'%'`,
            [i.po_number]);
          if (!po) return { error: "not_found", message: `No PO matching ${i.po_number}.` };
          poId = po.id;
        }
        if (i.project_name) {
          const r = await resolve("project", i.project_name);
          if (!r.match) return ambiguous("project", i.project_name, r.candidates);
          projectId = r.match.id;
        }
        if (!poId && !projectId) return need("which PO or project to bill");
        return repo.draftInvoiceFromApproved({
          purchaseOrderId: poId, projectId, throughWeek: i.through_week || null,
          terms: i.terms ?? 45, notes: i.notes || null }, actor());
      },
    },
    {
      name: "send_invoice",
      description:
        "Issue a drafted invoice to the client. This is the moment it burns the purchase " +
        "order. If it would take the PO past its committed amount the database refuses it " +
        "and the error says so - the remedy is a change order or a new PO, not a smaller " +
        "invoice.",
      input_schema: {
        type: "object",
        properties: {
          invoice_number: { type: "string" }, invoice_id: { type: "string" },
          issue_date: { type: "string", description: "YYYY-MM-DD. Defaults to today." },
        },
      },
      run: async (i) => {
        const id = i.invoice_id || (await invoiceIdFromNumber(i.invoice_number));
        if (!id) return need("which invoice to send");
        if (id.error) return id;
        return repo.sendInvoice(id, i.issue_date || null, actor());
      },
    },
    {
      name: "record_payment",
      description: "Record money received against an invoice. Settles it when the balance " +
        "reaches zero, otherwise marks it part paid.",
      input_schema: {
        type: "object",
        properties: {
          invoice_number: { type: "string" }, invoice_id: { type: "string" },
          amount: { type: "number" },
          received_at: { type: "string", description: "YYYY-MM-DD" },
          method: { type: "string" }, reference: { type: "string" },
        },
        required: ["amount"],
      },
      run: async (i) => {
        const id = i.invoice_id || (await invoiceIdFromNumber(i.invoice_number));
        if (!id) return need("which invoice this payment is against");
        if (id.error) return id;
        return repo.recordPayment({
          invoiceId: id, amount: i.amount, receivedAt: i.received_at || null,
          method: i.method || null, reference: i.reference || null }, actor());
      },
    },
    {
      name: "list_invoices",
      description:
        "Invoices with their totals, what has been paid and what is outstanding. " +
        "A draft has not been issued and owes nothing yet.",
      input_schema: {
        type: "object",
        properties: {
          account_name: { type: "string" }, project_name: { type: "string" },
          po_number: { type: "string" },
          status: { type: "string",
                    enum: ["draft", "sent", "part_paid", "paid", "void"] },
          overdue: { type: "boolean" },
        },
      },
      run: async (i) => {
        let accountId = null, projectId = null, poId = null;
        if (i.account_name) {
          const r = await resolve("account", i.account_name);
          if (!r.match) return ambiguous("account", i.account_name, r.candidates);
          accountId = r.match.id;
        }
        if (i.project_name) {
          const r = await resolve("project", i.project_name);
          if (!r.match) return ambiguous("project", i.project_name, r.candidates);
          projectId = r.match.id;
        }
        if (i.po_number) {
          const po = await one(
            `select id from purchase_order where po_number ilike '%'||$1||'%'`,
            [i.po_number]);
          poId = po?.id ?? null;
        }
        return repo.listInvoices({
          accountId, projectId, poId, status: i.status || null,
          overdueOnly: !!i.overdue });
      },
    },
    {
      name: "get_invoice",
      description: "One invoice in full: every line, which week of time each line bills, " +
        "and every payment received against it.",
      input_schema: {
        type: "object",
        properties: { invoice_number: { type: "string" }, invoice_id: { type: "string" } },
      },
      run: async (i) => {
        const id = i.invoice_id || (await invoiceIdFromNumber(i.invoice_number));
        if (!id) return need("which invoice");
        if (id.error) return id;
        return (await repo.getInvoice(id)) || { error: "not_found" };
      },
    },
    {
      name: "invoice_aging",
      description:
        "What clients owe us and how late it is, in the standard buckets: current, " +
        "1-30, 31-60, 61-90, 90+. Drafts are excluded because nobody owes us anything " +
        "until an invoice is issued.",
      input_schema: {
        type: "object",
        properties: { account_name: { type: "string" } },
      },
      run: async (i) => repo.invoiceAging({ accountName: i.account_name || null }),
    },

    // ------------------------------------------------------------- pipelines
    {
      name: "tag_to_pipeline",
      description:
        "Add someone to one of the current user's named pipelines, creating the pipeline " +
        "if it does not exist. This is how a recruiter remembers a person without owning " +
        "them - general candidates belong to the house, not to an individual.",
      input_schema: {
        type: "object",
        properties: {
          pipeline: { type: "string" },
          contact_name: { type: "string" }, contact_id: { type: "string" },
          note: { type: "string" },
        },
        required: ["pipeline"],
      },
      run: async (i) => {
        let contactId = i.contact_id || null;
        if (!contactId && i.contact_name) {
          const r = await resolve("contact", i.contact_name);
          if (!r.match) return ambiguous("person", i.contact_name, r.candidates);
          contactId = r.match.id;
        }
        if (!contactId) return need("who to add");
        return repo.addToPipeline(i.pipeline, actor(), contactId, i.note || null);
      },
    },
    {
      name: "get_pipeline",
      description: "Everyone in one of the current user's named pipelines.",
      input_schema: {
        type: "object",
        properties: { pipeline: { type: "string" } },
        required: ["pipeline"],
      },
      run: async (i) => repo.getPipeline(actor(), i.pipeline),
    },

    // --------------------------------------------------------------- system
    {
      name: "list_users",
      description:
        "Workspace users. Owners are chosen from this list and nowhere else, so call " +
        "this before assigning ownership.",
      input_schema: { type: "object", properties: {} },
      run: async () => repo.listUsers(),
    },
    {
      name: "record_history",
      description:
        "Every version of one record, newest first, with what changed, who changed it, " +
        "when, and why if a reason was given. Written by a database trigger, so it " +
        "covers every write however it was made.",
      input_schema: {
        type: "object",
        properties: {
          table: { type: "string",
            enum: ["account", "location", "contact", "project", "submission", "placement",
                   "purchase_order", "timesheet", "timesheet_entry", "timesheet_approval",
                   "invoice", "invoice_line", "payment", "unlock_request", "document"] },
          id: { type: "string" },
        },
        required: ["table", "id"],
      },
      run: async (i) => repo.revisionsFor(i.table, i.id),
    },
    {
      name: "audit_trail",
      description:
        "The audit trail across the whole system: every insert, update and delete on " +
        "every table, with the acting user, what fields changed, and the transaction " +
        "that did it. Use this for 'who changed X', 'what did someone do today', or " +
        "'show me everything that happened to this account'. Written by database " +
        "triggers, so nothing can write without appearing here.",
      input_schema: {
        type: "object",
        properties: {
          table: { type: "string" },
          record_id: { type: "string" },
          actor_name: { type: "string", description: "One workspace user's activity." },
          action: { type: "string", enum: ["insert", "update", "delete"] },
          since: { type: "string", description: "ISO timestamp or date." },
          query: { type: "string", description: "Free text against the changed data." },
          limit: { type: "integer", default: 100 },
        },
      },
      run: async (i) => {
        let actorId = null;
        if (i.actor_name) {
          const u = await one(
            `select id from app_user where full_name ilike '%'||$1||'%' limit 1`,
            [i.actor_name]);
          if (!u) return { error: "not_found",
                           message: `No workspace user matching ${i.actor_name}.` };
          actorId = u.id;
        }
        return repo.auditTrail({
          table: i.table || null, recordId: i.record_id || null, actorId,
          action: i.action || null, since: i.since || null, q: i.query || null,
          limit: i.limit || 100 });
      },
    },
    {
      name: "request_unlock",
      description:
        "Ask for approved time to be unlocked so it can be corrected. Approved days are " +
        "locked and cannot be changed by anyone, including the consultant who entered " +
        "them. An admin has to grant this, and cannot grant their own request. Give a " +
        "real reason - the admin deciding will read it.",
      input_schema: {
        type: "object",
        properties: {
          approval_id: { type: "string", description: "From approval_queue." },
          reason: { type: "string" },
        },
        required: ["approval_id", "reason"],
      },
      run: async (i) => {
        const missing = [];
        if (!i.approval_id) missing.push("which approved week and project");
        if (!i.reason || i.reason.trim().length <= 5)
          missing.push("why it needs to be unlocked");
        if (missing.length) return need(...missing);
        return repo.requestUnlock(
          { approvalId: i.approval_id, reason: i.reason }, actor());
      },
    },
    {
      name: "list_unlock_requests",
      description:
        "Requests to unlock approved time. Each shows what is at stake: the value of " +
        "the week and whether any of it has already gone out on an invoice.",
      input_schema: {
        type: "object",
        properties: {
          status: { type: "string",
                    enum: ["pending", "granted", "denied", "used", "withdrawn"] },
        },
      },
      run: async (i) => repo.listUnlockRequests({ status: i.status || "pending" }),
    },
    {
      name: "decide_unlock",
      description:
        "Grant or deny an unlock request. Only an admin can, and not their own request - " +
        "the database enforces both. Granting is refused outright if the time has " +
        "already been invoiced; void or credit the invoice first.",
      input_schema: {
        type: "object",
        properties: {
          request_id: { type: "string" },
          decision: { type: "string", enum: ["granted", "denied"] },
          note: { type: "string" },
        },
        required: ["request_id", "decision"],
      },
      run: async (i) => {
        if (!i.request_id || !i.decision) return need("which request, and the decision");
        return repo.decideUnlock(i.request_id, i.decision, actor(), i.note || null);
      },
    },
    {
      name: "reopen_approved_time",
      description:
        "Spend a granted unlock: put an approved week back to pending so it can be " +
        "corrected. This releases the frozen values on those days. Refused unless an " +
        "admin has granted an unlock for it, and the grant is used up afterwards.",
      input_schema: {
        type: "object",
        properties: { approval_id: { type: "string" } },
        required: ["approval_id"],
      },
      run: async (i) => {
        if (!i.approval_id) return need("which approved week and project");
        return repo.reopenApproval(i.approval_id, actor());
      },
    },
    {
      name: "describe_schema",
      description:
        "The live database structure - tables, columns, types and row counts - read from " +
        "the database itself. Use this before writing a sql_query so the query matches " +
        "what is actually there.",
      input_schema: {
        type: "object",
        properties: { table: { type: "string", description: "Omit for all tables." } },
      },
      run: async (i) => describeSchema(i.table || null),
    },
    {
      name: "sql_query",
      description:
        "Run a read-only SQL SELECT against the workspace database when no other tool " +
        "answers the question - aggregates, ranked lists, joins across several entities. " +
        "The connection holds a SELECT-only role, so a write is refused by the database. " +
        "Call describe_schema first if you are unsure of a column. Useful views: " +
        "po_burndown. Useful functions: gross_margin(pay,bill,burden_pct) and " +
        "gross_margin_pct(...) - always use these rather than computing margin yourself.",
      input_schema: {
        type: "object",
        properties: {
          sql: { type: "string", description: "A single SELECT or WITH statement." },
          purpose: { type: "string",
                     description: "One line on what this is meant to answer. Shown in the trace." },
        },
        required: ["sql"],
      },
      run: async (i) => runReadOnlySql(i.sql),
    },
  ];

  return T;
}

async function invoiceIdFromNumber(number) {
  if (!number) return null;
  const inv = await one(
    `select id from invoice where invoice_number ilike '%'||$1||'%'`, [number]);
  return inv ? inv.id
             : { error: "not_found", message: `No invoice matching ${number}.` };
}

export async function describeSchema(table = null) {
  const cols = await rows(
    `select c.table_name, c.column_name, c.data_type, c.is_nullable, c.column_default
       from information_schema.columns c
       join information_schema.tables t
         on t.table_name = c.table_name and t.table_schema = c.table_schema
      where c.table_schema = 'public' and ($1::text is null or c.table_name = $1)
      order by c.table_name, c.ordinal_position`, [table]);
  const kinds = await rows(
    `select table_name, table_type from information_schema.tables
      where table_schema = 'public'`);
  const kindOf = Object.fromEntries(kinds.map((k) => [k.table_name, k.table_type]));
  const out = {};
  for (const c of cols) {
    (out[c.table_name] ||= { type: kindOf[c.table_name] || "BASE TABLE", columns: [] })
      .columns.push({
        name: c.column_name, type: c.data_type,
        nullable: c.is_nullable === "YES",
        default: c.column_default,
      });
  }
  return out;
}

// The SQL guard. The database grant is the real defence; these checks exist to
// give the model a clear, immediate error rather than a permissions failure
// halfway through, and to stop a single runaway statement.
const FORBIDDEN = /\b(insert|update|delete|drop|alter|create|grant|revoke|truncate|copy|vacuum|call|do)\b/i;

export async function runReadOnlySql(sql) {
  const text = String(sql || "").trim().replace(/;\s*$/, "");
  if (!text) return { error: "empty query" };
  if (!/^\s*(select|with)\b/i.test(text))
    return { error: "only SELECT and WITH statements are allowed" };
  if (text.includes(";"))
    return { error: "one statement at a time" };
  if (FORBIDDEN.test(text))
    return { error: "this connection is read-only; that keyword is not permitted" };
  const capped = /\blimit\s+\d+\s*$/i.test(text) ? text : `${text} limit 200`;
  try {
    const res = await rows(capped, [], { ro: true, label: "assistant sql" });
    return { row_count: res.length, rows: res,
             truncated: res.length === 200 ? "showing the first 200 rows" : undefined };
  } catch (e) {
    return { error: e.message, hint: "Call describe_schema to check names, then retry." };
  }
}

export function toolSchemas(tools) {
  return tools.map(({ name, description, input_schema }) =>
    ({ name, description, input_schema }));
}
