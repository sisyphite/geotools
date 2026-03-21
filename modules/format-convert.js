/**
 * format-convert.js — 模块A：格式转换
 *
 * 设计原则：
 *  1. 单值转换：用户指定输入格式，所有输出格式同时展示，无需选择输出格式
 *  2. 批量转换：强制单列输入（每行一个坐标值），自动识别分隔符（仅用于跳过空行判断）
 *     支持的来源：任何能复制出纯文本的软件（Excel、WPS、记事本……）
 *     分隔符自动识别：制表符 / 逗号（含前后空白）/ 多个连续空白
 *     注：单列输入无需分隔符，此逻辑保留供后续模块复用
 *  3. 输出每行一个值，可直接复制回表格软件
 */

const FormatConvert = (() => {

  // ── 输入格式定义 ─────────────────────────────────────────────────
  const INPUT_FORMATS = [
    {
      id: 'dms_symbol',
      label: 'DD°MM\'SS.ss"',
      example: '118°23\'45.678"',
      hint: '带符号，支持 ° ′ ″ 等变体，如 118°23\'45.678" 或 -39°12\'33.4"',
      parse: parseDmsSymbol,
    },
    {
      id: 'dms_space',
      label: 'DD MM SS.ss',
      example: '118 23 45.678',
      hint: '空格分隔三段，如 118 23 45.678 或 -39 12 33.4',
      parse: parseDmsSpace,
    },
    {
      id: 'dms_dash',
      label: 'DD-MM-SS.ss',
      example: '118-23-45.678',
      hint: '连字符分隔，如 118-23-45.678 或 -39-12-33.4',
      parse: parseDmsDash,
    },
    {
      id: 'dms_concat',
      label: 'DDMMSS.ss（拼接）',
      example: '1182345.678',
      hint: '度分秒直接拼接，无分隔符，度为 2 或 3 位，如 1182345.678 或 391233.4',
      parse: parseDmsConcat,
    },
    {
      id: 'decimal',
      label: 'DD.dddddd（十进制）',
      example: '118.396022',
      hint: '十进制度，直接数字，如 118.396022 或 -39.209278',
      parse: parseDecimal,
    },
  ];

  // ── 输出格式定义（单值转换：全部展示；批量转换：用户选一种）────
  const OUTPUT_FORMATS = [
    { id: 'dms_symbol', label: 'DD°MM\'SS.ssss"',   format: toDmsSymbol },
    { id: 'dms_space',  label: 'DD MM SS.ssss',      format: toDmsSpace  },
    { id: 'dms_dash',   label: 'DD-MM-SS.ssss',      format: toDmsDash   },
    { id: 'dm',         label: 'DD°MM.mmmmmm\'',     format: toDm        },
    { id: 'decimal_6',  label: 'DD.dddddd（6位）',   format: d => d.toFixed(6) },
    { id: 'decimal_8',  label: 'DD.dddddddd（8位）', format: d => d.toFixed(8) },
    { id: 'rad',        label: '弧度 rad（10位）',   format: d => (d * Math.PI / 180).toFixed(10) },
  ];

  // ── 解析函数 ─────────────────────────────────────────────────────

  function parseDmsSymbol(str) {
    str = str.trim();
    // 负号或方向标识
    const negSign = str.startsWith('-');
    // 正则：支持 ° º ′ ' ″ " 等各种变体，秒可省略引号
    const m = str.match(/(\d+)\s*[°º]\s*(\d+)\s*[′']\s*([\d.]+)\s*[″"′']?\s*([NSEWnsew])?/);
    if (!m) throw new Error(`格式不匹配 DD°MM'SS"，输入为："${str}"`);
    const dd = +m[1] + +m[2] / 60 + +m[3] / 3600;
    const negDir = ['S','W'].includes((m[4] || '').toUpperCase());
    return (negSign || negDir) ? -dd : dd;
  }

  function parseDmsSpace(str) {
    str = str.trim();
    const neg = str.startsWith('-');
    const parts = str.replace(/^-/, '').trim().split(/\s+/);
    if (parts.length !== 3) throw new Error(`需三段空格分隔的数字，得到 ${parts.length} 段："${str}"`);
    const [d, m, s] = parts.map(Number);
    if ([d, m, s].some(isNaN)) throw new Error(`包含非数字内容："${str}"`);
    return neg ? -(d + m / 60 + s / 3600) : (d + m / 60 + s / 3600);
  }

  function parseDmsDash(str) {
    str = str.trim();
    const neg = str.startsWith('-');
    const parts = str.replace(/^-/, '').split('-');
    if (parts.length !== 3) throw new Error(`需三段连字符分隔，得到 ${parts.length} 段："${str}"`);
    const [d, m, s] = parts.map(Number);
    if ([d, m, s].some(isNaN)) throw new Error(`包含非数字内容："${str}"`);
    return neg ? -(d + m / 60 + s / 3600) : (d + m / 60 + s / 3600);
  }

  function parseDmsConcat(str) {
    str = str.trim();
    const neg = str.startsWith('-');
    const s = str.replace(/^-/, '');
    const dotIdx = s.indexOf('.');
    const intPart = dotIdx >= 0 ? s.slice(0, dotIdx) : s;
    const decPart = dotIdx >= 0 ? s.slice(dotIdx) : '.0';
    // 度数长度：整数部分总长 = degLen + 2（分）+ 2（秒整数）= degLen + 4
    // intPart.length >= 7 → 3位度（如 1182345）；>= 6 → 2位度（如 392345）
    let degLen;
    if      (intPart.length >= 7) degLen = 3;
    else if (intPart.length >= 6) degLen = 2;
    else throw new Error(`位数不足，无法判断度数长度："${str}"（期望至少 6 位整数部分）`);
    const deg = parseInt(intPart.slice(0, degLen), 10);
    const min = parseInt(intPart.slice(degLen, degLen + 2), 10);
    const sec = parseFloat(intPart.slice(degLen + 2) + decPart);
    if (min >= 60 || sec >= 60) throw new Error(`分或秒超出范围：${min}′ ${sec}″`);
    const dd = deg + min / 60 + sec / 3600;
    return neg ? -dd : dd;
  }

  function parseDecimal(str) {
    str = str.trim();
    const v = parseFloat(str);
    if (isNaN(v)) throw new Error(`不是有效数字："${str}"`);
    return v;
  }

  // ── 格式化函数 ───────────────────────────────────────────────────

  function toDmsSymbol(dd) {
    const neg = dd < 0, abs = Math.abs(dd);
    const deg = Math.floor(abs);
    const minF = (abs - deg) * 60;
    const min = Math.floor(minF);
    const sec = (minF - min) * 60;
    return `${neg?'-':''}${deg}°${pad2(min)}'${padSec(sec)}"`;
  }

  function toDmsSpace(dd) {
    const neg = dd < 0, abs = Math.abs(dd);
    const deg = Math.floor(abs);
    const minF = (abs - deg) * 60;
    const min = Math.floor(minF);
    const sec = (minF - min) * 60;
    return `${neg?'-':''}${deg} ${pad2(min)} ${padSec(sec)}`;
  }

  function toDmsDash(dd) {
    const neg = dd < 0, abs = Math.abs(dd);
    const deg = Math.floor(abs);
    const minF = (abs - deg) * 60;
    const min = Math.floor(minF);
    const sec = (minF - min) * 60;
    return `${neg?'-':''}${deg}-${pad2(min)}-${padSec(sec)}`;
  }

  function toDm(dd) {
    const neg = dd < 0, abs = Math.abs(dd);
    const deg = Math.floor(abs);
    const min = (abs - deg) * 60;
    return `${neg?'-':''}${deg}°${min.toFixed(6).padStart(9,'0')}'`;
  }

  // 补零辅助
  function pad2(n)  { return String(n).padStart(2, '0'); }
  function padSec(s){ return s.toFixed(4).padStart(7, '0'); }

  // ── 分隔符自动识别（供批量转换及后续模块复用）──────────────────
  /**
   * splitLine(line) → string[]
   * 按以下优先级自动识别：
   *   1. 制表符 \t
   *   2. 逗号（含前后任意空白），如 "a , b" → ['a','b']
   *   3. 两个及以上连续空白
   *   4. 无法分割则返回 [line.trim()]（单列）
   */
  function splitLine(line) {
    if (line.includes('\t'))         return line.split('\t').map(s => s.trim());
    if (/\s*,\s*/.test(line))        return line.split(/\s*,\s*/).map(s => s.trim());
    if (/\s{2,}/.test(line.trim()))  return line.trim().split(/\s{2,}/).map(s => s.trim());
    return [line.trim()];
  }

  // ── 状态 ─────────────────────────────────────────────────────────
  let singleInputFmt = 'dms_symbol';
  let batchInputFmt  = 'dms_symbol';
  let batchOutputFmt = 'decimal_6';

  // ── UI 渲染 ──────────────────────────────────────────────────────

  function render(container) {
    container.innerHTML = `
      <div class="module-header">
        <h1 class="module-title">格式转换</h1>
        <span class="module-badge">模块 A</span>
      </div>

      <!-- ══ 单值转换 ══ -->
      <div class="section-title">单值转换</div>
      <div class="panel">
        <div class="layout-2col">

          <!-- 左：输入区 -->
          <div>
            <label class="field-label">输入格式（手动指定）</label>
            <div class="format-selector" id="fc-in-fmt"></div>
            <div class="format-example" id="fc-in-example"></div>
            <p class="hint" id="fc-in-hint" style="margin-top:6px"></p>

            <div style="height:14px"></div>
            <label class="field-label">输入值</label>
            <input type="text" id="fc-single-input"
              placeholder="输入坐标值，按 Enter 转换…"
              autocomplete="off" spellcheck="false">

            <div style="height:12px"></div>
            <div class="btn-group">
              <button class="btn btn-primary" onclick="FormatConvert.convertSingle()">转换</button>
              <button class="btn btn-secondary" onclick="FormatConvert.clearSingle()">清空</button>
            </div>
          </div>

          <!-- 右：输出区（全部格式同时展示，无需选择）-->
          <div>
            <label class="field-label">所有格式结果</label>
            <div id="fc-single-results">
              ${OUTPUT_FORMATS.map(f => `
                <div class="data-row">
                  <span class="data-key">${f.label}</span>
                  <span class="data-val num" id="fc-val-${f.id}">—</span>
                  <button class="data-copy" onclick="FormatConvert.copyVal('fc-val-${f.id}', this)">Copy</button>
                </div>
              `).join('')}
            </div>
          </div>

        </div>
      </div>

      <!-- ══ 批量转换 ══ -->
      <div class="section-title">批量转换</div>
      <div class="alert alert-info">
        每行一个坐标值，直接粘贴即可。支持来自 Excel、WPS、记事本等任何来源。
        输出每行一个值，可直接复制回表格。
      </div>
      <div class="panel">

        <div class="layout-2col" style="margin-bottom:16px">
          <div>
            <label class="field-label">输入格式（手动指定）</label>
            <div class="format-selector" id="fc-batch-in-fmt"></div>
            <div class="format-example" id="fc-batch-in-example"></div>
          </div>
          <div>
            <label class="field-label">输出格式</label>
            <div class="format-selector" id="fc-batch-out-fmt"></div>


          </div>
        </div>

        <div class="layout-2col">
          <div>
            <label class="field-label">输入（每行一个值）</label>
            <textarea id="fc-batch-input" rows="12"
              placeholder="每行一个坐标值，例：&#10;118°23'45.678&quot;&#10;118°24'12.1&quot;&#10;118°25'03.5&quot;"
              spellcheck="false"></textarea>
          </div>
          <div>
            <label class="field-label">转换结果（每行一个值，可直接复制）</label>
            <textarea id="fc-batch-output" rows="12" readonly
              placeholder="结果将显示在此处…"
              spellcheck="false"
              style="color:var(--topo-blue);cursor:default"></textarea>
          </div>
        </div>

        <div class="stat-bar" id="fc-batch-stats" style="display:none">
          <div class="stat-item">
            <span class="stat-key">总行数</span>
            <span class="stat-val" id="fc-stat-total">0</span>
          </div>
          <div class="stat-item">
            <span class="stat-key">成功</span>
            <span class="stat-val ok" id="fc-stat-ok">0</span>
          </div>
          <div class="stat-item">
            <span class="stat-key">失败</span>
            <span class="stat-val error" id="fc-stat-fail">0</span>
          </div>
        </div>

        <div class="btn-group" style="margin-top:12px">
          <button class="btn btn-primary" onclick="FormatConvert.convertBatch()">批量转换</button>
          <button class="btn btn-blue"    onclick="FormatConvert.copyBatch()">复制结果</button>
          <button class="btn btn-secondary" onclick="FormatConvert.clearBatch()">清空</button>
        </div>

      </div>
    `;

    // 初始化格式按钮
    renderFormatButtons('fc-in-fmt', INPUT_FORMATS, singleInputFmt, id => {
      singleInputFmt = id; updateSingleFmtUI();
    });
    renderFormatButtons('fc-batch-in-fmt', INPUT_FORMATS, batchInputFmt, id => {
      batchInputFmt = id; updateBatchInFmtUI();
    });
    renderFormatButtons('fc-batch-out-fmt', OUTPUT_FORMATS, batchOutputFmt, id => {
      batchOutputFmt = id;
    });

    updateSingleFmtUI();
    updateBatchInFmtUI();

    document.getElementById('fc-single-input')
      .addEventListener('keydown', e => { if (e.key === 'Enter') convertSingle(); });
  }

  // ── 格式按钮渲染 ─────────────────────────────────────────────────

  function renderFormatButtons(containerId, formats, activeId, onChange) {
    const c = document.getElementById(containerId);
    if (!c) return;
    c.innerHTML = formats.map(f => `
      <button class="format-btn ${f.id === activeId ? 'active' : ''}"
        data-id="${f.id}"
        onclick="FormatConvert._fmtClick('${containerId}','${f.id}')"
      >${f.label}</button>
    `).join('');
    c._onChange = onChange;
  }

  function _fmtClick(containerId, id) {
    const c = document.getElementById(containerId);
    if (!c) return;
    c.querySelectorAll('.format-btn').forEach(b => b.classList.toggle('active', b.dataset.id === id));
    if (c._onChange) c._onChange(id);
  }

  function updateSingleFmtUI() {
    const fmt = INPUT_FORMATS.find(f => f.id === singleInputFmt);
    if (!fmt) return;
    const ex   = document.getElementById('fc-in-example');
    const hint = document.getElementById('fc-in-hint');
    if (ex)   ex.textContent   = fmt.example;
    if (hint) hint.textContent = fmt.hint;
  }

  function updateBatchInFmtUI() {
    const fmt = INPUT_FORMATS.find(f => f.id === batchInputFmt);
    const ex  = document.getElementById('fc-batch-in-example');
    if (ex && fmt) ex.textContent = fmt.example;
  }

  // ── 转换逻辑 ─────────────────────────────────────────────────────

  function convertSingle() {
    const raw = document.getElementById('fc-single-input').value.trim();
    if (!raw) { setStatus('请输入坐标值'); return; }

    const fmtDef = INPUT_FORMATS.find(f => f.id === singleInputFmt);
    if (!fmtDef) return;

    try {
      const dd = fmtDef.parse(raw);
      OUTPUT_FORMATS.forEach(f => {
        const el = document.getElementById(`fc-val-${f.id}`);
        if (el) el.textContent = f.format(dd);
      });
      setStatus(`转换成功：${dd.toFixed(8)}°`);
    } catch (e) {
      OUTPUT_FORMATS.forEach(f => {
        const el = document.getElementById(`fc-val-${f.id}`);
        if (el) el.textContent = '解析失败';
      });
      setStatus(`错误：${e.message}`, true);
    }
  }

  function clearSingle() {
    document.getElementById('fc-single-input').value = '';
    OUTPUT_FORMATS.forEach(f => {
      const el = document.getElementById(`fc-val-${f.id}`);
      if (el) el.textContent = '—';
    });
    setStatus('就绪');
  }

  function convertBatch() {
    const raw = document.getElementById('fc-batch-input').value;
    if (!raw.trim()) { setStatus('请粘贴要转换的数据'); return; }

    const inFmt  = INPUT_FORMATS.find(f => f.id === batchInputFmt);
    const outFmt = OUTPUT_FORMATS.find(f => f.id === batchOutputFmt);
    if (!inFmt || !outFmt) return;

    const lines = raw.split(/\r?\n/);
    const results = [];
    let ok = 0, fail = 0;

    lines.forEach(line => {
      if (!line.trim()) return; // 跳过空行

      // 单列输入：取第一列（若用户意外粘了多列，只取第一列并不报错）
      const cell = splitLine(line)[0];
      if (!cell) return;

      try {
        const dd  = inFmt.parse(cell);
        const out = outFmt.format(dd);
        results.push(out);
        ok++;
      } catch (e) {
        results.push(`[错误] ${cell} → ${e.message}`);
        fail++;
      }
    });

    document.getElementById('fc-batch-output').value = results.join('\n');

    const statsEl = document.getElementById('fc-batch-stats');
    statsEl.style.display = 'flex';
    document.getElementById('fc-stat-total').textContent = ok + fail;
    document.getElementById('fc-stat-ok').textContent    = ok;
    document.getElementById('fc-stat-fail').textContent  = fail;

    setStatus(`批量转换完成：${ok} 成功，${fail} 失败`);
  }

  function copyBatch() {
    const output = document.getElementById('fc-batch-output').value;
    if (!output) { setStatus('没有可复制的结果'); return; }
    navigator.clipboard.writeText(output).then(() => {
      setStatus('已复制到剪贴板');
    });
  }

  function clearBatch() {
    document.getElementById('fc-batch-input').value  = '';
    document.getElementById('fc-batch-output').value = '';
    document.getElementById('fc-batch-stats').style.display = 'none';
    setStatus('就绪');
  }

  function copyVal(id, btn) {
    const el = document.getElementById(id);
    if (!el || el.textContent === '—' || el.textContent === '解析失败') return;
    navigator.clipboard.writeText(el.textContent).then(() => {
      const orig = btn.textContent;
      btn.textContent = '✓';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 1200);
    });
  }

  function setStatus(msg, isError = false) {
    const el = document.getElementById('status-msg');
    if (!el) return;
    el.textContent  = msg;
    el.style.color  = isError ? 'var(--topo-red)' : 'rgba(255,255,255,0.35)';
  }

  // ── 公开 API ─────────────────────────────────────────────────────
  return {
    render,
    _fmtClick,
    convertSingle, clearSingle,
    convertBatch,  copyBatch, clearBatch,
    copyVal,
    // 供模块B/C复用
    splitLine,
    parsers:    Object.fromEntries(INPUT_FORMATS.map(f  => [f.id,  f.parse])),
    formatters: Object.fromEntries(OUTPUT_FORMATS.map(f => [f.id,  f.format])),
    INPUT_FORMATS,
    OUTPUT_FORMATS,
  };
})();
