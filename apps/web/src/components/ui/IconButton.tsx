'use client';

import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  active?: boolean;
  danger?: boolean;
  size?: 'sm' | 'md' | 'lg';
};

const sizes = {
  sm: 'h-9 w-9',
  md: 'h-11 w-11',
  lg: 'h-12 w-12',
};

export const IconButton = forwardRef<HTMLButtonElement, Props>(function IconButton(
  { className, label, active, danger, size = 'md', children, type = 'button', ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex items-center justify-center rounded-full border transition duration-150',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-0',
        'disabled:pointer-events-none disabled:opacity-45',
        sizes[size],
        danger
          ? 'border-red-500/40 bg-danger text-white hover:bg-red-500'
          : active
            ? 'border-brand-400/50 bg-brand-600 text-white shadow-glow'
            : 'border-white/10 bg-white/[0.06] text-slate-100 hover:bg-white/[0.12]',
        className
      )}
      {...rest}
    >
      {children}
    </button>
  );
});
