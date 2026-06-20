import React, { useEffect, useMemo, useState } from 'react';
import { QRCodeCanvas } from 'qrcode.react';
import { motion } from 'framer-motion';
import { AlertCircle, CheckCircle, KeyRound, LogOut, MapPin, QrCode } from 'lucide-react';
import { db, functions } from '../firebase';
import {
  collection,
  doc,
  onSnapshot,
  query,
  where
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { getRefinedPosition, requireUsableGpsAccuracy } from '../utils/geolocation';

const MotionDiv = motion.div;
const LOCATION_THRESHOLD_METERS = 100;
const QR_REFRESH_MS = 60 * 1000;
const formatCountdown = (seconds = 0) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

const createDeviceKey = () => {
  const browserCrypto = globalThis.crypto;

  if (browserCrypto?.randomUUID) {
    return browserCrypto.randomUUID();
  }

  if (!browserCrypto?.getRandomValues) {
    return `knust-device-${Date.now()}-${performance.now().toString().replace('.', '')}`;
  }

  const entropy = new Uint32Array(4);
  browserCrypto.getRandomValues(entropy);
  return Array.from(entropy, value => value.toString(16).padStart(8, '0')).join('-');
};

const getBrowserDeviceKey = () => {
  const existingKey = localStorage.getItem('knustDeviceKey');
  if (existingKey) return existingKey;

  const nextKey = createDeviceKey();
  localStorage.setItem('knustDeviceKey', nextKey);
  return nextKey;
};

export default function StudentDashboard({ user, onLogout }) {
  const [sessions, setSessions] = useState([]);
  const [selectedSessionKey, setSelectedSessionKey] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [isVerifying, setIsVerifying] = useState(false);
  const [verifiedSessionKey, setVerifiedSessionKey] = useState('');
  const [existingVerification, setExistingVerification] = useState(null);
  const [pinInput, setPinInput] = useState('');
  const [qrIssuedAtMs, setQrIssuedAtMs] = useState(() => Date.now());
  const [pinSecondsRemaining, setPinSecondsRemaining] = useState(0);

  useEffect(() => {
    const activeSessionsQuery = query(collection(db, 'attendance'), where('active', '==', true));

    const unsubscribe = onSnapshot(activeSessionsQuery, (snapshot) => {
      const pinSessions = snapshot.docs
        .map(sessionDoc => ({ id: sessionDoc.id, ...sessionDoc.data() }))
        .filter(session => session.method === 'PIN_GPS');

      setSessions(pinSessions);

      if (!selectedSessionKey && pinSessions.length === 1) {
        setSelectedSessionKey(pinSessions[0].id);
      }

      if (selectedSessionKey && !pinSessions.some(session => session.id === selectedSessionKey)) {
        setSelectedSessionKey('');
      }
    });

    return () => unsubscribe();
  }, [selectedSessionKey]);

  const selectedSession = useMemo(() => (
    sessions.find(session => session.id === selectedSessionKey) || sessions[0] || null
  ), [sessions, selectedSessionKey]);
  const studentId = user.knust_id || user.id;
  const qrValue = useMemo(() => (
    selectedSession
      ? JSON.stringify({
          type: 'KNUST_ATTENDANCE',
          studentID: studentId,
          fullName: user.name,
          sessionKey: selectedSession.id,
          courseCode: selectedSession.courseCode,
          week: selectedSession.weekNumber,
          issuedAtMs: qrIssuedAtMs
        })
      : ''
  ), [qrIssuedAtMs, selectedSession, studentId, user.name]);
  const isAlreadyVerified = Boolean(selectedSession && existingVerification?.sessionKey === selectedSession.id);

  useEffect(() => {
    setQrIssuedAtMs(Date.now());
    const qrRefreshTimer = window.setInterval(() => setQrIssuedAtMs(Date.now()), QR_REFRESH_MS);

    return () => window.clearInterval(qrRefreshTimer);
  }, [selectedSession?.id]);

  useEffect(() => {
    if (!selectedSession?.pinExpiresAtMs) {
      setPinSecondsRemaining(0);
      return;
    }

    const updateCountdown = () => {
      setPinSecondsRemaining(Math.max(0, Math.ceil((selectedSession.pinExpiresAtMs - Date.now()) / 1000)));
    };
    updateCountdown();
    const countdownTimer = window.setInterval(updateCountdown, 1000);

    return () => window.clearInterval(countdownTimer);
  }, [selectedSession?.pinExpiresAtMs]);

  useEffect(() => {
    if (!selectedSession || !studentId) {
      setExistingVerification(null);
      return;
    }

    const recordRef = doc(db, 'attendance', selectedSession.id, 'records', studentId);
    const unsubscribe = onSnapshot(recordRef, (snapshot) => {
      if (!snapshot.exists()) {
        setExistingVerification(null);
        return;
      }

      const record = snapshot.data();
      setExistingVerification(record);
      setVerifiedSessionKey(selectedSession.id);
      setStatus(`You are verified for ${selectedSession.courseCode || selectedSession.originalCourseCode}.`);
    });

    return () => unsubscribe();
  }, [selectedSession, studentId]);

  const verifyPresence = async () => {
    setError('');
    setStatus('');
    setVerifiedSessionKey('');
    const submittedPin = pinInput.trim();

    if (!selectedSession) {
      setError('No active PIN attendance session is available right now.');
      return;
    }

    if (!/^\d{4}$/.test(submittedPin)) {
      setError('Enter the current 4-digit PIN displayed by the lecturer.');
      return;
    }

    if (!navigator.geolocation) {
      setError('This browser does not support GPS location. Please use a GPS-enabled browser.');
      return;
    }

    const deviceKey = getBrowserDeviceKey();
    setIsVerifying(true);
    setStatus('Checking PIN and location...');

    try {
      const position = requireUsableGpsAccuracy(await getRefinedPosition());
      const submitAttendance = httpsCallable(functions, 'submitAttendance');

      const { data } = await submitAttendance({
        sessionKey: selectedSession.id,
        pin: submittedPin,
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracy: Math.round(position.coords.accuracy),
        deviceKey
      });

      const courseLabel = selectedSession.courseCode || selectedSession.originalCourseCode;
      setVerifiedSessionKey(selectedSession.id);

      if (data?.status === 'already-verified') {
        setStatus(`You are already verified for ${courseLabel}.`);
        return;
      }

      setPinInput('');
      const distanceText = Number.isFinite(data?.distanceMeters) ? ` Distance: ${data.distanceMeters}m.` : '';
      setStatus(`Presence verified for ${courseLabel}.${distanceText}`);
    } catch (verificationError) {
      const message = verificationError?.code === 1
        ? 'Location permission is required to verify attendance.'
        : verificationError?.message || 'PIN + GPS verification failed. Please try again.';
      setError(message);
      setStatus('');
    } finally {
      setIsVerifying(false);
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
          style={{ width: '60px', height: 'auto', marginBottom: '15px' }}
        />

        <h2 style={{color: '#003366', fontSize: '1.4rem', marginBottom: '5px'}}>
          Welcome, {user.name}
        </h2>
        <p style={{color: '#64748b', marginBottom: '18px'}}>ID: {studentId}</p>

        <div style={{
          margin: '20px 0',
          padding: '20px',
          background: 'rgba(255,255,255,0.95)',
          borderRadius: '16px',
          border: '1px solid #e2e8f0',
          boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
          textAlign: 'left'
        }}>
          <div style={{display: 'flex', gap: '12px', alignItems: 'center', marginBottom: '14px'}}>
            <KeyRound size={30} color="#003366" />
            <div>
              <h3 style={{color: '#003366', fontSize: '1rem', margin: 0}}>PIN + GPS Presence</h3>
              <p style={{color: '#64748b', fontSize: '0.8rem', margin: 0}}>Enter the lecturer's current 4-digit PIN.</p>
            </div>
          </div>

          {sessions.length > 1 && (
            <select
              value={selectedSession?.id || ''}
              onChange={(e) => setSelectedSessionKey(e.target.value)}
              className="week-dropdown"
              style={{width: '100%', marginBottom: '12px'}}
            >
              {sessions.map(session => (
                <option key={session.id} value={session.id}>
                  {session.originalCourseCode || session.courseCode} - Week {session.weekNumber}
                </option>
              ))}
            </select>
          )}

          <div style={{
            padding: '12px',
            borderRadius: '12px',
            background: sessions.length ? '#f0fdf4' : '#f8fafc',
            color: sessions.length ? '#166534' : '#64748b',
            border: sessions.length ? '1px solid #bbf7d0' : '1px solid #e2e8f0',
            fontSize: '0.85rem',
            fontWeight: 600
          }}>
            {selectedSession
              ? `${selectedSession.originalCourseCode || selectedSession.courseCode} Week ${selectedSession.weekNumber}: next PIN in ${formatCountdown(pinSecondsRemaining)}`
              : 'Waiting for a lecturer to start a PIN session.'}
          </div>

          <p style={{color: '#64748b', fontSize: '0.8rem', margin: '12px 0 0'}}>
            Location threshold: <strong>{selectedSession?.locationThresholdMeters || LOCATION_THRESHOLD_METERS}m</strong>
          </p>
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
            fontWeight: '500',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px'
          }}>
            <AlertCircle size={16} /> {error}
          </div>
        )}

        {status && (
          <div style={{
            background: verifiedSessionKey ? '#dcfce7' : '#eff6ff',
            color: verifiedSessionKey ? '#166534' : '#1d4ed8',
            padding: '10px',
            borderRadius: '8px',
            marginBottom: '15px',
            fontSize: '0.85rem',
            border: verifiedSessionKey ? '1px solid #bbf7d0' : '1px solid #bfdbfe',
            textAlign: 'center',
            fontWeight: '500',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px'
          }}>
            {verifiedSessionKey ? <CheckCircle size={16} /> : <MapPin size={16} />} {status}
          </div>
        )}

        {selectedSession && !isAlreadyVerified && (
          <div style={{
            margin: '18px 0',
            padding: '16px',
            background: '#ffffff',
            borderRadius: '16px',
            border: '1px solid #e2e8f0',
            boxShadow: '0 4px 12px rgba(0,0,0,0.08)'
          }}>
            <input
              placeholder="4-digit PIN"
              inputMode="numeric"
              maxLength={4}
              value={pinInput}
              onChange={(event) => setPinInput(event.target.value.replace(/\D/g, '').slice(0, 4))}
              style={{
                width: '100%',
                textAlign: 'center',
                fontSize: '2rem',
                letterSpacing: '8px',
                fontWeight: 900,
                color: '#003366',
                border: '2px solid #dbeafe',
                borderRadius: '14px',
                padding: '12px',
                outline: 'none'
              }}
            />
          </div>
        )}

        {selectedSession && (
          <div style={{
            margin: '18px 0',
            padding: '16px',
            background: '#ffffff',
            borderRadius: '16px',
            border: '1px solid #e2e8f0',
            boxShadow: '0 4px 12px rgba(0,0,0,0.08)'
          }}>
            <div style={{display: 'flex', gap: '10px', alignItems: 'center', justifyContent: 'center', marginBottom: '12px', color: '#003366', fontWeight: 800}}>
              <QrCode size={18} /> QR Backup
            </div>
            <p style={{color: '#64748b', fontSize: '0.78rem', margin: '0 0 10px', textAlign: 'center'}}>
              Show this rotating fallback code to the lecturer if PIN + GPS verification is unavailable.
            </p>
            <QRCodeCanvas
              value={qrValue}
              size={180}
              level="H"
              includeMargin
            />
          </div>
        )}

        <button
          onClick={verifyPresence}
          className="login-btn-final"
          disabled={!selectedSession || isVerifying || isAlreadyVerified}
          style={{
            background: '#006837',
            width: '100%',
            padding: '14px',
            borderRadius: '12px',
            color: 'white',
            border: 'none',
            cursor: !selectedSession || isVerifying || isAlreadyVerified ? 'not-allowed' : 'pointer',
            opacity: !selectedSession || isVerifying || isAlreadyVerified ? 0.7 : 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px'
          }}
        >
          {isAlreadyVerified ? <CheckCircle size={18} /> : <MapPin size={18} />}
          {isAlreadyVerified ? 'Already Verified' : isVerifying ? 'Verifying...' : 'Submit PIN + Verify Location'}
        </button>

        <button
          onClick={onLogout}
          className="login-btn-final"
          style={{background: '#64748b', width: '100%', padding: '12px', borderRadius: '10px', color: 'white', border: 'none', cursor: 'pointer', marginTop: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px'}}
        >
          <LogOut size={16} /> Logout
        </button>
      </MotionDiv>
    </div>
  );
}
