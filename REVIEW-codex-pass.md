# FabX Miner Desk — 独立公开前审查

审查日期：2026-10-19。结论：**1 个 Blocker，2 个 Warnings；建议修复 Blocker 后再首次公开。**

依据当前源码、双语文档、测试、全部三张 PNG 与本轮实测重新判断，未读取其他审查报告。仓库尚无 commit；结论针对当前目录，不代表历史版本或线上部署。仅新增本文件，未修改源码、文档或测试。

## 🔴 Blockers

### B1 — 部分待领奖励读取失败，仍显示完整余额，可能显示假零

**位置：`desk.mjs:673`、`desk.mjs:681`、`index.html:311`、`index.html:424`、`index.html:684`；相关测试：`test/engine.test.mjs:160`、`test/engine.test.mjs:182`。**

`pendingKnown` 只要大于零，就返回成功读到的 pending 之和，没有返回 pending 的覆盖数量。页面直接显示「待领 X FAB / X FAB pending」，未说明是部分余额。持有关系完整不等于奖励读取完整；资产卡的「可测日产」说明也不能替代待领余额覆盖说明。

**本轮已复现，纯内存 mock、不联网：**复用 `test/engine.test.mjs:132` 的 `fakeWalletRpc`，确认持有两台矿机；第一台 `now=0,before=0,zeroWeight=true`，第二台 `now=null,before=null`。调用真实 `wallet()`，再用 `test/ui.test.mjs:17` 的 harness 渲染真实页面脚本，得到：

```text
discovery.complete = true
circuits = 2
rigs = [{ status: "stopped", fabPerDay: 0 }, { status: "unread", fabPerDay: null }]
pendingFab = 0
pendingUsd = 0
页面：0 FAB pending · 0% of network
```

第二台待领余额未知，整个地址的总额不能断言为零。这违反 `README.md:19` / `README.zh.md:19` 的「读不到保留未知」承诺，属于公开前必须修正的展示正确性问题，并非凭证或资金执行漏洞。

**最小修复方向：**全部相关 pending 读数已确认才显示总额；否则显示未知，或明确「已读待领小计，1/2 台」。pending 覆盖率应独立于日产可测率。补上上述失败组合的回归用例；现有测试在部分 pending 缺失时仍接受小计，136 项通过不会发现此问题。

## 🟡 Warnings

### W1 — 排放变化时，两侧比较使用不同口径，赢家可能反转

**位置：`desk.mjs:19`、`desk.mjs:526`、`desk.mjs:657`、`test/entry.test.mjs:221`；假设披露：`README.md:64`、`README.zh.md:61`、`index.html:365`。**

新建基准固定按 7,128 FAB/日计算，挂牌矿机则按链上 `currentRate` 校验实测日产。本轮复用现有半排放 fixture（`emissionRate=4166666`，已验证排放 3,564 FAB/日），实际得到：新建显示 **1.323526**、挂单 **1.676799** OKB/(FAB/日)，结论为新建更便宜；按同一实际排放算，新建应为 **2.647423**，赢家应是挂单。

固定排放假设已有披露，本轮没有证据证明当前链上排放已改变，因此列为条件性警告。建议两侧共用同一区块的实际排放，或在实际排放与模型不符时停止给出「更便宜」结论，并醒目标注假设不匹配。

### W2 — 资产卡截图裁掉公开示例说明，单独查看容易误认为作者资产

**位置：`README.md:35`、`README.md:96`、`README.zh.md:33`、`README.zh.md:92`；页面说明：`index.html:311`、`index.html:424`；图片：`docs/screenshots/asset-card-mobile-v3.png`（二进制图片无文本行号）。**

图片直接从「我的矿机资产卡」开始，包含估值、日产与回本数字，未包含地址或公开示例标注。README 链接文字及隐私段落已解释示例归属，实际页面也有中英文说明，所以不判定为私人仓位泄漏。建议截图内保留「公开示例、非作者持仓、历史快照」说明，使点击原图或独立转发时仍有上下文；截图数字本身不能独立证明地址归属。

## 🟢 OK

