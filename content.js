(() => {
  'use strict';

  if (location.hostname !== 'inputread.site') return;

  const SCRIPT_VERSION = '1.11.1';
  const BUTTON_SELECTOR = 'button, [role="button"]';
  const LABEL_RE = /(朗读|读这句|读本段|朗读句子|播放句子|read aloud|speak|listen)/i;
  const ICON_RE = /(volume|speaker|audio|sound)/i;
  const GAMEPAD_BUTTONS = [0, 1, 2, 3, 5, 12, 13, 14, 15]; // A, B, X, Y, RB, then D-pad.
  const COMMAND_DEBOUNCE_MS = 260;
  const LEFT_CLICK_DEBOUNCE_MS = 80;
  const PRESS_SETTLE_MS = 90;
  const DOUBLE_CLICK_WINDOW_MS = 500;

  let currentButton = null;
  let currentUnitIndex = -1;
  let currentUnitKey = '';
  let lastMessage = '等待手柄操作';
  let lastMessageAt = 0;
  let wasPressed = new Map();
  let lastReleasedAt = new Map();
  let lastCommandAt = new Map();
  let previousAxisDirections = new Set();
  let lastRouteWasReader = null;
  let lastReaderRouteKey = '';
  let pausedAudio = null;
  let lastKeyboardNavigationKey = '';
  let lastKeyboardNavigationAt = 0;
  let lastUserScrollAt = 0;
  let gamepadStatus = '等待手柄连接';
  let rightStickWasActive = false;
  let virtualCursor = null;
  let cursorX = null;
  let cursorY = null;
  let cursorHideTimer = null;
  let lastFrameTimestamp = 0;
  let lastVirtualBlankClick = null;

  function isReaderRoute() {
    return location.pathname.startsWith('/read/');
  }

  function visible(element) {
    if (!(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' &&
      Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
  }

  function labelOf(element) {
    return [...new Set([
      element.getAttribute('aria-label'),
      element.getAttribute('title'),
      element.getAttribute('data-tooltip'),
      element.innerText,
      element.textContent
    ].filter(Boolean))].join(' ').trim();
  }

  function iconOf(element) {
    return [...element.querySelectorAll('svg')].map(svg => [
      svg.getAttribute('class'),
      svg.getAttribute('data-lucide'),
      svg.getAttribute('aria-label'),
      svg.querySelector('title')?.textContent
    ].filter(Boolean).join(' ')).join(' ');
  }

  function inDialog(element) {
    return Boolean(element.closest('[role="dialog"], dialog, [data-radix-dialog-content]'));
  }

  function isReaderContent(element) {
    return Boolean(element.closest('article, main, [role="article"]'));
  }

  // Controls that are NOT reading units: the chapter player's own bar, the
  // header "Read aloud" button, and the paragraph-help panel's read buttons
  // (data-read-aloud). The small speaker icon after each paragraph
  // (data-aloud-from) IS the site's paragraph reading unit and is kept.
  const ALOUD_UI_SELECTOR = [
    '[data-aloud-bar]',
    '[data-aloud-options]',
    '[data-aloud-options-card]',
    '[data-aloud-toggle]',
    '[data-aloud-prev]',
    '[data-aloud-next]',
    '[data-aloud-stop]',
    '[data-aloud-follow]',
    '[data-aloud-close]',
    '[data-aloud-play]',
    '[data-aloud-header]',
    '[data-read-aloud]'
  ].join(', ');

  function isAloudUi(element) {
    return Boolean(element.closest(ALOUD_UI_SELECTOR));
  }

  function speakerButtons() {
    const usable = button => visible(button) && !inDialog(button) && isReaderContent(button);

    // The site's real reading unit: the small speaker icon at the end of each
    // paragraph while the chapter player is available. It follows the player's
    // own paragraph order, so navigation and "repeat" match what is read.
    const paragraphs = [...document.querySelectorAll('[data-aloud-from]')].filter(usable);
    if (paragraphs.length) return paragraphs;

    // Fallback for a layout that exposes sentence-level speaker buttons in the
    // article itself (the word card's Listen buttons are outside it).
    const sentences = [...document.querySelectorAll('[data-speak]')].filter(usable);
    if (sentences.length) {
      return sentences.filter(button => !button.querySelector(BUTTON_SELECTOR));
    }

    // Older layouts: speaker-looking buttons inside the article only.
    const candidates = [...document.querySelectorAll(BUTTON_SELECTOR)].filter(button => {
      if (!visible(button) || inDialog(button) || isAloudUi(button)) return false;
      if (!isReaderContent(button)) return false;

      const label = labelOf(button);
      if (LABEL_RE.test(label) && !/(暂停|停止|本章|章节|整章|全文|关闭)/i.test(label)) return true;
      return ICON_RE.test(iconOf(button));
    });
    // Avoid counting a role=button wrapper and its nested native button twice.
    return candidates.filter(button => !button.querySelector(BUTTON_SELECTOR));
  }

  function unitLabel(button) {
    return (button.getAttribute('aria-label') || button.innerText || '').trim();
  }

  function unitKey(button) {
    const paragraph = button.getAttribute('data-aloud-from');
    if (paragraph !== null) return `para:${paragraph}`;
    return `label:${unitLabel(button)}`;
  }

  function nearestVisibleIndex(buttons) {
    const viewportMiddle = window.innerHeight * 0.44;
    let bestIndex = -1;
    let bestDistance = Infinity;
    buttons.forEach((button, index) => {
      const rect = button.getBoundingClientRect();
      if (rect.bottom < 0 || rect.top > window.innerHeight) return;
      const distance = Math.abs((rect.top + rect.bottom) / 2 - viewportMiddle);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });
    return bestIndex;
  }

  function activeIndex(buttons) {
    // 1. The sentence that is actually being spoken right now.
    const speaking = buttons.find(button => {
      const status = button.getAttribute('data-speak-status');
      return status === 'playing' || status === 'loading';
    });
    if (speaking) return buttons.indexOf(speaking);

    // 2. While the chapter player is reading, follow its highlighted paragraph
    // instead of the viewport, because the player scrolls the page itself.
    const aloudParagraph = document.querySelector('[data-aloud-current]');
    if (aloudParagraph) {
      const unit = buttons.find(button => aloudParagraph.contains(button));
      if (unit) return buttons.indexOf(unit);
    }

    // After the reader scrolls by hand, navigation should follow what is on
    // screen again instead of the item used before scrolling.
    const userScrolled = Date.now() - lastUserScrollAt < 2500;

    // 3. The unit that was last used from the gamepad (or clicked).
    if (currentButton && buttons.includes(currentButton)) {
      const rect = currentButton.getBoundingClientRect();
      const onScreen = rect.bottom >= 0 && rect.top <= window.innerHeight;
      if (onScreen || !userScrolled) return buttons.indexOf(currentButton);
    }

    // 4. Same slot after React replaced the button node: verify by label.
    if (!userScrolled && currentUnitIndex >= 0 && currentUnitIndex < buttons.length) {
      const candidate = buttons[currentUnitIndex];
      if (!currentUnitKey || unitKey(candidate) === currentUnitKey) {
        currentButton = candidate;
        return currentUnitIndex;
      }
    }

    // 5. Last resort: whatever is around the middle of the viewport.
    return nearestVisibleIndex(buttons);
  }

  function readingTextLength(block) {
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let length = 0;
    let node;
    while ((node = walker.nextNode())) {
      if (node.parentElement?.closest(BUTTON_SELECTOR)) continue;
      length += (node.textContent || '').trim().length;
    }
    return length;
  }

  function readingBlockFor(button, buttons) {
    let node = button.parentElement;
    while (node && node !== document.body && node !== document.documentElement) {
      const containedButtons = buttons.filter(candidate => node.contains(candidate));
      if (containedButtons.length > 1) return null;
      if (containedButtons.length === 1 && readingTextLength(node) > 0) return node;
      if (node.matches('article, main, [role="article"]')) break;
      node = node.parentElement;
    }
    return null;
  }

  function findBlankParagraphAt(x, y) {
    const target = document.elementFromPoint(x, y);
    if (!target || target === virtualCursor ||
        target.closest('button, a, input, select, textarea, [role="button"], [role="link"], [contenteditable="true"]')) {
      return null;
    }

    const buttons = speakerButtons();
    if (!buttons.length) return null;
    const entries = buttons.map((button, index) => ({
      button,
      index,
      block: readingBlockFor(button, buttons)
    })).filter(entry => entry.block && visible(entry.block));
    if (!entries.length) return null;

    let entry = entries
      .filter(candidate => candidate.block.contains(target))
      .sort((a, b) => {
        const rectA = a.block.getBoundingClientRect();
        const rectB = b.block.getBoundingClientRect();
        return rectA.width * rectA.height - rectB.width * rectB.height;
      })[0];

    if (!entry) {
      let bestScore = Infinity;
      for (const candidate of entries) {
        const rect = candidate.block.getBoundingClientRect();
        const dx = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0;
        const dy = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
        if (dx > 96 || dy > 64) continue;
        const score = dy * 2 + dx + rect.width * rect.height * 0.000001;
        if (score < bestScore) {
          bestScore = score;
          entry = candidate;
        }
      }
    }
    if (!entry) return null;

    const walker = document.createTreeWalker(entry.block, NodeFilter.SHOW_TEXT);
    let textNode;
    while ((textNode = walker.nextNode())) {
      if (textNode.parentElement?.closest(BUTTON_SELECTOR)) continue;
      const range = document.createRange();
      range.selectNodeContents(textNode);
      for (const rect of range.getClientRects()) {
        if (rect.width > 0 && rect.height > 0 &&
            x >= rect.left - 1 && x <= rect.right + 1 &&
            y >= rect.top - 1 && y <= rect.bottom + 1) {
          return null; // A word or sentence is under the pointer, not its blank margin.
        }
      }
    }
    return entry;
  }

  function startParagraphAt(entry) {
    if (!entry?.button) return false;
    playUnit(entry.button, '空白处双击：朗读对应段落');
    return true;
  }

  function announce(message) {
    lastMessage = message;
    lastMessageAt = Date.now();
  }

  function playUnit(target, message, index, total) {
    if (!target || !target.isConnected) return;
    const buttons = speakerButtons();
    const position = Number.isInteger(index) && Number.isInteger(total)
      ? ` · ${index + 1}/${total}`
      : '';
    currentButton = target;
    const freshIndex = buttons.indexOf(target);
    currentUnitIndex = freshIndex >= 0 ? freshIndex : Number.isInteger(index) ? index : -1;
    currentUnitKey = unitKey(target);
    pausedAudio = null;
    target.click();
    announce(`${message}${position}`);
  }

  function move(delta) {
    const buttons = speakerButtons();
    if (!buttons.length) {
      announce('手柄已读到，但没找到正文扬声器按钮');
      return;
    }
    const active = activeIndex(buttons);
    if (active < 0) {
      announce('未定位到当前朗读项，已取消跳转');
      return;
    }
    const targetIndex = Math.max(0, Math.min(active + delta, buttons.length - 1));
    playUnit(buttons[targetIndex], delta < 0 ? '上一句' : '下一句', targetIndex, buttons.length);
  }

  function repeatCurrent() {
    const buttons = speakerButtons();
    if (!buttons.length) {
      announce('手柄已读到，但没找到正文扬声器按钮');
      return;
    }
    const index = activeIndex(buttons);
    if (index < 0) {
      announce('当前屏幕没有可重播的朗读单元');
      return;
    }
    playUnit(buttons[index], '重播当前句', index, buttons.length);
  }

  function allVisibleButtons() {
    return [...document.querySelectorAll(BUTTON_SELECTOR)].filter(visible);
  }

  const HEART_RE = /(收藏|生词|喜欢|喜爱|favorite|favourite|heart|add to .*list|♥|♡|💗)/i;
  const CLOSE_RE = /(关闭|close|dismiss|退出解释|hide)/i;

  function hasHeartIcon(button) {
    return HEART_RE.test(`${labelOf(button)} ${iconOf(button)}`);
  }

  function isCloseButton(button) {
    const label = labelOf(button);
    if (CLOSE_RE.test(label)) return true;
    return /(^|[\s_-])(x|xmark|close|circle-x|square-x)(?=$|[\s_-])/i.test(iconOf(button));
  }

  function popupForHeart(heart) {
    let node = heart;
    for (let depth = 0; node && depth < 10 && node !== document.documentElement; depth += 1) {
      const descendants = [...node.querySelectorAll(BUTTON_SELECTOR)].filter(visible);
      const buttons = node.matches?.(BUTTON_SELECTOR) ? [node, ...descendants] : descendants;
      const hasHeart = buttons.some(button => button === heart || hasHeartIcon(button));
      const hasClose = buttons.some(button => button !== heart && isCloseButton(button));
      const marker = `${node.getAttribute?.('role') || ''} ${node.getAttribute?.('data-state') || ''} ${node.id || ''} ${node.className?.baseVal || node.className || ''}`;
      const semanticPopup = /dialog|popover|tooltip|definition|meaning|explanation|word-detail/i.test(marker);
      const rect = node.getBoundingClientRect();
      const compact = rect.width > 0 && rect.height > 0 &&
        rect.width <= window.innerWidth * 0.98 && rect.height <= window.innerHeight * 0.95;

      if (hasHeart && compact && (hasClose || semanticPopup)) return { root: node, heart };
      node = node.parentElement;
    }
    return null;
  }

  function findWordPopover() {
    for (const button of allVisibleButtons()) {
      if (!hasHeartIcon(button)) continue;
      const popup = popupForHeart(button);
      if (popup) return popup;
    }
    return null;
  }

  function closeWordPopover() {
    const popup = findWordPopover();
    if (!popup) {
      announce('B 键：当前没有打开单词解释框');
      return;
    }

    const buttons = [...popup.root.querySelectorAll(BUTTON_SELECTOR)].filter(visible);
    const close = buttons.find(button => button !== popup.heart && isCloseButton(button));
    if (close) {
      close.click();
      announce('B 键：已关闭单词解释框');
      return;
    }

    // Some popovers expose no close button but do close on Escape.
    popup.root.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape', code: 'Escape', bubbles: true, cancelable: true
    }));
    popup.root.dispatchEvent(new KeyboardEvent('keyup', {
      key: 'Escape', code: 'Escape', bubbles: true, cancelable: true
    }));
    announce('B 键：已发送关闭解释框命令');
  }

  function favoriteWord() {
    const popup = findWordPopover();
    if (!popup) {
      announce('X 键：当前没有打开单词解释框');
      return;
    }
    popup.heart.click();
    announce('X 键：已点击单词收藏');
  }

  // The word card has a "看图片" link (data-lookup="images"). Reading Ledger
  // rewrites that link from Bing to Google Images, so the tab is opened with
  // whatever href the link currently carries.
  const WORD_IMAGES_LINK = 'a[data-lookup="images"]';

  function visibleImagesLink() {
    return [...document.querySelectorAll(WORD_IMAGES_LINK)].filter(visible)[0] || null;
  }

  // The "more" button is a Radix dropdown trigger: it opens on pointerdown,
  // not on a synthetic click, so send the full pointer/mouse sequence.
  function pressControl(element) {
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const pointer = (type, buttons) => element.dispatchEvent(new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
      buttons
    }));
    pointer('pointerdown', 1);
    element.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true, cancelable: true, clientX: x, clientY: y, buttons: 1
    }));
    pointer('pointerup', 0);
    element.dispatchEvent(new MouseEvent('mouseup', {
      bubbles: true, cancelable: true, clientX: x, clientY: y, buttons: 0
    }));
    element.dispatchEvent(new MouseEvent('click', {
      bubbles: true, cancelable: true, clientX: x, clientY: y
    }));
  }

  function openWordImages() {
    const direct = visibleImagesLink();
    if (direct) {
      launchWordImages(direct);
      return;
    }

    const more = [...document.querySelectorAll('button[data-word-more]')].filter(visible)[0];
    if (!more) {
      announce('RB：当前没有打开单词解释框');
      return;
    }

    pressControl(more);
    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      const link = visibleImagesLink();
      if (link) {
        clearInterval(timer);
        launchWordImages(link);
      } else if (attempts >= 10) {
        clearInterval(timer);
        announce('RB：没找到“看图片”选项');
      }
    }, 80);
  }

  function launchWordImages(link) {
    const url = link.href || '';
    if (!/^https?:\/\//i.test(url)) {
      link.click();
      announce('RB：已点击“看图片”');
      return;
    }
    try {
      chrome.runtime.sendMessage({ type: 'INPUTREAD_OPEN_IMAGES', url }, response => {
        if (chrome.runtime.lastError || !response?.ok) {
          announce('RB：打开图片页失败，请再按一次');
          return;
        }
        announce('RB：图片页已打开 · 右摇杆滚动 · 再按 RB 返回');
      });
    } catch {
      announce('RB：扩展已更新，请刷新阅读页后重试');
    }
  }

  // The site's own read-aloud player exposes one dedicated toggle whose
  // aria-label is either "暂停朗读"/"Pause reading aloud" or
  // "继续朗读"/"Resume reading aloud".
  const ALOUD_TOGGLE_SELECTOR = '[data-aloud-toggle]';
  const ALOUD_PAUSE_LABEL_RE = /^(?:暂停(?:朗读|播放|阅读)?|pause(?: reading aloud| reading| playback)?)$/i;
  const ALOUD_RESUME_LABEL_RE = /^(?:继续(?:朗读|播放|阅读)?|恢复(?:朗读|播放|阅读)?|resume(?: reading aloud| reading)?|continue(?: reading)?)$/i;

  function controlLabels(element) {
    return [...new Set(
      [element.getAttribute('aria-label'), element.getAttribute('title')]
        .filter(Boolean)
        .map(value => value.trim())
        .filter(Boolean)
    )];
  }

  function matchesControlLabel(element, regex) {
    return controlLabels(element).some(value => regex.test(value));
  }

  // Only the player-level pause/resume control may be clicked. Sentence
  // speaker buttons carry aria-label "Listen: <sentence>"; a sentence that
  // merely contains "pause" or "continue" must never be treated as a command.
  function aloudControl() {
    const toggles = [...document.querySelectorAll(ALOUD_TOGGLE_SELECTOR)].filter(visible);
    if (toggles.length) return toggles[0];

    return allVisibleButtons().find(button => {
      if (button.matches('[data-speak]') || isReaderContent(button) || inDialog(button)) return false;
      return matchesControlLabel(button, ALOUD_PAUSE_LABEL_RE) ||
        matchesControlLabel(button, ALOUD_RESUME_LABEL_RE);
    }) || null;
  }

  function aloudControlState(control) {
    if (!control) return 'absent';
    if (matchesControlLabel(control, ALOUD_RESUME_LABEL_RE)) return 'paused';
    if (matchesControlLabel(control, ALOUD_PAUSE_LABEL_RE)) return 'playing';
    return 'unknown';
  }

  function currentAloudState() {
    const control = aloudControl();
    if (!control) {
      return [...document.querySelectorAll('audio')].some(item => !item.paused && !item.ended)
        ? 'playing'
        : 'absent';
    }
    const state = aloudControlState(control);
    return state === 'unknown' ? 'control' : state;
  }

  function verifyAloudControl(control, expected) {
    setTimeout(() => {
      if (!control.isConnected) return;
      const state = aloudControlState(control);
      if (expected === 'paused' && state === 'playing') {
        announce('暂停键：已点击暂停，但网页还在朗读；请再按一次或检查朗读播放器');
      } else if (expected === 'playing' && state === 'paused') {
        announce('暂停键：网页仍显示已暂停；请再按一次');
      }
    }, 400);
  }

  function toggleReadAloud() {
    const control = aloudControl();
    if (control) {
      const paused = aloudControlState(control) === 'paused';
      control.click();
      pausedAudio = null;
      if (paused) {
        announce(`暂停键：继续朗读${recentKeyboardNavigation()}`);
        verifyAloudControl(control, 'playing');
      } else {
        announce(`暂停键：已暂停朗读${recentKeyboardNavigation()}`);
        verifyAloudControl(control, 'paused');
      }
      return;
    }

    const playingAudio = [...document.querySelectorAll('audio')]
      .find(item => !item.paused && !item.ended && item.readyState > 0);
    if (playingAudio) {
      playingAudio.pause();
      pausedAudio = playingAudio;
      announce(`暂停键：已暂停音频${recentKeyboardNavigation()}`);
      return;
    }

    if (pausedAudio?.isConnected && !pausedAudio.ended) {
      const audio = pausedAudio;
      audio.play().then(() => {
        pausedAudio = null;
        announce(`暂停键：继续音频${recentKeyboardNavigation()}`);
      }).catch(() => {
        announce(`暂停键：音频无法恢复，网页没有可用的继续控件${recentKeyboardNavigation()}`);
      });
      return;
    }

    if ('speechSynthesis' in window && (speechSynthesis.speaking || speechSynthesis.pending)) {
      speechSynthesis.pause();
      pausedAudio = null;
      announce(`暂停键：已暂停系统语音朗读${recentKeyboardNavigation()}`);
      return;
    }

    if ('speechSynthesis' in window && speechSynthesis.paused) {
      speechSynthesis.resume();
      pausedAudio = null;
      announce(`暂停键：继续系统语音朗读${recentKeyboardNavigation()}`);
      return;
    }
    pausedAudio = null;
    announce(`暂停键：当前没有正在朗读的内容（朗读播放器未打开）${recentKeyboardNavigation()}`);
  }

  function recentKeyboardNavigation() {
    if (!lastKeyboardNavigationKey || Date.now() - lastKeyboardNavigationAt > 700) return '';
    return `；同时检测到键盘 ${lastKeyboardNavigationKey}（可能是手柄驱动映射）`;
  }

  function dispatch(buttonIndex) {
    switch (buttonIndex) {
      case 0: clickAtVirtualCursor(); break; // A: left click at virtual cursor
      case 1: closeWordPopover(); break; // B: close the word explanation popover
      case 2: favoriteWord(); break; // X: favorite the word in the popover
      case 3: toggleReadAloud(); break;  // Y: pause / resume
      case 5: openWordImages(); break;   // RB: open word images
      case 12: toggleReadAloud(); break; // Up: pause / resume
      case 13: repeatCurrent(); break;   // Down: repeat current item
      case 14: move(-1); break;          // Left: previous item
      case 15: move(1); break;           // Right: next item
    }
  }

  function commandKey(buttonIndex) {
    if (buttonIndex === 0) return 'left-click';
    if (buttonIndex === 1) return 'close-word-popover';
    if (buttonIndex === 2) return 'favorite-word';
    if (buttonIndex === 3 || buttonIndex === 12) return 'read-toggle';
    if (buttonIndex === 5) return 'word-images';
    if (buttonIndex === 13) return 'repeat';
    if (buttonIndex === 14) return 'previous';
    if (buttonIndex === 15) return 'next';
    return String(buttonIndex);
  }

  function ensureVirtualCursor() {
    if (virtualCursor?.isConnected) return;
    virtualCursor = document.createElement('div');
    virtualCursor.id = 'inputread-gamepad-cursor';
    virtualCursor.style.cssText = [
      'position:fixed', 'left:0', 'top:0', 'width:20px', 'height:20px',
      'border:2px solid #fff', 'border-radius:50%', 'background:rgba(30,110,76,.55)',
      'box-shadow:0 0 0 2px rgba(25,65,48,.8),0 2px 8px rgba(0,0,0,.35)',
      'transform:translate(-50%,-50%)', 'pointer-events:none',
      'z-index:2147483647', 'display:none'
    ].join(';');
    document.documentElement.appendChild(virtualCursor);
  }

  function placeVirtualCursor() {
    ensureVirtualCursor();
    virtualCursor.style.left = `${cursorX}px`;
    virtualCursor.style.top = `${cursorY}px`;
    virtualCursor.style.display = 'block';
    if (cursorHideTimer) clearTimeout(cursorHideTimer);
    cursorHideTimer = setTimeout(() => {
      if (virtualCursor) virtualCursor.style.display = 'none';
    }, 1100);
  }

  function pointerEvent(target, type, x, y, buttons = 0) {
    if (typeof PointerEvent === 'function') {
      target.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        buttons
      }));
    }
  }

  function moveVirtualCursor(pad, deltaMs) {
    const xAxis = pad.axes[0] || 0;
    const yAxis = pad.axes[1] || 0;
    const magnitude = Math.hypot(xAxis, yAxis);
    if (magnitude < 0.22) return;

    if (cursorX === null || cursorY === null) {
      cursorX = window.innerWidth / 2;
      cursorY = window.innerHeight / 2;
    }

    const strength = Math.min(1, (magnitude - 0.22) / 0.78);
    const speed = Math.pow(strength, 1.25) * 850 * deltaMs / 1000;
    cursorX = Math.max(2, Math.min(window.innerWidth - 2, cursorX + (xAxis / magnitude) * speed));
    cursorY = Math.max(2, Math.min(window.innerHeight - 2, cursorY + (yAxis / magnitude) * speed));

    const target = document.elementFromPoint(cursorX, cursorY);
    if (target && target !== virtualCursor) {
      pointerEvent(target, 'pointermove', cursorX, cursorY);
      target.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true,
        cancelable: true,
        clientX: cursorX,
        clientY: cursorY,
        buttons: 0
      }));
    }
    placeVirtualCursor();
  }

  function clickAtVirtualCursor() {
    if (cursorX === null || cursorY === null) {
      cursorX = window.innerWidth / 2;
      cursorY = window.innerHeight / 2;
    }
    placeVirtualCursor();

    const target = document.elementFromPoint(cursorX, cursorY);
    if (!target || target === virtualCursor || target === document.documentElement) {
      lastVirtualBlankClick = null;
      announce('A 键：光标下没有可点击内容');
      return;
    }

    const blankParagraph = findBlankParagraphAt(cursorX, cursorY);
    const now = performance.now();
    if (blankParagraph && lastVirtualBlankClick &&
        now - lastVirtualBlankClick.at <= DOUBLE_CLICK_WINDOW_MS &&
        Math.hypot(cursorX - lastVirtualBlankClick.x, cursorY - lastVirtualBlankClick.y) <= 36) {
      lastVirtualBlankClick = null;
      startParagraphAt(blankParagraph);
      return;
    }
    lastVirtualBlankClick = blankParagraph
      ? { x: cursorX, y: cursorY, at: now }
      : null;

    const clickable = target.closest('button, a, [role="button"], input, select, textarea, [tabindex]') || target;
    pointerEvent(clickable, 'pointerdown', cursorX, cursorY, 1);
    clickable.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true, cancelable: true, clientX: cursorX, clientY: cursorY, buttons: 1
    }));
    pointerEvent(clickable, 'pointerup', cursorX, cursorY, 0);
    clickable.dispatchEvent(new MouseEvent('mouseup', {
      bubbles: true, cancelable: true, clientX: cursorX, clientY: cursorY, buttons: 0
    }));
    clickable.click();

    if (speakerButtons().includes(clickable)) currentButton = clickable;
    announce('A 键：左击');
  }

  document.addEventListener('dblclick', event => {
    const entry = findBlankParagraphAt(event.clientX, event.clientY);
    if (!entry) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    lastVirtualBlankClick = null;
    startParagraphAt(entry);
  }, true);

  function pollRightStick(pad, deltaMs) {
    const value = pad.axes[3] || 0; // Standard mapping: right-stick vertical axis.
    const magnitude = Math.abs(value);
    if (magnitude < 0.22) {
      rightStickWasActive = false;
      return;
    }

    const intensity = (magnitude - 0.22) / 0.78;
    const distance = Math.sign(value) * Math.pow(intensity, 1.35) * 1320 * deltaMs / 1000;
    window.scrollBy({ top: distance, behavior: 'auto' });
    lastUserScrollAt = Date.now();
    if (!rightStickWasActive) {
      announce(value > 0 ? '右摇杆：向下滚动页面' : '右摇杆：向上滚动页面');
    }
    rightStickWasActive = true;
  }

  function dpadAxes(pad) {
    // Some non-standard controllers expose the D-pad as axes 4 and 5.
    if (pad.mapping === 'standard' || pad.axes.length < 6) {
      previousAxisDirections = new Set();
      return previousAxisDirections;
    }
    const x = pad.axes[4] || 0;
    const y = pad.axes[5] || 0;
    const directions = new Set();
    if (y < (previousAxisDirections.has(12) ? -0.42 : -0.72)) directions.add(12);
    if (y > (previousAxisDirections.has(13) ? 0.42 : 0.72)) directions.add(13);
    if (x < (previousAxisDirections.has(14) ? -0.42 : -0.72)) directions.add(14);
    if (x > (previousAxisDirections.has(15) ? 0.42 : 0.72)) directions.add(15);
    previousAxisDirections = directions;
    return directions;
  }

  function pollGamepads(deltaMs) {
    if (!isReaderRoute()) return;

    let gamepads;
    try {
      gamepads = [...navigator.getGamepads()].filter(Boolean);
    } catch (error) {
      gamepadStatus = `无法读取手柄：${error.name || 'Gamepad API 错误'}`;
      return;
    }

    if (!gamepads.length) {
      gamepadStatus = '等待手柄连接或按键唤醒';
      wasPressed.clear();
      previousAxisDirections = new Set();
      rightStickWasActive = false;
      lastVirtualBlankClick = null;
      if (virtualCursor) virtualCursor.style.display = 'none';
      return;
    }

    const pad = gamepads[0];
    const name = pad.id ? pad.id.slice(0, 42) : '手柄';
    gamepadStatus = `已连接：${name} · ${pad.mapping || '非标准布局'}`;
    moveVirtualCursor(pad, deltaMs);
    pollRightStick(pad, deltaMs);

    const axisDirections = dpadAxes(pad);
    GAMEPAD_BUTTONS.forEach(index => {
      const button = pad.buttons[index];
      const pressed = Boolean(button?.pressed || (button?.value || 0) > 0.65 || axisDirections.has(index));
      const wasDown = wasPressed.get(index) || false;
      const now = performance.now();
      if (!pressed) {
        if (wasDown) lastReleasedAt.set(index, now);
      } else if (!wasDown) {
        // A single physical press can flicker for one frame on some pads and
        // drivers; require a clean release before accepting the next press.
        const releasedAt = lastReleasedAt.get(index) ?? -Infinity;
        const key = commandKey(index);
        const last = lastCommandAt.get(key) ?? -Infinity;
        const debounceMs = index === 0 ? LEFT_CLICK_DEBOUNCE_MS : COMMAND_DEBOUNCE_MS;
        if (now - releasedAt >= PRESS_SETTLE_MS && now - last >= debounceMs) {
          dispatch(index);
          lastCommandAt.set(key, now);
        }
      }
      wasPressed.set(index, pressed);
    });
  }

  function syncPressedButtons() {
    let pads;
    try {
      pads = [...navigator.getGamepads()].filter(Boolean);
    } catch {
      return;
    }
    const pad = pads[0];
    if (!pad) return;
    GAMEPAD_BUTTONS.forEach(index => {
      const button = pad.buttons[index];
      wasPressed.set(index, Boolean(button?.pressed || (button?.value || 0) > 0.65));
    });
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    // Back from the image tab: a button that is still held (usually RB) must
    // not count as a fresh press and immediately reopen the image page.
    lastFrameTimestamp = 0;
    syncPressedButtons();
  });

  document.addEventListener('click', event => {
    const clicked = event.target instanceof Element ? event.target.closest(BUTTON_SELECTOR) : null;
    if (!clicked) return;
    const buttons = speakerButtons();
    if (buttons.includes(clicked)) {
      currentButton = clicked;
      currentUnitIndex = buttons.indexOf(clicked);
      currentUnitKey = unitKey(clicked);
    }
  }, true);

  window.addEventListener('gamepadconnected', event => {
    const id = event.gamepad.id ? ` · ${event.gamepad.id.slice(0, 28)}` : '';
    gamepadStatus = `已连接${id}`;
  });
  window.addEventListener('gamepaddisconnected', () => {
    gamepadStatus = '手柄已断开';
    rightStickWasActive = false;
  });
  const NAVIGATION_KEYS = new Set([
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    'Home', 'End', 'PageUp', 'PageDown', ' '
  ]);

  function navigationButtonHeld() {
    let pads;
    try {
      pads = [...navigator.getGamepads()].filter(Boolean);
    } catch {
      return false;
    }
    const pad = pads[0];
    if (!pad) return false;
    return [12, 13, 14, 15].some(index => {
      const button = pad.buttons[index];
      return Boolean(button?.pressed || (button?.value || 0) > 0.65);
    });
  }

  window.addEventListener('wheel', () => {
    lastUserScrollAt = Date.now();
  }, { passive: true, capture: true });

  window.addEventListener('touchmove', () => {
    lastUserScrollAt = Date.now();
  }, { passive: true, capture: true });

  window.addEventListener('keydown', event => {
    if (!NAVIGATION_KEYS.has(event.key)) return;
    lastKeyboardNavigationKey = event.key;
    lastKeyboardNavigationAt = Date.now();

    if (!navigationButtonHeld()) {
      lastUserScrollAt = Date.now();
      announce(`检测到键盘 ${event.key} 输入`);
      return;
    }

    // Some gamepad drivers send the D-pad as both a gamepad button and a
    // keyboard key. Block the browser scroll so one press is one action, not
    // "next sentence + scroll a page".
    event.preventDefault();
    event.stopPropagation();
    announce(`已拦截手柄映射的键盘 ${event.key}`);
  }, true);

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== 'INPUTREAD_GET_STATUS') return false;
    sendResponse({
      scriptVersion: SCRIPT_VERSION,
      pageReady: isReaderRoute(),
      aloudState: currentAloudState(),
      gamepadStatus,
      lastAction: lastMessage,
      keyboardInput: lastKeyboardNavigationKey && Date.now() - lastKeyboardNavigationAt < 5000
        ? lastKeyboardNavigationKey
        : ''
    });
    return false;
  });

  function frame(timestamp) {
    const deltaMs = lastFrameTimestamp ? Math.min(timestamp - lastFrameTimestamp, 50) : 16.67;
    lastFrameTimestamp = timestamp;
    const reader = isReaderRoute();
    const readerRouteKey = reader ? `${location.pathname}${location.search}` : '';
    if (reader !== lastRouteWasReader || readerRouteKey !== lastReaderRouteKey) {
      lastRouteWasReader = reader;
      lastReaderRouteKey = readerRouteKey;
      currentButton = null;
      currentUnitIndex = -1;
      currentUnitKey = '';
      pausedAudio = null;
      wasPressed.clear();
      previousAxisDirections = new Set();
      rightStickWasActive = false;
      cursorX = null;
      cursorY = null;
      lastVirtualBlankClick = null;
      if (virtualCursor) virtualCursor.style.display = 'none';
      if (!reader) gamepadStatus = '打开一本书进入阅读页';
      else gamepadStatus = '阅读页已就绪 · 等待手柄操作';
    }
    pollGamepads(deltaMs);
    window.requestAnimationFrame(frame);
  }

  window.requestAnimationFrame(frame);
})();
