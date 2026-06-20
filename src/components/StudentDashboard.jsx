import React, { useEffect, useMemo, useState } from 'react';
import { QRCodeCanvas } from 'qrcode.react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertCircle,
  CheckCircle2,
  Clock3,
  KeyRound,
  LogOut,
  MapPin,
  QrCode,
  ShieldCheck
} from 'lucide-react';
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
import Button from './ui/Button';
import Card from './ui/Card';
import { cn } from '../lib/cn';
import { fadeUp, popIn, staggerChildren } from '../lib/motion';

const MotionDiv = motion.div;
const MotionSection = motion.section;
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

  const thresholdMeters = selectedSession?.locationThresholdMeters || LOCATION_THRESHOLD_METERS;
  const pinDigits = pinInput.padEnd(4, ' ').slice(0, 4).split('');

  return (
    <div className="aurora-bg min-h-dvh px-4 py-8 sm:px-6 sm:py-10">
      <MotionSection
        variants={staggerChildren}
        initial="hidden"
        animate="show"
        className="mx-auto w-full max-w-4xl"
      >
        {/* Header */}
        <MotionDiv variants={fadeUp} className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <img
              src="https://images.seeklogo.com/logo-png/35/2/kwame-nkrumah-university-of-science-technology-logo-png_seeklogo-350387.png"
              alt="KNUST Logo"
              className="size-12 rounded-2xl bg-white/70 p-1.5 shadow-[var(--shadow-card)]"
            />
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-brand-700/70">
                Student presence
              </p>
              <h1 className="text-lg font-bold leading-tight text-slate-800 sm:text-xl">
                Welcome, <span className="text-gradient">{user.name}</span>
              </h1>
              <p className="text-sm text-slate-500">ID: {studentId}</p>
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={onLogout} className="shrink-0">
            <LogOut size={16} /> Logout
          </Button>
        </MotionDiv>

        {/* Alerts */}
        <AnimatePresence initial={false}>
          {error && (
            <MotionDiv
              key="error"
              initial={{ opacity: 0, height: 0, marginBottom: 0 }}
              animate={{ opacity: 1, height: 'auto', marginBottom: 16 }}
              exit={{ opacity: 0, height: 0, marginBottom: 0 }}
              transition={{ duration: 0.3 }}
              className="overflow-hidden"
            >
              <div className="flex items-center gap-2.5 rounded-2xl border border-rose-200 bg-rose-50/90 px-4 py-3 text-sm font-medium text-rose-700">
                <AlertCircle size={18} className="shrink-0" /> {error}
              </div>
            </MotionDiv>
          )}
          {status && (
            <MotionDiv
              key="status"
              initial={{ opacity: 0, height: 0, marginBottom: 0 }}
              animate={{ opacity: 1, height: 'auto', marginBottom: 16 }}
              exit={{ opacity: 0, height: 0, marginBottom: 0 }}
              transition={{ duration: 0.3 }}
              className="overflow-hidden"
            >
              <div
                className={cn(
                  'flex items-center gap-2.5 rounded-2xl border px-4 py-3 text-sm font-medium',
                  verifiedSessionKey
                    ? 'border-grass-200 bg-grass-50/90 text-grass-700'
                    : 'border-brand-200 bg-brand-50/90 text-brand-700'
                )}
              >
                {verifiedSessionKey ? <CheckCircle2 size={18} className="shrink-0" /> : <MapPin size={18} className="shrink-0" />}
                {status}
              </div>
            </MotionDiv>
          )}
        </AnimatePresence>

        <div className="grid gap-5 lg:grid-cols-5">
          {/* Main PIN panel */}
          <MotionDiv variants={popIn} className="lg:col-span-3">
            <Card className="p-6 sm:p-7">
              <div className="mb-5 flex items-start gap-3">
                <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-brand-600 via-iris-600 to-grass-600 text-white shadow-[var(--shadow-glow)]">
                  <KeyRound size={20} />
                </span>
                <div>
                  <h2 className="text-base font-bold text-slate-800">PIN + GPS Presence</h2>
                  <p className="text-sm text-slate-500">Enter the lecturer's current 4-digit PIN.</p>
                </div>
              </div>

              {sessions.length > 1 && (
                <select
                  value={selectedSession?.id || ''}
                  onChange={(e) => setSelectedSessionKey(e.target.value)}
                  className="mb-4 h-12 w-full rounded-2xl border border-slate-200 bg-white/80 px-4 text-sm font-medium text-slate-700 transition-[border,box-shadow] focus:border-iris-400 focus:outline-none focus:ring-4 focus:ring-iris-500/15"
                >
                  {sessions.map(session => (
                    <option key={session.id} value={session.id}>
                      {session.originalCourseCode || session.courseCode} - Week {session.weekNumber}
                    </option>
                  ))}
                </select>
              )}

              <div
                className={cn(
                  'flex items-center gap-2.5 rounded-2xl border px-4 py-3 text-sm font-semibold',
                  selectedSession
                    ? 'border-grass-200 bg-grass-50/80 text-grass-700'
                    : 'border-slate-200 bg-slate-50/80 text-slate-500'
                )}
              >
                <Clock3 size={16} className="shrink-0" />
                {selectedSession
                  ? `${selectedSession.originalCourseCode || selectedSession.courseCode} Week ${selectedSession.weekNumber}: next PIN in ${formatCountdown(pinSecondsRemaining)}`
                  : 'Waiting for a lecturer to start a PIN session.'}
              </div>

              <p className="mt-3 flex items-center gap-1.5 text-xs text-slate-500">
                <ShieldCheck size={14} className="text-iris-500" />
                Location threshold: <strong className="text-slate-700">{thresholdMeters}m</strong>
              </p>

              {/* PIN entry */}
              {selectedSession && !isAlreadyVerified && (
                <div className="mt-6">
                  <label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Enter PIN
                  </label>
                  <div className="relative">
                    <input
                      aria-label="4-digit PIN"
                      inputMode="numeric"
                      maxLength={4}
                      value={pinInput}
                      onChange={(event) => setPinInput(event.target.value.replace(/\D/g, '').slice(0, 4))}
                      className="absolute inset-0 z-10 h-full w-full cursor-text rounded-2xl opacity-0"
                    />
                    <div className="grid grid-cols-4 gap-3">
                      {pinDigits.map((digit, index) => (
                        <div
                          key={index}
                          className={cn(
                            'grid h-16 place-items-center rounded-2xl border-2 text-3xl font-black text-brand-800 transition-colors duration-200',
                            digit.trim()
                              ? 'border-iris-300 bg-iris-50/60'
                              : 'border-slate-200 bg-white/70',
                            index === pinInput.length && !isVerifying && 'border-iris-400 ring-4 ring-iris-500/15'
                          )}
                        >
                          {digit.trim() || ''}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              <Button
                variant="success"
                size="lg"
                fullWidth
                className="mt-6"
                onClick={verifyPresence}
                disabled={!selectedSession || isVerifying || isAlreadyVerified}
                isLoading={isVerifying}
              >
                {!isVerifying && (isAlreadyVerified ? <CheckCircle2 size={18} /> : <MapPin size={18} />)}
                {isAlreadyVerified ? 'Already Verified' : isVerifying ? 'Verifying…' : 'Submit PIN + Verify Location'}
              </Button>
            </Card>
          </MotionDiv>

          {/* QR backup panel */}
          <MotionDiv variants={popIn} className="lg:col-span-2">
            {selectedSession ? (
              <Card glass className="flex h-full flex-col items-center p-6 text-center sm:p-7">
                <div className="mb-2 flex items-center gap-2 font-bold text-brand-800">
                  <QrCode size={18} /> QR Backup
                </div>
                <p className="mb-5 text-xs text-slate-500">
                  Show this rotating fallback code to the lecturer if PIN + GPS verification is unavailable.
                </p>
                <div className="rounded-3xl bg-white p-4 shadow-[var(--shadow-card)]">
                  <QRCodeCanvas value={qrValue} size={180} level="H" includeMargin />
                </div>
                <p className="mt-4 text-[0.7rem] font-medium uppercase tracking-wide text-slate-400">
                  Refreshes every minute
                </p>
              </Card>
            ) : (
              <Card glass className="grid h-full place-items-center p-8 text-center">
                <div className="text-slate-400">
                  <QrCode size={40} className="mx-auto mb-3 opacity-40" />
                  <p className="text-sm font-medium">QR backup appears once a session is active.</p>
                </div>
              </Card>
            )}
          </MotionDiv>
        </div>
      </MotionSection>
    </div>
  );
}
