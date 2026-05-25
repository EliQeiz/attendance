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
- CSV exports neutralize spreadsheet formulas to reduce CSV injection risk.
- Roster uploads are restricted to CSV/XLSX with file size and row count limits.
- Vercel response headers deny framing, reduce MIME sniffing, narrow referrer leakage, and restrict browser permissions.

## Important Limitation

Web Bluetooth and QR verification run in the browser, so a determined attacker with full browser-console control can still attempt to call Firebase directly. Firestore rules now block most unauthorized writes, but cryptographic proof of physical proximity would require a server-side challenge flow, hardware beacon signing, or Firebase Cloud Functions.
