import { createWindowsWorker, windowsWorkerOptions } from './app.js';
import { resolveCredentialEnvironment } from './credential-bootstrap.js';

async function main(): Promise<void> {
  const credentials = await resolveCredentialEnvironment();
  const address = await createWindowsWorker().listen({
    host: windowsWorkerOptions.host,
    port: windowsWorkerOptions.port,
  });
  console.log(
    `windows-worker listening at ${address}; credential references resolved: ${credentials.resolvedNames.length}`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
