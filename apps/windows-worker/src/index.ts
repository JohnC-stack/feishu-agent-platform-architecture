import { createWindowsWorker, windowsWorkerOptions } from './app.js';

createWindowsWorker()
  .listen({ host: windowsWorkerOptions.host, port: windowsWorkerOptions.port })
  .then((address) => {
    console.log(`windows-worker listening at ${address}`);
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
