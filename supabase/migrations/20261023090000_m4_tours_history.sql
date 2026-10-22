-- SiteFlow M4 — tours and finding history.
--
--   * Finding history is recorded on the device, as it happens (also offline): each meaningful change
--     becomes an event with its own time, type, values and the tour it was made in. The events travel
--     with the finding in push_findings() and are stored idempotently (the event id comes from the device).
--     The server stamps the actor itself (auth.uid()) and never accepts a time in the future.
--   * A client that sends no events (an older app version) still gets history: the server derives
--     'created' / 'status_changed' / 'field_changed' / 'deleted' / 'restored' from the change itself.
--   * A new finding — or an edit that changes the contractor — must name a contractor that is active in
--     the project. Findings already assigned to a contractor keep it when edited for anything else.
--   * Findings recorded before tours existed keep tour_id null: nothing is back-filled.

-- History rows get a pull cursor like every other synced table, and the new event types.
alter table public.finding_events add column seq bigint not null default nextval('public.change_seq');
alter table public.finding_events add column recorded_at timestamptz not null default now();
create index finding_events_seq on public.finding_events (seq);
alter table public.finding_events drop constraint finding_events_type_check;
alter table public.finding_events add constraint finding_events_type_check
  check (type in ('created', 'status_changed', 'field_changed', 'photo_added', 'comment', 'deleted', 'restored'));

-- Status history now comes from push_finding_one (with the right tour and time), not from a trigger
-- that could only see the finding's original tour and the sync time.
drop trigger log_status on public.findings;
drop function public.log_finding_status();

create function public.contractor_active(p_project uuid, p_contractor uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.project_contractors pc
    join public.contractors c on c.id = pc.contractor_id
    where pc.project_id = p_project and pc.contractor_id = p_contractor
      and pc.deleted_at is null and c.deleted_at is null
  );
$$;

-- Events derived by the server for clients that send none.
create function public.derived_events(old_f public.findings, new_f public.findings) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  ev jsonb := '[]'::jsonb;
  f text;
  o jsonb;
  n jsonb;
  oj jsonb := to_jsonb(old_f);
  nj jsonb := to_jsonb(new_f);
  fr jsonb := '{}'::jsonb;
  t jsonb := '{}'::jsonb;
begin
  if old_f.id is null then
    return jsonb_build_array(jsonb_build_object('type', 'created', 'to', jsonb_build_object('status', new_f.status)));
  end if;
  if old_f.deleted_at is null and new_f.deleted_at is not null then
    ev := ev || jsonb_build_object('type', 'deleted');
  elsif old_f.deleted_at is not null and new_f.deleted_at is null then
    ev := ev || jsonb_build_object('type', 'restored');
  end if;
  if old_f.status is distinct from new_f.status then
    ev := ev || jsonb_build_object('type', 'status_changed', 'from', jsonb_build_object('status', old_f.status), 'to', jsonb_build_object('status', new_f.status));
  end if;
  foreach f in array array['description', 'location_id', 'location_detail', 'category_id', 'contractor_id', 'classification', 'photo_ids'] loop
    o := oj->f;
    n := nj->f;
    if o is distinct from n then
      fr := fr || jsonb_build_object(f, o);
      t := t || jsonb_build_object(f, n);
    end if;
  end loop;
  if t <> '{}'::jsonb then
    ev := ev || jsonb_build_object('type', 'field_changed', 'from', fr, 'to', t);
  end if;
  return ev;
end $$;

create or replace function public.push_finding_one(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := (p->>'id')::uuid;
  v_base integer := (p->>'baseVersion')::integer;
  d jsonb := p->'data';
  v_project uuid := (d->>'projectId')::uuid;
  v_contractor uuid := (d->>'contractorId')::uuid;
  v_org uuid;
  v_no integer;
  cur public.findings;
  prev public.findings;
  v_status text := coalesce(d->>'status', 'open');
  e jsonb;
  v_events jsonb;
  v_tour uuid;
  v_exists boolean;
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
  if v_contractor is not null
     and not exists (select 1 from public.contractors c where c.id = v_contractor and c.org_id = v_org) then
    raise exception 'unknown contractor %', v_contractor;
  end if;
  if d->>'tourId' is not null
     and not exists (select 1 from public.tours t where t.id = (d->>'tourId')::uuid and t.project_id = v_project) then
    raise exception 'tour % is not part of project %', d->>'tourId', v_project;
  end if;

  select * into cur from public.findings where id = v_id for update;
  v_exists := found;

  -- A contractor must be active in the project when it is assigned — on a new finding, or when an
  -- edit changes the contractor. Keeping a historical contractor on an existing finding is allowed.
  if v_contractor is not null and (not v_exists or cur.contractor_id is distinct from v_contractor)
     and not public.contractor_active(v_project, v_contractor) then
    raise exception 'הקבלן אינו פעיל בפרויקט — בחר קבלן אחר (contractor % is not active in project %)', v_contractor, v_project;
  end if;

  if not v_exists then
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
      coalesce(d->>'locationDetail', ''), (d->>'categoryId')::uuid, v_contractor,
      coalesce(d->>'classification', 'missing'), v_status, d->>'description',
      coalesce(array(select jsonb_array_elements_text(d->'photoIds'))::uuid[], '{}'),
      1, nextval('public.change_seq'), coalesce((p->>'createdAt')::timestamptz, now()), now(), auth.uid(),
      (d->>'deletedAt')::timestamptz
    ) returning * into cur;
  else
    if cur.org_id <> v_org or cur.project_id <> v_project then
      raise exception 'a finding cannot move between projects';
    end if;
    if cur.version <> v_base then
      return jsonb_build_object('id', v_id, 'status', 'conflict', 'row', public.finding_json(cur));
    end if;
    prev := cur;
    update public.findings set
      tour_id = (d->>'tourId')::uuid,
      batch_id = (d->>'batchId')::uuid,
      location_id = (d->>'locationId')::uuid,
      location_detail = coalesce(d->>'locationDetail', ''),
      category_id = (d->>'categoryId')::uuid,
      contractor_id = v_contractor,
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
  end if;

  -- History: the device's events (each with its own time and tour), or derived ones for older clients.
  v_events := case when p ? 'events' then coalesce(p->'events', '[]'::jsonb) else public.derived_events(prev, cur) end;
  for e in select * from jsonb_array_elements(v_events) loop
    v_tour := (e->>'tourId')::uuid;
    if v_tour is not null and not exists (select 1 from public.tours t where t.id = v_tour and t.project_id = v_project) then
      v_tour := null;
    end if;
    insert into public.finding_events (id, org_id, finding_id, tour_id, actor_id, at, type, from_value, to_value, note)
    values (
      coalesce((e->>'id')::uuid, gen_random_uuid()), v_org, v_id,
      case when p ? 'events' then v_tour else cur.tour_id end,
      auth.uid(), least(coalesce((e->>'at')::timestamptz, now()), now()),
      e->>'type', e->'from', e->'to', coalesce(e->>'note', '')
    )
    on conflict (id) do nothing;
  end loop;

  return jsonb_build_object('id', v_id, 'status', 'ok', 'row', public.finding_json(cur));
end $$;

revoke execute on function public.push_finding_one(jsonb) from public, anon, authenticated;
revoke execute on function public.derived_events(public.findings, public.findings) from public, anon, authenticated;
revoke execute on function public.contractor_active(uuid, uuid) from public, anon, authenticated;
