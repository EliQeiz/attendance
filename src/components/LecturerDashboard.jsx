import React, { useCallback, useMemo, useState, useEffect } from 'react';
import { QRCodeCanvas } from 'qrcode.react';
import { readSheet } from 'read-excel-file/browser';
import { motion } from 'framer-motion';
import {
  Search,
  Download,
  LogOut,
  Menu,
  X,
  CheckCircle,
  BookOpen,
  History,
  Moon,
  Sun,
  LayoutGrid,
  Users,
  ArrowLeft,
  ChevronRight,
  FileSpreadsheet,
  MapPin,
  Power,
  AlertCircle,
  QrCode,
  Upload,
  UserPlus,
  SortAsc,
  SortDesc,
  CalendarDays,
  ClipboardList
} from 'lucide-react';
import { Parser } from '@json2csv/plainjs';
import { db } from '../firebase';
import { getRefinedPosition, requireUsableGpsAccuracy, toLocationRecord } from '../utils/geolocation';
import {
  collection,
  query,
  where,
  onSnapshot,
  addDoc,
  setDoc,
  doc,
  getDoc,
  getDocs,
  deleteDoc,
  orderBy,
  serverTimestamp,
  writeBatch
} from "firebase/firestore";

const MotionDiv = motion.div;
const WEEKS = Array.from({ length: 15 }, (_, i) => i + 1);
const QR_DISTANCE_METERS = 150;
const MAX_ROSTER_FILE_BYTES = 2 * 1024 * 1024;
const MAX_ROSTER_ROWS = 5000;
const SUPPORTED_ROSTER_EXTENSIONS = ['csv', 'xlsx'];

const normalizeCourseCode = (code = '') => code.replace(/\s+/g, '').toUpperCase();
const getSessionKey = (courseCode, weekNumber) => `${normalizeCourseCode(courseCode)}-W${weekNumber}`;
const getStudentDeviceName = (studentID) => `KNUST_STU_${studentID}`;
const generateSessionCode = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const entropy = new Uint32Array(4);
  globalThis.crypto.getRandomValues(entropy);
  return Array.from(entropy, value => value.toString(16).padStart(8, '0')).join('-');
};
const stringifyCell = (value) => (value == null ? '' : String(value));
const normalizeHeader = (value = '') => stringifyCell(value).trim().toLowerCase().replace(/[^a-z0-9]/g, '');
const cleanCell = (value = '') => stringifyCell(value).trim().replace(/\.0$/, '');
const cleanIdentifier = (value = '') => cleanCell(value).replace(/\s+/g, '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
const stripControlCharacters = (value = '') => (
  Array.from(String(value), char => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127 ? ' ' : char;
  }).join('')
);
const cleanDisplayText = (value = '', maxLength = 120) => (
  stripControlCharacters(cleanCell(value))
    .replace(/\s+/g, ' ')
    .slice(0, maxLength)
);
const protectCsvCell = (value = '') => {
  const text = value == null ? '' : String(value);
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
};
const protectCsvRow = (row) => (
  Object.fromEntries(Object.entries(row).map(([key, value]) => [key, protectCsvCell(value)]))
);
const STUDENT_ID_ALIASES = ['studentid', 'studentnumber', 'knustid', 'knuststudentid', 'id'];
const INDEX_NUMBER_ALIASES = ['indexnumber', 'indexno', 'index'];
const REFERENCE_NUMBER_ALIASES = ['referencenumber', 'referenceno', 'refnumber', 'refno', 'reference'];
const NAME_ALIASES = ['fullname', 'studentname', 'name', 'names', 'candidatename'];
const FIRST_NAME_ALIASES = ['firstname', 'firstnames', 'givenname'];
const LAST_NAME_ALIASES = ['lastname', 'surname', 'familyname'];
const DEVICE_NAME_ALIASES = ['devicename', 'bluetoothname', 'bledevicename'];

const countDelimiterOutsideQuotes = (line, delimiter) => {
  let count = 0;
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const nextChar = line[index + 1];

    if (char === '"' && inQuotes && nextChar === '"') {
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (!inQuotes && char === delimiter) count += 1;
  }

  return count;
};

const detectDelimiter = (text) => {
  const sampleLines = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, 20);
  const candidates = [',', ';', '\t', '|'];
  const scores = candidates.map(delimiter => ({
    delimiter,
    score: sampleLines.reduce((sum, line) => sum + countDelimiterOutsideQuotes(line, delimiter), 0)
  }));

  return scores.sort((a, b) => b.score - a.score)[0]?.delimiter || ',';
};

const parseDelimitedRows = (text) => {
  const rows = [];
  let row = [];
  let value = '';
  let inQuotes = false;
  const delimiter = detectDelimiter(text);

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const nextChar = text[index + 1];

    if (inQuotes) {
      if (char === '"' && nextChar === '"') {
        value += '"';
        index += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        value += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }

    if (char === delimiter) {
      row.push(value);
      value = '';
      continue;
    }

    if (char === '\r') {
      if (nextChar === '\n') continue;
      row.push(value);
      rows.push(row);
      row = [];
      value = '';
      continue;
    }

    if (char === '\n') {
      row.push(value);
      rows.push(row);
      row = [];
      value = '';
      continue;
    }

    value += char;
  }

  row.push(value);
  if (row.some(cell => cleanCell(cell)) || rows.length) rows.push(row);
  return rows.map(csvRow => csvRow.map(cell => cleanCell(cell)));
};

const normalizeRosterRow = (row) => {
  if (Array.isArray(row)) return row;
  if (row && typeof row === 'object') return Object.values(row);
  if (row == null) return [];
  return [row];
};

const normalizeRosterRows = (rows) => {
  if (!Array.isArray(rows)) {
    throw new Error('Roster parser returned an invalid table. Please upload a CSV or XLSX table.');
  }

  return rows
    .map(normalizeRosterRow)
    .filter(row => row.some(cell => cleanCell(cell)));
};

const readRosterRows = async (file) => {
  const extension = file.name.split('.').pop()?.toLowerCase() || '';

  if (file.size > MAX_ROSTER_FILE_BYTES) {
    throw new Error('Roster file is too large. Upload a CSV or XLSX file under 2 MB.');
  }

  if (!SUPPORTED_ROSTER_EXTENSIONS.includes(extension)) {
    throw new Error('Unsupported roster format. Upload a CSV or modern Excel .xlsx file.');
  }

  const rows = extension === 'csv'
    ? parseDelimitedRows(await file.text())
    : await readSheet(file);

  const normalizedRows = normalizeRosterRows(rows);

  if (normalizedRows.length > MAX_ROSTER_ROWS) {
    throw new Error(`Roster has too many rows. Keep each upload under ${MAX_ROSTER_ROWS} students.`);
  }

  return normalizedRows;
};

const findHeaderIndex = (headers, aliases) => (
  headers.findIndex(header => {
    const normalizedHeader = normalizeHeader(header);
    return aliases.includes(normalizedHeader);
  })
);

const looksLikeStudentId = (value) => /^\d{8}$/.test(cleanIdentifier(value));
const looksLikeIndexNumber = (value) => /^\d{5,8}$/.test(cleanIdentifier(value));
const looksLikeStudentName = (value) => {
  const text = cleanDisplayText(value);
  return /^[A-Za-z][A-Za-z\s.'-]{3,}$/.test(text)
    && text.split(/\s+/).length >= 2
    && !/university|science|technology|semester|course|lecturer|programme|general|campus/i.test(text);
};

const getRosterHeaderInfo = (rows) => {
  let bestMatch = null;

  rows.forEach((row, rowIndex) => {
    const headers = row.map(cell => cleanCell(cell));
    const studentIdIndex = findHeaderIndex(headers, STUDENT_ID_ALIASES);
    const indexNumberIndex = findHeaderIndex(headers, INDEX_NUMBER_ALIASES);
    const referenceNumberIndex = findHeaderIndex(headers, REFERENCE_NUMBER_ALIASES);
    const nameIndex = findHeaderIndex(headers, NAME_ALIASES);
    const firstNameIndex = findHeaderIndex(headers, FIRST_NAME_ALIASES);
    const lastNameIndex = findHeaderIndex(headers, LAST_NAME_ALIASES);
    const deviceNameIndex = findHeaderIndex(headers, DEVICE_NAME_ALIASES);
    const hasAnyId = studentIdIndex >= 0 || indexNumberIndex >= 0 || referenceNumberIndex >= 0;
    const hasAnyName = nameIndex >= 0 || firstNameIndex >= 0 || lastNameIndex >= 0;
    const score = [
      studentIdIndex,
      indexNumberIndex,
      referenceNumberIndex,
      nameIndex,
      firstNameIndex,
      lastNameIndex,
      deviceNameIndex
    ].filter(index => index >= 0).length;

    if (!hasAnyId || !hasAnyName) return;

    if (!bestMatch || score > bestMatch.score) {
      bestMatch = {
        rowIndex,
        score,
        studentIdIndex,
        indexNumberIndex,
        referenceNumberIndex,
        nameIndex,
        firstNameIndex,
        lastNameIndex,
        deviceNameIndex
      };
    }
  });

  if (bestMatch) return bestMatch;

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const studentIdIndex = row.findIndex(looksLikeStudentId);
    if (studentIdIndex < 0) continue;

    const indexNumberIndex = row.findIndex((cell, cellIndex) => (
      cellIndex !== studentIdIndex && looksLikeIndexNumber(cell)
    ));
    const nameIndex = row.findIndex((cell, cellIndex) => (
      cellIndex !== studentIdIndex
      && cellIndex !== indexNumberIndex
      && looksLikeStudentName(cell)
    ));

    if (nameIndex >= 0) {
      return {
        rowIndex,
        dataStartIndex: rowIndex,
        score: 3,
        studentIdIndex,
        indexNumberIndex,
        referenceNumberIndex: -1,
        nameIndex,
        firstNameIndex: -1,
        lastNameIndex: -1,
        deviceNameIndex: -1
      };
    }
  }

  return null;
};

const getDateValue = (value) => {
  if (!value) return null;
  if (value?.toDate) return value.toDate();
  if (value instanceof Date) return value;

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const formatDateTime = (value) => {
  const date = getDateValue(value);
  if (!date) return '';

  return date.toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
};

const sortByStudentId = (rows, direction = 'asc') => {
  const multiplier = direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = (a.studentID || '').toString();
    const right = (b.studentID || '').toString();
    return left.localeCompare(right, undefined, { numeric: true }) * multiplier;
  });
};

