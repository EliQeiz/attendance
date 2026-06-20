import React, { useState } from 'react';
import { motion } from 'framer-motion';
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

const MotionDiv = motion.div;
const STUDENT_ID_PATTERN = /^\d{8}$/;
const STRONG_PASSWORD_PATTERN = /^(?=.*[A-Za-z])(?=.*\d).{8,}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

  return (
    <div className="knust-login-page">
      <MotionDiv
        className="login-glass-card"
        initial={{ opacity: 0, y: 18, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.45, ease: 'easeOut' }}
      >
        <img
          src="https://images.seeklogo.com/logo-png/35/2/kwame-nkrumah-university-of-science-technology-logo-png_seeklogo-350387.png"
          alt="KNUST Logo"
          style={{ width: '80px', height: 'auto', marginBottom: '15px' }}
        />
        <h1 style={{color: '#003366', fontSize: '1.5rem'}}>KNUST Attendance</h1>
        <p style={{color: '#64748b', marginBottom: '20px'}}>{isReset ? 'Recover Your Account' : 'Secure Portal Access'}</p>

        {!isReset && (
          <div className="auth-mode-toggle" style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '16px'}}>
            <button
              type="button"
              className={mode === 'signin' ? 'active' : ''}
              onClick={() => { setMode('signin'); setError(''); setStatus(''); }}
            >
              Sign In
            </button>
            <button
              type="button"
              className={mode === 'signup' ? 'active' : ''}
              onClick={() => { setMode('signup'); setError(''); setStatus(''); }}
            >
              Sign Up
            </button>
          </div>
        )}

        {error && (
          <div style={{
            background: '#fee2e2',
            color: '#dc2626',
            padding: '10px',
            borderRadius: '8px',
            marginBottom: '15px',
            fontSize: '0.85rem',
            border: '1px solid #fecaca',
            textAlign: 'center',
            fontWeight: '500'
          }}>
            {error}
          </div>
        )}

        {status && (
          <div style={{
            background: '#dcfce7',
            color: '#166534',
            padding: '10px',
            borderRadius: '8px',
            marginBottom: '15px',
            fontSize: '0.85rem',
            border: '1px solid #bbf7d0',
            textAlign: 'center',
            fontWeight: '500'
          }}>
            {status}
          </div>
        )}

        <form onSubmit={handleSubmit} className="login-form">
          {isReset && (
            <input
              placeholder="Recovery Email"
              required
              type="email"
              autoComplete="email"
              value={data.email}
              onChange={e => setData({...data, email: e.target.value})}
            />
          )}

          {isSignup && (
            <>
              <input
                placeholder="Full Name"
                required
                autoComplete="name"
                value={data.name}
                onChange={e => setData({...data, name: e.target.value})}
              />
              <input
                placeholder="Recovery Email"
                required
                type="email"
                autoComplete="email"
                value={data.email}
                onChange={e => setData({...data, email: e.target.value})}
              />
            </>
          )}

          {!isReset && (
            <>
              <input
                placeholder={isSignup
                  ? data.role === 'student' ? '8-digit Student ID' : 'Lecturer ID'
                  : 'Email or legacy ID'}
                required
                type="text"
                inputMode={isSignup && data.role === 'student' ? 'numeric' : 'text'}
                autoComplete={isSignup ? 'username' : 'username'}
                value={data.id}
                onChange={e => setData({...data, id: e.target.value})}
              />

              <input
                placeholder="Password"
                required
                type="password"
                autoComplete={isSignup ? 'new-password' : 'current-password'}
                value={data.password}
                onChange={e => setData({...data, password: e.target.value})}
              />

              {isSignup && (
                <input
                  placeholder="Confirm Password"
                  required
                  type="password"
                  autoComplete="new-password"
                  value={data.confirmPassword}
                  onChange={e => setData({...data, confirmPassword: e.target.value})}
                />
              )}

              <div className="role-toggle">
                <button
                  type="button"
                  className={data.role === 'student' ? 'active' : ''}
                  onClick={() => { setData({...data, role: 'student'}); setError(''); }}>
                  Student
                </button>
                <button
                  type="button"
                  className={data.role === 'lecturer' ? 'active' : ''}
                  onClick={() => { setData({...data, role: 'lecturer'}); setError(''); }}>
                  Lecturer
                </button>
              </div>
            </>
          )}

          <button
            type="submit"
            className="login-btn-final"
            disabled={isSubmitting}
            style={{
              width: '100%',
              padding: '14px',
              background: '#006837',
              color: 'white',
              border: 'none',
              borderRadius: '12px',
              fontWeight: 'bold',
              cursor: isSubmitting ? 'not-allowed' : 'pointer',
              marginTop: '10px',
              opacity: isSubmitting ? 0.75 : 1
            }}
          >
            {isSubmitting ? 'Please Wait...' : isReset ? 'Send Reset Link' : isSignup ? 'Create Account' : 'Sign In'}
          </button>

          <button
            type="button"
            onClick={() => {
              setMode(isReset ? 'signin' : 'reset');
              setError('');
              setStatus('');
            }}
            style={{background: 'none', border: 'none', color: '#003366', cursor: 'pointer', marginTop: '12px', fontWeight: 700}}
          >
            {isReset ? 'Back to Sign In' : 'Forgot Password?'}
          </button>
        </form>
      </MotionDiv>
    </div>
  );
}
