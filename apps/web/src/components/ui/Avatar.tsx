import { cn } from '@/lib/cn';

const palette = [
  'from-brand-600 to-indigo-500',
  'from-violet-600 to-fuchsia-500',
  'from-emerald-600 to-teal-500',
  'from-amber-600 to-orange-500',
  'from-rose-600 to-pink-500',
  'from-sky-600 to-cyan-500',
];

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function colorFor(name: string) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h + name.charCodeAt(i) * 17) % palette.length;
  return palette[h];
}

export function Avatar({
  name,
  size = 'md',
  className,
}: {
  name: string;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
}) {
  const sizes = {
    xs: 'h-5 w-5 text-[8px]',
    sm: 'h-7 w-7 text-2xs',
    md: 'h-9 w-9 text-xs',
    lg: 'h-12 w-12 text-sm',
    xl: 'h-16 w-16 text-lg',
  };
  return (
    <div
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br font-semibold text-white shadow-soft',
        sizes[size],
        colorFor(name || '?'),
        className
      )}
      aria-hidden
    >
      {initials(name || '?')}
    </div>
  );
}
