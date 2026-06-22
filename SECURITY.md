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
- Student verification requires the active 4-digit PIN, a fresh 3-minute PIN window, refined high-accuracy GPS sampling, and a Haversine distance check within 100 meters of the lecturer GPS coordinate.
- New accounts use a real recovery email for Firebase Authentication. Legacy ID-based sign-in remains available for older accounts created before recovery email support.
- New student signup atomically reserves the 8-digit Student ID, preventing two recovery emails from creating separate accounts for the same identity.
- QR fallback codes rotate on the student dashboard and are accepted only for the matching active session within their short validity window.
- Lecturer-entered fallback attendance requires a reason and records the lecturer identity for later review.
- CSV exports neutralize spreadsheet formulas to reduce CSV injection risk.
- Roster uploads are restricted to CSV/XLSX with file size and row count limits.
- Cloud Storage client access is denied by default because the app currently stores roster and attendance data in Firestore, not Storage.
- Vercel response headers deny framing, reduce MIME sniffing, narrow referrer leakage, and restrict browser permissions.

## Important Limitation

PIN + GPS and QR verification run in the browser, so a determined attacker with full browser-console control can still attempt to call Firebase directly. Firestore rules now block most unauthorized writes, but stronger proof of physical proximity would require server-side validation through Firebase Cloud Functions.
