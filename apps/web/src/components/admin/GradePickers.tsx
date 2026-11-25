'use client';

/**
 * Grade / division dropdowns fed by the master list (Admin → Grades & divisions)
 * via GET /api/grades/options (active entries only). Every picker keeps a
 * current value that is not (or no longer) in the list visible and selected,
 * marked "not in list", so editing an old row never silently drops data.
 * Before the master list is set up (`configured: false`) they fall back to
 * plain text inputs.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/clientFetch';
import { cn } from '@/lib/cn';
import {
  ALL_DIVISIONS,
  displayDivision,
  formatAssignment,
  normalizeDivision,
  normalizeCampus,
  normalizeGrade,
  parseAssignments,
  parseDivisionList,
  type Assignment,
} from '@/lib/grades';
import type { GradeOption } from '@/lib/gradeMasterLogic';
import type { CampusOption } from '@/lib/campusLogic';
import { displayCampusLabel, displayFoundationLabel, displayGradeLabel } from '@/lib/audienceLabels';
import { addAssignments } from '@/lib/assignmentPick';
import { sortGradeOptions } from '@/lib/gradeOrder';

export type GradeOptions = {
  grades: GradeOption[];
  configured: boolean;
  campuses: CampusOption[];
  campusesConfigured: boolean;
  loading: boolean;
  reload: () => void;
};

type OptionsData = { grades: GradeOption[]; configured: boolean; campuses: CampusOption[]; campusesConfigured: boolean };
const EMPTY: OptionsData = { grades: [], configured: false, campuses: [], campusesConfigured: false };

let cache: Promise<OptionsData> | null = null;
function fetchOptions(force = false) {
  if (!cache || force) {
    cache = api<OptionsData>('/api/grades/options').then((r) => {
      if (!r.ok) {
        cache = null;
        return EMPTY;
      }
      return {
        grades: r.data.grades ?? [],
        configured: Boolean(r.data.configured),
        campuses: r.data.campuses ?? [],
        campusesConfigured: Boolean(r.data.campusesConfigured),
      };
    });
  }
  return cache;
}

/** Drop the cached dropdown data (after editing Grades & divisions / Campuses). */
export function invalidateGradeOptions() {
  cache = null;
}

export function useGradeOptions(): GradeOptions {
  const [state, setState] = useState<OptionsData & { loading: boolean }>({ ...EMPTY, loading: true });
  const load = useCallback((force = false) => {
    void fetchOptions(force).then((d) => setState({ ...d, loading: false }));
  }, []);
  useEffect(() => load(), [load]);
  return { ...state, reload: () => load(true) };
}

/** The campus a new row defaults to: the only active campus, else none. */
export function defaultCampus(options: GradeOptions): string {
  return options.campuses.length === 1 ? options.campuses[0].name : '';
}

/** "Airport Campus": the readable label only (no "(AIRPORTCAMPUS)" code suffix). */
const campusLabel = (c: CampusOption) => displayCampusLabel(c.name, { campuses: [c] }) || c.name;

type CampusSelectProps = {
  value: string;
  onChange: (campus: string) => void;
  options: GradeOptions;
  /** Placeholder option (value ""), e.g. "Campus…" or "All campuses". */
  emptyLabel?: string;
  /** Limit to these canonical campuses (teacher's assigned campuses). */
  only?: string[];
  required?: boolean;
  className?: string;
  ariaLabel?: string;
};

/** Campus dropdown (Admin → Grades & divisions → Campuses); text input before any campus is set up. */
export function CampusSelect({ value, onChange, options, emptyLabel = 'Campus…', only, required, className, ariaLabel }: CampusSelectProps) {
  if (!options.campusesConfigured && !options.loading) {
    return (
      <input
        className={cn('input', className)}
        value={value}
        required={required}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Campus"
        aria-label={ariaLabel ?? 'Campus'}
      />
    );
  }
  const v = value ? normalizeCampus(value) : '';
  const list = options.campuses.filter((c) => !only || only.includes(c.name));
  const missing = v && !list.some((c) => c.name === v);
  return (
    <select
      className={cn('input', className)}
      value={v}
      required={required}
      onChange={(e) => onChange(e.target.value)}
      aria-label={ariaLabel ?? 'Campus'}
    >
      <option value="">{options.loading ? 'Loading…' : emptyLabel}</option>
      {list.map((c) => (
        <option key={c.name} value={c.name}>
          {campusLabel(c)}
        </option>
      ))}
      {missing && <option value={v}>{v} (not in list)</option>}
    </select>
  );
}

