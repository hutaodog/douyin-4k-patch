/* ==== dypc4k begin ==== */
/* dypc4k v1.3 —— 变更：
 *   0) 补档位真正生效：档位采集原来只挂在 AB 分支（视频响应根本进不来），
 *      且接口档位的 uri 是"每档一个"，改为按 aweme_id 建索引
 *   1) 画质日志：每条视频记录 实际分辨率/表内最高/接口给到/是否注入 -> %APPDATA%\douyin\dypc4k-quality.log
 *   2) 视频一开播就巡检（不等 800ms 定时器），缩短"先低后高"的窗口
 *   ---- 以下为 v1.2 ----
 *   1) 不再钉死编码族（客户端要 h265，而 4K/2K 只存在于 h265）
 *   2) 档位表里没有 4K 时，钉该列表的最高档（原来直接 return，导致 2K 视频落 720）
 *   3) 新增"补档位"：用接口返回的 bit_rate 合成播放器条目，补回被客户端裁掉的高档
 *   4) 底部清晰度标签跟随真实解码分辨率
 */
/* 抖音 PC 客户端「固定 4K」— preload 版注入（改文件方案用；CDP 方案不需要这段）
 * 挂在 <版本>\resources\app.asar.unpacked\preload.js 末尾。
 * 只在 https://*.douyin.com 下生效；只写 sessionStorage['MANUAL_SWITCH']。
 * 档位：4khdr / 4k / 2k / 1080p（改下面的 TARGET，或用 -Target 参数安装）
 *
 * v2 改进：
 *   1) 用 require('electron').webFrame.executeJavaScript 在【页面主世界】装一个钩子，
 *      把客户端自己写过的 MANUAL_SWITCH 原样存到 localStorage['__DYPC4K_RAW__']；
 *   2) 之后我们的写入以客户端真实结构为模板（保住 qualityType / clarityReal 等字段），
 *      只覆盖 gearType / gearClarity / gearName —— 避免"合成值"和客户端内部字段对不上。
 *   3) 主世界的 removeItem 也会被立刻感知（客户端 mount 时 pC 清空的场景）。
 *
 * 注意：preload 跑在隔离世界（contextIsolation），够不到页面自己的 Storage.prototype，
 *       所以必须靠上面的主世界注入才能拿到客户端视角。
 */
