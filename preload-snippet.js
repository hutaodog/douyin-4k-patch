/* ==== dypc4k begin ==== */
/* dypc4k v1.5 —— 变更（核心：真正把视频换到最高档，MSE 也能换）：
 *   1) 换源改成"硬换"：清掉 <source> 子元素 -> media.src = 目标档 mp4 直链 -> 恢复播放进度。
 *      原因（反编译 + 实测）：xgplayer 的 src setter 在 MSE 媒体上直接 return，
 *      changeDefinition 走 switchURL 时 Promise 没有 .catch，失败完全静默；
 *      seamlessSwitch 在播放器实例/原型上根本不存在。原方案因此一直"看起来切了、其实没换流"。
 *   2) 修 fillMissing 误判：我们合成补进去的高档条目会残留在播放器档位表里，
 *      下条视频就被误判成"表内已有 4K"-> 不补、不换流。合成条目加 __dypc4kSynth 标记并全部跳过。
 *   3) 换源静默期：硬换后有 6 秒不算"没到位"，避免连续 revert 把重试次数打满。
 *   4) 清晰度标签：改为直接改 DOM（.gear .item.selected 的 span + .gear .btnV2）。
 *      之前走 player.curDefinition 重算，但控件隐藏时尺寸为 0，旧过滤条件永远抓不到。
 *   5) 去掉切流探针（已完成取证使命）。
 *   实测：批量 10~16 条，全部达到接口给到的最高分辨率（含多例 3840x2160 / 2160x3840）。
 *   ---- 以下为 v1.3 ----
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
    var REFUSE = 'none';
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
            __dypc4kSynth: 1,
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
          // 当前列表里最好的档位（只看客户端自己的条目，不算我们补进去的）
          var bestDef = 99;
          for (var i = 0; i < list.length; i++) {
            if (list[i] && list[i].__dypc4kSynth) continue;
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
          // 已经有这一档（哪怕是上一轮补进去的）就别再补 —— 否则 step() 每秒一跑、
          // 每跑必补，list 里堆满重复条目，日志也会被 inject 刷屏。
          var dup = false;
          for (var di = 0; di < list.length; di++) {
            if (list[di] && Number(list[di].definition) === Number(best.def)) { dup = true; break; }
          }
          if (dup) return null;
          list.push(entry);
          W.__dypc4kLastInject = Date.now();
          return best.def;
        } catch (e) { return null; }
      }
      window.__dypc4kFill = fillMissing;

// ============ 自检：确认 fetch 钩子不再抛 ReferenceError ============
      // 背景：v1.3 引用了从未定义的 VID_URL，非 AB 的 fetch 一律 ReferenceError，
      // 结果搜索和分享全挂（视频走 XHR 所以没事）。这里用**被钩过的那个 fetch**
      // 实打实请求一次搜索接口，把结果写进日志，不依赖人工点页面。
      (function fetchSelfTest() {
        function run(tag, url) {
          try {
            var f = window.fetch;
            if (typeof f !== 'function') { post('selftest', tag + ' no-fetch'); return; }
            f(url, { credentials: 'include' }).then(function (res) {
              return res.text().then(function (t) {
                post('selftest', tag + ' OK status=' + res.status + ' bytes=' + t.length + ' url=' + String(res.url || '').slice(0, 60));
              });
            }).catch(function (e) {
              post('selftest', tag + ' FAIL ' + (e && e.message ? e.message : e));
            });
          } catch (e) {
            post('selftest', tag + ' THROW ' + (e && e.message ? e.message : e));
          }
        }
        setTimeout(function () {
          run('search', '/aweme/v1/web/search/item/?keyword=%E7%8C%AB&count=1');
          run('detail', '/aweme/v1/web/aweme/detail/');
        }, 6000);
      })();

      var W = window, TAG = '__dypc4kLock';
      if (W[TAG]) return;
      W[TAG] = 1;
      function post(kind, data) {
        // 【坑】这里不能用 W.postMessage —— 本 IIFE 里的同步逻辑（fetchSelfTest 等）在
        // `var W = window` 之前就会调 post，函数提升让 post 可调用但 W 是 undefined，
        // 异常又被 catch 吞掉，于是早期的日志（linit 等）全部静默丢失。直接用 window。
        try { window.postMessage({ __dypc4k: 3, kind: kind, data: data }, '*'); } catch (e) {}
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
          // 【v1.4 bugfix】v1.3 把档位采集挂到"所有视频响应"时引用了 VID_URL，
          // 却忘了定义它 —— 非 AB 的 fetch 走到 `!VID_URL.test(url)` 就抛 ReferenceError，
          // 于是搜索、分享等所有走 fetch 的请求全部失败（视频走 XHR，所以播放正常）。
          // 这里补上定义，并且**只在真的要处理时才碰响应体**。
          var VID_URL = /\/aweme\/|\/user\/|\/comment\/|\/search\/|\/mix\/|\/music\/|bit_rate/i;
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
              var isAB = false, isVid = false;
              try { isAB = AB_URL.test(url); isVid = !isAB && VID_URL.test(url); } catch (e) { return p; }
              if (!isAB && !isVid) return p;                 // 与补丁无关的请求：一根手指都不碰
              return p.then(function (res) {
                // 用 clone 读，原始 res 保持未消费 —— 万一不需要改写就原样返回，
                // 保住 res.url / headers / type（v1.3 里一律重建 Response 是隐患）
                var rc;
                try { rc = res.clone(); } catch (e) { return res; }
                return rc.text().then(function (txt) {
                  var maybeGear = txt.indexOf('bit_rate') >= 0;
                  if (!isAB && !maybeGear) return res;
                  var j = null;
                  try { j = JSON.parse(txt); } catch (e) {}
                  if (!j) return res;
                  try { if (maybeGear) captureGears(j); } catch (e6) {}
                  var n = 0;
                  try { if (isAB) n = patchABObj(j, 0); } catch (e8) {}
                  if (isAB) { stat.fetch++; if (n) { stat.changed += n; post('abpatch', 'fetch ' + url.slice(0, 60) + ' changed=' + n + ' [' + stat.keys.join(',') + ']'); } }
                  if (!n) return res;                          // 没改动过：返回原响应
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
      // 【v1.5 关键】只保留客户端自己的条目（滤掉我们 synth 进去的）。
      // 不滤的话：上一轮补进去的 4K 会一直躺在这份 list 里，于是"这条视频本来就有 4K"
      // 这个判断会被前一条视频的残留污染 —— 批量测试里 22 条有 15 条报
      // best=-2 ladderBest=-2（接口明明有 4K）就是这么来的。
      function realList(p) {
        var l = defList(p);
        if (!l) return null;
        var out = [];
        for (var i = 0; i < l.length; i++) if (l[i] && !l[i].__dypc4kSynth) out.push(l[i]);
        return out;
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

      // ============ 真正换源（v1.4 核心修复）============
      // 反编译结论：xgplayer.changeDefinition -> switchURL(entry.url)
      //   src setter: "Array"===typeOf ? _attachSourceEvents : this.media.src = e
      //   _attachSourceEvents 先 removeAttribute("src")+load()，之后才 appendChild(<source>)，
      //   canplay 早在 3ms 内就对着旧流触发 -> Promise resolve 但流没换。
      // 所以：把 entry.url 归一成字符串，走 media.src 那条真正换流的路。
      // 另一个坑：<source> 子元素存在时浏览器会忽略 media.src（HTML 规范），必须先清干净。
      // 【v1.5 bugfix】实测出现过 entry.url === 5（数字）导致 forceChange 把 media.src
      // 设成 "5" 的情况：换流静默失败，而 <video> 还停在旧流上，看起来像"钉了没反应"。
      // 所以这里改成：把所有可能的取址位置都试一遍，并且只接受 http(s) 开头的串。
      function httpish(s) {
        if (typeof s !== 'string') return '';
        s = s.replace(/^\s+|\s+$/g, '');
        if (!/^https?:\/\//i.test(s)) return '';
        return s;
      }
      function pickUrl(v) {
        if (!v) return '';
        if (typeof v === 'string') return httpish(v);
        if (Array.isArray(v)) {
          for (var i = 0; i < v.length; i++) {
            var got = pickUrl(v[i]);
            if (got) return got;
          }
          return '';
        }
        if (typeof v === 'object') {
          var cand = [v.src, v.url, v.Src, v.Url, v.playUrl, v.play_url];
          for (var j = 0; j < cand.length; j++) {
            var g2 = pickUrl(cand[j]);
            if (g2) return g2;
          }
        }
        return '';
      }
      function urlOf(entry) {
        try {
          if (!entry) return '';
          var slots = [
            entry.url, entry.urlList, entry.url_list, entry.playUrl, entry.play_url,
            entry.playAddr, entry.play_addr
          ];
          for (var i = 0; i < slots.length; i++) {
            var s = pickUrl(slots[i]);
            if (s) return s;
            if (slots[i] && typeof slots[i] === 'object' && !Array.isArray(slots[i])) {
              var nested = pickUrl(slots[i].url_list || slots[i].urlList);
              if (nested) return nested;
            }
          }
          // 全都不是 http 串：记下真实形状，方便下次定位（只记一次，避免刷屏）
          try {
            W.__dypc4kBadUrl = W.__dypc4kBadUrl || {};
            var k = String(entry.definition);
            if (!W.__dypc4kBadUrl[k]) {
              W.__dypc4kBadUrl[k] = 1;
              post('badurl', 'def=' + k + ' urlType=' + Object.prototype.toString.call(entry.url) +
                   ' url=' + String(entry.url).slice(0, 60) +
                   ' keys=' + Object.keys(entry).join('/').slice(0, 160));
            }
          } catch (eB) {}
          return '';
        } catch (e) { return ''; }
      }

      function forceChange(p, entry, def) {
        try {
          var m = p.media || p.video;
          if (!m) { post('err', 'force: no media'); return false; }
          var url = urlOf(entry);
          if (!url) {
            post('err', 'force: no http url def=' + def + ' urlType=' + Object.prototype.toString.call(entry && entry.url));
            return false;
          }
          // 同一条视频短时间内只换一次。换源后 currentSrc 变空/变新，step() 的防抖 key 会失效，
          // 而 step() 会被 30/200/600ms 的 FastStep 和多播放器实例重复触发 —— 不节流就会
          // 连续 reset 同一个 <video>，表现是分辨率迟迟不上去。
          // 计时挂在 media 元素上（不是播放器上）：多个播放器实例可能共用同一个 <video>。
          var lastAt = m.__dypc4kForceAt || 0;
          var lastIn = m.__dypc4kForceSrc || '';
          var cooldown = lastIn === url ? 8000 : 2500;
          if (lastAt && (Date.now() - lastAt) < cooldown) {
            post('force', 'skip def=' + def + ' (cooldown ' + (Date.now() - lastAt) + 'ms src=' + (lastIn === url ? 'same' : 'diff') + ')');
            return true;
          }
          m.__dypc4kForceAt = Date.now();
          m.__dypc4kForceSrc = url;
          var mse = false;
          try { mse = /^blob/.test(String(m.currentSrc || m.src || '')); } catch (e0) {}
          // 【v1.5 结论】MSE 播放器上 xgplayer 的 src setter 命中 isMSE 分支会直接 return，
          // changeDefinition 也走不到真正换流；seamlessSwitch 在实例/原型上不存在（探针 hasSeamless=undefined）。
          // 实测唯一可靠的路：清掉 <source> 子元素，把 media.src 直接指到目标档 mp4 直链，
          // 让 <video> 从 blob(MSE) 退回渐进式播放。576x1024(blob) -> 3840x2160 已实测通过。
          var before = (m.videoWidth || 0) + 'x' + (m.videoHeight || 0);
          var keepAt = 0, wasPlaying = false;
          try { keepAt = m.currentTime || 0; wasPlaying = !m.paused && !m.ended; } catch (e5) {}
          var removed = 0;
          try {
            var kids = m.querySelectorAll('source');
            for (var i = kids.length - 1; i >= 0; i--) { kids[i].parentNode.removeChild(kids[i]); removed++; }
          } catch (e2) {}
          try { m.pause(); } catch (e4) {}
          // 静默期：换源后 <video> 会短暂回到 0x0 / readyState=0，
          // 这段时间内 step() 不要判定"没到位"，否则会连续 revert + 打满 giveup。
          try { m.__dypc4kForcePendingUntil = Date.now() + 6000; } catch (e4b) {}
          try { m.setAttribute('src', url); m.load(); } catch (e2b) { post('err', 'hardSet: ' + e2b.message); return false; }
          if (keepAt > 0.35) {
            try {
              m.addEventListener('loadedmetadata', function once() {
                m.removeEventListener('loadedmetadata', once);
                try { if (Math.abs(m.currentTime - keepAt) > 0.3) m.currentTime = keepAt; } catch (e6) {}
              });
            } catch (e7) {}
          }
          try { var pr = m.play(); if (pr && pr.catch) pr.catch(function () {}); } catch (e3) {}
          post('force', (mse ? 'MSE->mp4 ' : '') + 'def=' + def + ' src=<' + url.length + 'B ' + url.slice(0, 46) + '> before=' + before + ' removedSource=' + removed + ' keep=' + keepAt.toFixed(1) + 's');
          (function (mm, dd, bb, pp, ee) {
            setTimeout(function () {
              try {
                post('force', 'after1.5s def=' + dd + ' now=' + (mm.videoWidth || 0) + 'x' + (mm.videoHeight || 0) + ' was=' + bb + ' rs=' + mm.readyState);
                // 换流真正落地后再同步标签（太早同步会被客户端按旧流改回去）
                if ((mm.videoHeight || 0) > 0) syncLabel(pp, ee, dd);
              } catch (e) {}
            }, 1500);
          })(m, def, before, p, entry);
          return true;
        } catch (e) { post('err', 'force: ' + e.message); return false; }
      }
      window.__dypc4kForce = forceChange;

      // ============ 让客户端自己的清晰度标签跟上真实画质 ============
      // 反编译结论（网页 bundle 47733.1859c7e9.js 的 PlayClaritySettingPlugin + 73544.00e6003e.js）：
      //   标签文案**不是读 DOM**，是 React 从 player.curDefinition.definition 现算的：
      //     档位映射 EA = {HD4K:-2, HD2K:-1, Hd:1, Clear:2, Smooth:3, Fast:4, Auto:0}
      //     文案表   cJ = {HD4K:'超清 4K', HD2K:'超清 2K', Hd:'高清 1080P', Clear:'高清 720P',
      //                   Smooth:'标清 540P', Fast:'极速', Auto:'智能'}
      //   重算靠 player.on('UpdateSyncText') 的回调 k()，切换状态靠 player.on('change_bitrate_success')。
      //   -> forceChange 直接换流绕过了 changeDefinition，curDefinition 没更新，标签就永远停在旧值。
      //      这也是之前 labelFix 改 DOM 一直改不动的真因（该元素根本不是文字节点驱动的）。
      // 做法：换流到位后把 curDefinition 写回目标档，再让客户端自己重算标签。不改 DOM。
      var LABEL_MAP = { '-2': '超清 4K', '-1': '超清 2K', '1': '高清 1080P', '2': '高清 720P', '3': '标清 540P', '4': '极速', '0': '智能' };
      function syncLabel(p, entry, def) {
        try {
          if (!p || !entry) return;
          var d = Number(def);
          if (isNaN(d)) return;
          var now = Date.now();
          var prevD = p.curDefinition ? Number(p.curDefinition.definition) : NaN;
          // 客户端 ABR 有可能把 curDefinition 改回去，所以同一个档位也要定期重钉一次
          if (prevD === d && (now - (p.__dypc4kLabelAt || 0)) < 4000) return;
          // 档位号以真实解码尺寸为准：接口经常把 1080 的源标成 4K，
          // 拿接口 def 直接写标签就会显示"超清 4K"而画面是 1080。
          var realDef = d;
          try {
            var mv = p.video || p.media;
            var rs = Math.min(mv.videoWidth || 0, mv.videoHeight || 0);
            if (rs > 0) realDef = tierDef(rs);
          } catch (eR) {}
          if (realDef !== d) {
            // 真实分辨率达不到目标档：沿用 entry 的形状，但把 definition 改对
            var fixed = {};
            for (var kk in entry) fixed[kk] = entry[kk];
            fixed.definition = realDef;
            entry = fixed;
            d = realDef;
          }
          p.curDefinition = entry;
          p.__dypc4kLabelAt = now;
          // 某些实例的档位组件读的是 BitrateSelector 插件的 curBitRate，顺手对齐
          try {
            var bs = p.getPlugin && p.getPlugin('bitrateselector');
            if (bs) {
              bs.curBitRate = {
                url: entry.url, definition: d, bitrate: entry.bitrate, type: 'normal',
                networkSpeed: (bs.curBitRate && bs.curBitRate.networkSpeed) || 0
              };
            }
          } catch (e1) {}
          try { p.emit('UpdateSyncText'); } catch (e2) {}
          try { p.emit('change_bitrate_success', d); } catch (e3) {}
          // 只在"档位真的变了"时打日志：step() 每 ~800ms 会重钉一次，
          // 每次都打会把 lock.log 刷满（实测同一条视频刷 60+ 行）。
          var sig = d + '@' + (p.video ? (p.video.videoWidth || 0) + 'x' + (p.video.videoHeight || 0) : '?');
          if (p.__dypc4kLabelSig !== sig) {
            p.__dypc4kLabelSig = sig;
            post('label', 'def=' + d + ' was=' + (isNaN(prevD) ? 'null' : prevD) +
                 ' text=' + (LABEL_MAP[String(d)] || '?') +
                 ' real=' + (p.video ? (p.video.videoWidth || 0) + 'x' + (p.video.videoHeight || 0) : '?'));
          }
        } catch (e) { try { post('err', 'syncLabel: ' + e.message); } catch (e9) {} }
      }
      window.__dypc4kLabel = syncLabel;

      // ============ 清晰度标签：DOM 层兜底 ============
      // 反编译+实测结论：标签控件其实一直在 DOM 里（只是宽高为 0、不可见），结构是
      //   <div class="gear ...">
      //     <div class="virtual">
      //       <div class="item selected"><div class="clarity-wrapper"><span>高清 1080P</span></div></div>
      //       <div class="item">高清 720P</div> ...
      //     </div>
      //     <div class="btn btnV2">高清 1080P</div>
      //   </div>
      // 之前用"只改可见元素"的过滤条件（getBoundingClientRect 宽高 > 8）永远抓不到，
      // 因为控件隐藏时尺寸恒为 0 —— 这就是 labelFix 一直不生效的真因。
      var DOM_LABEL_TXT = { '-2': '超清 4K', '-1': '超清 2K', '1': '高清 1080P', '2': '高清 720P', '3': '标清 540P', '4': '极速', '0': '智能' };
      function labelDom() {
        try {
          var ps = allPlayers(), best = null, bestA = -1;
          for (var i = 0; i < ps.length; i++) {
            var m = ps[i].media || ps[i].video;
            if (!m) continue;
            var w = m.videoWidth || 0, h = m.videoHeight || 0;
            var a = w * h;
            var pri = (!m.paused && a > 0) ? 1e12 : 0;
            if (pri + a > bestA) { bestA = pri + a; best = m; }
          }
          if (!best) return;
          var rs = Math.min(best.videoWidth || 0, best.videoHeight || 0);
          if (!rs) return;
          var want = DOM_LABEL_TXT[String(tierDef(rs))];
          if (!want) return;
          // 1) 悬浮菜单里的选中项
          var items = document.querySelectorAll('.gear .item');
          for (var j = 0; j < items.length; j++) {
            var it = items[j];
            if (!/(^|\s)selected(\s|$)/.test(String(it.className || ''))) continue;
            var sp = it.querySelector('.clarity-wrapper span') || it.querySelector('span');
            if (sp && (sp.textContent || '').trim() !== want) { sp.textContent = want; post('ldom', 'selected -> ' + want + ' real=' + rs); }
          }
          // 2) 控制栏上的按钮
          var btns = document.querySelectorAll('.gear .btnV2');
          for (var k = 0; k < btns.length; k++) {
            var b = btns[k];
            if ((b.textContent || '').trim() !== want) { b.textContent = want; post('ldom', 'btn -> ' + want + ' real=' + rs); }
          }
        } catch (e) {}
      }
      window.__dypc4kLabelDom = labelDom;

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

          // 诊断：每条视频首次见到时 dump 一次播放器真实结构
          try {
            if (info.playing && info.gears && info.gears.length) {
              var dk = info.gears.join(',') + '|' + cur;
              if (W.__dypc4kDiagOn && !DIAG2_SEEN[dk]) { DIAG2_SEEN[dk] = 1; setTimeout(diag2, 1200); }
            }
          } catch (e0) {}

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
              if (e2.__dypc4kSynth) continue;   // 别把上一轮补的档当成"这条视频本来就有"
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
              if (!forceChange(p, good4k[idx], Number(good4k[idx].definition))) {
                p.changeDefinition(good4k[idx], p.curDefinition);
              }
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
                if (list[qi] && list[qi].__dypc4kSynth) continue;
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
                      var vs3 = document.querySelectorAll('video'), ve = null, varea = -1;
                      for (var k3 = 0; k3 < vs3.length; k3++) {
                        var vv3 = vs3[k3];
                        var a3 = (vv3.videoWidth || 0) * (vv3.videoHeight || 0);
                        // 优先正在播的；否则取面积最大的那个（换源瞬间旧 <video> 会归零）
                        var pri3 = (!vv3.paused && a3 > 0) ? 1e12 : 0;
                        if (pri3 + a3 > varea) { varea = pri3 + a3; ve = vv3; }
                      }
                      var fw = ve ? ve.videoWidth : 0, fh = ve ? ve.videoHeight : 0;
                      if (!fw || !fh) {
                        // 还在加载：2 秒后再采一次，别把 0x0 当成结果
                        setTimeout(function () {
                          try {
                            var vs4 = document.querySelectorAll('video'), ve4 = null, a4 = -1;
                            for (var k4 = 0; k4 < vs4.length; k4++) {
                              var v4 = vs4[k4];
                              var ar4 = (v4.videoWidth || 0) * (v4.videoHeight || 0);
                              var p4 = (!v4.paused && ar4 > 0) ? 1e12 : 0;
                              if (p4 + ar4 > a4) { a4 = p4 + ar4; ve4 = v4; }
                            }
                            snapRef.h = ve4 ? ve4.videoHeight : 0;
                            snapRef.w = ve4 ? ve4.videoWidth : 0;
                            snapRef.uri = uriKey;
                            post('qlog', JSON.stringify({ phase: 'final', s: snapRef }));
                          } catch (e9b) {}
                        }, 2000);
                        return;
                      }
                      snapRef.h = fh;
                      snapRef.w = fw;
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
          if (!effTgt) return;
          // 【v1.4 关键】别拿 p.curDefinition 判断"到位没有"：那只是客户端记的档位号，
          // 我们的 changeDefinition 调用也会把它改掉，于是"以为钉上了、实际没换流"永远发现不了。
          // 改成看 <video> 元素真实解码尺寸。
          var realW = 0, realH = 0;
          try { var mv = p.video || p.media; realW = mv ? (mv.videoWidth || 0) : 0; realH = mv ? (mv.videoHeight || 0) : 0; } catch (e0) {}
          var realShort = Math.min(realW, realH);
          var wantShort = Math.max(
            Number(effTgt.width) || 0,
            Number(effTgt.height) || 0
          );
          // effTgt 的短边就是这条档位能给的最低分辨率
          wantShort = Math.min(Number(effTgt.width) || 99999, Number(effTgt.height) || 99999);
          // 换源静默期：刚硬换过流，<video> 还在 load()，此时 realShort=0 属于正常中间态。
          // 不跳过的后果：每条视频都会打出 revert #1~#5 再把 giveup 计数打满。
          try {
            var mp = p.video || p.media;
            if (mp && mp.__dypc4kForcePendingUntil && Date.now() < mp.__dypc4kForcePendingUntil) {
              if (!realShort) return;
              mp.__dypc4kForcePendingUntil = 0;   // 已经出画面了，静默期提前结束
            }
          } catch (eP) {}
          if (realShort && wantShort && !isNaN(wantShort) && realShort >= wantShort * 0.9) {
            if (reverts[idx + 'ok'] !== realShort) {
              reverts[idx + 'ok'] = realShort;
              post('at', 'def=' + effDef + ' real=' + realW + 'x' + realH + ' ok');
            }
            try { var mp2 = p.video || p.media; if (mp2) mp2.__dypc4kForcePendingUntil = 0; } catch (eP2) {}
            syncLabel(p, effTgt, effDef);
            if (!W.__dypc4kLdomAt || Date.now() - W.__dypc4kLdomAt > 1200) { W.__dypc4kLdomAt = Date.now(); labelDom(); }
            return;
          }
          var vkey;
          try { vkey = (p.video && p.video.currentSrc) || ('i' + idx); } catch (e) { vkey = 'i' + idx; }
          vkey = (vkey + '|' + effDef);
          reverts[vkey] = (reverts[vkey] || 0) + 1;
          if (reverts[vkey] > 5 && reverts[vkey + 'hard'] <= 3) {
            reverts[vkey + 'hard'] = (reverts[vkey + 'hard'] || 0) + 1;
            post('giveup', 'cur=' + cur + ' eff=' + effDef + ' real=' + realW + 'x' + realH + ' retry#' + reverts[vkey + 'hard']);
          }
          if (reverts[vkey] > 5) return;
          post('revert', 'cur=' + cur + ' -> ' + effDef + (effDef === Number(CFG.gear) ? ' (4K)' : ' (该视频最高)') +
               ' real=' + realW + 'x' + realH + ' want>=' + wantShort + ' #' + reverts[vkey]);
          if (!forceChange(p, effTgt, effDef)) {
            try { p.changeDefinition(effTgt, p.curDefinition); } catch (e) { post('err', 'changeDefinition: ' + e.message); }
          }
        });
        var sig = JSON.stringify(dump.map(function (d) { return [d.playing, d.cur, d.auto, d.gears]; }));
        if (sig !== lastSig) { lastSig = sig; post('state', JSON.stringify(dump)); }
      }

      // ================= 诊断 dump：播放器真实结构（v1.4-probe）=================
      // 目的：搞清「changeDefinition 调了没生效」到底是 (a) 找错播放器实例
      // (b) 编码族不匹配 (c) 列表与真实码流脱钩。每条视频 dump 一次。
      var DIAG2_SEEN = {};
      function diag2() {
        try {
          var vs = [].slice.call(document.querySelectorAll('video'));
          var vinfo = vs.map(function (v, i) {
            var src = '';
            try { src = String(v.currentSrc || v.src || '').slice(-70); } catch (e) {}
            return { i: i, paused: !!v.paused, w: v.videoWidth, h: v.videoHeight, rs: v.readyState, src: src };
          });
          var playing = null;
          for (var q = 0; q < vs.length; q++) if (!vs[q].paused && vs[q].videoWidth) { playing = vs[q]; break; }
          var ps = allPlayers();
          var pinfo = ps.map(function (p, i) {
            var o = { i: i, playing: !!p.isPlaying };
            try { o.sameVideo = (p.video === playing); } catch (e) { o.sameVideo = '?'; }
            try {
              o.cur = p.curDefinition ? {
                def: p.curDefinition.definition, w: p.curDefinition.width, h: p.curDefinition.height,
                gear: p.curDefinition.gearName, codec: p.curDefinition.codecType, h265: p.curDefinition.isH265
              } : null;
            } catch (e) { o.cur = 'err'; }
            try { o.cfgCodec = p.config && p.config.codecType; o.cfgInit = p.config && p.config.initCodecType; } catch (e) { }
            try { var l = p.config && p.config.definition && p.config.definition.list; o.listN = l ? l.length : -1; } catch (e) { }
            try { o.plugins = Object.keys(p.plugins || {}).slice(0, 24); } catch (e) { }
            try { o.ownKeys = Object.keys(p).slice(0, 40); } catch (e) { }
            try { o.sw = typeof p.switchDefinition; o.cd = typeof p.changeDefinition; } catch (e) { }
            try { o.mediaSrc = String((p.video && (p.video.currentSrc || p.video.src)) || '').slice(-70); } catch (e) { }
            // 【关键】客户端自己造的档位条目长什么样：url 是字符串还是数组、有哪些字段。
            // 我们合成的条目如果 url 形状不对，changeDefinition 内部 switchURL 会静默失败
            //（switchURL 的 Promise 没有 catch，this.src 设成数组对象就等于设成了 "[object Object]"）。
            try {
              var l2 = (p.config && p.config.definition && p.config.definition.list) || [];
              o.list = l2.slice(0, 5).map(function (e3) {
                var t3 = Object.prototype.toString.call(e3 && e3.url);
                var u3 = '';
                try {
                  if (typeof e3.url === 'string') u3 = e3.url.slice(0, 50);
                  else if (Array.isArray(e3.url)) u3 = 'ARR(' + e3.url.length + '):' + JSON.stringify(e3.url[0]).slice(0, 50);
                  else u3 = JSON.stringify(e3.url).slice(0, 60);
                } catch (e4) { u3 = 'ERR'; }
                return {
                  d: e3 && e3.definition, t: t3, u: u3,
                  vid: String((e3 && e3.vid) || '').slice(-12),
                  br: e3 && e3.bitrate, h5: e3 && e3.isH265,
                  keys: e3 ? Object.keys(e3).slice(0, 14).join('/') : ''
                };
              });
              o.cfgUrl = (function () { try { return Object.prototype.toString.call(p.config.url); } catch (e5) { return '?'; } })();
              // 【v1.4 关键】切档的真正入口不在 xgplayer，而在网页 bundle 的 DASH 插件里。
              // 把每个插件自己的方法列出来，才能知道该调谁（之前只看 plugins 的 key 没用）。
              o.pluginDetail = (function () {
                var out = {};
                try {
                  var pl = p.plugins || {};
                  Object.keys(pl).forEach(function (pn) {
                    var po = pl[pn];
                    if (!po || typeof po !== 'object') return;
                    var fns = [];
                    try {
                      for (var kk in po) {
                        try { if (typeof po[kk] === 'function') fns.push(kk + '()'); } catch (e6) {}
                      }
                    } catch (e7) {}
                    var snap = {};
                    try {
                      ['curBitRate', 'curDefinition', 'bitRateList', 'autoDefiSwitch', 'isPlayAutoDefi',
                       'currentDefinition', 'defiList', 'abrInfo'].forEach(function (pk) {
                        if (po[pk] !== undefined) {
                          var vv = po[pk];
                          snap[pk] = (vv && typeof vv === 'object')
                            ? ('{' + Object.keys(vv).slice(0, 8).join(',') + '}')
                            : String(vv).slice(0, 40);
                        }
                      });
                    } catch (e8) {}
                    out[pn] = { fns: fns.slice(0, 26), snap: snap };
                  });
                } catch (e) {}
                return out;
              })();
              // MSE 判定：如果 media 是 MSE，则 `this.src = url` 这条切换路径被直接忽略
              o.isMSE = (function () {
                try {
                  var m = p.media || p.video;
                  return !!(m && typeof MediaSource !== 'undefined' && m.src && m.src.indexOf('blob:') === 0);
                } catch (e9) { return '?'; }
              })();
              // 【v1.5 探针】MSE 下 src 换源无效，必须找客户端自己的切档入口。
              // 逐层扒原型链，把带 switch/definition/abr/clarity 字样的方法全列出来。
              o.protoFns = (function () {
                var out = [], seen = {}, proto = p, depth = 0;
                while (proto && depth < 6) {
                  try {
                    Object.getOwnPropertyNames(proto).forEach(function (n) {
                      if (seen[n]) return;
                      seen[n] = 1;
                      try {
                        if (typeof p[n] !== 'function') return;
                        if (n === 'constructor') return;
                        if (/switch|definition|defi|abr|clarity|seamless|change/i.test(n)) out.push(n + '@d' + depth);
                      } catch (e10) {}
                    });
                  } catch (e11) {}
                  proto = Object.getPrototypeOf(proto); depth++;
                }
                return out.slice(0, 30);
              })();
              o.hasSeamless = (function () {
                try { return typeof p.seamlessSwitch; } catch (e12) { return '?'; }
              })();
              // mp4encryptplayer 插件持有真正的 MSE 切档实现（changeDefinition/abrSwitchURL）
              o.mp4 = (function () {
                try {
                  var mp = p.plugins && p.plugins.mp4encryptplayer;
                  if (!mp) return null;
                  var r = {};
                  ['changeDefinition', 'abrSwitchURL', 'changeDefineCanPlay', 'removeBuffer', '_updateMSE']
                    .forEach(function (n) { r[n] = typeof mp[n]; });
                  try {
                    r.snap = {};
                    ['curDefinition', 'curBitRate', 'definition', 'bitRateList'].forEach(function (pk) {
                      if (mp[pk] !== undefined) r.snap[pk] = String(JSON.stringify(mp[pk])).slice(0, 60);
                    });
                  } catch (e13) {}
                  return r;
                } catch (e14) { return 'err'; }
              })();
            } catch (e) { }
            return o;
          });
          post('diag2', JSON.stringify({ nv: vs.length, v: vinfo, np: ps.length, players: pinfo }));
        } catch (e) { post('err', 'diag2: ' + e.message); }
      }
      W.__dypc4kDiag2 = diag2;

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

      // ---------- 远程控制：主世界这一侧真正执行动作 ----------
      // preload 侧负责轮询指令文件（它有 fs），把命令用 CustomEvent 递进来；
      // 这里执行完通过 postMessage 把结果回传，preload 再落盘。
      try {
        var ACT = {};
        ACT.state = function () {
          return JSON.stringify(allPlayers().map(function (p, _k) {
            var v = p.video || p.media || {};
            return {
              i: _k, playing: !!p.isPlaying, cur: curDef(p),
              sel: (p.config || {}).userSelectDefinition,
              vw: v.videoWidth, vh: v.videoHeight, paused: !!v.paused,
              rs: v.readyState, src: String(v.src || '').slice(0, 40)
            };
          }));
        };
        ACT.diag = function () { diag2(); return 'diag2 queued'; };
        ACT.gears = function () {
          return JSON.stringify(allPlayers().map(function (p) {
            var l = defList(p) || [];
            return l.map(function (e) {
              return Number(e.definition) + '@' + (e.height || 0) + 'p/' + (e.uri || '').slice(0, 8);
            }).join(' ');
          }));
        };
        ACT.click = function (x, y) {
          var el = document.elementFromPoint(Number(x) || 100, Number(y) || 100);
          if (!el) return 'no element at ' + x + ',' + y;
          try { el.click(); return 'clicked ' + el.tagName + '|' + String(el.className).slice(0, 40) + '|' + String(el.textContent || '').slice(0, 20); }
          catch (e) { return 'ERR ' + e.message; }
        };
        // 找窗口里可见的抖音内部控件（清晰度菜单/下一集按钮等）
        ACT.els = function (kw) {
          var out = [];
          var all = document.querySelectorAll('div,span,button,li');
          for (var i = 0; i < all.length && out.length < 40; i++) {
            var e = all[i];
            var t = String(e.textContent || '').trim();
            if (!t || t.length > 24) continue;
            if (kw && t.indexOf(kw) < 0) continue;
            var r = e.getBoundingClientRect();
            if (r.width < 4 || r.height < 4) continue;
            out.push({ t: t, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), cls: String(e.className).slice(0, 30) });
          }
          return JSON.stringify(out);
        };
        // 挑"最像主播放器"的那个：优先 playing，其次按 videoHeight 排序（暂停时 isPlaying 会变 false）
        function mainPlayer() {
          var ps = allPlayers().slice(0);
          if (!ps.length) return null;
          ps.sort(function (a, b) {
            var av = (a.video || a.media || {}), bv = (b.video || b.media || {});
            var ap = a.isPlaying ? 1 : 0, bp = b.isPlaying ? 1 : 0;
            if (ap !== bp) return bp - ap;
            return (bv.videoHeight || 0) - (av.videoHeight || 0);
          });
          return ps[0];
        }
        ACT.pn = function () {
          var out = [];
          allPlayers().forEach(function (p, i) {
            var pn = null;
            try { pn = p.getPlugin && p.getPlugin('playnext'); } catch (e) {}
            if (!pn) { out.push('#' + i + ' none'); return; }
            var ms = [];
            for (var k in pn) {
              try { if (typeof pn[k] === 'function') ms.push(k); } catch (e) {}
            }
            for (var k2 in pn) {
              try { if (k2 !== 'player' && pn[k2] !== null && typeof pn[k2] !== 'function' && typeof pn[k2] !== 'object') ms.push(k2 + '=' + pn[k2]); } catch (e) {}
            }
            out.push('#' + i + ' ' + ms.join(','));
          });
          return out.join(' || ');
        };
        ACT.scroll = function (dy) {
          var e = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
          var n = 0;
          while (e && n < 12) {
            var st = window.getComputedStyle(e);
            if (/(auto|scroll)/.test(st.overflowY)) {
              e.scrollTop += Number(dy) || 800;
              return 'scrolled ' + e.tagName + '.' + String(e.className).slice(0, 30) + ' -> ' + Math.round(e.scrollTop);
            }
            e = e.parentElement; n++;
          }
          return 'no scroll container';
        };
        ACT.plugins = function () {
          var out = allPlayers().map(function (p) {
            return Object.keys(p.plugins || {}).join('|');
          });
          return JSON.stringify(out);
        };
        ACT.pick = function (i) {
          var p = allPlayers()[Number(i) || 0];
          if (!p) return 'no player ' + i;
          var v = p.video || p.media || {};
          return '#' + i + ' playing=' + !!p.isPlaying + ' paused=' + !!v.paused + ' ' + (v.videoWidth || 0) + 'x' + (v.videoHeight || 0);
        };
        // 在页面里派发按键（不是 OS 级 SendKeys，焦点问题不存在）
        ACT.key = function () {
          var key = arguments[0] || 'ArrowDown';
          var kc = key === 'ArrowDown' ? 40 : key === 'ArrowUp' ? 38 : 0;
          var targets = [document, document.body, document.documentElement];
          var v = document.querySelector('video');
          var cont = v && v.parentElement;
          for (var d = 0; cont && d < 4; d++) { targets.push(cont); cont = cont.parentElement; }
          var hit = 0;
          targets.forEach(function (t) {
            if (!t) return;
            var base = { key: key, code: key, keyCode: kc, which: kc, bubbles: true, cancelable: true, composed: true };
            ['keydown', 'keypress', 'keyup'].forEach(function (ty) {
              try {
                var ev = new KeyboardEvent(ty, base);
                Object.defineProperty(ev, 'keyCode', { get: function () { return kc; } });
                Object.defineProperty(ev, 'which', { get: function () { return kc; } });
                t.dispatchEvent(ev); hit++;
              } catch (e) {}
            });
          });
          return 'dispatched ' + key + ' x' + hit + ' targets=' + targets.length;
        };
        // 用接口抓到的 aweme_id 直接跳转 —— 不依赖任何键盘/鼠标模拟
        ACT.aids = function () {
          var ks = Object.keys(AID2GEARS);
          var out = ks.slice(0, 60).map(function (aid) {
            var gs = AID2GEARS[aid] || [];
            var best = 9999;
            gs.forEach(function (g) { if (g && g.def != null && Number(g.def) < best) best = Number(g.def); });
            return aid + '@' + (best === 9999 ? '?' : best) + '/' + gs.length;
          });
          return out.join(' ');
        };
        ACT.goto = function (aid) {
          if (!aid) return 'need aweme id';
          try {
            location.href = 'https://www.douyin.com/video/' + String(aid);
            return 'navigating to /video/' + aid;
          } catch (e) { return 'ERR ' + e.message; }
        };
        // ---- 模拟真实鼠标：先让控件浮出来，再点 ----
        function fireMouse(el, ty, extra) {
          var r = el.getBoundingClientRect();
          var x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
          var o = {
            bubbles: true, cancelable: true, composed: true, view: window,
            clientX: x, clientY: y, screenX: x, screenY: y, button: 0, buttons: 0
          };
          if (extra) for (var k in extra) o[k] = extra[k];
          var Ev = ty.indexOf('pointer') === 0 ? (window.PointerEvent || MouseEvent) : MouseEvent;
          try { el.dispatchEvent(new Ev(ty, o)); return true; } catch (e) { return false; }
        }
        ACT.hover = function (x, y) {
          var el = document.elementFromPoint(Number(x) || window.innerWidth / 2, Number(y) || window.innerHeight / 2);
          if (!el) return 'no element';
          ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove'].forEach(function (t) {
            fireMouse(el, t);
          });
          return 'hover on ' + el.tagName + '.' + String(el.className).slice(0, 36);
        };
        // 全屏范围内撒一遍 mousemove，逼控件浮层挂载
        ACT.wake = function () {
          var n = 0, w = window.innerWidth, h = window.innerHeight;
          for (var fy = 0.3; fy <= 0.95; fy += 0.1) {
            for (var fx = 0.15; fx <= 0.9; fx += 0.15) {
              var el = document.elementFromPoint(Math.round(w * fx), Math.round(h * fy));
              if (!el) continue;
              fireMouse(el, 'pointermove'); fireMouse(el, 'mousemove'); n++;
            }
          }
          return 'woke ' + n + ' points';
        };
        // ---- 找真正的"无缝切档"包装播放器 ----
        // 反编译证据（mobile-web/probe-output/code/_chunks/47733.1859c7e9.js）：
        // 客户端切清晰度走的是 s.updateConfig(...) + s.seamlessSwitch({urlList}) + s.emit(DefinitionChange) + s.curDefinition=p。
        // 这个 s 不是 xgplayer 实例（实例上没有 seamlessSwitch），而是网页层包它的一层对象，
        // 只能从 React fiber 里把它挖出来。
        function hasFn(o, name) {
          try { return !!o && typeof o[name] === 'function'; } catch (e) { return false; }
        }
        function scanFor(obj, name, depth, seen) {
          if (!obj || depth < 0) return null;
          var t = typeof obj;
          if (t !== 'object' && t !== 'function') return null;
          if (seen.indexOf(obj) >= 0) return null;
          if (seen.length > 600) return null;
          seen.push(obj);
          try { if (hasFn(obj, name)) return obj; } catch (e) {}
          var ks;
          try { ks = Object.keys(obj); } catch (e) { return null; }
          for (var i = 0; i < ks.length && i < 60; i++) {
            var v;
            try { v = obj[ks[i]]; } catch (e) { continue; }
            if (!v || (typeof v !== 'object' && typeof v !== 'function')) continue;
            var r = scanFor(v, name, depth - 1, seen);
            if (r) return r;
          }
          return null;
        }
        var SP = null;
        function findSeamless() {
          if (SP) return SP;
          var roots = [];
          var els = document.querySelectorAll('div,video,*');
          var seenKeys = {};
          for (var i = 0; i < els.length && roots.length < 300; i++) {
            var e = els[i];
            var ks = null;
            try { ks = Object.keys(e); } catch (er) { continue; }
            for (var j = 0; j < ks.length; j++) {
              if (/^__reactFiber\$/.test(ks[j]) || /^__reactInternalInstance\$/.test(ks[j])) {
                if (!seenKeys[ks[j]]) { seenKeys[ks[j]] = 1; }
                var f = e[ks[j]];
                if (f && roots.indexOf(f) < 0) roots.push(f);
              }
            }
          }
          post('sp', 'fiber roots=' + roots.length);
          var queue = roots.slice(0), hops = 0, visited = 0;
          while (queue.length && hops < 30000) {
            var f2 = queue.shift(); hops++;
            if (!f2 || visited > 30000) break;
            visited++;
            // 1) fiber 上的 props / stateNode / 各类 state
            var cands = [f2.memoizedProps, f2.pendingProps, f2.stateNode, f2.memoizedState];
            // 2) hook 链
            var hs = f2.memoizedState, guard = 0;
            while (hs && hs.next && guard < 40) { cands.push(hs.memoizedState); hs = hs.next; guard++; }
            for (var ci = 0; ci < cands.length; ci++) {
              var cand = cands[ci];
              if (!cand) continue;
              if (hasFn(cand, 'seamlessSwitch')) { SP = cand; post('sp', 'FOUND at fiber#' + hops + ' kind=' + (f2.tag)); return SP; }
              var ref = null;
              try { ref = cand.current; } catch (e) {}
              if (ref && hasFn(ref, 'seamlessSwitch')) { SP = ref; post('sp', 'FOUND via .current at fiber#' + hops); return SP; }
            }
            if (f2.child) queue.push(f2.child);
            if (f2.sibling) queue.push(f2.sibling);
          }
          post('sp', 'NOT FOUND after ' + visited + ' fibers');
          return null;
        }
        ACT.sp = function () {
          var s = findSeamless();
          if (!s) return 'no seamless wrapper';
          var ms = [];
          for (var k in s) { try { if (typeof s[k] === 'function') ms.push(k); } catch (e) {} }
          return 'found; fns=' + ms.slice(0, 40).join(',') +
            ' cur=' + JSON.stringify((s.curDefinition && s.curDefinition.definition) || null);
        };
        ACT.spsw = function (d) {
          var s = findSeamless();
          if (!s) return 'no seamless wrapper';
          var pl = allPlayers()[0];
          var entry = null;
          var l = pl && defList(pl);
          if (l) for (var i = 0; i < l.length; i++) { if (Number(l[i].definition) === Number(d)) { entry = l[i]; break; } }
          if (!entry) return 'no entry for def=' + d;
          var out = [];
          try {
            if (typeof s.updateConfig === 'function') {
              s.updateConfig({ shared: { definition: { list: l } } });
              out.push('updateConfig ok');
            }
          } catch (e) { out.push('updateConfig ERR ' + e.message); }
          try {
            var r = s.seamlessSwitch({
              url: undefined,
              urlList: entry.url,
              mediaInfo: {
                size: entry.size, bitrate: entry.bitrate, duration: entry.duration,
                id: entry.vid || entry.uri, file_id: entry.file_id || entry.uri
              }
            });
            out.push('seamlessSwitch -> ' + (r && r.then ? 'promise' : String(r)));
            if (r && r.then) r.then(function () { post('sp', 'seamless resolved def=' + d); }, function (e) { post('sp', 'seamless rejected ' + (e && e.message)); });
          } catch (e) { out.push('seamlessSwitch ERR ' + e.message); }
          try { if (typeof s.emit === 'function') { s.emit('definition_change', { to: entry, from: {}, hack: false }); out.push('emit ok'); } } catch (e) { out.push('emit ERR ' + e.message); }
          try { s.curDefinition = entry; out.push('curDefinition set'); } catch (e) {}
          return out.join(' | ');
        };
        // MSE 播放器的硬换源：绕过 p.src setter（它对 blob 直接 return），
        // 直接把新的 mp4 直链写在 <video> 上，让浏览器从 MSE 切回渐进式。
        function entryFor(p, d) {
          var l = defList(p) || [];
          for (var i = 0; i < l.length; i++) if (Number(l[i].definition) === Number(d)) return l[i];
          return null;
        }
        ACT.hard = function (d) {
          var p = mainPlayer();
          if (!p) return 'no player';
          var e = entryFor(p, d);
          if (!e) return 'no entry for def=' + d + ' ladder=' + (defList(p) || []).map(function (x) { return x.definition; }).join(',');
          var m = p.media || p.video;
          if (!m) return 'no media';
          var url = urlOf(e);
          if (!url) return 'entry has no url';
          var before = (m.videoWidth || 0) + 'x' + (m.videoHeight || 0);
          var keep = m.currentTime, wasMSE = /^blob/.test(m.currentSrc || m.src);
          try { m.pause(); } catch (er) {}
          try {
            // 直接赋字符串 src：浏览器会丢掉旧的 MediaSource，改走渐进式下载
            m.src = url;
            m.load();
            if (keep > 0.35) {
              m.addEventListener('loadedmetadata', function once() {
                m.removeEventListener('loadedmetadata', once);
                try { m.currentTime = keep; } catch (er) {}
              });
            }
            var pr = m.play();
            if (pr && pr.catch) pr.catch(function () {});
          } catch (er) { return 'ERR ' + er.message; }
          post('hard', 'def=' + d + ' wasMSE=' + wasMSE + ' before=' + before + ' keep=' + keep.toFixed(1) + ' src=' + url.slice(0, 46));
          setTimeout(function () {
            post('hard', 'after1.5s def=' + d + ' now=' + (m.videoWidth || 0) + 'x' + (m.videoHeight || 0) +
              ' mse=' + /^blob/.test(m.currentSrc || m.src));
          }, 1500);
          return 'hard def=' + d + ' wasMSE=' + wasMSE + ' before=' + before;
        };
        // 用接口档位直接硬换源（不等 fillMissing、也不管播放器是 MSE 还是渐进式）
        ACT.hard4k = function (want) {
          var p = mainPlayer();
          if (!p) return 'no player';
          var m = p.media || p.video;
          if (!m) return 'no media';
          // 1) 从当前梯子任一条目反查 aweme_id，拿接口全档
          var l = defList(p) || [];
          var cands = null, aid = '';
          for (var i = 0; i < l.length && !cands; i++) {
            var u = String((l[i] && l[i].uri) || '');
            if (!u) continue;
            if (URI2AID[u] && AID2GEARS[URI2AID[u]]) { aid = URI2AID[u]; cands = AID2GEARS[aid]; }
            else if (GEARMAP[u]) { cands = GEARMAP[u]; }
          }
          if (!cands || !cands.length) return 'no api gears (ladder=' + l.map(function (x) { return x.definition; }).join(',') + ')';
          // 2) 挑目标档
          var wantDef = want == null ? 9999 : Number(want);
          var best = null;
          if (want == null) {
            for (var j = 0; j < cands.length; j++) if (!best || cands[j].def < best.def) best = cands[j];
          } else {
            for (var j2 = 0; j2 < cands.length; j2++) {
              if (Number(cands[j2].def) === wantDef) { best = cands[j2]; break; }
            }
            if (!best) return 'no api gear with def=' + wantDef + ' (have ' + cands.map(function (x) { return x.def; }).join(',') + ')';
          }
          if (!best) return 'no gear';
          var entry = synthEntry(best);
          if (!entry) return 'synthEntry null';
          var url = urlOf(entry);
          if (!url) return 'no url';
          var before = (m.videoWidth || 0) + 'x' + (m.videoHeight || 0);
          var keep = m.currentTime, wasMSE = /^blob/.test(m.currentSrc || m.src);
          try { m.pause(); } catch (er) {}
          // 关键：<source> 子元素存在时浏览器忽略 media.src，先清掉
          try {
            var kids = m.querySelectorAll('source');
            for (var s = 0; s < kids.length; s++) kids[s].parentNode.removeChild(kids[s]);
          } catch (er) {}
          try {
            m.src = url;
            m.load();
            if (keep > 0.35) {
              m.addEventListener('loadedmetadata', function once2() {
                m.removeEventListener('loadedmetadata', once2);
                try { m.currentTime = keep; } catch (er) {}
              });
            }
            var pr = m.play();
            if (pr && pr.catch) pr.catch(function () {});
          } catch (er) { return 'ERR ' + er.message; }
          post('hard', 'def=' + best.def + ' wasMSE=' + wasMSE + ' before=' + before + ' keep=' + keep.toFixed(1) + ' url=' + url.slice(0, 46));
          setTimeout(function () {
            post('hard', 'after1.5s def=' + best.def + ' now=' + (m.videoWidth || 0) + 'x' + (m.videoHeight || 0) + ' mse=' + /^blob/.test(m.currentSrc || m.src));
          }, 1500);
          return 'hard4k def=' + best.def + ' wasMSE=' + wasMSE + ' before=' + before + ' aid=' + aid;
        };
        // 诊断：每个播放器的 curDefinition + 页面上"看起来像清晰度标签"的文字
        ACT.q = function () {
          var out = [];
          allPlayers().forEach(function (p, i) {
            var m = p.media || p.video;
            out.push({
              i: i, playing: !!p.isPlaying,
              cur: (p.curDefinition && p.curDefinition.definition),
              curType: typeof (p.curDefinition && p.curDefinition.definition),
              vw: m ? (m.videoWidth || 0) : 0, vh: m ? (m.videoHeight || 0) : 0,
              mse: m ? /^blob/.test(m.currentSrc || m.src) : false,
              labelAt: p.__dypc4kLabelAt || 0
            });
          });
          // 找页面上的档位文字（控制栏是悬停才创建的，找不到就是空）
          var hits = [];
          try {
            var all = document.querySelectorAll('div,span');
            for (var i2 = 0; i2 < all.length && hits.length < 8; i2++) {
              var e = all[i2];
              if (e.children.length > 2) continue;
              var tx = (e.textContent || '').trim();
              if (!tx || tx.length > 14) continue;
              if (!/^(超清|高清|标清|极速|智能|流畅)\s*(4K|2K|1080P|720P|540P)?$/.test(tx)) continue;
              var r = e.getBoundingClientRect();
              hits.push({ t: tx, cls: String(e.className || '').slice(0, 40), x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });
            }
          } catch (e3) {}
          return JSON.stringify({ players: out, domHits: hits });
        };
        // 诊断：把清晰度控件的外层 HTML 打出来，看清结构再决定改哪个节点
        ACT.ql = function () {
          var out = {};
          try {
            var w = document.querySelector('.clarity-wrapper');
            out.wrapper = w ? String(w.outerHTML).slice(0, 1200) : '(none)';
            var sel = document.querySelector('.clarity-wrapper .item.selected');
            out.selected = sel ? String(sel.outerHTML).slice(0, 400) : '(none)';
            var btn = null, bs = document.querySelectorAll('.btnV2');
            for (var i = 0; i < bs.length; i++) {
              if (/P$|超清|高清|标清|极速|智能/.test((bs[i].textContent || '').trim())) { btn = bs[i]; break; }
            }
            out.btn = btn ? String(btn.outerHTML).slice(0, 600) : '(none)';
            out.btnParent = btn && btn.parentNode ? String(btn.parentNode.outerHTML).slice(0, 900) : '(none)';
          } catch (e) { out.err = e.message; }
          return JSON.stringify(out);
        };
        // 诊断：手工跑一次 step()，把异常抛出来（setInterval 里的异常会被静默吞掉）
        ACT.runs = function () {
          var out = {};
          try { step(); out.step = 'ok'; } catch (e) { out.step = 'ERR ' + e.message + ' @ ' + String(e.stack || '').split('\n')[1]; }
          try { out.tick = tickCount; } catch (e) { out.tick = 'n/a'; }
          try { out.gears = gearsOf(mainPlayer()); } catch (e) {}
          try { out.fill = typeof fillMissing + '/' + typeof realList + '/' + typeof labelDom + '/' + typeof forceChange; } catch (e) {}
          return JSON.stringify(out);
        };
        ACT.pnx = function () {
          var p = mainPlayer();
          if (!p) return 'no player';
          var pn = null;
          try { pn = p.getPlugin('playnext'); } catch (e) { return 'getPlugin ERR ' + e.message; }
          if (!pn) return 'no pn';
          try {
            // playNext 内部会 e.preventDefault()，必须给个假事件对象
            var fakeEvt = {
              preventDefault: function () {}, stopPropagation: function () {},
              type: 'click', target: null, currentTarget: null
            };
            var r = pn.playNext(fakeEvt);
            return 'playNext() -> ' + String(r);
          } catch (e) { return 'playNext ERR ' + (e && e.message); }
        };
        ACT.next = function () {
          var ps = allPlayers().filter(function (p) { return p.isPlaying; });
          if (!ps.length) { var mp = mainPlayer(); if (mp) ps = [mp]; }
          for (var i = 0; i < ps.length; i++) {
            try {
              var pn = ps[i].getPlugin && ps[i].getPlugin('playnext');
              if (pn && typeof pn.playNext === 'function') {
                var fe = { preventDefault: function () {}, stopPropagation: function () {}, type: 'click' };
                var rr = pn.playNext(fe);
                return 'playnext#' + i + ' -> ' + String(rr);
              }
            } catch (e) { return 'playnext#' + i + ' ERR ' + (e && e.message); }
          }
          // 退回：视频容器上滚轮（抖音桌面端靠 wheel 切上下条）
          var vids = [].slice.call(document.querySelectorAll('video'));
          vids.sort(function (a, b) { return (b.videoHeight || 0) - (a.videoHeight || 0); });
          for (var j = 0; j < vids.length; j++) {
            if (!vids[j].videoHeight && vids[j].paused) continue;
            var r = vids[j].getBoundingClientRect();
            var cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
            try {
              vids[j].dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true, clientX: cx, clientY: cy }));
            } catch (e) {}
            return 'wheel on video#' + j;
          }
          return 'no playing player';
        };
        ACT.force = function (d) {
          var done = 0;
          allPlayers().forEach(function (p) {
            try {
              var l = defList(p) || [];
              for (var i = 0; i < l.length; i++) {
                if (Number(l[i].definition) === Number(d)) { forceChange(p, l[i], Number(d)); done++; break; }
              }
            } catch (e) {}
          });
          return 'force def=' + d + ' x' + done;
        };
        window.__DYPc4kActions = ACT;
        window.addEventListener('dypc4kCmd', function (ev) {
          var raw = String((ev && ev.detail) || '');
          var parts = raw.trim().split(/\s+/);
          var op = parts[0] || '';
          var res;
          try {
            res = ACT[op] ? String(ACT[op].apply(null, parts.slice(1)) || 'ok')
              : (op === 'ops' ? Object.keys(ACT).join(',') : 'unknown op "' + op + '"');
          } catch (e) { res = 'ERR ' + (e && e.message); }
          try {
            window.postMessage({ __dypc4k: 3, kind: 'ctlres', data: JSON.stringify({ op: op, res: res }) }, '*');
          } catch (e) {}
        }, false);
        post('ctl', 'main-world actions: ' + Object.keys(ACT).join(','));
      } catch (e) { post('ctl', 'actions failed: ' + (e && e.message)); }
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
          // 远程控制的结果落到 dypc4k-cmd.out，格式：<时间>\t#<序号>\t<op>\t<result>
          if (d.kind === 'ctlres') {
            try {
              var oPath = require('path').join(process.env.APPDATA + '\\douyin', 'dypc4k-cmd.out');
              var oo = JSON.parse(d.data);
              var so = 0;
              try { so = fsl.statSync(oPath).size; } catch (e) {}
              if (so > 256 * 1024) fsl.truncateSync(oPath, 0);
              fsl.appendFileSync(oPath, new Date().toISOString().slice(11, 23) + '\t' + oo.op + '\t' + oo.res + '\n');
            } catch (eO) {}
            return;
          }
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

      // ---------- 远程控制：让测试不靠 SendKeys ----------
      // 键盘模拟在抖音窗口上极不可靠（焦点/快捷键拦截），实测 8 次只有 1 次生效。
      // 改成指令文件：往 %APPDATA%\douyin\dypc4k-cmd.txt 写一行命令，
      // 这里每 400ms 检查一次，转成主世界的 CustomEvent，执行结果由主世界 postMessage 回来再落盘。
      try {
        var fsCmd = require('fs');
        var pathMod = require('path');
        var electronCmd = require('electron');
        var dy4kDir = pathMod.join(process.env.APPDATA, 'douyin');
        var cmdPath = pathMod.join(dy4kDir, 'dypc4k-cmd.txt');
        var outPath = pathMod.join(dy4kDir, 'dypc4k-cmd.out');
        var cmdStat = { n: 0, lastOp: '', hadErr: false };
        setInterval(function () {
          try {
            if (!fsCmd.existsSync(cmdPath)) return;
            var raw = '';
            try { raw = fsCmd.readFileSync(cmdPath, 'utf8'); } catch (eR) { return; }
            try { fsCmd.unlinkSync(cmdPath); } catch (eU) {}
            cmdStat.n++;
            cmdStat.lastOp = String(raw || '').trim();
            var src = 'window.dispatchEvent(new CustomEvent("dypc4kCmd",{detail:' + JSON.stringify(String(raw || '')) + '}))';
            electronCmd.webFrame.executeJavaScript(src).catch(function (e) {
              fsCmd.appendFileSync(outPath, new Date().toISOString().slice(11, 23) + '\t#' + cmdStat.n + '\tdispatch ERR ' + (e && e.message) + '\n');
            });
          } catch (e) { cmdStat.hadErr = true; }
        }, 400);
        W.__dypc4kRemoteControl = { cmdPath: cmdPath, outPath: outPath, stat: cmdStat };
        post('ctl', 'remote control armed -> ' + cmdPath);
      } catch (e) {}
    } catch (e) {}
  } catch (e) {}
})();
/* ==== dypc4k end ==== */