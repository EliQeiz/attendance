import React from 'react';
import { cn } from '../../lib/cn';

export default function Input({ icon: Icon, className, wrapperClassName, ...props }) {
  return (
    <div className={cn('relative', wrapperClassName)}>
      {Icon && (
        <Icon
          size={18}
          className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-400"
        />
      )}
      <input
        className={cn(
          'h-12 w-full rounded-2xl border border-slate-200 bg-white/80 text-slate-800',
          'placeholder:text-slate-400 text-[0.95rem]',
          Icon ? 'pl-11 pr-4' : 'px-4',
          'transition-[border,box-shadow,background] duration-200',
          'focus:border-iris-400 focus:bg-white focus:outline-none focus:ring-4 focus:ring-iris-500/15',
          'disabled:opacity-60 disabled:cursor-not-allowed',
          className
        )}
        {...props}
      />
    </div>
  );
}
