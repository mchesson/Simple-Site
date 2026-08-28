// Business operations.
//
// Reads are plain queries. Writes all go through insertRecord / updateRecord /
// archiveRecord so that three things happen without anyone having to remember:
// the previous version is kept, a domain event is appended, and the whole thing
// is one transaction.

import { rows, one, tx, query } from "./db.js";
import { currentTrace, step } from "./trace.js";
import { withReason, withActing } from "./context.js";

// Columns a caller is allowed to set, per table. An allow-list rather than a
// deny-list: a new column is invisible to the API until it is named here, which
// is the failure direction we want.
const WRITABLE = {
  account: ["name","status","industry","website","bg_check_policy","drug_test_policy",
            "onboarding_notes","notes"],
  location: ["account_id","name","address1","address2","city","state","postal_code",
             "country","rules_of_engagement","bg_check_notes","drug_test_notes"],
  contact: ["full_name","email","phone","title","is_manager","is_candidate","account_id",
            "location_id","headline","skills","location_text","on_payroll","recruiter_id",
            "source","notes"],
  project: ["account_id","location_id","name","delivery_type","status","openings",
            "bill_rate_min","bill_rate_max","pay_rate_min","pay_rate_max","start_date",
            "end_date","description","skills","owner_id"],
  submission: ["project_id","contact_id","stage","submitted_by","pay_rate","bill_rate",
               "burden_pct","loss_reason_code","notes"],
  placement: ["project_id","contact_id","status","start_date","end_date","recruiter_id",
              "submission_id"],
  interview: ["submission_id","round","scheduled_at","duration_mins","mode","where_text",
              "interviewers","status","outcome","feedback","prep_notes","arranged_by"],
  agreement: ["account_id","location_id","kind","status","effective_from","effective_to","terms_notes"],
  rate_verification: ["project_id","contact_id","placement_id","status","pay_rate","bill_rate",
                      "start_date","end_date","confirmed_by","confirmed_at"],
  sow: ["project_id","title","status","start_date","end_date","total_value","deliverables"],
  purchase_order: ["project_id","sow_id","po_number","amount","currency","start_date",
                   "end_date","status","notes"],
  timesheet: ["contact_id","week_ending","status","submitted_at","notes"],
  timesheet_entry: ["timesheet_id","placement_id","project_id","purchase_order_id",
                    "work_date","hours","ot_hours","notes"],
  timesheet_approval: ["timesheet_id","project_id","approver_contact_id","status",
                       "decided_at","decided_by","note"],
  invoice: ["invoice_number","account_id","project_id","purchase_order_id","status",
            "issue_date","due_date","terms_days","period_start","period_end","notes"],
  invoice_line: ["invoice_id","kind","timesheet_entry_id","description","quantity",
                 "unit_rate","amount","sort_order"],
  payment: ["invoice_id","amount","received_at","method","reference"],
  document: ["kind","title","account_id","location_id","project_id","contact_id",
             "sharepoint_url","sharepoint_path","content_text","mime_type","byte_size","uploaded_by"],
  pipeline: ["owner_id","name","project_id","notes"],
  unlock_request: ["approval_id","requested_by","reason","status","decided_by",
                   "decision_note","expires_at"],
};

const HAS_UPDATED_AT = new Set(["account","location","contact","project","submission",
  "placement","interview","agreement","rate_verification","sow","purchase_order","timesheet",
  "timesheet_entry","invoice","conversation"]);

function pick(table, data) {
  const allowed = WRITABLE[table];
  if (!allowed) throw new Error(`table ${table} is not writable through the API`);
  const out = {};
  for (const [k, v] of Object.entries(data || {})) {
    if (v === undefined) continue;
    if (allowed.includes(k)) out[k] = v;
  }
  return out;
}

async function recordEvent(t, kind, subjectType, subjectId, payload, actorId) {
  const trace = currentTrace();
  await t.query(
    `insert into domain_event (kind, subject_type, subject_id, payload, actor_id, trace_id)
     values ($1,$2,$3,$4,$5,$6)`,
    [kind, subjectType, subjectId, payload || {}, actorId || null, trace ? trace.id : null],
  );
}

export async function insertRecord(table, data, actorId = null) {
  const cols = pick(table, data);
  const keys = Object.keys(cols);
  if (!keys.length) throw new Error("nothing to insert");
  const names = keys.map((k) => `"${k}"`).join(", ");
  const holes = keys.map((_, i) => `$${i + 1}`).join(", ");
  return tx(async (t) => {
    const row = await t.one(
      `insert into "${table}" (${names}) values (${holes}) returning *`,
      keys.map((k) => cols[k]),
    );
    await recordEvent(t, `${table}.created`, table, row.id, { fields: keys }, actorId);
    return row;
  });
}

// The non-destructive update. The previous version is kept - by an audit
// trigger on the table itself, not by this function - so "make changes without
// deleting the data" holds no matter which code path did the writing.
export async function updateRecord(table, id, changes, actorId = null) {
  const cols = pick(table, changes);
  const keys = Object.keys(cols);
  if (!keys.length) throw new Error("no recognised fields to change");
  return tx(async (t) => {
    const before = await t.one(`select * from "${table}" where id = $1 for update`, [id]);
    if (!before) throw new Error(`${table} ${id} not found`);
    const sets = keys.map((k, i) => `"${k}" = $${i + 2}`);
    if (HAS_UPDATED_AT.has(table)) sets.push("updated_at = now()");
    const after = await t.one(
      `update "${table}" set ${sets.join(", ")} where id = $1 returning *`,
      [id, ...keys.map((k) => cols[k])],
    );
    const changed = keys.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
    await recordEvent(t, `${table}.updated`, table, id, { changed }, actorId);
    return { before, after, changed };
  });
}

// Archiving, not deleting. Rows never leave.
export async function archiveRecord(table, id, actorId = null) {
  return tx(async (t) => {
    const before = await t.one(`select * from "${table}" where id = $1`, [id]);
    if (!before) throw new Error(`${table} ${id} not found`);
    const after = await t.one(
      `update "${table}" set archived_at = now() where id = $1 returning *`, [id]);
    await recordEvent(t, `${table}.archived`, table, id, {}, actorId);
    return after;
  });
}

export async function revisionsFor(table, id, limit = 50) {
  return rows(
    `select a.id, a.action, a.changed, a.before, a.after, a.reason, a.trace_id,
            a.txid, a.occurred_at, coalesce(u.full_name, a.actor_label) as changed_by
       from audit_log a left join app_user u on u.id = a.actor_id
      where a.table_name = $1 and a.record_id = $2
      order by a.id desc limit $3`, [table, id, limit]);
}

// The audit trail across everything, for the times the question is "what
// happened here" rather than "what happened to this record".
export async function auditTrail({ table = null, recordId = null, actorId = null,
                                   action = null, since = null, q = null,
                                   limit = 100 } = {}) {
  return rows(
    `select a.id, a.table_name, a.record_id, a.action, a.changed, a.reason,
            a.trace_id, a.txid, a.occurred_at,
            coalesce(u.full_name, a.actor_label, 'unattributed') as actor,
            -- A readable handle on the row, so a log line is not just a uuid.
            coalesce(a.after ->> 'name', a.after ->> 'full_name',
                     a.after ->> 'invoice_number', a.after ->> 'po_number',
                     a.after ->> 'title', a.before ->> 'name',
                     a.before ->> 'full_name') as label
       from audit_log a left join app_user u on u.id = a.actor_id
      where ($1::text is null or a.table_name = $1)
        and ($2::uuid is null or a.record_id = $2)
        and ($3::uuid is null or a.actor_id = $3)
        and ($4::text is null or a.action = $4)
        and ($5::timestamptz is null or a.occurred_at >= $5)
        and ($6::text is null or a.table_name ilike '%'||$6||'%'
             or a.after::text ilike '%'||$6||'%')
      order by a.id desc limit $7`,
    [table, recordId, actorId, action, since, q, limit]);
}

// Everything one transaction did, which is how a single user action reads when
// it touched five tables.
export async function auditTransaction(txid) {
  return rows(
    `select a.*, coalesce(u.full_name, a.actor_label) as actor
       from audit_log a left join app_user u on u.id = a.actor_id
      where a.txid = $1 order by a.id`, [txid]);
}

// ---------------------------------------------------------------- read models

export async function listUsers() {
  return rows(`select id, email, full_name, role, active from app_user
                where active order by full_name`);
}

