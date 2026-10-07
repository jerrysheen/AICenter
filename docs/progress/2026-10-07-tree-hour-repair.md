# 2026-10-07 指定小时最小修复与后续验收

## 当前边界与实际时刻

本轮只修现有四项问题，并验收北京时间2026-10-07 08:00—09:00，UTC毫秒1791331200000—1791334800000。实例配置核对为Asia/Shanghai、tree-v3。首次诊断时为北京时间00:47，窗口尚未开始；Feed/媒体保存窗口记录均0、信息头0、定向小时Job0、发布头0。不能把未来窗口无稿写成后台漏生成。用户明确确认仍按今天该窗口，结束后验收。

已通过Codex应用工具设置本聊天单次后续执行：2026-10-07 09:10（Asia/Shanghai），自动任务ID `10-7-08-09`，一次执行。没有新增产品Job类型、Runtime、模型客户端或全天重跑。本轮定向新增真实模型请求为0；同期原Worker的正常自动采集/模型消耗不计成本轮。

## 已证实的现有断点

原brief-page默认读取旧小时底稿/方向长文，tree-v3后台新树不会更新这个入口；独立树页面只在mount读取清单，没有自动检查新发布版本。原日报短模块直通条件继承children.every(safePassthrough)，导致长信息稿已被小时层浓缩合格后仍再次付费。原目录缺一般通信/数据中心类，主Tag纠错后会退到null。这些是代码层事实，不是本窗的唯一根因。

## 修复实现

- 简报入口根据既有树只读接口返回的显式pipeline进入树刊期；历史简报继续访问旧稿。方向导航保留金融/政策/科技/其他，使用版本化目录展示映射，直接展示既有模块，不生成方向长文。
- 每30秒、恢复可见时及重新进入页面检查新版本；提示接受更新。所选窗口与所读editionId分别记录，接受时保留窗口、方向、Tag、展开与滚动位置，新增时段不强迫跳走。状态明确partial/待补和旧已发布版本。
- 三份原Skill增加对象/产品/方法及动作的标题规则。对上一版信息Prompt哈希4935e6e8687998ff6e31481bf12aa56564e303ce286af730f827dc75a8361647建立明确兼容，仅复用已通过当前validator的正稿；不改写已有text或译文，不冒称旧稿用了新提示词。prepare复用前仍核对正文draftKey与来源版本，配置变化不静默忽略。旧坏短稿不批量改写。
- 目录新增communications（普通通信、卫星网络、海缆）和datacenter（普通数据中心），与明确AI用途的ai_compute分开。目录版本为tree-reading-v2，旧目录指纹d1d36f44383620e30bb6564ccf6e7cae8a72ef888f119d40bbce5ed696a99e20仅对保存标题/信息稿命中相关主题词的节点补分类，其余无模型更新内部目录版本。分类不重写text、不翻译、不重新读原文；人工锁定优先。
- 新生成、validated且safePassthrough的短小时模块可直接建立日报父节点和一个直接ref，不要求信息子节点短。旧小时提示词下的短稿不能冒充新规则已合格。缓存和pipeline策略覆盖兼容规则及直通策略。
- 原report.hourly.extract返回main editionId、window、status、published、pendingCount及groupFailureCount；Job完成不等于ready或完整发布。

## 本轮文件

`apps/web/public/{brief-page.js,information-tree.js,styles.css}`、`apps/web/src/server.js`、`packages/domain/src/{index.js,information-tree-service.js,information-tree-policy.js}`、`packages/contracts/src/tagging.js`、`config/tags{,.default}.json`、`packages/runtime/src/report-module.js`、`packages/runtime/src/information-tree/skills.js`及三份`skills/{information,hourly,daily}.md`。新增只读`inspect-tree-hour.mjs`和受控浏览器验证`verify-tree-live-update.mjs`；既有三层页面验证器适配默认入口和方向筛选。既有改动未重置、未提交。

## 已完成验证

`npm run check`：834/834通过。新增集成覆盖长信息→短小时→日报零调用直通、固定输入重复零新增调用、目录扩展仅受影响分类且正文不变、显式兼容稿复用、partial Job摘要真实。这里的模型是fake注入，不能当真实模型回放质量证据。

`node scripts/verify-tree-live-update.mjs`：受控UI夹具在390/1440px通过，浏览器故意使用UTC、刊期仍按Asia/Shanghai。页面持续打开，30秒自动发现新版本，接受前仍读旧版，接受后edition一致；时段、Tag、方向、展开、scrollY=600保持；无溢出或脚本错误。输出标明controlled-ui-fixture，不能称生产发布头已通过。

`node scripts/inspect-tree-hour.mjs`：只读生产，导出`.ai-data/tree-hour-2026-10-07/target/{result.json,hour.md}`。目前明确not-started、无正文；未把其他小时、语义示例或夹具当本窗新闻。该脚本窗口结束后会完整导出所有真实模块标题/正文/直接子节点/待补/定向Job及对应账本记录。

