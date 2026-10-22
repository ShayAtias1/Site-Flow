import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo, useState } from 'react';
import {
  COMMON_PRESETS,
  generateBuilding,
  generateFloors,
  rangeLabel,
  unitNumbers,
  unitShortLabel,
  validateBuilding,
  validateFloors,
  type BuildingSpec,
  type FloorSpec,
  type Numbering,
} from '../../../shared/structure';
import { db, type LocationRow, type ProjectRow } from '../../db';
import { addFloors, addLocation, addUnits, createBuilding, deleteLocation, moveLocation, renameLocation, subtree } from '../../setup';
import { Confirm, ErrorBox, Field, Sheet, num, useRunner } from './ui';

const KIND_LABEL: Record<LocationRow['kind'], string> = {
  building: 'בניין',
  floor: 'קומה',
  unit: 'דירה',
  common: 'שטח משותף',
  site: 'אזור',
};

const bySort = (a: LocationRow, b: LocationRow) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, 'he');
const trailingNo = (name: string) => Number(/(-?\d+)\s*$/.exec(name)?.[1] ?? NaN);

interface Tree {
  live: LocationRow[];
  kids: (id: string | null) => LocationRow[];
  /** Findings on this device per location, including everything under it. */
  findingsIn: (id: string) => number;
}

function useTree(projectId: string): Tree | undefined {
  const data = useLiveQuery(async () => {
    const locs = await db.locations.where('project_id').equals(projectId).toArray();
    const findings = await db.findings.filter((f) => f.projectId === projectId && !f.deletedAt).toArray();
    return { locs, findings };
  }, [projectId]);
  return useMemo(() => {
    if (!data) return undefined;
    const live = data.locs.filter((l) => !l.deleted_at).sort(bySort);
    const ids = new Set(live.map((l) => l.id));
    const children = new Map<string | null, LocationRow[]>();
    for (const l of live) {
      const key = l.parent_id && ids.has(l.parent_id) ? l.parent_id : null;
      children.set(key, [...(children.get(key) ?? []), l]);
    }
    const direct = new Map<string, number>();
    for (const f of data.findings) direct.set(f.locationId, (direct.get(f.locationId) ?? 0) + 1);
    const memo = new Map<string, number>();
    const findingsIn = (id: string): number => {
      if (!memo.has(id)) memo.set(id, (direct.get(id) ?? 0) + (children.get(id) ?? []).reduce((n, c) => n + findingsIn(c.id), 0));
      return memo.get(id)!;
    };
    return { live, kids: (id) => children.get(id) ?? [], findingsIn };
  }, [data]);
}

type Open =
  | { kind: 'node'; id: string }
  | { kind: 'building' }
  | { kind: 'floors'; buildingId: string }
  | { kind: 'units'; floorId: string }
  | { kind: 'area' };

