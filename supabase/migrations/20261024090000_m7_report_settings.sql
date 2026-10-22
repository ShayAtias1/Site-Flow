-- SiteFlow M7 — report settings (branding) and the distribution log's integrity.
-- Additive only: one new table, one new trigger. No existing row or policy is changed.

-- One row per organization: what every report of the organization shows as company and author.
-- Nothing here is invented by the system: empty fields are left out of the report.
-- Logo and signature are small images kept inline as data URIs (PNG/JPEG, resized on the device).
create table public.report_settings (
  id uuid primary key,
  org_id uuid not null unique references public.orgs (id),
  company_name text not null default '',
  company_details text not null default '',
  logo text check (logo is null or (logo ~ '^data:image/(png|jpeg);base64,[A-Za-z0-9+/=]+$' and length(logo) <= 800000)),
  author_name text not null default '',
  author_title text not null default '',
  -- Optional professional registration (e.g. engineer registry number), exactly as the user typed it.
  author_registration text not null default '',
  signature text check (signature is null or (signature ~ '^data:image/(png|jpeg);base64,[A-Za-z0-9+/=]+$' and length(signature) <= 800000)),
  version integer not null default 1,
  seq bigint not null default nextval('public.change_seq'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create trigger touch before insert or update on public.report_settings
  for each row execute function public.touch_synced_row();

alter table public.report_settings enable row level security;
create policy member_read on public.report_settings for select to authenticated using (public.is_member(org_id));
create policy writer_insert on public.report_settings for insert to authenticated with check (public.can_write(org_id));
create policy writer_update on public.report_settings for update to authenticated
  using (public.can_write(org_id)) with check (public.can_write(org_id));

grant select, insert, update on public.report_settings to authenticated;

-- A distribution entry must point at a report of the same organization.
create function public.check_distribution_org() returns trigger
language plpgsql set search_path = '' as $$
begin
  if not exists (select 1 from public.reports r where r.id = new.report_id and r.org_id = new.org_id) then
    raise exception 'report belongs to another organization';
  end if;
  if new.recipient_contractor_id is not null
     and not exists (select 1 from public.contractors c where c.id = new.recipient_contractor_id and c.org_id = new.org_id) then
    raise exception 'contractor belongs to another organization';
  end if;
  return new;
end $$;
revoke execute on function public.check_distribution_org() from public, anon, authenticated;

create trigger same_org before insert on public.report_distributions
  for each row execute function public.check_distribution_org();
