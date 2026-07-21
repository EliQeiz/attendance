import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { onCall, HttpsError } from 'firebase-functions/v2/https';

initializeApp();
const db = getFirestore();

const REGION = 'us-central1';
const CALLABLE_OPTIONS = { region: REGION, invoker: 'public' };
const DEFAULT_THRESHOLD_METERS = 150;
const MAX_ACCEPTABLE_ACCURACY_METERS = 150;
const EARTH_RADIUS_METERS = 6371000;

const toRadians = (degrees) => (degrees * Math.PI) / 180;

const haversineMeters = (from, to) => {
  const latitudeDelta = toRadians(to.latitude - from.latitude);
  const longitudeDelta = toRadians(to.longitude - from.longitude);
  const fromLatitude = toRadians(from.latitude);
  const toLatitude = toRadians(to.latitude);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(fromLatitude) * Math.cos(toLatitude) * Math.sin(longitudeDelta / 2) ** 2;

  return 2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
};

const sanitizeDeviceKey = (value) => (
  typeof value === 'string' ? value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 128) : ''
);

const toDateMillis = (value) => {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();

  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
};

const toDisplayDate = (value) => {
  const millis = toDateMillis(value);
  return millis ? new Date(millis).toLocaleString() : '';
};

const loadStudentRecordDocs = async (studentId) => {
  try {
    const snapshot = await db
      .collectionGroup('records')
      .where('studentID', '==', studentId)
      .limit(120)
      .get();

    return snapshot.docs;
  } catch (error) {
    const details = `${error?.message || ''} ${error?.details || ''}`.toLowerCase();
    const indexIsMissingOrBuilding = error?.code === 9
      && (details.includes('index') || details.includes('failed_precondition'));

    if (!indexIsMissingOrBuilding) {
      throw error;
    }

    console.warn(`records.studentID collection-group index is not ready; using exact record lookup fallback for ${studentId}.`);

    const sessionsSnapshot = await db.collection('attendance').limit(500).get();
    const recordSnapshots = await Promise.all(
      sessionsSnapshot.docs.map((sessionDoc) => sessionDoc.ref.collection('records').doc(studentId).get())
    );

    return recordSnapshots.filter((recordDoc) => recordDoc.exists).slice(0, 120);
  }
};

/**
 * Server-authoritative attendance verification.
 *
 * The projected QR code carries a session key plus a cryptographic session
 * code. The code and lecturer GPS coordinate are mirrored in a lecturer-only
 * secure subdocument, so students cannot submit attendance by merely browsing
 * the public active-session document. GPS submissions become Verified when
 * within range. Scan-only submissions become Pending for lecturer approval.
 */