type CampusesPickerProps = {
  /** Canonical campus codes, primary first. */
  value: string[];
  onChange: (campuses: string[]) => void;
  options: GradeOptions;
  /** Limit to these canonical campuses (teacher's assigned campuses). */
  only?: string[];
  className?: string;
};

/**
 * Multi-select of campuses (any combination), like DivisionsPicker. Nov 25:
 * a weekly slot, extra class or ad-hoc class may cover several campuses.
 */
export function CampusesPicker({ value, onChange, options, only, className }: CampusesPickerProps) {
  if (!options.campusesConfigured && !options.loading) {
    return (
      <input
        className={cn('input', className)}
        value={value.join(', ')}
        onChange={(e) => onChange(e.target.value.split(/[,;]+/).map((x) => normalizeCampus(x)).filter(Boolean))}
        placeholder="Campus, or several separated by commas"
        aria-label="Campuses"
      />
    );
  }
  const sel = value.map((c) => normalizeCampus(c)).filter(Boolean);
  const list = options.campuses.filter((c) => !only || only.includes(c.name));
  const extra = sel.filter((c) => !list.some((x) => x.name === c));
  const all = list.length > 1 && list.every((c) => sel.includes(c.name));
  const toggle = (e: React.MouseEvent, c: string) => {
    e.preventDefault();
    e.stopPropagation();
    onChange(sel.includes(c) ? sel.filter((x) => x !== c) : [...sel, c]);
  };
  return (
    <div className={cn('flex min-h-[42px] flex-wrap items-center gap-1.5 rounded-xl border border-white/10 bg-black/20 p-1.5', className)} role="group" aria-label="Campuses">
      {list.length > 1 && (
        <Chip active={all} onClick={(e) => { e.preventDefault(); e.stopPropagation(); onChange(all ? [] : list.map((c) => c.name)); }}>
          All campuses
        </Chip>
      )}
      {list.map((c) => (
        <Chip key={c.name} active={sel.includes(c.name)} onClick={(e) => toggle(e, c.name)}>
          {campusLabel(c)}
        </Chip>
      ))}
      {extra.map((c) => (
        <Chip key={`extra-${c}`} active onClick={(e) => toggle(e, c)} title="Not in Campuses (or inactive)">
          {c} ⚠
        </Chip>
      ))}
      {!list.length && !extra.length && <span className="px-1 text-xs text-slate-500">{options.loading ? 'Loading…' : 'No campuses set up'}</span>}
    </div>
  );
}

/** "Grade 7": the readable label only (no "(7)" code suffix). */
const gradeLabel = (g: GradeOption) => displayGradeLabel(g.name, { grades: [g] }) || g.name;

type GradeSelectProps = {
  value: string;
  onChange: (grade: string) => void;
  options: GradeOptions;
  /** Placeholder option (value ""), e.g. "Choose…" or "All grades". */
  emptyLabel?: string;
  /** Limit to these canonical grades (teacher's assigned grades). */
  only?: string[];
  required?: boolean;
  className?: string;
  ariaLabel?: string;
};

export function GradeSelect({ value, onChange, options, emptyLabel = 'Choose…', only, required, className, ariaLabel }: GradeSelectProps) {
  if (!options.configured && !options.loading) {
    return (
      <input
        className={cn('input', className)}
        value={value}
        required={required}
        onChange={(e) => onChange(e.target.value)}
        placeholder="7"
        aria-label={ariaLabel ?? 'Grade'}
      />
    );
  }
  const v = value ? normalizeGrade(value) : '';
  const list = sortGradeOptions(options.grades.filter((g) => !only || only.includes(g.name)));
  const missing = v && !list.some((g) => g.name === v);
  return (
    <select
      className={cn('input', className)}
      value={v}
      required={required}
      onChange={(e) => onChange(e.target.value)}
      aria-label={ariaLabel ?? 'Grade'}
    >
      <option value="">{options.loading ? 'Loading…' : emptyLabel}</option>
      {list.map((g) => (
        <option key={g.name} value={g.name}>
          {gradeLabel(g)}
        </option>
      ))}
      {missing && <option value={v}>{v} (not in list)</option>}
    </select>
  );
}

