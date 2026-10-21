"""v5 多维画像 · FastAPI 极简 API（纵向切片）

挂载方式：
  独立进程（uvicorn 8400）：
    python -m uvicorn backend.api.app:app --port 8400 --host 127.0.0.1
  或嵌入 Node 主服务（子进程 + 反向代理，见 §6 部署说明）

接口（4 个，极简闭环）：
  GET  /v5/persona?contactId=xx&platformId=xx     读取客户在指定平台的 PlatformPersona + 双层记忆
  GET  /v5/memory?contactId=xx                     读取客户 CustomerMemory 全量（按物理人）
  POST /v5/memory                                  写入 CustomerMemory（body: contactId/memType/content/source）
  GET  /v5/memory/preview                          前端资料面板拉数据用（同 GET /v5/memory 的别名）

设计原则（与架构蓝图一致）：
  * 确定性主键（sha1 拼接，幂等去重）——同 content 重复 POST 不报错
  * SQLite 直连（backend 侧零 ORM，零 SQLAlchemy 依赖；Node 侧 store.js 不动）
  * 全量读写都按蓝图 v5 表结构（v5_multiplatform_schema.sql）
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, ConfigDict

from ..models import (
    PlatformPersona, CustomerMemory, CustomerTag,
    PersonaMemory, now_iso,
)

# ---------------------------------------------------------------------------
# DB 连接（SQLite，与 Node 侧 store.js 同一库 data/aisay.db）
# ---------------------------------------------------------------------------
DB_PATH = "I:/deepseek/Ai SAY/data/aisay.db"

def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn

def _now() -> str:
    return now_iso()

def _sha1(*parts: "str | None") -> str:
    raw = "|".join(str(p if p is not None else "") for p in parts)
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()

# ---------------------------------------------------------------------------
# FastAPI 应用
# ---------------------------------------------------------------------------
app = FastAPI(title="Ai SAY v5 画像库 API", version="0.1.0")

# 跨域（前端 8300 调 8400）
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:8300", "http://localhost:8300",
        "http://127.0.0.1:19387", "http://localhost:19387",
    ],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Pydantic 请求体
# ---------------------------------------------------------------------------
class MemoryIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    contact_id: str = Field(..., alias="contactId")
    mem_type: str = Field(..., alias="memType", description="preference/personality/phrasing/media/schedule/note")
    content: str
    source: str = "manual"
    confidence: float = 0.5
    ref: Optional[str] = None


class MemoryOut(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    memory_id: str = Field(..., alias="memoryId")
    contact_id: str = Field(..., alias="contactId")
    mem_type: str = Field(..., alias="memType")
    content: str
    source: str
    confidence: float
    ref: Optional[str]
    created_at: str = Field(..., alias="createdAt")


class PersonaOut(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    persona_id: str = Field(..., alias="personaId")
    contact_id: str = Field(..., alias="contactId")
    platform_id: str = Field(..., alias="platformId")
    platform_uid: str = Field(..., alias="platformUid")
    display_name: str = Field(..., alias="displayName")
    relationship_stage: str = Field(..., alias="relationshipStage")
    chat_style: Optional[dict[str, Any]] = Field(None, alias="chatStyle")
    activity_pattern: Optional[dict[str, Any]] = Field(None, alias="activityPattern")
    registration_profile: Optional[dict[str, Any]] = Field(None, alias="registrationProfile")
    last_active_at: str = Field(..., alias="lastActiveAt")
    memories: list[MemoryOut] = []
    persona_memories: list[dict[str, Any]] = []


# ---------------------------------------------------------------------------
# 路由
# ---------------------------------------------------------------------------
@app.get("/v5/persona", response_model=PersonaOut)
def get_persona(contact_id: str = Query(..., alias="contactId"),
                platform_id: str = Query("ikuru", alias="platformId")) -> PersonaOut:
    """读取客户在指定平台的 PlatformPersona + 双层记忆。"""
    conn = _connect()
    try:
        # 物理人存在性检查
        row = conn.execute(
            "SELECT 1 FROM Contact WHERE contactId = ?", (contact_id,)
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail=f"contact {contact_id} not found")

        # PlatformPersona：确定性主键；查无则惰性创建（新物理人首次出现在某平台）
        persona_pk = _sha1(contact_id, platform_id, platform_id)  # platformUid 暂缺，用 platformId 占位
        p_row = conn.execute(
            "SELECT * FROM PlatformPersona WHERE personaId = ?", (persona_pk,)
        ).fetchone()
        if not p_row:
            # 惰性建 persona（relationshipStage=new, registrationProfile 留空）
            p_row = {
                "personaId": persona_pk, "contactId": contact_id, "platformId": platform_id,
                "platformUid": platform_id, "displayName": "", "avatarUrl": None,
                "profileUrl": None, "selfIntro": None, "personaTags": None,
                "chatStyle": None, "activityPattern": None, "registrationProfile": None,
                "relationshipStage": "new", "lastActiveAt": _now(),
                "createdAt": _now(), "updatedAt": _now(),
            }
            conn.execute(
                """INSERT INTO PlatformPersona
                   (personaId, contactId, platformId, platformUid, displayName,
                    relationshipStage, lastActiveAt, createdAt, updatedAt)
                   VALUES (?, ?, ?, ?, ?, 'new', ?, ?, ?)""",
                (persona_pk, contact_id, platform_id, platform_id, "", _now(), _now(), _now()),
            )
            conn.commit()

        # 双层记忆：物理人级（CustomerMemory）+ 人设级（PersonaMemory）
        mem_rows = conn.execute(
            "SELECT * FROM CustomerMemory WHERE contactId = ? ORDER BY createdAt DESC",
            (contact_id,)
        ).fetchall()
        pm_rows = conn.execute(
            "SELECT * FROM PersonaMemory WHERE personaId = ? ORDER BY createdAt DESC",
            (p_row["personaId"],)
        ).fetchall()

        def _json(v):
            if v is None: return None
            try: return json.loads(v)
            except Exception: return v

        out = PersonaOut(
            personaId=p_row["personaId"],
            contactId=p_row["contactId"],
            platformId=p_row["platformId"],
            platformUid=p_row["platformUid"],
            displayName=p_row["displayName"] or "",
            relationshipStage=p_row["relationshipStage"],
            chatStyle=_json(p_row["chatStyle"]),
            activityPattern=_json(p_row["activityPattern"]),
            registrationProfile=_json(p_row["registrationProfile"]),
            lastActiveAt=p_row["lastActiveAt"],
            memories=[
                MemoryOut(
                    memoryId=r["memoryId"], contactId=r["contactId"], memType=r["memType"],
                    content=r["content"], source=r["source"], confidence=r["confidence"],
                    ref=r["ref"], createdAt=r["createdAt"],
                ) for r in mem_rows
            ],
            persona_memories=[
                {
                    "memId": r["memId"], "memType": r["memType"],
                    "content": r["content"], "confidence": r["confidence"],
                    "createdAt": r["createdAt"],
                } for r in pm_rows
            ],
        )
        return out
    finally:
        conn.close()


@app.get("/v5/memory", response_model=list[MemoryOut])
def list_memory(contact_id: str = Query(..., alias="contactId")) -> list[MemoryOut]:
    """读取客户 CustomerMemory 全量（按物理人汇总）。"""
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT * FROM CustomerMemory WHERE contactId = ? ORDER BY createdAt DESC",
            (contact_id,)
        ).fetchall()
        return [
            MemoryOut(
                memoryId=r["memoryId"], contactId=r["contactId"], memType=r["memType"],
                content=r["content"], source=r["source"], confidence=r["confidence"],
                ref=r["ref"], createdAt=r["createdAt"],
            ) for r in rows
        ]
    finally:
        conn.close()


@app.post("/v5/memory", response_model=MemoryOut)
def add_memory(body: MemoryIn) -> MemoryOut:
    """写入 CustomerMemory（幂等：同 contact+type+content 不重复插入）。"""
    content_hash = _sha1(body.content)
    pk = _sha1(body.contact_id, body.mem_type, content_hash)
    conn = _connect()
    try:
        # 物理人存在性检查
        row = conn.execute(
            "SELECT 1 FROM Contact WHERE contactId = ?", (body.contact_id,)
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail=f"contact {body.contact_id} not found")

        # 幂等插入（同主键存在则跳过；SQLite INSERT OR IGNORE）
        existing = conn.execute(
            "SELECT createdAt FROM CustomerMemory WHERE memoryId = ?", (pk,)
        ).fetchone()
        if existing:
            return MemoryOut(
                memoryId=pk, contactId=body.contact_id, memType=body.mem_type,
                content=body.content, source=body.source, confidence=body.confidence,
                ref=body.ref, createdAt=existing["createdAt"],
            )
        conn.execute(
            """INSERT INTO CustomerMemory
               (memoryId, contactId, memType, ref, content, source, confidence, vectorRef, createdAt)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (pk, body.contact_id, body.mem_type, body.ref, body.content,
             body.source, body.confidence, None, _now()),
        )
        conn.commit()
        return MemoryOut(
            memoryId=pk, contactId=body.contact_id, memType=body.mem_type,
            content=body.content, source=body.source, confidence=body.confidence,
            ref=body.ref, createdAt=_now(),
        )
    finally:
        conn.close()


@app.get("/v5/memory/preview")
def preview_memory(contact_id: str = Query(..., alias="contactId")) -> dict[str, Any]:
    """前端资料面板别名：同 /v5/memory，返回 { ok, contactId, memories }。"""
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT * FROM CustomerMemory WHERE contactId = ? ORDER BY createdAt DESC",
            (contact_id,)
        ).fetchall()
        return {
            "ok": True,
            "contactId": contact_id,
            "count": len(rows),
            "memories": [
                {
                    "memoryId": r["memoryId"], "memType": r["memType"],
                    "content": r["content"], "source": r["source"],
                    "confidence": r["confidence"], "ref": r["ref"],
                    "createdAt": r["createdAt"],
                } for r in rows
            ],
        }
    finally:
        conn.close()


@app.get("/v5/health")
def health() -> dict[str, str]:
    return {"ok": "true", "db": DB_PATH}