export async function listAccounts({ q = null, ownerId = null, unassigned = false,
                                     status = null, limit = 50 } = {}) {
  return rows(
    `select a.id, a.name, a.status, a.industry,
            coalesce(o.owners, '[]'::jsonb) as owners,
            (select count(*)::int from location l where l.account_id = a.id
               and l.archived_at is null) as location_count,
            (select count(*)::int from contact c where c.account_id = a.id
               and c.is_manager and c.archived_at is null) as manager_count,
            (select count(*)::int from project p where p.account_id = a.id
               and p.status = 'open' and p.archived_at is null) as open_projects
       from account a
       left join lateral (
         select jsonb_agg(jsonb_build_object('user_id', u.id, 'name', u.full_name,
                                             'role', ao.role, 'split_pct', ao.split_pct)) as owners
           from account_owner ao join app_user u on u.id = ao.user_id
          where ao.account_id = a.id
       ) o on true
      where a.archived_at is null
        and ($1::text is null or a.name ilike '%' || $1 || '%')
        and ($2::uuid is null or exists (select 1 from account_owner ao2
              where ao2.account_id = a.id and ao2.user_id = $2))
        and (not $3::boolean or not exists (select 1 from account_owner ao3
              where ao3.account_id = a.id))
        and ($4::text is null or a.status = $4)
      order by a.name limit $5`,
    [q, ownerId, unassigned, status, limit]);
}

export async function getAccount(id) {
  const account = await one(`select * from account where id = $1`, [id]);
  if (!account) return null;
  const [owners, locations, contacts, projects, agreements, documents] = await Promise.all([
    rows(`select u.id as user_id, u.full_name, u.email, ao.role, ao.split_pct
            from account_owner ao join app_user u on u.id = ao.user_id
           where ao.account_id = $1 order by u.full_name`, [id]),
    rows(`select * from location where account_id = $1 and archived_at is null
           order by name`, [id]),
    rows(`select id, full_name, title, email, phone, is_manager, is_candidate, location_id
            from contact where account_id = $1 and archived_at is null order by full_name`, [id]),
    rows(`select id, name, delivery_type, status, openings, start_date
            from project where account_id = $1 and archived_at is null
           order by created_at desc`, [id]),
    rows(`select * from agreement where account_id = $1 order by kind`, [id]),
    rows(`select id, kind, title, sharepoint_url, created_at from document
           where account_id = $1 and archived_at is null order by created_at desc`, [id]),
  ]);
  return { ...account, owners, locations, contacts, projects, agreements, documents };
}

export async function setAccountOwners(accountId, owners, actorId = null) {
  return tx(async (t) => {
    const valid = await t.rows(
      `select id from app_user where id = any($1::uuid[]) and active`,
      [owners.map((o) => o.user_id)]);
    const validIds = new Set(valid.map((v) => v.id));
    const unknown = owners.filter((o) => !validIds.has(o.user_id));
    if (unknown.length) {
      // Owners come from the user list or not at all.
      throw new Error(
        `not workspace users: ${unknown.map((u) => u.user_id).join(", ")}`);
    }
    const before = await t.rows(
      `select user_id, role, split_pct from account_owner where account_id = $1`, [accountId]);
    await t.query(`delete from account_owner where account_id = $1`, [accountId]);
    for (const o of owners) {
      await t.query(
        `insert into account_owner (account_id, user_id, role, split_pct)
         values ($1,$2,coalesce($3,'account_manager'),coalesce($4,100))`,
        [accountId, o.user_id, o.role || null, o.split_pct ?? null]);
    }
    await recordEvent(t, "account.owners_changed", "account", accountId,
                      { owners: owners.map((o) => o.user_id) }, actorId);
    return t.rows(`select ao.user_id, u.full_name, ao.role, ao.split_pct
                     from account_owner ao join app_user u on u.id = ao.user_id
                    where ao.account_id = $1`, [accountId]);
  });
}

export async function getLocation(id) {
  const loc = await one(`select * from location where id = $1`, [id]);
  if (!loc) return null;
  const [account, contacts, projects, agreements] = await Promise.all([
    one(`select id, name, bg_check_policy, drug_test_policy, onboarding_notes
           from account where id = $1`, [loc.account_id]),
    rows(`select id, full_name, title, email, phone, is_manager, is_candidate
            from contact where location_id = $1 and archived_at is null order by full_name`, [id]),
    rows(`select id, name, delivery_type, status from project
           where location_id = $1 and archived_at is null`, [id]),
    rows(`select * from agreement where location_id = $1`, [id]),
  ]);
  // Account screening policy flows down; the site can add notes but not erase it.
  return { ...loc, account, contacts, projects, agreements,
           inherited_bg_check: account?.bg_check_policy ?? null,
           inherited_drug_test: account?.drug_test_policy ?? null };
}

export async function searchContacts({ q = null, skills = null, role = null,
                                       accountId = null, locationId = null,
                                       onPayroll = null, limit = 25 } = {}) {
  return rows(
    `select c.id, c.full_name, c.title, c.email, c.phone, c.headline, c.skills,
            c.is_manager, c.is_candidate, c.on_payroll, c.location_text,
            a.name as account_name, l.name as location_name,
            r.full_name as recruiter_name,
            (select max(occurred_at) from activity ac where ac.contact_id = c.id)
              as last_activity_at
       from contact c
       left join account  a on a.id = c.account_id
       left join location l on l.id = c.location_id
       left join app_user r on r.id = c.recruiter_id
      where c.archived_at is null
        and ($1::text is null or c.full_name ilike '%'||$1||'%'
             or c.email ilike '%'||$1||'%' or c.headline ilike '%'||$1||'%'
             or exists (select 1 from unnest(c.skills) s where s ilike '%'||$1||'%'))
        and ($2::text[] is null or c.skills && $2)
        and ($3::text is null or ($3 = 'manager' and c.is_manager)
                              or ($3 = 'candidate' and c.is_candidate))
        and ($4::uuid is null or c.account_id = $4)
        and ($5::uuid is null or c.location_id = $5)
        and ($6::boolean is null or c.on_payroll = $6)
      order by last_activity_at desc nulls last, c.full_name
      limit $7`,
    [q, skills, role, accountId, locationId, onPayroll, limit]);
}

export async function getContact(id) {
  const c = await one(`select * from contact where id = $1`, [id]);
  if (!c) return null;
  const [account, location, recruiter, activity, submissions, documents, pipelines] =
    await Promise.all([
      c.account_id ? one(`select id, name from account where id=$1`, [c.account_id]) : null,
      c.location_id ? one(`select id, name from location where id=$1`, [c.location_id]) : null,
      c.recruiter_id ? one(`select id, full_name from app_user where id=$1`, [c.recruiter_id]) : null,
      rows(`select ac.*, u.full_name as actor_name, p.name as project_name,
                   a.name as account_name
              from activity ac
              left join app_user u on u.id = ac.actor_id
              left join project  p on p.id = ac.project_id
              left join account  a on a.id = ac.account_id
             where ac.contact_id = $1 order by ac.occurred_at desc limit 50`, [id]),
      rows(`select id, stage, stage_label, is_open, days_in_stage, project_id,
                   project_name, account_name, account_id, pay_rate, bill_rate, gm_pct,
                   loss_reason_label, submitted_by_name, next_interview_at
              from submission_board
             where contact_id = $1 order by is_open desc, days_in_stage`, [id]),
      rows(`select id, kind, title, sharepoint_url, created_at from document
             where contact_id = $1 and archived_at is null order by created_at desc`, [id]),
      rows(`select pl.id, pl.name, u.full_name as owner
              from pipeline_member pm join pipeline pl on pl.id = pm.pipeline_id
              join app_user u on u.id = pl.owner_id
             where pm.contact_id = $1`, [id]),
    ]);
  return { ...c, account, location, recruiter, activity, submissions, documents, pipelines };
}

// Log against whichever hat the person is wearing. If the caller does not say,
// we work it out: a note tied to a project is candidate-side, a note tied only
// to the account they work for is manager-side. One person, one record, two
// timelines that read correctly.
export async function logActivity({ contactId, accountId = null, projectId = null,
                                    asRole = null, kind = "note", body, actorId = null }) {
  const c = contactId
    ? await one(`select id, is_manager, is_candidate, account_id from contact where id=$1`,
                [contactId])
    : null;
  if (contactId && !c) throw new Error("contact not found");

  let role = asRole;
  if (!role && c) {
    if (projectId) role = "candidate";
    else if (accountId && c.is_manager && c.account_id === accountId) role = "manager";
    else if (c.is_manager && !c.is_candidate) role = "manager";
    else if (c.is_candidate && !c.is_manager) role = "candidate";
    else role = "manager";
  }
  // A manager note with no account named defaults to the account they work for.
  const acct = accountId || (role === "manager" ? c?.account_id ?? null : null);

  return tx(async (t) => {
    const row = await t.one(
      `insert into activity (contact_id, account_id, project_id, as_role, kind, body, actor_id)
       values ($1,$2,$3,$4,$5,$6,$7) returning *`,
      [contactId || null, acct, projectId, role, kind, body, actorId]);
    await recordEvent(t, "activity.logged", "contact", contactId || null,
                      { as_role: role, kind, project_id: projectId }, actorId);
    return row;
  });
}

