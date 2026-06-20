import React from 'react';
import { motion } from 'framer-motion';
import { cn } from '../../lib/cn';

export default function Card({ as = 'div', glass = false, hover = false, className, children, ...props }) {
  const Comp = motion[as] || motion.div;
  return (
    <Comp
      whileHover={hover ? { y: -4 } : undefined}
      transition={{ type: 'spring', stiffness: 300, damping: 24 }}
      className={cn(
        'rounded-3xl border shadow-[var(--shadow-card)]',
        glass
          ? 'glass'
          : 'bg-white/90 border-slate-100',
        className
      )}
      {...props}
    >
      {children}
    </Comp>
  );
}
