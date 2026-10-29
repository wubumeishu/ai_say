(function() {
  // happymail.co.jp 快乐 · 客户招募帖列表抓取原语（v5.2 坐实）
  // POST /sp/app/api/html/get_profile_billboard.php
  // body = token&offset=1&count=N&direction=1&member_seq_id={客户tid}&memuse=true&HTTP_X_HAPPY_USER_AGENT=HappyHills/Web/8.3.0
  // 响应 = { error_no, profile_billboard[], page, pages }
  // 条目字段：billboard_id, billboard_profile_id, billboard_post_time, billboard_genre_code/name,
  //   billboard_subject, billboard_read_count, billboard_ret_count, billboard_my_read,
  //   billboard_scene_name_list, billboard_scene_bold_list（仅部分帖有标签）
  // 本 Expr 只读 DOM（若页面已渲染 .profile_billboard_item）；数据源为 API 直连，本 Expr 供 CDP 抽取
  var items = Array.from(document.querySelectorAll('.profile_billboard_item, .ds_profile_billboard_item, [class*="billboard_list"] li')).map(function(el) {
    var subj = el.querySelector('.billboard_subject, .keijiban_subject, h3, .subject');
    var date = el.querySelector('.billboard_post_time, .billboard_date, .date');
    var genre = el.querySelector('.billboard_genre, .genre, .billboard-genre-badge');
    return {
      subject: subj ? subj.innerText.trim() : '',
      postTime: date ? date.innerText.trim() : '',
      genre: genre ? genre.innerText.trim() : '',
      raw: el.innerText.trim().replace(/\n+/g, ' | ').slice(0, 200)
    };
  }).filter(function(x) { return x.subject || x.postTime; });
  return {
    items: items,
    count: items.length,
    postRef: {
      url: '/sp/app/api/html/get_profile_billboard.php',
      method: 'POST',
      body: 'token&offset&count&direction=1&member_seq_id={客户tid}&memuse=true&HTTP_X_HAPPY_USER_AGENT',
      respSchema: { profile_billboard: ['billboard_id','billboard_profile_id','billboard_post_time','billboard_genre_name','billboard_subject','billboard_read_count','billboard_ret_count','billboard_scene_name_list'] },
      note: '拉某客户的全部招募帖列表；正文需 get_billboard.php 逐帖查'
    },
    note: items.length ? '' : 'items 为空：帖子列表由 API+JS 填充，需渲染完成后抓'
  };
})()