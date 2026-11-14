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

  it('uses centralized API_BASE_URL in all frontend services without raw res.json() or external rewrites in vercel.json', () => {
    const vercelJson = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'vercel.json'), 'utf-8'));
    const rewrites = JSON.stringify(vercelJson.rewrites || []);
    expect(rewrites).toContain('(?!api');
    expect(rewrites).not.toContain('.run.app');
    expect(vercelJson.functions?.['api/[...all].ts']?.includeFiles).toContain('firebase-applet-config.json');

    const authServiceSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/services/authService.ts'), 'utf-8');
    expect(authServiceSrc).toContain('${API_BASE_URL}/api/auth/login');

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
});

