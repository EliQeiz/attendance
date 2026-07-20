import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { AlertCircle, CheckCircle, Clock, LogOut, MapPin, QrCode, ShieldCheck } from 'lucide-react';
import { db, functions } from '../firebase';
import {
  collection,
  doc,
  onSnapshot,
  query,
  where
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import Scanner from './Scanner';
import { getRefinedPosition, requireUsableGpsAccuracy } from '../utils/geolocation';

const MotionDiv = motion.div;
const LOCATION_THRESHOLD_METERS = 150;

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

const parseLecturerQrPayload = (decodedText) => {
  let payload;

  try {
    payload = JSON.parse(decodedText);
  } catch {
    throw new Error('This is not a valid KNUST lecturer attendance QR code.');
  }

  if (
    payload?.type !== 'KNUST_LECTURER_SESSION' ||
    typeof payload.sessionKey !== 'string' ||
    typeof payload.sessionCode !== 'string'
  ) {
    throw new Error('Scan the QR code projected by the lecturer for this active class.');
  }

  return {
    sessionKey: payload.sessionKey.trim(),
    sessionCode: payload.sessionCode.trim(),
    courseCode: payload.originalCourseCode || payload.courseCode || 'Course',
    weekNumber: payload.weekNumber || ''
  };
};

const getRecordStatusTheme = (status) => {
  if (status === 'Verified') {
    return {
      background: '#dcfce7',
      color: '#166534',
      border: '1px solid #bbf7d0',
      icon: <CheckCircle size={16} />
    };
  }

  if (status === 'Pending') {
    return {
      background: '#fffbeb',
      color: '#92400e',
      border: '1px solid #fde68a',
      icon: <Clock size={16} />
    };
  }

  return {
    background: '#fee2e2',
    color: '#991b1b',
    border: '1px solid #fecaca',
    icon: <AlertCircle size={16} />
  };
};

const formatMethodLabel = (method = '') => ({
  QR_GPS: 'QR + GPS',
  QR_SCAN_PENDING: 'QR Scan Pending',
  LECTURER_APPROVED_SCAN: 'Lecturer Approved',
  LECTURER_DENIED_SCAN: 'Lecturer Denied',
  LECTURER_MANUAL: 'Lecturer Manual'
}[method] || method || 'QR Attendance');

export default function StudentDashboard({ user, onLogout }) {
  const [activeSessions, setActiveSessions] = useState([]);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [isVerifying, setIsVerifying] = useState(false);
  const [scannerMode, setScannerMode] = useState('gps');
  const [isScannerOpen, setIsScannerOpen] = useState(false);
  const [scannedSession, setScannedSession] = useState(null);
  const [recordSessionKey, setRecordSessionKey] = useState('');
  const [currentRecord, setCurrentRecord] = useState(null);
  const [studentHistory, setStudentHistory] = useState([]);
  const [studentSummary, setStudentSummary] = useState({ verified: 0, pending: 0, denied: 0, total: 0, courses: [] });
  const [isHistoryLoading, setIsHistoryLoading] = useState(false);
  const studentId = user.knust_id || user.id;

  const loadStudentHistory = useCallback(async () => {
    setIsHistoryLoading(true);

    try {
      const getStudentAttendanceHistory = httpsCallable(functions, 'getStudentAttendanceHistory');
      const { data } = await getStudentAttendanceHistory();
      setStudentHistory(Array.isArray(data?.records) ? data.records : []);
      setStudentSummary(data?.summary || { verified: 0, pending: 0, denied: 0, total: 0, courses: [] });
    } catch (historyError) {
      console.error('Student history load failed:', historyError);
    } finally {
      setIsHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStudentHistory();
  }, [loadStudentHistory]);

  useEffect(() => {
    const activeSessionsQuery = query(collection(db, 'attendance'), where('active', '==', true));

    const unsubscribe = onSnapshot(activeSessionsQuery, (snapshot) => {
      const qrSessions = snapshot.docs
        .map(sessionDoc => ({ id: sessionDoc.id, ...sessionDoc.data() }))
        .filter(session => session.method === 'LECTURER_QR');

      setActiveSessions(qrSessions);
    });

    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!recordSessionKey || !studentId) {
      setCurrentRecord(null);
      return;
    }

    const recordRef = doc(db, 'attendance', recordSessionKey, 'records', studentId);
    const unsubscribe = onSnapshot(recordRef, (snapshot) => {
      setCurrentRecord(snapshot.exists() ? snapshot.data() : null);
    });

    return () => unsubscribe();
  }, [recordSessionKey, studentId]);

  const latestCourseLabel = useMemo(() => {
    if (scannedSession) {
      return `${scannedSession.courseCode}${scannedSession.weekNumber ? ` Week ${scannedSession.weekNumber}` : ''}`;
    }

    if (activeSessions.length === 1) {
      const session = activeSessions[0];
      return `${session.originalCourseCode || session.courseCode} Week ${session.weekNumber}`;
    }

    return '';
  }, [activeSessions, scannedSession]);

  const openScanner = (mode) => {
    setScannerMode(mode);
    setIsScannerOpen(true);
    setError('');
    setStatus(mode === 'gps'
      ? 'Scan the lecturer QR code. Your GPS will be checked silently after scanning.'
      : 'Scan the lecturer QR code. Your attendance will wait for lecturer confirmation.'
    );
  };

  const submitScannedAttendance = async (decodedText) => {
    setError('');
    setStatus('');
    setCurrentRecord(null);
    setIsVerifying(true);

    try {
      const lecturerSession = parseLecturerQrPayload(decodedText);
      const requestPayload = {
        sessionKey: lecturerSession.sessionKey,
        sessionCode: lecturerSession.sessionCode,
        mode: scannerMode,
        deviceKey: getBrowserDeviceKey()
      };

      setScannedSession(lecturerSession);
      setRecordSessionKey(lecturerSession.sessionKey);

      if (scannerMode === 'gps') {
        if (!navigator.geolocation) {
          throw new Error('This browser does not support GPS. Use scan-only and wait for lecturer approval.');
        }

        setStatus('QR scanned. Refining your GPS position...');
        const position = requireUsableGpsAccuracy(await getRefinedPosition());
        requestPayload.latitude = position.coords.latitude;
        requestPayload.longitude = position.coords.longitude;
        requestPayload.accuracy = Math.round(position.coords.accuracy);
      } else {
        setStatus('QR scanned. Submitting for lecturer approval...');
      }

      const submitAttendance = httpsCallable(functions, 'submitAttendance');
      const { data } = await submitAttendance(requestPayload);
      const courseLabel = `${lecturerSession.courseCode}${lecturerSession.weekNumber ? ` Week ${lecturerSession.weekNumber}` : ''}`;

      if (data?.status === 'verified') {
        const distanceText = Number.isFinite(data?.distanceMeters) ? ` Distance: ${data.distanceMeters}m.` : '';
        setStatus(`Presence verified for ${courseLabel}.${distanceText}`);
      } else if (data?.status === 'pending') {
        setStatus(`QR scan recorded for ${courseLabel}. Waiting for lecturer approval.`);
      } else if (data?.status === 'denied') {
        setError('This attendance request was denied by the lecturer.');
        setStatus('');
      } else {
        setStatus(`Attendance scan received for ${courseLabel}.`);
      }

      await loadStudentHistory();
    } catch (verificationError) {
      const message = verificationError?.code === 1
        ? 'Location permission is required for GPS verification. Use scan-only if your lecturer permits it.'
        : verificationError?.message || 'QR verification failed. Please try again.';
      setError(message);
      setStatus('');
    } finally {
      setIsVerifying(false);
      setIsScannerOpen(false);
    }
  };

  const statusTheme = currentRecord ? getRecordStatusTheme(currentRecord.status || 'Verified') : null;

  return (
    <div className="knust-login-page">
      <MotionDiv
        className="login-glass-card student-suite-card"
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
            <QrCode size={30} color="#003366" />
            <div>
              <h3 style={{color: '#003366', fontSize: '1rem', margin: 0}}>Lecturer QR Attendance</h3>
              <p style={{color: '#64748b', fontSize: '0.8rem', margin: 0}}>Scan the projected lecturer QR code to verify this class.</p>
            </div>
          </div>

          <div className="student-status-grid">
            <div style={{padding: '12px', borderRadius: '12px', background: activeSessions.length ? '#f0fdf4' : '#f8fafc', border: activeSessions.length ? '1px solid #bbf7d0' : '1px solid #e2e8f0'}}>
              <p style={{fontSize: '0.72rem', color: '#64748b', fontWeight: 800, textTransform: 'uppercase'}}>Active QR Sessions</p>
              <strong style={{color: activeSessions.length ? '#166534' : '#64748b', fontSize: '1.4rem'}}>{activeSessions.length}</strong>
            </div>
            <div style={{padding: '12px', borderRadius: '12px', background: '#eff6ff', border: '1px solid #bfdbfe'}}>
              <p style={{fontSize: '0.72rem', color: '#64748b', fontWeight: 800, textTransform: 'uppercase'}}>GPS Radius</p>
              <strong style={{color: '#003366', fontSize: '1.4rem'}}>{LOCATION_THRESHOLD_METERS}m</strong>
            </div>
          </div>

          <p style={{color: '#64748b', fontSize: '0.82rem', margin: '14px 0 0', lineHeight: 1.5}}>
            GPS verification gives immediate confirmation. If your phone blocks location, use scan-only and wait while the lecturer confirms you are in class.
          </p>
        </div>

        {latestCourseLabel && (
          <div style={{
            padding: '12px',
            borderRadius: '12px',
            background: '#f8fafc',
            color: '#003366',
            border: '1px solid #e2e8f0',
            fontSize: '0.85rem',
            fontWeight: 700,
            marginBottom: '15px'
          }}>
            Current context: {latestCourseLabel}
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
            background: status.includes('Waiting') || status.includes('approval') ? '#fffbeb' : '#eff6ff',
            color: status.includes('Waiting') || status.includes('approval') ? '#92400e' : '#1d4ed8',
            padding: '10px',
            borderRadius: '8px',
            marginBottom: '15px',
            fontSize: '0.85rem',
            border: status.includes('Waiting') || status.includes('approval') ? '1px solid #fde68a' : '1px solid #bfdbfe',
            textAlign: 'center',
            fontWeight: '500',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px'
          }}>
            {status.includes('Waiting') || status.includes('approval') ? <Clock size={16} /> : <MapPin size={16} />} {status}
          </div>
        )}

        {currentRecord && statusTheme && (
          <div style={{
            ...statusTheme,
            padding: '12px',
            borderRadius: '12px',
            marginBottom: '16px',
            textAlign: 'left',
            display: 'flex',
            gap: '10px',
            alignItems: 'flex-start'
          }}>
            {statusTheme.icon}
            <div>
              <strong>{currentRecord.status || 'Verified'}</strong>
              <p style={{margin: '4px 0 0', fontSize: '0.82rem'}}>
                {currentRecord.fullName || user.name} - {formatMethodLabel(currentRecord.method)}
                {Number.isFinite(currentRecord.distanceMeters) ? ` - ${currentRecord.distanceMeters}m from lecturer` : ''}
              </p>
            </div>
          </div>
        )}

        <div className="student-action-grid">
          <button
            onClick={() => openScanner('gps')}
            className="login-btn-final"
            disabled={isVerifying}
            style={{
              background: '#006837',
              padding: '14px',
              borderRadius: '12px',
              color: 'white',
              border: 'none',
              cursor: isVerifying ? 'not-allowed' : 'pointer',
              opacity: isVerifying ? 0.7 : 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '8px'
            }}
          >
            <ShieldCheck size={18} />
            {isVerifying && scannerMode === 'gps' ? 'Verifying...' : 'Scan + GPS Verify'}
          </button>

          <button
            onClick={() => openScanner('scan-only')}
            className="login-btn-final"
            disabled={isVerifying}
            style={{
              background: '#003366',
              padding: '14px',
              borderRadius: '12px',
              color: 'white',
              border: 'none',
              cursor: isVerifying ? 'not-allowed' : 'pointer',
              opacity: isVerifying ? 0.7 : 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '8px'
            }}
          >
            <QrCode size={18} />
            {isVerifying && scannerMode === 'scan-only' ? 'Submitting...' : 'Scan Only'}
          </button>
        </div>

        {isScannerOpen && (
          <div style={{
            marginTop: '18px',
            padding: '16px',
            background: '#ffffff',
            borderRadius: '16px',
            border: '1px solid #e2e8f0',
            boxShadow: '0 4px 12px rgba(0,0,0,0.08)'
          }}>
            <div style={{display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', color: '#003366', fontWeight: 800, marginBottom: '12px'}}>
              <QrCode size={18} /> {scannerMode === 'gps' ? 'Scan QR for GPS Verification' : 'Scan QR for Lecturer Approval'}
            </div>
            <Scanner onResult={submitScannedAttendance} onClose={() => setIsScannerOpen(false)} />
          </div>
        )}

        <div style={{
          margin: '18px 0',
          padding: '16px',
          background: 'rgba(255,255,255,0.95)',
          borderRadius: '16px',
          border: '1px solid #e2e8f0',
          boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
          textAlign: 'left'
        }}>
          <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', marginBottom: '12px'}}>
            <div>
              <h3 style={{color: '#003366', fontSize: '1rem', margin: 0}}>My Attendance Ledger</h3>
              <p style={{color: '#64748b', fontSize: '0.8rem', margin: '3px 0 0'}}>Your recorded sessions across courses.</p>
            </div>
            <button
              type="button"
              onClick={loadStudentHistory}
              disabled={isHistoryLoading}
              style={{background: '#f8fafc', color: '#003366', border: '1px solid #dbeafe', borderRadius: '10px', padding: '8px 10px', fontWeight: 800, cursor: isHistoryLoading ? 'not-allowed' : 'pointer'}}
            >
              {isHistoryLoading ? 'Refreshing' : 'Refresh'}
            </button>
          </div>

          <div className="student-status-grid" style={{marginBottom: '12px'}}>
            <div style={{padding: '10px', borderRadius: '12px', background: '#f0fdf4', border: '1px solid #bbf7d0'}}>
              <p style={{fontSize: '0.7rem', color: '#64748b', fontWeight: 800, textTransform: 'uppercase'}}>Verified</p>
              <strong style={{color: '#166534', fontSize: '1.35rem'}}>{studentSummary.verified || 0}</strong>
            </div>
            <div style={{padding: '10px', borderRadius: '12px', background: '#fffbeb', border: '1px solid #fde68a'}}>
              <p style={{fontSize: '0.7rem', color: '#64748b', fontWeight: 800, textTransform: 'uppercase'}}>Pending</p>
              <strong style={{color: '#92400e', fontSize: '1.35rem'}}>{studentSummary.pending || 0}</strong>
            </div>
          </div>

          <div style={{display: 'grid', gap: '8px', maxHeight: '230px', overflowY: 'auto', paddingRight: '2px'}}>
            {studentHistory.slice(0, 8).map((record, index) => {
              const theme = getRecordStatusTheme(record.status || 'Verified');

              return (
                <div key={`${record.sessionKey}-${index}`} style={{display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'center', padding: '10px', borderRadius: '12px', background: '#f8fafc', border: '1px solid #e2e8f0'}}>
                  <div>
                    <strong style={{color: '#003366'}}>{record.courseCode || 'Course'} {record.week ? `Week ${record.week}` : ''}</strong>
                    <p style={{color: '#64748b', fontSize: '0.78rem', margin: '3px 0 0'}}>{record.dateTime || record.timeVerified || 'Recorded'}</p>
                  </div>
                  <span style={{background: theme.background, color: theme.color, border: theme.border, padding: '4px 10px', borderRadius: '999px', fontSize: '0.72rem', fontWeight: 800}}>
                    {record.status || 'Verified'}
                  </span>
                </div>
              );
            })}
            {!isHistoryLoading && studentHistory.length === 0 && (
              <p style={{color: '#64748b', fontSize: '0.82rem', textAlign: 'center', margin: '10px 0'}}>No attendance records yet.</p>
            )}
          </div>
        </div>

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
