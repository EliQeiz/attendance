import React, { useId } from 'react';
import { motion } from 'framer-motion';
import { cn } from '../../lib/cn';

const MotionSpan = motion.span;

export default function SegmentedToggle({ options, value, onChange, className }) {
  const layoutId = useId();

  return (
    <div
      className={cn(
        'relative grid rounded-2xl bg-slate-100/80 p-1',
        className
      )}
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={cn(
              'relative z-10 flex items-center justify-center gap-1.5 rounded-xl py-2.5 text-sm font-semibold transition-colors duration-200',
              active ? 'text-white' : 'text-slate-500 hover:text-slate-700'
            )}
          >
            {active && (
              <MotionSpan
                layoutId={`seg-${layoutId}`}
                transition={{ type: 'spring', stiffness: 420, damping: 32 }}
                className="absolute inset-0 -z-10 rounded-xl bg-gradient-to-r from-brand-600 via-iris-600 to-grass-600 shadow-[0_6px_18px_-6px_rgba(109,51,245,0.6)]"
              />
            )}
            {option.icon}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
