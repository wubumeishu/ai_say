// =============================================================================
// Ai SAY · 账号信息解析
// 从 data/account-profiles.json 自动探测（窗口/平台/昵称/资料），
// 再与用户在控制台里填的覆盖值（昵称/资料/见面地址）合并。
// =============================================================================
const fs = require('fs');
const path = require('path');

// 从 mypage 的文本行里挖昵称 + 资料（如 "ともね" / "38歳 埼玉"）
function parseFromLines(lines) {
  var out = { nickname: '', profile: '' };
  if (!Array.isArray(lines)) return out;
  for (var i = 0; i < lines.length; i++) {
    var s = String(lines[i] == null ? '' : lines[i]).trim();
    var m = s.match(/^(\d{1,2})\s*歳\s*(.+)$/);
    if (m) {
      out.profile = s;
      // 昵称通常是紧邻的上一行（排除通知/按钮文案）
      for (var j = i - 1; j >= 0 && j >= i - 3; j--) {
        var cand = String(lines[j] == null ? '' : lines[j]).trim();
        if (!cand) continue;
        if (/通知|プロフィール|マイページ|変更|イククル|^[!0-9]+$/.test(cand)) continue;
        out.nickname = cand;
        break;
      }
      break;
    }
  }
  return out;
}

function readProfiles(profilesPath) {
  try {
    var raw = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
    if (Array.isArray(raw)) return raw;
    if (raw && Array.isArray(raw.profiles)) return raw.profiles;
    return [];
  } catch (_) { return []; }
}

// 找与当前窗口匹配的账号档案
function findProfile(profiles, windowId, accountLabel) {
  if (!profiles.length) return null;
  if (windowId) {
    var byWin = profiles.find(function(p) { return p.windowId === windowId; });
    if (byWin) return byWin;
  }
  if (accountLabel) {
    var byLabel = profiles.find(function(p) { return String(p.accountLabel) === String(accountLabel); });
    if (byLabel) return byLabel;
  }
  return profiles[0] || null;
}

function createAccountInfo(opts) {
  opts = opts || {};
  var profilesPath = opts.profilesPath || path.join(__dirname, '..', '..', 'data', 'account-profiles.json');

  // ctx: { windowLabel, windowId, platformName, override }
  function resolve(ctx) {
    ctx = ctx || {};
    var profiles = readProfiles(profilesPath);
    var p = findProfile(profiles, ctx.windowId, ctx.windowLabel);
    var parsed = p ? parseFromLines(p.lines) : { nickname: '', profile: '' };

    // 平台名：settings 里的分组名 → 简化显示（"自用出会" → "出会"）
    var platformRaw = (p && p.platform) || ctx.platformName || '';
    var platform = platformRaw.replace(/^自用/, '') || platformRaw;

    var ov = ctx.override || {};

    var nickname = (ov.nicknameOverride && ov.nicknameOverride.trim())
      ? ov.nicknameOverride.trim()
      : ((p && p.nickname && p.nickname !== (p.accountLabel || '')) ? p.nickname : (parsed.nickname || (p && p.accountLabel) || ''));

    var profile = (ov.profileOverride && ov.profileOverride.trim())
      ? ov.profileOverride.trim()
      : (parsed.profile || '');

    // 档案里的其它可展示字段（跳过空值/无意义的）
    var extraFields = [];
    if (p && Array.isArray(p.fields)) {
      p.fields.forEach(function(f) {
        if (!f || !f.key) return;
        if (f.value === '' || f.value == null) return;
        extraFields.push({ key: f.key, label: f.label || f.key, value: String(f.value), status: f.status || '' });
      });
    }

    return {
      window: ctx.windowLabel || (p && p.accountLabel) || '',
      windowId: ctx.windowId || (p && p.windowId) || '',
      platform: platform,
      platformRaw: platformRaw,
      nickname: nickname,
      profile: profile,
      // 是否需要用户补全
      nicknameIsAuto: !(ov.nicknameOverride && ov.nicknameOverride.trim()),
      profileIsAuto: !(ov.profileOverride && ov.profileOverride.trim()),
      profileUrl: (p && (p.mypageUrl || p.pageUrl)) || '',
      extraFields: extraFields,
      places: Array.isArray(ov.places) ? ov.places : [],
      detectedAt: (p && p.updatedAt) || null,
      overridden: !!(ov.nicknameOverride || ov.profileOverride || (ov.places && ov.places.length))
    };
  }

  return { resolve: resolve, parseFromLines: parseFromLines, findProfile: findProfile, _profilesPath: profilesPath };
}

module.exports = { createAccountInfo: createAccountInfo, parseFromLines: parseFromLines };
