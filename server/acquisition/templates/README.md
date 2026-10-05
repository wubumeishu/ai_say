# 话术模板目录（品类×语言×平台）

## 组织方式

```
templates/
  {platform}/            # fb / ig / wa / ai_meeting / line ...
    {category}.{lang}.json
    _default.{lang}.json # 该平台全品类兜底
  _default/
    {category}.{lang}.json
    _default.{lang}.json # 全局兜底
```

匹配顺序：平台+品类+语言 → 平台+品类兜底 → 全局+品类 → 全局兜底。
语言码：ja / en / zh（模板文件名后缀）。

## 文件格式

```json
{
  "vars": ["name", "region", "interest", "lineId", "greeting", "personaName", "personaTone"],
  "variants": {
    "A": { "hot": "...", "warm": "...", "cold": "..." },
    "B": { "hot": "...", "warm": "...", "cold": "..." }
  },
  "remind": "30min 未留 LINE 的提醒话术（A/B 通用）",
  "fallback": "模板缺失时的兜底"
}
```

### 变量占位符（{var} 语法）

| 占位符 | 来源 | 说明 |
| --- | --- | --- |
| {name} | customerProfile.displayName / Contact | 客户称呼 |
| {region} | ContactProfile.region | 地区 |
| {interest} | customerProfile.interest / ContactProfile.interests[0] | 兴趣/诉求 |
| {lineId} | createTalkEngine({ lineId }) / customerProfile.lineId | LINE 账号 ID |
| {personaName} | accountPersona.persona | 账号人设名 |
| {personaTone} | accountPersona.tone | 语气基调 |

A/B 变体按 contactId 哈希固定分流（同一客户永远一组），样本 ≥200/组 时
双比例 z 检验（|z|>1.96）裁决胜出变体。
