export const RESEARCH_CATALOG_JOB = 'research.catalog.activate';
export const RESEARCH_REPORT_JOB = 'research.report.generate';

export const researchRecallManifest = Object.freeze({
  id: 'research.recall',
  version: '1.0.0',
  capabilities: [RESEARCH_CATALOG_JOB, RESEARCH_REPORT_JOB],
  jobTypes: [RESEARCH_CATALOG_JOB, RESEARCH_REPORT_JOB],
});

export function createResearchRecallJobHandlers(service) {
  if (!service?.activate || !service?.buildReport) throw new Error('research recall jobs require research service');
  return {
    [RESEARCH_CATALOG_JOB]: async (input = {}) => service.activate(input),
    [RESEARCH_REPORT_JOB]: async (input = {}) => service.buildReport(input),
  };
}
