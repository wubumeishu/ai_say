
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

function createStore(baseDir = path.join(__dirname, "..")) {
  const rootDir = path.join(baseDir, "data");
  const profilesPath = path.join(rootDir, "account-profiles.json");
  const conversationsPath = path.join(rootDir, "conversations.json");
  const contactsPath = path.join(rootDir, "contacts.json");

  function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
  }

  function readJson(file, fallback) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      return fallback;
    }
  }

  function writeJson(file, value) {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
  }

  function normalizePlatform(platform) {
    const value = String(platform || "").trim();
    if (!value) return "未分组";
    return value;
  }

  function normalizeAccountKey(windowId, platform, accountLabel) {
    return [normalizePlatform(platform), String(windowId || "").trim(), String(accountLabel || "").trim()].join("/");
  }

  function normalizeConversationKey(platform, windowId, contactKey) {
    return [normalizePlatform(platform), String(windowId || "").trim(), String(contactKey || "").trim()].join("/");
  }

  function upsertAccountProfile(input = {}) {
    const records = readJson(profilesPath, []);
    const key = normalizeAccountKey(input.windowId, input.platform, input.accountLabel || input.nickname || input.name);
    const normalized = {
      key,
      platform: normalizePlatform(input.platform),
      windowId: String(input.windowId || ""),
      accountLabel: String(input.accountLabel || input.nickname || input.name || "").trim(),
      nickname: String(input.nickname || input.name || input.accountLabel || "").trim(),
      pageUrl: String(input.pageUrl || "").trim(),
      mypageUrl: String(input.mypageUrl || "").trim(),
      fields: Array.isArray(input.fields) ? input.fields : [],
      sections: Array.isArray(input.sections) ? input.sections : [],
      lines: Array.isArray(input.lines) ? input.lines : [],
      nextLevelPages: Array.isArray(input.nextLevelPages) ? input.nextLevelPages : [],
      bottomNav: Array.isArray(input.bottomNav) ? input.bottomNav : [],
      detection: input.detection || {},
      navigation: input.navigation || {},
      raw: input.raw || null,
      updatedAt: input.updatedAt || new Date().toISOString(),
      createdAt: input.createdAt || new Date().toISOString()
    };
    const idx = records.findIndex((item) => item.key === key);
    if (idx >= 0) {
      records[idx] = Object.assign({}, records[idx], normalized, {
        createdAt: records[idx].createdAt || normalized.createdAt
      });
    } else {
      records.push(normalized);
    }
    writeJson(profilesPath, records);
    return records[idx === -1 ? records.length - 1 : idx];
  }

  function listAccountProfiles(query = {}) {
    const records = readJson(profilesPath, []);
    const platform = String(query.platform || "").trim();
    const windowId = String(query.windowId || "").trim();
    return records.filter((item) => {
      if (platform && item.platform !== platform) return false;
      if (windowId && item.windowId !== windowId) return false;
      return true;
    });
  }

  function getAccountProfile(windowId, platform, accountLabel) {
    const key = normalizeAccountKey(windowId, platform, accountLabel);
    return readJson(profilesPath, []).find((item) => item.key === key) || null;
  }

  function upsertConversation(input = {}) {
    const records = readJson(conversationsPath, []);
    const key = normalizeConversationKey(input.platform, input.windowId, input.contactKey);
    const normalized = {
      key,
      platform: normalizePlatform(input.platform),
      windowId: String(input.windowId || "").trim(),
      contactKey: String(input.contactKey || input.contactName || "").trim(),
      contactName: String(input.contactName || input.contactKey || "").trim(),
      contact: input.contact || {},
      messages: Array.isArray(input.messages) ? input.messages : [],
      updatedAt: input.updatedAt || new Date().toISOString(),
      createdAt: input.createdAt || new Date().toISOString()
    };
    const idx = records.findIndex((item) => item.key === key);
    if (idx >= 0) {
      records[idx] = Object.assign({}, records[idx], normalized, {
        createdAt: records[idx].createdAt || normalized.createdAt,
        contact: Object.assign({}, records[idx].contact, normalized.contact),
        messages: normalized.messages.length ? normalized.messages : records[idx].messages
      });
    } else {
      records.push(normalized);
    }
    writeJson(conversationsPath, records);
    return records[idx === -1 ? records.length - 1 : idx];
  }

  function listConversations(query = {}) {
    const records = readJson(conversationsPath, []);
    const platform = String(query.platform || "").trim();
    const windowId = String(query.windowId || "").trim();
    const contactKey = String(query.contactKey || "").trim();
    return records.filter((item) => {
      if (platform && item.platform !== platform) return false;
      if (windowId && item.windowId !== windowId) return false;
      if (contactKey && item.contactKey !== contactKey) return false;
      return true;
    });
  }

  function upsertContact(input = {}) {
    const records = readJson(contactsPath, []);
    const key = normalizeConversationKey(input.platform, input.windowId, input.contactKey);
    const normalized = {
      key,
      platform: normalizePlatform(input.platform),
      windowId: String(input.windowId || "").trim(),
      contactKey: String(input.contactKey || input.contactName || "").trim(),
      contact: input.contact || {},
      profileUrl: String(input.profileUrl || "").trim(),
      updatedAt: input.updatedAt || new Date().toISOString(),
      createdAt: input.createdAt || new Date().toISOString()
    };
    const idx = records.findIndex((item) => item.key === key);
    if (idx >= 0) {
      records[idx] = Object.assign({}, records[idx], normalized, {
        contact: Object.assign({}, records[idx].contact, normalized.contact),
        createdAt: records[idx].createdAt || normalized.createdAt
      });
    } else {
      records.push(normalized);
    }
    writeJson(contactsPath, records);
    return records[idx === -1 ? records.length - 1 : idx];
  }

  function listContacts(query = {}) {
    const records = readJson(contactsPath, []);
    const platform = String(query.platform || "").trim();
    const windowId = String(query.windowId || "").trim();
    return records.filter((item) => {
      if (platform && item.platform !== platform) return false;
      if (windowId && item.windowId !== windowId) return false;
      return true;
    });
  }

  return {
    upsertAccountProfile,
    listAccountProfiles,
    getAccountProfile,
    upsertConversation,
    listConversations,
    upsertContact,
    listContacts
  };
}

module.exports = { createStore };
