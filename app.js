/**
 * 1500M 競速賽跑裁判記圈與即時排位系統 - 核心邏輯
 * 專為手機操作設計：單手快速計圈、防誤觸、即時排名運算、分段計時與匯出
 */

(function () {
  'use strict';

  // --- 設定與狀態儲存鍵值 ---
  const STORAGE_KEY = 'track_race_1500m_state_v1';
  const SETTINGS_KEY = 'track_race_1500m_settings_v1';

  // 預設比賽設定
  let config = {
    totalRunners: 30,
    targetLaps: 8,
    debounceMs: 1500,
    soundEnabled: true,
    vibrateEnabled: true,
    lightTheme: false,
    sortBy: 'number',
    filterBy: 'all'
  };

  // 賽事執行狀態
  let state = {
    timerRunning: false,
    startTime: 0,
    elapsedMs: 0,
    timerInterval: null,
    runners: [],
    historyStack: [],
    selectedRunnerId: null
  };

  // 音訊合成器 (Web Audio API)
  let audioCtx = null;

  function initAudio() {
    if (!audioCtx && (window.AudioContext || window.webkitAudioContext)) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AudioContextClass();
    }
  }

  function playBeep(freq = 600, duration = 0.08, type = 'sine') {
    if (!config.soundEnabled) return;
    try {
      initAudio();
      if (audioCtx) {
        if (audioCtx.state === 'suspended') {
          audioCtx.resume();
        }
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
        gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start();
        osc.stop(audioCtx.currentTime + duration);
      }
    } catch (e) {
      console.warn('Audio play failed', e);
    }
  }

  function playSuccessTone() {
    playBeep(880, 0.12, 'triangle');
  }

  function playFinishFanfare() {
    if (!config.soundEnabled) return;
    playBeep(523.25, 0.1, 'triangle');
    setTimeout(() => playBeep(659.25, 0.1, 'triangle'), 100);
    setTimeout(() => playBeep(783.99, 0.2, 'triangle'), 200);
  }

  function triggerVibrate(pattern = 40) {
    if (config.vibrateEnabled && navigator.vibrate) {
      try {
        navigator.vibrate(pattern);
      } catch (e) {}
    }
  }

  // --- 時間格式化公用函式 ---
  function formatTime(ms) {
    if (ms <= 0 || isNaN(ms)) return '00:00.00';
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const centiseconds = Math.floor((ms % 1000) / 10);
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centiseconds).padStart(2, '0')}`;
  }

  function formatShortTime(ms) {
    if (ms <= 0 || isNaN(ms)) return '--:--';
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  // --- 初始化選手陣列 ---
  function createRunnersArray(count) {
    const list = [];
    for (let i = 1; i <= count; i++) {
      list.push({
        id: i,
        bib: String(i).padStart(2, '0'),
        laps: [], // 每圈記錄: { lapNumber, timestampMs, lapDurationMs }
        isFinished: false,
        finishTimeMs: null,
        finishRank: null,
        rank: i,
        lastTapTimestamp: 0
      });
    }
    return list;
  }

  // --- 排名演算法 ---
  // 規則:
  // 1. 已完賽者依照完賽時間 (finishTimeMs) 由小到大排在最前面 (第 1 名、第 2 名...)
  // 2. 未完賽者依已完成圈數由多到少排序
  // 3. 同圈數者，依照該圈最後通過時間 (最近一次 lastLapTime) 由先到後排序
  // 4. 0 圈者按背號排序
  function updateRankings() {
    const sorted = [...state.runners].sort((a, b) => {
      // 完賽判定
      if (a.isFinished && !b.isFinished) return -1;
      if (!a.isFinished && b.isFinished) return 1;

      // 兩者皆完賽
      if (a.isFinished && b.isFinished) {
        return (a.finishTimeMs || 0) - (b.finishTimeMs || 0);
      }

      // 兩者皆未完賽: 先比圈數
      const lapsA = a.laps.length;
      const lapsB = b.laps.length;
      if (lapsA !== lapsB) {
        return lapsB - lapsA; // 圈數多者領先
      }

      // 圈數相同且 > 0: 比誰先完成該圈 (timestamp 較小者領先)
      if (lapsA > 0) {
        const lastA = a.laps[lapsA - 1].timestampMs;
        const lastB = b.laps[lapsB - 1].timestampMs;
        return lastA - lastB;
      }

      // 都還沒開始跑 (0 圈)
      return a.id - b.id;
    });

    let finishedCounter = 0;
    sorted.forEach((runner, idx) => {
      const realRank = idx + 1;
      const targetRunner = state.runners.find(r => r.id === runner.id);
      if (targetRunner) {
        targetRunner.rank = realRank;
        if (targetRunner.isFinished) {
          if (!targetRunner.finishRank) {
            finishedCounter++;
            targetRunner.finishRank = realRank;
          }
        } else {
          targetRunner.finishRank = null;
        }
      }
    });

    saveState();
  }

  // --- 記圈動作 (核心) ---
  function recordLap(runnerId, isManualAdjust = false) {
    const runner = state.runners.find(r => r.id === runnerId);
    if (!runner) return false;

    const now = getCurrentRaceTime();

    // 如果計時器未啟動，主動啟動計時器 (裁判起跑後第一圈按下的情況)
    if (!state.timerRunning && state.elapsedMs === 0) {
      startTimer();
    }

    // 防連點機制 (Debounce)
    const wallNow = Date.now();
    if (!isManualAdjust && config.debounceMs > 0) {
      if (runner.lastTapTimestamp && (wallNow - runner.lastTapTimestamp < config.debounceMs)) {
        showToast(`⚠️ ${runner.bib} 號防誤觸保護中 (請稍候再點)`);
        return false;
      }
    }
    runner.lastTapTimestamp = wallNow;

    // 若已完賽則不可再增加 (除非手動編輯)
    if (runner.laps.length >= config.targetLaps) {
      showToast(`🏆 ${runner.bib} 號已完成所有圈數 (${config.targetLaps} 圈)！`);
      return false;
    }

    const lapNum = runner.laps.length + 1;
    const prevLapTime = runner.laps.length > 0 ? runner.laps[runner.laps.length - 1].timestampMs : 0;
    const lapDuration = now - prevLapTime;

    const lapRecord = {
      lapNumber: lapNum,
      timestampMs: now,
      lapDurationMs: lapDuration
    };

    runner.laps.push(lapRecord);

    let isJustFinished = false;
    if (runner.laps.length >= config.targetLaps) {
      runner.isFinished = true;
      runner.finishTimeMs = now;
      isJustFinished = true;
    }

    // 儲存到 Undo 堆疊
    state.historyStack.push({
      action: 'ADD_LAP',
      runnerId: runner.id,
      lapNumber: lapNum,
      timestampMs: now,
      wasFinished: isJustFinished
    });

    updateRankings();

    // 音效與震動
    if (isJustFinished) {
      playFinishFanfare();
      triggerVibrate([60, 40, 100]);
      showToast(`🎉 ${runner.bib} 號 完賽！第 ${runner.rank} 名 (${formatTime(now)})`, true);
    } else {
      playSuccessTone();
      triggerVibrate(40);
      showToast(`已記錄: ${runner.bib} 號 (第 ${lapNum}/${config.targetLaps} 圈，名次 #${runner.rank})`, true);
    }

    renderAll();
    highlightButton(runner.id);
    return true;
  }

  // --- 扣減圈數 (復原或手動校正) ---
  function removeLap(runnerId) {
    const runner = state.runners.find(r => r.id === runnerId);
    if (!runner || runner.laps.length === 0) return false;

    const removed = runner.laps.pop();
    if (runner.isFinished) {
      runner.isFinished = false;
      runner.finishTimeMs = null;
      runner.finishRank = null;
    }

    state.historyStack.push({
      action: 'REMOVE_LAP',
      runnerId: runner.id,
      removedLap: removed
    });

    updateRankings();
    playBeep(350, 0.1);
    showToast(`↩️ 已取消 ${runner.bib} 號的第 ${removed.lapNumber} 圈紀錄`);
    renderAll();
    return true;
  }

  // --- 復原動作 (Undo) ---
  function undoLastAction() {
    if (state.historyStack.length === 0) return;

    const lastAction = state.historyStack.pop();
    const runner = state.runners.find(r => r.id === lastAction.runnerId);

    if (lastAction.action === 'ADD_LAP') {
      if (runner && runner.laps.length > 0) {
        runner.laps.pop();
        if (lastAction.wasFinished) {
          runner.isFinished = false;
          runner.finishTimeMs = null;
          runner.finishRank = null;
        }
        updateRankings();
        showToast(`↩️ 已復原：撤銷 ${runner.bib} 號第 ${lastAction.lapNumber} 圈`);
      }
    } else if (lastAction.action === 'REMOVE_LAP') {
      if (runner && lastAction.removedLap) {
        runner.laps.push(lastAction.removedLap);
        if (runner.laps.length >= config.targetLaps) {
          runner.isFinished = true;
          runner.finishTimeMs = lastAction.removedLap.timestampMs;
        }
        updateRankings();
        showToast(`↩️ 已復原：恢復 ${runner.bib} 號第 ${lastAction.removedLap.lapNumber} 圈`);
      }
    }

    playBeep(400, 0.08);
    renderAll();
  }

  // --- 計時器功能 ---
  function getCurrentRaceTime() {
    if (!state.timerRunning) return state.elapsedMs;
    return state.elapsedMs + (Date.now() - state.startTime);
  }

  function startTimer() {
    if (state.timerRunning) return;
    initAudio();
    state.timerRunning = true;
    state.startTime = Date.now();
    state.timerInterval = setInterval(updateTimerDisplay, 33); // ~30 fps 更新
    updateTimerControlsUI();
    saveState();
  }

  function pauseTimer() {
    if (!state.timerRunning) return;
    state.elapsedMs += (Date.now() - state.startTime);
    state.timerRunning = false;
    clearInterval(state.timerInterval);
    state.timerInterval = null;
    updateTimerDisplay();
    updateTimerControlsUI();
    saveState();
  }

  function resetRace() {
    const hasData = state.runners.some(r => r.laps.length > 0) || state.elapsedMs > 0;
    if (hasData) {
      const confirmReset = window.confirm('確定要重置比賽嗎？目前的圈數、時間與排名紀錄將全數清除！');
      if (!confirmReset) return;
    }

    if (state.timerInterval) clearInterval(state.timerInterval);
    state.timerRunning = false;
    state.timerInterval = null;
    state.startTime = 0;
    state.elapsedMs = 0;
    state.historyStack = [];
    state.runners = createRunnersArray(config.totalRunners);

    updateRankings();
    updateTimerDisplay();
    updateTimerControlsUI();
    renderAll();
    showToast('已重置所有選手資料與計時器');
  }

  function updateTimerDisplay() {
    const el = document.getElementById('timerDisplay');
    if (el) {
      el.textContent = formatTime(getCurrentRaceTime());
    }
  }

  function updateTimerControlsUI() {
    const btn = document.getElementById('timerToggleBtn');
    const textEl = document.getElementById('timerBtnText');
    const playIcon = document.getElementById('playIcon');

    if (!btn || !textEl) return;

    if (state.timerRunning) {
      btn.classList.add('running');
      textEl.textContent = '暫停計時';
      playIcon.innerHTML = '<rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect>';
    } else {
      btn.classList.remove('running');
      textEl.textContent = state.elapsedMs === 0 ? '鳴槍起跑' : '繼續計時';
      playIcon.innerHTML = '<polygon points="5 3 19 12 5 21 5 3"></polygon>';
    }
  }

  // --- 畫面視覺反饋 (按鈕閃爍) ---
  function highlightButton(runnerId) {
    const btn = document.getElementById(`runner-btn-${runnerId}`);
    if (btn) {
      btn.classList.remove('just-tapped');
      // 強制 reflow 以重啟動畫
      void btn.offsetWidth;
      btn.classList.add('just-tapped');
    }
  }

  // --- 吐司訊息 (Toast) ---
  let toastTimeout = null;
  function showToast(msg, canUndo = false) {
    const toast = document.getElementById('actionToast');
    const msgEl = document.getElementById('toastMessage');
    const undoBtn = document.getElementById('toastUndoBtn');

    if (!toast || !msgEl) return;

    msgEl.textContent = msg;
    undoBtn.style.display = canUndo ? 'block' : 'none';

    toast.classList.remove('hide');

    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
      toast.classList.add('hide');
    }, 3500);
  }

  // --- 畫面渲染核心函式 ---
  function renderAll() {
    renderHeaderStats();
    renderRunnerGrid();
    renderLeaderboard();
    renderLogsList();
    updateUndoButtonState();
  }

  function updateUndoButtonState() {
    const undoBtn = document.getElementById('undoBtn');
    if (undoBtn) {
      undoBtn.disabled = state.historyStack.length === 0;
    }
  }

  function renderHeaderStats() {
    const total = state.runners.length;
    const completed = state.runners.filter(r => r.isFinished).length;
    const running = total - completed;

    let leadLap = 0;
    state.runners.forEach(r => {
      if (r.laps.length > leadLap) leadLap = r.laps.length;
    });

    const totalTapped = state.runners.reduce((acc, r) => acc + r.laps.length, 0);

    const elCompleted = document.getElementById('statCompletedCount');
    const elRunning = document.getElementById('statRunningCount');
    const elLeadLap = document.getElementById('statLeadLap');
    const elTotalTaps = document.getElementById('statTotalLapsTapped');
    const elTabRankCount = document.getElementById('tabRankCount');
    const elRaceStatusLabel = document.getElementById('raceStatusLabel');

    if (elCompleted) elCompleted.textContent = completed;
    if (elRunning) elRunning.textContent = running;
    if (elLeadLap) elLeadLap.textContent = `${leadLap}/${config.targetLaps}`;
    if (elTotalTaps) elTotalTaps.textContent = totalTapped;
    if (elTabRankCount) elTabRankCount.textContent = `${completed}/${total}`;
    if (elRaceStatusLabel) elRaceStatusLabel.textContent = `1500M 競速賽 (目標 ${config.targetLaps} 圈 · ${total}人)`;
  }

  // 渲染號碼記圈盤 (GRID)
  function renderRunnerGrid() {
    const gridContainer = document.getElementById('runnerButtonsGrid');
    if (!gridContainer) return;

    // 取得排序後的選手副本
    let displayRunners = [...state.runners];

    // 依設定排序
    if (config.sortBy === 'rank') {
      displayRunners.sort((a, b) => a.rank - b.rank);
    } else if (config.sortBy === 'laps') {
      displayRunners.sort((a, b) => b.laps.length - a.laps.length || a.rank - b.rank);
    } else {
      displayRunners.sort((a, b) => a.id - b.id);
    }

    // 依分頁篩選
    if (config.filterBy === 'running') {
      displayRunners = displayRunners.filter(r => !r.isFinished);
    } else if (config.filterBy === 'finished') {
      displayRunners = displayRunners.filter(r => r.isFinished);
    }

    gridContainer.innerHTML = '';

    displayRunners.forEach(runner => {
      const card = document.createElement('div');
      card.id = `runner-btn-${runner.id}`;
      card.className = 'runner-card-btn';

      // 附加狀態 class
      if (runner.isFinished) {
        card.classList.add('is-finished');
        if (runner.rank === 1) card.classList.add('rank-1');
        else if (runner.rank === 2) card.classList.add('rank-2');
        else if (runner.rank === 3) card.classList.add('rank-3');
      } else if (runner.laps.length > 0) {
        card.classList.add('in-progress');
        if (runner.rank === 1) card.classList.add('rank-1');
        else if (runner.rank === 2) card.classList.add('rank-2');
        else if (runner.rank === 3) card.classList.add('rank-3');
      }

      // 進度百分比
      const lapCount = runner.laps.length;
      const progressPercent = Math.min(100, Math.round((lapCount / config.targetLaps) * 100));

      const lastLap = lapCount > 0 ? runner.laps[lapCount - 1] : null;
      const lastTimeFormatted = lastLap ? formatShortTime(lastLap.timestampMs) : '--:--';

      let rankLabel = `#${runner.rank}`;
      if (runner.isFinished) {
        rankLabel = runner.rank === 1 ? '🥇1' : runner.rank === 2 ? '🥈2' : runner.rank === 3 ? '🥉3' : `第${runner.rank}`;
      }

      card.innerHTML = `
        <div class="runner-card-header">
          <span class="rank-tag">${rankLabel}</span>
          <span class="card-lap-badge">${lapCount}/${config.targetLaps}</span>
        </div>
        <div class="bib-number">${runner.bib}</div>
        <div class="runner-progress-wrap">
          <div class="runner-progress-bar">
            <div class="runner-progress-fill" style="width: ${progressPercent}%;"></div>
          </div>
          <div class="runner-bottom-label">
            <span class="lap-count-text">${runner.isFinished ? '已完賽' : `圈 ${lapCount}`}</span>
            <span class="last-time-text">${lastTimeFormatted}</span>
          </div>
        </div>
      `;

      // 觸控與長按事件處理
      let pressTimer = null;
      let isLongPress = false;

      const handlePressStart = () => {
        isLongPress = false;
        pressTimer = setTimeout(() => {
          isLongPress = true;
          openRunnerModal(runner.id);
        }, 550); // 550ms 長按打開詳細視窗
      };

      const handlePressEnd = (e) => {
        if (pressTimer) clearTimeout(pressTimer);
        if (!isLongPress) {
          recordLap(runner.id);
        }
      };

      card.addEventListener('pointerdown', handlePressStart);
      card.addEventListener('pointerup', handlePressEnd);
      card.addEventListener('pointercancel', () => {
        if (pressTimer) clearTimeout(pressTimer);
      });

      // 防止行動裝置長按彈出預設右鍵選單
      card.addEventListener('contextmenu', (e) => e.preventDefault());

      gridContainer.appendChild(card);
    });
  }

  // 渲染即時排名榜 (LEADERBOARD)
  function renderLeaderboard() {
    const tbody = document.getElementById('leaderboardTbody');
    if (!tbody) return;

    const sortedRunners = [...state.runners].sort((a, b) => a.rank - b.rank);
    tbody.innerHTML = '';

    sortedRunners.forEach(runner => {
      const tr = document.createElement('tr');
      if (runner.rank === 1 && (runner.laps.length > 0 || runner.isFinished)) {
        tr.classList.add('leader-row');
      }

      let rankDisplay = runner.rank;
      let badgeClass = '';
      if (runner.rank === 1) { rankDisplay = '🥇 1'; badgeClass = 'gold'; }
      else if (runner.rank === 2) { rankDisplay = '🥈 2'; badgeClass = 'silver'; }
      else if (runner.rank === 3) { rankDisplay = '🥉 3'; badgeClass = 'bronze'; }

      const lapCount = runner.laps.length;
      const progressPercent = Math.min(100, Math.round((lapCount / config.targetLaps) * 100));
      const lastLap = lapCount > 0 ? runner.laps[lapCount - 1] : null;

      let statusHtml = '';
      if (runner.isFinished) {
        statusHtml = `<span class="status-badge finished">完賽 ${formatTime(runner.finishTimeMs)}</span>`;
      } else if (lapCount > 0) {
        statusHtml = `<span class="status-badge racing">跑動中</span>`;
      } else {
        statusHtml = `<span class="status-badge ready">待跑</span>`;
      }

      tr.innerHTML = `
        <td><div class="rank-badge-cell ${badgeClass}">${rankDisplay}</div></td>
        <td><span class="bib-pill">${runner.bib}</span></td>
        <td>
          <div class="progress-cell-wrap">
            <span class="progress-text">${lapCount} / ${config.targetLaps} 圈 (${progressPercent}%)</span>
            <div class="table-progress-bar">
              <div class="table-progress-fill ${runner.isFinished ? 'finish' : ''}" style="width: ${progressPercent}%;"></div>
            </div>
          </div>
        </td>
        <td><span class="time-stamp">${lastLap ? formatTime(lastLap.timestampMs) : '--:--.--'}</span></td>
        <td>${statusHtml}</td>
      `;

      tr.addEventListener('click', () => openRunnerModal(runner.id));
      tbody.appendChild(tr);
    });
  }

  // 渲染分圈明細與記錄列表 (LOGS)
  function renderLogsList() {
    const listContainer = document.getElementById('runnerLogsList');
    const searchVal = document.getElementById('logSearchInput')?.value?.trim().toLowerCase() || '';
    if (!listContainer) return;

    listContainer.innerHTML = '';

    const sortedRunners = [...state.runners].sort((a, b) => a.rank - b.rank);

    const filtered = sortedRunners.filter(r => {
      if (!searchVal) return true;
      return r.bib.includes(searchVal) || String(r.id) === searchVal;
    });

    if (filtered.length === 0) {
      listContainer.innerHTML = `<div style="text-align:center; padding:20px; color:var(--text-muted);">查無號碼為 ${searchVal} 的選手</div>`;
      return;
    }

    filtered.forEach(runner => {
      const card = document.createElement('div');
      card.className = 'runner-log-card';

      const lapRows = runner.laps.map(lap => `
        <tr>
          <td>第 ${lap.lapNumber} 圈</td>
          <td>${formatTime(lap.timestampMs)}</td>
          <td>+${formatTime(lap.lapDurationMs)}</td>
        </tr>
      `).join('');

      card.innerHTML = `
        <div class="runner-log-header">
          <div class="runner-log-title">
            <span class="bib-pill">${runner.bib} 號</span>
            <span style="font-weight:700; font-size:13px;">名次: #${runner.rank}</span>
            <span style="font-size:12px; color:var(--text-muted);">${runner.laps.length}/${config.targetLaps} 圈</span>
          </div>
          <div>
            ${runner.isFinished ? `<span class="status-badge finished">完賽 ${formatTime(runner.finishTimeMs)}</span>` : ''}
          </div>
        </div>
        ${runner.laps.length > 0 ? `
          <table class="runner-log-laps-table">
            <thead>
              <tr>
                <th>圈次</th>
                <th>累積通過時間</th>
                <th>該圈耗時 (Lap)</th>
              </tr>
            </thead>
            <tbody>
              ${lapRows}
            </tbody>
          </table>
        ` : '<div style="font-size:11px; color:var(--text-muted); margin-top:6px;">尚無過圈紀錄</div>'}
      `;

      listContainer.appendChild(card);
    });
  }

  // --- 選手詳細與手動調整 Modal ---
  function openRunnerModal(runnerId) {
    state.selectedRunnerId = runnerId;
    const runner = state.runners.find(r => r.id === runnerId);
    if (!runner) return;

    const modal = document.getElementById('runnerModal');
    const bibEl = document.getElementById('modalRunnerBib');
    const titleEl = document.getElementById('modalRunnerTitle');
    const rankEl = document.getElementById('modalRunnerRank');
    const lapsEl = document.getElementById('modalCompletedLaps');
    const lastTimeEl = document.getElementById('modalLastTime');
    const lapListEl = document.getElementById('modalLapHistoryList');
    const adjustLapNumEl = document.getElementById('modalAdjustLapNum');

    bibEl.textContent = `#${runner.bib}`;
    titleEl.textContent = `選手 ${runner.bib} 號 紀錄詳情`;
    rankEl.textContent = runner.isFinished ? `已完賽 · 第 ${runner.rank} 名` : `目前排名第 ${runner.rank} 名`;
    lapsEl.textContent = `${runner.laps.length} / ${config.targetLaps} 圈`;
    adjustLapNumEl.textContent = runner.laps.length;

    const lastLap = runner.laps.length > 0 ? runner.laps[runner.laps.length - 1] : null;
    lastTimeEl.textContent = lastLap ? formatTime(lastLap.timestampMs) : '--:--.--';

    if (runner.laps.length === 0) {
      lapListEl.innerHTML = '<div style="padding:10px; color:var(--text-muted); font-size:12px; text-align:center;">目前無圈次資料</div>';
    } else {
      lapListEl.innerHTML = runner.laps.map(lap => `
        <div class="lap-history-item">
          <span>第 ${lap.lapNumber} 圈</span>
          <span>${formatTime(lap.timestampMs)} (+${formatTime(lap.lapDurationMs)})</span>
        </div>
      `).join('');
    }

    modal.classList.remove('hide');
  }

  function closeRunnerModal() {
    const modal = document.getElementById('runnerModal');
    modal.classList.add('hide');
    state.selectedRunnerId = null;
  }

  // --- 匯出功能 ---
  function exportCSV() {
    let csv = '\uFEFF'; // UTF-8 BOM
    csv += '排名,號碼衣,完成圈數,狀態,完賽時間';
    for (let i = 1; i <= config.targetLaps; i++) {
      csv += `,第${i}圈通過時間,第${i}圈單圈用時`;
    }
    csv += '\n';

    const sortedRunners = [...state.runners].sort((a, b) => a.rank - b.rank);
    sortedRunners.forEach(r => {
      const statusText = r.isFinished ? '已完賽' : `${r.laps.length}/${config.targetLaps}圈中`;
      const finishTimeText = r.isFinished ? formatTime(r.finishTimeMs) : '';

      let row = `${r.rank},"${r.bib}",${r.laps.length},${statusText},${finishTimeText}`;

      for (let i = 0; i < config.targetLaps; i++) {
        if (r.laps[i]) {
          row += `,${formatTime(r.laps[i].timestampMs)},${formatTime(r.laps[i].lapDurationMs)}`;
        } else {
          row += ',,';
        }
      }
      csv += row + '\n';
    });

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `1500m_運動會成績單_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showToast('✅ 已匯出 CSV 成績單！');
  }

  function copySummaryText() {
    const sorted = [...state.runners].sort((a, b) => a.rank - b.rank);
    let text = `【1500M 競速賽 成績摘要】(目標: ${config.targetLaps} 圈)\n`;
    text += `賽事累計時間: ${formatTime(getCurrentRaceTime())}\n`;
    text += `-----------------------------------------\n`;

    sorted.forEach(r => {
      if (r.isFinished) {
        text += `第 ${r.rank} 名: ${r.bib} 號 | 完賽時間: ${formatTime(r.finishTimeMs)}\n`;
      } else if (r.laps.length > 0) {
        const last = r.laps[r.laps.length - 1];
        text += `第 ${r.rank} 名: ${r.bib} 號 | 完成 ${r.laps.length} 圈 | 最後通過: ${formatTime(last.timestampMs)}\n`;
      }
    });

    navigator.clipboard.writeText(text).then(() => {
      showToast('📋 成績摘要已成功複製至剪貼簿！');
    }).catch(() => {
      showToast('⚠️ 複製失敗，請手動匯出 CSV');
    });
  }

  // --- 狀態儲存 (LocalStorage) ---
  function saveState() {
    try {
      const payload = {
        config,
        state: {
          elapsedMs: state.elapsedMs,
          timerRunning: state.timerRunning,
          startTime: state.startTime,
          runners: state.runners,
          historyStack: state.historyStack
        }
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (e) {
      console.warn('LocalStorage save error', e);
    }
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.config) Object.assign(config, parsed.config);
        if (parsed.state) {
          state.elapsedMs = parsed.state.elapsedMs || 0;
          state.runners = parsed.state.runners || [];
          state.historyStack = parsed.state.historyStack || [];
          // 如果先前是在計時狀態，恢復計時
          if (parsed.state.timerRunning && parsed.state.startTime) {
            const timePassed = Date.now() - parsed.state.startTime;
            state.elapsedMs += timePassed;
            state.timerRunning = true;
            state.startTime = Date.now();
            state.timerInterval = setInterval(updateTimerDisplay, 33);
          }
        }
      }
    } catch (e) {
      console.warn('LocalStorage load error', e);
    }

    if (!state.runners || state.runners.length === 0) {
      state.runners = createRunnersArray(config.totalRunners);
    }
  }

  // --- 事件綁定 ---
  function bindEvents() {
    // 計時器按鈕
    const timerBtn = document.getElementById('timerToggleBtn');
    timerBtn.addEventListener('click', () => {
      if (state.timerRunning) {
        pauseTimer();
      } else {
        startTimer();
      }
    });

    const resetBtn = document.getElementById('timerResetBtn');
    resetBtn.addEventListener('click', resetRace);

    // 復原按鈕 (頂部與浮動 Toast)
    document.getElementById('undoBtn').addEventListener('click', undoLastAction);
    document.getElementById('toastUndoBtn').addEventListener('click', () => {
      undoLastAction();
      document.getElementById('actionToast').classList.add('hide');
    });

    // 陽光高對比模式切換
    const themeBtn = document.getElementById('themeToggleBtn');
    themeBtn.addEventListener('click', () => {
      config.lightTheme = !config.lightTheme;
      applyTheme();
      saveState();
    });

    // 分頁切換
    const tabs = document.querySelectorAll('.tab-btn');
    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const viewId = tab.dataset.view;
        document.querySelectorAll('.view-panel').forEach(p => p.classList.remove('active'));
        if (viewId === 'grid') document.getElementById('viewGrid').classList.add('active');
        if (viewId === 'leaderboard') document.getElementById('viewLeaderboard').classList.add('active');
        if (viewId === 'logs') document.getElementById('viewLogs').classList.add('active');
      });
    });

    // 排序選擇
    const sortSelect = document.getElementById('gridSortSelect');
    sortSelect.addEventListener('change', (e) => {
      config.sortBy = e.target.value;
      renderRunnerGrid();
      saveState();
    });

    // 篩選按鈕
    const chips = document.querySelectorAll('.filter-chips .chip');
    chips.forEach(chip => {
      chip.addEventListener('click', () => {
        chips.forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        config.filterBy = chip.dataset.filter;
        renderRunnerGrid();
      });
    });

    // 搜尋選手
    const searchInput = document.getElementById('logSearchInput');
    if (searchInput) {
      searchInput.addEventListener('input', renderLogsList);
    }

    // 匯出 CSV 與複製
    document.getElementById('exportCsvBtn').addEventListener('click', exportCSV);
    document.getElementById('copySummaryBtn').addEventListener('click', copySummaryText);

    // 選手 Modal 互動
    document.getElementById('closeModalBtn').addEventListener('click', closeRunnerModal);
    document.getElementById('modalDoneBtn').addEventListener('click', closeRunnerModal);

    document.getElementById('modalPlusLapBtn').addEventListener('click', () => {
      if (state.selectedRunnerId) {
        recordLap(state.selectedRunnerId, true);
        openRunnerModal(state.selectedRunnerId);
      }
    });

    document.getElementById('modalMinusLapBtn').addEventListener('click', () => {
      if (state.selectedRunnerId) {
        removeLap(state.selectedRunnerId);
        openRunnerModal(state.selectedRunnerId);
      }
    });

    // 設定 Modal
    const settingsBtn = document.getElementById('settingsBtn');
    const settingsModal = document.getElementById('settingsModal');
    const closeSettingsBtn = document.getElementById('closeSettingsBtn');
    const saveSettingsBtn = document.getElementById('saveSettingsBtn');

    settingsBtn.addEventListener('click', () => {
      document.getElementById('settingTotalRunners').value = config.totalRunners;
      document.getElementById('settingTargetLaps').value = config.targetLaps;
      document.getElementById('settingDebounce').checked = config.debounceMs > 0;
      document.getElementById('settingSound').checked = config.soundEnabled;
      document.getElementById('settingVibrate').checked = config.vibrateEnabled;
      settingsModal.classList.remove('hide');
    });

    closeSettingsBtn.addEventListener('click', () => {
      settingsModal.classList.add('hide');
    });

    saveSettingsBtn.addEventListener('click', () => {
      const newTotal = parseInt(document.getElementById('settingTotalRunners').value, 10) || 30;
      const newLaps = parseInt(document.getElementById('settingTargetLaps').value, 10) || 8;
      const debounceCheck = document.getElementById('settingDebounce').checked;

      config.debounceMs = debounceCheck ? 1500 : 0;
      config.soundEnabled = document.getElementById('settingSound').checked;
      config.vibrateEnabled = document.getElementById('settingVibrate').checked;

      // 如果更改了人數
      if (newTotal !== config.totalRunners) {
        if (window.confirm(`更改人數至 ${newTotal} 人將重置現有賽事，確定嗎？`)) {
          config.totalRunners = Math.min(60, Math.max(2, newTotal));
          config.targetLaps = Math.min(25, Math.max(1, newLaps));
          resetRace();
        }
      } else {
        config.targetLaps = Math.min(25, Math.max(1, newLaps));
        updateRankings();
        renderAll();
      }

      saveState();
      settingsModal.classList.add('hide');
      showToast('設定已套用');
    });

    document.getElementById('clearAllDataBtn').addEventListener('click', () => {
      if (window.confirm('確定要徹底清空所有紀錄並重置嗎？')) {
        localStorage.removeItem(STORAGE_KEY);
        resetRace();
        settingsModal.classList.add('hide');
      }
    });
  }

  function applyTheme() {
    if (config.lightTheme) {
      document.body.classList.add('light-theme');
    } else {
      document.body.classList.remove('light-theme');
    }
  }

  // --- 啟動初始化 ---
  function init() {
    loadState();
    applyTheme();
    bindEvents();
    updateTimerControlsUI();
    updateTimerDisplay();
    updateRankings();
    renderAll();
  }

  // DOM 就緒後啟動
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
