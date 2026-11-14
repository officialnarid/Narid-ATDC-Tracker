import fs from 'fs';
import { initializeApp, getApps, cert, applicationDefault, App } from 'firebase-admin/app';
import { getAuth, Auth } from 'firebase-admin/auth';
import { getFirestore, Firestore } from 'firebase-admin/firestore';
import firebaseConfig from './firebase-applet-config.json';

export const TARGET_PROJECT_ID =
  process.env.FIREBASE_PROJECT_ID || firebaseConfig.projectId || 'narid-atdc-tracker';

export const TARGET_DATABASE_ID =
  process.env.FIREBASE_DATABASE_ID ||
  firebaseConfig.firestoreDatabaseId ||
  'ai-studio-manpowertracker-9b87a863-5c0d-4126-accb-7a3be802b10b';

export interface FirebaseAdminContext {
  app: App | null;
  db: Firestore | null;
  auth: Auth | null;
  projectId: string;
  databaseId: string;
  credentialMode: 'SERVICE_ACCOUNT_ENV' | 'ADC' | 'UNCONFIGURED';
  credentialSource?: string;
  serviceAccountEmail?: string;
  error?: string;
}

let cachedContext: FirebaseAdminContext | null = null;

export function normalizePrivateKeyNewlines(key: unknown): string {
  if (typeof key !== 'string') return '';
  return key.replace(/\\n/g, '\n').trim();
}

export function parseServiceAccountFromSource(raw: string): Record<string, any> | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let parsed: Record<string, any> | null = null;

  if (trimmed.startsWith('{')) {
    parsed = JSON.parse(trimmed);
  } else if (fs.existsSync(trimmed)) {
    const fileContent = fs.readFileSync(trimmed, 'utf8');
    parsed = JSON.parse(fileContent);
  } else {
    try {
      const decoded = Buffer.from(trimmed, 'base64').toString('utf8').trim();
      if (decoded.startsWith('{')) {
        parsed = JSON.parse(decoded);
      }
    } catch {
      return null;
    }
  }

  if (parsed && typeof parsed.private_key === 'string') {
    parsed.private_key = normalizePrivateKeyNewlines(parsed.private_key);
  }

  return parsed;
}

export function isFirestorePermissionDeniedError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    const msg = String(err || '');
    return msg.includes('PERMISSION_DENIED') || msg.includes('permission-denied');
  }
  const anyErr = err as { code?: unknown; message?: unknown; details?: unknown };
  const codeStr = String(anyErr.code ?? '').toUpperCase();
  const msg = `${String(anyErr.message ?? '')} ${String(anyErr.details ?? '')}`;
  return (
    anyErr.code === 7 ||
    codeStr === '7' ||
    codeStr === 'PERMISSION_DENIED' ||
    msg.includes('PERMISSION_DENIED') ||
    msg.includes('permission-denied')
  );
}

export function formatAdminPermissionDeniedError(
  projectId: string = TARGET_PROJECT_ID,
  databaseId: string = TARGET_DATABASE_ID
): string {
  return (
    `Firebase Admin SDK credentials lack Cloud Firestore IAM permissions (roles/datastore.user) ` +
    `for project "${projectId}" (database "${databaseId}"). ` +
    `Verify FIREBASE_SERVICE_ACCOUNT_KEY (or FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY) in Vercel Environment Variables.`
  );
}

