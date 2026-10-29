# LINE 私域接入设计稿（v5.3 · 批4 · 用户"正在研究如何接入 LINE"占位）

> 状态：设计稿（未实现）。数据地基已有：schema.sql LineMember / LineBind 两表。
> 终极蓝图 §-1：「未来沉淀 LINE 私域」是引流软件的变现命脉（平台客户 → 可反复触达的私域）。

## 1. 现状与目标
- 现状：Ai SAY 在平台内话术会「要 LINE」，但换到 LINE 后**没有承接运营**（好友管理/消息中转/再触达全空白）。
- 目标：平台客户沉淀到 LINE OA → 私域可反复触达，不被平台封、不受平台限流。

## 2. 接入方式选型（三条路）
| 方式 | 说明 | 合规/成本 | 推荐 |
|---|---|---|---|
| LINE OA（官方账号） | 用 LINE Login + Messaging API，机器人主动发 | 需企业认证 + 月费；合规，可收信息 | ★★★ 主选 |
| LINE 个人号 + 第三方代接 | 个人 LINE 直接导，用中间号 | 高风险（违反 LINE ToS，易封号） | ✗ 仅研究 |
| 二维码加好友（引流） | 客户扫 LINE 码加 OA，平台内发码 | 合规，但转化依赖客户主动加 | 配合主选 |

**结论**：走 **LINE OA + Messaging API**（合规、可自动再触达、不怕单客户消息费）。个人号代接只做技术可行性研究，不上线。

## 3. 数据模型（已建地基，需扩）
- LineMember（已建）：LINE 侧成员画像（lineUserId / display / openId）。
- LineBind（已建）：平台 Contact ↔ LINE lineUserId 绑定（导流成功才写）。
- 需扩：
  - LineMember 加 `channelAccessTokenRef`（指向配置，不落 token 明文，§0.3 密钥不进 Git）
  - LineBind 加 `bindAt / source`（绑定时间 + 来源=平台内 which 话术触发的）
  - 新表 **LineMessageLog**（append-only，镜像 Message 结构）：LINE 侧消息流水，供看板/审计

## 4. 链路（平台 → LINE 闭环）
```
① 平台内：SOP 推 ライン（followupSop nudge/understand，软推进，不直说 LINE 品牌）
② 客户同意 → 给 LINE OA 二维码（或 line.me 链接，平台内发）
③ 客户扫码加 OA → LINE 回调（webhook）→ LineMember 建档
④ 绑定：平台 Contact ↔ lineUserId 写 LineBind（用 客户自报 / 平台内约定暗号 匹配）
⑤ 私域运营：Messaging API 批量再触达（LINE 侧有自己的频控/退订）
```

## 5. 合规红线（§0 铁律延伸）
- LINE channel token / 密钥 **不进 Git**（走 env / 配置文件，settings.example.json 留占位）。
- 自动再触达也要走「建议 → 确认」闸门（§-1.4），不裸发。
- LINE ToS：禁止爬取、禁止未授权代发；OA 需企业认证。
- 客户 PII（lineUserId 也算）进 LLM prompt 前脱敏（§5.6）。

## 6. 待研究清单（用户"正在研究"——先占位，逐项补）
- [ ] LINE OA 申请 + 企业认证流程（法人资料）
- [ ] Messaging API 批量消息配额/计费（一条 vs 批量 vs 好友消息免费额度）
- [ ] 平台内发 LINE 二维码的合规边界（平台是否允许引导导流 / 会不会判营销）
- [ ] 绑定匹配的暗号方案（客户在 LINE 自动回复里报 平台昵称/暗号，自动匹配 Contact）
- [ ] LINE webhook 回调 + 消息流水落库（LineMessageLog）
- [ ] 退订/黑名单同步（LINE 侧 unfollow → 平台侧 churned）

## 7. 分期
- **Phase A（现在）**：设计稿 + 数据地基（LineMember/LineBind 已建，补 LineMessageLog 表 + 扩列）。
- **Phase B（接入）**：LINE OA 申请 + Messaging API 封装（server/adapter/lineAdapter.js，仿 ichigo/happy 契约）。
- **Phase C（闭环）**：平台内 SOP 触发 → 发二维码 → webhook 绑定 → 私域再触达（走确认闸门）。
