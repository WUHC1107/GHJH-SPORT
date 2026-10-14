/**
 * GHJH SPORT 徑賽即時計圈與排名系統
 * 單屏免滾動 5x6 佈局 (30 位跑者全螢幕直覺觸控)、精簡介面、圈數上限8、人數上限30
 */

(function () {
  'use strict';

  // ============================================================
  // 1. 預設常數與狀態 (State Management)
  // ============================================================
  const STORAGE_KEY = 'ghjh_sport_race_data_v3';

  const defaultState = {
    totalLaps: 8,          // 預設 8 圈 (上限 8)
    runnerCount: 30,       // 預設 30 位學生 (上限 30)
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
      sortOrder: 'number' // 'number' 或 'rank'
    }
  };

  let state = loadFromStorage() || createInitialState();
  let timerInterval = null;
  let alertTimeout = null;

  // ============================================================
  // 2. 初始化與 DOM 節點快取
  // ============================================================
  const el = {
    alertBanner: document.getElementById('alertBanner'),
    alertTitle: document.getElementById('alertTitle'),
    alertDesc: document.getElementById('alertDesc'),
    alertDismissBtn: document.getElementById('alertDismissBtn'),

    timerDisplay: document.getElementById('timerDisplay'),
    startTimerBtn: document.getElementById('startTimerBtn'),
    startBtnText: document.getElementById('startBtnText'),
    pauseTimerBtn: document.getElementById('pauseTimerBtn'),
    resetTimerBtn: document.getElementById('resetTimerBtn'),

    statFinalLapPill: document.getElementById('statFinalLapPill'),
    statFinishedPill: document.getElementById('statFinishedPill'),

    themeToggleBtn: document.getElementById('themeToggleBtn'),
    settingsModalBtn: document.getElementById('settingsModalBtn'),

    tabBtns: document.querySelectorAll('.tab-btn'),
    tabPanes: document.querySelectorAll('.tab-pane'),

    toggleSortOrderBtn: document.getElementById('toggleSortOrderBtn'),
    sortOrderLabel: document.getElementById('sortOrderLabel'),
    runnerGrid: document.getElementById('runnerGrid'),

    rankList: document.getElementById('rankList'),
    copyRankBtn: document.getElementById('copyRankBtn'),
    exportCsvBtn: document.getElementById('exportCsvBtn'),

    logList: document.getElementById('logList'),
    clearAllLogsConfirmBtn: document.getElementById('clearAllLogsConfirmBtn'),

    lastActionText: document.getElementById('lastActionText'),
    undoBtn: document.getElementById('undoBtn'),
    undoSubText: document.getElementById('undoSubText'),

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

    toast: document.getElementById('toast')
  };

  // ============================================================
  // 3. 狀態初始化與存儲處理
  // ============================================================
  function createInitialState() {
    const s = JSON.parse(JSON.stringify(defaultState));
    s.totalLaps = Math.min(8, Math.max(1, s.totalLaps));
    s.runnerCount = Math.min(30, Math.max(1, s.runnerCount));
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
        lapTimes: [],
        lastLapTimestamp: null,
        finishedRank: null,
        finishedTime: null
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
      // 確保圈數與人數不超過上限
      parsed.totalLaps = Math.min(8, Math.max(1, parsed.totalLaps || 8));
      parsed.runnerCount = Math.min(30, Math.max(1, parsed.runnerCount || 30));
      return parsed;
    } catch (e) {
      console.warn('讀取 localStorage 失敗:', e);
      return null;
    }
  }

  function triggerVibration(pattern) {
    if (!state.settings.vibrationEnabled || !('vibrate' in navigator)) return;
    try {
      navigator.vibrate(pattern);
    } catch (e) {}
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

    showToast('⏱️ 計時開始');
    saveToStorage();
  }

  function pauseTimer() {
    if (!state.timer.isRunning) return;

    state.timer.elapsedTime = getRaceElapsedMs();
    state.timer.isRunning = false;
    clearInterval(timerInterval);

    el.startTimerBtn.disabled = false;
    el.startBtnText.textContent = '▶';
    el.pauseTimerBtn.disabled = true;

    showToast('⏸️ 已暫停');
    saveToStorage();
  }

  function resetTimerConfirm() {
    if (confirm('確定重置碼表？（計圈數仍保留）')) {
      clearInterval(timerInterval);
      state.timer.isRunning = false;
      state.timer.startTime = 0;
      state.timer.elapsedTime = 0;
      state.timer.lastTick = 0;

      el.startTimerBtn.disabled = false;
      el.startBtnText.textContent = '▶';
      el.pauseTimerBtn.disabled = true;
      updateTimerDisplay();
      saveToStorage();
      showToast('🔄 碼表已重置');
    }
  }

  // ============================================================
  // 5. 即時排名與計圈演算法
  // ============================================================
  function calculateRankings() {
    const list = [...state.runners];

    list.sort((a, b) => {
      if (a.finishedRank !== null && b.finishedRank !== null) {
        return a.finishedRank - b.finishedRank;
      }
      if (a.finishedRank !== null) return -1;
      if (b.finishedRank !== null) return 1;

      if (b.laps !== a.laps) {
        return b.laps - a.laps;
      }

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

    if (runner.laps >= state.totalLaps) {
      showToast(`${runner.id}號已完賽 (第${runner.finishedRank}名)`);
      return;
    }

    if (!state.timer.isRunning && state.timer.elapsedTime === 0) {
      startTimer();
    }

    const elapsed = getRaceElapsedMs();
    const prevLaps = runner.laps;
    const newLaps = prevLaps + 1;
    const isEnteringFinalLap = (newLaps === state.totalLaps - 1);
    const isFinished = (newLaps === state.totalLaps);

    runner.laps = newLaps;
    runner.lapTimes.push(elapsed);
    runner.lastLapTimestamp = Date.now();

    applyCooldownEffect(runnerId);

    if (isFinished) {
      const finishedCount = state.runners.filter((r) => r.finishedRank !== null).length;
      runner.finishedRank = finishedCount + 1;
      runner.finishedTime = elapsed;
    }

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

    if (isEnteringFinalLap) {
      triggerFinalLapAlert(runner);
    } else if (isFinished) {
      triggerFinishAlert(runner);
    } else {
      triggerVibration(40);
    }

    updateUndoStatus();
    renderAll();
    saveToStorage();
  }

  function triggerFinalLapAlert(runner) {
    triggerVibration([150, 100, 150, 100, 300]);

    el.alertTitle.textContent = `🔔 最後一圈！`;
    el.alertDesc.textContent = `${runner.id}號 進入最後一圈 (${runner.laps}/${state.totalLaps}圈)`;
    el.alertBanner.classList.remove('hidden');

    if (alertTimeout) clearTimeout(alertTimeout);
    alertTimeout = setTimeout(() => {
      el.alertBanner.classList.add('hidden');
    }, 4500);

    showToast(`🔔 ${runner.id}號 進入最後一圈！`);
  }

  function triggerFinishAlert(runner) {
    triggerVibration([200, 100, 200]);
    showToast(`🏁 ${runner.id}號完賽！第 ${runner.finishedRank} 名 (${formatTime(runner.finishedTime)})`);
  }

  function applyCooldownEffect(runnerId) {
    if (!state.settings.cooldownEnabled) return;
    const btn = document.querySelector(`.runner-btn[data-id="${runnerId}"]`);
    if (btn) {
      btn.classList.add('cooldown');
      setTimeout(() => {
        btn.classList.remove('cooldown');
      }, 650);
    }
  }

  // ============================================================
  // 7. 復原按鈕功能 (Undo)
  // ============================================================
  function handleUndo() {
    if (state.undoStack.length === 0) return;

    const lastAction = state.undoStack.pop();
    const runner = state.runners.find((r) => r.id === lastAction.runnerId);
    if (!runner) return;

    runner.laps = lastAction.lapBefore;
    runner.lapTimes.pop();
    runner.lastLapTimestamp = runner.lapTimes.length > 0 ? Date.now() : null;

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
      desc: `已撤銷 ${runner.id}號 第${lastAction.lapAfter}圈`
    });

    triggerVibration([80, 50, 80]);
    showToast(`↩ 已復原 ${runner.id}號 (回復為${runner.laps}圈)`);

    updateUndoStatus();
    renderAll();
    saveToStorage();
  }

  function updateUndoStatus() {
    if (state.undoStack.length === 0) {
      el.undoBtn.disabled = true;
      el.lastActionText.textContent = '就緒';
      el.undoSubText.textContent = '';
    } else {
      const last = state.undoStack[state.undoStack.length - 1];
      el.undoBtn.disabled = false;
      el.lastActionText.textContent = `#${last.runnerId}號 第${last.lapAfter}圈 (${last.formattedTime})`;
      el.undoSubText.textContent = `(#${last.runnerId})`;
    }
  }

  function revokeLogItem(actionId) {
    const stackIdx = state.undoStack.findIndex((a) => a.actionId === actionId);
    if (stackIdx !== -1 && stackIdx === state.undoStack.length - 1) {
      handleUndo();
      return;
    }

    if (confirm('確定撤銷此號碼 1 圈？')) {
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
        showToast(`已扣除 ${runner.id}號 1圈`);
        renderAll();
        saveToStorage();
      }
    }
  }

  // ============================================================
  // 8. 介面渲染 (Render System)
  // ============================================================
  function renderAll() {
    renderStats();
    renderRunnerGrid();
    renderLeaderboard();
    renderLogList();
  }

  function renderStats() {
    const finalLap = state.runners.filter((r) => r.laps === state.totalLaps - 1).length;
    const finished = state.runners.filter((r) => r.laps >= state.totalLaps).length;

    if (el.statFinalLapPill) el.statFinalLapPill.textContent = `🔔 ${finalLap}`;
    if (el.statFinishedPill) el.statFinishedPill.textContent = `🏁 ${finished}`;
  }

  // 渲染 30 個學生按鈕矩陣 (5欄x6行，完全單屏)
  function renderRunnerGrid() {
    const rankings = calculateRankings();
    const rankMap = new Map();
    rankings.forEach((r, idx) => {
      rankMap.set(r.id, idx + 1);
    });

    let displayList = [...state.runners];

    if (state.settings.sortOrder === 'rank') {
      displayList.sort((a, b) => (rankMap.get(a.id) || 999) - (rankMap.get(b.id) || 999));
    } else {
      displayList.sort((a, b) => a.id - b.id);
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
      card.setAttribute('aria-label', `${runner.id}號 ${runner.laps}圈`);

      let badgeHtml = '';
      if (isFinished) {
        badgeHtml = `<span class="finished-badge">#${runner.finishedRank}</span>`;
      } else if (isFinalLap) {
        badgeHtml = `<span class="final-lap-badge">🔔</span>`;
      }

      const nameHtml = runner.name ? `<div class="runner-name">${escapeHtml(runner.name)}</div>` : '';

      card.innerHTML = `
        ${badgeHtml}
        <div class="runner-num">${runner.id}</div>
        ${nameHtml}
        <div class="runner-info-row">
          <span class="runner-laps">${runner.laps}/${state.totalLaps}</span>
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

  function renderLeaderboard() {
    const sorted = calculateRankings();
    el.rankList.innerHTML = '';

    if (sorted.length === 0) {
      el.rankList.innerHTML = `<div style="text-align:center; padding: 20px; color: var(--text-muted);">無數據</div>`;
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

      const lastLapTime = runner.lapTimes.length > 0 
        ? formatTime(runner.lapTimes[runner.lapTimes.length - 1]) 
        : '--:--.-';

      card.innerHTML = `
        <div class="rank-left">
          <div class="rank-position">${rankSymbol}</div>
          <div class="rank-runner-badge">#${runner.id}</div>
          <div>
            <div class="rank-laps-text">${runner.laps}/${state.totalLaps}圈 ${isFinished ? '🏁' : (isFinalLap ? '🔔' : '')}</div>
            <div class="rank-time-text">${lastLapTime}</div>
          </div>
        </div>
        <button class="btn btn-sm btn-primary rank-quick-add" data-id="${runner.id}" ${isFinished ? 'disabled' : ''}>
          +1圈
        </button>
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

  function renderLogList() {
    el.logList.innerHTML = '';
    if (state.logs.length === 0) {
      el.logList.innerHTML = `<div style="text-align:center; padding: 20px; color: var(--text-muted);">無紀錄</div>`;
      return;
    }

    const fragment = document.createDocumentFragment();

    state.logs.slice(0, 40).forEach((item) => {
      const row = document.createElement('div');
      row.className = 'log-item';

      if (item.isUndo) {
        row.innerHTML = `
          <div>
            <span class="log-time">${item.wallClock}</span>
            <span style="color:var(--color-danger); margin-left: 6px;">${item.desc}</span>
          </div>
        `;
      } else {
        row.innerHTML = `
          <div>
            <span class="log-time">${item.formattedTime}</span>
            <span style="margin-left: 6px;"><strong>#${item.runnerId}</strong> 第${item.lapAfter}圈 ${item.isFinished ? '🏁' : ''}</span>
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
  // 9. 匯出與複製成績
  // ============================================================
  function generateResultText() {
    const sorted = calculateRankings();
    let text = `【GHJH SPORT 徑賽成績】\n總圈數：${state.totalLaps} 圈 ｜ 人數：${state.runnerCount} 人\n`;
    text += `------------------------------------\n`;
    text += `名次\t號碼\t完成圈數\t成績\n`;

    sorted.forEach((r, idx) => {
      const rank = idx + 1;
      const finishStr = r.finishedTime ? formatTime(r.finishedTime) : '未完賽';
      text += `第${rank}名\t#${r.id}\t${r.laps}/${state.totalLaps}\t${finishStr}\n`;
    });

    return text;
  }

  function copyRankResults() {
    const text = generateResultText();
    navigator.clipboard.writeText(text).then(() => {
      showToast('📋 已複製至剪貼簿');
    }).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      showToast('📋 已複製');
    });
  }

  function exportCsvFile() {
    const sorted = calculateRankings();
    let csv = '\uFEFF';
    csv += '名次,背號,完成圈數,狀態,用時,分圈明細\n';

    sorted.forEach((r, idx) => {
      const rank = idx + 1;
      const isFinished = r.laps >= state.totalLaps;
      const status = isFinished ? `完賽(#${r.finishedRank})` : (r.laps === state.totalLaps - 1 ? '最後一圈' : '進行中');
      const timeStr = r.finishedTime ? formatTime(r.finishedTime) : (r.lapTimes.length > 0 ? formatTime(r.lapTimes[r.lapTimes.length - 1]) : '');
      const lapSplits = r.lapTimes.map((t, i) => `第${i + 1}圈:${formatTime(t)}`).join(' | ');

      csv += `"${rank}","${r.id}","${r.laps}/${state.totalLaps}","${status}","${timeStr}","${lapSplits}"\n`;
    });

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const now = new Date();
    const dateStr = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}`;
    link.setAttribute('href', url);
    link.setAttribute('download', `GHJH_SPORT_成績_${dateStr}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showToast('📥 CSV 已下載');
  }

  let toastTimer = null;
  function showToast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.toast.classList.remove('show');
    }, 2000);
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }

  // ============================================================
  // 10. 事件綁定
  // ============================================================
  function bindEvents() {
    el.startTimerBtn.addEventListener('click', startTimer);
    el.pauseTimerBtn.addEventListener('click', pauseTimer);
    el.resetTimerBtn.addEventListener('click', resetTimerConfirm);

    el.undoBtn.addEventListener('click', handleUndo);

    el.alertDismissBtn.addEventListener('click', () => {
      el.alertBanner.classList.add('hidden');
    });

    el.themeToggleBtn.addEventListener('click', () => {
      if (document.body.classList.contains('theme-light')) {
        document.body.classList.replace('theme-light', 'theme-dark');
        state.settings.theme = 'dark';
        el.themeToggleBtn.textContent = '☀️';
      } else {
        document.body.classList.replace('theme-dark', 'theme-light');
        state.settings.theme = 'light';
        el.themeToggleBtn.textContent = '🌙';
      }
      saveToStorage();
    });

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

    el.toggleSortOrderBtn.addEventListener('click', () => {
      if (state.settings.sortOrder === 'number') {
        state.settings.sortOrder = 'rank';
        el.sortOrderLabel.textContent = '依名次';
      } else {
        state.settings.sortOrder = 'number';
        el.sortOrderLabel.textContent = '依號碼';
      }
      renderRunnerGrid();
    });

    el.copyRankBtn.addEventListener('click', copyRankResults);
    el.exportCsvBtn.addEventListener('click', exportCsvFile);

    el.clearAllLogsConfirmBtn.addEventListener('click', () => {
      if (confirm('確定清空日誌？')) {
        state.logs = [];
        renderLogList();
        saveToStorage();
        showToast('日誌已清空');
      }
    });

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

    window.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        handleUndo();
      }
    });
  }

  // ============================================================
  // 11. 設定視窗操作 (嚴格限制圈數<=8, 人數<=30)
  // ============================================================
  function openSettingsModal() {
    state.totalLaps = Math.min(8, Math.max(1, state.totalLaps || 8));
    state.runnerCount = Math.min(30, Math.max(1, state.runnerCount || 30));

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
    // 圈數預設及上限皆為 8，人數預設及上限皆為 30
    const newTotalLaps = Math.min(8, Math.max(1, parseInt(el.inputTotalLaps.value, 10) || 8));
    const newRunnerCount = Math.min(30, Math.max(1, parseInt(el.inputRunnerCount.value, 10) || 30));

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
    showToast('⚙️ 設定已更新');
  }

  function resetAllDataConfirm() {
    if (confirm('⚠️ 確定重置本場所有數據重新開局？')) {
      if (timerInterval) clearInterval(timerInterval);
      state = createInitialState();
      saveToStorage();
      el.settingsModal.close();
      renderAll();
      updateUndoStatus();
      updateTimerDisplay();
      el.startTimerBtn.disabled = false;
      el.startBtnText.textContent = '▶';
      el.pauseTimerBtn.disabled = true;
      showToast('🔄 已重新開局');
    }
  }

  // ============================================================
  // 12. 啟動入口
  // ============================================================
  function boot() {
    if (state.settings.theme === 'light') {
      document.body.classList.replace('theme-dark', 'theme-light');
      el.themeToggleBtn.textContent = '🌙';
    }

    updateTimerDisplay();
    if (state.timer.isRunning) {
      startTimer();
    } else if (state.timer.elapsedTime > 0) {
      el.startBtnText.textContent = '▶';
      el.pauseTimerBtn.disabled = true;
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
