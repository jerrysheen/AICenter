# AI Center 内容与提交指引

本文用于约束 AI Center 后续开发中的内容归属、文档维护和 Git 提交。目标是保持当前架构边界稳定，避免个人数据、运行状态和平台核心代码重新混在一起。

## 当前仓库的分发模式

当前仓库是**私有完整部署快照**，不是准备公开发布的纯 Core 仓库。Core / Instance / Host 描述的是 ownership 和运行边界，不等于所有 Instance 文件都必须被 Git 忽略。

为了让另一台 Windows 机器恢复当前单用户 AI Center，当前基线有意版本化：

```text
data/ai-center.db
data/imports/
data/blobs/
knowledge/
config/markets.json
config/tags.json
config/taxonomy.json（存在时）
externaltools/bsk.exe
```

以下内容仍然只属于主机本地，不进入 Git：

```text
.env / Instance .env
API Key / Token / Cookie
Browser Profile
*.db-wal / *.db-shm
.ai-data/ / runtime/ / logs/ / processes.json
签名材料与本机缓存
```

未来抽取“只包含工具和中立模板的 Core”是独立工作；不要为了那个未来目标删掉当前私有部署快照。

---

## 一、内容指引

### 1. 先判断内容属于 Core、Instance 还是 Host

新增任何代码、配置或数据前，先判断其归属。

```text
AI Center Core
平台具备什么能力

AI Center Instance
这个人如何使用平台，以及这个人的数据、知识和投资体系

Host Services
这台机器为多个 Instance 提供什么基础设施
```

### Core

Core 只保存平台能力、业务规则和稳定契约。

典型内容：

```text
apps/
packages/contracts/
packages/domain/
packages/runtime/
packages/source/
packages/connectors/
packages/database/
packages/instance/
```

允许进入 Core：

* Web / Harmony UI
* Domain Service
* Agent Runtime
* Tool Registry
* Source / Connector
* 数据 Contract
* SQLite Schema / Migration
* 通用 Import / Export Contract
* Instance 配置解析
* 通用默认模板

Core **不得保存某一个用户的真实投资状态或个人选择**。

不得重新出现：

* 真实持仓数量、成本价、账户余额
* 固定个人券商账户 ID
* 个人观察池
* 个人投资 Tag
* 个人 Knowledge
* 个人 Taxonomy
* 浏览器登录状态
* Cookie / Token / API Key
* 本机路径

---

### Instance

Instance 是单个用户完整 AI Center 的个人状态空间。

标准内容包括：

```text
<instance>/
├─ data/
│  └─ ai-center.db
├─ knowledge/
├─ config/
│  ├─ markets.json
│  ├─ tags.json
│  └─ taxonomy.json
├─ imports/
│  └─ personal-assets.xlsx
├─ runtime/
└─ .env
```

典型 Instance 数据：

* Portfolio / HoldingLot / Cash
* 信息流与 Capture
* 灵感
* Knowledge
* AI Session / Run
* 用户自己的 Market Catalog
* Tag Catalog
* Taxonomy
* 个人资产工作簿
* Instance Browser ID
* Instance API 配置

当前仍然只要求 **Single-user Instance** 完整工作。

不要提前建设：

```text
User
Tenant
Membership
多人权限后台
Instance Manager
动态加载用户 JS
```

真正出现第二个长期用户后再继续设计。

---

### Host Services

Host 是机器级公共运行能力：

```text
BrowserSkill daemon
可选 cloudflared（只转发 AI Center Web）
本机 SearXNG（legacy，不再作为 search.web 默认 Provider）
```

原则：

* Host Service 不属于任何一个 Instance。
* Instance 可以引用 Host Service。
* 停止某个 Instance 不应关闭 Host Service。
* 不在 Instance 的 `processes.json` 中声明 Host Service ownership。
* BrowserSkill 可以连接多个浏览器，由 Instance 的 `browserId` 选择自己的浏览器登录态。

---

## 二、个人数据必须通过 Contract 进入系统

不要再把个人数据写成 JS 常量。

例如持仓的正确链路：

```text
Excel / JSON / 券商 / 手工录入
              ↓
       PortfolioImport
              ↓
        TradingService
              ↓
      TradingRepository
              ↓
           SQLite
```

