import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { AlertCircle, Award, CheckCircle, Clock, Download, Filter, LogOut, MapPin, QrCode, RefreshCw, Search, ShieldCheck, Smartphone } from 'lucide-react';
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

const formatMethodLabel = (method = '') => ({
  QR_GPS: 'QR + GPS',
  QR_SCAN_PENDING: 'QR Scan Pending',
  LECTURER_APPROVED_SCAN: 'Lecturer Approved',
  LECTURER_DENIED_SCAN: 'Lecturer Denied',
  LECTURER_MANUAL: 'Lecturer Manual'
}[method] || method || 'QR Attendance');

const getStatusTone = (status = 'Verified') => {
  if (status === 'Verified') return 'verified';
  if (status === 'Pending') return 'pending';
  if (status === 'Denied') return 'denied';
  return 'absent';
};

const getStatusIcon = (status = 'Verified') => {
  if (status === 'Verified') return <CheckCircle size={16} />;
  if (status === 'Pending') return <Clock size={16} />;
  return <AlertCircle size={16} />;
};

const protectCsvCell = (value = '') => {
  const text = value == null ? '' : String(value);
  const safeText = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safeText.replace(/"/g, '""')}"`;
};

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
  const [historySearchTerm, setHistorySearchTerm] = useState('');
  const [historyStatusFilter, setHistoryStatusFilter] = useState('all');
  const studentId = user.knust_id || user.id;
  const deviceKeyPreview = useMemo(() => getBrowserDeviceKey().slice(-8).toUpperCase(), []);

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

  const filteredStudentHistory = useMemo(() => {
    const term = historySearchTerm.trim().toLowerCase();

    return studentHistory.filter(record => {
      const matchesStatus = historyStatusFilter === 'all'
        || (record.status || 'Verified').toLowerCase() === historyStatusFilter;
      const matchesTerm = !term
        || (record.courseCode || '').toLowerCase().includes(term)
        || String(record.week || '').toLowerCase().includes(term)
        || (record.status || '').toLowerCase().includes(term)
        || (record.method || '').toLowerCase().includes(term);

      return matchesStatus && matchesTerm;
    });
  }, [historySearchTerm, historyStatusFilter, studentHistory]);

  const downloadStudentLedger = () => {
    if (!studentHistory.length) {
      setError('No attendance records are available to export yet.');
      return;
    }

    const fields = ['Course', 'Week', 'Status', 'Method', 'Date', 'DistanceMeters'];
    const rows = studentHistory.map(record => ([
      record.courseCode || '',
      record.week ? `Week ${record.week}` : '',
      record.status || 'Verified',
      formatMethodLabel(record.method),
      record.dateTime || record.timeVerified || record.verificationDate || '',
      Number.isFinite(record.distanceMeters) ? record.distanceMeters : ''
    ]));
    const csv = [fields, ...rows]
      .map(row => row.map(protectCsvCell).join(','))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const anchor = document.createElement('a');
    const url = window.URL.createObjectURL(blob);
    anchor.href = url;
    anchor.download = `${studentId}_attendance_ledger.csv`;
    anchor.click();
    window.URL.revokeObjectURL(url);
  };

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

  return (
    <div className="knust-login-page">
      <MotionDiv
        className="login-glass-card student-suite-card"
        initial={{ opacity: 0, y: 18, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.45, ease: 'easeOut' }}
      >
        <div className="brand-lockup">
          <img
            src="https://images.seeklogo.com/logo-png/35/2/kwame-nkrumah-university-of-science-technology-logo-png_seeklogo-350387.png"
            alt="KNUST Logo"
            className="login-logo"
          />
          <p className="aura-eyebrow">Student Suite</p>
        </div>

        <section className="student-header">
          <h2>Welcome, <span className="gradient-text">{user.name}</span></h2>
          <p>ID: {studentId}</p>
        </section>

        <section className="suite-panel">
          <div className="suite-panel-header">
            <div className="suite-icon"><QrCode size={22} /></div>
            <div>
              <h3>Lecturer QR Attendance</h3>
              <p>Scan the projected lecturer QR code to verify this class.</p>
            </div>
          </div>

          <div className="student-status-grid">
            <div className={`metric-card ${activeSessions.length ? 'success' : ''}`}>
              <p className="metric-label">Active QR Sessions</p>
              <strong className="metric-value">{activeSessions.length}</strong>
            </div>
            <div className="metric-card info">
              <p className="metric-label">GPS Radius</p>
              <strong className="metric-value">{LOCATION_THRESHOLD_METERS}m</strong>
            </div>
          </div>

          <p className="panel-copy">
            GPS verification gives immediate confirmation. If your phone blocks location, use scan-only and wait while the lecturer confirms you are in class.
          </p>
        </section>

        <section className="suite-panel">
          <div className="suite-panel-header">
            <div className="suite-icon"><Smartphone size={20} /></div>
            <div>
              <h3>Verification Readiness</h3>
              <p>Device token, browser GPS support, and active session availability for this account.</p>
            </div>
          </div>

          <div className="student-status-grid readiness-grid">
            <div className="metric-card info">
              <p className="metric-label">Device Token</p>
              <strong className="metric-value token-value">{deviceKeyPreview}</strong>
            </div>
            <div className={`metric-card ${navigator.geolocation ? 'success' : 'warning'}`}>
              <p className="metric-label">GPS Support</p>
              <strong className="metric-value">{navigator.geolocation ? 'Ready' : 'Blocked'}</strong>
            </div>
          </div>
        </section>

        {latestCourseLabel && (
          <div className="notice-card info">
            <MapPin size={16} />
            <span>Current context: {latestCourseLabel}</span>
          </div>
        )}

        {error && (
          <div className="notice-card error">
            <AlertCircle size={16} />
            <span>{error}</span>
          </div>
        )}

        {status && (
          <div className={`notice-card ${status.includes('Waiting') || status.includes('approval') ? 'warning' : 'info'}`}>
            {status.includes('Waiting') || status.includes('approval') ? <Clock size={16} /> : <MapPin size={16} />}
            <span>{status}</span>
          </div>
        )}

        {currentRecord && (
          <div className={`record-card status-pill ${getStatusTone(currentRecord.status)}`}>
            {getStatusIcon(currentRecord.status)}
            <div>
              <strong>{currentRecord.status || 'Verified'}</strong>
              <p>
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
          >
            <ShieldCheck size={18} />
            {isVerifying && scannerMode === 'gps' ? 'Verifying...' : 'Scan + GPS Verify'}
          </button>

          <button
            onClick={() => openScanner('scan-only')}
            className="login-btn-final"
            disabled={isVerifying}
          >
            <QrCode size={18} />
            {isVerifying && scannerMode === 'scan-only' ? 'Submitting...' : 'Scan Only'}
          </button>
        </div>

        {isScannerOpen && (
          <section className="suite-panel">
            <div className="suite-panel-header">
              <div className="suite-icon"><QrCode size={20} /></div>
              <div>
                <h3>{scannerMode === 'gps' ? 'Scan QR for GPS Verification' : 'Scan QR for Lecturer Approval'}</h3>
                <p>{scannerMode === 'gps' ? 'Keep location enabled while the QR is processed.' : 'Your scan will enter the lecturer approval queue.'}</p>
              </div>
            </div>
            <Scanner onResult={submitScannedAttendance} onClose={() => setIsScannerOpen(false)} />
          </section>
        )}

        {studentSummary.courses?.length > 0 && (
          <section className="suite-panel">
            <div className="suite-panel-header">
              <div className="suite-icon"><Award size={20} /></div>
              <div>
                <h3>Course Passport</h3>
                <p>Attendance health by course, including pending and denied scans.</p>
              </div>
            </div>

            <div className="course-passport-grid">
              {studentSummary.courses.map(course => (
                <div key={course.courseCode} className="course-passport-card">
                  <div>
                    <strong>{course.courseCode}</strong>
                    <p>{course.sessions?.join(', ') || 'No verified sessions yet'}</p>
                  </div>
                  <div className="passport-metrics">
                    <span className="status-pill verified">{course.verified || 0} Verified</span>
                    {(course.pending || 0) > 0 && <span className="status-pill pending">{course.pending} Pending</span>}
                    {(course.denied || 0) > 0 && <span className="status-pill denied">{course.denied} Denied</span>}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="suite-panel">
          <div className="suite-panel-header">
            <div className="suite-icon"><Clock size={20} /></div>
            <div>
              <h3>My Attendance Ledger</h3>
              <p>Your recorded sessions across courses.</p>
            </div>
            <div className="ledger-header-actions">
              <button
                type="button"
                onClick={loadStudentHistory}
                disabled={isHistoryLoading}
                className="mini-action-btn present"
                aria-label="Refresh attendance ledger"
              >
                <RefreshCw size={15} />
                {isHistoryLoading ? 'Refreshing' : 'Refresh'}
              </button>
              <button
                type="button"
                onClick={downloadStudentLedger}
                className="mini-action-btn present"
                aria-label="Download attendance ledger"
              >
                <Download size={15} />
                Export
              </button>
            </div>
          </div>

          <div className="student-status-grid">
            <div className="metric-card success">
              <p className="metric-label">Verified</p>
              <strong className="metric-value">{studentSummary.verified || 0}</strong>
            </div>
            <div className="metric-card warning">
              <p className="metric-label">Pending</p>
              <strong className="metric-value">{studentSummary.pending || 0}</strong>
            </div>
            <div className="metric-card">
              <p className="metric-label">Denied</p>
              <strong className="metric-value">{studentSummary.denied || 0}</strong>
            </div>
            <div className="metric-card info">
              <p className="metric-label">Total Records</p>
              <strong className="metric-value">{studentSummary.total || 0}</strong>
            </div>
          </div>

          <div className="student-ledger-toolbar">
            <div className="search-bar">
              <Search size={16} />
              <input
                placeholder="Search course, week, method, or status"
                value={historySearchTerm}
                onChange={(event) => setHistorySearchTerm(event.target.value)}
              />
            </div>
            <div className="ledger-filter">
              <Filter size={15} />
              {['all', 'verified', 'pending', 'denied'].map(filter => (
                <button
                  key={filter}
                  type="button"
                  className={historyStatusFilter === filter ? 'active' : ''}
                  onClick={() => setHistoryStatusFilter(filter)}
                >
                  {filter}
                </button>
              ))}
            </div>
          </div>

          <div className="history-list">
            {filteredStudentHistory.slice(0, 12).map((record, index) => (
              <div key={`${record.sessionKey}-${index}`} className="history-row">
                <div>
                  <strong>{record.courseCode || 'Course'} {record.week ? `Week ${record.week}` : ''}</strong>
                  <p>{record.dateTime || record.timeVerified || 'Recorded'}</p>
                </div>
                <span className={`status-pill ${getStatusTone(record.status)}`}>
                  {record.status || 'Verified'}
                </span>
              </div>
            ))}
            {!isHistoryLoading && filteredStudentHistory.length === 0 && (
              <p className="empty-state">No attendance records yet.</p>
            )}
          </div>
        </section>

        <button onClick={onLogout} className="login-btn-final">
          <LogOut size={16} /> Logout
        </button>
      </MotionDiv>
    </div>
  );
}
