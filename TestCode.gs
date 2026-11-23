/**
 * 浩森設計工作管理系統｜後端 v4.9（上線前修正：正式版關閉切換身分、分享紀錄後端檢查、同時產 PDF 不重複、照片失敗不留半筆、重送不重複；v4.8 追加減與進度連動、PDF 依指示更新；v4.7 逐欄合併、簽核與 PDF 分開；v4.6 外部檢查修正、客戶指示執行追蹤、存檔一趟完成；v4.5 系統設定與範本維護、經驗回流；統計、結案唯讀、保固報修；日誌漏填追蹤；文件頁：週報、工程履歷；查驗紀錄、SOP、里程碑；客戶頁；現場總覽與指示追蹤；進度計畫；案件主檔修改；日誌簽核與 PDF；分享／下載分開記錄、唯讀查看 PDF）
 * 資料庫：Google Sheet「浩森設計工作管理系統_資料庫」（與 AppSheet 共用）
 * 所有前端呼叫都走 api(action, payload)，之後改成 PWA 時只需換「身分驗證」這一層。
 * 欄位一律用「表頭名稱」對應，不依賴欄位順序。
 */

const SS_ID = PropertiesService.getScriptProperties().getProperty('TEST_SS_ID') || 'TEST_NOT_SET';   // ★ 測試環境：只連測試試算表
const PHOTO_DIR = '日誌照片_Images';
const CONFIRM_DIR = '客戶確認_Images';  // 客戶簽名、LINE 回覆截圖
const CASE_ROOT = '案件資料夾';        // 案件沒有指定雲端資料夾時，自動建在這裡
const LOG_PDF_DIR = '工程日誌';        // 每個案件資料夾裡放日誌 PDF 的子資料夾
const APP_URL = 'https://housen-design.github.io/housen-app/';  // 網站網址（PDF 取 Logo 用）

/* 日誌狀態與指示狀態（改名時只改這裡） */
const LS = { DRAFT: '草稿', DESIGNER: '待設計師確認', PENDING: '待簽核', SIGNED: '已簽核' };
const IS = { TODO: '待處理', REPLIED: '已回報', CLOSED: '已結案' };
function insStatus_(s) { return s === '處理中' ? IS.TODO : s === '待確認' ? IS.REPLIED : (s || IS.TODO); }
const LEADER_ROLES = ['Boss', '主管'];   // 可以下指示、指派待辦給別人、管理工種
const TEST_MODE = false;                // 正式版固定 false：不提供切換身分。試玩站另外在自己的副本打開，不靠正式後端

/* ========== 入口 ========== */
function doGet() {
  return HtmlService.createTemplateFromFile('Index').evaluate()
    .setTitle('浩森設計工作管理系統')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

/* ========== PWA 入口（app.housenaid.com 透過 POST 呼叫） ========== */
const CLIENT_ID = '473235039295-dnrf8007tmjrnt93m09e4qli00qa473l.apps.googleusercontent.com'; // Google 登入用戶端 ID
const DOMAIN = 'housenaid.com';  // 只允許公司網域帳號
const SESSION_DAYS = 30;         // 登入有效天數

function doPost(e) {
  let out;
  try {
    const req = JSON.parse(e.postData.contents || '{}');
    if (req.action === 'login') out = { ok: true, data: login_(req.idToken) };
    else out = { ok: true, data: run_(session_(req.token), req.action, req.payload || {}) };
  } catch (err) {
    out = { ok: false, error: String(err && err.message || err), auth: !!(err && err.auth) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function login_(idToken) {
  if (!CLIENT_ID) throw authErr_('系統尚未設定 Google 登入');
  const r = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken || ''), { muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) throw authErr_('Google 登入驗證失敗，請再試一次');
  const t = JSON.parse(r.getContentText());
  if (t.aud !== CLIENT_ID) throw authErr_('登入來源不符');
  if (String(t.email_verified) !== 'true') throw authErr_('帳號尚未驗證');
  if ((t.hd || '') !== DOMAIN) throw authErr_('請使用公司帳號（@' + DOMAIN + '）登入');
  const me = user_(t.email);
  return { token: sign_(t.email), name: me.name, email: me.email, picture: t.picture || '' };
}

function secret_() {
  const p = PropertiesService.getScriptProperties();
  let s = p.getProperty('SESSION_SECRET');
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); p.setProperty('SESSION_SECRET', s); }
  return s;
}
function mac_(s) { return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(s, secret_())); }
function sign_(email) {
  const body = Utilities.base64EncodeWebSafe(JSON.stringify({ e: String(email).toLowerCase(), x: Date.now() + SESSION_DAYS * 864e5 }));
  return body + '.' + mac_(body);
}
function session_(tok) {
  const parts = String(tok || '').split('.');
  if (parts.length !== 2 || mac_(parts[0]) !== parts[1]) throw authErr_('請重新登入');
  const d = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString());
  if (Date.now() > d.x) throw authErr_('登入已過期，請重新登入');
  return d.e;
}
function authErr_(m) { const e = new Error(m); e.auth = true; return e; }

/** 舊版網頁（Apps Script 直接開啟）入口 */
function api(action, payload) {
  return run_(Session.getActiveUser().getEmail(), action, payload);
}

/** 共用：依登入者 email 執行動作。payload.as = 測試模式下 Boss 預覽員工畫面（唯讀） */
function run_(email, action, payload) {
  payload = payload || {};
  let real;
  try { real = user_(email); } catch (e) { throw authErr_(e.message); }
  let me = real;
  if (payload.as && payload.as !== real.id) {
    if (real.role !== 'Boss' || !TEST_MODE) throw new Error('沒有預覽權限');
    me = Object.assign(userById_(payload.as), { preview: true });
  }
  const READ = { home: getHome_, case: getCase_, thumbs: getThumbs_, pdfView: pdfView_, stats: stats_, admin: admin_ };   // 只讀，預覽模式也可用
  const SLOW = { buildLogPdf: buildLogPdf_, pdfLog: pdfLog_, clientPdf: clientPdf_, reportPdf: reportPdf_ };   // 產生 PDF 較久，不鎖住其他人
  const WRITE = {
    saveLog: saveLog_, updateLog: updateLog_, deletePhoto: deletePhoto_,
    submitLog: submitLog_, confirmLog: confirmLog_, signLog: signLog_, returnLog: returnLog_,
    escalateLog: escalateLog_, seenLog: seenLog_, shareLog: shareLog_,
    saveIns: saveIns_, actIns: actIns_, saveTodo: saveTodo_, setTodo: setTodo_,
    saveCase: saveCase_, saveCaseInfo: saveCaseInfo_, setStage: setStage_, saveTrade: saveTrade_,
    savePlanItem: savePlanItem_, cancelPlanItem: cancelPlanItem_, applyTemplate: applyTemplate_, lockPlan: lockPlan_,
    setActualStart: setActualStart_, setDone: setDone_,
    saveMeeting: saveMeeting_, reviewMeeting: reviewMeeting_, saveClientIns: saveClientIns_, confirmClientIns: confirmClientIns_,
    markNoWork: markNoWork_, saveCheck: saveCheck_, saveRepair: saveRepair_, applySop: applySop_, setSop: setSop_, applyMilestones: applyMilestones_, saveMilestone: saveMilestone_, setMilestone: setMilestone_,
    saveSetting: saveSetting_, saveTemplateRow: saveTemplateRow_, suggestTemplate: suggestTemplate_, setSuggestion: setSuggestion_,
    actClientIns: actClientIns_
  };
  if (READ[action]) return READ[action](me, payload);
  if (SLOW[action]) { if (me.preview) throw new Error('預覽模式只能看'); const scid = target_(action, payload); if (scid && !caseRow_(scid)) throw new Error('找不到案件，已拒絕這次動作'); return SLOW[action](me, payload); }
  if (WRITE[action]) {
    if (me.preview) throw new Error('預覽模式只能看，不能存檔');
    const lock = LockService.getScriptLock();
    let out;
    lock.waitLock(20000);
    try {
      TSheets.flush();   // 拿到鎖之後才讀，確保看到別人剛寫入的內容
      const seen = reqSeen_(me, action, payload);
      if (seen) out = seen.out;   // 同一次送出重送（例如網路斷線後重按）：直接回上次的結果，不再寫一次
      else {
        // 在鎖內才判斷：資料屬於哪個案件、是否已結案、畫面是否過期（避免檢查完到寫入之間被別人改掉）
        const cid = target_(action, payload);
        closedGuard_(action, cid);
        out = WRITE[action](me, payload);
        reqDone_(me, action, payload, out);
      }
    } finally { lock.releaseLock(); }
    // 加速：畫面正在看某個案件時，存檔後順便把這個案件的最新資料一起帶回去，手機不用再跑第二趟
    if (payload._back) {
      let fresh = null;
      try { _people = null; _settings = null; fresh = getCase_(me, { id: payload._back }); } catch (e) { }
      return { __r: out, __case: fresh, __id: payload._back };
    }
    return out;
  }
  throw new Error('未知的動作：' + action);
}

/* ========== 共用工具 ========== */
/** 重送保護：畫面每次送出帶一個 reqId；同一個 reqId 6 小時內只執行一次 */
function reqKey_(me, action, d) { return d && d.reqId ? 'req_' + me.id + '_' + action + '_' + String(d.reqId).slice(0, 40) : ''; }
function reqSeen_(me, action, d) {
  const k = reqKey_(me, action, d); if (!k) return null;
  const v = CacheService.getScriptCache().get(k);
  return v ? JSON.parse(v) : null;
}
function reqDone_(me, action, d, out) {
  const k = reqKey_(me, action, d); if (!k) return;
  try { CacheService.getScriptCache().put(k, JSON.stringify({ out: out === undefined ? null : out }), 21600); } catch (e) { }
}
/** 短暫鎖住（給不在大鎖裡的產檔動作，只在讀寫紀錄的那一小段用） */
function withLock_(fn) {
  const lk = LockService.getScriptLock();
  lk.waitLock(30000);
  try { TSheets.flush(); return fn(); } finally { lk.releaseLock(); }
}
let _ss;
function ss_() { return _ss || (_ss = TSheets.openById(SS_ID)); }

function readTable_(name) {
  const sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('找不到資料表：' + name);
  const v = sh.getDataRange().getDisplayValues();
  const head = v.shift() || [];
  return v.filter(r => r.some(c => c !== '')).map(r => {
    const o = {};
    head.forEach((h, i) => { if (h) o[h] = r[i]; });
    return o;
  });
}

function tryTable_(name) { return ss_().getSheetByName(name) ? readTable_(name) : []; }

/** 發布前在編輯器執行：檢查新版需要的資料表與欄位是否都已建立 */
/* ========== 資料表欄位（部署前在編輯器執行 checkSchema；缺的用 fixSchema 補） ==========
 * fixSchema 只做兩件事：建立缺少的資料表（只有標題列）、在既有資料表最右邊補缺少的欄位標題。不移動、不刪除任何資料。
 */
const SCHEMA = {
    '人員': ['人員ID', '姓名', 'Email', '職稱', '系統角色', '可看金額', '可看績效', '在職'],
    '工種清單': ['工種', '色碼', '排序', '啟用'],
    '案件': ['案件ID', '案件名稱', '客戶姓名', '客戶電話', '客戶LINE', '地址', '類型', '來源', '負責設計師', '階段', '狀態', '建立日期', '提案日', '設計約簽約日', '工程約簽約日', '預計開工日', '預計完工日', '實際完工日', '結案日', '保固到期日', 'Drive資料夾', '設計費', '工程金額', '備註', '最後修改時間', '最後修改人', '進度定案時間', '進度定案人'],
    '工程日誌': ['日誌ID', '案件ID', '日期', '工種', '今日狀況', '進度百分比', '發現問題', '填寫人', '建立時間', '最後修改時間', '修改次數', '最後修改人', '日誌狀態', '送出時間', '簽核人', '簽核期限', '轉Boss確認', '簽核者', '簽核時間', '簽核內容', '修改待簽', '小修待看', '退回原因', 'PDF檔ID', 'PDF時間', '修訂時間', '分享次數', '最後分享人', '最後分享時間', '下載次數', '最後下載人', '最後下載時間', 'PDF錯誤'],
    '進度計畫': ['工序ID', '案件ID', '順序', '工種', '工序名稱', '原計畫開始', '原計畫完成', '目前計畫開始', '目前計畫完成', '實際開始', '實際完成', '查驗點', '改期原因', '關聯客戶指示ID', '狀態', '實際開始確認人', '實際完成確認人', '範本工序ID', '最後修改人', '最後修改時間'],
    '進度異動紀錄': ['紀錄ID', '案件ID', '工序ID', '項目', '原值', '新值', '原因', '修改人', '時間', '關聯客戶指示'],
    '範本_工序': ['工序ID', '順序', '工種', '工序名稱', '標準工期（工作天）', '查驗點', '備註', '啟用'],
    '會議': ['會議ID', '案件ID', '日期', '會議名稱', '出席人', '錄音檔', 'AI摘要', '核對人', '核對時間', '記錄人', '建立時間', 'PDF時間'],
    '客戶指示': ['指示ID', '案件ID', '會議ID', '類型', '來源', '日期', '內容', '影響費用或工期', '追加減金額', '影響工期天數', '確認狀態', '確認方式', '客戶簽名', '確認截圖', '確認時間', '記錄人', '鎖定', '確認備註', '建立時間', '最後修改人', '最後修改時間', '執行人', '執行期限', '執行狀態', '處理回報', '回報時間', '回報人', '完成確認人', '完成時間', '進度調整', '進度調整說明', '進度調整人', '進度調整時間'],
    '文件紀錄': ['文件ID', '案件ID', '日期', '文件名稱', '文件類型', '對內對外', '檔案連結', '產生人', '檔案ID', '來源ID', '產生時間'],
    '查驗紀錄': ['紀錄ID', '案件ID', '查驗點', '檢查ID', '檢查項目', '照片', '完成', '狀態', '放行人', '放行時間', '備註', '工序ID', '檢查人', '檢查時間'],
    '範本_查驗清單': ['檢查ID', '查驗點', '順序', '檢查項目', '需拍照', '啟用'],
    '案件SOP': ['ID', '案件ID', '項目ID', '項目', '完成', '完成日', '完成人', '備註', '順序', '負責角色', '說明'],
    '範本_開案SOP': ['項目ID', '順序', '項目', '說明', '負責角色', '啟用'],
    '里程碑': ['任務ID', '案件ID', '階段', '名稱', '負責人', '原定日期', '目前期限', '完成日', '狀態', '退回次數', '改期原因', '備註', '順序'],
    '範本_里程碑': ['里程碑ID', '階段', '順序', '名稱', '負責角色', '相對天數', '說明', '啟用'],
    '公司設定': ['項目', '值', '說明'],
    '保固報修': ['報修ID', '案件ID', '報修日期', '內容', '負責人', '狀態', '處理結果', '完成日', '記錄人', '建立時間'],
    '範本建議': ['建議ID', '來源', '來源ID', '案件ID', '範本', '內容', '提出人', '提出時間', '狀態', '處理人', '處理時間', '處理備註'],
    '日誌豁免': ['ID', '案件ID', '日期', '原因', '記錄人', '時間'],
    '日誌照片': ['照片ID', '日誌ID', '案件ID', '照片', '空間', '位置', '說明', '拍攝時間', '刪除時間', '刪除人', '說明修改人', '說明修改時間'],
    '主管指示': ['指示ID', '案件ID', '日誌ID', '指示內容', '負責人', '期限', '狀態', '回報內容', '回報時間', '結案時間', '退回次數', '下指示人', '建立時間'],
    '待辦': ['待辦ID', '案件ID', '內容', '負責人', '期限', '狀態', '建立人', '建立時間', '完成時間']
};
function schemaGaps_() {
  const miss = [];
  Object.keys(SCHEMA).forEach(n => {
    const sh = ss_().getSheetByName(n);
    if (!sh) { miss.push({ sheet: n, cols: SCHEMA[n], newSheet: true }); return; }
    const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
    const lack = SCHEMA[n].filter(h => head.indexOf(h) < 0);
    if (lack.length) miss.push({ sheet: n, cols: lack });
  });
  return miss;
}
function checkSchema() {
  const miss = schemaGaps_();
  Logger.log(miss.length ? miss.map(m => (m.newSheet ? '缺資料表：' : '缺欄位：') + m.sheet + (m.newSheet ? '' : ' → ' + m.cols.join('、'))).join('\n') + '\n可執行 fixSchema 補上（不動既有資料）' : '欄位齊全，可以部署');
  return miss;
}
function fixSchema() {
  const ss = ss_(), done = [];
  schemaGaps_().forEach(m => {
    if (m.newSheet) { ss.insertSheet(m.sheet).getRange(1, 1, 1, m.cols.length).setValues([m.cols]); done.push('新增資料表：' + m.sheet); return; }
    const sh = ss.getSheetByName(m.sheet), last = sh.getLastColumn();
    const need = last + m.cols.length - sh.getMaxColumns();   // 試算表格子不夠寬（例如只有 26 欄）就先在最右邊加欄，否則寫不進去
    if (need > 0) sh.insertColumnsAfter(sh.getMaxColumns(), need);
    sh.getRange(1, last + 1, 1, m.cols.length).setValues([m.cols]);
    done.push(m.sheet + ' 補欄位：' + m.cols.join('、'));
  });
  Logger.log(done.length ? done.join('\n') : '不需要補');
  return done;
}

function appendRow_(name, obj) {
  const sh = ss_().getSheetByName(name);
  const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  sh.appendRow(head.map(h => (obj[h] === undefined || obj[h] === null) ? '' : obj[h]));
}

function findRow_(name, keyCol, key) {
  const sh = ss_().getSheetByName(name);
  const v = sh.getDataRange().getDisplayValues();
  const head = v[0], k = head.indexOf(keyCol);
  for (let r = 1; r < v.length; r++) if (String(v[r][k]) === String(key)) return { sh, head, row: r + 1, vals: v[r] };
  throw new Error('找不到資料：' + name + ' ' + key);
}

function updateRow_(name, keyCol, key, patch) {
  const f = findRow_(name, keyCol, key);
  Object.keys(patch).forEach(col => {
    const c = f.head.indexOf(col);
    if (c >= 0) f.sh.getRange(f.row, c + 1).setValue(patch[col]);
  });
}

