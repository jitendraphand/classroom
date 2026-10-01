import { redirect } from 'next/navigation';

/** Public teacher self-registration was removed: the school admin creates teacher accounts. */
export default function RegisterRemoved() {
  redirect('/login');
}
