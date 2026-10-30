/**
 * dsh-mobile-layout 浏览器端（client half）。
 *
 * 产物形状与 dsh-mobile-compose 一致：__ModuleLoader__ closure factory，
 * 外部依赖经注入的 require 从平台模块表解析（react 不在 bundle 内）。
 *
 * 职责：
 *   1. 先识别宿主（桌面 Electron / Android 壳 / 浏览器，见 detectHost）：
 *      桌面端有原生 titleBarOverlay 与鼠标指针，移动布局会错乱，永不激活；
 *      其余宿主按布局视口判定「手机竖屏」，进入 600/1.25、保持 640/1.15
 *      做滞回，旋屏 / 分屏拖拽时 120ms 去抖，避免来回切换。
 *   2. 模式写入 documentElement.dataset.dshmMode；全部移动样式只在
 *      html[data-dshm-mode="mobile"] 下生效，退出即恢复官方默认布局。
 *   3. 给官方 AppFrame 打 data-dshm-* 锚点，后续阶段只用自有属性写 CSS，
 *      不依赖官方 CSS Modules 哈希类名。锚点缺失时回退默认布局并 warn 一次。
 *   4. 左侧栏在手机竖屏下改为抽屉：入口只有左缘手势（无按键，避免遮挡
 *      子页面自身的返回 / 页头控件）；手势由 bindDrawerGesture 常驻 window
 *      捕获阶段监听（不随槽位 / 页面卸载，任何插件面板页都可用），跟手拖拽
 *      + 松手吸附；shell.overlay 承担遮罩。开合统一走
 *      ctx.layout.toggleSidebar()，状态以 frame 的 data-sidebar-collapsed
 *      为唯一事实来源。
 *
 * 失败策略：与 hardssh / mobile-compose 客户端一致 —— 任何 DOM 失败只
 * console.warn，绝不上抛（web shell 会在插件 apply 抛错时令整个启动失败）。
 */
