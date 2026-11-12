import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { 
  initializeFirestore,
  getFirestore, 
  doc, 
  getDocFromServer 
} from 'firebase/firestore';
import firebaseConfigJson from '../firebase-applet-config.json';

// Strictly use the provisioned database ID from firebase-applet-config.json
const targetDatabaseId = firebaseConfigJson.firestoreDatabaseId || (import.meta as any).env?.VITE_FIREBASE_DATABASE_ID;

const firebaseConfig = {
  projectId: (import.meta as any).env?.VITE_FIREBASE_PROJECT_ID || firebaseConfigJson.projectId,
  appId: (import.meta as any).env?.VITE_FIREBASE_APP_ID || firebaseConfigJson.appId,
  apiKey: (import.meta as any).env?.VITE_FIREBASE_API_KEY || firebaseConfigJson.apiKey,
  authDomain: (import.meta as any).env?.VITE_FIREBASE_AUTH_DOMAIN || firebaseConfigJson.authDomain,
  firestoreDatabaseId: targetDatabaseId,
  storageBucket: (import.meta as any).env?.VITE_FIREBASE_STORAGE_BUCKET || firebaseConfigJson.storageBucket,
  messagingSenderId: (import.meta as any).env?.VITE_FIREBASE_MESSAGING_SENDER_ID || firebaseConfigJson.messagingSenderId,
};

// Initialize Firebase App
const app = initializeApp(firebaseConfig);

// Initialize Firestore strictly with the provisioned database ID from firebase-applet-config.json
// Enable experimentalForceLongPolling to guarantee rock-solid connectivity in browser iframes,
// Cloud Run proxies, and corporate networks without WebChannel stream disconnections.
export const db = initializeFirestore(app, {
  experimentalForceLongPolling: true,
}, firebaseConfigJson.firestoreDatabaseId);

// Initialize Firebase Auth
export const auth = getAuth(app);

// Optional: Firebase App Check hook for future enterprise expansion.
// reCAPTCHA is not required or implemented at this stage. Startup execution is disabled.
export async function initAppCheck(customSiteKey?: string): Promise<void> {
  if (typeof window === 'undefined') return;
  const siteKey = customSiteKey || (import.meta as any).env?.VITE_FIREBASE_APPCHECK_KEY;
  if (!siteKey || siteKey.trim() === '') {
    return;
  }
  try {
    const { initializeAppCheck, ReCaptchaV3Provider } = await import('firebase/app-check');
    initializeAppCheck(app, {
      provider: new ReCaptchaV3Provider(siteKey),
      isTokenAutoRefreshEnabled: true,
    });
  } catch {
    // App Check remains completely optional
  }
}

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid || null,
      email: auth.currentUser?.email || null,
      emailVerified: auth.currentUser?.emailVerified || null,
      isAnonymous: auth.currentUser?.isAnonymous || null,
      tenantId: auth.currentUser?.tenantId || null,
      providerInfo: auth.currentUser?.providerData?.map(provider => ({
        providerId: provider.providerId,
        email: provider.email,
      })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error:', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// Connection test on boot
export async function testConnection(): Promise<boolean> {
  try {
    await getDocFromServer(doc(db, 'system_settings', 'global'));
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.warn('Firestore is running in offline mode. Please verify network or credentials.');
      return false;
    }
    // Any other response means we connected to the server
    return true;
  }
}

/**
 * Recursively strips out any undefined keys from objects before sending to Firestore,
 * preventing 'Unsupported field value: undefined' errors.
 */
export function sanitizeFirestoreData<T extends Record<string, any>>(data: T): Partial<T> {
  const clean: Record<string, any> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) {
      if (value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
        clean[key] = sanitizeFirestoreData(value);
      } else {
        clean[key] = value;
      }
    }
  }
  return clean as Partial<T>;
}

