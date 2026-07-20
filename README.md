# KNUST Lecturer Tracking & Attendance Platform

React + Firebase attendance platform for lecturer-led course sessions with projected lecturer QR codes, refined GPS proximity checks within 150 meters, scan-only lecturer approvals, lecturer-entered fallback verification, roster import, attendance history, correction workflows, password recovery, and CSV export.

## Local Development

```bash
npm install
npm run dev
```

## Production Checks

```bash
npm run lint
npm run build
npm audit --omit=dev
```

## Environment

Firebase web config can be supplied with Vite variables. Copy `.env.example` to `.env.local` for local overrides or add the same values in Vercel project settings.

## Firebase Security

Deploy `firestore.rules` before using the app with real student data. Lecturer sign-up is intentionally approval-gated: create a `lecturerApprovals/{lecturerLoginId}` document in Firestore before that lecturer creates an account.

Students must be on the course roster before a QR attendance record can be created. Lecturers own their courses, rosters, sessions, approvals, edits, exports, and audit logs.