export const submitAttendance = onCall(CALLABLE_OPTIONS, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in to verify attendance.');
  }

  const uid = request.auth.uid;
  const payload = request.data || {};
  const sessionKey = typeof payload.sessionKey === 'string' ? payload.sessionKey.trim() : '';
  const sessionCode = typeof payload.sessionCode === 'string' ? payload.sessionCode.trim() : '';
  const verificationMode = payload.mode === 'scan-only' ? 'scan-only' : 'gps';
  const latitude = Number(payload.latitude);
  const longitude = Number(payload.longitude);
  const accuracy = Number(payload.accuracy);
  const deviceKey = sanitizeDeviceKey(payload.deviceKey);

  if (!sessionKey) {
    throw new HttpsError('invalid-argument', 'No attendance session was provided.');
  }

  if (!sessionCode || sessionCode.length > 160) {
    throw new HttpsError('invalid-argument', 'Scan the lecturer QR code again.');
  }

  if (verificationMode === 'gps' && (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !Number.isFinite(accuracy))) {
    throw new HttpsError('invalid-argument', 'Location is required to verify attendance.');
  }

  if (verificationMode === 'gps' && accuracy > MAX_ACCEPTABLE_ACCURACY_METERS) {
    throw new HttpsError('failed-precondition', `GPS accuracy is currently +/-${Math.round(accuracy)}m. Move near a window or outdoors, then try again.`);
  }

  const profileSnap = await db.doc(`users/${uid}`).get();
  if (!profileSnap.exists) {
    throw new HttpsError('permission-denied', 'No account profile was found. Sign up again or contact the administrator.');
  }

  const profile = profileSnap.data();
  if (profile.role !== 'student') {
    throw new HttpsError('permission-denied', 'Only student accounts can verify attendance.');
  }

  const studentId = profile.knust_id;
  if (!studentId) {
    throw new HttpsError('failed-precondition', 'Your account has no student ID on file.');
  }

  const sessionRef = db.doc(`attendance/${sessionKey}`);
  const secureRef = db.doc(`attendance/${sessionKey}/secure/state`);
  const recordRef = db.doc(`attendance/${sessionKey}/records/${studentId}`);

  const result = await db.runTransaction(async (transaction) => {
    const [sessionSnap, secureSnap, recordSnap] = await Promise.all([
      transaction.get(sessionRef),
      transaction.get(secureRef),
      transaction.get(recordRef)
    ]);

    if (!sessionSnap.exists) {
      throw new HttpsError('not-found', 'This attendance session no longer exists.');
    }

    const session = sessionSnap.data();
    if (!session.active || session.method !== 'LECTURER_QR') {
      throw new HttpsError('failed-precondition', 'This attendance session is no longer active.');
    }

    if (!secureSnap.exists) {
      throw new HttpsError('failed-precondition', 'The session QR code is not ready yet. Try again in a moment.');
    }

    const secure = secureSnap.data();
    if (String(secure.sessionCode || '') !== sessionCode) {
      throw new HttpsError('permission-denied', 'Invalid QR code. Scan the current lecturer QR code.');
    }

    const lecturerLocation = secure.lecturerLocation;
    if (verificationMode === 'gps' && (!lecturerLocation || typeof lecturerLocation.latitude !== 'number' || typeof lecturerLocation.longitude !== 'number')) {
      throw new HttpsError('failed-precondition', 'Lecturer GPS location is not ready yet. Try again in a moment.');
    }

    const thresholdMeters = Number(session.locationThresholdMeters) || DEFAULT_THRESHOLD_METERS;
    const distanceMeters = verificationMode === 'gps'
      ? haversineMeters({ latitude, longitude }, lecturerLocation)
      : null;

    if (verificationMode === 'gps' && distanceMeters > thresholdMeters) {
      throw new HttpsError('failed-precondition', `You are ${Math.round(distanceMeters)}m from the lecturer. Move within ${thresholdMeters}m and try again.`);
    }

    let roster = null;
    if (session.courseId) {
      const rosterSnap = await transaction.get(db.doc(`courses/${session.courseId}/students/${studentId}`));
      if (!rosterSnap.exists) {
        throw new HttpsError('permission-denied', 'Your student ID is not on this course roster. Ask the lecturer to add you before verifying.');
      }
      roster = rosterSnap.data();
    }

    if (recordSnap.exists) {
      const existing = recordSnap.data();
      return {
        existingStatus: existing.status || 'Verified',
        distanceMeters: Number.isFinite(distanceMeters) ? Math.round(distanceMeters) : null
      };
    }

    let deviceRef = null;
    if (deviceKey) {
      deviceRef = db.doc(`attendance/${sessionKey}/devices/${deviceKey}`);
      const deviceSnap = await transaction.get(deviceRef);
      if (deviceSnap.exists && deviceSnap.data().studentID !== studentId) {
        throw new HttpsError('permission-denied', 'This device has already been used to verify another student for this session.');
      }
    }

    const resolvedFullName = roster?.fullName || roster?.name || profile.name || `Student ${studentId}`;
    const resolvedDeviceName = roster?.deviceName || `KNUST_STU_${studentId}`;
    const verifiedAtIso = new Date().toISOString();
    const isGpsVerified = verificationMode === 'gps';

    transaction.set(recordRef, {
      studentID: studentId,
      indexNumber: roster?.indexNumber || '',
      referenceNumber: roster?.referenceNumber || '',
      fullName: resolvedFullName,
      status: isGpsVerified ? 'Verified' : 'Pending',
      method: isGpsVerified ? 'QR_GPS' : 'QR_SCAN_PENDING',
      courseCode: session.courseCode || '',
      week: session.weekNumber ?? null,
      sessionKey,
      deviceKey: deviceKey || '',
      deviceName: resolvedDeviceName,
      studentLocation: isGpsVerified ? { latitude, longitude, accuracy: Math.round(accuracy) } : null,
      distanceMeters: isGpsVerified ? Math.round(distanceMeters) : null,
      scanOnly: !isGpsVerified,
      requiresLecturerApproval: !isGpsVerified,
      pendingReason: isGpsVerified ? '' : 'Student scanned QR without GPS and needs lecturer confirmation.',
      verifiedAt: isGpsVerified ? FieldValue.serverTimestamp() : null,
      pendingAt: isGpsVerified ? null : FieldValue.serverTimestamp(),
      verifiedAtIso,
      timeVerified: new Date().toLocaleTimeString(),
      verificationDate: new Date().toLocaleDateString(),
      timestamp: FieldValue.serverTimestamp(),
      verifiedVia: 'cloud-function'
    });

    if (deviceRef) {
      transaction.set(deviceRef, {
        studentID: studentId,
        fullName: resolvedFullName,
        deviceName: resolvedDeviceName,
        verifiedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    }

    return {
      alreadyVerified: false,
      distanceMeters: Number.isFinite(distanceMeters) ? Math.round(distanceMeters) : null
    };
  });

  if (result.existingStatus) {
    return {
      status: result.existingStatus === 'Pending' ? 'pending' : result.existingStatus.toLowerCase(),
      distanceMeters: result.distanceMeters
    };
  }

  return {
    status: verificationMode === 'gps' ? 'verified' : 'pending',
    distanceMeters: Number.isFinite(result.distanceMeters) ? result.distanceMeters : null
  };
});

