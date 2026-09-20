export function argumentFrom(argv, name, fallback = '') {
  const index = argv.indexOf(name);
  return index >= 0 ? String(argv[index + 1] || '').trim() : fallback;
}

export function resolveBilibiliSpaceTarget(argv = process.argv) {
  const midArg = argumentFrom(argv, '--mid');
  const urlArg = argumentFrom(argv, '--url')
    || argv.find((value) => /space\.bilibili\.com\/\d+/.test(String(value)))
    || '';
  const fromUrl = String(urlArg).match(/space\.bilibili\.com\/(\d+)/);
  const hostMid = String(midArg || fromUrl?.[1] || '').trim();
  if (!/^\d+$/.test(hostMid)) {
    throw new Error('需要 --mid <uid>，或带上 https://space.bilibili.com/<uid>/dynamic');
  }
  return {
    hostMid,
    spaceUrl: `https://space.bilibili.com/${hostMid}/dynamic`,
  };
}
