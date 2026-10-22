// The active project (and tour) on every main screen, with a way to switch project (UX-03).
// Switching only changes the current project: each project keeps its own capture draft.
import { useState } from 'react';
import { useProjects } from '../projectData';
import { setCurrentProject } from '../setup';
import { useActiveTour } from '../tours';
import { Dialog } from './Dialog';
import { tourLabel } from './Tours';

export function ProjectBar({ screen, onTours, showTour }: { screen: string; onTours: () => void; showTour: boolean }) {
  const projects = useProjects();
  const current = projects?.current ?? null;
  const tour = useActiveTour(current?.id);
  const [switching, setSwitching] = useState(false);
  if (!projects || !current) return <h1 className="sr-only">{screen}</h1>;
  const active = projects.all.filter((p) => p.status === 'active');
  return (
    <div className="project-bar">
      <h1 className="sr-only">{screen}</h1>
      <div className="pb-main">
        <span className="pb-label">פרויקט</span>
        <b className="pb-name">
          <bdi>{current.name}</bdi>
        </b>
        <span className="pb-code" dir="ltr">{current.code}</span>
      </div>
      {showTour && tour !== undefined && (
        <button className="pb-tour" onClick={onTours} aria-label={tour ? `סיור פעיל: ${tourLabel(tour)}. מעבר לסיורים` : 'אין סיור פעיל. מעבר לסיורים'}>
          {tour ? (
            <>
              <span className="pb-dot" aria-hidden="true" />
              {tourLabel(tour)}
            </>
          ) : (
            'אין סיור פעיל'
          )}
        </button>
      )}
      {active.length > 1 && (
        <button className="link pb-switch" onClick={() => setSwitching(true)}>
          החלף פרויקט
        </button>
      )}
      <button
        className="link pb-all"
        onClick={() => {
          sessionStorage.setItem('sf.setupView', 'home');
          window.dispatchEvent(new CustomEvent('sf:navigate', { detail: { tab: 'setup' } }));
        }}
      >
        כל הפרויקטים
      </button>
      {switching && (
        <Dialog title="החלפת פרויקט" onClose={() => setSwitching(false)}>
          <p className="muted">לכל פרויקט טיוטת תיעוד משלו — מיקום, תמונות וקבלן לא עוברים בין פרויקטים.</p>
          <div className="pb-list" role="radiogroup" aria-label="פרויקטים">
            {active.map((p) => (
              <button
                key={p.id}
                role="radio"
                aria-checked={p.id === current.id}
                className={`pb-option ${p.id === current.id ? 'on' : ''}`}
                onClick={async () => {
                  await setCurrentProject(p.id);
                  setSwitching(false);
                }}
              >
                <b>
                  <bdi>{p.name}</bdi>
                </b>
                <span className="pb-code" dir="ltr">{p.code}</span>
              </button>
            ))}
          </div>
          <p className="muted">יצירת פרויקט, ניהול ופרויקטים בארכיון — ב"כל הפרויקטים".</p>
        </Dialog>
      )}
    </div>
  );
}
