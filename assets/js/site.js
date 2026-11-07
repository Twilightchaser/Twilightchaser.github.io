// 网址末尾加 #ids：显示每个元素的编号，方便说"把 A1 改成……"
// 网址末尾加 #edit：打开网页编辑器，直接在页面上改字、换照片
if (location.hash === '#ids') document.documentElement.classList.add('show-ids');
if (location.hash === '#edit') {
  var edCss = document.createElement('link');
  edCss.rel = 'stylesheet';
  edCss.href = 'assets/css/editor.css';
  document.head.appendChild(edCss);
  var edJs = document.createElement('script');
  edJs.src = 'assets/js/editor.js';
  document.body.appendChild(edJs);
}
window.addEventListener('hashchange', function () {
  if (location.hash === '#edit' || location.hash === '#ids') location.reload();
});

// 回到顶部
document.querySelectorAll('.to-top').forEach(function (a) {
  a.addEventListener('click', function (e) {
    e.preventDefault();
    if (document.documentElement.classList.contains('is-editing')) return;
    var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
  });
});
