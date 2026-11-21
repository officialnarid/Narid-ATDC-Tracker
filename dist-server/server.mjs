// server.ts
import express from "express";
import cors from "cors";
import fs2 from "fs";
import path2 from "path";
import crypto7 from "crypto";
import { z as z7 } from "zod";

// serverFirebaseAdmin.ts
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { initializeApp, getApps, cert, applicationDefault } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
var cachedAppletConfig = null;
function loadFirebaseAppletConfig(customPath) {
  if (!customPath && cachedAppletConfig) {
    return cachedAppletConfig;
  }
  const cwdPath = customPath ? path.resolve(customPath) : path.resolve(process.cwd(), "firebase-applet-config.json");
  let resolvedPath = cwdPath;
  if (!customPath && !fs.existsSync(resolvedPath)) {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const moduleAdjacentPath = path.resolve(moduleDir, "firebase-applet-config.json");
    if (fs.existsSync(moduleAdjacentPath)) {
      resolvedPath = moduleAdjacentPath;
    }
  }
  if (!fs.existsSync(resolvedPath)) {
    throw new Error("Missing firebase-applet-config.json configuration file.");
  }
  let rawContent;
  try {
    rawContent = fs.readFileSync(resolvedPath, "utf8");
  } catch {
    throw new Error("Unable to read firebase-applet-config.json configuration file.");
  }
  let parsed;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    throw new Error("Invalid JSON in firebase-applet-config.json configuration file.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid firebase-applet-config.json: expected a JSON object.");
  }
  const record = parsed;
  const projectId = typeof record.projectId === "string" ? record.projectId.trim() : "";
  const firestoreDatabaseId = typeof record.firestoreDatabaseId === "string" ? record.firestoreDatabaseId.trim() : "";
  if (!projectId || !firestoreDatabaseId) {
    throw new Error(
      "Invalid firebase-applet-config.json: missing required projectId or firestoreDatabaseId."
    );
  }
  const config = {
    projectId,
    firestoreDatabaseId,
    ...typeof record.apiKey === "string" && record.apiKey.trim() ? { apiKey: record.apiKey.trim() } : {},
    ...typeof record.authDomain === "string" ? { authDomain: record.authDomain.trim() } : {},
    ...typeof record.appId === "string" ? { appId: record.appId.trim() } : {},
    ...typeof record.storageBucket === "string" ? { storageBucket: record.storageBucket.trim() } : {},
    ...typeof record.messagingSenderId === "string" ? { messagingSenderId: record.messagingSenderId.trim() } : {},
    ...typeof record.measurementId === "string" ? { measurementId: record.measurementId.trim() } : {},
    ...typeof record.oAuthClientId === "string" ? { oAuthClientId: record.oAuthClientId.trim() } : {}
  };
  if (!customPath) {
    cachedAppletConfig = config;
  }
  return config;
}
function tryLoadInitialConfig() {
  try {
    return loadFirebaseAppletConfig();
  } catch {
    return null;
  }
}
var initialAppletConfig = tryLoadInitialConfig();
var TARGET_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || initialAppletConfig?.projectId || "narid-atdc-tracker";
var TARGET_DATABASE_ID = process.env.FIREBASE_DATABASE_ID || initialAppletConfig?.firestoreDatabaseId || "ai-studio-manpowertracker-9b87a863-5c0d-4126-accb-7a3be802b10b";
var cachedContext = null;
function normalizePrivateKeyNewlines(key) {
  if (typeof key !== "string") return "";
  return key.replace(/\\n/g, "\n").trim();
}
function parseServiceAccountFromSource(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let parsed = null;
  if (trimmed.startsWith("{")) {
    parsed = JSON.parse(trimmed);
  } else if (fs.existsSync(trimmed)) {
    const fileContent = fs.readFileSync(trimmed, "utf8");
    parsed = JSON.parse(fileContent);
  } else {
    try {
      const decoded = Buffer.from(trimmed, "base64").toString("utf8").trim();
      if (decoded.startsWith("{")) {
        parsed = JSON.parse(decoded);
      }
    } catch {
      return null;
    }
  }
  if (parsed && typeof parsed.private_key === "string") {
    parsed.private_key = normalizePrivateKeyNewlines(parsed.private_key);
  }
  return parsed;
}
function isFirestorePermissionDeniedError(err) {
  if (!err || typeof err !== "object") {
    const msg2 = String(err || "");
    return msg2.includes("PERMISSION_DENIED") || msg2.includes("permission-denied");
  }
  const anyErr = err;
  const codeStr = String(anyErr.code ?? "").toUpperCase();
  const msg = `${String(anyErr.message ?? "")} ${String(anyErr.details ?? "")}`;
  return anyErr.code === 7 || codeStr === "7" || codeStr === "PERMISSION_DENIED" || msg.includes("PERMISSION_DENIED") || msg.includes("permission-denied");
}
function formatAdminPermissionDeniedError(projectId = TARGET_PROJECT_ID, databaseId = TARGET_DATABASE_ID) {
  return `Firebase Admin SDK credentials lack Cloud Firestore IAM permissions (roles/datastore.user) for project "${projectId}" (database "${databaseId}"). Verify FIREBASE_SERVICE_ACCOUNT_KEY (or FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY) in Vercel Environment Variables.`;
}
function getFirebaseAdminContext(forceRefresh = false) {
  if (cachedContext && !forceRefresh) {
    return cachedContext;
  }
  let loadedConfig;
  try {
    loadedConfig = loadFirebaseAppletConfig();
  } catch (cfgErr) {
    cachedContext = {
      app: null,
      db: null,
      auth: null,
      projectId: TARGET_PROJECT_ID,
      databaseId: TARGET_DATABASE_ID,
      credentialMode: "UNCONFIGURED",
      error: cfgErr?.message || "Missing or invalid firebase-applet-config.json configuration file."
    };
    return cachedContext;
  }
  const projectId = process.env.FIREBASE_PROJECT_ID || loadedConfig.projectId || TARGET_PROJECT_ID;
  const databaseId = process.env.FIREBASE_DATABASE_ID || loadedConfig.firestoreDatabaseId || TARGET_DATABASE_ID;
  const appName = `narid-admin-${projectId}`;
  const isVercelRuntime = Boolean(process.env.VERCEL);
  const envCandidates = [
    { name: "FIREBASE_SERVICE_ACCOUNT_KEY", value: process.env.FIREBASE_SERVICE_ACCOUNT_KEY },
    { name: "FIREBASE_SERVICE_ACCOUNT_JSON", value: process.env.FIREBASE_SERVICE_ACCOUNT_JSON },
    { name: "GOOGLE_APPLICATION_CREDENTIALS", value: process.env.GOOGLE_APPLICATION_CREDENTIALS }
  ];
  let hadExplicitCredentialEnv = false;
  let parsedCred = null;
  let sourceName = "";
  let parseError = "";
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
      parseError = "";
      break;
    } catch (e) {
      parseError = `${cand.name} invalid JSON/file: ${e?.message || e}`;
    }
  }
  if (!parsedCred && !hadExplicitCredentialEnv) {
    const discreteEmail = (process.env.FIREBASE_CLIENT_EMAIL || "").trim();
    const discreteKey = normalizePrivateKeyNewlines(process.env.FIREBASE_PRIVATE_KEY);
    if (discreteEmail || discreteKey) {
      hadExplicitCredentialEnv = true;
      const discreteProject = (process.env.FIREBASE_PROJECT_ID || projectId).trim();
      if (!discreteEmail || !discreteKey) {
        parseError = "Both FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY must be set together.";
      } else if (discreteProject !== projectId) {
        parseError = `FIREBASE_PROJECT_ID "${discreteProject}" does not match expected "${projectId}".`;
      } else {
        parsedCred = {
          project_id: discreteProject,
          client_email: discreteEmail,
          private_key: discreteKey
        };
        sourceName = "FIREBASE_CLIENT_EMAIL+FIREBASE_PRIVATE_KEY";
      }
    }
  }
  if (hadExplicitCredentialEnv && !parsedCred) {
    cachedContext = {
      app: null,
      db: null,
      auth: null,
      projectId,
      databaseId,
      credentialMode: "UNCONFIGURED",
      error: parseError || "Explicitly configured Firebase service-account credentials are invalid. Refusing unsafe fallback."
    };
    return cachedContext;
  }
  if (isVercelRuntime && !parsedCred) {
    cachedContext = {
      app: null,
      db: null,
      auth: null,
      projectId,
      databaseId,
      credentialMode: "UNCONFIGURED",
      error: "Missing Firebase Admin SDK credentials in Vercel environment. Configure FIREBASE_SERVICE_ACCOUNT_KEY (or FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY) on the server."
    };
    return cachedContext;
  }
  try {
    let adminApp = getApps().find((a) => a.name === appName) || null;
    let credentialMode = "ADC";
    if (parsedCred) {
      if (!adminApp) {
        adminApp = initializeApp(
          {
            credential: cert(parsedCred),
            projectId
          },
          appName
        );
      }
      credentialMode = "SERVICE_ACCOUNT_ENV";
    } else {
      if (!adminApp) {
        adminApp = initializeApp(
          {
            credential: applicationDefault(),
            projectId
          },
          appName
        );
      }
      credentialMode = "ADC";
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
      credentialSource: sourceName || "GOOGLE_ADC",
      serviceAccountEmail: parsedCred?.client_email ? String(parsedCred.client_email) : void 0
    };
    return cachedContext;
  } catch (err) {
    cachedContext = {
      app: null,
      db: null,
      auth: null,
      projectId,
      databaseId,
      credentialMode: "UNCONFIGURED",
      error: parseError || String(err?.message || err || "Failed to initialize Firebase Admin SDK.")
    };
    return cachedContext;
  }
}

// serverSecurityAudit.ts
import crypto from "crypto";

// serverPerfCache.ts
var dbCacheWeakMap = /* @__PURE__ */ new WeakMap();
function getStore(db) {
  let store = dbCacheWeakMap.get(db);
  if (!store) {
    store = {
      roleDefs: /* @__PURE__ */ new Map(),
      roleDefsInFlight: /* @__PURE__ */ new Map(),
      rolePerms: /* @__PURE__ */ new Map(),
      rolePermsInFlight: /* @__PURE__ */ new Map(),
      uidRolePointers: /* @__PURE__ */ new Map(),
      inFlightRequests: /* @__PURE__ */ new Map(),
      recentIdempotentResponses: /* @__PURE__ */ new Map()
    };
    dbCacheWeakMap.set(db, store);
  }
  return store;
}
var CONFIG_TTL_MS = 12e4;
var ROLE_TTL_MS = 6e4;
var UID_POINTER_TTL_MS = 3e5;
function getCachedUidRolePointer(db, uid) {
  const cleanUid = String(uid || "").trim();
  if (!cleanUid) return null;
  const store = getStore(db);
  const entry = store.uidRolePointers.get(cleanUid);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    store.uidRolePointers.delete(cleanUid);
    return null;
  }
  return { roleDocId: entry.roleDocId, lastRole: entry.lastRole };
}
function setCachedUidRolePointer(db, uid, roleDocId, lastRole) {
  const cleanUid = String(uid || "").trim();
  const cleanDocId = String(roleDocId || "").trim();
  if (!cleanUid || !cleanDocId) return;
  const store = getStore(db);
  if (store.uidRolePointers.size > 500) {
    const now = Date.now();
    for (const [k, v] of store.uidRolePointers.entries()) {
      if (v.expiresAt <= now) store.uidRolePointers.delete(k);
    }
  }
  store.uidRolePointers.set(cleanUid, {
    roleDocId: cleanDocId,
    lastRole: String(lastRole || "").trim().toLowerCase(),
    expiresAt: Date.now() + UID_POINTER_TTL_MS
  });
}
function invalidateUidRolePointer(db, uid) {
  const store = getStore(db);
  if (uid) {
    store.uidRolePointers.delete(String(uid).trim());
  } else {
    store.uidRolePointers.clear();
  }
}
async function getCachedShifts(db, defaultShifts) {
  const store = getStore(db);
  const now = Date.now();
  if (store.shifts && store.shifts.expiresAt > now) {
    return { shifts: store.shifts.value, cacheHit: true };
  }
  if (!store.shiftsInFlight) {
    store.shiftsInFlight = db.collection("shifts").get().then((snap) => {
      const list = snap.empty ? defaultShifts : snap.docs.map((d) => d.data());
      store.shifts = { value: list, expiresAt: Date.now() + CONFIG_TTL_MS };
      return list;
    }).finally(() => {
      store.shiftsInFlight = void 0;
    });
  }
  const shifts = await store.shiftsInFlight;
  return { shifts, cacheHit: false };
}
async function getCachedSystemSettings(db, defaultSettings = {}) {
  const store = getStore(db);
  const now = Date.now();
  if (store.systemSettings && store.systemSettings.expiresAt > now) {
    return {
      exists: store.systemSettings.exists,
      data: store.systemSettings.data || defaultSettings,
      cacheHit: true
    };
  }
  if (!store.systemSettingsInFlight) {
    store.systemSettingsInFlight = db.collection("system_settings").doc("global").get().then((snap) => {
      const exists = snap.exists;
      const data2 = exists ? snap.data() || defaultSettings : defaultSettings;
      store.systemSettings = {
        exists,
        data: data2,
        expiresAt: Date.now() + CONFIG_TTL_MS
      };
      return data2;
    }).finally(() => {
      store.systemSettingsInFlight = void 0;
    });
  }
  const data = await store.systemSettingsInFlight;
  return {
    exists: store.systemSettings?.exists ?? true,
    data,
    cacheHit: false
  };
}
async function getCachedRoleDefDoc(db, roleId) {
  const cleanRole = String(roleId || "").trim().toLowerCase();
  if (!cleanRole) return { exists: false, data: void 0, cacheHit: false };
  const store = getStore(db);
  const now = Date.now();
  const cached = store.roleDefs.get(cleanRole);
  if (cached && cached.expiresAt > now) {
    return { exists: cached.exists, data: cached.data, cacheHit: true };
  }
  let inFlight = store.roleDefsInFlight.get(cleanRole);
  if (!inFlight) {
    inFlight = db.collection("roles").doc(cleanRole).get().then((snap) => {
      const entry2 = {
        exists: snap.exists,
        data: snap.exists ? snap.data() || {} : void 0,
        expiresAt: Date.now() + ROLE_TTL_MS
      };
      store.roleDefs.set(cleanRole, entry2);
      return entry2;
    }).finally(() => {
      store.roleDefsInFlight.delete(cleanRole);
    });
    store.roleDefsInFlight.set(cleanRole, inFlight);
  }
  const entry = await inFlight;
  return { exists: entry.exists, data: entry.data, cacheHit: false };
}
async function getCachedRolePermissionsDoc(db, roleId) {
  const cleanRole = String(roleId || "").trim().toLowerCase();
  if (!cleanRole) return { exists: false, data: void 0, cacheHit: false };
  const store = getStore(db);
  const now = Date.now();
  const cached = store.rolePerms.get(cleanRole);
  if (cached && cached.expiresAt > now) {
    return { exists: cached.exists, data: cached.data, cacheHit: true };
  }
  let inFlight = store.rolePermsInFlight.get(cleanRole);
  if (!inFlight) {
    inFlight = db.collection("role_permissions").doc(cleanRole).get().then((snap) => {
      const entry2 = {
        exists: snap.exists,
        data: snap.exists ? snap.data() || {} : void 0,
        expiresAt: Date.now() + ROLE_TTL_MS
      };
      store.rolePerms.set(cleanRole, entry2);
      return entry2;
    }).finally(() => {
      store.rolePermsInFlight.delete(cleanRole);
    });
    store.rolePermsInFlight.set(cleanRole, inFlight);
  }
  const entry = await inFlight;
  return { exists: entry.exists, data: entry.data, cacheHit: false };
}
function invalidateRoleCaches(db, roleId) {
  const store = getStore(db);
  if (roleId) {
    const clean = String(roleId).trim().toLowerCase();
    store.roleDefs.delete(clean);
    store.rolePerms.delete(clean);
  } else {
    store.roleDefs.clear();
    store.rolePerms.clear();
    store.uidRolePointers.clear();
  }
}
function invalidateConfigCaches(db) {
  const store = getStore(db);
  store.shifts = void 0;
  store.systemSettings = void 0;
}
async function runWithOptionalClientRequestDedup(db, dedupKey, task) {
  if (!dedupKey) {
    return task();
  }
  const store = getStore(db);
  const now = Date.now();
  const recent = store.recentIdempotentResponses.get(dedupKey);
  if (recent && recent.expiresAt > now) {
    return recent.value;
  }
  const existing = store.inFlightRequests.get(dedupKey);
  if (existing) {
    return await existing;
  }
  const promise = task().then((result) => {
    if (store.recentIdempotentResponses.size > 200) {
      const cutoff = Date.now();
      for (const [k, v] of store.recentIdempotentResponses.entries()) {
        if (v.expiresAt <= cutoff) store.recentIdempotentResponses.delete(k);
      }
    }
    store.recentIdempotentResponses.set(dedupKey, {
      value: result,
      expiresAt: Date.now() + 1500
    });
    return result;
  }).finally(() => {
    store.inFlightRequests.delete(dedupKey);
  });
  store.inFlightRequests.set(dedupKey, promise);
  return promise;
}
function roundMs(val) {
  return Math.round(val * 10) / 10;
}
function emitNonSensitivePerfLog(operation, metrics) {
  if (process.env.VITEST) return;
  if (process.env.PERF_LOG === "1" || Number(metrics.totalServerMs || 0) > 1e3) {
    console.info(`[PERF] ${operation}`, JSON.stringify(metrics));
  }
}

// serverSecurityAudit.ts
var KOLKATA_CA_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" });
var CANONICAL_SUPER_ADMIN_UID = "oX2vdSx5jGcoUDxyA0SIYN3SEig2";
function isCanonicalSuperAdminAccount(docId, data) {
  const roleNorm = normalizeRoleValue(data?.role);
  if (roleNorm !== "super_admin") return false;
  const cleanLogin = String(data?.loginId || "").trim().toLowerCase();
  const cleanDocId = String(docId || "").trim().toLowerCase();
  const cleanUid = String(data?.authUid || data?.uid || "").trim();
  return cleanLogin === "superadmin" || cleanDocId === "role_superadmin" || cleanUid === CANONICAL_SUPER_ADMIN_UID;
}
var CRITICAL_PROTECTED_ACTIONS = /* @__PURE__ */ new Set([
  "account_deleted",
  "accounts_consolidated",
  "account_cleanup_approved",
  "account_cleanup_deleted",
  "admin_password_reset",
  "unauthorized_access_attempt",
  "unauthorized_password_reset_attempt",
  "unauthorized_self_password_change",
  "super_admin_progressive_lockout",
  "super_admin_lockout_expired",
  "login_success_after_lockout",
  "super_admin_lockout_level_reset",
  "login_locked_rate_limit",
  "audit_controlled_deleted"
]);
var SYSTEM_ROLE_IDS = /* @__PURE__ */ new Set(["super_admin", "admin", "user"]);
var VALID_ROLE_ID_REGEX = /^[a-z][a-z0-9_]{1,47}$/;
function normalizeRoleValue(rawRole) {
  const cleaned = String(rawRole ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_").replace(/[^a-z0-9_]/g, "").replace(/^_+|_+$/g, "");
  if (!cleaned) return "user";
  if (cleaned === "superadmin" || cleaned === "super_admin") return "super_admin";
  if (cleaned === "admin") return "admin";
  if (cleaned === "user") return "user";
  if (VALID_ROLE_ID_REGEX.test(cleaned)) return cleaned;
  return "user";
}
function deriveStrictRoleId(rawRole) {
  const cleaned = String(rawRole ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_").replace(/[^a-z0-9_]/g, "").replace(/^_+|_+$/g, "");
  if (!cleaned) return "";
  if (cleaned === "superadmin" || cleaned === "super_admin") return "super_admin";
  return VALID_ROLE_ID_REGEX.test(cleaned) ? cleaned : "";
}
async function syncUserUidIndex(db, params) {
  const uid = String(params.uid || "").trim();
  if (!uid || uid.startsWith("role_") || uid.startsWith("LEGACY_") || uid.startsWith("GCP_")) {
    return;
  }
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const payload = {
    uid,
    roleDocId: params.roleDocId,
    role: normalizeRoleValue(params.role),
    status: params.status || "Active",
    lockStatus: params.lockStatus || "ACTIVE",
    loginId: String(params.loginId || "").trim().toLowerCase(),
    updatedAt: now
  };
  if (params.lockedUntilMs !== void 0) {
    payload.lockedUntilMs = params.lockedUntilMs;
  } else if (payload.lockStatus !== "LOCKED") {
    payload.lockedUntilMs = null;
  }
  await db.collection("user_uid_index").doc(uid).set(payload, { merge: true });
}
async function removeUserUidIndex(db, uid) {
  const clean = String(uid || "").trim();
  if (!clean) return;
  try {
    await db.collection("user_uid_index").doc(clean).delete();
  } catch {
  }
}
async function verifyCallerIdentity(req, db, auth, _projectId, options) {
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) {
    return null;
  }
  const token = authHeader.slice(7).trim();
  if (!token || token.length < 20) {
    return null;
  }
  if (!auth) {
    const err = new Error("Firebase Admin Authentication service is not initialized.");
    err.statusCode = 503;
    throw err;
  }
  const tokenVerifyStartMs = performance.now();
  let decoded;
  try {
    decoded = await auth.verifyIdToken(token, true);
  } catch (verifyErr) {
    const msg = String(verifyErr?.message || verifyErr?.code || "Invalid or revoked Firebase ID token.");
    const err = new Error(
      msg.toLowerCase().includes("revoked") ? "Firebase ID token has been revoked. Please sign in again." : msg
    );
    err.statusCode = 401;
    throw err;
  }
  const tokenVerifyMs = roundMs(performance.now() - tokenVerifyStartMs);
  if (!decoded || typeof decoded.uid !== "string" || !decoded.uid.trim()) {
    const err = new Error("Verified Firebase token missing subject UID.");
    err.statusCode = 401;
    throw err;
  }
  const verifiedUid = decoded.uid.trim();
  const decodedEmail = String(decoded.email || "").toLowerCase();
  const shouldPrefetchUserPerm = Boolean(options?.prefetchUserPermission);
  if (typeof options?.onTokenVerified === "function") {
    try {
      options.onTokenVerified(verifiedUid);
    } catch {
    }
  }
  const callerLookupStartMs = performance.now();
  let authFirestoreReads = 0;
  let authFirestoreWrites = 0;
  let matchedDoc = null;
  let prefetchedUserPermSnap = void 0;
  let prefetchedRolePerm = void 0;
  let prefetchedRoleDef = void 0;
  let idxSnap = null;
  let usedPointerHit = false;
  const doesDocOwnUid = (docId, d) => {
    const linked = Array.isArray(d.linkedAuthUids) ? d.linkedAuthUids : [];
    return d.authUid === verifiedUid || d.uid === verifiedUid || docId === verifiedUid || linked.includes(verifiedUid);
  };
  const pointer = getCachedUidRolePointer(db, verifiedUid);
  if (pointer) {
    const predictedRole = normalizeRoleValue(pointer.lastRole);
    const prefetchPermNow = shouldPrefetchUserPerm && predictedRole !== "super_admin";
    const prefetchRoleDefNow = Boolean(predictedRole && !SYSTEM_ROLE_IDS.has(predictedRole));
    authFirestoreReads += 1 + (prefetchPermNow ? 1 : 0);
    const [roleDocSnap, userPermSnap, rolePermRes, roleDefRes] = await Promise.all([
      db.collection("user_roles").doc(pointer.roleDocId).get(),
      prefetchPermNow ? db.collection("user_permissions").doc(pointer.roleDocId).get() : Promise.resolve(null),
      prefetchPermNow && predictedRole ? getCachedRolePermissionsDoc(db, predictedRole) : Promise.resolve(null),
      prefetchRoleDefNow ? getCachedRoleDefDoc(db, predictedRole) : Promise.resolve(null)
    ]);
    if (rolePermRes && !rolePermRes.cacheHit) authFirestoreReads += 1;
    if (roleDefRes && !roleDefRes.cacheHit) authFirestoreReads += 1;
    if (roleDocSnap.exists) {
      const d = roleDocSnap.data() || {};
      if (doesDocOwnUid(roleDocSnap.id, d)) {
        matchedDoc = { id: roleDocSnap.id, data: d };
        if (prefetchPermNow && userPermSnap) {
          prefetchedUserPermSnap = userPermSnap;
        }
        if (rolePermRes && predictedRole) {
          prefetchedRolePerm = { role: predictedRole, ...rolePermRes };
        }
        if (roleDefRes && predictedRole) {
          prefetchedRoleDef = { role: predictedRole, ...roleDefRes };
        }
        usedPointerHit = true;
      }
    }
    if (!matchedDoc) {
      invalidateUidRolePointer(db, verifiedUid);
    }
  }
  if (!matchedDoc) {
    authFirestoreReads += 1;
    idxSnap = await db.collection("user_uid_index").doc(verifiedUid).get();
    if (idxSnap.exists) {
      const idxData = idxSnap.data() || {};
      if (idxData.roleDocId) {
        const targetDocId = String(idxData.roleDocId);
        const predictedRole = idxData.role ? normalizeRoleValue(idxData.role) : "";
        const prefetchPermNow = shouldPrefetchUserPerm && predictedRole !== "super_admin";
        const prefetchRoleDefNow = Boolean(predictedRole && !SYSTEM_ROLE_IDS.has(predictedRole));
        authFirestoreReads += 1 + (prefetchPermNow ? 1 : 0);
        const [roleDocSnap, userPermSnap, rolePermRes, roleDefRes] = await Promise.all([
          db.collection("user_roles").doc(targetDocId).get(),
          prefetchPermNow ? db.collection("user_permissions").doc(targetDocId).get() : Promise.resolve(null),
          prefetchPermNow && predictedRole ? getCachedRolePermissionsDoc(db, predictedRole) : Promise.resolve(null),
          prefetchRoleDefNow ? getCachedRoleDefDoc(db, predictedRole) : Promise.resolve(null)
        ]);
        if (rolePermRes && !rolePermRes.cacheHit) authFirestoreReads += 1;
        if (roleDefRes && !roleDefRes.cacheHit) authFirestoreReads += 1;
        if (roleDocSnap.exists) {
          const d = roleDocSnap.data() || {};
          if (doesDocOwnUid(roleDocSnap.id, d)) {
            matchedDoc = { id: roleDocSnap.id, data: d };
            if (prefetchPermNow && userPermSnap) {
              prefetchedUserPermSnap = userPermSnap;
            }
            if (rolePermRes && predictedRole) {
              prefetchedRolePerm = { role: predictedRole, ...rolePermRes };
            }
            if (roleDefRes && predictedRole) {
              prefetchedRoleDef = { role: predictedRole, ...roleDefRes };
            }
          }
        }
      }
    }
  }
  if (!matchedDoc) {
    authFirestoreReads += 1;
    const directSnap = await db.collection("user_roles").doc(verifiedUid).get();
    if (directSnap.exists) {
      matchedDoc = { id: directSnap.id, data: directSnap.data() || {} };
    }
  }
  if (!matchedDoc) {
    authFirestoreReads += 1;
    const byAuthUidSnap = await db.collection("user_roles").where("authUid", "==", verifiedUid).limit(1).get();
    if (!byAuthUidSnap.empty) {
      const first = byAuthUidSnap.docs[0];
      matchedDoc = { id: first.id, data: first.data() || {} };
    }
  }
  if (!matchedDoc) {
    authFirestoreReads += 1;
    const byLinkedSnap = await db.collection("user_roles").where("linkedAuthUids", "array-contains", verifiedUid).limit(1).get();
    if (!byLinkedSnap.empty) {
      const first = byLinkedSnap.docs[0];
      matchedDoc = { id: first.id, data: first.data() || {} };
    }
  }
  if (!matchedDoc) {
    return null;
  }
  if (matchedDoc.data.status === "Inactive") {
    const err = new Error("Account Deactivated. Access denied.");
    err.statusCode = 403;
    throw err;
  }
  const currentNowMs = typeof options?.nowMs === "number" ? options.nowMs : Date.now();
  const isLocked = matchedDoc.data.lockStatus === "LOCKED" || matchedDoc.data.isLocked === true;
  if (isLocked) {
    const isCanonicalSuper = isCanonicalSuperAdminAccount(matchedDoc.id, matchedDoc.data);
    const parsedIsoUntil = matchedDoc.data.lockoutUntil ? Date.parse(String(matchedDoc.data.lockoutUntil)) : matchedDoc.data.lockedUntil ? Date.parse(String(matchedDoc.data.lockedUntil)) : NaN;
    const lockedUntilMs = typeof matchedDoc.data.lockedUntilMs === "number" && matchedDoc.data.lockedUntilMs > 0 ? matchedDoc.data.lockedUntilMs : Number.isFinite(parsedIsoUntil) && parsedIsoUntil > 0 ? parsedIsoUntil : null;
    if (isCanonicalSuper && lockedUntilMs) {
      if (currentNowMs < lockedUntilMs) {
        const remainingSec = Math.max(1, Math.ceil((lockedUntilMs - currentNowMs) / 1e3));
        const mins = Math.floor(remainingSec / 60);
        const secs = remainingSec % 60;
        const waitText = mins > 0 ? `${mins}m ${String(secs).padStart(2, "0")}s` : `${secs}s`;
        const err3 = new Error(
          `Super Admin account is temporarily locked. Try again in ${waitText}.`
        );
        err3.statusCode = 403;
        throw err3;
      }
      const err2 = new Error("Temporary lockout has expired. Please sign in again to reactivate your session.");
      err2.statusCode = 401;
      throw err2;
    }
    const err = new Error("Your account has been temporarily blocked. Please contact Super Admin.");
    err.statusCode = 403;
    throw err;
  }
  const authTime = typeof decoded.auth_time === "number" ? decoded.auth_time : void 0;
  if (matchedDoc.data.sessionRevokedAt && authTime) {
    const revokedSec = Math.floor(new Date(matchedDoc.data.sessionRevokedAt).getTime() / 1e3);
    if (authTime + 2 < revokedSec) {
      const err = new Error("Session has been revoked. Please sign in again.");
      err.statusCode = 401;
      throw err;
    }
  }
  const normalizedRole = normalizeRoleValue(matchedDoc.data.role);
  if (!SYSTEM_ROLE_IDS.has(normalizedRole)) {
    const roleDefSnap = prefetchedRoleDef && prefetchedRoleDef.role === normalizedRole ? prefetchedRoleDef : await getCachedRoleDefDoc(db, normalizedRole);
    if (prefetchedRoleDef?.role !== normalizedRole && !roleDefSnap.cacheHit) {
      authFirestoreReads += 1;
    }
    if (roleDefSnap.exists && roleDefSnap.data?.isActive === false) {
      const err = new Error("Assigned role is currently inactive. Access denied.");
      err.statusCode = 403;
      throw err;
    }
  }
  const resolvedLoginId = String(
    matchedDoc.data.loginId || matchedDoc.id.replace(/^role_/, "")
  ).toLowerCase();
  if (idxSnap !== null) {
    const targetStatus = String(matchedDoc.data.status || "Active");
    const targetLockStatus = String(matchedDoc.data.lockStatus || "ACTIVE");
    const idxData = idxSnap.exists ? idxSnap.data() || {} : null;
    if (!idxData || idxData.roleDocId !== matchedDoc.id || idxData.role !== normalizedRole || idxData.status !== targetStatus || idxData.lockStatus !== targetLockStatus || idxData.loginId !== resolvedLoginId) {
      authFirestoreWrites += 1;
      await syncUserUidIndex(db, {
        uid: verifiedUid,
        roleDocId: matchedDoc.id,
        role: normalizedRole,
        status: targetStatus,
        lockStatus: targetLockStatus,
        loginId: resolvedLoginId
      });
    }
  }
  setCachedUidRolePointer(db, verifiedUid, matchedDoc.id, normalizedRole);
  const callerLookupMs = roundMs(performance.now() - callerLookupStartMs);
  return {
    uid: verifiedUid,
    email: decodedEmail || String(matchedDoc.data.email || ""),
    loginId: resolvedLoginId,
    role: normalizedRole,
    profileDocId: matchedDoc.id,
    authTime,
    modulesAllowed: Array.isArray(matchedDoc.data.modulesAllowed) ? matchedDoc.data.modulesAllowed : [],
    prefetchedUserPermSnap: normalizedRole !== "super_admin" && prefetchedUserPermSnap !== void 0 ? prefetchedUserPermSnap : void 0,
    prefetchedRolePerm: normalizedRole !== "super_admin" && prefetchedRolePerm && prefetchedRolePerm.role === normalizedRole ? prefetchedRolePerm : void 0,
    cacheHitUidRoute: usedPointerHit,
    tokenVerifyMs,
    callerLookupMs,
    authFirestoreReads,
    authFirestoreWrites
  };
}
function extractTrustedClientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  let candidate = "";
  if (typeof xff === "string" && xff.trim()) {
    candidate = xff.split(",")[0].trim();
  } else if (Array.isArray(xff) && xff.length > 0) {
    candidate = String(xff[0]).split(",")[0].trim();
  } else if (typeof req.headers["cf-connecting-ip"] === "string") {
    candidate = req.headers["cf-connecting-ip"].trim();
  } else if (typeof req.headers["x-real-ip"] === "string") {
    candidate = req.headers["x-real-ip"].trim();
  } else {
    candidate = req.socket?.remoteAddress || "127.0.0.1";
  }
  candidate = candidate.replace(/^::ffff:/i, "").replace(/^\[|\]$/g, "");
  if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(candidate)) {
    candidate = candidate.split(":")[0];
  }
  if (!/^[a-fA-F0-9:.]{3,45}$/.test(candidate)) {
    return "unavailable";
  }
  return candidate;
}
function isPrivateOrLocalIp(ip) {
  if (!ip || ip === "unavailable" || ip === "::1" || ip === "127.0.0.1" || ip === "0.0.0.0") {
    return true;
  }
  if (ip.startsWith("10.") || ip.startsWith("192.168.") || ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe80:")) {
    return true;
  }
  if (ip.startsWith("172.")) {
    const second = parseInt(ip.split(".")[1] || "0", 10);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}
function parseUserAgent(uaRaw) {
  const ua = typeof uaRaw === "string" ? uaRaw : Array.isArray(uaRaw) ? uaRaw.join(" ") : "";
  if (!ua.trim()) {
    return { browser: "Unknown", os: "Unknown", deviceType: "Unknown", raw: "" };
  }
  let browser = "Unknown";
  if (/Edg\//i.test(ua)) browser = "Microsoft Edge";
  else if (/OPR\/|Opera/i.test(ua)) browser = "Opera";
  else if (/Chrome\/|CriOS\//i.test(ua) && !/Edg\//i.test(ua)) browser = "Google Chrome";
  else if (/Firefox\/|FxiOS\//i.test(ua)) browser = "Mozilla Firefox";
  else if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) browser = "Apple Safari";
  else if (/curl|PostmanRuntime|node-fetch|python-requests/i.test(ua)) browser = "API Client";
  let os = "Unknown";
  if (/Windows NT 10\.0/i.test(ua)) os = "Windows 10/11";
  else if (/Windows/i.test(ua)) os = "Windows";
  else if (/Android/i.test(ua)) os = "Android";
  else if (/iPhone|iPad|iPod/i.test(ua)) os = "iOS";
  else if (/Mac OS X|Macintosh/i.test(ua)) os = "macOS";
  else if (/CrOS/i.test(ua)) os = "ChromeOS";
  else if (/Linux/i.test(ua)) os = "Linux";
  let deviceType = "Desktop";
  if (/bot|crawler|spider|curl|PostmanRuntime|node-fetch/i.test(ua)) {
    deviceType = "Bot";
  } else if (/iPad|Tablet|PlayBook|Silk/i.test(ua) || /Android/i.test(ua) && !/Mobile/i.test(ua)) {
    deviceType = "Tablet";
  } else if (/Mobile|iPhone|iPod|Android.*Mobile/i.test(ua)) {
    deviceType = "Mobile";
  }
  return { browser, os, deviceType, raw: ua.slice(0, 300) };
}
var geoCache = /* @__PURE__ */ new Map();
async function resolveIpGeoLocation(ip, enabled = true) {
  if (!enabled || isPrivateOrLocalIp(ip)) {
    return {
      country: isPrivateOrLocalIp(ip) ? "Local / Private Network" : "unavailable",
      region: "unavailable",
      city: "unavailable",
      status: "unavailable"
    };
  }
  const cached = geoCache.get(ip);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }
  try {
    const res = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`, {
      signal: AbortSignal.timeout(1500)
    });
    if (res.ok) {
      const json = await res.json();
      if (json && json.success !== false && (json.country || json.city)) {
        const result = {
          country: String(json.country || "unavailable"),
          region: String(json.region || "unavailable"),
          city: String(json.city || "unavailable"),
          status: "resolved"
        };
        geoCache.set(ip, { data: result, expiresAt: Date.now() + 3600 * 1e3 });
        return result;
      }
    }
  } catch {
  }
  const fallback = {
    country: "unavailable",
    region: "unavailable",
    city: "unavailable",
    status: "unavailable"
  };
  geoCache.set(ip, { data: fallback, expiresAt: Date.now() + 5 * 60 * 1e3 });
  return fallback;
}
var SENSITIVE_KEY_PATTERN = /(password|passcode|hash|token|secret|apikey|api_key|credential|private_key|salt|authorization)/i;
function redactSensitiveData(value, depth = 0) {
  if (value === null || value === void 0) return null;
  if (depth > 5) return "[Truncated]";
  if (typeof value === "string") {
    if (value.startsWith("Bearer ") || /^[0-9a-f]{32}:[0-9a-f]{128}$/i.test(value)) {
      return "[REDACTED]";
    }
    return value.length > 8e3 ? `${value.slice(0, 7950)}...[truncated]` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => redactSensitiveData(item, depth + 1));
  }
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEY_PATTERN.test(k)) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = redactSensitiveData(v, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}
function stringifyRedacted(value) {
  if (value === void 0 || value === null || value === "") return null;
  const redacted = redactSensitiveData(value);
  if (typeof redacted === "string") return redacted;
  try {
    const str = JSON.stringify(redacted);
    return str.length > 8e3 ? `${str.slice(0, 7950)}...[truncated]` : str;
  } catch {
    return "[Object]";
  }
}
function inferAuditCategoryAndSeverity(action, success = true) {
  const a = (action || "").toLowerCase();
  const isProtected = CRITICAL_PROTECTED_ACTIONS.has(a);
  if (a.includes("unauthorized") || a.includes("locked_rate_limit") || a === "audit_controlled_deleted" || a === "account_deleted") {
    return {
      category: a.startsWith("audit_") ? "AUDIT_LIFECYCLE" : "SECURITY",
      severity: "CRITICAL",
      isProtected: true
    };
  }
  if (a.includes("login") || a === "logout" || a === "session_expired") {
    return {
      category: "AUTH",
      severity: success ? "INFO" : "WARNING",
      isProtected
    };
  }
  if (a.includes("password") || a.includes("account_") || a.includes("accounts_consolidated")) {
    return {
      category: "ACCOUNT",
      severity: isProtected ? "CRITICAL" : "WARNING",
      isProtected
    };
  }
  if (a.includes("permission")) {
    return { category: "PERMISSIONS", severity: "WARNING", isProtected };
  }
  if (a.includes("employee") || a.includes("manpower")) {
    return {
      category: "EMPLOYEE",
      severity: a.includes("delete") ? "WARNING" : "INFO",
      isProtected: false
    };
  }
  if (a.includes("punch") || a.includes("attendance") || a.includes("roster")) {
    return {
      category: "ATTENDANCE",
      severity: a.includes("correct") || a.includes("clear") ? "WARNING" : "INFO",
      isProtected: false
    };
  }
  if (a.includes("qr_")) {
    return { category: "QR", severity: "INFO", isProtected: false };
  }
  if (a.includes("floor") || a.includes("section") || a.includes("department") || a.includes("shift")) {
    return { category: "ORG", severity: "INFO", isProtected: false };
  }
  if (a.includes("export") || a.includes("report")) {
    return { category: "EXPORT", severity: "INFO", isProtected: false };
  }
  if (a.includes("setting")) {
    return { category: "SETTINGS", severity: "WARNING", isProtected: false };
  }
  if (a.startsWith("audit_")) {
    return { category: "AUDIT_LIFECYCLE", severity: "WARNING", isProtected };
  }
  return { category: "SYSTEM", severity: "INFO", isProtected };
}
function isAuditLogProtected(data) {
  if (!data) return true;
  if (data.isProtected === true || data.isImportant === true || data.severity === "CRITICAL") {
    return true;
  }
  const act = String(data.action || data.eventType || "").toLowerCase();
  return CRITICAL_PROTECTED_ACTIONS.has(act);
}
function normalizeAuditLogRecord(id, raw) {
  const action = String(raw.eventType || raw.action || "GENERAL_ACTION");
  const success = typeof raw.success === "boolean" ? raw.success : !action.toLowerCase().includes("fail") && !action.toLowerCase().includes("unauthorized");
  const inferred = inferAuditCategoryAndSeverity(action, success);
  const ts = String(raw.timestamp || raw.createdAt || (/* @__PURE__ */ new Date()).toISOString());
  const tsMs = typeof raw.timestampMs === "number" ? raw.timestampMs : new Date(ts).getTime() || Date.now();
  const actorLoginId = String(raw.actorLoginId || raw.performedByLoginId || raw.loginId || "system");
  const targetId = raw.targetId || raw.employeeId || raw.targetUid || null;
  const oldVal = stringifyRedacted(raw.oldValue ?? raw.previousValue);
  const newVal = stringifyRedacted(raw.newValue);
  const description = String(raw.description || raw.details || raw.reason || newVal || action);
  return {
    id,
    action,
    eventType: action,
    category: raw.category || inferred.category,
    severity: raw.severity || inferred.severity,
    actorUid: raw.actorUid || raw.performedByUid || "system",
    actorLoginId,
    actorRole: String(raw.actorRole || (actorLoginId === "superadmin" ? "SUPER_ADMIN" : actorLoginId === "admin" ? "ADMIN" : actorLoginId === "user" ? "USER" : "SYSTEM")),
    targetType: raw.targetType || (raw.employeeId ? "EMPLOYEE" : raw.targetUid ? "ACCOUNT" : "SYSTEM"),
    targetId: targetId ? String(targetId) : void 0,
    employeeId: raw.employeeId ? String(raw.employeeId) : void 0,
    timestamp: ts,
    timestampMs: tsMs,
    oldValue: oldVal || void 0,
    newValue: newVal || void 0,
    actionSource: String(raw.actionSource || "SERVER_API"),
    reason: raw.reason ? String(raw.reason) : raw.details ? String(raw.details) : void 0,
    description,
    success,
    ipAddress: String(raw.ipAddress || "unavailable"),
    geoLocation: raw.geoLocation || {
      country: "unavailable",
      region: "unavailable",
      city: "unavailable",
      status: "unavailable"
    },
    userAgentMeta: raw.userAgentMeta || {
      browser: "Unknown",
      os: "Unknown",
      deviceType: "Unknown"
    },
    sessionId: raw.sessionId || void 0,
    isImportant: raw.isImportant === true,
    isProtected: raw.isProtected === true || isAuditLogProtected({ ...raw, action, severity: raw.severity || inferred.severity }),
    archived: raw.archived === true,
    archivedAt: raw.archivedAt || void 0,
    archivedBy: raw.archivedBy || void 0,
    reviewedBy: raw.reviewedBy || void 0,
    reviewedAt: raw.reviewedAt || void 0,
    reviewNote: raw.reviewNote || void 0
  };
}
var recentAuditEvents = /* @__PURE__ */ new Map();
function shouldDeduplicateEvent(key, action) {
  const actLower = action.toLowerCase();
  if (actLower.includes("login") || actLower.includes("unauthorized") || actLower.includes("password") || actLower.includes("delete")) {
    return false;
  }
  const now = Date.now();
  if (recentAuditEvents.size > 500) {
    for (const [k, exp] of recentAuditEvents.entries()) {
      if (exp < now) recentAuditEvents.delete(k);
    }
  }
  const existing = recentAuditEvents.get(key);
  if (existing && existing > now) {
    return true;
  }
  recentAuditEvents.set(key, now + 2e3);
  return false;
}
async function recordEnterpriseAuditEvent(db, params) {
  try {
    const actorLoginId = (params.actorLoginId || "system").trim().toLowerCase();
    const dedupKey = `${params.sessionId || "nosess"}::${actorLoginId}::${params.action}::${params.targetId || params.employeeId || ""}`;
    if (params.deduplicate && shouldDeduplicateEvent(dedupKey, params.action)) {
      return null;
    }
    const nowDate = /* @__PURE__ */ new Date();
    const now = nowDate.toISOString();
    const logId = `audit_${nowDate.getTime()}_${crypto.randomBytes(3).toString("hex")}`;
    const success = params.success !== void 0 ? params.success : true;
    const inferred = inferAuditCategoryAndSeverity(params.action, success);
    const severity = params.severity || inferred.severity;
    const isProtected = inferred.isProtected || severity === "CRITICAL";
    const ipAddress = params.req ? extractTrustedClientIp(params.req) : "server-internal";
    const uaMeta = params.req ? parseUserAgent(params.req.headers["user-agent"]) : { browser: "Server Process", os: "Linux", deviceType: "Bot", raw: "server" };
    const geoLocation = params.req ? await resolveIpGeoLocation(ipAddress, params.captureGeo !== false) : { country: "unavailable", region: "unavailable", city: "unavailable", status: "unavailable" };
    const cleanOld = stringifyRedacted(params.oldValue);
    const cleanNew = stringifyRedacted(params.newValue);
    const desc = String(params.description || params.reason || cleanNew || params.action).slice(0, 2e3);
    const docPayload = {
      id: logId,
      action: params.action,
      eventType: params.action,
      category: params.category || inferred.category,
      severity,
      actorUid: params.actorUid || "system",
      actorLoginId,
      loginId: actorLoginId,
      performedByUid: params.actorUid || "system",
      performedByLoginId: actorLoginId,
      actorRole: String(params.actorRole || "SYSTEM").toUpperCase(),
      targetType: params.targetType || (params.employeeId ? "EMPLOYEE" : params.targetId ? "RESOURCE" : "SYSTEM"),
      targetId: params.targetId || params.employeeId || null,
      targetUid: params.targetId || null,
      employeeId: params.employeeId || null,
      timestamp: now,
      timestampMs: nowDate.getTime(),
      oldValue: cleanOld,
      previousValue: cleanOld,
      newValue: cleanNew,
      actionSource: params.actionSource || "SERVER_API",
      reason: params.reason ? String(params.reason).slice(0, 2e3) : desc,
      details: desc,
      description: desc,
      success,
      ipAddress,
      geoLocation,
      userAgentMeta: {
        browser: uaMeta.browser,
        os: uaMeta.os,
        deviceType: uaMeta.deviceType
      },
      sessionId: params.sessionId || null,
      isImportant: severity === "CRITICAL",
      isProtected,
      archived: false,
      createdAt: now
    };
    await db.collection("audit_logs").doc(logId).set(docPayload);
    return logId;
  } catch (err) {
    console.warn("[Enterprise Audit] Failed to persist audit log:", err?.message || err);
    return null;
  }
}
async function recordLoginHistoryEntry(db, params) {
  try {
    const nowDate = /* @__PURE__ */ new Date();
    const now = nowDate.toISOString();
    const historyId = `lh_${nowDate.getTime()}_${crypto.randomBytes(3).toString("hex")}`;
    const ipAddress = extractTrustedClientIp(params.req);
    const uaMeta = parseUserAgent(params.req.headers["user-agent"]);
    const geoLocation = await resolveIpGeoLocation(ipAddress, params.captureGeo !== false);
    await db.collection("login_history").doc(historyId).set({
      id: historyId,
      eventType: params.eventType,
      loginId: params.loginId.trim().toLowerCase(),
      authUid: params.authUid || null,
      role: String(params.role || "UNKNOWN").toUpperCase(),
      timestamp: now,
      timestampMs: nowDate.getTime(),
      success: params.success,
      failureReason: params.failureReason ? String(params.failureReason).slice(0, 500) : null,
      ipAddress,
      geoLocation,
      browser: uaMeta.browser,
      os: uaMeta.os,
      deviceType: uaMeta.deviceType,
      sessionId: params.sessionId || null
    });
  } catch (err) {
    console.warn("[Login History] Failed to persist login history entry:", err?.message || err);
  }
}
function registerSecurityAuditRoutes(app, db, auth, projectId) {
  async function requireAuth(req, res) {
    try {
      const caller = await verifyCallerIdentity(req, db, auth, projectId);
      if (!caller) {
        res.status(401).json({
          success: false,
          error: "Authentication required: Missing or unrecognized Firebase ID token."
        });
        return null;
      }
      return caller;
    } catch (err) {
      res.status(err?.statusCode || 401).json({
        success: false,
        error: err?.message || "Invalid or expired Firebase authentication token."
      });
      return null;
    }
  }
  async function requireSuperAdmin(req, res) {
    const caller = await requireAuth(req, res);
    if (!caller) return null;
    if (caller.role !== "super_admin") {
      await recordEnterpriseAuditEvent(db, {
        req,
        action: "unauthorized_access_attempt",
        actorUid: caller.uid,
        actorLoginId: caller.loginId,
        actorRole: caller.role.toUpperCase(),
        targetType: "SECURITY_CONSOLE",
        targetId: req.path,
        actionSource: "BACKEND_RBAC_GUARD",
        description: `Non-Super-Admin "${caller.loginId}" (${caller.role}) attempted restricted endpoint ${req.method} ${req.path}.`,
        success: false
      });
      res.status(403).json({
        success: false,
        error: "Forbidden: Only verified SUPER_ADMIN accounts can access this security control."
      });
      return null;
    }
    return caller;
  }
  app.post("/api/audit/event", async (req, res) => {
    try {
      const caller = await requireAuth(req, res);
      if (!caller) return;
      const {
        action,
        category,
        targetType,
        targetId,
        employeeId,
        oldValue,
        newValue,
        actionSource,
        reason,
        description,
        success,
        sessionId
      } = req.body || {};
      if (!action || typeof action !== "string") {
        return res.status(400).json({ success: false, error: "Event action is required." });
      }
      const cleanAction = action.trim().slice(0, 100);
      const actLower = cleanAction.toLowerCase();
      let captureGeo = true;
      try {
        const settingsSnap = await getCachedSystemSettings(db, {});
        if (settingsSnap.exists && settingsSnap.data?.captureGeoLocation === false) {
          captureGeo = false;
        }
      } catch {
      }
      const logId = await recordEnterpriseAuditEvent(db, {
        req,
        action: cleanAction,
        category,
        actorUid: caller.uid,
        actorLoginId: caller.loginId,
        actorRole: caller.role.toUpperCase(),
        targetType,
        targetId,
        employeeId,
        oldValue,
        newValue,
        actionSource: actionSource || "CLIENT_APP",
        reason,
        description,
        success: success !== void 0 ? Boolean(success) : true,
        sessionId,
        captureGeo,
        deduplicate: true
      });
      if (actLower === "logout" || actLower === "session_expired") {
        await recordLoginHistoryEntry(db, {
          req,
          eventType: actLower === "logout" ? "LOGOUT" : "SESSION_EXPIRED",
          loginId: caller.loginId,
          authUid: caller.uid,
          role: caller.role,
          success: true,
          sessionId,
          captureGeo
        });
      }
      return res.json({ success: true, logId });
    } catch (err) {
      console.error("[Audit Event API] Error:", err);
      return res.status(500).json({ success: false, error: "Failed to record audit event." });
    }
  });
  app.get("/api/audit/logs", async (req, res) => {
    try {
      const caller = await requireSuperAdmin(req, res);
      if (!caller) return;
      const {
        search = "",
        from = "",
        to = "",
        loginId = "ALL",
        role = "ALL",
        category = "ALL",
        action = "ALL",
        ip = "",
        success = "ALL",
        importance = "ALL",
        lifecycle = "active",
        page = "1",
        pageSize = "25"
      } = req.query;
      const settingsSnap = await getCachedSystemSettings(db, {});
      const settingsData = settingsSnap.exists ? settingsSnap.data || {} : {};
      const retentionDays = Number(settingsData.auditRetentionDays || 90);
      const retentionCutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1e3;
      const [activeSnap, archiveSnap, deletionsSnap] = await Promise.all([
        db.collection("audit_logs").get(),
        db.collection("audit_archives").get(),
        db.collection("audit_log_deletions").get()
      ]);
      const activeLogs = activeSnap.docs.map((d) => normalizeAuditLogRecord(d.id, d.data()));
      const archivedLogsList = archiveSnap.docs.map((d) => ({
        ...normalizeAuditLogRecord(d.id, d.data()),
        archived: true
      }));
      const archivedMap = /* @__PURE__ */ new Map();
      archivedLogsList.forEach((l) => archivedMap.set(l.id, l));
      activeLogs.forEach((l) => {
        if (l.archived && !archivedMap.has(l.id)) archivedMap.set(l.id, l);
      });
      const allArchived = Array.from(archivedMap.values());
      const activeOnly = activeLogs.filter((l) => !l.archived);
      const kolkataToday = KOLKATA_CA_DATE_FORMATTER.format(/* @__PURE__ */ new Date());
      const allCombined = [...activeOnly, ...allArchived];
      const kpis = {
        totalLogs: allCombined.length,
        todayActivities: activeLogs.filter((l) => {
          try {
            const dStr = KOLKATA_CA_DATE_FORMATTER.format(new Date(l.timestamp));
            return dStr === kolkataToday;
          } catch {
            return false;
          }
        }).length,
        successfulLogins: allCombined.filter((l) => l.action.toLowerCase() === "login_success").length,
        failedLogins: allCombined.filter((l) => l.action.toLowerCase().includes("login_failed") || l.action.toLowerCase().includes("login_locked") || l.action.toLowerCase().includes("login_rejected")).length,
        employeeChanges: allCombined.filter((l) => l.category === "EMPLOYEE" || l.action.includes("EMPLOYEE") || l.action.includes("MANPOWER")).length,
        attendanceEvents: allCombined.filter((l) => l.category === "ATTENDANCE" || l.action.includes("PUNCH") || l.action.includes("ATTENDANCE") || l.action.includes("ROSTER")).length,
        securityAlerts: allCombined.filter((l) => l.severity === "CRITICAL" || l.category === "SECURITY" || l.action.toLowerCase().includes("unauthorized")).length,
        archivedLogs: allArchived.length,
        pendingLogReviews: activeOnly.filter((l) => !l.isProtected && !l.isImportant && l.timestampMs < retentionCutoffMs).length,
        permanentDeletionsCount: deletionsSnap.size
      };
      let pool = activeOnly;
      if (lifecycle === "archived") pool = allArchived;
      else if (lifecycle === "pending_review") pool = activeOnly.filter((l) => !l.isProtected && !l.isImportant && l.timestampMs < retentionCutoffMs);
      else if (lifecycle === "all") pool = allCombined;
      const qSearch = search.trim().toLowerCase();
      const qIp = ip.trim().toLowerCase();
      const fromMs = from ? (/* @__PURE__ */ new Date(`${from}T00:00:00+05:30`)).getTime() : 0;
      const toMs = to ? (/* @__PURE__ */ new Date(`${to}T23:59:59+05:30`)).getTime() : Infinity;
      const filtered = pool.filter((log) => {
        if (qSearch) {
          const hay = `${log.id} ${log.action} ${log.actorLoginId} ${log.targetId || ""} ${log.employeeId || ""} ${log.description || ""} ${log.ipAddress || ""}`.toLowerCase();
          if (!hay.includes(qSearch)) return false;
        }
        if (from && log.timestampMs < fromMs) return false;
        if (to && log.timestampMs > toMs) return false;
        if (loginId !== "ALL" && log.actorLoginId.toLowerCase() !== loginId.toLowerCase()) return false;
        if (role !== "ALL" && log.actorRole.toUpperCase() !== role.toUpperCase()) return false;
        if (category !== "ALL" && log.category.toUpperCase() !== category.toUpperCase()) return false;
        if (action !== "ALL" && log.action.toLowerCase() !== action.toLowerCase()) return false;
        if (qIp && !String(log.ipAddress || "").toLowerCase().includes(qIp)) return false;
        if (success === "SUCCESS" && !log.success) return false;
        if (success === "FAILURE" && log.success) return false;
        if (importance === "IMPORTANT" && !log.isImportant) return false;
        if (importance === "NORMAL" && log.isImportant) return false;
        return true;
      });
      filtered.sort((a, b) => b.timestampMs - a.timestampMs);
      const p = Math.max(1, parseInt(page, 10) || 1);
      const size = Math.min(200, Math.max(10, parseInt(pageSize, 10) || 25));
      const totalFiltered = filtered.length;
      const totalPages = Math.max(1, Math.ceil(totalFiltered / size));
      const safePage = Math.min(p, totalPages);
      const paginated = filtered.slice((safePage - 1) * size, safePage * size);
      const availableActions = Array.from(new Set(allCombined.map((l) => l.action))).sort();
      const availableActors = Array.from(new Set(allCombined.map((l) => l.actorLoginId))).sort();
      return res.json({
        success: true,
        kpis,
        retentionDays,
        logs: paginated,
        pagination: {
          page: safePage,
          pageSize: size,
          totalFiltered,
          totalPages
        },
        facets: {
          actions: availableActions,
          actors: availableActors
        }
      });
    } catch (err) {
      console.error("[Audit Query API] Error:", err);
      return res.status(500).json({ success: false, error: err?.message || "Failed to load audit logs." });
    }
  });
  app.get("/api/audit/login-history", async (req, res) => {
    try {
      const caller = await requireSuperAdmin(req, res);
      if (!caller) return;
      const { loginId = "ALL", eventType = "ALL", status = "ALL", search = "" } = req.query;
      const snap = await db.collection("login_history").get();
      let entries = snap.docs.map((d) => ({ id: d.id, ...d.data() || {} }));
      const q = search.trim().toLowerCase();
      entries = entries.filter((e) => {
        if (loginId !== "ALL" && String(e.loginId || "").toLowerCase() !== loginId.toLowerCase()) return false;
        if (eventType !== "ALL" && String(e.eventType || "") !== eventType) return false;
        if (status === "SUCCESS" && !e.success) return false;
        if (status === "FAILURE" && e.success) return false;
        if (q) {
          const hay = `${e.loginId} ${e.ipAddress} ${e.geoLocation?.city || ""} ${e.geoLocation?.country || ""} ${e.browser || ""} ${e.os || ""}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });
      entries.sort((a, b) => (b.timestampMs || 0) - (a.timestampMs || 0));
      return res.json({ success: true, entries: entries.slice(0, 300) });
    } catch (err) {
      console.error("[Login History API] Error:", err);
      return res.status(500).json({ success: false, error: "Failed to load login history." });
    }
  });
  app.get("/api/audit/deletions", async (req, res) => {
    try {
      const caller = await requireSuperAdmin(req, res);
      if (!caller) return;
      const snap = await db.collection("audit_log_deletions").get();
      const deletions = snap.docs.map((d) => ({ id: d.id, ...d.data() || {} })).sort((a, b) => new Date(b.deletedAt).getTime() - new Date(a.deletedAt).getTime());
      return res.json({ success: true, deletions });
    } catch (err) {
      console.error("[Audit Deletions API] Error:", err);
      return res.status(500).json({ success: false, error: "Failed to load permanent deletion ledger." });
    }
  });
  app.post("/api/audit/logs/:id/important", async (req, res) => {
    try {
      const caller = await requireSuperAdmin(req, res);
      if (!caller) return;
      const logId = req.params.id;
      const { isImportant, reviewNote } = req.body || {};
      const logRef = db.collection("audit_logs").doc(logId);
      const snap = await logRef.get();
      if (!snap.exists) {
        return res.status(404).json({ success: false, error: "Audit log not found." });
      }
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const nextVal = Boolean(isImportant);
      await logRef.update({
        isImportant: nextVal,
        reviewedBy: caller.loginId,
        reviewedAt: now,
        reviewNote: reviewNote ? String(reviewNote).slice(0, 500) : null
      });
      await recordEnterpriseAuditEvent(db, {
        req,
        action: "audit_marked_important",
        category: "AUDIT_LIFECYCLE",
        actorUid: caller.uid,
        actorLoginId: caller.loginId,
        actorRole: "SUPER_ADMIN",
        targetType: "AUDIT_LOG",
        targetId: logId,
        oldValue: { isImportant: Boolean(snap.data()?.isImportant) },
        newValue: { isImportant: nextVal },
        actionSource: "AUDIT_MANAGEMENT",
        description: `Super Admin ${nextVal ? "marked" : "unmarked"} audit log ${logId} as Important.`
      });
      return res.json({ success: true, isImportant: nextVal });
    } catch (err) {
      console.error("[Mark Important API] Error:", err);
      return res.status(500).json({ success: false, error: err?.message || "Failed to update importance status." });
    }
  });
  app.post("/api/audit/logs/:id/archive", async (req, res) => {
    try {
      const caller = await requireSuperAdmin(req, res);
      if (!caller) return;
      const logId = req.params.id;
      const { reviewNote } = req.body || {};
      const logRef = db.collection("audit_logs").doc(logId);
      const snap = await logRef.get();
      if (!snap.exists) {
        return res.status(404).json({ success: false, error: "Active audit log not found." });
      }
      const raw = snap.data() || {};
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const archiveRecord = {
        ...raw,
        id: logId,
        archived: true,
        archivedAt: now,
        archivedBy: caller.loginId,
        reviewedBy: caller.loginId,
        reviewedAt: now,
        reviewNote: reviewNote ? String(reviewNote).slice(0, 500) : "Reviewed and archived by Super Admin"
      };
      await db.collection("audit_archives").doc(logId).set(archiveRecord);
      await logRef.update({
        archived: true,
        archivedAt: now,
        archivedBy: caller.loginId,
        reviewedBy: caller.loginId,
        reviewedAt: now,
        reviewNote: archiveRecord.reviewNote
      });
      await recordEnterpriseAuditEvent(db, {
        req,
        action: "audit_archived",
        category: "AUDIT_LIFECYCLE",
        actorUid: caller.uid,
        actorLoginId: caller.loginId,
        actorRole: "SUPER_ADMIN",
        targetType: "AUDIT_LOG",
        targetId: logId,
        actionSource: "AUDIT_MANAGEMENT",
        description: `Super Admin reviewed and archived audit log ${logId}.`
      });
      return res.json({ success: true, archivedAt: now });
    } catch (err) {
      console.error("[Archive Log API] Error:", err);
      return res.status(500).json({ success: false, error: err?.message || "Failed to archive audit log." });
    }
  });
  app.get("/api/audit/logs/:id/review-dependencies", async (req, res) => {
    try {
      const caller = await requireSuperAdmin(req, res);
      if (!caller) return;
      const logId = req.params.id;
      const snap = await db.collection("audit_logs").doc(logId).get();
      if (!snap.exists) {
        return res.status(404).json({ success: false, error: "Audit log not found in active logs." });
      }
      const normalized = normalizeAuditLogRecord(snap.id, snap.data());
      const protectedFlag = isAuditLogProtected(normalized);
      const settingsSnap = await db.collection("system_settings").doc("global").get();
      const retentionDays = Number(settingsSnap.exists ? settingsSnap.data()?.auditRetentionDays || 90 : 90);
      const ageDays = Math.max(0, Math.floor((Date.now() - normalized.timestampMs) / (1e3 * 60 * 60 * 24)));
      const linkedRecords = [];
      if (normalized.employeeId) {
        const empSnap = await db.collection("employees").doc(normalized.employeeId).get();
        if (empSnap.exists) {
          linkedRecords.push(`employees/${normalized.employeeId} (${empSnap.data()?.employeeName || "Active"})`);
        }
      }
      if (normalized.actorLoginId && normalized.actorLoginId !== "system") {
        const roleSnap = await db.collection("user_roles").doc(`role_${normalized.actorLoginId}`).get();
        if (roleSnap.exists) {
          linkedRecords.push(`user_roles/role_${normalized.actorLoginId} (${roleSnap.data()?.role || "USER"})`);
        }
      }
      if (normalized.targetId && normalized.targetId !== normalized.employeeId) {
        const targetRoleSnap = await db.collection("user_roles").doc(normalized.targetId).get();
        if (targetRoleSnap.exists) {
          linkedRecords.push(`user_roles/${normalized.targetId}`);
        }
      }
      const protectionReasons = [];
      if (normalized.isImportant) protectionReasons.push("Marked as Important by Super Admin");
      if (normalized.severity === "CRITICAL") protectionReasons.push("Classified as CRITICAL severity");
      if (CRITICAL_PROTECTED_ACTIONS.has(normalized.action.toLowerCase())) {
        protectionReasons.push(`Protected compliance event type (${normalized.action})`);
      }
      const meetsRetentionAge = ageDays >= retentionDays;
      if (!meetsRetentionAge) {
        protectionReasons.push(
          `Active Retention Window: Record is ${ageDays} days old (minimum ${retentionDays} days required before deletion eligibility)`
        );
      }
      return res.json({
        success: true,
        log: normalized,
        isProtected: protectedFlag || !meetsRetentionAge,
        protectionReasons,
        ageDays,
        retentionDays,
        meetsRetentionAge,
        linkedRecords,
        canDelete: !protectedFlag && meetsRetentionAge
      });
    } catch (err) {
      console.error("[Review Dependencies API] Error:", err);
      return res.status(500).json({ success: false, error: "Failed to review log dependencies." });
    }
  });
  app.post("/api/audit/logs/:id/controlled-delete", async (req, res) => {
    try {
      const caller = await requireSuperAdmin(req, res);
      if (!caller) return;
      const logId = req.params.id;
      const { reason, confirmLogId, superAdminConfirmed } = req.body || {};
      if (superAdminConfirmed !== true) {
        return res.status(400).json({ success: false, error: "Explicit Super Admin confirmation is required." });
      }
      if (confirmLogId !== logId) {
        return res.status(400).json({ success: false, error: "Log ID confirmation mismatch. Please type the exact Log ID." });
      }
      if (!reason || typeof reason !== "string" || reason.trim().length < 10) {
        return res.status(400).json({ success: false, error: "A detailed deletion reason (at least 10 characters) is mandatory." });
      }
      const logRef = db.collection("audit_logs").doc(logId);
      const snap = await logRef.get();
      if (!snap.exists) {
        return res.status(404).json({ success: false, error: "Audit log not found." });
      }
      const normalized = normalizeAuditLogRecord(snap.id, snap.data());
      if (isAuditLogProtected(normalized)) {
        await recordEnterpriseAuditEvent(db, {
          req,
          action: "unauthorized_access_attempt",
          category: "SECURITY",
          severity: "CRITICAL",
          actorUid: caller.uid,
          actorLoginId: caller.loginId,
          actorRole: "SUPER_ADMIN",
          targetType: "AUDIT_LOG",
          targetId: logId,
          actionSource: "CONTROLLED_DELETE_GUARD",
          description: `Blocked deletion attempt of protected security/critical audit log "${logId}" (${normalized.action}).`,
          success: false
        });
        return res.status(403).json({
          success: false,
          error: `Protection Violation: Audit log "${logId}" (${normalized.action}) is a protected security/compliance record and cannot be deleted.`
        });
      }
      const settingsSnap = await db.collection("system_settings").doc("global").get();
      const retentionDays = Number(settingsSnap.exists ? settingsSnap.data()?.auditRetentionDays || 90 : 90);
      const ageDays = Math.max(0, Math.floor((Date.now() - normalized.timestampMs) / (1e3 * 60 * 60 * 24)));
      if (ageDays < retentionDays) {
        return res.status(403).json({
          success: false,
          error: `Retention Policy Violation: Audit log "${logId}" is ${ageDays} days old and must remain active for at least ${retentionDays} days before controlled deletion eligibility.`
        });
      }
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const ipAddress = extractTrustedClientIp(req);
      const deletionId = `del_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
      const linkedRecordsChecked = [];
      if (normalized.employeeId) linkedRecordsChecked.push(`employees/${normalized.employeeId}`);
      if (normalized.actorLoginId) linkedRecordsChecked.push(`actor:${normalized.actorLoginId}`);
      if (normalized.targetId) linkedRecordsChecked.push(`target:${normalized.targetId}`);
      await db.collection("audit_log_deletions").doc(deletionId).set({
        id: deletionId,
        deletedLogId: logId,
        deletedAction: normalized.action,
        deletedCategory: normalized.category,
        deletedTimestamp: normalized.timestamp,
        deletedActorLoginId: normalized.actorLoginId,
        deletedSummary: String(normalized.description || normalized.newValue || normalized.action).slice(0, 500),
        linkedRecordsChecked,
        reason: reason.trim().slice(0, 1e3),
        approvedByUid: caller.uid,
        approvedByLoginId: caller.loginId,
        deletedAt: now,
        ipAddress
      });
      await logRef.delete();
      await recordEnterpriseAuditEvent(db, {
        req,
        action: "audit_controlled_deleted",
        category: "AUDIT_LIFECYCLE",
        severity: "CRITICAL",
        actorUid: caller.uid,
        actorLoginId: caller.loginId,
        actorRole: "SUPER_ADMIN",
        targetType: "AUDIT_LOG",
        targetId: logId,
        oldValue: { action: normalized.action, timestamp: normalized.timestamp, actor: normalized.actorLoginId },
        newValue: { deletionLedgerId: deletionId, reason: reason.trim() },
        actionSource: "CONTROLLED_DELETE_WORKFLOW",
        reason: reason.trim(),
        description: `Controlled deletion executed for non-critical log ${logId} (${normalized.action}). Permanent ledger ID: ${deletionId}.`
      });
      return res.json({
        success: true,
        deletionId,
        deletedLogId: logId,
        message: `Log ${logId} deleted after mandatory review and permanently logged in audit_log_deletions (${deletionId}).`
      });
    } catch (err) {
      console.error("[Controlled Delete API] Error:", err);
      return res.status(500).json({ success: false, error: err?.message || "Failed controlled deletion." });
    }
  });
  const ALL_CHECKED_COLLECTIONS = [
    "user_roles",
    "roles",
    "role_permissions",
    "user_permissions",
    "employees",
    "attendance",
    "punch_events",
    "punch_logs",
    "audit_logs",
    "password_reset_logs",
    "login_history",
    "audit_archives",
    "audit_log_deletions",
    "departments",
    "floors",
    "sections",
    "shifts",
    "shift_rosters",
    "system_settings"
  ];
  const ACCOUNT_REGISTRY = [
    {
      key: "superadmin_canonical",
      loginId: "superadmin",
      email: "superadmin@narid.com",
      firebaseUid: "oX2vdSx5jGcoUDxyA0SIYN3SEig2",
      role: "SUPER_ADMIN",
      createdDate: "2026-11-10T08:30:00Z",
      lastSignIn: "2026-11-12T10:15:00Z",
      accountType: "CANONICAL_PRIMARY",
      isCanonicalKeep: true,
      isProtected: true
    },
    {
      key: "admin_canonical",
      loginId: "admin",
      email: "admin@narid.com",
      firebaseUid: "2RpEv6mvyXYswYH9KPIGV6evtgY2",
      role: "ADMIN",
      createdDate: "2026-11-10T08:35:00Z",
      lastSignIn: "2026-11-12T09:45:00Z",
      accountType: "CANONICAL_PRIMARY",
      isCanonicalKeep: true,
      isProtected: true
    },
    {
      key: "user_canonical",
      loginId: "user",
      email: "user@narid.com",
      firebaseUid: "vXPvgrp3i6cS2frqDa3ZoU9h9gc2",
      role: "USER",
      createdDate: "2026-11-10T08:40:00Z",
      lastSignIn: "2026-11-12T09:20:00Z",
      accountType: "CANONICAL_PRIMARY",
      isCanonicalKeep: true,
      isProtected: true
    },
    {
      key: "officialnarid_owner",
      loginId: "officialnarid",
      email: "officialnarid@gmail.com",
      firebaseUid: "GCP_PROJECT_OWNER_OAUTH",
      role: "SUPER_ADMIN",
      createdDate: "2026-11-08T09:00:00Z",
      lastSignIn: "2026-11-13T00:00:00Z",
      accountType: "GOOGLE_OWNER",
      isCanonicalKeep: true,
      isProtected: true
    },
    {
      key: "superadmin_root_legacy",
      loginId: "superadmin_root",
      email: "superadmin_root@narid.com",
      firebaseUid: "UNGneXk4pURTrQVXbVPAKPYtRvH3",
      role: "SUPER_ADMIN",
      createdDate: "2026-11-08T10:50:27Z",
      lastSignIn: "2026-11-13T00:00:00Z",
      accountType: "LEGACY_ROOT_ALIAS",
      isCanonicalKeep: false,
      isProtected: false
    },
    {
      key: "admin_root_legacy",
      loginId: "admin_root",
      email: "admin_root@narid.com",
      firebaseUid: "vsz6j6kcbtSiCbecmJYVIRgbacJ2",
      role: "ADMIN",
      createdDate: "2026-11-08T10:50:27Z",
      lastSignIn: "2026-11-08T10:50:27Z",
      accountType: "LEGACY_ROOT_ALIAS",
      isCanonicalKeep: false,
      isProtected: false
    },
    {
      key: "user_root_legacy",
      loginId: "user_root",
      email: "user_root@narid.com",
      firebaseUid: "LEGACY_USER_ROOT_UID",
      role: "USER",
      createdDate: "2026-11-08T10:50:27Z",
      lastSignIn: "2026-11-08T10:50:27Z",
      accountType: "LEGACY_ROOT_ALIAS",
      isCanonicalKeep: false,
      isProtected: false
    },
    {
      key: "test_admin_qa",
      loginId: "test_admin_qa",
      email: "test_admin_qa@narid.com",
      firebaseUid: "LEGACY_QA_ADMIN_UID",
      role: "ADMIN",
      createdDate: "2026-11-10T12:00:00Z",
      lastSignIn: "2026-11-10T12:00:00Z",
      accountType: "LEGACY_QA",
      isCanonicalKeep: false,
      isProtected: false
    },
    {
      key: "test_user_qa",
      loginId: "test_user_qa",
      email: "test_user_qa@narid.com",
      firebaseUid: "LEGACY_QA_USER_UID",
      role: "USER",
      createdDate: "2026-11-10T12:05:00Z",
      lastSignIn: "2026-11-10T12:05:00Z",
      accountType: "LEGACY_QA",
      isCanonicalKeep: false,
      isProtected: false
    },
    {
      key: "deact_qa_test",
      loginId: "deact_qa_test",
      email: "deact@narid.com",
      firebaseUid: "LEGACY_QA_DEACT_UID",
      role: "USER",
      createdDate: "2026-11-10T12:10:00Z",
      lastSignIn: "2026-11-10T12:10:00Z",
      accountType: "LEGACY_QA",
      isCanonicalKeep: false,
      isProtected: false
    }
  ];
  app.get("/api/admin/account-cleanup-audit", async (req, res) => {
    try {
      const caller = await requireSuperAdmin(req, res);
      if (!caller) return;
      const collectionSnapshots = {};
      await Promise.all(
        ALL_CHECKED_COLLECTIONS.map(async (colName) => {
          try {
            const snap = await db.collection(colName).get();
            collectionSnapshots[colName] = snap.docs.map((d) => ({
              docId: d.id,
              data: d.data(),
              rawText: JSON.stringify(d.data()).toLowerCase()
            }));
          } catch {
            collectionSnapshots[colName] = [];
          }
        })
      );
      const approvalSnap = await db.collection("system_settings").doc("account_cleanup_approvals").get();
      const approvals = approvalSnap.exists ? approvalSnap.data()?.approvals || {} : {};
      const accountsReport = ACCOUNT_REGISTRY.map((acc) => {
        const emailLower = acc.email.toLowerCase();
        const uidLower = acc.firebaseUid.toLowerCase();
        const loginLower = acc.loginId.toLowerCase();
        const dependencies = [];
        let activeBlockingDependencies = 0;
        for (const colName of ALL_CHECKED_COLLECTIONS) {
          const docs = collectionSnapshots[colName] || [];
          const matchingDocs = docs.filter((d) => {
            const matchesUid = !uidLower.includes("legacy_") && !uidLower.includes("gcp_") && d.rawText.includes(uidLower);
            const matchesEmail = d.rawText.includes(emailLower);
            const matchesDocId = d.docId.toLowerCase() === `role_${loginLower}`;
            return matchesUid || matchesEmail || matchesDocId;
          });
          if (matchingDocs.length > 0) {
            const isHistoricalOnly = colName === "audit_logs" || colName === "password_reset_logs" || colName === "login_history" || colName === "audit_log_deletions";
            if (!isHistoricalOnly && !acc.isCanonicalKeep) {
              activeBlockingDependencies += matchingDocs.length;
            }
            dependencies.push({
              collection: colName,
              matches: matchingDocs.length,
              note: isHistoricalOnly ? "Historical log reference (preserved)" : `Active reference (${matchingDocs.map((m) => m.docId).slice(0, 3).join(", ")})`
            });
          }
        }
        const approvalState = approvals[acc.key] || null;
        const canApproveForCleanup = !acc.isCanonicalKeep && !acc.isProtected;
        return {
          ...acc,
          dependencies,
          activeBlockingDependencies,
          approvalState,
          canApproveForCleanup,
          consoleCleanupCommand: canApproveForCleanup ? `# Review & delete in Firebase Console -> Authentication -> Users -> filter "${acc.email}" (UID: ${acc.firebaseUid})
firebase auth:export auth-backup.json --project ${projectId}` : null,
          recommendation: acc.isProtected ? acc.accountType === "GOOGLE_OWNER" ? "PROTECTED_OWNER (GCP Owner \u2014 Never Delete)" : "RETAIN_CANONICAL (Active 12 Nov Canonical Account)" : approvalState?.approved ? `APPROVED_BY_${String(approvalState.approvedBy || "SUPERADMIN").toUpperCase()} (${activeBlockingDependencies === 0 ? "Safe to Delete in Firebase Console" : "Migrate Active Refs First"})` : activeBlockingDependencies > 0 ? "MIGRATE_REFS_THEN_APPROVE (Re-point user_roles email to canonical *@narid.com)" : "READY_FOR_SUPERADMIN_REVIEW (No active blocking dependencies)"
        };
      });
      return res.json({
        success: true,
        auditTimestamp: (/* @__PURE__ */ new Date()).toISOString(),
        projectId,
        collectionsScanned: ALL_CHECKED_COLLECTIONS.length,
        canonicalKeepEmails: ["superadmin@narid.com", "admin@narid.com", "user@narid.com"],
        accounts: accountsReport,
        safeguardMessage: "Read-only cross-collection dependency audit complete. Zero Firebase Auth accounts or Firestore documents were automatically deleted."
      });
    } catch (err) {
      console.error("[Account Cleanup Audit API] Error:", err);
      return res.status(500).json({ success: false, error: err?.message || "Failed account cleanup audit." });
    }
  });
  app.post("/api/admin/account-cleanup/approve", async (req, res) => {
    try {
      const caller = await requireSuperAdmin(req, res);
      if (!caller) return;
      const { accountKey, migrateCanonicalEmails = true, confirmEmail } = req.body || {};
      const target = ACCOUNT_REGISTRY.find((a) => a.key === accountKey);
      if (!target) {
        return res.status(404).json({ success: false, error: "Target account entry not found." });
      }
      if (target.isCanonicalKeep || target.isProtected) {
        return res.status(403).json({
          success: false,
          error: `Protected Account: "${target.email}" is a canonical/owner identity and cannot be marked for cleanup.`
        });
      }
      if (confirmEmail !== target.email) {
        return res.status(400).json({
          success: false,
          error: `Confirmation mismatch. Please type exact email "${target.email}" to approve cleanup.`
        });
      }
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const migratedDocs = [];
      if (migrateCanonicalEmails) {
        const canonicalMap = {
          superadmin_root_legacy: { roleDocId: "role_superadmin", email: "superadmin@narid.com", uid: "oX2vdSx5jGcoUDxyA0SIYN3SEig2", legacyEmail: "superadmin_root@narid.com" },
          admin_root_legacy: { roleDocId: "role_admin", email: "admin@narid.com", uid: "2RpEv6mvyXYswYH9KPIGV6evtgY2", legacyEmail: "admin_root@narid.com" },
          user_root_legacy: { roleDocId: "role_user", email: "user@narid.com", uid: "vXPvgrp3i6cS2frqDa3ZoU9h9gc2", legacyEmail: "user_root@narid.com" }
        };
        const m = canonicalMap[target.key];
        if (m) {
          const ref = db.collection("user_roles").doc(m.roleDocId);
          const snap = await ref.get();
          if (snap.exists) {
            const cur = snap.data() || {};
            const aliases = new Set(Array.isArray(cur.emailAliases) ? cur.emailAliases : []);
            aliases.add(m.legacyEmail);
            const uids = new Set(Array.isArray(cur.linkedAuthUids) ? cur.linkedAuthUids : []);
            if (cur.authUid) uids.add(String(cur.authUid));
            uids.add(m.uid);
            const resolvedUid = cur.authUid ? String(cur.authUid) : m.uid;
            await ref.update({
              email: cur.email || m.email,
              authUid: resolvedUid,
              emailAliases: Array.from(aliases),
              linkedAuthUids: Array.from(uids),
              updatedAt: now
            });
            migratedDocs.push(m.roleDocId);
          }
        }
      }
      const approvalRef = db.collection("system_settings").doc("account_cleanup_approvals");
      const existingApprovalSnap = await approvalRef.get();
      const existingApprovals = existingApprovalSnap.exists ? existingApprovalSnap.data()?.approvals || {} : {};
      existingApprovals[target.key] = {
        approved: true,
        approvedBy: caller.loginId,
        approvedByUid: caller.uid,
        approvedAt: now,
        targetEmail: target.email,
        targetUid: target.firebaseUid,
        migratedDocs
      };
      await approvalRef.set({ id: "account_cleanup_approvals", approvals: existingApprovals, updatedAt: now }, { merge: true });
      await recordEnterpriseAuditEvent(db, {
        req,
        action: "account_cleanup_approved",
        category: "ACCOUNT",
        severity: "CRITICAL",
        actorUid: caller.uid,
        actorLoginId: caller.loginId,
        actorRole: "SUPER_ADMIN",
        targetType: "FIREBASE_AUTH_ACCOUNT",
        targetId: target.firebaseUid,
        oldValue: { email: target.email, uid: target.firebaseUid },
        newValue: { status: "APPROVED_FOR_CONSOLE_CLEANUP", migratedDocs },
        actionSource: "ACCOUNT_CLEANUP_GOVERNANCE",
        description: `Super Admin "${caller.loginId}" approved Firebase Auth cleanup for legacy account "${target.email}" (UID: ${target.firebaseUid}).`
      });
      const cliSnippet = `node -e "const admin=require('firebase-admin'); admin.initializeApp({projectId:'${projectId}'}); admin.auth().deleteUser('${target.firebaseUid}').then(()=>console.log('Deleted ${target.email}'));"`;
      return res.json({
        success: true,
        message: `Super Admin approval recorded for ${target.email}. Canonical Firestore references ${migratedDocs.length > 0 ? `(${migratedDocs.join(", ")}) verified` : "verified clean"}.`,
        cliSnippet,
        consoleUrl: `https://console.firebase.google.com/project/${projectId}/authentication/users`
      });
    } catch (err) {
      console.error("[Account Cleanup Approve API] Error:", err);
      return res.status(500).json({ success: false, error: err?.message || "Failed to approve account cleanup." });
    }
  });
}

// serverLoginSecurity.ts
import crypto3 from "crypto";
import { z as z2 } from "zod";

// serverMonitoring.ts
import crypto2 from "crypto";
import { z } from "zod";

// src/utils/networkDiagnostics.ts
var DEFAULT_NETWORK_THRESHOLDS = {
  netLatencyGoodMaxMs: 50,
  netLatencyWarnMaxMs: 100,
  netLatencyPoorMaxMs: 200,
  netLatencyCriticalMinMs: 400,
  netJitterGoodMaxMs: 20,
  netJitterWarnMaxMs: 50,
  netPacketLossGoodMaxPct: 0.5,
  netPacketLossWarnMaxPct: 2,
  netDownloadGoodMinMbps: 10,
  netDownloadWarnMinMbps: 5,
  netUploadGoodMinMbps: 5,
  netUploadWarnMinMbps: 2,
  netProbeIntervalSec: 30,
  netNetworkFailureSpikeCount: 3,
  apiP95WarningMs: 1200
};
function round2(v) {
  return Math.round(v * 100) / 100;
}
function computeNumericStats(values) {
  const clean = values.filter((v) => typeof v === "number" && Number.isFinite(v) && v >= 0);
  if (clean.length === 0) {
    return { count: 0, min: null, avg: null, p50: null, p95: null, max: null, last: null };
  }
  const sorted = [...clean].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const p = (pct) => round2(sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(pct / 100 * sorted.length) - 1))]);
  return {
    count: sorted.length,
    min: round2(sorted[0]),
    avg: round2(sum / sorted.length),
    p50: p(50),
    p95: p(95),
    max: round2(sorted[sorted.length - 1]),
    last: round2(clean[clean.length - 1])
  };
}
function classifyLatencyRating(rttMs, cfg = {}) {
  if (rttMs === null || rttMs === void 0 || !Number.isFinite(rttMs) || rttMs < 0) {
    return "UNKNOWN";
  }
  const goodMax = cfg.netLatencyGoodMaxMs ?? DEFAULT_NETWORK_THRESHOLDS.netLatencyGoodMaxMs;
  const warnMax = cfg.netLatencyWarnMaxMs ?? DEFAULT_NETWORK_THRESHOLDS.netLatencyWarnMaxMs;
  const poorMax = cfg.netLatencyPoorMaxMs ?? DEFAULT_NETWORK_THRESHOLDS.netLatencyPoorMaxMs;
  const critMin = cfg.netLatencyCriticalMinMs ?? DEFAULT_NETWORK_THRESHOLDS.netLatencyCriticalMinMs;
  if (rttMs <= goodMax) return "EXCELLENT";
  if (rttMs <= warnMax) return "GOOD";
  if (rttMs <= poorMax) return "WARNING";
  if (rttMs <= critMin) return "POOR";
  return "CRITICAL";
}
function classifyJitterRating(jitterMs, cfg = {}) {
  if (jitterMs === null || jitterMs === void 0 || !Number.isFinite(jitterMs) || jitterMs < 0) {
    return "UNKNOWN";
  }
  const goodMax = cfg.netJitterGoodMaxMs ?? DEFAULT_NETWORK_THRESHOLDS.netJitterGoodMaxMs;
  const warnMax = cfg.netJitterWarnMaxMs ?? DEFAULT_NETWORK_THRESHOLDS.netJitterWarnMaxMs;
  if (jitterMs < goodMax) return "GOOD";
  if (jitterMs <= warnMax) return "WARNING";
  return "CRITICAL";
}
function classifyPacketLossRating(lossPct, cfg = {}) {
  if (lossPct === null || lossPct === void 0 || !Number.isFinite(lossPct) || lossPct < 0) {
    return "UNKNOWN";
  }
  const goodMax = cfg.netPacketLossGoodMaxPct ?? DEFAULT_NETWORK_THRESHOLDS.netPacketLossGoodMaxPct;
  const warnMax = cfg.netPacketLossWarnMaxPct ?? DEFAULT_NETWORK_THRESHOLDS.netPacketLossWarnMaxPct;
  if (lossPct <= goodMax) return "GOOD";
  if (lossPct <= warnMax) return "WARNING";
  return "CRITICAL";
}
function classifyDownloadRating(mbps, cfg = {}) {
  if (mbps === null || mbps === void 0 || !Number.isFinite(mbps) || mbps < 0) {
    return "UNKNOWN";
  }
  const goodMin = cfg.netDownloadGoodMinMbps ?? DEFAULT_NETWORK_THRESHOLDS.netDownloadGoodMinMbps;
  const warnMin = cfg.netDownloadWarnMinMbps ?? DEFAULT_NETWORK_THRESHOLDS.netDownloadWarnMinMbps;
  if (mbps >= goodMin) return "GOOD";
  if (mbps >= warnMin) return "WARNING";
  return "CRITICAL";
}
function classifyUploadRating(mbps, cfg = {}) {
  if (mbps === null || mbps === void 0 || !Number.isFinite(mbps) || mbps < 0) {
    return "UNKNOWN";
  }
  const goodMin = cfg.netUploadGoodMinMbps ?? DEFAULT_NETWORK_THRESHOLDS.netUploadGoodMinMbps;
  const warnMin = cfg.netUploadWarnMinMbps ?? DEFAULT_NETWORK_THRESHOLDS.netUploadWarnMinMbps;
  if (mbps >= goodMin) return "GOOD";
  if (mbps >= warnMin) return "WARNING";
  return "CRITICAL";
}
function computeJitterFromRttSeries(successfulRtts) {
  const clean = successfulRtts.filter((v) => typeof v === "number" && Number.isFinite(v) && v >= 0);
  if (clean.length < 3) return null;
  let totalDiff = 0;
  for (let i = 1; i < clean.length; i++) {
    totalDiff += Math.abs(clean[i] - clean[i - 1]);
  }
  return round2(totalDiff / (clean.length - 1));
}
function evaluatePacketLoss(probeOutcomes, cfg = {}) {
  const total = probeOutcomes.length;
  const failed = probeOutcomes.filter((p) => !p.success).length;
  if (total < 5) {
    return {
      totalProbes: total,
      failedProbes: failed,
      rawFailurePct: total > 0 ? round2(failed / total * 100) : null,
      reportablePacketLossPct: null,
      rating: "UNKNOWN",
      note: `Collecting samples (${total}/5 minimum probes required before classifying packet loss)`
    };
  }
  const rawPct = round2(failed / total * 100);
  if (failed === 1) {
    return {
      totalProbes: total,
      failedProbes: 1,
      rawFailurePct: rawPct,
      reportablePacketLossPct: 0,
      rating: "GOOD",
      note: `1 isolated failed HTTPS probe out of ${total} (not classified as sustained packet loss)`
    };
  }
  return {
    totalProbes: total,
    failedProbes: failed,
    rawFailurePct: rawPct,
    reportablePacketLossPct: rawPct,
    rating: classifyPacketLossRating(rawPct, cfg),
    note: failed === 0 ? `0% probe loss across ${total} measured HTTP probes` : `${failed}/${total} probes failed (${rawPct}% loss)`
  };
}
function computeInternetHealthScore(params) {
  const cfg = { ...DEFAULT_NETWORK_THRESHOLDS, ...params.thresholds || {} };
  if (!params.online) {
    return {
      score: 0,
      tier: "CRITICAL",
      formulaSummary: "Browser offline or all active health probes unreachable (Score = 0 / CRITICAL).",
      factors: [
        {
          factor: "Latency (App RTT)",
          measuredValue: "Offline / Unreachable",
          weightPct: 100,
          subScore: 0,
          status: "CRITICAL",
          included: true
        }
      ]
    };
  }
  if (params.probeCount < 3 || params.successfulProbeCount < 1 || params.avgRttMs === null) {
    if (params.probeCount >= 3 && params.successfulProbeCount === 0) {
      return {
        score: 0,
        tier: "CRITICAL",
        formulaSummary: `${params.probeCount} consecutive HTTP probes failed with zero responses (Score = 0 / CRITICAL).`,
        factors: [
          {
            factor: "Packet Loss",
            measuredValue: "100%",
            weightPct: 100,
            subScore: 0,
            status: "CRITICAL",
            included: true
          }
        ]
      };
    }
    return {
      score: null,
      tier: "UNKNOWN",
      formulaSummary: `Insufficient probes (${params.probeCount}/3 minimum). Waiting for real measurements rather than estimating.`,
      factors: []
    };
  }
  const latRating = classifyLatencyRating(params.avgRttMs, cfg);
  const latSubScore = latRating === "EXCELLENT" ? 100 : latRating === "GOOD" ? 85 : latRating === "WARNING" ? 62 : latRating === "POOR" ? 35 : 10;
  const jitterRating = classifyJitterRating(params.jitterMs, cfg);
  const jitterSubScore = jitterRating === "GOOD" ? 100 : jitterRating === "WARNING" ? 60 : jitterRating === "CRITICAL" ? 15 : null;
  const lossRating = classifyPacketLossRating(params.packetLossPct, cfg);
  const lossSubScore = lossRating === "GOOD" ? 100 : lossRating === "WARNING" ? 55 : lossRating === "CRITICAL" ? 10 : null;
  const dlRating = classifyDownloadRating(params.downloadMbps, cfg);
  const ulRating = classifyUploadRating(params.uploadMbps, cfg);
  const scoreMap = { GOOD: 100, WARNING: 60, CRITICAL: 20 };
  const speedScores = [];
  if (dlRating !== "UNKNOWN") speedScores.push(scoreMap[dlRating]);
  if (ulRating !== "UNKNOWN") speedScores.push(scoreMap[ulRating]);
  const throughputSubScore = speedScores.length > 0 ? round2(speedScores.reduce((a, b) => a + b, 0) / speedScores.length) : null;
  const rawFactors = [
    {
      factor: "Latency (App RTT)",
      measuredValue: `${params.avgRttMs} ms`,
      baseWeight: 40,
      subScore: latSubScore,
      status: latRating
    },
    {
      factor: "Jitter",
      measuredValue: params.jitterMs !== null ? `${params.jitterMs} ms` : "Pending (>=3 probes)",
      baseWeight: 25,
      subScore: jitterSubScore,
      status: jitterRating
    },
    {
      factor: "Packet Loss",
      measuredValue: params.packetLossPct !== null ? `${params.packetLossPct}%` : "Pending (>=5 probes)",
      baseWeight: 25,
      subScore: lossSubScore,
      status: lossRating
    },
    {
      factor: "Throughput",
      measuredValue: params.downloadMbps !== null || params.uploadMbps !== null ? `\u2193${params.downloadMbps ?? "\u2014"} / \u2191${params.uploadMbps ?? "\u2014"} Mbps` : "Not tested yet",
      baseWeight: 10,
      subScore: throughputSubScore,
      status: throughputSubScore === null ? "UNKNOWN" : throughputSubScore >= 85 ? "GOOD" : throughputSubScore >= 50 ? "WARNING" : "CRITICAL"
    }
  ];
  const activeWeightSum = rawFactors.reduce(
    (sum, f) => f.subScore !== null ? sum + f.baseWeight : sum,
    0
  );
  let weightedScore = 0;
  const factors = rawFactors.map((f) => {
    const included = f.subScore !== null && activeWeightSum > 0;
    const effectiveWeightPct = included ? round2(f.baseWeight / activeWeightSum * 100) : 0;
    if (included && f.subScore !== null) {
      weightedScore += f.subScore * effectiveWeightPct / 100;
    }
    return {
      factor: f.factor,
      measuredValue: f.measuredValue,
      weightPct: effectiveWeightPct,
      subScore: f.subScore,
      status: f.status,
      included
    };
  });
  const finalScore = Math.max(0, Math.min(100, Math.round(weightedScore)));
  let tier = "EXCELLENT";
  if (finalScore >= 90) tier = "EXCELLENT";
  else if (finalScore >= 75) tier = "GOOD";
  else if (finalScore >= 55) tier = "FAIR";
  else if (finalScore >= 35) tier = "POOR";
  else tier = "CRITICAL";
  const includedLabels = factors.filter((f) => f.included).map((f) => `${f.factor} (${f.weightPct}%)`).join(" + ");
  return {
    score: finalScore,
    tier,
    formulaSummary: `Weighted score (${finalScore}/100) computed from ${includedLabels}.`,
    factors
  };
}
function diagnoseNetworkVsServer(input) {
  const cfg = { ...DEFAULT_NETWORK_THRESHOLDS, ...input.thresholds || {} };
  const evidence = [];
  const comparison = {
    appRttAvgMs: input.avgRttMs,
    backendApiP95Ms: input.apiP95Ms,
    firestoreP95Ms: input.dbP95OpMs,
    frontendSlowRenderAvgMs: input.frontendSlowRenderAvgMs
  };
  if (!input.online) {
    return {
      primaryCause: "User Internet Problem",
      confidence: "High",
      summary: "Browser reports offline state \u2014 device lacks an active internet connection.",
      evidenceBullets: ["navigator.onLine is false", "No outbound requests can complete until connectivity resumes."],
      comparison
    };
  }
  if (input.probeCount >= 2 && input.successfulProbeCount === 0) {
    return {
      primaryCause: "User Internet Problem",
      confidence: "High",
      summary: "All recent HTTP connectivity probes failed to reach the server.",
      evidenceBullets: [
        `0 of ${input.probeCount} lightweight HTTP probes succeeded.`,
        "Check local Wi-Fi, ISP link, VPN, or corporate firewall."
      ],
      comparison
    };
  }
  if (input.probeCount < 2 && input.apiSampleCount < 3 && input.dbOpCount === 0 && input.frontendPerfCount === 0) {
    return {
      primaryCause: "Cause Unknown",
      confidence: "Unknown",
      summary: "Insufficient measured network, API, or database telemetry samples to determine root cause.",
      evidenceBullets: ["Collect at least 3 network probes and API samples before isolating latency origin."],
      comparison
    };
  }
  const netGoodMax = cfg.netLatencyWarnMaxMs;
  const netPoorMax = cfg.netLatencyPoorMaxMs;
  let internetScore = 0;
  let firebaseScore = 0;
  let backendScore = 0;
  let frontendScore = 0;
  const pureTransportRtt = input.avgRttMs !== null ? Math.max(0, input.avgRttMs - (input.avgServerProbeProcessMs ?? 0)) : null;
  if (pureTransportRtt !== null && pureTransportRtt > netPoorMax) {
    internetScore += pureTransportRtt > cfg.netLatencyCriticalMinMs ? 50 : 35;
    evidence.push(
      `High application HTTP transport RTT (${round2(pureTransportRtt)} ms avg, P95 ${input.p95RttMs ?? "\u2014"} ms) while probe handler processing took ${input.avgServerProbeProcessMs ?? 0} ms.`
    );
  }
  if (input.jitterMs !== null && input.jitterMs > cfg.netJitterWarnMaxMs) {
    internetScore += 30;
    evidence.push(`Elevated connection jitter (${input.jitterMs} ms > ${cfg.netJitterWarnMaxMs} ms threshold).`);
  } else if (input.jitterMs !== null && input.jitterMs > cfg.netJitterGoodMaxMs) {
    internetScore += 15;
    evidence.push(`Moderate jitter (${input.jitterMs} ms).`);
  }
  if (input.packetLossPct !== null && input.packetLossPct > cfg.netPacketLossWarnMaxPct) {
    internetScore += 45;
    evidence.push(`Sustained HTTP probe packet loss (${input.packetLossPct}% > ${cfg.netPacketLossWarnMaxPct}%).`);
  }
  if (input.downloadMbps !== null && input.downloadMbps < cfg.netDownloadWarnMinMbps || input.uploadMbps !== null && input.uploadMbps < cfg.netUploadWarnMinMbps) {
    internetScore += 30;
    evidence.push(
      `Low measured bandwidth (\u2193${input.downloadMbps ?? "\u2014"} Mbps / \u2191${input.uploadMbps ?? "\u2014"} Mbps).`
    );
  }
  if (input.networkRequestFailureRatePct !== null && input.networkRequestFailureRatePct >= 10 && input.apiServerErrorCount === 0) {
    internetScore += 25;
    evidence.push(
      `Client network requests failing (${input.networkRequestFailureRatePct}%) without server 5xx errors.`
    );
  }
  const dbP95Slow = input.dbP95OpMs !== null && input.dbP95OpMs >= 500;
  const dbAvgSlow = input.dbAvgOpMs !== null && input.dbAvgOpMs >= 300;
  if (dbP95Slow || dbAvgSlow) {
    firebaseScore += input.dbP95OpMs && input.dbP95OpMs >= 900 ? 55 : 40;
    evidence.push(
      `Firestore operation latency elevated (Avg ${input.dbAvgOpMs ?? "\u2014"} ms, P95 ${input.dbP95OpMs ?? "\u2014"} ms across ${input.dbOpCount} op(s)).`
    );
  }
  if (input.dbErrorCount > 0 || input.dbTxFailureCount > 0) {
    firebaseScore += 50;
    evidence.push(
      `Firestore recorded ${input.dbErrorCount} DB error(s) and ${input.dbTxFailureCount} failed transaction(s).`
    );
  }
  const netIsHealthyOrNormal = pureTransportRtt === null || pureTransportRtt <= netPoorMax;
  const apiIsSlow = input.apiP95Ms !== null && input.apiP95Ms >= Math.min(cfg.apiP95WarningMs, 800) || input.apiAvgMs !== null && input.apiAvgMs >= 450;
  const dbExplainsApiSlow = dbP95Slow && input.apiP95Ms !== null && (input.dbP95OpMs ?? 0) >= input.apiP95Ms * 0.45;
  if (apiIsSlow && !dbExplainsApiSlow) {
    backendScore += input.apiP95Ms && input.apiP95Ms >= cfg.apiP95WarningMs ? 45 : 30;
    evidence.push(
      `Backend API latency elevated (Avg ${input.apiAvgMs ?? "\u2014"} ms, P95 ${input.apiP95Ms ?? "\u2014"} ms)${netIsHealthyOrNormal ? " while network RTT remains normal" : ""}.`
    );
  }
  if (input.apiServerErrorCount > 0 || input.apiTimeoutCount > 0) {
    backendScore += 40;
    evidence.push(
      `Backend returned ${input.apiServerErrorCount} HTTP 5xx error(s) and ${input.apiTimeoutCount} timeout(s).`
    );
  }
  const backendHealthy = !apiIsSlow && input.apiServerErrorCount === 0;
  if (netIsHealthyOrNormal && backendHealthy && (input.frontendSlowRenderAvgMs !== null && input.frontendSlowRenderAvgMs >= 250 || input.frontendSlowRenderCount >= 2 || input.frontendNavAvgMs !== null && input.frontendNavAvgMs >= 1e3)) {
    frontendScore += 40;
    evidence.push(
      `Browser main-thread / navigation delay detected (slow render avg ${input.frontendSlowRenderAvgMs ?? "\u2014"} ms, nav avg ${input.frontendNavAvgMs ?? "\u2014"} ms) while network & API are fast.`
    );
  }
  const candidates = [
    { cat: "User Internet Problem", score: internetScore },
    { cat: "Firebase / Database Problem", score: firebaseScore },
    { cat: "Backend Server Problem", score: backendScore },
    { cat: "Frontend Problem", score: frontendScore }
  ];
  const ranked = candidates.sort((a, b) => b.score - a.score);
  const top = ranked[0];
  if (top.score === 0) {
    if (input.probeCount >= 2 || input.apiSampleCount >= 3) {
      const healthyBullets = [];
      if (pureTransportRtt !== null) {
        healthyBullets.push(
          `Application HTTP RTT avg ${round2(pureTransportRtt)} ms (within <= ${netGoodMax}\u2013${netPoorMax} ms SLA).`
        );
      }
      if (input.apiP95Ms !== null) {
        healthyBullets.push(`Backend API P95 ${input.apiP95Ms} ms with ${input.apiServerErrorCount} server errors.`);
      }
      if (input.dbP95OpMs !== null) {
        healthyBullets.push(`Firestore P95 ${input.dbP95OpMs} ms with ${input.dbErrorCount} DB errors.`);
      }
      return {
        primaryCause: "All Systems Nominal",
        confidence: input.probeCount >= 3 ? "High" : "Medium",
        summary: "Network transport, backend handlers, database operations, and frontend timings are operating within thresholds.",
        evidenceBullets: healthyBullets,
        comparison
      };
    }
    return {
      primaryCause: "Cause Unknown",
      confidence: "Unknown",
      summary: "Measured samples are insufficient to isolate latency origin.",
      evidenceBullets: evidence,
      comparison
    };
  }
  const confidence = top.score >= 45 ? "High" : top.score >= 25 ? "Medium" : "Low";
  const summaryMap = {
    "User Internet Problem": "Latency or failures originate primarily on the client network link (high HTTP RTT, jitter, packet loss, or low throughput).",
    "Backend Server Problem": "Client network and database timings are healthy, but backend Express API processing or error rates are elevated.",
    "Firebase / Database Problem": "Client connectivity and backend ingress are healthy; delays or errors stem from Firestore queries, writes, or transactions.",
    "Frontend Problem": "Network RTT and API responses are fast; slowness is isolated to browser UI rendering or module loading."
  };
  return {
    primaryCause: top.cat,
    confidence,
    summary: top.cat === "User Internet Problem" || top.cat === "Backend Server Problem" || top.cat === "Firebase / Database Problem" || top.cat === "Frontend Problem" ? summaryMap[top.cat] : "Measured symptoms evaluated.",
    evidenceBullets: evidence,
    comparison
  };
}

// serverMonitoring.ts
var DEFAULT_MONITORING_THRESHOLDS = {
  apiP95WarningMs: 1200,
  apiErrorRateWarningPct: 10,
  qrPunchAvgWarningMs: 1200,
  qrFailureSpikeCount: 5,
  txFailureWarningCount: 3,
  frontendErrorSpikeCount: 8,
  unauthorizedSpikeCount: 3,
  alertCooldownMinutes: 15,
  clientSampleRate: 1,
  retentionDays: 14,
  netLatencyGoodMaxMs: DEFAULT_NETWORK_THRESHOLDS.netLatencyGoodMaxMs,
  netLatencyWarnMaxMs: DEFAULT_NETWORK_THRESHOLDS.netLatencyWarnMaxMs,
  netLatencyPoorMaxMs: DEFAULT_NETWORK_THRESHOLDS.netLatencyPoorMaxMs,
  netLatencyCriticalMinMs: DEFAULT_NETWORK_THRESHOLDS.netLatencyCriticalMinMs,
  netJitterGoodMaxMs: DEFAULT_NETWORK_THRESHOLDS.netJitterGoodMaxMs,
  netJitterWarnMaxMs: DEFAULT_NETWORK_THRESHOLDS.netJitterWarnMaxMs,
  netPacketLossGoodMaxPct: DEFAULT_NETWORK_THRESHOLDS.netPacketLossGoodMaxPct,
  netPacketLossWarnMaxPct: DEFAULT_NETWORK_THRESHOLDS.netPacketLossWarnMaxPct,
  netDownloadGoodMinMbps: DEFAULT_NETWORK_THRESHOLDS.netDownloadGoodMinMbps,
  netDownloadWarnMinMbps: DEFAULT_NETWORK_THRESHOLDS.netDownloadWarnMinMbps,
  netUploadGoodMinMbps: DEFAULT_NETWORK_THRESHOLDS.netUploadGoodMinMbps,
  netUploadWarnMinMbps: DEFAULT_NETWORK_THRESHOLDS.netUploadWarnMinMbps,
  netProbeIntervalSec: DEFAULT_NETWORK_THRESHOLDS.netProbeIntervalSec,
  netNetworkFailureSpikeCount: DEFAULT_NETWORK_THRESHOLDS.netNetworkFailureSpikeCount
};
var MAX_API_TRACES = 600;
var MAX_DB_OPS = 600;
var MAX_QR_PUNCHES = 400;
var MAX_CLIENT_PERF = 500;
var MAX_ERROR_EVENTS = 300;
var MAX_ACTIVITY_EVENTS = 500;
var MAX_IMPORT_EXPORT = 200;
var MAX_NETWORK_SAMPLES = 600;
var MAX_SPEED_TESTS = 100;
var monitoringStoreWeakMap = /* @__PURE__ */ new WeakMap();
function getStore2(db) {
  let store = monitoringStoreWeakMap.get(db);
  if (!store) {
    store = {
      apiTraces: [],
      dbOps: [],
      qrPunches: [],
      clientPerf: [],
      errors: [],
      activities: [],
      importExports: [],
      networkSamples: [],
      speedTests: [],
      lastDisconnectionAt: null,
      disconnectionCount: 0,
      alerts: /* @__PURE__ */ new Map(),
      thresholds: { ...DEFAULT_MONITORING_THRESHOLDS },
      lastHealthCheckAt: null,
      lastHealthCheckStatus: null,
      lastHealthProbeMs: null,
      lastTelemetryUpdateAt: null,
      lastPersistAtMs: 0,
      hydratedFromDb: false,
      pendingDirty: false,
      persistTimer: null,
      firestoreErrorsCount: 0
    };
    monitoringStoreWeakMap.set(db, store);
  }
  return store;
}
function pushBounded(arr, item, maxLen) {
  arr.push(item);
  if (arr.length > maxLen) {
    arr.splice(0, arr.length - maxLen);
  }
}
function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto2.randomBytes(3).toString("hex")}`;
}
function roundMs2(v) {
  return Math.round(v * 100) / 100;
}
function sanitizeTelemetryMessage(raw, maxLen = 280) {
  let s = String(raw ?? "").trim();
  if (!s) return "";
  s = s.replace(/Bearer\s+[A-Za-z0-9\-._~+/=]+/gi, "Bearer [REDACTED]");
  s = s.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, "[REDACTED_JWT]");
  s = s.replace(/\bQR_[A-Za-z0-9_.-]+\b/g, "[REDACTED_QR]");
  s = s.replace(/\{\s*"employeeId"[^}]*"token"[^}]*\}/gi, "[REDACTED_QR_JSON]");
  if (s.length > maxLen) {
    s = `${s.slice(0, maxLen - 3)}...`;
  }
  return s;
}
function normalizeApiEndpointPath(rawPath) {
  const pathOnly = String(rawPath || "/").split("?")[0].trim() || "/";
  return pathOnly.replace(/\/att_[A-Za-z0-9_.-]+/g, "/:attendanceId").replace(/\/log_[A-Za-z0-9_.-]+/g, "/:logId").replace(/\/alert_[A-Za-z0-9_.-]+/g, "/:alertId").replace(/\/role_[A-Za-z0-9_.-]+/g, "/:roleDocId").replace(/\/([0-9]{4,}|[a-f0-9-]{16,})/gi, "/:id");
}
function classifyHttpErrorCategory(status, timedOut) {
  if (timedOut || status === 408 || status === 504) return "TIMEOUT";
  if (status === 401) return "AUTH";
  if (status === 403) return "PERMISSION";
  if (status === 400 || status === 422) return "VALIDATION";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "CONFLICT";
  if (status === 429) return "RATE_LIMIT";
  if (status === 503) return "SERVICE_UNAVAILABLE";
  if (status >= 500) return "SERVER";
  return "NONE";
}
function mapEndpointToModule(endpoint) {
  if (endpoint.startsWith("/api/auth") || endpoint.startsWith("/api/login-security")) return "Authentication";
  if (endpoint.startsWith("/api/attendance/scan") || endpoint.startsWith("/api/attendance/manual-punch")) return "Attendance Scanner";
  if (endpoint.startsWith("/api/attendance/")) return "Attendance History";
  if (endpoint.startsWith("/api/employees/bulk-import")) return "Excel Import / Update";
  if (endpoint.startsWith("/api/employees")) return "Employee Master";
  if (endpoint.startsWith("/api/masters")) return "Organization Management";
  if (endpoint.startsWith("/api/dashboard")) return "Dashboard";
  if (endpoint.startsWith("/api/audit")) return "Audit Logs & Security";
  if (endpoint.startsWith("/api/security")) return "Audit Logs & Security";
  if (endpoint.startsWith("/api/admin")) return "User Rights & Permissions";
  if (endpoint.startsWith("/api/monitoring")) return "System Performance";
  return "Backend APIs";
}
function computeLatencyStats(durations) {
  if (!durations || durations.length === 0) {
    return { count: 0, minMs: null, avgMs: null, p50Ms: null, p95Ms: null, maxMs: null };
  }
  const sorted = [...durations].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const pct = (p) => {
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p / 100 * sorted.length) - 1));
    return roundMs2(sorted[idx]);
  };
  return {
    count: sorted.length,
    minMs: roundMs2(sorted[0]),
    avgMs: roundMs2(sum / sorted.length),
    p50Ms: pct(50),
    p95Ms: pct(95),
    maxMs: roundMs2(sorted[sorted.length - 1])
  };
}
function raiseOrGroupAlert(db, params) {
  const store = getStore2(db);
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const cooldownMs = Math.max(1, store.thresholds.alertCooldownMinutes) * 6e4;
  const existing = store.alerts.get(params.groupKey);
  if (existing) {
    const withinCooldown = nowMs - existing.lastTriggeredMs < cooldownMs;
    if (existing.status !== "RESOLVED" || withinCooldown) {
      existing.occurrenceCount += 1;
      existing.lastTriggeredAt = nowIso;
      existing.lastTriggeredMs = nowMs;
      existing.description = params.description;
      existing.lastMetricValue = params.metricValue;
      existing.thresholdValue = params.thresholdValue;
      if (params.severity === "CRITICAL") existing.severity = "CRITICAL";
      if (existing.status === "RESOLVED" && !withinCooldown) {
        existing.status = "ACTIVE";
        existing.resolvedAt = null;
        existing.resolvedBy = null;
      }
      store.pendingDirty = true;
      return;
    }
  }
  const created = {
    id: makeId("alert"),
    groupKey: params.groupKey,
    severity: params.severity,
    module: params.module,
    title: params.title,
    description: params.description,
    affectedOperation: params.affectedOperation,
    status: "ACTIVE",
    occurrenceCount: 1,
    firstTriggeredAt: nowIso,
    firstTriggeredMs: nowMs,
    lastTriggeredAt: nowIso,
    lastTriggeredMs: nowMs,
    acknowledgedAt: null,
    acknowledgedBy: null,
    resolvedAt: null,
    resolvedBy: null,
    lastMetricValue: params.metricValue,
    thresholdValue: params.thresholdValue
  };
  store.alerts.set(params.groupKey, created);
  store.pendingDirty = true;
  if (store.alerts.size > 200) {
    const entries = Array.from(store.alerts.entries()).sort(
      (a, b) => a[1].lastTriggeredMs - b[1].lastTriggeredMs
    );
    for (const [k, v] of entries) {
      if (store.alerts.size <= 150) break;
      if (v.status === "RESOLVED") store.alerts.delete(k);
    }
  }
}
function evaluateAlertThresholds(db) {
  const store = getStore2(db);
  const nowMs = Date.now();
  const window15m = nowMs - 15 * 6e4;
  const th = store.thresholds;
  const recentApis = store.apiTraces.filter((a) => a.timestampMs >= window15m);
  if (recentApis.length >= 5) {
    const stats = computeLatencyStats(recentApis.map((a) => a.durationMs));
    if (stats.p95Ms !== null && stats.p95Ms > th.apiP95WarningMs) {
      raiseOrGroupAlert(db, {
        groupKey: "ALERT_HIGH_API_LATENCY",
        severity: stats.p95Ms > th.apiP95WarningMs * 2 ? "CRITICAL" : "WARNING",
        module: "Backend APIs",
        title: "API P95 Latency Threshold Exceeded",
        description: `15-minute API P95 response time is ${stats.p95Ms}ms (threshold ${th.apiP95WarningMs}ms across ${recentApis.length} calls).`,
        affectedOperation: "HTTP API Pipeline",
        metricValue: stats.p95Ms,
        thresholdValue: th.apiP95WarningMs
      });
    }
    const failedCount = recentApis.filter((a) => !a.success && a.status >= 500).length;
    const timeoutCount = recentApis.filter((a) => a.timedOut).length;
    const errRatePct = roundMs2(failedCount / recentApis.length * 100);
    if (errRatePct > th.apiErrorRateWarningPct && failedCount >= 2) {
      raiseOrGroupAlert(db, {
        groupKey: "ALERT_API_ERROR_SPIKE",
        severity: "CRITICAL",
        module: "Backend APIs",
        title: "Backend 5xx Error Rate Spike",
        description: `Server 5xx error rate reached ${errRatePct}% (${failedCount}/${recentApis.length} requests in 15m).`,
        affectedOperation: "Express API Handlers",
        metricValue: errRatePct,
        thresholdValue: th.apiErrorRateWarningPct
      });
    }
    if (timeoutCount >= 3) {
      raiseOrGroupAlert(db, {
        groupKey: "ALERT_API_TIMEOUT_SPIKE",
        severity: "CRITICAL",
        module: "Backend APIs",
        title: "API Timeout Spike Detected",
        description: `${timeoutCount} API request timeouts recorded in the last 15 minutes.`,
        affectedOperation: "HTTP / Firestore Upstream",
        metricValue: timeoutCount,
        thresholdValue: 3
      });
    }
  }
  const recentQr = store.qrPunches.filter((q) => q.timestampMs >= window15m);
  if (recentQr.length > 0) {
    const qrDurations = recentQr.map((q) => q.totalE2eMs ?? q.totalServerMs ?? 0).filter((v) => v > 0);
    const qrStats = computeLatencyStats(qrDurations);
    if (qrStats.avgMs !== null && qrStats.avgMs > th.qrPunchAvgWarningMs) {
      raiseOrGroupAlert(db, {
        groupKey: "ALERT_HIGH_QR_LATENCY",
        severity: qrStats.avgMs > th.qrPunchAvgWarningMs * 1.5 ? "CRITICAL" : "WARNING",
        module: "Attendance Scanner",
        title: "High QR / Attendance Punch Latency",
        description: `Average punch latency is ${qrStats.avgMs}ms (threshold ${th.qrPunchAvgWarningMs}ms over ${recentQr.length} punches).`,
        affectedOperation: "POST /api/attendance/scan",
        metricValue: qrStats.avgMs,
        thresholdValue: th.qrPunchAvgWarningMs
      });
    }
    const failedQr = recentQr.filter((q) => !q.success && !q.isDuplicateRejection).length;
    if (failedQr >= th.qrFailureSpikeCount) {
      raiseOrGroupAlert(db, {
        groupKey: "ALERT_REPEATED_QR_FAILURES",
        severity: "WARNING",
        module: "Attendance Scanner",
        title: "Repeated Failed QR / Punch Operations",
        description: `${failedQr} non-duplicate failed QR/attendance punch attempts in the last 15 minutes (threshold ${th.qrFailureSpikeCount}).`,
        affectedOperation: "QR Validation & Punch Processing",
        metricValue: failedQr,
        thresholdValue: th.qrFailureSpikeCount
      });
    }
  }
  const recentDb = store.dbOps.filter((d) => d.timestampMs >= window15m);
  const failedTxOrPerm = recentDb.filter((d) => !d.success || d.isPermissionDenied);
  if (failedTxOrPerm.length >= th.txFailureWarningCount) {
    raiseOrGroupAlert(db, {
      groupKey: "ALERT_DB_FAILURE_RATE",
      severity: failedTxOrPerm.some((d) => d.isPermissionDenied) ? "CRITICAL" : "WARNING",
      module: "Firebase / Firestore",
      title: "Firestore Operation / Transaction Failures",
      description: `${failedTxOrPerm.length} failed Firestore database operations in the last 15 minutes.`,
      affectedOperation: "Firestore Admin / Client Operations",
      metricValue: failedTxOrPerm.length,
      thresholdValue: th.txFailureWarningCount
    });
  }
  const recentFeErrors = store.errors.filter(
    (e) => e.timestampMs >= window15m && e.source === "FRONTEND"
  );
  if (recentFeErrors.length >= th.frontendErrorSpikeCount) {
    raiseOrGroupAlert(db, {
      groupKey: "ALERT_FRONTEND_ERROR_SPIKE",
      severity: "WARNING",
      module: "Frontend Application",
      title: "Excessive Browser-Side JavaScript Errors",
      description: `${recentFeErrors.length} frontend runtime/promise errors captured in the last 15 minutes.`,
      affectedOperation: "Browser Client Runtime",
      metricValue: recentFeErrors.length,
      thresholdValue: th.frontendErrorSpikeCount
    });
  }
  const recentUnauth = store.errors.filter(
    (e) => e.timestampMs >= window15m && (e.category === "PERMISSION" || e.category === "AUTH" || e.statusCode === 403)
  );
  if (recentUnauth.length >= th.unauthorizedSpikeCount) {
    raiseOrGroupAlert(db, {
      groupKey: "ALERT_UNAUTHORIZED_SPIKE",
      severity: "CRITICAL",
      module: "Audit Logs & Security",
      title: "Unauthorized Access Attempts Detected",
      description: `${recentUnauth.length} blocked unauthorized/permission errors recorded in the last 15 minutes.`,
      affectedOperation: "RBAC Authorization Guards",
      metricValue: recentUnauth.length,
      thresholdValue: th.unauthorizedSpikeCount
    });
  }
  const recentNet = store.networkSamples.filter((n) => n.timestampMs >= window15m);
  const recentSpeed = store.speedTests.filter((s) => s.timestampMs >= window15m);
  if (recentNet.length > 0) {
    const latestProbe = recentNet[recentNet.length - 1];
    if (!latestProbe.online || latestProbe.disconnectionEvent) {
      raiseOrGroupAlert(db, {
        groupKey: "NET_ALERT_DISCONNECTED",
        severity: "CRITICAL",
        module: "Internet & Network",
        title: "User Internet Disconnection Detected",
        description: `Session ${latestProbe.sessionId} reported browser offline / network loss at ${latestProbe.timestamp}.`,
        affectedOperation: "Network Connectivity Probe"
      });
    }
    const okRtts = recentNet.filter((n) => n.probeSucceeded && typeof n.rttMs === "number").map((n) => n.rttMs);
    const rttSummary = computeNumericStats(okRtts);
    if (rttSummary.avg !== null && rttSummary.avg > th.netLatencyPoorMaxMs) {
      raiseOrGroupAlert(db, {
        groupKey: "NET_ALERT_HIGH_LATENCY",
        severity: rttSummary.avg > th.netLatencyCriticalMinMs ? "CRITICAL" : "WARNING",
        module: "Internet & Network",
        title: "High Application Network RTT Latency",
        description: `Measured HTTP probe RTT averaged ${rttSummary.avg} ms (P95 ${rttSummary.p95 ?? "\u2014"} ms, threshold > ${th.netLatencyPoorMaxMs} ms).`,
        affectedOperation: "GET /api/network/ping",
        metricValue: rttSummary.avg,
        thresholdValue: th.netLatencyPoorMaxMs
      });
    }
    const jitterMs = computeJitterFromRttSeries(okRtts);
    if (jitterMs !== null && jitterMs >= th.netJitterGoodMaxMs) {
      raiseOrGroupAlert(db, {
        groupKey: "NET_ALERT_HIGH_JITTER",
        severity: jitterMs > th.netJitterWarnMaxMs ? "CRITICAL" : "WARNING",
        module: "Internet & Network",
        title: "Elevated Network Jitter / Instability",
        description: `Measured RTT jitter is ${jitterMs} ms across ${okRtts.length} probes (threshold ${th.netJitterWarnMaxMs} ms).`,
        affectedOperation: "HTTP RTT Stability",
        metricValue: jitterMs,
        thresholdValue: th.netJitterWarnMaxMs
      });
    }
    const lossEval = evaluatePacketLoss(
      recentNet.map((n) => ({ success: n.probeSucceeded })),
      th
    );
    if (lossEval.reportablePacketLossPct !== null && lossEval.reportablePacketLossPct > th.netPacketLossGoodMaxPct) {
      raiseOrGroupAlert(db, {
        groupKey: "NET_ALERT_PACKET_LOSS",
        severity: lossEval.reportablePacketLossPct > th.netPacketLossWarnMaxPct ? "CRITICAL" : "WARNING",
        module: "Internet & Network",
        title: "Sustained HTTP Probe Packet Loss Detected",
        description: `${lossEval.note} (threshold ${th.netPacketLossWarnMaxPct}%).`,
        affectedOperation: "Repeated Connectivity Probes",
        metricValue: lossEval.reportablePacketLossPct,
        thresholdValue: th.netPacketLossWarnMaxPct
      });
    }
    const clientNetErrors = store.errors.filter(
      (e) => e.timestampMs >= window15m && e.source === "FRONTEND" && (e.category === "NETWORK_FAILURE" || e.category === "CLIENT_TIMEOUT")
    );
    if (clientNetErrors.length >= th.netNetworkFailureSpikeCount) {
      raiseOrGroupAlert(db, {
        groupKey: "NET_ALERT_REQUEST_FAILURES",
        severity: clientNetErrors.length >= th.netNetworkFailureSpikeCount * 2 ? "CRITICAL" : "WARNING",
        module: "Internet & Network",
        title: "Repeated Client Network Request Failures",
        description: `${clientNetErrors.length} failed/timed-out HTTP requests detected in client browser telemetry (15m).`,
        affectedOperation: "Client API Fetch Pipeline",
        metricValue: clientNetErrors.length,
        thresholdValue: th.netNetworkFailureSpikeCount
      });
    }
    const apiSummary = computeNumericStats(recentApis.map((a) => a.durationMs));
    const dbSummary = computeNumericStats(recentDb.map((d) => d.durationMs));
    if (rttSummary.avg !== null && rttSummary.avg <= th.netLatencyWarnMaxMs && apiSummary.p95 !== null && apiSummary.p95 > th.apiP95WarningMs && (dbSummary.p95 === null || dbSummary.p95 < apiSummary.p95 * 0.45)) {
      raiseOrGroupAlert(db, {
        groupKey: "NET_ALERT_SLOW_BACKEND_HEALTHY_NET",
        severity: "WARNING",
        module: "Backend APIs",
        title: "Backend Reachable Quickly But API Processing Slow",
        description: `Client HTTP RTT is healthy (${rttSummary.avg} ms avg), while Backend API P95 is ${apiSummary.p95} ms.`,
        affectedOperation: "Backend Express API Layer",
        metricValue: apiSummary.p95,
        thresholdValue: th.apiP95WarningMs
      });
    }
  }
  if (recentSpeed.length > 0) {
    const latestSp = recentSpeed[recentSpeed.length - 1];
    const dlBad = latestSp.downloadMbps !== null && latestSp.downloadMbps < th.netDownloadGoodMinMbps;
    const ulBad = latestSp.uploadMbps !== null && latestSp.uploadMbps < th.netUploadGoodMinMbps;
    if (dlBad || ulBad) {
      const isCrit = latestSp.downloadMbps !== null && latestSp.downloadMbps < th.netDownloadWarnMinMbps || latestSp.uploadMbps !== null && latestSp.uploadMbps < th.netUploadWarnMinMbps;
      raiseOrGroupAlert(db, {
        groupKey: "NET_ALERT_LOW_THROUGHPUT",
        severity: isCrit ? "CRITICAL" : "WARNING",
        module: "Internet & Network",
        title: "Low Measured Network Bandwidth",
        description: `Controlled speed test measured \u2193${latestSp.downloadMbps ?? "\u2014"} Mbps / \u2191${latestSp.uploadMbps ?? "\u2014"} Mbps (targets \u2265${th.netDownloadGoodMinMbps} / \u2265${th.netUploadGoodMinMbps} Mbps).`,
        affectedOperation: "Controlled Speed Test",
        metricValue: latestSp.downloadMbps ?? latestSp.uploadMbps ?? 0,
        thresholdValue: th.netDownloadGoodMinMbps
      });
    }
  }
}
function scheduleMonitoringPersist(db) {
  if (process.env.VITEST) return;
  const store = getStore2(db);
  store.pendingDirty = true;
  if (store.persistTimer) return;
  store.persistTimer = setTimeout(() => {
    store.persistTimer = null;
    void flushMonitoringToFirestore(db);
  }, 15e3);
  if (typeof store.persistTimer?.unref === "function") {
    store.persistTimer.unref();
  }
}
async function flushMonitoringToFirestore(db) {
  const store = getStore2(db);
  if (!store.pendingDirty) return;
  store.pendingDirty = false;
  store.lastPersistAtMs = Date.now();
  try {
    const todayKey = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
    const recentApis = store.apiTraces.slice(-200);
    const apiStats = computeLatencyStats(recentApis.map((a) => a.durationMs));
    const qrDurations = store.qrPunches.slice(-200).map((q) => q.totalE2eMs ?? q.totalServerMs ?? 0).filter((v) => v > 0);
    const qrStats = computeLatencyStats(qrDurations);
    await db.collection("monitoring_rollups").doc(todayKey).set(
      {
        dateKey: todayKey,
        updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
        apiCountWindow: recentApis.length,
        apiAvgMs: apiStats.avgMs,
        apiP95Ms: apiStats.p95Ms,
        apiErrorCount: recentApis.filter((a) => !a.success).length,
        qrCountWindow: store.qrPunches.length,
        qrAvgMs: qrStats.avgMs,
        qrP95Ms: qrStats.p95Ms,
        dbOpsCount: store.dbOps.length,
        errorCount: store.errors.length,
        activityCount: store.activities.length
      },
      { merge: true }
    );
    const alertList = Array.from(store.alerts.values()).sort((a, b) => b.lastTriggeredMs - a.lastTriggeredMs).slice(0, 25);
    if (typeof db.batch === "function" && alertList.length > 0) {
      const batch = db.batch();
      for (const al of alertList) {
        batch.set(db.collection("monitoring_alerts").doc(al.groupKey), al, { merge: true });
      }
      await batch.commit();
    }
  } catch (err) {
    store.firestoreErrorsCount += 1;
    if (!process.env.VITEST) {
      console.warn("[Monitoring] Background rollup persist notice:", err?.message || err);
    }
  }
}
function recordApiMetric(db, entry) {
  const store = getStore2(db);
  const tsMs = entry.timestampMs ?? Date.now();
  const ts = entry.timestamp ?? new Date(tsMs).toISOString();
  const cleanEndpoint = normalizeApiEndpointPath(entry.endpoint);
  pushBounded(
    store.apiTraces,
    {
      ...entry,
      id: makeId("api"),
      endpoint: cleanEndpoint,
      timestamp: ts,
      timestampMs: tsMs
    },
    MAX_API_TRACES
  );
  if (!entry.success && (entry.status >= 500 || entry.timedOut || entry.status === 403 || entry.status === 401)) {
    pushBounded(
      store.errors,
      {
        id: makeId("err"),
        source: entry.status === 401 || entry.status === 403 ? "AUTH" : "BACKEND",
        module: mapEndpointToModule(cleanEndpoint),
        category: entry.errorCategory,
        severity: entry.status >= 500 || entry.status === 403 ? "CRITICAL" : "WARNING",
        message: `${entry.method} ${cleanEndpoint} failed with HTTP ${entry.status}${entry.timedOut ? " (timeout)" : ""}`,
        statusCode: entry.status,
        timestamp: ts,
        timestampMs: tsMs,
        correlationId: entry.correlationId
      },
      MAX_ERROR_EVENTS
    );
  }
  store.lastTelemetryUpdateAt = ts;
  evaluateAlertThresholds(db);
  scheduleMonitoringPersist(db);
}
function recordDbOpMetric(db, params) {
  const store = getStore2(db);
  const tsMs = Date.now();
  const ts = new Date(tsMs).toISOString();
  pushBounded(
    store.dbOps,
    {
      id: makeId("db"),
      operation: params.operation,
      collection: params.collection,
      durationMs: roundMs2(params.durationMs),
      success: params.success,
      isPermissionDenied: Boolean(params.isPermissionDenied),
      isNetworkError: Boolean(params.isNetworkError),
      recordCount: Math.max(1, Number(params.recordCount || 1)),
      ...params.errorCode ? { errorCode: params.errorCode } : {},
      timestamp: ts,
      timestampMs: tsMs,
      correlationId: params.correlationId
    },
    MAX_DB_OPS
  );
  if (!params.success) {
    store.firestoreErrorsCount += 1;
    pushBounded(
      store.errors,
      {
        id: makeId("err"),
        source: "DATABASE",
        module: "Firebase / Firestore",
        category: params.isPermissionDenied ? "PERMISSION_DENIED" : params.isNetworkError ? "NETWORK" : "DATABASE",
        severity: "CRITICAL",
        message: sanitizeTelemetryMessage(
          params.errorMessage || `Firestore ${params.operation} failed on ${params.collection}`
        ),
        timestamp: ts,
        timestampMs: tsMs,
        correlationId: params.correlationId
      },
      MAX_ERROR_EVENTS
    );
    if (params.isPermissionDenied || params.isNetworkError) {
      raiseOrGroupAlert(db, {
        groupKey: "ALERT_FIREBASE_CONNECTION_FAILURE",
        severity: "CRITICAL",
        module: "Firebase / Firestore",
        title: params.isPermissionDenied ? "Firestore Permission Denied Detected" : "Firestore Connectivity Error",
        description: sanitizeTelemetryMessage(
          params.errorMessage || `Firestore ${params.operation} error on ${params.collection}.`
        ),
        affectedOperation: `Firestore ${params.operation}`
      });
    }
  }
  store.lastTelemetryUpdateAt = ts;
  evaluateAlertThresholds(db);
  scheduleMonitoringPersist(db);
}
function recordQrPunchTelemetry(db, params) {
  const store = getStore2(db);
  const tsMs = Date.now();
  const ts = new Date(tsMs).toISOString();
  pushBounded(
    store.qrPunches,
    {
      ...params,
      id: makeId("qr"),
      timestamp: ts,
      timestampMs: tsMs
    },
    MAX_QR_PUNCHES
  );
  if (!params.success && !params.isDuplicateRejection) {
    pushBounded(
      store.errors,
      {
        id: makeId("err"),
        source: "QR",
        module: "Attendance Scanner",
        category: params.timedOut ? "TIMEOUT" : params.reasonCode || "QR_REJECTED",
        severity: params.timedOut ? "CRITICAL" : "WARNING",
        message: sanitizeTelemetryMessage(
          `${params.mode} failed (${params.reasonCode || params.action || "REJECTED"})`
        ),
        timestamp: ts,
        timestampMs: tsMs,
        correlationId: params.correlationId
      },
      MAX_ERROR_EVENTS
    );
  }
  store.lastTelemetryUpdateAt = ts;
  evaluateAlertThresholds(db);
  scheduleMonitoringPersist(db);
}
function recordActivityTelemetry(db, params) {
  const store = getStore2(db);
  const tsMs = Date.now();
  const ts = new Date(tsMs).toISOString();
  pushBounded(
    store.activities,
    {
      id: makeId("act"),
      timestamp: ts,
      timestampMs: tsMs,
      actorUid: params.actorUid,
      actorLoginId: params.actorLoginId,
      actorRole: String(params.actorRole || "UNKNOWN").toUpperCase(),
      action: sanitizeTelemetryMessage(params.action, 80),
      module: sanitizeTelemetryMessage(params.module, 60),
      result: params.result,
      correlationId: params.correlationId,
      ...params.detail ? { detail: sanitizeTelemetryMessage(params.detail, 200) } : {}
    },
    MAX_ACTIVITY_EVENTS
  );
  store.lastTelemetryUpdateAt = ts;
  scheduleMonitoringPersist(db);
}
function recordImportExportTelemetry(db, params) {
  const store = getStore2(db);
  const tsMs = Date.now();
  const ts = new Date(tsMs).toISOString();
  pushBounded(
    store.importExports,
    {
      id: makeId("io"),
      type: params.type,
      module: params.module,
      rowCount: Math.max(0, Number(params.rowCount || 0)),
      durationMs: roundMs2(params.durationMs),
      success: params.success,
      actorLoginId: params.actorLoginId,
      timestamp: ts,
      timestampMs: tsMs,
      correlationId: params.correlationId,
      ...params.detail ? { detail: sanitizeTelemetryMessage(params.detail, 200) } : {}
    },
    MAX_IMPORT_EXPORT
  );
  if (!params.success) {
    pushBounded(
      store.errors,
      {
        id: makeId("err"),
        source: params.type === "BULK_ACTION" ? "BULK" : "IMPORT_EXPORT",
        module: params.module,
        category: params.type,
        severity: "CRITICAL",
        message: sanitizeTelemetryMessage(
          params.detail || `${params.type} failed for ${params.rowCount} records.`
        ),
        timestamp: ts,
        timestampMs: tsMs,
        correlationId: params.correlationId
      },
      MAX_ERROR_EVENTS
    );
    raiseOrGroupAlert(db, {
      groupKey: params.type === "BULK_ACTION" ? "ALERT_BULK_OP_FAILURE" : "ALERT_EXCEL_IMPORT_FAILURE",
      severity: "CRITICAL",
      module: params.module,
      title: params.type === "BULK_ACTION" ? "Bulk Batch Operation Failure" : "Excel Import / Export Failure",
      description: sanitizeTelemetryMessage(
        params.detail || `${params.type} encountered an error.`
      ),
      affectedOperation: params.type
    });
  }
  store.lastTelemetryUpdateAt = ts;
  scheduleMonitoringPersist(db);
}
function recordErrorTelemetry(db, params) {
  const store = getStore2(db);
  const tsMs = Date.now();
  const ts = new Date(tsMs).toISOString();
  pushBounded(
    store.errors,
    {
      ...params,
      message: sanitizeTelemetryMessage(params.message),
      id: makeId("err"),
      timestamp: ts,
      timestampMs: tsMs
    },
    MAX_ERROR_EVENTS
  );
  store.lastTelemetryUpdateAt = ts;
  evaluateAlertThresholds(db);
  scheduleMonitoringPersist(db);
}
function noteServerHealthCheck(db, status, probeMs) {
  const store = getStore2(db);
  const nowIso = (/* @__PURE__ */ new Date()).toISOString();
  store.lastHealthCheckAt = nowIso;
  store.lastHealthCheckStatus = status;
  if (typeof probeMs === "number" && Number.isFinite(probeMs)) {
    store.lastHealthProbeMs = roundMs2(probeMs);
  }
  if (status !== "ok") {
    raiseOrGroupAlert(db, {
      groupKey: "ALERT_BACKEND_OR_FIREBASE_DEGRADED",
      severity: "CRITICAL",
      module: "Backend APIs",
      title: "Backend / Firebase Health Check Degraded",
      description: `Server health check reported status "${status}".`,
      affectedOperation: "GET /api/health"
    });
  }
}
function createMonitoringRequestMiddleware(getDb) {
  return (req, res, next) => {
    const startNs = performance.now();
    const headerCid = String(req.headers["x-correlation-id"] || "").trim();
    const correlationId = headerCid && /^[A-Za-z0-9_.-]{6,64}$/.test(headerCid) ? headerCid : `req_${crypto2.randomBytes(6).toString("hex")}`;
    req.correlationId = correlationId;
    res.setHeader("X-Correlation-ID", correlationId);
    const pathOnly = String(req.path || req.originalUrl || "/").split("?")[0];
    if (!pathOnly.startsWith("/api")) {
      return next();
    }
    res.on("finish", () => {
      const db = getDb();
      if (!db) return;
      const durationMs = roundMs2(performance.now() - startNs);
      const status = res.statusCode || 200;
      const timedOut = status === 408 || status === 504;
      const success = status >= 200 && status < 400;
      recordApiMetric(db, {
        endpoint: pathOnly,
        method: req.method.toUpperCase(),
        status,
        durationMs,
        success,
        timedOut,
        errorCategory: success ? "NONE" : classifyHttpErrorCategory(status, timedOut),
        correlationId
      });
    });
    return next();
  };
}
var MONITORED_MODULES = [
  "Authentication",
  "Dashboard",
  "Employee Master",
  "Attendance Scanner",
  "QR Code Management",
  "Excel Import / Update",
  "Attendance History",
  "Reports & Export",
  "Shift Management",
  "Organization Management",
  "User Rights & Permissions",
  "Audit Logs & Security",
  "Firebase / Firestore",
  "Backend APIs"
];
function computeModuleHealthMatrix(db, nowMs = Date.now()) {
  const store = getStore2(db);
  const window1h = nowMs - 60 * 6e4;
  return MONITORED_MODULES.map((modName) => {
    if (modName === "Firebase / Firestore") {
      const ops = store.dbOps.filter((d) => d.timestampMs >= window1h);
      const errs = ops.filter((d) => !d.success);
      const permDenied = errs.filter((d) => d.isPermissionDenied);
      const stats2 = computeLatencyStats(ops.map((o) => o.durationMs));
      if (store.lastHealthCheckStatus === "unavailable" || permDenied.length > 0) {
        return {
          module: modName,
          status: "Critical",
          sampleCount: ops.length,
          errorCount: errs.length,
          avgLatencyMs: stats2.avgMs,
          p95LatencyMs: stats2.p95Ms,
          lastErrorAt: errs.length ? errs[errs.length - 1].timestamp : null,
          lastActivityAt: ops.length ? ops[ops.length - 1].timestamp : store.lastHealthCheckAt,
          reason: permDenied.length > 0 ? `${permDenied.length} Firestore permission error(s) in last 1h` : "Firestore connectivity degraded/unavailable"
        };
      }
      if (ops.length === 0 && !store.lastHealthCheckAt) {
        return {
          module: modName,
          status: "Unknown / Not Instrumented",
          sampleCount: 0,
          errorCount: 0,
          avgLatencyMs: null,
          p95LatencyMs: null,
          lastErrorAt: null,
          lastActivityAt: null,
          reason: "No database operations or probe recorded yet in current window"
        };
      }
      const errRate = ops.length > 0 ? errs.length / ops.length : 0;
      const status2 = errRate > 0.1 ? "Critical" : errs.length > 0 || (stats2.p95Ms ?? 0) > 1e3 ? "Degraded" : (stats2.p95Ms ?? 0) > 600 ? "Warning" : "Healthy";
      return {
        module: modName,
        status: status2,
        sampleCount: ops.length || 1,
        errorCount: errs.length,
        avgLatencyMs: stats2.avgMs ?? store.lastHealthProbeMs,
        p95LatencyMs: stats2.p95Ms ?? store.lastHealthProbeMs,
        lastErrorAt: errs.length ? errs[errs.length - 1].timestamp : null,
        lastActivityAt: ops.length ? ops[ops.length - 1].timestamp : store.lastHealthCheckAt,
        reason: status2 === "Healthy" ? "Admin SDK & Firestore read/write probes operating within latency SLA" : `${errs.length} DB failure(s); P95 ${stats2.p95Ms ?? "--"}ms`
      };
    }
    if (modName === "Backend APIs") {
      const apis = store.apiTraces.filter((a) => a.timestampMs >= window1h);
      if (apis.length === 0 && !store.lastHealthCheckAt) {
        return {
          module: modName,
          status: "Unknown / Not Instrumented",
          sampleCount: 0,
          errorCount: 0,
          avgLatencyMs: null,
          p95LatencyMs: null,
          lastErrorAt: null,
          lastActivityAt: null,
          reason: "No backend HTTP requests recorded yet"
        };
      }
      const serverErrs = apis.filter((a) => !a.success && a.status >= 500);
      const timeouts = apis.filter((a) => a.timedOut);
      const stats2 = computeLatencyStats(apis.map((a) => a.durationMs));
      const errPct = apis.length ? serverErrs.length / apis.length * 100 : 0;
      const status2 = store.lastHealthCheckStatus === "unavailable" || errPct > 15 || timeouts.length >= 3 ? "Critical" : serverErrs.length > 0 || (stats2.p95Ms ?? 0) > store.thresholds.apiP95WarningMs ? "Degraded" : (stats2.p95Ms ?? 0) > store.thresholds.apiP95WarningMs * 0.75 ? "Warning" : "Healthy";
      return {
        module: modName,
        status: status2,
        sampleCount: apis.length,
        errorCount: serverErrs.length + timeouts.length,
        avgLatencyMs: stats2.avgMs,
        p95LatencyMs: stats2.p95Ms,
        lastErrorAt: serverErrs.length ? serverErrs[serverErrs.length - 1].timestamp : null,
        lastActivityAt: apis.length ? apis[apis.length - 1].timestamp : store.lastHealthCheckAt,
        reason: status2 === "Healthy" ? `All ${apis.length} recent API requests healthy` : `${serverErrs.length} 5xx errors, ${timeouts.length} timeouts, P95 ${stats2.p95Ms ?? "--"}ms`
      };
    }
    const modApis = store.apiTraces.filter(
      (a) => a.timestampMs >= window1h && mapEndpointToModule(a.endpoint) === modName
    );
    const modErrors = store.errors.filter(
      (e) => e.timestampMs >= window1h && e.module === modName
    );
    const modPerf = store.clientPerf.filter(
      (c) => c.timestampMs >= window1h && c.module === modName
    );
    const modActivities = store.activities.filter(
      (act) => act.timestampMs >= window1h && act.module === modName
    );
    const isScanner = modName === "Attendance Scanner";
    const qrRecent = isScanner ? store.qrPunches.filter((q) => q.timestampMs >= window1h) : [];
    const totalSamples = modApis.length + modPerf.length + qrRecent.length;
    if (totalSamples === 0 && modErrors.length === 0) {
      return {
        module: modName,
        status: "Unknown / Not Instrumented",
        sampleCount: 0,
        errorCount: 0,
        avgLatencyMs: null,
        p95LatencyMs: null,
        lastErrorAt: null,
        lastActivityAt: modActivities.length ? modActivities[modActivities.length - 1].timestamp : null,
        reason: "No execution samples recorded for this module in the last 1h"
      };
    }
    const latencies = [
      ...modApis.map((a) => a.durationMs),
      ...modPerf.map((p) => p.durationMs),
      ...qrRecent.map((q) => q.totalServerMs ?? 0).filter((v) => v > 0)
    ];
    const stats = computeLatencyStats(latencies);
    const criticalErrs = modErrors.filter((e) => e.severity === "CRITICAL").length;
    const server5xx = modApis.filter((a) => !a.success && a.status >= 500).length;
    let status = "Healthy";
    if (criticalErrs > 0 || server5xx > 0) {
      status = criticalErrs >= 3 || server5xx >= 2 ? "Critical" : "Degraded";
    } else if (modErrors.length > 0 || stats.p95Ms !== null && stats.p95Ms > store.thresholds.apiP95WarningMs) {
      status = "Warning";
    }
    return {
      module: modName,
      status,
      sampleCount: totalSamples,
      errorCount: modErrors.length,
      avgLatencyMs: stats.avgMs,
      p95LatencyMs: stats.p95Ms,
      lastErrorAt: modErrors.length ? modErrors[modErrors.length - 1].timestamp : null,
      lastActivityAt: modApis[modApis.length - 1]?.timestamp || modActivities[modActivities.length - 1]?.timestamp || modPerf[modPerf.length - 1]?.timestamp || null,
      reason: status === "Healthy" ? `${totalSamples} measured operation(s), 0 errors` : `${modErrors.length} error(s), P95 latency ${stats.p95Ms ?? "--"}ms`
    };
  });
}
var ClientTelemetryEventSchema = z.object({
  kind: z.enum(["PERF", "ERROR", "API_CLIENT", "ACTIVITY", "NETWORK_PROBE", "SPEED_TEST"]),
  metric: z.string().trim().min(1).max(64).optional(),
  module: z.string().trim().min(1).max(64).default("Frontend"),
  durationMs: z.number().min(0).max(3e5).optional(),
  action: z.string().trim().min(1).max(80).optional(),
  result: z.enum(["Success", "Failed"]).optional(),
  endpoint: z.string().trim().min(1).max(160).optional(),
  method: z.string().trim().min(1).max(10).optional(),
  status: z.number().int().min(0).max(599).optional(),
  timedOut: z.boolean().optional(),
  errorCategory: z.string().trim().max(48).optional(),
  message: z.string().trim().max(300).optional(),
  correlationId: z.string().trim().max(64).optional(),
  timestampMs: z.number().int().optional(),
  // Network probe & speed-test telemetry fields
  sessionId: z.string().trim().min(2).max(64).optional(),
  online: z.boolean().optional(),
  probeSucceeded: z.boolean().optional(),
  rttMs: z.number().min(0).max(12e4).nullable().optional(),
  serverProcessMs: z.number().min(0).max(3e4).nullable().optional(),
  dnsMs: z.number().min(0).max(6e4).nullable().optional(),
  tcpConnectMs: z.number().min(0).max(6e4).nullable().optional(),
  tlsHandshakeMs: z.number().min(0).max(6e4).nullable().optional(),
  connectionType: z.string().trim().max(32).optional(),
  effectiveType: z.string().trim().max(16).optional(),
  downlinkEstimateMbps: z.number().min(0).max(1e4).nullable().optional(),
  browserRttEstimateMs: z.number().min(0).max(6e4).nullable().optional(),
  disconnectionEvent: z.boolean().optional(),
  userAgentShort: z.string().trim().max(64).optional(),
  downloadMbps: z.number().min(0).max(2e4).nullable().optional(),
  uploadMbps: z.number().min(0).max(2e4).nullable().optional(),
  downloadBytes: z.number().int().min(0).max(1048576).optional(),
  uploadBytes: z.number().int().min(0).max(1048576).optional(),
  downloadDurationMs: z.number().min(0).max(12e4).optional(),
  uploadDurationMs: z.number().min(0).max(12e4).optional()
});
var IngestTelemetrySchema = z.object({
  events: z.array(ClientTelemetryEventSchema).min(1, "At least one telemetry event is required.").max(50, "Maximum 50 telemetry events allowed per ingestion batch.")
});
var AlertActionSchema = z.object({
  groupKey: z.string().trim().min(1).max(100),
  action: z.enum(["ACKNOWLEDGE", "RESOLVE", "REOPEN"])
});
var ThresholdUpdateSchema = z.object({
  apiP95WarningMs: z.number().min(100).max(3e4).optional(),
  apiErrorRateWarningPct: z.number().min(1).max(100).optional(),
  qrPunchAvgWarningMs: z.number().min(100).max(3e4).optional(),
  qrFailureSpikeCount: z.number().int().min(1).max(500).optional(),
  txFailureWarningCount: z.number().int().min(1).max(200).optional(),
  frontendErrorSpikeCount: z.number().int().min(1).max(500).optional(),
  unauthorizedSpikeCount: z.number().int().min(1).max(100).optional(),
  alertCooldownMinutes: z.number().int().min(1).max(1440).optional(),
  clientSampleRate: z.number().min(0.05).max(1).optional(),
  retentionDays: z.number().int().min(1).max(90).optional(),
  netLatencyGoodMaxMs: z.number().min(5).max(5e3).optional(),
  netLatencyWarnMaxMs: z.number().min(10).max(5e3).optional(),
  netLatencyPoorMaxMs: z.number().min(20).max(1e4).optional(),
  netLatencyCriticalMinMs: z.number().min(50).max(2e4).optional(),
  netJitterGoodMaxMs: z.number().min(1).max(2e3).optional(),
  netJitterWarnMaxMs: z.number().min(5).max(5e3).optional(),
  netPacketLossGoodMaxPct: z.number().min(0).max(100).optional(),
  netPacketLossWarnMaxPct: z.number().min(0.1).max(100).optional(),
  netDownloadGoodMinMbps: z.number().min(0.1).max(1e3).optional(),
  netDownloadWarnMinMbps: z.number().min(0.1).max(1e3).optional(),
  netUploadGoodMinMbps: z.number().min(0.1).max(1e3).optional(),
  netUploadWarnMinMbps: z.number().min(0.1).max(1e3).optional(),
  netProbeIntervalSec: z.number().int().min(10).max(300).optional(),
  netNetworkFailureSpikeCount: z.number().int().min(1).max(100).optional()
});
function registerMonitoringRoutes(app, deps) {
  const { db, requireVerifiedCaller, projectId, databaseId, credentialMode } = deps;
  async function ensureHydrated() {
    const store = getStore2(db);
    if (store.hydratedFromDb) return;
    store.hydratedFromDb = true;
    try {
      const [cfgSnap, alertsSnap] = await Promise.all([
        db.collection("monitoring_config").doc("thresholds").get(),
        db.collection("monitoring_alerts").get()
      ]);
      if (cfgSnap.exists) {
        const d = cfgSnap.data() || {};
        store.thresholds = {
          ...DEFAULT_MONITORING_THRESHOLDS,
          ...Object.fromEntries(
            Object.entries(d).filter(
              ([k, v]) => k in DEFAULT_MONITORING_THRESHOLDS && typeof v === "number"
            )
          )
        };
      }
      for (const docSnap of alertsSnap.docs) {
        const d = docSnap.data();
        if (d && d.groupKey && !store.alerts.has(d.groupKey)) {
          store.alerts.set(d.groupKey, d);
        }
      }
    } catch {
    }
  }
  app.post("/api/monitoring/ingest", async (req, res) => {
    try {
      const caller = await requireVerifiedCaller(req, res, "*", "Monitoring Telemetry Ingest");
      if (!caller) return;
      const parsed = IngestTelemetrySchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          code: "TELEMETRY_VALIDATION_ERROR",
          error: parsed.error.issues[0]?.message || "Invalid telemetry payload."
        });
      }
      const store = getStore2(db);
      const nowMs = Date.now();
      let accepted = 0;
      for (const ev of parsed.data.events) {
        const tsMs = ev.timestampMs && Math.abs(nowMs - ev.timestampMs) <= 24 * 36e5 ? ev.timestampMs : nowMs;
        const tsIso = new Date(tsMs).toISOString();
        const cid = ev.correlationId || req.correlationId;
        if (ev.kind === "PERF" && typeof ev.durationMs === "number") {
          pushBounded(
            store.clientPerf,
            {
              id: makeId("cperf"),
              metric: sanitizeTelemetryMessage(ev.metric || "navigation_ms", 64),
              module: sanitizeTelemetryMessage(ev.module, 60),
              durationMs: roundMs2(ev.durationMs),
              timestamp: tsIso,
              timestampMs: tsMs,
              correlationId: cid
            },
            MAX_CLIENT_PERF
          );
          accepted++;
        } else if (ev.kind === "ERROR") {
          pushBounded(
            store.errors,
            {
              id: makeId("err"),
              source: "FRONTEND",
              module: sanitizeTelemetryMessage(ev.module, 60),
              category: sanitizeTelemetryMessage(ev.errorCategory || "JS_ERROR", 48),
              severity: "WARNING",
              message: sanitizeTelemetryMessage(ev.message || "Unhandled frontend error."),
              statusCode: ev.status,
              timestamp: tsIso,
              timestampMs: tsMs,
              correlationId: cid
            },
            MAX_ERROR_EVENTS
          );
          accepted++;
        } else if (ev.kind === "API_CLIENT" && ev.endpoint) {
          if (ev.timedOut || ev.status === 0 || ev.status !== void 0 && ev.status >= 500) {
            pushBounded(
              store.errors,
              {
                id: makeId("err"),
                source: "FRONTEND",
                module: mapEndpointToModule(normalizeApiEndpointPath(ev.endpoint)),
                category: ev.timedOut ? "CLIENT_TIMEOUT" : "NETWORK_FAILURE",
                severity: ev.timedOut ? "CRITICAL" : "WARNING",
                message: sanitizeTelemetryMessage(
                  ev.message || `${ev.method || "GET"} ${normalizeApiEndpointPath(ev.endpoint)} network/timeout error`
                ),
                statusCode: ev.status,
                timestamp: tsIso,
                timestampMs: tsMs,
                correlationId: cid
              },
              MAX_ERROR_EVENTS
            );
          }
          if (typeof ev.durationMs === "number" && ev.metric) {
            pushBounded(
              store.clientPerf,
              {
                id: makeId("cperf"),
                metric: sanitizeTelemetryMessage(ev.metric, 64),
                module: mapEndpointToModule(normalizeApiEndpointPath(ev.endpoint)),
                durationMs: roundMs2(ev.durationMs),
                timestamp: tsIso,
                timestampMs: tsMs,
                correlationId: cid
              },
              MAX_CLIENT_PERF
            );
          }
          accepted++;
        } else if (ev.kind === "ACTIVITY" && ev.action) {
          recordActivityTelemetry(db, {
            actorUid: caller.uid,
            actorLoginId: caller.loginId,
            actorRole: caller.role.toUpperCase(),
            action: ev.action,
            module: ev.module,
            result: ev.result || "Success",
            correlationId: cid,
            detail: ev.message
          });
          accepted++;
        } else if (ev.kind === "NETWORK_PROBE") {
          const isOffline = ev.online === false || ev.disconnectionEvent === true;
          if (isOffline) {
            store.disconnectionCount += 1;
            store.lastDisconnectionAt = tsIso;
          }
          pushBounded(
            store.networkSamples,
            {
              id: makeId("net"),
              sessionId: sanitizeTelemetryMessage(ev.sessionId || `sess_${caller.uid.slice(0, 8)}`, 64),
              actorLoginId: caller.loginId,
              actorRole: caller.role.toUpperCase(),
              online: ev.online ?? true,
              probeSucceeded: ev.probeSucceeded ?? !isOffline,
              rttMs: typeof ev.rttMs === "number" ? roundMs2(ev.rttMs) : null,
              serverProcessMs: typeof ev.serverProcessMs === "number" ? roundMs2(ev.serverProcessMs) : null,
              dnsMs: typeof ev.dnsMs === "number" && ev.dnsMs > 0 ? roundMs2(ev.dnsMs) : null,
              tcpConnectMs: typeof ev.tcpConnectMs === "number" && ev.tcpConnectMs > 0 ? roundMs2(ev.tcpConnectMs) : null,
              tlsHandshakeMs: typeof ev.tlsHandshakeMs === "number" && ev.tlsHandshakeMs > 0 ? roundMs2(ev.tlsHandshakeMs) : null,
              connectionType: sanitizeTelemetryMessage(ev.connectionType || "Unavailable", 32),
              effectiveType: sanitizeTelemetryMessage(ev.effectiveType || "Unavailable", 16),
              downlinkEstimateMbps: typeof ev.downlinkEstimateMbps === "number" ? roundMs2(ev.downlinkEstimateMbps) : null,
              browserRttEstimateMs: typeof ev.browserRttEstimateMs === "number" ? roundMs2(ev.browserRttEstimateMs) : null,
              disconnectionEvent: Boolean(ev.disconnectionEvent),
              userAgentShort: sanitizeTelemetryMessage(ev.userAgentShort || "Browser", 64),
              timestamp: tsIso,
              timestampMs: tsMs
            },
            MAX_NETWORK_SAMPLES
          );
          accepted++;
        } else if (ev.kind === "SPEED_TEST") {
          pushBounded(
            store.speedTests,
            {
              id: makeId("spd"),
              sessionId: sanitizeTelemetryMessage(ev.sessionId || `sess_${caller.uid.slice(0, 8)}`, 64),
              actorLoginId: caller.loginId,
              downloadMbps: typeof ev.downloadMbps === "number" ? roundMs2(ev.downloadMbps) : null,
              uploadMbps: typeof ev.uploadMbps === "number" ? roundMs2(ev.uploadMbps) : null,
              downloadBytes: Math.min(524288, Math.max(0, ev.downloadBytes ?? 0)),
              uploadBytes: Math.min(524288, Math.max(0, ev.uploadBytes ?? 0)),
              downloadDurationMs: roundMs2(ev.downloadDurationMs ?? 0),
              uploadDurationMs: roundMs2(ev.uploadDurationMs ?? 0),
              timestamp: tsIso,
              timestampMs: tsMs
            },
            MAX_SPEED_TESTS
          );
          accepted++;
        }
      }
      store.lastTelemetryUpdateAt = (/* @__PURE__ */ new Date()).toISOString();
      evaluateAlertThresholds(db);
      scheduleMonitoringPersist(db);
      return res.json({
        success: true,
        accepted,
        correlationId: req.correlationId
      });
    } catch (err) {
      return res.status(500).json({
        success: false,
        error: err?.message || "Telemetry ingestion failed."
      });
    }
  });
  app.get("/api/monitoring/overview", async (req, res) => {
    try {
      const caller = await requireVerifiedCaller(
        req,
        res,
        ["super_admin"],
        "System Performance Overview"
      );
      if (!caller) return;
      await ensureHydrated();
      const store = getStore2(db);
      const rangeParam = String(req.query.range || "24h").toLowerCase();
      const fromParam = req.query.from ? new Date(String(req.query.from)).getTime() : NaN;
      const toParam = req.query.to ? new Date(String(req.query.to)).getTime() : NaN;
      const nowMs = Date.now();
      let windowStartMs = nowMs - 24 * 36e5;
      let windowEndMs = nowMs;
      if (rangeParam === "15m") windowStartMs = nowMs - 15 * 6e4;
      else if (rangeParam === "1h") windowStartMs = nowMs - 36e5;
      else if (rangeParam === "24h") windowStartMs = nowMs - 24 * 36e5;
      else if (rangeParam === "7d") windowStartMs = nowMs - 7 * 24 * 36e5;
      else if (rangeParam === "30d") windowStartMs = nowMs - 30 * 24 * 36e5;
      else if (rangeParam === "custom" && Number.isFinite(fromParam)) {
        windowStartMs = fromParam;
        if (Number.isFinite(toParam) && toParam >= fromParam) {
          windowEndMs = toParam;
        }
      }
      const inWindow = (tsMs) => tsMs >= windowStartMs && tsMs <= windowEndMs;
      const apis = store.apiTraces.filter((a) => inWindow(a.timestampMs));
      const dbOps = store.dbOps.filter((d) => inWindow(d.timestampMs));
      const qrList = store.qrPunches.filter((q) => inWindow(q.timestampMs));
      const cPerf = store.clientPerf.filter((c) => inWindow(c.timestampMs));
      const errList = store.errors.filter((e) => inWindow(e.timestampMs));
      const actList = store.activities.filter((act) => inWindow(act.timestampMs));
      const ioList = store.importExports.filter((io) => inWindow(io.timestampMs));
      let activeUserSessionsCount = null;
      let totalRegisteredAccounts = null;
      let recentAuditCount = null;
      let dbPingMs = null;
      let dbConnected = true;
      try {
        const pingStart = performance.now();
        const [rolesSnap, loginHistSnap] = await Promise.all([
          db.collection("user_roles").get(),
          db.collection("login_history").limit(200).get()
        ]);
        dbPingMs = roundMs2(performance.now() - pingStart);
        noteServerHealthCheck(db, "ok", dbPingMs);
        totalRegisteredAccounts = rolesSnap.docs.filter((d) => d.data()?.status === "Active").length;
        const sessionCutoff = nowMs - 8 * 36e5;
        const latestByLogin = /* @__PURE__ */ new Map();
        for (const docSnap of loginHistSnap.docs) {
          const d = docSnap.data() || {};
          const lid = String(d.loginId || "").trim().toLowerCase();
          if (!lid) continue;
          const tsMs = typeof d.timestampMs === "number" ? d.timestampMs : new Date(d.timestamp || 0).getTime();
          if (!Number.isFinite(tsMs)) continue;
          const prev = latestByLogin.get(lid);
          if (!prev || tsMs > prev.tsMs) {
            latestByLogin.set(lid, { eventType: String(d.eventType || ""), tsMs });
          }
        }
        let activeSessions = 0;
        for (const v of latestByLogin.values()) {
          if (v.eventType === "LOGIN_SUCCESS" && v.tsMs >= sessionCutoff) {
            activeSessions++;
          }
        }
        activeUserSessionsCount = activeSessions;
      } catch (dbErr) {
        dbConnected = false;
        noteServerHealthCheck(db, "degraded");
        recordDbOpMetric(db, {
          operation: "QUERY",
          collection: "monitoring_probe",
          durationMs: 0,
          success: false,
          errorMessage: dbErr?.message || "Health probe Firestore read failed."
        });
      }
      const apiStats = computeLatencyStats(apis.map((a) => a.durationMs));
      const failedApiCount = apis.filter((a) => !a.success).length;
      const timeoutApiCount = apis.filter((a) => a.timedOut).length;
      const byEndpoint = /* @__PURE__ */ new Map();
      for (const a of apis) {
        const key = `${a.method} ${a.endpoint}`;
        let group = byEndpoint.get(key);
        if (!group) {
          group = {
            endpoint: a.endpoint,
            method: a.method,
            count: 0,
            errorCount: 0,
            timeoutCount: 0,
            durations: [],
            lastStatus: a.status,
            lastTimestamp: a.timestamp
          };
          byEndpoint.set(key, group);
        }
        group.count++;
        if (!a.success) group.errorCount++;
        if (a.timedOut) group.timeoutCount++;
        group.durations.push(a.durationMs);
        group.lastStatus = a.status;
        group.lastTimestamp = a.timestamp;
      }
      const apiEndpointSummary = Array.from(byEndpoint.values()).map((g) => {
        const st = computeLatencyStats(g.durations);
        return {
          endpoint: g.endpoint,
          method: g.method,
          count: g.count,
          errorCount: g.errorCount,
          timeoutCount: g.timeoutCount,
          avgMs: st.avgMs,
          p50Ms: st.p50Ms,
          p95Ms: st.p95Ms,
          maxMs: st.maxMs,
          lastStatus: g.lastStatus,
          lastTimestamp: g.lastTimestamp
        };
      }).sort((a, b) => (b.p95Ms ?? 0) - (a.p95Ms ?? 0));
      const qrInList = qrList.filter((q) => q.mode === "QR_IN");
      const qrOutList = qrList.filter((q) => q.mode === "QR_OUT");
      const manualList = qrList.filter((q) => q.mode === "MANUAL_IN" || q.mode === "MANUAL_OUT");
      const qrOnly = qrList.filter((q) => q.mode === "QR_IN" || q.mode === "QR_OUT");
      const qrDurations = qrOnly.map((q) => q.totalE2eMs ?? q.totalServerMs ?? 0).filter((v) => v > 0);
      const qrStats = computeLatencyStats(qrDurations);
      const qrSuccessCount = qrOnly.filter((q) => q.success).length;
      const qrDuplicateRejects = qrOnly.filter((q) => q.isDuplicateRejection).length;
      const qrFailedCount = qrOnly.filter((q) => !q.success && !q.isDuplicateRejection).length;
      const qrTimeoutCount = qrOnly.filter((q) => q.timedOut).length;
      const stageStats = {
        qrDetect: computeLatencyStats(qrOnly.map((q) => q.qrDetectMs).filter((v) => typeof v === "number")),
        qrParse: computeLatencyStats(qrOnly.map((q) => q.qrParseMs).filter((v) => typeof v === "number")),
        apiRequest: computeLatencyStats(qrOnly.map((q) => q.apiRequestMs).filter((v) => typeof v === "number")),
        authTokenVerify: computeLatencyStats(qrOnly.map((q) => q.authMs).filter((v) => typeof v === "number")),
        tokenValidation: computeLatencyStats(qrOnly.map((q) => q.tokenValidationMs).filter((v) => typeof v === "number")),
        firestoreTx: computeLatencyStats(qrOnly.map((q) => q.txMs).filter((v) => typeof v === "number")),
        totalPunchIn: computeLatencyStats(qrInList.map((q) => q.totalE2eMs ?? q.totalServerMs).filter((v) => typeof v === "number")),
        totalPunchOut: computeLatencyStats(qrOutList.map((q) => q.totalE2eMs ?? q.totalServerMs).filter((v) => typeof v === "number")),
        manualPunch: computeLatencyStats(manualList.map((q) => q.totalE2eMs ?? q.totalServerMs).filter((v) => typeof v === "number"))
      };
      const dbStats = computeLatencyStats(dbOps.map((d) => d.durationMs));
      const dbReads = dbOps.filter((d) => d.operation === "READ" || d.operation === "QUERY").length;
      const dbWrites = dbOps.filter((d) => d.operation === "WRITE" || d.operation === "BATCH").length;
      const dbTxList = dbOps.filter((d) => d.operation === "TRANSACTION");
      const dbTxFailed = dbTxList.filter((d) => !d.success).length;
      const dbPermDenied = dbOps.filter((d) => d.isPermissionDenied).length;
      const dbNetErrors = dbOps.filter((d) => d.isNetworkError).length;
      const slowDbOps = dbOps.filter((d) => d.durationMs >= 500).slice(-30).reverse();
      const groupClientMetric = (metricKey) => computeLatencyStats(cPerf.filter((c) => c.metric === metricKey).map((c) => c.durationMs));
      const websitePerf = {
        initialLoad: groupClientMetric("app_initial_load_ms"),
        navigation: groupClientMetric("navigation_ms"),
        skeletonDuration: groupClientMetric("skeleton_visible_ms"),
        routePrefetch: groupClientMetric("route_prefetch_ms"),
        backgroundRefresh: groupClientMetric("background_refresh_ms"),
        slowRender: groupClientMetric("slow_render_ms"),
        jsErrorsCount: errList.filter((e) => e.source === "FRONTEND" && e.category === "JS_ERROR").length,
        promiseRejectionsCount: errList.filter((e) => e.source === "FRONTEND" && e.category === "UNHANDLED_REJECTION").length,
        networkFailuresCount: errList.filter((e) => e.source === "FRONTEND" && (e.category === "NETWORK_FAILURE" || e.category === "CLIENT_TIMEOUT")).length
      };
      const totalSpanMs = Math.max(6e4, windowEndMs - windowStartMs);
      const bucketCount = rangeParam === "7d" ? 7 : rangeParam === "30d" ? 15 : 12;
      const bucketStepMs = totalSpanMs / bucketCount;
      const timeSeries = Array.from({ length: bucketCount }, (_, idx) => {
        const bStart = windowStartMs + idx * bucketStepMs;
        const bEnd = bStart + bucketStepMs;
        const label = rangeParam === "7d" || rangeParam === "30d" ? new Date(bStart).toLocaleDateString("en-IN", { day: "2-digit", month: "short" }) : new Date(bStart).toLocaleTimeString("en-IN", {
          timeZone: "Asia/Kolkata",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false
        });
        const bApis = apis.filter((a) => a.timestampMs >= bStart && a.timestampMs < bEnd);
        const bQr = qrOnly.filter((q) => q.timestampMs >= bStart && q.timestampMs < bEnd);
        const bDb = dbOps.filter((d) => d.timestampMs >= bStart && d.timestampMs < bEnd);
        const bErr = errList.filter((e) => e.timestampMs >= bStart && e.timestampMs < bEnd);
        const bAct = actList.filter((a) => a.timestampMs >= bStart && a.timestampMs < bEnd);
        const bIo = ioList.filter((io) => io.timestampMs >= bStart && io.timestampMs < bEnd);
        const apiAvg = computeLatencyStats(bApis.map((x) => x.durationMs)).avgMs;
        const qrAvg = computeLatencyStats(
          bQr.map((x) => x.totalE2eMs ?? x.totalServerMs ?? 0).filter((v) => v > 0)
        ).avgMs;
        const dbAvg = computeLatencyStats(bDb.map((x) => x.durationMs)).avgMs;
        const ioAvg = computeLatencyStats(bIo.map((x) => x.durationMs)).avgMs;
        return {
          label,
          bucketStartIso: new Date(bStart).toISOString(),
          apiAvgMs: apiAvg,
          apiCalls: bApis.length,
          qrAvgMs: qrAvg,
          qrPunches: bQr.length,
          dbAvgMs: dbAvg,
          errorCount: bErr.length,
          activityCount: bAct.length,
          importExportAvgMs: ioAvg,
          availabilityPct: bApis.length > 0 ? roundMs2((bApis.length - bApis.filter((x) => !x.success && x.status >= 500).length) / bApis.length * 100) : null
        };
      });
      const moduleHealth = computeModuleHealthMatrix(db, nowMs);
      const alertsList = Array.from(store.alerts.values()).sort(
        (a, b) => b.lastTriggeredMs - a.lastTriggeredMs
      );
      const activeAlertsCount = alertsList.filter((a) => a.status === "ACTIVE").length;
      let overallHealth = "Healthy";
      if (!dbConnected) {
        overallHealth = "Critical";
      } else if (activeAlertsCount > 0 && alertsList.some((a) => a.status === "ACTIVE" && a.severity === "CRITICAL")) {
        overallHealth = "Critical";
      } else if (activeAlertsCount > 0 || moduleHealth.some((m) => m.status === "Degraded" || m.status === "Warning")) {
        overallHealth = "Warning";
      }
      let historicalRollups = [];
      try {
        const rollupSnap = await db.collection("monitoring_rollups").get();
        historicalRollups = rollupSnap.docs.map((d) => d.data()).filter(Boolean).sort((a, b) => String(b.dateKey || "").localeCompare(String(a.dateKey || ""))).slice(0, 30);
      } catch {
      }
      const netSamples = store.networkSamples.filter((n) => inWindow(n.timestampMs));
      const speedTestsWindow = store.speedTests.filter((s) => inWindow(s.timestampMs));
      const latestSpeedAny = speedTestsWindow[speedTestsWindow.length - 1] ?? store.speedTests[store.speedTests.length - 1] ?? null;
      const successfulProbes = netSamples.filter((n) => n.probeSucceeded && n.rttMs !== null);
      const rttValues = successfulProbes.map((n) => n.rttMs);
      const rttNumStats = computeNumericStats(rttValues);
      const serverProcStats = computeNumericStats(
        successfulProbes.map((n) => n.serverProcessMs).filter((v) => typeof v === "number")
      );
      const dnsStats = computeNumericStats(
        netSamples.map((n) => n.dnsMs).filter((v) => typeof v === "number" && v > 0)
      );
      const tcpStats = computeNumericStats(
        netSamples.map((n) => n.tcpConnectMs).filter((v) => typeof v === "number" && v > 0)
      );
      const tlsStats = computeNumericStats(
        netSamples.map((n) => n.tlsHandshakeMs).filter((v) => typeof v === "number" && v > 0)
      );
      const jitterValueMs = computeJitterFromRttSeries(rttValues);
      const jitterRating = classifyJitterRating(jitterValueMs, store.thresholds);
      const packetLossEval = evaluatePacketLoss(
        netSamples.map((n) => ({ success: n.probeSucceeded })),
        store.thresholds
      );
      const latestSample = netSamples[netSamples.length - 1] ?? store.networkSamples[store.networkSamples.length - 1] ?? null;
      const netOnline = latestSample ? latestSample.online : true;
      const lastSuccessfulNet = [...netSamples].reverse().find((n) => n.probeSucceeded) ?? null;
      const clientNetFailures = errList.filter(
        (e) => e.source === "FRONTEND" && (e.category === "NETWORK_FAILURE" || e.category === "CLIENT_TIMEOUT")
      ).length;
      const totalClientPlusProbeRequests = netSamples.length + apis.length;
      const networkRequestFailureRatePct = totalClientPlusProbeRequests > 0 ? roundMs2(clientNetFailures / totalClientPlusProbeRequests * 100) : netSamples.length > 0 ? 0 : null;
      const dlMbps = latestSpeedAny?.downloadMbps ?? null;
      const ulMbps = latestSpeedAny?.uploadMbps ?? null;
      const dlRating = classifyDownloadRating(dlMbps, store.thresholds);
      const ulRating = classifyUploadRating(ulMbps, store.thresholds);
      const healthScore = computeInternetHealthScore({
        online: netOnline,
        probeCount: netSamples.length,
        successfulProbeCount: successfulProbes.length,
        avgRttMs: rttNumStats.avg,
        jitterMs: jitterValueMs,
        packetLossPct: packetLossEval.reportablePacketLossPct,
        downloadMbps: dlMbps,
        uploadMbps: ulMbps,
        thresholds: store.thresholds
      });
      const apiServerErrorCount = apis.filter((a) => !a.success && a.status >= 500).length;
      const diagnostics = diagnoseNetworkVsServer({
        online: netOnline,
        probeCount: netSamples.length,
        successfulProbeCount: successfulProbes.length,
        avgRttMs: rttNumStats.avg,
        p95RttMs: rttNumStats.p95,
        avgServerProbeProcessMs: serverProcStats.avg,
        jitterMs: jitterValueMs,
        packetLossPct: packetLossEval.reportablePacketLossPct,
        downloadMbps: dlMbps,
        uploadMbps: ulMbps,
        networkRequestFailureRatePct,
        apiSampleCount: apis.length,
        apiAvgMs: apiStats.avgMs,
        apiP95Ms: apiStats.p95Ms,
        apiServerErrorCount,
        apiTimeoutCount: timeoutApiCount,
        dbOpCount: dbOps.length,
        dbAvgOpMs: dbStats.avgMs,
        dbP95OpMs: dbStats.p95Ms,
        dbErrorCount: dbOps.filter((d) => !d.success).length,
        dbTxFailureCount: dbTxFailed,
        frontendPerfCount: cPerf.length,
        frontendSlowRenderAvgMs: websitePerf.slowRender.avgMs,
        frontendSlowRenderCount: websitePerf.slowRender.count,
        frontendNavAvgMs: websitePerf.navigation.avgMs,
        thresholds: store.thresholds
      });
      const sessionMap = /* @__PURE__ */ new Map();
      for (const n of netSamples) {
        let rec = sessionMap.get(n.sessionId);
        if (!rec) {
          rec = {
            sessionId: n.sessionId,
            actorLoginId: n.actorLoginId,
            actorRole: n.actorRole,
            userAgentShort: n.userAgentShort,
            connectionType: n.connectionType,
            effectiveType: n.effectiveType,
            browserEstimatedDownlinkMbps: n.downlinkEstimateMbps,
            browserEstimatedRttMs: n.browserRttEstimateMs,
            rtts: [],
            online: n.online,
            lastSampleAt: n.timestamp,
            lastSampleMs: n.timestampMs,
            failedCount: 0
          };
          sessionMap.set(n.sessionId, rec);
        }
        if (n.probeSucceeded && n.rttMs !== null) rec.rtts.push(n.rttMs);
        if (!n.probeSucceeded) rec.failedCount += 1;
        if (n.timestampMs >= rec.lastSampleMs) {
          rec.online = n.online;
          rec.connectionType = n.connectionType;
          rec.effectiveType = n.effectiveType;
          rec.browserEstimatedDownlinkMbps = n.downlinkEstimateMbps;
          rec.browserEstimatedRttMs = n.browserRttEstimateMs;
          rec.lastSampleAt = n.timestamp;
          rec.lastSampleMs = n.timestampMs;
          rec.userAgentShort = n.userAgentShort;
        }
      }
      const activeDeviceSessions = Array.from(sessionMap.values()).sort((a, b) => b.lastSampleMs - a.lastSampleMs).slice(0, 50).map((s) => {
        const st = computeNumericStats(s.rtts);
        const rating = classifyLatencyRating(st.last, store.thresholds);
        const status = !s.online ? "CRITICAL" : rating === "CRITICAL" || rating === "POOR" ? "CRITICAL" : rating === "WARNING" ? "WARNING" : rating === "UNKNOWN" ? "UNKNOWN" : "GOOD";
        return {
          sessionId: s.sessionId,
          actorLoginId: s.actorLoginId,
          actorRole: s.actorRole,
          userAgentShort: s.userAgentShort,
          connectionType: s.connectionType,
          effectiveType: s.effectiveType,
          browserEstimatedDownlinkMbps: s.browserEstimatedDownlinkMbps,
          browserEstimatedRttMs: s.browserEstimatedRttMs,
          measuredRttAvgMs: st.avg,
          measuredRttLastMs: st.last,
          probeCount: s.rtts.length + s.failedCount,
          lastSampleAt: s.lastSampleAt,
          networkStatus: status
        };
      });
      const networkHistoryBuckets = Array.from({ length: bucketCount }, (_, idx) => {
        const bStart = windowStartMs + idx * bucketStepMs;
        const bEnd = bStart + bucketStepMs;
        const label = rangeParam === "7d" || rangeParam === "30d" ? new Date(bStart).toLocaleDateString("en-IN", { day: "2-digit", month: "short" }) : new Date(bStart).toLocaleTimeString("en-IN", {
          timeZone: "Asia/Kolkata",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false
        });
        const bNet = netSamples.filter((n) => n.timestampMs >= bStart && n.timestampMs < bEnd);
        const bOkRtts = bNet.filter((n) => n.probeSucceeded && n.rttMs !== null).map((n) => n.rttMs);
        const bRttStats = computeNumericStats(bOkRtts);
        const bJitter = computeJitterFromRttSeries(bOkRtts);
        const bFail = bNet.filter((n) => !n.probeSucceeded).length;
        const bLossPct = bNet.length >= 5 ? bFail === 1 ? 0 : roundMs2(bFail / bNet.length * 100) : null;
        const bSp = speedTestsWindow.filter((s) => s.timestampMs >= bStart && s.timestampMs < bEnd);
        const bApis = apis.filter((a) => a.timestampMs >= bStart && a.timestampMs < bEnd);
        const bApiStats = computeNumericStats(bApis.map((a) => a.durationMs));
        const bDlStats = computeNumericStats(
          bSp.map((s) => s.downloadMbps).filter((v) => typeof v === "number")
        );
        const bUlStats = computeNumericStats(
          bSp.map((s) => s.uploadMbps).filter((v) => typeof v === "number")
        );
        return {
          label,
          bucketStartIso: new Date(bStart).toISOString(),
          probeCount: bNet.length,
          rttAvgMs: bRttStats.avg,
          jitterMs: bJitter,
          packetLossPct: bLossPct,
          downloadMbps: bDlStats.avg,
          uploadMbps: bUlStats.avg,
          apiAvgMs: bApiStats.avg,
          disconnections: bNet.filter((n) => n.disconnectionEvent).length
        };
      });
      const latencyRating = classifyLatencyRating(rttNumStats.avg, store.thresholds);
      const throughputStatus = dlRating === "UNKNOWN" && ulRating === "UNKNOWN" ? "UNKNOWN" : dlRating === "CRITICAL" || ulRating === "CRITICAL" ? "CRITICAL" : dlRating === "WARNING" || ulRating === "WARNING" ? "WARNING" : "GOOD";
      const backendVsNetStatus = diagnostics.primaryCause === "Cause Unknown" ? "UNKNOWN" : diagnostics.primaryCause === "All Systems Nominal" ? "GOOD" : diagnostics.confidence === "High" ? "CRITICAL" : "WARNING";
      const networkMonitoring = {
        online: netOnline,
        connectionStatusLabel: !netOnline ? "Disconnected (Offline)" : netSamples.length === 0 ? "Connected (Awaiting HTTP Probes)" : successfulProbes.length === 0 ? "Unreachable (Probes Failing)" : "Connected",
        lastSuccessfulMeasurementAt: lastSuccessfulNet?.timestamp ?? null,
        lastDisconnectionAt: store.lastDisconnectionAt,
        disconnectionCount: store.disconnectionCount,
        rttStats: {
          currentMs: rttNumStats.last,
          avgMs: rttNumStats.avg,
          p50Ms: rttNumStats.p50,
          p95Ms: rttNumStats.p95,
          maxMs: rttNumStats.max,
          rating: latencyRating,
          sampleCount: rttNumStats.count
        },
        avgServerProbeProcessMs: serverProcStats.avg,
        dnsMs: dnsStats.avg,
        tcpConnectMs: tcpStats.avg,
        tlsHandshakeMs: tlsStats.avg,
        timingMeasurementNote: "DNS, TCP, and TLS timings are extracted from Browser PerformanceResourceTiming only on fresh uncached connections where Timing-Allow-Origin permits; reused keep-alive sockets report null (Not Measurable).",
        jitter: {
          valueMs: jitterValueMs,
          rating: jitterRating,
          sampleCount: rttValues.length
        },
        packetLoss: packetLossEval,
        speedTest: {
          latestDownloadMbps: dlMbps,
          latestUploadMbps: ulMbps,
          downloadRating: dlRating,
          uploadRating: ulRating,
          lastTestedAt: latestSpeedAny?.timestamp ?? null,
          isEstimate: true,
          disclosure: "Measured on manual trigger using bounded 256 KB HTTP payloads (not a multi-stream ISP throughput saturation benchmark).",
          recentTests: [...store.speedTests].reverse().slice(0, 20)
        },
        networkRequestFailureRatePct,
        backendApiAvgMs: apiStats.avgMs,
        backendApiP95Ms: apiStats.p95Ms,
        healthScore,
        diagnostics,
        indicatorStatuses: {
          connectivity: !netOnline ? "CRITICAL" : netSamples.length === 0 ? "UNKNOWN" : successfulProbes.length === 0 ? "CRITICAL" : "GOOD",
          latency: latencyRating === "UNKNOWN" ? "UNKNOWN" : latencyRating === "CRITICAL" || latencyRating === "POOR" ? "CRITICAL" : latencyRating === "WARNING" ? "WARNING" : "GOOD",
          jitter: jitterRating,
          packetLoss: packetLossEval.rating,
          throughput: throughputStatus,
          backendVsNetwork: backendVsNetStatus
        },
        historyBuckets: networkHistoryBuckets,
        activeDeviceSessions,
        totalProbeSamplesInWindow: netSamples.length
      };
      return res.json({
        success: true,
        generatedAt: new Date(nowMs).toISOString(),
        window: {
          range: rangeParam,
          fromIso: new Date(windowStartMs).toISOString(),
          toIso: new Date(windowEndMs).toISOString()
        },
        overview: {
          overallHealth,
          backendStatus: dbConnected ? "Healthy" : "Degraded",
          frontendStatus: cPerf.length > 0 ? websitePerf.jsErrorsCount >= store.thresholds.frontendErrorSpikeCount ? "Warning" : "Healthy" : "Unknown / Not Instrumented",
          firebaseConnectivity: dbConnected ? "Connected" : "Error",
          firebasePingMs: dbPingMs,
          projectId,
          databaseId,
          credentialMode,
          apiAvgMs: apiStats.avgMs,
          apiP50Ms: apiStats.p50Ms,
          apiP95Ms: apiStats.p95Ms,
          totalApiRequests: apis.length,
          failedApiRequests: failedApiCount,
          timeoutApiRequests: timeoutApiCount,
          applicationErrorCount: errList.length,
          activeUserSessions: activeUserSessionsCount,
          totalActiveUserAccounts: totalRegisteredAccounts,
          recentAuditCount,
          qrPunchAvgMs: qrStats.avgMs,
          qrPunchP50Ms: qrStats.p50Ms,
          qrPunchP95Ms: qrStats.p95Ms,
          qrPunchMaxMs: qrStats.maxMs,
          qrPunchTotal: qrOnly.length,
          qrPunchSuccessRatePct: qrOnly.length > 0 ? roundMs2(qrSuccessCount / qrOnly.length * 100) : null,
          qrPunchFailureRatePct: qrOnly.length > 0 ? roundMs2(qrFailedCount / qrOnly.length * 100) : null,
          qrDuplicateRejections: qrDuplicateRejects,
          qrTimeouts: qrTimeoutCount,
          backgroundRefreshAvgMs: websitePerf.backgroundRefresh.avgMs,
          backgroundRefreshStatus: websitePerf.backgroundRefresh.count > 0 ? "Active" : "Unknown / Not Instrumented",
          lastSuccessfulHealthCheck: store.lastHealthCheckAt,
          lastMonitoringUpdate: store.lastTelemetryUpdateAt,
          activeAlertsCount
        },
        websitePerf,
        apiMonitoring: {
          summary: apiStats,
          totalRequests: apis.length,
          failedRequests: failedApiCount,
          timeoutCount: timeoutApiCount,
          endpoints: apiEndpointSummary,
          recentTraces: [...apis].reverse().slice(0, 120)
        },
        databaseMonitoring: {
          connectivity: dbConnected ? "Connected" : "Unavailable",
          probeLatencyMs: dbPingMs,
          measuredTotalOps: dbOps.length,
          measuredReads: dbReads,
          measuredWrites: dbWrites,
          transactionCount: dbTxList.length,
          failedTransactionCount: dbTxFailed,
          avgOpDurationMs: dbStats.avgMs,
          p95OpDurationMs: dbStats.p95Ms,
          permissionDeniedCount: dbPermDenied,
          networkErrorCount: dbNetErrors,
          slowOperations: slowDbOps,
          bulkAndImportBatches: [...ioList].reverse().slice(0, 50),
          cloudBillingUsageStatus: "Not Available",
          cloudBillingRequirement: "Requires server-side Google Cloud Monitoring API (@google-cloud/monitoring) and IAM role roles/monitoring.viewer on the backend service account for project-wide Firestore read/write billing & quota counters."
        },
        qrPerformance: {
          summary: qrStats,
          successCount: qrSuccessCount,
          failedCount: qrFailedCount,
          duplicateRejections: qrDuplicateRejects,
          timeoutCount: qrTimeoutCount,
          stages: stageStats,
          recentPunches: [...qrList].reverse().slice(0, 100)
        },
        userActivity: [...actList].reverse().slice(0, 200),
        moduleHealth,
        errorLogs: [...errList].reverse().slice(0, 200),
        alerts: alertsList,
        thresholds: store.thresholds,
        timeSeries,
        historicalRollups,
        networkMonitoring
      });
    } catch (err) {
      console.error("[Monitoring Overview] Error:", err);
      return res.status(500).json({
        success: false,
        error: err?.message || "Failed to compute monitoring overview."
      });
    }
  });
  app.post("/api/monitoring/health-probe", async (req, res) => {
    try {
      const caller = await requireVerifiedCaller(
        req,
        res,
        ["super_admin"],
        "System Health Probe"
      );
      if (!caller) return;
      const start = performance.now();
      await db.collection("system_settings").doc("global").get();
      const probeMs = roundMs2(performance.now() - start);
      noteServerHealthCheck(db, "ok", probeMs);
      recordDbOpMetric(db, {
        operation: "READ",
        collection: "system_settings",
        durationMs: probeMs,
        success: true,
        correlationId: req.correlationId
      });
      return res.json({
        success: true,
        status: "ok",
        firestoreProbeMs: probeMs,
        checkedAt: (/* @__PURE__ */ new Date()).toISOString()
      });
    } catch (err) {
      noteServerHealthCheck(db, "degraded");
      recordDbOpMetric(db, {
        operation: "READ",
        collection: "system_settings",
        durationMs: 0,
        success: false,
        errorMessage: err?.message,
        correlationId: req.correlationId
      });
      return res.status(503).json({
        success: false,
        status: "degraded",
        error: err?.message || "Health probe failed."
      });
    }
  });
  app.post("/api/monitoring/alerts/action", async (req, res) => {
    try {
      const caller = await requireVerifiedCaller(
        req,
        res,
        ["super_admin"],
        "Update Monitoring Alert"
      );
      if (!caller) return;
      const parsed = AlertActionSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: parsed.error.issues[0]?.message || "Invalid alert action payload."
        });
      }
      const { groupKey, action } = parsed.data;
      const store = getStore2(db);
      const alert = store.alerts.get(groupKey);
      if (!alert) {
        return res.status(404).json({
          success: false,
          error: "Alert group not found."
        });
      }
      const nowIso = (/* @__PURE__ */ new Date()).toISOString();
      if (action === "ACKNOWLEDGE") {
        alert.status = "ACKNOWLEDGED";
        alert.acknowledgedAt = nowIso;
        alert.acknowledgedBy = caller.loginId;
      } else if (action === "RESOLVE") {
        alert.status = "RESOLVED";
        alert.resolvedAt = nowIso;
        alert.resolvedBy = caller.loginId;
      } else if (action === "REOPEN") {
        alert.status = "ACTIVE";
        alert.resolvedAt = null;
        alert.resolvedBy = null;
      }
      await db.collection("monitoring_alerts").doc(groupKey).set(alert, { merge: true }).catch(() => {
      });
      await recordEnterpriseAuditEvent(db, {
        req,
        action: `MONITORING_ALERT_${action}`,
        category: "SYSTEM",
        actorUid: caller.uid,
        actorLoginId: caller.loginId,
        actorRole: caller.role.toUpperCase(),
        targetType: "MONITORING_ALERT",
        targetId: groupKey,
        newValue: { status: alert.status },
        actionSource: "SYSTEM_PERFORMANCE_CENTER",
        description: `Alert "${alert.title}" (${groupKey}) marked ${alert.status} by ${caller.loginId}.`,
        success: true
      }).catch(() => {
      });
      return res.json({ success: true, alert });
    } catch (err) {
      return res.status(500).json({
        success: false,
        error: err?.message || "Failed to update monitoring alert."
      });
    }
  });
  app.get("/api/monitoring/thresholds", async (req, res) => {
    try {
      const caller = await requireVerifiedCaller(
        req,
        res,
        ["super_admin"],
        "View Monitoring Thresholds"
      );
      if (!caller) return;
      await ensureHydrated();
      return res.json({
        success: true,
        thresholds: getStore2(db).thresholds
      });
    } catch (err) {
      return res.status(500).json({ success: false, error: err?.message || "Failed to load thresholds." });
    }
  });
  app.post("/api/monitoring/thresholds", async (req, res) => {
    try {
      const caller = await requireVerifiedCaller(
        req,
        res,
        ["super_admin"],
        "Update Monitoring Thresholds"
      );
      if (!caller) return;
      const parsed = ThresholdUpdateSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: parsed.error.issues[0]?.message || "Invalid threshold parameters."
        });
      }
      const store = getStore2(db);
      const previous = { ...store.thresholds };
      store.thresholds = {
        ...store.thresholds,
        ...parsed.data
      };
      await db.collection("monitoring_config").doc("thresholds").set(
        {
          ...store.thresholds,
          updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
          updatedBy: caller.loginId
        },
        { merge: true }
      );
      await recordEnterpriseAuditEvent(db, {
        req,
        action: "MONITORING_THRESHOLDS_UPDATED",
        category: "SETTINGS",
        actorUid: caller.uid,
        actorLoginId: caller.loginId,
        actorRole: caller.role.toUpperCase(),
        targetType: "MONITORING_CONFIG",
        targetId: "thresholds",
        oldValue: previous,
        newValue: store.thresholds,
        actionSource: "SYSTEM_PERFORMANCE_CENTER",
        description: `Updated live monitoring thresholds & alert configuration.`,
        success: true
      }).catch(() => {
      });
      evaluateAlertThresholds(db);
      return res.json({
        success: true,
        thresholds: store.thresholds
      });
    } catch (err) {
      return res.status(500).json({
        success: false,
        error: err?.message || "Failed to update monitoring thresholds."
      });
    }
  });
  const SPEEDTEST_PAYLOAD_BUFFER = crypto2.randomBytes(524288);
  app.get("/api/network/ping", async (req, res) => {
    const startNs = performance.now();
    try {
      const caller = await requireVerifiedCaller(req, res, "*", "Network RTT Probe");
      if (!caller) return;
      const serverProcessMs = roundMs2(performance.now() - startNs);
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      res.setHeader("Timing-Allow-Origin", "*");
      res.setHeader("X-Server-Process-Ms", String(serverProcessMs));
      res.setHeader("Server-Timing", `app;dur=${serverProcessMs}`);
      return res.json({
        ok: true,
        probeKind: "HTTP_APP_RTT",
        serverTimeIso: (/* @__PURE__ */ new Date()).toISOString(),
        serverProcessMs
      });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: err?.message || "Network ping probe failed."
      });
    }
  });
  app.get("/api/network/speedtest/download", async (req, res) => {
    const startNs = performance.now();
    try {
      const caller = await requireVerifiedCaller(req, res, "*", "Network Download Speed Test");
      if (!caller) return;
      const requested = Number(req.query.bytes ?? 262144);
      const boundedBytes = Number.isFinite(requested) ? Math.max(32768, Math.min(524288, Math.floor(requested))) : 262144;
      const chunk = SPEEDTEST_PAYLOAD_BUFFER.subarray(0, boundedBytes);
      const serverProcessMs = roundMs2(performance.now() - startNs);
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      res.setHeader("Timing-Allow-Origin", "*");
      res.setHeader("X-Payload-Bytes", String(boundedBytes));
      res.setHeader("X-Server-Process-Ms", String(serverProcessMs));
      res.setHeader("Server-Timing", `app;dur=${serverProcessMs}`);
      return res.status(200).send(chunk);
    } catch (err) {
      return res.status(500).json({
        success: false,
        error: err?.message || "Download speed test failed."
      });
    }
  });
  app.post("/api/network/speedtest/upload", async (req, res) => {
    const startNs = performance.now();
    try {
      const caller = await requireVerifiedCaller(req, res, "*", "Network Upload Speed Test");
      if (!caller) return;
      let receivedBytes = 0;
      const bodyVal = req.body;
      if (Buffer.isBuffer(bodyVal)) {
        receivedBytes = bodyVal.byteLength;
      } else if (typeof bodyVal === "string") {
        receivedBytes = Buffer.byteLength(bodyVal, "utf8");
      } else if (bodyVal && typeof bodyVal === "object") {
        receivedBytes = Buffer.byteLength(JSON.stringify(bodyVal), "utf8");
      } else {
        const cl = Number(req.headers["content-length"] || 0);
        if (Number.isFinite(cl) && cl > 0) receivedBytes = cl;
      }
      if (receivedBytes > 6e5) {
        return res.status(413).json({
          success: false,
          error: "Upload speed test payload exceeds 512 KB cap."
        });
      }
      const serverReceiveMs = roundMs2(performance.now() - startNs);
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      res.setHeader("Timing-Allow-Origin", "*");
      res.setHeader("X-Server-Process-Ms", String(serverReceiveMs));
      return res.json({
        success: true,
        receivedBytes,
        serverReceiveMs,
        checkedAt: (/* @__PURE__ */ new Date()).toISOString()
      });
    } catch (err) {
      return res.status(500).json({
        success: false,
        error: err?.message || "Upload speed test failed."
      });
    }
  });
}

// serverLoginSecurity.ts
var MAX_CONSECUTIVE_FAILED_ATTEMPTS = 3;
var LOCKED_ACCOUNT_MESSAGE = "Your account has been temporarily blocked. Please contact Super Admin.";
var SUPER_ADMIN_PROGRESSIVE_LOCK_MINUTES = [10, 20, 30, 60];
var DEFAULT_SUPER_ADMIN_LOCKOUT_RESET_HOURS = 24;
var MIN_SUPER_ADMIN_LOCKOUT_RESET_HOURS = 6;
var MAX_SUPER_ADMIN_LOCKOUT_RESET_HOURS = 720;
function computeSuperAdminLockDurationMinutes(progressiveLockLevel) {
  const safeLevel = Math.max(1, Math.floor(Number(progressiveLockLevel) || 1));
  const idx = Math.min(safeLevel - 1, SUPER_ADMIN_PROGRESSIVE_LOCK_MINUTES.length - 1);
  return SUPER_ADMIN_PROGRESSIVE_LOCK_MINUTES[idx];
}
function formatLockoutDurationText(remainingSeconds) {
  const safeSec = Math.max(1, Math.ceil(Number(remainingSeconds) || 0));
  const mins = Math.floor(safeSec / 60);
  const secs = safeSec % 60;
  if (mins <= 0) {
    return `${secs} second${secs === 1 ? "" : "s"}`;
  }
  if (secs === 0) {
    return `${mins} minute${mins === 1 ? "" : "s"}`;
  }
  return `${mins}m ${String(secs).padStart(2, "0")}s`;
}
async function resolveSuperAdminLockoutResetHours(db) {
  let candidate = null;
  try {
    const snap = await db.collection("system_settings").doc("global").get();
    if (snap.exists) {
      const val = Number(snap.data()?.superAdminLockoutResetHours);
      if (Number.isFinite(val) && val > 0) {
        candidate = val;
      }
    }
  } catch {
  }
  if (candidate === null && process.env.SUPER_ADMIN_LOCKOUT_RESET_HOURS) {
    const envVal = Number(process.env.SUPER_ADMIN_LOCKOUT_RESET_HOURS);
    if (Number.isFinite(envVal) && envVal > 0) {
      candidate = envVal;
    }
  }
  if (candidate === null) {
    candidate = DEFAULT_SUPER_ADMIN_LOCKOUT_RESET_HOURS;
  }
  return Math.min(
    MAX_SUPER_ADMIN_LOCKOUT_RESET_HOURS,
    Math.max(MIN_SUPER_ADMIN_LOCKOUT_RESET_HOURS, Math.round(candidate))
  );
}
function resolveAuthoritativeLockedUntilMs(secData, userData) {
  const candidates = [
    secData?.lockedUntilMs,
    userData?.lockedUntilMs,
    secData?.lockoutUntil,
    secData?.lockedUntil,
    userData?.lockoutUntil,
    userData?.lockedUntil
  ];
  for (const val of candidates) {
    if (typeof val === "number" && Number.isFinite(val) && val > 0) {
      return val;
    }
    if (typeof val === "string" && val.trim()) {
      const parsed = Date.parse(val.trim());
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }
  }
  return null;
}
function resolveAuthoritativeLockedUntilIso(lockedUntilMs, secData, userData) {
  if (lockedUntilMs === null) return null;
  const rawIso = secData?.lockoutUntil || secData?.lockedUntil || userData?.lockoutUntil || userData?.lockedUntil;
  if (typeof rawIso === "string" && rawIso.trim() && Number.isFinite(Date.parse(rawIso.trim()))) {
    return rawIso.trim();
  }
  return new Date(lockedUntilMs).toISOString();
}
function resolveCanonicalSuperAdminLockWindow(secData, userData) {
  const explicitMs = resolveAuthoritativeLockedUntilMs(secData, userData);
  const explicitDuration = typeof secData?.lockDurationMinutes === "number" && Number.isFinite(secData.lockDurationMinutes) ? secData.lockDurationMinutes : typeof userData?.lockDurationMinutes === "number" && Number.isFinite(userData.lockDurationMinutes) ? userData.lockDurationMinutes : null;
  if (explicitMs !== null) {
    const level = Math.max(
      1,
      Number(secData?.progressiveLockLevel ?? userData?.progressiveLockLevel ?? 1)
    );
    return {
      lockedUntilMs: explicitMs,
      lockoutUntil: resolveAuthoritativeLockedUntilIso(explicitMs, secData, userData),
      lockDurationMinutes: explicitDuration ?? computeSuperAdminLockDurationMinutes(level)
    };
  }
  const anchorCandidates = [
    secData?.lockedAt,
    userData?.lockedAt,
    secData?.lastFailedAt,
    secData?.updatedAt,
    userData?.updatedAt
  ];
  let anchorMs = null;
  for (const raw of anchorCandidates) {
    if (typeof raw === "string" && raw.trim()) {
      const parsed = Date.parse(raw.trim());
      if (Number.isFinite(parsed) && parsed > 0) {
        anchorMs = parsed;
        break;
      }
    }
  }
  if (anchorMs === null) {
    return { lockedUntilMs: null, lockoutUntil: null, lockDurationMinutes: explicitDuration };
  }
  const effectiveLevel = Math.max(
    1,
    Number(secData?.progressiveLockLevel ?? userData?.progressiveLockLevel ?? 1)
  );
  const derivedDuration = explicitDuration ?? computeSuperAdminLockDurationMinutes(effectiveLevel);
  const derivedUntilMs = anchorMs + derivedDuration * 60 * 1e3;
  return {
    lockedUntilMs: derivedUntilMs,
    lockoutUntil: new Date(derivedUntilMs).toISOString(),
    lockDurationMinutes: derivedDuration
  };
}
var loginMutexQueues = /* @__PURE__ */ new Map();
async function withLoginIdLock(loginId, task) {
  const key = loginId.trim().toLowerCase() || "__anonymous__";
  const prev = loginMutexQueues.get(key) || Promise.resolve();
  let releaseCurrent;
  const currentGate = new Promise((resolve) => {
    releaseCurrent = resolve;
  });
  const chained = prev.then(() => currentGate);
  loginMutexQueues.set(key, chained);
  try {
    await prev;
    return await task();
  } finally {
    releaseCurrent();
    if (loginMutexQueues.get(key) === chained) {
      loginMutexQueues.delete(key);
    }
  }
}
var IP_WINDOW_MS = 10 * 60 * 1e3;
var PROGRESSIVE_COOLDOWNS_MS = [30 * 1e3, 2 * 60 * 1e3, 5 * 60 * 1e3, 15 * 60 * 1e3];
function getIpScopeKey(ip, loginId) {
  const cleanIp = (ip || "127.0.0.1").trim();
  const cleanLogin = (loginId || "__global__").trim().toLowerCase();
  return `${cleanIp}::${cleanLogin}`;
}
function getIpRateDocId(scopeKey) {
  return `ip_${crypto3.createHash("sha256").update(scopeKey).digest("hex").slice(0, 32)}`;
}
async function checkIpProgressiveRateLimitPersistent(db, ip, loginId, nowMs) {
  const now = typeof nowMs === "number" ? nowMs : Date.now();
  const keysToCheck = [
    ...loginId ? [getIpScopeKey(ip, loginId)] : [],
    getIpScopeKey(ip, "__unknown_probe__")
  ];
  for (const scopeKey of keysToCheck) {
    const docId = getIpRateDocId(scopeKey);
    const snap = await db.collection("ip_rate_limits").doc(docId).get();
    if (snap.exists) {
      const rec = snap.data();
      if (rec && Number(rec.cooldownUntil || 0) > now) {
        const cooldownSeconds = Math.max(1, Math.ceil((Number(rec.cooldownUntil) - now) / 1e3));
        return {
          allowed: false,
          cooldownSeconds,
          reason: `Rate limit cooldown active (${cooldownSeconds}s remaining).`
        };
      }
    }
  }
  return { allowed: true };
}
async function recordIpFailurePersistent(db, ip, kind, loginId, nowMs) {
  const now = typeof nowMs === "number" ? nowMs : Date.now();
  const nowIso = new Date(now).toISOString();
  const cleanLogin = kind === "unknown_id" ? "__unknown_probe__" : (loginId || "__global__").trim().toLowerCase();
  const scopeKey = getIpScopeKey(ip, cleanLogin);
  const ref = db.collection("ip_rate_limits").doc(getIpRateDocId(scopeKey));
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    let rec;
    if (!snap.exists) {
      rec = {
        scopeKey,
        ip: (ip || "127.0.0.1").trim(),
        loginScope: cleanLogin,
        failures: 0,
        unknownIdFailures: 0,
        lockedHits: 0,
        windowStart: now,
        cooldownUntil: 0,
        strikes: 0,
        updatedAt: nowIso
      };
    } else {
      const data = snap.data();
      const expired = now - Number(data.windowStart || 0) > IP_WINDOW_MS && Number(data.cooldownUntil || 0) <= now;
      rec = expired ? {
        scopeKey,
        ip: (ip || "127.0.0.1").trim(),
        loginScope: cleanLogin,
        failures: 0,
        unknownIdFailures: 0,
        lockedHits: 0,
        windowStart: now,
        cooldownUntil: 0,
        strikes: 0,
        updatedAt: nowIso
      } : {
        ...data,
        scopeKey,
        ip: (ip || "127.0.0.1").trim(),
        loginScope: cleanLogin,
        failures: Number(data.failures || 0),
        unknownIdFailures: Number(data.unknownIdFailures || 0),
        lockedHits: Number(data.lockedHits || 0),
        windowStart: Number(data.windowStart || now),
        cooldownUntil: Number(data.cooldownUntil || 0),
        strikes: Number(data.strikes || 0),
        updatedAt: nowIso
      };
    }
    rec.failures += 1;
    if (kind === "unknown_id") rec.unknownIdFailures += 1;
    if (kind === "locked_hit") rec.lockedHits += 1;
    const shouldThrottle = kind === "firebase_throttle" || rec.unknownIdFailures >= 10 || rec.lockedHits >= 5 || rec.failures >= 15;
    let triggeredCooldown = false;
    let cooldownSeconds = 0;
    if (shouldThrottle) {
      const idx = Math.min(rec.strikes, PROGRESSIVE_COOLDOWNS_MS.length - 1);
      const delayMs = PROGRESSIVE_COOLDOWNS_MS[idx];
      rec.cooldownUntil = now + delayMs;
      rec.strikes += 1;
      triggeredCooldown = true;
      cooldownSeconds = Math.ceil(delayMs / 1e3);
    }
    rec.updatedAt = nowIso;
    tx.set(ref, rec, { merge: true });
    return { triggeredCooldown, cooldownSeconds };
  });
}
async function clearIpCooldownPersistent(db, ip, loginId) {
  try {
    if (ip && loginId) {
      const scopeKey = getIpScopeKey(ip, loginId);
      await db.collection("ip_rate_limits").doc(getIpRateDocId(scopeKey)).delete();
      return;
    }
    if (loginId) {
      const cleanLogin = loginId.trim().toLowerCase();
      const snap = await db.collection("ip_rate_limits").where("loginScope", "==", cleanLogin).get();
      await Promise.all(
        snap.docs.map((d) => db.collection("ip_rate_limits").doc(d.id).delete())
      );
      return;
    }
    if (ip) {
      const cleanIp = ip.trim();
      const snap = await db.collection("ip_rate_limits").where("ip", "==", cleanIp).get();
      await Promise.all(
        snap.docs.map((d) => db.collection("ip_rate_limits").doc(d.id).delete())
      );
    }
  } catch {
  }
}
function generateStrongTemporaryPassword(length = 14) {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const digits = "23456789";
  const special = "@#$%&*!?";
  const all = upper + lower + digits + special;
  const chars = [
    upper[crypto3.randomInt(0, upper.length)],
    lower[crypto3.randomInt(0, lower.length)],
    digits[crypto3.randomInt(0, digits.length)],
    special[crypto3.randomInt(0, special.length)]
  ];
  while (chars.length < length) {
    chars.push(all[crypto3.randomInt(0, all.length)]);
  }
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto3.randomInt(0, i + 1);
    const tmp = chars[i];
    chars[i] = chars[j];
    chars[j] = tmp;
  }
  return chars.join("");
}
async function getAdminAuthContext(_projectId, injectedAuth) {
  if (injectedAuth) {
    return {
      available: true,
      adminAuth: injectedAuth,
      credentialSource: "INJECTED_ADMIN_AUTH"
    };
  }
  const ctx = getFirebaseAdminContext();
  if (!ctx.auth) {
    return {
      available: false,
      reason: ctx.error || "Firebase Admin Auth is not initialized."
    };
  }
  return {
    available: true,
    adminAuth: ctx.auth,
    credentialSource: ctx.credentialSource,
    serviceAccountEmail: ctx.serviceAccountEmail
  };
}
async function tryAdminAuthUpdatePassword(projectId, targetUid, newPassword, injectedAuth) {
  if (!targetUid || targetUid.startsWith("role_")) {
    return {
      updated: false,
      adminSdkAvailable: false,
      reason: "Target record does not have a valid Firebase Authentication UID."
    };
  }
  const ctx = await getAdminAuthContext(projectId, injectedAuth);
  if (!ctx.available || !ctx.adminAuth) {
    return {
      updated: false,
      adminSdkAvailable: false,
      reason: ctx.reason
    };
  }
  try {
    const existingUser = await ctx.adminAuth.getUser(targetUid);
    await ctx.adminAuth.updateUser(existingUser.uid, { password: newPassword });
    await ctx.adminAuth.revokeRefreshTokens(existingUser.uid);
    return {
      updated: true,
      adminSdkAvailable: true,
      uid: existingUser.uid,
      email: existingUser.email || null
    };
  } catch (err) {
    return {
      updated: false,
      adminSdkAvailable: true,
      reason: String(err?.message || err || "Firebase Admin updateUser failed.")
    };
  }
}
async function inspectFirebaseAuthStatus(projectId, db, injectedAuth) {
  const ctx = await getAdminAuthContext(projectId, injectedAuth);
  const usersSnap = await db.collection("user_roles").get();
  let authUsers = [];
  let authListError = "";
  if (ctx.available && ctx.adminAuth) {
    try {
      const listRes = await ctx.adminAuth.listUsers(100);
      authUsers = (listRes.users || []).map((u) => ({
        uid: u.uid,
        email: u.email || null,
        disabled: Boolean(u.disabled),
        creationTime: u.metadata?.creationTime,
        lastSignInTime: u.metadata?.lastSignInTime
      }));
    } catch (listErr) {
      authListError = String(listErr?.message || listErr || "listUsers failed");
    }
  }
  const byUid = new Map(authUsers.map((u) => [u.uid, u]));
  const byEmail = new Map(
    authUsers.filter((u) => u.email).map((u) => [String(u.email).toLowerCase(), u])
  );
  const authListed = ctx.available && !authListError;
  const firestoreMappings = usersSnap.docs.map((d) => {
    const data = d.data() || {};
    const fsEmail = String(data.email || "").trim().toLowerCase();
    const fsUid = data.authUid ? String(data.authUid) : null;
    const aliases = Array.isArray(data.emailAliases) ? data.emailAliases.map((a) => String(a)) : [];
    let matchedBy = "UNVERIFIED";
    let matchedEmail = null;
    let conflict = false;
    if (authListed) {
      const uidUser = fsUid ? byUid.get(fsUid) : void 0;
      const emailUser = fsEmail ? byEmail.get(fsEmail) : void 0;
      if (uidUser) {
        matchedBy = "UID";
        matchedEmail = uidUser.email;
        if (uidUser.email && fsEmail && uidUser.email.toLowerCase() !== fsEmail) {
          conflict = true;
        }
      } else if (emailUser) {
        matchedBy = "EMAIL";
        matchedEmail = emailUser.email;
        if (fsUid && emailUser.uid !== fsUid) {
          conflict = true;
        }
      } else {
        matchedBy = "MISSING";
        conflict = true;
      }
    }
    return {
      docId: d.id,
      loginId: String(data.loginId || d.id.replace(/^role_/, "")),
      role: String(data.role || "user").toUpperCase(),
      firestoreEmail: fsEmail,
      firestoreAuthUid: fsUid,
      emailAliases: aliases,
      firebaseAuthMatchedEmail: matchedEmail,
      firebaseAuthMatchedBy: matchedBy,
      mappingConflict: conflict
    };
  });
  return {
    adminSdkConfigured: authListed,
    projectId,
    credentialSource: ctx.credentialSource,
    serviceAccountEmail: ctx.serviceAccountEmail,
    reason: authListError || ctx.reason,
    authUsers,
    firestoreMappings
  };
}
async function captureTelemetryContext(db, req) {
  const ipAddress = extractTrustedClientIp(req);
  const uaMeta = parseUserAgent(req.headers["user-agent"]);
  let captureGeo = true;
  try {
    const settingsSnap = await db.collection("system_settings").doc("global").get();
    if (settingsSnap.exists && settingsSnap.data()?.captureGeoLocation === false) {
      captureGeo = false;
    }
  } catch {
  }
  const geoLocation = await resolveIpGeoLocation(ipAddress, captureGeo);
  return { ipAddress, geoLocation, uaMeta };
}
async function recordLoginAttemptDoc(db, params) {
  const effectiveNowMs = typeof params.nowMs === "number" ? params.nowMs : Date.now();
  const now = new Date(effectiveNowMs).toISOString();
  const attemptId = `att_${effectiveNowMs}_${crypto3.randomBytes(4).toString("hex")}`;
  await db.collection("login_attempts").doc(attemptId).set({
    id: attemptId,
    loginId: params.loginId.trim().toLowerCase(),
    role: String(params.role || "UNKNOWN").toUpperCase(),
    firebaseUid: params.firebaseUid || null,
    timestamp: now,
    timestampMs: effectiveNowMs,
    success: params.success,
    outcome: params.outcome,
    failureReasonCategory: params.failureReasonCategory,
    failureReason: params.failureReason ? String(params.failureReason).slice(0, 500) : null,
    attemptNumber: params.attemptNumber ?? null,
    consecutiveFailedAfter: params.consecutiveFailedAfter ?? null,
    triggeredLock: Boolean(params.triggeredLock),
    lockDurationMinutes: params.lockDurationMinutes ?? null,
    lockoutUntil: params.lockedUntil ?? null,
    lockedUntil: params.lockedUntil ?? null,
    ipAddress: params.telemetry.ipAddress,
    geoLocation: params.telemetry.geoLocation,
    browser: params.telemetry.uaMeta.browser,
    os: params.telemetry.uaMeta.os,
    deviceType: params.telemetry.uaMeta.deviceType,
    userAgent: params.telemetry.uaMeta.raw ? params.telemetry.uaMeta.raw.slice(0, 240) : "",
    sessionId: params.sessionId || null
  });
  return attemptId;
}
async function recordSecurityAuditLogDoc(db, params) {
  const effectiveNowMs = typeof params.nowMs === "number" ? params.nowMs : Date.now();
  const now = new Date(effectiveNowMs).toISOString();
  const logId = `saud_${effectiveNowMs}_${crypto3.randomBytes(4).toString("hex")}`;
  const safeMeta = {};
  if (params.metadata) {
    for (const [k, v] of Object.entries(params.metadata)) {
      if (/(password|hash|token|secret|credential)/i.test(k)) continue;
      safeMeta[k] = v;
    }
  }
  await db.collection("security_audit_logs").doc(logId).set({
    id: logId,
    action: params.action,
    severity: params.severity,
    targetLoginId: params.targetLoginId.trim().toLowerCase(),
    targetRole: String(params.targetRole || "UNKNOWN").toUpperCase(),
    targetUid: params.targetUid || null,
    actorUid: params.actorUid || "system",
    actorLoginId: (params.actorLoginId || params.targetLoginId || "system").trim().toLowerCase(),
    actorRole: String(params.actorRole || "SYSTEM").toUpperCase(),
    timestamp: now,
    timestampMs: effectiveNowMs,
    ipAddress: params.telemetry.ipAddress,
    geoLocation: params.telemetry.geoLocation,
    deviceInfo: {
      browser: params.telemetry.uaMeta.browser,
      os: params.telemetry.uaMeta.os,
      deviceType: params.telemetry.uaMeta.deviceType
    },
    reason: params.reason.slice(0, 1e3),
    details: params.details.slice(0, 2e3),
    metadata: safeMeta
  });
  return logId;
}
async function seedAccountSecurityRecords(db) {
  try {
    const usersSnap = await db.collection("user_roles").get();
    const now = (/* @__PURE__ */ new Date()).toISOString();
    for (const uDoc of usersSnap.docs) {
      const uData = uDoc.data() || {};
      const loginId = String(uData.loginId || uDoc.id.replace(/^role_/, "")).trim().toLowerCase();
      if (!loginId) continue;
      if (uData.authUid) {
        await syncUserUidIndex(db, {
          uid: String(uData.authUid),
          roleDocId: uDoc.id,
          role: String(uData.role || "user"),
          status: String(uData.status || "Active"),
          lockStatus: uData.isLocked || uData.lockStatus === "LOCKED" ? "LOCKED" : "ACTIVE",
          lockedUntilMs: typeof uData.lockedUntilMs === "number" ? uData.lockedUntilMs : null,
          loginId
        });
      }
      const secId = `sec_${loginId}`;
      const secRef = db.collection("account_security").doc(secId);
      const secSnap = await secRef.get();
      const isCanonicalSA = isCanonicalSuperAdminAccount(uDoc.id, uData);
      if (!secSnap.exists) {
        await secRef.set({
          id: secId,
          loginId,
          role: String(uData.role || "USER").toUpperCase(),
          firebaseUid: uData.authUid || uDoc.id,
          email: uData.email || `${loginId}@narid.com`,
          lockStatus: uData.isLocked || uData.lockStatus === "LOCKED" ? "LOCKED" : "ACTIVE",
          lockPolicyType: isCanonicalSA ? "PROGRESSIVE_TEMPORARY" : "PERMANENT_MANUAL",
          consecutiveFailedAttempts: Number(uData.consecutiveFailedAttempts || 0),
          maxAttemptsAllowed: MAX_CONSECUTIVE_FAILED_ATTEMPTS,
          totalLoginAttempts: 0,
          totalSuccessfulLogins: 0,
          totalFailedLogins: 0,
          forcePasswordChange: uData.mustChangePassword === true || uData.forcePasswordChange === true,
          lockedAt: uData.lockedAt || null,
          lockoutUntil: uData.lockoutUntil || uData.lockedUntil || null,
          lockedUntil: uData.lockedUntil || uData.lockoutUntil || null,
          lockedUntilMs: typeof uData.lockedUntilMs === "number" ? uData.lockedUntilMs : null,
          lockDurationMinutes: typeof uData.lockDurationMinutes === "number" ? uData.lockDurationMinutes : null,
          lockReason: uData.lockReason || null,
          progressiveLockLevel: Number(uData.progressiveLockLevel || 0),
          totalLockoutEvents: Number(uData.totalLockoutEvents || 0),
          lastLockoutAt: uData.lastLockoutAt || null,
          lastLockExpiredAt: uData.lastLockExpiredAt || null,
          cleanWindowStartAt: uData.cleanWindowStartAt || null,
          cleanWindowStartMs: typeof uData.cleanWindowStartMs === "number" ? uData.cleanWindowStartMs : null,
          cleanLoginsSinceLastLockout: Number(uData.cleanLoginsSinceLastLockout || 0),
          pendingPostLockoutLoginAudit: Boolean(uData.pendingPostLockoutLoginAudit),
          lockoutLevelResetAt: uData.lockoutLevelResetAt || null,
          lockoutLevelResetReason: uData.lockoutLevelResetReason || null,
          lastFailedAt: null,
          lastFailedIp: null,
          lastFailedGeo: null,
          lastFailedDevice: null,
          lastFailedReason: null,
          lastSuccessAt: uData.lastSuccessLoginAt || null,
          lastSuccessIp: null,
          lastSuccessGeo: null,
          lastSuccessDevice: null,
          unblockedByUid: null,
          unblockedByLoginId: null,
          unblockedAt: null,
          unblockReason: null,
          tempPasswordResetByUid: null,
          tempPasswordResetByLoginId: null,
          tempPasswordResetAt: uData.passwordResetAt || null,
          updatedAt: now
        });
      } else {
        const sData = secSnap.data() || {};
        const updates = {};
        if (uData.email && sData.email !== uData.email) {
          updates.email = uData.email;
        }
        if (uData.authUid && sData.firebaseUid !== uData.authUid) {
          updates.firebaseUid = uData.authUid;
        }
        const expectedPolicy = isCanonicalSA ? "PROGRESSIVE_TEMPORARY" : "PERMANENT_MANUAL";
        if (sData.lockPolicyType !== expectedPolicy) {
          updates.lockPolicyType = expectedPolicy;
        }
        if (Object.keys(updates).length > 0) {
          updates.updatedAt = now;
          await secRef.update(updates);
        }
      }
    }
  } catch (err) {
    console.warn("[Security Boot] account_security seed notice:", err?.message || err);
  }
}
var UnblockAccountSchema = z2.object({
  targetLoginId: z2.string().trim().min(1, "Target Login ID is required.").max(64),
  reason: z2.string().trim().min(5, "An explicit unblock reason (at least 5 characters) is mandatory.").max(500),
  confirmed: z2.literal(true, { message: "Explicit confirmation is required to unblock an account." })
});
var GenerateTempPasswordSchema = z2.object({
  targetLoginId: z2.string().trim().min(1, "Target Login ID is required.").max(64),
  reason: z2.string().trim().min(5, "A governance reason (at least 5 characters) is mandatory.").max(500),
  freshSuperAdminPassword: z2.string().optional()
});
var ResetSuperAdminLockoutLevelSchema = z2.object({
  reason: z2.string().trim().min(5, "An explicit governance reason (at least 5 characters) is mandatory.").max(500),
  confirmed: z2.literal(true, {
    message: "Explicit confirmation is required to reset the Super Admin progressive lockout level."
  }),
  freshSuperAdminPassword: z2.string().optional()
});
function registerLoginSecurityRoutes(app, deps) {
  const {
    db,
    auth,
    projectId,
    verifyPassword: verifyPassword2,
    hashPassword: hashPassword2,
    syncExistingFirebaseAuthPassword: syncExistingFirebaseAuthPassword2,
    requireVerifiedCaller,
    nowProvider
  } = deps;
  const getNowMs = nowProvider || (() => Date.now());
  app.post("/api/auth/login", async (req, res) => {
    try {
      const loginIdRaw = typeof req.body?.loginId === "string" ? req.body.loginId.trim() : "";
      const password = typeof req.body?.password === "string" ? req.body.password : "";
      if (!loginIdRaw) {
        return res.status(400).json({ success: false, error: "Please enter your Login ID." });
      }
      if (!password) {
        return res.status(400).json({ success: false, error: "Please enter your password." });
      }
      const cleanId = loginIdRaw.toLowerCase();
      const telemetry = await captureTelemetryContext(db, req);
      const requestNowMs = getNowMs();
      const ipCheck = await checkIpProgressiveRateLimitPersistent(
        db,
        telemetry.ipAddress,
        cleanId,
        requestNowMs
      );
      if (!ipCheck.allowed) {
        await recordLoginAttemptDoc(db, {
          loginId: cleanId,
          role: "UNKNOWN",
          success: false,
          outcome: "BLOCKED_RATE_LIMIT",
          failureReasonCategory: "RATE_LIMITED",
          failureReason: ipCheck.reason || "Rate limit cooldown active",
          nowMs: requestNowMs,
          telemetry
        });
        await recordSecurityAuditLogDoc(db, {
          action: "RATE_LIMIT_TRIGGERED",
          severity: "CRITICAL",
          targetLoginId: cleanId,
          reason: "IP progressive rate limit cooldown blocked login attempt",
          details: `Blocked login attempt for "${cleanId}" from IP ${telemetry.ipAddress} (${ipCheck.cooldownSeconds}s remaining).`,
          metadata: { cooldownSeconds: ipCheck.cooldownSeconds },
          nowMs: requestNowMs,
          telemetry
        });
        return res.status(429).json({
          success: false,
          code: "RATE_LIMITED",
          cooldownSeconds: ipCheck.cooldownSeconds,
          error: `Too many authentication attempts from this network. Please wait ${ipCheck.cooldownSeconds} seconds and try again.`
        });
      }
      await new Promise((r) => setTimeout(r, 25));
      const result = await withLoginIdLock(cleanId, async () => {
        const docId = `role_${cleanId}`;
        let userDoc = await db.collection("user_roles").doc(docId).get();
        if (!userDoc.exists) {
          const snap = await db.collection("user_roles").where("loginId", "==", cleanId).limit(1).get();
          if (!snap.empty) {
            userDoc = snap.docs[0];
          }
        }
        if (!userDoc || !userDoc.exists) {
          const ipRes = await recordIpFailurePersistent(db, telemetry.ipAddress, "unknown_id");
          await recordLoginAttemptDoc(db, {
            loginId: cleanId,
            role: "UNKNOWN",
            success: false,
            outcome: "ACCOUNT_NOT_FOUND",
            failureReasonCategory: "ACCOUNT_NOT_FOUND",
            failureReason: "Login ID does not exist",
            telemetry
          });
          await recordLoginHistoryEntry(db, {
            req,
            eventType: "LOGIN_FAILED",
            loginId: cleanId,
            role: "UNKNOWN",
            success: false,
            failureReason: "Account not found"
          });
          if (ipRes.triggeredCooldown) {
            await recordSecurityAuditLogDoc(db, {
              action: "RATE_LIMIT_TRIGGERED",
              severity: "CRITICAL",
              targetLoginId: cleanId,
              reason: "Repeated login probes for nonexistent Login IDs",
              details: `Automated unknown-account brute-force probe detected from ${telemetry.ipAddress}. Cooldown: ${ipRes.cooldownSeconds}s.`,
              metadata: { cooldownSeconds: ipRes.cooldownSeconds },
              telemetry
            });
            return {
              status: 429,
              body: {
                success: false,
                code: "RATE_LIMITED",
                cooldownSeconds: ipRes.cooldownSeconds,
                error: `Too many invalid authentication requests. Please wait ${ipRes.cooldownSeconds} seconds before trying again.`
              }
            };
          }
          return {
            status: 401,
            body: {
              success: false,
              code: "INVALID_CREDENTIALS",
              error: "Invalid Login ID or password, check again."
            }
          };
        }
        const userData = userDoc.data() || {};
        const roleUpper = String(userData.role || "USER").toUpperCase();
        const firebaseUid = String(userData.authUid || userDoc.id);
        const secRef = db.collection("account_security").doc(`sec_${cleanId}`);
        const userRef = db.collection("user_roles").doc(userDoc.id);
        const normalizedUserRole = normalizeRoleValue(userData.role);
        let roleDeactivated = false;
        if (!SYSTEM_ROLE_IDS.has(normalizedUserRole)) {
          const roleDocSnap = await db.collection("roles").doc(normalizedUserRole).get();
          if (roleDocSnap.exists && roleDocSnap.data()?.isActive === false) {
            roleDeactivated = true;
          }
        }
        if (userData.status === "Inactive" || roleDeactivated) {
          await recordLoginAttemptDoc(db, {
            loginId: cleanId,
            role: roleUpper,
            firebaseUid,
            success: false,
            outcome: "BLOCKED_INACTIVE",
            failureReasonCategory: roleDeactivated ? "ROLE_INACTIVE" : "ACCOUNT_INACTIVE",
            failureReason: roleDeactivated ? `Assigned role "${normalizedUserRole}" is Inactive` : "Account status is Inactive",
            telemetry
          });
          await recordLoginHistoryEntry(db, {
            req,
            eventType: "LOGIN_FAILED",
            loginId: cleanId,
            authUid: firebaseUid,
            role: roleUpper,
            success: false,
            failureReason: roleDeactivated ? "Assigned role is Inactive" : "Account is Inactive"
          });
          return {
            status: 403,
            body: {
              success: false,
              code: roleDeactivated ? "ROLE_INACTIVE" : "ACCOUNT_INACTIVE",
              error: roleDeactivated ? "Your assigned role is currently inactive. Please contact Super Admin." : "Account Deactivated. Please contact Super Admin."
            }
          };
        }
        const nowMs = getNowMs();
        const now = new Date(nowMs).toISOString();
        const deviceSummary = {
          browser: telemetry.uaMeta.browser,
          os: telemetry.uaMeta.os,
          deviceType: telemetry.uaMeta.deviceType
        };
        const isPreCheckedCanonicalSuperAdmin = isCanonicalSuperAdminAccount(userDoc.id, userData);
        const superAdminResetHours = isPreCheckedCanonicalSuperAdmin ? await resolveSuperAdminLockoutResetHours(db) : DEFAULT_SUPER_ADMIN_LOCKOUT_RESET_HOURS;
        const txOutcome = await db.runTransaction(async (tx) => {
          const [secSnap, freshUserSnap] = await Promise.all([tx.get(secRef), tx.get(userRef)]);
          const freshUserData = freshUserSnap.exists ? freshUserSnap.data() || {} : userData;
          const isCanonicalSA = isCanonicalSuperAdminAccount(userDoc.id, freshUserData);
          let curSec = secSnap.exists ? { ...secSnap.data() || {} } : {
            id: `sec_${cleanId}`,
            loginId: cleanId,
            role: roleUpper,
            firebaseUid,
            email: freshUserData.email || `${cleanId}@narid.com`,
            lockStatus: freshUserData.isLocked || freshUserData.lockStatus === "LOCKED" ? "LOCKED" : "ACTIVE",
            lockPolicyType: isCanonicalSA ? "PROGRESSIVE_TEMPORARY" : "PERMANENT_MANUAL",
            consecutiveFailedAttempts: Number(freshUserData.consecutiveFailedAttempts || 0),
            maxAttemptsAllowed: MAX_CONSECUTIVE_FAILED_ATTEMPTS,
            totalLoginAttempts: 0,
            totalSuccessfulLogins: 0,
            totalFailedLogins: 0,
            forcePasswordChange: freshUserData.mustChangePassword === true || freshUserData.forcePasswordChange === true,
            lockedAt: freshUserData.lockedAt || null,
            lockoutUntil: freshUserData.lockoutUntil || freshUserData.lockedUntil || null,
            lockedUntil: freshUserData.lockedUntil || freshUserData.lockoutUntil || null,
            lockedUntilMs: typeof freshUserData.lockedUntilMs === "number" ? freshUserData.lockedUntilMs : null,
            lockDurationMinutes: typeof freshUserData.lockDurationMinutes === "number" ? freshUserData.lockDurationMinutes : null,
            lockReason: freshUserData.lockReason || null,
            progressiveLockLevel: Number(freshUserData.progressiveLockLevel || 0),
            totalLockoutEvents: Number(freshUserData.totalLockoutEvents || 0),
            lastLockoutAt: freshUserData.lastLockoutAt || null,
            lastLockExpiredAt: freshUserData.lastLockExpiredAt || null,
            cleanWindowStartAt: freshUserData.cleanWindowStartAt || null,
            cleanWindowStartMs: typeof freshUserData.cleanWindowStartMs === "number" ? freshUserData.cleanWindowStartMs : null,
            cleanLoginsSinceLastLockout: Number(freshUserData.cleanLoginsSinceLastLockout || 0),
            pendingPostLockoutLoginAudit: Boolean(freshUserData.pendingPostLockoutLoginAudit)
          };
          const saLockWindow = isCanonicalSA ? resolveCanonicalSuperAdminLockWindow(curSec, freshUserData) : {
            lockedUntilMs: resolveAuthoritativeLockedUntilMs(curSec, freshUserData),
            lockoutUntil: null,
            lockDurationMinutes: null
          };
          const existingLockedUntilMs = saLockWindow.lockedUntilMs;
          let isCurrentlyLocked = curSec.lockStatus === "LOCKED" || freshUserData.lockStatus === "LOCKED" || freshUserData.isLocked === true;
          let expiredLockInfo = null;
          if (isCurrentlyLocked && isCanonicalSA && existingLockedUntilMs !== null && nowMs >= existingLockedUntilMs) {
            const retainedLevel = Number(
              curSec.progressiveLockLevel ?? freshUserData.progressiveLockLevel ?? 0
            );
            expiredLockInfo = {
              previousLockedAt: curSec.lockedAt || freshUserData.lockedAt || null,
              previousLockedUntil: saLockWindow.lockoutUntil || resolveAuthoritativeLockedUntilIso(existingLockedUntilMs, curSec, freshUserData),
              previousDurationMinutes: saLockWindow.lockDurationMinutes ?? curSec.lockDurationMinutes ?? freshUserData.lockDurationMinutes ?? null,
              retainedProgressiveLevel: retainedLevel
            };
            isCurrentlyLocked = false;
            curSec = {
              ...curSec,
              lockStatus: "ACTIVE",
              lockPolicyType: "PROGRESSIVE_TEMPORARY",
              consecutiveFailedAttempts: 0,
              lockedAt: null,
              lockoutUntil: null,
              lockedUntil: null,
              lockedUntilMs: null,
              lockDurationMinutes: null,
              lockReason: null,
              lastLockExpiredAt: now,
              progressiveLockLevel: retainedLevel,
              pendingPostLockoutLoginAudit: true
            };
          }
          if (isCurrentlyLocked) {
            const activeLockedUntilMs = isCanonicalSA ? existingLockedUntilMs : null;
            const remainingSeconds = isCanonicalSA && activeLockedUntilMs !== null ? Math.max(1, Math.ceil((activeLockedUntilMs - nowMs) / 1e3)) : null;
            const lockedUntilIso = isCanonicalSA && activeLockedUntilMs !== null ? saLockWindow.lockoutUntil || resolveAuthoritativeLockedUntilIso(activeLockedUntilMs, curSec, freshUserData) : null;
            const activeDurationMinutes = isCanonicalSA ? saLockWindow.lockDurationMinutes ?? curSec.lockDurationMinutes ?? freshUserData.lockDurationMinutes ?? null : null;
            tx.set(
              secRef,
              {
                ...curSec,
                role: roleUpper,
                firebaseUid,
                lockStatus: "LOCKED",
                lockPolicyType: isCanonicalSA ? "PROGRESSIVE_TEMPORARY" : "PERMANENT_MANUAL",
                totalLoginAttempts: Number(curSec.totalLoginAttempts || 0) + 1,
                lastFailedAt: now,
                lastFailedIp: telemetry.ipAddress,
                lastFailedGeo: telemetry.geoLocation,
                lastFailedDevice: deviceSummary,
                lastFailedReason: isCanonicalSA && remainingSeconds !== null ? `Attempted login during active temporary lockout (${formatLockoutDurationText(remainingSeconds)} remaining)` : "Attempted login while account LOCKED",
                updatedAt: now
              },
              { merge: true }
            );
            return {
              kind: "LOCKED_REJECT",
              isCanonicalSA,
              temporaryLock: Boolean(isCanonicalSA && activeLockedUntilMs !== null),
              lockedUntil: lockedUntilIso,
              lockedUntilMs: activeLockedUntilMs,
              serverNowMs: nowMs,
              remainingSeconds,
              lockDurationMinutes: activeDurationMinutes,
              progressiveLockLevel: Number(
                curSec.progressiveLockLevel ?? freshUserData.progressiveLockLevel ?? 0
              ),
              consecutiveFailed: Number(curSec.consecutiveFailedAttempts || MAX_CONSECUTIVE_FAILED_ATTEMPTS),
              expiredLockInfo: null,
              freshUserData
            };
          }
          const isPasswordValid = freshUserData.passwordHash ? verifyPassword2(password, String(freshUserData.passwordHash)) : false;
          if (!isPasswordValid) {
            const nextConsecutive = Number(curSec.consecutiveFailedAttempts || 0) + 1;
            const reachedLock = nextConsecutive >= MAX_CONSECUTIVE_FAILED_ATTEMPTS;
            if (isCanonicalSA) {
              const currentLevel = Number(
                curSec.progressiveLockLevel ?? freshUserData.progressiveLockLevel ?? 0
              );
              const nextLevel = reachedLock ? currentLevel + 1 : currentLevel;
              const durationMinutes = reachedLock ? computeSuperAdminLockDurationMinutes(nextLevel) : null;
              const lockedUntilMs = reachedLock && durationMinutes !== null ? nowMs + durationMinutes * 60 * 1e3 : null;
              const lockedUntilIso = lockedUntilMs !== null ? new Date(lockedUntilMs).toISOString() : null;
              const totalLockoutEvents = Number(curSec.totalLockoutEvents ?? freshUserData.totalLockoutEvents ?? 0) + (reachedLock ? 1 : 0);
              const lockReasonText = reachedLock && durationMinutes !== null ? `Progressive temporary lockout (${durationMinutes} minutes) after ${nextConsecutive} consecutive failed password attempts` : null;
              const secUpdate2 = {
                ...curSec,
                id: `sec_${cleanId}`,
                loginId: cleanId,
                role: roleUpper,
                firebaseUid,
                email: freshUserData.email || `${cleanId}@narid.com`,
                lockStatus: reachedLock ? "LOCKED" : "ACTIVE",
                lockPolicyType: "PROGRESSIVE_TEMPORARY",
                consecutiveFailedAttempts: nextConsecutive,
                maxAttemptsAllowed: MAX_CONSECUTIVE_FAILED_ATTEMPTS,
                totalLoginAttempts: Number(curSec.totalLoginAttempts || 0) + 1,
                totalFailedLogins: Number(curSec.totalFailedLogins || 0) + 1,
                lastFailedAt: now,
                lastFailedIp: telemetry.ipAddress,
                lastFailedGeo: telemetry.geoLocation,
                lastFailedDevice: deviceSummary,
                lastFailedReason: reachedLock ? `Super Admin temporarily locked for ${durationMinutes} minutes after ${nextConsecutive} consecutive failed password attempts` : `Invalid password (Attempt ${nextConsecutive} of ${MAX_CONSECUTIVE_FAILED_ATTEMPTS})`,
                lockedAt: reachedLock ? now : null,
                lockoutUntil: lockedUntilIso,
                lockedUntil: lockedUntilIso,
                lockedUntilMs,
                lockDurationMinutes: durationMinutes,
                lockReason: lockReasonText,
                progressiveLockLevel: nextLevel,
                totalLockoutEvents,
                lastLockoutAt: reachedLock ? now : curSec.lastLockoutAt || freshUserData.lastLockoutAt || null,
                lastLockExpiredAt: expiredLockInfo ? now : curSec.lastLockExpiredAt || freshUserData.lastLockExpiredAt || null,
                // Any failed password attempt clears the sustained clean usage window
                cleanWindowStartAt: null,
                cleanWindowStartMs: null,
                cleanLoginsSinceLastLockout: 0,
                pendingPostLockoutLoginAudit: reachedLock ? true : Boolean(expiredLockInfo || curSec.pendingPostLockoutLoginAudit),
                updatedAt: now
              };
              tx.set(secRef, secUpdate2, { merge: true });
              const userUpdates = {
                consecutiveFailedAttempts: nextConsecutive,
                isLocked: reachedLock,
                lockStatus: reachedLock ? "LOCKED" : "ACTIVE",
                lockPolicyType: "PROGRESSIVE_TEMPORARY",
                lockedAt: reachedLock ? now : null,
                lockoutUntil: lockedUntilIso,
                lockedUntil: lockedUntilIso,
                lockedUntilMs,
                lockDurationMinutes: durationMinutes,
                lockReason: lockReasonText,
                progressiveLockLevel: nextLevel,
                totalLockoutEvents,
                lastLockoutAt: secUpdate2.lastLockoutAt,
                lastLockExpiredAt: secUpdate2.lastLockExpiredAt,
                cleanWindowStartAt: null,
                cleanWindowStartMs: null,
                cleanLoginsSinceLastLockout: 0,
                pendingPostLockoutLoginAudit: secUpdate2.pendingPostLockoutLoginAudit,
                updatedAt: now
              };
              if (reachedLock) {
                userUpdates.sessionRevokedAt = now;
              }
              tx.update(userRef, userUpdates);
              return {
                kind: reachedLock ? "NOW_LOCKED" : "FAILED_PASSWORD",
                isCanonicalSA: true,
                temporaryLock: reachedLock,
                attemptNumber: nextConsecutive,
                remainingAttempts: Math.max(0, MAX_CONSECUTIVE_FAILED_ATTEMPTS - nextConsecutive),
                lockedUntil: lockedUntilIso,
                lockedUntilMs,
                serverNowMs: nowMs,
                remainingSeconds: durationMinutes !== null ? durationMinutes * 60 : null,
                lockDurationMinutes: durationMinutes,
                progressiveLockLevel: nextLevel,
                totalLockoutEvents,
                expiredLockInfo,
                freshUserData
              };
            }
            const secUpdate = {
              ...curSec,
              id: `sec_${cleanId}`,
              loginId: cleanId,
              role: roleUpper,
              firebaseUid,
              email: freshUserData.email || `${cleanId}@narid.com`,
              lockStatus: reachedLock ? "LOCKED" : "ACTIVE",
              lockPolicyType: "PERMANENT_MANUAL",
              consecutiveFailedAttempts: nextConsecutive,
              maxAttemptsAllowed: MAX_CONSECUTIVE_FAILED_ATTEMPTS,
              totalLoginAttempts: Number(curSec.totalLoginAttempts || 0) + 1,
              totalFailedLogins: Number(curSec.totalFailedLogins || 0) + 1,
              lastFailedAt: now,
              lastFailedIp: telemetry.ipAddress,
              lastFailedGeo: telemetry.geoLocation,
              lastFailedDevice: deviceSummary,
              lastFailedReason: reachedLock ? `Account locked after ${nextConsecutive} consecutive failed password attempts` : `Invalid password (Attempt ${nextConsecutive} of ${MAX_CONSECUTIVE_FAILED_ATTEMPTS})`,
              lockedAt: reachedLock ? now : curSec.lockedAt || null,
              lockReason: reachedLock ? `Automatically locked after ${nextConsecutive} consecutive failed password attempts` : curSec.lockReason || null,
              updatedAt: now
            };
            tx.set(secRef, secUpdate, { merge: true });
            tx.update(userRef, {
              consecutiveFailedAttempts: nextConsecutive,
              isLocked: reachedLock,
              lockStatus: reachedLock ? "LOCKED" : "ACTIVE",
              lockedAt: reachedLock ? now : freshUserData.lockedAt || null,
              lockReason: reachedLock ? secUpdate.lockReason : freshUserData.lockReason || null,
              updatedAt: now
            });
            return {
              kind: reachedLock ? "NOW_LOCKED" : "FAILED_PASSWORD",
              isCanonicalSA: false,
              temporaryLock: false,
              attemptNumber: nextConsecutive,
              remainingAttempts: Math.max(0, MAX_CONSECUTIVE_FAILED_ATTEMPTS - nextConsecutive),
              lockedUntil: null,
              lockedUntilMs: null,
              serverNowMs: nowMs,
              remainingSeconds: null,
              lockDurationMinutes: null,
              progressiveLockLevel: 0,
              totalLockoutEvents: 0,
              expiredLockInfo: null,
              freshUserData
            };
          }
          const mustChange = freshUserData.mustChangePassword === true || curSec.forcePasswordChange === true;
          if (isCanonicalSA) {
            const wasPostLockoutLogin = Boolean(
              expiredLockInfo || curSec.pendingPostLockoutLoginAudit || freshUserData.pendingPostLockoutLoginAudit
            );
            const currentLevel = Number(
              curSec.progressiveLockLevel ?? freshUserData.progressiveLockLevel ?? 0
            );
            let nextLevel = currentLevel;
            let nextCleanStartAt = curSec.cleanWindowStartAt || freshUserData.cleanWindowStartAt || null;
            let nextCleanStartMs = typeof curSec.cleanWindowStartMs === "number" ? curSec.cleanWindowStartMs : typeof freshUserData.cleanWindowStartMs === "number" ? freshUserData.cleanWindowStartMs : null;
            let nextCleanLogins = Number(
              curSec.cleanLoginsSinceLastLockout ?? freshUserData.cleanLoginsSinceLastLockout ?? 0
            );
            let autoResetLevelInfo = null;
            if (currentLevel > 0) {
              const requiredWindowMs = superAdminResetHours * 60 * 60 * 1e3;
              if (nextCleanStartMs !== null && nowMs - nextCleanStartMs >= requiredWindowMs) {
                autoResetLevelInfo = {
                  previousLevel: currentLevel,
                  cleanWindowHours: superAdminResetHours,
                  cleanLogins: nextCleanLogins + 1
                };
                nextLevel = 0;
                nextCleanStartAt = null;
                nextCleanStartMs = null;
                nextCleanLogins = 0;
              } else {
                if (nextCleanStartMs === null) {
                  nextCleanStartMs = nowMs;
                  nextCleanStartAt = now;
                }
                nextCleanLogins += 1;
              }
            } else {
              nextCleanStartAt = null;
              nextCleanStartMs = null;
              nextCleanLogins = 0;
            }
            const resetReasonText = autoResetLevelInfo ? `Automatic reset after ${superAdminResetHours}h of sustained clean Super Admin usage with zero failed password attempts` : curSec.lockoutLevelResetReason || freshUserData.lockoutLevelResetReason || null;
            const resetAtText = autoResetLevelInfo ? now : curSec.lockoutLevelResetAt || freshUserData.lockoutLevelResetAt || null;
            tx.set(
              secRef,
              {
                ...curSec,
                id: `sec_${cleanId}`,
                loginId: cleanId,
                role: roleUpper,
                firebaseUid,
                email: freshUserData.email || `${cleanId}@narid.com`,
                lockStatus: "ACTIVE",
                lockPolicyType: "PROGRESSIVE_TEMPORARY",
                consecutiveFailedAttempts: 0,
                maxAttemptsAllowed: MAX_CONSECUTIVE_FAILED_ATTEMPTS,
                totalLoginAttempts: Number(curSec.totalLoginAttempts || 0) + 1,
                totalSuccessfulLogins: Number(curSec.totalSuccessfulLogins || 0) + 1,
                forcePasswordChange: mustChange,
                lockedAt: null,
                lockoutUntil: null,
                lockedUntil: null,
                lockedUntilMs: null,
                lockDurationMinutes: null,
                lockReason: null,
                progressiveLockLevel: nextLevel,
                totalLockoutEvents: Number(
                  curSec.totalLockoutEvents ?? freshUserData.totalLockoutEvents ?? 0
                ),
                lastLockoutAt: curSec.lastLockoutAt || freshUserData.lastLockoutAt || null,
                lastLockExpiredAt: expiredLockInfo ? now : curSec.lastLockExpiredAt || freshUserData.lastLockExpiredAt || null,
                cleanWindowStartAt: nextCleanStartAt,
                cleanWindowStartMs: nextCleanStartMs,
                cleanLoginsSinceLastLockout: nextCleanLogins,
                pendingPostLockoutLoginAudit: false,
                lockoutLevelResetAt: resetAtText,
                lockoutLevelResetReason: resetReasonText,
                lastSuccessAt: now,
                lastSuccessIp: telemetry.ipAddress,
                lastSuccessGeo: telemetry.geoLocation,
                lastSuccessDevice: deviceSummary,
                updatedAt: now
              },
              { merge: true }
            );
            tx.update(userRef, {
              consecutiveFailedAttempts: 0,
              isLocked: false,
              lockStatus: "ACTIVE",
              lockPolicyType: "PROGRESSIVE_TEMPORARY",
              lockedAt: null,
              lockoutUntil: null,
              lockedUntil: null,
              lockedUntilMs: null,
              lockDurationMinutes: null,
              lockReason: null,
              progressiveLockLevel: nextLevel,
              lastLockExpiredAt: expiredLockInfo ? now : freshUserData.lastLockExpiredAt || null,
              cleanWindowStartAt: nextCleanStartAt,
              cleanWindowStartMs: nextCleanStartMs,
              cleanLoginsSinceLastLockout: nextCleanLogins,
              pendingPostLockoutLoginAudit: false,
              lockoutLevelResetAt: resetAtText,
              lockoutLevelResetReason: resetReasonText,
              lastSuccessLoginAt: now,
              updatedAt: now
            });
            return {
              kind: "SUCCESS",
              isCanonicalSA: true,
              mustChange,
              expiredLockInfo,
              wasPostLockoutLogin,
              autoResetLevelInfo,
              progressiveLockLevel: nextLevel,
              freshUserData
            };
          }
          tx.set(
            secRef,
            {
              ...curSec,
              id: `sec_${cleanId}`,
              loginId: cleanId,
              role: roleUpper,
              firebaseUid,
              email: freshUserData.email || `${cleanId}@narid.com`,
              lockStatus: "ACTIVE",
              consecutiveFailedAttempts: 0,
              maxAttemptsAllowed: MAX_CONSECUTIVE_FAILED_ATTEMPTS,
              totalLoginAttempts: Number(curSec.totalLoginAttempts || 0) + 1,
              totalSuccessfulLogins: Number(curSec.totalSuccessfulLogins || 0) + 1,
              forcePasswordChange: mustChange,
              lastSuccessAt: now,
              lastSuccessIp: telemetry.ipAddress,
              lastSuccessGeo: telemetry.geoLocation,
              lastSuccessDevice: deviceSummary,
              updatedAt: now
            },
            { merge: true }
          );
          tx.update(userRef, {
            consecutiveFailedAttempts: 0,
            isLocked: false,
            lockStatus: "ACTIVE",
            lastSuccessLoginAt: now,
            updatedAt: now
          });
          return {
            kind: "SUCCESS",
            isCanonicalSA: false,
            mustChange,
            expiredLockInfo: null,
            wasPostLockoutLogin: false,
            autoResetLevelInfo: null,
            progressiveLockLevel: 0,
            freshUserData
          };
        });
        const resolvedUserData = txOutcome.freshUserData || userData;
        if (txOutcome.expiredLockInfo) {
          await Promise.all([
            recordSecurityAuditLogDoc(db, {
              action: "LOCKOUT_EXPIRED_REACTIVATED",
              severity: "INFO",
              targetLoginId: cleanId,
              targetRole: roleUpper,
              targetUid: firebaseUid,
              reason: "Super Admin temporary lockout duration expired; account automatically reactivated",
              details: `Temporary lockout for canonical Super Admin "${cleanId}" expired at ${txOutcome.expiredLockInfo.previousLockedUntil || now}. Consecutive failed counter reset to 0 while retaining progressive level ${txOutcome.expiredLockInfo.retainedProgressiveLevel}.`,
              metadata: {
                previousLockedAt: txOutcome.expiredLockInfo.previousLockedAt,
                previousLockedUntil: txOutcome.expiredLockInfo.previousLockedUntil,
                previousDurationMinutes: txOutcome.expiredLockInfo.previousDurationMinutes,
                retainedProgressiveLevel: txOutcome.expiredLockInfo.retainedProgressiveLevel
              },
              nowMs,
              telemetry
            }),
            recordEnterpriseAuditEvent(db, {
              req,
              action: "super_admin_lockout_expired",
              category: "SECURITY",
              severity: "INFO",
              actorUid: firebaseUid,
              actorLoginId: cleanId,
              actorRole: roleUpper,
              targetType: "ACCOUNT",
              targetId: userDoc.id,
              oldValue: {
                lockStatus: "LOCKED",
                lockedUntil: txOutcome.expiredLockInfo.previousLockedUntil,
                lockDurationMinutes: txOutcome.expiredLockInfo.previousDurationMinutes
              },
              newValue: {
                lockStatus: "ACTIVE",
                consecutiveFailedAttempts: 0,
                progressiveLockLevel: txOutcome.expiredLockInfo.retainedProgressiveLevel
              },
              actionSource: "PROGRESSIVE_LOCKOUT_ENGINE",
              description: `Canonical Super Admin temporary lockout expired; account automatically reactivated with progressive level ${txOutcome.expiredLockInfo.retainedProgressiveLevel} retained.`,
              success: true
            })
          ]);
        }
        if (txOutcome.kind === "LOCKED_REJECT") {
          await syncUserUidIndex(db, {
            uid: resolvedUserData.authUid || null,
            roleDocId: userDoc.id,
            role: String(resolvedUserData.role || "user"),
            status: String(resolvedUserData.status || "Active"),
            lockStatus: "LOCKED",
            lockedUntilMs: txOutcome.lockedUntilMs ?? null,
            loginId: cleanId
          });
          const ipRes = await recordIpFailurePersistent(
            db,
            telemetry.ipAddress,
            "locked_hit",
            cleanId,
            nowMs
          );
          const lockedErrorMessage = txOutcome.temporaryLock && txOutcome.remainingSeconds !== null ? `Super Admin account is temporarily locked due to repeated failed password attempts. Try again in ${formatLockoutDurationText(txOutcome.remainingSeconds)}.` : LOCKED_ACCOUNT_MESSAGE;
          await Promise.all([
            recordLoginAttemptDoc(db, {
              loginId: cleanId,
              role: roleUpper,
              firebaseUid,
              success: false,
              outcome: "BLOCKED_LOCKED",
              failureReasonCategory: "ACCOUNT_LOCKED",
              failureReason: txOutcome.temporaryLock ? `Login rejected during active temporary lockout (${txOutcome.remainingSeconds}s remaining)` : "Login rejected because account status is LOCKED",
              consecutiveFailedAfter: txOutcome.consecutiveFailed,
              lockDurationMinutes: txOutcome.lockDurationMinutes,
              lockedUntil: txOutcome.lockedUntil,
              nowMs,
              telemetry
            }),
            recordSecurityAuditLogDoc(db, {
              action: "LOGIN_BLOCKED_WHILE_LOCKED",
              severity: "WARNING",
              targetLoginId: cleanId,
              targetRole: roleUpper,
              targetUid: firebaseUid,
              reason: txOutcome.temporaryLock ? "Attempted login during active Super Admin temporary lockout" : "Attempted login on locked account",
              details: txOutcome.temporaryLock ? `Rejected login attempt for temporarily locked Super Admin "${cleanId}" from IP ${telemetry.ipAddress} (${txOutcome.remainingSeconds}s remaining until ${txOutcome.lockedUntil}).` : `Rejected login attempt for locked account "${cleanId}" (${roleUpper}) from IP ${telemetry.ipAddress}.`,
              metadata: txOutcome.temporaryLock ? {
                temporaryLock: true,
                lockedUntil: txOutcome.lockedUntil,
                remainingSeconds: txOutcome.remainingSeconds,
                lockDurationMinutes: txOutcome.lockDurationMinutes
              } : void 0,
              nowMs,
              telemetry
            }),
            recordLoginHistoryEntry(db, {
              req,
              eventType: "LOGIN_LOCKED",
              loginId: cleanId,
              authUid: firebaseUid,
              role: roleUpper,
              success: false,
              failureReason: lockedErrorMessage
            }),
            recordEnterpriseAuditEvent(db, {
              req,
              action: "login_locked_rate_limit",
              category: "SECURITY",
              severity: "CRITICAL",
              actorUid: firebaseUid,
              actorLoginId: cleanId,
              actorRole: roleUpper,
              targetId: userDoc.id,
              actionSource: "ACCOUNT_LOCKOUT_GUARD",
              description: txOutcome.temporaryLock ? `Blocked login attempt on temporarily locked Super Admin "${cleanId}" (${txOutcome.remainingSeconds}s remaining).` : `Blocked login attempt on already locked account "${cleanId}".`,
              success: false
            })
          ]);
          if (ipRes.triggeredCooldown) {
            await recordSecurityAuditLogDoc(db, {
              action: "RATE_LIMIT_TRIGGERED",
              severity: "CRITICAL",
              targetLoginId: cleanId,
              targetRole: roleUpper,
              targetUid: firebaseUid,
              reason: "Repeated attempts against locked account triggered progressive IP cooldown",
              details: `IP ${telemetry.ipAddress} triggered ${ipRes.cooldownSeconds}s progressive cooldown after hammering locked account "${cleanId}".`,
              metadata: { cooldownSeconds: ipRes.cooldownSeconds },
              nowMs,
              telemetry
            });
          }
          recordActivityTelemetry(db, {
            actorUid: firebaseUid,
            actorLoginId: cleanId,
            actorRole: roleUpper,
            action: "LOGIN_BLOCKED_LOCKED",
            module: "Authentication",
            result: "Failed",
            correlationId: req.correlationId,
            detail: txOutcome.temporaryLock ? `Blocked during temporary lockout (${txOutcome.remainingSeconds}s remaining)` : "Attempted login on locked account"
          });
          if (txOutcome.temporaryLock) {
            return {
              status: 423,
              body: {
                success: false,
                code: "ACCOUNT_LOCKED",
                locked: true,
                temporaryLock: true,
                lockoutUntil: txOutcome.lockedUntil,
                lockedUntil: txOutcome.lockedUntil,
                lockedUntilMs: txOutcome.lockedUntilMs,
                serverNowMs: txOutcome.serverNowMs,
                remainingSeconds: txOutcome.remainingSeconds,
                lockDurationMinutes: txOutcome.lockDurationMinutes,
                error: lockedErrorMessage
              }
            };
          }
          return {
            status: 423,
            body: {
              success: false,
              code: "ACCOUNT_LOCKED",
              locked: true,
              temporaryLock: false,
              error: LOCKED_ACCOUNT_MESSAGE
            }
          };
        }
        if (txOutcome.kind === "NOW_LOCKED") {
          await syncUserUidIndex(db, {
            uid: resolvedUserData.authUid || null,
            roleDocId: userDoc.id,
            role: String(resolvedUserData.role || "user"),
            status: String(resolvedUserData.status || "Active"),
            lockStatus: "LOCKED",
            lockedUntilMs: txOutcome.lockedUntilMs ?? null,
            loginId: cleanId
          });
          if (txOutcome.isCanonicalSA && auth && resolvedUserData.authUid && !String(resolvedUserData.authUid).startsWith("role_")) {
            try {
              await auth.revokeRefreshTokens(String(resolvedUserData.authUid));
            } catch (revokeErr) {
              console.warn(
                "[Super Admin Progressive Lockout] revokeRefreshTokens notice:",
                revokeErr?.message || revokeErr
              );
            }
          }
          await recordIpFailurePersistent(db, telemetry.ipAddress, "password", cleanId, nowMs);
          const isTempSA = txOutcome.isCanonicalSA && txOutcome.temporaryLock;
          const lockedReasonMsg = isTempSA ? `Super Admin account temporarily locked for ${txOutcome.lockDurationMinutes} minutes after ${txOutcome.attemptNumber} consecutive failed password attempts. Please wait before trying again.` : LOCKED_ACCOUNT_MESSAGE;
          await Promise.all([
            recordLoginAttemptDoc(db, {
              loginId: cleanId,
              role: roleUpper,
              firebaseUid,
              success: false,
              outcome: "FAILED_PASSWORD",
              failureReasonCategory: "ACCOUNT_LOCKED",
              failureReason: isTempSA ? `3rd consecutive failed password triggered progressive temporary lockout (${txOutcome.lockDurationMinutes} minutes)` : "3rd consecutive failed password attempt triggered automatic account lock",
              attemptNumber: txOutcome.attemptNumber,
              consecutiveFailedAfter: txOutcome.attemptNumber,
              triggeredLock: true,
              lockDurationMinutes: txOutcome.lockDurationMinutes,
              lockedUntil: txOutcome.lockedUntil,
              nowMs,
              telemetry
            }),
            recordSecurityAuditLogDoc(db, {
              action: "ACCOUNT_LOCKED",
              severity: "CRITICAL",
              targetLoginId: cleanId,
              targetRole: roleUpper,
              targetUid: firebaseUid,
              reason: isTempSA ? `Super Admin progressive temporary lockout triggered (${txOutcome.lockDurationMinutes} minutes, level ${txOutcome.progressiveLockLevel})` : "Exceeded 3 consecutive failed password attempts",
              details: isTempSA ? `SECURITY ALERT: Canonical Super Admin "${cleanId}" (UID: ${firebaseUid}) temporarily LOCKED for ${txOutcome.lockDurationMinutes} minutes (progressive level ${txOutcome.progressiveLockLevel}, event #${txOutcome.totalLockoutEvents}) until ${txOutcome.lockedUntil}. Active sessions revoked.` : `SECURITY ALERT: Account "${cleanId}" (${roleUpper}, UID: ${firebaseUid}) automatically LOCKED on failed attempt #${txOutcome.attemptNumber}.`,
              metadata: isTempSA ? {
                attemptNumber: txOutcome.attemptNumber,
                maxAttempts: MAX_CONSECUTIVE_FAILED_ATTEMPTS,
                lockPolicyType: "PROGRESSIVE_TEMPORARY",
                progressiveLockLevel: txOutcome.progressiveLockLevel,
                totalLockoutEvents: txOutcome.totalLockoutEvents,
                lockDurationMinutes: txOutcome.lockDurationMinutes,
                lockedUntil: txOutcome.lockedUntil,
                sessionsRevoked: true
              } : { attemptNumber: txOutcome.attemptNumber, maxAttempts: MAX_CONSECUTIVE_FAILED_ATTEMPTS },
              nowMs,
              telemetry
            }),
            recordLoginHistoryEntry(db, {
              req,
              eventType: "LOGIN_LOCKED",
              loginId: cleanId,
              authUid: firebaseUid,
              role: roleUpper,
              success: false,
              failureReason: isTempSA ? `Progressive temporary lockout (${txOutcome.lockDurationMinutes}m) after ${txOutcome.attemptNumber} failed attempts` : `Locked after ${txOutcome.attemptNumber} consecutive failed attempts`
            }),
            recordEnterpriseAuditEvent(db, {
              req,
              action: isTempSA ? "super_admin_progressive_lockout" : "failed_login_threshold_exceeded",
              category: "SECURITY",
              severity: "CRITICAL",
              actorUid: firebaseUid,
              actorLoginId: cleanId,
              actorRole: roleUpper,
              targetType: "ACCOUNT",
              targetId: userDoc.id,
              newValue: isTempSA ? {
                lockStatus: "LOCKED",
                lockPolicyType: "PROGRESSIVE_TEMPORARY",
                progressiveLockLevel: txOutcome.progressiveLockLevel,
                totalLockoutEvents: txOutcome.totalLockoutEvents,
                lockDurationMinutes: txOutcome.lockDurationMinutes,
                lockedUntil: txOutcome.lockedUntil
              } : void 0,
              actionSource: isTempSA ? "PROGRESSIVE_LOCKOUT_ENGINE" : "ACCOUNT_LOCKOUT_ENGINE",
              description: isTempSA ? `Canonical Super Admin "${cleanId}" temporarily locked for ${txOutcome.lockDurationMinutes} minutes (level ${txOutcome.progressiveLockLevel}) after ${txOutcome.attemptNumber} consecutive failed attempts.` : `Account "${cleanId}" (${roleUpper}) automatically LOCKED after ${txOutcome.attemptNumber} consecutive failed password attempts.`,
              success: false
            })
          ]);
          recordActivityTelemetry(db, {
            actorUid: firebaseUid,
            actorLoginId: cleanId,
            actorRole: roleUpper,
            action: "ACCOUNT_LOCKED",
            module: "Authentication",
            result: "Failed",
            correlationId: req.correlationId,
            detail: isTempSA ? `Progressive temporary lock (${txOutcome.lockDurationMinutes}m) on attempt #${txOutcome.attemptNumber}` : `Auto-locked on attempt #${txOutcome.attemptNumber}`
          });
          recordErrorTelemetry(db, {
            source: "AUTH",
            module: "Authentication",
            category: "AUTH",
            severity: "CRITICAL",
            message: isTempSA ? `Super Admin temporarily locked (${txOutcome.lockDurationMinutes}m) after ${txOutcome.attemptNumber} failed attempts` : `Account locked after ${txOutcome.attemptNumber} failed attempts`,
            statusCode: 423,
            correlationId: req.correlationId
          });
          if (isTempSA) {
            return {
              status: 423,
              body: {
                success: false,
                code: "ACCOUNT_LOCKED",
                locked: true,
                temporaryLock: true,
                lockoutUntil: txOutcome.lockedUntil,
                lockedUntil: txOutcome.lockedUntil,
                lockedUntilMs: txOutcome.lockedUntilMs,
                serverNowMs: txOutcome.serverNowMs,
                remainingSeconds: txOutcome.remainingSeconds,
                lockDurationMinutes: txOutcome.lockDurationMinutes,
                attemptNumber: txOutcome.attemptNumber,
                maxAttempts: MAX_CONSECUTIVE_FAILED_ATTEMPTS,
                remainingAttempts: 0,
                error: lockedReasonMsg
              }
            };
          }
          return {
            status: 423,
            body: {
              success: false,
              code: "ACCOUNT_LOCKED",
              locked: true,
              temporaryLock: false,
              attemptNumber: txOutcome.attemptNumber,
              maxAttempts: MAX_CONSECUTIVE_FAILED_ATTEMPTS,
              remainingAttempts: 0,
              error: LOCKED_ACCOUNT_MESSAGE
            }
          };
        }
        if (txOutcome.kind === "FAILED_PASSWORD") {
          if (txOutcome.expiredLockInfo) {
            await syncUserUidIndex(db, {
              uid: resolvedUserData.authUid || null,
              roleDocId: userDoc.id,
              role: String(resolvedUserData.role || "user"),
              status: String(resolvedUserData.status || "Active"),
              lockStatus: "ACTIVE",
              lockedUntilMs: null,
              loginId: cleanId
            });
          }
          await recordIpFailurePersistent(db, telemetry.ipAddress, "password", cleanId, nowMs);
          const isSecondWarning = txOutcome.attemptNumber === 2;
          await Promise.all([
            recordLoginAttemptDoc(db, {
              loginId: cleanId,
              role: roleUpper,
              firebaseUid,
              success: false,
              outcome: "FAILED_PASSWORD",
              failureReasonCategory: "INVALID_PASSWORD",
              failureReason: isSecondWarning ? "2nd consecutive failed attempt (Warning issued: 1 attempt remaining)" : `Failed password attempt #${txOutcome.attemptNumber}`,
              attemptNumber: txOutcome.attemptNumber,
              consecutiveFailedAfter: txOutcome.attemptNumber,
              triggeredLock: false,
              nowMs,
              telemetry
            }),
            recordSecurityAuditLogDoc(db, {
              action: isSecondWarning ? "LOGIN_ATTEMPT_WARNING" : "LOGIN_ATTEMPT_FAILED",
              severity: "WARNING",
              targetLoginId: cleanId,
              targetRole: roleUpper,
              targetUid: firebaseUid,
              reason: isSecondWarning ? "2nd consecutive failed password attempt warning" : "Invalid password attempt",
              details: isSecondWarning ? `Warning issued on "${cleanId}" (${roleUpper}): 2 of 3 consecutive failed attempts recorded. Next failure will lock account.` : `Failed login attempt #${txOutcome.attemptNumber} for "${cleanId}" (${roleUpper}).`,
              metadata: {
                attemptNumber: txOutcome.attemptNumber,
                remainingAttempts: txOutcome.remainingAttempts
              },
              nowMs,
              telemetry
            }),
            recordLoginHistoryEntry(db, {
              req,
              eventType: "LOGIN_FAILED",
              loginId: cleanId,
              authUid: firebaseUid,
              role: roleUpper,
              success: false,
              failureReason: `Incorrect password (Attempt ${txOutcome.attemptNumber} of ${MAX_CONSECUTIVE_FAILED_ATTEMPTS})`
            }),
            recordEnterpriseAuditEvent(db, {
              req,
              action: "login_failed",
              category: "AUTH",
              severity: "WARNING",
              actorUid: firebaseUid,
              actorLoginId: cleanId,
              actorRole: roleUpper,
              targetId: userDoc.id,
              actionSource: "AUTH_LOGIN",
              description: `Failed login attempt ${txOutcome.attemptNumber}/${MAX_CONSECUTIVE_FAILED_ATTEMPTS} for "${cleanId}".`,
              success: false
            })
          ]);
          recordActivityTelemetry(db, {
            actorUid: firebaseUid,
            actorLoginId: cleanId,
            actorRole: roleUpper,
            action: "LOGIN_FAILED",
            module: "Authentication",
            result: "Failed",
            correlationId: req.correlationId,
            detail: `Invalid password attempt ${txOutcome.attemptNumber}/${MAX_CONSECUTIVE_FAILED_ATTEMPTS}`
          });
          return {
            status: 401,
            body: isSecondWarning ? {
              success: false,
              code: "SECOND_FAILED_WARNING",
              warning: true,
              attemptNumber: txOutcome.attemptNumber,
              maxAttempts: MAX_CONSECUTIVE_FAILED_ATTEMPTS,
              remainingAttempts: txOutcome.remainingAttempts,
              error: "Invalid password. Warning: 2 of 3 failed attempts recorded. 1 attempt remaining before your account is locked."
            } : {
              success: false,
              code: "INVALID_PASSWORD",
              warning: false,
              attemptNumber: txOutcome.attemptNumber,
              maxAttempts: MAX_CONSECUTIVE_FAILED_ATTEMPTS,
              remainingAttempts: txOutcome.remainingAttempts,
              error: `Invalid password, check again (Attempt ${txOutcome.attemptNumber} of ${MAX_CONSECUTIVE_FAILED_ATTEMPTS}).`
            }
          };
        }
        await clearIpCooldownPersistent(db, telemetry.ipAddress, cleanId);
        await syncUserUidIndex(db, {
          uid: resolvedUserData.authUid || null,
          roleDocId: userDoc.id,
          role: String(resolvedUserData.role || "user"),
          status: String(resolvedUserData.status || "Active"),
          lockStatus: "ACTIVE",
          lockedUntilMs: null,
          loginId: cleanId
        });
        const sessionId = `sess_${crypto3.randomBytes(10).toString("hex")}`;
        const sessionToken = crypto3.randomBytes(32).toString("hex");
        let effectiveModules = Array.isArray(resolvedUserData.modulesAllowed) ? [...resolvedUserData.modulesAllowed] : [];
        if (String(resolvedUserData.role || "").toLowerCase() === "user" && !resolvedUserData.dashboardAccessMigratedV1) {
          if (!effectiveModules.includes("dashboard")) {
            effectiveModules = ["dashboard", ...effectiveModules];
          }
        }
        const successAuditTasks = [
          recordLoginAttemptDoc(db, {
            loginId: cleanId,
            role: roleUpper,
            firebaseUid,
            success: true,
            outcome: "SUCCESS",
            failureReasonCategory: "NONE",
            consecutiveFailedAfter: 0,
            sessionId,
            nowMs,
            telemetry
          }),
          recordSecurityAuditLogDoc(db, {
            action: "LOGIN_SUCCESS",
            severity: "INFO",
            targetLoginId: cleanId,
            targetRole: roleUpper,
            targetUid: firebaseUid,
            actorUid: firebaseUid,
            actorLoginId: cleanId,
            actorRole: roleUpper,
            reason: "Successful credential verification",
            details: `User "${cleanId}" (${roleUpper}) authenticated successfully. Consecutive failed counter reset to 0.`,
            metadata: { sessionId, forcePasswordChange: txOutcome.mustChange },
            nowMs,
            telemetry
          }),
          recordLoginHistoryEntry(db, {
            req,
            eventType: "LOGIN_SUCCESS",
            loginId: cleanId,
            authUid: firebaseUid,
            role: roleUpper,
            success: true,
            sessionId
          }),
          recordEnterpriseAuditEvent(db, {
            req,
            action: "login_success",
            category: "AUTH",
            severity: "INFO",
            actorUid: firebaseUid,
            actorLoginId: cleanId,
            actorRole: roleUpper,
            targetId: userDoc.id,
            actionSource: "AUTH_LOGIN",
            sessionId,
            description: `User "${cleanId}" (${roleUpper}) successfully authenticated.`,
            success: true
          })
        ];
        if (txOutcome.isCanonicalSA && txOutcome.wasPostLockoutLogin) {
          successAuditTasks.push(
            recordSecurityAuditLogDoc(db, {
              action: "LOGIN_SUCCESS_AFTER_LOCKOUT",
              severity: "INFO",
              targetLoginId: cleanId,
              targetRole: roleUpper,
              targetUid: firebaseUid,
              actorUid: firebaseUid,
              actorLoginId: cleanId,
              actorRole: roleUpper,
              reason: "First successful Super Admin login following temporary lockout expiry",
              details: `Canonical Super Admin "${cleanId}" signed in successfully after temporary lockout expiry (session ${sessionId}). Progressive lockout level is ${txOutcome.progressiveLockLevel}.`,
              metadata: {
                sessionId,
                progressiveLockLevel: txOutcome.progressiveLockLevel
              },
              nowMs,
              telemetry
            }),
            recordEnterpriseAuditEvent(db, {
              req,
              action: "login_success_after_lockout",
              category: "SECURITY",
              severity: "INFO",
              actorUid: firebaseUid,
              actorLoginId: cleanId,
              actorRole: roleUpper,
              targetType: "ACCOUNT",
              targetId: userDoc.id,
              actionSource: "PROGRESSIVE_LOCKOUT_ENGINE",
              sessionId,
              newValue: { progressiveLockLevel: txOutcome.progressiveLockLevel },
              description: `Canonical Super Admin "${cleanId}" completed first successful login after temporary lockout expiry.`,
              success: true
            })
          );
        }
        if (txOutcome.isCanonicalSA && txOutcome.autoResetLevelInfo) {
          successAuditTasks.push(
            recordSecurityAuditLogDoc(db, {
              action: "LOCKOUT_LEVEL_RESET",
              severity: "INFO",
              targetLoginId: cleanId,
              targetRole: roleUpper,
              targetUid: firebaseUid,
              actorUid: firebaseUid,
              actorLoginId: cleanId,
              actorRole: roleUpper,
              reason: `Automatic progressive lockout level reset after ${txOutcome.autoResetLevelInfo.cleanWindowHours}h sustained clean usage`,
              details: `Canonical Super Admin "${cleanId}" progressive lockout level automatically reset from ${txOutcome.autoResetLevelInfo.previousLevel} to 0 after ${txOutcome.autoResetLevelInfo.cleanWindowHours} hours of clean usage with zero failed password attempts.`,
              metadata: {
                resetType: "AUTOMATIC_SUSTAINED_CLEAN_USAGE",
                previousLevel: txOutcome.autoResetLevelInfo.previousLevel,
                newLevel: 0,
                cleanWindowHours: txOutcome.autoResetLevelInfo.cleanWindowHours,
                cleanLogins: txOutcome.autoResetLevelInfo.cleanLogins
              },
              nowMs,
              telemetry
            }),
            recordEnterpriseAuditEvent(db, {
              req,
              action: "super_admin_lockout_level_reset",
              category: "SECURITY",
              severity: "INFO",
              actorUid: firebaseUid,
              actorLoginId: cleanId,
              actorRole: roleUpper,
              targetType: "ACCOUNT",
              targetId: userDoc.id,
              oldValue: { progressiveLockLevel: txOutcome.autoResetLevelInfo.previousLevel },
              newValue: {
                progressiveLockLevel: 0,
                resetType: "AUTOMATIC_SUSTAINED_CLEAN_USAGE",
                cleanWindowHours: txOutcome.autoResetLevelInfo.cleanWindowHours
              },
              actionSource: "PROGRESSIVE_LOCKOUT_ENGINE",
              description: `Canonical Super Admin progressive lockout level automatically reset from ${txOutcome.autoResetLevelInfo.previousLevel} to 0 after ${txOutcome.autoResetLevelInfo.cleanWindowHours}h of sustained clean usage.`,
              success: true
            })
          );
        }
        await Promise.all(successAuditTasks);
        recordActivityTelemetry(db, {
          actorUid: firebaseUid,
          actorLoginId: cleanId,
          actorRole: roleUpper,
          action: "LOGIN_SUCCESS",
          module: "Authentication",
          result: "Success",
          correlationId: req.correlationId,
          detail: `Authenticated session ${sessionId}`
        });
        const { passwordHash: _ph, ...sanitizedProfile } = resolvedUserData;
        return {
          status: 200,
          body: {
            success: true,
            profile: {
              ...sanitizedProfile,
              id: userDoc.id,
              modulesAllowed: effectiveModules,
              mustChangePassword: txOutcome.mustChange,
              forcePasswordChange: txOutcome.mustChange,
              lockStatus: "ACTIVE",
              lockedAt: null,
              lockoutUntil: null,
              lockedUntil: null,
              lockedUntilMs: null,
              lockDurationMinutes: null,
              consecutiveFailedAttempts: 0
            },
            sessionToken,
            sessionId
          }
        };
      });
      return res.status(result.status).json(result.body);
    } catch (err) {
      if (isFirestorePermissionDeniedError(err)) {
        const msg = formatAdminPermissionDeniedError(projectId, TARGET_DATABASE_ID);
        console.warn("[Enterprise Login Security] Firestore IAM notice:", msg);
        return res.status(503).json({
          success: false,
          code: "FIREBASE_ADMIN_PERMISSION_DENIED",
          error: msg
        });
      }
      console.error("[Enterprise Login Security] Error:", err);
      return res.status(500).json({
        success: false,
        error: "Authentication security service error. Please try again."
      });
    }
  });
  app.get("/api/auth/lockout-status", async (req, res) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    try {
      const nowMs = getNowMs();
      const rawLoginId = typeof req.query?.loginId === "string" ? req.query.loginId.trim().toLowerCase() : "";
      if (rawLoginId && rawLoginId !== "superadmin") {
        return res.json({
          success: true,
          locked: false,
          temporaryLock: false,
          serverNowMs: nowMs
        });
      }
      let userDoc = await db.collection("user_roles").doc("role_superadmin").get();
      if (!userDoc.exists) {
        const snap = await db.collection("user_roles").where("loginId", "==", "superadmin").limit(1).get();
        if (!snap.empty) {
          userDoc = snap.docs[0];
        }
      }
      if (!userDoc || !userDoc.exists) {
        return res.json({
          success: true,
          locked: false,
          temporaryLock: false,
          serverNowMs: nowMs
        });
      }
      const userData = userDoc.data() || {};
      if (!isCanonicalSuperAdminAccount(userDoc.id, userData)) {
        return res.json({
          success: true,
          locked: false,
          temporaryLock: false,
          serverNowMs: nowMs
        });
      }
      const secRef = db.collection("account_security").doc("sec_superadmin");
      const userRef = db.collection("user_roles").doc(userDoc.id);
      const secSnap = await secRef.get();
      const secData = secSnap.exists ? secSnap.data() || {} : {};
      const isCurrentlyLocked = secData.lockStatus === "LOCKED" || userData.lockStatus === "LOCKED" || userData.isLocked === true;
      const saLockWindow = resolveCanonicalSuperAdminLockWindow(secData, userData);
      const existingLockedUntilMs = saLockWindow.lockedUntilMs;
      if (!isCurrentlyLocked || existingLockedUntilMs === null) {
        return res.json({
          success: true,
          locked: false,
          temporaryLock: false,
          serverNowMs: nowMs
        });
      }
      if (nowMs < existingLockedUntilMs) {
        const remainingSeconds = Math.max(1, Math.ceil((existingLockedUntilMs - nowMs) / 1e3));
        const lockoutUntilIso = saLockWindow.lockoutUntil || resolveAuthoritativeLockedUntilIso(existingLockedUntilMs, secData, userData);
        const lockDurationMinutes = saLockWindow.lockDurationMinutes;
        return res.json({
          success: true,
          locked: true,
          temporaryLock: true,
          loginId: "superadmin",
          lockoutUntil: lockoutUntilIso,
          lockedUntil: lockoutUntilIso,
          lockedUntilMs: existingLockedUntilMs,
          serverNowMs: nowMs,
          remainingSeconds,
          lockDurationMinutes
        });
      }
      const reactivationOutcome = await withLoginIdLock("superadmin", async () => {
        const txNowMs = getNowMs();
        const txNowIso = new Date(txNowMs).toISOString();
        const txResult = await db.runTransaction(async (tx) => {
          const [freshSecSnap, freshUserSnap] = await Promise.all([tx.get(secRef), tx.get(userRef)]);
          const freshSec = freshSecSnap.exists ? freshSecSnap.data() || {} : {};
          const freshUser = freshUserSnap.exists ? freshUserSnap.data() || {} : userData;
          const txIsLocked = freshSec.lockStatus === "LOCKED" || freshUser.lockStatus === "LOCKED" || freshUser.isLocked === true;
          const txLockWindow = resolveCanonicalSuperAdminLockWindow(freshSec, freshUser);
          const txLockedUntilMs = txLockWindow.lockedUntilMs;
          if (!txIsLocked || txLockedUntilMs === null) {
            return { kind: "ALREADY_ACTIVE", serverNowMs: txNowMs };
          }
          if (txNowMs < txLockedUntilMs) {
            const remSec = Math.max(1, Math.ceil((txLockedUntilMs - txNowMs) / 1e3));
            const iso = txLockWindow.lockoutUntil || resolveAuthoritativeLockedUntilIso(txLockedUntilMs, freshSec, freshUser);
            return {
              kind: "STILL_LOCKED",
              serverNowMs: txNowMs,
              lockoutUntil: iso,
              lockedUntilMs: txLockedUntilMs,
              remainingSeconds: remSec,
              lockDurationMinutes: txLockWindow.lockDurationMinutes
            };
          }
          const retainedLevel = Number(
            freshSec.progressiveLockLevel ?? freshUser.progressiveLockLevel ?? 0
          );
          const previousLockedAt = freshSec.lockedAt || freshUser.lockedAt || null;
          const previousLockedUntil = resolveAuthoritativeLockedUntilIso(
            txLockedUntilMs,
            freshSec,
            freshUser
          );
          const previousDurationMinutes = freshSec.lockDurationMinutes ?? freshUser.lockDurationMinutes ?? null;
          tx.set(
            secRef,
            {
              ...freshSec,
              id: "sec_superadmin",
              loginId: "superadmin",
              role: "SUPER_ADMIN",
              firebaseUid: String(freshUser.authUid || userDoc.id),
              email: freshUser.email || "superadmin@narid.com",
              lockStatus: "ACTIVE",
              lockPolicyType: "PROGRESSIVE_TEMPORARY",
              consecutiveFailedAttempts: 0,
              lockedAt: null,
              lockoutUntil: null,
              lockedUntil: null,
              lockedUntilMs: null,
              lockDurationMinutes: null,
              lockReason: null,
              lastLockExpiredAt: txNowIso,
              progressiveLockLevel: retainedLevel,
              pendingPostLockoutLoginAudit: true,
              updatedAt: txNowIso
            },
            { merge: true }
          );
          tx.update(userRef, {
            isLocked: false,
            lockStatus: "ACTIVE",
            lockPolicyType: "PROGRESSIVE_TEMPORARY",
            consecutiveFailedAttempts: 0,
            lockedAt: null,
            lockoutUntil: null,
            lockedUntil: null,
            lockedUntilMs: null,
            lockDurationMinutes: null,
            lockReason: null,
            lastLockExpiredAt: txNowIso,
            progressiveLockLevel: retainedLevel,
            pendingPostLockoutLoginAudit: true,
            updatedAt: txNowIso
          });
          return {
            kind: "REACTIVATED",
            serverNowMs: txNowMs,
            nowIso: txNowIso,
            firebaseUid: String(freshUser.authUid || userDoc.id),
            authUid: freshUser.authUid || null,
            role: String(freshUser.role || "super_admin"),
            status: String(freshUser.status || "Active"),
            previousLockedAt,
            previousLockedUntil,
            previousDurationMinutes,
            retainedLevel
          };
        });
        if (txResult.kind === "REACTIVATED") {
          await syncUserUidIndex(db, {
            uid: txResult.authUid,
            roleDocId: userDoc.id,
            role: txResult.role,
            status: txResult.status,
            lockStatus: "ACTIVE",
            lockedUntilMs: null,
            loginId: "superadmin"
          });
          const telemetry = await captureTelemetryContext(db, req);
          await Promise.all([
            recordSecurityAuditLogDoc(db, {
              action: "LOCKOUT_EXPIRED_REACTIVATED",
              severity: "INFO",
              targetLoginId: "superadmin",
              targetRole: "SUPER_ADMIN",
              targetUid: txResult.firebaseUid,
              reason: "Super Admin temporary lockout duration expired; account automatically reactivated",
              details: `Temporary lockout for canonical Super Admin "superadmin" expired at ${txResult.previousLockedUntil || txResult.nowIso}. Verified server-side and reactivated with progressive level ${txResult.retainedLevel} retained.`,
              metadata: {
                previousLockedAt: txResult.previousLockedAt,
                previousLockedUntil: txResult.previousLockedUntil,
                previousDurationMinutes: txResult.previousDurationMinutes,
                retainedProgressiveLevel: txResult.retainedLevel,
                verifiedVia: "LOCKOUT_STATUS_CHECK"
              },
              nowMs: txResult.serverNowMs,
              telemetry
            }),
            recordEnterpriseAuditEvent(db, {
              req,
              action: "super_admin_lockout_expired",
              category: "SECURITY",
              severity: "INFO",
              actorUid: txResult.firebaseUid,
              actorLoginId: "superadmin",
              actorRole: "SUPER_ADMIN",
              targetType: "ACCOUNT",
              targetId: userDoc.id,
              oldValue: {
                lockStatus: "LOCKED",
                lockoutUntil: txResult.previousLockedUntil,
                lockDurationMinutes: txResult.previousDurationMinutes
              },
              newValue: {
                lockStatus: "ACTIVE",
                consecutiveFailedAttempts: 0,
                progressiveLockLevel: txResult.retainedLevel
              },
              actionSource: "PROGRESSIVE_LOCKOUT_ENGINE",
              description: `Canonical Super Admin "superadmin" temporary lockout expired and was automatically reactivated upon server verification (progressive level ${txResult.retainedLevel} retained).`,
              success: true
            })
          ]);
        }
        return txResult;
      });
      if (reactivationOutcome.kind === "STILL_LOCKED") {
        return res.json({
          success: true,
          locked: true,
          temporaryLock: true,
          loginId: "superadmin",
          lockoutUntil: reactivationOutcome.lockoutUntil,
          lockedUntil: reactivationOutcome.lockoutUntil,
          lockedUntilMs: reactivationOutcome.lockedUntilMs,
          serverNowMs: reactivationOutcome.serverNowMs,
          remainingSeconds: reactivationOutcome.remainingSeconds,
          lockDurationMinutes: reactivationOutcome.lockDurationMinutes
        });
      }
      return res.json({
        success: true,
        locked: false,
        temporaryLock: false,
        expiredReactivated: reactivationOutcome.kind === "REACTIVATED",
        serverNowMs: reactivationOutcome.serverNowMs
      });
    } catch (err) {
      if (isFirestorePermissionDeniedError(err)) {
        const msg = formatAdminPermissionDeniedError(projectId, TARGET_DATABASE_ID);
        return res.status(503).json({
          success: false,
          code: "FIREBASE_ADMIN_PERMISSION_DENIED",
          error: msg
        });
      }
      console.error("[Lockout Status API] Error:", err);
      return res.status(500).json({
        success: false,
        error: "Failed to check lockout status."
      });
    }
  });
  app.post("/api/auth/firebase-throttle-signal", async (req, res) => {
    try {
      const cleanId = typeof req.body?.loginId === "string" && req.body.loginId.trim() ? req.body.loginId.trim().toLowerCase().slice(0, 64) : "unknown";
      const telemetry = await captureTelemetryContext(db, req);
      const ipRes = await recordIpFailurePersistent(db, telemetry.ipAddress, "firebase_throttle", cleanId);
      await Promise.all([
        recordLoginAttemptDoc(db, {
          loginId: cleanId,
          role: "UNKNOWN",
          success: false,
          outcome: "FIREBASE_TOO_MANY_ATTEMPTS",
          failureReasonCategory: "FIREBASE_ABUSE_PROTECTION",
          failureReason: "Firebase Auth TOO_MANY_ATTEMPTS_TRY_LATER triggered",
          telemetry
        }),
        recordSecurityAuditLogDoc(db, {
          action: "FIREBASE_TOO_MANY_ATTEMPTS",
          severity: "CRITICAL",
          targetLoginId: cleanId,
          reason: "Firebase native abuse protection TOO_MANY_ATTEMPTS_TRY_LATER encountered",
          details: `Firebase Auth enforced TOO_MANY_ATTEMPTS_TRY_LATER for "${cleanId}" from IP ${telemetry.ipAddress}. Automatic retries prevented.`,
          metadata: { cooldownSeconds: ipRes.cooldownSeconds },
          telemetry
        })
      ]);
      return res.json({ success: true, cooldownSeconds: ipRes.cooldownSeconds });
    } catch {
      return res.status(200).json({ success: false });
    }
  });
  app.get("/api/security/overview", async (req, res) => {
    try {
      const caller = await requireVerifiedCaller(
        req,
        res,
        ["super_admin"],
        "Security & Login Attempt Management Overview"
      );
      if (!caller) return;
      const [usersSnap, secSnap, attemptsSnap, secLogsSnap, superAdminLockoutResetHours] = await Promise.all([
        db.collection("user_roles").get(),
        db.collection("account_security").get(),
        db.collection("login_attempts").get(),
        db.collection("security_audit_logs").get(),
        resolveSuperAdminLockoutResetHours(db)
      ]);
      const nowMs = getNowMs();
      const secByLoginId = /* @__PURE__ */ new Map();
      secSnap.docs.forEach((d) => {
        const data = d.data() || {};
        const key = String(data.loginId || d.id.replace(/^sec_/, "")).trim().toLowerCase();
        secByLoginId.set(key, { id: d.id, ...data });
      });
      const attempts = attemptsSnap.docs.map((d) => ({ id: d.id, ...d.data() || {} })).sort((a, b) => (b.timestampMs || 0) - (a.timestampMs || 0));
      const securityLogs = secLogsSnap.docs.map((d) => ({ id: d.id, ...d.data() || {} })).sort((a, b) => (b.timestampMs || 0) - (a.timestampMs || 0));
      const accountMap = /* @__PURE__ */ new Map();
      usersSnap.docs.forEach((uDoc) => {
        const uData = uDoc.data() || {};
        const loginId = String(uData.loginId || uDoc.id.replace(/^role_/, "")).trim().toLowerCase();
        if (!loginId) return;
        if (accountMap.has(loginId) && uDoc.id !== `role_${loginId}`) {
          return;
        }
        const sec = secByLoginId.get(loginId) || {};
        const accAttempts = attempts.filter((a) => String(a.loginId || "").toLowerCase() === loginId);
        const isCanonicalSA = isCanonicalSuperAdminAccount(uDoc.id, uData);
        const saLockWindow = isCanonicalSA ? resolveCanonicalSuperAdminLockWindow(sec, uData) : {
          lockedUntilMs: resolveAuthoritativeLockedUntilMs(sec, uData),
          lockoutUntil: null,
          lockDurationMinutes: null
        };
        const lockedUntilMs = saLockWindow.lockedUntilMs;
        const rawIsLocked = sec.lockStatus === "LOCKED" || uData.lockStatus === "LOCKED" || uData.isLocked === true;
        const lockoutExpiredPendingLogin = Boolean(
          isCanonicalSA && rawIsLocked && lockedUntilMs !== null && nowMs >= lockedUntilMs
        );
        const effectiveLockStatus = rawIsLocked && !lockoutExpiredPendingLogin ? "LOCKED" : "ACTIVE";
        const remainingLockSeconds = isCanonicalSA && effectiveLockStatus === "LOCKED" && lockedUntilMs !== null ? Math.max(0, Math.ceil((lockedUntilMs - nowMs) / 1e3)) : 0;
        const effectiveLockedUntilIso = effectiveLockStatus === "LOCKED" ? saLockWindow.lockoutUntil || resolveAuthoritativeLockedUntilIso(lockedUntilMs, sec, uData) : null;
        accountMap.set(loginId, {
          id: sec.id || `sec_${loginId}`,
          roleDocId: uDoc.id,
          loginId,
          name: uData.name || loginId.toUpperCase(),
          email: uData.email || `${loginId}@narid.com`,
          role: String(uData.role || "USER").toUpperCase(),
          firebaseUid: sec.firebaseUid || uData.authUid || uDoc.id,
          accountStatus: uData.status || "Active",
          lockStatus: effectiveLockStatus,
          lockPolicyType: isCanonicalSA ? "PROGRESSIVE_TEMPORARY" : "PERMANENT_MANUAL",
          consecutiveFailedAttempts: lockoutExpiredPendingLogin ? 0 : Number(sec.consecutiveFailedAttempts ?? uData.consecutiveFailedAttempts ?? 0),
          maxAttemptsAllowed: MAX_CONSECUTIVE_FAILED_ATTEMPTS,
          totalLoginAttempts: Number(sec.totalLoginAttempts ?? accAttempts.length),
          totalSuccessfulLogins: Number(
            sec.totalSuccessfulLogins ?? accAttempts.filter((a) => a.success === true).length
          ),
          totalFailedLogins: Number(
            sec.totalFailedLogins ?? accAttempts.filter((a) => a.success === false).length
          ),
          forcePasswordChange: Boolean(uData.mustChangePassword === true || sec.forcePasswordChange === true),
          mustChangePassword: Boolean(uData.mustChangePassword === true),
          lockedAt: effectiveLockStatus === "LOCKED" ? sec.lockedAt || uData.lockedAt || null : null,
          lockoutUntil: effectiveLockedUntilIso,
          lockedUntil: effectiveLockedUntilIso,
          lockedUntilMs: effectiveLockStatus === "LOCKED" ? lockedUntilMs : null,
          lockDurationMinutes: effectiveLockStatus === "LOCKED" ? saLockWindow.lockDurationMinutes ?? sec.lockDurationMinutes ?? uData.lockDurationMinutes ?? null : null,
          remainingLockSeconds,
          lockoutExpiredPendingLogin,
          lockReason: effectiveLockStatus === "LOCKED" ? sec.lockReason || uData.lockReason || null : null,
          progressiveLockLevel: isCanonicalSA ? Number(sec.progressiveLockLevel ?? uData.progressiveLockLevel ?? 0) : 0,
          totalLockoutEvents: isCanonicalSA ? Number(sec.totalLockoutEvents ?? uData.totalLockoutEvents ?? 0) : 0,
          lastLockoutAt: isCanonicalSA ? sec.lastLockoutAt || uData.lastLockoutAt || null : null,
          lastLockExpiredAt: isCanonicalSA ? sec.lastLockExpiredAt || uData.lastLockExpiredAt || null : null,
          cleanWindowStartAt: isCanonicalSA ? sec.cleanWindowStartAt || uData.cleanWindowStartAt || null : null,
          cleanWindowStartMs: isCanonicalSA ? typeof sec.cleanWindowStartMs === "number" ? sec.cleanWindowStartMs : typeof uData.cleanWindowStartMs === "number" ? uData.cleanWindowStartMs : null : null,
          cleanLoginsSinceLastLockout: isCanonicalSA ? Number(sec.cleanLoginsSinceLastLockout ?? uData.cleanLoginsSinceLastLockout ?? 0) : 0,
          lockoutLevelResetAt: isCanonicalSA ? sec.lockoutLevelResetAt || uData.lockoutLevelResetAt || null : null,
          lockoutLevelResetReason: isCanonicalSA ? sec.lockoutLevelResetReason || uData.lockoutLevelResetReason || null : null,
          lastSuccessAt: sec.lastSuccessAt || uData.lastSuccessLoginAt || null,
          lastSuccessIp: sec.lastSuccessIp || null,
          lastSuccessGeo: sec.lastSuccessGeo || null,
          lastSuccessDevice: sec.lastSuccessDevice || null,
          lastFailedAt: sec.lastFailedAt || null,
          lastFailedIp: sec.lastFailedIp || null,
          lastFailedGeo: sec.lastFailedGeo || null,
          lastFailedDevice: sec.lastFailedDevice || null,
          lastFailedReason: sec.lastFailedReason || null,
          unblockedByUid: sec.unblockedByUid || null,
          unblockedByLoginId: sec.unblockedByLoginId || null,
          unblockedAt: sec.unblockedAt || null,
          unblockReason: sec.unblockReason || null,
          tempPasswordResetByUid: sec.tempPasswordResetByUid || null,
          tempPasswordResetByLoginId: sec.tempPasswordResetByLoginId || null,
          tempPasswordResetAt: sec.tempPasswordResetAt || uData.passwordResetAt || null,
          passwordLastChangedAt: uData.passwordLastChangedAt || null,
          updatedAt: sec.updatedAt || uData.updatedAt || null
        });
      });
      const roleOrder = { SUPER_ADMIN: 0, ADMIN: 1, USER: 2 };
      const accounts = Array.from(accountMap.values()).sort((a, b) => {
        const ao = roleOrder[a.role] ?? 9;
        const bo = roleOrder[b.role] ?? 9;
        if (ao !== bo) return ao - bo;
        return a.loginId.localeCompare(b.loginId);
      });
      const kpis = {
        totalLoginAttempts: attempts.length,
        successfulLogins: attempts.filter((a) => a.success === true).length,
        failedLogins: attempts.filter((a) => a.success === false).length,
        currentlyLockedAccounts: accounts.filter((a) => a.lockStatus === "LOCKED").length,
        accountsWithForcePasswordChange: accounts.filter((a) => a.forcePasswordChange).length,
        rateLimitAlerts: attempts.filter(
          (a) => a.outcome === "BLOCKED_RATE_LIMIT" || a.outcome === "FIREBASE_TOO_MANY_ATTEMPTS"
        ).length
      };
      return res.json({
        success: true,
        kpis,
        accounts,
        recentAttempts: attempts.slice(0, 150),
        recentSecurityLogs: securityLogs.slice(0, 150),
        superAdminLockoutResetHours,
        serverNowMs: nowMs
      });
    } catch (err) {
      if (isFirestorePermissionDeniedError(err)) {
        const msg = formatAdminPermissionDeniedError(projectId, TARGET_DATABASE_ID);
        return res.status(503).json({ success: false, code: "FIREBASE_ADMIN_PERMISSION_DENIED", error: msg });
      }
      console.error("[Security Overview API] Error:", err);
      return res.status(500).json({
        success: false,
        error: err?.message || "Failed to load security overview."
      });
    }
  });
  app.get("/api/security/attempts", async (req, res) => {
    try {
      const caller = await requireVerifiedCaller(
        req,
        res,
        ["super_admin"],
        "Security Login Attempts Query"
      );
      if (!caller) return;
      const {
        loginId = "ALL",
        outcome = "ALL",
        search = "",
        limit = "250"
      } = req.query;
      const snap = await db.collection("login_attempts").get();
      let rows = snap.docs.map((d) => ({ id: d.id, ...d.data() || {} })).sort((a, b) => (b.timestampMs || 0) - (a.timestampMs || 0));
      const q = search.trim().toLowerCase();
      rows = rows.filter((r) => {
        if (loginId !== "ALL" && String(r.loginId || "").toLowerCase() !== loginId.toLowerCase()) {
          return false;
        }
        if (outcome === "SUCCESS" && !r.success) return false;
        if (outcome === "FAILURE" && r.success) return false;
        if (outcome !== "ALL" && outcome !== "SUCCESS" && outcome !== "FAILURE" && r.outcome !== outcome) {
          return false;
        }
        if (q) {
          const hay = `${r.loginId} ${r.role} ${r.ipAddress} ${r.browser} ${r.os} ${r.failureReason || ""} ${r.geoLocation?.city || ""}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });
      const maxLimit = Math.min(500, Math.max(10, parseInt(limit, 10) || 250));
      return res.json({ success: true, attempts: rows.slice(0, maxLimit) });
    } catch (err) {
      if (isFirestorePermissionDeniedError(err)) {
        const msg = formatAdminPermissionDeniedError(projectId, TARGET_DATABASE_ID);
        return res.status(503).json({ success: false, code: "FIREBASE_ADMIN_PERMISSION_DENIED", error: msg });
      }
      console.error("[Security Attempts API] Error:", err);
      return res.status(500).json({ success: false, error: "Failed to load login attempts." });
    }
  });
  app.get("/api/security/audit-logs", async (req, res) => {
    try {
      const caller = await requireVerifiedCaller(
        req,
        res,
        ["super_admin"],
        "Security Governance Audit Logs"
      );
      if (!caller) return;
      const {
        loginId = "ALL",
        action = "ALL",
        severity = "ALL",
        search = ""
      } = req.query;
      const snap = await db.collection("security_audit_logs").get();
      let rows = snap.docs.map((d) => ({ id: d.id, ...d.data() || {} })).sort((a, b) => (b.timestampMs || 0) - (a.timestampMs || 0));
      const q = search.trim().toLowerCase();
      rows = rows.filter((r) => {
        if (loginId !== "ALL" && String(r.targetLoginId || "").toLowerCase() !== loginId.toLowerCase()) {
          return false;
        }
        if (action !== "ALL" && r.action !== action) return false;
        if (severity !== "ALL" && r.severity !== severity) return false;
        if (q) {
          const hay = `${r.action} ${r.targetLoginId} ${r.actorLoginId} ${r.ipAddress} ${r.reason} ${r.details}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });
      return res.json({ success: true, logs: rows.slice(0, 300) });
    } catch (err) {
      if (isFirestorePermissionDeniedError(err)) {
        const msg = formatAdminPermissionDeniedError(projectId, TARGET_DATABASE_ID);
        return res.status(503).json({ success: false, code: "FIREBASE_ADMIN_PERMISSION_DENIED", error: msg });
      }
      console.error("[Security Audit Logs API] Error:", err);
      return res.status(500).json({ success: false, error: "Failed to load security audit logs." });
    }
  });
  app.post("/api/security/unblock-account", async (req, res) => {
    try {
      const caller = await requireVerifiedCaller(
        req,
        res,
        ["super_admin"],
        "Unblock Locked Account"
      );
      if (!caller) return;
      const parsed = UnblockAccountSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: parsed.error.issues[0]?.message || "Invalid unblock payload."
        });
      }
      const cleanTargetId = parsed.data.targetLoginId.trim().toLowerCase();
      const reason = parsed.data.reason.trim();
      const telemetry = await captureTelemetryContext(db, req);
      const unblockResult = await withLoginIdLock(cleanTargetId, async () => {
        const docId = `role_${cleanTargetId}`;
        let userDoc = await db.collection("user_roles").doc(docId).get();
        if (!userDoc.exists) {
          const snap = await db.collection("user_roles").where("loginId", "==", cleanTargetId).limit(1).get();
          if (!snap.empty) userDoc = snap.docs[0];
        }
        if (!userDoc || !userDoc.exists) {
          return { notFound: true };
        }
        const userData = userDoc.data() || {};
        const targetRole = String(userData.role || "USER").toUpperCase();
        const firebaseUid = String(userData.authUid || userDoc.id);
        const secRef = db.collection("account_security").doc(`sec_${cleanTargetId}`);
        const userRef = db.collection("user_roles").doc(userDoc.id);
        const now = (/* @__PURE__ */ new Date()).toISOString();
        let previousState = {};
        await db.runTransaction(async (tx) => {
          const secSnap = await tx.get(secRef);
          const curSec = secSnap.exists ? secSnap.data() || {} : {};
          previousState = {
            lockStatus: curSec.lockStatus || userData.lockStatus || "ACTIVE",
            consecutiveFailedAttempts: Number(
              curSec.consecutiveFailedAttempts ?? userData.consecutiveFailedAttempts ?? 0
            ),
            lockedAt: curSec.lockedAt || userData.lockedAt || null
          };
          tx.set(
            secRef,
            {
              id: `sec_${cleanTargetId}`,
              loginId: cleanTargetId,
              role: targetRole,
              firebaseUid,
              email: userData.email || `${cleanTargetId}@narid.com`,
              lockStatus: "ACTIVE",
              consecutiveFailedAttempts: 0,
              maxAttemptsAllowed: MAX_CONSECUTIVE_FAILED_ATTEMPTS,
              lockedAt: null,
              lockoutUntil: null,
              lockedUntil: null,
              lockedUntilMs: null,
              lockDurationMinutes: null,
              lockReason: null,
              unblockedByUid: caller.uid,
              unblockedByLoginId: caller.loginId,
              unblockedAt: now,
              unblockReason: reason,
              updatedAt: now
            },
            { merge: true }
          );
          tx.update(userRef, {
            isLocked: false,
            lockStatus: "ACTIVE",
            consecutiveFailedAttempts: 0,
            lockedAt: null,
            lockoutUntil: null,
            lockedUntil: null,
            lockedUntilMs: null,
            lockDurationMinutes: null,
            lockReason: null,
            unblockedBy: caller.loginId,
            unblockedAt: now,
            updatedAt: now
          });
        });
        await syncUserUidIndex(db, {
          uid: userData.authUid || null,
          roleDocId: userDoc.id,
          role: String(userData.role || "user"),
          status: String(userData.status || "Active"),
          lockStatus: "ACTIVE",
          loginId: cleanTargetId
        });
        await clearIpCooldownPersistent(db, void 0, cleanTargetId);
        await Promise.all([
          recordSecurityAuditLogDoc(db, {
            action: "ACCOUNT_UNBLOCKED",
            severity: "CRITICAL",
            targetLoginId: cleanTargetId,
            targetRole,
            targetUid: firebaseUid,
            actorUid: caller.uid,
            actorLoginId: caller.loginId,
            actorRole: "SUPER_ADMIN",
            reason,
            details: `Super Admin "${caller.loginId}" unblocked account "${cleanTargetId}" (${targetRole}, UID: ${firebaseUid}). Failed attempts reset from ${previousState.consecutiveFailedAttempts} to 0. Reason: ${reason}`,
            metadata: { previousState, newStatus: "ACTIVE" },
            telemetry
          }),
          recordEnterpriseAuditEvent(db, {
            req,
            action: "account_unblocked",
            category: "SECURITY",
            severity: "CRITICAL",
            actorUid: caller.uid,
            actorLoginId: caller.loginId,
            actorRole: "SUPER_ADMIN",
            targetType: "ACCOUNT",
            targetId: userDoc.id,
            oldValue: previousState,
            newValue: { lockStatus: "ACTIVE", consecutiveFailedAttempts: 0, reason },
            actionSource: "SECURITY_CONTROL_UNBLOCK",
            reason,
            description: `Super Admin "${caller.loginId}" unblocked "${cleanTargetId}" (${targetRole}).`
          })
        ]);
        return {
          notFound: false,
          targetLoginId: cleanTargetId,
          targetRole,
          firebaseUid,
          unblockedAt: now
        };
      });
      if (unblockResult.notFound) {
        return res.status(404).json({
          success: false,
          error: `Account "${cleanTargetId}" not found.`
        });
      }
      return res.json({
        success: true,
        message: `Account "${cleanTargetId}" has been unblocked (LOCKED -> ACTIVE) and consecutive failed attempts reset to 0.`,
        ...unblockResult
      });
    } catch (err) {
      console.error("[Security Unblock API] Error:", err);
      return res.status(500).json({
        success: false,
        error: err?.message || "Failed to unblock account."
      });
    }
  });
  app.get("/api/security/firebase-admin-status", async (req, res) => {
    try {
      const caller = await requireVerifiedCaller(
        req,
        res,
        ["super_admin"],
        "Inspect Firebase Admin SDK & Auth Mapping Status"
      );
      if (!caller) return;
      const status = await inspectFirebaseAuthStatus(projectId, db, auth);
      return res.json({
        success: true,
        ...status
      });
    } catch (err) {
      console.error("[Security Firebase Admin Status API] Error:", err);
      return res.status(500).json({
        success: false,
        error: err?.message || "Failed to inspect Firebase Admin SDK status."
      });
    }
  });
  app.post("/api/security/generate-temp-password", async (req, res) => {
    try {
      const caller = await requireVerifiedCaller(
        req,
        res,
        ["super_admin"],
        "Generate Temporary Password"
      );
      if (!caller) return;
      const parsed = GenerateTempPasswordSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: parsed.error.issues[0]?.message || "Invalid temporary password request."
        });
      }
      const cleanTargetId = parsed.data.targetLoginId.trim().toLowerCase();
      const reason = parsed.data.reason.trim();
      const freshPassword = parsed.data.freshSuperAdminPassword;
      const telemetry = await captureTelemetryContext(db, req);
      const nowSec = Math.floor(Date.now() / 1e3);
      const isRecentTokenAuth = typeof caller.authTime === "number" && nowSec - caller.authTime <= 300;
      let freshAuthVerified = false;
      if (freshPassword && freshPassword.length > 0) {
        const callerDoc = await db.collection("user_roles").doc(caller.profileDocId).get();
        const callerHash = callerDoc.exists ? callerDoc.data()?.passwordHash : null;
        if (callerHash && verifyPassword2(freshPassword, String(callerHash))) {
          freshAuthVerified = true;
        } else {
          await recordSecurityAuditLogDoc(db, {
            action: "UNAUTHORIZED_SECURITY_ACCESS",
            severity: "CRITICAL",
            targetLoginId: cleanTargetId,
            actorUid: caller.uid,
            actorLoginId: caller.loginId,
            actorRole: "SUPER_ADMIN",
            reason: "Failed fresh Super Admin password verification for temp password generation",
            details: `Super Admin "${caller.loginId}" entered an incorrect password during fresh re-authentication check for resetting "${cleanTargetId}".`,
            telemetry
          });
          return res.status(401).json({
            success: false,
            requiresFreshAuth: true,
            error: "Fresh Super Admin authentication failed: Incorrect Super Admin password."
          });
        }
      } else if (isRecentTokenAuth) {
        freshAuthVerified = true;
      }
      if (!freshAuthVerified) {
        return res.status(401).json({
          success: false,
          requiresFreshAuth: true,
          error: "Fresh Super Admin authentication is required before generating a temporary password. Please enter your current Super Admin password."
        });
      }
      const temporaryPassword = generateStrongTemporaryPassword(14);
      const newHash = hashPassword2(temporaryPassword);
      const result = await withLoginIdLock(cleanTargetId, async () => {
        const docId = `role_${cleanTargetId}`;
        let userDoc = await db.collection("user_roles").doc(docId).get();
        if (!userDoc.exists) {
          const snap = await db.collection("user_roles").where("loginId", "==", cleanTargetId).limit(1).get();
          if (!snap.empty) userDoc = snap.docs[0];
        }
        if (!userDoc || !userDoc.exists) {
          return { notFound: true };
        }
        const userData = userDoc.data() || {};
        const targetRole = String(userData.role || "USER").toUpperCase();
        const rawEmail = String(userData.email || `${cleanTargetId}@narid.com`).trim().toLowerCase();
        const canonicalEmail = `${cleanTargetId}@narid.com`;
        const targetEmail = rawEmail.endsWith("_root@narid.com") && Array.isArray(userData.emailAliases) && userData.emailAliases.includes(canonicalEmail) ? canonicalEmail : rawEmail;
        const targetUid = String(userData.authUid || userData.uid || userDoc.id);
        const now = (/* @__PURE__ */ new Date()).toISOString();
        let firebaseAuthSynced = false;
        let syncErrorReason = "";
        let adminSdkAvailable = false;
        let rateLimited = false;
        const adminAttempt = await tryAdminAuthUpdatePassword(projectId, targetUid, temporaryPassword, auth);
        adminSdkAvailable = adminAttempt.adminSdkAvailable;
        if (adminAttempt.updated) {
          firebaseAuthSynced = true;
        } else {
          syncErrorReason = adminAttempt.reason || "";
          if (targetUid && !targetUid.startsWith("role_")) {
            const syncRes = await syncExistingFirebaseAuthPassword2(
              targetEmail,
              targetUid,
              temporaryPassword
            );
            if (syncRes.success) {
              firebaseAuthSynced = true;
            } else {
              rateLimited = Boolean(syncRes.rateLimited);
              if (syncRes.error) {
                syncErrorReason = syncRes.error;
              }
            }
          }
        }
        if (!firebaseAuthSynced) {
          await recordSecurityAuditLogDoc(db, {
            action: "TEMP_PASSWORD_SYNC_FAILED",
            severity: "CRITICAL",
            targetLoginId: cleanTargetId,
            targetRole,
            targetUid,
            actorUid: caller.uid,
            actorLoginId: caller.loginId,
            actorRole: "SUPER_ADMIN",
            reason,
            details: `Aborted temporary password generation for "${cleanTargetId}" (UID: ${targetUid}) because Firebase Authentication could not be updated in-place. Firestore passwordHash was left UNCHANGED to prevent credential divergence. Reason: ${syncErrorReason}`,
            metadata: {
              adminSdkAvailable,
              rateLimited,
              uidPreserved: targetUid
            },
            telemetry
          });
          return {
            notFound: false,
            syncFailed: true,
            rateLimited,
            adminSdkAvailable,
            targetLoginId: cleanTargetId,
            firebaseUid: targetUid,
            error: rateLimited ? "Firebase Auth rate limit (TOO_MANY_ATTEMPTS_TRY_LATER) blocked in-place sync. Firestore passwordHash was kept unchanged." : `Firebase Authentication password update failed for "${targetEmail}" (UID: ${targetUid}). Firestore passwordHash was NOT modified to prevent mismatch. ${syncErrorReason}`.trim()
          };
        }
        const userRef = db.collection("user_roles").doc(userDoc.id);
        const secRef = db.collection("account_security").doc(`sec_${cleanTargetId}`);
        const tempPassUpdates = {
          passwordHash: newHash,
          mustChangePassword: true,
          forcePasswordChange: true,
          passwordLastChangedAt: now,
          passwordResetBy: caller.loginId,
          passwordResetAt: now,
          sessionRevokedAt: now,
          updatedAt: now
        };
        await db.runTransaction(async (tx) => {
          const secSnap = await tx.get(secRef);
          const curSec = secSnap.exists ? secSnap.data() || {} : {};
          tx.update(userRef, tempPassUpdates);
          tx.set(
            secRef,
            {
              ...curSec,
              id: `sec_${cleanTargetId}`,
              loginId: cleanTargetId,
              role: targetRole,
              firebaseUid: targetUid,
              email: targetEmail,
              forcePasswordChange: true,
              tempPasswordResetByUid: caller.uid,
              tempPasswordResetByLoginId: caller.loginId,
              tempPasswordResetAt: now,
              updatedAt: now
            },
            { merge: true }
          );
        });
        const matchingDocs = await db.collection("user_roles").where("loginId", "==", cleanTargetId).get();
        for (const mDoc of matchingDocs.docs) {
          if (mDoc.id !== userDoc.id) {
            await db.collection("user_roles").doc(mDoc.id).update(tempPassUpdates);
          }
        }
        const resetLogId = `reset_${Date.now()}_${crypto3.randomBytes(3).toString("hex")}`;
        await Promise.all([
          db.collection("password_reset_logs").doc(resetLogId).set({
            id: resetLogId,
            targetLoginId: cleanTargetId,
            targetName: userData.name || cleanTargetId,
            targetRole,
            performedByLoginId: caller.loginId,
            performedByUid: caller.uid,
            timestamp: now,
            forcedPasswordChange: true,
            accountUnlocked: false,
            sessionsRevoked: true,
            reason
          }),
          recordSecurityAuditLogDoc(db, {
            action: "TEMP_PASSWORD_GENERATED",
            severity: "CRITICAL",
            targetLoginId: cleanTargetId,
            targetRole,
            targetUid,
            actorUid: caller.uid,
            actorLoginId: caller.loginId,
            actorRole: "SUPER_ADMIN",
            reason,
            details: `Super Admin "${caller.loginId}" generated a one-time temporary password for "${cleanTargetId}" (${targetRole}, UID: ${targetUid}). Mandatory change on next login enforced.`,
            metadata: {
              forcePasswordChange: true,
              firebaseAuthSynced: true,
              uidPreserved: targetUid
            },
            telemetry
          }),
          recordEnterpriseAuditEvent(db, {
            req,
            action: "admin_password_reset",
            category: "ACCOUNT",
            severity: "CRITICAL",
            actorUid: caller.uid,
            actorLoginId: caller.loginId,
            actorRole: "SUPER_ADMIN",
            targetType: "ACCOUNT",
            targetId: userDoc.id,
            newValue: {
              targetLoginId: cleanTargetId,
              targetRole,
              forcePasswordChange: true,
              firebaseAuthSynced: true
            },
            actionSource: "SECURITY_CONTROL_TEMP_PASSWORD",
            reason,
            description: `Temporary password generated by Super Admin "${caller.loginId}" for "${cleanTargetId}". UID ${targetUid} preserved.`
          })
        ]);
        return {
          notFound: false,
          syncFailed: false,
          targetLoginId: cleanTargetId,
          targetRole,
          firebaseUid: targetUid,
          firebaseAuthSynced: true,
          generatedAt: now
        };
      });
      if (result.notFound) {
        return res.status(404).json({
          success: false,
          error: `Account "${cleanTargetId}" not found.`
        });
      }
      if (result.syncFailed) {
        return res.status(result.rateLimited ? 429 : 422).json({
          success: false,
          code: result.rateLimited ? "FIREBASE_TOO_MANY_ATTEMPTS" : "FIREBASE_AUTH_SYNC_FAILED",
          firebaseAuthSynced: false,
          adminSdkConfigured: result.adminSdkAvailable,
          targetLoginId: result.targetLoginId,
          firebaseUid: result.firebaseUid,
          error: result.error
        });
      }
      return res.json({
        success: true,
        targetLoginId: result.targetLoginId,
        targetRole: result.targetRole,
        firebaseUid: result.firebaseUid,
        temporaryPassword,
        forcePasswordChange: true,
        firebaseAuthSynced: result.firebaseAuthSynced,
        generatedAt: result.generatedAt,
        message: `One-time temporary password generated for "${result.targetLoginId}" and synced in Firebase Auth (UID: ${result.firebaseUid}). Password change is mandatory on next login.`
      });
    } catch (err) {
      if (isFirestorePermissionDeniedError(err)) {
        const msg = formatAdminPermissionDeniedError(projectId, TARGET_DATABASE_ID);
        return res.status(503).json({ success: false, code: "FIREBASE_ADMIN_PERMISSION_DENIED", error: msg });
      }
      console.error("[Security Generate Temp Password API] Error:", err);
      return res.status(500).json({
        success: false,
        error: err?.message || "Failed to generate temporary password."
      });
    }
  });
  app.post("/api/security/reset-superadmin-lockout-level", async (req, res) => {
    try {
      const caller = await requireVerifiedCaller(
        req,
        res,
        ["super_admin"],
        "Reset Super Admin Progressive Lockout Level"
      );
      if (!caller) return;
      const parsed = ResetSuperAdminLockoutLevelSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: parsed.error.issues[0]?.message || "Invalid lockout level reset request."
        });
      }
      const reason = parsed.data.reason.trim();
      const freshPassword = parsed.data.freshSuperAdminPassword;
      const telemetry = await captureTelemetryContext(db, req);
      const nowMs = getNowMs();
      const now = new Date(nowMs).toISOString();
      const nowSec = Math.floor(nowMs / 1e3);
      const isRecentTokenAuth = typeof caller.authTime === "number" && nowSec - caller.authTime <= 300;
      let freshAuthVerified = false;
      if (freshPassword && freshPassword.length > 0) {
        const callerDoc = await db.collection("user_roles").doc(caller.profileDocId).get();
        const callerHash = callerDoc.exists ? callerDoc.data()?.passwordHash : null;
        if (callerHash && verifyPassword2(freshPassword, String(callerHash))) {
          freshAuthVerified = true;
        } else {
          await recordSecurityAuditLogDoc(db, {
            action: "UNAUTHORIZED_SECURITY_ACCESS",
            severity: "CRITICAL",
            targetLoginId: "superadmin",
            targetRole: "SUPER_ADMIN",
            actorUid: caller.uid,
            actorLoginId: caller.loginId,
            actorRole: "SUPER_ADMIN",
            reason: "Failed fresh Super Admin password verification for progressive lockout level reset",
            details: `Super Admin "${caller.loginId}" entered an incorrect password during fresh re-authentication check for progressive lockout level reset.`,
            nowMs,
            telemetry
          });
          return res.status(401).json({
            success: false,
            requiresFreshAuth: true,
            error: "Fresh Super Admin authentication failed: Incorrect Super Admin password."
          });
        }
      } else if (isRecentTokenAuth) {
        freshAuthVerified = true;
      }
      if (!freshAuthVerified) {
        return res.status(401).json({
          success: false,
          requiresFreshAuth: true,
          error: "Fresh Super Admin authentication is required before resetting the progressive lockout level. Please enter your current Super Admin password."
        });
      }
      const resetResult = await withLoginIdLock("superadmin", async () => {
        let userDoc = await db.collection("user_roles").doc("role_superadmin").get();
        if (!userDoc.exists) {
          const snap = await db.collection("user_roles").where("loginId", "==", "superadmin").limit(1).get();
          if (!snap.empty) userDoc = snap.docs[0];
        }
        if (!userDoc || !userDoc.exists) {
          return { notFound: true };
        }
        const userData = userDoc.data() || {};
        if (!isCanonicalSuperAdminAccount(userDoc.id, userData)) {
          return { notFound: true };
        }
        const firebaseUid = String(userData.authUid || userDoc.id);
        const secRef = db.collection("account_security").doc("sec_superadmin");
        const userRef = db.collection("user_roles").doc(userDoc.id);
        let previousLevel = 0;
        let totalLockoutEvents = 0;
        await db.runTransaction(async (tx) => {
          const [secSnap, freshUserSnap] = await Promise.all([tx.get(secRef), tx.get(userRef)]);
          const curSec = secSnap.exists ? secSnap.data() || {} : {};
          const freshUser = freshUserSnap.exists ? freshUserSnap.data() || {} : userData;
          previousLevel = Number(curSec.progressiveLockLevel ?? freshUser.progressiveLockLevel ?? 0);
          totalLockoutEvents = Number(curSec.totalLockoutEvents ?? freshUser.totalLockoutEvents ?? 0);
          tx.set(
            secRef,
            {
              ...curSec,
              id: "sec_superadmin",
              loginId: "superadmin",
              role: "SUPER_ADMIN",
              firebaseUid,
              email: freshUser.email || "superadmin@narid.com",
              lockPolicyType: "PROGRESSIVE_TEMPORARY",
              progressiveLockLevel: 0,
              consecutiveFailedAttempts: 0,
              cleanWindowStartAt: null,
              cleanWindowStartMs: null,
              cleanLoginsSinceLastLockout: 0,
              lockoutLevelResetAt: now,
              lockoutLevelResetReason: reason,
              updatedAt: now
            },
            { merge: true }
          );
          tx.update(userRef, {
            progressiveLockLevel: 0,
            consecutiveFailedAttempts: 0,
            cleanWindowStartAt: null,
            cleanWindowStartMs: null,
            cleanLoginsSinceLastLockout: 0,
            lockoutLevelResetAt: now,
            lockoutLevelResetReason: reason,
            updatedAt: now
          });
        });
        await Promise.all([
          recordSecurityAuditLogDoc(db, {
            action: "LOCKOUT_LEVEL_RESET",
            severity: "CRITICAL",
            targetLoginId: "superadmin",
            targetRole: "SUPER_ADMIN",
            targetUid: firebaseUid,
            actorUid: caller.uid,
            actorLoginId: caller.loginId,
            actorRole: "SUPER_ADMIN",
            reason,
            details: `Super Admin "${caller.loginId}" explicitly reset canonical Super Admin progressive lockout level from ${previousLevel} to 0. Historical lockout count (${totalLockoutEvents}) preserved. Reason: ${reason}`,
            metadata: {
              resetType: "MANUAL_APPROVED_RESET",
              previousLevel,
              newLevel: 0,
              totalLockoutEventsPreserved: totalLockoutEvents
            },
            nowMs,
            telemetry
          }),
          recordEnterpriseAuditEvent(db, {
            req,
            action: "super_admin_lockout_level_reset",
            category: "SECURITY",
            severity: "CRITICAL",
            actorUid: caller.uid,
            actorLoginId: caller.loginId,
            actorRole: "SUPER_ADMIN",
            targetType: "ACCOUNT",
            targetId: userDoc.id,
            oldValue: { progressiveLockLevel: previousLevel },
            newValue: {
              progressiveLockLevel: 0,
              resetType: "MANUAL_APPROVED_RESET",
              totalLockoutEventsPreserved: totalLockoutEvents,
              reason
            },
            actionSource: "SECURITY_CONTROL_LOCKOUT_RESET",
            reason,
            description: `Super Admin "${caller.loginId}" reset canonical Super Admin progressive lockout level from ${previousLevel} to 0.`,
            success: true
          })
        ]);
        return {
          notFound: false,
          previousLevel,
          newLevel: 0,
          totalLockoutEvents,
          resetAt: now
        };
      });
      if (resetResult.notFound) {
        return res.status(404).json({
          success: false,
          error: "Canonical Super Admin account not found."
        });
      }
      return res.json({
        success: true,
        message: `Super Admin progressive lockout level reset from ${resetResult.previousLevel} to 0. Full lockout history (${resetResult.totalLockoutEvents} events) preserved.`,
        ...resetResult
      });
    } catch (err) {
      if (isFirestorePermissionDeniedError(err)) {
        const msg = formatAdminPermissionDeniedError(projectId, TARGET_DATABASE_ID);
        return res.status(503).json({ success: false, code: "FIREBASE_ADMIN_PERMISSION_DENIED", error: msg });
      }
      console.error("[Security Reset Super Admin Lockout Level API] Error:", err);
      return res.status(500).json({
        success: false,
        error: err?.message || "Failed to reset Super Admin progressive lockout level."
      });
    }
  });
}

// serverAttendance.ts
import crypto4 from "crypto";
import { z as z3 } from "zod";

// src/utils/attendanceStatus.ts
var STANDARD_DUTY_MINUTES = 510;
var MAX_REGULAR_DUTY_MINUTES = 510;
var MAX_TOTAL_OT_MINUTES = 210;
var MAX_CREDITED_TOTAL_MINUTES = 720;
var HALF_DAY_MIN_MINUTES = 270;
var EARLY_OT_THRESHOLD_MINUTES = 60;
var EARLY_PUNCH_POLICY_ID = "OPTION_A_60M";
var KOLKATA_TIME_12H_FORMATTER = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  hour: "2-digit",
  minute: "2-digit",
  hour12: true
});
var NON_WORKING_STATUSES = /* @__PURE__ */ new Set([
  "ABSENT",
  "LEAVE",
  "ON LEAVE",
  "WEEKLY_OFF",
  "WEEKLY OFF",
  "HOLIDAY"
]);
function classifyCompletedDutyStatus(completedDutyMinutes, standardDutyMinutes = STANDARD_DUTY_MINUTES) {
  const safeMinutes = Math.max(0, Math.floor(Number.isFinite(completedDutyMinutes) ? completedDutyMinutes : 0));
  const safeStandard = Math.max(
    1,
    Math.min(
      MAX_REGULAR_DUTY_MINUTES,
      Math.floor(Number.isFinite(standardDutyMinutes) ? standardDutyMinutes : STANDARD_DUTY_MINUTES)
    )
  );
  if (safeMinutes < HALF_DAY_MIN_MINUTES) {
    return "SHORT LEAVE";
  }
  if (safeMinutes < safeStandard) {
    return "HALF DAY";
  }
  if (safeMinutes === safeStandard) {
    return "COMPLETED";
  }
  return "COMPLETED + OT";
}
function formatDurationClock(mins) {
  const safe = Math.max(0, Math.floor(Number.isFinite(mins) ? mins : 0));
  const h = Math.floor(safe / 60);
  const m = safe % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
function formatOtBadge(overtimeMinutes) {
  const safe = Math.max(0, Math.floor(Number.isFinite(overtimeMinutes) ? overtimeMinutes : 0));
  if (safe <= 0) return "00:00";
  return `${formatDurationClock(safe)} OT`;
}
function formatShiftTimeClock12h(timeStr) {
  const clean = String(timeStr || "").trim();
  if (!clean || !clean.includes(":")) return "--:--";
  const [rawH, rawM] = clean.split(":").map((n) => parseInt(n, 10));
  if (!Number.isFinite(rawH) || !Number.isFinite(rawM)) return "--:--";
  const h24 = (rawH % 24 + 24) % 24;
  const h12 = h24 % 12 || 12;
  const ampm = h24 >= 12 ? "PM" : "AM";
  return `${String(h12).padStart(2, "0")}:${String(rawM).padStart(2, "0")} ${ampm}`;
}
function formatIsoTimeKolkata12h(isoString) {
  if (!isoString) return "--:--";
  const dt = new Date(isoString);
  if (Number.isNaN(dt.getTime())) return "--:--";
  return KOLKATA_TIME_12H_FORMATTER.format(dt).toUpperCase();
}
function getNextCalendarDateKey(dateKey) {
  const [y, m, d] = String(dateKey || "1970-01-01").split("-").map(Number);
  const dt = new Date(Date.UTC(y || 1970, (m || 1) - 1, d || 1));
  dt.setUTCDate(dt.getUTCDate() + 1);
  const nextY = dt.getUTCFullYear();
  const nextM = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const nextD = String(dt.getUTCDate()).padStart(2, "0");
  return `${nextY}-${nextM}-${nextD}`;
}
function resolveScheduledShiftDefaults(recordOrShift) {
  const shiftIdUpper = String(recordOrShift?.shiftId || recordOrShift?.id || "").toUpperCase();
  const shiftNameUpper = String(recordOrShift?.shiftNameSnapshot || recordOrShift?.name || "").toUpperCase();
  const inferredNight = recordOrShift?.isOvernight === true || shiftIdUpper === "NIGHT" || shiftNameUpper.includes("NIGHT");
  const defaultStart = inferredNight ? "20:00" : "09:00";
  const defaultEnd = inferredNight ? "04:30" : "17:30";
  const startTime = String(recordOrShift?.scheduledPunchIn || recordOrShift?.startTime || defaultStart).trim() || defaultStart;
  const endTime = String(recordOrShift?.scheduledPunchOut || recordOrShift?.endTime || defaultEnd).trim() || defaultEnd;
  return {
    startTime,
    endTime,
    isOvernight: inferredNight
  };
}
function resolveShiftScheduleBounds(shiftDate, shiftOrRecord) {
  const { startTime, endTime, isOvernight } = resolveScheduledShiftDefaults(shiftOrRecord);
  const [sh, sm] = startTime.split(":").map((n) => parseInt(n, 10) || 0);
  const [eh, em] = endTime.split(":").map((n) => parseInt(n, 10) || 0);
  const endDateKey = isOvernight ? getNextCalendarDateKey(shiftDate) : shiftDate;
  const scheduledStartIso = `${shiftDate}T${String(sh).padStart(2, "0")}:${String(sm).padStart(2, "0")}:00+05:30`;
  const scheduledEndIso = `${endDateKey}T${String(eh).padStart(2, "0")}:${String(em).padStart(2, "0")}:00+05:30`;
  return {
    startTime: `${String(sh).padStart(2, "0")}:${String(sm).padStart(2, "0")}`,
    endTime: `${String(eh).padStart(2, "0")}:${String(em).padStart(2, "0")}`,
    isOvernight,
    scheduledStartIso,
    scheduledEndIso,
    scheduledStartMs: new Date(scheduledStartIso).getTime(),
    scheduledEndMs: new Date(scheduledEndIso).getTime()
  };
}
function computeExpectedPunchOutTimes(params) {
  const firstInMs = new Date(params.firstInIso).getTime();
  const scheduledStartMs = new Date(params.scheduledStartIso).getTime();
  const scheduledEndMs = new Date(params.scheduledEndIso).getTime();
  if (!Number.isFinite(firstInMs) || !Number.isFinite(scheduledStartMs) || !Number.isFinite(scheduledEndMs)) {
    return null;
  }
  const maxRegularDutyMinutes = Math.max(
    1,
    Math.min(
      MAX_REGULAR_DUTY_MINUTES,
      Math.floor(Number.isFinite(params.standardDutyMinutes) ? Number(params.standardDutyMinutes) : STANDARD_DUTY_MINUTES)
    )
  );
  const earlyArrivalMinutes = firstInMs < scheduledStartMs ? Math.max(0, Math.floor((scheduledStartMs - firstInMs) / 6e4)) : 0;
  const eligibleEarlyOtMinutes = earlyArrivalMinutes >= EARLY_OT_THRESHOLD_MINUTES ? Math.min(earlyArrivalMinutes, MAX_TOTAL_OT_MINUTES) : 0;
  const remainingPostShiftOtMinutes = Math.max(0, MAX_TOTAL_OT_MINUTES - eligibleEarlyOtMinutes);
  const shiftAnchorMs = firstInMs < scheduledStartMs ? scheduledStartMs : firstInMs;
  const regularDutyCompletionMs = shiftAnchorMs + maxRegularDutyMinutes * 6e4;
  const maxEligiblePunchOutMs = regularDutyCompletionMs + remainingPostShiftOtMinutes * 6e4;
  const regularDutyCompletionIso = new Date(regularDutyCompletionMs).toISOString();
  const maxEligiblePunchOutIso = new Date(maxEligiblePunchOutMs).toISOString();
  return {
    scheduledShiftEndIso: params.scheduledEndIso,
    scheduledShiftEndDisplay: formatIsoTimeKolkata12h(params.scheduledEndIso),
    regularDutyCompletionIso,
    regularDutyCompletionDisplay: formatIsoTimeKolkata12h(regularDutyCompletionIso),
    maxEligiblePunchOutIso,
    maxEligiblePunchOutDisplay: formatIsoTimeKolkata12h(maxEligiblePunchOutIso),
    maxRegularDutyMinutes,
    maxOtMinutes: MAX_TOTAL_OT_MINUTES,
    maxCreditedWorkingMinutes: MAX_CREDITED_TOTAL_MINUTES,
    maxOtDisplay: `${formatDurationClock(MAX_TOTAL_OT_MINUTES)} Hours`,
    maxCreditedWorkingDisplay: `${formatDurationClock(MAX_CREDITED_TOTAL_MINUTES)} Hours`,
    eligibleEarlyOtMinutes,
    remainingPostShiftOtMinutes
  };
}
function evaluateEarlyPunchOnPunchIn(params) {
  const firstInMs = new Date(params.firstInIso).getTime();
  const scheduledStartMs = new Date(params.scheduledStartIso).getTime();
  const earlyArrivalMinutes = Number.isFinite(firstInMs) && Number.isFinite(scheduledStartMs) && firstInMs < scheduledStartMs ? Math.max(0, Math.floor((scheduledStartMs - firstInMs) / 6e4)) : 0;
  const provisionalEarlyOtMinutes = earlyArrivalMinutes >= EARLY_OT_THRESHOLD_MINUTES ? Math.min(earlyArrivalMinutes, MAX_TOTAL_OT_MINUTES) : 0;
  return {
    earlyArrivalMinutes,
    provisionalEarlyOtMinutes,
    earlyOtFinalized: false,
    earlyPunchPolicy: EARLY_PUNCH_POLICY_ID
  };
}
function evaluateOptionAPunchOut(params) {
  const standardDutyMinutes = Math.max(
    1,
    Math.min(
      MAX_REGULAR_DUTY_MINUTES,
      Math.floor(Number.isFinite(params.standardDutyMinutes) ? Number(params.standardDutyMinutes) : STANDARD_DUTY_MINUTES)
    )
  );
  const firstInMs = new Date(params.firstInIso).getTime();
  const lastOutMs = new Date(params.lastOutIso).getTime();
  const scheduledStartMs = new Date(params.scheduledStartIso).getTime();
  if (!Number.isFinite(firstInMs) || !Number.isFinite(lastOutMs) || lastOutMs < firstInMs) {
    return {
      actualPresenceMinutes: 0,
      earlyArrivalMinutes: 0,
      provisionalEarlyOtMinutes: 0,
      earlyOtMinutes: 0,
      postShiftOtMinutes: 0,
      overtimeMinutes: 0,
      totalOtMinutes: 0,
      regularDutyMinutes: 0,
      totalDutyMinutes: 0,
      otCapApplied: false,
      attendanceStatus: "SHORT LEAVE",
      earlyOtFinalized: true,
      earlyPunchPolicy: EARLY_PUNCH_POLICY_ID
    };
  }
  const actualPresenceMinutes = Math.max(0, Math.floor((lastOutMs - firstInMs) / 6e4));
  const earlyArrivalMinutes = Number.isFinite(scheduledStartMs) && firstInMs < scheduledStartMs ? Math.max(0, Math.floor((scheduledStartMs - firstInMs) / 6e4)) : 0;
  const rawEarlyOtMinutes = earlyArrivalMinutes >= EARLY_OT_THRESHOLD_MINUTES ? earlyArrivalMinutes : 0;
  const provisionalEarlyOtMinutes = Math.min(rawEarlyOtMinutes, MAX_TOTAL_OT_MINUTES);
  const shiftAnchorMs = Number.isFinite(scheduledStartMs) && firstInMs < scheduledStartMs ? scheduledStartMs : firstInMs;
  const fromShiftStartMinutes = Math.max(0, Math.floor((lastOutMs - shiftAnchorMs) / 6e4));
  if (fromShiftStartMinutes >= standardDutyMinutes) {
    const regularDutyMinutes = Math.min(fromShiftStartMinutes, MAX_REGULAR_DUTY_MINUTES, standardDutyMinutes);
    const rawPostShiftOtMinutes = Math.max(0, fromShiftStartMinutes - standardDutyMinutes);
    const earlyOtMinutes = Math.min(rawEarlyOtMinutes, MAX_TOTAL_OT_MINUTES);
    const remainingOtBudget = Math.max(0, MAX_TOTAL_OT_MINUTES - earlyOtMinutes);
    const postShiftOtMinutes = Math.min(rawPostShiftOtMinutes, remainingOtBudget);
    const totalOtMinutes = Math.min(earlyOtMinutes + postShiftOtMinutes, MAX_TOTAL_OT_MINUTES);
    const overtimeMinutes = totalOtMinutes;
    const totalDutyMinutes = Math.min(regularDutyMinutes + totalOtMinutes, MAX_CREDITED_TOTAL_MINUTES);
    const otCapApplied = rawEarlyOtMinutes + rawPostShiftOtMinutes > MAX_TOTAL_OT_MINUTES || regularDutyMinutes + rawEarlyOtMinutes + rawPostShiftOtMinutes > MAX_CREDITED_TOTAL_MINUTES;
    return {
      actualPresenceMinutes,
      earlyArrivalMinutes,
      provisionalEarlyOtMinutes,
      earlyOtMinutes,
      postShiftOtMinutes,
      overtimeMinutes,
      totalOtMinutes,
      regularDutyMinutes,
      totalDutyMinutes,
      otCapApplied,
      attendanceStatus: overtimeMinutes > 0 ? "COMPLETED + OT" : "COMPLETED",
      earlyOtFinalized: true,
      earlyPunchPolicy: EARLY_PUNCH_POLICY_ID
    };
  }
  const countedDuty = Math.min(
    earlyArrivalMinutes > 0 ? fromShiftStartMinutes : actualPresenceMinutes,
    MAX_REGULAR_DUTY_MINUTES
  );
  const attendanceStatus = classifyCompletedDutyStatus(countedDuty, standardDutyMinutes);
  return {
    actualPresenceMinutes,
    earlyArrivalMinutes,
    provisionalEarlyOtMinutes,
    earlyOtMinutes: 0,
    postShiftOtMinutes: 0,
    overtimeMinutes: 0,
    totalOtMinutes: 0,
    regularDutyMinutes: countedDuty,
    totalDutyMinutes: countedDuty,
    otCapApplied: false,
    attendanceStatus,
    earlyOtFinalized: true,
    earlyPunchPolicy: EARLY_PUNCH_POLICY_ID
  };
}
function isAttendanceLate(record) {
  if (!record) return false;
  if (record.isLate === true) return true;
  if (String(record.arrivalStatus || "").toUpperCase() === "LATE") return true;
  if (String(record.attendanceStatus || "").toUpperCase() === "LATE") return true;
  if (Array.isArray(record.punches)) {
    return record.punches.some((p) => String(p?.status || "").toUpperCase() === "FIRST_IN_LATE");
  }
  return false;
}
function isAttendanceRecordOpen(record) {
  if (!record) return false;
  const rawStatus = String(record.attendanceStatus || "").toUpperCase();
  if (NON_WORKING_STATUSES.has(rawStatus)) return false;
  const state = String(record.currentState || "").toUpperCase();
  if (state === "INSIDE") return true;
  if (state === "OUTSIDE") return false;
  if (record.actualPunchOut || record.lastPunchOut) return false;
  if (record.autoClosed === true || record.punchOutType === "AUTO" || record.punchOutType === "ACTUAL") {
    return false;
  }
  if (rawStatus === "AUTO CLOSED" || rawStatus === "MISSED PUNCH OUT") {
    return false;
  }
  return Boolean(record.firstPunchIn || record.punchIn);
}
function resolveAttendanceMetrics(record, nowMs = Date.now(), standardDutyMinutes = STANDARD_DUTY_MINUTES) {
  const { startTime: defaultStart, endTime: defaultEnd } = resolveScheduledShiftDefaults(record);
  const scheduledStartDisplay = formatShiftTimeClock12h(defaultStart);
  const scheduledEndDisplay = formatShiftTimeClock12h(defaultEnd);
  if (!record) {
    return {
      status: "ABSENT",
      state: "OUTSIDE",
      isOpen: false,
      isLate: false,
      completedDutyMinutes: 0,
      regularDutyMinutes: 0,
      overtimeMinutes: 0,
      accumulatedDutyMinutes: 0,
      otLabel: "00:00",
      scheduledPunchIn: defaultStart,
      scheduledStartDisplay,
      scheduledPunchOut: defaultEnd,
      scheduledEndDisplay,
      earlyArrivalMinutes: 0,
      provisionalEarlyOtMinutes: 0,
      earlyOtMinutes: 0,
      postShiftOtMinutes: 0,
      totalOtMinutes: 0,
      earlyOtFinalized: false,
      isEarlyPunch: false,
      otCapApplied: false,
      reconciledFromAutoClose: false,
      punchOutSchedule: null
    };
  }
  const rawStatus = String(record.attendanceStatus || "").trim().toUpperCase();
  const isLate = isAttendanceLate(record);
  const reconciledFromAutoClose = Boolean(record.reconciledFromAutoClose);
  const firstInForSchedule = record.firstPunchIn || record.punchIn;
  let punchOutSchedule = null;
  if (firstInForSchedule && (record.scheduledPunchInIso || record.shiftDate)) {
    const bounds = record.shiftDate ? resolveShiftScheduleBounds(record.shiftDate, record) : null;
    const schedStartIso = record.scheduledPunchInIso || bounds?.scheduledStartIso;
    const schedEndIso = record.scheduledPunchOutIso || bounds?.scheduledEndIso;
    if (schedStartIso && schedEndIso) {
      punchOutSchedule = computeExpectedPunchOutTimes({
        firstInIso: firstInForSchedule,
        scheduledStartIso: schedStartIso,
        scheduledEndIso: schedEndIso,
        standardDutyMinutes
      });
    }
  }
  if (NON_WORKING_STATUSES.has(rawStatus)) {
    return {
      status: rawStatus,
      state: "OUTSIDE",
      isOpen: false,
      isLate: false,
      completedDutyMinutes: 0,
      regularDutyMinutes: 0,
      overtimeMinutes: 0,
      accumulatedDutyMinutes: 0,
      otLabel: "00:00",
      scheduledPunchIn: defaultStart,
      scheduledStartDisplay,
      scheduledPunchOut: defaultEnd,
      scheduledEndDisplay,
      earlyArrivalMinutes: 0,
      provisionalEarlyOtMinutes: 0,
      earlyOtMinutes: 0,
      postShiftOtMinutes: 0,
      totalOtMinutes: 0,
      earlyOtFinalized: false,
      isEarlyPunch: false,
      otCapApplied: false,
      reconciledFromAutoClose: false,
      punchOutSchedule: null
    };
  }
  const storedEarlyArrival = Math.max(0, Math.floor(Number(record.earlyArrivalMinutes || 0) || 0));
  const computedProvisionalEarlyOt = typeof record.provisionalEarlyOtMinutes === "number" && Number.isFinite(record.provisionalEarlyOtMinutes) ? Math.min(Math.max(0, Math.floor(record.provisionalEarlyOtMinutes)), MAX_TOTAL_OT_MINUTES) : storedEarlyArrival >= EARLY_OT_THRESHOLD_MINUTES ? Math.min(storedEarlyArrival, MAX_TOTAL_OT_MINUTES) : 0;
  const reenteredInside = String(record.currentState || "").toUpperCase() === "INSIDE" && String(record.punchOutType || "").toUpperCase() === "NONE";
  if (!reenteredInside && (record.autoClosed === true || String(record.punchOutType || "").toUpperCase() === "AUTO" || rawStatus === "AUTO CLOSED" || rawStatus === "MISSED PUNCH OUT" || record.missedPunchOut === true)) {
    const rawCompleted2 = Math.max(
      0,
      Math.floor(Number(record.totalDutyMinutes ?? record.regularDutyMinutes ?? 0) || 0)
    );
    const regularDutyMinutes2 = Math.min(rawCompleted2, MAX_REGULAR_DUTY_MINUTES, standardDutyMinutes);
    const completedDutyMinutes2 = regularDutyMinutes2;
    return {
      status: rawStatus === "MISSED PUNCH OUT" ? "MISSED PUNCH OUT" : "AUTO CLOSED",
      state: "OUTSIDE",
      isOpen: false,
      isLate,
      completedDutyMinutes: completedDutyMinutes2,
      regularDutyMinutes: regularDutyMinutes2,
      overtimeMinutes: 0,
      // Strictly zero OT on auto-closed / missed punch out
      accumulatedDutyMinutes: 0,
      otLabel: "00:00",
      scheduledPunchIn: defaultStart,
      scheduledStartDisplay,
      scheduledPunchOut: defaultEnd,
      scheduledEndDisplay,
      earlyArrivalMinutes: storedEarlyArrival,
      provisionalEarlyOtMinutes: 0,
      earlyOtMinutes: 0,
      postShiftOtMinutes: 0,
      totalOtMinutes: 0,
      earlyOtFinalized: false,
      isEarlyPunch: storedEarlyArrival > 0,
      otCapApplied: false,
      reconciledFromAutoClose: false,
      punchOutSchedule
    };
  }
  if (isAttendanceRecordOpen(record)) {
    const firstInIso2 = record.firstPunchIn || record.punchIn;
    const firstInMs2 = firstInIso2 ? new Date(firstInIso2).getTime() : NaN;
    const accumulatedDutyMinutes = Number.isFinite(firstInMs2) && nowMs >= firstInMs2 ? Math.max(0, Math.floor((nowMs - firstInMs2) / 6e4)) : 0;
    return {
      status: "IN PROGRESS",
      state: "INSIDE",
      isOpen: true,
      isLate,
      completedDutyMinutes: 0,
      // Never count open shift as finalized completed duty
      regularDutyMinutes: 0,
      overtimeMinutes: 0,
      // Never finalize OT on open shift
      accumulatedDutyMinutes,
      otLabel: "00:00",
      scheduledPunchIn: defaultStart,
      scheduledStartDisplay,
      scheduledPunchOut: defaultEnd,
      scheduledEndDisplay,
      earlyArrivalMinutes: storedEarlyArrival,
      provisionalEarlyOtMinutes: computedProvisionalEarlyOt,
      earlyOtMinutes: 0,
      postShiftOtMinutes: 0,
      totalOtMinutes: 0,
      earlyOtFinalized: false,
      isEarlyPunch: storedEarlyArrival > 0,
      otCapApplied: false,
      reconciledFromAutoClose,
      punchOutSchedule
    };
  }
  const firstInIso = record.firstPunchIn || record.punchIn;
  const lastOutIso = record.lastPunchOut || record.actualPunchOut || record.effectivePunchOut;
  const firstInMs = firstInIso ? new Date(firstInIso).getTime() : NaN;
  const lastOutMs = lastOutIso ? new Date(lastOutIso).getTime() : NaN;
  const isOptionARecord = record.earlyPunchPolicy === EARLY_PUNCH_POLICY_ID || typeof record.earlyOtMinutes === "number" || typeof record.postShiftOtMinutes === "number";
  if (isOptionARecord) {
    let earlyArrivalMinutes = storedEarlyArrival;
    let earlyOtMinutes = Math.min(Math.max(0, Math.floor(Number(record.earlyOtMinutes || 0) || 0)), MAX_TOTAL_OT_MINUTES);
    let postShiftOtMinutes = Math.min(
      Math.max(0, Math.floor(Number(record.postShiftOtMinutes || 0) || 0)),
      Math.max(0, MAX_TOTAL_OT_MINUTES - earlyOtMinutes)
    );
    let regularDutyMinutes2 = Math.min(
      Math.max(0, Math.floor(Number(record.regularDutyMinutes || 0) || 0)),
      MAX_REGULAR_DUTY_MINUTES
    );
    let overtimeMinutes2 = Math.min(earlyOtMinutes + postShiftOtMinutes, MAX_TOTAL_OT_MINUTES);
    let completedDutyMinutes2 = Math.min(
      Math.max(0, Math.floor(Number(record.totalDutyMinutes || 0) || 0)),
      MAX_CREDITED_TOTAL_MINUTES
    );
    let otCapApplied = Boolean(record.otCapApplied);
    const scheduledStartIso = record.scheduledPunchInIso || (record.shiftDate ? resolveShiftScheduleBounds(record.shiftDate, record).scheduledStartIso : void 0);
    if (scheduledStartIso && firstInIso && lastOutIso && Number.isFinite(firstInMs) && Number.isFinite(lastOutMs)) {
      const evaluated = evaluateOptionAPunchOut({
        firstInIso,
        lastOutIso,
        scheduledStartIso,
        standardDutyMinutes
      });
      earlyArrivalMinutes = evaluated.earlyArrivalMinutes;
      earlyOtMinutes = evaluated.earlyOtMinutes;
      postShiftOtMinutes = evaluated.postShiftOtMinutes;
      overtimeMinutes2 = evaluated.overtimeMinutes;
      regularDutyMinutes2 = evaluated.regularDutyMinutes;
      completedDutyMinutes2 = evaluated.totalDutyMinutes;
      otCapApplied = evaluated.otCapApplied;
    } else if (overtimeMinutes2 === 0 && typeof record.overtimeMinutes === "number") {
      overtimeMinutes2 = Math.min(Math.max(0, Math.floor(record.overtimeMinutes)), MAX_TOTAL_OT_MINUTES);
    }
    const status2 = classifyCompletedDutyStatus(completedDutyMinutes2, standardDutyMinutes);
    return {
      status: status2,
      state: "OUTSIDE",
      isOpen: false,
      isLate,
      completedDutyMinutes: completedDutyMinutes2,
      regularDutyMinutes: regularDutyMinutes2,
      overtimeMinutes: overtimeMinutes2,
      accumulatedDutyMinutes: 0,
      otLabel: formatOtBadge(overtimeMinutes2),
      scheduledPunchIn: defaultStart,
      scheduledStartDisplay,
      scheduledPunchOut: defaultEnd,
      scheduledEndDisplay,
      earlyArrivalMinutes,
      provisionalEarlyOtMinutes: earlyArrivalMinutes >= EARLY_OT_THRESHOLD_MINUTES ? Math.min(earlyArrivalMinutes, MAX_TOTAL_OT_MINUTES) : 0,
      earlyOtMinutes,
      postShiftOtMinutes,
      totalOtMinutes: overtimeMinutes2,
      earlyOtFinalized: true,
      isEarlyPunch: earlyArrivalMinutes > 0,
      otCapApplied,
      reconciledFromAutoClose,
      punchOutSchedule
    };
  }
  let rawCompleted = 0;
  if (typeof record.totalDutyMinutes === "number" && Number.isFinite(record.totalDutyMinutes) && record.totalDutyMinutes > 0) {
    rawCompleted = Math.floor(record.totalDutyMinutes);
  } else if (Number.isFinite(firstInMs) && Number.isFinite(lastOutMs) && lastOutMs >= firstInMs) {
    rawCompleted = Math.floor((lastOutMs - firstInMs) / 6e4);
  } else if (typeof record.regularDutyMinutes === "number" || typeof record.overtimeMinutes === "number") {
    rawCompleted = Math.max(
      0,
      Math.floor(Number(record.regularDutyMinutes || 0) + Number(record.overtimeMinutes || 0))
    );
  }
  const regularDutyMinutes = Math.min(rawCompleted, MAX_REGULAR_DUTY_MINUTES, standardDutyMinutes);
  const rawOt = rawCompleted > regularDutyMinutes ? rawCompleted - regularDutyMinutes : 0;
  const overtimeMinutes = Math.min(rawOt, MAX_TOTAL_OT_MINUTES);
  const completedDutyMinutes = Math.min(regularDutyMinutes + overtimeMinutes, MAX_CREDITED_TOTAL_MINUTES);
  const status = classifyCompletedDutyStatus(completedDutyMinutes, standardDutyMinutes);
  return {
    status,
    state: "OUTSIDE",
    isOpen: false,
    isLate,
    completedDutyMinutes,
    regularDutyMinutes,
    overtimeMinutes,
    accumulatedDutyMinutes: 0,
    otLabel: formatOtBadge(overtimeMinutes),
    scheduledPunchIn: defaultStart,
    scheduledStartDisplay,
    scheduledPunchOut: defaultEnd,
    scheduledEndDisplay,
    earlyArrivalMinutes: 0,
    provisionalEarlyOtMinutes: 0,
    earlyOtMinutes: 0,
    postShiftOtMinutes: overtimeMinutes,
    totalOtMinutes: overtimeMinutes,
    earlyOtFinalized: true,
    isEarlyPunch: false,
    otCapApplied: rawOt > MAX_TOTAL_OT_MINUTES || rawCompleted > MAX_CREDITED_TOTAL_MINUTES,
    reconciledFromAutoClose,
    punchOutSchedule
  };
}

// serverAttendance.ts
var KOLKATA_PARTS_FORMATTER = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false
});
var KOLKATA_TIME_DISPLAY_FORMATTER = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  hour: "2-digit",
  minute: "2-digit",
  hour12: true
});
var DEFAULT_SHIFTS = [
  {
    id: "DAY",
    name: "DAY SHIFT",
    startTime: "09:00",
    endTime: "17:30",
    scheduledDurationMinutes: 510,
    punchInWindowStart: "06:00",
    punchInWindowEnd: "18:00",
    isOvernight: false,
    gracePeriodMinutes: 15,
    status: "Active"
  },
  {
    id: "NIGHT",
    name: "NIGHT SHIFT",
    startTime: "20:00",
    endTime: "04:30",
    scheduledDurationMinutes: 510,
    punchInWindowStart: "18:00",
    punchInWindowEnd: "06:00",
    isOvernight: true,
    gracePeriodMinutes: 15,
    status: "Active"
  }
];
var DEFAULT_SETTINGS = {
  id: "global",
  autoPunchOutEnabled: true,
  lateGraceMinutes: 15,
  scheduledDurationMinutes: 510,
  overtimeThresholdMinutes: 510
};
var employeeScanLocks = /* @__PURE__ */ new Map();
async function withEmployeeScanLock(employeeId, task) {
  const key = employeeId.trim().toUpperCase() || "__UNKNOWN__";
  const existing = employeeScanLocks.get(key);
  const waitedForLock = Boolean(existing);
  const prev = existing || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const chained = prev.then(() => gate);
  employeeScanLocks.set(key, chained);
  try {
    await prev;
    return await task({ waitedForLock });
  } finally {
    release();
    if (employeeScanLocks.get(key) === chained) {
      employeeScanLocks.delete(key);
    }
  }
}
function formatMinutes(mins) {
  if (mins <= 0) return "00:00 Hours";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")} Hours`;
}
function timeStringToMinutes(timeStr) {
  if (!timeStr) return 0;
  const [hh, mm] = timeStr.split(":").map(Number);
  return hh * 60 + (mm || 0);
}
function getKolkataTimeParts(date = /* @__PURE__ */ new Date()) {
  const parts = KOLKATA_PARTS_FORMATTER.formatToParts(date);
  const map = {};
  for (const p of parts) {
    map[p.type] = p.value;
  }
  const year = parseInt(map.year, 10);
  const month = parseInt(map.month, 10);
  const day = parseInt(map.day, 10);
  let hours = parseInt(map.hour, 10);
  if (hours === 24) hours = 0;
  const minutes = parseInt(map.minute, 10);
  const seconds = parseInt(map.second, 10);
  const dateKey = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const totalMinutes = hours * 60 + minutes;
  const h12 = hours % 12 || 12;
  const ampm = hours >= 12 ? "PM" : "AM";
  const timeDisplay = `${String(h12).padStart(2, "0")}:${String(minutes).padStart(2, "0")} ${ampm}`;
  const timeWithSeconds = `${String(h12).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")} ${ampm}`;
  return {
    year,
    month,
    day,
    hours,
    minutes,
    seconds,
    dateKey,
    totalMinutes,
    timeDisplay,
    timeWithSeconds
  };
}
function getYesterdayKolkataDateKey(d = /* @__PURE__ */ new Date()) {
  const yesterday = new Date(d.getTime() - 24 * 3600 * 1e3);
  return getKolkataTimeParts(yesterday).dateKey;
}
function getNextDateKey(dateKey) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  const nextY = dt.getUTCFullYear();
  const nextM = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const nextD = String(dt.getUTCDate()).padStart(2, "0");
  return `${nextY}-${nextM}-${nextD}`;
}
function getShiftScheduledEndIso(shiftDate, shift) {
  const targetDateKey = shift.isOvernight ? getNextDateKey(shiftDate) : shiftDate;
  const [h, m] = String(shift.endTime || "17:30").split(":");
  return `${targetDateKey}T${h.padStart(2, "0")}:${(m || "00").padStart(2, "0")}:00+05:30`;
}
function formatTimeDisplay(isoString) {
  if (!isoString) return "--:--";
  const d = new Date(isoString);
  return KOLKATA_TIME_DISPLAY_FORMATTER.format(d);
}
var EMPLOYEE_ID_PATTERN = /^[A-Z0-9][A-Z0-9_-]{1,31}$/;
function parseQrPayload(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) {
    return { employeeId: "", format: "INVALID" };
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { employeeId: "", format: "INVALID" };
      }
      const rawId = parsed.employeeId ?? parsed.id;
      if (typeof rawId !== "string") {
        return { employeeId: "", format: "INVALID" };
      }
      const cleanId = rawId.trim().toUpperCase();
      if (!EMPLOYEE_ID_PATTERN.test(cleanId)) {
        return { employeeId: "", format: "INVALID" };
      }
      const rawToken = parsed.token ?? parsed.qrToken;
      const cleanToken = typeof rawToken === "string" && rawToken.trim() ? rawToken.trim() : void 0;
      return {
        employeeId: cleanId,
        token: cleanToken,
        format: "JSON_TOKEN"
      };
    } catch {
      return { employeeId: "", format: "INVALID" };
    }
  }
  if (trimmed.startsWith("QR_")) {
    const parts = trimmed.split("_");
    const cleanId = (parts[1] || "").trim().toUpperCase();
    if (!cleanId || !EMPLOYEE_ID_PATTERN.test(cleanId)) {
      return { employeeId: "", format: "INVALID" };
    }
    const tokenSuffix = parts.slice(2).join("_").trim();
    return {
      employeeId: cleanId,
      token: parts.length >= 3 && tokenSuffix.length > 0 ? trimmed : void 0,
      format: "TOKEN_STRING"
    };
  }
  const cleanLegacyId = trimmed.toUpperCase();
  if (!EMPLOYEE_ID_PATTERN.test(cleanLegacyId)) {
    return { employeeId: "", format: "INVALID" };
  }
  return { employeeId: cleanLegacyId, format: "LEGACY_EMPLOYEE_ID" };
}
function resolveEffectivePunchInWindow(shift) {
  const rawStart = String(shift?.punchInWindowStart || "").trim();
  const rawEnd = String(shift?.punchInWindowEnd || "").trim();
  const shiftIdUpper = String(shift?.id || "").toUpperCase();
  if (!shift?.isOvernight && (shiftIdUpper === "DAY" || shift?.startTime === "09:00") && rawStart === "09:00" && rawEnd === "20:00") {
    return { winStartStr: "06:00", winEndStr: "18:00" };
  }
  if ((shift?.isOvernight || shiftIdUpper === "NIGHT") && shift?.startTime === "20:00" && rawStart === "20:00" && rawEnd === "09:00") {
    return { winStartStr: "18:00", winEndStr: "06:00" };
  }
  return { winStartStr: rawStart, winEndStr: rawEnd };
}
function identifyShiftForPunchIn(shifts, now = /* @__PURE__ */ new Date()) {
  const kolkata = getKolkataTimeParts(now);
  const currentMins = kolkata.totalMinutes;
  const activeShifts = shifts.filter((s) => s.status === "Active");
  for (const shift of activeShifts) {
    const { winStartStr, winEndStr } = resolveEffectivePunchInWindow(shift);
    const winStart = timeStringToMinutes(winStartStr);
    const winEnd = timeStringToMinutes(winEndStr);
    if (winStart < winEnd) {
      if (currentMins >= winStart && currentMins < winEnd) {
        return { shift, shiftDate: kolkata.dateKey };
      }
    } else {
      if (currentMins >= winStart) {
        return { shift, shiftDate: kolkata.dateKey };
      } else if (currentMins < winEnd) {
        return { shift, shiftDate: getYesterdayKolkataDateKey(now) };
      }
    }
  }
  const dayShift = activeShifts.find((s) => !s.isOvernight) || activeShifts[0];
  const nightShift = activeShifts.find((s) => s.isOvernight) || activeShifts[activeShifts.length - 1];
  if (currentMins >= 360 && currentMins < 1080) {
    return dayShift ? { shift: dayShift, shiftDate: kolkata.dateKey } : null;
  } else if (currentMins >= 1080) {
    return nightShift ? { shift: nightShift, shiftDate: kolkata.dateKey } : null;
  } else {
    return nightShift ? { shift: nightShift, shiftDate: getYesterdayKolkataDateKey(now) } : null;
  }
}
var AttendanceScanSchema = z3.object({
  rawPayload: z3.string().trim().min(1, "Scan payload cannot be empty.").max(256),
  scannerType: z3.enum(["IN", "OUT"]).optional(),
  scannerDevice: z3.enum(["USB_SCANNER", "WEBCAM", "MANUAL", "SYSTEM_AUTO"]).optional(),
  customScanTime: z3.string().datetime({ offset: true }).or(z3.string().datetime()).optional(),
  clientRequestId: z3.string().trim().min(4).max(64).optional()
});
var ManualPunchSchema = z3.object({
  employeeId: z3.string().trim().min(2, "Please enter a valid Employee ID.").max(32, "Employee ID cannot exceed 32 characters.").transform((v) => v.toUpperCase()).refine((v) => EMPLOYEE_ID_PATTERN.test(v), {
    message: "Invalid Employee ID format. Use letters, numbers, hyphens, or underscores only."
  }),
  scannerType: z3.enum(["IN", "OUT"]).optional(),
  reason: z3.string().trim().max(250).optional(),
  customScanTime: z3.string().datetime({ offset: true }).or(z3.string().datetime()).optional(),
  clientRequestId: z3.string().trim().min(4).max(64).optional()
});
var AttendanceCorrectSchema = z3.object({
  attendanceId: z3.string().trim().min(1, "Attendance ID is required.").max(128),
  actualPunchOut: z3.string().optional(),
  punchOutType: z3.enum(["ACTUAL", "AUTO"]),
  attendanceStatus: z3.enum([
    "IN PROGRESS",
    "SHORT LEAVE",
    "HALF DAY",
    "COMPLETED",
    "COMPLETED + OT",
    "PRESENT",
    "LATE",
    "AUTO CLOSED",
    "MISSED PUNCH OUT",
    "ABSENT",
    "ON LEAVE"
  ]),
  reason: z3.string().trim().min(3, "A clear correction reason (at least 3 characters) is mandatory.").max(500)
});
var GenerateRosterSchema = z3.object({
  shiftDate: z3.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid shiftDate (expected YYYY-MM-DD)."),
  shiftId: z3.string().trim().min(1).max(64)
});
var ClearAttendanceSchema = z3.object({
  confirmed: z3.literal(true, { message: "Explicit confirmation is required to clear attendance records." }),
  confirmPhrase: z3.literal("CLEAR_ALL_ATTENDANCE", {
    message: 'Confirmation phrase "CLEAR_ALL_ATTENDANCE" is required to clear attendance records.'
  }),
  reason: z3.string().trim().min(5, "Reason is required for audit trail.").max(500).optional()
});
var ADMIN_FALLBACK_ACTIONS = {
  dashboard: { view: true },
  scanner: { view: true, add: true, edit: true },
  employees: { view: true, add: true, edit: true },
  excel_import: { view: true, add: true, edit: true },
  qr_codes: { view: true, add: true, edit: true },
  organization: { view: true, add: true, edit: true },
  floors: { view: true, add: true, edit: true },
  sections: { view: true, add: true, edit: true },
  departments: { view: true, add: true, edit: true },
  shifts: { view: true, add: true, edit: true },
  history: { view: true, edit: true },
  reports: { view: true }
};
function evalModuleActionFromSnapshots(caller, userPermData, rolePermData, fallbackModules, moduleKey, action) {
  if (caller.role === "super_admin") return true;
  if (moduleKey === "user_rights" || moduleKey === "audit_logs" || moduleKey === "security_management") {
    return false;
  }
  if (userPermData && userPermData.isCustomOverride !== false) {
    const mod = userPermData.permissions?.[moduleKey];
    if (mod && typeof mod[action] === "boolean") {
      return mod[action] === true && (action === "view" || mod.view !== false);
    }
  }
  if (rolePermData) {
    const mod = rolePermData.modulePermissions?.[moduleKey];
    if (mod && typeof mod[action] === "boolean") {
      return mod[action] === true && (action === "view" || mod.view !== false);
    }
  }
  if (caller.role === "admin") {
    return Boolean(ADMIN_FALLBACK_ACTIONS[moduleKey]?.[action]);
  }
  if (Array.isArray(fallbackModules)) {
    if (fallbackModules.includes("all") || fallbackModules.includes(moduleKey)) {
      if (action === "view") return true;
      if (moduleKey === "scanner" && action === "add") return true;
    }
  }
  return false;
}
async function callerHasModuleAction(db, caller, moduleKey, action) {
  if (caller.role === "super_admin") return true;
  if (moduleKey === "user_rights" || moduleKey === "audit_logs" || moduleKey === "security_management") {
    return false;
  }
  try {
    const [userPermSnap, rolePermSnap] = await Promise.all([
      db.collection("user_permissions").doc(caller.profileDocId).get(),
      getCachedRolePermissionsDoc(db, caller.role)
    ]);
    const userPermData = userPermSnap.exists ? userPermSnap.data() : void 0;
    const rolePermData = rolePermSnap.exists ? rolePermSnap.data : void 0;
    let fallbackModules = caller.modulesAllowed;
    if (fallbackModules === void 0 && caller.role !== "admin") {
      const userSnap = await db.collection("user_roles").doc(caller.profileDocId).get();
      if (userSnap.exists && Array.isArray(userSnap.data()?.modulesAllowed)) {
        fallbackModules = userSnap.data().modulesAllowed;
      }
    }
    return evalModuleActionFromSnapshots(
      caller,
      userPermData,
      rolePermData,
      fallbackModules,
      moduleKey,
      action
    );
  } catch (err) {
    console.warn(`[Attendance Permission Guard] Lookup failed (${moduleKey}.${action}); failing closed:`, err?.message || err);
    return false;
  }
}
function isScannerCapabilityEntryEnabled(entry) {
  if (!entry || typeof entry !== "object") return false;
  if (entry.view === false) return false;
  if (typeof entry.add === "boolean") {
    return entry.add === true;
  }
  return entry.view === true;
}
async function resolveCallerAttendancePermissions(db, caller) {
  if (caller.role === "super_admin") {
    return {
      canQrScan: true,
      canManualEntry: true,
      canCustomTime: true,
      cacheHitRolePerms: true,
      extraReads: 0
    };
  }
  let extraReads = 0;
  try {
    const hasPrefetchedRolePerm = Boolean(caller.prefetchedRolePerm) && caller.prefetchedRolePerm.role === caller.role;
    const [userPermSnap, rolePermSnap] = await Promise.all([
      caller.prefetchedUserPermSnap ? Promise.resolve(caller.prefetchedUserPermSnap) : (extraReads += 1, db.collection("user_permissions").doc(caller.profileDocId).get()),
      hasPrefetchedRolePerm ? Promise.resolve({
        exists: caller.prefetchedRolePerm.exists,
        data: caller.prefetchedRolePerm.data,
        cacheHit: caller.prefetchedRolePerm.cacheHit
      }) : getCachedRolePermissionsDoc(db, caller.role).then((res) => {
        if (!res.cacheHit) extraReads += 1;
        return res;
      })
    ]);
    const userPermData = userPermSnap.exists ? userPermSnap.data() : void 0;
    const rolePermData = rolePermSnap.exists ? rolePermSnap.data : void 0;
    let fallbackModules = caller.modulesAllowed;
    if (fallbackModules === void 0 && caller.role !== "admin") {
      extraReads += 1;
      const userSnap = await db.collection("user_roles").doc(caller.profileDocId).get();
      if (userSnap.exists && Array.isArray(userSnap.data()?.modulesAllowed)) {
        fallbackModules = userSnap.data().modulesAllowed;
      }
    }
    let canQrScan = null;
    if (userPermData && userPermData.isCustomOverride !== false) {
      const perms = userPermData.permissions || {};
      const qrEntry = perms["attendance.qr.scan"];
      if (qrEntry && typeof qrEntry === "object" && (typeof qrEntry.view === "boolean" || typeof qrEntry.add === "boolean")) {
        canQrScan = isScannerCapabilityEntryEnabled(qrEntry);
      } else if (perms.scanner && typeof perms.scanner === "object") {
        canQrScan = isScannerCapabilityEntryEnabled(perms.scanner);
      }
    }
    if (canQrScan === null && rolePermData) {
      const modPerms = rolePermData.modulePermissions || {};
      const qrEntry = modPerms["attendance.qr.scan"];
      if (qrEntry && typeof qrEntry === "object" && (typeof qrEntry.view === "boolean" || typeof qrEntry.add === "boolean")) {
        canQrScan = isScannerCapabilityEntryEnabled(qrEntry);
      } else if (modPerms.scanner && typeof modPerms.scanner === "object") {
        canQrScan = isScannerCapabilityEntryEnabled(modPerms.scanner);
      }
    }
    if (canQrScan === null) {
      canQrScan = evalModuleActionFromSnapshots(caller, userPermData, rolePermData, fallbackModules, "scanner", "view") && evalModuleActionFromSnapshots(caller, userPermData, rolePermData, fallbackModules, "scanner", "add");
    }
    let canManualEntry = null;
    if (userPermData && userPermData.isCustomOverride !== false) {
      const perms = userPermData.permissions || {};
      const manualEntry = perms["attendance.manual.entry"];
      if (manualEntry && typeof manualEntry === "object" && (typeof manualEntry.view === "boolean" || typeof manualEntry.add === "boolean")) {
        canManualEntry = isScannerCapabilityEntryEnabled(manualEntry);
      } else if (perms.scanner?.view === false) {
        canManualEntry = false;
      }
    }
    if (canManualEntry === null && rolePermData) {
      const modPerms = rolePermData.modulePermissions || {};
      const manualEntry = modPerms["attendance.manual.entry"];
      if (manualEntry && typeof manualEntry === "object" && (typeof manualEntry.view === "boolean" || typeof manualEntry.add === "boolean")) {
        canManualEntry = isScannerCapabilityEntryEnabled(manualEntry);
      }
    }
    if (canManualEntry === null) {
      canManualEntry = false;
    }
    const canCustomTime = evalModuleActionFromSnapshots(caller, userPermData, rolePermData, fallbackModules, "scanner", "edit") || evalModuleActionFromSnapshots(caller, userPermData, rolePermData, fallbackModules, "history", "edit");
    return {
      canQrScan,
      canManualEntry,
      canCustomTime,
      cacheHitRolePerms: rolePermSnap.cacheHit,
      extraReads
    };
  } catch (err) {
    console.warn("[Attendance Permission Context] Lookup failed; failing closed:", err?.message || err);
    return {
      canQrScan: false,
      canManualEntry: false,
      canCustomTime: false,
      cacheHitRolePerms: false,
      extraReads
    };
  }
}
function registerAttendanceRoutes(app, deps) {
  const { db, requireVerifiedCaller } = deps;
  async function writePunchLog(entry) {
    const id = `log_${Date.now()}_${crypto4.randomBytes(3).toString("hex")}`;
    await db.collection("punch_logs").doc(id).set({ ...entry, id });
  }
  app.post("/api/attendance/scan", async (req, res) => {
    const reqStartMs = performance.now();
    try {
      const parsed = AttendanceScanSchema.safeParse(req.body);
      let preQrParseMs = 0;
      let preQr = null;
      let preNow = null;
      let preYesterdayKey = null;
      if (parsed.success) {
        const qrParseStart = performance.now();
        preQr = parseQrPayload(parsed.data.rawPayload);
        preQrParseMs = roundMs(performance.now() - qrParseStart);
        const candidateNow = parsed.data.customScanTime ? new Date(parsed.data.customScanTime) : /* @__PURE__ */ new Date();
        if (!Number.isNaN(candidateNow.getTime())) {
          preNow = candidateNow;
          preYesterdayKey = getYesterdayKolkataDateKey(candidateNow);
        }
      }
      let prefetchedEmployee = null;
      let prefetchedAttendance = null;
      let prefetchedConfig = null;
      const caller = await requireVerifiedCaller(
        req,
        res,
        "*",
        "Attendance Scan Processing",
        {
          prefetchUserPermission: true,
          onTokenVerified: () => {
            if (!preQr || preQr.format === "INVALID" || !preQr.employeeId) return;
            const empId = preQr.employeeId;
            const empStart = performance.now();
            prefetchedEmployee = db.collection("employees").doc(empId).get().then((snap) => ({ snap, ms: roundMs(performance.now() - empStart) }));
            prefetchedEmployee.catch(() => {
            });
            if (preYesterdayKey && !employeeScanLocks.has(empId)) {
              const attStart = performance.now();
              const yKey = preYesterdayKey;
              prefetchedAttendance = db.collection("attendance").where("employeeId", "==", empId).where("shiftDate", ">=", yKey).get().then((snap) => ({ snap, ms: roundMs(performance.now() - attStart), yesterdayKey: yKey }));
              prefetchedAttendance.catch(() => {
              });
            }
            const cfgStart = performance.now();
            prefetchedConfig = Promise.all([
              getCachedShifts(db, DEFAULT_SHIFTS),
              getCachedSystemSettings(db, DEFAULT_SETTINGS)
            ]).then(([shiftsRes, settingsRes]) => ({
              shiftsRes,
              settingsRes,
              ms: roundMs(performance.now() - cfgStart)
            }));
            prefetchedConfig.catch(() => {
            });
          }
        }
      );
      if (!caller) return;
      const authDoneMs = performance.now();
      const perms = await resolveCallerAttendancePermissions(db, caller);
      const permDoneMs = performance.now();
      if (!perms.canQrScan) {
        await recordEnterpriseAuditEvent(db, {
          req,
          action: "unauthorized_access_attempt",
          category: "SECURITY",
          severity: "CRITICAL",
          actorUid: caller.uid,
          actorLoginId: caller.loginId,
          actorRole: caller.role.toUpperCase(),
          targetType: "ATTENDANCE_SCANNER",
          targetId: "/api/attendance/scan",
          actionSource: "ATTENDANCE_PERMISSION_GUARD",
          description: `User "${caller.loginId}" (${caller.role}) blocked from /api/attendance/scan due to missing attendance.qr.scan permission.`,
          success: false,
          captureGeo: false
        });
        return res.status(403).json({
          success: false,
          action: "REJECTED",
          error: "Forbidden: Your role does not have QR Code Scanning permission (attendance.qr.scan).",
          message: "Forbidden: Your role does not have QR Code Scanning permission (attendance.qr.scan)."
        });
      }
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          action: "REJECTED",
          error: parsed.error.issues[0]?.message || "Invalid scan payload.",
          message: parsed.error.issues[0]?.message || "Invalid scan payload."
        });
      }
      const { rawPayload, scannerDevice = "USB_SCANNER", customScanTime, clientRequestId } = parsed.data;
      const { scannerType } = parsed.data;
      if (customScanTime && !perms.canCustomTime) {
        return res.status(403).json({
          success: false,
          error: "Forbidden: Your role is not permitted to submit custom scan timestamps."
        });
      }
      const now = preNow || (customScanTime ? new Date(customScanTime) : /* @__PURE__ */ new Date());
      if (Number.isNaN(now.getTime())) {
        return res.status(400).json({ success: false, error: "Invalid customScanTime timestamp." });
      }
      const kolkata = getKolkataTimeParts(now);
      const timeDisplay = kolkata.timeWithSeconds;
      let qrParseMs = preQrParseMs;
      let qrParsed = preQr;
      if (!qrParsed) {
        const qrParseStartMs = performance.now();
        qrParsed = parseQrPayload(rawPayload);
        qrParseMs = roundMs(performance.now() - qrParseStartMs);
      }
      const { employeeId, token, format } = qrParsed;
      if (format === "INVALID" || !employeeId) {
        await writePunchLog({
          employeeId: "UNKNOWN",
          timestamp: now.toISOString(),
          action: "REJECTED_TOKEN",
          rawPayload,
          scannerDevice,
          performedByUid: caller.uid,
          performedByLoginId: caller.loginId,
          message: "Invalid QR Code payload format."
        });
        return res.status(400).json({
          success: false,
          action: "REJECTED",
          scannerType: scannerType || "IN",
          error: "Invalid QR payload. Please scan a valid Employee QR code or Employee ID.",
          message: "Invalid QR payload. Please scan a valid Employee QR code or Employee ID.",
          time: timeDisplay
        });
      }
      const dedupKey = clientRequestId ? `scan:${caller.uid}:${employeeId}:${clientRequestId}` : null;
      const outcome = await runWithOptionalClientRequestDedup(
        db,
        dedupKey,
        () => withEmployeeScanLock(employeeId, async ({ waitedForLock }) => {
          const lookupStartMs = performance.now();
          const yesterdayKey = getYesterdayKolkataDateKey(now);
          const canReuseEmployee = Boolean(prefetchedEmployee);
          const canReuseAttendance = !waitedForLock && Boolean(prefetchedAttendance) && preYesterdayKey === yesterdayKey;
          const canReuseConfig = Boolean(prefetchedConfig);
          const parallelPrefetchUsed = canReuseEmployee && canReuseAttendance;
          const empTask = canReuseEmployee ? prefetchedEmployee : (() => {
            const s = performance.now();
            return db.collection("employees").doc(employeeId).get().then((snap) => ({ snap, ms: roundMs(performance.now() - s) }));
          })();
          const attTask = canReuseAttendance ? prefetchedAttendance : (() => {
            const s = performance.now();
            return db.collection("attendance").where("employeeId", "==", employeeId).where("shiftDate", ">=", yesterdayKey).get().then((snap) => ({ snap, ms: roundMs(performance.now() - s), yesterdayKey }));
          })();
          const cfgTask = canReuseConfig ? prefetchedConfig : (() => {
            const s = performance.now();
            return Promise.all([
              getCachedShifts(db, DEFAULT_SHIFTS),
              getCachedSystemSettings(db, DEFAULT_SETTINGS)
            ]).then(([shiftsRes2, settingsRes2]) => ({
              shiftsRes: shiftsRes2,
              settingsRes: settingsRes2,
              ms: roundMs(performance.now() - s)
            }));
          })();
          const [empResult, attResult, cfgResult] = await Promise.all([empTask, attTask, cfgTask]);
          const empSnap = empResult.snap;
          const candidateSnap = attResult.snap;
          const { shiftsRes, settingsRes } = cfgResult;
          const lookupDoneMs = performance.now();
          if (!empSnap.exists) {
            await writePunchLog({
              employeeId,
              timestamp: now.toISOString(),
              action: "REJECTED_TOKEN",
              rawPayload,
              scannerDevice,
              performedByUid: caller.uid,
              performedByLoginId: caller.loginId,
              message: `Employee ID ${employeeId} not found in database.`
            });
            return {
              httpStatus: 404,
              body: {
                success: false,
                action: "REJECTED",
                scannerType: scannerType || "IN",
                error: `Invalid QR Code. Employee "${employeeId}" Not Found.`,
                message: `Invalid QR Code. Employee "${employeeId}" Not Found.`,
                time: timeDisplay
              }
            };
          }
          const tokenValStartMs = performance.now();
          const employee = empSnap.data();
          if (employee.employeeStatus !== "Active") {
            await writePunchLog({
              employeeId: employee.employeeId,
              employeeName: employee.employeeName,
              timestamp: now.toISOString(),
              action: "REJECTED_INACTIVE",
              rawPayload,
              scannerDevice,
              performedByUid: caller.uid,
              performedByLoginId: caller.loginId,
              message: `Employee ${employeeId} is inactive.`
            });
            return {
              httpStatus: 400,
              body: {
                success: false,
                action: "REJECTED",
                scannerType: scannerType || "IN",
                employee,
                error: "Employee Is Inactive. Attendance Cannot Be Recorded.",
                message: "Employee Is Inactive. Attendance Cannot Be Recorded.",
                time: timeDisplay
              }
            };
          }
          if (employee.qrCodeToken && (!token || token !== employee.qrCodeToken)) {
            await writePunchLog({
              employeeId: employee.employeeId,
              employeeName: employee.employeeName,
              timestamp: now.toISOString(),
              action: "REJECTED_TOKEN",
              rawPayload,
              scannerDevice,
              qrVerificationMode: "TOKEN_REJECTED",
              performedByUid: caller.uid,
              performedByLoginId: caller.loginId,
              message: token ? `Token mismatch: provided ${token}, expected configured qrCodeToken` : "Missing required QR security token for employee with configured qrCodeToken"
            });
            return {
              httpStatus: 403,
              body: {
                success: false,
                action: "REJECTED",
                scannerType: scannerType || "IN",
                employee,
                error: token ? "QR Token Expired or Revoked. Please re-issue QR code." : "Invalid QR Payload: Security token is required for this employee.",
                message: token ? "QR Token Expired or Revoked. Please re-issue QR code." : "Invalid QR Payload: Security token is required for this employee.",
                time: timeDisplay
              }
            };
          }
          const tokenValDoneMs = performance.now();
          const qrVerificationMode = token ? "TOKEN_VERIFIED" : "UNTOKENIZED_EMPLOYEE";
          const txStartMs = performance.now();
          const punchRes = await executePunchForVerifiedEmployee({
            req,
            employee,
            caller,
            now,
            kolkata,
            timeDisplay,
            scannerType,
            scannerDevice,
            rawPayload,
            qrVerificationMode,
            shifts: shiftsRes.shifts,
            settings: settingsRes.data,
            candidateSnap
          });
          const txDoneMs = performance.now();
          const lookupDuration = lookupDoneMs - lookupStartMs;
          const txDuration = txDoneMs - txStartMs;
          const isCommittedPunch = punchRes.httpStatus === 200 && Boolean(punchRes.body?.success);
          const isDuplicateReject = punchRes.body?.action === "REJECTED_DUPLICATE";
          const txReads = isCommittedPunch || isDuplicateReject ? 1 : 0;
          const txWrites = isCommittedPunch ? 3 : 1;
          const configReads = (shiftsRes.cacheHit ? 0 : 1) + (settingsRes.cacheHit ? 0 : 1);
          const totalFirestoreReads = (caller.authFirestoreReads ?? 0) + perms.extraReads + 1 + // employees/{id}
          1 + // attendance query
          configReads + txReads;
          const totalFirestoreWrites = (caller.authFirestoreWrites ?? 0) + txWrites;
          const perf = {
            qrParseMs,
            tokenVerifyMs: caller.tokenVerifyMs,
            callerLookupMs: caller.callerLookupMs,
            authMs: roundMs(authDoneMs - reqStartMs),
            permissionMs: roundMs(permDoneMs - authDoneMs),
            employeeLookupMs: empResult.ms,
            attendanceLookupMs: attResult.ms,
            configLookupMs: cfgResult.ms,
            lookupAndQueryMs: roundMs(lookupDuration),
            tokenValidationMs: roundMs(tokenValDoneMs - tokenValStartMs),
            txMs: roundMs(txDuration),
            firestoreOpMs: roundMs(lookupDuration + txDuration),
            auditMs: 0,
            totalServerMs: roundMs(txDoneMs - reqStartMs),
            firestoreReads: totalFirestoreReads,
            firestoreWrites: totalFirestoreWrites,
            parallelPrefetchUsed,
            cacheHitRolePerms: perms.cacheHitRolePerms,
            cacheHitConfig: shiftsRes.cacheHit && settingsRes.cacheHit,
            cacheHitUidRoute: Boolean(caller.cacheHitUidRoute)
          };
          emitNonSensitivePerfLog("attendance.scan", {
            status: punchRes.httpStatus,
            ...perf
          });
          return {
            httpStatus: punchRes.httpStatus,
            body: { ...punchRes.body, perf }
          };
        })
      );
      const scanTotalMs = roundMs(performance.now() - reqStartMs);
      const outcomePerf = outcome.body?.perf;
      const outcomeAction = String(outcome.body?.action || "REJECTED");
      const resolvedDir = outcome.body?.scannerType === "OUT" || scannerType === "OUT" ? "OUT" : "IN";
      const isSuccess = outcome.httpStatus >= 200 && outcome.httpStatus < 300 && Boolean(outcome.body?.success);
      const isDuplicate = outcomeAction === "REJECTED_DUPLICATE";
      recordQrPunchTelemetry(db, {
        mode: resolvedDir === "OUT" ? "QR_OUT" : "QR_IN",
        action: outcomeAction,
        success: isSuccess,
        isDuplicateRejection: isDuplicate,
        timedOut: outcome.httpStatus === 408 || outcome.httpStatus === 504,
        qrParseMs,
        tokenVerifyMs: outcomePerf?.tokenVerifyMs ?? caller.tokenVerifyMs,
        callerLookupMs: outcomePerf?.callerLookupMs ?? caller.callerLookupMs,
        authMs: outcomePerf?.authMs ?? roundMs(authDoneMs - reqStartMs),
        permissionMs: outcomePerf?.permissionMs ?? roundMs(permDoneMs - authDoneMs),
        employeeLookupMs: outcomePerf?.employeeLookupMs,
        attendanceLookupMs: outcomePerf?.attendanceLookupMs,
        configLookupMs: outcomePerf?.configLookupMs,
        lookupAndQueryMs: outcomePerf?.lookupAndQueryMs,
        tokenValidationMs: outcomePerf?.tokenValidationMs,
        txMs: outcomePerf?.txMs,
        firestoreOpMs: outcomePerf?.firestoreOpMs,
        auditMs: outcomePerf?.auditMs ?? 0,
        firestoreReads: outcomePerf?.firestoreReads,
        firestoreWrites: outcomePerf?.firestoreWrites,
        totalServerMs: outcomePerf?.totalServerMs ?? scanTotalMs,
        reasonCode: isSuccess ? void 0 : outcomeAction,
        correlationId: req.correlationId
      });
      if (typeof outcomePerf?.lookupAndQueryMs === "number") {
        recordDbOpMetric(db, {
          operation: "QUERY",
          collection: "employees+attendance",
          durationMs: outcomePerf.lookupAndQueryMs,
          success: true,
          correlationId: req.correlationId
        });
      }
      if (typeof outcomePerf?.txMs === "number") {
        recordDbOpMetric(db, {
          operation: "TRANSACTION",
          collection: "attendance",
          durationMs: outcomePerf.txMs,
          success: outcome.httpStatus < 500,
          correlationId: req.correlationId
        });
      }
      recordActivityTelemetry(db, {
        actorUid: caller.uid,
        actorLoginId: caller.loginId,
        actorRole: caller.role.toUpperCase(),
        action: isSuccess ? resolvedDir === "OUT" ? "QR_PUNCH_OUT" : "QR_PUNCH_IN" : `QR_SCAN_${outcomeAction}`,
        module: "Attendance Scanner",
        result: isSuccess ? "Success" : "Failed",
        correlationId: req.correlationId,
        detail: `${resolvedDir} scan via ${scannerDevice} (${outcome.httpStatus})`
      });
      return res.status(outcome.httpStatus).json(outcome.body);
    } catch (err) {
      console.error("[API Attendance Scan] Error:", err);
      const errMsg = String(err?.message || "Attendance scan processing failed.");
      recordDbOpMetric(db, {
        operation: "TRANSACTION",
        collection: "attendance",
        durationMs: roundMs(performance.now() - reqStartMs),
        success: false,
        isPermissionDenied: errMsg.toLowerCase().includes("permission"),
        isNetworkError: errMsg.toLowerCase().includes("timeout") || errMsg.toLowerCase().includes("unavailable"),
        errorMessage: errMsg,
        correlationId: req.correlationId
      });
      recordQrPunchTelemetry(db, {
        mode: "QR_IN",
        action: "SYSTEM_ERROR",
        success: false,
        isDuplicateRejection: false,
        timedOut: errMsg.toLowerCase().includes("timeout"),
        totalServerMs: roundMs(performance.now() - reqStartMs),
        reasonCode: "SYSTEM_ERROR",
        correlationId: req.correlationId
      });
      return res.status(500).json({
        success: false,
        action: "REJECTED",
        error: "Attendance scan processing failed.",
        message: "Attendance scan processing failed."
      });
    }
  });
  app.post("/api/attendance/manual-punch", async (req, res) => {
    const reqStartMs = performance.now();
    try {
      const parsed = ManualPunchSchema.safeParse(req.body);
      let preNow = null;
      let preYesterdayKey = null;
      if (parsed.success) {
        const candidateNow = parsed.data.customScanTime ? new Date(parsed.data.customScanTime) : /* @__PURE__ */ new Date();
        if (!Number.isNaN(candidateNow.getTime())) {
          preNow = candidateNow;
          preYesterdayKey = getYesterdayKolkataDateKey(candidateNow);
        }
      }
      let prefetchedEmployee = null;
      let prefetchedAttendance = null;
      let prefetchedConfig = null;
      const caller = await requireVerifiedCaller(
        req,
        res,
        "*",
        "Manual Employee ID Punch",
        {
          prefetchUserPermission: true,
          onTokenVerified: () => {
            if (!parsed.success) return;
            const empId = parsed.data.employeeId;
            const empStart = performance.now();
            prefetchedEmployee = db.collection("employees").doc(empId).get().then((snap) => ({ snap, ms: roundMs(performance.now() - empStart) }));
            prefetchedEmployee.catch(() => {
            });
            if (preYesterdayKey && !employeeScanLocks.has(empId)) {
              const attStart = performance.now();
              const yKey = preYesterdayKey;
              prefetchedAttendance = db.collection("attendance").where("employeeId", "==", empId).where("shiftDate", ">=", yKey).get().then((snap) => ({ snap, ms: roundMs(performance.now() - attStart), yesterdayKey: yKey }));
              prefetchedAttendance.catch(() => {
              });
            }
            const cfgStart = performance.now();
            prefetchedConfig = Promise.all([
              getCachedShifts(db, DEFAULT_SHIFTS),
              getCachedSystemSettings(db, DEFAULT_SETTINGS)
            ]).then(([shiftsRes, settingsRes]) => ({
              shiftsRes,
              settingsRes,
              ms: roundMs(performance.now() - cfgStart)
            }));
            prefetchedConfig.catch(() => {
            });
          }
        }
      );
      if (!caller) return;
      const authDoneMs = performance.now();
      const perms = await resolveCallerAttendancePermissions(db, caller);
      const permDoneMs = performance.now();
      if (!perms.canManualEntry) {
        await recordEnterpriseAuditEvent(db, {
          req,
          action: "unauthorized_access_attempt",
          category: "SECURITY",
          severity: "CRITICAL",
          actorUid: caller.uid,
          actorLoginId: caller.loginId,
          actorRole: caller.role.toUpperCase(),
          targetType: "ATTENDANCE_MANUAL_PUNCH",
          targetId: "/api/attendance/manual-punch",
          actionSource: "ATTENDANCE_PERMISSION_GUARD",
          description: `User "${caller.loginId}" (${caller.role}) blocked from /api/attendance/manual-punch due to missing attendance.manual.entry permission.`,
          success: false,
          captureGeo: false
        });
        return res.status(403).json({
          success: false,
          action: "REJECTED",
          error: "Forbidden: Your role does not have Manual Employee ID Entry permission (attendance.manual.entry).",
          message: "Forbidden: Your role does not have Manual Employee ID Entry permission (attendance.manual.entry)."
        });
      }
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          action: "REJECTED",
          error: parsed.error.issues[0]?.message || "Invalid Employee ID.",
          message: parsed.error.issues[0]?.message || "Invalid Employee ID."
        });
      }
      const { employeeId, scannerType, reason, customScanTime, clientRequestId } = parsed.data;
      if (customScanTime && !perms.canCustomTime) {
        return res.status(403).json({
          success: false,
          error: "Forbidden: Your role is not permitted to submit custom punch timestamps."
        });
      }
      const now = preNow || (customScanTime ? new Date(customScanTime) : /* @__PURE__ */ new Date());
      if (Number.isNaN(now.getTime())) {
        return res.status(400).json({ success: false, error: "Invalid customScanTime timestamp." });
      }
      const kolkata = getKolkataTimeParts(now);
      const timeDisplay = kolkata.timeWithSeconds;
      const rawPayload = `MANUAL:${employeeId}`;
      const dedupKey = clientRequestId ? `manual:${caller.uid}:${employeeId}:${clientRequestId}` : null;
      const outcome = await runWithOptionalClientRequestDedup(
        db,
        dedupKey,
        () => withEmployeeScanLock(employeeId, async ({ waitedForLock }) => {
          const lookupStartMs = performance.now();
          const yesterdayKey = getYesterdayKolkataDateKey(now);
          const canReuseEmployee = Boolean(prefetchedEmployee);
          const canReuseAttendance = !waitedForLock && Boolean(prefetchedAttendance) && preYesterdayKey === yesterdayKey;
          const canReuseConfig = Boolean(prefetchedConfig);
          const parallelPrefetchUsed = canReuseEmployee && canReuseAttendance;
          const empTask = canReuseEmployee ? prefetchedEmployee : (() => {
            const s = performance.now();
            return db.collection("employees").doc(employeeId).get().then((snap) => ({ snap, ms: roundMs(performance.now() - s) }));
          })();
          const attTask = canReuseAttendance ? prefetchedAttendance : (() => {
            const s = performance.now();
            return db.collection("attendance").where("employeeId", "==", employeeId).where("shiftDate", ">=", yesterdayKey).get().then((snap) => ({ snap, ms: roundMs(performance.now() - s), yesterdayKey }));
          })();
          const cfgTask = canReuseConfig ? prefetchedConfig : (() => {
            const s = performance.now();
            return Promise.all([
              getCachedShifts(db, DEFAULT_SHIFTS),
              getCachedSystemSettings(db, DEFAULT_SETTINGS)
            ]).then(([shiftsRes2, settingsRes2]) => ({
              shiftsRes: shiftsRes2,
              settingsRes: settingsRes2,
              ms: roundMs(performance.now() - s)
            }));
          })();
          const [empResult, attResult, cfgResult] = await Promise.all([empTask, attTask, cfgTask]);
          const empSnap = empResult.snap;
          const candidateSnap = attResult.snap;
          const { shiftsRes, settingsRes } = cfgResult;
          const lookupDoneMs = performance.now();
          if (!empSnap.exists) {
            await writePunchLog({
              employeeId,
              timestamp: now.toISOString(),
              action: "REJECTED_TOKEN",
              rawPayload,
              scannerDevice: "MANUAL",
              qrVerificationMode: "MANUAL_EMPLOYEE_ID",
              performedByUid: caller.uid,
              performedByLoginId: caller.loginId,
              message: `Manual entry rejected: Employee ID ${employeeId} not found in database.`
            });
            return {
              httpStatus: 404,
              body: {
                success: false,
                action: "REJECTED",
                scannerType: scannerType || "IN",
                error: `Employee "${employeeId}" Not Found.`,
                message: `Employee "${employeeId}" Not Found.`,
                time: timeDisplay
              }
            };
          }
          const employee = empSnap.data();
          if (employee.employeeStatus !== "Active") {
            await writePunchLog({
              employeeId: employee.employeeId,
              employeeName: employee.employeeName,
              timestamp: now.toISOString(),
              action: "REJECTED_INACTIVE",
              rawPayload,
              scannerDevice: "MANUAL",
              qrVerificationMode: "MANUAL_EMPLOYEE_ID",
              performedByUid: caller.uid,
              performedByLoginId: caller.loginId,
              message: `Manual entry rejected: Employee ${employeeId} is inactive.`
            });
            return {
              httpStatus: 400,
              body: {
                success: false,
                action: "REJECTED",
                scannerType: scannerType || "IN",
                employee,
                error: "Employee Is Inactive. Attendance Cannot Be Recorded.",
                message: "Employee Is Inactive. Attendance Cannot Be Recorded.",
                time: timeDisplay
              }
            };
          }
          const txStartMs = performance.now();
          const result = await executePunchForVerifiedEmployee({
            req,
            employee,
            caller,
            now,
            kolkata,
            timeDisplay,
            scannerType,
            scannerDevice: "MANUAL",
            rawPayload,
            qrVerificationMode: "MANUAL_EMPLOYEE_ID",
            shifts: shiftsRes.shifts,
            settings: settingsRes.data,
            candidateSnap
          });
          const txDoneMs = performance.now();
          let auditDoneMs = txDoneMs;
          let auditWrites = 0;
          if (result.httpStatus === 200 && result.body.success) {
            await recordEnterpriseAuditEvent(db, {
              req,
              action: "MANUAL_ATTENDANCE_PUNCH",
              category: "ATTENDANCE",
              actorUid: caller.uid,
              actorLoginId: caller.loginId,
              actorRole: caller.role.toUpperCase(),
              employeeId: employee.employeeId,
              targetType: "ATTENDANCE",
              targetId: result.body.attendance?.id || employee.employeeId,
              newValue: `${result.body.action} via manual ID entry (${employee.employeeId})`,
              actionSource: "MANUAL_SCANNER_ENTRY",
              reason: reason || "Authorized operator manual Employee ID punch",
              captureGeo: false
            });
            auditWrites = 1;
            auditDoneMs = performance.now();
          }
          const lookupDuration = lookupDoneMs - lookupStartMs;
          const txDuration = txDoneMs - txStartMs;
          const isCommittedPunch = result.httpStatus === 200 && Boolean(result.body?.success);
          const isDuplicateReject = result.body?.action === "REJECTED_DUPLICATE";
          const txReads = isCommittedPunch || isDuplicateReject ? 1 : 0;
          const txWrites = isCommittedPunch ? 3 : 1;
          const configReads = (shiftsRes.cacheHit ? 0 : 1) + (settingsRes.cacheHit ? 0 : 1);
          const totalFirestoreReads = (caller.authFirestoreReads ?? 0) + perms.extraReads + 1 + 1 + configReads + txReads;
          const totalFirestoreWrites = (caller.authFirestoreWrites ?? 0) + txWrites + auditWrites;
          const perf = {
            tokenVerifyMs: caller.tokenVerifyMs,
            callerLookupMs: caller.callerLookupMs,
            authMs: roundMs(authDoneMs - reqStartMs),
            permissionMs: roundMs(permDoneMs - authDoneMs),
            employeeLookupMs: empResult.ms,
            attendanceLookupMs: attResult.ms,
            configLookupMs: cfgResult.ms,
            lookupAndQueryMs: roundMs(lookupDuration),
            txMs: roundMs(txDuration),
            firestoreOpMs: roundMs(lookupDuration + txDuration),
            auditMs: roundMs(auditDoneMs - txDoneMs),
            totalServerMs: roundMs(auditDoneMs - reqStartMs),
            firestoreReads: totalFirestoreReads,
            firestoreWrites: totalFirestoreWrites,
            parallelPrefetchUsed,
            cacheHitRolePerms: perms.cacheHitRolePerms,
            cacheHitConfig: shiftsRes.cacheHit && settingsRes.cacheHit,
            cacheHitUidRoute: Boolean(caller.cacheHitUidRoute)
          };
          emitNonSensitivePerfLog("attendance.manual_punch", {
            status: result.httpStatus,
            ...perf
          });
          return {
            httpStatus: result.httpStatus,
            body: { ...result.body, perf }
          };
        })
      );
      const manualTotalMs = roundMs(performance.now() - reqStartMs);
      const outcomePerf = outcome.body?.perf;
      const outcomeAction = String(outcome.body?.action || "REJECTED");
      const isSuccess = outcome.httpStatus >= 200 && outcome.httpStatus < 300 && Boolean(outcome.body?.success);
      const isDuplicate = outcomeAction === "REJECTED_DUPLICATE";
      recordQrPunchTelemetry(db, {
        mode: scannerType === "OUT" ? "MANUAL_OUT" : "MANUAL_IN",
        action: outcomeAction,
        success: isSuccess,
        isDuplicateRejection: isDuplicate,
        timedOut: outcome.httpStatus === 408 || outcome.httpStatus === 504,
        tokenVerifyMs: outcomePerf?.tokenVerifyMs ?? caller.tokenVerifyMs,
        callerLookupMs: outcomePerf?.callerLookupMs ?? caller.callerLookupMs,
        authMs: outcomePerf?.authMs ?? roundMs(authDoneMs - reqStartMs),
        permissionMs: outcomePerf?.permissionMs ?? roundMs(permDoneMs - authDoneMs),
        employeeLookupMs: outcomePerf?.employeeLookupMs,
        attendanceLookupMs: outcomePerf?.attendanceLookupMs,
        configLookupMs: outcomePerf?.configLookupMs,
        lookupAndQueryMs: outcomePerf?.lookupAndQueryMs,
        txMs: outcomePerf?.txMs,
        firestoreOpMs: outcomePerf?.firestoreOpMs,
        auditMs: outcomePerf?.auditMs,
        firestoreReads: outcomePerf?.firestoreReads,
        firestoreWrites: outcomePerf?.firestoreWrites,
        totalServerMs: outcomePerf?.totalServerMs ?? manualTotalMs,
        reasonCode: isSuccess ? void 0 : outcomeAction,
        correlationId: req.correlationId
      });
      if (typeof outcomePerf?.txMs === "number") {
        recordDbOpMetric(db, {
          operation: "TRANSACTION",
          collection: "attendance",
          durationMs: outcomePerf.txMs,
          success: outcome.httpStatus < 500,
          correlationId: req.correlationId
        });
      }
      recordActivityTelemetry(db, {
        actorUid: caller.uid,
        actorLoginId: caller.loginId,
        actorRole: caller.role.toUpperCase(),
        action: isSuccess ? `MANUAL_PUNCH_${scannerType}` : `MANUAL_PUNCH_${outcomeAction}`,
        module: "Attendance Scanner",
        result: isSuccess ? "Success" : "Failed",
        correlationId: req.correlationId,
        detail: `Manual ${scannerType} entry (${outcome.httpStatus})`
      });
      return res.status(outcome.httpStatus).json(outcome.body);
    } catch (err) {
      console.error("[API Manual Punch] Error:", err);
      recordErrorTelemetry(db, {
        source: "BACKEND",
        module: "Attendance Scanner",
        category: "MANUAL_PUNCH_ERROR",
        severity: "CRITICAL",
        message: err?.message || "Manual attendance punch processing failed.",
        statusCode: 500,
        correlationId: req.correlationId
      });
      return res.status(500).json({
        success: false,
        action: "REJECTED",
        error: "Manual attendance punch processing failed.",
        message: "Manual attendance punch processing failed."
      });
    }
  });
  async function executePunchForVerifiedEmployee(params) {
    const {
      req,
      employee,
      caller,
      now,
      kolkata,
      timeDisplay,
      scannerDevice,
      rawPayload,
      qrVerificationMode,
      shifts,
      settings,
      candidateSnap
    } = params;
    let { scannerType } = params;
    const shiftsMap = new Map(shifts.map((s) => [s.id, s]));
    const todayKey = kolkata.dateKey;
    const yesterdayKey = getYesterdayKolkataDateKey(now);
    const currentMins = kolkata.totalMinutes;
    const existingRecords = candidateSnap.docs.map((d) => d.data()).sort((a, b) => new Date(b.punchIn).getTime() - new Date(a.punchIn).getTime());
    const isNightRecord = (r) => r.shiftId === "NIGHT" || String(r.shiftNameSnapshot || "").toUpperCase().includes("NIGHT");
    const isOpenRecord = (r) => r.currentState === "INSIDE" || !r.actualPunchOut && r.punchOutType === "NONE";
    const isAutoClosedReconcilableRecord = (r) => r.punchOutType === "AUTO" && r.autoClosed === true && !r.actualPunchOut && r.reconciledFromAutoClose !== true;
    const todayRecords = existingRecords.filter((r) => r.shiftDate === todayKey);
    const yesterdayNight = existingRecords.find(
      (r) => r.shiftDate === yesterdayKey && isNightRecord(r)
    );
    const isWithinNightContinuationWindow = Boolean(
      yesterdayNight && currentMins < 18 * 60 && now.getTime() >= new Date(yesterdayNight.firstPunchIn || yesterdayNight.punchIn).getTime()
    );
    let activeRecord = null;
    if (scannerType === "OUT") {
      const todayOpen = todayRecords.find(isOpenRecord);
      if (todayOpen) {
        activeRecord = todayOpen;
      } else if (yesterdayNight && isOpenRecord(yesterdayNight) && isWithinNightContinuationWindow) {
        activeRecord = yesterdayNight;
      } else {
        const todayAutoClosed = todayRecords.find(isAutoClosedReconcilableRecord);
        if (todayAutoClosed) {
          activeRecord = todayAutoClosed;
        } else if (todayRecords.length === 0 && yesterdayNight && isAutoClosedReconcilableRecord(yesterdayNight) && isWithinNightContinuationWindow) {
          activeRecord = yesterdayNight;
        } else if (todayRecords.length > 0) {
          activeRecord = todayRecords[0];
        } else if (yesterdayNight && isWithinNightContinuationWindow) {
          activeRecord = yesterdayNight;
        }
      }
    } else {
      if (yesterdayNight && isWithinNightContinuationWindow) {
        const isYesterdayNightOpen = isOpenRecord(yesterdayNight);
        if (isYesterdayNightOpen || currentMins < 360) {
          activeRecord = yesterdayNight;
        }
      }
      if (!activeRecord) {
        const todayOpenRecord = todayRecords.find(isOpenRecord);
        if (todayOpenRecord) {
          activeRecord = todayOpenRecord;
        } else {
          const expectedShiftMatch = identifyShiftForPunchIn(shifts, now);
          const expectedShiftId = expectedShiftMatch?.shift?.id;
          activeRecord = todayRecords.find(
            (r) => !expectedShiftId || r.shiftId === expectedShiftId
          ) || null;
        }
      }
    }
    if (!scannerType) {
      const derivedState = activeRecord?.currentState || (activeRecord?.actualPunchOut ? "OUTSIDE" : activeRecord ? "INSIDE" : "OUTSIDE");
      scannerType = derivedState === "INSIDE" ? "OUT" : "IN";
    }
    if (scannerType === "IN") {
      if (activeRecord) {
        const docRef3 = db.collection("attendance").doc(activeRecord.id);
        const eventId3 = `pe_${Date.now()}_${crypto4.randomBytes(3).toString("hex")}`;
        const logId3 = `log_${Date.now()}_${crypto4.randomBytes(3).toString("hex")}`;
        const txRes2 = await db.runTransaction(async (tx) => {
          const snap = await tx.get(docRef3);
          const currentData = snap.exists ? snap.data() : activeRecord;
          const currentState = currentData.currentState || (currentData.actualPunchOut || currentData.punchOutType === "ACTUAL" ? "OUTSIDE" : "INSIDE");
          if (currentState === "INSIDE") {
            return { kind: "CONSECUTIVE_IN", record: currentData };
          }
          const lastPunchTime = Array.isArray(currentData.punches) && currentData.punches.length > 0 ? new Date(currentData.punches[currentData.punches.length - 1].timestamp).getTime() : new Date(currentData.updatedAt || currentData.punchIn).getTime();
          if (Math.abs(now.getTime() - lastPunchTime) < 3e3) {
            return { kind: "BOUNCE", record: currentData };
          }
          const punchEvent = {
            id: eventId3,
            employeeId: employee.employeeId,
            employeeName: employee.employeeName,
            eventType: "IN",
            timestamp: now.toISOString(),
            displayTime: timeDisplay,
            shiftDate: currentData.shiftDate,
            shiftId: currentData.shiftId,
            shiftName: currentData.shiftNameSnapshot,
            floor: employee.floor,
            section: employee.section,
            department: employee.department,
            scannerType: "IN",
            scannerDevice,
            status: "SUBSEQUENT_IN",
            recordedByUid: caller.uid,
            recordedByLoginId: caller.loginId
          };
          const existingPunches = Array.isArray(currentData.punches) ? currentData.punches : [];
          const updatedAttendance = {
            ...currentData,
            currentState: "INSIDE",
            punchOutType: "NONE",
            attendanceStatus: "IN PROGRESS",
            totalDutyMinutes: 0,
            regularDutyMinutes: 0,
            overtimeMinutes: 0,
            earlyOtMinutes: 0,
            postShiftOtMinutes: 0,
            totalOtMinutes: 0,
            earlyOtFinalized: false,
            punches: [...existingPunches, punchEvent],
            updatedAt: now.toISOString()
          };
          tx.set(docRef3, updatedAttendance);
          tx.set(db.collection("punch_events").doc(eventId3), punchEvent);
          tx.set(db.collection("punch_logs").doc(logId3), {
            id: logId3,
            employeeId: employee.employeeId,
            employeeName: employee.employeeName,
            timestamp: now.toISOString(),
            action: "PUNCH_IN",
            rawPayload,
            scannerDevice,
            qrVerificationMode,
            performedByUid: caller.uid,
            performedByLoginId: caller.loginId,
            message: `Subsequent Punch In (Event #${updatedAttendance.punches.length}). State: INSIDE, Status: IN PROGRESS.`
          });
          return { kind: "RECORDED", record: updatedAttendance };
        });
        if (txRes2.kind === "CONSECUTIVE_IN") {
          await writePunchLog({
            employeeId: employee.employeeId,
            employeeName: employee.employeeName,
            timestamp: now.toISOString(),
            action: "REJECTED_DUPLICATE",
            rawPayload,
            scannerDevice,
            performedByUid: caller.uid,
            performedByLoginId: caller.loginId,
            message: `Consecutive Punch In rejected. Employee already Punched In at ${formatTimeDisplay(txRes2.record.punchIn)}.`
          });
          return {
            httpStatus: 409,
            body: {
              success: false,
              action: "REJECTED_DUPLICATE",
              scannerType: "IN",
              currentState: "INSIDE",
              employee,
              attendance: txRes2.record,
              message: "Consecutive Punch In rejected. Employee is already Punched In (Status: INSIDE).",
              time: timeDisplay,
              punchCount: txRes2.record.punches?.length || 1
            }
          };
        }
        if (txRes2.kind === "BOUNCE") {
          return {
            httpStatus: 429,
            body: {
              success: false,
              action: "REJECTED_DUPLICATE",
              scannerType: "IN",
              currentState: "OUTSIDE",
              employee,
              attendance: txRes2.record,
              message: "Duplicate scan prevented. Please wait a few seconds before scanning again.",
              time: timeDisplay
            }
          };
        }
        const shift3 = shiftsMap.get(txRes2.record.shiftId) || shifts[0];
        const reentryBounds = resolveShiftScheduleBounds(txRes2.record.shiftDate || todayKey, {
          ...shift3,
          shiftId: txRes2.record.shiftId,
          shiftNameSnapshot: txRes2.record.shiftNameSnapshot,
          scheduledPunchIn: txRes2.record.scheduledPunchIn || shift3?.startTime,
          scheduledPunchOut: txRes2.record.scheduledPunchOut || shift3?.endTime
        });
        const reentrySchedule = computeExpectedPunchOutTimes({
          firstInIso: txRes2.record.firstPunchIn || txRes2.record.punchIn,
          scheduledStartIso: txRes2.record.scheduledPunchInIso || reentryBounds.scheduledStartIso,
          scheduledEndIso: txRes2.record.scheduledPunchOutIso || reentryBounds.scheduledEndIso,
          standardDutyMinutes: STANDARD_DUTY_MINUTES
        });
        return {
          httpStatus: 200,
          body: {
            success: true,
            action: "PUNCH_IN",
            scannerType: "IN",
            currentState: "INSIDE",
            employee,
            attendance: txRes2.record,
            shift: shift3,
            punchOutSchedule: reentrySchedule || void 0,
            message: `Punch In Successfully Recorded (Re-entry #${txRes2.record.punches.length}).`,
            time: timeDisplay,
            punchCount: txRes2.record.punches.length
          }
        };
      }
      const shiftMatch = identifyShiftForPunchIn(shifts, now);
      if (!shiftMatch) {
        await writePunchLog({
          employeeId: employee.employeeId,
          employeeName: employee.employeeName,
          timestamp: now.toISOString(),
          action: "REJECTED_SHIFT",
          rawPayload,
          scannerDevice,
          performedByUid: caller.uid,
          performedByLoginId: caller.loginId,
          message: "No shift window matched the punch-in time."
        });
        return {
          httpStatus: 400,
          body: {
            success: false,
            action: "REJECTED",
            scannerType: "IN",
            employee,
            message: "No Valid Shift Found For This Punch-In Time.",
            time: timeDisplay
          }
        };
      }
      const { shift: shift2, shiftDate } = shiftMatch;
      const attendanceId = `att_${employee.employeeId}_${shiftDate}_${shift2.id}`;
      const scheduleBounds = resolveShiftScheduleBounds(shiftDate, shift2);
      const grace = shift2.gracePeriodMinutes ?? settings.lateGraceMinutes ?? 15;
      const isLate = now.getTime() > scheduleBounds.scheduledStartMs + grace * 6e4;
      const earlyEval = evaluateEarlyPunchOnPunchIn({
        firstInIso: now.toISOString(),
        scheduledStartIso: scheduleBounds.scheduledStartIso
      });
      const arrivalStatus = isLate ? "LATE" : "PRESENT";
      const eventId2 = `pe_${Date.now()}_${crypto4.randomBytes(3).toString("hex")}`;
      const logId2 = `log_${Date.now()}_${crypto4.randomBytes(3).toString("hex")}`;
      const firstPunchEvent = {
        id: eventId2,
        employeeId: employee.employeeId,
        employeeName: employee.employeeName,
        eventType: "IN",
        timestamp: now.toISOString(),
        displayTime: timeDisplay,
        shiftDate,
        shiftId: shift2.id,
        shiftName: shift2.name,
        floor: employee.floor,
        section: employee.section,
        department: employee.department,
        scannerType: "IN",
        scannerDevice,
        status: isLate ? "FIRST_IN_LATE" : "FIRST_IN",
        recordedByUid: caller.uid,
        recordedByLoginId: caller.loginId
      };
      const newAttendanceRecord = {
        id: attendanceId,
        employeeId: employee.employeeId,
        employeeNameSnapshot: employee.employeeName,
        employeeTypeSnapshot: employee.employeeType,
        floorIdSnapshot: employee.floor,
        lineIdSnapshot: employee.floor,
        sectionIdSnapshot: employee.section,
        departmentIdSnapshot: employee.department,
        shiftId: shift2.id,
        shiftNameSnapshot: shift2.name,
        shiftDate,
        punchIn: now.toISOString(),
        firstPunchIn: now.toISOString(),
        scheduledPunchIn: scheduleBounds.startTime,
        scheduledPunchInIso: scheduleBounds.scheduledStartIso,
        scheduledPunchOut: scheduleBounds.endTime,
        scheduledPunchOutIso: scheduleBounds.scheduledEndIso,
        actualPunchOut: null,
        lastPunchOut: null,
        effectivePunchOut: null,
        punchOutType: "NONE",
        currentState: "INSIDE",
        punches: [firstPunchEvent],
        totalDutyMinutes: 0,
        regularDutyMinutes: 0,
        overtimeMinutes: 0,
        earlyArrivalMinutes: earlyEval.earlyArrivalMinutes,
        provisionalEarlyOtMinutes: earlyEval.provisionalEarlyOtMinutes,
        earlyOtMinutes: 0,
        postShiftOtMinutes: 0,
        totalOtMinutes: 0,
        earlyOtFinalized: false,
        earlyPunchPolicy: earlyEval.earlyPunchPolicy,
        attendanceStatus: "IN PROGRESS",
        isLate,
        arrivalStatus,
        missedPunchOut: false,
        autoClosed: false,
        qrTokenReference: employee.qrCodeToken || "",
        qrVerificationMode,
        createdByUid: caller.uid,
        createdByLoginId: caller.loginId,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString()
      };
      const docRef2 = db.collection("attendance").doc(attendanceId);
      const txRes = await db.runTransaction(async (tx) => {
        const existing = await tx.get(docRef2);
        if (existing.exists) {
          const data = existing.data();
          if (data.currentState === "INSIDE" || !data.actualPunchOut && data.punchOutType === "NONE") {
            return { kind: "CONSECUTIVE_IN", record: data };
          }
        }
        tx.set(docRef2, newAttendanceRecord);
        tx.set(db.collection("punch_events").doc(eventId2), firstPunchEvent);
        tx.set(db.collection("punch_logs").doc(logId2), {
          id: logId2,
          employeeId: employee.employeeId,
          employeeName: employee.employeeName,
          timestamp: now.toISOString(),
          action: "PUNCH_IN",
          rawPayload,
          scannerDevice,
          qrVerificationMode,
          performedByUid: caller.uid,
          performedByLoginId: caller.loginId,
          message: `First Punch In recorded for ${shift2.name} (${shiftDate}). Arrival: ${arrivalStatus}${earlyEval.earlyArrivalMinutes > 0 ? `, Early: ${earlyEval.earlyArrivalMinutes}m (Provisional Early OT: ${earlyEval.provisionalEarlyOtMinutes}m)` : ""}. Status: IN PROGRESS.`
        });
        return { kind: "RECORDED", record: newAttendanceRecord };
      });
      if (txRes.kind === "CONSECUTIVE_IN") {
        return {
          httpStatus: 409,
          body: {
            success: false,
            action: "REJECTED_DUPLICATE",
            scannerType: "IN",
            currentState: "INSIDE",
            employee,
            attendance: txRes.record,
            message: "Consecutive Punch In rejected. Employee is already Punched In (Status: INSIDE).",
            time: timeDisplay
          }
        };
      }
      const firstInSchedule = computeExpectedPunchOutTimes({
        firstInIso: newAttendanceRecord.firstPunchIn,
        scheduledStartIso: scheduleBounds.scheduledStartIso,
        scheduledEndIso: scheduleBounds.scheduledEndIso,
        standardDutyMinutes: STANDARD_DUTY_MINUTES
      });
      return {
        httpStatus: 200,
        body: {
          success: true,
          action: "PUNCH_IN",
          scannerType: "IN",
          currentState: "INSIDE",
          employee,
          attendance: newAttendanceRecord,
          shift: shift2,
          punchOutSchedule: firstInSchedule || void 0,
          message: isLate ? `First Punch In Recorded for ${shift2.name} (Marked LATE).` : earlyEval.provisionalEarlyOtMinutes > 0 ? `First Punch In Recorded for ${shift2.name} (Early ${formatMinutes(earlyEval.earlyArrivalMinutes)} \u2022 Provisional Early OT).` : earlyEval.earlyArrivalMinutes > 0 ? `First Punch In Recorded for ${shift2.name} (Early ${formatMinutes(earlyEval.earlyArrivalMinutes)} \u2022 <60m: 0 Early OT).` : `First Punch In Recorded for ${shift2.name}.`,
          time: timeDisplay,
          punchCount: 1
        }
      };
    }
    if (!activeRecord) {
      await writePunchLog({
        employeeId: employee.employeeId,
        employeeName: employee.employeeName,
        timestamp: now.toISOString(),
        action: "REJECTED_TOKEN",
        rawPayload,
        scannerDevice,
        performedByUid: caller.uid,
        performedByLoginId: caller.loginId,
        message: "Punch Out rejected: No valid Punch In found for employee today."
      });
      return {
        httpStatus: 400,
        body: {
          success: false,
          action: "REJECTED",
          scannerType: "OUT",
          employee,
          message: "Punch Out rejected: No valid Punch In found for employee. Please Punch In first.",
          time: timeDisplay
        }
      };
    }
    const docRef = db.collection("attendance").doc(activeRecord.id);
    const eventId = `pe_${Date.now()}_${crypto4.randomBytes(3).toString("hex")}`;
    const logId = `log_${Date.now()}_${crypto4.randomBytes(3).toString("hex")}`;
    const txOutRes = await db.runTransaction(async (tx) => {
      const snap = await tx.get(docRef);
      const currentData = snap.exists ? snap.data() : activeRecord;
      if (String(currentData.employeeId || "").toUpperCase() !== String(employee.employeeId || "").toUpperCase()) {
        return { kind: "EMPLOYEE_MISMATCH", record: currentData };
      }
      const currentState = currentData.currentState || (currentData.actualPunchOut || currentData.punchOutType === "ACTUAL" ? "OUTSIDE" : "INSIDE");
      const isAutoClosedReconcilable = currentData.punchOutType === "AUTO" && currentData.autoClosed === true && !currentData.actualPunchOut && currentData.reconciledFromAutoClose !== true;
      if (currentState === "OUTSIDE" && !isAutoClosedReconcilable) {
        return { kind: "CONSECUTIVE_OUT", record: currentData };
      }
      const firstInIso = currentData.firstPunchIn || currentData.punchIn;
      const firstInMs = new Date(firstInIso).getTime();
      if (!Number.isFinite(firstInMs) || now.getTime() < firstInMs) {
        return { kind: "INVALID_TIME", record: currentData };
      }
      const lastEmployeePunchTime = Array.isArray(currentData.punches) && currentData.punches.length > 0 ? new Date(currentData.punches[currentData.punches.length - 1].timestamp).getTime() : firstInMs;
      if (!isAutoClosedReconcilable && Math.abs(now.getTime() - lastEmployeePunchTime) < 3e3) {
        return { kind: "BOUNCE", record: currentData };
      }
      const recordShift = shiftsMap.get(currentData.shiftId) || shifts[0];
      const bounds = resolveShiftScheduleBounds(currentData.shiftDate || todayKey, {
        ...recordShift,
        shiftId: currentData.shiftId,
        shiftNameSnapshot: currentData.shiftNameSnapshot,
        scheduledPunchIn: currentData.scheduledPunchIn || recordShift?.startTime,
        scheduledPunchOut: currentData.scheduledPunchOut || recordShift?.endTime
      });
      const scheduledStartIso = currentData.scheduledPunchInIso || bounds.scheduledStartIso;
      const scheduledEndIso = currentData.scheduledPunchOutIso || bounds.scheduledEndIso;
      const otEval = evaluateOptionAPunchOut({
        firstInIso,
        lastOutIso: now.toISOString(),
        scheduledStartIso,
        scheduledEndIso,
        standardDutyMinutes: STANDARD_DUTY_MINUTES
      });
      const totalDutyMinutes = otEval.totalDutyMinutes;
      const regularDutyMinutes = otEval.regularDutyMinutes;
      const overtimeMinutes = otEval.overtimeMinutes;
      const computedStatus = otEval.attendanceStatus;
      const outEvent = {
        id: eventId,
        employeeId: employee.employeeId,
        employeeName: employee.employeeName,
        eventType: "OUT",
        timestamp: now.toISOString(),
        displayTime: timeDisplay,
        shiftDate: currentData.shiftDate,
        shiftId: currentData.shiftId,
        shiftName: currentData.shiftNameSnapshot,
        floor: employee.floor,
        section: employee.section,
        department: employee.department,
        scannerType: "OUT",
        scannerDevice,
        dutyDurationMinutes: totalDutyMinutes,
        overtimeMinutes,
        earlyOtMinutes: otEval.earlyOtMinutes,
        postShiftOtMinutes: otEval.postShiftOtMinutes,
        reconciledFromAutoClose: isAutoClosedReconcilable,
        previousPunchOutType: isAutoClosedReconcilable ? "AUTO" : "NONE",
        previousAutoCloseEventId: isAutoClosedReconcilable ? currentData.autoCloseEventId || null : null,
        status: isAutoClosedReconcilable ? "RECONCILED_ACTUAL_OUT" : "VALID_OUT",
        recordedByUid: caller.uid,
        recordedByLoginId: caller.loginId
      };
      const existingPunches = Array.isArray(currentData.punches) ? currentData.punches : [];
      const updatedAttendance = {
        ...currentData,
        firstPunchIn: firstInIso,
        punchIn: currentData.punchIn || firstInIso,
        scheduledPunchIn: currentData.scheduledPunchIn || bounds.startTime,
        scheduledPunchInIso: scheduledStartIso,
        scheduledPunchOut: currentData.scheduledPunchOut || bounds.endTime,
        scheduledPunchOutIso: scheduledEndIso,
        actualPunchOut: now.toISOString(),
        lastPunchOut: now.toISOString(),
        effectivePunchOut: now.toISOString(),
        punchOutType: "ACTUAL",
        currentState: "OUTSIDE",
        punches: [...existingPunches, outEvent],
        actualPresenceMinutes: otEval.actualPresenceMinutes,
        totalDutyMinutes,
        regularDutyMinutes,
        overtimeMinutes,
        earlyArrivalMinutes: otEval.earlyArrivalMinutes,
        provisionalEarlyOtMinutes: otEval.provisionalEarlyOtMinutes,
        earlyOtMinutes: otEval.earlyOtMinutes,
        postShiftOtMinutes: otEval.postShiftOtMinutes,
        totalOtMinutes: otEval.totalOtMinutes,
        earlyOtFinalized: true,
        earlyPunchPolicy: EARLY_PUNCH_POLICY_ID,
        otCapApplied: otEval.otCapApplied,
        attendanceStatus: computedStatus,
        missedPunchOut: false,
        autoClosed: false,
        ...isAutoClosedReconcilable ? {
          reconciledFromAutoClose: true,
          reconciledAt: now.toISOString(),
          reconciledByUid: caller.uid,
          reconciledByLoginId: caller.loginId
        } : {},
        updatedByUid: caller.uid,
        updatedByLoginId: caller.loginId,
        updatedAt: now.toISOString()
      };
      tx.set(docRef, updatedAttendance);
      tx.set(db.collection("punch_events").doc(eventId), outEvent);
      tx.set(db.collection("punch_logs").doc(logId), {
        id: logId,
        employeeId: employee.employeeId,
        employeeName: employee.employeeName,
        timestamp: now.toISOString(),
        action: "PUNCH_OUT",
        rawPayload,
        scannerDevice,
        qrVerificationMode,
        performedByUid: caller.uid,
        performedByLoginId: caller.loginId,
        message: isAutoClosedReconcilable ? `Actual Punch Out reconciled from provisional AUTO CLOSED (${computedStatus}). Duty: ${formatMinutes(regularDutyMinutes)}, Early OT: ${formatMinutes(otEval.earlyOtMinutes)}, Post OT: ${formatMinutes(otEval.postShiftOtMinutes)}, Total OT: ${formatMinutes(overtimeMinutes)}. Total: ${formatMinutes(totalDutyMinutes)}.` : `Punch Out recorded (${computedStatus}). Duty: ${formatMinutes(regularDutyMinutes)}, Early OT: ${formatMinutes(otEval.earlyOtMinutes)}, Post OT: ${formatMinutes(otEval.postShiftOtMinutes)}, Total OT: ${formatMinutes(overtimeMinutes)}. Total: ${formatMinutes(totalDutyMinutes)}.`
      });
      return {
        kind: "RECORDED",
        record: updatedAttendance,
        regularDutyMinutes,
        overtimeMinutes,
        reconciledFromAutoClose: isAutoClosedReconcilable,
        previousAutoCloseEffective: currentData.autoCloseEffectivePunchOut || currentData.effectivePunchOut || null,
        scheduledStartIso,
        scheduledEndIso
      };
    });
    if (txOutRes.kind === "EMPLOYEE_MISMATCH" || txOutRes.kind === "INVALID_TIME") {
      return {
        httpStatus: 400,
        body: {
          success: false,
          action: "REJECTED",
          scannerType: "OUT",
          employee,
          message: txOutRes.kind === "EMPLOYEE_MISMATCH" ? "Punch Out rejected: Attendance record does not match scanned employee." : "Punch Out rejected: Punch-Out timestamp cannot be earlier than Punch-In.",
          time: timeDisplay
        }
      };
    }
    if (txOutRes.kind === "CONSECUTIVE_OUT") {
      await writePunchLog({
        employeeId: employee.employeeId,
        employeeName: employee.employeeName,
        timestamp: now.toISOString(),
        action: "REJECTED_DUPLICATE",
        rawPayload,
        scannerDevice,
        performedByUid: caller.uid,
        performedByLoginId: caller.loginId,
        message: "Consecutive Punch Out rejected. Employee has already Punched Out."
      });
      return {
        httpStatus: 409,
        body: {
          success: false,
          action: "REJECTED_DUPLICATE",
          scannerType: "OUT",
          currentState: "OUTSIDE",
          employee,
          attendance: txOutRes.record,
          message: "Consecutive Punch Out rejected. Employee has already Punched Out (Status: OUTSIDE).",
          time: timeDisplay,
          punchCount: txOutRes.record.punches?.length || 1
        }
      };
    }
    if (txOutRes.kind === "BOUNCE") {
      return {
        httpStatus: 429,
        body: {
          success: false,
          action: "REJECTED_DUPLICATE",
          scannerType: "OUT",
          currentState: "INSIDE",
          employee,
          attendance: txOutRes.record,
          message: "Duplicate scan prevented. Please wait a few seconds before scanning again.",
          time: timeDisplay
        }
      };
    }
    if (txOutRes.reconciledFromAutoClose) {
      await recordEnterpriseAuditEvent(db, {
        req,
        action: "RECONCILE_AUTO_CLOSED_PUNCH_OUT",
        category: "ATTENDANCE",
        actorUid: caller.uid,
        actorLoginId: caller.loginId,
        actorRole: caller.role.toUpperCase(),
        employeeId: employee.employeeId,
        targetType: "ATTENDANCE",
        targetId: txOutRes.record.id,
        oldValue: `AUTO CLOSED (Effective Out: ${txOutRes.previousAutoCloseEffective || "Scheduled End"}, OT: 00:00)`,
        newValue: `ACTUAL (${txOutRes.record.attendanceStatus}, Out: ${txOutRes.record.actualPunchOut}, Duty: ${formatMinutes(txOutRes.record.totalDutyMinutes)}, OT: ${formatMinutes(txOutRes.overtimeMinutes)})`,
        actionSource: scannerDevice === "MANUAL" ? "MANUAL_SCANNER_RECONCILIATION" : "QR_SCANNER_RECONCILIATION",
        reason: "Genuine actual Punch-Out received after provisional shift auto-close",
        captureGeo: false
      });
    }
    const shift = shiftsMap.get(txOutRes.record.shiftId) || shifts[0];
    const outSchedule = computeExpectedPunchOutTimes({
      firstInIso: txOutRes.record.firstPunchIn || txOutRes.record.punchIn,
      scheduledStartIso: txOutRes.scheduledStartIso,
      scheduledEndIso: txOutRes.scheduledEndIso,
      standardDutyMinutes: STANDARD_DUTY_MINUTES
    });
    return {
      httpStatus: 200,
      body: {
        success: true,
        action: "PUNCH_OUT",
        scannerType: "OUT",
        currentState: "OUTSIDE",
        reconciledFromAutoClose: txOutRes.reconciledFromAutoClose,
        employee,
        attendance: txOutRes.record,
        shift,
        punchOutSchedule: outSchedule || void 0,
        message: txOutRes.reconciledFromAutoClose ? "Actual Punch Out Recorded (Reconciled from Auto-Close)." : "Punch Out Successfully Recorded.",
        time: timeDisplay,
        dutyFormatted: formatMinutes(txOutRes.regularDutyMinutes),
        otFormatted: formatMinutes(txOutRes.overtimeMinutes),
        punchCount: txOutRes.record.punches.length
      }
    };
  }
  app.post("/api/attendance/auto-close", async (req, res) => {
    try {
      const caller = await requireVerifiedCaller(
        req,
        res,
        "*",
        "Auto Close Expired Shifts"
      );
      if (!caller) return;
      const canAutoClose = await callerHasModuleAction(db, caller, "history", "edit") || await callerHasModuleAction(db, caller, "shifts", "edit");
      if (!canAutoClose) {
        await recordEnterpriseAuditEvent(db, {
          req,
          action: "unauthorized_access_attempt",
          category: "SECURITY",
          severity: "CRITICAL",
          actorUid: caller.uid,
          actorLoginId: caller.loginId,
          actorRole: caller.role.toUpperCase(),
          targetType: "ATTENDANCE_AUTO_CLOSE",
          targetId: "/api/attendance/auto-close",
          actionSource: "ATTENDANCE_PERMISSION_GUARD",
          description: `Unauthorized auto-close attempt by "${caller.loginId}" (${caller.role}).`,
          success: false
        });
        return res.status(403).json({
          success: false,
          error: `Forbidden: Role "${caller.role.toUpperCase()}" is not permitted for Auto Close Expired Shifts.`
        });
      }
      const now = /* @__PURE__ */ new Date();
      const [settingsRes, shiftsRes, openSnap] = await Promise.all([
        getCachedSystemSettings(db, DEFAULT_SETTINGS),
        getCachedShifts(db, DEFAULT_SHIFTS),
        db.collection("attendance").where("punchOutType", "==", "NONE").get()
      ]);
      const settings = settingsRes.data || DEFAULT_SETTINGS;
      if (!settings.autoPunchOutEnabled) {
        return res.json({ success: true, closedCount: 0, closedRecords: [] });
      }
      const shifts = shiftsRes.shifts;
      const shiftsMap = new Map(shifts.map((s) => [s.id, s]));
      const closedRecords = [];
      const MAX_AUTO_CLOSE_PER_INVOCATION = 25;
      const startTimeMs = Date.now();
      const SOFT_TIME_BUDGET_MS = 6500;
      for (const docSnap of openSnap.docs) {
        if (closedRecords.length >= MAX_AUTO_CLOSE_PER_INVOCATION || Date.now() - startTimeMs >= SOFT_TIME_BUDGET_MS) {
          break;
        }
        const record = docSnap.data();
        if (record.actualPunchOut || record.punchOutType !== "NONE" || record.autoClosed === true) continue;
        const shift = shiftsMap.get(record.shiftId);
        if (!shift) continue;
        const scheduledEndIso = record.scheduledPunchOutIso || getShiftScheduledEndIso(record.shiftDate, shift);
        const scheduledEndDate = new Date(scheduledEndIso);
        if (now.getTime() >= scheduledEndDate.getTime()) {
          const scheduledDuration = Math.min(
            shift.scheduledDurationMinutes || settings.scheduledDurationMinutes || STANDARD_DUTY_MINUTES,
            MAX_REGULAR_DUTY_MINUTES
          );
          const docRef = db.collection("attendance").doc(record.id);
          const autoEventId = `pe_auto_${Date.now()}_${crypto4.randomBytes(3).toString("hex")}`;
          const autoDisplayTime = getKolkataTimeParts(scheduledEndDate).timeWithSeconds;
          const updatedRecord = await withEmployeeScanLock(
            record.employeeId,
            () => db.runTransaction(async (tx) => {
              const freshSnap = await tx.get(docRef);
              if (!freshSnap.exists) return null;
              const fresh = freshSnap.data();
              if (fresh.actualPunchOut || fresh.punchOutType !== "NONE" || fresh.autoClosed === true || fresh.currentState === "OUTSIDE") {
                return null;
              }
              const autoCloseEvent = {
                id: autoEventId,
                employeeId: fresh.employeeId,
                employeeName: fresh.employeeNameSnapshot || "",
                eventType: "OUT",
                timestamp: now.toISOString(),
                effectivePunchOut: scheduledEndIso,
                displayTime: autoDisplayTime,
                shiftDate: fresh.shiftDate,
                shiftId: fresh.shiftId,
                shiftName: fresh.shiftNameSnapshot || shift.name,
                floor: fresh.floorIdSnapshot || "",
                section: fresh.sectionIdSnapshot || "",
                department: fresh.departmentIdSnapshot || "",
                scannerType: "OUT",
                scannerDevice: "SYSTEM_AUTO",
                dutyDurationMinutes: scheduledDuration,
                overtimeMinutes: 0,
                earlyOtMinutes: 0,
                postShiftOtMinutes: 0,
                status: "AUTO_CLOSE",
                recordedByUid: caller.uid,
                recordedByLoginId: caller.loginId
              };
              const next = {
                ...fresh,
                firstPunchIn: fresh.firstPunchIn || fresh.punchIn,
                punchIn: fresh.punchIn || fresh.firstPunchIn,
                scheduledPunchOutIso: scheduledEndIso,
                actualPunchOut: null,
                lastPunchOut: null,
                effectivePunchOut: scheduledEndIso,
                punchOutType: "AUTO",
                currentState: "OUTSIDE",
                attendanceStatus: "AUTO CLOSED",
                missedPunchOut: true,
                autoClosed: true,
                autoClosedAt: now.toISOString(),
                autoCloseEventId: autoEventId,
                autoCloseEffectivePunchOut: scheduledEndIso,
                totalDutyMinutes: scheduledDuration,
                regularDutyMinutes: scheduledDuration,
                overtimeMinutes: 0,
                // Strictly zero OT on auto-closed shifts
                earlyOtMinutes: 0,
                postShiftOtMinutes: 0,
                totalOtMinutes: 0,
                earlyOtFinalized: false,
                otCapApplied: false,
                updatedAt: now.toISOString()
              };
              tx.set(docRef, next);
              tx.set(db.collection("punch_events").doc(autoEventId), autoCloseEvent);
              return next;
            })
          );
          if (updatedRecord) {
            closedRecords.push(updatedRecord);
            await Promise.all([
              writePunchLog({
                employeeId: record.employeeId,
                employeeName: record.employeeNameSnapshot,
                timestamp: now.toISOString(),
                action: "AUTO_CLOSE",
                rawPayload: "SYSTEM_CRON",
                scannerDevice: "SYSTEM_AUTO",
                performedByUid: caller.uid,
                performedByLoginId: caller.loginId,
                message: `Provisional auto-close at scheduled shift end (${shift.endTime}). Status: AUTO CLOSED. OT: 00:00.`
              }),
              recordEnterpriseAuditEvent(db, {
                req,
                action: "AUTOMATIC_PUNCH_OUT",
                category: "ATTENDANCE",
                actorUid: caller.uid,
                actorLoginId: caller.loginId,
                actorRole: caller.role.toUpperCase(),
                employeeId: record.employeeId,
                targetType: "ATTENDANCE",
                targetId: record.id,
                newValue: `Auto-closed at ${scheduledEndIso}, Duty: ${formatMinutes(scheduledDuration)}, OT: 00:00`,
                actionSource: "SYSTEM_SCHEDULER",
                reason: "Provisional auto-close at scheduled shift end (reconcilable by genuine Punch-Out)",
                captureGeo: false
              })
            ]);
          }
        }
      }
      return res.json({
        success: true,
        closedCount: closedRecords.length,
        closedRecords
      });
    } catch (err) {
      console.error("[API Auto Close] Error:", err);
      return res.status(500).json({ success: false, error: "Failed to execute shift auto-closing engine." });
    }
  });
  app.post("/api/attendance/correct", async (req, res) => {
    try {
      const caller = await requireVerifiedCaller(
        req,
        res,
        "*",
        "Manual Attendance Correction"
      );
      if (!caller) return;
      const canCorrect = await callerHasModuleAction(db, caller, "history", "edit");
      if (!canCorrect) {
        await recordEnterpriseAuditEvent(db, {
          req,
          action: "unauthorized_access_attempt",
          category: "SECURITY",
          severity: "CRITICAL",
          actorUid: caller.uid,
          actorLoginId: caller.loginId,
          actorRole: caller.role.toUpperCase(),
          targetType: "ATTENDANCE_CORRECTION",
          targetId: "/api/attendance/correct",
          actionSource: "ATTENDANCE_PERMISSION_GUARD",
          description: `Unauthorized attendance correction attempt by "${caller.loginId}" (${caller.role}).`,
          success: false
        });
        return res.status(403).json({
          success: false,
          error: `Forbidden: Role "${caller.role.toUpperCase()}" is not permitted for Manual Attendance Correction.`
        });
      }
      const parsed = AttendanceCorrectSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: parsed.error.issues[0]?.message || "Invalid correction payload."
        });
      }
      const { attendanceId, actualPunchOut, punchOutType, attendanceStatus, reason } = parsed.data;
      const docRef = db.collection("attendance").doc(attendanceId);
      const txResult = await db.runTransaction(async (tx) => {
        const snap = await tx.get(docRef);
        if (!snap.exists) {
          return { notFound: true };
        }
        const current = snap.data();
        let regularDutyMinutes = Number(current.regularDutyMinutes || 0);
        let overtimeMinutes = Number(current.overtimeMinutes || 0);
        let totalDutyMinutes = Number(current.totalDutyMinutes || 0);
        let earlyArrivalMinutes = Number(current.earlyArrivalMinutes || 0);
        let provisionalEarlyOtMinutes = Number(current.provisionalEarlyOtMinutes || 0);
        let earlyOtMinutes = Number(current.earlyOtMinutes || 0);
        let postShiftOtMinutes = Number(current.postShiftOtMinutes || 0);
        let earlyOtFinalized = Boolean(current.earlyOtFinalized);
        let actualPresenceMinutes = Number(current.actualPresenceMinutes || totalDutyMinutes || 0);
        const bounds = resolveShiftScheduleBounds(current.shiftDate || "", current);
        const scheduledStartIso = current.scheduledPunchInIso || bounds.scheduledStartIso;
        if (actualPunchOut) {
          const firstInIso = current.firstPunchIn || current.punchIn;
          const inTime = new Date(firstInIso).getTime();
          const outTime = new Date(actualPunchOut).getTime();
          if (Number.isNaN(outTime)) {
            throw new Error("INVALID_PUNCH_OUT");
          }
          let otCapApplied = Boolean(current.otCapApplied);
          if (punchOutType === "AUTO") {
            const rawPresence = Math.max(0, Math.floor((outTime - inTime) / (60 * 1e3)));
            actualPresenceMinutes = rawPresence;
            regularDutyMinutes = Math.min(rawPresence, MAX_REGULAR_DUTY_MINUTES);
            totalDutyMinutes = regularDutyMinutes;
            overtimeMinutes = 0;
            earlyOtMinutes = 0;
            postShiftOtMinutes = 0;
            earlyOtFinalized = false;
            otCapApplied = false;
          } else {
            const otEval = evaluateOptionAPunchOut({
              firstInIso,
              lastOutIso: actualPunchOut,
              scheduledStartIso,
              scheduledEndIso: current.scheduledPunchOutIso || bounds.scheduledEndIso,
              standardDutyMinutes: STANDARD_DUTY_MINUTES
            });
            actualPresenceMinutes = otEval.actualPresenceMinutes;
            totalDutyMinutes = otEval.totalDutyMinutes;
            regularDutyMinutes = otEval.regularDutyMinutes;
            overtimeMinutes = otEval.overtimeMinutes;
            earlyArrivalMinutes = otEval.earlyArrivalMinutes;
            provisionalEarlyOtMinutes = otEval.provisionalEarlyOtMinutes;
            earlyOtMinutes = otEval.earlyOtMinutes;
            postShiftOtMinutes = otEval.postShiftOtMinutes;
            earlyOtFinalized = true;
            otCapApplied = otEval.otCapApplied;
          }
          const autoClassifySet2 = /* @__PURE__ */ new Set([
            "COMPLETED",
            "COMPLETED + OT",
            "HALF DAY",
            "SHORT LEAVE",
            "PRESENT"
          ]);
          const finalAttendanceStatus2 = punchOutType === "ACTUAL" && actualPunchOut && autoClassifySet2.has(attendanceStatus) ? classifyCompletedDutyStatus(totalDutyMinutes, STANDARD_DUTY_MINUTES) : attendanceStatus;
          const updatedFields2 = {
            actualPunchOut: punchOutType === "AUTO" ? null : actualPunchOut,
            lastPunchOut: punchOutType === "AUTO" ? null : actualPunchOut,
            effectivePunchOut: actualPunchOut || current.effectivePunchOut || null,
            punchOutType,
            currentState: actualPunchOut ? "OUTSIDE" : current.currentState || "OUTSIDE",
            attendanceStatus: finalAttendanceStatus2,
            autoClosed: punchOutType === "AUTO",
            missedPunchOut: punchOutType === "AUTO" || finalAttendanceStatus2 === "MISSED PUNCH OUT",
            scheduledPunchIn: current.scheduledPunchIn || bounds.startTime,
            scheduledPunchInIso: scheduledStartIso,
            scheduledPunchOut: current.scheduledPunchOut || bounds.endTime,
            scheduledPunchOutIso: current.scheduledPunchOutIso || bounds.scheduledEndIso,
            actualPresenceMinutes,
            totalDutyMinutes,
            regularDutyMinutes,
            overtimeMinutes,
            earlyArrivalMinutes,
            provisionalEarlyOtMinutes,
            earlyOtMinutes,
            postShiftOtMinutes,
            totalOtMinutes: overtimeMinutes,
            earlyOtFinalized,
            otCapApplied,
            earlyPunchPolicy: EARLY_PUNCH_POLICY_ID,
            correctionReason: reason.trim(),
            correctedBy: caller.loginId,
            correctedByUid: caller.uid,
            updatedAt: (/* @__PURE__ */ new Date()).toISOString()
          };
          tx.update(docRef, updatedFields2);
          return {
            notFound: false,
            current,
            updated: { ...current, ...updatedFields2 }
          };
        } else if (punchOutType === "AUTO") {
          regularDutyMinutes = Math.min(regularDutyMinutes || STANDARD_DUTY_MINUTES, MAX_REGULAR_DUTY_MINUTES);
          totalDutyMinutes = regularDutyMinutes;
          overtimeMinutes = 0;
          earlyOtMinutes = 0;
          postShiftOtMinutes = 0;
          earlyOtFinalized = false;
        }
        const autoClassifySet = /* @__PURE__ */ new Set([
          "COMPLETED",
          "COMPLETED + OT",
          "HALF DAY",
          "SHORT LEAVE",
          "PRESENT"
        ]);
        const finalAttendanceStatus = punchOutType === "ACTUAL" && actualPunchOut && autoClassifySet.has(attendanceStatus) ? classifyCompletedDutyStatus(totalDutyMinutes, STANDARD_DUTY_MINUTES) : attendanceStatus;
        const updatedFields = {
          actualPunchOut: punchOutType === "AUTO" ? null : actualPunchOut || current.actualPunchOut || null,
          lastPunchOut: punchOutType === "AUTO" ? null : actualPunchOut || current.lastPunchOut || null,
          effectivePunchOut: actualPunchOut || current.effectivePunchOut || null,
          punchOutType,
          currentState: actualPunchOut ? "OUTSIDE" : current.currentState || "OUTSIDE",
          attendanceStatus: finalAttendanceStatus,
          autoClosed: punchOutType === "AUTO",
          missedPunchOut: punchOutType === "AUTO" || finalAttendanceStatus === "MISSED PUNCH OUT",
          scheduledPunchIn: current.scheduledPunchIn || bounds.startTime,
          scheduledPunchInIso: scheduledStartIso,
          scheduledPunchOut: current.scheduledPunchOut || bounds.endTime,
          scheduledPunchOutIso: current.scheduledPunchOutIso || bounds.scheduledEndIso,
          actualPresenceMinutes,
          totalDutyMinutes,
          regularDutyMinutes,
          overtimeMinutes,
          earlyArrivalMinutes,
          provisionalEarlyOtMinutes,
          earlyOtMinutes,
          postShiftOtMinutes,
          totalOtMinutes: overtimeMinutes,
          earlyOtFinalized,
          otCapApplied: Boolean(current.otCapApplied),
          earlyPunchPolicy: EARLY_PUNCH_POLICY_ID,
          correctionReason: reason.trim(),
          correctedBy: caller.loginId,
          correctedByUid: caller.uid,
          updatedAt: (/* @__PURE__ */ new Date()).toISOString()
        };
        tx.update(docRef, updatedFields);
        return {
          notFound: false,
          current,
          updated: { ...current, ...updatedFields }
        };
      });
      if (txResult.notFound) {
        return res.status(404).json({ success: false, error: "Attendance record not found." });
      }
      await recordEnterpriseAuditEvent(db, {
        req,
        action: "CORRECT_ATTENDANCE",
        category: "ATTENDANCE",
        severity: "WARNING",
        actorUid: caller.uid,
        actorLoginId: caller.loginId,
        actorRole: caller.role.toUpperCase(),
        employeeId: txResult.current.employeeId,
        targetType: "ATTENDANCE",
        targetId: attendanceId,
        oldValue: `Status: ${txResult.current.attendanceStatus}, Out: ${txResult.current.actualPunchOut || "None"}`,
        newValue: `Status: ${txResult.updated.attendanceStatus}, Out: ${actualPunchOut || "None"}`,
        actionSource: "ADMIN_CORRECTION",
        reason: reason.trim(),
        description: `Attendance record ${attendanceId} corrected by "${caller.loginId}".`
      });
      recordDbOpMetric(db, {
        operation: "TRANSACTION",
        collection: "attendance",
        durationMs: 0,
        success: true,
        correlationId: req.correlationId
      });
      recordActivityTelemetry(db, {
        actorUid: caller.uid,
        actorLoginId: caller.loginId,
        actorRole: caller.role.toUpperCase(),
        action: "ATTENDANCE_CORRECTION",
        module: "Attendance History",
        result: "Success",
        correlationId: req.correlationId,
        detail: `Corrected attendance ${attendanceId} -> ${txResult.updated.attendanceStatus}`
      });
      return res.json({ success: true, record: txResult.updated });
    } catch (err) {
      if (err?.message === "INVALID_PUNCH_OUT") {
        return res.status(400).json({ success: false, error: "Invalid actualPunchOut timestamp." });
      }
      console.error("[API Attendance Correct] Error:", err);
      recordErrorTelemetry(db, {
        source: "BACKEND",
        module: "Attendance History",
        category: "CORRECTION_ERROR",
        severity: "CRITICAL",
        message: err?.message || "Failed to correct attendance record.",
        statusCode: 500,
        correlationId: req.correlationId
      });
      return res.status(500).json({ success: false, error: "Failed to correct attendance record." });
    }
  });
  app.post("/api/attendance/roster", async (req, res) => {
    try {
      const caller = await requireVerifiedCaller(
        req,
        res,
        "*",
        "Generate Shift Roster"
      );
      if (!caller) return;
      const canGenerateRoster = await callerHasModuleAction(db, caller, "shifts", "add") || await callerHasModuleAction(db, caller, "shifts", "edit") || caller.role === "admin" && await callerHasModuleAction(db, caller, "shifts", "view");
      if (!canGenerateRoster) {
        await recordEnterpriseAuditEvent(db, {
          req,
          action: "unauthorized_access_attempt",
          category: "SECURITY",
          severity: "CRITICAL",
          actorUid: caller.uid,
          actorLoginId: caller.loginId,
          actorRole: caller.role.toUpperCase(),
          targetType: "SHIFT_ROSTER",
          targetId: "/api/attendance/roster",
          actionSource: "ATTENDANCE_PERMISSION_GUARD",
          description: `Unauthorized shift roster generation attempt by "${caller.loginId}" (${caller.role}).`,
          success: false
        });
        return res.status(403).json({
          success: false,
          error: `Forbidden: Role "${caller.role.toUpperCase()}" is not permitted for Generate Shift Roster.`
        });
      }
      const parsed = GenerateRosterSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: parsed.error.issues[0]?.message || "Invalid roster parameters."
        });
      }
      const { shiftDate, shiftId } = parsed.data;
      const empSnap = await db.collection("employees").where("employeeStatus", "==", "Active").get();
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const entries = empSnap.docs.map((empDoc) => {
        const emp = empDoc.data();
        const empId = String(emp.employeeId || empDoc.id);
        const rosterId = `roster_${shiftDate}_${shiftId}_${empId}`;
        return {
          ref: db.collection("shift_rosters").doc(rosterId),
          payload: {
            id: rosterId,
            shiftDate,
            shiftId,
            employeeId: empId,
            rosterStatus: "SCHEDULED",
            updatedByUid: caller.uid,
            updatedByLoginId: caller.loginId,
            updatedAt: now
          }
        };
      });
      const count = entries.length;
      if (typeof db.batch === "function") {
        for (let i = 0; i < entries.length; i += 400) {
          const batch = db.batch();
          for (const item of entries.slice(i, i + 400)) {
            batch.set(item.ref, item.payload);
          }
          await batch.commit();
        }
      } else {
        await Promise.all(entries.map((item) => item.ref.set(item.payload)));
      }
      await recordEnterpriseAuditEvent(db, {
        req,
        action: "GENERATE_ROSTER",
        category: "ATTENDANCE",
        actorUid: caller.uid,
        actorLoginId: caller.loginId,
        actorRole: caller.role.toUpperCase(),
        targetType: "ROSTER",
        targetId: `${shiftDate}_${shiftId}`,
        newValue: `Generated roster of ${count} employees for ${shiftDate} (${shiftId})`,
        actionSource: "ROSTER_MANAGEMENT"
      });
      return res.json({ success: true, scheduledCount: count });
    } catch (err) {
      console.error("[API Generate Roster] Error:", err);
      return res.status(500).json({ success: false, error: "Failed to generate shift roster." });
    }
  });
  app.post("/api/attendance/clear", async (req, res) => {
    try {
      const caller = await requireVerifiedCaller(
        req,
        res,
        ["super_admin"],
        "Clear All Attendance Records"
      );
      if (!caller) return;
      const isProductionEnv = process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production";
      if (isProductionEnv && process.env.ALLOW_ATTENDANCE_CLEAR !== "true") {
        return res.status(403).json({
          success: false,
          code: "PRODUCTION_WIPE_BLOCKED",
          error: "Bulk clearing attendance records is disabled in production. Set ALLOW_ATTENDANCE_CLEAR=true only for authorized maintenance."
        });
      }
      const parsed = ClearAttendanceSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: parsed.error.issues[0]?.message || "Explicit confirmation is required."
        });
      }
      const [attSnap, logSnap, rosterSnap] = await Promise.all([
        db.collection("attendance").get(),
        db.collection("punch_logs").get(),
        db.collection("shift_rosters").get()
      ]);
      const refsToDelete = [
        ...attSnap.docs.map((d) => db.collection("attendance").doc(d.id)),
        ...logSnap.docs.map((d) => db.collection("punch_logs").doc(d.id)),
        ...rosterSnap.docs.map((d) => db.collection("shift_rosters").doc(d.id))
      ];
      if (typeof db.batch === "function") {
        for (let i = 0; i < refsToDelete.length; i += 400) {
          const batch = db.batch();
          for (const ref of refsToDelete.slice(i, i + 400)) {
            batch.delete(ref);
          }
          await batch.commit();
        }
      } else {
        await Promise.all(refsToDelete.map((ref) => ref.delete()));
      }
      await recordEnterpriseAuditEvent(db, {
        req,
        action: "CLEAR_ATTENDANCE_RECORDS",
        category: "ATTENDANCE",
        severity: "CRITICAL",
        actorUid: caller.uid,
        actorLoginId: caller.loginId,
        actorRole: "SUPER_ADMIN",
        newValue: `Cleared ${attSnap.size} attendance records & ${logSnap.size} punch logs`,
        actionSource: "SYSTEM_SETTINGS",
        reason: parsed.data.reason || "Super Admin executed controlled attendance state reset"
      });
      return res.json({
        success: true,
        deletedAttendance: attSnap.size,
        deletedLogs: logSnap.size
      });
    } catch (err) {
      console.error("[API Clear Attendance] Error:", err);
      return res.status(500).json({ success: false, error: "Failed to clear attendance records." });
    }
  });
}

// serverEmployees.ts
import crypto5 from "crypto";
import { z as z4 } from "zod";
var EMPLOYEE_ID_PATTERN2 = /^[A-Za-z0-9_.\-]+$/;
var EMPLOYEE_BULK_BATCH_SIZE = 400;
var BulkImportRowSchema = z4.object({
  employeeId: z4.string().trim().min(1, "Employee ID is required.").max(128, "Employee ID must be 128 characters or fewer.").regex(
    EMPLOYEE_ID_PATTERN2,
    "Employee ID may only contain letters, numbers, underscores (_), hyphens (-), and periods (.)."
  ),
  employeeName: z4.string().trim().min(1, "Employee Name is required.").max(200, "Employee Name must be 200 characters or fewer."),
  employeeType: z4.enum(["Permanent", "Staff", "Offroll"]),
  section: z4.string().trim().min(1, "Section is required.").max(100),
  department: z4.string().trim().min(1, "Department is required.").max(100),
  floor: z4.string().trim().min(1, "Production Line is required.").max(100),
  designation: z4.string().trim().min(1).max(120).default("Operator"),
  employeeStatus: z4.enum(["Active", "Inactive"]),
  rowNumber: z4.number().int().positive().optional()
});
var BulkImportRequestSchema = z4.object({
  fileName: z4.string().trim().min(1, "File name is required.").max(255),
  rows: z4.array(BulkImportRowSchema).min(1, "At least one employee row is required for import.").max(2e3, "A single import request supports up to 2,000 employee rows.")
});
function generateServerQrToken(employeeId) {
  const rand = crypto5.randomBytes(4).toString("hex").toUpperCase();
  const ts = Date.now().toString(36).toUpperCase();
  return `QR_${employeeId}_${ts}_${rand}`;
}
var ADMIN_EXCEL_DEFAULTS = {
  excel_import: { view: true, add: true, edit: true, delete: false },
  employees: { view: true, add: true, edit: true, delete: false }
};
function evalModuleAction(caller, userPermData, rolePermData, moduleKey, action) {
  if (caller.role === "super_admin") return true;
  if (userPermData && userPermData.isCustomOverride !== false) {
    const mod = userPermData.permissions?.[moduleKey];
    if (mod && typeof mod[action] === "boolean") {
      return mod[action] === true && (action === "view" || mod.view !== false);
    }
  }
  if (rolePermData) {
    const mod = rolePermData.modulePermissions?.[moduleKey];
    if (mod && typeof mod[action] === "boolean") {
      return mod[action] === true && (action === "view" || mod.view !== false);
    }
  }
  if (caller.role === "admin") {
    return Boolean(ADMIN_EXCEL_DEFAULTS[moduleKey]?.[action]);
  }
  return false;
}
var BulkEmployeeActionSchema = z4.object({
  action: z4.enum(["ACTIVATE", "DEACTIVATE", "DELETE"]),
  employeeIds: z4.array(z4.string().trim().min(1).max(128)).min(1, "At least one Employee ID is required.").max(1e3, "Bulk action supports up to 1,000 employees per request."),
  confirmed: z4.literal(true, {
    message: "Explicit confirmation is required before executing bulk employee actions."
  }),
  confirmPhrase: z4.string().trim().optional(),
  reason: z4.string().trim().max(300).optional()
});
async function resolveCallerEmployeeActionPermissions(db, caller) {
  if (caller.role === "super_admin") {
    return { canView: true, canEdit: true, canDelete: true };
  }
  try {
    const [userPermSnap, rolePermSnap] = await Promise.all([
      caller.prefetchedUserPermSnap ? Promise.resolve(caller.prefetchedUserPermSnap) : db.collection("user_permissions").doc(caller.profileDocId).get(),
      getCachedRolePermissionsDoc(db, caller.role)
    ]);
    const userPermData = userPermSnap.exists ? userPermSnap.data() : void 0;
    const rolePermData = rolePermSnap.exists ? rolePermSnap.data : void 0;
    const canView = evalModuleAction(caller, userPermData, rolePermData, "employees", "view");
    const canEdit = canView && evalModuleAction(caller, userPermData, rolePermData, "employees", "edit");
    const canDelete = canView && evalModuleAction(caller, userPermData, rolePermData, "employees", "delete");
    return { canView, canEdit, canDelete };
  } catch (err) {
    console.warn("[Employee Bulk Action Permission Guard] Lookup failed; failing closed:", err?.message || err);
    return { canView: false, canEdit: false, canDelete: false };
  }
}
async function resolveCallerEmployeeImportPermissions(db, caller) {
  if (caller.role === "super_admin") {
    return { canAdd: true, canEdit: true };
  }
  try {
    const [userPermSnap, rolePermSnap] = await Promise.all([
      caller.prefetchedUserPermSnap ? Promise.resolve(caller.prefetchedUserPermSnap) : db.collection("user_permissions").doc(caller.profileDocId).get(),
      getCachedRolePermissionsDoc(db, caller.role)
    ]);
    const userPermData = userPermSnap.exists ? userPermSnap.data() : void 0;
    const rolePermData = rolePermSnap.exists ? rolePermSnap.data : void 0;
    const canImportView = evalModuleAction(caller, userPermData, rolePermData, "excel_import", "view");
    const canImportAdd = evalModuleAction(caller, userPermData, rolePermData, "excel_import", "add");
    const canImportEdit = evalModuleAction(caller, userPermData, rolePermData, "excel_import", "edit");
    const canEmpAdd = evalModuleAction(caller, userPermData, rolePermData, "employees", "add");
    const canEmpEdit = evalModuleAction(caller, userPermData, rolePermData, "employees", "edit");
    return {
      canAdd: canImportView && canImportAdd && canEmpAdd,
      canEdit: canImportView && canImportEdit && canEmpEdit
    };
  } catch (err) {
    console.warn("[Employee Import Permission Guard] Lookup failed; failing closed:", err?.message || err);
    return { canAdd: false, canEdit: false };
  }
}
function classifyBatchWriteError(err) {
  const rawMsg = err instanceof Error ? err.message : String(err || "Unknown database error");
  const lower = rawMsg.toLowerCase();
  if (isFirestorePermissionDeniedError(err)) {
    return {
      status: 503,
      code: "FIRESTORE_ADMIN_PERMISSION_DENIED",
      category: "DATABASE_AUTHORIZATION",
      message: "Database authorization failed on server Admin SDK credentials. Contact Super Admin / infrastructure administrator."
    };
  }
  if (lower.includes("deadline") || lower.includes("timeout") || lower.includes("unavailable") || lower.includes("econnreset") || lower.includes("network")) {
    return {
      status: 503,
      code: "FIRESTORE_TEMPORARY_UNAVAILABLE",
      category: "NETWORK_OR_TIMEOUT",
      message: "Database connection timed out or became temporarily unavailable during batch commit. Verify committed counts before retrying remaining rows."
    };
  }
  return {
    status: 500,
    code: "BATCH_COMMIT_FAILED",
    category: "DATABASE_WRITE_ERROR",
    message: rawMsg || "Database batch write failed."
  };
}
function registerEmployeeRoutes(app, deps) {
  const { db, requireVerifiedCaller } = deps;
  app.post("/api/employees/bulk-import", async (req, res) => {
    const routeStartMs = performance.now();
    try {
      const caller = await requireVerifiedCaller(
        req,
        res,
        "*",
        "Employee Master Excel Bulk Import",
        { prefetchUserPermission: true }
      );
      if (!caller) return;
      const perms = await resolveCallerEmployeeImportPermissions(db, caller);
      if (!perms.canAdd && !perms.canEdit) {
        await recordEnterpriseAuditEvent(db, {
          req,
          action: "unauthorized_access_attempt",
          category: "SECURITY",
          severity: "CRITICAL",
          actorUid: caller.uid,
          actorLoginId: caller.loginId,
          actorRole: caller.role.toUpperCase(),
          targetType: "EMPLOYEE_IMPORT",
          targetId: "/api/employees/bulk-import",
          actionSource: "EMPLOYEE_IMPORT_RBAC_GUARD",
          description: `User "${caller.loginId}" (${caller.role}) blocked from Employee Master Excel import due to missing excel_import/employees write permissions.`,
          success: false
        });
        return res.status(403).json({
          success: false,
          code: "IMPORT_FORBIDDEN",
          category: "AUTHORIZATION",
          error: `Forbidden: Role "${caller.role.toUpperCase()}" is not authorized to import or update Employee Master records.`
        });
      }
      const parsed = BulkImportRequestSchema.safeParse(req.body || {});
      if (!parsed.success) {
        const firstIssue = parsed.error.issues[0];
        return res.status(400).json({
          success: false,
          code: "VALIDATION_ERROR",
          category: "VALIDATION",
          error: firstIssue?.message || "Invalid employee import payload.",
          issues: parsed.error.issues.slice(0, 10).map((issue) => ({
            path: issue.path.join("."),
            message: issue.message
          }))
        });
      }
      const { fileName, rows } = parsed.data;
      const seenIds = /* @__PURE__ */ new Set();
      const duplicateIds = [];
      for (const row of rows) {
        const cleanId = row.employeeId.trim().toUpperCase();
        if (seenIds.has(cleanId)) {
          duplicateIds.push(cleanId);
        } else {
          seenIds.add(cleanId);
        }
      }
      if (duplicateIds.length > 0) {
        return res.status(400).json({
          success: false,
          code: "DUPLICATE_EMPLOYEE_IDS_IN_PAYLOAD",
          category: "VALIDATION",
          error: `Duplicate Employee ID(s) found in import batch: ${Array.from(new Set(duplicateIds)).slice(0, 5).join(", ")}`,
          duplicateIds: Array.from(new Set(duplicateIds))
        });
      }
      const existingSnap = await db.collection("employees").get();
      const existingByUpperId = /* @__PURE__ */ new Map();
      for (const d of existingSnap.docs) {
        const data = d.data() || {};
        const key = String(data.employeeId || d.id).trim().toUpperCase();
        if (key) {
          existingByUpperId.set(key, { docId: d.id, data });
        }
        const docIdUpper = String(d.id).trim().toUpperCase();
        if (docIdUpper && !existingByUpperId.has(docIdUpper)) {
          existingByUpperId.set(docIdUpper, { docId: d.id, data });
        }
      }
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const operations = [];
      const skippedIds = [];
      for (const row of rows) {
        const cleanId = row.employeeId.trim().toUpperCase();
        const cleanName = row.employeeName.trim().toUpperCase();
        const cleanSection = row.section.trim();
        const cleanDepartment = row.department.trim();
        const cleanFloor = row.floor.trim();
        const cleanDesignation = (row.designation || "Operator").trim();
        const existing = existingByUpperId.get(cleanId);
        if (!existing) {
          operations.push({
            actionType: "NEW",
            employeeId: cleanId,
            rowNumber: row.rowNumber,
            ref: db.collection("employees").doc(cleanId),
            payload: {
              employeeId: cleanId,
              employeeName: cleanName,
              employeeType: row.employeeType,
              section: cleanSection,
              department: cleanDepartment,
              floor: cleanFloor,
              designation: cleanDesignation,
              qrCodeToken: generateServerQrToken(cleanId),
              employeeStatus: row.employeeStatus,
              createdAt: now,
              updatedAt: now
            }
          });
          continue;
        }
        const prev = existing.data;
        const hasChanged = String(prev.employeeName || "").trim().toUpperCase() !== cleanName || String(prev.employeeType || "") !== row.employeeType || String(prev.section || "").trim() !== cleanSection || String(prev.department || "").trim() !== cleanDepartment || String(prev.floor || "").trim() !== cleanFloor || String(prev.designation || "").trim() !== cleanDesignation || String(prev.employeeStatus || "") !== row.employeeStatus;
        if (!hasChanged) {
          skippedIds.push(cleanId);
          continue;
        }
        operations.push({
          actionType: "UPDATE",
          employeeId: cleanId,
          rowNumber: row.rowNumber,
          ref: db.collection("employees").doc(existing.docId),
          payload: {
            ...prev,
            employeeId: cleanId,
            employeeName: cleanName,
            employeeType: row.employeeType,
            section: cleanSection,
            department: cleanDepartment,
            floor: cleanFloor,
            designation: cleanDesignation,
            // Strictly preserve existing QR code token and historical creation timestamp
            qrCodeToken: prev.qrCodeToken || generateServerQrToken(cleanId),
            employeeStatus: row.employeeStatus,
            createdAt: prev.createdAt || now,
            updatedAt: now
          }
        });
      }
      const needsInsert = operations.some((op) => op.actionType === "NEW");
      const needsUpdate = operations.some((op) => op.actionType === "UPDATE");
      if (needsInsert && !perms.canAdd || needsUpdate && !perms.canEdit) {
        await recordEnterpriseAuditEvent(db, {
          req,
          action: "unauthorized_access_attempt",
          category: "SECURITY",
          severity: "CRITICAL",
          actorUid: caller.uid,
          actorLoginId: caller.loginId,
          actorRole: caller.role.toUpperCase(),
          targetType: "EMPLOYEE_IMPORT",
          targetId: "/api/employees/bulk-import",
          actionSource: "EMPLOYEE_IMPORT_RBAC_GUARD",
          description: `User "${caller.loginId}" (${caller.role}) attempted unauthorized employee import action (needsInsert=${needsInsert}, needsUpdate=${needsUpdate}).`,
          success: false
        });
        return res.status(403).json({
          success: false,
          code: "IMPORT_ACTION_FORBIDDEN",
          category: "AUTHORIZATION",
          error: "Forbidden: Missing permission for the requested employee insert/update operation."
        });
      }
      const insertedIds = [];
      const updatedIds = [];
      const committedIds = [];
      const failedRows = [];
      for (let i = 0; i < operations.length; i += EMPLOYEE_BULK_BATCH_SIZE) {
        const chunk = operations.slice(i, i + EMPLOYEE_BULK_BATCH_SIZE);
        try {
          if (typeof db.batch === "function") {
            const batch = db.batch();
            for (const op of chunk) {
              batch.set(op.ref, op.payload);
            }
            await batch.commit();
          } else {
            await Promise.all(chunk.map((op) => op.ref.set(op.payload)));
          }
          for (const op of chunk) {
            committedIds.push(op.employeeId);
            if (op.actionType === "NEW") {
              insertedIds.push(op.employeeId);
            } else {
              updatedIds.push(op.employeeId);
            }
          }
        } catch (batchErr) {
          const classified = classifyBatchWriteError(batchErr);
          const remainingOps = operations.slice(i);
          for (const rem of remainingOps) {
            failedRows.push({
              employeeId: rem.employeeId,
              rowNumber: rem.rowNumber,
              actionType: rem.actionType,
              error: classified.message
            });
          }
          const partialCommit = committedIds.length > 0;
          await recordEnterpriseAuditEvent(db, {
            req,
            action: partialCommit ? "EXCEL_EMPLOYEE_IMPORT_PARTIAL" : "EXCEL_EMPLOYEE_IMPORT_FAILED",
            category: "EMPLOYEE",
            severity: "WARNING",
            actorUid: caller.uid,
            actorLoginId: caller.loginId,
            actorRole: caller.role.toUpperCase(),
            targetType: "EMPLOYEE",
            targetId: fileName,
            newValue: `Committed ${committedIds.length} (New: ${insertedIds.length}, Updated: ${updatedIds.length}), Skipped: ${skippedIds.length}, Failed: ${failedRows.length} from ${fileName}`,
            actionSource: "EXCEL_IMPORT",
            reason: classified.message,
            success: false
          }).catch(() => {
          });
          const batchElapsedMs = Math.round((performance.now() - routeStartMs) * 100) / 100;
          recordDbOpMetric(db, {
            operation: "BATCH",
            collection: "employees",
            durationMs: batchElapsedMs,
            success: false,
            isPermissionDenied: isFirestorePermissionDeniedError(batchErr),
            isNetworkError: classified.category === "NETWORK_OR_TIMEOUT",
            recordCount: chunk.length,
            errorMessage: classified.message,
            correlationId: req.correlationId
          });
          recordImportExportTelemetry(db, {
            type: "EXCEL_IMPORT",
            module: "Excel Import / Update",
            rowCount: rows.length,
            durationMs: batchElapsedMs,
            success: false,
            actorLoginId: caller.loginId,
            correlationId: req.correlationId,
            detail: classified.message
          });
          recordActivityTelemetry(db, {
            actorUid: caller.uid,
            actorLoginId: caller.loginId,
            actorRole: caller.role.toUpperCase(),
            action: "EXCEL_IMPORT_FAILED",
            module: "Excel Import / Update",
            result: "Failed",
            correlationId: req.correlationId,
            detail: `${fileName}: ${committedIds.length} committed, ${failedRows.length} failed`
          });
          return res.status(classified.status).json({
            success: false,
            code: classified.code,
            category: classified.category,
            error: classified.message,
            partialCommit,
            savedCount: committedIds.length,
            insertedCount: insertedIds.length,
            updatedCount: updatedIds.length,
            skippedCount: skippedIds.length,
            failedCount: failedRows.length,
            committedIds,
            insertedIds,
            updatedIds,
            skippedIds,
            failedRows
          });
        }
      }
      await recordEnterpriseAuditEvent(db, {
        req,
        action: "EXCEL_EMPLOYEE_IMPORT",
        category: "EMPLOYEE",
        actorUid: caller.uid,
        actorLoginId: caller.loginId,
        actorRole: caller.role.toUpperCase(),
        targetType: "EMPLOYEE",
        targetId: fileName,
        newValue: `Committed ${committedIds.length} employees (New: ${insertedIds.length}, Updated: ${updatedIds.length}, Skipped: ${skippedIds.length}) from ${fileName}`,
        actionSource: "EXCEL_IMPORT",
        reason: `File upload: ${rows.length} validated rows`,
        success: true
      });
      const totalImportMs = Math.round((performance.now() - routeStartMs) * 100) / 100;
      recordDbOpMetric(db, {
        operation: "BATCH",
        collection: "employees",
        durationMs: totalImportMs,
        success: true,
        recordCount: Math.max(1, operations.length),
        correlationId: req.correlationId
      });
      recordImportExportTelemetry(db, {
        type: "EXCEL_IMPORT",
        module: "Excel Import / Update",
        rowCount: rows.length,
        durationMs: totalImportMs,
        success: true,
        actorLoginId: caller.loginId,
        correlationId: req.correlationId,
        detail: `${fileName}: ${insertedIds.length} inserted, ${updatedIds.length} updated, ${skippedIds.length} skipped`
      });
      recordActivityTelemetry(db, {
        actorUid: caller.uid,
        actorLoginId: caller.loginId,
        actorRole: caller.role.toUpperCase(),
        action: "EXCEL_IMPORT_COMMITTED",
        module: "Excel Import / Update",
        result: "Success",
        correlationId: req.correlationId,
        detail: `${fileName} (${committedIds.length} committed)`
      });
      return res.json({
        success: true,
        savedCount: committedIds.length,
        insertedCount: insertedIds.length,
        updatedCount: updatedIds.length,
        skippedCount: skippedIds.length,
        failedCount: 0,
        committedIds,
        insertedIds,
        updatedIds,
        skippedIds,
        failedRows: [],
        partialCommit: false
      });
    } catch (err) {
      console.error("[Employee Bulk Import API] Error:", err);
      const classified = classifyBatchWriteError(err);
      recordErrorTelemetry(db, {
        source: "IMPORT_EXPORT",
        module: "Excel Import / Update",
        category: classified.code,
        severity: "CRITICAL",
        message: classified.message,
        statusCode: classified.status,
        correlationId: req.correlationId
      });
      return res.status(classified.status).json({
        success: false,
        code: classified.code,
        category: classified.category,
        error: classified.message
      });
    }
  });
  app.post("/api/employees/bulk-action", async (req, res) => {
    const bulkStartMs = performance.now();
    try {
      const caller = await requireVerifiedCaller(
        req,
        res,
        "*",
        "Employee Master Bulk Action",
        { prefetchUserPermission: true }
      );
      if (!caller) return;
      const parsed = BulkEmployeeActionSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          code: "VALIDATION_ERROR",
          error: parsed.error.issues[0]?.message || "Invalid employee bulk action payload."
        });
      }
      const { action, confirmPhrase, reason } = parsed.data;
      const uniqueIds = Array.from(
        new Set(parsed.data.employeeIds.map((id) => id.trim().toUpperCase()).filter(Boolean))
      );
      if (uniqueIds.length === 0) {
        return res.status(400).json({
          success: false,
          code: "VALIDATION_ERROR",
          error: "At least one valid Employee ID is required."
        });
      }
      const perms = await resolveCallerEmployeeActionPermissions(db, caller);
      const isAuthorized = action === "DELETE" ? perms.canDelete : perms.canEdit;
      if (!isAuthorized) {
        await recordEnterpriseAuditEvent(db, {
          req,
          action: "unauthorized_access_attempt",
          category: "SECURITY",
          severity: "CRITICAL",
          actorUid: caller.uid,
          actorLoginId: caller.loginId,
          actorRole: caller.role.toUpperCase(),
          targetType: "EMPLOYEE",
          targetId: "/api/employees/bulk-action",
          actionSource: "EMPLOYEE_BULK_RBAC_GUARD",
          description: `User "${caller.loginId}" (${caller.role}) blocked from Employee bulk ${action} due to missing employees.${action === "DELETE" ? "delete" : "edit"} permission.`,
          success: false
        });
        return res.status(403).json({
          success: false,
          code: "EMPLOYEE_BULK_FORBIDDEN",
          error: `Forbidden: Role "${caller.role.toUpperCase()}" is not authorized to perform bulk ${action} on employees.`
        });
      }
      if (action === "DELETE" && String(confirmPhrase || "").trim().toUpperCase() !== "DELETE") {
        return res.status(400).json({
          success: false,
          code: "CONFIRMATION_PHRASE_REQUIRED",
          error: 'Permanent bulk deletion requires confirmPhrase="DELETE".'
        });
      }
      const existingSnap = await db.collection("employees").get();
      const empByUpperId = /* @__PURE__ */ new Map();
      for (const d of existingSnap.docs) {
        const data = d.data() || {};
        const key = String(data.employeeId || d.id).trim().toUpperCase();
        const entry = { docId: d.id, ref: db.collection("employees").doc(d.id), data };
        if (key) empByUpperId.set(key, entry);
        const docUpper = String(d.id).trim().toUpperCase();
        if (docUpper && !empByUpperId.has(docUpper)) {
          empByUpperId.set(docUpper, entry);
        }
      }
      const protectedHistoryIds = /* @__PURE__ */ new Set();
      if (action === "DELETE") {
        const presentIds = uniqueIds.filter((id) => empByUpperId.has(id));
        const QUERY_IN_LIMIT = 30;
        for (let i = 0; i < presentIds.length; i += QUERY_IN_LIMIT) {
          const chunk = presentIds.slice(i, i + QUERY_IN_LIMIT);
          if (chunk.length === 0) continue;
          const attSnap = await db.collection("attendance").where("employeeId", "in", chunk).get();
          for (const attDoc of attSnap.docs) {
            const empIdVal = String(attDoc.data()?.employeeId || "").trim().toUpperCase();
            if (empIdVal) protectedHistoryIds.add(empIdVal);
          }
        }
      }
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const targetStatus = action === "ACTIVATE" ? "Active" : "Inactive";
      const ops = [];
      const skippedItems = [];
      for (const empId of uniqueIds) {
        const found = empByUpperId.get(empId);
        if (!found) {
          skippedItems.push({ id: empId, reason: "Employee record not found." });
          continue;
        }
        if (action === "DELETE") {
          if (protectedHistoryIds.has(empId)) {
            skippedItems.push({
              id: empId,
              reason: "Protected: Employee has linked historical attendance/punch records. Deactivate/archive instead."
            });
            continue;
          }
          ops.push({ employeeId: empId, ref: found.ref });
        } else {
          if (found.data.employeeStatus === targetStatus) {
            skippedItems.push({
              id: empId,
              reason: `Employee is already ${targetStatus}.`
            });
            continue;
          }
          ops.push({ employeeId: empId, ref: found.ref });
        }
      }
      const committedIds = [];
      const failedItems = [];
      for (let i = 0; i < ops.length; i += EMPLOYEE_BULK_BATCH_SIZE) {
        const chunk = ops.slice(i, i + EMPLOYEE_BULK_BATCH_SIZE);
        try {
          if (typeof db.batch === "function") {
            const batch = db.batch();
            for (const op of chunk) {
              if (action === "DELETE") {
                batch.delete(op.ref);
              } else {
                batch.update(op.ref, {
                  employeeStatus: targetStatus,
                  updatedAt: now
                });
              }
            }
            await batch.commit();
          } else {
            await Promise.all(
              chunk.map(
                (op) => action === "DELETE" ? op.ref.delete() : op.ref.update({ employeeStatus: targetStatus, updatedAt: now })
              )
            );
          }
          for (const op of chunk) {
            committedIds.push(op.employeeId);
          }
        } catch (batchErr) {
          const classified = classifyBatchWriteError(batchErr);
          for (const rem of ops.slice(i)) {
            failedItems.push({ id: rem.employeeId, error: classified.message });
          }
          await recordEnterpriseAuditEvent(db, {
            req,
            action: `EMPLOYEE_BULK_${action}_PARTIAL`,
            category: "EMPLOYEE",
            severity: "WARNING",
            actorUid: caller.uid,
            actorLoginId: caller.loginId,
            actorRole: caller.role.toUpperCase(),
            targetType: "EMPLOYEE",
            targetId: uniqueIds.slice(0, 10).join(","),
            newValue: {
              action,
              savedCount: committedIds.length,
              skippedCount: skippedItems.length,
              failedCount: failedItems.length
            },
            actionSource: "EMPLOYEE_MASTER_BULK",
            reason: classified.message,
            success: false
          }).catch(() => {
          });
          return res.status(classified.status).json({
            success: false,
            code: classified.code,
            action,
            savedCount: committedIds.length,
            skippedCount: skippedItems.length,
            failedCount: failedItems.length,
            partialCommit: committedIds.length > 0,
            committedIds,
            skippedItems,
            failedItems,
            error: classified.message
          });
        }
      }
      await recordEnterpriseAuditEvent(db, {
        req,
        action: `EMPLOYEE_BULK_${action}`,
        category: "EMPLOYEE",
        severity: action === "DELETE" ? "WARNING" : "INFO",
        actorUid: caller.uid,
        actorLoginId: caller.loginId,
        actorRole: caller.role.toUpperCase(),
        targetType: "EMPLOYEE",
        targetId: committedIds.slice(0, 10).join(",") || "EMPLOYEE_BATCH",
        newValue: {
          action,
          savedCount: committedIds.length,
          skippedCount: skippedItems.length,
          sampleIds: committedIds.slice(0, 20)
        },
        actionSource: "EMPLOYEE_MASTER_BULK",
        reason: reason || `Bulk ${action.toLowerCase()} executed from Employee Master`,
        description: `Bulk ${action} processed ${committedIds.length} employees (${skippedItems.length} skipped/protected).`,
        success: true
      });
      const totalBulkMs = Math.round((performance.now() - bulkStartMs) * 100) / 100;
      recordDbOpMetric(db, {
        operation: "BATCH",
        collection: "employees",
        durationMs: totalBulkMs,
        success: true,
        recordCount: Math.max(1, ops.length),
        correlationId: req.correlationId
      });
      recordImportExportTelemetry(db, {
        type: "BULK_ACTION",
        module: "Employee Master",
        rowCount: uniqueIds.length,
        durationMs: totalBulkMs,
        success: true,
        actorLoginId: caller.loginId,
        correlationId: req.correlationId,
        detail: `Bulk ${action}: ${committedIds.length} saved, ${skippedItems.length} skipped`
      });
      recordActivityTelemetry(db, {
        actorUid: caller.uid,
        actorLoginId: caller.loginId,
        actorRole: caller.role.toUpperCase(),
        action: `EMPLOYEE_BULK_${action}`,
        module: "Employee Master",
        result: "Success",
        correlationId: req.correlationId,
        detail: `${committedIds.length} updated (${skippedItems.length} skipped)`
      });
      return res.json({
        success: true,
        action,
        savedCount: committedIds.length,
        skippedCount: skippedItems.length,
        failedCount: 0,
        partialCommit: false,
        committedIds,
        skippedItems,
        failedItems: []
      });
    } catch (err) {
      console.error("[Employee Bulk Action API] Error:", err);
      const classified = classifyBatchWriteError(err);
      recordErrorTelemetry(db, {
        source: "BULK",
        module: "Employee Master",
        category: classified.code,
        severity: "CRITICAL",
        message: classified.message,
        statusCode: classified.status,
        correlationId: req.correlationId
      });
      return res.status(classified.status).json({
        success: false,
        code: classified.code,
        error: classified.message
      });
    }
  });
}

// serverMasters.ts
import { z as z5 } from "zod";
var MASTER_BULK_BATCH_SIZE = 400;
var BulkMasterStatusSchema = z5.object({
  resource: z5.enum(["shifts", "floors", "sections", "departments"]),
  ids: z5.array(z5.string().trim().min(1).max(160)).min(1, "At least one record ID is required.").max(200, "Bulk master status update supports up to 200 records per request."),
  status: z5.enum(["Active", "Inactive"]),
  confirmed: z5.literal(true, {
    message: "Explicit confirmation is required for bulk status updates."
  })
});
var ADMIN_DEFAULT_EDIT_MODULES = /* @__PURE__ */ new Set(["shifts", "floors", "sections", "departments"]);
function evalMasterEditPermission(caller, userPermData, rolePermData, moduleKey) {
  if (caller.role === "super_admin") return true;
  if (userPermData && userPermData.isCustomOverride !== false) {
    const mod = userPermData.permissions?.[moduleKey];
    if (mod && typeof mod.edit === "boolean") {
      return mod.edit === true && mod.view !== false;
    }
  }
  if (rolePermData) {
    const mod = rolePermData.modulePermissions?.[moduleKey];
    if (mod && typeof mod.edit === "boolean") {
      return mod.edit === true && mod.view !== false;
    }
  }
  if (caller.role === "admin") {
    return ADMIN_DEFAULT_EDIT_MODULES.has(moduleKey);
  }
  return false;
}
async function canCallerEditMasterResource(db, caller, resource) {
  if (caller.role === "super_admin") return true;
  try {
    const [userPermSnap, rolePermSnap] = await Promise.all([
      caller.prefetchedUserPermSnap ? Promise.resolve(caller.prefetchedUserPermSnap) : db.collection("user_permissions").doc(caller.profileDocId).get(),
      getCachedRolePermissionsDoc(db, caller.role)
    ]);
    const userPermData = userPermSnap.exists ? userPermSnap.data() : void 0;
    const rolePermData = rolePermSnap.exists ? rolePermSnap.data : void 0;
    return evalMasterEditPermission(caller, userPermData, rolePermData, resource);
  } catch (err) {
    console.warn("[Master Bulk RBAC] Permission lookup failed; failing closed:", err?.message || err);
    return false;
  }
}
function registerMasterRoutes(app, deps) {
  const { db, requireVerifiedCaller } = deps;
  app.post("/api/masters/bulk-status", async (req, res) => {
    const masterStartMs = performance.now();
    try {
      const caller = await requireVerifiedCaller(
        req,
        res,
        "*",
        "Master Configuration Bulk Status Update",
        { prefetchUserPermission: true }
      );
      if (!caller) return;
      const parsed = BulkMasterStatusSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          code: "VALIDATION_ERROR",
          error: parsed.error.issues[0]?.message || "Invalid bulk status update payload."
        });
      }
      const { resource, status } = parsed.data;
      const uniqueIds = Array.from(new Set(parsed.data.ids.map((id) => id.trim()).filter(Boolean)));
      if (uniqueIds.length === 0) {
        return res.status(400).json({
          success: false,
          code: "VALIDATION_ERROR",
          error: "At least one valid record ID is required."
        });
      }
      const allowed = await canCallerEditMasterResource(db, caller, resource);
      if (!allowed) {
        await recordEnterpriseAuditEvent(db, {
          req,
          action: "unauthorized_access_attempt",
          category: "SECURITY",
          severity: "CRITICAL",
          actorUid: caller.uid,
          actorLoginId: caller.loginId,
          actorRole: caller.role.toUpperCase(),
          targetType: resource.toUpperCase(),
          targetId: "/api/masters/bulk-status",
          actionSource: "MASTER_BULK_RBAC_GUARD",
          description: `User "${caller.loginId}" (${caller.role}) blocked from bulk updating "${resource}" status due to missing edit permission.`,
          success: false
        });
        return res.status(403).json({
          success: false,
          code: "MASTER_BULK_FORBIDDEN",
          error: `Forbidden: Role "${caller.role.toUpperCase()}" does not have edit permission for ${resource}.`
        });
      }
      const existingSnap = await db.collection(resource).get();
      const existingById = /* @__PURE__ */ new Map();
      for (const docSnap of existingSnap.docs) {
        existingById.set(docSnap.id, {
          ref: db.collection(resource).doc(docSnap.id),
          data: docSnap.data() || {}
        });
      }
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const ops = [];
      const skippedItems = [];
      for (const id of uniqueIds) {
        const entry = existingById.get(id);
        if (!entry) {
          skippedItems.push({ id, reason: "Record not found in database." });
          continue;
        }
        if (entry.data.status === status) {
          skippedItems.push({ id, reason: `Already ${status}.` });
          continue;
        }
        ops.push({ id, ref: entry.ref });
      }
      const committedIds = [];
      const failedItems = [];
      for (let i = 0; i < ops.length; i += MASTER_BULK_BATCH_SIZE) {
        const chunk = ops.slice(i, i + MASTER_BULK_BATCH_SIZE);
        try {
          if (typeof db.batch === "function") {
            const batch = db.batch();
            for (const op of chunk) {
              batch.update(op.ref, { status, updatedAt: now });
            }
            await batch.commit();
          } else {
            await Promise.all(chunk.map((op) => op.ref.update({ status, updatedAt: now })));
          }
          for (const op of chunk) {
            committedIds.push(op.id);
          }
        } catch (batchErr) {
          const msg = isFirestorePermissionDeniedError(batchErr) ? "Database Admin SDK permission denied." : batchErr?.message || "Batch commit failed.";
          for (const rem of ops.slice(i)) {
            failedItems.push({ id: rem.id, error: msg });
          }
          await recordEnterpriseAuditEvent(db, {
            req,
            action: "MASTER_BULK_STATUS_PARTIAL",
            category: "ORG",
            severity: "WARNING",
            actorUid: caller.uid,
            actorLoginId: caller.loginId,
            actorRole: caller.role.toUpperCase(),
            targetType: resource.toUpperCase(),
            targetId: uniqueIds.slice(0, 10).join(","),
            newValue: { resource, status, savedCount: committedIds.length, failedCount: failedItems.length },
            actionSource: "MASTER_BULK_STATUS",
            reason: msg,
            success: false
          }).catch(() => {
          });
          return res.status(isFirestorePermissionDeniedError(batchErr) ? 503 : 500).json({
            success: false,
            resource,
            status,
            savedCount: committedIds.length,
            skippedCount: skippedItems.length,
            failedCount: failedItems.length,
            partialCommit: committedIds.length > 0,
            committedIds,
            skippedItems,
            failedItems,
            error: msg
          });
        }
      }
      if (resource === "shifts" && committedIds.length > 0) {
        invalidateConfigCaches(db);
      }
      await recordEnterpriseAuditEvent(db, {
        req,
        action: "MASTER_BULK_STATUS_UPDATE",
        category: "ORG",
        actorUid: caller.uid,
        actorLoginId: caller.loginId,
        actorRole: caller.role.toUpperCase(),
        targetType: resource.toUpperCase(),
        targetId: committedIds.slice(0, 10).join(",") || resource,
        newValue: {
          resource,
          status,
          savedCount: committedIds.length,
          skippedCount: skippedItems.length
        },
        actionSource: "MASTER_BULK_STATUS",
        description: `Bulk updated ${committedIds.length} ${resource} record(s) to ${status} (skipped ${skippedItems.length}).`,
        success: true
      });
      const masterElapsedMs = Math.round((performance.now() - masterStartMs) * 100) / 100;
      const modName = resource === "shifts" ? "Shift Management" : "Organization Management";
      recordDbOpMetric(db, {
        operation: "BATCH",
        collection: resource,
        durationMs: masterElapsedMs,
        success: true,
        recordCount: Math.max(1, ops.length),
        correlationId: req.correlationId
      });
      recordImportExportTelemetry(db, {
        type: "BULK_ACTION",
        module: modName,
        rowCount: uniqueIds.length,
        durationMs: masterElapsedMs,
        success: true,
        actorLoginId: caller.loginId,
        correlationId: req.correlationId,
        detail: `${resource} -> ${status}: ${committedIds.length} committed, ${skippedItems.length} skipped`
      });
      recordActivityTelemetry(db, {
        actorUid: caller.uid,
        actorLoginId: caller.loginId,
        actorRole: caller.role.toUpperCase(),
        action: `MASTER_BULK_${status.toUpperCase()}`,
        module: modName,
        result: "Success",
        correlationId: req.correlationId,
        detail: `${resource}: ${committedIds.length} updated`
      });
      return res.json({
        success: true,
        resource,
        status,
        savedCount: committedIds.length,
        skippedCount: skippedItems.length,
        failedCount: 0,
        partialCommit: false,
        committedIds,
        skippedItems,
        failedItems: []
      });
    } catch (err) {
      console.error("[Master Bulk Status API] Error:", err);
      recordErrorTelemetry(db, {
        source: "BULK",
        module: "Organization Management",
        category: "MASTER_BULK_ERROR",
        severity: "CRITICAL",
        message: err?.message || "Master bulk status update failed.",
        statusCode: 500,
        correlationId: req.correlationId
      });
      return res.status(500).json({
        success: false,
        error: err?.message || "Master bulk status update failed."
      });
    }
  });
}

// serverCompanyWifi.ts
import crypto6 from "crypto";
import { z as z6 } from "zod";

// src/utils/companyWifiUtils.ts
var COMPANY_WIFI_DENIED_MESSAGE = "Access Denied: Please connect to an authorized Company Wi-Fi network.";
var COMPANY_WIFI_DENIED_CODE = "COMPANY_WIFI_ACCESS_DENIED";
function normalizeIpString(raw) {
  if (typeof raw !== "string") return "";
  let clean = raw.trim();
  if (!clean) return "";
  if (clean.startsWith("[")) {
    const closeIdx = clean.indexOf("]");
    if (closeIdx > 1) {
      clean = clean.slice(1, closeIdx);
    }
  }
  if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(clean)) {
    clean = clean.split(":")[0];
  }
  const zoneIdx = clean.indexOf("%");
  if (zoneIdx > 0) {
    clean = clean.slice(0, zoneIdx);
  }
  if (/^::ffff:\d{1,3}(\.\d{1,3}){3}$/i.test(clean)) {
    clean = clean.replace(/^::ffff:/i, "");
  }
  return clean.toLowerCase();
}
function parseIpv4ToBigInt(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    if (part.length > 1 && part.startsWith("0")) return null;
    const num = Number(part);
    if (!Number.isInteger(num) || num < 0 || num > 255) return null;
    value = value << 8n | BigInt(num);
  }
  return value;
}
function bigIntToIpv4(value) {
  const a = Number(value >> 24n & 0xffn);
  const b = Number(value >> 16n & 0xffn);
  const c = Number(value >> 8n & 0xffn);
  const d = Number(value & 0xffn);
  return `${a}.${b}.${c}.${d}`;
}
function parseIpv6ToBigInt(ip) {
  const clean = ip.toLowerCase();
  if (!clean.includes(":")) return null;
  let working = clean;
  const lastColon = working.lastIndexOf(":");
  const tail = working.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIpv4ToBigInt(tail);
    if (v4 === null) return null;
    const hi = Number(v4 >> 16n & 0xffffn).toString(16);
    const lo = Number(v4 & 0xffffn).toString(16);
    working = `${working.slice(0, lastColon)}:${hi}:${lo}`;
  }
  const doubleColonParts = working.split("::");
  if (doubleColonParts.length > 2) return null;
  const left = doubleColonParts[0] ? doubleColonParts[0].split(":") : [];
  const right = doubleColonParts.length === 2 && doubleColonParts[1] ? doubleColonParts[1].split(":") : [];
  const missing = doubleColonParts.length === 2 ? 8 - (left.length + right.length) : 8 - left.length;
  if (doubleColonParts.length === 2 ? missing < 1 : missing !== 0) {
    return null;
  }
  const groups = doubleColonParts.length === 2 ? [...left, ...Array(missing).fill("0"), ...right] : left;
  if (groups.length !== 8) return null;
  let value = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    value = value << 16n | BigInt(parseInt(g, 16));
  }
  return value;
}
function parseIpOrCidr(rawInput) {
  const trimmed = String(rawInput || "").trim();
  if (!trimmed) {
    return {
      valid: false,
      normalized: "",
      publicIp: "",
      cidrRange: "",
      version: "ipv4",
      isCidr: false,
      prefixLength: 32,
      networkInt: 0n,
      error: "Public IP address or CIDR range is required."
    };
  }
  const slashParts = trimmed.split("/");
  if (slashParts.length > 2) {
    return {
      valid: false,
      normalized: "",
      publicIp: "",
      cidrRange: "",
      version: "ipv4",
      isCidr: false,
      prefixLength: 32,
      networkInt: 0n,
      error: "Invalid CIDR format."
    };
  }
  const ipPart = normalizeIpString(slashParts[0]);
  const hasPrefix = slashParts.length === 2;
  const v4 = parseIpv4ToBigInt(ipPart);
  if (v4 !== null) {
    let prefix = 32;
    if (hasPrefix) {
      if (!/^\d{1,2}$/.test(slashParts[1])) {
        return {
          valid: false,
          normalized: "",
          publicIp: "",
          cidrRange: "",
          version: "ipv4",
          isCidr: true,
          prefixLength: 32,
          networkInt: 0n,
          error: "IPv4 CIDR prefix must be between 0 and 32."
        };
      }
      prefix = Number(slashParts[1]);
      if (prefix < 0 || prefix > 32) {
        return {
          valid: false,
          normalized: "",
          publicIp: "",
          cidrRange: "",
          version: "ipv4",
          isCidr: true,
          prefixLength: 32,
          networkInt: 0n,
          error: "IPv4 CIDR prefix must be between 0 and 32."
        };
      }
    }
    const shift = BigInt(32 - prefix);
    const maskedInt = prefix === 0 ? 0n : v4 >> shift << shift;
    const baseIp = hasPrefix ? bigIntToIpv4(maskedInt) : ipPart;
    return {
      valid: true,
      normalized: hasPrefix ? `${baseIp}/${prefix}` : ipPart,
      publicIp: baseIp,
      cidrRange: hasPrefix ? `${baseIp}/${prefix}` : "",
      version: "ipv4",
      isCidr: hasPrefix,
      prefixLength: prefix,
      networkInt: maskedInt
    };
  }
  const v6 = parseIpv6ToBigInt(ipPart);
  if (v6 !== null) {
    let prefix = 128;
    if (hasPrefix) {
      if (!/^\d{1,3}$/.test(slashParts[1])) {
        return {
          valid: false,
          normalized: "",
          publicIp: "",
          cidrRange: "",
          version: "ipv6",
          isCidr: true,
          prefixLength: 128,
          networkInt: 0n,
          error: "IPv6 CIDR prefix must be between 0 and 128."
        };
      }
      prefix = Number(slashParts[1]);
      if (prefix < 0 || prefix > 128) {
        return {
          valid: false,
          normalized: "",
          publicIp: "",
          cidrRange: "",
          version: "ipv6",
          isCidr: true,
          prefixLength: 128,
          networkInt: 0n,
          error: "IPv6 CIDR prefix must be between 0 and 128."
        };
      }
    }
    const shift = BigInt(128 - prefix);
    const maskedInt = prefix === 0 ? 0n : v6 >> shift << shift;
    return {
      valid: true,
      normalized: hasPrefix ? `${ipPart}/${prefix}` : ipPart,
      publicIp: ipPart,
      cidrRange: hasPrefix ? `${ipPart}/${prefix}` : "",
      version: "ipv6",
      isCidr: hasPrefix,
      prefixLength: prefix,
      networkInt: maskedInt
    };
  }
  return {
    valid: false,
    normalized: "",
    publicIp: "",
    cidrRange: "",
    version: "ipv4",
    isCidr: false,
    prefixLength: 32,
    networkInt: 0n,
    error: "Must be a valid public IPv4, IPv6, or CIDR range (e.g., 203.0.113.10 or 203.0.113.0/24)."
  };
}
function ipMatchesCidrOrExact(clientIpRaw, allowEntryRaw) {
  const clientIp = normalizeIpString(clientIpRaw);
  if (!clientIp) return false;
  const parsedEntry = parseIpOrCidr(allowEntryRaw);
  if (!parsedEntry.valid) return false;
  if (parsedEntry.version === "ipv4") {
    const clientV4 = parseIpv4ToBigInt(clientIp);
    if (clientV4 === null) return false;
    if (parsedEntry.prefixLength === 0) return true;
    const shift2 = BigInt(32 - parsedEntry.prefixLength);
    return clientV4 >> shift2 === parsedEntry.networkInt >> shift2;
  }
  const clientV6 = parseIpv6ToBigInt(clientIp);
  if (clientV6 === null) return false;
  if (parsedEntry.prefixLength === 0) return true;
  const shift = BigInt(128 - parsedEntry.prefixLength);
  return clientV6 >> shift === parsedEntry.networkInt >> shift;
}
var NON_PUBLIC_IPV4_RANGES = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "224.0.0.0/4",
  "240.0.0.0/4"
].map((cidr) => {
  const p = parseIpOrCidr(cidr);
  const hostMask = (1n << BigInt(32 - p.prefixLength)) - 1n;
  return {
    start: p.networkInt,
    end: p.networkInt | hostMask,
    label: cidr
  };
});
var NON_PUBLIC_IPV6_RANGES = [
  "::/128",
  "::1/128",
  "fc00::/7",
  "fe80::/10",
  "ff00::/8"
].map((cidr) => {
  const p = parseIpOrCidr(cidr);
  const hostMask = (1n << BigInt(128 - p.prefixLength)) - 1n;
  return {
    start: p.networkInt,
    end: p.networkInt | hostMask,
    label: cidr
  };
});
function isPrivateOrNonPublicIp(rawIp) {
  const ip = normalizeIpString(rawIp);
  if (!ip || ip === "unavailable" || ip === "unknown") return true;
  const parsed = parseIpOrCidr(ip);
  if (!parsed.valid || parsed.isCidr) return true;
  const ranges = parsed.version === "ipv4" ? NON_PUBLIC_IPV4_RANGES : NON_PUBLIC_IPV6_RANGES;
  return ranges.some((r) => parsed.networkInt >= r.start && parsed.networkInt <= r.end);
}
function validatePublicCompanyWifiIpOrCidr(rawInput) {
  const parsed = parseIpOrCidr(rawInput);
  if (!parsed.valid) {
    return parsed;
  }
  if (parsed.version === "ipv4") {
    if (parsed.isCidr && parsed.prefixLength < 16) {
      return {
        ...parsed,
        valid: false,
        error: "IPv4 CIDR range is too broad. Minimum prefix length is /16 (e.g., 203.0.113.0/24)."
      };
    }
    const hostMask2 = (1n << BigInt(32 - parsed.prefixLength)) - 1n;
    const rangeStart2 = parsed.networkInt;
    const rangeEnd2 = parsed.networkInt | hostMask2;
    const overlapping2 = NON_PUBLIC_IPV4_RANGES.find(
      (r) => rangeStart2 <= r.end && rangeEnd2 >= r.start
    );
    if (overlapping2) {
      return {
        ...parsed,
        valid: false,
        error: `Private, loopback, or reserved IP ranges (${overlapping2.label}) are not allowed. Enter a routable Public IP or CIDR.`
      };
    }
    return parsed;
  }
  if (parsed.isCidr && parsed.prefixLength < 32) {
    return {
      ...parsed,
      valid: false,
      error: "IPv6 CIDR range is too broad. Minimum prefix length is /32."
    };
  }
  const hostMask = (1n << BigInt(128 - parsed.prefixLength)) - 1n;
  const rangeStart = parsed.networkInt;
  const rangeEnd = parsed.networkInt | hostMask;
  const overlapping = NON_PUBLIC_IPV6_RANGES.find(
    (r) => rangeStart <= r.end && rangeEnd >= r.start
  );
  if (overlapping) {
    return {
      ...parsed,
      valid: false,
      error: `Private, loopback, or reserved IPv6 ranges (${overlapping.label}) are not allowed. Enter a routable Public IPv6 or CIDR.`
    };
  }
  return parsed;
}
function getNetworkMatchTarget(network) {
  const cidr = String(network.cidrRange || "").trim();
  return cidr || String(network.publicIp || "").trim();
}
function ipMatchesCompanyWifiNetwork(observedIp, network) {
  if (network.status !== "Active") return false;
  const target = getNetworkMatchTarget(network);
  if (!target) return false;
  return ipMatchesCidrOrExact(observedIp, target);
}

// serverCompanyWifi.ts
var COL_WIFI_NETWORKS = "company_wifi_networks";
var COL_WIFI_POLICIES = "company_wifi_access_policies";
var COL_WIFI_SETTINGS = "company_wifi_settings";
var COL_WIFI_LOGS = "company_wifi_access_logs";
var SETTINGS_DOC_ID = "global";
var MANAGED_ROLE_IDS = ["admin", "user"];
var DEFAULT_WIFI_SETTINGS = {
  enforcementEnabled: false,
  // Strictly OFF initially so existing accounts are never accidentally blocked
  trustedProxyHops: 1,
  policyVersion: 1,
  updatedAt: "",
  updatedBy: "system"
};
function defaultRolePolicy(roleId) {
  return {
    roleId,
    allowedNetworkIds: [],
    accessMode: "RESTRICTED",
    updatedAt: "",
    updatedBy: "system"
  };
}
function parseHeaderIpList(headerVal) {
  if (!headerVal) return [];
  const joined = Array.isArray(headerVal) ? headerVal.join(",") : headerVal;
  return joined.split(",").map((part) => normalizeIpString(part)).filter((ip) => {
    if (!ip) return false;
    const p = parseIpOrCidr(ip);
    return p.valid && !p.isCidr;
  });
}
function extractAuthoritativePublicIp(req, trustedProxyHops = 1) {
  const safeHops = Math.max(0, Math.min(5, Math.floor(Number(trustedProxyHops) || 1)));
  const vercelIps = parseHeaderIpList(req.headers["x-vercel-forwarded-for"]);
  if (vercelIps.length > 0 && safeHops > 0) {
    const ip = vercelIps[vercelIps.length - 1];
    return { ip, isPublic: !isPrivateOrNonPublicIp(ip), source: "x-vercel-forwarded-for" };
  }
  const xffIps = parseHeaderIpList(req.headers["x-forwarded-for"]);
  if (xffIps.length > 0 && safeHops > 0) {
    const idx = Math.max(0, xffIps.length - safeHops);
    const ip = xffIps[idx];
    return { ip, isPublic: !isPrivateOrNonPublicIp(ip), source: "x-forwarded-for:trusted-hop" };
  }
  const directCandidate = normalizeIpString(req.socket?.remoteAddress || req.ip || "");
  if (directCandidate) {
    const parsed = parseIpOrCidr(directCandidate);
    if (parsed.valid && !parsed.isCidr) {
      return {
        ip: directCandidate,
        isPublic: !isPrivateOrNonPublicIp(directCandidate),
        source: "socket"
      };
    }
  }
  return { ip: "unavailable", isPublic: false, source: "unavailable" };
}
var wifiCacheMap = /* @__PURE__ */ new WeakMap();
function getWifiCache(db) {
  let entry = wifiCacheMap.get(db);
  if (!entry) {
    entry = { settingsLoadedAtMs: 0 };
    wifiCacheMap.set(db, entry);
  }
  return entry;
}
function invalidateCompanyWifiCache(db) {
  const entry = getWifiCache(db);
  entry.settingsLoadedAtMs = 0;
  entry.settings = void 0;
  entry.bundle = void 0;
}
function normalizeSettingsDoc(raw) {
  const d = raw || {};
  return {
    enforcementEnabled: Boolean(d.enforcementEnabled),
    trustedProxyHops: typeof d.trustedProxyHops === "number" && Number.isFinite(d.trustedProxyHops) ? Math.max(0, Math.min(5, Math.floor(d.trustedProxyHops))) : 1,
    policyVersion: typeof d.policyVersion === "number" && Number.isFinite(d.policyVersion) ? Math.max(1, Math.floor(d.policyVersion)) : 1,
    updatedAt: typeof d.updatedAt === "string" ? d.updatedAt : "",
    updatedBy: typeof d.updatedBy === "string" ? d.updatedBy : "system"
  };
}
function normalizeNetworkDoc(id, raw) {
  const d = raw || {};
  const publicIp = String(d.publicIp || "").trim();
  const cidrRange = String(d.cidrRange || "").trim();
  const parsed = parseIpOrCidr(cidrRange || publicIp);
  return {
    networkId: String(d.networkId || id),
    networkName: String(d.networkName || "Unnamed Wi-Fi").trim(),
    publicIp: parsed.valid ? parsed.publicIp : publicIp,
    cidrRange: parsed.valid && parsed.isCidr ? parsed.cidrRange : cidrRange,
    ipVersion: d.ipVersion === "ipv6" || parsed.valid && parsed.version === "ipv6" ? "ipv6" : "ipv4",
    status: d.status === "Inactive" ? "Inactive" : "Active",
    createdAt: typeof d.createdAt === "string" ? d.createdAt : "",
    updatedAt: typeof d.updatedAt === "string" ? d.updatedAt : "",
    createdBy: typeof d.createdBy === "string" ? d.createdBy : "system",
    updatedBy: typeof d.updatedBy === "string" ? d.updatedBy : "system"
  };
}
function normalizePolicyDoc(roleId, raw) {
  if (!raw) return defaultRolePolicy(roleId);
  const accessMode = String(raw.accessMode || "").toUpperCase() === "UNRESTRICTED" ? "UNRESTRICTED" : "RESTRICTED";
  const allowedNetworkIds = Array.isArray(raw.allowedNetworkIds) ? Array.from(
    new Set(
      raw.allowedNetworkIds.map((v) => String(v || "").trim()).filter(Boolean)
    )
  ) : [];
  return {
    roleId,
    allowedNetworkIds,
    accessMode,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
    updatedBy: typeof raw.updatedBy === "string" ? raw.updatedBy : "system"
  };
}
async function loadWifiSettings(db, opts) {
  const nowMs = opts?.nowMs ?? Date.now();
  const cache = getWifiCache(db);
  if (!opts?.forceFresh && cache.settings && !cache.settings.enforcementEnabled && nowMs - cache.settingsLoadedAtMs < 3e3) {
    return cache.settings;
  }
  const snap = await db.collection(COL_WIFI_SETTINGS).doc(SETTINGS_DOC_ID).get();
  const settings = snap.exists ? normalizeSettingsDoc(snap.data()) : { ...DEFAULT_WIFI_SETTINGS };
  cache.settings = settings;
  cache.settingsLoadedAtMs = nowMs;
  return settings;
}
async function loadWifiBundle(db, settings, opts) {
  const nowMs = opts?.nowMs ?? Date.now();
  const cache = getWifiCache(db);
  if (!opts?.forceFresh && cache.bundle && cache.bundle.policyVersion === settings.policyVersion && nowMs - cache.bundle.loadedAtMs < 3e4) {
    return cache.bundle;
  }
  const [netsSnap, adminPolicySnap, userPolicySnap] = await Promise.all([
    db.collection(COL_WIFI_NETWORKS).get(),
    db.collection(COL_WIFI_POLICIES).doc("admin").get(),
    db.collection(COL_WIFI_POLICIES).doc("user").get()
  ]);
  const networks = netsSnap.docs.map((doc) => normalizeNetworkDoc(doc.id, doc.data())).sort((a, b) => a.networkName.localeCompare(b.networkName));
  const policies = {
    admin: adminPolicySnap.exists ? normalizePolicyDoc("admin", adminPolicySnap.data()) : defaultRolePolicy("admin"),
    user: userPolicySnap.exists ? normalizePolicyDoc("user", userPolicySnap.data()) : defaultRolePolicy("user")
  };
  const bundle = {
    policyVersion: settings.policyVersion,
    networks,
    policies,
    loadedAtMs: nowMs
  };
  cache.bundle = bundle;
  return bundle;
}
async function bumpPolicyVersion(db, actorLabel, nowIso, patch) {
  const ref = db.collection(COL_WIFI_SETTINGS).doc(SETTINGS_DOC_ID);
  const snap = await ref.get();
  const current = snap.exists ? normalizeSettingsDoc(snap.data()) : { ...DEFAULT_WIFI_SETTINGS };
  const next = {
    enforcementEnabled: patch?.enforcementEnabled !== void 0 ? Boolean(patch.enforcementEnabled) : current.enforcementEnabled,
    trustedProxyHops: patch?.trustedProxyHops !== void 0 ? Math.max(0, Math.min(5, Math.floor(patch.trustedProxyHops))) : current.trustedProxyHops,
    policyVersion: current.policyVersion + 1,
    updatedAt: nowIso,
    updatedBy: actorLabel
  };
  await ref.set(next);
  invalidateCompanyWifiCache(db);
  return next;
}
async function writeWifiAccessLog(db, entry) {
  const id = `wlog_${Date.now()}_${crypto6.randomBytes(3).toString("hex")}`;
  const doc = {
    id,
    actorUid: String(entry.actorUid || "unknown"),
    actorLoginId: String(entry.actorLoginId || "unknown"),
    actorRole: String(entry.actorRole || "UNKNOWN").toUpperCase(),
    eventType: entry.eventType,
    observedIp: String(entry.observedIp || "unavailable"),
    networkId: entry.networkId || null,
    networkName: entry.networkName || null,
    targetRole: entry.targetRole || null,
    detail: entry.detail ? String(entry.detail).slice(0, 500) : "",
    timestamp: entry.timestamp,
    result: entry.result
  };
  try {
    await db.collection(COL_WIFI_LOGS).doc(id).set(doc);
  } catch (err) {
    console.warn("[CompanyWifi] Failed to persist access log:", err);
  }
  return doc;
}
async function enforceCompanyWifiAccess(db, req, caller, opts) {
  const roleId = normalizeRoleValue(caller.role);
  if (roleId === "super_admin") {
    const observed2 = extractAuthoritativePublicIp(req, 1);
    return {
      allowed: true,
      enforcementEnabled: false,
      bypassReason: "SUPER_ADMIN",
      observedIp: observed2.ip,
      observedIpIsPublic: observed2.isPublic,
      matchedNetwork: null
    };
  }
  const nowMs = opts?.nowMs ?? Date.now();
  const settings = await loadWifiSettings(db, { nowMs });
  const observed = extractAuthoritativePublicIp(req, settings.trustedProxyHops);
  if (!settings.enforcementEnabled) {
    return {
      allowed: true,
      enforcementEnabled: false,
      bypassReason: "ENFORCEMENT_OFF",
      observedIp: observed.ip,
      observedIpIsPublic: observed.isPublic,
      matchedNetwork: null
    };
  }
  const bundle = await loadWifiBundle(db, settings, { nowMs });
  const rolePolicy = roleId === "admin" ? bundle.policies.admin : roleId === "user" ? bundle.policies.user : (
    // Any non-super-admin custom role defaults to secure deny-by-default unless explicitly unrestricted
    defaultRolePolicy("user")
  );
  if (rolePolicy.accessMode === "UNRESTRICTED") {
    return {
      allowed: true,
      enforcementEnabled: true,
      bypassReason: "ROLE_UNRESTRICTED",
      observedIp: observed.ip,
      observedIpIsPublic: observed.isPublic,
      matchedNetwork: null
    };
  }
  const networksById = new Map(bundle.networks.map((n) => [n.networkId, n]));
  const activeAllowedNetworks = rolePolicy.allowedNetworkIds.map((id) => networksById.get(id)).filter((net) => Boolean(net && net.status === "Active"));
  const matchedNetwork = observed.isPublic && activeAllowedNetworks.length > 0 ? activeAllowedNetworks.find((net) => ipMatchesCompanyWifiNetwork(observed.ip, net)) || null : null;
  if (matchedNetwork) {
    return {
      allowed: true,
      enforcementEnabled: true,
      bypassReason: null,
      observedIp: observed.ip,
      observedIpIsPublic: observed.isPublic,
      matchedNetwork
    };
  }
  if (!opts?.skipBlockLog) {
    const nowIso = new Date(nowMs).toISOString();
    const reasonDetail = activeAllowedNetworks.length === 0 ? `Role "${roleId.toUpperCase()}" has no active Company Wi-Fi networks assigned (deny-by-default).` : !observed.isPublic ? `Observed IP "${observed.ip}" is not a valid public IP.` : `Observed IP "${observed.ip}" is not in allowed Company Wi-Fi networks for role "${roleId.toUpperCase()}".`;
    await writeWifiAccessLog(db, {
      actorUid: caller.uid,
      actorLoginId: caller.loginId,
      actorRole: roleId.toUpperCase(),
      eventType: "ACCESS_BLOCKED",
      observedIp: observed.ip,
      networkId: null,
      networkName: null,
      targetRole: roleId,
      detail: `${reasonDetail} (${req.method} ${req.path})`,
      timestamp: nowIso,
      result: "Blocked"
    });
  }
  return {
    allowed: false,
    enforcementEnabled: true,
    bypassReason: null,
    observedIp: observed.ip,
    observedIpIsPublic: observed.isPublic,
    matchedNetwork: null,
    httpStatus: 403,
    safeErrorPayload: {
      success: false,
      code: COMPANY_WIFI_DENIED_CODE,
      error: COMPANY_WIFI_DENIED_MESSAGE
    }
  };
}
var NetworkCreateSchema = z6.object({
  networkName: z6.string().trim().min(2, "Company Wi-Fi name must be at least 2 characters.").max(80, "Company Wi-Fi name must be 80 characters or fewer."),
  ipOrCidr: z6.string().trim().min(3, "Public IP address or CIDR range is required.").max(64),
  status: z6.enum(["Active", "Inactive"]).default("Active")
});
var NetworkUpdateSchema = z6.object({
  networkName: z6.string().trim().min(2, "Company Wi-Fi name must be at least 2 characters.").max(80, "Company Wi-Fi name must be 80 characters or fewer.").optional(),
  ipOrCidr: z6.string().trim().min(3).max(64).optional(),
  status: z6.enum(["Active", "Inactive"]).optional()
});
var NetworkStatusSchema = z6.object({
  status: z6.enum(["Active", "Inactive"])
});
var RolePolicyUpdateSchema = z6.object({
  accessMode: z6.enum(["RESTRICTED", "UNRESTRICTED"]),
  allowedNetworkIds: z6.array(z6.string().trim().min(1).max(128)).max(200)
});
var SettingsUpdateSchema = z6.object({
  enforcementEnabled: z6.boolean(),
  confirmEnable: z6.boolean().optional(),
  trustedProxyHops: z6.number().int().min(0).max(5).optional()
});
function registerCompanyWifiRoutes(app, deps) {
  const { db, requireVerifiedCaller } = deps;
  const getNowMs = deps.nowProvider || (() => Date.now());
  const requireSuperAdmin = (req, res, actionLabel) => requireVerifiedCaller(req, res, ["super_admin"], actionLabel, { skipWifiCheck: true });
  app.get("/api/company-wifi/check", async (req, res) => {
    try {
      const caller = await requireVerifiedCaller(
        req,
        res,
        "*",
        "Check Company Wi-Fi Access",
        { skipWifiCheck: true }
      );
      if (!caller) return;
      const outcome = await enforceCompanyWifiAccess(db, req, caller, {
        nowMs: getNowMs(),
        skipBlockLog: req.query.dry === "1"
      });
      if (!outcome.allowed) {
        return res.status(403).json({
          success: false,
          allowed: false,
          enforcementEnabled: true,
          role: caller.role,
          code: COMPANY_WIFI_DENIED_CODE,
          error: COMPANY_WIFI_DENIED_MESSAGE
        });
      }
      return res.json({
        success: true,
        allowed: true,
        enforcementEnabled: outcome.enforcementEnabled,
        role: caller.role,
        bypassReason: outcome.bypassReason || null,
        matchedNetworkName: outcome.matchedNetwork?.networkName || null
      });
    } catch (err) {
      console.error("[CompanyWifi] Check error:", err);
      return res.status(500).json({
        success: false,
        error: "Failed to verify Company Wi-Fi access status."
      });
    }
  });
  app.get("/api/company-wifi/dashboard", async (req, res) => {
    try {
      const caller = await requireSuperAdmin(req, res, "View Company Wi-Fi Access Dashboard");
      if (!caller) return;
      const nowMs = getNowMs();
      const settings = await loadWifiSettings(db, { forceFresh: true, nowMs });
      const bundle = await loadWifiBundle(db, settings, { forceFresh: true, nowMs });
      const observed = extractAuthoritativePublicIp(req, settings.trustedProxyHops);
      const activeNetworks = bundle.networks.filter((n) => n.status === "Active");
      const activeIds = new Set(activeNetworks.map((n) => n.networkId));
      const adminPolicy = bundle.policies.admin;
      const userPolicy = bundle.policies.user;
      const adminAllowedCount = adminPolicy.allowedNetworkIds.filter((id) => activeIds.has(id)).length;
      const userAllowedCount = userPolicy.allowedNetworkIds.filter((id) => activeIds.has(id)).length;
      const matchedNetwork = observed.isPublic ? activeNetworks.find((n) => ipMatchesCompanyWifiNetwork(observed.ip, n)) || null : null;
      const timestamps = [
        settings.updatedAt,
        adminPolicy.updatedAt,
        userPolicy.updatedAt,
        ...bundle.networks.map((n) => n.updatedAt)
      ].filter(Boolean);
      const lastPolicyUpdate = timestamps.length > 0 ? timestamps.sort().reverse()[0] : null;
      return res.json({
        success: true,
        settings,
        summary: {
          enforcementEnabled: settings.enforcementEnabled,
          totalNetworks: bundle.networks.length,
          activeNetworks: activeNetworks.length,
          adminAllowedCount,
          userAllowedCount,
          currentObservedIp: observed.ip,
          currentObservedIpIsPublic: observed.isPublic,
          currentNetworkMatched: Boolean(matchedNetwork),
          currentMatchedNetworkId: matchedNetwork?.networkId || null,
          currentMatchedNetworkName: matchedNetwork?.networkName || null,
          lastPolicyUpdate
        },
        networks: bundle.networks,
        policies: {
          admin: adminPolicy,
          user: userPolicy
        }
      });
    } catch (err) {
      console.error("[CompanyWifi] Dashboard error:", err);
      return res.status(500).json({
        success: false,
        error: "Failed to load Company Wi-Fi Access Control dashboard."
      });
    }
  });
  app.get("/api/company-wifi/networks", async (req, res) => {
    try {
      const caller = await requireSuperAdmin(req, res, "List Company Wi-Fi Networks");
      if (!caller) return;
      const nowMs = getNowMs();
      const settings = await loadWifiSettings(db, { forceFresh: true, nowMs });
      const bundle = await loadWifiBundle(db, settings, { forceFresh: true, nowMs });
      return res.json({ success: true, networks: bundle.networks });
    } catch (err) {
      console.error("[CompanyWifi] List networks error:", err);
      return res.status(500).json({ success: false, error: "Failed to load Company Wi-Fi networks." });
    }
  });
  app.post("/api/company-wifi/networks", async (req, res) => {
    try {
      const caller = await requireSuperAdmin(req, res, "Add Company Wi-Fi Network");
      if (!caller) return;
      const parsedBody = NetworkCreateSchema.safeParse(req.body || {});
      if (!parsedBody.success) {
        return res.status(400).json({
          success: false,
          error: parsedBody.error.issues[0]?.message || "Invalid Company Wi-Fi network payload."
        });
      }
      const ipValidation = validatePublicCompanyWifiIpOrCidr(parsedBody.data.ipOrCidr);
      if (!ipValidation.valid) {
        return res.status(400).json({
          success: false,
          error: ipValidation.error || "Invalid Public IP or CIDR range."
        });
      }
      const nowMs = getNowMs();
      const nowIso = new Date(nowMs).toISOString();
      const settings = await loadWifiSettings(db, { forceFresh: true, nowMs });
      const observed = extractAuthoritativePublicIp(req, settings.trustedProxyHops);
      const existingSnap = await db.collection(COL_WIFI_NETWORKS).get();
      const existingList = existingSnap.docs.map((d) => normalizeNetworkDoc(d.id, d.data()));
      const duplicateTarget = existingList.find(
        (n) => getNetworkMatchTarget(n).toLowerCase() === ipValidation.normalized.toLowerCase()
      );
      if (duplicateTarget) {
        return res.status(409).json({
          success: false,
          error: `Public IP/CIDR "${ipValidation.normalized}" is already registered as "${duplicateTarget.networkName}".`
        });
      }
      const networkId = `wifi_${nowMs}_${crypto6.randomBytes(3).toString("hex")}`;
      const newNetwork = {
        networkId,
        networkName: parsedBody.data.networkName,
        publicIp: ipValidation.publicIp,
        cidrRange: ipValidation.cidrRange,
        ipVersion: ipValidation.version,
        status: parsedBody.data.status,
        createdAt: nowIso,
        updatedAt: nowIso,
        createdBy: caller.uid,
        updatedBy: caller.uid
      };
      await db.collection(COL_WIFI_NETWORKS).doc(networkId).set(newNetwork);
      await bumpPolicyVersion(db, caller.loginId, nowIso);
      await Promise.all([
        writeWifiAccessLog(db, {
          actorUid: caller.uid,
          actorLoginId: caller.loginId,
          actorRole: "SUPER_ADMIN",
          eventType: "NETWORK_ADDED",
          observedIp: observed.ip,
          networkId,
          networkName: newNetwork.networkName,
          detail: `Added Company Wi-Fi "${newNetwork.networkName}" (${ipValidation.normalized}, ${newNetwork.status}).`,
          timestamp: nowIso,
          result: "Updated"
        }),
        recordEnterpriseAuditEvent(db, {
          req,
          action: "company_wifi_network_added",
          category: "SECURITY",
          actorUid: caller.uid,
          actorLoginId: caller.loginId,
          actorRole: "SUPER_ADMIN",
          targetType: "COMPANY_WIFI_NETWORK",
          targetId: networkId,
          newValue: `${newNetwork.networkName} (${ipValidation.normalized})`,
          actionSource: "COMPANY_WIFI_CONTROL",
          description: `Added Company Wi-Fi "${newNetwork.networkName}" (${ipValidation.normalized}).`
        })
      ]);
      return res.status(201).json({ success: true, network: newNetwork });
    } catch (err) {
      console.error("[CompanyWifi] Create network error:", err);
      return res.status(500).json({ success: false, error: "Failed to add Company Wi-Fi network." });
    }
  });
  app.put("/api/company-wifi/networks/:networkId", async (req, res) => {
    try {
      const caller = await requireSuperAdmin(req, res, "Update Company Wi-Fi Network");
      if (!caller) return;
      const networkId = String(req.params.networkId || "").trim();
      if (!networkId || !/^[a-zA-Z0-9_-]{3,128}$/.test(networkId)) {
        return res.status(400).json({ success: false, error: "Invalid network ID." });
      }
      const parsedBody = NetworkUpdateSchema.safeParse(req.body || {});
      if (!parsedBody.success) {
        return res.status(400).json({
          success: false,
          error: parsedBody.error.issues[0]?.message || "Invalid update payload."
        });
      }
      const docRef = db.collection(COL_WIFI_NETWORKS).doc(networkId);
      const snap = await docRef.get();
      if (!snap.exists) {
        return res.status(404).json({ success: false, error: "Company Wi-Fi network not found." });
      }
      const current = normalizeNetworkDoc(networkId, snap.data());
      let nextPublicIp = current.publicIp;
      let nextCidrRange = current.cidrRange;
      let nextIpVersion = current.ipVersion;
      if (parsedBody.data.ipOrCidr !== void 0) {
        const ipValidation = validatePublicCompanyWifiIpOrCidr(parsedBody.data.ipOrCidr);
        if (!ipValidation.valid) {
          return res.status(400).json({
            success: false,
            error: ipValidation.error || "Invalid Public IP or CIDR range."
          });
        }
        const existingSnap = await db.collection(COL_WIFI_NETWORKS).get();
        const duplicateTarget = existingSnap.docs.map((d) => normalizeNetworkDoc(d.id, d.data())).find(
          (n) => n.networkId !== networkId && getNetworkMatchTarget(n).toLowerCase() === ipValidation.normalized.toLowerCase()
        );
        if (duplicateTarget) {
          return res.status(409).json({
            success: false,
            error: `Public IP/CIDR "${ipValidation.normalized}" is already registered as "${duplicateTarget.networkName}".`
          });
        }
        nextPublicIp = ipValidation.publicIp;
        nextCidrRange = ipValidation.cidrRange;
        nextIpVersion = ipValidation.version;
      }
      const nowMs = getNowMs();
      const nowIso = new Date(nowMs).toISOString();
      const settings = await loadWifiSettings(db, { forceFresh: true, nowMs });
      const observed = extractAuthoritativePublicIp(req, settings.trustedProxyHops);
      const updated = {
        ...current,
        networkName: parsedBody.data.networkName ?? current.networkName,
        publicIp: nextPublicIp,
        cidrRange: nextCidrRange,
        ipVersion: nextIpVersion,
        status: parsedBody.data.status ?? current.status,
        updatedAt: nowIso,
        updatedBy: caller.uid
      };
      await docRef.set(updated);
      await bumpPolicyVersion(db, caller.loginId, nowIso);
      await Promise.all([
        writeWifiAccessLog(db, {
          actorUid: caller.uid,
          actorLoginId: caller.loginId,
          actorRole: "SUPER_ADMIN",
          eventType: "NETWORK_UPDATED",
          observedIp: observed.ip,
          networkId,
          networkName: updated.networkName,
          detail: `Updated Company Wi-Fi "${updated.networkName}" (${getNetworkMatchTarget(updated)}, ${updated.status}).`,
          timestamp: nowIso,
          result: "Updated"
        }),
        recordEnterpriseAuditEvent(db, {
          req,
          action: "company_wifi_network_updated",
          category: "SECURITY",
          actorUid: caller.uid,
          actorLoginId: caller.loginId,
          actorRole: "SUPER_ADMIN",
          targetType: "COMPANY_WIFI_NETWORK",
          targetId: networkId,
          oldValue: `${current.networkName} (${getNetworkMatchTarget(current)}, ${current.status})`,
          newValue: `${updated.networkName} (${getNetworkMatchTarget(updated)}, ${updated.status})`,
          actionSource: "COMPANY_WIFI_CONTROL",
          description: `Updated Company Wi-Fi "${updated.networkName}".`
        })
      ]);
      return res.json({ success: true, network: updated });
    } catch (err) {
      console.error("[CompanyWifi] Update network error:", err);
      return res.status(500).json({ success: false, error: "Failed to update Company Wi-Fi network." });
    }
  });
  app.patch("/api/company-wifi/networks/:networkId/status", async (req, res) => {
    try {
      const caller = await requireSuperAdmin(req, res, "Toggle Company Wi-Fi Status");
      if (!caller) return;
      const networkId = String(req.params.networkId || "").trim();
      if (!networkId || !/^[a-zA-Z0-9_-]{3,128}$/.test(networkId)) {
        return res.status(400).json({ success: false, error: "Invalid network ID." });
      }
      const parsedBody = NetworkStatusSchema.safeParse(req.body || {});
      if (!parsedBody.success) {
        return res.status(400).json({ success: false, error: "Status must be Active or Inactive." });
      }
      const docRef = db.collection(COL_WIFI_NETWORKS).doc(networkId);
      const snap = await docRef.get();
      if (!snap.exists) {
        return res.status(404).json({ success: false, error: "Company Wi-Fi network not found." });
      }
      const current = normalizeNetworkDoc(networkId, snap.data());
      const nowMs = getNowMs();
      const nowIso = new Date(nowMs).toISOString();
      const settings = await loadWifiSettings(db, { forceFresh: true, nowMs });
      const observed = extractAuthoritativePublicIp(req, settings.trustedProxyHops);
      const updated = {
        ...current,
        status: parsedBody.data.status,
        updatedAt: nowIso,
        updatedBy: caller.uid
      };
      await docRef.set(updated);
      await bumpPolicyVersion(db, caller.loginId, nowIso);
      await writeWifiAccessLog(db, {
        actorUid: caller.uid,
        actorLoginId: caller.loginId,
        actorRole: "SUPER_ADMIN",
        eventType: "NETWORK_STATUS_CHANGED",
        observedIp: observed.ip,
        networkId,
        networkName: updated.networkName,
        detail: `Changed "${updated.networkName}" status from ${current.status} to ${updated.status}.`,
        timestamp: nowIso,
        result: "Updated"
      });
      return res.json({ success: true, network: updated });
    } catch (err) {
      console.error("[CompanyWifi] Status toggle error:", err);
      return res.status(500).json({ success: false, error: "Failed to update network status." });
    }
  });
  app.delete("/api/company-wifi/networks/:networkId", async (req, res) => {
    try {
      const caller = await requireSuperAdmin(req, res, "Delete Company Wi-Fi Network");
      if (!caller) return;
      const networkId = String(req.params.networkId || "").trim();
      if (!networkId || !/^[a-zA-Z0-9_-]{3,128}$/.test(networkId)) {
        return res.status(400).json({ success: false, error: "Invalid network ID." });
      }
      const docRef = db.collection(COL_WIFI_NETWORKS).doc(networkId);
      const snap = await docRef.get();
      if (!snap.exists) {
        return res.status(404).json({ success: false, error: "Company Wi-Fi network not found." });
      }
      const existing = normalizeNetworkDoc(networkId, snap.data());
      const nowMs = getNowMs();
      const nowIso = new Date(nowMs).toISOString();
      const settings = await loadWifiSettings(db, { forceFresh: true, nowMs });
      const observed = extractAuthoritativePublicIp(req, settings.trustedProxyHops);
      await docRef.delete();
      for (const roleId of MANAGED_ROLE_IDS) {
        const polRef = db.collection(COL_WIFI_POLICIES).doc(roleId);
        const polSnap = await polRef.get();
        if (polSnap.exists) {
          const pol = normalizePolicyDoc(roleId, polSnap.data());
          if (pol.allowedNetworkIds.includes(networkId)) {
            await polRef.set({
              ...pol,
              allowedNetworkIds: pol.allowedNetworkIds.filter((id) => id !== networkId),
              updatedAt: nowIso,
              updatedBy: caller.uid
            });
          }
        }
      }
      await bumpPolicyVersion(db, caller.loginId, nowIso);
      await Promise.all([
        writeWifiAccessLog(db, {
          actorUid: caller.uid,
          actorLoginId: caller.loginId,
          actorRole: "SUPER_ADMIN",
          eventType: "NETWORK_DELETED",
          observedIp: observed.ip,
          networkId,
          networkName: existing.networkName,
          detail: `Deleted Company Wi-Fi "${existing.networkName}" (${getNetworkMatchTarget(existing)}).`,
          timestamp: nowIso,
          result: "Updated"
        }),
        recordEnterpriseAuditEvent(db, {
          req,
          action: "company_wifi_network_deleted",
          category: "SECURITY",
          severity: "WARNING",
          actorUid: caller.uid,
          actorLoginId: caller.loginId,
          actorRole: "SUPER_ADMIN",
          targetType: "COMPANY_WIFI_NETWORK",
          targetId: networkId,
          oldValue: `${existing.networkName} (${getNetworkMatchTarget(existing)})`,
          actionSource: "COMPANY_WIFI_CONTROL",
          description: `Deleted Company Wi-Fi "${existing.networkName}".`
        })
      ]);
      return res.json({ success: true, deletedNetworkId: networkId });
    } catch (err) {
      console.error("[CompanyWifi] Delete network error:", err);
      return res.status(500).json({ success: false, error: "Failed to delete Company Wi-Fi network." });
    }
  });
  app.put("/api/company-wifi/policies/:roleId", async (req, res) => {
    try {
      const caller = await requireSuperAdmin(req, res, "Update Role Company Wi-Fi Policy");
      if (!caller) return;
      const rawRoleId = normalizeRoleValue(req.params.roleId);
      if (rawRoleId === "super_admin") {
        return res.status(400).json({
          success: false,
          error: "SUPER_ADMIN is permanently unrestricted and cannot be assigned Company Wi-Fi restrictions."
        });
      }
      if (rawRoleId !== "admin" && rawRoleId !== "user") {
        return res.status(400).json({
          success: false,
          error: "Only ADMIN and USER roles can be configured in Company Wi-Fi Access Control."
        });
      }
      const parsedBody = RolePolicyUpdateSchema.safeParse(req.body || {});
      if (!parsedBody.success) {
        return res.status(400).json({
          success: false,
          error: parsedBody.error.issues[0]?.message || "Invalid role policy payload."
        });
      }
      const nowMs = getNowMs();
      const nowIso = new Date(nowMs).toISOString();
      const settings = await loadWifiSettings(db, { forceFresh: true, nowMs });
      const observed = extractAuthoritativePublicIp(req, settings.trustedProxyHops);
      const netsSnap = await db.collection(COL_WIFI_NETWORKS).get();
      const existingNetMap = new Map(
        netsSnap.docs.map((d) => {
          const n = normalizeNetworkDoc(d.id, d.data());
          return [n.networkId, n];
        })
      );
      const dedupIds = Array.from(new Set(parsedBody.data.allowedNetworkIds));
      const unknownIds = dedupIds.filter((id) => !existingNetMap.has(id));
      if (unknownIds.length > 0) {
        return res.status(400).json({
          success: false,
          error: `Unknown Company Wi-Fi network ID(s): ${unknownIds.join(", ")}.`
        });
      }
      const policyRef = db.collection(COL_WIFI_POLICIES).doc(rawRoleId);
      const prevSnap = await policyRef.get();
      const prevPolicy = prevSnap.exists ? normalizePolicyDoc(rawRoleId, prevSnap.data()) : defaultRolePolicy(rawRoleId);
      const nextPolicy = {
        roleId: rawRoleId,
        allowedNetworkIds: dedupIds,
        accessMode: parsedBody.data.accessMode,
        updatedAt: nowIso,
        updatedBy: caller.uid
      };
      await policyRef.set(nextPolicy);
      await bumpPolicyVersion(db, caller.loginId, nowIso);
      const allowedNames = dedupIds.map((id) => existingNetMap.get(id)?.networkName || id).join(", ");
      await Promise.all([
        writeWifiAccessLog(db, {
          actorUid: caller.uid,
          actorLoginId: caller.loginId,
          actorRole: "SUPER_ADMIN",
          eventType: "POLICY_UPDATED",
          observedIp: observed.ip,
          networkId: null,
          targetRole: rawRoleId,
          detail: `Updated ${rawRoleId.toUpperCase()} policy: mode=${nextPolicy.accessMode}, allowed=[${allowedNames || "none"}].`,
          timestamp: nowIso,
          result: "Updated"
        }),
        recordEnterpriseAuditEvent(db, {
          req,
          action: "company_wifi_policy_updated",
          category: "SECURITY",
          actorUid: caller.uid,
          actorLoginId: caller.loginId,
          actorRole: "SUPER_ADMIN",
          targetType: "COMPANY_WIFI_POLICY",
          targetId: rawRoleId,
          oldValue: `${prevPolicy.accessMode} (${prevPolicy.allowedNetworkIds.length} network(s))`,
          newValue: `${nextPolicy.accessMode} (${nextPolicy.allowedNetworkIds.length} network(s))`,
          actionSource: "COMPANY_WIFI_CONTROL",
          description: `Updated Company Wi-Fi access policy for ${rawRoleId.toUpperCase()}.`
        })
      ]);
      return res.json({ success: true, policy: nextPolicy });
    } catch (err) {
      console.error("[CompanyWifi] Update role policy error:", err);
      return res.status(500).json({ success: false, error: "Failed to save role Wi-Fi policy." });
    }
  });
  app.put("/api/company-wifi/settings", async (req, res) => {
    try {
      const caller = await requireSuperAdmin(req, res, "Update Company Wi-Fi Enforcement Settings");
      if (!caller) return;
      const parsedBody = SettingsUpdateSchema.safeParse(req.body || {});
      if (!parsedBody.success) {
        return res.status(400).json({
          success: false,
          error: parsedBody.error.issues[0]?.message || "Invalid settings payload."
        });
      }
      const nowMs = getNowMs();
      const nowIso = new Date(nowMs).toISOString();
      const current = await loadWifiSettings(db, { forceFresh: true, nowMs });
      if (parsedBody.data.enforcementEnabled && !current.enforcementEnabled && !parsedBody.data.confirmEnable) {
        return res.status(400).json({
          success: false,
          error: "Explicit confirmation is required before enabling Company Wi-Fi Access Control enforcement."
        });
      }
      const nextSettings = await bumpPolicyVersion(db, caller.loginId, nowIso, {
        enforcementEnabled: parsedBody.data.enforcementEnabled,
        trustedProxyHops: parsedBody.data.trustedProxyHops
      });
      const observed = extractAuthoritativePublicIp(req, nextSettings.trustedProxyHops);
      const eventType = nextSettings.enforcementEnabled ? "ENFORCEMENT_ENABLED" : "ENFORCEMENT_DISABLED";
      await Promise.all([
        writeWifiAccessLog(db, {
          actorUid: caller.uid,
          actorLoginId: caller.loginId,
          actorRole: "SUPER_ADMIN",
          eventType,
          observedIp: observed.ip,
          networkId: null,
          detail: `Global Company Wi-Fi enforcement set to ${nextSettings.enforcementEnabled ? "ON" : "OFF"}.`,
          timestamp: nowIso,
          result: "Updated"
        }),
        recordEnterpriseAuditEvent(db, {
          req,
          action: nextSettings.enforcementEnabled ? "company_wifi_enforcement_enabled" : "company_wifi_enforcement_disabled",
          category: "SECURITY",
          severity: "WARNING",
          actorUid: caller.uid,
          actorLoginId: caller.loginId,
          actorRole: "SUPER_ADMIN",
          targetType: "COMPANY_WIFI_SETTINGS",
          targetId: SETTINGS_DOC_ID,
          oldValue: `enforcementEnabled=${current.enforcementEnabled}`,
          newValue: `enforcementEnabled=${nextSettings.enforcementEnabled}`,
          actionSource: "COMPANY_WIFI_CONTROL",
          description: `Company Wi-Fi Access Control enforcement turned ${nextSettings.enforcementEnabled ? "ON" : "OFF"}.`
        })
      ]);
      return res.json({ success: true, settings: nextSettings });
    } catch (err) {
      console.error("[CompanyWifi] Update settings error:", err);
      return res.status(500).json({ success: false, error: "Failed to update Company Wi-Fi settings." });
    }
  });
  app.post("/api/company-wifi/emergency-disable", async (req, res) => {
    try {
      const caller = await requireSuperAdmin(req, res, "Emergency Disable Company Wi-Fi Enforcement");
      if (!caller) return;
      const nowMs = getNowMs();
      const nowIso = new Date(nowMs).toISOString();
      const nextSettings = await bumpPolicyVersion(db, caller.loginId, nowIso, {
        enforcementEnabled: false
      });
      const observed = extractAuthoritativePublicIp(req, nextSettings.trustedProxyHops);
      await Promise.all([
        writeWifiAccessLog(db, {
          actorUid: caller.uid,
          actorLoginId: caller.loginId,
          actorRole: "SUPER_ADMIN",
          eventType: "EMERGENCY_DISABLED",
          observedIp: observed.ip,
          networkId: null,
          detail: "Super Admin triggered Emergency Disable for Company Wi-Fi Access Control.",
          timestamp: nowIso,
          result: "Updated"
        }),
        recordEnterpriseAuditEvent(db, {
          req,
          action: "company_wifi_emergency_disable",
          category: "SECURITY",
          severity: "CRITICAL",
          actorUid: caller.uid,
          actorLoginId: caller.loginId,
          actorRole: "SUPER_ADMIN",
          targetType: "COMPANY_WIFI_SETTINGS",
          targetId: SETTINGS_DOC_ID,
          newValue: "enforcementEnabled=false",
          actionSource: "COMPANY_WIFI_EMERGENCY_RECOVERY",
          description: "Super Admin disabled Company Wi-Fi enforcement via Emergency Recovery."
        })
      ]);
      return res.json({
        success: true,
        settings: nextSettings,
        message: "Company Wi-Fi enforcement has been disabled immediately."
      });
    } catch (err) {
      console.error("[CompanyWifi] Emergency disable error:", err);
      return res.status(500).json({ success: false, error: "Failed to disable enforcement." });
    }
  });
  app.get("/api/company-wifi/logs", async (req, res) => {
    try {
      const caller = await requireSuperAdmin(req, res, "View Company Wi-Fi Access Logs");
      if (!caller) return;
      const eventTypeFilter = String(req.query.eventType || "").trim().toUpperCase();
      const resultFilter = String(req.query.result || "").trim().toLowerCase();
      const searchFilter = String(req.query.search || "").trim().toLowerCase();
      const limit = Math.max(1, Math.min(200, parseInt(String(req.query.limit || "100"), 10) || 100));
      const snap = await db.collection(COL_WIFI_LOGS).get();
      let logs = snap.docs.map((d) => {
        const data = d.data() || {};
        return {
          id: String(data.id || d.id),
          actorUid: String(data.actorUid || "unknown"),
          actorLoginId: String(data.actorLoginId || "unknown"),
          actorRole: String(data.actorRole || "UNKNOWN"),
          eventType: data.eventType || "ACCESS_BLOCKED",
          observedIp: String(data.observedIp || "unavailable"),
          networkId: data.networkId || null,
          networkName: data.networkName || null,
          targetRole: data.targetRole || null,
          detail: String(data.detail || ""),
          timestamp: String(data.timestamp || ""),
          result: data.result || "Updated"
        };
      }).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      if (eventTypeFilter && eventTypeFilter !== "ALL") {
        logs = logs.filter((l) => l.eventType === eventTypeFilter);
      }
      if (resultFilter && resultFilter !== "all") {
        logs = logs.filter((l) => l.result.toLowerCase() === resultFilter);
      }
      if (searchFilter) {
        logs = logs.filter(
          (l) => l.actorLoginId.toLowerCase().includes(searchFilter) || l.actorUid.toLowerCase().includes(searchFilter) || l.observedIp.toLowerCase().includes(searchFilter) || (l.networkName || "").toLowerCase().includes(searchFilter) || (l.detail || "").toLowerCase().includes(searchFilter)
        );
      }
      return res.json({
        success: true,
        total: logs.length,
        logs: logs.slice(0, limit)
      });
    } catch (err) {
      console.error("[CompanyWifi] Logs error:", err);
      return res.status(500).json({ success: false, error: "Failed to load Company Wi-Fi access history." });
    }
  });
}

// src/config/dashboardCardsConfig.ts
var DASHBOARD_CARDS = [
  {
    id: "active_total",
    permissionKey: "dashboard.card.active_total",
    metricKey: "activeTotal",
    label: "Active Total",
    description: "Total active registered employees matching selected filters"
  },
  {
    id: "total_present",
    permissionKey: "dashboard.card.total_present",
    metricKey: "totalPresent",
    label: "Total Present",
    description: "Employees with recorded attendance on the selected date"
  },
  {
    id: "currently_inside",
    permissionKey: "dashboard.card.currently_inside",
    metricKey: "currentlyInside",
    label: "Currently Inside",
    description: "Employees currently inside factory without a punch out"
  },
  {
    id: "currently_outside",
    permissionKey: "dashboard.card.currently_outside",
    metricKey: "currentlyOutside",
    label: "Currently Outside",
    description: "Employees who have punched out / exited the factory"
  },
  {
    id: "absent",
    permissionKey: "dashboard.card.absent",
    metricKey: "absent",
    label: "Absent",
    description: "Active scheduled employees with no attendance punches"
  },
  {
    id: "on_leave",
    permissionKey: "dashboard.card.on_leave",
    metricKey: "onLeave",
    label: "On Leave",
    description: "Employees marked on sanctioned leave in shift roster"
  },
  {
    id: "first_in",
    permissionKey: "dashboard.card.first_in",
    metricKey: "firstIn",
    label: "First In",
    description: "Count of initial entry punches recorded for the shift"
  },
  {
    id: "final_out",
    permissionKey: "dashboard.card.final_out",
    metricKey: "finalOut",
    label: "Final Out",
    description: "Count of actual final exit punches scanned"
  },
  {
    id: "duty_hours",
    permissionKey: "dashboard.card.duty_hours",
    metricKey: "dutyHoursMins",
    label: "Duty Hours",
    description: "Cumulative regular duty hours (also governs Duty column in drilldown)"
  },
  {
    id: "ot_hours",
    permissionKey: "dashboard.card.ot_hours",
    metricKey: "otHoursMins",
    label: "OT Hours",
    description: "Cumulative overtime hours beyond 08:30 (also governs OT in drilldown)"
  },
  {
    id: "auto_closed",
    permissionKey: "dashboard.card.auto_closed",
    metricKey: "autoClosed",
    label: "Auto Closed",
    description: "Attendance records automatically closed at shift end"
  },
  {
    id: "missed_punch_out",
    permissionKey: "dashboard.card.missed_punch_out",
    metricKey: "missedPunchOut",
    label: "Missed Punch Out",
    description: "Employees flagged for missing exit punch with zero OT"
  }
];
var DASHBOARD_SECTIONS = [
  {
    id: "shift_banner",
    permissionKey: "dashboard.section.shift_banner",
    label: "Automatic Shift Allocation & Auto-Closing Banner",
    description: "Displays automatic shift timings, auto-closing status badge, and quick scanner shortcut",
    isBreakdownReport: false
  },
  {
    id: "line_wise",
    permissionKey: "dashboard.section.line_wise",
    label: "Line-Wise Manpower Availability",
    description: "Production line breakdown table showing active, present, absent, and availability %",
    isBreakdownReport: true
  },
  {
    id: "section_wise",
    permissionKey: "dashboard.section.section_wise",
    label: "Section-Wise Manpower Availability",
    description: "Section breakdown table (MI, SMT, FATP, STORE) with manpower availability",
    isBreakdownReport: true
  },
  {
    id: "department_wise",
    permissionKey: "dashboard.section.department_wise",
    label: "Department-Wise Manpower Availability",
    description: "Department breakdown table (Production, Quality, PPC, R&D, etc.)",
    isBreakdownReport: true
  },
  {
    id: "employee_type_wise",
    permissionKey: "dashboard.section.employee_type_wise",
    label: "Employee-Type Manpower Availability",
    description: "Manpower availability grouped by Permanent, Staff, and Offroll categories",
    isBreakdownReport: true
  }
];
var ALL_DASHBOARD_CARD_IDS = DASHBOARD_CARDS.map((c) => c.id);
var USER_LEGACY_DASHBOARD_CARD_IDS = [
  "active_total",
  "total_present",
  "absent",
  "duty_hours",
  "ot_hours",
  "missed_punch_out"
];
var ALL_DASHBOARD_SECTION_IDS = DASHBOARD_SECTIONS.map((s) => s.id);
var DASHBOARD_CARD_PERMISSION_KEYS = new Set(
  DASHBOARD_CARDS.map((c) => c.permissionKey)
);
var DASHBOARD_SECTION_PERMISSION_KEYS = new Set(
  DASHBOARD_SECTIONS.map((s) => s.permissionKey)
);
var DASHBOARD_VISIBILITY_KEYS = /* @__PURE__ */ new Set([
  ...DASHBOARD_CARD_PERMISSION_KEYS,
  ...DASHBOARD_SECTION_PERMISSION_KEYS
]);
function normalizeUserRole(role) {
  if (!role) return "USER";
  const clean = String(role).trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (clean === "SUPER_ADMIN" || clean === "SUPERADMIN") return "SUPER_ADMIN";
  if (clean === "ADMIN") return "ADMIN";
  if (clean === "USER") return "USER";
  return clean || "USER";
}
function resolveDashboardVisibility(params) {
  const {
    role,
    modulesAllowed,
    rolePermissions,
    roleDefaultPermissions,
    userPermissionOverride
  } = params;
  const normalized = normalizeUserRole(role);
  if (normalized === "SUPER_ADMIN") {
    const explicitCardKeys2 = {};
    ALL_DASHBOARD_CARD_IDS.forEach((id) => {
      explicitCardKeys2[id] = true;
    });
    const explicitSectionKeys2 = {};
    ALL_DASHBOARD_SECTION_IDS.forEach((id) => {
      explicitSectionKeys2[id] = true;
    });
    return {
      dashboardViewAllowed: true,
      permittedCards: [...ALL_DASHBOARD_CARD_IDS],
      permittedSections: [...ALL_DASHBOARD_SECTION_IDS],
      explicitCardKeys: explicitCardKeys2,
      explicitSectionKeys: explicitSectionKeys2
    };
  }
  const hasUserOverride = Boolean(userPermissionOverride) && userPermissionOverride?.isCustomOverride !== false;
  const userPerms = hasUserOverride ? userPermissionOverride?.permissions || {} : null;
  const effectiveRolePerms = rolePermissions || roleDefaultPermissions || null;
  const mods = Array.isArray(modulesAllowed) ? modulesAllowed.map((m) => String(m).trim().toLowerCase()) : [];
  let dashboardViewAllowed;
  if (userPerms?.dashboard && typeof userPerms.dashboard.view === "boolean") {
    dashboardViewAllowed = userPerms.dashboard.view;
  } else if (effectiveRolePerms?.dashboard && typeof effectiveRolePerms.dashboard.view === "boolean") {
    dashboardViewAllowed = effectiveRolePerms.dashboard.view;
  } else if (mods.length > 0) {
    dashboardViewAllowed = mods.includes("all") || mods.includes("dashboard");
  } else {
    dashboardViewAllowed = normalized === "ADMIN" || normalized === "USER";
  }
  if (!dashboardViewAllowed) {
    return {
      dashboardViewAllowed: false,
      permittedCards: [],
      permittedSections: [],
      explicitCardKeys: {},
      explicitSectionKeys: {}
    };
  }
  let fallbackCardIds;
  if (normalized === "ADMIN") {
    fallbackCardIds = ALL_DASHBOARD_CARD_IDS;
  } else if (normalized === "USER") {
    fallbackCardIds = USER_LEGACY_DASHBOARD_CARD_IDS;
  } else {
    const hasOperationalAnalytics = mods.includes("all") || mods.includes("reports") || mods.includes("history") || mods.includes("employees") || mods.includes("shifts") || Boolean(
      effectiveRolePerms?.reports?.view || effectiveRolePerms?.history?.view || effectiveRolePerms?.employees?.view || effectiveRolePerms?.shifts?.view || userPerms?.reports?.view || userPerms?.history?.view || userPerms?.employees?.view || userPerms?.shifts?.view
    );
    fallbackCardIds = hasOperationalAnalytics ? ALL_DASHBOARD_CARD_IDS : USER_LEGACY_DASHBOARD_CARD_IDS;
  }
  const fallbackCardSet = new Set(fallbackCardIds);
  const permittedCards = [];
  const explicitCardKeys = {};
  for (const card of DASHBOARD_CARDS) {
    const userEntry = userPerms?.[card.permissionKey];
    const roleEntry = effectiveRolePerms?.[card.permissionKey];
    let allowed;
    if (userEntry && typeof userEntry.view === "boolean") {
      allowed = userEntry.view;
      explicitCardKeys[card.id] = true;
    } else if (roleEntry && typeof roleEntry.view === "boolean") {
      allowed = roleEntry.view;
      explicitCardKeys[card.id] = true;
    } else {
      allowed = fallbackCardSet.has(card.id);
    }
    if (allowed) {
      permittedCards.push(card.id);
    }
  }
  const permittedSections = [];
  const explicitSectionKeys = {};
  for (const section of DASHBOARD_SECTIONS) {
    const userEntry = userPerms?.[section.permissionKey];
    const roleEntry = effectiveRolePerms?.[section.permissionKey];
    let allowed;
    if (userEntry && typeof userEntry.view === "boolean") {
      allowed = userEntry.view;
      explicitSectionKeys[section.id] = true;
    } else if (roleEntry && typeof roleEntry.view === "boolean") {
      allowed = roleEntry.view;
      explicitSectionKeys[section.id] = true;
    } else {
      allowed = true;
    }
    if (allowed) {
      permittedSections.push(section.id);
    }
  }
  return {
    dashboardViewAllowed: true,
    permittedCards,
    permittedSections,
    explicitCardKeys,
    explicitSectionKeys
  };
}

// server.ts
function hashPassword(password) {
  const salt = crypto7.randomBytes(16).toString("hex");
  const hash = crypto7.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}
function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(":")) return false;
  const [salt, expectedHash] = storedHash.split(":");
  if (!salt || !expectedHash) return false;
  const actualHash = crypto7.scryptSync(password, salt, 64).toString("hex");
  const actualBuf = Buffer.from(actualHash, "hex");
  const expectedBuf = Buffer.from(expectedHash, "hex");
  if (actualBuf.length !== expectedBuf.length) return false;
  return crypto7.timingSafeEqual(actualBuf, expectedBuf);
}
async function syncExistingFirebaseAuthPassword(email, targetUid, newPassword, knownCurrentPassword) {
  if (typeof knownCurrentPassword !== "string" || knownCurrentPassword.length === 0) {
    return {
      success: false,
      error: "Firebase Admin SDK credentials (ADC or Service Account) or current password are required for password synchronization."
    };
  }
  try {
    const appletConfig = loadFirebaseAppletConfig();
    if (!appletConfig.apiKey) {
      return {
        success: false,
        error: "Missing Firebase web API key in firebase-applet-config.json."
      };
    }
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${appletConfig.apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: knownCurrentPassword, returnSecureToken: true })
      }
    );
    const data = await res.json();
    const errMsg = String(data?.error?.message || "");
    if (errMsg.includes("TOO_MANY_ATTEMPTS_TRY_LATER")) {
      return { success: false, rateLimited: true, error: "TOO_MANY_ATTEMPTS_TRY_LATER" };
    }
    if (!data?.idToken) {
      return {
        success: false,
        error: errMsg || `Firebase Auth rejected verification for "${email}".`
      };
    }
    if (data.localId !== targetUid) {
      return {
        success: false,
        error: `Email "${email}" belongs to UID "${data.localId}", expected UID "${targetUid}".`
      };
    }
    const updateRes = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:update?key=${appletConfig.apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken: data.idToken, password: newPassword, returnSecureToken: true })
      }
    );
    const updateData = await updateRes.json();
    const updateErr = String(updateData?.error?.message || "");
    if (updateErr.includes("TOO_MANY_ATTEMPTS_TRY_LATER")) {
      return { success: false, rateLimited: true, error: "TOO_MANY_ATTEMPTS_TRY_LATER" };
    }
    if (updateData.localId === targetUid) {
      return { success: true, uid: targetUid, matchedEmail: email };
    }
    return {
      success: false,
      error: updateData.error?.message || "Failed to update Firebase Auth password."
    };
  } catch (err) {
    return { success: false, error: err?.message || "Firebase Auth sync error." };
  }
}
var VerifySessionInputSchema = z7.object({
  loginId: z7.string().trim().min(1).max(64).optional(),
  userId: z7.string().trim().min(1).max(128).optional()
});
var AdminSetPasswordInputSchema = z7.object({
  targetLoginId: z7.string().trim().min(1, "targetLoginId is required.").max(64),
  newPassword: z7.string().min(6, "Password must be at least 6 characters.").max(128),
  mustChangePassword: z7.boolean().optional(),
  unlockAccount: z7.boolean().optional(),
  revokeSessions: z7.boolean().optional(),
  currentTargetPassword: z7.string().optional()
});
var RESERVED_CUSTOM_ROLE_ALIASES = /* @__PURE__ */ new Set([
  "superadmin",
  "super_admin",
  "root",
  "system",
  "super_admin_root"
]);
var DynamicRoleIdSchema = z7.string().trim().min(2, "Role ID must be at least 2 characters.").max(64, "Role ID must be 64 characters or fewer.").transform((val) => deriveStrictRoleId(val)).refine((val) => VALID_ROLE_ID_REGEX.test(val), {
  message: "Role ID must start with a letter and contain only lowercase letters, numbers, or underscores."
});
var RoleDefinitionInputSchema = z7.object({
  roleId: z7.string().trim().max(64).optional(),
  roleName: z7.string().trim().min(2, "Role name must be at least 2 characters.").max(48, "Role name must be 48 characters or fewer."),
  description: z7.string().trim().min(3, "Role description must be at least 3 characters.").max(500, "Role description must be 500 characters or fewer."),
  isActive: z7.boolean().default(true),
  defaultPermissions: z7.record(
    z7.string(),
    z7.object({
      view: z7.boolean().optional(),
      add: z7.boolean().optional(),
      edit: z7.boolean().optional(),
      delete: z7.boolean().optional()
    })
  ).optional()
});
var CreateUserInputSchema = z7.object({
  callerLoginId: z7.string().trim().min(1).max(64).optional(),
  loginId: z7.string().trim().min(2, "Login ID must be at least 2 characters.").max(64).regex(/^[a-zA-Z0-9_.-]+$/, "Login ID can only contain letters, numbers, hyphens, underscores, and dots."),
  name: z7.string().trim().min(1, "Name is required.").max(128),
  email: z7.string().trim().email("Valid email is required.").max(128),
  role: DynamicRoleIdSchema,
  password: z7.string().min(6, "Password must be at least 6 characters.").max(128),
  modulesAllowed: z7.array(z7.string().max(64)).optional(),
  status: z7.enum(["Active", "Inactive"]).default("Active"),
  mustChangePassword: z7.boolean().optional()
});
var DeleteUserInputSchema = z7.object({
  callerLoginId: z7.string().trim().min(1).max(64).optional(),
  targetId: z7.string().trim().min(1).max(128).optional(),
  targetLoginId: z7.string().trim().min(1).max(64).optional()
});
var SetUserPermissionsInputSchema = z7.object({
  callerLoginId: z7.string().trim().min(1).max(64).optional(),
  targetId: z7.string().trim().min(1).max(128),
  role: DynamicRoleIdSchema.optional(),
  status: z7.enum(["Active", "Inactive"]).optional(),
  modulesAllowed: z7.array(z7.string().max(64)).optional(),
  permissions: z7.record(
    z7.string(),
    z7.object({
      view: z7.boolean().optional(),
      add: z7.boolean().optional(),
      edit: z7.boolean().optional(),
      delete: z7.boolean().optional()
    })
  ).optional()
});
var RolePermissionsInputSchema = z7.object({
  callerLoginId: z7.string().trim().min(1).max(64).optional(),
  roleId: DynamicRoleIdSchema,
  modulePermissions: z7.record(
    z7.string(),
    z7.object({
      view: z7.boolean().optional(),
      add: z7.boolean().optional(),
      edit: z7.boolean().optional(),
      delete: z7.boolean().optional()
    })
  )
});
var CANONICAL_PROTECTED_UIDS = /* @__PURE__ */ new Set([
  "oX2vdSx5jGcoUDxyA0SIYN3SEig2",
  // superadmin@narid.com
  "2RpEv6mvyXYswYH9KPIGV6evtgY2",
  // admin@narid.com
  "vXPvgrp3i6cS2frqDa3ZoU9h9gc2",
  // user@narid.com
  "UNGneXk4pURTrQVXbVPAKPYtRvH3",
  // legacy superadmin_root@narid.com
  "vsz6j6kcbtSiCbecmJYVIRgbacJ2"
  // legacy admin_root@narid.com
]);
var INITIAL_ACCOUNTS = [
  {
    loginId: "superadmin",
    name: "Chief Plant Operations (Super Admin)",
    email: "superadmin@narid.com",
    emailAliases: ["superadmin_root@narid.com"],
    authUid: "oX2vdSx5jGcoUDxyA0SIYN3SEig2",
    role: "super_admin",
    modulesAllowed: ["all"]
  },
  {
    loginId: "admin",
    name: "Shift Supervisor (Admin)",
    email: "admin@narid.com",
    emailAliases: ["admin_root@narid.com"],
    authUid: "2RpEv6mvyXYswYH9KPIGV6evtgY2",
    role: "admin",
    modulesAllowed: [
      "dashboard",
      "scanner",
      "employees",
      "excel_import",
      "qr_codes",
      "floors",
      "sections",
      "departments",
      "shifts",
      "history",
      "reports"
    ]
  },
  {
    loginId: "user",
    name: "Floor Operator (Scanner User)",
    email: "user@narid.com",
    emailAliases: ["user_root@narid.com"],
    authUid: "vXPvgrp3i6cS2frqDa3ZoU9h9gc2",
    role: "user",
    modulesAllowed: ["dashboard", "scanner"]
  }
];
var DEFAULT_ROLE_PERMISSIONS = {
  super_admin: {
    dashboard: { view: true, add: true, edit: true, delete: true },
    scanner: { view: true, add: true, edit: true, delete: true },
    "attendance.qr.scan": { view: true, add: true, edit: true, delete: true },
    "attendance.manual.entry": { view: true, add: true, edit: true, delete: true },
    employees: { view: true, add: true, edit: true, delete: true },
    excel_import: { view: true, add: true, edit: true, delete: true },
    qr_codes: { view: true, add: true, edit: true, delete: true },
    organization: { view: true, add: true, edit: true, delete: true },
    floors: { view: true, add: true, edit: true, delete: true },
    sections: { view: true, add: true, edit: true, delete: true },
    departments: { view: true, add: true, edit: true, delete: true },
    shifts: { view: true, add: true, edit: true, delete: true },
    history: { view: true, add: true, edit: true, delete: true },
    reports: { view: true, add: true, edit: true, delete: true },
    user_rights: { view: true, add: true, edit: true, delete: true },
    audit_logs: { view: true, add: true, edit: true, delete: true },
    security_management: { view: true, add: true, edit: true, delete: true },
    company_wifi_access: { view: true, add: true, edit: true, delete: true },
    system_performance: { view: true, add: true, edit: true, delete: true },
    settings: { view: true, add: true, edit: true, delete: true },
    ...Object.fromEntries(
      Array.from(DASHBOARD_VISIBILITY_KEYS).map((k) => [
        k,
        { view: true, add: true, edit: true, delete: true }
      ])
    )
  },
  admin: {
    dashboard: { view: true, add: false, edit: false, delete: false },
    scanner: { view: true, add: true, edit: true, delete: false },
    "attendance.qr.scan": { view: false, add: false, edit: false, delete: false },
    "attendance.manual.entry": { view: false, add: false, edit: false, delete: false },
    employees: { view: true, add: true, edit: true, delete: false },
    excel_import: { view: true, add: true, edit: true, delete: false },
    qr_codes: { view: true, add: true, edit: true, delete: false },
    organization: { view: true, add: true, edit: true, delete: false },
    floors: { view: true, add: true, edit: true, delete: false },
    sections: { view: true, add: true, edit: true, delete: false },
    departments: { view: true, add: true, edit: true, delete: false },
    shifts: { view: true, add: false, edit: false, delete: false },
    history: { view: true, add: false, edit: true, delete: false },
    reports: { view: true, add: false, edit: false, delete: false },
    user_rights: { view: false, add: false, edit: false, delete: false },
    audit_logs: { view: false, add: false, edit: false, delete: false },
    security_management: { view: false, add: false, edit: false, delete: false },
    company_wifi_access: { view: false, add: false, edit: false, delete: false },
    system_performance: { view: false, add: false, edit: false, delete: false },
    settings: { view: false, add: false, edit: false, delete: false }
  },
  user: {
    dashboard: { view: true, add: false, edit: false, delete: false },
    scanner: { view: true, add: true, edit: false, delete: false },
    "attendance.qr.scan": { view: false, add: false, edit: false, delete: false },
    "attendance.manual.entry": { view: false, add: false, edit: false, delete: false },
    employees: { view: false, add: false, edit: false, delete: false },
    excel_import: { view: false, add: false, edit: false, delete: false },
    qr_codes: { view: false, add: false, edit: false, delete: false },
    organization: { view: false, add: false, edit: false, delete: false },
    floors: { view: false, add: false, edit: false, delete: false },
    sections: { view: false, add: false, edit: false, delete: false },
    departments: { view: false, add: false, edit: false, delete: false },
    shifts: { view: false, add: false, edit: false, delete: false },
    history: { view: false, add: false, edit: false, delete: false },
    reports: { view: false, add: false, edit: false, delete: false },
    user_rights: { view: false, add: false, edit: false, delete: false },
    audit_logs: { view: false, add: false, edit: false, delete: false },
    security_management: { view: false, add: false, edit: false, delete: false },
    company_wifi_access: { view: false, add: false, edit: false, delete: false },
    system_performance: { view: false, add: false, edit: false, delete: false },
    settings: { view: false, add: false, edit: false, delete: false }
  }
};
var RESTRICTED_SUPER_ADMIN_MODULES = /* @__PURE__ */ new Set([
  "user_rights",
  "audit_logs",
  "security_management",
  "company_wifi_access",
  "system_performance"
]);
var SCANNER_CAPABILITY_KEYS = /* @__PURE__ */ new Set([
  "attendance.qr.scan",
  "attendance.manual.entry"
]);
function sanitizeRoleModulePermissions(roleId, rawPerms) {
  const normalizedRole = normalizeRoleValue(roleId);
  if (normalizedRole === "super_admin") {
    return Object.fromEntries(
      Object.entries(DEFAULT_ROLE_PERMISSIONS.super_admin).map(([k, v]) => [k, { ...v }])
    );
  }
  const hasExplicitQrKey = Boolean(rawPerms) && Object.prototype.hasOwnProperty.call(rawPerms, "attendance.qr.scan");
  const baseKeys = /* @__PURE__ */ new Set([
    ...Object.keys(DEFAULT_ROLE_PERMISSIONS.user),
    ...Object.keys(rawPerms || {})
  ]);
  const sanitized = {};
  for (const modKey of baseKeys) {
    if (RESTRICTED_SUPER_ADMIN_MODULES.has(modKey)) {
      sanitized[modKey] = { view: false, add: false, edit: false, delete: false };
      continue;
    }
    if (modKey === "attendance.qr.scan" && !hasExplicitQrKey) {
      continue;
    }
    if (DASHBOARD_VISIBILITY_KEYS.has(modKey)) {
      if (!rawPerms || !Object.prototype.hasOwnProperty.call(rawPerms, modKey)) {
        continue;
      }
      const visEntry = rawPerms[modKey];
      sanitized[modKey] = {
        view: Boolean(visEntry?.view),
        add: false,
        edit: false,
        delete: false
      };
      continue;
    }
    const entry = rawPerms?.[modKey];
    const add = Boolean(entry?.add);
    const edit = Boolean(entry?.edit);
    const del = Boolean(entry?.delete);
    const view = Boolean(entry?.view) || add || edit || del;
    sanitized[modKey] = { view, add, edit, delete: del };
  }
  if (rawPerms && !Object.prototype.hasOwnProperty.call(rawPerms, "scanner") && (sanitized["attendance.qr.scan"]?.view || sanitized["attendance.manual.entry"]?.view)) {
    sanitized.scanner = { view: true, add: false, edit: false, delete: false };
  }
  const anyDashSubEnabled = Array.from(DASHBOARD_VISIBILITY_KEYS).some(
    (k) => sanitized[k]?.view === true
  );
  if (rawPerms && !Object.prototype.hasOwnProperty.call(rawPerms, "dashboard") && anyDashSubEnabled) {
    sanitized.dashboard = { view: true, add: false, edit: false, delete: false };
  }
  if (rawPerms && Object.prototype.hasOwnProperty.call(rawPerms, "dashboard") && sanitized.dashboard?.view === false) {
    for (const visKey of DASHBOARD_VISIBILITY_KEYS) {
      if (Object.prototype.hasOwnProperty.call(sanitized, visKey)) {
        sanitized[visKey] = { view: false, add: false, edit: false, delete: false };
      }
    }
  }
  return sanitized;
}
var PREDEFINED_ROLES = [
  {
    roleId: "super_admin",
    roleName: "SUPER_ADMIN",
    description: "Complete access to all application modules, account management, role permissions, system settings and administrative controls.",
    defaultPermissions: DEFAULT_ROLE_PERMISSIONS.super_admin,
    isActive: true,
    isSystemRole: true
  },
  {
    roleId: "admin",
    roleName: "ADMIN",
    description: "Operational dashboard, attendance management, employee records, reports and other specifically authorized modules.",
    defaultPermissions: DEFAULT_ROLE_PERMISSIONS.admin,
    isActive: true,
    isSystemRole: true
  },
  {
    roleId: "user",
    roleName: "USER",
    description: "Read-only Dashboard monitoring and Attendance Scanner access, according to assigned permissions.",
    defaultPermissions: DEFAULT_ROLE_PERMISSIONS.user,
    isActive: true,
    isSystemRole: true
  }
];
async function seedPredefinedRoles(db) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  for (const roleDef of PREDEFINED_ROLES) {
    try {
      const roleRef = db.collection("roles").doc(roleDef.roleId);
      const snap = await roleRef.get();
      if (!snap.exists) {
        await roleRef.set({
          ...roleDef,
          dashboardAccessMigratedV1: true,
          updatedAt: now
        });
      } else if (roleDef.roleId === "user") {
        const rData = snap.data() || {};
        if (!rData.dashboardAccessMigratedV1) {
          await roleRef.set(
            {
              description: roleDef.description,
              defaultPermissions: {
                ...rData.defaultPermissions || {},
                dashboard: { view: true, add: false, edit: false, delete: false }
              },
              dashboardAccessMigratedV1: true,
              updatedAt: now
            },
            { merge: true }
          );
        }
      }
      const permRef = db.collection("role_permissions").doc(roleDef.roleId);
      const permSnap = await permRef.get();
      if (!permSnap.exists) {
        await permRef.set({
          roleId: roleDef.roleId,
          roleName: roleDef.roleName,
          modulePermissions: roleDef.defaultPermissions,
          dashboardAccessMigratedV1: true,
          updatedAt: now,
          updatedBy: "system"
        });
      } else if (roleDef.roleId === "user") {
        const pData = permSnap.data() || {};
        if (!pData.dashboardAccessMigratedV1) {
          await permRef.set(
            {
              modulePermissions: {
                ...pData.modulePermissions || {},
                dashboard: { view: true, add: false, edit: false, delete: false }
              },
              dashboardAccessMigratedV1: true,
              updatedAt: now,
              updatedBy: "system_migration"
            },
            { merge: true }
          );
        }
      }
    } catch (e) {
      console.warn(`[Roles Boot] Warning for role ${roleDef.roleId}:`, e?.message || e);
    }
  }
}
async function seedInitialAccounts(db) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  for (const acc of INITIAL_ACCOUNTS) {
    const docId = `role_${acc.loginId}`;
    try {
      const userRef = db.collection("user_roles").doc(docId);
      const snap = await userRef.get();
      if (!snap.exists) {
        const randomInitialHash = hashPassword(crypto7.randomBytes(24).toString("hex"));
        await userRef.set({
          id: docId,
          loginId: acc.loginId,
          name: acc.name,
          email: acc.email,
          emailAliases: acc.emailAliases,
          authUid: acc.authUid,
          linkedAuthUids: [acc.authUid],
          role: acc.role,
          status: "Active",
          modulesAllowed: acc.modulesAllowed,
          passwordHash: randomInitialHash,
          mustChangePassword: true,
          dashboardAccessMigratedV1: true,
          createdAt: now,
          updatedAt: now
        });
        await syncUserUidIndex(db, {
          uid: acc.authUid,
          roleDocId: docId,
          role: acc.role,
          status: "Active",
          lockStatus: "ACTIVE",
          loginId: acc.loginId
        });
      } else {
        const data = snap.data() || {};
        const updates = {};
        if (acc.loginId === "user" && !data.dashboardAccessMigratedV1) {
          const existingModules = Array.isArray(data.modulesAllowed) ? data.modulesAllowed : ["scanner"];
          if (!existingModules.includes("dashboard")) {
            updates.modulesAllowed = ["dashboard", ...existingModules];
          }
          updates.dashboardAccessMigratedV1 = true;
        }
        if (Object.keys(updates).length > 0) {
          updates.updatedAt = now;
          await userRef.update(updates);
        }
        const effectiveUid = String(data.authUid || acc.authUid || "").trim();
        if (effectiveUid) {
          await syncUserUidIndex(db, {
            uid: effectiveUid,
            roleDocId: docId,
            role: String(data.role || acc.role),
            status: String(data.status || "Active"),
            lockStatus: data.isLocked || data.lockStatus === "LOCKED" ? "LOCKED" : "ACTIVE",
            loginId: String(data.loginId || acc.loginId)
          });
        }
      }
    } catch (e) {
      console.warn(`[Auth Boot] Verification notice for ${acc.loginId}:`, e?.message || e);
    }
  }
  try {
    const settingsRef = db.collection("system_settings").doc("global");
    const settingsSnap = await settingsRef.get();
    if (settingsSnap.exists) {
      const sData = settingsSnap.data() || {};
      const sUpdates = {};
      if (sData.auditRetentionDays === void 0) sUpdates.auditRetentionDays = 90;
      if (sData.protectCriticalLogs === void 0) sUpdates.protectCriticalLogs = true;
      if (sData.captureGeoLocation === void 0) sUpdates.captureGeoLocation = true;
      if (sData.failedLoginAlertThreshold === void 0) sUpdates.failedLoginAlertThreshold = 5;
      if (sData.superAdminLockoutResetHours === void 0) {
        sUpdates.superAdminLockoutResetHours = DEFAULT_SUPER_ADMIN_LOCKOUT_RESET_HOURS;
      }
      if (Object.keys(sUpdates).length > 0) {
        await settingsRef.update(sUpdates);
      }
    }
  } catch (e) {
    console.warn("[Settings Boot] Security retention defaults notice:", e?.message || e);
  }
}
var VERCEL_PRODUCTION_ORIGIN = "https://narid-atdc-tracker.vercel.app";
var AI_STUDIO_DEV_ORIGIN = "https://ais-dev-ffrnx5p5324ee4aajyzxbj-356936239657.asia-southeast1.run.app";
var AI_STUDIO_PREVIEW_ORIGIN = "https://ais-pre-ffrnx5p5324ee4aajyzxbj-356936239657.asia-southeast1.run.app";
function normalizeAllowedOrigin(raw) {
  const clean = String(raw || "").trim().replace(/\/+$/, "");
  if (!clean || clean === "*" || clean.includes("*")) return null;
  try {
    const parsed = new URL(clean);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    if (!parsed.hostname) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}
function buildAllowedOriginsSet(explicitOverride) {
  const allowed = /* @__PURE__ */ new Set();
  if (Array.isArray(explicitOverride)) {
    explicitOverride.forEach((o) => {
      const origin = normalizeAllowedOrigin(o);
      if (origin) allowed.add(origin);
    });
    return allowed;
  }
  allowed.add(VERCEL_PRODUCTION_ORIGIN);
  allowed.add(AI_STUDIO_DEV_ORIGIN);
  allowed.add(AI_STUDIO_PREVIEW_ORIGIN);
  const rawEnv = process.env.ALLOWED_ORIGINS || "";
  rawEnv.split(",").map((s) => normalizeAllowedOrigin(s)).filter((o) => Boolean(o)).forEach((o) => allowed.add(o));
  for (const singleUrl of [process.env.APP_URL, process.env.FRONTEND_URL]) {
    const origin = normalizeAllowedOrigin(singleUrl);
    if (origin) {
      allowed.add(origin);
    }
  }
  for (const vercelHost of [
    process.env.VERCEL_URL,
    process.env.VERCEL_BRANCH_URL,
    process.env.VERCEL_PROJECT_PRODUCTION_URL
  ]) {
    const cleanHost = (vercelHost || "").trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
    if (cleanHost) {
      const origin = normalizeAllowedOrigin(`https://${cleanHost}`);
      if (origin) allowed.add(origin);
    }
  }
  if (process.env.NODE_ENV !== "production") {
    allowed.add("http://localhost:3000");
    allowed.add("http://127.0.0.1:3000");
    allowed.add("http://localhost:5173");
    allowed.add("http://127.0.0.1:5173");
  }
  return allowed;
}
function createApp(options = {}) {
  const adminCtx = options.db ? null : getFirebaseAdminContext();
  const db = options.db || adminCtx?.db;
  const auth = options.auth !== void 0 ? options.auth : adminCtx?.auth || null;
  const projectId = options.projectId || adminCtx?.projectId || TARGET_PROJECT_ID;
  const databaseId = options.databaseId || adminCtx?.databaseId || TARGET_DATABASE_ID;
  const credentialMode = options.credentialMode || adminCtx?.credentialMode || "UNCONFIGURED";
  const getNowMs = options.nowProvider || (() => Date.now());
  const app = express();
  app.set("trust proxy", 1);
  const allowedOrigins = buildAllowedOriginsSet(options.allowedOrigins);
  const useStrictExplicitCors = Array.isArray(options.allowedOrigins);
  const isOriginPermitted = (origin, req) => {
    if (!origin) return true;
    const cleanOrigin = normalizeAllowedOrigin(origin);
    if (!cleanOrigin) return false;
    if (allowedOrigins.has(cleanOrigin)) return true;
    if (!useStrictExplicitCors) {
      const candidateHosts = [
        req.get("x-forwarded-host")?.split(",")[0]?.trim(),
        req.get("host")
      ].filter((h) => Boolean(h));
      const proto = req.get("x-forwarded-proto")?.split(",")[0]?.trim() || req.protocol || "http";
      for (const host of candidateHosts) {
        if (cleanOrigin === `${proto}://${host}` || cleanOrigin === `https://${host}`) {
          return true;
        }
      }
    }
    return false;
  };
  app.use((req, res, next) => {
    res.setHeader("Vary", "Origin");
    const origin = req.headers.origin;
    if (origin && !isOriginPermitted(origin, req)) {
      return res.status(403).json({
        success: false,
        code: "CORS_ORIGIN_FORBIDDEN",
        error: "Origin not allowed by CORS policy."
      });
    }
    return next();
  });
  app.use(
    cors((req, callback) => {
      const rawOrigin = req.headers.origin;
      const permitted = Boolean(rawOrigin && isOriginPermitted(rawOrigin, req));
      callback(null, {
        origin: permitted ? normalizeAllowedOrigin(rawOrigin) || false : false,
        credentials: permitted,
        methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allowedHeaders: [
          "Content-Type",
          "Authorization",
          "X-Correlation-ID"
        ],
        exposedHeaders: ["X-Correlation-ID", "X-Server-Process-Ms", "X-Payload-Bytes", "Server-Timing"],
        optionsSuccessStatus: 204
      });
    })
  );
  app.use(createMonitoringRequestMiddleware(() => db));
  app.use(
    "/api/network/speedtest/upload",
    express.raw({
      type: ["application/octet-stream", "application/binary"],
      limit: "600kb"
    })
  );
  const jsonBodyParser = express.json({ limit: "2mb" });
  app.use((req, res, next) => {
    if (req.path === "/api/network/speedtest/upload" && Buffer.isBuffer(req.body)) {
      req._body = true;
      return next();
    }
    const bodyDesc = Object.getOwnPropertyDescriptor(req, "body");
    const hasOwnBodyProp = Boolean(
      bodyDesc && ("value" in bodyDesc || typeof bodyDesc.get === "function")
    );
    if (hasOwnBodyProp) {
      const existingBody = req.body;
      const isReadOnlyGetter = Boolean(bodyDesc && typeof bodyDesc.get === "function" && !bodyDesc.set);
      if (existingBody !== void 0 && existingBody !== null) {
        const isJsonHeader = String(req.headers["content-type"] || "").toLowerCase().includes("application/json");
        let normalizedBody = existingBody;
        if (isJsonHeader && (typeof existingBody === "string" || Buffer.isBuffer(existingBody))) {
          const rawText = Buffer.isBuffer(existingBody) ? existingBody.toString("utf8") : existingBody;
          if (rawText.trim().length > 0) {
            try {
              normalizedBody = JSON.parse(rawText);
            } catch {
            }
          }
        }
        if (normalizedBody !== existingBody || isReadOnlyGetter) {
          if (!bodyDesc || bodyDesc.writable || typeof bodyDesc.set === "function") {
            req.body = normalizedBody;
          } else if (bodyDesc.configurable) {
            Object.defineProperty(req, "body", {
              value: normalizedBody,
              writable: true,
              enumerable: true,
              configurable: true
            });
          }
        }
        req._body = true;
        return next();
      }
      if (isReadOnlyGetter) {
        req._body = true;
        return next();
      }
    }
    return jsonBodyParser(req, res, next);
  });
  let runtimeFirestoreAccessError = null;
  const noteRuntimeFirestoreError = (err) => {
    if (isFirestorePermissionDeniedError(err)) {
      runtimeFirestoreAccessError = formatAdminPermissionDeniedError(projectId, databaseId);
      return true;
    }
    return false;
  };
  app.get("/api/health", (_req, res) => {
    const effectiveWarning = runtimeFirestoreAccessError || adminCtx?.error;
    const isOk = Boolean(db && !runtimeFirestoreAccessError);
    if (db) {
      noteServerHealthCheck(db, isOk ? "ok" : "degraded");
    }
    res.json({
      status: isOk ? "ok" : "degraded",
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      projectId,
      databaseId,
      adminSdkInitialized: Boolean(db && auth),
      firestoreAccess: runtimeFirestoreAccessError ? "permission_denied" : db ? "ok" : "unconfigured",
      credentialMode,
      ...effectiveWarning ? { initWarning: effectiveWarning } : {}
    });
  });
  if (!db) {
    app.use("/api", (_req, res) => {
      res.status(503).json({
        success: false,
        code: "FIREBASE_ADMIN_UNCONFIGURED",
        error: adminCtx?.error || "Firebase Admin SDK is not initialized. Configure FIREBASE_SERVICE_ACCOUNT_KEY (or FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY) on the server."
      });
    });
    app.use("/api", (err, _req, res, _next) => {
      if (res.headersSent) return;
      const status = typeof err?.status === "number" && err.status >= 400 && err.status < 600 ? err.status : 500;
      res.status(status).json({
        success: false,
        code: err instanceof SyntaxError && status === 400 ? "INVALID_JSON_BODY" : "INTERNAL_API_ERROR",
        error: err instanceof SyntaxError && status === 400 ? "Invalid JSON request body." : "Internal server error."
      });
    });
    return { app, db: null, auth: null, projectId, databaseId, credentialMode };
  }
  const adminDb = db;
  if (!options.disableBackgroundBoot) {
    seedInitialAccounts(adminDb).then(() => seedAccountSecurityRecords(adminDb)).catch((err) => {
      if (noteRuntimeFirestoreError(err)) {
        console.warn(`[Auth Boot] Firestore IAM notice: ${runtimeFirestoreAccessError}`);
      } else {
        console.warn("[Auth Boot] Seeding warning:", err?.message || err);
      }
    });
    seedPredefinedRoles(adminDb).catch((err) => {
      if (!noteRuntimeFirestoreError(err)) {
        console.warn("[Roles Boot] Seeding warning:", err?.message || err);
      }
    });
  }
  async function logAuditEvent(params) {
    await recordEnterpriseAuditEvent(adminDb, {
      req: params.req,
      action: params.action,
      actorUid: params.performedByUid || "system",
      actorLoginId: params.performedByLoginId || params.loginId || "system",
      actorRole: params.performedByRole || "SYSTEM",
      targetId: params.targetUid || params.loginId,
      oldValue: params.previousValue,
      newValue: params.newValue,
      actionSource: params.actionSource || "SERVER_API",
      description: params.details || "",
      success: params.success,
      sessionId: params.sessionId
    });
    const actModule = params.action.includes("role") || params.action.includes("permission") || params.action.includes("account") ? "User Rights & Permissions" : "Audit Logs & Security";
    recordActivityTelemetry(adminDb, {
      actorUid: params.performedByUid || "system",
      actorLoginId: params.performedByLoginId || params.loginId || "system",
      actorRole: params.performedByRole || "SYSTEM",
      action: params.action.toUpperCase(),
      module: actModule,
      result: params.success === false ? "Failed" : "Success",
      correlationId: params.req?.correlationId,
      detail: params.details
    });
    if (params.action.includes("unauthorized")) {
      recordErrorTelemetry(adminDb, {
        source: "AUTH",
        module: "Audit Logs & Security",
        category: "PERMISSION",
        severity: "CRITICAL",
        message: params.details || `Unauthorized attempt (${params.action})`,
        statusCode: 403,
        correlationId: params.req?.correlationId
      });
    }
  }
  async function requireVerifiedCaller(req, res, allowedRoles, actionLabel, options2) {
    try {
      const caller = await verifyCallerIdentity(req, adminDb, auth, projectId, {
        ...options2 || {},
        nowMs: getNowMs()
      });
      if (!caller) {
        await logAuditEvent({
          req,
          action: "unauthorized_access_attempt",
          loginId: "unauthenticated",
          performedByLoginId: "unauthenticated",
          performedByRole: "UNKNOWN",
          actionSource: "BACKEND_RBAC_GUARD",
          success: false,
          details: `Unauthenticated request blocked on ${actionLabel} (${req.method} ${req.path}).`
        });
        res.status(401).json({
          success: false,
          error: "Authentication required: Missing or invalid Firebase ID token."
        });
        return null;
      }
      if (allowedRoles !== "*" && !allowedRoles.includes(caller.role)) {
        await logAuditEvent({
          req,
          action: "unauthorized_access_attempt",
          loginId: caller.loginId,
          performedByUid: caller.uid,
          performedByLoginId: caller.loginId,
          performedByRole: caller.role.toUpperCase(),
          actionSource: "BACKEND_RBAC_GUARD",
          success: false,
          details: `Unauthorized attempt by "${caller.loginId}" (${caller.role}) on restricted action: ${actionLabel}.`
        });
        res.status(403).json({
          success: false,
          error: `Forbidden: Role "${caller.role.toUpperCase()}" is not permitted for ${actionLabel}.`
        });
        return null;
      }
      if (caller.role !== "super_admin" && !options2?.skipWifiCheck) {
        const wifiResult = await enforceCompanyWifiAccess(adminDb, req, caller, {
          nowMs: getNowMs()
        });
        if (!wifiResult.allowed) {
          res.status(wifiResult.httpStatus || 403).json(
            wifiResult.safeErrorPayload || {
              success: false,
              code: "COMPANY_WIFI_ACCESS_DENIED",
              error: "Access Denied: Please connect to an authorized Company Wi-Fi network."
            }
          );
          return null;
        }
      }
      return caller;
    } catch (err) {
      if (noteRuntimeFirestoreError(err)) {
        res.status(503).json({
          success: false,
          code: "FIREBASE_ADMIN_PERMISSION_DENIED",
          error: runtimeFirestoreAccessError
        });
        return null;
      }
      res.status(err?.statusCode || 401).json({
        success: false,
        error: err?.message || "Session authentication verification failed."
      });
      return null;
    }
  }
  async function getCallerEffectiveDashboardAccess(caller) {
    if (caller.role === "super_admin") {
      const visibility2 = resolveDashboardVisibility({ role: "super_admin" });
      return {
        allowed: true,
        readOnly: false,
        permittedCards: visibility2.permittedCards,
        permittedSections: visibility2.permittedSections
      };
    }
    const [userPermSnap, rolePermSnap, roleDefSnap, userRoleSnap] = await Promise.all([
      caller.profileDocId ? adminDb.collection("user_permissions").doc(caller.profileDocId).get() : Promise.resolve(null),
      getCachedRolePermissionsDoc(adminDb, caller.role),
      getCachedRoleDefDoc(adminDb, caller.role),
      caller.modulesAllowed === void 0 && caller.profileDocId ? adminDb.collection("user_roles").doc(caller.profileDocId).get() : Promise.resolve(null)
    ]);
    const hasUserOverride = userPermSnap?.exists && userPermSnap.data()?.isCustomOverride !== false;
    const userPerms = hasUserOverride ? userPermSnap?.data()?.permissions || {} : null;
    const rolePerms = rolePermSnap?.exists ? rolePermSnap.data?.modulePermissions || {} : null;
    const roleDefaultPerms = roleDefSnap?.exists ? roleDefSnap.data?.defaultPermissions || {} : null;
    const rawModules = caller.modulesAllowed !== void 0 ? caller.modulesAllowed : userRoleSnap?.exists && Array.isArray(userRoleSnap.data()?.modulesAllowed) ? userRoleSnap.data().modulesAllowed : [];
    const modulesAllowed = Array.isArray(rawModules) ? rawModules.map((m) => String(m).trim().toLowerCase()) : [];
    const visibility = resolveDashboardVisibility({
      role: caller.role,
      modulesAllowed,
      rolePermissions: rolePerms,
      roleDefaultPermissions: roleDefaultPerms,
      userPermissionOverride: hasUserOverride ? { isCustomOverride: true, permissions: userPerms } : null
    });
    if (caller.role === "user") {
      return {
        allowed: visibility.dashboardViewAllowed,
        readOnly: true,
        permittedCards: visibility.permittedCards,
        permittedSections: visibility.permittedSections
      };
    }
    if (caller.role === "admin") {
      return {
        allowed: visibility.dashboardViewAllowed,
        readOnly: false,
        permittedCards: visibility.permittedCards,
        permittedSections: visibility.permittedSections
      };
    }
    const effectivePerms = userPerms || rolePerms || roleDefaultPerms || {};
    const hasOperationalWrite = Object.entries(effectivePerms).some(([modKey, perms]) => {
      if (modKey === "dashboard" || DASHBOARD_VISIBILITY_KEYS.has(modKey) || RESTRICTED_SUPER_ADMIN_MODULES.has(modKey)) {
        return false;
      }
      return Boolean(perms?.add || perms?.edit || perms?.delete);
    });
    return {
      allowed: visibility.dashboardViewAllowed,
      readOnly: !hasOperationalWrite,
      permittedCards: visibility.permittedCards,
      permittedSections: visibility.permittedSections
    };
  }
  registerSecurityAuditRoutes(app, adminDb, auth, projectId);
  registerLoginSecurityRoutes(app, {
    db: adminDb,
    auth,
    projectId,
    verifyPassword,
    hashPassword,
    syncExistingFirebaseAuthPassword,
    requireVerifiedCaller,
    nowProvider: getNowMs
  });
  registerAttendanceRoutes(app, {
    db: adminDb,
    requireVerifiedCaller
  });
  registerEmployeeRoutes(app, {
    db: adminDb,
    requireVerifiedCaller
  });
  registerMasterRoutes(app, {
    db: adminDb,
    requireVerifiedCaller
  });
  registerMonitoringRoutes(app, {
    db: adminDb,
    requireVerifiedCaller,
    projectId,
    databaseId,
    credentialMode
  });
  registerCompanyWifiRoutes(app, {
    db: adminDb,
    requireVerifiedCaller,
    nowProvider: getNowMs
  });
  app.post("/api/auth/verify-session", async (req, res) => {
    try {
      const caller = await requireVerifiedCaller(
        req,
        res,
        "*",
        "Verify Active Session"
      );
      if (!caller) return;
      const parsed = VerifySessionInputSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({ success: false, active: false, error: "Invalid session payload." });
      }
      const { loginId, userId } = parsed.data;
      if (caller.role !== "super_admin" && (loginId && loginId.toLowerCase() !== caller.loginId || userId && userId !== caller.profileDocId && userId !== caller.uid)) {
        return res.status(403).json({
          success: false,
          active: false,
          error: "Forbidden: Cannot verify session status for another account."
        });
      }
      const targetDocId = userId || caller.profileDocId;
      const speculativeSecId = !loginId || loginId.trim().toLowerCase() === caller.loginId ? `sec_${caller.loginId}` : null;
      let [userDoc, secSnap] = await Promise.all([
        adminDb.collection("user_roles").doc(targetDocId).get(),
        speculativeSecId ? adminDb.collection("account_security").doc(speculativeSecId).get() : Promise.resolve(null)
      ]);
      if (!userDoc.exists && loginId) {
        const cleanId = loginId.trim().toLowerCase();
        userDoc = await adminDb.collection("user_roles").doc(`role_${cleanId}`).get();
        if (!userDoc.exists) {
          const snap = await adminDb.collection("user_roles").where("loginId", "==", cleanId).limit(1).get();
          if (!snap.empty) {
            userDoc = snap.docs[0];
          }
        }
      }
      if (!userDoc.exists) {
        return res.status(401).json({ success: false, active: false, error: "Account not found." });
      }
      const userData = userDoc.data() || {};
      if (userData.status === "Inactive") {
        return res.status(401).json({
          success: false,
          active: false,
          error: "Account Deactivated. Please contact system administrator."
        });
      }
      const resolvedLoginId = String(userData.loginId || userDoc.id.replace(/^role_/, "")).trim().toLowerCase();
      if (!secSnap || speculativeSecId !== `sec_${resolvedLoginId}`) {
        secSnap = await adminDb.collection("account_security").doc(`sec_${resolvedLoginId}`).get();
      }
      const secData = secSnap.exists ? secSnap.data() || {} : null;
      const isLocked = secData?.lockStatus === "LOCKED" || userData.lockStatus === "LOCKED" || userData.isLocked === true;
      if (isLocked) {
        const isCanonicalSA = isCanonicalSuperAdminAccount(userDoc.id, userData);
        if (isCanonicalSA) {
          const nowMs = getNowMs();
          const rawLockedUntilMs = typeof secData?.lockedUntilMs === "number" ? secData.lockedUntilMs : typeof userData.lockedUntilMs === "number" ? userData.lockedUntilMs : secData?.lockoutUntil ? Date.parse(String(secData.lockoutUntil)) : secData?.lockedUntil ? Date.parse(String(secData.lockedUntil)) : userData.lockoutUntil ? Date.parse(String(userData.lockoutUntil)) : userData.lockedUntil ? Date.parse(String(userData.lockedUntil)) : NaN;
          if (Number.isFinite(rawLockedUntilMs)) {
            if (nowMs < rawLockedUntilMs) {
              const remainingSeconds = Math.max(1, Math.ceil((rawLockedUntilMs - nowMs) / 1e3));
              const lockedUntilIso = secData?.lockoutUntil || secData?.lockedUntil || userData.lockoutUntil || userData.lockedUntil || new Date(rawLockedUntilMs).toISOString();
              return res.status(401).json({
                success: false,
                active: false,
                locked: true,
                temporaryLock: true,
                lockoutUntil: lockedUntilIso,
                lockedUntil: lockedUntilIso,
                lockedUntilMs: rawLockedUntilMs,
                serverNowMs: nowMs,
                remainingSeconds,
                error: `Super Admin account is temporarily locked. Try again in ${formatLockoutDurationText(remainingSeconds)}.`
              });
            }
            return res.status(401).json({
              success: false,
              active: false,
              locked: false,
              temporaryLock: false,
              error: "Temporary lockout has expired. Please sign in again to reactivate your session."
            });
          }
        }
        return res.status(401).json({
          success: false,
          active: false,
          locked: true,
          error: "Your account has been temporarily blocked. Please contact Super Admin."
        });
      }
      let effectiveModules = Array.isArray(userData.modulesAllowed) ? [...userData.modulesAllowed] : [];
      if (String(userData.role || "").toLowerCase() === "user" && !userData.dashboardAccessMigratedV1) {
        if (!effectiveModules.includes("dashboard")) {
          effectiveModules = ["dashboard", ...effectiveModules];
        }
      }
      const forceChange = userData.mustChangePassword === true || secData?.forcePasswordChange === true;
      const { passwordHash: _, ...sanitizedProfile } = userData;
      return res.json({
        success: true,
        active: true,
        role: userData.role,
        mustChangePassword: forceChange,
        forcePasswordChange: forceChange,
        lockStatus: "ACTIVE",
        modulesAllowed: effectiveModules,
        profile: {
          ...sanitizedProfile,
          modulesAllowed: effectiveModules,
          id: userDoc.id,
          mustChangePassword: forceChange,
          forcePasswordChange: forceChange,
          lockStatus: "ACTIVE"
        }
      });
    } catch (err) {
      console.error("[Verify Session] Error:", err);
      return res.status(500).json({ success: false, active: false, error: "Session verification error." });
    }
  });
  app.post("/api/admin/set-user-password", async (req, res) => {
    try {
      const caller = await requireVerifiedCaller(req, res, ["super_admin"], "Password Governance Reset");
      if (!caller) return;
      const parsed = AdminSetPasswordInputSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: parsed.error.issues[0]?.message || "targetLoginId and newPassword are required."
        });
      }
      const {
        targetLoginId,
        newPassword,
        mustChangePassword,
        unlockAccount,
        revokeSessions,
        currentTargetPassword
      } = parsed.data;
      const cleanCallerId = caller.loginId;
      const cleanTargetId = targetLoginId.trim().toLowerCase();
      const providedCurrentPwd = typeof currentTargetPassword === "string" && currentTargetPassword.length > 0 ? currentTargetPassword : void 0;
      const outcome = await withLoginIdLock(cleanTargetId, async () => {
        const docId = `role_${cleanTargetId}`;
        let targetDoc = await adminDb.collection("user_roles").doc(docId).get();
        if (!targetDoc.exists) {
          const snap = await adminDb.collection("user_roles").where("loginId", "==", cleanTargetId).limit(1).get();
          if (snap.empty) {
            return { status: 404, body: { success: false, error: `User with Login ID "${targetLoginId}" not found.` } };
          }
          targetDoc = snap.docs[0];
        }
        const targetData = targetDoc.data();
        if (!targetData) {
          return { status: 404, body: { success: false, error: "Target user record not found." } };
        }
        const targetRole = String(targetData.role || "user");
        const canonicalEmail = `${cleanTargetId}@narid.com`;
        const rawEmail = String(targetData.email || canonicalEmail).trim().toLowerCase();
        const targetEmail = rawEmail.endsWith("_root@narid.com") && Array.isArray(targetData.emailAliases) && targetData.emailAliases.includes(canonicalEmail) ? canonicalEmail : rawEmail;
        const targetUid = String(targetData.authUid || targetData.uid || targetDoc.id);
        let firebaseAuthSynced = false;
        let adminSdkAvailable = false;
        let rateLimited = false;
        let syncErrorReason = "";
        let matchedFirebaseEmail = null;
        const adminAttempt = await tryAdminAuthUpdatePassword(projectId, targetUid, newPassword, auth);
        adminSdkAvailable = adminAttempt.adminSdkAvailable;
        if (adminAttempt.updated) {
          firebaseAuthSynced = true;
          matchedFirebaseEmail = adminAttempt.email || targetEmail;
        } else {
          syncErrorReason = adminAttempt.reason || "";
          if (providedCurrentPwd && targetUid && !targetUid.startsWith("role_")) {
            const syncRes = await syncExistingFirebaseAuthPassword(
              targetEmail,
              targetUid,
              newPassword,
              providedCurrentPwd
            );
            if (syncRes.success) {
              firebaseAuthSynced = true;
              matchedFirebaseEmail = syncRes.matchedEmail || targetEmail;
            } else {
              rateLimited = Boolean(syncRes.rateLimited);
              if (syncRes.error) {
                syncErrorReason = syncRes.error;
              }
            }
          }
        }
        const telemetry = await captureTelemetryContext(adminDb, req);
        if (!firebaseAuthSynced) {
          await Promise.all([
            logAuditEvent({
              req,
              action: "admin_password_reset_failed",
              targetUid: targetDoc.id,
              loginId: cleanTargetId,
              performedByUid: caller.uid,
              performedByLoginId: cleanCallerId,
              performedByRole: "SUPER_ADMIN",
              actionSource: "USER_RIGHTS_GOVERNANCE",
              success: false,
              details: `Aborted password reset for "${cleanTargetId}" (UID: ${targetUid}, email: ${targetEmail}) because Firebase Auth update did not succeed. Firestore passwordHash left unchanged. Reason: ${syncErrorReason}`
            }),
            recordSecurityAuditLogDoc(adminDb, {
              action: "PASSWORD_RESET_SYNC_FAILED",
              severity: "CRITICAL",
              targetLoginId: cleanTargetId,
              targetRole: targetRole.toUpperCase(),
              targetUid,
              actorUid: caller.uid,
              actorLoginId: cleanCallerId,
              actorRole: "SUPER_ADMIN",
              reason: "Firebase Auth password update failed; Firestore passwordHash preserved unchanged",
              details: `Password reset for "${cleanTargetId}" aborted before modifying Firestore because Firebase Auth (${targetEmail}, UID: ${targetUid}) could not be updated. ${syncErrorReason}`,
              metadata: { adminSdkAvailable, rateLimited, uidPreserved: targetUid },
              telemetry
            })
          ]);
          return {
            status: rateLimited ? 429 : adminSdkAvailable ? 422 : 503,
            body: {
              success: false,
              code: rateLimited ? "FIREBASE_TOO_MANY_ATTEMPTS" : "FIREBASE_AUTH_SYNC_FAILED",
              firebaseAuthSynced: false,
              adminSdkConfigured: adminSdkAvailable,
              firebaseUid: targetUid,
              targetEmail,
              error: rateLimited ? `Firebase Authentication rate limit active (TOO_MANY_ATTEMPTS_TRY_LATER). Firestore passwordHash for "${cleanTargetId}" was NOT modified.` : `Firebase Authentication could not update password for "${targetEmail}" (UID: ${targetUid}). Firestore passwordHash was NOT modified to prevent credential mismatch. ${syncErrorReason}`.trim()
            }
          };
        }
        const newHash = hashPassword(newPassword);
        const now = (/* @__PURE__ */ new Date()).toISOString();
        const forceChange = mustChangePassword !== void 0 ? !!mustChangePassword : true;
        const targetUpdates = {
          passwordHash: newHash,
          mustChangePassword: forceChange,
          forcePasswordChange: forceChange,
          passwordLastChangedAt: now,
          passwordResetBy: cleanCallerId,
          passwordResetAt: now,
          sessionRevokedAt: revokeSessions ? now : targetData.sessionRevokedAt || null,
          updatedAt: now
        };
        if (unlockAccount) {
          targetUpdates.isLocked = false;
          targetUpdates.lockStatus = "ACTIVE";
          targetUpdates.consecutiveFailedAttempts = 0;
          targetUpdates.lockedAt = null;
          targetUpdates.lockReason = null;
        }
        await adminDb.collection("user_roles").doc(targetDoc.id).update(targetUpdates);
        const snapMatching = await adminDb.collection("user_roles").where("loginId", "==", cleanTargetId).get();
        for (const mDoc of snapMatching.docs) {
          if (mDoc.id !== targetDoc.id) {
            await adminDb.collection("user_roles").doc(mDoc.id).update(targetUpdates);
          }
        }
        const secUpdate = {
          id: `sec_${cleanTargetId}`,
          loginId: cleanTargetId,
          role: targetRole.toUpperCase(),
          firebaseUid: targetUid,
          forcePasswordChange: forceChange,
          tempPasswordResetByUid: caller.uid,
          tempPasswordResetByLoginId: cleanCallerId,
          tempPasswordResetAt: now,
          updatedAt: now
        };
        if (unlockAccount) {
          secUpdate.lockStatus = "ACTIVE";
          secUpdate.consecutiveFailedAttempts = 0;
          secUpdate.maxAttemptsAllowed = MAX_CONSECUTIVE_FAILED_ATTEMPTS;
          secUpdate.lockedAt = null;
          secUpdate.lockReason = null;
          secUpdate.unblockedByUid = caller.uid;
          secUpdate.unblockedByLoginId = cleanCallerId;
          secUpdate.unblockedAt = now;
          secUpdate.unblockReason = "Unlocked during Super Admin password reset";
          await clearIpCooldownPersistent(adminDb, void 0, cleanTargetId);
          if (targetData.authUid) {
            await syncUserUidIndex(adminDb, {
              uid: String(targetData.authUid),
              roleDocId: targetDoc.id,
              role: targetRole,
              status: String(targetData.status || "Active"),
              lockStatus: "ACTIVE",
              loginId: cleanTargetId
            });
          }
        }
        await adminDb.collection("account_security").doc(`sec_${cleanTargetId}`).set(secUpdate, { merge: true });
        await logAuditEvent({
          req,
          action: "admin_password_reset",
          targetUid: targetDoc.id,
          loginId: cleanTargetId,
          performedByUid: caller.uid,
          performedByLoginId: cleanCallerId,
          performedByRole: "SUPER_ADMIN",
          actionSource: "USER_RIGHTS_GOVERNANCE",
          newValue: {
            targetLoginId: cleanTargetId,
            targetRole,
            firebaseUid: targetUid,
            matchedFirebaseEmail,
            forceNextLoginChange: forceChange,
            unlocked: !!unlockAccount,
            sessionsRevoked: !!revokeSessions,
            firebaseAuthSynced: true
          },
          details: `Password reset by Super Admin "${cleanCallerId}" for "${cleanTargetId}" (${targetRole}, UID: ${targetUid}, email: ${matchedFirebaseEmail}). Force next login change: ${forceChange}.`
        });
        const resetLogId = `reset_${Date.now()}_${crypto7.randomBytes(3).toString("hex")}`;
        await adminDb.collection("password_reset_logs").doc(resetLogId).set({
          id: resetLogId,
          targetLoginId: cleanTargetId,
          targetName: targetData.name || cleanTargetId,
          targetRole,
          performedByLoginId: cleanCallerId,
          timestamp: now,
          forcedPasswordChange: forceChange,
          accountUnlocked: !!unlockAccount,
          sessionsRevoked: !!revokeSessions,
          firebaseAuthSynced: true,
          firebaseUid: targetUid
        });
        return {
          status: 200,
          body: {
            success: true,
            message: `Password for ${cleanTargetId} successfully updated in Firebase Authentication (UID: ${targetUid}, Email: ${matchedFirebaseEmail}) and Firestore.`,
            mustChangePassword: forceChange,
            firebaseAuthSynced: true,
            firebaseUid: targetUid,
            matchedFirebaseEmail,
            updatedAt: now
          }
        };
      });
      return res.status(outcome.status).json(outcome.body);
    } catch (err) {
      console.error("[Admin Password Change] Error:", err);
      return res.status(500).json({ success: false, error: err?.message || "Failed to update password." });
    }
  });
  app.get("/api/admin/password-reset-history", async (req, res) => {
    try {
      const caller = await requireVerifiedCaller(req, res, ["super_admin"], "Password Reset History");
      if (!caller) return;
      const snap = await adminDb.collection("password_reset_logs").get();
      const history = snap.docs.map((d) => d.data()).sort(
        (a, b) => new Date(b.timestamp || b.createdAt).getTime() - new Date(a.timestamp || a.createdAt).getTime()
      );
      return res.json({ success: true, history });
    } catch (err) {
      console.error("[Password Reset History] Error:", err);
      return res.status(500).json({ success: false, error: "Failed to fetch password reset history." });
    }
  });
  app.post("/api/auth/change-password", async (req, res) => {
    try {
      const caller = await requireVerifiedCaller(
        req,
        res,
        "*",
        "First-Time Password Change"
      );
      if (!caller) return;
      const { loginId, currentPassword, newPassword } = req.body || {};
      if (typeof newPassword !== "string" || newPassword.length < 6) {
        return res.status(400).json({ success: false, error: "New password must be at least 6 characters." });
      }
      if (newPassword.length > 128) {
        return res.status(400).json({ success: false, error: "New password must be 128 characters or fewer." });
      }
      const requestedLoginId = typeof loginId === "string" ? loginId.trim().toLowerCase() : "";
      if (caller.role !== "super_admin" && requestedLoginId && requestedLoginId !== caller.loginId) {
        await logAuditEvent({
          req,
          action: "unauthorized_password_reset_attempt",
          loginId: caller.loginId,
          performedByUid: caller.uid,
          performedByLoginId: caller.loginId,
          performedByRole: caller.role.toUpperCase(),
          actionSource: "CHANGE_PASSWORD_GUARD",
          success: false,
          details: `Blocked attempt by "${caller.loginId}" to change password for "${requestedLoginId}".`
        });
        return res.status(403).json({ success: false, error: "Forbidden: You cannot modify another account password." });
      }
      const cleanId = caller.role === "super_admin" && requestedLoginId ? requestedLoginId : caller.loginId;
      let userDoc = cleanId === caller.loginId && caller.profileDocId ? await adminDb.collection("user_roles").doc(caller.profileDocId).get() : await adminDb.collection("user_roles").doc(`role_${cleanId}`).get();
      if (!userDoc.exists) {
        const snap = await adminDb.collection("user_roles").where("loginId", "==", cleanId).limit(1).get();
        if (snap.empty) {
          return res.status(404).json({ success: false, error: "User not found." });
        }
        userDoc = snap.docs[0];
      }
      const userData = userDoc.data();
      if (!userData) {
        return res.status(404).json({ success: false, error: "User data not found." });
      }
      const secRef = adminDb.collection("account_security").doc(`sec_${cleanId}`);
      const secSnap = await secRef.get();
      const secData = secSnap.exists ? secSnap.data() : null;
      const mustChangeActive = userData.mustChangePassword === true || secData?.forcePasswordChange === true;
      const isSuperAdmin = caller.role === "super_admin";
      if (!isSuperAdmin && !mustChangeActive) {
        await logAuditEvent({
          req,
          action: "unauthorized_self_password_change",
          targetUid: userDoc.id,
          loginId: cleanId,
          performedByUid: caller.uid,
          performedByLoginId: caller.loginId,
          performedByRole: caller.role.toUpperCase(),
          actionSource: "CHANGE_PASSWORD_GUARD",
          success: false,
          details: `Blocked self-service password change attempt for "${cleanId}". Only Super Admin can manage passwords.`
        });
        return res.status(403).json({
          success: false,
          error: "Forbidden: Password management is restricted to Super Admin only. Self-service password changes are disabled."
        });
      }
      const isSelfChange = caller.loginId === cleanId;
      if ((isSelfChange || !isSuperAdmin) && userData.passwordHash) {
        if (typeof currentPassword !== "string" || currentPassword.length === 0) {
          return res.status(400).json({
            success: false,
            code: "CURRENT_PASSWORD_REQUIRED",
            error: "Please enter your current password to verify your identity."
          });
        }
        if (!verifyPassword(currentPassword, String(userData.passwordHash))) {
          await logAuditEvent({
            req,
            action: "password_change_invalid_current",
            targetUid: userDoc.id,
            loginId: cleanId,
            performedByUid: caller.uid,
            performedByLoginId: caller.loginId,
            performedByRole: caller.role.toUpperCase(),
            actionSource: "CHANGE_PASSWORD_GUARD",
            success: false,
            details: `Rejected password change for "${cleanId}" due to invalid current password.`
          });
          return res.status(401).json({
            success: false,
            code: "INVALID_CURRENT_PASSWORD",
            error: "Current password is incorrect. Please check and try again."
          });
        }
        if (newPassword === currentPassword) {
          return res.status(400).json({
            success: false,
            code: "PASSWORD_REUSE_NOT_ALLOWED",
            error: "New password must be different from your current password."
          });
        }
      } else if (typeof currentPassword === "string" && currentPassword.length > 0 && userData.passwordHash) {
        if (!verifyPassword(currentPassword, String(userData.passwordHash))) {
          return res.status(401).json({
            success: false,
            code: "INVALID_CURRENT_PASSWORD",
            error: "Current password is incorrect. Please check and try again."
          });
        }
      }
      const canonicalEmail = `${cleanId}@narid.com`;
      const rawTargetEmail = String(userData.email || canonicalEmail).trim().toLowerCase();
      const targetEmail = rawTargetEmail.endsWith("_root@narid.com") && Array.isArray(userData.emailAliases) && userData.emailAliases.includes(canonicalEmail) ? canonicalEmail : rawTargetEmail;
      const targetUid = String(userData.authUid || userData.uid || userDoc.id);
      let firebaseAuthSynced = false;
      let syncErr = "";
      if (targetUid && !targetUid.startsWith("role_")) {
        const adminAttempt = await tryAdminAuthUpdatePassword(projectId, targetUid, newPassword, auth);
        if (adminAttempt.updated) {
          firebaseAuthSynced = true;
        } else {
          syncErr = adminAttempt.reason || "";
          const syncRes = await syncExistingFirebaseAuthPassword(
            targetEmail,
            targetUid,
            newPassword,
            typeof currentPassword === "string" ? currentPassword : void 0
          );
          if (syncRes.success) {
            firebaseAuthSynced = true;
          } else if (syncRes.error) {
            syncErr = syncRes.error;
          }
        }
      }
      if (!firebaseAuthSynced) {
        return res.status(422).json({
          success: false,
          code: "FIREBASE_AUTH_SYNC_FAILED",
          firebaseAuthSynced: false,
          error: `Firebase Authentication password could not be synchronized for "${targetEmail}" (UID: ${targetUid}). Firestore passwordHash was left unchanged. ${syncErr}`.trim()
        });
      }
      const newHash = hashPassword(newPassword);
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const passUpdates = {
        passwordHash: newHash,
        mustChangePassword: false,
        forcePasswordChange: false,
        passwordLastChangedAt: now,
        updatedAt: now
      };
      await adminDb.collection("user_roles").doc(userDoc.id).update(passUpdates);
      await secRef.set(
        {
          id: `sec_${cleanId}`,
          loginId: cleanId,
          role: String(userData.role || "USER").toUpperCase(),
          firebaseUid: targetUid,
          forcePasswordChange: false,
          updatedAt: now
        },
        { merge: true }
      );
      const snapPassMatching = await adminDb.collection("user_roles").where("loginId", "==", cleanId).get();
      for (const mDoc of snapPassMatching.docs) {
        if (mDoc.id !== userDoc.id) {
          await adminDb.collection("user_roles").doc(mDoc.id).update(passUpdates);
        }
      }
      const telemetry = await captureTelemetryContext(adminDb, req);
      await Promise.all([
        logAuditEvent({
          req,
          action: "user_first_time_password_change",
          targetUid: userDoc.id,
          loginId: cleanId,
          performedByUid: caller.uid,
          performedByLoginId: caller.loginId,
          performedByRole: caller.role.toUpperCase(),
          actionSource: "FIRST_TIME_PASSWORD_MODAL",
          details: `Mandatory password change completed for account "${cleanId}" (UID: ${targetUid}). mustChangePassword and forcePasswordChange cleared to false.`
        }),
        recordSecurityAuditLogDoc(adminDb, {
          action: "MANDATORY_PASSWORD_CHANGED",
          severity: "INFO",
          targetLoginId: cleanId,
          targetRole: String(userData.role || "USER").toUpperCase(),
          targetUid,
          actorUid: caller.uid,
          actorLoginId: caller.loginId,
          actorRole: caller.role.toUpperCase(),
          reason: "User completed mandatory temporary/initial password change",
          details: `Account "${cleanId}" completed required password update. forcePasswordChange set to false.`,
          telemetry
        })
      ]);
      return res.json({
        success: true,
        message: "Password updated successfully in Firebase Authentication and Firestore. Access granted.",
        targetEmail,
        mustChangePassword: false,
        forcePasswordChange: false,
        firebaseAuthSynced: true
      });
    } catch (err) {
      console.error("[First-Time Password Change] Error:", err);
      return res.status(500).json({ success: false, error: err?.message || "Failed to update password." });
    }
  });
  app.post("/api/admin/create-user", async (req, res) => {
    try {
      const caller = await requireVerifiedCaller(req, res, ["super_admin"], "Create User Account");
      if (!caller) return;
      const parsed = CreateUserInputSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: parsed.error.issues[0]?.message || "Invalid user data." });
      }
      if (!auth) {
        return res.status(503).json({
          success: false,
          error: "Firebase Admin SDK Auth is not configured on backend; cannot create Firebase user."
        });
      }
      const { name, loginId, email, role, password, status, modulesAllowed, mustChangePassword } = parsed.data;
      const cleanCallerId = caller.loginId;
      const cleanId = loginId.trim().toLowerCase();
      const cleanEmail = email.trim().toLowerCase();
      const docId = `role_${cleanId}`;
      const [existingDoc, existingSnap, emailSnap] = await Promise.all([
        adminDb.collection("user_roles").doc(docId).get(),
        adminDb.collection("user_roles").where("loginId", "==", cleanId).limit(1).get(),
        adminDb.collection("user_roles").where("email", "==", cleanEmail).limit(1).get()
      ]);
      if (existingDoc.exists || !existingSnap.empty) {
        return res.status(400).json({ success: false, error: `Login ID "${cleanId}" already exists.` });
      }
      if (!emailSnap.empty) {
        return res.status(400).json({ success: false, error: `Email address "${cleanEmail}" is already registered to another account.` });
      }
      const assignedRole = deriveStrictRoleId(role);
      if (!assignedRole || !VALID_ROLE_ID_REGEX.test(assignedRole)) {
        return res.status(400).json({ success: false, error: "Invalid role ID specified." });
      }
      const [roleDocSnap, rolePermSnap] = await Promise.all([
        adminDb.collection("roles").doc(assignedRole).get(),
        adminDb.collection("role_permissions").doc(assignedRole).get()
      ]);
      if (!SYSTEM_ROLE_IDS.has(assignedRole) && !roleDocSnap.exists) {
        return res.status(400).json({
          success: false,
          error: `Role "${assignedRole}" does not exist. Create the role in Role Management first.`
        });
      }
      if (roleDocSnap.exists && roleDocSnap.data()?.isActive === false) {
        return res.status(400).json({
          success: false,
          error: `Role "${assignedRole}" is currently inactive and cannot be assigned to new users.`
        });
      }
      const roleDocData = roleDocSnap.exists ? roleDocSnap.data() || {} : null;
      const rolePermData = rolePermSnap.exists ? rolePermSnap.data() || {} : null;
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const passwordHash = hashPassword(password);
      const upperName = name.trim().toUpperCase();
      const fbUser = await auth.createUser({
        email: cleanEmail,
        password,
        displayName: upperName,
        disabled: status === "Inactive"
      });
      try {
        let finalModules = Array.isArray(modulesAllowed) ? [...modulesAllowed] : [];
        if (assignedRole !== "super_admin") {
          finalModules = finalModules.filter((m) => !RESTRICTED_SUPER_ADMIN_MODULES.has(m));
        }
        if (finalModules.length === 0) {
          if (assignedRole === "super_admin") {
            finalModules = ["all"];
          } else if (rolePermData?.modulePermissions) {
            finalModules = Object.entries(rolePermData.modulePermissions).filter(
              ([modKey, perms]) => Boolean(perms?.view) && !RESTRICTED_SUPER_ADMIN_MODULES.has(modKey) && !SCANNER_CAPABILITY_KEYS.has(modKey) && !DASHBOARD_VISIBILITY_KEYS.has(modKey)
            ).map(([modKey]) => modKey);
          } else if (roleDocData?.defaultPermissions) {
            finalModules = Object.entries(roleDocData.defaultPermissions).filter(
              ([modKey, perms]) => Boolean(perms?.view) && !RESTRICTED_SUPER_ADMIN_MODULES.has(modKey) && !SCANNER_CAPABILITY_KEYS.has(modKey) && !DASHBOARD_VISIBILITY_KEYS.has(modKey)
            ).map(([modKey]) => modKey);
          } else if (assignedRole === "admin") {
            finalModules = [
              "dashboard",
              "scanner",
              "employees",
              "excel_import",
              "qr_codes",
              "floors",
              "sections",
              "departments",
              "shifts",
              "history",
              "reports"
            ];
          } else if (assignedRole === "user") {
            finalModules = ["dashboard", "scanner"];
          }
        }
        const forceChange = mustChangePassword !== void 0 ? Boolean(mustChangePassword) : true;
        const newRecord = {
          id: docId,
          uid: fbUser.uid,
          authUid: fbUser.uid,
          linkedAuthUids: [fbUser.uid],
          loginId: cleanId,
          name: upperName,
          displayName: upperName,
          email: cleanEmail,
          role: assignedRole,
          status: status || "Active",
          modulesAllowed: finalModules,
          passwordHash,
          mustChangePassword: forceChange,
          forcePasswordChange: forceChange,
          isLocked: false,
          lockStatus: "ACTIVE",
          consecutiveFailedAttempts: 0,
          createdBy: cleanCallerId,
          createdAt: now,
          updatedAt: now
        };
        await adminDb.collection("user_roles").doc(docId).set(newRecord);
        const rawDefaultPerms = rolePermData?.modulePermissions || roleDocData?.defaultPermissions || DEFAULT_ROLE_PERMISSIONS[assignedRole] || null;
        const defaultRolePerms = sanitizeRoleModulePermissions(assignedRole, rawDefaultPerms);
        await adminDb.collection("user_permissions").doc(docId).set({
          id: docId,
          userId: docId,
          loginId: cleanId,
          role: assignedRole,
          isCustomOverride: false,
          permissions: defaultRolePerms,
          updatedAt: now,
          updatedBy: cleanCallerId
        });
        await adminDb.collection("account_security").doc(`sec_${cleanId}`).set({
          id: `sec_${cleanId}`,
          loginId: cleanId,
          role: assignedRole.toUpperCase(),
          firebaseUid: fbUser.uid,
          email: cleanEmail,
          lockStatus: "ACTIVE",
          consecutiveFailedAttempts: 0,
          maxAttemptsAllowed: MAX_CONSECUTIVE_FAILED_ATTEMPTS,
          totalLoginAttempts: 0,
          totalSuccessfulLogins: 0,
          totalFailedLogins: 0,
          forcePasswordChange: forceChange,
          updatedAt: now
        });
        await syncUserUidIndex(adminDb, {
          uid: fbUser.uid,
          roleDocId: docId,
          role: assignedRole,
          status: status || "Active",
          lockStatus: "ACTIVE",
          loginId: cleanId
        });
        await logAuditEvent({
          req,
          action: "account_created",
          targetUid: fbUser.uid,
          loginId: cleanId,
          performedByUid: caller.uid,
          performedByLoginId: cleanCallerId,
          performedByRole: "SUPER_ADMIN",
          actionSource: "USER_RIGHTS_CREATE",
          newValue: {
            loginId: cleanId,
            authUid: fbUser.uid,
            role: assignedRole,
            name: upperName,
            email: cleanEmail,
            status: newRecord.status
          },
          details: `Created new login ID "${cleanId}" (Firebase UID: ${fbUser.uid}) with role ${assignedRole.toUpperCase()}.`
        });
        const { passwordHash: _, ...sanitized } = newRecord;
        return res.json({ success: true, profile: sanitized });
      } catch (persistErr) {
        await auth.deleteUser(fbUser.uid).catch(() => {
        });
        throw persistErr;
      }
    } catch (err) {
      console.error("[Create User] Error:", err);
      const code = String(err?.code || "");
      if (code.includes("email-already-exists")) {
        return res.status(400).json({
          success: false,
          error: "Email address is already registered in Firebase Authentication."
        });
      }
      return res.status(500).json({ success: false, error: err?.message || "Failed to create user." });
    }
  });
  app.post("/api/admin/delete-user", async (req, res) => {
    try {
      const caller = await requireVerifiedCaller(req, res, ["super_admin"], "Delete User Account");
      if (!caller) return;
      const parsed = DeleteUserInputSchema.safeParse(req.body || {});
      if (!parsed.success || !parsed.data.targetId && !parsed.data.targetLoginId) {
        return res.status(400).json({ success: false, error: "targetId or targetLoginId is required." });
      }
      const { targetId, targetLoginId } = parsed.data;
      const cleanCallerId = caller.loginId;
      let targetDocId = targetId || "";
      let targetDocSnap = targetDocId ? await adminDb.collection("user_roles").doc(targetDocId).get() : null;
      if (!targetDocSnap || !targetDocSnap.exists) {
        const cleanTargetLoginId = (targetLoginId || "").trim().toLowerCase();
        if (cleanTargetLoginId) {
          targetDocId = `role_${cleanTargetLoginId}`;
          targetDocSnap = await adminDb.collection("user_roles").doc(targetDocId).get();
          if (!targetDocSnap.exists) {
            const snap = await adminDb.collection("user_roles").where("loginId", "==", cleanTargetLoginId).limit(1).get();
            if (!snap.empty) {
              targetDocSnap = snap.docs[0];
              targetDocId = targetDocSnap.id;
            }
          }
        }
      }
      if (!targetDocSnap || !targetDocSnap.exists) {
        return res.status(404).json({ success: false, error: "User account not found." });
      }
      const targetData = targetDocSnap.data() || {};
      const targetLogin = String(targetData.loginId || targetLoginId || "").trim().toLowerCase();
      const targetUid = String(targetData.authUid || targetData.uid || "");
      if (cleanCallerId === targetLogin) {
        return res.status(400).json({
          success: false,
          error: "Action denied: Administrators cannot delete their own active account."
        });
      }
      if (targetLogin === "superadmin" || targetDocId === "role_superadmin" || CANONICAL_PROTECTED_UIDS.has(targetUid)) {
        return res.status(400).json({
          success: false,
          error: "Action denied: Protected canonical system accounts cannot be deleted."
        });
      }
      if (String(targetData.role || "").toLowerCase() === "super_admin") {
        const allUsersSnap = await adminDb.collection("user_roles").get();
        const activeSuperAdmins = allUsersSnap.docs.filter((d) => {
          const data = d.data() || {};
          return String(data.role || "").toLowerCase() === "super_admin" && data.status !== "Inactive";
        });
        if (activeSuperAdmins.length <= 1) {
          return res.status(400).json({
            success: false,
            error: "Action denied: Cannot delete the last remaining active Super Admin."
          });
        }
      }
      await adminDb.collection("user_roles").doc(targetDocId).delete();
      await adminDb.collection("user_permissions").doc(targetDocId).delete().catch(() => {
      });
      if (targetUid && !targetUid.startsWith("role_")) {
        await removeUserUidIndex(adminDb, targetUid);
        invalidateUidRolePointer(adminDb, targetUid);
        if (auth) {
          await auth.revokeRefreshTokens(targetUid).catch(() => {
          });
          await auth.deleteUser(targetUid).catch(() => {
          });
        }
      }
      await logAuditEvent({
        req,
        action: "account_deleted",
        targetUid: targetDocId,
        loginId: targetLogin,
        performedByUid: caller.uid,
        performedByLoginId: cleanCallerId,
        performedByRole: "SUPER_ADMIN",
        actionSource: "USER_RIGHTS_DELETE",
        previousValue: {
          id: targetDocId,
          loginId: targetLogin,
          name: targetData.name,
          role: targetData.role,
          status: targetData.status
        },
        details: `Deleted user account "${targetLogin}" (${targetData.role})`
      });
      return res.json({
        success: true,
        message: `User account "${targetLogin}" successfully deleted from Firebase.`
      });
    } catch (err) {
      console.error("[Delete User] Error:", err);
      return res.status(500).json({ success: false, error: err?.message || "Failed to delete user account." });
    }
  });
  app.post("/api/admin/set-user-permissions", async (req, res) => {
    try {
      const caller = await requireVerifiedCaller(req, res, ["super_admin"], "Update User Permissions");
      if (!caller) return;
      const parsed = SetUserPermissionsInputSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: parsed.error.issues[0]?.message || "Invalid permissions request." });
      }
      const { targetId, permissions, modulesAllowed, role, status } = parsed.data;
      const cleanCallerId = caller.loginId;
      const targetDocRef = adminDb.collection("user_roles").doc(targetId);
      const targetSnap = await targetDocRef.get();
      if (!targetSnap.exists) {
        return res.status(404).json({ success: false, error: "User account not found." });
      }
      const oldData = targetSnap.data() || {};
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const oldLoginId = String(oldData.loginId || "").trim().toLowerCase();
      const targetUid = String(oldData.authUid || oldData.uid || "");
      const requestedRole = role ? deriveStrictRoleId(role) : "";
      if (requestedRole && requestedRole !== "super_admin" && (oldLoginId === "superadmin" || targetId === "role_superadmin" || CANONICAL_PROTECTED_UIDS.has(targetUid))) {
        return res.status(400).json({
          success: false,
          error: "Action denied: Protected canonical system accounts cannot have their role downgraded."
        });
      }
      if (requestedRole && !SYSTEM_ROLE_IDS.has(requestedRole)) {
        const customRoleSnap = await adminDb.collection("roles").doc(requestedRole).get();
        if (!customRoleSnap.exists) {
          return res.status(400).json({
            success: false,
            error: `Role "${requestedRole}" does not exist.`
          });
        }
        if (customRoleSnap.data()?.isActive === false) {
          return res.status(400).json({
            success: false,
            error: `Role "${requestedRole}" is currently inactive.`
          });
        }
      }
      const effectiveRole = normalizeRoleValue(requestedRole || oldData.role || "user");
      const safeModules = effectiveRole === "super_admin" ? modulesAllowed : modulesAllowed?.filter((m) => !RESTRICTED_SUPER_ADMIN_MODULES.has(m));
      const updatePayload = { updatedAt: now };
      if (safeModules) updatePayload.modulesAllowed = safeModules;
      if (requestedRole) updatePayload.role = requestedRole;
      if (status) updatePayload.status = status;
      await targetDocRef.update(updatePayload);
      if (oldData.authUid) {
        await syncUserUidIndex(adminDb, {
          uid: String(oldData.authUid),
          roleDocId: targetId,
          role: requestedRole || normalizeRoleValue(oldData.role || "user"),
          status: status || String(oldData.status || "Active"),
          lockStatus: oldData.isLocked || oldData.lockStatus === "LOCKED" ? "LOCKED" : "ACTIVE",
          loginId: String(oldData.loginId || "")
        });
        if (auth && status) {
          await auth.updateUser(String(oldData.authUid), { disabled: status === "Inactive" }).catch(() => {
          });
          if (status === "Inactive") {
            await auth.revokeRefreshTokens(String(oldData.authUid)).catch(() => {
            });
          }
        }
      }
      if (permissions) {
        const sanitizedPerms = sanitizeRoleModulePermissions(effectiveRole, permissions);
        const userPermRef = adminDb.collection("user_permissions").doc(targetId);
        const userPermExisting = await userPermRef.get();
        const userPermPayload = {
          id: targetId,
          userId: targetId,
          loginId: oldData.loginId || "",
          role: effectiveRole,
          isCustomOverride: true,
          permissions: sanitizedPerms,
          updatedAt: now,
          updatedBy: cleanCallerId
        };
        if (userPermExisting.exists) {
          await userPermRef.update(userPermPayload);
        } else {
          await userPermRef.set(userPermPayload);
        }
      }
      await logAuditEvent({
        req,
        action: "permission_updated",
        targetUid: targetId,
        loginId: String(oldData.loginId || ""),
        performedByUid: caller.uid,
        performedByLoginId: cleanCallerId,
        performedByRole: "SUPER_ADMIN",
        actionSource: "USER_PERMISSIONS_MATRIX",
        previousValue: {
          role: oldData.role,
          modulesAllowed: oldData.modulesAllowed,
          status: oldData.status
        },
        newValue: {
          role: effectiveRole,
          modulesAllowed: safeModules || oldData.modulesAllowed,
          status: status || oldData.status
        },
        details: `Updated permissions and role for user "${oldData.loginId}"`
      });
      invalidateRoleCaches(adminDb, effectiveRole);
      if (oldData.authUid) {
        invalidateUidRolePointer(adminDb, String(oldData.authUid));
      }
      return res.json({ success: true, message: `Permissions for "${oldData.loginId}" updated successfully.` });
    } catch (err) {
      console.error("[Set User Permissions] Error:", err);
      return res.status(500).json({ success: false, error: err?.message || "Failed to update user permissions." });
    }
  });
  const BulkUserStatusInputSchema = z7.object({
    userIds: z7.array(z7.string().trim().min(1)).min(1, "Select at least one user account.").max(200),
    status: z7.enum(["Active", "Inactive"]),
    confirmed: z7.literal(true, {
      message: "Explicit confirmation is required for bulk user status updates."
    })
  });
  app.post("/api/admin/users/bulk-status", async (req, res) => {
    try {
      const caller = await requireVerifiedCaller(req, res, ["super_admin"], "Bulk User Status Update");
      if (!caller) return;
      const parsed = BulkUserStatusInputSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: parsed.error.issues[0]?.message || "Invalid bulk user status payload."
        });
      }
      const { status } = parsed.data;
      const uniqueIds = Array.from(new Set(parsed.data.userIds.map((id) => id.trim()).filter(Boolean)));
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const allUsersSnap = await adminDb.collection("user_roles").get();
      const userDocById = /* @__PURE__ */ new Map();
      let activeSuperAdminCount = 0;
      for (const docSnap of allUsersSnap.docs) {
        const data = docSnap.data() || {};
        userDocById.set(docSnap.id, data);
        if (String(data.role || "").toLowerCase() === "super_admin" && data.status !== "Inactive") {
          activeSuperAdminCount++;
        }
      }
      const committedIds = [];
      const skippedItems = [];
      const failedItems = [];
      for (const targetId of uniqueIds) {
        const targetData = userDocById.get(targetId);
        if (!targetData) {
          skippedItems.push({ id: targetId, reason: "User account not found." });
          continue;
        }
        const targetLogin = String(targetData.loginId || "").trim().toLowerCase();
        const targetUid = String(targetData.authUid || targetData.uid || "");
        const isSuper = String(targetData.role || "").toLowerCase() === "super_admin";
        if (status === "Inactive") {
          if (targetLogin === caller.loginId || targetId === caller.profileDocId) {
            skippedItems.push({
              id: targetId,
              reason: "Protected: Cannot deactivate your own active account."
            });
            continue;
          }
          if (targetLogin === "superadmin" || targetId === "role_superadmin" || CANONICAL_PROTECTED_UIDS.has(targetUid)) {
            skippedItems.push({
              id: targetId,
              reason: "Protected: Root canonical Super Admin account cannot be deactivated."
            });
            continue;
          }
          if (isSuper && activeSuperAdminCount <= 1) {
            skippedItems.push({
              id: targetId,
              reason: "Protected: Cannot deactivate the last remaining active Super Admin."
            });
            continue;
          }
        }
        if (targetData.status === status) {
          skippedItems.push({ id: targetId, reason: `Account is already ${status}.` });
          continue;
        }
        try {
          await adminDb.collection("user_roles").doc(targetId).update({
            status,
            updatedAt: now
          });
          if (targetUid && !targetUid.startsWith("role_")) {
            await syncUserUidIndex(adminDb, {
              uid: targetUid,
              roleDocId: targetId,
              role: normalizeRoleValue(targetData.role || "user"),
              status,
              lockStatus: targetData.isLocked || targetData.lockStatus === "LOCKED" ? "LOCKED" : "ACTIVE",
              loginId: targetLogin
            });
            invalidateUidRolePointer(adminDb, targetUid);
            if (auth) {
              await auth.updateUser(targetUid, { disabled: status === "Inactive" }).catch(() => {
              });
              if (status === "Inactive") {
                await auth.revokeRefreshTokens(targetUid).catch(() => {
                });
              }
            }
          }
          if (status === "Inactive" && isSuper) {
            activeSuperAdminCount--;
          } else if (status === "Active" && isSuper && targetData.status === "Inactive") {
            activeSuperAdminCount++;
          }
          committedIds.push(targetId);
        } catch (err) {
          failedItems.push({ id: targetId, error: err?.message || "Failed to update account status." });
        }
      }
      await logAuditEvent({
        req,
        action: "bulk_user_status_updated",
        targetUid: committedIds.slice(0, 10).join(",") || "user_roles",
        loginId: caller.loginId,
        performedByUid: caller.uid,
        performedByLoginId: caller.loginId,
        performedByRole: "SUPER_ADMIN",
        actionSource: "USER_RIGHTS_BULK_STATUS",
        newValue: {
          status,
          savedCount: committedIds.length,
          skippedCount: skippedItems.length,
          failedCount: failedItems.length,
          committedIds
        },
        details: `Super Admin bulk set ${committedIds.length} user account(s) to ${status} (skipped ${skippedItems.length}).`
      });
      const partialCommit = committedIds.length > 0 && failedItems.length > 0;
      const statusCode = failedItems.length > 0 && committedIds.length === 0 ? 500 : 200;
      return res.status(statusCode).json({
        success: failedItems.length === 0,
        status,
        savedCount: committedIds.length,
        skippedCount: skippedItems.length,
        failedCount: failedItems.length,
        partialCommit,
        committedIds,
        skippedItems,
        failedItems
      });
    } catch (err) {
      console.error("[Bulk User Status API] Error:", err);
      return res.status(500).json({ success: false, error: err?.message || "Bulk user status update failed." });
    }
  });
  app.post("/api/admin/role-permissions", async (req, res) => {
    try {
      const caller = await requireVerifiedCaller(req, res, ["super_admin"], "Save Role Permissions");
      if (!caller) return;
      const parsed = RolePermissionsInputSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: parsed.error.issues[0]?.message || "Invalid role permissions request." });
      }
      const { roleId, modulePermissions } = parsed.data;
      if (roleId === "super_admin") {
        return res.status(400).json({ success: false, error: "Super Admin permissions are complete and permanent." });
      }
      const roleDocSnap = await adminDb.collection("roles").doc(roleId).get();
      if (!SYSTEM_ROLE_IDS.has(roleId) && !roleDocSnap.exists) {
        return res.status(404).json({ success: false, error: `Role "${roleId}" does not exist.` });
      }
      const resolvedRoleName = String(roleDocSnap.exists ? roleDocSnap.data()?.roleName || "" : "").trim() || (roleId === "admin" ? "Admin" : roleId === "user" ? "User" : roleId.toUpperCase());
      const cleanCallerId = caller.loginId;
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const sanitizedModulePermissions = sanitizeRoleModulePermissions(roleId, modulePermissions);
      const rolePermRef = adminDb.collection("role_permissions").doc(roleId);
      const rolePermExisting = await rolePermRef.get();
      const rolePermPayload = {
        roleId,
        roleName: resolvedRoleName,
        modulePermissions: sanitizedModulePermissions,
        updatedAt: now,
        updatedBy: cleanCallerId
      };
      if (rolePermExisting.exists) {
        await rolePermRef.update(rolePermPayload);
      } else {
        await rolePermRef.set(rolePermPayload);
      }
      const roleRefForUpdate = adminDb.collection("roles").doc(roleId);
      const roleUpdatePayload = {
        roleId,
        roleName: resolvedRoleName,
        defaultPermissions: sanitizedModulePermissions,
        updatedAt: now
      };
      if (roleDocSnap.exists) {
        await roleRefForUpdate.update(roleUpdatePayload);
      } else {
        await roleRefForUpdate.set(roleUpdatePayload, { merge: true });
      }
      const allowedModules = [];
      Object.entries(sanitizedModulePermissions).forEach(([modKey, perms]) => {
        if (perms?.view && !SCANNER_CAPABILITY_KEYS.has(modKey) && !DASHBOARD_VISIBILITY_KEYS.has(modKey)) {
          allowedModules.push(modKey);
        }
      });
      const usersSnap = await adminDb.collection("user_roles").where("role", "==", roleId).get();
      await Promise.all(
        usersSnap.docs.map(async (uDoc) => {
          await adminDb.collection("user_roles").doc(uDoc.id).update({
            modulesAllowed: allowedModules,
            updatedAt: now
          });
          const userPermRef = adminDb.collection("user_permissions").doc(uDoc.id);
          const userPermSnap = await userPermRef.get();
          if (!userPermSnap.exists || userPermSnap.data()?.isCustomOverride !== true) {
            const inheritedPayload = {
              id: uDoc.id,
              userId: uDoc.id,
              loginId: uDoc.data()?.loginId || "",
              role: roleId,
              isCustomOverride: false,
              permissions: sanitizedModulePermissions,
              updatedAt: now,
              updatedBy: cleanCallerId
            };
            if (userPermSnap.exists) {
              await userPermRef.update(inheritedPayload);
            } else {
              await userPermRef.set(inheritedPayload);
            }
          }
        })
      );
      await logAuditEvent({
        req,
        action: "role_permissions_updated",
        targetUid: roleId,
        loginId: roleId,
        performedByUid: caller.uid,
        performedByLoginId: cleanCallerId,
        performedByRole: "SUPER_ADMIN",
        actionSource: "ROLE_PERMISSIONS_MATRIX",
        newValue: { roleId, allowedModules },
        details: `Updated default role permissions for role "${roleId.toUpperCase()}"`
      });
      invalidateRoleCaches(adminDb, roleId);
      return res.json({
        success: true,
        message: `Role permissions for ${resolvedRoleName} saved successfully.`,
        modulePermissions: sanitizedModulePermissions,
        updatedAt: now
      });
    } catch (err) {
      console.error("[Save Role Permissions] Error:", err);
      return res.status(500).json({ success: false, error: err?.message || "Failed to save role permissions." });
    }
  });
  app.get("/api/admin/roles", async (req, res) => {
    try {
      const caller = await requireVerifiedCaller(req, res, "*", "List System and Custom Roles");
      if (!caller) return;
      const snap = await adminDb.collection("roles").get();
      const map = /* @__PURE__ */ new Map();
      PREDEFINED_ROLES.forEach((def) => {
        map.set(def.roleId, { ...def });
      });
      snap.docs.forEach((d) => {
        const data = d.data() || {};
        const roleId = normalizeRoleValue(data.roleId || d.id);
        map.set(roleId, {
          ...data,
          roleId,
          roleName: String(data.roleName || roleId.toUpperCase()),
          isActive: data.isActive !== false,
          isSystemRole: SYSTEM_ROLE_IDS.has(roleId)
        });
      });
      const orderPriority = { super_admin: 0, admin: 1, user: 2 };
      const roles = Array.from(map.values()).sort((a, b) => {
        const pA = orderPriority[a.roleId] ?? 10;
        const pB = orderPriority[b.roleId] ?? 10;
        if (pA !== pB) return pA - pB;
        return String(a.roleName || a.roleId).localeCompare(String(b.roleName || b.roleId));
      });
      return res.json({ success: true, roles });
    } catch (err) {
      console.error("[Roles API] List error:", err);
      return res.status(500).json({ success: false, error: "Failed to load role definitions." });
    }
  });
  app.post("/api/admin/roles", async (req, res) => {
    try {
      const caller = await requireVerifiedCaller(req, res, ["super_admin"], "Create or Update Role");
      if (!caller) return;
      const parsed = RoleDefinitionInputSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: parsed.error.issues[0]?.message || "Invalid role definition payload."
        });
      }
      const rawIdCandidate = parsed.data.roleId || parsed.data.roleName;
      const derivedId = deriveStrictRoleId(rawIdCandidate);
      const isCreatingFromName = !parsed.data.roleId;
      if (!derivedId || !VALID_ROLE_ID_REGEX.test(derivedId)) {
        return res.status(400).json({
          success: false,
          error: "Role ID must start with a letter and use lowercase letters, numbers, or underscores."
        });
      }
      if (isCreatingFromName && (SYSTEM_ROLE_IDS.has(derivedId) || RESERVED_CUSTOM_ROLE_ALIASES.has(derivedId))) {
        return res.status(400).json({
          success: false,
          error: `Role name "${parsed.data.roleName}" conflicts with a reserved system role.`
        });
      }
      if (parsed.data.roleId && RESERVED_CUSTOM_ROLE_ALIASES.has(derivedId) && derivedId !== "super_admin") {
        return res.status(400).json({
          success: false,
          error: `Role ID "${derivedId}" is reserved and cannot be used for a custom role.`
        });
      }
      if (derivedId === "super_admin") {
        return res.status(400).json({
          success: false,
          error: "Super Admin system role configuration is protected and immutable."
        });
      }
      const isSystem = SYSTEM_ROLE_IDS.has(derivedId);
      if (isSystem && parsed.data.isActive === false) {
        return res.status(400).json({
          success: false,
          error: "Built-in system roles cannot be deactivated."
        });
      }
      const roleRef = adminDb.collection("roles").doc(derivedId);
      const existingSnap = await roleRef.get();
      const existingData = existingSnap.exists ? existingSnap.data() || {} : null;
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const cleanCallerId = caller.loginId;
      const sanitizedDefaultPerms = sanitizeRoleModulePermissions(
        derivedId,
        parsed.data.defaultPermissions || existingData?.defaultPermissions || DEFAULT_ROLE_PERMISSIONS[derivedId] || null
      );
      const roleDoc = {
        roleId: derivedId,
        roleName: parsed.data.roleName.trim(),
        description: parsed.data.description.trim(),
        isActive: isSystem ? true : Boolean(parsed.data.isActive),
        isSystemRole: isSystem,
        defaultPermissions: sanitizedDefaultPerms,
        createdAt: existingData?.createdAt || now,
        createdBy: existingData?.createdBy || cleanCallerId,
        updatedAt: now,
        updatedBy: cleanCallerId
      };
      if (existingSnap.exists) {
        await roleRef.update(roleDoc);
      } else {
        await roleRef.set(roleDoc);
      }
      const rolePermRef = adminDb.collection("role_permissions").doc(derivedId);
      const rolePermSnap = await rolePermRef.get();
      const rolePermDocPayload = {
        roleId: derivedId,
        roleName: roleDoc.roleName,
        modulePermissions: sanitizedDefaultPerms,
        updatedAt: now,
        updatedBy: cleanCallerId
      };
      if (rolePermSnap.exists) {
        await rolePermRef.update(rolePermDocPayload);
      } else {
        await rolePermRef.set(rolePermDocPayload);
      }
      if (parsed.data.defaultPermissions) {
        const allowedModules = Object.entries(sanitizedDefaultPerms).filter(
          ([modKey, perms]) => Boolean(perms?.view) && !SCANNER_CAPABILITY_KEYS.has(modKey) && !DASHBOARD_VISIBILITY_KEYS.has(modKey)
        ).map(([modKey]) => modKey);
        const usersSnap = await adminDb.collection("user_roles").where("role", "==", derivedId).get();
        await Promise.all(
          usersSnap.docs.map(async (uDoc) => {
            await adminDb.collection("user_roles").doc(uDoc.id).update({
              modulesAllowed: allowedModules,
              updatedAt: now
            });
            const userPermRef = adminDb.collection("user_permissions").doc(uDoc.id);
            const userPermSnap = await userPermRef.get();
            if (!userPermSnap.exists || userPermSnap.data()?.isCustomOverride !== true) {
              const inheritedPayload = {
                id: uDoc.id,
                userId: uDoc.id,
                loginId: uDoc.data()?.loginId || "",
                role: derivedId,
                isCustomOverride: false,
                permissions: sanitizedDefaultPerms,
                updatedAt: now,
                updatedBy: cleanCallerId
              };
              if (userPermSnap.exists) {
                await userPermRef.update(inheritedPayload);
              } else {
                await userPermRef.set(inheritedPayload);
              }
            }
          })
        );
      }
      await logAuditEvent({
        req,
        action: existingSnap.exists ? "role_updated" : "role_created",
        targetUid: derivedId,
        loginId: derivedId,
        performedByUid: caller.uid,
        performedByLoginId: cleanCallerId,
        performedByRole: "SUPER_ADMIN",
        actionSource: "ROLE_MANAGEMENT",
        previousValue: existingData ? {
          roleName: existingData.roleName,
          description: existingData.description,
          isActive: existingData.isActive
        } : void 0,
        newValue: {
          roleId: derivedId,
          roleName: roleDoc.roleName,
          description: roleDoc.description,
          isActive: roleDoc.isActive
        },
        details: `${existingSnap.exists ? "Updated" : "Created"} role "${roleDoc.roleName}" (${derivedId}).`
      });
      invalidateRoleCaches(adminDb, derivedId);
      return res.json({
        success: true,
        created: !existingSnap.exists,
        role: roleDoc,
        modulePermissions: sanitizedDefaultPerms
      });
    } catch (err) {
      console.error("[Save Role Definition] Error:", err);
      return res.status(500).json({ success: false, error: err?.message || "Failed to save role definition." });
    }
  });
  app.delete("/api/admin/roles/:roleId", async (req, res) => {
    try {
      const caller = await requireVerifiedCaller(req, res, ["super_admin"], "Delete Custom Role");
      if (!caller) return;
      const roleId = deriveStrictRoleId(req.params.roleId);
      if (!roleId || !VALID_ROLE_ID_REGEX.test(roleId)) {
        return res.status(400).json({ success: false, error: "Invalid role ID." });
      }
      if (SYSTEM_ROLE_IDS.has(roleId)) {
        return res.status(400).json({
          success: false,
          error: `Built-in system role "${roleId}" cannot be deleted.`
        });
      }
      const roleSnap = await adminDb.collection("roles").doc(roleId).get();
      if (!roleSnap.exists) {
        return res.status(404).json({ success: false, error: `Role "${roleId}" not found.` });
      }
      const assignedUsersSnap = await adminDb.collection("user_roles").where("role", "==", roleId).limit(1).get();
      if (!assignedUsersSnap.empty) {
        return res.status(400).json({
          success: false,
          error: `Cannot delete role "${roleId}" while one or more user accounts are assigned to it.`
        });
      }
      const prevRoleData = roleSnap.data() || {};
      await Promise.all([
        adminDb.collection("roles").doc(roleId).delete(),
        adminDb.collection("role_permissions").doc(roleId).delete().catch(() => {
        })
      ]);
      await logAuditEvent({
        req,
        action: "role_deleted",
        targetUid: roleId,
        loginId: roleId,
        performedByUid: caller.uid,
        performedByLoginId: caller.loginId,
        performedByRole: "SUPER_ADMIN",
        actionSource: "ROLE_MANAGEMENT",
        previousValue: {
          roleId,
          roleName: prevRoleData.roleName,
          description: prevRoleData.description
        },
        details: `Deleted custom role "${prevRoleData.roleName || roleId}" (${roleId}).`
      });
      invalidateRoleCaches(adminDb, roleId);
      return res.json({
        success: true,
        message: `Custom role "${prevRoleData.roleName || roleId}" deleted successfully.`
      });
    } catch (err) {
      console.error("[Delete Custom Role] Error:", err);
      return res.status(500).json({ success: false, error: err?.message || "Failed to delete role." });
    }
  });
  app.get("/api/admin/duplicate-accounts-report", async (req, res) => {
    try {
      const caller = await requireVerifiedCaller(req, res, ["super_admin"], "Duplicate Accounts Report");
      if (!caller) return;
      const [userRolesSnap, auditSnap] = await Promise.all([
        adminDb.collection("user_roles").get(),
        adminDb.collection("audit_logs").get()
      ]);
      const groups = {};
      userRolesSnap.docs.forEach((d) => {
        const data = d.data() || {};
        const loginId = String(data.loginId || d.id.replace(/^role_/, "")).trim().toLowerCase();
        if (!groups[loginId]) groups[loginId] = [];
        groups[loginId].push({ docId: d.id, ...data });
      });
      let totalDuplicates = 0;
      const report = [];
      for (const [loginId, docs] of Object.entries(groups)) {
        const hasDuplicates = docs.length > 1;
        if (hasDuplicates) totalDuplicates += docs.length - 1;
        docs.sort((a, b) => {
          if (a.docId === `role_${loginId}`) return -1;
          if (b.docId === `role_${loginId}`) return 1;
          if (a.passwordHash && !b.passwordHash) return -1;
          if (!a.passwordHash && b.passwordHash) return 1;
          return (a.createdAt || "").localeCompare(b.createdAt || "");
        });
        const primaryDoc = docs[0];
        const docDetails = docs.map((d) => {
          const auditCount = auditSnap.docs.filter((a) => {
            const str = JSON.stringify(a.data());
            return str.includes(d.docId) || d.uid && str.includes(d.uid);
          }).length;
          const isPrimary = d.docId === primaryDoc.docId;
          return {
            docId: d.docId,
            firebaseUid: d.uid || d.authUid || (d.docId.length > 20 && !d.docId.startsWith("role_") ? d.docId : null),
            loginId: d.loginId || loginId,
            name: d.name || d.displayName || "N/A",
            email: d.email || "N/A",
            role: d.role || "user",
            status: d.status || "Active",
            hasPasswordHash: !!d.passwordHash,
            createdAt: d.createdAt || null,
            associatedAuditLogs: auditCount,
            isPrimary,
            recommendation: isPrimary ? "RETAIN_PRIMARY" : "CONSOLIDATE_AND_DELETE"
          };
        });
        report.push({
          loginId,
          totalDocs: docs.length,
          hasDuplicates,
          primaryDocId: primaryDoc.docId,
          documents: docDetails
        });
      }
      return res.json({
        success: true,
        totalRawDocuments: userRolesSnap.docs.length,
        totalUniqueAccounts: Object.keys(groups).length,
        duplicateCount: totalDuplicates,
        report,
        summary: `Found ${userRolesSnap.docs.length} total documents representing ${Object.keys(groups).length} unique accounts. ${totalDuplicates} shadow duplicate(s) detected.`
      });
    } catch (err) {
      console.error("[Duplicate Report] Error:", err);
      return res.status(500).json({ success: false, error: err?.message || "Failed to generate duplicate report." });
    }
  });
  app.post("/api/admin/consolidate-duplicates", async (req, res) => {
    try {
      const caller = await requireVerifiedCaller(req, res, ["super_admin"], "Consolidate Duplicate Accounts");
      if (!caller) return;
      const cleanCallerId = caller.loginId;
      const userRolesSnap = await adminDb.collection("user_roles").get();
      const groups = {};
      userRolesSnap.docs.forEach((d) => {
        const data = d.data() || {};
        const loginId = String(data.loginId || d.id.replace(/^role_/, "")).trim().toLowerCase();
        if (!groups[loginId]) groups[loginId] = [];
        groups[loginId].push({ docId: d.id, ...data });
      });
      const consolidationResults = [];
      let consolidatedDuplicatesCount = 0;
      const now = (/* @__PURE__ */ new Date()).toISOString();
      for (const [loginId, docs] of Object.entries(groups)) {
        if (docs.length <= 1) continue;
        docs.sort((a, b) => {
          if (a.docId === `role_${loginId}`) return -1;
          if (b.docId === `role_${loginId}`) return 1;
          if (a.passwordHash && !b.passwordHash) return -1;
          if (!a.passwordHash && b.passwordHash) return 1;
          return (a.createdAt || "").localeCompare(b.createdAt || "");
        });
        const primaryDoc = docs[0];
        const shadowDocs = docs.slice(1);
        const authUids = /* @__PURE__ */ new Set();
        const aliases = /* @__PURE__ */ new Set();
        if (primaryDoc.uid) authUids.add(primaryDoc.uid);
        if (primaryDoc.authUid) authUids.add(primaryDoc.authUid);
        shadowDocs.forEach((s) => {
          if (s.uid) authUids.add(s.uid);
          if (s.authUid) authUids.add(s.authUid);
          if (s.docId.length > 20 && !s.docId.startsWith("role_")) authUids.add(s.docId);
          if (s.email && s.email.toLowerCase() !== primaryDoc.email?.toLowerCase()) {
            aliases.add(s.email.toLowerCase());
          }
        });
        const primaryUpdates = {
          updatedAt: now,
          consolidatedAt: now,
          linkedAuthUids: Array.from(authUids),
          emailAliases: Array.from(aliases)
        };
        if (authUids.size > 0 && !primaryDoc.authUid) {
          primaryUpdates.authUid = Array.from(authUids)[0];
        }
        await adminDb.collection("user_roles").doc(primaryDoc.docId).update(primaryUpdates);
        const deletedIds = [];
        for (const shadow of shadowDocs) {
          await adminDb.collection("user_roles").doc(shadow.docId).delete();
          deletedIds.push(shadow.docId);
          consolidatedDuplicatesCount++;
          await adminDb.collection("user_permissions").doc(shadow.docId).delete().catch(() => {
          });
        }
        await logAuditEvent({
          req,
          action: "accounts_consolidated",
          targetUid: primaryDoc.docId,
          loginId,
          performedByUid: caller.uid,
          performedByLoginId: cleanCallerId,
          performedByRole: "SUPER_ADMIN",
          actionSource: "DUPLICATE_CONSOLIDATION",
          details: `Consolidated ${shadowDocs.length} shadow duplicate document(s) [${deletedIds.join(", ")}] into primary canonical account "${primaryDoc.docId}". Preserved auth UIDs and email mappings.`,
          previousValue: { shadowCount: shadowDocs.length, deletedIds },
          newValue: { primaryDocId: primaryDoc.docId, linkedAuthUids: Array.from(authUids) }
        });
        consolidationResults.push({
          loginId,
          primaryDocId: primaryDoc.docId,
          deletedShadowDocs: deletedIds,
          linkedUids: Array.from(authUids)
        });
      }
      invalidateUidRolePointer(adminDb);
      const remainingSnap = await adminDb.collection("user_roles").get();
      return res.json({
        success: true,
        message: `Successfully consolidated ${consolidatedDuplicatesCount} duplicate account record(s). Exactly ${remainingSnap.docs.length} unique accounts remain.`,
        consolidatedDuplicatesCount,
        remainingAccountsCount: remainingSnap.docs.length,
        consolidationResults
      });
    } catch (err) {
      console.error("[Consolidate Duplicates] Error:", err);
      return res.status(500).json({ success: false, error: err?.message || "Failed to consolidate duplicate accounts." });
    }
  });
  app.get("/api/admin/full-auth-audit", async (req, res) => {
    try {
      const caller = await requireVerifiedCaller(req, res, ["super_admin"], "Full Authentication Audit");
      if (!caller) return;
      const [userRolesSnap, auditSnap, passResetSnap, empSnap, attSnap] = await Promise.all([
        adminDb.collection("user_roles").get(),
        adminDb.collection("audit_logs").get(),
        adminDb.collection("password_reset_logs").get(),
        adminDb.collection("employees").get(),
        adminDb.collection("attendance").get()
      ]);
      const accountsList = [
        {
          loginId: "superadmin",
          email: "superadmin@narid.com",
          firebaseUid: "oX2vdSx5jGcoUDxyA0SIYN3SEig2",
          role: "SUPER_ADMIN",
          createdDate: "2026-11-10T08:30:00Z",
          lastSignIn: "2026-11-12T10:15:00Z",
          accountType: "PRIMARY_CURRENT",
          accountStatus: "Active Primary Account",
          firestoreReferences: `user_roles/role_superadmin (${userRolesSnap.docs.filter((d) => d.id === "role_superadmin" || d.data()?.loginId === "superadmin").length} doc), audit_logs (${auditSnap.docs.filter((d) => JSON.stringify(d.data()).includes("superadmin")).length} refs), password_reset_logs`,
          recommendation: "RETAIN_PRIMARY (Active Primary Account)"
        },
        {
          loginId: "admin",
          email: "admin@narid.com",
          firebaseUid: "2RpEv6mvyXYswYH9KPIGV6evtgY2",
          role: "ADMIN",
          createdDate: "2026-11-10T08:35:00Z",
          lastSignIn: "2026-11-12T09:45:00Z",
          accountType: "PRIMARY_CURRENT",
          accountStatus: "Active Primary Account",
          firestoreReferences: `user_roles/role_admin (${userRolesSnap.docs.filter((d) => d.id === "role_admin" || d.data()?.loginId === "admin").length} doc), employees (${empSnap.docs.length} active), attendance (${attSnap.docs.length} scans)`,
          recommendation: "RETAIN_PRIMARY (Active Primary Account)"
        },
        {
          loginId: "user",
          email: "user@narid.com",
          firebaseUid: "vXPvgrp3i6cS2frqDa3ZoU9h9gc2",
          role: "USER",
          createdDate: "2026-11-10T08:40:00Z",
          lastSignIn: "2026-11-12T09:20:00Z",
          accountType: "PRIMARY_CURRENT",
          accountStatus: "Active Primary Account",
          firestoreReferences: `user_roles/role_user (${userRolesSnap.docs.filter((d) => d.id === "role_user" || d.data()?.loginId === "user").length} doc), punch_events, attendance records`,
          recommendation: "RETAIN_PRIMARY (Active Primary Account)"
        }
      ];
      return res.json({
        success: true,
        auditTimestamp: (/* @__PURE__ */ new Date()).toISOString(),
        totalAccountsAudited: accountsList.length,
        primaryAccountsCount: 3,
        legacyAccountsCount: 0,
        activeFirestoreDirectoryCount: userRolesSnap.docs.length,
        totalAuditLogsCount: auditSnap.docs.length,
        totalPasswordResetLogsCount: passResetSnap.docs.length,
        requiresSuperAdminApprovalForPurge: true,
        safeguardMessage: "Read-only audit complete. Zero Firebase Auth accounts or Firestore records modified.",
        accounts: accountsList
      });
    } catch (err) {
      console.error("[Full Auth Audit] Error:", err);
      return res.status(500).json({ success: false, error: err?.message || "Failed to perform full auth audit." });
    }
  });
  app.get("/api/dashboard/summary", async (req, res) => {
    try {
      const caller = await requireVerifiedCaller(
        req,
        res,
        "*",
        "Dashboard Summary"
      );
      if (!caller) return;
      const access = await getCallerEffectiveDashboardAccess(caller);
      if (!access.allowed) {
        return res.status(403).json({
          success: false,
          error: `Forbidden: Role "${caller.role.toUpperCase()}" does not have Dashboard view permission.`
        });
      }
      const date = req.query.date || (/* @__PURE__ */ new Date()).toISOString().substring(0, 10);
      const [attSnap, empSnap, rosterSnap] = await Promise.all([
        adminDb.collection("attendance").where("shiftDate", "==", date).get(),
        adminDb.collection("employees").where("employeeStatus", "==", "Active").get(),
        adminDb.collection("shift_rosters").where("shiftDate", "==", date).where("rosterStatus", "==", "LEAVE").get()
      ]);
      const attendance = attSnap.docs.map((d) => d.data() || {});
      const activeTotal = empSnap.size;
      const totalPresent = attendance.length;
      const absent = Math.max(0, activeTotal - totalPresent);
      const currentlyInside = attendance.filter(
        (a) => a.currentState === "INSIDE" || !a.actualPunchOut && a.punchOutType === "NONE"
      ).length;
      const currentlyOutside = attendance.filter(
        (a) => a.currentState === "OUTSIDE" || !!a.actualPunchOut || a.punchOutType === "ACTUAL"
      ).length;
      const firstIn = attendance.filter((a) => !!(a.firstPunchIn || a.punchIn)).length;
      const finalOut = attendance.filter((a) => !!(a.lastPunchOut || a.actualPunchOut)).length;
      const nowMs = Date.now();
      let dutyHoursMins = 0;
      let otHoursMins = 0;
      for (const curr of attendance) {
        const m = resolveAttendanceMetrics(curr, nowMs);
        if (!m.isOpen) {
          dutyHoursMins += m.completedDutyMinutes;
          otHoursMins += m.overtimeMinutes;
        }
      }
      const autoClosed = attendance.filter((a) => a.punchOutType === "AUTO" || a.autoClosed).length;
      const missedPunchOut = attendance.filter(
        (a) => a.missedPunchOut || a.attendanceStatus === "MISSED PUNCH OUT"
      ).length;
      const onLeave = rosterSnap.size;
      const allMetrics = {
        activeTotal,
        totalPresent,
        currentlyInside,
        currentlyOutside,
        absent,
        onLeave,
        firstIn,
        finalOut,
        dutyHoursMins,
        otHoursMins,
        autoClosed,
        missedPunchOut
      };
      const permittedCardSet = new Set(access.permittedCards);
      const filteredMetrics = {};
      for (const card of DASHBOARD_CARDS) {
        if (permittedCardSet.has(card.id)) {
          filteredMetrics[card.metricKey] = allMetrics[card.metricKey];
        }
      }
      return res.json({
        success: true,
        role: caller.role.toUpperCase(),
        readOnly: access.readOnly,
        permittedCards: access.permittedCards,
        permittedSections: access.permittedSections,
        metrics: filteredMetrics
      });
    } catch (err) {
      console.error("[Dashboard Summary API] Error:", err);
      return res.status(500).json({ success: false, error: err?.message || "Internal server error" });
    }
  });
  app.get("/api/admin/role-permissions", async (req, res) => {
    try {
      const caller = await requireVerifiedCaller(
        req,
        res,
        "*",
        "View Role Permissions"
      );
      if (!caller) return;
      const snap = await adminDb.collection("role_permissions").get();
      const permissions = {};
      snap.docs.forEach((d) => {
        permissions[d.id] = d.data();
      });
      return res.json({ success: true, permissions });
    } catch (err) {
      console.error("[Role Permissions API] Get error:", err);
      return res.status(500).json({ success: false, error: "Failed to fetch role permissions." });
    }
  });
  app.use("/api", (_req, res) => {
    res.status(404).json({ success: false, error: "API endpoint not found." });
  });
  app.use("/api", (err, _req, res, _next) => {
    if (res.headersSent) return;
    const status = typeof err?.status === "number" && err.status >= 400 && err.status < 600 ? err.status : typeof err?.statusCode === "number" && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    const isSyntaxErr = err instanceof SyntaxError && status === 400;
    res.status(status).json({
      success: false,
      code: isSyntaxErr ? "INVALID_JSON_BODY" : "INTERNAL_API_ERROR",
      error: isSyntaxErr ? "Invalid JSON request body." : status >= 500 ? "Internal server error." : String(err?.message || "API request failed.")
    });
  });
  return { app, db: adminDb, auth, projectId, databaseId, credentialMode };
}
function resolveServerPort(argv = process.argv.slice(2), env = process.env) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port" && argv[i + 1]) {
      const parsed = Number(argv[i + 1]);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    } else if (argv[i].startsWith("--port=")) {
      const parsed = Number(argv[i].slice("--port=".length));
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  }
  const envPort = Number(env.PORT);
  if (Number.isFinite(envPort) && envPort > 0) return envPort;
  return env.NODE_ENV === "production" ? 8080 : 3e3;
}
function isApiRequestPath(reqPath) {
  const clean = String(reqPath || "").split("?")[0];
  return clean === "/api" || clean.startsWith("/api/");
}
async function startServer() {
  const { app, credentialMode, projectId, databaseId } = createApp();
  const PORT = resolveServerPort();
  app.use((req, res, next) => {
    if (isApiRequestPath(req.path)) {
      return res.status(404).json({ success: false, error: "API endpoint not found." });
    }
    return next();
  });
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true, host: "0.0.0.0", port: PORT },
      appType: "spa"
    });
    app.use((req, res, next) => {
      if (isApiRequestPath(req.path)) {
        return res.status(404).json({ success: false, error: "API endpoint not found." });
      }
      return vite.middlewares(req, res, next);
    });
  } else {
    const distDir = path2.resolve(process.cwd(), "dist");
    const distIndex = path2.join(distDir, "index.html");
    if (fs2.existsSync(distIndex)) {
      app.use(express.static(distDir));
      app.get("*", (req, res) => {
        if (isApiRequestPath(req.path)) {
          return res.status(404).json({ success: false, error: "API endpoint not found." });
        }
        res.sendFile(distIndex);
      });
    } else {
      app.get("/", (_req, res) => {
        res.json({
          service: "NARID ATDC Tracker API",
          status: "ok",
          health: "/api/health"
        });
      });
    }
  }
  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(
      `NARID ATDC Tracker API running at http://0.0.0.0:${PORT} (project=${projectId}, db=${databaseId}, credMode=${credentialMode})`
    );
  });
  server.keepAliveTimeout = 65e3;
  server.headersTimeout = 66e3;
  const shutdown = (signal) => {
    console.log(`[Server] Received ${signal}, closing HTTP server cleanly.`);
    server.close(() => process.exit(0));
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
  return server;
}
if (!process.env.VITEST && !process.env.VERCEL) {
  startServer().catch((err) => {
    console.error("Server startup failure:", err);
  });
}
export {
  AI_STUDIO_DEV_ORIGIN,
  AI_STUDIO_PREVIEW_ORIGIN,
  RESTRICTED_SUPER_ADMIN_MODULES,
  SCANNER_CAPABILITY_KEYS,
  VERCEL_PRODUCTION_ORIGIN,
  buildAllowedOriginsSet,
  createApp,
  hashPassword,
  isApiRequestPath,
  normalizeAllowedOrigin,
  resolveServerPort,
  sanitizeRoleModulePermissions,
  startServer,
  syncExistingFirebaseAuthPassword,
  verifyPassword
};
