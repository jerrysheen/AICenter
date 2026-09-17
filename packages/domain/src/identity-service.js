export function createIdentityService({ identityRepository }) {
  if (!identityRepository) throw new Error('identityRepository is required');

  return Object.freeze({
    authorizeDevice(token) {
      return identityRepository.authorizeToken(token);
    },
    createPairingCode(ttlMinutes) {
      return identityRepository.createPairingCode(ttlMinutes);
    },
    pairDevice(input, options = {}) {
      const result = identityRepository.redeemPairingCode(input.code, input.deviceName, options);
      if (result) identityRepository.recordBehavior('device.paired', result.device.id, { source: 'pairing' });
      return result;
    },
    revokeDevice(deviceId) {
      return identityRepository.revokeDevice(deviceId);
    },
    listDevices() {
      return identityRepository.listDevices();
    },
    recordBehavior(event, deviceId = null) {
      identityRepository.recordBehavior(event.name, deviceId, event.metadata);
    },
    getMetrics() {
      return identityRepository.getMetrics();
    },
  });
}