export function Structure({ project, readOnly }: { project: ProjectRow; readOnly: boolean }) {
  const tree = useTree(project.id);
  const [open, setOpen] = useState<Open | null>(null);
  if (!tree) return null;
  const roots = tree.kids(null);
  const count = (k: LocationRow['kind']) => tree.live.filter((l) => l.kind === k).length;
  const node = open?.kind === 'node' ? tree.live.find((l) => l.id === open.id) : undefined;
  const floorsFor = open?.kind === 'floors' ? tree.live.find((l) => l.id === open.buildingId) : undefined;
  const unitsFor = open?.kind === 'units' ? tree.live.find((l) => l.id === open.floorId) : undefined;

  return (
    <div className="structure">
      <div className="structure-bar">
        <div className="muted">
          {count('building')} בניינים · {count('floor')} קומות · <b>{count('unit')} דירות</b> · {count('common')} שטחים משותפים
        </div>
        {!readOnly && (
          <div className="actions-row">
            <button className="btn primary-solid" onClick={() => setOpen({ kind: 'building' })}>
              + בניין (מחולל)
            </button>
            <button className="btn" onClick={() => setOpen({ kind: 'area' })}>
              + אזור / פיתוח
            </button>
          </div>
        )}
      </div>

      {!roots.length && (
        <div className="empty card">
          <b>אין עדיין מבנה לפרויקט</b>
          <p className="muted">צור בניין עם המחולל: טווח קומות, מספר דירות בקומה ומספור אוטומטי — עשרות דירות בפעולה אחת.</p>
        </div>
      )}

      {roots.map((r) => (
        <RootCard
          key={r.id}
          root={r}
          tree={tree}
          readOnly={readOnly}
          onOpen={(id) => setOpen({ kind: 'node', id })}
          onAddFloors={(id) => setOpen({ kind: 'floors', buildingId: id })}
          onAddUnits={(id) => setOpen({ kind: 'units', floorId: id })}
        />
      ))}

      {open?.kind === 'building' && <BuildingSheet project={project} existing={roots.length} onClose={() => setOpen(null)} />}
      {floorsFor && <FloorsSheet project={project} building={floorsFor} tree={tree} onClose={() => setOpen(null)} />}
      {unitsFor && <UnitsSheet project={project} floor={unitsFor} tree={tree} onClose={() => setOpen(null)} />}
      {open?.kind === 'area' && <AreaSheet project={project} onClose={() => setOpen(null)} />}
      {node && (
        <NodeSheet
          project={project}
          node={node}
          tree={tree}
          readOnly={readOnly}
          onClose={() => setOpen(null)}
          onAddFloors={() => setOpen({ kind: 'floors', buildingId: node.id })}
          onAddUnits={() => setOpen({ kind: 'units', floorId: node.id })}
        />
      )}
    </div>
  );
}

function RootCard({
  root,
  tree,
  readOnly,
  onOpen,
  onAddFloors,
  onAddUnits,
}: {
  root: LocationRow;
  tree: Tree;
  readOnly: boolean;
  onOpen: (id: string) => void;
  onAddFloors: (buildingId: string) => void;
  onAddUnits: (floorId: string) => void;
}) {
  const children = tree.kids(root.id);
  const commons = children.filter((c) => c.kind !== 'floor');
  const floors = children.filter((c) => c.kind === 'floor');
  const units = floors.reduce((n, f) => n + tree.kids(f.id).filter((u) => u.kind === 'unit').length, 0);
  const found = tree.findingsIn(root.id);
  const Chip = ({ l }: { l: LocationRow }) => {
    const n = tree.findingsIn(l.id);
    return (
      <button className={`st-chip ${l.kind}`} aria-label={l.name} onClick={() => onOpen(l.id)} title={readOnly ? l.name : `עריכה: ${l.name}`}>
        {l.kind === 'unit' ? unitShortLabel(l.name) : l.name}
        {n > 0 && <span className="st-count">{n}</span>}
      </button>
    );
  };
  return (
    <section className="card st-root" data-id={root.id}>
      <button className="st-head" onClick={() => onOpen(root.id)}>
        <span className="st-kind">{KIND_LABEL[root.kind]}</span>
        <b>{root.name}</b>
        {root.code && <span className="code" dir="ltr">{root.code}</span>}
        <span className="muted st-meta">
          {floors.length ? `${floors.length} קומות · ${units} דירות` : `${commons.length} שטחים`}
          {found > 0 && ` · ${found} ממצאים`}
        </span>
      </button>
      {!readOnly && (
        <div className="st-actions">
          <button className="btn small" onClick={() => onOpen(root.id)}>
            עריכה
          </button>
          {root.kind === 'building' && (
            <button className="btn small" onClick={() => onAddFloors(root.id)}>
              + קומות
            </button>
          )}
          <button className="btn small" onClick={() => onOpen(root.id)}>
            + שטח משותף
          </button>
        </div>
      )}
      {commons.length > 0 && (
        <div className="st-commons">
          {commons.map((c) => (
            <Chip key={c.id} l={c} />
          ))}
        </div>
      )}
      {floors.map((f) => (
        <div key={f.id} className="st-floor">
          <button className="st-floor-name" onClick={() => onOpen(f.id)}>
            {f.name}
          </button>
          <div className="st-units">
            {tree.kids(f.id).map((u) => (
              <Chip key={u.id} l={u} />
            ))}
            {!tree.kids(f.id).length && readOnly && <span className="muted">אין יחידות</span>}
            {!readOnly && (
              <button className="st-chip st-add" aria-label={`הוספת דירות ל${f.name} ב${root.name}`} title="הוספת דירות לקומה" onClick={() => onAddUnits(f.id)}>
                +
              </button>
            )}
          </div>
        </div>
      ))}
    </section>
  );
}