export async function listProjects({ accountId = null, status = null, deliveryType = null,
                                     ownerId = null, q = null, limit = 50 } = {}) {
  return rows(
    `select p.id, p.name, p.delivery_type, p.status, p.openings, p.start_date,
            p.bill_rate_min, p.bill_rate_max, p.skills,
            a.id as account_id, a.name as account_name, l.name as location_name,
            u.full_name as owner_name,
            (select count(*)::int from submission s where s.project_id = p.id) as submission_count,
            (select count(*)::int from placement pl where pl.project_id = p.id
               and pl.status = 'active') as active_placements
       from project p
       join account a on a.id = p.account_id
       left join location l on l.id = p.location_id
       left join app_user u on u.id = p.owner_id
      where p.archived_at is null
        and ($1::uuid is null or p.account_id = $1)
        and ($2::text is null or p.status = $2)
        and ($3::text is null or p.delivery_type = $3)
        and ($4::uuid is null or p.owner_id = $4)
        and ($5::text is null or p.name ilike '%'||$5||'%'
             or exists (select 1 from unnest(p.skills) s where s ilike '%'||$5||'%'))
      order by p.created_at desc limit $6`,
    [accountId, status, deliveryType, ownerId, q, limit]);
}

export async function getProject(id) {
  const p = await one(
    `select p.*, a.name as account_name, l.name as location_name, u.full_name as owner_name
       from project p join account a on a.id = p.account_id
       left join location l on l.id = p.location_id
       left join app_user u on u.id = p.owner_id
      where p.id = $1`, [id]);
  if (!p) return null;
  const [submissions, placements, pos, sows, docs, verifications] = await Promise.all([
    rows(`select * from submission_board
           where project_id = $1 order by stage_sort, days_in_stage desc`, [id]),
    rows(`select pl.id, pl.status, pl.start_date, pl.end_date, c.full_name,
                 c.id as contact_id,
                 (select jsonb_agg(jsonb_build_object(
                    'rate_type', r.rate_type, 'pay_rate', r.pay_rate,
                    'bill_rate', r.bill_rate, 'burden_pct', r.burden_pct,
                    'effective_from', r.effective_from, 'effective_to', r.effective_to,
                    'gm', gross_margin(r.pay_rate, r.bill_rate, r.burden_pct),
                    'gm_pct', round(gross_margin_pct(r.pay_rate,r.bill_rate,r.burden_pct),2))
                    order by r.effective_from)
                  from placement_rate r where r.placement_id = pl.id) as rates
            from placement pl join contact c on c.id = pl.contact_id
           where pl.project_id = $1`, [id]),
    rows(`select * from po_burndown where project_id = $1 order by po_number`, [id]),
    rows(`select s.*, (select coalesce(sum(co.value_delta),0) from change_order co
                        where co.sow_id = s.id and co.status = 'executed') as change_order_value
            from sow s where s.project_id = $1`, [id]),
    rows(`select id, kind, title, sharepoint_url from document
           where project_id = $1 and archived_at is null`, [id]),
    rows(`select rv.*, c.full_name from rate_verification rv
            join contact c on c.id = rv.contact_id where rv.project_id = $1`, [id]),
  ]);
  return { ...p, submissions, placements, purchase_orders: pos, sows: sows,
           documents: docs, rate_verifications: verifications };
}

// ------------------------------------------------------- submissions

// The stage machine, read out of the database rather than restated here. The UI
// draws its buttons from this, which is why there is no list of stages anywhere
// in the application code: one source of truth, and it is the one that enforces.
export async function stageMachine() {
  const [stages, flows, losses] = await Promise.all([
    rows(`select code, label, sort, is_open, is_entry, is_won
            from submission_stage order by sort`),
    rows(`select from_stage, to_stage, label, needs_reason, sort
            from submission_stage_flow order by from_stage, sort`),
    rows(`select code, label, side, sort from loss_reason order by sort`),
  ]);
  const movesFrom = {};
  for (const f of flows) (movesFrom[f.from_stage] ||= []).push(f);
  return { stages, flows, movesFrom, lossReasons: losses };
}

// What this submission can do next, with the labels the buttons should carry and
// whether the person clicking has to explain themselves.
export async function movesFor(submissionId) {
  const sub = await one(`select stage from submission where id = $1`, [submissionId]);
  if (!sub) throw new Error("that submission is not on file");
  const moves = await rows(
    `select f.to_stage, f.label, f.needs_reason, st.is_open, st.is_won
       from submission_stage_flow f
       join submission_stage st on st.code = f.to_stage
      where f.from_stage = $1 order by f.sort`, [sub.stage]);
  // A move to a closed, unwon stage is a loss, and a loss needs a coded reason.
  return moves.map((m) => ({ ...m, needs_loss_reason: !m.is_open && !m.is_won }));
}

// Putting somebody forward. The margin is worked out here and handed back with
// the row, because a recruiter deciding whether to submit at a rate wants to see
// what it leaves before they commit, not afterwards.
export async function submitCandidate(
  { projectId, contactId, payRate = null, billRate = null, burdenPct = 0, notes = null },
  actorId = null,
) {
  if (!projectId || !contactId) throw new Error("a submission needs a project and a person");

  const project = await one(
    `select p.*, a.name as account_name from project p
       join account a on a.id = p.account_id where p.id = $1`, [projectId]);
  if (!project) throw new Error("that project is not on file");
  if (project.archived_at) throw new Error("that project is archived");
  if (!["open", "draft"].includes(project.status)) {
    throw new Error(`that project is ${project.status} - reopen it before submitting anybody`);
  }

  const contact = await one(`select * from contact where id = $1`, [contactId]);
  if (!contact) throw new Error("that person is not on file");
  if (!contact.is_candidate) {
    throw new Error(`${contact.full_name} is not marked as a candidate - ` +
      "mark them as one first, which is a change to their record, not a new person");
  }

  return withActing(actorId, undefined, () => tx(async (t) => {
    const row = await t.one(
      `insert into submission (project_id, contact_id, submitted_by, pay_rate, bill_rate,
                               burden_pct, notes)
       values ($1,$2,$3,$4,$5,$6,$7) returning *`,
      [projectId, contactId, actorId, payRate, billRate, burdenPct, notes]);

    // The submission is an interaction with this person as a candidate, so it
    // belongs on their timeline under that hat.
    await t.query(
      `insert into activity (contact_id, account_id, project_id, as_role, kind, body, actor_id)
       values ($1,$2,$3,'candidate','submission',$4,$5)`,
      [contactId, project.account_id, projectId,
       `Submitted to ${project.account_name} for ${project.name}` +
         (billRate ? ` at ${billRate} an hour` : ""), actorId]);

    await recordEvent(t, "submission.created", "submission", row.id,
                      { project_id: projectId, contact_id: contactId }, actorId);

    const margin = await t.one(
      `select gross_margin($1,$2,$3) as gm, gross_margin_pct($1,$2,$3) as gm_pct`,
      [payRate, billRate, burdenPct]);

    // Advisory, not a refusal: a rate outside the project's range may be exactly
    // what the recruiter means to do, but they should know they are doing it.
    const notes_out = [];
    if (billRate && project.bill_rate_max && billRate > project.bill_rate_max) {
      notes_out.push(`that bill rate is above the ${project.bill_rate_max} ceiling on this project`);
    }
    if (billRate && project.bill_rate_min && billRate < project.bill_rate_min) {
      notes_out.push(`that bill rate is below the ${project.bill_rate_min} floor on this project`);
    }
    if (margin.gm_pct !== null && margin.gm_pct < 15) {
      notes_out.push(`that leaves ${Number(margin.gm_pct).toFixed(1)}% gross margin`);
    }
    return { ...row, gm: margin.gm, gm_pct: margin.gm_pct, advisories: notes_out };
  }));
}

// Moving a stage. The database decides whether the move is legal, writes the
// history row and stamps the clock; this function's only job is to hand it the
// reason and turn a constraint violation into something a person can read.
export async function advanceSubmission(submissionId, toStage, reason = null,
                                        { lossReasonCode = null } = {}, actorId = null) {
  if (!toStage) throw new Error("say which stage to move it to");
  return withActing(actorId, reason || undefined, () => tx(async (t) => {
    const before = await t.one(
      `select * from submission where id = $1 for update`, [submissionId]);
    if (!before) throw new Error("that submission is not on file");
    if (before.stage === toStage) {
      throw new Error(`it is already at ${toStage}`);
    }
    const after = await t.one(
      `update submission set stage = $2, loss_reason_code = coalesce($3, loss_reason_code)
        where id = $1 returning *`, [submissionId, toStage, lossReasonCode]);
    await recordEvent(t, "submission.advanced", "submission", submissionId,
                      { from: before.stage, to: toStage, reason,
                        loss_reason: after.loss_reason_code }, actorId);
    return { before, after };
  }));
}

