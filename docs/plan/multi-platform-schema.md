# 多平台客源软关联与多维画像数据库（v5）· 架构蓝图
> 2026-10-21 定稿（总控审核通过）；实施：backend/db/migrate_v5.py + backend/db/v5_multiplatform_schema.sql + backend/models/

## 核心关系
- Contact（物理人 GlobalID）1:N PlatformPersona（平台身份）：同一物理人跨平台独立人设，靠 contactId 软关联
- PlatformPersona 1:N Conversation：聊天/资料/风格锁在平台人设级（不串戏）
- Contact 1:N CustomerMemory / CustomerMedia / CustomerTag：多模态记忆 + 标签沉淀汇总到物理人级
- PlatformPersona 1:N PersonaMemory：人设级记忆（语气/话术/禁忌）——与 CustomerMemory 双层隔离
- Conversation.personaId（v5 唯一 ALTER）：会话 ↔ 平台人设绑定；迁移期旧数据 NULL
- Account.accountPool / proxyProfileId（v5 ALTER）：本方账号池分组 + 代理绑定
- VectorStore：向量库映射表（预留；向量本体存外部 qdrant / sqlite-vec，DB 只存映射）

## 三层主键（确定性 sha1，幂等去重）
| 表 | pk | 公式 |
|---|---|---|
| PlatformPersona | personaId | sha1(contactId\|platformId\|platformUid) |
| CustomerMemory | memoryId | sha1(contactId\|memType\|sha1(content)) |
| CustomerMedia | mediaId | sha1(contactId\|msgId\|sha1(url)) |
| CustomerTag | tagId | sha1(contactId\|layer\|value) |
| PersonaMemory | memId | sha1(personaId\|memType\|sha1(content)) |

## 双层记忆设计（RAG 组装边界的隔离原则）
- **CustomerMemory（物理人级，全局客观事实）**：喜欢动漫/性格/话术偏好/历史媒体——跨平台通用
- **PersonaMemory（平台人设级，信息差 + 交互风格）**：出会账号 A 上是商务御姐语气、快乐账号 B 上是御宅少女——同一个人不同平台表现不同

## 执行
python backend/db/migrate_v5.py            # 对 data/aisay.db 执行（幂等，可重跑）
python backend/db/migrate_v5.py --dry-run  # 只打印不写库
备份：backups/aisay-v5-pre-*.db（迁移前快照，回滚锚点）
全量回归：node --test（25 物理文件 159 用例 0 红，迁移后验证）
