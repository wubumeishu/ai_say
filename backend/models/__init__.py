"""多平台客源软关联 + 多维画像库 · Pydantic 数据模型（v5 新表）

对应 SQL 表：
  PlatformPersona / CustomerMemory / CustomerMedia / CustomerTag /
  PersonaMemory / VectorStore（均 CREATE TABLE IF NOT EXISTS）
以及 2 处旧表增强列（Conversation.personaId / Account.accountPool, proxyProfileId）

约定（与架构蓝图 §6 一致）：
  * 主键一律确定性 sha1 拼接（幂等去重），模型提供 *_id() 属性
  * JSON 列在模型里是 Optional[dict/list]，入库前由 store 层 json.dumps
  * 字段名统一 snake_case；model_config 开启 populate_by_name，
    传入 camelCase（alias）或 snake_case 均可构造
  * Pydantic v2
"""
from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from typing import Optional, Any

from pydantic import BaseModel, ConfigDict, Field

_CONFIG = ConfigDict(populate_by_name=True)


# ---------------------------------------------------------------------------
# 工具
# ---------------------------------------------------------------------------
def _sha1(*parts: "str | None") -> str:
    raw = "|".join(str(p if p is not None else "") for p in parts)
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# ① PlatformPersona · 平台人设（1 物理人 : N 平台身份）
# ---------------------------------------------------------------------------
class PlatformPersona(BaseModel):
    """客户在特定平台的独立身份。聊天/资料/风格锁在该层，跨平台不串戏。

    确定性主键：persona_id = sha1(contact_id|platform_id|platform_uid)
    """
    model_config = _CONFIG

    contact_id: str = Field(..., alias="contactId")
    platform_id: str = Field(..., alias="platformId")
    platform_uid: str = Field(..., alias="platformUid", description="平台内唯一 ID（出会/快乐=memberID，LINE=openId）")
    display_name: str = Field("", alias="displayName")
    avatar_url: Optional[str] = Field(None, alias="avatarUrl")
    profile_url: Optional[str] = Field(None, alias="profileUrl", description="资料页 URL，供 RAG 抓取")
    self_intro: Optional[str] = Field(None, alias="selfIntro")
    persona_tags: Optional[list[str]] = Field(None, alias="personaTags")
    chat_style: Optional[dict[str, Any]] = Field(None, alias="chatStyle")
    activity_pattern: Optional[dict[str, Any]] = Field(None, alias="activityPattern",
        description="{'peakHours':[..], 'activeDays':[..], 'tzOffset':0}")
    registration_profile: Optional[dict[str, Any]] = Field(None, alias="registrationProfile",
        description="平台登记完整资料（结构化 JSON 桶，不拆细列）")
    relationship_stage: str = Field("new", alias="relationshipStage",
        description="new/warming/active/silent/churned")
    last_active_at: str = Field(..., alias="lastActiveAt")
    created_at: str = Field(..., alias="createdAt")
    updated_at: str = Field(..., alias="updatedAt")

    @property
    def persona_id(self) -> str:
        return _sha1(self.contact_id, self.platform_id, self.platform_uid)


# ---------------------------------------------------------------------------
# ② CustomerMemory · 记忆碎片（按物理人汇总；RAG 检索源）
# ---------------------------------------------------------------------------
MEM_TYPES = ("preference", "personality", "phrasing", "media", "schedule", "note")
MEM_SOURCES = ("llm_extract", "manual", "platform_profile", "media_scan")


class CustomerMemory(BaseModel):
    """多模态记忆碎片。media 型只存 URL，不存 BLOB。

    确定性主键：memory_id = sha1(contact_id|mem_type|sha1(content))
    """
    model_config = _CONFIG

    contact_id: str = Field(..., alias="contactId")
    mem_type: str = Field(..., alias="memType", description=f"∈ {MEM_TYPES}")
    ref: Optional[str] = Field(None, description="来源引用（media=URL；preference=规则 ID）")
    content: str
    source: str = Field("llm_extract", description=f"∈ {MEM_SOURCES}")
    confidence: float = 0.5
    vector_ref: Optional[str] = Field(None, alias="vectorRef", description="向量库指针（预留）")
    created_at: str = Field(..., alias="createdAt")

    @property
    def memory_id(self) -> str:
        return _sha1(self.contact_id, self.mem_type, _sha1(self.content))


