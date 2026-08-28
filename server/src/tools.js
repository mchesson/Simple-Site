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
        "Purchase order burn-down: committed amount, what approved time has burned, what " +
        "is submitted but not yet approved, what is left, and days until the PO expires. " +
        "Use expiring_within_days to find POs about to run out.",
      input_schema: {
        type: "object",
        properties: {
          project_name: { type: "string" }, account_name: { type: "string" },
          expiring_within_days: { type: "integer" },
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
          expiringDays: i.expiring_within_days ?? null });
      },
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
        "Every past version of one record, newest first, with who changed it and when. " +
        "Nothing in this workspace is overwritten, so this always answers 'what did this " +
        "look like before'.",
      input_schema: {
        type: "object",
        properties: {
          table: { type: "string",
            enum: ["account", "location", "contact", "project", "submission", "placement",
                   "purchase_order", "timecard", "document"] },
          id: { type: "string" },
        },
        required: ["table", "id"],
      },
      run: async (i) => repo.revisionsFor(i.table, i.id),
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
