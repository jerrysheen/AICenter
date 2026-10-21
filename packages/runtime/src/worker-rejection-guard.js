// Node 22 treats an unhandled rejection as a fatal error and exits.
// The launcher then starts another Worker, and jobs left running are
// saved as WorkerLeaseExpired. Logging here keeps this process alive.
export function installWorkerRejectionGuard(target = process, log = console.error) {
  const onRejection = (error) => {
    const detail = error instanceof Error ? error.stack || error.message : String(error);
    log(`[worker] unhandledRejection ${detail}`);
  };
  target.on('unhandledRejection', onRejection);
  return () => target.off('unhandledRejection', onRejection);
}
