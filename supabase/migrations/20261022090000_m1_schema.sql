-- SiteFlow M1 — schema, row level security, private storage.
--
-- Principles (from the approved spec):
--   * Every row belongs to an organization (org_id); a user sees and changes only rows of orgs they are a member of.
--   * Ids are UUIDs generated on the device.
--   * Synced rows carry `version` (optimistic locking — no silent overwrites) and `seq` (pull cursor).
--   * Findings are written only through push_findings(): per-record transactions, version check,
--     server-assigned display numbers, history events. Direct INSERT/UPDATE on findings is not granted.
--   * Nothing is hard-deleted by clients (deleted_at); issued reports are immutable.
--   * Roles: owner / engineer can write; viewer can only read.

-- ---------------------------------------------------------------------------
-- Organizations and membership
-- ---------------------------------------------------------------------------

create table public.orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  -- Report branding: logo path in storage, author details, disclaimer text.
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.memberships (
  org_id uuid not null references public.orgs (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'engineer', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index memberships_user on public.memberships (user_id);

-- security definer: policies call these without recursing into memberships' own policies.
create function public.is_member(p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.memberships m where m.org_id = p_org and m.user_id = auth.uid());
$$;

create function public.can_write(p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships m
    where m.org_id = p_org and m.user_id = auth.uid() and m.role in ('owner', 'engineer')
  );
$$;

-- ---------------------------------------------------------------------------
-- Sync bookkeeping shared by all synced tables
-- ---------------------------------------------------------------------------

create sequence public.change_seq;

-- On insert: version 1. On update: the client must send the version it edited (optimistic lock,
-- see `.eq('version', base)` in the client); the row then gets version + 1 and a fresh seq.
create function public.touch_synced_row() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.version := 1;
  else
    if new.id <> old.id or new.org_id <> old.org_id then
      raise exception 'id and org_id cannot change';
    end if;
    new.version := old.version + 1;
  end if;
  new.seq := nextval('public.change_seq');
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Project setup
-- ---------------------------------------------------------------------------

create table public.projects (
  id uuid primary key,
  org_id uuid not null references public.orgs (id),
  code text not null,
  name text not null,
  address text not null default '',
  developer text not null default '',
  status text not null default 'active' check (status in ('active', 'archived')),
  version integer not null default 1,
  seq bigint not null default nextval('public.change_seq'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- Finding numbers per project. Kept apart from projects so numbering never bumps the project's
-- version (no false conflicts, no re-download). Internal: no client privileges, no policies.
create table public.project_counters (
  project_id uuid primary key references public.projects (id),
  next_finding_no integer not null default 1
);

create table public.locations (
  id uuid primary key,
  org_id uuid not null references public.orgs (id),
  project_id uuid not null references public.projects (id),
  parent_id uuid references public.locations (id),
  kind text not null check (kind in ('building', 'floor', 'unit', 'common', 'site')),
  name text not null,
  code text not null default '',
  sort_order integer not null default 0,
  version integer not null default 1,
  seq bigint not null default nextval('public.change_seq'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index locations_project on public.locations (project_id);

create table public.categories (
  id uuid primary key,
  org_id uuid not null references public.orgs (id),
  name text not null,
  phrases text[] not null default '{}',
  sort_order integer not null default 0,
  version integer not null default 1,
  seq bigint not null default nextval('public.change_seq'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table public.contractors (
  id uuid primary key,
  org_id uuid not null references public.orgs (id),
  name text not null,
  trade text not null default '',
  contact_name text not null default '',
  phone text not null default '',
  email text not null default '',
  version integer not null default 1,
  seq bigint not null default nextval('public.change_seq'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- Contractors working on a project, and the default contractor per category in that project.
create table public.project_contractors (
  id uuid primary key,
  org_id uuid not null references public.orgs (id),
  project_id uuid not null references public.projects (id),
  contractor_id uuid not null references public.contractors (id),
  version integer not null default 1,
  seq bigint not null default nextval('public.change_seq'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (project_id, contractor_id)
);

create table public.project_category_defaults (
  id uuid primary key,
  org_id uuid not null references public.orgs (id),
  project_id uuid not null references public.projects (id),
  category_id uuid not null references public.categories (id),
  contractor_id uuid references public.contractors (id),
  version integer not null default 1,
  seq bigint not null default nextval('public.change_seq'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (project_id, category_id)
);

-- ---------------------------------------------------------------------------
-- Tours and findings
-- ---------------------------------------------------------------------------

create table public.tours (
  id uuid primary key,
  org_id uuid not null references public.orgs (id),
  project_id uuid not null references public.projects (id),
  kind text not null default 'initial' check (kind in ('initial', 'follow_up', 'verification')),
  tour_date date not null,
  participants jsonb not null default '[]'::jsonb,
  scope_location_ids uuid[] not null default '{}',
  status text not null default 'active' check (status in ('active', 'closed')),
  notes text not null default '',
  version integer not null default 1,
  seq bigint not null default nextval('public.change_seq'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index tours_project on public.tours (project_id);

create table public.findings (
  id uuid primary key,
  org_id uuid not null references public.orgs (id),
  project_id uuid not null references public.projects (id),
  display_no integer not null,
  tour_id uuid references public.tours (id),
  -- Shared by findings created together for several units.
  batch_id uuid,
  location_id uuid not null references public.locations (id),
  location_detail text not null default '',
  category_id uuid references public.categories (id),
  contractor_id uuid references public.contractors (id),
  classification text not null default 'missing' check (classification in ('missing', 'defective', 'critical')),
  status text not null default 'open' check (status in ('open', 'reported_done', 'closed', 'reopened', 'cancelled')),
  description text not null,
  photo_ids uuid[] not null default '{}',
  version integer not null default 1,
  seq bigint not null default nextval('public.change_seq'),
  created_at timestamptz not null,
  updated_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  closed_at timestamptz,
  closed_by uuid,
  deleted_at timestamptz,
  unique (project_id, display_no)
);
create index findings_seq on public.findings (seq);
create index findings_project on public.findings (project_id);

-- History: what was opened, changed and closed in each tour. Append-only.
create table public.finding_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id),
  finding_id uuid not null references public.findings (id),
  tour_id uuid references public.tours (id),
  actor_id uuid default auth.uid(),
  at timestamptz not null default now(),
  type text not null check (type in ('created', 'status_changed', 'field_changed', 'photo_added', 'comment')),
  from_value jsonb,
  to_value jsonb,
  note text not null default ''
);
create index finding_events_finding on public.finding_events (finding_id);

create table public.photos (
  id uuid primary key,
  org_id uuid not null references public.orgs (id),
  finding_id uuid references public.findings (id),
  storage_path text not null,
  size integer not null,
  sha256 text not null,
  width integer,
  height integer,
  kind text not null default 'initial' check (kind in ('initial', 'progress', 'closure')),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Reports (immutable once issued) and distribution log
-- ---------------------------------------------------------------------------

create table public.reports (
  id uuid primary key,
  org_id uuid not null references public.orgs (id),
  project_id uuid not null references public.projects (id),
  number text not null,
  revision integer not null default 0,
  supersedes_report_id uuid references public.reports (id),
  format text not null check (format in ('table', 'detailed')),
  title text not null,
  scope jsonb not null,
  issued_at timestamptz not null default now(),
  issued_by uuid default auth.uid(),
  finding_count integer not null,
  snapshot jsonb not null,
  pdf_path text not null,
  pdf_sha256 text not null,
  pdf_bytes integer not null,
  unique (org_id, number, revision)
);

create function public.reports_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'issued reports are immutable';
end $$;
create trigger reports_no_change before update or delete on public.reports
  for each row execute function public.reports_immutable();

create table public.report_distributions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id),
  report_id uuid not null references public.reports (id),
  recipient_name text not null,
  recipient_contractor_id uuid references public.contractors (id),
  channel text not null check (channel in ('email', 'whatsapp', 'print', 'other')),
  sent_at timestamptz not null default now(),
  note text not null default ''
);

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

create trigger touch before insert or update on public.projects for each row execute function public.touch_synced_row();
create trigger touch before insert or update on public.locations for each row execute function public.touch_synced_row();
create trigger touch before insert or update on public.categories for each row execute function public.touch_synced_row();
create trigger touch before insert or update on public.contractors for each row execute function public.touch_synced_row();
create trigger touch before insert or update on public.project_contractors for each row execute function public.touch_synced_row();
create trigger touch before insert or update on public.project_category_defaults for each row execute function public.touch_synced_row();
create trigger touch before insert or update on public.tours for each row execute function public.touch_synced_row();
-- findings get version/seq from push_findings() itself.

-- Rows that reference a project must belong to that project's organization.
create function public.check_same_org() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.project_id is not null
     and not exists (select 1 from public.projects p where p.id = new.project_id and p.org_id = new.org_id) then
    raise exception 'project belongs to another organization';
  end if;
  return new;
end $$;
create trigger same_org before insert or update on public.locations for each row execute function public.check_same_org();
create trigger same_org before insert or update on public.project_contractors for each row execute function public.check_same_org();
create trigger same_org before insert or update on public.project_category_defaults for each row execute function public.check_same_org();
create trigger same_org before insert or update on public.tours for each row execute function public.check_same_org();
create trigger same_org before insert on public.reports for each row execute function public.check_same_org();

-- ---------------------------------------------------------------------------
-- push_findings: the only write path for findings
-- ---------------------------------------------------------------------------

-- The row as the client sees it (same shape as ServerFinding in shared/types.ts).
create function public.finding_json(f public.findings) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', f.id, 'version', f.version, 'displayNo', f.display_no,
    'createdAt', f.created_at, 'updatedAt', f.updated_at,
    'projectId', f.project_id, 'tourId', f.tour_id, 'batchId', f.batch_id,
    'locationId', f.location_id, 'locationDetail', f.location_detail,
    'categoryId', f.category_id, 'contractorId', f.contractor_id,
    'classification', f.classification, 'status', f.status, 'description', f.description,
    'photoIds', to_jsonb(f.photo_ids), 'deletedAt', f.deleted_at
  );
$$;

-- One record: insert (base version 0) or versioned update. Raises on invalid input.
create function public.push_finding_one(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := (p->>'id')::uuid;
  v_base integer := (p->>'baseVersion')::integer;
  d jsonb := p->'data';
  v_project uuid := (d->>'projectId')::uuid;
  v_org uuid;
  v_no integer;
  cur public.findings;
  v_status text := coalesce(d->>'status', 'open');
begin
  select org_id into v_org from public.projects where id = v_project and deleted_at is null;
  if v_org is null or not public.can_write(v_org) then
    raise exception 'forbidden: no write access to project %', v_project;
  end if;
  -- Referenced rows must belong to the same project / organization.
  if not exists (select 1 from public.locations l where l.id = (d->>'locationId')::uuid and l.project_id = v_project) then
    raise exception 'location % is not part of project %', d->>'locationId', v_project;
  end if;
  if d->>'categoryId' is not null
     and not exists (select 1 from public.categories c where c.id = (d->>'categoryId')::uuid and c.org_id = v_org) then
    raise exception 'unknown category %', d->>'categoryId';
  end if;
  if d->>'contractorId' is not null
     and not exists (select 1 from public.contractors c where c.id = (d->>'contractorId')::uuid and c.org_id = v_org) then
    raise exception 'unknown contractor %', d->>'contractorId';
  end if;
  if d->>'tourId' is not null
     and not exists (select 1 from public.tours t where t.id = (d->>'tourId')::uuid and t.project_id = v_project) then
    raise exception 'tour % is not part of project %', d->>'tourId', v_project;
  end if;

  select * into cur from public.findings where id = v_id for update;

  if not found then
    if v_base <> 0 then
      raise exception 'unknown finding % with base version %', v_id, v_base;
    end if;
    insert into public.project_counters (project_id, next_finding_no) values (v_project, 2)
      on conflict (project_id) do update set next_finding_no = public.project_counters.next_finding_no + 1
      returning next_finding_no - 1 into v_no;
    insert into public.findings (
      id, org_id, project_id, display_no, tour_id, batch_id, location_id, location_detail,
      category_id, contractor_id, classification, status, description, photo_ids,
      version, seq, created_at, updated_at, created_by, deleted_at
    ) values (
      v_id, v_org, v_project, v_no, (d->>'tourId')::uuid, (d->>'batchId')::uuid, (d->>'locationId')::uuid,
      coalesce(d->>'locationDetail', ''), (d->>'categoryId')::uuid, (d->>'contractorId')::uuid,
      coalesce(d->>'classification', 'missing'), v_status, d->>'description',
      coalesce(array(select jsonb_array_elements_text(d->'photoIds'))::uuid[], '{}'),
      1, nextval('public.change_seq'), coalesce((p->>'createdAt')::timestamptz, now()), now(), auth.uid(),
      (d->>'deletedAt')::timestamptz
    ) returning * into cur;
    insert into public.finding_events (org_id, finding_id, tour_id, type, to_value)
      values (v_org, v_id, cur.tour_id, 'created', jsonb_build_object('status', cur.status));
    return jsonb_build_object('id', v_id, 'status', 'ok', 'row', public.finding_json(cur));
  end if;

  if cur.org_id <> v_org or cur.project_id <> v_project then
    raise exception 'a finding cannot move between projects';
  end if;
  if cur.version <> v_base then
    return jsonb_build_object('id', v_id, 'status', 'conflict', 'row', public.finding_json(cur));
  end if;

  update public.findings set
    tour_id = (d->>'tourId')::uuid,
    batch_id = (d->>'batchId')::uuid,
    location_id = (d->>'locationId')::uuid,
    location_detail = coalesce(d->>'locationDetail', ''),
    category_id = (d->>'categoryId')::uuid,
    contractor_id = (d->>'contractorId')::uuid,
    classification = coalesce(d->>'classification', 'missing'),
    status = v_status,
    description = d->>'description',
    photo_ids = coalesce(array(select jsonb_array_elements_text(d->'photoIds'))::uuid[], '{}'),
    deleted_at = (d->>'deletedAt')::timestamptz,
    closed_at = case when v_status = 'closed' and cur.status <> 'closed' then now()
                     when v_status <> 'closed' then null else cur.closed_at end,
    closed_by = case when v_status = 'closed' and cur.status <> 'closed' then auth.uid()
                     when v_status <> 'closed' then null else cur.closed_by end,
    version = cur.version + 1,
    seq = nextval('public.change_seq'),
    updated_at = now()
  where id = v_id
  returning * into cur;

  return jsonb_build_object('id', v_id, 'status', 'ok', 'row', public.finding_json(cur));
end $$;

-- Status changes are recorded by a trigger so no write path can skip the history.
create function public.log_finding_status() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status is distinct from old.status then
    insert into public.finding_events (org_id, finding_id, tour_id, type, from_value, to_value)
      values (new.org_id, new.id, new.tour_id, 'status_changed',
              jsonb_build_object('status', old.status), jsonb_build_object('status', new.status));
  end if;
  return new;
end $$;
create trigger log_status after update on public.findings for each row execute function public.log_finding_status();

-- Batch entry point. Each record runs in its own subtransaction: one bad record
-- returns {status:'error'} and never rolls back the others.
create function public.push_findings(p_changes jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  ch jsonb;
  results jsonb := '[]'::jsonb;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  for ch in select * from jsonb_array_elements(p_changes) loop
    begin
      results := results || public.push_finding_one(ch);
    exception when others then
      results := results || jsonb_build_object('id', ch->>'id', 'status', 'error', 'error', sqlerrm);
    end;
  end loop;
  return results;
end $$;

-- ---------------------------------------------------------------------------
-- Admin: add a user to an organization (run from the SQL editor; not callable by app users)
-- ---------------------------------------------------------------------------

create function public.admin_add_member(p_email text, p_org_name text, p_role text default 'owner') returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid;
  v_org uuid;
begin
  select id into v_user from auth.users where lower(email) = lower(p_email);
  if v_user is null then
    raise exception 'no auth user with email % — create it first under Authentication → Users', p_email;
  end if;
  select id into v_org from public.orgs where name = p_org_name;
  if v_org is null then
    insert into public.orgs (name) values (p_org_name) returning id into v_org;
  end if;
  insert into public.memberships (org_id, user_id, role) values (v_org, v_user, p_role)
    on conflict (org_id, user_id) do update set role = excluded.role;
  return v_org;
end $$;

-- ---------------------------------------------------------------------------
-- Privileges and row level security
-- ---------------------------------------------------------------------------

-- Nothing for anonymous callers, anywhere in the public schema.
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke execute on all functions in schema public from anon, public;

grant execute on function public.push_findings(jsonb) to authenticated;
grant execute on function public.is_member(uuid), public.can_write(uuid) to authenticated;
revoke execute on function public.push_finding_one(jsonb) from authenticated;
revoke execute on function public.admin_add_member(text, text, text) from authenticated;
grant execute on function public.admin_add_member(text, text, text) to service_role;

-- No client hard deletes anywhere; findings only through push_findings(); orgs/memberships read-only.
revoke delete, truncate on all tables in schema public from authenticated;
revoke insert, update on public.findings, public.finding_events, public.orgs, public.memberships from authenticated;
revoke all on public.project_counters from authenticated;
revoke update on public.photos, public.reports, public.report_distributions from authenticated;

alter table public.orgs enable row level security;
alter table public.memberships enable row level security;
alter table public.projects enable row level security;
alter table public.project_counters enable row level security;
alter table public.locations enable row level security;
alter table public.categories enable row level security;
alter table public.contractors enable row level security;
alter table public.project_contractors enable row level security;
alter table public.project_category_defaults enable row level security;
alter table public.tours enable row level security;
alter table public.findings enable row level security;
alter table public.finding_events enable row level security;
alter table public.photos enable row level security;
alter table public.reports enable row level security;
alter table public.report_distributions enable row level security;

create policy read_own_orgs on public.orgs for select to authenticated using (public.is_member(id));
create policy read_own_memberships on public.memberships for select to authenticated using (user_id = auth.uid());

-- Same three policies on every org-scoped table: members read, writers insert and update.
do $$
declare t text;
begin
  foreach t in array array[
    'projects', 'locations', 'categories', 'contractors', 'project_contractors',
    'project_category_defaults', 'tours', 'findings', 'finding_events', 'photos', 'reports', 'report_distributions'
  ] loop
    execute format('create policy member_read on public.%I for select to authenticated using (public.is_member(org_id))', t);
    execute format('create policy writer_insert on public.%I for insert to authenticated with check (public.can_write(org_id))', t);
    execute format('create policy writer_update on public.%I for update to authenticated using (public.can_write(org_id)) with check (public.can_write(org_id))', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Private storage: <org_id>/<...> paths; photos and reports are write-once
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('photos', 'photos', false, 15728640, array['image/jpeg']),
  ('reports', 'reports', false, 52428800, array['application/pdf'])
on conflict (id) do nothing;

create function public.org_of_path(p_name text) returns uuid
language plpgsql immutable set search_path = '' as $$
begin
  return split_part(p_name, '/', 1)::uuid;
exception when others then
  return null;
end $$;
revoke execute on function public.org_of_path(text) from anon, public;
grant execute on function public.org_of_path(text) to authenticated;

create policy siteflow_read on storage.objects for select to authenticated
  using (bucket_id in ('photos', 'reports') and public.is_member(public.org_of_path(name)));
create policy siteflow_insert on storage.objects for insert to authenticated
  with check (bucket_id in ('photos', 'reports') and public.can_write(public.org_of_path(name)));
-- No update or delete policies: stored photos and reports cannot be replaced or removed by clients.
