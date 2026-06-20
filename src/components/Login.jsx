import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Eye,
  EyeOff,
  GraduationCap,
  IdCard,
  KeyRound,
  Lock,
  Mail,
  MapPin,
  ShieldCheck,
  User,
  Users
} from 'lucide-react';
import { auth, db } from '../firebase';
import {
  browserLocalPersistence,
  createUserWithEmailAndPassword,
  deleteUser,
  sendEmailVerification,
  sendPasswordResetEmail,
  setPersistence,
  signOut,
  signInWithEmailAndPassword
} from 'firebase/auth';
import { doc, getDoc, serverTimestamp, setDoc, writeBatch } from 'firebase/firestore';
import Button from './ui/Button';
import Input from './ui/Input';
import SegmentedToggle from './ui/SegmentedToggle';
import { cn } from '../lib/cn';
import { fadeUp, popIn, staggerChildren, listItem } from '../lib/motion';

const MotionDiv = motion.div;
const MotionUl = motion.ul;
const MotionLi = motion.li;

const STUDENT_ID_PATTERN = /^\d{8}$/;
const STRONG_PASSWORD_PATTERN = /^(?=.*[A-Za-z])(?=.*\d).{8,}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const KNUST_LOGO = 'https://images.seeklogo.com/logo-png/35/2/kwame-nkrumah-university-of-science-technology-logo-png_seeklogo-350387.png';

const buildLegacyAuthEmail = (role, id) => {
  const safeId = id.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  return `${role}.${safeId}@knust-attendance.local`;
};
const normalizeEmail = (email = '') => email.trim().toLowerCase();
const resolveSignInEmail = (identifier, role) => (
  EMAIL_PATTERN.test(normalizeEmail(identifier))
    ? normalizeEmail(identifier)
    : buildLegacyAuthEmail(role, identifier)
);

const getAuthMessage = (err) => {
  if (err?.code === 'auth/email-already-in-use') {
    return 'An account already exists for this email. Sign in or use Forgot Password.';
  }

  if (err?.code === 'auth/invalid-credential' || err?.code === 'auth/user-not-found' || err?.code === 'auth/wrong-password') {
    return 'The email, legacy ID, or password was not accepted. Use Forgot Password if you cannot access your account.';
  }

  if (err?.code === 'auth/invalid-email') return 'Enter a valid email address.';
  if (err?.code === 'auth/too-many-requests') return 'Too many attempts. Wait a few minutes or reset your password by email.';

  if (err?.code === 'auth/operation-not-allowed') {
    return 'Enable Firebase Email/Password sign-in for this project.';
  }

  if (err?.code === 'auth/weak-password') {
    return 'Password must be at least 8 characters and include a letter and a number.';
  }

  if (err?.code === 'permission-denied') {
    return 'This account is not approved for that role. Lecturer accounts must be approved by an administrator.';
  }

  return 'Unable to continue. Please check your connection and try again.';
};

const FEATURES = [
  { icon: KeyRound, title: 'Rotating PIN', text: 'A fresh 4-digit code every few minutes — impossible to share ahead of time.' },
  { icon: MapPin, title: 'GPS proximity', text: 'Presence is confirmed only when you are physically in the lecture hall.' },
  { icon: ShieldCheck, title: 'Server-verified', text: 'Every check-in is validated in the cloud, not on the device.' }
];

function PasswordField({ value, onChange, placeholder, autoComplete }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Lock size={18} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
      <input
        type={show ? 'text' : 'password'}
        required
        placeholder={placeholder}
        autoComplete={autoComplete}
        value={value}
        onChange={onChange}
        className={cn(
          'h-12 w-full rounded-2xl border border-slate-200 bg-white/80 pl-11 pr-12 text-[0.95rem] text-slate-800',
          'placeholder:text-slate-400 transition-[border,box-shadow,background] duration-200',
          'focus:border-iris-400 focus:bg-white focus:outline-none focus:ring-4 focus:ring-iris-500/15'
        )}
      />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        className="absolute right-3 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
        aria-label={show ? 'Hide password' : 'Show password'}
      >
        {show ? <EyeOff size={18} /> : <Eye size={18} />}
      </button>
    </div>
  );
}

