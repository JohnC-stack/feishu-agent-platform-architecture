import { readFileSync, statSync } from 'node:fs';
import { request as httpsRequest, type ServerOptions } from 'node:https';
import { isAbsolute } from 'node:path';

export type PlatformFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface MtlsClientOptions {
  required: boolean;
  allowedHosts: string[];
  ca?: Buffer;
  cert?: Buffer;
  key?: Buffer;
  servername?: string;
  maxResponseBytes?: number;
}

export function readServiceTlsOptions(
  prefix: string,
  environment: NodeJS.ProcessEnv = process.env,
): ServerOptions | undefined {
  if (!readBoolean(environment[`${prefix}_TLS_ENABLED`], false, `${prefix}_TLS_ENABLED`)) {
    return undefined;
  }
  const enforcePosixPermissions = readBoolean(
    environment[`${prefix}_TLS_ENFORCE_POSIX_PERMISSIONS`],
    true,
    `${prefix}_TLS_ENFORCE_POSIX_PERMISSIONS`,
  );
  const cert = readRequiredSecureFile(
    environment[`${prefix}_TLS_CERT_PATH`],
    `${prefix}_TLS_CERT_PATH`,
    enforcePosixPermissions,
  );
  const key = readRequiredSecureFile(
    environment[`${prefix}_TLS_KEY_PATH`],
    `${prefix}_TLS_KEY_PATH`,
    enforcePosixPermissions,
  );
  const requireClientCert = readBoolean(
    environment[`${prefix}_TLS_REQUIRE_CLIENT_CERT`],
    true,
    `${prefix}_TLS_REQUIRE_CLIENT_CERT`,
  );
  const caPath = environment[`${prefix}_TLS_CA_PATH`]?.trim();
  if (requireClientCert && !caPath) {
    throw new Error(`${prefix}_TLS_CA_PATH is required when client certificates are required.`);
  }
  const ca = caPath
    ? readRequiredSecureFile(caPath, `${prefix}_TLS_CA_PATH`, enforcePosixPermissions)
    : undefined;
  return {
    cert,
    key,
    ...(ca ? { ca } : {}),
    requestCert: requireClientCert,
    rejectUnauthorized: requireClientCert,
    minVersion: 'TLSv1.3',
  };
}

export function readMtlsClientOptions(
  prefix: string,
  environment: NodeJS.ProcessEnv = process.env,
): MtlsClientOptions {
  const required = readBoolean(
    environment[`${prefix}_MTLS_REQUIRED`],
    false,
    `${prefix}_MTLS_REQUIRED`,
  );
  const enforcePosixPermissions = readBoolean(
    environment[`${prefix}_MTLS_ENFORCE_POSIX_PERMISSIONS`],
    true,
    `${prefix}_MTLS_ENFORCE_POSIX_PERMISSIONS`,
  );
  const caPath = environment[`${prefix}_MTLS_CA_PATH`]?.trim();
  const certPath = environment[`${prefix}_MTLS_CERT_PATH`]?.trim();
  const keyPath = environment[`${prefix}_MTLS_KEY_PATH`]?.trim();
  const configuredCount = [caPath, certPath, keyPath].filter(Boolean).length;
  if (configuredCount !== 0 && configuredCount !== 3) {
    throw new Error(`${prefix}_MTLS_CA_PATH, CERT_PATH, and KEY_PATH must be configured together.`);
  }
  if (required && configuredCount !== 3) {
    throw new Error(`${prefix} mTLS is required but its CA, certificate, or key path is missing.`);
  }
  const allowedHosts = splitList(environment[`${prefix}_MTLS_ALLOWED_HOSTS`]).map((host) =>
    host.toLowerCase(),
  );
  if (required && allowedHosts.length === 0) {
    throw new Error(`${prefix}_MTLS_ALLOWED_HOSTS must contain at least one host.`);
  }
  return {
    required,
    allowedHosts,
    ...(caPath
      ? { ca: readRequiredSecureFile(caPath, `${prefix}_MTLS_CA_PATH`, enforcePosixPermissions) }
      : {}),
    ...(certPath
      ? {
          cert: readRequiredSecureFile(
            certPath,
            `${prefix}_MTLS_CERT_PATH`,
            enforcePosixPermissions,
          ),
        }
      : {}),
    ...(keyPath
      ? {
          key: readRequiredSecureFile(keyPath, `${prefix}_MTLS_KEY_PATH`, enforcePosixPermissions),
        }
      : {}),
    ...(environment[`${prefix}_MTLS_SERVER_NAME`]?.trim()
      ? { servername: environment[`${prefix}_MTLS_SERVER_NAME`]?.trim() }
      : {}),
  };
}

