# 生态外链核实记录

核实日期：**2026-10-22**（本机 `curl -sL -o /dev/null -w "%{http_code}"`，超时 15–20s）。  
来源优先级：官方 X 简介链接 → 官方站点页脚/导航 → mechanism-ssot【已核实】合约地址（浏览器用 OKLink）。

## FabX · @Fabx_global

| URL | 来源 | HTTP | 备注 |
|-----|------|------|------|
| https://fabx.tech/ | fabx.tech 首页与 @Fabx_global 互链；首页 HTML 含 `https://x.com/Fabx_global` | 200 | |
| https://fabx.tech/zh/pod | fabx.tech 导航 / Pod 入口 | 200 | |
| https://fabx.tech/zh/pod/formula | 官方公式（mechanism-ssot §2.1 出处） | 200 | |
| https://fabx.tech/en/circuits | fabx.tech 导航；Miner Desk 已用同一 URL | 200 | |
| https://fabx.tech/en/market/0xbe6f94115d32f3ac3252bc4626573e739beeb714-0 | fabx.tech 导航（VITE_TRANSISTORS） | 200 | |
| https://fabx.tech/en/deweb | fabx.tech DeWeb 列表 | 200 | |
| https://x.com/Fabx_global | fabx.tech 首页 `https://x.com/Fabx_global` | 200 | X 简介页 curl 为 CSR，未解析 bio 文本；以官网互链为准 |
| https://t.me/fabx_tech | fabx.tech 首页 HTML | 200 | |
| https://www.oklink.com/xlayer | FabX 前端 `explorer` 配置（indexed-mCl0T3Dn.js） | 200 | |
| https://www.oklink.com/xlayer/address/0x4f6a2312d80753bdafd35ddb1bf4bb14c43f8265 | mechanism-ssot F1 / desk.mjs `CFG.mining` | 200 | |
| https://www.oklink.com/xlayer/address/0x72f349b1eee7833b26f8c81a8410775a4e231ed2 | FabX 前端 `VITE_XMAKE_ADDRESS` | 200 | |
| https://www.oklink.com/xlayer/address/0x87bfca3494aa228ff589ab9b642143a5e8c8f9a6 | desk.mjs `CFG.circuits` | 200 | |
| https://www.oklink.com/xlayer/address/0xbe6f94115d32f3ac3252bc4626573e739beeb714 | FabX 前端 `VITE_TRANSISTORS_ADDRESS` | 200 | |
| https://www.oklink.com/xlayer/address/0x2f90b730bb696c1567f1eb8d0ba26b96d3b7a821 | mechanism-ssot §4.5 boost() | 200 | |
| https://www.oklink.com/xlayer/address/0xe566f9f6f20c19e2afbd0bb9028a2517d55bf5f5 | FabX 前端 `VITE_POD_LENS_ADDRESS` | 200 | |

**未列入 /links/**（自动化未通过或未作官网入口）：

| URL | 原因 |
|-----|------|
| https://api.fabx.tech | 根路径 HTTP 404（子路径 API 正常，无独立文档页） |
| https://bscscan.com/address/… | curl HTTP 403（Cloudflare）；TapeOut 前端仍指向 BscScan，本站用 OKLink |

## TapeOut · @TapeOutWorld

| URL | 来源 | HTTP | 备注 |
|-----|------|------|------|
| https://tapeout.net/ | @TapeOutWorld 简介 `tapeout.net`（第三方镜像摘录 + 官方新闻 tapeout.link 认 @TapeOutWorld 为官方号） | 200 | |
| https://tapeout.net/pod | TapeOut 客户端挖矿路由 | 200 | |
| https://x.com/TapeOutWorld | tapeout.link 新闻「官方 X 账号 @TapeOutWorld」 | 200 | |
| https://t.me/TapeOutnet | 社区 SSOT 与生态常用群；**未**在 tapeout.net 静态 JS 中检出；HTTP 200 | 200 | 标为官方 Telegram 前建议人工对照 @TapeOutWorld 简介 |
| https://www.oklink.com/bsc | tapeout.net 前端引用 oklink/xlayer；BSC 用 oklink/bsc | 200 | |
| https://www.oklink.com/bsc/address/0x7e2e0dc66a3bd9103e69b766afa62d9f7b697b46 | mechanism-ssot T1 / pod.mjs | 200 | |
| https://www.oklink.com/bsc/address/0x5ce033b2bfca3af30b3e8c8457deaf776a8b695a | mechanism-ssot token() 读数 | 200 | |
| https://www.oklink.com/bsc/address/0xb1024b89886b9a34aa4ff5f31c411d708b20a14c | mechanism-ssot T7 / pod.mjs | 200 | |
| https://www.oklink.com/bsc/address/0x1f5cb4aeaE1807Bf60c3b9C0D8aDBCC14e91f12C | mechanism-ssot T7 / pod.mjs | 200 | |

**未列入**：

| URL | 原因 |
|-----|------|
| https://tapeout.net/rpc | HTTP 403（RPC 端点，非人类文档页） |

## 社区工具（非官方）

| URL | 来源 | HTTP | 备注 |
|-----|------|------|------|
| https://r1-f6ee5a2b5b110171f4cf44fa1b282bca3c3afa29-deweb.fabx.tech/v/4/index.html | @0xTisane Hashrate Board DeWeb（竞品研究文档 + 本机 curl） | 200 | 页内标注「社区工具，非官方」 |
| https://x.com/0xTisane | 同上 | 403 | X 反爬；链接保留，核实记录为 curl 403 |

## 复核命令（节选）

```bash
curl -sL -o /dev/null -w "%{http_code}\n" "https://fabx.tech/"
curl -sL -o /dev/null -w "%{http_code}\n" "https://tapeout.net/pod"
curl -sL -o /dev/null -w "%{http_code}\n" "https://x.com/TapeOutWorld"
```