function divisionsOf(options: GradeOptions, grade: string) {
  const g = normalizeGrade(grade);
  return options.grades.find((x) => x.name === g)?.divisions ?? [];
}

type DivisionSelectProps = {
  grade: string;
  value: string;
  onChange: (division: string) => void;
  options: GradeOptions;
  emptyLabel?: string;
  className?: string;
  ariaLabel?: string;
};

/** Single division (filters). Disabled until a grade is chosen. */
export function DivisionSelect({ grade, value, onChange, options, emptyLabel = 'All divisions', className, ariaLabel }: DivisionSelectProps) {
  if (!options.configured && !options.loading) {
    return (
      <input
        className={cn('input', className)}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Division"
        aria-label={ariaLabel ?? 'Division'}
      />
    );
  }
  const v = value ? normalizeDivision(value) : '';
  const list = divisionsOf(options, grade);
  const missing = v && !list.some((d) => d.name === v);
  return (
    <select
      className={cn('input', className)}
      value={v}
      disabled={!grade}
      onChange={(e) => onChange(e.target.value)}
      aria-label={ariaLabel ?? 'Division'}
    >
      <option value="">{emptyLabel}</option>
      {list.map((d) => (
        <option key={d.name} value={d.name}>
          {d.label}
        </option>
      ))}
      {missing && <option value={v}>{displayDivision(v)} (not in list)</option>}
    </select>
  );
}

/** "A, B" / "ALL" text ↔ selection (the existing API format). */
export function parseDivisionsText(text: string): { all: boolean; divisions: string[] } {
  const d = parseDivisionList(text);
  return { all: d.allDivisions, divisions: d.divisions };
}
export function formatDivisionsText(all: boolean, divisions: string[]) {
  return all ? 'ALL' : divisions.join(', ');
}

type DivisionsPickerProps = {
  grade: string;
  /** "A, B" or "ALL". */
  value: string;
  onChange: (text: string) => void;
  options: GradeOptions;
  /** Offer "All divisions" (combined/whole-grade classes). */
  allowAll?: boolean;
  /** Limit to these canonical divisions (teacher's assigned divisions). */
  only?: string[];
  className?: string;
};

/** Multi-select of the grade's divisions, plus "All divisions". */
export function DivisionsPicker({ grade, value, onChange, options, allowAll = true, only, className }: DivisionsPickerProps) {
  if (!options.configured && !options.loading) {
    return (
      <input
        className={cn('input', className)}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={allowAll ? 'A, B or ALL' : 'A, B'}
        aria-label="Divisions"
      />
    );
  }
  const sel = parseDivisionsText(value);
  // Compare on the canonical form (same normaliser the text parser uses) and
  // de-duplicate by it, so one chip maps to exactly one selection entry and a
  // click can never toggle a sibling with the same/overlapping key.
  const seenNames = new Set<string>();
  const list = divisionsOf(options, grade)
    .map((d) => ({ ...d, key: normalizeDivision(d.name) }))
    .filter((d) => d.key && (!only || only.includes(d.name) || only.includes(d.key)))
    .filter((d) => (seenNames.has(d.key) ? false : (seenNames.add(d.key), true)));
  const extra = sel.divisions.filter((d) => !list.some((x) => x.key === d));
  const toggle = (e: React.MouseEvent, d: string) => {
    e.preventDefault();
    e.stopPropagation();
    const cur = parseDivisionsText(value).divisions;
    const next = cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d];
    onChange(formatDivisionsText(false, next));
  };
  if (!grade) return <p className={cn('input text-slate-500', className)}>Choose a grade first</p>;
  return (
    <div className={cn('flex min-h-[42px] flex-wrap items-center gap-1.5 rounded-xl border border-white/10 bg-black/20 p-1.5', className)} role="group" aria-label="Divisions">
      {allowAll && (
        <Chip active={sel.all} onClick={(e) => { e.preventDefault(); e.stopPropagation(); onChange(sel.all ? '' : 'ALL'); }}>
          All divisions
        </Chip>
      )}
      {list.map((d) => (
        <Chip key={d.key} active={!sel.all && sel.divisions.includes(d.key)} disabled={sel.all} onClick={(e) => toggle(e, d.key)}>
          {d.label}
        </Chip>
      ))}
      {!sel.all &&
        extra.map((d) => (
          <Chip key={`extra-${d}`} active onClick={(e) => toggle(e, d)} title="Not in Grades & divisions (or inactive)">
            {displayDivision(d)} ⚠
          </Chip>
        ))}
      {!list.length && !allowAll && <span className="px-1 text-xs text-slate-500">No divisions set up for this grade</span>}
    </div>
  );
}

