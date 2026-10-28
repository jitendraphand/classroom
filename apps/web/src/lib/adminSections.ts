import { hasAnyPrivilege, PRIVILEGE_LABELS, type Privilege, type PrivilegeSet } from './privileges';

/**
 * The admin area's sections, in navigation order. One table drives the tabs,
 * the per-page access check and the Settings hub, and each `view` matches the
 * guard on that page's read API (see app/api/admin/*), so a page that opens
 * always has data, and one that cannot is never offered.
 */
export type AdminSectionId = 'today' | 'live' | 'timetable' | 'teachers' | 'students' | 'attendance' | 'performance' | 'settings';

/** Privileges any one of which grants access; 'SYSTEM' = system administrator only. */
type Need = Privilege[] | 'SYSTEM';

export type AdminSection = { id: AdminSectionId; href: string; label: string; prefixes: string[]; view: Need };

export const ADMIN_SECTIONS: AdminSection[] = [
  { id: 'today', href: '/admin', label: 'Today', prefixes: [], view: ['viewReports', 'monitorLive', 'schedule'] },
  { id: 'live', href: '/admin/live', label: 'Live', prefixes: ['/admin/live'], view: ['monitorLive'] },
  { id: 'timetable', href: '/admin/timetable', label: 'Timetable', prefixes: ['/admin/timetable'], view: ['schedule'] },
  { id: 'teachers', href: '/admin/teachers', label: 'Teachers', prefixes: ['/admin/teachers'], view: ['manageTeachers', 'schedule', 'viewReports'] },
  { id: 'students', href: '/admin/students', label: 'Students', prefixes: ['/admin/students'], view: ['manageSchool'] },
  { id: 'attendance', href: '/admin/reports', label: 'Attendance', prefixes: ['/admin/reports'], view: ['viewReports'] },
  { id: 'performance', href: '/admin/performance', label: 'Performance', prefixes: ['/admin/performance'], view: ['viewReports'] },
  // Set-up pages that are rarely touched live behind one Settings tab.
  { id: 'settings', href: '/admin/system', label: 'Settings', prefixes: ['/admin/system', '/admin/grades'], view: ['manageSchool'] },
];

export type SettingsItem = { href: string; title: string; body: string; view: Need };

/** Cards on the Settings hub (/admin/system). */
export const SETTINGS_ITEMS: SettingsItem[] = [
  { href: '/admin/grades', title: 'Campuses, grades and divisions', body: 'The school structure that students, teachers and classes use.', view: ['manageSchool'] },
  { href: '/admin/system/years', title: 'Academic years', body: 'Year labels such as 2026-27, stored on every class.', view: ['manageSchool'] },
  { href: '/admin/system/settings', title: 'Class size and microphones', body: 'Optional limits. Leave them empty for no limit.', view: ['manageSchool'] },
  { href: '/admin/system/admins', title: 'Sub-administrators', body: 'Give other staff some admin permissions.', view: 'SYSTEM' },
];

/** Per-page needs where a page is stricter than its section (Settings children). */
const PAGE_VIEW: { prefix: string; view: Need }[] = [
  { prefix: '/admin/system/admins', view: 'SYSTEM' },
  { prefix: '/admin/system/years', view: ['manageSchool'] },
  { prefix: '/admin/system/settings', view: ['manageSchool'] },
  { prefix: '/admin/grades', view: ['manageSchool'] },
];

export function allowed(need: Need, privs: PrivilegeSet, kind: string): boolean {
  if (kind === 'SYSTEM') return true;
  return need !== 'SYSTEM' && hasAnyPrivilege(privs, kind, need);
}

export function sectionForPath(pathname: string): AdminSection {
  const hit = ADMIN_SECTIONS.find((s) => s.prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`)));
  return hit ?? ADMIN_SECTIONS[0]!;
}

function settingsVisible(privs: PrivilegeSet, kind: string): boolean {
  return SETTINGS_ITEMS.some((i) => allowed(i.view, privs, kind));
}

/** Tabs this admin sees, in order. System administrators see all of them. */
export function visibleAdminSections(privs: PrivilegeSet, kind: string): AdminSectionId[] {
  return ADMIN_SECTIONS.filter((s) => (s.id === 'settings' ? settingsVisible(privs, kind) : allowed(s.view, privs, kind))).map((s) => s.id);
}

export function visibleSettingsItems(privs: PrivilegeSet, kind: string): SettingsItem[] {
  return SETTINGS_ITEMS.filter((i) => allowed(i.view, privs, kind));
}

/**
 * Whether this admin may open the page, and if not, the permission to ask for
 * (shown instead of a page whose every request would be refused).
 */
export function pageAccess(pathname: string, privs: PrivilegeSet, kind: string): { ok: true } | { ok: false; needs: string } {
  const specific = PAGE_VIEW.find((p) => pathname === p.prefix || pathname.startsWith(`${p.prefix}/`));
  const section = sectionForPath(pathname);
  const need = specific?.view ?? (section.id === 'settings' && pathname === '/admin/system' ? null : section.view);
  if (need === null) return settingsVisible(privs, kind) ? { ok: true } : { ok: false, needs: PRIVILEGE_LABELS.manageSchool };
  if (allowed(need, privs, kind)) return { ok: true };
  return { ok: false, needs: need === 'SYSTEM' ? 'System administrator' : need.map((p) => PRIVILEGE_LABELS[p]).join(' or ') };
}
