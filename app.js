'use strict';

(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const PDFJS_BASE = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/';
  pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_BASE + 'build/pdf.worker.min.js';

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
    fontSize: 19, font: 'serif', theme: 'auto', wordHL: true, translate: false,
    skipHeaders: true, skipCites: true, wakeLock: true, view: 'text',
  };
  const storedSettings = store.get('settings', {});
  // v1の初期値だった声の高さ1.05は、声が不自然になるので1.0に戻す
  if (!storedSettings.v && storedSettings.pitch === 1.05) storedSettings.pitch = 1;
  const settings = Object.assign({}, DEFAULTS, storedSettings, { v: DEFAULTS.v });
  const saveSettings = () => store.set('settings', settings);

  // 開いたPDFの本体はIndexedDBに置く(metaは一覧用、blobsは中身)
  const library = (() => {
    let dbp = null;
    function open() {
      if (!dbp) {
        dbp = new Promise((resolve, reject) => {
          try {
            const req = indexedDB.open('pdfreader', 1);
            req.onupgradeneeded = () => {
              req.result.createObjectStore('meta', { keyPath: 'id' });
              req.result.createObjectStore('blobs', { keyPath: 'id' });
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

    pages.forEach((p, pi) => {
      const lines = p.lines.filter((l) => !(opt.skipHeaders && l.margin));
      const gap = medianLineGap(lines);
      const widths = lines.map((l) => l.right - l.x).sort((a, b) => a - b);
      const medW = widths.length ? widths[widths.length >> 1] : 0;

      lines.forEach((line, li) => {
        if (T.length) {
          const prev = li > 0 ? lines[li - 1] : lastLine;
          const para = li === 0
            ? ENDS_SENTENCE.test(T) || sizeChange(prev, line)
            : isParaBreak(prev, line, gap, medW, T);
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
        .replace(/\bdoi:\s*\S+/gi, '');
    }
    return t.replace(/\s+/g, ' ').trim();
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
      }
      const heading = s1 - s0 === 1 && S[s0].text.length < 90 && !/[.!?:;,]["”’)]?$/.test(S[s0].text);
      parts.push(heading ? `<p class="h">${html}</p>` : `<p>${html}</p>`);
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

  function currentVoice() {
    if (!voices.length) return null;
    return voices.find((v) => v.voiceURI === settings.voiceURI) || voices[0];
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
    const v = currentVoice();
    $('#voiceLabel').textContent = v ? v.name.replace(/^(Microsoft|Google)\s+/, '').replace(/\s+Online.*$/, '') : '標準';
  }

  function renderVoiceList() {
    const cur = currentVoice();
    const groups = [
      ['おすすめ(女性の声)', voices.filter((v) => isFemale(v) && !ROBOTIC.test(v.name))],
      ['そのほかの英語の声', voices.filter((v) => !isFemale(v) || ROBOTIC.test(v.name))],
    ];
    let html = '';
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
    const v = currentVoice();
    const u = new SpeechSynthesisUtterance('Hello! I will read your PDF aloud at this speed.');
    if (v) { u.voice = v; u.lang = v.lang; }
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
    st.gapTimer = st.speakTimer = st.watchdog = 0;
  }

  function play() {
    if (!doc || !doc.sentences.length) return;
    if (!synth) { toast('このブラウザは音声読み上げに対応していません'); return; }
    st.playing = true;
    st.errors = 0;
    st.retries = 0;
    updatePlayBtn();
    acquireWakeLock();
    speakFrom(st.idx, st.offset);
  }

  function pause() {
    st.playing = false;
    st.gen++;
    clearTimers();
    st.offset = st.wordPos;
    if (synth) synth.cancel();
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
    clearTimers();
    const gen = ++st.gen;
    const S = doc.sentences;
    st.idx = clamp(i, 0, S.length - 1);
    st.offset = st.wordPos = offset;
    st.started = false;
    markCurrent();
    savePosSoon();

    const s = S[st.idx];
    let text = s.text.slice(offset);
    if (!text.trim()) { onSentenceEnd(gen); return; }

    // 単語位置の通知(boundary)が使える声なら、同じ段落の続きの文もつなげて1回で読む。
    // 文ごとに区切って読むと、文の間に不自然な間が入るため。どの文を読んでいるかは通知の位置から求める
    const parts = [{ k: st.idx, at: 0, base: offset }];
    if (st.boundaryOK === true && !settings.repeat && !settings.gap) {
      for (let k = st.idx + 1; k < S.length && S[k].para === s.para && text.length + S[k].text.length < MAX_UTTERANCE; k++) {
        parts.push({ k, at: text.length + 1, base: 0 });
        text += ' ' + S[k].text;
      }
    }
    let sawBoundary = false;

    const u = new SpeechSynthesisUtterance(text);
    const v = currentVoice();
    if (v) { u.voice = v; u.lang = v.lang; } else { u.lang = 'en-US'; }
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
      st.wordPos = parts[p].base + (e.charIndex - parts[p].at);
      markWord(st.wordPos, e.charLength);
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
      st.speakTimer = setTimeout(() => { if (gen === st.gen) startUtterance(u, gen); }, 80);
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
    let next = st.idx;
    if (!settings.repeat) {
      next = st.idx + 1;
      if (next >= doc.sentences.length) {
        pause();
        st.offset = st.wordPos = 0;
        toast('最後まで読み終わりました');
        return;
      }
    }
    st.idx = next;
    st.offset = st.wordPos = 0;
    let delay = settings.gap * 1000;
    if (settings.repeat) delay = Math.max(delay, 400);
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
    if (!st.playing) return;
    restartTimer = setTimeout(() => { if (st.playing) speakFrom(st.idx, st.wordPos); }, 250);
  }

  const durOf = (i) => doc.sentences[i].text.length / (CPS * settings.rate) + 0.25;
  function elapsedInCurrent() {
    let t = st.offset / (CPS * settings.rate);
    if (st.playing && st.started) t += (performance.now() - st.uttStart) / 1000;
    return Math.min(t, durOf(st.idx));
  }

  function skipSeconds(sec) {
    if (!doc || !doc.sentences.length) return;
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
  function applyRepeat() {
    $('#repeatChip').setAttribute('aria-pressed', String(!!settings.repeat));
  }
  function applySwitches() {
    $('#optWord').checked = settings.wordHL;
    $('#optHeaders').checked = settings.skipHeaders;
    $('#optCites').checked = settings.skipCites;
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
    $('#voiceChip').addEventListener('click', () => { renderVoiceList(); openSheet('voiceSheet'); });
    $('#menuBtn').addEventListener('click', () => { openSheet('menuSheet'); updateSleepUI(); });
    $('#repeatChip').addEventListener('click', () => {
      settings.repeat = !settings.repeat;
      saveSettings();
      applyRepeat();
      restartSoon(); // 段落をまとめて読んでいる途中でも、いまの文からリピートに切り替える
      toast(settings.repeat ? '同じ文をくり返します' : 'リピートを解除しました');
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
        if (synth && !synth.speaking && !synth.pending && !st.gapTimer && !st.speakTimer) speakFrom(st.idx, st.wordPos);
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
    updateSleepUI();
    bind();
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
