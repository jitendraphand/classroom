/**
 * Sub-admin privileges. The system administrator (kind SYSTEM, seeded from
 * ADMIN_EMAIL) has every privilege and is the only account that can create,
 * edit or delete sub-admins. Enforcement is on each API route, not only in
 * the admin navigation.
 */

export const PRIVILEGES = [
  'manageTeachers',
  'schedule',
  'monitorLive',
  'viewReports',
  'manageSchool',
] as const;

export type Privilege = (typeof PRIVILEGES)[number];

export type PrivilegeSet = Record<Privilege, boolean>;

export const PRIVILEGE_LABELS: Record<Privilege, string> = {
  manageTeachers: 'Manage teachers (add and delete)',
  schedule: 'Schedule and assign classes',
  monitorLive: 'Monitor and join live classes',
  viewReports: 'View data and reports',
  manageSchool: 'Manage campus, grade, division and students',
};

export function allPrivileges(on: boolean): PrivilegeSet {
  return {
    manageTeachers: on,
    schedule: on,
    monitorLive: on,
    viewReports: on,
    manageSchool: on,
  };
}

export function privilegeSetFrom(row: {
  kind?: string | null;
  privManageTeachers?: boolean | null;
  privSchedule?: boolean | null;
  privMonitorLive?: boolean | null;
  privViewReports?: boolean | null;
  privManageSchool?: boolean | null;
}): PrivilegeSet {
  if (row.kind === 'SYSTEM') return allPrivileges(true);
  return {
    manageTeachers: !!row.privManageTeachers,
    schedule: !!row.privSchedule,
    monitorLive: !!row.privMonitorLive,
    viewReports: !!row.privViewReports,
    manageSchool: !!row.privManageSchool,
  };
}

export function hasPrivilege(privs: PrivilegeSet, kind: string, privilege: Privilege): boolean {
  if (kind === 'SYSTEM') return true;
  return !!privs[privilege];
}

export function hasAnyPrivilege(privs: PrivilegeSet, kind: string, list: Privilege[]): boolean {
  return list.some((p) => hasPrivilege(privs, kind, p));
}

export function parsePrivilegeBody(body: unknown): PrivilegeSet | null {
  if (!body || typeof body !== 'object') return null;
  const o = body as Record<string, unknown>;
  const out = allPrivileges(false);
  for (const key of PRIVILEGES) {
    if (typeof o[key] !== 'boolean') return null;
    out[key] = o[key];
  }
  return out;
}
