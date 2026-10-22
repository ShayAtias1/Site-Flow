// The active project (and tour) on every main screen, with a way to switch project (UX-03).
// Switching only changes the current project: each project keeps its own capture draft.
import { useState } from 'react';
import { useProjects } from '../projectData';
import { setCurrentProject } from '../setup';
import { useActiveTour } from '../tours';
import { Icon } from '../icons';
import { Dialog } from './Dialog';
import { tourLabel } from './Tours';

export function ProjectBar({ screen, onTours, showTour, showAll = true }: { screen: string; onTours: () => void; showTour: boolean; showAll?: boolean }) {
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
      {showAll && (
        <button className="link pb-all" onClick={() => window.dispatchEvent(new CustomEvent('sf:navigate', { detail: { tab: 'setup' } }))}>
          כל הפרויקטים
        </button>
      )}
      {switching && <ProjectSwitchDialog onClose={() => setSwitching(false)} />}
    </div>
  );
}

/** The project's name in the top header of the capture screen; tapping it opens the project switcher in place. */
export function HeaderProject() {
  const projects = useProjects();
  const [switching, setSwitching] = useState(false);
  const current = projects?.current;
  if (!projects || !current) return <span className="hdr-project-slot" />;
  const several = projects.all.filter((p) => p.status === 'active').length > 1;
  const name = (
    <>
      <bdi className="pb-name">{current.name}</bdi>
      <span className="pb-code" dir="ltr">{current.code}</span>
    </>
  );
  return (
    <>
      {several ? (
        <button className="hdr-project pb-switch" aria-haspopup="dialog" aria-label={`פרויקט: ${current.name}. החלפת פרויקט`} onClick={() => setSwitching(true)}>
          {name}
          <Icon name="down" size={14} strokeWidth={2.6} />
        </button>
      ) : (
        <span className="hdr-project" aria-label={`פרויקט: ${current.name}`}>{name}</span>
      )}
      {switching && <ProjectSwitchDialog onClose={() => setSwitching(false)} />}
    </>
  );
}

function ProjectSwitchDialog({ onClose }: { onClose: () => void }) {
  const projects = useProjects();
  const current = projects?.current;
  if (!projects || !current) return null;
  const active = projects.all.filter((p) => p.status === 'active');
  return (
      <Dialog title="החלפת פרויקט" onClose={onClose}>
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
                onClose();
              }}
            >
              <b>
                <bdi>{p.name}</bdi>
              </b>
              <span className="pb-code" dir="ltr">{p.code}</span>
            </button>
          ))}
        </div>
        <p className="muted">יצירת פרויקט, ניהול ופרויקטים בארכיון — בלשונית "פרויקטים".</p>
      </Dialog>
  );
}
