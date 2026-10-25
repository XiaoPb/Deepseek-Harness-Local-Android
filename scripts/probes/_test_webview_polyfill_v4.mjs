#!/usr/bin/env node
/**
 * v1.4.19 · issue #40：polyfill v4 语义测试（WebView 96 模拟环境）。
 *
 * 从 scripts/patch-webview-polyfill.py 抽出 <script> 内容，在 vm 沙箱里构造
 * 「Chrome 96」全局（有 AbortController，但原型缺 reason / throwIfAborted /
 * 静态缺 any / timeout），逐条断言补齐后的行为与标准语义一致。
 * 另有一条「Chrome 126 模拟」断言：原生齐全时 polyfill 零改动。
 *
 * 运行: node scripts/probes/_test_webview_polyfill_v4.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const py = readFileSync(join(ROOT, "scripts", "patch-webview-polyfill.py"), "utf8");
const m = py.match(/POLYFILL = r'''(.*?)'''/s);
if (!m) throw new Error("POLYFILL not found in patch script");
const html = m[1];
const js = html.match(/<script>([\s\S]*?)<\/script>/)[1];
if (!html.includes("polyfill v4")) throw new Error("polyfill marker is not v4");

let pass = 0, fail = 0;
function check(name, ok) {
  console.log((ok ? "PASS  " : "FAIL  ") + name);
  ok ? pass++ : fail++;
}

/**
 * 构造「Chrome 96」全局。Node 24 的 AbortSignal 是原生实现，any/timeout
 * 属性不可配置（delete 静默失败），所以用纯 JS 的最小 fake（abort 时同步
 * 触发 abort 事件、无 reason/throwIfAborted/any/timeout）——行为面与 96
 * 相同，且全部成员可覆盖。
 */
function make96Sandbox() {
  class FakeSignal {
    constructor() { this.__listeners = []; }
    get aborted() { return !!this.__aborted; }
    addEventListener(type, fn) { if (type === "abort") this.__listeners.push(fn); }
    removeEventListener() {}
  }
  class FakeController {
    constructor() { this.signal = new FakeSignal(); }
    abort() {
      if (this.signal.__aborted) return;
      this.signal.__aborted = true;
      this.signal.__listeners.slice().forEach((fn) => { try { fn(); } catch (e) {} });
    }
  }
  const sandbox = {
    console,
    setTimeout,
    DOMException,
    queueMicrotask,
    AbortController: FakeController,
    AbortSignal: FakeSignal,
    Promise,
    URL,
    Object,
    Map,
    Array,
    String,
    JSON,
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(
    `delete AbortSignal.prototype.throwIfAborted;
     delete AbortSignal.prototype.any; delete AbortSignal.prototype.timeout;
     delete AbortSignal.prototype.reason;
     delete Promise.withResolvers; delete URL.parse;
     delete Object.hasOwn; delete Object.groupBy; delete Map.groupBy;
     delete Array.fromAsync;
     delete String.prototype.replaceAll; delete Array.prototype.at;
     delete String.prototype.at; delete Array.prototype.findLast;
     delete Array.prototype.findLastIndex; delete Array.prototype.toSorted;
     delete Array.prototype.toReversed; delete Array.prototype.toSpliced;
     delete Array.prototype.with;`,
    ctx,
  );
  vm.runInContext(js, ctx);
  return sandbox;
}

// ---- Chrome 126 模拟（先跑：宿主原型未动）——原生齐全 → polyfill 零改动 ----
{
  const modern = vm.createContext({
    console, setTimeout, DOMException, AbortController, AbortSignal, Promise, URL,
    Object, Map, Array, String, JSON, structuredClone,
  });
  const probeBefore = vm.runInContext(
    `JSON.stringify({
       throwIsNative: AbortSignal.prototype.throwIfAborted.toString().includes("[native code]"),
       anyIsNative: AbortSignal.any.toString().includes("[native code]"),
     })`,
    modern);
  vm.runInContext(js, modern);
  const probeAfter = vm.runInContext(
    `JSON.stringify({
       throwIsNative: AbortSignal.prototype.throwIfAborted.toString().includes("[native code]"),
       anyIsNative: AbortSignal.any.toString().includes("[native code]"),
     })`,
    modern);
  check("modern globals untouched by polyfill", probeBefore === probeAfter);
}

// ---- Chrome 96 模拟（删成员后再注入）----
const sb = make96Sandbox();

// 1. throwIfAborted：未中止 → 不抛
const r1 = vm.runInContext(
  `(function(){ const c = new AbortController();
     try { c.signal.throwIfAborted(); return "no-throw"; } catch (e) { return "threw:" + e.name; } })()`,
  sb);
check("throwIfAborted not-aborted returns silently", r1 === "no-throw");

// 2. abort('自定义原因') 后 throwIfAborted 抛出 **reason 本身**
const r2 = vm.runInContext(
  `(function(){ const c = new AbortController(); c.abort("user-cancel");
     try { c.signal.throwIfAborted(); return "no-throw"; }
     catch (e) { return (e === "user-cancel") ? "threw-reason" : "threw-other:" + e; } })()`,
  sb);
check("abort(reason) → throwIfAborted throws the reason", r2 === "threw-reason");

// 3. signal.reason 在 abort(reason) 后可读（Chrome 98 语义）
const r3 = vm.runInContext(
  `(function(){ const c = new AbortController(); c.abort("why"); return c.signal.reason; })()`,
  sb);
check("signal.reason stored by abort wrapper", r3 === "why");

// 4. 无参 abort → reason 为 AbortError DOMException
const r4 = vm.runInContext(
  `(function(){ const c = new AbortController(); c.abort();
     return c.signal.reason && c.signal.reason.name; })()`,
  sb);
check("bare abort() → reason is AbortError", r4 === "AbortError");

// 5. abort 事件的监听器在触发时能读到 reason（同步时序）
const r5 = vm.runInContext(
  `(function(){ const c = new AbortController(); let seen;
     c.signal.addEventListener("abort", () => { seen = c.signal.reason; });
     c.abort("from-event"); return seen; })()`,
  sb);
check("abort listener reads reason synchronously", r5 === "from-event");

// 6. 二次 abort 幂等：reason 不被覆盖
const r6 = vm.runInContext(
  `(function(){ const c = new AbortController(); c.abort("first"); c.abort("second");
     return c.signal.reason; })()`,
  sb);
check("second abort does not overwrite reason", r6 === "first");

// 7. AbortSignal.any 合并：子 signal 中止 → 合并 signal 中止且 reason 透传
const r7 = vm.runInContext(
  `(function(){ const a = new AbortController(); const b = new AbortController();
     const s = AbortSignal.any([a.signal, b.signal]);
     a.abort("child-reason");
     try { s.throwIfAborted(); return "no-throw"; }
     catch (e) { return (e === "child-reason") ? "merged-throws-reason" : "wrong:" + e; } })()`,
  sb);
check("AbortSignal.any merges + reason passthrough", r7 === "merged-throws-reason");

// 8. AbortSignal.timeout：到时中止（异步，用短时延 + await）
const r8 = await vm.runInContext(
  `(async function(){ const s = AbortSignal.timeout(30);
     await new Promise((res) => setTimeout(res, 90));
     try { s.throwIfAborted(); return "no-throw"; }
     catch (e) { return e && e.name; } })()`,
  sb, { timeout: 3000 });
check("AbortSignal.timeout aborts after ms", r8 === "TimeoutError");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
