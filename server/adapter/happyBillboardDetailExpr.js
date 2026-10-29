(function() {
  // happymail.co.jp 快乐 · 单帖详情抓取原语（v5.2 坐实）
  // POST /sp/app/api/html/get_billboard.php
  // body = token&billboard_id={帖子id}&member_seq_id={客户tid}&HTTP_X_HAPPY_USER_AGENT=HappyHills/Web/8.3.0
  // 响应 61 字段，坐实关键字段：
  //   billboard_subject（标题）/ billboard_body（正文）/ billboard_genre_name（分类）/
  //   scene_name_list + scene_bold_list（标签，仅部分帖有）/ billboard_post_time（发帖时间）/
  //   telephone_number（客户电话）/ member_prof_list（客户画像子对象）/
  //   musi_url/michaiya_url/tuho_url（无视/屏蔽/回复 入口，⚠ 风控红线，本 Expr 只标注不触发）
  // 本 Expr 只读 DOM（若帖子详情页已渲染）；数据源为 API 直连
  var out = {};
  var bodyEl = document.querySelector('.keijiban_write_body, .billboard_body, .billboard_content, .keijiban_body');
  out.body = bodyEl ? bodyEl.innerText.trim().slice(0, 500) : '';
  var subj = document.querySelector('.billboard_subject, .keijiban_subject, h1, h2, h3');
  out.subject = subj ? subj.innerText.trim() : '';
  var date = document.querySelector('.billboard_post_time, .billboard_date, .write_date');
  out.postTime = date ? date.innerText.trim() : '';
  var tags = [];
  document.querySelectorAll('[class*="scene"], .ds_round_tag').forEach(function(el) {
    var t = el.innerText ? el.innerText.trim() : '';
    if (t && t.length < 20 && tags.indexOf(t) === -1) tags.push(t);
  });
  out.tags = tags;
  // 风控入口标注（只标注不触发，§0 铁律）
  var riskLinks = {};
  ['musi_url', 'michaiya_url', 'tuho_url'].forEach(function(k) {
    var a = document.querySelector('[data-ref="' + k + '"], a.musi, a.michaiya, a.tuho');
    if (a) riskLinks[k] = a.getAttribute('href') || '';
  });
  out.riskEntries = riskLinks; // 无视/屏蔽/回复 入口（⚠ 不点）
  return {
    detail: out,
    postRef: {
      url: '/sp/app/api/html/get_billboard.php',
      method: 'POST',
      body: 'token&billboard_id={帖子id}&member_seq_id={客户tid}&HTTP_X_HAPPY_USER_AGENT',
      respFields: ['billboard_subject','billboard_body','billboard_genre_name','scene_name_list','scene_bold_list','billboard_post_time','billboard_mail_count','telephone_number','member_prof_list'],
      note: '单帖正文 billboard_body + 标签 scene_name_list + 电话 telephone_number（61 字段全量见测绘图 §10.1）'
    }
  };
})()