;(function () {
  try {
    var H = (location && location.hostname) || '';
    if (H !== 'douyin.com' && !/(^|\.)douyin\.com$/.test(H)) return;
    var TARGET = '4k';
    var MODE = 'force';
    // FIGHT=true：客户端把 4K 项抽走后抢回来 + 拦截降档调用（4K 优先，可能偶发重载）
    // FIGHT=false：每条视频以 4K 起播；客户端自己降档后不再拉锯（无闪断，稳定）
    var FIGHT = false;
    // 编码族：4K 出现时客户端用的就是这一族；把它钉住，阻止它换到没有 4K 的那一族
    var LOCK_CODEC = '';
    // 编码能力改判范围：
    //   'vvc'     只封 H.266/VVC —— 客户端约 8 秒后会迁到 VVC 那一族，那族没有 4K；封掉它，4K(HEVC) 就能留住
    //   'vvc-all' 连 HEVC/AV1 一起封 —— 只留 H.264（实测会把 4K 一起封掉，只剩 1080P）
    //   'none'    不改判
    var REFUSE = 'vvc';
    // 改写服务端 AB 参数里的降档开关（auto_clarity_reselect / switch_clarity_timing /
    // smooth_switch_clarity / degradeBitrateFactors / maxDownSwitchLevel 等）
    var AB_PATCH = true;
    try {
      var rawCfg = localStorage.getItem('__DYPC4K_CFG__');
      if (rawCfg) {
        var cfg = JSON.parse(rawCfg);
        if (cfg && cfg.target) TARGET = cfg.target;
        if (cfg && cfg.mode) MODE = cfg.mode;
        if (MODE === 'remember') return;
      }
    } catch (e) {}
    var P = {
      '4khdr': { gearType: -3, gearClarity: '30', gearName: '超清 4K HDR', qualityType: 1 },
      '4k':    { gearType: -2, gearClarity: '20', gearName: '超清 4K',     qualityType: 1 },
      '2k':    { gearType: -1, gearClarity: '10', gearName: '超清 2K',     qualityType: 1 },
      '1080p': { gearType: 1,  gearClarity: '5',  gearName: '高清 1080P',  qualityType: 1 }
    };
    var p = P[TARGET] || P['4k'];
    var K = 'MANUAL_SWITCH';
    var RAW = '__DYPC4K_RAW__';

    // ---------- 主世界钩子：记录客户端自己写的真实结构 ----------
    var MAIN_HOOK = '(' + function () {
      if (window.__dypc4kLearn) return;
      window.__dypc4kLearn = 1;
      var K = 'MANUAL_SWITCH';
      var proto = window.Storage && window.Storage.prototype;
      if (!proto) return;
      var set = proto.setItem, rem = proto.removeItem;
      proto.setItem = function (k, v) {
        var r = set.apply(this, arguments);
        try {
          if (String(k) === K) {
            localStorage.setItem('__DYPC4K_RAW__', String(v));
            window.postMessage({ __dypc4k: 2, op: 'set', v: String(v).slice(0, 800) }, '*');
          }
        } catch (e) {}
        return r;
      };
      proto.removeItem = function (k) {
        var r = rem.apply(this, arguments);
        try {
          if (String(k) === K) window.postMessage({ __dypc4k: 2, op: 'remove' }, '*');
        } catch (e) {}
        return r;
      };
    }.toString() + ')()';

    try {
      require('electron').webFrame.executeJavaScript(MAIN_HOOK).catch(function () {});
    } catch (e) {}

    // 主世界把值写进来后，立刻补一次（清空场景）
    window.addEventListener('message', function (ev) {
      var d = ev && ev.data;
      if (d && d.__dypc4k === 2 && d.op === 'remove') tick();
    }, false);

    var lastBeat = 0;
    function beat() {
      var now = Date.now();
      if (now - lastBeat < 1500) return;
      lastBeat = now;
      try {
        localStorage.setItem('__DYPC4K_STATE__', JSON.stringify({
          at: now, by: 'dypc4k-preload-v2', target: TARGET,
          learned: !!localStorage.getItem(RAW),
          manualSwitch: sessionStorage.getItem(K)
        }));
      } catch (e) {}
    }

    // 以客户端真实结构为模板，只覆盖决定档位的三个字段
    function want() {
      var tpl = null;
      try { tpl = JSON.parse(localStorage.getItem(RAW) || 'null'); } catch (e) {}
      var o = {};
      if (tpl && typeof tpl === 'object') for (var k in tpl) o[k] = tpl[k];
      o.done = 1;
      o.gearType = p.gearType;
      o.gearClarity = p.gearClarity;
      o.gearName = p.gearName;
      // 只有当模板本来就是这个档位时，才沿用客户端给它的 qualityType
      var sameGear = tpl && String(tpl.gearClarity) === p.gearClarity && typeof tpl.qualityType === 'number';
      if (!sameGear) o.qualityType = p.qualityType;
      return JSON.stringify(o);
    }

    function tick() {
      try {
        beat();
        var v = want(), c = sessionStorage.getItem(K);
        if (c === v) return;
        var keep = false;
        try { var o = JSON.parse(c); keep = !!o && o.gearType === p.gearType && String(o.gearClarity) === p.gearClarity; } catch (e) {}
        if (!keep) sessionStorage.setItem(K, v);
      } catch (e) {}
    }

    tick();
    [0, 30, 80, 160, 320, 600, 1000, 1600].forEach(function (ms) { setTimeout(tick, ms); });
    setInterval(tick, 400);
    try { document.addEventListener('visibilitychange', tick, false); } catch (e) {}
    try { window.addEventListener('focus', tick, false); } catch (e) {}

    // ---------- 主世界：播放器锁（关掉 ABR，并把档位钉回目标值）----------
    // 客户端的自适应码率会按缓冲/带宽自己上下调档（服务端 abr_config:
    // safeUpgrade/maxUpSwitchLevel/maxDownSwitchLevel…），手选档位只是"起点"。
    // 这里拿到 webpack 模块缓存里的播放器注册表（getAllPlayer），直接改播放器：
    //   config.needAutoBitrate = false  → 停掉自动调档
    //   curDefinition !== 目标 && 列表里有目标 → changeDefinition 钉回去
    var LOCK_FN = function (CFG) {

      // ================= 档位补充（v1.2）=================
      // 实测：接口返回的 bit_rate 里有 4K/2K 档，但客户端只把其中一部分放进了播放器的
      // definition.list（例如某条视频接口给了 13 档含 1440p，播放器里却只有 720/540）。
      // 这里把接口档位按 uri 索引起来，发现播放器缺高档时，就合成一个条目塞进列表。
      // 字段与播放器自带条目一一对应（uri / url[{src}] / size / bitrate / definition / isH265 …）。
      var GEARMAP = {};    // uri -> [{def, gear}]
      var URI2AID = {};    // 任意一档的 uri -> aweme_id
      var AID2GEARS = {};  // aweme_id -> 该视频全部档位
      window.__dypc4kGearMap = GEARMAP;
      function tierDef(h) {
        return h >= 2160 ? -2 : h >= 1400 ? -1 : h >= 1000 ? 1 : h >= 700 ? 2 : 3;
      }
      function captureGears(j) {
        try {
          if (!j || typeof j !== 'object') return;
          var stack = [j], guard = 3000;
          while (stack.length && guard-- > 0) {
            var v = stack.pop();
            if (!v || typeof v !== 'object') continue;
            if (Array.isArray(v)) { for (var i = 0; i < v.length && i < 80; i++) stack.push(v[i]); continue; }
            if (v.video && Array.isArray(v.video.bit_rate) && v.video.bit_rate.length) {
              for (var gi = 0; gi < v.video.bit_rate.length; gi++) {
                var g = v.video.bit_rate[gi];
                var pa = (g && g.play_addr) || {};
                var uri = String(pa.uri || '');
                if (!uri) continue;
                var arr = GEARMAP[uri] || (GEARMAP[uri] = []);
                var h = Math.min(pa.width || 0, pa.height || 0) || Math.max(pa.width || 0, pa.height || 0) || 0;
                var rec = { def: tierDef(h), h: h, g: g };
                arr.push(rec);
                // 关键：接口的 uri 是"每档一个"，播放器条目的 uri 未必等于它，
                // 所以再按 aweme_id 建一份索引，用任意一档的 uri 都能反查到整条视频的档位表。
                try {
                  var aid = String(v.aweme_id || '');
                  if (aid) {
                    URI2AID[uri] = aid;
                    var bag = AID2GEARS[aid] || (AID2GEARS[aid] = []);
                    bag.push(rec);
                  }
                } catch (e0) {}
              }
            }
            for (var k in v) { var c = v[k]; if (c && typeof c === 'object') stack.push(c); }
          }
        } catch (e) {}
      }
      window.__dypc4kCapture = captureGears;

      // 用接口档位合成一个播放器能用的条目
      function synthEntry(rec) {
        try {
          var g = rec.g, pa = g.play_addr || {};
          var urls = (pa.url_list || []).map(function (u) { return { src: u }; });
          if (!urls.length) return null;
          return {
            vid: String(pa.uri || ''),
            size: pa.data_size || 0,
            uri: String(pa.uri || ''),
            url: urls,
            bitrate: g.bit_rate || 0,
            realBitrate: g.bit_rate || 0,
            definition: rec.def,
            qualityType: g.quality_type,
            duration: 0,
            isH265: !!(g.is_h265 || g.is_bytevc1),
            gearName: g.gear_name,
            isH266: false, isHDR: false,
            vtype: 'normal', mediaType: 'video',
            codecType: (g.is_h265 || g.is_bytevc1) ? 'h265' : 'h264',
            fps: g.FPS || 30,
            width: pa.width, height: pa.height,
            format: g.format
          };
        } catch (e) { return null; }
      }

      // 给某个播放器的列表补上缺失的高档（返回补进来的档位定义值，没补则返回 null）
      function fillMissing(list) {
        try {
          if (!list || !list.length) return null;
          // 用列表里任意一档的 uri 反查 aweme_id，再拿这条视频的全部档位
          var cands = null;
          for (var li2 = 0; li2 < list.length && !cands; li2++) {
            var u2 = String((list[li2] && list[li2].uri) || '');
            if (!u2) continue;
            var aid2 = URI2AID[u2];
            if (aid2 && AID2GEARS[aid2] && AID2GEARS[aid2].length) cands = AID2GEARS[aid2];
            else if (GEARMAP[u2] && GEARMAP[u2].length) cands = GEARMAP[u2];
          }
          if (!cands || !cands.length) { try { if (!W.__dypc4kFillDbg) { W.__dypc4kFillDbg = 1; post('fillmiss', 'no cands for ladder uris'); } } catch (e) {} return null; }
          // 当前列表里最好的档位
          var bestDef = 99;
          for (var i = 0; i < list.length; i++) {
            var d = Number(list[i] && list[i].definition);
            if (!isNaN(d) && d < bestDef) bestDef = d;
          }
          // 接口里最好的档位
          var best = null;
          for (var j = 0; j < cands.length; j++) {
            if (!best || cands[j].def < best.def) best = cands[j];
          }
          if (!best || !(best.def < bestDef)) { try { if (!W.__dypc4kFillDbg2) { W.__dypc4kFillDbg2 = 1; post('fillmiss', 'best=' + (best && best.def) + ' ladderBest=' + bestDef); } } catch (e) {} return null; }
          var entry = synthEntry(best);
          if (!entry) { try { if (!W.__dypc4kFillDbg3) { W.__dypc4kFillDbg3 = 1; post('fillmiss', 'synthEntry null (urls empty)'); } } catch (e) {} return null; }
          list.push(entry);
          W.__dypc4kLastInject = Date.now();
          return best.def;
        } catch (e) { return null; }
      }
      window.__dypc4kFill = fillMissing;

      // ============ 让客户端的清晰度标签跟上真实画质 ============
      // 实测：实际已经在播 4K/1080，客户端底部还写着「高清 720P」——那是它自己的 UI 状态，
      // 跟我们写的 MANUAL_SWITCH 不同步。这里只改**文字**，不碰播放逻辑。
      (function labelFix() {
        var RULES = [[2000, '超清 4K'], [1300, '超清 2K'], [1000, '高清 1080P'], [800, '高清 720P']];
        var RE = /^\s*(超清|高清|标清|智能|自动)\s*(4K|2K|1080P|720P|540P)?\s*$/i;
        function realH() {
          var best = 0, vs = document.querySelectorAll('video');
          for (var i = 0; i < vs.length; i++) {
            if (!vs[i].paused && vs[i].videoHeight > best) best = vs[i].videoHeight;
          }
          return best;
        }
        function tick() {
          try {
            var h = realH();
            if (!h) return;
            var want = null;
            for (var r = 0; r < RULES.length; r++) { if (h >= RULES[r][0]) { want = RULES[r][1]; break; } }
            if (!want) return;
            var vh = window.innerHeight || 800;
            var els = document.querySelectorAll('div,span');
            for (var j = 0; j < els.length && j < 4000; j++) {
              var e = els[j];
              var tx = (e.textContent || '').trim();
              if (tx === want) return;
              if (tx.length > 8 || !RE.test(tx)) continue;
              if (e.children.length > 2) continue;
              var rc = e.getBoundingClientRect();
              if (rc.width < 8 || rc.height < 8 || rc.height > 44) continue;
              if (rc.top < vh * 0.62) continue;
              e.textContent = want;
              return;
            }
          } catch (e) {}
        }
        setInterval(tick, 900);
      })();
      var W = window, TAG = '__dypc4kLock';
      if (W[TAG]) return;
      W[TAG] = 1;
      function post(kind, data) {
        try { W.postMessage({ __dypc4k: 3, kind: kind, data: data }, '*'); } catch (e) {}
      }

      // ---------- -1) 改 AB 参数：关掉"自动重选清晰度/降档" ----------
      // 客户端的降档策略来自服务端 AB 参数（/aweme/v1/web/mobile/ab/params/ 与
      // TTE_ENV.layoutInitialProps.allAbParams）。在渲染层把响应里这几个开关改掉，
      // 比改本地 SQLite 可靠（那个每次启动都会被重新拉取覆盖）。
      try {
        if (CFG.abPatch) {
          var AB_OFF = ['auto_clarity_reselect', 'switch_clarity_timing', 'smooth_switch_clarity'];
          var stat = { fetch: 0, xhr: 0, changed: 0, keys: [] };
          function markKey(k) { if (stat.keys.length < 24 && stat.keys.indexOf(k) < 0) stat.keys.push(k); }
          function patchABObj(o, depth) {
            if (!o || typeof o !== 'object' || depth > 6) return 0;
            var n = 0;
            for (var k in o) {
              var v = o[k];
              if (AB_OFF.indexOf(k) >= 0 && v !== 0) { o[k] = 0; n++; markKey(k); }
              // 注意：不再动 use_h266_client / fix_h266_list / degradeBitrateFactors
              // （实测把 h266 关掉后，部分视频的高码流会从档位列表里消失，只剩 720P/540P）
              else if (k === 'maxDownSwitchLevel' && Number(v) !== 0) { o[k] = 0; n++; markKey(k); }
              else if ((k === 'rebufferDegrade' || k === 'safeRebufferDegrade') && Number(v) !== 0) { o[k] = 0; n++; markKey(k); }
              else if (v && typeof v === 'object' && patchABObj(v, depth + 1)) n++;
            }
            return n;
          }
          // 视频请求 URL 修正：实测 channel/aid/主机名都不影响档位表，这里保留一个空的钩子位，
          // 方便以后发现别的原因时在这里加（当前不做任何改写）。
          function fixUrl(u) { return u; }

          var AB_URL = /ab\/params|mobile\/ab|abtest/i;
          // fetch
          var of = W.fetch;
          if (typeof of === 'function' && !of.__dypc4k) {
            W.fetch = function (input, init) {
              var url = '';
              try { url = String(typeof input === 'string' ? input : (input && input.url) || ''); } catch (e) {}
              // 补 channel 参数（只在需要时重建请求）
              try {
                var fixed = fixUrl(url);
                if (fixed !== url) {
                  if (typeof input === 'string') { input = fixed; url = fixed; }
                  else if (typeof Request !== 'undefined' && input instanceof Request) {
                    input = new Request(fixed, input); url = fixed;
                  }
                }
              } catch (e) {}
              var p = of.apply(this, arguments);
              var isAB = AB_URL.test(url);
              if (!isAB && !VID_URL.test(url)) return p;     // __dypc4kAllHook
              return p.then(function (res) {
                return res.text().then(function (txt) {
                  var maybeGear = txt.indexOf('bit_rate') >= 0;
                  if (!isAB && !maybeGear) return new Response(txt, { status: res.status, statusText: res.statusText, headers: res.headers });
                  var j = null;
                  try { j = JSON.parse(txt); } catch (e) {}
                  if (!j) return new Response(txt, { status: res.status, statusText: res.statusText, headers: res.headers });
                  try { if (maybeGear) captureGears(j); } catch (e6) {}
                  var n = 0;
                  try { if (isAB) n = patchABObj(j, 0); } catch (e8) {}
                  if (isAB) { stat.fetch++; if (n) { stat.changed += n; post('abpatch', 'fetch ' + url.slice(0, 60) + ' changed=' + n + ' [' + stat.keys.join(',') + ']'); } }
                  if (!n && !maybeGear) return new Response(txt, { status: res.status, statusText: res.statusText, headers: res.headers });
                  return new Response(JSON.stringify(j), { status: res.status, statusText: res.statusText, headers: res.headers });
                });
              });
            };
            W.fetch.__dypc4k = 1;
          }
          // XMLHttpRequest
          var XO = W.XMLHttpRequest;
          if (XO && XO.prototype && !XO.prototype.__dypc4k) {
            var xopen = XO.prototype.open;
            XO.prototype.open = function (m, u) {
              try {
                var fu = fixUrl(String(u || ''));
                if (fu !== String(u || '')) { arguments[1] = fu; u = fu; }
                this.__dypc4kUrl = String(u || '');
              } catch (e) {}
              return xopen.apply(this, arguments);
            };
            var descText = Object.getOwnPropertyDescriptor(XO.prototype, 'responseText');
            if (descText && descText.get) {
              Object.defineProperty(XO.prototype, 'responseText', {
                configurable: true,
                get: function () {
                  var t = descText.get.call(this);
                  try {
                    var isABx = this.__dypc4kUrl && AB_URL.test(this.__dypc4kUrl);
                    var isGearx = t && t.indexOf('bit_rate') >= 0;
                    if (this.readyState === 4 && (isABx || isGearx)) {
                      var j = JSON.parse(t);
                      try { if (isGearx) captureGears(j); } catch (e7) {}
                      var n = isABx ? patchABObj(j, 0) : 0;
                      if (isABx) { stat.xhr++; if (n) { stat.changed += n; post('abpatch', 'xhr ' + String(this.__dypc4kUrl).slice(0, 60) + ' changed=' + n + ' [' + stat.keys.join(',') + ']'); } }
                      if (n || isGearx) return JSON.stringify(j);
                    }
                  } catch (e) {}
                  return t;
                }
              });
            }
            var descResp = Object.getOwnPropertyDescriptor(XO.prototype, 'response');
            if (descResp && descResp.get) {
              Object.defineProperty(XO.prototype, 'response', {
                configurable: true,
                get: function () {
                  var r = descResp.get.call(this);
                  try {
                    if (this.__dypc4kUrl && AB_URL.test(this.__dypc4kUrl) && this.readyState === 4) {
                      if (r && typeof r === 'object') { var n1 = patchABObj(r, 0); if (n1) { stat.changed += n1; post('abpatch', 'xhr-obj changed=' + n1 + ' [' + stat.keys.join(',') + ']'); } return r; }
                      if (typeof r === 'string' && r) {
                        var j = JSON.parse(r); var n2 = patchABObj(j, 0);
                        if (n2) { stat.changed += n2; post('abpatch', 'xhr-resp changed=' + n2 + ' [' + stat.keys.join(',') + ']'); }
                        return JSON.stringify(j);
                      }
                    }
                  } catch (e) {}
                  return r;
                }
              });
            }
            XO.prototype.__dypc4k = 1;
          }
          // 页面初始化里那一份（preload 塞进来的）
          try {
            var lp = W.TTE_ENV && W.TTE_ENV.layoutInitialProps;
            if (lp) { var nn = patchABObj(lp, 0); post('abpatch', 'layoutInitialProps changed=' + nn); }
          } catch (e) {}
          post('abpatch', 'AB 改写钩子已安装（fetch/xhr/layoutInitialProps）');
        }
      } catch (e) { post('err', 'abpatch: ' + e.message); }

      // ---------- 0) 改判定输入：按 REFUSE 范围封掉某些编码族的"支持检测" ----------
      // 客户端的 nH/nU/nD 三条分支出自 isTypeSupported / canPlayType / mediaCapabilities。
      // 实测：HEVC 就是 4K 所在的那一族；VVC(H.266) 那一族没有 4K。
      // 所以只封 VVC，能挡住客户端 8 秒后迁过去，又不会把 4K 一起封掉。
      try {
        if (CFG.refuse && CFG.refuse !== 'none') {
          var HARD = CFG.refuse === 'vvc-all'
            ? /(hvc1|hev1|dvh1|dvhe|vvc1|vvi1|h266|av01)/i
            : /(vvc1|vvi1|h266|vvcC)/i;
          var hits = {};
          var noteHit = function (s) {
            var m = String(s).match(HARD);
            if (m) { var k = m[1].toLowerCase(); if (!hits[k] || Date.now() - hits[k] > 5000) { hits[k] = Date.now(); post('caps', 'refused ' + k); } }
            return !!m;
          };
          var MS = W.MediaSource;
          if (MS && typeof MS.isTypeSupported === 'function' && !MS.__dypc4k) {
            var ist = MS.isTypeSupported.bind(MS);
            MS.isTypeSupported = function (t) {
              try { if (noteHit(t)) return false; } catch (e) {}
              return ist(t);
            };
            MS.__dypc4k = 1;
          }
          if (W.MediaSource && MS !== W.MediaSource && W.MediaSource.isTypeSupported) { /* ManagedMediaSource 等，忽略 */ }
          var mms = W.ManagedMediaSource;
          if (mms && typeof mms.isTypeSupported === 'function' && !mms.__dypc4k) {
            var mist = mms.isTypeSupported.bind(mms);
            mms.isTypeSupported = function (t) {
              try { if (noteHit(t)) return false; } catch (e) {}
              return mist(t);
            };
            mms.__dypc4k = 1;
          }
          var cpt = W.HTMLMediaElement && W.HTMLMediaElement.prototype && W.HTMLMediaElement.prototype.canPlayType;
          if (cpt && !W.HTMLMediaElement.prototype.__dypc4k) {
            W.HTMLMediaElement.prototype.canPlayType = function (t) {
              try { if (noteHit(t)) return ''; } catch (e) {}
              return cpt.apply(this, arguments);
            };
            W.HTMLMediaElement.prototype.__dypc4k = 1;
          }
          var mc = W.navigator && W.navigator.mediaCapabilities;
          if (mc && typeof mc.decodingInfo === 'function' && !mc.__dypc4k) {
            var mdi = mc.decodingInfo.bind(mc);
            mc.decodingInfo = function (cfg) {
              try {
                var ct = cfg && cfg.video && cfg.video.contentType;
                if (ct && noteHit(ct)) {
                  return Promise.resolve({ supported: false, smooth: false, powerEfficient: false });
                }
              } catch (e) {}
              return mdi(cfg);
            };
            mc.__dypc4k = 1;
          }
          post('caps', 'caps refusal = ' + CFG.refuse + (CFG.refuse === 'vvc' ? ' (只封 H.266/VVC，放行 HEVC)' : ' (HEVC/VVC/AV1 全封)'));
        }
      } catch (e) { post('err', 'caps: ' + e.message); }
      var req = null;
      function grabRequire() {
        if (req) return true;
        var g = W.webpackChunkdouyin_web;
        if (!g || typeof g.push !== 'function') return false;
        try { g.push([['dypc4k'], {}, function (r) { req = r; }]); } catch (e) { post('err', 'webpack push: ' + e.message); }
        return !!req;
      }
      post('boot', 'waiting for webpack runtime');

      var regs = [];
      function scanRegs() {
        regs = [];
        try {
          var cache = req.c || {};
          for (var id in cache) {
            var ex = null;
            try { ex = cache[id] && cache[id].exports; } catch (e) { continue; }
            if (!ex || typeof ex !== 'object') continue;
            var cands = [ex];
            if (ex.default && typeof ex.default === 'object') cands.push(ex.default);
            for (var k in ex) { try { if (ex[k] && typeof ex[k] === 'object') cands.push(ex[k]); } catch (e) {} }
            for (var i = 0; i < cands.length; i++) {
              var c = cands[i];
              if (c && typeof c.getAllPlayer === 'function' && regs.indexOf(c) < 0) regs.push(c);
            }
          }
        } catch (e) { post('err', 'scan: ' + e.message); }
        return regs.length;
      }

      function allPlayers() {
        // A) webpack 模块缓存里的播放器注册表
        var ps = [];
        regs.forEach(function (r) {
          try { var a = r.getAllPlayer(); if (a && a.length) ps = ps.concat(a); } catch (e) {}
        });
        // B) window / DOM 上的播放器实例（xgplayer 常把实例挂在容器元素上）
        var found = [];
        try {
          var keys = Object.keys(W);
          for (var i = 0; i < keys.length && i < 4000; i++) {
            var k = keys[i];
            if (/webpack|performance|chrome|webkit/i.test(k)) continue;
            try {
              var v = W[k];
              if (v && typeof v === 'object' && typeof v.changeDefinition === 'function' && v.config) found.push(v);
            } catch (e) {}
          }
        } catch (e) {}
        try {
          var els = document.querySelectorAll('[class*="xgplayer"], [class*="player"]');
          for (var j = 0; j < els.length && j < 150; j++) {
            var el = els[j], ek;
            try { ek = Object.getOwnPropertyNames(el); } catch (e) { ek = []; }
            for (var m = 0; m < ek.length; m++) {
              try {
                var o = el[ek[m]];
                if (o && typeof o === 'object' && typeof o.changeDefinition === 'function' && o.config) found.push(o);
              } catch (e) {}
            }
          }
        } catch (e) {}
        if (!found.length) {
          var pr = W.playerPreloader;
          if (pr) {
            try {
              if (pr.player && typeof pr.player.changeDefinition === 'function') found.push(pr.player);
              if (typeof pr.getPlayer === 'function') { var gp = pr.getPlayer(); if (gp) found.push(gp); }
            } catch (e) {}
          }
        }
        ps = ps.concat(found);
        var uniq = [];
        for (var n = 0; n < ps.length; n++) if (ps[n] && uniq.indexOf(ps[n]) < 0) uniq.push(ps[n]);
        return uniq;
      }
      function gearsOf(p) {
        var c = p.config || {}, list = (c.definition && c.definition.list) || [];
        return list.map(function (x) { return String(x.gearName || '?') + '@' + x.definition; });
      }
      // 当前正在用的档位：不同版本挂在不同地方，挨个试
      function curDef(p) {
        try {
          if (p.curDefinition && p.curDefinition.definition != null) return Number(p.curDefinition.definition);
          var pl = p.plugins || {};
          var bs = pl.bitrateselector || pl.bitrateSelector;
          if (bs && bs.curBitRate && bs.curBitRate.definition != null) return Number(bs.curBitRate.definition);
          if (pl.dashplugin && pl.dashplugin.curDefinition && pl.dashplugin.curDefinition.definition != null)
            return Number(pl.dashplugin.curDefinition.definition);
          if (p.video && p.video.videoWidth) return p.video.videoWidth + 'x' + p.video.videoHeight;
        } catch (e) {}
        return null;
      }
      function targetEntry(p) {
        var c = p.config || {}, list = (c.definition && c.definition.list) || [];
        for (var i = 0; i < list.length; i++) {
          if (Number(list[i].definition) === Number(CFG.gear) && !list[i].isBackup) return list[i];
        }
        return null;
      }

      var reverts = {}, lastSig = '', tickCount = 0, cached = [], QLOG_SEEN = {};
      var good4k = {}, reinjected = {}, goodCodec = {};   // 缓存 4K 项 / 塞回次数 / 4K 时的编码族

      function defList(p) {
        try {
          var d = p.config && p.config.definition;
          if (d && Array.isArray(d.list)) return d.list;
        } catch (e) {}
        return null;
      }
      function entryIn(list, gear) {
        if (!list) return null;
        for (var i = 0; i < list.length; i++) {
          if (list[i] && Number(list[i].definition) === Number(gear)) return list[i];
        }
        return null;
      }
      function atTarget(cur) {
        if (typeof cur === 'number') return cur === Number(CFG.gear);
        if (typeof cur === 'string') return parseInt(cur, 10) >= 2000;
        return false;
      }

      // 拦截"降档"：客户端换族后会调用 changeDefinition 切到更低档（1/2/3 或 -1），
      // 只要 4K 可用（列表里有或我们缓存过），就把这类调用吞掉，让播放器保持 4K 流不动。
      function installGuard(p, idx) {
        try {
          if (p.__dypc4kGuard) return;
          if (typeof p.changeDefinition !== 'function') return;
          var orig = p.changeDefinition.bind(p);
          p.changeDefinition = function (entry, cur) {
            try {
              if (CFG.fight) {
                var want = null;
                if (entry && entry.definition !== undefined) want = Number(entry.definition);
                else if (typeof entry === 'number') want = Number(entry);
                var have4k = !!good4k[idx];
                if (!have4k) {
                  var l = defList(p);
                  have4k = !!(l && entryIn(l, CFG.gear));
                }
                if (want !== null && want !== Number(CFG.gear) && have4k) {
                  post('block', 'blocked downgrade -> ' + want);
                  return;
                }
              }
            } catch (e) {}
            return orig(entry, cur);
          };
          p.__dypc4kGuard = 1;
          post('guard', 'changeDefinition guard installed');
        } catch (e) { post('err', 'guard: ' + e.message); }
      }

      function step() {
        tickCount++;
        if (!cached.length || tickCount % 3 === 0) cached = allPlayers();
        var ps = cached;
        var dump = [];
        ps.forEach(function (p, idx) {
          var cur = curDef(p);
          var c = p.config || {};
          var info = {
            i: idx, playing: !!p.isPlaying, cur: cur,
            auto: c.needAutoBitrate, sel: c.userSelectDefinition,
            gears: gearsOf(p)
          };
          dump.push(info);

          if (!info.playing) return;
          installGuard(p, idx);                     // 拦住降档调用
          // 1) 关掉自动码率（ABR 会按缓冲/带宽自己上下调档）
          try {
            if (c.needAutoBitrate !== false) {
              c.needAutoBitrate = false;
              c.autoBitrateOpts = { isPlayAutoDefi: false, isOpenAutoDefi: false };
              post('lock', 'needAutoBitrate=false, autoBitrateOpts=off');
            }
          } catch (e) {}
          // 1.5) 钉住编码族：4K 只存在于原来那一族里
          try {
            if (CFG.codec && c.codecType !== CFG.codec) {
              var prev = String(c.codecType);
              c.codecType = CFG.codec;
              if (!p.__dypc4kCodecLogged || Date.now() - p.__dypc4kCodecLogged > 5000) {
                p.__dypc4kCodecLogged = Date.now();
                post('codec', 'pin codecType=' + CFG.codec + ' was=' + prev);
              }
            }
          } catch (e) {}

          var list = defList(p);
          if (!list) return;
          var tgt = entryIn(list, CFG.gear);

          // 【v1.2】列表里没有目标档（4K）时，退而取"该列表里的最高档"。
          // 之前这块直接 return，导致"只有 2K 的视频"被客户端自己落在 720 上不动。
          var effTgt = tgt, effDef = CFG.gear;
          if (!effTgt) {
            var bestE = null;
            for (var bi = 0; bi < list.length; bi++) {
              var e2 = list[bi];
              if (!e2 || e2.isBackup || e2.definition == null) continue;
              var d2 = Number(e2.definition);
              if (isNaN(d2)) continue;
              if (!bestE || d2 < Number(bestE.definition)) bestE = e2;
            }
            if (bestE) { effTgt = bestE; effDef = Number(bestE.definition); }
          }

          if (tgt) {
            good4k[idx] = tgt;                          // 见到就缓存一份
            if (c.codecType !== undefined || c.initCodecType !== undefined) {
              goodCodec[idx] = { codecType: c.codecType, initCodecType: c.initCodecType };
            }
          }

          // 2) 列表被客户端整体重建、4K 项被抽走
          if (!tgt && good4k[idx]) {
            post('lost4k', 'client dropped 4K from list (FIGHT=' + FIGHT + ')');
            if (!FIGHT) return;                        // 不拉锯：交给客户端
            var n = reinjected[idx] || 0;
            if (n >= 8) return;
            reinjected[idx] = n + 1;
            try {
              var gc = goodCodec[idx];
              if (gc) {
                var prevCodec = String(c.codecType);
                if (gc.codecType !== undefined && c.codecType !== gc.codecType) {
                  c.codecType = gc.codecType;
                  post('codec', 'restore codecType=' + String(gc.codecType) + ' was=' + prevCodec);
                }
                if (gc.initCodecType !== undefined && c.initCodecType !== gc.initCodecType) {
                  c.initCodecType = gc.initCodecType;
                }
              }
              list.push(good4k[idx]);
              p.config.definition.list = list;
              post('reinject', 'list lost 4K -> re-inserted (#' + (n + 1) + ')');
              p.changeDefinition(good4k[idx], p.curDefinition);
            } catch (e) { post('err', 'reinject: ' + e.message); }
            return;
          }

          // 画质日志：每条视频进来时记一次，4 秒后再记一次"最终结果"
          try {
            var quri = String((list[0] && list[0].uri) || '');
            if (quri) {
              QLOG_SEEN = QLOG_SEEN || {};
              var qkey = quri;
              var bestDefNow = 99;
              for (var qi = 0; qi < list.length; qi++) {
                var qd = Number(list[qi] && list[qi].definition);
                if (!isNaN(qd) && qd < bestDefNow) bestDefNow = qd;
              }
              var vEl = null;
              try {
                var vs2 = document.querySelectorAll('video');
                for (var vi2 = 0; vi2 < vs2.length; vi2++) {
                  if (!vs2[vi2].paused && vs2[vi2].videoHeight > 0) { vEl = vs2[vi2]; break; }
                }
              } catch (e8) {}
              var apiList = [];
              try {
                for (var lj = 0; lj < list.length && !apiList.length; lj++) {
                  var uj = String((list[lj] && list[lj].uri) || '');
                  if (!uj) continue;
                  var aj2 = URI2AID[uj];
                  if (aj2 && AID2GEARS[aj2] && AID2GEARS[aj2].length) apiList = AID2GEARS[aj2];
                  else if (GEARMAP[uj] && GEARMAP[uj].length) apiList = GEARMAP[uj];
                }
              } catch (e9) {}
              var apiBest = 99;
              for (var aj = 0; aj < apiList.length; aj++) {
                if (apiList[aj] && apiList[aj].def < apiBest) apiBest = apiList[aj].def;
              }
              var snap = {
                uri: quri.slice(-14),
                injected: (W.__dypc4kLastInject && (Date.now() - W.__dypc4kLastInject) < 6000) ? '是' : '否',
                apiCount: apiList.length,
                apiBest: apiBest === 99 ? null : apiBest,
                ladder: list.length,
                best: bestDefNow,
                cur: cur,
                sel: c.userSelectDefinition,
                h: vEl ? vEl.videoHeight : 0,
                w: vEl ? vEl.videoWidth : 0,
                auto: c.needAutoBitrate,
                codec: String(c.codecType || ''),
                gears: list.map(function (x) { return (x.definition) + '@' + Math.min(x.width || 0, x.height || 0) + (x.isH265 ? 'h5' : 'h4'); }).join(',')
              };
              if (!QLOG_SEEN[qkey]) {
                QLOG_SEEN[qkey] = 1;
                post('qlog', JSON.stringify({ phase: 'enter', s: snap }));
                (function (uriKey, snapRef) {
                  setTimeout(function () {
                    try {
                      var vs3 = document.querySelectorAll('video'), ve = null;
                      for (var k3 = 0; k3 < vs3.length; k3++) {
                        if (!vs3[k3].paused && vs3[k3].videoHeight > 0) { ve = vs3[k3]; break; }
                      }
                      snapRef.h = ve ? ve.videoHeight : 0;
                      snapRef.w = ve ? ve.videoWidth : 0;
                      snapRef.uri = uriKey;
                      post('qlog', JSON.stringify({ phase: 'final', s: snapRef }));
                    } catch (e9) {}
                  }, 4000);
                })(qkey.slice(-14), snap);
              }
            }
          } catch (e7) {}

          // 2.5) 播放器列表缺高档？用接口档位补进来，并把目标改成补进来的那一档
          try {
            var filled = fillMissing(list);
            if (filled !== null) {
              post('inject', 'added definition=' + filled + ' (uri=' + String((list[0] || {}).uri || '').slice(-16) + ')');
              effTgt = entryIn(list, filled);
              effDef = filled;
            }
          } catch (e5) {}

          // 3) 没在"该列表能给的最高档"上 —— 钉回去（目标可能是 4K，也可能是这条视频最高的 2K）
          if (!effTgt || Number(cur) === Number(effDef)) return;
          var vkey;
          try { vkey = (p.video && p.video.currentSrc) || ('i' + idx); } catch (e) { vkey = 'i' + idx; }
          vkey = vkey + '|' + effDef;
          reverts[vkey] = (reverts[vkey] || 0) + 1;
          if (reverts[vkey] > 5) { post('giveup', 'cur=' + cur + ' eff=' + effDef + ' reverts>5'); return; }
          post('revert', 'cur=' + cur + ' -> ' + effDef + (effDef === Number(CFG.gear) ? ' (4K)' : ' (该视频最高)') + ' #' + reverts[vkey]);
          try { p.changeDefinition(effTgt, p.curDefinition); } catch (e) { post('err', 'changeDefinition: ' + e.message); }
        });
        var sig = JSON.stringify(dump.map(function (d) { return [d.playing, d.cur, d.auto, d.gears]; }));
        if (sig !== lastSig) { lastSig = sig; post('state', JSON.stringify(dump)); }
      }

      // 等页面把播放器建起来；期间不断尝试 webpack 注册表 + window/DOM 扫描
      var bootTries = 0;
      function boot() {
        bootTries++;
        var gotReq = grabRequire();
        if (gotReq) scanRegs();
        var ps = allPlayers();
        if (bootTries <= 3 || ps.length) {
          post('diag', JSON.stringify({
            try: bootTries, webpack: !!gotReq,
            modules: gotReq ? Object.keys(req.c || {}).length : 0,
            regs: regs.length, players: ps.length,
            href: String(location.href).slice(0, 70),
            rs: document.readyState,
            keys: (function () { try { return Object.keys(W).length; } catch (e) { return -1; } })()
          }));
        }
        if (ps.length || bootTries >= 40) {
          post('ok', 'players=' + ps.length);
          setInterval(step, 800);
          step();
          // 视频一开播就立刻补一次（__dypc4kFastStep），把"先 540 后 4K"的窗口压到最小
          try {
            var fast = function () { setTimeout(step, 30); setTimeout(step, 200); setTimeout(step, 600); };
            document.addEventListener('playing', fast, true);
            document.addEventListener('loadedmetadata', fast, true);
            document.addEventListener('canplay', fast, true);
          } catch (e) {}
          return;
        }
        setTimeout(boot, 500);
      }
      boot();
    };

    try {
      var electron = require('electron');
      var lockSrc = '(' + LOCK_FN.toString() + ')(' +
        JSON.stringify({ gear: p.gearType, clarity: p.gearClarity, fight: !!FIGHT, codec: LOCK_CODEC, refuse: REFUSE, abPatch: !!AB_PATCH }) + ');';
      electron.webFrame.executeJavaScript(lockSrc).catch(function () {});
    } catch (e) {}

    // ---------- 主世界：右键菜单加「视频详情」 ----------
    // 右键菜单是网页层画的（routes-route 里的 onContextMenu），所以：
    //   1) 监听 contextmenu，等菜单 DOM 出现后，往里面插一项「视频详情」；
    //   2) 点击后弹出面板，显示分辨率/码率/帧率/编码/挡位等（数据直接读播放器实例 + <video> 元素）。
    var INFO_FN = function () {
      var W = window;
      if (W.__dypc4kInfo) return;
      W.__dypc4kInfo = 1;

      function log(m) { try { W.postMessage({ __dypc4k: 4, kind: 'info', data: String(m) }, '*'); } catch (e) {} }

      // ---- 播放器实例（与 quality lock 同样的发现方式）----
      function findPlayers() {
        var out = [];
        try {
          var keys = Object.keys(W);
          for (var i = 0; i < keys.length && i < 4000; i++) {
            var k = keys[i];
            if (/webpack|performance|chrome|webkit/i.test(k)) continue;
            try {
              var v = W[k];
              if (v && typeof v === 'object' && typeof v.changeDefinition === 'function' && v.config) out.push(v);
            } catch (e) {}
          }
        } catch (e) {}
        try {
          var els = document.querySelectorAll('[class*="xgplayer"]');
          for (var j = 0; j < els.length && j < 120; j++) {
            var el = els[j], ek;
            try { ek = Object.getOwnPropertyNames(el); } catch (e) { ek = []; }
            for (var m = 0; m < ek.length; m++) {
              try {
                var o = el[ek[m]];
                if (o && typeof o === 'object' && typeof o.changeDefinition === 'function' && o.config) out.push(o);
              } catch (e) {}
            }
          }
        } catch (e) {}
        var uniq = [];
        for (var n = 0; n < out.length; n++) if (uniq.indexOf(out[n]) < 0) uniq.push(out[n]);
        return uniq;
      }

      function activeVideo() {
        var vs = [].slice.call(document.querySelectorAll('video'));
        for (var i = 0; i < vs.length; i++) if (!vs[i].paused && vs[i].videoWidth) return vs[i];
        for (var j = 0; j < vs.length; j++) if (vs[j].videoWidth) return vs[j];
        return vs[0] || null;
      }

      function fmtRate(bps) {
        if (!bps || isNaN(bps)) return '-';
        bps = Number(bps);
        if (bps > 1e6) return (bps / 1e6).toFixed(2) + ' Mbps';
        if (bps > 1e3) return (bps / 1e3).toFixed(0) + ' kbps';
        return bps + ' bps';
      }

      function collect() {
        var info = { ok: false, rows: [] };
        var add = function (k, v) { info.rows.push([k, v]); };

        var v = activeVideo();
        var players = findPlayers();
        var p = players[0] || null;
        var cur = p && p.curDefinition ? p.curDefinition : null;

        if (v) {
          info.ok = true;
          add('视频分辨率', (v.videoWidth || '?') + ' × ' + (v.videoHeight || '?'));
        }
        if (cur) {
          if (cur.width && cur.height) add('码流分辨率', cur.width + ' × ' + cur.height);
          if (cur.gearName) add('清晰度挡位', cur.gearName + (cur.definition !== undefined ? '  (definition ' + cur.definition + ')' : ''));
          add('视频码率', fmtRate(cur.realBitrate || cur.bitrate));
          if (cur.fps) add('帧率', cur.fps + ' fps');
          if (cur.codecType || cur.vtype) add('编码', [cur.codecType, cur.vtype].filter(Boolean).join(' / '));
          if (cur.size) add('文件大小', (Number(cur.size) / 1048576).toFixed(2) + ' MB');
        }
        // 音频（DASH 时音频是独立条目）
        try {
          var list = (p && p.config && p.config.definition && p.config.definition.list) || [];
          var a = null;
          for (var i = 0; i < list.length; i++) if (list[i] && (list[i].mediaType === 'audio' || (list[i].codecType && /audio/i.test(String(list[i].mediaType || ''))))) { a = list[i]; break; }
          if (a) {
            add('音频码率', fmtRate(a.realBitrate || a.bitrate));
            if (a.codecType) add('音频编码', a.codecType);
          }
          if (list.length) add('可选挡位', list.map(function (x) { return (x.gearName || '?') + '@' + x.definition; }).join('  '));
        } catch (e) {}
        // 实时统计
        if (v) {
          try {
            var q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
            if (q) {
              add('已解码帧', q.totalVideoFrames);
              if (q.droppedVideoFrames) add('丢帧', q.droppedVideoFrames);
            }
            if (v.buffered && v.buffered.length) {
              var ahead = v.buffered.end(v.buffered.length - 1) - v.currentTime;
              add('缓冲余量', Math.max(0, ahead).toFixed(1) + ' s');
            }
            add('播放进度', (v.currentTime || 0).toFixed(1) + ' / ' + (isFinite(v.duration) ? v.duration.toFixed(1) : '?') + ' s');
            if (v.videoWidth && v.currentTime > 0) {
              try {
                var br = 0, set = window.performance && performance.getEntriesByType ? performance.getEntriesByType('resource') : [];
                for (var r = 0; r < set.length; r++) {
                  var u = set[r].name || '';
                  if (/douyinvod|bytecdn|tos-cn|video\//i.test(u)) br += set[r].transferSize || 0;
                }
                if (br > 0) add('累计下载(媒体)', (br / 1048576).toFixed(1) + ' MB');
              } catch (e) {}
            }
          } catch (e) {}
        }
        // 实时帧率测量（requestVideoFrameCallback）
        info.measureFps = function (cb) {
          if (!v || !v.requestVideoFrameCallback) { cb(null); return; }
          var n = 0, t0 = 0;
          var step = function (now) {
            if (!t0) t0 = now;
            n++;
            if (now - t0 >= 1000) { cb((n * 1000 / (now - t0)).toFixed(1)); return; }
            v.requestVideoFrameCallback(step);
          };
          try { v.requestVideoFrameCallback(step); } catch (e) { cb(null); }
        };
        return info;
      }

      // ---- 常驻实时面板：跟着当前视频自动刷新，切换视频自动换数据 ----
      var panel = null, rowsEl = null, headEl = null, timer = null;
      var fpsState = { v: null, n: 0, t0: 0, fps: null };
      var bwState = { bytes: 0, t: 0, mbps: null, total: 0 };
      var lastVideoKey = '';

      function mediaBytes() {
        var s = 0;
        try {
          var arr = performance.getEntriesByType('resource');
          for (var i = 0; i < arr.length; i++) {
            var n = arr[i].name || '';
            if (/douyinvod|bytecdn|tos-cn|video\/tos|mime_type=video|mime_type=audio/i.test(n)) s += arr[i].transferSize || 0;
          }
        } catch (e) {}
        return s;
      }

      // 持续测帧率（每帧回调，滚动 1 秒窗口）
      function watchFps(v) {
        if (!v) return;
        if (fpsState.v === v) return;
        fpsState = { v: v, n: 0, t0: 0, fps: null };
        if (!v.requestVideoFrameCallback) return;
        var step = function (now) {
          if (fpsState.v !== v) return;
          if (!v.paused) {
            if (!fpsState.t0) fpsState.t0 = now;
            fpsState.n++;
            if (now - fpsState.t0 >= 1000) {
              fpsState.fps = (fpsState.n * 1000 / (now - fpsState.t0)).toFixed(1);
              fpsState.n = 0; fpsState.t0 = now;
            }
          }
          try { v.requestVideoFrameCallback(step); } catch (e) {}
        };
        try { v.requestVideoFrameCallback(step); } catch (e) {}
      }

      function buildPanel() {
        panel = document.createElement('div');
        panel.style.cssText = 'position:fixed;z-index:2147483647;right:20px;top:70px;width:330px;' +
          'background:rgba(18,18,20,.95);color:#e9e9ea;border:1px solid #35353b;border-radius:10px;' +
          'box-shadow:0 10px 30px rgba(0,0,0,.6);font:12px/1.65 -apple-system,"Microsoft YaHei",sans-serif;' +
          'padding:10px 12px;user-select:text;';
        headEl = document.createElement('div');
        headEl.style.cssText = 'font-weight:600;font-size:12.5px;color:#fff;margin-bottom:6px;display:flex;align-items:center;gap:8px;';
        rowsEl = document.createElement('div');
        panel.appendChild(headEl);
        panel.appendChild(rowsEl);
        document.body.appendChild(panel);
        // 拖动
        var drag = false, dx = 0, dy = 0;
        headEl.style.cursor = 'move';
        headEl.addEventListener('mousedown', function (ev) {
          drag = true;
          var r = panel.getBoundingClientRect();
          dx = ev.clientX - r.left; dy = ev.clientY - r.top;
          ev.preventDefault();
        });
        document.addEventListener('mousemove', function (ev) {
          if (!drag) return;
          panel.style.right = 'auto'; panel.style.left = (ev.clientX - dx) + 'px';
          panel.style.top = (ev.clientY - dy) + 'px';
        }, true);
        document.addEventListener('mouseup', function () { drag = false; }, true);
      }

      function renderLive() {
        if (!panel || !panel.parentNode) return;
        var info = collect();
        var v = activeVideo();
        var players = findPlayers();
        var p = players[0] || null;
        if (v) {
          for (var i = 0; i < players.length; i++) {
            var pp = players[i];
            try {
              if (pp.video === v || (pp.root && pp.root.contains && pp.root.contains(v))) { p = pp; break; }
            } catch (e) {}
          }
          watchFps(v);
        }

        // 实时带宽：两次采样差
        var now = performance.now();
        var b = mediaBytes();
        if (bwState.t) {
          var dt = (now - bwState.t) / 1000;
          if (dt > 0.1 && b >= bwState.bytes) bwState.mbps = ((b - bwState.bytes) * 8 / dt / 1e6).toFixed(2);
        }
        bwState.bytes = b; bwState.t = now; bwState.total = b;

        // 视频标识（切换视频时能看到变化）
        var key = '';
        try {
          key = (v && (v.currentSrc || '').slice(-40)) || '';
        } catch (e) {}
        var switched = (key !== lastVideoKey);
        lastVideoKey = key;

        var cur = p && p.curDefinition ? p.curDefinition : null;
        var rows = [];
        var add = function (k, val, color) { rows.push([k, val, color]); };

        add('分辨率', v && v.videoWidth ? (v.videoWidth + ' × ' + v.videoHeight) : '-');
        if (cur && cur.width && cur.height) add('码流分辨率', cur.width + ' × ' + cur.height);
        if (cur && cur.gearName) add('清晰度', cur.gearName + (cur.definition !== undefined ? '  @' + cur.definition : ''));
        add('视频码率(声明)', fmtRate(cur && (cur.realBitrate || cur.bitrate)));
        add('实测码率(实时)', bwState.mbps ? (bwState.mbps + ' Mbps') : '测量中…', '#7ee787');
        add('实测帧率(实时)', fpsState.fps ? (fpsState.fps + ' fps') : '测量中…', '#7ee787');
        if (cur && cur.fps) add('标称帧率', cur.fps + ' fps');
        if (cur && (cur.codecType || cur.vtype)) add('编码', [cur.codecType, cur.vtype].filter(Boolean).join(' / '));
        try {
          var list = (p && p.config && p.config.definition && p.config.definition.list) || [];
          var a = null;
          for (var q = 0; q < list.length; q++) if (list[q] && String(list[q].mediaType) === 'audio') { a = list[q]; break; }
          if (a) {
            add('音频码率', fmtRate(a.realBitrate || a.bitrate));
            if (a.codecType) add('音频编码', a.codecType);
          }
          if (list.length) add('可选挡位', list.map(function (x) { return (x.gearName || '?') + '@' + x.definition; }).join('  '));
        } catch (e) {}
        if (v) {
          try {
            var pbq = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
            if (pbq) add('已解码帧 / 丢帧', pbq.totalVideoFrames + ' / ' + (pbq.droppedVideoFrames || 0));
            if (v.buffered && v.buffered.length) {
              add('缓冲余量', Math.max(0, v.buffered.end(v.buffered.length - 1) - v.currentTime).toFixed(1) + ' s');
            }
            add('播放进度', (v.currentTime || 0).toFixed(1) + ' / ' + (isFinite(v.duration) ? v.duration.toFixed(1) : '?') + ' s');
            add('暂停', v.paused ? '是' : '否');
          } catch (e) {}
        }
        add('累计下载(媒体)', (bwState.total / 1048576).toFixed(1) + ' MB');

        // 渲染
        var h = '<span style="color:#7ee787">● 实时</span>' +
          '<span style="color:#8a8f98;font-weight:400">' + (switched ? '已切换视频' : '') + '</span>' +
          '<span style="margin-left:auto;cursor:pointer;color:#9aa" id="dypc4k-x">✕</span>';
        headEl.innerHTML = h;
        var el = headEl.querySelector('#dypc4k-x');
        if (el) el.onclick = closePanel;

        var html = '';
        for (var i = 0; i < rows.length; i++) {
          var r = rows[i];
          html += '<div style="display:flex;gap:8px"><span style="color:#8a8f98;flex:0 0 92px">' + r[0] +
            '</span><span style="color:' + (r[2] || '#e9e9ea') + ';word-break:break-all">' + String(r[1]) + '</span></div>';
        }
        if (!v) html = '<div style="color:#f88">没找到正在播放的视频</div>' + html;
        rowsEl.innerHTML = html;
      }

      function closePanel() {
        if (timer) { clearInterval(timer); timer = null; }
        if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
        panel = null;
      }

      function showPanel() {
        if (panel && panel.parentNode) { renderLive(); return; }
        buildPanel();
        renderLive();
        timer = setInterval(renderLive, 700);
        log('live panel opened');
      }
      W.__dypc4kShowInfo = showPanel;
      W.__dypc4kCloseInfo = closePanel;

      // ---- 往右键菜单里插一项（更稳的定位 + 兜底快捷键 Alt+I）----
      // 你机器上右键菜单里已知的条目：清屏 / 评论 / 赞 / 进入作者主页 / 推荐朋友 / 分享 /
      // 不感兴趣 / 举报或反馈 / 举报 / 独立窗口显示 / 进入详情页
      var LABELS = ['清屏', '评论', '赞', '进入作者主页', '推荐朋友', '分享', '不感兴趣', '举报', '独立窗口', '进入详情页'];
      var injectedTo = null;

      function scoreMenu(el) {
        var txt = (el.innerText || '');
        if (!txt || txt.length > 500) return 0;
        var hits = 0;
        for (var i = 0; i < LABELS.length; i++) if (txt.indexOf(LABELS[i]) >= 0) hits++;
        if (hits < 3) return 0;
        var r = el.getBoundingClientRect();
        if (!r || r.width < 60 || r.width > 520 || r.height < 60 || r.height > 900) return 0;
        return hits;
      }

      function findMenu() {
        var best = null, bestScore = 0;
        var all = document.querySelectorAll('div,ul,section');
        for (var i = 0; i < all.length; i++) {
          var el = all[i];
          var s = scoreMenu(el);
          if (s > bestScore) { bestScore = s; best = el; }
        }
        // 从命中的最大容器里，挑出"只包含菜单项"的最小那个子容器
        if (best) {
          var kids = best.querySelectorAll('div,ul');
          for (var j = 0; j < kids.length; j++) {
            var s2 = scoreMenu(kids[j]);
            if (s2 >= bestScore) { best = kids[j]; bestScore = s2; }
          }
        }
        return best;
      }

      function injectMenuItem(round) {
        try {
          var cand = findMenu();
          if (!cand) { if (round === 9) log('menu not found after retries'); return; }
          if (cand.querySelector('[data-dypc4k-info]')) return;
          var item = document.createElement('div');
          item.setAttribute('data-dypc4k-info', '1');
          item.textContent = '视频详情（码率 / 分辨率 / 帧率）';
          item.style.cssText = 'padding:4px 14px;cursor:pointer;font-size:12px;line-height:22px;color:#eaeaea;' +
            'border-top:1px solid rgba(255,255,255,.10);margin-top:3px;white-space:nowrap;';
          item.onmouseenter = function () { item.style.background = 'rgba(255,255,255,.10)'; };
          item.onmouseleave = function () { item.style.background = 'transparent'; };
          item.onclick = function (ev) { ev.stopPropagation(); ev.preventDefault(); showPanel(); };
          cand.appendChild(item);
          injectedTo = cand;
          log('menu item injected into ' + cand.tagName + '.' + String(cand.className).slice(0, 40));
        } catch (e) { log('inject err: ' + e.message); }
      }

      document.addEventListener('contextmenu', function () {
        // 菜单是异步渲染的，密一点重试
        for (var i = 0; i < 10; i++) (function (n) { setTimeout(function () { injectMenuItem(n); }, 40 * n + 40); })(i);
      }, true);

      // 兜底：Alt+I 直接开面板（菜单插不进去时也能用）
      document.addEventListener('keydown', function (ev) {
        if (ev.altKey && (ev.key === 'i' || ev.key === 'I')) { ev.preventDefault(); showPanel(); }
      }, true);

      log('info hook installed (菜单注入 + Alt+I 兜底)');
    };

    try {
      var electron2 = require('electron');
      electron2.webFrame.executeJavaScript('(' + INFO_FN.toString() + ')();').catch(function () {});
    } catch (e) {}

    // 主世界回报 -> 落盘，便于排查
    try {
      var fsl = require('fs'), pl = require('path');
      var lockLog = pl.join(process.env.APPDATA + '\\douyin', 'dypc4k-lock.log');
      window.addEventListener('message', function (ev) {
        var d = ev && ev.data;
        if (!d || (d.__dypc4k !== 3 && d.__dypc4k !== 4)) return;
        try {
          var size = 0;
          try { size = fsl.statSync(lockLog).size; } catch (e) {}
          if (size > 512 * 1024) fsl.truncateSync(lockLog, 0);
          if (d.kind === 'qlog') {
            // 画质日志：独立文件，便于事后排查"刷着刷着变糊"
            try {
              var qf = pl.join(process.env.APPDATA + '\\douyin', 'dypc4k-quality.log');
              var qs = 0;
              try { qs = fsl.statSync(qf).size; } catch (e) {}
              if (qs > 2 * 1024 * 1024) fsl.truncateSync(qf, 0);
              var o = JSON.parse(d.data);
              var s2 = o.s || {};
              var defName = function (d2) {
                return d2 === -2 ? '4K' : d2 === -1 ? '2K' : d2 === 1 ? '1080' : d2 === 2 ? '720' : d2 === 3 ? '540' : String(d2);
              };
              var line = new Date().toLocaleString('zh-CN') + '\t[' + o.phase + ']' +
                '\t实际=' + (s2.w + 'x' + s2.h) +
                '\t清晰度档=' + defName(s2.cur) +
                '\t选中=' + defName(s2.sel) +
                '\t表内最高=' + defName(s2.best) + '(' + s2.ladder + '档)' +
                '\t注入=' + (s2.injected || '否') +
                '\t接口给到=' + (s2.apiBest == null ? '无记录' : defName(s2.apiBest) + '(' + s2.apiCount + '档)') +
                '\t编码=' + s2.codec +
                '\tauto=' + s2.auto +
                '\turi=' + s2.uri +
                '\t档位表=' + String(s2.gears || '').slice(0, 120) + '\n';
              fsl.appendFileSync(qf, line);
              return;
            } catch (e) {}
          }
          fsl.appendFileSync(lockLog,
            new Date().toISOString().slice(11, 23) + '\t' + d.kind + '\t' +
            (typeof d.data === 'string' ? d.data : JSON.stringify(d.data)) + '\n');
        } catch (e) {}
      }, false);
    } catch (e) {}
  } catch (e) {}
})();
/* ==== dypc4k end ==== */
