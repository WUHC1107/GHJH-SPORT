/**
 * 徑賽即時計圈與排名系統 (Track Lap Counter & Live Ranking)
 * 專為學校運動會裁判老師設計：支援離線、智慧型手機大字體、防誤觸、即時排名與最後一圈視覺提醒
 * （已完全移除所有語音與音效）
 */

(function () {
  'use strict';

  // ============================================================
  // 1. 預設常數與狀態 (State Management)
  // ============================================================
  const STORAGE_KEY = 'track_race_counter_data_v2';

  const defaultState = {
    totalLaps: 8,          // 預設 8 圈
    runnerCount: 30,       // 預設 30 位學生
    customNames: {},       // 自訂姓名背號 { 1: "王小明" }
    runners: [],           // 選手數據列表
    undoStack: [],         // 復原操作棧
    logs: [],              // 詳細紀錄列表
    timer: {
      isRunning: false,
      startTime: 0,
      elapsedTime: 0,
      lastTick: 0
    },
    settings: {
      vibrationEnabled: true,
      cooldownEnabled: true,
      theme: 'dark',
      gridColumns: 3,
      sortOrder: 'number', // 'number' 或 'rank'
      currentFilter: 'all'  // 'all', 'final', 'running', 'finished'
    }
  };

  let state = loadFromStorage() || createInitialState();
  let timerInterval = null;
  let alertTimeout = null;

  // ============================================================
  // 2. 初始化與 DOM 節點快取
  // ============================================================
  const el = {
    // 頂部橫幅
    alertBanner: document.getElementById('alertBanner'),
    alertTitle: document.getElementById('alertTitle'),
    alertDesc: document.getElementById('alertDesc'),
    alertDismissBtn: document.getElementById('alertDismissBtn'),

    // 標題與碼表
    raceSubtitle: document.getElementById('raceSubtitle'),
    timerDisplay: document.getElementById('timerDisplay'),
    timerStatusBadge: document.getElementById('timerStatusBadge'),
    startTimerBtn: document.getElementById('startTimerBtn'),
    startBtnText: document.getElementById('startBtnText'),
    pauseTimerBtn: document.getElementById('pauseTimerBtn'),
    resetTimerBtn: document.getElementById('resetTimerBtn'),

    // 統計
    statRunning: document.getElementById('statRunning'),
    statFinalLap: document.getElementById('statFinalLap'),
    statFinished: document.getElementById('statFinished'),

    // 頂部按鈕
    themeToggleBtn: document.getElementById('themeToggleBtn'),
    settingsModalBtn: document.getElementById('settingsModalBtn'),

    // 分頁
    tabBtns: document.querySelectorAll('.tab-btn'),
    tabPanes: document.querySelectorAll('.tab-pane'),

    // 網格與篩選
    filterChips: document.querySelectorAll('.chip'),
    countAll: document.getElementById('countAll'),
    countFinal: document.getElementById('countFinal'),
    countRunning: document.getElementById('countRunning'),
    countFinished: document.getElementById('countFinished'),
    toggleSortOrderBtn: document.getElementById('toggleSortOrderBtn'),
    sortOrderLabel: document.getElementById('sortOrderLabel'),
    columnBtns: document.querySelectorAll('.col-btn'),
    runnerGrid: document.getElementById('runnerGrid'),

    // 排名榜
    rankList: document.getElementById('rankList'),
    copyRankBtn: document.getElementById('copyRankBtn'),
    exportCsvBtn: document.getElementById('exportCsvBtn'),

    // 紀錄
    logList: document.getElementById('logList'),
    clearAllLogsConfirmBtn: document.getElementById('clearAllLogsConfirmBtn'),

    // 底部復原列
    lastActionText: document.getElementById('lastActionText'),
    undoBtn: document.getElementById('undoBtn'),
    undoSubText: document.getElementById('undoSubText'),

    // 設定 Modal
    settingsModal: document.getElementById('settingsModal'),
    closeSettingsBtn: document.getElementById('closeSettingsBtn'),
    saveSettingsBtn: document.getElementById('saveSettingsBtn'),
    inputTotalLaps: document.getElementById('inputTotalLaps'),
    valTotalLaps: document.getElementById('valTotalLaps'),
    inputRunnerCount: document.getElementById('inputRunnerCount'),
    valRunnerCount: document.getElementById('valRunnerCount'),
    switchVibration: document.getElementById('switchVibration'),
    switchCooldown: document.getElementById('switchCooldown'),
    customRunnerNames: document.getElementById('customRunnerNames'),
    resetAllDataBtn: document.getElementById('resetAllDataBtn'),

    // Toast
    toast: document.getElementById('toast')
  };

  // ============================================================
  // 3. 狀態初始化與存儲處理
  // ============================================================
  function createInitialState() {
    const s = JSON.parse(JSON.stringify(defaultState));
    s.runners = generateRunners(s.runnerCount, s.customNames);
    return s;
  }

  function generateRunners(count, namesMap = {}) {
    const list = [];
    for (let i = 1; i <= count; i++) {
      list.push({
        id: i,
        name: namesMap[i] || '',
        laps: 0,
        lapTimes: [],           // 每圈累計時間 [lap1Ms, lap2Ms, ...]
        lastLapTimestamp: null, // 最近一次通過起終點的時間戳
        finishedRank: null,     // 完賽名次 (1, 2, 3...)
        finishedTime: null      // 完賽用時 (毫秒)
      });
    }
    return list;
  }

  function saveToStorage() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      console.warn('無法存入 localStorage:', e);
    }
  }

  function loadFromStorage() {
    try {
      const data = localStorage.getItem(STORAGE_KEY);
      if (!data) return null;
      const parsed = JSON.parse(data);
      if (!parsed.runners || !parsed.settings) return null;
      return parsed;
    } catch (e) {
      console.warn('讀取 localStorage 失敗:', e);
      return null;
    }
  }

  // 震動反饋 (觸覺反饋，非音訊)
  function triggerVibration(pattern) {
    if (!state.settings.vibrationEnabled || !('vibrate' in navigator)) return;
    try {
      navigator.vibrate(pattern);
    } catch (e) {
      // 忽視不支援震動之設備
    }
  }

  // ============================================================
  // 4. 碼表計時控制 (Race Timer)
  // ============================================================
  function formatTime(ms) {
    if (ms < 0) ms = 0;
    const totalSec = Math.floor(ms / 1000);
    const tenths = Math.floor((ms % 1000) / 100);
    const minutes = Math.floor(totalSec / 60);
    const seconds = totalSec % 60;

    const mm = String(minutes).padStart(2, '0');
    const ss = String(seconds).padStart(2, '0');
    return `${mm}:${ss}.${tenths}`;
  }

  function getRaceElapsedMs() {
    if (!state.timer.isRunning) {
      return state.timer.elapsedTime;
    }
    return state.timer.elapsedTime + (Date.now() - state.timer.lastTick);
  }

  function updateTimerDisplay() {
    const elapsed = getRaceElapsedMs();
    el.timerDisplay.textContent = formatTime(elapsed);
  }

  function startTimer() {
    if (state.timer.isRunning) return;

    state.timer.isRunning = true;
    state.timer.lastTick = Date.now();
    if (!state.timer.startTime) {
      state.timer.startTime = Date.now();
    }

    clearInterval(timerInterval);
    timerInterval = setInterval(() => {
      updateTimerDisplay();
    }, 100);

    el.startTimerBtn.disabled = true;
    el.pauseTimerBtn.disabled = false;
    el.timerStatusBadge.className = 'timer-status-badge running';
    el.timerStatusBadge.textContent = '進行中';

    showToast('⏱️ 比賽計時開始！');
    saveToStorage();
  }

  function pauseTimer() {
    if (!state.timer.isRunning) return;

    state.timer.elapsedTime = getRaceElapsedMs();
    state.timer.isRunning = false;
    clearInterval(timerInterval);

    el.startTimerBtn.disabled = false;
    el.startBtnText.textContent = '繼續計時';
    el.pauseTimerBtn.disabled = true;
    el.timerStatusBadge.className = 'timer-status-badge paused';
    el.timerStatusBadge.textContent = '已暫停';

    showToast('⏸️ 比賽已暫停');
    saveToStorage();
  }

  function resetTimerConfirm() {
    if (confirm('確定要將比賽碼表歸零嗎？（選手計圈數仍會保留，如需全清請至設定重置）')) {
      clearInterval(timerInterval);
      state.timer.isRunning = false;
      state.timer.startTime = 0;
      state.timer.elapsedTime = 0;
      state.timer.lastTick = 0;

      el.startTimerBtn.disabled = false;
      el.startBtnText.textContent = '鳴槍起跑';
      el.pauseTimerBtn.disabled = true;
      el.timerStatusBadge.className = 'timer-status-badge stopped';
      el.timerStatusBadge.textContent = '未開始';
      updateTimerDisplay();
      saveToStorage();
      showToast('🔄 碼表已重置');
    }
  }

  // ============================================================
  // 5. 即時排名與計圈演算法
  // ============================================================
  /**
   * 計算即時排名順序
   * 規則：
   * 1. 完賽者排在最前，按完賽名次 (finishedRank)
   * 2. 進行中者：完成圈數多的優先
   * 3. 圈數相同時：較早通過該圈者優先 (lastLapTimestamp 較小者領先)
   * 4. 圈數皆為 0 時：按號碼順序排
   */
  function calculateRankings() {
    const list = [...state.runners];

    list.sort((a, b) => {
      // 若兩者皆完賽
      if (a.finishedRank !== null && b.finishedRank !== null) {
        return a.finishedRank - b.finishedRank;
      }
      // a 完賽，b 未完賽
      if (a.finishedRank !== null) return -1;
      // b 完賽，a 未完賽
      if (b.finishedRank !== null) return 1;

      // 未完賽：比較完成圈數 (降序)
      if (b.laps !== a.laps) {
        return b.laps - a.laps;
      }

      // 圈數相同：比時間戳 (升序，先達到該圈者領先)
      if (a.lastLapTimestamp && b.lastLapTimestamp) {
        return a.lastLapTimestamp - b.lastLapTimestamp;
      }

      return a.id - b.id;
    });

    return list;
  }

  // ============================================================
  // 6. 核心動作：點擊按鈕完成一圈 (Lap Increment)
  // ============================================================
  function handleRunnerLapClick(runnerId) {
    const runner = state.runners.find((r) => r.id === runnerId);
    if (!runner) return;

    // 若已完賽，防止誤加
    if (runner.laps >= state.totalLaps) {
      showToast(`⚠️ ${runner.id} 號已完賽 (第 ${runner.finishedRank} 名)，無法再加圈數！`);
      return;
    }

    // 若碼表尚未啟動，自動貼心幫裁判啟動
    if (!state.timer.isRunning && state.timer.elapsedTime === 0) {
      startTimer();
    }

    const elapsed = getRaceElapsedMs();
    const prevLaps = runner.laps;
    const newLaps = prevLaps + 1;
    const isEnteringFinalLap = (newLaps === state.totalLaps - 1);
    const isFinished = (newLaps === state.totalLaps);

    // 更新選手狀態
    runner.laps = newLaps;
    runner.lapTimes.push(elapsed);
    runner.lastLapTimestamp = Date.now();

    // 觸控防誤觸冷卻 (800ms)
    applyCooldownEffect(runnerId);

    // 完賽處理
    if (isFinished) {
      const finishedCount = state.runners.filter((r) => r.finishedRank !== null).length;
      runner.finishedRank = finishedCount + 1;
      runner.finishedTime = elapsed;
    }

    // 記錄歷史操作 (供復原與明細查看)
    const actionRecord = {
      actionId: 'action_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      runnerId: runner.id,
      runnerName: runner.name,
      lapBefore: prevLaps,
      lapAfter: newLaps,
      raceElapsed: elapsed,
      formattedTime: formatTime(elapsed),
      wallClock: new Date().toLocaleTimeString('zh-TW', { hour12: false }),
      isFinalLap: isEnteringFinalLap,
      isFinished: isFinished,
      finishedRank: runner.finishedRank
    };

    state.undoStack.push(actionRecord);
    state.logs.unshift(actionRecord);
    if (state.logs.length > 200) state.logs.pop();

    // 視覺提醒處理（無音效與語音）
    if (isEnteringFinalLap) {
      triggerFinalLapAlert(runner);
    } else if (isFinished) {
      triggerFinishAlert(runner);
    } else {
      triggerVibration(40);
    }

    // 更新底部復原按鈕與顯示
    updateUndoStatus();

    // 全面更新介面與儲存
    renderAll();
    saveToStorage();
  }

  // 進入最後一圈視覺橫幅與提醒（已移除聲音/語音）
  function triggerFinalLapAlert(runner) {
    triggerVibration([150, 100, 150, 100, 300]);

    const runnerNameStr = runner.name ? ` (${runner.name})` : '';
    el.alertTitle.textContent = `🔔 剩最後一圈提醒！`;
    el.alertDesc.textContent = `號碼 ${runner.id}${runnerNameStr} 進入最後一圈 (已完成 ${runner.laps}/${state.totalLaps} 圈)`;
    el.alertBanner.classList.remove('hidden');

    if (alertTimeout) clearTimeout(alertTimeout);
    alertTimeout = setTimeout(() => {
      el.alertBanner.classList.add('hidden');
    }, 6000);

    showToast(`🔔 ${runner.id} 號 進入最後一圈！`);
  }

  // 完賽視覺提醒（已移除聲音/語音）
  function triggerFinishAlert(runner) {
    triggerVibration([200, 100, 200]);
    showToast(`🏁 ${runner.id} 號完賽！獲得第 ${runner.finishedRank} 名 (${formatTime(runner.finishedTime)})`);
  }

  // 防連點冷卻視覺反饋
  function applyCooldownEffect(runnerId) {
    if (!state.settings.cooldownEnabled) return;
    const btn = document.querySelector(`.runner-btn[data-id="${runnerId}"]`);
    if (btn) {
      btn.classList.add('cooldown');
      setTimeout(() => {
        btn.classList.remove('cooldown');
      }, 700);
    }
  }

  // ============================================================
  // 7. 復原按鈕功能 (Undo - 核心防誤觸設計)
  // ============================================================
  function handleUndo() {
    if (state.undoStack.length === 0) return;

    const lastAction = state.undoStack.pop();
    const runner = state.runners.find((r) => r.id === lastAction.runnerId);
    if (!runner) return;

    // 回退圈數
    runner.laps = lastAction.lapBefore;
    runner.lapTimes.pop();
    runner.lastLapTimestamp = runner.lapTimes.length > 0 ? Date.now() : null;

    // 若原先已完賽，撤銷完賽名次
    if (lastAction.isFinished) {
      const revokedRank = runner.finishedRank;
      runner.finishedRank = null;
      runner.finishedTime = null;

      state.runners.forEach((r) => {
        if (r.finishedRank && r.finishedRank > revokedRank) {
          r.finishedRank -= 1;
        }
      });
    }

    state.logs.unshift({
      actionId: 'undo_' + Date.now(),
      runnerId: runner.id,
      runnerName: runner.name,
      lapBefore: lastAction.lapAfter,
      lapAfter: runner.laps,
      formattedTime: formatTime(getRaceElapsedMs()),
      wallClock: new Date().toLocaleTimeString('zh-TW', { hour12: false }),
      isUndo: true,
      desc: `已撤銷 ${runner.id} 號第 ${lastAction.lapAfter} 圈計次`
    });

    triggerVibration([80, 50, 80]);
    showToast(`↩ 已復原 ${runner.id} 號 (回復為 ${runner.laps} 圈)`);

    updateUndoStatus();
    renderAll();
    saveToStorage();
  }

  // 更新底欄復原按鈕狀態
  function updateUndoStatus() {
    if (state.undoStack.length === 0) {
      el.undoBtn.disabled = true;
      el.lastActionText.textContent = '尚無操作紀錄';
      el.undoSubText.textContent = '無動作可撤銷';
    } else {
      const last = state.undoStack[state.undoStack.length - 1];
      el.undoBtn.disabled = false;
      const desc = `#${last.runnerId} 號 完成第 ${last.lapAfter} 圈 (${last.formattedTime})`;
      el.lastActionText.textContent = desc;
      el.undoSubText.textContent = `撤銷 #${last.runnerId} 第 ${last.lapAfter} 圈`;
    }
  }

  // 單筆撤銷歷史紀錄
  function revokeLogItem(actionId) {
    const stackIdx = state.undoStack.findIndex((a) => a.actionId === actionId);
    if (stackIdx !== -1) {
      if (stackIdx === state.undoStack.length - 1) {
        handleUndo();
        return;
      }
    }

    if (confirm('此紀錄不是最後一步，確定要將該號碼扣除 1 圈嗎？')) {
      const item = state.logs.find((l) => l.actionId === actionId);
      if (!item) return;

      const runner = state.runners.find((r) => r.id === item.runnerId);
      if (runner && runner.laps > 0) {
        runner.laps -= 1;
        runner.lapTimes.pop();
        if (runner.finishedRank) {
          runner.finishedRank = null;
          runner.finishedTime = null;
        }
        showToast(`已扣除 ${runner.id} 號 1 圈`);
        renderAll();
        saveToStorage();
      }
    }
  }

  // ============================================================
  // 8. 介面渲染 (Render System)
  // ============================================================
  function renderAll() {
    renderSubtitle();
    renderStats();
    renderRunnerGrid();
    renderLeaderboard();
    renderLogList();
  }

  function renderSubtitle() {
    el.raceSubtitle.textContent = `總圈數：${state.totalLaps} 圈 ｜ 參賽：${state.runnerCount} 人`;
  }

  function renderStats() {
    const running = state.runners.filter((r) => r.laps < state.totalLaps).length;
    const finalLap = state.runners.filter((r) => r.laps === state.totalLaps - 1).length;
    const finished = state.runners.filter((r) => r.laps >= state.totalLaps).length;

    el.statRunning.textContent = running;
    el.statFinalLap.textContent = finalLap;
    el.statFinished.textContent = finished;

    el.countAll.textContent = state.runners.length;
    el.countFinal.textContent = finalLap;
    el.countRunning.textContent = running;
    el.countFinished.textContent = finished;
  }

  // 渲染 30 個學生按鈕矩陣
  function renderRunnerGrid() {
    const rankings = calculateRankings();
    const rankMap = new Map();
    rankings.forEach((r, idx) => {
      rankMap.set(r.id, idx + 1);
    });

    let displayList = [...state.runners];

    // 篩選過濾
    if (state.settings.currentFilter === 'final') {
      displayList = displayList.filter((r) => r.laps === state.totalLaps - 1);
    } else if (state.settings.currentFilter === 'running') {
      displayList = displayList.filter((r) => r.laps < state.totalLaps);
    } else if (state.settings.currentFilter === 'finished') {
      displayList = displayList.filter((r) => r.laps >= state.totalLaps);
    }

    // 排序
    if (state.settings.sortOrder === 'rank') {
      displayList.sort((a, b) => (rankMap.get(a.id) || 999) - (rankMap.get(b.id) || 999));
    } else {
      displayList.sort((a, b) => a.id - b.id);
    }

    el.runnerGrid.className = `runner-grid cols-${state.settings.gridColumns}`;

    if (displayList.length === 0) {
      el.runnerGrid.innerHTML = `
        <div style="grid-column: 1 / -1; text-align: center; padding: 30px; color: var(--text-muted);">
          目前此條件下無任何選手
        </div>
      `;
      return;
    }

    const fragment = document.createDocumentFragment();

    displayList.forEach((runner) => {
      const isFinalLap = (runner.laps === state.totalLaps - 1);
      const isFinished = (runner.laps >= state.totalLaps);
      const currentRank = rankMap.get(runner.id);
      const progressPercent = Math.min(100, Math.round((runner.laps / state.totalLaps) * 100));

      const card = document.createElement('button');
      card.type = 'button';
      card.dataset.id = runner.id;

      let stateClass = '';
      if (isFinished) {
        stateClass = 'state-finished';
      } else if (isFinalLap) {
        stateClass = 'state-final-lap';
      }

      card.className = `runner-btn ${stateClass}`;
      card.setAttribute('aria-label', `選手號碼 ${runner.id}，完成 ${runner.laps} 圈`);

      let badgeHtml = '';
      if (isFinished) {
        badgeHtml = `<span class="finished-badge">🏅 第 ${runner.finishedRank} 名完賽</span>`;
      } else if (isFinalLap) {
        badgeHtml = `<span class="final-lap-badge">🔔 最後1圈！</span>`;
      }

      const nameHtml = runner.name ? `<div class="runner-name">${escapeHtml(runner.name)}</div>` : '';

      card.innerHTML = `
        ${badgeHtml}
        <div class="runner-num">${runner.id}</div>
        ${nameHtml}
        <div class="runner-info-row">
          <span class="runner-laps">${runner.laps}/${state.totalLaps} 圈</span>
          <span class="runner-rank-badge">#${currentRank}</span>
        </div>
        <div class="runner-progress-bar">
          <div class="runner-progress-fill" style="width: ${progressPercent}%;"></div>
        </div>
      `;

      card.addEventListener('click', () => {
        handleRunnerLapClick(runner.id);
      });

      fragment.appendChild(card);
    });

    el.runnerGrid.innerHTML = '';
    el.runnerGrid.appendChild(fragment);
  }

  // 渲染即時排名榜
  function renderLeaderboard() {
    const sorted = calculateRankings();
    el.rankList.innerHTML = '';

    if (sorted.length === 0) {
      el.rankList.innerHTML = `<div style="text-align:center; padding: 20px; color: var(--text-muted);">暫無數據</div>`;
      return;
    }

    const fragment = document.createDocumentFragment();

    sorted.forEach((runner, idx) => {
      const rank = idx + 1;
      const isFinished = (runner.laps >= state.totalLaps);
      const isFinalLap = (runner.laps === state.totalLaps - 1);

      const card = document.createElement('div');
      let rankClass = '';
      if (rank === 1) rankClass = 'rank-1';
      else if (rank === 2) rankClass = 'rank-2';
      else if (rank === 3) rankClass = 'rank-3';

      card.className = `rank-card ${rankClass}`;

      let rankSymbol = rank;
      if (rank === 1) rankSymbol = '🥇';
      else if (rank === 2) rankSymbol = '🥈';
      else if (rank === 3) rankSymbol = '🥉';

      let statusBadge = '';
      if (isFinished) {
        statusBadge = `<span class="rank-status-tag tag-finished">完賽 (${formatTime(runner.finishedTime)})</span>`;
      } else if (isFinalLap) {
        statusBadge = `<span class="rank-status-tag tag-final">🔔 剩最後1圈</span>`;
      } else {
        statusBadge = `<span class="rank-status-tag tag-running">進行中</span>`;
      }

      const lastLapTime = runner.lapTimes.length > 0 
        ? formatTime(runner.lapTimes[runner.lapTimes.length - 1]) 
        : '--:--.-';

      card.innerHTML = `
        <div class="rank-left">
          <div class="rank-position">${rankSymbol}</div>
          <div class="rank-runner-badge">
            <span class="rank-runner-num">${runner.id}</span>
            ${runner.name ? `<span style="font-size:0.65rem; color:var(--text-secondary);">${escapeHtml(runner.name)}</span>` : ''}
          </div>
          <div class="rank-details">
            <span class="rank-laps-text">${runner.laps} / ${state.totalLaps} 圈</span>
            <span class="rank-time-text">最新用時: ${lastLapTime}</span>
          </div>
        </div>
        <div class="rank-right">
          ${statusBadge}
          <button class="btn btn-sm btn-primary rank-quick-add" data-id="${runner.id}" ${isFinished ? 'disabled' : ''}>
            +1圈
          </button>
        </div>
      `;

      const addBtn = card.querySelector('.rank-quick-add');
      addBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        handleRunnerLapClick(runner.id);
      });

      fragment.appendChild(card);
    });

    el.rankList.appendChild(fragment);
  }

  // 渲染操作日誌
  function renderLogList() {
    el.logList.innerHTML = '';
    if (state.logs.length === 0) {
      el.logList.innerHTML = `<div style="text-align:center; padding: 24px; color: var(--text-muted);">尚無點擊紀錄</div>`;
      return;
    }

    const fragment = document.createDocumentFragment();

    state.logs.slice(0, 50).forEach((item) => {
      const row = document.createElement('div');
      row.className = 'log-item';

      if (item.isUndo) {
        row.innerHTML = `
          <div class="log-item-info">
            <span class="log-time">${item.wallClock}</span>
            <span class="log-desc" style="color:var(--color-danger);">${item.desc}</span>
          </div>
        `;
      } else {
        row.innerHTML = `
          <div class="log-item-info">
            <span class="log-time">${item.formattedTime} (${item.wallClock})</span>
            <span class="log-desc">
              <strong>#${item.runnerId} 號</strong> 完成第 ${item.lapAfter} 圈
              ${item.isFinished ? ' 🏁 [完賽]' : (item.isFinalLap ? ' 🔔 [最後一圈]' : '')}
            </span>
          </div>
          <button class="log-revoke-btn" data-id="${item.actionId}">撤銷</button>
        `;

        const revokeBtn = row.querySelector('.log-revoke-btn');
        if (revokeBtn) {
          revokeBtn.addEventListener('click', () => {
            revokeLogItem(item.actionId);
          });
        }
      }

      fragment.appendChild(row);
    });

    el.logList.appendChild(fragment);
  }

  // ============================================================
  // 9. 匯出與複製成績 (Export / Copy)
  // ============================================================
  function generateResultText() {
    const sorted = calculateRankings();
    let text = `【徑賽成績總表】\n總圈數：${state.totalLaps} 圈 ｜ 參賽人數：${state.runnerCount} 人\n`;
    text += `------------------------------------\n`;
    text += `名次\t號碼\t姓名\t完成圈數\t完賽成績\n`;

    sorted.forEach((r, idx) => {
      const rank = idx + 1;
      const finishStr = r.finishedTime ? formatTime(r.finishedTime) : '未完賽';
      const name = r.name || '-';
      text += `第${rank}名\t#${r.id}\t${name}\t${r.laps}/${state.totalLaps}\t${finishStr}\n`;
    });

    return text;
  }

  function copyRankResults() {
    const text = generateResultText();
    navigator.clipboard.writeText(text).then(() => {
      showToast('📋 成績已複製至剪貼簿！可直接貼在 LINE 或 Excel');
    }).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      showToast('📋 成績已複製至剪貼簿！');
    });
  }

  function exportCsvFile() {
    const sorted = calculateRankings();
    let csv = '\uFEFF';
    csv += '即時名次,背號號碼,姓名,完成圈數,狀態,最新用時,各圈時間明細\n';

    sorted.forEach((r, idx) => {
      const rank = idx + 1;
      const isFinished = r.laps >= state.totalLaps;
      const status = isFinished ? `完賽(第${r.finishedRank}名)` : (r.laps === state.totalLaps - 1 ? '最後一圈' : '進行中');
      const timeStr = r.finishedTime ? formatTime(r.finishedTime) : (r.lapTimes.length > 0 ? formatTime(r.lapTimes[r.lapTimes.length - 1]) : '');
      const lapSplits = r.lapTimes.map((t, i) => `第${i + 1}圈:${formatTime(t)}`).join(' | ');

      csv += `"${rank}","${r.id}","${r.name || ''}","${r.laps}/${state.totalLaps}","${status}","${timeStr}","${lapSplits}"\n`;
    });

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const now = new Date();
    const dateStr = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}`;
    link.setAttribute('href', url);
    link.setAttribute('download', `徑賽計圈成績表_${dateStr}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showToast('📥 CSV 成績檔已下載！');
  }

  // ============================================================
  // 10. Toast 提示工具
  // ============================================================
  let toastTimer = null;
  function showToast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.toast.classList.remove('show');
    }, 2500);
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }

  // ============================================================
  // 11. 事件監聽綁定 (Event Listeners)
  // ============================================================
  function bindEvents() {
    // 碼表控制
    el.startTimerBtn.addEventListener('click', startTimer);
    el.pauseTimerBtn.addEventListener('click', pauseTimer);
    el.resetTimerBtn.addEventListener('click', resetTimerConfirm);

    // 復原按鈕
    el.undoBtn.addEventListener('click', handleUndo);

    // 頂部警告橫幅關閉
    el.alertDismissBtn.addEventListener('click', () => {
      el.alertBanner.classList.add('hidden');
    });

    // 戶外強光 / 暗色主題切換
    el.themeToggleBtn.addEventListener('click', () => {
      if (document.body.classList.contains('theme-light')) {
        document.body.classList.replace('theme-light', 'theme-dark');
        state.settings.theme = 'dark';
        el.themeToggleBtn.innerHTML = '<span>☀️</span>';
        el.themeToggleBtn.title = '切換至戶外強光模式';
      } else {
        document.body.classList.replace('theme-dark', 'theme-light');
        state.settings.theme = 'light';
        el.themeToggleBtn.innerHTML = '<span>🌙</span>';
        el.themeToggleBtn.title = '切換至暗色護眼模式';
      }
      saveToStorage();
    });

    // 分頁切換
    el.tabBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        const targetTab = btn.dataset.tab;
        el.tabBtns.forEach((b) => b.classList.remove('active'));
        el.tabPanes.forEach((p) => p.classList.add('hidden'));

        btn.classList.add('active');
        const targetPane = document.getElementById(targetTab);
        if (targetPane) targetPane.classList.remove('hidden');

        if (targetTab === 'rankTab') renderLeaderboard();
        if (targetTab === 'logTab') renderLogList();
      });
    });

    // 篩選晶片 (全部/最後一圈/進行中/已完賽)
    el.filterChips.forEach((chip) => {
      chip.addEventListener('click', () => {
        el.filterChips.forEach((c) => c.classList.remove('active'));
        chip.classList.add('active');
        state.settings.currentFilter = chip.dataset.filter;
        renderRunnerGrid();
      });
    });

    // 排序切換 (依號碼 / 依排名)
    el.toggleSortOrderBtn.addEventListener('click', () => {
      if (state.settings.sortOrder === 'number') {
        state.settings.sortOrder = 'rank';
        el.sortOrderLabel.textContent = '依名次排列';
      } else {
        state.settings.sortOrder = 'number';
        el.sortOrderLabel.textContent = '依號碼排列';
      }
      renderRunnerGrid();
    });

    // 欄數切換 (2欄 / 3欄 / 4欄)
    el.columnBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        el.columnBtns.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        state.settings.gridColumns = parseInt(btn.dataset.cols, 10);
        renderRunnerGrid();
      });
    });

    // 複製與匯出
    el.copyRankBtn.addEventListener('click', copyRankResults);
    el.exportCsvBtn.addEventListener('click', exportCsvFile);

    // 清空日誌確認
    el.clearAllLogsConfirmBtn.addEventListener('click', () => {
      if (confirm('確定要清空日誌明細嗎？（不會改變目前選手圈數）')) {
        state.logs = [];
        renderLogList();
        saveToStorage();
        showToast('日誌已清空');
      }
    });

    // 設定 Modal 相關
    el.settingsModalBtn.addEventListener('click', openSettingsModal);
    el.closeSettingsBtn.addEventListener('click', () => el.settingsModal.close());
    el.saveSettingsBtn.addEventListener('click', saveSettingsFromModal);

    el.inputTotalLaps.addEventListener('input', (e) => {
      el.valTotalLaps.textContent = e.target.value;
    });

    el.inputRunnerCount.addEventListener('input', (e) => {
      el.valRunnerCount.textContent = e.target.value;
    });

    el.resetAllDataBtn.addEventListener('click', resetAllDataConfirm);

    el.settingsModal.addEventListener('click', (e) => {
      if (e.target === el.settingsModal) {
        el.settingsModal.close();
      }
    });

    // 鍵盤空白鍵防滾動、支援熱鍵
    window.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        handleUndo();
      }
    });

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch((err) => {
        console.log('SW register skipped:', err);
      });
    }
  }

  // ============================================================
  // 12. 設定視窗操作 (Settings Modal)
  // ============================================================
  function openSettingsModal() {
    el.inputTotalLaps.value = state.totalLaps;
    el.valTotalLaps.textContent = state.totalLaps;

    el.inputRunnerCount.value = state.runnerCount;
    el.valRunnerCount.textContent = state.runnerCount;

    el.switchVibration.checked = state.settings.vibrationEnabled;
    el.switchCooldown.checked = state.settings.cooldownEnabled;

    const lines = [];
    for (let i = 1; i <= state.runnerCount; i++) {
      if (state.customNames[i]) {
        lines.push(`${i}號 ${state.customNames[i]}`);
      }
    }
    el.customRunnerNames.value = lines.join('\n');

    el.settingsModal.showModal();
  }

  function saveSettingsFromModal() {
    const newTotalLaps = parseInt(el.inputTotalLaps.value, 10);
    const newRunnerCount = parseInt(el.inputRunnerCount.value, 10);

    state.totalLaps = newTotalLaps;
    state.settings.vibrationEnabled = el.switchVibration.checked;
    state.settings.cooldownEnabled = el.switchCooldown.checked;

    const rawNames = el.customRunnerNames.value.trim().split('\n');
    const newCustomMap = {};
    rawNames.forEach((line) => {
      const match = line.match(/^(\d+)[\s號、.:-]+(.+)$/);
      if (match) {
        const id = parseInt(match[1], 10);
        newCustomMap[id] = match[2].trim();
      }
    });
    state.customNames = newCustomMap;

    if (newRunnerCount !== state.runnerCount) {
      state.runnerCount = newRunnerCount;
      if (newRunnerCount > state.runners.length) {
        for (let i = state.runners.length + 1; i <= newRunnerCount; i++) {
          state.runners.push({
            id: i,
            name: state.customNames[i] || '',
            laps: 0,
            lapTimes: [],
            lastLapTimestamp: null,
            finishedRank: null,
            finishedTime: null
          });
        }
      } else {
        state.runners = state.runners.slice(0, newRunnerCount);
      }
    }

    state.runners.forEach((r) => {
      r.name = state.customNames[r.id] || '';
    });

    el.settingsModal.close();
    renderAll();
    saveToStorage();
    showToast('⚙️ 設定已更新！');
  }

  function resetAllDataConfirm() {
    if (confirm('⚠️ 警告：確定要清空整場比賽的所有數據（包含計圈數、排名、碼表）重新開始嗎？')) {
      if (timerInterval) clearInterval(timerInterval);
      state = createInitialState();
      saveToStorage();
      el.settingsModal.close();
      renderAll();
      updateUndoStatus();
      updateTimerDisplay();
      el.startTimerBtn.disabled = false;
      el.startBtnText.textContent = '鳴槍起跑';
      el.pauseTimerBtn.disabled = true;
      el.timerStatusBadge.className = 'timer-status-badge stopped';
      el.timerStatusBadge.textContent = '未開始';
      showToast('🔄 已重新開局，所有選手計圈已歸零！');
    }
  }

  // ============================================================
  // 13. 啟動入口 (App Boot)
  // ============================================================
  function boot() {
    if (state.settings.theme === 'light') {
      document.body.classList.replace('theme-dark', 'theme-light');
      el.themeToggleBtn.innerHTML = '<span>🌙</span>';
      el.themeToggleBtn.title = '切換至暗色護眼模式';
    }

    el.columnBtns.forEach((btn) => {
      if (parseInt(btn.dataset.cols, 10) === state.settings.gridColumns) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });

    updateTimerDisplay();
    if (state.timer.isRunning) {
      startTimer();
    } else if (state.timer.elapsedTime > 0) {
      el.startBtnText.textContent = '繼續計時';
      el.timerStatusBadge.className = 'timer-status-badge paused';
      el.timerStatusBadge.textContent = '已暫停';
    }

    bindEvents();
    renderAll();
    updateUndoStatus();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
