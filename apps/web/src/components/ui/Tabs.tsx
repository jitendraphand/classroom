'use client';

import { cn } from '@/lib/cn';

export type TabItem<T extends string> = {
  id: T;
  label: string;
  badge?: number | string;
};

export function Tabs<T extends string>({
  items,
  value,
  onChange,
  className,
}: {
  items: TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  className?: string;
}) {
  return (
    <div className={cn('flex gap-1 rounded-xl bg-black/25 p-1', className)} role="tablist">
      {items.map((item) => {
        const active = item.id === value;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={active}
            className={active ? 'sidebar-tab-active' : 'sidebar-tab-idle'}
            onClick={() => onChange(item.id)}
          >
            {item.label}
            {item.badge != null && item.badge !== 0 && (
              <span className="ml-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-brand-500 px-1 text-[10px] font-bold text-white">
                {item.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
