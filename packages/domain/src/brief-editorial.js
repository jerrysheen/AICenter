import {BRIEF_ARTICLE_VERSION} from '../../contracts/src/report.js';

// Whole articles are the new reading/reference unit; legacy topic IDs remain resolvable.
export function editorialReadingItems(editorial) {
  if(editorial?.status!=='ready') return [];
  if(editorial.version!==BRIEF_ARTICLE_VERSION) return editorial.directions.flatMap(d=>d.topics);
  return editorial.directions.map(d=>{
    const paragraphs=[d.lead,...d.sections.flatMap(s=>s.paragraphs)];
    return {id:d.id,title:d.articleTitle,body:[d.lead.text,...d.sections.flatMap(s=>[s.heading,...s.paragraphs.map(p=>p.text)].filter(Boolean))].join('\n\n'),
      itemIds:[...new Set(paragraphs.flatMap(p=>p.itemIds))],
      evidence:[...new Map(paragraphs.flatMap(p=>p.evidence).map(e=>[JSON.stringify(e),e])).values()],
      occurredAt:Math.min(...paragraphs.map(p=>p.occurredAt))};
  });
}