// Booking a conversation with the client. The stage follows automatically -
// there is a trigger for it - so nobody has to remember two steps.
export async function scheduleInterview(
  { submissionId, scheduledAt, durationMins = 60, mode = "video", whereText = null,
    interviewers = null, prepNotes = null },
  actorId = null,
) {
  if (!submissionId || !scheduledAt) {
    throw new Error("an interview needs a submission and a date and time");
  }
  return withActing(actorId, "interview booked", () => tx(async (t) => {
    const next = await t.one(
      `select coalesce(max(round), 0) + 1 as round from interview where submission_id = $1`,
      [submissionId]);
    const row = await t.one(
      `insert into interview (submission_id, round, scheduled_at, duration_mins, mode,
                             where_text, interviewers, prep_notes, arranged_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
      [submissionId, next.round, scheduledAt, durationMins, mode, whereText,
       interviewers, prepNotes, actorId]);
    const sub = await t.one(
      `select s.*, c.full_name, p.name as project_name, a.name as account_name
         from submission s join contact c on c.id = s.contact_id
         join project p on p.id = s.project_id join account a on a.id = p.account_id
        where s.id = $1`, [submissionId]);
    await t.query(
      `insert into activity (contact_id, account_id, project_id, as_role, kind, body, actor_id)
       values ($1,(select account_id from project where id=$2),$2,'candidate','interview',$3,$4)`,
      [sub.contact_id, sub.project_id,
       `Round ${next.round} ${mode} interview with ${sub.account_name} booked for ` +
         new Date(scheduledAt).toISOString().slice(0, 16).replace("T", " "), actorId]);
    await recordEvent(t, "interview.scheduled", "submission", submissionId,
                      { round: next.round, scheduled_at: scheduledAt, mode }, actorId);
    return { ...row, submission: sub };
  }));
}

// What the client said. Recording an outcome deliberately does not move the
// stage: a rejection needs a coded reason, and asking for that is a separate
// decision by a person rather than something inferred from a dropdown.
export async function recordInterviewOutcome(
  interviewId, { status = "completed", outcome = null, feedback = null }, actorId = null,
) {
  return withActing(actorId, "interview outcome recorded", () => tx(async (t) => {
    const before = await t.one(`select * from interview where id = $1 for update`, [interviewId]);
    if (!before) throw new Error("that interview is not on file");
    const after = await t.one(
      `update interview set status = $2, outcome = coalesce($3, outcome),
              feedback = coalesce($4, feedback), updated_at = now()
        where id = $1 returning *`, [interviewId, status, outcome, feedback]);
    await recordEvent(t, "interview.outcome", "submission", before.submission_id,
                      { round: before.round, status, outcome }, actorId);
    const moves = await movesFor(before.submission_id);
    return { interview: after, next_moves: moves };
  }));
}

// The moment recruiting hands over to payroll and billing. One transaction:
// the placement, its opening rate, and only then the word "placed".
export async function placeSubmission(
  { submissionId, startDate, endDate = null, payRate = null, billRate = null,
    burdenPct = null, effectiveFrom = null },
  actorId = null,
) {
  if (!submissionId || !startDate) {
    throw new Error("a placement needs the submission and a start date");
  }
  return withActing(actorId, "placed", () => tx(async (t) => {
    const sub = await t.one(`select * from submission where id = $1 for update`, [submissionId]);
    if (!sub) throw new Error("that submission is not on file");

    const existing = await t.one(
      `select id from placement where submission_id = $1`, [submissionId]);
    if (existing) throw new Error("that submission already has a placement");

    const pay    = payRate  ?? sub.pay_rate;
    const bill   = billRate ?? sub.bill_rate;
    const burden = burdenPct ?? sub.burden_pct ?? 0;
    if (pay === null || bill === null) {
      throw new Error("a placement needs a pay rate and a bill rate - " +
        "they are what payroll and the invoice are built from");
    }

    // A start date that has already arrived means the assignment is running.
    // Deriving the status beats one somebody has to remember to change, and
    // doing it in SQL keeps it on the database's calendar rather than the
    // caller's timezone.
    const placement = await t.one(
      `insert into placement (project_id, contact_id, submission_id, status,
                              start_date, end_date, recruiter_id)
       values ($1,$2,$3,
               case when $4::date <= current_date then 'active' else 'pending' end,
               $4,$5,$6) returning *`,
      [sub.project_id, sub.contact_id, submissionId, startDate, endDate,
       sub.submitted_by || actorId]);

    await t.query(
      `insert into placement_rate (placement_id, rate_type, pay_rate, bill_rate,
                                   burden_pct, effective_from)
       values ($1,'standard',$2,$3,$4,$5)`,
      [placement.id, pay, bill, burden, effectiveFrom || startDate]);

    // Now the submission may say it. The guard checks the placement exists.
    const after = await t.one(
      `update submission set stage = 'placed' where id = $1 returning *`, [submissionId]);

    // Somebody starting work is a consultant of ours from that day.
    await t.query(
      `update contact set on_payroll = true, updated_at = now()
        where id = $1 and on_payroll = false`, [sub.contact_id]);

    await recordEvent(t, "submission.placed", "placement", placement.id,
                      { submission_id: submissionId, start_date: startDate,
                        pay_rate: pay, bill_rate: bill }, actorId);
    return { submission: after, placement };
  }));
}

// The board. One query behind every pipeline screen and every "what is out
// there" question the assistant gets asked.
export async function submissionBoard(
  { ownerId = null, accountId = null, projectId = null, contactId = null,
    stage = null, openOnly = true, staleDays = null, limit = 300 } = {},
) {
  return rows(
    `select * from submission_board
      where ($1::uuid is null or submitted_by = $1 or project_owner_id = $1)
        and ($2::uuid is null or account_id = $2)
        and ($3::uuid is null or project_id = $3)
        and ($4::uuid is null or contact_id = $4)
        and ($5::text is null or stage = $5)
        and (not $6::boolean or is_open)
        and ($7::int is null or days_in_stage >= $7)
      order by stage_sort, days_in_stage desc
      limit $8`,
    [ownerId, accountId, projectId, contactId, stage, openOnly, staleDays, limit]);
}

export async function submissionFunnel() {
  return rows(`select * from submission_funnel order by sort`);
}

// Everything that ever happened to one submission, in one list, so the story
// reads in order instead of across three screens.
export async function submissionHistory(submissionId) {
  const sub = await one(`select * from submission_board where id = $1`, [submissionId]);
  if (!sub) throw new Error("that submission is not on file");
  const [events, interviews] = await Promise.all([
    rows(`select e.*, u.full_name as actor_name
            from submission_event e left join app_user u on u.id = e.actor_id
           where e.submission_id = $1 order by e.id`, [submissionId]),
    rows(`select i.*, u.full_name as arranged_by_name
            from interview i left join app_user u on u.id = i.arranged_by
           where i.submission_id = $1 order by i.round`, [submissionId]),
  ]);
  const moves = await movesFor(submissionId);
  return { ...sub, events, interviews, next_moves: moves };
}

// Interviews coming up. A recruiter's morning: who is talking to whom, and
// which ones have happened and nobody has written down the answer.
export async function upcomingInterviews({ days = 14, ownerId = null } = {}) {
  return rows(
    `select i.id, i.round, i.scheduled_at, i.duration_mins, i.mode, i.where_text,
            i.interviewers, i.status, i.outcome, i.prep_notes,
            b.contact_name, b.contact_id, b.project_name, b.project_id,
            b.account_name, b.stage, b.submitted_by, b.submitted_by_name, b.id as submission_id
       from interview i join submission_board b on b.id = i.submission_id
      where i.status = 'scheduled'
        and i.scheduled_at >= now() - interval '2 days'
        and i.scheduled_at <= now() + ($1::int * interval '1 day')
        and ($2::uuid is null or b.submitted_by = $2 or b.project_owner_id = $2)
      order by i.scheduled_at`, [days, ownerId]);
}

// Interviews that have been and gone with nobody recording what happened. The
// feedback nobody chased is how a submission dies quietly.
export async function interviewsAwaitingFeedback({ ownerId = null } = {}) {
  return rows(
    `select i.id, i.round, i.scheduled_at, i.mode,
            b.contact_name, b.project_name, b.account_name, b.id as submission_id,
            b.submitted_by, b.stage,
            greatest(0, (current_date - i.scheduled_at::date)) as days_ago
       from interview i join submission_board b on b.id = i.submission_id
      where i.scheduled_at < now() and i.outcome = 'pending'
        and i.status in ('scheduled','completed')
        and b.is_open
        and ($1::uuid is null or b.submitted_by = $1 or b.project_owner_id = $1)
      order by i.scheduled_at`, [ownerId]);
}

// Why we lose. Grouped by whose decision it was, because the fix is different:
// client reasons are a sales and rate conversation, candidate reasons are a
// closing conversation, and ours are a process problem.
export async function lossBreakdown({ days = 90, ownerId = null } = {}) {
  return rows(
    `select lr.side, lr.code, lr.label, count(*)::int as losses,
            count(*) filter (where s.stage = 'withdrawn')::int as withdrawn,
            round(avg(greatest(0, (s.stage_since::date - s.created_at::date))), 1)
              as avg_days_to_loss
       from submission s
       join loss_reason lr on lr.code = s.loss_reason_code
       join project p on p.id = s.project_id
      where s.stage_since >= now() - ($1::int * interval '1 day')
        and ($2::uuid is null or s.submitted_by = $2 or p.owner_id = $2)
      group by lr.side, lr.code, lr.label, lr.sort
      order by losses desc, lr.sort`, [days, ownerId]);
}

export async function poBurndown({ projectId = null, accountName = null,
                                   expiringDays = null, atRisk = false } = {}) {
  return rows(
    `select * from po_burndown
      where ($1::uuid is null or project_id = $1)
        and ($2::text is null or account_name ilike '%'||$2||'%')
        and ($3::int is null or (days_remaining is not null and days_remaining <= $3))
        and (not $4::boolean or projected_remaining < 0 or
             (days_remaining is not null and days_remaining <= 45 and
              approved_unbilled + drafted_not_sent > 0))
      order by days_remaining nulls last, pct_committed desc`,
    [projectId, accountName, expiringDays, atRisk]);
}

// ----------------------------------------------------------------- timesheets

// What a consultant can charge to this week: every placement they hold, and the
// purchase orders on each. This is what the entry grid offers as allocation
// targets, so a consultant cannot invent one.
export async function allocationTargets(contactId, weekEnding) {
  return rows(
    `select pl.id as placement_id, p.id as project_id, p.name as project_name,
            p.delivery_type, a.name as account_name,
            po.id as purchase_order_id, po.po_number, po.end_date as po_end_date,
            r.bill_rate
       from placement pl
       join project p on p.id = pl.project_id
       join account a on a.id = p.account_id
       left join purchase_order po
              on po.project_id = p.id and po.status = 'open'
       left join lateral (select * from rate_in_force(pl.id, $2::date)) r on true
      where pl.contact_id = $1
        and pl.status <> 'cancelled'
        and pl.start_date <= $2::date
        and (pl.end_date is null or pl.end_date >= $2::date - 6)
      order by a.name, p.name, po.po_number`,
    [contactId, weekEnding]);
}

export async function getOrCreateTimesheet(contactId, weekEnding, actorId = null) {
  const found = await one(
    `select * from timesheet where contact_id = $1 and week_ending = $2::date`,
    [contactId, weekEnding]);
  if (found) return found;
  return insertRecord("timesheet",
    { contact_id: contactId, week_ending: weekEnding }, actorId);
}

export async function getTimesheet(id) {
  const ts = await one(
    `select t.*, c.full_name as consultant from timesheet t
       join contact c on c.id = t.contact_id where t.id = $1`, [id]);
  if (!ts) return null;
  const [entries, approvals] = await Promise.all([
    rows(`select * from timesheet_entry_detail where timesheet_id = $1
           order by work_date, project_name`, [id]),
    rows(`select ap.*, p.name as project_name, c.full_name as approver_name,
                 (select coalesce(sum(coalesce(e.billable_amount,
                    entry_billable(e.placement_id, e.work_date, e.hours, e.ot_hours))), 0)
                    from timesheet_entry e
                   where e.timesheet_id = ap.timesheet_id
                     and e.project_id = ap.project_id) as value,
                 (select coalesce(sum(e.hours + e.ot_hours), 0) from timesheet_entry e
                   where e.timesheet_id = ap.timesheet_id
                     and e.project_id = ap.project_id) as hours
            from timesheet_approval ap
            join project p on p.id = ap.project_id
            left join contact c on c.id = ap.approver_contact_id
           where ap.timesheet_id = $1 order by p.name`, [id]),
  ]);
  const totalHours = entries.reduce((a, e) => a + Number(e.hours) + Number(e.ot_hours), 0);
  return { ...ts, entries, approvals, total_hours: totalHours,
           total_value: entries.reduce((a, e) => a + Number(e.value), 0) };
}

/**
 * Save a week's allocation.
 *
 * The whole week is replaced in one transaction rather than patched row by row,
 * because that is how a grid is edited - a consultant moves three hours from one
 * project to another and expects both sides to land together or neither.
 */
export async function saveTimesheet(timesheetId, entries, actorId = null) {
  return tx(async (t) => {
    const ts = await t.one(`select * from timesheet where id = $1 for update`, [timesheetId]);
    if (!ts) throw new Error("timesheet not found");
    if (!["draft", "rejected"].includes(ts.status)) {
      throw new Error(`that week is ${ts.status} - reopen it before changing it`);
    }

    // Days under an approved packet are locked. A week that came back because
    // one manager rejected their part must not disturb what another manager
    // already signed off - that time is frozen and may already be invoiced.
    const locked = await t.rows(
      `select e.* from timesheet_entry e
         join timesheet_approval a
           on a.timesheet_id = e.timesheet_id and a.project_id = e.project_id
        where e.timesheet_id = $1 and a.status = 'approved'`, [timesheetId]);
    const lockedProjects = new Set(locked.map((e) => e.project_id));

    const rejected = entries.filter((e) => lockedProjects.size &&
      locked.some((l) => l.placement_id === e.placement_id));
    if (rejected.length && locked.length) {
      // Only complain if the caller is actually trying to change locked ground.
      const same = (a, b) =>
        a.work_date && String(a.work_date).slice(0, 10) ===
          b.work_date.toISOString().slice(0, 10) &&
        Number(a.hours || 0) === Number(b.hours) &&
        Number(a.ot_hours || 0) === Number(b.ot_hours);
      const changesLocked = rejected.some((e) => !locked.some((l) => same(e, l)));
      if (changesLocked) {
        throw new Error(
          "some of that time was approved and is locked. Request an unlock and " +
          "have an admin grant it before changing those days.");
      }
    }

    // Replace only the unlocked part of the week.
    await t.query(
      `delete from timesheet_entry e
        where e.timesheet_id = $1
          and not exists (select 1 from timesheet_approval a
                           where a.timesheet_id = e.timesheet_id
                             and a.project_id = e.project_id
                             and a.status = 'approved')`, [timesheetId]);

    const kept = [];
    for (const e of entries) {
      const hours = Number(e.hours) || 0;
      const ot = Number(e.ot_hours) || 0;
      if (hours <= 0 && ot <= 0) continue;   // an empty cell is not a row
      // Skip anything that belongs to a locked packet - it is already there.
      const proj = await t.one(`select project_id from placement where id = $1`,
                               [e.placement_id]);
      if (proj && lockedProjects.has(proj.project_id)) continue;
      kept.push(await t.one(
        `insert into timesheet_entry (timesheet_id, placement_id, project_id,
                                      purchase_order_id, work_date, hours, ot_hours, notes)
         values ($1,$2,(select project_id from placement where id = $2),$3,$4::date,$5,$6,$7)
         returning *`,
        [timesheetId, e.placement_id, e.purchase_order_id || null, e.work_date,
         hours, ot, e.notes || null]));
    }
    // A rejected week that gets corrected goes back to draft, so the consultant
    // has to submit it again rather than it silently re-entering the queue. The
    // packets that were approved stay approved.
    if (ts.status === "rejected") {
      await t.query(`update timesheet set status = 'draft', updated_at = now()
                      where id = $1`, [timesheetId]);
      await t.query(
        `delete from timesheet_approval
          where timesheet_id = $1 and status <> 'approved'`, [timesheetId]);
    }
    await recordEvent(t, "timesheet.saved", "timesheet", timesheetId,
                      { entries: kept.length, locked_kept: locked.length,
                        hours: kept.reduce((a, e) => a + Number(e.hours) + Number(e.ot_hours), 0) },
                      actorId);
    return kept;
  });
}

/**
 * Submit a week.
 *
 * One approval packet per project the week touches, each routed to that
 * project's designated approver. A project with no approver on file still gets
 * a packet - it just has nobody named on it, which is a gap somebody needs to
 * fix rather than a reason to swallow the time.
 */
export async function submitTimesheet(timesheetId, actorId = null) {
  return tx(async (t) => {
    const ts = await t.one(`select * from timesheet where id = $1 for update`, [timesheetId]);
    if (!ts) throw new Error("timesheet not found");
    if (!["draft", "rejected"].includes(ts.status)) {
      throw new Error(`that week is already ${ts.status}`);
    }
    const projects = await t.rows(
      `select e.project_id, p.name,
              sum(e.hours + e.ot_hours) as hours,
              sum(entry_billable(e.placement_id, e.work_date, e.hours, e.ot_hours)) as value
         from timesheet_entry e join project p on p.id = e.project_id
        where e.timesheet_id = $1 group by e.project_id, p.name order by p.name`,
      [timesheetId]);
    if (!projects.length) throw new Error("there is no time on that week to submit");

    // Approved packets are locked; re-submitting a corrected week leaves them
    // alone and only re-routes the parts that still need a decision.
    await t.query(
      `delete from timesheet_approval where timesheet_id = $1 and status <> 'approved'`,
      [timesheetId]);
    const packets = [];
    for (const pr of projects) {
      const existing = await t.one(
        `select * from timesheet_approval where timesheet_id = $1 and project_id = $2`,
        [timesheetId, pr.project_id]);
      if (existing) { packets.push(existing); continue; }
      const approver = await t.one(
        `select contact_id from project_approver
          where project_id = $1 order by is_primary desc, added_at limit 1`,
        [pr.project_id]);
      packets.push(await t.one(
        `insert into timesheet_approval (timesheet_id, project_id, approver_contact_id)
         values ($1,$2,$3) returning *`,
        [timesheetId, pr.project_id, approver?.contact_id ?? null]));
    }
    const after = await t.one(
      `update timesheet set status = 'submitted', submitted_at = now(), updated_at = now()
        where id = $1 returning *`, [timesheetId]);
    await recordEvent(t, "timesheet.submitted", "timesheet", timesheetId,
                      { projects: projects.length,
                        hours: projects.reduce((a, p) => a + Number(p.hours), 0),
                        unrouted: packets.filter((p) => !p.approver_contact_id).length },
                      actorId);
    return { ...after, packets, projects };
  });
}

// What is sitting in one client manager's queue, or in everyone's.
export async function approvalQueue({ approverContactId = null, projectId = null,
                                      accountId = null, status = "pending" } = {}) {
  return rows(
    `select ap.id as approval_id, ap.status, ap.note, ap.decided_by, ap.decided_at,
            t.id as timesheet_id, t.week_ending, t.submitted_at,
            c.full_name as consultant, c.id as contact_id,
            p.id as project_id, p.name as project_name,
            a.id as account_id, a.name as account_name,
            appr.full_name as approver_name, appr.id as approver_id,
            (select coalesce(sum(e.hours + e.ot_hours),0) from timesheet_entry e
              where e.timesheet_id = t.id and e.project_id = p.id) as hours,
            (select coalesce(sum(entry_billable(e.placement_id, e.work_date,
                                                e.hours, e.ot_hours)),0)
               from timesheet_entry e
              where e.timesheet_id = t.id and e.project_id = p.id) as value,
            -- The days behind the total, so an approver sees the shape of the
            -- week rather than one number.
            (select jsonb_agg(jsonb_build_object(
                      'work_date', e.work_date, 'hours', e.hours + e.ot_hours,
                      'po_number', po.po_number) order by e.work_date)
               from timesheet_entry e
               left join purchase_order po on po.id = e.purchase_order_id
              where e.timesheet_id = t.id and e.project_id = p.id) as days
       from timesheet_approval ap
       join timesheet t on t.id = ap.timesheet_id
       join contact  c  on c.id = t.contact_id
       join project  p  on p.id = ap.project_id
       join account  a  on a.id = p.account_id
       left join contact appr on appr.id = ap.approver_contact_id
      where ($1::uuid is null or ap.approver_contact_id = $1)
        and ($2::uuid is null or ap.project_id = $2)
        and ($3::uuid is null or a.id = $3)
        and ($4::text is null or ap.status = $4)
      order by t.week_ending desc, a.name, c.full_name`,
    [approverContactId, projectId, accountId, status]);
}

// One packet, with the days in it, so an approver sees what they are agreeing to.
export async function getApproval(approvalId) {
  const ap = await one(
    `select ap.*, t.week_ending, t.contact_id, c.full_name as consultant,
            p.name as project_name, a.name as account_name,
            appr.full_name as approver_name
       from timesheet_approval ap
       join timesheet t on t.id = ap.timesheet_id
       join contact c on c.id = t.contact_id
       join project p on p.id = ap.project_id
       join account a on a.id = p.account_id
       left join contact appr on appr.id = ap.approver_contact_id
      where ap.id = $1`, [approvalId]);
  if (!ap) return null;
  const entries = await rows(
    `select * from timesheet_entry_detail
      where timesheet_id = $1 and project_id = $2 order by work_date`,
    [ap.timesheet_id, ap.project_id]);
  return { ...ap, entries,
           hours: entries.reduce((a, e) => a + Number(e.hours) + Number(e.ot_hours), 0),
           value: entries.reduce((a, e) => a + Number(e.value), 0) };
}

// A client manager decides on their part of a week. Approving freezes the value
// of those days; rejecting releases it and sends the week back.
export async function decideApproval(approvalId, decision, decidedBy, note = null,
                                     actorId = null) {
  if (!["approved", "rejected"].includes(decision)) {
    throw new Error("a decision is either approved or rejected");
  }
  if (!decidedBy) throw new Error("record who made the decision");
  return tx(async (t) => {
    const before = await t.one(
      `select * from timesheet_approval where id = $1 for update`, [approvalId]);
    if (!before) throw new Error("that approval is not on file");
    if (before.status !== "pending") {
      throw new Error(`that was already ${before.status} by ${before.decided_by}`);
    }
    const after = await t.one(
      `update timesheet_approval set status = $2, decided_at = now(), decided_by = $3,
              note = $4 where id = $1 returning *`,
      [approvalId, decision, decidedBy, note]);
    await recordEvent(t, `timesheet.${decision}`, "timesheet", before.timesheet_id,
                      { project_id: before.project_id, by: decidedBy, note }, actorId);
    return after;
  });
}

export async function listTimesheets({ contactId = null, status = null,
                                       weekEnding = null, limit = 100 } = {}) {
  return rows(
    `select t.id, t.week_ending, t.status, t.submitted_at,
            c.id as contact_id, c.full_name as consultant,
            (select coalesce(sum(e.hours + e.ot_hours),0) from timesheet_entry e
              where e.timesheet_id = t.id) as hours,
            (select count(distinct e.project_id)::int from timesheet_entry e
              where e.timesheet_id = t.id) as projects,
            (select count(*)::int from timesheet_approval a
              where a.timesheet_id = t.id and a.status = 'pending') as awaiting
       from timesheet t join contact c on c.id = t.contact_id
      where ($1::uuid is null or t.contact_id = $1)
        and ($2::text is null or t.status = $2)
        and ($3::date is null or t.week_ending = $3::date)
      order by t.week_ending desc, c.full_name limit $4`,
    [contactId, status, weekEnding, limit]);
}

export async function listEntries({ status = null, poId = null, projectId = null,
                                    contactId = null, from = null, to = null,
                                    unbilledOnly = false, limit = 500 } = {}) {
  return rows(
    `select * from timesheet_entry_detail
      where ($1::text is null or approval_status is not distinct from $1)
        and ($2::uuid is null or purchase_order_id = $2)
        and ($3::uuid is null or project_id = $3)
        and ($4::uuid is null or contact_id = $4)
        and ($5::date is null or work_date >= $5::date)
        and ($6::date is null or work_date <= $6::date)
        and (not $7::boolean or invoice_id is null)
      order by work_date desc, consultant limit $8`,
    [status, poId, projectId, contactId, from, to, unbilledOnly, limit]);
}

// Who at the client may approve time on a project. Approvers are drawn from the
// account's own contacts, so this cannot become a list of typed-in names.
export async function setProjectApprovers(projectId, contactIds, actorId = null) {
  return tx(async (t) => {
    const proj = await t.one(`select account_id from project where id = $1`, [projectId]);
    if (!proj) throw new Error("project not found");
    const valid = await t.rows(
      `select id, full_name from contact
        where id = any($1::uuid[]) and is_manager and account_id = $2
          and archived_at is null`, [contactIds, proj.account_id]);
    if (valid.length !== contactIds.length) {
      throw new Error("an approver has to be a manager on this account");
    }
    await t.query(`delete from project_approver where project_id = $1`, [projectId]);
    let first = true;
    for (const id of contactIds) {
      await t.query(
        `insert into project_approver (project_id, contact_id, is_primary)
         values ($1,$2,$3)`, [projectId, id, first]);
      first = false;
    }
    await recordEvent(t, "project.approvers_set", "project", projectId,
                      { approvers: valid.map((v) => v.full_name) }, actorId);
    return valid;
  });
}

export async function projectApprovers(projectId) {
  return rows(
    `select pa.contact_id, pa.is_primary, c.full_name, c.email, c.title
       from project_approver pa join contact c on c.id = pa.contact_id
      where pa.project_id = $1 order by pa.is_primary desc, c.full_name`, [projectId]);
}

// --------------------------------------------------------------- unlocking

// Approved time is locked. Somebody asks for it back, an admin decides, and the
// grant opens that one packet once.
export async function requestUnlock({ approvalId, reason }, actorId = null) {
  if (!reason || reason.trim().length <= 5) {
    throw new Error("say why it needs unlocking - the admin deciding will read it");
  }
  const ap = await one(`select * from timesheet_approval where id = $1`, [approvalId]);
  if (!ap) throw new Error("that approval is not on file");
  if (ap.status !== "approved") {
    throw new Error(`that time is ${ap.status}, not approved - it is not locked`);
  }
  const open = await one(
    `select id from unlock_request where approval_id = $1 and status = 'pending'`,
    [approvalId]);
  if (open) throw new Error("there is already an unlock request waiting on that week");
  return insertRecord("unlock_request",
    { approval_id: approvalId, requested_by: actorId, reason: reason.trim() }, actorId);
}

export async function listUnlockRequests({ status = "pending", limit = 50 } = {}) {
  return rows(
    `select ur.*, t.week_ending, c.full_name as consultant,
            p.name as project_name, a.name as account_name,
            req.full_name as requested_by_name, dec.full_name as decided_by_name,
            (select coalesce(sum(e.billable_amount),0) from timesheet_entry e
              where e.timesheet_id = ap.timesheet_id
                and e.project_id = ap.project_id) as value,
            (select count(*)::int from invoice_line l
               join invoice i on i.id = l.invoice_id
               join timesheet_entry e on e.id = l.timesheet_entry_id
              where e.timesheet_id = ap.timesheet_id
                and e.project_id = ap.project_id and i.status <> 'void') as billed_lines
       from unlock_request ur
       join timesheet_approval ap on ap.id = ur.approval_id
       join timesheet t on t.id = ap.timesheet_id
       join contact c on c.id = t.contact_id
       join project p on p.id = ap.project_id
       join account a on a.id = p.account_id
       left join app_user req on req.id = ur.requested_by
       left join app_user dec on dec.id = ur.decided_by
      where ($1::text is null or ur.status = $1)
      order by ur.created_at desc limit $2`, [status, limit]);
}

// Granting is an admin act. The database checks the role and refuses a
// self-grant; this adds the operational check that nobody unlocks time that has
// already gone out on an invoice without seeing that first.
export async function decideUnlock(requestId, decision, adminUserId, note = null) {
  if (!["granted", "denied"].includes(decision)) {
    throw new Error("an unlock is either granted or denied");
  }
  return tx(async (t) => {
    const req = await t.one(`select * from unlock_request where id = $1 for update`,
                            [requestId]);
    if (!req) throw new Error("that request is not on file");
    if (req.status !== "pending") throw new Error(`that request is already ${req.status}`);

    if (decision === "granted") {
      const billed = await t.one(
        `select count(*)::int as n, min(i.invoice_number) as invoice
           from invoice_line l join invoice i on i.id = l.invoice_id
           join timesheet_entry e on e.id = l.timesheet_entry_id
           join timesheet_approval ap on ap.timesheet_id = e.timesheet_id
                                     and ap.project_id = e.project_id
          where ap.id = $1 and i.status <> 'void'`, [req.approval_id]);
      if (billed.n > 0) {
        throw new Error(
          `that time is already on invoice ${billed.invoice}. Void or credit the ` +
          `invoice first - unlocking it here would leave the invoice standing ` +
          `against time that no longer exists.`);
      }
    }

    const after = await t.one(
      `update unlock_request set status = $2, decided_by = $3, decision_note = $4
        where id = $1 returning *`, [requestId, decision, adminUserId, note]);
    await recordEvent(t, `unlock.${decision}`, "timesheet_approval", req.approval_id,
                      { reason: req.reason, note }, adminUserId);
    return after;
  });
}

// Spend a granted unlock: put the packet back to pending, which releases the
// frozen values and lets the week be corrected.
export async function reopenApproval(approvalId, actorId = null) {
  return tx(async (t) => {
    const ap = await t.one(`select * from timesheet_approval where id = $1 for update`,
                           [approvalId]);
    if (!ap) throw new Error("that approval is not on file");
    if (ap.status !== "approved") throw new Error("that packet is not approved");
    // The database refuses this unless a granted, unexpired unlock exists, and
    // spends it when it succeeds.
    const after = await t.one(
      `update timesheet_approval set status = 'pending', decided_at = null,
              decided_by = null, note = null where id = $1 returning *`, [approvalId]);
    await t.query(
      `update timesheet set status = 'draft', updated_at = now() where id = $1`,
      [ap.timesheet_id]);
    await recordEvent(t, "timesheet.reopened", "timesheet", ap.timesheet_id,
                      { project_id: ap.project_id }, actorId);
    return after;
  });
}

// ------------------------------------------------------------------- invoices

// Invoice numbers are sequential within the year and gapless enough to satisfy
// an auditor. Taken inside the transaction that creates the invoice.
async function nextInvoiceNumber(t) {
  const year = new Date().getFullYear();
  const row = await t.one(
    `select coalesce(max(substring(invoice_number from '\\d+$')::int), 0) + 1 as n
       from invoice where invoice_number like $1`, [`TS-${year}-%`]);
  return `TS-${year}-${String(row.n).padStart(4, "0")}`;
}

/**
 * Draft an invoice from approved, unbilled time.
 *
 * This is the only route from worked time to an invoice line. It cannot pick up
 * time the client has not approved, and it cannot pick up a week that is
 * already on a live invoice - the database refuses both.
 */
export async function draftInvoiceFromApproved({ purchaseOrderId = null, projectId = null,
                                                 throughWeek = null, terms = 45,
                                                 notes = null }, actorId = null) {
  return tx(async (t) => {
    const entries = await t.rows(
      `select d.* from timesheet_entry_detail d
        where d.approval_status = 'approved' and d.invoice_id is null
          and ($1::uuid is null or d.purchase_order_id = $1)
          and ($2::uuid is null or d.project_id = $2)
          and ($3::date is null or d.week_ending <= $3::date)
        order by d.work_date, d.consultant`,
      [purchaseOrderId, projectId, throughWeek]);

    if (!entries.length) {
      return { nothing_to_bill: true,
               message: "No approved time is waiting to be billed for that." };
    }

    const project = await t.one(
      `select p.id, p.name, p.account_id from project p where p.id = $1`,
      [projectId || entries[0].project_id]);
    const number = await nextInvoiceNumber(t);

    const inv = await t.one(
      `insert into invoice (invoice_number, account_id, project_id, purchase_order_id,
                            status, terms_days, period_start, period_end, notes)
       values ($1,$2,$3,$4,'draft',$5,$6,$7,$8) returning *`,
      [number, project.account_id, project.id,
       purchaseOrderId || entries[0].purchase_order_id, terms,
       entries[0].work_date, entries[entries.length - 1].work_date, notes]);

    // One line per consultant per week rather than per day - a client wants to
    // read an invoice, not audit it. The days behind each line are still linked.
    let n = 0;
    for (const e of entries) {
      const hours = Number(e.hours) + Number(e.ot_hours);
      await t.query(
        `insert into invoice_line (invoice_id, kind, timesheet_entry_id, description,
                                   quantity, unit_rate, amount, sort_order)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [inv.id, "time", e.entry_id,
         `${e.consultant} - ${e.work_date.toISOString().slice(0, 10)}` +
         (e.po_number ? ` (${e.po_number})` : ""),
         hours, hours ? Number(e.value) / hours : null, e.value, n++]);
    }
    await recordEvent(t, "invoice.drafted", "invoice", inv.id,
                      { number, days: entries.length,
                        total: entries.reduce((a, e) => a + Number(e.value), 0) },
                      actorId);
    return { ...inv, line_count: entries.length,
             total: entries.reduce((a, e) => a + Number(e.value), 0) };
  });
}

