/**
 * Request handling for Admin → Grades & divisions → Campuses, with the store
 * and guard injected so the rules are unit-tested (tests/campus.test.ts).
 * Same rules as grades: add, rename the label any time, rename the campus
 * itself or delete it only while unused, deactivate to hide it from new picks.
 */
import { campusInput, type MasterCampus } from './campusLogic';
import { describeUsage, inUse, type Usage } from './gradeMasterLogic';
import type { AdminGuard } from './adminLiveApi';

export interface CampusStore {
  list(): Promise<MasterCampus[]>;
  usageCounts(): Promise<Record<string, number>>;
  usage(name: string): Promise<Usage>;
  create(d: { name: string; label: string; sortOrder: number }): Promise<MasterCampus>;
  update(id: string, d: Partial<Pick<MasterCampus, 'name' | 'label' | 'active' | 'sortOrder'>>): Promise<void>;
  remove(id: string): Promise<void>;
  unrecognised(): Promise<{ campus: string; count: number }[]>;
}

type Deps = { guard: AdminGuard; store: CampusStore };

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const err = (error: string, status = 400, extra?: Record<string, unknown>) => json({ error, ...extra }, status);
const obj = (b: unknown) => (b && typeof b === 'object' ? (b as Record<string, unknown>) : {});

export async function handleListCampuses(deps: Deps) {
  const g = await deps.guard();
  if (g.res) return g.res;
  const [list, counts, unrecognised] = await Promise.all([deps.store.list(), deps.store.usageCounts(), deps.store.unrecognised()]);
  return json({
    campuses: [...list]
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
      .map((c) => ({ ...c, usageCount: counts[c.name] ?? 0 })),
    unrecognised,
  });
}

export async function handleCreateCampus(body: unknown, deps: Deps) {
  const g = await deps.guard();
  if (g.res) return g.res;
  const input = campusInput(obj(body).label ?? obj(body).name);
  if (!input) return err('Enter a campus, e.g. CC or North (letters and digits; "ALL" is reserved).');
  const list = await deps.store.list();
  if (list.some((c) => c.name === input.name)) return err(`Campus ${input.name} already exists.`, 409);
  const sortOrder = list.reduce((m, c) => Math.max(m, c.sortOrder), 0) + 10;
  return json({ campus: await deps.store.create({ ...input, sortOrder }) }, 201);
}

export async function handleUpdateCampus(id: string, body: unknown, deps: Deps) {
  const g = await deps.guard();
  if (g.res) return g.res;
  const list = await deps.store.list();
  const cur = list.find((c) => c.id === id);
  if (!cur) return err('Campus not found', 404);
  const b = obj(body);
  const patch: Partial<MasterCampus> = {};
  if (b.label !== undefined || b.name !== undefined) {
    const input = campusInput(b.label ?? b.name);
    if (!input) return err('Enter a campus, e.g. CC or North.');
    if (input.name !== cur.name) {
      if (list.some((c) => c.name === input.name)) return err(`Campus ${input.name} already exists.`, 409);
      const usage = await deps.store.usage(cur.name);
      if (inUse(usage)) {
        return err(
          `Campus ${cur.name} is in use (${describeUsage(usage)}), so only its display label can change, not the campus code ` +
            `(students and timetable keep "${cur.name}"). Add a new campus and deactivate this one instead.`,
          409,
          { usage }
        );
      }
      patch.name = input.name;
    }
    patch.label = input.label;
  }
  if (b.active !== undefined) patch.active = Boolean(b.active);
  await deps.store.update(id, patch);
  return json({ ok: true });
}

export async function handleDeleteCampus(id: string, deps: Deps) {
  const g = await deps.guard();
  if (g.res) return g.res;
  const cur = (await deps.store.list()).find((c) => c.id === id);
  if (!cur) return err('Campus not found', 404);
  const usage = await deps.store.usage(cur.name);
  if (inUse(usage)) {
    return err(
      `Campus ${cur.name} is in use and cannot be deleted: ${describeUsage(usage)}. Deactivate it instead to hide it from new selections.`,
      409,
      { usage, suggest: 'deactivate' }
    );
  }
  await deps.store.remove(id);
  return json({ ok: true });
}
