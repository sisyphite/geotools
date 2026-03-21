/**
 * format-convert.js — 模块A：格式转换
 *
 * 功能：
 *  1. 单值转换：度分秒 ↔ 十进制度，用户手动指定输入格式
 *  2. 批量转换：兼容 Excel 复制粘贴（制表符分隔），用户指定列映射
 *  3. 输出也是制表符分隔，可直接粘回 Excel
 */

const FormatConvert = (() => {

  // ── 支持的输入格式定义 ──────────────────────────────────────────
  const INPUT_FORMATS = [
    {
      id: 'dms_symbol',
      label: 'DD°MM\'SS.sss"',
      example: '118°23\'45.678"',
      hint: '带符号，如 118°23\'45.678" 或 -118°23\'45.678"',
      parse: parseDmsSymbol,
    },
    {
      id: 'dms_space',
      label: 'DD MM SS.sss',
      example: '118 23 45.678',
      hint: '空格分隔，如 118 23 45.678 或 -118 23 45.678',
      parse: parseDmsSpace,
    },
    {
      id: 'dms_dash',
      label: 'DD-MM-SS.sss',
      example: '118-23-45.678',
      hint: '连字符分隔，如 118-23-45.678',
      parse: parseDmsDash,
    },
    {
      id: 'dms_concat',
      label: 'DDMMSS.sss',
      example: '1182345.678',
      hint: '度分秒直接拼接，度占整数部分（2或3位）',
      parse: parseDmsConcat,
    },
    {
      id: 'decimal',
      label: 'DD.dddddd',
      example: '118.396022',
      hint: '十进制度，直接输入',
      parse: parseDecimal,
    },
  ];

  const OUTPUT_FORMATS = [
    { id: 'dms_symbol', label: 'DD°MM\'SS.sss"', format: toDmsSymbol },
    { id: 'dms_space',  label: 'DD MM SS.sss',   format: toDmsSpace },
    { id: 'decimal_6',  label: 'DD.dddddd（6位）',format: d => d.toFixed(6) },
    { id: 'decimal_8',  label: 'DD.dddddddd（8位）', format: d => d.toFixed(8) },
    { id: 'dms_dm',     label: 'DD°MM.mmmm\'',   format: toDm },
    { id: 'rad',        label: '弧度 rad',        format: d => (d * Math.PI / 180).toFixed(10) },
  ];

  // ── 解析函数 ─────────────────────────────────────────────────────

  function parseDmsSymbol(str) {
    str = str.trim();
    const neg = str.startsWith('-') || str.includes('S') || str.includes('W');
    // 支持各种符号组合：° ' " ′ ″
    const m = str.match(/(\d+)[°º]\s*(\d+)[′']\s*([\d.]+)[″"''"]?\s*([NSEW])?/i);
    if (!m) throw new Error(`无法解析: "${str}"`);
    const d = +m[1] + +m[2] / 60 + +m[3] / 3600;
    return (neg || ['S','W'].includes((m[4]||'').toUpperCase())) ? -d : d;
  }

  function parseDmsSpace(str) {
    str = str.trim();
    const neg = str.startsWith('-');
    const parts = str.replace(/^-/, '').trim().split(/\s+/);
    if (parts.length !== 3) throw new Error(`需要三个空格分隔的数字: "${str}"`);
    const d = +parts[0] + +parts[1] / 60 + +parts[2] / 3600;
    return neg ? -d : d;
  }

  function parseDmsDash(str) {
    str = str.trim();
    const neg = str.startsWith('-');
    const parts = str.replace(/^-/, '').split('-');
    if (parts.length !== 3) throw new Error(`需要连字符分隔的三段: "${str}"`);
    const d = +parts[0] + +parts[1] / 60 + +parts[2] / 3600;
    return neg ? -d : d;
  }

  function parseDmsConcat(str) {
    str = str.trim();
    const neg = str.startsWith('-');
    const s = str.replace(/^-/, '');
    // 整数部分判断是2位还是3位度数
    const dotIdx = s.indexOf('.');
    const intPart = dotIdx >= 0 ? s.slice(0, dotIdx) : s;
    const decPart = dotIdx >= 0 ? s.slice(dotIdx) : '.0';

    let degLen;
    if (intPart.length >= 7) degLen = 3;      // 如 1182345 → 118°
    else if (intPart.length >= 6) degLen = 2; // 如 392345 → 39°
    else throw new Error(`无法判断度数位数: "${str}"`);

    const deg = parseInt(intPart.slice(0, degLen), 10);
    const min = parseInt(intPart.slice(degLen, degLen + 2), 10);
    const sec = parseFloat(intPart.slice(degLen + 2) + decPart);
    const d = deg + min / 60 + sec / 3600;
    return neg ? -d : d;
  }

  function parseDecimal(str) {
    str = str.trim();
    const v = parseFloat(str);
    if (isNaN(v)) throw new Error(`不是有效数字: "${str}"`);
    return v;
  }

  // ── 格式化函数 ───────────────────────────────────────────────────

  function toDmsSymbol(dd) {
    const neg = dd < 0;
    const abs = Math.abs(dd);
    const deg = Math.floor(abs);
    const minF = (abs - deg) * 60;
    const min = Math.floor(minF);
    const sec = (minF - min) * 60;
    return `${neg ? '-' : ''}${deg}°${String(min).padStart(2,'0')}'${sec.toFixed(4).padStart(7,'0')}"`;
  }

  function toDmsSpace(dd) {
    const neg = dd < 0;
    const abs = Math.abs(dd);
    const deg = Math.floor(abs);
    const minF = (abs - deg) * 60;
    const min = Math.floor(minF);
    const sec = (minF - min) * 60;
    return `${neg ? '-' : ''}${deg} ${String(min).padStart(2,'0')} ${sec.toFixed(4).padStart(7,'0')}`;
  }

  function toDm(dd) {
    const neg = dd < 0;
    const abs = Math.abs(dd);
    const deg = Math.floor(abs);
    const min = (abs - deg) * 60;
    return `${neg ? '-' : ''}${deg}°${min.toFixed(6).padStart(9,'0')}'`;
  }

  // ── UI 渲染 ──────────────────────────────────────────────────────

  let singleInputFmt = 'dms_symbol';
  let singleOutputFmt = 'decimal_6';
  let batchInputFmt = 'dms_symbol';
  let batchOutputFmt = 'decimal_6';

  function render(container) {
    container.innerHTML = `
      <div class="module-header">
        <h1 class="module-title">格式转换</h1>
        <span class="module-badge">模块 A</span>
      </div>

      <!-- ── 单值转换 ── -->
      <div class="section-title">单值转换</div>
      <div class="panel">
        <div class="layout-2col">

          <!-- 左：输入 -->
          <div>
            <label class="field-label">输入格式</label>
            <div class="format-selector" id="fc-in-fmt"></div>
            <div class="format-example" id="fc-in-example"></div>

            <div style="height:12px"></div>
            <label class="field-label">输入值</label>
            <input type="text" id="fc-single-input" placeholder="在此输入坐标值…" autocomplete="off" spellcheck="false">
            <p class="hint" id="fc-in-hint"></p>

            <div style="height:12px"></div>
            <div class="btn-group">
              <button class="btn btn-primary" onclick="FormatConvert.convertSingle()">转换</button>
              <button class="btn btn-secondary" onclick="FormatConvert.clearSingle()">清空</button>
            </div>
          </div>

          <!-- 右：输出 -->
          <div>
            <label class="field-label">输出格式</label>
            <div class="format-selector" id="fc-out-fmt"></div>

            <div style="height:12px"></div>
            <label class="field-label">结果</label>
            <div class="panel" style="padding:0;background:transparent;box-shadow:none;border:none;">
              ${OUTPUT_FORMATS.map(f => `
                <div class="data-row" id="fc-result-${f.id}">
                  <span class="data-key">${f.label}</span>
                  <span class="data-val num" id="fc-val-${f.id}">—</span>
                  <button class="data-copy" onclick="FormatConvert.copyVal('fc-val-${f.id}', this)">Copy</button>
                </div>
              `).join('')}
            </div>
          </div>

        </div>
      </div>

      <!-- ── 批量转换 ── -->
      <div class="section-title">批量转换（Excel 兼容）</div>
      <div class="alert alert-info">
        ⌨ 直接从 Excel 复制多行粘贴，每行制表符分隔；输出结果同样是制表符分隔，可直接粘回 Excel。
      </div>
      <div class="panel">

        <!-- 格式选择行 -->
        <div class="layout-2col" style="margin-bottom:14px">
          <div>
            <label class="field-label">输入格式</label>
            <div class="format-selector" id="fc-batch-in-fmt"></div>
            <div class="format-example" id="fc-batch-in-example"></div>
          </div>
          <div>
            <label class="field-label">输出格式</label>
            <div class="format-selector" id="fc-batch-out-fmt"></div>
          </div>
        </div>

        <!-- 列映射 -->
        <div class="section-title" style="margin-top:4px">列映射配置</div>
        <div class="alert alert-warn" id="fc-col-hint" style="display:none"></div>

        <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:14px">
          <div style="flex:1;min-width:200px">
            <div class="col-map-row">
              <span class="field-label">目标列（第几列）</span>
              <select id="fc-col-target" style="width:90px" onchange="FormatConvert.updateColHint()">
                ${[1,2,3,4,5,6,7,8].map(i=>`<option value="${i-1}">${i}</option>`).join('')}
              </select>
              <span class="hint" style="margin-top:0">列号从 1 开始</span>
            </div>
            <div class="col-map-row">
              <span class="field-label">其余列处理</span>
              <select id="fc-col-pass" style="width:150px">
                <option value="keep">保留（原样输出）</option>
                <option value="drop">丢弃（只输出转换列）</option>
                <option value="append">追加（在原始数据末尾新增一列）</option>
              </select>
            </div>
          </div>
          <div style="flex:1;min-width:200px">
            <div class="col-map-row">
              <span class="field-label">输出精度</span>
              <select id="fc-precision" style="width:120px">
                <option value="4">4 位小数</option>
                <option value="6" selected>6 位小数</option>
                <option value="8">8 位小数</option>
                <option value="10">10 位小数</option>
              </select>
            </div>
            <div class="col-map-row">
              <span class="field-label">跳过首行</span>
              <select id="fc-skip-header" style="width:120px">
                <option value="0">不跳过</option>
                <option value="1">跳过第 1 行（标题行）</option>
              </select>
            </div>
          </div>
        </div>

        <!-- 输入输出区 -->
        <div class="layout-2col">
          <div>
            <label class="field-label">粘贴输入（从 Excel 复制）</label>
            <textarea id="fc-batch-input" rows="10" placeholder="直接从 Excel 粘贴…\n例：\nA001\t118°23'45.6&quot;\t39°12'33.4&quot;\nA002\t118°24'12.1&quot;\t39°13'05.7&quot;" spellcheck="false"></textarea>
          </div>
          <div>
            <label class="field-label">转换结果（可直接复制回 Excel）</label>
            <textarea id="fc-batch-output" rows="10" readonly placeholder="结果将显示在此处…" spellcheck="false" style="color:var(--topo-blue);cursor:default"></textarea>
          </div>
        </div>

        <!-- 统计 & 按钮 -->
        <div class="stat-bar" id="fc-batch-stats" style="display:none">
          <div class="stat-item"><span class="stat-key">总行数</span><span class="stat-val" id="fc-stat-total">0</span></div>
          <div class="stat-item"><span class="stat-key">成功</span><span class="stat-val ok" id="fc-stat-ok">0</span></div>
          <div class="stat-item"><span class="stat-key">失败</span><span class="stat-val error" id="fc-stat-fail">0</span></div>
        </div>

        <div class="btn-group" style="margin-top:12px">
          <button class="btn btn-primary" onclick="FormatConvert.convertBatch()">批量转换</button>
          <button class="btn btn-blue" onclick="FormatConvert.copyBatch()">复制结果</button>
          <button class="btn btn-secondary" onclick="FormatConvert.clearBatch()">清空</button>
        </div>

      </div>
    `;

    // 渲染格式按钮
    renderFormatButtons('fc-in-fmt', INPUT_FORMATS, singleInputFmt, (id) => {
      singleInputFmt = id;
      updateFmtUI();
    });
    renderFormatButtons('fc-out-fmt', OUTPUT_FORMATS, singleOutputFmt, (id) => {
      singleOutputFmt = id;
    });
    renderFormatButtons('fc-batch-in-fmt', INPUT_FORMATS, batchInputFmt, (id) => {
      batchInputFmt = id;
      updateBatchFmtUI();
    });
    renderFormatButtons('fc-batch-out-fmt', OUTPUT_FORMATS, batchOutputFmt, (id) => {
      batchOutputFmt = id;
    });

    updateFmtUI();
    updateBatchFmtUI();

    // 回车触发单值转换
    document.getElementById('fc-single-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') convertSingle();
    });
  }

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
    c.querySelectorAll('.format-btn').forEach(b => b.classList.toggle('active', b.dataset.id === id));
    if (c._onChange) c._onChange(id);
  }

  function updateFmtUI() {
    const fmt = INPUT_FORMATS.find(f => f.id === singleInputFmt);
    if (!fmt) return;
    const ex = document.getElementById('fc-in-example');
    const hint = document.getElementById('fc-in-hint');
    if (ex) ex.textContent = fmt.example;
    if (hint) hint.textContent = fmt.hint;
  }

  function updateBatchFmtUI() {
    const fmt = INPUT_FORMATS.find(f => f.id === batchInputFmt);
    const ex = document.getElementById('fc-batch-in-example');
    if (ex && fmt) ex.textContent = fmt.example;
  }

  function updateColHint() {
    // 可以在这里根据选择的列数给出提示
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

    const skipHeader = parseInt(document.getElementById('fc-skip-header').value, 10);
    const targetCol  = parseInt(document.getElementById('fc-col-target').value, 10);
    const passMode   = document.getElementById('fc-col-pass').value;
    const precision  = parseInt(document.getElementById('fc-precision').value, 10);

    const inFmt  = INPUT_FORMATS.find(f => f.id === batchInputFmt);
    const outFmt = OUTPUT_FORMATS.find(f => f.id === batchOutputFmt);
    if (!inFmt || !outFmt) return;

    const lines = raw.split(/\r?\n/);
    const resultLines = [];
    let ok = 0, fail = 0;

    lines.forEach((line, lineIdx) => {
      if (!line.trim()) return; // 跳过空行

      // 跳过标题行
      if (lineIdx < skipHeader) {
        resultLines.push(line);
        return;
      }

      const cols = line.split('\t');

      // 检查列是否存在
      if (targetCol >= cols.length) {
        fail++;
        resultLines.push(line + '\t[错误：列不存在]');
        return;
      }

      const cell = cols[targetCol].trim();
      try {
        const dd = inFmt.parse(cell);
        // 根据输出格式特殊处理精度
        let converted;
        if (outFmt.id === 'decimal_6' || outFmt.id === 'decimal_8') {
          converted = dd.toFixed(precision);
        } else {
          converted = outFmt.format(dd);
        }

        let outCols;
        if (passMode === 'keep') {
          outCols = [...cols];
          outCols[targetCol] = converted;
        } else if (passMode === 'drop') {
          outCols = [converted];
        } else { // append
          outCols = [...cols, converted];
        }
        resultLines.push(outCols.join('\t'));
        ok++;
      } catch (e) {
        fail++;
        if (passMode === 'keep') {
          const outCols = [...cols];
          outCols[targetCol] = `[错误:${e.message}]`;
          resultLines.push(outCols.join('\t'));
        } else if (passMode === 'drop') {
          resultLines.push(`[错误:${e.message}]`);
        } else {
          resultLines.push(line + '\t[错误]');
        }
      }
    });

    document.getElementById('fc-batch-output').value = resultLines.join('\n');

    const statsEl = document.getElementById('fc-batch-stats');
    statsEl.style.display = 'flex';
    document.getElementById('fc-stat-total').textContent = ok + fail;
    document.getElementById('fc-stat-ok').textContent = ok;
    document.getElementById('fc-stat-fail').textContent = fail;

    setStatus(`批量转换完成：${ok} 成功，${fail} 失败`);
  }

  function copyBatch() {
    const output = document.getElementById('fc-batch-output').value;
    if (!output) { setStatus('没有可复制的结果'); return; }
    navigator.clipboard.writeText(output).then(() => {
      setStatus('已复制到剪贴板，可直接粘贴到 Excel');
    });
  }

  function clearBatch() {
    document.getElementById('fc-batch-input').value = '';
    document.getElementById('fc-batch-output').value = '';
    document.getElementById('fc-batch-stats').style.display = 'none';
    setStatus('就绪');
  }

  function copyVal(id, btn) {
    const el = document.getElementById(id);
    if (!el || el.textContent === '—') return;
    navigator.clipboard.writeText(el.textContent).then(() => {
      btn.textContent = '✓';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1200);
    });
  }

  // ── 辅助 ─────────────────────────────────────────────────────────

  function setStatus(msg, isError = false) {
    const el = document.getElementById('status-msg');
    if (el) {
      el.textContent = msg;
      el.style.color = isError ? 'var(--topo-red)' : 'rgba(255,255,255,0.35)';
    }
  }

  return {
    render,
    _fmtClick,
    updateColHint,
    convertSingle,
    clearSingle,
    convertBatch,
    copyBatch,
    clearBatch,
    copyVal,
    // 供其他模块调用的底层解析/格式化
    parsers: Object.fromEntries(INPUT_FORMATS.map(f => [f.id, f.parse])),
    formatters: Object.fromEntries(OUTPUT_FORMATS.map(f => [f.id, f.format])),
    INPUT_FORMATS,
    OUTPUT_FORMATS,
  };
})();