// Issuing is the moment it burns the PO, which is why the overrun check lives
// on this transition and not on drafting.
export async function sendInvoice(id, issueDate = null, actorId = null) {
  return tx(async (t) => {
    const before = await t.one(`select * from invoice where id = $1 for update`, [id]);
    if (!before) throw new Error("invoice not found");
    if (before.status !== "draft")
      throw new Error(`invoice ${before.invoice_number} is already ${before.status}`);
    const issue = issueDate || new Date().toISOString().slice(0, 10);
    const after = await t.one(
      `update invoice set status = 'sent', issue_date = $2::date,
              due_date = $2::date + terms_days, sent_at = now(), updated_at = now()
        where id = $1 returning *`, [id, issue]);
    const totals = await t.one(`select * from invoice_totals where invoice_id = $1`, [id]);
    await recordEvent(t, "invoice.sent", "invoice", id,
                      { number: after.invoice_number, total: totals.total }, actorId);
    return { ...after, ...totals };
  });
}

export async function recordPayment({ invoiceId, amount, receivedAt = null,
                                      method = null, reference = null }, actorId = null) {
  return tx(async (t) => {
    const inv = await t.one(`select * from invoice where id = $1 for update`, [invoiceId]);
    if (!inv) throw new Error("invoice not found");
    if (inv.status === "void") throw new Error("that invoice was voided");
    if (inv.status === "draft") throw new Error("that invoice has not been sent yet");
    await t.query(
      `insert into payment (invoice_id, amount, received_at, method, reference)
       values ($1,$2,coalesce($3::date, current_date),$4,$5)`,
      [invoiceId, amount, receivedAt, method, reference]);
    const totals = await t.one(`select * from invoice_totals where invoice_id = $1`,
                               [invoiceId]);
    const status = Number(totals.outstanding) <= 0 ? "paid" : "part_paid";
    const after = await t.one(
      `update invoice set status = $2, updated_at = now() where id = $1 returning *`,
      [invoiceId, status]);
    await recordEvent(t, "payment.received", "invoice", invoiceId,
                      { amount, outstanding: totals.outstanding, status }, actorId);
    return { ...after, ...totals };
  });
}

