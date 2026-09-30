import { redirect } from 'next/navigation';

/**
 * The share-controls popup must not boot this Next app. The root layout mounts
 * the idle-logout guard, which would sign the teacher out after 15 minutes of
 * no activity inside the popup even while they are teaching in the main window.
 * The live host is the static same-origin document /share-controls.html.
 */
export default function HudRedirectPage() {
  redirect('/share-controls.html');
}
