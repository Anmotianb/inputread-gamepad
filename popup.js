const pageStatus = document.getElementById('page-status');
const gamepadStatus = document.getElementById('gamepad-status');
const aloudStatus = document.getElementById('aloud-status');
const statusDot = document.getElementById('status-dot');
const lastAction = document.getElementById('last-action');
const keyboardNote = document.getElementById('keyboard-note');
const versionNote = document.getElementById('version-note');

const extensionVersion = chrome.runtime.getManifest().version;

const ALOUD_LABELS = {
  playing: '朗读播放器：正在朗读',
  paused: '朗读播放器：已暂停（按暂停键继续）',
  absent: '朗读播放器：未打开',
  control: '朗读播放器：控件状态未知'
};

function showUnavailable(message) {
  pageStatus.textContent = message;
  gamepadStatus.textContent = '请刷新 inputread 阅读页后再试';
  aloudStatus.textContent = '—';
  lastAction.textContent = '最近操作：—';
  keyboardNote.hidden = true;
  versionNote.className = 'version-note';
  versionNote.textContent = `扩展 v${extensionVersion}`;
  statusDot.className = 'status-dot error';
}

function showVersion(scriptVersion) {
  versionNote.className = 'version-note';
  if (!scriptVersion) {
    versionNote.classList.add('stale');
    versionNote.textContent = `扩展 v${extensionVersion} · 页面脚本版本未知，请刷新阅读页`;
    return;
  }
  if (scriptVersion !== extensionVersion) {
    versionNote.classList.add('stale');
    versionNote.textContent = `扩展 v${extensionVersion}，页面仍在运行旧脚本 v${scriptVersion}：请刷新阅读页（F5）`;
    return;
  }
  versionNote.textContent = `扩展 v${extensionVersion} · 页面脚本已同步`;
}

function refreshStatus() {
  pageStatus.textContent = '正在检查页面…';
  statusDot.className = 'status-dot';

  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const tab = tabs && tabs[0];
    if (!tab?.id) {
      showUnavailable('找不到当前标签页');
      return;
    }

    chrome.tabs.sendMessage(tab.id, { type: 'INPUTREAD_GET_STATUS' }, response => {
      if (chrome.runtime.lastError || !response) {
        showUnavailable('当前标签不是 inputread，或页面脚本尚未加载');
        return;
      }

      if (response.pageReady) {
        pageStatus.textContent = '阅读页已连接';
        statusDot.className = 'status-dot ready';
      } else {
        pageStatus.textContent = '请先打开一本书';
        statusDot.className = 'status-dot';
      }
      gamepadStatus.textContent = response.gamepadStatus || '等待手柄';
      aloudStatus.textContent = ALOUD_LABELS[response.aloudState] || '朗读播放器：—';
      lastAction.textContent = `最近操作：${response.lastAction || '尚无'}`;
      if (response.keyboardInput) {
        keyboardNote.textContent = `检测到键盘输入：${response.keyboardInput}（可能是手柄驱动映射）`;
        keyboardNote.hidden = false;
      } else {
        keyboardNote.hidden = true;
      }
      showVersion(response.scriptVersion);
    });
  });
}

document.getElementById('refresh').addEventListener('click', refreshStatus);
refreshStatus();
