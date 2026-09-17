export function createEventRoutes() {
  return [{
    method: 'GET',
    path: '/api/v1/events/stream',
    handler({ request, response, identity, url, events }) {
      const lastEventId = Number(request.headers['last-event-id'] || url.searchParams.get('lastEventId') || 0);
      events.open(request, response, identity, lastEventId);
    },
  }];
}
