-- SiteFlow M2 — bootstrap a demo project into an organization.
-- Until project setup exists (M3), this is how an organization gets a project to work on.
-- Same structure as the PoC demo (shared/project.ts). Run from the SQL editor:
--   select public.admin_seed_demo_project('שם החברה');
-- Re-running returns the existing project; categories and contractors are reused by name.

create function public.admin_seed_demo_project(p_org_name text, p_project_name text default 'פרויקט הדגמה — מגדלי הפארק')
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
  v_project uuid;
  v_building uuid;
  v_floor uuid;
  v_site uuid;
  v_order integer := 0;
  b text;
  f integer;
  u integer;
  no integer;
  c record;
  v_cat uuid;
  v_con uuid;
begin
  select id into v_org from public.orgs where name = p_org_name;
  if v_org is null then
    raise exception 'no organization named % — run admin_add_member first', p_org_name;
  end if;
  select id into v_project from public.projects where org_id = v_org and name = p_project_name and deleted_at is null;
  if v_project is not null then
    return v_project;
  end if;

  v_project := gen_random_uuid();
  insert into public.projects (id, org_id, code, name, address, developer)
    values (v_project, v_org, 'DEMO', p_project_name, 'רח׳ הדוגמה 12, עיר לדוגמה', 'חברת יזמות לדוגמה בע״מ');

  -- Locations, in walking order.
  foreach b in array array['A', 'B'] loop
    v_building := gen_random_uuid();
    v_order := v_order + 1;
    insert into public.locations (id, org_id, project_id, parent_id, kind, name, code, sort_order)
      values (v_building, v_org, v_project, null, 'building', 'בניין ' || b, b, v_order);
    v_order := v_order + 1;
    insert into public.locations (id, org_id, project_id, parent_id, kind, name, code, sort_order)
      values (gen_random_uuid(), v_org, v_project, v_building, 'common', 'לובי כניסה', b || '-LOBBY', v_order);
    v_order := v_order + 1;
    insert into public.locations (id, org_id, project_id, parent_id, kind, name, code, sort_order)
      values (gen_random_uuid(), v_org, v_project, v_building, 'common', 'חדר מדרגות', b || '-STAIRS', v_order);
    for f in 1..4 loop
      v_floor := gen_random_uuid();
      v_order := v_order + 1;
      insert into public.locations (id, org_id, project_id, parent_id, kind, name, code, sort_order)
        values (v_floor, v_org, v_project, v_building, 'floor', 'קומה ' || f, b || '-' || lpad(f::text, 2, '0'), v_order);
      for u in 1..4 loop
        no := (f - 1) * 4 + u;
        v_order := v_order + 1;
        insert into public.locations (id, org_id, project_id, parent_id, kind, name, code, sort_order)
          values (gen_random_uuid(), v_org, v_project, v_floor, 'unit', 'דירה ' || no,
                  b || '-' || lpad(f::text, 2, '0') || '-' || lpad(no::text, 2, '0'), v_order);
      end loop;
    end loop;
    v_order := v_order + 1;
    insert into public.locations (id, org_id, project_id, parent_id, kind, name, code, sort_order)
      values (gen_random_uuid(), v_org, v_project, v_building, 'common', 'גג', b || '-ROOF', v_order);
  end loop;
  v_site := gen_random_uuid();
  v_order := v_order + 1;
  insert into public.locations (id, org_id, project_id, parent_id, kind, name, code, sort_order)
    values (v_site, v_org, v_project, null, 'site', 'פיתוח ושטחים משותפים', 'SITE', v_order);
  v_order := v_order + 1;
  insert into public.locations (id, org_id, project_id, parent_id, kind, name, code, sort_order)
    values (gen_random_uuid(), v_org, v_project, v_site, 'common', 'חניון ‎-1', 'P-1', v_order);
  v_order := v_order + 1;
  insert into public.locations (id, org_id, project_id, parent_id, kind, name, code, sort_order)
    values (gen_random_uuid(), v_org, v_project, v_site, 'common', 'גינה צפונית', 'GARDEN-N', v_order);
  v_order := v_order + 1;
  insert into public.locations (id, org_id, project_id, parent_id, kind, name, code, sort_order)
    values (gen_random_uuid(), v_org, v_project, v_site, 'common', 'חדר משאבות', 'PUMPS', v_order);

  -- Categories with phrases, each with its default contractor in this project.
  v_order := 0;
  for c in
    select * from (values
      ('אינסטלציה', array['חסר כיסוי ביקורת', 'חסר סיליקון סביב כלים סניטריים', 'חסרה סוללה', 'נזילה בחיבור'], 'אינסטלציה כהן בע״מ', 'אינסטלציה'),
      ('חשמל', array['חסרים כיסויי שקעים', 'חסר גוף תאורה', 'לוח חשמל ללא שילוט', 'חסר שקע 16A'], 'לוי חשמל ותקשורת', 'חשמל'),
      ('ריצוף וחיפוי', array['חסר רובה', 'אריח סדוק להחלפה', 'חסר פאנל', 'חסר סף שיש'], 'ריצוף מזרחי', 'ריצוף וחיפוי'),
      ('אלומיניום', array['חסרה רשת', 'חסר ידית', 'כנף לא נסגרת', 'חסר אטם'], 'אלומיניום השרון', 'אלומיניום'),
      ('טיח וצבע', array['תיקוני טיח', 'שכבת צבע אחרונה חסרה', 'כתמים על הקיר'], 'טיח ושפכטל אברהם', 'טיח וצבע'),
      ('נגרות', array['חסר משקוף', 'דלת לא מכוונת', 'חסרה ידית דלת'], 'נגרות גולן', 'נגרות'),
      ('מסגרות', array['חסר מעקה', 'חסרה צביעה למעקה', 'חסר עיגון'], 'מסגרות הצפון', 'מסגרות'),
      ('איטום', array['חסר איטום בחיבור', 'סימני רטיבות'], 'איטום פלוס', 'איטום'),
      ('כללי', array['חסר ניקוי', 'פסולת בניין לפינוי'], 'קבלן ראשי', 'כללי')
    ) as t(cat_name, phrases, con_name, trade)
  loop
    v_order := v_order + 1;
    select id into v_cat from public.categories where org_id = v_org and name = c.cat_name and deleted_at is null;
    if v_cat is null then
      v_cat := gen_random_uuid();
      insert into public.categories (id, org_id, name, phrases, sort_order) values (v_cat, v_org, c.cat_name, c.phrases, v_order);
    end if;
    select id into v_con from public.contractors where org_id = v_org and name = c.con_name and deleted_at is null;
    if v_con is null then
      v_con := gen_random_uuid();
      insert into public.contractors (id, org_id, name, trade) values (v_con, v_org, c.con_name, c.trade);
    end if;
    insert into public.project_contractors (id, org_id, project_id, contractor_id)
      values (gen_random_uuid(), v_org, v_project, v_con) on conflict (project_id, contractor_id) do nothing;
    insert into public.project_category_defaults (id, org_id, project_id, category_id, contractor_id)
      values (gen_random_uuid(), v_org, v_project, v_cat, v_con) on conflict (project_id, category_id) do nothing;
  end loop;

  return v_project;
end $$;

revoke execute on function public.admin_seed_demo_project(text, text) from public, anon, authenticated;
grant execute on function public.admin_seed_demo_project(text, text) to service_role;