window.__ModuleLoader__.load({
  id: '@xiaopb/dsh-mobile-layout',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const react = require('react');

    const VERSION = '0.2.10';
    const MODE_MOBILE = 'mobile';
    const MODE_DEFAULT = 'default';

    /** 进入手机布局的阈值。 */
    const ENTER = { shortSide: 600, ratio: 1.25 };
    /** 保持手机布局的阈值（滞回，避免 600~640 区间抖动）。 */
    const STAY = { shortSide: 640, ratio: 1.15 };
    const DEBOUNCE_MS = 120;

    /**
     * 底部表下拉关闭阈值（CSS px）：手指自把手下滑超过这段距离、松手即关闭。
     * 96px 约等于拇指一节的长度——小于它多是误触，大于它用户已经明确表达
     * 「不要这张表」。
     */
    const SHEET_DRAG_CLOSE_PX = 96;

    /**
     * 纯判定：下拉位移是否达到关闭阈值。
     *
     * 只比大小不做 DOM 操作，便于单测覆盖边界；调用方负责把位移钳到 ≥0
     * （向上拖不该有"负距离关闭"这种语义）。
     *
     * @param {number} dy 下拉位移（CSS px）
     * @returns {boolean} 达到阈值返回 true
     */
    function shouldCloseSheetByDrag(dy) {
      const value = Number(dy);
      return Number.isFinite(value) && value > SHEET_DRAG_CLOSE_PX;
    }

    /**
     * 纯判定：布局视口 → 模式。
     * @param {number} width 布局视口宽（CSS px）
     * @param {number} height 布局视口高（CSS px）
     * @param {'mobile'|'default'} prev 上一模式，用于滞回
     * @returns {'mobile'|'default'}
     */
    function classify(width, height, prev) {
      const w = Number(width);
      const h = Number(height);
      if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return MODE_DEFAULT;
      const shortSide = Math.min(w, h);
      const longSide = Math.max(w, h);
      const portrait = h > w;
      const ratio = longSide / shortSide;
      const threshold = prev === MODE_MOBILE ? STAY : ENTER;
      return portrait && shortSide <= threshold.shortSide && ratio >= threshold.ratio ? MODE_MOBILE : MODE_DEFAULT;
    }

    // ---- 宿主识别（桌面端默认不激活移动布局） ----
    /** 宿主形态：桌面端 DeepSeek Harness（Electron 壳）。 */
    const HOST_DESKTOP = 'desktop';
    /** 宿主形态：Android WebView 壳（app.dsh.mobile）。 */
    const HOST_ANDROID = 'android';
    /** 宿主形态：普通浏览器（web 服务的 http(s) 页面）。 */
    const HOST_WEB = 'web';

    /**
     * 宿主识别。
     *
     * 桌面端以自定义协议 `dsh-app://app` 加载 web 客户端，且 preload 无条件
     * 注入 `window.dshDesktop`（主框架是完整产品 API，iframe 里也有
     * `{protocolVersion:1}` 桩）；Android 壳暴露 `DshAndroidClipboard` /
     * `DshAndroidDownloader` 桥；纯浏览器两者皆无。判据顺序协议 → 桥，
     * 双判据防单点失效（协议若改名，桥仍在；反之亦然）。UA 里的
     * `Electron/` 只作参考不作判据，官方未来可能覆写 UA。
     *
     * 结果只取决于加载环境，页面生命周期内不变；调用方应判定一次并缓存。
     *
     * @param {Window} win 页面 window（测试可传 mock）
     * @returns {'desktop'|'android'|'web'}
     */
    function detectHost(win) {
      const w = win || {};
      let protocol = '';
      try {
        protocol = w.location ? String(w.location.protocol) : '';
      } catch (error) {
        protocol = '';
      }
      if (protocol === 'dsh-app:') return HOST_DESKTOP;
      if (typeof w.dshDesktop !== 'undefined') return HOST_DESKTOP;
      if (w.DshAndroidClipboard || w.DshAndroidDownloader) return HOST_ANDROID;
      return HOST_WEB;
    }

    /**
     * 模式策略：宿主 → 模式。
     *
     * 桌面端永不进入手机布局：桌面窗口可缩到 520×600（足以命中视口判定），
     * 但那里有原生 titleBarOverlay（40px 窗控浮层压在网页右上角）、拖拽头
     * 与鼠标指针，移动布局的顶栏 / 手势 / Android 专属校准都会错乱——先让
     * 插件在桌面正确地「不跑」。android / web 维持视口几何判定。
     *
     * @param {'desktop'|'android'|'web'} host detectHost() 的结果
     * @param {number} width 布局视口宽（CSS px）
     * @param {number} height 布局视口高（CSS px）
     * @param {'mobile'|'default'} prev 上一模式
     * @returns {'mobile'|'default'}
     */
    function resolveMode(host, width, height, prev) {
      return host === HOST_DESKTOP ? MODE_DEFAULT : classify(width, height, prev);
    }

    /** 读取布局视口尺寸；visualViewport 存在时优先。 */
    function measure(win) {
      const doc = win.document;
      const vv = win.visualViewport;
      const innerW = Number(win.innerWidth) || 0;
      const innerH = Number(win.innerHeight) || 0;
      const clientW = doc && doc.documentElement ? Number(doc.documentElement.clientWidth) || 0 : 0;
      const clientH = doc && doc.documentElement ? Number(doc.documentElement.clientHeight) || 0 : 0;
      return {
        width: Math.round((vv && Number(vv.width)) || innerW || clientW || 0),
        height: Math.round((vv && Number(vv.height)) || innerH || clientH || 0),
      };
    }

    /**
     * 与底部常驻条重复、面板里不再重复展示的项（按选项内的标签 / 别名文本匹配）。
     * 常驻条已有「文件」按钮，面板里再放一个只是重复。
     */
    const ADD_DROP_LABELS = ['文件'];
    const ADD_DROP_ALIASES = ['file'];

    // ---- 加号面板分页（纯函数，便于单测） ----
    /** 一页的列数（与宫格列数一致）。 */
    const ADD_COLS = 4;
    /** 面板最多两行，超出改分页。 */
    const ADD_MAX_ROWS = 2;

    /**
     * 加号面板的图标配色板。
     *
     * 只取蓝 / 橙 / 紫 / 绿四族——这是工具类应用里用来区分功能分组最常见的
     * 四种色相；每族给 3 档，全部避开正色（不用 #0000ff / #ff8800 / #00aa00
     * 这类纯色），改用业内常见的中低饱和品牌色：饱和度 45%~62%、明度
     * 52%~62%，保证 24px 线性图标在浅色和深色底上都不糊。
     *
     * `soft` 是同色相 15% 的柔光底，给图标当胶囊背景；不用 color-mix 是
     * 为了兼容 Android 12 上那版 WebView（Chrome 100 左右）。
     *
     * 排列按「族」交错（蓝橙紫绿、蓝橙紫绿…）而不是同族聚在一起：色位是按
     * 哈希位就近探测的，交错排列能让相邻色位天然跨色相，一屏十来个图标不会
     * 出现一片蓝挨着蓝。
     *
     * 新增功能不需要改这张表：颜色由功能 id 哈希决定（见 planAddTints）。
     */
    const ADD_TINTS = [
      { name: 'blue-1', fg: '#4C7DF0', soft: 'rgba(76, 125, 240, 0.15)' },
      { name: 'amber-1', fg: '#D9773B', soft: 'rgba(217, 119, 59, 0.15)' },
      { name: 'violet-1', fg: '#8A6FE8', soft: 'rgba(138, 111, 232, 0.15)' },
      { name: 'green-1', fg: '#2FA57B', soft: 'rgba(47, 165, 123, 0.15)' },
      { name: 'blue-2', fg: '#3F6FD8', soft: 'rgba(63, 111, 216, 0.15)' },
      { name: 'amber-2', fg: '#D98A3E', soft: 'rgba(217, 138, 62, 0.15)' },
      { name: 'violet-2', fg: '#7C63D8', soft: 'rgba(124, 99, 216, 0.15)' },
      { name: 'green-2', fg: '#37A06B', soft: 'rgba(55, 160, 107, 0.15)' },
      { name: 'blue-3', fg: '#5B8DEF', soft: 'rgba(91, 141, 239, 0.15)' },
      { name: 'amber-3', fg: '#C96F45', soft: 'rgba(201, 111, 69, 0.15)' },
      { name: 'violet-3', fg: '#9273E4', soft: 'rgba(146, 115, 228, 0.15)' },
      { name: 'green-3', fg: '#2E9E86', soft: 'rgba(46, 158, 134, 0.15)' },
    ];

    /**
     * 功能项的类型键。
     *
     * 官方选项内部依次是「名称 / 别名 / 描述」三段（实测：文件 · file ·
     * 上传或引用本地文件），别名等同于命令 id，新增功能天然自带，最适合当
     * 类型键——同一功能永远同色，不随名称翻译变化。别名缺失时退回名称。
     *
     * @param {string[]} texts 选项内各 span 的文本
     * @param {string} group 所属分组标题
     * @returns {string}
     */
    function addOptionKey(texts, group) {
      const list = Array.isArray(texts)
        ? texts.map((text) => String(text || '').replace(/\s+/g, ' ').trim()).filter(Boolean)
        : [];
      const alias = list[1] || '';
      if (alias && alias.length <= 24) return 'alias:' + alias.toLowerCase();
      if (list[0]) return 'label:' + list[0].toLowerCase();
      if (group) return 'group:' + String(group).replace(/\s+/g, ' ').trim().toLowerCase();
      return 'misc';
    }

    /** FNV-1a 32 位哈希；同一类型键永远落在同一个色位。 */
    function tintHash(key) {
      const text = String(key || '');
      let hash = 2166136261;
      for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
      return hash >>> 0;
    }

    /**
     * 给一屏功能项分配色位。
     *
     * 规则：同类型键复用同一色位（同类型同配色）；新键从 FNV-1a 哈希位起
     * 线性探测一个未占用的色位，同屏尽量不撞色；色板用尽落回哈希位。结果是
     * 纯函数——只取决于功能集合本身，关闭重开、重启应用颜色都一样。
     *
     * @param {Array<{key: string}>} entries 按 DOM 顺序的功能项
     * @param {number} paletteSize 色板长度
     * @returns {number[]} 与 entries 等长的色位下标
     */
    function planAddTints(entries, paletteSize) {
      const size = Math.max(1, Number(paletteSize) || 1);
      const list = Array.isArray(entries) ? entries : [];
      const assigned = new Map();
      const used = new Set();
      const out = [];
      for (const entry of list) {
        const key = String((entry && entry.key) || '');
        if (assigned.has(key)) {
          out.push(assigned.get(key));
          continue;
        }
        const base = tintHash(key) % size;
        // 从哈希位起线性探测一个未占用的色位：同屏尽量不撞色；
        // 色板用尽时落回哈希位（此时撞色不可避免，只求不越界）。
        let picked = base;
        for (let step = 0; step < size; step += 1) {
          const probe = (base + step) % size;
          if (!used.has(probe)) {
            picked = probe;
            break;
          }
        }
        assigned.set(key, picked);
        used.add(picked);
        out.push(picked);
      }
      return out;
    }

    /**
     * 行数：不超过一列宽度时单行，否则固定两行（面板高度不随项数跳动）。
     * @param {number} count 项数
     * @param {number} cols 列数
     * @returns {1|2}
     */
    function rowsFor(count, cols) {
      const total = Math.max(0, Number(count) || 0);
      const width = Math.max(1, Number(cols) || ADD_COLS);
      return total <= width ? 1 : ADD_MAX_ROWS;
    }

    /**
     * 页内序号 → 网格的显式行列位置（1 起）。
     *
     * 不用 `order` 重排：网格的自动排布按「排名」而不是「order 值」填槽位，
     * 一旦某页不足 8 项，order 里的空号会被压缩，第二页的内容就会漏进第一页
     * （实测 11 项时 9/10 位被「余额/对话」占据）。显式 grid-column /
     * grid-row 直接钉住位置，缺项就留空，页边界永远落在第 4 列之后。
     *
     * @param {number} indexInPage 页内序号（0 起）
     * @param {number} pageIndex 页码（0 起）
     * @param {number} rows 行数
     * @param {number} cols 列数
     * @returns {{column: number, row: number}}
     */
    function slotOf(indexInPage, pageIndex, rows, cols) {
      const j = Math.max(0, Number(indexInPage) || 0);
      const page = Math.max(0, Number(pageIndex) || 0);
      const r = Math.max(1, Number(rows) || 1);
      const c = Math.max(1, Number(cols) || ADD_COLS);
      return {
        column: page * c + (j % c) + 1,
        row: Math.min(r, Math.floor(j / c) + 1),
      }
    }

    /**
     * 顺序切页：每页 perPage 项，最后一页可以不满。
     *
     * 不按官方分组切：页签只显示圆点、不显示组名，按组切会让前一页留白
     * （实测 10 项时第一页只有 3 项、空掉一整行），顺序切满更符合 QQ 式翻页。
     *
     * @param {Array<unknown>} options 官方选项（DOM 顺序）
     * @param {number} perPage 每页项数
     * @returns {Array<{label: string, items: number[], part: number, parts: number}>}
     */
    function planAddPages(options, perPage) {
      const list = Array.isArray(options) ? options : [];
      const size = Math.max(1, Number(perPage) || ADD_MAX_ROWS * ADD_COLS);
      const pages = [];
      for (let start = 0; start < list.length; start += size) {
        const items = [];
        for (let i = start; i < list.length && i < start + size; i += 1) items.push(i);
        pages.push({ label: String(pages.length + 1), items, part: pages.length + 1, parts: 1 });
      }
      for (const page of pages) page.parts = pages.length;
      return pages;
    }

    /**
     * 设置弹窗判据（纯判定）。
     *
     * 必须同时满足：role=dialog、aria-modal=true、导航区按钮 ≥3。前两条来自
     * narrow-settings 曾把主界面误判成设置面板的事故；第三条排除只有「关闭」
     * 的普通弹窗。
     *
     * @param {{role?: string, ariaModal?: string, navButtons?: number}} desc
     * @returns {boolean}
     */
    function isSettingsDialog(desc) {
      if (!desc || typeof desc !== 'object') return false;
      if (desc.role !== 'dialog') return false;
      if (desc.ariaModal !== 'true') return false;
      return Number(desc.navButtons) >= 3;
    }

    // ---- 文案（跟随 DSH 语言，缺省英文） ----
    const STRINGS = {
      zh: {
        close: '关闭',
        newSession: '新建',
        sessions: '会话',
        files: '文件',
        images: '图片',
        plugins: '插件',
        more: '更多',
        noSessions: '还没有会话',
        current: '当前',
        otherWorkspace: '未归入工作区',
        managePlugins: '管理插件',
        pluginsHint: '插件的安装、启停与配置在官方插件面板完成。',
        drawer: '侧栏',
        page: '第 {n} 页',
        pageCurrent: '当前第 {n} 页',
        back: '返回',
      },
      en: {
        close: 'Close',
        newSession: 'New',
        sessions: 'Sessions',
        files: 'Files',
        images: 'Images',
        plugins: 'Plugins',
        more: 'More',
        noSessions: 'No sessions yet',
        current: 'Current',
        otherWorkspace: 'No workspace',
        managePlugins: 'Manage plugins',
        pluginsHint: 'Install, toggle, and configure plugins in the official panel.',
        drawer: 'Sidebar',
        page: 'Page {n}',
        pageCurrent: 'Current page, {n}',
        back: 'Back',
      },
    };

    const runtime = { ctx: null, layout: null, sessions: null, workspace: null, lang: 'en' };

    function t(key) {
      // `runtime.lang` 是事件回调（相对时间 / 权限短文案）读的值，`state.lang`
      // 只是渲染触发器：两者由 setLang 同步写入，这里优先读 state 保证组件
      // 渲染期拿到的一定是触发本次渲染的那个语言。
      const table = STRINGS[state.lang] || STRINGS[runtime.lang] || STRINGS.en;
      return table[key] || STRINGS.en[key] || key;
    }

    /**
     * 翻页圆点的 aria-label：`page` / `pageCurrent` 两个模板按当前语言取，
     * `{n}` 换成人眼可见的页码（从 1 开始）。硬编码中文会让英文环境的读屏
     * 把页码念成中文。
     */
    function pageLabel(index, current) {
      return t(current ? 'pageCurrent' : 'page').replace('{n}', String(index + 1));
    }

    /** 横滑判定的最小位移（CSS px）：短于此视为误触 / 抖动。 */
    const SWIPE_MIN = 48;

    /**
     * 横滑意图：返回 +1（下一项）、-1（上一项）或 0（不处理）。
     *
     * 只认「横向明显大于纵向」的手势，竖向滑动交给内容滚动；`min` 可按设备
     * 密度调整，缺省 {@link SWIPE_MIN}。
     */
    function swipeDirection(dx, dy, min) {
      const limit = typeof min === 'number' ? min : SWIPE_MIN;
      const horizontal = Math.abs(dx);
      if (!(horizontal >= limit)) return 0;
      if (Math.abs(dy) > horizontal * 0.72) return 0;
      return dx < 0 ? 1 : -1;
    }

    /**
     * 加号面板用的键盘高度来源优先级：
     * 1. 原生注入——Android 壳（Kotlin）用 WindowInsetsCompat.Type.ime() 拿
     *    精确键盘高，经 JS 桥推给 WebView，最准且无需真弹一次键盘；
     * 2. 实测 / 持久化——visualViewport 收缩量（adjustResize），本会话实测过
     *    或历史会话经 localStorage 带过来；
     * 3. 启发式估值——视口 42%，首次使用且从未开过键盘的兜底，开过一次
     *    键盘后被实测覆盖并持久化。
     */
    function resolveImeHeight(native, measured, viewportHeight) {
      const n = Number(native);
      if (n > 0) return n;
      const m = typeof measured === 'string' ? parseFloat(measured) : Number(measured);
      if (Number.isFinite(m) && m > 0) return m;
      const vh = Number(viewportHeight);
      if (!(vh > 0)) return 0;
      return Math.round(vh * 0.42);
    }

    /**
     * 抽屉右滑开栏的起手区宽度（CSS px，从屏幕左缘起算）。
     *
     * 全面屏手势把系统「返回」绑在左缘，纯边缘滑动经常直接退回桌面；参考
     * QQ 把打开区扩到屏幕左侧，中间偏左起手右滑也能开抽屉。取左 60% 屏宽
     * （下限 64 防窄屏退化成边缘手势）。
     */
    function drawerStartLimit(width) {
      const w = Number(width);
      if (!(w > 0)) return 96;
      return Math.max(64, Math.round(w * 0.6));
    }

    /**
     * 手势横向意图确认阈值（CSS px）。
     *
     * 位移达到它就锁定本次手势的方向（此后只做触发阈值的等待，不再重新
     * 判竖滑）。提前到 24px（触发阈值 48 的一半）是因为部分页面会在
     * touchstart 上 preventDefault，move 的派发随时可能被截断——意图确认
     * 得越早，手势越不容易被页面吃掉。
     */
    const SWIPE_ARM_PX = 24;

    /**
     * 横向滚动容器判定指标（纯函数）。
     *
     * @param {{scrollWidth:number, clientWidth:number, overflowX:string}} metrics
     * @returns {boolean} 该元素是否「真的能横滚」（宽出 4px 以上且 overflow-x 可滚）
     */
    function isHorizScrollerMetrics(metrics) {
      if (!metrics) return false;
      const scrollWidth = Number(metrics.scrollWidth);
      const clientWidth = Number(metrics.clientWidth);
      if (!(scrollWidth > clientWidth + 4)) return false;
      const overflowX = String(metrics.overflowX || '');
      return overflowX === 'auto' || overflowX === 'scroll';
    }

    /**
     * 横滚容器是否还能吞掉这个方向的手势（纯函数，作用于元素指标）。
     *
     * 手指右滑（dx>0）想让内容往右滚，需要 scrollLeft 还有余量；左滑看是否
     * 还没到右端。滚到边界后容器不再消费手势，抽屉接管——终端 / 宽表整页
     * 也能在最左端起手右滑开抽屉。
     *
     * @param {{scrollLeft:number, clientWidth:number, scrollWidth:number}} el
     * @param {number} dx 带符号位移（右正左负）
     * @returns {boolean} true = 让路给内容横滚
     */
    function scrollerConsumes(el, dx) {
      if (!el) return false;
      const scrollLeft = Number(el.scrollLeft) || 0;
      const clientWidth = Number(el.clientWidth) || 0;
      const scrollWidth = Number(el.scrollWidth) || 0;
      if (dx > 0) return scrollLeft > 0;
      return scrollLeft + clientWidth < scrollWidth - 1;
    }

    /**
     * 抽屉手势判定（纯函数）。
     *
     * 输入一次滑动的起点、位移与上下文，输出该手势应触发的动作：
     *   'open'  左起手区右滑且抽屉未开；
     *   'close' 抽屉已开时的左滑（不限起手位置，遮罩之外任何地方都能收）；
     *   'none'  竖滑 / 距离不足 / 起手出区 / 容器还要横滚 / 浮层挡着。
     *
     * @param {object} input
     * @param {number} input.dx 横向位移（CSS px，右正左负）
     * @param {number} input.dy 纵向位移（CSS px）
     * @param {number} input.startX 起手 x 坐标
     * @param {number} input.width 布局视口宽
     * @param {boolean} input.drawerOpen 抽屉当前是否展开
     * @param {boolean} input.blocked 浮层 / 设置页等拦截
     * @param {boolean} input.hScrollerConsumes 起手容器在该方向是否还能滚
     * @param {number} [min] 触发位移阈值，缺省 {@link SWIPE_MIN}
     * @returns {'open'|'close'|'none'}
     */
    function decideDrawerGesture(input, min) {
      const data = input || {};
      const dx = Number(data.dx);
      const dy = Number(data.dy);
      const limit = typeof min === 'number' ? min : SWIPE_MIN;
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) return 'none';
      if (data.blocked) return 'none';
      const horizontal = Math.abs(dx);
      if (horizontal < limit) return 'none';
      // 只认「横向明显大于纵向」：竖滑属于内容滚动。
      if (Math.abs(dy) > horizontal * 0.72) return 'none';
      if (data.hScrollerConsumes) return 'none';
      if (dx > 0) {
        if (data.drawerOpen) return 'none';
        const startX = Number(data.startX);
        if (!Number.isFinite(startX)) return 'none';
        if (startX > drawerStartLimit(data.width)) return 'none';
        return 'open';
      }
      return data.drawerOpen ? 'close' : 'none';
    }

    /** 松手吸附：位移比例阈值（不足此比例回到起点一侧）。 */
    const SETTLE_RATIO = 0.38;
    /** 松手吸附：速度阈值（px/ms），达到即按甩动方向吸附。 */
    const SETTLE_VELOCITY = 0.35;

    /**
     * 松手后抽屉吸附到哪一侧（纯函数）。
     *
     * 甩动优先（快速轻扫不必拖过半屏），否则按松手时的位置比例：比例 ≥
     * {@link SETTLE_RATIO} 吸附展开，否则收回。两个阈值都取偏小的值——
     * 手机上「拖出 1/3 屏 + 稍快」就该算明确的开抽屉意图。
     *
     * @param {boolean} wasOpen 拖拽开始时抽屉是否展开
     * @param {number} progress 松手时的位置比例（0 收起 → 1 展开）
     * @param {number} velocity 松手速度（px/ms，右正左负）
     * @returns {boolean} true = 吸附到展开
     */
    function drawerSettle(wasOpen, progress, velocity) {
      const p = Number(progress);
      const v = Number(velocity);
      const ratio = Number.isFinite(p) ? p : wasOpen ? 1 : 0;
      if (Number.isFinite(v) && Math.abs(v) >= SETTLE_VELOCITY) return v > 0;
      return ratio >= SETTLE_RATIO;
    }

    /**
     * 设置页左滑退出的松手吸附判定（纯函数）。
     *
     * 设置页全屏铺开，左滑退出语义与抽屉「展开后左滑收」一致：位移比例
     * （dx/width，左滑为负）越过 {@link SETTLE_RATIO} 或左甩速度达到
     * {@link SETTLE_VELOCITY} 就退出，否则弹回原位。
     *
     * @param {number} ratio 位移比例（左滑为负）
     * @param {number} velocity 水平速度 px/ms（左滑为负）
     * @returns {boolean} true = 关闭设置页
     */
    function settingsSettle(ratio, velocity) {
      const r = Number(ratio);
      const v = Number(velocity);
      const rv = Number.isFinite(r) ? r : 0;
      if (Number.isFinite(v) && Math.abs(v) >= SETTLE_VELOCITY) {
        // 甩动方向与位移同向才算退出意图，反向甩动视为弹回。
        return rv !== 0 && (v > 0) === (rv > 0);
      }
      return Math.abs(rv) >= SETTLE_RATIO;
    }

    /**
     * 换页目标下标：越界返回 -1（不循环）。
     *
     * 滑动换页最怕「滑到末页还继续滑」时跳到首页，所以这里只钳不绕。
     * `index` 为 -1 表示没找到激活项，按第 0 项起算。
     */
    function nextTabIndex(index, delta, count) {
      const total = Number(count);
      if (!(total > 0)) return -1;
      if (!(delta === 1 || delta === -1)) return -1;
      const base = Number(index) >= 0 ? Number(index) : 0;
      const next = base + delta;
      if (next < 0 || next >= total) return -1;
      return next;
    }

    function detectLang(locale) {
      try {
        const snap = (locale && typeof locale.getSnapshot === 'function' && locale.getSnapshot()) || null;
        const active = snap && (snap.active || snap.locale);
        if (typeof active === 'string' && active) return /^zh/i.test(active) ? 'zh' : 'en';
      } catch (error) {
        console.error('[dsh-mobile-layout] 读取 locale 失败：', error);
      }
      const htmlLang = document.documentElement.getAttribute('lang');
      if (htmlLang) return /^zh/i.test(htmlLang) ? 'zh' : 'en';
      return /^zh/i.test(navigator.language || '') ? 'zh' : 'en';
    }

    /**
     * 切换语言。
     *
     * `runtime.lang` 供事件回调直接读取；同时写一份 `state.lang`，让订阅了
     * state 的组件重新渲染——否则切语言后底部条、会话面板里的文案要等下一次
     * 状态变化才更新（语言服务本身不触发我们的组件重渲染）。
     */
    function setLang(locale) {
      const next = detectLang(locale);
      const changed = next !== runtime.lang || next !== state.lang;
      runtime.lang = next;
      if (changed) setState({ lang: next });
    }

    /** 权限模式短文案：输入行只放得下 2~4 个字。 */
    const SHORT_PERM = {
      zh: { full: '完全访问', workspace: '工作区', readonly: '只读' },
      en: { full: 'Full', workspace: 'Workspace', readonly: 'Read-only' },
    };

    /**
     * 从官方按钮 aria-label 提取权限短文案。
     * 官方：`访问模式，当前：完全权限` / `Access mode, current: Full access`。
     */
    function permissionShort(label, lang) {
      const table = SHORT_PERM[lang] || SHORT_PERM.en;
      const matched = /(?:当前|current)[：:\s]*([^，,]+)/i.exec(label || '');
      const value = (matched ? matched[1] : label || '').trim();
      if (/完全|full/i.test(value)) return table.full;
      if (/工作区|workspace/i.test(value)) return table.workspace;
      if (/仅可查看|只读|read[\s-]?only|view/i.test(value)) return table.readonly;
      return value.slice(0, 6) || table.full;
    }

    const EFFORT_CODE = { high: 'H', medium: 'M', low: 'L', max: 'Max', 高: 'H', 中: 'M', 低: 'L', 最高: 'Max' };

    /**
     * 从官方模型按钮 aria-label 提取 `V4.1 · H` 形式短名。
     * 官方：`选择模型，当前 DeepSeek-V4.1-Flash，推理等级 High`。
     */
    function modelShort(label) {
      const matched = /(?:当前|current)[：:\s]*([^，,]+)/i.exec(label || '');
      const full = (matched ? matched[1] : label || '').trim();
      const version = /([A-Za-z]*\d+(?:\.\d+)*)/.exec(full);
      const name = version ? version[1] : full.replace(/\s+/g, '').slice(0, 10);
      const effort = /(?:推理等级|思考等级|reasoning(?:\s*level)?|effort)[：:\s]*([A-Za-z\u4e00-\u9fa5]+)/i.exec(label || '');
      const raw = effort ? effort[1] : '';
      const code = EFFORT_CODE[raw.toLowerCase()] || EFFORT_CODE[raw] || '';
      return code ? name + ' \u00b7 ' + code : name;
    }

    /**
     * 给官方输入区按钮打短文案标记。
     *
     * 官方按钮在窄屏下把权限文案设为 display:none、模型文本整体保留但宽度
     * 被挤，这里不插 DOM（避免与 React 协调打架），只写 data-dshm-short，
     * 由 CSS 伪元素渲染短文案；完整名称仍在 aria-label 中供读屏使用。
     */
    function syncComposerChips() {
      const root = centerElement();
      if (!root) return;
      const buttons = root.querySelectorAll('button[aria-label], button[title]');
      for (const button of buttons) {
        const label = button.getAttribute('aria-label') || button.getAttribute('title') || '';
        if (/访问模式|access mode/i.test(label)) {
          markChip(button, ATTR_PERM_CHIP, permissionShort(label, runtime.lang));
          // 当前是「完全访问 / 完全权限 / Full access」时，chip 短文案与
          // 盾牌图标标红（aria-label 里就有当前模式，中英文都认）。
          const danger = /完全权限|完全访问|full[\s-]*access/i.test(label);
          if (danger !== button.hasAttribute(ATTR_PERM_DANGER)) {
            if (danger) button.setAttribute(ATTR_PERM_DANGER, '');
            else button.removeAttribute(ATTR_PERM_DANGER);
          }
        } else if (/选择模型|select model/i.test(label)) {
          markChip(button, ATTR_MODEL_CHIP, modelShort(label));
        } else if (/添加文件|调用指令|add file|add command|attach/i.test(label)) {
          // 输入行内的官方 ⊕ 隐藏（CSS display:none），只保留常驻条最右侧的
          // ⊕；按钮仍在 DOM 中，openOfficialAddMenu 仍可程序化点击它。
          if (!button.hasAttribute(ATTR_ADD_CHIP)) button.setAttribute(ATTR_ADD_CHIP, '');
        }
      }
      syncComposerPad();
      syncComposerFrame();
      syncStatsBar();
      syncHero();
      syncComposerEdge();
      tagStatsDialog();
    }

    /**
     * 标记统计胶囊打开的「Token 用量」详情对话框。
     *
     * 官方按胶囊位置向上展开，胶囊挪到标题栏下方后对话框会顶到屏幕顶部；
     * 这里改由 CSS 固定在状态带下方，不挤占输入区，也不影响底部弹层体系。
     */
    function tagStatsDialog() {
      if (state.mode !== MODE_MOBILE) return;
      for (const dialog of document.querySelectorAll('[role="dialog"]')) {
        if (dialog.hasAttribute(ATTR_STATS_DIALOG)) continue;
        const box = dialog.getBoundingClientRect();
        if (!box.width || !box.height) continue;
        // 插件自己的底部表也是 role=dialog，会话标题里出现「上下文 / 用量 / tok」
        // 时会被误判成统计浮层、被按固定小窗样式压住；加号面板里的弹窗同理，
        // 一律排除。
        if (dialog.classList.contains('dshm-sheet')) continue;
        if (dialog.closest('[' + ATTR_POPOVER + ']')) continue;
        // 抽屉同样是 role=dialog（手机形态），会话标题里可能出现「上下文」。
        if (dialog.hasAttribute(ATTR_SIDEBAR)) continue;
        // 设置弹窗里有「查询用量」这类文案，会误命中统计关键词；带页签导航的
        // 一定是设置页，直接跳过（否则设置页会被当成统计浮层压成固定小窗）。
        if (dialog.querySelectorAll('nav button, nav a, nav [role="tab"]').length >= 3) continue;
        if (!/tok|用量|usage|上下文|context/i.test(dialog.textContent || '')) continue;
        dialog.setAttribute(ATTR_STATS_DIALOG, '');
      }
    }

    /**
     * 把官方会话统计（轮次/速度、Token 用量、上下文占用）从输入区挪到
     * 会话标题栏下方，作为常驻状态带。
     *
     * 官方这三项都在 composer 的 dock 里（输入卡片下方），窄屏会挤占
     * 输入区；这里标记同时包含「Token 用量」与「上下文」按钮的容器为
     * 状态带，由 CSS 固定到标题栏下方，并让标题栏以同高内边距预留空间。
     * 两项按钮的 aria-label 均可能本地化，按 tok + 上下文关键词定位。
     */
    function syncStatsBar() {
      const html = document.documentElement;
      const root = centerElement();
      if (!root) {
        clearStatsBar();
        return;
      }
      const buttons = Array.from(root.querySelectorAll('button[aria-label]'));
      const usage = buttons.find((b) => /tok/i.test(b.getAttribute('aria-label') || ''));
      const context = buttons.find((b) => /上下文|context/i.test(b.getAttribute('aria-label') || ''));
      if (!usage || !context) {
        clearStatsBar();
        return;
      }
      let dock = usage.parentElement;
      for (let hop = 0; hop < 6 && dock && dock !== root; hop += 1) {
        if (dock.contains(context)) break;
        dock = dock.parentElement;
      }
      if (!dock || dock === root || !dock.contains(context)) {
        clearStatsBar();
        return;
      }
      const height = Math.max(16, Math.round(dock.getBoundingClientRect().height) || 26);
      const host = dock.parentElement;
      dock.setAttribute(ATTR_STATS, '');
      if (host) host.setAttribute(ATTR_STATS_HOST, '');
      const heightValue = height + 'px';
      if (html.style.getPropertyValue('--dshm-stats-height') !== heightValue) {
        html.style.setProperty('--dshm-stats-height', heightValue);
      }
      html.setAttribute('data-dshm-stats-on', '');
      const header = root.querySelector('header[data-window-drag]');
      if (header) {
        // 标题栏此时已含底部预留，状态带顶端 = 标题栏底边 - 状态带高度。
        const top = Math.max(0, Math.round(header.getBoundingClientRect().bottom) - height);
        const topValue = top + 'px';
        if (html.style.getPropertyValue('--dshm-stats-top') !== topValue) {
          html.style.setProperty('--dshm-stats-top', topValue);
        }
      }
    }

    /** 清除统计状态带标记（会话切到空态或离开手机布局时）。 */
    function clearStatsBar() {
      const html = document.documentElement;
      document.querySelectorAll('[' + ATTR_STATS + ']').forEach((node) => node.removeAttribute(ATTR_STATS));
      document.querySelectorAll('[' + ATTR_STATS_HOST + ']').forEach((node) => node.removeAttribute(ATTR_STATS_HOST));
      html.removeAttribute('data-dshm-stats-on');
      html.style.removeProperty('--dshm-stats-top');
      html.style.removeProperty('--dshm-stats-height');
    }

    /**
     * 标记 hero（空会话）态 composer 多余的下边距。
     *
     * 官方空会话把整段 composer 垂直居中，且 stack 带 32px 底部留白；手机
     * 竖屏要让输入行紧贴常驻条，这里找出 card 与 composerSeat 之间仍有底部
     * 内边距的祖先并打标记，由 CSS 清零。正常会话本身已贴底，不会命中。
     *
     * 标记一旦打上就保留：CSS 已把该节点 padding-bottom 归零，若再按计算值
     * 判断会因 0 < 8 而撤掉标记，导致 padding 恢复、下次同步又标记的来回抖动。
     * 失效标记由 clearAnchors 在离开手机布局时统一清理。
     */
    function syncComposerPad() {
      const seat = document.querySelector('[data-composer-seat]');
      if (!seat) return;
      const card = seat.querySelector('[data-composer-card]');
      if (!card) return;
      let node = card.parentElement;
      for (let hop = 0; hop < 8 && node && node !== seat; hop += 1) {
        if (node.hasAttribute(ATTR_COMPOSER_PAD)) {
          node = node.parentElement;
          continue;
        }
        if ((parseFloat(getComputedStyle(node).paddingBottom) || 0) >= 8) node.setAttribute(ATTR_COMPOSER_PAD, '');
        node = node.parentElement;
      }
    }

    /**
     * 输入卡与常驻条融合：官方输入卡是带圆角、边框和阴影的浮层，窄屏下
     * 会与下方常驻条割裂。这里给 card 到 composerSeat 之间的外壳打扁平标记，
     * 由 CSS 去掉圆角/边框/阴影与左右留白，使输入区与常驻条成为同一条
     * 全宽底部面板（标记保留，由 clearAnchors 统一清理）。
     */
    function syncComposerFrame() {
      const seat = document.querySelector('[data-composer-seat]');
      const card = seat && seat.querySelector('[data-composer-card]');
      if (!seat || !card) return;
      if (!card.hasAttribute(ATTR_COMPOSER_FLAT)) card.setAttribute(ATTR_COMPOSER_FLAT, '');
      let node = card.parentElement;
      for (let hop = 0; hop < 8 && node && node !== seat; hop += 1) {
        if (!node.hasAttribute(ATTR_COMPOSER_FLAT)) node.setAttribute(ATTR_COMPOSER_FLAT, '');
        node = node.parentElement;
      }
    }

    /**
     * 空会话 hero（图标 + 「探索未至之境」）脱离输入区，居中到信息页面。
     *
     * 官方把空态 hero 放在 composer 里的一层绝对定位浮层（root），内容块
     * 贴在浮层底端、紧挨输入卡。这里标记这层浮层，并沿「只有一个可见子节点」
     * 的链路找到真正的图标/标题内容块，再用 translateY 把它移到
     * 「标题栏/状态带下沿 → 输入卡上沿」的中点；浮层自身的布局与高度不变，
     * 不改变官方的定位基准。非空会话没有这样的兄弟子树，标记与位移一起清除。
     */
    function syncHero() {
      const html = document.documentElement;
      if (state.mode !== MODE_MOBILE || state.panelActive) {
        clearHero();
        return;
      }
      const seat = document.querySelector('[data-composer-seat]');
      const card = seat && seat.querySelector('[data-composer-card]');
      if (!seat || !card) {
        clearHero();
        return;
      }
      const cardRect = card.getBoundingClientRect();
      if (!cardRect.height || cardRect.top > window.innerHeight || cardRect.bottom < 0) {
        clearHero();
        return;
      }
      let best = null;
      let node = card.parentElement;
      for (let hop = 0; hop < 8 && node && node !== seat; hop += 1) {
        const parent = node.parentElement;
        if (!parent) break;
        for (const sibling of parent.children) {
          if (sibling === node || sibling.contains(card)) continue;
          const box = sibling.getBoundingClientRect();
          if (!box.width || box.height < 16 || box.width < 80) continue;
          if (box.bottom > cardRect.top - 1) continue;
          if (sibling.querySelector('input, textarea, select, [contenteditable="true"], [role="textbox"], [role="searchbox"]')) continue;
          const area = box.width * box.height;
          if (!best || area > best.area) best = { node: sibling, area };
        }
        node = parent;
      }
      if (!best) {
        clearHero();
        return;
      }
      const hero = best.node;
      if (!hero.hasAttribute(ATTR_HERO)) hero.setAttribute(ATTR_HERO, '');
      // 沿唯一可见子节点下钻，拿到真正的图标/标题内容块（而不是整层浮层）。
      let content = hero;
      for (let depth = 0; depth < 6; depth += 1) {
        const visible = Array.from(content.children).filter((child) => {
          const box = child.getBoundingClientRect();
          return box.width > 0 && box.height > 0;
        });
        if (visible.length !== 1) break;
        content = visible[0];
      }
      const heroRect = content.getBoundingClientRect();
      const stats = document.querySelector('[' + ATTR_STATS + ']');
      const statsRect = stats ? stats.getBoundingClientRect() : null;
      const center = centerElement();
      const header = center ? center.querySelector('header[data-window-drag]') : null;
      const headerRect = header ? header.getBoundingClientRect() : null;
      let contentTop = Math.max(0, Math.round(seat.getBoundingClientRect().top));
      if (statsRect && statsRect.height) contentTop = Math.round(statsRect.bottom);
      else if (headerRect && headerRect.height) contentTop = Math.round(headerRect.bottom);
      const available = cardRect.top - contentTop;
      const targetTop = contentTop + Math.max(0, Math.round((available - heroRect.height) / 2));
      const shift = Math.round((parseFloat(html.style.getPropertyValue('--dshm-hero-shift')) || 0) + (targetTop - heroRect.top));
      const shiftValue = shift + 'px';
      if (html.style.getPropertyValue('--dshm-hero-shift') !== shiftValue) {
        html.style.setProperty('--dshm-hero-shift', shiftValue);
      }
    }

    /**
     * 空会话的输入区顶端分界线下移到「工作区选择」行。
     *
     * 空态时 composerSeat 顶部到输入卡之间还留着官方的 hero 占位空白（实测
     * seat 顶 484、工作区选择行 541、card 顶 577），画在 seat 顶边上的分界线
     * 会悬在 hero 区域下方一大截。这里在 hero 生效时改把分界线画到输入卡
     * 上方紧邻的那条可见行（工作区 / 权限模式选择行）的顶边。
     *
     * 判定只看几何：seat 内、card 之上、底边贴合 card 顶、宽 ≥ seat 一半、
     * 高 16–60 的最外层块。没有 hero 或没找到时回到 seat 顶部原分界线。
     */
    function syncComposerEdge() {
      const html = document.documentElement;
      const seat = document.querySelector('[data-composer-seat]');
      const card = document.querySelector('[data-composer-card]');
      if (!seat || !card || state.mode !== MODE_MOBILE || !document.querySelector('[' + ATTR_HERO + ']')) {
        clearComposerEdge();
        return;
      }
      const seatRect = seat.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      // 逐个子节点量尺寸是这条链里最贵的一步；几何没变（seat 顶边 / 宽度、
      // 输入卡顶边都不动）而上次的标记节点还在，就直接沿用。
      const key = Math.round(seatRect.top) + ':' + Math.round(seatRect.width) + ':' + Math.round(cardRect.top);
      if (edgeState.key === key && edgeState.node && edgeState.node.isConnected) {
        html.setAttribute('data-dshm-composer-split', '');
        return;
      }
      let best = null;
      for (const node of seat.querySelectorAll('*')) {
        if (card.contains(node)) continue;
        const box = node.getBoundingClientRect();
        if (!box.width || !box.height) continue;
        if (box.top < seatRect.top || box.bottom > cardRect.top + 1) continue;
        if (box.width < seatRect.width * 0.5) continue;
        if (box.height < 16 || box.height > 60) continue;
        // 同一行常有多层嵌套（行容器 + 两个 chip），取最外层：同顶边时取更宽者。
        if (!best || box.top > best.box.top || (box.top === best.box.top && box.width > best.box.width)) {
          best = { node, box };
        }
      }
      if (!best) {
        clearComposerEdge();
        return;
      }
      if (best.node !== edgeState.node) {
        if (edgeState.node) edgeState.node.removeAttribute(ATTR_COMPOSER_EDGE);
        best.node.setAttribute(ATTR_COMPOSER_EDGE, '');
        edgeState.node = best.node;
      }
      edgeState.key = key;
      html.setAttribute('data-dshm-composer-split', '');
    }

    function clearComposerEdge() {
      if (edgeState.node) {
        edgeState.node.removeAttribute(ATTR_COMPOSER_EDGE);
        edgeState.node = null;
      }
      edgeState.key = '';
      document.documentElement.removeAttribute('data-dshm-composer-split');
    }

    function clearHero() {
      const html = document.documentElement;
      document.querySelectorAll('[' + ATTR_HERO + ']').forEach((node) => node.removeAttribute(ATTR_HERO));
      html.style.removeProperty('--dshm-hero-shift');
    }

    function markChip(button, attr, short) {
      if (!button.hasAttribute(attr)) button.setAttribute(attr, '');
      if (button.getAttribute('data-dshm-short') !== short) button.setAttribute('data-dshm-short', short);
    }

    /** 右栏全屏时把顶部 28px 工具按钮标记为 44px 触控目标。 */
    function syncRightbarChrome() {
      const col = document.querySelector('[' + ATTR_RIGHTBAR + ']');
      if (!col) return;
      for (const button of col.querySelectorAll('button')) {
        const rect = button.getBoundingClientRect();
        const isChrome = rect.width > 0 && rect.height > 0 && rect.top < 64 && rect.width <= 44 && rect.height <= 44;
        if (isChrome) {
          if (!button.hasAttribute(ATTR_CHROME_BTN)) button.setAttribute(ATTR_CHROME_BTN, '');
        } else if (button.hasAttribute(ATTR_CHROME_BTN)) {
          button.removeAttribute(ATTR_CHROME_BTN);
        }
      }
    }

    /** 插件级最小状态：模式、锚点、抽屉与右栏呈现，UI 组件自行订阅。 */
    const subscribers = new Set();
    let state = {
      mode: MODE_DEFAULT,
      anchored: false,
      drawerOpen: false,
      rightbarFullscreen: false,
      panelActive: false,
      sheet: null,
      popoverOpen: false,
      /** 当前文案语言（zh / en）；仅用于触发重渲染，读写统一走 setLang。 */
      lang: runtime.lang,
      /** 加号面板页数；≤1 页时为 0（不显示指示条）。 */
      addPageCount: 0,
      /** 设置弹窗是否处于手机端全屏态。 */
      settingsOpen: false,
    };

    function getState() {
      return state;
    }

    function setState(patch) {
      let changed = false;
      for (const key of Object.keys(patch)) {
        if (state[key] !== patch[key]) changed = true;
      }
      if (!changed) return;
      state = Object.assign({}, state, patch);
      subscribers.forEach((listener) => {
        try {
          listener(state);
        } catch (error) {
          console.error('[dsh-mobile-layout] 状态订阅者异常：', error);
        }
      });
    }

    function subscribe(listener) {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    }

    /** 组件钩子：订阅插件状态。 */
    function useLayoutState() {
      return react.useSyncExternalStore(subscribe, getState, getState);
    }

    // ---- DOM 锚点 ----
    const ATTR_FRAME = 'data-dshm-frame';
    const ATTR_SIDEBAR = 'data-dshm-sidebar';
    const ATTR_CENTER = 'data-dshm-center';
    const ATTR_RIGHTBAR = 'data-dshm-rightbar';
    const ATTR_BOTTOM = 'data-dshm-bottom';
    const ATTR_POPOVER = 'data-dshm-popover';
    /**
     * 手势让路标记：任何子树打上它，抽屉左滑手势一律不接管。
     * 给自带整页手势的第三方插件留的逃生口（读写都走 closest）。
     */
    const ATTR_SWIPE_IGNORE = 'data-dshm-swipe-ignore';
    /** 模型 / 权限选择器（带搜索框的贴底浮层）与其中选项段的标记。 */
    const ATTR_PICKER = 'data-dshm-picker';
    const ATTR_PICKER_DETAIL = 'data-dshm-picker-detail';
    const ATTR_PICKER_CHECK = 'data-dshm-picker-check';
    const ATTR_PERM_DANGER = 'data-dshm-perm-danger';
    const ATTR_PERM_CHIP = 'data-dshm-perm-chip';
    const ATTR_MODEL_CHIP = 'data-dshm-model-chip';
    const ATTR_CHROME_BTN = 'data-dshm-chrome-btn';
    const ATTR_ADD_CHIP = 'data-dshm-add-chip';
    const ATTR_COMPOSER_PAD = 'data-dshm-composer-pad';
    const ATTR_COMPOSER_FLAT = 'data-dshm-composer-flat';
    const ATTR_COMPOSER_EDGE = 'data-dshm-composer-edge';
    /** 空会话分界线当前落在的节点及其几何签名，避免每次同步重复扫描。 */
    const edgeState = { node: null, key: '' };
    const ATTR_STATS = 'data-dshm-stats';
    const ATTR_STATS_HOST = 'data-dshm-stats-host';
    const ATTR_STATS_DIALOG = 'data-dshm-stats-dialog';
    const ATTR_HEADER_MENU = 'data-dshm-header-menu';
    const ATTR_HEADER_MENU_HOST = 'data-dshm-header-menu-host';
    const ATTR_HEADER_MENU_OPEN = 'data-dshm-header-menu-open';
    /** 空会话工作区 / 模式选择行的官方菜单，改向上弹出。 */
    const ATTR_MENU_UP = 'data-dshm-menu-up';
    const ATTR_HERO = 'data-dshm-hero';
    /** 加号宫格分页：容器标记、每页首项的吸附点。 */
    const ATTR_ADD_PAGED = 'data-dshm-add-paged';
    const ATTR_ADD_PAGE_START = 'data-dshm-add-page-start';
    /** 图标胶囊上的配色标记（值即色板名，用于幂等比对）。 */
    const ATTR_ADD_TINT = 'data-dshm-tint';
    /** 设置弹窗（手机端全屏化）各部位标记。 */
    const ATTR_SETTINGS_PANEL = 'data-dshm-settings-panel';
    const ATTR_SETTINGS_BRAND = 'data-dshm-settings-brand';
    const ATTR_SETTINGS_NAV = 'data-dshm-settings-nav';
    const ATTR_SETTINGS_TABS = 'data-dshm-settings-tabs';
    const ATTR_SETTINGS_TITLE = 'data-dshm-settings-title';
    const ATTR_SETTINGS_CONTENT = 'data-dshm-settings-content';
    const ATTR_SETTINGS_HEAD = 'data-dshm-settings-head';
    const ATTR_SETTINGS_SCROLL = 'data-dshm-settings-scroll';
    const ATTR_SETTINGS_CLOSE = 'data-dshm-settings-close';
    const ATTR_SETTINGS_TOOL = 'data-dshm-settings-tool';
    const ATTR_SETTINGS_CARDS = 'data-dshm-settings-cards';
    /** 设置页左上角的返回键（插件自建，全屏后没有平台返回控件）。 */
    const ATTR_SETTINGS_BACK = 'data-dshm-settings-back';
    /** 滑动换页时给内容区打的临时标记，只用于播一次淡入。 */
    const ATTR_SETTINGS_SWAP = 'data-dshm-settings-swap';
    const SETTINGS_ATTRS = [
      ATTR_SETTINGS_PANEL,
      ATTR_SETTINGS_BRAND,
      ATTR_SETTINGS_NAV,
      ATTR_SETTINGS_TABS,
      ATTR_SETTINGS_TITLE,
      ATTR_SETTINGS_CONTENT,
      ATTR_SETTINGS_HEAD,
      ATTR_SETTINGS_SCROLL,
      ATTR_SETTINGS_CLOSE,
      ATTR_SETTINGS_TOOL,
      ATTR_SETTINGS_CARDS,
    ];

    /**
     * 标记官方 AppFrame 结构。
     *
     * 官方结构（0.2.1-rc.x）：frame = grid，子节点依次为 sidebarCol、
     * centerCol、rightbarCol（带 data-rightbar-col）、bottomRow
     * （data-shell-bottom）、overlayLayer（data-shell-overlay），其后可能还有
     * leadingSeat 与拖拽手柄。这里只用稳定属性 + 相邻关系定位。
     */
    function applyAnchors(doc) {
      const bottomRow = doc.querySelector('[data-shell-bottom]');
      const rightbar = doc.querySelector('[data-rightbar-col]');
      if (!bottomRow || !rightbar) return null;
      const frameEl = bottomRow.parentElement;
      if (!frameEl) return null;
      const sidebar = frameEl.firstElementChild;
      const center = rightbar.previousElementSibling;
      if (!sidebar || !center) return null;
      frameEl.setAttribute(ATTR_FRAME, '');
      sidebar.setAttribute(ATTR_SIDEBAR, '');
      center.setAttribute(ATTR_CENTER, '');
      rightbar.setAttribute(ATTR_RIGHTBAR, '');
      bottomRow.setAttribute(ATTR_BOTTOM, '');
      return frameEl;
    }

    function clearAnchors(doc) {
      [ATTR_FRAME, ATTR_SIDEBAR, ATTR_CENTER, ATTR_RIGHTBAR, ATTR_BOTTOM, ATTR_POPOVER, ATTR_PICKER, ATTR_PICKER_DETAIL, ATTR_PICKER_CHECK, ATTR_PERM_CHIP, ATTR_PERM_DANGER, ATTR_MODEL_CHIP, ATTR_CHROME_BTN, ATTR_ADD_CHIP, ATTR_COMPOSER_PAD, ATTR_COMPOSER_FLAT, ATTR_COMPOSER_EDGE, ATTR_STATS, ATTR_STATS_HOST, ATTR_STATS_DIALOG, ATTR_HEADER_MENU, ATTR_HEADER_MENU_HOST, ATTR_MENU_UP, ATTR_HERO].concat(SETTINGS_ATTRS, [ATTR_ADD_PAGED, ATTR_ADD_PAGE_START, ATTR_ADD_TINT]).forEach((attr) => {
        doc.querySelectorAll('[' + attr + ']').forEach((node) => node.removeAttribute(attr));
      });
      edgeState.node = null;
      edgeState.key = '';
      doc.documentElement.removeAttribute('data-dshm-composer-split');
      doc.documentElement.removeAttribute('data-dshm-settings-open');
      doc.documentElement.style.removeProperty('--dshm-menu-up-bottom');
    }

    /** 拿当前锚定后的 frame 元素；未锚定时返回 null。 */
    function frameElement() {
      const doc = document;
      const frame = doc.querySelector('[' + ATTR_FRAME + ']');
      return frame && frame.isConnected ? frame : null;
    }

    function isDrawerOpen() {
      const frame = frameElement();
      return Boolean(frame && !frame.hasAttribute('data-sidebar-collapsed'));
    }

    /** 中心列容器；官方 composer 与主内容都在其中。 */
    function centerElement() {
      const el = document.querySelector('[data-dshm-center]');
      return el && el.isConnected ? el : null;
    }

    /** 新建 / 切换会话后把焦点还给输入框（不强制拉起键盘）。 */
    function focusComposer() {
      const root = centerElement();
      if (!root) return;
      const target = root.querySelector('textarea, [contenteditable="true"]');
      if (target && typeof target.focus === 'function') target.focus();
    }

    /**
     * 收起 composer 焦点（软键盘随焦点离开而收起）。
     *
     * 面板与键盘互斥的公共出口：底部表（openSheet）与加号面板
     * （openOfficialAddMenu）打开前都收焦点，避免面板与输入法同屏。
     */
    function blurComposer() {
      const root = centerElement();
      if (!root) return;
      const active = root.querySelector('textarea, [contenteditable="true"]');
      if (active && typeof active.blur === 'function') active.blur();
    }

    /**
     * 浮层返回栈：抽屉或底部表打开时压入一条 history，Android 返回键 /
     * 浏览器后退先关闭浮层，而不是离开页面。
     */
    let overlayHistory = false;
    let suppressHistory = false;
    /** 返回键触发的关闭过渡：浮层要等动画/状态机收尾才真正消失，期间不能再压栈。 */
    let closingOverlay = false;
    let closingTimer = 0;
    /** ⊕ 的 pointerdown 让官方浮层关闭的时间戳；用于避免随后的 click 重开。 */
    let popoverClosedAt = 0;
    /** 加号面板本次打开的时间戳；面板与键盘互斥的兜底在打开后 800ms 内不动。 */
    let addMenuOpenedAt = 0;

    /**
     * 设置页是否真的在屏幕上。
     *
     * 状态位 `settingsOpen` 由 observer 同步，理论上会有一帧延迟；这里再加一条
     * 「已打标且量得出尺寸」的旁路，避免返回键在那一帧里被漏判（漏判的后果是
     * 越过 WebView 直接退出应用）。
     */
    function settingsPanelOpen() {
      if (state.settingsOpen) return true;
      const node = document.querySelector('[' + ATTR_SETTINGS_PANEL + ']');
      if (!node || !node.isConnected) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    function overlayVisible() {
      return (
        state.sheet !== null ||
        isDrawerOpen() ||
        state.rightbarFullscreen ||
        settingsPanelOpen() ||
        // 官方 ⊕ 浮层（加号面板）也压一条返回栈：官方自己不响应返回键，
        // 不接管就会一路退到桌面（真机实测：面板开着按返回直接退出应用）。
        state.popoverOpen ||
        Boolean(document.querySelector('[' + ATTR_POPOVER + ']')) ||
        // 头部 ⋯ 菜单同理。
        document.documentElement.hasAttribute(ATTR_HEADER_MENU_OPEN)
      );
    }

    /**
     * 返回键消费掉栈条目后进入「关闭过渡」。
     *
     * 关闭是异步的（官方弹窗要跑完动画、抽屉要过渡），期间 overlayVisible()
     * 仍为 true，若照常 pushState 就会多压一条，下一次按返回被它空转掉
     * （真机复现：设置页第一次返回只切了页签、第二次才关）。这里用闸门挡住，
     * 并在 700ms 后兜底重算，避免关闭没生效时把栈锁死。
     */
    function beginClosingOverlay() {
      closingOverlay = true;
      if (closingTimer) window.clearTimeout(closingTimer);
      closingTimer = window.setTimeout(() => {
        closingTimer = 0;
        closingOverlay = false;
        syncOverlayHistory();
      }, 700);
    }

    /** 按浮层可见性同步 history 条目；关闭时回退并复位标记。 */
    function syncOverlayHistory() {
      if (suppressHistory) return;
      // 默认布局下不碰浏览器历史，保持与官方完全一致。
      if (state.mode !== MODE_MOBILE) return;
      const visible = overlayVisible();
      if (closingOverlay) {
        // 正在关闭：条目已被返回键消费，等浮层真的消失再解除，不重复压栈。
        if (visible) return;
        closingOverlay = false;
        if (closingTimer) {
          window.clearTimeout(closingTimer);
          closingTimer = 0;
        }
        return;
      }
      if (visible && !overlayHistory) {
        overlayHistory = true;
        try {
          window.history.pushState({ dshmOverlay: true }, '');
        } catch (error) {
          console.warn('[dsh-mobile-layout] history.pushState 失败：', error);
        }
      } else if (!visible && overlayHistory) {
        overlayHistory = false;
        try {
          window.history.back();
        } catch (error) {
          console.warn('[dsh-mobile-layout] history.back 失败：', error);
        }
      }
    }

    /** 关闭当前底部表。 */
    function closeSheet() {
      if (state.sheet !== null) setState({ sheet: null });
      syncOverlayHistory();
    }

    /** 打开底部表；与抽屉、键盘互斥。 */
    function openSheet(name) {
      if (isDrawerOpen()) requestDrawer(false);
      blurComposer();
      setState({ sheet: name });
      syncOverlayHistory();
    }

    /** 新建会话：沿用官方 uiWorkspace.startSession，失败不动原会话。 */
    function startNewSession() {
      closeSheet();
      if (isDrawerOpen()) requestDrawer(false);
      const workspace = runtime.workspace;
      if (!workspace || typeof workspace.startSession !== 'function') {
        console.warn('[dsh-mobile-layout] uiWorkspace.startSession 不可用，忽略新建');
        return;
      }
      try {
        workspace.startSession();
      } catch (error) {
        console.error('[dsh-mobile-layout] 新建会话失败：', error);
        return;
      }
      requestAnimationFrame(() => window.setTimeout(focusComposer, 200));
    }

    /** 切到某个会话。 */
    function openSessionById(sessionId) {
      closeSheet();
      const workspace = runtime.workspace;
      if (!workspace || typeof workspace.openSession !== 'function') return;
      try {
        workspace.openSession(sessionId);
      } catch (error) {
        console.error('[dsh-mobile-layout] 打开会话失败：', sessionId, error);
      }
    }

    /** 打开官方插件全局面板。 */
    function openPluginPanel() {
      closeSheet();
      const layout = runtime.layout;
      if (!layout || typeof layout.selectPanel !== 'function') return;
      try {
        layout.selectPanel('plugins');
      } catch (error) {
        console.error('[dsh-mobile-layout] 打开插件面板失败：', error);
      }
    }

    /**
     * 把文件回流到官方隐藏 input[type=file]，由官方 onPickFiles → addFiles
     * 完成校验、上传与附件预览（本插件不造上传链路）。
     */
    function injectOfficialFiles(files) {
      if (!files || files.length === 0) return;
      const candidates = Array.from(document.querySelectorAll('input[type="file"]')).filter(
        (el) => !el.hasAttribute('data-dshm-input'),
      );
      const target = candidates.find((el) => el.multiple) || candidates[0];
      if (!target) {
        console.warn('[dsh-mobile-layout] 未找到官方文件输入，忽略本次选择');
        return;
      }
      try {
        const transfer = new DataTransfer();
        for (const file of files) transfer.items.add(file);
        target.files = transfer.files;
        target.dispatchEvent(new Event('change', { bubbles: true }));
      } catch (error) {
        console.error('[dsh-mobile-layout] 回流文件到官方输入失败：', error);
      }
    }

    /**
     * 短暂禁用 composer 输入控件（disabled / contenteditable=false），期间
     * 一切 focus() 都是 no-op，`ms` 后恢复原值并回调。
     *
     * 面板与键盘互斥的公共底座：开面板（openOfficialAddMenu）用它吞掉官方
     * 打开时的异步 refocus；面板开着点输入框（closeAddMenuForComposerTap）
     * 用它把键盘推迟到面板收完之后。`imeSuppressRestore` 供反向切换提前
     * 解除抑制——否则「开面板后立刻点输入框」会 focus 到禁用元素上，键盘
     * 不弹（真机复现）。
     */
    let imeSuppressRestore = null;

    function suppressComposerFocus(ms, onRestore) {
      const root = centerElement();
      const fields = [];
      if (root) {
        for (const el of root.querySelectorAll('textarea, [contenteditable="true"]')) {
          fields.push({
            el,
            editable: el.tagName !== 'TEXTAREA' ? el.getAttribute('contenteditable') : null,
          });
          try {
            if (el.tagName === 'TEXTAREA') el.disabled = true;
            else el.setAttribute('contenteditable', 'false');
          } catch (error) {
            /* 单个控件禁用失败不阻断 */
          }
        }
      }
      const restore = () => {
        for (const item of fields) {
          try {
            if (item.el.tagName === 'TEXTAREA') item.el.disabled = false;
            else if (item.editable === null) item.el.removeAttribute('contenteditable');
            else item.el.setAttribute('contenteditable', item.editable);
          } catch (error) {
            /* ignore */
          }
        }
        imeSuppressRestore = null;
        if (typeof onRestore === 'function') onRestore();
      };
      imeSuppressRestore = restore;
      window.setTimeout(restore, ms);
    }

    /**
     * 「面板 ⇄ 键盘」原位切换（揭开 / 覆盖模型）。
     *
     * 平台事实：系统键盘绘制在 WebView 之上，且 K70 实测 visualViewport 的
     * resize 是一次性跳变（开：focusin 后 ~126ms；收：一次 524↔875）——
     * Web 侧拿不到逐帧键盘动画，但也不需要：让面板与输入行「提前就位」，
     * 键盘自身的滑出 / 滑入动画会自然地把它们揭开 / 覆盖。
     *
     * 关键是 resize 跳变时刻的 padding 换算。输入行屏幕底距 =
     * (满高视口 - 可视视口) + frame padding-bottom。跳变前后各算一次，
     * 令 padding = 切换前屏幕底距 - (满高 - 当前视口)，输入行屏幕位置
     * 就保持不动；随后清掉内联 padding，由基础过渡滑到目标态——
     * 方向「键盘→面板」输入行随键盘下滑落到面板顶（hold = 旧键盘高），
     * 方向「面板→键盘」输入行原地不动被键盘覆盖（hold = 0，钳掉负数）。
     */
    let imeSwap = null;
    /** 「键盘→面板」方向的活动 focusin 守卫：吞掉官方 refocus，防键盘回弹。 */
    let imeFocusGuard = null;

    /** 当前可视视口高度（CSS px），取不到回退 innerHeight。 */
    function currentViewportH() {
      const vv = window.visualViewport;
      return Math.round((vv && Number(vv.height)) || window.innerHeight || 0);
    }

    /** 摘掉 focusin 守卫（settle 完成或异常早退时）。 */
    function removeImeFocusGuard() {
      if (imeFocusGuard) {
        document.removeEventListener('focusin', imeFocusGuard, true);
        imeFocusGuard = null;
      }
    }

    /** 切换开始：冻结 frame padding（内联覆盖，防 --dshm-panel-space 立即生效）。 */
    function startImeSwap(target) {
      const frame = document.querySelector('[' + ATTR_FRAME + ']');
      if (!frame) return;
      // 打上 swap 标记：面板的弹入 / 收起动画在切换期间冻结（CSS 侧
      // [data-dshm-swap] 规则），面板「原位就位」，由键盘动画揭开 / 覆盖。
      document.documentElement.setAttribute('data-dshm-swap', target);
      const padPre = parseFloat(getComputedStyle(frame).paddingBottom) || 0;
      frame.style.transition = 'none';
      frame.style.paddingBottom = padPre + 'px';
      imeSwap = {
        target,
        padPre,
        vbPre: currentViewportH(),
        timer: window.setTimeout(settleImeSwap, 600),
      };
      if (target === 'panel') {
        // 官方打开面板后会异步 refocus 输入框——键盘态下会让正在收起的键盘
        // 回弹。不能靠禁用输入框吞 refocus：新版官方 bundle 在 textarea
        // disabled 时 ⊕ 菜单打不开（真机实测）。改为守卫：composer 一拿到
        // 焦点就下一帧 blur——焦点态一闪而过，Android 键盘来不及拉起。
        imeFocusGuard = (ev) => {
          const t = ev.target;
          if (!t || !t.closest || !t.closest('textarea, [contenteditable="true"]')) return;
          window.setTimeout(() => {
            if (imeSwap && imeSwap.target === 'panel' && typeof t.blur === 'function') t.blur();
          }, 0);
        };
        document.addEventListener('focusin', imeFocusGuard, true);
      }
    }

    /** 切换落地：resize 跳变（或 600ms 兜底）后换算 padding 并滑向目标态。 */
    function settleImeSwap() {
      if (!imeSwap) return;
      const swap = imeSwap;
      imeSwap = null;
      window.clearTimeout(swap.timer);
      const frame = document.querySelector('[' + ATTR_FRAME + ']');
      const html = document.documentElement;
      if (!frame) {
        html.removeAttribute('data-dshm-swap');
        removeImeFocusGuard();
        return;
      }
      const vbNow = currentViewportH();
      const hold = Math.max(0, Math.round(swap.padPre + vbNow - swap.vbPre));
      frame.style.transition = 'none';
      frame.style.paddingBottom = hold + 'px';
      if (swap.target === 'panel' && !html.style.getPropertyValue('--dshm-panel-space')) {
        // 面板还没渲染完（官方异步打开 + resize 来得早）：保持 hold 位，
        // 等面板空间就绪后再落地，避免输入行先坠到底再弹起。
        imeSwap = { ...swap, timer: window.setTimeout(settleImeSwap, 80) };
        return;
      }
      // 回到基础规则：padding 由内联值过渡到 CSS 变量目标（panel-space 或 0），
      // frame 的 0.18s 过渡负责「输入行滑到面板顶」这最后一小段。
      void frame.offsetHeight;
      frame.style.transition = '';
      frame.style.paddingBottom = '';
      html.removeAttribute('data-dshm-swap');
      removeImeFocusGuard();
    }

    /**
     * ⊕ 面板开着时点了输入框：先收面板，再把焦点还给输入框拉起键盘。
     *
     * 加号宫格面板走「覆盖」：面板留在原地（swap 标记免收起动画），聚焦后
     * 键盘从其上方滑入把它盖住；frame padding 由 resize 换算保持输入行
     * 位置，键盘盖满后输入行已在键盘顶上（见 {@link startImeSwap}）。
     * 其余弹层（权限 / 模型选择器等）维持原路径：短暂禁用输入控件吞掉
     * 本次官方聚焦，350ms 后恢复并聚焦，避免键盘与收起动画交叉。
     */
    function closeAddMenuForComposerTap(event) {
      if (!state.popoverOpen && !document.querySelector('[' + ATTR_POPOVER + ']')) return false;
      const root = centerElement();
      if (!root) return false;
      const target = event.target;
      if (!target || typeof target.closest !== 'function') return false;
      const input = target.closest('textarea, [contenteditable="true"]');
      if (!input || !root.contains(input)) return false;
      const html = document.documentElement;
      const surface = document.querySelector('[' + ATTR_POPOVER + ']');
      if (surface && surface.querySelector('[' + ATTR_ADD_PAGED + ']')) {
        startImeSwap('kb');
        // 面板可能刚打开、抑制还在窗口内：先解除，否则 focusComposer()
        // 落在禁用元素上，键盘不弹。
        if (imeSuppressRestore) imeSuppressRestore();
        closeOfficialAddMenu();
        focusComposer();
        // 官方收面板会重渲染 composer、可能重建输入框节点——立即聚焦会被
        // remount 顶掉（真机复现：键盘不弹）。150/320ms 各补一次聚焦；
        // 期间用户若又打开了面板则不抢焦点。
        const refocus = () => {
          if (!state.popoverOpen && !document.querySelector('[' + ATTR_POPOVER + ']')) focusComposer();
        };
        window.setTimeout(refocus, 150);
        window.setTimeout(refocus, 320);
        // 面板收起会让布局下沉，紧随 pointerdown 的 mousedown/click 会落到
        // 下沉后位于指针下的元素上（真机复现：误开「请选择模型」「标准模式」
        // 菜单——菜单入口响应 mousedown，只吞 click 不够）。400ms 内吞掉
        // 后续的鼠标系事件——聚焦输入框不需要它们。
        const types = ['pointerup', 'mousedown', 'mouseup', 'click'];
        const swallow = (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
        };
        for (const type of types) document.addEventListener(type, swallow, true);
        window.setTimeout(() => {
          for (const type of types) document.removeEventListener(type, swallow, true);
        }, 400);
        return true;
      }
      closeOfficialAddMenu();
      suppressComposerFocus(350, () => {
        if (!state.popoverOpen && !document.querySelector('[' + ATTR_POPOVER + ']')) focusComposer();
      });
      return true;
    }

    /** 面板退场动画互斥位：退场进行中不重复触发。 */
    const popoverFx = { closing: false };

    /** 收起已展开的官方 composer 弹层（⊕ 再次点击时用）。 */
    function closeOfficialAddMenu() {
      if (popoverFx.closing) return;
      const panel = document.querySelector('[' + ATTR_POPOVER + ']');
      const finish = () => {
        popoverFx.closing = false;
        setState({ popoverOpen: false });
      };
      let reduce = false;
      try {
        reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      } catch (error) {
        reduce = false;
      }
      const PointerCtor = typeof window.PointerEvent === 'function' ? window.PointerEvent : window.MouseEvent;
      const dismiss = () => {
        // 给 body 派发 pointerdown 触发官方点击外部关闭，不产生 click，
        // 避免点穿到下面的元素。
        document.body.dispatchEvent(new PointerCtor('pointerdown', { bubbles: true }));
        finish();
      };
      if (!panel || reduce) {
        dismiss();
        return;
      }
      // 退场动画：面板下滑离场后再走官方关闭；这期间 frame 的预留高度还在，
      // 输入行保持在面板顶上方，面板走完输入行才回落（syncPanelSpace 收尾）。
      popoverFx.closing = true;
      panel.style.setProperty('transition', 'translate 160ms cubic-bezier(0.4, 0, 1, 1)', 'important');
      panel.style.setProperty('translate', '0 105%', 'important');
      window.setTimeout(() => {
        panel.style.removeProperty('transition');
        panel.style.removeProperty('translate');
        dismiss();
      }, 170);
    }

    /**
     * 收起插件的头部 ⋯ 菜单。官方菜单同样不响应返回键，返回时由插件代为收起：
     * 派发一次 body pointerdown 走官方「点击外部关闭」，再清掉插件标记兜底。
     */
    function closeHeaderMenu() {
      const PointerCtor = typeof window.PointerEvent === 'function' ? window.PointerEvent : window.MouseEvent;
      document.body.dispatchEvent(new PointerCtor('pointerdown', { bubbles: true }));
      const html = document.documentElement;
      html.removeAttribute(ATTR_HEADER_MENU_OPEN);
      html.style.removeProperty('--dshm-header-menu-top');
      html.style.removeProperty('--dshm-header-menu-right');
      document.querySelectorAll('[' + ATTR_HEADER_MENU_HOST + ']').forEach((node) => node.removeAttribute(ATTR_HEADER_MENU_HOST));
    }

    /** 点击官方 composer 的「添加文件或调用指令」按钮，打开官方加号菜单。 */
    function openOfficialAddMenu() {
      closeSheet();
      // 已展开时再点 ⊕ 收起（真实 pointerdown 可能已让官方先关闭，这里兜底）。
      if (state.popoverOpen || document.querySelector('[' + ATTR_POPOVER + ']')) {
        closeOfficialAddMenu();
        return true;
      }
      const root = centerElement();
      if (!root) return false;
      const buttons = root.querySelectorAll('button[aria-label], button[title]');
      for (const button of buttons) {
        const label = (button.getAttribute('aria-label') || button.getAttribute('title') || '').toLowerCase();
        if (/添加文件|调用指令|add file|add command|attach/.test(label)) {
          // 面板与键盘互斥：官方打开面板时会把焦点放回输入框——先 blur 也会
          // 被 refocus，真机上键盘「拉起→收起→再弹面板」体验交叉。这里把
          // 输入控件短暂禁用（suppressComposerFocus）：focus() 是 no-op，
          // 官方 refocus 直接落空，600ms 后恢复输入。
          // 键盘开着时走「揭开」：面板免弹入动画立即就位（在键盘下方，被盖
          // 住），键盘滑落时把它揭出来；frame padding 由 resize 换算保持输
          // 入行屏幕位置，随后滑落到面板顶（见 {@link startImeSwap}）。
          const activeEl = document.activeElement;
          const imeUp =
            activeEl &&
            root.contains(activeEl) &&
            (activeEl.tagName === 'TEXTAREA' || activeEl.isContentEditable);
          if (imeUp) {
            // 键盘态走「揭开」：面板免弹入就位（在键盘下方被盖住），键盘滑落
            // 把它揭出来；frame padding 由 resize 换算保持输入行屏幕位置。
            // 不能禁用输入框吞 refocus——新版官方 bundle 在 textarea disabled
            // 时 ⊕ 菜单打不开（真机实测），改由 startImeSwap 挂 focusin 守卫。
            startImeSwap('panel');
            blurComposer();
            addMenuOpenedAt = Date.now();
            button.click();
          } else {
            blurComposer();
            addMenuOpenedAt = Date.now();
            // 无键盘态：短暂禁用吞掉官方 refocus，防止面板开着键盘被拉起
            // （输入框 disabled 不影响无键盘态的菜单渲染，真机已验）。
            suppressComposerFocus(600);
            button.click();
          }
          window.setTimeout(tagComposerMenus, 0);
          window.setTimeout(blurComposer, 120);
          window.setTimeout(tagComposerMenus, 120);
          window.setTimeout(blurComposer, 250);
          return true;
        }
      }
      return false;
    }

    /** 从浮层节点向上找定位根（absolute/fixed 且 z-index>=100）。 */
    function positionedRoot(node) {
      let el = node;
      while (el && el !== document.body) {
        const style = window.getComputedStyle(el);
        if ((style.position === 'absolute' || style.position === 'fixed') && Number(style.zIndex) >= 100) return el;
        el = el.parentElement;
      }
      return null;
    }

    /**
     * 给选择器（模型 / 权限）选项内的段落打角色标记。
     *
     * 模型行是「名称 + ✓」两段，权限行是「名称 + 描述 + ✓」三段，段数不定，
     * CSS 没法只按位置区分（Android 12 的 WebView 也没有 :has）；这里按内容
     * 判定——含 svg 的是选中勾，纯文本的是描述。官方切换选中、搜索过滤都会
     * 重渲染行，所以每次同步都重打一遍。
     *
     * @param {Element} root 打了 ATTR_PICKER 的定位根
     */
    /** 「完全访问」是高危权限：无论一级菜单还是选择器，标题恒标红（中英文都认）。 */
    function isFullAccessTitle(text) {
      return /^(完全访问|完全权限|full\s+access)$/i.test(String(text || '').replace(/\s+/g, ' ').trim());
    }

    /**
     * 给单个权限选项行打/撤危险标记。
     *
     * @param {Element} row role=option / menuitem / menuitemradio 行
     * @param {string} title 行标题文本（选择器取第一段，菜单取整行文本）
     */
    function tagPermissionDanger(row, title) {
      const danger = isFullAccessTitle(title);
      if (danger === row.hasAttribute(ATTR_PERM_DANGER)) return;
      if (danger) row.setAttribute(ATTR_PERM_DANGER, '');
      else row.removeAttribute(ATTR_PERM_DANGER);
    }

    function tagPickerOptions(root) {
      for (const row of Array.from(root.querySelectorAll('[role="option"]'))) {
        const spans = row.querySelectorAll(':scope > span');
        // 只按标题文本精确匹配，避免模型名之类的普通文本误伤。
        tagPermissionDanger(row, (spans[0] && spans[0].textContent) || '');
        for (let i = 1; i < spans.length; i += 1) {
          const span = spans[i];
          const isCheck = Boolean(span.querySelector('svg'));
          const attr = isCheck ? ATTR_PICKER_CHECK : ATTR_PICKER_DETAIL;
          if (!span.hasAttribute(attr)) span.setAttribute(attr, '');
          const other = isCheck ? ATTR_PICKER_DETAIL : ATTR_PICKER_CHECK;
          if (span.hasAttribute(other)) span.removeAttribute(other);
        }
      }
    }

    // ---- 选择器（模型 / 权限）搜索框焦点守卫 ----
    /**
     * 打开模型 / 权限选择器时官方会 autoFocus 顶部搜索框，手机端直接拉起
     * 软键盘，把刚弹出的选项列表盖掉大半。守卫策略：搜索框在没有用户
     * 触碰（pointerdown 落在搜索框本身）的情况下拿到焦点，立即 blur；
     * 用户主动点搜索框过滤的正常路径不受影响。
     *
     * 两条路径互补：
     * 1. 挂载 autofocus 发生在 observer 打标记之前，focusin 时还查不到
     *    ATTR_PICKER——由 tagComposerMenus 选择器分支的「新开一次」检测兜住
     *    （同一微任务帧内 blur，Android 键盘来不及拉起，见 imeFocusGuard）；
     * 2. 之后官方异步 refocus / 重渲染回焦，焦点已带标记，由全局 focusin
     *    守卫收掉。
     */
    const pickerFocusGuard = { lastTouch: 0, openNode: null, installed: false };

    /** 用户是否刚碰过选择器搜索框（500ms 内的手势视为主动聚焦意图）。 */
    function pickerSearchRecentlyTouched() {
      return Date.now() - pickerFocusGuard.lastTouch < 500;
    }

    /** 非用户意图的自动落焦才收（500ms 内有触碰放行）。返回是否 blur 了。 */
    function blurInputIfAuto(input) {
      if (document.activeElement !== input) return false;
      if (pickerSearchRecentlyTouched()) return false;
      if (typeof input.blur !== 'function') return false;
      input.blur();
      return true;
    }

    /** 焦点在选择器根内且非用户意图时收掉。返回是否真的 blur 了。 */
    function blurPickerSearchAuto(root) {
      const active = document.activeElement;
      if (!active || active.tagName !== 'INPUT' || !root.contains(active)) return false;
      return blurInputIfAuto(active);
    }

    /**
     * 安装全局守卫（bootstrap 一次）：pointerdown 记录用户落在搜索框上的
     * 手势时间戳；focusin 捕获阶段收掉非用户意图的搜索框焦点。
     *
     * 识别两条线：
     * - 带 ATTR_PICKER 标记的选择器根（tagComposerMenus 打的）；
     * - placeholder 以「搜索 / Search」开头的输入框——空态选择器（如模型
     *   列表为空时「暂无可用模型」）没有 [role=listbox] 选项结构、打不上
     *   标记（K70 实测官方 autoFocus 照样拉起软键盘），退而按搜索框语义
     *   兜底识别。
     *
     * @param {Document} doc
     */
    function installPickerFocusGuard(doc) {
      if (pickerFocusGuard.installed) return;
      pickerFocusGuard.installed = true;
      doc.addEventListener('pointerdown', (event) => {
        const target = event.target;
        if (!target || !target.closest) return;
        // 已打标记的选择器内输入框：一律视为用户意图（placeholder 属性可能
        // 缺失，不能按语义二次过滤——漏记会把用户自己的聚焦也 blur 掉）。
        if (target.closest('[data-dshm-picker] input')) {
          pickerFocusGuard.lastTouch = Date.now();
          return;
        }
        // 未打标记的空态选择器：按搜索框语义识别。
        const searchInput = target.closest('input[placeholder]');
        if (searchInput && /^(搜索|search)/i.test(String(searchInput.getAttribute('placeholder') || '').trim())) {
          pickerFocusGuard.lastTouch = Date.now();
        }
      }, true);
      doc.addEventListener('focusin', (event) => {
        const target = event.target;
        if (!target || target.tagName !== 'INPUT' || !target.closest) return;
        const pickerRoot = target.closest('[data-dshm-picker]');
        if (pickerRoot) {
          blurPickerSearchAuto(pickerRoot);
          return;
        }
        const placeholder = String(target.getAttribute('placeholder') || '').trim();
        if (/^(搜索|search)/i.test(placeholder)) blurInputIfAuto(target);
      }, true);
    }

    /**
     * 在空会话的工作区 / 模式选择行里找到与弹层横向对齐的展开中按钮。
     *
     * 官方这两个选择器把菜单固定在按钮下沿（实测按钮 20,541 122×28、菜单
     * 20,573），而该行已靠近屏幕底部，向下展开会压住输入卡；返回按钮矩形
     * 供调用方改画到按钮上方。
     */
    function edgeMenuAnchor(row, box) {
      for (const button of row.querySelectorAll('button[aria-expanded="true"]')) {
        const rect = button.getBoundingClientRect();
        if (box.left <= rect.right + 12 && box.right >= rect.left - 12) return rect;
      }
      return null;
    }

    /**
     * 撤掉已经失效的弹层标记。
     *
     * 加号面板的定位根标记是「打上就不撤」的，而 `overlayVisible()`、返回栈、
     * `state.popoverOpen` 都靠 `querySelector('[data-dshm-popover]')` 判断有无浮层。
     * 官方若在关闭后仍把定位根挂在树上（渲染成 0 高度的空壳），标记就会一直
     * 为真：插件误以为浮层还开着，压过的那条 history 收不回去，返回键被空转
     * 吃掉。这里在每次同步前把「已卸载 / 量不出高度」的标记清掉。
     */
    function prunePopoverMarks() {
      for (const node of Array.from(document.querySelectorAll('[' + ATTR_POPOVER + ']'))) {
        const drop = () => {
          node.removeAttribute(ATTR_POPOVER);
          node.removeAttribute(ATTR_PICKER);
          // 守卫的「新开一次」检测随之复位：官方复用同一节点重开选择器时
          // 也要再收一次 autofocus。
          if (pickerFocusGuard.openNode === node) pickerFocusGuard.openNode = null;
        };
        if (!node.isConnected) {
          drop();
          continue;
        }
        if (node.getBoundingClientRect().height > 0) continue;
        // 定位根本身可能是 0 高度的锚点（菜单绝对定位在里面撑开），
        // 只要内部还有可见菜单就仍然算打开。
        const menu = node.querySelector('[role="listbox"], [role="menu"]');
        if (menu && menu.getBoundingClientRect().height > 0) continue;
        drop();
      }
    }

    /**
     * 给官方输入区弹层打移动端标记。
     *
     * 加号菜单 role=listbox，权限/模型菜单 role=menu，都是 position:absolute、
     * z-index>=100 的浮层；官方可能把浮层 portal 到 body，因此按「不在侧栏 /
     * 全局面板内」过滤，再向上找到定位根打属性。CSS 只在
     * html[data-dshm-mode="mobile"] 下把定位根固定到底部条上方。
     *
     * @param {boolean} [marksPruned] 调用方已在本轮同步里清过失效标记（observer
     *   每帧先 prune 再进来），传 true 跳过重复的全文档查询与 rect 测量。
     */
    function tagComposerMenus(marksPruned) {
      if (state.mode !== MODE_MOBILE) return;
      if (!marksPruned) prunePopoverMarks();
      if (state.panelActive) return;
      const sidebar = document.querySelector('[' + ATTR_SIDEBAR + ']');
      let hit = false;
      let headerMenuOpen = false;
      const menus = document.querySelectorAll('[role="listbox"], [role="menu"]');
      const edgeRow = document.querySelector('[' + ATTR_COMPOSER_EDGE + ']');
      for (const menu of menus) {
        if (sidebar && sidebar.contains(menu)) continue;
        const box = menu.getBoundingClientRect();
        if (!box.width || !box.height) continue;
        // 顶栏 ⋯（更多操作）的菜单挂在 header 内，保持右上角下拉形态；输入区
        // 的权限 / 模型与加号菜单挂在 composer 内，走各自的原始形态或贴底面板。
        // 不能用菜单自身 y 坐标判断：加号宫格较高时向上展开，顶部也会落在页面上半区。
        const header = document.querySelector('[' + ATTR_CENTER + '] header[data-window-drag]');
        if (header && header.contains(menu)) {
          headerMenuOpen = true;
          const topTarget = positionedRoot(menu) || menu;
          if (!topTarget.hasAttribute(ATTR_HEADER_MENU)) topTarget.setAttribute(ATTR_HEADER_MENU, '');
          // 官方把菜单挂在 headerUtilities 里，中间几层没有形成层叠上下文，
          // 于是 header 内的 _tabs（对话/轨迹 切换条，透明但全宽）在命中顺序上
          // 压过菜单首行，首项（下载 Session 日志）点不到。这里给菜单到 header
          // 之间的祖先链打标记，展开期间由 CSS 抬成层叠上下文。
          let host = topTarget.parentElement;
          for (let hop = 0; hop < 6 && host && host !== header; hop += 1) {
            if (!host.hasAttribute(ATTR_HEADER_MENU_HOST)) host.setAttribute(ATTR_HEADER_MENU_HOST, '');
            host = host.parentElement;
          }
          // 菜单紧贴 ⋯ 按钮下沿，右缘紧贴窗口。
          const trigger = header.querySelector('button[aria-label="更多操作"], button[aria-label="More actions"]');
          const anchor = trigger || header;
          const top = Math.max(0, Math.round(anchor.getBoundingClientRect().bottom)) + 2;
          const html = document.documentElement;
          const topValue = top + 'px';
          if (html.style.getPropertyValue('--dshm-header-menu-top') !== topValue) {
            html.style.setProperty('--dshm-header-menu-top', topValue);
          }
          // 右缘贴边自校正：Android WebView（页面上有 0.9 初始缩放）里，
          // 官方浮层定位根的 fixed 包含块右缘会比窗口窄一截，`right: 0`
          // 落在窗口内侧；这里量出实际空档，反向补偿到 --dshm-header-menu-right，
          // 每帧按需修正，窗口尺寸变化后也能回正。
          const rect = topTarget.getBoundingClientRect();
          const gap = Math.round(window.innerWidth - rect.right);
          if (gap !== 0) {
            const applied = parseFloat(getComputedStyle(topTarget).right) || 0;
            const rightValue = applied - gap + 'px';
            if (html.style.getPropertyValue('--dshm-header-menu-right') !== rightValue) {
              html.style.setProperty('--dshm-header-menu-right', rightValue);
            }
          }
          continue;
        }
        // 空会话工作区 / 模式选择的官方菜单默认向下展开（实测从行底 569
        // 起），会压住输入卡；这里改画到该行按钮上方，贴着行顶边。
        const anchorBox = edgeRow ? edgeMenuAnchor(edgeRow, box) : null;
        if (anchorBox) {
          const target = positionedRoot(menu) || menu;
          const bottomValue = Math.max(0, Math.round(window.innerHeight - anchorBox.top + 6)) + 'px';
          const html = document.documentElement;
          if (html.style.getPropertyValue('--dshm-menu-up-bottom') !== bottomValue) {
            html.style.setProperty('--dshm-menu-up-bottom', bottomValue);
          }
          if (!target.hasAttribute(ATTR_MENU_UP)) target.setAttribute(ATTR_MENU_UP, '');
          continue;
        }
        // 权限 / 模型的一级菜单（role=menu）保持官方原始弹层形态，不并入
        // 底部面板；宫格与选择器（模型 / 权限的带搜索浮层）走贴底面板。
        if (menu.getAttribute('role') === 'menu' || menu.querySelector('[role="menuitem"]')) {
          // 官方形态不动，只给「完全访问」选项标红（工作区 / 只读不受影响）。
          for (const item of Array.from(
            menu.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="option"]')
          )) {
            tagPermissionDanger(item, item.textContent);
          }
          continue;
        }
        const target = positionedRoot(menu);
        if (!target) continue;
        if (!target.hasAttribute(ATTR_POPOVER)) {
          target.setAttribute(ATTR_POPOVER, '');
          hit = true;
        }
        if (menu.getAttribute('role') === 'listbox') {
          // 选择器的 surface 里带搜索框，加号宫格没有：两者分开造型，
          // 选择器按整行列表处理，宫格继续走分页 + 配色。
          if (target.querySelector('input')) {
            if (!target.hasAttribute(ATTR_PICKER)) target.setAttribute(ATTR_PICKER, '');
            tagPickerOptions(target);
            // 选择器新开一轮：收掉官方 autofocus 到搜索框上的焦点，防止
            // 软键盘一开就盖住选项列表（用户点搜索框的正常路径放行，见
            // installPickerFocusGuard 头注释里的两条互补路径）。
            if (pickerFocusGuard.openNode !== target) {
              pickerFocusGuard.openNode = target;
              blurPickerSearchAuto(target);
            }
            // 官方把宫格换成选择器（点「模型 / 权限」）时旧宫格节点直接消失，
            // 分页圆点还挂在 state 上；这里连节点状态一起撤。
            if (addPagingState.node && !addPagingState.node.isConnected) {
              addPagingState.node = null;
              addPagingState.signature = '';
            }
            if (state.addPageCount) setState({ addPageCount: 0 });
          } else {
            // 面板已打开时仍要重算分页：order 可能被官方重渲染覆盖，也让项数
            // 变化（插件动态追加指令）能立刻反映到页签。
            syncAddPaging(menu);
            // 加号面板与键盘互斥的其他路径兜底：任何途径打开面板后官方把焦点
            // 放回输入框（拉起软键盘），这里收掉。刚打开的 800ms 内不动——
            // openOfficialAddMenu 的延迟收焦点尚未落定，避免和官方异步 focus
            // 竞争；选择器（带搜索框）走上面的 picker 分支，不受影响。
            if (Date.now() - addMenuOpenedAt > 800) {
              const center = centerElement();
              const activeEl = document.activeElement;
              const inComposer =
                activeEl &&
                center &&
                center.contains(activeEl) &&
                (activeEl.tagName === 'TEXTAREA' || activeEl.isContentEditable);
              if (inComposer && typeof activeEl.blur === 'function') activeEl.blur();
            }
          }
        }
      }
      // 顶栏菜单与统计状态带在 y 轴上重叠，而状态带位于 composerSeat(z:7)
      // 的层叠上下文内、部分 WebView 会压过固定在 header 里的菜单；菜单打开
      // 期间暂时隐藏状态带，关闭后自动恢复。
      const html = document.documentElement;
      if (headerMenuOpen) html.setAttribute(ATTR_HEADER_MENU_OPEN, '');
      else {
        html.removeAttribute(ATTR_HEADER_MENU_OPEN);
        document.querySelectorAll('[' + ATTR_HEADER_MENU_HOST + ']').forEach((node) => node.removeAttribute(ATTR_HEADER_MENU_HOST));
      }
      // 选择行菜单关闭后清掉向上定位的位移变量。
      if (!document.querySelector('[' + ATTR_MENU_UP + ']')) html.style.removeProperty('--dshm-menu-up-bottom');
      // 弹层互斥：任意官方 composer 弹层出现时收起插件底部表。
      if (hit && state.sheet !== null) closeSheet();
      syncPanelSpace();
      // 官方弹层/头部菜单的开合都要反映到返回栈，返回键才会先收浮层。
      syncOverlayHistory();
    }

    // ---- 加号面板：两行宫格 + 横向分页 ----
    /** 当前分页容器与页签签名；签名不变就不 setState，避免每帧重渲染。 */
    const addPagingState = { node: null, signature: '' };

    /**
     * 按 DOM 顺序收集加号面板的选项与所属分组。
     *
     * 官方结构（0.2.1-rc.4 实测）：`[role=listbox]` 的直接子节点交替为
     * `div[role=presentation]`（分组标题，display:none，textContent 仍可读）
     * 与 `button[role=option]`。标题之后到下一个标题之前都属于该组。
     *
     * @param {Element} listbox
     * @returns {Array<{node: Element, group: string, key: string}>}
     */
    function collectAddOptions(listbox) {
      const out = [];
      let group = '';
      for (const child of Array.from(listbox.children)) {
        if (child.getAttribute('role') === 'option') {
          out.push({ node: child, group, key: addOptionKey(optionTexts(child), group) });
          continue;
        }
        // 选项被分组容器包裹时无法按平级顺序判定，交给下面的兜底。
        if (child.querySelector('[role="option"]')) return [];
        const label = (child.textContent || '').replace(/\s+/g, ' ').trim();
        if (label) group = label.slice(0, 10);
      }
      if (out.length) return out;
      return Array.from(listbox.querySelectorAll('[role="option"]')).map((node) => ({
        node,
        group: '',
        key: addOptionKey(optionTexts(node), ''),
      }));
    }

    /** 选项内各 span 的文本：名称 / 别名 / 描述。 */
    function optionTexts(node) {
      return Array.from((node && node.querySelectorAll('span')) || [])
        .map((span) => (span.textContent || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean);
    }

    /**
     * 数一数「分组标题」行有几个。
     *
     * 加号菜单用 `[role=presentation]` 做分组标题（display:none，textContent
     * 仍可读）；桌宠 / 模型这类 composer 列表也是 `[role=listbox]`，但没有这个
     * 结构。分页只对加号菜单生效，避免把别的列表也改成两行翻页。
     */
    function countSectionTitles(listbox) {
      let count = 0;
      for (const child of Array.from(listbox.children)) {
        if (child.getAttribute('role') === 'option') continue;
        if (child.querySelector('[role="option"]')) continue;
        if ((child.textContent || '').replace(/\s+/g, ' ').trim()) count += 1;
      }
      return count;
    }

    /**
     * 判断某个选项是否要从面板里过滤掉（与常驻条重复）。
     *
     * 官方选项是 `button[role=option]`，内部 span 依次为图标 / 名称 / 别名 /
     * 描述；这里只按「纯文本等于名称或别名」匹配，避免误伤描述里含 file 的项。
     */
    function isDuplicateAddOption(node) {
      const texts = Array.from(node.querySelectorAll('span'))
        .map((span) => (span.textContent || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      if (!texts.length) return false;
      return texts.some((text) => {
        if (ADD_DROP_LABELS.indexOf(text) >= 0) return true;
        const lower = text.toLowerCase();
        return ADD_DROP_ALIASES.indexOf(lower) >= 0;
      });
    }

    /** 撤掉分页标记、内联定位与图标配色，回到 4 列 + 垂直滚动的原始宫格。 */
    function clearAddPaging(listbox) {
      addPagingState.node = null;
      addPagingState.signature = '';
      if (!listbox) return;
      listbox.removeAttribute(ATTR_ADD_PAGED);
      if (listbox.style) {
        listbox.style.removeProperty('--dshm-add-rows');
        listbox.style.removeProperty('grid-template-columns');
      }
      listbox.querySelectorAll('[' + ATTR_ADD_TINT + ']').forEach((icon) => {
        icon.removeAttribute(ATTR_ADD_TINT);
        if (icon.style) {
          icon.style.removeProperty('--dshm-tint');
          icon.style.removeProperty('--dshm-tint-soft');
        }
      });
      for (const node of Array.from(listbox.querySelectorAll('[role="option"]'))) {
        if (node.style) {
          node.style.removeProperty('order');
          node.style.removeProperty('grid-column');
          node.style.removeProperty('grid-row');
          node.style.removeProperty('display');
        }
        node.removeAttribute(ATTR_ADD_PAGE_START);
      }
    }

    /**
     * 给一个功能项的图标胶囊上色。
     *
     * 只写两个 CSS 变量（主色 + 柔光底），svg 内部是 `currentColor`，因此
     * 不碰官方节点结构、不改任何 fill/stroke，官方重渲染也能靠变量继续生效。
     * 色板名写进属性，值没变就跳过，避免每次同步都写一遍内联样式。
     */
    function applyAddTint(node, index) {
      const icon = node && node.querySelector('span');
      // 只认「装着 svg 的第一个 span」：官方若把结构改成 div 包文字，宁可不上色。
      if (!icon || !icon.style || !icon.querySelector('svg')) return;
      const tint = ADD_TINTS[index % ADD_TINTS.length];
      if (icon.getAttribute(ATTR_ADD_TINT) === tint.name) return;
      icon.setAttribute(ATTR_ADD_TINT, tint.name);
      icon.style.setProperty('--dshm-tint', tint.fg);
      icon.style.setProperty('--dshm-tint-soft', tint.soft);
    }

    /**
     * 给加号面板打上「两行 + 分页」标记。
     *
     * 关键：不移动、不包裹、不插入任何官方节点，只写内联 grid-column /
     * grid-row 与标记属性，因此不会破坏官方键盘导航与 aria-activedescendant；
     * 官方重渲染最多覆盖内联样式，下一次同步会补回来。
     *
     * @param {Element} listbox `[role=listbox]` 节点
     * @returns {Array|null} 页信息；无法解析时返回 null 并保持原始宫格
     */
    function syncAddPaging(listbox) {
      if (!listbox) return null;
      if (!countSectionTitles(listbox)) {
        // 不是加号菜单（如桌宠选择）：只清理自己留下的痕迹，其余一律不动。
        if (addPagingState.node === listbox) {
          clearAddPaging(listbox);
          if (state.addPageCount) setState({ addPageCount: 0 });
        }
        return null;
      }
      let options = [];
      try {
        options = collectAddOptions(listbox);
      } catch (error) {
        console.warn('[dsh-mobile-layout] 加号面板结构解析失败，保留原始宫格：', error);
        return null;
      }
      // 与常驻条重复的项直接从面板里收掉（官方节点不删，只 display:none）。
      const kept = [];
      for (const entry of options) {
        const duplicate = isDuplicateAddOption(entry.node);
        // 官方 CSS 用 `display: flex !important` 写选项，隐藏必须带 important。
        if (entry.node.style) {
          if (duplicate) entry.node.style.setProperty('display', 'none', 'important');
          else entry.node.style.removeProperty('display');
        }
        if (!duplicate) kept.push(entry);
      }
      options = kept;
      if (!options.length) {
        clearAddPaging(listbox);
        if (state.addPageCount) setState({ addPageCount: 0 });
        return null;
      }
      const rows = rowsFor(options.length, ADD_COLS);
      const perPage = rows * ADD_COLS;
      const pages = planAddPages(options, perPage);
      // 配色：同类型同色、同屏尽量不撞；新增功能按 id 哈希自动落位。
      const tints = planAddTints(options, ADD_TINTS.length);
      try {
        options.forEach((entry, index) => applyAddTint(entry.node, tints[index]));
        pages.forEach((page, pageIndex) => {
          page.items.forEach((globalIndex, j) => {
            const entry = options[globalIndex];
            const node = entry && entry.node;
            if (!node || !node.style) return;
            const slot = slotOf(j, pageIndex, rows, ADD_COLS);
            node.style.gridColumn = String(slot.column);
            node.style.gridRow = String(slot.row);
            if (slot.row === 1 && j % ADD_COLS === 0) node.setAttribute(ATTR_ADD_PAGE_START, '');
            else node.removeAttribute(ATTR_ADD_PAGE_START);
          });
        });
      } catch (error) {
        console.warn('[dsh-mobile-layout] 加号面板分页写入失败，保留原始宫格：', error);
        clearAddPaging(listbox);
        if (state.addPageCount) setState({ addPageCount: 0 });
        return null;
      }
      listbox.setAttribute(ATTR_ADD_PAGED, '');
      if (listbox.style) {
        listbox.style.setProperty('--dshm-add-rows', String(rows));
        // 显式补齐到「页数 × 4 列」：末页项数不足时列数也要够，否则容器滚动
        // 宽度不够，翻到末页会停在半路（实测 2 页 6 列时最多只能滚 196px，
        // 需要 393px）。用 important 覆盖官方宫格规则的 !important。
        listbox.style.setProperty('grid-template-columns', 'repeat(' + pages.length * ADD_COLS + ', 25%)', 'important');
      }
      addPagingState.node = listbox;
      const labels = pages.map((page) => page.label);
      const signature = labels.join('|') + '#' + rows;
      if (signature !== addPagingState.signature) {
        addPagingState.signature = signature;
        setState({ addPageCount: labels.length > 1 ? labels.length : 0 });
      }
      return pages;
    }

    /** 面板贴底时给 frame 预留高度，让常驻条与输入行一起上移。 */
    function syncPanelSpace() {
      const html = document.documentElement;
      const root = document.querySelector('[' + ATTR_POPOVER + ']');
      if (!root) {
        html.removeAttribute('data-dshm-panel');
        // 面板已消失：原位切换标记一起撤（面板免动画只覆盖切换期间）。
        html.removeAttribute('data-dshm-swap');
        html.style.removeProperty('--dshm-panel-space');
        // 浮层关闭时官方节点可能还挂在树上（复用同一 listbox）：分页写进去的
        // 内联列数 / grid-column / display:none 要一起撤掉，否则宫格会停在
        // 「多列 + 缺项」的形态。node 清空后这里是空转，不会每帧重扫。
        if (addPagingState.node) clearAddPaging(addPagingState.node);
        addPagingState.signature = '';
        if (state.addPageCount) setState({ addPageCount: 0 });
        return;
      }
      const height = Math.round(root.getBoundingClientRect().height);
      if (height <= 0) return;
      // 受控退场若被官方复用节点打断，残留的内联 translate 会在下次打开时
      // 把面板压在屏外；非退场期间一律清掉（入场动画由 CSS keyframes 驱动）。
      if (!popoverFx.closing && root.style.getPropertyValue('translate')) {
        root.style.removeProperty('translate');
        root.style.removeProperty('transition');
      }
      html.setAttribute('data-dshm-panel', '');
      // 圆点指示器浮在面板底部内边距里，不占额外高度（面板高度只由宫格决定）。
      const next = height + 'px';
      if (html.style.getPropertyValue('--dshm-panel-space') !== next) {
        html.style.setProperty('--dshm-panel-space', next);
      }
    }

    // ---- 设置弹窗：手机端全屏化 ----
    const settingsState = { active: '' };
    /** 设置页开合动画互斥位：退场进行中不再重复触发。 */
    const settingsFx = { closing: false };
    /** 滑动换页后淡入标记的回收定时器。 */
    let settingsSwapTimer = 0;

    /** 关闭按钮判据：aria-label / title / 文本里带「关闭」或 close。 */
    function isCloseButton(button) {
      const label = button.getAttribute('aria-label') || button.getAttribute('title') || button.textContent || '';
      return /关闭|close/i.test(label);
    }

    /**
     * 定位设置弹窗与其导航区。
     *
     * 判据走 {@link isSettingsDialog}：role=dialog + aria-modal=true + 导航按钮
     * ≥3；打标过的节点直接复用，避免每帧重复判断。
     */
    function findSettingsDialog() {
      for (const dialog of Array.from(document.querySelectorAll('[role="dialog"]'))) {
        // 手机形态下抽屉（官方侧栏）也被标成 role=dialog，里面同样可能有 nav，
        // 不能让它被当成设置页全屏化。
        if (dialog.hasAttribute(ATTR_SIDEBAR)) continue;
        const nav = dialog.querySelector('nav');
        if (!nav) continue;
        if (dialog.hasAttribute(ATTR_SETTINGS_PANEL)) return { dialog, nav };
        const navButtons = nav.querySelectorAll('button, a, [role="tab"]').length;
        const ok = isSettingsDialog({
          role: dialog.getAttribute('role'),
          ariaModal: dialog.getAttribute('aria-modal'),
          navButtons,
        });
        if (!ok) continue;
        // 早先版本会把设置页误标成统计浮层（被按固定小窗样式压住），这里收回。
        if (dialog.hasAttribute(ATTR_STATS_DIALOG)) dialog.removeAttribute(ATTR_STATS_DIALOG);
        return { dialog, nav };
      }
      return null;
    }

    /**
     * 复制官方侧栏顶部的品牌图标（DeepSeek 鲸鱼）。
     *
     * 官方没有稳定的选择器，实测侧栏里第一个 svg 就是它：viewBox 0 0 23.16 17.04
     * （宽扁的鲸鱼），其余 7 个都是 16×16 的线性图标。这里按「宽高比 1.15~2.2
     * 且宽 ≤40」挑第一个，拿不到就返回 null（品牌区只显示字标）。
     */
    function cloneBrandLogo() {
      const sidebar = document.querySelector('[' + ATTR_SIDEBAR + ']');
      if (!sidebar) return null;
      for (const svg of Array.from(sidebar.querySelectorAll('svg'))) {
        const box = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
        if (box.length !== 4) continue;
        const w = box[2];
        const h = box[3];
        if (!(w > 0 && h > 0)) continue;
        const ratio = w / h;
        if (ratio < 1.15 || ratio > 2.2 || w > 40) continue;
        const copy = svg.cloneNode(true);
        copy.removeAttribute('style');
        copy.setAttribute('width', '22');
        copy.setAttribute('height', String(Math.max(10, Math.round((22 * h) / w))));
        copy.setAttribute('aria-hidden', 'true');
        return copy;
      }
      return null;
    }

    /**
     * 设置页顶部品牌区：官方弹窗顶端就是页签，而手机端顶部常被宿主
     * 「引擎已就绪」悬浮条（收起后是把手）压住，先把品牌行垫上去，
     * 页签自然下移，同时给出与抽屉一致的 DeepSeek 标识。
     */
    function ensureSettingsBrand(dialog) {
      let brand = dialog.querySelector('[' + ATTR_SETTINGS_BRAND + ']');
      if (brand && brand.parentElement !== dialog) {
        brand.remove();
        brand = null;
      }
      if (!brand) {
        brand = document.createElement('div');
        brand.setAttribute(ATTR_SETTINGS_BRAND, '');
        const logo = cloneBrandLogo();
        if (logo) {
          const holder = document.createElement('span');
          holder.className = 'dshm-settings-brand-logo';
          holder.appendChild(logo);
          brand.appendChild(holder);
        }
        const name = document.createElement('span');
        name.className = 'dshm-settings-brand-name';
        name.textContent = 'deepseek';
        brand.appendChild(name);
        dialog.insertBefore(brand, dialog.firstChild);
      }
      return brand;
    }

    /** 返回箭头：静态字符串，无外部输入。 */
    const SETTINGS_BACK_ICON =
      '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M15 5l-7 7 7 7"/></svg>';

    /**
     * 设置页立即关闭（无退场动画）：点官方关闭按钮，让官方状态机自己收尾；
     * 找不到按钮时只撤插件标记。
     *
     * 系统返回键（Android 返回 / 手势）与 Esc 走的也是这条路，三条入口共用
     * 一个出口，避免「系统返回关得掉、界面按钮关不掉」这种分叉。
     */
    function closeSettingsImmediate() {
      const close = document.querySelector('[' + ATTR_SETTINGS_CLOSE + ']');
      if (close && typeof close.click === 'function') {
        close.click();
        return;
      }
      clearSettingsPanel();
      syncOverlayHistory();
    }

    /**
     * 设置页退出（带退场动画）：面板先滑出再走官方关闭。
     *
     * 官方弹窗是瞬时卸载，手机端全屏化后开与关都是「一瞬间」，与 composer
     * 的过渡不同步（用户实测反馈）。这里统一给返回键 / Esc / 返回箭头 /
     * 左滑手势一条动画出口；减动效宿主直接走立即关闭。
     */
    function closeSettingsByBack() {
      if (settingsFx.closing) return;
      const panel = document.querySelector('[' + ATTR_SETTINGS_PANEL + ']');
      let reduce = false;
      try {
        reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      } catch (error) {
        reduce = false;
      }
      if (!panel || reduce) {
        closeSettingsImmediate();
        return;
      }
      settingsFx.closing = true;
      panel.style.setProperty('transition', 'translate 220ms cubic-bezier(0.4, 0, 1, 1)', 'important');
      panel.style.setProperty('translate', '0 105%', 'important');
      window.setTimeout(() => {
        settingsFx.closing = false;
        panel.style.removeProperty('transition');
        panel.style.removeProperty('translate');
        closeSettingsImmediate();
      }, 250);
    }

    /**
     * 页签行左侧的返回键。
     *
     * 设置页在手机端铺满整屏，原来唯一的退出方式是右对齐工具行里那个 ✕（还
     * 和「打开配置文件」挤在一起）。这里补一个 44×44 的返回箭头，`aria-label`
     * 跟随语言。
     *
     * 位置特意放在**页签行**而不是品牌行：品牌行在屏幕最顶端，宿主的
     * 「引擎已就绪」悬浮条展开时正好压住那一带（实测原生 View 覆盖
     * CSS y 11~47 的整行），点上去事件被宿主吃掉；页签行在 y 56 以下，
     * 任何形态都碰不到。
     */
    function ensureSettingsBack(container, before) {
      let button = container.querySelector('[' + ATTR_SETTINGS_BACK + ']');
      if (!button) {
        button = document.createElement('button');
        button.type = 'button';
        button.className = 'dshm-settings-back';
        button.setAttribute(ATTR_SETTINGS_BACK, '');
        button.innerHTML = SETTINGS_BACK_ICON;
        button.addEventListener('click', closeSettingsByBack);
      }
      // 每次同步都摆一次位置：官方重渲染页签行时可能把外来节点挪走。
      const anchor = before && before.parentElement === container ? before : container.firstChild;
      if (button.parentElement !== container || button.nextElementSibling !== anchor) {
        container.insertBefore(button, anchor);
      }
      const label = t('back');
      if (button.getAttribute('aria-label') !== label) button.setAttribute('aria-label', label);
      return button;
    }

    /** 主题卡片识别：同组 ≥3 个等高的可选按钮（aria-checked / aria-pressed / radio）。 */
    function tagSettingsCards(scroll) {
      const parents = new Set();
      for (const button of Array.from(scroll.querySelectorAll('button'))) {
        if (button.parentElement && button.parentElement !== scroll) parents.add(button.parentElement);
      }
      parents.forEach((parent) => {
        const kids = Array.from(parent.children).filter((kid) => kid.tagName === 'BUTTON');
        if (kids.length < 3 || kids.length !== parent.children.length) return;
        const checkable = kids.every((kid) => {
          const role = kid.getAttribute('role');
          const pressed = kid.getAttribute('aria-pressed');
          const checked = kid.getAttribute('aria-checked');
          const state = kid.getAttribute('data-state');
          return role === 'radio' || role === 'option' || pressed !== null || checked !== null || state === 'checked' || state === 'unchecked';
        });
        if (!checkable) return;
        const heights = kids.map((kid) => Math.round(kid.getBoundingClientRect().height));
        const min = Math.min.apply(null, heights);
        const max = Math.max.apply(null, heights);
        if (min < 60 || max - min > 6) return;
        if (!parent.hasAttribute(ATTR_SETTINGS_CARDS)) parent.setAttribute(ATTR_SETTINGS_CARDS, '');
      });
    }

    /** 给设置弹窗各部位打标（幂等，已标记的节点不重复 setAttribute）。 */
    function tagSettings(found) {
      const dialog = found.dialog;
      const nav = found.nav;
      if (!dialog.hasAttribute(ATTR_SETTINGS_PANEL)) dialog.setAttribute(ATTR_SETTINGS_PANEL, '');
      ensureSettingsBrand(dialog);
      if (nav) {
        if (!nav.hasAttribute(ATTR_SETTINGS_NAV)) nav.setAttribute(ATTR_SETTINGS_NAV, '');
        let tabs = null;
        for (const child of Array.from(nav.children)) {
          if (child.querySelectorAll('button, a, [role="tab"]').length >= 3) {
            tabs = child;
            break;
          }
        }
        if (!tabs && nav.querySelectorAll('button, a, [role="tab"]').length >= 3) tabs = nav;
        if (tabs) {
          if (!tabs.hasAttribute(ATTR_SETTINGS_TABS)) tabs.setAttribute(ATTR_SETTINGS_TABS, '');
          // 返回键放在页签行最左（宿主悬浮条压不到这一行）。
          ensureSettingsBack(nav, tabs === nav ? nav.firstChild : tabs);
          // 「设置」标题占 44px 宽却不出信息，全屏后可以省掉，把宽度让给页签。
          for (const child of Array.from(nav.children)) {
            if (child === tabs || child.hasAttribute(ATTR_SETTINGS_TITLE)) continue;
            if (child.hasAttribute(ATTR_SETTINGS_BACK)) continue;
            if (child.querySelector('button, a, [role="tab"]')) continue;
            const text = (child.textContent || '').replace(/\s+/g, ' ').trim();
            if (text && text.length <= 8) {
              child.setAttribute(ATTR_SETTINGS_TITLE, '');
              break;
            }
          }
        }
      }
      let content = null;
      let best = -1;
      for (const child of Array.from(dialog.children)) {
        if (child === nav) continue;
        if (child.hasAttribute(ATTR_SETTINGS_BRAND)) continue;
        const rect = child.getBoundingClientRect();
        const area = rect.width * rect.height;
        if (area > best) {
          best = area;
          content = child;
        }
      }
      if (!content) return;
      if (!content.hasAttribute(ATTR_SETTINGS_CONTENT)) content.setAttribute(ATTR_SETTINGS_CONTENT, '');
      // 工具行：内容区里较矮、且带「关闭」按钮的那一块。
      let head = null;
      for (const child of Array.from(content.children)) {
        if (child.getBoundingClientRect().height > 72) continue;
        const buttons = Array.from(child.querySelectorAll('button'));
        if (!buttons.length) continue;
        if (buttons.some(isCloseButton)) {
          head = child;
          break;
        }
      }
      if (head) {
        if (!head.hasAttribute(ATTR_SETTINGS_HEAD)) head.setAttribute(ATTR_SETTINGS_HEAD, '');
        for (const button of Array.from(head.querySelectorAll('button'))) {
          const attr = isCloseButton(button) ? ATTR_SETTINGS_CLOSE : ATTR_SETTINGS_TOOL;
          if (!button.hasAttribute(attr)) button.setAttribute(attr, '');
        }
      }
      // 滚动区：工具行之外最高的那一块。
      let scroll = null;
      let tallest = -1;
      for (const child of Array.from(content.children)) {
        if (child === head) continue;
        const rect = child.getBoundingClientRect();
        if (rect.height > tallest) {
          tallest = rect.height;
          scroll = child;
        }
      }
      if (!scroll) return;
      if (!scroll.hasAttribute(ATTR_SETTINGS_SCROLL)) scroll.setAttribute(ATTR_SETTINGS_SCROLL, '');
      tagSettingsCards(scroll);
    }

    /** 页签条与其中的可点项（官方用 button / a / role=tab 三种之一）。 */
    function settingsTabItems() {
      const tabs = document.querySelector('[' + ATTR_SETTINGS_TABS + ']');
      if (!tabs) return null;
      // 返回键也插在页签行里，不能被当成页签（否则滑动可能点出「返回」）。
      const items = Array.from(tabs.querySelectorAll('button, a, [role="tab"]')).filter((item) => !item.hasAttribute(ATTR_SETTINGS_BACK));
      if (!items.length) return null;
      return { tabs, items };
    }

    /**
     * 激活页签的下标。
     *
     * 官方没有统一标记：`aria-selected` / `aria-current` / `data-state=active`
     * / class 里带 `is-active` 都出现过，按这几种依次认；都不命中返回 -1。
     */
    function settingsTabActiveIndex(items) {
      for (let i = 0; i < items.length; i += 1) {
        const item = items[i];
        const selected = item.getAttribute('aria-selected') || item.getAttribute('aria-current');
        const state2 = item.getAttribute('data-state');
        if (selected === 'true' || selected === 'page' || state2 === 'active' || /(^|\s)is-active(\s|$)/i.test(item.className || '')) {
          return i;
        }
      }
      return -1;
    }

    /** 离页签条视口中心最近的一项：官方没给激活标记时的兜底。 */
    function nearestTabIndex(tabs, items) {
      const box = tabs.getBoundingClientRect();
      const center = box.left + box.width / 2;
      let best = 0;
      let bestDist = Infinity;
      items.forEach((item, i) => {
        const rect = item.getBoundingClientRect();
        const dist = Math.abs(rect.left + rect.width / 2 - center);
        if (dist < bestDist) {
          bestDist = dist;
          best = i;
        }
      });
      return best;
    }

    /** 换页后的轻量反馈：内容区淡入一次（不位移，避免影响内部定位的浮层）。 */
    function flashSettingsContent() {
      const scroll = document.querySelector('[' + ATTR_SETTINGS_SCROLL + ']');
      if (!scroll) return;
      scroll.setAttribute(ATTR_SETTINGS_SWAP, '');
      if (settingsSwapTimer) window.clearTimeout(settingsSwapTimer);
      settingsSwapTimer = window.setTimeout(() => {
        settingsSwapTimer = 0;
        if (scroll.isConnected) scroll.removeAttribute(ATTR_SETTINGS_SWAP);
      }, 200);
    }

    /**
     * 切到相邻页签：点官方页签按钮，换页交给官方状态机。
     * @returns {boolean} 是否真的切了（首尾到头时为 false）
     */
    function switchSettingsTab(delta) {
      const found = settingsTabItems();
      if (!found) return false;
      const { tabs, items } = found;
      if (items.length < 2) return false;
      let index = settingsTabActiveIndex(items);
      if (index < 0) index = nearestTabIndex(tabs, items);
      const next = nextTabIndex(index, delta, items.length);
      if (next < 0) return false;
      const item = items[next];
      if (!item) return false;
      flashSettingsContent();
      item.click();
      return true;
    }

    /**
     * 手势起点是否落在可换页的区域。
     *
     * 只认内容滚动区：页签条自身要横滑、工具行要能点错、输入类控件要拖选，
     * 都不该被换页抢走。内容里若嵌了可横滚的块，横滑优先给它。
     */
    function canStartSettingsSwipe(target) {
      if (!target || typeof target.closest !== 'function') return false;
      const scroll = target.closest('[' + ATTR_SETTINGS_SCROLL + ']');
      if (!scroll) return false;
      if (target.closest('input, textarea, select, [contenteditable="true"], [role="slider"], [role="textbox"], [role="searchbox"]')) return false;
      let node = target;
      while (node && node !== scroll) {
        if (node.scrollWidth > node.clientWidth + 4) {
          const style = window.getComputedStyle(node);
          const overflowX = style ? style.overflowX : '';
          if (overflowX === 'auto' || overflowX === 'scroll') return false;
        }
        node = node.parentElement;
      }
      return true;
    }

    /** 横滑换页签：touchstart 记起点，touchend 判方向。 */
    const settingsSwipe = { active: false, x: 0, y: 0, time: 0 };

    function onSettingsTouchStart(event) {
      settingsSwipe.active = false;
      if (state.mode !== MODE_MOBILE) return;
      const touches = event.touches;
      if (!touches || touches.length !== 1) return;
      if (!canStartSettingsSwipe(event.target)) return;
      settingsSwipe.active = true;
      settingsSwipe.x = touches[0].clientX;
      settingsSwipe.y = touches[0].clientY;
      settingsSwipe.time = Date.now();
    }

    function onSettingsTouchEnd(event) {
      if (!settingsSwipe.active) return;
      settingsSwipe.active = false;
      // 长按后再拖不算换页（多是选中文字 / 调值）。
      if (Date.now() - settingsSwipe.time > 900) return;
      const touch = event.changedTouches && event.changedTouches[0];
      if (!touch) return;
      const direction = swipeDirection(touch.clientX - settingsSwipe.x, touch.clientY - settingsSwipe.y);
      if (!direction) return;
      switchSettingsTab(direction);
    }

    function onSettingsTouchCancel() {
      settingsSwipe.active = false;
    }

    /**
     * 设置页翻页容器在该方向是否还能换页（内容翻页由 settingsSwipe 在
     * touchend 离散完成，这里按激活页签下标判边界）。
     *
     * 左滑（dir=-1）是下一页、右滑（dir=+1）是上一页（swipeDirection 的
     * 符号约定：dx<0 → 1）。只保留左边界退出：最左页签上右滑翻页吞不掉
     * 时交给面板跟手退出；左滑一律让路换页（最右再左滑不退出）。
     *
     * @param {number} dir 手势方向：-1 左滑 / +1 右滑
     * @returns {boolean} true = 该方向还能换页，手势应让路
     */
    function settingsPagerCanConsume(dir) {
      const found = settingsTabItems();
      if (!found) return false;
      const items = found.items;
      if (items.length < 2) return false;
      let index = settingsTabActiveIndex(items);
      if (index < 0) index = nearestTabIndex(found.tabs, items);
      if (dir < 0) return true;
      return index > 0;
    }

    /** 让当前页签滚到页签条中央（只在激活项变化时动，不抢用户横滑）。 */
    function centerSettingsTab() {
      const found = settingsTabItems();
      if (!found) return;
      const { tabs, items } = found;
      const index = settingsTabActiveIndex(items);
      if (index < 0) return;
      const active = items[index];
      const key = (active.textContent || '').replace(/\s+/g, ' ').trim();
      if (settingsState.active === key) return;
      settingsState.active = key;
      const box = tabs.getBoundingClientRect();
      const rect = active.getBoundingClientRect();
      if (!box.width) return;
      const delta = rect.left + rect.width / 2 - (box.left + box.width / 2);
      if (Math.abs(delta) > 2) {
        try {
          tabs.scrollLeft += delta;
        } catch (error) {
          /* 忽略：滚动失败不影响功能 */
        }
      }
    }

    /** 清理设置弹窗的全部标记与全屏态。 */
    function clearSettingsPanel() {
      const html = document.documentElement;
      settingsState.active = '';
      // 开合动画的内联 translate / transition 可能残留在面板上（官方自行
      // 关闭、动画中途弹窗被卸载等），这里一并摘掉。
      document.querySelectorAll('[' + ATTR_SETTINGS_PANEL + ']').forEach((panel) => {
        panel.style.removeProperty('transition');
        panel.style.removeProperty('translate');
      });
      if (html.hasAttribute('data-dshm-settings-open')) {
        html.removeAttribute('data-dshm-settings-open');
        // 品牌行与返回键由插件创建，官方不会回收，这里连节点一起摘掉
        // （只摘属性会在设置页下次打开时留下一个重复的箭头）。
        document.querySelectorAll('[' + ATTR_SETTINGS_BRAND + '], [' + ATTR_SETTINGS_BACK + ']').forEach((node) => node.remove());
        SETTINGS_ATTRS.forEach((attr) => {
          document.querySelectorAll('[' + attr + ']').forEach((node) => node.removeAttribute(attr));
        });
      }
      if (state.settingsOpen) {
        setState({ settingsOpen: false });
        syncOverlayHistory();
      }
    }

    /**
     * 设置页入场动画：自底滑入。
     *
     * 官方弹窗挂载即呈现，全屏化后 opening 瞬变、与 composer 的隐藏过渡
     * 脱节。面板初始内联 translate 压到屏下，下一帧带过渡归位；退场由
     * closeSettingsByBack 负责。减动效宿主跳过。
     */
    function animateSettingsIn(panel) {
      let reduce = false;
      try {
        reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      } catch (error) {
        reduce = false;
      }
      if (reduce || !panel || !panel.isConnected) return;
      panel.style.setProperty('translate', '0 105%', 'important');
      window.requestAnimationFrame(() => {
        if (!panel.isConnected || settingsFx.closing) {
          panel.style.removeProperty('transition');
          panel.style.removeProperty('translate');
          return;
        }
        panel.style.setProperty('transition', 'translate 260ms cubic-bezier(0.32, 0.72, 0, 1)', 'important');
        panel.style.setProperty('translate', '0 0', 'important');
        window.setTimeout(() => {
          panel.style.removeProperty('transition');
          panel.style.removeProperty('translate');
        }, 290);
      });
    }

    /** 每次 DOM 变更后同步：识别设置弹窗 → 打标 → 打开全屏态。 */
    function syncSettingsPanel() {
      if (state.mode !== MODE_MOBILE) {
        clearSettingsPanel();
        return;
      }
      const found = findSettingsDialog();
      if (!found) {
        clearSettingsPanel();
        return;
      }
      tagSettings(found);
      const html = document.documentElement;
      if (!html.hasAttribute('data-dshm-settings-open')) {
        html.setAttribute('data-dshm-settings-open', '');
        settingsState.active = '';
        // 抽屉与设置互斥：设置要在最上层，抽屉留在下面会露出遮罩。
        if (isDrawerOpen()) requestDrawer(false);
        setState({ settingsOpen: true });
        syncOverlayHistory();
        animateSettingsIn(found.dialog);
      }
      centerSettingsTab();
    }

    // ---- 会话列表 ----
    const EMPTY_LIST = { byId: {}, items: [] };

    /**
     * 会话行的 id 归一。
     *
     * 官方快照的行可能带 `id`，也可能只有 `sessionId`（不同版本 / 不同来源）。
     * 面板渲染与 `openSession(id)` 都只认 `row.id`，所以这里统一补一次：
     * 缺 `id` 就浅拷贝补上，避免「当前标记失效 + React key 全是 undefined」。
     */
    function sessionRowId(row) {
      if (!row) return null;
      return row.id || row.sessionId || null;
    }

    function sessionRows(snapshot) {
      const source = snapshot && snapshot.byId ? Object.values(snapshot.byId) : (snapshot && snapshot.items) || [];
      const current = source.find((row) => row && row.retainedBy && (row.retainedBy.mainView || 0) > 0);
      const currentId = sessionRowId(current);
      const rows = source
        .filter((row) => row && (!row.blank || sessionRowId(row) === currentId))
        .map((row) => (row.id ? row : Object.assign({}, row, { id: sessionRowId(row) })))
        .sort((a, b) => {
          const aCurrent = a.id === currentId ? 1 : 0;
          const bCurrent = b.id === currentId ? 1 : 0;
          if (aCurrent !== bCurrent) return bCurrent - aCurrent;
          return (b.updatedAt || 0) - (a.updatedAt || 0);
        })
        .slice(0, 40);
      return { rows, currentId };
    }

    const EMPTY_WORKSPACES = { items: [] };

    /** 路径归一：统一分隔符、去掉尾斜杠，便于 cwd 与 workspace.path 对齐。 */
    function normalizeWorkspacePath(value) {
      return String(value || '')
        .trim()
        .replace(/\\/g, '/')
        .replace(/\/+$/, '');
    }

    /**
     * 抽屉内一次点击后该不该收起（纯函数，真值表见 ux.test.js）。
     *
     * 返回 `close` = 立刻收，`signature` = 等视图签名变化再收，`none` = 不收。
     *
     * - 表单控件不收：正在输入 / 搜索时不打断；
     * - `disclosure`（有 aria-expanded / aria-haspopup / aria-controls）不收：
     *   那是展开折叠、下拉菜单、行内「… 操作」，点完还要继续在抽屉里挑；
     * - 会话 / 工作区行（`navRow`）收：换的就是当前会话；
     * - 带文字的按钮（新建会话 / 插件 / 自动化任务 / SSH 工作区）收；
     * - 纯图标按钮（搜索 / 视图选项 / 添加工作区 / 账号菜单）默认不收，
     *   交给视图签名判定——只有真的换了页面才收。
     */
    function sidebarClickAction(flags) {
      if (!flags || !flags.inside) return 'none';
      if (flags.formControl || flags.disclosure) return 'none';
      if (flags.navRow) return 'close';
      if (!flags.button) return 'none';
      return flags.hasText ? 'close' : 'signature';
    }

    /**
     * 工作区标题表：`path` → 显示名。
     *
     * 官方 `workspaces.list` 快照形如 `{ items: [{ path, title, sessionIds }] }`，
     * 而会话行只带 `cwd`，两边按路径对齐；`title` 为空时退回目录名。
     *
     * 字典用无原型对象：路径里含 `constructor` / `__proto__` 这类原型键名时，
     * 普通 `{}` 会让 `map[key]` 命中原型链上的函数，取到非字符串值。
     */
    function workspaceTitleMap(snapshot) {
      const map = Object.create(null);
      const items = (snapshot && snapshot.items) || [];
      for (const item of items) {
        if (!item || !item.path) continue;
        const key = normalizeWorkspacePath(item.path);
        if (!key) continue;
        const title = item.title || key.slice(key.lastIndexOf('/') + 1);
        if (!title) continue;
        map[key] = title;
      }
      return map;
    }

    /** 会话行 → 工作区显示名；对不上就返回空串（该行只显示标题）。 */
    function workspaceNameFor(cwd, map) {
      if (!map) return '';
      const key = normalizeWorkspacePath(cwd);
      if (!key) return '';
      return map[key] || '';
    }

    /**
     * 会话行的最终工作区标签：先查表，查不到退回 `cwd` 的目录名。
     *
     * 工作区改名/删除后会话仍留着旧 `cwd`，此时目录名仍是最接近的身份，
     * 也避免多工作区列表里出现「有的两行、有的一行」的高低错落。
     */
    function workspaceLabelFor(cwd, map) {
      const name = workspaceNameFor(cwd, map);
      if (name) return name;
      const key = normalizeWorkspacePath(cwd);
      if (!key) return '';
      return key.slice(key.lastIndexOf('/') + 1);
    }

    /**
     * 会话按工作区分组，供面板「分组标题 + 会话缩进」渲染。
     *
     * 组序 = 该组第一行在列表里的出现位置，这样上游「当前会话置顶 + 其余按
     * 更新时间倒序」的排序意图原样保留（当前会话所在组自然最先出现）；
     * 组内顺序也不动。行的工作区名沿用 `workspaceLabelFor`，空名单独成组。
     *
     * 字典必须无原型：分组键是工作区目录名，目录叫 `constructor` / `toString`
     * 时普通 `{}` 会直接取到原型上的函数，`group.rows.push` 随之抛 TypeError，
     * 而这个函数在面板渲染期执行，等于整个会话面板崩掉。
     */
    function groupSessionsByWorkspace(rows, map) {
      const groups = [];
      const seen = Object.create(null);
      for (const row of rows || []) {
        if (!row) continue;
        const name = workspaceLabelFor(row.cwd, map);
        const key = name || '\u0000';
        let group = seen[key];
        if (!group) {
          group = { name, rows: [] };
          seen[key] = group;
          groups.push(group);
        }
        group.rows.push(row);
      }
      return {
        groups,
        grouped: groups.length > 1,
        single: groups.length === 1 ? groups[0].name : '',
      };
    }

    /** 补零，用于 M-D / Y-M-D 片段。 */
    function pad2(value) {
      return value < 10 ? '0' + value : String(value);
    }

    /**
     * 会话行右侧的相对时间。
     *
     * 面板行高只有 44px，右侧列宽约 60px，所以刻意用紧凑写法：
     * 1 分钟内「刚刚」、1 小时内「N 分钟」、当天内「N 小时」、昨天、
     * 7 天内「N 天」，再往前只留日期（同年省略年份）。空值返回空串，
     * 由调用方整块跳过。
     */
    function formatRelativeTime(updatedAt, now, lang) {
      const ts = Number(updatedAt) || 0;
      const base = Number(now) || 0;
      if (!ts || !base) return '';
      const zh = lang === 'zh';
      const diff = base - ts;
      if (diff < 60 * 1000) return zh ? '刚刚' : 'now';
      const minutes = Math.floor(diff / (60 * 1000));
      if (minutes < 60) return zh ? minutes + ' 分钟' : minutes + 'm';
      const hours = Math.floor(diff / (60 * 60 * 1000));
      if (hours < 24) return zh ? hours + ' 小时' : hours + 'h';
      const days = Math.floor(diff / (24 * 60 * 60 * 1000));
      if (days === 1) return zh ? '昨天' : 'Yesterday';
      if (days < 7) return zh ? days + ' 天' : days + 'd';
      const date = new Date(ts);
      const ref = new Date(base);
      const year = date.getFullYear();
      const month = pad2(date.getMonth() + 1);
      const day = pad2(date.getDate());
      const sep = zh ? '-' : '/';
      if (year === ref.getFullYear()) return month + sep + day;
      return year + sep + month + sep + day;
    }

    function useWorkspaceNames(enabled) {
      const store = runtime.workspace && runtime.workspace.workspaces && runtime.workspace.workspaces.list;
      const subscribe = react.useCallback(
        (listener) => {
          if (!store || typeof store.subscribe !== 'function') return () => {};
          return store.subscribe(listener);
        },
        [store, enabled],
      );
      const getSnapshot = react.useCallback(
        () =>
          enabled && store && typeof store.getSnapshot === 'function' ? store.getSnapshot() : EMPTY_WORKSPACES,
        [store, enabled],
      );
      const snapshot = react.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
      return react.useMemo(() => workspaceTitleMap(snapshot), [snapshot]);
    }

    function useSessionRows(enabled) {
      const list = runtime.sessions && runtime.sessions.list;
      const subscribeList = react.useCallback(
        (listener) => {
          if (!list || typeof list.subscribe !== 'function') return () => {};
          return list.subscribe(listener);
        },
        [list, enabled],
      );
      const getSnapshot = react.useCallback(
        () => (enabled && list && typeof list.getSnapshot === 'function' ? list.getSnapshot() : EMPTY_LIST),
        [list, enabled],
      );
      return sessionRows(react.useSyncExternalStore(subscribeList, getSnapshot, getSnapshot));
    }

    /**
     * 通过官方布局服务开合侧栏。目标是幂等的：已经处于目标状态就不调用，
     * 避免官方 toggle 在窄屏下翻转 narrowExpanded 造成反效果。
     */
    function requestDrawer(open) {
      if (open) closeSheet();
      if (isDrawerOpen() === open) return;
      const layout = runtime.layout;
      console.info('[dshm-gesture] REQUEST open=' + open + ' layout=' + (layout ? Object.keys(layout).join(',') : 'null')); // TEMP-DEBUG
      if (!layout || typeof layout.toggleSidebar !== 'function') {
        console.warn('[dshm-gesture] toggleSidebar 缺失，手势动作丢弃'); // TEMP-DEBUG
        return;
      }
      try {
        layout.toggleSidebar();
      } catch (error) {
        console.error('[dsh-mobile-layout] 切换侧栏失败：', error);
      }
    }

    /**
     * 抽屉手势层：window 捕获阶段单点绑定，与页面 / 槽位生命周期解耦。
     *
     * 旧实现把手势挂在 shell.overlay 的 OverlayLayer 里，等于把「能不能左滑
     * 开抽屉」绑在官方 React 槽位组件的挂载状态上：其它插件提供的面板页
     * （main 槽位）只要自己消费触摸事件（stopPropagation / preventDefault，
     * 终端页的 VS Code 组件栈就这么干）或整页横滚，冒泡阶段的监听就够不着，
     * 表现为「换到插件页面左滑失灵」。
     *
     * 现在挂在 window 的捕获阶段：捕获先于一切目标处理器执行，任何层级的
     * stopPropagation 都拦不住；也不依赖 shell.overlay 是否挂载。只要插件
     * 活着、形态是手机，任何页面都能监听到。全部监听 passive：只观察，
     * 不抢页面的默认行为。
     *
     * 判定走 decideDrawerGesture（纯函数）：左起手区右滑开、展开后任何
     * 位置左滑收；横滚容器按「方向 + 是否到边界」让路（scrollerConsumes），
     * 终端 / 宽表在最左端起手右滑也能开抽屉。
     *
     * 官方 toggleSidebar 是异步 React 提交，快速连滑两次会双翻（第一次的
     * 目标被第二次 toggle 翻回去）；触发后 320ms 按 DOM 复核一次，只补
     * 一次不重试。
     *
     * 调试：localStorage 设 dshm-debug=1，被拒绝的手势会打出结构化原因
     * （SWIPE_IGNORE / RIGHTBAR_FULLSCREEN / BLOCKED_LAYER / TOO_VERTICAL /
     * H_SCROLLER / OUT_OF_ZONE），现场一条日志即可定位。
     *
     * @param {Window} win 页面 window（测试可传 mock）
     * @param {Document} doc 页面 document
     * @returns {() => void} release：摘掉全部监听并复位状态
     */
    function bindDrawerGesture(win, doc) {
      /** 本轮手势是否在跟踪（单指起手且未被静态拦截）。 */
      let active = false;
      /** 双通道按先到者去重：同一次手势 pointerdown 先于 touchstart 到达。 */
      let source = '';
      let pointerId = -1;
      let touchId = -1;
      let startX = 0;
      let startY = 0;
      /** 起手元素：让路判定（closest / 横滚祖先）要用。 */
      let startTarget = null;
      /** 已锁定的方向：1 右滑（开）、-1 左滑（收）、0 未定向。方向翻转会重判让路。 */
      let armed = 0;
      /** 定向时一次性判定：起手横滚容器在该方向是否还能滚。 */
      let hConsume = false;
      /** 起手时抽屉是否展开：跟手进度基准与松手吸附的「起点侧」。 */
      let openAtStart = false;
      /** 是否处于跟手阶段：抽屉 / 遮罩由手势引擎直接驱动（内联样式）。 */
      let following = false;
      /** 跟手用抽屉宽（CSS px），beginFollow 量一次。 */
      let drawerWidth = 280;
      /** 增量跟随基准：定向时的手指 x，progress 从 0 平滑起步。 */
      let followBaseX = 0;
      /** 当前跟手进度（0 收起 → 1 展开），updateFollow 刷新、endFollow 吸附。 */
      let lastProgress = 0;
      let moveCount = 0; // TEMP-DEBUG
      let followSidebar = null;
      /** 跟手遮罩：手势引擎自建（.dshm-drag-mask），不依赖 React 树。 */
      let dragMask = null;
      /** 跟手期间让位的官方 React 遮罩（.dshm-mask），松手后恢复。 */
      let reactMask = null;
      /** 兜底遮罩的抽屉状态观察：抽屉被任何途径收起时淡出并摘除。 */
      let fallbackObserver = null;
      /** 官方抽屉状态 → 位移变量同步 observer（bind 时挂，release 断开）。 */
      let followObserver = null;
      /** 吸附终态的内联样式清理计时。 */
      let settleTimer = 0;
      /** 遮罩交还官方 React 遮罩的轮询计时。 */
      let maskSwapTimer = 0;
      /** 速度采样（最近 8 个 {t, x}），松手时折算 px/ms。 */
      let samples = [];
      let reducedMotion = false;
      let debugOn = false;
      let recheckTimer = 0;
      let released = false;
      /** 设置页左滑退出：起手时设置页在屏上（本轮手势只服务退出语义）。 */
      let settingsExit = false;
      /** 起手点是否在设置页内容滚动区（与翻页同一准入，canStartSettingsSwipe）。 */
      let settingsAreaOk = false;
      /** 设置页跟手阶段：面板位移由手势引擎直接驱动（内联 translate）。 */
      let settingsFollowing = false;
      /** 跟手中的设置面板元素；松手吸附后置空。 */
      let settingsPanel = null;
      /** 当前跟手位移（≤0，左滑为负）。 */
      let settingsDx = 0;

      const clamp01 = (value) => {
        const v = Number(value);
        if (!Number.isFinite(v)) return 0;
        return v < 0 ? 0 : v > 1 ? 1 : v;
      };
      const removeNode = (node) => {
        try {
          if (node && node.parentNode) node.parentNode.removeChild(node);
        } catch (error) {
          /* 节点已被官方重挂 / 移除 */
        }
      };
      /** 抽屉位移（CSS %）写到 <html> 变量：官方同步清不到根元素上的变量。 */
      const setDrawerX = (pct) => {
        try {
          doc.documentElement.style.setProperty('--dshm-drawer-x', pct + '%');
        } catch (error) {
          /* ignore */
        }
      };
      /** 跟手 / 吸附期间变量归手势引擎管；空闲时随官方状态同步。 */
      const syncDrawerX = () => {
        if (following || settleTimer) return;
        setDrawerX(isDrawerOpen() ? 0 : -104);
      };
      const debugLog = (reason) => {
        if (!debugOn) return;
        console.info('[dsh-mobile-layout] 抽屉手势忽略：' + reason);
      };

      /** 浮层开着时不起手势（底部表 / 官方 ⊕ 浮层 / 头部菜单）。 */
      const overlayBlocked = () =>
        getState().sheet !== null ||
        getState().popoverOpen ||
        Boolean(doc.querySelector('[' + ATTR_POPOVER + ']'));

      const overflowXOf = (node) => {
        try {
          return win.getComputedStyle(node).overflowX;
        } catch (error) {
          return '';
        }
      };

      /** 起手点向上 6 层内找「真的能横滚」的容器（代码块 / 表格 / 终端视口）。 */
      const horizScrollerOf = (node) => {
        let cur = node instanceof win.Element ? node : null;
        for (let i = 0; cur && i < 6; i += 1) {
          if (
            isHorizScrollerMetrics({
              scrollWidth: cur.scrollWidth,
              clientWidth: cur.clientWidth,
              overflowX: overflowXOf(cur),
            })
          ) {
            return cur;
          }
          cur = cur.parentElement;
        }
        return null;
      };

      const resetGesture = () => {
        active = false;
        source = '';
        pointerId = -1;
        touchId = -1;
        startTarget = null;
        armed = 0;
        hConsume = false;
        settingsExit = false;
        settingsAreaOk = false;
        // settingsFollowing 的收尾走 endFollow（吸附计时器自持面板引用），
        // 这里只复位跟踪标记。
        settingsFollowing = false;
        settingsPanel = null;
        settingsDx = 0;
      };

      /** 触发后的复核：DOM 与手势目标不一致时只补一次 toggle。 */
      const applyDrawerDecision = (open) => {
        requestDrawer(open);
        if (recheckTimer) win.clearTimeout(recheckTimer);
        recheckTimer = win.setTimeout(() => {
          recheckTimer = 0;
          if (released) return;
          if (getState().mode !== MODE_MOBILE) return;
          if (isDrawerOpen() !== open) requestDrawer(open);
        }, 320);
      };

      /**
       * 进入跟手：抽屉 / 遮罩改由手势引擎直接驱动（CSS 变量）。
       *
       * 官方自己的拖拽约定是 data-dragging 关过渡、data-animating 统一读
       * 缓动变量，这里复用同一语义：跟手期给 <html> 打 data-dshm-following
       * （CSS 关过渡），松手吸附换 data-dshm-settling + 时长变量交还补间。
       * 位移走 <html> 上的 --dshm-drawer-x 变量——官方 React / narrow-sidebar
       * 插件会重写侧栏元素的内联 style（实测清掉内联 transform 导致抽屉
       * 瞬间全弹一帧），根元素上的变量它们碰不到。遮罩用自建的
       * .dshm-drag-mask（opacity 跟进度），跟手期间把官方 React 遮罩
       * display:none 让位，避免双层叠加发黑。
       */
      const beginFollow = (open, baseX) => {
        // openAtStart = 起手时抽屉的当前状态（吸附的起点侧、进度基准），
        // 不是本次手势的目标方向——展开方向误设 true 会让进度公式
        // （从展开态回拖：1 + delta/width）从第一帧就恒为全开。
        openAtStart = isDrawerOpen();
        // 增量跟随基准 = 定向时手指位置（起手区已走的距离不映射到位移）。
        followBaseX = Number.isFinite(baseX) ? baseX : startX;
        following = true;
        lastProgress = openAtStart ? 1 : 0;
        samples = [];
        try {
          reducedMotion = Boolean(
            win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches,
          );
        } catch (error) {
          reducedMotion = false;
        }
        // 减动效（MIUI 关过渡动画等宿主会被 Chromium 判成 reduce）只缩短
        // 吸附补间，不禁跟手：拖拽是手指直接驱动的操作，不是装饰动画——
        // K70（transition scale=0）实测禁跟手会导致抽屉瞬间全开。
        followSidebar = doc.querySelector('[' + ATTR_SIDEBAR + ']');
        console.info("[dshm-gesture] FOLLOW begin open=" + open + " base=" + Math.round(followBaseX) + " w=" + drawerWidth); // TEMP-DEBUG
        if (followSidebar) {
          const rect = followSidebar.getBoundingClientRect();
          if (rect.width > 40) drawerWidth = rect.width;
        }
        // 跟手标记挂 <html>（关过渡 + 防官方同步干扰）；起点变量即当前态，
        // 增量跟随从定向点平滑起步。
        doc.documentElement.setAttribute('data-dshm-following', '');
        // 状态先行（仅展开方向）：官方侧栏在 data-sidebar-collapsed 态渲染
        // 成窄条图标模式（文字不挂载），跟手时只有 transform 在动、内容
        // 一片空白，松手 toggleSidebar 后 React 才展开文字（真机实测）。
        // 这里立即切到展开态让 React 提前挂载内容，视觉仍由变量逐帧驱动；
        // 松手吸附若终态与先行态相反，applyDrawerDecision 会反向 toggle 校正。
        // 收起方向不先行：保持展开态渲染拖到松手，否则拖动中内容反而退化窄条。
        if (open && isDrawerOpen() !== open) requestDrawer(open);
        // React 遮罩会随状态立即淡入（展开方向先行后必然出现），跟手期间
        // 一律让位给自建遮罩，避免双层叠加发黑。
        reactMask = doc.querySelector('.dshm-mask');
        if (reactMask) reactMask.style.display = 'none';
        if (!dragMask) {
          dragMask = doc.createElement('div');
          dragMask.className = 'dshm-drag-mask';
          const host = (followSidebar && followSidebar.parentNode) || doc.body;
          try {
            host.appendChild(dragMask);
          } catch (error) {
            dragMask = null;
          }
        }
        if (dragMask) dragMask.style.opacity = String(openAtStart ? 1 : 0);
      };

      /** 跟手中：按位移刷新抽屉 transform 与遮罩透明度，并采样速度。 */
      const updateFollow = (x) => {
        if (!following) return;
        // 从定向点增量跟随：起手区里手指已走的 24~60px 不映射到位移，
        // 否则抽屉从隐藏位瞬间跳到手指对应位置（视觉闪一下）。
        const delta = x - followBaseX;
        const raw = openAtStart ? 1 + delta / drawerWidth : delta / drawerWidth;
        lastProgress = clamp01(raw);
        moveCount += 1; // TEMP-DEBUG
        if (moveCount <= 4 || moveCount % 10 === 0) console.info('[dshm-gesture] UPD n=' + moveCount + ' base=' + Math.round(followBaseX) + ' x=' + Math.round(x) + ' p=' + lastProgress.toFixed(2)); // TEMP-DEBUG
        // 隐藏位是 translateX(-104%)，进度 p 内插：p=1 恰好归位。
        setDrawerX((lastProgress - 1) * 104);
        if (dragMask) dragMask.style.opacity = lastProgress.toFixed(3);
        const now = win.performance.now();
        samples.push({ t: now, x: x });
        if (samples.length > 8) samples.shift();
      };

      /** 松手吸附：按位移比例 / 速度决定终态，交还 CSS 过渡做补间。 */
      const endFollow = () => {
        if (settingsFollowing) {
          endSettingsFollow();
          return true;
        }
        if (!following) return false;
        following = false;
        let velocity = 0;
        if (samples.length >= 2) {
          const first = samples[0];
          const last = samples[samples.length - 1];
          const dt = last.t - first.t;
          if (dt > 0) velocity = (last.x - first.x) / dt;
        }
        const target = drawerSettle(openAtStart, lastProgress, velocity);
        // 吸附时长按剩余距离与甩速自适应（固定 300ms 会让短距回弹生硬、
        // 半程松手急冲）：decelerate 曲线下长距离前段快后段缓，手感连续。
        // 减动效宿主（reduce-motion）压缩到 100ms。
        const distPx = (Math.abs((target ? 0 : -104) - (lastProgress - 1) * 104) / 100) * drawerWidth;
        const duration = reducedMotion
          ? 100
          : Math.round(Math.max(150, Math.min(420, distPx / Math.max(Math.abs(velocity), 0.3))));
        if (debugOn) {
          console.info(
            '[dsh-mobile-layout] 抽屉吸附：progress=' + lastProgress.toFixed(2) +
              ' velocity=' + velocity.toFixed(3) + ' → ' + (target ? 'open' : 'close') +
              ' in ' + duration + 'ms',
          );
        }
        console.info('[dshm-gesture] SETTLE target=' + target + ' dur=' + duration); // TEMP-DEBUG
        if (followSidebar) {
          // 吸附标记挂 <html>（时长走变量，侧栏内联会被官方同步清掉）。
          doc.documentElement.removeAttribute('data-dshm-following');
          doc.documentElement.setAttribute('data-dshm-settling', '');
          doc.documentElement.style.setProperty('--dshm-settle-dur', duration + 'ms');
          setDrawerX(target ? 0 : -104);
        }
        if (dragMask) {
          dragMask.style.transition = 'opacity ' + duration + 'ms cubic-bezier(0.32, 0.72, 0, 1)';
          dragMask.style.opacity = target ? '1' : '0';
        }
        applyDrawerDecision(target);
        if (settleTimer) win.clearTimeout(settleTimer);
        settleTimer = win.setTimeout(() => {
          settleTimer = 0;
          cleanupFollow(target);
        }, duration + 80);
        return true;
      };

      /**
       * 吸附完成后的清理：还原内联样式与被让位的官方遮罩。
       *
       * 展开终态时官方 React 遮罩可能因槽位缺席而不渲染（overlay 注册
       * 失败的宿主），这时轮询一小段时间，仍没有就挂 MutationObserver
       * 兜底——抽屉日后被任何途径收起时淡出并摘除自建遮罩。
       */
      const cleanupFollow = (target) => {
        const html = doc.documentElement;
        console.info('[dshm-gesture] CLEANUP target=' + target + // TEMP-DEBUG
          ' reactMaskNow=' + Boolean(doc.querySelector('.dshm-mask')) +
          ' drag=' + Boolean(dragMask)); // TEMP-DEBUG
        html.removeAttribute('data-dshm-settling');
        // removeProperty 是 CSSStyleDeclaration 的方法：直接调在元素上会抛
        // TypeError，cleanupFollow 中断——dragMask 永远不会摘除（滑动展开
        // 后 opacity=1，非滑动路径收起抽屉时灰色遮罩永久残留，实测复现）。
        html.style.removeProperty('--dshm-settle-dur');
        // 终态变量保持（展开 0 / 收起 -104），后续由状态同步 observer 维护。
        setDrawerX(target ? 0 : -104);
        if (followSidebar) {
          followSidebar = null;
        }
        if (reactMask) {
          reactMask.style.removeProperty('display');
          reactMask = null;
        }
        if (dragMask && !target) {
          removeNode(dragMask);
          dragMask = null;
        }
        if (maskSwapTimer) {
          win.clearInterval(maskSwapTimer);
          maskSwapTimer = 0;
        }
        if (fallbackObserver) {
          fallbackObserver.disconnect();
          fallbackObserver = null;
        }
        if (dragMask && target) {
          let ticks = 0;
          maskSwapTimer = win.setInterval(() => {
            ticks += 1;
            const reactMaskNow = Boolean(doc.querySelector('.dshm-mask'));
            if (ticks <= 3 || ticks === 10) console.info('[dshm-gesture] SWAPTICK t=' + ticks + ' mask=' + reactMaskNow); // TEMP-DEBUG
            if (reactMaskNow) {
              win.clearInterval(maskSwapTimer);
              maskSwapTimer = 0;
              removeNode(dragMask);
              dragMask = null;
              console.info('[dshm-gesture] MASKSWAP ok ticks=' + ticks); // TEMP-DEBUG
              return;
            }
            if (ticks < 10) return;
            win.clearInterval(maskSwapTimer);
            maskSwapTimer = 0;
            console.info('[dshm-gesture] FALLBACK observer install'); // TEMP-DEBUG
            // 官方遮罩始终不来：转状态观察，抽屉收起时淡出自建遮罩。
            try {
              const host = dragMask ? dragMask.parentNode : null;
              const frame = host && host.closest ? host.closest('[data-dshm-frame]') : null;
              if (!frame || typeof win.MutationObserver !== 'function') return;
              fallbackObserver = new win.MutationObserver(() => {
                if (!isDrawerOpen()) {
                  if (fallbackObserver) {
                    fallbackObserver.disconnect();
                    fallbackObserver = null;
                  }
                  if (dragMask) {
                    dragMask.style.transition = 'opacity 160ms var(--ds-ease-in-out, ease)';
                    dragMask.style.opacity = '0';
                  }
                  win.setTimeout(() => {
                    removeNode(dragMask);
                    dragMask = null;
                  }, 180);
                }
              });
              fallbackObserver.observe(frame, { attributes: true, attributeFilter: ['data-sidebar-collapsed'] });
            } catch (error) {
              /* 观察不可用时保留遮罩，下次手势会重建 */
            }
          }, 60);
        }
      };

      /** 中止跟手并按当前位置吸附（多点触控 / 系统打断时走这里）。 */
      const cancelFollow = () => {
        if (following) {
          endFollow();
          return true;
        }
        if (settingsFollowing) {
          endFollow();
          return true;
        }
        return false;
      };

      /**
       * 设置页跟手：进入跟手阶段，面板位移改由手势引擎驱动（内联 translate）。
       *
       * 设置页全屏铺开时官方没有任何退场动画，边界外滑动复用抽屉的跟手
       * 手感：面板 translate 直接跟手指（方向跟随滑动），松手按位移比例 /
       * 速度吸附（settingsSettle）。
       */
      const beginSettingsFollow = () => {
        settingsPanel = doc.querySelector('[' + ATTR_SETTINGS_PANEL + ']');
        if (!settingsPanel) {
          active = false;
          return false;
        }
        settingsFollowing = true;
        settingsDx = 0;
        samples = [];
        try {
          reducedMotion = Boolean(
            win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches,
          );
        } catch (error) {
          reducedMotion = false;
        }
        // 开场动画的内联 transition 若还在（入场 260ms 内就开滑），关掉再跟手。
        settingsPanel.style.setProperty('transition', 'none', 'important');
        return true;
      };

      /** 设置页跟手中：面板 translate 跟手指（方向随滑动），采样速度。 */
      const updateSettingsFollow = (x) => {
        if (!settingsFollowing || !settingsPanel) return;
        settingsDx = x - followBaseX;
        settingsPanel.style.setProperty('translate', settingsDx.toFixed(1) + 'px 0', 'important');
        const now = win.performance.now();
        samples.push({ t: now, x: x });
        if (samples.length > 8) samples.shift();
      };

      /** 设置页松手吸附：按位移比例 / 速度决定退出或弹回，交还 CSS 过渡补间。 */
      const endSettingsFollow = () => {
        settingsFollowing = false;
        const panel = settingsPanel;
        settingsPanel = null;
        if (!panel || !panel.isConnected) return;
        let velocity = 0;
        if (samples.length >= 2) {
          const first = samples[0];
          const last = samples[samples.length - 1];
          const dt = last.t - first.t;
          if (dt > 0) velocity = (last.x - first.x) / dt;
        }
        const width = Math.max(1, doc.documentElement.clientWidth);
        const close = settingsSettle(settingsDx / width, velocity);
        const distPx = Math.abs(settingsDx - (close ? -width : 0));
        const duration = reducedMotion
          ? 100
          : Math.round(Math.max(140, Math.min(320, distPx / Math.max(Math.abs(velocity), 0.3))));
        if (debugOn) {
          console.info(
            '[dsh-mobile-layout] 设置页吸附：dx=' + Math.round(settingsDx) +
              ' velocity=' + velocity.toFixed(3) + ' → ' + (close ? 'close' : 'back') +
              ' in ' + duration + 'ms',
          );
        }
        panel.style.setProperty('transition', 'translate ' + duration + 'ms cubic-bezier(0.32, 0.72, 0, 1)', 'important');
        panel.style.setProperty('translate', close ? (settingsDx < 0 ? '-105% 0' : '105% 0') : '0 0', 'important');
        win.setTimeout(() => {
          panel.style.removeProperty('transition');
          panel.style.removeProperty('translate');
          if (close && panel.isConnected) closeSettingsImmediate();
        }, duration + 30);
      };

      const gestureStart = (x, y, target, tag, id) => {
        // 双通道去重：同一次手势 pointerdown 先于 touchstart 到达，后到的
        // 通道的起点忽略（坐标一致，重置反而丢信息）。
        if (active && source && source !== tag) return;
        resetGesture();
        if (getState().mode !== MODE_MOBILE) return;
        try {
          debugOn = String(win.localStorage.getItem('dshm-debug')) === '1';
        } catch (error) {
          debugOn = false;
        }
        debugOn = true; // TEMP-DEBUG: 真机取证用，验收后删除
        if (debugOn) console.info('[dshm-gesture] START x=' + Math.round(x) + ' y=' + Math.round(y) + ' w=' + doc.documentElement.clientWidth + ' mode=' + getState().mode + ' open=' + isDrawerOpen()); // TEMP-DEBUG
        if (target && target.closest && target.closest('[' + ATTR_SWIPE_IGNORE + ']')) {
          debugLog('SWIPE_IGNORE');
          return;
        }
        if (doc.querySelector('[data-rightbar-fullscreen]')) {
          debugLog('RIGHTBAR_FULLSCREEN');
          return;
        }
        if (overlayBlocked()) {
          debugLog('BLOCKED_LAYER');
          return;
        }
        // 设置页不再当死区：起手时在屏上就进入「边界外滑动退出」模式（本轮
        // 手势不再参与抽屉开关）；准入与翻页一致（内容滚动区、非输入控件）。
        settingsExit = settingsPanelOpen();
        settingsAreaOk = settingsExit ? canStartSettingsSwipe(target) : false;
        active = true;
        source = tag;
        startX = x;
        startY = y;
        startTarget = target || null;
        if (tag === 'pointer') pointerId = id;
        else touchId = id;
      };

      const gestureMove = (x, y) => {
        if (!active) return;
        const dx = x - startX;
        const dy = y - startY;
        const horizontal = Math.abs(dx);
        // 意图确认（24px）：竖滑明显就整轮作废，交给内容滚动。
        if (!armed) {
          if (horizontal < SWIPE_ARM_PX) return;
          if (Math.abs(dy) > horizontal * 1.2) {
            debugLog('TOO_VERTICAL');
            resetGesture();
            return;
          }
        }
        const dir = dx > 0 ? 1 : -1;
        console.info('[dshm-gesture] MOVE x=' + Math.round(x) + ' dx=' + Math.round(dx) + ' armed=' + armed + ' follow=' + following); // TEMP-DEBUG
        // 定向（含方向翻转）时判定一次让路：容器已到边界就交还抽屉。
        if (dir !== armed) {
          armed = dir;
          const scroller = horizScrollerOf(startTarget);
          hConsume = scroller ? scrollerConsumes(scroller, dx) : false;
          if (hConsume) debugLog('H_SCROLLER');
        }
        if (following) {
          updateFollow(x);
          return;
        }
        // 设置页退出：内容区由插件的 settingsSwipe 左右滑动换页，仅保留
        // 左边界退出——最左页签上右滑（翻页吞不掉）时面板跟手退出；其余
        // 方向一律让路换页，面板不动。
        if (settingsFollowing) {
          updateSettingsFollow(x);
          return;
        }
        if (settingsExit) {
          if (!settingsAreaOk) {
            debugLog('SETTINGS_AREA');
            if (horizontal >= SWIPE_MIN) {
              active = false;
              armed = 0;
            }
            return;
          }
          if (hConsume || settingsPagerCanConsume(dir)) {
            debugLog(hConsume ? 'H_SCROLLER' : 'SETTINGS_PAGE');
            if (horizontal >= SWIPE_MIN) {
              active = false;
              armed = 0;
            }
            return;
          }
          if (horizontal < SWIPE_ARM_PX) return;
          followBaseX = x;
          if (!beginSettingsFollow()) return;
          updateSettingsFollow(x);
          return;
        }
        // 未跟手：24px 处一次性判定资格（起手区 / 方向 / 抽屉状态），合格
        // 即进入跟手（减动效宿主退化为阈值触发）；不合格直接停跟踪——
        // 资格条件（起手点、抽屉状态）在本轮手势内不会变化，无需反复判。
        const decision = decideDrawerGesture(
          {
            dx: dx,
            dy: dy,
            startX: startX,
            width: doc.documentElement.clientWidth,
            drawerOpen: isDrawerOpen(),
            blocked: false,
            hScrollerConsumes: hConsume,
          },
          SWIPE_ARM_PX,
        );
        if (decision === 'open' || decision === 'close') {
          beginFollow(decision === 'open', x);
          if (following) updateFollow(x);
          else applyDrawerDecision(decision === 'open');
        } else if (horizontal >= SWIPE_MIN) {
          // 过了阈值还不合格（起手出区 / 容器还要滚）：本轮放弃。
          debugLog(hConsume ? 'H_SCROLLER' : 'OUT_OF_ZONE');
          active = false;
          armed = 0;
        }
      };

      const touchById = (list, id) => {
        if (!list || !list.length) return null;
        if (id < 0) return list.length === 1 ? list.item(0) : null;
        for (let i = 0; i < list.length; i += 1) {
          const touch = list.item(i);
          if (touch && touch.identifier === id) return touch;
        }
        return null;
      };

      const onTouchStart = (event) => {
        if (!event.touches || event.touches.length !== 1) {
          // 第二根手指落下：跟手中的按当前进度吸附收尾，否则直接弃。
          if (!cancelFollow()) resetGesture();
          return;
        }
        const touch = event.touches[0];
        gestureStart(touch.clientX, touch.clientY, event.target, 'touch', touch.identifier);
      };
      const onTouchMove = (event) => {
        if (!active || source !== 'touch') return;
        if (!event.touches || event.touches.length !== 1) {
          console.info('[dshm-gesture] MOVE-BAD len=' + (event.touches ? event.touches.length : 'null') + ' follow=' + following); // TEMP-DEBUG
          if (!cancelFollow()) resetGesture();
          return;
        }
        const touch = touchById(event.touches, touchId);
        if (!touch) {
          console.info('[dshm-gesture] MOVE-NOID id=' + touchId + ' ids=' + Array.from(event.touches).map(function (t) { return t.identifier; }).join(',')); // TEMP-DEBUG
          return;
        }
        gestureMove(touch.clientX, touch.clientY);
      };
      const onTouchEnd = (event) => {
        if (source !== 'touch') return;
        const list = event.changedTouches;
        if (list && touchId >= 0) {
          for (let i = 0; i < list.length; i += 1) {
            const touch = list.item(i);
            if (touch && touch.identifier === touchId) {
              endFollow();
              resetGesture();
              return;
            }
          }
          return;
        }
        endFollow();
        resetGesture();
      };

      const onPointerDown = (event) => {
        // 触摸一律交给 touch 通道：Android WebView 的 pointer 序列会在页面
        // 滚动容器接管时被 pointercancel 截杀（聊天页竖向可滚，右滑必中招），
        // 而 touch 事件全程稳定派发不受影响。pointer 通道只服务鼠标 / 触控笔。
        if (event.pointerType === 'touch') return;
        gestureStart(event.clientX, event.clientY, event.target, 'pointer', event.pointerId);
      };
      const onPointerMove = (event) => {
        if (!active || source !== 'pointer' || event.pointerId !== pointerId) return;
        gestureMove(event.clientX, event.clientY);
      };
      const onPointerUp = (event) => {
        if (source !== 'pointer' || event.pointerId !== pointerId) return;
        // pointercancel（系统打断）同样按当前进度吸附，避免抽屉停在半路。
        endFollow();
        resetGesture();
      };

      const CAPTURE_PASSIVE = { capture: true, passive: true };
      win.addEventListener('touchstart', onTouchStart, CAPTURE_PASSIVE);
      win.addEventListener('touchmove', onTouchMove, CAPTURE_PASSIVE);
      win.addEventListener('touchend', onTouchEnd, CAPTURE_PASSIVE);
      win.addEventListener('touchcancel', onTouchEnd, CAPTURE_PASSIVE);
      win.addEventListener('pointerdown', onPointerDown, CAPTURE_PASSIVE);
      win.addEventListener('pointermove', onPointerMove, CAPTURE_PASSIVE);
      win.addEventListener('pointerup', onPointerUp, CAPTURE_PASSIVE);
      win.addEventListener('pointercancel', onPointerUp, CAPTURE_PASSIVE);
      console.info('[dshm-gesture] BOUND ok, listeners=8'); // TEMP-DEBUG
      // 官方状态 → 位移变量同步：遮罩点击 / Esc / 会话切换等任何途径开关
      // 抽屉时保持视觉一致（位移已从 CSS 状态规则改为变量驱动）。
      // subtree+attributeFilter 回调极轻；跟手 / 吸附期间 syncDrawerX 空转。
      followObserver = new win.MutationObserver(() => {
        if (frameElement()) {
          syncDrawerX();
          console.info('[dshm-gesture] ATTRSYNC open=' + isDrawerOpen() + // TEMP-DEBUG
            ' reactMask=' + Boolean(doc.querySelector('.dshm-mask')) +
            ' drag=' + (dragMask ? String(dragMask.style.opacity) : '-') +
            ' x=' + doc.documentElement.style.getPropertyValue('--dshm-drawer-x')); // TEMP-DEBUG
        }
      });
      followObserver.observe(doc.body || doc.documentElement, {
        attributes: true,
        attributeFilter: ['data-sidebar-collapsed'],
        subtree: true,
      });

      return function release() {
        released = true;
        if (recheckTimer) {
          win.clearTimeout(recheckTimer);
          recheckTimer = 0;
        }
        if (settleTimer) {
          win.clearTimeout(settleTimer);
          settleTimer = 0;
        }
        if (maskSwapTimer) {
          win.clearInterval(maskSwapTimer);
          maskSwapTimer = 0;
        }
        if (fallbackObserver) {
          fallbackObserver.disconnect();
          fallbackObserver = null;
        }
        if (followSidebar) {
          followSidebar = null;
        }
        if (followObserver) {
          followObserver.disconnect();
          followObserver = null;
        }
        if (reactMask) {
          reactMask.style.removeProperty('display');
          reactMask = null;
        }
        removeNode(dragMask);
        dragMask = null;
        const html = doc.documentElement;
        html.removeAttribute('data-dshm-following');
        html.removeAttribute('data-dshm-settling');
        html.style.removeProperty('--dshm-settle-dur');
        resetGesture();
        win.removeEventListener('touchstart', onTouchStart, CAPTURE_PASSIVE);
        win.removeEventListener('touchmove', onTouchMove, CAPTURE_PASSIVE);
        win.removeEventListener('touchend', onTouchEnd, CAPTURE_PASSIVE);
        win.removeEventListener('touchcancel', onTouchEnd, CAPTURE_PASSIVE);
        win.removeEventListener('pointerdown', onPointerDown, CAPTURE_PASSIVE);
        win.removeEventListener('pointermove', onPointerMove, CAPTURE_PASSIVE);
        win.removeEventListener('pointerup', onPointerUp, CAPTURE_PASSIVE);
        win.removeEventListener('pointercancel', onPointerUp, CAPTURE_PASSIVE);
      };
    }

    // ---- 样式 ----
    const STYLE_ID = 'dshm-style';

    const CSS_TEXT = [
      'html[data-dshm-mode="mobile"] {',
      /* 顶部宿主悬浮条实测占位（含「引擎已就绪」那条），底部浮层不得越过它。 */
      '  --dshm-header-height: 56px;',
      '  --dshm-bar-height: 56px;',
      '  --dshm-drawer-width: min(86vw, 280px);',
      '  --dshm-safe-top: env(safe-area-inset-top, 0px);',
      '  --dshm-safe-left: env(safe-area-inset-left, 0px);',
      '  --dshm-safe-right: env(safe-area-inset-right, 0px);',
      '  --dshm-safe-bottom: env(safe-area-inset-bottom, 0px);',
      '}',
      /* 手机竖屏：侧栏列不占内容宽度，主列全宽；右栏全屏时交还官方网格。 */
      'html[data-dshm-mode="mobile"] [data-dshm-frame]:not([data-rightbar-fullscreen]) {',
      '  grid-template-columns: 0 minmax(0, 1fr) 0 !important;',
      '}',
      'html[data-dshm-mode="mobile"] [data-dshm-center] {',
      '  border-left: none !important;',
      '  min-width: 0;',
      '  grid-column: 2 !important;',
      '  grid-row: 1 !important;',
      '}',
      'html[data-dshm-mode="mobile"] [data-dshm-rightbar] {',
      '  grid-column: 3 !important;',
      '  grid-row: 1 !important;',
      '  min-width: 0;',
      '}',
      /* 官方侧栏列变成离屏抽屉。位移由 <html> 上的 --dshm-drawer-x 变量驱动：
         官方 React / narrow-sidebar 插件会重写侧栏元素的内联 style（实测清掉
         内联 transform 导致抽屉瞬间全弹一帧），挂根元素上的变量它们碰不到。
         变量由手势引擎维护（跟手 / 吸附 / 状态同步 observer），缺省收起。 */
      'html[data-dshm-mode="mobile"] [data-dshm-sidebar] {',
      '  position: absolute;',
      '  inset: 0 auto 0 0;',
      '  z-index: 30;',
      '  width: var(--dshm-drawer-width);',
      '  max-width: 86vw;',
      '  height: 100%;',
      '  overflow: hidden;',
      '  border-radius: 0 var(--dsw-radius-lg, 16px) var(--dsw-radius-lg, 16px) 0;',
      '  box-shadow: var(--dsw-shadow-lv3, 0 12px 32px rgba(0, 0, 0, 0.32));',
      '  transform: translateX(var(--dshm-drawer-x, -104%));',
      '  transition: transform var(--ds-transition-duration-slow, 220ms) var(--ds-ease-in-out, ease);',
      '  will-change: transform;',
      '}',
      /* 跟手期关过渡（官方 data-dragging 同一语义），位移由手势逐帧驱动。
         标记挂 <html>：侧栏元素上的属性 / 内联都会被官方同步清掉。 */
      'html[data-dshm-mode="mobile"][data-dshm-following] [data-dshm-sidebar] {',
      '  transition: none !important;',
      '}',
      /* 吸附补间：时长由 JS 按剩余距离 / 甩速写入 --dshm-settle-dur。 */
      'html[data-dshm-mode="mobile"][data-dshm-settling] [data-dshm-sidebar] {',
      '  transition: transform var(--dshm-settle-dur, 300ms) cubic-bezier(0.32, 0.72, 0, 1) !important;',
      '}',
      'html[data-dshm-mode="mobile"] [data-dshm-sidebar] > * {',
      '  width: 100% !important;',
      '  max-width: none;',
      '}',
      /* 官方 Android narrow-sidebar 在抽屉展开时会隐藏中心列/右栏并把侧栏
         拉成整行；抽屉需要内容留在原位，这里把它的标记还原。 */
      'html[data-dshm-mode="mobile"] [data-android-narrow-yield-col] {',
      '  display: block !important;',
      '}',
      'html[data-dshm-mode="mobile"] [data-android-narrow-sidebar-col] {',
      '  grid-column: auto !important;',
      '}',
      /* 抽屉遮罩：位于内容之上、抽屉之下（overlayLayer z=20 < sidebar z=30）。
         颜色走官方遮罩 alias token。 */
      'html[data-dshm-mode="mobile"] .dshm-mask {',
      '  position: absolute;',
      '  inset: 0;',
      '  z-index: 25;',
      '  background: var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.38));',
      '  border: 0;',
      '  padding: 0;',
      '  transition: opacity 160ms var(--ds-ease-in-out, ease);',
      '}',
      /* 跟手期自建遮罩：透明度由手势逐帧驱动，自身不带过渡（吸附淡入 /
         淡出时由 JS 临时补 inline transition），不接收指针事件。 */
      'html[data-dshm-mode="mobile"] .dshm-drag-mask {',
      '  position: absolute;',
      '  inset: 0;',
      '  z-index: 25;',
      '  background: var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.38));',
      '  opacity: 0;',
      '  pointer-events: none;',
      '}',
      /* 底部常驻条由官方 shell.bottom 行承载（grid 第二行 auto），
         高度含安全区，避免手势条遮挡最后一个按键。与输入区同表面，
         不再画分隔线（分隔线只在输入区顶端，见下）。 */
      'html[data-dshm-mode="mobile"] [data-dshm-bottom] {',
      '  padding: 0 env(safe-area-inset-right) var(--dshm-safe-bottom) env(safe-area-inset-left);',
      '  background: var(--dsw-alias-bg-base, #fff);',
      '  border-top: 0 !important;',
      '}',
      'html[data-dshm-mode="mobile"] .dshm-bottom-bar {',
      '  display: flex;',
      '  align-items: stretch;',
      '  width: 100%;',
      '  height: var(--dshm-bar-height);',
      '}',
      'html[data-dshm-mode="mobile"] .dshm-bar-btn {',
      '  flex: 1 1 0;',
      '  min-width: 44px;',
      '  min-height: 44px;',
      '  display: inline-flex;',
      '  flex-direction: column;',
      '  align-items: center;',
      '  justify-content: center;',
      '  gap: 2px;',
      '  padding: 0;',
      '  border: 0;',
      '  background: transparent;',
      '  color: var(--dsw-alias-label-secondary, inherit);',
      '  font-size: 11px;',
      '  line-height: 1;',
      '  -webkit-tap-highlight-color: transparent;',
      '}',
      'html[data-dshm-mode="mobile"] .dshm-bar-btn:active {',
      '  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12));',
      '}',
      'html[data-dshm-mode="mobile"] .dshm-bar-btn[aria-expanded="true"] {',
      '  color: var(--dsw-alias-label-primary, inherit);',
      '}',
      /* 底部表：止于常驻条上沿，遮罩避开常驻条，保证随时可切换面板。 */
      /* 弹层动效（v1.4.57）：对齐官方「预览版说明」卡片的出现节奏 —— 遮罩淡入、
         面板从底部上滑，缓动带一点收尾减速。 */
      '@keyframes dshm-sheet-up {',
      '  from { transform: translateY(100%); }',
      '  to { transform: translateY(0); }',
      '}',
      '@keyframes dshm-sheet-fade {',
      '  from { opacity: 0; }',
      '  to { opacity: 1; }',
      '}',
      'html[data-dshm-mode="mobile"] .dshm-sheet-mask {',
      '  position: absolute;',
      '  inset: 0 0 calc(var(--dshm-bar-height) + var(--dshm-safe-bottom)) 0;',
      '  z-index: 24;',
      '  border: 0;',
      '  padding: 0;',
      '  background: rgba(0, 0, 0, 0.45);',
      '  animation: dshm-sheet-fade 180ms ease-out;',
      '}',
      'html[data-dshm-mode="mobile"] .dshm-sheet {',
      '  position: absolute;',
      '  left: 0;',
      '  right: 0;',
      '  bottom: calc(var(--dshm-bar-height) + var(--dshm-safe-bottom));',
      '  z-index: 27;',
      '  display: flex;',
      '  flex-direction: column;',
      /* 高度上限三档：常规屏最多占 64%（官方弹层比例，留住上方对话上下文，
         拇指也够得着）；屏特别矮时 64% 放不下几行，用 300px 下限继续往上长；
         最后统一封顶在顶部悬浮条以下，任何屏都不会越过它。 */
      '  max-height: min(max(300px, calc(var(--dshm-viewport-height, 100vh) * 0.64)), calc(var(--dshm-viewport-height, 100vh) - var(--dshm-bar-height) - var(--dshm-header-height) - 8px));',
      '  padding-bottom: 10px;',
      '  border-radius: 28px 28px 0 0;',
      /* 官方弹窗是「抬升面」（v1.4.57 对色取图）：卡片 rgb(44,44,46) 明显亮于
         页面 rgb(13,13,14)，并带 1px 浅描边 rgb(61,61,62)。这里用「页面底色 +
         9% 白叠加」得到等效抬升，浅色主题下叠加近似无效、自动退化为白底。 */
      '  background: linear-gradient(rgba(255, 255, 255, 0.09), rgba(255, 255, 255, 0.09)), var(--dsw-alias-bg-base, #fff);',
      '  border: 1px solid rgba(127, 127, 127, 0.25);',
      '  border-bottom: 0;',
      '  box-shadow: 0 -12px 40px rgba(0, 0, 0, 0.28);',
      '  overflow: hidden;',
      '  animation: dshm-sheet-up 220ms cubic-bezier(0.32, 0.72, 0, 1);',
      '}',
      /* 顶部把手：官方卡片的「拖拽暗示」。往下拖超过阈值松手即关闭。 */
      'html[data-dshm-mode="mobile"] .dshm-sheet-grabber {',
      '  flex: none;',
      '  width: 40px;',
      '  height: 4px;',
      '  margin: 10px auto 0;',
      '  border-radius: 999px;',
      '  background: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.6));',
      '  opacity: 0.55;',
      '  touch-action: none;',
      '}',
      'html[data-dshm-mode="mobile"] .dshm-sheet-head {',
      '  display: flex;',
      '  align-items: center;',
      '  justify-content: space-between;',
      '  gap: 8px;',
      '  padding: 8px 20px 12px;',
      '  font-size: 15px;',
      '  font-weight: 700;',
      '  color: var(--dsw-alias-label-primary, inherit);',
      '}',
      'html[data-dshm-mode="mobile"] .dshm-sheet-title {',
      '  min-width: 0;',
      '  overflow: hidden;',
      '  text-overflow: ellipsis;',
      '  white-space: nowrap;',
      '  font-size: 20px;',
      '  font-weight: 700;',
      '  letter-spacing: -0.01em;',
      '}',
      'html[data-dshm-mode="mobile"] .dshm-sheet-sub {',
      '  margin-left: 8px;',
      '  color: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.95));',
      '  font-size: 12px;',
      '  font-weight: 400;',
      '}',
      'html[data-dshm-mode="mobile"] .dshm-sheet-close {',
      '  width: 32px;',
      '  height: 32px;',
      '  padding: 0;',
      '  border: 0;',
      '  border-radius: 999px;',
      '  background: transparent;',
      '  color: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.9));',
      '  font-size: 20px;',
      '  line-height: 1;',
      '  opacity: 0.7;',
      '}',
      'html[data-dshm-mode="mobile"] .dshm-sheet-list {',
      '  padding: 0 10px 4px;',
      '  overflow-y: auto;',
      '  -webkit-overflow-scrolling: touch;',
      '}',
      'html[data-dshm-mode="mobile"] .dshm-sheet-row {',
      '  display: flex;',
      '  align-items: center;',
      '  justify-content: space-between;',
      '  gap: 8px;',
      '  width: 100%;',
      '  min-height: 52px;',
      '  padding: 10px 14px;',
      '  border: 0;',
      '  border-radius: 14px;',
      '  background: transparent;',
      '  color: var(--dsw-alias-label-primary, inherit);',
      '  font-size: 15px;',
      '  text-align: left;',
      '}',
      'html[data-dshm-mode="mobile"] .dshm-sheet-row:active {',
      '  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12));',
      '}',
      'html[data-dshm-mode="mobile"] .dshm-sheet-row.is-current {',
      '  color: var(--dsw-alias-label-primary-bluish, #4d6bfe);',
      '}',
      'html[data-dshm-mode="mobile"] .dshm-sheet-row-main {',
      '  display: flex;',
      '  flex-direction: column;',
      '  gap: 2px;',
      '  flex: 1 1 auto;',
      '  min-width: 0;',
      '}',
      /* 工作区分组头：贴在列表顶部，滚动时保持可见。 */
      'html[data-dshm-mode="mobile"] .dshm-sheet-group {',
      '  display: block;',
      '}',
      'html[data-dshm-mode="mobile"] .dshm-sheet-group-head {',
      '  position: sticky;',
      '  top: 0;',
      '  z-index: 1;',
      '  display: flex;',
      '  align-items: center;',
      '  justify-content: space-between;',
      '  gap: 8px;',
      '  padding: 16px 14px 8px;',
      '  background: var(--dsw-alias-bg-base, #fff);',
      '  font-size: 12px;',
      '  font-weight: 600;',
      '  letter-spacing: 0.02em;',
      '  color: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.95));',
      '}',
      'html[data-dshm-mode="mobile"] .dshm-sheet-group-name {',
      '  overflow: hidden;',
      '  text-overflow: ellipsis;',
      '  white-space: nowrap;',
      '}',
      'html[data-dshm-mode="mobile"] .dshm-sheet-group-count {',
      '  flex: none;',
      '  font-weight: 400;',
      '  opacity: 0.7;',
      '  font-variant-numeric: tabular-nums;',
      '}',
      /* 分组下会话行缩进一级，用留白表达从属关系（不再逐行重复工作区名）。 */
      'html[data-dshm-mode="mobile"] .dshm-sheet-list.is-grouped .dshm-sheet-row {',
      '  padding-left: 24px;',
      '}',
      'html[data-dshm-mode="mobile"] .dshm-sheet-row-title {',
      '  overflow: hidden;',
      '  text-overflow: ellipsis;',
      '  white-space: nowrap;',
      '}',
      'html[data-dshm-mode="mobile"] .dshm-sheet-row-time {',
      '  flex: none;',
      '  color: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.95));',
      '  font-size: 11px;',
      '  font-variant-numeric: tabular-nums;',
      '}',
      'html[data-dshm-mode="mobile"] .dshm-sheet-badge {',
      '  flex: none;',
      '  padding: 3px 9px;',
      '  border: 0;',
      '  border-radius: 999px;',
      '  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.14));',
      '  font-size: 11px;',
      '  font-weight: 500;',
      '}',
      'html[data-dshm-mode="mobile"] .dshm-sheet-empty {',
      '  margin: 12px 16px 16px;',
      '  font-size: 13px;',
      '  color: var(--dsw-alias-label-secondary, inherit);',
      '}',
      'html[data-dshm-mode="mobile"] .dshm-sheet-hint {',
      '  margin: 0 16px 12px;',
      '  font-size: 13px;',
      '  line-height: 1.5;',
      '  color: var(--dsw-alias-label-secondary, inherit);',
      '}',
      'html[data-dshm-mode="mobile"] .dshm-sheet-action {',
      '  display: block;',
      '  min-height: 52px;',
      '  margin: 8px 12px 12px;',
      '  padding: 15px 18px;',
      '  border: 0;',
      '  border-radius: 999px;',
      '  background: var(--dsw-alias-label-primary, #fff);',
      '  color: var(--dsw-alias-bg-base, #000);',
      '  font-size: 15px;',
      '  font-weight: 600;',
      '  text-align: center;',
      '}',
      /* 输入行权限 / 模型 chip：隐藏官方长文案，用伪元素渲染短文案。
         权限按钮保留盾牌图标，去掉 chevron（图标 + 短文案即可表达可点）；
         模型按钮整块换成 `V4.1 · H`，完整名称仍由 aria-label 提供。 */
      'html[data-dshm-mode="mobile"] [data-dshm-perm-chip],',
      'html[data-dshm-mode="mobile"] [data-dshm-model-chip] {',
      '  font-size: 0 !important;',
      '  gap: 4px !important;',
      '  padding: 0 6px !important;',
      '  min-width: 0 !important;',
      '  max-width: 46vw !important;',
      '}',
      'html[data-dshm-mode="mobile"] [data-dshm-perm-chip] > span:not([aria-hidden="true"]),',
      'html[data-dshm-mode="mobile"] [data-dshm-perm-chip] > span[aria-hidden="true"]:last-of-type {',
      '  display: none !important;',
      '}',
      'html[data-dshm-mode="mobile"] [data-dshm-model-chip] > * {',
      '  display: none !important;',
      '}',
      'html[data-dshm-mode="mobile"] [data-dshm-perm-chip]::after,',
      'html[data-dshm-mode="mobile"] [data-dshm-model-chip]::after {',
      '  content: attr(data-dshm-short);',
      '  overflow: hidden;',
      '  font-size: 12px;',
      '  line-height: 1;',
      '  white-space: nowrap;',
      '  text-overflow: ellipsis;',
      '}',
      /* 「完全访问」高危权限：输入行 chip 的短文案与盾牌图标同步标红。 */
      'html[data-dshm-mode="mobile"] [data-dshm-perm-chip][data-dshm-perm-danger]::after {',
      '  color: #e5484d !important;',
      '}',
      'html[data-dshm-mode="mobile"] [data-dshm-perm-chip][data-dshm-perm-danger] svg {',
      '  color: #e5484d !important;',
      '}',
      /* 输入行贴底：hero（空会话）态官方把整段 composer 垂直居中，用自动
         外边距把输入座压到内容区底部；再由 JS 标记 hero 多余的下内边距并
         清零，使输入行下沿与常驻条上沿齐平。正常会话官方本就贴底，无副作用。 */
      'html[data-dshm-mode="mobile"] [data-composer-seat] {',
      '  margin-top: auto !important;',
      '}',
      'html[data-dshm-mode="mobile"] [data-dshm-composer-pad] {',
      '  padding-bottom: 0 !important;',
      '}',
      /* 空会话 hero 脱离输入区：官方把这层空态浮层放在 composer 里，内容块
         贴着输入卡；JS 量出内容块到「标题栏/状态带下沿 → 输入卡上沿」中点的
         位移，写进 --dshm-hero-shift，这里只做平移，不改浮层自身布局。 */
      'html[data-dshm-mode="mobile"] [data-dshm-hero] {',
      '  transform: translateY(var(--dshm-hero-shift, 0px)) !important;',
      '}',
      /* 输入行内的官方 ⊕（添加文件/调用指令）隐藏，只保留常驻条最右侧的 ⊕。 */
      'html[data-dshm-mode="mobile"] [data-dshm-add-chip] {',
      '  display: none !important;',
      '}',
      /* 空态输入区收紧：输入框一行高度由官方 36px 压到 24px（2/3），
         去掉顶部额外内边距，工具行上方留白压到 4px；输入多行时仍按官方
         逻辑自增（受官方 max-height 约束）。 */
      'html[data-dshm-mode="mobile"] [data-composer-card] {',
      '  row-gap: 4px !important;',
      '}',
      'html[data-dshm-mode="mobile"] [data-composer-card] [class*="_input"] {',
      '  min-height: 24px !important;',
      '  padding-top: 0 !important;',
      '}',
      /* 输入卡与常驻条融合：官方输入卡是带圆角、边框、阴影和左右留白的
         浮层，窄屏下与常驻条割裂。card 到 composerSeat 之间的外壳统一去掉
         圆角/边框/阴影和左右留白，card 拉满宽度，与常驻条成为同一条全宽
         底部面板；分隔线只在输入区顶端保留一条。 */
      'html[data-dshm-mode="mobile"] [data-dshm-composer-flat] {',
      '  border-radius: 0 !important;',
      '  border: 0 !important;',
      '  box-shadow: none !important;',
      '  margin-left: 0 !important;',
      '  margin-right: 0 !important;',
      '  padding-left: 0 !important;',
      '  padding-right: 0 !important;',
      '  background: var(--dsw-alias-bg-base, #fff) !important;',
      '}',
      'html[data-dshm-mode="mobile"] [data-composer-card] {',
      '  width: 100% !important;',
      '  max-width: none !important;',
      '}',
      /* 卡片拉满后输入区滚动条会贴在窗口右缘，像一条割裂面板的竖线；
         移动端不显示滚动条，触摸滚动不受影响。 */
      'html[data-dshm-mode="mobile"] [data-composer-seat],',
      'html[data-dshm-mode="mobile"] [data-composer-seat] * {',
      '  scrollbar-width: none;',
      '}',
      'html[data-dshm-mode="mobile"] [data-composer-seat]::-webkit-scrollbar,',
      'html[data-dshm-mode="mobile"] [data-composer-seat] *::-webkit-scrollbar {',
      '  width: 0 !important;',
      '  height: 0 !important;',
      '  display: none !important;',
      '}',
      'html[data-dshm-mode="mobile"] [data-composer-seat] {',
      '  padding-left: 0 !important;',
      '  padding-right: 0 !important;',
      '  background: var(--dsw-alias-bg-base, #fff) !important;',
      /* 输入区与上方会话正文同为白底，0.5px 的官方边框在窄屏缩放下几乎看不见；
         改为 1px 且加深一档，给「对话输入区」和「信息页面」一条明确分界线。 */
      '  border-top: 1px solid rgba(0, 0, 0, 0.14) !important;',
      '}',
      /* 空会话：hero 区留在 seat 顶部，分界线下移到输入卡上方的工作区选择行，
         否则一条线会悬在 hero 与输入区之间。 */
      'html[data-dshm-mode="mobile"][data-dshm-composer-split] [data-composer-seat] {',
      '  border-top: 0 !important;',
      '}',
      'html[data-dshm-mode="mobile"] [data-dshm-composer-edge] {',
      '  border-top: 1px solid rgba(0, 0, 0, 0.14) !important;',
      '}',
      /* 会话统计（轮次/速度、Token 用量、上下文占用）：从输入区挪到会话
         标题栏下方，固定为一条常驻状态带；标题栏底部预留同高内边距，
         正文从状态带下方开始，滚动时不会被遮挡。 */
      'html[data-dshm-mode="mobile"][data-dshm-stats-on] [data-dshm-center] header[data-window-drag] {',
      '  padding-bottom: var(--dshm-stats-height, 26px) !important;',
      '}',
      'html[data-dshm-mode="mobile"] [data-dshm-stats] {',
      '  position: fixed !important;',
      '  top: var(--dshm-stats-top, 86px) !important;',
      '  left: var(--dshm-safe-left, 0px) !important;',
      '  right: var(--dshm-safe-right, 0px) !important;',
      '  bottom: auto !important;',
      '  z-index: 6 !important;',
      '  box-sizing: border-box;',
      '  height: var(--dshm-stats-height, 26px);',
      '  margin: 0 !important;',
      '  padding: 0 10px !important;',
      '  gap: 6px !important;',
      '  display: flex !important;',
      '  align-items: center !important;',
      '  justify-content: safe center !important;',
      '  background: var(--dsw-alias-bg-base, #fff) !important;',
      '  border-bottom: 0.5px solid var(--dsw-alias-border-l3, rgba(127, 127, 127, 0.25));',
      '  overflow-x: auto;',
      '  overflow-y: hidden;',
      '  -webkit-overflow-scrolling: touch;',
      '}',
      /* 窄屏三组统计按官方 12px 会因系统字体更宽而被省略号截断；状态带本就
         是常驻细条，降到 11px 并取消按钮收缩，保证「缓存命中 54%」等关键
         数字完整；万一本地化文案更长，仍可横向滑动查看。 */
      'html[data-dshm-mode="mobile"] [data-dshm-stats] button {',
      '  flex: 0 0 auto !important;',
      '  font-size: 11px !important;',
      '}',
      'html[data-dshm-mode="mobile"] [data-dshm-stats] button span {',
      '  text-overflow: clip !important;',
      '}',
      'html[data-dshm-mode="mobile"] [data-dshm-frame][data-rightbar-fullscreen] [data-dshm-stats] {',
      '  display: none !important;',
      '}',
      /* 菜单在 header 子树里，菜单自身的 9999 只在 header 的层叠上下文内比较；
         展开期间把 header 提成独立层叠上下文（z 50），排在消息列表、
         统计状态带（z 6）与 composerSeat（z 7）之上，菜单可直接盖住状态带，
         不再需要把状态带隐藏（隐藏会在标题栏下方留出一条空白）。 */
      'html[data-dshm-mode="mobile"][data-dshm-header-menu-open] [data-dshm-center] header[data-window-drag] {',
      '  position: relative !important;',
      '  z-index: 50 !important;',
      '}',
      /* 官方把菜单放在 headerUtilities 里，但中间层不是层叠上下文，导致 header
         内那条 _tabs（对话/轨迹 切换条，透明却全宽）在命中顺序上压过菜单首行，
         「下载 Session 日志」点不到。展开期间把菜单到 header 的祖先链一起抬成
         层叠上下文，菜单整体越过 _tabs。 */
      'html[data-dshm-mode="mobile"][data-dshm-header-menu-open] [data-dshm-header-menu-host] {',
      '  position: relative !important;',
      '  z-index: 60 !important;',
      '}',
      /* 顶栏 ⋯（更多操作）的菜单保持右上角下拉列表：紧贴按钮下沿、右缘紧贴
         窗口，并提到所有浮层之上；不并入底部面板，也不挤占输入区。 */
      'html[data-dshm-mode="mobile"] [data-dshm-header-menu] {',
      '  position: fixed !important;',
      '  top: var(--dshm-header-menu-top, 46px) !important;',
      '  left: auto !important;',
      '  right: var(--dshm-header-menu-right, 0px) !important;',
      '  bottom: auto !important;',
      '  width: 220px !important;',
      '  max-width: calc(100vw - 12px) !important;',
      '  max-height: 60vh !important;',
      '  margin: 0 !important;',
      '  border-radius: 12px 0 0 12px !important;',
      '  background: var(--dsw-alias-bg-base, #fff) !important;',
      '  opacity: 1 !important;',
      '  backdrop-filter: none !important;',
      '  -webkit-backdrop-filter: none !important;',
      '  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.16) !important;',
      '  overflow-y: auto !important;',
      '  -webkit-overflow-scrolling: touch;',
      '  z-index: 9999 !important;',
      /* 官方浮层定位器可能带位移/缩放变换，会覆盖上面的 top / right，
         使菜单落在按钮附近而不是窗口右缘；这里清掉变换，位置完全由
         top / right 决定，剩余偏差再由 JS 自校正补偿。 */
      '  transform: none !important;',
      '  translate: none !important;',
      '  scale: none !important;',
      '  rotate: none !important;',
      '}',
      /* 统计胶囊的「Token 用量」详情：固定在状态带下方展开，避免顶到屏幕顶部。 */
      'html[data-dshm-mode="mobile"] [data-dshm-stats-dialog] {',
      '  position: fixed !important;',
      '  top: calc(var(--dshm-stats-top, 86px) + var(--dshm-stats-height, 26px) + 8px) !important;',
      '  left: 8px !important;',
      '  right: 8px !important;',
      '  bottom: auto !important;',
      '  width: auto !important;',
      '  max-width: none !important;',
      '  max-height: 55vh !important;',
      '  margin: 0 !important;',
      '  border-radius: 14px !important;',
      '  background: var(--dsw-alias-bg-base, #fff) !important;',
      '  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18) !important;',
      '  overflow-y: auto !important;',
      '  -webkit-overflow-scrolling: touch;',
      '  z-index: 27 !important;',
      '}',
      /* 状态带移出后，composer 根节点不再需要底部内边距，输入行与常驻条齐平。 */
      'html[data-dshm-mode="mobile"] [data-dshm-stats-host] {',
      '  padding-bottom: 0 !important;',
      '}',
      /* 官方 composer 弹层底部化（加号 / 权限 / 模型）：改 fixed 全宽面板，
         与常驻栏同一表面（同底色、去圆角与阴影），只在两者之间留一条分隔线。
         保留官方项与行为；不加暗色遮罩，点外部仍由官方浮层关闭。 */
      'html[data-dshm-mode="mobile"] [data-dshm-popover] {',
      '  position: fixed !important;',
      '  top: auto !important;',
      '  left: 0 !important;',
      '  right: 0 !important;',
      '  bottom: var(--dshm-safe-bottom) !important;',
      '  width: auto !important;',
      '  min-width: 0 !important;',
      '  max-width: none !important;',
      '  max-height: calc(var(--dshm-viewport-height, 100vh) * 0.55) !important;',
      '  margin: 0 !important;',
      '  transform: none !important;',
      '  border-radius: 0 !important;',
      '  border-top: 1px solid rgba(0, 0, 0, 0.14) !important;',
      '  background: var(--dsw-alias-bg-base, #fff) !important;',
      '  box-shadow: none !important;',
      '  overflow-y: auto !important;',
      '  -webkit-overflow-scrolling: touch;',
      '  z-index: 27 !important;',
      '}',
      /* 面板 ⇄ 键盘原位切换（揭开 / 覆盖模型）：标记挂在 <html> 上而非面板
         节点——官方 React 收起 / 打开时的重渲染会抹掉节点属性，面板会闪现
         （看起来像「收起又快速打开」），html 属性不受官方管辖。切换期间
         面板与其子元素免动画：键盘→面板方向面板要无弹入地提前就位（在键
         盘下方被盖住，滑落时被揭开）；面板→键盘方向要无收起地留在原地
         （键盘上滑把它盖住）。frame 的 padding 换算由 JS 内联控制。 */
      'html[data-dshm-mode="mobile"][data-dshm-swap] [data-dshm-popover],',
      'html[data-dshm-mode="mobile"][data-dshm-swap] [data-dshm-popover] > * {',
      '  transition: none !important;',
      '  animation: none !important;',
      '}',
      /* 空会话工作区 / 模式选择菜单：官方固定向下展开，会压住输入卡；
         改为贴着选择行顶边向上弹出，超出上方空间时内部滚动。 */
      'html[data-dshm-mode="mobile"] [data-dshm-menu-up] {',
      '  top: auto !important;',
      '  bottom: var(--dshm-menu-up-bottom, 8px) !important;',
      '  max-height: calc(var(--dshm-viewport-height, 100vh) - var(--dshm-menu-up-bottom, 8px) - 8px) !important;',
      '  overflow-y: auto !important;',
      '  -webkit-overflow-scrolling: touch;',
      '  transform: none !important;',
      '}',

      '@keyframes dshm-pop-in { from { transform: translateY(10px); opacity: 0.4 } to { transform: translateY(0); opacity: 1 } }',
      'html[data-dshm-mode="mobile"] [data-dshm-popover] > * {',
      '  animation: dshm-pop-in 0.18s ease-out;',
      '}',
      /* 面板容器自底滑入：与 frame 的 padding-bottom 0.18s 过渡同步，修掉
         「面板瞬现、输入行还在滑」的不同步（动画只作用于 translate 属性，
         不碰面板规则里的 transform: none !important，两者互不覆盖）。 */
      '@keyframes dshm-panel-in { from { translate: 0 105%; } to { translate: 0 0; } }',
      'html[data-dshm-mode="mobile"] [data-dshm-popover] {',
      '  animation: dshm-panel-in 0.18s ease-out;',
      '}',
      /* 弹层贴屏幕最底部：给 frame 预留等高的底部空间，让常驻条与输入行
         一起上移，面板正好落在常驻条下方（与 dsh-mobile-compose 一致）。 */
      'html[data-dshm-mode="mobile"] [data-dshm-frame] {',
      '  transition: padding-bottom 0.18s ease-out;',
      '}',
      'html[data-dshm-mode="mobile"][data-dshm-panel] [data-dshm-frame] {',
      '  box-sizing: border-box;',
      '  padding-bottom: calc(var(--dshm-panel-space, 0px) + var(--dshm-safe-bottom));',
      '}',
      /* 加号菜单宫格化：4 列、48px 圆角图标、12px 单行标签；隐藏分组标题与别名/描述。 */
      'html[data-dshm-mode="mobile"] [data-dshm-popover] [role="listbox"] {',
      '  display: grid !important;',
      '  grid-template-columns: repeat(4, minmax(0, 1fr)) !important;',
      '  gap: 10px 4px !important;',
      '  justify-items: center;',
      '  box-sizing: border-box;',
      '  max-height: calc(var(--dshm-viewport-height, 100vh) * 0.55 - 24px);',
      '  padding: 12px 8px !important;',
      '  overflow-y: auto;',
      '  -webkit-overflow-scrolling: touch;',
      '}',
      'html[data-dshm-mode="mobile"] [data-dshm-popover] [role="listbox"] > [role="presentation"] {',
      '  display: none !important;',
      '}',
      'html[data-dshm-mode="mobile"] [data-dshm-popover] [role="listbox"] > [role="option"] {',
      '  display: flex !important;',
      '  flex-direction: column !important;',
      '  align-items: center !important;',
      '  gap: 6px !important;',
      '  width: 100%;',
      '  min-height: 76px !important;',
      '  padding: 6px 0 !important;',
      '  border-radius: 12px !important;',
      '  background: transparent !important;',
      '  color: var(--dsw-alias-label-primary, inherit);',
      '  font-size: 12px !important;',
      '}',
      'html[data-dshm-mode="mobile"] [data-dshm-popover] [role="listbox"] > [role="option"] > span:nth-child(n+3) {',
      '  display: none !important;',
      '}',
      'html[data-dshm-mode="mobile"] [data-dshm-popover] [role="listbox"] > [role="option"] > span:first-child {',
      '  display: flex !important;',
      '  align-items: center;',
      '  justify-content: center;',
      '  width: 48px;',
      '  height: 48px;',
      '  border-radius: 13px;',
      '  background: var(--dshm-tint-soft, var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12)));',
      '  color: var(--dshm-tint, inherit);',
      '  transition: transform 0.12s ease;',
      '  flex: none;',
      '}',
      'html[data-dshm-mode="mobile"] [data-dshm-popover] [role="listbox"] > [role="option"]:active > span:first-child {',
      '  transform: scale(0.94);',
      '}',
      'html[data-dshm-mode="mobile"] [data-dshm-popover] [role="listbox"] > [role="option"] > span:first-child svg {',
      '  width: 24px !important;',
      '  height: 24px !important;',
      '}',
      'html[data-dshm-mode="mobile"] [data-dshm-popover] [role="listbox"] > [role="option"] > span:nth-child(2) {',
      '  max-width: 100%;',
      '  overflow: hidden;',
      '  font-size: 12px !important;',
      '  line-height: 1.2;',
      '  white-space: nowrap;',
      '  text-overflow: ellipsis;',
      '  text-align: center;',
      '}',
      /* ⊕ 展开时图标转 45° 变成 ×，与 dsh-mobile-compose 一致。 */
      'html[data-dshm-mode="mobile"] .dshm-bar-btn-spin svg {',
      '  transition: transform 0.18s ease;',
      '}',
      'html[data-dshm-mode="mobile"] .dshm-bar-btn-spin[aria-expanded="true"] svg {',
      '  transform: rotate(45deg);',
      '}',
      /* 右栏全屏：安全区内边距 + 顶部工具 44px 触控（官方为 28px）。 */
      'html[data-dshm-mode="mobile"] [data-dshm-frame][data-rightbar-fullscreen] [data-dshm-rightbar] {',
      '  box-sizing: border-box;',
      '  padding-top: var(--dshm-safe-top);',
      '  padding-bottom: var(--dshm-safe-bottom);',
      '}',
      'html[data-dshm-mode="mobile"] [data-dshm-chrome-btn] {',
      '  min-width: 44px !important;',
      '  min-height: 44px !important;',
      '}',
      'html[data-dshm-mode="mobile"] [data-rightbar-fullscreen] .dshm-mask {',
      '  display: none;',
      '}',
      /* ---- 加号面板：两行宫格 + 横向分页 -------------------------------
         按 4 列 × 2 行切页，逐项用内联 grid-column / grid-row 钉住位置（不用
         order：自动排布按排名填槽位，页内缺项会让下一页的内容漏进来）。
         左右 padding 归零、列间距改由 item 内边距提供，保证页宽严格等于
         clientWidth，吸附点才不会逐页偏移。 */
      'html[data-dshm-mode="mobile"] [data-dshm-popover] [role="listbox"][data-dshm-add-paged] {',
      '  display: grid !important;',
      '  grid-auto-flow: row !important;',
      '  grid-template-columns: none !important;',
      '  grid-template-rows: repeat(var(--dshm-add-rows, 2), 80px) !important;',
      '  grid-auto-columns: 25% !important;',
      '  column-gap: 0 !important;',
      '  row-gap: 10px !important;',
      '  align-content: start !important;',
      '  justify-items: center !important;',
      '  box-sizing: border-box;',
      '  width: 100%;',
      '  max-height: none !important;',
      '  height: auto !important;',
      '  padding: 12px 0 !important;',
      '  overflow-x: auto !important;',
      '  overflow-y: hidden !important;',
      '  scroll-snap-type: x mandatory;',
      '  overscroll-behavior-x: contain;',
      '  scrollbar-width: none;',
      '  -webkit-overflow-scrolling: touch;',
      '}',
      'html[data-dshm-mode="mobile"] [data-dshm-popover] [role="listbox"][data-dshm-add-paged]::-webkit-scrollbar {',
      '  display: none;',
      '}',
      'html[data-dshm-mode="mobile"] [data-dshm-popover] [role="listbox"][data-dshm-add-paged] > [role="option"] {',
      '  min-height: 80px !important;',
      '  padding: 6px 2px !important;',
      '}',
      'html[data-dshm-mode="mobile"] [data-dshm-popover] [role="listbox"][data-dshm-add-paged] > [role="option"][data-dshm-add-page-start] {',
      '  scroll-snap-align: start;',
      '}',
      /* 模型 / 权限选择器（surface 内带搜索框）：不再当宫格处理，改整行列表。
         上面那组宫格规则会把这些选择器的 listbox 也压成 4 列（分组被挤成
         147px 窄列还偏出屏幕左缘、权限卡片只剩 91px 宽描述全截断），这里用
         更高优先级的选择器整体翻回来。选项段落由 tagPickerOptions 打标记。 */
      'html[data-dshm-mode="mobile"] [data-dshm-popover][data-dshm-picker] [role="listbox"] {',
      '  display: block !important;',
      '  gap: 0 !important;',
      '  max-height: calc(var(--dshm-viewport-height, 100vh) * 0.55 - 62px) !important;',
      '  padding: 2px 6px calc(8px + var(--dshm-safe-bottom, 0px)) !important;',
      '  overflow-y: auto !important;',
      '  -webkit-overflow-scrolling: touch;',
      '}',
      /* 搜索框：圆角输入行，占面板顶部一整行。 */
      'html[data-dshm-mode="mobile"] [data-dshm-popover][data-dshm-picker] input {',
      '  display: block !important;',
      '  box-sizing: border-box !important;',
      '  width: calc(100% - 16px) !important;',
      '  height: 36px !important;',
      '  margin: 8px !important;',
      '  padding: 0 12px !important;',
      '  border: 1px solid rgba(127, 127, 127, 0.28) !important;',
      '  border-radius: 10px !important;',
      '  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.10)) !important;',
      '  color: var(--dsw-alias-label-primary, inherit) !important;',
      '  font-size: 14px !important;',
      '  appearance: none !important;',
      '  outline: none !important;',
      '}',
      /* 分组（如「DeepSeek 账号」）：整行块，标题是小号灰字。 */
      'html[data-dshm-mode="mobile"] [data-dshm-popover][data-dshm-picker] [role="group"] {',
      '  display: block !important;',
      '  width: 100% !important;',
      '  margin: 0 !important;',
      '  padding: 0 !important;',
      '  transform: none !important;',
      '}',
      'html[data-dshm-mode="mobile"] [data-dshm-popover][data-dshm-picker] [role="group"] > div:not([role="option"]) {',
      '  margin: 6px 8px 2px !important;',
      '  padding: 0 !important;',
      '  color: var(--dsw-alias-label-tertiary, rgba(0, 0, 0, 0.45)) !important;',
      '  font-size: 12px !important;',
      '  font-weight: 500 !important;',
      '  line-height: 16px !important;',
      '}',
      /* 选项行：一行一项，标题 + 可换行描述 + 靠右的选中勾。 */
      'html[data-dshm-mode="mobile"] [data-dshm-popover][data-dshm-picker] [role="option"] {',
      '  display: flex !important;',
      '  flex-direction: row !important;',
      '  flex-wrap: wrap !important;',
      '  align-items: center !important;',
      '  gap: 0 !important;',
      '  position: relative !important;',
      '  box-sizing: border-box !important;',
      '  width: 100% !important;',
      '  min-height: 48px !important;',
      '  margin: 0 !important;',
      '  padding: 8px 36px 8px 10px !important;',
      '  border-radius: 10px !important;',
      '  background: transparent !important;',
      '  color: var(--dsw-alias-label-primary, inherit) !important;',
      '  font-size: 14px !important;',
      '  text-align: left !important;',
      '  transform: none !important;',
      '}',
      'html[data-dshm-mode="mobile"] [data-dshm-popover][data-dshm-picker] [role="option"]:active {',
      '  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12)) !important;',
      '}',
      /* 选中态用主题蓝（发送按钮 / 「对话」页签那支蓝）：同色 10% 柔光底 + 蓝标题。 */
      'html[data-dshm-mode="mobile"] [data-dshm-popover][data-dshm-picker] [role="option"][aria-checked="true"],',
      'html[data-dshm-mode="mobile"] [data-dshm-popover][data-dshm-picker] [role="option"][aria-selected="true"] {',
      '  background: rgba(77, 107, 254, 0.10) !important;',
      '}',
      'html[data-dshm-mode="mobile"] [data-dshm-popover][data-dshm-picker] [role="option"][aria-checked="true"] > span:first-child,',
      'html[data-dshm-mode="mobile"] [data-dshm-popover][data-dshm-picker] [role="option"][aria-selected="true"] > span:first-child {',
      '  color: var(--dsw-alias-label-primary-bluish, #4d6bfe) !important;',
      '}',
      /* 「完全访问」高危权限：标题恒为红色警示（中英文都认）；选中底色与对勾
         跟着走红色系，不与主题蓝混排。放在蓝色选中态之后，同优先级靠后者胜。 */
      'html[data-dshm-mode="mobile"] [data-dshm-popover][data-dshm-picker] [role="option"][data-dshm-perm-danger][aria-checked="true"],',
      'html[data-dshm-mode="mobile"] [data-dshm-popover][data-dshm-picker] [role="option"][data-dshm-perm-danger][aria-selected="true"] {',
      '  background: rgba(229, 72, 77, 0.10) !important;',
      '}',
      'html[data-dshm-mode="mobile"] [data-dshm-popover][data-dshm-picker] [role="option"][data-dshm-perm-danger] > span:first-child {',
      '  color: #e5484d !important;',
      '}',
      'html[data-dshm-mode="mobile"] [data-dshm-popover][data-dshm-picker] [role="option"][data-dshm-perm-danger] > span[data-dshm-picker-check] {',
      '  color: #e5484d !important;',
      '}',
      /* 一级权限菜单（role=menu，保持官方形态）：整项文字与其内部段落标红。 */
      'html[data-dshm-mode="mobile"] [role="menuitem"][data-dshm-perm-danger],',
      'html[data-dshm-mode="mobile"] [role="menuitemradio"][data-dshm-perm-danger],',
      'html[data-dshm-mode="mobile"] [role="option"][data-dshm-perm-danger] {',
      '  color: #e5484d !important;',
      '}',
      'html[data-dshm-mode="mobile"] [role="menuitem"][data-dshm-perm-danger] > span,',
      'html[data-dshm-mode="mobile"] [role="menuitemradio"][data-dshm-perm-danger] > span {',
      '  color: #e5484d !important;',
      '}',
      /* 标题段（第一段）：单行省略。 */
      'html[data-dshm-mode="mobile"] [data-dshm-popover][data-dshm-picker] [role="option"] > span:first-child {',
      '  display: block !important;',
      '  flex: 1 1 auto !important;',
      '  width: auto !important;',
      '  min-width: 0 !important;',
      '  height: auto !important;',
      '  margin: 0 !important;',
      '  padding: 0 !important;',
      '  border-radius: 0 !important;',
      '  background: none !important;',
      '  color: inherit !important;',
      '  font-size: 14px !important;',
      '  font-weight: 500 !important;',
      '  line-height: 20px !important;',
      '  white-space: nowrap !important;',
      '  overflow: hidden !important;',
      '  text-overflow: ellipsis !important;',
      '  transition: none !important;',
      '}',
      /* 描述段（无 svg 的后续段）：整行、可换行、灰字。 */
      'html[data-dshm-mode="mobile"] [data-dshm-popover][data-dshm-picker] [role="option"] > span[data-dshm-picker-detail] {',
      '  display: block !important;',
      '  flex: 1 1 100% !important;',
      '  width: auto !important;',
      '  height: auto !important;',
      '  margin: 2px 0 0 !important;',
      '  padding: 0 !important;',
      '  background: none !important;',
      '  color: var(--dsw-alias-label-secondary, rgba(0, 0, 0, 0.55)) !important;',
      '  font-size: 12px !important;',
      '  font-weight: 400 !important;',
      '  line-height: 16px !important;',
      '  white-space: normal !important;',
      '  text-align: left !important;',
      '  overflow: hidden !important;',
      '}',
      /* 选中勾（含 svg 的后续段）：绝对定位靠右垂直居中。 */
      'html[data-dshm-mode="mobile"] [data-dshm-popover][data-dshm-picker] [role="option"] > span[data-dshm-picker-check] {',
      '  position: absolute !important;',
      '  right: 10px !important;',
      '  top: 50% !important;',
      '  transform: translateY(-50%) !important;',
      '  display: flex !important;',
      '  align-items: center !important;',
      '  justify-content: center !important;',
      '  width: 16px !important;',
      '  height: 16px !important;',
      '  margin: 0 !important;',
      '  padding: 0 !important;',
      '  background: none !important;',
      '  color: var(--dsw-alias-label-primary-bluish, #4C7DF0) !important;',
      '}',
      'html[data-dshm-mode="mobile"] [data-dshm-popover][data-dshm-picker] [role="option"] > span[data-dshm-picker-check] svg {',
      '  width: 16px !important;',
      '  height: 16px !important;',
      '}',
      /* 翻页圆点：浮在面板底部内边距里（面板下内边距 12px，圆点占 3~10px），
         不新增任何高度，也不遮挡图标；无文字，当前页拉长成短条。 */
      'html[data-dshm-mode="mobile"] .dshm-add-pager {',
      '  position: fixed;',
      '  left: 0;',
      '  right: 0;',
      '  bottom: calc(var(--dshm-safe-bottom, 0px) + 3px);',
      '  z-index: 28;',
      '  display: flex;',
      '  align-items: center;',
      '  justify-content: center;',
      '  gap: 5px;',
      '  height: 8px;',
      '  padding: 0;',
      '  margin: 0;',
      '  border: 0;',
      '  background: transparent;',
      '  pointer-events: none;',
      '}',
      'html[data-dshm-mode="mobile"] .dshm-add-pager-dot {',
      '  position: relative;',
      '  flex: none;',
      '  width: 5px;',
      '  height: 5px;',
      '  padding: 0;',
      '  margin: 0;',
      '  border: 0;',
      '  border-radius: 3px;',
      '  background: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.34));',
      '  pointer-events: auto;',
      '  transition: width 0.18s ease, background 0.18s ease;',
      '  -webkit-tap-highlight-color: transparent;',
      '}',
      'html[data-dshm-mode="mobile"] .dshm-add-pager-dot::after {',
      '  content: "";',
      '  position: absolute;',
      '  inset: -9px -5px;',
      '}',
      'html[data-dshm-mode="mobile"] .dshm-add-pager-dot.is-active {',
      '  width: 12px;',
      '  background: var(--dsw-alias-label-secondary, rgba(70, 70, 70, 0.6));',
      '}',

      /* ---- 设置弹窗：手机端全屏 ---------------------------------------- */
      'html[data-dshm-mode="mobile"][data-dshm-settings-open] [data-dshm-bottom],',
      'html[data-dshm-mode="mobile"][data-dshm-settings-open] .dshm-sheet,',
      'html[data-dshm-mode="mobile"][data-dshm-settings-open] .dshm-sheet-mask {',
      '  display: none !important;',
      '}',
      'html[data-dshm-mode="mobile"] [data-dshm-settings-panel] {',
      '  position: fixed !important;',
      '  inset: 0 !important;',
      '  width: auto !important;',
      '  max-width: none !important;',
      '  height: auto !important;',
      '  max-height: none !important;',
      '  margin: 0 !important;',
      '  padding: var(--dshm-safe-top) 0 var(--dshm-safe-bottom) 0 !important;',
      '  border: 0 !important;',
      '  border-radius: 0 !important;',
      '  box-shadow: none !important;',
      '  background: var(--dsw-alias-bg-base, #fff) !important;',
      '  display: flex !important;',
      '  flex-direction: column !important;',
      '  overflow: hidden !important;',
      '  z-index: 120 !important;',
      '  transform: none !important;',
      '  translate: none !important;',
      '}',
      /* 品牌行：垫在页签之上，避开宿主顶部悬浮条（收起后残留的把手）。 */
      'html[data-dshm-mode="mobile"] [data-dshm-settings-brand] {',
      '  flex: none !important;',
      '  display: flex !important;',
      '  align-items: center !important;',
      '  gap: 8px !important;',
      '  height: 56px !important;',
      '  min-height: 56px !important;',
      '  padding: 0 16px !important;',
      '  box-sizing: border-box !important;',
      '  background: var(--dsw-alias-bg-base, #fff);',
      '}',
      'html[data-dshm-mode="mobile"] [data-dshm-settings-brand] .dshm-settings-brand-logo {',
      '  display: inline-flex !important;',
      '  align-items: center !important;',
      '  justify-content: center !important;',
      '  width: 22px !important;',
      '  height: 22px !important;',
      '  flex: none !important;',
      '}',
      'html[data-dshm-mode="mobile"] [data-dshm-settings-brand] .dshm-settings-brand-logo svg {',
      '  display: block !important;',
      '  width: 22px !important;',
      '  height: auto !important;',
      '}',
      'html[data-dshm-mode="mobile"] [data-dshm-settings-brand] .dshm-settings-brand-name {',
      '  font-size: 15px !important;',
      '  font-weight: 600 !important;',
      '  line-height: 1 !important;',
      '  letter-spacing: 0.2px !important;',
      '  white-space: nowrap !important;',
      '}',
      /* 返回键：页签行最左，44×44 热区。 */
      'html[data-dshm-mode="mobile"] [data-dshm-settings-back] {',
      '  flex: none !important;',
      '  display: inline-flex !important;',
      '  align-items: center !important;',
      '  justify-content: center !important;',
      '  width: 44px !important;',
      '  height: 44px !important;',
      '  min-width: 44px !important;',
      '  min-height: 44px !important;',
      '  margin: 0 0 0 4px !important;',
      '  padding: 0 !important;',
      '  border: 0 !important;',
      '  border-radius: 12px !important;',
      '  background: transparent !important;',
      '  color: inherit !important;',
      '  cursor: pointer !important;',
      '  -webkit-tap-highlight-color: transparent;',
      '  transition: background-color 0.15s ease;',
      '}',
      'html[data-dshm-mode="mobile"] [data-dshm-settings-back] svg {',
      '  display: block !important;',
      '  width: 22px !important;',
      '  height: 22px !important;',
      '}',
      'html[data-dshm-mode="mobile"] [data-dshm-settings-back]:active {',
      '  background: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.16)) !important;',
      '}',
      /* 横滑换页后的淡入：只动透明度，不位移，避免影响内部绝对定位的浮层。 */
      'html[data-dshm-mode="mobile"] [data-dshm-settings-scroll][data-dshm-settings-swap] {',
      '  animation: dshm-settings-swap 0.18s ease-out;',
      '}',
      '@keyframes dshm-settings-swap {',
      '  from { opacity: 0.35; }',
      '  to { opacity: 1; }',
      '}',
      'html[data-dshm-mode="mobile"] [data-dshm-settings-nav] {',
      '  flex: none !important;',
      '  display: flex !important;',
      /* ⚠️ v1.4.50：nav 必须是**横向**容器。
         引擎的 nav 是纵向 column，里面有 navTitle（我们隐藏了）、返回键、
         以及 navList（页签）。纵向排列时 navList 作为第三个子元素被挤成
         0 高 —— 页签一排看不见，用户以为「其他设置项没了」。 */
      '  flex-direction: row !important;',
      '  align-items: center !important;',
      '  width: 100% !important;',
      '  height: 56px !important;',
      '  padding: 0 !important;',
      '  box-sizing: border-box !important;',
      '  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.08)) !important;',
      '  background: var(--dsw-alias-bg-base, #fff);',
      '}',
      'html[data-dshm-mode="mobile"] [data-dshm-settings-title] {',
      '  display: none !important;',
      '}',
      'html[data-dshm-mode="mobile"] [data-dshm-settings-tabs] {',
      '  flex: 1 1 auto !important;',
      '  min-width: 0 !important;',
      '  width: 100% !important;',
      '  height: 56px !important;',
      '  display: flex !important;',
      /* ⚠️ v1.4.50：必须显式 row + 禁止换行。
         官方的 navList 是**纵向列表**（flex-direction: column），插件只改了
         高度和 overflow-x，没改方向 —— 四个页签竖排后总高 160px 被 56px 的
         容器裁掉，用户只能看到第一个（active）页签，其余设置项进不去。 */
      '  flex-direction: row !important;',
      '  flex-wrap: nowrap !important;',
      '  align-items: center !important;',
      '  gap: 8px !important;',
      '  padding: 0 12px !important;',
      '  box-sizing: border-box !important;',
      '  overflow-x: auto !important;',
      '  overflow-y: hidden !important;',
      '  scrollbar-width: none;',
      '  scroll-snap-type: x proximity;',
      '  -webkit-overflow-scrolling: touch;',
      '}',
      'html[data-dshm-mode="mobile"] [data-dshm-settings-tabs]::-webkit-scrollbar {',
      '  display: none;',
      '}',
      'html[data-dshm-mode="mobile"] [data-dshm-settings-tabs] > * {',
      '  flex: none !important;',
      '}',
      'html[data-dshm-mode="mobile"] [data-dshm-settings-tabs] button,',
      'html[data-dshm-mode="mobile"] [data-dshm-settings-tabs] a {',
      '  position: relative !important;',
      '  flex: none !important;',
      '  height: 40px !important;',
      '  min-height: 40px !important;',
      '  padding: 0 14px !important;',
      '  border-radius: 999px !important;',
      '  font-size: 14px !important;',
      '  line-height: 1 !important;',
      '  white-space: nowrap !important;',
      '  scroll-snap-align: center;',
      '}',
      'html[data-dshm-mode="mobile"] [data-dshm-settings-tabs] button::after,',
      'html[data-dshm-mode="mobile"] [data-dshm-settings-tabs] a::after {',
      '  content: "";',
      '  position: absolute;',
      '  inset: -6px -2px;',
      '}',
      /* 页签条与 nav 是同一个节点时（官方扁平结构），返回键也会落在上面：
         把 chip 的圆角 / 内边距 / 热区伪元素改回按钮自己的尺寸。 */
      'html[data-dshm-mode="mobile"] [data-dshm-settings-tabs] [data-dshm-settings-back] {',
      '  width: 44px !important;',
      '  height: 44px !important;',
      '  padding: 0 !important;',
      '  margin: 0 !important;',
      '  border-radius: 12px !important;',
      '}',
      'html[data-dshm-mode="mobile"] [data-dshm-settings-tabs] [data-dshm-settings-back]::after {',
      '  content: none !important;',
      '}',
      'html[data-dshm-mode="mobile"] [data-dshm-settings-content] {',
      '  flex: 1 1 auto !important;',
      '  min-height: 0 !important;',
      '  display: flex !important;',
      '  flex-direction: column !important;',
      '  width: 100% !important;',
      '  padding: 0 !important;',
      '  overflow: hidden !important;',
      '}',
      'html[data-dshm-mode="mobile"] [data-dshm-settings-head] {',
      '  flex: none !important;',
      '  height: 48px !important;',
      '  min-height: 48px !important;',
      '  display: flex !important;',
      '  align-items: center !important;',
      '  justify-content: flex-end !important;',
      '  gap: 4px !important;',
      '  padding: 0 4px !important;',
      '  box-sizing: border-box !important;',
      '  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.08)) !important;',
      '}',
      'html[data-dshm-mode="mobile"] [data-dshm-settings-tool] {',
      '  height: 32px !important;',
      '  min-height: 32px !important;',
      '  padding: 0 12px !important;',
      '  border-radius: 16px !important;',
      '  font-size: 13px !important;',
      '}',
      'html[data-dshm-mode="mobile"] [data-dshm-settings-close] {',
      '  width: 44px !important;',
      '  height: 44px !important;',
      '  min-width: 44px !important;',
      '  min-height: 44px !important;',
      '  display: inline-flex !important;',
      '  align-items: center !important;',
      '  justify-content: center !important;',
      '  border-radius: 12px !important;',
      '}',
      'html[data-dshm-mode="mobile"] [data-dshm-settings-scroll] {',
      '  flex: 1 1 auto !important;',
      '  min-height: 0 !important;',
      '  overflow-y: auto !important;',
      '  overflow-x: hidden !important;',
      '  padding: 4px 16px calc(24px + var(--dshm-safe-bottom)) !important;',
      '  box-sizing: border-box !important;',
      '  overscroll-behavior: contain;',
      '  scrollbar-width: none;',
      '  -webkit-overflow-scrolling: touch;',
      '}',
      'html[data-dshm-mode="mobile"] [data-dshm-settings-scroll]::-webkit-scrollbar {',
      '  display: none;',
      '}',
      'html[data-dshm-mode="mobile"] [data-dshm-settings-scroll] > * {',
      '  max-width: 100% !important;',
      '  box-sizing: border-box;',
      '}',
      /* 触控：开关与下拉补足热区（视觉尺寸不变）。 */
      'html[data-dshm-mode="mobile"] [data-dshm-settings-scroll] [role="switch"] {',
      '  position: relative !important;',
      '  min-width: 44px !important;',
      '  min-height: 28px !important;',
      '}',
      'html[data-dshm-mode="mobile"] [data-dshm-settings-scroll] [role="switch"]::after {',
      '  content: "";',
      '  position: absolute;',
      '  inset: -10px -6px;',
      '}',
      'html[data-dshm-mode="mobile"] [data-dshm-settings-scroll] select,',
      'html[data-dshm-mode="mobile"] [data-dshm-settings-scroll] button[aria-haspopup] {',
      '  min-height: 40px !important;',
      '}',
      /* 外观主题 / 模板卡片：三列一行，省下两行高度。 */
      'html[data-dshm-mode="mobile"] [data-dshm-settings-cards] {',
      '  display: grid !important;',
      '  grid-template-columns: repeat(3, minmax(0, 1fr)) !important;',
      '  gap: 8px !important;',
      '  width: 100% !important;',
      '}',
      'html[data-dshm-mode="mobile"] [data-dshm-settings-cards] > * {',
      '  width: auto !important;',
      '  min-width: 0 !important;',
      '  min-height: 84px !important;',
      '  flex: none !important;',
      '}',
      /* 窄屏（≤430px）三列会把「跟随系统」挤成两行，放成两列更好点。 */
      '@media (max-width: 430px) {',
      '  html[data-dshm-mode="mobile"] [data-dshm-settings-cards] {',
      '    grid-template-columns: repeat(2, minmax(0, 1fr)) !important;',
      '  }',
      '}',

      /* 动效降级：系统开「减少动态效果」时，抽屉滑入、遮罩淡入、弹层 pop-in、
         宫格图标按压、圆点伸缩、⊕ 旋转全部去掉过渡（终态保留，只去掉动画），
         照顾前庭敏感用户。 */
      '@media (prefers-reduced-motion: reduce) {',
      '  html[data-dshm-mode="mobile"] [data-dshm-sidebar],',
      '  html[data-dshm-mode="mobile"] .dshm-mask,',
      '  html[data-dshm-mode="mobile"] .dshm-sheet-mask,',
      '  html[data-dshm-mode="mobile"] .dshm-sheet,',
      '  html[data-dshm-mode="mobile"] [data-dshm-frame],',
      '  html[data-dshm-mode="mobile"] [data-dshm-popover] > *,',
      '  html[data-dshm-mode="mobile"] [data-dshm-popover] [role="listbox"] > [role="option"] > span:first-child,',
      '  html[data-dshm-mode="mobile"] .dshm-bar-btn-spin svg,',
      '  html[data-dshm-mode="mobile"] .dshm-add-pager-dot {',
      '    transition: none !important;',
      '    animation: none !important;',
      '  }',
      /* 换页淡入同样降级：内容直接出现，只去掉动画。 */
      '  html[data-dshm-mode="mobile"] [data-dshm-settings-scroll][data-dshm-settings-swap] {',
      '    animation: none !important;',
      '  }',
      /* 返回键的按压底色也保留（它不是动效，是触控反馈），这里只去掉过渡。 */
      '  html[data-dshm-mode="mobile"] [data-dshm-settings-back] {',
      '    transition: none !important;',
      '  }',
      '}',
    ].join('\n');

    function injectStyle(doc) {
      let tag = doc.getElementById(STYLE_ID);
      if (!tag) {
        tag = doc.createElement('style');
        tag.id = STYLE_ID;
        tag.setAttribute('data-plugin-css', 'dsh-mobile-layout');
        doc.head.appendChild(tag);
      }
      tag.textContent = CSS_TEXT;
      return tag;
    }

    // ---- React 组件 ----
    const h = react.createElement;

    /** 20px 线性图标（底部条统一风格，不依赖官方图标组件）。 */
    function strokeIcon(...paths) {
      return h(
        'svg',
        {
          width: 20,
          height: 20,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        paths.map((d, index) => h('path', { key: index, d })),
      );
    }

    /** 图标工厂：延迟到渲染期调用，避免测试环境（无 createElement）在加载期失败。 */
    const ICONS = {
      newSession: () => strokeIcon('M12 5v14', 'M5 12h14'),
      sessions: () => strokeIcon('M20 11.5a7.5 7.5 0 0 1-10.9 6.6L5 19.5l1.4-3.6A7.5 7.5 0 1 1 20 11.5Z'),
      files: () => strokeIcon('M4 7.5A1.5 1.5 0 0 1 5.5 6h3.8l2 2h7.2A1.5 1.5 0 0 1 20 9.5v8A1.5 1.5 0 0 1 18.5 19h-13A1.5 1.5 0 0 1 4 17.5Z'),
      images: () => strokeIcon('M4 5.5h16v13H4Z', 'M4 15l4.6-4.6 3.4 3.4 2.4-2.4L20 17', 'M15.2 9.2h.01'),
      plugins: () => strokeIcon('M9 3v4', 'M15 3v4', 'M7 7h10v3.5a5 5 0 0 1-10 0Z', 'M12 15v6'),
      more: () => strokeIcon('M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18', 'M12 8v8', 'M8 12h8'),
    };

    /** 底部条按键：图标在上、11px 标签在下，触控区不小于 44px。 */
    function BarButton({ icon, label, expanded, onClick, spin }) {
      return h(
        'button',
        {
          type: 'button',
          className: 'dshm-bar-btn' + (spin ? ' dshm-bar-btn-spin' : ''),
          'aria-label': label,
          'aria-expanded': expanded === undefined ? undefined : expanded ? 'true' : 'false',
          onClick,
        },
        icon,
        h('span', null, label),
      );
    }

    /**
     * 底部常驻条（官方 shell.bottom 行）。
     *
     * 6 键：新建 / 会话 / 文件 / 图片 / 插件 / ⊕。文件与图片使用插件自建
     * input，选中后回流到官方隐藏输入，上传与校验仍由官方 composer 负责。
     * 官方全局面板或右栏全屏时不渲染，把整行交还官方。
     */
    function BottomBar() {
      const layoutState = useLayoutState();
      const fileRef = react.useRef(null);
      const imageRef = react.useRef(null);
      const mobile = layoutState.mode === MODE_MOBILE;
      const sheet = layoutState.sheet;
      const visible = mobile && !layoutState.panelActive && !layoutState.rightbarFullscreen;

      const pick = (ref) => {
        const input = ref.current;
        if (input) input.click();
      };

      const onPick = (event) => {
        const input = event.currentTarget;
        const files = input.files ? Array.from(input.files) : [];
        input.value = '';
        if (files.length === 0) return;
        closeSheet();
        injectOfficialFiles(files);
      };

      if (!visible) return null;

      return h(
        'div',
        { className: 'dshm-bottom-bar' },
        h(BarButton, { icon: ICONS.newSession(), label: t('newSession'), onClick: startNewSession }),
        h(BarButton, {
          icon: ICONS.sessions(),
          label: t('sessions'),
          expanded: sheet === 'sessions',
          onClick: () => (sheet === 'sessions' ? closeSheet() : openSheet('sessions')),
        }),
        h(BarButton, { icon: ICONS.files(), label: t('files'), onClick: () => pick(fileRef) }),
        h(BarButton, { icon: ICONS.images(), label: t('images'), onClick: () => pick(imageRef) }),
        h(BarButton, {
          icon: ICONS.plugins(),
          label: t('plugins'),
          expanded: sheet === 'plugins',
          onClick: () => (sheet === 'plugins' ? closeSheet() : openSheet('plugins')),
        }),
        h(BarButton, {
          icon: ICONS.more(),
          label: t('more'),
          expanded: layoutState.popoverOpen,
          spin: true,
          onClick: () => {
            // 真实 pointerdown 已让官方浮层关闭时，本次 click 不再重开。
            if (Date.now() - popoverClosedAt < 800) {
              closeOfficialAddMenu();
              return;
            }
            openOfficialAddMenu();
          },
        }),
        h('input', {
          type: 'file',
          multiple: true,
          hidden: true,
          ref: fileRef,
          'data-dshm-input': '',
          onChange: onPick,
        }),
        h('input', {
          type: 'file',
          accept: 'image/*',
          multiple: true,
          hidden: true,
          ref: imageRef,
          'data-dshm-input': '',
          onChange: onPick,
        }),
      );
    }

    /**
     * 底部表：会话列表 / 插件快捷入口。
     *
     * 由 overlay 层渲染，位置止于底部条上沿；遮罩避开底部条，方便随时切换。
     * 会话行数据来自官方 sessions.list，当前会话按 retainedBy.mainView 标记。
     */
    function Sheet() {
      const layoutState = useLayoutState();
      const sheet = layoutState.mode === MODE_MOBILE ? layoutState.sheet : null;
      const sessionState = useSessionRows(sheet === 'sessions');
      const workspaceNames = useWorkspaceNames(sheet === 'sessions');
      const rootRef = react.useRef(null);

      /**
       * 模态焦点管理：打开时把焦点送进面板（关闭按钮），关闭时还给打开前的
       * 元素（通常是底部条按钮）。否则键盘 / 读屏用户会停在背后的底部条上，
       * Tab 顺序走进遮罩下面的内容。
       */
      react.useEffect(() => {
        if (!sheet) return undefined;
        const node = rootRef.current;
        if (!node) return undefined;
        const doc = document;
        const prev = doc.activeElement;
        const target = node.querySelector('.dshm-sheet-close') || node;
        if (target && typeof target.focus === 'function') {
          try {
            target.focus({ preventScroll: true });
          } catch (error) {
            /* 焦点转移失败不影响面板本身 */
          }
        }
        return () => {
          if (prev && prev !== doc.body && prev.isConnected && typeof prev.focus === 'function') {
            try {
              prev.focus({ preventScroll: true });
            } catch (error) {
              /* ignore */
            }
          }
        };
      }, [sheet]);

      if (!sheet) return null;

      const title = sheet === 'sessions' ? t('sessions') : t('plugins');

      /* 拖拽关闭（v1.4.57）：只在顶部把手上识别，不干扰列表滚动。
         下滑超过 SHEET_DRAG_CLOSE_PX 松手关闭，否则弹回原位。 */
      const dragRef = react.useRef({ active: false, startY: 0, dy: 0 });
      const onGrabDown = (event) => {
        const drag = dragRef.current;
        drag.active = true;
        drag.startY = event.clientY;
        drag.dy = 0;
        const node = rootRef.current;
        if (node) {
          node.style.animation = 'none';
          node.style.transition = 'none';
        }
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch (error) {
          /* 捕获失败时仍能按 Move 计算 */
        }
      };
      const onGrabMove = (event) => {
        const drag = dragRef.current;
        if (!drag.active) return;
        drag.dy = Math.max(0, event.clientY - drag.startY);
        const node = rootRef.current;
        if (node) node.style.transform = `translateY(${drag.dy}px)`;
      };
      const onGrabEnd = () => {
        const drag = dragRef.current;
        if (!drag.active) return;
        drag.active = false;
        const node = rootRef.current;
        if (!node) return;
        if (shouldCloseSheetByDrag(drag.dy)) {
          closeSheet();
          return;
        }
        node.style.transition = 'transform 200ms cubic-bezier(0.32, 0.72, 0, 1)';
        node.style.transform = '';
        window.setTimeout(() => {
          if (!node.isConnected) return;
          node.style.transition = '';
        }, 220);
      };

      // 工作区呈现：多工作区走「分组标题 + 会话缩进」，单工作区只在标题旁标一次。
      const wsGroups = groupSessionsByWorkspace(sessionState.rows, workspaceNames);
      const labelWorkspaceOnRow = wsGroups.grouped;
      const onlyWorkspace = wsGroups.single;
      const now = Date.now();

      const head = h(
        'div',
        { className: 'dshm-sheet-head' },
        h(
          'span',
          { className: 'dshm-sheet-title' },
          title,
          onlyWorkspace ? h('span', { className: 'dshm-sheet-sub' }, onlyWorkspace) : null,
        ),
        h(
          'button',
          { type: 'button', className: 'dshm-sheet-close', 'aria-label': t('close'), onClick: closeSheet },
          '\u00d7',
        ),
      );

      const renderRow = (row) => {
        const isCurrent = row.id === sessionState.currentId;
        const relative = formatRelativeTime(row.updatedAt, now, runtime.lang);
        return h(
          'button',
          {
            type: 'button',
            key: row.id,
            className: 'dshm-sheet-row' + (isCurrent ? ' is-current' : ''),
            onClick: () => openSessionById(row.id),
          },
          h(
            'span',
            { className: 'dshm-sheet-row-main' },
            h('span', { className: 'dshm-sheet-row-title' }, row.displayTitle || row.title || row.id),
          ),
          isCurrent ? h('span', { className: 'dshm-sheet-badge' }, t('current')) : null,
          relative ? h('span', { className: 'dshm-sheet-row-time' }, relative) : null,
        );
      };

      let body = null;
      if (sheet === 'sessions') {
        body = sessionState.rows.length === 0
          ? h('p', { className: 'dshm-sheet-empty' }, t('noSessions'))
          : h(
              'div',
              { className: 'dshm-sheet-list' + (labelWorkspaceOnRow ? ' is-grouped' : '') },
              labelWorkspaceOnRow
                ? wsGroups.groups.map((group) =>
                    h(
                      'div',
                      { className: 'dshm-sheet-group', key: '\u0000' + group.name },
                      h(
                        'div',
                        { className: 'dshm-sheet-group-head' },
                        h(
                          'span',
                          { className: 'dshm-sheet-group-name' },
                          group.name || t('otherWorkspace'),
                        ),
                        h('span', { className: 'dshm-sheet-group-count' }, String(group.rows.length)),
                      ),
                      group.rows.map(renderRow),
                    ),
                  )
                : sessionState.rows.map(renderRow),
            );
      } else {
        body = h(
          react.Fragment,
          null,
          h('p', { className: 'dshm-sheet-hint' }, t('pluginsHint')),
          h('button', { type: 'button', className: 'dshm-sheet-action', onClick: openPluginPanel }, t('managePlugins')),
        );
      }

      return h(
        'div',
        {
          className: 'dshm-sheet',
          role: 'dialog',
          // 底部表盖住内容且拦截交互，是模态对话框；补 aria-modal 让读屏
          // 只在面板内导航。tabIndex=-1 供「无关闭按钮时」兜底聚焦。
          'aria-modal': 'true',
          'aria-label': title,
          tabIndex: -1,
          ref: rootRef,
        },
        h('div', {
          className: 'dshm-sheet-grabber',
          'aria-hidden': 'true',
          onPointerDown: onGrabDown,
          onPointerMove: onGrabMove,
          onPointerUp: onGrabEnd,
          onPointerCancel: onGrabEnd,
        }),
        head,
        body,
      );
    }

    /**
     * 加号面板的翻页指示条（QQ 式：只有圆点，没有文字）。
     *
     * 贴在官方弹层上沿（bottom = 安全区 + 面板实测高度），只做「横滑同步高亮 +
     * 点圆点跳页」，不参与官方弹层结构；只有 1 页时整条不渲染。
     */
    function AddPager() {
      const layoutState = useLayoutState();
      const count = layoutState.addPageCount || 0;
      const [index, setIndex] = react.useState(0);

      react.useEffect(() => {
        if (count < 2) return undefined;
        const doc = document;
        const selector = '[data-dshm-popover] [role="listbox"][' + ATTR_ADD_PAGED + ']';
        let raf = 0;
        const read = () => {
          raf = 0;
          const list = doc.querySelector(selector);
          if (!list || !list.clientWidth) return;
          const next = Math.max(0, Math.min(count - 1, Math.round(list.scrollLeft / list.clientWidth)));
          setIndex((prev) => (prev === next ? prev : next));
        };
        const onScroll = (event) => {
          const target = event.target;
          if (!target || typeof target.matches !== 'function' || !target.matches(selector)) return;
          if (raf) return;
          raf = window.requestAnimationFrame(read);
        };
        doc.addEventListener('scroll', onScroll, true);
        read();
        return () => {
          doc.removeEventListener('scroll', onScroll, true);
          if (raf) window.cancelAnimationFrame(raf);
        };
      }, [count]);

      if (count < 2) return null;

      const go = (next) => {
        const list = document.querySelector('[data-dshm-popover] [role="listbox"][' + ATTR_ADD_PAGED + ']');
        setIndex(next);
        if (!list || !list.clientWidth) return;
        try {
          list.scrollTo({ left: next * list.clientWidth, behavior: 'smooth' });
        } catch (error) {
          list.scrollLeft = next * list.clientWidth;
        }
      };

      const dots = [];
      for (let i = 0; i < count; i += 1) {
        dots.push(
          h('button', {
            key: String(i),
            type: 'button',
            className: 'dshm-add-pager-dot' + (i === index ? ' is-active' : ''),
            'aria-label': pageLabel(i, i === index),
            'aria-current': i === index ? 'true' : undefined,
            onClick: () => go(i),
          }),
        );
      }
      return h('div', { className: 'dshm-add-pager' }, dots);
    }

    /**
     * 遮罩 / 全局面板兜底入口。
     *
     * 注册在 shell.overlay（list，root）；该层 pointer-events: none，子元素
     * 自动恢复指针事件，所以关闭态不阻塞任何交互。
     *
     * 左缘手势已从这里搬走（0.1.15）：槽位组件的监听够不着其它插件提供的
     * 面板页（页面自己消费触摸事件或整页横滚都会截断冒泡），现在由
     * bindDrawerGesture 在 window 捕获阶段常驻监听，与本组件挂载状态解耦。
     */
    function OverlayLayer() {
      const layoutState = useLayoutState();
      const mobile = layoutState.mode === MODE_MOBILE;
      const open = mobile && layoutState.drawerOpen;
      console.info('[dshm-overlay] RENDER open=' + open + ' drawerOpen=' + layoutState.drawerOpen); // TEMP-DEBUG

      react.useEffect(() => {
        if (!mobile) return undefined;
        const doc = document;
        // ⊕ 面板开着点输入框：捕获阶段截住，先主动收面板，键盘等面板收完再拉。
        const onAddPanelPointerDown = (event) => {
          closeAddMenuForComposerTap(event);
        };
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return;
          // 设置页在最上层，Esc 先关它（与系统返回、左上返回键同一个出口）。
          if (settingsPanelOpen()) {
            closeSettingsByBack();
            return;
          }
          if (getState().sheet !== null) {
            closeSheet();
            return;
          }
          // 官方 ⊕ 浮层同样先收它，避免 Esc 直落到页面层。
          if (getState().popoverOpen || doc.querySelector('[' + ATTR_POPOVER + ']')) {
            closeOfficialAddMenu();
            return;
          }
          if (isDrawerOpen()) requestDrawer(false);
          const layout = runtime.layout;
          if (getState().rightbarFullscreen && layout && typeof layout.closeRightbar === 'function') {
            try {
              layout.closeRightbar();
            } catch (error) {
              console.error('[dsh-mobile-layout] 关闭右栏失败：', error);
            }
          }
        };

        doc.addEventListener('pointerdown', onAddPanelPointerDown, { capture: true, passive: true });
        doc.addEventListener('keydown', onKeyDown);
        return () => {
          doc.removeEventListener('pointerdown', onAddPanelPointerDown, { capture: true });
          doc.removeEventListener('keydown', onKeyDown);
        };
      }, [mobile]);

      /**
       * 抽屉的焦点进出。
       *
       * 抽屉本体是官方侧栏，它的 role / aria-modal 由 syncDrawerA11y 在展开
       * 期间临时补上（收起即还原），这里只负责焦点：否则键盘 / 读屏用户打开
       * 抽屉后仍停在遮罩或底部条上，Tab 顺序走的是背后的内容。关闭时把焦点
       * 还给打开前的元素。
       */
      react.useEffect(() => {
        if (!mobile || !open) return undefined;
        const doc = document;
        const sidebar = doc.querySelector('[' + ATTR_SIDEBAR + ']');
        const prev = doc.activeElement;
        if (sidebar && prev && sidebar.contains(prev)) return undefined;
        const candidates = sidebar
          ? Array.from(sidebar.querySelectorAll('a[href], button:not([disabled]), [role="treeitem"], [tabindex]:not([tabindex="-1"])'))
          : [];
        // 输入框不抢焦点：手机上一聚焦就弹软键盘，抽屉刚展开就被顶起半屏。
        const target = candidates.find((node) => {
          const tag = node.tagName;
          return tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT' && !node.isContentEditable;
        });
        if (target && typeof target.focus === 'function') {
          try {
            target.focus({ preventScroll: true });
          } catch (error) {
            /* 焦点转移失败不影响抽屉本身 */
          }
        }
        return () => {
          const back = prev;
          if (back && back.isConnected && typeof back.focus === 'function') {
            try {
              back.focus({ preventScroll: true });
            } catch (error) {
              /* ignore */
            }
          }
        };
      }, [mobile, open]);

      if (!mobile) return null;

      const sheet = layoutState.sheet;

      return h(
        react.Fragment,
        null,
        open
          ? h('button', {
              type: 'button',
              className: 'dshm-mask',
              'aria-label': t('close'),
              tabIndex: -1,
              onClick: () => requestDrawer(false),
            })
          : null,
        sheet
          ? h('button', {
              type: 'button',
              className: 'dshm-sheet-mask',
              'aria-label': t('close'),
              tabIndex: -1,
              onClick: closeSheet,
            })
          : null,
        sheet ? h(Sheet) : null,
        h(AddPager),
      );
    }

    // ---- 生命周期 ----
    function apply(ctx) {
      runtime.ctx = ctx;
      const win = window;
      const doc = win.document;
      // 宿主识别一次并缓存（页面生命周期内不变）。桌面端在 evaluateNow 里
      // 直接判 default，不做视口分类，移动布局全程不激活。
      const hostKind = detectHost(win);
      if (hostKind === HOST_DESKTOP) {
        console.info('[dsh-mobile-layout] 检测到桌面端（Electron），移动布局保持关闭');
      }
      let disposed = false;
      let debounceTimer = 0;
      let warnCount = 0;
      let observer = null;
      let attrObserver = null;
      let anchorRaf = 0;
      let frameEl = null;
      let styleEl = null;
      let anchorTimer = 0;
      let mobileBase = null;
      /**
       * 进入手机布局前侧栏是否处于展开态。
       *
       * 手机竖屏下官方侧栏本就折叠，只有「桌面 / 平板窄窗」切进来时才由插件
       * 收起；记下来，退出手机布局或卸载时还原，避免官方侧栏永久停在折叠态。
       */
      let sidebarExpandedBeforeMobile = false;
      /** 几何同步的合并计时器（见 scheduleLayoutSync）。 */
      let layoutTimer = 0;
      /** 上一次看到的输入卡节点；换节点（会话切换 / 空态切换）时几何必须立刻重算。 */
      let lastComposerCard = null;
      const teardowns = [];

      const logWarn = (message, error) => {
        if (warnCount >= 5) return;
        warnCount += 1;
        if (error) console.warn('[dsh-mobile-layout]', message, error);
        else console.warn('[dsh-mobile-layout]', message);
      };

      styleEl = injectStyle(doc);

      /** 键盘收起时的满高视口与最近一次测得的键盘高度（CSS px）。 */
      let viewportFullH = 0;
      let imeHeightPx = 0;
      /** 历史会话持久化的键盘高度；本会话实测后即被实测值覆盖。 */
      let imeStored = 0;
      try {
        imeStored = parseFloat(win.localStorage.getItem('dshm-ime-height')) || 0;
      } catch (error) {
        imeStored = 0;
      }
      /** 原生桥读取：Android 壳注入的键盘高度（CSS px 直给或物理 px 换算）。 */
      const nativeImeHeight = () => {
        try {
          const bridge = win.DshAndroidKeyboard;
          if (bridge && typeof bridge.heightPx === 'function') {
            const px = Number(bridge.heightPx());
            if (px > 0) return Math.round(px / (win.devicePixelRatio || 1));
          }
          const direct = Number(win.__DSH_IME_HEIGHT);
          if (direct > 0) return Math.round(direct);
        } catch (error) {
          /* 桥不存在：走 visualViewport 实测 */
        }
        return 0;
      };
      const syncViewportVar = () => {
        const vv = win.visualViewport;
        const height = Math.round((vv && Number(vv.height)) || win.innerHeight || 0);
        if (height > 0) {
          doc.documentElement.style.setProperty('--dshm-viewport-height', height + 'px');
          // 键盘高度测量：adjustResize 下视口收缩量即键盘高。只认 ≥120px 的
          // 显著收缩（pinch-zoom / 抖动不误判），历史最大值视为键盘收起的满高。
          if (height > viewportFullH) viewportFullH = height;
          const ime = viewportFullH - height;
          if (ime >= 120) {
            imeHeightPx = ime;
            try {
              win.localStorage.setItem('dshm-ime-height', String(ime));
            } catch (error) {
              /* 存不了就用会话内值 */
            }
          }
          const effective = resolveImeHeight(nativeImeHeight(), imeHeightPx || imeStored, viewportFullH);
          if (effective > 0) {
            doc.documentElement.style.setProperty('--dshm-ime-height', effective + 'px');
          } else {
            doc.documentElement.style.removeProperty('--dshm-ime-height');
          }
          // 视口跳变 = 面板 ⇄ 键盘切换的「落地时刻」：换算 padding 保持输入行
          // 屏幕位置，再滑向目标态（见 startImeSwap / settleImeSwap）。
          settleImeSwap();
        }
      };

      /**
       * 抽屉的无障碍暴露（仅手机形态，且仅在展开时）。
       *
       * 抽屉是模态面板：展开时给官方侧栏补 role=dialog + aria-label +
       * aria-modal=true。收起时必须连同 role 一起撤掉——侧栏收起后只是
       * `translateX(-104%)` 的离屏元素，仍在无障碍树里；留着 role=dialog
       * 会让读屏把一段离屏内容念成对话框（aria-modal 同理，留着 true 还会
       * 让读屏以为整页被遮挡、只遍历侧栏）。
       *
       * 官方的原始属性按节点记录：React 若重挂了侧栏节点，先把旧节点还原，
       * 再对新节点重新取值，避免把旧节点的 role 写到新节点上。退出手机形态
       * 或卸载时一律还原，不把我们的语义留在官方节点上。
       */
      const drawerA11y = { node: null, role: null, modal: null, label: null };
      const setAttrIfChanged = (node, name, value) => {
        if (value === null || value === undefined) {
          if (node.hasAttribute(name)) node.removeAttribute(name);
          return;
        }
        if (node.getAttribute(name) !== value) node.setAttribute(name, value);
      };
      const restoreDrawerAttrs = (sidebar) => {
        setAttrIfChanged(sidebar, 'role', drawerA11y.role);
        setAttrIfChanged(sidebar, 'aria-modal', drawerA11y.modal);
        setAttrIfChanged(sidebar, 'aria-label', drawerA11y.label);
        drawerA11y.node = null;
      };
      const syncDrawerA11y = (mobile) => {
        const sidebar = doc.querySelector('[' + ATTR_SIDEBAR + ']');
        if (!sidebar) return;
        // 节点被官方换掉：旧节点还挂在树上就还原它，否则直接丢弃记录。
        if (drawerA11y.node && drawerA11y.node !== sidebar) {
          if (drawerA11y.node.isConnected) restoreDrawerAttrs(drawerA11y.node);
          else drawerA11y.node = null;
        }
        if (!mobile || !isDrawerOpen()) {
          if (drawerA11y.node === sidebar) restoreDrawerAttrs(sidebar);
          return;
        }
        if (drawerA11y.node !== sidebar) {
          drawerA11y.node = sidebar;
          drawerA11y.role = sidebar.getAttribute('role');
          drawerA11y.modal = sidebar.getAttribute('aria-modal');
          drawerA11y.label = sidebar.getAttribute('aria-label');
        }
        setAttrIfChanged(sidebar, 'role', 'dialog');
        setAttrIfChanged(sidebar, 'aria-label', t('drawer'));
        setAttrIfChanged(sidebar, 'aria-modal', 'true');
      };

      const syncFrameFlags = () => {
        if (!frameEl || !frameEl.isConnected) return;
        const rightbarFullscreen = frameEl.hasAttribute('data-rightbar-fullscreen');
        setState({
          drawerOpen: !frameEl.hasAttribute('data-sidebar-collapsed'),
          rightbarFullscreen,
        });
        // 抽屉开合会改 data-sidebar-collapsed，role / aria-modal 要跟着变。
        if (state.mode === MODE_MOBILE) syncDrawerA11y(true);
        if (rightbarFullscreen && state.mode === MODE_MOBILE) syncRightbarChrome();
        // 右栏全屏与抽屉互斥：右栏打开时把抽屉收起。
        if (rightbarFullscreen && isDrawerOpen()) requestDrawer(false);
        syncOverlayHistory();
      };

      const bindFrame = (next) => {
        if (frameEl === next) {
          syncFrameFlags();
          return;
        }
        if (attrObserver) attrObserver.disconnect();
        frameEl = next;
        if (frameEl) {
          attrObserver = new win.MutationObserver(syncFrameFlags);
          attrObserver.observe(frameEl, {
            attributes: true,
            attributeFilter: ['data-sidebar-collapsed', 'data-rightbar-fullscreen'],
          });
        }
        syncFrameFlags();
      };

      const resolveAnchors = () => {
        if (disposed) return true;
        if (frameEl && frameEl.isConnected) {
          syncFrameFlags();
          return true;
        }
        const next = applyAnchors(doc);
        if (!next) {
          setState({ anchored: false });
          if (state.mode === MODE_MOBILE) setMode(MODE_DEFAULT);
          bindFrame(null);
          return false;
        }
        bindFrame(next);
        setState({ anchored: true });
        return true;
      };

      const setMode = (next) => {
        if (next === state.mode) return;
        const prev = state.mode;
        doc.documentElement.setAttribute('data-dshm-mode', next);
        setState({ mode: next });
        // 手机形态才把抽屉当模态对话框暴露；退出时还原官方属性。
        syncDrawerA11y(next === MODE_MOBILE);
        // 进入手机竖屏先收起抽屉，并记住「进入前是否展开」（桌面 / 平板窄窗
        // 才会命中）；退出手机布局时按原样还原，否则官方侧栏会一直停在折叠态。
        if (next === MODE_MOBILE && isDrawerOpen()) {
          sidebarExpandedBeforeMobile = true;
          requestDrawer(false);
        }
        if (prev === MODE_MOBILE && next === MODE_DEFAULT) {
          const restoreExpanded = sidebarExpandedBeforeMobile;
          sidebarExpandedBeforeMobile = false;
          // 抽屉在手机态由插件开合：退出时统一回正到进入前的状态，只调一次
          // toggleSidebar（它是异步更新的，连调两次会互相覆盖）。
          if (isDrawerOpen() !== restoreExpanded) requestDrawer(restoreExpanded);
        }
        if (next === MODE_DEFAULT) {
          // 离开手机形态：把压过的浮层历史条目退回，别留在桌面形态的栈里
          // （否则用户在桌面形态按一次返回会「没反应」）。popstate 因标记已复位而空转。
          if (overlayHistory) {
            overlayHistory = false;
            try {
              win.history.back();
            } catch (error) {
              console.warn('[dsh-mobile-layout] history.back 失败：', error);
            }
          }
          closeSheet();
          setState({ popoverOpen: false });
          clearStatsBar();
          clearHero();
          clearSettingsPanel();
          document.documentElement.removeAttribute('data-dshm-header-menu-open');
          document.documentElement.style.removeProperty('--dshm-header-menu-top');
          document.documentElement.style.removeProperty('--dshm-header-menu-right');
        }
        if (next === MODE_MOBILE) {
          // 换形态后输入区几何全变：清掉卡片缓存，让下一次同步立刻执行。
          lastComposerCard = null;
          syncComposerChips();
        }
        try {
          win.dispatchEvent(new win.CustomEvent('dshm:mode', { detail: { mode: next, version: VERSION } }));
        } catch (error) {
          console.error('[dsh-mobile-layout] 派发模式事件失败：', error);
        }
      };

      const evaluateNow = () => {
        if (disposed) return;
        if (!state.anchored && !resolveAnchors()) return;
        const size = measure(win);
        // 软键盘（visualViewport 收缩）不应把手机竖屏判定成非手机：手机态下
        // 宽度不变、高度明显变小时视为键盘/浮层，保持模式并保留进入时的基线。
        if (state.mode === MODE_MOBILE) {
          if (!mobileBase) mobileBase = size;
          const sameWidth = Math.abs(size.width - mobileBase.width) <= 2;
          if (sameWidth && size.height < mobileBase.height - 40) return;
          mobileBase = size;
        } else {
          mobileBase = null;
        }
        const next = resolveMode(hostKind, size.width, size.height, state.mode);
        setMode(next);
      };

      const schedule = (delay) => {
        if (disposed) return;
        if (debounceTimer) win.clearTimeout(debounceTimer);
        debounceTimer = win.setTimeout(() => {
          debounceTimer = 0;
          evaluateNow();
        }, delay);
      };

      /** 几何类同步（量 rect / computedStyle 的那一组）的合并窗口。 */
      const LAYOUT_SYNC_MS = 120;

      const runLayoutSync = () => {
        if (disposed || state.mode !== MODE_MOBILE) return;
        syncComposerChips();
      };

      /**
       * 几何类同步节流。
       *
       * `syncComposerChips` 一条链里要读输入区几十个 rect 与 computedStyle
       * （统计带、hero 位移、分界线、页头）。消息流式输出时 DOM 每帧都在变，
       * MutationObserver 每个 rAF 都全量量一遍会反复强制布局，低端机上直接
       * 掉帧。这里把这一组合并到 120ms 窗口；结构突变（输入卡换新节点）仍
       * 立刻执行，避免会话切换后闪一下旧布局。
       */
      const scheduleLayoutSync = (immediate) => {
        if (disposed) return;
        if (immediate) {
          if (layoutTimer) {
            win.clearTimeout(layoutTimer);
            layoutTimer = 0;
          }
          runLayoutSync();
          return;
        }
        if (layoutTimer) return;
        layoutTimer = win.setTimeout(() => {
          layoutTimer = 0;
          runLayoutSync();
        }, LAYOUT_SYNC_MS);
      };

      const onResize = () => {
        syncViewportVar();
        schedule(DEBOUNCE_MS);
        scheduleLayoutSync(false);
      };
      const onOrientation = () => {
        schedule(0);
        scheduleLayoutSync(true);
      };

      // 锚点可能在登录、面板切换、重建时重挂：用 MutationObserver 重新标记。
      // 只有轻量同步（浮层 / 设置页 / 返回栈）每帧跟手，重的几何同步走节流。
      observer = new win.MutationObserver(() => {
        if (disposed || anchorRaf) return;
        anchorRaf = win.requestAnimationFrame(() => {
          anchorRaf = 0;
          if (disposed || doc.hidden) return;
          if (!resolveAnchors()) return;
          evaluateNow();
          if (state.mode !== MODE_MOBILE) return;
          prunePopoverMarks();
          if (doc.querySelector('[role="listbox"], [role="menu"]') || doc.documentElement.hasAttribute('data-dshm-header-menu-open')) tagComposerMenus(true);
          setState({ popoverOpen: Boolean(doc.querySelector('[' + ATTR_POPOVER + ']')) });
          syncOverlayHistory();
          syncPanelSpace();
          if (state.rightbarFullscreen) syncRightbarChrome();
          syncSettingsPanel();
          const card = doc.querySelector('[data-composer-card]');
          const cardChanged = card !== lastComposerCard;
          lastComposerCard = card;
          scheduleLayoutSync(cardChanged);
        });
      });
      observer.observe(doc.documentElement, { childList: true, subtree: true });

      // 后台标签页不做同步（上面的 rAF 直接返回）；切回前台补一次全量。
      const onVisibilityChange = () => {
        if (doc.hidden) return;
        syncViewportVar();
        schedule(0);
        scheduleLayoutSync(true);
      };
      doc.addEventListener('visibilitychange', onVisibilityChange);

      // 点击后官方可能重渲染权限 / 模型按钮（aria-label 变化不触发 childList
      // 观察），这里在交互后补一次短文案同步。
      let chipTimer = 0;
      const scheduleChips = () => {
        if (disposed) return;
        if (chipTimer) win.clearTimeout(chipTimer);
        chipTimer = win.setTimeout(() => {
          chipTimer = 0;
          if (disposed || state.mode !== MODE_MOBILE) return;
          scheduleLayoutSync(true);
          if (doc.querySelector('[role="listbox"], [role="menu"]') || doc.documentElement.hasAttribute('data-dshm-header-menu-open')) tagComposerMenus();
          // 会话切换后 composer 往往在下一帧才挂载，补一次延迟同步（hero
          // 输入行的贴底标记、统计状态带都依赖挂载后的几何）。
          chipTimer = win.setTimeout(() => {
            chipTimer = 0;
            if (disposed || state.mode !== MODE_MOBILE) return;
            scheduleLayoutSync(true);
          }, 360);
        }, 80);
      };
      doc.addEventListener('click', scheduleChips, true);

      // 抽屉内点击「真正换页」的目标后自动收起，避免抽屉一直挡着内容。
      //
      // 只认两类：① 会话行（role=treeitem，工作区分组头带 aria-expanded 属于
      // 展开/折叠，不算换页）；② 带文字的导航按钮（新建会话 / 插件 / 自动化
      // 任务 / SSH 工作区）。搜索、视图选项、添加工作区、账号菜单、每行右侧的
      // 「… 操作」都是纯图标按钮，只开菜单或弹窗，点它们不该把抽屉收走。
      // 图标按钮里也有会换页的（如分组头的「新建会话」），用视图签名兜底：
      // 选中行 / 全局面板 / 路由变了才收。
      const NAV_TARGET_SELECTOR = '[role="treeitem"]:not([aria-expanded]), [role="option"]:not([aria-expanded]), a[href]';
      const sideViewSignature = () => {
        const sidebar = doc.querySelector('[' + ATTR_SIDEBAR + ']');
        if (!sidebar) return '';
        const current = sidebar.querySelector('[role="treeitem"][aria-selected="true"], [aria-current]');
        const key = current
          ? current.getAttribute('data-row-key') || (current.textContent || '').trim().slice(0, 32)
          : '';
        return key + '|' + doc.documentElement.getAttribute('data-dshm-panel') + '|' + win.location.pathname;
      };
      const closeDrawerAfterSelect = (delay) => {
        win.setTimeout(() => {
          if (disposed || state.mode !== MODE_MOBILE) return;
          if (isDrawerOpen()) requestDrawer(false);
        }, delay);
      };
      const onSidebarSelect = (event) => {
        if (state.mode !== MODE_MOBILE || !isDrawerOpen()) return;
        const target = event.target;
        if (!(target && target.closest)) return;
        if (!target.closest('[' + ATTR_SIDEBAR + ']')) return;
        const button = target.closest('button');
        const action = sidebarClickAction({
          inside: true,
          formControl: Boolean(target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"], [role="searchbox"]')),
          disclosure: Boolean(target.closest('[aria-expanded], [aria-haspopup], [aria-controls]')),
          navRow: Boolean(target.closest(NAV_TARGET_SELECTOR)),
          button: Boolean(button),
          hasText: Boolean(button && (button.textContent || '').trim()),
        });
        if (action === 'close') {
          // 放到同一手势的其余处理器之后，不打断官方导航本身。
          closeDrawerAfterSelect(0);
          return;
        }
        if (action !== 'signature') return;
        const before = sideViewSignature();
        win.setTimeout(() => {
          if (disposed || state.mode !== MODE_MOBILE || !isDrawerOpen()) return;
          if (sideViewSignature() !== before) requestDrawer(false);
        }, 220);
      };
      doc.addEventListener('click', onSidebarSelect, true);

      // ⊕ 位于浮层外，指针按下时官方会先关闭浮层；记录时间戳，
      // 让同一手势的 click 只收起、不重开。
      const onDocPointerDown = (event) => {
        const target = event.target;
        if (!(target && target.closest)) return;
        if (!target.closest('.dshm-bar-btn-spin')) return;
        if (doc.querySelector('[' + ATTR_POPOVER + ']')) popoverClosedAt = Date.now();
      };
      doc.addEventListener('pointerdown', onDocPointerDown, true);
      doc.addEventListener('mousedown', onDocPointerDown, true);

      // Android 返回键 / 浏览器后退：先关设置页，再关底部表、抽屉与右栏。
      const onPopState = () => {
        if (!overlayHistory) return;
        suppressHistory = true;
        overlayHistory = false;
        beginClosingOverlay();
        if (settingsPanelOpen()) {
          // 走官方关闭按钮，官方状态机自行收尾；找不到按钮时只退标记。
          // 与设置页左上角的返回键共用同一个出口。
          closeSettingsByBack();
          suppressHistory = false;
          return;
        }
        // 官方 ⊕ 浮层（加号面板）在最上层时先收它：官方子菜单不接返回键，
        // 不接管就会越过 WebView 直接 finish Activity（真机实测退到桌面）。
        if (state.popoverOpen || document.querySelector('[' + ATTR_POPOVER + ']')) {
          closeOfficialAddMenu();
          suppressHistory = false;
          return;
        }
        // 头部 ⋯ 菜单同理。
        if (document.documentElement.hasAttribute(ATTR_HEADER_MENU_OPEN)) {
          closeHeaderMenu();
          suppressHistory = false;
          return;
        }
        closeSheet();
        if (isDrawerOpen()) requestDrawer(false);
        if (state.rightbarFullscreen) {
          const layout = runtime.layout;
          if (layout && typeof layout.closeRightbar === 'function') {
            try {
              layout.closeRightbar();
            } catch (error) {
              console.error('[dsh-mobile-layout] 关闭右栏失败：', error);
            }
          }
        }
        suppressHistory = false;
      };

      win.addEventListener('resize', onResize);
      // Android 壳推送键盘高度（WindowInsets 桥 → evaluateJavascript 派发）。
      win.addEventListener('dsh-ime-height', onResize);
      win.addEventListener('orientationchange', onOrientation);
      win.addEventListener('pageshow', onOrientation);
      win.addEventListener('popstate', onPopState);
      // 设置页横滑换页签：挂在文档上而不是内容节点上，官方换 tab 时重挂
      // 内容节点也不需要重新绑定。
      doc.addEventListener('touchstart', onSettingsTouchStart, { passive: true });
      doc.addEventListener('touchend', onSettingsTouchEnd, { passive: true });
      doc.addEventListener('touchcancel', onSettingsTouchCancel, { passive: true });
      // 模型 / 权限选择器的搜索框焦点守卫：自动落焦立即 blur，防软键盘
      // 一开就盖住选项列表；用户点搜索框的正常路径放行。
      try {
        installPickerFocusGuard(doc);
      } catch (error) {
        logWarn('选择器搜索框焦点守卫安装失败：', error);
      }
      // 抽屉手势挂在 window 捕获阶段而不是 shell.overlay 槽位里：其它插件
      // 提供的面板页可能自己消费触摸事件（stopPropagation / 整页横滚），
      // 槽位组件的冒泡监听够不着；捕获阶段先于一切目标处理器，任何页面
      // 都监听得到。见 bindDrawerGesture 的头注释与 docs/plan-drawer-gesture.md。
      let releaseDrawerGesture = null;
      try {
        releaseDrawerGesture = bindDrawerGesture(win, doc);
      } catch (error) {
        logWarn('抽屉手势绑定失败（左缘滑动开抽屉不可用）：', error);
      }
      if (win.visualViewport) win.visualViewport.addEventListener('resize', onResize);

      // 官方槽位注册：遮罩层常驻但在默认布局下不渲染。
      // 客户端 cordis 的服务必须先 inject 才能取用（直接 ctx.slots 会抛错）。
      try {
        ctx.inject(['slots', 'layout'], (scoped) => {
          runtime.layout = scoped.layout || null;
          const slots = scoped.slots;
          try {
            slots.inject('shell.overlay', () => slots.register(
              { name: 'shell.overlay', id: 'dshm-overlay', order: 5 },
              OverlayLayer,
            ));
          } catch (error) {
            logWarn('shell.overlay 槽位注册失败（遮罩与兜底入口不可用）：', error);
          }
          try {
            slots.inject('shell.bottom', () => slots.register(
              { name: 'shell.bottom', id: 'dshm-bottom', order: 5 },
              BottomBar,
            ));
          } catch (error) {
            logWarn('shell.bottom 槽位注册失败（底部操作条不可用）：', error);
          }

          // 官方全局面板打开时隐藏底部条，把整行交还官方。
          const panelInfo = runtime.layout && runtime.layout.panelInfo;
          if (
            panelInfo &&
            typeof panelInfo.subscribe === 'function' &&
            typeof panelInfo.getSnapshot === 'function'
          ) {
            const syncPanel = () => {
              const snapshot = panelInfo.getSnapshot();
              const active = Boolean(snapshot && snapshot.activePanelId);
              setState({ panelActive: active });
              // 面板页盖住会话时，空会话 hero 不能浮在面板上。
              if (active) clearHero();
            };
            syncPanel();
            teardowns.push(panelInfo.subscribe(syncPanel));
          }

          // 会话与工作区服务：新建会话、会话表、切换会话。
          try {
            ctx.inject(['sessions', 'uiWorkspace'], (services) => {
              runtime.sessions = services.sessions || null;
              runtime.workspace = services.uiWorkspace || null;
            });
          } catch (error) {
            logWarn('sessions / uiWorkspace 注入失败（新建与会话表不可用）：', error);
          }
        });
      } catch (error) {
        logWarn('slots / layout 注入失败（抽屉不可用）：', error);
      }

      // 语言跟随官方 locale；服务缺席时退回 <html lang> / navigator。
      try {
        ctx.inject(['locale'], (scoped) => {
          const locale = scoped && scoped.locale;
          if (!locale) return;
          const applyLocale = () => {
            setLang(locale);
            syncComposerChips();
          };
          applyLocale();
          if (typeof scoped.on === 'function') scoped.on('locale/change', applyLocale);
        });
      } catch (error) {
        setLang(null);
        console.error('[dsh-mobile-layout] locale 注入失败：', error);
      }

      // 初始：先标记锚点（失败也不阻断），再判定模式。
      syncViewportVar();
      resolveAnchors();
      evaluateNow();
      // AppFrame 由官方在启动后挂载，锚点缺失不算错误；延迟确认仍缺失再提示。
      anchorTimer = win.setTimeout(() => {
        anchorTimer = 0;
        if (!disposed && !state.anchored) {
          logWarn('未找到官方 AppFrame 锚点（data-shell-bottom / data-rightbar-col），回退默认布局');
        }
      }, 2000);

      return function dispose() {
        disposed = true;
        if (debounceTimer) win.clearTimeout(debounceTimer);
        if (chipTimer) win.clearTimeout(chipTimer);
        if (anchorTimer) win.clearTimeout(anchorTimer);
        if (layoutTimer) win.clearTimeout(layoutTimer);
        if (settingsSwapTimer) {
          win.clearTimeout(settingsSwapTimer);
          settingsSwapTimer = 0;
        }
        if (anchorRaf) win.cancelAnimationFrame(anchorRaf);
        if (observer) observer.disconnect();
        if (attrObserver) attrObserver.disconnect();
        doc.removeEventListener('click', scheduleChips, true);
        doc.removeEventListener('click', onSidebarSelect, true);
        doc.removeEventListener('pointerdown', onDocPointerDown, true);
        doc.removeEventListener('mousedown', onDocPointerDown, true);
        doc.removeEventListener('visibilitychange', onVisibilityChange);
        win.removeEventListener('resize', onResize);
        win.removeEventListener('dsh-ime-height', onResize);
        win.removeEventListener('orientationchange', onOrientation);
        win.removeEventListener('pageshow', onOrientation);
        win.removeEventListener('popstate', onPopState);
        doc.removeEventListener('touchstart', onSettingsTouchStart);
        doc.removeEventListener('touchend', onSettingsTouchEnd);
        doc.removeEventListener('touchcancel', onSettingsTouchCancel);
        if (releaseDrawerGesture) releaseDrawerGesture();
        doc.removeEventListener('scroll', onDocScroll, true);
        if (pageHeadRaf) win.cancelAnimationFrame(pageHeadRaf);
        if (win.visualViewport) win.visualViewport.removeEventListener('resize', onResize);
        teardowns.forEach((fn) => {
          try {
            fn();
          } catch (error) {
            console.error('[dsh-mobile-layout] 清理订阅失败：', error);
          }
        });
        // 先把抽屉上的 role / aria-modal / aria-label 还原成进手机形态前的值，
        // 再清锚点标记（clearAnchors 之后找不到 [data-dshm-sidebar]）。
        syncDrawerA11y(false);
        // 设置页里由插件插进去的品牌行与返回键，官方不会回收，卸载时一起摘掉。
        doc.querySelectorAll('[' + ATTR_SETTINGS_BRAND + '], [' + ATTR_SETTINGS_BACK + ']').forEach((node) => node.remove());
        clearAnchors(doc);
        doc.documentElement.removeAttribute('data-dshm-mode');
        doc.documentElement.removeAttribute('data-dshm-panel');
        doc.documentElement.removeAttribute('data-dshm-swap');
        // 原位切换可能冻过 frame 的内联 padding / transition，一并还原。
        doc.querySelectorAll('[' + ATTR_FRAME + ']').forEach((node) => {
          node.style.transition = '';
          node.style.paddingBottom = '';
        });
        doc.documentElement.style.removeProperty('--dshm-ime-height');
        // 插件接管期间收起过侧栏的，卸载时还原成接管前的展开态。
        if (sidebarExpandedBeforeMobile) {
          sidebarExpandedBeforeMobile = false;
          const layout = runtime.layout;
          if (
            layout &&
            typeof layout.toggleSidebar === 'function' &&
            frameEl &&
            frameEl.isConnected &&
            frameEl.hasAttribute('data-sidebar-collapsed')
          ) {
            try {
              layout.toggleSidebar();
            } catch (error) {
              console.warn('[dsh-mobile-layout] 还原侧栏展开态失败：', error);
            }
          }
        }
        lastComposerCard = null;
        doc.documentElement.style.removeProperty('--dshm-viewport-height');
        doc.documentElement.style.removeProperty('--dshm-panel-space');
        doc.documentElement.style.removeProperty('--dshm-header-menu-top');
        doc.documentElement.style.removeProperty('--dshm-header-menu-right');
        doc.documentElement.removeAttribute('data-dshm-header-menu-open');
        doc.documentElement.style.removeProperty('--dshm-hero-shift');
        clearStatsBar();
        if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
        subscribers.clear();
        state = {
          mode: MODE_DEFAULT,
          anchored: false,
          drawerOpen: false,
          rightbarFullscreen: false,
          panelActive: false,
          sheet: null,
          popoverOpen: false,
          lang: runtime.lang,
          addPageCount: 0,
          settingsOpen: false,
        };
        popoverClosedAt = 0;
        closingOverlay = false;
        if (closingTimer) {
          win.clearTimeout(closingTimer);
          closingTimer = 0;
        }
        // 分页留下的内联 grid-template-columns / grid-column / display:none 必须
        // 一起撤掉：只清状态不清节点，官方宫格复用同一 listbox 时会停在
        // 「8 列 + 缺项」的形态。
        if (addPagingState.node) clearAddPaging(addPagingState.node);
        addPagingState.node = null;
        addPagingState.signature = '';
        settingsState.active = '';
        runtime.ctx = null;
        runtime.layout = null;
        runtime.sessions = null;
        runtime.workspace = null;
      };
    }

    exports.apply = apply;
    exports.__test = {
      classify,
      measure,
      detectHost,
      resolveMode,
      HOST_DESKTOP,
      HOST_ANDROID,
      HOST_WEB,
      permissionShort,
      modelShort,
      ENTER,
      STAY,
      MODE_MOBILE,
      MODE_DEFAULT,
      VERSION,
      rowsFor,
      slotOf,
      planAddPages,
      isSettingsDialog,
      workspaceTitleMap,
      workspaceNameFor,
      workspaceLabelFor,
      groupSessionsByWorkspace,
      formatRelativeTime,
      normalizeWorkspacePath,
      sidebarClickAction,
      ADD_COLS,
      ADD_MAX_ROWS,
      ADD_TINTS,
      addOptionKey,
      tintHash,
      planAddTints,
      sessionRows,
      sessionRowId,
      pageLabel,
      swipeDirection,
      nextTabIndex,
      drawerStartLimit,
      SWIPE_ARM_PX,
      isHorizScrollerMetrics,
      scrollerConsumes,
      decideDrawerGesture,
      drawerSettle,
      settingsSettle,
      SETTLE_RATIO,
      SETTLE_VELOCITY,
      resolveImeHeight,
      SWIPE_MIN,
      SHEET_DRAG_CLOSE_PX,
      shouldCloseSheetByDrag,
      STRINGS,
    };
    return module.exports;
  },
});
