// Historical V16 bootstrap only. These nodes preserve already-shipped migration
// behavior and must not receive new personal taxonomy entries. New Instance
// taxonomy belongs in config/taxonomy.json via the TaxonomyCatalog contract.
const LEGACY_BOOTSTRAP_NODES = [
  ['domain.investment', '投资研究'],
  ['domain.graphics-engine', '图形 / 引擎'],
  ['domain.ai-systems', 'AI系统与自动化'],
  ['domain.game-research', '游戏与用户研究'],
  ['domain.work-career', '工作 / 职业'],
  ['domain.personal-tech', '数码 / 本地设备'],

  ['industry.semiconductor', '半导体'],
  ['industry.semiconductor.memory', '存储'],
  ['industry.semiconductor.pcb-ccl', 'PCB / CCL'],
  ['industry.semiconductor.semiconductor-materials', '半导体材料'],
  ['industry.semiconductor.optical-cpo', '光模块 / CPO'],
  ['industry.semiconductor.semiconductor-equipment', '半导体设备'],
  ['industry.semiconductor.advanced-packaging', '先进封装'],
  ['industry.semiconductor.ai-compute', 'AI 算力'],
  ['industry.metals-materials', '金属 / 材料'],
  ['industry.game-industry', '游戏产业'],
  ['industry.software-ai', '软件 / AI 应用'],

  ['market.cn-a', 'A股'],
  ['market.cn-b', 'B股'],
  ['market.hk', '港股'],
  ['market.us', '美股'],
  ['market.tw', '台湾'],
  ['market.global', '全球'],

  ['asset-class.equity', '股票'],
  ['asset-class.etf', 'ETF'],
  ['asset-class.futures', '期货'],
  ['asset-class.commodity', '商品'],
  ['asset-class.fx', '外汇'],
  ['asset-class.crypto', 'Crypto'],
  ['asset-class.rates', '利率'],

  ['platform.unity', 'Unity'],
  ['platform.webgpu', 'WebGPU'],
  ['platform.playcanvas', 'PlayCanvas'],
  ['platform.ios', 'iOS'],
  ['platform.wechat-minigame', '微信小游戏'],
  ['platform.harmonyos', 'HarmonyOS'],

  ['lens.business-cycle', '景气度'],
  ['lens.supply-chain', '产业链'],
  ['lens.macro', '宏观'],
  ['lens.valuation', '估值'],
  ['lens.event-driven', '事件驱动'],
  ['lens.portfolio', '组合 / 仓位'],
  ['lens.mechanism', '机制分析'],
  ['lens.architecture', '架构设计'],
  ['lens.performance', '性能优化'],
  ['lens.debugging', '问题排查'],
  ['lens.implementation', '实现方案'],
  ['lens.learning', '原理学习'],
  ['lens.comparison', '方案比较'],
  ['lens.ux-product', 'UX / 产品设计'],
  ['lens.user-research', '用户研究'],
  ['lens.data-analysis', '数据分析'],

  ['topic.graphics', '图形 / 引擎'],
  ['topic.graphics.gpu-driven', 'GPU Driven'],
  ['topic.graphics.gpu-driven.terrain', 'Terrain'],
  ['topic.graphics.gpu-driven.grass', 'Grass'],
  ['topic.graphics.gpu-driven.gpu-scene', 'GPU Scene'],
  ['topic.graphics.gpu-driven.visibility-virtual-geometry', 'Visibility / Virtual Geometry'],
  ['topic.graphics.virtual-texturing', 'Virtual Texturing'],
  ['topic.graphics.virtual-texturing.rvt', 'RVT'],
  ['topic.graphics.virtual-texturing.avt', 'AVT'],
  ['topic.graphics.shadow', 'Shadow'],
  ['topic.graphics.shadow.vsm', 'VSM'],
  ['topic.graphics.shadow.contact-shadow', 'Contact Shadow'],
  ['topic.graphics.ambient-occlusion', 'Ambient Occlusion'],
  ['topic.graphics.ambient-occlusion.ssao', 'SSAO'],
  ['topic.graphics.ambient-occlusion.hbao', 'HBAO'],
  ['topic.graphics.ambient-occlusion.gtao', 'GTAO'],
  ['topic.graphics.ambient-occlusion.capsule-ao', 'Capsule AO'],
  ['topic.graphics.raymarching', 'Raymarching'],
  ['topic.graphics.raymarching.screen-space-dda', 'Screen-Space DDA'],
  ['topic.graphics.lighting', 'Lighting'],
  ['topic.graphics.lighting.forward-plus', 'Forward+'],
  ['topic.graphics.lighting.clustered', 'Clustered'],
  ['topic.graphics.sdf-mdf', 'SDF / MDF'],
  ['topic.graphics.runtime', 'Runtime'],
  ['topic.graphics.runtime.csharp-gc', 'C# GC'],
  ['topic.graphics.runtime.il2cpp', 'IL2CPP'],
  ['topic.graphics.runtime.hybridclr', 'HybridCLR'],

  ['topic.ai', 'AI 系统'],
  ['topic.ai.agent-runtime', 'Agent Runtime'],
  ['topic.ai.tool-call-mcp', 'Tool Call / MCP'],
  ['topic.ai.context-reference', 'Context Reference'],
  ['topic.ai.knowledge-memory', 'Knowledge / Memory'],
  ['topic.ai.local-model', 'Local Model'],
  ['topic.ai.automation', 'Automation'],
  ['topic.ai.deployment', 'Deployment'],
  ['topic.ai.data-pipeline', 'Data Pipeline'],
  ['topic.ai.structured-output', 'Structured Output'],

  ['topic.game', '游戏研究'],
  ['topic.game.research-method', '研究方法'],
  ['topic.game.research-method.survey', '问卷'],
  ['topic.game.research-method.interview', '访谈'],
  ['topic.game.research-method.usability-ce', '可用性 / CE'],
  ['topic.game.research-method.segmentation', '分群'],
  ['topic.game.research-method.quantitative', '定量'],
  ['topic.game.research-method.qualitative', '定性'],
  ['topic.game.player-experience', '玩家体验'],
  ['topic.game.player-experience.gameplay', '玩法'],
  ['topic.game.player-experience.social', '社交'],
  ['topic.game.player-experience.monetization', '商业化'],
  ['topic.game.player-experience.liveops', 'LiveOps'],
  ['topic.game.player-experience.acquisition', '获客'],
  ['topic.game.research-report', '研究报告'],
  ['topic.game.market-research', '市场研究'],
  ['topic.game.game-design', '游戏设计'],
];

function parentKeyOf(key) {
  const parts = key.split('.');
  return parts.length > 2 ? parts.slice(0, -1).join('.') : null;
}

export function legacyTaxonomyBootstrapNodes() {
  return LEGACY_BOOTSTRAP_NODES.map(([key, name], index) => ({
    key,
    name,
    dimension: key.split('.')[0],
    parentKey: parentKeyOf(key),
    sortOrder: index + 1,
  }));
}

// Compatibility export retained while V16 remains immutable.
export function taxonomySeedNodes() {
  return legacyTaxonomyBootstrapNodes();
}

export function seedWorkspaceTaxonomy(database, workspaceId = 'local') {
  const now = Date.now();
  const insert = database.prepare(`INSERT OR IGNORE INTO taxonomy_nodes
    (workspace_id, key, dimension, name, parent_key, description, status, created_by, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, '', 'active', 'system', ?, ?, ?)`);
  for (const node of legacyTaxonomyBootstrapNodes()) {
    insert.run(workspaceId, node.key, node.dimension, node.name, node.parentKey, node.sortOrder, now, now);
  }
}
