/** Install renderer error reporting for one window (window.onerror + unhandled rejections). */
import { createErrorReporter } from '../shared/errorReport';
import { desktop } from './bridge';

let report: ((e: unknown, componentStack?: string | null) => boolean) | null = null;
let classCode = '';

export function setReportClassCode(code: string): void {
  classCode = code;
}

export function reportRendererError(error: unknown, componentStack?: string | null): void {
  report?.(error, componentStack);
}

export function installErrorReporter(windowName: string): void {
  if (report) return;
  report = createErrorReporter({
    windowName,
    code: () => classCode,
    ua: `ClassroomTeacher-win ${navigator.userAgent}`,
    post: (r) => desktop().api('POST', '/api/client-error', r),
  });
  window.addEventListener('error', (ev) => reportRendererError(ev.error ?? ev.message));
  window.addEventListener('unhandledrejection', (ev) => reportRendererError(ev.reason));
}