## 生产加载与待完成验收

当前生产Web/Worker仍在运行旧内存配置；静态文件已编辑，但后台pipeline/目录/Skill需正常重载。检查时有report.information.prepare及report.hourly.extract在途，不强杀、不重置Job、不写restart.request打断。尚未宣称本轮生产加载完成。已有服务保持可用。

原09:10后续执行已在用户要求立即执行全链路后取消，以下最新执行记录覆盖先前等待方案。正式后台新策略仍须在无活动任务时备份并正常重载；不强杀模型、不重置Job。

冻结本窗有效输入完成后再原样执行一次，核对无新付费调用、不为换标题重新加工。统计准备/分类/小时的本次请求、SDK重试、失败、缓存和实际报告Token，明确排除其他自动Job；成本未知不填0。新增应用调用最多30或总耗时30分钟，到限留结果，不反复跑到好看。

最终完整导出实际正文，核对科技对象/动作、数字对象与状态，明确ready/partial及不可补原因；正式页面持续打开验证自动更新、接受后所读editionId=正式发布头，390/1440px方向、单ref、逐层展开、原文、筛选/位置与权限。当前尚未完成这部分真实小时/真实模型/正式发布验收。回退沿用legacy并正常重载，保留所有数据/节点/用量，不撤销已执行迁移、不导入隔离库。

## 用户要求立即执行全链路后的记录

通过已有RuntimeService/Repository排队注册Worker任务，实际刷新26个媒体源新增34条；X推荐新增15、关注新增1，雪球快讯新增3。没有新增来源、外网模型客户端、Runtime或Token账本。准备任务优先级只对同工作区queued Job提升，并同事务写outbox；不改变输入、不重复创建已排队的同来源准备任务、不打断running任务。

当前实际采集窗口已有8篇信息稿经现有DS Harness落盘，定向准备任务报告8次调用、0缓存命中、0待补；小时任务随后显式传入该实际hourStart。该窗口仍在进行中，不能称完整结束小时。用户所指当天09—10点在实例及外部时钟核对时仍未开始，未更改时钟或篡改材料时间。先前旧Worker把未来空窗标ready的问题新增Service防护：未来hourStart拒绝执行、不创建空刊期，回归验证零模型调用；新防护尚待后台正常重载。

正式简报入口旧后台不返回pipeline，导致静态新入口仍落旧简报，已补滚动升级兼容：显式pipeline优先，缺字段时仅当存在tree-response-v3.1.0独立信息头才启用树入口。旧目录的方向展示有兼容映射；新服务映射优先，不生成方向长文。实际8787正式页面已回读树刊期与发布版本，截图保存在实例私有验收目录。生产当前使用在途Worker的旧Skill与目录，不能把这次真实加工称新Skill质量验证。

本轮全仓检查836/836；新增优先级操作和未来窗口拒绝用例。390/1440px自动更新受控夹具复核通过，实际新闻、真实账本和真实发布结果保存于`.ai-data/tree-hour-2026-10-07/`，与受控夹具分开。

### 本轮实际完成结果

实际采集窗口小时Job已completed，正式发布头为partial，8个模块分别引用8篇冻结信息稿；6份材料在生成冻结时为information-not-ready，后台持续准备后信息视图已出现第9篇，但该新信息不能冒称已纳入此发布版本。完整正文、每模块直接子节点、6项待补及实际版本保存于实例私有`full-chain/hour.md`和`result.json`。窗口是实例北京时间2026-10-07 01:00—02:00，仍在进行中；并未交付用户指定09—10点的完整结束刊期，也未运行全天日报。

显式本轮采集/定向准备/定向小时Job账本：信息8次请求/71460已报告Token，小时3次请求/20676Token，均succeeded；采集Job内部另有1次翻译/5416Token。共11次树请求/92136Token，定向信息准备报告0缓存命中。仅request求和，不重复加turn；同期自动派生的其他准备/翻译/打标Job未纳入此定向汇总，不能称全系统总费用。供应商费用未知，没有补零。原样第二次运行尚未执行，因为窗口仍增量准备、输入集合已变化；不为了展示缓存再生成付费稿。

真实8787正式页持续打开，自动发现进度/刊期更新；接受后明确选择本窗口，390/1440px所读editionId均与该发布头完全一致，8模块展示无遗漏，每模块一个ref，展开可读直接信息稿，无横向溢出/脚本错误。截图与真实`production-ui.json`均在`full-chain/`；此前受控夹具中的版本和新闻未混入真实验收。该操作没有重载Worker，新标题/分类/直通策略仍待安全重载，不能把本次旧内存Skill生成质量说成所有四项新策略已生产验收。
