// 試玩版引擎：在瀏覽器（或 node）裡執行真正的後端程式 Code.gs，資料全部在記憶體，跟正式試算表完全無關
(function (root) {
  function makeEngine(src, T, files, logoBin) {
    files = files || {};
    const b64e = s => btoa(/[^\x00-\xff]/.test(s) ? unescape(encodeURIComponent(s)) : s), b64d = s => atob(s);
    const toBin = x => typeof x === 'string' ? x : Array.isArray(x) || x instanceof Uint8Array ? Array.from(x, c => String.fromCharCode(c & 255)).join('') : String(x);
    function sheet(n) {
      const v = T[n]; if (!v) return null;
      return {
        getDataRange: () => ({ getDisplayValues: () => v.map(r => v[0].map((_, i) => r[i] == null ? '' : String(r[i]))), getValues: () => v.map(r => v[0].map((_, i) => r[i] == null ? '' : r[i])) }),
        getRange: (r, c, nr, nc) => ({ getValues: () => [v[r - 1].slice(c - 1, c - 1 + (nc || 1))], setValue: x => { v[r - 1][c - 1] = x; }, setValues: rows => { rows.forEach((row, i) => row.forEach((x, j) => { (v[r - 1 + i] = v[r - 1 + i] || [])[c - 1 + j] = x; })); } }),
        getLastColumn: () => v[0].length, getLastRow: () => v.length, appendRow: row => v.push(row.slice()), deleteRow: r => v.splice(r - 1, 1)
      };
    }
    let uid = Date.now() % 100000;
    const G = {};
    G.SpreadsheetApp = { flush() { }, openById: () => ({ getSheetByName: sheet, insertSheet: n => { T[n] = [[]]; return sheet(n); } }) };
    G.Utilities = {
      sleep(ms) { const t = Date.now() + Math.min(ms, 1500); while (Date.now() < t) { } },
      getUuid: () => 'd' + (++uid).toString(16) + Math.random().toString(16).slice(2, 10) + 'xxxx',
      formatDate: (d, tz, p) => { const z = new Date(d.getTime() + 8 * 3600e3); const P = n => String(n).padStart(2, '0'); return p.replace('yyyy', z.getUTCFullYear()).replace('MM', P(z.getUTCMonth() + 1)).replace('dd', P(z.getUTCDate())).replace('HH', P(z.getUTCHours())).replace('mm', P(z.getUTCMinutes())).replace('ss', P(z.getUTCSeconds())).replace(/^u$/, String(z.getUTCDay() || 7)); },
      base64Encode: b => b64e(toBin(b)), base64Decode: s => b64d(s), base64DecodeWebSafe: s => b64d(String(s).replace(/-/g, '+').replace(/_/g, '/')),
      newBlob: (content, type, name) => { const blob = { content: toBin(content || ''), type: type || '', name: name || '', getDataAsString: () => blob.content, getAs: t => ({ content: blob.content, type: t, html: type === 'text/html' ? blob.content : '', setName(n) { this.name = n; return this; } }) }; return blob; }
    };
    let fid = 0;
    const mkFile = id => ({
      getId: () => id, getName: () => files[id].name, getUrl: () => 'https://demo.file/' + id,
      getBlob: () => ({ getBytes: () => files[id].content || '', getContentType: () => files[id].type || 'image/jpeg' }), getThumbnail: () => null,
      setTrashed: x => { files[id].trashed = x !== false; }, isTrashed: () => !!files[id].trashed, getParents: () => ({ next: () => folder('ROOT') })
    });
    const dirs = {};
    function folder(path) {
      return dirs[path] = dirs[path] || {
        getId: () => path, getUrl: () => 'https://demo.folder/' + encodeURIComponent(path),
        getFoldersByName: n => { const p = path + '/' + n; let done = false; return { hasNext: () => !done && !!dirs[p], next: () => { done = true; return dirs[p]; } }; },
        createFolder: n => folder(path + '/' + n),
        getFilesByName: n => { const ids = Object.keys(files).filter(k => files[k].dir === path && files[k].name === n && !files[k].trashed); let i = 0; return { hasNext: () => i < ids.length, next: () => mkFile(ids[i++]) }; },
        createFile: b => { const id = 'F' + Date.now().toString(36) + (++fid); files[id] = { name: b.name, type: b.type, content: b.content, html: b.html || '', dir: path }; return mkFile(id); }
      };
    }
    Object.keys(files).forEach(id => { if (files[id].dir) folder(files[id].dir); });
    G.DriveApp = {
      getFileById: id => files[id] ? mkFile(id) : { getParents: () => ({ next: () => folder('ROOT') }) },
      getFolderById: id => folder(decodeURIComponent(id))
    };
    G.LockService = { getScriptLock: () => ({ waitLock() { }, releaseLock() { } }) };
    const cache = {};
    G.CacheService = { getScriptCache: () => ({ get: k => (k in cache ? cache[k] : null), put: (k, v) => { cache[k] = String(v); }, remove: k => { delete cache[k]; } }) };
    G.UrlFetchApp = { fetch: u => ({ getContent: () => /logo\.png/.test(u) && logoBin ? logoBin : '', getContentText: () => '{}' }) };
    G.PropertiesService = { getScriptProperties: () => ({ getProperty: () => 's', setProperty() { } }) };
    G.Logger = { log() { } };
    G.HtmlService = {}; G.ContentService = { MimeType: {} }; G.MimeType = { PDF: 'application/pdf' };
    // 案件資料夾的網址在試玩版裡長得不一樣，讓 caseDir_ 找得到
    if (src.indexOf('const TEST_MODE = false;') < 0) throw new Error('後端找不到 TEST_MODE 設定');
    // 試玩版自己打開「切換身分」：只改試玩版這份副本，正式後端維持 false
    const code = src.replace("match(/folders\\/([\\w-]+)/)", "match(/demo\\.folder\\/([^?#]+)/)").replace('const TEST_MODE = false;', 'const TEST_MODE = true;');
    const m = {};
    new Function(...Object.keys(G), 'exp', code + ';exp.run_=run_;exp.reset=()=>{_people=null;try{_settings=null}catch(e){}try{for(const k in _dirs)delete _dirs[k]}catch(e){}};')(...Object.values(G), m);
    return { run: (who, action, payload) => { m.reset(); return m.run_(who, action, payload || {}); }, T, files };
  }
  if (typeof module !== 'undefined') module.exports = makeEngine; else root.makeEngine = makeEngine;
})(this);