export function createEnvironmentMtlsFetch(
  prefix: string,
  environment: NodeJS.ProcessEnv = process.env,
  fallback: PlatformFetch = (input, init) => fetch(input, init),
): PlatformFetch {
  return createMtlsFetch(readMtlsClientOptions(prefix, environment), fallback);
}

export function createMtlsFetch(
  options: MtlsClientOptions,
  fallback: PlatformFetch = (input, init) => fetch(input, init),
): PlatformFetch {
  const hasClientIdentity = Boolean(options.ca && options.cert && options.key);
  return async (input, init = {}) => {
    const url = input instanceof URL ? input : new URL(input);
    if (options.required && url.protocol !== 'https:') {
      throw new Error('mTLS transport requires an https:// endpoint.');
    }
    if (
      options.required &&
      !options.allowedHosts.some((host) => host === url.hostname.toLowerCase())
    ) {
      throw new Error('mTLS endpoint host is outside the configured allowlist.');
    }
    if (!hasClientIdentity) {
      if (options.required) throw new Error('mTLS client identity is not configured.');
      return fallback(url, init);
    }
    if (url.protocol !== 'https:') {
      return fallback(url, init);
    }
    return requestWithClientCertificate(url, init, options);
  };
}

async function requestWithClientCertificate(
  url: URL,
  init: RequestInit,
  options: MtlsClientOptions,
): Promise<Response> {
  const body = normalizeBody(init.body);
  const headers = new Headers(init.headers);
  if (body && !headers.has('content-length')) {
    headers.set('content-length', String(body.byteLength));
  }
  const response = await new Promise<Response>((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        method: init.method ?? 'GET',
        headers: Object.fromEntries(headers.entries()),
        ca: options.ca,
        cert: options.cert,
        key: options.key,
        servername: options.servername ?? url.hostname,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.3',
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        let size = 0;
        incoming.on('data', (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > (options.maxResponseBytes ?? 16 * 1024 * 1024)) {
            incoming.destroy(new Error('mTLS response exceeded the configured size limit.'));
            return;
          }
          chunks.push(chunk);
        });
        incoming.once('error', reject);
        incoming.once('end', () => {
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) {
            if (Array.isArray(value)) {
              for (const item of value) responseHeaders.append(name, item);
            } else if (value !== undefined) {
              responseHeaders.set(name, value);
            }
          }
          const status = incoming.statusCode ?? 500;
          resolve(
            new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), {
              status,
              statusText: incoming.statusMessage,
              headers: responseHeaders,
            }),
          );
        });
      },
    );
    const abort = () => request.destroy(new Error('mTLS request was aborted.'));
    if (init.signal?.aborted) {
      abort();
    } else {
      init.signal?.addEventListener('abort', abort, { once: true });
    }
    request.once('error', reject);
    request.once('close', () => init.signal?.removeEventListener('abort', abort));
    request.end(body);
  });
  return response;
}

function normalizeBody(body: BodyInit | null | undefined): Buffer | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  throw new Error(
    'mTLS transport supports string, Uint8Array, or ArrayBuffer request bodies only.',
  );
}

function readRequiredSecureFile(
  pathValue: string | undefined,
  name: string,
  enforcePosixPermissions = true,
): Buffer {
  const path = pathValue?.trim();
  if (!path || !isAbsolute(path)) throw new Error(`${name} must be an absolute path.`);
  const metadata = statSync(path);
  if (!metadata.isFile() || metadata.size <= 0 || metadata.size > 1_048_576) {
    throw new Error(`${name} must reference a non-empty regular file no larger than 1 MiB.`);
  }
  if (enforcePosixPermissions && process.platform !== 'win32' && (metadata.mode & 0o022) !== 0) {
    throw new Error(`${name} must not be writable by group or other users.`);
  }
  return readFileSync(path);
}

function readBoolean(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  if (value.trim().toLowerCase() === 'true') return true;
  if (value.trim().toLowerCase() === 'false') return false;
  throw new Error(`${name} must be true or false.`);
}

function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}