// ---------- Generator ----------

interface FloorForm {
  floorFrom: string;
  floorTo: string;
  unitsPerFloor: string;
  numbering: Numbering;
  startNo: string;
  unitPrefix: string;
}

const toSpec = (f: FloorForm): FloorSpec => ({
  floorFrom: num(f.floorFrom),
  floorTo: num(f.floorTo),
  unitsPerFloor: num(f.unitsPerFloor),
  numbering: f.numbering,
  startNo: f.numbering === 'continuous' ? num(f.startNo) : 1,
  unitPrefix: f.unitPrefix,
});

function FloorFields({ value, onChange }: { value: FloorForm; onChange: (v: FloorForm) => void }) {
  const set = (patch: Partial<FloorForm>) => onChange({ ...value, ...patch });
  return (
    <>
      <div className="form-grid three">
        <Field label="מקומה" hint="0 = קרקע, שלילי = מרתף">
          <input type="number" inputMode="numeric" value={value.floorFrom} onChange={(e) => set({ floorFrom: e.target.value })} />
        </Field>
        <Field label="עד קומה">
          <input type="number" inputMode="numeric" value={value.floorTo} onChange={(e) => set({ floorTo: e.target.value })} />
        </Field>
        <Field label="דירות בקומה">
          <input type="number" inputMode="numeric" min={0} value={value.unitsPerFloor} onChange={(e) => set({ unitsPerFloor: e.target.value })} />
        </Field>
      </div>
      <div className="label">מספור דירות</div>
      <div className="seg" role="radiogroup" aria-label="מספור דירות">
        <button role="radio" aria-checked={value.numbering === 'continuous'} className={value.numbering === 'continuous' ? 'on' : ''} onClick={() => set({ numbering: 'continuous' })}>
          רציף (1, 2, 3…)
        </button>
        <button role="radio" aria-checked={value.numbering === 'byFloor'} className={value.numbering === 'byFloor' ? 'on' : ''} onClick={() => set({ numbering: 'byFloor' })}>
          לפי קומה (101, 102…)
        </button>
      </div>
      <div className="form-grid three">
        {value.numbering === 'continuous' && (
          <Field label="מספר הדירה הראשונה">
            <input type="number" inputMode="numeric" value={value.startNo} onChange={(e) => set({ startNo: e.target.value })} />
          </Field>
        )}
        <Field label="שם יחידה" hint="לדוגמה: דירה, משרד, חנות">
          <input value={value.unitPrefix} onChange={(e) => set({ unitPrefix: e.target.value })} />
        </Field>
      </div>
    </>
  );
}

