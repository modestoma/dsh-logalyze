/**
 * 「观象」页面样式。使用 DSH 语义 token（`--dsw-alias-*`）并带中性回退，
 * 页面随当前主题变化。
 *
 * @module dsh-logalyze/client/styles
 */

const STYLE_ATTRIBUTE = 'data-dsh-logalyze-css'

const CSS = `
.lz-page{width:100%;height:100%;min-width:0;min-height:0;overflow:auto;scrollbar-gutter:stable;background:var(--dsw-alias-bg-base,#fff)}
.lz-page__content{box-sizing:border-box;max-width:816px;margin:0 auto;padding:18px clamp(24px,4vw,48px) 48px}
[data-platform='darwin'] .lz-page__content{padding-top:calc(18px + var(--dsh-frame-top-clearance,0px))}
.lz{--lz-fg:var(--dsw-alias-label-primary,#1f2328);--lz-fg2:var(--dsw-alias-label-secondary,#5c6169);--lz-fg3:var(--dsw-alias-label-tertiary,#8a8f98);--lz-dim:var(--dsw-alias-label-dimmed,#b0b4ba);--lz-bg:var(--dsw-alias-bg-base,#fff);--lz-line:var(--dsw-alias-border-l2,rgba(0,0,0,.12));--lz-hover:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));--lz-accent:var(--dsw-alias-state-business-primary,#0a67d3);--lz-ok:var(--dsw-alias-state-success-primary,#0a7d33);--lz-warn:var(--dsw-alias-state-warn-primary,#a15c00);--lz-bad:var(--dsw-alias-state-error-primary,#c62828);--lz-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;display:flex;flex-direction:column;gap:14px;width:100%;max-width:720px;color:var(--lz-fg);font-size:13px;line-height:20px}
.lz__head{position:sticky;top:0;z-index:2;display:flex;flex-direction:column;gap:4px;padding:10px 0 6px;background:var(--lz-bg)}
.lz__headRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.lz__title{margin:0 2px 0 0;font-size:20px;font-weight:500;line-height:28px}
.lz__meta{color:var(--lz-fg3);font-size:12px}
.lz__mono{font-family:var(--lz-mono);font-size:12px}
.lz__pill{display:inline-flex;align-items:center;gap:5px;padding:0 8px;border-radius:999px;font-size:12px;line-height:20px;white-space:nowrap;color:var(--lz-fg3);background:color-mix(in srgb,currentColor 10%,transparent)}
.lz__pill--ok{color:var(--lz-ok)}
.lz__pill--warn{color:var(--lz-warn)}
.lz__pill--bad{color:var(--lz-bad)}
.lz__dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}
.lz__tabs{display:flex;align-items:center;gap:18px;border-bottom:1px solid var(--lz-line);overflow-x:auto;scrollbar-width:none}
.lz__tab{display:inline-flex;align-items:center;min-height:34px;padding:0;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--lz-fg2);font:inherit;font-size:13px;cursor:pointer;white-space:nowrap}
.lz__tab:hover{color:var(--lz-fg)}
.lz__tab[aria-selected="true"]{color:var(--lz-fg);border-bottom-color:currentColor;font-weight:600}
.lz__body{display:flex;flex-direction:column;gap:22px;padding:4px 0 8px}
.lz__sec{display:flex;flex-direction:column;gap:6px;margin:0}
.lz__secTitle{margin:0;font-size:12px;font-weight:600;line-height:18px;color:var(--lz-fg3);letter-spacing:.02em}
.lz__secFoot{margin:0;color:var(--lz-fg3);font-size:12px;line-height:18px}
.lz__list{display:flex;flex-direction:column;border:1px solid var(--lz-line);border-radius:10px}
.lz__list>*+*{border-top:1px solid var(--lz-line)}
.lz__row{display:flex;align-items:center;gap:16px;padding:11px 14px;min-height:28px}
.lz__row--top{align-items:flex-start}
.lz__rowText{display:flex;flex-direction:column;gap:2px;flex:1 1 auto;min-width:0}
.lz__rowLabel{display:flex;align-items:center;gap:6px;flex-wrap:wrap;overflow-wrap:anywhere}
.lz__rowSummary{color:var(--lz-fg3);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.lz__rowError{color:var(--lz-bad);font-size:12px;line-height:18px;overflow-wrap:anywhere;white-space:pre-wrap}
.lz__rowCtl{flex:none;display:flex;align-items:center;gap:6px;justify-content:flex-end}
.lz__tag{display:inline-flex;align-items:center;padding:0 5px;border-radius:4px;font-size:11px;line-height:16px;white-space:nowrap;color:var(--lz-fg2);background:var(--lz-hover)}
.lz__tag--accent{color:var(--lz-accent);background:color-mix(in srgb,var(--lz-accent) 10%,transparent)}
.lz__input{box-sizing:border-box;width:100%;min-width:0;height:30px;padding:0 10px;border:1px solid var(--lz-line);border-radius:7px;background:var(--dsw-alias-bg-layer-1,transparent);color:inherit;font:inherit;font-size:13px;outline:none}
.lz__input:focus{border-color:var(--lz-accent)}
.lz__input--num{width:120px;text-align:right;font-variant-numeric:tabular-nums}
.lz__input--wide{width:320px}
.lz__textarea{height:auto;margin-top:6px;padding:6px 10px;line-height:18px;resize:vertical}
.lz__check{width:16px;height:16px;margin:0;accent-color:var(--lz-accent);cursor:pointer}
.lz__unit{min-width:36px;color:var(--lz-fg3);font-size:12px}
.lz__addRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 14px}
.lz__addRow .lz__input{flex:1 1 160px;width:auto}
.lz__addRow .lz__input--branch{flex:0 1 140px}
.lz__addRow--flush{padding:6px 0 0}
.lz__addForm{display:flex;flex-direction:column;gap:6px;padding:10px 14px}
.lz__field{display:flex;flex-direction:column;gap:2px;flex:1 1 160px;color:var(--lz-fg3);font-size:12px}
.lz__field .lz__input{flex:none;width:100%}
.lz__btn--end{align-self:flex-end;height:30px}
.lz__emptyRow{padding:11px 14px;color:var(--lz-fg3);font-size:12px}
.lz__btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:28px;padding:0 12px;border:1px solid var(--lz-line);border-radius:7px;background:transparent;color:inherit;font:inherit;font-size:13px;cursor:pointer;white-space:nowrap}
.lz__btn:hover:not(:disabled){background:var(--lz-hover)}
.lz__btn:disabled{color:var(--lz-dim);cursor:default}
.lz__btn--primary{background:var(--dsw-alias-button-primary-fill,var(--lz-accent));border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff)}
.lz__btn--primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,#0b5cba)}
.lz__btn--primary:disabled{opacity:.45;color:var(--dsw-alias-label-primary-foreground,#fff)}
.lz__btn--ghost{border-color:transparent;color:var(--lz-fg2)}
.lz__btn--danger{color:var(--lz-bad)}
.lz__btn:focus-visible,.lz__tab:focus-visible{outline:2px solid var(--lz-accent);outline-offset:2px}
.lz__notice{padding:8px 12px;border-radius:8px;font-size:12px;line-height:18px;overflow-wrap:anywhere}
.lz__notice--ok{color:var(--lz-ok);background:color-mix(in srgb,var(--lz-ok) 9%,transparent)}
.lz__notice--error{color:var(--lz-bad);background:color-mix(in srgb,var(--lz-bad) 8%,transparent)}
.lz__saveBar{position:sticky;bottom:0;z-index:2;display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 0;border-top:1px solid var(--lz-line);background:var(--lz-bg)}
.lz__saveMsg{flex:1;min-width:0;color:var(--lz-fg2);font-size:12px}
.lz__loading{padding:16px 0;color:var(--lz-fg3);font-size:12px}
`

/**
 * Install the page stylesheet once.
 * @returns disposer removing it.
 */
export function installStyles(): () => void {
  const existing = document.querySelector(`style[${STYLE_ATTRIBUTE}]`)
  if (existing !== null) return () => {}
  const element = document.createElement('style')
  element.setAttribute(STYLE_ATTRIBUTE, '')
  element.textContent = CSS
  document.head.append(element)
  return () => { element.remove() }
}