// Voiding never deletes. The invoice stays, and its weeks become billable again.
export async function voidInvoice(id, reason, actorId = null) {
  return tx(async (t) => {
    const before = await t.one(`select * from invoice where id = $1 for update`, [id]);
    if (!before) throw new Error("invoice not found");
    const after = await t.one(
      `update invoice set status = 'void', voided_at = now(), void_reason = $2,
              updated_at = now() where id = $1 returning *`, [id, reason]);
    await recordEvent(t, "invoice.voided", "invoice", id,
                      { number: before.invoice_number, reason }, actorId);
    return after;
  });
}

export async function listInvoices({ accountId = null, projectId = null, poId = null,
                                     status = null, overdueOnly = false,
                                     limit = 100 } = {}) {
  return rows(
    `select i.id, i.invoice_number, i.status, i.issue_date, i.due_date,
            i.period_start, i.period_end,
            t.total, t.paid, t.outstanding, t.line_count,
            a.name as account_name, p.name as project_name, po.po_number,
            ag.days_overdue, ag.bucket
       from invoice i
       join invoice_totals t on t.invoice_id = i.id
       join account a on a.id = i.account_id
       left join project p on p.id = i.project_id
       left join purchase_order po on po.id = i.purchase_order_id
       left join invoice_aging ag on ag.invoice_id = i.id
      where ($1::uuid is null or i.account_id = $1)
        and ($2::uuid is null or i.project_id = $2)
        and ($3::uuid is null or i.purchase_order_id = $3)
        and ($4::text is null or i.status = $4)
        and (not $5::boolean or coalesce(ag.days_overdue,0) > 0)
      order by i.issue_date desc nulls first, i.invoice_number desc
      limit $6`,
    [accountId, projectId, poId, status, overdueOnly, limit]);
}