# ---------------------------------------------------------------------------
# ③ CustomerMedia · 媒体文件（按物理人汇总）
# ---------------------------------------------------------------------------
class CustomerMedia(BaseModel):
    """历史发送媒体。确定性主键：media_id = sha1(contact_id|msg_id|sha1(url))"""
    model_config = _CONFIG

    contact_id: str = Field(..., alias="contactId")
    msg_id: Optional[str] = Field(None, alias="msgId")
    mime_type: Optional[str] = Field(None, alias="mimeType")
    url: str
    local_path: Optional[str] = Field(None, alias="localPath")
    duration: Optional[int] = None
    width: Optional[int] = None
    height: Optional[int] = None
    direction: str = Field("peer", description="self / peer")
    platform_id: Optional[str] = Field(None, alias="platformId")
    created_at: str = Field(..., alias="createdAt")

    @property
    def media_id(self) -> str:
        return _sha1(self.contact_id, self.msg_id or "", _sha1(self.url))


# ---------------------------------------------------------------------------
# ④ CustomerTag · 标签沉淀（按物理人）
# ---------------------------------------------------------------------------
TAG_LAYERS = ("source", "intent", "category", "status", "ops")
TAG_SOURCES = ("llm_extract", "manual", "rule_hit")


class CustomerTag(BaseModel):
    """确定性主键：tag_id = sha1(contact_id|layer|value)"""
    model_config = _CONFIG

    contact_id: str = Field(..., alias="contactId")
    layer: str = Field(..., description=f"∈ {TAG_LAYERS}")
    value: str
    confidence: float = 0.5
    source: str = Field("rule_hit", description=f"∈ {TAG_SOURCES}")
    created_at: str = Field(..., alias="createdAt")
    updated_at: str = Field(..., alias="updatedAt")

    @property
    def tag_id(self) -> str:
        return _sha1(self.contact_id, self.layer, self.value)


# ---------------------------------------------------------------------------
# ⑤ PersonaMemory · 人设记忆（按 PlatformPersona 隔离；与 CustomerMemory 双层）
# ---------------------------------------------------------------------------
PERSONA_MEM_TYPES = ("tone", "phrasing", "taboo", "preference")


class PersonaMemory(BaseModel):
    """确定性主键：mem_id = sha1(persona_id|mem_type|sha1(content))"""
    model_config = _CONFIG

    persona_id: str = Field(..., alias="personaId")
    mem_type: str = Field(..., alias="memType", description=f"∈ {PERSONA_MEM_TYPES}")
    content: str
    confidence: float = 0.5
    created_at: str = Field(..., alias="createdAt")

    @property
    def mem_id(self) -> str:
        return _sha1(self.persona_id, self.mem_type, _sha1(self.content))


# ---------------------------------------------------------------------------
# ⑥ VectorStore · 向量库映射（预留；向量本体存外部 qdrant / sqlite-vec）
# ---------------------------------------------------------------------------
class VectorRecord(BaseModel):
    """DB 只存映射；向量本体放 data/vectors/ 或 qdrant。"""
    model_config = _CONFIG

    vector_id: str = Field(..., alias="vectorId", description="vs_{uuid}")
    memory_id: Optional[str] = Field(None, alias="memoryId")
    source_ref: Optional[str] = Field(None, alias="sourceRef", description="customer / persona")
    model: Optional[str] = Field(None, description="向量模型版本")
    dim: Optional[int] = None
    created_at: str = Field(..., alias="createdAt")


# ---------------------------------------------------------------------------
# 旧表增强列（ALTER ADD）的模型补丁
# ---------------------------------------------------------------------------
class ConversationExtension(BaseModel):
    """Conversation.personaId（会话 ↔ 平台人设绑定；迁移期旧数据 NULL）。"""
    model_config = _CONFIG

    conversation_id: str = Field(..., alias="conversationId")
    persona_id: Optional[str] = Field(None, alias="personaId")


class AccountPoolInfo(BaseModel):
    """Account.accountPool / proxyProfileId（账号池管理）。"""
    model_config = _CONFIG

    account_id: str = Field(..., alias="accountId")
    account_pool: Optional[str] = Field(None, alias="accountPool", description="primary/backup/cold")
    proxy_profile_id: Optional[str] = Field(None, alias="proxyProfileId")


__all__ = [
    "PlatformPersona", "CustomerMemory", "CustomerMedia", "CustomerTag",
    "PersonaMemory", "VectorRecord", "ConversationExtension", "AccountPoolInfo",
    "MEM_TYPES", "MEM_SOURCES", "TAG_LAYERS", "TAG_SOURCES", "PERSONA_MEM_TYPES",
    "now_iso",
]
