// A finding as a card: what a site manager needs at a glance — number, full location, description,
// responsible contractor, status — with batch and sync state as secondary information (UX-01/08).
import type { ProjectModel } from '../../shared/projectModel';
import { CLASSIFICATION_LABEL, STATUS_LABEL } from '../../shared/types';
import type { LocalFinding } from '../db';
import { MAX_SYNC_ATTEMPTS } from '../findings';
import { Icon } from '../icons';

export function SyncTag({ f }: { f: LocalFinding }) {
  if (f.conflict) return <span className="tag danger">התנגשות — נדרשת החלטה</span>;
  if (f.syncError?.blocked) return <span className="tag danger" title={f.syncError.message}>נדחה בסנכרון — ערוך כדי לשלוח שוב</span>;
  if (f.syncError)
    return (
      <span className="tag warn" title={f.syncError.message}>
        נדחה בסנכרון (ניסיון {f.syncError.attempts}/{MAX_SYNC_ATTEMPTS})
      </span>
    );
  if (f.dirty) return <span className="tag warn">נשמר במכשיר · ממתין לסנכרון</span>;
  return <span className="tag ok">מסונכרן</span>;
}

export function FindingCard({ m, f, batchSize, onOpen }: { m: ProjectModel; f: LocalFinding; batchSize: number; onOpen: () => void }) {
  const contractor = m.contractorById(f.contractorId)?.name;
  return (
    <button className={`item finding-card ${f.conflict ? 'has-conflict' : ''} cls-${f.classification} ${f.deletedAt ? 'is-deleted' : ''}`} data-id={f.id} onClick={onOpen}>
      <div className="item-top">
        <b className="fc-no">{f.displayNo ? `#${f.displayNo}` : 'טרם מוספר'}</b>
        <span className="fc-loc">{m.locationLabel(f.locationId)}{f.locationDetail ? ` · ${f.locationDetail}` : ''}</span>
      </div>
      <div className="item-desc">{f.description}</div>
      <div className="fc-main">
        <span className="fc-contractor">
          <Icon name="hardhat" size={15} />
          {contractor ?? 'ללא קבלן'}
        </span>
        <span className={`tag status-${f.status}`}>{STATUS_LABEL[f.status]}</span>
        {f.classification !== 'missing' && <span className={`tag ${f.classification}`}>{CLASSIFICATION_LABEL[f.classification]}</span>}
        {f.photoIds.length > 0 && (
          <span className="tag" aria-label={`${f.photoIds.length} תמונות`}>
            <Icon name="camera" size={13} /> {f.photoIds.length}
          </span>
        )}
      </div>
      <div className="item-tags fc-secondary">
        {batchSize > 1 && <span className="tag subtle">אחד מ-{batchSize} מיקומים</span>}
        {f.deletedAt && <span className="tag danger">נמחק</span>}
        <SyncTag f={f} />
      </div>
    </button>
  );
}