运行时持仓唯一真源：

```text
Portfolio
HoldingLot
PortfolioCash
```

进程启动不得自动写入或恢复某个人的持仓。

旧数据迁移只能通过显式 Import 完成。

---

## 三、配置与默认模板的关系

仓库可以保存：

```text
config/markets.default.json
config/tags.default.json
config/taxonomy.default.json
```

这些文件必须是**中立模板**。

用户自己的：

```text
markets.json
tags.json
taxonomy.json
```

属于 Instance，不属于 Core。

判断标准：

> “换一个完全不同的用户，这个内容是否仍然应该默认存在？”

如果答案是否定的，就不应该进入 `.default.json`。

例如：

```text
标普 500
黄金
美元
基础股票市场
```

可以作为通用模板。

而：

```text
CPO
利基存储
AI 算力链
某个人长期跟踪的一组公司
```

属于 Instance。

---

## 四、Knowledge 与 Taxonomy

Knowledge 是用户自己的长期认知资产，不应与 Core Code 混合。

```text
Instance knowledge/
```

保存用户可复用的：

* Framework
* Concept
* Mechanism
* Thesis
* Procedure
* Case

数据库中的 Knowledge Document / Revision 仍由 SQLite 管理。

Taxonomy 同样属于 Instance。

历史 V16 已写入现有数据库的 Taxonomy 保持不动：

```text
不删除
不重写历史 Migration
不迁移当前 Lily DB
```

旧 `taxonomy-seed.js` 只作为 Legacy Bootstrap 保留，不继续加入新的个人节点。

---

## 五、Browser 使用边界

业务 Connector 不管理浏览器身份。

统一链路：

```text
Instance
   ↓
AI_CENTER_BROWSER_ID
   ↓
BrowserRuntime
   ↓
BrowserSkill
   ↓
对应 Chrome
```

X、Bilibili 等 Connector 只调用 BrowserRuntime。

它们不应该知道：

```text
用户是谁
Chrome Profile 在哪里
Cookie 是什么
BrowserSkill daemon 如何启动
```

---

## 六、文档维护规则

文档分四层。

### README.md

只回答：

```text
这是什么
现在是什么状态
怎么启动
去哪里继续看
```

不要塞大量历史实现过程。

---

### docs/release-readiness.md

这是**当前版本事实的最高优先级说明**。

记录：

* 当前基线
* 已实现但待验收的能力
* 发布门槛
* 当前真实风险
* 本轮明确不继续扩大的内容

如果 README、历史 Progress 和这里冲突，以这里为准。

---

### 稳定架构文档

主要包括：

```text
docs/architecture.md
docs/architecture-modules-v1.md
docs/architecture-agent-v1.md
docs/contracts-v1.md
docs/product-v2.md
```

它们记录当前稳定规则。

例如：

* Core / Instance / Host
* Domain ownership
* Source / Connector 边界
* Agent Runtime
* 数据 Contract
* PortfolioImport
* Knowledge / Tag / Taxonomy

不要把临时调试过程长期写进这些文档。

---

### docs/progress/

只记录一次具体工作的过程和决策。

格式建议：

```text
YYYY-MM-DD-topic.md

目标
决定
改动
验证
遗留
```

Progress 是历史。

> Progress 可以解释“为什么当时这么做”，但不能覆盖当前 Architecture 和 Release Readiness。

---

## 七、代码修改原则

每次新增能力先问：

```text
1. 这是平台能力还是个人状态？
2. 数据真源在哪里？
3. 是否已有 Contract？
4. 是否已有 Domain / Repository owner？
5. 是否需要新的 Source，而不是直接调 Connector？
6. 是否会把 Provider 字段泄漏到页面？
7. 是否会产生隐式初始化或启动副作用？
```

优先扩展现有边界，不轻易新增：

```text
新的 Registry
新的 Router
新的 Agent
新的数据库体系
新的“万能 Manager”
```

---

# 八、提交指引

## 1. 提交目标

当前第一版提交应该表达的是：

> AI Center 已形成可运行的 0.2.0 基线，并完成 Core / Instance / Host 的基础架构收束。