export default function Login({ onLogin }) {
  const [mode, setMode] = useState('signin');
  const [data, setData] = useState({
    name: '',
    id: '',
    role: 'student',
    email: '',
    password: '',
    confirmPassword: ''
  });
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isSignup = mode === 'signup';
  const isReset = mode === 'reset';

  const validate = () => {
    const knustId = data.id.trim();

    if (isReset) {
      return EMAIL_PATTERN.test(normalizeEmail(data.email)) ? '' : 'Enter the recovery email linked to your account.';
    }

    if (data.role === 'student' && isSignup && !STUDENT_ID_PATTERN.test(knustId)) {
      return 'Student KNUST ID must be exactly 8 digits.';
    }

    if (data.role === 'student' && !isSignup && !EMAIL_PATTERN.test(normalizeEmail(knustId)) && !STUDENT_ID_PATTERN.test(knustId)) {
      return 'Enter your recovery email or your exact 8-digit legacy Student ID.';
    }

    if (isSignup && !data.name.trim()) {
      return 'Full name is required for sign up.';
    }

    if (isSignup && !EMAIL_PATTERN.test(normalizeEmail(data.email))) {
      return 'A valid recovery email is required for sign up.';
    }

    if (isSignup && !STRONG_PASSWORD_PATTERN.test(data.password)) {
      return 'Password must be at least 8 characters and include a letter and a number.';
    }

    if (isSignup && data.password !== data.confirmPassword) {
      return 'Passwords do not match.';
    }

    return '';
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setStatus('');

    const validationMessage = validate();
    if (validationMessage) {
      setError(validationMessage);
      return;
    }

    setIsSubmitting(true);
    let createdUser = null;

    try {
      await setPersistence(auth, browserLocalPersistence);

      if (isReset) {
        await sendPasswordResetEmail(auth, normalizeEmail(data.email));
        setStatus('If an account is linked to this email, a password reset link has been sent. Check your inbox and spam folder.');
        return;
      }

      const knustId = data.id.trim();
      const authEmail = isSignup
        ? normalizeEmail(data.email)
        : resolveSignInEmail(data.id, data.role);
      const credential = isSignup
        ? await createUserWithEmailAndPassword(auth, authEmail, data.password)
        : await signInWithEmailAndPassword(auth, authEmail, data.password);
      createdUser = isSignup ? credential.user : null;

      const uid = credential.user.uid;
      const profileRef = doc(db, 'users', uid);
      const profileSnap = await getDoc(profileRef);

      if (isSignup) {
        const profile = {
          name: data.name.trim(),
          knust_id: knustId,
          login_id: knustId,
          role: data.role,
          email: authEmail,
          authEmail,
          recoveryEmail: authEmail,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        };

        if (data.role === 'student') {
          const signupBatch = writeBatch(db);
          signupBatch.set(profileRef, profile);
          signupBatch.set(doc(db, 'studentAccounts', knustId), {
            uid,
            knust_id: knustId,
            recoveryEmail: authEmail,
            createdAt: serverTimestamp()
          });
          await signupBatch.commit();
        } else {
          await setDoc(profileRef, profile);
        }
        sendEmailVerification(credential.user).catch((verificationError) => {
          console.error('Unable to send verification email:', verificationError);
        });

        onLogin({
          uid,
          id: data.role === 'lecturer' ? uid : knustId,
          knust_id: knustId,
          name: profile.name,
          role: data.role,
          email: authEmail,
          recoveryEmail: authEmail
        });
        return;
      }

      if (!profileSnap.exists()) {
        await signOut(auth);
        setError('Account profile is missing. Please sign up again or contact the administrator.');
        return;
      }

      const profile = profileSnap.data();
      onLogin({
        uid,
        id: profile.role === 'lecturer' ? uid : profile.knust_id,
        knust_id: profile.knust_id,
        name: profile.name,
        role: profile.role,
        email: profile.email || authEmail,
        recoveryEmail: profile.recoveryEmail || profile.email || authEmail
      });
    } catch (err) {
      console.error(`${isReset ? 'Password reset' : isSignup ? 'Sign up' : 'Sign in'} failed:`, err);

      if (createdUser) {
        await deleteUser(createdUser).catch((cleanupError) => {
          console.error('Unable to roll back incomplete account:', cleanupError);
        });
      }

      setError(
        isSignup && data.role === 'student' && err?.code === 'permission-denied'
          ? 'This Student ID is already linked to an account. Sign in with your recovery email or use Forgot Password.'
          : getAuthMessage(err)
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const switchMode = (next) => {
    setMode(next);
    setError('');
    setStatus('');
  };

  const title = isReset ? 'Recover account' : isSignup ? 'Create your account' : 'Welcome back';
  const subtitle = isReset
    ? 'Enter the recovery email linked to your account.'
    : isSignup
      ? 'Join the smart attendance platform in seconds.'
      : 'Sign in to mark and manage attendance.';

  return (
    <div className="aurora-bg min-h-dvh w-full flex items-center justify-center p-4 sm:p-6">
      <MotionDiv
        variants={popIn}
        initial="hidden"
        animate="show"
        className="glass relative w-full max-w-5xl overflow-hidden rounded-[2rem] shadow-[var(--shadow-glow)]"
      >
        <div className="grid lg:grid-cols-[1.05fr_1fr]">
          {/* Brand / showcase panel */}
          <div className="relative hidden overflow-hidden bg-gradient-to-br from-brand-900 via-iris-700 to-grass-700 p-10 lg:flex lg:flex-col">
            <div className="pointer-events-none absolute -top-24 -right-20 size-72 rounded-full bg-white/10 blur-2xl" />
            <div className="pointer-events-none absolute -bottom-28 -left-16 size-80 rounded-full bg-grass-400/20 blur-3xl" />

            <div className="relative flex items-center gap-3 text-white">
              <span className="grid size-12 place-items-center rounded-2xl bg-white/15 backdrop-blur">
                <img src={KNUST_LOGO} alt="KNUST" className="size-8 object-contain" />
              </span>
              <div>
                <p className="text-sm font-semibold tracking-wide text-white/80">KNUST</p>
                <p className="text-lg font-bold leading-tight">Smart Attendance</p>
              </div>
            </div>

            <div className="relative mt-12">
              <h2 className="text-3xl font-extrabold leading-tight text-white">
                Attendance that<br />can&apos;t be faked.
              </h2>
              <p className="mt-3 max-w-sm text-sm leading-relaxed text-white/75">
                PIN, GPS and server-side verification work together so every record is real, fair and tamper-proof.
              </p>
            </div>

            <MotionUl
              variants={staggerChildren}
              initial="hidden"
              animate="show"
              className="relative mt-10 space-y-4"
            >
              {FEATURES.map((feature) => {
                const Icon = feature.icon;
                return (
                  <MotionLi key={feature.title} variants={listItem} className="flex items-start gap-3">
                    <span className="mt-0.5 grid size-10 shrink-0 place-items-center rounded-xl bg-white/15 text-white backdrop-blur">
                      <Icon size={18} />
                    </span>
                    <div>
                      <p className="font-semibold text-white">{feature.title}</p>
                      <p className="text-sm leading-snug text-white/70">{feature.text}</p>
                    </div>
                  </MotionLi>
                );
              })}
            </MotionUl>

            <p className="relative mt-auto pt-10 text-xs text-white/55">
              Kwame Nkrumah University of Science &amp; Technology
            </p>
          </div>

          {/* Form panel */}
          <div className="p-6 sm:p-10">
            <div className="mx-auto w-full max-w-sm">
              {/* Mobile brand header */}
              <div className="mb-6 flex items-center gap-3 lg:hidden">
                <span className="grid size-11 place-items-center rounded-2xl bg-gradient-to-br from-brand-600 to-iris-600">
                  <img src={KNUST_LOGO} alt="KNUST" className="size-7 object-contain" />
                </span>
                <div>
                  <p className="text-base font-bold text-slate-900 leading-tight">KNUST Attendance</p>
                  <p className="text-xs text-slate-500">Secure portal access</p>
                </div>
              </div>

              <MotionDiv variants={fadeUp} initial="hidden" animate="show">
                <h1 className="text-2xl font-extrabold tracking-tight text-slate-900 sm:text-3xl">
                  <span className="text-gradient">{title}</span>
                </h1>
                <p className="mt-1.5 text-sm text-slate-500">{subtitle}</p>
              </MotionDiv>

              {!isReset && (
                <SegmentedToggle
                  className="mt-6"
                  value={mode}
                  onChange={switchMode}
                  options={[
                    { value: 'signin', label: 'Sign In' },
                    { value: 'signup', label: 'Sign Up' }
                  ]}
                />
              )}

              <AnimatePresence mode="wait">
                {error && (
                  <MotionDiv
                    key="error"
                    initial={{ opacity: 0, height: 0, marginTop: 0 }}
                    animate={{ opacity: 1, height: 'auto', marginTop: 16 }}
                    exit={{ opacity: 0, height: 0, marginTop: 0 }}
                    className="overflow-hidden"
                  >
                    <div className="flex items-start gap-2.5 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-600">
                      <AlertCircle size={18} className="mt-0.5 shrink-0" />
                      <span>{error}</span>
                    </div>
                  </MotionDiv>
                )}
                {status && (
                  <MotionDiv
                    key="status"
                    initial={{ opacity: 0, height: 0, marginTop: 0 }}
                    animate={{ opacity: 1, height: 'auto', marginTop: 16 }}
                    exit={{ opacity: 0, height: 0, marginTop: 0 }}
                    className="overflow-hidden"
                  >
                    <div className="flex items-start gap-2.5 rounded-2xl border border-grass-200 bg-grass-50 px-4 py-3 text-sm font-medium text-grass-700">
                      <CheckCircle2 size={18} className="mt-0.5 shrink-0" />
                      <span>{status}</span>
                    </div>
                  </MotionDiv>
                )}
              </AnimatePresence>

              <form onSubmit={handleSubmit} className="mt-5 space-y-3">
                {isReset && (
                  <Input
                    icon={Mail}
                    placeholder="Recovery email"
                    required
                    type="email"
                    autoComplete="email"
                    value={data.email}
                    onChange={(e) => setData({ ...data, email: e.target.value })}
                  />
                )}

                {isSignup && (
                  <>
                    <Input
                      icon={User}
                      placeholder="Full name"
                      required
                      autoComplete="name"
                      value={data.name}
                      onChange={(e) => setData({ ...data, name: e.target.value })}
                    />
                    <Input
                      icon={Mail}
                      placeholder="Recovery email"
                      required
                      type="email"
                      autoComplete="email"
                      value={data.email}
                      onChange={(e) => setData({ ...data, email: e.target.value })}
                    />
                  </>
                )}

                {!isReset && (
                  <>
                    <Input
                      icon={IdCard}
                      placeholder={isSignup
                        ? data.role === 'student' ? '8-digit Student ID' : 'Lecturer ID'
                        : 'Email or legacy ID'}
                      required
                      type="text"
                      inputMode={isSignup && data.role === 'student' ? 'numeric' : 'text'}
                      autoComplete="username"
                      value={data.id}
                      onChange={(e) => setData({ ...data, id: e.target.value })}
                    />

                    <PasswordField
                      placeholder="Password"
                      autoComplete={isSignup ? 'new-password' : 'current-password'}
                      value={data.password}
                      onChange={(e) => setData({ ...data, password: e.target.value })}
                    />

                    {isSignup && (
                      <PasswordField
                        placeholder="Confirm password"
                        autoComplete="new-password"
                        value={data.confirmPassword}
                        onChange={(e) => setData({ ...data, confirmPassword: e.target.value })}
                      />
                    )}

                    <div className="pt-1">
                      <SegmentedToggle
                        value={data.role}
                        onChange={(role) => { setData({ ...data, role }); setError(''); }}
                        options={[
                          { value: 'student', label: 'Student', icon: <GraduationCap size={16} /> },
                          { value: 'lecturer', label: 'Lecturer', icon: <Users size={16} /> }
                        ]}
                      />
                    </div>
                  </>
                )}

                <Button
                  type="submit"
                  size="lg"
                  fullWidth
                  isLoading={isSubmitting}
                  className="mt-2"
                >
                  {isSubmitting
                    ? 'Please wait…'
                    : isReset ? 'Send reset link' : isSignup ? 'Create account' : 'Sign in'}
                  {!isSubmitting && <ArrowRight size={18} />}
                </Button>

                <button
                  type="button"
                  onClick={() => switchMode(isReset ? 'signin' : 'reset')}
                  className="mx-auto block pt-2 text-sm font-semibold text-brand-700 transition-colors hover:text-iris-600"
                >
                  {isReset ? 'Back to sign in' : 'Forgot password?'}
                </button>
              </form>
            </div>
          </div>
        </div>
      </MotionDiv>
    </div>
  );
}
