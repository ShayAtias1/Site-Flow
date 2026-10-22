-- SiteFlow M3 — project setup from the app.
-- Setup rows are written by owners/engineers directly (RLS + grants from M1/M2). This migration adds
-- the integrity rules the setup screens rely on, enforced on the server so no client can skip them:
--   * a project code is unique within its organization (it prefixes report numbers);
--   * a location's parent belongs to the same project, and a location never moves between projects;
--   * a location (with everything under it) cannot be deleted while findings are recorded there.

create unique index projects_org_code on public.projects (org_id, lower(code)) where deleted_at is null;

create function public.check_location() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.project_id <> old.project_id then
    raise exception 'a location cannot move between projects';
  end if;
  if new.parent_id is not null then
    if new.parent_id = new.id then
      raise exception 'a location cannot be its own parent';
    end if;
    if not exists (select 1 from public.locations p where p.id = new.parent_id and p.project_id = new.project_id) then
      raise exception 'parent location belongs to another project';
    end if;
  end if;
  -- Soft delete: refused while live findings are recorded in this location or anywhere under it.
  if tg_op = 'UPDATE' and new.deleted_at is not null and old.deleted_at is null then
    if exists (
      with recursive sub(id) as (
        select new.id
        union
        select l.id from public.locations l join sub on l.parent_id = sub.id
      )
      select 1 from public.findings f join sub on f.location_id = sub.id where f.deleted_at is null
    ) then
      raise exception 'location has findings and cannot be deleted' using errcode = 'P0001', hint = 'has_findings';
    end if;
  end if;
  return new;
end $$;

-- AFTER: a multi-row insert (the structure generator sends a whole building at once) sees all of its rows.
create constraint trigger check_location after insert or update on public.locations
  for each row execute function public.check_location();
