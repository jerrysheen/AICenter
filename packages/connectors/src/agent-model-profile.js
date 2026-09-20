function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function modelIdForProfile(defaultModel, researchModel, researchProfile) {
  const fallback = text(defaultModel);
  if (researchProfile?.modelProfile !== 'research') return fallback;
  return text(researchModel) || fallback;
}
