'use strict';

// Keeps track of the image tab that the gamepad opened from the reader, so the
// image page can (a) enable gamepad control only for that tab and (b) close
// itself and hand focus back to the reader tab.

const IMAGE_TAB_KEY = 'inputreadImageTab';

function senderUrl(sender) {
  return sender?.url || sender?.tab?.url || '';
}

function isInputreadSender(sender) {
  return /^https:\/\/(?:www\.)?inputread\.site\//i.test(senderUrl(sender));
}

async function openImages(message, sender) {
  const url = String(message.url || '');
  if (!/^https?:\/\//i.test(url) || !isInputreadSender(sender)) return { ok: false };

  const openerId = sender.tab?.id;
  const tab = await chrome.tabs.create({
    url,
    active: true,
    ...(openerId ? { openerTabId: openerId } : {})
  });
  await chrome.storage.session.set({ [IMAGE_TAB_KEY]: { tabId: tab.id, openerId } });
  return { ok: true, tabId: tab.id };
}

async function isImagesTab(sender) {
  const tabId = sender.tab?.id;
  if (!tabId) return { armed: false };
  const stored = (await chrome.storage.session.get(IMAGE_TAB_KEY))[IMAGE_TAB_KEY];
  return { armed: stored?.tabId === tabId };
}

async function closeImages(sender) {
  const tabId = sender.tab?.id;
  if (!tabId) return { ok: false };
  const stored = (await chrome.storage.session.get(IMAGE_TAB_KEY))[IMAGE_TAB_KEY];
  if (stored?.tabId === tabId) await chrome.storage.session.remove(IMAGE_TAB_KEY);

  try {
    await chrome.tabs.remove(tabId);
  } catch {
    /* already gone */
  }
  if (stored?.openerId) {
    try {
      await chrome.tabs.update(stored.openerId, { active: true });
    } catch {
      /* reader tab closed meanwhile */
    }
  }
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message?.type) {
    case 'INPUTREAD_OPEN_IMAGES':
      openImages(message, sender).then(
        sendResponse,
        error => sendResponse({ ok: false, error: String(error) })
      );
      return true;
    case 'INPUTREAD_AM_I_IMAGES_TAB':
      isImagesTab(sender).then(
        sendResponse,
        () => sendResponse({ armed: false })
      );
      return true;
    case 'INPUTREAD_CLOSE_IMAGES':
      closeImages(sender).then(
        sendResponse,
        () => sendResponse({ ok: false })
      );
      return true;
    default:
      return false;
  }
});

chrome.tabs.onRemoved.addListener(async tabId => {
  const stored = (await chrome.storage.session.get(IMAGE_TAB_KEY))[IMAGE_TAB_KEY];
  if (stored?.tabId === tabId) await chrome.storage.session.remove(IMAGE_TAB_KEY);
});
