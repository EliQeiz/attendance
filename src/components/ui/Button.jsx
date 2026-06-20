import React from 'react';
import { motion } from 'framer-motion';
import { cn } from '../../lib/cn';

const MotionButton = motion.button;

const VARIANTS = {
  primary:
    'text-white bg-gradient-to-r from-brand-600 via-iris-600 to-grass-600 shadow-[0_10px_30px_-10px_rgba(31,71,230,0.6)] hover:shadow-[0_14px_40px_-10px_rgba(109,51,245,0.7)]',
  brand:
    'text-white bg-gradient-to-r from-brand-700 to-brand-500 shadow-[0_10px_30px_-12px_rgba(31,71,230,0.6)] hover:from-brand-800 hover:to-brand-600',
  success:
    'text-white bg-gradient-to-r from-grass-600 to-grass-500 shadow-[0_10px_30px_-12px_rgba(3,152,85,0.6)] hover:from-grass-700 hover:to-grass-600',
  iris:
    'text-white bg-gradient-to-r from-iris-600 to-iris-500 shadow-[0_10px_30px_-12px_rgba(109,51,245,0.6)] hover:from-iris-700 hover:to-iris-600',
  outline:
    'text-brand-800 bg-white/70 border border-brand-200 hover:bg-white hover:border-brand-300',
  ghost:
    'text-slate-600 bg-transparent hover:bg-slate-100',
  danger:
    'text-white bg-gradient-to-r from-rose-600 to-rose-500 shadow-[0_10px_30px_-12px_rgba(225,29,72,0.6)] hover:from-rose-700 hover:to-rose-600'
};

const SIZES = {
  sm: 'h-9 px-4 text-sm rounded-xl gap-1.5',
  md: 'h-11 px-5 text-sm rounded-2xl gap-2',
  lg: 'h-13 px-6 text-base rounded-2xl gap-2.5 py-3'
};

export default function Button({
  variant = 'primary',
  size = 'md',
  className,
  children,
  fullWidth = false,
  isLoading = false,
  disabled,
  ...props
}) {
  return (
    <MotionButton
      whileHover={{ y: -2 }}
      whileTap={{ scale: 0.97 }}
      transition={{ type: 'spring', stiffness: 400, damping: 24 }}
      disabled={disabled || isLoading}
      className={cn(
        'inline-flex items-center justify-center font-semibold tracking-tight',
        'transition-[background,box-shadow,color] duration-200 select-none',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-iris-400 focus-visible:ring-offset-2',
        'disabled:opacity-60 disabled:cursor-not-allowed disabled:pointer-events-none',
        VARIANTS[variant],
        SIZES[size],
        fullWidth && 'w-full',
        className
      )}
      {...props}
    >
      {isLoading && (
        <span className="size-4 rounded-full border-2 border-white/40 border-t-white animate-spin" />
      )}
      {children}
    </MotionButton>
  );
}
