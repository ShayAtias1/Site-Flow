-- SiteFlow M2 — explicit table privileges.
-- New hosted Supabase projects do not grant table privileges to `authenticated` automatically,
-- while the local stack does. Relying on those defaults made every read fail on the hosted project
-- ("permission denied for table projects"). Privileges are now stated explicitly, and the defaults
-- are revoked first so the local stack behaves exactly like the hosted one.
-- RLS policies (M1) still decide which rows; these grants decide which operations exist at all.

revoke all on all tables in schema public from authenticated;
revoke all on all sequences in schema public from authenticated;

-- Read: everything org-scoped (rows filtered by RLS). Internal counters stay hidden.
grant select on
  public.orgs, public.memberships, public.projects, public.locations, public.categories, public.contractors,
  public.project_contractors, public.project_category_defaults, public.tours, public.findings,
  public.finding_events, public.photos, public.reports, public.report_distributions
to authenticated;

-- Setup tables: insert and update (optimistic locking via `version`, soft delete via deleted_at).
grant insert, update on
  public.projects, public.locations, public.categories, public.contractors,
  public.project_contractors, public.project_category_defaults, public.tours
to authenticated;

-- Write-once records.
grant insert on public.photos, public.reports, public.report_distributions to authenticated;

-- Inserts take `seq` from this sequence (column default and touch_synced_row()).
grant usage on sequence public.change_seq to authenticated;

-- findings / finding_events: no direct writes — push_findings() (security definer) only.
-- project_counters: no access.
