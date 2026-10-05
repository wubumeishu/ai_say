const fs = require('fs');

const docPath = 'I:/project/Ai SAY/docs/click_mypage_17098.md';
fs.mkdirSync(require('path').dirname(docPath), { recursive: true });

fs.writeFileSync(docPath, `# 17098 窗口：点击「マイページ」的记录

## 目标
- 窗口编号：17098
- 窗口 ID：2315e879dd6642559bdc11a07bb1fc43
- 目标动作：点击底部导航的「マイページ」
- 平台：出会 / Pappy / イククル

## 实际定位方式
- 当前页面：https://sp.194964.com/mail/inbox/show_mailbox.html
- 查找范围：a, button, [role=button], .tab, .menu, .nav, li, span, div
- 匹配条件：元素文本严格等于「マイページ」
- 命中的元素：
  - tag: A
  - class: bottom-nav-item-txt nav-mypage
  - href: https://sp.194964.com/mypage.html

## 点击方式
- 因为命中元素带 href，所以使用 window.location.href = href 跳转
- 不使用 .click()
- 点击前：https://sp.194964.com/mail/inbox/show_mailbox.html
- 点击后：https://sp.194964.com/mypage.html

## 可复用规则
底部其他菜单也按同样方式处理：
- 先按“精确文本”匹配
- 再优先取带 href 的元素
- 如果 href 存在，直接 location.href 跳转
- 如果 href 不存在，再调用 .click()

## 已验证结果
- 成功进入 https://sp.194964.com/mypage.html
- 页面 readyState = complete
- 页面显示账号摘要、通知条、底部导航
`, 'utf8');

console.log('documented click rule: ' + docPath);
