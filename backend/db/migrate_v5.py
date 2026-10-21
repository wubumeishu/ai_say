#!/usr/bin/env python3
"""v5 迁移执行器 · 多平台客源软关联 + 多维画像数据库（基建 Phase 1）

幂等策略（与设计蓝图 §6 一致）：
  * 新表一律 CREATE TABLE IF NOT EXISTS（SQL 文件 v5_multiplatform_schema.sql）
  * 旧表 ADD COLUMN 用 PRAGMA table_info 探测后条件执行（SQLite 无 ADD IF NOT EXISTS）
  * _migration 写 version=5（INSERT OR IGNORE，重复跑不报错）
执行方式：
  python backend/db/migrate_v5.py            # 对默认 data/aisay.db 执行
  python backend/db/migrate_v5.py --db path  # 指定其他 db
验证：脚本末尾自动跑 PRAGMA integrity_check + 逐表 schema 回显。
"""
from __future__ import annotations

import argparse
import sqlite3
from pathlib import Path

DB_DEFAULT = Path(__file__).resolve().parents[2] / "data" / "aisay.db"
SQL_FILE = Path(__file__).resolve().parent / "v5_multiplatform_schema.sql"

# 旧表增强（唯一 ALTER）：表名 → [(列名, 列定义)]
# 定义与 v5_multiplatform_schema.sql 的注释声明一一对应
ALTER_TARGETS: list[tuple[str, str, str]] = [
    # (table, column, column_def)
    ("Conversation", "personaId", "TEXT"),
    ("Account", "accountPool", "TEXT"),
    ("Account", "proxyProfileId", "TEXT"),
]


def ensure_column(conn: sqlite3.Connection, table: str, column: str, col_def: str) -> bool:
    """探测式 ADD COLUMN（幂等）。返回 True=本次实际执行了 ADD。"""
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    existing = {r[1] for r in rows}
    if column in existing:
        return False
    conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {col_def}")
    return True


def migrate(db_path: Path, dry_run: bool = False) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path, timeout=30)
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 30000")

    # ① 新表（IF NOT EXISTS 幂等）
    sql = SQL_FILE.read_text(encoding="utf-8")
    if not dry_run:
        conn.executescript(sql)
    print("[1/3] 新表 DDL 执行完毕（6 表 + 索引 + _migration v5）")

    # ② 旧表 ADD COLUMN（探测式幂等）
    for table, column, col_def in ALTER_TARGETS:
        # 旧表不存在则跳过（例如空库初始化顺序颠倒时）
        exists = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
        ).fetchone()
        if not exists:
            print(f"[2/3] 跳过 {table}.{column}（表 {table} 不存在）")
            continue
        did = ensure_column(conn, table, column, col_def) if not dry_run else "dry"
        print(f"[2/3] {table}.{column}: {'ADD COLUMN' if did is True else '已存在，跳过' if did is False else 'dry-run'}")

    # ③ 落库 + 完整性校验
    if not dry_run:
        conn.commit()

    # 校验：逐表回显新表 schema
    tables = [
        "PlatformPersona", "CustomerMemory", "CustomerMedia",
        "CustomerTag", "PersonaMemory", "VectorStore",
    ]
    print("[3/3] schema 回显：")
    for t in tables:
        row = conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (t,)
        ).fetchone()
        cols = [r[1] for r in conn.execute(f"PRAGMA table_info({t})")]
        print(f"  {t}: {len(cols)} cols -> {cols}")
    # 旧表增强列
    for t in ("Conversation", "Account"):
        cols = [r[1] for r in conn.execute(f"PRAGMA table_info({t})")]
        print(f"  {t}（增强后）: {len(cols)} cols -> {cols}")
    ic = conn.execute("PRAGMA integrity_check").fetchone()[0]
    print(f"integrity_check: {ic}")
    conn.close()


def main() -> None:
    ap = argparse.ArgumentParser(description="v5 多平台画像库迁移（幂等）")
    ap.add_argument("--db", type=Path, default=DB_DEFAULT, help="SQLite 路径（默认 data/aisay.db）")
    ap.add_argument("--dry-run", action="store_true", help="只打印不写库")
    args = ap.parse_args()
    print(f"target db: {args.db} (exists={args.db.exists()})")
    migrate(args.db, dry_run=args.dry_run)
    print("迁移完成。")


if __name__ == "__main__":
    main()
