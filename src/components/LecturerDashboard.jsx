import React, { useCallback, useMemo, useState, useEffect, lazy, Suspense } from 'react';
import { readSheet } from 'read-excel-file/browser';
import { AnimatePresence, motion } from 'framer-motion';
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
  KeyRound,
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

import Button from './ui/Button';
import { cn } from '../lib/cn';

const Scanner = lazy(() => import('./Scanner'));

const MotionDiv = motion.div;
const MotionAside = motion.aside;
const WEEKS = Array.from({ length: 15 }, (_, i) => i + 1);
const PIN_WINDOW_MS = 3 * 60 * 1000;
const PIN_DISTANCE_METERS = 100;
const QR_WINDOW_MS = 3 * 60 * 1000;
const MAX_ROSTER_FILE_BYTES = 2 * 1024 * 1024;
const MAX_ROSTER_ROWS = 5000;
const SUPPORTED_ROSTER_EXTENSIONS = ['csv', 'xlsx'];

const normalizeCourseCode = (code = '') => code.replace(/\s+/g, '').toUpperCase();
const getSessionKey = (courseCode, weekNumber) => `${normalizeCourseCode(courseCode)}-W${weekNumber}`;
const getStudentDeviceName = (studentID) => `KNUST_STU_${studentID}`;
const formatCountdown = (seconds = 0) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
const generatePin = () => {
  const entropy = new Uint32Array(1);
  globalThis.crypto.getRandomValues(entropy);
  return String(entropy[0] % 10000).padStart(4, '0');
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

const parseQrPayload = (rawResult) => {
  try {
    const parsed = JSON.parse(rawResult);
    return {
      type: cleanCell(parsed.type),
      studentID: cleanCell(parsed.studentID || parsed.knust_id || parsed.id),
      fullName: cleanCell(parsed.fullName || parsed.name),
      sessionKey: cleanCell(parsed.sessionKey),
      issuedAtMs: Number(parsed.issuedAtMs) || 0,
      method: 'QR'
    };
  } catch {
    const idMatch = rawResult.match(/ID:\s*(\d+)/i) || rawResult.match(/(\d{8})/);
    const nameMatch = rawResult.match(/Name:\s*([^|]+)/i);

    return {
      type: '',
      studentID: idMatch ? cleanCell(idMatch[1]) : '',
      fullName: nameMatch ? cleanCell(nameMatch[1]) : '',
      sessionKey: '',
      issuedAtMs: 0,
      method: 'QR'
    };
  }
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

export default function LecturerDashboard({ user, onLogout }) {
  const [courses, setCourses] = useState([]);
  const [attendance, setAttendance] = useState({});
  const [activeCourse, setActiveCourse] = useState(null);
  const [currentWeek, setCurrentWeek] = useState(1);
  const [activeSession, setActiveSession] = useState(null);
  const [sessionSecret, setSessionSecret] = useState(null);
  const [pinSecondsRemaining, setPinSecondsRemaining] = useState(0);
  const [bleStatus, setBleStatus] = useState('');
  const [isBleBusy, setIsBleBusy] = useState(false);
  const [isQrFallbackOpen, setIsQrFallbackOpen] = useState(false);
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

      setBleStatus('PIN + GPS session active. The current PIN is shown below.');
    });

    return () => unsubscribe();
  }, [activeCourse, currentWeek]);

  // The PIN and lecturer GPS live in a lecturer-only secure subdocument so
  // students can never read them. Subscribe so the lecturer can display the PIN.
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
    const presentIds = new Set(recordsSnapshot.docs.map(recordDoc => recordDoc.id));
    const registeredStudents = await getRegisteredStudentsForCourse();
    const absentStudents = registeredStudents
      .filter(student => !presentIds.has(student.studentID))
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
      totalVerified: recordsSnapshot.size,
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

    if (existingRecord.exists()) {
      return {
        ok: false,
        alreadyVerified: true,
        studentID: resolvedStudentID,
        record: existingRecord.data()
      };
    }

    const now = new Date();
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

  const handleQrScanSuccess = async (rawResult) => {
    if (!activeSession?.active) {
      setBleStatus('Start the attendance session before using QR fallback.');
      return;
    }

    try {
      const payload = parseQrPayload(rawResult);

      if (!payload.studentID) {
        setBleStatus('QR fallback failed. No valid student ID was found.');
        return;
      }

      if (payload.type !== 'KNUST_ATTENDANCE') {
        setBleStatus('QR fallback blocked. Ask the student to display the current in-app attendance QR code.');
        return;
      }

      if (payload.sessionKey && payload.sessionKey !== currentSessionKey) {
        setBleStatus('QR fallback blocked. This student code belongs to a different course or week.');
        return;
      }

      if (!payload.issuedAtMs || payload.issuedAtMs > Date.now() + 30000 || Date.now() - payload.issuedAtMs > QR_WINDOW_MS) {
        setBleStatus('QR fallback blocked. The student QR code has expired. Ask the student to refresh the code.');
        return;
      }

      const result = await recordAttendance({
        studentID: payload.studentID,
        fullName: payload.fullName,
        method: 'QR_FALLBACK',
        verificationNote: 'Lecturer scanned student in-app QR fallback.'
      });

      if (result.alreadyVerified) {
        setBleStatus(`${payload.fullName || payload.studentID} was already verified for this session.`);
        setIsQrFallbackOpen(false);
        return;
      }

      if (!result.ok) {
        setBleStatus(result.reason === 'not-rostered'
          ? `${payload.studentID} is not on this course roster. Add the student manually first, then verify again.`
          : 'QR fallback blocked. Check that the session is active and the code is valid.'
        );
        return;
      }

      setBleStatus(`${payload.fullName || payload.studentID} verified by QR fallback.`);
      setIsQrFallbackOpen(false);
    } catch (error) {
      console.error('QR fallback failed:', error);
      setBleStatus('QR fallback failed. Please try again.');
    }
  };

  const refreshPinSession = useCallback(async ({ silent = false } = {}) => {
    if (!activeCourse) return;

    const sessionKey = getSessionKey(activeCourse.code, currentWeek);
    const position = requireUsableGpsAccuracy(await getRefinedPosition());
    const nowMs = Date.now();
    const currentPin = generatePin();
    const pinExpiresAtMs = nowMs + PIN_WINDOW_MS;

    await setDoc(doc(db, "attendance", sessionKey), {
      pinIssuedAtMs: nowMs,
      pinExpiresAtMs,
      pinWindowMs: PIN_WINDOW_MS,
      locationThresholdMeters: PIN_DISTANCE_METERS,
      pinGeneratedAt: serverTimestamp(),
      locationUpdatedAt: serverTimestamp()
    }, { merge: true });

    await setDoc(doc(db, "attendance", sessionKey, "secure", "state"), {
      currentPin,
      lecturerLocation: toLocationRecord(position, nowMs),
      pinIssuedAtMs: nowMs,
      pinExpiresAtMs,
      pinWindowMs: PIN_WINDOW_MS,
      updatedAt: serverTimestamp()
    }, { merge: true });

    if (!silent) {
      setBleStatus(`PIN refreshed: ${currentPin}. It expires in 3 minutes.`);
    }
  }, [activeCourse, currentWeek]);

  const startPinSession = async () => {
    if (!activeCourse) return;

    if (!activeCourse.rosterCount) {
      setBleStatus('Upload or manually add students to this course roster before starting a secure attendance session.');
      return;
    }

    const sessionKey = getSessionKey(activeCourse.code, currentWeek);
    setIsBleBusy(true);
    setBleStatus('Requesting lecturer GPS and generating secure PIN...');

    try {
      const now = new Date();
      const nowMs = Date.now();
      const currentPin = generatePin();
      const pinExpiresAtMs = nowMs + PIN_WINDOW_MS;
      const position = requireUsableGpsAccuracy(await getRefinedPosition());

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
        method: "PIN_GPS",
        verificationMode: "PIN_GPS",
        sessionKey,
        pinIssuedAtMs: nowMs,
        pinExpiresAtMs,
        pinWindowMs: PIN_WINDOW_MS,
        locationThresholdMeters: PIN_DISTANCE_METERS,
        startedAt: serverTimestamp(),
        startedAtIso: now.toISOString(),
        sessionDate: now.toLocaleDateString(),
        endedAt: null,
        pinGeneratedAt: serverTimestamp(),
        locationUpdatedAt: serverTimestamp()
      }, { merge: true });

      await setDoc(doc(db, "attendance", sessionKey, "secure", "state"), {
        currentPin,
        lecturerLocation: toLocationRecord(position, nowMs),
        pinIssuedAtMs: nowMs,
        pinExpiresAtMs,
        pinWindowMs: PIN_WINDOW_MS,
        updatedAt: serverTimestamp()
      }, { merge: true });

      setBleStatus(`Session active. Current PIN: ${currentPin}. It will rotate every 3 minutes.`);
    } catch (error) {
      console.error("Unable to start PIN session:", error);
      setBleStatus(error?.code === 1
        ? 'Location permission is required to start a PIN + GPS session.'
        : error.message || 'Unable to start PIN + GPS session. Please check location and Firebase permissions.'
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
      const presentIds = new Set(recordsSnapshot.docs.map(recordDoc => recordDoc.id));
      const registeredStudents = await getRegisteredStudentsForCourse();
      const absentStudents = registeredStudents
        .filter(student => !presentIds.has(student.studentID))
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
        totalVerified: recordsSnapshot.size,
        absentCount: absentStudents.length,
        absentStudents
      }, { merge: true });

      setBleStatus(`Session ended. ${recordsSnapshot.size} verified, ${absentStudents.length} absent for exports.`);
    } catch (error) {
      console.error("Unable to end PIN session:", error);
      setBleStatus('Unable to end session. Please check Firebase permissions and try again.');
    } finally {
      setIsBleBusy(false);
    }
  };

  useEffect(() => {
    if (!activeCourse || !activeSession?.active || activeSession.method !== 'PIN_GPS') return;

    const rotationTimer = window.setInterval(() => {
      refreshPinSession({ silent: true }).catch((error) => {
        console.error('PIN rotation failed:', error);
        setBleStatus('PIN rotation paused. Keep location permission enabled and refresh the session.');
      });
    }, PIN_WINDOW_MS);

    return () => window.clearInterval(rotationTimer);
  }, [activeCourse, activeSession?.active, activeSession?.method, refreshPinSession]);

  useEffect(() => {
    if (!activeSession?.active || !activeSession.pinExpiresAtMs) {
      setPinSecondsRemaining(0);
      return;
    }

    const updateCountdown = () => {
      setPinSecondsRemaining(Math.max(0, Math.ceil((activeSession.pinExpiresAtMs - Date.now()) / 1000)));
    };
    updateCountdown();
    const countdownTimer = window.setInterval(updateCountdown, 1000);

    return () => window.clearInterval(countdownTimer);
  }, [activeSession?.active, activeSession?.pinExpiresAtMs]);

  const buildExportRows = async (weekNum) => {
    const selectedWeek = weekNum || currentWeek;
    const sessionKey = getSessionKey(activeCourse.code, selectedWeek);
    const recordsSnapshot = await getDocs(collection(db, "attendance", sessionKey, "records"));
    const sessionSnapshot = await getDoc(doc(db, "attendance", sessionKey));
    const presentRows = recordsSnapshot.docs.map(recordDoc => {
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
        Method: record.method || "PIN + GPS"
      };
    });

    const presentIds = new Set(presentRows.map(row => row.StudentID));
    const savedAbsentees = sessionSnapshot.exists() ? (sessionSnapshot.data().absentStudents || []) : [];
    const absentStudents = savedAbsentees.length
      ? savedAbsentees
      : (await getRegisteredStudentsForCourse())
          .filter(student => !presentIds.has(student.studentID))
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
      Method: 'PIN + GPS'
    }));

    return [...presentRows, ...absentRows];
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

      allRows.forEach(row => {
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
  const currentSessionPin = sessionSecret?.currentPin || '----';
  const currentRecords = useMemo(() => attendance[currentSessionKey] || [], [attendance, currentSessionKey]);
  const sortedCurrentRecords = useMemo(() => sortByStudentId(currentRecords, 'asc'), [currentRecords]);
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
      return {
        ...student,
        ...record,
        fullName: record?.fullName || student.fullName,
        isPresent: Boolean(record)
      };
    });

    recordsById.forEach(record => {
      if (!rosterRows.some(row => row.studentID === record.studentID)) {
        rosterRows.push({ ...record, attendedCount: 1, sessions: [`W${editWeek}`], isPresent: true });
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
    ? Math.round((historyRows.length / (historySummary.length * WEEKS.length)) * 100)
    : 0;

  return (
    <div className={cn('relative min-h-dvh', darkMode && 'dark')}>
      <div className="min-h-dvh bg-gradient-to-br from-slate-50 via-brand-50/40 to-grass-50/30 text-slate-800 transition-colors dark:from-slate-950 dark:via-slate-900 dark:to-slate-950 dark:text-slate-100">

        {/* Mobile overlay */}
        <AnimatePresence>
          {sidebarOpen && (
            <MotionDiv
              key="overlay"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setSidebarOpen(false)}
              className="fixed inset-0 z-30 bg-slate-900/50 backdrop-blur-sm lg:hidden"
            />
          )}
        </AnimatePresence>

        {/* Sidebar */}
        <MotionAside
          className={cn(
            'fixed inset-y-0 left-0 z-40 flex w-72 flex-col gap-6 overflow-y-auto px-5 py-7 text-white transition-transform duration-300 ease-out lg:translate-x-0',
            'bg-gradient-to-b from-brand-900 via-iris-900 to-brand-950',
            sidebarOpen ? 'translate-x-0' : '-translate-x-full'
          )}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <img
                src="https://images.seeklogo.com/logo-png/35/2/kwame-nkrumah-university-of-science-technology-logo-png_seeklogo-350387.png"
                alt="KNUST"
                className="size-11 rounded-2xl bg-white/10 p-1.5 backdrop-blur"
              />
              <div>
                <p className="text-sm font-bold leading-tight">KNUST</p>
                <p className="text-[0.7rem] uppercase tracking-[0.18em] text-white/60">Lecturer</p>
              </div>
            </div>
            <button
              onClick={() => setSidebarOpen(false)}
              className="grid size-9 place-items-center rounded-xl text-white/70 hover:bg-white/10 hover:text-white lg:hidden"
            >
              <X size={20} />
            </button>
          </div>

          <nav className="flex flex-col gap-1.5">
            <p className="px-2 pb-1 text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-white/40">Main Menu</p>
            <button
              onClick={() => { setView('hub'); setActiveCourse(null); setSidebarOpen(false); }}
              className={cn('nav-link', view === 'hub' && 'nav-link-active')}
            >
              <LayoutGrid size={18} /> Academic Hub
            </button>
            <button
              onClick={() => { if (activeCourse) setView('history'); setSidebarOpen(false); }}
              className={cn('nav-link disabled:cursor-not-allowed disabled:opacity-40', view === 'history' && 'nav-link-active')}
              disabled={!activeCourse}
            >
              <History size={18} /> Attendance History
            </button>
          </nav>

          <nav className="flex flex-col gap-1.5">
            <p className="px-2 pb-1 text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-white/40">UI Preferences</p>
            <button onClick={() => setDarkMode(!darkMode)} className="nav-link">
              {darkMode ? <Sun size={18} /> : <Moon size={18} />}
              {darkMode ? 'Light Theme' : 'Dark Theme'}
            </button>
          </nav>

          {activeCourse && courses.filter(c => c.id !== activeCourse.id).length > 0 && (
            <nav className="flex flex-col gap-1.5">
              <p className="px-2 pb-1 text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-white/40">Switch Context</p>
              {courses.filter(c => c.id !== activeCourse.id).map(c => (
                <button
                  key={c.id}
                  onClick={() => { setActiveCourse(c); setView('session'); setSidebarOpen(false); }}
                  className="nav-link text-white/60"
                >
                  <span className="size-1.5 rounded-full bg-grass-400" />
                  {c.code}
                </button>
              ))}
            </nav>
          )}

          <div className="mt-auto rounded-2xl border border-white/10 bg-white/5 p-4">
            <p className="text-[0.6rem] uppercase tracking-[0.18em] text-white/50">Logged in as</p>
            <p className="mt-1 text-sm font-bold">{user.name}</p>
            <p className="text-xs text-white/60">ID: {user.id}</p>
            <button
              onClick={onLogout}
              className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-white/10 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-white/20"
            >
              <LogOut size={14} /> Sign Out
            </button>
          </div>
        </MotionAside>

        <div className="lg:pl-72">
        <header className="sticky top-0 z-20 flex items-center justify-between gap-4 border-b border-slate-200/70 bg-white/70 px-4 py-3.5 backdrop-blur-xl sm:px-6 lg:px-8 dark:border-white/10 dark:bg-slate-900/60">
          <div className="flex items-center gap-3">
            <button
              className="grid size-10 place-items-center rounded-xl border border-slate-200 bg-white/80 text-slate-600 hover:bg-slate-50 lg:hidden dark:border-white/10 dark:bg-white/5 dark:text-slate-200"
              onClick={() => setSidebarOpen(true)}
            >
              <Menu size={20} />
            </button>
            <div>
              <p className="text-[0.7rem] font-bold uppercase tracking-[0.18em] text-grass-600">Lecturer Portal</p>
              <h1 className="text-lg font-extrabold leading-tight text-brand-900 sm:text-xl dark:text-white">
                {activeCourse ? activeCourse.code : 'Academic Overview'}
              </h1>
            </div>
          </div>
          {activeCourse && view !== 'hub' && (
            <span className="hidden rounded-full bg-gradient-to-r from-brand-600 to-iris-600 px-4 py-1.5 text-sm font-semibold text-white shadow-[var(--shadow-card)] sm:inline-block">
              {activeCourse.name}
            </span>
          )}
        </header>

        <main className="px-4 py-6 sm:px-6 sm:py-8 lg:px-8">

        {view === 'hub' && (
          <MotionDiv
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
            className="mx-auto max-w-6xl"
          >
            <div className="mb-8">
              <h2 className="text-3xl font-extrabold sm:text-4xl">
                Welcome back, <span className="text-gradient">{user.name.split(' ')[0]}</span>!
              </h2>
              <p className="mt-2 text-base text-slate-500 dark:text-slate-400">
                Select a course to start recording attendance or view semester analytics.
              </p>
            </div>

            <div className="panel p-6 sm:p-7">
              <div className="mb-5 flex items-center gap-3">
                <span className="grid size-10 place-items-center rounded-2xl bg-gradient-to-br from-brand-600 to-iris-600 text-white shadow-[var(--shadow-glow)]">
                  <BookOpen size={18} />
                </span>
                <h3 className="text-base font-bold text-slate-800 dark:text-slate-100">Register New Course</h3>
              </div>
              <form onSubmit={addCourse} className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
                <input name="cn" placeholder="Course Title (e.g. Thermodynamics)" required className="field sm:flex-[3]" />
                <input name="cc" placeholder="Code (e.g. ME 221)" required className="field sm:flex-1" />
                <Button type="submit" variant="success" className="sm:w-auto">
                  <UserPlus size={18} /> Add to Ledger
                </Button>
              </form>
            </div>

            <div className="mt-7 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {courses.map(c => (
                <MotionDiv
                  key={c.id}
                  onClick={() => { setActiveCourse(c); setView('session'); }}
                  whileHover={{ y: -5 }}
                  whileTap={{ scale: 0.99 }}
                  transition={{ type: 'spring', stiffness: 280, damping: 22 }}
                  className="panel group flex cursor-pointer items-center gap-4 p-5 hover:border-brand-200 dark:hover:border-iris-500/40"
                >
                  <div className="grid size-12 shrink-0 place-items-center rounded-2xl bg-brand-50 text-brand-700 transition-colors group-hover:bg-brand-100 dark:bg-white/5 dark:text-iris-300">
                    <BookOpen size={24} />
                  </div>
                  <div className="min-w-0">
                    <strong className="block truncate text-lg text-slate-800 dark:text-slate-100">{c.code}</strong>
                    <p className="truncate text-sm text-slate-500 dark:text-slate-400">{c.name}</p>
                  </div>
                  <ChevronRight size={20} className="ml-auto shrink-0 text-slate-300 transition-transform group-hover:translate-x-1 group-hover:text-brand-500" />
                </MotionDiv>
              ))}
              {courses.length === 0 && (
                <div className="panel-muted col-span-full grid place-items-center px-6 py-12 text-center">
                  <BookOpen size={40} className="mb-3 text-slate-300" />
                  <p className="text-sm font-medium text-slate-500 dark:text-slate-400">No courses yet — register one above to get started.</p>
                </div>
              )}
            </div>
          </MotionDiv>
        )}

        {view === 'session' && activeCourse && (
          <MotionDiv
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
            className="mx-auto flex max-w-6xl flex-col gap-5"
          >
            {/* Week + export */}
            <div className="panel flex flex-col gap-4 p-5 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <label className="mb-2 block text-xs font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">Session Week</label>
                <select value={currentWeek} onChange={(e) => setCurrentWeek(parseInt(e.target.value))} className="field sm:w-56">
                  {WEEKS.map(w => <option key={w} value={w}>Academic Week {w}</option>)}
                </select>
              </div>
              <Button variant="brand" onClick={() => downloadCSV()} className="sm:w-auto">
                <FileSpreadsheet size={18} /> Export CSV (Week {currentWeek})
              </Button>
            </div>

            {/* Roster */}
            <div className="panel p-5 sm:p-6">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-3">
                  <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-brand-50 text-brand-700 dark:bg-white/5 dark:text-iris-300">
                    <Upload size={22} />
                  </span>
                  <div>
                    <h3 className="text-base font-bold text-slate-800 dark:text-slate-100">Course Roster</h3>
                    <p className="text-sm text-slate-500 dark:text-slate-400">Students loaded: <strong className="text-slate-700 dark:text-slate-200">{activeCourse.rosterCount || 0}</strong></p>
                    <p className="text-xs text-slate-400">Device format: KNUST_STU_INDEXNO or KNUST_STU_STUDENTID</p>
                  </div>
                </div>

                <label className={cn(
                  'inline-flex cursor-pointer items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-brand-600 to-iris-600 px-5 py-3 text-sm font-semibold text-white shadow-[var(--shadow-card)] transition-opacity hover:opacity-95',
                  isRosterUploading && 'cursor-not-allowed opacity-70'
                )}>
                  <FileSpreadsheet size={18} />
                  {isRosterUploading ? 'Importing…' : 'Upload CSV/Excel'}
                  <input type="file" accept=".csv,.xlsx" onChange={handleRosterUpload} disabled={isRosterUploading} className="hidden" />
                </label>
              </div>

              {rosterStatus && (
                <div className={cn(
                  'mt-4 rounded-2xl border px-4 py-3 text-sm font-semibold',
                  rosterStatus.startsWith('Imported')
                    ? 'border-grass-200 bg-grass-50 text-grass-700 dark:border-grass-500/30 dark:bg-grass-500/10 dark:text-grass-300'
                    : 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300'
                )}>
                  {rosterStatus}
                </div>
              )}

              <form onSubmit={handleManualStudentAdd} className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <input className="field" placeholder="Student ID" value={manualStudent.studentID} onChange={(e) => setManualStudent({ ...manualStudent, studentID: e.target.value })} required />
                <input className="field" placeholder="Index No." value={manualStudent.indexNumber} onChange={(e) => setManualStudent({ ...manualStudent, indexNumber: e.target.value })} />
                <input className="field" placeholder="Reference No." value={manualStudent.referenceNumber} onChange={(e) => setManualStudent({ ...manualStudent, referenceNumber: e.target.value })} />
                <input className="field" placeholder="Full Name" value={manualStudent.fullName} onChange={(e) => setManualStudent({ ...manualStudent, fullName: e.target.value })} required />
                <Button type="submit" variant="outline" className="xl:col-span-4 xl:w-auto xl:justify-self-end">
                  <UserPlus size={18} /> Add Student
                </Button>
              </form>
            </div>

            {/* PIN session */}
            <div className="panel p-5 sm:p-6">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-3">
                  <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-brand-600 via-iris-600 to-grass-600 text-white shadow-[var(--shadow-glow)]">
                    <KeyRound size={22} />
                  </span>
                  <div>
                    <h3 className="text-base font-bold text-slate-800 dark:text-slate-100">PIN + GPS Attendance Session</h3>
                    <p className="text-sm text-slate-500 dark:text-slate-400">
                      Current PIN: <strong className="ml-1 font-mono text-2xl tracking-[0.3em] text-brand-700 dark:text-iris-300">{currentSessionPin}</strong>
                    </p>
                    <p className="mt-1 text-xs text-slate-400">
                      Next rotation: {formatCountdown(pinSecondsRemaining)}. GPS threshold: {PIN_DISTANCE_METERS}m.
                      {sessionSecret?.lecturerLocation?.accuracy ? ` Accuracy: +/-${sessionSecret.lecturerLocation.accuracy}m.` : ''}
                    </p>
                  </div>
                </div>

                <Button
                  onClick={activeSession?.active ? endBleSession : startPinSession}
                  disabled={isBleBusy}
                  isLoading={isBleBusy}
                  variant={activeSession?.active ? 'danger' : 'success'}
                  size="lg"
                  className="sm:min-w-56"
                >
                  {!isBleBusy && (activeSession?.active ? <Power size={18} /> : <MapPin size={18} />)}
                  {isBleBusy ? 'Processing…' : activeSession?.active ? 'End Session' : 'Start PIN Session'}
                </Button>
              </div>

              <div className="mt-4 flex flex-wrap gap-3">
                <Button variant="brand" size="sm" onClick={() => setIsQrFallbackOpen(prev => !prev)}>
                  <QrCode size={18} /> {isQrFallbackOpen ? 'Close QR Fallback' : 'Open QR Fallback'}
                </Button>
              </div>

              {bleStatus && (
                <div className={cn(
                  'mt-4 flex items-start gap-2.5 rounded-2xl border px-4 py-3 text-sm font-semibold',
                  activeSession?.active
                    ? 'border-grass-200 bg-grass-50 text-grass-700 dark:border-grass-500/30 dark:bg-grass-500/10 dark:text-grass-300'
                    : 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300'
                )}>
                  {activeSession?.active ? <CheckCircle size={18} className="shrink-0" /> : <AlertCircle size={18} className="shrink-0" />}
                  <span>{bleStatus}</span>
                </div>
              )}

              {isQrFallbackOpen && (
                <div className="mx-auto mt-5 max-w-xl overflow-hidden rounded-3xl border-2 border-brand-200 bg-white p-3 dark:border-iris-500/40 dark:bg-slate-900">
                  <Suspense fallback={<div className="p-6 text-center text-sm text-slate-400">Loading scanner…</div>}>
                    <Scanner onResult={handleQrScanSuccess} onClose={() => setIsQrFallbackOpen(false)} />
                  </Suspense>
                </div>
              )}

              <form onSubmit={handleManualPresenceVerification} className="mt-5 grid gap-3 sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1.5fr)_auto]">
                <input className="field" placeholder="Student ID" value={manualVerification.studentID} onChange={(event) => setManualVerification({ ...manualVerification, studentID: event.target.value })} required />
                <input className="field" placeholder="Reason for manual verification" value={manualVerification.reason} onChange={(event) => setManualVerification({ ...manualVerification, reason: event.target.value })} required />
                <Button type="submit" variant="iris" disabled={isBleBusy}>
                  <UserPlus size={18} /> Verify Present
                </Button>
                {manualVerificationLookupStatus && (
                  <div className={cn(
                    'rounded-2xl border px-4 py-2.5 text-sm font-semibold sm:col-span-full',
                    manualVerificationStudent
                      ? 'border-grass-200 bg-grass-50 text-grass-700 dark:border-grass-500/30 dark:bg-grass-500/10 dark:text-grass-300'
                      : 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300'
                  )}>
                    {manualVerificationLookupStatus}
                  </div>
                )}
              </form>
            </div>

            {/* Search */}
            <div className="relative">
              <Search size={18} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                placeholder="Search student ID or name…"
                onChange={(e) => setSearchTerm(e.target.value)}
                className="field h-12 pl-11"
              />
            </div>

            {/* Live attendance table */}
            <div className="panel overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-4 dark:border-white/10">
                <h3 className="text-base font-bold text-slate-800 dark:text-slate-100">Live Attendance List</h3>
                <span className="rounded-full bg-grass-50 px-3 py-1 text-xs font-bold text-grass-700 dark:bg-grass-500/10 dark:text-grass-300">
                  {currentRecords.length} Present
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs font-semibold uppercase tracking-wide text-slate-400">
                      <th className="px-5 py-3">Student Details</th>
                      <th className="px-5 py-3">Index / Ref</th>
                      <th className="px-5 py-3">Check-in</th>
                      <th className="px-5 py-3">Method</th>
                      <th className="px-5 py-3">Verification</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedCurrentRecords
                      .filter(s => (
                        (s.studentID || '').includes(searchTerm) ||
                        (s.indexNumber || '').includes(searchTerm) ||
                        (s.referenceNumber || '').includes(searchTerm) ||
                        (s.fullName || '').toLowerCase().includes(searchTerm.toLowerCase())
                      ))
                      .map((s, i) => (
                        <tr key={`${s.studentID}-${i}`} className="border-t border-slate-100 dark:border-white/5">
                          <td className="px-5 py-3">
                            <div className="flex flex-col">
                              <span className="font-semibold text-slate-800 dark:text-slate-100">{s.studentID}</span>
                              <span className="text-xs text-slate-400">{s.fullName}</span>
                            </div>
                          </td>
                          <td className="px-5 py-3">
                            <div className="flex flex-col">
                              <span className="font-medium text-slate-700 dark:text-slate-200">{s.indexNumber || 'N/A'}</span>
                              <span className="text-xs text-slate-400">{s.referenceNumber || 'No ref'}</span>
                            </div>
                          </td>
                          <td className="px-5 py-3 text-slate-600 dark:text-slate-300">{s.timeVerified}</td>
                          <td className="px-5 py-3 text-slate-600 dark:text-slate-300">{s.method || 'PIN + GPS'}</td>
                          <td className="px-5 py-3">
                            <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-grass-50 px-2.5 py-1 text-xs font-semibold text-grass-700 dark:bg-grass-500/10 dark:text-grass-300">
                              <CheckCircle size={12} /> Verified
                            </span>
                          </td>
                        </tr>
                      ))}
                    {currentRecords.length === 0 && (
                      <tr>
                        <td colSpan={5} className="px-5 py-12 text-center text-sm text-slate-400">
                          No students have checked in yet.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </MotionDiv>
        )}

        {view === 'history' && activeCourse && (
          <MotionDiv
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
            className="mx-auto flex max-w-6xl flex-col gap-5"
          >
            <div>
              <Button variant="ghost" size="sm" onClick={() => setView('session')} className="mb-4">
                <ArrowLeft size={18} /> Back to Active Session
              </Button>
              <h2 className="text-2xl font-extrabold sm:text-3xl">
                Semester Ledger: <span className="text-gradient">{activeCourse.code}</span>
              </h2>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                Search attendance by student name, ID, index number, reference number, session, and date.
              </p>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              {[
                { label: 'Total Verifications', value: historyRows.length, accent: 'from-brand-600 to-brand-400' },
                { label: 'Unique Students', value: new Set(historyRows.map(s => s.studentID)).size, accent: 'from-iris-600 to-iris-400' },
                { label: 'Weeks Recorded', value: WEEKS.filter(w => attendance[getSessionKey(activeCourse.code, w)]?.length > 0).length, accent: 'from-grass-600 to-grass-400' },
                { label: 'Semester Rate', value: `${historyAttendanceRate}%`, accent: 'from-brand-600 via-iris-600 to-grass-600' }
              ].map(stat => (
                <div key={stat.label} className="panel relative overflow-hidden p-5">
                  <span className={cn('absolute inset-x-0 top-0 h-1 bg-gradient-to-r', stat.accent)} />
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{stat.label}</p>
                  <p className="mt-2 text-2xl font-extrabold text-slate-800 dark:text-slate-100">{stat.value}</p>
                </div>
              ))}
            </div>

            {/* History toolbar */}
            <div className="panel flex flex-col gap-3 p-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
              <div className="relative flex-1 sm:min-w-[280px]">
                <Search size={18} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  placeholder="Search name, student ID, index no., or reference no."
                  value={historySearchTerm}
                  onChange={(e) => setHistorySearchTerm(e.target.value)}
                  className="field h-12 pl-11"
                />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => setHistorySortDirection(prev => prev === 'asc' ? 'desc' : 'asc')}>
                  {historySortDirection === 'asc' ? <SortAsc size={18} /> : <SortDesc size={18} />}
                  ID {historySortDirection === 'asc' ? 'Ascending' : 'Descending'}
                </Button>
                <Button variant="outline" size="sm" onClick={loadCourseHistory}>
                  <ClipboardList size={18} /> {isHistoryLoading ? 'Refreshing…' : 'Refresh'}
                </Button>
              </div>
            </div>

            {/* Correction console */}
            <div className="panel overflow-hidden">
              <div className="flex flex-col gap-3 border-b border-slate-100 px-5 py-4 lg:flex-row lg:items-center lg:justify-between dark:border-white/10">
                <div>
                  <h3 className="text-base font-bold text-slate-800 dark:text-slate-100">Session Correction Console</h3>
                  <p className="mt-0.5 text-xs text-slate-400">Edit attendance for any week, including sessions that have already ended.</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <select value={editWeek} onChange={(e) => setEditWeek(parseInt(e.target.value))} className="field h-11 w-auto">
                    {WEEKS.map(w => <option key={w} value={w}>Week {w}</option>)}
                  </select>
                  <div className="relative">
                    <Search size={18} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
                    <input
                      placeholder="Find student to correct…"
                      value={editSearchTerm}
                      onChange={(e) => setEditSearchTerm(e.target.value)}
                      className="field h-11 pl-10 sm:w-56"
                    />
                  </div>
                </div>
              </div>

              {correctionStatus && (
                <div className={cn(
                  'mx-5 mt-4 rounded-2xl border px-4 py-3 text-sm font-semibold',
                  correctionStatus.includes('Unable')
                    ? 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300'
                    : 'border-grass-200 bg-grass-50 text-grass-700 dark:border-grass-500/30 dark:bg-grass-500/10 dark:text-grass-300'
                )}>
                  {correctionStatus}
                </div>
              )}

              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs font-semibold uppercase tracking-wide text-slate-400">
                      <th className="px-5 py-3">Student</th>
                      <th className="px-5 py-3">Index / Ref</th>
                      <th className="px-5 py-3">Week {editWeek} Status</th>
                      <th className="px-5 py-3">Last Method</th>
                      <th className="px-5 py-3">Correction</th>
                    </tr>
                  </thead>
                  <tbody>
                    {editableSessionRows.map(student => (
                      <tr key={`edit-${student.studentID}`} className="border-t border-slate-100 dark:border-white/5">
                        <td className="px-5 py-3">
                          <div className="flex flex-col">
                            <span className="font-semibold text-slate-800 dark:text-slate-100">{student.studentID}</span>
                            <span className="text-xs text-slate-400">{student.fullName}</span>
                          </div>
                        </td>
                        <td className="px-5 py-3">
                          <div className="flex flex-col">
                            <span className="font-medium text-slate-700 dark:text-slate-200">{student.indexNumber || 'N/A'}</span>
                            <span className="text-xs text-slate-400">{student.referenceNumber || 'No ref'}</span>
                          </div>
                        </td>
                        <td className="px-5 py-3">
                          <span className={cn(
                            'inline-flex w-fit items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold',
                            student.isPresent
                              ? 'bg-grass-50 text-grass-700 dark:bg-grass-500/10 dark:text-grass-300'
                              : 'bg-rose-50 text-rose-600 dark:bg-rose-500/10 dark:text-rose-300'
                          )}>
                            {student.isPresent ? 'Present' : 'Absent'}
                          </span>
                        </td>
                        <td className="px-5 py-3 text-slate-600 dark:text-slate-300">{student.method || 'N/A'}</td>
                        <td className="px-5 py-3">
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              className="rounded-xl bg-grass-600 px-3 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                              disabled={isCorrectionSaving || student.isPresent}
                              onClick={() => markStudentPresentForWeek(student, editWeek)}
                            >
                              Mark Present
                            </button>
                            <button
                              type="button"
                              className="rounded-xl bg-rose-500 px-3 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                              disabled={isCorrectionSaving || !student.isPresent}
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
            </div>

            {/* Summary */}
            <div className="panel overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-4 dark:border-white/10">
                <div>
                  <h3 className="text-base font-bold text-slate-800 dark:text-slate-100">Student Attendance Summary</h3>
                  <p className="mt-0.5 text-xs text-slate-400">Total classes attended per student for {activeCourse.code}</p>
                </div>
                <span className="rounded-full bg-grass-50 px-3 py-1 text-xs font-bold text-grass-700 dark:bg-grass-500/10 dark:text-grass-300">
                  {filteredHistorySummary.length} Students
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs font-semibold uppercase tracking-wide text-slate-400">
                      <th className="px-5 py-3">Student</th>
                      <th className="px-5 py-3">Index / Ref</th>
                      <th className="px-5 py-3">Attended</th>
                      <th className="px-5 py-3">Sessions</th>
                      <th className="px-5 py-3">Last Verified</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredHistorySummary.map((s) => (
                      <tr key={s.studentID} className="border-t border-slate-100 dark:border-white/5">
                        <td className="px-5 py-3">
                          <div className="flex flex-col">
                            <span className="font-semibold text-slate-800 dark:text-slate-100">{s.studentID}</span>
                            <span className="text-xs text-slate-400">{s.fullName}</span>
                          </div>
                        </td>
                        <td className="px-5 py-3">
                          <div className="flex flex-col">
                            <span className="font-medium text-slate-700 dark:text-slate-200">{s.indexNumber || 'N/A'}</span>
                            <span className="text-xs text-slate-400">{s.referenceNumber || 'No ref'}</span>
                          </div>
                        </td>
                        <td className="px-5 py-3"><strong className="text-slate-800 dark:text-slate-100">{s.attendedCount}</strong></td>
                        <td className="px-5 py-3 text-slate-600 dark:text-slate-300">{s.sessions.join(', ') || 'None'}</td>
                        <td className="px-5 py-3 text-slate-600 dark:text-slate-300">{s.lastVerified || 'Not yet verified'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Complete ledger */}
            <div className="panel overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-4 dark:border-white/10">
                <div>
                  <h3 className="text-base font-bold text-slate-800 dark:text-slate-100">Complete Session Ledger</h3>
                  <p className="mt-0.5 text-xs text-slate-400">Every recorded verification by session and date</p>
                </div>
                <span className="rounded-full bg-grass-50 px-3 py-1 text-xs font-bold text-grass-700 dark:bg-grass-500/10 dark:text-grass-300">
                  {filteredHistoryRows.length} Records
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs font-semibold uppercase tracking-wide text-slate-400">
                      <th className="px-5 py-3">Student</th>
                      <th className="px-5 py-3">Index / Ref</th>
                      <th className="px-5 py-3">Session</th>
                      <th className="px-5 py-3">Date</th>
                      <th className="px-5 py-3">Method</th>
                      <th className="px-5 py-3">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredHistoryRows.map((s, idx) => (
                      <tr key={`${s.sessionKey}-${s.studentID}-${idx}`} className="border-t border-slate-100 dark:border-white/5">
                        <td className="px-5 py-3">
                          <div className="flex flex-col">
                            <span className="font-semibold text-slate-800 dark:text-slate-100">{s.studentID}</span>
                            <span className="text-xs text-slate-400">{s.fullName}</span>
                          </div>
                        </td>
                        <td className="px-5 py-3">
                          <div className="flex flex-col">
                            <span className="font-medium text-slate-700 dark:text-slate-200">{s.indexNumber || 'N/A'}</span>
                            <span className="text-xs text-slate-400">{s.referenceNumber || 'No ref'}</span>
                          </div>
                        </td>
                        <td className="px-5 py-3">
                          <span className="inline-flex items-center gap-2 text-slate-600 dark:text-slate-300"><CalendarDays size={14} /> Week {s.week}</span>
                        </td>
                        <td className="px-5 py-3 text-slate-600 dark:text-slate-300">{s.dateTime || s.timeVerified || s.sessionDate}</td>
                        <td className="px-5 py-3 text-slate-600 dark:text-slate-300">{s.method || 'PIN + GPS'}</td>
                        <td className="px-5 py-3">
                          <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-grass-50 px-2.5 py-1 text-xs font-semibold text-grass-700 dark:bg-grass-500/10 dark:text-grass-300">Verified</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!isHistoryLoading && filteredHistoryRows.length === 0 && (
                <div className="px-5 py-16 text-center text-slate-400">
                  <Users size={48} className="mx-auto mb-4 opacity-50" />
                  <h3 className="text-sm font-medium">No matching attendance records found.</h3>
                </div>
              )}
            </div>
          </MotionDiv>
        )}
        </main>
      </div>
    </div>
    </div>
  );
}
