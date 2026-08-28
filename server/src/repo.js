// Business operations.
//
// Reads are plain queries. Writes all go through insertRecord / updateRecord /
// archiveRecord so that three things happen without anyone having to remember:
// the previous version is kept, a domain event is appended, and the whole thing
// is one transaction.

import { rows, one, tx, query } from "./db.js";
import { currentTrace, step } from "./trace.js";

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
  submission: ["project_id","contact_id","stage","submitted_by","pay_rate","bill_rate"],
  placement: ["project_id","contact_id","status","start_date","end_date","recruiter_id"],
  agreement: ["account_id","location_id","kind","status","effective_from","effective_to","terms_notes"],
  rate_verification: ["project_id","contact_id","placement_id","status","pay_rate","bill_rate",
                      "start_date","end_date","confirmed_by","confirmed_at"],
  sow: ["project_id","title","status","start_date","end_date","total_value","deliverables"],
  purchase_order: ["project_id","sow_id","po_number","amount","currency","start_date",
                   "end_date","status","notes"],
  timecard: ["placement_id","purchase_order_id","week_ending","hours","ot_hours","status",
             "approved_by","approved_at","billed_amount"],
  document: ["kind","title","account_id","location_id","project_id","contact_id",
             "sharepoint_url","sharepoint_path","content_text","mime_type","byte_size","uploaded_by"],
  pipeline: ["owner_id","name","project_id","notes"],
};

const HAS_UPDATED_AT = new Set(["account","location","contact","project","submission",
  "placement","agreement","rate_verification","sow","purchase_order","timecard","conversation"]);

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
    await t.query(
      `insert into record_revision (table_name, record_id, before, after, changed_by)
       values ($1,$2,null,$3,$4)`,
      [table, row.id, row, actorId],
    );
    await recordEvent(t, `${table}.created`, table, row.id, { fields: keys }, actorId);
    return row;
  });
}

// The non-destructive update. The prior version is written to record_revision
// before the row changes, so "make changes without deleting the data" is a
// property of the write path, not a promise in a document.
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
    await t.query(
      `insert into record_revision (table_name, record_id, before, after, changed_by)
       values ($1,$2,$3,$4,$5)`,
      [table, id, before, after, actorId],
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
    await t.query(
      `insert into record_revision (table_name, record_id, before, after, changed_by)
       values ($1,$2,$3,$4,$5)`, [table, id, before, after, actorId]);
    await recordEvent(t, `${table}.archived`, table, id, {}, actorId);
    return after;
  });
}

export async function revisionsFor(table, id, limit = 50) {
  return rows(
    `select id, changed_at, changed_by, before, after
       from record_revision where table_name = $1 and record_id = $2
      order by changed_at desc limit $3`, [table, id, limit]);
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
    await t.query(
      `insert into record_revision (table_name, record_id, before, after, changed_by)
       values ('account_owner',$1,$2,$3,$4)`,
      [accountId, JSON.stringify(before), JSON.stringify(owners), actorId]);
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
      rows(`select s.id, s.stage, s.updated_at, p.id as project_id, p.name as project_name,
                   a.name as account_name
              from submission s join project p on p.id = s.project_id
              join account a on a.id = p.account_id
             where s.contact_id = $1 order by s.updated_at desc`, [id]),
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
    rows(`select s.id, s.stage, s.pay_rate, s.bill_rate, s.updated_at,
                 c.id as contact_id, c.full_name
            from submission s join contact c on c.id = s.contact_id
           where s.project_id = $1 order by s.updated_at desc`, [id]),
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

// Moving a submission forward appends to the event log and updates the cached
// stage in the same transaction, so the two can never disagree.
export async function advanceSubmission(submissionId, toStage, reason, actorId = null) {
  return tx(async (t) => {
    const cur = await t.one(`select * from submission where id=$1 for update`, [submissionId]);
    if (!cur) throw new Error("submission not found");
    const row = await t.one(
      `update submission set stage=$2, updated_at=now() where id=$1 returning *`,
      [submissionId, toStage]);
    await t.query(
      `insert into submission_event (submission_id, from_stage, to_stage, reason, actor_id)
       values ($1,$2,$3,$4,$5)`, [submissionId, cur.stage, toStage, reason || null, actorId]);
    await recordEvent(t, "submission.advanced", "submission", submissionId,
                      { from: cur.stage, to: toStage }, actorId);
    return row;
  });
}

export async function poBurndown({ projectId = null, accountName = null,
                                   expiringDays = null } = {}) {
  return rows(
    `select * from po_burndown
      where ($1::uuid is null or project_id = $1)
        and ($2::text is null or account_name ilike '%'||$2||'%')
        and ($3::int is null or (days_remaining is not null and days_remaining <= $3))
      order by days_remaining nulls last, pct_burned desc`,
    [projectId, accountName, expiringDays]);
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

export async function recentEvents(limit = 50) {
  return rows(
    `select e.id, e.kind, e.subject_type, e.subject_id, e.payload, e.trace_id,
            e.occurred_at, u.full_name as actor
       from domain_event e left join app_user u on u.id = e.actor_id
      order by e.id desc limit $1`, [limit]);
}
