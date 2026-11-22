/**
 * 測試環境的「隔離層」：取代 SpreadsheetApp 與 DriveApp。
 *
 * 1. 權限縮小：只用 drive.file（只能碰這個專案自己建立的檔案）＋ Sheets／Drive API，
 *    Google 層級就看不到你雲端硬碟裡其他檔案，也打不開正式試算表。
 * 2. 程式層再擋一次：
 *    - 試算表只能開「建立測試環境時記下的那一份」。
 *    - 任何資料夾、檔案都必須在「測試根資料夾」底下（逐層往上查到根資料夾 ID），否則拒絕。
 *    - 案件資料夾網址只接受測試根資料夾底下的資料夾。
 */
const TEST_PROPS = PropertiesService.getScriptProperties();
function testRootId_() { const id = TEST_PROPS.getProperty('TEST_ROOT_ID'); if (!id) throw new Error('測試環境尚未建立（請先執行 setupTestEnv）'); return id; }
function testSsId_() { const id = TEST_PROPS.getProperty('TEST_SS_ID'); if (!id) throw new Error('測試環境尚未建立（請先執行 setupTestEnv）'); return id; }

/* ---------- 試算表（Sheets API） ---------- */
const TSheets = (function () {
  let cache = null;   // { 表名: 二維陣列（顯示值） }
  const q = n => "'" + String(n).replace(/'/g, "''") + "'";
  const col = n => { let s = ''; n = n | 0; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
  function load(id) {
    if (cache) return cache;
    const meta = Sheets.Spreadsheets.get(id, { fields: 'sheets.properties.title' });
    const names = (meta.sheets || []).map(s => s.properties.title);
    cache = {};
    if (names.length) {
      const r = Sheets.Spreadsheets.Values.batchGet(id, { ranges: names.map(q), valueRenderOption: 'FORMATTED_VALUE' });
      (r.valueRanges || []).forEach((vr, i) => { cache[names[i]] = vr.values || [[]]; });
    }
    return cache;
  }
  function sheetObj(id, name) {
    const rows = () => load(id)[name];
    const width = () => (rows()[0] || []).length;
    const pad = r => { const w = width(), o = (r || []).slice(0, Math.max(w, (r || []).length)); while (o.length < w) o.push(''); return o.map(v => v == null ? '' : String(v)); };
    return {
      getName: () => name,
      getDataRange: () => ({ getDisplayValues: () => rows().map(pad), getValues: () => rows().map(pad) }),
      getLastColumn: () => width(),
      getLastRow: () => rows().length,
      getRange: (r, c, nr, nc) => ({
        getValues: () => { const out = []; for (let i = 0; i < (nr || 1); i++) out.push(pad(rows()[r - 1 + i]).slice(c - 1, c - 1 + (nc || 1))); return out; },
        setValue: v => this_set(id, name, r, c, [[v]]),
        setValues: vals => this_set(id, name, r, c, vals)
      }),
      appendRow: row => {
        const vals = [row.map(v => v == null ? '' : String(v))];
        Sheets.Spreadsheets.Values.append({ values: vals }, id, q(name) + '!A1', { valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' });
        rows().push(vals[0]);
      }
    };
  }
  function this_set(id, name, r, c, vals) {
    const v = vals.map(row => row.map(x => x == null ? '' : String(x)));
    const a1 = q(name) + '!' + col(c) + r + ':' + col(c + v[0].length - 1) + (r + v.length - 1);
    Sheets.Spreadsheets.Values.update({ values: v }, id, a1, { valueInputOption: 'RAW' });
    const t = load(id)[name];
    v.forEach((row, i) => { t[r - 1 + i] = t[r - 1 + i] || []; row.forEach((x, j) => { t[r - 1 + i][c - 1 + j] = x; }); });
  }
  return {
    openById: id => {
      if (!id || id !== testSsId_()) throw new Error('測試環境只能開測試試算表');   // 正式試算表一律拒絕
      return {
        getId: () => id,
        getSheetByName: n => (n in load(id)) ? sheetObj(id, n) : null,
        insertSheet: n => {
          Sheets.Spreadsheets.batchUpdate({ requests: [{ addSheet: { properties: { title: n } } }] }, id);
          load(id)[n] = [[]]; return sheetObj(id, n);
        }
      };
    },
    _reset: () => { cache = null; }
  };
})();

/* ---------- 雲端硬碟（Drive API，只限測試根資料夾） ---------- */
const TDrive = (function () {
  const FOLDER = 'application/vnd.google-apps.folder';
  const meta = {};
  const info = id => meta[id] || (meta[id] = Drive.Files.get(id, { fields: 'id,name,mimeType,parents,trashed' }));
  const esc = s => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  /** 往上查父資料夾，必須查到測試根資料夾；查不到（或沒有權限）就拒絕 */
  function inRoot_(id) {
    const root = testRootId_();
    let cur = id;
    for (let i = 0; i < 12 && cur; i++) {
      if (cur === root) return true;
      let f; try { f = info(cur); } catch (e) { return false; }
      cur = (f.parents || [])[0];
    }
    return false;
  }
  function guard_(id) { if (!inRoot_(id)) throw new Error('測試環境只能使用測試資料夾裡的檔案'); }
  function list_(parent, name, isFolder) {
    const qy = "'" + esc(parent) + "' in parents and name = '" + esc(name) + "' and trashed = false and mimeType " + (isFolder ? '=' : '!=') + " '" + FOLDER + "'";
    return (Drive.Files.list({ q: qy, fields: 'files(id,name,mimeType,parents,trashed)', pageSize: 50 }).files || []);
  }
  const iter = arr => { let i = 0; return { hasNext: () => i < arr.length, next: () => arr[i++] }; };
  function fileObj(id) {
    return {
      getId: () => id,
      getName: () => info(id).name,
      getUrl: () => 'https://drive.google.com/file/d/' + id + '/view',
      getThumbnail: () => null,
      isTrashed: () => !!Drive.Files.get(id, { fields: 'trashed' }).trashed,
      setTrashed: b => { guard_(id); Drive.Files.update({ trashed: !!b }, id); delete meta[id]; },
      getParents: () => iter([folderObj((info(id).parents || [])[0])]),
      getBlob: () => {
        const r = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + id + '?alt=media', { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } });
        return r.getBlob().setName(info(id).name);
      }
    };
  }
  function folderObj(id) {
    guard_(id);
    return {
      getId: () => id,
      getName: () => info(id).name,
      getUrl: () => 'https://drive.google.com/drive/folders/' + id,
      getFoldersByName: n => iter(list_(id, n, true).map(f => { meta[f.id] = f; return folderObj(f.id); })),
      getFilesByName: n => iter(list_(id, n, false).map(f => { meta[f.id] = f; return fileObj(f.id); })),
      createFolder: n => { const f = Drive.Files.create({ name: n, mimeType: FOLDER, parents: [id] }, null, { fields: 'id,name,mimeType,parents' }); meta[f.id] = f; return folderObj(f.id); },
      createFile: blob => {
        const f = Drive.Files.create({ name: blob.getName(), parents: [id], mimeType: blob.getContentType() || 'application/octet-stream' }, blob, { fields: 'id,name,mimeType,parents' });
        meta[f.id] = f; return fileObj(f.id);
      }
    };
  }
  return {
    getFileById: id => { guard_(id); return fileObj(id); },
    getFolderById: id => folderObj(id),
    inRoot: inRoot_
  };
})();
function testRoot_() { return TDrive.getFolderById(testRootId_()); }
