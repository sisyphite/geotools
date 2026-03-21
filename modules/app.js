/**
 * app.js — 应用主控
 * 负责：导航切换、模块初始化、时钟、proj4 状态检测
 */

(function () {

  // ── 模块注册表 ───────────────────────────────────────────────────
  const MODULES = [
    { id: 'format-convert',  mod: typeof FormatConvert  !== 'undefined' ? FormatConvert  : null },
    { id: 'projection',      mod: typeof Projection     !== 'undefined' ? Projection     : null },
    { id: 'param-transform', mod: typeof ParamTransform !== 'undefined' ? ParamTransform : null },
  ];

  // ── 初始化 ───────────────────────────────────────────────────────
  function init() {
    // 渲染所有模块
    MODULES.forEach(({ id, mod }) => {
      const container = document.getElementById(`module-${id}`);
      if (container && mod && typeof mod.render === 'function') {
        mod.render(container);
      }
    });

    // 导航按钮绑定
    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const target = btn.dataset.module;
        switchModule(target);
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    // 时钟
    updateClock();
    setInterval(updateClock, 1000);

    // proj4 状态检测
    checkProj4();
  }

  function switchModule(id) {
    document.querySelectorAll('.module').forEach(m => m.classList.remove('active'));
    const target = document.getElementById(`module-${id}`);
    if (target) target.classList.add('active');
  }

  function updateClock() {
    const el = document.getElementById('clock');
    if (!el) return;
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    el.textContent = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}  ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  }

  function checkProj4() {
    const el = document.getElementById('status-proj4');
    if (!el) return;
    // proj4 可能异步加载，轮询检测
    let attempts = 0;
    const check = setInterval(() => {
      attempts++;
      if (typeof proj4 !== 'undefined') {
        el.textContent = `proj4 ${proj4.version || 'OK'}`;
        el.classList.add('ok');
        clearInterval(check);
      } else if (attempts > 30) {
        el.textContent = 'proj4 未加载（离线功能受限）';
        el.classList.add('error');
        clearInterval(check);
      }
    }, 300);
  }

  // DOM 就绪后初始化
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
