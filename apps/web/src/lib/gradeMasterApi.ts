/**
 * Request handling for Admin → Grades & divisions, with the store and the
 * guard injected so the auth gate, validation and the "block delete while in
 * use" rule are unit-tested (tests/gradeMaster.test.ts). Route files only wire
 * in the real deps (lib/gradeMaster.ts). The guard runs first on every path.
 * CSRF/Origin checks for POST/PATCH/DELETE are applied by the middleware.
 */
import { displayDivision, normalizeDivision, normalizeGrade } from './grades';
import {
  activeOptions,
  collectMasterData,
  compareGrades,
  describeUsage,
  divisionInput,
  gradeInput,
  inUse,
  missingFromMaster,
  unrecognisedFromStudents,
  type GradeOption,
  type MasterGrade,
  type Usage,
} from './gradeMasterLogic';
import type { AdminGuard } from './adminLiveApi';

export type GradeRow = { id: string; name: string; label: string; sortOrder: number; active: boolean };
export type DivisionRow = { id: string; gradeId: string; gradeName: string; name: string; label: string; active: boolean };

export interface GradeStore {
  list(): Promise<MasterGrade[]>;
  /** Rows using each grade / "grade|division" (for badges on the admin page). */
  usageCounts(): Promise<{ grades: Record<string, number>; divisions: Record<string, number> }>;
  gradeUsage(grade: string): Promise<Usage>;
  divisionUsage(grade: string, division: string): Promise<Usage>;
  getGrade(id: string): Promise<GradeRow | null>;
  getDivision(id: string): Promise<DivisionRow | null>;
  createGrade(d: { name: string; label: string; sortOrder: number; active?: boolean }): Promise<GradeRow>;
  updateGrade(id: string, d: Partial<Pick<GradeRow, 'name' | 'label' | 'active' | 'sortOrder'>>): Promise<void>;
  deleteGrade(id: string): Promise<void>;
  createDivision(gradeId: string, d: { name: string; label: string; active?: boolean }): Promise<DivisionRow>;
  updateDivision(id: string, d: Partial<Pick<DivisionRow, 'name' | 'label' | 'active'>>): Promise<void>;
  deleteDivision(id: string): Promise<void>;
  reorder(ids: string[]): Promise<void>;
  /** Grades/divisions referenced by existing rows (see collectMasterData). */
  sources(): Promise<{ grade: string | null; divisions?: string[] }[]>;
  /** Distinct student (grade, division) with counts. */
  studentGroups(): Promise<{ grade: string; division: string; count: number }[]>;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
const err = (error: string, status = 400, extra?: Record<string, unknown>) => json({ error, ...extra }, status);

type Deps = { guard: AdminGuard; store: GradeStore };
const obj = (b: unknown) => (b && typeof b === 'object' ? (b as Record<string, unknown>) : {});

const inUseResponse = (what: string, usage: Usage) =>
  err(
    `${what} is in use and cannot be deleted: ${describeUsage(usage)}. Deactivate it instead to hide it from new selections.`,
    409,
    { usage, suggest: 'deactivate' }
  );

export async function handleListGrades(deps: Deps) {
  const g = await deps.guard();
  if (g.res) return g.res;
  const [master, counts, groups] = await Promise.all([
    deps.store.list(),
    deps.store.usageCounts(),
    deps.store.studentGroups(),
  ]);
  const grades = [...master]
    .sort((a, b) => a.sortOrder - b.sortOrder || compareGrades(a.name, b.name))
    .map((gr) => ({
      ...gr,
      usageCount: counts.grades[gr.name] ?? 0,
      divisions: [...gr.divisions]
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
        .map((d) => ({ ...d, usageCount: counts.divisions[`${gr.name}|${d.name}`] ?? 0 })),
    }));
  return json({ grades, unrecognised: unrecognisedFromStudents(groups, master) });
}

export async function handleCreateGrade(body: unknown, deps: Deps) {
  const g = await deps.guard();
  if (g.res) return g.res;
  const b = obj(body);
  const input = gradeInput(b.label ?? b.name);
  if (!input) return err('Enter a grade, e.g. 7 or KG (letters, digits, spaces, "." and "-").');
  const master = await deps.store.list();
  if (master.some((x) => x.name === input.name)) return err(`Grade ${input.name} already exists.`, 409);
  const sortOrder = master.reduce((m, x) => Math.max(m, x.sortOrder), 0) + 10;
  const grade = await deps.store.createGrade({ ...input, sortOrder });
  const divisions: DivisionRow[] = [];
  for (const raw of parseList(b.divisions)) {
    const d = divisionInput(raw);
    if (d && !divisions.some((x) => x.name === d.name)) divisions.push(await deps.store.createDivision(grade.id, d));
  }
  return json({ grade, divisions }, 201);
}

export async function handleUpdateGrade(id: string, body: unknown, deps: Deps) {
  const g = await deps.guard();
  if (g.res) return g.res;
  const cur = await deps.store.getGrade(id);
  if (!cur) return err('Grade not found', 404);
  const b = obj(body);
  const patch: Partial<GradeRow> = {};
  if (b.label !== undefined || b.name !== undefined) {
    const input = gradeInput(b.label ?? b.name);
    if (!input) return err('Enter a grade, e.g. 7 or KG.');
    if (input.name !== cur.name) {
      const master = await deps.store.list();
      if (master.some((x) => x.name === input.name)) return err(`Grade ${input.name} already exists.`, 409);
      const usage = await deps.store.gradeUsage(cur.name);
      if (inUse(usage)) {
        return err(
          `Grade ${cur.name} is in use (${describeUsage(usage)}), so only its display label can change, not the grade itself ` +
            `(students and timetable keep "${cur.name}"). Add a new grade and deactivate this one instead.`,
          409,
          { usage }
        );
      }
      patch.name = input.name;
    }
    patch.label = input.label;
  }
  if (b.active !== undefined) patch.active = Boolean(b.active);
  if (b.sortOrder !== undefined) {
    const n = Number(b.sortOrder);
    if (!Number.isInteger(n) || Math.abs(n) > 1_000_000) return err('sortOrder must be an integer');
    patch.sortOrder = n;
  }
  await deps.store.updateGrade(id, patch);
  return json({ ok: true });
}

export async function handleDeleteGrade(id: string, deps: Deps) {
  const g = await deps.guard();
  if (g.res) return g.res;
  const cur = await deps.store.getGrade(id);
  if (!cur) return err('Grade not found', 404);
  const usage = await deps.store.gradeUsage(cur.name);
  if (inUse(usage)) return inUseResponse(`Grade ${cur.name}`, usage);
  await deps.store.deleteGrade(id); // its (unused) divisions go with it
  return json({ ok: true });
}

export async function handleCreateDivision(gradeId: string, body: unknown, deps: Deps) {
  const g = await deps.guard();
  if (g.res) return g.res;
  const grade = await deps.store.getGrade(gradeId);
  if (!grade) return err('Grade not found', 404);
  const items = parseList(obj(body).name ?? obj(body).label);
  if (!items.length) return err('Enter a division, e.g. A or Mahaveer.');
  const master = await deps.store.list();
  const existing = new Set(master.find((x) => x.id === gradeId)?.divisions.map((d) => d.name) ?? []);
  const created: DivisionRow[] = [];
  const skipped: string[] = [];
  for (const raw of items) {
    const d = divisionInput(raw);
    if (!d) return err(`"${raw}" is not a valid division (letters/digits; "ALL" is reserved).`);
    if (existing.has(d.name)) {
      skipped.push(d.label);
      continue;
    }
    existing.add(d.name);
    created.push(await deps.store.createDivision(gradeId, d));
  }
  if (!created.length) return err(`Division ${skipped.join(', ')} already exists in grade ${grade.name}.`, 409);
  return json({ divisions: created, skipped }, 201);
}

export async function handleUpdateDivision(id: string, body: unknown, deps: Deps) {
  const g = await deps.guard();
  if (g.res) return g.res;
  const cur = await deps.store.getDivision(id);
  if (!cur) return err('Division not found', 404);
  const b = obj(body);
  const patch: Partial<DivisionRow> = {};
  if (b.label !== undefined || b.name !== undefined) {
    const input = divisionInput(b.label ?? b.name);
    if (!input) return err('Enter a division, e.g. A or Mahaveer.');
    if (input.name !== cur.name) {
      const master = await deps.store.list();
      const siblings = master.find((x) => x.id === cur.gradeId)?.divisions ?? [];
      if (siblings.some((d) => d.name === input.name)) {
        return err(`Division ${input.label} already exists in grade ${cur.gradeName}.`, 409);
      }
      const usage = await deps.store.divisionUsage(cur.gradeName, cur.name);
      if (inUse(usage)) {
        return err(
          `Division ${cur.gradeName}-${cur.label} is in use (${describeUsage(usage)}), so only its display form can change ` +
            `(e.g. "MAHAVEER" → "Mahaveer"), not the name itself. Add a new division and deactivate this one instead.`,
          409,
          { usage }
        );
      }
      patch.name = input.name;
    }
    patch.label = input.label;
  }
  if (b.active !== undefined) patch.active = Boolean(b.active);
  await deps.store.updateDivision(id, patch);
  return json({ ok: true });
}

export async function handleDeleteDivision(id: string, deps: Deps) {
  const g = await deps.guard();
  if (g.res) return g.res;
  const cur = await deps.store.getDivision(id);
  if (!cur) return err('Division not found', 404);
  const usage = await deps.store.divisionUsage(cur.gradeName, cur.name);
  if (inUse(usage)) return inUseResponse(`Division ${cur.gradeName}-${cur.label}`, usage);
  await deps.store.deleteDivision(id);
  return json({ ok: true });
}

export async function handleReorder(body: unknown, deps: Deps) {
  const g = await deps.guard();
  if (g.res) return g.res;
  const ids = obj(body).ids;
  if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string') || ids.length > 500) {
    return err('ids must be the grade ids in the new order');
  }
  const master = await deps.store.list();
  const known = new Set(master.map((x) => x.id));
  if (new Set(ids).size !== ids.length || ids.some((x) => !known.has(x))) return err('Unknown or duplicate grade id');
  await deps.store.reorder(ids as string[]);
  return json({ ok: true });
}

