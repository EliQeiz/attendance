import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { onCall, HttpsError } from 'firebase-functions/v2/https';

initializeApp();
const db = getFirestore();

const REGION = 'us-central1';
const PIN_PATTERN = /^\d{4}$/;
const DEFAULT_PIN_WINDOW_MS = 3 * 60 * 1000;
const DEFAULT_THRESHOLD_METERS = 100;
const MAX_ACCEPTABLE_ACCURACY_METERS = 100;
const CLOCK_SKEW_MS = 15 * 1000;
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

/**
 * Server-authoritative attendance verification.
 *
 * The 4-digit PIN and the lecturer GPS coordinate live in a lecturer-only
 * secure subdocument that students cannot read, so neither value ever reaches
 * the student client. All integrity checks (PIN match, freshness, GPS
 * proximity, roster membership, duplicate, device reuse) run here and the
 * record is written with admin privileges. Firestore rules forbid students
 * from creating records directly, so this function is the only path in.
 */
export const submitAttendance = onCall({ region: REGION }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in to verify attendance.');
  }

  const uid = request.auth.uid;
  const payload = request.data || {};
  const sessionKey = typeof payload.sessionKey === 'string' ? payload.sessionKey.trim() : '';
  const pin = typeof payload.pin === 'string' ? payload.pin.trim() : '';
  const latitude = Number(payload.latitude);
  const longitude = Number(payload.longitude);
  const accuracy = Number(payload.accuracy);
  const deviceKey = sanitizeDeviceKey(payload.deviceKey);

  if (!sessionKey) {
    throw new HttpsError('invalid-argument', 'No attendance session was provided.');
  }

  if (!PIN_PATTERN.test(pin)) {
    throw new HttpsError('invalid-argument', 'Enter the current 4-digit PIN displayed by the lecturer.');
  }

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !Number.isFinite(accuracy)) {
    throw new HttpsError('invalid-argument', 'Location is required to verify attendance.');
  }

  if (accuracy > MAX_ACCEPTABLE_ACCURACY_METERS) {
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
    if (!session.active || session.method !== 'PIN_GPS') {
      throw new HttpsError('failed-precondition', 'This attendance session is no longer active.');
    }

    if (!secureSnap.exists) {
      throw new HttpsError('failed-precondition', 'The session PIN is not ready yet. Try again in a moment.');
    }

    const secure = secureSnap.data();
    const now = Date.now();
    const issuedAtMs = Number(secure.pinIssuedAtMs) || 0;
    const windowMs = Number(secure.pinWindowMs) || DEFAULT_PIN_WINDOW_MS;
    const expiresAtMs = Number(secure.pinExpiresAtMs) || (issuedAtMs + windowMs);

    if (!issuedAtMs || now > expiresAtMs + CLOCK_SKEW_MS) {
      throw new HttpsError('failed-precondition', 'This PIN has expired. Enter the newly displayed PIN.');
    }

    if (String(secure.currentPin) !== pin) {
      throw new HttpsError('permission-denied', 'Invalid PIN. Use the current PIN displayed by the lecturer.');
    }

    const lecturerLocation = secure.lecturerLocation;
    if (!lecturerLocation || typeof lecturerLocation.latitude !== 'number' || typeof lecturerLocation.longitude !== 'number') {
      throw new HttpsError('failed-precondition', 'Lecturer GPS location is not ready yet. Try again in a moment.');
    }

    const thresholdMeters = Number(session.locationThresholdMeters) || DEFAULT_THRESHOLD_METERS;
    const distanceMeters = haversineMeters({ latitude, longitude }, lecturerLocation);

    if (distanceMeters > thresholdMeters) {
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
      return { alreadyVerified: true, distanceMeters: Math.round(distanceMeters) };
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

    transaction.set(recordRef, {
      studentID: studentId,
      indexNumber: roster?.indexNumber || '',
      referenceNumber: roster?.referenceNumber || '',
      fullName: resolvedFullName,
      status: 'Verified',
      method: 'PIN_GPS',
      courseCode: session.courseCode || '',
      week: session.weekNumber ?? null,
      sessionKey,
      deviceKey: deviceKey || '',
      deviceName: resolvedDeviceName,
      studentLocation: { latitude, longitude, accuracy: Math.round(accuracy) },
      distanceMeters: Math.round(distanceMeters),
      verifiedAt: FieldValue.serverTimestamp(),
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

    return { alreadyVerified: false, distanceMeters: Math.round(distanceMeters) };
  });

  return {
    status: result.alreadyVerified ? 'already-verified' : 'verified',
    distanceMeters: result.distanceMeters
  };
});