function Chip({
  active,
  disabled,
  onClick,
  children,
  title,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'rounded-lg border px-2.5 py-1 text-xs font-medium transition',
        active ? 'border-brand-400/60 bg-brand-600 text-white' : 'border-white/10 text-slate-300 hover:border-white/30',
        disabled && 'opacity-40'
      )}
    >
      {children}
    </button>
  );
}

function safeAssignments(text: string): Assignment[] {
  try {
    // Unprefixed legacy tokens are shown under "?" so nothing is dropped silently.
    return parseAssignments(text, '?');
  } catch {
    return [];
  }
}

/**
 * Teacher assignments as chips + "add" row (campus, grade, division or ALL).
 * Value/onChange use the "CC@7-A, CC@8-ALL" text the teachers API takes.
 */
export function AssignmentsPicker({ value, onChange, options }: { value: string; onChange: (text: string) => void; options: GradeOptions }) {
  const [campusPick, setCampuses] = useState<string[]>([]);
  const campuses = campusPick.length ? campusPick : [defaultCampus(options)].filter(Boolean);
  const [grade, setGrade] = useState('');
  const [divisionsText, setDivisionsText] = useState('');
  if (!options.configured && !options.loading) {
    return (
      <input className="input" value={value} onChange={(e) => onChange(e.target.value)} placeholder="CC@7-A, CC@7-B, CC@8-ALL" aria-label="Grades" />
    );
  }
  const items = safeAssignments(value);
  const write = (list: Assignment[]) => onChange(list.map(formatAssignment).join(', '));
  const pick = parseDivisionsText(divisionsText);
  const canAdd = campuses.length > 0 && !!grade && (pick.all || pick.divisions.length > 0);
  const add = () => {
    if (!canAdd) return;
    write(addAssignments(items, campuses, grade, pick));
    setDivisionsText('');
  };
  const labels = { campuses: options.campuses, grades: options.grades };
  const chipLabel = (a: Assignment) =>
    `${displayCampusLabel(a.campus, labels)} · ${displayGradeLabel(a.grade, labels)} · ${
      a.division === ALL_DIVISIONS ? 'All divisions' : displayFoundationLabel(a.grade, a.division, labels)
    }`;
  const known = (a: Assignment) => {
    const g = options.grades.find((x) => x.name === a.grade);
    const campusOk = !options.campusesConfigured || options.campuses.some((c) => c.name === a.campus);
    return campusOk && !!g && (a.division === ALL_DIVISIONS || g.divisions.some((d) => d.name === a.division));
  };
  return (
    <div className="space-y-2">
      <div className="flex min-h-[42px] flex-wrap gap-1.5 rounded-xl border border-white/10 bg-black/20 p-1.5">
        {items.length ? (
          items.map((a) => (
            <span
              key={`${a.campus}|${a.grade}|${a.division}`}
              className={cn(
                'inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-xs',
                known(a) ? 'border-white/15 text-slate-200' : 'border-amber-400/40 text-amber-200'
              )}
              title={known(a) ? undefined : 'Not in Grades & divisions (or inactive)'}
            >
              {chipLabel(a)}
              <button
                type="button"
                className="text-slate-400 hover:text-red-300"
                aria-label={`Remove ${chipLabel(a)}`}
                onClick={() => write(items.filter((x) => x !== a))}
              >
                ×
              </button>
            </span>
          ))
        ) : (
          <span className="px-1 py-1 text-xs text-slate-500">No grades yet</span>
        )}
      </div>
      <div className="grid gap-2" data-testid="assignment-add">
        <CampusesPicker value={campuses} onChange={setCampuses} options={options} />
        <div className="flex flex-wrap items-start gap-2">
          <GradeSelect className="w-36" value={grade} onChange={(g) => {
              setGrade(g);
              setDivisionsText('');
            }} options={options} emptyLabel="Grade…" />
          <DivisionsPicker className="min-w-[12rem] flex-1" grade={grade} value={divisionsText} onChange={setDivisionsText} options={options} />
          <button type="button" className="btn-secondary px-3 py-1.5 text-xs" disabled={!canAdd} onClick={add}>
            Add
          </button>
        </div>
      </div>
    </div>
  );
}
