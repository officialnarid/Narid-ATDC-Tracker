# NARID ATDC Tracker — Vercel + Firebase Deployment & Security Guide

Architecture:
- **Frontend**: Vercel (React + TypeScript + Vite SPA)
- **Backend API**: Vercel Serverless Functions (`api/[...all].ts` wrapping Express)
- **Database & Auth**: Existing Firebase Project `narid-atdc-tracker` / Database `ai-studio-manpowertracker-9b87a863-5c0d-4126-accb-7a3be802b10b` (Region: `asia-south1`)
- **Backend Security**: Firebase Admin SDK using server-side Vercel Environment Variables

---

## 1. Pre-Deployment Verification (Preserves Existing Production Data)
- Confirm zero changes to `firebase-applet-config.json` (`projectId`: `narid-atdc-tracker`, `firestoreDatabaseId`: `ai-studio-manpowertracker-9b87a863-5c0d-4126-accb-7a3be802b10b`).
- On Vercel cold start (`api/[...all].ts`), automatic seeding and migrations are disabled (`disableBackgroundBoot: true`) so existing users, UIDs, scrypt password hashes, roles, employees, and attendance history are strictly preserved.
- Run local verification before deploying:
  ```bash
  npm test
  npm run test:rules
  npm run lint
  npm run build:frontend
  ```

---

## 2. Dual-Environment Variables (Vercel Production + AI Studio Preview)

Configure the following environment variables in **Vercel Project Settings -> Environment Variables** (never expose service-account secrets with a `VITE_` prefix):

### Vercel Server-Side Variables (All Environments / Production & Preview)
- `FIREBASE_PROJECT_ID` = `narid-atdc-tracker`
- `FIREBASE_DATABASE_ID` = `ai-studio-manpowertracker-9b87a863-5c0d-4126-accb-7a3be802b10b`
- **Firebase Admin Credentials** (choose Option A or Option B):
  - **Option A (Recommended):**
    - `FIREBASE_SERVICE_ACCOUNT_KEY` = *(full JSON contents or Base64 JSON of the GCP Service Account with `roles/firebaseauth.admin` and `roles/datastore.user` in `narid-atdc-tracker`)*
  - **Option B (Discrete Fields):**
    - `FIREBASE_CLIENT_EMAIL` = *(service account `client_email`)*
    - `FIREBASE_PRIVATE_KEY` = *(PEM `private_key`, supports escaped `\n` newlines)*
- `ALLOWED_ORIGINS` = `https://narid-atdc-tracker.vercel.app,https://ais-dev-ffrnx5p5324ee4aajyzxbj-356936239657.asia-southeast1.run.app,https://ais-pre-ffrnx5p5324ee4aajyzxbj-356936239657.asia-southeast1.run.app`
- `APP_URL` = `https://narid-atdc-tracker.vercel.app`

### Vercel Production Frontend Variables
- `VITE_API_BASE_URL` = `""` *(leave unset or empty for same-origin `/api/*` Vercel Serverless Functions)*
- `VITE_FIREBASE_PROJECT_ID` = `narid-atdc-tracker`
- `VITE_FIREBASE_API_KEY` = *(existing Firebase Web API key)*
- `VITE_FIREBASE_AUTH_DOMAIN` = `narid-atdc-tracker.firebaseapp.com`
- `VITE_FIREBASE_DATABASE_ID` = `ai-studio-manpowertracker-9b87a863-5c0d-4126-accb-7a3be802b10b`
- `VITE_FIREBASE_APP_ID` = `1:1060028696945:web:c720807980550c1cc5ced0`
- `VITE_FIREBASE_STORAGE_BUCKET` = `narid-atdc-tracker.firebasestorage.app`
- `VITE_FIREBASE_MESSAGING_SENDER_ID` = `1060028696945`

### Google AI Studio Preview Frontend Variable (`.env.development`)
- `VITE_API_BASE_URL` = `https://narid-atdc-tracker.vercel.app` *(routes AI Studio Preview `/api/*` requests directly to the shared Vercel Serverless backend; ignored by `vite build` for Vercel Production)*

---

## 3. Verifying Deployment Readiness
After deploying to Vercel, verify health and same-origin routing:
```bash
curl -fsS https://narid-atdc-tracker.vercel.app/api/health
# Expect: {"status":"ok","adminSdkInitialized":true,"credentialMode":"SERVICE_ACCOUNT_ENV","projectId":"narid-atdc-tracker",...}
```

---

## 4. Firestore Security Rules Verification & Manual Deployment
Ensure your hardened `firestore.rules` (blocking direct client writes to `attendance`, `punch_events`, `punch_logs`, `shift_rosters`, `user_uid_index`, `user_roles`, `roles`, `user_permissions`, `role_permissions`, `audit_*`, `account_security`, `login_attempts`, `security_audit_logs`, and `ip_rate_limits`) are deployed to `narid-atdc-tracker`:
```bash
firebase deploy --only firestore:rules --project narid-atdc-tracker
```
> **Important Order:** Deploy the Vercel backend (`api/[...all].ts`) **before** deploying `firestore.rules`, so all attendance scans, login telemetry, permission edits, and audit events run through Firebase Admin SDK APIs.
