/**
 * GHJH SPORT - 運動會徑賽計圈與即時排名系統
 * 特性：高對比大字、一屏全覽、零滑動、多步復原、零彈窗、零音效、純前端離線
 */

(function () {
  'use strict';

  // ----------------------------------------------------
  // 常數與初始設定
  // ----------------------------------------------------
  const STORAGE_KEY = 'GHJH_SPORT_STATE_V1';
  const DEFAULT_TOTAL_LAPS = 8;       // 預設至多 8 圈
  const DEFAULT_ATHLETES_COUNT = 30;  // 預設 30 位學生

  // 全域狀態
  let state = {
    totalLaps: DEFAULT_TOTAL_Laps_Safe(DEFAULT_TOTAL_LAPS),
    totalAthletes: DEFAULT_ATHLETES_COUNT,
    athletes: [],       // 陣列長度 30
    history: [],        // 動作歷程 (用於 Undo)
    actionSeq: 0,       // 全域動作序號計數器
    finishCount: 0,     // 已完賽人數
    outdoorTheme: false // 戶外烈日高對比模式
  };

  function DEFAULT_TOTAL_Laps_Safe(val) {
    return Math.max(1, Math.min(20, parseInt(val, 10) || 8));
  }

  // ----------------------------------------------------
  // DOM 元素快取
  // ----------------------------------------------------
  const elements = {
    gridContainer: document.getElementById('gridContainer'),
    btnUndo: document.getElementById('btnUndo'),
    undoTargetBadge: document.getElementById('undoTargetBadge'),
    bellBanner: document.getElementById('bellBanner'),
    finalLapList: document.getElementById('finalLapList'),
    leaderSummary: document.getElementById('leaderSummary'),
    targetLapsDisplay: document.getElementById('targetLapsDisplay'),
    statusMessage: document.getElementById('statusMessage'),

    // 抽屜與按鈕
    btnRankToggle: document.getElementById('btnRankToggle'),
    rankDrawer: document.getElementById('rankDrawer'),
    btnCloseRank: document.getElementById('btnCloseRank'),
    rankListContainer: document.getElementById('rankListContainer'),
    rankDrawerLapInfo: document.getElementById('rankDrawerLapInfo'),

    btnSettingsToggle: document.getElementById('btnSettingsToggle'),
    settingsDrawer: document.getElementById('settingsDrawer'),
    btnCloseSettings: document.getElementById('btnCloseSettings'),
    inputTotalLaps: document.getElementById('inputTotalLaps'),
    btnLapMinus: document.getElementById('btnLapMinus'),
    btnLapPlus: document.getElementById('btnLapPlus'),
    inputTotalAthletes: document.getElementById('inputTotalAthletes'),
    btnAthMinus: document.getElementById('btnAthMinus'),
    btnAthPlus: document.getElementById('btnAthPlus'),
    btnResetMatch: document.getElementById('btnResetMatch'),
    resetBtnText: document.getElementById('resetBtnText'),

    btnThemeToggle: document.getElementById('btnThemeToggle'),
    themeIcon: document.getElementById('themeIcon'),
    drawerBackdrop: document.getElementById('drawerBackdrop')
  };

  // ----------------------------------------------------
  // 狀態初始化與 LocalStorage 持久化
  // ----------------------------------------------------
  function initAthletes() {
    state.athletes = [];
    for (let i = 1; i <= 30; i++) {
      state.athletes.push({
        id: i,
        bib: i < 10 ? '0' + i : '' + i,
        laps: 0,
        lastTimestamp: 0,
        lastSeq: 0,
        finishRank: null, // 完賽名次 (1, 2, 3...)
        finishTime: null
      });
    }
  }

  function loadState() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        state.totalLaps = parsed.totalLaps || DEFAULT_TOTAL_LAPS;
        state.totalAthletes = parsed.totalAthletes || DEFAULT_ATHLETES_COUNT;
        state.athletes = parsed.athletes || [];
        state.history = parsed.history || [];
        state.actionSeq = parsed.actionSeq || 0;
        state.finishCount = parsed.finishCount || 0;
        state.outdoorTheme = !!parsed.outdoorTheme;

        // 確保 30 位選手結構完整
        if (!state.athletes || state.athletes.length !== 30) {
          initAthletes();
        }
      } else {
        initAthletes();
      }
    } catch (e) {
      console.warn('無法讀取本地儲存，重新初始化', e);
      initAthletes();
    }
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        totalLaps: state.totalLaps,
        totalAthletes: state.totalAthletes,
        athletes: state.athletes,
        history: state.history,
        actionSeq: state.actionSeq,
        finishCount: state.finishCount,
        outdoorTheme: state.outdoorTheme
      }));
    } catch (e) {
      // 避免儲存空間滿時報錯
    }
  }

  // ----------------------------------------------------
  // 排名計算核心算法
  // ----------------------------------------------------
  function calculateRankings() {
    const activeAthletes = state.athletes.filter(a => a.id <= state.totalAthletes);

    // 排序權重：
    // 1. 已完賽者最前 (finishRank 由小到大)
    // 2. 未完賽者依完成圈數 laps 由大到小
    // 3. 圈數相同時，依據達成最後一圈的 sequence/timestamp 先後 (先達成者前)
    // 4. 0 圈者依號碼由小到大排列在後
    const sorted = [...activeAthletes].sort((a, b) => {
      const aDone = a.laps >= state.totalLaps;
      const bDone = b.laps >= state.totalLaps;

      if (aDone && bDone) {
        return (a.finishRank || 999) - (b.finishRank || 999);
      }
      if (aDone && !bDone) return -1;
      if (!aDone && bDone) return 1;

      // 雙方皆未完賽
      if (a.laps !== b.laps) {
        return b.laps - a.laps; // 圈數多者領先
      }

      // 圈數相同
      if (a.laps > 0) {
        return a.lastSeq - b.lastSeq; // 先完成該圈者領先
      }

      return a.id - b.id; // 均為 0 圈按號碼排
    });

    // 映射當前即時名次 (1 ~ totalAthletes)
    const rankMap = new Map();
    sorted.forEach((athlete, index) => {
      rankMap.set(athlete.id, index + 1);
    });

    return { sorted, rankMap };
  }

  // ----------------------------------------------------
  // 核心計圈與操作邏輯
  // ----------------------------------------------------
  let clickCoolDowns = new Map(); // 針對單一號碼防連按抖動 (300ms)

  function recordLap(athleteId) {
    const now = Date.now();
    const lastClick = clickCoolDowns.get(athleteId) || 0;
    if (now - lastClick < 300) {
      return; // 忽略過於快速的誤連按
    }
    clickCoolDowns.set(athleteId, now);

    const athlete = state.athletes.find(a => a.id === athleteId);
    if (!athlete || athlete.id > state.totalAthletes) return;

    if (athlete.laps >= state.totalLaps) {
      showStatusMessage(`#${athlete.bib} 號已完賽 (第 ${athlete.finishRank} 名)`, true);
      return;
    }

    // 儲存操作前快照 (供 Undo)
    state.actionSeq++;
    const prevLaps = athlete.laps;
    const prevTimestamp = athlete.lastTimestamp;
    const prevSeq = athlete.lastSeq;
    const prevFinishRank = athlete.finishRank;

    // 推進 1 圈
    athlete.laps++;
    athlete.lastTimestamp = now;
    athlete.lastSeq = state.actionSeq;

    // 檢查是否完賽
    let newlyFinished = false;
    if (athlete.laps >= state.totalLaps) {
      state.finishCount++;
      athlete.finishRank = state.finishCount;
      athlete.finishTime = now;
      newlyFinished = true;
    }

    // 記錄至歷史堆疊 (支援多步 Undo)
    state.history.push({
      action: 'LAP_INCREMENT',
      athleteId: athlete.id,
      bib: athlete.bib,
      prevLaps,
      prevTimestamp,
      prevSeq,
      prevFinishRank,
      newlyFinished
    });

    // 狀態反饋
    const isFinalLap = (athlete.laps === state.totalLaps - 1);
    if (newlyFinished) {
      showStatusMessage(`🏁 #${athlete.bib} 號完賽！獲得第 ${athlete.finishRank} 名`, true);
    } else if (isFinalLap) {
      showStatusMessage(`🔔 #${athlete.bib} 號進入最後 1 圈！請提醒選手！`, true);
    } else {
      showStatusMessage(`✓ #${athlete.bib} 號完成第 ${athlete.laps}/${state.totalLaps} 圈`);
    }

    // 震動微反饋 (若支援)
    if (navigator.vibrate) {
      if (isFinalLap) {
        navigator.vibrate([80, 50, 80]); // 醒目短震動兩次
      } else {
        navigator.vibrate(35); // 輕微觸控確認
      }
    }

    saveState();
    render();
  }

  // 復原按鈕 (Undo)
  function undoLastAction() {
    if (state.history.length === 0) return;

    const lastAction = state.history.pop();
    const athlete = state.athletes.find(a => a.id === lastAction.athleteId);

    if (lastAction.action === 'LAP_INCREMENT') {
      if (lastAction.newlyFinished) {
        state.finishCount = Math.max(0, state.finishCount - 1);
      }
      athlete.laps = lastAction.prevLaps;
      athlete.lastTimestamp = lastAction.prevTimestamp;
      athlete.lastSeq = lastAction.prevSeq;
      athlete.finishRank = lastAction.prevFinishRank;

      showStatusMessage(`↶ 已復原：#${athlete.bib} 號回到 ${athlete.laps} 圈`, true);
    } else if (lastAction.action === 'LAP_DECREMENT') {
      // 復原先前的手動減圈
      athlete.laps = lastAction.prevLaps;
      athlete.lastTimestamp = lastAction.prevTimestamp;
      athlete.lastSeq = lastAction.prevSeq;
      athlete.finishRank = lastAction.prevFinishRank;

      showStatusMessage(`↶ 已復原：#${athlete.bib} 號還原為 ${athlete.laps} 圈`, true);
    }

    saveState();
    render();
  }

  // 手動減 1 圈 (長按號碼按鈕觸發，用於個別號碼校正)
  function decrementLap(athleteId) {
    const athlete = state.athletes.find(a => a.id === athleteId);
    if (!athlete || athlete.laps <= 0) return;

    state.actionSeq++;
    const prevLaps = athlete.laps;
    const prevTimestamp = athlete.lastTimestamp;
    const prevSeq = athlete.lastSeq;
    const prevFinishRank = athlete.finishRank;
    const wasFinished = (athlete.laps >= state.totalLaps);

    if (wasFinished) {
      state.finishCount = Math.max(0, state.finishCount - 1);
      athlete.finishRank = null;
      athlete.finishTime = null;
    }

    athlete.laps--;
    athlete.lastTimestamp = Date.now();
    athlete.lastSeq = state.actionSeq;

    state.history.push({
      action: 'LAP_DECREMENT',
      athleteId: athlete.id,
      bib: athlete.bib,
      prevLaps,
      prevTimestamp,
      prevSeq,
      prevFinishRank,
      wasFinished
    });

    showStatusMessage(`⚠️ 已將 #${athlete.bib} 號倒退 1 圈 (現為 ${athlete.laps} 圈)`, true);

    if (navigator.vibrate) {
      navigator.vibrate(60);
    }

    saveState();
    render();
  }

  // ----------------------------------------------------
  // 重置比賽 (雙重無彈窗確認)
  // ----------------------------------------------------
  let resetConfirmTimer = null;
  function handleResetMatch() {
    if (!elements.btnResetMatch.classList.contains('confirming')) {
      // 第一次點擊：進入確認狀態
      elements.btnResetMatch.classList.add('confirming');
      elements.resetBtnText.textContent = '⚠️ 請在 3 秒內再點一次以確認重設！';

      clearTimeout(resetConfirmTimer);
      resetConfirmTimer = setTimeout(() => {
        elements.btnResetMatch.classList.remove('confirming');
        elements.resetBtnText.textContent = '重新開始新比賽';
      }, 3000);
    } else {
      // 第二次點擊：真正重置
      clearTimeout(resetConfirmTimer);
      elements.btnResetMatch.classList.remove('confirming');
      elements.resetBtnText.textContent = '重新開始新比賽';

      initAthletes();
      state.history = [];
      state.actionSeq = 0;
      state.finishCount = 0;

      saveState();
      closeDrawers();
      render();
      showStatusMessage('✨ 比賽數據已重置，準備開始！', true);
    }
  }

  // ----------------------------------------------------
  // 介面渲染 (Render)
  // ----------------------------------------------------
  function render() {
    const { sorted, rankMap } = calculateRankings();
    const finalLapAthletes = [];

    // 1. 渲染 30 個選手號碼按鈕
    elements.gridContainer.innerHTML = '';
    
    state.athletes.forEach(athlete => {
      const btn = document.createElement('div');
      btn.className = 'student-btn';
      btn.dataset.id = athlete.id;

      // 檢查是否超出參賽人數
      if (athlete.id > state.totalAthletes) {
        btn.classList.add('state-disabled');
      }

      const isFinished = athlete.laps >= state.totalLaps;
      const isFinalLap = !isFinished && athlete.laps === (state.totalLaps - 1);
      const isRunning = !isFinished && !isFinalLap && athlete.laps > 0;

      if (isFinished) {
        btn.classList.add('state-finished');
      } else if (isFinalLap) {
        btn.classList.add('state-final-lap');
        if (athlete.id <= state.totalAthletes) {
          finalLapAthletes.push(athlete);
        }
      } else if (isRunning) {
        btn.classList.add('state-running');
      }

      // 號碼數字
      const bibEl = document.createElement('div');
      bibEl.className = 'student-bib';
      bibEl.textContent = athlete.bib;

      // 圈數與狀態文字
      const statusEl = document.createElement('div');
      statusEl.className = 'student-status-text';
      if (isFinished) {
        statusEl.textContent = `完賽 No.${athlete.finishRank}`;
      } else if (isFinalLap) {
        statusEl.textContent = `🔔剩1圈`;
      } else if (athlete.laps === 0) {
        statusEl.textContent = `0圈`;
      } else {
        statusEl.textContent = `${athlete.laps}/${state.totalLaps}圈`;
      }

      // 右上角即時排名小角標 (有跑動時才顯示)
      const rankBadge = document.createElement('div');
      rankBadge.className = 'student-rank-badge';
      if (athlete.laps > 0 && athlete.id <= state.totalAthletes) {
        const curRank = rankMap.get(athlete.id);
        rankBadge.textContent = `#${curRank}`;
        rankBadge.classList.add('visible');
        if (curRank === 1) rankBadge.classList.add('rank-1');
        else if (curRank === 2) rankBadge.classList.add('rank-2');
        else if (curRank === 3) rankBadge.classList.add('rank-3');
      }

      // 底部微型進度條
      const progressBar = document.createElement('div');
      progressBar.className = 'student-progress-bar';
      const progressFill = document.createElement('div');
      progressFill.className = 'student-progress-fill';
      const progressPercent = Math.min(100, Math.round((athlete.laps / state.totalLaps) * 100));
      progressFill.style.width = `${progressPercent}%`;
      progressBar.appendChild(progressFill);

      btn.appendChild(rankBadge);
      btn.appendChild(bibEl);
      btn.appendChild(statusEl);
      btn.appendChild(progressBar);

      // 點擊事件與長按微調綁定
      bindButtonEvents(btn, athlete.id);

      elements.gridContainer.appendChild(btn);
    });

    // 2. 渲染最後一圈醒目提醒看板 (專門方便裁判高喊)
    renderBellBanner(finalLapAthletes);

    // 3. 渲染頂部即時領先摘要
    renderLeaderSummary(sorted);

    // 4. 更新復原按鈕狀態
    renderUndoButton();

    // 5. 更新設定面板數值與抽屜排名
    elements.targetLapsDisplay.textContent = `${state.totalLaps} 圈`;
    elements.inputTotalLaps.value = state.totalLaps;
    elements.inputTotalAthletes.value = state.totalAthletes;
    elements.rankDrawerLapInfo.textContent = `(目標 ${state.totalLaps} 圈 / 參賽 ${state.totalAthletes} 人)`;

    if (elements.rankDrawer.classList.contains('open')) {
      renderRankDrawer(sorted);
    }
  }

  // 綁定號碼按鈕觸控 (點擊 + 長按倒退1圈)
  function bindButtonEvents(btn, athleteId) {
    let pressTimer = null;
    let isLongPress = false;

    const startPress = (e) => {
      isLongPress = false;
      pressTimer = setTimeout(() => {
        isLongPress = true;
        decrementLap(athleteId);
      }, 750); // 長按 750ms 觸發減圈
    };

    const cancelPress = () => {
      clearTimeout(pressTimer);
    };

    btn.addEventListener('touchstart', startPress, { passive: true });
    btn.addEventListener('touchend', (e) => {
      cancelPress();
      if (!isLongPress) {
        recordLap(athleteId);
      }
    });
    btn.addEventListener('touchcancel', cancelPress);

    // 支援滑鼠操作 (PC 或測試時)
    btn.addEventListener('mousedown', startPress);
    btn.addEventListener('mouseup', () => {
      cancelPress();
      if (!isLongPress) {
        recordLap(athleteId);
      }
    });
    btn.addEventListener('mouseleave', cancelPress);
  }

  // 渲染最後一圈提醒看板
  function renderBellBanner(finalLapAthletes) {
    if (finalLapAthletes.length > 0) {
      elements.bellBanner.classList.add('has-alert');
      elements.finalLapList.innerHTML = '';
      finalLapAthletes.forEach(ath => {
        const chip = document.createElement('span');
        chip.className = 'final-bib-chip';
        chip.textContent = `#${ath.bib}`;
        elements.finalLapList.appendChild(chip);
      });
    } else {
      elements.bellBanner.classList.remove('has-alert');
      elements.finalLapList.innerHTML = '<span class="empty-tip">目前無進入最後一圈選手</span>';
    }
  }

  // 渲染即時領先摘要
  function renderLeaderSummary(sorted) {
    const runningOrDone = sorted.filter(a => a.laps > 0);
    if (runningOrDone.length === 0) {
      elements.leaderSummary.textContent = '比賽準備中，點擊號碼開始計圈';
      return;
    }

    const leaders = runningOrDone.slice(0, 3).map((a, i) => {
      const medal = i === 0 ? '🥇' : (i === 1 ? '🥈' : '🥉');
      const status = a.laps >= state.totalLaps ? '完賽' : `${a.laps}圈`;
      return `${medal}#${a.bib}(${status})`;
    });

    elements.leaderSummary.textContent = leaders.join('  ');
  }

  // 渲染復原按鈕
  function renderUndoButton() {
    if (state.history.length > 0) {
      elements.btnUndo.disabled = false;
      const last = state.history[state.history.length - 1];
      elements.undoTargetBadge.textContent = `#${last.bib}`;
      elements.undoTargetBadge.classList.add('active');
    } else {
      elements.btnUndo.disabled = true;
      elements.undoTargetBadge.textContent = '';
      elements.undoTargetBadge.classList.remove('active');
    }
  }

  // 渲染排名抽屜總表
  function renderRankDrawer(sorted) {
    elements.rankListContainer.innerHTML = '';

    sorted.forEach((athlete, index) => {
      const rankNum = index + 1;
      const row = document.createElement('div');
      row.className = 'rank-row';

      if (rankNum === 1) row.classList.add('top-1');
      if (rankNum === 2) row.classList.add('top-2');
      if (rankNum === 3) row.classList.add('top-3');

      const isFinished = athlete.laps >= state.totalLaps;
      const isFinalLap = !isFinished && athlete.laps === (state.totalLaps - 1);

      if (isFinished) row.classList.add('status-finished');
      if (isFinalLap) row.classList.add('status-final');

      let statusHtml = '';
      if (isFinished) {
        statusHtml = `<span class="status-tag tag-done">完賽 (${athlete.finishRank})</span>`;
      } else if (isFinalLap) {
        statusHtml = `<span class="status-tag tag-final">🔔剩最後1圈</span>`;
      } else if (athlete.laps > 0) {
        statusHtml = `<span class="status-tag tag-running">進行中</span>`;
      } else {
        statusHtml = `<span class="status-tag" style="background:#334155;color:#94a3b8;">未出發</span>`;
      }

      row.innerHTML = `
        <div class="col-rank-num">${rankNum <= 3 ? ['🥇','🥈','🥉'][rankNum-1] : rankNum}</div>
        <div class="col-bib-num">#${athlete.bib}</div>
        <div class="col-laps-detail">${athlete.laps} / ${state.totalLaps} 圈</div>
        <div>${statusHtml}</div>
      `;

      elements.rankListContainer.appendChild(row);
    });
  }

  // 狀態列小提示
  let statusTimeout = null;
  function showStatusMessage(msg, isHighlight = false) {
    clearTimeout(statusTimeout);
    elements.statusMessage.textContent = msg;
    if (isHighlight) {
      elements.statusMessage.classList.add('highlight');
      statusTimeout = setTimeout(() => {
        elements.statusMessage.classList.remove('highlight');
        elements.statusMessage.textContent = '點擊號碼完成1圈｜長按號碼可倒退1圈';
      }, 3500);
    }
  }

  // ----------------------------------------------------
  // 抽屜控制 (完全無彈窗，側欄抽屜式滑出)
  // ----------------------------------------------------
  function openRankDrawer() {
    closeDrawers();
    const { sorted } = calculateRankings();
    renderRankDrawer(sorted);
    elements.rankDrawer.classList.add('open');
    elements.drawerBackdrop.classList.add('active');
  }

  function openSettingsDrawer() {
    closeDrawers();
    elements.settingsDrawer.classList.add('open');
    elements.drawerBackdrop.classList.add('active');
  }

  function closeDrawers() {
    elements.rankDrawer.classList.remove('open');
    elements.settingsDrawer.classList.remove('open');
    elements.drawerBackdrop.classList.remove('active');
  }

  // ----------------------------------------------------
  // 主題切換 (戶外烈日高對比模式)
  // ----------------------------------------------------
  function toggleOutdoorTheme() {
    state.outdoorTheme = !state.outdoorTheme;
    applyTheme();
    saveState();
  }

  function applyTheme() {
    if (state.outdoorTheme) {
      document.body.classList.remove('theme-dark');
      document.body.classList.add('theme-outdoor');
      elements.themeIcon.textContent = '🌙';
      elements.btnThemeToggle.title = '切換為深色運動模式';
    } else {
      document.body.classList.remove('theme-outdoor');
      document.body.classList.add('theme-dark');
      elements.themeIcon.textContent = '☀️';
      elements.btnThemeToggle.title = '切換為烈日高對比模式';
    }
  }

  // ----------------------------------------------------
  // 監聽與事件綁定
  // ----------------------------------------------------
  function bindGlobalEvents() {
    // 復原
    elements.btnUndo.addEventListener('click', undoLastAction);

    // 抽屜開啟與關閉
    elements.btnRankToggle.addEventListener('click', openRankDrawer);
    elements.btnCloseRank.addEventListener('click', closeDrawers);
    elements.btnSettingsToggle.addEventListener('click', openSettingsDrawer);
    elements.btnCloseSettings.addEventListener('click', closeDrawers);
    elements.drawerBackdrop.addEventListener('click', closeDrawers);

    // 主題模式切換
    elements.btnThemeToggle.addEventListener('click', toggleOutdoorTheme);

    // 總圈數調節
    elements.btnLapMinus.addEventListener('click', () => {
      if (state.totalLaps > 1) {
        state.totalLaps--;
        saveState();
        render();
      }
    });

    elements.btnLapPlus.addEventListener('click', () => {
      if (state.totalLaps < 20) {
        state.totalLaps++;
        saveState();
        render();
      }
    });

    // 參賽人數調節
    elements.btnAthMinus.addEventListener('click', () => {
      if (state.totalAthletes > 1) {
        state.totalAthletes--;
        saveState();
        render();
      }
    });

    elements.btnAthPlus.addEventListener('click', () => {
      if (state.totalAthletes < 30) {
        state.totalAthletes++;
        saveState();
        render();
      }
    });

    // 重設比賽按鈕
    elements.btnResetMatch.addEventListener('click', handleResetMatch);

    // 防止 iOS Safari 橡皮筋下拉捲動造成跳動
    document.addEventListener('touchmove', (e) => {
      // 僅允許排名清單與設定清單滾動，主面板嚴格禁止捲動
      if (!e.target.closest('.drawer-content')) {
        e.preventDefault();
      }
    }, { passive: false });
  }

  // ----------------------------------------------------
  // 啟動入口
  // ----------------------------------------------------
  loadState();
  applyTheme();
  bindGlobalEvents();
  render();

})();
