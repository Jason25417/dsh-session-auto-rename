/* dsh-session-auto-rename — Client half.
 *
 * Two additions, both native-looking:
 *
 *  1. `sidebar.workspaces.session.menu.item` gains a「自动重命名」row right under
 *     the shipped「重命名」row. Selecting it asks the Host half (an exact Fetch
 *     route on the shared `/api` channel, which is the only path the Desktop
 *     shell proxies from its custom `dsh-app://app/` page) to name the Session
 *     from its log and apply the title through the shipped rename RPC.
 *
 *  2. Right-clicking a Session row opens that row's own「…」menu, pinned to the
 *     pointer. The shipped row has no context-menu wiring, so this half
 *     synthesizes the same click the caret button raises and then keeps the
 *     just-opened portal menu at the pointer. The menu, its items and its state
 *     stay the shipped ones.
 *
 * Written as a dynamic Client module: React comes through `require('react')`
 * and no JSX transform is available, so elements are built with h().
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-auto-rename',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useSyncExternalStore } = React;

    const NS = 'dsh-session-auto-rename';
    const ROUTE = '/api/dsh-session-auto-rename/suggest';
    const MENU_SLOT = 'sidebar.workspaces.session.menu.item';
    const OVERLAY_SLOT = 'shell.overlay';
    const STYLE_ID = 'dsh-session-auto-rename-style';
    const SHIFT_ATTR = 'data-dsar-shifted';
    const MENU_SELECTOR = 'div[role="menu"][data-menu-material]';
    const DEFAULT_LABEL = '自动重命名';
    const WORKING_TEXT = '正在自动重命名…';
    const ROW_SELECTOR = '[data-row-key]';
    const ROW_PREFIX = 'session:';

    const DICT_ZH = {
      'menu.label': DEFAULT_LABEL,
      'status.working': WORKING_TEXT,
      'status.workingElapsed': '正在自动重命名… {seconds}s',
      'status.done': '已重命名为「{title}」',
      'status.doneWithPrevious': '已重命名为「{title}」（原「{previous}」）',
      'status.failed': '自动重命名失败：{reason}',
    };

    const DICT_EN = {
      'menu.label': 'Auto-rename',
      'status.working': 'Auto-naming this session…',
      'status.workingElapsed': 'Auto-naming this session… {seconds}s',
      'status.done': 'Renamed to "{title}"',
      'status.doneWithPrevious': 'Renamed to "{title}" (was "{previous}")',
      'status.failed': 'Auto-rename failed: {reason}',
    };

    /** Fill `{name}` placeholders without depending on the locale service. */
    function format(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (match, key) => {
        const value = values ? values[key] : undefined;
        return value === undefined || value === null ? match : String(value);
      });
    }

    /* ------------------------------------------------------------------ *
     * one shared status line for the frame-level overlay
     * ------------------------------------------------------------------ */

    const statusStore = (() => {
      let state = { phase: 'idle', tone: 'neutral', text: '', revision: 0 };
      const listeners = new Set();
      let timer = null;

      const publish = (next) => {
        state = next;
        for (const listener of listeners) {
          try {
            listener();
          } catch (_error) {
            /* a broken listener must not keep the status from updating */
          }
        }
      };

      const clearTimer = () => {
        if (timer !== null) {
          window.clearTimeout(timer);
          timer = null;
        }
      };

      return {
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        getSnapshot() {
          return state;
        },
        show(phase, tone, text, ttlMs) {
          clearTimer();
          publish({ phase, tone, text, revision: state.revision + 1 });
          if (typeof ttlMs === 'number' && ttlMs > 0) {
            timer = window.setTimeout(() => {
              timer = null;
              publish({ phase: 'idle', tone: 'neutral', text: '', revision: state.revision + 1 });
            }, ttlMs);
          }
        },
      };
    })();

    /* ------------------------------------------------------------------ *
     * styles (host tokens only; class names are this plugin's own)
     * ------------------------------------------------------------------ */

    const CSS = `
.dsar-item-wrap { position: relative; }
.dsar-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-height: 34px;
  padding: 6px 8px;
  border: none;
  border-radius: var(--dsw-radius-md, 8px);
  background: transparent;
  cursor: pointer;
  font-family: inherit;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-primary);
  text-align: left;
}
.dsar-item:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsar-item:focus-visible { background: var(--dsw-alias-interactive-bg-hover); outline: none; }
.dsar-item-icon {
  display: inline-flex;
  flex: none;
  width: 14px;
  height: 14px;
  align-items: center;
  justify-content: center;
  color: var(--dsw-alias-menu-icon, var(--dsw-alias-label-secondary));
}
.dsar-item-icon svg { width: 14px; height: 14px; }
.dsar-item-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsar-toast {
  position: fixed;
  left: 50%;
  bottom: 100px;
  transform: translateX(-50%);
  z-index: 1200;
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: min(560px, calc(100vw - 48px));
  padding: 8px 14px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 12px;
  background: var(--dsw-alias-bg-overlay);
  box-shadow: var(--dsw-elevation-prominent, 0 8px 24px rgba(0, 0, 0, 0.18));
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 20px;
  pointer-events: none;
}
.dsar-toast--error { color: var(--dsw-alias-state-error-primary); pointer-events: auto; }
.dsar-toast-text { min-width: 0; overflow-wrap: anywhere; }
.dsar-spinner {
  flex: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid var(--dsw-alias-border-l2);
  border-top-color: var(--dsw-alias-brand-primary);
  animation: dsar-spin 0.8s linear infinite;
}
@keyframes dsar-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .dsar-spinner { animation: none; }
}
`;

    function injectStyle() {
      if (document.getElementById(STYLE_ID) !== null) return () => {};
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
      return () => {
        style.remove();
      };
    }

    /* ------------------------------------------------------------------ *
     * the operation caller
     * ------------------------------------------------------------------ */

    /** The rename request in flight: a new click aborts it and starts over. */
    let inFlight = null;

    async function requestAutoRename(sessionId, signal) {
      const response = await fetch(ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId }),
        ...(signal === undefined ? {} : { signal }),
      });
      let payload = null;
      try {
        payload = await response.json();
      } catch (_error) {
        payload = null;
      }
      if (payload === null || payload.ok !== true) {
        const reason = payload !== null && typeof payload.error === 'string' && payload.error.length > 0
          ? payload.error
          : `Host 拒绝了请求（HTTP ${response.status}）`;
        throw new Error(reason);
      }
      return {
        title: typeof payload.title === 'string' ? payload.title : '',
        previousTitle: typeof payload.previousTitle === 'string' ? payload.previousTitle : '',
      };
    }

    async function autoRename(sessionId, t) {
      if (sessionId === '') return;
      // A second click restarts: the older request and its model call are dropped.
      const controller = new AbortController();
      if (inFlight !== null) {
        inFlight.controller.abort();
        window.clearInterval(inFlight.ticks);
        inFlight = null;
      }
      const startedAt = Date.now();
      const record = { controller, ticks: 0 };
      inFlight = record;
      record.ticks = window.setInterval(() => {
        const seconds = Math.round((Date.now() - startedAt) / 1000);
        statusStore.show('working', 'neutral', t.f('status.workingElapsed', { seconds }), 0);
      }, 1000);
      statusStore.show('working', 'neutral', t.f('status.working'), 0);
      try {
        const result = await requestAutoRename(sessionId, controller.signal);
        window.clearInterval(record.ticks);
        if (inFlight !== record) return;
        inFlight = null;
        const done = result.previousTitle.length > 0
          ? t.f('status.doneWithPrevious', { title: result.title, previous: result.previousTitle })
          : t.f('status.done', { title: result.title });
        statusStore.show('done', 'neutral', done, 3600);
      } catch (error) {
        window.clearInterval(record.ticks);
        if (inFlight !== record) return;
        inFlight = null;
        const aborted = error instanceof DOMException && error.name === 'AbortError';
        if (aborted) return;
        const reason = error instanceof Error ? error.message : String(error);
        statusStore.show('error', 'error', t.f('status.failed', { reason }), 9000);
      }
    }

    /* ------------------------------------------------------------------ *
     * menu row
     * ------------------------------------------------------------------ */

    function SparkleIcon() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M7.2 2.2 8.4 5l2.8 1.2L8.4 7.4 7.2 10.2 6 7.4 3.2 6.2 6 5z',
          fill: 'currentColor',
          opacity: 0.95,
        }),
        h('path', {
          d: 'M11.6 9.2 12.3 10.9 14 11.6 12.3 12.3 11.6 14 10.9 12.3 9.2 11.6 10.9 10.9z',
          fill: 'currentColor',
          opacity: 0.7,
        }),
      );
    }

    function AutoRenameMenuItem(props) {
      const sessionId = props !== null && typeof props.sessionId === 'string' ? props.sessionId : '';
      const t = makeTranslator(props !== null && typeof props.t === 'function' ? props.t : null);
      const useMenuOpenState = props !== null && typeof props.useMenuOpenState === 'function' ? props.useMenuOpenState : null;
      // The owner injects the open-state pair as this occurrence's hook; read it
      // once during render (never inside the click handler).
      let setMenuOpen = null;
      if (useMenuOpenState !== null) {
        try {
          const pair = useMenuOpenState();
          if (Array.isArray(pair) && typeof pair[1] === 'function') setMenuOpen = pair[1];
        } catch (_error) {
          setMenuOpen = null;
        }
      }
      return h(
        'div',
        { className: 'dsar-item-wrap' },
        h(
          'button',
          {
            type: 'button',
            role: 'menuitem',
            className: 'dsar-item',
            onClick: () => {
              if (setMenuOpen !== null) {
                try {
                  setMenuOpen(false);
                } catch (_error) {
                  /* the menu also closes itself after a selection */
                }
              }
              autoRename(sessionId, t);
            },
          },
          h('span', { className: 'dsar-item-icon' }, h(SparkleIcon)),
          h('span', { className: 'dsar-item-label' }, t.f('menu.label')),
        ),
      );
    }

    /* ------------------------------------------------------------------ *
     * frame-level status line
     * ------------------------------------------------------------------ */

    function StatusOverlay() {
      const state = useSyncExternalStore(statusStore.subscribe, statusStore.getSnapshot, statusStore.getSnapshot);
      if (state.phase === 'idle' || state.text === '') return null;
      const failed = state.phase === 'error';
      return h(
        'div',
        {
          className: failed ? 'dsar-toast dsar-toast--error' : 'dsar-toast',
          role: failed ? 'alert' : 'status',
        },
        state.phase === 'working' ? h('span', { className: 'dsar-spinner', 'aria-hidden': 'true' }) : null,
        h('span', { className: 'dsar-toast-text' }, state.text),
      );
    }

    /* ------------------------------------------------------------------ *
     * right-click: open the row's own menu at the pointer
     * ------------------------------------------------------------------ */

    /** The visible portalled menu surface, or null. */
    function visibleMenu() {
      const nodes = document.querySelectorAll(MENU_SELECTOR);
      let found = null;
      for (const node of nodes) {
        if (!(node instanceof HTMLElement)) continue;
        const rect = node.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        found = node;
      }
      return found;
    }

    /** The live pointer placement, if a right-click menu is open. */
    let placement = null;

    /** Undo a previous pointer-placement so click-opened menus stay anchored. */
    function clearPlacement() {
      if (placement !== null) {
        placement.stop();
        placement = null;
      }
      for (const node of document.querySelectorAll(`[${SHIFT_ATTR}]`)) {
        if (!(node instanceof HTMLElement)) continue;
        node.style.removeProperty('transform');
        node.removeAttribute(SHIFT_ATTR);
      }
    }

    /**
     * Keep one menu pinned at a screen point for as long as it stays open.
     *
     * The shipped menu re-derives its own position from the row's「…」button on
     * every frame, and the sidebar re-sorts live, so a one-shot offset drifts
     * away from the pointer. This loop re-applies the offset each frame with the
     * pointer's point as the target, so the menu stays where the user clicked
     * even when its anchor moves underneath.
     */
    function pinMenuAt(x, y) {
      const menu = visibleMenu();
      if (menu === null) return false;
      const margin = 12;
      let dx = 0;
      let dy = 0;
      let frame = 0;
      let stopped = false;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        if (frame !== 0) window.cancelAnimationFrame(frame);
        menu.style.removeProperty('transform');
        menu.removeAttribute(SHIFT_ATTR);
      };
      const tick = () => {
        if (stopped) return;
        if (!menu.isConnected) {
          stop();
          placement = null;
          return;
        }
        const rect = menu.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) {
          stop();
          placement = null;
          return;
        }
        const baseLeft = rect.left - dx;
        const baseTop = rect.top - dy;
        const left = Math.min(Math.max(x, margin), Math.max(margin, window.innerWidth - rect.width - margin));
        const top = Math.min(Math.max(y, margin), Math.max(margin, window.innerHeight - rect.height - margin));
        const nextDx = Math.round(left - baseLeft);
        const nextDy = Math.round(top - baseTop);
        if (nextDx !== dx || nextDy !== dy) {
          dx = nextDx;
          dy = nextDy;
          menu.style.transform = `translate(${dx}px, ${dy}px)`;
          menu.setAttribute(SHIFT_ATTR, '1');
        }
        frame = window.requestAnimationFrame(tick);
      };
      menu.setAttribute(SHIFT_ATTR, '1');
      frame = window.requestAnimationFrame(tick);
      placement = { stop };
      return true;
    }

    /** Open the row's shipped「…」menu from a contextmenu event. */
    function openRowMenuAt(target, x, y) {
      const row = target.closest(ROW_SELECTOR);
      if (row === null) return false;
      const key = row.getAttribute('data-row-key') || '';
      if (!key.startsWith(ROW_PREFIX) || key.length === ROW_PREFIX.length) return false;
      // A blank row has no action area and therefore no menu of its own.
      const actions = row.querySelector('span[class*="rowActions"]');
      if (actions === null) return false;
      const trigger = actions.querySelector('button');
      if (trigger === null) return false;
      trigger.click();
      const attempt = (left) => {
        if (pinMenuAt(x, y)) return;
        if (left <= 0) return;
        window.requestAnimationFrame(() => attempt(left - 1));
      };
      attempt(8);
      return true;
    }

    function installRightClick() {
      const onContextMenu = (event) => {
        if (!(event.target instanceof Element)) return;
        clearPlacement();
        if (openRowMenuAt(event.target, event.clientX, event.clientY)) {
          event.preventDefault();
          event.stopPropagation();
        }
      };
      const onPointerDown = (event) => {
        if (event.button === 2) return;
        // A click *inside* the pointer-placed menu must keep its placement: the
        // click event that follows would otherwise land where the menu no longer
        // is (this was the "nothing happens" bug).
        const menu = visibleMenu();
        if (menu !== null && event.target instanceof Node && menu.contains(event.target)) return;
        clearPlacement();
      };
      document.addEventListener('contextmenu', onContextMenu, true);
      document.addEventListener('pointerdown', onPointerDown, true);
      return () => {
        document.removeEventListener('contextmenu', onContextMenu, true);
        document.removeEventListener('pointerdown', onPointerDown, true);
        clearPlacement();
      };
    }

    /* ------------------------------------------------------------------ *
     * locale binding
     * ------------------------------------------------------------------ */

    /** Wrap the slot's `t` into the small `{f}` face this file uses. */
    function makeTranslator(t) {
      if (t === null) {
        return { f: (key, values) => format(DICT_ZH[key] ?? key, values) };
      }
      return {
        f(key, values) {
          try {
            const value = t(key, values);
            if (typeof value === 'string' && value.length > 0 && value !== key) return value;
          } catch (_error) {
            /* fall through to the built-in copy */
          }
          return format(DICT_ZH[key] ?? key, values);
        },
      };
    }

    /* ------------------------------------------------------------------ *
     * plugin
     * ------------------------------------------------------------------ */

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => injectStyle(), 'dsh-session-auto-rename: styles');
        ctx.effect(() => ctx.locale.register(NS, { zh: DICT_ZH, en: DICT_EN }), 'dsh-session-auto-rename: dictionaries');

        ctx.effect(
          () => ctx.slots.inject(MENU_SLOT, () => ctx.slots.register(
            { name: MENU_SLOT, id: 'auto-rename', order: 250, locale: NS },
            AutoRenameMenuItem,
          )),
          'dsh-session-auto-rename: menu row',
        );

        ctx.effect(
          () => ctx.slots.inject(OVERLAY_SLOT, () => ctx.slots.register(
            { name: OVERLAY_SLOT, id: 'dsh-session-auto-rename-status', order: 900, locale: NS },
            StatusOverlay,
          )),
          'dsh-session-auto-rename: status line',
        );

        ctx.effect(() => installRightClick(), 'dsh-session-auto-rename: right click');
      },
    };
  },
});
