import { createHash, timingSafeEqual } from 'node:crypto';

function digestSecret(value) {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest();
}

function timingSafeEqualText(left, right) {
  return timingSafeEqual(digestSecret(left), digestSecret(right));
}

export function resolveLoginCredential(env = {}) {
  const username = String(env.AI_CENTER_LOGIN_USERNAME || '').trim();
  const password = String(env.AI_CENTER_LOGIN_PASSWORD ?? '').trim();
  if (!username || !password) return null;
  return { username, password };
}

export function createIdentityService({ identityRepository, loginCredential = null }) {
  if (!identityRepository) throw new Error('identityRepository is required');
  const credential = loginCredential && loginCredential.username && loginCredential.password
    ? { username: String(loginCredential.username), password: String(loginCredential.password) }
    : null;

  return Object.freeze({
    authorizeDevice(token) {
      return identityRepository.authorizeToken(token);
    },
    loginAvailable() {
      return Boolean(credential);
    },
    loginWithPassword(input) {
      if (!credential) return { ok: false, reason: 'disabled' };
      const usernameOk = timingSafeEqualText(input.username, credential.username);
      const passwordOk = timingSafeEqualText(input.password, credential.password);
      if (!usernameOk || !passwordOk) return { ok: false, reason: 'invalid' };
      if (typeof identityRepository.issueDevice !== 'function') {
        throw new Error('identityRepository.issueDevice is required');
      }
      const result = identityRepository.issueDevice(input.deviceName);
      identityRepository.recordBehavior('device.paired', result.device.id, { source: 'password' });
      return { ok: true, device: result.device, token: result.token };
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
