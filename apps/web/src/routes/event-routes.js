export function createEventRoutes() {
  return [{
    method: 'GET',
    path: '/api/v1/events/stream',
    async handler({ request, response, identity, url, events }) {
      const lastEventId = Number(request.headers['last-event-id'] || url.searchParams.get('lastEventId') || 0);
      await events.open(request, response, identity, lastEventId);
    },
  }];
}
