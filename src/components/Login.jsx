import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { auth, db } from '../firebase';
import {
  browserLocalPersistence,
  createUserWithEmailAndPassword,
  setPersistence,
  signInWithEmailAndPassword
} from 'firebase/auth';
import { doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore';

const MotionDiv = motion.div;
const STUDENT_ID_PATTERN = /^\d{8}$/;
const STRONG_PASSWORD_PATTERN = /^(?=.*[A-Za-z])(?=.*\d).{8,}$/;

const buildAuthEmail = (role, id) => {
  const safeId = id.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  return `${role}.${safeId}@knust-attendance.local`;
};

const getAuthMessage = (err) => {
  if (err?.code === 'auth/email-already-in-use') {
    return 'This account already exists. Switch to Sign In.';
  }

  if (err?.code === 'auth/invalid-credential' || err?.code === 'auth/user-not-found' || err?.code === 'auth/wrong-password') {
    return 'Invalid ID, role, or password.';
  }

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
    password: ''
  });
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isSignup = mode === 'signup';

  const validate = () => {
    const knustId = data.id.trim();

    if (data.role === 'student' && !STUDENT_ID_PATTERN.test(knustId)) {
      return 'Student KNUST ID must be exactly 8 digits.';
    }

    if (isSignup && !data.name.trim()) {
      return 'Full name is required for sign up.';
    }

    if (isSignup && !STRONG_PASSWORD_PATTERN.test(data.password)) {
      return 'Password must be at least 8 characters and include a letter and a number.';
    }

    return '';
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    const validationMessage = validate();
    if (validationMessage) {
      setError(validationMessage);
      return;
    }

    const knustId = data.id.trim();
    const authEmail = buildAuthEmail(data.role, knustId);
    setIsSubmitting(true);

    try {
      await setPersistence(auth, browserLocalPersistence);

      const credential = isSignup
        ? await createUserWithEmailAndPassword(auth, authEmail, data.password)
        : await signInWithEmailAndPassword(auth, authEmail, data.password);

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
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        };

        await setDoc(profileRef, profile, { merge: true });

        onLogin({
          uid,
          id: data.role === 'lecturer' ? uid : knustId,
          knust_id: knustId,
          name: profile.name,
          role: data.role,
          email: authEmail
        });
        return;
      }

      if (!profileSnap.exists()) {
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
        email: profile.email || authEmail
      });
    } catch (err) {
      console.error(`${isSignup ? 'Sign up' : 'Sign in'} failed:`, err);
      setError(getAuthMessage(err));
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
        <p style={{color: '#64748b', marginBottom: '20px'}}>Secure Portal Access</p>

        <div className="auth-mode-toggle" style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '16px'}}>
          <button
            type="button"
            className={mode === 'signin' ? 'active' : ''}
            onClick={() => { setMode('signin'); setError(''); }}
          >
            Sign In
          </button>
          <button
            type="button"
            className={mode === 'signup' ? 'active' : ''}
            onClick={() => { setMode('signup'); setError(''); }}
          >
            Sign Up
          </button>
        </div>

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

        <form onSubmit={handleSubmit} className="login-form">
          {isSignup && (
            <input
              placeholder="Full Name"
              required
              value={data.name}
              onChange={e => setData({...data, name: e.target.value})}
            />
          )}

          <input
            placeholder={data.role === 'student' ? '8-digit Student ID' : 'Lecturer ID'}
            required
            type="text"
            inputMode={data.role === 'student' ? 'numeric' : 'text'}
            value={data.id}
            onChange={e => setData({...data, id: e.target.value})}
          />

          <input
            placeholder="Password"
            required
            type="password"
            value={data.password}
            onChange={e => setData({...data, password: e.target.value})}
          />

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
            {isSubmitting ? 'Please Wait...' : isSignup ? 'Create Account' : 'Sign In'}
          </button>
        </form>
      </MotionDiv>
    </div>
  );
}