export async function getInvoice(id) {
  const inv = await one(
    `select i.*, a.name as account_name, p.name as project_name, po.po_number,
            t.total, t.paid, t.outstanding
       from invoice i
       join invoice_totals t on t.invoice_id = i.id
       join account a on a.id = i.account_id
       left join project p on p.id = i.project_id
       left join purchase_order po on po.id = i.purchase_order_id
      where i.id = $1`, [id]);
  if (!inv) return null;
  const [lines, payments] = await Promise.all([
    rows(`select l.*, d.work_date, d.hours, d.ot_hours, d.consultant, d.po_number
            from invoice_line l
            left join timesheet_entry_detail d on d.entry_id = l.timesheet_entry_id
           where l.invoice_id = $1 order by l.sort_order, l.created_at`, [id]),
    rows(`select * from payment where invoice_id = $1 order by received_at`, [id]),
  ]);
  return { ...inv, lines, payments };
}

export async function invoiceAging({ accountName = null } = {}) {
  return rows(
    `select * from invoice_aging
      where ($1::text is null or account_name ilike '%'||$1||'%')
      order by days_overdue desc, due_date`, [accountName]);
}

export async function searchDocuments({ q = null, kind = null, accountId = null,
                                        contactId = null, projectId = null, limit = 25 } = {}) {
  return rows(
    `select d.id, d.kind, d.title, d.sharepoint_url, d.sharepoint_path, d.created_at,
            a.name as account_name, c.full_name as contact_name, p.name as project_name,
            left(coalesce(d.content_text,''), 300) as excerpt
       from document d
       left join account a on a.id = d.account_id
       left join contact c on c.id = d.contact_id
       left join project p on p.id = d.project_id
      where d.archived_at is null
        and ($1::text is null or
             to_tsvector('english', coalesce(d.title,'')||' '||coalesce(d.content_text,''))
             @@ plainto_tsquery('english', $1)
             or d.title ilike '%'||$1||'%')
        and ($2::text is null or d.kind = $2)
        and ($3::uuid is null or d.account_id = $3)
        and ($4::uuid is null or d.contact_id = $4)
        and ($5::uuid is null or d.project_id = $5)
      order by d.created_at desc limit $6`,
    [q, kind, accountId, contactId, projectId, limit]);
}

