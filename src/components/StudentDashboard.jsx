import React, { useEffect, useMemo, useState } from 'react';
import { QRCodeCanvas } from 'qrcode.react';
import { motion } from 'framer-motion';
import { AlertCircle, Bluetooth, CheckCircle, LogOut, QrCode } from 'lucide-react';
import { db } from '../firebase';
import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  where
} from 'firebase/firestore';

const MotionDiv = motion.div;
const BLE_SERVICE_UUID = '0000feed-0000-1000-8000-00805f9b34fb';

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

  useEffect(() => {
    const activeSessionsQuery = query(collection(db, 'attendance'), where('active', '==', true));

    const unsubscribe = onSnapshot(activeSessionsQuery, (snapshot) => {
      const bluetoothSessions = snapshot.docs
        .map(sessionDoc => ({ id: sessionDoc.id, ...sessionDoc.data() }))
        .filter(session => session.method === 'Bluetooth');

      setSessions(bluetoothSessions);

      if (!selectedSessionKey && bluetoothSessions.length === 1) {
        setSelectedSessionKey(bluetoothSessions[0].id);
      }

      if (selectedSessionKey && !bluetoothSessions.some(session => session.id === selectedSessionKey)) {
        setSelectedSessionKey('');
      }
    });

    return () => unsubscribe();
  }, [selectedSessionKey]);

  const selectedSession = useMemo(() => (
    sessions.find(session => session.id === selectedSessionKey) || sessions[0] || null
  ), [sessions, selectedSessionKey]);
  const studentId = user.knust_id || user.id;
  const studentDeviceName = `KNUST_STU_${studentId}`;
  const qrValue = useMemo(() => (
    selectedSession
      ? JSON.stringify({
          type: 'KNUST_ATTENDANCE',
          studentID: studentId,
          fullName: user.name,
          sessionKey: selectedSession.id,
          courseCode: selectedSession.courseCode,
          week: selectedSession.weekNumber
        })
      : ''
  ), [selectedSession, studentId, user.name]);
  const isAlreadyVerified = Boolean(selectedSession && existingVerification?.sessionKey === selectedSession.id);

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

    if (!selectedSession) {
      setError('No active Bluetooth attendance session is available right now.');
      return;
    }

    if (!navigator.bluetooth) {
      setError('This browser does not support Web Bluetooth. Please use Chrome or Edge on Android, Windows, macOS, or ChromeOS.');
      return;
    }

    const sessionName = selectedSession.sessionName || 'KNUST_LEC_';
    const serviceUuid = selectedSession.serviceUuid || BLE_SERVICE_UUID;
    const recordRef = doc(db, 'attendance', selectedSession.id, 'records', studentId);
    const deviceKey = getBrowserDeviceKey();
    const deviceRef = doc(db, 'attendance', selectedSession.id, 'devices', deviceKey);
    setIsVerifying(true);
    setStatus(`Scanning for ${sessionName}...`);

    try {
      const existingRecord = await getDoc(recordRef);
      if (existingRecord.exists()) {
        setExistingVerification(existingRecord.data());
        setVerifiedSessionKey(selectedSession.id);
        setStatus(`You are already verified for ${selectedSession.courseCode || selectedSession.originalCourseCode}.`);
        return;
      }

      const existingDevice = await getDoc(deviceRef);
      if (existingDevice.exists() && existingDevice.data().studentID !== studentId) {
        setError('This device has already been used to verify another student for this session.');
        setStatus('');
        return;
      }

      if (selectedSession.courseId) {
        const rosterRef = doc(db, 'courses', selectedSession.courseId, 'students', studentId);
        const rosterSnap = await getDoc(rosterRef);

        if (!rosterSnap.exists()) {
          setError('Your student ID is not on this course roster. Ask the lecturer to add you before verifying.');
          setStatus('');
          return;
        }
      }

      const device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: sessionName }],
        optionalServices: [serviceUuid]
      });

      if (device.gatt?.connect) {
        try {
          await device.gatt.connect();
        } catch (connectError) {
          console.warn('BLE device selected but GATT connection was not completed:', connectError);
        }
      }

      const now = new Date();
      await setDoc(recordRef, {
        studentID: studentId,
        fullName: user.name,
        timeVerified: now.toLocaleTimeString(),
        verifiedAt: serverTimestamp(),
        verifiedAtIso: now.toISOString(),
        verificationDate: now.toLocaleDateString(),
        status: 'Verified',
        timestamp: serverTimestamp(),
        method: 'Bluetooth',
        courseCode: selectedSession.courseCode,
        week: selectedSession.weekNumber,
        sessionKey: selectedSession.id,
        deviceName: studentDeviceName,
        deviceKey,
        lecturerDeviceName: device.name || sessionName
      }, { merge: true });

      await setDoc(deviceRef, {
        studentID: studentId,
        fullName: user.name,
        deviceName: studentDeviceName,
        verifiedAt: serverTimestamp()
      }, { merge: true });

      setVerifiedSessionKey(selectedSession.id);
      setStatus(`Presence verified for ${selectedSession.courseCode || selectedSession.originalCourseCode}.`);
    } catch (bluetoothError) {
      const cancelled = bluetoothError?.name === 'NotFoundError';
      setError(cancelled
        ? `No matching BLE device was selected. Move closer and scan for ${sessionName} again.`
        : `Bluetooth verification failed: ${bluetoothError.message || 'unknown Bluetooth error'}.`
      );
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
            <Bluetooth size={30} color="#003366" />
            <div>
              <h3 style={{color: '#003366', fontSize: '1rem', margin: 0}}>Bluetooth Presence</h3>
              <p style={{color: '#64748b', fontSize: '0.8rem', margin: 0}}>Scan for the lecturer's active BLE session.</p>
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
              ? `${selectedSession.originalCourseCode || selectedSession.courseCode} Week ${selectedSession.weekNumber}: ${selectedSession.sessionName}`
              : 'Waiting for a lecturer to start a BLE session.'}
          </div>

          <p style={{color: '#64748b', fontSize: '0.8rem', margin: '12px 0 0'}}>
            Device name: <strong>{studentDeviceName}</strong>
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
            {verifiedSessionKey ? <CheckCircle size={16} /> : <Bluetooth size={16} />} {status}
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
          {isAlreadyVerified ? <CheckCircle size={18} /> : <Bluetooth size={18} />}
          {isAlreadyVerified ? 'Already Verified' : isVerifying ? 'Scanning...' : 'Verify Presence (Bluetooth)'}
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
