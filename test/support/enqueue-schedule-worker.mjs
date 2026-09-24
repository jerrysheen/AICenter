import { parentPort, workerData } from 'node:worker_threads';
import { createStore } from '../../packages/database/src/index.js';

if (!parentPort || !workerData?.databasePath) {
  // Loaded outside the concurrency test.
} else {
  const store = createStore(workerData.databasePath);
  try {
    const result = store.enqueueDueSchedule(workerData.scheduleId, workerData.now);
    parentPort.postMessage({ created: Boolean(result), jobId: result?.jobId || null });
  } catch (error) {
    parentPort.postMessage({ created: false, error: error instanceof Error ? error.message : String(error) });
  } finally {
    store.close();
  }
}