function Preview({ spec, invalid }: { spec: FloorSpec; invalid: string | null }) {
  if (invalid) return <div className="alert warn">{invalid}</div>;
  const floors = Array.from({ length: spec.floorTo - spec.floorFrom + 1 }, (_, i) => spec.floorFrom + i);
  const total = floors.length * spec.unitsPerFloor;
  return (
    <div className="preview">
      <div className="preview-head">
        <b>{floors.length} קומות · {total} יחידות</b>
      </div>
      <div className="preview-floors">
        {[...floors].reverse().map((f) => (
          <div key={f} className="preview-floor">
            <span>{f === 0 ? 'קרקע' : `קומה ${f}`}</span>
            <span dir="ltr">{rangeLabel(unitNumbers(spec, f, f - spec.floorFrom))}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function BuildingSheet({ project, existing, onClose }: { project: ProjectRow; existing: number; onClose: () => void }) {
  const letter = String.fromCharCode(65 + Math.min(existing, 25));
  const [name, setName] = useState(`בניין ${letter}`);
  const [code, setCode] = useState(letter);
  const [floors, setFloors] = useState<FloorForm>({ floorFrom: '1', floorTo: '4', unitsPerFloor: '4', numbering: 'continuous', startNo: '1', unitPrefix: 'דירה' });
  const [commons, setCommons] = useState<string[]>(['לובי כניסה', 'חדר מדרגות', 'גג']);
  const [extra, setExtra] = useState('');
  const { busy, error, run } = useRunner();
  const spec: BuildingSpec = { ...toSpec(floors), name, code, commons };
  const invalid = validateBuilding(spec);
  const nodes = invalid ? [] : generateBuilding(spec);
  const toggle = (c: string) => setCommons(commons.includes(c) ? commons.filter((x) => x !== c) : [...commons, c]);
  const addExtra = () => {
    if (extra.trim() && !commons.includes(extra.trim())) setCommons([...commons, extra.trim()]);
    setExtra('');
  };
  return (
    <Sheet title="בניין חדש — מחולל מבנה" onClose={onClose}
      footer={<button className="primary" disabled={busy || !!invalid} onClick={async () => (await run(() => createBuilding(project, spec))) && onClose()}>
        {busy ? 'יוצר…' : `צור ${name.trim() || 'בניין'} (${nodes.length} מיקומים)`}
      </button>}
    >
      <div className="form-grid">
        <Field label="שם הבניין">
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="קוד" hint="משמש בקודי היחידות, לדוגמה A-03-12" ltr>
          <input value={code} dir="ltr" maxLength={8} onChange={(e) => setCode(e.target.value.toUpperCase())} />
        </Field>
      </div>
      <FloorFields value={floors} onChange={setFloors} />
      <div className="label">שטחים משותפים בבניין</div>
      <div className="chips">
        {[...COMMON_PRESETS, ...commons.filter((c) => !COMMON_PRESETS.includes(c))].map((c) => (
          <button key={c} className={`chip small ${commons.includes(c) ? 'on' : ''}`} aria-pressed={commons.includes(c)} onClick={() => toggle(c)}>
            {c}
          </button>
        ))}
      </div>
      <div className="inline-add">
        <input value={extra} placeholder="שטח נוסף, לדוגמה: חדר עגלות" onChange={(e) => setExtra(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addExtra()} />
        <button className="btn" onClick={addExtra} disabled={!extra.trim()}>
          הוסף
        </button>
      </div>
      <Preview spec={spec} invalid={invalid} />
      <ErrorBox error={error} />
    </Sheet>
  );
}

function FloorsSheet({ project, building, tree, onClose }: { project: ProjectRow; building: LocationRow; tree: Tree; onClose: () => void }) {
  // Continue where the building ends: next floor, next unit number, same units per floor.
  const floors = tree.kids(building.id).filter((c) => c.kind === 'floor');
  const lastFloor = floors.map((f) => (/קרקע/.test(f.name) ? 0 : trailingNo(f.name))).filter(Number.isFinite);
  const units = floors.flatMap((f) => tree.kids(f.id)).filter((u) => u.kind === 'unit');
  const lastUnit = units.map((u) => trailingNo(u.name)).filter(Number.isFinite);
  const perFloor = floors.length ? Math.round(units.length / floors.length) : 4;
  const from = lastFloor.length ? Math.max(...lastFloor) + 1 : 1;
  const [form, setForm] = useState<FloorForm>({
    floorFrom: String(from),
    floorTo: String(from),
    unitsPerFloor: String(perFloor),
    numbering: lastUnit.some((n) => n >= 100) ? 'byFloor' : 'continuous',
    startNo: String(lastUnit.length ? Math.max(...lastUnit) + 1 : 1),
    unitPrefix: units[0]?.name.replace(/\s*-?\d+\s*$/, '') || 'דירה',
  });
  const { busy, error, run } = useRunner();
  const spec = toSpec(form);
  const invalid = validateFloors(spec);
  const count = invalid ? 0 : generateFloors(spec, 'p', building.code).length;
  return (
    <Sheet title={`הוספת קומות — ${building.name}`} onClose={onClose}
      footer={<button className="primary" disabled={busy || !!invalid} onClick={async () => (await run(() => addFloors(project, building, spec))) && onClose()}>
        {busy ? 'מוסיף…' : `הוסף (${count} מיקומים)`}
      </button>}
    >
      <FloorFields value={form} onChange={setForm} />
      <Preview spec={spec} invalid={invalid} />
      <ErrorBox error={error} />
    </Sheet>
  );
}

/** Next unit number on a floor: after the floor's own last unit, unless the building already uses it. */
function nextUnitNo(floor: LocationRow, tree: Tree) {
  const building = tree.live.find((l) => l.id === floor.parent_id);
  const onFloor = tree.kids(floor.id).filter((u) => u.kind === 'unit').map((u) => trailingNo(u.name)).filter(Number.isFinite);
  const inBuilding = new Set(
    (building ? tree.kids(building.id) : []).flatMap((f) => tree.kids(f.id)).filter((u) => u.kind === 'unit').map((u) => trailingNo(u.name)),
  );
  const floorNo = /קרקע/.test(floor.name) ? 0 : trailingNo(floor.name);
  let n = onFloor.length ? Math.max(...onFloor) + 1 : Number.isFinite(floorNo) && [...inBuilding].some((x) => x >= 100) ? floorNo * 100 + 1 : Math.max(0, ...[...inBuilding].filter(Number.isFinite)) + 1;
  while (inBuilding.has(n)) n++;
  return n;
}

function UnitsSheet({ project, floor, tree, onClose }: { project: ProjectRow; floor: LocationRow; tree: Tree; onClose: () => void }) {
  const building = tree.live.find((l) => l.id === floor.parent_id);
  const existing = tree.kids(floor.id).filter((u) => u.kind === 'unit');
  const anyUnit = existing[0] ?? (building ? tree.kids(building.id).flatMap((f) => tree.kids(f.id)).find((u) => u.kind === 'unit') : undefined);
  const [count, setCount] = useState('1');
  const [first, setFirst] = useState(String(nextUnitNo(floor, tree)));
  const [prefix, setPrefix] = useState(anyUnit?.name.replace(/\s*-?\d+\s*$/, '') || 'דירה');
  const { busy, error, run } = useRunner();
  const n = num(count);
  const start = num(first);
  const invalid =
    !Number.isInteger(n) || n < 1 || n > 40 ? 'מספר הדירות: 1 עד 40' : !Number.isInteger(start) || start < 0 ? 'מספר הדירה הראשונה אינו תקין' : !prefix.trim() ? 'יש להזין שם יחידה' : null;
  const units = invalid ? [] : Array.from({ length: n }, (_, i) => ({ name: `${prefix.trim()} ${start + i}`, code: floor.code ? `${floor.code}-${String(start + i).padStart(2, '0')}` : '' }));
  const clash = units.find((u) => existing.some((e) => e.name === u.name));
  return (
    <Sheet title={`הוספת דירות — ${building ? `${building.name} › ` : ''}${floor.name}`} onClose={onClose}
      footer={<button className="primary" disabled={busy || !!invalid || !!clash} onClick={async () => (await run(() => addUnits(project, floor, units))) && onClose()}>
        {busy ? 'מוסיף…' : `הוסף ${units.length || ''} דירות`}
      </button>}
    >
      {existing.length > 0 && (
        <p className="muted">
          כבר בקומה: {existing.map((u) => unitShortLabel(u.name)).join(', ')}
        </p>
      )}
      <div className="form-grid three">
        <Field label="כמה דירות">
          <input type="number" inputMode="numeric" min={1} max={40} value={count} onChange={(e) => setCount(e.target.value)} />
        </Field>
        <Field label="מספר הדירה הראשונה">
          <input type="number" inputMode="numeric" min={0} value={first} onChange={(e) => setFirst(e.target.value)} />
        </Field>
        <Field label="שם יחידה" hint="לדוגמה: דירה, משרד, חנות">
          <input value={prefix} onChange={(e) => setPrefix(e.target.value)} />
        </Field>
      </div>
      {invalid ? (
        <div className="alert warn">{invalid}</div>
      ) : clash ? (
        <div className="alert warn">"{clash.name}" כבר קיימת בקומה. שנה את מספר הדירה הראשונה.</div>
      ) : (
        <div className="preview">
          <div className="preview-head">
            <b>יתווספו {units.length} דירות</b>
          </div>
          <div className="preview-floors">
            <div className="preview-floor">
              <span>{floor.name}</span>
              <span>{units.map((u) => u.name).join(', ')}</span>
            </div>
          </div>
        </div>
      )}
      <ErrorBox error={error} />
    </Sheet>
  );
}

function AreaSheet({ project, onClose }: { project: ProjectRow; onClose: () => void }) {
  const [name, setName] = useState('פיתוח ושטחים משותפים');
  const { busy, error, run } = useRunner();
  return (
    <Sheet title="אזור חדש" onClose={onClose}
      footer={<button className="primary" disabled={busy || !name.trim()} onClick={async () => (await run(() => addLocation(project, null, 'site', name))) && onClose()}>
        צור אזור
      </button>}
    >
      <p className="muted">אזור שאינו בניין — פיתוח, חניון, מבנה עזר. בתוכו מוסיפים שטחים משותפים.</p>
      <Field label="שם האזור">
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <ErrorBox error={error} />
    </Sheet>
  );
}

// ---------- Editing one location ----------

function NodeSheet({
  project,
  node,
  tree,
  readOnly,
  onClose,
  onAddFloors,
  onAddUnits,
}: {
  project: ProjectRow;
  node: LocationRow;
  tree: Tree;
  readOnly: boolean;
  onClose: () => void;
  onAddFloors: () => void;
  onAddUnits: () => void;
}) {
  const [name, setName] = useState(node.name);
  const [code, setCode] = useState(node.code);
  const { busy, error, run } = useRunner();
  const siblings = tree.kids(node.parent_id && tree.live.some((l) => l.id === node.parent_id) ? node.parent_id : null).filter((s) => (s.kind === 'floor') === (node.kind === 'floor'));
  const pos = siblings.findIndex((s) => s.id === node.id);
  const all = subtree(tree.live, node.id);
  const found = tree.findingsIn(node.id);
  const parentPath: string[] = [];
  for (let p = tree.live.find((l) => l.id === node.parent_id); p; p = tree.live.find((l) => l.id === p!.parent_id)) parentPath.unshift(p.name);

  // What can be added under this node.
  const building = node.kind === 'building' ? node : node.kind === 'floor' ? tree.live.find((l) => l.id === node.parent_id) : undefined;
  const unitsHere = node.kind === 'floor' ? tree.kids(node.id).filter((u) => u.kind === 'unit') : [];
  const buildingUnits = building ? tree.kids(building.id).flatMap((f) => tree.kids(f.id)).filter((u) => u.kind === 'unit') : [];
  const nextNo = Math.max(0, ...buildingUnits.map((u) => trailingNo(u.name)).filter(Number.isFinite)) + 1;
  const prefix = (unitsHere[0] ?? buildingUnits[0])?.name.replace(/\s*-?\d+\s*$/, '') || 'דירה';
  const [childName, setChildName] = useState('');

  const dirty = name !== node.name || code !== node.code;
  return (
    <Sheet title={`${KIND_LABEL[node.kind]}: ${node.name}`} onClose={onClose}>
      {parentPath.length > 0 && <div className="muted">{parentPath.join(' › ')}</div>}
      {found > 0 && <div className="alert info">{found} ממצאים במכשיר במיקום הזה{all.length > 1 ? ' ובמה שתחתיו' : ''}.</div>}
      <div className="form-grid">
        <Field label="שם">
          <input value={name} disabled={readOnly} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="קוד" ltr>
          <input value={code} disabled={readOnly} dir="ltr" onChange={(e) => setCode(e.target.value)} />
        </Field>
      </div>
      {!readOnly && (
        <>
          <div className="actions-row">
            <button className="btn primary-solid" disabled={busy || !dirty} onClick={() => run(() => renameLocation(node, name, code))}>
              שמור שם
            </button>
            <button className="btn" disabled={busy || pos <= 0} aria-label="הזז לפני" onClick={() => run(() => moveLocation(node, siblings, -1))}>
              ↑ הזז לפני
            </button>
            <button className="btn" disabled={busy || pos < 0 || pos >= siblings.length - 1} aria-label="הזז אחרי" onClick={() => run(() => moveLocation(node, siblings, 1))}>
              ↓ הזז אחרי
            </button>
          </div>

          {node.kind === 'building' && (
            <div className="actions-row">
              <button className="btn" onClick={onAddFloors}>
                + הוסף קומות (מחולל)
              </button>
            </div>
          )}
          {node.kind === 'floor' && (
            <div className="actions-row">
              <button className="btn" onClick={onAddUnits}>
                + הוסף כמה דירות לקומה
              </button>
            </div>
          )}
          {(node.kind === 'building' || node.kind === 'site' || node.kind === 'floor') && (
            <div className="sub-block">
              <div className="label">{node.kind === 'floor' ? 'הוספה לקומה' : 'שטח משותף חדש'}</div>
              <div className="inline-add">
                <input
                  value={childName}
                  placeholder={node.kind === 'floor' ? `${prefix} ${nextNo}` : 'לדוגמה: חדר אשפה'}
                  onChange={(e) => setChildName(e.target.value)}
                />
                {node.kind === 'floor' && (
                  <button
                    className="btn"
                    disabled={busy}
                    onClick={async () => {
                      const n = childName.trim() || `${prefix} ${nextNo}`;
                      const no = trailingNo(n);
                      if (await run(() => addLocation(project, node.id, 'unit', n, Number.isFinite(no) ? `${node.code}-${String(no).padStart(2, '0')}` : ''))) setChildName('');
                    }}
                  >
                    + דירה
                  </button>
                )}
                <button
                  className="btn"
                  disabled={busy || !childName.trim()}
                  onClick={async () => (await run(() => addLocation(project, node.id, 'common', childName))) && setChildName('')}
                >
                  + שטח משותף
                </button>
              </div>
            </div>
          )}

          <div className="sub-block">
            <Confirm
              action={all.length > 1 ? `מחק את ${node.name} ו-${all.length - 1} המיקומים שתחתיו` : `מחק את ${node.name}`}
              text={`המחיקה תסיר את ${all.length > 1 ? `${all.length} המיקומים` : 'המיקום'} מהתיעוד ומבורר המיקומים.`}
              disabled={found ? `לא ניתן למחוק: יש ${found} ממצאים במיקום הזה${all.length > 1 ? ' או ביחידות שתחתיו' : ''}. ממצאים אינם נמחקים עם המבנה.` : null}
              busy={busy}
              onConfirm={async () => (await run(() => deleteLocation(project.id, node.id))) && onClose()}
            />
          </div>
        </>
      )}
      <ErrorBox error={error} />
    </Sheet>
  );
}