- **公开信息扫描未发现凭证或私人环境指纹。** 检查全部文本文件与隐藏文件清单，未发现私钥、助记词、API key/token、私人邮箱、本机绝对路径、主机名、内部任务号或私人策略预设。64 位十六进制命中可对应池 ID、槽位、事件或交易哈希。公开署名、社交链接及通用 localhost 命令属于有意公开内容。依据：`desk.mjs:8`、`desk.mjs:32`、`index.html:484`、`README.md:96`、`README.md:107`、`README.md:153`、`test/fixtures/fab-bem-swap.json:13`。

- **三张截图已目视检查并检查 PNG 元数据。** 未见个人桌面、账号界面、邮箱、本机路径、凭证或文本/EXIF 隐藏信息；ICC 色彩信息未见身份数据。首页数字是行情与模型输出；资产卡的公开示例属性由文档说明，独立图片限制见 W2。依据：`README.md:33`、`README.md:35`、`README.md:96`。

- **公开示例确有页面说明。** 本轮在本地 Chrome 点击示例后成功显示 76 台矿机；中文显示「这是一个链上公开大户的示例地址」，英文显示「example: a large public holder」。代码不会将示例保存为上次地址。这确认当前页面标注与查询行为，不证明地址背后的现实身份。依据：`desk.mjs:34`、`index.html:311`、`index.html:424`、`index.html:894`、`index.html:955`。

- **只读边界符合文档。** RPC 允许列表只有四种读取方法；钱包请求仅在用户按钮事件中调用 `eth_requestAccounts`，未发现签名、代币授权或广播交易路径。隐私说明覆盖 RPC/API 查询、local storage 及地址 URL 先到静态主机的行为。依据：`rpc.mjs:8`、`rpc.mjs:21`、`index.html:933`、`index.html:943`、`index.html:965`、`README.md:90`、`README.zh.md:86`。

- **未发现外部字符串直接触发的 HTML 注入路径。** 外部矿机 ID 经 `esc`，外链采用固定 HTTPS 域名并编码 ID；错误使用 `textContent`，数值经过格式化，状态文案来自固定映射。这是当前源码检查结果，不是对未来修改的保证。依据：`index.html:465`、`index.html:467`、`index.html:479`、`index.html:639`、`index.html:722`。

- **公共 RPC 调用有界。** 每次状态请求对每个端点最多尝试一次，有超时、共享 cooldown 与退避；日志只缩小明确超范围的查询，达到下限后终止；界面重试间隔 60 秒，隐藏页面暂停。未发现失败后的紧密无限重试。依据：`rpc.mjs:47`、`rpc.mjs:152`、`rpc.mjs:188`、`desk.mjs:61`、`desk.mjs:87`、`index.html:784`、`test/ui.test.mjs:59`。

- **文档核心技术口径与实现一致，B1/W1 除外。** 八项地址及池 ID 与配置一致；FAB/BEM 反比平方、NAND 完整卖单簿最低有效价、同区块所有权确认、完整枚举后排名、约十分钟奖励差分及未知日产处理有代码支持。资产估值注明为 NAND 等效重置成本，非购买成本或转售价；费用、深度和未来稀释限制已有披露。依据：`README.md:41`、`README.md:59`、`README.zh.md:39`、`README.zh.md:56`、`desk.mjs:117`、`desk.mjs:415`、`desk.mjs:496`、`desk.mjs:542`、`desk.mjs:615`、`nand-price.mjs:58`。

- **中英文语义一致，风险提示与 MIT 许可齐全。** 未发现影响使用的双语矛盾，中文表达自然；两版均说明示例、参考价、静态假设与不构成投资建议。未知网络增速显示为「未测，假设 0 增长」，有假设标记，与 B1 的未知余额假零不同。依据：`README.md:96`、`README.md:132`、`README.zh.md:92`、`README.zh.md:128`、`index.html:701`、`index.html:744`、`LICENSE:1`。

- **离线测试数亲自核验通过。** 执行 `node --test`，Node.js **v25.9.0**：**136 tests / 136 pass / 0 fail / 0 cancelled / 0 skipped / 0 todo**，退出码 0，与 README 一致。测试使用模拟 provider 与固定样本；两个额外内存反例未计入这 136 项。依据：`README.md:104`、`README.md:125`、`README.zh.md:121`、`test/data.test.mjs:13`、`test/ui.test.mjs:17`。

