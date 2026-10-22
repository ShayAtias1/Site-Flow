import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { db, type CategoryRow, type ContractorRow, type ProjectRow } from '../../db';
import { createCategory, deleteCategory, setCategoryDefault, updateCategory } from '../../setup';
import { Icon } from '../../icons';
import { Confirm, ErrorBox, useRunner } from './ui';

function useCategories(project: ProjectRow) {
  return useLiveQuery(async () => {
    const [categories, defaults, pcs, contractors] = await Promise.all([
      db.categories.filter((c) => c.org_id === project.org_id && !c.deleted_at).toArray(),
      db.project_category_defaults.where('project_id').equals(project.id).toArray(),
      db.project_contractors.where('project_id').equals(project.id).toArray(),
      db.contractors.filter((c) => c.org_id === project.org_id && !c.deleted_at).toArray(),
    ]);
    const onProject = new Set(pcs.filter((pc) => !pc.deleted_at).map((pc) => pc.contractor_id));
    return {
      categories: categories.sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, 'he')),
      defaultOf: new Map(defaults.filter((d) => !d.deleted_at && d.contractor_id && onProject.has(d.contractor_id)).map((d) => [d.category_id, d.contractor_id!])),
      contractors: contractors.filter((c) => onProject.has(c.id)).sort((a, b) => a.name.localeCompare(b.name, 'he')),
    };
  }, [project.id]);
}

export function Categories({ project, readOnly }: { project: ProjectRow; readOnly: boolean }) {
  const data = useCategories(project);
  const [name, setName] = useState('');
  const { busy, error, run } = useRunner();
  if (!data) return null;
  const add = async () => {
    if (await run(() => createCategory(project.org_id, name, []))) setName('');
  };
  return (
    <div className="categories">
      <section className="scope-section" aria-labelledby="cat-project">
        <div className="scope-head">
          <h2 className="section-title" id="cat-project">קבלן ברירת מחדל לכל קטגוריה</h2>
          <span className="scope-tag project">רק בפרויקט {project.name}</span>
        </div>
        <p className="muted">בתיעוד, בחירת קטגוריה ממלאת את הקבלן הזה. השינוי נשמר מיד ומשפיע על ממצאים חדשים בפרויקט הזה בלבד; ממצאים קיימים לא משתנים.</p>
        <div className="defaults-list">
          {data.categories.map((c) => (
            <DefaultRow key={c.id} project={project} c={c} contractors={data.contractors} defaultId={data.defaultOf.get(c.id) ?? ''} readOnly={readOnly} />
          ))}
        </div>
      </section>
      <section className="scope-section" aria-labelledby="cat-org">
        <div className="scope-head">
          <h2 className="section-title" id="cat-org">ספריית הארגון: קטגוריות וביטויים מוכנים</h2>
          <span className="scope-tag org">משותף לכל פרויקטי הארגון</span>
        </div>
        <p className="muted">שינוי שם, ביטוי או מחיקה כאן משפיעים על התיעוד בכל הפרויקטים של הארגון.</p>
      {!readOnly && (
        <div className="inline-add">
          <input value={name} placeholder="קטגוריה חדשה, לדוגמה: גבס" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && add()} />
          <button className="btn primary-solid" disabled={busy || !name.trim()} onClick={add}>
            + קטגוריה
          </button>
        </div>
      )}
      <ErrorBox error={error} />
      <div className="cards-grid">
        {data.categories.map((c) => (
          <CategoryCard key={`${c.id}:${c.version}`} c={c} readOnly={readOnly} />
        ))}
      </div>
      </section>
    </div>
  );
}

function DefaultRow({ project, c, contractors, defaultId, readOnly }: { project: ProjectRow; c: CategoryRow; contractors: ContractorRow[]; defaultId: string; readOnly: boolean }) {
  const { busy, error, run } = useRunner();
  return (
    <div className="default-row">
      <label className="drow cat-default">
        <span className="drow-label">{c.name}</span>
        <select
          className="drow-select"
          value={defaultId}
          disabled={readOnly || busy}
          aria-label={`קבלן ברירת מחדל ל${c.name}`}
          onChange={(e) => run(() => setCategoryDefault(project, c.id, e.target.value || null))}
        >
          <option value="">ללא</option>
          {contractors.map((k) => (
            <option key={k.id} value={k.id}>{k.name}</option>
          ))}
        </select>
        <span className="chev"><Icon name="chevron" size={16} strokeWidth={2.4} /></span>
      </label>
      <ErrorBox error={error} />
    </div>
  );
}

function CategoryCard({ c, readOnly }: { c: CategoryRow; readOnly: boolean }) {
  const [name, setName] = useState(c.name);
  const [phrase, setPhrase] = useState('');
  const [more, setMore] = useState(false);
  const { busy, error, run } = useRunner();
  const addPhrase = async () => {
    if (!phrase.trim()) return;
    if (await run(() => updateCategory(c, { phrases: [...c.phrases, phrase] }))) setPhrase('');
  };
  return (
    <section className="card category-card" data-id={c.id}>
      <div className="cat-head">
        {readOnly ? (
          <b>{c.name}</b>
        ) : (
          <input className="cat-name" aria-label="שם הקטגוריה" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name !== c.name && run(() => updateCategory(c, { name }))} />
        )}
      </div>
      <div className="label">ביטויים מוכנים</div>
      <div className="chips">
        {c.phrases.map((p) => (
          <span key={p} className="chip ghost small phrase">
            {p}
            {!readOnly && (
              <button className="x-inline" aria-label={`הסר את הביטוי ${p}`} disabled={busy} onClick={() => run(() => updateCategory(c, { phrases: c.phrases.filter((x) => x !== p) }))}>
                ×
              </button>
            )}
          </span>
        ))}
        {!c.phrases.length && <span className="muted">אין ביטויים</span>}
      </div>
      {!readOnly && (
        <div className="inline-add">
          <input value={phrase} placeholder="ביטוי חדש" aria-label={`ביטוי חדש ל${c.name}`} onChange={(e) => setPhrase(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addPhrase()} />
          <button className="btn" disabled={busy || !phrase.trim()} onClick={addPhrase}>
            הוסף
          </button>
        </div>
      )}
      <ErrorBox error={error} />
      {!readOnly && (
        <div className="sub-block">
          {more ? (
            <Confirm
              action="מחק קטגוריה"
              text="הקטגוריה תוסתר מהתיעוד בכל פרויקטי הארגון. ממצאים קיימים שומרים את הקטגוריה שלהם."
              busy={busy}
              onConfirm={() => run(() => deleteCategory(c))}
            />
          ) : (
            <button className="link" onClick={() => setMore(true)}>
              מחיקה…
            </button>
          )}
        </div>
      )}
    </section>
  );
}
