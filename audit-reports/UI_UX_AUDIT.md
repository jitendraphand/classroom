# UI / UX Audit

Method: component and CSS review, plus measured entry-page metrics. The live classroom screens were not rendered with data here; those findings come from code.

## Design system
- A small shared kit in `components/ui` (Button, IconButton, Card, Badge, Input, Tabs, ConfirmDialog, EmptyState, Skeleton, Avatar, Icons); Tailwind tokens; two fonts (Inter body, Outfit display).
- **Dark-only theme** (`<html className="dark">`, `app/layout.tsx:43`). Fine for video, but there is no light option for bright classrooms or projector use.
- Loading states: `PageLoading`, `Skeleton`. Empty states: `EmptyState` (6 app pages use them). Errors: specific copy for camera and mic failures.

## Accessibility (counts measured with grep in `apps/web/src`)
| Check | Result | Assessment |
|---|---|---|
| `aria-label` | 194 | Good coverage on icon buttons |
| `role=` | 81 | — |
| `aria-live` | 8 | Some announcements; check that chat arrivals and "you are unmuted" are announced |
| `prefers-reduced-motion` | **0** occurrences in `globals.css` | Add, for the floating and speaking pop-ups and pulses |
| `html lang` | `en` | OK |
| Contrast | `text-slate-500` used 57× on dark backgrounds | slate-500 (#64748b) on slate-900/950 is ≈3.7:1, **below WCAG AA 4.5:1** for small text (estimate from the palette; verify with axe). Use slate-400 for body text |
| Keyboard | Not tested | Run axe + a keyboard pass on the classroom controls |
| CLS | 0 on entry pages (measured) | — |

## Live classroom UI (code review)
| Area | Observation | Recommendation |
|---|---|---|
| Student stage | One layout everywhere: share fills the screen, teacher float, right control panel | Good consistency |
| Speaker identification | Speaking pop-up (teacher side), roster speaking state | Add a speaking ring on the student side for the teacher float |
| Mic / camera controls | Clear lock states ("Mic locked — teacher not in class") | — |
| Connection status | Only a "Reconnecting…" pill for students | UX-01 signal bars |
| Data controls | "Quality" Full/Low/Audio | Rename "Audio" to "Audio + slides"; add a true Audio only (DATA-02) |
| Teacher controls | Dense but grouped (HUD, roster menus) | First-run hints; keep progressive disclosure |
| Mobile layouts | dvh-safe heights, clamped floats | Verify the 360-px width with the chat drawer open |

## Concrete usability problems (each tied to a cause)
1. **Students cannot tell network from class problems** → UX-01.
2. **Typo creates a new identity** → UX-02.
3. **Low-contrast secondary text** (slate-500) on dark → readability on cheap, dim LCDs in sunlight. Verify with axe.
4. **No reduced-motion support** → vestibular discomfort and extra GPU work on low-end devices.
