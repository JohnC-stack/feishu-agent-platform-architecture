import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createEnvironmentMtlsFetch,
  createMtlsFetch,
  readMtlsClientOptions,
  readServiceTlsOptions,
} from './index.js';

describe('P7 service transport', () => {
  it('fails closed when mTLS is required for a plain HTTP endpoint', async () => {
    const client = createMtlsFetch({ required: true, allowedHosts: ['control.internal'] });
    await expect(client('http://control.internal/health')).rejects.toThrow('https://');
  });

  it('rejects hosts outside the mTLS allowlist before network access', async () => {
    const client = createMtlsFetch({ required: true, allowedHosts: ['control.internal'] });
    await expect(client('https://other.internal/health')).rejects.toThrow('allowlist');
  });

  it('delegates to the standard fetch path when mTLS is disabled', async () => {
    const response = new Response('ok');
    const fallback = vi.fn(() => Promise.resolve(response));
    const client = createEnvironmentMtlsFetch('CONTROL_PLANE', {}, fallback);
    await expect(client('http://127.0.0.1:3000/health')).resolves.toBe(response);
    expect(fallback).toHaveBeenCalledOnce();
  });

  it('loads complete client and server identities from protected files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feishu-agent-mtls-'));
    try {
      const ca = join(root, 'ca.pem');
      const cert = join(root, 'service.pem');
      const key = join(root, 'service.key');
      for (const path of [ca, cert, key]) {
        await writeFile(path, 'synthetic-pem', { mode: 0o600 });
        await chmod(path, 0o600);
      }
      const environment = {
        CONTROL_PLANE_MTLS_REQUIRED: 'true',
        CONTROL_PLANE_MTLS_ALLOWED_HOSTS: 'control.internal',
        CONTROL_PLANE_MTLS_CA_PATH: ca,
        CONTROL_PLANE_MTLS_CERT_PATH: cert,
        CONTROL_PLANE_MTLS_KEY_PATH: key,
        WINDOWS_WORKER_TLS_ENABLED: 'true',
        WINDOWS_WORKER_TLS_CA_PATH: ca,
        WINDOWS_WORKER_TLS_CERT_PATH: cert,
        WINDOWS_WORKER_TLS_KEY_PATH: key,
      };
      expect(readMtlsClientOptions('CONTROL_PLANE', environment)).toMatchObject({
        required: true,
        allowedHosts: ['control.internal'],
      });
      expect(readServiceTlsOptions('WINDOWS_WORKER', environment)).toMatchObject({
        requestCert: true,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.3',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects incomplete mTLS file configuration', () => {
    expect(() =>
      readMtlsClientOptions('CONTROL_PLANE', {
        CONTROL_PLANE_MTLS_REQUIRED: 'true',
        CONTROL_PLANE_MTLS_ALLOWED_HOSTS: 'control.internal',
        CONTROL_PLANE_MTLS_CA_PATH: 'C:\\certs\\ca.pem',
      }),
    ).toThrow('configured together');
  });
});