const isVerifiedRecord = (record) => (record?.status || 'Verified') === 'Verified';

const getStatusClassName = (status = 'Verified') => {
  if (status === 'Verified') return 'status-tag-verified';
  if (status === 'Pending') return 'status-tag-pending';
  return 'status-tag-absent';
};

const formatMethodLabel = (method = '') => ({
  QR_GPS: 'QR + GPS',
  QR_SCAN_PENDING: 'QR Scan Pending',
  LECTURER_APPROVED_SCAN: 'Lecturer Approved',
  LECTURER_DENIED_SCAN: 'Lecturer Denied',
  LECTURER_MANUAL: 'Lecturer Manual',
  PIN_GPS: 'Legacy PIN + GPS',
  QR_FALLBACK: 'Legacy Student QR'
}[method] || method || 'QR Attendance');

export default function LecturerDashboard({ user, onLogout }) {
  const [courses, setCourses] = useState([]);
  const [attendance, setAttendance] = useState({});
  const [activeCourse, setActiveCourse] = useState(null);
  const [currentWeek, setCurrentWeek] = useState(1);
  const [activeSession, setActiveSession] = useState(null);
  const [sessionSecret, setSessionSecret] = useState(null);
  const [bleStatus, setBleStatus] = useState('');
  const [isBleBusy, setIsBleBusy] = useState(false);
  const [rosterStatus, setRosterStatus] = useState('');
  const [isRosterUploading, setIsRosterUploading] = useState(false);
  const [manualStudent, setManualStudent] = useState({
    studentID: '',
    indexNumber: '',
    referenceNumber: '',
    fullName: ''
  });
  const [manualVerification, setManualVerification] = useState({
    studentID: '',
    reason: ''
  });
  const [manualVerificationStudent, setManualVerificationStudent] = useState(null);
  const [manualVerificationLookupStatus, setManualVerificationLookupStatus] = useState('');
  const [historyRows, setHistoryRows] = useState([]);
  const [historySummary, setHistorySummary] = useState([]);
  const [historySearchTerm, setHistorySearchTerm] = useState('');
  const [historySortDirection, setHistorySortDirection] = useState('asc');
  const [isHistoryLoading, setIsHistoryLoading] = useState(false);
  const [editWeek, setEditWeek] = useState(1);
  const [editSearchTerm, setEditSearchTerm] = useState('');
  const [correctionStatus, setCorrectionStatus] = useState('');
  const [isCorrectionSaving, setIsCorrectionSaving] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [darkMode, setDarkMode] = useState(false);
  const [view, setView] = useState('hub');

  useEffect(() => {
    if (!user?.id) return;

    const q = query(collection(db, "courses"), where("lecturerId", "==", user.id));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      setCourses(snapshot.docs.map(courseDoc => ({ ...courseDoc.data(), id: courseDoc.id })));
    });

    return () => unsubscribe();
  }, [user.id]);

  useEffect(() => {
    if (!activeCourse) return;

    const sessionKey = getSessionKey(activeCourse.code, currentWeek);
    const q = query(collection(db, "attendance", sessionKey, "records"), orderBy("timestamp", "desc"));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      setAttendance(prev => ({
        ...prev,
        [sessionKey]: snapshot.docs.map(recordDoc => recordDoc.data())
      }));
    });

    return () => unsubscribe();
  }, [activeCourse, currentWeek]);

  useEffect(() => {
    if (!activeCourse) {
      setActiveSession(null);
      setSessionSecret(null);
      setBleStatus('');
      return;
    }

    const sessionKey = getSessionKey(activeCourse.code, currentWeek);
    const unsubscribe = onSnapshot(doc(db, "attendance", sessionKey), (snapshot) => {
      const sessionData = snapshot.exists() ? snapshot.data() : null;
      setActiveSession(sessionData);
      if (!sessionData?.active) return;

      setBleStatus('Lecturer QR session active. Project the QR code for students to scan.');
    });

    return () => unsubscribe();
  }, [activeCourse, currentWeek]);

  // The QR session code and lecturer GPS live in a lecturer-only secure
  // subdocument. Students prove they saw the projected QR by submitting the
  // code through the Cloud Function after scanning.
  useEffect(() => {
    if (!activeCourse) {
      setSessionSecret(null);
      return;
    }

    const sessionKey = getSessionKey(activeCourse.code, currentWeek);
    const unsubscribe = onSnapshot(
      doc(db, "attendance", sessionKey, "secure", "state"),
      (snapshot) => setSessionSecret(snapshot.exists() ? snapshot.data() : null),
      () => setSessionSecret(null)
    );

    return () => unsubscribe();
  }, [activeCourse, currentWeek]);

  const addCourse = async (e) => {
    e.preventDefault();

    await addDoc(collection(db, "courses"), {
      name: e.target.cn.value,
      code: e.target.cc.value,
      lecturerId: user.id,
      createdAt: serverTimestamp()
    });

    e.target.reset();
  };

  const getRegisteredStudentsForCourse = useCallback(async () => {
    if (!activeCourse) return [];

    const rosterSnapshot = await getDocs(collection(db, "courses", activeCourse.id, "students"));
    return rosterSnapshot.docs.map(studentDoc => ({
      uid: studentDoc.id,
      ...studentDoc.data()
    })).filter(student => student.studentID);
  }, [activeCourse]);

  const parseRosterFile = async (file) => {
    const rows = await readRosterRows(file);
    const headerInfo = getRosterHeaderInfo(rows);

    if (!headerInfo) {
      throw new Error('No roster table header was found. Expected columns like Student ID, Index No., and Name.');
    }

    const studentsById = new Map();

    rows.slice(headerInfo.dataStartIndex ?? headerInfo.rowIndex + 1).forEach(row => {
      const studentIDFromFile = headerInfo.studentIdIndex >= 0
        ? cleanIdentifier(row[headerInfo.studentIdIndex])
        : '';
      const indexNumber = headerInfo.indexNumberIndex >= 0
        ? cleanIdentifier(row[headerInfo.indexNumberIndex])
        : '';
      const explicitReferenceNumber = headerInfo.referenceNumberIndex >= 0
        ? cleanIdentifier(row[headerInfo.referenceNumberIndex])
        : '';
      const referenceNumber = explicitReferenceNumber || studentIDFromFile;
      const studentID = studentIDFromFile || referenceNumber || indexNumber;
      const fallbackName = [cleanDisplayText(row[headerInfo.firstNameIndex]), cleanDisplayText(row[headerInfo.lastNameIndex])]
        .filter(Boolean)
        .join(' ');
      const fullName = headerInfo.nameIndex >= 0 ? cleanDisplayText(row[headerInfo.nameIndex]) : fallbackName;

      if (!studentID || !fullName) return;

      studentsById.set(studentID, {
        studentID,
        knust_id: studentID,
        indexNumber,
        referenceNumber,
        fullName,
        name: fullName,
        deviceName: headerInfo.deviceNameIndex >= 0 && cleanDisplayText(row[headerInfo.deviceNameIndex], 80)
          ? cleanDisplayText(row[headerInfo.deviceNameIndex], 80)
          : getStudentDeviceName(indexNumber || studentID),
        alternateDeviceNames: [studentID, indexNumber, referenceNumber]
          .filter(Boolean)
          .map(value => getStudentDeviceName(value)),
        courseId: activeCourse.id,
        courseCode: normalizeCourseCode(activeCourse.code),
        importedAt: serverTimestamp()
      });
    });

    const students = Array.from(studentsById.values());

    if (!students.length) {
      throw new Error('No valid student rows were found in the roster file.');
    }

    return students;
  };

  const handleRosterUpload = async (event) => {
    const file = event.target.files?.[0];
    if (!file || !activeCourse) return;

    setIsRosterUploading(true);
    setRosterStatus('Importing roster...');

    try {
      const students = await parseRosterFile(file);
      let batch = writeBatch(db);
      let operationCount = 0;

      const commitBatch = async () => {
        if (!operationCount) return;
        await batch.commit();
        batch = writeBatch(db);
        operationCount = 0;
      };

      for (const student of students) {
        batch.set(doc(db, "courses", activeCourse.id, "students", student.studentID), student, { merge: true });
        operationCount += 1;

        if (operationCount >= 450) {
          await commitBatch();
        }
      }

      batch.set(doc(db, "courses", activeCourse.id), {
        rosterCount: students.length,
        rosterUpdatedAt: serverTimestamp()
      }, { merge: true });
      operationCount += 1;
      await commitBatch();

      setActiveCourse(prev => prev?.id === activeCourse.id
        ? { ...prev, rosterCount: students.length }
        : prev
      );
      setRosterStatus(`Imported ${students.length} students. Stored Student ID, Index No., Reference No., and Name.`);
    } catch (error) {
      console.error('Roster upload failed:', error);
      setRosterStatus(error.message || 'Unable to import roster.');
    } finally {
      event.target.value = '';
      setIsRosterUploading(false);
    }
  };

  const handleManualStudentAdd = async (event) => {
    event.preventDefault();
    if (!activeCourse) return;

    const studentID = cleanIdentifier(manualStudent.studentID);
    const indexNumber = cleanIdentifier(manualStudent.indexNumber);
    const referenceNumber = cleanIdentifier(manualStudent.referenceNumber);
    const fullName = cleanDisplayText(manualStudent.fullName);

    if (!studentID || !fullName) {
      setRosterStatus('Student ID and full name are required.');
      return;
    }

    if (!/^\d{6,12}$/.test(studentID)) {
      setRosterStatus('Student ID must be 6 to 12 digits.');
      return;
    }

    try {
      const student = {
        studentID,
        knust_id: studentID,
        indexNumber,
        referenceNumber: referenceNumber || studentID,
        fullName,
        name: fullName,
        deviceName: getStudentDeviceName(indexNumber || studentID),
        alternateDeviceNames: [studentID, indexNumber, referenceNumber]
          .filter(Boolean)
          .map(value => getStudentDeviceName(value)),
        courseId: activeCourse.id,
        courseCode: normalizeCourseCode(activeCourse.code),
        manuallyAdded: true,
        updatedAt: serverTimestamp()
      };

      await setDoc(doc(db, "courses", activeCourse.id, "students", studentID), student, { merge: true });

      const rosterSnapshot = await getDocs(collection(db, "courses", activeCourse.id, "students"));
      await setDoc(doc(db, "courses", activeCourse.id), {
        rosterCount: rosterSnapshot.size,
        rosterUpdatedAt: serverTimestamp()
      }, { merge: true });

      setActiveCourse(prev => prev?.id === activeCourse.id
        ? { ...prev, rosterCount: rosterSnapshot.size }
        : prev
      );
      setManualStudent({ studentID: '', indexNumber: '', referenceNumber: '', fullName: '' });
      setRosterStatus(`${fullName} added to ${activeCourse.code}.`);
    } catch (error) {
      console.error('Manual student add failed:', error);
      setRosterStatus('Unable to add student. Please try again.');
    }
  };

  const getRosterStudentByIdentifier = useCallback(async (identifier) => {
    const cleanedIdentifier = cleanIdentifier(identifier);
    if (!activeCourse || !cleanedIdentifier) return null;

    const rosterCollection = collection(db, "courses", activeCourse.id, "students");
    const directSnap = await getDoc(doc(db, "courses", activeCourse.id, "students", cleanedIdentifier));

    if (directSnap.exists()) {
      return { studentID: directSnap.id, ...directSnap.data() };
    }

    const indexSnap = await getDocs(query(rosterCollection, where("indexNumber", "==", cleanedIdentifier)));
    if (!indexSnap.empty) {
      const rosterDoc = indexSnap.docs[0];
      return { studentID: rosterDoc.id, ...rosterDoc.data() };
    }

    const referenceSnap = await getDocs(query(rosterCollection, where("referenceNumber", "==", cleanedIdentifier)));
    if (!referenceSnap.empty) {
      const rosterDoc = referenceSnap.docs[0];
      return { studentID: rosterDoc.id, ...rosterDoc.data() };
    }

    return null;
  }, [activeCourse]);

  useEffect(() => {
    const identifier = cleanIdentifier(manualVerification.studentID);
    let isCancelled = false;

    setManualVerificationStudent(null);

    if (!activeCourse || identifier.length < 6) {
      setManualVerificationLookupStatus('');
      return () => {
        isCancelled = true;
      };
    }

    setManualVerificationLookupStatus('Looking up student...');
    const lookupTimer = window.setTimeout(async () => {
      try {
        const rosterStudent = await getRosterStudentByIdentifier(identifier);
        if (isCancelled) return;

        if (!rosterStudent) {
          setManualVerificationLookupStatus('No roster match found for this ID.');
          return;
        }

        setManualVerificationStudent(rosterStudent);
        setManualVerificationLookupStatus(`Matched: ${rosterStudent.fullName || rosterStudent.name || rosterStudent.studentID}`);
      } catch (error) {
        console.error('Manual verification lookup failed:', error);
        if (!isCancelled) setManualVerificationLookupStatus('Unable to look up this student right now.');
      }
    }, 300);

    return () => {
      isCancelled = true;
      window.clearTimeout(lookupTimer);
    };
  }, [activeCourse, getRosterStudentByIdentifier, manualVerification.studentID]);

  const updateSessionAbsentees = async (weekNumber) => {
    if (!activeCourse) return;

    const sessionKey = getSessionKey(activeCourse.code, weekNumber);
    const recordsSnapshot = await getDocs(collection(db, "attendance", sessionKey, "records"));
    const records = recordsSnapshot.docs.map(recordDoc => ({ id: recordDoc.id, ...recordDoc.data() }));
    const recordedIds = new Set(records.map(record => record.id || record.studentID));
    const verifiedCount = records.filter(isVerifiedRecord).length;
    const pendingCount = records.filter(record => record.status === 'Pending').length;
    const deniedCount = records.filter(record => record.status === 'Denied').length;
    const registeredStudents = await getRegisteredStudentsForCourse();
    const absentStudents = registeredStudents
      .filter(student => !recordedIds.has(student.studentID))
      .map(student => ({
        studentID: student.studentID,
        fullName: student.fullName || student.name || `Student ${student.studentID}`,
        indexNumber: student.indexNumber || '',
        referenceNumber: student.referenceNumber || '',
        deviceName: student.deviceName || getStudentDeviceName(student.studentID),
        status: "Absent"
      }));

    await setDoc(doc(db, "attendance", sessionKey), {
      courseCode: normalizeCourseCode(activeCourse.code),
      courseName: activeCourse.name,
      originalCourseCode: activeCourse.code,
      courseId: activeCourse.id,
      lecturerId: user.id,
      lecturerName: user.name,
      weekNumber,
      sessionKey,
      totalVerified: verifiedCount,
      pendingCount,
      deniedCount,
      absentCount: absentStudents.length,
      absentStudents,
      lastEditedAt: serverTimestamp(),
      lastEditedBy: user.id
    }, { merge: true });
  };

  const recordAttendance = async ({ studentID, fullName, method, deviceName, verificationNote = '' }) => {
    if (!activeCourse || !studentID) return { ok: false, reason: 'missing-student' };
    if (!activeSession?.active) return { ok: false, reason: 'inactive-session' };

    const sessionKey = getSessionKey(activeCourse.code, currentWeek);
    const cleanedStudentID = cleanIdentifier(studentID);
    const roster = await getRosterStudentByIdentifier(cleanedStudentID);
    const resolvedStudentID = roster?.studentID || cleanedStudentID;

    if (!roster && (activeCourse.rosterCount || 0) > 0) {
      return { ok: false, reason: 'not-rostered', studentID: resolvedStudentID };
    }

    const recordRef = doc(db, "attendance", sessionKey, "records", resolvedStudentID);
    const existingRecord = await getDoc(recordRef);
    const now = new Date();

    if (existingRecord.exists()) {
      const existing = existingRecord.data();

      if (isVerifiedRecord(existing)) {
        return {
          ok: false,
          alreadyVerified: true,
          studentID: resolvedStudentID,
          record: existing
        };
      }

      await setDoc(recordRef, {
        studentID: resolvedStudentID,
        indexNumber: roster?.indexNumber || existing.indexNumber || '',
        referenceNumber: roster?.referenceNumber || existing.referenceNumber || '',
        fullName: roster?.fullName || roster?.name || cleanDisplayText(fullName) || existing.fullName || `Student ${resolvedStudentID}`,
        deviceName: cleanDisplayText(deviceName, 80) || existing.deviceName || roster?.deviceName || getStudentDeviceName(resolvedStudentID),
        timeVerified: now.toLocaleTimeString(),
        verifiedAt: serverTimestamp(),
        verifiedAtIso: now.toISOString(),
        verificationDate: now.toLocaleDateString(),
        status: "Verified",
        timestamp: serverTimestamp(),
        method,
        verificationNote: cleanDisplayText(verificationNote, 160),
        verifiedBy: user.id,
        verifiedByName: user.name,
        requiresLecturerApproval: false,
        week: currentWeek,
        courseCode: normalizeCourseCode(activeCourse.code),
        sessionKey
      }, { merge: true });

      return { ok: true, studentID: resolvedStudentID, updatedExisting: true };
    }

    await setDoc(recordRef, {
      studentID: resolvedStudentID,
      indexNumber: roster?.indexNumber || '',
      referenceNumber: roster?.referenceNumber || '',
      fullName: roster?.fullName || roster?.name || cleanDisplayText(fullName) || `Student ${resolvedStudentID}`,
      deviceName: cleanDisplayText(deviceName, 80) || roster?.deviceName || getStudentDeviceName(resolvedStudentID),
      timeVerified: now.toLocaleTimeString(),
      verifiedAt: serverTimestamp(),
      verifiedAtIso: now.toISOString(),
      verificationDate: now.toLocaleDateString(),
      status: "Verified",
      timestamp: serverTimestamp(),
      method,
      verificationNote: cleanDisplayText(verificationNote, 160),
      verifiedBy: user.id,
      verifiedByName: user.name,
      week: currentWeek,
      courseCode: normalizeCourseCode(activeCourse.code),
      sessionKey
    }, { merge: true });

    return { ok: true, studentID: resolvedStudentID };
  };

  const handleManualPresenceVerification = async (event) => {
    event.preventDefault();

    if (!activeSession?.active) {
      setBleStatus('Start the attendance session before manually verifying a student.');
      return;
    }

    const studentID = cleanIdentifier(manualVerification.studentID);
    const reason = cleanDisplayText(manualVerification.reason, 160);

    if (!/^\d{6,12}$/.test(studentID) || !reason) {
      setBleStatus('Manual verification requires a valid student ID and reason.');
      return;
    }

    setIsBleBusy(true);

    try {
      const rosterStudent = manualVerificationStudent?.studentID
        ? manualVerificationStudent
        : await getRosterStudentByIdentifier(studentID);

      if (!rosterStudent) {
        setBleStatus(`${studentID} was not found on this course roster. Upload or add the student first, then verify again.`);
        return;
      }

      const resolvedFullName = rosterStudent.fullName || rosterStudent.name;

      if (!resolvedFullName) {
        setBleStatus(`${studentID} was found, but no student name is stored. Update the roster entry before verifying.`);
        return;
      }

      const result = await recordAttendance({
        studentID: rosterStudent.studentID,
        fullName: resolvedFullName,
        method: 'LECTURER_MANUAL',
        verificationNote: reason
      });

      if (result.alreadyVerified) {
        setBleStatus(`${resolvedFullName} was already verified for this session.`);
        return;
      }

      if (!result.ok) {
        setBleStatus('Manual verification could not be saved. Check the active session and student details.');
        return;
      }

      await recordCorrectionAudit({
        weekNumber: currentWeek,
        studentID: result.studentID,
        fullName: resolvedFullName,
        action: `lecturer-manual-present: ${reason}`
      });
      setManualVerification({ studentID: '', reason: '' });
      setManualVerificationStudent(null);
      setManualVerificationLookupStatus('');
      setBleStatus(`${resolvedFullName} verified manually by lecturer.`);
    } catch (error) {
      console.error('Manual attendance verification failed:', error);
      setBleStatus('Manual verification failed. Please check Firebase permissions and try again.');
    } finally {
      setIsBleBusy(false);
    }
  };

  const recordCorrectionAudit = async ({ weekNumber, studentID, fullName, action }) => {
    const sessionKey = getSessionKey(activeCourse.code, weekNumber);
    await addDoc(collection(db, "attendance", sessionKey, "audit"), {
      action,
      studentID,
      fullName,
      courseCode: normalizeCourseCode(activeCourse.code),
      weekNumber,
      editedBy: user.id,
      editedByName: user.name,
      editedAt: serverTimestamp()
    });
  };

  const markStudentPresentForWeek = async (student, weekNumber) => {
    if (!activeCourse || !student?.studentID) return;

    setIsCorrectionSaving(true);
    setCorrectionStatus('Saving correction...');

    try {
      const sessionKey = getSessionKey(activeCourse.code, weekNumber);
      const recordRef = doc(db, "attendance", sessionKey, "records", student.studentID);
      const existingRecord = await getDoc(recordRef);

      if (!existingRecord.exists()) {
        const now = new Date();
        await setDoc(recordRef, {
          studentID: student.studentID,
          indexNumber: student.indexNumber || '',
          referenceNumber: student.referenceNumber || '',
          fullName: student.fullName || student.name || `Student ${student.studentID}`,
          deviceName: student.deviceName || getStudentDeviceName(student.indexNumber || student.studentID),
          timeVerified: now.toLocaleTimeString(),
          verifiedAt: serverTimestamp(),
          verifiedAtIso: now.toISOString(),
          verificationDate: now.toLocaleDateString(),
          status: "Verified",
          timestamp: serverTimestamp(),
          method: "Manual Correction",
          correction: true,
          correctedBy: user.id,
          correctedByName: user.name,
          correctedAt: serverTimestamp(),
          week: weekNumber,
          courseCode: normalizeCourseCode(activeCourse.code),
          sessionKey
        }, { merge: true });

        await recordCorrectionAudit({
          weekNumber,
          studentID: student.studentID,
          fullName: student.fullName || student.name,
          action: 'marked-present'
        });
      }

      await updateSessionAbsentees(weekNumber);
      await loadCourseHistory();
      setCorrectionStatus(`${student.fullName || student.name || student.studentID} marked present for Week ${weekNumber}.`);
    } catch (error) {
      console.error('Correction present failed:', error);
      setCorrectionStatus('Unable to mark student present. Please try again.');
    } finally {
      setIsCorrectionSaving(false);
    }
  };

  const markStudentAbsentForWeek = async (student, weekNumber) => {
    if (!activeCourse || !student?.studentID) return;

    setIsCorrectionSaving(true);
    setCorrectionStatus('Saving correction...');

    try {
      const sessionKey = getSessionKey(activeCourse.code, weekNumber);
      await deleteDoc(doc(db, "attendance", sessionKey, "records", student.studentID));
      await recordCorrectionAudit({
        weekNumber,
        studentID: student.studentID,
        fullName: student.fullName || student.name,
        action: 'marked-absent'
      });
      await updateSessionAbsentees(weekNumber);
      await loadCourseHistory();
      setCorrectionStatus(`${student.fullName || student.name || student.studentID} marked absent for Week ${weekNumber}.`);
    } catch (error) {
      console.error('Correction absent failed:', error);
      setCorrectionStatus('Unable to mark student absent. Please try again.');
    } finally {
      setIsCorrectionSaving(false);
    }
  };

  const startQrSession = async () => {
    if (!activeCourse) return;

    if (!activeCourse.rosterCount) {
      setBleStatus('Upload or manually add students to this course roster before starting an attendance session.');
      return;
    }

    const sessionKey = getSessionKey(activeCourse.code, currentWeek);
    setIsBleBusy(true);
    setBleStatus('Preparing projected QR session and checking lecturer GPS...');

    try {
      const now = new Date();
      const nowMs = Date.now();
      const sessionCode = generateSessionCode();
      let lecturerLocation = null;

      try {
        lecturerLocation = toLocationRecord(requireUsableGpsAccuracy(await getRefinedPosition()), nowMs);
      } catch (locationError) {
        console.warn('Lecturer GPS unavailable; scan-only pending path will remain available:', locationError);
      }

      await setDoc(doc(db, "attendance", sessionKey), {
        active: true,
        courseCode: normalizeCourseCode(activeCourse.code),
        courseName: activeCourse.name,
        originalCourseCode: activeCourse.code,
        courseId: activeCourse.id,
        rosterCount: activeCourse.rosterCount || 0,
        lecturerId: user.id,
        lecturerName: user.name,
        weekNumber: currentWeek,
        method: "LECTURER_QR",
        verificationMode: "QR_GPS_OR_APPROVAL",
        sessionKey,
        locationThresholdMeters: QR_DISTANCE_METERS,
        lecturerLocationReady: Boolean(lecturerLocation),
        startedAt: serverTimestamp(),
        startedAtIso: now.toISOString(),
        sessionDate: now.toLocaleDateString(),
        endedAt: null,
        qrGeneratedAt: serverTimestamp(),
        locationUpdatedAt: serverTimestamp()
      }, { merge: true });

      const secureState = {
        sessionCode,
        locationThresholdMeters: QR_DISTANCE_METERS,
        qrIssuedAtMs: nowMs,
        updatedAt: serverTimestamp()
      };

      if (lecturerLocation) {
        secureState.lecturerLocation = lecturerLocation;
      }

      await setDoc(doc(db, "attendance", sessionKey, "secure", "state"), secureState, { merge: true });

      setBleStatus(lecturerLocation
        ? `Session active. Project the QR code. GPS auto-verification is enabled within ${QR_DISTANCE_METERS}m.`
        : 'Session active. Project the QR code. Lecturer GPS was unavailable, so student scans will require lecturer approval.'
      );
    } catch (error) {
      console.error("Unable to start QR session:", error);
      setBleStatus(error?.code === 1
        ? 'Location permission was blocked. You can retry, or continue with scan-only approvals if the session started.'
        : error.message || 'Unable to start QR attendance session. Please check Firebase permissions.'
      );
    } finally {
      setIsBleBusy(false);
    }
  };

  const endBleSession = async () => {
    if (!activeCourse) return;

    const sessionKey = getSessionKey(activeCourse.code, currentWeek);
    setIsBleBusy(true);
    setBleStatus('Ending session and calculating absentees...');

    try {
      const recordsSnapshot = await getDocs(collection(db, "attendance", sessionKey, "records"));
      const records = recordsSnapshot.docs.map(recordDoc => ({ id: recordDoc.id, ...recordDoc.data() }));
      const recordedIds = new Set(records.map(record => record.id || record.studentID));
      const verifiedCount = records.filter(isVerifiedRecord).length;
      const pendingCount = records.filter(record => record.status === 'Pending').length;
      const deniedCount = records.filter(record => record.status === 'Denied').length;
      const registeredStudents = await getRegisteredStudentsForCourse();
      const absentStudents = registeredStudents
        .filter(student => !recordedIds.has(student.studentID))
        .map(student => ({
          studentID: student.studentID,
          fullName: student.fullName || student.name || `Student ${student.studentID}`,
          indexNumber: student.indexNumber || '',
          referenceNumber: student.referenceNumber || '',
          deviceName: student.deviceName || getStudentDeviceName(student.studentID),
          status: "Absent"
        }));

      await setDoc(doc(db, "attendance", sessionKey), {
        active: false,
        endedAt: serverTimestamp(),
        totalVerified: verifiedCount,
        pendingCount,
        deniedCount,
        absentCount: absentStudents.length,
        absentStudents
      }, { merge: true });

      setBleStatus(`Session ended. ${verifiedCount} verified, ${pendingCount} pending approval, ${deniedCount} denied, ${absentStudents.length} no-scan absent.`);
    } catch (error) {
      console.error("Unable to end QR session:", error);
      setBleStatus('Unable to end session. Please check Firebase permissions and try again.');
    } finally {
      setIsBleBusy(false);
    }
  };

  const updatePendingRecord = async (record, decision) => {
    if (!activeCourse || !record?.studentID) return;

    const sessionKey = getSessionKey(activeCourse.code, currentWeek);
    const now = new Date();
    const isAccepted = decision === 'accept';

    await setDoc(doc(db, "attendance", sessionKey, "records", record.studentID), {
      status: isAccepted ? 'Verified' : 'Denied',
      method: isAccepted ? 'LECTURER_APPROVED_SCAN' : 'LECTURER_DENIED_SCAN',
      requiresLecturerApproval: false,
      approvedBy: isAccepted ? user.id : '',
      approvedByName: isAccepted ? user.name : '',
      approvedAt: isAccepted ? serverTimestamp() : null,
      deniedBy: isAccepted ? '' : user.id,
      deniedByName: isAccepted ? '' : user.name,
      deniedAt: isAccepted ? null : serverTimestamp(),
      timeVerified: isAccepted ? now.toLocaleTimeString() : record.timeVerified || '',
      verifiedAt: isAccepted ? serverTimestamp() : record.verifiedAt || null,
      verifiedAtIso: isAccepted ? now.toISOString() : record.verifiedAtIso || '',
      verificationDate: isAccepted ? now.toLocaleDateString() : record.verificationDate || now.toLocaleDateString(),
      timestamp: serverTimestamp()
    }, { merge: true });

    await recordCorrectionAudit({
      weekNumber: currentWeek,
      studentID: record.studentID,
      fullName: record.fullName,
      action: isAccepted ? 'approved-pending-scan' : 'denied-pending-scan'
    });

    setBleStatus(`${record.fullName || record.studentID} ${isAccepted ? 'accepted as present' : 'denied'} from the pending scan queue.`);
  };

  const updateAllPendingRecords = async (decision) => {
    const pending = pendingRecords;
    if (!activeCourse || !pending.length) return;

    setIsBleBusy(true);
    try {
      const sessionKey = getSessionKey(activeCourse.code, currentWeek);
      const now = new Date();
      const isAccepted = decision === 'accept';
      let batch = writeBatch(db);
      let operationCount = 0;

      const commitBatch = async () => {
        if (!operationCount) return;
        await batch.commit();
        batch = writeBatch(db);
        operationCount = 0;
      };

      pending.forEach(record => {
        batch.set(doc(db, "attendance", sessionKey, "records", record.studentID), {
          status: isAccepted ? 'Verified' : 'Denied',
          method: isAccepted ? 'LECTURER_APPROVED_SCAN' : 'LECTURER_DENIED_SCAN',
          requiresLecturerApproval: false,
          approvedBy: isAccepted ? user.id : '',
          approvedByName: isAccepted ? user.name : '',
          approvedAt: isAccepted ? serverTimestamp() : null,
          deniedBy: isAccepted ? '' : user.id,
          deniedByName: isAccepted ? '' : user.name,
          deniedAt: isAccepted ? null : serverTimestamp(),
          timeVerified: isAccepted ? now.toLocaleTimeString() : record.timeVerified || '',
          verifiedAt: isAccepted ? serverTimestamp() : record.verifiedAt || null,
          verifiedAtIso: isAccepted ? now.toISOString() : record.verifiedAtIso || '',
          verificationDate: isAccepted ? now.toLocaleDateString() : record.verificationDate || now.toLocaleDateString(),
          timestamp: serverTimestamp()
        }, { merge: true });
        operationCount += 1;
      });

      await commitBatch();
      await addDoc(collection(db, "attendance", sessionKey, "audit"), {
        action: isAccepted ? 'approved-all-pending-scans' : 'denied-all-pending-scans',
        count: pending.length,
        courseCode: normalizeCourseCode(activeCourse.code),
        weekNumber: currentWeek,
        editedBy: user.id,
        editedByName: user.name,
        editedAt: serverTimestamp()
      });

      setBleStatus(`${pending.length} pending scan${pending.length === 1 ? '' : 's'} ${isAccepted ? 'accepted' : 'denied'}.`);
    } catch (error) {
      console.error('Batch pending update failed:', error);
      setBleStatus('Unable to update pending scans. Please try again.');
    } finally {
      setIsBleBusy(false);
    }
  };

  const buildExportRows = async (weekNum) => {
    const selectedWeek = weekNum || currentWeek;
    const sessionKey = getSessionKey(activeCourse.code, selectedWeek);
    const recordsSnapshot = await getDocs(collection(db, "attendance", sessionKey, "records"));
    const sessionSnapshot = await getDoc(doc(db, "attendance", sessionKey));
    const recordRows = recordsSnapshot.docs.map(recordDoc => {
      const record = recordDoc.data();
      return {
        Course: normalizeCourseCode(activeCourse.code),
        Week: `Week ${selectedWeek}`,
        StudentID: record.studentID,
        FullName: record.fullName,
        IndexNumber: record.indexNumber || '',
        ReferenceNumber: record.referenceNumber || '',
        DeviceName: record.deviceName || '',
        Time: record.timeVerified,
        Status: record.status || "Verified",
        Method: formatMethodLabel(record.method)
      };
    });

    const recordedIds = new Set(recordRows.map(row => row.StudentID));
    const savedAbsentees = sessionSnapshot.exists() ? (sessionSnapshot.data().absentStudents || []) : [];
    const absentStudents = savedAbsentees.length
      ? savedAbsentees
      : (await getRegisteredStudentsForCourse())
          .filter(student => !recordedIds.has(student.studentID))
          .map(student => ({
            studentID: student.studentID,
            fullName: student.fullName || student.name || `Student ${student.studentID}`,
            indexNumber: student.indexNumber || '',
            referenceNumber: student.referenceNumber || '',
            deviceName: student.deviceName || getStudentDeviceName(student.studentID)
          }));

    const absentRows = absentStudents.map(student => ({
      Course: normalizeCourseCode(activeCourse.code),
      Week: `Week ${selectedWeek}`,
      StudentID: student.studentID,
      FullName: student.fullName,
      IndexNumber: student.indexNumber || '',
      ReferenceNumber: student.referenceNumber || '',
      DeviceName: student.deviceName || getStudentDeviceName(student.studentID),
      Time: '',
      Status: 'Absent',
      Method: 'No Scan'
    }));

    return [...recordRows, ...absentRows];
  };

  const downloadCSV = async (weekNum) => {
    if (!activeCourse) return;

    try {
      const selectedWeek = weekNum || currentWeek;
      const formattedData = await buildExportRows(selectedWeek);

      if (!formattedData.length) return alert("No student records found for this week.");

      const fields = ['Course', 'Week', 'StudentID', 'FullName', 'IndexNumber', 'ReferenceNumber', 'DeviceName', 'Time', 'Status', 'Method'];
      const parser = new Parser({ fields });
      const csv = parser.parse(formattedData.map(protectCsvRow));
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      const url = window.URL.createObjectURL(blob);
      a.href = url;
      a.download = `${normalizeCourseCode(activeCourse.code)}_Week${selectedWeek}.csv`;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error("CSV export failed:", error);
      alert("Unable to export attendance at this time.");
    }
  };

  const loadCourseHistory = useCallback(async () => {
    if (!activeCourse) return;

    setIsHistoryLoading(true);
    try {
      const roster = await getRegisteredStudentsForCourse();
      const allRows = [];
      const attendanceUpdates = {};

      for (const week of WEEKS) {
        const sessionKey = getSessionKey(activeCourse.code, week);
        const sessionSnap = await getDoc(doc(db, "attendance", sessionKey));
        const session = sessionSnap.exists() ? sessionSnap.data() : {};
        const recordsSnapshot = await getDocs(collection(db, "attendance", sessionKey, "records"));
        const records = recordsSnapshot.docs.map(recordDoc => recordDoc.data());

        attendanceUpdates[sessionKey] = records;

        records.forEach(record => {
          const verifiedDate = getDateValue(record.verifiedAt || record.timestamp || record.verifiedAtIso || session.startedAt || session.startedAtIso);
          allRows.push({
            ...record,
            week,
            sessionKey,
            courseCode: normalizeCourseCode(activeCourse.code),
            sessionDate: record.verificationDate || session.sessionDate || (verifiedDate ? verifiedDate.toLocaleDateString() : ''),
            dateTime: formatDateTime(verifiedDate || record.verifiedAtIso || session.startedAtIso),
            dateSort: verifiedDate ? verifiedDate.getTime() : 0
          });
        });
      }

      setAttendance(prev => ({ ...prev, ...attendanceUpdates }));
      setHistoryRows(allRows);

      const summaryById = new Map();
      roster.forEach(student => {
        summaryById.set(student.studentID, {
          studentID: student.studentID,
          indexNumber: student.indexNumber || '',
          referenceNumber: student.referenceNumber || '',
          fullName: student.fullName || student.name || `Student ${student.studentID}`,
          attendedCount: 0,
          sessions: [],
          lastVerified: ''
        });
      });

      allRows.filter(isVerifiedRecord).forEach(row => {
        const summary = summaryById.get(row.studentID) || {
          studentID: row.studentID,
          indexNumber: row.indexNumber || '',
          referenceNumber: row.referenceNumber || '',
          fullName: row.fullName || `Student ${row.studentID}`,
          attendedCount: 0,
          sessions: [],
          lastVerified: ''
        };

        summary.attendedCount += 1;
        summary.sessions.push(`W${row.week}`);
        if (!summary.lastVerified || row.dateSort > (summary.lastSort || 0)) {
          summary.lastVerified = row.dateTime;
          summary.lastSort = row.dateSort;
        }
        summaryById.set(row.studentID, summary);
      });

      setHistorySummary(Array.from(summaryById.values()));
    } catch (error) {
      console.error('History load failed:', error);
      setBleStatus('Unable to load attendance history right now.');
    } finally {
      setIsHistoryLoading(false);
    }
  }, [activeCourse, getRegisteredStudentsForCourse]);

  useEffect(() => {
    if (view === 'history' && activeCourse) {
      loadCourseHistory();
    }
  }, [view, activeCourse, loadCourseHistory]);

  const currentSessionKey = activeCourse ? getSessionKey(activeCourse.code, currentWeek) : '';
  const lecturerQrPayload = useMemo(() => (
    activeCourse && activeSession?.active && sessionSecret?.sessionCode
      ? JSON.stringify({
          type: 'KNUST_LECTURER_SESSION',
          sessionKey: currentSessionKey,
          sessionCode: sessionSecret.sessionCode,
          courseCode: normalizeCourseCode(activeCourse.code),
          originalCourseCode: activeCourse.code,
          weekNumber: currentWeek,
          issuedAtMs: sessionSecret.qrIssuedAtMs || Date.now()
        })
      : ''
  ), [activeCourse, activeSession?.active, currentSessionKey, currentWeek, sessionSecret?.qrIssuedAtMs, sessionSecret?.sessionCode]);
  const currentRecords = useMemo(() => attendance[currentSessionKey] || [], [attendance, currentSessionKey]);
  const sortedCurrentRecords = useMemo(() => sortByStudentId(currentRecords, 'asc'), [currentRecords]);
  const verifiedRecords = useMemo(() => currentRecords.filter(record => record.status === 'Verified'), [currentRecords]);
  const pendingRecords = useMemo(() => sortByStudentId(currentRecords.filter(record => record.status === 'Pending'), 'asc'), [currentRecords]);
  const deniedRecords = useMemo(() => currentRecords.filter(record => record.status === 'Denied'), [currentRecords]);
  const verifiedHistoryRows = useMemo(() => historyRows.filter(isVerifiedRecord), [historyRows]);
  const filteredHistoryRows = useMemo(() => {
    const term = historySearchTerm.trim().toLowerCase();
    const filteredRows = historyRows.filter(row => (
      !term ||
      (row.studentID || '').toLowerCase().includes(term) ||
      (row.indexNumber || '').toLowerCase().includes(term) ||
      (row.referenceNumber || '').toLowerCase().includes(term) ||
      (row.fullName || '').toLowerCase().includes(term)
    ));

    return sortByStudentId(filteredRows, historySortDirection);
  }, [historyRows, historySearchTerm, historySortDirection]);
  const filteredHistorySummary = useMemo(() => {
    const term = historySearchTerm.trim().toLowerCase();
    const filteredRows = historySummary.filter(row => (
      !term ||
      (row.studentID || '').toLowerCase().includes(term) ||
      (row.indexNumber || '').toLowerCase().includes(term) ||
      (row.referenceNumber || '').toLowerCase().includes(term) ||
      (row.fullName || '').toLowerCase().includes(term)
    ));

    return sortByStudentId(filteredRows, historySortDirection);
  }, [historySummary, historySearchTerm, historySortDirection]);
  const editableSessionRows = useMemo(() => {
    if (!activeCourse) return [];

    const sessionKey = getSessionKey(activeCourse.code, editWeek);
    const recordsById = new Map((attendance[sessionKey] || []).map(record => [record.studentID, record]));
    const rosterRows = historySummary.map(student => {
      const record = recordsById.get(student.studentID);
      const recordStatus = record?.status || 'Absent';
      return {
        ...student,
        ...record,
        fullName: record?.fullName || student.fullName,
        isPresent: recordStatus === 'Verified',
        hasRecord: Boolean(record),
        statusLabel: recordStatus
      };
    });

    recordsById.forEach(record => {
      if (!rosterRows.some(row => row.studentID === record.studentID)) {
        const recordStatus = record.status || 'Verified';
        rosterRows.push({
          ...record,
          attendedCount: recordStatus === 'Verified' ? 1 : 0,
          sessions: recordStatus === 'Verified' ? [`W${editWeek}`] : [],
          isPresent: recordStatus === 'Verified',
          hasRecord: true,
          statusLabel: recordStatus
        });
      }
    });

    const term = editSearchTerm.trim().toLowerCase();
    const filteredRows = rosterRows.filter(row => (
      !term ||
      (row.studentID || '').toLowerCase().includes(term) ||
      (row.indexNumber || '').toLowerCase().includes(term) ||
      (row.referenceNumber || '').toLowerCase().includes(term) ||
      (row.fullName || '').toLowerCase().includes(term)
    ));

    return sortByStudentId(filteredRows, historySortDirection);
  }, [activeCourse, attendance, editSearchTerm, editWeek, historySortDirection, historySummary]);
  const historyAttendanceRate = historySummary.length
    ? Math.round((verifiedHistoryRows.length / (historySummary.length * WEEKS.length)) * 100)
    : 0;

  return (
    <MotionDiv
      className={`dashboard-layout ${darkMode ? 'dark-theme' : ''}`}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.35 }}
    >
      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
        <div className="sidebar-header" style={{ marginBottom: '40px' }}>
          <img src="https://images.seeklogo.com/logo-png/35/2/kwame-nkrumah-university-of-science-technology-logo-png_seeklogo-350387.png" className="sidebar-logo" alt="KNUST" style={{ width: '80px', filter: 'drop-shadow(0 4px 10px rgba(0,0,0,0.2))' }} />
          <X className="mobile-close-btn" onClick={() => setSidebarOpen(false)} />
        </div>

        <nav className="sidebar-nav">
          <div className="nav-group">
            <p className="nav-label">Main Menu</p>
            <button onClick={() => { setView('hub'); setActiveCourse(null); setSidebarOpen(false); }} className={`nav-item ${view === 'hub' ? 'active-nav' : ''}`}>
              <LayoutGrid size={20} /> Academic Hub
            </button>
            <button
              onClick={() => { if(activeCourse) setView('history'); setSidebarOpen(false); }}
              className={`nav-item ${view === 'history' ? 'active-nav' : ''}`}
              disabled={!activeCourse}
              style={{ opacity: activeCourse ? 1 : 0.4 }}
            >
              <History size={20} /> Attendance History
            </button>
          </div>

          <div className="nav-group" style={{marginTop: '30px'}}>
            <p className="nav-label">UI Preferences</p>
            <button onClick={() => setDarkMode(!darkMode)} className="nav-item">
              {darkMode ? <Sun size={20} /> : <Moon size={20} />}
              {darkMode ? 'Light Theme' : 'Dark Theme'}
            </button>
          </div>

          {activeCourse && (
            <div className="nav-group" style={{marginTop: '30px'}}>
              <p className="nav-label">Switch Context</p>
              {courses.filter(c => c.id !== activeCourse.id).map(c => (
                <button key={c.id} onClick={() => { setActiveCourse(c); setView('session'); setSidebarOpen(false); }} className="nav-item-sub">
                  <div style={{display:'flex', alignItems:'center', gap: '8px'}}>
                    <div style={{width: '6px', height:'6px', borderRadius:'50%', background:'var(--knust-yellow)'}}></div>
                    {c.code}
                  </div>
                </button>
              ))}
            </div>
          )}
        </nav>

        <div className="sidebar-user-card" style={{marginTop: 'auto', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)'}}>
          <p style={{ fontSize: '0.65rem', opacity: 0.6, letterSpacing: '1px' }}>LOGGED IN AS</p>
          <p style={{fontSize: '0.95rem', margin: '4px 0'}}><strong>{user.name}</strong></p>
          <p style={{ fontSize: '0.75rem', opacity: 0.8, marginBottom: '12px' }}>ID: {user.id}</p>
          <button onClick={onLogout} className="mini-logout" style={{width: '100%', justifyContent:'center', display:'flex', gap: '8px'}}><LogOut size={14} /> Sign Out</button>
        </div>
      </aside>

      <main className="main-content">
        <header className="top-bar" style={{display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom: '30px'}}>
          <div style={{display:'flex', alignItems:'center', gap: '15px'}}>
            <button className="hamburger" onClick={() => setSidebarOpen(true)}><Menu size={28} /></button>
            <div>
              <h4 style={{fontSize: '0.75rem', color: 'var(--knust-green)', fontWeight: '800', textTransform: 'uppercase', letterSpacing: '2px'}}>Lecturer Portal</h4>
              <h1 style={{fontSize: '1.5rem', color: 'var(--knust-blue)', fontWeight: '900'}}>{activeCourse ? activeCourse.code : 'Academic Overview'}</h1>
            </div>
          </div>
          {activeCourse && view !== 'hub' && (
            <div className="course-badge" style={{background: 'var(--knust-blue)', color: 'white', padding: '6px 16px', borderRadius: '20px', fontSize: '0.85rem', fontWeight: '600'}}>
              {activeCourse.name}
            </div>
          )}
        </header>

        {view === 'hub' && (
          <div className="hub fade-in">
            <div className="welcome-banner" style={{marginBottom: '40px'}}>
              <h2 style={{fontSize: '2.5rem', fontWeight: '900', background: 'linear-gradient(45deg, var(--knust-blue), var(--knust-green))', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent'}}>
                Welcome back, {user.name.split(' ')[0]}!
              </h2>
              <p style={{fontSize: '1.1rem', color: 'var(--text-muted)', marginTop: '5px'}}>Select a course to start recording attendance or view semester analytics.</p>
            </div>

            <div className="table-card" style={{padding: '30px', border: '1px solid var(--knust-blue)', borderLeftWidth: '6px'}}>
              <h3 style={{marginBottom: '20px', fontSize: '1rem', color: 'var(--knust-blue)'}}>Quick Actions: Register New Course</h3>
              <form onSubmit={addCourse} style={{display: 'flex', gap: '15px', flexWrap: 'wrap'}}>
                <input name="cn" placeholder="Course Title (e.g. Thermodynamics)" required className="pro-input" style={{flex: 3}} />
                <input name="cc" placeholder="Code (e.g. ME 221)" required className="pro-input" style={{flex: 1}} />
                <button type="submit" className="pro-btn-primary" style={{padding: '12px 30px', boxShadow: '0 10px 15px rgba(0, 104, 55, 0.2)'}}>+ Add to Ledger</button>
              </form>
            </div>

            <div className="course-grid" style={{marginTop: '30px'}}>
              {courses.map(c => (
                <MotionDiv
                  key={c.id}
                  className="course-card"
                  onClick={() => { setActiveCourse(c); setView('session'); }}
                  style={{padding: '25px', border: '1px solid var(--border-color)'}}
                  whileHover={{ y: -5, boxShadow: '0 16px 30px rgba(0, 51, 102, 0.12)' }}
                  whileTap={{ scale: 0.99 }}
                  transition={{ type: 'spring', stiffness: 280, damping: 22 }}
                >
                  <div className="course-icon" style={{background: 'rgba(0, 51, 102, 0.1)', color: 'var(--knust-blue)'}}><BookOpen size={28} /></div>
                  <div className="course-info">
                    <strong style={{fontSize: '1.2rem'}}>{c.code}</strong>
                    <p style={{color: 'var(--text-muted)', fontSize: '0.9rem'}}>{c.name}</p>
                  </div>
                  <ChevronRight size={20} style={{marginLeft: 'auto', opacity: 0.3}} />
                </MotionDiv>
              ))}
            </div>
          </div>
        )}

        {view === 'session' && activeCourse && (
          <div className="session fade-in">
            <div className="session-header-card" style={{borderTop: '5px solid var(--knust-green)'}}>
              <div className="week-selector-box">
                <label style={{fontSize: '0.8rem', fontWeight: '700', color: 'var(--text-muted)', display: 'block', marginBottom: '8px'}}>SESSION WEEK</label>
                <select value={currentWeek} onChange={(e) => setCurrentWeek(parseInt(e.target.value))} className="week-dropdown" style={{minWidth: '150px'}}>
                  {WEEKS.map(w => <option key={w} value={w}>Academic Week {w}</option>)}
                </select>
              </div>
              <button onClick={() => downloadCSV()} className="btn-download" style={{background: 'var(--knust-blue)', height: 'fit-content'}}>
                <FileSpreadsheet size={18}/> Export CSV (Week {currentWeek})
              </button>
            </div>

            <div className="table-card" style={{borderLeft: '6px solid var(--knust-blue)'}}>
              <div style={{display: 'flex', justifyContent: 'space-between', gap: '20px', alignItems: 'center', flexWrap: 'wrap'}}>
                <div style={{display: 'flex', gap: '14px', alignItems: 'center'}}>
                  <Upload size={32} color="var(--knust-blue)" />
                  <div>
                    <h3 style={{fontSize: '1rem', color: 'var(--knust-blue)', marginBottom: '4px'}}>Course Roster</h3>
                    <p style={{color: 'var(--text-muted)', fontSize: '0.9rem'}}>Students loaded: <strong>{activeCourse.rosterCount || 0}</strong></p>
                    <p style={{color: 'var(--text-muted)', fontSize: '0.8rem'}}>Device format: KNUST_STU_INDEXNO or KNUST_STU_STUDENTID</p>
                  </div>
                </div>

                <label className="pro-btn-primary" style={{padding: '12px 24px', display: 'flex', alignItems: 'center', gap: '8px', cursor: isRosterUploading ? 'not-allowed' : 'pointer', opacity: isRosterUploading ? 0.7 : 1}}>
                  <FileSpreadsheet size={18} />
                  {isRosterUploading ? 'Importing...' : 'Upload CSV/Excel'}
                  <input
                    type="file"
                    accept=".csv,.xlsx"
                    onChange={handleRosterUpload}
                    disabled={isRosterUploading}
                    style={{display: 'none'}}
                  />
                </label>
              </div>

              {rosterStatus && (
                <div style={{
                  marginTop: '16px',
                  padding: '12px',
                  borderRadius: '12px',
                  background: rosterStatus.startsWith('Imported') ? '#f0fdf4' : '#fffbeb',
                  color: rosterStatus.startsWith('Imported') ? '#166534' : '#92400e',
                  border: rosterStatus.startsWith('Imported') ? '1px solid #bbf7d0' : '1px solid #fde68a',
                  fontSize: '0.88rem',
                  fontWeight: 600
                }}>
                  {rosterStatus}
                </div>
              )}

              <form onSubmit={handleManualStudentAdd} className="manual-student-form" style={{display: 'grid', gridTemplateColumns: 'repeat(4, minmax(140px, 1fr)) auto', gap: '12px', marginTop: '18px'}}>
                <input
                  className="pro-input"
                  placeholder="Student ID"
                  value={manualStudent.studentID}
                  onChange={(e) => setManualStudent({...manualStudent, studentID: e.target.value})}
                  required
                />
                <input
                  className="pro-input"
                  placeholder="Index No."
                  value={manualStudent.indexNumber}
                  onChange={(e) => setManualStudent({...manualStudent, indexNumber: e.target.value})}
                />
                <input
                  className="pro-input"
                  placeholder="Reference No."
                  value={manualStudent.referenceNumber}
                  onChange={(e) => setManualStudent({...manualStudent, referenceNumber: e.target.value})}
                />
                <input
                  className="pro-input"
                  placeholder="Full Name"
                  value={manualStudent.fullName}
                  onChange={(e) => setManualStudent({...manualStudent, fullName: e.target.value})}
                  required
                />
                <button type="submit" className="pro-btn-primary" style={{display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px'}}>
                  <UserPlus size={18} /> Add
                </button>
              </form>
            </div>

            <div className="table-card" style={{borderLeft: `6px solid ${activeSession?.active ? 'var(--knust-green)' : 'var(--knust-yellow)'}`}}>
              <div style={{display: 'flex', justifyContent: 'space-between', gap: '20px', alignItems: 'center', flexWrap: 'wrap'}}>
                <div style={{display: 'flex', gap: '14px', alignItems: 'center'}}>
                  <QrCode size={34} color="var(--knust-blue)" />
                  <div>
                    <h3 style={{fontSize: '1rem', color: 'var(--knust-blue)', marginBottom: '4px'}}>Projected QR Attendance Session</h3>
                    <p style={{color: 'var(--text-muted)', fontSize: '0.8rem'}}>
                      Students scan this lecturer QR. GPS auto-verifies within {QR_DISTANCE_METERS}m; scan-only submissions wait for your approval.
                      {sessionSecret?.lecturerLocation?.accuracy ? ` Lecturer GPS accuracy: +/-${sessionSecret.lecturerLocation.accuracy}m.` : ''}
                    </p>
                  </div>
                </div>

                <button
                  onClick={activeSession?.active ? endBleSession : startQrSession}
                  disabled={isBleBusy}
                  className={`scan-btn-master ${activeSession?.active ? 'is-active' : ''}`}
                  style={{minWidth: '220px'}}
                >
                  {activeSession?.active ? <Power size={18} /> : <MapPin size={18} />}
                  {isBleBusy ? 'Processing...' : activeSession?.active ? 'End Session' : 'Start QR Session'}
                </button>
              </div>

              {activeSession?.active && (
                <div className="qr-session-grid" style={{display: 'grid', gridTemplateColumns: 'minmax(240px, 360px) 1fr', gap: '20px', alignItems: 'center', marginTop: '22px'}}>
                  <div style={{background: '#fff', border: '4px solid var(--knust-blue)', borderRadius: '18px', padding: '18px', textAlign: 'center'}}>
                    {lecturerQrPayload ? (
                      <QRCodeCanvas value={lecturerQrPayload} size={300} level="H" includeMargin />
                    ) : (
                      <div style={{height: '300px', display: 'grid', placeItems: 'center', color: 'var(--text-muted)', fontWeight: 700}}>
                        Preparing QR...
                      </div>
                    )}
                    <p style={{fontSize: '0.82rem', color: 'var(--text-muted)', marginTop: '10px', fontWeight: 700}}>
                      {activeCourse.code} - Week {currentWeek}
                    </p>
                  </div>

                  <div className="stats-grid" style={{margin: 0}}>
                    <div className="stat-card" style={{borderLeft: '5px solid var(--knust-green)'}}><h3>Verified</h3><p>{verifiedRecords.length}</p></div>
                    <div className="stat-card" style={{borderLeft: '5px solid var(--knust-yellow)'}}><h3>Pending</h3><p>{pendingRecords.length}</p></div>
                    <div className="stat-card" style={{borderLeft: '5px solid #be123c'}}><h3>Denied</h3><p>{deniedRecords.length}</p></div>
                    <div className="stat-card" style={{borderLeft: '5px solid var(--knust-blue)'}}><h3>Roster</h3><p>{activeCourse.rosterCount || 0}</p></div>
                  </div>
                </div>
              )}

              {bleStatus && (
                <div style={{
                  marginTop: '18px',
                  padding: '12px',
                  borderRadius: '12px',
                  display: 'flex',
                  gap: '10px',
                  alignItems: 'flex-start',
                  background: activeSession?.active ? '#f0fdf4' : '#fffbeb',
                  color: activeSession?.active ? '#166534' : '#92400e',
                  border: activeSession?.active ? '1px solid #bbf7d0' : '1px solid #fde68a'
                }}>
                  {activeSession?.active ? <CheckCircle size={18} /> : <AlertCircle size={18} />}
                  <span style={{fontSize: '0.88rem', fontWeight: 600}}>{bleStatus}</span>
                </div>
              )}

              {pendingRecords.length > 0 && (
                <div className="table-card table-wrapper" style={{marginTop: '20px', marginBottom: 0, borderLeft: '5px solid var(--knust-yellow)'}}>
                  <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap', marginBottom: '14px'}}>
                    <div>
                      <h3 style={{fontSize: '1rem', color: 'var(--knust-blue)'}}>Pending Scan-Only Confirmations</h3>
                      <p style={{fontSize: '0.82rem', color: 'var(--text-muted)'}}>These students scanned successfully but need lecturer confirmation because GPS was unavailable or restricted.</p>
                    </div>
                    <div style={{display: 'flex', gap: '10px', flexWrap: 'wrap'}}>
                      <button type="button" className="mini-action-btn present" disabled={isBleBusy} onClick={() => updateAllPendingRecords('accept')}>Allow All</button>
                      <button type="button" className="mini-action-btn absent" disabled={isBleBusy} onClick={() => updateAllPendingRecords('deny')}>Deny All</button>
                    </div>
                  </div>
                  <table className="pro-table">
                    <thead><tr><th>Student</th><th>Index / Ref</th><th>Requested</th><th>Reason</th><th>Decision</th></tr></thead>
                    <tbody>
                      {pendingRecords.map(record => (
                        <tr key={`pending-${record.studentID}`}>
                          <td><div className="student-cell"><span className="s-id">{record.studentID}</span><span className="s-name">{record.fullName}</span></div></td>
                          <td><div className="student-cell"><span className="s-id">{record.indexNumber || 'N/A'}</span><span className="s-name">{record.referenceNumber || 'No ref'}</span></div></td>
                          <td>{record.timeVerified || 'Just now'}</td>
                          <td>{record.pendingReason || 'Scan-only request'}</td>
                          <td>
                            <div style={{display: 'flex', gap: '8px', flexWrap: 'wrap'}}>
                              <button type="button" className="mini-action-btn present" disabled={isBleBusy} onClick={() => updatePendingRecord(record, 'accept')}>Accept</button>
                              <button type="button" className="mini-action-btn absent" disabled={isBleBusy} onClick={() => updatePendingRecord(record, 'deny')}>Deny</button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <form onSubmit={handleManualPresenceVerification} className="manual-student-form" style={{display: 'grid', gridTemplateColumns: 'minmax(160px, 0.9fr) minmax(240px, 1.5fr) auto', gap: '12px', marginTop: '18px'}}>
                <input
                  className="pro-input"
                  placeholder="Student ID"
                  value={manualVerification.studentID}
                  onChange={(event) => setManualVerification({...manualVerification, studentID: event.target.value})}
                  required
                />
                <input
                  className="pro-input"
                  placeholder="Reason for manual verification"
                  value={manualVerification.reason}
                  onChange={(event) => setManualVerification({...manualVerification, reason: event.target.value})}
                  required
                />
                <button type="submit" disabled={isBleBusy} className="pro-btn-primary" style={{display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px'}}>
                  <UserPlus size={18} /> Verify Present
                </button>
                {manualVerificationLookupStatus && (
                  <div style={{
                    gridColumn: '1 / -1',
                    padding: '10px 12px',
                    borderRadius: '12px',
                    background: manualVerificationStudent ? '#f0fdf4' : '#fffbeb',
                    color: manualVerificationStudent ? '#166534' : '#92400e',
                    border: manualVerificationStudent ? '1px solid #bbf7d0' : '1px solid #fde68a',
                    fontSize: '0.84rem',
                    fontWeight: 700
                  }}>
                    {manualVerificationLookupStatus}
                  </div>
                )}
              </form>
            </div>

            <div className="action-row" style={{display: 'flex', gap: '15px', marginBottom: '25px'}}>
              <div className="search-bar" style={{flex: 2, background: 'var(--card-bg)', border: '1px solid var(--border-color)', padding: '0 12px', borderRadius: '12px', display: 'flex', alignItems: 'center', gap: '10px'}}>
                <Search size={18} color="#94a3b8" />
                <input placeholder="Search student ID or Name..." onChange={(e) => setSearchTerm(e.target.value)} style={{border: 'none', outline: 'none', background: 'transparent', width: '100%', padding: '14px', color: 'var(--text-main)'}} />
              </div>
            </div>

            <div className="table-card table-wrapper">
              <div style={{padding: '20px', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap'}}>
                <h3 style={{fontSize: '1rem'}}>Live Attendance List</h3>
                <span style={{fontSize: '0.8rem', color: 'var(--knust-green)', fontWeight: '700'}}>
                  {verifiedRecords.length} Verified | {pendingRecords.length} Pending | {deniedRecords.length} Denied
                </span>
              </div>
              <table className="pro-table">
                <thead><tr><th>Student Details</th><th>Index / Ref</th><th>Check-in Time</th><th>Method</th><th>Verification</th></tr></thead>
                <tbody>
                  {sortedCurrentRecords
                    .filter(s => (
                      (s.studentID || '').includes(searchTerm) ||
                      (s.indexNumber || '').includes(searchTerm) ||
                      (s.referenceNumber || '').includes(searchTerm) ||
                      (s.fullName || '').toLowerCase().includes(searchTerm.toLowerCase())
                    ))
                    .map((s, i) => (
                      <tr key={`${s.studentID}-${i}`}>
                        <td><div className="student-cell"><span className="s-id">{s.studentID}</span><span className="s-name">{s.fullName}</span></div></td>
                        <td><div className="student-cell"><span className="s-id">{s.indexNumber || 'N/A'}</span><span className="s-name">{s.referenceNumber || 'No ref'}</span></div></td>
                        <td>{s.timeVerified}</td>
                        <td>{formatMethodLabel(s.method)}</td>
                        <td>
                          <span className={getStatusClassName(s.status)} style={{display: 'flex', alignItems: 'center', gap: '5px', width: 'fit-content'}}>
                            {s.status === 'Verified' ? <CheckCircle size={12}/> : <AlertCircle size={12}/>}
                            {s.status || 'Verified'}
                          </span>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {view === 'history' && activeCourse && (
          <div className="history-view fade-in">
            <div className="history-header" style={{marginBottom: '30px'}}>
              <button onClick={() => setView('session')} className="back-btn" style={{marginBottom: '20px'}}><ArrowLeft size={18}/> Back to Active Session</button>
              <h2 style={{fontSize: '2rem', color: 'var(--knust-blue)', fontWeight: '900'}}>Semester Ledger: {activeCourse.code}</h2>
              <p style={{color: 'var(--text-muted)'}}>Search attendance by student name, ID, index number, reference number, session, and date.</p>
            </div>

            <div className="stats-grid">
              <div className="stat-card" style={{borderLeft: '5px solid var(--knust-blue)'}}><h3>Total Verifications</h3><p>{verifiedHistoryRows.length}</p></div>
              <div className="stat-card" style={{borderLeft: '5px solid var(--knust-green)'}}><h3>Unique Students</h3><p>{new Set(verifiedHistoryRows.map(s => s.studentID)).size}</p></div>
              <div className="stat-card" style={{borderLeft: '5px solid var(--knust-yellow)'}}><h3>Weeks Recorded</h3><p>{WEEKS.filter(w => attendance[getSessionKey(activeCourse.code, w)]?.length > 0).length}</p></div>
              <div className="stat-card" style={{borderLeft: '5px solid var(--knust-green)'}}><h3>Semester Rate</h3><p>{historyAttendanceRate}%</p></div>
            </div>

            <div className="table-card">
              <div className="history-toolbar" style={{display: 'flex', gap: '12px', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap'}}>
                <div className="search-bar" style={{flex: '1 1 280px', background: 'var(--card-bg)', border: '1px solid var(--border-color)', padding: '0 12px', borderRadius: '12px', display: 'flex', alignItems: 'center', gap: '10px'}}>
                  <Search size={18} color="#94a3b8" />
                  <input
                    placeholder="Search name, student ID, index no., or reference no."
                    value={historySearchTerm}
                    onChange={(e) => setHistorySearchTerm(e.target.value)}
                    style={{border: 'none', outline: 'none', background: 'transparent', width: '100%', padding: '14px', color: 'var(--text-main)'}}
                  />
                </div>
                <button
                  className="btn-download"
                  onClick={() => setHistorySortDirection(prev => prev === 'asc' ? 'desc' : 'asc')}
                  style={{padding: '10px 16px'}}
                >
                  {historySortDirection === 'asc' ? <SortAsc size={18} /> : <SortDesc size={18} />}
                  ID {historySortDirection === 'asc' ? 'Ascending' : 'Descending'}
                </button>
                <button className="btn-download" onClick={loadCourseHistory} style={{padding: '10px 16px'}}>
                  <ClipboardList size={18} /> {isHistoryLoading ? 'Refreshing...' : 'Refresh'}
                </button>
              </div>
            </div>

            <div className="table-card table-wrapper" style={{borderLeft: '6px solid var(--knust-green)'}}>
              <div style={{padding: '20px', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap'}}>
                <div>
                  <h3 style={{fontSize: '1rem'}}>Session Correction Console</h3>
                  <p style={{fontSize: '0.82rem', color: 'var(--text-muted)', marginTop: '4px'}}>Edit attendance for any week, including sessions that have already ended.</p>
                </div>
                <div style={{display: 'flex', gap: '10px', flexWrap: 'wrap'}}>
                  <select value={editWeek} onChange={(e) => setEditWeek(parseInt(e.target.value))} className="week-dropdown">
                    {WEEKS.map(w => <option key={w} value={w}>Week {w}</option>)}
                  </select>
                  <div className="search-bar" style={{background: 'var(--card-bg)', border: '1px solid var(--border-color)', padding: '0 12px', borderRadius: '12px', display: 'flex', alignItems: 'center', gap: '10px'}}>
                    <Search size={18} color="#94a3b8" />
                    <input
                      placeholder="Find student to correct..."
                      value={editSearchTerm}
                      onChange={(e) => setEditSearchTerm(e.target.value)}
                      style={{border: 'none', outline: 'none', background: 'transparent', width: '220px', padding: '12px', color: 'var(--text-main)'}}
                    />
                  </div>
                </div>
              </div>

              {correctionStatus && (
                <div style={{
                  margin: '16px 20px',
                  padding: '12px',
                  borderRadius: '12px',
                  background: correctionStatus.includes('Unable') ? '#fee2e2' : '#f0fdf4',
                  color: correctionStatus.includes('Unable') ? '#b91c1c' : '#166534',
                  border: correctionStatus.includes('Unable') ? '1px solid #fecaca' : '1px solid #bbf7d0',
                  fontSize: '0.88rem',
                  fontWeight: 700
                }}>
                  {correctionStatus}
                </div>
              )}

              <table className="pro-table">
                <thead><tr><th>Student</th><th>Index / Ref</th><th>Week {editWeek} Status</th><th>Last Method</th><th>Correction</th></tr></thead>
                <tbody>
                  {editableSessionRows.map(student => (
                    <tr key={`edit-${student.studentID}`}>
                      <td><div className="student-cell"><span className="s-id">{student.studentID}</span><span className="s-name">{student.fullName}</span></div></td>
                      <td><div className="student-cell"><span className="s-id">{student.indexNumber || 'N/A'}</span><span className="s-name">{student.referenceNumber || 'No ref'}</span></div></td>
                      <td>
                        <span className={getStatusClassName(student.statusLabel)}>
                          {student.isPresent ? 'Present' : student.statusLabel || 'Absent'}
                        </span>
                      </td>
                      <td>{student.method ? formatMethodLabel(student.method) : 'N/A'}</td>
                      <td>
                        <div style={{display: 'flex', gap: '8px', flexWrap: 'wrap'}}>
                          <button
                            type="button"
                            className="mini-action-btn present"
                            disabled={isCorrectionSaving || student.isPresent}
                            onClick={() => markStudentPresentForWeek(student, editWeek)}
                          >
                            Mark Present
                          </button>
                          <button
                            type="button"
                            className="mini-action-btn absent"
                            disabled={isCorrectionSaving || !student.hasRecord}
                            onClick={() => markStudentAbsentForWeek(student, editWeek)}
                          >
                            Mark Absent
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="table-card table-wrapper">
              <div style={{padding: '20px', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap'}}>
                <div>
                  <h3 style={{fontSize: '1rem'}}>Student Attendance Summary</h3>
                  <p style={{fontSize: '0.82rem', color: 'var(--text-muted)', marginTop: '4px'}}>Total classes attended per student for {activeCourse.code}</p>
                </div>
                <span style={{fontSize: '0.8rem', color: 'var(--knust-green)', fontWeight: '700'}}>{filteredHistorySummary.length} Students</span>
              </div>
              <table className="pro-table">
                <thead><tr><th>Student</th><th>Index / Ref</th><th>Classes Attended</th><th>Sessions</th><th>Last Verified</th></tr></thead>
                <tbody>
                  {filteredHistorySummary.map((s) => (
                    <tr key={s.studentID}>
                      <td><div className="student-cell"><span className="s-id">{s.studentID}</span><span className="s-name">{s.fullName}</span></div></td>
                      <td><div className="student-cell"><span className="s-id">{s.indexNumber || 'N/A'}</span><span className="s-name">{s.referenceNumber || 'No ref'}</span></div></td>
                      <td><strong>{s.attendedCount}</strong></td>
                      <td>{s.sessions.join(', ') || 'None'}</td>
                      <td>{s.lastVerified || 'Not yet verified'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="table-card table-wrapper">
              <div style={{padding: '20px', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap'}}>
                <div>
                  <h3 style={{fontSize: '1rem'}}>Complete Session Ledger</h3>
                  <p style={{fontSize: '0.82rem', color: 'var(--text-muted)', marginTop: '4px'}}>Every recorded verification by session and date</p>
                </div>
                <span style={{fontSize: '0.8rem', color: 'var(--knust-green)', fontWeight: '700'}}>{filteredHistoryRows.length} Records</span>
              </div>
              <table className="pro-table">
                <thead><tr><th>Student</th><th>Index / Ref</th><th>Session</th><th>Date</th><th>Method</th><th>Status</th></tr></thead>
                <tbody>
                  {filteredHistoryRows.map((s, idx) => (
                    <tr key={`${s.sessionKey}-${s.studentID}-${idx}`}>
                      <td><div className="student-cell"><span className="s-id">{s.studentID}</span><span className="s-name">{s.fullName}</span></div></td>
                      <td><div className="student-cell"><span className="s-id">{s.indexNumber || 'N/A'}</span><span className="s-name">{s.referenceNumber || 'No ref'}</span></div></td>
                      <td><div style={{display: 'flex', alignItems: 'center', gap: '8px'}}><CalendarDays size={14} /> Week {s.week}</div></td>
                      <td>{s.dateTime || s.timeVerified || s.sessionDate}</td>
                      <td>{formatMethodLabel(s.method)}</td>
                      <td><span className={getStatusClassName(s.status)}>{s.status || 'Verified'}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!isHistoryLoading && filteredHistoryRows.length === 0 && (
                <div style={{textAlign: 'center', padding: '60px 0', opacity: 0.55}}>
                  <Users size={56} style={{margin: '0 auto 16px'}} />
                  <h3>No matching attendance records found.</h3>
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </MotionDiv>
  );
}
