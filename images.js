(() => {
  'use strict';

  // Runs on the image-search page opened by the gamepad. It only takes over
  // when the background confirms this exact tab is the one that was opened
  // from the reader, so ordinary Google/Bing tabs are left alone.

  const RB_INDEX = 5;
  const STICK_DEADZONE = 0.22;
  const SCROLL_SPEED = 1320;

  let armed = false;
  let started = false;
  let lastTimestamp = 0;
  let rbWasPressed = false;
  let armAttempts = 0;

  function askArm() {
    if (armed) return;
    try {
      chrome.runtime.sendMessage({ type: 'INPUTREAD_AM_I_IMAGES_TAB' }, response => {
        if (chrome.runtime.lastError) return;
        if (response?.armed) {
          armed = true;
          start();
          return;
        }
        armAttempts += 1;
        if (armAttempts < 3) setTimeout(askArm, 300);
      });
    } catch {
      /* extension context gone */
    }
  }

  function showHint() {
    const hint = document.createElement('div');
    hint.textContent = 'RB 返回阅读页 · 右摇杆滚动';
    hint.style.cssText = [
      'position:fixed', 'left:50%', 'bottom:18px', 'transform:translateX(-50%)',
      'z-index:2147483647', 'padding:7px 14px', 'border-radius:999px',
      'background:rgba(20,32,26,.86)', 'color:#f4f8f2', 'font:600 13px/1.4 system-ui,sans-serif',
      'box-shadow:0 6px 20px rgba(0,0,0,.28)', 'pointer-events:none',
      'transition:opacity .3s ease', 'opacity:1'
    ].join(';');
    document.documentElement.appendChild(hint);
    setTimeout(() => {
      hint.style.opacity = '0';
      setTimeout(() => hint.remove(), 320);
    }, 3200);
  }

  function start() {
    if (started) return;
    started = true;
    showHint();
    window.requestAnimationFrame(frame);
  }

  function goBack() {
    try {
      chrome.runtime.sendMessage({ type: 'INPUTREAD_CLOSE_IMAGES' });
    } catch {
      /* extension context gone */
    }
  }

  function frame(timestamp) {
    window.requestAnimationFrame(frame);
    const deltaMs = lastTimestamp ? Math.min(timestamp - lastTimestamp, 50) : 16.67;
    lastTimestamp = timestamp;
    if (document.visibilityState !== 'visible') return;

    let pad = null;
    try {
      pad = [...navigator.getGamepads()].filter(Boolean)[0] || null;
    } catch {
      return;
    }
    if (!pad) return;

    const axis = pad.axes[3] || 0;
    const magnitude = Math.abs(axis);
    if (magnitude >= STICK_DEADZONE) {
      const intensity = (magnitude - STICK_DEADZONE) / (1 - STICK_DEADZONE);
      const distance = Math.sign(axis) * Math.pow(intensity, 1.35) * SCROLL_SPEED * deltaMs / 1000;
      window.scrollBy({ top: distance, behavior: 'auto' });
    }

    const pressed = Boolean(pad.buttons[RB_INDEX]?.pressed);
    if (pressed && !rbWasPressed) goBack();
    rbWasPressed = pressed;
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') askArm();
  });

  askArm();
})();