function rowObj_(f) { const o = {}; f.head.forEach((h, i) => { if (h) o[h] = f.vals[i]; }); return o; }
function getLog_(id) { return rowObj_(findRow_('工程日誌', '日誌ID', id)); }
function caseRow_(id) { return readTable_('案件').find(c => c['案件ID'] === id) || null; }
function h_(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function uid_() { return Utilities.getUuid().replace(/-/g, '').slice(0, 8); }
function fmt_(d, p) { return Utilities.formatDate(d, 'Asia/Taipei', p); }
function today_() { return fmt_(new Date(), 'yyyy/MM/dd'); }
function now_() { return fmt_(new Date(), 'yyyy/MM/dd HH:mm:ss'); }
function ymd_(s) { return s ? String(s).replace(/-/g, '/') : ''; }

function person_(p) {
  return {
    id: p['人員ID'], name: p['姓名'], email: (p['Email'] || '').toLowerCase(), title: p['職稱'], role: p['系統角色'],
    leader: LEADER_ROLES.indexOf(p['系統角色']) >= 0, seeMoney: p['可看金額'] === 'Y', seePerf: p['可看績效'] === 'Y',
    active: p['在職'] !== 'N'
  };
}
let _people;
function people_() { return _people || (_people = readTable_('人員').map(person_)); }
function user_(email) {
  email = String(email || '').toLowerCase();
  const p = people_().find(x => x.email === email && x.active);
  if (!p) throw new Error('你的帳號（' + (email || '未登入') + '）不在「人員」名單中，請聯絡管理者。');
  return Object.assign({}, p);
}
function userById_(id) {
  const p = people_().find(x => x.id === id);
  if (!p) throw new Error('找不到人員');
  return Object.assign({}, p);
}
function pname_(id) { return (people_().find(p => p.id === id) || {}).name || id || ''; }

/* ========== 簽核規則 ========== */

/** 依「日誌填寫人」決定簽核人：一般員工→主管（蘋芳）；主管填寫→Boss；Boss 填寫→自己 */
function signerFor_(writerId) {
  const ppl = people_().filter(p => p.active), w = ppl.find(p => p.id === writerId) || {};
  const boss = (ppl.find(p => p.role === 'Boss') || {}).id || '';
  if (w.role === 'Boss') return w.id;
  if (w.role === '主管') return boss;
  const sup = ppl.find(p => p.role === '主管');
  return sup ? sup.id : boss;
}
function bossId_() { return (people_().find(p => p.role === 'Boss' && p.active) || {}).id || ''; }

/** 簽核期限：下一個工作天中午 12:00（週六日不計） */
function deadline_() {
  let t = Date.now();
  do { t += 864e5; } while (['6', '7'].indexOf(fmt_(new Date(t), 'u')) >= 0);
  return fmt_(new Date(t), 'yyyy/MM/dd') + ' 12:00';
}
function overdue_(dl) { return !!dl && fmt_(new Date(), 'yyyy/MM/dd HH:mm') > String(dl).slice(0, 16); }

function logStatus_(l) { return l['日誌狀態'] || LS.PENDING; }
function signerOf_(l) { return l['簽核人'] || signerFor_(l['填寫人']); }
function canSign_(me, l) { return me.id === signerOf_(l) || me.role === 'Boss'; }
function canShare_(me, c) { return me.leader || (c && c['負責設計師'] === me.id); }
function parseSnap_(l) { try { return l['簽核內容'] ? JSON.parse(l['簽核內容']) : null; } catch (e) { return null; } }

function activePhotos_(logId, all) {
  return (all || readTable_('日誌照片')).filter(p => p['日誌ID'] === logId && !p['刪除時間']);
}
function snapshot_(l, photos) {
  return { date: l['日期'], trades: l['工種'], text: l['今日狀況'], issue: l['發現問題'], photos: photos.map(p => ({ id: p['照片ID'], note: p['說明'] || '' })) };
}

/** 進入待簽核 */
function pendingPatch_(writerId) {
  return { '日誌狀態': LS.PENDING, '簽核人': signerFor_(writerId), '簽核期限': deadline_(), '轉Boss確認': '' };
}
/** 送出：填寫人就是負責設計師（或 Boss、案件未指定設計師）→ 直接待簽核；否則先給設計師確認 */
function submitPatch_(writerId, c) {
  const designer = c ? c['負責設計師'] : '';
  const w = people_().find(p => p.id === writerId) || {};
  const p = { '送出時間': now_(), '退回原因': '' };
  if (!designer || designer === writerId || w.role === 'Boss') Object.assign(p, pendingPatch_(writerId));
  else p['日誌狀態'] = LS.DESIGNER;
  return p;
}
/** 已簽核的日誌被重大修改 → 回到待簽核，主管只看差異 */
function resignPatch_(l) { return Object.assign(pendingPatch_(l['填寫人']), { '修改待簽': 'Y', '小修待看': '', '退回原因': '' }); }

/* ========== 讀取 ========== */

function getHome_(me) {
  const people = people_().filter(p => p.active).map(x => ({ id: x.id, name: x.name, role: x.role, leader: x.leader }));
  const trades = readTable_('工種清單').filter(t => t['啟用'] !== 'N')
    .sort((a, b) => (+a['排序'] || 0) - (+b['排序'] || 0))
    .map(t => ({ name: t['工種'], color: t['色碼'] }));
  const logs = readTable_('工程日誌');
  const ins = readTable_('主管指示').filter(i => i['指示內容']);
  ins.forEach(i => i['狀態'] = insStatus_(i['狀態']));
  const todos = readTable_('待辦');
  const caseRows = readTable_('案件');
  const cases = caseRows.map(c => {
    const cl = logs.filter(l => l['案件ID'] === c['案件ID']);
    const dates = cl.map(l => l['日期']).sort();
    const acts = cl.map(l => [l['建立時間'], l['最後修改時間']].sort().pop() || '').sort();
    return {
      id: c['案件ID'], name: c['案件名稱'], client: c['客戶姓名'], address: c['地址'],
      stage: c['階段'], status: c['狀態'], designer: c['負責設計師'],
      lastLog: dates.length ? dates[dates.length - 1] : '', act: acts.length ? acts[acts.length - 1] : '',
      openIns: ins.filter(i => i['案件ID'] === c['案件ID'] && i['狀態'] !== IS.CLOSED).length
    };
  });
  const cname = id => (cases.find(c => c.id === id) || {}).name || '';
  const items = [];
  // 待辦事項
  todos.filter(t => t['負責人'] === me.id).forEach(t => items.push({
    kind: 'todo', id: t['待辦ID'], caseId: t['案件ID'], caseName: cname(t['案件ID']), text: t['內容'],
    due: t['期限'], done: t['狀態'] === '已完成', doneAt: t['完成時間'], from: t['建立人'], created: t['建立時間']
  }));
  // 指示：交給我的、等我確認的
  ins.filter(i => (i['負責人'] === me.id && i['狀態'] !== IS.CLOSED) || (i['下指示人'] === me.id && i['狀態'] === IS.REPLIED))
    .forEach(i => items.push({
      kind: 'ins', id: i['指示ID'], caseId: i['案件ID'], caseName: cname(i['案件ID']), text: i['指示內容'],
      due: i['期限'], status: i['狀態'], to: i['負責人'], from: i['下指示人'], created: i['建立時間'],
      mine: i['負責人'] === me.id
    }));
  // 日誌：要我簽核、確認、傳送、重寫的
  logs.forEach(l => {
    const st = logStatus_(l), cid = l['案件ID'], c = caseRows.find(x => x['案件ID'] === cid);
    const designer = c ? c['負責設計師'] : '', signer = signerOf_(l);
    const base = { kind: 'log', id: l['日誌ID'], caseId: cid, caseName: cname(cid), date: l['日期'], by: l['填寫人'], created: l['送出時間'] || l['建立時間'] };
    const add = (task, more) => items.push(Object.assign({ status: task }, base, more || {}));
    if (st === LS.PENDING && signer === me.id) add(l['修改待簽'] === 'Y' ? 'resign' : 'sign', { due: l['簽核期限'], overdue: overdue_(l['簽核期限']), escal: l['轉Boss確認'] === 'Y' });
    else if (st === LS.PENDING && me.role === 'Boss' && overdue_(l['簽核期限'])) add('overdue', { due: l['簽核期限'], overdue: true, signer: signer });
    if (st === LS.DESIGNER && designer === me.id) add('confirm');
    if (st === LS.DRAFT && l['填寫人'] === me.id) add(l['退回原因'] ? 'returned' : 'draft', { note: l['退回原因'] });
    if (st === LS.SIGNED && designer === me.id && !(+l['分享次數'])) add('send');
    if (st === LS.SIGNED && l['小修待看'] === 'Y' && signer === me.id) add('minor');
  });
  // 日誌漏填：提醒負責設計師（最近 5 天）
  const rule = logRule_(), exempt = tryTable_('日誌豁免');
  const missMap = {};
  caseRows.forEach(c => { const m = missingDays_(c, logs, exempt, rule); missMap[c['案件ID']] = m;
    if (c['負責設計師'] === me.id) m.slice(0, 5).forEach(dd => items.push({ kind: 'miss', id: c['案件ID'] + ':' + dd, caseId: c['案件ID'], caseName: c['案件名稱'], date: dd, status: 'miss', created: dd })); });
  items.forEach(i => { if (i.kind === 'ins' && i.status === IS.TODO && !i.due && i.created) i.staleDays = Math.floor((Date.now() - new Date(String(i.created).replace(/\//g, '-').replace(' ', 'T') + '+08:00').getTime()) / 864e5); });
  // 保固報修：交給我、還沒完成的
  tryTable_('保固報修').filter(x => x['負責人'] === me.id && x['狀態'] !== '已完成').forEach(x => items.push({
    kind: 'wr', id: x['報修ID'], caseId: x['案件ID'], caseName: cname(x['案件ID']), text: x['內容'], status: x['狀態'], created: x['報修日期'], due: ''
  }));
  // 客戶指示的執行：交給我待執行的；我負責的案件、已回報等我確認完成的
  const designerOf = {}; caseRows.forEach(c => { designerOf[c['案件ID']] = c['負責設計師']; });
  tryTable_('客戶指示').forEach(x => {
    const st = x['執行狀態'] || '';
    if (x['確認狀態'] === '已確認' && x['影響費用或工期'] === 'Y' && (+x['影響工期天數'] || 0) !== 0 && !x['進度調整'] && designerOf[x['案件ID']] === me.id)
      items.push({ kind: 'cins', id: x['指示ID'], caseId: x['案件ID'], caseName: cname(x['案件ID']), text: x['內容'], status: '待調整進度', days: x['影響工期天數'], created: x['確認時間'] || x['建立時間'] });
    if (st === '待執行' && x['執行人'] === me.id) items.push({ kind: 'cins', id: x['指示ID'], caseId: x['案件ID'], caseName: cname(x['案件ID']), text: x['內容'], status: '待執行', due: x['執行期限'], created: x['建立時間'] });
    else if (st === '已回報' && (designerOf[x['案件ID']] === me.id || (me.role === 'Boss' && !designerOf[x['案件ID']]))) items.push({ kind: 'cins', id: x['指示ID'], caseId: x['案件ID'], caseName: cname(x['案件ID']), text: x['內容'], status: '已回報', due: x['執行期限'], created: x['回報時間'] || x['建立時間'], report: x['處理回報'] });
  });
  // 設計階段里程碑：交給我、未完成的（期限 7 天內或已逾期）
  const soon = fmt_(new Date(Date.now() + 7 * 864e5), 'yyyy/MM/dd');
  tryTable_('里程碑').filter(x => x['負責人'] === me.id && x['狀態'] !== '已完成' && x['目前期限'] && x['目前期限'] <= soon).forEach(x => items.push({
    kind: 'ms', id: x['任務ID'], caseId: x['案件ID'], caseName: cname(x['案件ID']), text: x['名稱'], due: x['目前期限'], status: '未完成', created: x['原定日期']
  }));
  // 工序超過計畫日期（只提醒負責設計師，不需任何批准）
  const lateDays = +setting_('延誤警告門檻（天）', 1) || 0, lim = fmt_(new Date(Date.now() - lateDays * 864e5), 'yyyy/MM/dd');
  tryTable_('進度計畫').filter(r => r['狀態'] !== '取消').forEach(r => {
    const c = caseRows.find(x => x['案件ID'] === r['案件ID']);
    if (!c || c['負責設計師'] !== me.id) return;
    const lateEnd = r['目前計畫完成'] && r['目前計畫完成'] < lim && !r['實際完成'], lateStart = r['目前計畫開始'] && r['目前計畫開始'] < lim && !r['實際開始'];
    if (lateEnd || lateStart) items.push({ kind: 'plan', id: r['工序ID'], caseId: r['案件ID'], caseName: cname(r['案件ID']), text: r['工序名稱'],
      due: lateEnd ? r['目前計畫完成'] : r['目前計畫開始'], status: lateEnd ? '超過計畫完成日' : '超過計畫開始日', created: r['目前計畫開始'] });
  });
  // 主管的現場總覽：施工中與開案前案件的最新日誌、照片、問題、指示與進度差異（只讀、不設任何批准）
  let overview = [], tracking = [];
  if (me.leader) {
    const t = today_(), cut = fmt_(new Date(Date.now() - 14 * 864e5), 'yyyy/MM/dd');
    const photos = readTable_('日誌照片'), plan = tryTable_('進度計畫');
    overview = caseRows.filter(c => c['狀態'] !== '已結案' && c['狀態'] !== '未成交' && ['施工', '開案前'].indexOf(c['階段']) >= 0).map(c => {
      const cid = c['案件ID'];
      const cl = logs.filter(l => l['案件ID'] === cid).sort((a, b) => (b['日期'] + b['建立時間']).localeCompare(a['日期'] + a['建立時間']));
      const last = cl[0], issue = cl.find(l => l['發現問題'] && l['日期'] >= cut);
      const ci = ins.filter(i => i['案件ID'] === cid), pl = plan.filter(r => r['案件ID'] === cid && r['狀態'] !== '取消');
      const lp = last ? activePhotos_(last['日誌ID'], photos) : [];
      return {
        id: cid, name: c['案件名稱'], designer: c['負責設計師'], stage: c['階段'],
        last: last ? { id: last['日誌ID'], date: last['日期'], by: last['填寫人'], text: String(last['今日狀況'] || '').slice(0, 90), status: logStatus_(last), photos: lp.slice(0, 3).map(x => x['照片']), nPhotos: lp.length } : null,
        logs7: cl.filter(l => l['日期'] >= fmt_(new Date(Date.now() - 7 * 864e5), 'yyyy/MM/dd')).length,
        issue: issue ? { id: issue['日誌ID'], date: issue['日期'], text: String(issue['發現問題']).slice(0, 90) } : null,
        missing: (missMap[cid] || []).length,
        insOpen: ci.filter(i => i['狀態'] === IS.TODO).length,
        insLate: ci.filter(i => i['狀態'] === IS.TODO && i['期限'] && i['期限'] < t).length,
        insWait: ci.filter(i => i['狀態'] === IS.REPLIED).length,
        plan: pl.length ? {
          total: pl.length, done: pl.filter(r => r['實際完成']).length,
          lateEnd: pl.filter(r => r['目前計畫完成'] && r['目前計畫完成'] < t && !r['實際完成']).length,
          lateStart: pl.filter(r => r['目前計畫開始'] && r['目前計畫開始'] < t && !r['實際開始']).length
        } : null
      };
    });
    tracking = ins.filter(i => i['下指示人'] === me.id && i['狀態'] === IS.TODO).map(i => ({
      id: i['指示ID'], caseId: i['案件ID'], caseName: cname(i['案件ID']), text: i['指示內容'], to: i['負責人'], due: i['期限'],
      created: i['建立時間'], late: !!i['期限'] && i['期限'] < t
    })).sort((a, b) => a.created.localeCompare(b.created));
  }
  return { me, people, trades, cases, items, overview, tracking, rule: rule, today: today_(), now: fmt_(new Date(), 'yyyy/MM/dd HH:mm'), testMode: TEST_MODE, tplDemo: String(setting_('範本狀態', '示範')).indexOf('正式') < 0 };
}

function getCase_(me, p) {
  const c = readTable_('案件').find(x => x['案件ID'] === p.id);
  if (!c) throw new Error('找不到案件');
  if (!me.seeMoney) { delete c['設計費']; delete c['工程金額']; }
  const photos = readTable_('日誌照片').filter(x => x['案件ID'] === p.id), insAt = insAtMap_(p.id);
  const ph = x => ({ id: x['照片ID'], path: x['照片'], note: x['說明'] || [x['空間'], x['位置']].filter(String).join('・'), noteBy: x['說明修改人'], noteAt: x['說明修改時間'] });
  const logs = readTable_('工程日誌').filter(l => l['案件ID'] === p.id).map(l => {
    const mine = photos.filter(x => x['日誌ID'] === l['日誌ID']);
    const resign = l['修改待簽'] === 'Y';
    return {
      id: l['日誌ID'], date: l['日期'], trades: (l['工種'] || '').split(/\s*,\s*/).filter(String),
      text: l['今日狀況'], issue: l['發現問題'], by: l['填寫人'], created: l['建立時間'],
      edited: l['最後修改時間'], edits: +l['修改次數'] || 0, editor: l['最後修改人'],
      photos: mine.filter(x => !x['刪除時間']).map(ph),
      gone: resign ? mine.filter(x => x['刪除時間']).map(ph) : [],
      status: logStatus_(l), submitted: l['送出時間'], signer: signerOf_(l), deadline: l['簽核期限'],
      overdue: logStatus_(l) === LS.PENDING && overdue_(l['簽核期限']), escal: l['轉Boss確認'] === 'Y',
      signedBy: l['簽核者'], signedAt: l['簽核時間'], resign: resign, snap: resign ? parseSnap_(l) : null,
      signedOnce: !!l['簽核內容'], minor: l['小修待看'] === 'Y', returnNote: l['退回原因'],
      pdfAt: l['PDF時間'], hasPdf: !!l['PDF檔ID'], pdfState: pdfState_(l, insAt[l['日誌ID']] || ''), pdfErr: l['PDF錯誤'] || '', revisedAt: l['修訂時間'], shares: +l['分享次數'] || 0, sharedBy: l['最後分享人'], sharedAt: l['最後分享時間'],
      downloads: +l['下載次數'] || 0, downloadedBy: l['最後下載人'], downloadedAt: l['最後下載時間'], rev: rev_('工程日誌', l), fv: fv_('工程日誌', l)
    };
  }).sort((a, b) => (b.date + b.created).localeCompare(a.date + a.created));
  const ins = readTable_('主管指示').filter(i => i['案件ID'] === p.id && i['指示內容']).map(i => ({
    id: i['指示ID'], logId: i['日誌ID'], text: i['指示內容'], to: i['負責人'], due: i['期限'],
    status: insStatus_(i['狀態']), reply: i['回報內容'], returns: +i['退回次數'] || 0, from: i['下指示人'], created: i['建立時間']
  })).sort((a, b) => b.created.localeCompare(a.created));
  const todos = readTable_('待辦').filter(t => t['案件ID'] === p.id).map(t => ({
    id: t['待辦ID'], text: t['內容'], to: t['負責人'], due: t['期限'], done: t['狀態'] === '已完成', from: t['建立人']
  }));
  const plan = readTable_('進度計畫').filter(r => r['案件ID'] === p.id).map(r => ({
    id: r['工序ID'], order: +r['順序'] || 0, trade: r['工種'], name: r['工序名稱'],
    baseStart: r['原計畫開始'], baseEnd: r['原計畫完成'], start: r['目前計畫開始'], end: r['目前計畫完成'],
    actStart: r['實際開始'], actStartBy: r['實際開始確認人'], actEnd: r['實際完成'], actEndBy: r['實際完成確認人'],
    check: r['查驗點'], cancelled: r['狀態'] === '取消', tpl: r['範本工序ID'], rev: rev_('進度計畫', r), fv: fv_('進度計畫', r)
  })).sort((a, b) => a.order - b.order);
  const planLog = tryTable_('進度異動紀錄').filter(r => r['案件ID'] === p.id).map(r => ({
    item: r['工序ID'], what: r['項目'], from: r['原值'], to: r['新值'], why: r['原因'], by: r['修改人'], at: r['時間']
  })).reverse();
  const meetings = tryTable_('會議').filter(m => m['案件ID'] === p.id).map(m => ({
    id: m['會議ID'], date: m['日期'], name: m['會議名稱'], attendees: m['出席人'], audio: m['錄音檔'], summary: m['AI摘要'],
    reviewedBy: m['核對人'], reviewedAt: m['核對時間'], by: m['記錄人'], pdfAt: m['PDF時間'], rev: rev_('會議', m), fv: fv_('會議', m)
  })).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const cins = tryTable_('客戶指示').filter(x => x['案件ID'] === p.id).map(x => ({
    id: x['指示ID'], meetingId: x['會議ID'], type: x['類型'], source: x['來源'], date: x['日期'], text: x['內容'],
    impact: x['影響費用或工期'] === 'Y', amount: x['追加減金額'], days: x['影響工期天數'], status: x['確認狀態'] || '待確認',
    method: x['確認方式'], sign: x['客戶簽名'], shot: x['確認截圖'], confirmedAt: x['確認時間'], note: x['確認備註'],
    by: x['記錄人'], created: x['建立時間'], locked: x['鎖定'] === 'Y',
    owner: x['執行人'], due: x['執行期限'], exec: x['執行狀態'] || (x['確認狀態'] === '客戶不同意' ? '不需執行' : '待執行'), report: x['處理回報'], reportAt: x['回報時間'],
    doneBy: x['完成確認人'], doneAt: x['完成時間'], rev: rev_('客戶指示', x),
    sched: x['進度調整'] || '', schedNote: x['進度調整說明'] || '', schedBy: x['進度調整人'] || '', schedAt: x['進度調整時間'] || '',
    needSched: x['確認狀態'] === '已確認' && x['影響費用或工期'] === 'Y' && (+x['影響工期天數'] || 0) !== 0 && !x['進度調整'], fv: fv_('客戶指示', x)
  })).sort((a, b) => ((b.date || '') + b.created).localeCompare((a.date || '') + a.created));
  const checks = tryTable_('查驗紀錄').filter(x => x['案件ID'] === p.id).map(x => ({
    id: x['紀錄ID'], item: x['工序ID'], point: x['查驗點'], checkId: x['檢查ID'], label: x['檢查項目'], photo: x['照片'], done: x['完成'] === 'Y',
    status: x['狀態'], note: x['備註'], by: x['檢查人'], at: x['檢查時間']
  }));
  const checkTpl = tryTable_('範本_查驗清單').filter(t => t['啟用'] !== 'N').map(t => ({ id: t['檢查ID'], point: t['查驗點'], order: +t['順序'] || 0, label: t['檢查項目'], photo: t['需拍照'] === 'Y' }));
  const sop = tryTable_('案件SOP').filter(x => x['案件ID'] === p.id).map(x => ({ id: x['ID'], tpl: x['項目ID'], label: x['項目'], done: x['完成'] === 'Y', date: x['完成日'], by: x['完成人'], note: x['備註'], role: x['負責角色'], order: +x['順序'] || 0 }))
    .sort((a, b) => a.order - b.order);
  const ms = tryTable_('里程碑').filter(x => x['案件ID'] === p.id).map(x => ({
    id: x['任務ID'], stage: x['階段'], name: x['名稱'], owner: x['負責人'], base: x['原定日期'], due: x['目前期限'], done: x['完成日'],
    status: x['狀態'], returns: +x['退回次數'] || 0, why: x['改期原因'], note: x['備註'], order: +x['順序'] || 0, rev: rev_('里程碑', x), fv: fv_('里程碑', x)
  })).sort((a, b) => (a.due || '9').localeCompare(b.due || '9') || a.order - b.order);
  return { info: c, canEdit: canEditCase_(me, c), canMoney: canEditMoney_(me), canPlan: canPlan_(me, c), logs, ins, todos, plan, planLog, meetings, cins, checks, checkTpl, sop, ms,
    settings: settings_(), closed: c['階段'] === '結案',
    repairs: tryTable_('保固報修').filter(x => x['案件ID'] === p.id).map(x => ({ id: x['報修ID'], date: x['報修日期'], text: x['內容'], owner: x['負責人'], status: x['狀態'], result: x['處理結果'], done: x['完成日'], by: x['記錄人'], rev: rev_('保固報修', x), fv: fv_('保固報修', x) }))
      .sort((a, b) => String(b.date).localeCompare(String(a.date))),
    docs: tryTable_('文件紀錄').filter(x => x['案件ID'] === p.id).map(x => ({ id: x['文件ID'], date: x['日期'], name: x['文件名稱'], type: x['文件類型'], url: x['檔案連結'], by: x['產生人'], at: x['產生時間'] || x['日期'] }))
      .sort((a, b) => String(b.at).localeCompare(String(a.at))),
    planLocked: c['進度定案時間'] || '', planLockedBy: c['進度定案人'] || '' };
}

function getThumbs_(me, p) {
  const out = {};
  (p.paths || []).forEach(path => {
    try {
      const it = dirFor_(path).getFilesByName(String(path).split('/').pop());
      if (!it.hasNext()) return;
      const f = it.next(), blob = f.getThumbnail() || f.getBlob();
      out[path] = { src: 'data:image/jpeg;base64,' + Utilities.base64Encode(blob.getBytes()), url: f.getUrl() };
    } catch (e) { }
  });
  return out;
}

const _dirs = {};
/** 試算表所在資料夾下的子資料夾（沒有就建立），例如 日誌照片_Images、客戶確認_Images */
function subDir_(name) {
  if (_dirs[name]) return _dirs[name];
  const parent = testRoot_();
  const it = parent.getFoldersByName(name);
  return (_dirs[name] = it.hasNext() ? it.next() : parent.createFolder(name));
}
function photoDir_() { return subDir_(PHOTO_DIR); }
function dirFor_(path) { const d = String(path).split('/')[0]; return d === CONFIRM_DIR ? subDir_(CONFIRM_DIR) : photoDir_(); }

/* ========== 寫入：日誌 ========== */

/**
 * 照片先全部上傳到雲端；任何一張失敗，就把這次已上傳的檔案收回並停止，試算表一筆都不寫。
 * 這樣使用者看到「失敗」時，資料就真的沒有變；再按一次儲存不會多出一篇日誌或重複照片。
 */
function uploadPhotos_(photos) {
  const done = [];
  if (!photos || !photos.length) return done;
  try {
    const dir = photoDir_();
    photos.forEach(ph => {
      const pid = uid_(), name = pid + '.照片.' + fmt_(new Date(), 'HHmmss') + '.jpg';
      const file = dir.createFile(Utilities.newBlob(Utilities.base64Decode(ph.data), 'image/jpeg', name));
      done.push({ pid: pid, name: name, note: ph.note || '', file: file });
    });
  } catch (e) {
    done.forEach(x => { try { x.file.setTrashed(true); } catch (e2) { } });
    throw new Error('照片上傳失敗，這次沒有存任何資料，請再按一次儲存（' + e.message + '）');
  }
  return done;
}
function photoRows_(caseId, logId, ups) {
  ups.forEach(x => appendRow_('日誌照片', { '照片ID': x.pid, '日誌ID': logId, '案件ID': caseId, '照片': PHOTO_DIR + '/' + x.name, '說明': x.note, '拍攝時間': now_() }));
}

/** 新增日誌。d.submit = true 時直接送出，否則存成草稿。建立時間之後不能改，用來判斷補登。 */
function saveLog_(me, d) {
  if (!d.caseId) throw new Error('缺少案件');
  const id = uid_();
  const row = {
    '日誌ID': id, '案件ID': d.caseId, '日期': ymd_(d.date) || today_(), '工種': (d.trades || []).join(' , '),
    '今日狀況': d.text || '', '發現問題': d.issue || '', '填寫人': me.id, '建立時間': now_(), '修改次數': 0,
    '日誌狀態': LS.DRAFT, '分享次數': 0
  };
  if (d.submit) Object.assign(row, submitPatch_(me.id, caseRow_(d.caseId)));
  const ups = uploadPhotos_(d.photos);   // 先上傳；失敗就整筆不存
  photoRows_(d.caseId, id, ups);
  appendRow_('工程日誌', row);   // 日誌最後才寫：照片列先寫，萬一這裡失敗也不會出現半篇日誌
  return id;
}

/**
 * 修改日誌：每個人都能改。
 * 已簽核過的日誌：改到 日期／工種／施工內容／問題 → 回到待簽核（主管只看差異）；
 * 只新增照片 → 不必重簽，主管那邊出現「已修改」提示。
 */
function updateLog_(me, d) {
  const l = getLog_(d.id), st = logStatus_(l), snap = parseSnap_(l);
  // 舊照片：刪除與說明修改都跟著這次「儲存」一起生效（關掉表單不存＝什麼都沒變）
  const mine = tryTable_('日誌照片').filter(x => x['日誌ID'] === d.id && !x['刪除時間']);
  const dels = (d.delPhotos || []).filter(id => mine.some(x => x['照片ID'] === id));
  const notes = d.notes || {}, noteIds = Object.keys(notes).filter(id => mine.some(x => x['照片ID'] === id && String(x['說明'] || '') !== String(notes[id] || '').trim()) && dels.indexOf(id) < 0);
  const patch = {
    '日期': ymd_(d.date), '工種': (d.trades || []).join(' , '), '今日狀況': d.text || '', '發現問題': d.issue || '',
    '最後修改時間': now_(), '修改次數': (+l['修改次數'] || 0) + 1, '最後修改人': me.id
  };
  if (snap && st !== LS.DRAFT) {
    const delSigned = dels.some(id => (snap.photos || []).some(p => p.id === id));   // 刪掉已簽核內容裡的照片＝重大修改
    const major = snap.date !== patch['日期'] || snap.trades !== patch['工種'] || snap.text !== patch['今日狀況'] || snap.issue !== patch['發現問題'] || delSigned;
    if (major) Object.assign(patch, resignPatch_(l));
    else if (((d.photos && d.photos.length) || noteIds.length || dels.length) && st === LS.SIGNED) { patch['小修待看'] = 'Y'; patch['修訂時間'] = now_(); }   // 加照片、改說明＝小修
  } else if (d.submit && st === LS.DRAFT) {
    Object.assign(patch, snap ? resignPatch_(l) : submitPatch_(l['填寫人'], caseRow_(l['案件ID'])));
  }
  const ups = uploadPhotos_(d.photos);   // 新照片先上傳；失敗就停在這裡，刪除、改說明、內容修改都不會生效
  updateRow_('工程日誌', '日誌ID', d.id, patch);
  dels.forEach(id => updateRow_('日誌照片', '照片ID', id, { '刪除時間': now_(), '刪除人': me.id }));
  noteIds.forEach(id => updateRow_('日誌照片', '照片ID', id, { '說明': String(notes[id] || '').trim(), '說明修改人': me.id, '說明修改時間': now_() }));
  photoRows_(l['案件ID'], d.id, ups);
  return d.id;
}

/** 刪除照片：不真的刪檔，只標記刪除（可追溯）。已簽核內容裡的照片被刪 → 需重新簽核 */
function deletePhoto_(me, d) {
  const ph = rowObj_(findRow_('日誌照片', '照片ID', d.id));
  updateRow_('日誌照片', '照片ID', d.id, { '刪除時間': now_(), '刪除人': me.id });
  const l = getLog_(ph['日誌ID']), snap = parseSnap_(l);
  const patch = { '最後修改時間': now_(), '最後修改人': me.id, '修改次數': (+l['修改次數'] || 0) + 1 };
  if (snap && logStatus_(l) !== LS.DRAFT && (snap.photos || []).some(p => p.id === d.id)) Object.assign(patch, resignPatch_(l));
  updateRow_('工程日誌', '日誌ID', ph['日誌ID'], patch);
  return true;
}

/** 草稿送出 */
function submitLog_(me, d) {
  const l = getLog_(d.id);
  if (logStatus_(l) !== LS.DRAFT) throw new Error('這篇已經送出');
  if (l['填寫人'] !== me.id && !me.leader) throw new Error('只有填寫人可以送出');
  updateRow_('工程日誌', '日誌ID', d.id, parseSnap_(l) ? resignPatch_(l) : submitPatch_(l['填寫人'], caseRow_(l['案件ID'])));
  return true;
}

/** 負責設計師確認（別人填寫的日誌）→ 待簽核 */
function confirmLog_(me, d) {
  const l = getLog_(d.id), c = caseRow_(l['案件ID']);
  if (logStatus_(l) !== LS.DESIGNER) throw new Error('這篇不在待設計師確認');
  if ((c && c['負責設計師']) !== me.id && me.role !== 'Boss') throw new Error('只有案件負責設計師可以確認');
  updateRow_('工程日誌', '日誌ID', d.id, pendingPatch_(l['填寫人']));
  return true;
}

/** 主管簽核通過 = 正式發布：記錄簽核內容、產生 PDF 存檔 */
function signLog_(me, d) {
  const l = getLog_(d.id);
  if (logStatus_(l) === LS.SIGNED && l['簽核者'] === me.id) return { already: true };   // 重按：告訴畫面「已經簽好了」，不當成錯誤
  if (logStatus_(l) !== LS.PENDING) throw new Error('這篇不在待簽核');
  if (!canSign_(me, l)) throw new Error('這篇不是由你簽核');
  const patch = {
    '日誌狀態': LS.SIGNED, '簽核者': me.id, '簽核時間': now_(),
    '簽核內容': JSON.stringify(snapshot_(l, activePhotos_(d.id))), '修改待簽': '', '小修待看': '', '退回原因': ''
  };
  if (l['簽核內容']) patch['修訂時間'] = now_();
  patch['PDF錯誤'] = '';
  updateRow_('工程日誌', '日誌ID', d.id, patch);
  // 簽核到這裡就完成並存檔了；PDF 由畫面另外呼叫 buildLogPdf 在背景產生（產得慢也不影響「已簽核」）
  return { signed: true, at: patch['簽核時間'] };
}

/** 日誌 PDF 是否為最新：有檔案，且產生時間不早於簽核／修訂時間 */
/** 這篇日誌的主管指示最後一次變動時間（下指示、回報、結案）：PDF 裡有指示與回報，變動後 PDF 要更新 */
function insAtMap_(cid) {
  const m = {};
  tryTable_('主管指示').filter(i => i['案件ID'] === cid && i['日誌ID']).forEach(i => {
    const t = [i['建立時間'], i['回報時間'], i['結案時間']].map(x => String(x || '')).sort().pop();
    if (t > (m[i['日誌ID']] || '')) m[i['日誌ID']] = t;
  });
  return m;
}
/** PDF 內容需要「至少」到哪個時間點：簽核／修訂時間與指示最後變動時間取較晚者 */
function pdfNeed_(l, insAt) {
  return [l['修訂時間'] || l['簽核時間'] || '', insAt === undefined ? (insAtMap_(l['案件ID'])[l['日誌ID']] || '') : (insAt || '')].map(String).sort().pop();
}
function pdfFresh_(l, insAt) {
  if (!l['PDF檔ID'] || !l['PDF時間']) return false;
  // PDF時間 是「開始產檔」的時間，而且一定晚於之前的所有修改；之後的修改時間 ≥ 它，所以用「嚴格晚於」判斷
  return String(l['PDF時間']) > pdfNeed_(l, insAt);
}
/** 產生 PDF 時用到的所有內容（日誌、照片、指示、案件名稱）；產檔前後比對，有變就不能標成最新 */
const PDF_FP_COLS = ['日期', '工種', '今日狀況', '發現問題', '填寫人', '日誌狀態', '簽核者', '簽核時間', '修訂時間'];
function pdfFp_(logId) {
  const l = getLog_(logId), c = caseRow_(l['案件ID']) || {};
  const ins = tryTable_('主管指示').filter(i => i['案件ID'] === l['案件ID']);
  return JSON.stringify([PDF_FP_COLS.map(k => l[k]), c['案件名稱'] || '', c['地址'] || '', activePhotos_(logId), ins]);
}
function pdfState_(l, insAt) {
  if (logStatus_(l) !== LS.SIGNED) return '';
  if (pdfFresh_(l, insAt)) return 'ready';
  return l['PDF錯誤'] ? 'failed' : 'pending';
}
/** 背景產生日誌 PDF（簽核人、負責設計師、主管可做）。已是最新就不重產；失敗會記錄原因，畫面顯示「失敗，重試」 */
function buildLogPdf_(me, d) {
  const l = getLog_(d.id), c = caseRow_(l['案件ID']);
  if (logStatus_(l) !== LS.SIGNED) throw new Error('這篇尚未簽核，不能產生 PDF');
  if (!(l['簽核者'] === me.id || canShare_(me, c) || me.leader)) throw new Error('你不能產生這篇的 PDF');
  const r = ensureLogPdf_(d.id);
  const now = getLog_(d.id);
  return { ready: pdfFresh_(now), at: now['PDF時間'], already: r.already };
}

/**
 * 確保這篇有最新的 PDF，回傳檔案。
 * 同一篇同時只會有一個人在產：另一個人會等前一個做完，直接用那份，不會多產一份。
 */
const PDF_WAIT_MS = 120000;
function ensureLogPdf_(id) {
  const cache = CacheService.getScriptCache(), key = 'pdfb_' + id, me = Utilities.getUuid();
  const t0 = Date.now();
  for (;;) {
    const st = withLock_(() => {
      const l = getLog_(id);
      if (pdfFresh_(l)) { const f = pdfFile_(l); if (f) return { file: f }; }
      if (cache.get(key)) return { wait: true };
      cache.put(key, me, 300);   // 我來產（5 分鐘內有效，避免當掉後永遠卡住）
      return { mine: true };
    });
    if (st.file) return { file: st.file, already: true };
    if (st.mine) break;
    if (Date.now() - t0 > PDF_WAIT_MS) throw new Error('別人正在產生這篇的 PDF，請稍後再試');
    Utilities.sleep(2000);
  }
  try {
    const file = makePdf_(id);
    withLock_(() => updateRow_('工程日誌', '日誌ID', id, { 'PDF錯誤': '' }));
    return { file: file, already: false };
  } catch (e) {
    withLock_(() => updateRow_('工程日誌', '日誌ID', id, { 'PDF錯誤': now_() + ' ' + e.message }));
    throw new Error('PDF 產生失敗：' + e.message + '（簽核已完成，不受影響，可以重試）');
  } finally {
    try { if (cache.get(key) === me) cache.remove(key); } catch (e) { }
  }
}
/** 紀錄裡的 PDF 檔還在才回傳 */
function pdfFile_(l) {
  if (!l['PDF檔ID']) return null;
  try { const f = TDrive.getFileById(l['PDF檔ID']); if (f.isTrashed()) return null; f.getName(); return f; } catch (e) { return null; }
}

/** 退回修改（內容明顯有誤、不適合發布） */
function returnLog_(me, d) {
  const l = getLog_(d.id);
  if (logStatus_(l) !== LS.PENDING && logStatus_(l) !== LS.DESIGNER) throw new Error('這篇目前不能退回');
  const c = caseRow_(l['案件ID']);
  if (!canSign_(me, l) && !(logStatus_(l) === LS.DESIGNER && c && c['負責設計師'] === me.id)) throw new Error('你不能退回這篇');
  updateRow_('工程日誌', '日誌ID', d.id, { '日誌狀態': LS.DRAFT, '退回原因': d.text || '請修改後再送出', '簽核期限': '' });
  return true;
}

/** 主管把重大異常、費用爭議、重要決策轉給 Boss 確認 */
function escalateLog_(me, d) {
  const l = getLog_(d.id);
  if (logStatus_(l) !== LS.PENDING || signerOf_(l) !== me.id || me.role === 'Boss') throw new Error('目前不能轉給 Boss');
  updateRow_('工程日誌', '日誌ID', d.id, { '簽核人': bossId_(), '轉Boss確認': 'Y' });
  return true;
}

/** 主管看過小修（新增照片）後消除提示 */
function seenLog_(me, d) {
  const l = getLog_(d.id);
  if (l['小修待看'] === 'Y' && canSign_(me, l)) updateRow_('工程日誌', '日誌ID', d.id, { '小修待看': '' });
  return true;
}

/** 分享前取得 PDF：以當下狀態重新產生（覆蓋舊檔），回傳檔案內容 */
function pdfLog_(me, d) {
  const l = getLog_(d.id);
  if (logStatus_(l) !== LS.SIGNED) throw new Error('這篇尚未簽核，或修改後待主管確認，暫時不能分享');
  if (!canShare_(me, caseRow_(l['案件ID']))) throw new Error('只有案件負責設計師或主管可以分享');
  const file = ensureLogPdf_(d.id).file;
  const now = getLog_(d.id);
  return { name: file.getName(), data: Utilities.base64Encode(file.getBlob().getBytes()), url: file.getUrl(), fresh: pdfFresh_(now) };
}

/**
 * 記錄 PDF 的分享或下載操作（兩者分開記錄；分享操作完成不代表客戶已收到）。
 * d.kind = 'share'（手機分享選單完成）或 'download'（下載檔案）。只累加，不重算、不清除歷史。
 */
function shareLog_(me, d) {
  if (d.kind !== 'share' && d.kind !== 'download') throw new Error('不明的紀錄類型');
  const l = getLog_(d.id);
  if (!canShare_(me, caseRow_(l['案件ID']))) throw new Error('只有案件負責設計師或主管可以分享');
  if (logStatus_(l) !== LS.SIGNED) throw new Error('這篇尚未簽核，或修改後待主管確認，不能分享');
  if (!pdfFresh_(l)) throw new Error('PDF 不是最新版本，請先更新 PDF 再分享');
  if (!pdfFile_(l)) throw new Error('找不到這篇的 PDF 檔，請先產生 PDF');
  if (d.kind === 'download') updateRow_('工程日誌', '日誌ID', d.id, { '下載次數': (+l['下載次數'] || 0) + 1, '最後下載人': me.id, '最後下載時間': now_() });
  else updateRow_('工程日誌', '日誌ID', d.id, { '分享次數': (+l['分享次數'] || 0) + 1, '最後分享人': me.id, '最後分享時間': now_() });
  return true;
}

/** 唯讀查看既有 PDF：只回傳已存檔的檔案，不重新產生；預覽模式也走這裡 */
function pdfView_(me, d) {
  const l = getLog_(d.id);
  if (!l['PDF檔ID']) throw new Error('這篇還沒有 PDF 檔（主管簽核後才會產生）');
  let f;
  try { f = TDrive.getFileById(l['PDF檔ID']); } catch (e) { f = null; }
  if (!f || f.isTrashed()) throw new Error('找不到這篇的 PDF 檔，可能已被移除');
  return { name: f.getName(), url: f.getUrl(), at: l['PDF時間'] };
}

/* ========== PDF ========== */

function caseDir_(c) {
  const m = String(c['Drive資料夾'] || '').match(/folders\/([\w-]+)/);
  if (m) return TDrive.getFolderById(m[1]);   // ★ 測試環境：不在測試資料夾底下就拒絕
  const parent = testRoot_();
  const it = parent.getFoldersByName(CASE_ROOT), root = it.hasNext() ? it.next() : parent.createFolder(CASE_ROOT);
  const it2 = root.getFoldersByName(c['案件名稱']), dir = it2.hasNext() ? it2.next() : root.createFolder(c['案件名稱']);
  updateRow_('案件', '案件ID', c['案件ID'], { 'Drive資料夾': dir.getUrl() });
  return dir;
}
function logPdfDir_(c) {
  const d = caseDir_(c), it = d.getFoldersByName(LOG_PDF_DIR);
  return it.hasNext() ? it.next() : d.createFolder(LOG_PDF_DIR);
}
function logoData_() {
  const cache = CacheService.getScriptCache();
  let s = cache.get('logo');
  if (!s) {
    try { s = Utilities.base64Encode(UrlFetchApp.fetch(APP_URL + 'icons/logo.png').getContent()); cache.put('logo', s, 21600); }
    catch (e) { s = ''; }
  }
  return s ? 'data:image/png;base64,' + s : '';
}
function photoData_(path) {
  try {
    const it = dirFor_(path).getFilesByName(String(path).split('/').pop());
    if (it.hasNext()) { const b = it.next().getBlob(); return 'data:' + (b.getContentType() || 'image/jpeg') + ';base64,' + Utilities.base64Encode(b.getBytes()); }
  } catch (e) { }
  return '';
}

/** 產生日誌 PDF，存到「案件資料夾／工程日誌」，覆蓋舊檔 */
function makePdf_(logId) {
  // 開始前記下內容版本；產完後再比一次，期間有人下指示、回報或改日誌，就不標成最新（維持「待更新」）
  const pre = withLock_(() => {
    Utilities.sleep(1020 - (Date.now() % 1000));   // 時間只記到秒：等到下一秒才開始，確保開始時間晚於之前所有修改
    return { at: now_(), fp: pdfFp_(logId) };
  });
  const l = getLog_(logId), c = caseRow_(l['案件ID']);
  if (!c) throw new Error('找不到案件');
  const photos = activePhotos_(logId);
  const logs = readTable_('工程日誌').filter(x => x['案件ID'] === l['案件ID']);
  const dateOf = id => (logs.find(x => x['日誌ID'] === id) || {})['日期'] || '';
  const allIns = readTable_('主管指示').filter(i => i['案件ID'] === l['案件ID'] && i['指示內容']);
  allIns.forEach(i => i['狀態'] = insStatus_(i['狀態']));
  const ins = allIns.filter(i => i['日誌ID'] === logId);
  const track = allIns.filter(i => i['日誌ID'] && i['日誌ID'] !== logId && i['狀態'] !== IS.CLOSED && dateOf(i['日誌ID']) && dateOf(i['日誌ID']) < l['日期']);
  const html = pdfHtml_(l, c, photos, ins, track, dateOf);
  const name = '工程日誌_' + c['案件名稱'] + '_' + String(l['日期']).replace(/\//g, '-') + '_' + logId.slice(0, 4) + '.pdf';
  const blob = Utilities.newBlob(html, 'text/html', 'log.html').getAs('application/pdf').setName(name);
  const dir = logPdfDir_(c);
  const file = dir.createFile(blob);   // 先建好新檔；失敗就停在這裡，舊檔和紀錄都不動
  return withLock_(() => {
    const cur = getLog_(logId);
    // 別人在這段期間已經存了一份同樣新或更新的 PDF：用他的，收回我這份，不留孤兒檔
    if (cur['PDF檔ID'] && cur['PDF檔ID'] !== l['PDF檔ID'] && pdfFresh_(cur) && pdfFile_(cur)) {
      try { file.setTrashed(true); } catch (e) { }
      return pdfFile_(cur);
    }
    const same = pdfFp_(logId) === pre.fp;
    // PDF時間記「開始產檔」的時間；內容在產檔期間變了就留空＝待更新
    updateRow_('工程日誌', '日誌ID', logId, { 'PDF檔ID': file.getId(), 'PDF時間': same ? pre.at : '' });
    if (cur['PDF檔ID'] && cur['PDF檔ID'] !== file.getId()) { try { TDrive.getFileById(cur['PDF檔ID']).setTrashed(true); } catch (e) { } }   // 新檔與紀錄都成功後才回收「目前紀錄上」的舊檔
    return file;
  });
}

function sec_(title, blocks) { return blocks.length ? '<div class="keep"><h2>' + h_(title) + '</h2>' + blocks[0] + '</div>' + blocks.slice(1).join('') : ''; }
function pdfHtml_(l, c, photos, ins, track, dateOf) {
  const logo = logoData_();
  const row = (k, v) => v ? '<tr><td class="k">' + h_(k) + '</td><td>' + h_(v) + '</td></tr>' : '';
  const stCls = s => s === IS.CLOSED ? 'ok' : s === IS.REPLIED ? 'wait' : 'todo';
  const stTxt = s => s === IS.REPLIED ? '已回報，待主管確認' : s;
  const insBlock = i => '<div class="ins"><div class="it">' + h_(i['指示內容']) + '　<span class="st ' + stCls(i['狀態']) + '">' + h_(stTxt(i['狀態'])) + '</span></div>'
    + '<div class="im">下指示：' + h_(pname_(i['下指示人'])) + (i['負責人'] ? '　負責人：' + h_(pname_(i['負責人'])) : '') + (i['期限'] ? '　期限：' + h_(i['期限']) : '') + '</div>'
    + (i['回報內容'] ? '<div class="rp">處理回報：' + h_(i['回報內容']) + '</div>' : '') + '</div>';
  const ph = [];   // 每兩張照片一列
  for (let k = 0; k < photos.length; k += 2) {
    ph.push('<tr>' + [photos[k], photos[k + 1]].map(p => p ? '<td><img src="' + photoData_(p['照片']) + '" width="240"><div class="pn">' + h_(p['說明'] || [p['空間'], p['位置']].filter(String).join('・')) + '</div></td>' : '<td></td>').join('') + '</tr>');
  }
  const signed = l['簽核者'] ? pname_(l['簽核者']) + '（' + String(l['簽核時間']).slice(0, 16) + '）' : '';
  return '<html><head><meta charset="utf-8"><style>'
    + 'body{font-family:"Noto Sans TC","Noto Sans CJK TC","Microsoft JhengHei",sans-serif;color:#2b2724;font-size:10.5pt;line-height:1.6}'
    + '.hd{width:100%;border-bottom:1.5pt solid #AF9263;padding-bottom:6pt}.hd td{vertical-align:bottom}'
    + '.tt{font-size:18pt;letter-spacing:3pt;font-weight:bold;text-align:right}.ts{font-size:9pt;color:#8a7f75;text-align:right}'
    + 'table.info{width:100%;border-collapse:collapse;margin-top:12pt}table.info td{border:0.6pt solid #e2d9cc;padding:4pt 7pt;font-size:10pt}'
    + 'table.info td.k{background:#f7f4ef;width:72pt;color:#7a7067}'
    + 'h2{font-size:11.5pt;margin:16pt 0 6pt;padding-left:6pt;border-left:3pt solid #AF9263}'
    + '.txt{white-space:pre-wrap}.issue{background:#f9ece9;color:#8a2f25;padding:6pt 9pt;white-space:pre-wrap}'
    + 'table.ph{width:100%}table.ph td{width:50%;vertical-align:top;padding:4pt}.pn{font-size:9pt;color:#5a5048;margin-top:2pt}'
    + '.ins{border:0.6pt solid #e2d9cc;padding:6pt 9pt;margin-bottom:6pt}.it{font-weight:bold}.im{font-size:9pt;color:#7a7067}'
    + '.rp{font-size:9.5pt;margin-top:3pt;background:#f7f4ef;padding:3pt 6pt;white-space:pre-wrap}'
    + '.st{font-size:8.5pt;font-weight:normal;padding:1pt 5pt}.st.ok{color:#4f7a5c}.st.wait{color:#b9773a}.st.todo{color:#5b6f8c}'
    + '.foot{margin-top:22pt;border-top:0.6pt solid #e2d9cc;padding-top:5pt;font-size:8.5pt;color:#8a7f75;page-break-inside:avoid}'
    + '.keep,.ins,table.ph tr{page-break-inside:avoid}h2{page-break-after:avoid}'
    + '</style></head><body>'
    + '<table class="hd"><tr><td>' + (logo ? '<img src="' + logo + '" height="62">' : '<b>浩森設計 HOUSEN</b>') + '</td>'
    + '<td><div class="tt">工程日誌</div><div class="ts">' + h_(c['案件名稱']) + '　' + h_(l['日期']) + '</div></td></tr></table>'
    + '<table class="info">' + row('案件名稱', c['案件名稱']) + row('施工地點', c['地址']) + row('施工日期', l['日期'])
    + row('工種', String(l['工種'] || '').split(/\s*,\s*/).join('、')) + row('填寫人', pname_(l['填寫人'])) + row('主管簽核', signed) + '</table>'
    + '<h2>施工內容</h2><div class="txt">' + (h_(l['今日狀況']) || '（無）') + '</div>'
    + (l['發現問題'] ? '<h2>現場問題</h2><div class="issue">' + h_(l['發現問題']) + '</div>' : '')
    // 分頁：標題和它的第一個區塊放在一起，不讓標題單獨留在頁尾；每個指示框、每列照片不切成兩半
    + (ph.length ? '<div class="keep"><h2>現場照片</h2><table class="ph">' + ph[0] + '</table></div>' + (ph.length > 1 ? '<table class="ph">' + ph.slice(1).join('') + '</table>' : '') : '')
    + sec_('主管指示', ins.map(insBlock))
    + sec_('追蹤中事項', track.map(i => '<div class="keep"><div class="im">源自 ' + h_(dateOf(i['日誌ID'])) + ' 日誌</div>' + insBlock(i) + '</div>'))
    + '<div class="foot">狀態截至 ' + fmt_(new Date(), 'yyyy/MM/dd HH:mm') + (l['修訂時間'] ? '　・修訂於 ' + h_(String(l['修訂時間']).slice(0, 10)) : '')
    + '<br>浩森設計 HOUSEN INTERIOR DESIGN</div>'
    + '</body></html>';
}

/* ========== 寫入：指示、待辦、案件、工種 ========== */

function saveIns_(me, d) {
  if (!me.leader) throw new Error('只有主管可以下指示');
  if (!d.text) throw new Error('請填寫指示內容');
  const id = uid_();
  appendRow_('主管指示', {
    '指示ID': id, '案件ID': d.caseId, '日誌ID': d.logId || '', '指示內容': d.text, '負責人': d.to || '',
    '期限': ymd_(d.due), '狀態': IS.TODO, '退回次數': 0, '下指示人': me.id, '建立時間': now_()
  });
  return id;
}

/** 指示：待處理 →（負責人回報）已回報 →（下指示人確認）已結案；退回回到待處理 */
function actIns_(me, d) {
  const f = findRow_('主管指示', '指示ID', d.id), g = c => f.vals[f.head.indexOf(c)];
  if (d.act === 'reply') {
    if (g('負責人') !== me.id) throw new Error('只有負責人可以回報');
    updateRow_('主管指示', '指示ID', d.id, { '回報內容': d.text || '', '回報時間': now_(), '狀態': IS.REPLIED });
  } else if (d.act === 'close' || d.act === 'return') {
    if (g('下指示人') !== me.id && me.role !== 'Boss') throw new Error('只有下指示的人可以結案或退回');
    if (d.act === 'close') updateRow_('主管指示', '指示ID', d.id, { '狀態': IS.CLOSED, '結案時間': now_() });
    else updateRow_('主管指示', '指示ID', d.id, {
      '狀態': IS.TODO, '退回次數': (+g('退回次數') || 0) + 1,
      '回報內容': (d.text ? '【退回】' + d.text + '\n' : '') + (g('回報內容') || '')
    });
  }
  return true;
}

/** 待辦：自己建給自己；主管可以指派給別人 */
function saveTodo_(me, d) {
  if (!d.text) throw new Error('請填寫待辦內容');
  const to = d.to || me.id;
  if (to !== me.id && !me.leader) throw new Error('只能建立自己的待辦');
  const id = uid_();
  appendRow_('待辦', { '待辦ID': id, '案件ID': d.caseId || '', '內容': d.text, '負責人': to, '期限': ymd_(d.due), '狀態': '未完成', '建立人': me.id, '建立時間': now_() });
  return id;
}

function setTodo_(me, d) {
  const f = findRow_('待辦', '待辦ID', d.id), g = c => f.vals[f.head.indexOf(c)];
  if (g('負責人') !== me.id && g('建立人') !== me.id) throw new Error('只能更新自己的待辦');
  updateRow_('待辦', '待辦ID', d.id, d.done ? { '狀態': '已完成', '完成時間': now_() } : { '狀態': '未完成', '完成時間': '' });
  return true;
}

/** 新增案件：暫定主管、行政可以（權限表待 Boss 確認） */
const CASE_CREATE_ROLES = ['Boss', '主管', '行政'];
function saveCase_(me, d) {
  if (CASE_CREATE_ROLES.indexOf(me.role) < 0) throw new Error('只有主管或行政可以新增案件');
  if (!d.name) throw new Error('請填寫案件名稱');
  const id = uid_();
  appendRow_('案件', {
    '案件ID': id, '案件名稱': d.name, '客戶姓名': d.client || '', '客戶電話': d.phone || '', '地址': d.address || '',
    '類型': d.type || '', '來源': d.source || '', '負責設計師': d.designer || '', '階段': '洽談', '狀態': '進行中', '建立日期': today_()
  });
  return id;
}

function setStage_(me, d) {
  if (!me.leader) throw new Error('只有主管可以改案件階段');
  const c = caseRow_(d.id), patch = { '階段': d.stage, '最後修改時間': now_(), '最後修改人': me.id };
  if (d.stage === '結案' && c) {   // 結案：補上結案日與保固到期日（保固年限在公司設定）
    const end = c['結案日'] || today_();
    patch['結案日'] = end;
    if (!c['保固到期日']) { const p = end.split('/'); patch['保固到期日'] = (+p[0] + (+setting_('保固年限', 1) || 1)) + '/' + p[1] + '/' + p[2]; }
  }
  updateRow_('案件', '案件ID', d.id, patch);
  return true;
}

/* ========== 結案後唯讀 ==========
 * 案件在「結案」階段時，日誌、指示、進度、客戶紀錄都不能再新增或修改；
 * 仍可：改階段（主管重新開啟）、修改案件資料、保固報修、產生報告。
 */
const CLOSED_OK = ['setStage', 'saveCaseInfo', 'saveRepair', 'saveTodo', 'setTodo', 'saveCase', 'saveTrade', 'shareLog',
  'saveSetting', 'saveTemplateRow', 'suggestTemplate', 'setSuggestion'];
/**
 * 找出這次動作真正影響的案件：一律從「目標紀錄」查出所屬案件，不相信畫面傳來的 caseId。
 * 傳來的 caseId 與目標紀錄不同案 → 拒絕；查到後把 payload.caseId 改成真正的案件，後面的權限檢查就以它為準。
 * 編輯類動作若帶 rev（畫面開啟時的版本），與目前內容不同 → 拒絕，避免舊畫面蓋掉別人剛存的內容。
 */
const REF = {
  updateLog: [['id', '工程日誌', '日誌ID']], submitLog: [['id', '工程日誌', '日誌ID']], confirmLog: [['id', '工程日誌', '日誌ID']],
  signLog: [['id', '工程日誌', '日誌ID']], returnLog: [['id', '工程日誌', '日誌ID']], escalateLog: [['id', '工程日誌', '日誌ID']],
  seenLog: [['id', '工程日誌', '日誌ID']], shareLog: [['id', '工程日誌', '日誌ID']], pdfLog: [['id', '工程日誌', '日誌ID']], buildLogPdf: [['id', '工程日誌', '日誌ID']],
  deletePhoto: [['id', '日誌照片', '照片ID']],
  saveIns: [['logId', '工程日誌', '日誌ID']], actIns: [['id', '主管指示', '指示ID']], setTodo: [['id', '待辦', '待辦ID']],
  savePlanItem: [['id', '進度計畫', '工序ID']], cancelPlanItem: [['id', '進度計畫', '工序ID']], setActualStart: [['id', '進度計畫', '工序ID']],
  setDone: [['id', '進度計畫', '工序ID']], saveCheck: [['itemId', '進度計畫', '工序ID']],
  saveMeeting: [['id', '會議', '會議ID']], reviewMeeting: [['id', '會議', '會議ID']],
  saveClientIns: [['id', '客戶指示', '指示ID'], ['meetingId', '會議', '會議ID']], confirmClientIns: [['id', '客戶指示', '指示ID']], actClientIns: [['id', '客戶指示', '指示ID']],
  setSop: [['id', '案件SOP', 'ID']], saveMilestone: [['id', '里程碑', '任務ID']], setMilestone: [['id', '里程碑', '任務ID']],
  saveRepair: [['id', '保固報修', '報修ID']], clientPdf: [['meetingId', '會議', '會議ID'], ['insId', '客戶指示', '指示ID']]
};
const CASE_IS_ID = ['setStage', 'saveCaseInfo'];
/** 版本比對用的欄位（只看內容，不看已讀、下載這類欄位） */
const REV_COLS = {
  '工程日誌': ['日期', '工種', '今日狀況', '發現問題', '修改次數'], '會議': ['日期', '會議名稱', '出席人', '錄音檔', 'AI摘要'],
  '客戶指示': ['日期', '內容', '影響費用或工期', '追加減金額', '影響工期天數', '鎖定', '執行人', '執行期限', '執行狀態', '處理回報'],
  '進度計畫': ['工序名稱', '工種', '目前計畫開始', '目前計畫完成', '狀態', '實際開始', '實際完成'],
  '里程碑': ['名稱', '負責人', '目前期限', '狀態'], '保固報修': ['內容', '負責人', '狀態', '處理結果']
};
const REV_CHECK = ['updateLog', 'saveMeeting', 'saveClientIns', 'savePlanItem', 'saveMilestone', 'saveRepair'];   // 沒附原值時的備用檢查
function rev_(table, r) {
  const s = (REV_COLS[table] || []).map(k => String(r[k] == null ? '' : r[k])).join('\u0001');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
/**
 * 逐欄合併：編輯表單送出時附上「打開時看到的原值」（orig）。
 * 你沒改的欄位 → 改用資料庫目前的值（保留同事剛補的內容）；
 * 你改了、同事也改了同一欄且內容不同 → 擋下並說明是哪一欄。
 * 欄位：[畫面送來的名稱, 資料表欄位, 類型]
 */
const FIELDS = {
  updateLog: [['date', '日期', 'date'], ['trades', '工種', 'list'], ['text', '今日狀況', 'text'], ['issue', '發現問題', 'text']],
  saveMeeting: [['date', '日期', 'date'], ['name', '會議名稱', 'text'], ['attendees', '出席人', 'text'], ['audio', '錄音檔', 'text'], ['summary', 'AI摘要', 'text']],
  saveClientIns: [['date', '日期', 'date'], ['text', '內容', 'text'], ['source', '來源', 'text'], ['impact', '影響費用或工期', 'bool'], ['amount', '追加減金額', 'num'], ['days', '影響工期天數', 'num'], ['owner', '執行人', 'text'], ['due', '執行期限', 'date']],
  savePlanItem: [['name', '工序名稱', 'text'], ['trade', '工種', 'text'], ['start', '目前計畫開始', 'date'], ['end', '目前計畫完成', 'date']],
  saveMilestone: [['name', '名稱', 'text'], ['owner', '負責人', 'text'], ['due', '目前期限', 'date']],
  saveRepair: [['status', '狀態', 'text'], ['result', '處理結果', 'text'], ['owner', '負責人', 'text']]
};
const FV_TABLE = { updateLog: '工程日誌', saveMeeting: '會議', saveClientIns: '客戶指示', savePlanItem: '進度計畫', saveMilestone: '里程碑', saveRepair: '保固報修' };
function fnorm_(type, v) {
  if (type === 'date') return v ? ymd_(v) || '' : '';
  if (type === 'list') return (Array.isArray(v) ? v : String(v == null ? '' : v).split(/\s*[,、，]\s*/)).map(x => String(x).trim()).filter(String).join(' , ');
  if (type === 'bool') return v === true || v === 'Y' ? 'Y' : 'N';
  if (type === 'num') return String(v == null ? '' : v).replace(/[^0-9.\-]/g, '');
  return String(v == null ? '' : v).trim();
}
function fback_(type, dbv) {   // 資料庫的值換回畫面送來的格式
  if (type === 'list') return fnorm_('list', dbv) ? fnorm_('list', dbv).split(' , ') : [];
  if (type === 'bool') return dbv === 'Y';
  return fnorm_(type, dbv);
}
/** 給畫面的「原值」：只放可編輯欄位 */
function fv_(table, r) {
  const o = {};
  Object.keys(FV_TABLE).forEach(a => { if (FV_TABLE[a] === table) FIELDS[a].forEach(f => { o[f[1]] = r[f[1]] == null ? '' : String(r[f[1]]); }); });
  return o;
}
function merge_(action, d, r) {
  const clash = [];
  (FIELDS[action] || []).forEach(([k, col, type]) => {
    if (!(col in d.orig) || d[k] === undefined) return;
    const nv = fnorm_(type, d[k]), ov = fnorm_(type, d.orig[col]), cv = fnorm_(type, r[col]);
    if (nv === ov) d[k] = fback_(type, r[col]);           // 你沒改：保留目前資料庫的內容（可能是同事剛改的）
    else if (cv !== ov && cv !== nv) clash.push(col);      // 同一欄兩人都改了，而且不一樣
  });
  if (clash.length) {
    const who = r['最後修改人'] ? pname_(r['最後修改人']) : '同事';
    throw new Error('「' + clash.join('、') + '」在你打開之後已被' + who + '改過，跟你改的不同。請關掉重新打開，看過最新內容再改。');
  }
}
function target_(action, d) {
  if (!d) return '';
  if (CASE_IS_ID.indexOf(action) >= 0) return d.id || '';
  const refs = REF[action] || [], found = [];
  refs.forEach(([field, table, key]) => {
    if (!d[field]) return;
    let r;
    try { r = rowObj_(findRow_(table, key, d[field])); } catch (e) { throw new Error('找不到這筆資料，可能已被刪除；請重新整理'); }
    found.push(r['案件ID'] || '');
    if (field === refs[0][0] && d.orig && typeof d.orig === 'object' && FIELDS[action]) { merge_(action, d, r); return; }
    if (field === refs[0][0] && d.rev && REV_CHECK.indexOf(action) >= 0 && rev_(table, r) !== d.rev) {
      const who = r['最後修改人'] ? pname_(r['最後修改人']) : '別人';
      throw new Error('這筆資料剛被' + who + '修改過，你畫面上的是舊內容。請關掉重新打開，確認後再改。');
    }
  });
  const ids = found.concat(d.caseId ? [d.caseId] : []).filter(String);
  if (ids.some(x => x !== ids[0])) throw new Error('資料與案件不符，已拒絕這次動作');
  if (found.length && found[0]) d.caseId = found[0];
  return ids[0] || '';
}
function closedGuard_(action, cid) {
  if (!cid) return;
  const c = caseRow_(cid);
  if (!c) throw new Error('找不到案件，已拒絕這次動作');   // 偽造或已刪除的案件編號：不寫任何資料、不建任何檔案
  if (CLOSED_OK.indexOf(action) >= 0) return;
  if (c['階段'] === '結案') throw new Error('案件已結案，資料唯讀；如需修改請主管把階段改回');
}

/* ========== 保固報修 ========== */
const REPAIR_ST = ['待處理', '處理中', '已完成'];
function saveRepair_(me, d) {
  const c = caseRow_(d.caseId);
  if (!c) throw new Error('找不到案件');
  if (!d.id) {
    if (!String(d.text || '').trim()) throw new Error('請填寫報修內容');
    appendRow_('保固報修', { '報修ID': uid_(), '案件ID': d.caseId, '報修日期': ymd_(d.date) || today_(), '內容': String(d.text).trim(), '負責人': d.owner || c['負責設計師'] || '',
      '狀態': '待處理', '記錄人': me.id, '建立時間': now_() });
    return true;
  }
  const r = rowObj_(findRow_('保固報修', '報修ID', d.id));
  if (!(me.leader || r['負責人'] === me.id || c['負責設計師'] === me.id)) throw new Error('只有負責人、負責設計師或主管可以更新');
  const st = REPAIR_ST.indexOf(d.status) >= 0 ? d.status : r['狀態'];
  if (st === '已完成' && !String(d.result || r['處理結果'] || '').trim()) throw new Error('完成請寫處理結果');
  updateRow_('保固報修', '報修ID', d.id, { '狀態': st, '處理結果': d.result != null ? d.result : r['處理結果'], '負責人': d.owner || r['負責人'],
    '完成日': st === '已完成' ? (r['完成日'] || today_()) : '' });
  return true;
}

/* ========== 統計（可看績效者） ==========
 * 期間內每人的：日誌篇數、補登篇數、負責案件漏填天數、指示收到／逾期回報／被退回、簽核篇數與平均耗時、里程碑完成與逾期。
 */
function stats_(me, d) {
  if (!me.seePerf) throw new Error('沒有查看績效的權限');
  const from = ymd_(d.from), to = ymd_(d.to);
  if (!from || !to || to < from) throw new Error('請選擇正確的期間');
  const inR = v => v && String(v).slice(0, 10) >= from && String(v).slice(0, 10) <= to;
  const logs = readTable_('工程日誌'), ins = readTable_('主管指示').filter(i => i['指示內容']), ms = tryTable_('里程碑'), cases = readTable_('案件');
  const exempt = tryTable_('日誌豁免'), rule = logRule_();
  const hrs = (a, b) => (new Date(String(b).replace(/\//g, '-').replace(' ', 'T') + '+08:00') - new Date(String(a).replace(/\//g, '-').replace(' ', 'T') + '+08:00')) / 36e5;
  // 期間內漏填（依目前規則回推）
  const missBy = {};
  cases.filter(c => c['階段'] === '施工' || c['結案日']).forEach(c => {
    let t = new Date(from.replace(/\//g, '-') + 'T12:00:00+08:00');
    const end = to < today_() ? to : fmt_(new Date(Date.now() - 864e5), 'yyyy/MM/dd'), start = [c['預計開工日'], rule.since].filter(String).sort().pop() || '';
    while (fmt_(t, 'yyyy/MM/dd') <= end) {
      const ymd = fmt_(t, 'yyyy/MM/dd');
      if ((!start || ymd >= start) && (!c['結案日'] || ymd <= c['結案日']) && rule.days.indexOf(WEEK[+fmt_(t, 'u') % 7]) >= 0
        && !logs.some(l => l['案件ID'] === c['案件ID'] && l['日期'] === ymd && logStatus_(l) !== LS.DRAFT) && !exempt.some(x => x['案件ID'] === c['案件ID'] && x['日期'] === ymd))
        missBy[c['負責設計師']] = (missBy[c['負責設計師']] || 0) + 1;
      t = new Date(t.getTime() + 864e5);
    }
  });
  const rows = people_().filter(p => p.active).map(p => {
    const myLogs = logs.filter(l => l['填寫人'] === p.id && inR(l['日期']));
    const late = myLogs.filter(l => l['建立時間'] && String(l['建立時間']).slice(0, 10) > l['日期']);
    const got = ins.filter(i => i['負責人'] === p.id && inR(i['建立時間']));
    const lateReply = got.filter(i => i['期限'] && ((i['回報時間'] && String(i['回報時間']).slice(0, 10) > i['期限']) || (!i['回報時間'] && i['期限'] < today_())));
    const signed = logs.filter(l => l['簽核者'] === p.id && inR(l['簽核時間']));
    const signHrs = signed.map(l => l['送出時間'] ? hrs(l['送出時間'], l['簽核時間']) : null).filter(x => x !== null && x >= 0);
    const myMs = ms.filter(m => m['負責人'] === p.id && inR(m['目前期限']));
    return {
      id: p.id, name: p.name, role: p.role,
      logs: myLogs.length, lateLogs: late.length, missing: missBy[p.id] || 0,
      insGot: got.length, insLate: lateReply.length, insReturns: got.reduce((a, i) => a + (+i['退回次數'] || 0), 0),
      signed: signed.length, signHrs: signHrs.length ? Math.round(signHrs.reduce((a, b) => a + b, 0) / signHrs.length * 10) / 10 : null,
      signLate: signed.filter(l => l['簽核期限'] && String(l['簽核時間']).slice(0, 16) > l['簽核期限']).length,
      msDone: myMs.filter(m => m['狀態'] === '已完成').length, msTotal: myMs.length,
      msLate: myMs.filter(m => (m['完成日'] && m['完成日'] > m['目前期限']) || (!m['完成日'] && m['目前期限'] < today_())).length,
      msReturns: myMs.reduce((a, m) => a + (+m['退回次數'] || 0), 0)
    };
  });
  return { from, to, rows, rule: rule };
}

/* ========== 案件主檔：修改案件資料 ========== */
const CASE_TEXT = ['案件名稱', '客戶姓名', '客戶電話', '客戶LINE', '地址', '類型', '來源', '負責設計師', 'Drive資料夾', '備註'];
const CASE_DATES = ['提案日', '設計約簽約日', '工程約簽約日', '預計開工日', '預計完工日', '實際完工日', '結案日', '保固到期日'];
const CASE_MONEY = ['設計費', '工程金額'];
/** 可修改案件資料：主管、行政、該案負責設計師（金額另需「可看金額」） */
function canEditCase_(me, c) { return me.leader || me.role === '行政' || (!!c && c['負責設計師'] === me.id); }
/** 金額：「可看」不等於「可改」。暫定只有 Boss 與行政（且可看金額）可以改，權限表待確認 */
const MONEY_EDIT_ROLES = ['Boss', '行政'];
function canEditMoney_(me) { return me.seeMoney && MONEY_EDIT_ROLES.indexOf(me.role) >= 0; }

/** 只寫入有變動的欄位，並記錄最後修改時間與修改人 */
function saveCaseInfo_(me, d) {
  const c = caseRow_(d.id);
  if (!c) throw new Error('找不到案件');
  if (!canEditCase_(me, c)) throw new Error('只有主管、行政或案件負責設計師可以修改案件資料');
  const f = d.fields || {}, patch = {};
  CASE_TEXT.forEach(k => { if (k in f) patch[k] = String(f[k] == null ? '' : f[k]).trim(); });
  CASE_DATES.forEach(k => { if (k in f) patch[k] = ymd_(String(f[k] || '').trim()); });
  if (CASE_MONEY.some(k => k in f && String(f[k] == null ? '' : f[k]).replace(/[^0-9.]/g, '') !== String(c[k] || '').replace(/[^0-9.]/g, '')) && !canEditMoney_(me)) throw new Error('你可以看金額，但修改金額暫定只有 Boss 和行政可以');
  if (canEditMoney_(me)) CASE_MONEY.forEach(k => { if (k in f) patch[k] = String(f[k] == null ? '' : f[k]).replace(/[^0-9.]/g, ''); });
  // 多人同時編輯：只有「你改的欄位」在你打開之後又被別人改過，才擋下；改不同欄位兩邊都會保留
  const orig = d.orig || {}, clash = Object.keys(f).filter(k => k in orig && String(c[k] == null ? '' : c[k]) !== String(orig[k] == null ? '' : orig[k]));
  if (clash.length) throw new Error('「' + clash.join('、') + '」在你打開之後已被' + (c['最後修改人'] && c['最後修改人'] !== me.id ? pname_(c['最後修改人']) : '別人') + '改成新的內容，請關掉重新打開再改');
  if ('案件名稱' in patch && !patch['案件名稱']) throw new Error('案件名稱不能空白');
  if (patch['負責設計師'] && !people_().some(p => p.id === patch['負責設計師'] && p.active)) throw new Error('負責設計師不在人員名單');
  const v = k => k in patch ? patch[k] : (c[k] || '');
  if (v('預計開工日') && v('預計完工日') && v('預計完工日') < v('預計開工日')) throw new Error('預計完工日不能早於預計開工日');
  CASE_DATES.forEach(k => { if (patch[k] && !/^\d{4}\/\d{2}\/\d{2}$/.test(patch[k])) throw new Error(k + '格式不對'); });
  if (patch['Drive資料夾'] && patch['Drive資料夾'] !== c['Drive資料夾']) {
    const m = patch['Drive資料夾'].match(/folders\/([\w-]+)/);
    if (!m) throw new Error('請貼上 Google 雲端硬碟「資料夾」的網址（網址裡要有 /folders/）');
    if (!TDrive.inRoot(m[1])) throw new Error('測試環境只能使用測試資料夾，這個資料夾不接受');
    patch['Drive資料夾'] = TDrive.getFolderById(m[1]).getUrl();
  }
  const changed = Object.keys(patch).filter(k => String(c[k] == null ? '' : c[k]) !== patch[k]);
  if (!changed.length) return { changed: [] };
  const out = {};
  changed.forEach(k => out[k] = patch[k]);
  out['最後修改時間'] = now_(); out['最後修改人'] = me.id;
  updateRow_('案件', '案件ID', d.id, out);
  return { changed: changed };
}

/** 新增工種（主管） */
function saveTrade_(me, d) {
  if (!me.leader) throw new Error('只有主管可以管理工種');
  const name = String(d.name || '').trim();
  if (!name) throw new Error('請填寫工種名稱');
  const list = readTable_('工種清單');
  if (list.some(t => t['工種'] === name)) throw new Error('工種已存在');
  const max = list.reduce((m, t) => Math.max(m, +t['排序'] || 0), 0);
  appendRow_('工種清單', { '工種': name, '色碼': d.color || '#8A7F75', '排序': max + 1, '啟用': 'Y' });
  return true;
}

/* ========== 進度計畫（第 4 項：不受待決規則影響的部分） ==========
 * 暫定：負責設計師與主管可以編排進度、確認實際開始、標記施工完成；只有主管可以「定案」。
 * 定案前：日期直接改（只改「目前計畫」）。定案時：把目前計畫複製成「原計畫」（基準）。
 * 定案後：改期只改「目前計畫」且必須填原因；所有變動寫入「進度異動紀錄」。
 * 實際開始：系統以該工種第一篇日誌作為「參考」，由負責設計師確認；更正要填原因。
 * 施工完成、查驗通過、下一工序放行分開記錄；查驗與放行的規則待 Boss 決定，這裡尚未製作。
 */
function canPlan_(me, c) { return me.leader || (!!c && c['負責設計師'] === me.id); }
function planGuard_(me, caseId) {
  const c = caseRow_(caseId);
  if (!c) throw new Error('找不到案件');
  if (!canPlan_(me, c)) throw new Error('只有案件負責設計師或主管可以編排進度');
  return c;
}
function planItem_(id) { return rowObj_(findRow_('進度計畫', '工序ID', id)); }
function planLog_(me, caseId, itemId, what, from, to, why, ciId) {
  appendRow_('進度異動紀錄', { '紀錄ID': uid_(), '案件ID': caseId, '工序ID': itemId || '', '項目': what, '原值': from || '', '新值': to || '', '原因': why || '', '修改人': me.id, '時間': now_(), '關聯客戶指示': ciId || '' });
}
function checkRange_(s, e) {
  if (s && !/^\d{4}\/\d{2}\/\d{2}$/.test(s) || e && !/^\d{4}\/\d{2}\/\d{2}$/.test(e)) throw new Error('日期格式不對');
  if (s && e && e < s) throw new Error('完成日不能早於開始日');
}
/** 加 n 個工作天（週六日不算；國定假日尚未處理） */
function addWorkdays_(ymd, n) {
  const p = String(ymd).split('/').map(Number);
  let d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  const wk = () => { const w = d.getUTCDay(); return w !== 0 && w !== 6; };
  while (!wk()) d = new Date(d.getTime() + 864e5);
  for (let i = 0; i < n; i++) { do { d = new Date(d.getTime() + 864e5); } while (!wk()); }
  const z = x => (x < 10 ? '0' : '') + x;
  return d.getUTCFullYear() + '/' + z(d.getUTCMonth() + 1) + '/' + z(d.getUTCDate());
}

/** 新增或修改工序 */
function savePlanItem_(me, d) {
  const c = planGuard_(me, d.caseId), locked = !!c['進度定案時間'];
  const start = ymd_(d.start), end = ymd_(d.end), why = String(d.reason || '').trim();
  checkRange_(start, end);
  if (!String(d.name || '').trim()) throw new Error('請填寫工序名稱');
  // 追加減連動：這次改期／新增是因為哪一筆客戶指示（選填）
  let ci = null;
  if (d.ciId) { ci = rowObj_(findRow_('客戶指示', '指示ID', d.ciId)); if (ci['案件ID'] !== d.caseId) throw new Error('客戶指示不屬於這個案件'); }
  const linkCi = itemName => { if (ci) updateRow_('客戶指示', '指示ID', d.ciId, { '進度調整': '已調整', '進度調整說明': itemName + '：' + start + '～' + end, '進度調整人': me.id, '進度調整時間': now_() }); };
  if (!d.id) {
    if (locked && !why) throw new Error('進度已定案，新增工序請填寫原因');
    const id = uid_(), maxOrder = readTable_('進度計畫').filter(r => r['案件ID'] === d.caseId).reduce((m, r) => Math.max(m, +r['順序'] || 0), 0);
    appendRow_('進度計畫', { '工序ID': id, '案件ID': d.caseId, '順序': d.order || maxOrder + 1, '工種': d.trade || '', '工序名稱': String(d.name).trim(),
      '目前計畫開始': start, '目前計畫完成': end, '狀態': '計畫', '最後修改人': me.id, '最後修改時間': now_() });
    if (locked) planLog_(me, d.caseId, id, '新增工序', '', String(d.name).trim() + ' ' + start + '～' + end, why, d.ciId);
    linkCi('新增 ' + String(d.name).trim());
    return id;
  }
  const r = planItem_(d.id);
  if (r['案件ID'] !== d.caseId) throw new Error('工序不屬於這個案件');
  const patch = { '工種': d.trade || '', '工序名稱': String(d.name).trim(), '目前計畫開始': start, '目前計畫完成': end };
  if (d.order) patch['順序'] = d.order;
  const dateChanged = start !== (r['目前計畫開始'] || '') || end !== (r['目前計畫完成'] || '');
  if (locked && dateChanged && !why) throw new Error('進度已定案，改期請填寫原因');
  if (locked && dateChanged) planLog_(me, d.caseId, d.id, '改期', (r['目前計畫開始'] || '') + '～' + (r['目前計畫完成'] || ''), start + '～' + end, why, d.ciId);
  if (dateChanged) linkCi(patch['工序名稱']);
  if (locked && patch['工序名稱'] !== r['工序名稱']) planLog_(me, d.caseId, d.id, '改名稱', r['工序名稱'], patch['工序名稱'], why);
  patch['改期原因'] = locked && dateChanged ? why : (r['改期原因'] || '');
  patch['最後修改人'] = me.id; patch['最後修改時間'] = now_();
  updateRow_('進度計畫', '工序ID', d.id, patch);
  return d.id;
}

/** 取消工序（不刪除，保留紀錄）；定案後要填原因 */
function cancelPlanItem_(me, d) {
  const r = planItem_(d.id), c = planGuard_(me, r['案件ID']);
  const why = String(d.reason || '').trim();
  if (c['進度定案時間'] && !why) throw new Error('進度已定案，取消工序請填寫原因');
  if (r['實際開始']) throw new Error('這個工序已經開始，不能取消');
  updateRow_('進度計畫', '工序ID', d.id, { '狀態': '取消', '最後修改人': me.id, '最後修改時間': now_() });
  planLog_(me, r['案件ID'], d.id, '取消工序', r['工序名稱'], '', why);
  return true;
}

/** 套用工序範本（範本為示範內容，待 Boss 確認）。有預計開工日就依標準工期排出草稿日期 */
function applyTemplate_(me, d) {
  const c = planGuard_(me, d.caseId);
  if (readTable_('進度計畫').some(r => r['案件ID'] === d.caseId && r['狀態'] !== '取消')) throw new Error('這個案件已經有工序，不能再套用範本');
  const tpl = readTable_('範本_工序').filter(t => t['工序名稱'] && t['啟用'] !== 'N').sort((a, b) => (+a['順序'] || 0) - (+b['順序'] || 0));
  if (!tpl.length) throw new Error('工序範本是空的');
  let cursor = c['預計開工日'] || '', prevStart = '';
  tpl.forEach((t, i) => {
    const days = Math.max(1, +t['標準工期（工作天）'] || 1);
    let s = '', e = '';
    if (cursor) {
      const parallel = /同步/.test(t['備註'] || '') && prevStart;
      s = parallel ? prevStart : addWorkdays_(cursor, 0);
      e = addWorkdays_(s, days - 1);
      if (!parallel) { cursor = addWorkdays_(e, 1); prevStart = s; }
    }
    appendRow_('進度計畫', { '工序ID': uid_(), '案件ID': d.caseId, '順序': i + 1, '工種': t['工種'] || '', '工序名稱': t['工序名稱'],
      '目前計畫開始': s, '目前計畫完成': e, '查驗點': t['查驗點'] || '', '狀態': '計畫', '範本工序ID': t['工序ID'] || '', '最後修改人': me.id, '最後修改時間': now_() });
  });
  planLog_(me, d.caseId, '', '套用範本', '', tpl.length + ' 個工序（示範範本）', c['預計開工日'] ? '依預計開工日 ' + c['預計開工日'] + ' 排出草稿日期' : '案件沒有預計開工日，日期留空');
  return tpl.length;
}

/** 定案（主管）：把目前計畫複製成原計畫，之後改期都要填原因 */
function lockPlan_(me, d) {
  if (!me.leader) throw new Error('只有主管可以定案進度計畫');
  const c = caseRow_(d.caseId);
  if (!c) throw new Error('找不到案件');
  if (c['進度定案時間']) throw new Error('進度計畫已經定案');
  const items = readTable_('進度計畫').filter(r => r['案件ID'] === d.caseId && r['狀態'] !== '取消');
  if (!items.length) throw new Error('還沒有任何工序');
  const miss = items.filter(r => !r['目前計畫開始'] || !r['目前計畫完成']);
  if (miss.length) throw new Error('還有 ' + miss.length + ' 個工序沒有排日期（例如「' + miss[0]['工序名稱'] + '」）');
  items.forEach(r => updateRow_('進度計畫', '工序ID', r['工序ID'], { '原計畫開始': r['目前計畫開始'], '原計畫完成': r['目前計畫完成'] }));
  updateRow_('案件', '案件ID', d.caseId, { '進度定案時間': now_(), '進度定案人': me.id });
  planLog_(me, d.caseId, '', '進度定案', '', items.length + ' 個工序', '');
  return true;
}

/** 確認實際開始日（日誌只是參考）；已確認過再改視為更正，要填原因 */
function setActualStart_(me, d) {
  const r = planItem_(d.id); planGuard_(me, r['案件ID']);
  const date = ymd_(d.date), why = String(d.reason || '').trim();
  checkRange_(date, '');
  if (!date) throw new Error('請選擇日期');
  if (r['實際完成'] && date > r['實際完成']) throw new Error('實際開始不能晚於施工完成日');
  if (r['實際開始'] && r['實際開始'] !== date && !why) throw new Error('更正實際開始日請填寫原因');
  if (r['實際開始'] === date) return true;
  updateRow_('進度計畫', '工序ID', d.id, { '實際開始': date, '實際開始確認人': me.id, '最後修改人': me.id, '最後修改時間': now_() });
  planLog_(me, r['案件ID'], d.id, r['實際開始'] ? '更正實際開始' : '確認實際開始', r['實際開始'], date, why || (d.basis ? '參考：' + d.basis : ''));
  return true;
}

/** 施工完成（與查驗、放行分開）；撤回或更正要填原因 */
function setDone_(me, d) {
  const r = planItem_(d.id); planGuard_(me, r['案件ID']);
  const why = String(d.reason || '').trim();
  if (d.undo) {
    if (!r['實際完成']) return true;
    if (!why) throw new Error('撤回施工完成請填寫原因');
    updateRow_('進度計畫', '工序ID', d.id, { '實際完成': '', '實際完成確認人': '', '最後修改人': me.id, '最後修改時間': now_() });
    planLog_(me, r['案件ID'], d.id, '撤回施工完成', r['實際完成'], '', why);
    return true;
  }
  const date = ymd_(d.date);
  if (!date) throw new Error('請選擇日期');
  if (!r['實際開始']) throw new Error('請先確認實際開始日');
  checkRange_(r['實際開始'], date);
  if (r['實際完成'] && r['實際完成'] !== date && !why) throw new Error('更正施工完成日請填寫原因');
  if (r['實際完成'] === date) return true;
  updateRow_('進度計畫', '工序ID', d.id, { '實際完成': date, '實際完成確認人': me.id, '最後修改人': me.id, '最後修改時間': now_() });
  planLog_(me, r['案件ID'], d.id, r['實際完成'] ? '更正施工完成' : '施工完成', r['實際完成'], date, why);
  return true;
}

/* ========== 客戶頁：客戶指示、會議記錄、客戶確認、追加減 ==========
 * 暫定規則（可調）：任何同事都能記錄；確認前由記錄人、負責設計師、主管修改；
 * 客戶確認後「鎖定」不可再改，要更正就另記一筆。追加減金額目前案件成員都看得到（待 Boss 確認）。
 */
const CI_SOURCES = ['LINE', '口頭', '電話', '會議', '其他'];
const CI_STATUS = ['待確認', '已確認', '客戶不同意'];
function canCI_(me, c, rec) { return me.leader || (c && c['負責設計師'] === me.id) || (rec && rec['記錄人'] === me.id); }

function saveMeeting_(me, d) {
  const c = caseRow_(d.caseId);
  if (!c) throw new Error('找不到案件');
  if (!String(d.name || '').trim()) throw new Error('請填寫會議名稱');
  const row = { '日期': ymd_(d.date) || today_(), '會議名稱': String(d.name).trim(), '出席人': d.attendees || '', '錄音檔': d.audio || '', 'AI摘要': d.summary || '' };
  if (!d.id) {
    const id = uid_();
    appendRow_('會議', Object.assign({ '會議ID': id, '案件ID': d.caseId, '記錄人': me.id, '建立時間': now_() }, row));
    return id;
  }
  const m = rowObj_(findRow_('會議', '會議ID', d.id));
  if (!canCI_(me, c, m)) throw new Error('只有記錄人、負責設計師或主管可以修改');
  row['核對人'] = ''; row['核對時間'] = '';   // 內容改了要重新核對
  updateRow_('會議', '會議ID', d.id, row);
  return d.id;
}

/** 設計師核對會議摘要（AI 整理的內容要人確認過） */
function reviewMeeting_(me, d) {
  const m = rowObj_(findRow_('會議', '會議ID', d.id)), c = caseRow_(m['案件ID']);
  if (!canCI_(me, c, null)) throw new Error('只有負責設計師或主管可以核對');
  updateRow_('會議', '會議ID', d.id, { '核對人': me.id, '核對時間': now_() });
  return true;
}

function saveClientIns_(me, d) {
  const c = caseRow_(d.caseId);
  if (!c) throw new Error('找不到案件');
  const text = String(d.text || '').trim();
  if (!text) throw new Error('請填寫客戶指示內容');
  const impact = d.impact ? 'Y' : 'N';
  const row = {
    '會議ID': d.meetingId || '', '類型': d.meetingId ? '會議性' : '臨時性', '來源': d.meetingId ? '會議' : (CI_SOURCES.indexOf(d.source) >= 0 ? d.source : '其他'),
    '日期': ymd_(d.date) || today_(), '內容': text, '影響費用或工期': impact,
    '追加減金額': impact === 'Y' ? String(d.amount || '').replace(/[^0-9.\-]/g, '') : '', '影響工期天數': impact === 'Y' ? String(d.days || '').replace(/[^0-9\-]/g, '') : ''
  };
  row['執行人'] = d.owner || c['負責設計師'] || me.id;
  row['執行期限'] = ymd_(d.due);
  if (row['執行人'] && !people_().some(p => p.id === row['執行人'] && p.active)) throw new Error('執行人不在人員名單');
  if (!d.id) {
    const id = uid_();
    appendRow_('客戶指示', Object.assign({ '指示ID': id, '案件ID': d.caseId, '確認狀態': '待確認', '執行狀態': '待執行', '記錄人': me.id, '建立時間': now_() }, row));
    return id;
  }
  const x = rowObj_(findRow_('客戶指示', '指示ID', d.id));
  if (!canCI_(me, c, x)) throw new Error('只有記錄人、負責設計師或主管可以修改');
  if (x['鎖定'] === 'Y') {   // 客戶確認後內容鎖定，只能調整誰執行、期限
    updateRow_('客戶指示', '指示ID', d.id, { '執行人': row['執行人'], '執行期限': row['執行期限'], '最後修改人': me.id, '最後修改時間': now_() });
    return d.id;
  }
  updateRow_('客戶指示', '指示ID', d.id, Object.assign(row, { '最後修改人': me.id, '最後修改時間': now_() }));
  return d.id;
}

function saveImage_(b64, ext, prefix) {
  if (!b64) return '';
  const name = prefix + '.' + uid_() + '.' + fmt_(new Date(), 'HHmmss') + '.' + ext;
  subDir_(CONFIRM_DIR).createFile(Utilities.newBlob(Utilities.base64Decode(b64), ext === 'png' ? 'image/png' : 'image/jpeg', name));
  return CONFIRM_DIR + '/' + name;
}

/** 記錄客戶確認：現場簽名、LINE 回覆截圖或其他方式；確認後鎖定 */
function confirmClientIns_(me, d) {
  const x = rowObj_(findRow_('客戶指示', '指示ID', d.id)), c = caseRow_(x['案件ID']);
  if (x['鎖定'] === 'Y') throw new Error('這筆已經確認過');
  if (!canCI_(me, c, x)) throw new Error('只有記錄人、負責設計師或主管可以登記客戶確認');
  const status = CI_STATUS.indexOf(d.status) > 0 ? d.status : '已確認';
  if (!d.method) throw new Error('請選擇確認方式');
  if (d.method === '現場簽名' && !d.sign) throw new Error('請請客戶簽名');
  if (d.method === 'LINE回覆' && !d.shot) throw new Error('請附上客戶回覆的截圖');
  updateRow_('客戶指示', '指示ID', d.id, {
    '確認狀態': status, '確認方式': d.method, '客戶簽名': saveImage_(d.sign, 'png', '簽名'), '確認截圖': saveImage_(d.shot, 'jpg', '截圖'),
    '確認時間': now_(), '確認備註': d.note || '', '鎖定': 'Y', '最後修改人': me.id, '最後修改時間': now_(),
    '執行狀態': status === '客戶不同意' ? '不需執行' : (x['執行狀態'] || '待執行')   // 客戶確認≠事情做完：仍要執行、回報、確認完成
  });
  return true;
}

/**
 * 客戶指示的執行追蹤（與「客戶確認」分開）：待執行 →（執行人回報）已回報 →（負責設計師或主管確認）已完成；可退回重做。
 * act: report（執行人回報處理結果）／done（確認完成）／return（退回，需原因）
 */
function actClientIns_(me, d) {
  const x = rowObj_(findRow_('客戶指示', '指示ID', d.id)), c = caseRow_(x['案件ID']);
  const lead = me.leader || c['負責設計師'] === me.id, st = x['執行狀態'] || '待執行';
  if (st === '不需執行') throw new Error('客戶不同意，這項不需執行');
  const text = String(d.text || '').trim();
  if (d.act === 'report') {
    if (x['執行人'] !== me.id && !lead) throw new Error('只有執行人、負責設計師或主管可以回報');
    if (!text) throw new Error('請寫處理結果，例如：木作已改 260cm');
    updateRow_('客戶指示', '指示ID', d.id, { '執行狀態': '已回報', '處理回報': text, '回報時間': now_(), '回報人': me.id, '最後修改人': me.id, '最後修改時間': now_() });
  } else if (d.act === 'done') {
    if (!lead) throw new Error('只有負責設計師或主管可以確認完成');
    updateRow_('客戶指示', '指示ID', d.id, { '執行狀態': '已完成', '處理回報': text || x['處理回報'], '完成確認人': me.id, '完成時間': now_(), '最後修改人': me.id, '最後修改時間': now_() });
  } else if (d.act === 'noSchedule') {
    if (!lead) throw new Error('只有負責設計師或主管可以決定');
    if (!text) throw new Error('請寫為什麼不需要調整進度，例如：利用原本的緩衝天數吸收');
    updateRow_('客戶指示', '指示ID', d.id, { '進度調整': '不需調整', '進度調整說明': text, '進度調整人': me.id, '進度調整時間': now_() });
  } else if (d.act === 'return') {
    if (!lead) throw new Error('只有負責設計師或主管可以退回');
    if (!text) throw new Error('退回請寫原因');
    updateRow_('客戶指示', '指示ID', d.id, { '執行狀態': '待執行', '處理回報': (x['處理回報'] ? x['處理回報'] + '\n' : '') + today_() + ' 退回（' + pname_(me.id) + '）：' + text, '最後修改人': me.id, '最後修改時間': now_() });
  } else throw new Error('不明的動作');
  return true;
}

/* ========== 公司設定（可調整的規則參數） ========== */
let _settings;
function settings_() {
  if (_settings) return _settings;
  const o = {};
  tryTable_('公司設定').forEach(r => { if (r['項目']) o[r['項目']] = r['值']; });
  return (_settings = o);
}
function setting_(k, dflt) { const v = settings_()[k]; return v === undefined || v === '' ? dflt : v; }

/* ========== 日誌填寫規則與漏填追蹤（暫定，參數在「公司設定」可調） ==========
 * 施工階段的案件，在「日誌填寫日」每天要有一篇已送出的日誌（草稿不算）；當天沒施工就登記「無施工」。
 * 截止：隔天「日誌截止時間」；過了還沒有就算漏填，提醒負責設計師，Boss 總覽看得到。只追蹤最近 14 天。
 */
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
function logRule_() {
  return {
    days: String(setting_('日誌填寫日', '一二三四五六')).replace(/[^一二三四五六日]/g, '').split(''),
    cut: String(setting_('日誌截止時間', '10:00')),
    since: String(setting_('日誌追蹤起始日', '')),
    stale: +setting_('指示未回報提醒天數', 3) || 3
  };
}
/** 回傳案件漏填的日期（新到舊） */
function missingDays_(c, logs, exempt, rule) {
  if (c['階段'] !== '施工' || c['狀態'] === '已結案') return [];
  const now = new Date(), nowHM = fmt_(now, 'HH:mm'), out = [];
  const start = [c['預計開工日'], rule.since].filter(String).sort().pop() || '';
  for (let k = 1; k <= 14; k++) {
    const day = new Date(now.getTime() - k * 864e5), ymd = fmt_(day, 'yyyy/MM/dd');
    if (start && ymd < start) break;
    if (k === 1 && nowHM < rule.cut) continue;   // 昨天的日誌還沒到截止時間
    if (rule.days.indexOf(WEEK[+fmt_(day, 'u') % 7]) < 0) continue;
    if (logs.some(l => l['案件ID'] === c['案件ID'] && l['日期'] === ymd && logStatus_(l) !== LS.DRAFT)) continue;
    if (exempt.some(x => x['案件ID'] === c['案件ID'] && x['日期'] === ymd)) continue;
    out.push(ymd);
  }
  return out;
}
/** 登記某天無施工（任何同事都可以登記，記錄是誰） */
function markNoWork_(me, d) {
  const c = caseRow_(d.caseId);
  if (!c) throw new Error('找不到案件');
  const day = ymd_(d.date), why = String(d.reason || '').trim();
  if (!day) throw new Error('請選擇日期');
  if (!why) throw new Error('請寫原因，例如：等系統櫃進場');
  if (tryTable_('日誌豁免').some(x => x['案件ID'] === d.caseId && x['日期'] === day)) return true;
  appendRow_('日誌豁免', { 'ID': uid_(), '案件ID': d.caseId, '日期': day, '原因': why, '記錄人': me.id, '時間': now_() });
  return true;
}

/* ========== 進度頁補完：查驗紀錄、開案前 SOP、設計階段里程碑 ==========
 * 依 Boss 11/19 方向：查驗是「記錄與提醒」，不擋施工、不需主管逐項放行；有問題就照常下指示處理。
 * 暫定：負責設計師與主管可以記錄查驗、勾 SOP、維護里程碑（canPlan_）。
 */
function saveCheck_(me, d) {
  const it = planItem_(d.itemId), c = planGuard_(me, it['案件ID']);
  const all = tryTable_('查驗紀錄'), cur = all.find(x => x['工序ID'] === d.itemId && x['檢查ID'] === d.checkId);
  const tpl = tryTable_('範本_查驗清單').find(t => t['檢查ID'] === d.checkId) || {};
  const status = d.status === '有問題' ? '有問題' : '正常';
  if (status === '有問題' && !String(d.note || '').trim()) throw new Error('有問題請寫明狀況');
  const row = { '完成': d.done ? 'Y' : '', '狀態': d.done ? status : '', '備註': d.note || '', '檢查人': me.id, '檢查時間': now_() };
  if (d.photo) row['照片'] = saveImage_(d.photo, 'jpg', '查驗');
  if (cur) updateRow_('查驗紀錄', '紀錄ID', cur['紀錄ID'], row);
  else appendRow_('查驗紀錄', Object.assign({ '紀錄ID': uid_(), '案件ID': c['案件ID'], '工序ID': d.itemId, '查驗點': it['查驗點'], '檢查ID': d.checkId, '檢查項目': tpl['檢查項目'] || d.label || '' }, row));
  return true;
}

function applySop_(me, d) {
  const c = planGuard_(me, d.caseId);
  if (tryTable_('案件SOP').some(x => x['案件ID'] === d.caseId)) throw new Error('這個案件已經有 SOP 清單');
  const tpl = tryTable_('範本_開案SOP').filter(t => t['啟用'] !== 'N' && t['項目']).sort((a, b) => (+a['順序'] || 0) - (+b['順序'] || 0));
  tpl.forEach(t => appendRow_('案件SOP', { 'ID': uid_(), '案件ID': c['案件ID'], '項目ID': t['項目ID'], '項目': t['項目'], '順序': t['順序'], '負責角色': t['負責角色'] || '', '說明': t['說明'] || '' }));
  return tpl.length;
}
function setSop_(me, d) {
  const x = rowObj_(findRow_('案件SOP', 'ID', d.id)); planGuard_(me, x['案件ID']);
  updateRow_('案件SOP', 'ID', d.id, d.done ? { '完成': 'Y', '完成日': ymd_(d.date) || today_(), '完成人': me.id, '備註': d.note || x['備註'] || '' } : { '完成': '', '完成日': '', '完成人': '', '備註': d.note || x['備註'] || '' });
  return true;
}

/** 帶入設計階段里程碑範本：提案階段以提案日為 0、設計階段以設計約簽約日為 0（日曆天） */
function applyMilestones_(me, d) {
  const c = planGuard_(me, d.caseId), stage = d.stage === '設計' ? '設計' : '提案';
  const base = stage === '提案' ? c['提案日'] : c['設計約簽約日'];
  if (!base) throw new Error('請先在案件資料填寫' + (stage === '提案' ? '提案日' : '設計約簽約日'));
  if (tryTable_('里程碑').some(x => x['案件ID'] === d.caseId && x['階段'] === stage)) throw new Error('這個案件已經有「' + stage + '」里程碑');
  const tpl = tryTable_('範本_里程碑').filter(t => t['階段'] === stage && t['名稱'] && t['啟用'] !== 'N').sort((a, b) => (+a['順序'] || 0) - (+b['順序'] || 0));
  const bossId = bossId_(), b = base.split('/').map(Number);
  tpl.forEach(t => {
    const dt = new Date(Date.UTC(b[0], b[1] - 1, b[2]) + (+t['相對天數'] || 0) * 864e5), z = x => (x < 10 ? '0' : '') + x;
    const due = dt.getUTCFullYear() + '/' + z(dt.getUTCMonth() + 1) + '/' + z(dt.getUTCDate());
    appendRow_('里程碑', { '任務ID': uid_(), '案件ID': d.caseId, '階段': stage, '名稱': t['名稱'], '順序': t['順序'],
      '負責人': t['負責角色'] === 'Boss' ? bossId : (c['負責設計師'] || ''), '原定日期': due, '目前期限': due, '狀態': '未完成', '退回次數': 0 });
  });
  return tpl.length;
}
function saveMilestone_(me, d) {
  const c = planGuard_(me, d.caseId), due = ymd_(d.due), why = String(d.reason || '').trim();
  if (!String(d.name || '').trim()) throw new Error('請填寫名稱');
  if (!d.id) {
    appendRow_('里程碑', { '任務ID': uid_(), '案件ID': d.caseId, '階段': d.stage || c['階段'] || '', '名稱': String(d.name).trim(), '負責人': d.owner || '',
      '原定日期': due, '目前期限': due, '狀態': '未完成', '退回次數': 0 });
    return true;
  }
  const x = rowObj_(findRow_('里程碑', '任務ID', d.id));
  if (x['目前期限'] && due !== x['目前期限'] && !why) throw new Error('改期請填寫原因');
  updateRow_('里程碑', '任務ID', d.id, { '名稱': String(d.name).trim(), '負責人': d.owner || '', '目前期限': due,
    '改期原因': due !== x['目前期限'] ? (x['改期原因'] ? x['改期原因'] + '\n' : '') + today_() + ' ' + x['目前期限'] + '→' + due + '：' + why : x['改期原因'] });
  return true;
}
/** 完成／取消完成／退回（退回只限主管，計入退回次數） */
function setMilestone_(me, d) {
  const x = rowObj_(findRow_('里程碑', '任務ID', d.id)), c = caseRow_(x['案件ID']);
  const mine = x['負責人'] === me.id;
  if (d.act === 'return') {
    if (!me.leader) throw new Error('只有主管可以退回');
    updateRow_('里程碑', '任務ID', d.id, { '狀態': '未完成', '完成日': '', '退回次數': (+x['退回次數'] || 0) + 1,
      '備註': (x['備註'] ? x['備註'] + '\n' : '') + today_() + ' 退回（' + pname_(me.id) + '）：' + (d.reason || '') });
    return true;
  }
  if (!mine && !canPlan_(me, c)) throw new Error('只有負責人、負責設計師或主管可以更新');
  updateRow_('里程碑', '任務ID', d.id, d.act === 'done' ? { '狀態': '已完成', '完成日': today_() } : { '狀態': '未完成', '完成日': '' });
  return true;
}

/* ========== 共用：產生文件 PDF 並登記到「文件紀錄」 ========== */
function docHtml_(title, sub, body) {
  const logo = logoData_();
  return '<html><head><meta charset="utf-8"><style>'
    + 'body{font-family:"Noto Sans TC","Noto Sans CJK TC","Microsoft JhengHei",sans-serif;color:#2b2724;font-size:10.5pt;line-height:1.6}'
    + '.hd{width:100%;border-bottom:1.5pt solid #AF9263;padding-bottom:6pt}.hd td{vertical-align:bottom}'
    + '.tt{font-size:18pt;letter-spacing:3pt;font-weight:bold;text-align:right}.ts{font-size:9pt;color:#8a7f75;text-align:right}'
    + 'table.info{width:100%;border-collapse:collapse;margin-top:12pt}table.info td{border:0.6pt solid #e2d9cc;padding:4pt 7pt;font-size:10pt}table.info td.k{background:#f7f4ef;width:80pt;color:#7a7067}'
    + 'h2{font-size:11.5pt;margin:16pt 0 6pt;padding-left:6pt;border-left:3pt solid #AF9263}h3{font-size:10.5pt;margin:12pt 0 4pt}'
    + '.txt{white-space:pre-wrap}.issue{background:#f9ece9;color:#8a2f25;padding:6pt 9pt;white-space:pre-wrap}'
    + '.item{border:0.6pt solid #e2d9cc;padding:6pt 9pt;margin-bottom:6pt}.im{font-size:9pt;color:#7a7067}.st{font-size:9pt;color:#5b6f8c}'
    + 'table.grid{width:100%;border-collapse:collapse}table.grid td,table.grid th{border:0.6pt solid #e2d9cc;padding:3pt 6pt;font-size:9.5pt;text-align:left}table.grid th{background:#f7f4ef;font-weight:normal;color:#7a7067}'
    + 'table.ph td{width:50%;vertical-align:top;padding:4pt}.pn{font-size:9pt;color:#5a5048}'
    + '.sign{border:0.6pt solid #e2d9cc;padding:6pt;margin-top:6pt}.foot{margin-top:22pt;border-top:0.6pt solid #e2d9cc;padding-top:5pt;font-size:8.5pt;color:#8a7f75}.pb{page-break-before:always}'
    + '</style></head><body>'
    + '<table class="hd"><tr><td>' + (logo ? '<img src="' + logo + '" height="62">' : '<b>浩森設計 HOUSEN</b>') + '</td>'
    + '<td><div class="tt">' + h_(title) + '</div><div class="ts">' + h_(sub) + '</div></td></tr></table>'
    + body
    + '<div class="foot">產生時間 ' + fmt_(new Date(), 'yyyy/MM/dd HH:mm') + '<br>浩森設計 HOUSEN INTERIOR DESIGN</div></body></html>';
}
/** 存到「案件資料夾／子資料夾」，同一來源重新產生時覆蓋舊檔，並更新文件紀錄 */
function saveDoc_(me, c, sub, name, html, type, srcId) {
  const blob = Utilities.newBlob(html, 'text/html', 'doc.html').getAs('application/pdf').setName(name);
  const d = caseDir_(c), it = d.getFoldersByName(sub), dir = it.hasNext() ? it.next() : d.createFolder(sub);
  const file = dir.createFile(blob);   // 先建好新檔；失敗就停在這裡，舊檔和紀錄都不動
  // 記錄在鎖內重新讀：兩人同時產同一份，只會留一筆紀錄，被取代的檔案一定收回
  withLock_(() => {
    const docs = tryTable_('文件紀錄'), old = srcId ? docs.find(x => x['來源ID'] === srcId && x['文件類型'] === type) : null;
    const row = { '日期': today_(), '文件名稱': name, '檔案連結': file.getUrl(), '檔案ID': file.getId(), '產生人': me.id, '產生時間': now_() };
    if (old) updateRow_('文件紀錄', '文件ID', old['文件ID'], row);
    else appendRow_('文件紀錄', Object.assign({ '文件ID': uid_(), '案件ID': c['案件ID'], '文件類型': type, '對內對外': '對外', '來源ID': srcId || '' }, row));
    if (old && old['檔案ID'] && old['檔案ID'] !== file.getId()) { try { TDrive.getFileById(old['檔案ID']).setTrashed(true); } catch (e) { } }
  });
  return file;
}
function pdfOut_(file) { return { name: file.getName(), data: Utilities.base64Encode(file.getBlob().getBytes()), url: file.getUrl() }; }

function ciBlock_(x) {
  const imp = x['影響費用或工期'] === 'Y'
    ? '<div class="im">影響費用或工期：' + (x['追加減金額'] ? '追加減 ' + h_(x['追加減金額']) + ' 元' : '') + (x['影響工期天數'] ? '　工期 ' + h_(x['影響工期天數']) + ' 天' : '') + '</div>' : '';
  const conf = x['鎖定'] === 'Y'
    ? '<div class="st">' + h_(x['確認狀態']) + '（' + h_(x['確認方式']) + '，' + h_(String(x['確認時間']).slice(0, 16)) + '）' + (x['確認備註'] ? '：' + h_(x['確認備註']) : '') + '</div>'
      + (x['客戶簽名'] ? '<div class="sign">客戶簽名<br><img src="' + photoData_(x['客戶簽名']) + '" height="70"></div>' : '')
    : '<div class="st">待客戶確認</div>';
  return '<div class="item"><div class="im">' + h_(x['日期']) + '・' + h_(x['來源']) + '・記錄人 ' + h_(pname_(x['記錄人'])) + '</div><div class="txt">' + h_(x['內容']) + '</div>' + imp + conf + '</div>';
}

/** 客戶確認單／會議記錄 PDF（d.meetingId 或 d.insId） */
function clientPdf_(me, d) {
  const owner = d.meetingId ? rowObj_(findRow_('會議', '會議ID', d.meetingId)) : rowObj_(findRow_('客戶指示', '指示ID', d.insId));
  if (!canCI_(me, caseRow_(owner['案件ID']), null) && !me.leader) throw new Error('只有負責設計師或主管可以產生');   // 先檢查權限，再做任何事
  const all = tryTable_('客戶指示');
  let c, html, name, src, type;
  if (d.meetingId) {
    const m = rowObj_(findRow_('會議', '會議ID', d.meetingId)); c = caseRow_(m['案件ID']);
    const items = all.filter(x => x['會議ID'] === d.meetingId);
    html = docHtml_('會議記錄', c['案件名稱'] + '　' + m['日期'],
      '<table class="info"><tr><td class="k">案件</td><td>' + h_(c['案件名稱']) + '</td></tr><tr><td class="k">日期</td><td>' + h_(m['日期']) + '</td></tr><tr><td class="k">會議</td><td>' + h_(m['會議名稱']) + '</td></tr>'
      + (m['出席人'] ? '<tr><td class="k">出席</td><td>' + h_(m['出席人']) + '</td></tr>' : '') + '</table>'
      + (m['AI摘要'] ? '<h2>重點摘要</h2><div class="txt">' + h_(m['AI摘要']) + '</div>' + (m['核對人'] ? '<div class="im">已由 ' + h_(pname_(m['核對人'])) + ' 核對</div>' : '<div class="im">摘要尚未核對</div>') : '')
      + '<h2>決議與客戶指示（' + items.length + ' 項）</h2>' + (items.map(ciBlock_).join('') || '<div class="im">無</div>')
      + '<h2>客戶確認</h2><div class="txt">以上內容如無誤，請回覆「確認」；如有不同意見，請直接說明。</div>');
    name = '會議記錄_' + c['案件名稱'] + '_' + String(m['日期']).replace(/\//g, '-') + '.pdf'; src = d.meetingId; type = '會議記錄';
  } else {
    const x = rowObj_(findRow_('客戶指示', '指示ID', d.insId)); c = caseRow_(x['案件ID']);
    html = docHtml_('客戶指示確認單', c['案件名稱'] + '　' + x['日期'],
      '<table class="info"><tr><td class="k">案件</td><td>' + h_(c['案件名稱']) + '</td></tr><tr><td class="k">施工地點</td><td>' + h_(c['地址']) + '</td></tr></table>'
      + '<h2>客戶指示內容</h2>' + ciBlock_(x) + '<h2>客戶確認</h2><div class="txt">以上內容如無誤，請回覆「確認」；如有不同意見，請直接說明。</div>');
    name = '客戶確認單_' + c['案件名稱'] + '_' + String(x['日期']).replace(/\//g, '-') + '_' + d.insId.slice(0, 4) + '.pdf'; src = d.insId; type = '客戶確認單';
  }
  const file = saveDoc_(me, c, '客戶確認', name, html, type, src);
  if (d.meetingId) updateRow_('會議', '會議ID', d.meetingId, { 'PDF時間': now_() });   // 檔案真的建好才記錄
  return pdfOut_(file);
}

/* ========== 文件頁：週報、工程履歷 ==========
 * 只收「已簽核」的日誌（對外內容一致）；照片數量設上限避免檔案過大，完整照片在雲端資料夾。
 */
function logSection_(l, photos, insAll, maxPh) {
  const ph = activePhotos_(l['日誌ID'], photos).slice(0, maxPh);
  let t = '';
  for (let k = 0; k < ph.length; k += 2) t += '<tr>' + [ph[k], ph[k + 1]].map(p => p ? '<td><img src="' + photoData_(p['照片']) + '" width="230"><div class="pn">' + h_(p['說明'] || '') + '</div></td>' : '<td></td>').join('') + '</tr>';
  const ins = insAll.filter(i => i['日誌ID'] === l['日誌ID']);
  return '<h3>' + h_(l['日期']) + '　' + h_(String(l['工種'] || '').split(/\s*,\s*/).join('、')) + '　<span class="im">' + h_(pname_(l['填寫人'])) + '</span></h3>'
    + '<div class="txt">' + (h_(l['今日狀況']) || '（無）') + '</div>'
    + (l['發現問題'] ? '<div class="issue">' + h_(l['發現問題']) + '</div>' : '')
    + (t ? '<table class="ph">' + t + '</table>' : '')
    + ins.map(i => '<div class="item"><div class="txt">主管指示：' + h_(i['指示內容']) + '</div><div class="im">' + h_(insStatus_(i['狀態'])) + (i['負責人'] ? '・負責 ' + h_(pname_(i['負責人'])) : '') + (i['回報內容'] ? '・回報：' + h_(i['回報內容']) : '') + '</div></div>').join('');
}
function planTable_(items) {
  if (!items.length) return '<div class="im">尚未排定進度計畫</div>';
  return '<table class="grid"><tr><th>工序</th><th>計畫</th><th>實際</th><th>狀態</th></tr>' + items.map(r =>
    '<tr><td>' + h_(r['工序名稱']) + '</td><td>' + h_(String(r['目前計畫開始']).slice(5)) + '–' + h_(String(r['目前計畫完成']).slice(5)) + '</td><td>'
    + h_(String(r['實際開始'] || '').slice(5)) + (r['實際完成'] ? '–' + h_(String(r['實際完成']).slice(5)) : '') + '</td><td>' + (r['實際完成'] ? '完成' : r['實際開始'] ? '進行中' : '未開始') + '</td></tr>').join('') + '</table>';
}

/** 週報（d.from～d.to）或工程履歷（d.kind = 'resume'） */
function reportPdf_(me, d) {
  const c = planGuard_(me, d.caseId), cid = d.caseId;
  const photos = readTable_('日誌照片'), insAll = readTable_('主管指示').filter(i => i['案件ID'] === cid && i['指示內容']);
  const logs = readTable_('工程日誌').filter(l => l['案件ID'] === cid && logStatus_(l) === LS.SIGNED).sort((a, b) => (a['日期'] + a['建立時間']).localeCompare(b['日期'] + b['建立時間']));
  const plan = tryTable_('進度計畫').filter(r => r['案件ID'] === cid && r['狀態'] !== '取消').sort((a, b) => (+a['順序'] || 0) - (+b['順序'] || 0));
  const cis = tryTable_('客戶指示').filter(x => x['案件ID'] === cid);
  const info = '<table class="info"><tr><td class="k">案件</td><td>' + h_(c['案件名稱']) + '</td></tr><tr><td class="k">施工地點</td><td>' + h_(c['地址']) + '</td></tr><tr><td class="k">負責設計師</td><td>' + h_(pname_(c['負責設計師'])) + '</td></tr>';
  let html, name, type, src;
  if (d.kind === 'resume') {
    const meetings = tryTable_('會議').filter(m => m['案件ID'] === cid).sort((a, b) => String(a['日期']).localeCompare(String(b['日期'])));
    const checks = tryTable_('查驗紀錄').filter(x => x['案件ID'] === cid && x['完成'] === 'Y');
    const imp = cis.filter(x => x['影響費用或工期'] === 'Y' && x['確認狀態'] === '已確認'), sum = k => imp.reduce((a, x) => a + (+x[k] || 0), 0);
    let budget = 60, body = '';
    logs.forEach(l => { const n = Math.min(4, budget); budget -= Math.min(n, activePhotos_(l['日誌ID'], photos).length); body += logSection_(l, photos, insAll, n); });
    html = docHtml_('工程履歷', c['案件名稱'],
      info + (c['預計開工日'] ? '<tr><td class="k">預計工期</td><td>' + h_(c['預計開工日']) + '～' + h_(c['預計完工日']) + '</td></tr>' : '') + (c['實際完工日'] ? '<tr><td class="k">實際完工</td><td>' + h_(c['實際完工日']) + '</td></tr>' : '') + '</table>'
      + '<h2>工程進度</h2>' + planTable_(plan)
      + '<h2>追加減（客戶已確認）</h2>' + (imp.length ? imp.map(ciBlock_).join('') + '<div class="im">合計：' + sum('追加減金額') + ' 元，工期 ' + sum('影響工期天數') + ' 天</div>' : '<div class="im">無</div>')
      + '<h2>會議記錄</h2>' + (meetings.length ? meetings.map(m => '<h3>' + h_(m['日期']) + '　' + h_(m['會議名稱']) + '</h3>' + (m['AI摘要'] ? '<div class="txt">' + h_(m['AI摘要']) + '</div>' : '') + cis.filter(x => x['會議ID'] === m['會議ID']).map(ciBlock_).join('')).join('') : '<div class="im">無</div>')
      + '<h2>其他客戶指示</h2>' + (cis.filter(x => !x['會議ID']).map(ciBlock_).join('') || '<div class="im">無</div>')
      + '<h2>查驗紀錄</h2>' + (checks.length ? '<table class="grid"><tr><th>查驗點</th><th>項目</th><th>結果</th><th>說明</th></tr>' + checks.map(x => '<tr><td>' + h_(x['查驗點']) + '</td><td>' + h_(x['檢查項目']) + '</td><td>' + h_(x['狀態']) + '</td><td>' + h_(x['備註']) + '</td></tr>').join('') + '</table>' : '<div class="im">無</div>')
      + '<h2 class="pb">工程日誌（' + logs.length + ' 篇）</h2>' + (body || '<div class="im">無已簽核日誌</div>')
      + '<div class="im">照片最多收錄 60 張，完整照片請見案件雲端資料夾。</div>');
    name = '工程履歷_' + c['案件名稱'] + '_' + today_().replace(/\//g, '-') + '.pdf'; type = '工程履歷'; src = cid;
  } else {
    const from = ymd_(d.from), to = ymd_(d.to);
    if (!from || !to || to < from) throw new Error('請選擇正確的日期區間');
    const inRange = logs.filter(l => l['日期'] >= from && l['日期'] <= to);
    const openIns = insAll.filter(i => insStatus_(i['狀態']) !== IS.CLOSED);
    const ciR = cis.filter(x => x['日期'] >= from && x['日期'] <= to);
    const next = plan.filter(r => !r['實際完成'] && r['目前計畫開始'] && r['目前計畫開始'] <= fmt_(new Date(Date.now() + 14 * 864e5), 'yyyy/MM/dd'));
    html = docHtml_('工程週報', c['案件名稱'] + '　' + from + '～' + to,
      info + '<tr><td class="k">期間</td><td>' + h_(from) + '～' + h_(to) + '</td></tr></table>'
      + '<h2>本期施工（' + inRange.length + ' 篇已簽核日誌）</h2>' + (inRange.map(l => logSection_(l, photos, insAll, 2)).join('') || '<div class="im">本期沒有已簽核的日誌</div>')
      + '<h2>追蹤中事項</h2>' + (openIns.length ? openIns.map(i => '<div class="item"><div class="txt">' + h_(i['指示內容']) + '</div><div class="im">' + h_(insStatus_(i['狀態'])) + (i['期限'] ? '・期限 ' + h_(i['期限']) : '') + '</div></div>').join('') : '<div class="im">無</div>')
      + '<h2>本期客戶指示</h2>' + (ciR.map(ciBlock_).join('') || '<div class="im">無</div>')
      + '<h2>接下來兩週預計</h2>' + planTable_(next));
    name = '工程週報_' + c['案件名稱'] + '_' + from.replace(/\//g, '-') + '_' + to.replace(/\//g, '-') + '.pdf'; type = '週報'; src = cid + ':' + from + ':' + to;
  }
  return pdfOut_(saveDoc_(me, c, d.kind === 'resume' ? '工程履歷' : '週報', name, html, type, src));
}

/** 第一次安裝或新增權限時，在編輯器選這個函式按「執行」完成授權 */
function authorize() {
  secret_();
  UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=x', { muteHttpExceptions: true });
  CacheService.getScriptCache().get('x');
  Logger.log('授權完成');
}

/** 測試 PDF：在編輯器執行，會用最新一篇已簽核日誌產生 PDF，並在記錄中顯示檔案網址 */
function testPdf() {
  const l = readTable_('工程日誌').filter(x => x['日誌狀態'] === LS.SIGNED).pop();
  if (!l) { Logger.log('還沒有已簽核的日誌'); return; }
  Logger.log(makePdf_(l['日誌ID']).getUrl());
}


/* ========== 系統設定（公司設定、範本、經驗回流） ==========
 * 誰可以改：ADMIN_ROLES（暫定只有 Boss；主管可看）。範本停用用「啟用＝N」，不刪資料。
 */
const ADMIN_ROLES = ['Boss'];
const TPL = {
  '範本_工序': { key: '工序ID', pre: 'W', label: '工序', cols: ['順序', '工種', '工序名稱', '標準工期（工作天）', '查驗點', '備註'], need: '工序名稱' },
  '範本_查驗清單': { key: '檢查ID', pre: 'Q', label: '查驗清單', cols: ['查驗點', '順序', '檢查項目', '需拍照'], need: '檢查項目' },
  '範本_開案SOP': { key: '項目ID', pre: 'SOP', label: '開案 SOP', cols: ['順序', '項目', '說明', '負責角色'], need: '項目' },
  '範本_里程碑': { key: '里程碑ID', pre: 'M', label: '設計里程碑', cols: ['階段', '順序', '名稱', '負責角色', '相對天數', '說明'], need: '名稱' }
};
const SETTING_DEFAULTS = [
  ['範本狀態', '示範（待 Boss 確認）', '範本確認後改成「正式」，畫面上的「示範」字樣就會拿掉'],
  ['日誌填寫日', '一二三四五六', '施工中案件哪幾天要寫日誌（暫定）'],
  ['日誌截止時間', '10:00', '隔天幾點前補上才不算漏填（暫定）'],
  ['日誌追蹤起始日', '', '從哪天開始算漏填，空白＝預計開工日'],
  ['指示未回報提醒天數', '3', '指示超過幾天沒回報就提醒（暫定）'],
  ['延誤警告門檻（天）', '1', '工序晚幾天開始顯示延誤'],
  ['保固年限', '1', '結案後保固幾年']
];
function isAdmin_(me) { return ADMIN_ROLES.indexOf(me.role) >= 0; }
function admin_(me) {
  if (!me.leader) throw new Error('只有主管可以看系統設定');
  const cur = settings_(), desc = {};
  tryTable_('公司設定').forEach(r => { desc[r['項目']] = r['說明']; });
  const settings = SETTING_DEFAULTS.map(x => ({ key: x[0], value: cur[x[0]] !== undefined ? cur[x[0]] : x[1], note: desc[x[0]] || x[2], saved: cur[x[0]] !== undefined }));
  Object.keys(cur).forEach(k => { if (!settings.some(x => x.key === k)) settings.push({ key: k, value: cur[k], note: desc[k] || '', saved: true }); });
  const tpls = Object.keys(TPL).map(n => ({ name: n, label: TPL[n].label, key: TPL[n].key, cols: TPL[n].cols,
    rows: tryTable_(n).filter(r => r[TPL[n].key]).map(r => { const o = { id: r[TPL[n].key], on: r['啟用'] !== 'N' }; TPL[n].cols.forEach(c => { o[c] = r[c] || ''; }); return o; })
      .sort((a, b) => (n === '範本_查驗清單' ? (a['查驗點'] || '').localeCompare(b['查驗點'] || '') : n === '範本_里程碑' ? (a['階段'] === b['階段'] ? 0 : a['階段'] === '提案' ? -1 : 1) : 0) || (+a['順序'] || 0) - (+b['順序'] || 0)) }));
  const cname = id => { const c = id ? tryTable_('案件').find(x => x['案件ID'] === id) : null; return c ? c['案件名稱'] : ''; };
  const sugg = tryTable_('範本建議').map(r => ({ id: r['建議ID'], src: r['來源'], srcId: r['來源ID'], caseId: r['案件ID'], caseName: cname(r['案件ID']), tpl: r['範本'],
    text: r['內容'], by: r['提出人'], at: r['提出時間'], status: r['狀態'] || '待處理', doneBy: r['處理人'], doneAt: r['處理時間'], note: r['處理備註'] })).reverse();
  return { canEdit: isAdmin_(me), settings, tpls, sugg, trades: tryTable_('工種清單').filter(t => t['啟用'] !== 'N').map(t => t['工種']) };
}
function saveSetting_(me, d) {
  if (!isAdmin_(me)) throw new Error('只有 Boss 可以改公司設定');
  const key = String(d.key || '').trim(), val = String(d.value == null ? '' : d.value).trim();
  if (!key) throw new Error('缺設定項目');
  if (key === '日誌截止時間' && val && !/^\d{1,2}:\d{2}$/.test(val)) throw new Error('時間格式例如 10:00');
  if (['指示未回報提醒天數', '延誤警告門檻（天）', '保固年限'].indexOf(key) >= 0 && !(+val >= 0)) throw new Error('請填數字');
  if (key === '日誌填寫日' && !val.replace(/[^一二三四五六日]/g, '')) throw new Error('請填星期，例如：一二三四五六');
  const def = SETTING_DEFAULTS.find(x => x[0] === key);
  if (tryTable_('公司設定').some(r => r['項目'] === key)) updateRow_('公司設定', '項目', key, { '值': val });
  else appendRow_('公司設定', { '項目': key, '值': val, '說明': def ? def[2] : '' });
  _settings = null;
  return true;
}
function saveTemplateRow_(me, d) {
  if (!isAdmin_(me)) throw new Error('只有 Boss 可以改範本');
  const T = TPL[d.tpl];
  if (!T) throw new Error('沒有這個範本');
  const f = d.fields || {}, row = {};
  T.cols.forEach(c => { if (f[c] !== undefined) row[c] = String(f[c]).trim(); });
  if (d.on !== undefined) row['啟用'] = d.on ? 'Y' : 'N';
  if (row['工種'] && !tryTable_('工種清單').some(t => t['工種'] === row['工種'])) throw new Error('工種要先在「工種」清單裡：' + row['工種']);
  if (row['需拍照'] !== undefined) row['需拍照'] = row['需拍照'] === 'Y' ? 'Y' : 'N';
  if (d.id) { updateRow_(d.tpl, T.key, d.id, row); return d.id; }
  if (!row[T.need]) throw new Error('請填寫' + T.need);
  const id = T.pre + uid_().slice(0, 5).toUpperCase();
  row[T.key] = id; if (row['啟用'] === undefined) row['啟用'] = 'Y';
  appendRow_(d.tpl, row);
  return id;
}
/** 經驗回流：任何人都可以從指示、日誌問題提出「建議納入範本」，Boss 決定採納或不採納（採納後由 Boss 在範本裡改） */
function suggestTemplate_(me, d) {
  const text = String(d.text || '').trim();
  if (!text) throw new Error('請寫建議內容');
  if (d.tpl && !TPL[d.tpl]) throw new Error('沒有這個範本');
  appendRow_('範本建議', { '建議ID': uid_(), '來源': d.source || '手動', '來源ID': d.sourceId || '', '案件ID': d.caseId || '', '範本': d.tpl || '',
    '內容': text, '提出人': me.id, '提出時間': now_(), '狀態': '待處理' });
  return true;
}
function setSuggestion_(me, d) {
  if (!isAdmin_(me)) throw new Error('只有 Boss 可以處理範本建議');
  if (['已採納', '不採納', '待處理'].indexOf(d.status) < 0) throw new Error('狀態不正確');
  updateRow_('範本建議', '建議ID', d.id, { '狀態': d.status, '處理人': me.id, '處理時間': now_(), '處理備註': d.note || '' });
  return true;
}
