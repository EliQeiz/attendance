# Security Notes

## Required Before Production

- Deploy `firestore.rules` to the Firebase project.
- Enable Firebase Email/Password auth and configure Firebase Auth password policy to require at least 8 characters, one letter, and one number.
- Add `lecturerApprovals/{lecturerLoginId}` documents for approved lecturer accounts only.
- Add Vercel environment variables from `.env.example`.
- Enable Firebase App Check for the web app before handling real institutional data.

## Current Protections

- Student sign-up requires an exact 8-digit KNUST ID.
- Lecturer accounts are blocked by Firestore rules unless pre-approved.
- Attendance writes are role-gated, roster-gated, session-gated, and duplicate-protected by document ID.
- Device reuse is tracked per session through `attendance/{sessionId}/devices/{deviceKey}`.
- Student GPS verification requires the active projected lecturer QR code, a server-side session code match, refined high-accuracy GPS sampling, and a Haversine distance check within 150 meters of the lecturer GPS coordinate.
- Scan-only QR submissions are stored as `Pending` and require lecturer approval before counting as attended.
- New accounts use a real recovery email for Firebase Authentication. Legacy ID-based sign-in remains available for older accounts created before recovery email support.
- New student signup atomically reserves the 8-digit Student ID, preventing two recovery emails from creating separate accounts for the same identity.
- Lecturer approval actions and lecturer-entered fallback attendance require a reason or explicit decision and record the lecturer identity for later review.
- CSV exports neutralize spreadsheet formulas to reduce CSV injection risk.
- Roster uploads are restricted to CSV/XLSX with file size and row count limits.
- Cloud Storage client access is denied by default because the app currently stores roster and attendance data in Firestore, not Storage.
- Vercel response headers deny framing, reduce MIME sniffing, narrow referrer leakage, and restrict browser permissions.

## Important Limitation

QR scanning and GPS collection run in the browser, so a determined attacker with full browser-console control can still attempt to call Firebase directly. Firestore rules block direct student writes, and `submitAttendance` validates the QR session code, roster membership, device uniqueness, GPS proximity, and pending scan-only path server-side through Firebase Cloud Functions.