export function getFirebaseAdminContext(forceRefresh = false): FirebaseAdminContext {
  if (cachedContext && !forceRefresh) {
    return cachedContext;
  }

  const projectId = TARGET_PROJECT_ID;
  const databaseId = TARGET_DATABASE_ID;
  const appName = `narid-admin-${projectId}`;
  const isVercelRuntime = Boolean(process.env.VERCEL);

  const envCandidates: Array<{ name: string; value?: string }> = [
    { name: 'FIREBASE_SERVICE_ACCOUNT_KEY', value: process.env.FIREBASE_SERVICE_ACCOUNT_KEY },
    { name: 'FIREBASE_SERVICE_ACCOUNT_JSON', value: process.env.FIREBASE_SERVICE_ACCOUNT_JSON },
    { name: 'GOOGLE_APPLICATION_CREDENTIALS', value: process.env.GOOGLE_APPLICATION_CREDENTIALS },
  ];

  let hadExplicitCredentialEnv = false;
  let parsedCred: Record<string, any> | null = null;
  let sourceName = '';
  let parseError = '';

  for (const cand of envCandidates) {
    if (!cand.value || !cand.value.trim()) continue;
    hadExplicitCredentialEnv = true;
    try {
      const parsed = parseServiceAccountFromSource(cand.value);
      if (!parsed || !parsed.client_email || !parsed.private_key) {
        parseError = `${cand.name} is invalid or missing required service-account fields (client_email, private_key).`;
        continue;
      }
      if (parsed.project_id && parsed.project_id !== projectId) {
        parseError = `${cand.name} belongs to project "${parsed.project_id}", expected "${projectId}".`;
        continue;
      }
      parsedCred = parsed;
      sourceName = cand.name;
      parseError = '';
      break;
    } catch (e: any) {
      parseError = `${cand.name} invalid JSON/file: ${e?.message || e}`;
    }
  }

  // Fallback to discrete Vercel server-side environment variables if JSON blob was not supplied
  if (!parsedCred && !hadExplicitCredentialEnv) {
    const discreteEmail = (process.env.FIREBASE_CLIENT_EMAIL || '').trim();
    const discreteKey = normalizePrivateKeyNewlines(process.env.FIREBASE_PRIVATE_KEY);
    if (discreteEmail || discreteKey) {
      hadExplicitCredentialEnv = true;
      const discreteProject = (process.env.FIREBASE_PROJECT_ID || projectId).trim();
      if (!discreteEmail || !discreteKey) {
        parseError = 'Both FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY must be set together.';
      } else if (discreteProject !== projectId) {
        parseError = `FIREBASE_PROJECT_ID "${discreteProject}" does not match expected "${projectId}".`;
      } else {
        parsedCred = {
          project_id: discreteProject,
          client_email: discreteEmail,
          private_key: discreteKey,
        };
        sourceName = 'FIREBASE_CLIENT_EMAIL+FIREBASE_PRIVATE_KEY';
      }
    }
  }

  // Strictly fail closed if explicit service-account credentials were provided but invalid
  if (hadExplicitCredentialEnv && !parsedCred) {
    cachedContext = {
      app: null,
      db: null,
      auth: null,
      projectId,
      databaseId,
      credentialMode: 'UNCONFIGURED',
      error:
        parseError ||
        'Explicitly configured Firebase service-account credentials are invalid. Refusing unsafe fallback.',
    };
    return cachedContext;
  }

  // Vercel Serverless Functions do not have GCP Metadata Server ADC — fail closed if no service account env is set
  if (isVercelRuntime && !parsedCred) {
    cachedContext = {
      app: null,
      db: null,
      auth: null,
      projectId,
      databaseId,
      credentialMode: 'UNCONFIGURED',
      error:
        'Missing Firebase Admin SDK credentials in Vercel environment. Configure FIREBASE_SERVICE_ACCOUNT_KEY (or FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY) on the server.',
    };
    return cachedContext;
  }

  try {
    let adminApp = getApps().find((a) => a.name === appName) || null;
    let credentialMode: FirebaseAdminContext['credentialMode'] = 'ADC';

    if (parsedCred) {
      if (!adminApp) {
        adminApp = initializeApp(
          {
            credential: cert(parsedCred as any),
            projectId,
          },
          appName
        );
      }
      credentialMode = 'SERVICE_ACCOUNT_ENV';
    } else {
      // Local / GCP ADC fallback only outside Vercel runtime
      if (!adminApp) {
        adminApp = initializeApp(
          {
            credential: applicationDefault(),
            projectId,
          },
          appName
        );
      }
      credentialMode = 'ADC';
    }

    const db = getFirestore(adminApp, databaseId);
    const auth = getAuth(adminApp);

    cachedContext = {
      app: adminApp,
      db,
      auth,
      projectId,
      databaseId,
      credentialMode,
      credentialSource: sourceName || 'GOOGLE_ADC',
      serviceAccountEmail: parsedCred?.client_email ? String(parsedCred.client_email) : undefined,
    };
    return cachedContext;
  } catch (err: any) {
    cachedContext = {
      app: null,
      db: null,
      auth: null,
      projectId,
      databaseId,
      credentialMode: 'UNCONFIGURED',
      error: parseError || String(err?.message || err || 'Failed to initialize Firebase Admin SDK.'),
    };
    return cachedContext;
  }
}
