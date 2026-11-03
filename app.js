'use strict';

(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // PDF.jsのプログラムはリポジトリ内に置き、外部のスクリプトは読み込まない。
  // 外部(jsDelivr)から取るのは、文字の対応表とフォントのデータだけ
  const PDFJS_BASE = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/';
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdfjs-3.11.174/pdf.worker.min.js';

  // 速度1.0のときに1秒間に読まれるおおよその文字数(10秒スキップと残り時間の目安に使う)
  const CPS = 14.5;
  // 1文の最大文字数。ChromeのGoogle音声(ネットワーク音声)は約15秒で止まるので短めに分ける
  const MAX_CHUNK_NETWORK = 230;
  const MAX_CHUNK_LOCAL = 1000;
  // 段落をまとめて1回で読むときの最大文字数
  const MAX_UTTERANCE = 1500;

  const synth = window.speechSynthesis || null;

  // ---------------------------------------------------------------- storage
  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem('pdfr:' + key);
        return v == null ? fallback : JSON.parse(v);
      } catch { return fallback; }
    },
    set(key, val) {
      try { localStorage.setItem('pdfr:' + key, JSON.stringify(val)); } catch { /* 保存できなくても動作は続ける */ }
    },
    del(key) {
      try { localStorage.removeItem('pdfr:' + key); } catch { /* noop */ }
    },
  };

  const DEFAULTS = {
    v: 2, rate: 1, pitch: 1, voiceURI: '', gap: 0, repeat: false,
    engine: 'device', systemLang: 'en-US', cloudVoice: 'en-US-Chirp3-HD-Aoede', cloudLimit: 900000,
    fontSize: 19, font: 'serif', theme: 'auto', wordHL: true, translate: false,
    skipHeaders: true, skipCites: true, skipMath: true, wakeLock: true, view: 'text',
  };
  const storedSettings = store.get('settings', {});
  // v1の初期値だった声の高さ1.05は、声が不自然になるので1.0に戻す
  if (!storedSettings.v && storedSettings.pitch === 1.05) storedSettings.pitch = 1;
  // リピートは false / 'sentence'(1文)/ 'page'(ページ)。以前は true/false だった
  if (storedSettings.repeat === true) storedSettings.repeat = 'sentence';
  const settings = Object.assign({}, DEFAULTS, storedSettings, { v: DEFAULTS.v });
  const saveSettings = () => store.set('settings', settings);
  // APIキーはブラウザに保存しない。以前の版で保存したキーが残っていれば消す
  if ('cloudKey' in settings) { delete settings.cloudKey; saveSettings(); }

  // 開いたPDFの本体はIndexedDBに置く(metaは一覧用、blobsは中身、audioはクラウドの声で作った音声)
  const AUDIO_CACHE_MAX = 4000; // 保存しておく音声の数(1文あたり20KB前後)
  const library = (() => {
    let dbp = null;
    let puts = 0;
    function open() {
      if (!dbp) {
        dbp = new Promise((resolve, reject) => {
          try {
            const req = indexedDB.open('pdfreader', 2);
            req.onupgradeneeded = () => {
              const db = req.result;
              if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' });
              if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs', { keyPath: 'id' });
              if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio', { keyPath: 'key' }).createIndex('t', 't');
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          } catch (e) { reject(e); }
        });
        dbp.catch(() => { dbp = null; });
      }
      return dbp;
    }
    function run(stores, mode, fn) {
      return open().then((db) => new Promise((resolve, reject) => {
        const t = db.transaction(stores, mode);
        const box = {};
        t.oncomplete = () => resolve(box.value);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
        fn(t, box);
      }));
    }
    return {
      list: () => run(['meta'], 'readonly', (t, box) => {
        const r = t.objectStore('meta').getAll();
        r.onsuccess = () => { box.value = r.result || []; };
      }),
      put: (meta, data) => run(['meta', 'blobs'], 'readwrite', (t) => {
        t.objectStore('meta').put(meta);
        if (data) t.objectStore('blobs').put({ id: meta.id, data });
      }),
      getMeta: (id) => run(['meta'], 'readonly', (t, box) => {
        const r = t.objectStore('meta').get(id);
        r.onsuccess = () => { box.value = r.result; };
      }),
      getData: (id) => run(['blobs'], 'readonly', (t, box) => {
        const r = t.objectStore('blobs').get(id);
        r.onsuccess = () => { box.value = r.result && r.result.data; };
      }),
      remove: (id) => run(['meta', 'blobs'], 'readwrite', (t) => {
        t.objectStore('meta').delete(id);
        t.objectStore('blobs').delete(id);
      }),
      audioGet: (key) => run(['audio'], 'readonly', (t, box) => {
        const r = t.objectStore('audio').get(key);
        r.onsuccess = () => { box.value = r.result && r.result.blob; };
      }),
      audioPut(key, blob) {
        const p = run(['audio'], 'readwrite', (t) => { t.objectStore('audio').put({ key, blob, t: Date.now() }); });
        if (++puts % 50 === 0) p.then(() => this.audioPrune()).catch(() => {});
        return p;
      },
      // 古い音声から消して、保存数を AUDIO_CACHE_MAX 以下に保つ
      audioPrune: () => run(['audio'], 'readwrite', (t) => {
        const store = t.objectStore('audio');
        const c = store.count();
        c.onsuccess = () => {
          let extra = c.result - AUDIO_CACHE_MAX;
          if (extra <= 0) return;
          store.index('t').openCursor().onsuccess = (e) => {
            const cur = e.target.result;
            if (!cur || extra-- <= 0) return;
            cur.delete();
            cur.continue();
          };
        };
      }),
    };
  })();

  // ---------------------------------------------------------------- state
  let doc = null; // { id, name, size, pdf, numPages, pages, T, items, pageItems, sentences, paraStarts, prefix }
  let spans = [];
  let hlSpan = null;
  let voices = [];
  let wakeLock = null;

  const st = {
    idx: 0, offset: 0, wordPos: 0,
    playing: false, gen: 0, started: false, uttStart: 0, retries: 0, errors: 0,
    boundaryOK: null, // 今の声が単語位置を通知するか(null=まだ分からない)
    utter: null, gapTimer: 0, speakTimer: 0, watchdog: 0,
    userScrollAt: 0, seeking: false, seekAt: 0,
    pdfPage: 1, pdfFollow: true, zoom: 1, pdfScale: 1, renderTok: 0, renderTask: null,
    sleepAt: 0, sleepMin: 0, sleepTimer: 0, sleepTick: 0, sleepPending: false,
    chunk: null, boundaryTimer: 0, cloudError: false, unlock: null, // chunk = いま読み込んでいるクラウドの声の音声(段落単位)
  };

  // ---------------------------------------------------------------- text extraction
  const ABBR = new Set(('mr mrs ms dr prof sr jr st vs etc e.g i.e fig figs eq eqs ref refs no nos vol vols pp ' +
    'al inc ltd co corp jan feb mar apr jun jul aug sep sept oct nov dec sec ch chap approx cf ca dept univ ' +
    'est resp viz ed eds tab art op cit ibid gen gov rev mt ft cap para app suppl ext lt col sgt').split(' '));

  function normalizeText(s) {
    return s.normalize('NFKC')
      .replace(/[­​-‍﻿]/g, '')
      .replace(/[‐‑]/g, '-');
  }

  async function extractPages(pdf, onProgress) {
    const pages = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      const items = [];
      for (const it of tc.items) {
        if (typeof it.str !== 'string') continue;
        const tx = pdfjsLib.Util.transform(vp.transform, it.transform);
        const h = Math.hypot(tx[2], tx[3]) || 1;
        items.push({
          str: normalizeText(it.str),
          x: tx[4], base: tx[5], w: it.width * vp.scale, h,
          eol: !!it.hasEOL,
          vertical: Math.abs(tx[1]) > Math.abs(tx[0]) + 0.01,
        });
      }
      pages.push({ w: vp.width, h: vp.height, lines: groupLines(items) });
      page.cleanup();
      onProgress(n, pdf.numPages);
    }
    markMargins(pages);
    return pages;
  }

  function groupLines(items) {
    const lines = [];
    let cur = null;
    let breakNext = true;
    for (const it of items) {
      if (!it.str.trim()) {
        if (cur && it.str && !breakNext) cur.items.push(it);
        if (it.eol) breakNext = true;
        continue;
      }
      if (!cur || breakNext || it.vertical !== cur.vertical ||
          Math.abs(it.base - cur.base) > Math.max(it.h, cur.h) * 0.55) {
        cur = { items: [], base: it.base, h: it.h, x: it.x, right: it.x + it.w, vertical: it.vertical };
        lines.push(cur);
      }
      cur.items.push(it);
      cur.right = Math.max(cur.right, it.x + it.w);
      cur.h = Math.max(cur.h, it.h);
      breakNext = it.eol;
    }
    for (const l of lines) {
      l.text = l.items.map((i) => i.str).join('').replace(/\s+/g, ' ').trim();
      l.top = l.base - l.h;
    }
    return lines;
  }

  // ページ上下の余白にあって、何ページにも繰り返し出てくる行(ヘッダー・フッター)とページ番号に印を付ける
  function markMargins(pages) {
    const PAGE_NUM = /^(page\s*)?(\d{1,4}|[ivxlc]{1,7})(\s*(of|\/)\s*\d{1,4})?$/i;
    const counts = new Map();
    for (const p of pages) {
      const seen = new Set();
      for (const l of p.lines) {
        l.band = l.vertical ? 'side' : l.base < p.h * 0.09 ? 'top' : l.top > p.h * 0.91 ? 'bottom' : '';
        if (l.band !== 'top' && l.band !== 'bottom') continue;
        l.key = l.band + ':' + l.text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ');
        if (!seen.has(l.key)) {
          seen.add(l.key);
          counts.set(l.key, (counts.get(l.key) || 0) + 1);
        }
      }
    }
    const minRepeat = pages.length >= 5 ? 3 : 2;
    for (const p of pages) {
      for (const l of p.lines) {
        l.margin = l.band === 'side' ||
          (!!l.band && (PAGE_NUM.test(l.text) || (l.text.length <= 160 && counts.get(l.key) >= minRepeat)));
      }
    }
  }

  const ENDS_SENTENCE = /[.!?:;"”’)\]]\s*$/;
  const sizeChange = (a, b) => !!a && Math.abs(a.h - b.h) > Math.max(a.h, b.h) * 0.2;

  function medianLineGap(lines) {
    const gaps = [];
    for (let i = 1; i < lines.length; i++) {
      const dy = lines[i].base - lines[i - 1].base;
      if (dy > 0 && dy < lines[i].h * 3 && !sizeChange(lines[i - 1], lines[i])) gaps.push(dy);
    }
    gaps.sort((a, b) => a - b);
    return gaps.length ? gaps[gaps.length >> 1] : 0;
  }

  function isParaBreak(prev, line, gap, medW, T) {
    const dy = line.base - prev.base;
    const h = Math.max(prev.h, line.h);
    const ends = ENDS_SENTENCE.test(T);
    if (sizeChange(prev, line)) return true;
    if (dy < -h) return ends; // 段組みの次の列へ移ったとき
    if (gap ? dy > gap * 1.45 + 0.5 : dy > h * 1.9) return true;
    if (ends && medW > 0 && prev.right - prev.x < medW * 0.72) return true;
    if (ends && line.x - prev.x > h * 0.9 && line.x - prev.x < h * 6) return true;
    return false;
  }

  function buildDoc(pages, opt) {
    let T = '';
    const items = [];
    const pageItems = pages.map(() => []);
    let lastItem = null;
    let lastLine = null;

    let mathPending = null; // 直前に読み飛ばした数式の行があったページ
    const mathMarks = []; // 読み飛ばした数式の位置 { pos, page }

    pages.forEach((p, pi) => {
      const lines = [];
      for (const l of p.lines) {
        if (opt.skipHeaders && l.margin) continue;
        if (opt.skipMath && isMathLine(l.text)) {
          if (mathPending == null) mathPending = pi;
          continue;
        }
        l.mathBefore = mathPending;
        mathPending = null;
        lines.push(l);
      }
      const gap = medianLineGap(lines);
      const widths = lines.map((l) => l.right - l.x).sort((a, b) => a - b);
      const medW = widths.length ? widths[widths.length >> 1] : 0;

      lines.forEach((line, li) => {
        if (T.length) {
          const prev = li > 0 ? lines[li - 1] : lastLine;
          let para = li === 0
            ? ENDS_SENTENCE.test(T) || sizeChange(prev, line)
            : isParaBreak(prev, line, gap, medW, T);
          if (line.mathBefore != null) {
            mathMarks.push({ pos: T.length, page: line.mathBefore });
            if (!ENDS_SENTENCE.test(T)) para = false; // 文の途中の数式なら、前後をつなげて1つの文にする
          }
          if (para) {
            T = T.replace(/ +$/, '');
            if (lastItem) lastItem.end = Math.min(lastItem.end, T.length);
            if (!T.endsWith('\n')) T += '\n';
          } else if (/[A-Za-z]-$/.test(T) && /^[a-z]/.test(line.text)) {
            // 行末のハイフンで切れた単語をつなぐ(state-of-the- のような複合語はハイフンを残す)
            const word = T.match(/(\S+)-$/)[1];
            if (!word.includes('-')) {
              T = T.slice(0, -1);
              if (lastItem && lastItem.end > lastItem.start) lastItem.end--;
            }
          } else if (!/\s$/.test(T)) {
            T += ' ';
          }
        }
        let prevIt = null;
        for (const it of line.items) {
          let s = it.str.replace(/\s+/g, ' ');
          // 右上についた小さな数字。単語や句読点の右上(脚注・引用の番号「word¹」)は読まない。
          // 数字の右上(10⁵ のような指数)は「10^5」にして、読み上げでは「10 to the power of 5」と読む
          const sup = prevIt && /^[\d,\-–*†‡§¶]+$/.test(s.trim()) && it.h < line.h * 0.8 && line.base - it.base > it.h * 0.25;
          if (sup && opt.skipCites && /[A-Za-z.,;:)"”’]$/.test(T)) {
            prevIt = it;
            continue;
          }
          if (sup && /\d$/.test(T) && /^\d{1,3}$/.test(s.trim())) {
            T += '^';
            s = s.trim();
          }
          if (prevIt && s && !/\s$/.test(T) && !s.startsWith(' ') && it.x - (prevIt.x + prevIt.w) > it.h * 0.18) T += ' ';
          if (T === '' || /\s$/.test(T)) s = s.replace(/^ +/, '');
          prevIt = it;
          if (!s) continue;
          if (!s.trim()) { T += ' '; continue; }
          // 項目の範囲には前後の空白を含めない
          const lead = s.length - s.trimStart().length;
          const rec = { start: T.length + lead, end: T.length + s.trimEnd().length, x: it.x, y: it.base - it.h, w: it.w, h: it.h, page: pi };
          T += s;
          items.push(rec);
          pageItems[pi].push(rec);
          lastItem = rec;
        }
        lastLine = line;
      });
    });
    if (mathPending != null) mathMarks.push({ pos: T.length, page: mathPending });

    const sentences = [];
    const paraStarts = [];
    let ps = 0;
    while (ps <= T.length) {
      let pe = T.indexOf('\n', ps);
      if (pe < 0) pe = T.length;
      const before = sentences.length;
      for (const [a, b] of splitSentences(T, ps, pe)) {
        for (const [c, d] of chunkLong(T, a, b, opt.maxChunk)) {
          const text = cleanText(T.slice(c, d), opt);
          if (!/[A-Za-z0-9]/.test(text)) continue;
          sentences.push({ a: c, b: d, text, page: pageAt(items, c), para: paraStarts.length });
        }
      }
      if (sentences.length > before) paraStarts.push(before);
      ps = pe + 1;
    }

    // 見出し(1文だけの短い段落で、文末の句読点がないもの)。表示と、読み上げの間の取り方に使う
    paraStarts.forEach((s0, p) => {
      const s1 = p + 1 < paraStarts.length ? paraStarts[p + 1] : sentences.length;
      if (s1 - s0 === 1 && sentences[s0].text.length < 90 && !/[.!?:;,]["”’)]?$/.test(sentences[s0].text)) sentences[s0].heading = true;
    });

    // 読み飛ばした数式は、その直前の文のうしろに印を出す(タップでPDF表示へ)
    let si = 0;
    for (const m of mathMarks) {
      while (si + 1 < sentences.length && sentences[si + 1].a <= m.pos) si++;
      if (sentences[si]) sentences[si].math = m.page;
    }

    const prefix = new Float64Array(sentences.length + 1);
    sentences.forEach((s, i) => { prefix[i + 1] = prefix[i] + s.text.length; });

    return { T, items, pageItems, sentences, paraStarts, prefix, maxChunk: opt.maxChunk };
  }

  const buildOpts = () => Object.assign({}, settings, { maxChunk: chunkLimit() });

  function trimRange(T, a, b) {
    while (a < b && /\s/.test(T[a])) a++;
    while (b > a && /\s/.test(T[b - 1])) b--;
    return [a, b];
  }

  function splitSentences(T, ps, pe) {
    const seg = T.slice(ps, pe);
    const out = [];
    const re = /[.!?…]+["'”’)\]]*(?=\s)/g;
    let start = 0;
    let m;
    while ((m = re.exec(seg))) {
      const end = m.index + m[0].length;
      const after = seg.slice(end).match(/^\s+(\S)/);
      if (!after) continue;
      if (/[a-z]/.test(after[1])) continue; // 次が小文字なら文の途中(略語など)
      if (m[0].replace(/["'”’)\]]+$/, '') === '.') {
        const sofar = seg.slice(start, m.index);
        const word = (sofar.match(/(\S+)$/) || ['', ''])[1].replace(/^[("'“‘[]+/, '');
        if (ABBR.has(word.toLowerCase()) || /^[A-Za-z]$/.test(word) || /^([A-Za-z]\.)+[A-Za-z]$/.test(word)) continue;
        // 見出しの番号(「1. Introduction」「2.3. Method」「IV. Results」)では区切らない
        if (/^(\d{1,3}(\.\d{1,3})*|[IVXLC]{1,6})$/.test(sofar.trim())) continue;
      }
      out.push(trimRange(T, ps + start, ps + end));
      start = end;
    }
    if (start < seg.length) out.push(trimRange(T, ps + start, pe));
    return out.filter(([a, b]) => b > a);
  }

  // 長い文を読点やセミコロンの位置で分ける
  function chunkLong(T, a, b, max) {
    const out = [];
    while (b - a > max) {
      const len = b - a;
      const target = len > max * 1.8 ? max : Math.ceil(len / 2) + 30;
      const piece = T.slice(a, a + target);
      let cut = -1;
      const re = /[,;:)—–](?=\s)|\s[—–-](?=\s)/g;
      let m;
      while ((m = re.exec(piece))) if (m.index >= 40) cut = m.index + 1;
      if (cut < 0) {
        cut = piece.lastIndexOf(' ');
        if (cut < 40) cut = target;
      }
      out.push(trimRange(T, a, a + cut));
      a = trimRange(T, a + cut, b)[0];
    }
    if (b > a) out.push([a, b]);
    return out;
  }

  function cleanText(s, opt) {
    let t = s.replace(/\n/g, ' ');
    if (opt.skipCites) {
      t = t.replace(/\s?\[\d+(?:\s*[-–,]\s*\d+)*\]/g, '')
        .replace(/\b(?:https?:\/\/|www\.)[^\s)\]]+/gi, 'link')
        .replace(/\bdoi:\s*\S+/gi, '')
        // 著者と年の引用「(Smith et al., 2020; Lee and Kim, 2019)」と、「Smith et al. (2020)」の年
        .replace(AUTHOR_YEAR_CITE, '')
        .replace(NARRATIVE_CITE_YEAR, '');
    }
    t = t.replace(/\s+/g, ' ').trim();
    if (opt.skipMath) t = stripInlineMath(t);
    return t;
  }

  // ---------------------------------------------------------------- math
  // 数式に使われる記号(ギリシャ文字と、文字に対応づけられていない記号=私用領域も含む)
  const MATH_CHAR = /[=<>+±×÷·∗∘∑∏∫∮∂∇√∞≤≥≠≈≡∼≃≅∝∈∉∋⊂⊃⊆⊇∪∩∧∨¬∀∃→←↔⇒⇐⇔↦⊕⊗⊥∥∠⌊⌋⌈⌉⟨⟩‖|^_{}~−′″Α-Ωα-ωϑϕϰϱϵ-]/;
  const MATH_CHAR_G = new RegExp(MATH_CHAR.source, 'g');
  const MATH_WORDS = new Set('log exp sin cos tan max min arg lim det sup inf mod softmax sigmoid relu tanh var cov diag dim ker'.split(' '));
  const SHORT_WORDS = new Set('a i an as at be by do if in is it of on or so to up we us no he me my'.split(' '));

  // 行全体が数式か(独立した数式の行、式番号だけの行、∑の上下の添字など)
  function isMathLine(text) {
    const t = text.trim();
    if (!t) return false;
    if (/^\(\d{1,3}(\.\d{1,3})?[a-z]?\)$/.test(t)) return true;
    const words = (t.match(/[A-Za-z]{3,}/g) || []).filter((w) => !MATH_WORDS.has(w.toLowerCase()));
    const sym = (t.match(MATH_CHAR_G) || []).length;
    if (!words.length) return sym > 0 || (t.length <= 12 && /[A-Za-z]/.test(t) && !/[a-z]{2,}/.test(t));
    if (sym >= 3 && words.length <= 2) return true;
    return sym / t.replace(/\s/g, '').length > 0.2 && words.length <= 4;
  }

  // 変数や数値のような短いトークン(数式記号のとなりにあれば一緒に消す)
  function isVarToken(w) {
    const core = w.replace(/^[([{]+|[)\]},.;:]+$/g, '');
    if (!core) return true;
    if (/^[\d.,]+$/.test(core)) return true;
    return /^[A-Za-z]{1,2}\d*$/.test(core) && !SHORT_WORDS.has(core.toLowerCase());
  }

  // 文の中の数式(「where x ∈ R^d is」の「x ∈ R^d」など)を取り除く。
  // 「~10」(およそ10)と「10^5」(数の指数)は文の一部として残す
  const isMathToken = (w) => MATH_CHAR.test(w) && !/^\(?~\d/.test(w) && !/^\(?\d+\^\d{1,3}[),.;:]?$/.test(w);
  function stripInlineMath(t) {
    if (!MATH_CHAR.test(t)) return t;
    const toks = t.split(' ');
    const drop = toks.map(isMathToken);
    toks.forEach((w, k) => {
      if (!isMathToken(w)) return;
      for (let j = k - 1; j >= 0 && !drop[j] && isVarToken(toks[j]); j--) drop[j] = true;
      for (let j = k + 1; j < toks.length && !drop[j] && isVarToken(toks[j]); j++) drop[j] = true;
    });
    const out = [];
    for (let k = 0; k < toks.length; k++) {
      if (!drop[k]) { out.push(toks[k]); continue; }
      let e = k;
      while (e + 1 < toks.length && drop[e + 1]) e++;
      // 消した範囲の最後にあった句読点は残す
      const punct = (toks[e].match(/([.,;:!?])[)\]"'”’]*$/) || [])[1];
      if (punct && out.length && !/[.,;:!?]$/.test(out[out.length - 1])) out[out.length - 1] += punct;
      k = e;
    }
    return out.join(' ');
  }

  const CITE_NAME = "[A-Z][\\p{L}'’.\\-]*(?:\\s+(?:et\\s+al\\.?|and|&|[A-Z][\\p{L}'’\\-]*))*";
  const CITE_YEAR = '(?:19|20)\\d{2}[a-z]?(?:,\\s*(?:19|20)\\d{2}[a-z]?)*';
  const AUTHOR_YEAR_CITE = new RegExp(`\\s?\\((?:(?:see|e\\.g\\.,?|cf\\.)\\s+)?(?:${CITE_NAME},?\\s+${CITE_YEAR}(?:,\\s*pp?\\.\\s*\\d+(?:[–-]\\d+)?)?(?:;\\s*)?)+\\)`, 'gu');
  const NARRATIVE_CITE_YEAR = new RegExp(`(?<=(?:et\\s+al\\.?|\\b[A-Z][\\p{Ll}'’\\-]+))\\s?\\(${CITE_YEAR}\\)`, 'gu');

  // ---------------------------------------------------------------- speech text
  // 声に出して読むときの言い換え。ネイティブが読み上げるときと同じように、略語や記号を言葉にする。
  // 画面の文はそのままにして、読み上げ用の文と「読み上げ用の位置 → 画面の位置」の対応表を作る
  const SPEECH_RULES = [
    [/\be\.g\.(,?)/gi, 'for example$1'],
    [/\bi\.e\.(,?)/gi, 'that is$1'],
    [/\bet al\.(?!$)/g, 'et al'],
    [/\bvs?\.(?=\s)/g, 'versus'],
    [/\bFigs\.(?=\s*\d)/g, 'Figures'],
    [/\bFig\.(?=\s*\d)/g, 'Figure'],
    [/\bEqs\.(?=\s*\(?\d)/g, 'Equations'],
    [/\bEq\.(?=\s*\(?\d)/g, 'Equation'],
    [/\bSecs\.(?=\s*\d)/g, 'Sections'],
    [/\bSec(?:t)?\.(?=\s*\d)/g, 'Section'],
    [/\bCh(?:ap)?\.(?=\s*\d)/g, 'Chapter'],
    [/\bTab\.(?=\s*\d)/g, 'Table'],
    [/\bRefs\.(?=\s*\d)/g, 'References'],
    [/\bRef\.(?=\s*\d)/g, 'Reference'],
    [/\bNos\.(?=\s*\d)/g, 'Numbers'],
    [/\bNo\.(?=\s*\d)/g, 'Number'],
    [/\bpp\.(?=\s*\d)/g, 'pages'],
    [/\bp\.(?=\s*\d)/g, 'page'],
    [/\bVols?\.(?=\s*\d)/g, 'Volume'],
    [/\bapprox\.(?=\s)/gi, 'approximately'],
    [/\bcf\.(?=\s)/g, 'compare'],
    [/\bw\.r\.t\.?/g, 'with respect to'],
    [/\bresp\.(?=[\s),;])/g, 'respectively'],
    [/\bviz\.(?=\s)/g, 'namely'],
    // 数の範囲「12–15」「2019-2021」(小数や「2020-01-15」のような日付は除く。文末のピリオドは可)
    [/(?<![\d.])(\d{1,4})\s?[–—]\s?(\d{1,4})(?!\d|[.,]\d)/g, '$1 to $2'],
    [/(?<![\d.\-])(\d{1,4})-(\d{1,4})(?!\d|[.,]\d|-\d)/g, '$1 to $2'],
    [/~\s?(?=\d)/g, 'about '],
    [/(\d)\^(\d{1,3})\b/g, '$1 to the power of $2'],
    [/\band\/or\b/gi, 'and or'],
    [/\bw\/o\b/gi, 'without'],
    [/\bw\/(?=\s)/gi, 'with'],
    [/\bType (II?) (?=errors?\b)/g, (m) => `Type ${m[1].length} `],
    // 「Chapter IV」「Part II」「World War II」のローマ数字は数字にする(「Section I describe」のIは代名詞なので除く)
    [/\b(Chapter|Part|Book|Section|Appendix|Volume|Act|Phase|Stage|Type|Class|Level|Step|War)\s+([IVXL]{1,6})\b(?=\s*$|\s*[.,:;)]|\s+[A-Z])|\b(Chapter|Part|Book|Section|Appendix|Volume|Act|Phase|Stage|Type|Class|Level|Step|War)\s+([IVXL]{2,6})\b/g,
      (m) => { const word = m[1] || m[3]; const n = romanToInt(m[2] || m[4]); return n ? `${word} ${n}` : m[0]; }],
  ];
  function romanToInt(r) {
    const v = { I: 1, V: 5, X: 10, L: 50 };
    let n = 0;
    for (let i = 0; i < r.length; i++) n += v[r[i]] < (v[r[i + 1]] || 0) ? -v[r[i]] : v[r[i]];
    // 正しい書き方のローマ数字だけ(IIII や VX などは対象外)
    const back = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX'];
    const tens = ['', 'X', 'XX', 'XXX', 'XL', 'L'];
    return n > 0 && n < 60 && tens[Math.floor(n / 10)] + back[n % 10] === r ? n : 0;
  }
  // 全部大文字の見出しで、ふつうの書き方に直す短い単語(それ以外の4文字以下は略語として残す)
  const CAPS_COMMON = new Set('A AN THE AND OR OF TO IN ON AT BY FOR WITH FROM INTO ONTO OVER AS IS ARE WAS BE NOT NO ITS IT THIS THAT WE YOU OUR HOW WHY WHAT WHEN ONE TWO SIX TEN PART'.split(' '));

  function speechText(src) {
    const hits = [];
    for (const [re, rep] of SPEECH_RULES) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src))) {
        if (!m[0].length) { re.lastIndex++; continue; }
        const out = typeof rep === 'function' ? rep(m) : rep.replace(/\$(\d)/g, (_, d) => m[+d] || '');
        hits.push({ a: m.index, b: m.index + m[0].length, out });
      }
    }
    hits.sort((x, y) => x.a - y.a || y.b - x.b);
    let text = '';
    const map = [];
    let pos = 0;
    for (const h of hits) {
      if (h.a < pos) continue; // 重なったら先のものを使う
      text += src.slice(pos, h.a);
      for (let k = pos; k < h.a; k++) map.push(k);
      text += h.out;
      for (let k = 0; k < h.out.length; k++) map.push(h.a);
      pos = h.b;
    }
    text += src.slice(pos);
    for (let k = pos; k < src.length; k++) map.push(k);
    map.push(src.length);
    // 全部大文字の見出しは、ふつうの書き方にする(頭文字を1文字ずつ読まれないように。文字数は変わらない)。
    // 4文字以下でよくある単語でないもの(NLP、BERTなど)は略語として残す
    if (!/[a-z]/.test(text) && (text.match(/[A-Z]/g) || []).length >= 8) {
      text = text.replace(/\b[A-Z][A-Z]+\b/g, (w) => (w.length >= 5 || CAPS_COMMON.has(w) ? w[0] + w.slice(1).toLowerCase() : w));
    }
    return { text, map: Int32Array.from(map) };
  }

  const sayOf = (s) => s.say || (s.say = speechText(s.text));

  // 画面の文の位置 → 読み上げ用の文の位置(その位置以降で最初に対応する所)
  function spokenIndex(map, offset) {
    let lo = 0;
    let hi = map.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (map[mid] < offset) lo = mid + 1; else hi = mid;
    }
    return Math.min(lo, map.length - 1);
  }

  // items は start 順。pos を含む(または pos 以降で最初の)項目の位置を返す
  function findItem(items, pos) {
    let lo = 0, hi = items.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (items[mid].end <= pos) lo = mid + 1; else hi = mid;
    }
    return lo;
  }
  function pageAt(items, pos) {
    const k = findItem(items, pos);
    return items[Math.min(k, items.length - 1)]?.page ?? 0;
  }
  function sentenceAt(pos) {
    const S = doc.sentences;
    let lo = 0, hi = S.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (S[mid].a <= pos) lo = mid; else hi = mid - 1;
    }
    if (S[lo].b < pos && lo + 1 < S.length) return lo + 1;
    return lo;
  }

  // ---------------------------------------------------------------- open / close documents
  async function openBuffer(buf, name, size, { save }) {
    stopSpeech();
    showLoading('PDFを読み込んでいます…', 0);
    let pdf;
    try {
      pdf = await pdfjsLib.getDocument({
        data: new Uint8Array(buf.slice(0)),
        cMapUrl: PDFJS_BASE + 'cmaps/',
        cMapPacked: true,
        standardFontDataUrl: PDFJS_BASE + 'standard_fonts/',
      }).promise;
    } catch (e) {
      hideLoading();
      if (e && e.name === 'PasswordException') toast('パスワード付きのPDFは開けません');
      else toast('PDFを開けませんでした。ファイルが壊れていないか確認してください');
      console.error(e);
      return;
    }

    let pages;
    try {
      pages = await extractPages(pdf, (n, total) => showLoading(`文章を取り出しています… ${n} / ${total}ページ`, n / total));
    } catch (e) {
      hideLoading();
      toast('文章の取り出しに失敗しました');
      console.error(e);
      return;
    }

    if (doc && doc.pdf) doc.pdf.destroy();
    const id = (pdf.fingerprints && pdf.fingerprints[0]) || `${name}-${size}`;
    doc = { id, name, size, pdf, numPages: pdf.numPages, pages };
    Object.assign(doc, buildDoc(pages, buildOpts()));

    const saved = store.get('pos:' + id, null);
    st.idx = saved ? restoreIndex(saved) : 0;
    st.offset = st.wordPos = 0;
    st.pdfPage = doc.sentences[st.idx] ? doc.sentences[st.idx].page + 1 : 1;
    st.pdfFollow = true;
    st.zoom = 1;

    hideLoading();
    showReader();
    renderText();
    markCurrent();
    applyView();
    if (saved && st.idx > 0) toast(`前回の続き(${doc.sentences[st.idx].page + 1}ページ)から再生できます`);

    updateMediaMeta();
    const meta = { id, name, size, numPages: pdf.numPages, nSent: doc.sentences.length, opened: Date.now() };
    try {
      const old = await library.getMeta(id);
      meta.added = old ? old.added : Date.now();
      await library.put(meta, save || !old ? buf : null);
    } catch (e) {
      console.warn('library save failed', e);
      if (save) toast('この端末への保存はできませんでしたが、読み上げは使えます');
    }
  }

  function restoreIndex(saved) {
    const S = doc.sentences;
    if (!S.length) return 0;
    const approx = clamp(saved.n ? Math.round(saved.i / Math.max(1, saved.n - 1) * (S.length - 1)) : saved.i, 0, S.length - 1);
    if (saved.snip) {
      const key = saved.snip.slice(0, 32);
      let best = -1;
      for (let i = 0; i < S.length; i++) {
        if (S[i].text.startsWith(key) && (best < 0 || Math.abs(i - approx) < Math.abs(best - approx))) best = i;
      }
      if (best >= 0) return best;
    }
    return approx;
  }

  function rebuild() {
    if (!doc) return;
    const cur = doc.sentences[st.idx];
    const snapshot = cur ? { i: st.idx, n: doc.sentences.length, snip: cur.text.slice(0, 50) } : null;
    const wasPlaying = st.playing;
    if (wasPlaying) pause();
    Object.assign(doc, buildDoc(doc.pages, buildOpts()));
    st.idx = snapshot ? restoreIndex(snapshot) : 0;
    st.offset = st.wordPos = 0;
    renderText();
    markCurrent();
    if (wasPlaying) play();
  }

  async function openFromLibrary(id) {
    try {
      const [meta, data] = await Promise.all([library.getMeta(id), library.getData(id)]);
      if (!meta || !data) {
        toast('保存データが見つかりませんでした。もう一度PDFを選んでください');
        await library.remove(id).catch(() => {});
        refreshLibrary();
        return;
      }
      await openBuffer(data, meta.name, meta.size, { save: false });
    } catch (e) {
      console.error(e);
      toast('保存したPDFを読み込めませんでした');
    }
  }

  function closeDoc() {
    stopSpeech();
    savePos();
    if (doc && doc.pdf) doc.pdf.destroy();
    doc = null;
    spans = [];
    hlSpan = null;
    $('#textView').innerHTML = '';
    showHome();
  }

  // ---------------------------------------------------------------- views
  function showHome() {
    $('#reader').hidden = true;
    $('#home').hidden = false;
    closeSheets();
    refreshLibrary();
  }
  function showReader() {
    $('#home').hidden = true;
    $('#reader').hidden = false;
    $('#docTitle').textContent = doc.name.replace(/\.pdf$/i, '');
    $('#pdfPageCount').textContent = doc.numPages;
    $('#pdfPageInput').max = doc.numPages;
    $('#pageJumpInput').max = doc.numPages;
    $('#searchResults').innerHTML = '';
    $('#searchInput').value = '';
    if (!history.state || !history.state.reader) history.pushState({ reader: true }, '');
  }

  async function refreshLibrary() {
    const list = $('#libraryList');
    let metas = [];
    try { metas = await library.list(); } catch { metas = []; }
    metas.sort((a, b) => (b.opened || 0) - (a.opened || 0));
    $('#libraryEmpty').hidden = metas.length > 0;
    list.innerHTML = metas.map((m) => {
      const pos = store.get('pos:' + m.id, null);
      const pct = pos && pos.n > 1 ? Math.round(pos.i / (pos.n - 1) * 100) : 0;
      const d = new Date(m.opened || m.added || Date.now());
      return `<li class="book" data-id="${esc(m.id)}">
        <button class="book-open" type="button" data-open="${esc(m.id)}">
          <span class="book-name">${esc(m.name.replace(/\.pdf$/i, ''))}</span>
          <span class="book-meta">${m.numPages}ページ · ${pct}% · ${d.getMonth() + 1}/${d.getDate()}に開いた</span>
          <span class="book-bar"><span style="width:${pct}%"></span></span>
        </button>
        <button class="book-del" type="button" data-del="${esc(m.id)}" aria-label="削除">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path class="stroke" d="M5 7h14M10 7V4.5h4V7M7 7l1 13h8l1-13"/></svg>
        </button>
      </li>`;
    }).join('');
  }

  function renderText() {
    const tv = $('#textView');
    tv.classList.toggle('sans', settings.font === 'sans');
    hlSpan = null;
    const S = doc.sentences;
    if (!S.length) {
      tv.innerHTML = `<div class="notext"><b>このPDFには文字データが見つかりませんでした</b>
        スキャンした画像だけのPDFは読み上げできません。「PDF」表示でページを見ることはできます。</div>`;
      spans = [];
      return;
    }
    const parts = [];
    let lastPage = -1;
    for (let p = 0; p < doc.paraStarts.length; p++) {
      const s0 = doc.paraStarts[p];
      const s1 = p + 1 < doc.paraStarts.length ? doc.paraStarts[p + 1] : S.length;
      let html = '';
      for (let i = s0; i < s1; i++) {
        const s = S[i];
        if (s.page !== lastPage) {
          html += `<span class="pg">p.${s.page + 1}</span>`;
          lastPage = s.page;
        }
        html += `<span class="s" data-i="${i}">${esc(s.text)}</span> `;
        if (s.math != null) html += `<button type="button" class="mathmark" data-math-page="${s.math + 1}" aria-label="読み飛ばした数式をPDFで見る(${s.math + 1}ページ)">数式</button> `;
      }
      parts.push(S[s0].heading ? `<p class="h">${html}</p>` : `<p>${html}</p>`);
    }
    tv.innerHTML = `<div class="text-inner">${parts.join('')}</div>`;
    spans = $$('.s', tv);
  }

  function applyView() {
    const pdfMode = settings.view === 'pdf';
    $('#textView').hidden = pdfMode;
    $('#pdfView').hidden = !pdfMode;
    $('#pdfToolbar').hidden = !pdfMode;
    $('#modeText').setAttribute('aria-pressed', String(!pdfMode));
    $('#modePdf').setAttribute('aria-pressed', String(pdfMode));
    $('#followBtn').hidden = true;
    if (!doc) return;
    if (pdfMode) {
      const s = doc.sentences[st.idx];
      st.pdfFollow = true;
      renderPdfPage(s ? s.page + 1 : st.pdfPage);
    } else {
      st.userScrollAt = 0;
      followText(true);
    }
  }

  function markCurrent() {
    if (!doc) return;
    if (hlSpan) {
      hlSpan.classList.remove('cur');
      if (hlSpan.dataset.w) {
        hlSpan.textContent = doc.sentences[+hlSpan.dataset.i].text;
        delete hlSpan.dataset.w;
      }
    }
    hlSpan = spans[st.idx] || null;
    if (hlSpan) hlSpan.classList.add('cur');
    if (settings.view === 'pdf') showPdfSentence();
    else followText(false);
    updateProgress();
    showTranslation();
  }

  function markWord(pos, len) {
    if (!hlSpan || !settings.wordHL || settings.view !== 'text') return;
    const t = doc.sentences[st.idx].text;
    if (!len) {
      const m = t.slice(pos).match(/^\S+/);
      len = m ? m[0].length : 0;
    }
    if (!len) return;
    hlSpan.innerHTML = esc(t.slice(0, pos)) + '<mark class="w">' + esc(t.slice(pos, pos + len)) + '</mark>' + esc(t.slice(pos + len));
    hlSpan.dataset.w = '1';
  }

  const userIsScrolling = () => performance.now() - st.userScrollAt < 6000;

  function followText(force) {
    if (!hlSpan) return;
    const stage = $('#stage');
    if (!force && userIsScrolling()) { updateFollowBtn(); return; }
    const r = hlSpan.getBoundingClientRect();
    const sr = stage.getBoundingClientRect();
    if (force || r.top < sr.top + sr.height * 0.1 || r.bottom > sr.top + sr.height * 0.72) {
      stage.scrollTo({ top: stage.scrollTop + (r.top - sr.top) - sr.height * 0.28, behavior: force || reducedMotion ? 'auto' : 'smooth' });
    }
    $('#followBtn').hidden = true;
  }

  function updateFollowBtn() {
    const btn = $('#followBtn');
    if (!doc || !doc.sentences.length) { btn.hidden = true; return; }
    const stage = $('#stage');
    const sr = stage.getBoundingClientRect();
    let visible = true;
    if (settings.view === 'text') {
      if (!hlSpan) { btn.hidden = true; return; }
      const r = hlSpan.getBoundingClientRect();
      visible = r.bottom > sr.top && r.top < sr.bottom;
    } else {
      const s = doc.sentences[st.idx];
      const hl = $('#hlLayer').firstElementChild;
      if (s.page + 1 !== st.pdfPage) visible = false;
      else if (hl) {
        const r = hl.getBoundingClientRect();
        visible = r.bottom > sr.top && r.top < sr.bottom;
      }
    }
    btn.hidden = visible;
  }

  function updateProgress() {
    const S = doc.sentences;
    const seek = $('#seek');
    seek.max = Math.max(0, S.length - 1);
    // つまみを動かしている最中は再生位置で上書きしない(changeが来ないまま指を離した場合も1.5秒で戻す)
    if (!st.seeking || performance.now() - st.seekAt > 1500) { st.seeking = false; seek.value = st.idx; }
    const pct = S.length > 1 ? st.idx / (S.length - 1) : 0;
    seek.style.setProperty('--pct', (pct * 100).toFixed(2) + '%');
    const s = S[st.idx];
    $('#posLabel').textContent = s ? `p.${s.page + 1} / ${doc.numPages}` : `p.1 / ${doc.numPages}`;
    if (S.length) {
      const remainSec = (doc.prefix[S.length] - doc.prefix[st.idx]) / (CPS * settings.rate);
      $('#remainLabel').textContent = `${Math.round(pct * 100)}% · 残り約${formatDuration(remainSec)}`;
    } else {
      $('#remainLabel').textContent = '';
    }
  }

  function formatDuration(sec) {
    const min = Math.max(1, Math.round(sec / 60));
    if (min < 60) return `${min}分`;
    return `${Math.floor(min / 60)}時間${min % 60 ? (min % 60) + '分' : ''}`;
  }

  // ---------------------------------------------------------------- PDF view
  async function renderPdfPage(n) {
    if (!doc) return;
    n = clamp(Math.round(n) || 1, 1, doc.numPages);
    const tok = ++st.renderTok;
    st.pdfPage = n;
    $('#pdfPageInput').value = n;
    const page = await doc.pdf.getPage(n);
    if (tok !== st.renderTok || !doc) return;
    const base = page.getViewport({ scale: 1 });
    const avail = Math.max(200, $('#stage').clientWidth - 24);
    const cssScale = (avail / base.width) * st.zoom;
    const vp = page.getViewport({ scale: cssScale });
    let dpr = Math.min(window.devicePixelRatio || 1, 3);
    const maxPixels = 12e6; // iOSのcanvas上限に余裕を持たせる
    if (vp.width * vp.height * dpr * dpr > maxPixels) dpr = Math.sqrt(maxPixels / (vp.width * vp.height));
    if (st.renderTask) { st.renderTask.cancel(); st.renderTask = null; }
    const canvas = $('#pdfCanvas');
    canvas.width = Math.floor(vp.width * dpr);
    canvas.height = Math.floor(vp.height * dpr);
    canvas.style.width = vp.width + 'px';
    canvas.style.height = vp.height + 'px';
    const wrap = $('#pdfPage');
    wrap.style.width = vp.width + 'px';
    wrap.style.height = vp.height + 'px';
    st.pdfScale = cssScale;
    $('#hlLayer').innerHTML = '';
    const task = page.render({
      canvasContext: canvas.getContext('2d'),
      viewport: vp,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
    });
    st.renderTask = task;
    try {
      await task.promise;
    } catch (e) {
      if (e && e.name === 'RenderingCancelledException') return;
      console.error(e);
    }
    if (st.renderTask === task) st.renderTask = null;
    if (tok === st.renderTok) drawPdfHighlight(st.pdfFollow);
  }

  function drawPdfHighlight(scroll) {
    const layer = $('#hlLayer');
    const s = doc && doc.sentences[st.idx];
    if (!s) { layer.innerHTML = ''; return; }
    const pi = st.pdfPage - 1;
    const sc = st.pdfScale;
    let html = '';
    for (let k = findItem(doc.items, s.a); k < doc.items.length && doc.items[k].start < s.b; k++) {
      const it = doc.items[k];
      if (it.page !== pi) continue;
      const len = Math.max(1, it.end - it.start);
      const f0 = clamp((s.a - it.start) / len, 0, 1);
      const f1 = clamp((s.b - it.start) / len, 0, 1);
      if (f1 <= f0) continue;
      const x = (it.x + it.w * f0) * sc;
      const w = Math.max(2, it.w * (f1 - f0) * sc);
      const y = (it.y - it.h * 0.12) * sc;
      const h = it.h * 1.32 * sc;
      html += `<div class="hl" style="left:${x.toFixed(1)}px;top:${y.toFixed(1)}px;width:${w.toFixed(1)}px;height:${h.toFixed(1)}px"></div>`;
    }
    layer.innerHTML = html;
    if (scroll) scrollPdfToHighlight();
  }

  function scrollPdfToHighlight() {
    const hl = $('#hlLayer').firstElementChild;
    if (!hl || userIsScrolling()) { updateFollowBtn(); return; }
    const stage = $('#stage');
    const r = hl.getBoundingClientRect();
    const sr = stage.getBoundingClientRect();
    if (r.top < sr.top + 60 || r.bottom > sr.top + sr.height * 0.75) {
      stage.scrollTo({ top: stage.scrollTop + (r.top - sr.top) - sr.height * 0.3, behavior: reducedMotion ? 'auto' : 'smooth' });
    }
    $('#followBtn').hidden = true;
  }

  function showPdfSentence() {
    const s = doc.sentences[st.idx];
    if (!s) return;
    if (st.pdfFollow && s.page + 1 !== st.pdfPage) renderPdfPage(s.page + 1);
    else drawPdfHighlight(st.pdfFollow);
  }

  function tapPdf(e) {
    if (!doc || !doc.sentences.length) return;
    const r = $('#pdfCanvas').getBoundingClientRect();
    const px = (e.clientX - r.left) / st.pdfScale;
    const py = (e.clientY - r.top) / st.pdfScale;
    let best = null;
    let bd = Infinity;
    for (const it of doc.pageItems[st.pdfPage - 1] || []) {
      const dx = px < it.x ? it.x - px : px > it.x + it.w ? px - it.x - it.w : 0;
      const dy = py < it.y ? it.y - py : py > it.y + it.h ? py - it.y - it.h : 0;
      const d = dx * dx + dy * dy * 4;
      if (d < bd) { bd = d; best = it; }
    }
    if (!best || bd > 50 * 50) return;
    const f = clamp((px - best.x) / (best.w || 1), 0, 1);
    jumpTo(sentenceAt(best.start + Math.floor((best.end - best.start) * f)));
  }

  function readFromPage(n) {
    if (!doc || !doc.sentences.length) return;
    const i = doc.sentences.findIndex((s) => s.page >= n - 1);
    if (i < 0) { toast('このページ以降に読める文がありません'); return; }
    jumpTo(i);
  }

  // ---------------------------------------------------------------- voices
  const FEMALE = new Set(('samantha ava allison susan zoe zoey nicky joelle noelle karen moira tessa fiona serena kate ' +
    'stephanie martha catherine veena isha sangeeta victoria vicki agnes kathy princess flo sandy shelley grandma ' +
    'aria jenny zira michelle ana libby sonia maisie natasha clara emily hazel heera neerja linda hayley jessa ashley ' +
    'amber cora elizabeth jane nancy sara monica molly emma olivia mia salli joanna kendra kimberly ivy nicole ' +
    'raveena aditi luna ruth female').split(' '));
  const NOVELTY = /^(albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|deranged|hysterical|pipe organ|junior|ralph|fred|kathy|princess)\b/i;
  const ROBOTIC = /^(flo|sandy|shelley|grandma|grandpa|eddy|reed|rocko)\b/i;
  const FAVORITES = ['ava', 'samantha', 'allison', 'zoe', 'aria', 'jenny', 'google us english', 'serena', 'susan', 'karen', 'kate', 'moira', 'nicky', 'tessa', 'zira'];
  const LANG_JA = { US: 'アメリカ英語', GB: 'イギリス英語', AU: 'オーストラリア英語', IE: 'アイルランド英語', ZA: '南アフリカ英語', IN: 'インド英語', NZ: 'ニュージーランド英語', CA: 'カナダ英語', SG: 'シンガポール英語' };

  function voiceBaseName(v) {
    return v.name.replace(/^(Microsoft|Google|Apple)\s+/i, '').replace(/\s*[(-].*$/, '').replace(/\s+Online.*$/i, '').trim().toLowerCase();
  }
  function isFemale(v) {
    const n = v.name.toLowerCase();
    if (/\bfemale\b/.test(n) || n === 'google us english') return true;
    if (/\bmale\b/.test(n)) return false;
    return FEMALE.has(voiceBaseName(v).split(' ')[0]);
  }
  const isHighQuality = (v) => /enhanced|premium|natural|neural|拡張|プレミアム/i.test(v.name + ' ' + v.voiceURI);
  function langLabel(lang) {
    const m = /^en[-_]([A-Za-z]{2})/.exec(lang || '');
    if (/gbsct|scotland/i.test(lang)) return 'スコットランド英語';
    return (m && LANG_JA[m[1].toUpperCase()]) || lang || '英語';
  }
  function voiceScore(v) {
    let s = 0;
    if (isFemale(v)) s += 100;
    if (ROBOTIC.test(v.name)) s -= 80;
    if (isHighQuality(v)) s += 30;
    if (/^en[-_]US/i.test(v.lang)) s += 10;
    else if (/^en[-_]GB/i.test(v.lang)) s += 6;
    const fav = FAVORITES.indexOf(v.name.toLowerCase() === 'google us english' ? 'google us english' : voiceBaseName(v));
    if (fav >= 0) s += 20 - fav;
    if (v.localService) s += 1;
    return s;
  }

  function loadVoices() {
    if (!synth) return;
    const all = synth.getVoices();
    let en = all.filter((v) => /^en([-_]|$)/i.test(v.lang) && !NOVELTY.test(v.name));
    if (!en.length) en = all.filter((v) => /^en/i.test(v.lang));
    en.sort((a, b) => voiceScore(b) - voiceScore(a) || a.name.localeCompare(b.name));
    const uriOf = (v) => (v ? v.voiceURI : '');
    const before = uriOf(currentVoice());
    voices = en;
    if (uriOf(currentVoice()) !== before) onVoiceChanged();
    else updateVoiceLabel();
    if (!$('#voiceSheet').hidden) renderVoiceList();
  }

  // 「iPhoneの設定の声」: 声を指定せずに言語だけを指定すると、Safariは言語から声を選ぶ。
  // 最近のiOSではそれが設定アプリの「読み上げコンテンツ › 声」で選んだ声になるので、
  // 一覧には出てこない、ダウンロードした高音質の声(Premium/Enhanced)を使える可能性がある
  const SYSTEM_VOICE = 'system';
  const useSystemVoice = () => settings.voiceURI === SYSTEM_VOICE;
  const SYSTEM_LANGS = ['en-US', 'en-GB', 'en-AU', 'en-IE', 'en-IN', 'en-ZA'];

  function currentVoice() {
    if (!voices.length || useSystemVoice()) return null;
    return voices.find((v) => v.voiceURI === settings.voiceURI) || voices[0];
  }

  // 発話に声を設定する
  function applyVoice(u) {
    const v = currentVoice();
    if (v) { u.voice = v; u.lang = v.lang; }
    else u.lang = useSystemVoice() ? settings.systemLang : 'en-US';
  }

  // ネットワーク音声(ChromeのGoogle音声など)だけ長い文を短く分ける
  function chunkLimit() {
    const v = currentVoice();
    return v && v.localService === false ? MAX_CHUNK_NETWORK : MAX_CHUNK_LOCAL;
  }

  // 声が変わったら、単語位置の通知に対応しているかを測り直し、文の分け方も合わせる
  function onVoiceChanged() {
    st.boundaryOK = null;
    updateVoiceLabel();
    if (doc && doc.maxChunk !== chunkLimit()) rebuild();
  }
  function updateVoiceLabel() {
    const cloud = cloudActive();
    $('#voiceChip').classList.toggle('cloud', cloud);
    if (cloud) { $('#voiceLabel').textContent = cloudVoiceShort(settings.cloudVoice); return; }
    if (useSystemVoice()) { $('#voiceLabel').textContent = '設定の声'; return; }
    const v = currentVoice();
    $('#voiceLabel').textContent = v ? v.name.replace(/^(Microsoft|Google)\s+/, '').replace(/\s+Online.*$/, '') : '標準';
  }

  function renderVoiceList() {
    const cur = currentVoice();
    const groups = [
      ['おすすめ(女性の声)', voices.filter((v) => isFemale(v) && !ROBOTIC.test(v.name))],
      ['そのほかの英語の声', voices.filter((v) => !isFemale(v) || ROBOTIC.test(v.name))],
    ];
    const sys = useSystemVoice();
    let html = `<div class="voice-group">iPhoneの設定の声</div>
      <button type="button" class="voice" role="radio" aria-checked="${sys}" data-uri="${SYSTEM_VOICE}">
        <span class="voice-dot"></span>
        <span class="voice-body"><span class="voice-name">設定アプリで選んだ声</span><span class="voice-lang">${esc(langLabel(settings.systemLang))}・ダウンロードした高音質の声を使える場合があります</span></span>
        <span class="tag good">高音質向け</span>
      </button>`;
    if (sys) {
      html += `<label class="sys-lang" for="sysLang"><span>英語の種類</span>
        <select id="sysLang">${SYSTEM_LANGS.map((c) => `<option value="${c}"${c === settings.systemLang ? ' selected' : ''}>${esc(langLabel(c))}</option>`).join('')}</select></label>`;
    }
    for (const [label, list] of groups) {
      if (!list.length) continue;
      html += `<div class="voice-group">${label}</div>`;
      for (const v of list) {
        const checked = cur && v.voiceURI === cur.voiceURI;
        html += `<button type="button" class="voice" role="radio" aria-checked="${checked}" data-uri="${esc(v.voiceURI)}">
          <span class="voice-dot"></span>
          <span class="voice-body"><span class="voice-name">${esc(v.name)}</span><span class="voice-lang">${esc(langLabel(v.lang))}</span></span>
          ${isHighQuality(v) ? '<span class="tag good">高音質</span>' : ''}
        </button>`;
      }
    }
    $('#voiceList').innerHTML = html || '<p class="note">英語の声が見つかりませんでした。端末の設定で英語の声を追加してください。</p>';
  }

  function previewVoice() {
    if (!synth || st.playing) return;
    const u = new SpeechSynthesisUtterance('Hello! I will read your PDF aloud at this speed.');
    applyVoice(u);
    u.rate = settings.rate;
    u.pitch = settings.pitch;
    synth.cancel();
    st.utter = u;
    synth.speak(u);
  }

  // ---------------------------------------------------------------- speech
  function clearTimers() {
    clearTimeout(st.gapTimer);
    clearTimeout(st.speakTimer);
    clearTimeout(st.watchdog);
    clearTimeout(st.boundaryTimer);
    st.gapTimer = st.speakTimer = st.watchdog = st.boundaryTimer = 0;
  }

  // 段落の変わり目と見出しの前後に、ナレーターのような間を入れる(ミリ秒。速く読むときは短くする)。
  // 声の側でも文末に短い無音が入るので、それに足す分
  const PARA_PAUSE = 350;
  const HEADING_PAUSE = 650;
  function naturalPause(from, to) {
    const S = doc.sentences;
    if (to >= S.length || to <= from || S[to].para === S[from].para) return 0;
    return (S[from].heading || S[to].heading ? HEADING_PAUSE : PARA_PAUSE) / settings.rate;
  }

  // i番目の文と同じページの最初の文(文はページ順に並んでいる)
  function firstOfPage(i) {
    const S = doc.sentences;
    let k = i;
    while (k > 0 && S[k - 1].page === S[i].page) k--;
    return k;
  }

  function play() {
    if (!doc || !doc.sentences.length) return;
    if (!synth && !cloudActive()) { toast('このブラウザは音声読み上げに対応していません'); return; }
    if (settings.engine === 'cloud' && !cloudKey && !keyNagged) {
      keyNagged = true;
      toast('クラウドの声を使うには「声」でAPIキーを入れてください。今は端末の声で読みます');
    }
    st.playing = true;
    st.errors = 0;
    st.retries = 0;
    updatePlayBtn();
    acquireWakeLock();
    if (cloudActive()) {
      unlockAudio(); // iOSではタップ操作の中で一度再生しておかないと、あとから音声を流せない
      // 一時停止した音声が残っていれば、止めた位置からそのまま再開する
      if (cloudCanResume()) {
        audioEl.playbackRate = settings.rate;
        audioEl.play().then(() => { st.uttStart = performance.now(); scheduleBoundary(); }).catch(() => { pause(); });
        return;
      }
    }
    speakFrom(st.idx, st.offset);
  }

  function pause() {
    st.playing = false;
    st.gen++;
    clearTimers();
    st.offset = st.wordPos;
    if (synth) synth.cancel();
    if (!audioEl.paused) audioEl.pause();
    updatePlayBtn();
    releaseWakeLock();
    savePos();
  }

  function stopSpeech() {
    if (st.playing) pause();
    else if (synth && synth.speaking) synth.cancel();
  }

  function togglePlay() {
    if (st.playing) pause(); else play();
  }

  function speakFrom(i, offset = 0) {
    if (cloudActive()) { cloudSpeakFrom(i); return; }
    if (!audioEl.paused) audioEl.pause();
    clearTimers();
    const gen = ++st.gen;
    const S = doc.sentences;
    st.idx = clamp(i, 0, S.length - 1);
    st.offset = st.wordPos = offset;
    st.started = false;
    markCurrent();
    savePosSoon();

    const s = S[st.idx];
    const first = sayOf(s); // 読み上げ用に言い換えた文(e.g. → for example など)
    const startAt = spokenIndex(first.map, offset);
    let text = first.text.slice(startAt);
    if (!text.trim()) { onSentenceEnd(gen); return; }

    // 単語位置の通知(boundary)が使える声なら、同じ段落の続きの文もつなげて1回で読む。
    // 文ごとに区切って読むと、文の間に不自然な間が入るため。どの文を読んでいるかは通知の位置から求める
    const parts = [{ k: st.idx, at: 0, base: startAt, say: first }];
    if (st.boundaryOK === true && settings.repeat !== 'sentence' && !settings.gap) {
      for (let k = st.idx + 1; k < S.length && S[k].para === s.para && (settings.repeat !== 'page' || S[k].page === s.page); k++) {
        const say = sayOf(S[k]);
        if (text.length + say.text.length >= MAX_UTTERANCE) break;
        parts.push({ k, at: text.length + 1, base: 0, say });
        text += ' ' + say.text;
      }
    }
    let sawBoundary = false;

    const u = new SpeechSynthesisUtterance(text);
    applyVoice(u);
    u.rate = settings.rate;
    u.pitch = settings.pitch;
    u.onstart = () => {
      if (gen !== st.gen) return;
      st.started = true;
      st.retries = 0;
      st.uttStart = performance.now();
    };
    u.onboundary = (e) => {
      if (gen !== st.gen || (e.name && e.name !== 'word')) return;
      sawBoundary = true;
      st.boundaryOK = true;
      let p = parts.length - 1;
      while (p > 0 && parts[p].at > e.charIndex) p--;
      if (parts[p].k !== st.idx) {
        enterSentence(parts[p].k);
        if (gen !== st.gen) return; // スリープタイマーで止まった
      }
      // 通知は読み上げ用の文での位置なので、画面の文での位置に直す
      const part = parts[p];
      const sp = clamp(part.base + (e.charIndex - part.at), 0, part.say.text.length);
      const pos = part.say.map[sp];
      const end = e.charLength ? part.say.map[Math.min(part.say.text.length, sp + e.charLength)] : 0;
      st.wordPos = pos;
      markWord(pos, end > pos ? end - pos : 0);
    };
    u.onend = () => {
      if (gen !== st.gen) return;
      st.errors = 0;
      // 3語以上読んで一度も通知がなければ、この声は単語位置の通知に対応していない
      if (st.boundaryOK === null && !sawBoundary && text.trim().split(/\s+/).length >= 3) st.boundaryOK = false;
      st.idx = parts[parts.length - 1].k;
      onSentenceEnd(gen);
    };
    u.onerror = (e) => {
      if (gen !== st.gen || e.error === 'interrupted' || e.error === 'canceled') return;
      console.warn('speech error', e.error);
      if (++st.errors > 3) { pause(); toast('読み上げでエラーが続いたため停止しました'); return; }
      onSentenceEnd(gen);
    };
    st.utter = u; // 参照を保持しないとChromeでonendが来なくなることがある

    if (synth.speaking || synth.pending) {
      synth.cancel();
      // Safariは中断の直後に読ませると開始・終了の通知が来ないことがあるので、少し待ってから読む
      st.speakTimer = setTimeout(() => { if (gen === st.gen) startUtterance(u, gen); }, 150);
    } else {
      startUtterance(u, gen); // iOSでは最初の発話をタップ操作の中で同期的に始める必要がある
    }
  }

  function startUtterance(u, gen) {
    if (synth.paused) synth.resume();
    synth.speak(u);
    st.watchdog = setTimeout(() => {
      if (gen !== st.gen || st.started || !st.playing) return;
      if (st.retries++ < 2) speakFrom(st.idx, st.offset);
      else { pause(); toast('音声を再生できませんでした。もう一度再生ボタンを押してください'); }
    }, 4000);
  }

  // 段落をまとめて読んでいる途中で、次の文に入ったとき
  function enterSentence(k) {
    st.idx = k;
    st.offset = st.wordPos = 0;
    st.uttStart = performance.now();
    markCurrent();
    savePosSoon();
    if (st.sleepPending) finishSleep();
  }

  function onSentenceEnd(gen) {
    if (gen !== st.gen || !st.playing) return;
    if (st.sleepPending) { finishSleep(); return; }
    const S = doc.sentences;
    let next = st.idx;
    let delay = settings.gap * 1000;
    if (settings.repeat === 'sentence') {
      delay = Math.max(delay, 400);
    } else {
      next = st.idx + 1;
      if (settings.repeat === 'page' && (next >= S.length || S[next].page !== S[st.idx].page)) {
        // ページの終わりまで来たら、同じページの最初に戻る
        next = firstOfPage(st.idx);
        delay = Math.max(delay, 800);
      } else if (next >= S.length) {
        pause();
        st.offset = st.wordPos = 0;
        toast('最後まで読み終わりました');
        return;
      } else {
        delay = Math.max(delay, naturalPause(st.idx, next));
      }
    }
    st.idx = next;
    st.offset = st.wordPos = 0;
    if (delay > 0) {
      markCurrent();
      st.gapTimer = setTimeout(() => { if (gen === st.gen && st.playing) speakFrom(next, 0); }, delay);
    } else {
      speakFrom(next, 0);
    }
  }

  function jumpTo(i, offset = 0) {
    if (!doc || !doc.sentences.length) return;
    i = clamp(i, 0, doc.sentences.length - 1);
    st.userScrollAt = 0;
    st.pdfFollow = true;
    if (st.playing) {
      speakFrom(i, offset);
    } else {
      st.idx = i;
      st.offset = st.wordPos = offset;
      markCurrent();
      savePosSoon();
    }
  }

  // 速度や声を変えたら、いま読んでいる単語から読み直す
  let restartTimer = 0;
  function restartSoon() {
    clearTimeout(restartTimer);
    // クラウドの声は速度を再生速度で変えるだけでよい(作り直さないので使用量も増えない)。
    // リピートや文間の無音は、次の文の区切りで反映される
    if (cloudActive()) { audioEl.playbackRate = settings.rate; scheduleBoundary(); return; }
    if (!st.playing) return;
    restartTimer = setTimeout(() => { if (st.playing) speakFrom(st.idx, st.wordPos); }, 250);
  }

  const durOf = (i) => doc.sentences[i].text.length / (CPS * settings.rate) + 0.25;
  function elapsedInCurrent() {
    if (cloudActive() && cloudLoaded()) return Math.max(0, audioEl.currentTime - st.chunk.bounds[st.idx - st.chunk.k0]) / settings.rate;
    let t = st.offset / (CPS * settings.rate);
    if (st.playing && st.started) t += (performance.now() - st.uttStart) / 1000;
    return Math.min(t, durOf(st.idx));
  }

  function skipSeconds(sec) {
    if (!doc || !doc.sentences.length) return;
    // クラウドの声で、移動先がいまの段落の音声の中なら、その中で正確に移動する
    if (cloudActive() && cloudLoaded() && audioEl.duration) {
      const target = audioEl.currentTime + sec * settings.rate;
      if (target >= 0 && target < audioEl.duration - 0.2) { audioEl.currentTime = target; cloudSyncIdx(); return; }
      if (target >= audioEl.duration - 0.2) { jumpTo(st.chunk.k1 + 1); return; }
    }
    const n = doc.sentences.length;
    let i = st.idx;
    if (sec < 0) {
      let acc = elapsedInCurrent();
      while (acc < -sec && i > 0) { i--; acc += durOf(i); }
    } else {
      let acc = durOf(i) - elapsedInCurrent();
      i++;
      while (acc < sec && i < n - 1) { acc += durOf(i); i++; }
      if (i > n - 1) i = n - 1;
    }
    jumpTo(i);
  }

  function prevSentence() {
    if (!doc) return;
    if (elapsedInCurrent() > 2.5) jumpTo(st.idx);
    else jumpTo(st.idx - 1);
  }
  function nextSentence() {
    if (!doc) return;
    jumpTo(st.idx + 1);
  }

  function updatePlayBtn() {
    const b = $('#playBtn');
    b.classList.toggle('playing', st.playing);
    b.setAttribute('aria-label', st.playing ? '一時停止' : '再生');
    if ('mediaSession' in navigator) {
      try { navigator.mediaSession.playbackState = st.playing ? 'playing' : 'paused'; } catch { /* noop */ }
    }
  }

  // ---------------------------------------------------------------- cloud voice (Google Cloud Text-to-Speech)
  const CLOUD_FREE = 1000000; // Chirp 3: HD の毎月の無料枠(文字数。空白や改行も数える)
  const CLOUD_PRICE_PER_M = 30; // 無料枠を超えたときの100万文字あたりの料金(米ドル)
  const TTS_API = 'https://texttospeech.googleapis.com/v1/';
  const audioEl = new Audio();
  audioEl.preload = 'auto';
  const audioUrls = new Map(); // 保存キー → objectURL(起動中だけ)
  const audioPending = new Map();
  let cloudVoices = store.get('cloudVoices', null);
  // APIキーはメモリにだけ持つ(localStorageなどには書かない)。ページを閉じると消える
  let cloudKey = '';
  let keyNagged = false;

  const cloudActive = () => settings.engine === 'cloud' && !!cloudKey && !st.cloudError && !limitReached();

  // 次の文が上限に収まらなかったら、その月は(上限を変えるまで)上限に達したものとして扱う
  function limitReached() {
    if (usageThisMonth() >= settings.cloudLimit) return true;
    const hit = store.get('limitHit', null);
    return !!hit && hit.month === monthKey() && hit.limit === settings.cloudLimit;
  }
  const cloudVoiceShort = (name) => name.replace(/^.*-Chirp3-HD-/, '');
  const cloudLang = (name) => (name.match(/^[a-z]{2}-[A-Z]{2}/) || ['en-US'])[0];

  // Googleの請求月は米国太平洋時間で区切られる
  function monthKey() {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit' }).formatToParts(new Date());
    const get = (type) => parts.find((p) => p.type === type).value;
    return `${get('year')}-${get('month')}`;
  }
  const usageThisMonth = () => store.get('usage:' + monthKey(), 0);

  function addUsage(chars) {
    const before = usageThisMonth();
    const after = before + chars;
    store.set('usage:' + monthKey(), after);
    for (const r of [0.5, 0.8, 0.9]) {
      if (before < CLOUD_FREE * r && after >= CLOUD_FREE * r) toast(`クラウドの声:今月の無料枠の${r * 100}%を使いました`);
    }
    renderUsage();
  }

  async function ttsFetch(path, body) {
    let res;
    try {
      res = await fetch(TTS_API + path, {
        method: body ? 'POST' : 'GET',
        headers: Object.assign({ 'X-Goog-Api-Key': cloudKey }, body ? { 'Content-Type': 'application/json' } : {}),
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      const err = new Error('network');
      err.code = 'network';
      throw err;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error((data.error && data.error.message) || 'HTTP ' + res.status);
      err.code = res.status;
      err.reason = (data.error && data.error.details && data.error.details[0] && data.error.details[0].reason) || '';
      throw err;
    }
    return data;
  }

  async function synthesize(text, voiceName) {
    if (usageThisMonth() + text.length > settings.cloudLimit) {
      const err = new Error('limit');
      err.code = 'limit';
      throw err;
    }
    const data = await ttsFetch('text:synthesize', {
      input: { text },
      voice: { languageCode: cloudLang(voiceName), name: voiceName },
      audioConfig: { audioEncoding: 'MP3' },
    });
    addUsage(text.length);
    const bin = atob(data.audioContent);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: 'audio/mpeg' });
  }

  // 一度作った音声は端末に保存して使い回す(読み直しや巻き戻しで使用量が増えないように)
  function getAudioUrl(text, voiceName = settings.cloudVoice) {
    const key = voiceName + '|' + text;
    if (audioUrls.has(key)) return Promise.resolve(audioUrls.get(key));
    if (audioPending.has(key)) return audioPending.get(key);
    const p = (async () => {
      let blob = await library.audioGet(key).catch(() => null);
      if (!blob) {
        blob = await synthesize(text, voiceName);
        library.audioPut(key, blob).catch(() => {});
      }
      const url = URL.createObjectURL(blob);
      audioUrls.set(key, url);
      if (audioUrls.size > 80) {
        const [oldKey, oldUrl] = audioUrls.entries().next().value;
        if (audioEl.src !== oldUrl) URL.revokeObjectURL(oldUrl);
        audioUrls.delete(oldKey);
      }
      return url;
    })().finally(() => audioPending.delete(key));
    audioPending.set(key, p);
    return p;
  }

  // 無音の短いWAV。最初のタップで再生して、iOSで音声要素を使えるようにする
  function silentWavUrl() {
    const n = 800;
    const buf = new ArrayBuffer(44 + n);
    const v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + n, true); str(8, 'WAVE'); str(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
    str(36, 'data'); v.setUint32(40, n, true);
    for (let i = 0; i < n; i++) v.setUint8(44 + i, 128);
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  }
  function unlockAudio() {
    if (st.unlock) return;
    audioEl.src = silentWavUrl();
    st.unlock = audioEl.play().catch(() => {});
  }

  // ---- 段落単位の音声
  // 1文ずつ音声を作ると、文ごとに抑揚がリセットされて、つながりが不自然になる。
  // そこで段落を(長ければ文の区切りで)まとめて1つの音声にし、音声の中の無音の位置から
  // 文の区切りの時刻を求めて、ハイライトや文単位の移動に使う
  const CHUNK_CHARS = 900; // 1つの音声にまとめる目安の文字数(1分ほど)
  const chunkMemo = new Map(); // 保存キー → { url, bounds }
  const chunkPending = new Map();

  // i番目の文を含むまとまり。区切りは文書だけで決まるので、どこから読み始めても同じ音声を使い回せる
  function chunkRange(i) {
    const S = doc.sentences;
    const p = S[i].para;
    const ps = doc.paraStarts[p];
    const pe = (p + 1 < doc.paraStarts.length ? doc.paraStarts[p + 1] : S.length) - 1;
    let k0 = ps;
    let len = 0;
    for (let k = ps; k <= pe; k++) {
      const n = sayOf(S[k]).text.length + 1;
      if (k > k0 && len + n > CHUNK_CHARS) {
        if (i < k) return { k0, k1: k - 1 };
        k0 = k;
        len = 0;
      }
      len += n;
    }
    return { k0, k1: pe };
  }

  async function getChunk(i, voice = settings.cloudVoice) {
    const { k0, k1 } = chunkRange(i);
    const says = [];
    for (let k = k0; k <= k1; k++) says.push(sayOf(doc.sentences[k]).text);
    const text = says.join(' ');
    const key = voice + '|' + text;
    let memo = chunkMemo.get(key);
    if (!memo) {
      if (!chunkPending.has(key)) {
        const p = (async () => {
          let blob = await library.audioGet(key).catch(() => null);
          if (!blob) {
            blob = await synthesize(text, voice);
            library.audioPut(key, blob).catch(() => {});
          }
          const m = { url: URL.createObjectURL(blob), bounds: await sentenceBounds(blob, says) };
          chunkMemo.set(key, m);
          if (chunkMemo.size > 40) {
            const [oldKey, old] = chunkMemo.entries().next().value;
            if (audioEl.src !== old.url) URL.revokeObjectURL(old.url);
            chunkMemo.delete(oldKey);
          }
          return m;
        })().finally(() => chunkPending.delete(key));
        chunkPending.set(key, p);
      }
      memo = await chunkPending.get(key);
    }
    return { k0, k1, key, voice, says, url: memo.url, bounds: memo.bounds, memo };
  }

  // 文字数の比率だけで見積もった区切り(音声を解析できなかったとき)
  function proportionalBounds(duration, says) {
    const total = says.reduce((a, t) => a + t.length + 1, 0);
    const bounds = [0];
    let acc = 0;
    for (let j = 1; j < says.length; j++) {
      acc += says[j - 1].length + 1;
      bounds.push(duration * acc / total);
    }
    bounds.push(duration);
    return bounds;
  }

  // 音声の音量を10msごとに調べて無音の区間を探し、文字数の比率で見積もった位置の近くにある
  // いちばん長い無音を文の区切りとする。bounds[j] = j番目の文の始まりの時刻、最後は音声の長さ
  async function sentenceBounds(blob, says) {
    let data;
    try {
      const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      const ctx = new Ctx(1, 1, 16000);
      const buf = await blob.arrayBuffer();
      data = await new Promise((resolve, reject) => {
        const p = ctx.decodeAudioData(buf, resolve, reject);
        if (p && p.then) p.then(resolve, reject);
      });
    } catch {
      return null;
    }
    const duration = data.duration;
    if (says.length < 2) return [0, duration];
    const pcm = data.getChannelData(0);
    const hop = Math.max(1, Math.round(data.sampleRate * 0.01));
    const n = Math.floor(pcm.length / hop);
    const env = new Float32Array(n);
    let peak = 0;
    for (let f = 0; f < n; f++) {
      let sum = 0;
      for (let k = f * hop, e = k + hop; k < e; k++) sum += pcm[k] * pcm[k];
      env[f] = Math.sqrt(sum / hop);
      if (env[f] > peak) peak = env[f];
    }
    if (!peak) return proportionalBounds(duration, says);
    const th = peak * 0.06;
    let first = 0;
    while (first < n && env[first] < th) first++;
    let last = n - 1;
    while (last > first && env[last] < th) last--;
    const gaps = [];
    let s0 = -1;
    for (let f = first; f <= last; f++) {
      if (env[f] < th) { if (s0 < 0) s0 = f; }
      else if (s0 >= 0) {
        if (f - s0 >= 8) gaps.push({ mid: (s0 + f) / 200, len: (f - s0) / 100 });
        s0 = -1;
      }
    }
    const t0 = first / 100;
    const t1 = (last + 1) / 100;
    const total = says.reduce((a, t) => a + t.length + 1, 0);
    const bounds = [0];
    let acc = 0;
    let prev = t0;
    for (let j = 1; j < says.length; j++) {
      acc += says[j - 1].length + 1;
      const est = t0 + (t1 - t0) * acc / total;
      const win = Math.max(0.8, (t1 - t0) * 0.12);
      let best = null;
      let score = -Infinity;
      for (const g of gaps) {
        if (g.mid <= prev + 0.25 || Math.abs(g.mid - est) > win) continue;
        const sc = g.len * 2 - Math.abs(g.mid - est); // 長い無音(文末の間)を優先する
        if (sc > score) { score = sc; best = g; }
      }
      const b = best ? best.mid : Math.max(est, prev + 0.25);
      bounds.push(b);
      prev = b;
    }
    bounds.push(duration);
    return bounds;
  }

  const boundsIndex = (bounds, t) => {
    let j = bounds.length - 2;
    while (j > 0 && bounds[j] > t + 0.02) j--;
    return j;
  };
  // いまの文を含む音声が読み込まれているか
  const cloudLoaded = () => {
    const c = st.chunk;
    return !!c && !!c.bounds && audioEl.src === c.url && c.voice === settings.cloudVoice && st.idx >= c.k0 && st.idx <= c.k1;
  };
  function cloudCanResume() {
    return cloudLoaded() && audioEl.currentTime > 0 && !audioEl.ended && st.chunk.k0 + boundsIndex(st.chunk.bounds, audioEl.currentTime) === st.idx;
  }

  function waitForEvent(name, ms) {
    return new Promise((resolve) => {
      const done = () => { clearTimeout(t); audioEl.removeEventListener(name, done); audioEl.removeEventListener('error', done); resolve(); };
      const t = setTimeout(done, ms);
      audioEl.addEventListener(name, done);
      audioEl.addEventListener('error', done);
    });
  }

  async function cloudSpeakFrom(i) {
    clearTimers();
    const gen = ++st.gen;
    const S = doc.sentences;
    st.idx = clamp(i, 0, S.length - 1);
    st.offset = st.wordPos = 0;
    st.started = false;
    markCurrent();
    savePosSoon();
    if (synth && (synth.speaking || synth.pending)) synth.cancel();
    const idx = st.idx;
    let c = st.chunk;
    const reuse = cloudLoaded();
    if (!reuse) {
      try {
        c = await getChunk(idx);
        if (st.unlock) await st.unlock;
      } catch (e) {
        if (gen === st.gen) cloudFailed(e, idx);
        return;
      }
      if (gen !== st.gen || !st.playing) return;
      st.chunk = c;
      audioEl.src = c.url;
    }
    audioEl.defaultPlaybackRate = audioEl.playbackRate = settings.rate;
    let playing;
    if (reuse) {
      audioEl.currentTime = c.bounds[idx - c.k0];
      playing = audioEl.play();
    } else {
      // iPhoneは再生を始めるまで音声を読み込まないことがあるので、先に再生して長さが分かってから位置を合わせる
      const seek = idx > c.k0;
      if (seek) audioEl.muted = true;
      playing = audioEl.play();
      if (audioEl.readyState < 1) await waitForEvent('loadedmetadata', 8000);
      if (gen !== st.gen) { audioEl.muted = false; return; }
      if (!c.memo.bounds) c.memo.bounds = proportionalBounds(audioEl.duration || 0, c.says);
      c.bounds = c.memo.bounds;
      if (seek) {
        audioEl.currentTime = c.bounds[idx - c.k0];
        await waitForEvent('seeked', 1500);
        audioEl.muted = false;
      }
    }
    try {
      await playing;
    } catch (e) {
      audioEl.muted = false;
      if (gen !== st.gen) return;
      pause();
      toast('再生を始められませんでした。もう一度再生ボタンを押してください');
      return;
    }
    if (gen !== st.gen) return;
    st.started = true;
    st.uttStart = performance.now();
    scheduleBoundary();
    // 次のまとまりの音声を用意しておく(画面ロック中でも途切れにくくする)
    if (c.k1 + 1 < S.length) getChunk(c.k1 + 1).catch(() => {});
  }

  // 次の文の始まりの時刻にタイマーを掛けて、文の区切りを正確に扱う(timeupdateは0.25秒ごとと粗いので)
  function scheduleBoundary() {
    clearTimeout(st.boundaryTimer);
    st.boundaryTimer = 0;
    const c = st.chunk;
    if (!st.playing || audioEl.paused || !cloudLoaded()) return;
    const j = st.idx - c.k0;
    if (j + 1 >= c.bounds.length - 1) return; // 最後の文は 'ended' で扱う
    const ms = Math.max(0, (c.bounds[j + 1] - audioEl.currentTime) / (audioEl.playbackRate || 1) * 1000);
    st.boundaryTimer = setTimeout(cloudTick, ms + 15);
  }

  function cloudTick() {
    if (!st.playing || audioEl.paused || !cloudActive() || !cloudLoaded()) return;
    const c = st.chunk;
    const k = c.k0 + boundsIndex(c.bounds, audioEl.currentTime);
    if (k > st.idx) onCloudBoundary(st.idx, st.idx + 1);
    else if (k < st.idx) { st.idx = k; markCurrent(); scheduleBoundary(); }
    else scheduleBoundary();
  }

  // 再生位置を手で動かしたあと、いまの文を合わせる
  function cloudSyncIdx() {
    const c = st.chunk;
    const k = c.k0 + boundsIndex(c.bounds, audioEl.currentTime);
    if (k !== st.idx) { st.idx = k; markCurrent(); savePosSoon(); }
    scheduleBoundary();
  }

  // from番目の文を読み終えて、to番目に進むところ。リピート・ページのループ・文間の無音・スリープをここで扱う
  function onCloudBoundary(from, to) {
    const S = doc.sentences;
    if (st.sleepPending) {
      st.idx = Math.min(to, S.length - 1);
      markCurrent();
      finishSleep();
      return;
    }
    let target = to;
    let wait = settings.gap * 1000;
    if (settings.repeat === 'sentence') {
      target = from;
      wait = Math.max(wait, 400);
    } else if (settings.repeat === 'page' && (to >= S.length || S[to].page !== S[from].page)) {
      target = firstOfPage(from);
      wait = Math.max(wait, 800);
    } else if (to >= S.length) {
      pause();
      st.offset = 0;
      toast('最後まで読み終わりました');
      return;
    } else {
      wait = Math.max(wait, naturalPause(from, to));
    }
    const c = st.chunk;
    if (!wait && target === to && c && to <= c.k1 && !audioEl.paused) {
      // 同じ音声の中で、そのまま次の文へ
      st.idx = to;
      st.offset = 0;
      st.uttStart = performance.now();
      markCurrent();
      savePosSoon();
      scheduleBoundary();
      return;
    }
    audioEl.pause();
    if (wait) {
      st.idx = target;
      markCurrent();
      const gen = st.gen;
      st.gapTimer = setTimeout(() => { if (st.playing && gen === st.gen) cloudSpeakFrom(target); }, wait);
    } else {
      cloudSpeakFrom(target);
    }
  }

  audioEl.addEventListener('ended', () => {
    const c = st.chunk;
    if (!st.playing || !cloudActive() || !c || audioEl.src !== c.url) return;
    st.idx = Math.max(st.idx, c.k1);
    onCloudBoundary(c.k1, c.k1 + 1);
  });
  audioEl.addEventListener('timeupdate', cloudTick); // 画面ロック中などタイマーが遅れるときの予備
  audioEl.addEventListener('play', () => { audioEl.playbackRate = settings.rate; });

  function cloudErrorMessage(e) {
    if (e.code === 'network') return '通信できなかったので、端末の声に切り替えました';
    if (e.reason === 'API_KEY_INVALID') return 'APIキーが正しくないので、端末の声に切り替えました';
    if (e.code === 403 && /billing/i.test(e.message)) return 'Google Cloudで請求先アカウントの設定が必要です。端末の声に切り替えました';
    if (e.code === 403) return 'Text-to-Speech APIが有効でないか、キーの制限で拒否されました。端末の声に切り替えました';
    if (e.code === 429) return '利用回数の制限に達したので、端末の声に切り替えました';
    return 'クラウドの声でエラーが起きたので、端末の声に切り替えました';
  }

  // 上限に達したときやエラーのときは、端末の声でそのまま読み続ける
  function cloudFailed(e, idx) {
    console.warn('cloud voice', e);
    if (e.code === 'limit') {
      store.set('limitHit', { month: monthKey(), limit: settings.cloudLimit });
      toast('今月の上限に達したので、端末の声に切り替えました');
    } else {
      st.cloudError = true;
      st.cloudErrorMsg = cloudErrorMessage(e);
      toast(st.cloudErrorMsg);
    }
    updateVoiceLabel();
    renderUsage();
    if (st.playing) speakFrom(idx, 0);
  }

  async function loadCloudVoices() {
    const box = $('#cloudVoiceList');
    if (!cloudKey) { renderCloudVoices(); return; }
    box.innerHTML = '<p class="note">声の一覧を読み込んでいます…</p>';
    try {
      const data = await ttsFetch('voices');
      cloudVoices = (data.voices || [])
        .filter((v) => /-Chirp3-HD-/.test(v.name) && v.ssmlGender === 'FEMALE' && /^en-/.test(v.name))
        .map((v) => ({ name: v.name, lang: cloudLang(v.name) }));
      store.set('cloudVoices', cloudVoices);
      st.cloudError = false;
      renderCloudVoices();
      renderUsage();
      updateVoiceLabel();
    } catch (e) {
      box.innerHTML = `<p class="note warn">${esc(e.reason === 'API_KEY_INVALID' ? 'APIキーが正しくありません。' : e.code === 403 ? 'Text-to-Speech APIが有効になっていないか、キーの制限で拒否されました。' : e.code === 'network' ? '通信できませんでした。' : 'エラー: ' + e.message)}</p>`;
    }
  }

  function renderCloudVoices() {
    const box = $('#cloudVoiceList');
    if (!cloudKey) { box.innerHTML = '<p class="note">APIキーを入れると、声の一覧が出ます。</p>'; return; }
    const list = (cloudVoices && cloudVoices.length ? cloudVoices : ['Aoede', 'Kore', 'Leda', 'Zephyr'].map((n) => ({ name: `en-US-Chirp3-HD-${n}`, lang: 'en-US' })))
      .slice().sort((a, b) => (a.lang === 'en-US' ? 0 : 1) - (b.lang === 'en-US' ? 0 : 1) || a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
    box.innerHTML = '<div class="voice-group">女性の声(Chirp 3 HD)</div>' + list.map((v) => `
      <button type="button" class="voice" role="radio" aria-checked="${v.name === settings.cloudVoice}" data-cloud="${esc(v.name)}">
        <span class="voice-dot"></span>
        <span class="voice-body"><span class="voice-name">${esc(cloudVoiceShort(v.name))}</span><span class="voice-lang">${esc(langLabel(v.lang))}</span></span>
      </button>`).join('');
  }

  async function previewCloudVoice() {
    if (st.playing || !cloudActive()) return;
    unlockAudio();
    try {
      const url = await getAudioUrl('Hello! I will read your PDF aloud in this voice.');
      if (st.unlock) await st.unlock;
      if (st.playing) return;
      st.chunk = null;
      audioEl.src = url;
      audioEl.playbackRate = settings.rate;
      await audioEl.play();
    } catch (e) {
      if (e.code === 'limit') { store.set('limitHit', { month: monthKey(), limit: settings.cloudLimit }); renderUsage(); updateVoiceLabel(); toast('今月の上限に達しているので試聴できません'); }
      else toast(cloudErrorMessage(e).replace('、端末の声に切り替えました', ''));
    }
  }

  function renderUsage() {
    const used = usageThisMonth();
    const [y, m] = monthKey().split('-');
    $('#usageMonth').textContent = `${y}年${+m}月`;
    $('#usageUsed').textContent = used.toLocaleString('en-US');
    $('#usageFree').textContent = CLOUD_FREE.toLocaleString('en-US');
    $('#usageFill').style.width = Math.min(100, used / CLOUD_FREE * 100) + '%';
    $('#usageLimitMark').style.left = Math.min(100, settings.cloudLimit / CLOUD_FREE * 100) + '%';
    const left = Math.max(0, settings.cloudLimit - used);
    const hours = left / CPS / 3600;
    let note;
    if (limitReached()) note = `上限(${settings.cloudLimit.toLocaleString('en-US')}文字)に達したので、来月まで端末の声を使います。上限を上げると、また使えます。`;
    else note = `上限の${settings.cloudLimit.toLocaleString('en-US')}文字まで、あと${left.toLocaleString('en-US')}文字(速度1.0で約${hours < 1 ? Math.max(1, Math.round(hours * 60)) + '分' : hours.toFixed(1) + '時間'})。上限に達すると自動で端末の声に切り替わります。`;
    $('#usageNote').textContent = note;
    $('#usageWarn').hidden = settings.cloudLimit <= CLOUD_FREE;
    $('#cloudStatus').textContent = st.cloudError ? st.cloudErrorMsg || '' : '';
    $('#cloudStatus').hidden = !st.cloudError;
  }

  function applyEngine() {
    const cloud = settings.engine === 'cloud';
    $$('#engineSeg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.engine === settings.engine)));
    $('#devicePanel').hidden = cloud;
    $('#cloudPanel').hidden = !cloud;
    $('#cloudKey').value = cloudKey;
    $('#cloudLimit').value = settings.cloudLimit;
    if (cloud) { renderUsage(); renderCloudVoices(); }
    updateVoiceLabel();
  }

  // 声の切り替え。再生中なら今の文から新しい声で読み直す
  function switchEngine(engine) {
    if (settings.engine === engine) return;
    const wasPlaying = st.playing;
    if (wasPlaying) pause();
    settings.engine = engine;
    st.cloudError = false;
    st.chunk = null;
    saveSettings();
    applyEngine();
    if (engine === 'cloud' && cloudKey && !cloudVoices) loadCloudVoices();
    if (wasPlaying) play();
  }

  // ロック画面やイヤホンのボタンで操作できるようにする
  function setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const handlers = {
      play: () => play(), pause: () => pause(),
      previoustrack: () => prevSentence(), nexttrack: () => nextSentence(),
      seekbackward: () => skipSeconds(-10), seekforward: () => skipSeconds(10),
    };
    for (const [action, fn] of Object.entries(handlers)) {
      try { navigator.mediaSession.setActionHandler(action, fn); } catch { /* 未対応の操作 */ }
    }
  }
  function updateMediaMeta() {
    if (!('mediaSession' in navigator) || !doc || typeof MediaMetadata === 'undefined') return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: doc.name.replace(/\.pdf$/i, ''),
        artist: 'pdfReader',
        artwork: [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
      });
    } catch { /* noop */ }
  }

  // ---------------------------------------------------------------- position / bookmarks
  function savePos() {
    if (!doc || !doc.sentences.length) return;
    const s = doc.sentences[st.idx];
    store.set('pos:' + doc.id, { i: st.idx, n: doc.sentences.length, snip: s.text.slice(0, 50), t: Date.now() });
  }
  let saveTimer = 0;
  function savePosSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(savePos, 800);
  }

  const getMarks = () => (doc ? store.get('bm:' + doc.id, []) : []);
  function renderMarks() {
    const marks = getMarks();
    $('#markEmpty').hidden = marks.length > 0;
    $('#markList').innerHTML = marks.map((m, k) => `<li>
      <button type="button" class="res" data-mark="${k}">
        <span class="res-meta">p.${m.page + 1} · ${new Date(m.t).toLocaleDateString('ja-JP')}</span>
        <span class="res-text">${esc(m.snip)}</span>
      </button>
      <button type="button" class="res-del" data-unmark="${k}" aria-label="しおりを削除">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path class="stroke" d="M6 6l12 12M18 6 6 18"/></svg>
      </button>
    </li>`).join('');
  }
  function addMark() {
    if (!doc || !doc.sentences.length) return;
    const s = doc.sentences[st.idx];
    const marks = getMarks().filter((m) => m.snip !== s.text.slice(0, 80));
    marks.unshift({ i: st.idx, n: doc.sentences.length, page: s.page, snip: s.text.slice(0, 80), t: Date.now() });
    store.set('bm:' + doc.id, marks.slice(0, 100));
    renderMarks();
    toast('しおりを挟みました');
  }

  // ---------------------------------------------------------------- search
  function runSearch(q) {
    const out = $('#searchResults');
    q = q.trim();
    if (!doc || q.length < 2) { out.innerHTML = ''; return; }
    const ql = q.toLowerCase();
    const hits = [];
    for (let i = 0; i < doc.sentences.length && hits.length < 100; i++) {
      if (doc.sentences[i].text.toLowerCase().includes(ql)) hits.push(i);
    }
    if (!hits.length) { out.innerHTML = '<li><p class="empty">見つかりませんでした</p></li>'; return; }
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    out.innerHTML = hits.map((i) => {
      const s = doc.sentences[i];
      const pos = s.text.toLowerCase().indexOf(ql);
      let from = Math.max(0, pos - 40);
      if (from > 0) from = s.text.indexOf(' ', from) + 1 || from; // 単語の途中から始めない
      const snip = (from > 0 ? '…' : '') + s.text.slice(from, from + 160);
      return `<li><button type="button" class="res" data-goto="${i}">
        <span class="res-meta">p.${s.page + 1}</span>
        <span class="res-text">${esc(snip).replace(re, (m) => `<mark>${m}</mark>`)}</span>
      </button></li>`;
    }).join('') + (hits.length >= 100 ? '<li><p class="note">最初の100件を表示しています</p></li>' : '');
  }

  // ---------------------------------------------------------------- translation
  // 非公式のGoogle翻訳エンドポイント(キー不要・CORS可)。訳を表示する文だけを送る
  const TRANSLATE_URL = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ja&dt=t&q=';
  const transCache = new Map(); // 英文 → 訳文
  const transPending = new Map(); // 英文 → Promise

  async function requestTranslation(texts) {
    const res = await fetch(TRANSLATE_URL + encodeURIComponent(texts.join('\n')));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const out = data[0].map((seg) => seg[0] || '').join('').replace(/[​-‍﻿]/g, '');
    return out.split('\n').map((s) => s.trim());
  }

  // i番目から先の未翻訳の文を最大8文まとめて1回のリクエストで訳す(1行1文で送り、行で分け直す)
  function translateFrom(i) {
    const S = doc.sentences;
    const batch = [];
    let chars = 0;
    for (let k = i; k < S.length && batch.length < 8; k++) {
      const t = S[k].text;
      if (transCache.has(t) || transPending.has(t) || batch.includes(t)) continue;
      if (batch.length && chars + t.length > 1400) break;
      batch.push(t);
      chars += t.length;
    }
    if (!batch.length) return null;
    const p = requestTranslation(batch).then(async (parts) => {
      if (parts.length === batch.length) {
        batch.forEach((t, k) => transCache.set(t, parts[k]));
      } else {
        for (const t of batch) transCache.set(t, (await requestTranslation([t])).join(' '));
      }
    }).finally(() => batch.forEach((t) => transPending.delete(t)));
    batch.forEach((t) => transPending.set(t, p));
    p.catch(() => {});
    return p;
  }

  function showTranslation() {
    const panel = $('#transPanel');
    panel.hidden = !settings.translate || !doc || !doc.sentences.length;
    if (panel.hidden) return;
    const i = st.idx;
    const S = doc.sentences;
    const box = $('#transText');
    const t = S[i].text;
    if (transCache.has(t)) {
      box.textContent = transCache.get(t);
      box.classList.remove('muted');
      const next = S[i + 1];
      if (next && !transCache.has(next.text) && !transPending.has(next.text)) translateFrom(i + 1);
      return;
    }
    box.textContent = '訳しています…';
    box.classList.add('muted');
    const p = transPending.get(t) || translateFrom(i);
    if (!p) return;
    p.then(() => { if (st.idx === i) showTranslation(); }).catch(() => {
      if (st.idx !== i) return;
      box.innerHTML = '訳を取得できませんでした。通信状態を確認してください。<button type="button" class="link-btn" data-retry>もう一度</button>';
    });
  }

  function applyTranslate() {
    $('#transBtn').setAttribute('aria-pressed', String(!!settings.translate));
    showTranslation();
  }

  function toggleTranslate() {
    settings.translate = !settings.translate;
    saveSettings();
    applyTranslate();
    if (settings.translate && !store.get('transNoticed', false)) {
      store.set('transNoticed', true);
      toast('訳はGoogle翻訳で作ります。表示する文と、その先の数文だけが送信されます');
    }
  }

  // ---------------------------------------------------------------- sleep timer / wake lock
  function setSleep(min) {
    clearTimeout(st.sleepTimer);
    clearInterval(st.sleepTick);
    st.sleepPending = false;
    st.sleepAt = min ? Date.now() + min * 60000 : 0;
    st.sleepMin = min;
    if (min) {
      st.sleepTimer = setTimeout(() => {
        if (st.playing) st.sleepPending = true; // 文の終わりで止める
        else finishSleep();
      }, min * 60000);
      st.sleepTick = setInterval(updateSleepUI, 15000);
      toast(`${min}分後に停止します`);
    }
    updateSleepUI();
  }
  function finishSleep() {
    st.sleepPending = false;
    st.sleepAt = 0;
    clearInterval(st.sleepTick);
    if (st.playing) pause();
    updateSleepUI();
  }
  function updateSleepUI() {
    const left = st.sleepAt ? Math.max(0, Math.ceil((st.sleepAt - Date.now()) / 60000)) : 0;
    const badge = $('#sleepBadge');
    badge.hidden = !st.sleepAt;
    badge.textContent = st.sleepAt ? `スリープまで ${left}分` : '';
    $('#sleepStatus').textContent = st.sleepAt ? `あと約${left}分で、文の区切りで停止します。` : '';
    $$('#sleepPresets button').forEach((b) => {
      b.setAttribute('aria-pressed', String(+b.dataset.min === (st.sleepAt ? st.sleepMin : 0)));
    });
  }

  async function acquireWakeLock() {
    if (!settings.wakeLock || !('wakeLock' in navigator) || wakeLock || document.hidden) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch { wakeLock = null; }
  }
  function releaseWakeLock() {
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  }

  // ---------------------------------------------------------------- sheets / toast / loading
  function openSheet(id) {
    closeSheets();
    $('#backdrop').hidden = false;
    const sh = $('#' + id);
    sh.hidden = false;
    sh.scrollTop = 0;
  }
  function closeSheets() {
    $('#backdrop').hidden = true;
    $$('.sheet').forEach((s) => { s.hidden = true; });
  }
  function selectTab(name) {
    $$('#menuSheet [role="tab"]').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
    $$('#menuSheet .tab-panel').forEach((p) => { p.hidden = p.dataset.panel !== name; });
    if (name === 'marks') renderMarks();
  }

  let toastTimer = 0;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2800);
  }
  function showLoading(msg, frac) {
    $('#loading').hidden = false;
    $('#loadMsg').textContent = msg;
    $('#loadBar').style.width = Math.round(frac * 100) + '%';
  }
  const hideLoading = () => { $('#loading').hidden = true; };

  // ---------------------------------------------------------------- settings UI
  function applyTheme() {
    if (settings.theme === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', settings.theme);
    $$('#themeSeg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.themeOpt === settings.theme)));
  }
  function applyFont() {
    document.documentElement.style.setProperty('--read-size', settings.fontSize + 'px');
    $('#fontValue').textContent = settings.fontSize;
    $('#textView').classList.toggle('sans', settings.font === 'sans');
    $$('#fontSeg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.font === settings.font)));
  }
  function setRangeFill(input) {
    const pct = (input.value - input.min) / (input.max - input.min) * 100;
    input.style.setProperty('--pct', pct + '%');
  }
  function applyRate() {
    const r = +settings.rate;
    $('#speedLabel').textContent = (Math.abs(r * 10 - Math.round(r * 10)) < 1e-6 ? r.toFixed(1) : r.toFixed(2)) + '×';
    $('#rateValue').textContent = (+settings.rate).toFixed(2);
    $('#rateRange').value = settings.rate;
    setRangeFill($('#rateRange'));
    $$('#ratePresets button').forEach((b) => b.setAttribute('aria-pressed', String(Math.abs(+b.dataset.rate - settings.rate) < 0.001)));
    if (doc) updateProgress();
  }
  function applyGap() {
    $('#gapRange').value = settings.gap;
    $('#gapValue').textContent = settings.gap ? `${settings.gap}秒` : 'なし';
    setRangeFill($('#gapRange'));
  }
  function applyPitch() {
    $('#pitchRange').value = settings.pitch;
    $('#pitchValue').textContent = (+settings.pitch).toFixed(2);
    setRangeFill($('#pitchRange'));
  }
  const REPEAT_LABEL = { sentence: '1文', page: 'ページ' };
  function applyRepeat() {
    const chip = $('#repeatChip');
    chip.setAttribute('aria-pressed', String(!!settings.repeat));
    chip.dataset.mode = settings.repeat || 'off';
    chip.setAttribute('aria-label', `リピート: ${settings.repeat ? REPEAT_LABEL[settings.repeat] : 'オフ'}`);
    $('#repeatLabel').textContent = settings.repeat ? REPEAT_LABEL[settings.repeat] : '';
  }
  function applySwitches() {
    $('#optWord').checked = settings.wordHL;
    $('#optHeaders').checked = settings.skipHeaders;
    $('#optCites').checked = settings.skipCites;
    $('#optMath').checked = settings.skipMath;
    $('#optWake').checked = settings.wakeLock;
  }

  // ---------------------------------------------------------------- events
  function bind() {
    $('#fileInput').addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!f) return;
      if (f.type && f.type !== 'application/pdf' && !/\.pdf$/i.test(f.name)) { toast('PDFファイルを選んでください'); return; }
      try {
        const buf = await f.arrayBuffer();
        await openBuffer(buf, f.name, f.size, { save: true });
      } catch (err) {
        hideLoading();
        console.error(err);
        toast('ファイルを読み込めませんでした');
      }
    });

    $('#libraryList').addEventListener('click', async (e) => {
      const open = e.target.closest('[data-open]');
      if (open) { openFromLibrary(open.dataset.open); return; }
      const del = e.target.closest('[data-del]');
      if (!del) return;
      if (!del.classList.contains('confirm')) {
        del.classList.add('confirm');
        del.textContent = '削除';
        setTimeout(() => { if (del.isConnected) refreshLibrary(); }, 3000);
        return;
      }
      const id = del.dataset.del;
      try { await library.remove(id); } catch { /* noop */ }
      store.del('pos:' + id);
      store.del('bm:' + id);
      refreshLibrary();
      toast('削除しました');
    });

    $('#backBtn').addEventListener('click', () => {
      if (history.state && history.state.reader) history.back();
      else closeDoc();
    });
    window.addEventListener('popstate', () => { if (doc) closeDoc(); });

    $('#transBtn').addEventListener('click', toggleTranslate);
    $('#transPanel').addEventListener('click', (e) => { if (e.target.closest('[data-retry]')) showTranslation(); });
    $('#modeText').addEventListener('click', () => { settings.view = 'text'; saveSettings(); applyView(); });
    $('#modePdf').addEventListener('click', () => { settings.view = 'pdf'; saveSettings(); applyView(); });

    $('#textView').addEventListener('click', (e) => {
      const mark = e.target.closest('[data-math-page]');
      if (mark) {
        // 読み飛ばした数式のページをPDF表示で開く
        settings.view = 'pdf';
        saveSettings();
        applyView();
        st.pdfFollow = false;
        renderPdfPage(+mark.dataset.mathPage);
        return;
      }
      const sp = e.target.closest('.s');
      if (!sp) return;
      const sel = window.getSelection && window.getSelection();
      if (sel && !sel.isCollapsed) return; // 単語を選択しているときは移動しない
      jumpTo(+sp.dataset.i);
    });
    $('#pdfPage').addEventListener('click', tapPdf);

    const stage = $('#stage');
    const markUser = () => { st.userScrollAt = performance.now(); };
    stage.addEventListener('touchmove', markUser, { passive: true });
    stage.addEventListener('wheel', markUser, { passive: true });
    let scrollRaf = 0;
    stage.addEventListener('scroll', () => {
      if (scrollRaf) return;
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = 0;
        if (userIsScrolling()) updateFollowBtn();
      });
    }, { passive: true });
    $('#followBtn').addEventListener('click', () => {
      st.userScrollAt = 0;
      st.pdfFollow = true;
      if (settings.view === 'text') followText(true);
      else {
        const s = doc.sentences[st.idx];
        if (s.page + 1 !== st.pdfPage) renderPdfPage(s.page + 1);
        else scrollPdfToHighlight();
      }
      $('#followBtn').hidden = true;
    });

    // PDFツールバー
    const gotoPdfPage = (n) => {
      st.pdfFollow = false;
      renderPdfPage(n).then(() => { stage.scrollTo({ top: 0 }); updateFollowBtn(); });
    };
    $('#pdfPrev').addEventListener('click', () => gotoPdfPage(st.pdfPage - 1));
    $('#pdfNext').addEventListener('click', () => gotoPdfPage(st.pdfPage + 1));
    $('#pdfPageInput').addEventListener('change', (e) => gotoPdfPage(+e.target.value));
    $('#pdfReadPage').addEventListener('click', () => readFromPage(st.pdfPage));
    $('#zoomIn').addEventListener('click', () => { st.zoom = clamp(st.zoom + 0.25, 1, 3); renderPdfPage(st.pdfPage); });
    $('#zoomOut').addEventListener('click', () => { st.zoom = clamp(st.zoom - 0.25, 1, 3); renderPdfPage(st.pdfPage); });
    let resizeTimer = 0;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { if (doc && settings.view === 'pdf') renderPdfPage(st.pdfPage); }, 200);
    });

    // プレイヤー
    $('#playBtn').addEventListener('click', togglePlay);
    $('#prevSent').addEventListener('click', prevSentence);
    $('#nextSent').addEventListener('click', nextSentence);
    $('#back10').addEventListener('click', () => skipSeconds(-10));
    $('#fwd10').addEventListener('click', () => skipSeconds(10));

    const seek = $('#seek');
    seek.addEventListener('input', () => {
      if (!doc || !doc.sentences.length) return;
      st.seeking = true;
      st.seekAt = performance.now();
      const s = doc.sentences[+seek.value];
      const pct = doc.sentences.length > 1 ? seek.value / (doc.sentences.length - 1) * 100 : 0;
      seek.style.setProperty('--pct', pct + '%');
      $('#posLabel').textContent = `p.${s.page + 1} / ${doc.numPages}`;
      $('#remainLabel').textContent = s.text.slice(0, 36) + (s.text.length > 36 ? '…' : '');
    });
    seek.addEventListener('change', () => {
      st.seeking = false;
      jumpTo(+seek.value);
    });

    $('#speedChip').addEventListener('click', () => openSheet('speedSheet'));
    $('#voiceChip').addEventListener('click', () => { renderVoiceList(); applyEngine(); openSheet('voiceSheet'); });
    $('#menuBtn').addEventListener('click', () => { openSheet('menuSheet'); updateSleepUI(); });
    // オフ → 1文 → ページ → オフ の順に切り替える
    $('#repeatChip').addEventListener('click', () => {
      settings.repeat = !settings.repeat ? 'sentence' : settings.repeat === 'sentence' ? 'page' : false;
      saveSettings();
      applyRepeat();
      restartSoon(); // 段落をまとめて読んでいる途中でも、いまの文から切り替える
      const s = doc && doc.sentences[st.idx];
      toast(settings.repeat === 'sentence' ? '同じ文をくり返します'
        : settings.repeat === 'page' ? `このページ${s ? `(p.${s.page + 1})` : ''}をくり返します` : 'リピートを解除しました');
    });

    $('#backdrop').addEventListener('click', closeSheets);
    $$('[data-close]').forEach((b) => b.addEventListener('click', closeSheets));

    // 速度シート
    $('#rateRange').addEventListener('input', (e) => {
      settings.rate = +e.target.value;
      saveSettings();
      applyRate();
      restartSoon();
    });
    $('#ratePresets').addEventListener('click', (e) => {
      const b = e.target.closest('[data-rate]');
      if (!b) return;
      settings.rate = +b.dataset.rate;
      saveSettings();
      applyRate();
      restartSoon();
    });
    $('#gapRange').addEventListener('input', (e) => {
      settings.gap = +e.target.value;
      saveSettings();
      applyGap();
      restartSoon();
    });

    // 声シート
    $('#pitchRange').addEventListener('input', (e) => {
      settings.pitch = +e.target.value;
      saveSettings();
      applyPitch();
      restartSoon();
    });
    $('#pitchRange').addEventListener('change', previewVoice);
    $('#voiceList').addEventListener('click', (e) => {
      const b = e.target.closest('[data-uri]');
      if (!b) return;
      settings.voiceURI = b.dataset.uri;
      saveSettings();
      renderVoiceList();
      onVoiceChanged();
      if (st.playing) restartSoon(); else previewVoice();
    });
    // 「iPhoneの設定の声」の英語の種類
    $('#voiceList').addEventListener('change', (e) => {
      if (e.target.id !== 'sysLang') return;
      settings.systemLang = e.target.value;
      saveSettings();
      renderVoiceList();
      onVoiceChanged();
      if (st.playing) restartSoon(); else previewVoice();
    });

    // クラウドの声
    $('#engineSeg').addEventListener('click', (e) => {
      const b = e.target.closest('[data-engine]');
      if (b) switchEngine(b.dataset.engine);
    });
    // フォームは見えないiframeに送信する(ページは移動しない)。ふつうのログインフォームと同じ形にして、
    // iPhoneのパスワード自動入力(iCloudキーチェーン)にキーを保存・入力できるようにするため
    $('#cloudKeyForm').addEventListener('submit', () => {
      cloudKey = $('#cloudKey').value.trim();
      st.cloudError = false;
      $('#cloudKey').blur();
      updateVoiceLabel();
      renderUsage();
      loadCloudVoices();
      toast(cloudKey ? 'APIキーを入れました(保存はせず、アプリを閉じると消えます)' : 'APIキーを消しました');
    });
    $('#cloudKeyClear').addEventListener('click', () => {
      cloudKey = '';
      $('#cloudKey').value = '';
      if (st.playing && settings.engine === 'cloud') { pause(); }
      updateVoiceLabel();
      renderUsage();
      renderCloudVoices();
      toast('APIキーを消しました');
    });
    $('#cloudKeyShow').addEventListener('click', () => {
      const input = $('#cloudKey');
      input.type = input.type === 'password' ? 'text' : 'password';
      $('#cloudKeyShow').textContent = input.type === 'password' ? '表示' : '隠す';
    });
    $('#cloudLimit').addEventListener('change', (e) => {
      settings.cloudLimit = clamp(Math.round(+e.target.value || 0), 0, CLOUD_FREE);
      e.target.value = settings.cloudLimit;
      saveSettings();
      renderUsage();
      updateVoiceLabel();
    });
    $('#cloudVoiceList').addEventListener('click', (e) => {
      const b = e.target.closest('[data-cloud]');
      if (!b) return;
      settings.cloudVoice = b.dataset.cloud;
      saveSettings();
      renderCloudVoices();
      updateVoiceLabel();
      if (st.playing && cloudActive()) cloudSpeakFrom(st.idx); else previewCloudVoice();
    });
    $('#cloudVoiceReload').addEventListener('click', loadCloudVoices);

    // メニューシート
    $$('#menuSheet [role="tab"]').forEach((t) => t.addEventListener('click', () => selectTab(t.dataset.tab)));
    $('#pageJumpForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const n = +$('#pageJumpInput').value;
      if (!doc || !n) return;
      readFromPage(clamp(n, 1, doc.numPages));
      closeSheets();
    });
    $('#searchForm').addEventListener('submit', (e) => {
      e.preventDefault();
      runSearch($('#searchInput').value);
      $('#searchInput').blur();
    });
    $('#searchResults').addEventListener('click', (e) => {
      const b = e.target.closest('[data-goto]');
      if (!b) return;
      jumpTo(+b.dataset.goto);
      closeSheets();
    });
    $('#addMark').addEventListener('click', addMark);
    $('#markList').addEventListener('click', (e) => {
      const go = e.target.closest('[data-mark]');
      const del = e.target.closest('[data-unmark]');
      const marks = getMarks();
      if (go) {
        const m = marks[+go.dataset.mark];
        if (m) { jumpTo(restoreIndex(m)); closeSheets(); }
      } else if (del) {
        marks.splice(+del.dataset.unmark, 1);
        store.set('bm:' + doc.id, marks);
        renderMarks();
      }
    });
    $('#sleepPresets').addEventListener('click', (e) => {
      const b = e.target.closest('[data-min]');
      if (b) setSleep(+b.dataset.min);
    });
    $('#fontDown').addEventListener('click', () => { settings.fontSize = clamp(settings.fontSize - 1, 14, 32); saveSettings(); applyFont(); });
    $('#fontUp').addEventListener('click', () => { settings.fontSize = clamp(settings.fontSize + 1, 14, 32); saveSettings(); applyFont(); });
    $('#fontSeg').addEventListener('click', (e) => {
      const b = e.target.closest('[data-font]');
      if (!b) return;
      settings.font = b.dataset.font;
      saveSettings();
      applyFont();
    });
    $('#themeSeg').addEventListener('click', (e) => {
      const b = e.target.closest('[data-theme-opt]');
      if (!b) return;
      settings.theme = b.dataset.themeOpt;
      saveSettings();
      applyTheme();
    });
    $('#optWord').addEventListener('change', (e) => {
      settings.wordHL = e.target.checked;
      saveSettings();
      markCurrent();
    });
    $('#optHeaders').addEventListener('change', (e) => { settings.skipHeaders = e.target.checked; saveSettings(); rebuild(); });
    $('#optCites').addEventListener('change', (e) => { settings.skipCites = e.target.checked; saveSettings(); rebuild(); });
    $('#optMath').addEventListener('change', (e) => { settings.skipMath = e.target.checked; saveSettings(); rebuild(); });
    $('#optWake').addEventListener('change', (e) => {
      settings.wakeLock = e.target.checked;
      saveSettings();
      if (settings.wakeLock && st.playing) acquireWakeLock(); else releaseWakeLock();
    });

    // キーボード(PCで使うとき)
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { closeSheets(); return; }
      if (!doc || $('#reader').hidden) return;
      if (e.target.closest('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
      if (!$('#backdrop').hidden) return;
      if (e.key === ' ') { e.preventDefault(); togglePlay(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); if (e.shiftKey) skipSeconds(-10); else prevSentence(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); if (e.shiftKey) skipSeconds(10); else nextSentence(); }
      else if (e.key === 't' || e.key === 'T') toggleTranslate();
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { savePos(); return; }
      if (st.playing) {
        acquireWakeLock();
        // バックグラウンドで止まっていたら、いまの文から再開する
        if (!cloudActive() && synth && !synth.speaking && !synth.pending && !st.gapTimer && !st.speakTimer) speakFrom(st.idx, st.wordPos);
      }
    });
    window.addEventListener('pagehide', savePos);
  }

  // ---------------------------------------------------------------- init
  function init() {
    applyTheme();
    applyFont();
    applyRate();
    applyGap();
    applyPitch();
    applyRepeat();
    applySwitches();
    applyTranslate();
    applyEngine();
    updateSleepUI();
    bind();
    setupMediaSession();
    if (synth) {
      loadVoices();
      if ('onvoiceschanged' in synth) synth.addEventListener('voiceschanged', loadVoices);
      // 一部のブラウザでは声の一覧が遅れて届く
      let tries = 0;
      const poll = setInterval(() => {
        if (voices.length || ++tries > 20) clearInterval(poll);
        loadVoices();
      }, 250);
    } else {
      $('#voiceLabel').textContent = '非対応';
    }
    if (history.state && history.state.reader) history.replaceState(null, '');
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    refreshLibrary();
  }

  init();
})();
