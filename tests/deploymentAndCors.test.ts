import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { describe, it, expect } from 'vitest';
import { createApp } from '../server.ts';
import { InMemoryAdminAuth, InMemoryFirestore } from './helpers/inMemoryAdmin.ts';

describe('Deployment Readiness, CORS Policy & Secret Hygiene', () => {
  it('allows explicitly configured Vercel origins and blocks untrusted cross-origin requests with 403', async () => {
    const db = new InMemoryFirestore();
    const auth = new InMemoryAdminAuth();
    const { app } = createApp({
      db,
      auth,
      projectId: 'narid-atdc-tracker',
      databaseId: 'ai-studio-manpowertracker-9b87a863-5c0d-4126-accb-7a3be802b10b',
      credentialMode: 'ADC',
      allowedOrigins: ['https://narid-atdc.vercel.app'],
      disableBackgroundBoot: true,
    });

    const allowedRes = await request(app)
      .get('/api/health')
      .set('Origin', 'https://narid-atdc.vercel.app');
    expect(allowedRes.status).toBe(200);
    expect(allowedRes.headers['access-control-allow-origin']).toBe('https://narid-atdc.vercel.app');
    expect(allowedRes.body).toMatchObject({
      status: 'ok',
      projectId: 'narid-atdc-tracker',
      databaseId: 'ai-studio-manpowertracker-9b87a863-5c0d-4126-accb-7a3be802b10b',
      adminSdkInitialized: true,
      credentialMode: 'ADC',
    });

    const preflightAllowed = await request(app)
      .options('/api/auth/login')
      .set('Origin', 'https://narid-atdc.vercel.app')
      .set('Access-Control-Request-Method', 'POST');
    expect(preflightAllowed.status).toBe(204);
    expect(preflightAllowed.headers['access-control-allow-origin']).toBe('https://narid-atdc.vercel.app');

    const deniedRes = await request(app)
      .get('/api/health')
      .set('Origin', 'https://evil-attacker.example.com');
    expect(deniedRes.status).toBe(403);
    expect(deniedRes.body.code).toBe('CORS_ORIGIN_FORBIDDEN');
  });

  it('separates runtime dependencies from build/test devDependencies in package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf-8'));
    expect(pkg.scripts['build:frontend']).toBeTruthy();
    expect(pkg.scripts['build:server']).toBeTruthy();
    expect(pkg.scripts.start).toContain('dist-server/server.mjs');
    expect(pkg.dependencies['firebase-admin']).toBeTruthy();
    expect(pkg.dependencies.express).toBeTruthy();
    expect(pkg.dependencies.cors).toBeTruthy();
    expect(pkg.dependencies.zod).toBeTruthy();
    expect(pkg.dependencies.vite).toBeUndefined();
    expect(pkg.dependencies.vitest).toBeUndefined();
    expect(pkg.dependencies.supertest).toBeUndefined();
    expect(pkg.devDependencies.vite).toBeTruthy();
    expect(pkg.devDependencies.vitest).toBeTruthy();
    expect(pkg.devDependencies.esbuild).toBeTruthy();
  });

  it('contains zero hardcoded passwords, client Firestore SDK imports in backend, or real secrets in deployment config', () => {
    const filesToScan = [
      'server.ts',
      'serverFirebaseAdmin.ts',
      'serverSecurityAudit.ts',
      'serverLoginSecurity.ts',
      'serverAttendance.ts',
      'src/services/authService.ts',
      'src/components/UserRights.tsx',
      'Dockerfile',
      'vercel.json',
      '.env.example',
    ];

    for (const rel of filesToScan) {
      const content = fs.readFileSync(path.resolve(process.cwd(), rel), 'utf-8');
      expect(content, `Hardcoded Narid@12345 found in ${rel}`).not.toContain('Narid@12345');
      expect(content, `INITIAL_DEFAULT_PASSWORD found in ${rel}`).not.toContain('INITIAL_DEFAULT_PASSWORD');
      if (rel.startsWith('server')) {
        expect(content, `Client firebase/* import found in ${rel}`).not.toMatch(/from\s+['"]firebase\/(app|auth|firestore)['"]/);
      }
    }
  });

  it('fails closed when explicit service-account env credentials are invalid instead of falling back to ADC', async () => {
    const { getFirebaseAdminContext } = await import('../serverFirebaseAdmin.ts');
    const prevKey = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    try {
      process.env.FIREBASE_SERVICE_ACCOUNT_KEY = '{"project_id":"wrong-project","client_email":"a@b.c","private_key":"k"}';
      const ctx = getFirebaseAdminContext(true);
      expect(ctx.credentialMode).toBe('UNCONFIGURED');
      expect(ctx.db).toBeNull();
      expect(ctx.auth).toBeNull();
      expect(ctx.error).toContain('wrong-project');
    } finally {
      if (prevKey === undefined) {
        delete process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
      } else {
        process.env.FIREBASE_SERVICE_ACCOUNT_KEY = prevKey;
      }
      getFirebaseAdminContext(true);
    }
  });

  it('returns clean 503 FIREBASE_ADMIN_PERMISSION_DENIED on login when Firestore Admin IAM fails', async () => {
    const failingDb = {
      collection: () => {
        const err: any = new Error('7 PERMISSION_DENIED: Missing or insufficient permissions.');
        err.code = 7;
        const rejectChain = {
          doc: () => ({ get: async () => { throw err; }, set: async () => { throw err; }, update: async () => { throw err; }, delete: async () => { throw err; } }),
          where: () => rejectChain,
          limit: () => rejectChain,
          get: async () => { throw err; },
        };
        return rejectChain;
      },
      runTransaction: async () => {
        const err: any = new Error('7 PERMISSION_DENIED: Missing or insufficient permissions.');
        err.code = 7;
        throw err;
      },
    } as any;

    const { app } = createApp({
      db: failingDb,
      auth: new InMemoryAdminAuth(),
      projectId: 'narid-atdc-tracker',
      databaseId: 'ai-studio-manpowertracker-9b87a863-5c0d-4126-accb-7a3be802b10b',
      credentialMode: 'ADC',
      disableBackgroundBoot: true,
    });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ loginId: 'admin', password: 'SomePassword#123' });

    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('FIREBASE_ADMIN_PERMISSION_DENIED');
  });

  it('validates VITE_API_BASE_URL placeholders/Vercel config and safely parses HTML 404 non-JSON responses', async () => {
    const {
      normalizeApiBaseUrl,
      validateApiBaseUrl,
      safeParseJsonResponse,
      parseApiJsonOrThrow,
    } = await import('../src/config/api.ts');

    expect(normalizeApiBaseUrl('  https://api.example.com///  ')).toBe('https://api.example.com');
    expect(validateApiBaseUrl('', 'narid-atdc-tracker.vercel.app')).toBeNull();
    expect(validateApiBaseUrl('https://YOUR_CLOUD_RUN_URL', 'narid-atdc-tracker.vercel.app')).toContain('placeholder');
    expect(validateApiBaseUrl('invalid-host-without-scheme', 'narid-atdc-tracker.vercel.app')).toContain(
      'Invalid VITE_API_BASE_URL'
    );
    expect(validateApiBaseUrl('', 'localhost')).toBeNull();
    expect(validateApiBaseUrl('https://backend.example.com', 'narid-atdc-tracker.vercel.app')).toBeNull();

    const html404 = new Response('<!doctype html><html><body>404: NOT_FOUND</body></html>', {
      status: 404,
      statusText: 'Not Found',
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
    const parsed404 = await safeParseJsonResponse(html404, 'POST /api/auth/login');
    expect(parsed404.ok).toBe(false);
    expect(parsed404.status).toBe(404);
    expect(parsed404.isHtmlOrNonJson).toBe(true);
    expect(parsed404.errorMessage).toContain('HTTP 404');
    expect(parsed404.errorMessage).toContain('vercel.json');

    const json423 = new Response(JSON.stringify({ success: false, code: 'LOCKED', error: 'Account locked' }), {
      status: 423,
      headers: { 'Content-Type': 'application/json' },
    });
    await expect(parseApiJsonOrThrow(json423, 'Fallback')).rejects.toMatchObject({
      message: 'Account locked',
      status: 423,
      code: 'LOCKED',
      isHtmlOrNonJson: false,
    });
  });

  it('uses centralized apiUrl/executeApiFetch in all frontend services without raw fetch(), raw res.json(), or external rewrites', () => {
    const vercelJson = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'vercel.json'), 'utf-8'));
    const rewrites = JSON.stringify(vercelJson.rewrites || []);
    expect(rewrites).toContain('(?!api');
    expect(rewrites).not.toContain('.run.app');
    expect(vercelJson.functions?.['api/[...all].ts']?.includeFiles).toContain('firebase-applet-config.json');

    const authServiceSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/services/authService.ts'), 'utf-8');
    expect(authServiceSrc).toContain("apiUrl('/api/auth/login')");

    const frontendApiFiles = [
      'src/App.tsx',
      'src/services/authService.ts',
      'src/services/attendanceService.ts',
      'src/services/auditService.ts',
      'src/services/masterService.ts',
      'src/services/permissionService.ts',
      'src/services/securityService.ts',
    ];
    for (const rel of frontendApiFiles) {
      const content = fs.readFileSync(path.resolve(process.cwd(), rel), 'utf-8');
      expect(content, `Unsafe raw res.json() remaining in ${rel}`).not.toMatch(/\bres\.json\(/);
      expect(content, `Direct fetch() bypassing src/config/api.ts found in ${rel}`).not.toMatch(/\bfetch\(/);
    }
  });

  it('normalizes escaped newlines in service-account private_key and fails closed on VERCEL when credentials are missing or partial', async () => {
    const {
      normalizePrivateKeyNewlines,
      parseServiceAccountFromSource,
      getFirebaseAdminContext,
    } = await import('../serverFirebaseAdmin.ts');

    const escapedPem = '-----BEGIN PRIVATE KEY-----\\nLINE1\\nLINE2\\n-----END PRIVATE KEY-----\\n';
    expect(normalizePrivateKeyNewlines(escapedPem)).toBe(
      '-----BEGIN PRIVATE KEY-----\nLINE1\nLINE2\n-----END PRIVATE KEY-----'
    );

    const parsedJson = parseServiceAccountFromSource(
      JSON.stringify({
        project_id: 'narid-atdc-tracker',
        client_email: 'sa@narid-atdc-tracker.iam.gserviceaccount.com',
        private_key: escapedPem,
      })
    );
    expect(parsedJson?.private_key).toContain('\nLINE1\n');

    const prevVercel = process.env.VERCEL;
    const prevKey = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    const prevJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    const prevGac = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    const prevEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const prevPrivateKey = process.env.FIREBASE_PRIVATE_KEY;

    try {
      process.env.VERCEL = '1';
      delete process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
      delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
      delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      delete process.env.FIREBASE_CLIENT_EMAIL;
      delete process.env.FIREBASE_PRIVATE_KEY;

      // Missing all credentials on Vercel must fail closed (UNCONFIGURED, never ADC)
      const missingCtx = getFirebaseAdminContext(true);
      expect(missingCtx.credentialMode).toBe('UNCONFIGURED');
      expect(missingCtx.db).toBeNull();
      expect(missingCtx.auth).toBeNull();
      expect(missingCtx.error).toContain('Missing Firebase Admin SDK credentials in Vercel');

      // Partial discrete credentials must also fail closed
      process.env.FIREBASE_CLIENT_EMAIL = 'sa@narid-atdc-tracker.iam.gserviceaccount.com';
      const partialCtx = getFirebaseAdminContext(true);
      expect(partialCtx.credentialMode).toBe('UNCONFIGURED');
      expect(partialCtx.error).toContain('FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY');
    } finally {
      if (prevVercel === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = prevVercel;
      if (prevKey === undefined) delete process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
      else process.env.FIREBASE_SERVICE_ACCOUNT_KEY = prevKey;
      if (prevJson === undefined) delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
      else process.env.FIREBASE_SERVICE_ACCOUNT_JSON = prevJson;
      if (prevGac === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      else process.env.GOOGLE_APPLICATION_CREDENTIALS = prevGac;
      if (prevEmail === undefined) delete process.env.FIREBASE_CLIENT_EMAIL;
      else process.env.FIREBASE_CLIENT_EMAIL = prevEmail;
      if (prevPrivateKey === undefined) delete process.env.FIREBASE_PRIVATE_KEY;
      else process.env.FIREBASE_PRIVATE_KEY = prevPrivateKey;
      getFirebaseAdminContext(true);
    }
  });

  it('routes Vercel api/[...all].ts catch-all requests cleanly and returns JSON responses (no HTML fallback)', async () => {
    const http = await import('http');
    const handlerMod = await import('../api/[...all].ts');

    const prevVercel = process.env.VERCEL;
    const prevKey = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    const prevEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const prevPrivateKey = process.env.FIREBASE_PRIVATE_KEY;

    try {
      process.env.VERCEL = '1';
      delete process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
      delete process.env.FIREBASE_CLIENT_EMAIL;
      delete process.env.FIREBASE_PRIVATE_KEY;

      const { getFirebaseAdminContext } = await import('../serverFirebaseAdmin.ts');
      getFirebaseAdminContext(true);
      handlerMod.resetServerlessAppHandlerForTests();

      const server = http.createServer((req, res) => handlerMod.default(req, res));

      const healthRes = await request(server).get('/api/health');
      expect(healthRes.status).toBe(200);
      expect(healthRes.headers['content-type']).toContain('application/json');
      expect(healthRes.body.status).toBe('degraded');
      expect(healthRes.body.adminSdkInitialized).toBe(false);
      expect(healthRes.body.credentialMode).toBe('UNCONFIGURED');

      // Also verify stripped path normalization (/health -> /api/health)
      const strippedHealth = await request(server).get('/health');
      expect(strippedHealth.status).toBe(200);
      expect(strippedHealth.body.projectId).toBe('narid-atdc-tracker');

      // Unknown API route when unconfigured returns clean 503 JSON, never HTML
      const apiFailRes = await request(server).post('/api/auth/login').send({ loginId: 'admin', password: 'x' });
      expect(apiFailRes.status).toBe(503);
      expect(apiFailRes.headers['content-type']).toContain('application/json');
      expect(apiFailRes.body.code).toBe('FIREBASE_ADMIN_UNCONFIGURED');
    } finally {
      handlerMod.resetServerlessAppHandlerForTests();
      if (prevVercel === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = prevVercel;
      if (prevKey === undefined) delete process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
      else process.env.FIREBASE_SERVICE_ACCOUNT_KEY = prevKey;
      if (prevEmail === undefined) delete process.env.FIREBASE_CLIENT_EMAIL;
      else process.env.FIREBASE_CLIENT_EMAIL = prevEmail;
      if (prevPrivateKey === undefined) delete process.env.FIREBASE_PRIVATE_KEY;
      else process.env.FIREBASE_PRIVATE_KEY = prevPrivateKey;
      const { getFirebaseAdminContext } = await import('../serverFirebaseAdmin.ts');
      getFirebaseAdminContext(true);
    }

    // Also confirm unknown /api/* path inside configured app returns 404 JSON (not HTML)
    const db = new InMemoryFirestore();
    const auth = new InMemoryAdminAuth();
    const { app } = createApp({
      db,
      auth,
      projectId: 'narid-atdc-tracker',
      databaseId: 'ai-studio-manpowertracker-9b87a863-5c0d-4126-accb-7a3be802b10b',
      credentialMode: 'SERVICE_ACCOUNT_ENV',
      disableBackgroundBoot: true,
    });

    const notFoundRes = await request(app).get('/api/does-not-exist');
    expect(notFoundRes.status).toBe(404);
    expect(notFoundRes.headers['content-type']).toContain('application/json');
    expect(notFoundRes.body).toEqual({ success: false, error: 'API endpoint not found.' });

    // Confirm disableBackgroundBoot performs zero cold-start seed/migration writes
    expect(Object.keys(db.getRawCollection('user_roles'))).toHaveLength(0);
    expect(Object.keys(db.getRawCollection('roles'))).toHaveLength(0);
    expect(Object.keys(db.getRawCollection('account_security'))).toHaveLength(0);
  });

  it('avoids static JSON ESM imports in backend files and safely loads/validates firebase-applet-config.json at runtime', async () => {
    const os = await import('os');
    const {
      loadFirebaseAppletConfig,
      resetFirebaseAppletConfigCacheForTests,
      TARGET_PROJECT_ID,
      TARGET_DATABASE_ID,
    } = await import('../serverFirebaseAdmin.ts');

    const backendFiles = [
      'api/[...all].ts',
      'server.ts',
      'serverFirebaseAdmin.ts',
      'serverSecurityAudit.ts',
      'serverLoginSecurity.ts',
      'serverAttendance.ts',
    ];
    for (const rel of backendFiles) {
      const content = fs.readFileSync(path.resolve(process.cwd(), rel), 'utf-8');
      expect(content, `Static JSON import found in ${rel}`).not.toMatch(/from\s+['"][^'"]+\.json['"]/);
    }

    resetFirebaseAppletConfigCacheForTests();
    const cfg = loadFirebaseAppletConfig();
    expect(cfg.projectId).toBe('narid-atdc-tracker');
    expect(cfg.firestoreDatabaseId).toBe('ai-studio-manpowertracker-9b87a863-5c0d-4126-accb-7a3be802b10b');
    expect(TARGET_PROJECT_ID).toBe('narid-atdc-tracker');
    expect(TARGET_DATABASE_ID).toBe('ai-studio-manpowertracker-9b87a863-5c0d-4126-accb-7a3be802b10b');

    const missingPath = path.join(os.tmpdir(), `missing-firebase-config-${Date.now()}.json`);
    expect(() => loadFirebaseAppletConfig(missingPath)).toThrow('Missing firebase-applet-config.json');

    const invalidJsonPath = path.join(os.tmpdir(), `invalid-firebase-config-${Date.now()}.json`);
    const missingFieldsPath = path.join(os.tmpdir(), `incomplete-firebase-config-${Date.now()}.json`);
    try {
      fs.writeFileSync(invalidJsonPath, '{bad json', 'utf8');
      expect(() => loadFirebaseAppletConfig(invalidJsonPath)).toThrow('Invalid JSON in firebase-applet-config.json');

      fs.writeFileSync(missingFieldsPath, JSON.stringify({ apiKey: 'AIzaTestSecretShouldNotLeak' }), 'utf8');
      let errMsg = '';
      try {
        loadFirebaseAppletConfig(missingFieldsPath);
      } catch (e: any) {
        errMsg = String(e?.message || '');
      }
      expect(errMsg).toContain('missing required projectId or firestoreDatabaseId');
      expect(errMsg).not.toContain('AIzaTestSecretShouldNotLeak');
    } finally {
      if (fs.existsSync(invalidJsonPath)) fs.unlinkSync(invalidJsonPath);
      if (fs.existsSync(missingFieldsPath)) fs.unlinkSync(missingFieldsPath);
    }
  });

  it('prevents ERR_REQUIRE_ESM between jwks-rsa and jose under strict CommonJS/ESM interop', () => {
    const { execFileSync } = require('child_process');

    const rootPkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf-8'));
    const faPkg = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), 'node_modules/firebase-admin/package.json'), 'utf-8')
    );
    const jwksPkg = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), 'node_modules/jwks-rsa/package.json'), 'utf-8')
    );
    const josePkg = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), 'node_modules/jose/package.json'), 'utf-8')
    );

    expect(rootPkg.dependencies['firebase-admin']).toBe('13.10.0');
    expect(faPkg.version).toBe('13.10.0');
    expect(Number(jwksPkg.version.split('.')[0])).toBe(3);
    expect(Number(josePkg.version.split('.')[0])).toBe(4);
    expect(josePkg.exports['.']?.require).toBe('./dist/node/cjs/index.js');

    // Reproduces the exact Node runtime condition (--no-experimental-require-module) where jose@6 + jwks-rsa@4 failed with ERR_REQUIRE_ESM
    const script = `
      const http = require('http');
      require('jwks-rsa');
      require('jose');
      require('firebase-admin/auth');
      process.env.VERCEL = '1';
      import('./api/[...all].ts').then(async (m) => {
        const srv = http.createServer((req, res) => m.default(req, res));
        srv.listen(0, '127.0.0.1', async () => {
          const addr = srv.address();
          const r = await fetch('http://127.0.0.1:' + addr.port + '/api/health');
          const body = await r.json();
          if (r.status !== 200 || body.projectId !== 'narid-atdc-tracker') {
            process.exit(2);
          }
          console.log('NO_ERR_REQUIRE_ESM_OK');
          srv.close();
        });
      }).catch((err) => {
        console.error(err);
        process.exit(1);
      });
    `;
    const out = execFileSync(process.execPath, ['--no-experimental-require-module', '-e', script], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    });
    expect(out).toContain('NO_ERR_REQUIRE_ESM_OK');
  });

  it('initializes real api/[...all].ts Firebase Admin SDK with service-account credentials, returns 200 /api/health, and rejects unverified JWTs', async () => {
    const crypto = await import('crypto');
    const http = await import('http');
    const { deleteApp } = await import('firebase-admin/app');
    const handlerMod = await import('../api/[...all].ts');
    const { getFirebaseAdminContext } = await import('../serverFirebaseAdmin.ts');

    const { privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });

    const prevVercel = process.env.VERCEL;
    const prevKey = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;

    try {
      process.env.VERCEL = '1';
      process.env.FIREBASE_SERVICE_ACCOUNT_KEY = JSON.stringify({
        type: 'service_account',
        project_id: 'narid-atdc-tracker',
        client_email: 'offline-test@narid-atdc-tracker.iam.gserviceaccount.com',
        private_key: privateKey,
      });

      const ctx = getFirebaseAdminContext(true);
      expect(ctx.credentialMode).toBe('SERVICE_ACCOUNT_ENV');
      expect(ctx.app).not.toBeNull();
      expect(ctx.auth).not.toBeNull();
      expect(ctx.db).not.toBeNull();

      handlerMod.resetServerlessAppHandlerForTests();
      const server = http.createServer((req, res) => handlerMod.default(req, res));

      const healthRes = await request(server).get('/api/health');
      expect(healthRes.status).toBe(200);
      expect(healthRes.body).toMatchObject({
        status: 'ok',
        projectId: 'narid-atdc-tracker',
        databaseId: 'ai-studio-manpowertracker-9b87a863-5c0d-4126-accb-7a3be802b10b',
        adminSdkInitialized: true,
        firestoreAccess: 'ok',
        credentialMode: 'SERVICE_ACCOUNT_ENV',
      });

      // Unsigned alg=none token must be rejected with 401
      const algNoneHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const forgedPayload = Buffer.from(
        JSON.stringify({
          iss: 'https://securetoken.google.com/narid-atdc-tracker',
          aud: 'narid-atdc-tracker',
          sub: 'oX2vdSx5jGcoUDxyA0SIYN3SEig2',
          user_id: 'oX2vdSx5jGcoUDxyA0SIYN3SEig2',
          exp: Math.floor(Date.now() / 1000) + 3600,
        })
      ).toString('base64url');

      const algNoneRes = await request(server)
        .post('/api/auth/verify-session')
        .set('Authorization', `Bearer ${algNoneHeader}.${forgedPayload}.`)
        .send({ loginId: 'superadmin' });
      expect(algNoneRes.status).toBe(401);
      expect(algNoneRes.body.success).toBe(false);

      // Invalid/mismatched RS256 signature token must be rejected with 401
      const rs256Header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'fake-kid' })).toString('base64url');
      const badSigRes = await request(server)
        .post('/api/auth/verify-session')
        .set('Authorization', `Bearer ${rs256Header}.${forgedPayload}.invalidSignature`)
        .send({ loginId: 'superadmin' });
      expect(badSigRes.status).toBe(401);
      expect(badSigRes.body.success).toBe(false);
    } finally {
      const ctx = getFirebaseAdminContext(false);
      if (ctx.app) {
        await deleteApp(ctx.app).catch(() => {});
      }
      handlerMod.resetServerlessAppHandlerForTests();
      if (prevVercel === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = prevVercel;
      if (prevKey === undefined) delete process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
      else process.env.FIREBASE_SERVICE_ACCOUNT_KEY = prevKey;
      getFirebaseAdminContext(true);
    }
  });
  it('resolves dual-environment API URLs cleanly without double /api/api or malformed protocols', async () => {
    const {
      normalizeApiBaseUrl,
      validateApiBaseUrl,
      resolveApiUrl,
    } = await import('../src/config/api.ts');

    // Empty / undefined -> same-origin /api/* (Vercel Production)
    expect(resolveApiUrl('/api/auth/login', undefined)).toBe('/api/auth/login');
    expect(resolveApiUrl('/api/auth/login', '')).toBe('/api/auth/login');
    expect(resolveApiUrl('/api/health', '   ')).toBe('/api/health');

    // Absolute HTTPS URL -> Google AI Studio Preview pointing at shared Vercel backend
    expect(resolveApiUrl('/api/auth/login', 'https://narid-atdc-tracker.vercel.app')).toBe(
      'https://narid-atdc-tracker.vercel.app/api/auth/login'
    );
    expect(resolveApiUrl('/api/auth/login', 'https://narid-atdc-tracker.vercel.app/')).toBe(
      'https://narid-atdc-tracker.vercel.app/api/auth/login'
    );
    // Trailing /api on base URL or duplicate /api/api in path never doubles /api
    expect(normalizeApiBaseUrl('https://narid-atdc-tracker.vercel.app/api/')).toBe(
      'https://narid-atdc-tracker.vercel.app'
    );
    expect(resolveApiUrl('/api/auth/login', 'https://narid-atdc-tracker.vercel.app/api')).toBe(
      'https://narid-atdc-tracker.vercel.app/api/auth/login'
    );
    expect(resolveApiUrl('/api/api/auth/login', 'https://narid-atdc-tracker.vercel.app')).toBe(
      'https://narid-atdc-tracker.vercel.app/api/auth/login'
    );

    // Preserves query strings accurately
    expect(resolveApiUrl('/api/audit/logs?limit=50&loginId=admin', 'https://narid-atdc-tracker.vercel.app')).toBe(
      'https://narid-atdc-tracker.vercel.app/api/audit/logs?limit=50&loginId=admin'
    );

    // Rejects '/', relative URLs, invalid URLs, extra path segments, embedded credentials, and unsupported protocols
    expect(validateApiBaseUrl('/')).toContain('relative URLs are not allowed');
    expect(validateApiBaseUrl('/api')).toContain('relative URLs are not allowed');
    expect(validateApiBaseUrl('./api')).toContain('relative URLs are not allowed');
    expect(validateApiBaseUrl('narid-atdc-tracker.vercel.app')).toContain('Invalid VITE_API_BASE_URL');
    expect(validateApiBaseUrl('ftp://narid-atdc-tracker.vercel.app')).toContain('Unsupported protocol');
    expect(validateApiBaseUrl('javascript:alert(1)')).toContain('Unsupported protocol');
    expect(validateApiBaseUrl('https://')).toContain('Invalid VITE_API_BASE_URL');
    expect(validateApiBaseUrl('https://user:pass@narid-atdc-tracker.vercel.app')).toContain('credentials');
    expect(validateApiBaseUrl('https://narid-atdc-tracker.vercel.app/v2')).toContain('backend origin only');
    expect(() => resolveApiUrl('/api/auth/login', '/')).toThrow('not allowed');
    expect(() => resolveApiUrl('/api/auth/login', '/api')).toThrow('not allowed');
    expect(() => resolveApiUrl('/api/auth/login', 'ftp://narid-atdc-tracker.vercel.app')).toThrow('Unsupported protocol');
  });

  it('allows exact AI Studio & Vercel origins with preflight and rejects untrusted/other Cloud Run origins without wildcards', async () => {
    const { buildAllowedOriginsSet } = await import('../server.ts');

    const prevAllowed = process.env.ALLOWED_ORIGINS;
    try {
      // Even if a wildcard entry is passed in ALLOWED_ORIGINS, it must be ignored
      process.env.ALLOWED_ORIGINS = '*,https://*.run.app,https://custom.narid-tracker.com/';
      const set = buildAllowedOriginsSet();
      expect(set.has('*')).toBe(false);
      expect(set.has('https://*.run.app')).toBe(false);
      expect(set.has('https://custom.narid-tracker.com')).toBe(true);
      expect(set.has('https://narid-atdc-tracker.vercel.app')).toBe(true);
      expect(set.has('https://ais-dev-ffrnx5p5324ee4aajyzxbj-356936239657.asia-southeast1.run.app')).toBe(true);
      expect(set.has('https://ais-pre-ffrnx5p5324ee4aajyzxbj-356936239657.asia-southeast1.run.app')).toBe(true);
    } finally {
      if (prevAllowed === undefined) delete process.env.ALLOWED_ORIGINS;
      else process.env.ALLOWED_ORIGINS = prevAllowed;
    }

    const db = new InMemoryFirestore();
    const auth = new InMemoryAdminAuth();
    const { app } = createApp({
      db,
      auth,
      projectId: 'narid-atdc-tracker',
      databaseId: 'ai-studio-manpowertracker-9b87a863-5c0d-4126-accb-7a3be802b10b',
      credentialMode: 'SERVICE_ACCOUNT_ENV',
      disableBackgroundBoot: true,
    });

    const aiStudioOrigin = 'https://ais-dev-ffrnx5p5324ee4aajyzxbj-356936239657.asia-southeast1.run.app';
    const aiPreviewOrigin = 'https://ais-pre-ffrnx5p5324ee4aajyzxbj-356936239657.asia-southeast1.run.app';
    const vercelOrigin = 'https://narid-atdc-tracker.vercel.app';
    const randomCloudRunOrigin = 'https://unrelated-service-12345.asia-southeast1.run.app';

    for (const trustedOrigin of [aiStudioOrigin, aiPreviewOrigin, vercelOrigin]) {
      const preflight = await request(app)
        .options('/api/auth/login')
        .set('Origin', trustedOrigin)
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'Content-Type, Authorization');
      expect(preflight.status).toBe(204);
      expect(preflight.headers['access-control-allow-origin']).toBe(trustedOrigin);
      expect(preflight.headers['access-control-allow-origin']).not.toBe('*');
      expect(preflight.headers['access-control-allow-credentials']).toBe('true');

      const health = await request(app).get('/api/health').set('Origin', trustedOrigin);
      expect(health.status).toBe(200);
      expect(health.headers['access-control-allow-origin']).toBe(trustedOrigin);
      expect(health.headers['access-control-allow-credentials']).toBe('true');
    }

    const rejectedOtherRunApp = await request(app)
      .options('/api/auth/login')
      .set('Origin', randomCloudRunOrigin)
      .set('Access-Control-Request-Method', 'POST');
    expect(rejectedOtherRunApp.status).toBe(403);
    expect(rejectedOtherRunApp.body.code).toBe('CORS_ORIGIN_FORBIDDEN');

    const rejectedUntrustedPost = await request(app)
      .post('/api/auth/login')
      .set('Origin', 'https://evil-attacker.example.com')
      .send({ loginId: 'admin', password: 'x' });
    expect(rejectedUntrustedPost.status).toBe(403);
    expect(rejectedUntrustedPost.body.code).toBe('CORS_ORIGIN_FORBIDDEN');
  });

  it('normalizes Vercel api/[...all].ts login paths, executes POST /api/auth/login (never 404), and returns JSON 404 for unknown endpoints', async () => {
    const http = await import('http');
    const crypto = await import('crypto');
    const { deleteApp } = await import('firebase-admin/app');
    const { hashPassword } = await import('../server.ts');
    const { getFirebaseAdminContext } = await import('../serverFirebaseAdmin.ts');
    const handlerMod = await import('../api/[...all].ts');

    expect(handlerMod.normalizeServerlessRequestUrl('/api/auth/login')).toBe('/api/auth/login');
    expect(handlerMod.normalizeServerlessRequestUrl('/auth/login')).toBe('/api/auth/login');
    expect(handlerMod.normalizeServerlessRequestUrl('/api/api/auth/login')).toBe('/api/auth/login');
    expect(handlerMod.normalizeServerlessRequestUrl('/api/audit/logs?limit=10')).toBe('/api/audit/logs?limit=10');

    // Mount real Express app inside Vercel handler's URL normalizer to verify end-to-end login route without live network
    const db = new InMemoryFirestore();
    const auth = new InMemoryAdminAuth();
    await db.collection('user_roles').doc('role_user').set({
      id: 'role_user',
      loginId: 'user',
      name: 'Floor Operator',
      email: 'user@narid.com',
      authUid: 'existing-uid-user-001',
      role: 'user',
      status: 'Active',
      passwordHash: hashPassword('CorrectPass#123'),
      mustChangePassword: false,
      modulesAllowed: ['dashboard', 'scanner'],
    });
    const { app } = createApp({
      db,
      auth,
      projectId: 'narid-atdc-tracker',
      databaseId: 'ai-studio-manpowertracker-9b87a863-5c0d-4126-accb-7a3be802b10b',
      credentialMode: 'SERVICE_ACCOUNT_ENV',
      disableBackgroundBoot: true,
    });

    const normalizedServer = http.createServer((req, res) => {
      req.url = handlerMod.normalizeServerlessRequestUrl(req.url);
      return app(req as any, res as any);
    });

    // Wrong password hits real login logic (401 INVALID_PASSWORD, never 404)
    const badLogin = await request(normalizedServer)
      .post('/api/auth/login')
      .set('Origin', 'https://ais-dev-ffrnx5p5324ee4aajyzxbj-356936239657.asia-southeast1.run.app')
      .send({ loginId: 'user', password: 'WrongPassword!' });
    expect(badLogin.status).toBe(401);
    expect(badLogin.body.code).toBe('INVALID_PASSWORD');
    expect(badLogin.headers['access-control-allow-origin']).toBe(
      'https://ais-dev-ffrnx5p5324ee4aajyzxbj-356936239657.asia-southeast1.run.app'
    );

    // Valid password succeeds and preserves existing UID across /api/auth/login & normalized /api/api/auth/login
    const goodLogin = await request(normalizedServer)
      .post('/api/api/auth/login')
      .set('Origin', 'https://narid-atdc-tracker.vercel.app')
      .send({ loginId: 'user', password: 'CorrectPass#123' });
    expect(goodLogin.status).toBe(200);
    expect(goodLogin.body.success).toBe(true);
    expect(goodLogin.body.profile.authUid).toBe('existing-uid-user-001');
    expect(goodLogin.headers['access-control-allow-origin']).toBe('https://narid-atdc-tracker.vercel.app');

    // Unknown API path returns 404 JSON (never HTML)
    const unknownApi = await request(normalizedServer).get('/api/unknown-route-check');
    expect(unknownApi.status).toBe(404);
    expect(unknownApi.headers['content-type']).toContain('application/json');
    expect(unknownApi.body).toEqual({ success: false, error: 'API endpoint not found.' });

    // Confirm real handler with SERVICE_ACCOUNT_ENV returns 200 JSON on /api/health
    const { privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const prevVercel = process.env.VERCEL;
    const prevKey = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    try {
      process.env.VERCEL = '1';
      process.env.FIREBASE_SERVICE_ACCOUNT_KEY = JSON.stringify({
        type: 'service_account',
        project_id: 'narid-atdc-tracker',
        client_email: 'offline-test@narid-atdc-tracker.iam.gserviceaccount.com',
        private_key: privateKey,
      });
      getFirebaseAdminContext(true);
      handlerMod.resetServerlessAppHandlerForTests();
      const realSrv = http.createServer((req, res) => handlerMod.default(req, res));
      const hRes = await request(realSrv).get('/api/health');
      expect(hRes.status).toBe(200);
      expect(hRes.body.status).toBe('ok');
    } finally {
      const ctx = getFirebaseAdminContext(false);
      if (ctx.app) await deleteApp(ctx.app).catch(() => {});
      handlerMod.resetServerlessAppHandlerForTests();
      if (prevVercel === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = prevVercel;
      if (prevKey === undefined) delete process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
      else process.env.FIREBASE_SERVICE_ACCOUNT_KEY = prevKey;
      getFirebaseAdminContext(true);
    }
  });
});

