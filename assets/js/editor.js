/*
 * 网页编辑器
 * 用法：在网址末尾加 #edit（例如 https://你的用户名.github.io/#edit）
 *   - 点文字直接改，回车换行
 *   - 点照片右上角"换照片"，浏览器会自动压缩到长边 2560px 并去掉定位信息
 *   - 改完点"发布到 GitHub"，一次提交所有修改；连不上 GitHub 时可以先"下载修改"
 * 编辑器只在你自己的浏览器里运行，访客看到的网站不受影响。
 */
(function () {
  'use strict';

  var PAGES = ['index.html', 'work.html', 'about.html', 'journal.html', 'contact.html'];
  var PAGE_NAMES = { 'index.html': '首页', 'work.html': '作品', 'about.html': '关于', 'journal.html': '手记', 'contact.html': '联系' };
  var MAX_EDGE = 2560;
  var API = window.SITE_EDITOR_API || 'https://api.github.com';
  var MULTILINE = { H1: 1, H2: 1, H3: 1, P: 1 };
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  var current = location.pathname.split('/').pop() || 'index.html';
  if (PAGES.indexOf(current) < 0) current = 'index.html';

  var orig = {};        // key -> 打开编辑器时的内容
  var origLinks = {};   // key -> 打开时的链接
  var links = {};       // key -> 当前链接
  var imgs = {};        // key -> { blob, w, h, path, alt, url }
  var bar, countEl, msgEl, pop, popKey, leaving = false;

  /* ---------- 工具 ---------- */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function el(tag, attrs, html) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    if (html != null) n.innerHTML = html;
    return n;
  }
  function textOf(html) { var d = document.createElement('div'); d.innerHTML = html; return d.textContent; }
  function isSite(k) { return k.indexOf('site.') === 0; }
  function stamp() {
    var d = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  // 把可编辑元素里的内容整理成只含文字和 <br> 的 HTML
  function clean(node) {
    var out = '';
    (function walk(n) {
      for (var i = 0; i < n.childNodes.length; i++) {
        var c = n.childNodes[i];
        if (c.nodeType === 3) out += esc(c.nodeValue);
        else if (c.nodeType === 1) {
          if (c.tagName === 'BR') out += '<br>';
          else if (c.tagName === 'DIV' || c.tagName === 'P') {
            if (out && !/<br>$/.test(out)) out += '<br>';
            walk(c);
          } else walk(c);
        }
      }
    })(node);
    return out.replace(/^(<br>)+/, '').replace(/(<br>)+$/, '');
  }

  /* ---------- 进入编辑模式 ---------- */
  function init() {
    document.documentElement.classList.add('is-editing');

    $$('[data-e]').forEach(function (n) {
      var k = n.getAttribute('data-e');
      if (!(k in orig)) orig[k] = clean(n);
      n.setAttribute('contenteditable', 'true');
      n.setAttribute('spellcheck', 'false');
    });
    $$('[data-href]').forEach(function (a) {
      var k = a.getAttribute('data-href');
      if (!(k in origLinks)) { origLinks[k] = a.getAttribute('href'); links[k] = origLinks[k]; }
    });
    $$('a').forEach(function (a) { a.setAttribute('draggable', 'false'); });
    $$('img[data-i]').forEach(addImageTools);

    document.addEventListener('click', onClick, true);
    document.addEventListener('input', onInput);
    document.addEventListener('keydown', onKey);
    document.addEventListener('paste', onPaste);
    document.addEventListener('focusin', onFocus);
    window.addEventListener('beforeunload', function (e) {
      if (!leaving && changeCount() > 0) { e.preventDefault(); e.returnValue = ''; }
    });

    buildBar();
  }

  function editableFrom(t) { return t && t.closest ? t.closest('[data-e]') : null; }
  function inEditorUI(t) { return t && t.closest && t.closest('.ed-bar, .ed-modal-bg, .ed-pop, .ed-img-tools, .ed-alt'); }

  // 编辑时点链接不跳转
  function onClick(e) {
    var a = e.target.closest && e.target.closest('a');
    if (!a || a.hasAttribute('download')) return;
    if (inEditorUI(e.target)) {
      // 工具栏、弹窗里的链接照常打开；照片上的按钮和输入框在作品卡片（链接）里面，要拦住跳转
      if (e.target.closest('.ed-bar, .ed-modal-bg, .ed-pop')) return;
      if (e.target.matches && e.target.matches('input[type=file]')) return;
      e.preventDefault();
      return;
    }
    e.preventDefault();
  }

  function onInput(e) {
    var n = editableFrom(e.target);
    if (!n) return;
    var k = n.getAttribute('data-e');
    var v = clean(n);
    // 同一内容在页面上出现多次（比如名字），一起更新
    $$('[data-e="' + k + '"]').forEach(function (m) {
      if (m !== n && clean(m) !== v) m.innerHTML = v;
    });
    if (k === 'site.email') {
      var t = n.textContent.trim();
      if (EMAIL_RE.test(t)) setLink('site.email', 'mailto:' + t);
    }
    markChanged(k);
    refresh();
  }

  function onKey(e) {
    var n = editableFrom(e.target);
    if (!n) return;
    if (e.key === 'Escape') { n.blur(); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (MULTILINE[n.tagName]) {
        if (!document.execCommand('insertLineBreak')) document.execCommand('insertHTML', false, '<br>');
      } else n.blur();
    }
  }

  function onPaste(e) {
    var n = editableFrom(e.target);
    if (!n) return;
    e.preventDefault();
    var text = (e.clipboardData || window.clipboardData).getData('text/plain') || '';
    if (!MULTILINE[n.tagName]) text = text.replace(/\s*\n\s*/g, ' ');
    document.execCommand('insertText', false, text);
  }

  function markChanged(k) {
    var changed = $$('[data-e="' + k + '"]')[0];
    var isChanged = changed && clean(changed) !== orig[k];
    $$('[data-e="' + k + '"]').forEach(function (m) { m.classList.toggle('ed-changed', !!isChanged); });
  }

  /* ---------- 链接 ---------- */
  function setLink(k, url) {
    links[k] = url;
    $$('[data-href="' + k + '"]').forEach(function (a) { a.setAttribute('href', url); });
    refresh();
  }

  function onFocus(e) {
    if (pop && pop.contains(e.target)) return;
    var n = editableFrom(e.target);
    var a = n && n.closest('a[data-href]');
    if (!a || a.getAttribute('data-href') === 'site.email') { closePop(); return; }
    openLinkPop(a);
  }

  function openLinkPop(a) {
    var k = a.getAttribute('data-href');
    closePop();
    popKey = k;
    pop = el('div', { 'class': 'ed-pop' });
    pop.appendChild(el('p', null, '这个链接点开后去哪里？填完整网址，比如 https://www.instagram.com/你的账号'));
    var input = el('input', { 'class': 'ed-input', type: 'url', placeholder: 'https://', 'aria-label': '链接地址' });
    input.value = links[k] && links[k] !== '#' ? links[k] : '';
    input.addEventListener('input', function () { setLink(k, input.value.trim() || '#'); });
    input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === 'Escape') closePop(); });
    pop.appendChild(input);
    document.body.appendChild(pop);
    var r = a.getBoundingClientRect();
    var left = Math.min(Math.max(16, r.left + window.scrollX), window.scrollX + document.documentElement.clientWidth - pop.offsetWidth - 16);
    pop.style.left = left + 'px';
    pop.style.top = (r.bottom + window.scrollY + 10) + 'px';
  }

  function closePop() { if (pop) { pop.remove(); pop = null; popKey = null; } }
  document.addEventListener('mousedown', function (e) {
    if (pop && !pop.contains(e.target) && !(e.target.closest && e.target.closest('a[data-href="' + popKey + '"]'))) closePop();
  });

  /* ---------- 照片 ---------- */
  function addImageTools(img) {
    var frame = img.closest('.frame') || img.parentNode;
    if (frame.querySelector('.ed-img-tools')) return;
    var k = img.getAttribute('data-i');
    var tools = el('div', { 'class': 'ed-img-tools' });
    var btn = el('button', { 'class': 'ed-btn', type: 'button' }, '换照片');
    var file = el('input', { type: 'file', accept: 'image/*', hidden: '' });
    btn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); file.click(); });
    file.addEventListener('change', function () {
      if (file.files && file.files[0]) replaceImage(k, file.files[0], btn);
      file.value = '';
    });
    tools.appendChild(btn);
    tools.appendChild(file);
    frame.appendChild(tools);
  }

  function loadBitmap(file) {
    if (window.createImageBitmap) {
      return createImageBitmap(file, { imageOrientation: 'from-image' }).catch(function () { return loadViaImg(file); });
    }
    return loadViaImg(file);
  }
  function loadViaImg(file) {
    return new Promise(function (res, rej) {
      var im = new Image();
      im.onload = function () { res(im); };
      im.onerror = function () { rej(new Error('读不了这张图片')); };
      im.src = URL.createObjectURL(file);
    });
  }
  function toBlob(canvas, type, q) { return new Promise(function (r) { canvas.toBlob(r, type, q); }); }

  // 压缩：长边不超过 2560px，重新编码会去掉 GPS 等拍摄信息
  function compress(file) {
    return loadBitmap(file).then(function (bmp) {
      var bw = bmp.width || bmp.naturalWidth, bh = bmp.height || bmp.naturalHeight;
      var s = Math.min(1, MAX_EDGE / Math.max(bw, bh));
      var w = Math.round(bw * s), h = Math.round(bh * s);
      var c = document.createElement('canvas');
      c.width = w; c.height = h;
      var ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bmp, 0, 0, w, h);
      return toBlob(c, 'image/webp', 0.82).then(function (b) {
        if (b && b.type === 'image/webp') return { blob: b, w: w, h: h, ext: 'webp' };
        return toBlob(c, 'image/jpeg', 0.86).then(function (j) { return { blob: j, w: w, h: h, ext: 'jpg' }; });
      });
    });
  }

  function replaceImage(k, file, btn) {
    btn.disabled = true;
    btn.textContent = '处理中…';
    compress(file).then(function (r) {
      var safe = k.replace(/^site\./, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
      var prev = imgs[k];
      if (prev && prev.url) URL.revokeObjectURL(prev.url);
      var url = URL.createObjectURL(r.blob);
      imgs[k] = { blob: r.blob, w: r.w, h: r.h, path: 'assets/img/' + safe + '-' + stamp() + '.' + r.ext, alt: '', url: url };
      $$('img[data-i="' + k + '"]').forEach(function (img) {
        img.src = url;
        img.width = r.w;
        img.height = r.h;
        img.alt = '';
        img.removeAttribute('loading');
      });
      showAlt(k, btn.closest('.frame'));
      refresh();
      say('照片已换好（' + r.w + '×' + r.h + '，' + Math.round(r.blob.size / 1024) + ' KB）。记得发布。', 'ok');
    }).catch(function (err) {
      say('这张照片处理失败：' + err.message + '。换一张 JPG 试试。', 'err');
    }).then(function () {
      btn.disabled = false;
      btn.textContent = '换照片';
    });
  }

  function showAlt(k, frame) {
    if (!frame) return;
    var old = frame.querySelector('.ed-alt');
    if (old) old.remove();
    var box = el('div', { 'class': 'ed-alt' });
    var id = 'alt-' + k.replace(/\W/g, '-');
    box.appendChild(el('label', { 'for': id }, '照片描述（可不填）'));
    var input = el('input', { 'class': 'ed-input', id: id, type: 'text', placeholder: '比如：傍晚的玄武湖，一个人在湖边跑步' });
    input.addEventListener('input', function () {
      if (imgs[k]) imgs[k].alt = input.value.trim();
      $$('img[data-i="' + k + '"]').forEach(function (img) { img.alt = input.value.trim(); });
    });
    input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') box.remove(); });
    var ok = el('button', { 'class': 'ed-btn', type: 'button' }, '完成');
    ok.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); box.remove(); });
    box.appendChild(input);
    box.appendChild(ok);
    box.addEventListener('click', function (e) { e.stopPropagation(); });
    frame.appendChild(box);
  }

  /* ---------- 收集修改 ---------- */
  function collect() {
    var text = {}, seen = {};
    $$('[data-e]').forEach(function (n) {
      var k = n.getAttribute('data-e');
      if (seen[k]) return;
      seen[k] = 1;
      var v = clean(n);
      if (v !== orig[k]) text[k] = v;
    });
    var l = {};
    Object.keys(links).forEach(function (k) { if (links[k] !== origLinks[k]) l[k] = links[k]; });
    return { text: text, links: l, imgs: imgs };
  }
  function changeCount() {
    var c = collect();
    return Object.keys(c.text).length + Object.keys(c.links).length + Object.keys(c.imgs).length;
  }
  function touchesSite(c) {
    return Object.keys(c.text).some(isSite) || Object.keys(c.links).some(isSite) || Object.keys(c.imgs).some(isSite);
  }

  // 把修改写进一个页面的源码（只改有标记的元素，其他内容原样保留）
  function patch(src, c, isCurrent) {
    var doc = new DOMParser().parseFromString(src, 'text/html');
    var touched = false;
    var allow = function (k) { return isCurrent || isSite(k); };
    Object.keys(c.text).forEach(function (k) {
      if (!allow(k)) return;
      $$('[data-e="' + k + '"]', doc).forEach(function (n) { n.innerHTML = c.text[k]; touched = true; });
    });
    Object.keys(c.links).forEach(function (k) {
      if (!allow(k)) return;
      $$('[data-href="' + k + '"]', doc).forEach(function (a) { a.setAttribute('href', c.links[k]); touched = true; });
    });
    Object.keys(c.imgs).forEach(function (k) {
      if (!allow(k)) return;
      var im = c.imgs[k];
      $$('img[data-i="' + k + '"]', doc).forEach(function (img) {
        img.setAttribute('src', im.path);
        img.setAttribute('width', im.w);
        img.setAttribute('height', im.h);
        img.setAttribute('alt', im.alt || '');
        touched = true;
      });
    });
    if (c.text['site.name'] !== undefined) {
      var oldName = textOf(orig['site.name']).trim(), newName = textOf(c.text['site.name']).trim();
      if (oldName && doc.title.indexOf(oldName) >= 0) { doc.title = doc.title.split(oldName).join(newName); touched = true; }
    }
    if (!touched) return null;
    // 序列化后把结尾整理回原样，避免每次发布都多出空行
    return '<!doctype html>\n' + doc.documentElement.outerHTML.replace(/\s*<\/body>\s*<\/html>\s*$/, '\n</body>\n</html>') + '\n';
  }

  function afterSaved() {
    $$('[data-e]').forEach(function (n) { orig[n.getAttribute('data-e')] = clean(n); n.classList.remove('ed-changed'); });
    Object.keys(links).forEach(function (k) { origLinks[k] = links[k]; });
    imgs = {};
    refresh();
  }

  /* ---------- 下载修改（备用） ---------- */
  var CRC = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(u8) { var c = 0xFFFFFFFF; for (var i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  function makeZip(files) {
    var enc = new TextEncoder(), parts = [], central = [], offset = 0, d = new Date();
    var time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
    var date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    files.forEach(function (f) {
      var name = enc.encode(f.name), data = f.data, crc = crc32(data);
      var h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
      h.setUint16(10, time, true); h.setUint16(12, date, true); h.setUint32(14, crc, true);
      h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
      parts.push(new Uint8Array(h.buffer), name, data);
      var cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true);
      cd.setUint16(10, 0, true); cd.setUint16(12, time, true); cd.setUint16(14, date, true); cd.setUint32(16, crc, true);
      cd.setUint32(20, data.length, true); cd.setUint32(24, data.length, true); cd.setUint16(28, name.length, true);
      cd.setUint16(30, 0, true); cd.setUint16(32, 0, true); cd.setUint16(34, 0, true); cd.setUint16(36, 0, true);
      cd.setUint32(38, 0, true); cd.setUint32(42, offset, true);
      central.push(new Uint8Array(cd.buffer), name);
      offset += 30 + name.length + data.length;
    });
    var size = central.reduce(function (s, a) { return s + a.length; }, 0);
    var end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, size, true); end.setUint32(16, offset, true);
    return new Blob(parts.concat(central, [new Uint8Array(end.buffer)]), { type: 'application/zip' });
  }

  function download() {
    var c = collect();
    if (!changeCount()) { say('还没有修改。', ''); return; }
    var targets = touchesSite(c) ? PAGES : [current];
    var enc = new TextEncoder();
    say('正在打包…', '');
    Promise.all(targets.map(function (f) {
      return fetch(f, { cache: 'no-store' }).then(function (r) { return r.text(); }).then(function (src) {
        var out = patch(src, c, f === current);
        return out ? { name: f, data: enc.encode(out) } : null;
      });
    })).then(function (pages) {
      var files = pages.filter(Boolean);
      return Promise.all(Object.keys(c.imgs).map(function (k) {
        return c.imgs[k].blob.arrayBuffer().then(function (b) { return { name: c.imgs[k].path, data: new Uint8Array(b) }; });
      })).then(function (pics) { return files.concat(pics); });
    }).then(function (files) {
      var blob = makeZip(files);
      var a = el('a', { href: URL.createObjectURL(blob), download: '网站修改-' + stamp() + '.zip' });
      document.body.appendChild(a);
      a.click();
      a.remove();
      say('已下载 ' + files.length + ' 个文件。解压后，把里面的文件拖到 GitHub 仓库的上传页面（Add file → Upload files），同名文件会被替换。', 'ok');
    }).catch(function (err) { say('打包失败：' + err.message, 'err'); });
  }

  /* ---------- 发布到 GitHub ---------- */
  function loadCfg() {
    try { return JSON.parse(localStorage.getItem('siteEditor') || sessionStorage.getItem('siteEditor') || '{}'); } catch (e) { return {}; }
  }
  function saveCfg(cfg, remember) {
    try {
      var s = JSON.stringify(cfg);
      if (remember) { localStorage.setItem('siteEditor', s); sessionStorage.removeItem('siteEditor'); }
      else { sessionStorage.setItem('siteEditor', s); localStorage.removeItem('siteEditor'); }
    } catch (e) { /* 浏览器不让存，就只在这次用 */ }
  }
  function guessRepo() {
    var h = location.hostname;
    if (/\.github\.io$/i.test(h)) {
      var owner = h.split('.')[0];
      var seg = location.pathname.split('/').filter(Boolean)[0];
      if (seg && !/\.html?$/i.test(seg)) return owner + '/' + seg;
      return owner + '/' + h.toLowerCase();
    }
    return '';
  }

  function settings(cfg, onSave) {
    var bg = el('div', { 'class': 'ed-modal-bg' });
    var box = el('div', { 'class': 'ed-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'ed-set-title' });
    box.innerHTML =
      '<h2 id="ed-set-title">连接 GitHub</h2>' +
      '<p>只需要设置一次。发布时，编辑器用一个只能改这个仓库的"令牌"替你提交修改。</p>' +
      '<ol>' +
      '<li>打开 <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">GitHub 新建令牌页面</a>（Fine-grained token）。</li>' +
      '<li>Token name 随便填；Expiration 选一年。</li>' +
      '<li>Repository access 选 Only select repositories，选你的网站仓库。</li>' +
      '<li>Permissions 里找到 Contents，设为 Read and write。</li>' +
      '<li>点 Generate token，复制生成的令牌，粘贴到下面。</li>' +
      '</ol>' +
      '<label for="ed-repo">仓库（用户名/仓库名）</label>' +
      '<input class="ed-input" id="ed-repo" placeholder="yourname/yourname.github.io">' +
      '<label for="ed-token">令牌</label>' +
      '<input class="ed-input" id="ed-token" type="password" placeholder="github_pat_…" autocomplete="off">' +
      '<label class="ed-check"><input type="checkbox" id="ed-remember" checked> 在这台电脑上记住（公共电脑别勾）</label>' +
      '<p id="ed-set-err" style="color:#a3402a;margin:10px 0 0"></p>' +
      '<div class="ed-actions"><button type="button" class="ed-btn" id="ed-cancel">取消</button><button type="button" class="ed-btn primary" id="ed-save">保存并发布</button></div>';
    bg.appendChild(box);
    document.body.appendChild(bg);
    var repo = $('#ed-repo', box), token = $('#ed-token', box), remember = $('#ed-remember', box);
    repo.value = cfg.repo || guessRepo();
    token.value = cfg.token || '';
    (repo.value ? token : repo).focus();
    function close() { bg.remove(); }
    $('#ed-cancel', box).addEventListener('click', close);
    bg.addEventListener('click', function (e) { if (e.target === bg) close(); });
    box.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
    $('#ed-save', box).addEventListener('click', function () {
      var r = repo.value.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '').replace(/\/+$/, '');
      var t = token.value.trim();
      if (!/^[^/\s]+\/[^/\s]+$/.test(r)) { $('#ed-set-err', box).textContent = '仓库要写成"用户名/仓库名"。'; repo.focus(); return; }
      if (!t) { $('#ed-set-err', box).textContent = '请粘贴令牌。'; token.focus(); return; }
      var next = { repo: r, token: t, folder: cfg.folder || '' };
      saveCfg(next, remember.checked);
      close();
      onSave(next);
    });
  }

  function gh(cfg, method, path, body) {
    var headers = { 'Accept': 'application/vnd.github+json', 'Authorization': 'Bearer ' + cfg.token, 'X-GitHub-Api-Version': '2022-11-28' };
    if (body) headers['Content-Type'] = 'application/json';
    return fetch(API + path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) { var e = new Error(t || res.statusText); e.status = res.status; throw e; });
      }
      return res.status === 204 ? null : res.json();
    });
  }
  function b64ToText(b64) {
    var bin = atob(b64.replace(/\s/g, ''));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  function blobToB64(blob) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { res(String(fr.result).split(',')[1]); };
      fr.onerror = function () { rej(fr.error); };
      fr.readAsDataURL(blob);
    });
  }
  function encPath(p) { return p.split('/').map(encodeURIComponent).join('/'); }

  function explain(err) {
    if (err instanceof TypeError) return '连不上 GitHub（可能是网络问题）。可以稍后再试，或者先点"下载修改"。';
    switch (err.status) {
      case 401: return '令牌不对或已过期。点"GitHub 设置"重新粘贴一个。';
      case 403: return '令牌没有写入权限：新建令牌时要把 Contents 设为 Read and write。';
      case 404: return '找不到仓库或文件：检查仓库名，以及令牌有没有选中这个仓库。';
      case 409: case 422: return '仓库刚被别处改过。刷新页面后重新修改并发布。';
      default: return '发布失败（' + (err.status || '') + '）：' + String(err.message).slice(0, 200);
    }
  }

  function publish(cfg) {
    var c = collect();
    if (!changeCount()) { say('还没有修改。', ''); return; }
    var parts = cfg.repo.split('/'), base = '/repos/' + encodeURIComponent(parts[0]) + '/' + encodeURIComponent(parts[1]);
    var folder = cfg.folder ? cfg.folder.replace(/^\/+|\/+$/g, '') + '/' : '';
    var targets = touchesSite(c) ? PAGES : [current];
    var branch, baseCommit, files = [];
    setBusy(true);
    say('正在连接 GitHub…', '');
    gh(cfg, 'GET', base).then(function (repo) {
      branch = cfg.branch || repo.default_branch || 'main';
      return gh(cfg, 'GET', base + '/git/ref/heads/' + encPath(branch));
    }).then(function (ref) {
      baseCommit = ref.object.sha;
      return gh(cfg, 'GET', base + '/git/commits/' + baseCommit);
    }).then(function (commit) {
      var baseTree = commit.tree.sha;
      say('正在读取最新的页面…', '');
      // 以仓库里最新的文件为底稿，只替换改过的元素
      return targets.reduce(function (p, f) {
        return p.then(function () {
          return gh(cfg, 'GET', base + '/contents/' + encPath(folder + f) + '?ref=' + encodeURIComponent(branch)).then(function (file) {
            var src = b64ToText(file.content);
            var out = patch(src, c, f === current);
            if (out && out !== src) files.push({ path: folder + f, text: out });
          });
        });
      }, Promise.resolve()).then(function () { return baseTree; });
    }).then(function (baseTree) {
      var keys = Object.keys(c.imgs);
      return keys.reduce(function (p, k) {
        return p.then(function () {
          return blobToB64(c.imgs[k].blob).then(function (b64) { files.push({ path: folder + c.imgs[k].path, b64: b64 }); });
        });
      }, Promise.resolve()).then(function () { return baseTree; });
    }).then(function (baseTree) {
      if (!files.length) { var none = new Error('nothing'); none.nothing = true; throw none; }
      var tree = [], i = 0;
      return files.reduce(function (p, f) {
        return p.then(function () {
          i++;
          say('正在上传 ' + i + ' / ' + files.length + '…', '');
          var body = f.text !== undefined ? { content: f.text, encoding: 'utf-8' } : { content: f.b64, encoding: 'base64' };
          return gh(cfg, 'POST', base + '/git/blobs', body).then(function (b) {
            tree.push({ path: f.path, mode: '100644', type: 'blob', sha: b.sha });
          });
        });
      }, Promise.resolve()).then(function () {
        return gh(cfg, 'POST', base + '/git/trees', { base_tree: baseTree, tree: tree });
      });
    }).then(function (tree) {
      var n = Object.keys(c.text).length + Object.keys(c.links).length + Object.keys(c.imgs).length;
      return gh(cfg, 'POST', base + '/git/commits', { message: '网页编辑器：更新 ' + n + ' 处内容（' + PAGE_NAMES[current] + '）', tree: tree.sha, parents: [baseCommit] });
    }).then(function (commit) {
      return gh(cfg, 'PATCH', base + '/git/refs/heads/' + encPath(branch), { sha: commit.sha }).then(function () { return commit; });
    }).then(function (commit) {
      afterSaved();
      var link = commit.html_url ? '（<a href="' + commit.html_url + '" target="_blank" rel="noopener">查看这次提交</a>）' : '';
      say('已发布 ' + files.length + ' 个文件' + link + '。一两分钟后刷新网站就能看到；如果还是旧的，再等几分钟或强制刷新（Ctrl+F5）。', 'ok', true);
    }).catch(function (err) {
      if (err.nothing) { afterSaved(); say('仓库里已经是这些内容了，不需要发布。', 'ok'); return; }
      say(explain(err), 'err');
    }).then(function () { setBusy(false); });
  }

  function startPublish(forceSettings) {
    var cfg = loadCfg();
    if (forceSettings || !cfg.repo || !cfg.token) settings(cfg, publish);
    else publish(cfg);
  }

  /* ---------- 工具栏 ---------- */
  function buildBar() {
    bar = el('div', { 'class': 'ed-bar', role: 'region', 'aria-label': '网页编辑器' });
    var opts = PAGES.map(function (f) { return '<option value="' + f + '"' + (f === current ? ' selected' : '') + '>' + PAGE_NAMES[f] + '</option>'; }).join('');
    bar.innerHTML =
      '<div class="ed-bar-row">' +
      '<strong>编辑模式</strong><span class="ed-count">还没有修改</span>' +
      '<select class="ed-page" aria-label="切换页面">' + opts + '</select>' +
      '<span class="ed-spacer"></span>' +
      '<button type="button" class="ed-btn ed-dl">下载修改</button>' +
      '<button type="button" class="ed-btn ed-set">GitHub 设置</button>' +
      '<button type="button" class="ed-btn primary ed-pub">发布到 GitHub</button>' +
      '<button type="button" class="ed-btn ed-exit">退出</button>' +
      '</div>' +
      '<div class="ed-hint">点虚线框里的文字直接改，回车换行；照片右上角可以换图。导航、名字、页脚这些全站共用的内容，改一处，所有页面一起更新。</div>' +
      '<div class="ed-msg" hidden></div>';
    document.body.appendChild(bar);
    countEl = $('.ed-count', bar);
    msgEl = $('.ed-msg', bar);
    $('.ed-dl', bar).addEventListener('click', download);
    $('.ed-pub', bar).addEventListener('click', function () { startPublish(false); });
    $('.ed-set', bar).addEventListener('click', function () { settings(loadCfg(), function () { say('GitHub 设置已保存。', 'ok'); }); });
    $('.ed-exit', bar).addEventListener('click', function () {
      if (changeCount() > 0 && !confirm('还有修改没有发布，确定退出吗？')) return;
      leaving = true;
      location.href = location.pathname;
    });
    $('.ed-page', bar).addEventListener('change', function (e) {
      var f = e.target.value;
      if (changeCount() > 0) {
        e.target.value = current;
        say('这一页还有修改没有发布：先点"发布到 GitHub"或"下载修改"，再切换页面。', 'err');
        return;
      }
      location.href = f + '#edit';
    });
    refresh();
  }

  function setBusy(b) { $$('.ed-btn', bar).forEach(function (x) { x.disabled = b; }); }

  function say(text, kind, html) {
    if (!msgEl) return;
    msgEl.hidden = !text;
    msgEl.className = 'ed-msg' + (kind ? ' ' + kind : '');
    if (html) msgEl.innerHTML = text; else msgEl.textContent = text;
  }

  function refresh() {
    if (!countEl) return;
    var n = changeCount();
    countEl.textContent = n ? '已修改 ' + n + ' 处，未发布' : '还没有修改';
  }

  // 暴露给测试用
  window.__siteEditor = { collect: collect, patch: patch, makeZip: makeZip, clean: clean };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