/** "Sync from existing data": add any grade/division in use but missing (idempotent). */
export async function handleSync(deps: Deps) {
  const g = await deps.guard();
  if (g.res) return g.res;
  const [master, sources] = await Promise.all([deps.store.list(), deps.store.sources()]);
  const missing = missingFromMaster(collectMasterData(sources), master);
  let sortOrder = master.reduce((m, x) => Math.max(m, x.sortOrder), 0);
  let grades = 0;
  let divisions = 0;
  for (const m of missing) {
    let gradeId = master.find((x) => x.name === m.name)?.id;
    if (!gradeId) {
      sortOrder += 10;
      gradeId = (await deps.store.createGrade({ name: m.name, label: m.name, sortOrder })).id;
      grades++;
    }
    for (const d of m.divisions) {
      await deps.store.createDivision(gradeId, { name: d, label: displayDivision(d) });
      divisions++;
    }
  }
  return json({ ok: true, added: { grades, divisions } });
}

/** One-click add of an unrecognised (grade, division) seen from the school app. */
export async function handleRecognise(body: unknown, deps: Deps) {
  const g = await deps.guard();
  if (g.res) return g.res;
  const b = obj(body);
  const grade = normalizeGrade(b.grade);
  const division = normalizeDivision(b.division);
  const gi = gradeInput(grade);
  const parsed = divisionInput(division);
  if (!gi || !parsed) return err('That grade/division cannot be added (letters and digits only).');
  // School-app values arrive upper-cased; show the friendly form ("Mahaveer").
  const di = { name: parsed.name, label: displayDivision(parsed.name) };
  const master = await deps.store.list();
  let gr = master.find((x) => x.name === gi.name);
  let gradeId = gr?.id;
  if (!gradeId) {
    const sortOrder = master.reduce((m, x) => Math.max(m, x.sortOrder), 0) + 10;
    gradeId = (await deps.store.createGrade({ ...gi, sortOrder })).id;
  } else if (gr && !gr.active) {
    await deps.store.updateGrade(gradeId, { active: true });
  }
  gr = master.find((x) => x.id === gradeId);
  const d = gr?.divisions.find((x) => x.name === di.name);
  if (!d) await deps.store.createDivision(gradeId, di);
  else if (!d.active) await deps.store.updateDivision(d.id, { active: true });
  return json({ ok: true, grade: gi.name, division: di.name }, 201);
}

/**
 * Dropdown data for admin and teacher pages: active grades in order with
 * their active divisions. Requires an admin or teacher session.
 */
export async function handleGradeOptions(deps: { authorised: () => Promise<boolean>; list: () => Promise<MasterGrade[]> }) {
  if (!(await deps.authorised())) return err('Sign-in required', 401);
  const master = await deps.list();
  const grades: GradeOption[] = activeOptions(master);
  return json({ grades, configured: master.length > 0 });
}

function parseList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 100);
  return String(raw ?? '')
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 100);
}
