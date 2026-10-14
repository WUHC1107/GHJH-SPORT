/**
 * GHJH SPORT - 徑賽圈數與名次計數系統
 * 專為手機端設計，深色模式，免伺服器，無彈窗，防誤觸
 */

(() => {
  'use strict';

  // 系統常數
  const TOTAL_STUDENTS = 30;
  const LONG_PRESS_MS = 450; // 長按判定時間 (毫秒)
  const RESET_TIMEOUT_MS = 3000; // 重設確認倒數 (毫秒)
  const STORAGE_KEY = 'GHJH_SPORT_RACE_STATE_V1';

  // DOM 元素引用
  const gridContainer = document.getElementById('gridContainer');
  const totalLapsSelect = document.getElementById('totalLapsSelect');
  const undoBtn = document.getElementById('undoBtn');
  const resetBtn = document.getElementById('resetBtn');
  const resetBtnText = document.getElementById('resetBtnText');
  const viewToggleBtn = document.getElementById('viewToggleBtn');
  const viewToggleText = document.getElementById('viewToggleText');
  const leaderboardPanel = document.getElementById('leaderboardPanel');
  const closeLeaderboardBtn = document.getElementById('closeLeaderboardBtn');
  const leaderboardList = document.getElementById('leaderboardList');
  const panelSummary = document.getElementById('panelSummary');

  // 跑馬燈元素
  const finalLapAlert = document.getElementById('finalLapAlert');
  const finalLapList = document.getElementById('finalLapList');
  const raceLeaderInfo = document.getElementById('raceLeaderInfo');
  const raceLeaderList = document.getElementById('raceLeaderList');
  const lastActionInfo = document.getElementById('lastActionInfo');

  // 狀態變數
  let totalLaps = parseInt(totalLapsSelect.value, 10) || 8;
  let students = []; // 30位學生的資料
  let historyStack = []; // 復原操作堆疊
  let resetConfirmTimer = null; // 重設二階段確認計時器
  let isResetConfirming = false;

  /**
   * 初始化學生資料
   */
  function initStudents() {
    students = [];
    for (let i = 1; i <= TOTAL_STUDENTS; i++) {
      students.push({
        bib: i,
        bibStr: i < 10 ? `0${i}` : `${i}`,
        laps: 0,
        lastUpdated: 0, // 完成最近一圈的時間戳記
        finishTime: 0,  // 完賽時間戳記
        isFinished: false,
        rank: null
      });
    }
  }

  /**
   * 載入儲存的狀態 (若有)
   */
  function loadSavedState() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const data = JSON.parse(saved);
        if (data && Array.isArray(data.students) && data.students.length === TOTAL_STUDENTS) {
          students = data.students;
          totalLaps = data.totalLaps || 8;
          totalLapsSelect.value = totalLaps;
          historyStack = Array.isArray(data.historyStack) ? data.historyStack : [];
          return true;
        }
      }
    } catch (e) {
      console.warn('載入暫存紀錄失敗', e);
    }
    return false;
  }

  /**
   * 儲存當前狀態到 localStorage
   */
  function persistState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        students,
        totalLaps,
        historyStack
      }));
    } catch (e) {
      // 靜默處理
    }
  }

  /**
   * 計算並更新全體名次
   */
  function calculateRankings() {
    // 排序邏輯：
    // 1. 完賽者優先，依完賽時間戳記 (finishTime) 升冪排序
    // 2. 進行中者，依完成圈數 (laps) 降冪排序
    // 3. 圈數相同者，依達到該圈數的時間戳記 (lastUpdated) 升冪排序 (先到者領先)
    // 4. 0 圈者列於最後，依號碼牌升冪排序
    const sorted = [...students].sort((a, b) => {
      // 若兩者都完賽
      if (a.isFinished && b.isFinished) {
        return a.finishTime - b.finishTime;
      }
      // 其中一人完賽
      if (a.isFinished) return -1;
      if (b.isFinished) return 1;

      // 圈數不同
      if (b.laps !== a.laps) {
        return b.laps - a.laps;
      }

      // 圈數相同且 > 0：比較誰先達到此圈
      if (a.laps > 0) {
        return a.lastUpdated - b.lastUpdated;
      }

      // 0 圈：依號碼排序
      return a.bib - b.bib;
    });

    // 分配排名
    let currentRank = 1;
    sorted.forEach((student, index) => {
      if (student.laps > 0) {
        student.rank = currentRank++;
      } else {
        student.rank = null; // 尚未開始計圈
      }
    });

    // 建立快取映射
    const rankMap = new Map();
    students.forEach(s => rankMap.set(s.bib, s.rank));
    return rankMap;
  }

  /**
   * 增加圈數 (短按)
   * @param {number} bib - 學生號碼 (1-30)
   */
  function incrementLap(bib) {
    const student = students.find(s => s.bib === bib);
    if (!student) return;

    if (student.laps >= totalLaps) {
      // 已完賽，不重複增加
      flashButton(bib);
      return;
    }

    const now = Date.now();
    const prevLaps = student.laps;
    const prevLastUpdated = student.lastUpdated;
    const prevFinishTime = student.finishTime;
    const prevFinished = student.isFinished;

    student.laps += 1;
    student.lastUpdated = now;

    if (student.laps >= totalLaps) {
      student.isFinished = true;
      student.finishTime = now;
    }

    // 推入復原堆疊
    historyStack.push({
      action: 'increment',
      bib: bib,
      prevLaps,
      prevLastUpdated,
      prevFinishTime,
      prevFinished,
      newLap: student.laps,
      timeText: `${student.bibStr}號 +1圈(${student.laps}/${totalLaps})`
    });

    onRaceStateChanged(bib, `已記錄 ${student.bibStr}號 第${student.laps}圈`);
  }

  /**
   * 減少圈數 (長按)
   * @param {number} bib - 學生號碼 (1-30)
   */
  function decrementLap(bib) {
    const student = students.find(s => s.bib === bib);
    if (!student || student.laps <= 0) {
      flashButton(bib);
      return;
    }

    const prevLaps = student.laps;
    const prevLastUpdated = student.lastUpdated;
    const prevFinishTime = student.finishTime;
    const prevFinished = student.isFinished;

    student.laps -= 1;
    student.isFinished = false;
    student.finishTime = 0;
    student.lastUpdated = Date.now();

    // 推入復原堆疊
    historyStack.push({
      action: 'decrement',
      bib: bib,
      prevLaps,
      prevLastUpdated,
      prevFinishTime,
      prevFinished,
      newLap: student.laps,
      timeText: `${student.bibStr}號 -1圈(${student.laps}/${totalLaps})`
    });

    onRaceStateChanged(bib, `修正扣除 ${student.bibStr}號 1圈 (現為${student.laps}圈)`);
  }

  /**
   * 執行復原
   */
  function undoLastAction() {
    if (historyStack.length === 0) return;

    const lastAction = historyStack.pop();
    const student = students.find(s => s.bib === lastAction.bib);
    if (!student) return;

    student.laps = lastAction.prevLaps;
    student.lastUpdated = lastAction.prevLastUpdated;
    student.finishTime = lastAction.prevFinishTime;
    student.isFinished = lastAction.prevFinished;

    onRaceStateChanged(student.bib, `已復原 ${student.bibStr}號 上次操作`);
  }

  /**
   * 比賽狀態改變後的統一處理
   * @param {number} updatedBib - 剛更新的號碼
   * @param {string} logText - 操作提示字串
   */
  function onRaceStateChanged(updatedBib, logText) {
    calculateRankings();
    renderAllButtons();
    updateStatusBanners(logText);
    updateUndoButtonState();
    persistState();

    if (updatedBib) {
      flashButton(updatedBib);
    }
  }

  /**
   * 按鈕視覺微動畫
   */
  function flashButton(bib) {
    const btn = document.getElementById(`bib-btn-${bib}`);
    if (btn) {
      btn.classList.remove('just-updated');
      void btn.offsetWidth; // 強制重繪
      btn.classList.add('just-updated');
    }
  }

  /**
   * 更新復原按鈕狀態
   */
  function updateUndoButtonState() {
    if (historyStack.length > 0) {
      const topAction = historyStack[historyStack.length - 1];
      const bibStr = topAction.bib < 10 ? `0${topAction.bib}` : `${topAction.bib}`;
      undoBtn.disabled = false;
      undoBtn.querySelector('.btn-text').textContent = `復原(${bibStr}號)`;
    } else {
      undoBtn.disabled = true;
      undoBtn.querySelector('.btn-text').textContent = '復原';
    }
  }

  /**
   * 更新頂部狀態跑馬燈與最後一圈醒目提醒
   */
  function updateStatusBanners(logText) {
    if (logText) {
      lastActionInfo.querySelector('.action-desc').textContent = logText;
    }

    // 1. 檢查是否有學生進入最後一圈
    // 當 totalLaps > 1 時，完成了 totalLaps - 1 圈即代表正在跑最後一圈
    const finalLapRunners = students
      .filter(s => !s.isFinished && totalLaps > 1 && s.laps === totalLaps - 1)
      .map(s => `${s.bibStr}號`);

    if (finalLapRunners.length > 0) {
      finalLapAlert.style.display = 'flex';
      finalLapList.textContent = finalLapRunners.join('、');
      raceLeaderInfo.style.display = 'none'; // 讓出空間給最後一圈警示
    } else {
      finalLapAlert.style.display = 'none';
      raceLeaderInfo.style.display = 'flex';

      // 顯示目前領先者 (前2名)
      const leaders = students
        .filter(s => s.laps > 0)
        .sort((a, b) => (a.rank || 99) - (b.rank || 99))
        .slice(0, 2)
        .map(s => `${s.bibStr}號(${s.isFinished ? '完賽' : s.laps + '圈'})`);

      if (leaders.length > 0) {
        raceLeaderList.textContent = leaders.join(' ｜ ');
      } else {
        raceLeaderList.textContent = '比賽進行中';
      }
    }
  }

  /**
   * 建立並渲染 30 個學生號碼按鈕
   */
  function buildButtonsGrid() {
    gridContainer.innerHTML = '';

    for (let i = 1; i <= TOTAL_STUDENTS; i++) {
      const btn = document.createElement('button');
      btn.className = 'bib-btn';
      btn.id = `bib-btn-${i}`;
      btn.setAttribute('data-bib', i);

      // 長按時的視覺填滿遮罩
      const progressOverlay = document.createElement('div');
      progressOverlay.className = 'press-progress';
      btn.appendChild(progressOverlay);

      // 號碼衣數字
      const numSpan = document.createElement('span');
      numSpan.className = 'bib-number';
      numSpan.textContent = i < 10 ? `0${i}` : `${i}`;
      btn.appendChild(numSpan);

      // 圈數文字
      const lapsSpan = document.createElement('span');
      lapsSpan.className = 'bib-laps';
      lapsSpan.id = `bib-laps-${i}`;
      lapsSpan.textContent = `0/${totalLaps}圈`;
      btn.appendChild(lapsSpan);

      // 狀態與名次徽章
      const statusSpan = document.createElement('span');
      statusSpan.className = 'bib-status';
      statusSpan.id = `bib-status-${i}`;
      statusSpan.textContent = '準備';
      btn.appendChild(statusSpan);

      // 綁定長按與短按觸發器 (支援行動裝置觸控與滑鼠)
      attachPressHandlers(btn, i);

      gridContainer.appendChild(btn);
    }
  }

  /**
   * 為按鈕綁定短按/長按事件
   * 短按：+1圈
   * 長按：-1圈 (帶進度條提示)
   */
  function attachPressHandlers(element, bib) {
    let pressTimer = null;
    let isLongPressTriggered = false;
    let startX = 0;
    let startY = 0;

    // 防止右鍵選單彈窗干擾長按
    element.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      return false;
    });

    const startPress = (e) => {
      // 若是滑鼠事件，只接受左鍵
      if (e.pointerType === 'mouse' && e.button !== 0) return;

      isLongPressTriggered = false;
      startX = e.clientX;
      startY = e.clientY;

      element.classList.add('pressing');

      // 設定長按計時器
      pressTimer = setTimeout(() => {
        isLongPressTriggered = true;
        element.classList.remove('pressing');
        decrementLap(bib); // 長按觸發：減少圈數
      }, LONG_PRESS_MS);
    };

    const cancelPress = () => {
      if (pressTimer) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
      element.classList.remove('pressing');
    };

    const endPress = (e) => {
      if (pressTimer) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
      element.classList.remove('pressing');

      // 若未觸發長按，則視為短按
      if (!isLongPressTriggered) {
        incrementLap(bib); // 短按觸發：增加圈數
      }
      isLongPressTriggered = false;
    };

    // 指標移動超過閾值則取消長按 (防滑動誤觸)
    const movePress = (e) => {
      const deltaX = Math.abs(e.clientX - startX);
      const deltaY = Math.abs(e.clientY - startY);
      if (deltaX > 12 || deltaY > 12) {
        cancelPress();
      }
    };

    element.addEventListener('pointerdown', startPress);
    element.addEventListener('pointerup', endPress);
    element.addEventListener('pointercancel', cancelPress);
    element.addEventListener('pointerleave', cancelPress);
    element.addEventListener('pointermove', movePress);
  }

  /**
   * 刷新所有按鈕的顯示狀態 (外觀、圈數、名次、警告)
   */
  function renderAllButtons() {
    students.forEach(student => {
      const btn = document.getElementById(`bib-btn-${student.bib}`);
      if (!btn) return;

      const lapsSpan = document.getElementById(`bib-laps-${student.bib}`);
      const statusSpan = document.getElementById(`bib-status-${student.bib}`);

      // 清除舊狀態 class
      btn.classList.remove('running', 'final-lap', 'finished', 'rank-1', 'rank-2', 'rank-3');

      // 更新圈數文字
      lapsSpan.textContent = `${student.laps}/${totalLaps}圈`;

      // 判定狀態
      const isFinalLap = !student.isFinished && totalLaps > 1 && student.laps === totalLaps - 1;

      if (student.isFinished) {
        // 完賽
        btn.classList.add('finished');
        statusSpan.textContent = `完賽#${student.rank || 1}`;
      } else if (isFinalLap) {
        // 剩最後一圈 (最高警示等級)
        btn.classList.add('final-lap');
        statusSpan.textContent = student.rank ? `剩1圈#${student.rank}` : `剩1圈`;
      } else if (student.laps > 0) {
        // 進行中
        btn.classList.add('running');
        statusSpan.textContent = student.rank ? `第${student.rank}名` : `進行中`;

        // 前三名特殊標記
        if (student.rank === 1) btn.classList.add('rank-1');
        else if (student.rank === 2) btn.classList.add('rank-2');
        else if (student.rank === 3) btn.classList.add('rank-3');
      } else {
        // 0 圈未開始
        statusSpan.textContent = '準備';
      }
    });

    // 如果名次榜面板處於開啟狀態，同步更新清單
    if (leaderboardPanel.classList.contains('active')) {
      renderLeaderboardPanel();
    }
  }

  /**
   * 渲染名次榜面板清單 (供老師謄寫全體排序)
   */
  function renderLeaderboardPanel() {
    const finishedCount = students.filter(s => s.isFinished).length;
    panelSummary.textContent = `完賽: ${finishedCount} / ${TOTAL_STUDENTS} 人`;

    leaderboardList.innerHTML = '';

    // 排序清單：已完賽 -> 圈數多到少 -> 先達標者在前 -> 0圈
    const sorted = [...students].sort((a, b) => {
      if (a.isFinished && b.isFinished) return a.finishTime - b.finishTime;
      if (a.isFinished) return -1;
      if (b.isFinished) return 1;
      if (b.laps !== a.laps) return b.laps - a.laps;
      if (a.laps > 0) return a.lastUpdated - b.lastUpdated;
      return a.bib - b.bib;
    });

    sorted.forEach((student, index) => {
      const card = document.createElement('div');
      card.className = 'rank-card';
      if (index === 0 && student.laps > 0) card.classList.add('top-1');
      if (index === 1 && student.laps > 0) card.classList.add('top-2');
      if (index === 2 && student.laps > 0) card.classList.add('top-3');

      // 左側：名次與號碼
      const leftDiv = document.createElement('div');
      leftDiv.className = 'rank-card-left';

      const orderSpan = document.createElement('span');
      orderSpan.className = 'rank-order';
      orderSpan.textContent = student.rank ? `#${student.rank}` : `-`;
      leftDiv.appendChild(orderSpan);

      const nameSpan = document.createElement('span');
      nameSpan.className = 'rank-bib-name';
      nameSpan.textContent = `${student.bibStr} 號`;
      leftDiv.appendChild(nameSpan);

      card.appendChild(leftDiv);

      // 右側：圈數與狀態
      const rightDiv = document.createElement('div');
      rightDiv.className = 'rank-card-right';

      const lapBadge = document.createElement('span');
      lapBadge.className = 'rank-lap-badge';
      lapBadge.textContent = `${student.laps} / ${totalLaps} 圈`;
      rightDiv.appendChild(lapBadge);

      const statusBadge = document.createElement('span');
      statusBadge.className = 'rank-status-badge';
      if (student.isFinished) {
        statusBadge.classList.add('finished');
        statusBadge.textContent = '已完賽';
      } else if (totalLaps > 1 && student.laps === totalLaps - 1) {
        statusBadge.classList.add('final-lap');
        statusBadge.textContent = '剩最後1圈';
      } else if (student.laps > 0) {
        statusBadge.textContent = '競賽中';
      } else {
        statusBadge.textContent = '尚未出發';
      }
      rightDiv.appendChild(statusBadge);

      card.appendChild(rightDiv);
      leaderboardList.appendChild(card);
    });
  }

  /**
   * 綁定控制項事件
   */
  function bindControlEvents() {
    // 總圈數切換
    totalLapsSelect.addEventListener('change', (e) => {
      const newTotal = parseInt(e.target.value, 10);
      if (newTotal >= 1 && newTotal <= 8) {
        totalLaps = newTotal;
        // 重新檢驗每位學生完賽狀態
        students.forEach(s => {
          if (s.laps >= totalLaps) {
            s.isFinished = true;
            if (!s.finishTime) s.finishTime = s.lastUpdated || Date.now();
          } else {
            s.isFinished = false;
            s.finishTime = 0;
          }
        });
        onRaceStateChanged(null, `已將總圈數設定為 ${totalLaps} 圈`);
      }
    });

    // 復原按鈕
    undoBtn.addEventListener('click', () => {
      undoLastAction();
    });

    // 重設按鈕 (內聯二階段防呆確認，無彈窗)
    resetBtn.addEventListener('click', () => {
      if (!isResetConfirming) {
        // 第一階段：顯示確認字樣
        isResetConfirming = true;
        resetBtn.classList.add('confirming');
        resetBtnText.textContent = '確定重設?';

        // 3 秒後自動還原
        if (resetConfirmTimer) clearTimeout(resetConfirmTimer);
        resetConfirmTimer = setTimeout(() => {
          isResetConfirming = false;
          resetBtn.classList.remove('confirming');
          resetBtnText.textContent = '重設';
        }, RESET_TIMEOUT_MS);
      } else {
        // 第二階段：執行真正重設
        if (resetConfirmTimer) clearTimeout(resetConfirmTimer);
        isResetConfirming = false;
        resetBtn.classList.remove('confirming');
        resetBtnText.textContent = '重設';

        initStudents();
        historyStack = [];
        try {
          localStorage.removeItem(STORAGE_KEY);
        } catch (e) {}

        onRaceStateChanged(null, '所有圈數與名次已歸零重設');
      }
    });

    // 名次榜開關
    viewToggleBtn.addEventListener('click', () => {
      const isOpen = leaderboardPanel.classList.toggle('active');
      viewToggleText.textContent = isOpen ? '網格' : '名次';
      if (isOpen) {
        renderLeaderboardPanel();
      }
    });

    closeLeaderboardBtn.addEventListener('click', () => {
      leaderboardPanel.classList.remove('active');
      viewToggleText.textContent = '名次';
    });
  }

  /**
   * 初始化系統啟動
   */
  function startApp() {
    initStudents();
    const hasSaved = loadSavedState();
    buildButtonsGrid();
    bindControlEvents();
    calculateRankings();
    renderAllButtons();
    updateUndoButtonState();
    updateStatusBanners(hasSaved ? '已恢復上次競賽紀錄' : null);
  }

  // 啟動應用
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startApp);
  } else {
    startApp();
  }
})();
