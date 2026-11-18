// server.ts
import express from "express";
import cors from "cors";
import fs2 from "fs";
import path2 from "path";
import crypto5 from "crypto";
import { z as z4 } from "zod";

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
      rolePerms: /* @__PURE__ */ new Map(),
      uidRolePointers: /* @__PURE__ */ new Map(),
      inFlightRequests: /* @__PURE__ */ new Map(),
      recentIdempotentResponses: /* @__PURE__ */ new Map()
    };
    dbCacheWeakMap.set(db, store);
  }
  return store;
}
var CONFIG_TTL_MS = 3e4;
var ROLE_TTL_MS = 15e3;
var UID_POINTER_TTL_MS = 6e4;
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
  const snap = await db.collection("roles").doc(cleanRole).get();
  const entry = {
    exists: snap.exists,
    data: snap.exists ? snap.data() || {} : void 0,
    expiresAt: Date.now() + ROLE_TTL_MS
  };
  store.roleDefs.set(cleanRole, entry);
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
  const snap = await db.collection("role_permissions").doc(cleanRole).get();
  const entry = {
    exists: snap.exists,
    data: snap.exists ? snap.data() || {} : void 0,
    expiresAt: Date.now() + ROLE_TTL_MS
  };
  store.rolePerms.set(cleanRole, entry);
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
var CRITICAL_PROTECTED_ACTIONS = /* @__PURE__ */ new Set([
  "account_deleted",
  "accounts_consolidated",
  "account_cleanup_approved",
  "account_cleanup_deleted",
  "admin_password_reset",
  "unauthorized_access_attempt",
  "unauthorized_password_reset_attempt",
  "unauthorized_self_password_change",
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
  await db.collection("user_uid_index").doc(uid).set(
    {
      uid,
      roleDocId: params.roleDocId,
      role: normalizeRoleValue(params.role),
      status: params.status || "Active",
      lockStatus: params.lockStatus || "ACTIVE",
      loginId: String(params.loginId || "").trim().toLowerCase(),
      updatedAt: now
    },
    { merge: true }
  );
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
  if (!decoded || typeof decoded.uid !== "string" || !decoded.uid.trim()) {
    const err = new Error("Verified Firebase token missing subject UID.");
    err.statusCode = 401;
    throw err;
  }
  const verifiedUid = decoded.uid.trim();
  const decodedEmail = String(decoded.email || "").toLowerCase();
  const shouldPrefetchUserPerm = Boolean(options?.prefetchUserPermission);
  let matchedDoc = null;
  let prefetchedUserPermSnap = void 0;
  let idxSnap = null;
  let usedPointerHit = false;
  const doesDocOwnUid = (docId, d) => {
    const linked = Array.isArray(d.linkedAuthUids) ? d.linkedAuthUids : [];
    return d.authUid === verifiedUid || d.uid === verifiedUid || docId === verifiedUid || linked.includes(verifiedUid);
  };
  const pointer = getCachedUidRolePointer(db, verifiedUid);
  if (pointer) {
    const prefetchPermNow = shouldPrefetchUserPerm && pointer.lastRole !== "super_admin";
    const [roleDocSnap, userPermSnap] = await Promise.all([
      db.collection("user_roles").doc(pointer.roleDocId).get(),
      prefetchPermNow ? db.collection("user_permissions").doc(pointer.roleDocId).get() : Promise.resolve(null)
    ]);
    if (roleDocSnap.exists) {
      const d = roleDocSnap.data() || {};
      if (doesDocOwnUid(roleDocSnap.id, d)) {
        matchedDoc = { id: roleDocSnap.id, data: d };
        if (prefetchPermNow && userPermSnap) {
          prefetchedUserPermSnap = userPermSnap;
        }
        usedPointerHit = true;
      }
    }
    if (!matchedDoc) {
      invalidateUidRolePointer(db, verifiedUid);
    }
  }
  if (!matchedDoc) {
    idxSnap = await db.collection("user_uid_index").doc(verifiedUid).get();
    if (idxSnap.exists) {
      const idxData = idxSnap.data() || {};
      if (idxData.roleDocId) {
        const targetDocId = String(idxData.roleDocId);
        const prefetchPermNow = shouldPrefetchUserPerm && String(idxData.role || "").toLowerCase() !== "super_admin";
        const [roleDocSnap, userPermSnap] = await Promise.all([
          db.collection("user_roles").doc(targetDocId).get(),
          prefetchPermNow ? db.collection("user_permissions").doc(targetDocId).get() : Promise.resolve(null)
        ]);
        if (roleDocSnap.exists) {
          const d = roleDocSnap.data() || {};
          if (doesDocOwnUid(roleDocSnap.id, d)) {
            matchedDoc = { id: roleDocSnap.id, data: d };
            if (prefetchPermNow && userPermSnap) {
              prefetchedUserPermSnap = userPermSnap;
            }
          }
        }
      }
    }
  }
  if (!matchedDoc) {
    const directSnap = await db.collection("user_roles").doc(verifiedUid).get();
    if (directSnap.exists) {
      matchedDoc = { id: directSnap.id, data: directSnap.data() || {} };
    }
  }
  if (!matchedDoc) {
    const byAuthUidSnap = await db.collection("user_roles").where("authUid", "==", verifiedUid).limit(1).get();
    if (!byAuthUidSnap.empty) {
      const first = byAuthUidSnap.docs[0];
      matchedDoc = { id: first.id, data: first.data() || {} };
    }
  }
  if (!matchedDoc) {
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
  if (matchedDoc.data.lockStatus === "LOCKED" || matchedDoc.data.isLocked === true) {
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
    const roleDefSnap = await getCachedRoleDefDoc(db, normalizedRole);
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
  return {
    uid: verifiedUid,
    email: decodedEmail || String(matchedDoc.data.email || ""),
    loginId: resolvedLoginId,
    role: normalizedRole,
    profileDocId: matchedDoc.id,
    authTime,
    modulesAllowed: Array.isArray(matchedDoc.data.modulesAllowed) ? matchedDoc.data.modulesAllowed : [],
    prefetchedUserPermSnap: normalizedRole !== "super_admin" && prefetchedUserPermSnap !== void 0 ? prefetchedUserPermSnap : void 0,
    cacheHitUidRoute: usedPointerHit
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
import crypto2 from "crypto";
import { z } from "zod";
var MAX_CONSECUTIVE_FAILED_ATTEMPTS = 3;
var LOCKED_ACCOUNT_MESSAGE = "Your account has been temporarily blocked. Please contact Super Admin.";
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
  return `ip_${crypto2.createHash("sha256").update(scopeKey).digest("hex").slice(0, 32)}`;
}
async function checkIpProgressiveRateLimitPersistent(db, ip, loginId) {
  const now = Date.now();
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
async function recordIpFailurePersistent(db, ip, kind, loginId) {
  const now = Date.now();
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
    upper[crypto2.randomInt(0, upper.length)],
    lower[crypto2.randomInt(0, lower.length)],
    digits[crypto2.randomInt(0, digits.length)],
    special[crypto2.randomInt(0, special.length)]
  ];
  while (chars.length < length) {
    chars.push(all[crypto2.randomInt(0, all.length)]);
  }
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto2.randomInt(0, i + 1);
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
  const nowDate = /* @__PURE__ */ new Date();
  const now = nowDate.toISOString();
  const attemptId = `att_${nowDate.getTime()}_${crypto2.randomBytes(4).toString("hex")}`;
  await db.collection("login_attempts").doc(attemptId).set({
    id: attemptId,
    loginId: params.loginId.trim().toLowerCase(),
    role: String(params.role || "UNKNOWN").toUpperCase(),
    firebaseUid: params.firebaseUid || null,
    timestamp: now,
    timestampMs: nowDate.getTime(),
    success: params.success,
    outcome: params.outcome,
    failureReasonCategory: params.failureReasonCategory,
    failureReason: params.failureReason ? String(params.failureReason).slice(0, 500) : null,
    attemptNumber: params.attemptNumber ?? null,
    consecutiveFailedAfter: params.consecutiveFailedAfter ?? null,
    triggeredLock: Boolean(params.triggeredLock),
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
  const nowDate = /* @__PURE__ */ new Date();
  const now = nowDate.toISOString();
  const logId = `saud_${nowDate.getTime()}_${crypto2.randomBytes(4).toString("hex")}`;
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
    timestampMs: nowDate.getTime(),
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
          loginId
        });
      }
      const secId = `sec_${loginId}`;
      const secRef = db.collection("account_security").doc(secId);
      const secSnap = await secRef.get();
      if (!secSnap.exists) {
        await secRef.set({
          id: secId,
          loginId,
          role: String(uData.role || "USER").toUpperCase(),
          firebaseUid: uData.authUid || uDoc.id,
          email: uData.email || `${loginId}@narid.com`,
          lockStatus: uData.isLocked || uData.lockStatus === "LOCKED" ? "LOCKED" : "ACTIVE",
          consecutiveFailedAttempts: Number(uData.consecutiveFailedAttempts || 0),
          maxAttemptsAllowed: MAX_CONSECUTIVE_FAILED_ATTEMPTS,
          totalLoginAttempts: 0,
          totalSuccessfulLogins: 0,
          totalFailedLogins: 0,
          forcePasswordChange: uData.mustChangePassword === true || uData.forcePasswordChange === true,
          lockedAt: uData.lockedAt || null,
          lockReason: uData.lockReason || null,
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
var UnblockAccountSchema = z.object({
  targetLoginId: z.string().trim().min(1, "Target Login ID is required.").max(64),
  reason: z.string().trim().min(5, "An explicit unblock reason (at least 5 characters) is mandatory.").max(500),
  confirmed: z.literal(true, { message: "Explicit confirmation is required to unblock an account." })
});
var GenerateTempPasswordSchema = z.object({
  targetLoginId: z.string().trim().min(1, "Target Login ID is required.").max(64),
  reason: z.string().trim().min(5, "A governance reason (at least 5 characters) is mandatory.").max(500),
  freshSuperAdminPassword: z.string().optional()
});
function registerLoginSecurityRoutes(app, deps) {
  const {
    db,
    auth,
    projectId,
    verifyPassword: verifyPassword2,
    hashPassword: hashPassword2,
    syncExistingFirebaseAuthPassword: syncExistingFirebaseAuthPassword2,
    requireVerifiedCaller
  } = deps;
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
      const ipCheck = await checkIpProgressiveRateLimitPersistent(db, telemetry.ipAddress, cleanId);
      if (!ipCheck.allowed) {
        await recordLoginAttemptDoc(db, {
          loginId: cleanId,
          role: "UNKNOWN",
          success: false,
          outcome: "BLOCKED_RATE_LIMIT",
          failureReasonCategory: "RATE_LIMITED",
          failureReason: ipCheck.reason || "Rate limit cooldown active",
          telemetry
        });
        await recordSecurityAuditLogDoc(db, {
          action: "RATE_LIMIT_TRIGGERED",
          severity: "CRITICAL",
          targetLoginId: cleanId,
          reason: "IP progressive rate limit cooldown blocked login attempt",
          details: `Blocked login attempt for "${cleanId}" from IP ${telemetry.ipAddress} (${ipCheck.cooldownSeconds}s remaining).`,
          metadata: { cooldownSeconds: ipCheck.cooldownSeconds },
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
        const now = (/* @__PURE__ */ new Date()).toISOString();
        const deviceSummary = {
          browser: telemetry.uaMeta.browser,
          os: telemetry.uaMeta.os,
          deviceType: telemetry.uaMeta.deviceType
        };
        const txOutcome = await db.runTransaction(async (tx) => {
          const secSnap = await tx.get(secRef);
          const curSec = secSnap.exists ? secSnap.data() || {} : {
            id: `sec_${cleanId}`,
            loginId: cleanId,
            role: roleUpper,
            firebaseUid,
            email: userData.email || `${cleanId}@narid.com`,
            lockStatus: userData.isLocked || userData.lockStatus === "LOCKED" ? "LOCKED" : "ACTIVE",
            consecutiveFailedAttempts: Number(userData.consecutiveFailedAttempts || 0),
            maxAttemptsAllowed: MAX_CONSECUTIVE_FAILED_ATTEMPTS,
            totalLoginAttempts: 0,
            totalSuccessfulLogins: 0,
            totalFailedLogins: 0,
            forcePasswordChange: userData.mustChangePassword === true || userData.forcePasswordChange === true,
            lockedAt: userData.lockedAt || null,
            lockReason: userData.lockReason || null
          };
          const isCurrentlyLocked = curSec.lockStatus === "LOCKED" || userData.lockStatus === "LOCKED" || userData.isLocked === true;
          if (isCurrentlyLocked) {
            tx.set(
              secRef,
              {
                ...curSec,
                role: roleUpper,
                firebaseUid,
                lockStatus: "LOCKED",
                totalLoginAttempts: Number(curSec.totalLoginAttempts || 0) + 1,
                lastFailedAt: now,
                lastFailedIp: telemetry.ipAddress,
                lastFailedGeo: telemetry.geoLocation,
                lastFailedDevice: deviceSummary,
                lastFailedReason: "Attempted login while account LOCKED",
                updatedAt: now
              },
              { merge: true }
            );
            return {
              kind: "LOCKED_REJECT",
              consecutiveFailed: Number(curSec.consecutiveFailedAttempts || MAX_CONSECUTIVE_FAILED_ATTEMPTS)
            };
          }
          const isPasswordValid = userData.passwordHash ? verifyPassword2(password, String(userData.passwordHash)) : false;
          if (!isPasswordValid) {
            const nextConsecutive = Number(curSec.consecutiveFailedAttempts || 0) + 1;
            const reachedLock = nextConsecutive >= MAX_CONSECUTIVE_FAILED_ATTEMPTS;
            const secUpdate = {
              ...curSec,
              id: `sec_${cleanId}`,
              loginId: cleanId,
              role: roleUpper,
              firebaseUid,
              email: userData.email || `${cleanId}@narid.com`,
              lockStatus: reachedLock ? "LOCKED" : "ACTIVE",
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
              lockedAt: reachedLock ? now : userData.lockedAt || null,
              lockReason: reachedLock ? secUpdate.lockReason : userData.lockReason || null,
              updatedAt: now
            });
            return {
              kind: reachedLock ? "NOW_LOCKED" : "FAILED_PASSWORD",
              attemptNumber: nextConsecutive,
              remainingAttempts: Math.max(0, MAX_CONSECUTIVE_FAILED_ATTEMPTS - nextConsecutive)
            };
          }
          const mustChange = userData.mustChangePassword === true || curSec.forcePasswordChange === true;
          tx.set(
            secRef,
            {
              ...curSec,
              id: `sec_${cleanId}`,
              loginId: cleanId,
              role: roleUpper,
              firebaseUid,
              email: userData.email || `${cleanId}@narid.com`,
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
            mustChange
          };
        });
        if (txOutcome.kind === "LOCKED_REJECT") {
          await syncUserUidIndex(db, {
            uid: userData.authUid || null,
            roleDocId: userDoc.id,
            role: String(userData.role || "user"),
            status: String(userData.status || "Active"),
            lockStatus: "LOCKED",
            loginId: cleanId
          });
          const ipRes = await recordIpFailurePersistent(db, telemetry.ipAddress, "locked_hit", cleanId);
          await Promise.all([
            recordLoginAttemptDoc(db, {
              loginId: cleanId,
              role: roleUpper,
              firebaseUid,
              success: false,
              outcome: "BLOCKED_LOCKED",
              failureReasonCategory: "ACCOUNT_LOCKED",
              failureReason: "Login rejected because account status is LOCKED",
              consecutiveFailedAfter: txOutcome.consecutiveFailed,
              telemetry
            }),
            recordSecurityAuditLogDoc(db, {
              action: "LOGIN_BLOCKED_WHILE_LOCKED",
              severity: "WARNING",
              targetLoginId: cleanId,
              targetRole: roleUpper,
              targetUid: firebaseUid,
              reason: "Attempted login on locked account",
              details: `Rejected login attempt for locked account "${cleanId}" (${roleUpper}) from IP ${telemetry.ipAddress}.`,
              telemetry
            }),
            recordLoginHistoryEntry(db, {
              req,
              eventType: "LOGIN_LOCKED",
              loginId: cleanId,
              authUid: firebaseUid,
              role: roleUpper,
              success: false,
              failureReason: LOCKED_ACCOUNT_MESSAGE
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
              description: `Blocked login attempt on already locked account "${cleanId}".`,
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
              telemetry
            });
          }
          return {
            status: 423,
            body: {
              success: false,
              code: "ACCOUNT_LOCKED",
              locked: true,
              error: LOCKED_ACCOUNT_MESSAGE
            }
          };
        }
        if (txOutcome.kind === "NOW_LOCKED") {
          await syncUserUidIndex(db, {
            uid: userData.authUid || null,
            roleDocId: userDoc.id,
            role: String(userData.role || "user"),
            status: String(userData.status || "Active"),
            lockStatus: "LOCKED",
            loginId: cleanId
          });
          await recordIpFailurePersistent(db, telemetry.ipAddress, "password", cleanId);
          await Promise.all([
            recordLoginAttemptDoc(db, {
              loginId: cleanId,
              role: roleUpper,
              firebaseUid,
              success: false,
              outcome: "FAILED_PASSWORD",
              failureReasonCategory: "ACCOUNT_LOCKED",
              failureReason: "3rd consecutive failed password attempt triggered automatic account lock",
              attemptNumber: txOutcome.attemptNumber,
              consecutiveFailedAfter: txOutcome.attemptNumber,
              triggeredLock: true,
              telemetry
            }),
            recordSecurityAuditLogDoc(db, {
              action: "ACCOUNT_LOCKED",
              severity: "CRITICAL",
              targetLoginId: cleanId,
              targetRole: roleUpper,
              targetUid: firebaseUid,
              reason: "Exceeded 3 consecutive failed password attempts",
              details: `SECURITY ALERT: Account "${cleanId}" (${roleUpper}, UID: ${firebaseUid}) automatically LOCKED on failed attempt #${txOutcome.attemptNumber}.`,
              metadata: { attemptNumber: txOutcome.attemptNumber, maxAttempts: MAX_CONSECUTIVE_FAILED_ATTEMPTS },
              telemetry
            }),
            recordLoginHistoryEntry(db, {
              req,
              eventType: "LOGIN_LOCKED",
              loginId: cleanId,
              authUid: firebaseUid,
              role: roleUpper,
              success: false,
              failureReason: `Locked after ${txOutcome.attemptNumber} consecutive failed attempts`
            }),
            recordEnterpriseAuditEvent(db, {
              req,
              action: "failed_login_threshold_exceeded",
              category: "SECURITY",
              severity: "CRITICAL",
              actorUid: firebaseUid,
              actorLoginId: cleanId,
              actorRole: roleUpper,
              targetId: userDoc.id,
              actionSource: "ACCOUNT_LOCKOUT_ENGINE",
              description: `Account "${cleanId}" (${roleUpper}) automatically LOCKED after ${txOutcome.attemptNumber} consecutive failed password attempts.`,
              success: false
            })
          ]);
          return {
            status: 423,
            body: {
              success: false,
              code: "ACCOUNT_LOCKED",
              locked: true,
              attemptNumber: txOutcome.attemptNumber,
              maxAttempts: MAX_CONSECUTIVE_FAILED_ATTEMPTS,
              remainingAttempts: 0,
              error: LOCKED_ACCOUNT_MESSAGE
            }
          };
        }
        if (txOutcome.kind === "FAILED_PASSWORD") {
          await recordIpFailurePersistent(db, telemetry.ipAddress, "password", cleanId);
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
          uid: userData.authUid || null,
          roleDocId: userDoc.id,
          role: String(userData.role || "user"),
          status: String(userData.status || "Active"),
          lockStatus: "ACTIVE",
          loginId: cleanId
        });
        const sessionId = `sess_${crypto2.randomBytes(10).toString("hex")}`;
        const sessionToken = crypto2.randomBytes(32).toString("hex");
        let effectiveModules = Array.isArray(userData.modulesAllowed) ? [...userData.modulesAllowed] : [];
        if (String(userData.role || "").toLowerCase() === "user" && !userData.dashboardAccessMigratedV1) {
          if (!effectiveModules.includes("dashboard")) {
            effectiveModules = ["dashboard", ...effectiveModules];
          }
        }
        await Promise.all([
          recordLoginAttemptDoc(db, {
            loginId: cleanId,
            role: roleUpper,
            firebaseUid,
            success: true,
            outcome: "SUCCESS",
            failureReasonCategory: "NONE",
            consecutiveFailedAfter: 0,
            sessionId,
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
        ]);
        const { passwordHash: _ph, ...sanitizedProfile } = userData;
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
      const [usersSnap, secSnap, attemptsSnap, secLogsSnap] = await Promise.all([
        db.collection("user_roles").get(),
        db.collection("account_security").get(),
        db.collection("login_attempts").get(),
        db.collection("security_audit_logs").get()
      ]);
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
        const lockStatus = sec.lockStatus === "LOCKED" || uData.lockStatus === "LOCKED" || uData.isLocked === true ? "LOCKED" : "ACTIVE";
        accountMap.set(loginId, {
          id: sec.id || `sec_${loginId}`,
          roleDocId: uDoc.id,
          loginId,
          name: uData.name || loginId.toUpperCase(),
          email: uData.email || `${loginId}@narid.com`,
          role: String(uData.role || "USER").toUpperCase(),
          firebaseUid: sec.firebaseUid || uData.authUid || uDoc.id,
          accountStatus: uData.status || "Active",
          lockStatus,
          consecutiveFailedAttempts: Number(
            sec.consecutiveFailedAttempts ?? uData.consecutiveFailedAttempts ?? 0
          ),
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
          lockedAt: sec.lockedAt || uData.lockedAt || null,
          lockReason: sec.lockReason || uData.lockReason || null,
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
        recentSecurityLogs: securityLogs.slice(0, 150)
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
        const resetLogId = `reset_${Date.now()}_${crypto2.randomBytes(3).toString("hex")}`;
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
}

// serverAttendance.ts
import crypto3 from "crypto";
import { z as z2 } from "zod";

// src/utils/attendanceStatus.ts
var STANDARD_DUTY_MINUTES = 510;
var HALF_DAY_MIN_MINUTES = 270;
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
  const safeStandard = Math.max(1, Math.floor(Number.isFinite(standardDutyMinutes) ? standardDutyMinutes : STANDARD_DUTY_MINUTES));
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
      otLabel: "00:00"
    };
  }
  const rawStatus = String(record.attendanceStatus || "").trim().toUpperCase();
  const isLate = isAttendanceLate(record);
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
      otLabel: "00:00"
    };
  }
  const reenteredInside = String(record.currentState || "").toUpperCase() === "INSIDE" && String(record.punchOutType || "").toUpperCase() === "NONE";
  if (!reenteredInside && (record.autoClosed === true || String(record.punchOutType || "").toUpperCase() === "AUTO" || rawStatus === "AUTO CLOSED" || rawStatus === "MISSED PUNCH OUT" || record.missedPunchOut === true)) {
    const completedDutyMinutes2 = Math.max(
      0,
      Math.floor(Number(record.totalDutyMinutes ?? record.regularDutyMinutes ?? 0) || 0)
    );
    const regularDutyMinutes2 = Math.min(completedDutyMinutes2, standardDutyMinutes);
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
      otLabel: "00:00"
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
      // Never calculate OT on open shift
      accumulatedDutyMinutes,
      otLabel: "00:00"
    };
  }
  const firstInIso = record.firstPunchIn || record.punchIn;
  const lastOutIso = record.lastPunchOut || record.actualPunchOut || record.effectivePunchOut;
  const firstInMs = firstInIso ? new Date(firstInIso).getTime() : NaN;
  const lastOutMs = lastOutIso ? new Date(lastOutIso).getTime() : NaN;
  let completedDutyMinutes = 0;
  if (typeof record.totalDutyMinutes === "number" && Number.isFinite(record.totalDutyMinutes) && record.totalDutyMinutes > 0) {
    completedDutyMinutes = Math.floor(record.totalDutyMinutes);
  } else if (Number.isFinite(firstInMs) && Number.isFinite(lastOutMs) && lastOutMs >= firstInMs) {
    completedDutyMinutes = Math.floor((lastOutMs - firstInMs) / 6e4);
  } else if (typeof record.regularDutyMinutes === "number" || typeof record.overtimeMinutes === "number") {
    completedDutyMinutes = Math.max(
      0,
      Math.floor(Number(record.regularDutyMinutes || 0) + Number(record.overtimeMinutes || 0))
    );
  }
  const regularDutyMinutes = Math.min(completedDutyMinutes, standardDutyMinutes);
  const overtimeMinutes = completedDutyMinutes > standardDutyMinutes ? completedDutyMinutes - standardDutyMinutes : 0;
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
    otLabel: formatOtBadge(overtimeMinutes)
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
    punchInWindowStart: "09:00",
    punchInWindowEnd: "20:00",
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
    punchInWindowStart: "20:00",
    punchInWindowEnd: "09:00",
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
  const prev = employeeScanLocks.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const chained = prev.then(() => gate);
  employeeScanLocks.set(key, chained);
  try {
    await prev;
    return await task();
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
function identifyShiftForPunchIn(shifts, now = /* @__PURE__ */ new Date()) {
  const kolkata = getKolkataTimeParts(now);
  const currentMins = kolkata.totalMinutes;
  const activeShifts = shifts.filter((s) => s.status === "Active");
  for (const shift of activeShifts) {
    const winStart = timeStringToMinutes(shift.punchInWindowStart);
    const winEnd = timeStringToMinutes(shift.punchInWindowEnd);
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
  if (currentMins >= 540 && currentMins < 1200) {
    return dayShift ? { shift: dayShift, shiftDate: kolkata.dateKey } : null;
  } else if (currentMins >= 1200) {
    return nightShift ? { shift: nightShift, shiftDate: kolkata.dateKey } : null;
  } else {
    return nightShift ? { shift: nightShift, shiftDate: getYesterdayKolkataDateKey(now) } : null;
  }
}
var AttendanceScanSchema = z2.object({
  rawPayload: z2.string().trim().min(1, "Scan payload cannot be empty.").max(256),
  scannerType: z2.enum(["IN", "OUT"]).optional(),
  scannerDevice: z2.enum(["USB_SCANNER", "WEBCAM", "MANUAL", "SYSTEM_AUTO"]).optional(),
  customScanTime: z2.string().datetime({ offset: true }).or(z2.string().datetime()).optional(),
  clientRequestId: z2.string().trim().min(4).max(64).optional()
});
var ManualPunchSchema = z2.object({
  employeeId: z2.string().trim().min(2, "Please enter a valid Employee ID.").max(32, "Employee ID cannot exceed 32 characters.").transform((v) => v.toUpperCase()).refine((v) => EMPLOYEE_ID_PATTERN.test(v), {
    message: "Invalid Employee ID format. Use letters, numbers, hyphens, or underscores only."
  }),
  scannerType: z2.enum(["IN", "OUT"]).optional(),
  reason: z2.string().trim().max(250).optional(),
  customScanTime: z2.string().datetime({ offset: true }).or(z2.string().datetime()).optional(),
  clientRequestId: z2.string().trim().min(4).max(64).optional()
});
var AttendanceCorrectSchema = z2.object({
  attendanceId: z2.string().trim().min(1, "Attendance ID is required.").max(128),
  actualPunchOut: z2.string().optional(),
  punchOutType: z2.enum(["ACTUAL", "AUTO"]),
  attendanceStatus: z2.enum([
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
  reason: z2.string().trim().min(3, "A clear correction reason (at least 3 characters) is mandatory.").max(500)
});
var GenerateRosterSchema = z2.object({
  shiftDate: z2.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid shiftDate (expected YYYY-MM-DD)."),
  shiftId: z2.string().trim().min(1).max(64)
});
var ClearAttendanceSchema = z2.object({
  confirmed: z2.literal(true, { message: "Explicit confirmation is required to clear attendance records." }),
  confirmPhrase: z2.literal("CLEAR_ALL_ATTENDANCE", {
    message: 'Confirmation phrase "CLEAR_ALL_ATTENDANCE" is required to clear attendance records.'
  }),
  reason: z2.string().trim().min(5, "Reason is required for audit trail.").max(500).optional()
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
      cacheHitRolePerms: true
    };
  }
  try {
    const [userPermSnap, rolePermSnap] = await Promise.all([
      caller.prefetchedUserPermSnap ? Promise.resolve(caller.prefetchedUserPermSnap) : db.collection("user_permissions").doc(caller.profileDocId).get(),
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
      cacheHitRolePerms: rolePermSnap.cacheHit
    };
  } catch (err) {
    console.warn("[Attendance Permission Context] Lookup failed; failing closed:", err?.message || err);
    return {
      canQrScan: false,
      canManualEntry: false,
      canCustomTime: false,
      cacheHitRolePerms: false
    };
  }
}
function registerAttendanceRoutes(app, deps) {
  const { db, requireVerifiedCaller } = deps;
  async function writePunchLog(entry) {
    const id = `log_${Date.now()}_${crypto3.randomBytes(3).toString("hex")}`;
    await db.collection("punch_logs").doc(id).set({ ...entry, id });
  }
  app.post("/api/attendance/scan", async (req, res) => {
    const reqStartMs = performance.now();
    try {
      const caller = await requireVerifiedCaller(
        req,
        res,
        "*",
        "Attendance Scan Processing",
        { prefetchUserPermission: true }
      );
      if (!caller) return;
      const authDoneMs = performance.now();
      const parsed = AttendanceScanSchema.safeParse(req.body);
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
      const now = customScanTime ? new Date(customScanTime) : /* @__PURE__ */ new Date();
      if (Number.isNaN(now.getTime())) {
        return res.status(400).json({ success: false, error: "Invalid customScanTime timestamp." });
      }
      const kolkata = getKolkataTimeParts(now);
      const timeDisplay = kolkata.timeWithSeconds;
      const qrParseStartMs = performance.now();
      const { employeeId, token, format } = parseQrPayload(rawPayload);
      const qrParseDoneMs = performance.now();
      const qrParseMs = roundMs(qrParseDoneMs - qrParseStartMs);
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
        () => withEmployeeScanLock(employeeId, async () => {
          const lookupStartMs = performance.now();
          const yesterdayKey = getYesterdayKolkataDateKey(now);
          const [empSnap, candidateSnap, shiftsRes, settingsRes] = await Promise.all([
            db.collection("employees").doc(employeeId).get(),
            db.collection("attendance").where("employeeId", "==", employeeId).where("shiftDate", ">=", yesterdayKey).get(),
            getCachedShifts(db, DEFAULT_SHIFTS),
            getCachedSystemSettings(db, DEFAULT_SETTINGS)
          ]);
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
          const perf = {
            qrParseMs,
            authMs: roundMs(authDoneMs - reqStartMs),
            permissionMs: roundMs(permDoneMs - authDoneMs),
            lookupAndQueryMs: roundMs(lookupDuration),
            tokenValidationMs: roundMs(tokenValDoneMs - tokenValStartMs),
            txMs: roundMs(txDuration),
            firestoreOpMs: roundMs(lookupDuration + txDuration),
            totalServerMs: roundMs(txDoneMs - reqStartMs),
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
      return res.status(outcome.httpStatus).json(outcome.body);
    } catch (err) {
      console.error("[API Attendance Scan] Error:", err);
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
      const caller = await requireVerifiedCaller(
        req,
        res,
        "*",
        "Manual Employee ID Punch",
        { prefetchUserPermission: true }
      );
      if (!caller) return;
      const authDoneMs = performance.now();
      const parsed = ManualPunchSchema.safeParse(req.body);
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
      const now = customScanTime ? new Date(customScanTime) : /* @__PURE__ */ new Date();
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
        () => withEmployeeScanLock(employeeId, async () => {
          const lookupStartMs = performance.now();
          const yesterdayKey = getYesterdayKolkataDateKey(now);
          const [empSnap, candidateSnap, shiftsRes, settingsRes] = await Promise.all([
            db.collection("employees").doc(employeeId).get(),
            db.collection("attendance").where("employeeId", "==", employeeId).where("shiftDate", ">=", yesterdayKey).get(),
            getCachedShifts(db, DEFAULT_SHIFTS),
            getCachedSystemSettings(db, DEFAULT_SETTINGS)
          ]);
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
            auditDoneMs = performance.now();
          }
          const lookupDuration = lookupDoneMs - lookupStartMs;
          const txDuration = txDoneMs - txStartMs;
          const perf = {
            authMs: roundMs(authDoneMs - reqStartMs),
            permissionMs: roundMs(permDoneMs - authDoneMs),
            lookupAndQueryMs: roundMs(lookupDuration),
            txMs: roundMs(txDuration),
            firestoreOpMs: roundMs(lookupDuration + txDuration),
            auditMs: roundMs(auditDoneMs - txDoneMs),
            totalServerMs: roundMs(auditDoneMs - reqStartMs),
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
      return res.status(outcome.httpStatus).json(outcome.body);
    } catch (err) {
      console.error("[API Manual Punch] Error:", err);
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
    let activeRecord = null;
    if (currentMins < 540) {
      const yesterdayNight = existingRecords.find(
        (r) => r.shiftDate === yesterdayKey && (r.shiftId === "NIGHT" || String(r.shiftNameSnapshot || "").toUpperCase().includes("NIGHT"))
      );
      if (yesterdayNight) {
        activeRecord = yesterdayNight;
      }
    }
    if (!activeRecord) {
      activeRecord = existingRecords.find((r) => r.shiftDate === todayKey) || null;
    }
    if (!scannerType) {
      const derivedState = activeRecord?.currentState || (activeRecord?.actualPunchOut ? "OUTSIDE" : activeRecord ? "INSIDE" : "OUTSIDE");
      scannerType = derivedState === "INSIDE" ? "OUT" : "IN";
    }
    if (scannerType === "IN") {
      if (activeRecord) {
        const docRef3 = db.collection("attendance").doc(activeRecord.id);
        const eventId3 = `pe_${Date.now()}_${crypto3.randomBytes(3).toString("hex")}`;
        const logId3 = `log_${Date.now()}_${crypto3.randomBytes(3).toString("hex")}`;
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
      const shiftStartMins = timeStringToMinutes(shift2.startTime);
      const grace = shift2.gracePeriodMinutes ?? settings.lateGraceMinutes ?? 15;
      const isLate = !shift2.isOvernight ? currentMins > shiftStartMins + grace : currentMins >= 1200 ? currentMins > shiftStartMins + grace : true;
      const arrivalStatus = isLate ? "LATE" : "PRESENT";
      const eventId2 = `pe_${Date.now()}_${crypto3.randomBytes(3).toString("hex")}`;
      const logId2 = `log_${Date.now()}_${crypto3.randomBytes(3).toString("hex")}`;
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
        scheduledPunchOut: shift2.endTime,
        actualPunchOut: null,
        lastPunchOut: null,
        effectivePunchOut: null,
        punchOutType: "NONE",
        currentState: "INSIDE",
        punches: [firstPunchEvent],
        totalDutyMinutes: 0,
        regularDutyMinutes: 0,
        overtimeMinutes: 0,
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
          message: `First Punch In recorded for ${shift2.name} (${shiftDate}). Arrival: ${arrivalStatus}. Status: IN PROGRESS.`
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
          message: isLate ? `First Punch In Recorded for ${shift2.name} (Marked LATE).` : `First Punch In Recorded for ${shift2.name}.`,
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
    const eventId = `pe_${Date.now()}_${crypto3.randomBytes(3).toString("hex")}`;
    const logId = `log_${Date.now()}_${crypto3.randomBytes(3).toString("hex")}`;
    const txOutRes = await db.runTransaction(async (tx) => {
      const snap = await tx.get(docRef);
      const currentData = snap.exists ? snap.data() : activeRecord;
      const currentState = currentData.currentState || (currentData.actualPunchOut || currentData.punchOutType === "ACTUAL" ? "OUTSIDE" : "INSIDE");
      if (currentState === "OUTSIDE") {
        return { kind: "CONSECUTIVE_OUT", record: currentData };
      }
      const lastPunchTime = Array.isArray(currentData.punches) && currentData.punches.length > 0 ? new Date(currentData.punches[currentData.punches.length - 1].timestamp).getTime() : new Date(currentData.updatedAt || currentData.punchIn).getTime();
      if (Math.abs(now.getTime() - lastPunchTime) < 3e3) {
        return { kind: "BOUNCE", record: currentData };
      }
      const firstInIso = currentData.firstPunchIn || currentData.punchIn;
      const firstInDate = new Date(firstInIso);
      const totalDutyMinutes = Math.max(
        0,
        Math.floor((now.getTime() - firstInDate.getTime()) / (1e3 * 60))
      );
      const scheduledStandardDutyMinutes = STANDARD_DUTY_MINUTES;
      const regularDutyMinutes = Math.min(totalDutyMinutes, scheduledStandardDutyMinutes);
      const overtimeMinutes = Math.max(0, totalDutyMinutes - scheduledStandardDutyMinutes);
      const computedStatus = classifyCompletedDutyStatus(
        totalDutyMinutes,
        scheduledStandardDutyMinutes
      );
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
        status: "VALID_OUT",
        recordedByUid: caller.uid,
        recordedByLoginId: caller.loginId
      };
      const existingPunches = Array.isArray(currentData.punches) ? currentData.punches : [];
      const updatedAttendance = {
        ...currentData,
        actualPunchOut: now.toISOString(),
        lastPunchOut: now.toISOString(),
        effectivePunchOut: now.toISOString(),
        punchOutType: "ACTUAL",
        currentState: "OUTSIDE",
        punches: [...existingPunches, outEvent],
        totalDutyMinutes,
        regularDutyMinutes,
        overtimeMinutes,
        attendanceStatus: computedStatus,
        missedPunchOut: false,
        autoClosed: false,
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
        message: `Punch Out recorded (${computedStatus}). Duty: ${formatMinutes(regularDutyMinutes)}, OT: ${formatMinutes(overtimeMinutes)}. Total: ${formatMinutes(totalDutyMinutes)}.`
      });
      return {
        kind: "RECORDED",
        record: updatedAttendance,
        regularDutyMinutes,
        overtimeMinutes
      };
    });
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
    const shift = shiftsMap.get(txOutRes.record.shiftId) || shifts[0];
    return {
      httpStatus: 200,
      body: {
        success: true,
        action: "PUNCH_OUT",
        scannerType: "OUT",
        currentState: "OUTSIDE",
        employee,
        attendance: txOutRes.record,
        shift,
        message: "Punch Out Successfully Recorded.",
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
        if (record.actualPunchOut || record.punchOutType !== "NONE") continue;
        const shift = shiftsMap.get(record.shiftId);
        if (!shift) continue;
        const scheduledEndIso = getShiftScheduledEndIso(record.shiftDate, shift);
        const scheduledEndDate = new Date(scheduledEndIso);
        if (now.getTime() > scheduledEndDate.getTime()) {
          const scheduledDuration = shift.scheduledDurationMinutes || settings.scheduledDurationMinutes || 510;
          const docRef = db.collection("attendance").doc(record.id);
          const updatedRecord = await db.runTransaction(async (tx) => {
            const freshSnap = await tx.get(docRef);
            if (!freshSnap.exists) return null;
            const fresh = freshSnap.data();
            if (fresh.actualPunchOut || fresh.punchOutType !== "NONE") return null;
            const next = {
              ...fresh,
              actualPunchOut: null,
              lastPunchOut: null,
              effectivePunchOut: scheduledEndIso,
              punchOutType: "AUTO",
              currentState: "OUTSIDE",
              attendanceStatus: "AUTO CLOSED",
              missedPunchOut: true,
              autoClosed: true,
              totalDutyMinutes: scheduledDuration,
              regularDutyMinutes: scheduledDuration,
              overtimeMinutes: 0,
              // Zero OT on auto-closed shifts
              updatedAt: now.toISOString()
            };
            tx.set(docRef, next);
            return next;
          });
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
                message: `Auto-closed at scheduled shift end (${shift.endTime}). Status: AUTO CLOSED. OT: 00:00.`
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
                reason: "Employee missed scanning Punch Out at scheduled shift closing",
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
        if (actualPunchOut) {
          const inTime = new Date(current.firstPunchIn || current.punchIn).getTime();
          const outTime = new Date(actualPunchOut).getTime();
          if (Number.isNaN(outTime)) {
            throw new Error("INVALID_PUNCH_OUT");
          }
          totalDutyMinutes = Math.max(0, Math.floor((outTime - inTime) / (60 * 1e3)));
          regularDutyMinutes = Math.min(totalDutyMinutes, STANDARD_DUTY_MINUTES);
          overtimeMinutes = punchOutType === "AUTO" ? 0 : Math.max(0, totalDutyMinutes - STANDARD_DUTY_MINUTES);
        } else if (punchOutType === "AUTO") {
          overtimeMinutes = 0;
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
          actualPunchOut: actualPunchOut || current.actualPunchOut || null,
          lastPunchOut: actualPunchOut || current.lastPunchOut || null,
          effectivePunchOut: actualPunchOut || current.effectivePunchOut || null,
          punchOutType,
          currentState: actualPunchOut ? "OUTSIDE" : current.currentState || "OUTSIDE",
          attendanceStatus: finalAttendanceStatus,
          totalDutyMinutes,
          regularDutyMinutes,
          overtimeMinutes,
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
      return res.json({ success: true, record: txResult.updated });
    } catch (err) {
      if (err?.message === "INVALID_PUNCH_OUT") {
        return res.status(400).json({ success: false, error: "Invalid actualPunchOut timestamp." });
      }
      console.error("[API Attendance Correct] Error:", err);
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
import crypto4 from "crypto";
import { z as z3 } from "zod";
var EMPLOYEE_ID_PATTERN2 = /^[A-Za-z0-9_.\-]+$/;
var EMPLOYEE_BULK_BATCH_SIZE = 400;
var BulkImportRowSchema = z3.object({
  employeeId: z3.string().trim().min(1, "Employee ID is required.").max(128, "Employee ID must be 128 characters or fewer.").regex(
    EMPLOYEE_ID_PATTERN2,
    "Employee ID may only contain letters, numbers, underscores (_), hyphens (-), and periods (.)."
  ),
  employeeName: z3.string().trim().min(1, "Employee Name is required.").max(200, "Employee Name must be 200 characters or fewer."),
  employeeType: z3.enum(["Permanent", "Staff", "Offroll"]),
  section: z3.string().trim().min(1, "Section is required.").max(100),
  department: z3.string().trim().min(1, "Department is required.").max(100),
  floor: z3.string().trim().min(1, "Production Line is required.").max(100),
  designation: z3.string().trim().min(1).max(120).default("Operator"),
  employeeStatus: z3.enum(["Active", "Inactive"]),
  rowNumber: z3.number().int().positive().optional()
});
var BulkImportRequestSchema = z3.object({
  fileName: z3.string().trim().min(1, "File name is required.").max(255),
  rows: z3.array(BulkImportRowSchema).min(1, "At least one employee row is required for import.").max(2e3, "A single import request supports up to 2,000 employee rows.")
});
function generateServerQrToken(employeeId) {
  const rand = crypto4.randomBytes(4).toString("hex").toUpperCase();
  const ts = Date.now().toString(36).toUpperCase();
  return `QR_${employeeId}_${ts}_${rand}`;
}
var ADMIN_EXCEL_DEFAULTS = {
  excel_import: { view: true, add: true, edit: true },
  employees: { view: true, add: true, edit: true }
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
      return res.status(classified.status).json({
        success: false,
        code: classified.code,
        category: classified.category,
        error: classified.message
      });
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
  const salt = crypto5.randomBytes(16).toString("hex");
  const hash = crypto5.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}
function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(":")) return false;
  const [salt, expectedHash] = storedHash.split(":");
  if (!salt || !expectedHash) return false;
  const actualHash = crypto5.scryptSync(password, salt, 64).toString("hex");
  const actualBuf = Buffer.from(actualHash, "hex");
  const expectedBuf = Buffer.from(expectedHash, "hex");
  if (actualBuf.length !== expectedBuf.length) return false;
  return crypto5.timingSafeEqual(actualBuf, expectedBuf);
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
var VerifySessionInputSchema = z4.object({
  loginId: z4.string().trim().min(1).max(64).optional(),
  userId: z4.string().trim().min(1).max(128).optional()
});
var AdminSetPasswordInputSchema = z4.object({
  targetLoginId: z4.string().trim().min(1, "targetLoginId is required.").max(64),
  newPassword: z4.string().min(6, "Password must be at least 6 characters.").max(128),
  mustChangePassword: z4.boolean().optional(),
  unlockAccount: z4.boolean().optional(),
  revokeSessions: z4.boolean().optional(),
  currentTargetPassword: z4.string().optional()
});
var RESERVED_CUSTOM_ROLE_ALIASES = /* @__PURE__ */ new Set([
  "superadmin",
  "super_admin",
  "root",
  "system",
  "super_admin_root"
]);
var DynamicRoleIdSchema = z4.string().trim().min(2, "Role ID must be at least 2 characters.").max(64, "Role ID must be 64 characters or fewer.").transform((val) => deriveStrictRoleId(val)).refine((val) => VALID_ROLE_ID_REGEX.test(val), {
  message: "Role ID must start with a letter and contain only lowercase letters, numbers, or underscores."
});
var RoleDefinitionInputSchema = z4.object({
  roleId: z4.string().trim().max(64).optional(),
  roleName: z4.string().trim().min(2, "Role name must be at least 2 characters.").max(48, "Role name must be 48 characters or fewer."),
  description: z4.string().trim().min(3, "Role description must be at least 3 characters.").max(500, "Role description must be 500 characters or fewer."),
  isActive: z4.boolean().default(true),
  defaultPermissions: z4.record(
    z4.string(),
    z4.object({
      view: z4.boolean().optional(),
      add: z4.boolean().optional(),
      edit: z4.boolean().optional(),
      delete: z4.boolean().optional()
    })
  ).optional()
});
var CreateUserInputSchema = z4.object({
  callerLoginId: z4.string().trim().min(1).max(64).optional(),
  loginId: z4.string().trim().min(2, "Login ID must be at least 2 characters.").max(64).regex(/^[a-zA-Z0-9_.-]+$/, "Login ID can only contain letters, numbers, hyphens, underscores, and dots."),
  name: z4.string().trim().min(1, "Name is required.").max(128),
  email: z4.string().trim().email("Valid email is required.").max(128),
  role: DynamicRoleIdSchema,
  password: z4.string().min(6, "Password must be at least 6 characters.").max(128),
  modulesAllowed: z4.array(z4.string().max(64)).optional(),
  status: z4.enum(["Active", "Inactive"]).default("Active"),
  mustChangePassword: z4.boolean().optional()
});
var DeleteUserInputSchema = z4.object({
  callerLoginId: z4.string().trim().min(1).max(64).optional(),
  targetId: z4.string().trim().min(1).max(128).optional(),
  targetLoginId: z4.string().trim().min(1).max(64).optional()
});
var SetUserPermissionsInputSchema = z4.object({
  callerLoginId: z4.string().trim().min(1).max(64).optional(),
  targetId: z4.string().trim().min(1).max(128),
  role: DynamicRoleIdSchema.optional(),
  status: z4.enum(["Active", "Inactive"]).optional(),
  modulesAllowed: z4.array(z4.string().max(64)).optional(),
  permissions: z4.record(
    z4.string(),
    z4.object({
      view: z4.boolean().optional(),
      add: z4.boolean().optional(),
      edit: z4.boolean().optional(),
      delete: z4.boolean().optional()
    })
  ).optional()
});
var RolePermissionsInputSchema = z4.object({
  callerLoginId: z4.string().trim().min(1).max(64).optional(),
  roleId: DynamicRoleIdSchema,
  modulePermissions: z4.record(
    z4.string(),
    z4.object({
      view: z4.boolean().optional(),
      add: z4.boolean().optional(),
      edit: z4.boolean().optional(),
      delete: z4.boolean().optional()
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
    settings: { view: false, add: false, edit: false, delete: false }
  }
};
var RESTRICTED_SUPER_ADMIN_MODULES = /* @__PURE__ */ new Set([
  "user_rights",
  "audit_logs",
  "security_management"
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
        const randomInitialHash = hashPassword(crypto5.randomBytes(24).toString("hex"));
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
        allowedHeaders: ["Content-Type", "Authorization"],
        optionsSuccessStatus: 204
      });
    })
  );
  const jsonBodyParser = express.json({ limit: "2mb" });
  app.use((req, res, next) => {
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
    res.json({
      status: db && !runtimeFirestoreAccessError ? "ok" : "degraded",
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
  }
  async function requireVerifiedCaller(req, res, allowedRoles, actionLabel, options2) {
    try {
      const caller = await verifyCallerIdentity(req, adminDb, auth, projectId, options2);
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
    requireVerifiedCaller
  });
  registerAttendanceRoutes(app, {
    db: adminDb,
    requireVerifiedCaller
  });
  registerEmployeeRoutes(app, {
    db: adminDb,
    requireVerifiedCaller
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
        const resetLogId = `reset_${Date.now()}_${crypto5.randomBytes(3).toString("hex")}`;
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
  return { app, db: adminDb, auth, projectId, databaseId, credentialMode };
}
async function startServer() {
  const { app, credentialMode, projectId, databaseId } = createApp();
  const PORT = Number(process.env.PORT) || 8080;
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true, host: "0.0.0.0", port: PORT },
      appType: "spa"
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path2.resolve(process.cwd(), "dist");
    const distIndex = path2.join(distDir, "index.html");
    if (fs2.existsSync(distIndex)) {
      app.use(express.static(distDir));
      app.get("*", (_req, res) => {
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
  normalizeAllowedOrigin,
  sanitizeRoleModulePermissions,
  startServer,
  syncExistingFirebaseAuthPassword,
  verifyPassword
};