- **Quick start 实际可启动，浏览器关键流程可用。** 按 README 运行 `python3 -m http.server 8765 --bind 127.0.0.1`，Python **3.14.6**；首页、四个模块及 `/rigs/` 均 HTTP 200，模块 MIME 正确，相对软链接有效。真实 Chrome 加载建机/挂单比较，回本入口一击展开，示例查询与中英文切换正常；本次读取的控制台 error/warn 列表为空。可选 24h 行情显示暂不可用，核心比价与资产卡仍正常。临时服务器和审查标签页已关闭。依据：`README.md:79`、`README.md:98`、`README.md:119`、`README.md:136`、`index.html:229`、`index.html:955`。

验证边界：`README.md:75` 的公开仓库 clone/源码下载需首次发布后复核，本轮从给定源目录运行；`README.md:126` 的历史 390px/320px 布局记录未重新做完整尺寸矩阵；`README.md:138` 的可升级合约安全性不属于本次静态网页审计。这些未验证项没有被计为通过；审查不构成发布授权。

## 修复记录

2026-10-19，在 `chore/public-release` 分支、基线 `254c946` 上定向修复 B1、W1、W2。

- **B1：待领总额与已读小计分离。** `wallet()` 返回独立的 `pendingKnown`、`pendingTotal`、`pendingSubtotalFab`、`pendingComplete`。只有持有关系完整且每台当前 pending 均成功读取时，`pendingFab` / `pendingUsd` 才是总额；否则保留 `null`。中英文摘要和资产卡显示「已读待领小计 X FAB（n/m 台）」或未知。历史奖励、历史区块头或排放缺失不再抹掉可读的当前 pending，待领覆盖率与日产可测率独立。`test/engine.test.mjs` 覆盖报告的停机零值 + 未知组合、全部未知/哨兵值、完整余额、部分持有发现及空地址；`test/ui.test.mjs` 用纯内存 RPC mock 调用真实 `wallet()`，再运行真实页面脚本，验证两语言均不把部分零值显示为总额。`test/wallet-speed.test.mjs` 同步断言部分读数为小计。

- **W1：新建基准与挂单共用实际排放。** 使用挂单同一区块的 `currentRate` 和 `unverifiedBps`，按合约整数扣除未验证份额后换算已验证 FAB/日，再用 `networkNand / (verifiedFabPerDay - 1)` 计入新增权重稀释。缺失/无效排放时不提供赢家，页面醒目标明「假设未核实」；零排放或不足以支持 1 FAB/日时不给出建机基准。入场缓存升级为 v2，避免旧固定排放结论回流。`test/entry.test.mjs` 的半排放 fixture（`emissionRate=4166666`）得到 3,564 FAB/日，新建约 2.647423、挂单约 1.676799 OKB/(FAB/日)，断言赢家为挂单且排放读取固定在挂单区块；另覆盖缺失/无效/零排放、空挂单及旧缓存。UI 测试验证双语未核实提示和实际排放来源。双语 README 与页面口径同步：入场比价使用实际排放，其他静态回本/情景及重置估值仍明确披露 7,128 假设，不冒充当前排放。

- **W2：截图独立保留示例上下文。** 两版 README 的截图说明和隐私段落明确「公开示例地址、非作者持仓、历史快照」。资产卡本身加入完整示例地址和同义双语说明，UI 测试确认普通地址不会被误标为示例。通过临时静态服务器和 Chrome 重截 `docs/screenshots/asset-card-mobile-v3.png`，390 × 1032，图片内保留上述说明及待领覆盖率。已目视检查：仅网页卡片，无桌面、浏览器地址栏或本机信息；PNG 无文本/EXIF 元数据。临时标签页和服务器均已关闭并回读确认。

验证：`node --test test/engine.test.mjs test/entry.test.mjs` **39/39**，`node --test test/ui.test.mjs` **44/44**，`node --test test/wallet-speed.test.mjs` **15/15**；最终 `node --test` **156 tests / 156 pass / 0 fail / 0 cancelled / 0 skipped / 0 todo**，均退出码 0。全部回归使用内存 mock 或固定样本，不联网；截图另为公开示例的只读浏览器观察。`git diff --check` 通过。本次仅本地提交，不推送；未重跑完整浏览器尺寸矩阵，不构成发布授权。