export const getStudentAttendanceHistory = onCall(CALLABLE_OPTIONS, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in to view attendance history.');
  }

  const profileSnap = await db.doc(`users/${request.auth.uid}`).get();
  if (!profileSnap.exists || profileSnap.data().role !== 'student') {
    throw new HttpsError('permission-denied', 'Only student accounts can view student attendance history.');
  }

  const profile = profileSnap.data();
  const studentId = profile.knust_id;
  if (!studentId) {
    throw new HttpsError('failed-precondition', 'Your account has no student ID on file.');
  }

  const recordDocs = await loadStudentRecordDocs(studentId);

  const records = recordDocs.map((recordDoc) => {
    const record = recordDoc.data();
    const sessionRef = recordDoc.ref.parent.parent;
    const timestampMs = toDateMillis(record.verifiedAt || record.pendingAt || record.timestamp || record.verifiedAtIso || record.pendingAtIso);

    return {
      sessionKey: record.sessionKey || sessionRef?.id || '',
      courseCode: record.courseCode || '',
      week: record.week ?? null,
      status: record.status || 'Verified',
      method: record.method || '',
      timeVerified: record.timeVerified || '',
      verificationDate: record.verificationDate || '',
      dateTime: toDisplayDate(record.verifiedAt || record.pendingAt || record.timestamp || record.verifiedAtIso || record.pendingAtIso),
      distanceMeters: Number.isFinite(record.distanceMeters) ? record.distanceMeters : null,
      timestampMs
    };
  }).sort((a, b) => b.timestampMs - a.timestampMs);

  const summary = records.reduce((totals, record) => {
    if (record.status === 'Verified') totals.verified += 1;
    else if (record.status === 'Pending') totals.pending += 1;
    else if (record.status === 'Denied') totals.denied += 1;
    return totals;
  }, { verified: 0, pending: 0, denied: 0 });

  const courses = {};
  records.forEach((record) => {
    const courseCode = record.courseCode || 'Course';
    if (!courses[courseCode]) {
      courses[courseCode] = { courseCode, verified: 0, pending: 0, denied: 0, sessions: [] };
    }

    if (record.status === 'Verified') courses[courseCode].verified += 1;
    else if (record.status === 'Pending') courses[courseCode].pending += 1;
    else if (record.status === 'Denied') courses[courseCode].denied += 1;

    if (record.week) courses[courseCode].sessions.push(`W${record.week}`);
  });

  return {
    studentID: studentId,
    records,
    summary: {
      ...summary,
      total: records.length,
      courses: Object.values(courses)
    }
  };
});