不是：

> 所有长期能力已经完成。

当前明确没有完成：

* 多用户 / Tenant
* Instance Manager
* 完整 Backup / Restore
* 自动交易
* 完整交易流水会计
* 动态自定义 Tool
* Vector DB
* 多 Agent

---

## 2. 提交前必须运行

```powershell
npm run check
```

必须确认：

```text
syntax
source syntax
contracts typecheck
architecture verify
Harmony verify
tests
```

全部通过。

任何失败都应先修复，不带着“已知红灯”做基线提交。

---

## 3. 提交前检查 Git 内容

先看：

```powershell
git status --short
```

当前私有部署快照应确认 SQLite、Knowledge、个人 Catalog 和必要导入资料都已进入 Git，同时确认没有把以下主机秘密或瞬时状态加入 Git：

```text
.env
Instance .env

*.db-wal
*.db-shm

.ai-data/
runtime/
logs/
processes.json

Browser Profile
Cookie
Token
API Key
本机缓存
真实公网 Hostname
签名文件
临时输出
```

如果发现这些主机秘密或瞬时文件，不是“提交后再删”，而是提交前解决 `.gitignore` 或文件位置。可移植的个人业务内容不属于此排除列表。

---

## 4. 默认允许提交的内容

通常应该提交：

```text
apps/
packages/
scripts/
test/
docs/

README.md
AGENTS.md
package.json
package-lock.json
.env.example

config/*.default.json
config/searxng-settings.yml

data/ai-center.db
data/imports/
data/blobs/
knowledge/
config/markets.json
config/tags.json
config/taxonomy.json
externaltools/bsk.exe
```

第三方二进制文件只有在：

```text
确定需要 vendoring
许可证允许
来源明确
仓库明确决定维护
```

时才提交。

否则通过安装说明或路径配置提供。

---

## 5. Stage 后再次检查

不要直接：

```powershell
git add .
git commit
```

然后不检查。

至少执行：

```powershell
git diff --cached --stat
git diff --cached --name-only
git diff --cached --check
```

然后重点检查：

```powershell
git diff --cached
```

确认：

* 没有秘密
* 可移植的 Instance 内容齐全且放在 Instance 路径
* 没有本机绝对路径
* 没有临时 Debug
* 没有旧架构重新混进来
* 没有大段无关生成文件

---

## 6. 第一个基线提交建议

提交信息建议：

```text
feat: establish AI Center 0.2.0 baseline
```

如果希望突出这一轮最重要的架构变化：

```text
feat: establish AI Center baseline with instance boundaries
```

正文可以写：

```text
- establish Core / Instance / Host service boundaries
- add single-user instance configuration and isolated runtime paths
- move holdings to SQLite-backed PortfolioImport flow
- externalize market, tag and taxonomy configuration
- unify BrowserRuntime and host-level BrowserSkill/SearXNG services
- stabilize single Agent, SourceHub, Knowledge and Harmony workflows
- add architecture, contract, security and regression tests
```

---

## 7. 提交完成后的状态

提交之后：

```powershell
git status
```

理想结果：

```text
working tree clean
```

允许继续存在的只能是明确被 Git ignore 的个人运行数据。

然后记录：

```text
commit hash
npm run check 结果
当前版本号
```

这一个 Commit 就作为后续开发的稳定回退点。

---

# 九、后续开发停止线

第一版提交完成以后，暂时不要继续围绕“未来多人”扩大架构。

后续出现新需求时继续遵守：

```text
平台能力
→ Core

个人数据 / 方法 / 配置
→ Instance

机器公共基础设施
→ Host
```

等第二个真实长期 Instance 出现，再根据真实问题补：

```text
Instance Backup / Restore
Instance Manager
更严格 Browser Binding
服务器进程编排
独立域名 / 反向代理
```

不要根据假设提前建设 SaaS。

---

## 当前架构的一句话定义

> AI Center 是一个 Local-first、Single-user Instance 的个人 AI 信息与投资研究平台。Core 提供能力，Instance 保存个人数据与认知体系，Host 提供机器级公共服务；当前优先保证单 Instance 的完整、稳定和可复原，并为未来复制多个独立 Instance 保留清晰边界。
