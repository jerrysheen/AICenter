import { json } from '../http/response.js';
import { createHomeBootstrapHandler, HOME_BOOTSTRAP_PATH } from '../http/home-bootstrap.js';

export function createHomeRoutes() {
  const handler = createHomeBootstrapHandler();
  return [
    {
      method: 'GET',
      path: HOME_BOOTSTRAP_PATH,
      handler(context) {
        return handler({ ...context, json });
      },
    },
  ];
}