export async function addToPipeline(pipelineName, ownerId, contactId, note = null) {
  return tx(async (t) => {
    let pl = await t.one(`select * from pipeline where owner_id=$1 and lower(name)=lower($2)`,
                         [ownerId, pipelineName]);
    if (!pl) {
      pl = await t.one(`insert into pipeline (owner_id, name) values ($1,$2) returning *`,
                       [ownerId, pipelineName]);
    }
    await t.query(
      `insert into pipeline_member (pipeline_id, contact_id, note) values ($1,$2,$3)
       on conflict (pipeline_id, contact_id) do update set note = excluded.note`,
      [pl.id, contactId, note]);
    await recordEvent(t, "pipeline.tagged", "contact", contactId, { pipeline: pl.name }, ownerId);
    return pl;
  });
}

export async function getPipeline(ownerId, name) {
  return rows(
    `select c.id, c.full_name, c.headline, c.skills, c.on_payroll, pm.note, pm.added_at
       from pipeline pl join pipeline_member pm on pm.pipeline_id = pl.id
       join contact c on c.id = pm.contact_id
      where pl.owner_id = $1 and lower(pl.name) = lower($2) and c.archived_at is null
      order by pm.added_at desc`, [ownerId, name]);
}

/* A recruiter's categories with everybody in them, and what each person is
 * actually doing. The status is the point: a category full of people on
 * assignment is a category with nothing in it to sell, and a bench employee in
 * one is the cheapest seat on the desk. */
export async function listPipelines(ownerId = null) {
  return rows(
    `select pl.id, pl.name, pl.notes, pl.created_at,
            pl.owner_id, u.full_name as owner_name,
            pl.project_id, p.name as project_name,
            coalesce((
              select jsonb_agg(m order by m->>'full_name')
                from (
                  select jsonb_build_object(
                    'contact_id', c.id, 'full_name', c.full_name,
                    'headline', c.headline, 'skills', c.skills,
                    'note', pm.note, 'added_at', pm.added_at,
                    'on_payroll', c.on_payroll,
                    'status', case
                      when live.id is not null then 'on_assignment'
                      when soon.id is not null then 'starting'
                      when c.on_payroll then 'bench'
                      when out_now.n > 0 then 'out_with_a_client'
                      else 'available' end,
                    'free_on', live.end_date,
                    'starts_on', soon.start_date,
                    'submissions_out', out_now.n,
                    'last_touch', (select max(a.occurred_at) from activity a
                                    where a.contact_id = c.id)) as m
                    from pipeline_member pm
                    join contact c on c.id = pm.contact_id and c.archived_at is null
                    left join lateral (
                      select pl2.id, pl2.end_date from placement pl2
                       where pl2.contact_id = c.id
                         and pl2.status in ('active','pending')
                         and pl2.start_date <= current_date
                         and (pl2.end_date is null or pl2.end_date >= current_date)
                       order by pl2.end_date nulls last limit 1) live on true
                    left join lateral (
                      select pl3.id, pl3.start_date from placement pl3
                       where pl3.contact_id = c.id
                         and pl3.status in ('active','pending')
                         and pl3.start_date > current_date
                       order by pl3.start_date limit 1) soon on true
                    left join lateral (
                      select count(*)::int as n from submission s
                        join submission_stage st on st.code = s.stage
                       where s.contact_id = c.id and st.is_open) out_now on true
                   where pm.pipeline_id = pl.id) members
            ), '[]'::jsonb) as members
       from pipeline pl
       join app_user u on u.id = pl.owner_id
       left join project p on p.id = pl.project_id
      where ($1::uuid is null or pl.owner_id = $1)
      order by u.full_name, pl.name`, [ownerId]);
}

export async function recentEvents(limit = 50) {
  return rows(
    `select e.id, e.kind, e.subject_type, e.subject_id, e.payload, e.trace_id,
            e.occurred_at, u.full_name as actor
       from domain_event e left join app_user u on u.id = e.actor_id
      order by e.id desc limit $1`, [limit]);
}
