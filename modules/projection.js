/**
 * projection.js — 模块B：坐标系转换
 * 依赖：proj4js（window.proj4），FormatConvert.splitLine()
 *
 * 覆盖范围：
 *   椭球：CGCS2000/GRS80、WGS84、北京54/Krassovsky、西安80/IAG75
 *   投影：地理坐标（经纬度）、高斯-克吕格（TM）、UTM
 *
 * 批量输入为多列，用户指定点号列、X列、Y列及其余列处理方式。
 * 分隔符识别复用 FormatConvert.splitLine()。
 */

const Projection = (() => {

  // ── 椭球体定义 ────────────────────────────────────────────────────
  const ELLIPSOIDS = [
    { id: 'GRS80',  label: 'CGCS2000 / GRS80（现行国标）', proj4: 'ellps=GRS80'  },
    { id: 'WGS84',  label: 'WGS84',                        proj4: 'ellps=WGS84'  },
    { id: 'krass',  label: '北京54 / Krassovsky',          proj4: 'ellps=krass'  },
    { id: 'IAU76',  label: '西安80 / IAG75',               proj4: 'ellps=IAU76'  },
  ];

  // ── 投影定义 ──────────────────────────────────────────────────────
  const PROJECTIONS = [
    { id: 'longlat', label: '地理坐标（经纬度，不投影）' },
    { id: 'gauss',   label: '高斯-克吕格 / 横轴墨卡托（TM）' },
    { id: 'utm',     label: 'UTM（通用横轴墨卡托）' },
  ];

  // ── 预设坐标系 ────────────────────────────────────────────────────
  // 格式：{ id, label, proj4str }
  const PRESETS = [
    {
      id: 'cgcs2000_geo',
      label: 'CGCS2000 地理坐标（°）',
      proj4str: '+proj=longlat +ellps=GRS80 +no_defs',
      unit: 'deg',
    },
    {
      id: 'wgs84_geo',
      label: 'WGS84 地理坐标（°）',
      proj4str: '+proj=longlat +ellps=WGS84 +datum=WGS84 +no_defs',
      unit: 'deg',
    },
    {
      id: 'bj54_geo',
      label: '北京54 地理坐标（°）',
      proj4str: '+proj=longlat +ellps=krass +no_defs',
      unit: 'deg',
    },
    {
      id: 'xian80_geo',
      label: '西安80 地理坐标（°）',
      proj4str: '+proj=longlat +ellps=IAU76 +no_defs',
      unit: 'deg',
    },
    { id: '__sep1', label: '── 高斯-克吕格 / CGCS2000 ──', proj4str: null },
    {
      id: 'cgcs2000_3_117',
      label: 'CGCS2000 3°带 第39带（中央子午线 117°）',
      proj4str: '+proj=tmerc +lat_0=0 +lon_0=117 +k=1 +x_0=39500000 +y_0=0 +ellps=GRS80 +units=m +no_defs',
      unit: 'm',
    },
    {
      id: 'cgcs2000_3_120',
      label: 'CGCS2000 3°带 第40带（中央子午线 120°）',
      proj4str: '+proj=tmerc +lat_0=0 +lon_0=120 +k=1 +x_0=40500000 +y_0=0 +ellps=GRS80 +units=m +no_defs',
      unit: 'm',
    },
    {
      id: 'cgcs2000_6_19',
      label: 'CGCS2000 6°带 第19带（中央子午线 111°）',
      proj4str: '+proj=tmerc +lat_0=0 +lon_0=111 +k=1 +x_0=19500000 +y_0=0 +ellps=GRS80 +units=m +no_defs',
      unit: 'm',
    },
    {
      id: 'cgcs2000_6_20',
      label: 'CGCS2000 6°带 第20带（中央子午线 117°）',
      proj4str: '+proj=tmerc +lat_0=0 +lon_0=117 +k=1 +x_0=20500000 +y_0=0 +ellps=GRS80 +units=m +no_defs',
      unit: 'm',
    },
    { id: '__sep2', label: '── UTM / WGS84 ──', proj4str: null },
    {
      id: 'wgs84_utm49n',
      label: 'WGS84 UTM 49N（东经 108°–114°）',
      proj4str: '+proj=utm +zone=49 +ellps=WGS84 +datum=WGS84 +units=m +no_defs',
      unit: 'm',
    },
    {
      id: 'wgs84_utm50n',
      label: 'WGS84 UTM 50N（东经 114°–120°）',
      proj4str: '+proj=utm +zone=50 +ellps=WGS84 +datum=WGS84 +units=m +no_defs',
      unit: 'm',
    },
    { id: '__custom', label: '── 自定义（见下方构建器）──', proj4str: null },
  ];

  // ── 状态 ─────────────────────────────────────────────────────────
  let srcProj4  = PRESETS[0].proj4str;  // 源坐标系 PROJ 字符串
  let dstProj4  = PRESETS[1].proj4str;  // 目标坐标系 PROJ 字符串
  let srcCustom = false;  // 源是否使用自定义构建器
  let dstCustom = false;

  // ── PROJ 字符串构建 ───────────────────────────────────────────────

  /**
   * 从自定义构建器参数生成 PROJ 字符串
   * side: 'src' | 'dst'
   */
  function buildProjStr(side) {
    const get = id => {
      const el = document.getElementById(`pb-${side}-${id}`);
      return el ? el.value : '';
    };

    const ellps = get('ellps');
    const proj  = get('proj');

    if (proj === 'longlat') {
      return `+proj=longlat +${ellps} +no_defs`;
    }

    if (proj === 'gauss') {
      const cmMode = get('cm-mode');
      let cm;
      if (cmMode === 'direct') {
        cm = parseFloat(get('cm'));
        if (isNaN(cm)) throw new Error('请输入有效的中央子午线经度');
      } else {
        const band     = parseInt(get('band-no'), 10);
        const bandType = get('band-type');
        if (isNaN(band)) throw new Error('请输入有效的带号');
        cm = bandType === '3' ? band * 3 : band * 6 - 3;
      }
      if (cm < -180 || cm > 180) throw new Error(`中央子午线 ${cm}° 超出范围`);

      const withBand  = get('with-band') === '1';
      const bandNo    = cmMode === 'direct'
        ? (get('band-type') === '3' ? Math.round(cm / 3) : Math.round((cm + 3) / 6))
        : parseInt(get('band-no'), 10);
      const x0 = withBand ? bandNo * 1000000 + 500000 : 500000;

      return `+proj=tmerc +lat_0=0 +lon_0=${cm} +k=1 +x_0=${x0} +y_0=0 +${ellps} +units=m +no_defs`;
    }

    if (proj === 'utm') {
      const zone  = parseInt(get('utm-zone'), 10);
      const south = get('utm-hemi') === 'S';
      if (isNaN(zone) || zone < 1 || zone > 60) throw new Error('UTM 带号范围为 1–60');
      return `+proj=utm +zone=${zone}${south ? ' +south' : ''} +${ellps} +units=m +no_defs`;
    }

    throw new Error(`未知投影类型：${proj}`);
  }

  /** 刷新某侧 PROJ 字符串预览，并更新状态变量 */
  function refreshProjStr(side) {
    const previewEl = document.getElementById(`pb-${side}-preview`);
    try {
      const str = buildProjStr(side);
      if (previewEl) {
        previewEl.textContent = str;
        previewEl.classList.remove('error');
      }
      if (side === 'src') srcProj4 = str;
      else               dstProj4 = str;
    } catch (e) {
      if (previewEl) {
        previewEl.textContent = `⚠ ${e.message}`;
        previewEl.classList.add('error');
      }
      if (side === 'src') srcProj4 = null;
      else               dstProj4 = null;
    }
  }

  // ── 执行转换 ──────────────────────────────────────────────────────

  function doConvert(x, y, fromStr, toStr) {
    if (typeof proj4 === 'undefined') throw new Error('proj4 库未加载，请检查网络连接');
    if (!fromStr) throw new Error('源坐标系参数无效');
    if (!toStr)   throw new Error('目标坐标系参数无效');
    const result = proj4(fromStr, toStr, [x, y]);
    return { x: result[0], y: result[1] };
  }

  /** 格式化坐标输出，地理坐标显示更多小数 */
  function fmtCoord(v, projStr) {
    const isDeg = projStr && projStr.includes('longlat');
    return isDeg ? v.toFixed(8) : v.toFixed(4);
  }

  // ── UI 渲染 ──────────────────────────────────────────────────────

  function render(container) {
    container.innerHTML = `
      <div class="module-header">
        <h1 class="module-title">坐标系转换</h1>
        <span class="module-badge">模块 B</span>
      </div>

      <!-- ══ 坐标系选择 ══ -->
      <div class="section-title">坐标系配置</div>
      <div class="panel-row">

        <!-- 源坐标系 -->
        <div class="panel-half">
          <label class="field-label">源坐标系</label>
          <select id="pb-src-preset" onchange="Projection._onPresetChange('src')">
            ${renderPresetOptions()}
          </select>
          <div id="pb-src-builder" style="display:none;margin-top:14px">
            ${renderBuilder('src')}
          </div>
          <div class="format-example" id="pb-src-preview" style="margin-top:10px;word-break:break-all">
            ${PRESETS[0].proj4str}
          </div>
        </div>

        <!-- 目标坐标系 -->
        <div class="panel-half">
          <label class="field-label">目标坐标系</label>
          <select id="pb-dst-preset" onchange="Projection._onPresetChange('dst')">
            ${renderPresetOptions(1)}
          </select>
          <div id="pb-dst-builder" style="display:none;margin-top:14px">
            ${renderBuilder('dst')}
          </div>
          <div class="format-example" id="pb-dst-preview" style="margin-top:10px;word-break:break-all">
            ${PRESETS[1].proj4str}
          </div>
        </div>

      </div>

      <!-- ══ 单点转换 ══ -->
      <div class="section-title">单点转换</div>
      <div class="panel">
        <div class="layout-2col">

          <!-- 输入 -->
          <div>
            <label class="field-label">X 坐标（或经度，十进制度）</label>
            <input type="text" id="pb-single-x" placeholder="如 121.473701 或 39500432.123" spellcheck="false" autocomplete="off">
            <div style="height:10px"></div>
            <label class="field-label">Y 坐标（或纬度，十进制度）</label>
            <input type="text" id="pb-single-y" placeholder="如 31.230416 或 3456789.456" spellcheck="false" autocomplete="off">
            <div style="height:12px"></div>
            <div class="btn-group">
              <button class="btn btn-primary" onclick="Projection.convertSingle()">转换</button>
              <button class="btn btn-secondary" onclick="Projection.clearSingle()">清空</button>
            </div>
          </div>

          <!-- 输出 -->
          <div>
            <label class="field-label">转换结果</label>
            <div class="data-row">
              <span class="data-key">X / 经度</span>
              <span class="data-val num" id="pb-res-x">—</span>
              <button class="data-copy" onclick="Projection.copyVal('pb-res-x',this)">Copy</button>
            </div>
            <div class="data-row">
              <span class="data-key">Y / 纬度</span>
              <span class="data-val num" id="pb-res-y">—</span>
              <button class="data-copy" onclick="Projection.copyVal('pb-res-y',this)">Copy</button>
            </div>
            <div id="pb-single-error" class="alert alert-error" style="display:none;margin-top:10px"></div>
          </div>

        </div>
      </div>

      <!-- ══ 批量转换 ══ -->
      <div class="section-title">批量转换</div>
      <div class="alert alert-info">
        多列数据，分隔符自动识别（制表符 / 逗号 / 多空格）。每行至少包含 X 和 Y 两列。
      </div>
      <div class="panel">

        <!-- 列映射 -->
        <div class="section-title" style="font-size:9px">列映射配置</div>
        <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:16px;align-items:flex-end">
          <div>
            <label class="field-label">X 列（第几列）</label>
            <select id="pb-col-x" style="width:90px">
              ${colOptions(1)}
            </select>
          </div>
          <div>
            <label class="field-label">Y 列（第几列）</label>
            <select id="pb-col-y" style="width:90px">
              ${colOptions(2)}
            </select>
          </div>
          <div>
            <label class="field-label">点号列（可选）</label>
            <select id="pb-col-id" style="width:110px">
              <option value="-1">无</option>
              ${colOptions(0, true)}
            </select>
          </div>
          <div>
            <label class="field-label">其余列</label>
            <select id="pb-col-pass" style="width:160px">
              <option value="keep">保留（原样）</option>
              <option value="drop">丢弃</option>
              <option value="append">追加（在末尾新增转换结果）</option>
            </select>
          </div>
          <div>
            <label class="field-label">跳过首行</label>
            <select id="pb-skip-header" style="width:140px">
              <option value="0">不跳过</option>
              <option value="1">跳过第 1 行（标题）</option>
            </select>
          </div>
        </div>

        <!-- 输入输出 -->
        <div class="layout-2col">
          <div>
            <label class="field-label">输入</label>
            <textarea id="pb-batch-input" rows="12"
              placeholder="粘贴多列坐标数据…&#10;例：&#10;A001	121.4737	31.2304&#10;A002	121.4821	31.2415"
              spellcheck="false"></textarea>
          </div>
          <div>
            <label class="field-label">转换结果</label>
            <textarea id="pb-batch-output" rows="12" readonly
              placeholder="结果将显示在此处…"
              spellcheck="false"
              style="color:var(--topo-blue);cursor:default"></textarea>
          </div>
        </div>

        <!-- 统计 & 按钮 -->
        <div class="stat-bar" id="pb-batch-stats" style="display:none">
          <div class="stat-item">
            <span class="stat-key">总行数</span>
            <span class="stat-val" id="pb-stat-total">0</span>
          </div>
          <div class="stat-item">
            <span class="stat-key">成功</span>
            <span class="stat-val ok" id="pb-stat-ok">0</span>
          </div>
          <div class="stat-item">
            <span class="stat-key">失败</span>
            <span class="stat-val error" id="pb-stat-fail">0</span>
          </div>
        </div>

        <div class="btn-group" style="margin-top:12px">
          <button class="btn btn-primary"   onclick="Projection.convertBatch()">批量转换</button>
          <button class="btn btn-blue"      onclick="Projection.copyBatch()">复制结果</button>
          <button class="btn btn-secondary" onclick="Projection.clearBatch()">清空</button>
        </div>

      </div>
    `;

    // 初始化源/目标预览
    _onPresetChange('src');
    _onPresetChange('dst');
  }

  // ── 预设下拉 HTML ─────────────────────────────────────────────────

  function renderPresetOptions(defaultIdx = 0) {
    return PRESETS.map((p, i) => {
      if (p.proj4str === null) {
        return `<option disabled>${p.label}</option>`;
      }
      return `<option value="${p.id}" ${i === defaultIdx ? 'selected' : ''}>${p.label}</option>`;
    }).join('');
  }

  function colOptions(defaultVal = 1, zeroStart = false) {
    return [1,2,3,4,5,6,7,8].map(i =>
      `<option value="${i-1}" ${i-1 === defaultVal ? 'selected' : ''}>${i}</option>`
    ).join('');
  }

  // ── 自定义构建器 HTML ─────────────────────────────────────────────

  function renderBuilder(side) {
    const s = side;
    return `
      <div class="section-title" style="font-size:9px">自定义坐标系构建器</div>

      <label class="field-label">椭球体</label>
      <select id="pb-${s}-ellps" onchange="Projection._refreshBuilder('${s}')">
        ${ELLIPSOIDS.map(e => `<option value="${e.proj4}">${e.label}</option>`).join('')}
      </select>

      <div style="height:10px"></div>
      <label class="field-label">投影类型</label>
      <select id="pb-${s}-proj" onchange="Projection._onProjChange('${s}')">
        ${PROJECTIONS.map(p => `<option value="${p.id}">${p.label}</option>`).join('')}
      </select>

      <!-- 高斯参数区 -->
      <div id="pb-${s}-gauss-params" style="margin-top:12px">
        <label class="field-label">中央子午线来源</label>
        <div style="display:flex;gap:6px;margin-bottom:10px">
          <button class="format-btn active" id="pb-${s}-cm-btn-direct"
            onclick="Projection._setCmMode('${s}','direct')">直接输入经度</button>
          <button class="format-btn" id="pb-${s}-cm-btn-band"
            onclick="Projection._setCmMode('${s}','band')">按带号推算</button>
        </div>

        <!-- 直接输入 -->
        <div id="pb-${s}-cm-direct-area">
          <label class="field-label">中央子午线（°）</label>
          <input type="number" id="pb-${s}-cm" placeholder="如 117" min="-180" max="180" step="0.5"
            oninput="Projection._refreshBuilder('${s}')">
        </div>

        <!-- 按带号 -->
        <div id="pb-${s}-cm-band-area" style="display:none">
          <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap">
            <div>
              <label class="field-label">分带方式</label>
              <select id="pb-${s}-band-type" onchange="Projection._refreshBuilder('${s}')">
                <option value="3">3° 带</option>
                <option value="6">6° 带</option>
              </select>
            </div>
            <div>
              <label class="field-label">带号</label>
              <input type="number" id="pb-${s}-band-no" placeholder="如 40" min="1" max="60" step="1"
                style="width:90px" oninput="Projection._refreshBuilder('${s}')">
            </div>
            <div id="pb-${s}-cm-derived" class="hint" style="margin-top:0;padding-bottom:2px"></div>
          </div>
        </div>

        <div style="height:10px"></div>
        <label class="field-label">东偏移（X₀）</label>
        <select id="pb-${s}-with-band" onchange="Projection._refreshBuilder('${s}')">
          <option value="0">500000 m（不含带号前缀）</option>
          <option value="1">带号 × 1000000 + 500000（含带号前缀）</option>
        </select>
        <p class="hint">国家坐标成果通常含带号前缀，如 X = 39500000 则带号为 39</p>
        <!-- 隐藏字段存储 cm-mode -->
        <input type="hidden" id="pb-${s}-cm-mode" value="direct">
      </div>

      <!-- UTM 参数区 -->
      <div id="pb-${s}-utm-params" style="margin-top:12px;display:none">
        <div style="display:flex;gap:12px;flex-wrap:wrap">
          <div>
            <label class="field-label">UTM 带号（1–60）</label>
            <input type="number" id="pb-${s}-utm-zone" placeholder="如 50" min="1" max="60" step="1"
              style="width:100px" oninput="Projection._refreshBuilder('${s}')">
          </div>
          <div>
            <label class="field-label">半球</label>
            <select id="pb-${s}-utm-hemi" onchange="Projection._refreshBuilder('${s}')">
              <option value="N">北半球（N）</option>
              <option value="S">南半球（S）</option>
            </select>
          </div>
        </div>
        <p class="hint">UTM 带号与经度关系：带号 = ⌊(经度 + 180) / 6⌋ + 1</p>
      </div>
    `;
  }

  // ── 交互处理 ─────────────────────────────────────────────────────

  /** 预设下拉切换 */
  function _onPresetChange(side) {
    const sel     = document.getElementById(`pb-${side}-preset`);
    const builder = document.getElementById(`pb-${side}-builder`);
    const preview = document.getElementById(`pb-${side}-preview`);
    if (!sel) return;

    const chosen = PRESETS.find(p => p.id === sel.value);
    if (!chosen || !chosen.proj4str) return;

    if (chosen.id === '__custom') {
      // 显示构建器
      if (builder) builder.style.display = 'block';
      if (side === 'src') srcCustom = true;
      else               dstCustom = true;
      _refreshBuilder(side);
    } else {
      if (builder) builder.style.display = 'none';
      if (side === 'src') { srcCustom = false; srcProj4 = chosen.proj4str; }
      else               { dstCustom = false; dstProj4 = chosen.proj4str; }
      if (preview) {
        preview.textContent = chosen.proj4str;
        preview.classList.remove('error');
      }
    }
  }

  /** 投影类型切换 → 显示/隐藏参数区 */
  function _onProjChange(side) {
    const proj = document.getElementById(`pb-${side}-proj`)?.value;
    const gaussArea = document.getElementById(`pb-${side}-gauss-params`);
    const utmArea   = document.getElementById(`pb-${side}-utm-params`);
    if (gaussArea) gaussArea.style.display = proj === 'gauss' ? 'block' : 'none';
    if (utmArea)   utmArea.style.display   = proj === 'utm'   ? 'block' : 'none';
    _refreshBuilder(side);
  }

  /** 中央子午线来源切换 */
  function _setCmMode(side, mode) {
    document.getElementById(`pb-${side}-cm-mode`).value = mode;
    const directArea = document.getElementById(`pb-${side}-cm-direct-area`);
    const bandArea   = document.getElementById(`pb-${side}-cm-band-area`);
    const btnDirect  = document.getElementById(`pb-${side}-cm-btn-direct`);
    const btnBand    = document.getElementById(`pb-${side}-cm-btn-band`);
    if (directArea) directArea.style.display = mode === 'direct' ? 'block' : 'none';
    if (bandArea)   bandArea.style.display   = mode === 'band'   ? 'block' : 'none';
    if (btnDirect)  btnDirect.classList.toggle('active', mode === 'direct');
    if (btnBand)    btnBand.classList.toggle('active', mode === 'band');
    _refreshBuilder(side);
  }

  /** 重新生成 PROJ 字符串并刷新预览 */
  function _refreshBuilder(side) {
    // 如果按带号模式，显示推算出的中央子午线
    const cmMode  = document.getElementById(`pb-${side}-cm-mode`)?.value;
    const derived = document.getElementById(`pb-${side}-cm-derived`);
    if (cmMode === 'band' && derived) {
      const bandType = document.getElementById(`pb-${side}-band-type`)?.value;
      const bandNo   = parseInt(document.getElementById(`pb-${side}-band-no`)?.value, 10);
      if (!isNaN(bandNo)) {
        const cm = bandType === '3' ? bandNo * 3 : bandNo * 6 - 3;
        derived.textContent = `→ 中央子午线 ${cm}°`;
      } else {
        derived.textContent = '';
      }
    }
    refreshProjStr(side);
  }

  // ── 单点转换 ─────────────────────────────────────────────────────

  function convertSingle() {
    const xStr = document.getElementById('pb-single-x').value.trim();
    const yStr = document.getElementById('pb-single-y').value.trim();
    const errEl = document.getElementById('pb-single-error');

    errEl.style.display = 'none';
    document.getElementById('pb-res-x').textContent = '—';
    document.getElementById('pb-res-y').textContent = '—';

    if (!xStr || !yStr) { showSingleErr('请输入 X 和 Y 坐标'); return; }

    const x = parseFloat(xStr), y = parseFloat(yStr);
    if (isNaN(x) || isNaN(y)) { showSingleErr('坐标值包含非数字内容'); return; }

    try {
      const res = doConvert(x, y, srcProj4, dstProj4);
      document.getElementById('pb-res-x').textContent = fmtCoord(res.x, dstProj4);
      document.getElementById('pb-res-y').textContent = fmtCoord(res.y, dstProj4);
      setStatus(`转换成功：(${fmtCoord(res.x, dstProj4)}, ${fmtCoord(res.y, dstProj4)})`);
    } catch (e) {
      showSingleErr(e.message);
      setStatus(`转换错误：${e.message}`, true);
    }
  }

  function showSingleErr(msg) {
    const el = document.getElementById('pb-single-error');
    if (!el) return;
    el.textContent = msg;
    el.style.display = 'flex';
    setStatus(msg, true);
  }

  function clearSingle() {
    ['pb-single-x','pb-single-y'].forEach(id => document.getElementById(id).value = '');
    ['pb-res-x','pb-res-y'].forEach(id => document.getElementById(id).textContent = '—');
    document.getElementById('pb-single-error').style.display = 'none';
    setStatus('就绪');
  }

  // ── 批量转换 ─────────────────────────────────────────────────────

  function convertBatch() {
    const raw = document.getElementById('pb-batch-input').value;
    if (!raw.trim()) { setStatus('请粘贴要转换的数据'); return; }

    const colX      = parseInt(document.getElementById('pb-col-x').value, 10);
    const colY      = parseInt(document.getElementById('pb-col-y').value, 10);
    const colId     = parseInt(document.getElementById('pb-col-id').value, 10);
    const passMode  = document.getElementById('pb-col-pass').value;
    const skipHdr   = parseInt(document.getElementById('pb-skip-header').value, 10);

    const splitLine = (typeof FormatConvert !== 'undefined')
      ? FormatConvert.splitLine
      : line => line.split('\t').map(s => s.trim());

    const lines = raw.split(/\r?\n/);
    const results = [];
    let ok = 0, fail = 0;

    lines.forEach((line, lineIdx) => {
      if (!line.trim()) return;

      // 跳过标题行：原样保留
      if (lineIdx < skipHdr) { results.push(line); return; }

      const cols = splitLine(line);

      // 检查列是否存在
      if (colX >= cols.length || colY >= cols.length) {
        fail++;
        results.push(appendErr(line, '列数不足'));
        return;
      }

      const x = parseFloat(cols[colX]);
      const y = parseFloat(cols[colY]);
      if (isNaN(x) || isNaN(y)) {
        fail++;
        results.push(appendErr(line, `X/Y 非数字 ("${cols[colX]}", "${cols[colY]}")`));
        return;
      }

      try {
        const res  = doConvert(x, y, srcProj4, dstProj4);
        const outX = fmtCoord(res.x, dstProj4);
        const outY = fmtCoord(res.y, dstProj4);

        let outCols;
        if (passMode === 'keep') {
          outCols = [...cols];
          outCols[colX] = outX;
          outCols[colY] = outY;
        } else if (passMode === 'drop') {
          outCols = colId >= 0 && colId < cols.length
            ? [cols[colId], outX, outY]
            : [outX, outY];
        } else { // append
          outCols = [...cols, outX, outY];
        }
        results.push(outCols.join('\t'));
        ok++;
      } catch (e) {
        fail++;
        results.push(appendErr(line, e.message));
      }
    });

    document.getElementById('pb-batch-output').value = results.join('\n');

    const statsEl = document.getElementById('pb-batch-stats');
    statsEl.style.display = 'flex';
    document.getElementById('pb-stat-total').textContent = ok + fail;
    document.getElementById('pb-stat-ok').textContent    = ok;
    document.getElementById('pb-stat-fail').textContent  = fail;

    setStatus(`批量转换完成：${ok} 成功，${fail} 失败`);
  }

  function appendErr(line, msg) {
    return `${line}\t[错误] ${msg}`;
  }

  function copyBatch() {
    const out = document.getElementById('pb-batch-output').value;
    if (!out) { setStatus('没有可复制的结果'); return; }
    navigator.clipboard.writeText(out).then(() => setStatus('已复制到剪贴板'));
  }

  function clearBatch() {
    document.getElementById('pb-batch-input').value  = '';
    document.getElementById('pb-batch-output').value = '';
    document.getElementById('pb-batch-stats').style.display = 'none';
    setStatus('就绪');
  }

  function copyVal(id, btn) {
    const el = document.getElementById(id);
    if (!el || el.textContent === '—') return;
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
    el.textContent = msg;
    el.style.color = isError ? 'var(--topo-red)' : 'rgba(255,255,255,0.35)';
  }

  // ── 公开 API ─────────────────────────────────────────────────────
  return {
    render,
    _onPresetChange,
    _onProjChange,
    _setCmMode,
    _refreshBuilder,
    convertSingle, clearSingle,
    convertBatch,  copyBatch, clearBatch,
    copyVal,
  };
})();
