"""模块2 · 免密钥翻译服务（deep_translator GoogleTranslator 免费源）
替代容易超时的旧 LLM 翻译节点；入参预留 context/personaId，为本地大模型角色扮演翻译打管道。

调用方式（Node 侧 spawn）：
  python server/translate_service.py '<json>'
  JSON: {"items": [{"text": "...", "from": "ja", "to": "zh-CN", "context": "", "personaId": ""}], "timeout_ms": 8000}
  输出 JSON: {"ok": true, "results": {"<text>": {"translated": "...", "source": "google-free", "cached": false}}}

设计：
  * deep_translator.GoogleTranslator：免密钥、稳定、快（~200ms/条），替换旧 LLM 节点
  * context / personaId 入参：现阶段透传存到结果（标记"大模型管道预留位"），后续接本地大模型
    角色扮演翻译时按 personaId 取人设 prompt + context 组上下文，本层无需改契约
  * 超时保护：单批 timeout_ms（默认 8s），超时已翻译的照常返回，未完成的标 ok:false
"""
from __future__ import annotations
import json
import sys
import threading

try:
    from deep_translator import GoogleTranslator
except ImportError as e:
    print(json.dumps({"ok": False, "reason": "import-error", "msg": str(e)}))
    sys.exit(0)

# 语言码映射（key 全小写；deep_translator 支持 ISO 码：ja / zh-CN 简中 / zh-TW 繁中 / en / ko，非裸 'zh'）
_LANG_MAP = {
    "ja": "ja", "zh-cn": "zh-CN", "zh": "zh-CN", "zh-hans": "zh-CN",
    "en": "en", "ko": "ko", "fr": "fr", "es": "es",
    "zh-tw": "zh-TW", "zh-hant": "zh-TW",
}


def _map(src: str, dst: str):
    # 全小写查表，值保留 deep_translator 期望的大小写
    s = _LANG_MAP.get(str(src or "ja").lower(), "ja")
    t = _LANG_MAP.get(str(dst or "zh-CN").lower(), "zh-CN")
    return s, t


def translate_batch(items: list, timeout_ms: int = 8000) -> dict:
    """批量翻译。返回 {text: {translated, source, cached, context, personaId}}"""
    results = {}
    done = threading.Event()

    def _worker():
        for it in items:
            text = str(it.get("text") or "")
            frm = it.get("from", "ja")
            to = it.get("to", "zh-CN")
            s, t = _map(frm, to)
            ctx = it.get("context", "")
            persona_id = it.get("personaId", "")
            try:
                tr = GoogleTranslator(source=s, target=t).translate(text)
                # source 标记：google-free（deep_translator 免密钥）；context/personaId 预留位记录
                results[text] = {
                    "ok": True,
                    "translated": tr or "",
                    "source": "google-free",
                    "cached": False,
                    "context": ctx,
                    "personaId": persona_id,
                    "modelNote": "deep_translator 免密钥；context/personaId 已预留，待接本地大模型角色扮演",
                }
            except Exception as e:
                results[text] = {
                    "ok": False,
                    "translated": text,
                    "source": "error",
                    "reason": str(e),
                    "context": ctx,
                    "personaId": persona_id,
                }
        done.set()

    th = threading.Thread(target=_worker, daemon=True)
    th.start()
    ok_wait = done.wait(timeout=timeout_ms / 1000.0)
    if not ok_wait:
        # 超时：已完成的保留，未完成的标 timeout
        pending = [i.get("text") for i in items if i.get("text") not in results]
        for pt in pending:
            results[pt] = {"ok": False, "translated": pt, "source": "timeout", "reason": f"超时 {timeout_ms}ms"}
    return results


def main():
    raw = sys.stdin.read() if not sys.argv[1:] else sys.argv[1]
    try:
        req = json.loads(raw)
    except Exception as e:
        print(json.dumps({"ok": False, "reason": "bad-json", "msg": str(e)}))
        return
    items = req.get("items", [])
    timeout_ms = int(req.get("timeout_ms", 8000))
    results = translate_batch(items, timeout_ms)
    print(json.dumps({"ok": True, "results": results, "total": len(results)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
